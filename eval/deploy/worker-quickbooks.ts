/** Native smoke composition; redirect and restart controls exist only in eval/. */
import { createConnecta } from "@zackbart/connecta";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { workerExecutor } from "@zackbart/connecta/worker";
import { d1Storage } from "@zackbart/connecta/d1";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { operatorUi } from "@zackbart/connecta/ui";
import { interceptQuickBooks, quickbooksAuth, quickbooksConnectors, quickbooksPools } from "./quickbooks.js";
import { injectedConnectors, injectedD1, presetInjected, withInjectedPools, type InjectedEnv } from "./injected.js";

interface Env extends InjectedEnv {
  CONNECTA_DB: D1Database;
  LOADER: WorkerLoader;
  PUBLIC_URL: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  QUICKBOOKS_URL: string;
  QUICKBOOKS_WRITES: string;
  QUICKBOOKS_CLIENT: string;
}
let connecta: ReturnType<typeof createConnecta> | undefined;
let token: string | undefined;
let installed = false;
let endpointReadOnly = false;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const storage = d1Storage(injectedD1(env.CONNECTA_DB, env));
    const vault = encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY);
    if (!installed) {
      interceptQuickBooks(env.QUICKBOOKS_URL);
      await presetInjected(vault, env);
      installed = true;
    }
    token ??= (
      await new AccessTokenManager(storage, { agents: ["eval-machine"] }).rotate("eval-machine", "eval-provisioning")
    ).token;
    // Local-only process controls; not a product route or configuration option.
    if (new URL(request.url).pathname === "/__eval/restart") {
      endpointReadOnly = new URL(request.url).searchParams.get("readOnly") === "true";
      await connecta?.close();
      connecta = undefined;
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__eval/token") return Response.json({ token });
    connecta ??= createConnecta({
      publicUrl: env.PUBLIC_URL,
      readOnly: endpointReadOnly,
      storage,
      agents: ["eval-machine"],
      accessTokens: accessTokens(storage),
      auth: quickbooksAuth,
      maintainers: ["alice", "bob"],
      pools: withInjectedPools(quickbooksPools(env.QUICKBOOKS_WRITES === "true"), env),
      executor: workerExecutor({ loader: env.LOADER }),
      ui: operatorUi(),
      vault,
      connectors: [
        ...quickbooksConnectors(env.QUICKBOOKS_WRITES === "true", env.QUICKBOOKS_CLIENT),
        ...injectedConnectors(env),
      ],
    });
    return connecta.fetch(request, env, ctx);
  },
};
