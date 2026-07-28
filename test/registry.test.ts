import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  KVStorage,
  Logger,
  ToolDef,
} from "../src/types.js";
import {
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
  silentLogger,
} from "./helpers.js";

const BASE = "https://connecta.test";

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

  it("warns on api() tools missing description or inputSchema", () => {
    const { logger, warnings } = spyLogger();
    const conn = api("bare", {
      description: "Bare — demo",
      tools: [{ name: "go", handler: () => ({}) }],
    });
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

  it("warns and falls back independently for an unusable batch cap", () => {
    for (const maxBatchResultBytes of BAD_CAPS) {
      const { logger, warnings } = spyLogger();
      const registry = new Registry([calcConnector], {
        storage: memoryStorage(),
        logger,
        maxResultBytes: 400,
        maxBatchResultBytes,
      });
      expect(
        registry.maxBatchResultBytes,
        `cap ${String(maxBatchResultBytes)}`,
      ).toBe(100_000);
      expect(
        warnings.some(
          (warning) =>
            warning.includes(
              `maxBatchResultBytes ${maxBatchResultBytes}`,
            ) && warning.includes("100000"),
        ),
        `cap ${String(maxBatchResultBytes)}`,
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
          maxBatchResultBytes: cap,
        },
      );
      expect(registry.maxResultBytes).toBe(cap);
      expect(registry.maxBatchResultBytes).toBe(cap);
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
    expect(registry.maxBatchResultBytes).toBe(100_000);
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

    expect((await oldRefresh)[0].name).toBe("old_credential_tool");
    expect(registry.peekTools("racing")).toBeUndefined();
    expect(await storage.get("catalog:racing")).toBeNull();

    expect((await registry.getTools("racing", BASE))[0].name).toBe(
      "new_credential_tool",
    );
    expect(await storage.get("catalog:racing")).toContain(
      "new_credential_tool",
    );
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
    expect((await first.getTools("persisted", BASE))[0].annotations).toEqual({
      readOnlyHint: true,
    });

    const cold = new Registry([connector], {
      storage,
      logger: silentLogger,
      toolCacheTtlSeconds: 300,
    });
    expect((await cold.getTools("persisted", BASE))[0].name).toBe("read");
    expect(calls).toBe(1);
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
      expect((await registry.getTools("stale", BASE))[0].name).toBe(
        "still_here",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps discovery and invalidation working when catalog storage fails", async () => {
    const warnings: string[] = [];
    const unavailableStorage: KVStorage = {
      async get() {
        throw new Error("storage read unavailable");
      },
      async set() {
        throw new Error("storage write unavailable");
      },
      async delete() {
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

    expect((await registry.getTools("resilient", BASE))[0].name).toBe("read");
    expect((await registry.getTools("resilient", BASE))[0].name).toBe("read");
    expect(calls).toBe(1);
    await expect(registry.invalidateStored("resilient")).resolves.toBeUndefined();
    expect((await registry.getTools("resilient", BASE))[0].name).toBe("read");
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
