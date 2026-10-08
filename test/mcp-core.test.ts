import { describe, expect, it } from "vitest";
import { specTypeSchemas, type ServerContext } from "@modelcontextprotocol/server";
import { activityHistory, recordToolActivity, type ActivityRequestContext, type ToolCallActivityEvent } from "../src/activity.js";
import { bindMcpClient, type McpClientContext } from "../src/mcp-client-context.js";
import { META_TOOL_NAMES } from "../src/meta-tool-names.js";
import { calcApi, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, required, silentLogger } from "./helpers.js";
import { checkClientActivity, INVALID_CLIENT_FACTS, VALID_CLIENT_IDENTITIES, modernRequest as modern } from "./fixtures/client-identity.js";

const BASE = "https://connecta.test";
const VERSION = "2026-07-28";

describe("2026-07-28 core", () => {
  it("INV-4: binds SDK envelope capabilities and identity as request context only", () => {
    const client: McpClientContext = {};
    bindMcpClient({ mcpReq: { envelope: {
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
      "io.modelcontextprotocol/clientInfo": { name: "host", version: "1", privatePayload: "secret" },
    } } } as unknown as ServerContext, client);
    expect(client).toEqual({ clientCapabilities: { elicitation: { url: {} } }, clientInfo: { name: "host", version: "1" } });
    bindMcpClient({ mcpReq: {} } as ServerContext, client);
    expect(client).toEqual({});
  });

  it("INV-4: drops prototype keys from declared client capabilities", () => {
    const client: McpClientContext = {};
    const declared = JSON.parse('{"__proto__":{"polluted":true},"constructor":{},"prototype":{},"elicitation":{"url":{}}}');
    bindMcpClient({ mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": declared } } } as unknown as ServerContext, client);
    const capabilities = required(client.clientCapabilities);
    expect(Object.keys(capabilities)).toEqual(["elicitation"]);
    expect(Object.getPrototypeOf(capabilities)).toBeNull();
    expect((capabilities as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("INV-6: records only bounded typed client name and version facts", () => {
    const events: ToolCallActivityEvent[] = [];
    const context: ActivityRequestContext = {
      sink: { record: event => void events.push(event) }, actor: { kind: "test" }, requestId: "r",
      serverInfo: { name: "connecta", version: "0" }, logger: silentLogger,
    };
    for (const value of INVALID_CLIENT_FACTS) {
      for (const source of ["call_tool", "call_destructive_tool", "execute_code"] as const) {
        context.clientInfo = { name: value, version: value } as NonNullable<ActivityRequestContext["clientInfo"]>;
        recordToolActivity(context, { connectorId: "calc", toolName: "add", address: "calc.add", source, outcome: "success", durationMs: 1, attempts: 1 });
        expect(events.at(-1)).not.toHaveProperty("clientName");
        expect(events.at(-1)).not.toHaveProperty("clientVersion");
      }
    }
    for (const clientInfo of VALID_CLIENT_IDENTITIES) {
      context.clientInfo = clientInfo;
      recordToolActivity(context, { connectorId: "calc", toolName: "add", address: "calc.add", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1 });
      expect(events.at(-1)).toMatchObject({ clientName: clientInfo.name, clientVersion: clientInfo.version });
    }
  });

  it("INV-6: withholds invalid modern client facts across direct/program activity and UI", async () => {
    const events: ToolCallActivityEvent[] = [];
    await checkClientActivity({ record: event => void events.push(event), list: async () => ({ events }) });
  });

  it("INV-6: rechecks client facts from custom activity readers before serving UI", async () => {
    let template!: ToolCallActivityEvent;
    recordToolActivity({
      sink: { record: event => { template = event; } }, actor: { kind: "test" }, requestId: "r",
      serverInfo: { name: "connecta", version: "0" }, logger: silentLogger,
    }, { connectorId: "calc", toolName: "add", address: "calc.add", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1 });
    const events: ToolCallActivityEvent[] = [...INVALID_CLIENT_FACTS, "v".repeat(33)].map(value => ({
      ...template, packageVersion: value as string, clientName: value as string, clientVersion: value as string,
    }));
    events.push(...VALID_CLIENT_IDENTITIES.map(clientInfo => ({ ...template, clientName: clientInfo.name, clientVersion: clientInfo.version })));
    const c = createTestConnecta({ connectors: [], logger: silentLogger,
      auth: { kind: "test", interactiveOperator: true, authorize: () => ({ ok: true, userId: "operator" }) },
      activity: activityHistory({ store: { record() {}, list: async () => ({ events }) } }),
    });
    try {
      const response = await c.fetch(new Request(`${BASE}/ui/activity`));
      expect(response.status).toBe(200);
      const page = await response.json() as { events: ToolCallActivityEvent[] };
      for (const event of page.events.slice(0, INVALID_CLIENT_FACTS.length)) {
        expect(event).not.toHaveProperty("clientName");
        expect(event).not.toHaveProperty("clientVersion");
        expect(event).not.toHaveProperty("packageVersion");
      }
      expect(page.events[INVALID_CLIENT_FACTS.length]).toMatchObject({ clientName: "v".repeat(33) });
      expect(page.events[INVALID_CLIENT_FACTS.length]).not.toHaveProperty("clientVersion");
      expect(page.events.slice(-VALID_CLIENT_IDENTITIES.length)).toEqual(events.slice(-VALID_CLIENT_IDENTITIES.length));
      // Reading does not mutate the stored event.
      expect(events[0]!.clientName).toBe(INVALID_CLIENT_FACTS[0]);
    } finally { await c.close(); }
  });

  it("INV-4: activity API is read-only and retains the operator and read gates", async () => {
    for (const [operator, gate, status] of [[false, true, 403], [true, false, 403], [true, true, 200]] as const) {
      let reads = 0;
      const c = createTestConnecta({ connectors: [], logger: silentLogger,
        auth: { kind: "test", activityActorNamespace: "connecta:test", interactiveOperator: true, authorize: () => ({ ok: true, userId: "operator" }) },
        identity: { activityAccess: () => operator },
        activity: activityHistory({ readGate: () => gate, store: { record() {}, list: async () => { reads++; return { events: [] }; } } }),
      });
      try {
        const response = await c.fetch(new Request(`${BASE}/ui/api/activity`));
        expect(response.status).toBe(status);
        expect(response.headers.get("Cache-Control")).toContain("no-store");
        expect(reads).toBe(status === 200 ? 1 : 0);
        expect((await c.fetch(new Request(`${BASE}/ui/api/activity`, { method: "POST" }))).status).toBe(405);
      } finally { await c.close(); }
    }
  });

  it("INV-6 INV-7: threads per-request client identity into direct and program activity without retaining capabilities", async () => {
    const events: ToolCallActivityEvent[] = [];
    const c = createTestConnecta({ connectors: [calcApi()], logger: silentLogger,
      activity: activityHistory({ store: { record: event => void events.push(event) } }),
      executor: { execute: async (_code, options) => {
        await required(options.find(provider => provider.name === "connecta")).fns.call!("calc.add", { a: 1, b: 2 });
        return { result: 3 };
      } },
    });
    try {
      for (const name of ["call_tool", "call_destructive_tool", "execute_code"]) {
        const args = name === "execute_code" ? { code: "async () => 3" } : { address: "calc.add", args: { a: 1, b: 2 } };
        const body = await readJsonRpc(await c.fetch(modern("tools/call", { name, arguments: args }, { name, version: "1", description: "payload" })));
        expect(body.error).toBeUndefined();
        expect(body.result.isError).not.toBe(true);
      }
      await readJsonRpc(await c.fetch(modern("tools/call", { name: "call_tool", arguments: { address: "calc.add", args: { a: 1, b: 2 } } })));
      await readJsonRpc(await mcpRpc(c, "tools/call", { name: "call_tool", arguments: { address: "calc.add", args: { a: 1, b: 2 } } }));
      expect(events.map(event => event.clientName)).toEqual(["call_tool", "call_destructive_tool", "execute_code", undefined, undefined]);
      expect(JSON.stringify(events)).not.toContain("elicitation");
      expect(JSON.stringify(events)).not.toContain("payload");
    } finally { await c.close(); }
  });

  it("INV-4: returns a payload-free JSON-RPC forbidden error for invalid admitted permissions", async () => {
    const c = createTestConnecta({ connectors: [], logger: silentLogger,
      auth: { kind: "test", authorize: () => ({ ok: true }) },
      identity: { connectorAccess: () => ["missing"] },
    });
    try {
      const response = await c.fetch(modern("tools/list"));
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.json();
      expect((await specTypeSchemas.JSONRPCErrorResponse["~standard"].validate(body)).issues).toBeUndefined();
      expect(body).toEqual({ jsonrpc: "2.0", error: { code: -33005, message: "MCP access is forbidden." } });
    } finally { await c.close(); }
  });

  it("INV-4 INV-7: validates transport refusals against the modern JSON-RPC error schema", async () => {
    async function refusal(response: Response, status: number, code: number): Promise<void> {
      expect(response.status).toBe(status);
      const body = await response.json();
      expect((await specTypeSchemas.JSONRPCErrorResponse["~standard"].validate(body)).issues).toBeUndefined();
      expect(body).not.toHaveProperty("id");
      expect(body).toMatchObject({ jsonrpc: "2.0", error: { code } });
    }
    const c = createTestConnecta({ connectors: [], logger: silentLogger });
    try {
      const origin = modern("tools/list");
      origin.headers.set("Origin", "https://attacker.example");
      await refusal(await c.fetch(origin), 403, -33005);
      await refusal(await c.fetch(new Request(`${BASE}/mcp/missing`, modern("tools/list"))), 404, -33004);
    } finally { await c.close(); }
    await refusal(await c.fetch(modern("tools/list")), 503, -33002);

    let release!: () => void;
    let authorizing = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const busy = createTestConnecta({ connectors: [], logger: silentLogger,
      admission: { requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: 100 } },
      auth: { kind: "blocked", authorize: async () => { authorizing = true; await blocked; return { ok: true }; } },
    });
    const first = busy.fetch(modern("tools/list"));
    try {
      await expect.poll(() => authorizing).toBe(true);
      await refusal(await busy.fetch(modern("tools/list")), 503, -33001);
      await refusal(await first, 504, -33003);
    } finally {
      release();
      await first.then(response => response.body?.cancel()).catch(() => {});
      await busy.close();
    }
  });

  it("INV-7: cancels an adapter stream returned by the request deadline abort", async () => {
    let cancelled = false;
    const c = createTestConnecta({ connectors: [], logger: silentLogger,
      admission: { requests: { maxDurationMs: 25 } },
      auth: { kind: "abort-aware", authorize: request => new Promise(resolve => {
        request.signal.addEventListener("abort", () => resolve({ ok: false, response: new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(new TextEncoder().encode("adapter")); },
            cancel() { cancelled = true; },
          }), { status: 403, headers: { "Content-Type": "text/plain" } },
        ) }), { once: true });
      }) },
    });
    try {
      const response = await c.fetch(modern("tools/list"));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
      expect(cancelled).toBe(true);
      const health = await c.fetch(new Request(`${BASE}/health`));
      expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 } } });
    } finally { await c.close(); }
  });

  it("advertises served extensions, identity, and private discovery cache hints", async () => {
    const c = createTestConnecta({ connectors: [], logger: silentLogger,
      serverInfo: { name: "acme", version: "1", title: "Acme", websiteUrl: "https://acme.example", icons: [{ src: "https://acme.example/icon.svg" }] },
    });
    try {
      const body = await readJsonRpc(await c.fetch(modern("server/discover")));
      expect(body.result).toMatchObject({ resultType: "complete", supportedVersions: [VERSION], capabilities: { tools: { listChanged: false }, extensions: {} }, ttlMs: 3_600_000, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": { name: "acme", version: "1", title: "Acme", websiteUrl: "https://acme.example", icons: [{ src: "https://acme.example/icon.svg" }] } } });
    } finally { await c.close(); }
  });

  it("declares address headers on both direct-call tools and exports exactly the served tool names", async () => {
    const c = createTestConnecta({ connectors: [], logger: silentLogger });
    try {
      const body = await readJsonRpc(await c.fetch(modern("tools/list")));
      expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...META_TOOL_NAMES].sort());
      for (const name of ["call_tool", "call_destructive_tool"]) {
        const tool = body.result.tools.find((entry: { name: string }) => entry.name === name);
        expect(tool.inputSchema.properties.address["x-mcp-header"]).toBe("Address");
      }
      const request = modern("tools/call", { name: "call_tool", arguments: { address: "calc.add" } });
      request.headers.set("Mcp-Param-Address", "calc.subtract");
      const response = await c.fetch(request);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32020);
    } finally { await c.close(); }
  });
});
