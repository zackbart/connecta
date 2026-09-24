// Whose lifetime a shared catalog read runs on. A refresh flight shared across
// requests is bounded by its owner's deadline, whether or not its connector
// honors abort (#570); a read shared inside one request, and a flight shared
// across them, answers each reader on that reader's own deadline and
// cancellation rather than the first one's (#571).
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { InvocationService } from "../src/invocation.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { withDeadline } from "../src/timeout.js";
import type { Connector, KVStorage, Logger, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const READ: ToolDef = { name: "read", annotations: { readOnlyHint: true } };
const STALE: ToolDef = { name: "stale", annotations: { readOnlyHint: true } };

afterEach(() => {
  vi.useRealTimers();
});

/** Let every pending microtask and zero-delay timer run, moving no clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function recordingLogger(warnings: string[]): Logger {
  return { ...silentLogger, warn: (...args) => warnings.push(String(args[0])) };
}

/**
 * A connector whose first listing ignores its abort signal and settles only
 * when the test says so; every later listing answers at once.
 */
function stuckOnce(id: string) {
  let release: ((tools: ToolDef[]) => void) | undefined;
  const state = { calls: 0 };
  const connector = connectorWith({
    id,
    kind: "mcp",
    tools: () => {
      state.calls++;
      if (state.calls > 1) return Promise.resolve([READ]);
      return new Promise<ToolDef[]>((resolve) => {
        release = resolve;
      });
    },
  });
  return {
    connector,
    state,
    release: (tools: ToolDef[]) => required(release, "the stuck listing")(tools),
  };
}

/**
 * A connector that honors its signal and lists after `delayMs`, recording the
 * signal of every listing it starts.
 */
function honoring(id: string, delayMs: number) {
  const signals: AbortSignal[] = [];
  const connector = connectorWith({
    id,
    kind: "mcp",
    tools: (ctx) => {
      const signal = ctx.signal ?? new AbortController().signal;
      signals.push(signal);
      return new Promise<ToolDef[]>((resolve, reject) => {
        const timer = setTimeout(() => resolve([READ]), delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  return { connector, signals };
}

function registryOf(
  connector: Connector,
  storage: KVStorage = memoryStorage(),
  logger: Logger = silentLogger,
): Registry {
  return new Registry([connector], { storage, logger });
}

describe("a refresh flight's bound (#570)", () => {
  it("sends a waiting joiner to a fresh attempt at its bound and discards the stuck flight's late result", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const warnings: string[] = [];
    const stuck = stuckOnce("stuck");
    const registry = registryOf(stuck.connector, storage, recordingLogger(warnings));

    // Two requests: the first owns the flight, under a 1s deadline.
    const owner = registry.getTools("stuck", BASE, {}, { timeoutMs: 1_000 });
    await flush();
    const joiner = registry.getTools("stuck", BASE, {});
    let joinerSettled = false;
    void joiner.finally(() => {
      joinerSettled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(stuck.state.calls).toBe(1);
    expect(joinerSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(joiner).resolves.toEqual([READ]);
    expect(stuck.state.calls).toBe(2);
    expect(
      warnings.some((warning) => warning.includes("outlived its bound")),
    ).toBe(true);

    // The stuck listing finally lands. Its owner may still use it, but it
    // reaches neither cache layer, nor overwrites the fresh attempt's.
    stuck.release([STALE]);
    await expect(owner).resolves.toEqual([STALE]);
    await flush();
    await expect(registry.getTools("stuck", BASE)).resolves.toEqual([READ]);
    const cold = registryOf(stuck.connector, storage);
    await expect(cold.getTools("stuck", BASE)).resolves.toEqual([READ]);
    expect(stuck.state.calls).toBe(2);
  });

  it("gives a reader arriving after the bound a fresh attempt though nobody abandoned the flight yet", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const stuck = stuckOnce("unwatched");
    const registry = registryOf(stuck.connector, storage);

    // A search whose probe times out; the connector keeps listing regardless.
    const searched = new CatalogService(registry, BASE, {
      probeTimeoutMs: 500,
    }).search({ connector: "unwatched" });
    await vi.advanceTimersByTimeAsync(500);
    expect((await searched).queryAnalysis?.catalogError?.code).toBe("timeout");

    // A later request, after the bound, starts afresh rather than joining.
    await vi.advanceTimersByTimeAsync(100);
    await expect(
      new CatalogService(registry, BASE).loadConnector("unwatched"),
    ).resolves.toEqual([READ]);
    expect(stuck.state.calls).toBe(2);

    stuck.release([STALE]);
    await flush();
    await expect(registry.getTools("unwatched", BASE)).resolves.toEqual([READ]);
    const cold = registryOf(stuck.connector, storage);
    await expect(cold.getTools("unwatched", BASE)).resolves.toEqual([READ]);
    expect(stuck.state.calls).toBe(2);
  });

  it("does not cache a late result even when no fresh attempt replaced it", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const stuck = stuckOnce("late");
    const registry = registryOf(stuck.connector, storage);

    const owner = registry.getTools("late", BASE, {}, { timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(300);
    stuck.release([STALE]);
    await expect(owner).resolves.toEqual([STALE]);
    await flush();

    expect(await storage.get("catalog:late")).toBeNull();
    await expect(registry.getTools("late", BASE)).resolves.toEqual([READ]);
    expect(stuck.state.calls).toBe(2);
  });
});

describe("each reader's own deadline and cancellation (#571)", () => {
  it("fails a short-deadline call that starts the read and serves the search that joined it", async () => {
    vi.useFakeTimers();
    const slow = honoring("slow", 50);
    const registry = registryOf(slow.connector);
    const catalog = new CatalogService(registry, BASE, { probeTimeoutMs: 1_000 });

    const call = new InvocationService(registry, catalog).invoke(
      "slow.read",
      {},
      { source: "call_tool", timeoutMs: 10 },
    );
    await flush();
    const search = catalog.search({ connector: "slow" });

    await vi.advanceTimersByTimeAsync(10);
    const called = await call;
    expect(called.ok).toBe(false);
    expect(called.ok ? undefined : called.error.code).toBe("timeout");
    expect(required(slow.signals[0]).aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(40);
    const page = await search;
    expect(page.queryAnalysis?.catalogError).toBeUndefined();
    expect(page.entries.map((entry) => entry.tool.address)).toEqual([
      "slow.read",
    ]);
    expect(slow.signals).toHaveLength(1);
  });

  it("fails a cancelled starter with its own reason and serves a live joiner from the same read", async () => {
    vi.useFakeTimers();
    const slow = honoring("cancelled", 50);
    const catalog = new CatalogService(registryOf(slow.connector), BASE);
    const starter = new AbortController();
    const reason = new Error("starter cancelled");

    const started = catalog.loadConnector("cancelled", { signal: starter.signal });
    const joined = catalog.loadConnector("cancelled");
    await vi.advanceTimersByTimeAsync(5);
    starter.abort(reason);
    await expect(started).rejects.toBe(reason);
    expect(required(slow.signals[0]).aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(45);
    await expect(joined).resolves.toEqual([READ]);
    expect(slow.signals).toHaveLength(1);
  });

  it("ends a joiner on its own deadline while the starter still gets the catalog", async () => {
    vi.useFakeTimers();
    const slow = honoring("joiner_leaves", 50);
    const catalog = new CatalogService(registryOf(slow.connector), BASE);

    const started = catalog.loadConnector("joiner_leaves");
    const joined = withDeadline(
      (signal) => catalog.loadConnector("joiner_leaves", { signal }),
      { timeoutMs: 10, timeoutError: new Error("joiner timed out") },
    );
    const joinerFailed = expect(joined).rejects.toThrow("joiner timed out");
    await vi.advanceTimersByTimeAsync(10);
    await joinerFailed;

    await vi.advanceTimersByTimeAsync(40);
    await expect(started).resolves.toEqual([READ]);
    expect(slow.signals).toHaveLength(1);
  });

  it("stops the shared read once every reader has gone, and reads afresh for the next", async () => {
    vi.useFakeTimers();
    const slow = honoring("abandoned_read", 50);
    const catalog = new CatalogService(registryOf(slow.connector), BASE);
    const first = new AbortController();
    const second = new AbortController();

    const reads = [
      catalog.loadConnector("abandoned_read", { signal: first.signal }),
      catalog.loadConnector("abandoned_read", { signal: second.signal }),
    ];
    await flush();
    first.abort(new Error("first left"));
    await expect(reads[0]).rejects.toThrow("first left");
    expect(required(slow.signals[0]).aborted).toBe(false);
    second.abort(new Error("second left"));
    await expect(reads[1]).rejects.toThrow("second left");
    expect(required(slow.signals[0]).aborted).toBe(true);

    const again = catalog.loadConnector("abandoned_read");
    await vi.advanceTimersByTimeAsync(50);
    await expect(again).resolves.toEqual([READ]);
    expect(slow.signals).toHaveLength(2);
  });

  it("sends another request's joiner to a fresh attempt when the flight's owner is cancelled", async () => {
    vi.useFakeTimers();
    const slow = honoring("owner_cancelled", 50);
    const registry = registryOf(slow.connector);
    const owner = new AbortController();
    const reason = new Error("owner cancelled");

    const owned = registry.getTools("owner_cancelled", BASE, {}, {
      signal: owner.signal,
    });
    await flush();
    const joined = registry.getTools("owner_cancelled", BASE, {});
    await vi.advanceTimersByTimeAsync(5);
    owner.abort(reason);
    await expect(owned).rejects.toBe(reason);

    await vi.advanceTimersByTimeAsync(50);
    await expect(joined).resolves.toEqual([READ]);
    expect(slow.signals).toHaveLength(2);
    await expect(registry.getTools("owner_cancelled", BASE)).resolves.toEqual([
      READ,
    ]);
    expect(slow.signals).toHaveLength(2);
  });

  it("serves a long-deadline search in one request after a short-deadline search in another started the flight", async () => {
    vi.useFakeTimers();
    const slow = honoring("across", 50);
    const registry = registryOf(slow.connector);

    const short = new CatalogService(registry, BASE, { probeTimeoutMs: 10 })
      .search({ connector: "across" });
    await flush();
    const long = new CatalogService(registry, BASE, { probeTimeoutMs: 1_000 })
      .search({ connector: "across" });

    await vi.advanceTimersByTimeAsync(10);
    expect((await short).queryAnalysis?.catalogError?.message).toContain(
      'search_tools probe of "across" timed out after 10ms',
    );

    await vi.advanceTimersByTimeAsync(50);
    const page = await long;
    expect(page.queryAnalysis?.catalogError).toBeUndefined();
    expect(page.entries.map((entry) => entry.tool.address)).toEqual([
      "across.read",
    ]);
    expect(slow.signals).toHaveLength(2);
  });
});
