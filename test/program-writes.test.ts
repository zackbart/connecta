import { guestError, guestErrorText, guestFailureFacts, guestSource } from "./fixtures/misc.js";
// Program writes on writable and read-only endpoints, with one attempt and
// bounded outcome accounting.
import { describe, expect, it } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { recordToolActivity } from "../src/activity.js";
import { ConnectorCallError } from "../src/errors.js";
import { delegatesEachCall, knownProviderFailure } from "../src/provider-call.js";
import { createExecuteTool } from "../src/execute.js";
import { classifyWriteOutcome } from "../src/program-writes.js";
import { api } from "../src/connectors/api.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { createMetaTools } from "../src/meta-tools.js";
import { classifyTool } from "../src/tool-safety.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Executor, ExecutorProvider, ToolDef } from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";
import { machineAuth, TEST_MACHINE_NAMESPACE } from "./helpers/machine-auth.js";
import { privateArgumentCases, PRIVATE_MARKER } from "./fixtures/private-arguments.js";
import type { JsonSchema } from "../src/types.js";
import { CredentialVault } from "../src/credentials.js";
import { stripe } from "../src/providers/stripe/index.js";

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
  connectorReadOnly?: boolean;
  inputSchema?: JsonSchema;
  readOnly?: boolean;
  maxWrites?: number;
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
    ...(options.connectorReadOnly !== undefined ? { readOnly: options.connectorReadOnly } : {}),
    kind: "api",
    description: "Writes issues",
    async listTools() {
      return [
        {
          name: "close_issue",
          annotations: { readOnlyHint: false, destructiveHint: true },
          ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}),
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
    ...(options.maxWrites !== undefined ? { maxWrites: options.maxWrites } : {}),
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

const closeOne: Program = async (connecta) => {
  await connecta.call!("tracker.close_issue", { id: 1 });
  return "closed";
};

describe("a writable endpoint's program Stripe refund whose reply is lost", () => {
  it("INV-9: reports write_outcome_unknown with the generated Idempotency-Key, sent once", async () => {
    const storage = memoryStorage();
    const credentialVault = new CredentialVault(storage, btoa("k".repeat(32)));
    await credentialVault.set("billing", "rk_test_51abc", "test");
    const registry = makeRegistry(
      [stripe("billing", { purpose: "Refunds", auth: { type: "apiKey" }, mode: "sandbox" })],
      {
        storage,
        credentialVault,
      },
    );
    const sent: Headers[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const programs = new Map<string, Program>();
      const code = "async () => refund";
      programs.set(code, async (connecta) => {
        try {
          await connecta.call!("billing.stripe_api_write", {
            method: "POST",
            path: "/v1/refunds",
            body: { charge: "ch_1", amount: 1250 },
          });
        } catch {
          /* A guest cannot erase an unknown outcome. */
        }
        return "done";
      });
      const execute = createExecuteTool(registry, BASE, scriptedExecutor(programs), silentLogger, undefined, {
        readOnly: false,
      });
      const error = value(await execute({ code })).error;
      expect(sent).toHaveLength(1);
      const key = sent[0]!.get("idempotency-key");
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(error).toMatchObject({
        code: "write_outcome_unknown",
        writes: { succeeded: 0, failed: 0, unknown: 1 },
        uncertainCall: { address: "billing.stripe_api_write", recovery: { idempotencyKey: key } },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("a writable endpoint's program Stripe refund that meets an object lock", () => {
  it("INV-9: counts a lock_timeout as a failed write, not an unknown outcome", async () => {
    const storage = memoryStorage();
    const credentialVault = new CredentialVault(storage, btoa("k".repeat(32)));
    await credentialVault.set("billing", "rk_test_51abc", "test");
    const registry = makeRegistry(
      [stripe("billing", { purpose: "Refunds", auth: { type: "apiKey" }, mode: "sandbox" })],
      {
        storage,
        credentialVault,
      },
    );
    let sent = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      sent += 1;
      return Response.json({ error: { type: "invalid_request_error", code: "lock_timeout" } }, { status: 429 });
    }) as typeof fetch;
    try {
      const programs = new Map<string, Program>();
      const code = "async () => lockedRefund";
      programs.set(code, async (connecta) => {
        try {
          await connecta.call!("billing.stripe_api_write", {
            method: "POST",
            path: "/v1/refunds",
            body: { charge: "ch_1" },
          });
        } catch (error) {
          return { caught: (error as { code?: string }).code };
        }
        return "sent";
      });
      const execute = createExecuteTool(registry, BASE, scriptedExecutor(programs), silentLogger, undefined, {
        readOnly: false,
      });
      const result = await execute({ code });
      expect(sent).toBe(1);
      expect(JSON.stringify(result)).not.toContain("write_outcome_unknown");
      expect(JSON.stringify(result)).toContain("conflict");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("a program's write", () => {
  for (const { name, schema, args, echo } of privateArgumentCases)
    it(`INV-5 INV-6 INV-9: caught writes retain safe ${name} echoes and original-argument guidance`, async () => {
      const w = world({
        readOnly: false,
        inputSchema: schema,
        write: () => {
          throw new ConnectorCallError("timeout", "Synthetic write deadline.");
        },
      });
      const result = await w.run(async (connecta) => {
        for (let i = 0; i < 2; i++)
          try {
            await connecta.call!("tracker.close_issue", args);
          } catch {
            /* Guest cannot erase uncertainty. */
          }
        return "caught";
      });
      const error = value(result).error;
      const uncertain = {
        address: "tracker.close_issue",
        ...echo,
        ...(!("args" in echo) ? { argsOmitted: true } : {}),
      };
      expect(error).toMatchObject({
        code: "write_outcome_unknown",
        retryable: false,
        writes: { succeeded: 0, failed: 0, unknown: 2 },
        uncertainCalls: [uncertain, uncertain],
      });
      expect(error.message).toContain("original arguments");
      expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
      expect(JSON.parse(result.content[0]!.text!)).toEqual(result.structuredContent);
      expect(w.writes()).toEqual([
        { address: "tracker.close_issue", args },
        { address: "tracker.close_issue", args },
      ]);
      expect(w.events.map((event) => event.attempts)).toEqual([1, 1]);
      expect(JSON.stringify(w.events)).not.toContain(PRIVATE_MARKER);
    });
  it("INV-1 INV-2: connector readOnly refuses program writes and unclassified tools on a writable endpoint", async () => {
    const w = world({ connectorReadOnly: true, readOnly: false });
    expect(value(await w.run(closeOne)).error).toMatchObject({ code: "read_only_endpoint", retryable: false });
    const result = await w.run(async (connecta) => {
      try {
        await connecta.call!("tracker.post", {});
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(value(result).result).toBe("read_only_endpoint");
    expect(w.writes()).toEqual([]);
  });

  it("INV-2: is refused on a read-only endpoint before it is sent, offering no write route", async () => {
    const w = world({ readOnly: true });
    const result = await w.run(closeOne);
    expect(result.isError).toBe(true);
    expect(value(result).error).toMatchObject({ code: "read_only_endpoint", retryable: false });
    expect(value(result).error).not.toHaveProperty("nextAction");
    expect(w.writes()).toEqual([]);
    // An ordinary refused attempt, recorded payload-free.
    expect(w.events.map((event) => [event.address, event.outcome, event.errorCode, event.friction])).toEqual([
      ["tracker.close_issue", "error", "read_only_endpoint", undefined],
    ]);
  });

  it("INV-2: is refused on a read-only endpoint for an unannotated tool too, and a caught refusal lets the program go on", async () => {
    const w = world({ readOnly: true });
    const result = await w.run(async (connecta) => {
      const issue = await connecta.call!("reader.get", { id: 7 });
      try {
        await connecta.call!("tracker.post", { text: issue.title });
        return "posted";
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(value(result).result).toBe("read_only_endpoint");
    expect(w.writes()).toEqual([]);
  });

  it("INV-2: runs when the host route threads no readOnly, as on a writable endpoint", async () => {
    const w = world();
    expect(value(await w.run(closeOne)).result).toBe("closed");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
  });
});

describe("writable-endpoint programs (#706, #820)", () => {
  it("INV-2: runs a program write on a writable endpoint, recorded as an ordinary call", async () => {
    const w = world({ readOnly: false });
    expect(value(await w.run(closeOne)).result).toBe("closed");
    expect(w.writes()).toEqual([{ address: "tracker.close_issue", args: { id: 1 } }]);
    expect(w.events.map((event) => [event.address, event.outcome, event.source])).toEqual([
      ["tracker.close_issue", "success", "execute_code"],
    ]);
  });

  it("INV-2: permits every write on a writable endpoint", async () => {
    const w = world({ readOnly: false });
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
    expect(w.writes()).toEqual([
      { address: "tracker.close_issue", args: { id: 1 } },
      { address: "tracker.post", args: { text: "x" } },
    ]);
  });

  it("spends the write budget", async () => {
    const w = world({ maxWrites: 1, readOnly: false });
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

  it("puts write counts on the error of a program that fails after writing", async () => {
    const w = world({ readOnly: false });
    const failed = await w.run(async (connecta) => {
      await connecta.call!("tracker.close_issue", { id: 1 });
      throw new Error("the program gave up");
    });
    expect(failed.isError).toBe(true);
    expect(value(failed).error).toMatchObject({
      writes: { succeeded: 1, failed: 0, unknown: 0 },
    });
  });

  it("INV-2: keeps writes out of call_tool even on writable endpoints", async () => {
    const w = world({ readOnly: false });
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
    const notes = api("notes", {
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => [] }],
    });
    const construct = (options: unknown) =>
      createConnecta({ readOnly: false, connectors: [notes], executor, logger: "silent", ...(options as object) });
    expect(() => construct({ execute: { approval: { notes: "never" } } })).toThrow("ConnectaConfig.execute.approval");
    expect(() => construct({ classification: { nope: { read: "read" } } })).toThrow('unknown connector "nope"');
    expect(() => construct({ classification: { notes: { missing: "read" } } })).toThrow('has no tool "missing"');
    expect(() => construct({ classification: { notes: { read: "never" } } })).toThrow('must be "read" or "write"');
    expect(() => construct({ readOnly: "yes" })).toThrow("ConnectaConfig.readOnly must be true or false");
    expect(() => construct({ pools: { named: { tools: ["notes"], readOnly: 1 } } })).toThrow(
      "ConnectaConfig.pools.named.readOnly must be true or false",
    );
    expect(() => construct({ connectors: [{ ...notes, approval: "never" }] })).toThrow("approval was removed");
  });

  it.each([
    ["the deployment", (trust: unknown) => ({ trust }), "ConnectaConfig.trust"],
    [
      "a pool",
      (trust: unknown) => ({
        pools: { named: { tools: ["notes"], members: [{ namespace: "people", id: "alice" }], trust } },
      }),
      "ConnectaConfig.pools.named.trust",
    ],
  ])("INV-11: refuses the retired trust option on %s, pointing at readOnly", (_where, config, path) => {
    const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
    const notes = api("notes", {
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => [] }],
    });
    for (const trust of ["trusted", "read-only", undefined]) {
      const construct = () =>
        (createConnecta as (config: unknown) => unknown)({
          connectors: [notes],
          executor,
          logger: "silent",
          ...config(trust),
        });
      expect(construct).toThrow(path);
      expect(construct).toThrow('trust: "read-only" becomes readOnly: true');
      expect(construct).toThrow('trust: "trusted" becomes readOnly: false');
    }
  });
});

describe("write outcomes", () => {
  it("INV-9: classifies a write's outcome by what is known", () => {
    const table: Array<[Parameters<typeof classifyWriteOutcome>[0], string]> = [
      [{ ok: true, dispatched: true }, "ok"],
      [{ ok: false, dispatched: false, error: { code: "timeout" } }, "failed"],
      [{ ok: false, dispatched: true, error: { code: "timeout" } }, "unknown"],
      [{ ok: false, dispatched: true, error: { code: "cancelled" } }, "unknown"],
      // Refusal provenance (`answered`: the ledger proved it unsent, a served
      // 4xx other than 408 refused it, or the tool answered isError) decides,
      // whatever the code: a pre-dispatch deadline or connect failure applied
      // nothing.
      [{ ok: false, dispatched: true, answered: true, error: { code: "timeout" } }, "failed"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "unavailable" } }, "failed"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "connector_call_failed" } }, "failed"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "rate_limited" } }, "failed"],
      // A typed error after the request went out (an oversized body, a
      // refused redirect) is not an answer: the write may have landed.
      [{ ok: false, dispatched: true, answered: false, error: { code: "connector_call_failed" } }, "unknown"],
      // Nor is a refusal code by itself (round 11): a mapper, parser, or
      // output validator can throw it after the write applied.
      [{ ok: false, dispatched: true, answered: false, error: { code: "not_found" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "invalid_args" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "rate_limited" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: false, error: { code: "conflict" } }, "unknown"],
      [{ ok: false, dispatched: true, error: { code: "result_processing_failed" } }, "ok"],
      // An authorization verdict reached after the write left (a 401, then a
      // failed renewal) keeps its code, but the connector says the write's
      // outcome is unknown, and that wins over the refusal.
      [
        { ok: false, dispatched: true, error: { code: "downstream_oauth_required", writeOutcome: "unknown" } },
        "unknown",
      ],
      [{ ok: false, dispatched: true, error: { code: "auth_required", writeOutcome: "unknown" } }, "unknown"],
      [{ ok: false, dispatched: true, error: { code: "auth_required" } }, "unknown"],
      [{ ok: false, dispatched: true, answered: true, error: { code: "auth_required" } }, "failed"],
      [{ ok: false, dispatched: false, error: { code: "auth_required", writeOutcome: "unknown" } }, "failed"],
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
    const connecta = createConnecta({
      readOnly: false,
      connectors: [],
      executor: customExecutor(executor, { lifecycle: "self-managed" }),
      logger: "silent",
    });
    const listed = (await readJsonRpc(await mcpRpc(connecta, "tools/list", {}))) as {
      result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
    };
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("resume_execution");
    // A default endpoint is writable, so execute_code is annotated as a write.
    expect(listed.result.tools.find((tool) => tool.name === "execute_code")?.annotations?.readOnlyHint).toBe(false);
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
    expect(first.map((tool) => tool.classification)).toEqual(["write", "read", "write"]);
    first[0]!.classification = "read";
    first[1]!.annotations!.readOnlyHint = false;
    raw[0]!.annotations!.readOnlyHint = false;
    const second = await registry.getTools("test", BASE, {});
    expect(second.map((tool) => tool.classification)).toEqual(["write", "read", "write"]);
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
      id: "reviewed",
      listTools: async () => raw,
      callTool: async () => null,
      classification: {
        tools: {
          lapsed: { verdict: "read", schemaDigest: `sha256:${"0".repeat(64)}` },
          mislabeled: "write",
          mixed: "write",
        },
      },
    };
    const registry = makeRegistry([connector], {
      classification: {
        reviewed: { lapsed: "read", mixed: "read", constructor: "read" as const },
      },
    });
    const tools = await registry.getTools("reviewed", BASE, {});
    expect(tools.map((tool) => tool.classification)).toEqual(["read", "write", "read", "read"]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const without = makeRegistry([connector]);
    expect((await without.getTools("reviewed", BASE, {})).map((tool) => tool.classification)).toEqual([
      "write",
      "write",
      "write",
      "write",
    ]);
  });

  it("INV-11 INV-8: refuses an entire remote catalog with an unknown override", async () => {
    const connector: Connector = {
      id: "remote",
      listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
      callTool: async () => null,
    };
    const registry = makeRegistry([connector], { classification: { remote: { missing: "read" } } });
    await expect(registry.getTools("remote", BASE, {})).rejects.toThrow('has no tool "missing"');
    await expect(registry.getTools("remote", BASE, {})).rejects.toThrow('has no tool "missing"');
  });
});

describe("read-only and writable endpoints (#820)", () => {
  const PROGRAMS = new Map<string, Program>([
    [
      "async () => write",
      async (connecta) => {
        await connecta.call!("notes.write", { text: "x" });
        return "written";
      },
    ],
    ["async () => guide", async (connecta) => (await connecta.skill!("connector:notes")).text],
    [
      "async () => discover",
      async (connecta) => {
        const page = await connecta.search!({ connector: "notes", query: "", safety: "all" });
        const described = await connecta.describe!({ addresses: ["notes.write", "notes.read"] });
        return {
          visible: page.tools.map((tool: { address: string }) => tool.address).sort(),
          described: described.tools.map((tool: { address: string; errorDetails?: { code: string } }) =>
            tool.errorDetails ? tool.errorDetails.code : tool.address,
          ),
        };
      },
    ],
  ]);

  const TOKEN = "endpoint-caller";
  const CALLER = { namespace: TEST_MACHINE_NAMESPACE, id: "machine" };
  function deployment(config: { readOnly: boolean; pools: Record<string, { readOnly?: boolean }> }) {
    let writes = 0;
    const notes = api("notes", {
      // A guide is documentation: it names the write on every endpoint.
      usageGuide: "Close a note with notes.write; pass its text.",
      tools: [
        { name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => "read" },
        {
          name: "write",
          description: "Write",
          annotations: { readOnlyHint: false },
          // Required input: a refusal ahead of validation never reports invalid_args.
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          handler: () => {
            writes++;
            return "written";
          },
        },
      ],
    });
    const app = createConnecta({
      connectors: [notes],
      logger: "silent",
      executor: customExecutor(scriptedExecutor(PROGRAMS), { lifecycle: "self-managed" }),
      readOnly: config.readOnly,
      // Pools need inbound auth: one bearer caller is the maintainer and every pool's member.
      auth: machineAuth(TOKEN),
      maintainers: [CALLER],
      pools: Object.fromEntries(
        Object.entries(config.pools).map(([name, pool]) => [name, { tools: ["notes"], members: [CALLER], ...pool }]),
      ),
    });
    const rpc = async (path: string, method: string, params: unknown) =>
      readJsonRpc(
        await app.fetch(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: `Bearer ${TOKEN}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        ),
      ) as Promise<any>;
    return { app, rpc, writes: () => writes };
  }

  /** Search and describe omit the write, and every write path refuses it before validation or dispatch. */
  async function expectReadOnly(target: ReturnType<typeof deployment>, path: string) {
    const before = target.writes();
    const listing = await target.rpc(path, "tools/list", {});
    expect(listing.result.tools).toHaveLength(6);
    const execute = listing.result.tools.find((tool: { name: string }) => tool.name === "execute_code");
    expect(execute.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(execute.description).toContain("Read-only endpoint");
    const search = await target.rpc(path, "tools/call", {
      name: "search_tools",
      arguments: { connector: "notes", query: "", safety: "all" },
    });
    expect(search.result.structuredContent.tools.map((tool: { address: string }) => tool.address)).toEqual([
      "notes.read",
    ]);
    const discovered = await target.rpc(path, "tools/call", {
      name: "execute_code",
      arguments: { code: "async () => discover" },
    });
    expect(discovered.result.structuredContent.result).toEqual({
      visible: ["notes.read"],
      described: ["unknown_tool", "notes.read"],
    });
    for (const name of ["call_tool", "call_destructive_tool"]) {
      const refused = await target.rpc(path, "tools/call", { name, arguments: { address: "notes.write", args: {} } });
      expect(refused.result.isError).toBe(true);
      expect(refused.result.structuredContent.error).toMatchObject({ code: "read_only_endpoint", retryable: false });
      expect(refused.result.structuredContent.error).not.toHaveProperty("nextAction");
    }
    const program = await target.rpc(path, "tools/call", {
      name: "execute_code",
      arguments: { code: "async () => write" },
    });
    expect(program.result.isError).toBe(true);
    expect(program.result.structuredContent.error).toMatchObject({ code: "read_only_endpoint", retryable: false });
    expect(program.result.structuredContent.error).not.toHaveProperty("nextAction");
    expect(target.writes()).toBe(before);
    // Reads are unchanged.
    const read = await target.rpc(path, "tools/call", { name: "call_tool", arguments: { address: "notes.read" } });
    expect(read.result.isError).toBeFalsy();
  }

  /** Writes behave as a trusted pool's did: programs and call_destructive_tool send them, call_tool never. */
  async function expectWritable(target: ReturnType<typeof deployment>, path: string) {
    const before = target.writes();
    const listing = await target.rpc(path, "tools/list", {});
    expect(listing.result.tools).toHaveLength(6);
    const execute = listing.result.tools.find((tool: { name: string }) => tool.name === "execute_code");
    expect(execute.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(execute.description).toContain("Writable endpoint");
    const search = await target.rpc(path, "tools/call", {
      name: "search_tools",
      arguments: { connector: "notes", query: "", safety: "all" },
    });
    expect(search.result.structuredContent.tools.map((tool: { address: string }) => tool.address).sort()).toEqual([
      "notes.read",
      "notes.write",
    ]);
    const direct = await target.rpc(path, "tools/call", {
      name: "call_tool",
      arguments: { address: "notes.write", args: { text: "x" } },
    });
    expect(direct.result.structuredContent.error).toMatchObject({ code: "destructive_tool_requires_approval" });
    const approved = await target.rpc(path, "tools/call", {
      name: "call_destructive_tool",
      arguments: { address: "notes.write", args: { text: "x" } },
    });
    expect(approved.result.isError).toBeFalsy();
    const program = await target.rpc(path, "tools/call", {
      name: "execute_code",
      arguments: { code: "async () => write" },
    });
    expect(program.result.structuredContent.result).toBe("written");
    expect(target.writes()).toBe(before + 2);
  }

  it("INV-2 INV-4 INV-9: a writable deployment writes, and a pool inherits it unless it sets readOnly", async () => {
    const target = deployment({ readOnly: false, pools: { inherits: {}, locked: { readOnly: true } } });
    try {
      await expectWritable(target, "/mcp");
      await expectWritable(target, "/mcp/inherits");
      await expectReadOnly(target, "/mcp/locked");
      expect(target.app.describeConfig()).toMatchObject({
        readOnly: false,
        pools: [
          { name: "inherits", readOnly: false },
          { name: "locked", readOnly: true },
        ],
      });
    } finally {
      await target.app.close();
    }
  });

  it("INV-2: a write a guide names is still refused on a read-only endpoint, root and pooled", async () => {
    for (const [config, path] of [
      [{ readOnly: true, pools: {} }, "/mcp"],
      [{ readOnly: false, pools: { locked: { readOnly: true } } }, "/mcp/locked"],
    ] as const) {
      const target = deployment(config);
      try {
        // Guides are documentation, not discovery: they may name a write the endpoint refuses.
        const skill = await target.rpc(path, "tools/call", { name: "skills", arguments: { name: "connector:notes" } });
        expect(JSON.stringify(skill.result)).toContain("notes.write");
        const guide = await target.rpc(path, "tools/call", {
          name: "execute_code",
          arguments: { code: "async () => guide" },
        });
        expect(guide.result.structuredContent.result).toContain("notes.write");
        await expectReadOnly(target, path);
        expect(target.writes()).toBe(0);
      } finally {
        await target.app.close();
      }
    }
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

  it("INV-2 INV-4 INV-9: a read-only deployment omits writes from search and refuses them, and a pool can reopen them", async () => {
    const target = deployment({ readOnly: true, pools: { inherits: {}, open: { readOnly: false } } });
    try {
      await expectReadOnly(target, "/mcp");
      await expectReadOnly(target, "/mcp/inherits");
      await expectWritable(target, "/mcp/open");
      expect(target.app.describeConfig()).toMatchObject({
        readOnly: true,
        pools: [
          { name: "inherits", readOnly: true },
          { name: "open", readOnly: false },
        ],
      });
    } finally {
      await target.app.close();
    }
  });
});

it("INV-6 INV-9: caught write timeouts retain uncertain arguments in host-owned write accounting", async () => {
  const w = world({
    readOnly: false,
    write: async () => {
      throw new ConnectorCallError("timeout", "deadline");
    },
  });
  const result = await w.run(async (connecta) => {
    try {
      await connecta.call!("tracker.close_issue", { id: 42, note: "argument-sentinel" });
    } catch {
      return "handled";
    }
    return "unreachable";
  });
  expect(value(result).error).toMatchObject({
    code: "write_outcome_unknown",
    retryable: false,
    uncertainCall: { address: "tracker.close_issue", args: { id: 42, note: "argument-sentinel" } },
  });
  expect(w.writes()).toHaveLength(1);
  expect(JSON.stringify(w.events)).not.toContain("argument-sentinel");
});
