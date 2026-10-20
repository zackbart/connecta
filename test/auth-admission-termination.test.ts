// Charges stranded by an ended Worker invocation, through the real fetch edge
// on fake timers. Node makes no termination promise and keeps counting.
import { expect, it, vi } from "vitest";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
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

it.each(["access", "agent"] as const)(
  `INV-6 INV-7: %s charges retire ${workerd ? "only after their Worker invocation's platform end" : "never on Node"}, exactly once`,
  async (kind) => {
    vi.useFakeTimers();
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
    const send = () => {
      const response = app.fetch(
        new Request(`${BASE}${kind === "agent" ? "/agent/team" : "/mcp"}`, {
          method: "POST",
          headers: {
            "Mcp-Method": "subscriptions/listen",
            ...(kind === "agent" ? { Authorization: `Bearer cta_${"a".repeat(43)}` } : {}),
          },
        }),
        undefined,
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
    const health = async (active: number, abandoned: number) => {
      const response = await drain(app.fetch(new Request(`${BASE}/health`)));
      const body = (await drain(response.json())) as { admission: { authentication: unknown } };
      expect(body.admission.authentication).toEqual({
        active,
        limit: 16,
        abandoned,
        abandonedLimit: 16,
        abandonedSaturated: abandoned === 16,
      });
    };
    try {
      const wave = Array.from({ length: 16 }, send);
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
      await health(0, 16);
      // At the latest instant those invocations can be alive, nothing retires
      // and the full allowance still refuses.
      await vi.advanceTimersByTimeAsync(ended + 35_000 - Date.now());
      await health(0, 16);
      const refused = await drain(send());
      expect(refused.status).toBe(503);
      await drain(refused.text());
      expect(warn).not.toHaveBeenCalledWith(...RETIRED);
      await vi.advanceTimersByTimeAsync(1);
      await health(0, workerd ? 1 : 16);
      if (workerd) expect(warn).toHaveBeenCalledWith(...RETIRED);
      // An unfinished response is no end: an hour later it still counts.
      await vi.advanceTimersByTimeAsync(3_600_000);
      await health(0, workerd ? 1 : 16);
      await drain(streaming.body!.cancel());
      await vi.advanceTimersByTimeAsync(35_001);
      await health(0, workerd ? 0 : 16);
      expect(warn.mock.calls.filter((call) => call[0] === RETIRED[0])).toHaveLength(workerd ? 2 : 0);
      // Late settlements of retired charges change nothing; on Node they are
      // the real settlements that release.
      finishes.splice(0).forEach((finish) => finish());
      await drain(Promise.all(waits));
      await health(0, 0);
      // Admission recovered with exact accounting: 16 admitted, then busy.
      const fresh = Array.from({ length: 16 }, send);
      await until(() => finishes.length === 16);
      await health(16, 0);
      const busy = await drain(send());
      expect(busy.status).toBe(503);
      expect(await drain(busy.json())).toMatchObject({ error: { code: "authentication_busy" } });
      finishes.splice(0).forEach((finish) => finish());
      for (const response of await drain(Promise.all(fresh))) await drain(response.text());
      await drain(Promise.all(waits));
      await health(0, 0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishes.splice(0).forEach((finish) => finish());
      await vi.advanceTimersByTimeAsync(10_000);
      for (const response of await Promise.all(pending)) await response?.body?.cancel().catch(() => {});
      await Promise.all(waits);
      await app.close();
      get.mockRestore();
      vi.useRealTimers();
    }
  },
);
