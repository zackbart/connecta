import { workerRetirement, type AuthenticationRetirement } from "./auth-admission.js";
import type { Connecta } from "./index.js";

type WorkerEntry = (request: Request, ctx: unknown, retirement: AuthenticationRetirement) => Promise<Response>;
// Each createConnecta() instance's private entry: the public `fetch` never
// accepts a retirement decision from its caller.
const entries = new WeakMap<Connecta, WorkerEntry>();

export function registerWorkerEntry(connecta: Connecta, entry: WorkerEntry): void {
  entries.set(connecta, entry);
}

/** An instance's private entry, for `workerHandler` and contributor tests. */
export function workerEntry(connecta: Connecta): WorkerEntry {
  const entry = entries.get(connecta);
  if (!entry) throw new TypeError("workerHandler: start(env) must return a createConnecta() instance");
  return entry;
}

/** A Worker module's fetch handler, exported unwrapped as its default. */
export interface WorkerHandler<Env = unknown> {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response>;
}

/**
 * The Worker's outermost fetch handler. Export it unwrapped as the module's
 * default (`export default workerHandler(start)`), or spread it beside other
 * handlers, keeping this exact `fetch`. `start(env)` runs on the first request
 * of each isolate, and its instance serves every later request.
 *
 * Only when workerd itself calls this `fetch` for a fetch event, with
 * `enable_request_signal` set, does Connecta know the invocation's real end,
 * and so retire authentication charges it has stranded. Called by any other
 * code, it serves the same responses with Node accounting; `/health` reports
 * which (`admission.authentication.retirement`).
 */
export function workerHandler<Env>(start: (env: Env) => Connecta): WorkerHandler<Env> {
  let started: Connecta | undefined;
  return Object.freeze({
    fetch: function fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
      // First and synchronous: only here is the caller's frame observable.
      const retirement = workerRetirement(fetch, ctx);
      try {
        started ??= start(env);
        return workerEntry(started)(request, ctx, retirement);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
}
