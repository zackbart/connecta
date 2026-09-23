// The per-Connecta runtime and the services it provides (P1-S05).
//
// test/config.test.ts, test/optional-modules.test.ts,
// test/startup-warnings.test.ts, and test/activity.test.ts pin construction
// and the modules unchanged through the Promise surface; this suite pins what
// only an Effect program sees — which values each service holds, that an
// omitted activity module records nothing, that creating the runtime builds
// nothing, and that close() disposes it last.

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityHistory } from "../src/activity.js";
import type { CatalogDriftActivityEvent, ToolCallActivityEvent } from "../src/activity.js";
import { bearerToken } from "../src/auth/bearer.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { createConnecta, type Connecta, type ConnectaConfig } from "../src/index.js";
import { runEdge } from "../src/runtime/run.js";
import {
  ActivityRecorder,
  coreRuntime,
  DeferredWork,
  Logger,
  ResolvedConfig,
  Storage,
  Vault,
  type CoreServices,
} from "../src/runtime/services.js";
import { memoryStorage } from "../src/storage/memory.js";
import { CONNECTA_VERSION } from "../src/version.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const executor = { execute: async () => ({ result: null }) };
const KEY = btoa("k".repeat(32));

function connecta(config: Partial<ConnectaConfig> = {}): Connecta {
  return createConnecta({ connectors: [], executor, logger: "silent", ...config });
}

function run<A>(app: Connecta, effect: Effect.Effect<A, never, CoreServices>): Promise<A> {
  return runEdge(effect, { runtime: required(coreRuntime(app.registry)) });
}

const TOOL_CALL = {
  connectorId: "notion",
  toolName: "search",
  address: "notion.search",
  source: "call_tool",
  outcome: "success",
  durationMs: 12,
  attempts: 1,
} as const;
const REQUEST = { actor: { kind: "bearer" }, requestId: "request-1" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("core services", () => {
  it("provides the configured storage, vault, and logger as the same objects", async () => {
    const storage = memoryStorage();
    const vault = encryptedCredentialVault(storage, KEY);
    const logger = { ...silentLogger };
    const app = connecta({ storage, vault, logger });
    const seen = await run(app, Effect.all([Storage, Vault, Logger]));
    expect(seen[0]).toBe(storage);
    expect(seen[0].compareAndSet).toBe(storage.compareAndSet);
    expect(seen[1]).toBe(vault);
    expect(seen[2]).toBe(logger);
    await app.close();
  });

  it("stands memory storage in for omitted storage and leaves an omitted vault absent", async () => {
    const app = connecta();
    const [storage, vault] = await run(app, Effect.all([Storage, Vault]));
    await storage.set("k", "v");
    expect(await storage.get("k")).toBe("v");
    expect(typeof storage.compareAndSet).toBe("function");
    expect(vault).toBeUndefined();
    await app.close();
  });

  it('keeps "silent" silent and prefixes the default console logger', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const silent = connecta();
    (await run(silent, Logger)).warn("quiet");
    expect(warn).not.toHaveBeenCalled();
    const loud = createConnecta({ connectors: [], executor });
    (await run(loud, Logger)).warn("heard", 1);
    expect(warn).toHaveBeenCalledWith("[connecta]", "heard", 1);
    await Promise.all([silent.close(), loud.close()]);
  });

  it("resolves the configuration once, at construction", async () => {
    const connectors = [{
      id: "calc",
      staticTools: [{ name: "add", description: "Add", inputSchema: { type: "object" } }],
      listTools: async () => [],
      callTool: async () => null,
    }];
    const clerk = fakeClerkAuth();
    const bearer = bearerToken("secret");
    const named = Object.assign(
      { execute: async () => ({ result: null }) },
      { name: "sandbox" },
    );
    const config: ConnectaConfig = {
      connectors,
      executor: named,
      logger: "silent",
      auth: [clerk, bearer],
      pools: { math: { tools: ["calc.add"] } },
      serverInfo: { title: "Tools" },
    };
    const app = createConnecta(config);
    const resolved = await run(app, ResolvedConfig);
    expect(resolved.config).toBe(config);
    expect(resolved.serverInfo).toEqual({ title: "Tools", name: "connecta", version: CONNECTA_VERSION });
    expect(resolved.auth).toEqual([bearer, clerk]);
    expect([...resolved.pools.keys()]).toEqual(["math"]);
    expect(resolved.executorName).toBe("sandbox");
    await app.close();
  });
});

describe("ActivityRecorder", () => {
  it("records nothing and builds no event when the activity module is omitted", async () => {
    const app = connecta();
    const recorder = await run(app, ActivityRecorder);
    expect(recorder.enabled).toBe(false);
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    await runEdge(recorder.recordTool(REQUEST, TOOL_CALL));
    await runEdge(recorder.recordDrift({
      connectorId: "notion", unclassifiedTools: 1, unservedTools: 0, annotationConflicts: 0, schemaChanges: 0,
    }));
    expect(randomUUID).not.toHaveBeenCalled();
    await app.close();
  });

  it("records payload-free tool calls and drift through the configured module", async () => {
    const events: ToolCallActivityEvent[] = [];
    const drift: CatalogDriftActivityEvent[] = [];
    const activity = activityHistory({
      store: { record: (event) => { events.push(event); }, recordCatalogDrift: (event) => { drift.push(event); } },
      deploymentId: "prod",
    });
    const app = connecta({ activity, serverInfo: { name: "hub", version: "9" } });
    const recorder = await run(app, ActivityRecorder);
    expect(recorder.enabled).toBe(true);
    await runEdge(recorder.recordTool(REQUEST, TOOL_CALL));
    await runEdge(recorder.recordDrift({
      connectorId: "notion", unclassifiedTools: 1, unservedTools: 0, annotationConflicts: 0, schemaChanges: 0,
    }));
    expect(events).toEqual([expect.objectContaining({
      ...TOOL_CALL,
      requestId: "request-1",
      actor: { kind: "bearer" },
      serverName: "hub",
      serverVersion: "9",
      deploymentId: "prod",
    })]);
    expect(drift).toEqual([expect.objectContaining({
      connectorId: "notion", unclassifiedTools: 1, serverName: "hub", deploymentId: "prod",
    })]);
    await app.close();
  });

  it("hands a pending write to the request's DeferredWork and logs its failure", async () => {
    const warn = vi.fn();
    const activity = activityHistory({
      store: { record: async () => { throw new Error("D1 unavailable"); } },
    });
    const app = connecta({ activity, logger: { ...silentLogger, warn } });
    const recorder = await run(app, ActivityRecorder);
    const deferred: Promise<unknown>[] = [];
    await runEdge(recorder.recordTool(REQUEST, TOOL_CALL).pipe(
      Effect.provideService(DeferredWork, (promise) => { deferred.push(promise); }),
    ));
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(warn).toHaveBeenCalledWith("[connecta] activity record failed", expect.any(Error));
    await app.close();
  });

  it("never fails the work it describes, even when a custom recorder throws", async () => {
    const warn = vi.fn();
    const activity = {
      ...activityHistory({ store: { record: () => {} } }),
      recordTool: () => { throw new Error("recorder bug"); },
    };
    const app = connecta({ activity, logger: { ...silentLogger, warn } });
    const recorder = await run(app, ActivityRecorder);
    await expect(runEdge(recorder.recordTool(REQUEST, TOOL_CALL))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[connecta] activity record failed", expect.any(Error));
    await app.close();
  });
});

describe("DeferredWork", () => {
  it("is absent outside a request and whatever the request provides inside one", async () => {
    expect(await runEdge(DeferredWork)).toBeUndefined();
    const hook = () => {};
    expect(await runEdge(DeferredWork.pipe(Effect.provideService(DeferredWork, hook)))).toBe(hook);
  });
});

describe("the per-Connecta runtime", () => {
  it("builds nothing at construction and builds once, on first use", async () => {
    const app = connecta();
    const runtime = required(coreRuntime(app.registry));
    expect(runtime.cachedContext).toBeUndefined();
    const [first, second] = await Promise.all([run(app, Storage), run(app, Storage)]);
    expect(first).toBe(second);
    expect(runtime.cachedContext).toBeDefined();
    await app.close();
  });

  it("builds under fake timers, on the edge scheduler", async () => {
    vi.useFakeTimers();
    const app = connecta();
    await expect(run(app, Vault)).resolves.toBeUndefined();
    await app.close();
  });

  it("belongs to the Connecta only: a registry built directly has none", () => {
    expect(coreRuntime(makeRegistry([]))).toBeUndefined();
  });

  it("is disposed after the executor closes, once, and refuses runs afterwards", async () => {
    const order: string[] = [];
    let app!: Connecta;
    const closing = {
      execute: async () => ({ result: null }),
      close: vi.fn(async () => {
        order.push("executor");
        // Still serving while the executor closes.
        order.push(`storage ${typeof (await run(app, Storage)).get}`);
      }),
    };
    app = connecta({ executor: closing });
    await Promise.all([app.close(), app.close()]);
    await app.close();
    expect(closing.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["executor", "storage function"]);
    await expect(run(app, Storage)).rejects.toThrow("This Connecta has been closed.");
  });

  it("leaves a run already in flight its services", async () => {
    const storage = memoryStorage();
    const app = connecta({ storage });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const inFlight = run(app, Effect.promise(() => gate).pipe(Effect.andThen(Storage)));
    await app.close();
    open();
    await expect(inFlight).resolves.toBe(storage);
  });

  it("is disposed even when the executor's close rejects", async () => {
    const failure = new Error("executor close failed");
    const app = connecta({
      executor: { execute: async () => ({ result: null }), close: async () => { throw failure; } },
    });
    await expect(app.close()).rejects.toBe(failure);
    await expect(app.close()).rejects.toBe(failure);
    await expect(run(app, Storage)).rejects.toThrow("This Connecta has been closed.");
  });

  it("disposes cleanly when nothing ever used it", async () => {
    const app = connecta();
    await app.close();
    expect(required(coreRuntime(app.registry)).cachedContext).toBeUndefined();
  });
});
