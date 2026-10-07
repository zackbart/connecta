// Writes inside execute_code (#566, #672): a program runs explicitly
// read-only tools and the writes config exempts from approval, and refuses
// every other write before it is sent. The host's prompt on
// call_destructive_tool is the only approval there is.
//
// Programs here are JavaScript closures run by a scripted executor, not
// source strings: workerd forbids eval, and this suite runs in both projects.
// The guest-contract arms cover the real QuickJS and Dynamic Worker sandboxes.

import { describe, expect, it } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { recordToolActivity } from "../src/activity.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { classifyWriteOutcome } from "../src/exempt-writes.js";
import { api } from "../src/connectors/api.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { createMetaTools } from "../src/meta-tools.js";
import {
  isApprovalExempt,
  NO_EXEMPTIONS,
  type ApprovalPolicy,
} from "../src/tool-safety.js";
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
  approval?: ApprovalPolicy;
  maxWrites?: number;
  /** The tracker connector's own approval default. */
  trackerApproval?: "never";
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
      if (options.read) return options.read(name, args as Record<string, unknown>);
      return { id: (args as { id?: number }).id, title: "An issue" };
    },
  };
  const tracker: Connector = {
    id: "tracker",
    kind: "api",
    description: "Writes issues",
    ...(options.trackerApproval ? { approval: options.trackerApproval } : {}),
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
      if (options.write) return options.write(name, args as Record<string, unknown>);
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
      approval: options.approval,
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

const policy = (
  tools: Record<string, "never" | "ask"> = {},
  connectors: Record<string, "never" | "ask"> = {},
): ApprovalPolicy => ({
  tools: new Map(Object.entries(tools)),
  connectors: new Map(Object.entries(connectors)),
});

const closeOne: Program = async (connecta) => {
  await connecta.call!("tracker.close_issue", { id: 1 });
  return "closed";
};

describe("a program's write", () => {
  it("is refused before it is sent, pointing at call_destructive_tool", async () => {
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

describe("config approval exemptions (#566)", () => {
  it("runs an exempt write, recorded as an ordinary call", async () => {
    const w = world({ approval: policy({ "tracker.close_issue": "never" }) });
    expect(value(await w.run(closeOne)).result).toBe("closed");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
    expect(w.events.map((event) => [event.address, event.outcome, event.source]))
      .toEqual([["tracker.close_issue", "success", "execute_code"]]);
  });

  it("covers only the exempt tool: every other write keeps E4", async () => {
    const w = world({ approval: policy({ "tracker.close_issue": "never" }) });
    const done = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      try {
        await connecta.call!("tracker.post", { text: "x" });
        return "posted";
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(value(done).result).toBe("destructive_tool_requires_approval");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
  });

  it("spends the write budget", async () => {
    const w = world({ maxWrites: 1, approval: policy({}, { tracker: "never" }) });
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

  it("honors a connector's own default and lets config switch it off", async () => {
    const byDefault = world({ trackerApproval: "never" });
    expect(value(await byDefault.run(closeOne)).result).toBe("closed");

    const refused = (result: { structuredContent?: Record<string, unknown> }) =>
      value(result).error?.code;
    const switchedOff = world({
      trackerApproval: "never",
      approval: policy({}, { tracker: "ask" }),
    });
    expect(refused(await switchedOff.run(closeOne))).toBe("destructive_tool_requires_approval");

    // The address beats the connector entry, both ways.
    const narrowed = world({
      approval: policy({ "tracker.close_issue": "ask" }, { tracker: "never" }),
    });
    expect(refused(await narrowed.run(closeOne))).toBe("destructive_tool_requires_approval");
    const widened = world({
      approval: policy({ "tracker.close_issue": "never" }, { tracker: "ask" }),
    });
    expect(value(await widened.run(closeOne)).result).toBe("closed");
  });

  it("lets an unawaited exempt write finish, and says how it went", async () => {
    let writeStarted!: () => void;
    let dispatched = new Promise<void>((resolve) => { writeStarted = resolve; });
    const w = world({
      approval: policy({ "tracker.close_issue": "never" }),
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
  });

  it.each([false, true])("drains a dispatched write on terminal host-budget exhaustion (unknown: %s)", async (unknown) => {
    let writeStarted!: () => void;
    const dispatched = new Promise<void>((resolve) => { writeStarted = resolve; });
    const w = world({
      approval: policy({ "tracker.close_issue": "never" }),
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
    const w = world({ approval: policy({ "tracker.close_issue": "never" }) });
    const failed = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      throw new Error("the program gave up");
    });
    expect(failed.isError).toBe(true);
    expect(value(failed).error).toMatchObject({
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
  });

  it("never exempts a read-only tool or reads an annotation as an exemption", () => {
    const every = policy({}, { reader: "never" });
    const connector = { id: "reader" };
    expect(isApprovalExempt(every, connector, "get", {
      name: "get",
      annotations: { readOnlyHint: true },
    })).toBe(false);
    // A downstream cannot annotate its way out of approval.
    expect(isApprovalExempt(NO_EXEMPTIONS, connector, "wipe", {
      name: "wipe",
      annotations: { readOnlyHint: false, approval: "never" } as never,
    })).toBe(false);
    expect(isApprovalExempt(every, connector, "wipe", { name: "wipe" })).toBe(true);
  });

  it("keeps an exempt tool approval-required everywhere else", async () => {
    const approval = policy({ "tracker.close_issue": "never" });
    const w = world({ approval });
    const tools = createMetaTools(w.registry, BASE, { approval });
    const direct = await tools.callTool({
      address: "tracker.close_issue",
      args: { id: 1 },
      resultMode: "value",
    });
    expect(direct.isError).toBe(true);
    expect(JSON.stringify(direct.structuredContent)).toContain(
      "destructive_tool_requires_approval",
    );
    expect(w.writes()).toEqual([]);

    const search = async (safety: "readOnly" | "approvalRequired") =>
      value(await tools.searchTools({ connector: "tracker", query: "", safety }));
    const approvalRequired = (await search("approvalRequired")).connectors[0].tools as Array<{
      address: string;
      approval?: string;
    }>;
    expect(approvalRequired.find((tool) => tool.address === "tracker.close_issue")?.approval)
      .toBe("exempt");
    expect(approvalRequired.find((tool) => tool.address === "tracker.post")?.approval)
      .toBeUndefined();
    expect((await search("readOnly")).connectors).toEqual([]);

    // A program sees the same marker.
    const found = await w.run(async (connecta) => {
      const page = await connecta.search!({ connector: "tracker", query: "close" });
      const described = await connecta.describe!({ address: "tracker.close_issue" });
      return {
        searched: page.tools.find((tool: { address: string }) => tool.address === "tracker.close_issue")?.approval,
        described: described.tools[0].approval,
      };
    });
    expect(value(found).result).toEqual({ searched: "exempt", described: "exempt" });
  });

  it("validates exemptions at construction, like pools", () => {
    const executor: Executor = { execute: async () => ({ result: null }) };
    const notes = api("notes", {
      tools: [
        {
          name: "add",
          description: "Add a note",
          annotations: { readOnlyHint: false },
          handler: () => ({}),
        },
        {
          name: "list",
          description: "List notes",
          annotations: { readOnlyHint: true },
          handler: () => [],
        },
      ],
    });
    const remote: Connector = {
      id: "remote",
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    };
    const construct = (approval: unknown, connectors: Connector[] = [notes, remote]) =>
      createConnecta({
        connectors,
        executor: customExecutor(executor, { lifecycle: "self-managed" }),
        logger: "silent",
        execute: { approval: approval as Record<string, "never" | "ask"> },
      });
    expect(() => construct({ notes: "never", "notes.add": "ask", "remote.anything": "never" }))
      .not.toThrow();
    expect(() => construct({ nope: "never" })).toThrow(/unknown connector "nope"/);
    expect(() => construct({ "nope.add": "never" })).toThrow(/unknown connector "nope"/);
    expect(() => construct({ "notes.missing": "never" })).toThrow(
      /connector "notes" has no tool "missing"/,
    );
    expect(() => construct({ notes: "always" })).toThrow(/must be "never" or "ask"/);
    expect(() => construct({ "notes.": "never" })).toThrow(/connector ids or connector.tool addresses/);
    expect(() => construct(["notes"])).toThrow(/must be an object/);
    expect(() =>
      construct(undefined, [{ ...remote, approval: "always" as never }]),
    ).toThrow(/approval must be "never" or omitted/);
  });
});

describe("write outcomes", () => {
  it("classifies an exempt write's outcome by what is known", () => {
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
