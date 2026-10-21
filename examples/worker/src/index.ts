/**
 * connecta on Cloudflare Workers. Configuration lives in connecta.config.ts,
 * which also lists setup; this file only starts it.
 */
import { createConnecta, workerHandler } from "@zackbart/connecta";
import connectaConfig, { type Env } from "./connecta.config.js";

// The Worker's outermost fetch handler: export it as is, never wrapped by
// middleware or called from another handler. Only then can connecta recover
// authentication work the platform cancelled; /health reports it as
// `admission.authentication.retirement`. Keep enable_request_signal set.
// Add other handlers beside it: `export default { ...handler, scheduled }`.
// One instance per isolate, from the first request's env, reuses the
// plain-data tool cache. Downstream MCP clients are request-scoped internally
// so Worker I/O never crosses requests, and deferred work (activity sinks)
// settles on that event's ctx.waitUntil.
const handler = workerHandler((env: Env) => {
  const config = connectaConfig(env);
  return createConnecta(config);
}) satisfies ExportedHandler<Env>;

export default handler;
