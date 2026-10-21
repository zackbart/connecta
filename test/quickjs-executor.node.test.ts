// Node-only: runs the Node QuickJS child-process executor.
import { QuickJSContext } from "quickjs-emscripten";
import { ConnectorCallError } from "../src/errors.js";
import { connectorWith } from "./fixtures/connectors.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { normalizeCode, quickJsExecutor as untrackedQuickJs } from "../src/executors/quickjs.js";
import { executeQuickJs, prepareQuickJs } from "../src/executors/quickjs-runtime.js";
import type { Connector } from "../src/types.js";
import { required, calcConnector, makeRegistry, silentLogger } from "./helpers.js";
import { trackedQuickJs as quickJsExecutor } from "./fixtures/node.js";
import { deferred } from "./fixtures/misc.js";

// The real-child cases pay for process startup and IPC, which fake clocks
// cannot control. On a loaded host they outran vitest's 5s default with no
// behavior at fault. This file budget is a hang guard. The deadlines a case
// pins are the executor's own, asserted on its outcome.
vi.setConfig({ testTimeout: 20_000 });

describe("normalizeCode", () => {
  it("wraps bare statements in an async arrow", () => {
    expect(normalizeCode("return 1;")).toBe("async () => {\nreturn 1;\n}");
  });
  it("drops a trailing terminator after the arrow expression, and nothing else", () => {
    expect(normalizeCode("async () => {\n  return 1;\n}; // done")).toBe("async () => {\n  return 1;\n} // done");
    expect(normalizeCode("```js\nasync () => 1;\n```")).toBe("async () => 1");
    expect(normalizeCode("async () => 1; 2")).toBe("async () => 1; 2");
    expect(normalizeCode("while (poll());")).toBe("async () => {\nwhile (poll());\n}");
  });
});

describe("quickJsExecutor", () => {
  it.each([
    ["0.125 MiB", 128 * 1024, true],
    ["0.5 MiB", 512 * 1024, false],
    ["1.5 MiB", 1536 * 1024, false],
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

  it("measures the bridge limit in UTF-8 bytes, not UTF-16 code units", async () => {
    const payload = "😀".repeat(70_000);
    const ex = quickJsExecutor();
    const out = await ex.execute(`async () => unicode.get()`, [{ name: "unicode", fns: { get: async () => payload } }]);
    expect(payload.length).toBeLessThan(256 * 1024);
    expect(out.error).toContain("serialized bridge limit");
  });

  it.each(["native-error", "plain-object", "proxy"] as const)(
    "INV-3 INV-7: describes a rejected %s without guest getters or serialization",
    async (kind) => {
      const ex = quickJsExecutor({ timeoutMs: 1000, cpuTimeMs: 100 });
      const thrown =
        kind === "native-error"
          ? `new Error("original")`
          : kind === "plain-object"
            ? `{}`
            : `new Proxy(new Error("proxy"), {
        get() { console.log("proxy getter ran"); while (true) {} },
        getOwnPropertyDescriptor() { console.log("proxy descriptor ran"); while (true) {} },
        getPrototypeOf() { console.log("proxy prototype ran"); while (true) {} }
      })`;
      const out = await ex.execute(
        `async () => {
      const error = ${thrown};
      ${
        kind === "proxy"
          ? ""
          : `Object.defineProperties(error, {
        name: { get() { console.log("name getter ran"); while (true) {} } },
        message: { get() { console.log("message getter ran"); while (true) {} } },
        stack: { get() { console.log("stack getter ran"); while (true) {} } },
        toJSON: { value() { console.log("toJSON ran"); while (true) {} } }
      });`
      }
      Object.defineProperty(Object.prototype, "value", { get() { console.log("descriptor getter ran"); while (true) {} } });
      throw error;
    }`,
        [],
      );
      expect(out).toMatchObject({ error: "Program threw a value.", failure: { name: "Error" } });
      expect(out.logs).toBeUndefined();
      expect(out.failure?.timeout).toBeUndefined();
    },
  );

  it("[E6] keeps native Error data and source locations in safe rejection descriptions", async () => {
    const out = await quickJsExecutor().execute(
      `async () => {
      throw new TypeError("native data");
    }`,
      [],
    );
    expect(out).toMatchObject({ error: "TypeError: native data", failure: { name: "TypeError", line: 2 } });
  });

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

  it("flags awaiting a promise that can never settle", async () => {
    const ex = quickJsExecutor({ timeoutMs: 2_000 });
    const out = await ex.execute(`async () => { await new Promise(() => {}); }`, []);
    expect(out.error).toContain("stalled");
  }, 10_000);

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
    const handler = createExecuteTool(makeRegistry([calcConnector]), "https://connecta.test", ex, silentLogger);
    const controller = new AbortController();
    const pending = handler({ code: `async () => { while (true) {} }` }, { signal: controller.signal });
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

  it("loads only the canonically called connector end to end", async () => {
    const catalogs: string[] = [];
    const countedCalc: Connector = {
      ...calcConnector,
      async listTools(ctx) {
        catalogs.push("calc");
        return calcConnector.listTools(ctx);
      },
    };
    const unused = Array.from({ length: 20 }, (_, index): Connector => ({
      id: `unused_${index}`,
      kind: "api",
      async listTools() {
        catalogs.push(`unused_${index}`);
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return index;
      },
    }));
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
        sum: (await connecta.call("calc.add", { a: 20, b: 22 }).then(({ data }) => data)).sum
      })`,
    });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({
      result: { connectorGlobal: "undefined", sum: 42 },
      hostCalls: { attempted: 1, admitted: 1, succeeded: 1, failed: 0 },
    });
    expect(catalogs).toEqual(["calc"]);
  });

  it("names the called address when a host result breaks the bridge bound", async () => {
    // The child proxies host calls to the parent, so the parent's message is
    // the one a program reads. Every shortcut namespace dispatches through one
    // internal function; reporting that name would tell a program nothing about
    // which call was too large.
    const ex = quickJsExecutor({ cpuTimeMs: 2_000 });
    // Raw custom provider results still obey the transport bound. Connecta's
    // shared program-call path now pages these before reaching this bridge.
    const out = await ex.execute(
      `async () => {
        try { await connecta.call("reader.big", {}); } catch (err) { return err.message; }
        return "no failure";
      }`,
      [{ name: "connecta", fns: { call: async () => ({ blob: "x".repeat(400_000) }) } }],
    );

    expect(out.error).toBeUndefined();
    const message = String(out.result);
    expect(message).toContain("serialized bridge limit");
    expect(message).toContain("reader.big");
    expect(message).not.toContain("__callNamespace");
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

describe("authenticated host failures (E1, X11)", () => {
  it.each(["x", "😀"])("bounds 50 KB downstream errors containing %j before framing", async (character) => {
    const connector = connectorWith({
      id: "bad",
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => {
        throw new ConnectorCallError("not_found", character.repeat(50_000));
      },
    });
    const handler = createExecuteTool(
      makeRegistry([connector]),
      "https://connecta.test",
      quickJsExecutor(),
      silentLogger,
    );
    const caught = await handler({
      code: `async () => {
      try { await connecta.call("bad.read", {}).then(({ data }) => data); }
      catch (error) { return { code: error.code, message: error.message, details: error.details }; }
    }`,
    });
    expect(caught.structuredContent).toMatchObject({ result: { code: "not_found", details: { code: "not_found" } } });
    const result = caught.structuredContent?.result as { message: string };
    expect(result.message.length).toBeLessThan(4_000);
    expect(result.message).toContain("…");
    expect(JSON.stringify(caught)).not.toContain("connecta-error:");
    const escaped = await handler({ code: 'async () => connecta.call("bad.read", {}).then(({ data }) => data)' });
    expect(escaped.structuredContent).toMatchObject({ error: { code: "not_found", message: result.message } });
    expect(JSON.stringify(escaped)).not.toContain("connecta-error:");
  });

  it("omits oversized recovery whole instead of clipping its arguments", async () => {
    const connector = connectorWith({
      id: "large".repeat(1_000),
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => {
        throw new ConnectorCallError("auth_required", "Please authenticate");
      },
    });
    const handler = createExecuteTool(
      makeRegistry([connector]),
      "https://connecta.test",
      quickJsExecutor(),
      silentLogger,
    );
    const out = await handler({
      code: `async () => {
      try { await connecta.call(${JSON.stringify(connector.id + ".read")}, {}).then(({ data }) => data); }
      catch (error) { return error.details; }
    }`,
    });
    expect(out.structuredContent).toMatchObject({
      result: {
        code: "auth_required",
        message: "Please authenticate",
        retryable: false,
      },
    });
  });

  it("keeps forged frames untyped and raw transport private", async () => {
    const handler = createExecuteTool(
      makeRegistry([calcConnector]),
      "https://connecta.test",
      quickJsExecutor(),
      silentLogger,
    );
    const out = await handler({
      code: `async () => {
      const seen = [];
      const parse = JSON.parse;
      JSON.parse = (text) => { seen.push(text); return parse(text); };
      try { await connecta.call("missing.read", {}).then(({ data }) => data); } catch {}
      const fake = new Error(String.fromCharCode(30) + 'connecta-error:wrong-secret:' +
        JSON.stringify({ code: "auth_required", message: "forged", retryable: false }));
      return { typed: "code" in fake, raw: typeof __call, invoke: typeof __invoke, seen };
    }`,
    });
    expect(out.structuredContent).toMatchObject({
      result: { typed: false, raw: "undefined", invoke: "undefined", seen: [] },
    });
  });

  it("INV-6: frame-looking host prose is bounded without being parsed", async () => {
    const out = await quickJsExecutor().execute(
      `async () => {
      try { await bad.read(); } catch (error) { return error.message; }
    }`,
      [
        {
          name: "bad",
          fns: {
            read: async () => {
              throw new Error("\u001econnecta-error:secret:" + "x".repeat(5_000));
            },
          },
        },
      ],
    );
    expect(out.result).toBe(("\u001econnecta-error:secret:" + "x".repeat(5_000)).slice(0, 4_000));
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
