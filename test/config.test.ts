import { describe, expect, it } from "vitest";
import { createConnecta, customExecutor } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";

const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });

type UnsafeCreateConnecta = (config: Record<PropertyKey, unknown>) => unknown;

const unsafeCreateConnecta = createConnecta as unknown as UnsafeCreateConnecta;

describe("ConnectaConfig boundary", () => {
  it("wraps a frozen custom executor without losing private-field receivers or admission", async () => {
    const events: string[] = [];
    class SelfManaged {
      #value = "private";
      readonly name = "self-managed-test";
      async execute() {
        return { result: this.#value };
      }
      async acquire(options?: { signal?: AbortSignal }) {
        events.push(`acquire ${this.#value} ${options?.signal?.aborted}`);
        return { execute: this.execute.bind(this), release: () => events.push("release") };
      }
      admissionSnapshot() {
        events.push(`snapshot ${this.#value}`);
        return {
          concurrency: 1,
          maxQueueSize: 0,
          queueTimeoutMs: 1,
          retryAfterMs: 1,
          active: 0,
          queued: 0,
          closed: false,
          totals: { admitted: 0, queued: 0, rejected: 0, cancelled: 0, closed: 0 },
          queueWaitMs: { count: 0, total: 0, max: 0 },
        };
      }
      close() {
        events.push(`close ${this.#value}`);
      }
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
    const app = createConnecta({ readOnly: false, connectors: [], executor: wrapped, logger: "silent" });
    await app.close();
    expect(events).toEqual(["acquire private false", "release", "snapshot private", "close private"]);
  });

  it("INV-11: refuses storage without list or compareAndSet, as a Workers KV adapter is", () => {
    // The 0.28 Worker example's Workers KV adapter: no atomic claim.
    const kv = { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] };
    expect(() => unsafeCreateConnecta({ connectors: [], executor, storage: kv })).toThrow(
      /storage must implement compareAndSet[\s\S]*d1Storage[\s\S]*sqliteStorage[\s\S]*Workers KV is not supported/,
    );
    const { list: _list, ...unlisted } = memoryStorage();
    expect(() => unsafeCreateConnecta({ connectors: [], executor, storage: unlisted })).toThrow(
      "storage must implement list",
    );
  });

  it.each([undefined, { absoluteExpiry: "true" }])(
    "INV-11: refuses storage without an explicit absolute-expiry capability (%j)",
    (capabilities) => {
      expect(() =>
        unsafeCreateConnecta({
          connectors: [],
          executor,
          storage: { ...memoryStorage(), capabilities },
        }),
      ).toThrow("storage must declare capabilities.absoluteExpiry: true");
    },
  );

  it("validates allowedOrigins as exact HTTP origins or an explicit wildcard", async () => {
    for (const allowedOrigins of [
      null,
      true,
      "https://client.example",
      ["*"],
      ["null"],
      ["https://client.example/"],
      ["https://user:secret@client.example"],
      ["file://host"],
      [42],
    ]) {
      expect(() => unsafeCreateConnecta({ connectors: [], executor, allowedOrigins })).toThrow(/allowedOrigins/);
    }
    for (const allowedOrigins of [[], ["https://client.example", "http://localhost:1234"], "*" as const]) {
      const connecta = createConnecta({ readOnly: false, connectors: [], executor, allowedOrigins });
      await connecta.close();
    }
  });

  it("INV-11: rejects malformed admission bounds at construction", () => {
    expect(() =>
      createConnecta({ readOnly: false, connectors: [], executor, admission: { requests: { concurrency: 0 } } }),
    ).toThrow("concurrency must be a positive whole number");
    expect(() =>
      createConnecta({ readOnly: false, connectors: [], executor, admission: { requests: { maxQueueSize: -1 } } }),
    ).toThrow("maxQueueSize must be a non-negative whole number");
    expect(() =>
      createConnecta({
        readOnly: false,
        connectors: [],
        executor,
        admission: { code: { queueTimeoutMs: Number.NaN } },
      }),
    ).toThrow("queueTimeoutMs must be a positive whole number");
    expect(() =>
      createConnecta({ readOnly: false, connectors: [], executor, admission: { requests: { maxDurationMs: 0 } } }),
    ).toThrow("maxDurationMs must be a positive whole number");
    expect(() =>
      createConnecta({
        readOnly: false,
        connectors: [],
        executor,
        admission: { requests: { maxDurationMs: 3_000_000_000 } },
      }),
    ).toThrow("maxDurationMs must be at most 2,147,483,647 milliseconds");
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

    expect(() => unsafeCreateConnecta(config)).toThrow("ConnectaConfig.typo");
    expect(() => unsafeCreateConnecta(config)).not.toThrow(secret);
    expect(connectorsRead).toBe(false);
  });
});

// Compile-time clean-break coverage. These branches never run, but tsc must
// prove every removed v0.6 path is rejected at the public call site.
// oxlint-disable-next-line no-constant-condition -- This branch exists only for tsc.
if (false) {
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
    readOnly: false,
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
    [
      "a top-level option",
      (calls: { count: number }) => trap({ connectors: [], executor }, "discovery", calls),
      "ConnectaConfig.discovery",
    ],
    [
      "a nested limit",
      (calls: { count: number }) => ({ connectors: [], executor, discovery: trap({}, "concurrency", calls) }),
      "ConnectaConfig.discovery.concurrency",
    ],
    [
      "a connector slot",
      (calls: { count: number }) => ({ connectors: trap([], "0", calls), executor }),
      "ConnectaConfig.connectors[0]",
    ],
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

  it("INV-11: refuses a root config whose inspection throws, by path and without the trap's text", () => {
    const revocable = Proxy.revocable({ connectors: [], executor }, {});
    revocable.revoke();
    for (const config of [
      new Proxy(
        { connectors: [], executor },
        {
          ownKeys() {
            throw new Error(SECRET);
          },
        },
      ),
      new Proxy(
        { connectors: [], executor },
        {
          getOwnPropertyDescriptor() {
            throw new Error(SECRET);
          },
        },
      ),
      revocable.proxy,
      {
        connectors: new Proxy([], {
          ownKeys() {
            throw new Error(SECRET);
          },
        }),
        executor,
      },
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

  it("INV-11: keeps __proto__, constructor, and prototype as ordinary pool names", async () => {
    const members = [{ namespace: "people", id: "alice" }];
    const pools = {
      ["__proto__"]: { tools: ["notes"], members },
      constructor: { tools: ["notes"], members },
      prototype: { tools: ["notes"], members },
    };
    expect(Object.keys(pools)).toEqual(["__proto__", "constructor", "prototype"]);
    const notes: Connector = { id: "notes", listTools: async () => [], callTool: async () => null };
    const app = createConnecta({ readOnly: false, connectors: [notes], executor, logger: "silent", pools });
    expect(
      app
        .describeConfig()
        .pools.map((pool) => pool.name)
        .sort(),
    ).toEqual(["__proto__", "constructor", "prototype"]);
    await app.close();

    // An undeclared name stays undeclared: a resolved map inherits nothing.
    const { resolveConfig } = await import("../src/config.js");
    const resolved = resolveConfig({
      readOnly: false,
      connectors: [notes],
      executor,
      pools: { support: { tools: ["notes"], members } },
    });
    expect(Object.getPrototypeOf(resolved.pools)).toBeNull();
    expect(resolved.pools?.["constructor"]).toBeUndefined();
    expect(resolved.pools?.["toString"]).toBeUndefined();
  });
});
