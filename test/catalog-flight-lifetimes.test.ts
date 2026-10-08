// Catalog reads share I/O only within one request. Each asker retains its own
// deadline and cancellation; independent requests never inherit another lifetime.
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
afterEach(() => { vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

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
    await expect(joined).resolves.toEqual([{ ...READ, classification: "read" }]);
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
    await expect(started).resolves.toEqual([{ ...READ, classification: "read" }]);
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
    await expect(again).resolves.toEqual([{ ...READ, classification: "read" }]);
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
    await expect(joined).resolves.toEqual([{ ...READ, classification: "read" }]);
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
    expect((await short).queryAnalysis?.catalogError?.message).toBe('Connector "across" catalog lookup failed (timeout).');

    await vi.advanceTimersByTimeAsync(50);
    const page = await long;
    expect(page.queryAnalysis?.catalogError).toBeUndefined();
    expect(page.entries.map((entry) => entry.tool.address)).toEqual([
      "across.read",
    ]);
    expect(slow.signals).toHaveLength(2);
  });
});
