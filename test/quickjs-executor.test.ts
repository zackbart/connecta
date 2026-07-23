import { describe, expect, it } from "vitest";
import { normalizeCode, quickJsExecutor } from "../src/executors/quickjs.js";
import type { ExecutorProvider } from "../src/types.js";

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
  it("detects a function past a leading block comment", () => {
    expect(normalizeCode("/* setup */\n(async () => 1)")).toBe(
      "/* setup */\n(async () => 1)",
    );
  });
});

describe("quickJsExecutor", () => {
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
      `async () => { try { await connecta.nope(); } catch (e) { return "x"; } }`,
      providers(),
    );
    // connecta.nope is not defined on the frozen namespace → TypeError.
    expect(out.error ?? out.result).toBeDefined();
  });

  it("maps a runaway synchronous loop to the friendly timeout message", async () => {
    const ex = quickJsExecutor({ timeoutMs: 300 });
    const out = await ex.execute(`async () => { while (true) {} }`, []);
    expect(out.result).toBeUndefined();
    // Not QuickJS's raw "interrupted" — the same message as a host-call timeout.
    expect(out.error).toBe("Execution timed out after 300ms.");
  }, 10_000);

  it("rejects an allocation that exceeds the guest heap limit", async () => {
    // Tight 4 MiB cap with a generous time budget: the failure must be the
    // memory ceiling, not the deadline. A growing allocation blows the cap.
    const ex = quickJsExecutor({
      memoryLimitBytes: 4 * 1024 * 1024,
      timeoutMs: 10_000,
    });
    const out = await ex.execute(
      `async () => {
        const a = [];
        for (let i = 0; i < 1e7; i++) a.push("padding".repeat(100));
        return a.length;
      }`,
      [],
    );
    expect(out.result).toBeUndefined();
    expect(out.error).toBeTruthy();
    // The heap cap trips, not the wall-clock deadline.
    expect(out.error).not.toContain("timed out");
    expect(out.error).toMatch(/memory/i);
  }, 15_000);

  it("times out when a host call hangs", async () => {
    const hang: ExecutorProvider[] = [
      { name: "slow", fns: { forever: () => new Promise(() => {}) } },
    ];
    const ex = quickJsExecutor({ timeoutMs: 300 });
    const out = await ex.execute(`async () => slow.forever({})`, hang);
    expect(out.error).toContain("timed out");
  }, 10_000);

  it("drains pending host calls after a timeout without spinning", async () => {
    // Two stragglers settling at different times after the budget expires.
    const slow: ExecutorProvider[] = [
      {
        name: "slow",
        fns: {
          a: () => new Promise((r) => setTimeout(() => r(1), 600)),
          b: () => new Promise((r) => setTimeout(() => r(2), 1200)),
        },
      },
    ];
    const ex = quickJsExecutor({ timeoutMs: 300 });
    const out = await ex.execute(
      `async () => Promise.all([slow.a(), slow.b()])`,
      slow,
    );
    expect(out.error).toContain("timed out");
    // Regression guard: the old drain re-.then()'d an already-resolved
    // deferred forever, pinning the microtask queue and starving setTimeout.
    // If that returns, this macrotask timer never fires and the hard vitest
    // budget below trips instead of hanging the suite.
    const tick = await new Promise<string>((r) =>
      setTimeout(() => r("tick"), 1400),
    );
    expect(tick).toBe("tick");
  }, 4_000);

  it("rejects guest calls that resolve to inherited prototype members", async () => {
    const ex = quickJsExecutor();
    const out = await ex.execute(
      `async () => {
        try { await __invoke("calc", "hasOwnProperty", []); return "no throw"; }
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
});
