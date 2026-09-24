// The request pipeline's lifetime rules (P1-S17): a request is one fiber tied
// to its signal, and what it holds — the admission permit, its McpServer, its
// discovery probes — ends with it, however it ends.
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";

afterEach(() => vi.restoreAllMocks());

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}

/** Settles within `ms`, or reports that it did not. */
function within<T>(promise: Promise<T>, ms = 500): Promise<T | "still pending"> {
  return Promise.race([
    promise,
    new Promise<"still pending">((resolve) =>
      setTimeout(() => resolve("still pending"), ms),
    ),
  ]);
}

async function admission(connecta: { fetch(request: Request): Promise<Response> }) {
  const health = await connecta.fetch(new Request(`${BASE}/health`));
  return ((await health.json()) as {
    admission: { requests: { active: number; queued: number } };
  }).admission.requests;
}

const ONE_PERMIT = {
  requests: { concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 5_000 },
};

describe("request pipeline lifetime", () => {
  it("releases the permit of an /mcp request whose client leaves during authorization", async () => {
    let calls = 0;
    const auth: InboundAuth = {
      kind: "stalled",
      authorize() {
        calls++;
        return new Promise(() => {});
      },
    };
    const connecta = createTestConnecta({
      connectors: [],
      auth,
      logger: silentLogger,
      admission: ONE_PERMIT,
    });
    const controller = new AbortController();
    const pending = connecta.fetch(
      mcpRpc("tools/list", {}, { id: 1, signal: controller.signal }),
    );
    pending.catch(() => {});
    await waitFor(() => calls === 1);
    expect(await admission(connecta)).toMatchObject({ active: 1 });

    controller.abort(new Error("caller left"));
    await expect(within(pending)).rejects.toThrow("caller left");
    expect(await admission(connecta)).toMatchObject({ active: 0, queued: 0 });
  });

  it("releases the permit of a legacy /mcp request whose client leaves mid-call", async () => {
    // Nothing reaches a stalled startAuth: it takes no signal. The request's
    // permit must still end with the request.
    let started = false;
    const connector: Connector = {
      id: "stalled",
      kind: "api",
      description: "A connector whose OAuth start never settles",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      startAuth() {
        started = true;
        return new Promise(() => {});
      },
    };
    const auth: InboundAuth = {
      kind: "operator",
      interactiveOperator: true,
      authorize: () => ({ ok: true, userId: "operator" }),
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth,
      logger: silentLogger,
      admission: ONE_PERMIT,
    });
    const controller = new AbortController();
    const pending = connecta.fetch(mcpRpc(
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "stalled" } },
      { id: 1, signal: controller.signal },
    ));
    pending.catch(() => {});
    await waitFor(() => started);

    controller.abort(new Error("caller left"));
    await expect(within(pending)).rejects.toThrow("caller left");
    expect(await admission(connecta)).toMatchObject({ active: 0, queued: 0 });
  });

  it("hands a released permit to the next queued request", async () => {
    let calls = 0;
    const auth: InboundAuth = {
      kind: "stalled-first",
      authorize() {
        calls++;
        return calls === 1 ? new Promise(() => {}) : { ok: true };
      },
    };
    const connecta = createTestConnecta({
      connectors: [],
      auth,
      logger: silentLogger,
      admission: ONE_PERMIT,
    });
    const controller = new AbortController();
    const first = connecta.fetch(
      mcpRpc("tools/list", {}, { id: 1, signal: controller.signal }),
    );
    first.catch(() => {});
    await waitFor(() => calls === 1);
    const second = connecta.fetch(mcpRpc("tools/list", {}, { id: 2 }));
    await waitFor(async () => (await admission(connecta)).queued === 1);

    controller.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    const response = await second;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: expect.any(Array) } });
    expect(await admission(connecta)).toMatchObject({ active: 0, queued: 0 });
  });

  it("aborts search_tools discovery probes when the request's client leaves", async () => {
    let probeSignal: AbortSignal | undefined;
    const connector: Connector = {
      id: "slow",
      kind: "api",
      description: "A catalog that answers only when cancelled",
      listTools(ctx) {
        probeSignal = ctx.signal;
        return new Promise((_, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => reject(ctx.signal?.reason),
            { once: true },
          );
        });
      },
      async callTool() {
        return null;
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [],
      logger: silentLogger,
      discovery: { probeTimeoutMs: 60_000, persistCatalog: false },
    });
    const controller = new AbortController();
    const pending = connecta.fetch(mcpRpc(
      "tools/call",
      { name: "search_tools", arguments: { query: "anything" } },
      { id: 1, signal: controller.signal },
    ));
    pending.catch(() => {});
    await waitFor(() => probeSignal !== undefined);

    controller.abort(new Error("caller left"));
    await within(pending).catch(() => {});
    expect(probeSignal?.aborted).toBe(true);
    expect(await admission(connecta)).toMatchObject({ active: 0 });
  });

  it("closes each request's McpServer once its response has been read", async () => {
    const close = vi.spyOn(McpServer.prototype, "close");
    const connecta = createTestConnecta({
      connectors: [],
      auth: [],
      logger: silentLogger,
    });
    const response = await connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    expect(close).not.toHaveBeenCalled();
    await response.text();
    await waitFor(() => close.mock.calls.length === 1);
    expect(await admission(connecta)).toMatchObject({ active: 0 });
  });
});
