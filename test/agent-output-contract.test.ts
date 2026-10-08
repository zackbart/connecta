import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { mcpRpc } from "./fixtures/http.js";
import { createTestConnecta, silentLogger } from "./helpers.js";

const wire = vi.hoisted(() => ({ body: "", type: "application/json", status: 200 }));
const TOKEN = "serialized-agent-output-credential";

// Inject an SDK-produced response after a real handler sent a credential.
// These values never pass through connector or meta-tool result redaction.
vi.mock("@modelcontextprotocol/server", async importOriginal => {
  const sdk = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...sdk,
    createMcpHandler: (...args: Parameters<typeof sdk.createMcpHandler>) => {
      const handler = sdk.createMcpHandler(...args);
      return {
        ...handler,
        fetch: async (request: Request) => {
          await (await handler.fetch(request)).text();
          return new Response(wire.body, { status: wire.status, headers: { "Content-Type": wire.type } });
        },
      };
    },
  };
});

afterEach(() => { vi.unstubAllGlobals(); });

it.each(["rpc-error", "http-400", "isError", "structuredContent", "paging"])("INV-5: serialized %s output must cross the request redaction choke point", async kind => {
  vi.stubGlobal("fetch", async () => Response.json({ ok: true }));
  const connector = api("sender", { tools: [{
    name: "read", description: "Read", annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => {
      await ctx.fetch("https://downstream.test/read", { headers: { "X-API-Key": TOKEN } });
      return null;
    },
  }] });
  wire.type = kind === "http-400" ? "text/plain" : "application/json";
  wire.status = kind === "http-400" ? 400 : 200;
  wire.body = kind === "rpc-error"
    ? JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: TOKEN, data: { echo: TOKEN } } })
    : kind === "http-400" ? `Refused ${TOKEN}`
    : kind === "isError" ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [
      { type: "text", text: TOKEN.slice(0, 12) }, { type: "text", text: TOKEN.slice(12) },
    ] } })
    : kind === "structuredContent" ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { [TOKEN]: { echo: TOKEN } } } })
    : JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `{"offset":0}\n${TOKEN}` }] } });
  const app = createTestConnecta({ connectors: [connector], logger: silentLogger });
  try {
    const request = mcpRpc("tools/call", {
      name: "call_tool", arguments: { address: "sender.read" }, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    });
    request.headers.set("MCP-Protocol-Version", "2026-07-28");
    request.headers.set("Mcp-Method", "tools/call");
    request.headers.set("Mcp-Name", "call_tool");
    const response = await app.fetch(request);
    expect(response.status).toBe(wire.status);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[redacted]");
    if (kind === "isError") {
      expect(JSON.parse(text).result.content.map((block: { text: string }) => block.text).join("")).toBe("[redacted]");
    }
  } finally { await app.close(); }
});
