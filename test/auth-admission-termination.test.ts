// Charges stranded by an ended Worker invocation, through the real fetch edge
// on fake timers. Retirement belongs to the Worker's outermost handler only;
// every public entry reached from other code keeps counting until settlement.
import { expect, it, vi } from "vitest";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { accessTokens } from "../src/access-tokens.js";
import type { AuthenticationRetirement } from "../src/auth-admission.js";
import { workerHandler } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import { workerEntry } from "../src/worker-handler.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const workerd = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
// Work may finish on real I/O (digests) or yield through faked immediates
// (Effect's scheduler). Run due timers until it settles; the clock never moves.
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await vi.advanceTimersByTimeAsync(0);
}
async function drain<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  work.then(
    () => (settled = true),
    () => (settled = true),
  );
  await until(() => settled);
  return work;
}
const RETIRED = [
  "[connecta] Authentication retired after its Worker invocation ended",
  { reason: "authentication_invocation_ended" },
];
type Entry = (request: Request, ctx: unknown) => Promise<Response>;

/** A deployment whose Access lookups and agent-token reads never settle until released. */
function stalledDeployment(kind: "access" | "agent") {
  // Native operations with no cancellation API; resolving one late models a
  // settlement that arrives after its charge was retired.
  const finishes: Array<() => void> = [];
  const storage = memoryStorage();
  const get = vi
    .spyOn(storage, "get")
    .mockImplementation(() => new Promise((resolve) => finishes.push(() => resolve(null))));
  const warn = vi.fn();
  const app = createTestConnecta({
    connectors: [calcConnector],
    auth: cloudflareAccessAuth(),
    maintainers: [{ namespace: "cloudflare-access", id: "alice" }],
    logger: { ...silentLogger, warn },
    accessTokens: accessTokens(storage),
    agents: ["assistant"],
    pools: { team: { tools: ["calc"], members: ["agent:assistant"] } },
  });
  const waits: Promise<unknown>[] = [];
  const pending: Promise<Response | undefined>[] = [];
  // A fresh ExecutionContext per invocation, as a Worker fetch event has.
  const send = (entry: Entry) => {
    const response = entry(
      new Request(`${BASE}${kind === "agent" ? "/agent/team" : "/mcp"}`, {
        method: "POST",
        headers: {
          "Mcp-Method": "subscriptions/listen",
          ...(kind === "agent" ? { Authorization: `Bearer cta_${"a".repeat(43)}` } : {}),
        },
      }),
      {
        waitUntil: (work: Promise<unknown>) => void waits.push(work),
        passThroughOnException() {},
        access: {
          aud: "app",
          getIdentity: () =>
            new Promise<Record<string, unknown>>((resolve) => finishes.push(() => resolve({ user_uuid: "late" }))),
        },
      },
    );
    pending.push(response.catch(() => undefined));
    return response;
  };
  const health = async (entry: Entry, active: number, abandoned: number, retirement: AuthenticationRetirement) => {
    const response = await drain(
      entry(new Request(`${BASE}/health`), { waitUntil: () => {}, passThroughOnException() {} }),
    );
    const body = (await drain(response.json())) as { admission: { authentication: unknown } };
    expect(body.admission.authentication).toEqual({
      active,
      limit: 16,
      abandoned,
      abandonedLimit: 16,
      abandonedSaturated: abandoned === 16,
      retirement,
    });
  };
  const cleanup = async () => {
    finishes.splice(0).forEach((finish) => finish());
    await vi.advanceTimersByTimeAsync(10_000);
    for (const response of await Promise.all(pending)) await response?.body?.cancel().catch(() => {});
    await Promise.all(waits);
    await app.close();
    get.mockRestore();
  };
  return { app, finishes, warn, waits, send, health, cleanup };
}

it.each(["access", "agent"] as const)(
  "INV-6 INV-7: %s charges behind a retiring entry retire only after their invocation's platform end, exactly once",
  async (kind) => {
    vi.useFakeTimers();
    const deployment = stalledDeployment(kind);
    const { finishes, warn, waits, send, health } = deployment;
    // The entry workerHandler drives once workerd itself has called it.
    const enabled: AuthenticationRetirement = { enabled: true };
    const entry = workerEntry(deployment.app);
    const outer: Entry = (request, ctx) => entry(request, ctx, enabled);
    try {
      const wave = Array.from({ length: 16 }, () => send(outer));
      await until(() => finishes.length === 16);
      await vi.advanceTimersByTimeAsync(5_000);
      const answered = await drain(Promise.all(wave));
      for (const response of answered) expect(response.status).toBe(kind === "access" ? 503 : 401);
      // Fifteen responses finish sending, which starts the platform's
      // 30-second waitUntil window; one is never read, so its invocation may
      // still be running.
      const streaming = answered.pop()!;
      for (const response of answered) await drain(response.text());
      const ended = Date.now();
      await vi.advanceTimersByTimeAsync(1_000);
      await health(outer, 0, 16, enabled);
      // At the latest instant those invocations can be alive, nothing retires
      // and the full allowance still refuses.
      await vi.advanceTimersByTimeAsync(ended + 35_000 - Date.now());
      await health(outer, 0, 16, enabled);
      const refused = await drain(send(outer));
      expect(refused.status).toBe(503);
      await drain(refused.text());
      expect(warn).not.toHaveBeenCalledWith(...RETIRED);
      await vi.advanceTimersByTimeAsync(1);
      await health(outer, 0, 1, enabled);
      expect(warn).toHaveBeenCalledWith(...RETIRED);
      // An unfinished response is no end: an hour later it still counts.
      await vi.advanceTimersByTimeAsync(3_600_000);
      await health(outer, 0, 1, enabled);
      await drain(streaming.body!.cancel());
      await vi.advanceTimersByTimeAsync(35_001);
      await health(outer, 0, 0, enabled);
      expect(warn.mock.calls.filter((call) => call[0] === RETIRED[0])).toHaveLength(2);
      // Late settlements of retired charges change nothing.
      finishes.splice(0).forEach((finish) => finish());
      await drain(Promise.all(waits));
      await health(outer, 0, 0, enabled);
      // Admission recovered with exact accounting: 16 admitted, then busy.
      const fresh = Array.from({ length: 16 }, () => send(outer));
      await until(() => finishes.length === 16);
      await health(outer, 16, 0, enabled);
      const busy = await drain(send(outer));
      expect(busy.status).toBe(503);
      expect(await drain(busy.json())).toMatchObject({ error: { code: "authentication_busy" } });
      finishes.splice(0).forEach((finish) => finish());
      for (const response of await drain(Promise.all(fresh))) await drain(response.text());
      await drain(Promise.all(waits));
      await health(outer, 0, 0, enabled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await deployment.cleanup();
      vi.useRealTimers();
    }
  },
);

it.each(["access", "agent"] as const)(
  `INV-6 INV-7: %s charges entering through connecta.fetch or a called workerHandler ${workerd ? "keep Node accounting on workerd" : "never retire on Node"}`,
  async (kind) => {
    vi.useFakeTimers();
    const deployment = stalledDeployment(kind);
    const { finishes, warn, waits, send, health } = deployment;
    // Both receive an ExecutionContext shaped like an event's own; neither
    // owns the invocation's outer boundary.
    const direct: Entry = (request, ctx) => deployment.app.fetch(request, undefined, ctx);
    const handler = workerHandler(() => deployment.app);
    const called: Entry = (request, ctx) => handler.fetch(request, undefined, ctx);
    const directMode: AuthenticationRetirement = {
      enabled: false,
      reason: workerd ? "not_worker_handler" : "not_workers",
    };
    const calledMode: AuthenticationRetirement = {
      enabled: false,
      reason: workerd ? "not_outermost_handler" : "not_workers",
    };
    try {
      const wave = Array.from({ length: 16 }, (_, i) => send(i % 2 ? direct : called));
      await until(() => finishes.length === 16);
      await vi.advanceTimersByTimeAsync(5_000);
      for (const response of await drain(Promise.all(wave))) {
        expect(response.status).toBe(kind === "access" ? 503 : 401);
        await drain(response.text());
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await health(direct, 0, 16, directMode);
      await health(called, 0, 16, calledMode);
      // Every response was read, yet no end is known: an hour later all 16 still count.
      await vi.advanceTimersByTimeAsync(3_600_000);
      await health(direct, 0, 16, directMode);
      await health(called, 0, 16, calledMode);
      const refused = await drain(send(called));
      expect(await drain(refused.json())).toMatchObject({ error: { code: "authentication_busy" } });
      expect(warn).not.toHaveBeenCalledWith(...RETIRED);
      // Their real settlements release, once each.
      finishes.splice(0).forEach((finish) => finish());
      await drain(Promise.all(waits));
      await health(direct, 0, 0, directMode);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await deployment.cleanup();
      vi.useRealTimers();
    }
  },
);

it("workerHandler starts one instance per isolate and refuses anything createConnecta did not build", async () => {
  const app = createTestConnecta({ connectors: [calcConnector], logger: silentLogger });
  const start = vi.fn((_env: { name: string }) => app);
  const handler = workerHandler(start);
  try {
    expect(Object.isFrozen(handler)).toBe(true);
    for (const name of ["first", "second"]) {
      const response = await handler.fetch(new Request(`${BASE}/health`), { name }, undefined);
      expect(response.status).toBe(200);
    }
    expect(start.mock.calls).toEqual([[{ name: "first" }]]);
    const spread = { ...handler };
    expect(spread.fetch).toBe(handler.fetch);
    const forged = workerHandler(() => ({ ...app }));
    await expect(forged.fetch(new Request(`${BASE}/health`), undefined, undefined)).rejects.toThrow(
      "start(env) must return a createConnecta() instance",
    );
  } finally {
    await app.close();
  }
});
