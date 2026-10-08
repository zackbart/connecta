import { OAuthErrorCode } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecuteTool } from "../src/execute.js";
import { snapshotCatalog } from "../src/catalog-fingerprint.js";
import { Registry } from "../src/registry.js";
import { recordToolActivity } from "../src/activity.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { parseConnectorAccess } from "../src/connector-access.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError, type ConnectorCallErrorCode } from "../src/errors.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import {
  boundedStatus,
  classifiedFailure,
  describeFailure,
  failureRecord,
  failureStatus,
  logFailure,
  OAUTH_ERROR_CODES,
  ownStatus,
  type FailureRecord,
  type FailureSubject,
} from "../src/operator-record.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, JsonSchema, Logger, ToolDef } from "../src/types.js";
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
 * Bodies read natively as text whose Content-Type workerd may not parse as
 * text, or that carries a sentinel. workerd prints a native warning quoting
 * such a Content-Type for each text read (`.json()` included), outside every
 * console this file can spy on, so none may happen: connecta reads a
 * downstream's body as bytes.
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
  for (const reader of ["text", "json"] as const) {
    const read = Response.prototype[reader] as (this: Response) => Promise<unknown>;
    vi.spyOn(Response.prototype, reader).mockImplementation(function (this: Response) {
      const type = this.headers.get("content-type");
      const essence = type?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (
        this.body !== null &&
        type !== null &&
        (ANY_PLANTED.test(type) ||
          !/^(?:text\/[a-z0-9.+-]+|[a-z0-9.+-]+\/(?:[a-z0-9.-]+\+)?json)$/.test(essence))
      ) {
        textOnUnreadable.push(type);
      }
      return read.call(this) as never;
    });
  }
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
    // Read as bytes, the refusal reaches the agent like any other 4xx answer;
    // the type it was labelled with reaches no one.
    agentMay: ["ct-4xx-body"],
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
  // Content-Types that pass a loose text-or-JSON filter and that workerd's own
  // parser still quotes: a JSON subtype under a planted type, and a planted
  // parameter on a type with no subtype (#695 round 7).
  ...[
    ["a JSON subtype of a planted type", `x-${planted("ct-json-type")}/json`],
    ["a planted parameter on a bare text type", `text; x=${planted("ct-param")}`],
    ["a planted parameter on application/json", `application/json; x=${planted("ct-json-param")}`],
  ].flatMap(([label, type]): Scenario[] => [
    {
      name: `remoteMcp: ${label} on an HTTP 400 refusal`,
      connector: remote,
      fetch: downstream({ call: () => new Response(`refused ${planted("ct-loose-4xx-body")}`, {
        status: 400,
        headers: { "content-type": type! },
      }) }),
      agentMay: ["ct-loose-4xx-body"],
    },
    {
      name: `remoteMcp: ${label} on a 200 reply`,
      connector: remote,
      fetch: downstream({ call: () => new Response(`{"x":"${planted("ct-loose-200-body")}"}`, {
        headers: { "content-type": type! },
      }) }),
    },
  ]),
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
    name: "api(): a downstream's code forwarded into a ConnectorCallError",
    connector: () => handler(() => {
      throw new ConnectorCallError(planted("code") as ConnectorCallErrorCode, "refused");
    }),
    // The agent reads the code the handler chose; activity and logs do not.
    agentMay: ["code"],
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
      ).invoke(address, args, { source: "call_destructive_tool" });
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

  it("INV-6: logFailure writes a fixed rejection for a record failureRecord did not build", () => {
    const { logger, lines } = capturingLogger();
    const forged = { connector: "svc", errorClass: planted("forged") } as unknown as FailureRecord;
    expect(() => logFailure(logger, "call failed", forged)).not.toThrow();
    // A copy of a built record is not that record.
    const copy = { ...failureRecord({ connector: "svc" }) } as FailureRecord;
    expect(() => logFailure(logger, "call failed", copy)).not.toThrow();
    expect(lines).toEqual([
      '[connecta] call failed {"record":"<rejected>"}',
      '[connecta] call failed {"record":"<rejected>"}',
    ]);
  });

  it("INV-6: logFailure contains a logger that throws", () => {
    const throwing = () => {
      throw new Error(planted("logger"));
    };
    const logger = { info: throwing, warn: throwing, error: throwing };
    expect(() => logFailure(logger, "call failed", failureRecord({ connector: "svc" }))).not.toThrow();
    expect(() => logFailure(logger, "call failed", {} as FailureRecord, "error")).not.toThrow();
  });

  it("INV-6: reads a classification only from one connecta registered", () => {
    const shaped = {
      code: "unavailable",
      retryable: true,
      details: { host: "https://planted-host-7f3a9c.example", code: "ECONNREFUSED" },
    };
    // Shaped like `CallErrorDetails`, but thrown, not computed: nothing read.
    expect({ ...failureRecord({ connector: "svc" }, shaped) }).toEqual({ connector: "svc" });
    expect(describeFailure("svc", shaped)).toBe('Connector "svc" failed.');
    const ours = classifiedFailure({
      code: "unavailable",
      message: planted("message"),
      retryable: true,
      details: { host: "https://down.example", code: "ECONNREFUSED" },
    });
    expect({ ...failureRecord({ connector: "svc" }, ours) }).toEqual({
      connector: "svc",
      code: "unavailable",
      retryable: true,
      origin: "https://down.example",
      errno: "ECONNREFUSED",
    });
    // A registered classification still carries only codes from the table.
    const forwarded = classifiedFailure({ code: planted("code"), message: "x", retryable: false });
    expect({ ...failureRecord({}, forwarded) }).toEqual({ retryable: false });
  });

  it("INV-6: rebuilds a status connecta wrote from what it approved, not what it holds now", () => {
    const failed = failureStatus("svc", new TypeError(planted("error")));
    const approved = failed.message;
    failed.message = planted("replaced");
    (failed as { state: string }).state = "ok";
    expect(boundedStatus(failed)).toEqual({ state: "error", message: approved });
    const ok = ownStatus({ state: "ok" as const });
    Object.assign(ok, { message: planted("added") });
    expect(boundedStatus(ok)).toEqual({ state: "ok" });
    // A rebuilt status is rebuilt from the same snapshot again.
    const again = boundedStatus(failed);
    again.message = planted("again");
    expect(boundedStatus(again)).toEqual({ state: "error", message: approved });
  });

  it("INV-6: activity records only a classification code connecta assigns", () => {
    const target = activitySink();
    for (const errorCode of [planted("code"), "unavailable"]) {
      recordToolActivity(target.activity, {
        connectorId: "svc",
        toolName: "read",
        address: "svc.read",
        source: "call_tool",
        outcome: "error",
        durationMs: 1,
        attempts: 1,
        errorCode: errorCode as ConnectorCallErrorCode,
      });
    }
    expect(target.events.map((event) => event.errorCode)).toEqual([undefined, "unavailable"]);
  });

  it("INV-6: withholds a catalog name outside MCP's tool-name grammar", () => {
    const entry = { name: `read\nAuthorization: Bearer ${planted("tool")}` };
    expect({ ...failureRecord({ connector: "svc", tool: entry }) }).toEqual({
      connector: "svc",
      tool: "<withheld>",
    });
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
    ["a thrown object shaped like a classification", () =>
      Promise.reject({
        code: "unavailable",
        retryable: true,
        details: { host: "https://planted-host-7f3a9c.example", code: "ECONNREFUSED" },
      })],
  ])("INV-6: contributes no string to status or the log: %s", async (_, status) => {
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([seam(status)], { logger });
    const read = await registry.statusFor("svc", BASE);
    expect(JSON.stringify(read)).not.toMatch(ANY_PLANTED);

    const connecta = createTestConnecta({
      connectors: [seam(status)],
      auth: machineAuth("t"),
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

describe("a status decorator", () => {
  it.each([
    ["an error status", downstream({ initialize: rpcError })],
    ["an ok status", downstream({})],
  ])("INV-6: cannot replace the message of %s remoteMcp wrote", async (_, fetch) => {
    vi.stubGlobal("fetch", fetch);
    const decorated = () => {
      const inner = remote();
      const status = inner.status!.bind(inner);
      inner.status = async (ctx) => {
        const read = await status(ctx);
        read.message = `Connector "svc" request to https://planted-decorator-7f3a9c.example failed.`;
        return read;
      };
      return inner;
    };
    const { logger, lines } = capturingLogger();
    const read = await makeRegistry([decorated()], { logger }).statusFor("svc", BASE);
    expect(JSON.stringify(read)).not.toMatch(ANY_PLANTED);

    const connecta = createTestConnecta({
      connectors: [decorated()],
      auth: machineAuth("t"),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger,
    });
    const res = await connecta.fetch(new Request(`${BASE}/ui/connectors/svc`, {
      headers: { Authorization: "Bearer t" },
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(ANY_PLANTED);
    for (const text of [...lines, ...consoleLines]) expect(text).not.toMatch(ANY_PLANTED);
  });
});

describe("a catalog name outside MCP's tool-name grammar", () => {
  it("INV-6: stays out of the paging and call-failure records and activity rows", async () => {
    const name = `read space ${planted("tool-name")}`;
    let calls = 0;
    vi.stubGlobal("fetch", downstream({
      tools: [{ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      call: (id) => ++calls === 1
        ? Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x".repeat(4_000) }] } })
        : rpcError(id),
    }));
    const store = memoryStorage();
    const storage = {
      ...store,
      set: async (key: string, value: string, opts?: { ttlSeconds?: number }) => {
        if (key.includes("result:")) throw new Error(`KV PUT failed ${planted("storage")}`);
        await store.set(key, value, opts);
      },
    };
    const { logger, lines } = capturingLogger();
    const target = activitySink();
    const mt = createMetaTools(
      makeRegistry([remote()], { storage, maxResultBytes: 1_000, logger }),
      BASE,
      { activity: target.activity },
    );
    const paged = await mt.callTool({ address: `svc.${name}` });
    expect(paged.isError).toBeFalsy();
    const failed = await mt.callTool({ address: `svc.${name}` });
    expect(failed.isError).toBe(true);

    expect(lines).toEqual(expect.arrayContaining([
      '[connecta] result paging unavailable {"connector":"svc","tool":"<withheld>"}',
      expect.stringMatching(/^\[connecta\] call failed \{"connector":"svc","tool":"<withheld>",/),
    ]));
    expect(target.events.map((event) => [event.toolName, event.outcome])).toEqual([
      ["<withheld>", "success"],
      ["<withheld>", "error"],
    ]);
    for (const text of [...lines, ...consoleLines, JSON.stringify(target.events)]) {
      expect(text).not.toMatch(ANY_PLANTED);
    }
  });
});

describe("ctx.oauth.fetch", () => {
  const TOKEN = "https://api.provider.test/oauth/token";
  const API = "https://api.provider.test";
  const oauthConnector = (read: (response: Response) => Promise<unknown>): Connector =>
    api("svc", {
      oauth: {
        authorizationEndpoint: "https://oauth.provider.test/authorize",
        tokenEndpoint: TOKEN,
        clientId: "client",
        clientSecret: "secret",
        apiOrigins: [API],
      },
      tools: [{
        name: "read",
        description: "Read a thing",
        annotations: { readOnlyHint: true },
        handler: async (_args, ctx) => await read(await ctx.oauth!.fetch(`${API}/me`)),
      }],
    });

  it.each([
    ["json()", (response: Response) => response.json()],
    ["text()", (response: Response) => response.text()],
    ["clone().json()", (response: Response) => response.clone().json()],
  ])("INV-6: a handler's %s of a planted Content-Type prints nothing the downstream wrote", async (_, read) => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      // The token endpoint labels its answer with a planted type too.
      if (url === TOKEN) {
        return new Response(JSON.stringify({ access_token: "oauth-access-credential-42", token_type: "Bearer", expires_in: 3600 }), {
          headers: { "content-type": `application/${planted("token-ct")}` },
        });
      }
      return new Response(`{"name":"${planted("oauth-body")}"}`, {
        headers: { "content-type": `application/${planted("oauth-ct")}` },
      });
    });
    const connector = oauthConnector(read);
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([connector], { logger });
    const ctx = () => registry.contextFor("svc", BASE);
    const started = await connector.startAuth!(ctx());
    const authorizationUrl = new URL(started.authorizationUrl!);
    const state = authorizationUrl.searchParams.get("state")!;
    const callback = ctx();
    expect(await connector.verifyState!(state, callback)).toBe(true);
    await connector.finishAuth!("code", callback, new URLSearchParams({ code: "code", state }));

    const target = activitySink();
    const outcome = await new InvocationService(
      registry,
      new CatalogService(registry, BASE),
      target.activity,
    ).invoke("svc.read", {}, { source: "call_destructive_tool" });
    // The agent reads the body as the handler decoded it.
    expect(outcome.ok).toBe(true);
    expect(rendered(outcome.ok ? outcome.value : undefined)).toContain(planted("oauth-body"));
    expect(textOnUnreadable).toEqual([]);
    for (const text of [...lines, ...consoleLines, JSON.stringify(target.events)]) {
      expect(text).not.toMatch(ANY_PLANTED);
    }
  });
});

describe("the operator page's catalog", () => {
  it("INV-6: shows a description but withholds a name outside MCP's tool-name grammar", async () => {
    const name = `读取 ${planted("ui-name")}`;
    vi.stubGlobal("fetch", downstream({ tools: [
      { name, description: `Reads ${planted("ui-description")}`, inputSchema: { type: "object" } },
      { name: "list", description: "Lists things", inputSchema: { type: "object" } },
    ] }));
    const connecta = createTestConnecta({
      connectors: [remote()],
      auth: machineAuth("t"),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: capturingLogger().logger,
    });
    const res = await connecta.fetch(new Request(`${BASE}/ui/connectors/svc`, {
      headers: { Authorization: "Bearer t" },
    }));
    expect(res.status).toBe(200);
    const body = await res.text();
    const { tools } = JSON.parse(body) as { tools: Array<Record<string, unknown>> };
    expect(tools.map((tool) => [tool.name, tool.address])).toEqual([
      ["<withheld>", "svc.<withheld>"],
      ["list", "svc.list"],
    ]);
    // Catalog metadata the operator loaded and the agent already sees.
    expect(tools[0]?.description).toBe(`Reads ${planted("ui-description")}`);
    expect(body.replace(planted("ui-description"), "")).not.toMatch(ANY_PLANTED);
  });
});

describe("a forwarded catalog drift report", () => {
  const drifting = (observedAt: string): Connector => ({
    id: "svc",
    async listTools() {
      return [];
    },
    async callTool() {
      return {};
    },
    catalogDrift: () => ({
      observedAt,
      unclassifiedTools: 1,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
    }),
  });

  it.each([
    ["header text after a timestamp", `2026-08-12T00:00:00.000Z\nAuthorization: Bearer ${planted("drift")}`],
    ["header text alone", `Authorization: Bearer ${planted("drift")}`],
    ["a timestamp-shaped prefix of text", `2026-08-12T00:00${planted("drift")}`],
  ])("INV-6: puts no %s on health, status, or the operator page", async (_, observedAt) => {
    const { logger, lines } = capturingLogger();
    const connecta = createTestConnecta({
      connectors: [drifting(observedAt)],
      auth: machineAuth("t"),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger,
    });
    const health = await (await connecta.fetch(new Request(`${BASE}/health`))).text();
    const page = await (await connecta.fetch(new Request(`${BASE}/ui/connectors/svc`, {
      headers: { Authorization: "Bearer t" },
    }))).text();
    const status = JSON.stringify(await connecta.registry.statusFor("svc", BASE));
    for (const text of [health, page, status, ...lines, ...consoleLines]) {
      expect(text).not.toMatch(ANY_PLANTED);
    }
    expect(status).not.toContain("catalogDrift");
  });

  it("INV-6: re-serializes a real timestamp as connecta's own ISO-8601 UTC form", async () => {
    const registry = makeRegistry([drifting("2026-08-12T02:00:00+02:00")]);
    expect((await registry.statusFor("svc", BASE)).catalogDrift?.observedAt).toBe(
      "2026-08-12T00:00:00.000Z",
    );
  });
});


describe("control-character tool names at catalog intake", () => {
  it.each(["fresh", "v3 cache", "v2 cache"])("INV-6: drops names from %s without leaking into discovery, calls, or operator sinks", async (source) => {
    const rejected = ["read\nAuthorization: Bearer planted-7f3a9c", "x\u0085y"];
    const kept = ["read space", "读取"];
    const tools: ToolDef[] = [...rejected, ...kept].map((name) => ({
      name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
    }));
    let calls = 0;
    let listings = 0;
    const serve = downstream({ tools, call: (id) => {
      calls++;
      return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
    } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.body ? (JSON.parse(String(init.body)) as { method: string }).method : "";
      if (method === "tools/list") listings++;

      return serve(input, init);
    });
    const storage = memoryStorage();
    if (source !== "fresh") {
      const now = Date.now();
      const snapshot = await snapshotCatalog(tools);
      await storage.set(`catalog:svc:chunk:${snapshot.fingerprint}:0`, new TextDecoder().decode(snapshot.serializedBytes));
      await storage.set("catalog:svc", JSON.stringify({
        version: source === "v2 cache" ? 2 : 3, revision: snapshot.fingerprint,
        toolCount: tools.length, byteCount: snapshot.serializedBytes.byteLength, chunkCount: 1,
        fetchedAt: now, expiresAt: now + 600_000, staleUntil: now + 1_200_000,
      }));
    }
    const { logger, lines } = capturingLogger();
    const connector = () => remoteMcp("svc", { url: MCP_URL, classify: { tools: Object.fromEntries(kept.map((name) => [name, "read" as const])) } });
    const registry = new Registry([connector()], {
      storage, logger,
    });
    const target = activitySink();
    const mt = createMetaTools(registry, BASE, { activity: target.activity });
    const search = await mt.searchTools({ query: "", connector: "svc" });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent?.total).toBe(2);
    expect(listings).toBe(1);
    expect(JSON.stringify(search)).not.toMatch(ANY_PLANTED);
    expect(JSON.stringify(search)).not.toContain("x\u0085y");
    expect((await registry.getTools("svc", BASE)).map((tool) => tool.name)).toEqual(kept);
    expect((await registry.statusFor("svc", BASE)).catalogDrift?.droppedTools).toBe(2);
    for (const name of rejected) {
      const result = await mt.callTool({ address: `svc.${name}` });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("unknown_tool");
      expect(JSON.stringify(result)).not.toContain(name);
      expect(JSON.stringify(result)).not.toMatch(ANY_PLANTED);
    }
    for (const name of kept) expect((await mt.callTool({ address: `svc.${name}` })).isError).toBeFalsy();
    const execute = createExecuteTool(registry, BASE, {
      async execute(_code, providers) {
        const fns = providers.find((provider) => provider.name === "connecta")!.fns;
        const programSearch = await fns.search!({ query: "", connector: "svc" });
        expect(JSON.stringify(programSearch)).not.toMatch(ANY_PLANTED);
        expect(JSON.stringify(programSearch)).not.toContain("x\u0085y");
        for (const name of rejected) {
          await expect(fns.call!(`svc.${name}`, {})).rejects.toMatchObject({ code: "unknown_tool" });
        }
        for (const name of kept) expect(await fns.call!(`svc.${name}`, {})).toEqual({ data: "ok", format: "text" });
        return { result: "ok" };
      },
    }, logger);
    expect((await execute({ code: "" })).isError).toBeFalsy();
    expect(calls).toBe(4);
    const app = createTestConnecta({ connectors: [connector()], auth: machineAuth("t"), storage, publicUrl: BASE, logger });
    const ui = await (await app.fetch(new Request(`${BASE}/ui/connectors/svc`, { headers: { Authorization: "Bearer t" } }))).text();
    const health = await (await app.fetch(new Request(`${BASE}/health`))).text();
    const status = JSON.stringify(await registry.statusFor("svc", BASE));
    for (const text of [...lines, ...consoleLines, JSON.stringify(target.events), ui, health, status]) {
      expect(text).not.toMatch(ANY_PLANTED);
      expect(text).not.toContain("x\u0085y");
    }
    expect(target.events.filter((event) => event.outcome === "success").map((event) => event.toolName)).toEqual(["<withheld>", "<withheld>"]);
    await app.close();
  });

  it("INV-6: drops every C0, DEL, and C1 boundary while retaining adjacent Unicode", async () => {
    const controls = [...Array.from({ length: 32 }, (_, i) => i), 127, ...Array.from({ length: 32 }, (_, i) => i + 128)];
    const names = controls.map((code) => `x${String.fromCharCode(code)}y`);
    const registry = makeRegistry([{
      id: "svc", async listTools() { return [...names, "x y", "x~y", "x\u00a0y", "读取"].map((name) => ({ name })); },
      async callTool() { return null; },
    }]);
    expect((await registry.getTools("svc", BASE)).map((tool) => tool.name)).toEqual(["x y", "x~y", "x\u00a0y", "读取"]);
    expect((await registry.statusFor("svc", BASE)).catalogDrift?.droppedTools).toBe(65);
  });
});


describe("catalog intake finding lifecycle", () => {
  it("INV-6: personal connector findings stay out of health without principal or name text", async () => {
    const { logger, lines } = capturingLogger();
    const app = createTestConnecta({
      publicUrl: BASE, logger, storage: memoryStorage(),
      connectors: [{
        id: "svc", authScope: "personal", classification: { tools: {} },
        async listTools() { return [{ name: "x\u0085planted-7f3a9c" }]; },
        async callTool() { return null; },
      }],
    });
    const scoped = app.registry.scoped({ connectorIds: ["svc"], principalKey: "private-principal", subjectKey: "private-subject" });
    expect(await scoped.getTools("svc", BASE)).toEqual([]);
    expect((await scoped.statusFor("svc", BASE)).catalogDrift?.droppedTools).toBe(1);
    const body = await (await app.fetch(new Request(`${BASE}/health`))).text();
    expect(JSON.parse(body)).not.toHaveProperty("catalogDrift");
    for (const text of [body, ...lines, ...consoleLines]) {
      expect(text).not.toMatch(ANY_PLANTED);
      expect(text).not.toContain("private-principal");
      expect(text).not.toContain("private-subject");
    }
    await app.close();
  });

  it("INV-6: rejects control-character grants and bounds warnings even for a manually scoped C1 grant", async () => {
    for (const name of ["read\nAuthorization: Bearer planted-7f3a9c", "x\u0085planted-7f3a9c"]) {
      expect(() => parseConnectorAccess([`svc.${name}`])).toThrow("invalid connector permission");
      expect(() => parseConnectorAccess([{ tool: `svc.${name}`, requireReadOnly: true }], { allowReadOnly: true })).toThrow("invalid connector permission");
    }
    const name = "x\u0085planted-7f3a9c";
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([{
      id: "svc", async listTools() { return [{ name }]; }, async callTool() { return null; },
    }], { logger });
    const scoped = registry.scoped({ connectorIds: ["svc"], toolAccess: new Map([["svc", new Set([name])]]) });
    expect(await scoped.getTools("svc", BASE)).toEqual([]);
    expect(await scoped.getTools("svc", BASE)).toEqual([]);
    expect(lines.filter((line) => line.includes("grant is unreachable"))).toHaveLength(1);
    for (const text of [...lines, ...consoleLines]) expect(text).not.toMatch(ANY_PLANTED);
  });
});
