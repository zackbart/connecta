import { describe, expect, it } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const TOKEN = "subscription-test";

function rpc(era: "modern" | "legacy", method: string, params: Record<string, unknown>, id: number): Request {
  const request = mcpRpc(method, era === "modern" ? {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  } : params, { id, token: TOKEN });
  request.headers.set("MCP-Protocol-Version", era === "modern" ? "2026-07-28" : "2025-06-18");
  if (era === "modern") {
    request.headers.set("Mcp-Method", method);
    if (typeof params.name === "string") request.headers.set("Mcp-Name", params.name);
  }
  return request;
}

function deployment() {
  return createTestConnecta({
    connectors: [calcConnector],
    auth: bearerToken(TOKEN),
    publicUrl: BASE,
    logger: silentLogger,
    admission: {
      requests: { concurrency: 16, maxQueueSize: 32, queueTimeoutMs: 1_000, maxDurationMs: 5_000 },
    },
  });
}

describe("MCP subscriptions", () => {
  it.each(["modern", "legacy"] as const)("does not advertise tool list changes to a %s client", async (era) => {
    const c = deployment();
    try {
      const request = era === "modern"
        ? rpc(era, "server/discover", {}, 1)
        : rpc(era, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "subscription-test", version: "1.0.0" },
          }, 1);
      const response = await c.fetch(request);
      expect(response.status).toBe(200);
      const body = await readJsonRpc(response);
      expect(body.result.capabilities.tools).toEqual({ listChanged: false });
    } finally {
      await c.close();
    }
  });

  it.each(["modern", "legacy"] as const)("refuses 20 concurrent %s listens without starving tools/call", async (era) => {
    const c = deployment();
    const controller = new AbortController();
    const requests: Promise<{ status: number; body: any; contentType: string | null }>[] = [];
    const send = (request: Request) => {
      const pending = c.fetch(new Request(request, { signal: controller.signal })).then(async response => ({
        status: response.status,
        contentType: response.headers.get("Content-Type"),
        body: await readJsonRpc(response),
      }));
      requests.push(pending);
      return pending;
    };
    try {
      // Start more listens than there are permits, then queue a real call
      // behind them. Reading each refusal releases its normal request permit;
      // an SSE listen would keep it and the tool call would time out in queue.
      const listens = Array.from({ length: 20 }, (_, i) => send(rpc(era, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      }, i + 1)));
      const call = send(rpc(era, "tools/call", {
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 1, b: 2 } },
      }, 21));
      const result = await call;
      expect(result.status).toBe(200);
      expect(result.body.error).toBeUndefined();
      expect(result.body.result.isError).not.toBe(true);
      expect(JSON.parse(result.body.result.content[0].text)).toEqual({ sum: 3 });

      for (const [i, response] of (await Promise.all(listens)).entries()) {
        expect(response.status).toBe(200);
        expect(response.contentType).toContain("application/json");
        expect(response.body).toMatchObject({
          id: i + 1,
          error: { code: era === "modern" ? -32603 : -32601 },
        });
        expect(response.body.result).toBeUndefined();
        if (era === "modern") expect(response.body.error.message).toBe("Subscription limit reached");
      }
      const health = await c.fetch(new Request(`${BASE}/health`));
      expect(await health.json()).toMatchObject({
        admission: { requests: { active: 0, queued: 0, totals: { rejected: 0 } } },
      });
    } finally {
      controller.abort();
      await Promise.allSettled(requests);
      await c.close();
    }
  });
});
