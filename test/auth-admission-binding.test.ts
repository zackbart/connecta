// Native separate requests exercise the non-cancellable Access/storage binding
// contract; the real TCP operation intentionally ignores caller cancellation.
import { expect, inject, it, vi } from "vitest";
// Each collection scenario has a fresh fixture isolate (vitest.config.ts).
const bindings = await (async () => {
  try {
    const module = "cloudflare:test";
    return ((await import(/* @vite-ignore */ module)) as { env: Record<string, Fetcher> }).env;
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
      // Every binding still runs, so every charge is reachable and counted.
      expect((await status()).ids).toHaveLength(17);
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

type Authentication = {
  active: number;
  limit: number;
  abandoned: number;
  abandonedLimit: number;
  abandonedSaturated: boolean;
  unreachableRelease: boolean;
};
const healthOf = async (via: Fetcher): Promise<Authentication> => {
  const response = await via.fetch("https://connecta.test/health");
  return ((await response.json()) as { admission: { authentication: Authentication } }).admission.authentication;
};
const total = async (via: Fetcher) => {
  const { active, abandoned } = await healthOf(via);
  return active + abandoned;
};
// Allocation pressure until `satisfied`, or fail: collection timing is never
// guaranteed, only that enough garbage makes V8 collect.
async function collectUntil(pressure: () => Promise<string[]>, satisfied: (finalized: string[]) => Promise<boolean>) {
  let finalized: string[] = [];
  for (let round = 0; round < 80; round++) if (await satisfied((finalized = await pressure()))) return;
  throw new Error(`Allocation pressure never produced the expected collection (finalized: ${finalized.join(", ")})`);
}
// Four sentinels per check, two of which must be collected: V8 scans
// workerd's native stack conservatively during allocation-triggered
// collections, so a recent unreachable object can survive several of them.
const SENTINELS = 4;
const sentinelsCollected = (prefix: string) => async (finalized: string[]) =>
  finalized.filter((name) => name.startsWith(prefix)).length >= 2;
// Once workerd cancelled a wave's work, the collector may release any of
// its charges at any moment, before the first look included. Assert only
// that the count never grows, then the same allowance as for sentinels: all
// but one released.
async function releasedMonotonically(fixture: { via: Fetcher; pressure: () => Promise<string[]> }) {
  let previous = 16;
  for (let round = 0; round < 80; round++) {
    const { active, abandoned } = await healthOf(fixture.via);
    expect(active).toBe(0);
    expect(abandoned).toBeLessThanOrEqual(previous);
    if ((previous = abandoned) <= 1) return;
    await fixture.pressure();
  }
  throw new Error(`Allocation pressure never released the cancelled charges (${previous} remain)`);
}
// Regression (round 6): collection pressure at once after cancellation,
// before any look at the counters, may legally release every charge.
async function collectEarly(pressure: () => Promise<string[]>) {
  for (let round = 0; round < 4; round++) await pressure();
}
const binding = {
  control: async (path: string) => {
    await (await fetch(`${origin}/binding/${path}`)).text();
  },
  status: async (): Promise<{ calls: number; ids: string[] }> => (await fetch(`${origin}/binding/status`)).json(),
  ids: async (prefix: string) =>
    ((await (await fetch(`${origin}/binding/status`)).json()) as { ids: string[] }).ids.filter((id) =>
      id.startsWith(`/binding/${prefix}`),
    ),
};
// The connecta.fetch fixture (index.ts) in a scenario's own isolate.
function bindingFixture(key: string) {
  const via = bindings![`AUTH_ADMISSION_${key.toUpperCase().replaceAll("-", "_")}`]!;
  return {
    via,
    health: () => healthOf(via),
    pressure: async () =>
      ((await (await via.fetch("https://connecta.test/__pressure")).json()) as { finalized: string[] }).finalized,
    // Sentinels whose only reference is a fetch workerd cancels `ms` after
    // this request, as it cancels a stalled charge's lookup.
    sentinels: async (prefix: string, ms: number) => {
      for (let i = 0; i < SENTINELS; i++) {
        const response = await via.fetch(`https://connecta.test/__sentinel?name=${prefix}-${i}&ms=${ms}`, {
          headers: { "X-Auth-Upstream": `${origin}/binding/sentinel-${prefix}-${i}` },
        });
        await response.text();
      }
    },
    start: (kind: "access" | "agent", id: string, headers: Record<string, string> = {}) =>
      via.fetch(`https://connecta.test/${kind === "agent" ? "agent/team" : "mcp"}`, {
        method: "POST",
        headers: {
          "X-Binding-Kind": kind,
          "X-Auth-Upstream": `${origin}/binding/${id}`,
          "Mcp-Method": "subscriptions/listen",
          ...(kind === "agent" ? { Authorization: `Bearer cta_${"a".repeat(43)}` } : {}),
          ...headers,
        },
      }),
  };
}
// The plain Worker export (entry.ts) with its middleware and control
// entrypoints, in a scenario's own isolate.
function entryFixture(key: string) {
  const name = `AUTH_ADMISSION_ENTRY_${key.toUpperCase().replaceAll("-", "_")}`;
  const via = bindings![name]!;
  const control = async (path: string) =>
    (await bindings![`${name}_CONTROL`]!.fetch(`https://connecta.test${path}`)).text();
  return {
    via,
    middleware: bindings![`${name}_MIDDLEWARE`]!,
    control,
    health: () => healthOf(via),
    pressure: async () => (JSON.parse(await control("/pressure")) as { finalized: string[] }).finalized,
    sentinels: async (prefix: string, ms: number) => {
      for (let i = 0; i < SENTINELS; i++) await control(`/sentinel?name=${prefix}-${i}&ms=${ms}`);
    },
    agent: (through: Fetcher = via) =>
      through.fetch("https://connecta.test/agent/team", {
        method: "POST",
        headers: { "Mcp-Method": "subscriptions/listen", Authorization: `Bearer cta_${"a".repeat(43)}` },
      }),
    human: (upstream: string, signal?: AbortSignal) =>
      via.fetch("https://connecta.test/mcp", {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: { "Mcp-Method": "subscriptions/listen", "X-Auth-Upstream": `${origin}/binding/${upstream}` },
      }),
  };
}

it.skipIf(!worker).each(["access", "agent"] as const)(
  "INV-6 INV-7: workerd releases %s charges whose invocation ended and cancelled their lookups once collected, and admission recovers",
  async (kind) => {
    const fixture = bindingFixture(`ended-${kind}`);
    const pending: Promise<unknown>[] = [];
    try {
      await binding.control("reset");
      // Each invocation runs on after its answer until the test closes its
      // waitUntil window, as production's limit would end it; no lookup ever
      // settles.
      const wave = Array.from({ length: 16 }, (_, i) =>
        fixture.start(kind, `ended-${i}`, { "X-Wait-Until-Window": "held" }),
      );
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect(await binding.ids("ended-")).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) {
        expect(response.status).toBe(kind === "access" ? 503 : 401);
        await response.text();
      }
      // While every lookup still runs, every charge counts and admission
      // refuses.
      await vi.waitFor(
        async () =>
          expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      const refused = await fixture.start(kind, "refused");
      expect(await refused.json()).toMatchObject({ error: { code: "authentication_busy" } });
      expect(await binding.ids("ended-")).toHaveLength(16);
      // workerd ends every invocation and closes its upstream connection, so
      // no settlement callback will ever run.
      await (await fixture.via.fetch("https://connecta.test/__close-windows")).text();
      await vi.waitFor(async () => expect(await binding.ids("ended-")).toHaveLength(0), { timeout: 10_000 });
      // Unreachable now, each token is freed and its charge released once.
      await collectEarly(fixture.pressure);
      await releasedMonotonically(fixture);
      const recovered = await fixture.start(kind, "fast");
      expect(recovered.status).not.toBe(503);
      await recovered.text();
      expect(await total(fixture.via)).toBeLessThanOrEqual(1);
    } finally {
      await (await fixture.via.fetch("https://connecta.test/__close-windows")).text();
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  60_000,
);

it.skipIf(!worker).each(["access", "agent"] as const)(
  "INV-6 INV-7: workerd %s charges whose lookups still run are never released, though their responses were read",
  async (kind) => {
    const fixture = bindingFixture(`replaced-${kind}`);
    const pending: Promise<unknown>[] = [];
    try {
      await binding.control("reset");
      // Sentinels as old as the charges, unreachable once the wave is answered.
      await fixture.sentinels("replaced", 6_000);
      // connecta.fetch with the fixture's own context, its answer read: the
      // invocation, and every lookup, keeps running.
      const wave = Array.from({ length: 16 }, (_, i) => fixture.start(kind, `replaced-${i}`));
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect(await binding.ids("replaced-")).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) {
        expect(response.status).toBe(kind === "access" ? 503 : 401);
        await response.text();
      }
      await vi.waitFor(
        async () =>
          expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      // Sentinels cancelled with their own invocations are collected, proving
      // a collection ran, while every live lookup keeps its charge.
      await vi.waitFor(async () => expect(await binding.ids("sentinel-replaced")).toHaveLength(0), { timeout: 8_000 });
      await collectUntil(fixture.pressure, sentinelsCollected("replaced"));
      await fixture.pressure();
      expect(await binding.ids("replaced-")).toHaveLength(16);
      expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      const refused = await fixture.start(kind, "refused");
      expect(await refused.json()).toMatchObject({ error: { code: "authentication_busy" } });
      // Real settlement releases each charge once.
      await binding.control("release");
      await vi.waitFor(async () => expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  60_000,
);

it.skipIf(!worker)("INV-6: /health reports whether unreachable work can release its charge", async () => {
  expect(await entryFixture("middleware").health()).toEqual({
    active: 0,
    limit: 16,
    abandoned: 0,
    abandonedLimit: 16,
    abandonedSaturated: false,
    unreachableRelease: true,
  });
  expect((await entryFixture("no-weak-ref").health()).unreachableRelease).toBe(false);
});

it.skipIf(!worker)(
  "INV-6 INV-7: Promise-chain middleware that consumes Connecta's response and keeps running holds every charge, so the bound holds and a second wave is refused",
  async () => {
    const fixture = entryFixture("middleware");
    const pending: Promise<Response | undefined>[] = [];
    try {
      await binding.control("reset");
      await fixture.sentinels("middleware", 6_000);
      // The reviewer's middleware: Promise.resolve().then(handler.fetch.bind(...)),
      // then read the body and await another fetch, with the event's context.
      const wave = Array.from({ length: 16 }, () => fixture.agent(fixture.middleware));
      pending.push(...wave.map((response) => response.catch(() => undefined)));
      await vi.waitFor(async () => expect(await binding.ids("after-")).toHaveLength(16), { timeout: 10_000 });
      await vi.waitFor(
        async () =>
          expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      // Collections run (cancelled sentinels as old as the charges are
      // freed), yet every lookup is still live and every charge still counts.
      await vi.waitFor(async () => expect(await binding.ids("sentinel-middleware")).toHaveLength(0), {
        timeout: 8_000,
      });
      await collectUntil(fixture.pressure, sentinelsCollected("middleware"));
      await fixture.pressure();
      expect(await binding.ids("agent-")).toHaveLength(16);
      expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      // A second wave is refused before any lookup: nothing accumulates.
      for (const response of await Promise.all(Array.from({ length: 16 }, () => fixture.agent()))) {
        expect(await response.json()).toMatchObject({ error: { code: "authentication_busy" } });
      }
      expect(await binding.ids("agent-")).toHaveLength(16);
      expect((await binding.status()).calls).toBe(32 + SENTINELS);
      // Settlement releases each charge once, and the middleware answers.
      await binding.control("release");
      for (const response of await Promise.all(wave)) expect(response?.status).toBe(401);
      await vi.waitFor(async () => expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 0 }));
    } finally {
      await binding.control("release");
      for (const response of await Promise.all(pending)) await response?.body?.cancel();
    }
  },
  60_000,
);

it.skipIf(!worker)(
  "INV-7: a connected caller and a scheduled handler that read Connecta's answers and run on are never released while live",
  async () => {
    const fixture = entryFixture("scheduled");
    const caller = new AbortController();
    let running: Promise<Response | undefined> | undefined;
    const result = async () => JSON.parse(await fixture.control("/scheduled/result")) as Record<string, unknown>;
    try {
      await binding.control("reset");
      await fixture.sentinels("scheduled", 6_000);
      // A connected caller still waiting on its adapter: no response yet.
      running = fixture.human("running", caller.signal).catch(() => undefined);
      await vi.waitFor(async () => expect(await binding.ids("running")).toHaveLength(1), { timeout: 10_000 });
      // A cron job calls connecta.fetch twice with its own context, reads
      // both answers, then keeps running.
      await fixture.control("/scheduled");
      await vi.waitFor(async () => expect(await binding.ids("scheduled-hold")).toHaveLength(1), { timeout: 10_000 });
      expect(await result()).toEqual({ statuses: [401, 401] });
      expect(await binding.ids("agent-")).toHaveLength(2);
      expect(await total(fixture.via)).toBe(3);
      await vi.waitFor(async () => expect(await binding.ids("sentinel-scheduled")).toHaveLength(0), {
        timeout: 8_000,
      });
      await collectUntil(fixture.pressure, sentinelsCollected("scheduled"));
      await fixture.pressure();
      expect(await binding.ids("agent-")).toHaveLength(2);
      expect(await total(fixture.via)).toBe(3);
      await binding.control("release");
      await vi.waitFor(async () => expect(await result()).toMatchObject({ done: true }));
      await vi.waitFor(async () => expect(await total(fixture.via)).toBe(0));
    } finally {
      caller.abort();
      await binding.control("release");
      const response = await running;
      await response?.body?.cancel();
    }
  },
  60_000,
);

it.skipIf(!worker)(
  "INV-6 INV-7: behind the plain Worker export, charges whose invocation ended are released once collected",
  async () => {
    const fixture = entryFixture("ended");
    const pending: Promise<unknown>[] = [];
    try {
      await binding.control("reset");
      // Each invocation's waitUntil runs on after its answer until the test
      // closes the window; the event's own context is kept.
      await fixture.control("/window?held");
      const wave = Array.from({ length: 16 }, () => fixture.agent());
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) {
        expect(response.status).toBe(401);
        await response.text();
      }
      // Live: every charge counts, and a refusal makes no lookup.
      await vi.waitFor(
        async () =>
          expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      const refused = await fixture.agent();
      expect(await refused.json()).toMatchObject({ error: { code: "authentication_busy" } });
      expect(await binding.ids("agent-")).toHaveLength(16);
      expect((await binding.status()).calls).toBe(16);
      await fixture.control("/window");
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(0), { timeout: 10_000 });
      await collectEarly(fixture.pressure);
      await releasedMonotonically(fixture);
      const recovered = await fixture.human("fast");
      expect(recovered.status).toBe(401);
      await recovered.text();
    } finally {
      await fixture.control("/window");
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  60_000,
);

// Leaves the twin's isolate saturated for good; nothing else uses it.
it.skipIf(!worker)(
  "INV-6 INV-7: without enable_weak_ref, charges whose invocation ended stay counted, and the allowance refuses",
  async () => {
    const fixture = entryFixture("no-weak-ref");
    const pending: Promise<unknown>[] = [];
    try {
      await binding.control("reset");
      await fixture.control("/window?held");
      const wave = Array.from({ length: 16 }, () => fixture.agent());
      pending.push(...wave.map((response) => response.catch(() => {})));
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(16), { timeout: 10_000 });
      for (const response of await Promise.all(wave)) await response.text();
      await vi.waitFor(
        async () =>
          expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true }),
        { timeout: 3_000 },
      );
      await fixture.control("/window");
      await vi.waitFor(async () => expect(await binding.ids("agent-")).toHaveLength(0), { timeout: 10_000 });
      for (let round = 0; round < 8; round++) await fixture.pressure();
      expect(await fixture.health()).toMatchObject({ active: 0, abandoned: 16, abandonedSaturated: true });
      const refused = await fixture.agent();
      expect(await refused.json()).toMatchObject({ error: { code: "authentication_busy" } });
      expect((await binding.status()).calls).toBe(16);
    } finally {
      await fixture.control("/window");
      await binding.control("release");
      await Promise.all(pending);
    }
  },
  60_000,
);
