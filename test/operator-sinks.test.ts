import { OAuthErrorCode } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { InvocationService } from "../src/invocation.js";
import {
  describeFailure,
  failureRecord,
  logFailure,
  OAUTH_ERROR_CODES,
  type FailureRecord,
  type FailureSubject,
} from "../src/operator-record.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, JsonSchema, Logger } from "../src/types.js";
import { activitySink, createTestConnecta, makeRegistry } from "./helpers.js";

// INV-6 at the sinks (#695, #716). Every position a downstream controls gets
// its own sentinel; none may reach a log line, the console, an activity row,
// or a status message, on Node and on Workers. The agent's result may carry
// only a downstream's own answer to its call: a JSON-RPC error's message, a
// 4xx refusal's text, an isError result's content, or the words a handler
// put in a ConnectorCallError.
const planted = (position: string) => `planted-${position}-7f3a9c`;
/** Any sentinel, including ones shaped as identifiers (an error's name). */
const ANY_PLANTED = /7f3a9c/;
const BASE = "https://connecta.test";
const MCP_URL = "https://downstream.example/mcp";

/** Each error's string form, stack, own properties, causes, and members. */
function rendered(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined || seen.has(value)) return "";
  seen.add(value);
  if (typeof value !== "object") return String(value);
  if (!(value instanceof Error)) {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  }
  const members = value instanceof AggregateError ? value.errors : [];
  return [
    String(value),
    value.stack ?? "",
    rendered({ ...value }, seen),
    rendered(value.cause, seen),
    ...members.map((member: unknown) => rendered(member, seen)),
  ].join("\n");
}

let consoleLines: string[] = [];
/**
 * Bodies read as text although their Content-Type is not text. workerd prints
 * a native warning quoting that Content-Type for each, outside every console
 * this file can spy on, so none may happen.
 */
let textOnUnreadable: string[] = [];

beforeEach(() => {
  consoleLines = [];
  textOnUnreadable = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => rendered(arg)).join(" "));
    });
  }
  const text = Response.prototype.text;
  vi.spyOn(Response.prototype, "text").mockImplementation(function (this: Response) {
    const type = this.headers.get("content-type");
    const essence = type?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (
      this.body !== null &&
      type !== null &&
      !essence.startsWith("text/") &&
      !/\/(?:.*\+)?json$/.test(essence)
    ) {
      textOnUnreadable.push(type);
    }
    return text.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => {
    lines.push(args.map((arg) => rendered(arg)).join(" "));
  };
  return { logger: { debug: sink, info: sink, warn: sink, error: sink }, lines };
}

type Answer = Response | (() => never);

/**
 * A static-credential MCP endpoint whose handshake, catalog, and tool call
 * each scenario may replace.
 */
function downstream(opts: {
  initialize?: (id: number) => Answer;
  tools?: unknown[];
  call?: (id: number) => Answer;
}) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href !== MCP_URL || init.method !== "POST") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body)) as {
      id: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    const answer = (chosen: Answer | undefined, fallback: () => Response) => {
      if (chosen === undefined) return fallback();
      if (typeof chosen === "function") return chosen();
      return chosen;
    };
    if (request.method === "initialize") {
      return answer(opts.initialize?.(request.id), () =>
        Response.json({ jsonrpc: "2.0", id: request.id, result: {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        } }));
    }
    if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    if (request.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {
        tools: opts.tools ?? [readTool()],
      } });
    }
    if (request.method === "tools/call") {
      return answer(opts.call?.(request.id), () =>
        Response.json({ jsonrpc: "2.0", id: request.id, result: {
          content: [{ type: "text", text: "ok" }],
        } }));
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  };
}

function readTool(inputSchema: JsonSchema = { type: "object" }) {
  return { name: "read", inputSchema, annotations: { readOnlyHint: true } };
}

const rpcError = (id: number) =>
  Response.json({ jsonrpc: "2.0", id, error: {
    code: -32000,
    message: `refused ${planted("rpc-message")}`,
    data: { echo: planted("rpc-data") },
  } });

const remote = () =>
  remoteMcp("svc", {
    url: MCP_URL,
    auth: { type: "headers", headers: { authorization: "Bearer static" } },
    versionNegotiation: "legacy",
  });

const handler = (run: () => Promise<unknown> | unknown): Connector =>
  api("svc", {
    tools: [{
      name: "read",
      description: "Read a thing",
      annotations: { readOnlyHint: true },
      handler: run,
    }],
  });

interface Scenario {
  name: string;
  connector: () => Connector;
  fetch?: ReturnType<typeof downstream>;
  /** Positions the agent's result may carry: the downstream's own answer. */
  agentMay?: string[];
  args?: Record<string, unknown>;
  /** The address called, when not `svc.read`. */
  address?: string;
  /** The agent's own input comes back to it (a search for the unlisted tool). */
  agentEchoes?: boolean;
}

const scenarios: Scenario[] = [
  {
    name: "remoteMcp: a JSON-RPC error's message and data",
    connector: remote,
    fetch: downstream({ call: rpcError }),
    agentMay: ["rpc-message"],
  },
  {
    name: "remoteMcp: a JSON-RPC error at the handshake",
    connector: remote,
    fetch: downstream({ initialize: rpcError }),
    agentMay: ["rpc-message"],
  },
  {
    name: "remoteMcp: an HTTP 400 refusal body",
    connector: remote,
    fetch: downstream({ call: () => new Response(`refused ${planted("4xx-body")}`, {
      status: 400,
      headers: { "content-type": "text/plain" },
    }) }),
    agentMay: ["4xx-body"],
  },
  {
    name: "remoteMcp: an HTTP 500 body",
    connector: remote,
    fetch: downstream({ call: () => new Response(`broke ${planted("5xx-body")}`, {
      status: 500,
      headers: { "content-type": "text/plain" },
    }) }),
  },
  {
    name: "remoteMcp: an isError result",
    connector: remote,
    fetch: downstream({ call: (id) => Response.json({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text: `failed ${planted("is-error")}` }],
      isError: true,
    } }) }),
    agentMay: ["is-error"],
  },
  {
    name: "remoteMcp: a planted content type on a 200 reply",
    connector: remote,
    fetch: downstream({ call: () => new Response(`{"x":"${planted("ct-200-body")}"}`, {
      headers: { "content-type": `application/${planted("ct-200")}` },
    }) }),
  },
  {
    name: "remoteMcp: a planted content type on a 4xx refusal",
    connector: remote,
    fetch: downstream({ call: () => new Response(`refused ${planted("ct-4xx-body")}`, {
      status: 400,
      headers: { "content-type": `application/${planted("ct-4xx")}` },
    }) }),
  },
  {
    name: "remoteMcp: a planted content type on a 5xx answer",
    connector: remote,
    fetch: downstream({ call: () => new Response(`broke ${planted("ct-5xx-body")}`, {
      status: 503,
      headers: { "content-type": `application/${planted("ct-5xx")}` },
    }) }),
  },
  {
    name: "remoteMcp: a planted content type at the handshake",
    connector: remote,
    fetch: downstream({ initialize: () => new Response(planted("ct-init-body"), {
      headers: { "content-type": `application/${planted("ct-init")}` },
    }) }),
  },
  {
    name: "remoteMcp: a transport error and its cause",
    connector: remote,
    fetch: downstream({ call: () => {
      throw new TypeError(`fetch failed ${planted("transport")}`, {
        cause: new Error(planted("transport-cause")),
      });
    } }),
  },
  {
    name: "remoteMcp: an abort reason from somewhere other than the caller",
    connector: remote,
    fetch: downstream({ call: () => {
      throw new DOMException(`stream closed ${planted("foreign-abort")}`, "AbortError");
    } }),
  },
  {
    name: "remoteMcp: an input schema whose $ref cannot resolve",
    connector: remote,
    fetch: downstream({ tools: [readTool({
      type: "object",
      properties: { q: { $ref: `#/${planted("schema-ref")}` } },
    })] }),
    args: { q: "x" },
  },
  {
    name: "remoteMcp: an input schema whose pattern is not a regex",
    connector: remote,
    fetch: downstream({ tools: [readTool({
      type: "object",
      properties: { q: { type: "string", pattern: `${planted("schema-pattern")}(` } },
    })] }),
    args: { q: "x" },
  },
  {
    name: "remoteMcp: an input schema whose type is no JSON type",
    connector: remote,
    fetch: downstream({ tools: [readTool({
      type: "object",
      properties: { q: { type: planted("schema-type") } },
    } as JsonSchema)] }),
    args: { q: "x" },
  },
  {
    name: "api(): a reply stream that rejects",
    connector: () => handler(async () =>
      await new Response(new ReadableStream({
        pull(controller) {
          controller.error(new TypeError(planted("stream")));
        },
      })).text()),
  },
  {
    name: "api(): an error with a cause",
    connector: () => handler(() => {
      throw new Error(planted("message"), { cause: new Error(planted("cause")) });
    }),
  },
  {
    name: "api(): an AggregateError's members",
    connector: () => handler(() => {
      throw new AggregateError([new Error(planted("member"))], planted("aggregate"));
    }),
  },
  {
    name: "api(): an abort reason from somewhere other than the caller",
    connector: () => handler(() => {
      throw new DOMException(planted("api-abort"), "AbortError");
    }),
  },
  {
    name: "api(): a reply that does not parse",
    connector: () => handler(() => JSON.parse(`{"${planted("json")}`)),
  },
  {
    name: "api(): an error whose name is planted",
    connector: () => handler(() => {
      throw Object.assign(new Error("x"), { name: "PlantedName7f3a9c" });
    }),
  },
  {
    name: "api(): a subclass whose name is planted",
    connector: () => handler(() => {
      throw new (class PlantedClass7f3a9c extends TypeError {})("x");
    }),
  },
  {
    name: "api(): a DOMException whose name is planted",
    connector: () => handler(() => {
      throw new DOMException("x", "PlantedDomName7f3a9c");
    }),
  },
  {
    name: "remoteMcp: a transport error whose name is planted",
    connector: remote,
    fetch: downstream({ call: () => {
      throw Object.assign(new TypeError("fetch failed"), { name: "PlantedName7f3a9c" });
    } }),
  },
  {
    name: "a tool name the catalog does not list",
    connector: remote,
    fetch: downstream({}),
    address: `svc.${planted("unlisted")}`,
    agentEchoes: true,
  },
  {
    name: "api(): a provider's own words in a ConnectorCallError",
    connector: () => handler(() => {
      throw new ConnectorCallError("invalid_args", `rejected ${planted("provider")}`);
    }),
    agentMay: ["provider"],
  },
];

describe("operator sinks", () => {
  it.each(scenarios)(
    "INV-6: $name stays out of logs, console, activity, and status",
    async ({ connector, fetch, agentMay = [], args = {}, address = "svc.read", agentEchoes }) => {
      if (fetch) vi.stubGlobal("fetch", fetch);
      const { logger, lines } = capturingLogger();
      const registry = makeRegistry([connector()], { logger });
      const target = activitySink();
      const outcome = await new InvocationService(
        registry,
        new CatalogService(registry, BASE),
        target.activity,
      ).invoke(address, args, { source: "call_tool", allowDestructive: true });
      const status = await registry.statusFor("svc", BASE);

      const operator = [
        ...lines,
        ...consoleLines,
        // An unlisted tool's activity row records the address the agent
        // called, which is the agent's own text, not a downstream's.
        ...(address === "svc.read" ? [JSON.stringify(target.events)] : []),
        JSON.stringify(status),
      ];
      for (const text of operator) expect(text).not.toMatch(ANY_PLANTED);
      expect(textOnUnreadable).toEqual([]);

      // The sinks were reached: a failure was logged and recorded.
      if (!outcome.ok) {
        expect(lines.some((line) => line.includes("[connecta] call failed"))).toBe(true);
        expect(target.events).toEqual([expect.objectContaining({ outcome: "error" })]);
      }

      // The agent's result carries the downstream's own answer and nothing else.
      const agent = rendered(outcome.ok ? outcome.value : outcome.error);
      if (agentEchoes) return;
      for (const match of agent.matchAll(/planted-([a-z0-9-]+)-7f3a9c/g)) {
        expect(agentMay).toContain(match[1]);
      }
      expect(agent.replace(/planted-[a-z0-9-]+-7f3a9c/g, "")).not.toMatch(ANY_PLANTED);
    },
  );
});

describe("the operator record", () => {
  it("INV-6: keeps typed facts and drops every text an error carries", () => {
    const error = new ConnectorCallError("unavailable", planted("record"), {
      cause: new Error(planted("record-cause")),
      details: { host: "https://user:pass@down.example/path?q=1", code: "ECONNREFUSED" },
    });
    expect({ ...failureRecord({}, error) }).toEqual({
      code: "unavailable",
      retryable: true,
      errorClass: "ConnectorCallError",
      origin: "https://down.example",
      errno: "ECONNREFUSED",
    });
    expect(describeFailure("svc", error)).toBe(
      'Connector "svc" request to https://down.example failed (ConnectorCallError, unavailable, ECONNREFUSED).',
    );
  });

  it("INV-6: labels an error by its class's identity, never its name", () => {
    const named = Object.assign(new Error(planted("odd")), { name: "PlantedName7f3a9c" });
    expect({ ...failureRecord({}, named) }).toEqual({ errorClass: "Error" });
    const posing = Object.assign(new RangeError("x"), { name: "ConnectorCallError" });
    expect(failureRecord({}, posing).errorClass).toBe("RangeError");
    class PlantedClass7f3a9c extends TypeError {}
    expect(failureRecord({}, new PlantedClass7f3a9c("x")).errorClass).toBe("TypeError");
    expect(failureRecord({}, new DOMException("x", "AbortError")).errorClass).toBe("AbortError");
    expect(failureRecord({}, new DOMException("x", "PlantedName7f3a9c")).errorClass).toBe("DOMException");
    // Shaped like an error, but no class of one: no label at all.
    expect(failureRecord({}, { name: "TypeError", message: planted("shape") }).errorClass).toBeUndefined();
    expect(describeFailure("svc", named)).toBe('Connector "svc" failed (Error).');
  });

  it("INV-6: copies only the subject's listed fields, each checked", () => {
    const subject = {
      connector: "svc",
      tool: { name: "read", description: planted("entry-description") },
      source: planted("source"),
      userId: `user ${planted("user")}`,
      attempts: 2,
      durationMs: Number.NaN,
      message: planted("subject-message"),
      cause: new Error(planted("subject-cause")),
    } as FailureSubject;
    const record = failureRecord(subject, new TypeError(planted("error")));
    expect({ ...record }).toEqual({
      connector: "svc",
      tool: "read",
      attempts: 2,
      errorClass: "TypeError",
    });
    expect({ ...failureRecord({ connector: `svc ${planted("id")}`, tool: undefined }) }).toEqual({
      connector: "<unknown>",
      tool: "<unlisted>",
    });
    const { logger, lines } = capturingLogger();
    logFailure(logger, "call failed", record);
    expect(lines).toEqual(['[connecta] call failed {"connector":"svc","tool":"read","attempts":2,"errorClass":"TypeError"}']);
  });

  it("INV-6: logFailure refuses a record failureRecord did not build", () => {
    const { logger, lines } = capturingLogger();
    const forged = { connector: "svc", errorClass: planted("forged") } as unknown as FailureRecord;
    expect(() => logFailure(logger, "call failed", forged)).toThrow(TypeError);
    // A copy of a built record is not that record.
    const copy = { ...failureRecord({ connector: "svc" }) } as FailureRecord;
    expect(() => logFailure(logger, "call failed", copy)).toThrow(TypeError);
    expect(lines).toEqual([]);
  });

  it("names every OAuth error code the pinned SDK knows", () => {
    for (const code of Object.values(OAuthErrorCode)) expect(OAUTH_ERROR_CODES.has(code)).toBe(true);
  });
});

describe("a plugin status seam", () => {
  const RECORD_SHAPED = 'Connector "svc" request to https://planted-status-7f3a9c.example failed.';
  const seam = (status: () => Promise<unknown>): Connector => ({
    id: "svc",
    status: status as NonNullable<Connector["status"]>,
    async listTools() {
      return [];
    },
    async callTool() {
      return {};
    },
  });

  it.each([
    ["record-shaped prose", () => Promise.resolve({ state: "error", message: RECORD_SHAPED })],
    ["prose on an auth_required status", () => Promise.resolve({ state: "auth_required", message: planted("auth") })],
    ["an unknown state", () => Promise.resolve({ state: planted("state"), message: planted("m") })],
    ["a thrown error with a planted name", () =>
      Promise.reject(Object.assign(new Error(planted("thrown")), { name: "PlantedName7f3a9c" }))],
  ])("INV-6: contributes no string to status or the log: %s", async (_, status) => {
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([seam(status)], { logger });
    const read = await registry.statusFor("svc", BASE);
    expect(JSON.stringify(read)).not.toMatch(ANY_PLANTED);

    const connecta = createTestConnecta({
      connectors: [seam(status)],
      auth: bearerToken("t"),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger,
    });
    const res = await connecta.fetch(new Request(`${BASE}/ui/connectors/svc`, {
      headers: { Authorization: "Bearer t" },
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(ANY_PLANTED);
    expect(lines.some((line) => line.startsWith("[connecta] operator status"))).toBe(true);
    for (const text of [...lines, ...consoleLines]) expect(text).not.toMatch(ANY_PLANTED);
  });
});
