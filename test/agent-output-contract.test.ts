import { afterEach, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { api } from "../src/connectors/api.js";
import { registerMetaTools } from "../src/meta-tools.js";
import type { McpClientContext } from "../src/mcp-client-context.js";
import { SentSecrets, sentSecretsForRequest } from "../src/sent-secrets.js";
import { calcApi } from "./fixtures/http.js";
import { modernRequest } from "./fixtures/client-identity.js";
import { deferred } from "./fixtures/misc.js";
import { createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";

const wire = vi.hoisted(() => ({
  body: "",
  type: "application/json",
  status: 200,
  blocked: undefined as Promise<void> | undefined,
  response: undefined as (() => Response) | undefined,
}));
const TOKEN = "serialized-agent-output-credential";

// Inject an SDK-produced response after a real handler sent a credential.
// These values never pass through connector or meta-tool result redaction.
vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...sdk,
    createMcpHandler: (...args: Parameters<typeof sdk.createMcpHandler>) => {
      const handler = sdk.createMcpHandler(...args);
      return {
        ...handler,
        fetch: async (request: Request) => {
          await (await handler.fetch(request)).text();
          await wire.blocked;
          return (
            wire.response?.() ??
            new Response(wire.body, { status: wire.status, headers: { "Content-Type": wire.type } })
          );
        },
      };
    },
  };
});

afterEach(() => {
  wire.blocked = undefined;
  wire.response = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "SDK error" } },
  { jsonrpc: "2.0", id: 1, result: { tools: [] } },
  { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
  { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Refused" }] } },
  { jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { nested: [null, true, 1, "é"] } } },
  { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"offset":0}\npage' }] } },
  { jsonrpc: "2.0", id: 1, result: { contents: [{ uri: "test://blob", blob: "YWJj" }] } },
])("idle serialized SDK output preserves JSON meaning and original bytes: %j", (value) => {
  const body = ` \n${JSON.stringify(value, null, 2).replace("é", "\\u00e9")}\n `;
  const parse = vi.spyOn(JSON, "parse");
  const stringify = vi.spyOn(JSON, "stringify");
  const actual = new SentSecrets().serializedAgentOutput(body, true);
  expect(actual).toBe(body);
  expect(parse).not.toHaveBeenCalled();
  expect(stringify).not.toHaveBeenCalled();
  parse.mockRestore();
  stringify.mockRestore();
  expect(JSON.parse(actual)).toEqual(value);
});

it("INV-5: serialized private arguments and unregistered values cannot use idle passthrough", () => {
  const schema = { type: "object", properties: { value: { type: "string", writeOnly: true } } };
  const secrets = new SentSecrets();
  secrets.arguments({ value: TOKEN }, schema);
  const body = JSON.stringify({
    content: [
      { type: "text", text: TOKEN.slice(0, 12) },
      { type: "text", text: TOKEN.slice(12) },
    ],
  });
  expect(JSON.parse(secrets.serializedAgentOutput(body, true))).toEqual({
    content: [
      { type: "text", text: "[redacted]" },
      { type: "text", text: "[redacted]" },
    ],
  });
  const unregistered = new SentSecrets();
  unregistered.arguments({ value: "s".repeat(524_289) }, schema);
  const parse = vi.spyOn(JSON, "parse");
  expect(unregistered.serializedAgentOutput(' { "text": "unchecked content" }\n', true)).toBe(
    '{"text":"unchecked content"}',
  );
  expect(parse).toHaveBeenCalledOnce();
});

it.each([false, true])("INV-5: non-JSON diagnostics retain text fallback (JSON header: %s)", (json) => {
  const body = `Refused ${TOKEN}\nRetry later.\n`;
  const secrets = new SentSecrets();
  expect(secrets.serializedAgentOutput(body, json)).toBe(body);
  secrets.add(TOKEN);
  expect(secrets.serializedAgentOutput(body, json)).toBe("Refused [redacted]\nRetry later.\n");
});

it("INV-5: a call's private arguments redact SDK output even without sent credentials", async () => {
  const handler = vi.fn(() => null);
  const connector = api("private", {
    tools: [
      {
        name: "read",
        description: "Read",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { value: { type: "string", writeOnly: true } } },
        handler,
      },
    ],
  });
  wire.type = "application/json";
  wire.status = 200;
  wire.body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: TOKEN } });
  const app = createTestConnecta({ connectors: [connector], logger: silentLogger });
  try {
    const response = await app.fetch(
      modernRequest("tools/call", {
        name: "call_tool",
        arguments: { address: "private.read", args: { value: TOKEN } },
      }),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "[redacted]" } });
  } finally {
    await app.close();
  }
});

it.each([false, true])(
  "INV-5 INV-7: drains the SDK body before deciding passthrough (late secret: %s)",
  async (late) => {
    const reading = deferred<void>();
    const release = deferred<void>();
    const body = ` { "jsonrpc": "2.0", "id": 1, "result": { "echo": "${TOKEN}" } }\n`;
    wire.response = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              reading.resolve();
              await release.promise;
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        {
          status: 201,
          statusText: "Created",
          headers: { "Content-Type": "application/json", "Content-Length": String(body.length), "X-SDK": "preserved" },
        },
      );
    const app = createTestConnecta({ connectors: [], logger: silentLogger });
    const request = modernRequest("tools/list");
    let settled = false;
    try {
      const pending = app.fetch(request).then((response) => {
        settled = true;
        return response;
      });
      await reading.promise;
      expect(settled).toBe(false);
      if (late) sentSecretsForRequest(request).add(TOKEN);
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(201);
      expect(response.statusText).toBe("Created");
      expect(response.headers.get("X-SDK")).toBe("preserved");
      expect(response.headers.get("Content-Length")).toBeNull();
      expect(await response.text()).toBe(
        late ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echo: "[redacted]" } }) : body,
      );
      const health = await app.fetch(new Request("https://connecta.test/health"));
      expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 } } });
    } finally {
      release.resolve();
      await app.close();
    }
  },
);

it("INV-7: cancelling an idle SDK response releases its request", async () => {
  wire.type = "application/json";
  wire.status = 200;
  wire.body = '{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [] } }\n';
  const app = createTestConnecta({ connectors: [], logger: silentLogger });
  try {
    const response = await app.fetch(modernRequest("tools/list"));
    await response.body!.cancel();
    const health = await app.fetch(new Request("https://connecta.test/health"));
    expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 } } });
  } finally {
    await app.close();
  }
});

it.each(["rpc-error", "http-400", "isError", "structuredContent", "paging", "server-discover"])(
  "INV-5: serialized %s output must cross the request redaction choke point",
  async (kind) => {
    let sent = false;
    vi.stubGlobal("fetch", async () => Response.json({ ok: true }));
    const connector = api("sender", {
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          handler: async (_args, ctx) => {
            await ctx.fetch("https://downstream.test/read", { headers: { "X-API-Key": TOKEN } });
            sent = true;
            return null;
          },
        },
      ],
    });
    wire.type = kind === "http-400" ? "text/plain" : "application/json";
    wire.status = kind === "http-400" ? 400 : 200;
    wire.body =
      kind === "rpc-error"
        ? JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: TOKEN, data: { echo: TOKEN } } })
        : kind === "http-400"
          ? `Refused ${TOKEN}`
          : kind === "isError"
            ? JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: {
                  isError: true,
                  content: [
                    { type: "text", text: TOKEN.slice(0, 12) },
                    { type: "text", text: TOKEN.slice(12) },
                  ],
                },
              })
            : kind === "structuredContent"
              ? JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: { content: [], structuredContent: { [TOKEN]: { echo: TOKEN } } },
                })
              : kind === "server-discover"
                ? JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    result: {
                      supportedVersions: ["2026-07-28"],
                      _meta: { "io.modelcontextprotocol/serverInfo": { name: TOKEN, version: "1" } },
                    },
                  })
                : JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    result: { content: [{ type: "text", text: `{"offset":0}\n${TOKEN}` }] },
                  });
    const app = createTestConnecta({ connectors: [connector], logger: silentLogger });
    try {
      const request =
        kind === "server-discover"
          ? modernRequest("server/discover")
          : modernRequest("tools/call", {
              name: "call_tool",
              arguments: { address: "sender.read" },
            });
      if (kind === "server-discover") {
        sentSecretsForRequest(request).add(TOKEN);
      }
      const response = await app.fetch(request);
      expect(sent).toBe(kind !== "server-discover");
      expect(response.status).toBe(wire.status);
      const text = await response.text();
      expect(text).not.toContain(TOKEN);
      expect(text).toContain("[redacted]");
      if (kind === "isError") {
        // Each block keeps its own piece of the match as a placeholder.
        expect(
          JSON.parse(text)
            .result.content.map((block: { text: string }) => block.text)
            .join(""),
        ).toBe("[redacted][redacted]");
      }
    } finally {
      await app.close();
    }
  },
);

it.each([
  "origin-403",
  "pool-404",
  "pool-refused-404",
  "not-maintainer-404",
  "overload-503",
  "shutdown-503",
  "deadline-504",
])("INV-5 INV-7: %s refusal must cross the request redaction choke point", async (kind) => {
  const entered = deferred<void>();
  const blocked = deferred<void>();
  const capacity = kind === "overload-503" || kind === "deadline-504";
  const status = kind.includes("403") ? 403 : kind.includes("404") ? 404 : kind.includes("504") ? 504 : 503;
  const message =
    status === 403
      ? "MCP access is forbidden."
      : status === 404
        ? "MCP endpoint not found."
        : status === 504
          ? "MCP request lifetime exceeded."
          : kind === "overload-503"
            ? "Server capacity is exhausted. Retry later."
            : "Server is shutting down.";
  const code =
    kind === "overload-503"
      ? -33001
      : kind === "shutdown-503"
        ? -33002
        : status === 504
          ? -33003
          : status === 404
            ? -33004
            : -33005;
  if (kind === "deadline-504") vi.useFakeTimers();
  const app = createTestConnecta({
    connectors: [calcApi()],
    logger: silentLogger,
    ...(capacity
      ? {
          admission: { requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: 100 } },
          auth: {
            kind: "blocked",
            authorize: async () => {
              entered.resolve();
              await blocked.promise;
              return { ok: true as const };
            },
          },
          maintainers: [{ namespace: "connecta:test", id: "caller" }],
        }
      : {
          auth: {
            kind: "test",
            activityActorNamespace: "connecta:test",
            interactiveOperator: true,
            authorize: () => ({ ok: true as const, userId: "caller" }),
          },
          // The caller is a maintainer except where the refusal is that it is not one (#837).
          maintainers: [kind === "not-maintainer-404" ? "other" : "caller"],
        }),
    pools: { refused: { tools: ["calc"], members: [{ namespace: "connecta:test", id: "other" }] } },
  });
  let occupied: Promise<Response> | undefined;
  try {
    const pool = kind === "pool-refused-404" ? "refused" : "missing";
    const request = kind.startsWith("pool-")
      ? new Request(`https://connecta.test/mcp/${pool}`, modernRequest("tools/list"))
      : modernRequest("tools/list");
    if (kind === "origin-403") request.headers.set("Origin", "https://attacker.test");
    sentSecretsForRequest(request).add(message);
    if (kind === "shutdown-503") await app.close();
    if (kind === "overload-503") {
      occupied = app.fetch(modernRequest("tools/list"));
      await entered.promise;
    }
    const pending = app.fetch(request);
    if (kind === "deadline-504") {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(100);
    }
    const response = await pending;
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    const body = await response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", error: { code, message: "[redacted]" } });
    expect(body).not.toHaveProperty("id");
  } finally {
    blocked.resolve();
    await occupied?.then((response) => response.text());
    await app.close();
  }
});

it("INV-5 INV-7: a deadline refusal shares credentials sent by the registered meta-tool", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => Response.json({ ok: true }));
  const entered = deferred<void>();
  const blocked = deferred<void>();
  const message = "MCP request lifetime exceeded.";
  // Hold SDK serialization after the connector sent its credential, so the
  // route deadline has to produce its own response with that request's set.
  wire.blocked = blocked.promise;
  const connector = api("sender", {
    tools: [
      {
        name: "read",
        description: "Read",
        annotations: { readOnlyHint: true },
        handler: async (_args, ctx) => {
          await ctx.fetch("https://downstream.test/read", { headers: { "X-API-Key": message } });
          entered.resolve();
          return null;
        },
      },
    ],
  });
  const app = createTestConnecta({
    connectors: [connector],
    logger: silentLogger,
    admission: { requests: { maxDurationMs: 100 } },
  });
  try {
    const pending = app.fetch(
      modernRequest("tools/call", { name: "call_tool", arguments: { address: "sender.read" } }),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", error: { code: -33003, message: "[redacted]" } });
    const health = await app.fetch(new Request("https://connecta.test/health"));
    expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 } } });
  } finally {
    blocked.resolve();
    await app.close();
  }
});

it("INV-4 INV-5: every registered meta-tool binds the envelope and redacts its result", async () => {
  const connector = api("contract", {
    tools: [
      {
        name: "read",
        description: `Read ${TOKEN}`,
        annotations: { readOnlyHint: true },
        handler: () => ({ echo: TOKEN }),
      },
    ],
  });
  connector.usageGuide = `Guide ${TOKEN}`;
  connector.startAuth = async () => ({ state: "auth_required" });
  type Handler = (args: Record<string, unknown>, request: ServerContext) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const requestScope = {};
  sentSecretsForRequest(requestScope).add(TOKEN);
  const client: McpClientContext = {};
  registerMetaTools(server, makeRegistry([connector]), {
    baseUrl: "https://connecta.test",
    requestScope,
    client,
    canManageAuth: () => true,
    oauthConnectUrl: async () => `https://oauth.test/${TOKEN}`,
  });
  const args: Record<string, Record<string, unknown>> = {
    skills: { name: "connector:contract" },
    search_tools: { connector: "contract", fullDescriptions: true },
    call_tool: { address: "contract.read", resultMode: "value" },
    call_destructive_tool: { address: "contract.read", reason: "Contract test", resultMode: "value" },
    authorize_connector: { connector: "contract" },
  };
  expect([...handlers.keys()].sort()).toEqual(Object.keys(args).sort());
  const envelope = {
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
    "io.modelcontextprotocol/clientInfo": { name: "contract-host", version: "1" },
  };
  for (const [name, handler] of handlers) {
    const result = JSON.stringify(await handler(args[name]!, { mcpReq: { envelope } } as unknown as ServerContext));
    expect(result, name).not.toContain(TOKEN);
    expect(result, name).toContain("[redacted]");
    expect(client).toEqual({
      clientCapabilities: { elicitation: { url: {} } },
      clientInfo: { name: "contract-host", version: "1" },
    });
    await handler(args[name]!, { mcpReq: {} } as ServerContext);
    expect(client).toEqual({});
  }
});

it("INV-5 INV-7: a stalled-listen deadline refusal redacts and cancels the request body", async () => {
  let cancelled = false;
  const request = new Request("https://connecta.test/mcp", {
    method: "POST",
    headers: modernRequest("subscriptions/listen").headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"'));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit);
  sentSecretsForRequest(request).add("MCP request lifetime exceeded.");
  const app = createTestConnecta({
    connectors: [],
    logger: silentLogger,
    admission: { requests: { maxDurationMs: 100 } },
  });
  try {
    const response = await app.fetch(request);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", error: { code: -33003, message: "[redacted]" } });
    expect(cancelled).toBe(true);
  } finally {
    await app.close();
  }
});
