// Node-only: runs the Node QuickJS child-process executor.
import type { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { InvocationFailure } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { sentSecretsFor } from "../src/sent-secrets.js";
import type { AdmittingExecutor, Connector } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { calcConnector, makeRegistry, silentLogger } from "./helpers.js";

// Real child startup and IPC need generous hang guards on a loaded host.
// Each deadline case still asserts the executor's own configured budget.
vi.setConfig({ testTimeout: 20_000 });

describe("quickJsExecutor", () => {
  // A new QuickJS context isolates every program; these cases exercise results
  // and host failures without killing the child or depending on pool startup.
  let executor: AdmittingExecutor;
  let rejectionExecutor: AdmittingExecutor;
  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
    rejectionExecutor = quickJsExecutor({ timeoutMs: 1_000, cpuTimeMs: 100 });
  });
  afterAll(async () => {
    await Promise.all([executor.close?.(), rejectionExecutor.close?.()]);
  });
  it.each(["value", "promise", "throw", "rejection"] as const)(
    "INV-7: direct execution preserves provider %s behavior at the native leaf",
    async (mode) => {
      const failure = new InvocationFailure({
        code: "invalid_args",
        message: "Direct host refusal.",
        retryable: false,
      });
      const answer = () => {
        if (mode === "throw") throw failure;
        if (mode === "rejection") return Promise.reject(failure);
        return mode === "promise" ? Promise.resolve(42) : 42;
      };
      const outcome = await executor.execute("async () => await host.answer()", [
        {
          name: "host",
          // Direct JavaScript callers historically work with plain values too.
          fns: { answer: answer as unknown as () => Promise<unknown> },
        },
      ]);
      if (mode === "value" || mode === "promise") expect(outcome).toEqual({ result: 42 });
      else {
        expect(outcome.error).toContain(failure.message);
        expect(outcome.failure?.call).toEqual(failure.details);
      }
    },
  );
  it.each([
    ["0.125 MiB", 128 * 1024, true],
    ["0.5 MiB", 512 * 1024, false],
  ])(
    "bridges or deterministically rejects a %s serialized host result",
    async (_label, size, succeeds) => {
      const payload = "x".repeat(size);
      const ex = executor;
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

  it.each(["native-error", "proxy"] as const)(
    "INV-3 INV-7: describes a rejected %s without guest getters or serialization",
    async (kind) => {
      const ex = rejectionExecutor;
      const thrown =
        kind === "native-error"
          ? `new Error("original")`
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

  describe("INV-5: a clip never leaves the opening of a credential a later call registers", () => {
    const LATE = "Zqx79UVW_LATE_SECRET";
    const lateRegistry = (text: string) =>
      makeRegistry([
        {
          id: "source",
          kind: "mcp",
          description: "Answers with a tool error",
          listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
          callTool: async () => ({ isError: true, content: [{ type: "text", text }] }),
        },
        {
          id: "vault",
          kind: "api",
          description: "Sends a credential",
          listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
          callTool: async (_name, _args, context) => {
            sentSecretsFor(context).secret(LATE);
            return { ok: true };
          },
        },
      ]);
    const caughtThenRegistered = `async () => {
      let held;
      try { await connecta.call("source.read", {}); } catch (error) { held = error.message; }
      await connecta.call("vault.read", {});
      return held;
    }`;

    it("in a tool error the bridge clips, crossing its 2,000 serialized characters", async () => {
      const text = `${"a ".repeat(996)}x${LATE}${" trailing ".repeat(10)}`;
      const execute = createExecuteTool(lateRegistry(text), "https://connecta.test", executor, silentLogger);
      const result = await execute({ code: caughtThenRegistered });
      const held = result.structuredContent?.result as string;
      expect(held).toMatch(/^a a .* a … \[truncated\]$/);
      expect(JSON.stringify(held).length).toBeLessThanOrEqual(2_000);
      expect(JSON.stringify(result)).not.toContain("Zqx7");
      expect(JSON.stringify(result)).not.toMatch(/ x… | x /);
    });

    it("in a bridge clip counting JSON escapes, not characters", async () => {
      const text = `${'"'.repeat(990)}x${LATE} tail`;
      const execute = createExecuteTool(lateRegistry(text), "https://connecta.test", executor, silentLogger);
      const result = await execute({ code: caughtThenRegistered });
      expect(JSON.stringify(result.structuredContent?.result).length).toBeLessThanOrEqual(2_000);
      expect(JSON.stringify(result)).not.toContain("Zqx");
    });

    it.each([
      ["an Error", (text: string) => `throw new Error(${JSON.stringify(text)})`],
      ["a string", (text: string) => `throw ${JSON.stringify(text)}`],
    ])("in %s the program throws, clipped at 4,000 characters", async (_label, thrown) => {
      const text = `${"a ".repeat(1_998)}x${LATE} tail`;
      const execute = createExecuteTool(lateRegistry("unused"), "https://connecta.test", executor, silentLogger);
      const result = await execute({
        code: `async () => { await connecta.call("vault.read", {}); ${thrown(text)}; }`,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("a a a");
      expect(JSON.stringify(result)).not.toContain("Zqx");
    });

    it("in a log line kept when a cancelled run ends without its final reply", async () => {
      const cancel = new AbortController();
      let calls = 0;
      const registry = makeRegistry([
        {
          id: "vault",
          kind: "api",
          description: "Sends a credential",
          listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
          callTool: async (_name, _args, context) => {
            sentSecretsFor(context).secret(LATE);
            // The log line reached the host before this second call.
            if (++calls === 2) cancel.abort();
            return { ok: true };
          },
        },
      ]);
      const text = `${"a ".repeat(1_998)}x${LATE} tail`;
      const result = await createExecuteTool(
        registry,
        "https://connecta.test",
        executor,
        silentLogger,
      )(
        {
          code: `async () => {
            await connecta.call("vault.read", {});
            console.log(${JSON.stringify(text)});
            await connecta.call("vault.read", {});
            await new Promise(() => {});
          }`,
        },
        { signal: cancel.signal },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.logs).toContain("a a a");
      expect(JSON.stringify(result)).not.toContain("Zqx");
    });
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
});

describe("authenticated host failures (E1, X11)", () => {
  let executor: AdmittingExecutor;
  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  });
  afterAll(() => executor.close?.());
  it.each(["😀"])("bounds 50 KB downstream errors containing %j before framing", async (character) => {
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
});

describe("credential echoes reach the QuickJS guest only checked", () => {
  const BASE = "https://wire-redaction.test";
  const REDACTED = "[redacted]";
  let executor: AdmittingExecutor;
  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await executor.close?.();
  });

  it("INV-5: public-schema remote tools redact bare numeric bearer credentials in direct modes and QuickJS", async () => {
    const token = "12345678";
    const downstream = httpDownstream(
      (server) =>
        server.registerTool(
          "read",
          { description: "Read public data", annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: token }] }),
        ),
      {
        capture: (request) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
        },
      },
    );
    vi.stubGlobal("fetch", downstream.fetch);
    const registry = makeRegistry([
      remoteMcp("remote", {
        url: downstream.url,
        auth: { type: "headers", headers: { Authorization: `Bearer ${token}` } },
      }),
    ]);
    for (const resultMode of ["mcp", "value"] as const) {
      const result = await createMetaTools(registry, BASE).callTool({ address: "remote.read", resultMode });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).toContain(REDACTED);
    }
    const execute = createExecuteTool(registry, BASE, executor, silentLogger);
    const whole = await execute({ code: 'async () => await connecta.call("remote.read")' });
    expect(whole.isError, JSON.stringify(whole.structuredContent)).toBeFalsy();
    expect(whole.structuredContent).toMatchObject({ result: { data: REDACTED, format: "text" } });
    // Seven units are below the final scanner's threshold, so only what the
    // guest received decides what returns, as a string or converted to a number.
    const sliced = await execute({
      code: 'async () => { const { data } = await connecta.call("remote.read"); return [String(data).slice(0, 7), Number(data)]; }',
    });
    expect(sliced.isError, JSON.stringify(sliced.structuredContent)).toBeFalsy();
    expect(sliced.structuredContent).toMatchObject({ result: [REDACTED.slice(0, 7), null] });
    vi.unstubAllGlobals();
  });

  it("INV-5: an array whose toJSON echoes a credential reaches the QuickJS guest only checked", async () => {
    const token = "Q8!wZ2?A7@vR4#";
    const connector: Connector = {
      id: "wire",
      kind: "api",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool(_name, _args, ctx) {
        sentSecretsFor(ctx).add(token);
        // Its entries are public; what serialization sends is the toJSON result.
        return Object.assign(["public"], { toJSON: () => ({ echo: token }) });
      },
    };
    const result = await createExecuteTool(
      makeRegistry([connector]),
      BASE,
      executor,
      silentLogger,
    )({ code: 'async () => (await connecta.call("wire.read")).data.echo.slice(0, 7)' });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ result: REDACTED.slice(0, 7) });
  });
});

describe("INV-5: a remote connection's credential under any header or query name", () => {
  const BASE = "https://connecta.test";
  const SECRET = "q7Zx4Lm9Tp2Vb8Nc5Rk3Wd6H";
  const INTERIOR = SECRET.slice(5, 17);
  let executor: AdmittingExecutor;

  beforeAll(() => {
    executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  });
  afterAll(async () => {
    await executor.close?.();
    vi.unstubAllGlobals();
  });

  const run = async (answer: string, connection: { url?: string; headers?: Record<string, string> }) => {
    const written: string[] = [];
    const downstream = httpDownstream(
      (server) => {
        server.registerTool(
          "read",
          { description: "Read a record", annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: answer }] }),
        );
        server.registerTool(
          "write",
          { description: "Write a record", inputSchema: z.object({ note: z.string() }) },
          async ({ note }) => {
            written.push(note);
            return { content: [{ type: "text", text: "saved" }] };
          },
        );
      },
      connection.url ? { url: connection.url } : {},
    );
    vi.stubGlobal("fetch", downstream.fetch);
    const execute = createExecuteTool(
      makeRegistry([
        remoteMcp("remote", {
          url: downstream.url,
          ...(connection.headers ? { auth: { type: "headers", headers: connection.headers } } : {}),
        }),
      ]),
      BASE,
      executor,
      silentLogger,
      undefined,
      { readOnly: false },
    );
    const result = await execute({
      code: `async () => {
        const read = (await connecta.call("remote.read")).data;
        const write = await connecta.call("remote.write", { note: ${JSON.stringify(`ref ${INTERIOR}`)} }).then(
          () => "sent",
          (error) => error.code,
        );
        return { read, write };
      }`,
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    return { out: result.structuredContent?.result as { read: string; write: string }, written };
  };

  it.each([["x-user"], ["x-api-id"], ["x-client-id"], ["x-auth-email"], ["x-account-login"], ["public-key"]])(
    "withholds a downstream answer holding interior characters of a %s header and refuses a write holding them",
    async (name) => {
      const { out, written } = await run(`row ${INTERIOR} end`, { headers: { [name]: SECRET } });
      expect(out.read).not.toContain(INTERIOR);
      expect(out.write).toBe("invalid_args");
      expect(written).toEqual([]);
    },
  );

  it("takes no public identifier declaration from a deployment", () => {
    expect(() =>
      remoteMcp("remote", {
        url: "https://downstream.test/mcp",
        publicIdentifierHeaders: ["x-user"],
      } as Parameters<typeof remoteMcp>[1]),
    ).toThrow(/publicIdentifierHeaders/);
  });

  it("withholds the unframed secret of a remote URL's scheme-framed query credential and refuses a write holding it", async () => {
    const { out, written } = await run(`row ${SECRET} end`, {
      url: `https://downstream.test/mcp?auth_user=Bearer%20${SECRET}`,
    });
    expect(out.read).not.toContain(SECRET);
    expect(out.write).toBe("invalid_args");
    expect(written).toEqual([]);
  });
});

describe("quickJsExecutor memory growth during a job pass", () => {
  vi.setConfig({ testTimeout: 60_000 });
  type Pool = AdmittingExecutor & {
    slots: { child?: { process: EventEmitter & { pid: number } }; active?: { id: number } }[];
  };
  const pool = (options: Parameters<typeof quickJsExecutor>[0] = {}) => {
    const created = quickJsExecutor({ cpuTimeMs: 5_000, ...options }) as unknown as Pool;
    onTestFinished(() => created.close?.());
    return created;
  };
  const childPid = (executor: Pool) => executor.slots[0]?.child?.process.pid;
  const GROW = `const grown = []; for (let i = 0; i < 30; i++) grown.push(new ArrayBuffer(1 << 20));`;
  const tool = (executor: Pool, value: unknown = "value") =>
    createExecuteTool(
      makeRegistry([
        {
          id: "store",
          kind: "api",
          listTools: async () => [
            { name: "fast", annotations: { readOnlyHint: true } },
            { name: "slow", annotations: { readOnlyHint: true } },
            { name: "get", annotations: { readOnlyHint: true } },
          ],
          async callTool(name: string) {
            if (name === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
            return name === "get" ? value : name;
          },
        },
      ]),
      "https://growth.test",
      executor,
      silentLogger,
      undefined,
      { maxHostCalls: 512 },
    );

  it("a run with an unawaited host call keeps its answer and its child takes the next request", async () => {
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());
    const executor = pool();
    const execute = tool(executor);
    await execute({ code: `async () => { await connecta.call("store.fast"); return "warm"; }` });
    const child = childPid(executor);
    expect(child).toBeTypeOf("number");
    const grew = await execute({
      code: `async () => { await connecta.call("store.fast"); connecta.call("store.slow"); ${GROW} return "answer"; }`,
    });
    expect(grew.structuredContent?.result, JSON.stringify(grew.structuredContent)).toBe("answer");
    for (let run = 0; run < 3; run++) {
      const next = await execute({ code: `async () => { await connecta.call("store.fast"); return ${run}; }` });
      expect(next.isError, JSON.stringify(next.structuredContent)).toBeUndefined();
      expect(next.structuredContent?.result).toBe(run);
    }
    expect(childPid(executor)).toBe(child);
    expect(warn).not.toHaveBeenCalled();
  });

  const fill = (make: () => unknown, bytes: number) => {
    const rows: unknown[] = [];
    let size = 2;
    const each = JSON.stringify(make()).length + 1;
    while (size < bytes) {
      rows.push(make());
      size += each;
    }
    return rows;
  };
  it.each([
    ["small objects", () => ({ a: 1 })],
    ["empty objects", () => ({})],
    ["integers", () => 1],
  ])("reading %s around 1.2 MB doesn't replace the child", async (_shape, make) => {
    const executor = pool();
    const execute = tool(executor, fill(make, 1.2 * 1024 * 1024));
    const read = await execute({
      code: `async () => {
        const handle = await connecta.call("store.get");
        const parts = [];
        let offset = 0, page;
        do {
          page = await connecta.result(handle, { offset, maxBytes: 32000 });
          parts.push(page.text);
          offset = page.nextOffset;
        } while (page.hasMore);
        return JSON.parse(parts.join("")).length > 1000;
      }`,
    });
    expect(read.structuredContent?.result, JSON.stringify(read.structuredContent)).toBe(true);
    const child = childPid(executor);
    const next = await execute({ code: `async () => "next"` });
    expect(next.structuredContent?.result, JSON.stringify(next.structuredContent)).toBe("next");
    expect(child).toBeTypeOf("number");
    expect(childPid(executor)).toBe(child);
  });

  // Fills the heap to the limit during a job pass, then gives back a little at each level.
  it.each([0, 4, 16, 64, 128, 200, 256])(
    "tears down cleanly with the heap filled and %i blocks given back",
    async (released) => {
      const executor = pool({ cpuTimeMs: 30_000 });
      const providers = [{ name: "h", fns: { noop: async () => "ok" } }];
      const outcome = await executor.execute(
        `async () => {
          await h.noop();
          globalThis.keep = [];
          for (const size of [1 << 20, 1 << 16, 1 << 12, 1 << 8]) {
            try { for (;;) keep.push(new ArrayBuffer(size)); } catch {}
          }
          for (let i = 0; i < ${released} && keep.length; i++) keep.pop();
          await h.noop();
          return "survived";
        }`,
        providers,
      );
      // With nothing given back the program itself may run out of heap, which is its own clean failure.
      if (released > 0) expect(outcome.result, String(outcome.error)).toBe("survived");
      expect(String(outcome.error)).not.toContain("Aborted");
      const child = childPid(executor);
      const next = await executor.execute(`async () => { await h.noop(); return "next"; }`, providers);
      expect(next.result).toBe("next");
      expect(child).toBeTypeOf("number");
      expect(childPid(executor)).toBe(child);
    },
  );

  it("a job that ends on the CPU budget after growing reports it and keeps the child", async () => {
    const executor = pool({ cpuTimeMs: 300 });
    const providers = [{ name: "h", fns: { noop: async () => "ok" } }];
    await executor.execute(`async () => "warm"`, providers);
    const child = childPid(executor);
    const outcome = await executor.execute(`async () => { await h.noop(); ${GROW} for (;;) {} }`, providers);
    expect(outcome.error).toContain("CPU budget");
    const next = await executor.execute(`async () => "next"`, providers);
    expect(next.result).toBe("next");
    expect(childPid(executor)).toBe(child);
  });

  it("a child reporting a failed free has its answer kept, a warning logged and is replaced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const executor = pool();
    let began!: () => void;
    const waiting = new Promise<void>((resolve) => (began = resolve));
    const running = executor.execute(`async () => await h.wait()`, [
      {
        name: "h",
        fns: {
          wait: () => {
            began();
            return new Promise(() => {});
          },
        },
      },
    ]);
    await waiting;
    const slot = executor.slots[0]!;
    const child = slot.child!.process;
    child.emit("message", {
      type: "result",
      jobId: slot.active!.id,
      payloadJson: JSON.stringify({ outcome: { result: "kept" }, retire: true }),
    });
    expect((await running).result).toBe("kept");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("replacing the child");
    expect(slot.child?.process).not.toBe(child);
  });
});
