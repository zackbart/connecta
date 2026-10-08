import { describe, expect, it } from "vitest";
import type { ServerContext } from "@modelcontextprotocol/server";
import { activityHistory, recordToolActivity, type ActivityRequestContext, type ToolCallActivityEvent } from "../src/activity.js";
import { bindMcpClient, type McpClientContext } from "../src/mcp-client-context.js";
import { META_TOOL_NAMES } from "../src/meta-tool-names.js";
import { calcApi, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const VERSION = "2026-07-28";
function modern(method: string, params: Record<string, unknown> = {}, clientInfo?: unknown): Request {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": VERSION, "Mcp-Method": method,
      ...(params.arguments && typeof params.arguments === "object" && "address" in params.arguments ? { "Mcp-Param-Address": String(params.arguments.address) } : {}),
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
        ...(clientInfo === undefined ? {} : { "io.modelcontextprotocol/clientInfo": clientInfo }),
      },
    } }),
  });
}

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

  it("INV-6: records only bounded typed client name and version facts", () => {
    const events: ToolCallActivityEvent[] = [];
    const context: ActivityRequestContext = {
      sink: { record: event => void events.push(event) }, actor: { kind: "test" }, requestId: "r",
      serverInfo: { name: "connecta", version: "0" }, logger: silentLogger,
      clientInfo: { name: "💻".repeat(200), version: "v".repeat(1000), payload: "secret" } as { name: string; version: string },
    };
    recordToolActivity(context, { connectorId: "calc", toolName: "add", address: "calc.add", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1 });
    const event = required(events[0]);
    expect(new TextEncoder().encode(event.clientName).byteLength).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(event.clientVersion).byteLength).toBeLessThanOrEqual(128);
    expect(JSON.stringify(event)).not.toContain("secret");
    context.clientInfo = { name: 42, version: { code: "secret" } } as unknown as { name: string; version: string };
    recordToolActivity(context, { connectorId: "calc", toolName: "add", address: "calc.add", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1 });
    expect(events[1]).not.toHaveProperty("clientName");
    expect(events[1]).not.toHaveProperty("clientVersion");
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
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -33005, message: "MCP access is forbidden." } });
    } finally { await c.close(); }
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
