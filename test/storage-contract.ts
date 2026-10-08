import { afterEach, expect, it, vi } from "vitest";
import type { KVStorage } from "../src/index.js";

/**
 * Values with NUL at the start, middle, and end, beside multi-byte UTF-8 and a
 * leading U+FEFF (a decoder must not take it for a byte order mark), and one
 * large enough to span many SQLite pages.
 */
export const NUL_VALUES: readonly string[] = [
  "\0",
  "\0\0\0",
  "\0start",
  "before\0after",
  "end\0",
  "é\0中\0😀",
  "\0😀",
  "😀\0",
  "\uFEFF\0bom",
  JSON.parse('{"sealed":"x\\u0000y"}').sealed as string,
  `${"x".repeat(256 * 1024)}\0${"é".repeat(1024)}\0`,
];

/**
 * Shared compare-and-set cases for every `KVStorage`. Not a suite: each
 * adapter's own suite calls this inside its `describe`, so the same contract
 * runs against memory, namespaced, SQLite, and D1 storage.
 *
 * Memory expiry uses a fake Date. SQL fixtures move stored expiry directly:
 * their database clock is independent of the caller's clock.
 */
export function compareAndSetContract(
  open: () => KVStorage | Promise<KVStorage>,
  advanceStoredExpiry?: (ms: number) => Promise<void>,
): void {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const fakeClock = () => {
    if (advanceStoredExpiry) return advanceStoredExpiry;
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    return (ms: number) => vi.setSystemTime(Date.now() + ms);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects NUL in every key operation and list prefix without touching other keys", async () => {
    const storage = await open();
    await storage.set("a", "original");
    for (const key of ["\0a", "a\0b", "a\0"]) {
      const operations = [
        () => storage.get(key),
        () => storage.set(key, "replacement"),
        () => storage.delete(key),
        () => storage.list(key),
        () => storage.compareAndSet(key, null, "new"),
        () => storage.compareAndSet(key, "original", "replacement"),
        () => storage.compareAndSet(key, "original", null),
        () => storage.compareAndSet(key, null, null),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow(
          new TypeError("Storage keys and list prefixes must not contain U+0000 (NUL)"),
        );
      }
    }
    expect(await storage.get("a")).toBe("original");
    expect(await storage.list("")).toEqual(["a"]);
  });

  it("keeps a value's NUL (U+0000) wherever it falls through get, set, list, and compareAndSet", async () => {
    // Keys may not hold NUL; values may. Node 22's `node:sqlite` ended a text
    // result at its first NUL, so every one of these once read back cut short.
    const storage = await open();
    for (const [index, value] of NUL_VALUES.entries()) {
      await storage.set(`nul:${index}`, value);
    }
    for (const [index, value] of NUL_VALUES.entries()) {
      expect(await storage.get(`nul:${index}`)).toBe(value);
    }
    expect(await storage.list("nul:")).toEqual(NUL_VALUES.map((_, index) => `nul:${index}`).sort());

    await storage.set("cas", "a\0b");
    expect(await storage.compareAndSet("cas", "a", "x")).toBe(false);
    expect(await storage.compareAndSet("cas", "a\0", "x")).toBe(false);
    expect(await storage.compareAndSet("cas", "a\0c", "x")).toBe(false);
    expect(await storage.get("cas")).toBe("a\0b");
    expect(await storage.compareAndSet("cas", "a\0b", null)).toBe(true);
    expect(await storage.get("cas")).toBeNull();
    expect(await storage.compareAndSet("cas", null, "\0é\0next")).toBe(true);
    expect(await storage.get("cas")).toBe("\0é\0next");
    expect(await storage.compareAndSet("cas", "\0é\0nex", "x")).toBe(false);
    expect(await storage.compareAndSet("cas", "\0é\0next", "then\0", { ttlSeconds: 60 })).toBe(true);
    expect(await storage.get("cas")).toBe("then\0");
    expect(await storage.compareAndSet("cas", "then\0", null)).toBe(true);
    expect(await storage.get("cas")).toBeNull();
  });

  it("lets exactly one of 50 concurrent claims on an absent key win", async () => {
    const storage = await open();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => storage.compareAndSet("claim", null, `owner-${i}`)),
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
    expect(await storage.list("lease")).toEqual([]);
    expect(await storage.compareAndSet("lease", null, "again")).toBe(true);
    expect(await storage.get("lease")).toBe("again");
  });

  it("counts an expired entry as absent", async () => {
    const advance = fakeClock();
    const storage = await open();
    await storage.set("lease", "stale", { ttlSeconds: 1 });
    expect(await storage.compareAndSet("lease", null, "fresh")).toBe(false);
    await advance(2_000);
    expect(await storage.compareAndSet("lease", "stale", "revived")).toBe(false);
    expect(await storage.compareAndSet("lease", null, "fresh")).toBe(true);
    expect(await storage.get("lease")).toBe("fresh");

    await storage.set("gone", "stale", { ttlSeconds: 1 });
    await advance(2_000);
    expect(await storage.compareAndSet("gone", null, null)).toBe(true);
    expect(await storage.get("gone")).toBeNull();
  });

  it("honors ttlSeconds on the value it writes", async () => {
    const advance = fakeClock();
    const storage = await open();
    expect(await storage.compareAndSet("lease", null, "held", { ttlSeconds: 10 })).toBe(true);
    await advance(9_000);
    expect(await storage.get("lease")).toBe("held");
    expect(await storage.compareAndSet("lease", null, "thief")).toBe(false);
    await advance(2_000);
    expect(await storage.get("lease")).toBeNull();
    expect(await storage.list("lease")).toEqual([]);
    expect(await storage.compareAndSet("lease", null, "next")).toBe(true);
  });

  it("INV-7: honors absolute expiry for set and CAS without restarting a delayed write's TTL", async () => {
    const advance = fakeClock();
    const storage = await open();
    const expiresAtMs = Date.now() + 60_000;
    await storage.set("absolute-set", "value", { expiresAtMs });
    expect(await storage.get("absolute-set")).toBe("value");
    expect(await storage.compareAndSet("absolute-cas", null, "value", { expiresAtMs })).toBe(true);
    expect(await storage.get("absolute-cas")).toBe("value");
    await advance(61_000);
    expect(await storage.get("absolute-set")).toBeNull();
    expect(await storage.get("absolute-cas")).toBeNull();
    const past = Date.now() - 60_000;
    await storage.set("late-set", "late", { expiresAtMs: past });
    expect(await storage.compareAndSet("late-cas", null, "late", { expiresAtMs: past })).toBe(true);
    expect(await storage.get("late-set")).toBeNull();
    expect(await storage.get("late-cas")).toBeNull();
    expect(await storage.list("late-")).toEqual([]);
  });

  it("refuses invalid or mixed absolute expiry options without changing a live value", async () => {
    const storage = await open();
    const invalid = [
      { expiresAtMs: Number.NaN },
      { expiresAtMs: Number.POSITIVE_INFINITY },
      { expiresAtMs: Number.MAX_VALUE },
      { expiresAtMs: 1.5 },
      { expiresAtMs: Date.now() + 60_000, ttlSeconds: 10 },
    ];
    for (const options of invalid) {
      await storage.set("absolute", "original");
      await expect(storage.set("absolute", "replacement", options)).rejects.toThrow();
      await expect(storage.compareAndSet("absolute", "original", "replacement", options)).rejects.toThrow();
      expect(await storage.get("absolute")).toBe("original");
      expect(await storage.compareAndSet("absolute", "different", "replacement", options)).toBe(false);
      expect(await storage.compareAndSet("absolute", "original", null, options)).toBe(true);
    }
  });

  it("refuses non-finite or overflowing TTLs without changing a live value", async () => {
    const storage = await open();
    for (const ttlSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE]) {
      await storage.set("ttl", "original");
      await expect(storage.set("ttl", "replacement", { ttlSeconds })).rejects.toThrow();
      expect(await storage.get("ttl")).toBe("original");
      await expect(storage.compareAndSet("ttl", "original", "replacement", { ttlSeconds })).rejects.toThrow();
      expect(await storage.get("ttl")).toBe("original");
    }
    expect(await storage.compareAndSet("ttl", "different", "replacement", { ttlSeconds: Number.NaN })).toBe(false);
    expect(await storage.compareAndSet("ttl", "original", null, { ttlSeconds: Number.NaN })).toBe(true);
  });

  it("replaces the previous expiry exactly as set would", async () => {
    const advance = fakeClock();
    const storage = await open();
    await storage.set("rev", "1", { ttlSeconds: 1 });
    expect(await storage.compareAndSet("rev", "1", "2")).toBe(true);
    await advance(60_000);
    expect(await storage.get("rev")).toBe("2");
    expect(await storage.compareAndSet("rev", "2", "3", { ttlSeconds: 1 })).toBe(true);
    await advance(2_000);
    expect(await storage.get("rev")).toBeNull();
  });
}
