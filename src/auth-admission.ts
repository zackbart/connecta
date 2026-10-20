import { failureRecord, logFailure } from "./operator-record.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext, Logger } from "./types.js";

// Shared by human and agent routes, even across deployments constructed in the
// same loaded core. No queue, promises, signals, or I/O in isolate-wide state.
const AUTHENTICATION_CONCURRENCY = 16;
let active = 0;

/** The sole route boundary for invoking an inbound adapter, including its SDK. */
export async function authenticate(
  provider: InboundAuth,
  request: Request,
  baseUrl: string,
  runtimeContext: InboundAuthRuntimeContext | undefined,
  logger: Logger,
  settle?: (pending: Promise<unknown>) => void,
): Promise<{ admitted: true; result: AuthResult } | { admitted: false; response: Response }> {
  request.signal.throwIfAborted();
  if (active >= AUTHENTICATION_CONCURRENCY) {
    logFailure(logger, "Authentication admission refused", failureRecord({ reason: "authentication_busy" }));
    return {
      admitted: false,
      response: Response.json(
        { error: { code: "authentication_busy", message: "Authentication capacity reached.", retryable: true } },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
      ),
    };
  }
  active++;
  let asynchronous = false;
  try {
    const result = provider.authorize(request, baseUrl, runtimeContext);
    // A synchronous local/cached verdict owns no pending authentication.
    // Release before yielding, rather than holding a slot for a microtask.
    if ("ok" in result) return { admitted: true, result };
    // Keep just this request's cancellation/settlement continuation runnable
    // when workerd drops the disconnected caller. This does not detach or
    // start work: the adapter's signal still cancels its upstream I/O.
    asynchronous = true;
    const pending = result.finally(() => {
      active--;
    });
    settle?.(pending.catch(() => {}));
    return { admitted: true, result: await pending };
  } finally {
    // A caller leaving is not proof that its adapter or SDK has stopped.
    // Keep capacity charged until the underlying authorization settles.
    if (!asynchronous) active--;
  }
}
