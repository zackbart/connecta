import { describe, expect, it, vi } from "vitest";
import { authenticate, authenticationSnapshot } from "../src/auth-admission.js";
import { authorize, authorizeAgent } from "../src/routes/shared.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { AuthResult, InboundAuth } from "../src/types.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const refused = (): AuthResult => ({ ok: false, response: new Response(null, { status: 401 }) });
const request = (signal?: AbortSignal) => new Request(`${BASE}/mcp`, signal ? { signal } : {});

function blocking() {
  const finish: Array<(value: AuthResult) => void> = [];
  const provider: InboundAuth = {
    kind: "test",
    interactiveOperator: true,
    authorize: vi.fn(() => new Promise<AuthResult>((resolve) => finish.push(resolve))),
  };
  return {
    provider,
    finish,
    start: (signal?: AbortSignal) => authenticate(provider, request(signal), BASE, undefined, silentLogger),
    release: () => finish.splice(0).forEach((resolve) => resolve(refused())),
  };
}

async function expectBusy(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: { code: "authentication_busy", message: "Authentication capacity reached.", retryable: true },
  });
}

describe("inbound authentication admission", () => {
  it("INV-7: synchronous local verdicts finish before another authentication starts", async () => {
    const provider = { kind: "local", authorize: refused };
    const results = await Promise.all(
      Array.from({ length: 64 }, () => authenticate(provider, request(), BASE, undefined, silentLogger)),
    );
    expect(results.every((result) => result.admitted)).toBe(true);
  });
  it("INV-6 INV-7: fast-refuses beyond 16 across providers with only a checked payload-free log", async () => {
    const gate = blocking();
    const pending = Array.from({ length: 16 }, () => gate.start());
    const warn = vi.fn();
    const outsider = { kind: "other", authorize: vi.fn(refused) };
    try {
      const busy = await authenticate(outsider, request(), BASE, undefined, { ...silentLogger, warn });
      expect(busy.admitted).toBe(false);
      if (!busy.admitted) await expectBusy(busy.response);
      expect(outsider.authorize).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        ["[connecta] Authentication admission refused", { reason: "authentication_busy" }],
      ]);
    } finally {
      gate.release();
      await Promise.all(pending);
    }
    expect((await authenticate(outsider, request(), BASE, undefined, silentLogger)).admitted).toBe(true);
  });

  it.each(["success", "refusal", "throw", "reject"])("INV-7: releases all slots on %s", async (outcome) => {
    const provider: InboundAuth = {
      kind: "test",
      authorize() {
        if (outcome === "throw") throw new Error("private");
        if (outcome === "reject") return Promise.reject(new Error("private"));
        return outcome === "success" ? { ok: true, userId: "alice" } : refused();
      },
    };
    for (let i = 0; i < 32; i++) {
      const result = authenticate(provider, request(), BASE, undefined, silentLogger);
      if (outcome === "throw" || outcome === "reject") await expect(result).rejects.toThrow("private");
      else expect((await result).admitted).toBe(true);
    }
  });

  it("INV-7: abort retains capacity until the adapter settles, and pre-abort invokes nothing", async () => {
    const gate = blocking();
    const caller = new AbortController();
    const old = gate.start(caller.signal);
    const finishOld = gate.finish.shift()!;
    caller.abort();
    const pending = Array.from({ length: 15 }, () => gate.start());
    try {
      expect(gate.finish).toHaveLength(15);
      const refusedWhileSettling = gate.start();
      expect(gate.finish).toHaveLength(15);
      expect((await refusedWhileSettling).admitted).toBe(false);
      finishOld(refused());
      await old;
      pending.push(gate.start());
      const busy = await gate.start();
      expect(busy.admitted).toBe(false);
      if (!busy.admitted) await expectBusy(busy.response);
      const before = vi.mocked(gate.provider.authorize).mock.calls.length;
      await expect(gate.start(caller.signal)).rejects.toBe(caller.signal.reason);
      expect(gate.provider.authorize).toHaveBeenCalledTimes(before);
    } finally {
      finishOld(refused());
      gate.release();
      await old;
      await Promise.all(pending);
    }
  });

  it.each([false, true])(
    "INV-7: bounds 64 full-server authorizations (listen header: %s) before reading bodies",
    async (listen) => {
      const gate = blocking();
      const app = createTestConnecta({
        connectors: [],
        auth: gate.provider,
        logger: silentLogger,
        maintainers: [{ namespace: "test", id: "alice" }],
        admission: { requests: { concurrency: 64, maxQueueSize: 0, maxDurationMs: 30_000 } },
      });
      let settled = 0;
      let reads = 0;
      const pending = Array.from({ length: 64 }, () => {
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array(1));
            },
          },
          { highWaterMark: 0 },
        );
        const req = new Request(`${BASE}/mcp`, {
          method: "POST",
          body,
          duplex: "half",
          headers: { "Content-Type": "application/json", ...(listen ? { "Mcp-Method": "subscriptions/listen" } : {}) },
        } as RequestInit);
        return app.fetch(req).then(async (res) => {
          settled++;
          if (res.status === 503) await expectBusy(res);
          return res;
        });
      });
      try {
        await vi.waitFor(() => expect(settled).toBe(48));
        expect(gate.provider.authorize).toHaveBeenCalledTimes(16);
        // Node's Request transfer may prefetch one chunk per body; no route
        // consumes beyond that before the adapter returns (as in body-bounds).
        expect(reads).toBeLessThanOrEqual(64);
      } finally {
        gate.release();
        await Promise.all(pending);
        await app.close();
      }
    },
  );

  it("INV-7: MCP, pools, operator APIs, and agent storage share the bound across deployments", async () => {
    const gate = blocking();
    const pending = Array.from({ length: 16 }, () => gate.start());
    const storage = memoryStorage();
    const get = vi.spyOn(storage, "get");
    const human = { kind: "test", interactiveOperator: true as const, authorize: vi.fn(refused) };
    const app = createTestConnecta({
      connectors: [calcConnector],
      auth: human,
      logger: silentLogger,
      maintainers: [{ namespace: "test", id: "alice" }],
      accessTokens: accessTokens(storage),
      agents: ["assistant"],
      activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
      pools: { team: { tools: ["calc"], members: ["agent:assistant"] } },
    });
    try {
      for (const path of ["/mcp", "/mcp/team", "/ui/api/config", "/ui/data", "/ui/api/activity", "/ui/access-tokens"]) {
        await expectBusy(await app.fetch(new Request(`${BASE}${path}`)));
      }
      const agent = mcpRpc("tools/list", {}, { agentPool: "team", token: `cta_${"a".repeat(43)}` });
      await expectBusy(await app.fetch(agent));
      expect(get).not.toHaveBeenCalled();
      expect(human.authorize).not.toHaveBeenCalled();
      for (const path of ["/health", "/", "/unknown", "/agent", "/.well-known/unknown"]) {
        const res = await app.fetch(new Request(`${BASE}${path}`));
        expect(res.status).not.toBe(503);
        await res.text();
      }
      expect((await app.fetch(new Request(`${BASE}/mcp`, { method: "OPTIONS" }))).status).toBe(204);
    } finally {
      gate.release();
      await Promise.all(pending);
      await app.close();
    }
  });

  it("INV-4 INV-7: cheap invalid human and agent credentials refuse without invoking an adapter under load", async () => {
    const gate = blocking();
    const pending = Array.from({ length: 16 }, () => gate.start());
    try {
      const invalid = new Request(`${BASE}/mcp`, { headers: { Authorization: "Basic private" } });
      const human = await authorize(invalid, BASE, [gate.provider]);
      const agent = await authorizeAgent(request(), BASE, [gate.provider]);
      expect(!human.ok && human.response.status).toBe(401);
      expect(!agent.ok && agent.response.status).toBe(401);
      expect(gate.provider.authorize).toHaveBeenCalledTimes(16);
    } finally {
      gate.release();
      await Promise.all(pending);
    }
  });
});

// These promises model a native binding/storage operation that has no cancel
// argument. The adapter must return promptly without releasing the real work.
it.each(["access", "agent"] as const)(
  "INV-6 INV-7: %s hard deadlines recover partial stalls and bound permanent abandonment",
  async (kind) => {
    vi.useFakeTimers();
    const finishes: Array<() => void> = [];
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage, { agents: ["assistant"] });
    const { token } = await manager.rotate("assistant");
    const get = vi
      .spyOn(storage, "get")
      .mockImplementation(() => new Promise((resolve) => finishes.push(() => resolve(null))));
    const provider = kind === "access" ? cloudflareAccessAuth() : manager.auth;
    const warn = vi.fn();
    const context =
      kind === "access"
        ? {
            access: {
              aud: "app",
              getIdentity: () =>
                new Promise<Record<string, unknown>>((resolve) => finishes.push(() => resolve({ user_uuid: "late" }))),
            },
          }
        : undefined;
    const callers: AbortController[] = [];
    const waits: Promise<unknown>[] = [];
    const pending: Promise<unknown>[] = [];
    const start = () => {
      const caller = new AbortController();
      callers.push(caller);
      const req = new Request(`${BASE}/mcp`, {
        signal: caller.signal,
        ...(kind === "agent" ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      const result = authenticate(provider, req, BASE, context, { ...silentLogger, warn }, (work) => waits.push(work));
      pending.push(result);
      return result;
    };
    const snapshot = (active: number, abandoned: number) =>
      expect(authenticationSnapshot()).toEqual({
        active,
        abandoned,
        limit: 16,
        abandonedLimit: 16,
        abandonedSaturated: abandoned === 16,
        unreachableRelease: typeof FinalizationRegistry === "function",
      });
    try {
      const first = start();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(finishes).toHaveLength(1));
      callers[0]!.abort();
      expect((await first).admitted).toBe(true);
      snapshot(1, 0);
      await vi.advanceTimersByTimeAsync(6_000);
      snapshot(0, 1);
      // One stuck operation no longer prevents the normal pool accepting 16.
      const wave = Array.from({ length: 16 }, start);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(finishes).toHaveLength(17));
      snapshot(16, 1);
      expect((await start()).admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      for (const result of await Promise.all(wave)) {
        expect(result.admitted).toBe(true);
        if (result.admitted) expect(result.result.ok).toBe(false);
      }
      snapshot(16, 1); // caller deadline did not release any native work
      await vi.advanceTimersByTimeAsync(1_000);
      snapshot(1, 16); // the extra overdue charge cannot overflow the allowance
      // Callers keep one retryable contract; only the log names saturation.
      const saturated = await start();
      expect(saturated.admitted).toBe(false);
      if (!saturated.admitted) await expectBusy(saturated.response);
      expect(warn.mock.calls.at(-1)).toEqual([
        "[connecta] Authentication admission refused",
        { reason: "authentication_abandoned_saturated" },
      ]);
      expect(finishes).toHaveLength(17);
      finishes.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      snapshot(0, 16); // real settlement promotes the waiting overdue charge
      finishes.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      snapshot(0, 15);
      const recovered = start();
      await vi.waitFor(() => expect(finishes).toHaveLength(16));
      snapshot(1, 15);
      finishes.splice(0).forEach((finish) => finish());
      await recovered;
      await Promise.all(waits);
      snapshot(0, 0);
      // No double release after abort, timeout, promotion, and late settlement.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      callers.forEach((caller) => caller.abort());
      finishes.splice(0).forEach((finish) => finish());
      await Promise.all(pending);
      await Promise.all(waits);
      get.mockRestore();
      vi.useRealTimers();
    }
  },
);

it("INV-7: a custom adapter ignoring cancellation moves to the allowance at ten seconds plus grace", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const provider: InboundAuth = {
    kind: "custom",
    authorize: () =>
      new Promise<AuthResult>((_resolve, fail) => {
        reject = fail;
      }),
  };
  const caller = new AbortController();
  const waits: Promise<unknown>[] = [];
  const pending = authenticate(provider, request(caller.signal), BASE, undefined, silentLogger, (work) =>
    waits.push(work),
  );
  try {
    caller.abort();
    await vi.advanceTimersByTimeAsync(10_999);
    expect(authenticationSnapshot()).toMatchObject({ active: 1, abandoned: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 1 });
    const app = createTestConnecta({ connectors: [calcConnector], logger: silentLogger });
    try {
      const health = (await (await app.fetch(new Request(`${BASE}/health`))).json()) as {
        admission: { authentication: unknown };
      };
      expect(health.admission.authentication).toEqual({
        active: 0,
        limit: 16,
        abandoned: 1,
        abandonedLimit: 16,
        abandonedSaturated: false,
        // workerd hides FinalizationRegistry without enable_weak_ref.
        unreachableRelease: typeof FinalizationRegistry === "function",
      });
    } finally {
      await app.close();
    }
    reject(new Error("late"));
    await expect(pending).rejects.toThrow("late");
    await Promise.all(waits);
    // A late rejection decrements the abandoned charge exactly once.
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    reject(new Error("late"));
    await pending.catch(() => {});
    vi.useRealTimers();
  }
});
