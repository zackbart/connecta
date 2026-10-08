import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { catalogClientOptions, attachCatalogCache, catalogIntake, observeCatalogChange } from "../src/catalog-cache.js";
import { CatalogService } from "../src/catalog-service.js";
import { MAX_CATALOG_CHUNK_BYTES } from "../src/catalog-limits.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { callerOf } from "../src/connector-caller.js";
import { d1Storage } from "../src/d1.js";
import { Registry } from "../src/registry.js";
import { sqlStorage, type SqlStatement, type SqlDriver } from "../src/storage/sql.js";
import { sentSecretsFor, sentSecretsForRequest } from "../src/sent-secrets.js";
import { responseCacheKeys } from "../src/storage/keys.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, deferred, waitFor } from "./fixtures/misc.js";
import { silentLogger } from "./helpers.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";

const BASE = "https://connecta.test";
const TOKEN_A = "principal-a-secret/+=";
const TOKEN_B = "principal-b-secret/+=";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of closers.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// One portable suite, real D1 in workerd and the same SQL KV on node:sqlite.
async function storage(): Promise<KVStorage> {
  try {
    const module = "cloudflare:test";
    const { env } = await import(/* @vite-ignore */ module) as { env: { KV_COPY_TARGET: D1Database } };
    return d1Storage(env.KV_COPY_TARGET);
  } catch {
    const module = "node:sqlite";
    const { DatabaseSync } = await import(/* @vite-ignore */ module) as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    closers.push(() => db.close());
    const driver: SqlDriver = {
      async all<Row>({ sql, params }: SqlStatement) { return db.prepare(sql).all(...params) as Row[]; },
      async run({ sql, params }) { return Number(db.prepare(sql).run(...params).changes); },
      async batch(statements) {
        db.exec("BEGIN");
        try { const result = statements.map(({ sql, params }) => Number(db.prepare(sql).run(...params).changes)); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    };
    return sqlStorage(driver, "sqlite");
  }
}
async function fixture(options: { ttl?: number; scope?: "public" | "private"; legacy?: boolean; min?: number; max?: number; fallback?: number; sharedCredential?: boolean; description?: string; nextPage?: { ttl: number; scope: "public" | "private" } } = {}) {
  const store = await storage();
  const id = `catalog_${crypto.randomUUID().replaceAll("-", "")}`;
  let listings = 0; let mode: "ok" | "name" | "error" | "partial" | "header" | "paged" = "ok";
  const requests: string[] = [];
  const server = httpDownstream(mcp => mcp.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [] })));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.clone().json() as { method: string; id: string; params?: { cursor?: string } } : undefined;
    if (body?.method) requests.push(body.method);
    if (body?.method === "tools/list") {
      listings++;
      const token = request.headers.get("authorization")!.slice(7);
      if (mode === "error" || (mode === "partial" && body.params?.cursor)) return new Response(`Refused ${token}`, { status: 403 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        ...(options.legacy ? {} : { resultType: "complete" }),
        ...((body.params?.cursor ? options.nextPage?.ttl : options.ttl) === undefined ? {} : { ttlMs: body.params?.cursor ? options.nextPage?.ttl : options.ttl }),
        ...(options.legacy && options.scope === undefined ? {} : { cacheScope: (body.params?.cursor ? options.nextPage?.scope : options.scope) ?? "private" }),
        ...(mode === "partial" || (mode === "paged" && !body.params?.cursor) ? { nextCursor: "second" } : {}),
        tools: [{ name: body.params?.cursor ? "read_next" : mode === "name" ? `read_${token}` : mode === "header" ? "downstream-private-name" : "read", description: options.description ?? `Read ${token}`, inputSchema: { type: "object", properties: { [token]: { const: encodeURIComponent(token) }, ...(mode === "header" ? { bad: { type: "object", "x-mcp-header": "bad private declaration" } } : {}) } }, annotations: { readOnlyHint: true } }],
      } });
    }
    return server.fetch(input instanceof Request ? input.url : input, init);
  });
  const connector = remoteMcp(id, { url: server.url, versionNegotiation: options.legacy ? "legacy" : "auto", auth: { type: "request", token: async ctx => !options.sharedCredential && callerOf(ctx)?.identity.actor.id === "b" ? TOKEN_B : TOKEN_A } });
  const registry = () => new Registry([connector], { storage: store, logger: silentLogger, toolCacheTtlSeconds: options.fallback ?? 300, catalogMinTtlSeconds: options.min ?? 0, catalogMaxTtlSeconds: options.max ?? 86_400 });
  const read = async (root: Registry, principal = "a", pool = "one", requestScope = {}) => {
    const view = root.scoped({ connectorIds: [id], principalKey: principal, caller: { identity: { actor: { kind: "human", id: principal, namespace: "test" }, interactive: true }, authenticated: true, pool } });
    try { return await view.getTools(id, BASE, requestScope); }
    finally { await connector.closeScope?.(view.contextFor(id, BASE, requestScope)); }
  };
  return { store, id, connector, registry, read, requests, listings: () => listings, mode: (value: typeof mode) => { mode = value; } };
}

describe("SQL-backed SDK catalog cache", () => {
  it.each([
    { ttl: 2_000, expected: 2_000 },
    { ttl: 1, min: 2, max: 4, expected: 2_000 },
    { ttl: 50_000, min: 2, max: 4, expected: 4_000 },
    { ttl: Number.MAX_SAFE_INTEGER, expected: 86_400_000 },
    { legacy: true, fallback: 3, expected: 3_000 },
  ])("INV-7: honors hinted, legacy, and bounded TTL $expected on SQL", async options => {
    const f = await fixture(options);
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const initial = f.registry();
    await f.read(initial);
    const fetched = now;
    now += 1;
    const restarted = f.registry();
    await f.read(restarted);
    expect(restarted.catalogAgeMs(f.id)).toBe(now - fetched);
    expect(f.listings()).toBe(1);
    now += options.expected - 2;
    await f.read(f.registry()); expect(f.listings()).toBe(1);
    now += 2;
    await f.read(f.registry()); expect(f.listings()).toBe(2);
  });

  it.each([0, -1, 0.5, Infinity, NaN])("INV-8: never reuses an invalid or zero hint %s", async ttl => {
    const f = await fixture({ ttl });
    // Invalid modern wire hints fail validation; no catalog may be cached.
    const first = await f.read(f.registry()).catch(error => error);
    const second = await f.read(f.registry()).catch(error => error);
    expect(f.listings()).toBe(2);
    if (ttl === 0) { expect(first).toHaveLength(1); expect(second).toHaveLength(1); }
    else { expect(first).toBeInstanceOf(Error); expect(second).toBeInstanceOf(Error); }
  });

  it("INV-4 INV-5: private catalogs never cross principals or pools, including shared-auth connectors", async () => {
    const f = await fixture({ ttl: 60_000, scope: "private", sharedCredential: true });
    const root = f.registry();
    await f.read(root, "a", "one"); await f.read(root, "a", "one");
    await f.read(root, "a", "two"); await f.read(root, "b", "one");
    expect(f.listings()).toBe(3);
    await f.read(f.registry(), "b", "one"); expect(f.listings()).toBe(3);
  });

  it("INV-5 INV-6: public cache hits carry only intake-redacted success and no prior SentSecrets", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public" });
    const a = await f.read(f.registry());
    const scopeB = {};
    const b = await f.read(f.registry(), "b", "two", scopeB);
    expect(b).toEqual(a); expect(f.listings()).toBe(1);
    expect(JSON.stringify(b)).toContain("[redacted]");
    expect(JSON.stringify(b)).not.toContain(TOKEN_A);
    expect(sentSecretsForRequest(scopeB).text(TOKEN_A)).toBe(TOKEN_A);
    expect(sentSecretsForRequest(scopeB).text(TOKEN_B)).toBe("[redacted]");
    for (const key of await f.store.list(responseCacheKeys.prefix(f.id))) {
      expect(await f.store.get(key)).not.toContain(TOKEN_A);
      expect(await f.store.get(key)).not.toContain(encodeURIComponent(TOKEN_A));
    }
  });

  it("INV-5 INV-8: echoed tool names and later-page failures never enter the SDK cache", async () => {
    const f = await fixture({ ttl: 60_000 });
    const sdkList = vi.spyOn(Client.prototype, "listTools");
    f.mode("name"); await expect(f.read(f.registry())).rejects.toThrow("tool name");
    f.mode("partial"); await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied" });
    f.mode("ok"); await expect(f.read(f.registry())).resolves.toHaveLength(1);
    expect(f.listings()).toBe(4); expect(sdkList).toHaveBeenCalledTimes(3);
  });

  it("INV-6 INV-8: cache storage outages preserve downstream failure classification", async () => {
    const f = await fixture({ ttl: 60_000 });
    vi.spyOn(f.store, "get").mockRejectedValue(new Error(`Storage failed ${TOKEN_A}`));
    f.mode("error");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied", retryable: false });
    f.mode("ok"); await expect(f.read(f.registry())).resolves.toHaveLength(1);
    expect(f.listings()).toBe(2);
  });

  it("INV-8: a missing SQL chunk forces a complete live refresh", async () => {
    const f = await fixture({ ttl: 60_000 });
    await f.read(f.registry());
    const chunks = (await f.store.list("response-cache:v1:")).filter(key => key.includes(f.id) && key.includes(":chunk:"));
    expect(chunks).toHaveLength(1); await f.store.delete(chunks[0]!);
    await f.read(f.registry()); expect(f.listings()).toBe(2);
  });

  it.each([0, 1_000])("INV-8: later pages narrow public scope and TTL to %s before SDK publication", async ttl => {
    const f = await fixture({ ttl: 60_000, scope: "public", sharedCredential: true, nextPage: { ttl, scope: "private" } });
    f.mode("paged");
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await f.read(f.registry());
    await f.read(f.registry()); expect(f.listings()).toBe(ttl === 0 ? 4 : 2);
    await f.read(f.registry(), "b", "two"); expect(f.listings()).toBe(ttl === 0 ? 6 : 4);
    now += 1_001;
    await f.read(f.registry()); expect(f.listings()).toBe(ttl === 0 ? 8 : 6);
  });

  it("INV-6 INV-8: invalid header declarations fail before SDK logging or caching", async () => {
    const f = await fixture({ ttl: 60_000 });
    const warning = vi.spyOn(console, "warn");
    f.mode("header");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "connector_call_failed", retryable: false, message: "Downstream tool has an invalid x-mcp-header declaration." });
    expect(warning).not.toHaveBeenCalled();
    f.mode("ok"); await f.read(f.registry()); expect(f.listings()).toBe(2);
  });

  it.each([
    { "x-mcp-header": "top", type: "string" },
    { properties: { a: { type: "string", "x-mcp-header": "a" }, b: { type: "string", "x-mcp-header": "A" } } },
    { items: { properties: { a: { type: "string", "x-mcp-header": "a" } } } },
    { $defs: { a: { type: "string", "x-mcp-header": "a" } } },
  ])("INV-6 INV-8: refuses invalid header topology %# without quoting schema", schema => {
    expect(() => catalogIntake(connectorContext(), { tools: [{ name: "sensitive-name", inputSchema: { ...schema, type: "object" } }] })).toThrow("invalid x-mcp-header");
  });

  it("INV-8: incomplete SQL writes are misses and never hide a live failure", async () => {
    const f = await fixture({ ttl: 60_000 });
    const original = f.store.set.bind(f.store);
    vi.spyOn(f.store, "set").mockImplementation((key, ...args) => key.includes(":chunk:") ? Promise.reject(new Error("Write refused")) : original(key, ...args));
    await f.read(f.registry());
    f.mode("error");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied", retryable: false });
    expect(f.listings()).toBe(2);
  });

  it("INV-4 INV-6: public keys bind connector configuration and TTL policy rather than server identity", async () => {
    const store = await storage();
    const ctx = connectorContext(store);
    attachCatalogCache(ctx, { storage: store, partition: "a/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 86_400_000 });
    const id = `configuration_${crypto.randomUUID().replaceAll("-", "")}`;
    const a = await catalogClientOptions(ctx, id, "configuration-a", "grant");
    const key = { method: "tools/list", partition: JSON.stringify(["self-reported-server-a", ""]) };
    const value = JSON.stringify({ resultType: "complete", tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000, cacheScope: "public" });
    await a.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "public" });
    expect(await a.responseCacheStore!.get({ ...key, partition: JSON.stringify(["self-reported-server-b", ""]) })).toBeDefined();
    const changed = await catalogClientOptions(ctx, id, "configuration-b", "grant");
    const otherConnector = await catalogClientOptions(ctx, id + "_other", "configuration-a", "grant");
    expect(await changed.responseCacheStore!.get(key)).toBeUndefined();
    expect(await otherConnector.responseCacheStore!.get(key)).toBeUndefined();
    attachCatalogCache(ctx, { storage: store, partition: "a/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 30_000 });
    const bounded = await catalogClientOptions(ctx, id, "configuration-a", "grant");
    expect(await bounded.responseCacheStore!.get(key)).toBeUndefined();
  });

  it("INV-5 INV-8: invalidation prevents an old in-flight SDK cache from resurrecting", async () => {
    const store = await storage();
    const id = `invalidate_${crypto.randomUUID().replaceAll("-", "")}`;
    const ctx = connectorContext(store);
    attachCatalogCache(ctx, { storage: store, partition: "a/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 86_400_000 });
    const old = await catalogClientOptions(ctx, id, "configuration", "grant");
    const key = { method: "tools/list", partition: JSON.stringify(["same-server", old.cachePartition]) };
    await old.responseCacheStore!.get(key);
    await new Registry([], { storage: store, logger: silentLogger }).invalidateStored(id);
    const value = JSON.stringify({ resultType: "complete", tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000, cacheScope: "private" });
    await old.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "private" });
    const fresh = await catalogClientOptions(ctx, id, "configuration", "grant");
    expect(await fresh.responseCacheStore!.get(key)).toBeUndefined();
    sentSecretsFor(ctx).add(TOKEN_A);
    await expect(fresh.responseCacheStore!.set(key, { value: value.replace('"read"', JSON.stringify(TOKEN_A)), expiresAt: Date.now() + 60_000, scope: "private" })).rejects.toThrow("tool name");
  });

  it.each(([
    { oldScope: "private", newScope: "private" },
    { oldScope: "private", newScope: "public" },
    { oldScope: "public", newScope: "private" },
    { oldScope: "public", newScope: "public" },
  ] as const).flatMap(scopes => (["legacy", "auto"] as const).map(versionNegotiation => ({ ...scopes, versionNegotiation }))))("INV-4 INV-6 INV-8: real $versionNegotiation SDK list_changed fences late $oldScope publication after a $newScope listing", async ({ oldScope, newScope, versionNegotiation }) => {
    const store = await storage();
    const id = `notification_${crypto.randomUUID().replaceAll("-", "")}`;
    // Both clients start in one established generation. The first refresh
    // must pin it even though the SDK deliberately skips all cache reads.
    await new Registry([], { storage: store, logger: silentLogger }).invalidateStored(id);
    const entered = deferred<void>(); const release = deferred<void>();
    const servers: Server[] = [];
    let listings = 0; let deletes = 0;
    const sdkList = Client.prototype.listTools;
    let first = true;
    vi.spyOn(Client.prototype, "listTools").mockImplementation(function (this: Client, params, options) {
      // A refresh skips cache reads. Its first eventual publication must
      // already belong to the generation from before the wire request.
      const refresh = first; first = false;
      return sdkList.call(this, params, refresh ? { ...options, cacheMode: "refresh" } : options);
    });
    const deletion = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async key => { await deletion(key); deletes++; });
    const connector = remoteMcp(id, {
      url: "https://downstream.test/mcp", versionNegotiation,
      _transportFactory: () => {
        const [client, peer] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true } } });
        const index = servers.length; servers.push(server);
        server.setRequestHandler("tools/list", async () => {
          listings++;
          if (index === 0) { entered.resolve(); await release.promise; }
          return { tools: [{ name: index === 0 ? "old_catalog" : "new_catalog", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], ttlMs: 60_000, cacheScope: index === 0 ? oldScope : newScope };
        });
        const connected = server.connect(peer);
        closers.push(async () => { await connected; await server.close(); });
        return client;
      },
    });
    const context = (principal: string) => {
      const ctx = { ...connectorContext(store), requestScope: {} };
      attachCatalogCache(ctx, { storage: store, partition: `${principal}/pool`, defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 86_400_000 });
      closers.push(() => connector.closeScope!(ctx));
      return ctx;
    };
    const old = connector.listTools(context("a"));
    try {
      await entered.promise;
      expect((await connector.listTools(context("b"))).map(tool => tool.name)).toEqual(["new_catalog"]);
      const generation = await store.get(responseCacheKeys.generation(id));
      deletes = 0;
      await servers[1]!.notification({ method: "notifications/tools/list_changed" });
      // Wait for the real SDK eviction to finish before releasing the old wire
      // response. SDK 2.3.1 deletes both slots; a rotated generation also makes
      // them unreachable, without depending on an arbitrary sleep.
      await waitFor(async () => deletes === 2 || await store.get(responseCacheKeys.generation(id)) !== generation);
      release.resolve();
      expect((await old).map(tool => tool.name)).toEqual(["old_catalog"]);
      expect((await connector.listTools(context("a"))).map(tool => tool.name)).toEqual(["new_catalog"]);
      expect(listings).toBe(3);
      expect((await connector.listTools(context("a"))).map(tool => tool.name)).toEqual(["new_catalog"]);
      expect(listings).toBe(3);
      const warning = vi.spyOn(silentLogger, "warn");
      const writing = store.set.bind(store);
      vi.spyOn(store, "set").mockImplementation((key, ...args) => key === responseCacheKeys.generation(id)
        ? Promise.reject(new Error(`Fence refused ${TOKEN_A}`)) : writing(key, ...args));
      await servers[1]!.notification({ method: "notifications/tools/list_changed" });
      await waitFor(() => warning.mock.calls.length > 0);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(TOKEN_A);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("Fence refused");
      expect((await connector.listTools(context("a"))).map(tool => tool.name)).toEqual(["new_catalog"]);
    } finally { release.resolve(); await old.catch(() => {}); }
  });

  it.each(["deadline", "teardown"] as const)("INV-7 INV-8: starts no cache I/O after %s while a chunk write is pending", async ending => {
    const f = await fixture({ ttl: 60_000, description: "x".repeat(MAX_CATALOG_CHUNK_BYTES + 100) });
    const entered = deferred<void>(); const release = deferred<void>(); const settled = deferred<void>();
    let ctx: ConnectorContext | undefined; let closed = false; let chunks = 0;
    const late: string[] = [];
    const start = (operation: string) => { if (closed || ctx?.signal?.aborted) late.push(operation); };
    const listTools = f.connector.listTools.bind(f.connector);
    vi.spyOn(f.connector, "listTools").mockImplementation(async context => {
      ctx = context;
      try { return await listTools(context); } finally { settled.resolve(); }
    });
    const get = f.store.get.bind(f.store); const set = f.store.set.bind(f.store);
    const deletion = f.store.delete.bind(f.store); const cas = f.store.compareAndSet.bind(f.store);
    vi.spyOn(f.store, "get").mockImplementation(key => { start("get"); return get(key); });
    vi.spyOn(f.store, "delete").mockImplementation(key => { start("delete"); return deletion(key); });
    const publication = vi.spyOn(f.store, "compareAndSet").mockImplementation((...args) => { start("compareAndSet"); return cas(...args); });
    vi.spyOn(f.store, "set").mockImplementation(async (key, ...args) => {
      start("set");
      if (key.includes(":chunk:") && ++chunks === 1) { entered.resolve(); await release.promise; }
      return set(key, ...args);
    });
    const root = f.registry(); const requestScope = {};
    const search = ending === "deadline"
      ? new CatalogService(root, BASE, { requestScope, probeTimeoutMs: 1_000 }).search({ connector: f.id })
      : f.connector.listTools(root.contextFor(f.id, BASE, requestScope));
    try {
      await entered.promise;
      if (ending === "deadline") {
        const result = await search as Awaited<ReturnType<CatalogService["search"]>>;
        expect(result.queryAnalysis?.catalogError?.code).toBe("timeout");
        expect(ctx?.signal?.aborted).toBe(true);
      }
      closed = true;
      await f.connector.closeScope!(root.contextFor(f.id, BASE, requestScope));
      release.resolve();
      await settled.promise;
      await search;
      expect(chunks).toBe(1);
      expect(late).toEqual([]);
      expect(publication.mock.calls.filter(([key]) => key.startsWith(responseCacheKeys.prefix(f.id)) && !key.endsWith(":generation"))).toEqual([]);
      const keys = await f.store.list(responseCacheKeys.prefix(f.id));
      expect(keys.filter(key => !key.includes(":chunk:") && !key.endsWith(":generation"))).toEqual([]);
      vi.restoreAllMocks();
      await f.read(f.registry());
      expect(f.listings()).toBe(2);
    } finally { release.resolve(); await settled.promise; await search.catch(() => {}); }
  });

  it("INV-7: bounds teardown while notification invalidation storage is blocked", async () => {
    const f = await fixture({ ttl: 60_000 });
    const ctx = f.registry().contextFor(f.id, BASE, {});
    await f.connector.listTools(ctx);
    closers.push(() => f.connector.closeScope!(ctx));
    const entered = deferred<void>(); const release = deferred<void>(); const settled = deferred<void>();
    const set = f.store.set.bind(f.store);
    let writes = 0;
    vi.spyOn(f.store, "set").mockImplementation(async (key, ...args) => {
      if (key === responseCacheKeys.generation(f.id)) {
        writes++; entered.resolve(); await release.promise;
        try { return await set(key, ...args); } finally { settled.resolve(); }
      }
      return set(key, ...args);
    });
    // The real notification path is exercised above. Block the same observer's
    // storage I/O here so teardown's own deadline is the only possible exit.
    observeCatalogChange(ctx, f.id);
    await entered.promise;
    vi.useFakeTimers();
    const closing = f.connector.closeScope!(ctx);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;
      observeCatalogChange(ctx, f.id);
      expect(writes).toBe(1);
    } finally {
      release.resolve(); vi.useRealTimers(); await settled.promise; await closing;
    }
  });
});
