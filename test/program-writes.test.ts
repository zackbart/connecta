import { guestError, guestErrorText, guestFailureFacts, guestSource } from "./fixtures/misc.js";
// Focused program accounting/drain and classification-drift fault probes.
// HTTP policy, private payloads and one-send recovery live in identity-write-journey.node.test.ts.
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { recordToolActivity } from "../src/activity.js";
import { routeDescription, routeNames } from "../src/agent-routes.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { CompletedCalls, type OwnEntry, type SealOperations } from "../src/program-completed.js";
import type { ResolvedCatalogTool } from "../src/catalog-service.js";
import { createConnecta, customExecutor } from "../src/index.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { delegatesEachCall, knownProviderFailure } from "../src/provider-call.js";
import { writeStateOf } from "../src/program-writes.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Executor, ExecutorProvider, ToolDef } from "../src/types.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.program-writes";

type Guest = Record<string, (...args: unknown[]) => Promise<any>>;
type Program = (connecta: Guest) => Promise<unknown>;

function scriptedExecutor(programs: Map<string, Program>): Executor {
  return {
    async execute(code: string, providers: ExecutorProvider[]) {
      const program = programs.get(guestSource(code));
      if (!program) return { result: undefined, error: `no program for ${code}` };
      const provider = required(providers[0]);
      const connecta = new Proxy({} as Guest, {
        get:
          (_target, name: string) =>
          async (...args: unknown[]) => {
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
          error: guestErrorText(error),
          failure: guestFailureFacts(error),
        };
      }
    },
  };
}

interface WorldOptions {
  readOnly?: boolean;
  /** The tracker stands for a boundary, so its own refusal marks hold (round 13). */
  provesRefusals?: boolean;
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
  if (options.provesRefusals) delegatesEachCall(tracker);
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
  const execute = createExecuteTool(registry, BASE, scriptedExecutor(programs), silentLogger, activity, {
    readOnly: options.readOnly,
  });
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

describe("writable-endpoint programs (#706, #820)", () => {
  it.each([
    { code: "rate_limited", extra: { retryAfterMs: 5_000 } },
    { code: "timeout", extra: {} },
    { code: "unavailable", extra: {} },
  ] as const)("INV-9: a program a retryable $code ends after a successful write is not retryable", async (failure) => {
    const w = world({
      readOnly: false,
      read: () => {
        throw new ConnectorCallError(failure.code, "Read failed", failure.extra);
      },
    });
    const result = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      await connecta.call!("reader.get", {});
    });
    const { error } = value(result);
    expect(error).toMatchObject({ retryable: false, writes: { succeeded: 1, failed: 0, unknown: 0 } });
    expect(error).not.toHaveProperty("retryAfterMs");
    expect(error.note).toContain("would repeat them");
    expect(w.writes()).toHaveLength(1);
  });

  it("INV-9: a write that is proven not applied leaves a program's own retry verdict standing", async () => {
    const w = world({
      readOnly: false,
      provesRefusals: true,
      write: () => {
        throw knownProviderFailure(new ConnectorCallError("invalid_args", "Write refused"));
      },
      read: () => {
        throw new ConnectorCallError("rate_limited", "Read failed", { retryAfterMs: 5_000 });
      },
    });
    const result = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 }).catch(() => {});
      await connecta.call!("reader.get", {});
    });
    const { error } = value(result);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 5_000,
      writes: { succeeded: 0, failed: 1, unknown: 0 },
    });
    expect(error.note).toContain("none applied");
  });

  it.each(["succeeded", "failed", "unknown"] as const)(
    "INV-9: program failures retain %s write accounting after caught host failures",
    async (state) => {
      const w = world({
        readOnly: false,
        provesRefusals: true,
        read: () => {
          throw new ConnectorCallError("not_found", "Read refused");
        },
        write: () => {
          // A refusal the connector proved: an error code alone is no evidence.
          if (state === "failed") throw knownProviderFailure(new ConnectorCallError("invalid_args", "Write refused"));
          if (state === "unknown") throw new ConnectorCallError("timeout", "No write response");
          return { ok: true };
        },
      });
      const result = await w.run(async (connecta) => {
        // A guest catching host failures still owns every write it dispatched.
        try {
          await connecta.call!("reader.get", {});
        } catch {}
        try {
          await connecta.call!("tracker.close_issue", { id: 1 });
        } catch {}
        throw new Error("Guest failed after catching host failures");
      });
      expect(result.isError).toBe(true);
      expect(value(result)).toMatchObject({
        error: {
          code: state === "unknown" ? "write_outcome_unknown" : "program_error",
          writes: {
            succeeded: state === "succeeded" ? 1 : 0,
            failed: state === "failed" ? 1 : 0,
            unknown: state === "unknown" ? 1 : 0,
          },
        },
        hostCalls: {
          attempted: 2,
          admitted: 2,
          succeeded: state === "succeeded" ? 1 : 0,
          failed: state === "succeeded" ? 1 : 2,
        },
      });
      expect(w.writes()).toHaveLength(1);
      expect(value(result)).not.toHaveProperty("result");
    },
  );

  it("INV-9: lets an unawaited program write finish, and says how it went", async () => {
    let writeStarted!: () => void;
    let dispatched = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const w = world({
      readOnly: false,
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
    const fireAndReturn =
      (id: number): Program =>
      async (connecta) => {
        connecta.call!("tracker.close_issue", { id }).catch(() => {});
        await connecta.call!("reader.get", { id: 9 });
        return "done";
      };
    // The write outlives the program, finishes, and is recorded as it ended.
    const done = await w.run(fireAndReturn(1));
    expect(value(done).result).toBe("done");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
    expect(w.events.filter((event) => event.address === "tracker.close_issue").map((event) => event.outcome)).toEqual([
      "success",
    ]);
    // One that turns unknown is the result, not a plain success.
    dispatched = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
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

  it.each([false, true])(
    "drains a dispatched write on terminal host-budget exhaustion (unknown: %s)",
    async (unknown) => {
      let writeStarted!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        writeStarted = resolve;
      });
      const w = world({
        readOnly: false,
        read: async () => {
          await dispatched;
          return { id: 9 };
        },
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
          try {
            await connecta.call!("reader.get", { id: 9 });
          } catch {
            /* A budget refusal must never get here. */
          }
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
          attempted: 21,
          admitted: 20,
          succeeded: unknown ? 19 : 20,
          failed: unknown ? 2 : 1,
        },
      });
      expect(w.writes()).toHaveLength(1);
      expect(value(failed)).not.toHaveProperty("result");
    },
  );

  it("INV-11: rejects unknown classification keys and malformed readOnly settings", () => {
    const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
    const notes = api("notes", {
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => [] }],
    });
    const construct = (options: unknown) =>
      createConnecta({ readOnly: false, connectors: [notes], executor, logger: "silent", ...(options as object) });
    expect(() => construct({ classification: { nope: { read: "read" } } })).toThrow('unknown connector "nope"');
    expect(() => construct({ classification: { notes: { missing: "read" } } })).toThrow('has no tool "missing"');
    expect(() => construct({ classification: { notes: { read: "never" } } })).toThrow(
      'must be "read", "write", or "hidden"',
    );
    expect(() => construct({ readOnly: "yes" })).toThrow("ConnectaConfig.readOnly must be true or false");
    expect(() => construct({ pools: { named: { tools: ["notes"], readOnly: 1 } } })).toThrow(
      "ConnectaConfig.pools.named.readOnly must be true or false",
    );
    expect(() => construct({ connectors: [{ ...notes, approval: "never" }] })).toThrow("approval was removed");
  });
});

describe("classification and pool endpoints (#706)", () => {
  it("INV-9: accounts a write overridden to read on every surface, routed descriptions included", async () => {
    // A declared description makes each non-meta surface route its own copy of the tool.
    const note = routeDescription((phrases) => `What to save, ${phrases.forDirect}.`);
    const accounted: Record<string, unknown> = {};
    for (const surface of ["meta", "native-code", "code"] as const) {
      const connector = api("notes", {
        tools: [
          {
            name: "update",
            description: "Update a note",
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema: { type: "object", properties: { text: { type: "string", description: note } } },
            handler: async () => ({ ok: true }),
          },
        ],
      });
      const registry = makeRegistry([connector], { classification: { notes: { update: "read" } } });
      const programs = new Map<string, Program>();
      const code = "async () => program";
      programs.set(code, async (connecta) => {
        await connecta.call!("notes.update", { text: "x" });
        throw new Error("Guest failed after its write succeeded");
      });
      const execute = createExecuteTool(registry, BASE, scriptedExecutor(programs), silentLogger, undefined, {
        readOnly: false,
        routes: routeNames(surface),
      });
      const error = value(await execute({ code })).error;
      accounted[surface] = { writes: error.writes, warned: JSON.stringify(error).includes("are not undone") };
    }
    for (const surface of ["meta", "native-code", "code"])
      expect(accounted[surface], surface).toEqual({ writes: { succeeded: 1, failed: 0, unknown: 0 }, warned: true });
  });

  it("INV-2 INV-4: hidden tools disappear from discovery and refuse guessed calls on every surface", async () => {
    for (const [staticCatalog, reviewed, readOnly] of [
      [true, false, false],
      [false, false, false],
      [false, true, false],
      [false, false, true],
    ]) {
      const calls: string[] = [];
      const raw = ["visible", "hidden"].map((name) => ({ name, annotations: { readOnlyHint: true } }));
      const connector: Connector = {
        id: "notes",
        ...(staticCatalog ? { staticTools: raw } : {}),
        ...(reviewed ? { classification: { tools: { visible: "read", hidden: "read" } } as const } : {}),
        listTools: async () => raw,
        callTool: async (name) => {
          calls.push(name);
          return {};
        },
      };
      const registry = makeRegistry([connector], { classification: { notes: { hidden: "hidden" } } });
      const catalog = new CatalogService(registry, BASE, { readOnly });
      expect((await catalog.search({})).entries.map((entry) => entry.tool.name)).toEqual(["visible"]);
      expect(await catalog.describe({ address: "notes.hidden", format: "json" })).toMatchObject([
        { errorDetails: { code: "unknown_tool" } },
      ]);
      const tools = createMetaTools(registry, BASE, { readOnly });
      for (const call of [tools.callTool, tools.callDestructiveTool]) {
        const refused = await call({ address: "notes.hidden", args: { classification: { hidden: "read" } } });
        expect(refused.isError).toBe(true);
      }
      const service = new InvocationService(registry, catalog);
      expect((await service.invoke("notes.hidden", {}, { source: "execute_code", readOnly })).ok).toBe(false);
      expect(calls).toEqual([]);
      expect(raw.map((tool) => tool.name)).toEqual(["visible", "hidden"]);
    }
  });

  it("INV-1 INV-11: absent runtime overrides stay dormant and apply on return; static typos fail construction", async () => {
    for (const verdict of ["read", "write", "hidden"] as const) {
      let present = false;
      const raw = { name: "returning", annotations: { readOnlyHint: true } };
      const logger = { ...silentLogger, warn: vi.fn() };
      const connector: Connector = {
        id: "notes",
        listTools: async () => (present ? [raw] : []),
        callTool: async () => null,
      };
      const classification = { notes: { returning: verdict } };
      expect(() => makeRegistry([{ ...connector, staticTools: [] }], { classification })).toThrow(
        'has no tool "returning"',
      );
      const registry = makeRegistry([connector], { classification, logger });
      expect(await registry.getTools("notes", BASE, {})).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"notes.returning" is dormant'));
      await registry.getTools("notes", BASE, {});
      expect(logger.warn.mock.calls.filter(([message]) => message.includes("is dormant"))).toHaveLength(1);
      present = true;
      const tools = await registry.getTools("notes", BASE, {});
      expect(tools.map((tool) => tool.classification)).toEqual(verdict === "hidden" ? [] : [verdict]);
      present = false;
      await registry.getTools("notes", BASE, {});
      await registry.getTools("notes", BASE, {});
      expect(logger.warn.mock.calls.filter(([message]) => message.includes("is dormant"))).toHaveLength(2);
    }
  });

  it("INV-1 INV-3: publishes isolated verdicts without persisting or trusting a downstream verdict", async () => {
    const storage = memoryStorage();
    const hintCases: [ToolDef["annotations"], "read" | "write"][] = [
      [undefined, "write"],
      [{ readOnlyHint: false }, "write"],
      [{ destructiveHint: false }, "write"],
      [{ readOnlyHint: true }, "read"],
      [{ readOnlyHint: true, destructiveHint: false }, "read"],
      [{ readOnlyHint: true, destructiveHint: true }, "write"],
    ];
    const raw: ToolDef[] = [
      { name: "mislabeled", annotations: { readOnlyHint: true } },
      { name: "mixed", annotations: { readOnlyHint: false } },
      { name: "constructor", classification: "read" },
      ...hintCases.map(([annotations], index) => ({ name: `hint_${index}`, ...(annotations ? { annotations } : {}) })),
    ];
    const connector: Connector = { id: "test", listTools: async () => raw, callTool: async () => ({ ok: true }) };
    const overrides = { test: { mislabeled: "write" as const, mixed: "read" as const } };
    const registry = makeRegistry([connector], { storage, classification: overrides });
    overrides.test.mixed = "write" as never;
    const first = await registry.getTools("test", BASE, {});
    const expected = ["write", "read", "write", ...hintCases.map(([, verdict]) => verdict)];
    expect(first.map((tool) => tool.classification)).toEqual(expected);
    first[0]!.classification = "read";
    first[1]!.annotations!.readOnlyHint = false;
    raw[0]!.annotations!.readOnlyHint = false;
    const second = await registry.getTools("test", BASE, {});
    expect(second.map((tool) => tool.classification)).toEqual(expected);
    expect(second[1]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const key of await storage.list("")) {
      expect(await storage.get(key)).not.toContain('"classification"');
    }
    const tools = createMetaTools(registry, BASE);
    expect((await tools.callTool({ address: "test.mislabeled" })).isError).toBe(true);
    expect((await tools.callTool({ address: "test.mixed" })).isError).toBeFalsy();
    expect((await tools.callDestructiveTool({ address: "test.mislabeled" })).isError).toBeFalsy();
  });
});

it("INV-11: requires every deployment to choose readOnly, while pools inherit it", () => {
  const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
  for (const config of [
    {},
    { readOnly: undefined },
    { pools: { named: { tools: [], members: [{ namespace: "people", id: "alice" }], readOnly: true } } },
  ]) {
    const construct = () =>
      (createConnecta as (config: unknown) => unknown)({ connectors: [], executor, logger: "silent", ...config });
    expect(construct).toThrow("ConnectaConfig.readOnly is required");
    expect(construct).toThrow("Choose readOnly: true");
    expect(construct).toThrow("or readOnly: false");
  }
});

describe("CompletedCalls", () => {
  const KIB = 1024;
  const tool = (name: string, annotations: ToolDef["annotations"]) =>
    ({
      connector: { id: "books" },
      toolName: name,
      definition: {
        name,
        annotations,
        classification: annotations?.readOnlyHint === true ? "read" : "write",
      },
    }) as unknown as ResolvedCatalogTool;
  const read = tool("read", { readOnlyHint: true });
  const write = tool("write", { readOnlyHint: false });
  const add = (calls: CompletedCalls, target: ResolvedCatalogTool, kib: number) =>
    calls.record(target, "x".repeat(kib * KIB - 2), "text", kib * KIB);
  interface Report {
    resultId?: string;
    calls: { address: string; dropped?: true; resultId?: string }[];
    callsOmitted?: number;
    note: string;
  }
  const kept = async (calls: CompletedCalls, reseal: SealOperations["reseal"] = () => Effect.succeed(undefined)) => {
    const closed = required(calls.close());
    let stashed: { calls: unknown[] } | undefined;
    await Effect.runPromise(
      closed.seal({
        stash: (outputs) => {
          stashed = outputs as { calls: unknown[] };
          return Effect.succeed("id");
        },
        reseal,
      }),
    );
    return { stashed, report: closed.report() as Report };
  };
  const handle = (resultId: string, valueFormat = "json") => ({ format: "paged", valueFormat, resultId });

  it("R9: drops the oldest reads first and never a write before a read", async () => {
    const calls = new CompletedCalls();
    add(calls, write, 200);
    add(calls, read, 300);
    add(calls, read, 300);
    add(calls, write, 400);
    const { report } = await kept(calls);
    expect(report.calls.map(({ dropped }) => dropped === true)).toEqual([false, true, false, false]);
  });

  it("R9: a read that cannot fit beside writes gives way, and writes evict the oldest write last", async () => {
    const reads = new CompletedCalls();
    add(reads, write, 600);
    add(reads, write, 400);
    add(reads, read, 100);
    expect((await kept(reads)).report.calls.map(({ dropped }) => dropped === true)).toEqual([false, false, true]);
    const writes = new CompletedCalls();
    add(writes, write, 600);
    add(writes, read, 200);
    add(writes, write, 500);
    add(writes, write, 500);
    expect((await kept(writes)).report.calls.map(({ dropped }) => dropped === true)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("R9: an output over the limit displaces nothing and is never serialized", async () => {
    const calls = new CompletedCalls();
    add(calls, read, 100);
    const toJSON = vi.fn(() => "never");
    calls.record(write, { toJSON }, "json", 1024 * KIB + 1);
    expect(toJSON).not.toHaveBeenCalled();
    const { stashed, report } = await kept(calls);
    expect(report.calls.map(({ dropped }) => dropped === true)).toEqual([false, true]);
    expect(stashed?.calls).toHaveLength(1);
  });

  it("R9: charges an output's retained JSON, however small its raw measure", async () => {
    const calls = new CompletedCalls();
    add(calls, read, 1);
    // 180 KiB raw is 1080 KiB once escaped, so it fits nowhere and displaces nothing.
    calls.record(read, "\0".repeat(180 * KIB), "text", 180 * KIB);
    const charged = new CompletedCalls();
    // 200 KiB raw and over 1 MiB held: a charge of the raw size would keep all five.
    for (let i = 0; i < 5; i++) charged.record(read, "\0".repeat(40 * KIB), "text", 40 * KIB);
    const multibyte = new CompletedCalls();
    // UTF-8 bytes, not string length: 1080 KiB in 360 KiB of code units.
    for (let i = 0; i < 2; i++) multibyte.record(read, "\u20ac".repeat(180 * KIB), "text", 540 * KIB);
    const retained = async (ledger: CompletedCalls) =>
      (await kept(ledger)).report.calls.map(({ dropped }) => dropped !== true);
    expect(await retained(calls)).toEqual([true, false]);
    expect(await retained(charged)).toEqual([false, true, true, true, true]);
    expect(await retained(multibyte)).toEqual([false, true]);
  });

  it("INV-5: publishes an output's own entry only through what sealing answered", async () => {
    const stored = new CompletedCalls();
    const reseal = vi.fn((entry: OwnEntry) =>
      entry.id === "pending" ? Effect.fail(new Error("storage")) : Effect.succeed(`sealed-${entry.id}`),
    );
    stored.presented(stored.record(read, "r", "text", 3), handle("read-entry", "text"));
    stored.presented(stored.record(write, "w", "text", 3), { value: { transfer: "t", handle: handle("write-entry") } });
    stored.presented(stored.record(read, "n", "text", 3), { native: { value: handle("pending") } });
    const { stashed, report } = await kept(stored, reseal);
    // The write first, because an interrupted seal should still have reached it.
    expect(reseal.mock.calls.map(([entry]) => entry)).toEqual([
      { id: "write-entry", format: "json" },
      { id: "read-entry", format: "text" },
      { id: "pending", format: "json" },
    ]);
    expect(stashed).toBeUndefined();
    expect(report.resultId).toBeUndefined();
    expect(report.calls).toEqual([
      { address: "books.read", resultId: "sealed-read-entry" },
      { address: "books.write", write: true, resultId: "sealed-write-entry" },
      { address: "books.read", dropped: true },
    ]);
    expect(report.note).toContain("only addresses survive");
    expect(JSON.stringify(report)).not.toMatch(/"(?:read|write)-entry"|pending/);

    // Unsealed, an entry is never named: a cancelled caller, stalled storage or an interrupted run.
    const unsealed = new CompletedCalls();
    unsealed.presented(unsealed.record(write, "w", "text", 3), handle("write-entry"));
    expect(required(unsealed.close()).report()).toMatchObject({
      calls: [{ address: "books.write", write: true, dropped: true }],
    });
  });

  it("R9: lists every write and the newest reads, with an omission count", async () => {
    const calls = new CompletedCalls();
    for (let i = 0; i < 40; i++) calls.record(tool(`read${i}`, { readOnlyHint: true }), i, "json", 2);
    calls.record(write, 1, "json", 1);
    const { report } = await kept(calls);
    expect(report.calls).toHaveLength(32);
    expect(report.callsOmitted).toBe(9);
    expect(report.calls.at(0)!.address).toBe("books.read9");
    expect(report.calls.at(-1)!.address).toBe("books.write");
  });

  it("INV-7: holds nothing once the run has closed it", () => {
    const calls = new CompletedCalls();
    expect(calls.close()).toBeUndefined();
    expect(add(calls, write, 1)).toBeUndefined();
    expect(calls.close()).toBeUndefined();
  });
});

describe("write accounting's authorization handoff", () => {
  it("INV-5 INV-9: the terminal result of a program write never gains the call's link", () => {
    const link = "https://connecta.example/connect/tickets?h=signed";
    const state = writeStateOf({
      ok: false,
      dispatched: true,
      answered: false,
      error: {
        code: "auth_required",
        message: "The token was refused",
        retryable: false,
        connector: "tickets",
        recovery: "operator_config",
        writeOutcome: "unknown",
        reconciliationRequired: true,
        operatorUrl: link,
        nextAction: {
          url: link,
          purpose: "Give this link to the user, unchanged, for the operator to open, then stop.",
        },
      },
    } as never);
    expect(state).toMatchObject({
      state: "unknown",
      handoff: {
        code: "auth_required",
        connector: "tickets",
        nextAction: { tool: "authorize_connector", arguments: { connector: "tickets" } },
      },
    });
    expect(JSON.stringify(state)).not.toContain(link);
  });
});
