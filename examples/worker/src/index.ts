/**
 * connecta on Cloudflare Workers.
 *
 * One MCP endpoint aggregating a downstream remote MCP and an HTTP API, guarded
 * by Cloudflare Access, with OAuth/cache state in a KV namespace. Access
 * authenticates the request before this Worker runs and supplies the trusted
 * identity through ctx.access. The required Worker Loader binding in
 * wrangler.jsonc backs the seven-tool surface.
 *
 * The operator surface is wired here except for activity history, which needs
 * a database this example does not create for you: sign-in, the credential
 * vault, and access-token issuance are on, and activity is three commented
 * lines below. README.md § "The operator surface" walks through all four.
 *
 * Setup (this example has no package.json of its own — it self-references the
 * installed `@zackbart/connecta` package):
 *   1. `npm install` in the connecta package root (../../ from here) so the
 *      package import and wrangler resolve. A copy in its own repository
 *      installs `@zackbart/connecta @cloudflare/codemode` instead. Codemode is
 *      an optional peer.
 *   2. Create a KV namespace and put its id in wrangler.jsonc under `kv_namespaces`.
 *   3. Set secrets:
 *        wrangler secret put DOWNSTREAM_TOKEN
 *        wrangler secret put CREDENTIAL_ENCRYPTION_KEY
 *      and PUBLIC_URL as a plain var in wrangler.jsonc.
 *   4. Attach Cloudflare Access to this Worker. Enable Managed OAuth and
 *      Dynamic Client Registration. Its Allowed redirect URIs must include
 *      Claude's https://claude.ai/api/mcp/auth_callback plus ChatGPT's
 *      https://chatgpt.com/connector_platform_oauth_redirect and
 *      https://chatgpt.com/connector/oauth/* forms (see ../AGENTS.md).
 *   5. Use the Workers Paid plan required by the `worker_loaders` binding.
 *   6. `wrangler deploy` from this folder (examples/worker), where wrangler.jsonc
 *      lives. Point your MCP client at `<PUBLIC_URL>/mcp`.
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import {
  api,
  createConnecta,
  remoteMcp,
} from "@zackbart/connecta";
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
import { cloudflareKvStorage } from "./cloudflare-kv.js";
// Activity history, off by default because it needs a D1 database.
// import { d1ActivityStore } from "./d1-activity.js";

interface Env {
  CONNECTA_KV: KVNamespace;
  /**
   * Base64 32-byte AES key encrypting operator-managed credentials in KV.
   * Unset means no vault: /credentials stays read-only and connecta says so at
   * startup. Never put it in KV — it is what protects KV.
   */
  CREDENTIAL_ENCRYPTION_KEY: string;
  DOWNSTREAM_TOKEN: string;
  PUBLIC_URL: string;
  /** Uncomment with the `d1_databases` binding to enable activity history. */
  // ACTIVITY_DB: D1Database;
  /**
   * Worker Loader binding (wrangler.jsonc `worker_loaders`) powering
   * execute_code. Dynamic Workers require the Workers Paid plan.
   */
  LOADER: WorkerLoader;
}

function build(env: Env) {
  return createConnecta({
    publicUrl: env.PUBLIC_URL,
    storage: cloudflareKvStorage(env.CONNECTA_KV),
    executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
    auth: [
      // Access owns admission policy. A human identity may use MCP and the
      // operator pages; a service token may use MCP but cannot mutate operator
      // state. Neither path asks connecta to parse a JWT.
      cloudflareAccessAuth(),
    ],
    // Optional code-owned roster. Access proves the identity; connecta derives
    // connector visibility and deployment-operator status from the stable id
    // it supplies. A signed-in human may manage auth for every connector this
    // view includes. Omit the block to keep every connector visible and every
    // human a deployment operator.
    // identity: {
    //   connectorAccess: ({ principal }) =>
    //     principal?.id === "ACCESS_USER_UUID"
    //       ? ["notion", "echo"]
    //       : ["echo"],
    //   operatorAccess: ({ id }) => id === "ACCESS_USER_UUID",
    // },
    // Connectors that declare a `credential` slot become editable by every
    // signed-in human who can see that connector at /credentials, encrypted
    // with this key before anything reaches KV. A saved replacement takes
    // effect on the next call — no redeploy, and no liveness probe:
    // credentials fail at use.
    //
    // The key is the vault, not the page: /credentials is a list of connector
    // slots, so it stays hidden until a connector declares one. Neither
    // connector below does — Notion here carries a deployment-owned static
    // header and echo has no secret at all — so this example ships the vault
    // ready and the page empty. Declare a slot (see the commented shape on
    // `echo`, or use a provider connector like `notion()`, which declares its
    // own) and the page appears on the next load.
    credentials: { encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY },
    // Eligible human operators can create named, revocable MCP Bearer tokens
    // at /tokens. Under Worker-level Access those tokens are a rollback tool,
    // not standalone edge credentials: Access still runs before connecta.
    accessTokens: {},
    // Payload-free activity at /activity, off until a database exists to hold
    // it. Uncomment the `d1_databases` binding in wrangler.jsonc, apply the
    // schema in README.md § "Activity history", then these three lines and the
    // import above.
    // activity: {
    //   store: d1ActivityStore(env.ACTIVITY_DB),
    //   deploymentId: "production",
    // },
    connectors: [
      remoteMcp("notion", {
        url: "https://mcp.notion.com/mcp",
        description: "Notion — pages, databases, comments (static token)",
        auth: {
          type: "headers",
          headers: { Authorization: `Bearer ${env.DOWNSTREAM_TOKEN}` },
          // The vault-backed alternative for a downstream that authenticates
          // with a static key: the operator pastes it at /credentials and
          // rotates it there, so no Worker secret holds it.
          //   type: "credential",
          //   credential: { label: "Notion internal integration token" },
        },
        // Use `authScope: "personal"` with OAuth or credential auth when each
        // Access user connects their own downstream account. Literal headers
        // are deployment-owned and cannot be personal.
      }),
      api("echo", {
        description: "Echo — text transforms",
        // What a vault-backed connector adds — an operator edits this slot at
        // /credentials and the handler reads it with
        // `await ctx.credential?.get()`, so the secret never lives in source
        // or in a Worker variable:
        //   credential: { label: "API token" },
        tools: [
          {
            name: "shout",
            description: "Uppercase the given text.",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string", description: "Text to uppercase." },
              },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
            handler: async (args: { text: string }) => ({
              shouted: args.text.toUpperCase(),
            }),
          },
        ],
      }),
    ],
  });
}

// Lazy per-isolate singleton: reuses the plain-data tool cache. Downstream MCP
// clients are request-scoped internally so Worker I/O never crosses requests.
let connecta: ReturnType<typeof build> | undefined;

export default {
  // Pass `ctx` through: connecta hands deferred work (activity sinks) to
  // ctx.waitUntil so it settles after the response is returned instead of
  // being cancelled with the request.
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    connecta ??= build(env);
    return connecta.fetch(request, env, ctx);
  },
};
