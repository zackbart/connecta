import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
// The Promise edge of the Effect core (src/runtime/run.ts). Every later step
// of the Effect conversion leans on three promises this file keeps: a caller's
// abort reason survives interruption, connecta's own error objects come back
// out unwrapped, and fibers keep moving under vitest's fake timers.

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detach, runEdge, withDeadlineEffect } from "../src/runtime/run.js";

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
  it("rejects with the original failure, not a wrapper", NODE, async () => {
    const error = new LabelledError("the connector said no");
    const rejection = await runEdge(Effect.fail(error)).catch((e) => e);
    expect(rejection).toBe(error);
    expect(rejection).toBeInstanceOf(LabelledError);
    expect(rejection.name).toBe("LabelledError");
    expect(rejection.message).toBe("the connector said no");
  });

  it("rejects with the original defect, whether died or thrown", NODE, async () => {
    const defect = new TypeError("not a function");
    await expect(runEdge(Effect.die(defect))).rejects.toBe(defect);
    await expect(
      runEdge(
        Effect.sync(() => {
          throw defect;
        }),
      ),
    ).rejects.toBe(defect);
    const primitive = { reason: "not even an Error" };
    await expect(runEdge(Effect.die(primitive))).rejects.toBe(primitive);
  });

  it("maps an interrupt to the caller's abort reason", WORKERS, async () => {
    const controller = new AbortController();
    const reason = new LabelledError("request closed");
    const running = runEdge(Effect.never, { signal: controller.signal });
    await drainMicrotasks();
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
  });
});

describe("the microtask scheduler", () => {
  it("makes progress under fake timers without advancing them", WORKERS, async () => {
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

  it("still lets Effect.sleep wait on the faked clock", WORKERS, async () => {
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

describe("withDeadlineEffect", () => {
  it("aborts the operation's signal with the labelled error before interrupting it", WORKERS, async () => {
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
    expect(events).toEqual(["abort:search_tools timed out after 50ms", "interrupt:aborted=true"]);
  });

  it("fails with the caller's abort reason, forwarded to the operation", WORKERS, async () => {
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

  it("does not start an operation after its caller has already aborted", NODE, async () => {
    const reason = new LabelledError("caller left before dispatch");
    const operation = vi.fn(() => Effect.succeed("dispatched"));
    await expect(
      runEdge(
        withDeadlineEffect(operation, {
          signal: AbortSignal.abort(reason),
          timeoutError: new Error("unused"),
        }),
      ),
    ).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
  });

  it("stops listening to the caller's signal once it settles", WORKERS, async () => {
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
  it("hands the work to waitUntil and runs it to completion", WORKERS, async () => {
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

  it("never rejects, whatever the work does", NODE, async () => {
    const handed: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => handed.push(promise) };
    await expect(detach(Effect.fail(new Error("background")), ctx)).resolves.toBeUndefined();
    await expect(detach(Effect.die(new Error("defect")), ctx)).resolves.toBeUndefined();
    await expect(Promise.all(handed)).resolves.toEqual([undefined, undefined]);
  });
});
