import { describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "../src/catalog-limits.js";
import { api } from "../src/connectors/api.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, KVStorage, Logger, ToolDef } from "../src/types.js";
import { brokenConnector, calcConnector, makeRegistry, remoteConnector, silentLogger } from "./helpers.js";

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

describe("startup convention warnings", () => {
  function spyLogger(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = [];
    return {
      warnings,
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
    };
  }

  it("bounds absent-grant warning deduplication and evicts the oldest name", () => {
    const { logger, warnings } = spyLogger();
    const registry = new Registry([], { storage: memoryStorage(), logger });
    for (let i = 0; i < 1_025; i++) registry.noteAbsentGrant("docs", `missing_${i}`);
    expect((registry as unknown as { warnedAbsentGrants: Set<string> }).warnedAbsentGrants.size).toBe(1_024);
    registry.noteAbsentGrant("docs", "missing_1024");
    expect(warnings).toHaveLength(1_025);
    registry.noteAbsentGrant("docs", "missing_0");
    expect(warnings).toHaveLength(1_026);
  });

  it("warns on a connector with no description", () => {
    const { logger, warnings } = spyLogger();
    const noDesc: Connector = connectorWith({
      id: "nodesc",
      tools: [],
      call: async () => null,
    });
    new Registry([noDesc], { storage: memoryStorage(), logger });
    expect(warnings.some((w) => w.includes('connector "nodesc" has no description'))).toBe(true);
  });

  it("warns on static tools missing description or inputSchema", () => {
    const { logger, warnings } = spyLogger();
    // Hand-rolled rather than api(): api() now refuses a description-less
    // tool outright, so this warning covers the connectors that implement the
    // interface themselves and still publish `staticTools`.
    const conn: Connector = connectorWith({
      id: "bare",
      kind: "api",
      description: "Bare — demo",
      staticTools: [{ name: "go" }],
      tools: [{ name: "go" }],
      call: async () => ({}),
    });
    new Registry([conn], { storage: memoryStorage(), logger });
    expect(warnings.some((w) => w.includes('tool "bare.go" has no description'))).toBe(true);
    expect(warnings.some((w) => w.includes('tool "bare.go" has no inputSchema'))).toBe(true);
  });

  it("stays silent when conventions are met", () => {
    const { logger, warnings } = spyLogger();
    const conn = api("clean", {
      description: "Clean — one tool",
      tools: [
        {
          name: "do_thing",
          description: "Do the thing.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
    new Registry([conn], { storage: memoryStorage(), logger });
    expect(warnings).toEqual([]);
  });
});

describe("normalized result-cap state", () => {
  it.each([0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "INV-11: refuses unusable deployment cap %s at construction",
    (maxResultBytes) => {
      expect(
        () =>
          new Registry([calcConnector], {
            storage: memoryStorage(),
            logger: silentLogger,
            maxResultBytes,
          }),
      ).toThrow("calls.maxResultBytes");
    },
  );

  it.each([1, 4, 100, 50_000])("keeps valid deployment cap %s", (cap) => {
    const registry = new Registry([calcConnector], {
      storage: memoryStorage(),
      logger: silentLogger,
      maxResultBytes: cap,
    });
    expect(registry.maxResultBytes).toBe(cap);
  });

  it("uses the built-in default when no cap is configured", () => {
    const registry = new Registry([calcConnector], {
      storage: memoryStorage(),
      logger: silentLogger,
    });
    expect(registry.maxResultBytes).toBe(24_000);
  });
});

describe("address resolution", () => {
  const registry = makeRegistry([calcConnector, remoteConnector]);

  it("resolves <connector>.<tool>", () => {
    const r = registry.resolveAddress("calc.add");
    expect(r?.connector.id).toBe("calc");
    expect(r?.toolName).toBe("add");
  });

  it("keeps only the first dot as the split", () => {
    const r = registry.resolveAddress("remote.echo.deep");
    expect(r?.connector.id).toBe("remote");
    expect(r?.toolName).toBe("echo.deep");
  });

  it("returns null for unknown connector or malformed address", () => {
    expect(registry.resolveAddress("nope.tool")).toBeNull();
    expect(registry.resolveAddress("noseparator")).toBeNull();
    expect(registry.resolveAddress(".leading")).toBeNull();
    expect(registry.resolveAddress("calc.")).toBeNull();
  });
});

describe("request-local catalogs", () => {
  it("coalesces concurrent cold loads within one request scope", async () => {
    const backing = memoryStorage();
    let storageReads = 0;
    let storageWrites = 0;
    const storage: KVStorage = {
      list: (prefix) => backing.list(prefix),
      compareAndSet: (key, expected, next, options) => backing.compareAndSet(key, expected, next, options),
      async get(key) {
        storageReads++;
        return backing.get(key);
      },
      async set(key, value, options) {
        storageWrites++;
        return backing.set(key, value, options);
      },
      delete: (key) => backing.delete(key),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let catalogLoads = 0;
    const connector: Connector = connectorWith({
      id: "coalesced",
      kind: "mcp",
      tools: async () => {
        catalogLoads++;
        started();
        await gate;
        return [{ name: "read" }];
      },
      call: async () => null,
    });
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    const requestScope = {};
    const pending = Array.from({ length: 25 }, () => registry.getTools("coalesced", BASE, requestScope));
    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(catalogLoads).toBe(1);
    expect(storageReads).toBe(0);
    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(25);
    expect(catalogLoads).toBe(1);
    expect(storageWrites).toBe(0);
  });
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
    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (...args: unknown[]) => warnings.push(String(args[0])),
    };
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
      logger,
    });

    await expect(registry.getTools("too_many", BASE)).rejects.toThrow("complete-catalog ceiling");
    await expect(registry.getTools("too_large", BASE)).rejects.toThrow("complete-catalog ceiling");
  });

  it.each(["tools", "bytes"])(
    "refuses an over-ceiling %s catalog even when invalidation prevents publication",
    async (limit) => {
      const storage = memoryStorage();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let calls = 0;
      const connector = connectorWith({
        id: "invalidated_limit",
        kind: "mcp",
        tools: async () => {
          if (++calls > 1) return [{ name: "fresh" }];
          reached();
          await gate;
          return limit === "tools"
            ? (Array(MAX_CATALOG_TOOLS + 1).fill({ name: "same" }) as ToolDef[])
            : [{ name: "x".repeat(MAX_SERIALIZED_CATALOG_BYTES) }];
        },
        call: async () => null,
      });
      const registry = makeRegistry([connector], { storage });
      const pending = registry.getTools(connector.id, BASE);
      const refused = expect(pending).rejects.toThrow(
        limit === "tools" ? "catalog ceiling" : "complete-catalog ceiling",
      );
      await started;
      await registry.invalidateStored(connector.id);
      release();
      await refused;
      expect(await storage.get(`catalog:${connector.id}`)).toBeNull();
      await expect(registry.getTools(connector.id, BASE)).resolves.toMatchObject([{ name: "fresh" }]);
    },
  );
});

describe("broken-connector isolation", () => {
  const registry = makeRegistry([calcConnector, brokenConnector]);

  it("reports error status for the broken connector", async () => {
    const status = await registry.statusFor("broken", BASE);
    expect(status.state).toBe("error");
    // An operator surface: the failure's record, never its text (INV-6).
    expect(status.message).toBe('Connector "broken" failed (Error).');
  });

  it("keeps healthy connectors working alongside a broken one", async () => {
    const ok = await registry.statusFor("calc", BASE);
    expect(ok.state).toBe("ok");
    const tools = await registry.getTools("calc", BASE);
    expect(tools.map((t) => t.name)).toEqual(["add"]);
  });
});

describe("memory storage expiry", () => {
  it("reclaims expired entries on later sets with bounded rotating work", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const storage = memoryStorage();
    for (let i = 0; i < 100; i++) await storage.set(`expired-${i}`, "payload", { ttlSeconds: 1 });
    await storage.set("live", "keep");
    const deleted = vi.spyOn(Map.prototype, "delete");
    try {
      now.mockReturnValue(2_000);
      await storage.set("later-0", "keep");
      expect(deleted.mock.calls.length).toBeGreaterThan(0);
      expect(deleted.mock.calls.length).toBeLessThanOrEqual(16);
      for (let i = 1; i < 20; i++) await storage.set(`later-${i}`, "keep");
      expect(deleted.mock.calls.filter(([key]) => String(key).startsWith("expired-"))).toHaveLength(100);
      expect(await storage.get("live")).toBe("keep");
    } finally {
      deleted.mockRestore();
      now.mockRestore();
    }
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
