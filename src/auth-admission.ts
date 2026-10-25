import { Effect } from "effect";
import { authCall, AuthenticationWork, authProgram, authValue, hasAuthProgram, registerAuth } from "./auth/native.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
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
let active = 0;
let abandoned = 0;
// Charges released by the collector and not yet logged: a plain number.
let unreachable = 0;
// A plain record. It never references its token, request, work, or callbacks,
// or the collector could never free that token while the record lives.
type Charge = { state: "active" | "abandoned" | "released" };
// Overdue active charges waiting for abandoned room; at most the active limit.
const overdue = new Set<Charge>();

// The one release that is not a settlement. Each charge's token is reachable
// only through the continuations attached to its adapter promise and native
// operations, plus its deadline timer and its request's lifetime entry. While
// any of that work can still settle, whatever would settle it reaches the
// token. Once the collector frees the token, nothing can ever settle the
// charge, so it is released. Collection is eventual, never timed. A runtime
// without FinalizationRegistry (workerd without `enable_weak_ref` before the
// 2025-05-05 compatibility date) releases on settlement alone.
const collector =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<Charge>((charge) => {
        if (release(charge)) unreachable++;
      })
    : undefined;

/** Health counters: plain numbers and one runtime fact, no request facts. */
export function authenticationSnapshot() {
  return {
    active,
    limit: AUTHENTICATION_CONCURRENCY,
    abandoned,
    abandonedLimit: ABANDONED_ALLOWANCE,
    abandonedSaturated: abandoned >= ABANDONED_ALLOWANCE,
    unreachableRelease: collector !== undefined,
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
 * Exactly once per charge: when its underlying work has settled, or when the
 * collector proves it never can. The flag lives in the record, so a second
 * attempt from either path changes nothing.
 */
function release(charge: Charge): boolean {
  if (charge.state === "released") return false;
  overdue.delete(charge);
  if (charge.state === "active") active--;
  else abandoned--;
  charge.state = "released";
  for (const waiting of overdue) {
    if (abandoned >= ABANDONED_ALLOWANCE) break;
    overdue.delete(waiting);
    abandon(waiting);
  }
  return true;
}

type Lifetime = { track(pending: Promise<unknown>): void; deadline(ms: number): void };
// Lets built-in adapters register work that has no cancellation API with
// their own invocation, without changing the published adapter contract.
// Keyed by the exact request `authenticate` hands its adapter; no request
// ever reads another request's work or settlement. The entry refers to its
// lifetime weakly: workerd keeps a Request, and whatever a WeakMap keys on it,
// alive after its invocation ends, so a strong entry would pin every token.
// While the adapter can still reach withAuthenticationDeadline, its pending
// promise holds the lifetime through `authenticate`.
const lifetimes = new WeakMap<Request, { deref(): Lifetime | undefined }>();
const weakly = (lifetime: Lifetime) =>
  typeof WeakRef === "function" ? new WeakRef(lifetime) : { deref: () => lifetime };

/**
 * Race the caller and a five-second deadline for a native operation that
 * cannot be cancelled. The caller gets a prompt answer; the operation itself
 * stays charged to this invocation until it actually settles.
 */
export function withAuthenticationDeadline<T>(
  request: Request,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return runEdge(authProgram<T>(withAuthenticationDeadlineNative, [request, operation]));
}
const withAuthenticationDeadlineNative = /* @__PURE__ */ registerAuth(withAuthenticationDeadline, function <
  T,
>(request: Request, operation: (signal: AbortSignal) => Promise<T>) {
  return Effect.suspend(() => {
    const lifetime = lifetimes.get(request)?.deref();
    lifetime?.deadline(NATIVE_DEADLINE_MS);
    const bounded = withDeadlineEffect(
      (signal) => {
        signal.throwIfAborted();
        return authCall<T>(operation, [signal]);
      },
      { timeoutMs: NATIVE_DEADLINE_MS, signal: request.signal, timeoutError: new Error("Authentication timed out") },
    );
    // A custom decorator may call the saved Promise shell. Reuse this exact
    // request's charge even when native consumer dispatch cannot select it.
    return lifetime ? bounded.pipe(Effect.provideService(AuthenticationWork, lifetime)) : bounded;
  });
});

/** Shared capacity refusal: one checked log and retryable HTTP contract. */
export function authenticationBusyResponse(
  logger: Logger,
  reason: "authentication_busy" | "authentication_abandoned_saturated" = "authentication_busy",
): Response {
  logFailure(logger, "Authentication admission refused", failureRecord({ reason }));
  return Response.json(
    { error: { code: "authentication_busy", message: "Authentication capacity reached.", retryable: true } },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
  );
}

/** The sole route boundary for invoking an inbound adapter, including its SDK. */
export function authenticate(
  provider: InboundAuth,
  request: Request,
  baseUrl: string,
  runtimeContext: InboundAuthRuntimeContext | undefined,
  logger: Logger,
  settle?: (pending: Promise<unknown>) => void,
): Promise<
  | {
      admitted: true;
      result: AuthResult;
    }
  | {
      admitted: false;
      response: Response;
    }
> {
  return runEdge(
    authProgram<
      | {
          admitted: true;
          result: AuthResult;
        }
      | {
          admitted: false;
          response: Response;
        }
    >(authenticateNative, [provider, request, baseUrl, runtimeContext, logger, settle]),
  );
}
const authenticateNative = /* @__PURE__ */ registerAuth(
  authenticate,
  function (
    provider: InboundAuth,
    request: Request,
    baseUrl: string,
    runtimeContext: InboundAuthRuntimeContext | undefined,
    logger: Logger,
    settle?: (pending: Promise<unknown>) => void,
  ) {
    return Effect.suspend<Awaited<ReturnType<typeof authenticate>>, unknown>(() => {
      request.signal.throwIfAborted();
      if (unreachable > 0) {
        unreachable = 0;
        logFailure(
          logger,
          "Authentication released after its pending work became unreachable",
          failureRecord({ reason: "authentication_unreachable" }),
        );
      }
      if (active >= AUTHENTICATION_CONCURRENCY || abandoned >= ABANDONED_ALLOWANCE) {
        const reason = abandoned >= ABANDONED_ALLOWANCE ? "authentication_abandoned_saturated" : "authentication_busy";
        return Effect.succeed({
          admitted: false,
          response: authenticationBusyResponse(logger, reason),
        });
      }
      active++;
      const charge: Charge = { state: "active" };
      const token = {};
      collector?.register(token, charge, token);
      let remaining = 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let complete!: () => void;
      const done = new Promise<void>((resolve: (value: void | PromiseLike<void>) => void) => {
        complete = resolve;
      });
      const finish = () => {
        if (--remaining !== 0) return;
        clearTimeout(timer);
        collector?.unregister(token);
        if (lifetimes.get(request)?.deref() === lifetime) lifetimes.delete(request);
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
      lifetimes.set(request, weakly(lifetime));
      // Native verification composes in this request and accounts for the
      // real settlement of every uncancellable SDK/platform leaf.
      if (hasAuthProgram(provider.authorize)) {
        settle?.(done);
        return authCall<AuthResult>(provider.authorize, [request, baseUrl, runtimeContext], provider).pipe(
          Effect.provideService(AuthenticationWork, lifetime),
          Effect.ensuring(Effect.sync(finish)),
          Effect.map((result) => ({ admitted: true as const, result })),
        );
      }
      let asynchronous = false;
      try {
        const result = provider.authorize(request, baseUrl, runtimeContext);
        if ("ok" in result) return Effect.succeed({ admitted: true as const, result });
        asynchronous = true;
        const pending = result.finally(finish);
        settle?.(done);
        return authValue<AuthResult>(() => pending).pipe(Effect.map((result) => ({ admitted: true as const, result })));
      } finally {
        if (!asynchronous) finish();
      }
    });
  },
);
