import { describe, expect, it } from "vitest";
import {
  createConnecta,
  type ConnectaAdmissionConfig,
  type ConnectaActivityConfig,
  type ConnectaCallsConfig,
  type ConnectaConfig,
  type ConnectaCredentialsConfig,
  type ConnectaDiscoveryConfig,
} from "../src/index.js";
import type { ActivityStore } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";

const executor = { execute: async () => ({ result: null }) };

type UnsafeCreateConnecta = (
  config: Record<PropertyKey, unknown>,
) => unknown;

const unsafeCreateConnecta =
  createConnecta as unknown as UnsafeCreateConnecta;

describe("ConnectaConfig boundary", () => {
  it("accepts all five cohesive config groups", () => {
    const activity: ConnectaActivityConfig = {
      store: { record() {} },
      readGate: () => true,
      deploymentId: "test",
    };
    const credentials: ConnectaCredentialsConfig = {};
    const discovery: ConnectaDiscoveryConfig = {
      concurrency: 4,
      catalogTtlSeconds: 10,
      persistCatalog: false,
      staleCatalogSeconds: 30,
      probeTimeoutMs: 1_000,
    };
    const calls: ConnectaCallsConfig = {
      defaultTimeoutMs: 1_000,
      maxResultBytes: 123,
    };
    const admission: ConnectaAdmissionConfig = {
      requests: {
        concurrency: 4,
        maxQueueSize: 8,
        queueTimeoutMs: 250,
      },
      code: {
        concurrency: 1,
        maxQueueSize: 2,
        queueTimeoutMs: 100,
      },
    };
    const config: ConnectaConfig = {
      connectors: [],
      executor,
      activity,
      credentials,
      discovery,
      calls,
      admission,
    };

    const connecta = createConnecta(config);

    expect(connecta.registry.maxResultBytes).toBe(123);
  });

  it("rejects malformed admission bounds at construction", () => {
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
    expect(catalog.version).toBe(2);
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

  it("rejects an unknown top-level option before reading the config", () => {
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
    ["activity", { store: { record() {} }, typo: true }, "activity.typo"],
    ["credentials", { typo: true }, "credentials.typo"],
    ["accessTokens", { typo: true }, "accessTokens.typo"],
    ["discovery", { typo: true }, "discovery.typo"],
    ["calls", { typo: true }, "calls.typo"],
    ["execute", { typo: true }, "execute.typo"],
    ["admission", { typo: true }, "admission.typo"],
    [
      "admission",
      { requests: { typo: true } },
      "admission.requests.typo",
    ],
    ["admission", { code: { typo: true } }, "admission.code.typo"],
    ["branding", { typo: true }, "branding.typo"],
    [
      "branding",
      { favicon: { typo: true } },
      "branding.favicon.typo",
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
    ["credentials", "health"],
    ["calls", "maxBatchResultBytes"],
  ] as const)("rejects the removed %s.%s option", (group, path) => {
    expect(() =>
      unsafeCreateConnecta({
        connectors: [],
        executor,
        [group]: { [path]: undefined },
      }),
    ).toThrow(`ConnectaConfig.${group}.${path}`);
  });

  it("ignores inherited names because only own properties are config", () => {
    const config = Object.assign(
      Object.create({ maxResultBytes: 1 }),
      { connectors: [], executor },
    ) as Record<PropertyKey, unknown>;

    expect(() => unsafeCreateConnecta(config)).not.toThrow();
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
    ).toThrow("activity.store");
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
    credentials: {
      // @ts-expect-error removed in v0.9
      health: {},
    },
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
}
