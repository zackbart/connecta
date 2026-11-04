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
import { CONFIG_DEFAULTS } from "../src/config-defaults.js";
import { customExecutor } from "../src/executor-contract.js";

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

  it("INV-7/INV-9: the request deadline stops a held final program-return stash", WORKERS, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const backing = memoryStorage();
    const storage = {
      ...backing,
      get: vi.fn(async (key: string) => {
        if (key === stashLedgerKeys.ledger) {
          entered.resolve();
          await release.promise;
        }
        return backing.get(key);
      }),
      set: vi.fn(backing.set),
      delete: vi.fn(backing.delete),
      list: vi.fn(backing.list),
      compareAndSet: vi.fn(backing.compareAndSet),
    };
    let writes = 0;
    const deployment = createTestConnecta({
      connectors: [
        connectorWith({
          id: "notes",
          kind: "api",
          tools: [{ name: "save", annotations: { readOnlyHint: false } }],
          call: async () => {
            writes++;
            return { saved: true };
          },
        }),
      ],
      storage,
      logger: silentLogger,
      executor: scriptedExecutor(async (fns) => {
        await fns.call!("notes.save", {});
        return "x".repeat(300_000);
      }),
      admission: {
        requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: 100 },
        code: { concurrency: 1, maxQueueSize: 0 },
      },
    });
    let ended = false;
    const pending = deployment
      .fetch(
        mcpRpc("tools/call", {
          name: "execute_code",
          arguments: { code: "async () => { await connecta.call('notes.save', {}); return 'x'.repeat(300000); }" },
        }),
      )
      .then((response) => {
        ended = true;
        return response;
      });
    try {
      await entered.promise;
      expect(writes).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(ended).toBe(true);
      const health = await deployment.fetch(new Request(`${BASE}/health`));
      expect(await health.json()).toMatchObject({ admission: { requests: { active: 0 }, code: { active: 0 } } });
      const callsAtEnd = [storage.get, storage.set, storage.delete, storage.list, storage.compareAndSet].map(
        (operation) => operation.mock.calls.length,
      );
      release.resolve();
      await settle();
      expect(
        [storage.get, storage.set, storage.delete, storage.list, storage.compareAndSet].map(
          (operation) => operation.mock.calls.length,
        ),
      ).toEqual(callsAtEnd);
      expect(writes).toBe(1);
    } finally {
      release.resolve();
      await settle();
      await pending;
    }
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
            // Storage already stalled this run: the response does not wait on it twice.
            expect(response.rpc.result.structuredContent.error.completed).toMatchObject({
              calls: [{ address: "notes.save", write: true, dropped: true }],
            });
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

  describe("a 65-second downstream behind a 60-second client", () => {
    const CLIENT_LIMIT_MS = 60_000;
    const DOWNSTREAM_MS = 65_000;
    /** What the client's own timer produces: the agent sees this, and nothing the run knew. */
    const TRANSPORT_TIMEOUT = "The operation timed out.";
    const PROGRAM = { code: "async () => null" };
    type Fns = Parameters<Parameters<typeof scriptedExecutor>[0]>[0];

    /**
     * A deployment on the shipped ceiling whose executor publishes the Dynamic
     * Worker's default deadline. Its timer may be wedged, so nothing here honors it.
     */
    function world(
      program: (fns: Fns) => Promise<unknown> = async () => null,
      config: { watchdogMs?: number; deadlineMs?: number } = {},
    ) {
      const calls = { read: 0, write: 0 };
      const connector = connectorWith({
        id: "slow",
        kind: "api",
        tools: [
          { name: "read", annotations: { readOnlyHint: true } },
          { name: "write", annotations: { readOnlyHint: false } },
        ],
        call: async (name) => {
          calls[name as "read" | "write"]++;
          await new Promise((resolve) => setTimeout(resolve, DOWNSTREAM_MS));
          return { answered: true };
        },
      });
      const deployment = createTestConnecta({
        connectors: [connector],
        logger: silentLogger,
        ...(config.watchdogMs !== undefined ? { execute: { watchdogMs: config.watchdogMs } } : {}),
        executor: Object.assign(scriptedExecutor(program), { deadlineMs: config.deadlineMs ?? 50_000 }),
      });
      return { calls, deployment };
    }

    /** One request under the client's limit: its JSON-RPC body, or the client's timeout. */
    async function underClientLimit(
      deployment: ReturnType<typeof createTestConnecta>,
      name: string,
      args: Record<string, unknown>,
    ) {
      const clientLimit = new Promise<typeof TRANSPORT_TIMEOUT>((resolve) => {
        setTimeout(() => resolve(TRANSPORT_TIMEOUT), CLIENT_LIMIT_MS);
      });
      const answered = deployment.fetch(mcpRpc("tools/call", { name, arguments: args })).then(readJsonRpc);
      const outcome = Promise.race([answered, clientLimit]);
      await vi.advanceTimersByTimeAsync(DOWNSTREAM_MS + 1_000);
      return await outcome;
    }

    function typed(outcome: Awaited<ReturnType<typeof underClientLimit>>) {
      if (outcome === TRANSPORT_TIMEOUT) throw new Error("The client's limit won the race.");
      expect(outcome.result.isError).toBe(true);
      return outcome.result.structuredContent;
    }

    it("a program's read ends as a typed timeout with its host-call counts", NODE, async () => {
      const { calls, deployment } = world((fns) => fns.call!("slow.read", {}, { timeoutMs: 600_000 }));
      const content = typed(await underClientLimit(deployment, "execute_code", PROGRAM));
      expect(content.error).toMatchObject({ code: "timeout", retryable: true, details: { operation: "slow.read" } });
      expect(content.error.details.elapsedMs).toBeLessThan(CLIENT_LIMIT_MS);
      expect(content.hostCalls).toMatchObject({ attempted: 1, failed: 1 });
      expect(calls.read).toBe(1);
    });

    it("a program's write resolves as unknown before the client gives up, and is not replayed", NODE, async () => {
      const { calls, deployment } = world((fns) => fns.call!("slow.write", {}, { timeoutMs: 600_000 }));
      const content = typed(await underClientLimit(deployment, "execute_code", PROGRAM));
      expect(content.error).toMatchObject({
        code: "write_outcome_unknown",
        retryable: false,
        writes: { succeeded: 0, failed: 0, unknown: 1 },
      });
      expect(content.error.details.elapsedMs).toBeLessThan(CLIENT_LIMIT_MS);
      expect(calls.write).toBe(1);
    });

    it.each([
      { name: "call_tool", address: "slow.read", code: "timeout", tool: "read" as const },
      { name: "call_destructive_tool", address: "slow.write", code: "write_outcome_unknown", tool: "write" as const },
    ])("$name cuts an explicit deadline past the ceiling", NODE, async ({ name, address, code, tool }) => {
      const { calls, deployment } = world();
      const args = { address, args: {}, timeoutMs: 600_000 };
      const content = typed(await underClientLimit(deployment, name, args));
      expect(content.error).toMatchObject({ code, details: { deadlineMs: 55_000 } });
      expect(calls[tool]).toBe(1);
    });

    it("a queue configured to outwait the client still refuses in time", NODE, async () => {
      // A pool that never grants a slot, as one with a long queue deadline might not.
      let waiter: AbortSignal | undefined;
      const deployment = createTestConnecta({
        connectors: [calcConnector],
        logger: silentLogger,
        executor: customExecutor(
          {
            execute: async () => ({ result: null }),
            acquire: async ({ signal }: { signal?: AbortSignal } = {}) => {
              waiter = signal;
              return await new Promise<never>(() => {});
            },
          } as unknown as Executor,
          { lifecycle: "self-managed" },
        ),
      });
      const content = typed(await underClientLimit(deployment, "execute_code", PROGRAM));
      expect(content.error).toMatchObject({ code: "executor_overloaded", retryable: true });
      expect(content.error.message).toContain("Executor admission timed out");
      // INV-7: the queue's wait ends with the request.
      expect(waiter?.aborted).toBe(true);
    });

    it.each([{ deadlineMs: 50_000 }, { deadlineMs: undefined }])(
      "time spent queued counts: a late run ends at the ceiling, retryable ($deadlineMs)",
      NODE,
      async ({ deadlineMs }) => {
        let runs = 0;
        const deployment = createTestConnecta({
          connectors: [calcConnector],
          logger: silentLogger,
          admission: { code: { concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 600_000 } },
          executor: Object.assign(
            scriptedExecutor(async () => {
              if (++runs === 1) return await new Promise((resolve) => setTimeout(resolve, 10_000));
              return await new Promise<never>(() => {});
            }),
            deadlineMs === undefined ? {} : { deadlineMs },
          ),
        });
        const first = deployment.fetch(mcpRpc("tools/call", { name: "execute_code", arguments: PROGRAM }));
        await settle();
        const content = typed(await underClientLimit(deployment, "execute_code", PROGRAM));
        expect(content.error).toMatchObject({
          code: "timeout",
          retryable: true,
          details: { stage: "response ceiling", deadlineMs: 55_000 },
        });
        expect(content.error.details.elapsedMs).toBeLessThan(CLIENT_LIMIT_MS);
        await first;
      },
    );

    // The control: under the old defaults this harness reports the agents' symptom.
    it.each([
      {
        route: "execute_code",
        program: (fns: Fns) => fns.call!("slow.write", {}, { timeoutMs: 600_000 }),
        args: PROGRAM,
      },
      {
        route: "call_tool",
        program: undefined,
        args: { address: "slow.read", args: {}, timeoutMs: 600_000 },
      },
      {
        route: "call_destructive_tool",
        program: undefined,
        args: { address: "slow.write", args: {}, timeoutMs: 600_000 },
      },
    ])("$route loses to the client under the old 120-second ceiling", NODE, async ({ route, program, args }) => {
      const { deployment } = world(program, { watchdogMs: 120_000, deadlineMs: 60_000 });
      expect(await underClientLimit(deployment, route, args)).toBe(TRANSPORT_TIMEOUT);
      await vi.advanceTimersByTimeAsync(120_000);
    });

    it("the shipped ceiling leaves time to send a result", NODE, () => {
      expect(CONFIG_DEFAULTS.execute.watchdogMs).toBeLessThanOrEqual(CLIENT_LIMIT_MS - 5_000);
    });
  });

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

  it("withdraws a timed-out listen candidate's fallback waiter before a slot is released", WORKERS, async () => {
    let releaseCandidate!: () => void;
    const candidateAuth = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    let authCalls = 0;
    const connecta = createTestConnecta({
      connectors: [],
      auth: registerTestMaintainer(
        {
          kind: "listen-candidate",
          async authorize() {
            if (++authCalls === 1) {
              await candidateAuth;
              return { ok: true, principal: PRINCIPAL };
            }
            return { ok: false, response: new Response(new ReadableStream(), { status: 401 }) };
          },
        },
        PRINCIPAL,
      ),
      logger: silentLogger,
      admission: {
        requests: { concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 500, maxDurationMs: 100 },
      },
    });
    const request = mcpRpc("tools/list", {}, { id: 1 });
    request.headers.set("Mcp-Method", "subscriptions/listen");
    const candidate = connecta.fetch(request);
    let held: Response | undefined;
    const snapshot = async () => {
      const health = await connecta.fetch(new Request(`${BASE}/health`));
      return health.json();
    };
    try {
      await waitFor(() => authCalls === 1);
      // Give the held slot a later deadline than the listen candidate, so its
      // release can expose an abandoned fallback waiter after the 504.
      await vi.advanceTimersByTimeAsync(50);
      held = await connecta.fetch(mcpRpc("tools/list", {}, { id: 2 }));
      expect(held.status).toBe(401);
      releaseCandidate();
      await waitFor(async () => {
        const health = (await snapshot()) as any;
        return health.admission.requests.queued === 1;
      });
      expect(await snapshot()).toMatchObject({
        admission: { requests: { active: 1, queued: 1, totals: { admitted: 1, cancelled: 0 } } },
      });

      await vi.advanceTimersByTimeAsync(50);
      const response = await candidate;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -33003 } });
      expect(await snapshot()).toMatchObject({
        admission: { requests: { active: 1, queued: 0, totals: { admitted: 1, cancelled: 1 } } },
      });

      await held.body?.cancel();
      await settle();
      expect(await snapshot()).toMatchObject({
        admission: { requests: { active: 0, queued: 0, totals: { admitted: 1, cancelled: 1 } } },
      });
      expect(authCalls).toBe(2);
    } finally {
      releaseCandidate();
      await held?.body?.cancel();
      await connecta.close();
      await candidate.catch(() => undefined);
    }
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
