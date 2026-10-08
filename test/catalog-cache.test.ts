import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { catalogClientOptions, attachCatalogCache, catalogIntake, invalidateCatalogCache, observeCompletedCatalogRefresh, type CompletedCatalogRefresh } from "../src/catalog-cache.js";
import { CatalogService } from "../src/catalog-service.js";
import { MAX_CATALOG_CHUNK_BYTES } from "../src/catalog-limits.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { callerOf } from "../src/connector-caller.js";
import { d1Storage } from "../src/d1.js";
import { createExecuteTool } from "../src/execute.js";
import { Registry } from "../src/registry.js";
import { sqlStorage, type SqlStatement, type SqlDriver } from "../src/storage/sql.js";
import { sentSecretsFor, sentSecretsForRequest } from "../src/sent-secrets.js";
import { responseCacheKeys } from "../src/storage/keys.js";
import { withDeadline } from "../src/timeout.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, deferred, scriptedExecutor, waitFor } from "./fixtures/misc.js";
import { required, silentLogger } from "./helpers.js";
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
async function fixture(options: { ttl?: number; scope?: "public" | "private"; legacy?: boolean; min?: number; max?: number; fallback?: number; sharedCredential?: boolean; description?: string; operatorShared?: boolean; nextPage?: { ttl: number; scope: "public" | "private" } } = {}) {
  const store = await storage();
  const id = `catalog_${crypto.randomUUID().replaceAll("-", "")}`;
  let tokenA = TOKEN_A;
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
  const connector = remoteMcp(id, { url: server.url, versionNegotiation: options.legacy ? "legacy" : "auto", auth: options.operatorShared ? { type: "headers", headers: { Authorization: `Bearer ${TOKEN_A}` } } : { type: "request", token: async ctx => !options.sharedCredential && callerOf(ctx)?.identity.actor.id === "b" ? TOKEN_B : tokenA } });
  const registry = () => new Registry([connector], { storage: store, logger: silentLogger, toolCacheTtlSeconds: options.fallback ?? 300, catalogMinTtlSeconds: options.min ?? 0, catalogMaxTtlSeconds: options.max ?? 86_400 });
  const read = async (root: Registry, principal = "a", pool = "one", requestScope = {}, baseUrl = BASE) => {
    const view = root.scoped({ connectorIds: [id], principalKey: principal, caller: { identity: { actor: { kind: "human", id: principal, namespace: "test" }, interactive: true }, authenticated: true, pool } });
    try { return await view.getTools(id, baseUrl, requestScope); }
    finally { await connector.closeScope?.(view.contextFor(id, baseUrl, requestScope)); }
  };
  return { store, id, connector, registry, read, requests, rotate: (token: string) => { tokenA = token; }, listings: () => listings, mode: (value: typeof mode) => { mode = value; } };
}

describe("SQL-backed SDK catalog cache", () => {
  it("INV-6 INV-8: observes one completed SDK catalog refresh with previous and new digests, excluding hits and failures", async () => {
    const store = await storage(); const id = `refresh_${crypto.randomUUID().replaceAll("-", "")}`;
    const ctx = { ...connectorContext(store), requestScope: {} };
    const refreshes: CompletedCatalogRefresh[] = [];
    attachCatalogCache(ctx, { storage: store, partition: "principal/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 86_400_000,
      onCompletedCatalogRefresh: (refresh, observed) => { expect(observed).toBe(ctx); refreshes.push(refresh); } });
    let revision = "old"; let fail = false; let server: Server;
    const connector = remoteMcp(id, { url: "https://downstream.test/mcp", _transportFactory: () => {
      const [client, peer] = InMemoryTransport.createLinkedPair();
      server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true } } });
      server.setRequestHandler("tools/list", async request => {
        if (fail && request.params?.cursor) throw new Error("private-listing-failure");
        return { tools: [{ name: `${revision}_${request.params?.cursor ? "second" : "first"}`, inputSchema: { type: "object" } }],
          ...(!request.params?.cursor ? { nextCursor: "second" } : {}), ttlMs: 60_000, cacheScope: "private" };
      });
      const connected = server.connect(peer);
      closers.push(async () => { await connected; await server.close(); });
      return client;
    } });
    closers.push(() => connector.closeScope!(ctx));
    await connector.listTools(ctx); await connector.listTools(ctx);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ connectorId: id, digest: expect.stringMatching(/^sha256:/) });
    expect(refreshes[0]!.previousDigest).toBeUndefined();
    const generation = await store.get(responseCacheKeys.generation(id));
    fail = true;
    await server!.notification({ method: "notifications/tools/list_changed" });
    await waitFor(async () => await store.get(responseCacheKeys.generation(id)) !== generation);
    await expect(connector.listTools(ctx)).rejects.toThrow();
    expect(refreshes).toHaveLength(1);
    fail = false; revision = "new";
    await connector.listTools(ctx); await connector.listTools(ctx);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]!.previousDigest).toBe(refreshes[0]!.digest);
    expect(refreshes[1]!.digest).not.toBe(refreshes[0]!.digest);
  });

  it("INV-5 INV-8: OAuth credential identities fence cache hits and mid-listing publication without an epoch change", async () => {
    const store = await storage(); const ctx = connectorContext(store);
    const id = `oauth_identity_${crypto.randomUUID().replaceAll("-", "")}`;
    let identity = "credential-digest-a";
    const cache = await catalogClientOptions(ctx, id, "oauth-configuration", "same-epoch", undefined, undefined, "private", async () => identity);
    const key = { method: "tools/list", partition: JSON.stringify(["server", cache.cachePartition]) };
    const value = JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000, cacheScope: "private" });
    await cache.withListing(ctx, async () => cache.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "private" }));
    await cache.withListing(ctx, async () => { expect(await cache.responseCacheStore!.get(key)).toBeDefined(); });
    identity = "credential-digest-b";
    await cache.withListing(ctx, async () => { expect(await cache.responseCacheStore!.get(key)).toBeUndefined(); });
    await cache.withListing(ctx, async () => {
      identity = "credential-digest-c";
      expect(await cache.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "private" })).toBe(0);
    });
  });

  it("INV-6 INV-8: refresh digest baselines survive invalidation and a new request without retaining catalogs", async () => {
    const store = await storage(); const id = `refresh_restart_${crypto.randomUUID().replaceAll("-", "")}`;
    const refreshes: CompletedCatalogRefresh[] = [];
    const refresh = async (name: string) => {
      const ctx = connectorContext(store);
      attachCatalogCache(ctx, { storage: store, partition: "principal/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 86_400_000,
        onCompletedCatalogRefresh: value => { refreshes.push(value); } });
      const cache = await catalogClientOptions(ctx, id, "configuration", "grant");
      await cache.withListing(ctx, async () => {
        const digests = await cache.completeCatalogRefresh({ tools: [{ name, inputSchema: { type: "object" } }], ttlMs: 0 });
        if (digests) await observeCompletedCatalogRefresh(ctx, digests);
      });
    };
    await refresh("old"); await invalidateCatalogCache(store, id); await refresh("new");
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]!.previousDigest).toBe(refreshes[0]!.digest);
    const keys = (await store.list(responseCacheKeys.prefix(id))).filter(key => key.includes(":refresh-digest:") && !key.includes(":chunk:"));
    expect(keys).toHaveLength(1);
    const baseline = await store.get(keys[0]!);
    const manifest = JSON.parse(baseline!);
    expect(manifest).toMatchObject({ digest: refreshes[1]!.digest, chunkCount: 1 });
    const facts = await store.get(responseCacheKeys.chunk(keys[0]!, manifest.revision, 0));
    expect(JSON.parse(facts!)).toEqual(refreshes[1]!.next);
    expect(facts).not.toMatch(/old|new|inputSchema/);
    expect(baseline).not.toMatch(/old|new|inputSchema/);
  });

  it("INV-6 INV-8: publishes chunked hash baselines and rejects torn baseline facts", async () => {
    const store = await storage(); const ctx = connectorContext(store);
    const id = `refresh_chunks_${crypto.randomUUID().replaceAll("-", "")}`;
    const cache = await catalogClientOptions(ctx, id, "configuration", "grant");
    const tools = Array.from({ length: 7_000 }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: "object" as const } }));
    const refresh = () => cache.withListing(ctx, () => cache.completeCatalogRefresh({ tools, ttlMs: 0 }));
    const first = await refresh();
    expect(first?.previous).toBeUndefined();
    const keys = (await store.list(responseCacheKeys.prefix(id))).filter(key => key.includes(":refresh-digest:") && !key.includes(":chunk:"));
    expect(keys).toHaveLength(1);
    const manifest = JSON.parse((await store.get(keys[0]!))!);
    expect(manifest.chunkCount).toBeGreaterThan(1);
    for (let index = 0; index < manifest.chunkCount; index++) {
      const chunk = (await store.get(responseCacheKeys.chunk(keys[0]!, manifest.revision, index)))!;
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(MAX_CATALOG_CHUNK_BYTES);
      expect(chunk).not.toContain("tool_");
    }
    const second = await refresh();
    expect(second?.previous).toEqual(first?.next);
    const current = JSON.parse((await store.get(keys[0]!))!);
    await store.delete(responseCacheKeys.chunk(keys[0]!, current.revision, 0));
    const torn = await refresh();
    expect(torn?.previous).toBeUndefined();
    expect(torn?.previousDigest).toBeUndefined();
  });

  it("INV-4 INV-5: private auth modes refuse the SDK's empty shared slot", async () => {
    const store = await storage(); const ctx = connectorContext(store);
    const id = `private_slot_${crypto.randomUUID().replaceAll("-", "")}`;
    const cache = await catalogClientOptions(ctx, id, "configuration", "private-grant");
    const key = { method: "tools/list", partition: JSON.stringify(["server", ""]) };
    const value = JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000, cacheScope: "public" });
    expect(await cache.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "public" })).toBe(0);
    expect(await cache.responseCacheStore!.get(key)).toBeUndefined();
    expect(await store.list(responseCacheKeys.prefix(id))).toEqual([]);
  });

  it.each([0, 1])("INV-7 INV-8: closing temporary instance %s preserves another instance with the same connector id and request scope", async closing => {
    const store = await storage(); const id = `instances_${crypto.randomUUID().replaceAll("-", "")}`;
    const ctx = { ...connectorContext(store), requestScope: {} };
    attachCatalogCache(ctx, { storage: store, partition: "principal/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 86_400_000 });
    const servers: Server[] = [];
    let changed = false; let listings = 0;
    const instance = () => {
      const connector = remoteMcp(id, {
        url: "https://downstream.test/mcp",
        _transportFactory: () => {
          const [client, peer] = InMemoryTransport.createLinkedPair();
          const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true } } });
          servers.push(server);
          server.setRequestHandler("tools/list", async () => {
            listings++;
            return { tools: [{ name: changed ? "new_catalog" : "old_catalog", inputSchema: { type: "object" } }], ttlMs: 60_000, cacheScope: "private" };
          });
          const connected = server.connect(peer);
          closers.push(async () => { await connected; await server.close(); });
          return client;
        },
      });
      closers.push(() => connector.closeScope!(ctx));
      return connector;
    };
    const pair = [instance(), instance()];
    for (const connector of pair) expect((await connector.listTools(ctx)).map(tool => tool.name)).toEqual(["old_catalog"]);
    expect(listings).toBe(1);
    await pair[closing]!.closeScope!(ctx);
    const live = pair[1 - closing]!;
    expect((await live.listTools(ctx)).map(tool => tool.name)).toEqual(["old_catalog"]);
    expect(listings).toBe(1);
    const generation = await store.get(responseCacheKeys.generation(id));
    changed = true;
    await servers[1 - closing]!.notification({ method: "notifications/tools/list_changed" });
    await waitFor(async () => await store.get(responseCacheKeys.generation(id)) !== generation);
    expect((await live.listTools(ctx)).map(tool => tool.name)).toEqual(["new_catalog"]);
    expect((await live.listTools(ctx)).map(tool => tool.name)).toEqual(["new_catalog"]);
    expect(listings).toBe(2);
    await live.closeScope!(ctx);
    // A later temporary client in this still-live outer request owns a fresh
    // lifetime and can reuse the surviving client's complete publication.
    expect((await instance().listTools(ctx)).map(tool => tool.name)).toEqual(["new_catalog"]);
    expect(listings).toBe(2);
    await expect(pair[closing]!.listTools(ctx)).rejects.toThrow("scope ended");
  });

  it.each((["resource", "listing"] as const).flatMap(operation => (["public", "private"] as const).map(scope => ({ operation, scope }))))("INV-7 INV-8: a completed $operation keeps connection notifications and later $scope SDK cache operations live", async ({ operation, scope }) => {
    const store = await storage();
    const id = `completed_${crypto.randomUUID().replaceAll("-", "")}`;
    const servers: Server[] = [];
    let changed = false; let listings = 0;
    const connector = remoteMcp(id, {
      url: "https://downstream.test/mcp",
      auth: { type: "headers", headers: { "X-API-Key": TOKEN_A } },
      _transportFactory: () => {
        const [client, peer] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true }, resources: {} } });
        servers.push(server);
        server.setRequestHandler("tools/list", async () => {
          listings++;
          return { tools: [{ name: changed ? "new_catalog" : "old_catalog", description: `Catalog ${TOKEN_A}`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], ttlMs: 60_000, cacheScope: scope };
        });
        server.setRequestHandler("resources/list", async () => ({ resources: [{ name: "manual", uri: "docs://manual/start" }], ttlMs: 60_000, cacheScope: "private" }));
        server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [], ttlMs: 60_000, cacheScope: "private" }));
        server.setRequestHandler("resources/read", async request => ({ contents: [{ uri: request.params.uri, text: "resource" }] }));
        const connected = server.connect(peer);
        closers.push(async () => { await connected; await server.close(); });
        return client;
      },
    });
    const root = new Registry([connector], { storage: store, logger: silentLogger });
    const seed = {};
    expect((await root.getTools(id, BASE, seed)).map(tool => tool.name)).toEqual(["old_catalog"]);
    await connector.closeScope!(root.contextFor(id, BASE, seed));
    const listingScope = {};
    if (operation === "listing") closers.push(() => connector.closeScope!(root.contextFor(id, BASE, listingScope)));
    let completed: ConnectorContext | undefined;
    const original = operation === "resource" ? connector.readResource!.bind(connector) : connector.listTools.bind(connector);
    if (operation === "resource") connector.readResource = async (uri, ctx) => { completed = ctx; return (original as NonNullable<typeof connector.readResource>)(uri, ctx); };
    else connector.listTools = async ctx => { completed = ctx; return (original as typeof connector.listTools)(ctx); };
    const output = await createExecuteTool(root, BASE, scriptedExecutor(async fns => {
      if (operation === "resource") await required(fns.read)(`resource://${id}/${encodeURIComponent("docs://manual/start")}`);
      else await withDeadline(signal => connector.listTools(root.contextFor(id, BASE, listingScope, { signal })), { timeoutMs: 1_000, timeoutError: new Error("Opening listing deadline") });
      const ctx = required(completed);
      expect(ctx.signal?.aborted).toBe(true);
      const liveList = () => withDeadline(signal => connector.listTools(root.contextFor(id, BASE, ctx.requestScope, { signal })), { timeoutMs: 1_000, timeoutError: new Error("Listing deadline") });
      expect((await liveList()).map(tool => tool.name)).toEqual(["old_catalog"]);
      expect(listings).toBe(1);
      const generation = await store.get(responseCacheKeys.generation(id));
      changed = true;
      await servers[1]!.notification({ method: "notifications/tools/list_changed" });
      await waitFor(async () => await store.get(responseCacheKeys.generation(id)) !== generation);
      // This is the same live client whose opening operation already ended.
      expect((await liveList()).map(tool => tool.name)).toEqual(["new_catalog"]);
      expect(listings).toBe(2);
      for (const key of await store.list(responseCacheKeys.prefix(id))) expect(await store.get(key)).not.toContain(TOKEN_A);
      expect((await liveList()).map(tool => tool.name)).toEqual(["new_catalog"]);
      expect(listings).toBe(2);
      // If rotation storage fails later, the real SDK must still delete both
      // current-generation slots after the previous listing's signal ended.
      const set = store.set.bind(store);
      const deletion = vi.spyOn(store, "delete");
      const writing = vi.spyOn(store, "set").mockImplementation((key, ...args) => key === responseCacheKeys.generation(id)
        ? Promise.reject(new Error(`Fence refused ${TOKEN_A}`)) : set(key, ...args));
      const warning = vi.spyOn(silentLogger, "warn");
      changed = false;
      await servers[1]!.notification({ method: "notifications/tools/list_changed" });
      await waitFor(() => deletion.mock.calls.length === 2);
      writing.mockRestore();
      expect(JSON.stringify(warning.mock.calls)).not.toContain(TOKEN_A);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("Fence refused");
      expect((await liveList()).map(tool => tool.name)).toEqual(["old_catalog"]);
      expect((await liveList()).map(tool => tool.name)).toEqual(["old_catalog"]);
      expect(listings).toBe(3);
      const fresh = {};
      // Workerd forbids reading another request's signal. A SQL cache hit must
      // carry no operation context from the request that published its catalog.
      const foreignSignal = vi.spyOn(required(ctx.signal), "aborted", "get").mockImplementation(() => { throw new Error("Another request read the completed operation signal."); });
      try { expect((await root.getTools(id, BASE, fresh)).map(tool => tool.name)).toEqual(["old_catalog"]); }
      finally { await connector.closeScope!(root.contextFor(id, BASE, fresh)); foreignSignal.mockRestore(); }
      expect(listings).toBe(3);
      return "invalidated";
    }), silentLogger)({ code: "async () => null" });
    expect(output.isError, JSON.stringify(output)).toBeUndefined();
    expect(output.structuredContent).toMatchObject({ result: "invalidated" });
  });

  it("INV-7 INV-8: an ended listing stops publication and cleanup without starving a live concurrent listing", async () => {
    const f = await fixture({ ttl: 60_000, description: "x".repeat(MAX_CATALOG_CHUNK_BYTES + 100) });
    const root = f.registry(); const requestScope = {};
    const base = root.contextFor(f.id, BASE, requestScope);
    await f.connector.status!(base);
    closers.push(() => f.connector.closeScope!(base));
    const entered = deferred<void>(); const release = deferred<void>(); const finished = deferred<void>(); const settled = deferred<void>();
    const listTools = f.connector.listTools.bind(f.connector);
    let calls = 0;
    vi.spyOn(f.connector, "listTools").mockImplementation(async ctx => {
      const first = ++calls === 1;
      try { return await listTools(ctx); } finally { if (first) settled.resolve(); }
    });
    const set = f.store.set.bind(f.store);
    let chunks = 0;
    vi.spyOn(f.store, "set").mockImplementation(async (key, ...args) => {
      if (key.includes(":chunk:") && !key.includes(":refresh-digest:") && ++chunks === 1) {
        entered.resolve(); await release.promise;
        try { return await set(key, ...args); } finally { finished.resolve(); }
      }
      return set(key, ...args);
    });
    vi.useFakeTimers();
    let endedSignal: AbortSignal | undefined; let liveSignal: AbortSignal | undefined;
    const ended = withDeadline(signal => {
      endedSignal = signal;
      return f.connector.listTools(root.contextFor(f.id, BASE, requestScope, { signal }));
    }, { timeoutMs: 100, timeoutError: new Error("Ended listing") });
    const rejected = expect(ended).rejects.toThrow("Ended listing");
    await entered.promise;
    const live = withDeadline(signal => {
      liveSignal = signal;
      return f.connector.listTools(root.contextFor(f.id, BASE, requestScope, { signal }));
    }, { timeoutMs: 2_000, timeoutError: new Error("Live listing starved") });
    try {
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(endedSignal?.aborted).toBe(true);
      expect(liveSignal).not.toBe(endedSignal);
      // The live listing must complete while the old storage write is blocked.
      await expect(live).resolves.toHaveLength(1);
      expect(f.listings()).toBe(2);
      expect(chunks).toBe(3);
      const before = await Promise.all((await f.store.list(responseCacheKeys.prefix(f.id))).filter(key => !key.includes(":chunk:")).map(async key => [key, await f.store.get(key)]));
      release.resolve(); await finished.promise; await settled.promise;
      await ended.catch(() => {});
      const after = await Promise.all((await f.store.list(responseCacheKeys.prefix(f.id))).filter(key => !key.includes(":chunk:")).map(async key => [key, await f.store.get(key)]));
      expect(after).toEqual(before);
      expect(chunks).toBe(3);
      await f.connector.listTools(root.contextFor(f.id, BASE, requestScope));
      expect(f.listings()).toBe(2);
    } finally { release.resolve(); vi.useRealTimers(); await finished.promise; await settled.promise; await ended.catch(() => {}); await live.catch(() => {}); }
  });

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

  it("INV-4 INV-5: public hints cannot share Alice's private workspace with Bob or another pool", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public", description: "Private Alice workspace: acquisition-budget-2027" });
    await f.read(f.registry(), "a", "P");
    f.mode("error");
    await expect(f.read(f.registry(), "b", "Q")).rejects.toMatchObject({ code: "provider_permission_denied" });
    await expect(f.read(f.registry(), "a", "Q")).rejects.toMatchObject({ code: "provider_permission_denied" });
    await expect(f.read(f.registry(), "a", "P", {}, "https://other-connecta.test")).rejects.toMatchObject({ code: "provider_permission_denied" });
    expect(f.listings()).toBe(4);
    await expect(f.read(f.registry(), "a", "P")).resolves.toMatchObject([{ description: "Private Alice workspace: acquisition-budget-2027" }]);
    expect(f.listings()).toBe(4);
  });

  it("INV-4 INV-5: a rotated request token cannot reuse the same principal's public-hinted catalog", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public" });
    await f.read(f.registry());
    f.rotate("replacement-request-token"); f.mode("error");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied" });
    expect(f.listings()).toBe(2);
  });

  it("INV-4 INV-5: operator-shared public catalogs reuse within a pool and stay separate across pools", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public", operatorShared: true });
    await f.read(f.registry(), "a", "P"); await f.read(f.registry(), "b", "P");
    expect(f.listings()).toBe(1);
    await f.read(f.registry(), "a", "Q"); expect(f.listings()).toBe(2);
  });

  it("INV-5 INV-6: public hints preserve request-token isolation and intake redaction", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public" });
    const a = await f.read(f.registry());
    const scopeB = {};
    const b = await f.read(f.registry(), "b", "two", scopeB);
    expect(b).toEqual(a); expect(f.listings()).toBe(2);
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
    const chunks = (await f.store.list("response-cache:v1:")).filter(key => key.includes(f.id) && key.includes(":chunk:") && !key.includes(":refresh-digest:"));
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
    const a = await catalogClientOptions(ctx, id, "configuration-a", "grant", undefined, undefined, "shared");
    const key = { method: "tools/list", partition: JSON.stringify(["self-reported-server-a", ""]) };
    const value = JSON.stringify({ resultType: "complete", tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000, cacheScope: "public" });
    await a.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "public" });
    expect(await a.responseCacheStore!.get({ ...key, partition: JSON.stringify(["self-reported-server-b", ""]) })).toBeDefined();
    const changed = await catalogClientOptions(ctx, id, "configuration-b", "grant", undefined, undefined, "shared");
    const otherConnector = await catalogClientOptions(ctx, id + "_other", "configuration-a", "grant", undefined, undefined, "shared");
    expect(await changed.responseCacheStore!.get(key)).toBeUndefined();
    expect(await otherConnector.responseCacheStore!.get(key)).toBeUndefined();
    attachCatalogCache(ctx, { storage: store, partition: "a/pool", defaultTtlMs: 300_000, minTtlMs: 0, maxTtlMs: 30_000 });
    const bounded = await catalogClientOptions(ctx, id, "configuration-a", "grant", undefined, undefined, "shared");
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
      if (key.includes(":chunk:") && !key.includes(":refresh-digest:") && ++chunks === 1) { entered.resolve(); await release.promise; }
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
    const store = await storage(); const id = `teardown_${crypto.randomUUID().replaceAll("-", "")}`;
    const [transport, peer] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler("tools/list", async () => ({ tools: [], ttlMs: 60_000 }));
    const connected = server.connect(peer);
    closers.push(async () => { await connected; await server.close(); });
    const connector = remoteMcp(id, { url: "https://downstream.test/mcp", _transportFactory: () => transport });
    const ctx = new Registry([connector], { storage: store, logger: silentLogger }).contextFor(id, BASE, {});
    await connector.listTools(ctx);
    closers.push(() => connector.closeScope!(ctx));
    const entered = deferred<void>(); const release = deferred<void>(); const settled = deferred<void>();
    const set = store.set.bind(store);
    let writes = 0;
    vi.spyOn(store, "set").mockImplementation(async (key, ...args) => {
      if (key === responseCacheKeys.generation(id)) {
        writes++; entered.resolve(); await release.promise;
        try { return await set(key, ...args); } finally { settled.resolve(); }
      }
      return set(key, ...args);
    });
    const notify = required(transport.onmessage);
    await server.notification({ method: "notifications/tools/list_changed" });
    await entered.promise;
    vi.useFakeTimers();
    const closing = connector.closeScope!(ctx);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;
      notify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      expect(writes).toBe(1);
    } finally {
      release.resolve(); vi.useRealTimers(); await settled.promise; await closing;
    }
  });
});
