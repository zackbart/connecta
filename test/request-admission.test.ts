import { describe, expect, it, vi } from "vitest";
import type { Executor, InboundAuth } from "../src/types.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";

function blockingAuth() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const auth: InboundAuth = {
    kind: "test",
    async authorize() {
      calls++;
      await blocked;
      return { ok: true };
    },
  };
  return { auth, release, calls: () => calls };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}

describe("request admission", () => {
  it("bounds /mcp before auth and leaves health/operator routes responsive", async () => {
    const gate = blockingAuth();
    const logger = {
      ...silentLogger,
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const connecta = createTestConnecta({
      connectors: [calcConnector],
      auth: gate.auth,
      logger,
      admission: {
        requests: {
          concurrency: 1,
          maxQueueSize: 1,
          queueTimeoutMs: 1_000,
          retryAfterMs: 250,
        },
      },
    });

    const first = connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    await waitFor(() => gate.calls() === 1);
    const second = connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    await waitFor(async () => {
      const health = await connecta.fetch(new Request(`${BASE}/health`));
      const body = (await health.json()) as any;
      return body.admission.requests.queued === 1;
    });

    const overloaded = await connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get("Retry-After")).toBe("1");
    expect(overloaded.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await overloaded.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "Server capacity is exhausted. Retry later.",
        data: {
          code: "server_overloaded",
          retryable: true,
          retryAfterMs: 250,
        },
      },
    });

    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      admission: {
        policy: "global-fifo",
        requests: {
          concurrency: 1,
          active: 1,
          queued: 1,
          totals: { admitted: 1, queued: 1, rejected: 1 },
        },
      },
    });
    const operator = await connecta.fetch(new Request(`${BASE}/`));
    expect(operator.status).toBe(200);
    await operator.body?.cancel();
    expect(logger.warn).toHaveBeenCalledWith(
      "[connecta] MCP request admission rejected",
      expect.objectContaining({ active: 1, queued: 1 }),
    );

    gate.release();
    const firstResponse = await first;
    await firstResponse.text();
    const secondResponse = await second;
    await secondResponse.text();

    const drained = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await drained.json()).toMatchObject({
      admission: {
        requests: {
          active: 0,
          queued: 0,
          totals: { admitted: 2, queued: 1, rejected: 1 },
          queueWaitMs: { count: 1 },
        },
      },
    });
  });

  it("removes a cancelled queued request without consuming a permit", async () => {
    const gate = blockingAuth();
    const connecta = createTestConnecta({
      connectors: [],
      auth: gate.auth,
      logger: silentLogger,
      admission: {
        requests: {
          concurrency: 1,
          maxQueueSize: 2,
          queueTimeoutMs: 1_000,
        },
      },
    });
    const first = connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    await waitFor(() => gate.calls() === 1);
    const controller = new AbortController();
    const cancelled = connecta.fetch(mcpRpc("tools/list", {}, { id: 1, signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("caller left"));
    await expect(cancelled).rejects.toThrow("caller left");

    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await health.json()).toMatchObject({
      admission: {
        requests: {
          active: 1,
          queued: 0,
          totals: { cancelled: 1 },
        },
      },
    });
    gate.release();
    await (await first).text();
  });

  it("absorbs a rejecting response-stream cancellation and releases once", async () => {
    let cancellations = 0;
    const auth: InboundAuth = {
      kind: "rejecting-stream",
      authorize() {
        return {
          ok: false,
          response: new Response(
            new ReadableStream({
              cancel() {
                cancellations++;
                return Promise.reject(new Error("cancel failed"));
              },
            }),
            { status: 401 },
          ),
        };
      },
    };
    const connecta = createTestConnecta({
      connectors: [],
      auth,
      logger: silentLogger,
      admission: {
        requests: {
          concurrency: 1,
          maxQueueSize: 0,
          queueTimeoutMs: 1_000,
        },
      },
    });
    const controller = new AbortController();
    await connecta.fetch(mcpRpc("tools/list", {}, { id: 1, signal: controller.signal }));
    controller.abort(new Error("caller left"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await health.json()).toMatchObject({
      admission: {
        requests: {
          active: 0,
          queued: 0,
          totals: { admitted: 1 },
        },
      },
    });
    expect(cancellations).toBe(1);
  });

  it("close rejects queued and future MCP work while active work drains", async () => {
    const gate = blockingAuth();
    const connecta = createTestConnecta({
      connectors: [],
      auth: gate.auth,
      logger: silentLogger,
      admission: {
        requests: {
          concurrency: 1,
          maxQueueSize: 1,
          queueTimeoutMs: 1_000,
        },
      },
    });
    const first = connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    await waitFor(() => gate.calls() === 1);
    const queued = connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await connecta.close();
    const queuedResponse = await queued;
    const futureResponse = await connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    for (const response of [queuedResponse, futureResponse]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          code: -32002,
          data: { code: "server_shutting_down", retryable: false },
        },
      });
    }
    gate.release();
    await (await first).text();
  });

  it("gives a one-method executor its own smaller bounded pool", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const executor: Executor = {
      async execute() {
        started++;
        await blocked;
        return { result: "ok" };
      },
    };
    const connecta = createTestConnecta({
      connectors: [calcConnector],
      executor,
      logger: silentLogger,
      admission: {
        requests: { concurrency: 8, maxQueueSize: 8, queueTimeoutMs: 1_000 },
        code: {
          concurrency: 1,
          maxQueueSize: 1,
          queueTimeoutMs: 1_000,
          retryAfterMs: 400,
        },
      },
    });

    const first = connecta.fetch(
      mcpRpc("tools/call", {
        name: "execute_code",
        arguments: { code: "() => 1" },
      }, { id: 1 }),
    );
    await waitFor(() => started === 1);
    const second = connecta.fetch(
      mcpRpc("tools/call", {
        name: "execute_code",
        arguments: { code: "() => 2" },
      }, { id: 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await connecta.fetch(
      mcpRpc("tools/call", {
        name: "execute_code",
        arguments: { code: "() => 3" },
      }, { id: 1 }),
    );
    const thirdBody = (await third.json()) as any;
    const error = JSON.parse(thirdBody.result.content[0].text);
    expect(error).toEqual({
      error: {
        code: "executor_overloaded",
        message: "Executor queue is full.",
        retryable: true,
        retryAfterMs: 400,
      },
    });
    expect(thirdBody.result.isError).toBe(true);

    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await health.json()).toMatchObject({
      admission: {
        requests: { concurrency: 8 },
        code: {
          concurrency: 1,
          active: 1,
          queued: 1,
          totals: { rejected: 1 },
        },
      },
    });

    release();
    await (await first).text();
    await (await second).text();
    expect(started).toBe(2);
  });
});
