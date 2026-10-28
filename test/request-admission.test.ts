import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, Executor, InboundAuth } from "../src/types.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { connectorWith } from "./fixtures/connectors.js";
import { deferred, scriptedExecutor } from "./fixtures/misc.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes, stashLedgerKeys } from "../src/storage/keys.js";
import { registerTestMaintainer } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";
/** The maintainer every auth fixture here admits, so plain /mcp serves it (#837). */
const PRINCIPAL = { namespace: "connecta:test", id: "operator" };

function blockingAuth() {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const auth: InboundAuth = registerTestMaintainer(
    {
      kind: "test",
      async authorize() {
        calls++;
        await blocked;
        return { ok: true, principal: PRINCIPAL };
      },
    },
    PRINCIPAL,
  );
  return { auth, release, calls: () => calls };
}

/**
 * Run whatever is due now, without moving the fake clock. Every test here runs
 * on a fake clock, so a deadline or queue timeout fires only when a test
 * advances time on purpose — never because a loaded host was slow to reach
 * the connector before a real 100ms timer ran out.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await settle();
  }
  throw new Error("Condition was not reached.");
}

describe("request admission", () => {
  beforeEach(() => {
    // Only deadlines are faked; native WebCrypto still completes in real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { route: "execute_code", earlyReturn: false },
    { route: "execute_code", earlyReturn: true },
    { route: "call_destructive_tool", earlyReturn: false },
    { route: "call_tool", earlyReturn: false },
  ])(
    "INV-7/INV-9: $route (early return: $earlyReturn) releases admission while result reservation stalls",
    { ...WORKERS, timeout: 30_000 },
    async ({ route, earlyReturn }) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const backing = memoryStorage();
      const get = vi.fn(async (key: string) => {
        if (key === stashLedgerKeys.ledger) {
          entered.resolve();
          await release.promise;
        }
        return backing.get(key);
      });
      let writes = 0;
      const read = route === "call_tool";
      const connector = connectorWith({
        id: "notes",
        kind: "api",
        maxResultBytes: 1_024,
        tools: [{ name: "save", annotations: { readOnlyHint: read } }],
        call: async () => {
          if (!read) writes++;
          return { text: "x".repeat(300_000) };
        },
      });
      const deployment = createTestConnecta({
        connectors: [connector],
        storage: { ...backing, get },
        logger: silentLogger,
        executor: scriptedExecutor(async (fns) => {
          const pending = fns.call!("notes.save", {});
          if (!earlyReturn) return await pending;
          void pending.catch(() => {});
          await entered.promise;
          return "returned before result processing";
        }),
        execute: { hostCallTimeoutMs: 20, watchdogMs: 35 },
        admission: {
          requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: 100 },
          code: { concurrency: 1, maxQueueSize: 0 },
        },
      });
      let ended = false;
      const pending = deployment
        .fetch(
          mcpRpc("tools/call", {
            name: route,
            arguments:
              route === "execute_code"
                ? { code: "async () => await connecta.call('notes.save', {})" }
                : { address: "notes.save", args: {}, timeoutMs: 20 },
          }),
        )
        .then(async (response) => {
          const rpc = await readJsonRpc(response);
          ended = true;
          return { status: response.status, rpc };
        });
      try {
        await entered.promise;
        expect(writes).toBe(read ? 0 : 1);
        await vi.advanceTimersByTimeAsync(20);
        expect(ended).toBe(true);
        await vi.advanceTimersByTimeAsync(80);
        expect(ended).toBe(true);
        const health = await deployment.fetch(new Request(`${BASE}/health`));
        expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 }, code: { active: 0 } } });
        const response = await pending;
        expect(response.status).toBe(200);
        if (!earlyReturn) {
          expect(response.rpc.result).toMatchObject({
            isError: true,
            structuredContent: { error: { code: "result_processing_failed", retryable: false } },
          });
          if (route === "execute_code") {
            expect(response.rpc.result.structuredContent.error.writes).toEqual({ succeeded: 1, failed: 0, unknown: 0 });
          }
          expect(response.rpc.result.structuredContent.error.writeOutcome).toBeUndefined();
          expect(response.rpc.result.structuredContent.error.message).toContain("completed");
        }
        const readsAtEnd = get.mock.calls.length;
        release.resolve();
        await settle();
        expect(get).toHaveBeenCalledTimes(readsAtEnd);
        expect(await backing.list(scopes.results)).toEqual([]);
        expect(writes).toBe(read ? 0 : 1);
      } finally {
        release.resolve();
        await settle();
        await pending;
      }
    },
  );

  it("aborts an in-flight connector call at the total request deadline", WORKERS, async () => {
    let started = 0;
    let aborted = 0;
    let markStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const connector: Connector = {
      ...calcConnector,
      async callTool(_name, _args, ctx) {
        started++;
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) {
            aborted++;
            resolve();
          } else {
            ctx.signal?.addEventListener(
              "abort",
              () => {
                aborted++;
                resolve();
              },
              { once: true },
            );
          }
          markStarted();
        });
        return { stopped: true };
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      logger: silentLogger,
      admission: {
        requests: { concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1_000, maxDurationMs: 100 },
      },
    });
    const first = connecta.fetch(
      mcpRpc(
        "tools/call",
        {
          name: "call_tool",
          arguments: { address: "calc.add", args: { a: 1, b: 2 } },
        },
        { id: 1 },
      ),
    );
    // Catalog fingerprinting awaits native WebCrypto. An arbitrary number of
    // fake-clock turns cannot guarantee it finishes before the call begins.
    await callStarted;
    expect(started).toBe(1);
    // Time moves only here: a tick short of the 100ms lifetime the call is
    // still running, and at 100ms it is aborted.
    await vi.advanceTimersByTimeAsync(99);
    expect(aborted).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(1);
    await first.catch(() => undefined);
    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 } } });
  });

  it("ends stalled authorization before a response and returns its permit", WORKERS, async () => {
    const gate = blockingAuth();
    const connecta = createTestConnecta({
      connectors: [],
      auth: gate.auth,
      logger: silentLogger,
      admission: {
        requests: { concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1_000, maxDurationMs: 100 },
      },
    });
    let settled = false;
    const first = connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    void first.finally(() => {
      settled = true;
    });
    await waitFor(() => gate.calls() === 1);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const response = await first;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -33003, message: "MCP request lifetime exceeded." },
    });
    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 } } });
    gate.release();
  });

  it("ends a still-live response at its configured lifetime and frees admission", WORKERS, async () => {
    let cancellations = 0;
    const auth: InboundAuth = {
      kind: "streaming",
      authorize() {
        return {
          ok: false,
          response: new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("open"));
              },
              cancel() {
                cancellations++;
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
      maintainers: [PRINCIPAL],
      logger: silentLogger,
      admission: {
        requests: { concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1_000, maxDurationMs: 100 },
      },
    });

    const first = await connecta.fetch(mcpRpc("tools/list", {}, { id: 1 }));
    expect(first.status).toBe(401);
    const blocked = await connecta.fetch(mcpRpc("tools/list", {}, { id: 2 }));
    expect(blocked.status).toBe(503);
    await blocked.text();
    await vi.advanceTimersByTimeAsync(99);
    expect(cancellations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancellations).toBe(1);

    const next = await connecta.fetch(mcpRpc("tools/list", {}, { id: 3 }));
    expect(next.status).toBe(401);
    await next.body?.cancel();
    const health = await connecta.fetch(new Request(`${BASE}/health`));
    expect(await health.json()).toMatchObject({ admission: { requests: { active: 0, maxDurationMs: 100 } } });
    await first.body?.cancel().catch(() => {});
  });

  it("bounds /mcp before auth and leaves health/operator routes responsive", NODE, async () => {
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
    // An originless request gets no allow-origin header: the reflected origin
    // policy only answers browsers that sent one.
    expect(overloaded.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await overloaded.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -33001,
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

  it("removes a cancelled queued request without consuming a permit", WORKERS, async () => {
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
    await settle();
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

  it("absorbs a rejecting response-stream cancellation and releases once", WORKERS, async () => {
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
      maintainers: [PRINCIPAL],
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
    await settle();

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

  it("gives a one-method executor its own smaller bounded pool", NODE, async () => {
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
      mcpRpc(
        "tools/call",
        {
          name: "execute_code",
          arguments: { code: "() => 1" },
        },
        { id: 1 },
      ),
    );
    await waitFor(() => started === 1);
    const second = connecta.fetch(
      mcpRpc(
        "tools/call",
        {
          name: "execute_code",
          arguments: { code: "() => 2" },
        },
        { id: 1 },
      ),
    );
    await settle();
    const third = await connecta.fetch(
      mcpRpc(
        "tools/call",
        {
          name: "execute_code",
          arguments: { code: "() => 3" },
        },
        { id: 1 },
      ),
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
      hostCalls: { attempted: 0, admitted: 0, succeeded: 0, failed: 0 },
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
