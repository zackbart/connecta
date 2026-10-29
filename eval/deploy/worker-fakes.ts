/**
 * The Worker example's composition — D1 storage, the Dynamic Worker executor,
 * Cloudflare Access auth, the vault, the operator UI — with the Node-hosted
 * fake downstreams as its connectors, so a write can be verified on workerd.
 * The example itself ships no write-capable tool; this is its shape, not a
 * third deployment scaffold.
 */
import { workerExecutor } from "@zackbart/connecta/worker";
import { createConnecta, remoteMcp } from "@zackbart/connecta";
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { operatorUi } from "@zackbart/connecta/ui";
import { d1Storage } from "@zackbart/connecta/d1";
import { withAccess } from "./access-shim.js";
import { injectedConnectors, injectedD1, presetInjected, withInjectedPools, type InjectedEnv } from "./injected.js";

interface Env extends InjectedEnv {
  CONNECTA_DB: D1Database;
  CREDENTIAL_ENCRYPTION_KEY: string;
  PUBLIC_URL: string;
  TRACKER_URL: string;
  CHAT_URL: string;
  BILLING_URL: string;
  LOADER: WorkerLoader;
}

function build(env: Env) {
  const storage = d1Storage(injectedD1(env.CONNECTA_DB, env));
  const vault = encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY);
  const connecta = createConnecta({
    readOnly: false,
    publicUrl: env.PUBLIC_URL,
    storage,
    executor: workerExecutor({ loader: env.LOADER }),
    auth: [cloudflareAccessAuth()],
    // The Access stand-in's user, the one maintainer plain /mcp admits and
    // the one who manages connector auth (#837).
    maintainers: ["eval-operator"],
    pools: withInjectedPools(
      { personal: { tools: ["billing"], members: ["eval-operator", "eval-member"], readOnly: true } },
      env,
    ),
    vault,
    ui: operatorUi(),
    connectors: [
      remoteMcp("billing", {
        url: env.BILLING_URL,
        title: "Billing",
        authScope: "personal",
        auth: { type: "credential", credential: { label: "API token" } },
      }),
      remoteMcp("tracker", { url: env.TRACKER_URL, title: "Issue tracker", description: "Issues" }),
      remoteMcp("chat", { url: env.CHAT_URL, title: "Team chat", description: "Channels and messages" }),
      ...injectedConnectors(env),
    ],
  });
  return { connecta, ready: presetInjected(vault, env) };
}

let connecta: ReturnType<typeof build> | undefined;

export default withAccess({
  async fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    connecta ??= build(env as unknown as Env);
    await connecta.ready;
    return connecta.connecta.fetch(request, env, ctx);
  },
});
