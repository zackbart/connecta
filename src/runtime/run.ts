// The one place an Effect becomes a Promise.
//
// Connecta's published surface is Promise-shaped and stays that way; Effect is
// an implementation detail behind it. Every edge where a fiber starts runs
// through this module, so the rules for that crossing live in one file instead
// of being re-derived at each call site — and test/purity.test.ts fails if any
// other file under src/ calls Effect.run*, runFork, forkDaemon, or
// ManagedRuntime.make.
//
// Two things the stock runners get wrong for this codebase:
//
// - The default MixedScheduler yields through setImmediate, which vitest's
//   fake timers replace. A fiber that yields under vi.useFakeTimers() then
//   waits for a timer tick nobody advances. Yielding through a microtask keeps
//   fibers moving under fakes, and Workers never had setImmediate to begin
//   with. The cost is that a fiber never yields to I/O, which is why CPU-heavy
//   work stays out of Effect loops.
// - Effect.runPromise rejects an interrupted fiber with a generic "All fibers
//   interrupted without error". Callers of withDeadline today see the abort
//   reason the caller chose, and runEdge keeps it that way.

import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  type Layer,
  ManagedRuntime,
  Scheduler,
} from "effect";
import type { DeadlineOptions } from "../timeout.js";

/** Yield to the scheduler through the microtask queue, never a timer. */
function setMicrotask(task: () => void): () => void {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) task();
  });
  return () => {
    cancelled = true;
  };
}

/** The scheduler every edge-run fiber uses; see the header for why. */
export const microtaskScheduler: Scheduler.Scheduler =
  new Scheduler.MixedScheduler("async", setMicrotask);

const runExit = Effect.runPromiseExitWith(
  Context.make(Scheduler.Scheduler, microtaskScheduler),
);

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("aborted", "AbortError");
}

/**
 * Turn a failed Exit back into the value a Promise caller would have seen.
 *
 * An interrupt caused by the caller's signal wins, as the abort does in
 * withDeadline's race. Otherwise the first typed failure is rethrown as is,
 * then the first defect — never a wrapper, because callers check `instanceof`,
 * `name`, and `message` on connecta's own error classes.
 */
function rethrow(cause: Cause.Cause<unknown>, signal: AbortSignal | undefined): never {
  const reasons = cause.reasons;
  if (signal?.aborted && reasons.some(Cause.isInterruptReason)) {
    throw abortReason(signal);
  }
  const failure = reasons.find(Cause.isFailReason);
  if (failure) throw failure.error;
  const defect = reasons.find(Cause.isDieReason);
  if (defect) throw defect.defect;
  throw abortReason(signal);
}

/**
 * Long-lived services an edge run can be handed: one per Connecta, holding
 * what createConnecta resolved at construction (src/runtime/services.ts).
 *
 * Making one runs nothing. The layer is built by the first run that needs it,
 * on that run's scheduler, and released by disposeEdgeRuntime — which is why
 * a Worker can create its Connecta at global scope, where no fiber may start.
 * Fibers run against it are not owned by it: disposing releases the layer's
 * resources and refuses later runs, but never interrupts work in flight,
 * because close() drains active work rather than cutting it off.
 */
export type EdgeRuntime<R> = ManagedRuntime.ManagedRuntime<R, never>;

const disposedRuntimes = new WeakSet<EdgeRuntime<never>>();

/** Wrap a layer as an EdgeRuntime without building it. */
export function makeEdgeRuntime<R>(layer: Layer.Layer<R>): EdgeRuntime<R> {
  return ManagedRuntime.make(layer);
}

/**
 * Release a runtime's layer resources. Idempotent, and never rejects: a
 * finalizer that fails has nobody left to report to.
 */
export async function disposeEdgeRuntime(
  runtime: EdgeRuntime<never>,
): Promise<void> {
  if (disposedRuntimes.has(runtime)) return;
  disposedRuntimes.add(runtime);
  // Through runExit rather than runtime.dispose(), whose runner yields on
  // Effect's default scheduler — the one vitest's fake timers freeze.
  await runExit(runtime.disposeEffect);
}

/**
 * The effect with the runtime's services provided, building them first when
 * no run has yet. The build runs on the calling fiber's scheduler, so it is
 * the microtask scheduler here, as everything else is.
 */
function provideRuntime<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtime: EdgeRuntime<R>,
): Effect.Effect<A, E> {
  if (disposedRuntimes.has(runtime)) {
    return Effect.die(new Error("This Connecta has been closed."));
  }
  const built = runtime.cachedContext;
  if (built) return Effect.provideContext(effect, built);
  return Effect.flatMap(runtime.contextEffect, (context) =>
    Effect.provideContext(effect, context),
  );
}

export interface EdgeOptions {
  /** Interrupts the fiber when aborted; its reason becomes the rejection. */
  signal?: AbortSignal | undefined;
}

export interface EdgeRuntimeOptions<R> extends EdgeOptions {
  /** Supplies the services the effect requires. */
  runtime: EdgeRuntime<R>;
}

/**
 * Run an effect at a Promise boundary.
 *
 * Resolves with the success value. Rejects with the original Fail error or Die
 * defect, and with `signal.reason` (or an AbortError) when interrupted. An
 * effect that requires services takes them from `runtime`; a run against a
 * disposed runtime dies before the effect starts.
 */
export function runEdge<A, E>(
  effect: Effect.Effect<A, E>,
  options?: EdgeOptions,
): Promise<A>;
export function runEdge<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: EdgeRuntimeOptions<R>,
): Promise<A>;
export async function runEdge<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: EdgeOptions & { runtime?: EdgeRuntime<R> } = {},
): Promise<A> {
  const exit = await runExit(
    options.runtime
      ? provideRuntime(effect, options.runtime)
      // Without a runtime the overloads admit only an effect that requires
      // nothing, so there is nothing to provide.
      : (effect as Effect.Effect<A, E>),
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  return rethrow(exit.cause, options.signal);
}

/**
 * Fail with the signal's abort reason once it aborts; never succeed.
 *
 * Race it against work that should stop when the signal does. A signal
 * aborted without a reason fails with an AbortError, as `fetch` would.
 */
export function fromSignal(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback<never, unknown>((resume) => {
    // Remove the listener on every path, firing included. `once` already
    // drops it from a real AbortSignal, but the cleanup below runs only on
    // interruption, and a signal-shaped wrapper sees no removal otherwise.
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resume(Effect.fail(abortReason(signal)));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * The Effect form of withDeadline (src/timeout.ts), with the same contract.
 *
 * The operation gets a signal of its own. The caller's signal is forwarded to
 * it, and the deadline aborts it with the labelled `timeoutError` *before* the
 * operation's fiber is interrupted, so work that honors the signal sees the
 * same reason the caller does. Either abort fails the effect with that reason:
 * the caller's, or `timeoutError`. The signal is always aborted on exit, as
 * withDeadline's `finally` does.
 *
 * The error channel is `unknown` because an abort reason is whatever the
 * caller chose.
 */
export function withDeadlineEffect<A, E, R>(
  operation: (signal: AbortSignal) => Effect.Effect<A, E, R>,
  options: DeadlineOptions,
): Effect.Effect<A, unknown, R> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    // One race, not a race nested in a race: every contender is a forked
    // fiber, and forks are most of what a deadline costs (P1-S02 measured
    // about 2µs per raceFirst). Fork order is unchanged — operation, abort,
    // timer — and the timer still aborts the signal before anything is
    // interrupted, so the abort contender wins with the labelled reason.
    const contenders: Array<Effect.Effect<A, unknown, R>> = [
      Effect.suspend(() => operation(controller.signal)),
      fromSignal(controller.signal),
    ];
    if (options.timeoutMs !== undefined) {
      contenders.push(
        Effect.sleep(Duration.millis(options.timeoutMs)).pipe(
          Effect.andThen(
            Effect.sync(() => controller.abort(options.timeoutError)),
          ),
          Effect.andThen(Effect.never),
        ),
      );
    }
    return Effect.raceAllFirst(contenders).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          controller.abort();
          options.signal?.removeEventListener("abort", forwardAbort);
        }),
      ),
    );
  });
}

export interface DetachContext {
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

/**
 * The only sanctioned fire-and-forget.
 *
 * On Workers the work is handed to `ctx.waitUntil`, so the platform keeps the
 * invocation alive until it settles rather than freezing it mid-flight. The
 * returned promise never rejects: the outcome is the effect's own business,
 * and an unhandled rejection from background work helps nobody.
 */
export function detach(
  effect: Effect.Effect<unknown, unknown>,
  ctx?: DetachContext,
): Promise<void> {
  const settled = runExit(effect).then(
    () => {},
    () => {},
  );
  ctx?.waitUntil?.(settled);
  return settled;
}
