/**
 * connecta on Cloudflare Workers.
 *
 * One MCP endpoint aggregating a downstream remote MCP and an HTTP API behind
 * the nine meta-tools plus execute_code (code mode, Dynamic Worker sandbox),
 * guarded by Clerk OAuth *and* a static bearer token, with OAuth/cache state
 * in a KV namespace.
 *
 * Setup (this example has no package.json of its own — it self-references the
 * installed `@zackbart/connecta` package):
 *   1. `npm install` in the connecta package root (../../ from here) so the
 *      package import and wrangler resolve.
 *   2. Create a KV namespace and put its id in wrangler.jsonc under `kv_namespaces`.
 *   3. Set secrets:
 *        wrangler secret put SUPPORT_TOKEN
 *        wrangler secret put EXEC_TOKEN
 *        wrangler secret put CLERK_SECRET_KEY
 *        wrangler secret put DOWNSTREAM_TOKEN
 *      and CLERK_PUBLISHABLE_KEY + PUBLIC_URL as plain vars in wrangler.jsonc.
 *   4. Enable Dynamic Client Registration in the Clerk dashboard
 *        (OAuth Applications -> DCR toggle) so Claude/Cursor can self-register.
 *   5. `wrangler deploy` from this folder (examples/worker), where wrangler.jsonc
 *      lives. Point your MCP client at `<PUBLIC_URL>/mcp`.
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import {
  api,
  bearerToken,
  createConnecta,
  remoteMcp,
} from "@zackbart/connecta";
import { clerkAuth } from "@zackbart/connecta/auth/clerk";
import { cloudflareKvStorage } from "./cloudflare-kv.js";

interface Env {
  CONNECTA_KV: KVNamespace;
  /** Bearer token for the support team, bound to the `support` toolkit. */
  SUPPORT_TOKEN: string;
  /** Bearer token for the exec team, bound to the `exec` toolkit. */
  EXEC_TOKEN: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  DOWNSTREAM_TOKEN: string;
  PUBLIC_URL: string;
  /**
   * Worker Loader binding (wrangler.jsonc `worker_loaders`) powering the
   * optional execute_code meta-tool. Dynamic Workers is in open beta on paid
   * plans; delete the binding + the `executor` line below to run without it —
   * connecta then serves the nine base meta-tools.
   */
  LOADER?: WorkerLoader;
}

function build(env: Env) {
  return createConnecta({
    publicUrl: env.PUBLIC_URL,
    storage: cloudflareKvStorage(env.CONNECTA_KV),
    // Code mode: models can orchestrate the connectors below in sandboxed JS.
    ...(env.LOADER
      ? { executor: new DynamicWorkerExecutor({ loader: env.LOADER }) }
      : {}),
    auth: [
      // One credential per team, each BOUND to that team's toolkit: the support
      // token can open ?toolkit=support and nothing else — not the exec view,
      // and not an unscoped session over the whole registry. Enforced at connect
      // time, before any scoped registry exists.
      bearerToken(env.SUPPORT_TOKEN, {
        subjectId: "support-team",
        toolkits: ["support"],
      }),
      bearerToken(env.EXEC_TOKEN, {
        subjectId: "exec-team",
        toolkits: ["exec"],
      }),
      // The operator signs in with Clerk. `unscoped: true` keeps the full
      // registry, operator pages, and the deployment-wide activity log. Saying
      // so explicitly (rather than leaving the provider unbound) is what tells
      // connecta the exemption is deliberate, so it stops warning that one
      // credential still opens every view. Restrict WHO may sign in with
      // `allowedDomains` (or a `gate`, for anything a domain cannot express);
      // for per-team Clerk users, add one clerkAuth per team, each with its own
      // admission rule and its own `toolkits`.
      clerkAuth({
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        secretKey: env.CLERK_SECRET_KEY,
        publicUrl: env.PUBLIC_URL,
        // allowedDomains: ["acme.com"],
        toolkits: ["support", "exec"],
        unscoped: true,
      }),
    ],
    // Multi-team setup: one deployment for the org, one scoped view per group
    // of team members. A client picks its view at connect time with a query
    // parameter on the MCP URL — and its credential decides whether it may:
    //
    //   support team → <PUBLIC_URL>/mcp?toolkit=support   (SUPPORT_TOKEN)
    //   exec team    → <PUBLIC_URL>/mcp?toolkit=exec      (EXEC_TOKEN)
    //   operators    → <PUBLIC_URL>/mcp                   (Clerk ⇒ everything)
    //
    // Inside a scoped session the meta-tools behave as if out-of-scope
    // connectors and tools do not exist, and an out-of-scope address fails
    // exactly like a nonexistent one. Unknown toolkit names are rejected, never
    // silently widened; a toolkit a credential is not bound to is refused with a
    // 403 that looks exactly like the refusal for a name that does not exist.
    // See docs/toolkits.md.
    toolkits: {
      support: { connectors: ["notion"] },
      exec: {
        connectors: ["notion", "echo"],
        // Finer grain than a connector id — hide one address from this view.
        excludeTools: ["echo.shout"],
      },
    },
    connectors: [
      remoteMcp("notion", {
        url: "https://mcp.notion.com/mcp",
        description: "Notion — pages, databases, comments (static token)",
        auth: {
          type: "headers",
          headers: { Authorization: `Bearer ${env.DOWNSTREAM_TOKEN}` },
        },
      }),
      api("echo", {
        description: "Echo — text transforms",
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

  // Credential health (wrangler.jsonc `triggers.crons`): probe the stored
  // downstream credentials on a schedule so a revoked or expired token flips the
  // connector to auth_required *before* an agent's call fails on it. Workers
  // have no long-lived timers, so the cron trigger IS the scheduler; connecta
  // exposes the check as a plain awaited call and does no background work of its
  // own. The verdicts are persisted in KV, which is what makes them visible to
  // the fetch isolates — this handler runs in a different one.
  //
  // Checks are rate-limited per connector (default: at most one every 15
  // minutes, however many triggers fire), so this is safe to schedule tightly.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    connecta ??= build(env);
    ctx.waitUntil(connecta.checkCredentials());
  },
};
