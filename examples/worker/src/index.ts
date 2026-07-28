/**
 * connecta on Cloudflare Workers.
 *
 * One MCP endpoint aggregating a downstream remote MCP and an HTTP API behind
 * the nine base meta-tools, guarded by Clerk OAuth *and* a static bearer token,
 * with OAuth/cache state in a KV namespace. Add the optional Worker Loader
 * binding in wrangler.jsonc to register execute_code.
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
 *   5. Optional paid code mode: add the documented `worker_loaders` binding to
 *      wrangler.jsonc. Binding presence enables execute_code automatically.
 *   6. `wrangler deploy` from this folder (examples/worker), where wrangler.jsonc
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
  /** Bearer token for one headless client in this deployment's audience. */
  SUPPORT_TOKEN: string;
  /** Bearer token for another headless client in the same audience. */
  EXEC_TOKEN: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  DOWNSTREAM_TOKEN: string;
  PUBLIC_URL: string;
  /**
   * Worker Loader binding (wrangler.jsonc `worker_loaders`) powering the
   * optional execute_code meta-tool. Dynamic Workers require the Workers Paid
   * plan; leave the binding absent for the nine base meta-tools on either plan.
   */
  LOADER?: WorkerLoader;
}

function build(env: Env) {
  return createConnecta({
    publicUrl: env.PUBLIC_URL,
    storage: cloudflareKvStorage(env.CONNECTA_KV),
    // Binding-as-switch: adding worker_loaders in wrangler.jsonc enables code
    // mode; leaving it absent keeps this deployment free-tier compatible.
    ...(env.LOADER
      ? { executor: new DynamicWorkerExecutor({ loader: env.LOADER }) }
      : {}),
    auth: [
      // Multiple credentials may identify callers in one deployment. Every
      // admitted caller reaches this deployment's deliberate connector set.
      bearerToken(env.SUPPORT_TOKEN, {
        subjectId: "support-team",
      }),
      bearerToken(env.EXEC_TOKEN, {
        subjectId: "exec-team",
      }),
      // The operator signs in with Clerk. Restrict who may sign in with
      // `allowedDomains` (or a `gate`, for anything a domain cannot express).
      clerkAuth({
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        secretKey: env.CLERK_SECRET_KEY,
        publicUrl: env.PUBLIC_URL,
        // allowedDomains: ["acme.com"],
      }),
    ],
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
    const defer = ctx.waitUntil.bind(ctx);
    ctx.waitUntil(connecta.checkCredentials({ defer }));
  },
};
