// The guest API contract cases from documentation/code-mode.md, written once
// and run against every executor. Each case names the clauses it verifies; a
// case that behaves differently under two executors is either a bug or a
// documented exception in that guide.

import { expect } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import type { Connector, Executor, ToolDef } from "../src/types.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

export const CONTRACT_BASE = "https://connecta.contract";

export interface ContractState {
  /** Calls that reached a connector, by canonical address. */
  calls: Record<string, number>;
  events: ToolCallActivityEvent[];
}

/** What the model receives: the parsed tool result of one execute_code call. */
export interface ContractOutcome {
  isError: boolean;
  text: string;
  value: Record<string, unknown>;
  result: unknown;
  /** The full content array, envelope first — where emitted blocks land. */
  content: Array<Record<string, unknown>>;
}

export interface ContractCase {
  clauses: string;
  name: string;
  code: string;
  /** A second program run on the same executor, for cross-run clauses. */
  follows?: string;
  /** Set for the cases that need a short-deadline executor. */
  deadline?: true;
  check(
    outcome: ContractOutcome,
    state: ContractState,
    follow?: ContractOutcome,
  ): void;
}

function readOnly(name: string, extra: Partial<ToolDef> = {}): ToolDef {
  return { name, annotations: { readOnlyHint: true }, ...extra };
}

function contractConnectors(state: ContractState): Connector[] {
  const count = (address: string) => {
    state.calls[address] = (state.calls[address] ?? 0) + 1;
  };
  const reader: Connector = {
    id: "reader",
    kind: "api",
    description: "Reader",
    usageGuide: "# Reader usage\n\nRead one value at a time.",
    async listTools() {
      return [
        readOnly("read", {
          description: "Read one value back",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        }),
        readOnly("big", {
          description: "Return a large blob",
          inputSchema: {
            type: "object",
            properties: { chars: { type: "number" } },
          },
        }),
        readOnly("flaky", { description: "Always unavailable" }),
        {
          name: "wipe",
          description: "Delete everything",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        { name: "unannotated", description: "No annotations at all" },
      ];
    },
    async callTool(name, args) {
      count(`reader.${name}`);
      if (name === "read") return { echo: (args as { value: string }).value };
      if (name === "big") {
        const chars = (args as { chars?: number }).chars ?? 1_000;
        return { blob: "x".repeat(chars) };
      }
      if (name === "flaky") {
        throw new ConnectorCallError("unavailable", "Reader is unavailable");
      }
      return { done: true };
    },
  };
  const remote: Connector = {
    id: "remote",
    kind: "mcp",
    description: "Remote echo",
    async listTools() {
      return [
        readOnly("echo", {
          description: "Echo as MCP text content",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              options: {
                type: "object",
                properties: { uppercase: { type: "boolean" } },
                required: ["uppercase"],
              },
            },
            required: ["text", "options"],
          },
        }),
      ];
    },
    async callTool(name, args) {
      count(`remote.${name}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ said: (args as { text: string }).text }),
          },
        ],
      };
    },
  };
  const collide: Connector = {
    id: "collide",
    kind: "api",
    description: "Two tools, one alias",
    async listTools() {
      return [readOnly("get.thing"), readOnly("get-thing")];
    },
    async callTool(name) {
      count(`collide.${name}`);
      return { which: name === "get.thing" ? "dot" : "dash" };
    },
  };
  const odd: Connector = {
    id: "odd-service",
    kind: "api",
    description: "Needs sanitizing",
    async listTools() {
      return [readOnly("get.thing")];
    },
    async callTool() {
      count("odd-service.get.thing");
      return { thing: true };
    },
  };
  const needsAuth: Connector = {
    id: "needsauth",
    kind: "mcp",
    description: "Credential is missing",
    async listTools() {
      return [readOnly("read")];
    },
    async callTool() {
      count("needsauth.read");
      throw new ConnectorCallError(
        "auth_required",
        "Downstream rejected the stored grant.",
      );
    },
    async startAuth() {
      return {
        state: "auth_required",
        authorizationUrl: "https://auth.example/authorize",
      };
    },
  };
  const badCatalog: Connector = {
    id: "badcatalog",
    kind: "api",
    description: "Its catalog cannot be loaded",
    async listTools() {
      throw new Error("catalog is unreachable");
    },
    async callTool() {
      count("badcatalog.read");
      return { done: true };
    },
  };
  // Declares a credential with no vault behind it, so connecta cannot supply
  // one and refuses before dispatch.
  const needsStore: Connector = {
    id: "needsstore",
    kind: "api",
    description: "Wants a credential this deployment cannot store",
    credential: { label: "API token" },
    async listTools() {
      return [readOnly("read")];
    },
    async callTool() {
      count("needsstore.read");
      return { done: true };
    },
  };
  // An id whose text trips the retryable-message heuristic. A policy refusal
  // about this connector must still report retryable: false.
  const retryableLooking: Connector = {
    id: "temporary-503-service",
    kind: "api",
    description: "Its name looks like a transient failure",
    async listTools() {
      return [
        readOnly("read"),
        {
          name: "wipe",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ];
    },
    async callTool(name) {
      count(`temporary-503-service.${name}`);
      return { done: true };
    },
  };
  const hang: Connector = {
    id: "hang",
    kind: "api",
    description: "Never answers",
    async listTools() {
      return [readOnly("read")];
    },
    async callTool() {
      count("hang.read");
      return new Promise<never>(() => {});
    },
  };
  return [
    reader,
    remote,
    collide,
    odd,
    needsAuth,
    badCatalog,
    needsStore,
    retryableLooking,
    hang,
  ];
}

/** One fresh registry, activity sink, and call counter per case. */
export function contractHarness(): {
  state: ContractState;
  run: (executor: Executor, code: string) => Promise<ContractOutcome>;
} {
  const state: ContractState = { calls: {}, events: [] };
  const activity: ActivityRequestContext = {
    sink: {
      record: (event) => {
        state.events.push(event);
      },
    },
    actor: { kind: "contract" },
    requestId: "contract-request",
    serverInfo: { name: "connecta-contract", version: "0" },
    logger: silentLogger,
  };
  const registry = makeRegistry(contractConnectors(state));
  return {
    state,
    run: async (executor, code) => {
      const handler = createExecuteTool(
        registry,
        CONTRACT_BASE,
        executor,
        silentLogger,
        activity,
      );
      const out = await handler({ code });
      const text = required(out.content[0]).text ?? "";
      let value: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object") {
          value = parsed as Record<string, unknown>;
        }
      } catch {
        value = {};
      }
      return {
        isError: out.isError === true,
        text,
        value,
        result: value.result,
        content: out.content as unknown as Array<Record<string, unknown>>,
      };
    },
  };
}

function record(outcome: ContractOutcome): Record<string, unknown> {
  expect(outcome.isError, outcome.text).toBe(false);
  expect(outcome.result, outcome.text).toBeTypeOf("object");
  return outcome.result as Record<string, unknown>;
}

export const CONTRACT_CASES: ContractCase[] = [
  {
    clauses: "P1",
    name: "TypeScript syntax is not JavaScript and does not run",
    code: `async () => {
      const value: number = 1;
      return value;
    }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.result).toBeUndefined();
    },
  },
  {
    clauses: "P4",
    name: "nothing a program leaves behind reaches the next one",
    code: `async () => {
      globalThis.leakedByContractCase = "yes";
      return typeof globalThis.leakedByContractCase;
    }`,
    follows: `async () => ({ leaked: typeof globalThis.leakedByContractCase })`,
    check(outcome, _state, follow) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toBe("string");
      const second = required(follow, "follow-up outcome");
      expect(second.isError, second.text).toBe(false);
      expect(second.result).toEqual({ leaked: "undefined" });
    },
  },
  {
    clauses: "A1, A2, S5",
    name: "canonical addresses and shortcuts reach the same tool",
    code: `async () => ({
      canonical: await connecta.call("reader.read", { value: "x" }),
      shortcut: await reader.read({ value: "x" }),
      unwrapped: await connecta.call("remote.echo", {
        text: "hi",
        options: { uppercase: false }
      })
    })`,
    check(outcome) {
      const result = record(outcome);
      expect(result.canonical).toEqual({ echo: "x" });
      expect(result.shortcut).toEqual({ echo: "x" });
      expect(result.unwrapped).toEqual({ said: "hi" });
    },
  },
  {
    clauses: "A1, A2",
    name: "sanitized shortcut names keep the unsanitized address callable",
    code: `async () => ({
      shortcut: await odd_service.get_thing({}),
      canonical: await connecta.call("odd-service.get.thing", {})
    })`,
    check(outcome) {
      const result = record(outcome);
      expect(result.shortcut).toEqual({ thing: true });
      expect(result.canonical).toEqual({ thing: true });
    },
  },
  {
    clauses: "A3",
    name: "an ambiguous shortcut fails closed and names the escape hatch",
    code: `async () => {
      const out = {};
      try { await collide.get_thing({}); } catch (err) { out.thrown = err.message; }
      out.dotted = await connecta.call("collide.get.thing", {});
      out.dashed = await connecta.call("collide.get-thing", {});
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(String(result.thrown)).toContain("ambiguous");
      expect(String(result.thrown)).toContain("connecta.call");
      expect(result.dotted).toEqual({ which: "dot" });
      expect(result.dashed).toEqual({ which: "dash" });
    },
  },
  {
    clauses: "E4, S6",
    name: "tools that are not explicitly read-only are refused either way",
    code: `async () => {
      const out = {};
      try { await reader.wipe({}); } catch (err) { out.shortcut = err.message; }
      try { await connecta.call("reader.unannotated", {}); } catch (err) { out.canonical = err.message; }
      return out;
    }`,
    check(outcome, state) {
      const result = record(outcome);
      for (const message of [result.shortcut, result.canonical]) {
        expect(String(message)).toContain("not explicitly read-only");
        expect(String(message)).toContain("call_destructive_tool");
      }
      expect(state.calls["reader.wipe"]).toBeUndefined();
      expect(state.calls["reader.unannotated"]).toBeUndefined();
    },
  },
  {
    clauses: "E2",
    name: "unknown addresses and unknown tools are distinguishable",
    code: `async () => {
      const out = {};
      try { await connecta.call("nope.read", {}); } catch (err) { out.address = err.message; }
      try { await connecta.call("reader.nope", {}); } catch (err) { out.tool = err.message; }
      try { await reader.nope({}); } catch (err) { out.shortcut = err.message; }
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(String(result.address)).toContain('Unknown address "nope.read"');
      expect(String(result.tool)).toContain(
        'Unknown tool "nope" on connector "reader"',
      );
      expect(String(result.shortcut)).toContain('Unknown tool "nope"');
    },
  },
  {
    clauses: "E1, E2, E3, E8, S7, S8, Y2, Y3",
    name: "batch outcomes carry typed, distinguishable failures",
    code: `async () => {
      const outcomes = await connecta.batch([
        { address: "reader.read", args: { value: "ok" } },
        { address: "reader.wipe", args: {} },
        { address: "reader.flaky", args: {} },
        { address: "needsauth.read", args: {} },
        { address: "nope.read", args: {} },
        {
          address: "remote.echo",
          args: {
            options: {
              uppercase: "submitted-secret"
            }
          }
        }
      ]);
      return outcomes.map((outcome) => outcome.ok
        ? { address: outcome.address, ok: true, data: outcome.data }
        : {
            address: outcome.address,
            ok: false,
            error: outcome.error,
            code: outcome.errorDetails.code,
            retryable: outcome.errorDetails.retryable,
            recovery: outcome.errorDetails.recovery,
            validation: outcome.errorDetails.validation,
            nextAction: outcome.errorDetails.nextAction
              ? outcome.errorDetails.nextAction.tool
              : undefined
          });
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      const outcomes = outcome.result as Array<Record<string, unknown>>;
      expect(outcomes).toHaveLength(6);
      expect(required(outcomes[0])).toMatchObject({
        address: "reader.read",
        ok: true,
        data: { echo: "ok" },
      });
      expect(required(outcomes[1])).toMatchObject({
        ok: false,
        code: "destructive_tool_requires_approval",
        retryable: false,
      });
      expect(required(outcomes[2])).toMatchObject({
        ok: false,
        code: "unavailable",
        retryable: true,
      });
      expect(required(outcomes[3])).toMatchObject({
        ok: false,
        code: "auth_required",
        retryable: false,
        recovery: "oauth",
        nextAction: "authorize_connector",
      });
      expect(required(outcomes[4])).toMatchObject({
        ok: false,
        code: "unknown_address",
        retryable: false,
      });
      expect(required(outcomes[5])).toMatchObject({
        ok: false,
        code: "invalid_args",
        retryable: false,
        nextAction: "search_tools",
        validation: {
          issues: [
            { path: "/text", code: "required", expected: "string" },
            {
              path: "/options/uppercase",
              code: "type",
              expected: "boolean",
            },
          ],
        },
      });
      expect(JSON.stringify(required(outcomes[5]))).not.toContain(
        "submitted-secret",
      );
      expect(state.calls["remote.echo"]).toBeUndefined();
      // The message a program can log stays beside the type it must branch on.
      expect(String(required(outcomes[2]).error)).toContain("unavailable");
    },
  },
  {
    clauses: "S7",
    name: "a batch over ten calls is refused",
    code: `async () => {
      const calls = [];
      for (let index = 0; index < 11; index += 1) {
        calls.push({ address: "reader.read", args: { value: String(index) } });
      }
      try { await connecta.batch(calls); } catch (err) { return { thrown: err.message }; }
      return { thrown: "none" };
    }`,
    check(outcome, state) {
      const result = record(outcome);
      expect(String(result.thrown)).toContain("at most 10");
      expect(state.calls["reader.read"]).toBeUndefined();
    },
  },
  {
    clauses: "S1, S2",
    name: "search returns guide and code-mode key metadata on flat rows",
    code: `async () => {
      const page = await connecta.search({
        query: "read value",
        connector: "reader",
        includeSchemas: "compact"
      });
      const bare = await connecta.search({
        query: "read value",
        connector: "reader",
        includeSchemas: "compact",
        includeSchemaKeys: false
      });
      const match = page.tools.filter((tool) => tool.address === "reader.read")[0];
      return {
        pageKeys: Object.keys(page).sort(),
        address: match.address,
        inputKeys: match.inputKeys,
        requiredInputKeys: match.requiredInputKeys,
        hasSchema: typeof match.inputSchema,
        guide: match.guide,
        bareCarriesKeys: bare.tools.some((tool) => tool.inputKeys !== undefined)
      };
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(result.pageKeys).toEqual(
        expect.arrayContaining(["hasMore", "limit", "offset", "tools", "total"]),
      );
      expect(result.address).toBe("reader.read");
      expect(result.inputKeys).toEqual(["value"]);
      expect(result.requiredInputKeys).toEqual(["value"]);
      expect(result.hasSchema).toBe("string");
      expect(result.guide).toBe("connector:reader");
      expect(result.bareCarriesKeys).toBe(false);
    },
  },
  {
    clauses: "E1, E2, E8",
    name: "an uncaught remote argument mismatch keeps structured recovery",
    code: `async () => await connecta.call("remote.echo", {
      text: "private-value",
      options: { uppercase: "private-secret" }
    })`,
    check(outcome, state) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({
        code: "invalid_args",
        retryable: false,
        connector: "remote",
        operation: "remote.echo",
        validation: {
          issues: [
            {
              path: "/options/uppercase",
              code: "type",
              expected: "boolean",
            },
          ],
        },
        nextAction: {
          tool: "search_tools",
          arguments: {
            query: "echo",
            connector: "remote",
            includeSchemas: "compact",
          },
        },
      });
      expect(outcome.text).not.toContain("private-value");
      expect(outcome.text).not.toContain("private-secret");
      expect(state.calls["remote.echo"]).toBeUndefined();
    },
  },
  {
    // The discovery path a model used to reach through `list_connectors`, which
    // the code-first surface folded away (#224). An unfiltered browse is the
    // replacement: it names every connector a program can reach and how many
    // tools each one has, which is the part of that tool a model ever used.
    clauses: "S1, S2",
    name: "an unfiltered browse enumerates the deployment's connectors",
    code: `async () => {
      const page = await connecta.search({ limit: 100 });
      const byConnector = {};
      for (const tool of page.tools) {
        const connector = tool.address.slice(0, tool.address.indexOf("."));
        byConnector[connector] = (byConnector[connector] ?? 0) + 1;
      }
      const scoped = await connecta.search({ connector: "reader", limit: 100 });
      return {
        connectors: Object.keys(byConnector).sort(),
        readerTools: byConnector.reader,
        total: page.total,
        scopedConnectors: scoped.tools
          .map((tool) => tool.address.slice(0, tool.address.indexOf(".")))
          .filter((id, index, all) => all.indexOf(id) === index)
      };
    }`,
    check(outcome) {
      const result = record(outcome);
      // Every connector whose catalog loads, not merely the ones a query
      // happened to match. badcatalog throws on listTools and so has no tools
      // to browse; its absence here is the complete-or-failure rule holding,
      // not a gap in the browse.
      expect(result.connectors).toEqual([
        "collide",
        "hang",
        "needsauth",
        "needsstore",
        "odd-service",
        "reader",
        "remote",
        "temporary-503-service",
      ]);
      expect(result.readerTools).toBe(5);
      expect(result.total).toBeGreaterThan(5);
      expect(result.scopedConnectors).toEqual(["reader"]);
    },
  },
  {
    clauses: "S4",
    name: "describe answers per address and reports bad ones inline",
    code: `async () => {
      const described = await connecta.describe({
        addresses: ["reader.read", "nope.read", "reader.nope"]
      });
      return described.tools.map((tool) => ({
        address: tool.address,
        hasSchema: tool.inputSchema !== undefined,
        error: tool.error
      }));
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      const tools = outcome.result as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(3);
      expect(required(tools[0])).toMatchObject({
        address: "reader.read",
        hasSchema: true,
      });
      expect(required(tools[0]).error).toBeUndefined();
      expect(String(required(tools[1]).error)).toContain("Unknown address");
      expect(String(required(tools[2]).error)).toContain("Unknown tool");
    },
  },
  {
    clauses: "L4",
    name: "the host-call budget stops the twenty-first call",
    code: `async () => {
      let succeeded = 0;
      let failure = "none";
      for (let index = 0; index < 22; index += 1) {
        try {
          await reader.read({ value: String(index) });
          succeeded += 1;
        } catch (err) {
          failure = err.message;
          break;
        }
      }
      const [spent] = await connecta.batch([
        { address: "reader.read", args: { value: "after" } }
      ]);
      return {
        succeeded: succeeded,
        failure: failure,
        spentCode: spent.errorDetails.code,
        spentRetryable: spent.errorDetails.retryable
      };
    }`,
    check(outcome, state) {
      const result = record(outcome);
      expect(result.succeeded).toBe(20);
      expect(String(result.failure)).toContain("budget");
      expect(state.calls["reader.read"]).toBe(20);
      // Budget exhaustion is framed as connector_call_failed even though no
      // connector was reached — L4 says so rather than leaving it to be found.
      expect(result.spentCode).toBe("connector_call_failed");
      expect(result.spentRetryable).toBe(false);
    },
  },
  {
    clauses: "P2, X5",
    name: "the sandbox has no usable network and no deployment config",
    code: `async () => {
      const out = {
        fetch: typeof fetch,
        timers: typeof setTimeout,
        requires: typeof require,
        process: typeof process
      };
      if (typeof fetch === "function") {
        try {
          await fetch("https://example.invalid/");
          out.egress = "resolved";
        } catch (err) {
          out.egress = "blocked";
        }
      } else {
        out.egress = "absent";
      }
      out.envKeys = typeof process === "object" && process && process.env
        ? Object.keys(process.env).length
        : 0;
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(result.egress).not.toBe("resolved");
      expect(result.envKeys).toBe(0);
      expect(result.requires).toBe("undefined");
    },
  },
  {
    clauses: "R1, R6",
    name: "a small result reaches the model unchanged and unadorned",
    code: `async () => ({ nested: { list: [1, 2, 3] }, text: "kept" })`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ nested: { list: [1, 2, 3] }, text: "kept" });
      expect(Object.keys(outcome.value)).toEqual(["result"]);
    },
  },
  {
    clauses: "R2, R3",
    name: "an oversized result truncates once, successfully, and honestly",
    code: `async () => {
      const big = await reader.big({ chars: 200000 });
      return { blob: big.blob };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      const result = outcome.result as {
        truncated?: boolean;
        preview?: string;
        totalChars?: number;
        hint?: string;
      };
      expect(result.truncated).toBe(true);
      expect(result.totalChars).toBeGreaterThanOrEqual(200_000);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(24_000);
      expect(String(result.preview)).not.toContain('"truncated"');
      expect(String(result.hint)).toContain("filter/map/slice");
    },
  },
  {
    clauses: "R5, X4",
    name: "console output is captured in order",
    code: `async () => {
      console.log("first");
      console.warn("second");
      console.error("third");
      return "done";
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toBe("done");
      const logs = String(outcome.value.logs);
      expect(logs.indexOf("first")).toBeGreaterThanOrEqual(0);
      expect(logs.indexOf("second")).toBeGreaterThan(logs.indexOf("first"));
      expect(logs.indexOf("third")).toBeGreaterThan(logs.indexOf("second"));
    },
  },
  {
    clauses: "R5",
    name: "logs survive a failing program",
    code: `async () => {
      console.log("before failure");
      throw new Error("deliberate");
    }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("deliberate");
      expect(outcome.text).toContain("before failure");
    },
  },
  {
    clauses: "P3, X9",
    name: "a value outside JSON never round-trips",
    code: `async () => {
      const cycle = { name: "cycle" };
      cycle.self = cycle;
      return cycle;
    }`,
    check(outcome) {
      // Executors differ on how they refuse it (X9): the Dynamic Worker ends
      // the run with an error, QuickJS dumps the value lossily. The contract is
      // that the cycle never comes back as data a program could trust.
      expect(outcome.text.length).toBeGreaterThan(0);
      if (outcome.isError) return;
      const result = outcome.result;
      const self =
        result !== null && typeof result === "object"
          ? (result as { self?: unknown }).self
          : undefined;
      expect(self).toBeUndefined();
    },
  },
  {
    clauses: "Y1, V2",
    name: "connecta retries nothing beneath one program call",
    code: `async () => {
      try { await reader.flaky({}); } catch (err) { return { message: err.message }; }
      return { message: "none" };
    }`,
    check(outcome, state) {
      const result = record(outcome);
      expect(String(result.message)).toContain("unavailable");
      expect(state.calls["reader.flaky"]).toBe(1);
      const event = required(state.events[0]);
      expect(event.attempts).toBe(1);
      expect(event.outcome).toBe("error");
      expect(event.errorCode).toBe("unavailable");
    },
  },
  {
    clauses: "V1, V2, V3, V4",
    name: "every resolved call is one payload-free event, and nothing else is",
    code: `async () => {
      await reader.read({ value: "1" });
      await connecta.call("reader.read", { value: "2" });
      try { await connecta.call("nope.read", {}); } catch (err) { void err; }
      try { await reader.wipe({}); } catch (err) { void err; }
      return "done";
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(state.events).toHaveLength(3);
      expect(state.events.map((event) => event.address)).toEqual([
        "reader.read",
        "reader.read",
        "reader.wipe",
      ]);
      for (const event of state.events) {
        expect(event.source).toBe("execute_code");
        expect(Object.keys(event)).not.toContain("args");
        expect(Object.keys(event)).not.toContain("result");
        expect(Object.keys(event)).not.toContain("code");
      }
      expect(required(state.events[2]).errorCode).toBe(
        "destructive_tool_requires_approval",
      );
    },
  },
  {
    clauses: "E1, E6",
    name: "a wrapped failure message still reports the underlying type",
    code: `async () => {
      try {
        await connecta.call("reader.flaky", {});
      } catch (err) {
        throw new Error("while summarizing: " + err.message);
      }
    }`,
    check(outcome) {
      // Documented precedence: exact match first, containment second. Keeping
      // the type beats keeping the program's prose.
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({
        code: "unavailable",
        retryable: true,
      });
    },
  },
  {
    clauses: "E2, E7",
    name: "a policy refusal stays non-retryable however the address reads",
    code: `async () => {
      const outcomes = await connecta.batch([
        { address: "temporary-503-service.nope", args: {} },
        { address: "temporary-503-service.wipe", args: {} },
        { address: "no-such-503-service.read", args: {} }
      ]);
      return outcomes.map((outcome) => ({
        code: outcome.errorDetails.code,
        retryable: outcome.errorDetails.retryable
      }));
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual([
        { code: "unknown_tool", retryable: false },
        { code: "destructive_tool_requires_approval", retryable: false },
        { code: "unknown_address", retryable: false },
      ]);
    },
  },
  {
    clauses: "S3, E1",
    name: "an uncaught discovery-bound failure reaches the model typed",
    code: `async () => await connecta.search({ limit: 500 })`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({
        code: "invalid_args",
        retryable: false,
      });
      expect(String((outcome.value.error as { message: string }).message)).toContain(
        "through 100",
      );
    },
  },
  {
    clauses: "V1, V2, V3",
    name: "a refusal that reached a connector is an event; a guessed connector is not",
    code: `async () => {
      try { await connecta.call("reader.nope", {}); } catch (err) { void err; }
      try { await collide.get_thing({}); } catch (err) { void err; }
      try { await connecta.call("badcatalog.read", {}); } catch (err) { void err; }
      try { await connecta.call("needsstore.read", {}); } catch (err) { void err; }
      try { await connecta.call("nope.read", {}); } catch (err) { void err; }
      return "done";
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      // Four refusals named a real connector and are recorded; the last never
      // did, so there is nothing to attribute it to.
      expect(
        state.events.map((event) => [event.address, event.errorCode]),
      ).toEqual([
        ["reader.nope", "unknown_tool"],
        // The sanitized alias, not a canonical address: it is what the program
        // asked for, and no single tool owns it.
        ["collide.get_thing", "ambiguous_tool_alias"],
        ["badcatalog.read", "catalog_lookup_failed"],
        // Refused before dispatch, so no connector call happened.
        ["needsstore.read", "auth_required"],
      ]);
      expect(state.calls["badcatalog.read"]).toBeUndefined();
      expect(state.calls["needsstore.read"]).toBeUndefined();
      for (const event of state.events) {
        expect(event.outcome).toBe("error");
        expect(event.source).toBe("execute_code");
      }
    },
  },
  {
    clauses: "E6, X8",
    name: "only provider functions are callable, inherited members included",
    code: `async () => {
      const out = { inheritedType: typeof connecta.toString };
      try { await connecta.nope({}); } catch (err) { out.unknown = String(err.message); }
      try { await connecta.toString(); } catch (err) { out.inherited = String(err.message); }
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      // Reading any property yields a function — the namespace is a Proxy —
      // which is exactly why the host, not the guest, decides what is callable.
      expect(result.inheritedType).toBe("function");
      expect(String(result.unknown).length).toBeGreaterThan(0);
      expect(String(result.inherited).length).toBeGreaterThan(0);
    },
  },
  {
    clauses: "M1, M2, M3",
    name: "emitted blocks are delivered after the envelope, in order",
    code: `async () => {
      await connecta.emit({ type: "text", text: "caption" });
      await connecta.emit({
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/png"
      });
      return { done: true };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ done: true });
      expect(outcome.value.emitted).toBe(2);
      expect(outcome.content).toHaveLength(3);
      expect(required(outcome.content[1])).toEqual({
        type: "text",
        text: "caption",
      });
      expect(required(outcome.content[2])).toEqual({
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/png",
      });
    },
  },
  {
    clauses: "M1",
    name: "an invalid emit throws catchably and accepts nothing",
    code: `async () => {
      const out = {};
      try { await connecta.emit("bare"); } catch (err) { out.bare = err.message; }
      try {
        await connecta.emit({ type: "resource_link", uri: "https://lure.example/" });
      } catch (err) { out.link = err.message; }
      try {
        await connecta.emit({ type: "text", text: "x", annotations: {} });
      } catch (err) { out.annotated = err.message; }
      try {
        await connecta.emit({ type: "image", data: "aGk=" });
      } catch (err) { out.partial = err.message; }
      await connecta.emit({ type: "text", text: "still fine" });
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(String(result.bare)).toContain("content block");
      expect(String(result.link)).toContain('"text", "image", and "audio"');
      expect(String(result.annotated)).toContain("annotations");
      expect(String(result.partial)).toContain("mimeType");
      // Only the valid block survived the four refused ones.
      expect(outcome.value.emitted).toBe(1);
      expect(outcome.content).toHaveLength(2);
      expect(required(outcome.content[1]).text).toBe("still fine");
    },
  },
  {
    clauses: "M2, M3",
    name: "a truncated return value does not suppress emitted blocks",
    code: `async () => {
      await connecta.emit({ type: "text", text: "alongside" });
      const big = await reader.big({ chars: 200000 });
      return { blob: big.blob };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect((outcome.result as { truncated?: boolean }).truncated).toBe(true);
      expect(outcome.value.emitted).toBe(1);
      expect(outcome.content).toHaveLength(2);
      expect(required(outcome.content[1]).text).toBe("alongside");
    },
  },
  {
    clauses: "M4",
    name: "a failed program delivers no blocks, visibly",
    code: `async () => {
      await connecta.emit({ type: "text", text: "doomed block" });
      throw new Error("after emitting");
    }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain("after emitting");
      expect(outcome.text).toContain("emittedDiscarded: 1");
      expect(outcome.content).toHaveLength(1);
      expect(outcome.text).not.toContain("doomed block");
    },
  },
  {
    clauses: "L3, X1",
    name: "an execution that outruns its deadline ends as an error",
    deadline: true,
    code: `async () => {
      await hang.read({});
      return "never";
    }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.text.toLowerCase()).toMatch(/timed out|timeout/);
    },
  },
];
