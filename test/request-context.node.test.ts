// Node-only: AsyncLocalStorage shows which request's async context a queued
// continuation or a QuickJS host call runs in (#1106).
//
// Shared admission queues are handed a waiter's permit from inside whichever
// request released one. On Workers, resuming the waiter there throws; Node
// throws nothing, so these suites pin the same rule through the async
// context each continuation observes and the order it runs in.
import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ConnectorCallAdmissionController } from "../src/call-admission.js";
import { AdmissionController } from "../src/executor-admission.js";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { admit } from "../src/runtime/admission.js";
import { startCallAdmission } from "../src/runtime/call-admission.js";
import { runEdge } from "../src/runtime/run.js";
import { Settlement } from "../src/runtime/settlement.js";

const request = new AsyncLocalStorage<string>();

/** Run `effect` as request `name` would, recording where it resumes. */
function waitIn<A>(name: string, effect: Effect.Effect<A, unknown>, events: string[]): Promise<A> {
  return request.run(name, () =>
    runEdge(
      effect.pipe(
        Effect.tap(() => Effect.sync(() => events.push(`${name} resumed in ${request.getStore()}`))),
        Effect.tapError(() => Effect.sync(() => events.push(`${name} refused in ${request.getStore()}`))),
      ),
    ),
  );
}

describe("a Settlement", () => {
  it("INV-7: wakes each waiter after the settling call returns, in the waiter's own context", async () => {
    const settlement = new Settlement<string>();
    const events: string[] = [];
    const bob = waitIn("bob", settlement.wait(), events);
    const carol = waitIn("carol", settlement.wait(), events);
    request.run("alice", () => {
      expect(settlement.settle(Exit.succeed("granted"))).toBe(true);
      expect(settlement.settle(Exit.succeed("again"))).toBe(false);
      events.push("alice settled");
    });
    expect(await bob).toBe("granted");
    expect(await carol).toBe("granted");
    expect(events).toEqual(["alice settled", "bob resumed in bob", "carol resumed in carol"]);
    // A late waiter reads the recorded outcome at once.
    expect(await runEdge(settlement.wait())).toBe("granted");
  });

  it("INV-7: forgets a waiter that left before the outcome arrived", async () => {
    const settlement = new Settlement<string, Error>();
    const controller = new AbortController();
    const left = runEdge(settlement.wait(), { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort("left");
    expect(await left).toBe("left");
    settlement.settle(Exit.fail(new Error("too late")));
    expect(settlement.outcome).toMatchObject({ _tag: "Failure" });
  });
});

describe("shared admission queues hand a permit across requests", () => {
  it("INV-7: a queued execution resumes in its own request after the releasing call returns", async () => {
    const admission = new AdmissionController({ concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 1_000 });
    const events: string[] = [];
    const held = await request.run("alice", () => runEdge(admit(admission)));
    const bob = waitIn("bob", admit(admission), events);
    expect(admission.queuedCount).toBe(1);
    request.run("alice", () => {
      held.release();
      events.push("alice released");
    });
    const lease = await bob;
    expect(events).toEqual(["alice released", "bob resumed in bob"]);
    // Shutdown refuses the next waiter in its own request too.
    const carol = waitIn("carol", admit(admission), events).catch((error: unknown) => error);
    request.run("alice", () => {
      admission.close();
      events.push("alice closed");
    });
    expect(await carol).toMatchObject({ code: "executor_closed" });
    expect(events.slice(2)).toEqual(["alice closed", "carol refused in carol"]);
    lease.release();
    expect(admission.activeCount).toBe(0);
  });

  it("INV-7: a waiter pruned by another request's admission is refused in its own request", async () => {
    // Only Date moves, so alice's prune decides before bob's own queue timer.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const admission = new AdmissionController({ concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 1_000 });
      const events: string[] = [];
      const held = await request.run("alice", () => runEdge(admit(admission)));
      const bob = waitIn("bob", admit(admission), events).catch((error: unknown) => error);
      vi.setSystemTime(Date.now() + 1_000);
      request.run("alice", () => {
        admission.snapshot();
        events.push("alice pruned");
      });
      expect(await bob).toMatchObject({ code: "executor_overloaded", retryable: true });
      expect(events).toEqual(["alice pruned", "bob refused in bob"]);
      held.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("INV-7: a queued connector call resumes in its own request after the releasing call returns", async () => {
    const admission = new ConnectorCallAdmissionController("limited", { rules: [{ maxConcurrency: 1 }] });
    const events: string[] = [];
    const held = await request.run("alice", () =>
      runEdge(startCallAdmission(admission, { toolName: "read", args: {} })),
    );
    const bob = waitIn("bob", startCallAdmission(admission, { toolName: "read", args: {} }), events);
    request.run("alice", () => {
      held.release();
      events.push("alice released");
    });
    (await bob).release();
    expect(events).toEqual(["alice released", "bob resumed in bob"]);
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});

describe("a permit granted before its waiter hears of it", () => {
  // The grant is recorded in the releasing request and heard a turn later.
  // A shutdown in that gap must win. (A grant that beats the waiter's abort
  // stays the waiter's: test/cancellation-faults.test.ts.)
  it("INV-7: is given back when execution admission closes first", async () => {
    const admission = new AdmissionController({ concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1_000 });
    const held = await runEdge(admit(admission));
    const bob = runEdge(admit(admission)).catch((error: unknown) => error);
    held.release();
    admission.close();
    expect(await bob).toMatchObject({ code: "executor_closed", retryable: false });
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, totals: { admitted: 2, closed: 1 } });
  });

  it("INV-7: is given back when connector call admission closes first", async () => {
    const admission = new ConnectorCallAdmissionController("limited", { rules: [{ maxConcurrency: 1 }] });
    const call = () => runEdge(startCallAdmission(admission, { toolName: "read", args: {} }));
    const held = await call();
    const bob = call().catch((error: unknown) => error);
    held.release();
    admission.close();
    expect(await bob).toMatchObject({ admissionKind: "closed", code: "unavailable" });
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("INV-7: never becomes a QuickJS lease after the executor closes", async () => {
    const executor = quickJsExecutor({ concurrency: 1 });
    const held = await executor.acquire();
    const queued = executor.acquire().catch((error: unknown) => error);
    held.release();
    await executor.close?.();
    expect(await queued).toMatchObject({ code: "executor_closed" });
    expect(executor.admissionSnapshot?.()).toMatchObject({ active: 0, queued: 0, closed: true });
  });
});

describe("QuickJS host calls", () => {
  it("INV-7: run in the context of the request that runs the program, not the one that spawned its child", async () => {
    const executor = quickJsExecutor({ concurrency: 1 });
    const seen: string[] = [];
    const host = (name: string) => [
      {
        name: "host",
        fns: {
          read: async () => {
            seen.push(`${name} called in ${request.getStore()}`);
            return name;
          },
        },
      },
    ];
    try {
      // Alice's request spawns the warm child that serves every later run.
      expect(
        await request.run("alice", () => executor.execute("async () => host.read()", host("alice"))),
      ).toMatchObject({ result: "alice" });
      expect(await request.run("bob", () => executor.execute("async () => host.read()", host("bob")))).toMatchObject({
        result: "bob",
      });
      // Dave queues behind Carol and is handed her slot.
      const [carol, dave] = await Promise.all([
        request.run("carol", () =>
          executor.execute("async () => { await host.read(); return host.read(); }", host("carol")),
        ),
        request.run("dave", () => executor.execute("async () => host.read()", host("dave"))),
      ]);
      expect([carol.result, dave.result]).toEqual(["carol", "dave"]);
      expect(seen).toEqual([
        "alice called in alice",
        "bob called in bob",
        "carol called in carol",
        "carol called in carol",
        "dave called in dave",
      ]);
    } finally {
      await executor.close?.();
    }
  }, 60_000);
});
