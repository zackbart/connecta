/**
 * connecta on Cloudflare Workers. Configuration lives in connecta.config.ts,
 * which also lists setup; this file only starts it.
 */
import { createConnecta, type Connecta, type ConnectaConfig } from "@zackbart/connecta";
import connectaConfig, { type Env } from "./connecta.config.js";

// Lazy per-isolate singleton: reuses the plain-data tool cache. Downstream MCP
// clients are request-scoped internally so Worker I/O never crosses requests.
let started: { config: ConnectaConfig; connecta: Connecta } | undefined;
function start(env: Env) {
  if (!started) {
    const config = connectaConfig(env);
    started = { config, connecta: createConnecta(config) };
  }
  return started;
}

export default {
  // Pass `ctx` through: deferred work (activity sinks) settles on ctx.waitUntil.
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => start(env).connecta.fetch(request, env, ctx),
  // The wrangler cron, off until enabled, refreshes due artifact pages.
  // Activity needs no cron: each write prunes rows past its retention.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await start(env).config.artifacts?.runDue?.();
  },
};
