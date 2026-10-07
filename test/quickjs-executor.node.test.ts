// Node-only: runs the Node QuickJS child-process executor.
import { ConnectorCallError } from "../src/errors.js";
import { connectorWith } from "./fixtures/connectors.js";
import { api } from "../src/connectors/api.js";
import { USAGE_SKILL } from "../src/skills.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { createConnecta } from "../src/index.js";
import {
  normalizeCode,
  quickJsExecutor as untrackedQuickJs,
} from "../src/executors/quickjs.js";
import { normalizeProgramSource } from "../src/program-source.js";
import {
  executeQuickJs,
  prepareQuickJs,
} from "../src/executors/quickjs-runtime.js";
import type { Connector, ExecuteResult, ExecutorProvider } from "../src/types.js";
import {
  required,
  calcConnector,
  makeRegistry,
  silentLogger,
} from "./helpers.js";
import { trackedQuickJs as quickJsExecutor } from "./fixtures/node.js";
import { deferred, waitFor } from "./fixtures/misc.js";

// The real-child cases pay for process startup and IPC, which fake clocks
// cannot control. On a loaded host they outran vitest's 5s default with no
// behavior at fault. This file budget is a hang guard. The deadlines a case
// pins are the executor's own, asserted on its outcome.
vi.setConfig({ testTimeout: 20_000 });

/**
 * What ended a run its wall deadline cut short. The child reports its own
 * expiry as a structural `timed out` result; when a loaded host delays that
 * report past the parent's fixed grace, the parent terminates the child at its
 * wall budget and the run rejects instead. Both are the deadline. The child's
 * own report is pinned race-free, in-process, by the runtime case below.
 */
function deadlineOutcome(run: Promise<ExecuteResult>): Promise<string | undefined> {
  return run.then((out) => out.error, (error: Error) => error.message);
}

function providers(): ExecutorProvider[] {
  return [
    {
      name: "calc",
      fns: {
        add: async (args) => {
          const { a, b } = args as { a: number; b: number };
          await new Promise((r) => setTimeout(r, 5)); // real async hop
          return { sum: a + b };
        },
        boom: async () => {
          throw new Error("downstream exploded");
        },
      },
    },
    {
      name: "connecta",
      fns: {
        call: async (address, args) => ({ address, args }),
      },
    },
  ];
}

describe("normalizeCode", () => {
  it("strips markdown fences", () => {
    expect(normalizeCode("```js\nasync () => 1\n```")).toBe("async () => 1");
  });
  it("wraps bare statements in an async arrow", () => {
    expect(normalizeCode("return 1;")).toBe("async () => {\nreturn 1;\n}");
  });
  it("leaves async arrows alone", () => {
    expect(normalizeCode("async () => 1")).toBe("async () => 1");
  });
  it("detects a function past a leading line comment", () => {
    expect(normalizeCode("// grab the roadmap\nasync () => 1")).toBe(
      "// grab the roadmap\nasync () => 1",
    );
  });
  it("drops a trailing terminator after the arrow expression, and nothing else", () => {
    expect(normalizeCode("async () => {\n  return 1;\n}; // done")).toBe(
      "async () => {\n  return 1;\n} // done",
    );
    expect(normalizeCode("```js\nasync () => 1;\n```")).toBe("async () => 1");
    expect(normalizeCode("async () => 1; 2")).toBe("async () => 1; 2");
    expect(normalizeCode("while (poll());")).toBe("async () => {\nwhile (poll());\n}");
  });
  it("runs a program ending with `};` when driven directly", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute("async () => {\n  return 2;\n};", []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(2);
    await ex.close?.();
  });
  it("detects a function past a leading block comment", () => {
    expect(normalizeCode("/* setup */\n(async () => 1)")).toBe(
      "/* setup */\n(async () => 1)",
    );
  });
});

it("forwards positional arguments through recovered named functions", async () => {
  const source = normalizeProgramSource(
    "async function read(value) { return { value, count: arguments.length }; }",
  );
  const program = new Function(`return (${source});`)() as (value: number) => Promise<unknown>;
  await expect(program(42)).resolves.toEqual({ value: 42, count: 1 });
});

describe("quickJsExecutor", () => {
  it("carries a non-enumerable lifecycle brand accepted by createConnecta", async () => {
    const executor = quickJsExecutor();
    expect(Object.getOwnPropertyDescriptor(executor, Symbol.for("connecta.executor")))
      .toMatchObject({ enumerable: false, value: { version: 1, lifecycle: "leased" } });
    const app = createConnecta({ connectors: [], executor, logger: "silent" });
    await app.close();
  });

  it("identifies itself as QuickJS for /health and doctor (#368)", () => {
    expect((quickJsExecutor() as { name?: string }).name).toBe("QuickJS");
  });

  it("runs plain code and returns the value", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute("async () => 1 + 1", []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(2);
  });

  it("bridges tool calls, sequentially and via Promise.all", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        const a = await calc.add({ a: 1, b: 2 });
        const more = await Promise.all([
          calc.add({ a: 10, b: 10 }),
          calc.add({ a: 20, b: 20 }),
        ]);
        return { first: a.sum, sums: more.map((m) => m.sum) };
      }`,
      providers(),
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ first: 3, sums: [20, 40] });
  });

  it.each([
    ["0.125 MiB", 128 * 1024, true],
    ["0.5 MiB", 512 * 1024, false],
    ["1.5 MiB", 1536 * 1024, false],
    ["3.5 MiB", 3584 * 1024, false],
    ["7 MiB", 7 * 1024 * 1024, false],
  ])(
    "bridges or deterministically rejects a %s serialized host result",
    async (_label, size, succeeds) => {
      const payload = "x".repeat(size);
      const ex = quickJsExecutor({ timeoutMs: 10_000 });
      const out = await ex.execute(`async () => (await large.get()).length`, [
        { name: "large", fns: { get: async () => payload } },
      ]);
      if (succeeds) {
        expect(out).toEqual({ result: size });
      } else {
        expect(out.result).toBeUndefined();
        expect(out.error).toContain("serialized bridge limit");
      }
    },
    15_000,
  );

  it("keeps concurrent near-limit bridge rounds deterministic", async () => {
    const size = 192 * 1024;
    const payload = "x".repeat(size);
    const ex = quickJsExecutor({ timeoutMs: 10_000 });
    const provider: ExecutorProvider[] = [
      { name: "large", fns: { get: async () => payload } },
    ];
    for (let round = 0; round < 5; round += 1) {
      const outputs = await Promise.all(
        Array.from({ length: 20 }, () =>
          ex.execute(`async () => (await large.get()).length`, provider),
        ),
      );
      expect(outputs).toEqual(Array(20).fill({ result: size }));
    }
  }, 30_000);

  it.each([
    ["0.5 MiB", 512 * 1024],
    ["1.5 MiB", 1536 * 1024],
    ["3.5 MiB", 3584 * 1024],
    ["7 MiB", 7 * 1024 * 1024],
  ])(
    "rejects concurrent %s host results before they enter QuickJS",
    async (_label, size) => {
      const payload = "x".repeat(size);
      const ex = quickJsExecutor({ timeoutMs: 10_000 });
      const provider: ExecutorProvider[] = [
        { name: "large", fns: { get: async () => payload } },
      ];
      const outputs = await Promise.all(
        Array.from({ length: 8 }, () =>
          ex.execute(`async () => (await large.get()).length`, provider),
        ),
      );
      for (const output of outputs) {
        expect(output.result).toBeUndefined();
        expect(output.error).toContain("serialized bridge limit");
      }
    },
    20_000,
  );

  it("measures the bridge limit in UTF-8 bytes, not UTF-16 code units", async () => {
    const payload = "😀".repeat(70_000);
    const ex = quickJsExecutor();
    const out = await ex.execute(`async () => unicode.get()`, [
      { name: "unicode", fns: { get: async () => payload } },
    ]);
    expect(payload.length).toBeLessThan(256 * 1024);
    expect(out.error).toContain("serialized bridge limit");
  });

  it("preserves logs when a host result cannot be serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => { console.log("before host call"); return bad.result(); }`,
      [{ name: "bad", fns: { result: async () => circular } }],
    );
    expect(out.result).toBeUndefined();
    expect(out.error).toContain("could not be serialized");
    expect(out.logs).toEqual(["before host call"]);
  });

  it("forwards every argument verbatim, positionally", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => connecta.call("calc.add", { a: 1 })`,
      providers(),
    );
    // Both args reach the host fn positionally — no drop, no first-arg-only.
    expect(out.result).toEqual({ address: "calc.add", args: { a: 1 } });
  });

  it("turns provider throws into catchable guest exceptions", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        try { await calc.boom({}); return "no throw"; }
        catch (e) { return "caught: " + e.message; }
      }`,
      providers(),
    );
    expect(out.result).toBe("caught: downstream exploded");
  });

  it("reports uncaught guest errors as error, not a rejection", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => { throw new Error("guest sad"); }`,
      [],
    );
    expect(out.result).toBeUndefined();
    expect(out.error).toContain("guest sad");
  });

  it("captures console output as logs", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => { console.log("hello", { a: 1 }); console.warn("warned"); return null; }`,
      [],
    );
    expect(out.logs).toEqual(["hello {\"a\":1}", "warned"]);
  });

  it("has no ambient capabilities in the sandbox", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => [typeof fetch, typeof setTimeout, typeof process, typeof require]`,
      [],
    );
    expect(out.result).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  it("rejects unknown provider functions", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        try { await connecta.nope(); }
        catch (e) { return e.message; }
      }`,
      providers(),
    );
    expect(out.result).toBe("Unknown function connecta.nope");
  });

  it("uses lazy namespaces without enumerating one property per tool", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => ({
        keys: Object.keys(calc),
        sum: (await calc.add({ a: 2, b: 3 })).sum
      })`,
      providers(),
    );
    expect(out).toEqual({ result: { keys: [], sum: 5 } });
  });

  it("runs a trusted provider prelude before user code", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => ({
        keys: Object.keys(calc),
        sum: (await calc.add({ a: 2, b: 3 })).sum
      })`,
      [
        {
          name: "connecta",
          prelude: `globalThis.calc = Object.freeze(new Proxy(Object.create(null), {
            get: (_target, toolName) => (args) =>
              connecta.__callNamespace("calc", toolName, args)
          }));`,
          fns: {
            __callNamespace: async (_connectorId, toolName, args) => {
              const { a, b } = args as { a: number; b: number };
              return toolName === "add" ? { sum: a + b } : null;
            },
          },
        },
      ],
    );
    expect(out).toEqual({ result: { keys: [], sum: 5 } });
  });

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
      [{
        name: "slow",
        fns: {
          forever: () => {
            called();
            return new Promise(() => {});
          },
        },
      }],
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

  it("times out when a host call hangs", async () => {
    const hang: ExecutorProvider[] = [
      { name: "slow", fns: { forever: () => new Promise(() => {}) } },
    ];
    // A budget the healthy follow-up below can meet on a loaded host; 300ms
    // was not always enough for it.
    const ex = quickJsExecutor({ timeoutMs: 1_000 });
    expect(
      await deadlineOutcome(ex.execute(`async () => slow.forever({})`, hang)),
    ).toMatch(/timed out|wall budget/);
    // The deadline ends the run, the parent retires the child, and the
    // replacement slot keeps serving.
    await expect(ex.execute("async () => 3", [])).resolves.toEqual({
      result: 3,
    });
  }, 10_000);

  it("releases every losing deadline timer after host waits settle", async () => {
    const before = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    const ex = quickJsExecutor({ timeoutMs: 2_000 });
    const out = await ex.execute(
      `async () => {
        for (let index = 0; index < 20; index += 1) await fast.one();
        return 20;
      }`,
      [{ name: "fast", fns: { one: async () => 1 } }],
    );
    const after = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    expect(out).toEqual({ result: 20 });
    expect(after).toBeLessThanOrEqual(before);
  });

  // The process boots tsx and a QuickJS child, which takes seconds on a loaded
  // host, so time-to-exit is no signal on its own. What the case pins is that
  // nothing outlives the computation: a leaked wall-deadline timer would hold
  // the process for the full EXECUTOR_WALL_MS, and a still-referenced child
  // forever. The spawn budget sits far below the first and far above startup.
  // The guest CPU budget is generous for the same reason as the fixture's.
  const EXECUTOR_WALL_MS = 300_000;
  const SPAWN_BUDGET_MS = 30_000;
  it("lets a short-lived process exit near computation time", () => {
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
  }, 2 * SPAWN_BUDGET_MS);

  it("drains pending host calls after a timeout without spinning [INV-7]", () => {
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
  }, 2 * SPAWN_BUDGET_MS);

  it("rejects guest calls that resolve to inherited prototype members", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        try { await calc.hasOwnProperty(); return "no throw"; }
        catch (e) { return "caught: " + e.message; }
      }`,
      providers(),
    );
    expect(out.result).toBe("caught: Unknown function calc.hasOwnProperty");
  });

  it("flags awaiting a promise that can never settle", async () => {
    const ex = quickJsExecutor({ timeoutMs: 2_000 });
    const out = await ex.execute(
      `async () => { await new Promise(() => {}); }`,
      [],
    );
    expect(out.error).toContain("stalled");
  }, 10_000);

  it("returns syntax errors as error", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute("async () => {{{", []);
    expect(out.error).toBeTruthy();
  });

  it("does not charge host-tool waits to the short guest CPU budget", async () => {
    const ex = quickJsExecutor({ cpuTimeMs: 250, timeoutMs: 2_000 });
    const out = await ex.execute(`async () => slow.read()`, [
      {
        name: "slow",
        fns: {
          read: () =>
            new Promise((resolve) => setTimeout(() => resolve("done"), 600)),
        },
      },
    ]);
    expect(out).toEqual({ result: "done" });
  });

  it("keeps the Node event loop responsive while a guest runs away", async () => {
    // A guest run on this event loop would block it for the whole CPU budget,
    // so the bound is derived from that budget: half of it leaves a loaded
    // host room for its own scheduling stalls (a fixed 150ms against a 200ms
    // budget did not) while still failing any guest that blocks the parent.
    const cpuTimeMs = 1_000;
    const ex = quickJsExecutor({ cpuTimeMs, timeoutMs: 10 * cpuTimeMs });
    let last = performance.now();
    let maxGap = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    const out = await ex.execute(`async () => { while (true) {} }`, []);
    clearInterval(heartbeat);
    expect(out.error).toContain("guest CPU budget");
    expect(maxGap).toBeLessThan(cpuTimeMs / 2);
  });

  it("cancels a running child from the inbound request signal", async () => {
    const ex = quickJsExecutor({ cpuTimeMs: 5_000, timeoutMs: 10_000 });
    const handler = createExecuteTool(
      makeRegistry([calcConnector]),
      "https://connecta.test",
      ex,
      silentLogger,
    );
    const controller = new AbortController();
    const pending = handler(
      { code: `async () => { while (true) {} }` },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const out = await pending;
    const payload = JSON.parse(required(out.content[0]).text) as {
      error: { code: string; retryable: boolean };
    };
    expect(payload.error).toMatchObject({
      code: "executor_cancelled",
      retryable: false,
    });
    await expect(ex.execute("async () => 9", [])).resolves.toEqual({
      result: 9,
    });
    await ex.close?.();
  });

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
    expect(payload.error.code).toBe("executor_failed");
    expect(payload.error.message).toContain("unresponsive");
    expect(ex.admissionSnapshot?.().active).toBe(0);
    await expect(ex.execute("async () => 9", [])).resolves.toEqual({
      result: 9,
    });
  }, 10_000);

  it("cancels a cold readiness wait without poisoning the warming slot", async () => {
    const ex = quickJsExecutor({ timeoutMs: 2_000 });
    const controller = new AbortController();
    const lease = await ex.acquire({ signal: controller.signal });
    const started = performance.now();
    const pending = lease.execute("async () => 1", []);
    setTimeout(() => controller.abort(), 1);
    await expect(pending).rejects.toMatchObject({
      code: "executor_cancelled",
    });
    lease.release();
    expect(performance.now() - started).toBeLessThan(500);
    await expect(ex.execute("async () => 9", [])).resolves.toEqual({
      result: 9,
    });
  });

  it("loads only the canonically called connector end to end", async () => {
    const catalogs: string[] = [];
    const countedCalc: Connector = {
      ...calcConnector,
      async listTools(ctx) {
        catalogs.push("calc");
        return calcConnector.listTools(ctx);
      },
    };
    const unused = Array.from(
      { length: 20 },
      (_, index): Connector => ({
        id: `unused_${index}`,
        kind: "api",
        async listTools() {
          catalogs.push(`unused_${index}`);
          return [
            { name: "read", annotations: { readOnlyHint: true } },
          ];
        },
        async callTool() {
          return index;
        },
      }),
    );
    const registry = makeRegistry([countedCalc, ...unused]);
    const ex = quickJsExecutor();
    const out = await createExecuteTool(
      registry,
      "https://connecta.test",
      ex,
      silentLogger,
    )({
      code: `async () => ({
        connectorGlobal: typeof calc,
        sum: (await connecta.call("calc.add", { a: 20, b: 22 })).sum
      })`,
    });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({
      result: { connectorGlobal: "undefined", sum: 42 },
    });
    expect(catalogs).toEqual(["calc"]);
  });

  it("names the called address when a host result breaks the bridge bound", async () => {
    // The child proxies host calls to the parent, so the parent's message is
    // the one a program reads. Every shortcut namespace dispatches through one
    // internal function; reporting that name would tell a program nothing about
    // which call was too large.
    const bulky: Connector = {
      id: "reader",
      kind: "api",
      async listTools() {
        return [{ name: "big", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return { blob: "x".repeat(400_000) };
      },
    };
    const ex = quickJsExecutor({ cpuTimeMs: 2_000 });
    const out = await createExecuteTool(
      makeRegistry([bulky]),
      "https://connecta.test",
      ex,
      silentLogger,
    )({
      code: `async () => {
        try { await connecta.call("reader.big", {}); } catch (err) { return err.message; }
        return "no failure";
      }`,
    });

    expect(out.isError).toBeUndefined();
    const message = String(
      (out.structuredContent as { result?: unknown }).result,
    );
    expect(message).toContain("serialized bridge limit");
    expect(message).toContain("reader.big");
    expect(message).not.toContain("__callNamespace");
  });

  it("bounds the final guest result before child-to-parent IPC", async () => {
    const ex = quickJsExecutor({
      memoryLimitBytes: 16 * 1024 * 1024,
      cpuTimeMs: 1_000,
    });
    const out = await ex.execute(
      `async () => "x".repeat(5 * 1024 * 1024)`,
      [],
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({
      truncated: true,
      totalChars: expect.any(Number),
    });
    expect(JSON.stringify(out).length).toBeLessThan(100_000);
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

  it("keeps a 10,000-tool direct call inside a one-second warm budget", async () => {
    const fns: ExecutorProvider["fns"] = {};
    for (let index = 0; index < 10_000; index++) {
      fns[`tool_${index}`] = async () => index;
    }
    const ex = quickJsExecutor({ cpuTimeMs: 1_000 });
    await ex.execute("async () => 1", [{ name: "catalog", fns }]);
    const started = performance.now();
    const out = await ex.execute("async () => catalog.tool_9999()", [
      { name: "catalog", fns },
    ]);
    expect(out).toEqual({ result: 9_999 });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("bounds a 50-way saturation burst without starving heartbeats", async () => {
    const ex = quickJsExecutor({
      concurrency: 4,
      maxQueueSize: 50,
      cpuTimeMs: 30,
      timeoutMs: 2_000,
    });
    let last = performance.now();
    const gaps: number[] = [];
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 10);
    const outputs = await Promise.all(
      Array.from({ length: 50 }, () =>
        ex.execute(`async () => { while (true) {} }`, []),
      ),
    );
    clearInterval(heartbeat);
    gaps.sort((a, b) => a - b);
    const p99 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.99))];
    expect(outputs.every((out) => out.error?.includes("guest CPU budget"))).toBe(
      true,
    );
    expect(p99).toBeLessThan(150);
  }, 15_000);

  it("close terminates active children and rejects new admission", async () => {
    const ex = quickJsExecutor({ cpuTimeMs: 5_000, timeoutMs: 10_000 });
    const running = ex.execute(`async () => { while (true) {} }`, []);
    const closed = expect(running).rejects.toMatchObject({
      code: "executor_closed",
    });
    await waitFor(() => (ex.admissionSnapshot?.().active ?? 0) > 0);
    await ex.close?.();
    await closed;
    await expect(ex.execute("async () => 1", [])).rejects.toMatchObject({
      code: "executor_closed",
    });
  });

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
          context.signal?.addEventListener(
            "abort",
            () => reject(new Error("call aborted")),
            { once: true },
          );
        });
      },
    };
    const executor = quickJsExecutor({ timeoutMs: 10_000 });
    const handler = createExecuteTool(
      makeRegistry([connector]),
      "https://connecta.test",
      executor,
      silentLogger,
    );
    const running = handler({
      code: `async () => {
        await connecta.emit({ type: "text", text: "doomed" });
        return connecta.call("blocking.read", {});
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
    };
    expect(JSON.parse(required(out.content[0]).text ?? "")).toEqual(expected);
    expect(out.structuredContent).toEqual(expected);
  });
});


describe("the advertised investigation example", () => {
  it.each(["available", "missing", "approval-required"] as const)(
    "finds dependent evidence with %s logs and never reads the other account",
    async (mode) => {
      // Execute the published example, not a separately maintained imitation.
      const code = required(USAGE_SKILL.match(/```js\n([\s\S]*?)\n```/)?.[1]);
      const calls: string[] = [];
      let unrelatedCatalogReads = 0;
      const run = {
        name: "get_run", description: "Get a deployment run",
        inputSchema: { type: "object" as const, properties: { runId: { type: "integer" as const } }, required: ["runId"], additionalProperties: false },
        annotations: { readOnlyHint: true },
        handler: (args: Record<string, unknown>) => {
          expect(args).toEqual({ runId: 42 }); calls.push("run");
          return { status: "failed", failedJobId: 7 };
        },
      };
      const logs = {
        name: "get_job_logs", description: "Get logs for a job",
        inputSchema: { type: "object" as const, properties: { jobId: { type: "integer" as const } }, required: ["jobId"], additionalProperties: false },
        annotations: { readOnlyHint: mode !== "approval-required" },
        handler: (args: Record<string, unknown>) => {
          expect(args).toEqual({ jobId: 7 }); calls.push("logs");
          return [{ level: "info", message: "private noise", timestamp: "1" }, { level: "error", message: "Build failed", timestamp: "2" }];
        },
      };
      const registry = makeRegistry([
        api("ci", { tools: mode === "missing" ? [run] : [run, logs] }),
        { id: "ci_sandbox", listTools: async () => { unrelatedCatalogReads++; throw new Error("wrong account searched"); }, callTool: async () => { throw new Error("wrong account called"); } },
      ]);
      const out = await createExecuteTool(registry, "https://connecta.test", quickJsExecutor(), silentLogger)({ code });
      const payload = JSON.parse(required(out.content[0]).text);
      expect(out.isError).toBeFalsy();
      expect(payload.result).toEqual(mode === "available"
        ? [{ timestamp: "2", message: "Build failed" }]
        : { status: "failed", gap: "Job logs not resolved" });
      expect(calls).toEqual(mode === "available" ? ["run", "logs"] : ["run"]);
      expect(unrelatedCatalogReads).toBe(0);
    },
  );
});

describe("authenticated host failures (E1, X11)", () => {
  it.each(["x", "\u0000", "😀"])("bounds 50 KB downstream errors containing %j before framing", async (character) => {
    const connector = connectorWith({
      id: "bad", kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => { throw new ConnectorCallError("not_found", character.repeat(50_000)); },
    });
    const handler = createExecuteTool(makeRegistry([connector]), "https://connecta.test", quickJsExecutor(), silentLogger);
    const caught = await handler({ code: `async () => {
      try { await connecta.call("bad.read", {}); }
      catch (error) { return { code: error.code, message: error.message, details: error.details }; }
    }` });
    expect(caught.structuredContent).toMatchObject({ result: { code: "not_found", details: { code: "not_found" } } });
    const result = caught.structuredContent?.result as { message: string };
    expect(result.message.length).toBeLessThan(4_000);
    expect(result.message).toContain("…");
    expect(JSON.stringify(caught)).not.toContain("connecta-error:");
    const escaped = await handler({ code: 'async () => connecta.call("bad.read", {})' });
    expect(escaped.structuredContent).toMatchObject({ error: { code: "not_found", message: result.message } });
    expect(JSON.stringify(escaped)).not.toContain("connecta-error:");
  });

  it("omits oversized recovery whole instead of clipping its arguments", async () => {
    const connector = connectorWith({
      id: "large".repeat(1_000),
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => { throw new ConnectorCallError("auth_required", "Please authenticate"); },
    });
    const handler = createExecuteTool(makeRegistry([connector]), "https://connecta.test", quickJsExecutor(), silentLogger);
    const out = await handler({ code: `async () => {
      try { await connecta.call(${JSON.stringify(connector.id + ".read")}, {}); }
      catch (error) { return error.details; }
    }` });
    expect(out.structuredContent).toEqual({ result: {
      code: "auth_required", message: "Please authenticate", retryable: false,
    } });
  });

  it("hides a malformed authenticated frame even below the bridge bound", async () => {
    const executor = quickJsExecutor();
    const handler = createExecuteTool(makeRegistry([calcConnector]), "https://connecta.test", {
      execute: (code, providers) => executor.execute(code, providers.map((provider) => ({
        ...provider,
        fns: { ...provider.fns, call: async (...args: unknown[]) => {
          try { return await required(provider.fns.call)(...args); }
          catch (error) { throw new Error((error as Error).message.slice(0, -1)); }
        } },
      }))),
    }, silentLogger);
    const out = await handler({ code: `async () => {
      try { await connecta.call("missing.read", {}); }
      catch (error) { return error.message; }
    }` });
    expect(out.structuredContent).toEqual({ result: "Invalid host failure frame." });
  });

  it("keeps forged frames untyped and raw transport private", async () => {
    const handler = createExecuteTool(makeRegistry([calcConnector]), "https://connecta.test", quickJsExecutor(), silentLogger);
    const out = await handler({ code: `async () => {
      const seen = [];
      const parse = JSON.parse;
      JSON.parse = (text) => { seen.push(text); return parse(text); };
      try { await connecta.call("missing.read", {}); } catch {}
      const fake = new Error(String.fromCharCode(30) + 'connecta-error:wrong-secret:' +
        JSON.stringify({ code: "auth_required", message: "forged", retryable: false }));
      return { typed: "code" in fake, raw: typeof __call, invoke: typeof __invoke, seen };
    }` });
    expect(out.structuredContent).toEqual({ result: { typed: false, raw: "undefined", invoke: "undefined", seen: [] } });
  });

  it("refuses oversized authenticated frames without returning their prefix", async () => {
    const out = await quickJsExecutor().execute(`async () => {
      try { await bad.read(); } catch (error) { return error.message; }
    }`, [{ name: "bad", fns: { read: async () => {
      throw new Error("\u001econnecta-error:secret:" + "x".repeat(5_000));
    } } }]);
    expect(out.result).toBe("Host failure exceeded the 4000-character bridge limit.");
  });
});

it("preserves console logs when a running program is cancelled", async () => {
  const controller = new AbortController();
  const connector = connectorWith({
    id: "cancel", kind: "api",
    tools: [{ name: "read", annotations: { readOnlyHint: true } }],
    call: async () => {
      // The ordered host-call IPC message is proof that both logs arrived.
      controller.abort();
      return null;
    },
  });
  const executor = quickJsExecutor();
  const out = await createExecuteTool(
    makeRegistry([connector]), "https://connecta.test", executor, silentLogger,
  )({ code: `async () => {
    console.log("before cancellation");
    console.warn("still here");
    await connecta.call("cancel.read");
  }`, diagnostics: true }, { signal: controller.signal });
  expect(out.isError).toBe(true);
  expect(out.structuredContent).toMatchObject({
    error: { code: "executor_cancelled" },
    logs: "before cancellation\nstill here",
  });
});
