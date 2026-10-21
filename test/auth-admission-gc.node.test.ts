// Node-only: forces V8 collections through --expose-gc, which workerd does not provide.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { authenticationSnapshot } from "../src/auth-admission.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { AuthResult } from "../src/types.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const BASE = "https://connecta.test";

async function collect() {
  // Finalizers run as their own tasks after a collection.
  for (let round = 0; round < 6; round++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// A human adapter that never settles. `live` keeps a request's resolver, as
// running I/O keeps its callbacks; otherwise nothing can ever settle it.
function deployment(live: (id: string) => boolean) {
  const resolvers = new Map<string, (result: AuthResult) => void>();
  const storage = memoryStorage();
  // A native read that never settles and that nothing can settle.
  storage.get = () => new Promise(() => {});
  const app = createTestConnecta({
    connectors: [calcConnector],
    logger: silentLogger,
    maintainers: [{ namespace: "test", id: "alice" }],
    auth: {
      kind: "test",
      interactiveOperator: true,
      authorize: (request) =>
        new Promise<AuthResult>((resolve) => {
          const id = request.headers.get("X-Id")!;
          if (live(id)) resolvers.set(id, resolve);
        }),
    },
    accessTokens: accessTokens(storage),
    agents: ["assistant"],
    pools: { team: { tools: ["calc"], members: ["agent:assistant"] } },
  });
  const human = (id: string) => {
    const caller = new AbortController();
    const response = app.fetch(new Request(`${BASE}/mcp`, { signal: caller.signal, headers: { "X-Id": id } }));
    return { abort: () => caller.abort(), response: response.catch(() => undefined) };
  };
  const agent = () => app.fetch(mcpRpc("tools/list", {}, { agentPool: "team", token: `cta_${"a".repeat(43)}` }));
  // While deadline timers still hold every charge's token, admission refuses.
  // A listen defers MCP execution admission, which the stalled callers fill.
  const refused = async () => {
    const response = await app.fetch(
      new Request(`${BASE}/mcp`, { method: "POST", headers: { "Mcp-Method": "subscriptions/listen" } }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "authentication_busy" } });
  };
  return { app, resolvers, human, agent, refused };
}

it("INV-7: on Node a never-settling adapter or native read whose chain is unreachable is collected and released once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const warn = vi.fn();
  const { app, human, agent, refused } = deployment(() => false);
  try {
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0, unreachableRelease: true });
    const humans = Array.from({ length: 8 }, (_, i) => human(`dropped-${i}`));
    const agents = Array.from({ length: 8 }, () => agent());
    await vi.advanceTimersByTimeAsync(1);
    expect(authenticationSnapshot()).toMatchObject({ active: 16, abandoned: 0 });
    await refused();
    humans.forEach((caller) => caller.abort());
    // Agent callers get the five-second answer; nothing settles any charge.
    await vi.advanceTimersByTimeAsync(5_000);
    for (const response of await Promise.all(agents)) {
      expect(response.status).toBe(401);
      await response.text();
    }
    await Promise.all(humans.map((caller) => caller.response));
    await vi.advanceTimersByTimeAsync(6_000);
    // Past every deadline nothing holds a token, so an incidental collection
    // may already have released some charges.
    const { active, abandoned } = authenticationSnapshot();
    expect(active).toBe(0);
    expect(abandoned).toBeLessThanOrEqual(16);
    await collect();
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0, abandonedSaturated: false });
    // Admission recovers, logging the collector's release once.
    const logged = createTestConnecta({
      connectors: [calcConnector],
      logger: { ...silentLogger, warn },
      maintainers: [{ namespace: "test", id: "alice" }],
      auth: { kind: "test", interactiveOperator: true, authorize: () => Promise.resolve({ ok: true, userId: "bob" }) },
    });
    try {
      const response = await logged.fetch(new Request(`${BASE}/ui/api/config`));
      expect(response.status).not.toBe(503);
      await response.text();
      expect(warn.mock.calls).toContainEqual([
        "[connecta] Authentication released after its pending work became unreachable",
        { reason: "authentication_unreachable" },
      ]);
    } finally {
      await logged.close();
    }
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
  } finally {
    await app.close();
  }
});

it("INV-7: on Node a never-settling adapter that can still settle is never collected", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Fifteen callers stay settleable; one beside them proves collection ran.
  const { app, resolvers, human, refused } = deployment((id) => id !== "dropped");
  try {
    const callers = [...Array.from({ length: 15 }, (_, i) => human(`live-${i}`)), human("dropped")];
    await vi.advanceTimersByTimeAsync(1);
    expect(authenticationSnapshot()).toMatchObject({ active: 16, abandoned: 0 });
    await refused();
    callers.forEach((caller) => caller.abort());
    await Promise.all(callers.map((caller) => caller.response));
    await vi.advanceTimersByTimeAsync(11_000);
    // The live fifteen always count; the dropped one may already be released.
    expect(authenticationSnapshot().active).toBe(0);
    expect(authenticationSnapshot().abandoned).toBeGreaterThanOrEqual(15);
    await collect();
    await collect();
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 15 });
    for (const resolve of resolvers.values()) resolve({ ok: false, response: new Response(null, { status: 401 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
    await collect();
    expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
  } finally {
    await app.close();
  }
});
