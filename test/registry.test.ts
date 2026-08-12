import { describe, expect, it, vi } from "vitest";
import {
  MAX_CATALOG_CHUNK_BYTES,
  MAX_CATALOG_TOOLS,
  MAX_SERIALIZED_CATALOG_BYTES,
} from "../src/catalog-limits.js";
import { api } from "../src/connectors/api.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  KVStorage,
  Logger,
  ToolDef,
} from "../src/types.js";
import { required,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
  silentLogger,
} from "./helpers.js";

const BASE = "https://connecta.test";

interface CatalogManifest {
  version: 2;
  revision: string;
  toolCount: number;
  byteCount: number;
  chunkCount: number;
}

async function readManifest(
  storage: KVStorage,
  id: string,
): Promise<CatalogManifest> {
  return JSON.parse((await storage.get(`catalog:${id}`))!) as CatalogManifest;
}

async function readPersistedTools(
  storage: KVStorage,
  id: string,
): Promise<ToolDef[]> {
  const manifest = await readManifest(storage, id);
  const chunks: string[] = [];
  for (let index = 0; index < manifest.chunkCount; index++) {
    chunks.push(
      (await storage.get(`catalog:${id}:chunk:${manifest.revision}:${index}`))!,
    );
  }
  return JSON.parse(chunks.join("")) as ToolDef[];
}

describe("Registry construction", () => {
  it("rejects invalid connector ids", () => {
    const bad: Connector = { ...calcConnector, id: "Bad.Id" };
    expect(() => makeRegistry([bad])).toThrow(/Invalid connector id/);
  });

  it("rejects duplicate connector ids", () => {
    expect(() => makeRegistry([calcConnector, { ...calcConnector }])).toThrow(
      /Duplicate connector id/,
    );
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

  it("warns on a connector with no description", () => {
    const { logger, warnings } = spyLogger();
    const noDesc: Connector = {
      id: "nodesc",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    new Registry([noDesc], { storage: memoryStorage(), logger });
    expect(
      warnings.some((w) =>
        w.includes('connector "nodesc" has no description'),
      ),
    ).toBe(true);
  });

  it("warns on static tools missing description or inputSchema", () => {
    const { logger, warnings } = spyLogger();
    // Hand-rolled rather than api(): api() now refuses a description-less
    // tool outright, so this warning covers the connectors that implement the
    // interface themselves and still publish `staticTools`.
    const conn: Connector = {
      id: "bare",
      kind: "api",
      description: "Bare — demo",
      staticTools: [{ name: "go" }],
      async listTools() {
        return [{ name: "go" }];
      },
      async callTool() {
        return {};
      },
    };
    new Registry([conn], { storage: memoryStorage(), logger });
    expect(
      warnings.some((w) => w.includes('tool "bare.go" has no description')),
    ).toBe(true);
    expect(
      warnings.some((w) => w.includes('tool "bare.go" has no inputSchema')),
    ).toBe(true);
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

describe("result-cap startup warnings", () => {
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

  /** Caps that are accepted today but silently do something wrong (issue #32). */
  const BAD_CAPS = [0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  it("warns and falls back to the default for an unusable deployment cap", () => {
    for (const maxResultBytes of BAD_CAPS) {
      const { logger, warnings } = spyLogger();
      const registry = new Registry([calcConnector], {
        storage: memoryStorage(),
        logger,
        maxResultBytes,
      });
      expect(registry.maxResultBytes, `cap ${String(maxResultBytes)}`).toBe(
        50_000,
      );
      expect(
        warnings.some(
          (w) =>
            w.includes(`maxResultBytes ${maxResultBytes}`) &&
            w.includes("50000"),
        ),
        `cap ${String(maxResultBytes)}`,
      ).toBe(true);
    }
  });

  it("warns and names the connector for an unusable per-connector override", () => {
    for (const maxResultBytes of BAD_CAPS) {
      const { logger, warnings } = spyLogger();
      new Registry([{ ...calcConnector, maxResultBytes }], {
        storage: memoryStorage(),
        logger,
        maxResultBytes: 400,
      });
      expect(
        warnings.some(
          (w) =>
            w.includes(
              `connector "calc" sets maxResultBytes ${maxResultBytes}`,
            ) && w.includes("400"),
        ),
        `override ${String(maxResultBytes)}`,
      ).toBe(true);
    }
  });

  it("stays silent for valid caps, including the 1-byte floor", () => {
    for (const cap of [1, 4, 100, 50_000]) {
      const { logger, warnings } = spyLogger();
      const registry = new Registry(
        [{ ...calcConnector, maxResultBytes: cap }],
        {
          storage: memoryStorage(),
          logger,
          maxResultBytes: cap,
        },
      );
      expect(registry.maxResultBytes).toBe(cap);
      expect(warnings, `cap ${cap}`).toEqual([]);
    }
  });

  it("keeps the built-in default when no cap is configured", () => {
    const { logger, warnings } = spyLogger();
    const registry = new Registry([calcConnector], {
      storage: memoryStorage(),
      logger,
    });
    expect(registry.maxResultBytes).toBe(50_000);
    expect(warnings).toEqual([]);
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

describe("tool cache TTL", () => {
  it("coalesces concurrent cold loads within one request scope", async () => {
    const backing = memoryStorage();
    let storageReads = 0;
    let storageWrites = 0;
    const storage: KVStorage = {
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
    const connector: Connector = {
      id: "coalesced",
      kind: "mcp",
      async listTools() {
        catalogLoads++;
        started();
        await gate;
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    const requestScope = {};
    const pending = Array.from({ length: 25 }, () =>
      registry.getTools("coalesced", BASE, requestScope),
    );
    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(catalogLoads).toBe(1);
    expect(storageReads).toBe(1);
    release();
    await expect(Promise.all(pending)).resolves.toHaveLength(25);
    expect(catalogLoads).toBe(1);
    expect(storageWrites).toBe(2);
  });

  it("does not share an in-flight catalog across request scopes", async () => {
    let catalogLoads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector: Connector = {
      id: "request_bound",
      kind: "mcp",
      async listTools() {
        catalogLoads++;
        await gate;
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger: silentLogger,
      persistToolCatalog: false,
      toolCacheTtlSeconds: 0,
    });
    const pending = [
      registry.getTools("request_bound", BASE, {}),
      registry.getTools("request_bound", BASE, {}),
    ];
    await vi.waitFor(() => expect(catalogLoads).toBe(2));
    release();
    await Promise.all(pending);
  });

  it("removes a failed request-local load so the same request can retry", async () => {
    let catalogLoads = 0;
    const connector: Connector = {
      id: "retry_load",
      kind: "mcp",
      async listTools() {
        catalogLoads++;
        if (catalogLoads === 1) throw new Error("temporary failure");
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger: silentLogger,
      persistToolCatalog: false,
    });
    const scope = {};
    await expect(
      registry.getTools("retry_load", BASE, scope),
    ).rejects.toThrow("temporary failure");
    await expect(
      registry.getTools("retry_load", BASE, scope),
    ).resolves.toEqual([{ name: "read" }]);
    expect(catalogLoads).toBe(2);
  });

  it("caches within the TTL and refetches after it expires", async () => {
    let calls = 0;
    const counting: Connector = {
      id: "counter",
      kind: "api",
      async listTools(): Promise<ToolDef[]> {
        calls++;
        return [{ name: "ping" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([counting], {
      storage: memoryStorage(),
      logger: silentLogger,
      toolCacheTtlSeconds: 10,
    });

    vi.useFakeTimers();
    try {
      await registry.getTools("counter", BASE);
      await registry.getTools("counter", BASE);
      expect(calls).toBe(1); // second read served from cache

      vi.advanceTimersByTime(11_000);
      await registry.getTools("counter", BASE);
      expect(calls).toBe(2); // TTL expired → refetch
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate() forces a refetch", async () => {
    let calls = 0;
    const counting: Connector = {
      id: "counter2",
      async listTools() {
        calls++;
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([counting]);
    await registry.getTools("counter2", BASE);
    registry.invalidate("counter2");
    await registry.getTools("counter2", BASE);
    expect(calls).toBe(2);
  });

  it("does not publish a catalog refresh invalidated while listTools is in flight", async () => {
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
    const connector: Connector = {
      id: "racing",
      kind: "mcp",
      async listTools() {
        calls++;
        if (calls === 1) {
          reached();
          await gate;
          return [{ name: "old_credential_tool" }];
        }
        return [{ name: "new_credential_tool" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });

    const oldRefresh = registry.getTools("racing", BASE);
    await started;
    await registry.invalidateStored("racing");
    release();

    expect(required((await oldRefresh)[0]).name).toBe("old_credential_tool");
    expect(registry.peekTools("racing")).toBeUndefined();
    expect(await storage.get("catalog:racing")).toBeNull();

    expect(required((await registry.getTools("racing", BASE))[0]).name).toBe(
      "new_credential_tool",
    );
    expect(await readPersistedTools(storage, "racing")).toEqual([
      { name: "new_credential_tool" },
    ]);
  });

  it("reuses a persisted serializable catalog in a cold registry", async () => {
    const storage = memoryStorage();
    let calls = 0;
    const connector: Connector = {
      id: "persisted",
      kind: "mcp",
      async listTools() {
        calls++;
        return [
          {
            name: "read",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool() {
        return null;
      },
    };
    const first = new Registry([connector], {
      storage,
      logger: silentLogger,
      toolCacheTtlSeconds: 300,
    });
    expect(required((await first.getTools("persisted", BASE))[0]).annotations).toEqual({
      readOnlyHint: true,
    });

    const cold = new Registry([connector], {
      storage,
      logger: silentLogger,
      toolCacheTtlSeconds: 300,
    });
    expect(required((await cold.getTools("persisted", BASE))[0]).name).toBe("read");
    expect(calls).toBe(1);
  });

  it("round-trips a multichunk catalog without splitting UTF-8", async () => {
    const storage = memoryStorage();
    let calls = 0;
    const tools: ToolDef[] = [
      {
        name: "large",
        description: "é".repeat(700_000),
        annotations: { readOnlyHint: true },
      },
      { name: "tail", description: "complete" },
    ];
    const connector: Connector = {
      id: "chunked",
      kind: "mcp",
      async listTools() {
        calls++;
        return tools;
      },
      async callTool() {
        return null;
      },
    };
    const first = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    await first.getTools("chunked", BASE);

    const manifest = await readManifest(storage, "chunked");
    expect(manifest).toMatchObject({
      version: 2,
      toolCount: 2,
      chunkCount: 2,
    });
    for (let index = 0; index < manifest.chunkCount; index++) {
      const chunk = await storage.get(
        `catalog:chunked:chunk:${manifest.revision}:${index}`,
      );
      expect(new TextEncoder().encode(chunk!).byteLength).toBeLessThanOrEqual(
        MAX_CATALOG_CHUNK_BYTES,
      );
    }

    const cold = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    await expect(cold.getTools("chunked", BASE)).resolves.toEqual(tools);
    expect(calls).toBe(1);
  });

  it("reads persisted catalog chunks with a fixed concurrency bound", async () => {
    const backing = memoryStorage();
    const tools: ToolDef[] = [
      {
        name: "large",
        description: "x".repeat(MAX_CATALOG_CHUNK_BYTES * 5),
      },
    ];
    let calls = 0;
    const connector: Connector = {
      id: "bounded_reads",
      kind: "mcp",
      async listTools() {
        calls++;
        return tools;
      },
      async callTool() {
        return null;
      },
    };
    const first = new Registry([connector], {
      storage: backing,
      logger: silentLogger,
    });
    await first.getTools("bounded_reads", BASE);
    const manifest = await readManifest(backing, "bounded_reads");
    expect(manifest.chunkCount).toBeGreaterThan(4);

    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage: KVStorage = {
      async get(key) {
        if (key.startsWith("catalog:bounded_reads:chunk:")) {
          active++;
          started++;
          maxActive = Math.max(maxActive, active);
          try {
            await gate;
            return await backing.get(key);
          } finally {
            active--;
          }
        }
        return backing.get(key);
      },
      set: (key, value, options) => backing.set(key, value, options),
      delete: (key) => backing.delete(key),
    };
    const cold = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    const pending = cold.getTools("bounded_reads", BASE);
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      expect(maxActive).toBe(4);
      expect(started).toBeLessThan(manifest.chunkCount);
    } finally {
      release();
    }

    await expect(pending).resolves.toEqual(tools);
    expect(calls).toBe(1);
  });

  it("withholds the manifest when a parallel chunk write fails", async () => {
    const backing = memoryStorage();
    let active = 0;
    let maxActive = 0;
    let chunkWrites = 0;
    let manifestWrites = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, options) {
        if (key.startsWith("catalog:parallel_write_failure:chunk:")) {
          active++;
          chunkWrites++;
          maxActive = Math.max(maxActive, active);
          try {
            await gate;
            if (key.endsWith(":1")) throw new Error("chunk write failed");
            return await backing.set(key, value, options);
          } finally {
            active--;
          }
        }
        if (key === "catalog:parallel_write_failure") manifestWrites++;
        return backing.set(key, value, options);
      },
      delete: (key) => backing.delete(key),
    };
    const warnings: string[] = [];
    const connector: Connector = {
      id: "parallel_write_failure",
      kind: "mcp",
      async listTools() {
        return [
          {
            name: "large",
            description: "x".repeat(MAX_CATALOG_CHUNK_BYTES * 2),
          },
        ];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
    });
    const pending = registry.getTools("parallel_write_failure", BASE);
    try {
      await vi.waitFor(() => expect(active).toBeGreaterThan(1));
      expect(manifestWrites).toBe(0);
    } finally {
      release();
    }

    await expect(pending).resolves.toEqual([
      {
        name: "large",
        description: "x".repeat(MAX_CATALOG_CHUNK_BYTES * 2),
      },
    ]);
    expect(maxActive).toBeGreaterThan(1);
    expect(chunkWrites).toBe(3);
    expect(manifestWrites).toBe(0);
    expect(await backing.get("catalog:parallel_write_failure")).toBeNull();
    expect(
      warnings.some((warning) =>
        warning.includes("catalog persistence failed: chunk write failed"),
      ),
    ).toBe(true);
  });

  it("treats a missing persisted chunk as no catalog", async () => {
    const storage = memoryStorage();
    const warnings: string[] = [];
    let fail = false;
    const connector: Connector = {
      id: "torn",
      kind: "mcp",
      async listTools() {
        if (fail) throw new Error("live unavailable");
        return [{ name: "large", description: "x".repeat(1_100_000) }];
      },
      async callTool() {
        return null;
      },
    };
    const first = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    await first.getTools("torn", BASE);
    const manifest = await readManifest(storage, "torn");
    await storage.delete(
      `catalog:torn:chunk:${manifest.revision}:${manifest.chunkCount - 1}`,
    );
    fail = true;

    const cold = new Registry([connector], {
      storage,
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
    });
    await expect(cold.getTools("torn", BASE)).rejects.toThrow(
      "live unavailable",
    );
    expect(cold.peekTools("torn")).toBeUndefined();
    expect(
      warnings.some((warning) => warning.includes("chunk 2/2 is missing")),
    ).toBe(true);
  });

  it("treats a persisted fingerprint mismatch as no catalog", async () => {
    const storage = memoryStorage();
    const warnings: string[] = [];
    let fail = false;
    const connector: Connector = {
      id: "mismatch",
      kind: "mcp",
      async listTools() {
        if (fail) throw new Error("live unavailable");
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const first = new Registry([connector], {
      storage,
      logger: silentLogger,
    });
    await first.getTools("mismatch", BASE);
    const manifest = await readManifest(storage, "mismatch");
    const chunkKey = `catalog:mismatch:chunk:${manifest.revision}:0`;
    await storage.set(
      chunkKey,
      (await storage.get(chunkKey))!.replace('"read"', '"reed"'),
    );
    fail = true;

    const cold = new Registry([connector], {
      storage,
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
    });
    await expect(cold.getTools("mismatch", BASE)).rejects.toThrow(
      "live unavailable",
    );
    expect(cold.peekTools("mismatch")).toBeUndefined();
    expect(
      warnings.some((warning) => warning.includes("fingerprint mismatch")),
    ).toBe(true);
  });

  it("refuses complete catalogs over the tool or serialized-byte ceiling", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (...args: unknown[]) => warnings.push(String(args[0])),
    };
    const tooMany: Connector = {
      id: "too_many",
      kind: "mcp",
      async listTools() {
        return Array(MAX_CATALOG_TOOLS + 1).fill({ name: "same" }) as ToolDef[];
      },
      async callTool() {
        return null;
      },
    };
    const tooLarge: Connector = {
      id: "too_large",
      kind: "mcp",
      async listTools() {
        return [{ name: "x".repeat(MAX_SERIALIZED_CATALOG_BYTES) }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([tooMany, tooLarge], {
      storage: memoryStorage(),
      logger,
      persistToolCatalog: false,
    });

    await expect(registry.getTools("too_many", BASE)).rejects.toThrow(
      `${MAX_CATALOG_TOOLS}-tool catalog ceiling`,
    );
    await expect(registry.getTools("too_large", BASE)).rejects.toThrow(
      `${MAX_SERIALIZED_CATALOG_BYTES}-byte ceiling`,
    );
    expect(registry.peekTools("too_many")).toBeUndefined();
    expect(registry.peekTools("too_large")).toBeUndefined();
    expect(
      warnings.filter((warning) => warning.includes("catalog ceiling")),
    ).toHaveLength(1);
    expect(
      warnings.filter((warning) => warning.includes("serialized catalog")),
    ).toHaveLength(1);
  });

  it("reads legacy single-value catalogs and retires them on invalidation", async () => {
    const storage = memoryStorage();
    const now = Date.now();
    await storage.set(
      "catalog:legacy",
      JSON.stringify({
        tools: [{ name: "old" }],
        fetchedAt: now,
        expiresAt: now + 60_000,
        staleUntil: now + 120_000,
      }),
    );
    let calls = 0;
    const connector: Connector = {
      id: "legacy",
      kind: "mcp",
      async listTools() {
        calls++;
        return [{ name: "new" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });

    await expect(registry.getTools("legacy", BASE)).resolves.toEqual([
      { name: "old" },
    ]);
    expect(calls).toBe(0);
    await registry.invalidateStored("legacy");
    await expect(registry.getTools("legacy", BASE)).resolves.toEqual([
      { name: "new" },
    ]);
    expect(calls).toBe(1);
    expect(await readPersistedTools(storage, "legacy")).toEqual([
      { name: "new" },
    ]);
  });

  it("does not resurrect a legacy read across a generation change", async () => {
    const backing = memoryStorage();
    const now = Date.now();
    await backing.set(
      "catalog:legacy_race",
      JSON.stringify({
        tools: [{ name: "old" }],
        fetchedAt: now,
        expiresAt: now + 60_000,
        staleUntil: now + 120_000,
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let firstRootRead = true;
    const storage: KVStorage = {
      async get(key) {
        if (key === "catalog:legacy_race" && firstRootRead) {
          firstRootRead = false;
          const value = await backing.get(key);
          reached();
          await gate;
          return value;
        }
        return backing.get(key);
      },
      set: (key, value, options) => backing.set(key, value, options),
      delete: (key) => backing.delete(key),
    };
    let calls = 0;
    const connector: Connector = {
      id: "legacy_race",
      kind: "mcp",
      async listTools() {
        calls++;
        return [{ name: "new" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });

    const pending = registry.getTools("legacy_race", BASE);
    await started;
    await registry.invalidateStored("legacy_race");
    release();

    await expect(pending).resolves.toEqual([{ name: "new" }]);
    expect(calls).toBe(1);
    expect(registry.peekTools("legacy_race")).toEqual([{ name: "new" }]);
    expect(await readPersistedTools(storage, "legacy_race")).toEqual([
      { name: "new" },
    ]);
  });

  it("persists only when the complete catalog fingerprint changes", async () => {
    const backing = memoryStorage();
    let manifestWrites = 0;
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, options) {
        if (key === "catalog:fingerprinted") manifestWrites++;
        return backing.set(key, value, options);
      },
      delete: (key) => backing.delete(key),
    };
    let tools: ToolDef[] = [
      {
        name: "read",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ];
    const connector: Connector = {
      id: "fingerprinted",
      kind: "mcp",
      async listTools() {
        return tools;
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
    });

    await registry.refreshTools("fingerprinted", BASE);
    expect(manifestWrites).toBe(1);
    await registry.refreshTools("fingerprinted", BASE);
    expect(manifestWrites).toBe(1);

    const mutations: ToolDef[][] = [
      [...tools, { name: "second" }],
      [{ ...required(tools[0]), name: "renamed" }],
      [{ ...required(tools[0]), inputSchema: { type: "string" } }],
      [{ ...required(tools[0]), annotations: { readOnlyHint: false } }],
      [],
    ];
    for (const mutation of mutations) {
      tools = mutation;
      await registry.refreshTools("fingerprinted", BASE);
      expect(manifestWrites).toBeGreaterThan(1);
      const persisted = await readManifest(backing, "fingerprinted");
      expect(persisted.revision).toMatch(/^sha256:/);
      expect(await readPersistedTools(backing, "fingerprinted")).toEqual(
        mutation,
      );
    }
    expect(manifestWrites).toBe(1 + mutations.length);
  });

  it("serializes a refreshed tool array once for fingerprint and persistence", async () => {
    let serializations = 0;
    const serializable = {
      name: "read",
      toJSON() {
        serializations++;
        return { name: "read", annotations: { readOnlyHint: true } };
      },
    } as unknown as ToolDef;
    const connector: Connector = {
      id: "serialize_once",
      kind: "mcp",
      async listTools() {
        return [serializable];
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([connector]);
    await registry.refreshTools("serialize_once", BASE);
    expect(serializations).toBe(1);
  });

  it("falls back to a stale persisted catalog when live refresh fails", async () => {
    const storage = memoryStorage();
    let fail = false;
    const connector: Connector = {
      id: "stale",
      kind: "mcp",
      async listTools() {
        if (fail) throw new Error("temporary outage");
        return [{ name: "still_here" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage,
      logger: silentLogger,
      toolCacheTtlSeconds: 1,
      toolCatalogStaleSeconds: 30,
    });
    vi.useFakeTimers();
    try {
      await registry.getTools("stale", BASE);
      fail = true;
      vi.advanceTimersByTime(2_000);
      expect(required((await registry.getTools("stale", BASE))[0]).name).toBe(
        "still_here",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps discovery and invalidation working when catalog storage fails", async () => {
    const warnings: string[] = [];
    let deletes = 0;
    const unavailableStorage: KVStorage = {
      async get() {
        throw new Error("storage read unavailable");
      },
      async set() {
        throw new Error("storage write unavailable");
      },
      async delete() {
        deletes++;
        throw new Error("storage delete unavailable");
      },
    };
    let calls = 0;
    const connector: Connector = {
      id: "resilient",
      kind: "mcp",
      async listTools() {
        calls++;
        return [{ name: "read" }];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([connector], {
      storage: unavailableStorage,
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
    });

    expect(required((await registry.getTools("resilient", BASE))[0]).name).toBe("read");
    expect(required((await registry.getTools("resilient", BASE))[0]).name).toBe("read");
    expect(calls).toBe(1);
    await expect(registry.invalidateStored("resilient")).resolves.toBeUndefined();
    expect(deletes).toBe(1);
    expect(required((await registry.getTools("resilient", BASE))[0]).name).toBe("read");
    expect(calls).toBe(2);
    expect(warnings.some((warning) => warning.includes("catalog read failed"))).toBe(
      true,
    );
    expect(
      warnings.some((warning) => warning.includes("catalog persistence failed")),
    ).toBe(true);
    expect(
      warnings.some((warning) => warning.includes("catalog invalidation failed")),
    ).toBe(true);
  });
});

describe("broken-connector isolation", () => {
  const registry = makeRegistry([calcConnector, brokenConnector]);

  it("reports error status for the broken connector", async () => {
    const status = await registry.statusFor("broken", BASE);
    expect(status.state).toBe("error");
    expect(status.message).toContain("boom");
  });

  it("keeps healthy connectors working alongside a broken one", async () => {
    const ok = await registry.statusFor("calc", BASE);
    expect(ok.state).toBe("ok");
    const tools = await registry.getTools("calc", BASE);
    expect(tools.map((t) => t.name)).toEqual(["add"]);
  });
});
