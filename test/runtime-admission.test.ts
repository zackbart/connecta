// Admission and deadlines run on Effect behind their Promise faces (P1-S02).
// test/executor-admission.test.ts and test/request-admission.test.ts pin the
// Promise contract unchanged; this suite pins what only the Effect side can
// reach — a scope-owned lease, interruption of a queued wait — and the timer
// hygiene of the Effect-backed queue and deadline.

import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionController,
  ExecutorAdmissionError,
} from "../src/executor-admission.js";
import { acquireScoped, admit } from "../src/runtime/admission.js";
import { microtaskScheduler, runEdge } from "../src/runtime/run.js";
import { withDeadline } from "../src/timeout.js";

function controller(concurrency = 1, maxQueueSize = 2, queueTimeoutMs = 1_000) {
  return new AdmissionController({ concurrency, maxQueueSize, queueTimeoutMs });
}

async function drainMicrotasks(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("admit", () => {
  it("shares acquire()'s bookkeeping and error objects", async () => {
    const admission = controller(1, 0);
    const lease = await runEdge(admit(admission));
    expect(admission.activeCount).toBe(1);
    const refused = await runEdge(admit(admission)).catch((error) => error);
    expect(refused).toBeInstanceOf(ExecutorAdmissionError);
    expect(refused).toMatchObject({ code: "executor_overloaded", message: "Executor queue is full." });
    lease.release();
    expect(admission.snapshot().totals).toMatchObject({ admitted: 1, rejected: 1 });
  });
});

describe("acquireScoped", () => {
  it("releases the lease when its scope closes", async () => {
    const admission = controller();
    const seen = await runEdge(
      Effect.scoped(
        acquireScoped(admission).pipe(
          Effect.map((lease) => ({ waitMs: lease.waitMs, active: admission.activeCount })),
        ),
      ),
    );
    expect(seen).toEqual({ waitMs: 0, active: 1 });
    expect(admission.activeCount).toBe(0);
  });

  it("releases on failure after admission, too", async () => {
    const admission = controller();
    const boom = new Error("work failed");
    await expect(
      runEdge(Effect.scoped(acquireScoped(admission).pipe(Effect.andThen(Effect.fail(boom))))),
    ).rejects.toBe(boom);
    expect(admission.activeCount).toBe(0);
  });

  it("withdraws a queued wait when its fiber is interrupted, without taking a slot", async () => {
    const admission = controller();
    const held = await admission.acquire();
    const scope = Scope.makeUnsafe();
    // runEdge offers no handle to interrupt with, so fork directly — on the
    // scheduler runEdge uses, so the fiber moves without a timer tick.
    const waiting = Effect.runFork(
      acquireScoped(admission).pipe(Scope.provide(scope)),
      { scheduler: microtaskScheduler },
    );
    await drainMicrotasks();
    expect(admission.queuedCount).toBe(1);

    await Effect.runPromise(Fiber.interrupt(waiting));
    expect(admission.queuedCount).toBe(0);
    expect(admission.snapshot().totals).toMatchObject({ queued: 1, cancelled: 1 });

    held.release();
    expect(admission.activeCount).toBe(0);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("the Effect-backed queue under fake timers", () => {
  it("times out on the faked clock and leaves no timer behind a grant", async () => {
    vi.useFakeTimers();
    const admission = controller(1, 2, 25);
    const held = await admission.acquire();
    const expiring = admission.acquire();
    const rejected = expect(expiring).rejects.toMatchObject({
      code: "executor_overloaded",
      message: "Executor admission timed out after 25ms.",
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    const granted = admission.acquire({ signal: new AbortController().signal });
    expect(vi.getTimerCount()).toBe(1);
    held.release();
    (await granted).release();
    expect(vi.getTimerCount()).toBe(0);
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 2, queued: 2, rejected: 1 },
    });
  });

  it("an abort that loses to a grant in the same tick still yields the lease", async () => {
    const admission = controller();
    const held = await admission.acquire();
    const caller = new AbortController();
    const waiting = admission.acquire({ signal: caller.signal });
    held.release();
    caller.abort();
    const lease = await waiting;
    expect(admission.activeCount).toBe(1);
    lease.release();
    expect(admission.snapshot().totals.cancelled).toBe(0);
  });
});

describe("withDeadline", () => {
  it("rejects with the labelled timeout error and aborts the operation", async () => {
    vi.useFakeTimers();
    const timeoutError = new Error("probe timed out");
    let seen: unknown;
    const running = withDeadline(
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", () => {
            seen = signal.reason;
          });
        }),
      { timeoutMs: 100, timeoutError },
    );
    const rejected = expect(running).rejects.toBe(timeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(seen).toBe(timeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the caller's abort reason", async () => {
    const caller = new AbortController();
    const reason = new Error("caller left");
    const running = withDeadline(() => new Promise<never>(() => {}), {
      timeoutMs: 10_000,
      signal: caller.signal,
      timeoutError: new Error("unused"),
    });
    await drainMicrotasks();
    caller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });

  it("passes a synchronous throw and a rejection through untouched", async () => {
    const thrown = new TypeError("sync");
    await expect(
      withDeadline(() => {
        throw thrown;
      }, { timeoutError: new Error("unused") }),
    ).rejects.toBe(thrown);
    const rejectedWith = { not: "an Error" };
    await expect(
      withDeadline(() => Promise.reject(rejectedWith), { timeoutError: new Error("unused") }),
    ).rejects.toBe(rejectedWith);
  });

  it("resolves with the operation's value and aborts its signal afterwards", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      withDeadline(async (s) => {
        signal = s;
        return 7;
      }, { timeoutMs: 1_000, timeoutError: new Error("unused") }),
    ).resolves.toBe(7);
    expect(signal?.aborted).toBe(true);
  });
});
