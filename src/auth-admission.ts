import { failureRecord, logFailure } from "./operator-record.js";
import { withDeadline } from "./timeout.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext, Logger } from "./types.js";

// Shared by human and agent routes, even across deployments constructed in the
// same loaded core. Isolate-wide state is counters and plain charge records:
// no queue, requests, promises, signals, or I/O.
const AUTHENTICATION_CONCURRENCY = 16;
// Work still unsettled after its hard deadline plus grace leaves the active
// pool for this allowance. Equal to the active limit: one full wave of
// stalls can recover without blocking normal authentication, yet total
// outstanding work never exceeds twice the limit, and a binding that never
// settles fills it and fails closed instead of accumulating I/O.
const ABANDONED_ALLOWANCE = 16;
const SETTLEMENT_GRACE_MS = 1_000;
// Clerk owns a ten-second deadline; custom adapters share that threshold.
const DEFAULT_DEADLINE_MS = 10_000;
// Native Access lookups and agent-token storage reads.
const NATIVE_DEADLINE_MS = 5_000;
let active = 0;
let abandoned = 0;
type Charge = { state: "active" | "abandoned" | "settled" };
// Overdue active charges waiting for abandoned room; at most the active limit.
const overdue = new Set<Charge>();

/** Health counters: plain numbers, no request facts. */
export function authenticationSnapshot() {
  return {
    active,
    limit: AUTHENTICATION_CONCURRENCY,
    abandoned,
    abandonedLimit: ABANDONED_ALLOWANCE,
    abandonedSaturated: abandoned >= ABANDONED_ALLOWANCE,
  };
}

function abandon(charge: Charge): void {
  if (charge.state !== "active") return;
  // A full allowance cannot overflow: the charge keeps its active slot.
  if (abandoned >= ABANDONED_ALLOWANCE) {
    overdue.add(charge);
    return;
  }
  charge.state = "abandoned";
  active--;
  abandoned++;
}

/** Exactly once per charge, only when its underlying work has settled. */
function release(charge: Charge): void {
  if (charge.state === "settled") return;
  overdue.delete(charge);
  if (charge.state === "active") active--;
  else abandoned--;
  charge.state = "settled";
  for (const waiting of overdue) {
    if (abandoned >= ABANDONED_ALLOWANCE) break;
    overdue.delete(waiting);
    abandon(waiting);
  }
}

type Lifetime = { track(pending: Promise<unknown>): void; deadline(ms: number): void };
// Lets built-in adapters register work that has no cancellation API with
// their own invocation, without changing the published adapter contract.
// Keyed by the exact request `authenticate` hands its adapter; no request
// ever reads another request's work or settlement.
const lifetimes = new WeakMap<Request, Lifetime>();

/**
 * Race the caller and a five-second deadline for a native operation that
 * cannot be cancelled. The caller gets a prompt answer; the operation itself
 * stays charged to this invocation until it actually settles.
 */
export function withAuthenticationDeadline<T>(
  request: Request,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifetime = lifetimes.get(request);
  lifetime?.deadline(NATIVE_DEADLINE_MS);
  return withDeadline(
    (signal) => {
      signal.throwIfAborted();
      const pending = operation(signal);
      lifetime?.track(pending);
      return pending;
    },
    { timeoutMs: NATIVE_DEADLINE_MS, signal: request.signal, timeoutError: new Error("Authentication timed out") },
  );
}

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
  if (active >= AUTHENTICATION_CONCURRENCY || abandoned >= ABANDONED_ALLOWANCE) {
    // Callers see one retryable contract; the log and health tell an
    // operator whether stalled bindings, not load, are refusing.
    const reason = abandoned >= ABANDONED_ALLOWANCE ? "authentication_abandoned_saturated" : "authentication_busy";
    logFailure(logger, "Authentication admission refused", failureRecord({ reason }));
    return {
      admitted: false,
      response: Response.json(
        { error: { code: "authentication_busy", message: "Authentication capacity reached.", retryable: true } },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
      ),
    };
  }
  active++;
  const charge: Charge = { state: "active" };
  // The adapter's own promise plus each tracked native operation.
  let remaining = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const finish = () => {
    if (--remaining !== 0) return;
    clearTimeout(timer);
    if (lifetimes.get(request) === lifetime) lifetimes.delete(request);
    release(charge);
    complete();
  };
  const lifetime: Lifetime = {
    deadline(ms) {
      clearTimeout(timer);
      timer = setTimeout(() => abandon(charge), ms + SETTLEMENT_GRACE_MS);
    },
    track(pending) {
      remaining++;
      void pending.then(finish, finish);
    },
  };
  lifetime.deadline(DEFAULT_DEADLINE_MS);
  lifetimes.set(request, lifetime);
  let asynchronous = false;
  try {
    const result = provider.authorize(request, baseUrl, runtimeContext);
    // A synchronous local/cached verdict owns no pending authentication.
    // Release before yielding, rather than holding a slot for a microtask.
    if ("ok" in result) return { admitted: true, result };
    asynchronous = true;
    const pending = result.finally(finish);
    // Keep just this request's settlement continuation runnable when workerd
    // drops the disconnected caller, including native work that outlived the
    // caller-facing deadline. It neither detaches nor starts work.
    settle?.(done);
    return { admitted: true, result: await pending };
  } finally {
    // A caller leaving is not proof that its adapter or SDK has stopped.
    // Keep capacity charged until the underlying authorization settles.
    if (!asynchronous) finish();
  }
}
