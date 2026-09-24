// One read that several readers in one request wait on, each on its own terms.
//
// Discovery and the registry both coalesce a connector's catalog read inside
// one request, so a search, a describe, and the call after them cost one
// downstream listing. The read used to run under whichever reader asked
// first: its signal was the read's signal, so a short-deadline call that
// happened to start the read failed a search that joined it with the call's
// timeout, and a cancelled search cancelled a read others were still waiting
// on (#571).
//
// So the read owns its signal. Each reader waits under its own cancellation,
// and the read is cancelled only when no reader is left to want it. Nothing
// here is shared across requests: a SharedRead lives in one request's map and
// is waited on only by that request's fibers, which is why a plain count of
// readers is enough and no edge is needed between them.

import { Deferred, Effect, Exit } from "effect";

export class SharedRead<A> {
  private readonly controller = new AbortController();
  private readonly outcome = Deferred.makeUnsafe<A, unknown>();
  private readers = 0;
  private ended = false;

  /**
   * Start `read` at once, under a signal the read owns. `onEnd` runs once:
   * when the read settles, with whether it succeeded, or when it is cancelled
   * first, with `false`. It runs before any reader hears the outcome, so an
   * owner that evicts the read there sends a reader who retries on hearing of
   * a failure to a fresh read, never back to this one.
   */
  constructor(
    read: (signal: AbortSignal) => PromiseLike<A>,
    private readonly onEnd: (succeeded: boolean) => void = () => {},
  ) {
    // The executor turns a synchronous throw from `read` into a rejection.
    new Promise<A>((resolve) => resolve(read(this.controller.signal))).then(
      (value) => this.settle(Exit.succeed(value)),
      (cause: unknown) => this.settle(Exit.fail(cause)),
    );
  }

  private settle(exit: Exit.Exit<A, unknown>): void {
    this.end(Exit.isSuccess(exit));
    Deferred.doneUnsafe(this.outcome, exit);
  }

  private end(succeeded: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd(succeeded);
  }

  // Cancel the read for good. After this it is no longer joinable: whatever
  // it eventually settles with still reaches the readers already waiting, but
  // its owner has evicted it and a newcomer starts afresh.
  private cancel(reason: unknown): void {
    if (this.ended) return;
    this.controller.abort(reason);
    this.end(false);
  }

  /**
   * Wait for the read under this reader's own cancellation.
   *
   * A reader whose signal aborts while others still wait fails at once with
   * its own reason and leaves the read to them. The last reader's abort is the
   * read's: it is forwarded to the read's signal and that reader waits for the
   * read's answer, as a lone reader always has, so a connector that finishes
   * its listing anyway still hands it over. A reader that is interrupted — its
   * deadline, as `withDeadlineEffect` ends it — simply leaves, and when it was
   * the last one the read is cancelled with its reason.
   */
  join(signal?: AbortSignal): Effect.Effect<A, unknown> {
    return Effect.suspend(() => {
      this.readers++;
      let waiting = true;
      const leave = Effect.sync(() => {
        if (!waiting) return;
        waiting = false;
        this.readers--;
        if (this.readers === 0) this.cancel(signal?.reason);
      });
      const answer = Deferred.await(this.outcome);
      const own = signal
        ? Effect.raceFirst(answer, this.leftBy(signal))
        : answer;
      return Effect.ensuring(own, leave);
    });
  }

  // Fails with the reader's abort reason when other readers remain; when it is
  // the last, forwards the abort to the read and never completes, leaving the
  // read's own answer to win the race.
  private leftBy(signal: AbortSignal): Effect.Effect<never, unknown> {
    return Effect.callback<never, unknown>((resume) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        if (this.readers > 1) {
          resume(Effect.fail(signal.reason));
        } else {
          this.cancel(signal.reason);
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
  }
}
