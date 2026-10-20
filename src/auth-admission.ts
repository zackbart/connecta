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
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active--;
  };
  // workerd can discard an awaiting continuation on disconnect. Only this
  // owning request's abort handler releases its slot; finally is idempotent.
  request.signal.addEventListener("abort", release, { once: true });
  try {
    const result = provider.authorize(request, baseUrl, runtimeContext);
    // A synchronous local/cached verdict owns no pending authentication.
    // Release before yielding, rather than holding a slot for a microtask.
    return { admitted: true, result: "ok" in result ? result : await result };
  } finally {
    request.signal.removeEventListener("abort", release);
    release();
  }
}
