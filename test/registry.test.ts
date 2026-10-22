import { describe, expect, it, vi } from "vitest";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "../src/catalog-limits.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, KVStorage, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { calcConnector, makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

describe("Registry construction", () => {
  it("rejects invalid connector ids", () => {
    const bad: Connector = { ...calcConnector, id: "Bad.Id" };
    expect(() => makeRegistry([bad])).toThrow(/Invalid connector id/);
  });

  it("rejects duplicate connector ids", () => {
    expect(() => makeRegistry([calcConnector, { ...calcConnector }])).toThrow(/Duplicate connector id/);
  });
});

describe("personal OAuth handoffs", () => {
  it("consumes only the expected principal once", async () => {
    const storage = memoryStorage();
    const registry = new Registry([calcConnector], { storage, logger: silentLogger });
    await registry.storeOAuthHandoff("calc", "state", "alice");
    expect(await registry.consumeOAuthHandoff("calc", null, "alice")).toBe(false);
    expect(await registry.consumeOAuthHandoff("calc", "state", "bob")).toBe(false);
    expect((await registry.oauthCallbackView("calc", "state"))?.principalKey).toBe("alice");
    expect(await registry.consumeOAuthHandoff("calc", "state", "alice")).toBe(true);
    expect(await registry.consumeOAuthHandoff("calc", "state", "alice")).toBe(false);
    expect(await registry.oauthCallbackView("calc", "state")).toBeNull();
  });

  it("refuses concurrent reuse of one state by different owners", async () => {
    const backing = memoryStorage();
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage: KVStorage = {
      ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key.startsWith("oauth-handoff:") && reads < 2) {
          if (++reads === 2) release();
          await bothRead;
        }
        return value;
      },
    };
    const registry = new Registry([{ ...calcConnector, authScope: "personal" }], {
      storage,
      logger: silentLogger,
    });
    const results = await Promise.allSettled([
      registry.storeOAuthHandoff("calc", "reused-state", "alice"),
      registry.storeOAuthHandoff("calc", "reused-state", "bob"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.message).toContain("reused one OAuth state across principals");
    const winner = results[0]?.status === "fulfilled" ? "alice" : "bob";
    expect((await registry.oauthCallbackView("calc", "reused-state"))?.principalKey).toBe(winner);
    await registry.storeOAuthHandoff("calc", "reused-state", winner);
    expect((await registry.oauthCallbackView("calc", "reused-state"))?.principalKey).toBe(winner);
  });
});

describe("request-local catalogs", () => {
  it("removes a failed request-local load so the same request can retry", async () => {
    let catalogLoads = 0;
    const connector: Connector = connectorWith({
      id: "retry_load",
      kind: "mcp",
      tools: async () => {
        catalogLoads++;
        if (catalogLoads === 1) throw new Error("temporary failure");
        return [{ name: "read" }];
      },
      call: async () => null,
    });
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger: silentLogger,
    });
    const scope = {};
    await expect(registry.getTools("retry_load", BASE, scope)).rejects.toThrow("temporary failure");
    await expect(registry.getTools("retry_load", BASE, scope)).resolves.toMatchObject([{ name: "read" }]);
    expect(catalogLoads).toBe(2);
  });
  it("refuses complete catalogs over the tool or serialized-byte ceiling", async () => {
    const tooMany: Connector = connectorWith({
      id: "too_many",
      kind: "mcp",
      tools: Array(MAX_CATALOG_TOOLS + 1).fill({ name: "same" }) as ToolDef[],
      call: async () => null,
    });
    const tooLarge: Connector = connectorWith({
      id: "too_large",
      kind: "mcp",
      tools: [{ name: "x".repeat(MAX_SERIALIZED_CATALOG_BYTES) }],
      call: async () => null,
    });
    const registry = new Registry([tooMany, tooLarge], {
      storage: memoryStorage(),
      logger: silentLogger,
    });

    await expect(registry.getTools("too_many", BASE)).rejects.toThrow("complete-catalog ceiling");
    await expect(registry.getTools("too_large", BASE)).rejects.toThrow("complete-catalog ceiling");
  });
});

describe("personal registry eviction", () => {
  it("keeps a personal registry with catalog work in flight, so its refresh cannot outlive an invalidation", async () => {
    const storage = memoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const connector: Connector = connectorWith({
      id: "mine",
      kind: "mcp",
      authScope: "personal",
      tools: async () => {
        calls++;
        if (calls === 1) {
          await gate;
          return [{ name: "before_reauthorization" }];
        }
        return [{ name: "after_reauthorization" }];
      },
      call: async () => null,
    });
    const root = new Registry([connector], { storage, logger: silentLogger });
    const refreshing = root.scoped({ connectorIds: "all", principalKey: "0" }).getTools("mine", BASE);
    await vi.waitFor(() => expect(calls).toBe(1));

    // Fill the personal-registry bound while principal 0's listing is live,
    // then let principal 0 come back and change its credential.
    for (let i = 1; i <= 1_024; i++) {
      root.scoped({ connectorIds: "all", principalKey: String(i) });
    }
    await root.scoped({ connectorIds: "all", principalKey: "0" }).invalidateStored("mine");
    release();

    await expect(refreshing).resolves.toMatchObject([{ name: "before_reauthorization" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await storage.get("principal:0:catalog:mine")).toBeNull();
    await expect(root.scoped({ connectorIds: "all", principalKey: "0" }).getTools("mine", BASE)).resolves.toMatchObject(
      [{ name: "after_reauthorization" }],
    );
  });
});
