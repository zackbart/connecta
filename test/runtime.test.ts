// The Promise edge of the Effect core (src/runtime/run.ts). Every later step
// of the Effect conversion leans on three promises this file keeps: a caller's
// abort reason survives interruption, connecta's own error objects come back
// out unwrapped, and fibers keep moving under vitest's fake timers.

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detach,
  fromSignal,
  microtaskScheduler,
  runEdge,
  withDeadlineEffect,
} from "../src/runtime/run.js";

class LabelledError extends Error {
  override readonly name = "LabelledError";
}

/** A fiber that yields to the scheduler `times` times, then succeeds. */
function yieldingWork(times: number): Effect.Effect<number> {
  return Effect.gen(function* () {
    for (let index = 0; index < times; index += 1) yield* Effect.yieldNow;
    return times;
  });
}

/** Let every queued microtask (and the ones they queue) run. */
async function drainMicrotasks(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runEdge", () => {
  it("resolves with the success value", async () => {
    await expect(runEdge(Effect.succeed(42))).resolves.toBe(42);
  });

  it("rejects with the original failure, not a wrapper", async () => {
    const error = new LabelledError("the connector said no");
    const rejection = await runEdge(Effect.fail(error)).catch((e) => e);
    expect(rejection).toBe(error);
    expect(rejection).toBeInstanceOf(LabelledError);
    expect(rejection.name).toBe("LabelledError");
    expect(rejection.message).toBe("the connector said no");
  });

  it("rejects with the original defect, whether died or thrown", async () => {
    const defect = new TypeError("not a function");
    await expect(runEdge(Effect.die(defect))).rejects.toBe(defect);
    await expect(
      runEdge(Effect.sync(() => {
        throw defect;
      })),
    ).rejects.toBe(defect);
    const primitive = { reason: "not even an Error" };
    await expect(runEdge(Effect.die(primitive))).rejects.toBe(primitive);
  });

  it("maps an interrupt to the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = new LabelledError("request closed");
    const running = runEdge(Effect.never, { signal: controller.signal });
    await drainMicrotasks();
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });

  it("maps an interrupt to the reason of an already-aborted signal", async () => {
    const reason = { code: "gone" };
    await expect(
      runEdge(Effect.never, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  it("prefers the abort reason over a failure raised while interrupted", async () => {
    const controller = new AbortController();
    const reason = new LabelledError("caller left");
    const running = runEdge(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.die(new Error("finalizer")))),
      { signal: controller.signal },
    );
    await drainMicrotasks();
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });

  it("falls back to an AbortError for an interrupt without a signal", async () => {
    const rejection = await runEdge(Effect.interrupt).catch((e) => e);
    expect(rejection).toBeInstanceOf(DOMException);
    expect(rejection.name).toBe("AbortError");
  });
});

describe("the microtask scheduler", () => {
  it("is the one edge-run fibers use", () => {
    expect(microtaskScheduler.executionMode).toBe("async");
  });

  it("makes progress under fake timers without advancing them", async () => {
    vi.useFakeTimers();
    // Thousands of yields, and concurrent fibers, all without a single timer
    // tick: nothing here may wait on setImmediate or setTimeout.
    await expect(runEdge(yieldingWork(5_000))).resolves.toBe(5_000);
    await expect(
      runEdge(
        Effect.all([yieldingWork(100), yieldingWork(200), yieldingWork(300)], {
          concurrency: "unbounded",
        }),
      ),
    ).resolves.toEqual([100, 200, 300]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is what makes the difference: the default scheduler stalls under fakes", async () => {
    vi.useFakeTimers();
    // The control case. Effect's default MixedScheduler yields through
    // setImmediate, which vitest fakes, so the same work sits still until a
    // timer is advanced. If this ever starts passing without the advance, the
    // microtask scheduler is no longer buying anything and can be revisited.
    const fiber = Effect.runFork(yieldingWork(5_000));
    await drainMicrotasks();
    expect(fiber.pollUnsafe()).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(fiber.pollUnsafe()).toBeDefined();
  });

  it("still lets Effect.sleep wait on the faked clock", async () => {
    vi.useFakeTimers();
    let done = false;
    const running = runEdge(Effect.sleep(1_000)).then(() => {
      done = true;
    });
    await drainMicrotasks();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    expect(done).toBe(true);
  });
});

describe("fromSignal", () => {
  it("fails with the abort reason once the signal aborts", async () => {
    const controller = new AbortController();
    const reason = new LabelledError("stop");
    const waiting = runEdge(fromSignal(controller.signal));
    await drainMicrotasks();
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it("fails at once for a signal that is already aborted", async () => {
    const reason = new LabelledError("already");
    await expect(runEdge(fromSignal(AbortSignal.abort(reason)))).rejects.toBe(
      reason,
    );
  });

  it("lets the work win a race against a signal that never aborts", async () => {
    const controller = new AbortController();
    await expect(
      runEdge(Effect.raceFirst(Effect.succeed("done"), fromSignal(controller.signal))),
    ).resolves.toBe("done");
  });
});

describe("withDeadlineEffect", () => {
  it("resolves with the operation's value and aborts its signal afterwards", async () => {
    let seen: AbortSignal | undefined;
    const value = await runEdge(
      withDeadlineEffect(
        (signal) => {
          seen = signal;
          return Effect.succeed("ok");
        },
        { timeoutMs: 1_000, timeoutError: new Error("never") },
      ),
    );
    expect(value).toBe("ok");
    expect(seen?.aborted).toBe(true);
  });

  it("aborts the operation's signal with the labelled error before interrupting it", async () => {
    vi.useFakeTimers();
    const timeoutError = new Error("search_tools timed out after 50ms");
    const events: string[] = [];
    const running = runEdge(
      withDeadlineEffect(
        (signal) => {
          signal.addEventListener("abort", () => {
            events.push(`abort:${(signal.reason as Error).message}`);
          });
          return Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                events.push(`interrupt:aborted=${signal.aborted}`);
              }),
            ),
          );
        },
        { timeoutMs: 50, timeoutError },
      ),
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toBe(timeoutError);
    expect(events).toEqual([
      "abort:search_tools timed out after 50ms",
      "interrupt:aborted=true",
    ]);
  });

  it("fails with the caller's abort reason, forwarded to the operation", async () => {
    const caller = new AbortController();
    const reason = new LabelledError("client went away");
    let operationReason: unknown;
    const running = runEdge(
      withDeadlineEffect(
        (signal) =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                operationReason = signal.reason;
              }),
            ),
          ),
        { signal: caller.signal, timeoutMs: 60_000, timeoutError: new Error("late") },
      ),
    );
    await drainMicrotasks();
    caller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(operationReason).toBe(reason);
  });

  it("fails at once when the caller's signal is already aborted", async () => {
    const reason = new LabelledError("before start");
    await expect(
      runEdge(
        withDeadlineEffect(() => Effect.never, {
          signal: AbortSignal.abort(reason),
          timeoutError: new Error("unused"),
        }),
      ),
    ).rejects.toBe(reason);
  });

  it("passes the operation's own failure through untouched", async () => {
    const error = new LabelledError("downstream 500");
    await expect(
      runEdge(
        withDeadlineEffect(() => Effect.fail(error), {
          timeoutMs: 1_000,
          timeoutError: new Error("unused"),
        }),
      ),
    ).rejects.toBe(error);
  });

  it("stops listening to the caller's signal once it settles", async () => {
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    await runEdge(
      withDeadlineEffect(() => Effect.succeed(1), {
        signal: caller.signal,
        timeoutError: new Error("unused"),
      }),
    );
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("detach", () => {
  it("hands the work to waitUntil and runs it to completion", async () => {
    const handed: Array<Promise<unknown>> = [];
    let ran = false;
    detach(
      Effect.sync(() => {
        ran = true;
      }),
      { waitUntil: (promise) => handed.push(promise) },
    );
    expect(handed).toHaveLength(1);
    await handed[0];
    expect(ran).toBe(true);
  });

  it("never rejects, whatever the work does", async () => {
    const handed: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => handed.push(promise) };
    await expect(detach(Effect.fail(new Error("background")), ctx)).resolves.toBeUndefined();
    await expect(detach(Effect.die(new Error("defect")), ctx)).resolves.toBeUndefined();
    await expect(Promise.all(handed)).resolves.toEqual([undefined, undefined]);
  });

  it("still runs the work where there is no waitUntil", async () => {
    let ran = false;
    await detach(
      Effect.sync(() => {
        ran = true;
      }),
    );
    expect(ran).toBe(true);
  });
});
