import { recordToolActivity } from "../src/activity.js";
// The guest API contract cases from documentation/code-mode.md, written once
// and run against every executor. Each case names the clauses it verifies; a
// case that behaves differently under two executors is either a bug or a
// documented exception in that guide.

import { expect } from "vitest";
import type { ActivityRequestContext, ToolCallActivityEvent } from "../src/activity.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools, type ToolResult } from "../src/meta-tools.js";
import type { Connector, Executor, ToolDef } from "../src/types.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

export const CONTRACT_BASE = "https://connecta.contract";

/** Review regression: a write passed its gate but is still in admission. */
export async function checkQueuedWriteAtExhaustion(executor: Executor): Promise<void> {
  let releaseRead!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
  let writes = 0;
  let finished = false;
  const limited: Connector = {
    id: "limited",
    kind: "api",
    callAdmission: { rules: [{ maxConcurrency: 1, maxQueueSize: 2, queueTimeoutMs: 1_000 }] },
    async listTools() {
      return [readOnly("read"), { name: "write", annotations: { readOnlyHint: false } }];
    },
    async callTool(name) {
      if (name === "read") await blocked;
      else writes++;
      return "done";
    },
  };
  const registry = makeRegistry([limited, {
    id: "control", kind: "api",
    async listTools() { return [readOnly("queued")]; },
    async callTool() {
      const deadline = Date.now() + 1_000;
      while (registry.callAdmissionSnapshot().limited?.queued !== 1) {
        if (Date.now() > deadline) throw new Error("write never queued");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      // Release the read the moment exhaustion withdraws the queued write,
      // rather than on a bare 40ms timer a slow guest could outlast before its
      // fourth call. An implementation that never withdraws the write still
      // gets the read released 250ms on, while the run waits on it, and the
      // write that capacity then admits fails the checks below. 250ms is six
      // times the old margin; it is only the fallback for a broken run.
      void (async () => {
        const fallback = Date.now() + 250;
        while (!finished && Date.now() < fallback
          && registry.callAdmissionSnapshot().limited?.queued !== 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        releaseRead();
      })();
      return true;
    },
  }]);
  try {
    const outcome = await createExecuteTool(registry, CONTRACT_BASE, executor, silentLogger, undefined, {
      maxHostCalls: 3,
      trust: "trusted",
    })({ code: `async () => {
      void connecta.call("limited.read", {}).then(({ data }) => data).catch(() => {});
      void connecta.call("limited.write", {}).then(({ data }) => data).catch(() => {});
      await connecta.call("control.queued", {}).then(({ data }) => data);
      await connecta.call("control.queued", {}).then(({ data }) => data);
    }` });
    expect(outcome.isError).toBe(true);
    expect(outcome.structuredContent).toMatchObject({
      error: { code: "budget_exceeded", writes: { succeeded: 0, failed: 1, unknown: 0 } },
      hostCalls: { attempted: 4, admitted: 3 },
    });
    // With the read released, admission drains; a write still queued behind
    // it would be admitted and run before it does.
    releaseRead();
    const drained = Date.now() + 5_000;
    while (Date.now() < drained) {
      const snapshot = registry.callAdmissionSnapshot().limited;
      if (snapshot?.active === 0 && snapshot.queued === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(0);
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({ active: 0, queued: 0 });
  } finally {
    finished = true;
    releaseRead();
  }
}

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
  /** Optional tool result metadata. */
  meta?: Record<string, unknown>;
}

export interface ContractCase {
  clauses: string;
  name: string;
  code: string;
  /** A second program run on the same executor, for cross-run clauses. */
  follows?: string;
  /** Set for the cases that need a short-deadline executor. */
  deadline?: true;
  /** Small output budget for utility-budget contract cases. */
  maxEmittedBytes?: number;
  check(
    outcome: ContractOutcome,
    state: ContractState,
    follow?: ContractOutcome,
  ): void;
}

/** One program that pins the guest capability matrix on every shipped executor. */
export const CAPABILITY_PROBE_CODE = `async () => {
  const attempt = async (fn) => {
    try { await fn(); return "resolved"; }
    catch (error) { return String(error); }
  };
  const importStatus = async (specifier) => {
    try { await import(specifier); return "available"; }
    catch { return "blocked"; }
  };
  const builtinType = (specifier) => {
    if (typeof process !== "object" || !process || typeof process.getBuiltinModule !== "function") return "process absent";
    try { return typeof process.getBuiltinModule(specifier); }
    catch (error) { return String(error); }
  };
  const envShape = (value) => ({
    type: value === null ? "null" : typeof value,
    keys: value && typeof value === "object" ? Object.keys(value).length : 0
  });
  let workerModule;
  try { workerModule = await import("cloudflare:workers"); }
  catch {}
  const dataFetch = typeof fetch === "function"
    ? await (await fetch("data:text/plain,reachable")).text()
    : "absent";
  const netConnect = await (async () => {
    try {
      const net = await import("node:net");
      return await new Promise((resolve) => {
        try {
          const socket = net.connect(80, "example.com");
          socket.once("connect", () => { socket.destroy(); resolve("resolved"); });
          socket.once("error", (error) => resolve(String(error)));
        } catch (error) { resolve(String(error)); }
      });
    } catch { return "import blocked"; }
  })();
  const tlsConnect = await (async () => {
    try {
      const tls = await import("node:tls");
      return await new Promise((resolve) => {
        try {
          const socket = tls.connect({ host: "example.com", port: 443 });
          socket.once("secureConnect", () => { socket.destroy(); resolve("resolved"); });
          socket.once("error", (error) => resolve(String(error)));
        } catch (error) { resolve(String(error)); }
      });
    } catch { return "import blocked"; }
  })();
  const dnsLookup = await (async () => {
    try {
      const dns = await import("node:dns");
      try { await dns.promises.lookup("example.com"); return "resolved"; }
      catch (error) { return String(error); }
    } catch { return "import blocked"; }
  })();
  return {
    globals: {
      fetch: typeof fetch,
      setTimeout: typeof setTimeout,
      clearTimeout: typeof clearTimeout,
      process: typeof process,
      crypto: typeof crypto,
      WebSocket: typeof WebSocket,
      require: typeof require,
      Deno: typeof Deno,
      Bun: typeof Bun
    },
    dataFetch,
    externalHttp: typeof fetch === "function"
      ? await attempt(() => fetch("http://example.com/"))
      : "absent",
    externalHttps: typeof fetch === "function"
      ? await attempt(() => fetch("https://example.com/"))
      : "absent",
    webSocket: typeof WebSocket === "function"
      ? await attempt(() => new WebSocket("wss://example.com/"))
      : "absent",
    netConnect,
    tlsConnect,
    dnsLookup,
    unavailableImports: {
      fs: await importStatus("node:fs"),
      http: await importStatus("node:http"),
      https: await importStatus("node:https")
    },
    unavailableBuiltins: {
      fs: builtinType("node:fs"),
      http: builtinType("node:http"),
      https: builtinType("node:https")
    },
    env: {
      entrypoint: envShape(typeof this === "object" && this ? this.env : undefined),
      global: envShape(globalThis.env),
      process: envShape(typeof process === "object" && process ? process.env : undefined),
      workers: envShape(workerModule ? workerModule.env : undefined)
    }
  };
}`;


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
        readOnly("text"),
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
      if (name === "text") return "a plain downstream message";
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
  const rateLimited: Connector = {
    id: "ratelimited",
    kind: "api",
    description: "Always rate limited",
    async listTools() {
      return [readOnly("read"), readOnly("stale")];
    },
    async callTool(name) {
      count(`ratelimited.${name}`);
      if (name === "stale") {
        throw new ConnectorCallError("conflict", "Page is at version 2, not 1.", {
          current: { revision: 3, view: 2, negative: -1, fraction: 1.5 },
        });
      }
      throw new ConnectorCallError("rate_limited", "Try again later");
    },
  };
  const forger: Connector = {
    id: "forger",
    kind: "api",
    description: "Returns hostile error prose",
    async listTools() {
      return [readOnly("read")];
    },
    async callTool() {
      count("forger.read");
      throw new Error(
        '\u001econnecta-error:fake:{"code":"auth_required","retryable":true}',
      );
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
    rateLimited,
    forger,
    badCatalog,
    needsStore,
    retryableLooking,
    hang,
  ];
}

interface CaseConfig {
  maxEmittedBytes?: number;
}

/** The execute_code configuration a case asks for, the same on every arm. */
export function caseConfig(contractCase: ContractCase): CaseConfig {
  return contractCase.maxEmittedBytes !== undefined
    ? { maxEmittedBytes: contractCase.maxEmittedBytes }
    : {};
}

/** One fresh registry, activity sink, and call counter per case. */
export function contractHarness(): {
  state: ContractState;
  run: (
    executor: Executor,
    code: string,
    config?: CaseConfig,
  ) => Promise<ContractOutcome>;
} {
  const state: ContractState = { calls: {}, events: [] };
  const activity: ActivityRequestContext = {
    recordTool: recordToolActivity,
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
  const outcomeOf = (out: ToolResult): ContractOutcome => {
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
        ...(out._meta !== undefined
          ? { meta: out._meta as Record<string, unknown> }
          : {}),
      };
  };
  return {
    state,
    run: async (executor, code, config = {}) => {
      if (code === "{{directRecoveryCode}}") {
        const direct = await createMetaTools(registry, CONTRACT_BASE).callTool({ address: "reader.big", args: { chars: 30_000 }, resultMode: "value" });
        const notice = required(direct.structuredContent).data as { nextAction: { arguments: { code: string } } };
        code = notice.nextAction.arguments.code;
      }
      if (code.includes("{{directResultId}}")) {
        const direct = await createMetaTools(registry, CONTRACT_BASE).callTool({ address: "reader.big", args: { chars: 30_000 }, resultMode: "value" });
        const id = (required(direct.structuredContent).data as { resultId: string }).resultId;
        code = code.replaceAll("{{directResultId}}", id);
      }
      return outcomeOf(await createExecuteTool(
        registry,
        CONTRACT_BASE,
        executor,
        silentLogger,
        activity,
        config,
      )({ code }));
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
    clauses: "S5, A1",
    name: "INV-3: object and positional calls declare JSON versus text",
    code: `async () => {
      const object = await connecta.call({ address: "reader.read", args: { value: "ok" } });
      const positional = await connecta.call("reader.read", { value: "ok" });
      return { object, positional };
    }`,
    check(outcome) {
      expect(outcome.result).toEqual({
        object: { data: { echo: "ok" }, format: "json" },
        positional: { data: { echo: "ok" }, format: "json" },
      });
      expect(outcome.value.hostCalls).toEqual({ attempted: 2, admitted: 2, succeeded: 2, failed: 0 });
    },
  },
  {
    clauses: "S5, E1",
    name: "INV-3: malformed calls fail with the exact supported signatures",
    code: `async () => {
      try { await connecta.call({ tool: "reader.read" }); }
      catch (error) { return { code: error.code, message: error.message }; }
    }`,
    check(outcome, state) {
      expect(outcome.result).toMatchObject({ code: "invalid_args", message: expect.stringContaining("connecta.call({ address, args?, timeoutMs? })") });
      expect(Object.values(state.calls)).toHaveLength(0);
      expect(outcome.value.hostCalls).toEqual({ attempted: 1, admitted: 1, succeeded: 0, failed: 1 });
    },
  },
  {
    clauses: "P2",
    name: "INV-4: skills use exact names in the admitted connector view",
    code: `async () => {
      const guide = await connecta.skill("connector:reader");
      try { await connecta.skill("connector:hidden"); }
      catch (error) { return { guide, missing: error.code }; }
    }`,
    check(outcome) {
      expect(outcome.result).toMatchObject({ guide: { name: "connector:reader", format: "text", text: expect.stringContaining("Read one value") }, missing: "not_found" });
      expect(outcome.value.hostCalls).toEqual({ attempted: 2, admitted: 2, succeeded: 1, failed: 1 });
    },
  },
  {
    clauses: "R4",
    name: "INV-4: programs page and reduce a stashed direct result",
    code: `async () => {
      let text = "", offset = 0, page;
      do {
        page = await connecta.result("{{directResultId}}", { offset, maxBytes: 8_000 });
        if (page.format !== "text") throw new Error("page format");
        text += page.text;
        offset = page.nextOffset;
      } while (page.hasMore);
      return { length: JSON.parse(text).blob.length, totalBytes: page.totalBytes };
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ length: 30_000, totalBytes: 30_011 });
      expect(state.calls["reader.big"]).toBe(1);
      expect(outcome.value.hostCalls).toEqual({ attempted: 4, admitted: 4, succeeded: 4, failed: 0 });
    },
  },
  {
    clauses: "R2, R4",
    name: "INV-7: a direct result recovery action preserves its complete page and continuation",
    code: "{{directRecoveryCode}}",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toMatchObject({ offset: 0, bytes: 3829, totalBytes: 30_011, hasMore: true, nextOffset: 3829, format: "text", text: expect.any(String) });
      expect(outcome.text.length).toBeLessThan(24_000);
      expect(outcome.result).not.toHaveProperty("truncated");
    },
  },
  ...[
    ["require('fs')", "ReferenceError", "Imports, require, and filesystem access"],
    ["fs.readFile('secret')", "ReferenceError", "Imports, require, and filesystem access"],
    ["callTool('reader.read')", "ReferenceError", "Use connecta.call"],
    ["mixpanel.query()", "ReferenceError", "Use connecta.call"],
    ["skills()", "ReferenceError", "Use connecta.call"],
    ["await connecta.guide('usage')", "TypeError", "Use connecta.call"],
    ["await connecta.skills('usage')", "TypeError", "Use connecta.call"],
    ["const connecta = {}; await connecta.call('reader.read')", "TypeError", "Do not shadow connecta"],
  ].map(([source, name, hint]): ContractCase => ({
    clauses: "E6",
    name: `INV-6: program errors repair ${source}`,
    code: `async () => {\n${source};\n}`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "program_error", retryable: false, details: { name, line: 2, hint: expect.stringContaining(hint!) } });
      expect(outcome.value.hostCalls).toEqual({ attempted: 0, admitted: 0, succeeded: 0, failed: 0 });
    },
  })),
  {
    clauses: "M1, M2",
    name: "INV-7: unawaited emit delivers real MCP image content",
    code: `async () => {
      connecta.emit({ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXxkAAAAASUVORK5CYII=", mimeType: "image/png" });
      return "image";
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.value.emitted).toBe(1);
      expect(outcome.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: expect.stringContaining("iVBOR") });
    },
  },
  {
    clauses: "M3, R2",
    name: "INV-3: text emission shares the returned-result cap",
    code: `async () => {
      connecta.emit({ type: "text", text: "x".repeat(18_000) });
      return { blob: "y".repeat(100_000) };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toMatchObject({ truncated: true, totalChars: 100_011 });
      expect((outcome.result as { preview: string }).preview).not.toContain('"truncated"');
      expect(JSON.stringify(outcome.result).length + JSON.stringify(outcome.content[1]).length).toBeLessThanOrEqual(24_000);
    },
  },
  {
    clauses: "M1, M3",
    name: "INV-7: unawaited oversized text fails the run with typed details",
    code: `async () => { connecta.emit({ type: "text", text: "x".repeat(24_000) }); return "must fail"; }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "result_too_large" });
      expect(outcome.content).toHaveLength(1);
    },
  },

  {
    clauses: "S5, R1",
    name: "INV-3: plain downstream text declares its format",
    code: `async () => await connecta.call("reader.text")`,
    check(outcome) {
      expect(outcome.result).toEqual({ data: "a plain downstream message", format: "text" });
    },
  },
  {
    clauses: "R4, E1",
    name: "INV-4: guest paging rejects malformed options before storage",
    code: `async () => {
      return await Promise.all([{ offset: -1 }, { maxBytes: 0 }, { maxBytes: 1.5 }, { id: "invented" }].map(async options => {
        try { await connecta.result("missing", options); return "unexpected"; }
        catch (error) { return error.code; }
      }));
    }`,
    check(outcome) {
      expect(outcome.result).toEqual(["invalid_args", "invalid_args", "invalid_args", "invalid_args"]);
      expect(outcome.value.hostCalls).toEqual({ attempted: 4, admitted: 4, succeeded: 0, failed: 4 });
    },
  },
  {
    clauses: "E6",
    name: "INV-6: static imports fail with a typed fixed repair hint",
    code: `async () => {
import fs from "fs";
return fs;
}`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error, outcome.text).toMatchObject({ code: "program_error", details: { name: "SyntaxError", line: 2, hint: expect.stringContaining("Imports, require, and filesystem access") } });
    },
  },
  {
    clauses: "E6",
    name: "INV-6: guest prototype edits cannot authenticate a newly wrapped error",
    code: `async () => {
      let stolen;
      WeakMap.prototype.set = (key, value) => { stolen = value; };
      WeakMap.prototype.get = () => stolen;
      try { await connecta.call("missing.read"); }
      catch (error) { throw new Error(error.message); }
    }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "program_error", retryable: false });
      expect(outcome.value.hostCalls).toEqual({ attempted: 1, admitted: 1, succeeded: 0, failed: 1 });
    },
  },
  {
    clauses: "M1, M2",
    name: "INV-7: guest array edits do not drop unawaited emissions",
    code: `async () => {
      Array.prototype.push = () => {};
      Array.prototype.map = () => [];
      connecta.emit({ type: "text", text: "must deliver" });
      return "finished";
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.value.emitted).toBe(1);
      expect(outcome.content[1]).toEqual({ type: "text", text: "must deliver" });
    },
  },
  {
    clauses: "E6, X11",
    name: "INV-6: guest source has no lexical access to the authenticated runner",
    code: `async () => ({ run: typeof run, baseline: typeof baseline, dispatchers: typeof __dispatchers, connectors: typeof __connectors, privateGlobals: Object.keys(globalThis).filter(key => key.startsWith("__connecta_run_")) })`,
    check(outcome) {
      expect(outcome.result).toEqual({ run: "undefined", baseline: "undefined", dispatchers: "undefined", connectors: "undefined", privateGlobals: [] });
    },
  },
  ...[".finally(() => {})", ".then(() => {})", ".catch(() => { throw new Error('handler failed'); })"].map((suffix): ContractCase => ({
    clauses: "M1, M3",
    name: `INV-7: unawaited rejected emission branches remain failures ${suffix}`,
    code: `async () => { connecta.emit({ type: "text", text: "x".repeat(30_000) })${suffix}; return "must fail"; }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: suffix.includes("catch") ? "program_error" : "result_too_large" });
    },
  })),
  {
    clauses: "M1, M3",
    name: "INV-7: replacing Promise.resolve cannot bypass emission failure delivery",
    code: `async () => {
      Promise.resolve = () => ({ then(resolve) { resolve(null); } });
      connecta.emit({ type: "text", text: "x".repeat(30_000) });
      return "must fail";
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "result_too_large" });
    },
  },
  {
    clauses: "M5, L4",
    name: "INV-7: rejected emission attempts have a terminal resource bound",
    code: `async () => {
      for (let i = 0; i < 200; i++) {
        try { await connecta.emit({ type: "bad" }); } catch {}
      }
      return "must not finish";
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "budget_exceeded", message: expect.stringContaining("128 attempts maximum") });
      expect(outcome.value.hostCalls).toEqual({ attempted: 0, admitted: 0, succeeded: 0, failed: 0 });
    },
  },
  {
    clauses: "E6, X11",
    name: "INV-6: codec hooks cannot steal an authenticated host failure frame",
    code: `async () => {
      let stolen;
      const parse = JSON.parse;
      Reflect.set(JSON, "parse", (...args) => {
        const value = parse(...args);
        if (value && value.error) stolen = value.error;
        return value;
      });
      try { Object.defineProperty(Object.prototype, "toJSON", { value() { stolen = this; return this; } }); } catch {}
      try { await connecta.call("missing.read"); }
      catch (error) { throw new Error(stolen || "wrapped: " + error.message); }
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "program_error", message: expect.stringContaining("wrapped:") });
    },
  },
  {
    clauses: "E6, X11",
    name: "INV-6: promise adoption and mutable call hooks cannot observe private failure frames",
    code: `async () => {
      const then = Promise.prototype.then;
      let observed = false;
      Reflect.set(Promise.prototype, "then", function (...args) {
        observed = true;
        return then.apply(this, args);
      });
      Reflect.set(Promise.resolve, "call", () => { observed = true; });
      Reflect.set(Promise, Symbol.species, class extends Promise {});
      const racePrototype = Object.getPrototypeOf(Promise.race([]));
      try { Object.defineProperty(racePrototype, "then", { value() { observed = true; } }); } catch {}
      Reflect.set(globalThis, "Promise", { race() { observed = true; } });
      try { await connecta.call("missing.read"); }
      catch (error) { throw new Error(observed ? "observed frame" : "wrapped: " + error.message); }
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "program_error", message: expect.stringContaining("wrapped:") });
    },
  },
  ...[false, true].map((escaped): ContractCase => ({
    clauses: "E1, E6, R2",
    name: `INV-7: oversized program diagnostics remain typed failures escaped=${escaped}`,
    code: `async () => {
      const error = new Error(${escaped ? '"\\u0000".repeat(40_000)' : '"failure"'});
      error.name = "custom".repeat(8_000);
      ${escaped ? 'error.stack = "\\u0000".repeat(40_000);' : ''}
      throw error;
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "program_error", details: { name: "Error" } });
      expect(outcome.result).toBeUndefined();
    },
  })),
  {
    clauses: "E6, X11",
    name: "INV-6: completion uses captured array iteration despite guest iterator hooks",
    code: `async () => {
      const iterator = [][Symbol.iterator]();
      const prototype = Object.getPrototypeOf(iterator);
      Reflect.set(Array.prototype, Symbol.iterator, function () { throw new Error("guest iterator used"); });
      Reflect.set(prototype, "next", function () { throw new Error("guest next used"); });
      await connecta.call("missing.read");
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(true);
      expect(outcome.value.error).toMatchObject({ code: "unknown_address" });
    },
  },
  {
    clauses: "E6, X11",
    name: "INV-6: imported Worker module functions contain no private frame literals",
    code: `async () => {
      if (typeof process === "undefined") return { privateLiterals: false, privateBindings: false };
      const executorModule = await import("./executor.js");
      const guestModule = await import("./connecta-guest.js");
      const sources = [guestModule.default.toString()];
      for (const value of Object.values(executorModule)) {
        if (typeof value !== "function") continue;
        sources.push(value.toString());
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value.prototype || {}))) {
          if (typeof descriptor.value === "function") sources.push(descriptor.value.toString());
        }
      }
      return { privateLiterals: /__connecta_run_[a-f0-9]{32}|connecta-error:[a-f0-9]{32}:/.test(sources.join("\\n")),
        privateBindings: typeof __connecta_program !== "undefined" || typeof __connecta_initialize_0 !== "undefined" || typeof __connecta_user_program !== "undefined" };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ privateLiterals: false, privateBindings: false });
    },
  },
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
    clauses: "P1",
    name: "a trailing semicolon after the arrow expression is accepted",
    // Models end a program with `};` as often as not. The semicolons inside
    // the strings, the regex, and the trailing comments are data, not
    // terminators, and must survive untouched.
    code: `async () => {
      const text = "a;b";
      const tail = \`;\${text};\`;
      return { text, tail, match: /;$/.test(tail) }; // done;
    };
    // nothing after this; really
    /* ; */ ;`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ text: "a;b", tail: ";a;b;", match: true });
    },
  },
  {
    clauses: "P1",
    name: "a one-line arrow expression may end with a semicolon",
    code: "async () => 40 + 2;",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toBe(42);
    },
  },
  {
    clauses: "P1",
    name: "a fenced arrow expression may end with a semicolon",
    code: "```js\nasync () => ({ fenced: true });\n```",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ fenced: true });
    },
  },
  {
    clauses: "P1",
    name: "one fenced program surrounded by prose runs on both executors",
    code: "Read the value:\n```javascript\nasync () => ({ recovered: 42 });\n```\nThat is the program.",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ recovered: 42 });
    },
  },
  {
    clauses: "P1",
    name: "a default-exported arrow runs on both executors",
    code: "export default async () => ({ recovered: 42 });",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ recovered: 42 });
    },
  },
  {
    clauses: "P1",
    name: "a named async declaration runs as one arrow on both executors",
    code: "async function main() { return { recovered: 42 }; }",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ recovered: 42 });
    },
  },
  {
    clauses: "P1",
    name: "a named async declaration keeps recursion and its arguments binding",
    code: "async function recurse(n = 3) { if (n === 0) return { depth: 0, args: arguments.length }; const prior = await recurse(n - 1); return { depth: prior.depth + 1, args: arguments.length }; }",
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ depth: 3, args: 0 });
    },
  },
  {
    clauses: "P1",
    name: "a fence in a program comment does not replace later host calls",
    code: `async () => {
      /*
      \`\`\`js
      async () => 42
      \`\`\`
      */
      const result = await connecta.call("reader.read", { value: "original" }).then(({ data }) => data);
      return result.echo;
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toBe("original");
      expect(state.calls["reader.read"]).toBe(1);
    },
  },
  {
    clauses: "P1",
    name: "two fenced programs remain invalid",
    code: "```js\nasync () => 1\n```\n```js\nasync () => 2\n```",
    check(outcome) {
      expect(outcome.isError).toBe(true);
      expect(outcome.result).toBeUndefined();
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
    name: "INV-3: canonical calls declare and unwrap tool values",
    code: `async () => ({
      canonical: await connecta.call("reader.read", { value: "x" }).then(({ data }) => data),
      connectorGlobal: typeof reader,
      unwrapped: await connecta.call("remote.echo", {
        text: "hi",
        options: { uppercase: false }
      }).then(({ data }) => data)
    })`,
    check(outcome) {
      const result = record(outcome);
      expect(result.canonical).toEqual({ echo: "x" });
      expect(result.connectorGlobal).toBe("undefined");
      expect(result.unwrapped).toEqual({ said: "hi" });
    },
  },
  {
    clauses: "A1, A2",
    name: "canonical addresses preserve punctuation",
    code: `async () => ({
      shortcut: await connecta.call("odd-service.get.thing", {}).then(({ data }) => data),
      canonical: await connecta.call("odd-service.get.thing", {}).then(({ data }) => data)
    })`,
    check(outcome) {
      const result = record(outcome);
      expect(result.shortcut).toEqual({ thing: true });
      expect(result.canonical).toEqual({ thing: true });
    },
  },
  {
    clauses: "A1, A2",
    name: "distinct punctuated tool names remain independently callable",
    code: `async () => {
      const out = {};
      try { await connecta.call("collide.get_thing", {}).then(({ data }) => data); } catch (err) { out.thrown = err.code; }
      out.dotted = await connecta.call("collide.get.thing", {}).then(({ data }) => data);
      out.dashed = await connecta.call("collide.get-thing", {}).then(({ data }) => data);
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(result.thrown).toBe("unknown_tool");
      expect(result.dotted).toEqual({ which: "dot" });
      expect(result.dashed).toEqual({ which: "dash" });
    },
  },
  {
    clauses: "E4, S6",
    name: "tools that are not explicitly read-only are refused either way",
    code: `async () => {
      const out = {};
      try { await connecta.call("reader.wipe", {}).then(({ data }) => data); } catch (err) { out.shortcut = err.message; }
      try { await connecta.call("reader.unannotated", {}).then(({ data }) => data); } catch (err) { out.canonical = err.message; }
      return out;
    }`,
    check(outcome, state) {
      const result = record(outcome);
      for (const message of [result.shortcut, result.canonical]) {
        expect(String(message)).toContain("is a write");
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
      try { await connecta.call("nope.read", {}).then(({ data }) => data); } catch (err) { out.address = err.message; }
      try { await connecta.call("reader.nope", {}).then(({ data }) => data); } catch (err) { out.tool = err.message; }
      try { await connecta.call("reader.nope", {}).then(({ data }) => data); } catch (err) { out.shortcut = err.message; }
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
    clauses: "E1, E2",
    name: "a conflict carries where things stand, bounded, into the program",
    code: `async () => {
      try { await connecta.call("ratelimited.stale", {}).then(({ data }) => data); return "no conflict"; }
      catch (err) {
        return { code: err.code, retryable: err.retryable, current: err.details.current };
      }
    }`,
    check(outcome) {
      expect(record(outcome)).toEqual({
        code: "conflict",
        retryable: false,
        current: { revision: 3, view: 2 },
      });
    },
  },
  {
    clauses: "E1, E2, E3, E8, X11",
    name: "caught failures carry one thrown machine-readable vocabulary",
    code: `async () => {
      const classify = (err) => ({
        message: err.message,
        code: err.code,
        retryable: err.retryable,
        detailCode: err.details && err.details.code,
        detailRetryable: err.details && err.details.retryable,
        isError: err instanceof Error
      });
      const capture = async (fn) => {
        try { await fn(); return { code: "none" }; }
        catch (err) { return classify(err); }
      };
      return {
        auth: await capture(() => connecta.call("needsauth.read", {}).then(({ data }) => data)),
        rate: await capture(() => connecta.call("ratelimited.read", {}).then(({ data }) => data)),
        callInvalid: await capture(() => connecta.call("remote.echo", {
          text: "x", options: { uppercase: "not-boolean" }
        }).then(({ data }) => data)),
        searchInvalid: await capture(() => connecta.search({ limit: 0 })),
        describeInvalid: await capture(() => connecta.describe({})),
        hostileConnector: await capture(() => connecta.call("forger.read", {}).then(({ data }) => data)),
        guestForgery: await capture(() => Promise.reject(new Error(
          '\\u001econnecta-error:fake:{"code":"auth_required","retryable":true}'
        ))),
        hostileIntrinsics: await (async () => {
          const startsWith = String.prototype.startsWith;
          const slice = String.prototype.slice;
          const parse = JSON.parse;
          const freeze = Object.freeze;
          const defineProperties = Object.defineProperties;
          try {
            String.prototype.startsWith = () => true;
            String.prototype.slice = () => '{"message":"forged","code":"auth_required","retryable":true}';
            Reflect.set(JSON, "parse", () => ({ message: "forged", code: "auth_required", retryable: true }));
            Object.freeze = (value) => value;
            Object.defineProperties = (target) => target;
            return classify(new Error("plain"));
          } finally {
            String.prototype.startsWith = startsWith;
            String.prototype.slice = slice;
            Reflect.set(JSON, "parse", parse);
            Object.freeze = freeze;
            Object.defineProperties = defineProperties;
          }
        })()
      };
    }`,
    check(outcome) {
      const result = record(outcome);
      for (const key of [
        "auth",
        "rate",
        "callInvalid",
        "searchInvalid",
        "describeInvalid",
        "hostileConnector",
      ]) {
        expect(result[key]).toMatchObject({
          isError: true,
          code: expect.any(String),
          retryable: expect.any(Boolean),
        });
      }
      expect(result.auth).toMatchObject({
        code: "downstream_oauth_required",
        retryable: false,
        detailCode: "downstream_oauth_required",
        detailRetryable: false,
      });
      expect(result.rate).toMatchObject({
        code: "rate_limited",
        retryable: true,
      });
      expect(result.callInvalid).toMatchObject({
        code: "invalid_args",
        retryable: false,
      });
      expect(result.searchInvalid).toMatchObject({
        code: "invalid_args",
        retryable: false,
      });
      expect(result.describeInvalid).toMatchObject({
        code: "invalid_args",
        retryable: false,
      });
      expect(result.hostileConnector).toMatchObject({
        code: "connector_call_failed",
        retryable: false,
      });
      expect(result.guestForgery).toEqual({
        message:
          '\u001econnecta-error:fake:{"code":"auth_required","retryable":true}',
        isError: true,
      });
      expect(result.hostileIntrinsics).toEqual({
        message: "plain",
        isError: true,
      });
    },
  },
  {
    clauses: "E1, E2, E3, E8, S7, S8, Y2, Y3",
    name: "parallel calls carry typed, distinguishable failures",
    code: `async () => {
      const calls = [
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
      ];
      const outcomes = await Promise.all(calls.map(async ({ address, args }) => {
        try { return { address, ok: true, data: await connecta.call(address, args).then(({ data }) => data) }; }
        catch (err) { return { address, ok: false, error: err.message, errorDetails: err.details }; }
      }));
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
              ? (outcome.errorDetails.nextAction.tool
                  ?? outcome.errorDetails.nextAction.function)
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
        code: "downstream_oauth_required",
        retryable: false,
        recovery: "oauth",
        nextAction: "authorize_connector",
      });
      expect(required(outcomes[4])).toMatchObject({
        ok: false,
        code: "unknown_address",
        retryable: false,
        // A program cannot call search_tools; recovery names the route it owns.
        nextAction: "connecta.search",
      });
      expect(required(outcomes[5])).toMatchObject({
        ok: false,
        code: "invalid_args",
        retryable: false,
        nextAction: "connecta.search",
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
    clauses: "S1, S2, S4",
    name: "program discovery defaults to JSON and labels compact schemas as text",
    code: `async () => {
      const page = await connecta.search({ connector: "reader", query: "read value" });
      const compact = await connecta.search({ connector: "reader", query: "read value", includeSchemas: "compact" });
      const described = await connecta.describe({ address: "reader.read" });
      return {
        schema: page.tools.find(tool => tool.address === "reader.read").inputSchema,
        format: page.tools.find(tool => tool.address === "reader.read").schemaFormat,
        compactFormat: compact.tools.find(tool => tool.address === "reader.read").schemaFormat,
        compactType: typeof compact.tools.find(tool => tool.address === "reader.read").inputSchema,
        describeType: typeof described.tools[0].inputSchema,
        describeFormat: described.tools[0].schemaFormat,
        catalogErrors: page.catalogErrors
      };
    }`,
    check(outcome) {
      const result = record(outcome);
      expect(result.schema).toMatchObject({ type: "object", properties: { value: { type: "string" } } });
      expect(result.format).toBe("json");
      expect(result.compactFormat).toBe("text");
      expect(result.compactType).toBe("string");
      expect(result.describeType).toBe("object");
      expect(result.describeFormat).toBe("json");
      expect(result.catalogErrors).toEqual([]);
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
      expect(result.pageKeys).toEqual([
        "catalogErrors",
        "hasMore",
        "limit",
        "offset",
        "tools",
        "total",
      ]);
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
    }).then(({ data }) => data)`,
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
          function: "connecta.search",
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
        "forger",
        "hang",
        "needsauth",
        "needsstore",
        "odd-service",
        "ratelimited",
        "reader",
        "remote",
        "temporary-503-service",
      ]);
      expect(result.readerTools).toBe(6);
      expect(result.total).toBeGreaterThan(5);
      expect(result.scopedConnectors).toEqual(["reader"]);
    },
  },
  {
    clauses: "S4",
    name: "describe answers per address and reports bad ones inline",
    code: `async () => {
      const described = await connecta.describe({
        addresses: ["reader.read", "nope.read", "reader.raed", "badcatalog.read"]
      });
      return {
        envelopeKeys: Object.keys(described).sort(),
        tools: described.tools.map((tool) => ({
          address: tool.address,
          hasSchema: tool.inputSchema !== undefined,
          error: tool.error,
          errorDetails: tool.errorDetails
        }))
      };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      const result = record(outcome);
      expect(result.envelopeKeys).toEqual(["tools"]);
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(4);
      expect(required(tools[0])).toMatchObject({
        address: "reader.read",
        hasSchema: true,
      });
      expect(required(tools[0]).error).toBeUndefined();
      expect(String(required(tools[1]).error)).toContain("Unknown address");
      expect(required(tools[1]).errorDetails).toEqual({
        code: "unknown_address",
        configuredConnectors: expect.arrayContaining(["reader"]),
        message: 'Unknown address "nope.read"',
        retryable: false,
        nextAction: {
          function: "connecta.search",
          arguments: {
            query: "read",
            includeSchemas: "compact",
          },
          purpose: "Find the configured canonical address before retrying.",
        },
      });
      expect(String(required(tools[2]).error)).toContain("Unknown tool");
      expect(required(tools[2]).errorDetails).toEqual({
        code: "unknown_tool",
        message: 'Unknown tool "raed" on connector "reader"',
        retryable: false,
        nextAction: {
          function: "connecta.search",
          arguments: {
            query: "raed",
            connector: "reader",
            includeSchemas: "compact",
          },
          purpose: "Find the connector's current canonical tool address.",
        },
        suggestions: ["reader.read"],
      });
      expect(required(tools[3]).errorDetails).toEqual({
        code: "catalog_lookup_failed",
        message: "catalog is unreachable",
        retryable: false,
      });
    },
  },
  ...["call", "search", "describe"].map((operation): ContractCase => ({
    clauses: "L4, E1, M4",
    name: `a catch-and-continue ${operation} loop ends at the first budget refusal`,
    code: `async () => {
      await connecta.emit({ type: "text", text: "discard me" });
      const failures = [];
      for (let index = 0; index < 213; index += 1) {
        try {
          ${operation === "call"
            ? 'await connecta.call("remote.echo", { text: index < 2 ? "ok" : index, options: { uppercase: false } }).then(({ data }) => data);'
            : operation === "search"
              ? 'await connecta.search({ connector: "reader" });'
              : 'await connecta.describe({ address: "reader.read" });'}
        } catch (err) {
          failures.push(err.message);
          await connecta.emit({ type: "text", text: "caught a refusal" });
        }
      }
      return failures;
    }`,
    follows: 'async () => await connecta.call("reader.read", { value: "fresh run" }).then(({ data }) => data)',
    check(outcome, state, follow) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value).toMatchObject({
        error: {
          code: "budget_exceeded",
          message: "execute_code host-call budget exceeded (20 calls maximum)",
          retryable: false,
        },
        hostCalls: {
          attempted: 21, admitted: 20,
          succeeded: operation === "call" ? 2 : 20,
          failed: operation === "call" ? 19 : 1,
        },
        emittedDiscarded: operation === "call" ? 19 : 1,
      });
      expect(outcome.value).not.toHaveProperty("result");
      expect(outcome.content).toHaveLength(1);
      expect(outcome.text.split("host-call budget exceeded")).toHaveLength(2);
      expect(follow?.isError).toBe(false);
      expect(follow?.result).toEqual({ echo: "fresh run" });
      expect(state.calls["reader.read"]).toBe(1);
      expect(state.calls["remote.echo"] ?? 0).toBe(operation === "call" ? 2 : 0);
    },
  })),
  {
    clauses: "L4, S7",
    name: "a parallel burst ends without delivering catchable budget refusals",
    code: `async () => {
      const calls = [];
      for (let index = 0; index < 213; index += 1) {
        calls.push(connecta.call("reader.read", { value: "burst" }).then(({ data }) => data).catch(() => {}));
      }
      await Promise.allSettled(calls);
      return "must not be returned";
    }`,
    check(outcome, state) {
      expect(outcome.isError).toBe(true);
      expect(outcome.value).toMatchObject({
        error: { code: "budget_exceeded", retryable: false },
        hostCalls: { attempted: 21, admitted: 20 },
      });
      expect(outcome.value).not.toHaveProperty("result");
      expect(state.calls["reader.read"] ?? 0).toBeLessThanOrEqual(20);
    },
  },
  {
    clauses: "P2, X5",
    name: "pins the portable ambient-authority boundary",
    code: CAPABILITY_PROBE_CODE,
    check(outcome) {
      const result = record(outcome);
      const globals = result.globals as Record<string, string>;
      const unavailableImports = result.unavailableImports as Record<
        string,
        string
      >;
      const env = result.env as Record<string, { keys: number }>;
      expect(result.externalHttp).not.toBe("resolved");
      expect(result.externalHttps).not.toBe("resolved");
      expect(result.webSocket).not.toBe("resolved");
      expect(result.netConnect).not.toBe("resolved");
      expect(result.tlsConnect).not.toBe("resolved");
      expect(result.dnsLookup).not.toBe("resolved");
      expect(
        Object.values(unavailableImports).every(
          (status) => status === "blocked",
        ),
      ).toBe(true);
      expect(Object.values(env).every((shape) => shape.keys === 0)).toBe(true);
      expect(globals.require).toBe("undefined");
      expect(globals.Deno).toBe("undefined");
      expect(globals.Bun).toBe("undefined");
    },
  },
  {
    clauses: "R1, R6",
    name: "a small result reaches the model unchanged and unadorned",
    code: `async () => ({ nested: { list: [1, 2, 3] }, text: "kept" })`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.result).toEqual({ nested: { list: [1, 2, 3] }, text: "kept" });
      expect(Object.keys(outcome.value)).toEqual(["result", "hostCalls"]);
    },
  },
  {
    clauses: "R2, R3",
    name: "an oversized result truncates once, successfully, and honestly",
    code: `async () => {
      const big = await connecta.call("reader.big", { chars: 200000 }).then(({ data }) => data);
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
      try { await connecta.call("reader.flaky", {}).then(({ data }) => data); } catch (err) { return { message: err.message }; }
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
      await connecta.call("reader.read", { value: "1" }).then(({ data }) => data);
      await connecta.call("reader.read", { value: "2" }).then(({ data }) => data);
      try { await connecta.call("nope.read", {}).then(({ data }) => data); } catch (err) { void err; }
      try { await connecta.call("reader.wipe", {}).then(({ data }) => data); } catch (err) { void err; }
      return "done";
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect(state.events).toHaveLength(4);
      expect(state.events.map((event) => event.address)).toEqual([
        "reader.read",
        "reader.read",
        // The address as the program wrote it. No connector answered, which is
        // the event's point: an invented id is the most common address mistake.
        "nope.read",
        "reader.wipe",
      ]);
      for (const event of state.events) {
        expect(event.source).toBe("execute_code");
        expect(Object.keys(event)).not.toContain("args");
        expect(Object.keys(event)).not.toContain("result");
        expect(Object.keys(event)).not.toContain("code");
      }
      expect(required(state.events[2]).errorCode).toBe("unknown_address");
      expect(required(state.events[3]).errorCode).toBe(
        "destructive_tool_requires_approval",
      );
    },
  },
  {
    clauses: "E1, E6",
    name: "INV-6: a wrapped failure message is a program error, not a host frame",
    code: `async () => {
      try {
        await connecta.call("reader.flaky", {}).then(({ data }) => data);
      } catch (err) {
        throw new Error("while summarizing: " + err.message);
      }
    }`,
    check(outcome) {
      // A new Error identity cannot borrow a caught host failure classification.
      expect(outcome.isError).toBe(true);
      expect(outcome.value.error).toMatchObject({
        code: "program_error",
        retryable: false,
      });
    },
  },
  {
    clauses: "E2, E7",
    name: "a policy refusal stays non-retryable however the address reads",
    code: `async () => {
      const calls = [
        { address: "temporary-503-service.nope", args: {} },
        { address: "temporary-503-service.wipe", args: {} },
        { address: "no-such-503-service.read", args: {} }
      ];
      const outcomes = await Promise.all(calls.map(async ({ address, args }) => {
        try { return { address, ok: true, data: await connecta.call(address, args).then(({ data }) => data) }; }
        catch (err) { return { address, ok: false, error: err.message, errorDetails: err.details }; }
      }));
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
    name: "every refusal is an event, including one at an address nothing owns",
    code: `async () => {
      try { await connecta.call("reader.nope", {}).then(({ data }) => data); } catch (err) { void err; }
      try { await connecta.call("collide.get_thing", {}).then(({ data }) => data); } catch (err) { void err; }
      try { await connecta.call("badcatalog.read", {}).then(({ data }) => data); } catch (err) { void err; }
      try { await connecta.call("needsstore.read", {}).then(({ data }) => data); } catch (err) { void err; }
      try { await connecta.call("nope.read", {}).then(({ data }) => data); } catch (err) { void err; }
      return "done";
    }`,
    check(outcome, state) {
      expect(outcome.isError, outcome.text).toBe(false);
      // Four refusals named a real connector; the last named one that does not
      // exist and is recorded anyway, as the address the program wrote.
      expect(
        state.events.map((event) => [event.address, event.errorCode]),
      ).toEqual([
        ["reader.nope", "unknown_tool"],
        ["collide.get_thing", "unknown_tool"],
        ["badcatalog.read", "catalog_lookup_failed"],
        // Refused before dispatch, so no connector call happened.
        ["needsstore.read", "auth_required"],
        ["nope.read", "unknown_address"],
      ]);
      expect(state.events.map((event) => event.friction)).toEqual([
        "tool_not_found",
        "tool_not_found",
        undefined,
        "auth_required",
        "tool_not_found",
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
      for (const removed of ["ui", "batch", "__callNamespace"]) {
        try { await connecta[removed]("unused"); } catch (err) { out[removed] = err.message; }
      }
      try { await connecta.nope({}); } catch (err) { out.unknown = String(err.message); }
      try { await connecta.toString(); } catch (err) { out.inherited = String(err.message); }
      return out;
    }`,
    check(outcome) {
      const result = record(outcome);
      // Both executors expose the same finite namespace without inherited members.
      expect(result.inheritedType).toBe("undefined");
      for (const removed of ["ui", "batch", "__callNamespace"]) {
        expect(String(result[removed]).length).toBeGreaterThan(0);
      }
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
    clauses: "E1, L4, M1, M5, X11",
    name: "utility validation and budget failures use distinct codes",
    maxEmittedBytes: 64,
    code: `async () => {
      const capture = async (fn) => {
        try { await fn(); return { code: "none" }; }
        catch (err) {
          return {
            message: err.message,
            code: err.code,
            retryable: err.retryable,
            detailCode: err.details && err.details.code
          };
        }
      };
      return {
        emitInvalid: await capture(() => connecta.emit("bare")),
        emitBudget: await capture(() => connecta.emit({
          type: "text", text: "x".repeat(100)
        })),
      };
    }`,
    check(outcome) {
      const result = record(outcome);
      for (const key of ["emitInvalid"]) {
        expect(result[key]).toMatchObject({
          code: "invalid_args",
          retryable: false,
          detailCode: "invalid_args",
        });
      }
      for (const key of ["emitBudget"]) {
        expect(result[key]).toMatchObject({
          code: "budget_exceeded",
          retryable: false,
          detailCode: "budget_exceeded",
        });
      }
      expect(String((result.emitInvalid as Record<string, unknown>).message))
        .toContain("content block");
      expect(String((result.emitBudget as Record<string, unknown>).message))
        .toContain("byte budget exceeded");
    },
  },
  {
    clauses: "M2, M3",
    name: "a truncated return value preserves emitted blocks",
    code: `async () => {
      await connecta.emit({ type: "text", text: "alongside" });
      const big = await connecta.call("reader.big", { chars: 200000 }).then(({ data }) => data);
      return { blob: big.blob };
    }`,
    check(outcome) {
      expect(outcome.isError, outcome.text).toBe(false);
      expect((outcome.result as { truncated?: boolean }).truncated).toBe(true);
      expect(outcome.value.emitted).toBe(1);
      expect(outcome.content).toHaveLength(2);
      expect(required(outcome.content[1]).text).toBe("alongside");
      expect(outcome.meta).toBeUndefined();
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
      expect(outcome.value.emittedDiscarded).toBe(1);
      expect(outcome.content).toHaveLength(1);
      expect(outcome.text).not.toContain("doomed block");
    },
  },
  {
    clauses: "L3, X1",
    name: "an execution that outruns its deadline ends as an error",
    deadline: true,
    code: `async () => {
      await connecta.call("hang.read", {}).then(({ data }) => data);
      return "never";
    }`,
    check(outcome) {
      expect(outcome.isError).toBe(true);
      // Either side of the QuickJS deadline may end it: the child reports its
      // own timeout, or, when a loaded host delays that report past the
      // parent's grace, the parent terminates the child at its wall budget.
      // Both are this clause; a hang or an unrelated error is not.
      expect(outcome.text.toLowerCase()).toMatch(/timed out|timeout|wall budget/);
    },
  },
];
