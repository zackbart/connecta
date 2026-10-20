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

// The fixture moves its own isolate clock, never Connecta's code or constants.
const clock = async (query: string) => {
  await (await worker!.fetch(`https://connecta.test/__clock?${query}`)).text();
};
const binding = {
  control: async (path: string) => {
    await (await fetch(`${origin}/binding/${path}`)).text();
  },
  status: async (): Promise<{ calls: number; ids: string[] }> => (await fetch(`${origin}/binding/status`)).json(),
  health: async (): Promise<{ active: number; abandoned: number; abandonedSaturated: boolean }> => {
    const response = await worker!.fetch("https://connecta.test/health");
    return ((await response.json()) as { admission: { authentication: Awaited<ReturnType<typeof binding.health>> } })
      .admission.authentication;
  },
  start: (kind: "access" | "agent", id: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    worker!.fetch(`https://connecta.test/${kind === "agent" ? "agent/team" : "mcp"}`, {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: {
        "X-Binding-Kind": kind,
        "X-Auth-Upstream": `${origin}/binding/${id}`,
        "Mcp-Method": "subscriptions/listen",
        ...(kind === "agent" ? { Authorization: `Bearer cta_${"a".repeat(43)}` } : {}),
        ...headers,
      },
    }),
};

it.skipIf(!worker).each(["access", "agent"] as const)(
  "INV-6 INV-7: workerd %s charges stranded by ended invocations retire after the waitUntil bound and admission recovers",
  async (kind) => {
    const pending: Promise<unknown>[] = [];
    try {
      await binding.control("reset");
      await clock("reset");
      // Each invocation ends two seconds after its response, as production's
      // waitUntil limit would end it; its unfinished lookup then never settles.
      const wave = Array.from({ length: 16 }, (_, i) =>
        binding.start(kind, `ended-${i}`, { "X-Wait-Until-Window": "2000" }),
      );
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect((await binding.status()).ids).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) {
        expect(response.status).toBe(kind === "access" ? 503 : 401);
        await response.text();
      }
      // workerd ended every invocation and closed its upstream connection.
      await vi.waitFor(async () => expect((await binding.status()).ids).toHaveLength(0), { timeout: 10_000 });
      // Inside the bound the stranded allowance still refuses.
      expect(await binding.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      const refused = await binding.start(kind, "refused");
      expect(await refused.json()).toMatchObject({ error: { code: "authentication_busy" } });
      expect((await binding.status()).calls).toBe(16);
      // Past 30 seconds plus margin after those responses, no invocation can
      // still be running: health retires the charges.
      await clock("advance=36000");
      expect(await binding.health()).toMatchObject({ active: 0, abandoned: 0, abandonedSaturated: false });
      const recovered = await binding.start(kind, "fast");
      expect(recovered.status).not.toBe(503);
      await recovered.body?.cancel();
    } finally {
      await clock("reset");
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  30_000,
);

it.skipIf(!worker)(
  "INV-7: workerd never retires a still-running invocation's charge, and a late settlement after retirement counts once",
  async () => {
    const caller = new AbortController();
    let running: Promise<Response | undefined> | undefined;
    const total = async () => {
      const { active, abandoned } = await binding.health();
      return active + abandoned;
    };
    try {
      await binding.control("reset");
      await clock("reset");
      // A connected caller still waiting on its adapter: no response, no end.
      running = worker!
        .fetch("https://connecta.test/mcp", {
          method: "POST",
          signal: caller.signal,
          headers: { "Mcp-Method": "subscriptions/listen", "X-Auth-Upstream": `${origin}/binding/running` },
        })
        .catch(() => undefined);
      await vi.waitFor(async () => expect((await binding.status()).ids).toEqual(["/binding/running"]), {
        timeout: 10_000,
      });
      // An answered invocation whose lookup Miniflare keeps running.
      const answered = await binding.start("access", "answered");
      expect(answered.status).toBe(503);
      await answered.text();
      await vi.waitFor(async () => expect(await binding.health()).toMatchObject({ abandoned: 1 }), { timeout: 3_000 });
      expect(await total()).toBe(2);
      // Still inside its 30-second waitUntil window: nothing retires.
      await clock("advance=25000");
      expect(await total()).toBe(2);
      expect((await binding.status()).ids).toEqual(["/binding/running", "/binding/answered"]);
      // Past the bound the answered charge retires; production would have
      // cancelled its lookup. The connected caller's charge never retires.
      await clock("advance=11000");
      expect(await total()).toBe(1);
      await clock("advance=3600000");
      expect(await total()).toBe(1);
      // The lookup Miniflare kept alive now settles: its retired charge stays
      // closed, so nothing is decremented twice.
      await binding.control("release?id=/binding/answered");
      await vi.waitFor(async () => expect((await binding.status()).ids).toEqual(["/binding/running"]));
      expect(await total()).toBe(1);
      await binding.control("release");
      await vi.waitFor(async () => expect(await binding.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      caller.abort();
      await clock("reset");
      await binding.control("release");
      const response = await running;
      await response?.body?.cancel();
    }
  },
  30_000,
);
