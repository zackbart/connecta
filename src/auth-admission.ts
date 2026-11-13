import { Duration, Effect, Exit } from "effect";
import { authCall, AuthenticationWork, authProgram, authValue, hasAuthProgram, registerAuth } from "./auth/native.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { fromSignal, runEdge, withDeadlineEffect } from "./runtime/run.js";
import { Settlement } from "./runtime/settlement.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext, Logger } from "./types.js";

// Shared by human and agent routes, even across deployments constructed in the
// same loaded core. Isolate-wide state is counters, plain charge records and
// queued settlements: no requests, signals, or I/O.
const AUTHENTICATION_CONCURRENCY = 16;
const QUEUE_LIMIT = 16;
const QUEUE_WAIT_MS = 2_000;
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
type Refusal = "authentication_busy" | "authentication_abandoned_saturated";
const queue: Settlement<Refusal | undefined>[] = [];

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
    queued: queue.length,
    queueLimit: QUEUE_LIMIT,
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
  pump();
  return true;
}

function pump(): void {
  while (queue.length > 0) {
    if (abandoned >= ABANDONED_ALLOWANCE) {
      queue.shift()!.settle(Exit.succeed("authentication_abandoned_saturated"));
      continue;
    }
    if (active >= AUTHENTICATION_CONCURRENCY) return;
    active++;
    queue.shift()!.settle(Exit.succeed(undefined));
  }
}

function leave(ticket: Settlement<Refusal | undefined>): boolean {
  const index = queue.indexOf(ticket);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

function returnGrant(ticket: Settlement<Refusal | undefined>): void {
  const outcome = ticket.outcome;
  if (outcome && Exit.isSuccess(outcome) && outcome.value === undefined) {
    active--;
    pump();
  }
}

// workerd throws when one request reads another request's AbortSignal, so a
// waiter leaves the queue from its own abort listener and timer, and a grant
// reaches it through its own Settlement (src/runtime/settlement.ts).
function queued<A>(
  signal: AbortSignal,
  admitted: () => Effect.Effect<A, unknown>,
  refused: (reason: Refusal) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  const ticket = new Settlement<Refusal | undefined>();
  queue.push(ticket);
  const giveUp = (outcome: Effect.Effect<Refusal | undefined, unknown>) =>
    Effect.suspend(() => (leave(ticket) ? outcome : ticket.wait()));
  let heard = false;
  return Effect.raceAllFirst([
    ticket.wait(),
    Effect.sleep(Duration.millis(QUEUE_WAIT_MS)).pipe(
      Effect.andThen(giveUp(Effect.succeed<Refusal>("authentication_busy"))),
    ),
    fromSignal(signal).pipe(Effect.catch((reason) => giveUp(Effect.fail(reason)))),
  ]).pipe(
    Effect.flatMap((refusal) =>
      Effect.suspend(() => {
        heard = true;
        if (refusal !== undefined) return refused(refusal);
        if (!signal.aborted) return admitted();
        returnGrant(ticket);
        return Effect.fail(signal.reason);
      }),
    ),
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        if (!heard && !leave(ticket)) returnGrant(ticket);
      }),
    ),
  );
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
function authenticationBusyResponse(logger: Logger, reason: Refusal): Response {
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
    return Effect.suspend<Awaited<ReturnType<typeof authenticate>>, unknown, never>(() => {
      request.signal.throwIfAborted();
      if (unreachable > 0) {
        unreachable = 0;
        logFailure(
          logger,
          "Authentication released after its pending work became unreachable",
          failureRecord({ reason: "authentication_unreachable" }),
        );
      }
      // Callers see one retryable contract; the log and health tell an
      // operator whether stalled bindings, not load, are refusing.
      const refused = (reason: Refusal) =>
        Effect.sync(() => ({ admitted: false as const, response: authenticationBusyResponse(logger, reason) }));
      if (abandoned >= ABANDONED_ALLOWANCE) return refused("authentication_abandoned_saturated");
      if (active < AUTHENTICATION_CONCURRENCY && queue.length === 0) {
        active++;
        return admitted();
      }
      if (queue.length >= QUEUE_LIMIT) return refused("authentication_busy");
      return queued(request.signal, admitted, refused);
    });

    function admitted(): Effect.Effect<Awaited<ReturnType<typeof authenticate>>, unknown> {
      const charge: Charge = { state: "active" };
      // Held only by this scope's closures (see `collector`); the registry keeps
      // the record, and the token, as its own unregister key, only weakly.
      const token = {};
      collector?.register(token, charge, token);
      // The adapter's own program or Promise plus each tracked native operation.
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
          timer = setTimeout(() => {
            abandon(charge);
            pump();
          }, ms + SETTLEMENT_GRACE_MS);
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
        // A synchronous local/cached verdict owns no pending authentication.
        // Release before yielding, rather than holding a slot for a microtask.
        if ("ok" in result) return Effect.succeed({ admitted: true as const, result });
        asynchronous = true;
        const pending = result.finally(finish);
        // Keep just this request's settlement continuation runnable when workerd
        // drops the disconnected caller, including native work that outlived the
        // caller-facing deadline. It neither detaches nor starts work.
        settle?.(done);
        return authValue<AuthResult>(() => pending).pipe(Effect.map((result) => ({ admitted: true as const, result })));
      } finally {
        // A caller leaving is not proof that its adapter or SDK has stopped.
        // Keep capacity charged until the underlying authorization settles.
        if (!asynchronous) finish();
      }
    }
  },
);
