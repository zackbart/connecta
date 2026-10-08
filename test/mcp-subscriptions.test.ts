import { describe, expect, it } from "vitest";
import { machineAuth } from "./helpers/machine-auth.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const TOKEN = "subscription-test";

function rpc(era: "modern" | "legacy", method: string, params: Record<string, unknown>, id: number): Request {
  const request = mcpRpc(
    method,
    era === "modern"
      ? {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }
      : params,
    { id, token: TOKEN },
  );
  request.headers.set("MCP-Protocol-Version", era === "modern" ? "2026-07-28" : "2025-06-18");
  if (era === "modern") {
    request.headers.set("Mcp-Method", method);
    if (params.arguments && typeof params.arguments === "object" && "address" in params.arguments) {
      request.headers.set("Mcp-Param-Address", String(params.arguments.address));
    }
    if (typeof params.name === "string") request.headers.set("Mcp-Name", params.name);
  }
  return request;
}

function deployment() {
  return createTestConnecta({
    connectors: [calcConnector],
    auth: machineAuth(TOKEN),
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
      const request =
        era === "modern"
          ? rpc(era, "server/discover", {}, 1)
          : rpc(
              era,
              "initialize",
              {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "subscription-test", version: "1.0.0" },
              },
              1,
            );
      const response = await c.fetch(request);
      expect(response.status).toBe(200);
      const body = await readJsonRpc(response);
      expect(body.result.capabilities).toEqual({
        tools: { listChanged: false },
        resources: {},
        extensions: { "io.modelcontextprotocol/skills": {} },
      });
    } finally {
      await c.close();
    }
  });

  it.each(["modern", "legacy"] as const)(
    "refuses 20 concurrent %s listens without starving tools/call",
    async (era) => {
      const c = deployment();
      const controller = new AbortController();
      const requests: Promise<{ status: number; body: any; contentType: string | null }>[] = [];
      const send = (request: Request) => {
        const pending = c.fetch(new Request(request, { signal: controller.signal })).then(async (response) => ({
          status: response.status,
          contentType: response.headers.get("Content-Type"),
          body: await readJsonRpc(response),
        }));
        requests.push(pending);
        return pending;
      };
      try {
        // Start more listens than there are permits, then queue a real call
        // behind them. Modern refusals must never take a permit; legacy refusals
        // release theirs on read. An SSE listen would starve the queued call.
        const listens = Array.from({ length: 20 }, (_, i) =>
          send(
            rpc(
              era,
              "subscriptions/listen",
              {
                notifications: { toolsListChanged: true },
              },
              i + 1,
            ),
          ),
        );
        const call = send(
          rpc(
            era,
            "tools/call",
            {
              name: "call_tool",
              arguments: { address: "calc.add", args: { a: 1, b: 2 } },
            },
            21,
          ),
        );
        const result = await call;
        expect(result.status).toBe(200);
        expect(result.body.error).toBeUndefined();
        expect(result.body.result.isError).not.toBe(true);
        expect(JSON.parse(result.body.result.content[0].text)).toEqual({ sum: 3 });

        for (const [i, response] of (await Promise.all(listens)).entries()) {
          expect(response.status).toBe(era === "modern" ? 404 : 200);
          expect(response.contentType).toContain("application/json");
          expect(response.body).toMatchObject({
            id: i + 1,
            error: { code: -32601 },
          });
          expect(response.body.result).toBeUndefined();
          if (era === "modern") expect(response.body.error.message).toBe("Method not found: subscriptions/listen");
        }
        const health = await c.fetch(new Request(`${BASE}/health`));
        expect(await health.json()).toMatchObject({
          admission: {
            requests: { active: 0, queued: 0, totals: { admitted: era === "modern" ? 1 : 21, rejected: 0 } },
          },
        });
      } finally {
        controller.abort();
        await Promise.allSettled(requests);
        await c.close();
      }
    },
  );

  it("refuses modern listens even when admission is full, without admitting a spoofed tools/call", async () => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = createTestConnecta({
      connectors: [
        {
          ...calcConnector,
          async callTool() {
            started();
            await blocked;
            return { sum: 3 };
          },
        },
      ],
      auth: machineAuth(TOKEN),
      publicUrl: BASE,
      logger: silentLogger,
      admission: { requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: 5_000 } },
    });
    const call = c.fetch(
      rpc(
        "modern",
        "tools/call",
        {
          name: "call_tool",
          arguments: { address: "calc.add", args: { a: 1, b: 2 } },
        },
        1,
      ),
    );
    try {
      await entered;
      const listen = await c.fetch(
        rpc(
          "modern",
          "subscriptions/listen",
          {
            notifications: { toolsListChanged: true },
          },
          2,
        ),
      );
      expect(listen.status).toBe(404);
      expect(await readJsonRpc(listen)).toMatchObject({ id: 2, error: { code: -32601 } });
      for (const era of ["modern", "legacy"] as const) {
        const spoofed = rpc(
          era,
          "tools/call",
          {
            name: "call_tool",
            arguments: { address: "calc.add", args: { a: 1, b: 2 } },
          },
          3,
        );
        spoofed.headers.set("Mcp-Method", "subscriptions/listen");
        const refusal = await c.fetch(spoofed);
        expect(refusal.status).toBe(503);
        await refusal.text();
      }
    } finally {
      release();
      await (await call).text();
      await c.close();
    }
  });

  it.each([
    ["authentication", (request: Request) => request.headers.delete("Authorization"), 401, undefined],
    ["protocol header", (request: Request) => request.headers.delete("MCP-Protocol-Version"), 400, -32020],
    ["header mismatch", (request: Request) => request.headers.set("MCP-Protocol-Version", "2025-06-18"), 400, -32020],
    ["method header", (request: Request) => request.headers.set("Mcp-Method", "tools/list"), 400, -32020],
    ["content type", (request: Request) => request.headers.set("Content-Type", "text/plain"), 415, -32000],
  ] as const)("retains %s validation before refusing a listen", async (_name, change, status, code) => {
    const c = deployment();
    try {
      const request = rpc("modern", "subscriptions/listen", { notifications: { toolsListChanged: true } }, 1);
      change(request);
      const response = await c.fetch(request);
      expect(response.status).toBe(status);
      if (code !== undefined) expect(await readJsonRpc(response)).toMatchObject({ error: { code } });
      else await response.text();
    } finally {
      await c.close();
    }
  });

  it("bounds authorization for a modern listen without taking a permit", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = createTestConnecta({
      connectors: [],
      publicUrl: BASE,
      logger: silentLogger,
      auth: {
        kind: "stalled",
        async authorize() {
          await blocked;
          return { ok: true };
        },
      },
      admission: { requests: { maxDurationMs: 100 } },
    });
    try {
      const response = await c.fetch(
        rpc(
          "modern",
          "subscriptions/listen",
          {
            notifications: { toolsListChanged: true },
          },
          1,
        ),
      );
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -33003 } });
      const health = await c.fetch(new Request(`${BASE}/health`));
      expect(await health.json()).toMatchObject({
        admission: { requests: { active: 0, totals: { admitted: 0 } } },
      });
    } finally {
      release();
      await c.close();
    }
  });

  it("cancels a stalled listen body at the request deadline", async () => {
    let cancelled = false;
    const c = createTestConnecta({
      connectors: [],
      auth: machineAuth(TOKEN),
      publicUrl: BASE,
      logger: silentLogger,
      admission: { requests: { maxDurationMs: 100 } },
    });
    try {
      const headers = rpc("modern", "subscriptions/listen", {}, 1).headers;
      const response = await c.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -33003 } });
      expect(cancelled).toBe(true);
    } finally {
      await c.close();
    }
  });
});
