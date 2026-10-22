// Node-only: exercises QuickJS WASM budgets and Node child-process IPC bounds.
import { QuickJSContext } from "quickjs-emscripten";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { executeQuickJs, prepareQuickJs } from "../src/executors/quickjs-runtime.js";
import { quickJsExecutor as untrackedQuickJs } from "../src/executors/quickjs.js";
import { deferred } from "./fixtures/misc.js";
import { trackedQuickJs as quickJsExecutor } from "./fixtures/node.js";

// Real child startup and IPC need generous hang guards on a loaded host.
// Each deadline case still asserts the executor's own configured budget.
vi.setConfig({ testTimeout: 20_000 });

describe("quickJsExecutor", () => {
  it.each(["cpu", "wall"] as const)(
    "INV-7: checks %s interruption before inspecting a rejected handle",
    async (budget) => {
      await prepareQuickJs();
      const dump = vi.spyOn(QuickJSContext.prototype, "dump");
      try {
        const out = await executeQuickJs(`async () => { await Promise.resolve(); while (true) {} }`, [], {
          timeoutMs: budget === "wall" ? 25 : 5000,
          cpuTimeMs: budget === "cpu" ? 25 : 5000,
          memoryLimitBytes: 64 * 1024 * 1024,
          maxStackSizeBytes: 1024 * 1024,
        });
        expect(out.error).toBe(
          budget === "wall" ? "Execution timed out after 25ms." : "Execution exceeded the 25ms guest CPU budget.",
        );
        expect(out.timedOut).toBe(budget === "wall" ? true : undefined);
        expect(dump).not.toHaveBeenCalled();
      } finally {
        dump.mockRestore();
      }
    },
  );

  it("maps a runaway synchronous loop to the guest CPU budget", async () => {
    // Wall budget far above the 250ms CPU default: a slow CI tick past a tight
    // wall deadline would otherwise let wallInterrupted win the race. The
    // untracked constructor, because this case pins the production default
    // the tracked fixture raises.
    const ex = untrackedQuickJs({ timeoutMs: 5_000 });
    onTestFinished(() => ex.close?.());
    const out = await ex.execute(`async () => { while (true) {} }`, []);
    expect(out.result).toBeUndefined();
    expect(out.error).toBe("Execution exceeded the 250ms guest CPU budget.");
  }, 10_000);

  it("rejects an allocation that exceeds the guest heap limit", async () => {
    // Tight 4 MiB cap with a generous time budget: the failure must be the
    // memory ceiling, not the deadline. A growing allocation blows the cap,
    // bounded so the outcome owes nothing to time: a million-element array is
    // several times the cap and well within what the runtime holds without
    // one, so only an enforced cap fails it. Twenty doublings get there; the
    // tens of thousands of GC-bound pushes this once took outran the budget
    // on a loaded host.
    const ex = quickJsExecutor({
      memoryLimitBytes: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      cpuTimeMs: 5_000,
    });
    const out = await ex.execute(
      `async () => {
        let a = [0];
        for (let i = 0; i < 20; i++) a = a.concat(a);
        return a.length;
      }`,
      [],
    );
    expect(out.result).toBeUndefined();
    expect(out.error).toBeTruthy();
    // The heap cap trips, not the wall-clock deadline.
    expect(out.error).not.toContain("timed out");
    expect(out.error).toMatch(/memory/i);
    // Whether QuickJS returned a memory error or aborted the child, the slot is
    // replaceable and the serving process remains usable.
    await expect(ex.execute("async () => 7", [])).resolves.toEqual({
      result: 7,
    });
  }, 15_000);

  it("reports a hung host wait as a structural timeout inside the runtime", async () => {
    // The child's half of the deadline, with no parent racing it and on a fake
    // clock: at its own wall expiry during a host wait, and not before, the
    // runtime returns a result naming it.
    await prepareQuickJs();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { promise: waiting, resolve: called } = deferred<void>();
    let settled = false;
    const pending = executeQuickJs(
      `async () => slow.forever({})`,
      [
        {
          name: "slow",
          fns: {
            forever: () => {
              called();
              return new Promise(() => {});
            },
          },
        },
      ],
      {
        timeoutMs: 50,
        cpuTimeMs: 5_000,
        memoryLimitBytes: 64 * 1024 * 1024,
        maxStackSizeBytes: 1024 * 1024,
      },
    ).finally(() => {
      settled = true;
    });
    await waiting;
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({
      error: "Execution timed out after 50ms.",
    });
  });

  it("does not charge host-tool waits to the short guest CPU budget", async () => {
    const ex = quickJsExecutor({ cpuTimeMs: 250, timeoutMs: 2_000 });
    const out = await ex.execute(`async () => slow.read()`, [
      {
        name: "slow",
        fns: {
          read: () => new Promise((resolve) => setTimeout(() => resolve("done"), 600)),
        },
      },
    ]);
    expect(out).toEqual({ result: "done" });
  });

  it("INV-7: transports the complete guest result in bounded IPC chunks", async () => {
    const ex = quickJsExecutor({
      memoryLimitBytes: 16 * 1024 * 1024,
      cpuTimeMs: 1_000,
    });
    const out = await ex.execute(`async () => "x".repeat(5 * 1024 * 1024)`, []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe("x".repeat(5 * 1024 * 1024));
  });

  it("bounds guest-to-host call arguments before IPC", async () => {
    const ex = quickJsExecutor({ memoryLimitBytes: 16 * 1024 * 1024 });
    const out = await ex.execute(
      `async () => {
        try { return await echo.read("x".repeat(2 * 1024 * 1024)); }
        catch (e) { return e.message; }
      }`,
      [{ name: "echo", fns: { read: async (value) => value } }],
    );
    expect(out.result).toContain("IPC limit");
  });

  it("bounds guest-controlled function names before parent IPC", async () => {
    const ex = quickJsExecutor({ memoryLimitBytes: 16 * 1024 * 1024 });
    const out = await ex.execute(
      `async () => {
        try { return await echo["x".repeat(2 * 1024 * 1024)](); }
        catch (e) { return e.message; }
      }`,
      [{ name: "echo", fns: { read: async () => "ok" } }],
    );
    expect(out.result).toContain("IPC limit");
  });
});
