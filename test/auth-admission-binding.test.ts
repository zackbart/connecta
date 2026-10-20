// Native separate requests exercise the non-cancellable Access/storage binding
// contract; the real TCP operation intentionally ignores caller cancellation.
import { expect, inject, it, vi } from "vitest";
const worker = await (async () => {
  try {
    const module = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ module)) as { env: { AUTH_ADMISSION?: Fetcher } };
    return env.AUTH_ADMISSION;
  } catch {
    return undefined;
  }
})();
const origin = worker ? inject("authAdmissionServer") : "";
it.skipIf(!worker).each(["access", "agent"] as const)(
  "INV-6 INV-7: workerd %s binding stalls recover with honest bounded abandonment",
  async (kind) => {
    const pending: Promise<unknown>[] = [];
    const callers: AbortController[] = [];
    const control = async (path: string) => {
      await (await fetch(`${origin}/binding/${path}`)).text();
    };
    const status = async (): Promise<{ calls: number; peak: number; ids: string[] }> =>
      (await fetch(`${origin}/binding/status`)).json();
    const health = async (): Promise<{ active: number; abandoned: number; abandonedSaturated: boolean }> => {
      const response = await worker!.fetch("https://connecta.test/health");
      return ((await response.json()) as { admission: { authentication: Awaited<ReturnType<typeof health>> } })
        .admission.authentication;
    };
    const start = (id: string) => {
      const caller = new AbortController();
      callers.push(caller);
      const promise = worker!.fetch(`https://connecta.test/${kind === "agent" ? "agent/team" : "mcp"}`, {
        method: "POST",
        signal: caller.signal,
        headers: {
          "X-Binding-Kind": kind,
          "X-Auth-Upstream": `${origin}/binding/${id}`,
          "Mcp-Method": "subscriptions/listen",
          ...(kind === "agent" ? { Authorization: `Bearer cta_${"a".repeat(43)}` } : {}),
        },
      });
      pending.push(promise.catch(() => {}));
      return promise;
    };
    try {
      await control("reset");
      start("first").catch(() => {});
      await vi.waitFor(async () => expect((await status()).ids).toHaveLength(1), { timeout: 10_000 });
      callers[0]!.abort();
      await vi.waitFor(async () => expect(await health()).toMatchObject({ active: 0, abandoned: 1 }), {
        timeout: 8_000,
      });
      expect((await status()).ids).toHaveLength(1); // disconnect did not end the binding
      const wave = Array.from({ length: 16 }, (_, i) => start(`wave-${i}`));
      await vi.waitFor(async () => expect((await status()).ids).toHaveLength(17), { timeout: 5_000 });
      const busy = await start("busy");
      expect(await busy.json()).toMatchObject({ error: { code: "authentication_busy" } });
      // Native caller-facing deadlines answer even though all bindings still run.
      for (const response of await Promise.all(wave)) expect(response.status).toBe(kind === "access" ? 503 : 401);
      await vi.waitFor(
        async () => expect(await health()).toMatchObject({ active: 1, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      for (let i = 0; i < 4; i++) {
        const saturated = await start("saturated");
        expect(saturated.status).toBe(503);
        expect(saturated.headers.get("Cache-Control")).toBe("no-store");
        expect(await saturated.json()).toMatchObject({ error: { code: "authentication_busy" } });
      }
      expect((await status()).calls).toBe(17);
      expect((await status()).peak).toBeLessThanOrEqual(32);
      await control("release?id=/binding/first");
      await vi.waitFor(async () => expect(await health()).toMatchObject({ active: 0, abandoned: 16 }));
      await control("release?id=/binding/wave-0");
      await vi.waitFor(async () =>
        expect(await health()).toMatchObject({ active: 0, abandoned: 15, abandonedSaturated: false }),
      );
      const recovered = await start("fast");
      expect(recovered.status).not.toBe(503);
      await control("release");
      await vi.waitFor(async () => expect(await health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      callers.forEach((caller) => caller.abort());
      await control("release");
      await Promise.all(pending);
      await vi.waitFor(async () => expect(await health()).toMatchObject({ active: 0, abandoned: 0 }));
    }
  },
  30_000,
);
