// Call admission, settled fan-out, and connector scope close run on Effect
// behind their Promise faces (P1-S04). test/call-admission.test.ts and the
// registry, search, and remote-mcp suites pin the Promise contract unchanged;
// this suite pins what only the Effect side can reach — a scope-owned permit,
// interruption of a queued wait, a rolling window on the fiber's Clock, a
// scope finalizer — and the timer hygiene of the Effect-backed waits.

import { Clock, Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallAdmissionError,
  ConnectorCallAdmissionController,
} from "../src/call-admission.js";
import { mapSettledWithConcurrency } from "../src/concurrency.js";
import { closeConnectorScope } from "../src/connector-scope.js";
import {
  acquireCallScoped,
  admitCall,
} from "../src/runtime/call-admission.js";
import { closeScopeOnExit } from "../src/runtime/connector-scope.js";
import { microtaskScheduler, runEdge } from "../src/runtime/run.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";

const input = { toolName: "read", args: {} };

function limited(maxQueueSize = 2, queueTimeoutMs = 1_000) {
  return new ConnectorCallAdmissionController("limited", {
    rules: [{ maxConcurrency: 1, maxQueueSize, queueTimeoutMs }],
  });
}

async function drainMicrotasks(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/** A clock pinned to `at.ms`, for the rolling window; sleeps stay live. */
async function pinnedClock(at: { ms: number }): Promise<Clock.Clock> {
  const live = await runEdge(Clock.clockWith((clock) => Effect.succeed(clock)));
  return {
    currentTimeMillisUnsafe: () => at.ms,
    currentTimeMillis: Effect.sync(() => at.ms),
    currentTimeNanosUnsafe: () => BigInt(at.ms) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(at.ms) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("admitCall", () => {
  it("shares acquire()'s bookkeeping and error objects", async () => {
    const admission = limited(0);
    const permit = await runEdge(admitCall(admission, input));
    const refused = await runEdge(admitCall(admission, input)).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CallAdmissionError);
    expect(refused).toMatchObject({
      admissionKind: "concurrency",
      code: "rate_limited",
      message: 'Connector "limited" call concurrency queue is full.',
    });
    permit.release();
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      totals: { admitted: 1, rejected: 1 },
    });
  });

  it("decides when it runs, not when it is built, and again on every run", async () => {
    const admission = limited();
    const admitOne = admitCall(admission, input);
    expect(admission.snapshot().totals.admitted).toBe(0);
    (await runEdge(admitOne)).release();
    (await runEdge(admitOne)).release();
    expect(admission.snapshot().totals.admitted).toBe(2);
  });

  it("keeps the rolling window on the fiber's Clock", async () => {
    const at = { ms: 50_000 };
    const clock = await pinnedClock(at);
    const admission = new ConnectorCallAdmissionController("budgeted", {
      rules: [{ budget: { kind: "rolling-window", maxCalls: 1, windowMs: 1_000 } }],
    });
    const onClock = admitCall(admission, input).pipe(
      Effect.provideService(Clock.Clock, clock),
    );
    (await runEdge(onClock)).release();
    at.ms = 50_400;
    await expect(runEdge(onClock)).rejects.toMatchObject({
      admissionKind: "budget",
      retryAfterMs: 600,
    });
    at.ms = 51_000;
    (await runEdge(onClock)).release();
    expect(admission.snapshot().totals).toMatchObject({
      admitted: 2,
      rateLimited: 1,
    });
  });
});

describe("acquireCallScoped", () => {
  it("releases the permit when its scope closes, on failure too", async () => {
    const admission = limited();
    const seen = await runEdge(
      Effect.scoped(
        acquireCallScoped(admission, input).pipe(
          Effect.map(() => admission.snapshot().active),
        ),
      ),
    );
    expect(seen).toBe(1);
    expect(admission.snapshot().active).toBe(0);

    const boom = new Error("call failed");
    await expect(
      runEdge(
        Effect.scoped(
          acquireCallScoped(admission, input).pipe(Effect.andThen(Effect.fail(boom))),
        ),
      ),
    ).rejects.toBe(boom);
    expect(admission.snapshot().active).toBe(0);
    expect(admission.isIdle()).toBe(true);
  });

  it("withdraws a queued wait when its fiber is interrupted, without taking a slot", async () => {
    const admission = limited();
    const held = await admission.acquire(input);
    const scope = Scope.makeUnsafe();
    // runEdge offers no handle to interrupt with, so fork directly — on the
    // scheduler runEdge uses, so the fiber moves without a timer tick.
    const waiting = Effect.runFork(
      acquireCallScoped(admission, input).pipe(Scope.provide(scope)),
      { scheduler: microtaskScheduler },
    );
    await drainMicrotasks();
    expect(admission.snapshot().queued).toBe(1);

    await Effect.runPromise(Fiber.interrupt(waiting));
    expect(admission.snapshot()).toMatchObject({
      queued: 0,
      totals: { queued: 1, cancelled: 1, admitted: 1 },
    });

    held.release();
    expect(admission.snapshot().active).toBe(0);
    expect(admission.isIdle()).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("the Effect-backed call queue", () => {
  it("times out on the faked clock and leaves no timer behind a grant", async () => {
    vi.useFakeTimers();
    const admission = limited(2, 25);
    const held = await admission.acquire(input);
    const rejected = expect(admission.acquire(input)).rejects.toMatchObject({
      admissionKind: "concurrency",
      message: 'Connector "limited" call concurrency queue wait exceeded 25ms.',
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    const granted = admission.acquire({
      ...input,
      signal: new AbortController().signal,
    });
    expect(vi.getTimerCount()).toBe(1);
    held.release();
    const permit = await granted;
    expect(permit.waitMs).toBe(0);
    permit.release();
    expect(vi.getTimerCount()).toBe(0);
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 2, queued: 2, rejected: 1 },
    });
    expect(admission.isIdle()).toBe(true);
  });

  it("an abort that lands before the grant is delivered still cancels", async () => {
    const admission = limited();
    const held = await admission.acquire(input);
    const caller = new AbortController();
    const waiting = admission.acquire({ ...input, signal: caller.signal });
    caller.abort(new Error("caller left"));
    held.release();
    await expect(waiting).rejects.toMatchObject({ admissionKind: "cancelled" });
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      totals: { admitted: 1, cancelled: 1 },
    });
  });

  it("a grant that lands before the abort keeps the permit", async () => {
    const admission = limited();
    const held = await admission.acquire(input);
    const caller = new AbortController();
    const waiting = admission.acquire({ ...input, signal: caller.signal });
    held.release();
    caller.abort();
    const permit = await waiting;
    expect(admission.snapshot().active).toBe(1);
    permit.release();
    expect(admission.snapshot().totals.cancelled).toBe(0);
  });
});

describe("mapSettledWithConcurrency", () => {
  it("bounds work in flight and keeps input order whatever order work finishes in", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases = new Map<number, () => void>();
    const running = mapSettledWithConcurrency([0, 1, 2, 3, 4], 2, (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<number>((resolve, reject) => {
        releases.set(item, () => {
          inFlight--;
          if (item === 3) reject(new Error(`item ${item}`));
          else resolve(item * 10);
        });
      });
    });
    // The first `limit` calls start before the call returns, as they did.
    expect([...releases.keys()]).toEqual([0, 1]);
    for (const next of [1, 0, 3, 2, 4]) {
      while (!releases.has(next)) await Promise.resolve();
      releases.get(next)!();
    }
    const settled = await running;
    expect(peak).toBe(2);
    expect(settled.map((result) =>
      result.status === "fulfilled" ? result.value : (result.reason as Error).message,
    )).toEqual([0, 10, 20, "item 3", 40]);
  });

  it("settles a synchronous throw in place and passes rejections through untouched", async () => {
    const thrown = new TypeError("sync");
    const rejectedWith = { not: "an Error" };
    const settled = await mapSettledWithConcurrency([0, 1, 2], 3, (item) => {
      if (item === 0) throw thrown;
      if (item === 1) return Promise.reject(rejectedWith);
      return Promise.resolve("ok");
    });
    expect(settled).toEqual([
      { status: "rejected", reason: thrown },
      { status: "rejected", reason: rejectedWith },
      { status: "fulfilled", value: "ok" },
    ]);
    expect(settled[0]!.status === "rejected" && settled[0]!.reason).toBe(thrown);
  });

  it("returns an empty list for no items", async () => {
    await expect(mapSettledWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});

function closingConnector(closeScope: Connector["closeScope"]): Connector {
  return connectorWith({
    id: "scoped",
    kind: "api",
    description: "Scoped",
    ...(closeScope ? { closeScope } : {}),
  });
}

const ctx = {} as ConnectorContext;

describe("closeConnectorScope", () => {
  it("waits at most 100ms, hands a 2s tail to defer, and leaves no timer once the close settles", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const deferred: Array<Promise<unknown>> = [];
    let returned = false;
    const closing = closeConnectorScope(
      closingConnector(() => new Promise<void>((resolve) => { finish = resolve; })),
      ctx,
      (promise) => deferred.push(promise),
    ).then(() => { returned = true; });
    expect(deferred).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(returned).toBe(true);

    finish();
    await deferred[0];
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the deferred tail of a close that never settles", async () => {
    vi.useFakeTimers();
    const deferred: Array<Promise<unknown>> = [];
    const closing = closeConnectorScope(
      closingConnector(() => new Promise<void>(() => {})),
      ctx,
      (promise) => deferred.push(promise),
    );
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    let tailDone = false;
    void deferred[0]!.then(() => { tailDone = true; });
    await vi.advanceTimersByTimeAsync(1_899);
    expect(tailDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(tailDone).toBe(true);
  });

  it("swallows a throwing hook, a rejecting hook, and a throwing defer", async () => {
    await expect(
      closeConnectorScope(closingConnector(() => { throw new Error("sync"); }), ctx),
    ).resolves.toBeUndefined();
    await expect(
      closeConnectorScope(
        closingConnector(() => Promise.reject(new Error("async"))),
        ctx,
        () => { throw new Error("defer"); },
      ),
    ).resolves.toBeUndefined();
    await expect(
      closeConnectorScope(closingConnector(undefined), ctx),
    ).resolves.toBeUndefined();
  });
});

describe("closeScopeOnExit", () => {
  it("closes the connector scope when the Effect scope closes, however it ends", async () => {
    const closed: string[] = [];
    const connector = closingConnector(async () => { closed.push("closed"); });
    await runEdge(Effect.scoped(closeScopeOnExit(connector, ctx)));
    expect(closed).toEqual(["closed"]);

    const boom = new Error("probe failed");
    await expect(
      runEdge(
        Effect.scoped(closeScopeOnExit(connector, ctx).pipe(Effect.andThen(Effect.fail(boom)))),
      ),
    ).rejects.toBe(boom);
    expect(closed).toEqual(["closed", "closed"]);
  });
});
