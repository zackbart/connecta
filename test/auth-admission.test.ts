import { describe, expect, it, vi } from "vitest";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { authenticate, authenticationSnapshot } from "../src/auth-admission.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { AuthResult, InboundAuth } from "../src/types.js";
import { mcpRpc } from "./fixtures/http.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";

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

async function drain(gate: ReturnType<typeof blocking>, pending: Promise<unknown>[]) {
  let settled = false;
  const all = Promise.all(pending).then(() => {
    settled = true;
  });
  while (!settled) {
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await all;
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
  it("INV-6 INV-7: queues 16 beyond the active bound and refuses only the excess with a checked payload-free log", async () => {
    const gate = blocking();
    const pending: Promise<unknown>[] = Array.from({ length: 32 }, () => gate.start());
    const warn = vi.fn();
    const outsider = { kind: "other", authorize: vi.fn(refused) };
    try {
      expect(gate.finish).toHaveLength(16);
      expect(authenticationSnapshot()).toMatchObject({ active: 16, limit: 16, queued: 16, queueLimit: 16 });
      const busy = await authenticate(outsider, request(), BASE, undefined, { ...silentLogger, warn });
      expect(busy.admitted).toBe(false);
      if (!busy.admitted) await expectBusy(busy.response);
      expect(outsider.authorize).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        ["[connecta] Authentication admission refused", { reason: "authentication_busy" }],
      ]);
      gate.release();
      await vi.waitFor(() => expect(gate.finish).toHaveLength(16));
      expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 0 });
      expect(vi.mocked(gate.provider.authorize)).toHaveBeenCalledTimes(32);
    } finally {
      await drain(gate, pending);
    }
    for (const result of (await Promise.all(pending)) as Array<{ admitted: boolean }>)
      expect(result.admitted).toBe(true);
    expect(authenticationSnapshot()).toMatchObject({ active: 0, queued: 0 });
    expect((await authenticate(outsider, request(), BASE, undefined, silentLogger)).admitted).toBe(true);
  });

  it("INV-7: admits a burst of 24 concurrent authorizations against slow adapters", async () => {
    const finish: Array<() => void> = [];
    const slow: InboundAuth = {
      kind: "test",
      authorize: vi.fn(
        () => new Promise<AuthResult>((resolve) => finish.push(() => resolve({ ok: true, userId: "alice" }))),
      ),
    };
    const burst = Array.from({ length: 24 }, () => authenticate(slow, request(), BASE, undefined, silentLogger));
    expect(finish).toHaveLength(16);
    expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 8 });
    finish.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(finish).toHaveLength(8));
    expect(authenticationSnapshot()).toMatchObject({ active: 8, queued: 0 });
    finish.splice(0).forEach((resolve) => resolve());
    const results = await Promise.all(burst);
    expect(results.every((result) => result.admitted && result.result.ok)).toBe(true);
    expect(slow.authorize).toHaveBeenCalledTimes(24);
    expect(authenticationSnapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("INV-7: a queued caller waits two seconds at most, and leaving frees its place without I/O", async () => {
    vi.useFakeTimers();
    const gate = blocking();
    const pending: Promise<unknown>[] = Array.from({ length: 16 }, () => gate.start());
    try {
      const callers = Array.from({ length: 16 }, () => new AbortController());
      const waiting = callers.map((caller) => gate.start(caller.signal));
      expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 16 });
      callers[3]!.abort();
      await expect(waiting[3]).rejects.toBe(callers[3]!.signal.reason);
      expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 15 });
      const late = gate.start();
      expect(authenticationSnapshot()).toMatchObject({ queued: 16 });
      expect(gate.provider.authorize).toHaveBeenCalledTimes(16);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(authenticationSnapshot()).toMatchObject({ queued: 16 });
      await vi.advanceTimersByTimeAsync(1);
      for (const result of await Promise.all([...waiting.filter((_, i) => i !== 3), late])) {
        expect(result.admitted).toBe(false);
        if (!result.admitted) await expectBusy(result.response);
      }
      expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 0 });
      expect(gate.provider.authorize).toHaveBeenCalledTimes(16);
    } finally {
      gate.release();
      await Promise.all(pending);
      vi.useRealTimers();
    }
  });

  it("INV-7: abort retains capacity until the adapter settles, and pre-abort invokes nothing", async () => {
    const gate = blocking();
    const caller = new AbortController();
    const old = gate.start(caller.signal);
    const finishOld = gate.finish.shift()!;
    caller.abort();
    const pending: Promise<unknown>[] = Array.from({ length: 15 }, () => gate.start());
    try {
      expect(gate.finish).toHaveLength(15);
      const queuedWhileSettling = gate.start();
      pending.push(queuedWhileSettling);
      expect(gate.finish).toHaveLength(15);
      expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 1 });
      finishOld(refused());
      await old;
      await vi.waitFor(() => expect(gate.finish).toHaveLength(16));
      expect(authenticationSnapshot()).toMatchObject({ active: 16, queued: 0 });
      pending.push(...Array.from({ length: 16 }, () => gate.start()));
      const busy = await gate.start();
      expect(busy.admitted).toBe(false);
      if (!busy.admitted) await expectBusy(busy.response);
      const before = vi.mocked(gate.provider.authorize).mock.calls.length;
      await expect(gate.start(caller.signal)).rejects.toBe(caller.signal.reason);
      expect(gate.provider.authorize).toHaveBeenCalledTimes(before);
    } finally {
      finishOld(refused());
      await old;
      await drain(gate, pending);
    }
  });

  it("INV-7: MCP, pools, operator APIs, and agent storage share the bound across deployments", async () => {
    const gate = blocking();
    const pending = Array.from({ length: 32 }, () => gate.start());
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
      await drain(gate, pending);
      await app.close();
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
        queued: 0,
        queueLimit: 16,
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
      const queued = start();
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await queued).admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
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
