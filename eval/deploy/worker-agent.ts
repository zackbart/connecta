/**
 * The agent-eval composition on workerd: D1 storage, the Dynamic Worker
 * executor, Cloudflare Access for people and stored agent tokens at
 * /agent/<pool>, the vault and the operator UI, over one task's fakes. The
 * connector mapping is compose.ts, shared with the Node deployment.
 *
 * Loopback fakes are fetched directly. Every other outbound request goes to
 * the Node harness's vendor gateway (eval/deploy/worker.ts), which dispatches
 * it through the credential-routed fake transport and its fail-closed rules.
 * Each hop of a followed redirect goes back through the wrapper
 * (gateway-fetch.ts), so the wrapper never lets workerd follow a Location itself.
 * This covers code that uses globalThis.fetch; workerd itself is not
 * network-sandboxed (see eval/README.md).
 *
 * `/__eval/*` are local process controls, never product routes.
 */
import { workerExecutor } from "@zackbart/connecta/worker";
import { createConnecta } from "@zackbart/connecta";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { operatorUi } from "@zackbart/connecta/ui";
import { d1Storage } from "@zackbart/connecta/d1";
import { withAccess } from "./access-shim.js";
import { connectCcb, evalConfig, presetCredentials, type EvalComposition } from "./compose.js";
import { observePrograms, type ProgramObservation } from "./observe.js";
import { viaGateway } from "./gateway-fetch.js";

interface Env {
  CONNECTA_DB: D1Database;
  LOADER: WorkerLoader;
  PUBLIC_URL: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  /** JSON EvalComposition. */
  EVAL_COMPOSITION: string;
  EVAL_GATEWAY: string;
  /** This trial's gateway credential; the gateway refuses requests without it. */
  EVAL_GATEWAY_TOKEN: string;
}

interface Live {
  connecta: ReturnType<typeof createConnecta>;
  build(): ReturnType<typeof createConnecta>;
  token: string;
  vault: ReturnType<typeof encryptedCredentialVault>;
  programs(): ProgramObservation[];
  observeNext(): void;
  setReadOnly(value: boolean): void;
}

let live: Promise<Live> | undefined;

async function setup(env: Env): Promise<Live> {
  globalThis.fetch = viaGateway(globalThis.fetch.bind(globalThis), env.EVAL_GATEWAY, env.EVAL_GATEWAY_TOKEN);
  const composition = JSON.parse(env.EVAL_COMPOSITION) as EvalComposition;
  const storage = d1Storage(env.CONNECTA_DB);
  const vault = encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY);
  const { token } = await new AccessTokenManager(storage, { agents: ["eval-machine"] }).rotate(
    "eval-machine",
    "eval-provisioning",
  );
  await presetCredentials(vault, composition.connectors);
  const previous: ProgramObservation[] = [];
  let observed = observePrograms(workerExecutor({ loader: env.LOADER }));
  let readOnly = composition.readOnly;
  const build = () =>
    createConnecta(
      evalConfig(
        { ...composition, readOnly },
        {
          storage,
          accessTokens: accessTokens(storage),
          publicUrl: env.PUBLIC_URL,
          executor: observed.executor,
          vault,
          ui: operatorUi(),
          // People arrive through Access; the eval stand-in's user maintains (#837).
          auth: { auth: [cloudflareAccessAuth()], maintainers: ["eval-operator"] },
        },
      ),
    );
  const state: Live = {
    connecta: build(),
    build,
    token,
    vault,
    programs: () => [...previous, ...observed.programs],
    observeNext: () => {
      previous.push(...observed.programs);
      observed = observePrograms(workerExecutor({ loader: env.LOADER }));
    },
    setReadOnly: (value) => {
      readOnly = value;
    },
  };
  await connectCcb(state.connecta, composition.connectors, env.PUBLIC_URL);
  return state;
}

export default withAccess({
  async fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    const bindings = env as unknown as Env;
    live ??= setup(bindings).catch((error: unknown) => {
      live = undefined;
      throw error;
    });
    const state = await live;
    const url = new URL(request.url);
    if (url.pathname === "/__eval/token") return Response.json({ token: state.token });
    if (url.pathname === "/__eval/programs") return Response.json(state.programs());
    if (url.pathname === "/__eval/credential" && request.method === "POST") {
      const { connector, value } = (await request.json()) as { connector: string; value: string };
      await state.vault.set(connector, value, "operator");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__eval/restart" && request.method === "POST") {
      const readOnly = url.searchParams.get("readOnly");
      if (readOnly !== null) state.setReadOnly(readOnly === "true");
      await state.connecta.close();
      state.observeNext();
      state.connecta = state.build();
      return new Response(null, { status: 204 });
    }
    return state.connecta.fetch(request, env, ctx);
  },
});
