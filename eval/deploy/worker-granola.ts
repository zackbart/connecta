/** Local smoke only: published Worker/D1 deployment and fixed-origin fake interception. */
import { createConnecta } from "@zackbart/connecta";
import { granola } from "@zackbart/connecta/providers/granola";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { workerExecutor } from "@zackbart/connecta/worker";
import { d1Storage } from "@zackbart/connecta/d1";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { interceptGranola } from "./granola.js";
import { injectedConnectors, injectedD1, presetInjected, withInjectedPools, type InjectedEnv } from "./injected.js";

interface Env extends InjectedEnv {
  CONNECTA_DB: D1Database;
  LOADER: WorkerLoader;
  PUBLIC_URL: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  GRANOLA_URL: string;
  GRANOLA_KEY: string;
}
let connecta: ReturnType<typeof createConnecta> | undefined;
let token: string | undefined;
let installed = false;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const storage = d1Storage(injectedD1(env.CONNECTA_DB, env));
    const vault = encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY);
    if (!installed) {
      interceptGranola(env.GRANOLA_URL);
      await vault.set("granola", env.GRANOLA_KEY, "eval-provisioning");
      await presetInjected(vault, env);
      installed = true;
    }
    token ??= (
      await new AccessTokenManager(storage, { agents: ["eval-machine"] }).rotate("eval-machine", "eval-provisioning")
    ).token;
    const path = new URL(request.url).pathname;
    if (path === "/__eval/restart") {
      await connecta?.close();
      connecta = undefined;
      return new Response(null, { status: 204 });
    }
    if (path === "/__eval/token") return Response.json({ token });
    connecta ??= createConnecta({
      publicUrl: env.PUBLIC_URL,
      readOnly: true,
      storage,
      vault,
      agents: ["eval-machine"],
      accessTokens: accessTokens(storage),
      pools: withInjectedPools({ eval: { tools: ["granola"], members: ["agent:eval-machine"] } }, env),
      executor: workerExecutor({ loader: env.LOADER }),
      connectors: [granola("granola", { purpose: "Workspace meetings" }), ...injectedConnectors(env)],
    });
    return connecta.fetch(request, env, ctx);
  },
};
