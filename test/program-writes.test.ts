// Trust-tier program writes, with one attempt and bounded outcome accounting.
import { describe, expect, it } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { recordToolActivity } from "../src/activity.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { classifyWriteOutcome } from "../src/program-writes.js";
import { api } from "../src/connectors/api.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { createMetaTools } from "../src/meta-tools.js";
import { classifyTool, type PoolTrust } from "../src/tool-safety.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  Executor,
  ExecutorProvider,
  ToolDef,
} from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.program-writes";

type Guest = Record<string, (...args: unknown[]) => Promise<any>>;
type Program = (connecta: Guest) => Promise<unknown>;

/** Rebuild a typed guest error the way the trusted prelude does. */
function guestError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = "\u001econnecta-error:";
  if (!message.startsWith(prefix)) return error instanceof Error ? error : new Error(message);
  const rest = message.slice(prefix.length);
  const details = JSON.parse(rest.slice(rest.indexOf(":") + 1)) as {
    code: string;
    message: string;
  };
  return Object.assign(new Error(details.message), {
    code: details.code,
    details,
  });
}

/** Runs registered closures by program text, through the real provider. */
function scriptedExecutor(programs: Map<string, Program>): Executor {
  return {
    async execute(code: string, providers: ExecutorProvider[]) {
      const program = programs.get(code.trim());
      if (!program) return { result: undefined, error: `no program for ${code}` };
      const provider = required(providers[0]);
      const connecta = new Proxy({} as Guest, {
        get: (_target, name: string) => async (...args: unknown[]) => {
          try {
            return await required(provider.fns[name])(...args);
          } catch (error) {
            throw guestError(error);
          }
        },
      });
      try {
        return { result: await program(connecta) };
      } catch (error) {
        return {
          result: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

interface WorldOptions {
  trust?: PoolTrust;
  maxWrites?: number;
  write?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  read?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function world(options: WorldOptions = {}) {
  const calls: Array<{ address: string; args: Record<string, unknown> }> = [];
  const events: ToolCallActivityEvent[] = [];
  const count = (address: string, args: unknown) =>
    calls.push({ address, args: (args ?? {}) as Record<string, unknown> });
  const reader: Connector = {
    id: "reader",
    kind: "api",
    description: "Reads issues",
    async listTools() {
      const readOnly: Partial<ToolDef> = { annotations: { readOnlyHint: true } };
      return [{ name: "get", ...readOnly }];
    },
    async callTool(name, args) {
      count(`reader.${name}`, args);
      if (options.read) return await options.read(name, args as Record<string, unknown>);
      return { id: (args as { id?: number }).id, title: "An issue" };
    },
  };
  const tracker: Connector = {
    id: "tracker",
    kind: "api",
    description: "Writes issues",
    async listTools() {
      return [
        {
          name: "close_issue",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        { name: "post" },
      ];
    },
    async callTool(name, args) {
      count(`tracker.${name}`, args);
      if (options.write) return await options.write(name, args as Record<string, unknown>);
      return { ok: true };
    },
  };
  const registry = makeRegistry([reader, tracker], { storage: memoryStorage() });
  const activity: ActivityRequestContext = {
    recordTool: recordToolActivity,
    sink: { record: (event) => void events.push(event) },
    actor: { kind: "test" },
    requestId: "request",
    serverInfo: { name: "connecta-test", version: "0" },
    logger: silentLogger,
  };
  const programs = new Map<string, Program>();
  const execute = createExecuteTool(
    registry,
    BASE,
    scriptedExecutor(programs),
    silentLogger,
    activity,
    {
      trust: options.trust,
      ...(options.maxWrites !== undefined ? { maxWrites: options.maxWrites } : {}),
    },
  );
  let next = 0;
  return {
    registry,
    events,
    /** Register a closure and run the program text that names it. */
    run(program: Program) {
      const code = `async () => program${next++}`;
      programs.set(code, program);
      return execute({ code });
    },
    writes: () => calls.filter((call) => call.address.startsWith("tracker.")),
  };
}

function value(result: { structuredContent?: Record<string, unknown> }): Record<string, any> {
  return required(result.structuredContent, "structured result") as Record<string, any>;
}

const closeOne: Program = async (connecta) => {
  await connecta.call!("tracker.close_issue", { id: 1 });
  return "closed";
};

describe("a program's write", () => {
  it("INV-2: is refused before it is sent, pointing at call_destructive_tool", async () => {
    const w = world();
    const result = await w.run(closeOne);
    expect(result.isError).toBe(true);
    expect(value(result).error).toMatchObject({
      code: "destructive_tool_requires_approval",
      retryable: false,
      nextAction: {
        tool: "call_destructive_tool",
        arguments: { address: "tracker.close_issue", args: { id: 1 } },
      },
    });
    expect(w.writes()).toEqual([]);
    // An ordinary refused attempt, recorded payload-free with its friction.
    expect(w.events.map((event) => [event.address, event.outcome, event.errorCode, event.friction]))
      .toEqual([[
        "tracker.close_issue",
        "error",
        "destructive_tool_requires_approval",
        "destructive_reroute",
      ]]);
  });

  it("is refused for an unannotated tool too, and a caught refusal lets the program go on", async () => {
    const w = world();
    const result = await w.run(async (connecta) => {
      const issue = await connecta.call!("reader.get", { id: 7 });
      try {
        await connecta.call!("tracker.post", { text: issue.title });
        return "posted";
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(value(result).result).toBe("destructive_tool_requires_approval");
    expect(w.writes()).toEqual([]);
  });
});

describe("trusted-pool programs (#706)", () => {
  it("INV-2: runs a write in a trusted pool, recorded as an ordinary call", async () => {
    const w = world({ trust: "trusted" });
    expect(value(await w.run(closeOne)).result).toBe("closed");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
    expect(w.events.map((event) => [event.address, event.outcome, event.source]))
      .toEqual([["tracker.close_issue", "success", "execute_code"]]);
  });

  it("INV-2: permits every write in a trusted pool", async () => {
    const w = world({ trust: "trusted" });
    const done = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      try {
        await connecta.call!("tracker.post", { text: "x" });
        return "posted";
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(value(done).result).toBe("posted");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }, { address: "tracker.post", args: { text: "x" } }]);
  });

  it("spends the write budget", async () => {
    const w = world({ maxWrites: 1, trust: "trusted" });
    const done = await w.run(async (connecta) => {
      const outcomes = [];
      for (const id of [1, 2]) {
        try {
          await connecta.call!("tracker.close_issue", { id });
          outcomes.push("closed");
        } catch (error) {
          outcomes.push((error as { code: string }).code);
        }
      }
      return outcomes;
    });
    expect(value(done).result).toEqual(["closed", "budget_exceeded"]);
    expect(w.writes()).toHaveLength(1);
  });

  it("INV-9: lets an unawaited trusted-pool write finish, and says how it went", async () => {
    let writeStarted!: () => void;
    let dispatched = new Promise<void>((resolve) => { writeStarted = resolve; });
    const w = world({
      trust: "trusted",
      read: async () => {
        await dispatched;
        return { id: 9, title: "An issue" };
      },
      write: async (_name, args) => {
        writeStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (args.id === 2) throw new ConnectorCallError("timeout", "gateway timed out");
        return { ok: true };
      },
    });
    const fireAndReturn = (id: number): Program => async (connecta) => {
      connecta.call!("tracker.close_issue", { id }).catch(() => {});
      await connecta.call!("reader.get", { id: 9 });
      return "done";
    };
    // The write outlives the program, finishes, and is recorded as it ended.
    const done = await w.run(fireAndReturn(1));
    expect(value(done).result).toBe("done");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
    expect(w.events.filter((event) => event.address === "tracker.close_issue")
      .map((event) => event.outcome)).toEqual(["success"]);
    // One that turns unknown is the result, not a plain success.
    dispatched = new Promise<void>((resolve) => { writeStarted = resolve; });
    const unknown = await w.run(fireAndReturn(2));
    expect(unknown.isError).toBe(true);
    expect(value(unknown).error).toMatchObject({
      code: "write_outcome_unknown",
      writes: { succeeded: 0, failed: 0, unknown: 1 },
    });
    expect(w.writes()).toEqual([
      { address: "tracker.close_issue", args: { id: 1 } },
      { address: "tracker.close_issue", args: { id: 2 } },
    ]);
  });

  it.each([false, true])("drains a dispatched write on terminal host-budget exhaustion (unknown: %s)", async (unknown) => {
    let writeStarted!: () => void;
    const dispatched = new Promise<void>((resolve) => { writeStarted = resolve; });
    const w = world({
      trust: "trusted",
      read: async () => { await dispatched; return { id: 9 }; },
      write: async () => {
        writeStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (unknown) throw new ConnectorCallError("timeout", "gateway timed out");
        return { ok: true };
      },
    });
    const failed = await w.run(async (connecta) => {
      void connecta.call!("tracker.close_issue", { id: 1 }).catch(() => {});
      for (let i = 0; i < 213; i++) {
        try { await connecta.call!("reader.get", { id: 9 }); }
        catch { /* A budget refusal must never get here. */ }
      }
      return "must not be returned";
    });
    expect(failed.isError).toBe(true);
    expect(value(failed)).toMatchObject({
      error: {
        code: unknown ? "write_outcome_unknown" : "budget_exceeded",
        writes: { succeeded: unknown ? 0 : 1, failed: 0, unknown: unknown ? 1 : 0 },
      },
      hostCalls: {
        attempted: 21, admitted: 20,
        succeeded: unknown ? 19 : 20, failed: unknown ? 2 : 1,
      },
    });
    expect(w.writes()).toHaveLength(1);
    expect(value(failed)).not.toHaveProperty("result");
  });

  it("puts write counts on the error of a program that fails after writing", async () => {
    const w = world({ trust: "trusted" });
    const failed = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      throw new Error("the program gave up");
    });
    expect(failed.isError).toBe(true);
    expect(value(failed).error).toMatchObject({
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
  });

  it("INV-2: keeps writes out of call_tool even in trusted deployments", async () => {
    const w = world({ trust: "trusted" });
    const tools = createMetaTools(w.registry, BASE);
    const refused = await tools.callTool({ address: "tracker.close_issue", args: { id: 1 } });
    expect(refused.isError).toBe(true);
    expect(w.writes()).toEqual([]);
    const search = value(await tools.searchTools({ connector: "tracker", safety: "approvalRequired" }));
    expect(search.tools.every((tool: ToolDef) => tool.classification === "write")).toBe(true);
    expect(JSON.stringify(search)).not.toContain('"approval":"exempt"');
  });

  it("INV-11: rejects removed exemptions and unknown classification keys", () => {
    const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
    const notes = api("notes", { tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => [] }] });
    const construct = (options: unknown) => createConnecta({ connectors: [notes], executor, logger: "silent", ...options as object });
    expect(() => construct({ execute: { approval: { notes: "never" } } })).toThrow("ConnectaConfig.execute.approval");
    expect(() => construct({ classification: { nope: { read: "read" } } })).toThrow('unknown connector "nope"');
    expect(() => construct({ classification: { notes: { missing: "read" } } })).toThrow('has no tool "missing"');
    expect(() => construct({ classification: { notes: { read: "never" } } })).toThrow('must be "read" or "write"');
    expect(() => construct({ trust: "ask" })).toThrow('must be "trusted" or "read-only"');
    expect(() => construct({ pools: { named: { tools: ["notes"], trust: "ask" } } })).toThrow("ConnectaConfig.pools.named.trust");
    expect(() => construct({ connectors: [{ ...notes, approval: "never" }] })).toThrow("approval was removed");
  });

});

describe("write outcomes", () => {
  it("classifies a write's outcome by what is known", () => {
    const table: Array<[Parameters<typeof classifyWriteOutcome>[0], string]> = [
      [{ ok: true, dispatched: true }, "ok"],
      [{ ok: false, dispatched: false, error: { code: "timeout" } }, "failed"],
      [{ ok: false, dispatched: true, error: { code: "timeout" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "timeout" } }, "unknown"],
      [{ ok: false, dispatched: true, error: { code: "cancelled" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "unavailable" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "connector_call_failed" } }, "failed"],
      // A typed error after the request went out (an oversized body, a
      // refused redirect) is not an answer: the write may have landed.
      [{ ok: false, dispatched: true, answered: false, error: { code: "connector_call_failed" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "not_found" } }, "failed"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "invalid_args" } }, "failed"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "rate_limited" } }, "failed"],
      // A stale base is a verdict: the connector refused before changing anything.
      [{ ok: false, dispatched: true, answered: false, error: { code: "conflict" } }, "failed"],
      [{ ok: false, dispatched: true, error: { code: "result_processing_failed" } }, "ok"],
    ];
    for (const [outcome, expected] of table) {
      expect(classifyWriteOutcome(outcome), JSON.stringify(outcome)).toBe(expected);
    }
  });
});

describe("retired pause configuration (#672)", () => {
  const executor: Executor = { execute: async () => ({ result: null }) };

  it.each([
    ["resumableWrites", false],
    ["resumableWrites", true],
    ["pausedRunTtlSeconds", 1_800],
    ["pausedRunTtlSeconds", undefined],
  ])("refuses execute.%s = %s at construction, naming the removal", (key, setting) => {
    const construct = () =>
      (createConnecta as (config: unknown) => unknown)({
        connectors: [],
        executor: customExecutor(executor, { lifecycle: "self-managed" }),
        logger: "silent",
        execute: { [key]: setting },
      });
    expect(construct).toThrow(`ConnectaConfig.execute.${key}`);
    expect(construct).toThrow("#672");
    expect(construct).toThrow("call_destructive_tool");
  });

  it("lists no resume_execution and reports no resumableWrites on /health", async () => {
    const connecta = createConnecta({ connectors: [], executor: customExecutor(executor, { lifecycle: "self-managed" }), logger: "silent" });
    const listed = await readJsonRpc(await mcpRpc(connecta, "tools/list", {})) as {
      result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("resume_execution");
    expect(listed.result.tools.find((tool) => tool.name === "execute_code")?.annotations?.readOnlyHint)
      .toBe(true);
    const health = await (await connecta.fetch(new Request("http://localhost/health"))).json();
    expect(health).not.toHaveProperty("resumableWrites");
    await connecta.close();
  });
});


describe("classification and pool endpoints (#706)", () => {
  it("INV-1: classifies by overrides, provider review, then fail-closed annotations", () => {
    const raw: ToolDef = { name: "mixed", annotations: { readOnlyHint: true } };
    expect(classifyTool(raw, "write", { verdict: "read" })).toBe("write");
    expect(classifyTool(raw, "read", { verdict: "write", stale: true })).toBe("read");
    expect(classifyTool(raw, undefined, { verdict: "write" })).toBe("write");
    expect(classifyTool(raw, undefined, { verdict: "read", stale: true })).toBe("write");
    expect(classifyTool({ name: "silent" }, undefined, { verdict: "read" })).toBe("read");
    for (const annotations of [undefined, {}, { readOnlyHint: false }, { readOnlyHint: true, destructiveHint: true }]) {
      expect(classifyTool({ name: "unknown", ...(annotations ? { annotations } : {}) })).toBe("write");
    }
    expect(classifyTool(raw)).toBe("read");
  });

  it("INV-1 INV-3: publishes isolated verdicts without persisting or trusting a downstream verdict", async () => {
    const storage = memoryStorage();
    const raw: ToolDef[] = [
      { name: "mislabeled", annotations: { readOnlyHint: true } },
      { name: "mixed", annotations: { readOnlyHint: false } },
      { name: "constructor", classification: "read" },
    ];
    const connector: Connector = { id: "test", listTools: async () => raw, callTool: async () => ({ ok: true }) };
    const overrides = { test: { mislabeled: "write" as const, mixed: "read" as const } };
    const registry = makeRegistry([connector], { storage, classification: overrides });
    overrides.test.mixed = "write" as never;
    const first = await registry.getTools("test", BASE, {});
    expect(first.map(tool => tool.classification)).toEqual(["write", "read", "write"]);
    first[0]!.classification = "read";
    first[1]!.annotations!.readOnlyHint = false;
    raw[0]!.annotations!.readOnlyHint = false;
    const second = await registry.getTools("test", BASE, {});
    expect(second.map(tool => tool.classification)).toEqual(["write", "read", "write"]);
    expect(second[1]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const key of await storage.list("")) {
      expect(await storage.get(key)).not.toContain('"classification"');
    }
    const tools = createMetaTools(registry, BASE);
    expect((await tools.callTool({ address: "test.mislabeled" })).isError).toBe(true);
    expect((await tools.callTool({ address: "test.mixed" })).isError).toBeFalsy();
    expect((await tools.callDestructiveTool({ address: "test.mislabeled" })).isError).toBeFalsy();
  });

  it("INV-1: deployment overrides beat stale reviewed schemas and provider writes", async () => {
    const raw: ToolDef[] = [
      { name: "lapsed", annotations: { readOnlyHint: true } },
      { name: "mislabeled", annotations: { readOnlyHint: true } },
      { name: "mixed" },
      { name: "constructor" },
    ];
    const connector: Connector = {
      id: "reviewed", listTools: async () => raw, callTool: async () => null,
      classification: { tools: {
        lapsed: { verdict: "read", schemaDigest: `sha256:${"0".repeat(64)}` },
        mislabeled: "write", mixed: "write",
      } },
    };
    const registry = makeRegistry([connector], { classification: {
      reviewed: { lapsed: "read", mixed: "read", constructor: "read" as const },
    } });
    const tools = await registry.getTools("reviewed", BASE, {});
    expect(tools.map(tool => tool.classification)).toEqual(["read", "write", "read", "read"]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const without = makeRegistry([connector]);
    expect((await without.getTools("reviewed", BASE, {})).map(tool => tool.classification))
      .toEqual(["write", "write", "write", "write"]);
  });

  it("INV-11 INV-8: refuses an entire remote catalog with an unknown override", async () => {
    const connector: Connector = { id: "remote", listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }], callTool: async () => null };
    const registry = makeRegistry([connector], { classification: { remote: { missing: "read" } } });
    await expect(registry.getTools("remote", BASE, {})).rejects.toThrow('has no tool "missing"');
    await expect(registry.getTools("remote", BASE, {})).rejects.toThrow('has no tool "missing"');
  });

  it("INV-2 INV-4 INV-9: endpoint trust controls writes and execute_code annotations", async () => {
    let writes = 0;
    const programs = new Map<string, Program>([["async () => write", async connecta => {
      await connecta.call!("notes.write", {});
      return "written";
    }]]);
    const notes = api("notes", { tools: [
      { name: "write", description: "Write", annotations: { readOnlyHint: false }, handler: () => { writes++; return "written"; } },
    ] });
    const app = createConnecta({ connectors: [notes], logger: "silent", executor: customExecutor(scriptedExecutor(programs), { lifecycle: "self-managed" }),
      pools: {
        trusted: { tools: ["notes"], trust: "trusted", grant: () => true },
        readonly: { tools: ["notes"], grant: () => true },
      },
    });
    const rpc = async (path: string, method: string, params: unknown) => readJsonRpc(await app.fetch(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }))) as Promise<any>;
    try {
      for (const path of ["/mcp", "/mcp/readonly", "/mcp/trusted"]) {
        const trusted = path === "/mcp/trusted";
        const listing = await rpc(path, "tools/list", {});
        expect(listing.result.tools.find((tool: { name: string }) => tool.name === "execute_code").annotations)
          .toMatchObject({ readOnlyHint: !trusted, destructiveHint: trusted });
        const run = await rpc(path, "tools/call", { name: "execute_code", arguments: { code: "async () => write" } });
        expect(run.result.isError === true).toBe(!trusted);
        const direct = await rpc(path, "tools/call", { name: "call_tool", arguments: { address: "notes.write" } });
        expect(direct.result.isError).toBe(true);
      }
      expect(writes).toBe(1);
      const direct = await rpc("/mcp/readonly", "tools/call", { name: "call_destructive_tool", arguments: { address: "notes.write" } });
      expect(direct.result.isError).toBeFalsy();
      expect(writes).toBe(2);
      expect(app.describeConfig()).toMatchObject({ trust: "read-only", pools: [
        { name: "trusted", trust: "trusted" }, { name: "readonly", trust: "read-only" },
      ] });
    } finally { await app.close(); }
  });
});

it("INV-6 INV-9: caught write timeouts retain uncertain arguments in host-owned write accounting", async () => {
  const w = world({ trust: "trusted", write: async () => { throw new ConnectorCallError("timeout", "deadline"); } });
  const result = await w.run(async (connecta) => {
    try { await connecta.call!("tracker.close_issue", { id: 42, note: "argument-sentinel" }); }
    catch { return "handled"; }
    return "unreachable";
  });
  expect(value(result).error).toMatchObject({
    code: "write_outcome_unknown", retryable: false,
    uncertainCall: { address: "tracker.close_issue", args: { id: 42, note: "argument-sentinel" } },
  });
  expect(w.writes()).toHaveLength(1);
  expect(JSON.stringify(w.events)).not.toContain("argument-sentinel");
});
