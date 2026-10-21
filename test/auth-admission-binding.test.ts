// Native separate requests exercise the non-cancellable Access/storage binding
// contract; the real TCP operation intentionally ignores caller cancellation.
import { expect, inject, it, vi } from "vitest";
interface Bindings {
  AUTH_ADMISSION: Fetcher;
  AUTH_ADMISSION_ENTRY: Fetcher;
  AUTH_ADMISSION_MIDDLEWARE: Fetcher;
  AUTH_ADMISSION_CONTROL: Fetcher;
  AUTH_ADMISSION_NO_SIGNAL: Fetcher;
}
const bindings = await (async () => {
  try {
    const module = "cloudflare:test";
    return ((await import(/* @vite-ignore */ module)) as { env: Bindings }).env;
  } catch {
    return undefined;
  }
})();
const worker = bindings?.AUTH_ADMISSION;
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
type Authentication = { active: number; abandoned: number; abandonedSaturated: boolean; retirement: unknown };
const healthOf = async (via: Fetcher): Promise<Authentication> => {
  const response = await via.fetch("https://connecta.test/health");
  return ((await response.json()) as { admission: { authentication: Authentication } }).admission.authentication;
};
const binding = {
  control: async (path: string) => {
    await (await fetch(`${origin}/binding/${path}`)).text();
  },
  status: async (): Promise<{ calls: number; ids: string[] }> => (await fetch(`${origin}/binding/status`)).json(),
  ids: async (prefix: string) =>
    ((await (await fetch(`${origin}/binding/status`)).json()) as { ids: string[] }).ids.filter((id) =>
      id.startsWith(`/binding/${prefix}`),
    ),
  health: () => healthOf(worker!),
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
  "INV-6 INV-7: workerd %s charges behind connecta.fetch with a replaced context never retire, though their responses were read",
  async (kind) => {
    const pending: Promise<unknown>[] = [];
    try {
      await binding.control("reset");
      await clock("reset");
      // A Worker passing a context of its own to connecta.fetch and reading
      // the answer: Connecta cannot know when that invocation ends.
      const wave = Array.from({ length: 16 }, (_, i) => binding.start(kind, `replaced-${i}`));
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect(await binding.ids("replaced-")).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) {
        expect(response.status).toBe(kind === "access" ? 503 : 401);
        await response.text();
      }
      await vi.waitFor(
        async () =>
          expect(await binding.health()).toMatchObject({
            active: 0,
            abandoned: 16,
            retirement: { enabled: false, reason: "not_worker_handler" },
          }),
        { timeout: 3_000 },
      );
      // Past any bound counted from those responses, every lookup still runs
      // and every charge still counts.
      await clock("advance=36000");
      expect(await binding.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      await clock("advance=3600000");
      expect(await binding.ids("replaced-")).toHaveLength(16);
      expect(await binding.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      // Real settlement releases each charge once.
      await binding.control("release");
      await vi.waitFor(async () => expect(await binding.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      await clock("reset");
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  30_000,
);

// The fixture Worker exporting workerHandler itself, which workerd calls
// directly, plus middleware and control entrypoints in the same isolate.
const entry = {
  control: async (path: string) =>
    (await bindings!.AUTH_ADMISSION_CONTROL.fetch(`https://connecta.test${path}`)).text(),
  health: (via: Fetcher = bindings!.AUTH_ADMISSION_ENTRY) => healthOf(via),
  agent: (via: Fetcher = bindings!.AUTH_ADMISSION_ENTRY) =>
    via.fetch("https://connecta.test/agent/team", {
      method: "POST",
      headers: { "Mcp-Method": "subscriptions/listen", Authorization: `Bearer cta_${"a".repeat(43)}` },
    }),
  human: (upstream: string, signal?: AbortSignal) =>
    bindings!.AUTH_ADMISSION_ENTRY.fetch("https://connecta.test/mcp", {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "Mcp-Method": "subscriptions/listen", "X-Auth-Upstream": `${origin}/binding/${upstream}` },
    }),
  reset: async () => {
    await binding.control("reset");
    await entry.control("/clock?reset");
    await entry.control("/window");
  },
};

it.skipIf(!worker)("INV-6: /health reports each entry's retirement mode as one fixed verdict", async () => {
  const authentication = await entry.health();
  expect(authentication).toEqual({
    active: 0,
    limit: 16,
    abandoned: 0,
    abandonedLimit: 16,
    abandonedSaturated: false,
    retirement: { enabled: true },
  });
  expect((await entry.health(bindings!.AUTH_ADMISSION_MIDDLEWARE)).retirement).toEqual({
    enabled: false,
    reason: "not_outermost_handler",
  });
  expect((await entry.health(bindings!.AUTH_ADMISSION_NO_SIGNAL)).retirement).toEqual({
    enabled: false,
    reason: "request_signal_disabled",
  });
  expect((await binding.health()).retirement).toEqual({ enabled: false, reason: "not_worker_handler" });
});

it.skipIf(!worker)(
  "INV-6 INV-7: workerd retires charges stranded behind the outermost workerHandler after the waitUntil bound, and admission recovers",
  async () => {
    const pending: Promise<unknown>[] = [];
    try {
      await entry.reset();
      // Each invocation ends about two seconds after its answer, as
      // production's waitUntil limit would end it; its lookup never settles.
      await entry.control("/window?ms=7000");
      const wave = Array.from({ length: 16 }, () => entry.agent());
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) {
        expect(response.status).toBe(401);
        await response.text();
      }
      // workerd ended every invocation and closed its upstream connection.
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(0), { timeout: 10_000 });
      // Inside the bound the stranded allowance still refuses.
      expect(await entry.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      const refused = await entry.agent();
      expect(await refused.json()).toMatchObject({ error: { code: "authentication_busy" } });
      expect((await binding.status()).calls).toBe(16);
      // Past 30 seconds plus margin after those responses, no invocation can
      // still be running: health retires the charges.
      await entry.control("/clock?advance=36000");
      expect(await entry.health()).toMatchObject({ active: 0, abandoned: 0, abandonedSaturated: false });
      const recovered = await entry.human("fast");
      expect(recovered.status).toBe(401);
      await recovered.text();
    } finally {
      await entry.reset();
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  30_000,
);

it.skipIf(!worker)(
  "INV-7: behind workerHandler a still-connected caller never retires, an answered charge retires only past its bound, and a late settlement counts once",
  async () => {
    const caller = new AbortController();
    let running: Promise<Response | undefined> | undefined;
    const total = async () => {
      const { active, abandoned } = await entry.health();
      return active + abandoned;
    };
    try {
      await entry.reset();
      // A connected caller still waiting on its adapter: no response, no end.
      running = entry.human("running", caller.signal).catch(() => undefined);
      await vi.waitFor(async () => expect(await binding.ids("running")).toHaveLength(1), { timeout: 10_000 });
      // An answered invocation whose lookup Miniflare keeps running.
      const answered = await entry.agent();
      expect(answered.status).toBe(401);
      await answered.text();
      await vi.waitFor(async () => expect(await entry.health()).toMatchObject({ abandoned: 1 }), { timeout: 3_000 });
      const [lookup] = await binding.ids("agent-");
      expect(lookup).toBeDefined();
      expect(await total()).toBe(2);
      // Still inside its 30-second waitUntil window: nothing retires.
      await entry.control("/clock?advance=25000");
      expect(await total()).toBe(2);
      // Past the bound the answered charge retires; production would have
      // cancelled its lookup. The connected caller's charge never retires.
      await entry.control("/clock?advance=11000");
      expect(await total()).toBe(1);
      await entry.control("/clock?advance=3600000");
      expect(await total()).toBe(1);
      // The lookup Miniflare kept alive now settles: its retired charge stays
      // closed, so nothing is decremented twice.
      await binding.control(`release?id=${lookup}`);
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(0));
      expect(await total()).toBe(1);
      await binding.control("release");
      await vi.waitFor(async () => expect(await entry.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      caller.abort();
      await entry.reset();
      await binding.control("release");
      const response = await running;
      await response?.body?.cancel();
    }
  },
  30_000,
);

it.skipIf(!worker)(
  "INV-6 INV-7: middleware that consumes workerHandler's response and keeps running never retires its charges, so counts stay truthful",
  async () => {
    const pending: Promise<Response | undefined>[] = [];
    try {
      await entry.reset();
      const wave = Array.from({ length: 16 }, () => entry.agent(bindings!.AUTH_ADMISSION_MIDDLEWARE));
      pending.push(...wave.map((response) => response.catch(() => undefined)));
      // Each wrapper read Connecta's answer and now awaits a fetch of its own.
      await vi.waitFor(async () => expect(await binding.ids("after-")).toHaveLength(16), { timeout: 10_000 });
      await vi.waitFor(
        async () => expect(await entry.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      // Past any bound counted from those consumed responses, all 16 lookups
      // still run, and health still says so.
      await entry.control("/clock?advance=36000");
      expect(await binding.ids("agent-")).toHaveLength(16);
      expect(await entry.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      // Another wave is refused before any lookup: nothing accumulates.
      for (const response of await Promise.all(Array.from({ length: 16 }, () => entry.agent()))) {
        expect(await response.json()).toMatchObject({ error: { code: "authentication_busy" } });
      }
      expect(await binding.ids("agent-")).toHaveLength(16);
      await entry.control("/clock?advance=3600000");
      expect(await entry.health()).toMatchObject({ active: 0, abandoned: 16 });
      await binding.control("release");
      for (const response of await Promise.all(wave)) expect(response?.status).toBe(401);
      await vi.waitFor(async () => expect(await entry.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      await entry.reset();
      await binding.control("release");
      for (const response of await Promise.all(pending)) await response?.body?.cancel();
    }
  },
  30_000,
);

it.skipIf(!worker)(
  "INV-7: a scheduled handler calling Connecta with its own ExecutionContext never retires, through either entry",
  async () => {
    const result = async () => JSON.parse(await entry.control("/scheduled/result")) as Record<string, unknown>;
    try {
      await entry.reset();
      await entry.control("/scheduled");
      // Both answers were read; the cron job now runs on.
      await vi.waitFor(async () => expect(await binding.ids("scheduled-hold")).toHaveLength(1), { timeout: 10_000 });
      expect(await result()).toEqual({
        retirement: [
          { enabled: false, reason: "not_outermost_handler" },
          { enabled: false, reason: "not_worker_handler" },
        ],
        statuses: [401, 401],
      });
      await vi.waitFor(async () => expect(await entry.health()).toMatchObject({ active: 0, abandoned: 2 }), {
        timeout: 3_000,
      });
      await entry.control("/clock?advance=36000");
      expect(await entry.health()).toMatchObject({ active: 0, abandoned: 2 });
      await entry.control("/clock?advance=3600000");
      expect(await binding.ids("agent-")).toHaveLength(2);
      expect(await entry.health()).toMatchObject({ active: 0, abandoned: 2 });
      await binding.control("release");
      await vi.waitFor(async () => expect(await result()).toMatchObject({ done: true }));
      await vi.waitFor(async () => expect(await entry.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      await entry.reset();
      await binding.control("release");
    }
  },
  30_000,
);
