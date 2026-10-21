import { failureRecord, logFailure } from "./operator-record.js";
import { withDeadline } from "./timeout.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext, Logger } from "./types.js";

// Shared by human and agent routes, even across deployments constructed in the
// same loaded core. Isolate-wide state is counters and plain charge records:
// no queue, requests, promises, signals, or I/O.
const AUTHENTICATION_CONCURRENCY = 16;
// Work still unsettled after its hard deadline plus grace leaves the active
// pool for this allowance. Equal to the active limit: a partial wave of stalls
// recovers while normal authentication continues, yet total outstanding work
// never exceeds twice the limit, and a full wave, or a binding that never
// settles, fills it and fails closed instead of accumulating I/O.
const ABANDONED_ALLOWANCE = 16;
const SETTLEMENT_GRACE_MS = 1_000;
// Clerk owns a ten-second deadline; custom adapters share that threshold.
const DEFAULT_DEADLINE_MS = 10_000;
// Native Access lookups and agent-token storage reads.
const NATIVE_DEADLINE_MS = 5_000;
// Cloudflare cancels a Worker fetch invocation, with every I/O operation it
// owns, at most 30 seconds after its response is sent or its client
// disconnects (https://developers.cloudflare.com/workers/runtime-apis/context/).
// Its settlement callbacks then never run, so its charges retire once that
// instant has passed. Connecta knows those instants only for an invocation
// whose outermost handler it is (workerHandler). The margin covers the runtime
// finishing a response after Connecta observes it, and Worker clocks that
// advance only on I/O. Every other entry, and Node, makes no such promise:
// there a charge counts until its work really settles.
const WAIT_UNTIL_LIMIT_MS = 30_000;
const TERMINATION_MARGIN_MS = 5_000;
let active = 0;
let abandoned = 0;
/** The latest instant one Worker invocation can still be alive, once known. */
type InvocationBound = { aliveUntil: number | undefined; pending: number };
type Charge = { state: "active" | "abandoned" | "settled" | "retired"; bound: InvocationBound | undefined };
// Overdue active charges waiting for abandoned room; at most the active limit.
const overdue = new Set<Charge>();
// Unsettled charges owned by Worker invocations; at most both limits together.
const terminable = new Set<Charge>();

/** Health counters: plain numbers, no request facts. */
export function authenticationSnapshot(logger?: Pick<Logger, "info" | "warn" | "error">) {
  retireEnded(logger);
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

/**
 * Exactly once per charge: when its underlying work has settled, or when its
 * Worker invocation has certainly ended. A late settlement after retirement
 * finds the charge closed and changes nothing.
 */
function close(charge: Charge, state: "settled" | "retired"): boolean {
  if (charge.state === "settled" || charge.state === "retired") return false;
  overdue.delete(charge);
  terminable.delete(charge);
  if (charge.state === "active") active--;
  else abandoned--;
  charge.state = state;
  if (charge.bound) charge.bound.pending--;
  for (const waiting of overdue) {
    if (abandoned >= ABANDONED_ALLOWANCE) break;
    overdue.delete(waiting);
    abandon(waiting);
  }
  return true;
}

/** Lazily retire charges whose invocation, and so all its I/O, has ended. */
function retireEnded(logger: Pick<Logger, "info" | "warn" | "error"> | undefined): void {
  const now = Date.now();
  let retired = false;
  for (const charge of terminable) {
    const aliveUntil = charge.bound?.aliveUntil;
    if (aliveUntil !== undefined && now > aliveUntil) retired = close(charge, "retired") || retired;
  }
  if (retired && logger) {
    logFailure(
      logger,
      "Authentication retired after its Worker invocation ended",
      failureRecord({ reason: "authentication_invocation_ended" }),
    );
  }
}

/**
 * Whether an entry may retire its invocation's charges, and if not why: one
 * fixed reason, never a request fact.
 * - `not_workers`: the runtime promises no invocation end.
 * - `not_worker_handler`: the request entered through `connecta.fetch`.
 * - `not_outermost_handler`: other JavaScript called `workerHandler`'s fetch,
 *   or called it without the event's ExecutionContext.
 * - `request_signal_disabled`: without `enable_request_signal`, a client
 *   disconnect before the response is unobservable.
 */
export type AuthenticationRetirement =
  | { enabled: true }
  | {
      enabled: false;
      reason: "not_workers" | "not_worker_handler" | "not_outermost_handler" | "request_signal_disabled";
    };

const isWorkerd = () => typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/** `connecta.fetch` never owns its invocation's outer boundary. */
export function fetchRetirement(): AuthenticationRetirement {
  return { enabled: false, reason: isWorkerd() ? "not_worker_handler" : "not_workers" };
}

type V8ErrorConstructor = {
  captureStackTrace(target: object, below: (...args: never[]) => unknown): void;
  prepareStackTrace: unknown;
  stackTraceLimit: number;
};

/**
 * Whether the runtime itself called `handler`, which must be the caller of
 * this check: no JavaScript frame sits below it. Middleware, a scheduled,
 * queue, or alarm handler, a Durable Object, or an RPC method calling it
 * leaves its own frame. Any doubt answers false. A bare function reference
 * handed to a timer or promise reaction leaves none either; the outermost
 * handler contract (documentation/auth.md) rules that out.
 */
function calledByRuntime(handler: (...args: never[]) => unknown): boolean {
  const V8Error = Error as unknown as V8ErrorConstructor;
  const { prepareStackTrace, stackTraceLimit } = V8Error;
  try {
    V8Error.stackTraceLimit = 1;
    V8Error.prepareStackTrace = (_error: unknown, frames: unknown[]) => frames.length;
    const holder: { stack?: unknown } = {};
    V8Error.captureStackTrace(holder, handler);
    return holder.stack === 0;
  } catch {
    return false;
  } finally {
    try {
      V8Error.prepareStackTrace = prepareStackTrace;
      V8Error.stackTraceLimit = stackTraceLimit;
    } catch {
      // A frozen Error refused the first assignment too.
    }
  }
}

/**
 * Called first, synchronously, by `workerHandler`'s fetch. Retirement needs
 * workerd itself to invoke that exact function for a fetch event, so its
 * context is the event's own ExecutionContext and its Response is the one the
 * platform sends, and `enable_request_signal`, so a client disconnect before
 * that response is observed.
 */
export function workerRetirement(handler: (...args: never[]) => unknown, context: unknown): AuthenticationRetirement {
  if (!isWorkerd()) return { enabled: false, reason: "not_workers" };
  if (!calledByRuntime(handler) || typeof (context as { waitUntil?: unknown } | undefined)?.waitUntil !== "function") {
    return { enabled: false, reason: "not_outermost_handler" };
  }
  const flags = (globalThis as { Cloudflare?: { compatibilityFlags?: Record<string, boolean> } }).Cloudflare
    ?.compatibilityFlags;
  if (flags?.enable_request_signal !== true) return { enabled: false, reason: "request_signal_disabled" };
  return { enabled: true };
}

/** Where a request's authentications settle: its `waitUntil` and, on a Worker, the invocation's end. */
export interface AuthenticationInvocation {
  waitUntil(pending: Promise<unknown>): void;
  readonly bound?: InvocationBound;
}

/**
 * Open the invocation that owns a request's authentications. Only an entry
 * with retirement enabled has a platform end. It is first observed when the
 * client disconnects, the handler fails, or the response the platform sends
 * finishes or is cancelled; until then the invocation may run indefinitely
 * and nothing it owns retires. Every other entry keeps counting until real
 * settlement.
 */
export function openInvocation(
  request: Request,
  context: { waitUntil(pending: Promise<unknown>): void } | undefined,
  retirement: AuthenticationRetirement,
): { invocation: AuthenticationInvocation | undefined; observe(served: Promise<Response>): Promise<Response> } {
  if (!context) return { invocation: undefined, observe: (served) => served };
  const waitUntil = context.waitUntil.bind(context);
  if (!retirement.enabled) return { invocation: { waitUntil }, observe: (served) => served };
  const bound: InvocationBound = { aliveUntil: undefined, pending: 0 };
  const end = () => {
    request.signal.removeEventListener("abort", end);
    bound.aliveUntil ??= Date.now() + WAIT_UNTIL_LIMIT_MS + TERMINATION_MARGIN_MS;
  };
  request.signal.addEventListener("abort", end);
  if (request.signal.aborted) end();
  return {
    invocation: { waitUntil, bound },
    observe: (served) =>
      served.then(
        (response) => {
          // Settled work leaves nothing to retire, and needs no observed body.
          if (bound.pending === 0) return response;
          if (!response.body) {
            end();
            return response;
          }
          return observedBody(response, end);
        },
        (error: unknown) => {
          end();
          throw error;
        },
      ),
  };
}

/** The same response, with a body that reports when the runtime finishes or cancels it. */
function observedBody(response: Response, end: () => void): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            end();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          end();
          controller.error(error);
        }
      },
      cancel(reason) {
        end();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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
  invocation?: AuthenticationInvocation,
): Promise<{ admitted: true; result: AuthResult } | { admitted: false; response: Response }> {
  request.signal.throwIfAborted();
  retireEnded(logger);
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
  const charge: Charge = { state: "active", bound: invocation?.bound };
  if (charge.bound) {
    charge.bound.pending++;
    terminable.add(charge);
  }
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
    close(charge, "settled");
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
    invocation?.waitUntil(done);
    return { admitted: true, result: await pending };
  } finally {
    // A caller leaving is not proof that its adapter or SDK has stopped.
    // Keep capacity charged until the underlying authorization settles.
    if (!asynchronous) finish();
  }
}
