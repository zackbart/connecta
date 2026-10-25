import { Effect } from "effect";
import { registerNativeStorage } from "../src/runtime/native-storage.js";
import type { AgentConfig } from "../src/agent-config.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { agentDescriptions } from "../src/agent-description.js";
import { observeAgentAdmission } from "../src/agent-observation.js";
import { readConfig } from "../src/config.js";
import { customExecutor } from "../src/index.js";
import { runEdge } from "../src/runtime/run.js";
import { agentObservationKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectaConfig } from "../src/index.js";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { activityHistory, type ToolCallActivityEvent } from "../src/activity.js";
import { AGENT_NAMESPACE } from "../src/agent-identity.js";
import { agentRows } from "../src/operator-ui/agents.js";
import { attentionItems } from "../src/operator-ui/overview.js";
import { createTestConnecta } from "./helpers.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { workloadBinding, workloadFixture } from "./fixtures/workload.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";

const BASE = "https://connecta.test";
const NOW = "2026-10-25T12:00:00.000Z";
const LATER = "2026-10-25T12:00:01.000Z";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
let workload: Awaited<ReturnType<typeof workloadFixture>>;
beforeAll(async () => {
  workload = await workloadFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function deployment(options: Partial<ConnectaConfig> = {}) {
  return createTestConnecta({
    logger: "silent",
    connectors: [{ id: "crm", staticTools: [], listTools: async () => [], callTool: async () => null }],
    auth: fakeClerkAuth(),
    agents: [{ name: "assistant", vercel: workloadBinding }],
    pools: { team: { tools: ["crm"], members: ["agent:assistant"] } },
    ...options,
  });
}
async function contract(app: ReturnType<typeof deployment>, bearer = "clerk-operator") {
  const response = await app.fetch(
    new Request(`${BASE}/ui/api/config`, { headers: { Authorization: `Bearer ${bearer}` } }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as OperatorUiContractV2;
}
function request(bearer: string, path = "/agent/team", signal?: AbortSignal) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}
function mockKeys() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(new Request(url).url).toBe("https://oidc.vercel.com/.well-known/jwks");
    return Response.json(workload.jwks);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("deployment agent descriptions", () => {
  it("INV-4 INV-10 INV-13: describes each agent's actual credential kinds, frozen and isolated from callers", () => {
    const storage = memoryStorage();
    const input: AgentConfig[] = [{ name: "assistant", vercel: { ...workloadBinding } }, "token-only"];
    const resolved = readConfig({
      connectors: [],
      readOnly: true,
      executor,
      agents: input,
      accessTokens: accessTokens(storage),
    }).resolved;
    const expected = [
      { name: "assistant", credentialTypes: ["access_token", "vercel_oidc"] },
      { name: "token-only", credentialTypes: ["access_token"] },
    ];
    expect(agentDescriptions(resolved)).toEqual(expected);
    const original = input[0] as { name: string; vercel: typeof workloadBinding };
    original.vercel.project = "prj_changed";
    Object.defineProperty(original, "vercel", {
      get() {
        throw new Error("caller getter must not run");
      },
    });
    input[0] = "changed";
    expect(agentDescriptions(resolved)).toEqual(expected);
    const descriptions = agentDescriptions(resolved);
    expect(Object.isFrozen(descriptions)).toBe(true);
    for (const entry of descriptions) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.credentialTypes)).toBe(true);
    }
    expect(() => (descriptions as unknown as unknown[]).push({})).toThrow();
    const oidc = readConfig({
      connectors: [],
      readOnly: true,
      executor,
      agents: [{ name: "assistant", vercel: workloadBinding }],
    }).resolved;
    expect(agentDescriptions(oidc)).toEqual([{ name: "assistant", credentialTypes: ["vercel_oidc"] }]);
    expect(agentDescriptions({})).toEqual([]);
    expect(Object.isFrozen(agentDescriptions({}))).toBe(true);
    expect(agentDescriptions(resolved)).toEqual(expected);
    expect(JSON.stringify(descriptions)).not.toMatch(/team_|prj_|environment/);
  });
});

describe("operator agent admission observations", () => {
  it.each([false, true])(
    "INV-4 INV-6 INV-10: lists OIDC agents and pools with token module=%s without authorizing or minting",
    async (tokens) => {
      const storage = memoryStorage();
      const fetcher = mockKeys();
      const app = deployment({
        storage,
        ...(tokens ? { accessTokens: accessTokens(storage) } : {}),
        agents: [
          { name: "assistant", vercel: workloadBinding },
          { name: "idle", vercel: { ...workloadBinding, project: "prj_idle" } },
        ],
      });
      try {
        const before = await storage.list("");
        const view = await contract(app);
        expect(view.agents).toEqual([
          {
            name: "assistant",
            credentialTypes: tokens ? ["access_token", "vercel_oidc"] : ["vercel_oidc"],
            pools: ["team"],
            token: tokens ? expect.objectContaining({ state: "none" }) : null,
            lastSeenAt: null,
          },
          {
            name: "idle",
            credentialTypes: tokens ? ["access_token", "vercel_oidc"] : ["vercel_oidc"],
            pools: [],
            token: tokens ? expect.objectContaining({ state: "none" }) : null,
            lastSeenAt: null,
          },
        ]);
        expect(fetcher).not.toHaveBeenCalled();
        expect(await storage.list("")).toEqual(before);
        expect(agentRows(view, [])[0]).toMatchObject({ actions: tokens ? ["issue"] : [], lastSeenAt: null });
        expect(attentionItems(view).filter((item) => item.kind === "agent")).toEqual([]);
        const shell = await app.fetch(new Request(`${BASE}/tokens`));
        expect(shell.status).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["vercel_oidc", "access_token"] as const)(
    "INV-4 INV-6: successful %s admission updates last-seen without requiring activity or a tool call",
    async (kind) => {
      const storage = memoryStorage();
      mockKeys();
      const app = deployment({
        storage,
        ...(kind === "access_token" ? { agents: ["assistant"], accessTokens: accessTokens(storage) } : {}),
      });
      try {
        const bearer = kind === "vercel_oidc" ? await workload.token() : await issueAgentToken(storage, "assistant");
        const response = await app.fetch(request(bearer));
        expect(response.status).toBe(200);
        await response.text();
        const view = await contract(app);
        expect(view.agents[0]?.lastSeenAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(view.live.activity).toBe("unconfigured");
        const observed = await storage.get(agentObservationKeys.agent("assistant"));
        expect(observed).toBe(view.agents[0]?.lastSeenAt);
        expect(observed).not.toContain(bearer);
        const snapshot = await storage.list("");
        await contract(app);
        expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(observed);
        expect(await storage.list("")).toEqual(snapshot);
      } finally {
        await app.close();
      }
    },
  );

  it("INV-4 INV-6: failed identity, refused/undeclared pools and human traffic never update last-seen", async () => {
    const storage = memoryStorage();
    mockKeys();
    const app = deployment({ storage, pools: { team: { tools: ["crm"], members: ["other-person"] } } });
    try {
      const bearer = await workload.token();
      for (const [credential, path, status] of [
        [await workload.token({ project_id: "prj_wrong" }), "/agent/team", 401],
        [bearer, "/agent/team", 404],
        [bearer, "/agent/unknown", 404],
        ["clerk-operator", "/mcp", 200],
      ] as const) {
        const response = await app.fetch(request(credential, path));
        expect(response.status).toBe(status);
        await response.text();
      }
      expect(await storage.get(agentObservationKeys.agent("assistant"))).toBeNull();
      expect((await contract(app)).agents[0]?.lastSeenAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("INV-4: concurrent older admissions cannot roll last-seen backwards and contention is bounded", async () => {
    const storage = memoryStorage();
    const cas = storage.compareAndSet.bind(storage);
    const gate = deferred<void>();
    let blocked = false;
    const compare = vi.spyOn(storage, "compareAndSet").mockImplementation(async (key, expected, next, options) => {
      if (next === NOW && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return cas(key, expected, next, options);
    });
    const older = runEdge(observeAgentAdmission(storage, "assistant", NOW, 1000));
    await vi.waitFor(() => expect(blocked).toBe(true));
    await runEdge(observeAgentAdmission(storage, "assistant", LATER, 1000));
    gate.resolve();
    await older;
    expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(LATER);
    expect(compare).toHaveBeenCalledTimes(2);
    compare.mockResolvedValue(false);
    // Explicitly pass the one-minute sample window so this still exercises
    // two CAS attempts under contention, rather than a fresh-sample no-op.
    await runEdge(observeAgentAdmission(storage, "assistant", "2026-10-25T12:01:01.000Z", 1000));
    expect(compare).toHaveBeenCalledTimes(4);
    expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(LATER);
  });

  it.each(["failure", "stall"] as const)(
    "INV-7 INV-9: observation storage %s never refuses or replays admitted work",
    async (mode) => {
      const storage = memoryStorage();
      const get = storage.get.bind(storage);
      vi.spyOn(storage, "get").mockImplementation((key) =>
        key === agentObservationKeys.agent("assistant")
          ? mode === "stall"
            ? new Promise(() => {})
            : Promise.reject(new Error("private storage failure"))
          : get(key),
      );
      mockKeys();
      const calls = vi.fn(async () => ({ ok: true }));
      const app = deployment({
        storage,
        discovery: { probeTimeoutMs: 20 },
        connectors: [
          {
            id: "crm",
            staticTools: [{ name: "send", annotations: { readOnlyHint: false } }],
            listTools: async () => [{ name: "send", annotations: { readOnlyHint: false } }],
            callTool: calls,
          },
        ],
        pools: { team: { surface: "native", tools: ["crm"], members: ["agent:assistant"] } },
      });
      try {
        const admitted = request(await workload.token());
        const response = await app.fetch(
          new Request(admitted, {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "crm__send", arguments: {} },
            }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain("private storage failure");
        expect(calls).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it("INV-7: native observation settlement is interrupted before timeout returns", async () => {
    const storage = memoryStorage();
    let closed = false;
    registerNativeStorage(storage, {
      get: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
        ),
      set: () => Effect.void,
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      compareAndSet: () => Effect.succeed(true),
    });
    await runEdge(observeAgentAdmission(storage, "assistant", NOW, 10));
    expect(closed).toBe(true);
  });

  it("INV-4 INV-6 INV-10: admission and visible historical calls use the newest timestamp, respecting read gates and owner visibility", async () => {
    const storage = memoryStorage();
    const event: ToolCallActivityEvent = {
      schemaVersion: 1,
      id: "call",
      requestId: "request",
      occurredAt: LATER,
      actor: { kind: "vercel_oidc", id: "assistant", namespace: AGENT_NAMESPACE },
      connectorId: "crm",
      toolName: "read",
      address: "crm.read",
      source: "call_tool",
      outcome: "success",
      durationMs: 1,
      attempts: 1,
      serverName: "test",
      serverVersion: "test",
    };
    let events = [event];
    const history = activityHistory({ store: { record: async () => {}, list: async () => ({ events }) } });
    const connector = {
      id: "crm",
      staticTools: [{ name: "read", annotations: { readOnlyHint: true } }],
      listTools: async () => [],
      callTool: async () => null,
    };
    const app = deployment({ storage, connectors: [connector], activity: history });
    await storage.set(agentObservationKeys.agent("assistant"), NOW);
    try {
      expect((await contract(app)).agents[0]?.lastSeenAt).toBe(LATER);
      events = [{ ...event, actorBasis: "principal" }];
      // Personal call history has no checked matching human owner, so it is withheld.
      const personal = deployment({
        storage,
        connectors: [{ ...connector, authScope: "personal" }],
        activity: history,
      });
      try {
        expect((await contract(personal)).agents[0]?.lastSeenAt).toBe(NOW);
      } finally {
        await personal.close();
      }
      const hidden = deployment({
        storage,
        connectors: [connector],
        activity: activityHistory({
          store: { record: async () => {}, list: async () => ({ events }) },
          readGate: async () => false,
        }),
      });
      try {
        expect((await contract(hidden)).agents[0]?.lastSeenAt).toBeNull();
      } finally {
        await hidden.close();
      }
      const noReader = deployment({
        storage,
        connectors: [connector],
        activity: activityHistory({ store: { record: async () => {} }, readGate: async () => false }),
      });
      try {
        expect((await contract(noReader)).agents[0]?.lastSeenAt).toBeNull();
      } finally {
        await noReader.close();
      }
      await storage.set(agentObservationKeys.agent("assistant"), "2026-10-25T12:00:02.000Z");
      expect((await contract(app)).agents[0]?.lastSeenAt).toBe("2026-10-25T12:00:02.000Z");
    } finally {
      await app.close();
    }
  });

  it.each(["failure", "stall"] as const)(
    "INV-7 INV-10: a %s in admission observation reads stays bounded and returns unknown",
    async (mode) => {
      const storage = memoryStorage();
      const get = storage.get.bind(storage);
      vi.spyOn(storage, "get").mockImplementation((key) =>
        key === agentObservationKeys.agent("assistant")
          ? mode === "stall"
            ? new Promise(() => {})
            : Promise.reject(new Error("private read failure"))
          : get(key),
      );
      const app = deployment({ storage, discovery: { probeTimeoutMs: 20 } });
      try {
        expect((await contract(app)).agents[0]?.lastSeenAt).toBeNull();
      } finally {
        await app.close();
      }
    },
  );

  it("INV-7: cancellation during a stalled observation preserves the original reason and stops dispatch", async () => {
    const storage = memoryStorage();
    const entered = deferred<void>();
    const get = storage.get.bind(storage);
    vi.spyOn(storage, "get").mockImplementation((key) => {
      if (key !== agentObservationKeys.agent("assistant")) return get(key);
      entered.resolve();
      return new Promise(() => {});
    });
    const catalogs = vi.fn(async () => []);
    mockKeys();
    const app = deployment({
      storage,
      connectors: [{ id: "crm", listTools: catalogs, callTool: async () => null }],
      pools: { team: { tools: ["crm"], members: ["agent:assistant"] } },
    });
    const abort = new AbortController();
    const reason = new Error("original request cancellation");
    try {
      const response = app.fetch(request(await workload.token(), "/agent/team", abort.signal));
      const outcome = expect(response).rejects.toBe(reason);
      await entered.promise;
      abort.abort(reason);
      await outcome;
      expect(catalogs).not.toHaveBeenCalled();
      expect(await get(agentObservationKeys.agent("assistant"))).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("review 981: bounded sampled admission observations", () => {
  it.each([true, false])(
    "INV-7 INV-9: stalled observation=%s leaves the shared request permit available before the queue deadline",
    async (stalled) => {
      const storage = memoryStorage();
      const originalGet = storage.get.bind(storage);
      const entered = deferred<void>();
      const get = vi.spyOn(storage, "get").mockImplementation((key) => {
        if (key !== agentObservationKeys.agent("assistant")) return originalGet(key);
        entered.resolve();
        return stalled ? new Promise(() => {}) : originalGet(key);
      });
      mockKeys();
      const dispatch = vi.fn(async () => ({ ok: true }));
      const app = deployment({
        storage,
        connectors: [
          {
            id: "crm",
            staticTools: [{ name: "send", annotations: { readOnlyHint: false } }],
            listTools: async () => [],
            callTool: dispatch,
          },
        ],
        pools: { team: { surface: "native", tools: ["crm"], members: ["agent:assistant"] } },
        discovery: { probeTimeoutMs: 2500 },
        admission: { requests: { concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1000 } },
      });
      try {
        const bearer = await workload.token();
        const started = Date.now();
        const agent = app
          .fetch(
            new Request(request(bearer), {
              method: "POST",
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "crm__send", arguments: {} },
              }),
            }),
          )
          .then(async (response) => {
            await response.text();
            return { status: response.status, elapsedMs: Date.now() - started };
          });
        await entered.promise;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const human = await app.fetch(request("clerk-operator", "/mcp"));
        const humanStatus = human.status;
        await human.text();
        const agentResponse = await agent;
        console.info(
          JSON.stringify({
            stalled,
            humanStatus,
            agentStatus: agentResponse.status,
            agentElapsedMs: agentResponse.elapsedMs,
          }),
        );
        expect(humanStatus).toBe(200);
        expect(agentResponse.status).toBe(200);
        expect(agentResponse.elapsedMs).toBeLessThan(1000);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith(agentObservationKeys.agent("assistant"));
        if (stalled) expect(await originalGet(agentObservationKeys.agent("assistant"))).toBeNull();
        else expect(await originalGet(agentObservationKeys.agent("assistant"))).toMatch(/^\d{4}-/);
      } finally {
        await app.close();
      }
    },
  );

  it.each(["vercel_oidc", "access_token"] as const)(
    "INV-4 INV-6 INV-10: repeated successful %s admissions sample storage once per minute, refreshing at and after 60 seconds",
    async (kind) => {
      // Only wall time is faked: the production request and cancellation timers
      // keep running, while timestamp precision has explicit boundary steps.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
      const storage = memoryStorage();
      mockKeys();
      const app = deployment({
        storage,
        ...(kind === "access_token" ? { agents: ["assistant"], accessTokens: accessTokens(storage) } : {}),
      });
      try {
        const bearer = kind === "vercel_oidc" ? await workload.token() : await issueAgentToken(storage, "assistant");
        const compare = vi.spyOn(storage, "compareAndSet");
        const observations = () =>
          compare.mock.calls.filter(([key]) => key === agentObservationKeys.agent("assistant"));
        const admit = async (offset: number) => {
          vi.setSystemTime(new Date(Date.parse(NOW) + offset));
          const response = await app.fetch(request(bearer));
          expect(response.status).toBe(200);
          await response.text();
        };
        await admit(0);
        expect(observations()).toHaveLength(1);
        for (const offset of [1, 1000, 30_000, 59_999]) await admit(offset);
        expect(observations()).toHaveLength(1);
        expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(NOW);
        expect((await contract(app)).agents[0]?.lastSeenAt).toBe(NOW);
        await admit(60_000);
        expect(observations()).toHaveLength(2);
        const minute = new Date(Date.parse(NOW) + 60_000).toISOString();
        expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(minute);
        await admit(119_999);
        expect(observations()).toHaveLength(2);
        await admit(120_001);
        expect(observations()).toHaveLength(3);
        const latest = new Date(Date.parse(NOW) + 120_001).toISOString();
        expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(latest);
        await runEdge(observeAgentAdmission(storage, "assistant", NOW, 2500));
        expect(observations()).toHaveLength(3);
        expect(await storage.get(agentObservationKeys.agent("assistant"))).toBe(latest);
        expect(JSON.stringify(observations())).not.toContain(bearer);
      } finally {
        await app.close();
      }
    },
  );
});

it.each([2500, 125])(
  "INV-7: observation timeout %i uses the smaller of the probe deadline and 500 ms with native cleanup",
  async (probeMs) => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    let entered = false;
    let closed = false;
    let settled = false;
    registerNativeStorage(storage, {
      get: () =>
        Effect.sync(() => {
          entered = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
        ),
      set: () => Effect.void,
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      compareAndSet: () => Effect.succeed(true),
    });
    const caller = new AbortController();
    const pending = runEdge(observeAgentAdmission(storage, "assistant", NOW, probeMs), { signal: caller.signal }).then(
      () => {
        settled = true;
      },
    );
    const outcome = pending.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(entered).toBe(true);
      const budget = Math.min(probeMs, 500);
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(settled).toBe(false);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(closed).toBe(true);
      expect(settled).toBe(true);
      await pending;
    } finally {
      caller.abort(new Error("test request complete"));
      await outcome;
    }
  },
);
