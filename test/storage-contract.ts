import { afterEach, expect, it, vi } from "vitest";
import type { KVStorage } from "../src/index.js";

/**
 * Shared compare-and-set cases for every `KVStorage` that declares the
 * capability. Not a suite: each adapter's own suite calls this inside its
 * `describe`, so the same contract runs against memory, namespaced, file, and
 * the Worker example's D1 adapter.
 *
 * Expiry is driven by faking `Date` alone. Every adapter computes expiry from
 * `Date.now()` in the calling process, and leaving real timers alone keeps a
 * file store's heartbeat and a local D1 proxy's I/O untouched.
 */
export type CasStorage = KVStorage &
  Required<Pick<KVStorage, "compareAndSet">>;

/** Assert at runtime that `storage` declares the capability, and say so in its type. */
export function requireCas<T extends KVStorage>(storage: T): T & CasStorage {
  if (typeof storage.compareAndSet !== "function") {
    throw new Error("Expected storage to declare compareAndSet");
  }
  return storage as T & CasStorage;
}

export function compareAndSetContract(
  open: () => CasStorage | Promise<CasStorage>,
): void {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const fakeClock = () => {
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    return (ms: number) => vi.setSystemTime(Date.now() + ms);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets exactly one of 50 concurrent claims on an absent key win", async () => {
    const storage = await open();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        storage.compareAndSet("claim", null, `owner-${i}`),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storage.get("claim")).toBe(`owner-${results.indexOf(true)}`);
  });

  it("swaps only when the current value matches", async () => {
    const storage = await open();
    await storage.set("rev", "1");
    expect(await storage.compareAndSet("rev", "0", "2")).toBe(false);
    expect(await storage.get("rev")).toBe("1");
    expect(await storage.compareAndSet("rev", null, "2")).toBe(false);
    expect(await storage.get("rev")).toBe("1");
    expect(await storage.compareAndSet("rev", "1", "2")).toBe(true);
    expect(await storage.get("rev")).toBe("2");
    expect(await storage.compareAndSet("rev", "1", "3")).toBe(false);
    expect(await storage.get("rev")).toBe("2");
  });

  it("treats an absent key as null and refuses a non-null expectation", async () => {
    const storage = await open();
    expect(await storage.compareAndSet("missing", "anything", "x")).toBe(false);
    expect(await storage.get("missing")).toBeNull();
    expect(await storage.compareAndSet("missing", null, null)).toBe(true);
    expect(await storage.get("missing")).toBeNull();
    await storage.set("present", "x");
    expect(await storage.compareAndSet("present", null, null)).toBe(false);
    expect(await storage.get("present")).toBe("x");
  });

  it("deletes when next is null", async () => {
    const storage = await open();
    await storage.set("lease", "held");
    expect(await storage.compareAndSet("lease", "other", null)).toBe(false);
    expect(await storage.get("lease")).toBe("held");
    expect(await storage.compareAndSet("lease", "held", null)).toBe(true);
    expect(await storage.get("lease")).toBeNull();
    if (storage.list) expect(await storage.list("lease")).toEqual([]);
    expect(await storage.compareAndSet("lease", null, "again")).toBe(true);
    expect(await storage.get("lease")).toBe("again");
  });

  it("counts an expired entry as absent", async () => {
    const advance = fakeClock();
    const storage = await open();
    await storage.set("lease", "stale", { ttlSeconds: 1 });
    expect(await storage.compareAndSet("lease", null, "fresh")).toBe(false);
    advance(2_000);
    expect(await storage.compareAndSet("lease", "stale", "revived")).toBe(false);
    expect(await storage.compareAndSet("lease", null, "fresh")).toBe(true);
    expect(await storage.get("lease")).toBe("fresh");

    await storage.set("gone", "stale", { ttlSeconds: 1 });
    advance(2_000);
    expect(await storage.compareAndSet("gone", null, null)).toBe(true);
    expect(await storage.get("gone")).toBeNull();
  });

  it("honors ttlSeconds on the value it writes", async () => {
    const advance = fakeClock();
    const storage = await open();
    expect(
      await storage.compareAndSet("lease", null, "held", { ttlSeconds: 10 }),
    ).toBe(true);
    advance(9_000);
    expect(await storage.get("lease")).toBe("held");
    expect(await storage.compareAndSet("lease", null, "thief")).toBe(false);
    advance(2_000);
    expect(await storage.get("lease")).toBeNull();
    if (storage.list) expect(await storage.list("lease")).toEqual([]);
    expect(await storage.compareAndSet("lease", null, "next")).toBe(true);
  });

  it("replaces the previous expiry exactly as set would", async () => {
    const advance = fakeClock();
    const storage = await open();
    await storage.set("rev", "1", { ttlSeconds: 1 });
    expect(await storage.compareAndSet("rev", "1", "2")).toBe(true);
    advance(60_000);
    expect(await storage.get("rev")).toBe("2");
    expect(
      await storage.compareAndSet("rev", "2", "3", { ttlSeconds: 1 }),
    ).toBe(true);
    advance(2_000);
    expect(await storage.get("rev")).toBeNull();
  });
}
