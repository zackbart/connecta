// Node-only: verifies Node QuickJS child-process deadlines, cancellation, and shutdown.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import type { Connector, ExecuteResult, ExecutorProvider } from "../src/types.js";
import { deferred } from "./fixtures/misc.js";
import { connectorWith } from "./fixtures/connectors.js";
import { trackedQuickJs as quickJsExecutor } from "./fixtures/node.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";

// Real child startup and IPC need generous hang guards on a loaded host.
// Each deadline case still asserts the executor's own configured budget.
vi.setConfig({ testTimeout: 20_000 });

/**
 * What ended a run its wall deadline cut short. The child reports its own
 * expiry as a structural `timed out` result; when a loaded host delays that
 * report past the parent's fixed grace, the parent terminates the child at its
 * wall budget and the run rejects instead. Both are the deadline. The child's
 * own report is pinned race-free, in-process, in quickjs-executor-limits.
 */
function deadlineOutcome(run: Promise<ExecuteResult>): Promise<string | undefined> {
  return run.then(
    (out) => out.error,
    (error: Error) => error.message,
  );
}

describe("quickJsExecutor", () => {
  it("times out when a host call hangs", async () => {
    const hang: ExecutorProvider[] = [{ name: "slow", fns: { forever: () => new Promise(() => {}) } }];
    // A budget the healthy follow-up below can meet on a loaded host; 300ms
    // was not always enough for it.
    const ex = quickJsExecutor({ timeoutMs: 1_000 });
    expect(await deadlineOutcome(ex.execute(`async () => slow.forever({})`, hang))).toMatch(/timed out|wall budget/);
    // The deadline ends the run, the parent retires the child, and the
    // replacement slot keeps serving.
    await expect(ex.execute("async () => 3", [])).resolves.toEqual({
      result: 3,
    });
  }, 10_000);

  // The process boots tsx and a QuickJS child, which takes seconds on a loaded
  // host, so time-to-exit is no signal on its own. What the case pins is that
  // nothing outlives the computation: a leaked wall-deadline timer would hold
  // the process for the full EXECUTOR_WALL_MS, and a still-referenced child
  // forever. The spawn budget sits far below the first and far above startup.
  // The guest CPU budget is generous for the same reason as the fixture's.
  const EXECUTOR_WALL_MS = 300_000;
  const SPAWN_BUDGET_MS = 30_000;
  it(
    "lets a short-lived process exit near computation time",
    () => {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          [
            'import { quickJsExecutor } from "./src/executors/quickjs.ts";',
            `const ex = quickJsExecutor({ timeoutMs: ${EXECUTOR_WALL_MS}, cpuTimeMs: 5_000 });`,
            'const providers = [{ name: "fast", fns: { one: async () => 1 } }];',
            'const out = await ex.execute("async () => { for (let i = 0; i < 20; i += 1) await fast.one(); return 20; }", providers);',
            "if (out.result !== 20) { console.error(JSON.stringify(out)); process.exitCode = 1; }",
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: SPAWN_BUDGET_MS,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    },
    2 * SPAWN_BUDGET_MS,
  );

  it(
    "drains pending host calls after a timeout without spinning [INV-7]",
    () => {
      // Drive the runtime directly, without the pool terminating its child and
      // settling both calls together. The fixture releases one call, yields a
      // real event-loop turn, then releases the other and checks disposal.
      // A missing re-arm spins microtasks and blocks timers in that process;
      // spawnSync's external watchdog can still kill it. Its budget allows tsx
      // and WASM startup under load, matching the exit guard above.
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./fixtures/quickjs-drain.ts", import.meta.url))],
        { cwd: process.cwd(), encoding: "utf8", timeout: SPAWN_BUDGET_MS },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("drain completed after separate releases");
    },
    2 * SPAWN_BUDGET_MS,
  );

  it("recycles a running child when the execute watchdog abandons it", async () => {
    // The ceiling is set below this pool's own deadline only to make the
    // abandonment observable: releasing the lease must kill the child rather
    // than hand its slot to the next run with the old program still inside.
    const ex = quickJsExecutor({ cpuTimeMs: 5_000, timeoutMs: 10_000 });
    const started = performance.now();
    const out = await createExecuteTool(
      makeRegistry([calcConnector]),
      "https://connecta.test",
      ex,
      silentLogger,
      undefined,
      { watchdogMs: 300 },
    )({ code: `async () => { while (true) {} }`, diagnostics: true });
    expect(performance.now() - started).toBeLessThan(3_000);
    const payload = JSON.parse(required(out.content[0]).text) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("timeout");
    expect(payload.error.message).toContain("unresponsive");
    expect(ex.admissionSnapshot?.().active).toBe(0);
    await expect(ex.execute("async () => 9", [])).resolves.toEqual({
      result: 9,
    });
  }, 10_000);

  it("reports emitted blocks discarded by mid-run shutdown", async () => {
    const { promise: started, resolve: callStarted } = deferred<void>();
    const connector: Connector = {
      id: "blocking",
      kind: "api",
      async listTools() {
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool(_name, _args, context) {
        callStarted();
        return new Promise((_, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("call aborted")), { once: true });
        });
      },
    };
    const executor = quickJsExecutor({ timeoutMs: 10_000 });
    const handler = createExecuteTool(makeRegistry([connector]), "https://connecta.test", executor, silentLogger);
    const running = handler({
      code: `async () => {
        await connecta.emit({ type: "text", text: "doomed" });
        return connecta.call("blocking.read", {}).then(({ data }) => data);
      }`,
    });
    await started;
    await executor.close?.();
    const out = await running;
    expect(out.isError).toBe(true);
    expect(out._meta).toBeUndefined();
    const expected = {
      error: {
        code: "executor_closed",
        message: "Executor is shutting down.",
        retryable: false,
      },
      emittedDiscarded: 1,
      hostCalls: { attempted: 1, admitted: 1, succeeded: 0, failed: 1 },
    };
    expect(JSON.parse(required(out.content[0]).text ?? "")).toEqual(expected);
    expect(out.structuredContent).toEqual(expected);
  });
});

it("preserves console logs when a running program is cancelled", async () => {
  const controller = new AbortController();
  const connector = connectorWith({
    id: "cancel",
    kind: "api",
    tools: [{ name: "read", annotations: { readOnlyHint: true } }],
    call: async () => {
      // The ordered host-call IPC message is proof that both logs arrived.
      controller.abort();
      return null;
    },
  });
  const executor = quickJsExecutor();
  const out = await createExecuteTool(
    makeRegistry([connector]),
    "https://connecta.test",
    executor,
    silentLogger,
  )(
    {
      code: `async () => {
    console.log("before cancellation");
    console.warn("still here");
    await connecta.call("cancel.read").then(({ data }) => data);
  }`,
      diagnostics: true,
    },
    { signal: controller.signal },
  );
  expect(out.isError).toBe(true);
  expect(out.structuredContent).toMatchObject({
    error: { code: "executor_cancelled" },
    logs: "before cancellation\nstill here",
  });
});
