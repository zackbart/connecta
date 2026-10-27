// One outcome that a fiber in one request waits on while another request may
// deliver it: a queued admission permit, a shared token refresh.
//
// Effect resumes a waiting fiber synchronously, inside whatever completes the
// Deferred it awaits, and runs it in the async context it suspended in: the
// fiber captured a `node:async_hooks` AsyncResource when it suspended and
// resumes through `runInAsyncScope`. On Workers that context belongs to the
// waiter's request. workerd refuses to enter it from another request ("Cannot
// call this AsyncLocalStorage bound function outside of the request in which
// it was created.") when the Worker's compatibility date is 2025-06-16 or
// later, in releases since September 2026. The refusal throws out of the call
// that completed the Deferred, failing the request that released a slot, and
// the waiter never resumes (#1106). Awaiting a Promise around that wait is no
// help: the fiber waiting on the Deferred inside the Promise is resumed in the
// completing request just the same.
//
// So nothing here resumes a fiber. `settle` records the outcome and resolves,
// for each waiter, a Promise that the waiter's own request created. workerd
// runs a Promise's reactions in the request that created it, whichever
// request resolves it; Node runs them one microtask later in the waiter's
// async context. The waiter resumes there. The record itself is synchronous,
// so a queue's arbitration reads the outcome at once, and a waiter that leaves
// before it wakes can still give back what it was handed.

import { Effect, type Exit } from "effect";

export class Settlement<A, E = never> {
  private exit: Exit.Exit<A, E> | undefined;
  private readonly wakers = new Set<() => void>();

  /** The recorded outcome; undefined until `settle` runs. */
  get outcome(): Exit.Exit<A, E> | undefined {
    return this.exit;
  }

  /** Record the first outcome and wake each waiter in its own request. */
  settle(exit: Exit.Exit<A, E>): boolean {
    if (this.exit) return false;
    this.exit = exit;
    const wakers = [...this.wakers];
    this.wakers.clear();
    for (const wake of wakers) wake();
    return true;
  }

  /** The outcome, waited for by a fiber that resumes in its own request. */
  wait(): Effect.Effect<A, E> {
    return Effect.suspend(
      () =>
        this.exit ??
        Effect.callback<A, E>((resume) => {
          let wake!: () => void;
          // Created here, by the waiting fiber, so it belongs to the waiting
          // request whichever request resolves it.
          void new Promise<void>((resolve) => {
            wake = resolve;
          }).then(() => resume(this.exit!));
          this.wakers.add(wake);
          return Effect.sync(() => {
            this.wakers.delete(wake);
          });
        }),
    );
  }
}
