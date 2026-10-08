import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { operatorUi } from "../src/ui.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { activityHistory } from "../src/activity.js";
import { describe, expect, it, vi } from "vitest";
import {
  customExecutor,
  createConnecta,
  defineConfig,
  type ConnectaConfig,
} from "../src/index.js";
import type { ActivityStore } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { silentLogger } from "./helpers.js";

const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

type UnsafeCreateConnecta = (
  config: Record<PropertyKey, unknown>,
) => unknown;

const unsafeCreateConnecta =
  createConnecta as unknown as UnsafeCreateConnecta;

describe("ConnectaConfig boundary", () => {
  it("wraps a frozen custom executor without losing private-field receivers or admission", async () => {
    const events: string[] = [];
    class SelfManaged {
      #value = "private";
      readonly name = "self-managed-test";
      async execute() { return { result: this.#value }; }
      async acquire(options?: { signal?: AbortSignal }) {
        events.push(`acquire ${this.#value} ${options?.signal?.aborted}`);
        return { execute: this.execute.bind(this), release: () => events.push("release") };
      }
      admissionSnapshot() {
        events.push(`snapshot ${this.#value}`);
        return { concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1, retryAfterMs: 1,
          active: 0, queued: 0, closed: false,
          totals: { admitted: 0, queued: 0, rejected: 0, cancelled: 0, closed: 0 },
          queueWaitMs: { count: 0, total: 0, max: 0 } };
      }
      close() { events.push(`close ${this.#value}`); }
    }
    const original = Object.freeze(new SelfManaged());
    const wrapped = customExecutor(original, { lifecycle: "self-managed" });
    expect(Object.getOwnPropertySymbols(original)).toEqual([]);
    expect(wrapped.name).toBe(original.name);
    await expect(wrapped.execute("", [])).resolves.toEqual({ result: "private" });
    const lease = await wrapped.acquire({ signal: new AbortController().signal });
    await expect(lease.execute("", [])).resolves.toEqual({ result: "private" });
    lease.release();
    wrapped.admissionSnapshot?.();
    const app = createConnecta({ connectors: [], executor: wrapped, logger: "silent" });
    await app.close();
    expect(events).toEqual(["acquire private false", "release", "snapshot private", "close private"]);
  });

  it("INV-11: requires explicit opt-in for custom executors regardless of constructor or display name", async () => {
    class CustomExecutor {
      readonly name = "DynamicWorkerExecutor";
      async execute() { return { result: null }; }
    }
    class DynamicWorkerExecutor {
      async execute() { return { result: null }; }
    }
    for (const executor of [
      new CustomExecutor(),
      new DynamicWorkerExecutor(),
      { name: "DynamicWorkerExecutor", execute: async () => ({ result: null }) },
      { execute: async () => ({ result: null }), async acquire() {
        return { waitMs: 0, execute: async () => ({ result: null }), release() {} };
      } },
    ]) {
      const construct = () => createConnecta({ connectors: [], executor, logger: "silent" });
      for (const fragment of [
        "ConnectaConfig.executor must declare its lifecycle",
        'import { workerExecutor } from "@zackbart/connecta/worker";',
        "executor: workerExecutor({ loader: env.LOADER })",
        "@zackbart/connecta/quickjs",
        'customExecutor(myExecutor, { lifecycle: "self-managed" })',
      ]) expect(construct).toThrow(fragment);
      const app = createConnecta({ connectors: [], executor: customExecutor(executor, { lifecycle: "self-managed" }), logger: "silent" });
      await app.close();
    }
  });

  it("INV-11: refuses storage without list or compareAndSet, as a Workers KV adapter is", () => {
    // The 0.28 Worker example's Workers KV adapter: no atomic claim.
    const kv = { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] };
    expect(() => unsafeCreateConnecta({ connectors: [], executor, storage: kv }))
      .toThrow(/storage must implement compareAndSet[\s\S]*d1Storage[\s\S]*sqliteStorage[\s\S]*Workers KV is not supported/);
    const { list: _list, ...unlisted } = memoryStorage();
    expect(() => unsafeCreateConnecta({ connectors: [], executor, storage: unlisted }))
      .toThrow("storage must implement list");
  });

  it("validates result stash limits and accepts zero to disable stashing", async () => {
    for (const field of ["maxStashBytes", "maxStashEntries"]) {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "64", null]) {
        expect(() => unsafeCreateConnecta({ connectors: [], executor, results: { [field]: value } }))
          .toThrow(`results.${field}`);
      }
    }
    for (const results of [null, [], 5]) {
      expect(() => unsafeCreateConnecta({ connectors: [], executor, results })).toThrow("results");
    }
    const app = createConnecta({ connectors: [], executor, results: { maxStashBytes: 0, maxStashEntries: 0 } });
    expect(await app.registry.stashResult("disabled", ["body"], 900)).toBe(false);
    await app.close();
  });

  it("warns for every open deployment with connectors, including static API auth", async () => {
    const fetchProvider = vi.fn();
    const connector = api("static_auth", { tools: [{
      name: "read", description: "Read provider data", annotations: { readOnlyHint: true },
      handler: () => fetchProvider("https://provider.example", { headers: { Authorization: "Bearer private" } }),
    }] });
    for (const connectors of [[], [connector], [{ ...connector, credential: { label: "Token" } }]]) {
      for (const auth of [undefined, bearerToken("secret")]) {
        const warn = vi.fn();
        const connecta = createConnecta({ connectors, executor, ...(auth ? { auth } : {}), logger: { ...silentLogger, warn } });
        const warnings = warn.mock.calls.filter(([message]) => String(message).includes("no inbound authentication"));
        expect(warnings).toHaveLength(connectors.length && !auth ? 1 : 0);
        if (connectors[0]?.credential && !auth) expect(warnings[0]?.[0]).toContain("credentials");
        expect(JSON.stringify(warnings)).not.toContain("Bearer private");
        await connecta.close();
      }
    }
  });

  it("validates allowedOrigins as exact HTTP origins or an explicit wildcard", async () => {
    for (const allowedOrigins of [null, true, "https://client.example", ["*"], ["null"], ["https://client.example/"], ["https://user:secret@client.example"], ["file://host"], [42]]) {
      expect(() => unsafeCreateConnecta({ connectors: [], executor, allowedOrigins })).toThrow(/allowedOrigins/);
    }
    for (const allowedOrigins of [[], ["https://client.example", "http://localhost:1234"], "*" as const]) {
      const connecta = createConnecta({ connectors: [], executor, allowedOrigins });
      await connecta.close();
    }
  });

  it("accepts every declared closed option", () => {
    const config: ConnectaConfig = {
      connectors: [],
      auth: fakeClerkAuth(),
      identity: {
        connectorAccess: () => "all",
        activityAccess: () => true,
      },
      storage: memoryStorage(),
      publicUrl: "https://connecta.test",
      executor,
      activity: activityHistory({
        store: { record() {} },
        readGate: () => true,
        deploymentId: "test",
      }),
      vault: encryptedCredentialVault(memoryStorage(), "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
      discovery: {
        concurrency: 4,
        catalogTtlSeconds: 10,
        persistCatalog: false,
        staleCatalogSeconds: 30,
        probeTimeoutMs: 1_000,
      },
      calls: {
        defaultTimeoutMs: 1_000,
        maxResultBytes: 123,
      },
      execute: {
        maxEmittedBytes: 1_000,
        maxEmittedBlocks: 2,
        maxHostCalls: 5,
        hostCallTimeoutMs: 2_000,
      },
      admission: {
        requests: {
          concurrency: 4,
          maxQueueSize: 8,
          queueTimeoutMs: 250,
          retryAfterMs: 25,
        },
        code: {
          concurrency: 1,
          maxQueueSize: 2,
          queueTimeoutMs: 100,
          retryAfterMs: 10,
        },
      },
      ui: operatorUi({ branding: {
        productName: "Connecta test",
        productUrl: "https://connecta.test",
        ownerName: "Test owner",
        ownerUrl: "https://owner.connecta.test",
        description: "Config boundary test",
        pageTitle: "Connecta test page",
        favicon: {
          svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" />",
          ico: new Uint8Array([0]),
          href: "/favicon.svg",
        },
        themeColor: "#ffffff",
      } }),
      logger: silentLogger,
      serverInfo: {
        name: "connecta-test",
        version: "1.0.0",
        title: "Connecta test",
        websiteUrl: "https://connecta.test",
        icons: [
          {
            src: "https://connecta.test/icon.svg",
            mimeType: "image/svg+xml",
            sizes: ["any"],
          },
        ],
      },
      deploymentInfo: { fixture: true },
    };

    const connecta = createConnecta(config);

    expect(connecta.registry.maxResultBytes).toBe(123);
  });

  it("INV-11: rejects malformed admission bounds at construction", () => {
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        admission: { requests: { concurrency: 0 } },
      }),
    ).toThrow("concurrency must be a positive whole number");
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        admission: { requests: { maxQueueSize: -1 } },
      }),
    ).toThrow("maxQueueSize must be a non-negative whole number");
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        admission: { code: { queueTimeoutMs: Number.NaN } },
      }),
    ).toThrow("queueTimeoutMs must be a positive whole number");
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        admission: { requests: { maxDurationMs: 0 } },
      }),
    ).toThrow("maxDurationMs must be a positive whole number");
    expect(() =>
      createConnecta({
        connectors: [],
        executor,
        admission: { requests: { maxDurationMs: 3_000_000_000 } },
      }),
    ).toThrow("maxDurationMs must be at most 2,147,483,647 milliseconds");
  });

  it("forwards catalog freshness and persistence settings at the boundary", async () => {
    const storage = memoryStorage();
    const connector: Connector = {
      id: "catalog",
      kind: "mcp",
      async listTools() {
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const persisted = createConnecta({
      connectors: [connector],
      executor,
      storage,
      discovery: {
        catalogTtlSeconds: 10,
        persistCatalog: true,
        staleCatalogSeconds: 30,
      },
    });

    await persisted.registry.getTools("catalog", "https://connecta.test");
    const raw = await storage.get("catalog:catalog");
    expect(raw).toBeTruthy();
    const catalog = JSON.parse(raw!) as {
      version: number;
      chunkCount: number;
      fetchedAt: number;
      expiresAt: number;
      staleUntil: number;
    };
    expect(catalog.version).toBe(3);
    expect(catalog.chunkCount).toBe(1);
    expect(catalog.expiresAt - catalog.fetchedAt).toBe(10_000);
    expect(catalog.staleUntil - catalog.expiresAt).toBe(30_000);

    const noPersistenceStorage = memoryStorage();
    const memoryOnly = createConnecta({
      connectors: [{ ...connector, id: "memory-only" }],
      executor,
      storage: noPersistenceStorage,
      discovery: { persistCatalog: false },
    });
    await memoryOnly.registry.getTools(
      "memory-only",
      "https://connecta.test",
    );
    expect(await noPersistenceStorage.get("catalog:memory-only")).toBeNull();
  });

  it("INV-11: rejects an unknown top-level option before reading the config", () => {
    const secret = "must-not-appear";
    let connectorsRead = false;
    const config = { typo: secret } as Record<PropertyKey, unknown>;
    Object.defineProperty(config, "connectors", {
      enumerable: true,
      get() {
        connectorsRead = true;
        return [];
      },
    });

    expect(() => unsafeCreateConnecta(config)).toThrow(
      "ConnectaConfig.typo",
    );
    expect(() => unsafeCreateConnecta(config)).not.toThrow(secret);
    expect(connectorsRead).toBe(false);
  });

  it.each([
    ["activity", { store: { record() {} }, typo: true }, "activity must be created"],
    ["identity", { typo: true }, "identity.typo"],
    ["credentials", { typo: true }, "credentials"],
    ["accessTokens", { typo: true }, "accessTokens"],
    ["discovery", { typo: true }, "discovery.typo"],
    ["calls", { typo: true }, "calls.typo"],
    ["results", { typo: true }, "results.typo"],
    ["execute", { typo: true }, "execute.typo"],
    ["admission", { typo: true }, "admission.typo"],
    [
      "admission",
      { requests: { typo: true } },
      "admission.requests.typo",
    ],
    ["admission", { code: { typo: true } }, "admission.code.typo"],
    ["admission", { code: { maxDurationMs: 2_000 } }, "admission.code.maxDurationMs"],
    ["branding", { typo: true }, "branding"],
    [
      "branding",
      { favicon: { typo: true } },
      "branding",
    ],
    ["serverInfo", { typo: true }, "serverInfo.typo"],
    [
      "serverInfo",
      { icons: [{ src: "/icon.svg", typo: true }] },
      "serverInfo.icons[0].typo",
    ],
  ] as const)("rejects an unknown %s option", (group, value, path) => {
    expect(() =>
      unsafeCreateConnecta({
        connectors: [],
        executor,
        [group]: value,
      }),
    ).toThrow(`ConnectaConfig.${path}`);
  });

  it.each([
    ["toolkits", { support: { connectors: ["notes"] } }],
    ["credentialHealth", undefined],
    ["surface", "classic"],
    ["maxResultBytes", 1],
  ] as const)("rejects the removed top-level %s option", (path, value) => {
    expect(() =>
      unsafeCreateConnecta({ connectors: [], executor, [path]: value }),
    ).toThrow(`ConnectaConfig.${path}`);
  });

  it.each([
    ["credentials", ""],
    ["calls", "maxBatchResultBytes"],
  ] as const)("rejects the removed %s.%s option", (group, path) => {
    expect(() =>
      unsafeCreateConnecta({
        connectors: [],
        executor,
        [group]: { [path]: undefined },
      }),
    ).toThrow(`ConnectaConfig.${group}${path ? `.${path}` : ""}`);
  });

  it("ignores inherited names because only own properties are config", () => {
    // A root prototype stands in for a polluted Object.prototype: plain, but
    // carrying a name that is not configuration.
    const root = Object.create(null, { maxResultBytes: { value: 1, enumerable: true } }) as object;
    const config = Object.assign(Object.create(root), { connectors: [], executor }) as Record<PropertyKey, unknown>;

    expect(() => unsafeCreateConnecta(config)).not.toThrow();
  });

  it("INV-11: refuses an array or a class instance where plain configuration belongs", () => {
    const derived = Object.assign(Object.create({ maxResultBytes: 1 }), { connectors: [], executor }) as Record<PropertyKey, unknown>;
    expect(() => unsafeCreateConnecta(derived)).toThrow("ConnectaConfig must be a plain object.");
    expect(() => unsafeCreateConnecta({ connectors: [], executor, discovery: [] }))
      .toThrow("ConnectaConfig.discovery must be an object.");
    expect(() => unsafeCreateConnecta({ connectors: [], executor, pools: [] }))
      .toThrow("ConnectaConfig.pools must be an object.");
    expect(() => unsafeCreateConnecta({ connectors: [], executor, classification: new Map() }))
      .toThrow("ConnectaConfig.classification must be a plain object.");
  });

  it("accepts an explicitly undefined activity group as omitted", () => {
    expect(() =>
      unsafeCreateConnecta({ connectors: [], executor, activity: undefined }),
    ).not.toThrow();
  });

  it("rejects an old activity store whose nested store is not an activity store", () => {
    class LegacyActivityStore implements ActivityStore {
      store = { backend: true };
      record(): void {}
    }

    expect(() =>
      unsafeCreateConnecta({
        connectors: [],
        executor,
        activity: new LegacyActivityStore(),
      }),
    ).toThrow("activity must be created");
  });
});

describe("ConnectaConfig schema", () => {
  // Every numeric limit, the smallest value it accepts, and a sample of the
  // values that once warned and fell back. One policy: they now throw.
  const LIMITS = [
    ["discovery", "concurrency", 1],
    ["discovery", "probeTimeoutMs", 1],
    ["calls", "defaultTimeoutMs", 1],
    ["calls", "maxResultBytes", 1],
    ["results", "maxStashBytes", 0],
    ["results", "maxStashEntries", 0],
    ["execute", "maxEmittedBytes", 1],
    ["execute", "maxEmittedBlocks", 1],
    ["execute", "maxHostCalls", 1],
    ["execute", "hostCallTimeoutMs", 1],
    ["execute", "watchdogMs", 1],
    ["execute", "maxWrites", 1],
  ] as const;

  it.each(LIMITS)("INV-11: refuses an unusable %s.%s at construction", async (group, key, min) => {
    for (const value of [min - 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
      expect(
        () => unsafeCreateConnecta({ connectors: [], executor, [group]: { [key]: value } }),
        `${group}.${key} = ${String(value)}`,
      ).toThrow(`ConnectaConfig.${group}.${key} must be a`);
    }
    const accepted = createConnecta({ connectors: [], executor, logger: "silent", [group]: { [key]: min } });
    expect(accepted.describeConfig().limits[group]).toHaveProperty(key, { value: min, source: "config" });
    await accepted.close();
  });

  it.each([
    ["discovery", { catalogTtlSeconds: -1 }, "discovery.catalogTtlSeconds must be a non-negative number of seconds"],
    ["discovery", { persistCatalog: "yes" }, "discovery.persistCatalog must be true or false"],
    ["discovery", null, "ConnectaConfig.discovery must be an object"],
    ["serverInfo", { name: 42 }, "serverInfo.name must be a string"],
    ["serverInfo", { icons: [{ mimeType: "image/png" }] }, "serverInfo.icons[0].src is required"],
    ["storage", { get() {} }, "ConnectaConfig.storage must implement set and delete and list and compareAndSet"],
    ["logger", "quiet", 'ConnectaConfig.logger must be a Logger or "silent"'],
    ["auth", [{ kind: "bearer" }], "ConnectaConfig.auth[0] must be an inbound auth adapter"],
    ["publicUrl", "connecta.example", "ConnectaConfig.publicUrl must be an absolute http(s) URL"],
    ["publicUrl", "https://user:pass@connecta.example", "without credentials"],
    ["identity", { connectorAccess: "all" }, "ConnectaConfig.identity.connectorAccess must be a function"],
    ["pools", { support: { grant: () => true } }, "ConnectaConfig.pools.support.tools is required"],
    ["pools", { support: { tools: ["x"], grant: true } }, "ConnectaConfig.pools.support.grant must be a function"],
    ["deploymentInfo", "v1", "ConnectaConfig.deploymentInfo must be an object"],
  ] as const)("INV-11: refuses a wrong %s value with its path", (key, value, message) => {
    expect(() => unsafeCreateConnecta({ connectors: [], executor, [key]: value })).toThrow(message);
  });

  it("INV-11: refuses a connector that is not a Connector, by index", () => {
    expect(() => unsafeCreateConnecta({ connectors: [{ id: "x" }], executor })).toThrow(
      "ConnectaConfig.connectors[0] must be a Connector",
    );
    expect(() => unsafeCreateConnecta({ executor })).toThrow("ConnectaConfig.connectors is required");
  });

  it("treats an explicitly undefined optional value as omitted, at every depth", async () => {
    const connecta = createConnecta({
      connectors: [],
      executor,
      logger: "silent",
      vault: undefined,
      discovery: { concurrency: undefined },
      execute: undefined,
      admission: { requests: { maxDurationMs: undefined } },
    });
    const limits = connecta.describeConfig().limits;
    expect(limits.discovery.concurrency).toEqual({ value: 4, source: "default" });
    expect(limits.requests.maxDurationMs).toEqual({ value: 300_000, source: "default" });
    await connecta.close();
  });

  it("defineConfig returns the factory unchanged and runs nothing at definition", async () => {
    let calls = 0;
    const factory = (env: { TOKEN?: string }): ConnectaConfig => {
      calls += 1;
      return { connectors: [], executor, logger: "silent", deploymentInfo: { token: env.TOKEN } };
    };
    const config = defineConfig(factory);
    expect(config).toBe(factory);
    expect(calls).toBe(0);
    const connecta = createConnecta(config({ TOKEN: "t" }));
    expect(calls).toBe(1);
    await connecta.close();
  });
});

// Compile-time clean-break coverage. These branches never run, but tsc must
// prove every removed v0.6 path is rejected at the public call site.
// oxlint-disable-next-line no-constant-condition -- This branch exists only for tsc.
if (false) {
  const store: ActivityStore = { record() {} };

  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error v0.6 activity stores now belong at activity.store
    activity: store,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    activityReadGate: () => true,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    activityDeploymentId: "test",
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    credentialEncryptionKey: "key",
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.9
    credentialHealth: {},
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed modular configuration
    credentials: { health: {} },
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    toolCacheTtlSeconds: 1,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    persistToolCatalog: false,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    toolCatalogStaleSeconds: 1,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    probeTimeoutMs: 1,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    defaultToolTimeoutMs: 1,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.7
    maxResultBytes: 1,
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error removed in v0.9
    toolkits: {},
  });
  // The schema-derived type keeps every check a hand-written interface had.
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error unknown nested option
    discovery: { concurrncy: 2 },
  });
  createConnecta({
    connectors: [],
    executor,
    // @ts-expect-error wrong value type
    execute: { maxHostCalls: "20" },
  });
  // @ts-expect-error executor is required
  createConnecta({ connectors: [] });
  // Optional modules may be wired conditionally, including under
  // exactOptionalPropertyTypes.
  createConnecta({
    connectors: [],
    executor,
    vault: undefined,
    activity: Math.random() > 1 ? undefined : undefined,
  });
}

describe("ConnectaConfig accessors and keyed maps", () => {
  const SECRET = "SENTINEL-getter-text";
  /** A property whose getter counts its calls and throws the sentinel. */
  function trap(target: object, key: string, calls: { count: number }) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        calls.count += 1;
        throw new Error(SECRET);
      },
    });
    return target;
  }

  it.each([
    ["a top-level option", (calls: { count: number }) =>
      trap({ connectors: [], executor }, "discovery", calls), "ConnectaConfig.discovery"],
    ["a nested limit", (calls: { count: number }) =>
      ({ connectors: [], executor, discovery: trap({}, "concurrency", calls) }), "ConnectaConfig.discovery.concurrency"],
    ["a pool", (calls: { count: number }) =>
      ({ connectors: [], executor, pools: trap({}, "support", calls) }), "ConnectaConfig.pools.support"],
    ["a classification entry", (calls: { count: number }) =>
      ({ connectors: [], executor, classification: trap({}, "notes", calls) }),
    "ConnectaConfig.classification.notes"],
    ["a connector slot", (calls: { count: number }) =>
      ({ connectors: trap([], "0", calls), executor }), "ConnectaConfig.connectors[0]"],
    ["an icon", (calls: { count: number }) =>
      ({ connectors: [], executor, serverInfo: { icons: [trap({}, "src", calls)] } }),
    "ConnectaConfig.serverInfo.icons[0].src"],
    // Opaque arrays are still plain arrays: their items are read by descriptor.
    ["an allowed origin", (calls: { count: number }) =>
      ({ connectors: [], executor, allowedOrigins: trap([], "0", calls) }), "ConnectaConfig.allowedOrigins[0]"],
    ["an inbound auth slot", (calls: { count: number }) =>
      ({ connectors: [], executor, auth: trap([], "0", calls) }), "ConnectaConfig.auth[0]"],
    ["a pool's tools", (calls: { count: number }) =>
      ({ connectors: [], executor, pools: { support: { tools: trap([], "0", calls) } } }),
    "ConnectaConfig.pools.support.tools[0]"],
  ] as const)("INV-11: refuses an accessor on %s by path, without running it", (_, build, path) => {
    const calls = { count: 0 };
    const config = build(calls) as Record<PropertyKey, unknown>;
    let error: unknown;
    try {
      unsafeCreateConnecta(config);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(`${path} must be a plain value, not a getter or setter.`);
    expect(String(error)).not.toContain(SECRET);
    expect(calls.count).toBe(0);
  });

  it("INV-11: reports an unknown key beside an accessor without running the accessor", () => {
    const calls = { count: 0 };
    const config = trap({ connectors: [], executor, discovery: { concurrncy: 2 } }, "calls", calls);
    expect(() => unsafeCreateConnecta(config as Record<PropertyKey, unknown>))
      .toThrow("ConnectaConfig.discovery.concurrncy");
    expect(calls.count).toBe(0);
  });

  it("INV-11: refuses a config object whose inspection throws, without echoing the trap", () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error(SECRET);
      },
    });
    let error: unknown;
    try {
      unsafeCreateConnecta({ connectors: [], executor, discovery: hostile });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("ConnectaConfig.discovery could not be read as plain configuration.");
    expect(String(error)).not.toContain(SECRET);
  });

  it("INV-11: resolves a root Proxy from its descriptors, so its get trap never runs", async () => {
    let gets = 0;
    const config = new Proxy({ connectors: [], executor, logger: "silent", discovery: { concurrency: 1 } }, {
      get() {
        gets += 1;
        throw new Error(SECRET);
      },
      has() {
        throw new Error(SECRET);
      },
    });
    const app = createConnecta(config as never);
    try {
      expect(app.describeConfig().limits.discovery.concurrency).toEqual({ value: 1, source: "config" });
      expect(JSON.stringify(app.describeConfig())).not.toContain(SECRET);
    } finally {
      await app.close();
    }
    expect(gets).toBe(0);
  });

  it("INV-11: refuses a root config whose inspection throws, by path and without the trap's text", () => {
    const revocable = Proxy.revocable({ connectors: [], executor }, {});
    revocable.revoke();
    for (const config of [
      new Proxy({ connectors: [], executor }, { ownKeys() { throw new Error(SECRET); } }),
      new Proxy({ connectors: [], executor }, { getOwnPropertyDescriptor() { throw new Error(SECRET); } }),
      revocable.proxy,
      { connectors: new Proxy([], { ownKeys() { throw new Error(SECRET); } }), executor },
    ]) {
      let error: unknown;
      try {
        unsafeCreateConnecta(config);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toMatch(/ConnectaConfig(\.connectors)? could not be read as plain configuration\./);
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("passes connectors, modules, storage, and loggers through without inspecting their accessors", async () => {
    let titleReads = 0;
    const connector = {
      id: "notes",
      listTools: async () => [],
      callTool: async () => null,
      get title() {
        titleReads += 1;
        return "Notes";
      },
    } as Connector;
    const storage = memoryStorage();
    const logger = Object.defineProperty(
      { debug() {}, info() {}, warn() {}, error() {} },
      "level",
      { enumerable: true, get: () => "info" },
    );
    const app = createConnecta({ connectors: [connector], executor, storage, logger });
    expect(app.describeConfig().connectors[0]?.title).toBe("Notes");
    expect(titleReads).toBeGreaterThan(0);
    await app.close();
  });

  it("INV-11: keeps __proto__, constructor, and prototype as ordinary pool names", async () => {
    const grant = () => true;
    const pools = {
      ["__proto__"]: { tools: ["notes"], grant },
      constructor: { tools: ["notes"], grant },
      prototype: { tools: ["notes"], grant },
    };
    expect(Object.keys(pools)).toEqual(["__proto__", "constructor", "prototype"]);
    const notes: Connector = { id: "notes", listTools: async () => [], callTool: async () => null };
    const app = createConnecta({ connectors: [notes], executor, logger: "silent", pools });
    expect(app.describeConfig().pools.map((pool) => pool.name).sort())
      .toEqual(["__proto__", "constructor", "prototype"]);
    await app.close();

    // An undeclared name stays undeclared: a resolved map inherits nothing.
    const { resolveConfig } = await import("../src/config.js");
    const resolved = resolveConfig({ connectors: [notes], executor, pools: { support: { tools: ["notes"] } } });
    expect(Object.getPrototypeOf(resolved.pools)).toBeNull();
    expect(resolved.pools?.["constructor"]).toBeUndefined();
    expect(resolved.pools?.["toString"]).toBeUndefined();
  });

  it("INV-11: keeps a __proto__ classification key as an ordinary entry", async () => {
    const { resolveConfig } = await import("../src/config.js");
    const resolved = resolveConfig({
      connectors: [],
      executor,
      classification: { ["__proto__"]: { read: "read" }, constructor: { write: "write" as const } },
    });
    expect(Object.entries(resolved.classification ?? {})).toEqual([
      ["__proto__", { read: "read" }],
      ["constructor", { write: "write" }],
    ]);
  });
});
