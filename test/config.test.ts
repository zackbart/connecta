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

type UnsafeCreateConnecta = (
  config: Record<PropertyKey, unknown>,
) => unknown;

const unsafeCreateConnecta =
  createConnecta as unknown as UnsafeCreateConnecta;

const EXPECTED_ALL_MIGRATIONS = [
  "Unsupported v0.6.x ConnectaConfig options. Migrate each path for v0.7.0:",
  "- activity -> activity.store",
  "- activityReadGate -> activity.readGate",
  "- activityDeploymentId -> activity.deploymentId",
  "- credentialEncryptionKey -> credentials.encryptionKey",
  "- toolCacheTtlSeconds -> discovery.catalogTtlSeconds",
  "- persistToolCatalog -> discovery.persistCatalog",
  "- toolCatalogStaleSeconds -> discovery.staleCatalogSeconds",
  "- probeTimeoutMs -> discovery.probeTimeoutMs",
  "- defaultToolTimeoutMs -> calls.defaultTimeoutMs",
  "- maxResultBytes -> calls.maxResultBytes",
].join("\n");

describe("ConnectaConfig v0.7 shape", () => {
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
      maxBatchResultBytes: 456,
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
      activity,
      credentials,
      discovery,
      calls,
      admission,
    };

    const connecta = createConnecta(config);

    expect(connecta.registry.maxResultBytes).toBe(123);
    expect(connecta.registry.maxBatchResultBytes).toBe(456);
  });

  it("rejects malformed admission bounds at construction", () => {
    expect(() =>
      createConnecta({
        connectors: [],
        admission: { requests: { concurrency: 0 } },
      }),
    ).toThrow("concurrency must be a positive whole number");
    expect(() =>
      createConnecta({
        connectors: [],
        admission: { requests: { maxQueueSize: -1 } },
      }),
    ).toThrow("maxQueueSize must be a non-negative whole number");
    expect(() =>
      createConnecta({
        connectors: [],
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
      storage: noPersistenceStorage,
      discovery: { persistCatalog: false },
    });
    await memoryOnly.registry.getTools(
      "memory-only",
      "https://connecta.test",
    );
    expect(await noPersistenceStorage.get("catalog:memory-only")).toBeNull();
  });

  it("aggregates every legacy own path without exposing its values", () => {
    const secret = "must-not-appear";
    let thrown: unknown;
    try {
      unsafeCreateConnecta({
        connectors: [],
        activity: { record() {} },
        activityReadGate: () => true,
        activityDeploymentId: secret,
        credentialEncryptionKey: secret,
        toolCacheTtlSeconds: 1,
        persistToolCatalog: false,
        toolCatalogStaleSeconds: 1,
        probeTimeoutMs: 1,
        defaultToolTimeoutMs: 1,
        maxResultBytes: 1,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(EXPECTED_ALL_MIGRATIONS);
    expect((thrown as Error).message).not.toContain(secret);
  });

  it("rejects an old path even when the new path is also present", () => {
    expect(() =>
      unsafeCreateConnecta({
        connectors: [],
        calls: { maxResultBytes: 100 },
        maxResultBytes: 200,
      }),
    ).toThrow(
      "- maxResultBytes -> calls.maxResultBytes",
    );
  });

  it("rejects removed credential-health config at either path", () => {
    for (const config of [
      { credentialHealth: undefined },
      { credentials: { health: undefined } },
      { credentials: { health: { onRequest: false } } },
    ]) {
      expect(() =>
        unsafeCreateConnecta({ connectors: [], ...config }),
      ).toThrow("removed in issue #179");
      expect(() =>
        unsafeCreateConnecta({ connectors: [], ...config }),
      ).toThrow("ethos.md");
    }
  });

  it("rejects retired toolkit config even when undefined", () => {
    for (const toolkits of [
      undefined,
      {},
      { support: { connectors: ["notes"] } },
    ]) {
      expect(() =>
        unsafeCreateConnecta({ connectors: [], toolkits }),
      ).toThrow("removed in issue #178");
      expect(() =>
        unsafeCreateConnecta({ connectors: [], toolkits }),
      ).toThrow("ethos.md");
    }
  });

  it("ignores inherited legacy names because only own properties are config", () => {
    const config = Object.assign(
      Object.create({ maxResultBytes: 1 }),
      { connectors: [] },
    ) as Record<PropertyKey, unknown>;

    expect(() => unsafeCreateConnecta(config)).not.toThrow();
  });

  it("accepts an explicitly undefined activity group as omitted", () => {
    expect(() =>
      unsafeCreateConnecta({ connectors: [], activity: undefined }),
    ).not.toThrow();
  });

  it("recognizes an old activity store that itself owns `store`", () => {
    class LegacyActivityStore implements ActivityStore {
      store = { backend: true };
      record(): void {}
    }

    expect(() =>
      unsafeCreateConnecta({
        connectors: [],
        activity: new LegacyActivityStore(),
      }),
    ).toThrow("- activity -> activity.store");
  });
});

// Compile-time clean-break coverage. These branches never run, but tsc must
// prove every removed v0.6 path is rejected at the public call site.
// oxlint-disable-next-line no-constant-condition -- This branch exists only for tsc.
if (false) {
  const store: ActivityStore = { record() {} };

  createConnecta({
    connectors: [],
    // @ts-expect-error v0.6 activity stores now belong at activity.store
    activity: store,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    activityReadGate: () => true,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    activityDeploymentId: "test",
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    credentialEncryptionKey: "key",
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.9
    credentialHealth: {},
  });
  createConnecta({
    connectors: [],
    credentials: {
      // @ts-expect-error removed in v0.9
      health: {},
    },
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    toolCacheTtlSeconds: 1,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    persistToolCatalog: false,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    toolCatalogStaleSeconds: 1,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    probeTimeoutMs: 1,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    defaultToolTimeoutMs: 1,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.7
    maxResultBytes: 1,
  });
  createConnecta({
    connectors: [],
    // @ts-expect-error removed in v0.9
    toolkits: {},
  });
}
