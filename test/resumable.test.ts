// Resumable writes (#565): a program pauses host-side at its first unapproved
// write and resumes by replay through resume_execution.
//
// Programs here are JavaScript closures run by a scripted executor, not
// source strings: workerd forbids eval, and this suite runs in both projects.
// The executor keys each closure by its program text, which is what the
// journal stores and a replay plays again. The guest-contract arms cover the
// real QuickJS and Dynamic Worker sandboxes.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { recordToolActivity } from "../src/activity.js";
import { ConnectorCallError } from "../src/errors.js";
import { createProgramRunner } from "../src/execute.js";
import { createConnecta } from "../src/index.js";
import {
  resumeExecution,
  type ResumableSettings,
  type ResumeArgs,
} from "../src/resumable.js";
import {
  canonicalJson,
  classifyWriteOutcome,
  parseToken,
  RunJournal,
  type RunHeader,
} from "../src/run-journal.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  Executor,
  ExecutorProvider,
  KVStorage,
  ToolDef,
} from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.resumable";

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
function scriptedExecutor(programs: Map<string, Program>): Executor & { runs: number } {
  const executor = {
    runs: 0,
    async execute(code: string, providers: ExecutorProvider[]) {
      executor.runs++;
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
  return executor;
}

interface WorldOptions {
  storage?: KVStorage;
  settings?: Partial<ResumableSettings>;
  hostCallTimeoutMs?: number;
  watchdogMs?: number;
  storageTimeoutMs?: number;
  write?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  read?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const ISSUES = [
  { id: 1, stale: true },
  { id: 2, stale: true },
  { id: 3, stale: false },
];

function world(options: WorldOptions = {}) {
  const storage = options.storage ?? memoryStorage();
  const calls: Array<{ address: string; args: Record<string, unknown> }> = [];
  const catalogLoads: Record<string, number> = {};
  const events: ToolCallActivityEvent[] = [];
  const count = (address: string, args: unknown) =>
    calls.push({ address, args: (args ?? {}) as Record<string, unknown> });
  const reader: Connector = {
    id: "reader",
    kind: "api",
    description: "Reads issues",
    async listTools() {
      catalogLoads.reader = (catalogLoads.reader ?? 0) + 1;
      const readOnly: Partial<ToolDef> = { annotations: { readOnlyHint: true } };
      return [
        { name: "list_issues", ...readOnly },
        { name: "get", ...readOnly },
        { name: "big", ...readOnly },
      ];
    },
    async callTool(name, args) {
      count(`reader.${name}`, args);
      if (options.read) return options.read(name, args as Record<string, unknown>);
      if (name === "list_issues") return { issues: ISSUES };
      if (name === "big") return { blob: "x".repeat(4_300_000) };
      return { id: (args as { id?: number }).id, title: "An issue" };
    },
  };
  const tracker: Connector = {
    id: "tracker",
    kind: "api",
    description: "Writes issues",
    async listTools() {
      catalogLoads.tracker = (catalogLoads.tracker ?? 0) + 1;
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
  const registry = makeRegistry([reader, tracker], { storage });
  const activity: ActivityRequestContext = {
    recordTool: recordToolActivity,
    sink: { record: (event) => void events.push(event) },
    actor: { kind: "test" },
    requestId: "request",
    serverInfo: { name: "connecta-test", version: "0" },
    logger: silentLogger,
  };
  const programs = new Map<string, Program>();
  const executor = scriptedExecutor(programs);
  const settings: ResumableSettings = {
    maxWrites: 10,
    ttlSeconds: 1_800,
    pool: null,
    ...options.settings,
  };
  const runner = createProgramRunner(
    registry,
    BASE,
    executor,
    silentLogger,
    activity,
    {
      resumable: settings,
      ...(options.hostCallTimeoutMs !== undefined
        ? { hostCallTimeoutMs: options.hostCallTimeoutMs }
        : {}),
      ...(options.watchdogMs !== undefined ? { watchdogMs: options.watchdogMs } : {}),
      ...(options.storageTimeoutMs !== undefined
        ? { storageTimeoutMs: options.storageTimeoutMs }
        : {}),
    },
  );
  let next = 0;
  return {
    storage,
    registry,
    calls,
    catalogLoads,
    events,
    executor,
    settings,
    /** Register a closure and return the program text that names it. */
    program(run: Program): string {
      const code = `async () => program${next++}`;
      programs.set(code, run);
      return code;
    },
    execute: (code: string) => runner.execute({ code }),
    resume: (args: ResumeArgs, overrides: Partial<ResumableSettings> = {}) =>
      runEdge(resumeExecution(args, {
        storage: registry.resultsStorage(),
        settings: { ...settings, ...overrides },
        run: (runState) => runner.replay(runState),
        claimMs: runner.claimMs,
        storageTimeoutMs: runner.storageTimeoutMs,
        activity,
      })),
    writes: () => calls.filter((call) => call.address.startsWith("tracker.")),
    reads: () => calls.filter((call) => call.address.startsWith("reader.")),
  };
}

function value(result: { structuredContent?: Record<string, unknown> }): Record<string, any> {
  return required(result.structuredContent, "structured result") as Record<string, any>;
}

interface Paused {
  address: string;
  args: Record<string, unknown>;
  token: string;
  expiresAt: string;
  nextAction: { tool: string; arguments: ResumeArgs };
}

function paused(result: { isError?: boolean; structuredContent?: Record<string, unknown> }): Paused {
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return required(value(result).paused, "paused result") as Paused;
}

function approve(pause: Paused, approval: "call" | "tool" = "call"): ResumeArgs {
  return { token: pause.token, address: pause.address, args: pause.args, approval };
}

async function header(storage: KVStorage, token: string): Promise<{ raw: string; header: RunHeader }> {
  const parsed = required(parseToken(token));
  const view = makeRegistry([], { storage }).resultsStorage();
  return required(await new RunJournal(view, parsed.runId).readHeader(), "header");
}

/** The stale-close program: read, then close each stale issue, then post. */
const staleClose: Program = async (connecta) => {
  const { issues } = await connecta.call!("reader.list_issues", {});
  const stale = issues.filter((issue: { stale: boolean }) => issue.stale);
  const closed: number[] = [];
  for (const issue of stale) {
    await connecta.call!("tracker.close_issue", { id: issue.id });
    closed.push(issue.id);
  }
  await connecta.call!("tracker.post", { text: `closed ${closed.join(",")}` });
  return { closed };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("resumable writes: pausing", () => {
  it("pauses at the first write, sends nothing, and returns the exact write", async () => {
    const w = world();
    const result = await w.execute(w.program(staleClose));
    const pause = paused(result);
    expect(pause.address).toBe("tracker.close_issue");
    expect(pause.args).toEqual({ id: 1 });
    expect(pause.token).toMatch(/^r1\.[0-9a-f]{32}\.[0-9a-f]{32}\.\d+$/);
    expect(pause.nextAction).toEqual({
      tool: "resume_execution",
      arguments: approve(pause),
    });
    expect(Date.parse(pause.expiresAt) - Date.now()).toBeGreaterThan(1_790_000);
    expect(w.writes()).toEqual([]);
    const { header: stored } = await header(w.storage, pause.token);
    expect(stored).toMatchObject({
      state: "paused",
      pending: { address: "tracker.close_issue", args: { id: 1 } },
      approvals: [],
      writes: [],
      entries: 1,
      pool: null,
    });
  });

  it("records a payload-free paused event with zero attempts", async () => {
    const w = world();
    paused(await w.execute(w.program(staleClose)));
    const pausedEvents = w.events.filter((event) => event.outcome === "paused");
    expect(pausedEvents).toHaveLength(1);
    const [event] = pausedEvents;
    expect(event).toMatchObject({
      address: "tracker.close_issue",
      source: "execute_code",
      outcome: "paused",
      attempts: 0,
    });
    expect(event).not.toHaveProperty("errorCode");
    expect(JSON.stringify(event)).not.toContain("\"id\":1");
  });

  it("stops every later call and discards the program's own result", async () => {
    const w = world();
    const seen: string[] = [];
    const result = await w.execute(w.program(async (connecta) => {
      try {
        await connecta.call!("tracker.close_issue", { id: 9 });
      } catch (error) {
        seen.push((error as { code: string }).code);
      }
      try {
        await connecta.call!("reader.get", { id: 1 });
      } catch (error) {
        seen.push((error as { code: string }).code);
      }
      return "the program kept going";
    }));
    expect(paused(result).args).toEqual({ id: 9 });
    expect(JSON.stringify(result)).not.toContain("kept going");
    expect(w.calls).toEqual([]);
    // Whatever the program saw, it never reached a connector.
    expect(seen.every((code) => code === "execution_paused")).toBe(true);
  });

  it("pauses reproducibly at the lowest-numbered of concurrent writes", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const w = world();
      const result = await w.execute(w.program(async (connecta) => {
        await Promise.allSettled([
          connecta.call!("tracker.close_issue", { id: 1 }),
          connecta.call!("tracker.close_issue", { id: 2 }),
          connecta.call!("tracker.post", { text: "x" }),
        ]);
        return "done";
      }));
      expect(paused(result).args).toEqual({ id: 1 });
      expect(w.writes()).toEqual([]);
    }
  });

  it("refuses a pending write too large to hold, before journaling anything", async () => {
    const w = world();
    const result = await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.post", { text: "y".repeat(20_000) });
    }));
    expect(result.isError).toBe(true);
    expect(value(result).error).toMatchObject({
      code: "pending_write_too_large",
      nextAction: { tool: "call_destructive_tool", arguments: { address: "tracker.post" } },
    });
    expect(w.writes()).toEqual([]);
    expect(await w.storage.list?.("results:run:")).toEqual([]);
  });

  it("refuses to journal more than its byte bound", async () => {
    const w = world();
    const result = await w.execute(w.program(async (connecta) => {
      await connecta.call!("reader.big", {});
      await connecta.call!("tracker.close_issue", { id: 1 });
    }));
    expect(result.isError).toBe(true);
    expect(value(result).error.code).toBe("journal_too_large");
    expect(w.writes()).toEqual([]);
    expect(await w.storage.list?.("results:run:")).toEqual([]);
  });

  it("keeps E4's refusal when resumable writes are off", async () => {
    const w = world();
    const registry = w.registry;
    const runner = createProgramRunner(
      registry,
      BASE,
      w.executor,
      silentLogger,
    );
    const code = w.program(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
    });
    const result = await runner.execute({ code });
    expect(value(result).error.code).toBe("destructive_tool_requires_approval");
  });
});

describe("resumable writes: resume_execution", () => {
  it("approves exactly the paused write and replays reads from the journal", async () => {
    const w = world();
    const code = w.program(staleClose);
    const first = paused(await w.execute(code));
    const readsBefore = w.reads().length;
    const catalogBefore = w.catalogLoads.reader;
    const eventsBefore = w.events.length;

    const second = paused(await w.resume(approve(first)));
    expect(w.writes()).toEqual([
      { address: "tracker.close_issue", args: { id: 1 } },
    ]);
    // The read was answered from the journal: no call, no catalog load.
    expect(w.reads().length).toBe(readsBefore);
    expect(w.catalogLoads.reader).toBe(catalogBefore);
    expect(second.args).toEqual({ id: 2 });

    const third = paused(await w.resume(approve(second)));
    expect(third.address).toBe("tracker.post");
    const done = await w.resume(approve(third));
    expect(done.isError).not.toBe(true);
    expect(value(done).result).toEqual({ closed: [1, 2] });
    expect(w.writes().map((call) => call.address)).toEqual([
      "tracker.close_issue",
      "tracker.close_issue",
      "tracker.post",
    ]);
    expect(w.reads().length).toBe(readsBefore);
    // Replayed calls record no activity: after the first run, only approvals,
    // the live writes, and pauses.
    const later = w.events.slice(eventsBefore);
    expect(later.every((event) => event.address.startsWith("tracker."))).toBe(true);
    expect(later.filter((event) => event.outcome === "approved")).toHaveLength(3);
    expect(later.filter((event) => event.outcome === "success")).toHaveLength(3);
  });

  it("approval \"tool\" covers the rest of the run for that tool", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const next = paused(await w.resume(approve(first, "tool")));
    // Both closes went through on one approval; the post still asks.
    expect(next.address).toBe("tracker.post");
    expect(w.writes().map((call) => call.args)).toEqual([{ id: 1 }, { id: 2 }]);
    const approvedEvents = w.events.filter((event) => event.outcome === "approved");
    expect(approvedEvents).toEqual([
      expect.objectContaining({
        address: "tracker.close_issue",
        source: "resume_execution",
        approval: "tool",
        attempts: 0,
      }),
    ]);
  });

  it("rejects anything but an exact repetition, and consumes nothing", async () => {
    const w = world({
      write: () => ({ ok: true }),
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.post", { text: "hi", meta: { a: 1, b: [1, 2] } });
      return "posted";
    })));
    const { raw } = await header(w.storage, first.token);
    for (const wrong of [
      { ...approve(first), address: "tracker.close_issue" },
      { ...approve(first), args: { text: "hi" } },
      { ...approve(first), args: { text: "hi", meta: { a: "1", b: [1, 2] } } },
      { ...approve(first), args: { text: "hi", meta: { a: 1, b: [2, 1] } } },
      { ...approve(first), args: { text: "hi", meta: { a: 1, b: [1, 2] }, extra: true } },
    ]) {
      const refused = await w.resume(wrong);
      expect(refused.isError).toBe(true);
      expect(value(refused).error.code).toBe("approval_mismatch");
      expect(value(refused).error.nextAction.arguments).toEqual(approve(first));
    }
    expect((await header(w.storage, first.token)).raw).toBe(raw);
    expect(w.writes()).toEqual([]);
    // Key order is not part of the call.
    const done = await w.resume({
      ...approve(first),
      args: { meta: { b: [1, 2], a: 1 }, text: "hi" },
    });
    expect(value(done).result).toBe("posted");
    expect(w.writes()).toHaveLength(1);
  });

  it("answers a stale token with the current pause", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const second = paused(await w.resume(approve(first)));
    const stale = await w.resume(approve(first));
    expect(value(stale).error).toMatchObject({
      code: "execution_token_stale",
      nextAction: { tool: "resume_execution", arguments: approve(second) },
    });
    // A chained pause keeps the first pause's expiry.
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(w.writes()).toHaveLength(1);
  });

  it("returns the same answer to a repeated resume after the run completed", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.post", { text: "once" });
      return { posted: true };
    })));
    const done = await w.resume(approve(first));
    const again = await w.resume(approve(first));
    expect(value(again)).toEqual(value(done));
    expect(w.writes()).toHaveLength(1);
  });

  it("sends one set of writes when two resumes race for the same pause", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const w = world({
      write: async () => {
        await gate;
        return { ok: true };
      },
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.post", { text: "race" });
      return "done";
    })));
    const winner = w.resume(approve(first));
    await vi.waitFor(() => expect(w.writes()).toHaveLength(1));
    const loser = await w.resume(approve(first));
    expect(value(loser).error).toMatchObject({
      code: "execution_in_progress",
      retryable: true,
    });
    release();
    expect(value(await winner).result).toBe("done");
    expect(w.writes()).toHaveLength(1);
  });

  it("lets exactly one of two simultaneous resumes win the claim", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const w = world();
      const first = paused(await w.execute(w.program(async (connecta) => {
        await connecta.call!("tracker.post", { text: "race" });
        return "done";
      })));
      // Both read the header as paused before either claims it.
      const outcomes = await Promise.all([
        w.resume(approve(first)),
        w.resume(approve(first)),
      ]);
      const codes = outcomes.map((outcome) => value(outcome).error?.code ?? "done");
      expect(codes.sort()).toEqual(["done", "execution_in_progress"]);
      expect(w.writes()).toHaveLength(1);
    }
  });

  it("never sends a write a crashed claimant left in flight", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const { raw, header: stored } = await header(w.storage, first.token);
    // A claimant marked the approved write `sending`, then vanished.
    const crashed: RunHeader = {
      ...stored,
      state: "running",
      version: stored.version + 1,
      claim: { id: "0".repeat(32), until: Date.now() - 1 },
      approvals: [{
        address: "tracker.close_issue",
        scope: "call",
        argsCanonical: canonicalJson({ id: 1 }),
        consumed: true,
        nonce: stored.nonce,
      }],
      writes: [{ entry: stored.entries, address: "tracker.close_issue", state: "sending" }],
      entries: stored.entries + 1,
    };
    const journal = new RunJournal(w.registry.resultsStorage(), required(parseToken(first.token)).runId);
    expect(await journal.casHeader(raw, crashed)).toBeDefined();
    const result = await w.resume(approve(first));
    expect(value(result).error).toMatchObject({
      code: "write_outcome_unknown",
      writes: { succeeded: 0, failed: 0, unknown: 1 },
    });
    expect(w.writes()).toEqual([]);
    expect((await header(w.storage, first.token)).header.state).toBe("failed");
    // The same answer again, and still nothing sent.
    expect(value(await w.resume(approve(first))).error.code).toBe("write_outcome_unknown");
    expect(w.writes()).toEqual([]);
  });

  it("takes over a lapsed claim with nothing in flight and replays", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const { raw, header: stored } = await header(w.storage, first.token);
    const journal = new RunJournal(w.registry.resultsStorage(), required(parseToken(first.token)).runId);
    await journal.casHeader(raw, {
      ...stored,
      state: "running",
      version: stored.version + 1,
      claim: { id: "0".repeat(32), until: Date.now() - 1 },
    });
    const next = paused(await w.resume(approve(first)));
    expect(next.args).toEqual({ id: 2 });
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
  });

  it("stops without sending when another claimant took the run mid-play", async () => {
    let journal: RunJournal | undefined;
    const w = world({
      write: async (_name, args) => {
        if (args.id === 1 && journal) {
          // Someone else claims the run while this write is on the wire.
          const read = required(await journal.readHeader());
          await journal.casHeader(read.raw, {
            ...read.header,
            version: read.header.version + 1,
            claim: { id: "f".repeat(32), until: Date.now() + 60_000 },
          });
        }
        return { ok: true };
      },
    });
    const first = paused(await w.execute(w.program(staleClose)));
    journal = new RunJournal(w.registry.resultsStorage(), required(parseToken(first.token)).runId);
    const result = await w.resume(approve(first, "tool"));
    // The write that lost the claim was sent, and the report says so.
    expect(value(result).error).toMatchObject({
      code: "execution_claim_lost",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect(value(result).error.message).toContain("was sent (it succeeded)");
    // The first close had already been sent; the second never was.
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
  });

  it("goes back to the same pause when the executor fails, and retries cleanly", async () => {
    const w = world();
    const code = w.program(staleClose);
    const first = paused(await w.execute(code));
    const failing = w.executor.execute;
    let failNext = true;
    w.executor.execute = async (source, providers) => {
      if (failNext) {
        failNext = false;
        throw new Error("sandbox crashed");
      }
      return failing.call(w.executor, source, providers);
    };
    const crashed = await w.resume(approve(first));
    expect(crashed.isError).toBe(true);
    const { header: stored } = await header(w.storage, first.token);
    expect(stored.state).toBe("paused");
    expect(stored.approvals).toEqual([]);
    const retried = paused(await w.resume(approve(first)));
    expect(retried.args).toEqual({ id: 2 });
    expect(w.writes()).toHaveLength(1);
  });
});

describe("resumable writes: unknown outcomes", () => {
  const cases: Array<[string, () => unknown]> = [
    ["a timeout", () => { throw new ConnectorCallError("timeout", "gateway timed out"); }],
    ["an unavailable service", () => { throw new ConnectorCallError("unavailable", "down"); }],
    ["an untyped transport failure", () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [label, fail] of cases) {
    it(`stops at ${label} and never sends the write again`, async () => {
      const w = world({ write: (_name, args) => (args.id === 1 ? fail() : { ok: true }) });
      const first = paused(await w.execute(w.program(staleClose)));
      const result = await w.resume(approve(first, "tool"));
      expect(value(result).error).toMatchObject({
        code: "write_outcome_unknown",
        address: "tracker.close_issue",
        args: { id: 1 },
        writes: { succeeded: 0, failed: 0, unknown: 1 },
      });
      expect(w.writes()).toHaveLength(1);
      expect((await header(w.storage, first.token)).header.state).toBe("failed");
      await w.resume(approve(first, "tool"));
      expect(w.writes()).toHaveLength(1);
    });
  }

  it("treats a typed error after the response as an unknown outcome", async () => {
    const w = world({
      write: () => {
        throw new ConnectorCallError(
          "connector_call_failed",
          "tracker returned more bytes than it may, past this connector's response ceiling.",
        );
      },
    });
    const first = paused(await w.execute(w.program(staleClose)));
    const result = await w.resume(approve(first));
    expect(value(result).error.code).toBe("write_outcome_unknown");
    expect(w.writes()).toHaveLength(1);
  });

  it("treats a typed downstream answer as a known failure the program sees", async () => {
    const w = world({
      write: (_name, args) => {
        if (args.id === 1) throw new ConnectorCallError("not_found", "no such issue");
        return { ok: true };
      },
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
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
    })));
    const done = await w.resume(approve(first, "tool"));
    expect(value(done).result).toEqual(["not_found", "closed"]);
    const { header: stored } = await header(w.storage, first.token);
    expect(stored.writes.map((write) => write.state)).toEqual(["failed", "ok"]);
  });

  it("classifies write outcomes by what is known", () => {
    const table: Array<[Parameters<typeof classifyWriteOutcome>[0], string]> = [
      [{ ok: true, dispatched: true }, "ok"],
      [{ ok: false, dispatched: false, error: { code: "timeout" } }, "failed"],
      [{ ok: false, dispatched: true, error: { code: "timeout" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "timeout" } }, "unknown"],
      [{ ok: false, dispatched: true, error: { code: "cancelled" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "unavailable" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "connector_call_failed" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "connector_call_failed" } }, "failed"],
      // A typed error after the request went out (an oversized body, a
      // refused redirect) is not an answer: the write may have landed.
      [{ ok: false, dispatched: true, answered: false, error: { code: "connector_call_failed" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "not_found" } }, "failed"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "invalid_args" } }, "failed"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "not_found" } }, "failed"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "rate_limited" } }, "failed"],
      [{ ok: false, dispatched: true, error: { code: "result_processing_failed" } }, "ok"],
    ];
    for (const [outcome, expected] of table) {
      expect(classifyWriteOutcome(outcome), JSON.stringify(outcome)).toBe(expected);
    }
  });
});

describe("resumable writes: expiry, divergence, and budgets", () => {
  it("reports an expired run and an unknown one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = world({ settings: { ttlSeconds: 5 } });
    const first = paused(await w.execute(w.program(staleClose)));
    vi.setSystemTime(Date.now() + 6_000);
    const expired = await w.resume(approve(first));
    expect(value(expired).error).toMatchObject({
      code: "execution_expired",
      nextAction: { tool: "execute_code" },
    });
    const parsed = required(parseToken(first.token));
    const unknown = await w.resume({
      ...approve(first),
      token: `r1.${"a".repeat(32)}.${parsed.nonce}.${Date.now() + 60_000}`,
    });
    expect(value(unknown).error.code).toBe("execution_not_found");
    expect(value(await w.resume({ ...approve(first), token: "nonsense" })).error.code)
      .toBe("execution_not_found");
    expect(w.writes()).toEqual([]);
  });

  it("is not found from another pool", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const elsewhere = await w.resume(approve(first), { pool: "ops" });
    expect(value(elsewhere).error.code).toBe("execution_not_found");
    expect(w.writes()).toEqual([]);
  });

  it("fails typed when the replay makes a call its journal lacks (a)", async () => {
    let plays = 0;
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      plays++;
      await connecta.call!("reader.get", { id: plays });
      await connecta.call!("tracker.close_issue", { id: 1 });
      return "done";
    })));
    const readsBefore = w.reads().length;
    const result = await w.resume(approve(first));
    expect(value(result).error).toMatchObject({
      code: "execution_diverged",
      nextAction: { tool: "execute_code" },
    });
    expect(w.calls.length).toBe(readsBefore);
    expect((await header(w.storage, first.token)).header.state).toBe("failed");
  });

  it("fails typed when the replay never repeats the approved write (b)", async () => {
    let plays = 0;
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      plays++;
      if (plays === 1) await connecta.call!("tracker.close_issue", { id: 1 });
      return "done";
    })));
    const result = await w.resume(approve(first));
    expect(value(result).error.code).toBe("execution_diverged");
    expect(w.writes()).toEqual([]);
  });

  it("fails typed when the replay skips a write it already sent (c)", async () => {
    let plays = 0;
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      plays++;
      if (plays !== 3) await connecta.call!("tracker.close_issue", { id: 1 });
      await connecta.call!("tracker.close_issue", { id: 2 });
      return "done";
    })));
    const second = paused(await w.resume(approve(first)));
    const result = await w.resume(approve(second));
    expect(value(result).error.code).toBe("execution_diverged");
  });

  it("refuses writes past execute.maxWrites instead of asking for them", async () => {
    const w = world({ settings: { maxWrites: 1 } });
    const first = paused(await w.execute(w.program(async (connecta) => {
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
    })));
    const done = await w.resume(approve(first, "tool"));
    expect(value(done).result).toEqual(["closed", "budget_exceeded"]);
    expect(w.writes()).toHaveLength(1);
  });

  it("reports resumable writes unavailable when they are off", async () => {
    const w = world();
    const result = await runEdge(resumeExecution(
      { token: "r1.x", address: "a.b", args: {} },
      {
        storage: w.registry.resultsStorage(),
        settings: undefined,
        run: () => { throw new Error("never played"); },
        claimMs: 1_000,
        storageTimeoutMs: 1_000,
      },
    ));
    expect(value(result).error.code).toBe("resumable_writes_unavailable");
  });
});

describe("resumable writes: construction", () => {
  const executor: Executor = { execute: async () => ({ result: null }) };

  it("refuses resumableWrites: true over storage without compareAndSet", () => {
    const { compareAndSet: _cas, ...plain } = memoryStorage();
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        storage: plain,
        logger: "silent",
        execute: { resumableWrites: true },
      }),
    ).toThrow(/resumableWrites needs storage with compareAndSet/);
  });

  it("refuses a non-boolean resumableWrites", () => {
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        logger: "silent",
        execute: { resumableWrites: "yes" as unknown as boolean },
      }),
    ).toThrow(/resumableWrites must be a boolean/);
  });

  it("registers resume_execution only when resumable writes are on", async () => {
    const list = async (resumableWrites?: boolean) => {
      const connecta = createConnecta({
        connectors: [],
        executor,
        logger: "silent",
        ...(resumableWrites !== undefined ? { execute: { resumableWrites } } : {}),
      });
      const json = await readJsonRpc(await mcpRpc(connecta, "tools/list", {})) as {
        result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
      };
      await connecta.close();
      return json.result.tools;
    };
    expect((await list()).map((tool) => tool.name)).not.toContain("resume_execution");
    expect((await list(false)).map((tool) => tool.name)).not.toContain("resume_execution");
    const on = await list(true);
    expect(on.find((tool) => tool.name === "resume_execution")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(on.find((tool) => tool.name === "execute_code")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("resumable writes: review regressions", () => {
  it("never buries an unknown write under a concurrent pause, and never re-sends it", async () => {
    const sent: number[] = [];
    const w = world({
      write: async (name, args) => {
        if (name === "close_issue") {
          sent.push(Number(args.id));
          // The first send lands, then the gateway gives up on it.
          if (sent.length === 1) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            throw new ConnectorCallError("timeout", "gateway timed out");
          }
        }
        return { ok: true };
      },
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
      const closeWithRetry = async (id: number) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await connecta.call!("tracker.close_issue", { id });
          } catch (error) {
            if (!(error as { retryable?: boolean }).retryable) throw error;
          }
        }
        return undefined;
      };
      await Promise.all([
        closeWithRetry(2),
        connecta.call!("tracker.post", { text: "closed" }),
      ]);
      return "done";
    })));
    expect(first.address).toBe("tracker.close_issue");
    // The close goes out under "tool"; the post pauses beside it; the close
    // then times out. The unknown outcome must win over the pause.
    const second = await w.resume(approve(first, "tool"));
    expect(value(second).error).toMatchObject({
      code: "write_outcome_unknown",
      writes: { succeeded: 0, failed: 0, unknown: 1 },
    });
    expect((await header(w.storage, first.token)).header.state).toBe("failed");
    // Nothing left to resume, and the close is never sent a second time.
    const again = await w.resume(approve(first, "tool"));
    expect(value(again).error.code).toBe("write_outcome_unknown");
    expect(sent).toEqual([2]);
  });

  it("fails rather than returning to the pause when a play that sent a write is cut short", async () => {
    let plays = 0;
    let reads = 0;
    const w = world({
      watchdogMs: 200,
      read: (name) => {
        reads++;
        // The data a later write is built from changes between reads.
        return name === "get" ? { target: 100 + reads } : { issues: ISSUES };
      },
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
      plays++;
      const a = await connecta.call!("reader.get", { id: 1 });
      await connecta.call!("tracker.close_issue", { id: a.target });
      const b = await connecta.call!("reader.get", { id: 2 });
      // The second play hangs here until the watchdog ends it.
      if (plays === 2) await new Promise(() => {});
      await connecta.call!("tracker.close_issue", { id: b.target });
      return "done";
    })));
    expect(first.args).toEqual({ id: 101 });
    const cut = await w.resume(approve(first, "tool"));
    expect(value(cut).error).toMatchObject({
      code: "execution_interrupted",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect((await header(w.storage, first.token)).header.state).toBe("failed");
    // A retry, however it approves, gets the same answer and sends nothing.
    const retried = await w.resume(approve(first, "tool"));
    expect(value(retried).error.code).toBe("execution_interrupted");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 101 } }]);
  });

  it("refuses to replay past a lapsed play that sent writes it never paused after", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const { raw, header: stored } = await header(w.storage, first.token);
    const journal = new RunJournal(w.registry.resultsStorage(), required(parseToken(first.token)).runId);
    // A claimant sent the approved close, recorded it, and then crashed:
    // the reads it made after it were never journaled.
    await journal.writeEntry(stored.entries, {
      seq: 1,
      op: "call",
      key: required(stored.pending).key,
      write: true,
      outcome: { ok: true, value: { ok: true } },
    }, stored.expiresAt);
    await journal.casHeader(raw, {
      ...stored,
      state: "running",
      version: stored.version + 1,
      claim: { id: "0".repeat(32), until: Date.now() - 1 },
      approvals: [{ address: "tracker.close_issue", scope: "tool", nonce: stored.nonce }],
      writes: [{ entry: stored.entries, address: "tracker.close_issue", state: "ok" }],
      entries: stored.entries + 1,
    });
    const result = await w.resume(approve(first, "tool"));
    expect(value(result).error).toMatchObject({
      code: "execution_interrupted",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect(w.writes()).toEqual([]);
  });

  it("keeps a __proto__ key in the canonical form, and refuses to hold such a write", async () => {
    const hidden = JSON.parse('{"text":"hello","__proto__":{"text":"HIDDEN"}}') as unknown;
    expect(canonicalJson(hidden)).not.toBe(canonicalJson({ text: "hello" }));
    expect(canonicalJson(hidden)).toContain('"__proto__"');
    const w = world();
    const result = await w.execute(w.program(async (connecta) => {
      try {
        await connecta.call!("tracker.post", JSON.parse('{"text":"hello","__proto__":{"text":"HIDDEN"}}'));
        return "sent";
      } catch (error) {
        return (error as { code: string }).code;
      }
    }));
    expect(value(result).result).toBe("invalid_args");
    expect(w.writes()).toEqual([]);
  });

  it("reports an unawaited write that turned unknown after the program returned", async () => {
    const w = world({
      read: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
      write: async (_name, args) => {
        if (args.id === 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new ConnectorCallError("timeout", "gateway timed out");
        }
        return { ok: true };
      },
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      const unawaited = connecta.call!("tracker.close_issue", { id: 2 });
      unawaited.catch(() => {});
      await connecta.call!("reader.get", { id: 9 });
      return "done";
    })));
    const result = await w.resume(approve(first, "tool"));
    expect(value(result).error).toMatchObject({
      code: "write_outcome_unknown",
      writes: { succeeded: 1, failed: 0, unknown: 1 },
    });
    expect((await header(w.storage, first.token)).header.state).toBe("failed");
  });

  it("never leaves a write marked sending when the program returns before it is gated", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      connecta.call!("tracker.close_issue", { id: 2 }).catch(() => {});
      return "done";
    })));
    const result = await w.resume(approve(first, "tool"));
    expect(value(result).result).toBe("done");
    const { header: stored } = await header(w.storage, first.token);
    expect(stored.state).toBe("completed");
    expect(stored.writes.some((write) => write.state === "sending" || write.state === "unknown"))
      .toBe(false);
    // Whatever reached the connector is exactly what the header records.
    expect(w.writes().length).toBe(stored.writes.length);
  });

  it("puts write counts on the error of a claimed play whose program failed", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      throw new Error("the program gave up");
    })));
    const result = await w.resume(approve(first));
    expect(result.isError).toBe(true);
    expect(value(result).error).toMatchObject({
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect(value(result).error.message).toContain("the program gave up");
    expect((await header(w.storage, first.token)).header.state).toBe("failed");
  });

  it("keeps the run's header while a claim outlives its deadline, and answers a repeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = world({
      settings: { ttlSeconds: 1 },
      write: () => {
        // The write takes longer than the paused run's whole lifetime.
        vi.setSystemTime(Date.now() + 2_000);
        return { ok: true };
      },
    });
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      return "done";
    })));
    const done = await w.resume(approve(first));
    expect(value(done).result).toBe("done");
    // Past expiresAt, a repeat gets the run's answer, not "run it again".
    const again = await w.resume(approve(first));
    expect(value(again).result).toBe("done");
    expect(w.writes()).toHaveLength(1);
  });

  it("does not take an earlier identical call for the repeated approved write", async () => {
    let plays = 0;
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      plays++;
      await connecta.call!("tracker.close_issue", { id: 1 });
      await connecta.call!("reader.get", { id: plays === 3 ? 99 : 1 });
      await connecta.call!("tracker.close_issue", { id: 1 });
      return "done";
    })));
    const second = paused(await w.resume(approve(first)));
    expect(second.args).toEqual({ id: 1 });
    const result = await w.resume(approve(second));
    expect(value(result).error.code).toBe("execution_diverged");
    expect(w.writes()).toHaveLength(1);
  });

  it("settles a write a host-call deadline cut short after its sending mark as never sent", async () => {
    const base = memoryStorage();
    let slowed = false;
    const slow: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        // Only the first write-ahead mark outlasts the host-call deadline.
        if (!slowed && next?.includes('"state":"sending"')) {
          slowed = true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return required(base.compareAndSet)(key, expected, next, options);
      },
    };
    const w = world({ storage: slow, hostCallTimeoutMs: 40 });
    const first = paused(await w.execute(w.program(async (connecta) => {
      let code = "sent";
      try {
        await connecta.call!("tracker.close_issue", { id: 1 });
      } catch (error) {
        code = (error as { code: string }).code;
      }
      await connecta.call!("tracker.post", { text: code });
      return code;
    })));
    const second = paused(await w.resume(approve(first)));
    expect(second.args).toEqual({ text: "timeout" });
    const done = await w.resume(approve(second));
    expect(value(done).result).toBe("timeout");
    expect(w.writes()).toEqual([{ address: "tracker.post", args: { text: "timeout" } }]);
    // The header says what happened: the close was marked, then settled as
    // never sent — not left `sending` over a journal slot nothing filled.
    const { header: stored } = await header(w.storage, first.token);
    expect(stored.writes.map((write) => [write.address, write.state])).toEqual([
      ["tracker.close_issue", "failed"],
      ["tracker.post", "ok"],
    ]);
  });
});

describe("resumable writes: messages that match what happened", () => {
  it("does not say nothing was sent when a chained pause is too large to hold", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      await connecta.call!("reader.big", {});
      await connecta.call!("tracker.close_issue", { id: 2 });
      return "done";
    })));
    const result = await w.resume(approve(first));
    expect(value(result).error).toMatchObject({
      code: "journal_too_large",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect(value(result).error.message).not.toContain("Nothing was sent");
  });
});

/** Resolves "hung" if `work` has not settled within `ms`. */
function within<T>(ms: number, work: Promise<T>): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<"hung">((resolve) => {
      timer = setTimeout(() => resolve("hung"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A header as a claimant that sent the approved close and then crashed left it. */
async function lapsedAfterWrite(
  w: ReturnType<typeof world>,
  pause: Paused,
  until: number,
): Promise<void> {
  const { raw, header: stored } = await header(w.storage, pause.token);
  const journal = new RunJournal(w.registry.resultsStorage(), required(parseToken(pause.token)).runId);
  await journal.writeEntry(stored.entries, {
    seq: 1,
    op: "call",
    key: required(stored.pending).key,
    write: true,
    outcome: { ok: true, value: { ok: true } },
  }, stored.expiresAt);
  expect(await journal.casHeader(raw, {
    ...stored,
    state: "running",
    version: stored.version + 1,
    claim: { id: "0".repeat(32), until },
    approvals: [{ address: "tracker.close_issue", scope: "tool", nonce: stored.nonce }],
    writes: [{ entry: stored.entries, address: "tracker.close_issue", state: "ok" }],
    entries: stored.entries + 1,
  })).toBeDefined();
}

describe("resumable writes: second review regressions", () => {
  it("answers a live claim as in progress and a lapsed one with its counts, even past the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = world({ settings: { ttlSeconds: 5 } });
    const first = paused(await w.execute(w.program(staleClose)));
    // A claimant still inside its lease, past the run's deadline.
    await lapsedAfterWrite(w, first, Date.now() + 20_000);
    vi.setSystemTime(Date.now() + 10_000);
    const live = await w.resume(approve(first, "tool"));
    expect(value(live).error).toMatchObject({ code: "execution_in_progress", retryable: true });
    // Its lease lapses: what it sent is still reported, not "expired".
    vi.setSystemTime(Date.now() + 15_000);
    const lapsed = await w.resume(approve(first, "tool"));
    expect(value(lapsed).error).toMatchObject({
      code: "execution_interrupted",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect(w.writes()).toEqual([]);
  });

  it("gives check-first advice, not a plain re-run, once a write landed", async () => {
    let plays = 0;
    const w = world();
    const first = paused(await w.execute(w.program(async (connecta) => {
      plays++;
      await connecta.call!("tracker.close_issue", { id: 1 });
      await connecta.call!("reader.get", { id: plays === 3 ? 99 : 1 });
      await connecta.call!("tracker.close_issue", { id: 1 });
      return "done";
    })));
    const second = paused(await w.resume(approve(first)));
    const result = await w.resume(approve(second));
    const error = value(result).error;
    expect(error).toMatchObject({
      code: "execution_diverged",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
      nextAction: { tool: "execute_code" },
    });
    expect(error.nextAction.purpose).toMatch(/^Check what the writes/);
    // A run that sent nothing keeps the plain advice.
    const quiet = world();
    let quietPlays = 0;
    const pause = paused(await quiet.execute(quiet.program(async (connecta) => {
      quietPlays++;
      await connecta.call!("reader.get", { id: quietPlays });
      await connecta.call!("tracker.close_issue", { id: 1 });
      return "done";
    })));
    const diverged = value(await quiet.resume(approve(pause))).error;
    expect(diverged.nextAction.purpose).toMatch(/^Run the task again/);
  });

  it("keeps a paused run's write counts past its deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const w = world({ settings: { ttlSeconds: 5 } });
    const first = paused(await w.execute(w.program(staleClose)));
    const second = paused(await w.resume(approve(first)));
    vi.setSystemTime(Date.now() + 60_000);
    const expired = value(await w.resume(approve(second))).error;
    expect(expired).toMatchObject({
      code: "execution_expired",
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
    expect(expired.nextAction.purpose).toMatch(/^Check what the writes/);
    expect(w.writes()).toHaveLength(1);
  });

  it("bounds a write-ahead mark that storage never answers, and sends nothing", async () => {
    const base = memoryStorage();
    const hanging: KVStorage = {
      ...base,
      compareAndSet: (key, expected, next, options) =>
        next?.includes('"state":"sending"')
          ? new Promise<boolean>(() => {})
          : required(base.compareAndSet)(key, expected, next, options),
    };
    const w = world({ storage: hanging, storageTimeoutMs: 50 });
    const first = paused(await w.execute(w.program(staleClose)));
    const result = await within(3_000, w.resume(approve(first)));
    expect(result).not.toBe("hung");
    expect(value(result as { structuredContent?: Record<string, unknown> }).error).toMatchObject({
      code: "execution_interrupted",
      writes: { succeeded: 0, failed: 0, unknown: 0 },
    });
    expect(w.writes()).toEqual([]);
  });

  it("bounds a write's journal entry that storage never answers, and reports it sent", async () => {
    const base = memoryStorage();
    let armed = false;
    const hanging: KVStorage = {
      ...base,
      set: (key, value, options) =>
        armed && /:e:\d+$/.test(key)
          ? new Promise<void>(() => {})
          : base.set(key, value, options),
    };
    const w = world({ storage: hanging, storageTimeoutMs: 50 });
    const first = paused(await w.execute(w.program(staleClose)));
    armed = true;
    const result = await within(3_000, w.resume(approve(first)));
    expect(result).not.toBe("hung");
    const error = value(result as { structuredContent?: Record<string, unknown> }).error;
    expect(error.code).toBe("execution_interrupted");
    expect(error.message).toContain("was sent");
    expect(error.writes.succeeded + error.writes.unknown).toBe(1);
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
  });

  it("stores a failed takeover's answer in the compare-and-set that ends the run", async () => {
    const base = memoryStorage();
    let casLeft = Number.POSITIVE_INFINITY;
    const flaky: KVStorage = {
      ...base,
      compareAndSet: (key, expected, next, options) => {
        if (casLeft-- <= 0) return Promise.reject(new Error("storage went away"));
        return required(base.compareAndSet)(key, expected, next, options);
      },
    };
    const w = world({ storage: flaky });
    const first = paused(await w.execute(w.program(staleClose)));
    await lapsedAfterWrite(w, first, Date.now() - 1);
    // One more compare-and-set works; a second would fail.
    casLeft = 1;
    const result = await w.resume(approve(first, "tool"));
    expect(value(result).error.code).toBe("execution_interrupted");
    casLeft = 0;
    // The answer was stored with the failure, so a repeat still gets it.
    expect(await w.resume(approve(first, "tool"))).toEqual(result);
    expect(w.writes()).toEqual([]);

    // The same for a journal that cannot be read back.
    const v = world({ storage: flaky });
    casLeft = Number.POSITIVE_INFINITY;
    const pause = paused(await v.execute(v.program(staleClose)));
    await v.registry.resultsStorage().delete(`run:${required(parseToken(pause.token)).runId}:src`);
    casLeft = 1;
    const unreadable = await v.resume(approve(pause));
    expect(value(unreadable).error.code).toBe("execution_interrupted");
    casLeft = 0;
    expect(await v.resume(approve(pause))).toEqual(unreadable);
    expect(v.writes()).toEqual([]);
  });

  it("answers approval_mismatch to a repetition whose args carry __proto__", async () => {
    const programs = new Map<string, Program>();
    const sent: unknown[] = [];
    const tracker: Connector = {
      id: "tracker",
      kind: "api",
      description: "Writes issues",
      listTools: async () => [{ name: "post" }],
      callTool: async (_name, args) => {
        sent.push(args);
        return { ok: true };
      },
    };
    const connecta = createConnecta({
      connectors: [tracker],
      executor: scriptedExecutor(programs),
      logger: "silent",
      execute: { resumableWrites: true },
    });
    const code = "async () => protoProgram";
    programs.set(code, async (guest) => {
      await guest.call!("tracker.post", { text: "a" });
      return "done";
    });
    const call = async (name: string, args: unknown) =>
      (await readJsonRpc(await mcpRpc(connecta, "tools/call", { name, arguments: args })) as {
        result: { structuredContent: Record<string, any> };
      }).result.structuredContent;
    const pause = (await call("execute_code", { code })).paused as Paused;
    expect(pause.args).toEqual({ text: "a" });
    const smuggled = JSON.parse(
      `{"token":${JSON.stringify(pause.token)},"address":"tracker.post","args":{"text":"a","__proto__":{"text":"b"}}}`,
    ) as unknown;
    const answer = await call("resume_execution", smuggled);
    expect(answer.error?.code).toBe("approval_mismatch");
    expect(sent).toEqual([]);
    // The exact repetition still goes through.
    const done = await call("resume_execution", approve(pause));
    expect(done.result).toBe("done");
    expect(sent).toEqual([{ text: "a" }]);
    await connecta.close();
  });

  it("renders holes and boxed primitives as JSON does", () => {
    // oxlint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    const boxed = {
      n: Object(1) as unknown,
      s: Object("x") as unknown,
      b: Object(false) as unknown,
      list: [Object(2) as unknown],
    };
    expect(canonicalJson(sparse)).toBe(JSON.stringify(sparse));
    expect(canonicalJson(sparse)).toBe("[1,null,3]");
    expect(canonicalJson(boxed)).toBe('{"b":false,"list":[2],"n":1,"s":"x"}');
    expect(canonicalJson(boxed)).not.toBe(canonicalJson({ b: {}, list: [{}], n: {}, s: {} }));
  });

  it("lets a retried resume's approval scope replace an unused approval of the same pause", async () => {
    const w = world();
    const first = paused(await w.execute(w.program(staleClose)));
    const { raw, header: stored } = await header(w.storage, first.token);
    const journal = new RunJournal(w.registry.resultsStorage(), required(parseToken(first.token)).runId);
    // A claimant approved the close for one call, then crashed before sending.
    await journal.casHeader(raw, {
      ...stored,
      state: "running",
      version: stored.version + 1,
      claim: { id: "0".repeat(32), until: Date.now() - 1 },
      approvals: [{
        address: "tracker.close_issue",
        scope: "call",
        argsCanonical: canonicalJson({ id: 1 }),
        nonce: stored.nonce,
      }],
    });
    const next = paused(await w.resume(approve(first, "tool")));
    // The retry's "tool" covers both closes; the post asks.
    expect(next.address).toBe("tracker.post");
    expect(w.writes().map((call) => call.args)).toEqual([{ id: 1 }, { id: 2 }]);
    const approvals = (await header(w.storage, next.token)).header.approvals;
    expect(approvals).toEqual([
      { address: "tracker.close_issue", scope: "tool", nonce: stored.nonce },
    ]);
    expect(w.events.filter((event) => event.outcome === "approved")).toEqual([
      expect.objectContaining({ address: "tracker.close_issue", approval: "tool" }),
    ]);
  });
});
