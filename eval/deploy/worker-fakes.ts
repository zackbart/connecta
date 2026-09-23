/**
 * The Worker example's composition — KV storage, the Dynamic Worker executor,
 * Cloudflare Access auth, the vault, the operator UI — with the Node-hosted
 * fake downstreams as its connectors, so a write can be verified on workerd.
 * The example itself ships no write-capable tool; this is its shape, not a
 * third deployment scaffold.
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createConnecta, remoteMcp } from "@zackbart/connecta";
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { operatorUi } from "@zackbart/connecta/ui";
import { cloudflareKvStorage } from "../../examples/worker/src/cloudflare-kv.js";
import { withAccess } from "./access-shim.js";

interface Env {
  CONNECTA_KV: KVNamespace;
  CREDENTIAL_ENCRYPTION_KEY: string;
  PUBLIC_URL: string;
  TRACKER_URL: string;
  CHAT_URL: string;
  LOADER: WorkerLoader;
}

function build(env: Env) {
  const storage = cloudflareKvStorage(env.CONNECTA_KV);
  return createConnecta({
    publicUrl: env.PUBLIC_URL,
    storage,
    executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
    auth: [cloudflareAccessAuth()],
    vault: encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY),
    ui: operatorUi(),
    identity: { credentialAdministration: () => "all", personalConnection: () => "all" },
    connectors: [
      remoteMcp("tracker", { url: env.TRACKER_URL, title: "Issue tracker", description: "Issues" }),
      remoteMcp("chat", { url: env.CHAT_URL, title: "Team chat", description: "Channels and messages" }),
    ],
  });
}

let connecta: ReturnType<typeof build> | undefined;

export default withAccess({
  async fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> {
    connecta ??= build(env as unknown as Env);
    return connecta.fetch(request, env, ctx);
  },
});
