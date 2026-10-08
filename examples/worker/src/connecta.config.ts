/**
 * connecta on Cloudflare Workers: this deployment's configuration.
 *
 * One MCP endpoint aggregating a downstream remote MCP and an HTTP API, guarded
 * by Cloudflare Access. It needs three resources and nothing else: one D1
 * database (CONNECTA_DB) holding every piece of state, the Worker Loader
 * binding (LOADER) behind execute_code, and one secret
 * (CREDENTIAL_ENCRYPTION_KEY) sealing credentials in that database. Access
 * admits the request before this Worker runs and supplies trusted human
 * identity through ctx.access. Machines use stored cta_ tokens inside connecta.
 *
 * Optional modules are type-checked code switched by the environment: the
 * credential vault by the CREDENTIAL_ENCRYPTION_KEY secret, and activity
 * history by the CONNECTA_ACTIVITY var ("on"), in the same database. README.md § "Select optional
 * modules" walks through each.
 *
 * Setup (this example has no package.json of its own — it self-references the
 * installed `@zackbart/connecta` package):
 *   1. `npm install` in the connecta package root (../../ from here) so the
 *      package import and wrangler resolve. A copy in its own repository
 *      installs `@zackbart/connecta @cloudflare/codemode` instead. Codemode is
 *      an optional peer.
 *   2. `wrangler d1 create connecta` and put its id in wrangler.jsonc under
 *      `d1_databases`. connecta creates its tables on first use.
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
import { api, defineConfig, remoteMcp } from "@zackbart/connecta";
import { activityHistory } from "@zackbart/connecta/activity";
import { accessTokens } from "@zackbart/connecta/auth/access-tokens";
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { d1ActivityStore, d1Storage } from "@zackbart/connecta/d1";
import { operatorUi } from "@zackbart/connecta/ui";
import { workerExecutor } from "@zackbart/connecta/worker";

export interface Env {
  /** The one D1 database: OAuth grants, sealed credentials, catalogs, tokens, activity. */
  CONNECTA_DB: D1Database;
  /**
   * Base64 32-byte AES key encrypting operator-managed credentials in D1.
   * Unset means no vault: credential management is unavailable in the operator
   * UI. Never put it in D1, since it is what protects D1.
   */
  CREDENTIAL_ENCRYPTION_KEY?: string;
  DOWNSTREAM_TOKEN: string;
  PUBLIC_URL: string;
  /** "on" switches on activity history, in CONNECTA_DB. */
  CONNECTA_ACTIVITY?: string;
  /**
   * Worker Loader binding (wrangler.jsonc `worker_loaders`) powering
   * execute_code. Dynamic Workers require the Workers Paid plan.
   */
  LOADER: WorkerLoader;
}

export default defineConfig((env: Env) => {
  const storage = d1Storage(env.CONNECTA_DB);
  return {
    publicUrl: env.PUBLIC_URL,
    storage,
    // Required adapter owns each run's handles; direct upstream construction throws.
    executor: workerExecutor({ loader: env.LOADER }),
    // Access owns edge admission and proves human identity for MCP and the
    // operator pages. Machines need Access service headers at the edge plus a
    // stored cta_ bearer inside connecta; a service identity alone is refused.
    auth: [cloudflareAccessAuth()],
    // Always installed over the same D1 storage. Empty storage admits no
    // machine client; an Access-authenticated operator can provision tokens.
    accessTokens: accessTokens(storage),
    // Code-owned roster. Access proves the identity; connecta derives
    // connector visibility and management permissions from the stable id it
    // supplies. Add `connectorAccess` and `activityAccess` to split members
    // from operators; here every signed-in human may manage every connector
    // and access token. Machine tokens never receive interactive authority.
    identity: {
      credentialAdministration: () => "all",
      personalConnection: () => "all",
      accessTokenManagement: () => true,
    },
    // Connectors that declare a `credential` slot become editable by every
    // signed-in human who can see that connector, encrypted with this key
    // before anything reaches D1. A saved replacement takes effect on the
    // next call; credentials fail at use.
    vault: env.CREDENTIAL_ENCRYPTION_KEY ? encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY) : undefined,
    // Payload-free activity at /ui/api/activity in CONNECTA_DB. The shared
    // D1 mapping persists the build version and validated client facts, and
    // adds nullable columns to old tables. Each write prunes expired rows.
    activity:
      env.CONNECTA_ACTIVITY === "on"
        ? activityHistory({
            store: d1ActivityStore(env.CONNECTA_DB, { retentionDays: 90 }),
            deploymentId: "production",
          })
        : undefined,
    // Branding is code too: operatorUi({ branding }).
    ui: operatorUi(),
    connectors: [
      remoteMcp("notion", {
        url: "https://mcp.notion.com/mcp",
        description: "Notion — pages, databases, comments (static token)",
        auth: {
          type: "headers",
          headers: { Authorization: `Bearer ${env.DOWNSTREAM_TOKEN}` },
          // The vault-backed alternative for a downstream that authenticates
          // with a static key: the operator manages it inside its connection
          // in the operator UI, so no Worker secret holds it.
          //   type: "credential",
          //   credential: { label: "Notion internal integration token" },
        },
        // Use `authScope: "personal"` with OAuth or credential auth when each
        // Access user connects their own downstream account. Literal headers
        // are deployment-owned and cannot be personal.
      }),
      api("echo", {
        description: "Echo — text transforms",
        // What a vault-backed connector adds — an operator edits this slot
        // inside its connection and the handler reads it with
        // `await ctx.credential?.get()`, so the secret never lives in source:
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
  };
});
