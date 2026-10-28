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
