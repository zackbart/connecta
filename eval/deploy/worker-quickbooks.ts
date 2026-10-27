/** Native smoke composition; redirect and restart controls exist only in eval/. */
import { createConnecta } from "@zackbart/connecta";
import { accessTokens, AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { workerExecutor } from "@zackbart/connecta/worker";
import { d1Storage } from "@zackbart/connecta/d1";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { operatorUi } from "@zackbart/connecta/ui";
import { interceptQuickBooks, quickbooksAuth, quickbooksConnectors, quickbooksPools } from "./quickbooks.js";

interface Env {
  CONNECTA_DB: D1Database;
  LOADER: WorkerLoader;
  PUBLIC_URL: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  QUICKBOOKS_URL: string;
  QUICKBOOKS_WRITES: string;
}
let connecta: ReturnType<typeof createConnecta> | undefined;
let token: string | undefined;
let installed = false;
let endpointReadOnly = false;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!installed) {
      interceptQuickBooks(env.QUICKBOOKS_URL);
      installed = true;
    }
    const storage = d1Storage(env.CONNECTA_DB);
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
      pools: quickbooksPools(env.QUICKBOOKS_WRITES === "true"),
      executor: workerExecutor({ loader: env.LOADER }),
      ui: operatorUi(),
      vault: encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY),
      connectors: quickbooksConnectors(env.QUICKBOOKS_WRITES === "true"),
    });
    return connecta.fetch(request, env, ctx);
  },
};
