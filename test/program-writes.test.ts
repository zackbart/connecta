import { guestError, guestErrorText, guestFailureFacts, guestSource } from "./fixtures/misc.js";
// Focused program accounting/drain and classification-drift fault probes.
// HTTP policy, private payloads and one-send recovery live in identity-write-journey.node.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { recordToolActivity } from "../src/activity.js";
import { routeDescription, routeNames } from "../src/agent-routes.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { MAX_EXECUTE_RESULT_CHARS } from "../src/executor-result.js";
import { createConnecta, customExecutor } from "../src/index.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { delegatesEachCall, knownProviderFailure } from "../src/provider-call.js";
import { writeStateOf } from "../src/program-writes.js";
import { sentSecretsFor } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, Executor, ExecutorProvider, ToolDef } from "../src/types.js";
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
  read?: (name: string, args: Record<string, unknown>, context: ConnectorContext) => Promise<unknown> | unknown;
  /** The tracker answers as a hosted MCP tool does, so `isError` is its own answer. */
  trackerKind?: "mcp";
  maxResultChars?: number;
  logger?: typeof silentLogger;
  readProgram?: boolean;
  classification?: Record<string, Record<string, "read" | "write" | "hidden">>;
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
    async callTool(name, args, context) {
      count(`reader.${name}`, args);
      if (options.read) return await options.read(name, args as Record<string, unknown>, context);
      return { id: (args as { id?: number }).id, title: "An issue" };
    },
  };
  const tracker: Connector = {
    id: "tracker",
    kind: options.trackerKind ?? "api",
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
  const registry = makeRegistry([reader, tracker], {
    storage: memoryStorage(),
    ...(options.classification ? { classification: options.classification } : {}),
  });
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
    options.logger ?? silentLogger,
    activity,
    {
      readOnly: options.readOnly,
      ...(options.maxResultChars !== undefined ? { maxResultChars: options.maxResultChars } : {}),
      ...(options.readProgram
        ? { readProgram: true, routes: routeNames("read-route"), followUpRoutes: routeNames("read-route") }
        : {}),
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
    reads: () => calls.filter((call) => call.address.startsWith("reader.")),
  };
}

function value(result: { structuredContent?: Record<string, unknown> }): Record<string, any> {
  return required(result.structuredContent, "structured result") as Record<string, any>;
}

describe("read programs (execute_read_code)", () => {
  const readProgram = (classification?: WorldOptions["classification"]) =>
    world({ readProgram: true, ...(classification ? { classification } : {}) });

  it("INV-2 INV-3: reads, then refuses a write below the sandbox with its next step; catching changes nothing", async () => {
    const w = readProgram();
    const refused = await w.run(async (connecta) => {
      const read = await connecta.call!("reader.get", { id: 1 });
      const attempts = await Promise.allSettled([
        connecta.call!("tracker.close_issue", { id: 1 }),
        connecta.call!("tracker.post", {}),
      ]);
      let caught: Record<string, unknown> = {};
      try {
        await connecta.call!("tracker.close_issue", { id: 2 });
      } catch (error) {
        caught = { ...(error as object), message: (error as Error).message };
      }
      return { read: read.data, statuses: attempts.map((a) => a.status), caught };
    });
    expect(w.writes()).toEqual([]);
    const answer = value(refused).result;
    expect(answer.read).toMatchObject({ id: 1 });
    expect(answer.statuses).toEqual(["rejected", "rejected"]);
    expect(answer.caught).toMatchObject({ code: "destructive_tool_requires_approval", retryable: false });
    expect(answer.caught.message).toContain("call_destructive_tool");
    expect(answer.caught.message).toContain("execute_code");
    expect(value(refused).writes).toBeUndefined();
  });

  it("INV-1 INV-9: refuses a source write a silent override serves as a read, which the host could resend", async () => {
    const w = readProgram({ tracker: { post: "read" } });
    const tools = await w.registry.getTools("tracker", BASE, {});
    expect(tools.find((tool) => tool.name === "post")).toMatchObject({ classification: "read" });
    const refused = await w.run((connecta) => connecta.call!("tracker.post", {}));
    expect(value(refused).error).toMatchObject({ code: "destructive_tool_requires_approval", retryable: false });
    expect(w.writes()).toEqual([]);
  });

  it("INV-2: a read-only connector's refusal keeps saying no write route exists", async () => {
    const connector: Connector = {
      id: "locked",
      readOnly: true,
      listTools: async () => [{ name: "update", annotations: { readOnlyHint: false } }],
      callTool: async () => null,
    };
    const programs = new Map<string, Program>([
      ["async () => program", (connecta) => connecta.call!("locked.update", {})],
    ]);
    const execute = createExecuteTool(
      makeRegistry([connector]),
      BASE,
      scriptedExecutor(programs),
      silentLogger,
      undefined,
      {
        readProgram: true,
      },
    );
    expect(value(await execute({ code: "async () => program" })).error).toMatchObject({ code: "read_only_endpoint" });
  });

  it("marks writes uncallable in discovery instead of hiding them, and records the route", async () => {
    const w = readProgram();
    const found = value(
      await w.run(async (connecta) => {
        const search = await connecta.search!({});
        const described = await connecta.describe!({ addresses: ["tracker.close_issue", "reader.get"] });
        await connecta.call!("reader.get", { id: 1 });
        return { search: search.tools, described: described.tools };
      }),
    ).result as { search: Array<Record<string, unknown>>; described: Array<Record<string, unknown>> };
    const marked = (tools: Array<Record<string, unknown>>) =>
      Object.fromEntries(tools.map((tool) => [tool.address, tool.callable]));
    expect(marked(found.search)).toEqual({
      "reader.get": undefined,
      "tracker.close_issue": false,
      "tracker.post": false,
    });
    expect(marked(found.described)).toEqual({ "tracker.close_issue": false, "reader.get": undefined });
    expect(w.events.map((event) => event.source)).toEqual(["execute_read_code"]);

    const plain = world();
    const unmarked = value(await plain.run(async (connecta) => (await connecta.search!({})).tools)).result as object[];
    expect(unmarked.every((tool) => !("callable" in tool))).toBe(true);
  });

  it("sends follow-up work from a read program to the read route", async () => {
    const w = readProgram();
    const result = value(await w.run(async () => "x".repeat(MAX_EXECUTE_RESULT_CHARS + 1))).result;
    expect(result.nextAction).toMatchObject({ tool: "execute_read_code" });
  });
});

const LATE_SECRET = "Zqx79UVW_LATE_SECRET";
const toolError = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
const registerLate =
  (credential = LATE_SECRET) =>
  (_name: string, _args: Record<string, unknown>, context: ConnectorContext) => {
    sentSecretsFor(context).secret(credential);
    return { ok: true };
  };
const attempt = async (call: () => Promise<unknown>) => {
  try {
    await call();
  } catch {
    // The program carries on, as one that catches a failed write can.
  }
};
const programResult = (result: { content: { text?: string }[] }) => JSON.stringify(result);

describe("what a program's unknown writes report", () => {
  it.each([
    ["a connector's error", "api", `${"x ".repeat(252)}${LATE_SECRET}`],
    ["a connector's error far past the clip", "api", `${"x ".repeat(2_500)}${LATE_SECRET} tail`],
    ["a tool's error", "mcp", `${"x ".repeat(252)}${LATE_SECRET}`],
    ["a tool's error crossing the clip", "mcp", `${"x ".repeat(2_043)}${LATE_SECRET} tail`],
    ["a tool's error with no boundary before it", "mcp", `${"x".repeat(4_090)}${LATE_SECRET} tail`],
  ] as const)("INV-5: a credential a later call registers leaves no fragment of %s", async (_label, kind, text) => {
    const w = world({
      readOnly: false,
      ...(kind === "mcp" ? { trackerKind: "mcp" as const } : {}),
      write: () => {
        if (kind === "mcp") return toolError(text);
        throw new Error(text);
      },
      read: registerLate(),
    });
    const result = await w.run(async (connecta) => {
      await attempt(() => connecta.call!("tracker.post", {}));
      await connecta.call!("reader.get", {});
      return "done";
    });
    const rendered = programResult(result);
    expect(value(result).error.code).toBe("write_outcome_unknown");
    expect(rendered).not.toContain("Zqx7");
    expect(rendered).not.toContain("LATE_SECRET");
  });

  it("INV-5: a retained text cut through a credential shrinks to no fragment of it", async () => {
    const long = `Zqx79UVW${"s".repeat(192)}`;
    const w = world({
      readOnly: false,
      write: () => Promise.reject(new Error(`${long} `.repeat(90))),
      read: registerLate(long),
    });
    const result = await w.run(async (connecta) => {
      await attempt(() => connecta.call!("tracker.post", {}));
      await connecta.call!("reader.get", {});
      return "done";
    });
    const rendered = programResult(result);
    expect(value(result).error.code).toBe("write_outcome_unknown");
    expect(rendered).not.toContain("Zqx7");
    expect(rendered).not.toContain("sssssss");
  });

  it("a connector's long failure fits the deployment's result limit and marks the cut", async () => {
    const w = world({
      readOnly: false,
      maxResultChars: 1_024,
      write: () => Promise.reject(new Error("word ".repeat(4_800))),
    });
    const result = await w.run(async (connecta) => {
      await attempt(() => connecta.call!("tracker.post", {}));
      return "done";
    });
    const { error } = value(result);
    expect(new TextEncoder().encode(JSON.stringify(value(result))).length).toBeLessThanOrEqual(1_024);
    expect(error.unknownWrites[0].message).toContain("… [truncated]");
  });

  it("marks what a limit too small for any report leaves out", async () => {
    const w = world({
      readOnly: false,
      maxResultChars: 600,
      write: () => Promise.reject(new Error("word ".repeat(4_800))),
    });
    const result = await w.run(async (connecta) => {
      await attempt(() => connecta.call!("tracker.post", {}));
      return "done";
    });
    const { error } = value(result);
    expect(error.code).toBe("write_outcome_unknown");
    expect(error.message).toContain("unknown outcome");
    expect(error.unknownWritesTruncated).toBe(true);
    expect(JSON.stringify(error)).not.toContain("word word word");
  });

  it("bounds every entry and the whole report, however many writes fail", async () => {
    const w = world({ readOnly: false, write: () => Promise.reject(new Error(`"${"quoted word ".repeat(2_000)}"`)) });
    const result = await w.run(async (connecta) => {
      for (let index = 0; index < 10; index++) await attempt(() => connecta.call!("tracker.post", {}));
      return "done";
    });
    const { error } = value(result);
    expect(error.writes).toMatchObject({ unknown: 10 });
    expect(new TextEncoder().encode(JSON.stringify(error.unknownWrites)).length).toBeLessThanOrEqual(8_192);
    for (const entry of error.unknownWrites)
      expect(new TextEncoder().encode(JSON.stringify(entry.message ?? "")).length).toBeLessThanOrEqual(4_096);
    expect(error.unknownWrites[0].message).toContain("… [truncated]");
    expect(error.unknownWritesTruncated).toBe(true);
    expect(w.writes()).toHaveLength(10);
  });

  it("INV-6: the tool's words stay out of activity and the operator's log", async () => {
    const logged: unknown[] = [];
    const logger = {
      ...silentLogger,
      warn: (...args: unknown[]) => void logged.push(args),
      error: (...args: unknown[]) => void logged.push(args),
    };
    const w = world({
      readOnly: false,
      trackerKind: "mcp",
      logger,
      write: () => toolError("Approve at https://vendor.example/apr_7Hq2"),
    });
    const result = await w.run(async (connecta) => {
      await attempt(() => connecta.call!("tracker.post", {}));
      return "done";
    });
    expect(value(result).error.message).toContain("https://vendor.example/apr_7Hq2");
    expect(w.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.events)).not.toContain("apr_7Hq2");
    expect(JSON.stringify(logged)).not.toContain("apr_7Hq2");
  });
});

describe("the credential check on a program's outbound arguments", () => {
  const STRIPE_STYLE = "sk_test_51Hq7ZpLm9TxV2bNw";
  const afterCredential = async (credential: string, note: unknown, tool = "tracker.post") => {
    const w = world({ readOnly: false, read: registerLate(credential) });
    const result = await w.run(async (connecta) => {
      await connecta.call!("reader.get", {});
      return await connecta.call!(tool, { note });
    });
    return { result: value(result), sent: w.writes(), calls: w };
  };

  it.each([
    ["names the public prefix", "Document the sk_test_ prefix"],
    ["names only a prefix among other words", "keys look like sk_test_ or sk_live_ here"],
    ["looks like a header line", "x-api-key: rotate this one"],
  ])("INV-9: a write that %s is sent exactly as written", async (_label, note) => {
    const { result, sent } = await afterCredential(STRIPE_STYLE, note);
    expect(result.error).toBeUndefined();
    expect(sent).toEqual([{ address: "tracker.post", args: { note } }]);
  });

  it.each([
    ["the whole credential", STRIPE_STYLE],
    ["it in framing", `Authorization: Bearer ${STRIPE_STYLE}`],
    ["eight units past the prefix", "sk_test_51Hq7ZpL"],
    ["eight units of its value alone", "51Hq7ZpL"],
    ["its encoding", btoa(STRIPE_STYLE)],
    ["its percent encoding inside a URL", `https://example.com/?k=${encodeURIComponent(`Bearer ${STRIPE_STYLE}`)}`],
    ["it nested in JSON text", JSON.stringify({ deep: JSON.stringify({ key: STRIPE_STYLE }) })],
  ])("INV-5: a write holding %s stays unsent", async (_label, note) => {
    const { result, sent } = await afterCredential(STRIPE_STYLE, note);
    expect(result.error.code).toBe("invalid_args");
    expect(result.error.message).toContain("tracker.post was not sent");
    expect(sent).toEqual([]);
  });

  it("states the limit: fewer than eight units past a public prefix are not a match", async () => {
    const { result, sent } = await afterCredential(STRIPE_STYLE, "sk_test_51Hq7Zp");
    expect(result.error).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("a credential that is only its label and a short value matches whole", async () => {
    expect((await afterCredential("sk_live_short12", "the sk_live_ prefix")).sent).toHaveLength(1);
    expect((await afterCredential("sk_live_short12", "sk_live_short12")).sent).toEqual([]);
  });

  it("a JWT's public header segment is not a match; its payload is", async () => {
    const header = "eyJhbGciOiJIUzI1NiJ9";
    const token = `${header}.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLWJ5dGVz`;
    expect((await afterCredential(token, `another token ${header}.eyJvdGhlciI6dHJ1ZX0.b3RoZXI`)).sent).toHaveLength(1);
    expect((await afterCredential(token, token)).sent).toEqual([]);
  });

  it("an identifier sent beside a credential is public: a write naming it is sent", async () => {
    const w = world({
      readOnly: false,
      read: (_name, _args, context) => {
        sentSecretsFor(context).identifier("alice@example.com");
        return { ok: true };
      },
    });
    const result = await w.run(async (connecta) => {
      await connecta.call!("reader.get", {});
      return await connecta.call!("tracker.post", { assignee: "alice@example.com" });
    });
    expect(value(result).error).toBeUndefined();
    expect(w.writes()).toEqual([{ address: "tracker.post", args: { assignee: "alice@example.com" } }]);
  });

  it("a private value an earlier call submitted never refuses a later write repeating it", async () => {
    const w = world({
      readOnly: false,
      read: (_name, _args, context) => {
        sentSecretsFor(context).arguments(
          { note: "our ordinary repeated sentence" },
          { type: "object", properties: { note: { type: "string", writeOnly: true } } },
        );
        return { ok: true };
      },
    });
    const result = await w.run(async (connecta) => {
      await connecta.call!("reader.get", {});
      return await connecta.call!("tracker.post", { note: "our ordinary repeated sentence" });
    });
    expect(value(result).error).toBeUndefined();
    expect(w.writes()).toEqual([{ address: "tracker.post", args: { note: "our ordinary repeated sentence" } }]);
  });

  it("a read sends a public prefix as written and still has a real match replaced", async () => {
    const w = world({ readOnly: false, read: registerLate(STRIPE_STYLE) });
    const result = await w.run(async (connecta) => {
      await connecta.call!("reader.get", {});
      await connecta.call!("reader.get", { query: "the sk_test_ prefix" });
      await connecta.call!("reader.get", { query: `leaked ${STRIPE_STYLE}` });
      return "done";
    });
    const reads = w.reads();
    expect(value(result).error).toBeUndefined();
    expect(reads[1]!.args).toEqual({ query: "the sk_test_ prefix" });
    expect(JSON.stringify(reads[2]!.args)).not.toContain("51Hq7ZpL");
  });
});

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

  it("INV-1 INV-2: a read override cannot make a declared write a read, and warns once per catalog change", async () => {
    const logger = { ...silentLogger, warn: vi.fn() };
    let sent = 0;
    let raw: ToolDef[] = [
      { name: "no_read", annotations: { readOnlyHint: false } },
      { name: "no_read_additive", annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: "destructive", annotations: { destructiveHint: true } },
      { name: "contradictory", annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: "malformed", annotations: { readOnlyHint: null as never } },
      { name: "silent" },
      { name: "silent_not_destructive", annotations: { destructiveHint: false } },
      { name: "source_read", annotations: { readOnlyHint: true } },
    ];
    const connector: Connector = {
      id: "crm",
      listTools: async () => raw,
      callTool: async () => {
        sent++;
        return { ok: true };
      },
    };
    const classification = {
      crm: Object.fromEntries(raw.map((tool) => [tool.name, "read" as const])),
    };
    const registry = makeRegistry([connector], { classification, logger });
    const verdicts = async () =>
      Object.fromEntries(
        (await registry.getTools("crm", BASE, {})).map((tool) => [
          tool.name,
          [tool.classification, tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint],
        ]),
      );
    expect(await verdicts()).toEqual({
      no_read: ["write", false, true],
      no_read_additive: ["write", false, true],
      destructive: ["write", false, true],
      contradictory: ["write", false, true],
      malformed: ["write", false, true],
      silent: ["read", true, false],
      silent_not_destructive: ["read", true, false],
      source_read: ["read", true, false],
    });
    const warned = () => logger.warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('"read"'));
    expect(warned()).toHaveLength(5);
    expect(warned().join("\n")).toContain('"crm.no_read"');
    expect(warned().join("\n")).not.toContain('"crm.silent"');
    await verdicts();
    expect(warned()).toHaveLength(5);
    raw = raw.slice(0, 2);
    await verdicts();
    expect(warned()).toHaveLength(7);

    raw = [{ name: "no_read", annotations: { readOnlyHint: false } }];
    const readOnly = createMetaTools(registry, BASE, { readOnly: true });
    const refused = await readOnly.callTool({ address: "crm.no_read" });
    expect(refused.structuredContent).toMatchObject({ error: { code: "read_only_endpoint" } });
    const programs = new Map<string, Program>();
    const code = "async () => program";
    programs.set(code, (connecta) => connecta.call!("crm.no_read", {}));
    const execute = createExecuteTool(registry, BASE, scriptedExecutor(programs), silentLogger, undefined, {
      readOnly: true,
    });
    expect(value(await execute({ code })).error).toMatchObject({ code: "read_only_endpoint" });
    expect(sent).toBe(0);
  });

  it("INV-1: a static connector reports a refused read override once, at construction", async () => {
    const logger = { ...silentLogger, warn: vi.fn() };
    const connector = api("notes", {
      tools: [{ name: "update", description: "Update", annotations: { readOnlyHint: false }, handler: () => ({}) }],
    });
    const registry = makeRegistry([connector], { classification: { notes: { update: "read" } }, logger });
    const warned = () =>
      logger.warn.mock.calls.filter(([message]) => String(message).includes('"notes.update" to "read"'));
    expect(warned()).toHaveLength(1);
    await registry.getTools("notes", BASE, {});
    await registry.getTools("notes", BASE, {});
    expect(warned()).toHaveLength(1);
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
      { name: "mixed" },
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
