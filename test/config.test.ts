import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { operatorUi } from "../src/ui.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { activityHistory } from "../src/activity.js";
import { describe, expect, it, vi } from "vitest";
import {
  createConnecta,
  type ConnectaConfig,
} from "../src/index.js";
import type { ActivityStore } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { silentLogger } from "./helpers.js";

const executor = { execute: async () => ({ result: null }) };

type UnsafeCreateConnecta = (
  config: Record<PropertyKey, unknown>,
) => unknown;

const unsafeCreateConnecta =
  createConnecta as unknown as UnsafeCreateConnecta;

describe("ConnectaConfig boundary", () => {
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
    expect(await app.registry.stashResult("result:disabled", "body", 900)).toBe(false);
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
    ).toThrow("activity must be created");
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
}
