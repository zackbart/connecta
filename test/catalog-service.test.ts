// The request-scoped catalog cache and the discovery probes above it
// (P1-S11). Ranking, rendering, and the wire shapes are guarded by
// catalog.test.ts, meta-tools-search.test.ts, and execute.test.ts; this suite
// guards ownership of catalog snapshots across consumers.
import { describe, expect, it, vi } from "vitest";
import * as lexicalCatalog from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import { MAX_CATALOG_TOOLS } from "../src/catalog-limits.js";
import { Effect } from "effect";
import { runEdge } from "../src/runtime/run.js";
import { openRequest } from "../src/runtime/call.js";
import type { ToolDef } from "../src/types.js";
import { ConnectorCallError } from "../src/errors.js";
import type { RegistryView } from "../src/registry.js";
import { connectorWith } from "./fixtures/connectors.js";
import { makeRegistry } from "./helpers.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthGrantKeys, scopes } from "../src/storage/keys.js";

const BASE = "https://connecta.test";

describe("request-scoped catalog cache", () => {
  it("performs zero additional storage get/list calls on unchanged repeat searches", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const connectors = ["records", "notes"].map((id) =>
      connectorWith({
        id,
        credential: { label: "Key" },
        tools: async (ctx) => {
          await ctx.credential!.get();
          await ctx.storage.get(oauthGrantKeys.grant);
          return [{ name: "read_record", annotations: { readOnlyHint: true } }];
        },
      }),
    );
    for (const { id } of connectors) {
      await vault.set(id, "credential", "alice");
      await storage.set(scopes.connector(id) + oauthGrantKeys.grant, "grant");
    }
    const get = vi.spyOn(storage, "get");
    const list = vi.spyOn(storage, "list");
    const service = new CatalogService(makeRegistry(connectors, { storage, credentialVault: vault }), BASE);
    try {
      expect((await service.search({ query: "record" })).entries).toHaveLength(2);
      expect(get).toHaveBeenCalled();
      get.mockClear();
      list.mockClear();
      for (const query of ["record", "read", "record"]) {
        expect((await service.search({ query })).entries).toHaveLength(2);
      }
      expect(get).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      list.mockRestore();
      openRequest(service.requestScope).close();
    }
  });

  it("does not join an older registry flight after invalidation in the same request", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    const registry = makeRegistry([
      connectorWith({
        id: "records",
        tools: async () => {
          if (++reads === 1) {
            entered();
            await waiting;
            return [{ name: "old_record", annotations: { readOnlyHint: true } }];
          }
          return [{ name: "new_record", annotations: { readOnlyHint: true } }];
        },
      }),
    ]);
    const service = new CatalogService(registry, BASE);
    try {
      const first = service.search({ query: "record" });
      await started;
      await registry.invalidateStored("records");
      const second = service.search({ query: "record" });
      release();
      await first;
      expect((await second).entries.map((entry) => entry.tool.name)).toEqual(["new_record"]);
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "new_record",
      ]);
    } finally {
      release();
      openRequest(service.requestScope).close();
    }
  });

  it("replaces a retained catalog and search index after invalidation and refresh in the same request", async () => {
    let name = "old_record";
    const registry = makeRegistry([
      connectorWith({ id: "records", tools: async () => [{ name, annotations: { readOnlyHint: true } }] }),
    ]);
    const service = new CatalogService(registry, BASE);
    try {
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "old_record",
      ]);
      name = "new_record";
      await registry.invalidateStored("records");
      expect((await registry.getTools("records", BASE, service.requestScope)).map((tool) => tool.name)).toEqual([
        "new_record",
      ]);
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "new_record",
      ]);
      expect((await service.search({ query: "old_record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "new_record",
      ]);
      expect((await service.loadConnector("records")).map((tool) => tool.name)).toEqual(["new_record"]);
    } finally {
      openRequest(service.requestScope).close();
    }
  });

  it.each(["invalidate", "set", "clear"])("revalidates credentials mid-request (%s)", async (operation) => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    await vault.set("records", "old-credential", "alice");
    const registry = makeRegistry(
      [
        connectorWith({
          id: "records",
          credential: { label: "Key" },
          tools: async (ctx) => [
            {
              name: (await ctx.credential!.get()) === "old-credential" ? "old_record" : "new_record",
              annotations: { readOnlyHint: true },
            },
          ],
        }),
      ],
      { storage, credentialVault: vault },
    );
    const service = new CatalogService(registry, BASE);
    try {
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "old_record",
      ]);
      if (operation === "clear") await vault.delete("records");
      else await vault.set("records", "new-credential", "alice");
      // The credential administration route invalidates after updating the vault.
      if (operation === "invalidate") await registry.invalidateStored("records");
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "new_record",
      ]);
      expect((await service.search({ query: "old_record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "new_record",
      ]);
    } finally {
      openRequest(service.requestScope).close();
    }
  });

  it("revalidates a stored OAuth grant change in the same request", async () => {
    const storage = memoryStorage();
    const key = scopes.connector("records") + oauthGrantKeys.grant;
    await storage.set(key, "old-grant");
    const registry = makeRegistry(
      [
        connectorWith({
          id: "records",
          tools: async (ctx) => [
            {
              name: (await ctx.storage.get(oauthGrantKeys.grant)) === "old-grant" ? "old_record" : "new_record",
              annotations: { readOnlyHint: true },
            },
          ],
        }),
      ],
      { storage },
    );
    const service = new CatalogService(registry, BASE);
    try {
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "old_record",
      ]);
      await storage.set(key, "new-grant");
      // OAuth connect/disconnect/restart routes invalidate after changing grants.
      await registry.invalidateStored("records");
      expect((await service.search({ query: "record" })).entries.map((entry) => entry.tool.name)).toEqual([
        "new_record",
      ]);
    } finally {
      openRequest(service.requestScope).close();
    }
  });

  it("INV-8: a native complete-catalog ceiling failure reaches Effect.result without a partial catalog", async () => {
    const connector = connectorWith({ id: "large", tools: Array(MAX_CATALOG_TOOLS + 1).fill({ name: "read" }) });
    const service = new CatalogService(makeRegistry([connector]), BASE);
    try {
      const result = await runEdge(Effect.result(service.loadConnectorEffect("large")));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ message: expect.stringContaining("complete-catalog ceiling") });
      const catalogs = await runEdge(service.listCatalogsEffect());
      expect(catalogs).toEqual([
        { connector, error: expect.objectContaining({ message: expect.stringContaining("complete-catalog ceiling") }) },
      ]);
    } finally {
      openRequest(service.requestScope).close();
    }
  });
  it("INV-1 INV-3: owns its snapshot and never shares definitions with discovery or invocation consumers", async () => {
    const original: ToolDef = {
      name: "read",
      classification: "read",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    };
    const registry = makeRegistry([connectorWith({ id: "owned", tools: [original] })]);
    // Simulate a registry view that returns the same mutable listing.
    const view = Object.assign(Object.create(registry) as typeof registry, {
      getTools: async () => [original],
    });
    const service = new CatalogService(view, BASE);
    const loaded = await service.loadConnector("owned");
    const mutate = (tool: ToolDef) => {
      tool.annotations!.readOnlyHint = false;
      (tool.inputSchema!.properties as Record<string, { type: string }>).id!.type = "number";
    };
    const expected = structuredClone(original);
    mutate(original);
    mutate(loaded[0]!);
    const resolution = await service.resolveTool("owned.read");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected a catalog resolution");
    expect(resolution.resolved.definition).toEqual(expected);
    mutate(resolution.resolved.definition);
    await expect(service.loadConnector("owned")).resolves.toEqual([expected]);
    const page = await service.search({ includeSchemas: "json" });
    mutate(page.entries[0]!.tool as ToolDef);
    const later = await service.search({ query: "read", includeSchemas: "json" });
    expect(later.entries[0]!.tool).toMatchObject(expected);
    const listed = await service.listCatalogs();
    if (!("tools" in listed[0]!)) throw new Error("expected a catalog listing");
    mutate(listed[0]!.tools[0]!);
    const described = await service.describe({ address: "owned.read", format: "json" });
    expect(described[0]).toMatchObject(expected);
    mutate(described[0] as ToolDef);
    await expect(service.loadConnector("owned")).resolves.toEqual([expected]);
  });
  it("reuses the indexed arrays per request and safety view without sharing caller definitions", async () => {
    const tools: ToolDef[] = [
      {
        name: "read_record",
        description: "Read a record",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object" },
      },
      { name: "write_record", description: "Write a record", annotations: { readOnlyHint: true } },
      { name: "hidden_record" },
    ];
    const registry = makeRegistry([connectorWith({ id: "records", tools })], {
      classification: { records: { hidden_record: "hidden", write_record: "write" } },
    });
    const service = new CatalogService(registry, BASE);
    const nextRequest = new CatalogService(registry, BASE);
    const readOnly = new CatalogService(registry, BASE, { readOnly: true });
    const rank = vi.spyOn(lexicalCatalog, "rankTools");
    try {
      const first = await service.search({ query: "record", safety: "readOnly", includeSchemas: "json" });
      const firstIndex = rank.mock.calls.at(-1)![0];
      const second = await service.search({ query: "read record", safety: "readOnly", includeSchemas: "json" });
      expect(rank.mock.calls.at(-1)![0]).toBe(firstIndex);
      expect(firstIndex.map((tool) => tool.name)).toEqual(["read_record"]);
      expect(second.entries[0]!.tool.inputSchema).not.toBe(first.entries[0]!.tool.inputSchema);
      expect(second.entries[0]!.tool.annotations).not.toBe(first.entries[0]!.tool.annotations);
      expect(first.entries[0]!.tool.inputSchema).not.toBe(firstIndex[0]!.inputSchema);

      await service.search({ query: "record", safety: "approvalRequired" });
      const writes = rank.mock.calls.at(-1)![0];
      expect(writes).not.toBe(firstIndex);
      expect(writes.map((tool) => tool.name)).toEqual(["write_record"]);
      await service.search({ query: "write record", safety: "approvalRequired" });
      expect(rank.mock.calls.at(-1)![0]).toBe(writes);
      await service.search({ query: "record" });
      const all = rank.mock.calls.at(-1)![0];
      expect(all.map((tool) => tool.name)).toEqual(["read_record", "write_record"]);
      await service.search({ query: "record", safety: "all" });
      expect(rank.mock.calls.at(-1)![0]).toBe(all);
      await service.search({ query: "record", safety: "readOnly" });
      expect(rank.mock.calls.at(-1)![0]).toBe(firstIndex);

      await nextRequest.search({ query: "record", safety: "readOnly" });
      expect(rank.mock.calls.at(-1)![0]).not.toBe(firstIndex);
      const visible = await readOnly.search({ query: "record" });
      const readOnlyIndex = rank.mock.calls.at(-1)![0];
      expect(readOnlyIndex).not.toBe(firstIndex);
      expect(visible.entries.map((entry) => entry.tool.name)).toEqual(["read_record"]);
      await readOnly.search({ query: "read record" });
      expect(rank.mock.calls.at(-1)![0]).toBe(readOnlyIndex);
      expect((await readOnly.search({ query: "record", safety: "approvalRequired" })).entries).toEqual([]);
    } finally {
      rank.mockRestore();
      for (const catalog of [service, nextRequest, readOnly]) openRequest(catalog.requestScope).close();
    }
  });

  it("evicts a failed read before building and reusing the recovered catalog's index", async () => {
    let attempts = 0;
    const connector = connectorWith({
      id: "recovering",
      tools: async () => {
        if (++attempts === 1) throw new Error("listing failed");
        return [{ name: "read_recovered", annotations: { readOnlyHint: true } }];
      },
    });
    const service = new CatalogService(makeRegistry([connector]), BASE);
    const rank = vi.spyOn(lexicalCatalog, "rankTools");
    try {
      const failure = await service.search({ query: "read" });
      expect(failure.catalogErrors).toHaveLength(1);
      expect(rank).not.toHaveBeenCalled();
      const recovered = await service.search({ query: "read" });
      const index = rank.mock.calls.at(-1)![0];
      expect(recovered.entries.map((entry) => entry.tool.name)).toEqual(["read_recovered"]);
      await service.search({ query: "recovered" });
      expect(rank.mock.calls.at(-1)![0]).toBe(index);
      expect(attempts).toBe(2);
    } finally {
      rank.mockRestore();
      openRequest(service.requestScope).close();
    }
  });
});

describe("discovery health across requests", () => {
  // A connector whose listing never answers until `healthy` is set; it ends only on its signal.
  function hangingConnector(id: string, state: { healthy: boolean; listings: number; answerMs?: number }) {
    return connectorWith({
      id,
      tools: async (ctx) => {
        state.listings++;
        if (state.healthy) {
          if (state.answerMs) await new Promise((resolve) => setTimeout(resolve, state.answerMs));
          return [{ name: "read_hung", annotations: { readOnlyHint: true } }];
        }
        return new Promise((_, reject) => {
          const signal = ctx.signal!;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
  }
  const healthy = connectorWith({ id: "notes", tools: [{ name: "read_note", annotations: { readOnlyHint: true } }] });

  async function searchOnce(
    registry: RegistryView,
    args: Parameters<CatalogService["search"]>[0],
    options: ConstructorParameters<typeof CatalogService>[2] = {},
  ) {
    const service = new CatalogService(registry, BASE, { probeTimeoutMs: 300, ...options });
    const started = Date.now();
    try {
      return { page: await service.search(args), ms: Date.now() - started };
    } finally {
      openRequest(service.requestScope).close();
    }
  }

  it("INV-6 INV-8: skips a hung connector on later unscoped searches and reports it with retryAfterMs", async () => {
    const storage = memoryStorage();
    const state = { healthy: false, listings: 0 };
    const registry = makeRegistry([hangingConnector("hung", state), healthy], { storage });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await searchOnce(registry, { query: "read" }));
    // The first search waits out the probe deadline; the next two do not.
    expect(runs[0]!.ms).toBeGreaterThanOrEqual(290);
    expect(runs[1]!.ms).toBeLessThan(200);
    expect(runs[2]!.ms).toBeLessThan(200);
    expect(state.listings).toBe(1);
    for (const { page } of runs) {
      expect(page.entries.map((entry) => entry.tool.address)).toEqual(["notes.read_note"]);
      expect(page.catalogErrors).toEqual([expect.objectContaining({ connector: "hung", code: "timeout" })]);
    }
    const skipped = runs[1]!.page.catalogErrors[0]!;
    expect(skipped.message).toBe(
      'Connector "hung" was skipped because its catalog lookup failed recently (timeout). Search with connector "hung" to try it now.',
    );
    expect(skipped.retryable).toBe(true);
    expect(skipped.retryAfterMs).toBeGreaterThan(50_000);
    expect(skipped.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Typed facts only: no tools, text or credentials in the stored record.
    const keys = await storage.list("connector-health:v1:hung:");
    expect(keys).toHaveLength(1);
    expect(Object.keys(JSON.parse((await storage.get(keys[0]!))!)).sort()).toEqual([
      "code",
      "generation",
      "observedAt",
      "retryAt",
      "v",
    ]);
  });

  it("probes a skipped connector on a scoped search and clears its record on recovery", async () => {
    const storage = memoryStorage();
    const state = { healthy: false, listings: 0 };
    const registry = makeRegistry([hangingConnector("hung", state), healthy], { storage });
    await searchOnce(registry, { query: "read" });
    state.healthy = true;
    expect((await searchOnce(registry, { query: "read" })).page.catalogErrors).toHaveLength(1);
    expect(state.listings).toBe(1);
    const scoped = await searchOnce(registry, { connector: "hung", query: "" });
    expect(scoped.page.entries.map((entry) => entry.tool.address)).toEqual(["hung.read_hung"]);
    expect(await storage.list("connector-health:v1:hung:")).toEqual([]);
    const unscoped = await searchOnce(registry, { query: "read" });
    expect(unscoped.page.catalogErrors).toEqual([]);
    expect(unscoped.page.entries.map((entry) => entry.tool.address).sort()).toEqual([
      "hung.read_hung",
      "notes.read_note",
    ]);
  });

  it("forgets a record when the connector's catalog generation rotates on a credential change", async () => {
    const storage = memoryStorage();
    const state = { healthy: false, listings: 0 };
    const registry = makeRegistry([hangingConnector("hung", state), healthy], { storage });
    await searchOnce(registry, { query: "read" });
    state.healthy = true;
    await registry.invalidateStored("hung");
    const next = await searchOnce(registry, { query: "read" });
    expect(next.page.catalogErrors).toEqual([]);
    expect(state.listings).toBe(2);
    expect(await storage.list("connector-health:v1:hung:")).toEqual([]);
  });

  it("INV-4 INV-5: keeps one owner's record out of another owner's search", async () => {
    const storage = memoryStorage();
    const state = { healthy: false, listings: 0 };
    const registry = makeRegistry([hangingConnector("hung", state), healthy], { storage });
    const alice = registry.scoped({ connectorIds: "all", principalKey: "alice" });
    const bob = registry.scoped({ connectorIds: "all", principalKey: "bob" });
    await searchOnce(alice, { query: "read" });
    expect(state.listings).toBe(1);
    await searchOnce(alice, { query: "read" });
    expect(state.listings).toBe(1);
    const other = await searchOnce(bob, { query: "read" });
    expect(other.ms).toBeGreaterThanOrEqual(290);
    expect(state.listings).toBe(2);
  });

  it("records nothing when the caller cancels or a fast failure answers", async () => {
    const storage = memoryStorage();
    const state = { healthy: false, listings: 0 };
    const failing = connectorWith({
      id: "flaky",
      tools: async () => {
        throw new ConnectorCallError("unavailable", "Upstream returned 503.");
      },
    });
    const registry = makeRegistry([hangingConnector("hung", state), failing, healthy], { storage });
    const caller = new AbortController();
    const service = new CatalogService(registry, BASE, { probeTimeoutMs: 1_000, requestSignal: caller.signal });
    const pending = service.search({ query: "read" });
    setTimeout(() => caller.abort(new Error("caller left")), 20);
    await pending.catch(() => undefined);
    openRequest(service.requestScope).close();
    await searchOnce(registry, { query: "read" });
    expect(await storage.list("connector-health:v1:hung:")).toHaveLength(1);
    expect(await storage.list("connector-health:v1:flaky:")).toEqual([]);
    expect(state.listings).toBe(2);
  });

  it("ends the unscoped fan-out at the discovery budget without recording the probes it cut short", async () => {
    const storage = memoryStorage();
    const states = [0, 1, 2].map(() => ({ healthy: false, listings: 0 }));
    const registry = makeRegistry(
      states.map((state, index) => hangingConnector(`hung${index}`, state)),
      { storage },
    );
    // One at a time: the first spends its deadline, the second gets what
    // remains of the budget, and the third never starts.
    const { page, ms } = await searchOnce(
      registry,
      { query: "read" },
      { probeTimeoutMs: 150, discoveryBudgetMs: 200, concurrency: 1 },
    );
    expect(ms).toBeGreaterThanOrEqual(190);
    expect(ms).toBeLessThan(400);
    expect(page.catalogErrors.map((error) => error.code)).toEqual(["timeout", "timeout", "timeout"]);
    expect(states.map((state) => state.listings)).toEqual([1, 1, 0]);
    expect(await storage.list("connector-health:v1:hung0:")).toHaveLength(1);
    expect(await storage.list("connector-health:v1:hung1:")).toEqual([]);
    expect(await storage.list("connector-health:v1:hung2:")).toEqual([]);
  });

  it("lets exactly one of many concurrent searches probe once a record's retry time passes", async () => {
    const storage = memoryStorage();
    const state: { healthy: boolean; listings: number; answerMs?: number } = { healthy: false, listings: 0 };
    const registry = makeRegistry([hangingConnector("hung", state), healthy], { storage });
    await searchOnce(registry, { query: "read" });
    const [key] = await storage.list("connector-health:v1:hung:");
    const record = JSON.parse((await storage.get(key!))!);
    await storage.set(key!, JSON.stringify({ ...record, retryAt: Date.now() - 1 }), {
      expiresAtMs: Date.now() + 60_000,
    });
    // The recovered connector answers slowly, so every search reads the record while one probes.
    state.healthy = true;
    state.answerMs = 100;
    const pages = await Promise.all(Array.from({ length: 8 }, () => searchOnce(registry, { query: "read" })));
    expect(state.listings).toBe(2);
    const probed = pages.filter(({ page }) => page.catalogErrors.length === 0);
    expect(probed).toHaveLength(1);
    expect(await storage.list("connector-health:v1:hung:")).toEqual([]);
  });
});
