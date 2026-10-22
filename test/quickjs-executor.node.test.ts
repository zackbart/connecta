// Node-only: runs the Node QuickJS child-process executor.
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { normalizeCode, quickJsExecutor } from "../src/executors/quickjs.js";
import type { AdmittingExecutor, Connector } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { calcConnector, makeRegistry, silentLogger } from "./helpers.js";

// Real child startup and IPC need generous hang guards on a loaded host.
// Each deadline case still asserts the executor's own configured budget.
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
  // A new QuickJS context isolates every program; these cases exercise results
  // and host failures without killing the child or depending on pool startup.
  let executor: AdmittingExecutor;
  let bridgeExecutor: AdmittingExecutor;
  let rejectionExecutor: AdmittingExecutor;
  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
    bridgeExecutor = quickJsExecutor({ cpuTimeMs: 5_000, timeoutMs: 10_000 });
    rejectionExecutor = quickJsExecutor({ timeoutMs: 1_000, cpuTimeMs: 100 });
  });
  afterAll(async () => {
    await Promise.all([executor.close?.(), bridgeExecutor.close?.(), rejectionExecutor.close?.()]);
  });
  it.each([
    ["0.125 MiB", 128 * 1024, true],
    ["0.5 MiB", 512 * 1024, false],
    ["1.5 MiB", 1536 * 1024, false],
  ])(
    "bridges or deterministically rejects a %s serialized host result",
    async (_label, size, succeeds) => {
      const payload = "x".repeat(size);
      const ex = bridgeExecutor;
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
    const ex = executor;
    const out = await ex.execute(`async () => unicode.get()`, [{ name: "unicode", fns: { get: async () => payload } }]);
    expect(payload.length).toBeLessThan(256 * 1024);
    expect(out.error).toContain("serialized bridge limit");
  });

  it("preserves logs when a host result cannot be serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ex = executor;
    const out = await ex.execute(`async () => { console.log("before host call"); return bad.result(); }`, [
      { name: "bad", fns: { result: async () => circular } },
    ]);
    expect(out.result).toBeUndefined();
    expect(out.error).toContain("could not be serialized");
    expect(out.logs).toEqual(["before host call"]);
  });

  it.each(["native-error", "plain-object", "proxy"] as const)(
    "INV-3 INV-7: describes a rejected %s without guest getters or serialization",
    async (kind) => {
      const ex = rejectionExecutor;
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
    const out = await executor.execute(
      `async () => {
      throw new TypeError("native data");
    }`,
      [],
    );
    expect(out).toMatchObject({ error: "TypeError: native data", failure: { name: "TypeError", line: 2 } });
  });

  it("INV-3 INV-6: accessor edits do not replace a retained typed host rejection", async () => {
    const result = await createExecuteTool(
      makeRegistry([calcConnector]),
      "https://connecta.test",
      executor,
      silentLogger,
    )({
      code: `async () => {
        try { await connecta.call("missing.read"); }
        catch (error) {
          Object.defineProperties(error, {
            name: { get() { console.log("name getter ran"); while (true) {} } },
            message: { get() { console.log("message getter ran"); while (true) {} } },
            stack: { get() { console.log("stack getter ran"); while (true) {} } }
          });
          throw error;
        }
      }`,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "unknown_address" },
      hostCalls: { attempted: 1, admitted: 1, succeeded: 0, failed: 1 },
    });
    expect(result.structuredContent).not.toHaveProperty("logs");
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
    const ex = executor;
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
    onTestFinished(() => ex.close?.());
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
});

describe("authenticated host failures (E1, X11)", () => {
  let executor: AdmittingExecutor;
  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  });
  afterAll(() => executor.close?.());
  it.each(["x", "😀"])("bounds 50 KB downstream errors containing %j before framing", async (character) => {
    const connector = connectorWith({
      id: "bad",
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => {
        throw new ConnectorCallError("not_found", character.repeat(50_000));
      },
    });
    const handler = createExecuteTool(makeRegistry([connector]), "https://connecta.test", executor, silentLogger);
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
    const handler = createExecuteTool(makeRegistry([connector]), "https://connecta.test", executor, silentLogger);
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
    const handler = createExecuteTool(makeRegistry([calcConnector]), "https://connecta.test", executor, silentLogger);
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
    const out = await executor.execute(
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
