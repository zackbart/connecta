import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  catalogClientOptions,
  catalogExpiry,
  attachCatalogCache,
  invalidateCatalogCache,
  observeCompletedCatalogRefresh,
  type CompletedCatalogRefresh,
} from "../src/catalog-cache.js";
import { catalogIsFresh } from "../src/catalog-freshness.js";
import { sha256Hex } from "../src/bytes.js";
import { CatalogService } from "../src/catalog-service.js";
import { CredentialVault } from "../src/credentials.js";
import { MAX_CATALOG_CHUNK_BYTES } from "../src/catalog-limits.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { callerOf } from "../src/connector-caller.js";
import { d1Storage } from "../src/d1.js";
import { createExecuteTool } from "../src/execute.js";
import { Registry } from "../src/registry.js";
import { sqlStorage, type SqlStatement, type SqlDriver } from "../src/storage/sql.js";
import { sentSecretsForRequest } from "../src/sent-secrets.js";
import { oauthGrantKeys, responseCacheKeys, scopes } from "../src/storage/keys.js";
import { withDeadline } from "../src/timeout.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, deferred, scriptedExecutor, waitFor } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";

const BASE = "https://connecta.test";
// No eight-unit run in common: a shared run is itself a fragment of the other token.
const TOKEN_A = "pA4-k9Xm/2Vq+=";
const TOKEN_B = "pB7-w3Lz/8Rn+=";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// One portable suite, real D1 in workerd and the same SQL KV on node:sqlite.
async function storage(): Promise<KVStorage> {
  try {
    const module = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ module)) as { env: { STORAGE_DB: D1Database } };
    return d1Storage(env.STORAGE_DB);
  } catch {
    const module = "node:sqlite";
    const { DatabaseSync } = (await import(/* @vite-ignore */ module)) as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    closers.push(() => db.close());
    const driver: SqlDriver = {
      async all<Row>({ sql, params }: SqlStatement) {
        return db.prepare(sql).all(...params) as Row[];
      },
      async run({ sql, params }) {
        return Number(db.prepare(sql).run(...params).changes);
      },
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const result = statements.map(({ sql, params }) => Number(db.prepare(sql).run(...params).changes));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
    return sqlStorage(driver, "sqlite");
  }
}
async function fixture(
  options: {
    ttl?: number;
    scope?: "public" | "private";
    legacy?: boolean;
    min?: number;
    max?: number;
    fallback?: number;
    sharedCredential?: boolean;
    description?: string;
    operatorShared?: boolean;
    nextPage?: { ttl: number; scope: "public" | "private" };
  } = {},
) {
  const store = await storage();
  const id = `catalog_${crypto.randomUUID().replaceAll("-", "")}`;
  let tokenA = TOKEN_A;
  let listings = 0;
  let mode: "ok" | "name" | "error" | "transient" | "partial" | "header" | "paged" = "ok";
  const requests: string[] = [];
  const server = httpDownstream((mcp) =>
    mcp.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [] })),
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body =
      request.method === "POST"
        ? ((await request.clone().json()) as { method: string; id: string; params?: { cursor?: string } })
        : undefined;
    if (body?.method) requests.push(body.method);
    if (body?.method === "tools/list") {
      listings++;
      const token = request.headers.get("authorization")!.slice(7);
      if (mode === "transient") return new Response(null, { status: 503 });
      if (mode === "error" || (mode === "partial" && body.params?.cursor))
        return new Response(`Refused ${token}`, { status: 403 });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          ...(options.legacy ? {} : { resultType: "complete" }),
          ...((body.params?.cursor ? options.nextPage?.ttl : options.ttl) === undefined
            ? {}
            : { ttlMs: body.params?.cursor ? options.nextPage?.ttl : options.ttl }),
          ...(options.legacy && options.scope === undefined
            ? {}
            : { cacheScope: (body.params?.cursor ? options.nextPage?.scope : options.scope) ?? "private" }),
          ...(mode === "partial" || (mode === "paged" && !body.params?.cursor) ? { nextCursor: "second" } : {}),
          tools: [
            {
              name: body.params?.cursor
                ? "read_next"
                : mode === "name"
                  ? `read_${token}`
                  : mode === "header"
                    ? "downstream-private-name"
                    : "read",
              description: options.description ?? `Read ${token}`,
              inputSchema: {
                type: "object",
                properties: {
                  [token]: { const: encodeURIComponent(token) },
                  ...(mode === "header" ? { bad: { type: "object", "x-mcp-header": "bad private declaration" } } : {}),
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    }
    return server.fetch(input instanceof Request ? input.url : input, init);
  });
  const connector = remoteMcp(id, {
    url: server.url,
    versionNegotiation: options.legacy ? "legacy" : "auto",
    auth: options.operatorShared
      ? { type: "headers", headers: { Authorization: `Bearer ${TOKEN_A}` } }
      : {
          type: "request",
          token: async (ctx) =>
            !options.sharedCredential && callerOf(ctx)?.identity.actor.id === "b" ? TOKEN_B : tokenA,
        },
  });
  const registry = () =>
    new Registry([connector], {
      storage: store,
      logger: silentLogger,
      toolCacheTtlSeconds: options.fallback ?? 300,
      catalogMinTtlSeconds: options.min ?? 0,
      catalogMaxTtlSeconds: options.max ?? 86_400,
    });
  const read = async (root: Registry, principal = "a", pool = "one", requestScope = {}, baseUrl = BASE) => {
    const view = root.scoped({
      connectorIds: [id],
      principalKey: principal,
      caller: {
        identity: { actor: { kind: "human", id: principal, namespace: "test" }, interactive: true },
        authenticated: true,
        pool,
      },
    });
    try {
      return await view.getTools(id, baseUrl, requestScope);
    } finally {
      await connector.closeScope?.(view.contextFor(id, baseUrl, requestScope));
    }
  };
  return {
    store,
    id,
    connector,
    registry,
    read,
    requests,
    rotate: (token: string) => {
      tokenA = token;
    },
    listings: () => listings,
    mode: (value: typeof mode) => {
      mode = value;
    },
  };
}

describe("SQL-backed SDK catalog cache", () => {
  it("INV-6 INV-8: observes one completed SDK catalog refresh with previous and new digests, excluding hits and failures", async () => {
    const store = await storage();
    const id = `refresh_${crypto.randomUUID().replaceAll("-", "")}`;
    const ctx = { ...connectorContext(store), requestScope: {} };
    const refreshes: CompletedCatalogRefresh[] = [];
    attachCatalogCache(ctx, {
      storage: store,
      partition: "principal/pool",
      defaultTtlMs: 300_000,
      minTtlMs: 0,
      maxTtlMs: 86_400_000,
      onCompletedCatalogRefresh: (refresh, observed) => {
        expect(observed).toBe(ctx);
        refreshes.push(refresh);
      },
    });
    let revision = "old";
    let fail = false;
    let server: Server;
    const connector = remoteMcp(id, {
      url: "https://downstream.test/mcp",
      _transportFactory: () => {
        const [client, peer] = InMemoryTransport.createLinkedPair();
        server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true } } });
        server.setRequestHandler("tools/list", async (request) => {
          if (fail && request.params?.cursor) throw new Error("private-listing-failure");
          return {
            tools: [
              { name: `${revision}_${request.params?.cursor ? "second" : "first"}`, inputSchema: { type: "object" } },
            ],
            ...(!request.params?.cursor ? { nextCursor: "second" } : {}),
            ttlMs: 60_000,
            cacheScope: "private",
          };
        });
        const connected = server.connect(peer);
        closers.push(async () => {
          await connected;
          await server.close();
        });
        return client;
      },
    });
    closers.push(() => connector.closeScope!(ctx));
    await connector.listTools(ctx);
    await connector.listTools(ctx);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ connectorId: id, digest: expect.stringMatching(/^sha256:/) });
    expect(refreshes[0]!.previousDigest).toBeUndefined();
    const generation = await store.get(responseCacheKeys.generation(id));
    fail = true;
    await server!.notification({ method: "notifications/tools/list_changed" });
    await waitFor(async () => (await store.get(responseCacheKeys.generation(id))) !== generation);
    await expect(connector.listTools(ctx)).rejects.toThrow();
    expect(refreshes).toHaveLength(1);
    fail = false;
    revision = "new";
    await connector.listTools(ctx);
    await connector.listTools(ctx);
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]!.previousDigest).toBe(refreshes[0]!.digest);
    expect(refreshes[1]!.digest).not.toBe(refreshes[0]!.digest);
  });

  it("INV-5 INV-8: OAuth credential identities fence cache hits and mid-listing publication without an epoch change", async () => {
    const store = await storage();
    const ctx = connectorContext(store);
    const id = `oauth_identity_${crypto.randomUUID().replaceAll("-", "")}`;
    let identity = "credential-digest-a";
    const cache = await catalogClientOptions(
      ctx,
      id,
      "oauth-configuration",
      "same-epoch",
      undefined,
      undefined,
      "private",
      async () => identity,
    );
    const key = { method: "tools/list", partition: JSON.stringify(["server", cache.cachePartition]) };
    const value = JSON.stringify({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
      ttlMs: 60_000,
      cacheScope: "private",
    });
    await cache.withListing(ctx, async () =>
      cache.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "private" }),
    );
    await cache.withListing(ctx, async () => {
      expect(await cache.responseCacheStore!.get(key)).toBeDefined();
    });
    identity = "credential-digest-b";
    await cache.withListing(ctx, async () => {
      expect(await cache.responseCacheStore!.get(key)).toBeUndefined();
    });
    await cache.withListing(ctx, async () => {
      identity = "credential-digest-c";
      expect(
        await cache.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "private" }),
      ).toBe(0);
    });
  });

  it("INV-6 INV-8: refresh digest baselines survive invalidation and a new request without retaining catalogs", async () => {
    const store = await storage();
    const id = `refresh_restart_${crypto.randomUUID().replaceAll("-", "")}`;
    const refreshes: CompletedCatalogRefresh[] = [];
    const refresh = async (name: string) => {
      const ctx = connectorContext(store);
      attachCatalogCache(ctx, {
        storage: store,
        partition: "principal/pool",
        defaultTtlMs: 300_000,
        minTtlMs: 0,
        maxTtlMs: 86_400_000,
        onCompletedCatalogRefresh: (value) => {
          refreshes.push(value);
        },
      });
      const cache = await catalogClientOptions(ctx, id, "configuration", "grant");
      await cache.withListing(ctx, async () => {
        const digests = await cache.completeCatalogRefresh({
          tools: [{ name, inputSchema: { type: "object" } }],
          ttlMs: 0,
        });
        if (digests) await observeCompletedCatalogRefresh(ctx, digests);
      });
    };
    await refresh("old");
    await invalidateCatalogCache(store, id);
    await refresh("new");
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]!.previousDigest).toBe(refreshes[0]!.digest);
    const keys = (await store.list(responseCacheKeys.prefix(id))).filter(
      (key) => key.includes(":refresh-digest:") && !key.includes(":chunk:"),
    );
    expect(keys).toHaveLength(1);
    const baseline = await store.get(keys[0]!);
    const manifest = JSON.parse(baseline!);
    expect(manifest).toMatchObject({ digest: refreshes[1]!.digest, chunkCount: 1 });
    const facts = await store.get(responseCacheKeys.chunk(keys[0]!, manifest.revision, 0));
    expect(JSON.parse(facts!)).toEqual(refreshes[1]!.next);
    expect(facts).not.toMatch(/old|new|inputSchema/);
    expect(baseline).not.toMatch(/old|new|inputSchema/);
  });

  it("INV-6 INV-8: a modern zero-TTL catalog lists every call, writes no baseline while unchanged and still records drift", async () => {
    const store = await storage();
    const id = `modern_zero_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const recordChange = vi.fn();
    let description = "Read a record";
    let listings = 0;
    // The SDK server's default catalog hint is `ttlMs: 0`.
    const downstream = httpDownstream(
      (mcp) =>
        mcp.registerTool("read", { description, annotations: { readOnlyHint: true } }, async () => ({ content: [] })),
      {
        capture: async (request) => {
          if (request.method !== "POST") return;
          if (((await request.json()) as { method?: string }).method === "tools/list") listings++;
        },
      },
    );
    const connector = remoteMcp(id, { url: downstream.url, fetch: downstream.fetch });
    const call = async () => {
      const registry = new Registry([connector], {
        storage: store,
        logger: silentLogger,
        catalogDriftActivity: { recordChange, sink: { record: () => {} }, serverInfo: { name: "test", version: "1" } },
      });
      const ctx = registry.contextFor(id, BASE, {});
      try {
        return (await connector.listTools(ctx)).map((tool) => tool.description);
      } finally {
        await connector.closeScope!(ctx);
      }
    };
    const writes = () => (["set", "compareAndSet", "delete"] as const).map((method) => vi.spyOn(store, method));
    // An unchanged call only clears the zero-TTL cache slots; it writes no baseline.
    const baselineUntouched = ([set, compareAndSet, remove]: ReturnType<typeof writes>) => {
      expect(set).not.toHaveBeenCalled();
      expect(compareAndSet).not.toHaveBeenCalled();
      for (const [key] of remove!.mock.calls) expect(key).not.toContain(":refresh-digest:");
    };
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(await call()).toEqual(["Read a record"]);
    const baseline = (await store.list(responseCacheKeys.prefix(id))).filter(
      (key) => key.includes(":refresh-digest:") && !key.includes(":chunk:"),
    );
    expect(baseline).toHaveLength(1);
    const written = await store.get(baseline[0]!);

    // Budget: a warm unchanged call still lists, never reuses, and writes no baseline.
    let spies = writes();
    expect(await call()).toEqual(["Read a record"]);
    expect(listings).toBe(2);
    baselineUntouched(spies);
    expect(await store.get(baseline[0]!)).toBe(written);
    expect(recordChange).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    // An hour on, the unchanged baseline is rewritten once and reports no drift.
    vi.spyOn(Date, "now").mockImplementation(() => now);
    now += 60 * 60 * 1000;
    await call();
    expect(await store.get(baseline[0]!)).not.toBe(written);
    expect(recordChange).not.toHaveBeenCalled();

    // A changed catalog writes its baseline and records drift once.
    description = "Read one record";
    spies = writes();
    expect(await call()).toEqual(["Read one record"]);
    expect(spies[0]).toHaveBeenCalled();
    expect(spies[1]).toHaveBeenCalled();
    expect(recordChange).toHaveBeenCalledOnce();
    expect(recordChange.mock.calls[0]![1]).toMatchObject({
      connectorId: id,
      drift: { kind: "catalog_changed", addedTools: 0, removedTools: 0, changedTools: 1 },
    });
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    spies = writes();
    await call();
    baselineUntouched(spies);
    expect(recordChange).toHaveBeenCalledOnce();
    expect(listings).toBe(5);
  });

  it.each([0])(
    "INV-7 INV-8: closing temporary instance %s preserves another instance with the same connector id and request scope",
    async (closing) => {
      const store = await storage();
      const id = `instances_${crypto.randomUUID().replaceAll("-", "")}`;
      const ctx = { ...connectorContext(store), requestScope: {} };
      attachCatalogCache(ctx, {
        storage: store,
        partition: "principal/pool",
        defaultTtlMs: 300_000,
        minTtlMs: 0,
        maxTtlMs: 86_400_000,
      });
      const servers: Server[] = [];
      let changed = false;
      let listings = 0;
      const instance = () => {
        const connector = remoteMcp(id, {
          url: "https://downstream.test/mcp",
          _transportFactory: () => {
            const [client, peer] = InMemoryTransport.createLinkedPair();
            const server = new Server(
              { name: "downstream", version: "1" },
              { capabilities: { tools: { listChanged: true } } },
            );
            servers.push(server);
            server.setRequestHandler("tools/list", async () => {
              listings++;
              return {
                tools: [{ name: changed ? "new_catalog" : "old_catalog", inputSchema: { type: "object" } }],
                ttlMs: 60_000,
                cacheScope: "private",
              };
            });
            const connected = server.connect(peer);
            closers.push(async () => {
              await connected;
              await server.close();
            });
            return client;
          },
        });
        closers.push(() => connector.closeScope!(ctx));
        return connector;
      };
      const pair = [instance(), instance()];
      for (const connector of pair)
        expect((await connector.listTools(ctx)).map((tool) => tool.name)).toEqual(["old_catalog"]);
      expect(listings).toBe(1);
      // The second instance served the complete cached catalog without connecting.
      expect(servers).toHaveLength(1);
      // A live status probe connects it, so both instances hold connections.
      for (const connector of pair) expect((await connector.status!(ctx)).state).toBe("ok");
      expect(servers).toHaveLength(2);
      await pair[closing]!.closeScope!(ctx);
      const live = pair[1 - closing]!;
      expect((await live.listTools(ctx)).map((tool) => tool.name)).toEqual(["old_catalog"]);
      expect(listings).toBe(1);
      const generation = await store.get(responseCacheKeys.generation(id));
      changed = true;
      await servers[1 - closing]!.notification({ method: "notifications/tools/list_changed" });
      await waitFor(async () => (await store.get(responseCacheKeys.generation(id))) !== generation);
      expect((await live.listTools(ctx)).map((tool) => tool.name)).toEqual(["new_catalog"]);
      expect((await live.listTools(ctx)).map((tool) => tool.name)).toEqual(["new_catalog"]);
      expect(listings).toBe(2);
      await live.closeScope!(ctx);
      // A later temporary client in this still-live outer request owns a fresh
      // lifetime and can reuse the surviving client's complete publication.
      expect((await instance().listTools(ctx)).map((tool) => tool.name)).toEqual(["new_catalog"]);
      expect(listings).toBe(2);
      await expect(pair[closing]!.listTools(ctx)).rejects.toThrow("scope ended");
    },
  );

  it.each(
    (["resource", "listing"] as const).flatMap((operation) =>
      (["private"] as const).map((scope) => ({ operation, scope })),
    ),
  )(
    "INV-7 INV-8: a completed $operation keeps connection notifications and later $scope SDK cache operations live",
    async ({ operation, scope }) => {
      const store = await storage();
      const id = `completed_${crypto.randomUUID().replaceAll("-", "")}`;
      const servers: Server[] = [];
      let changed = false;
      let listings = 0;
      const connector = remoteMcp(id, {
        url: "https://downstream.test/mcp",
        auth: { type: "headers", headers: { "X-API-Key": TOKEN_A } },
        _transportFactory: () => {
          const [client, peer] = InMemoryTransport.createLinkedPair();
          const server = new Server(
            { name: "downstream", version: "1" },
            { capabilities: { tools: { listChanged: true }, resources: {} } },
          );
          servers.push(server);
          server.setRequestHandler("tools/list", async () => {
            listings++;
            return {
              tools: [
                {
                  name: changed ? "new_catalog" : "old_catalog",
                  description: `Catalog ${TOKEN_A}`,
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
              ttlMs: 60_000,
              cacheScope: scope,
            };
          });
          server.setRequestHandler("resources/list", async () => ({
            resources: [{ name: "manual", uri: "docs://manual/start" }],
            ttlMs: 60_000,
            cacheScope: "private",
          }));
          server.setRequestHandler("resources/templates/list", async () => ({
            resourceTemplates: [],
            ttlMs: 60_000,
            cacheScope: "private",
          }));
          server.setRequestHandler("resources/read", async (request) => ({
            contents: [{ uri: request.params.uri, text: "resource" }],
          }));
          const connected = server.connect(peer);
          closers.push(async () => {
            await connected;
            await server.close();
          });
          return client;
        },
      });
      const root = new Registry([connector], { storage: store, logger: silentLogger });
      const seed = {};
      expect((await root.getTools(id, BASE, seed)).map((tool) => tool.name)).toEqual(["old_catalog"]);
      await connector.closeScope!(root.contextFor(id, BASE, seed));
      const listingScope = {};
      if (operation === "listing") closers.push(() => connector.closeScope!(root.contextFor(id, BASE, listingScope)));
      // A cached catalog is served without connecting. Invalidate it so the
      // opening listing connects and fetches, leaving a live client behind.
      if (operation === "listing") await invalidateCatalogCache(store, id);
      const opened = operation === "listing" ? 1 : 0;
      let completed: ConnectorContext | undefined;
      const original =
        operation === "resource" ? connector.readResource!.bind(connector) : connector.listTools.bind(connector);
      if (operation === "resource")
        connector.readResource = async (uri, ctx) => {
          completed = ctx;
          return (original as NonNullable<typeof connector.readResource>)(uri, ctx);
        };
      else
        connector.listTools = async (ctx) => {
          completed = ctx;
          return (original as typeof connector.listTools)(ctx);
        };
      const output = await createExecuteTool(
        root,
        BASE,
        scriptedExecutor(async (fns) => {
          if (operation === "resource")
            await required(fns.read)(`resource://${id}/${encodeURIComponent("docs://manual/start")}`);
          else
            await withDeadline((signal) => connector.listTools(root.contextFor(id, BASE, listingScope, { signal })), {
              timeoutMs: 1_000,
              timeoutError: new Error("Opening listing deadline"),
            });
          const ctx = required(completed);
          expect(ctx.signal?.aborted).toBe(true);
          const liveList = () =>
            withDeadline((signal) => connector.listTools(root.contextFor(id, BASE, ctx.requestScope, { signal })), {
              timeoutMs: 1_000,
              timeoutError: new Error("Listing deadline"),
            });
          expect((await liveList()).map((tool) => tool.name)).toEqual(["old_catalog"]);
          expect(listings).toBe(1 + opened);
          const generation = await store.get(responseCacheKeys.generation(id));
          changed = true;
          await servers[1]!.notification({ method: "notifications/tools/list_changed" });
          await waitFor(async () => (await store.get(responseCacheKeys.generation(id))) !== generation);
          // This is the same live client whose opening operation already ended.
          expect((await liveList()).map((tool) => tool.name)).toEqual(["new_catalog"]);
          expect(listings).toBe(2 + opened);
          for (const key of await store.list(responseCacheKeys.prefix(id)))
            expect(await store.get(key)).not.toContain(TOKEN_A);
          expect((await liveList()).map((tool) => tool.name)).toEqual(["new_catalog"]);
          expect(listings).toBe(2 + opened);
          // If rotation storage fails later, the real SDK must still delete both
          // current-generation slots after the previous listing's signal ended.
          const set = store.set.bind(store);
          const deletion = vi.spyOn(store, "delete");
          const writing = vi
            .spyOn(store, "set")
            .mockImplementation((key, ...args) =>
              key === responseCacheKeys.generation(id)
                ? Promise.reject(new Error(`Fence refused ${TOKEN_A}`))
                : set(key, ...args),
            );
          const warning = vi.spyOn(silentLogger, "warn");
          changed = false;
          await servers[1]!.notification({ method: "notifications/tools/list_changed" });
          await waitFor(() => deletion.mock.calls.length === 2);
          writing.mockRestore();
          expect(JSON.stringify(warning.mock.calls)).not.toContain(TOKEN_A);
          expect(JSON.stringify(warning.mock.calls)).not.toContain("Fence refused");
          expect((await liveList()).map((tool) => tool.name)).toEqual(["old_catalog"]);
          expect((await liveList()).map((tool) => tool.name)).toEqual(["old_catalog"]);
          expect(listings).toBe(3 + opened);
          const fresh = {};
          // Workerd forbids reading another request's signal. A SQL cache hit must
          // carry no operation context from the request that published its catalog.
          const foreignSignal = vi.spyOn(required(ctx.signal), "aborted", "get").mockImplementation(() => {
            throw new Error("Another request read the completed operation signal.");
          });
          try {
            expect((await root.getTools(id, BASE, fresh)).map((tool) => tool.name)).toEqual(["old_catalog"]);
          } finally {
            await connector.closeScope!(root.contextFor(id, BASE, fresh));
            foreignSignal.mockRestore();
          }
          expect(listings).toBe(3 + opened);
          return "invalidated";
        }),
        silentLogger,
      )({ code: "async () => null" });
      expect(output.isError, JSON.stringify(output)).toBeUndefined();
      expect(output.structuredContent).toMatchObject({ result: "invalidated" });
    },
  );

  it("INV-7 INV-8: an ended listing stops publication and cleanup without starving a live concurrent listing", async () => {
    const f = await fixture({ ttl: 60_000, description: "x".repeat(MAX_CATALOG_CHUNK_BYTES + 100) });
    const root = f.registry();
    const requestScope = {};
    const base = root.contextFor(f.id, BASE, requestScope);
    await f.connector.status!(base);
    closers.push(() => f.connector.closeScope!(base));
    const entered = deferred<void>();
    const release = deferred<void>();
    const finished = deferred<void>();
    const settled = deferred<void>();
    const listTools = f.connector.listTools.bind(f.connector);
    let calls = 0;
    vi.spyOn(f.connector, "listTools").mockImplementation(async (ctx) => {
      const first = ++calls === 1;
      try {
        return await listTools(ctx);
      } finally {
        if (first) settled.resolve();
      }
    });
    const set = f.store.set.bind(f.store);
    let chunks = 0;
    vi.spyOn(f.store, "set").mockImplementation(async (key, ...args) => {
      if (key.includes(":chunk:") && !key.includes(":refresh-digest:") && ++chunks === 1) {
        entered.resolve();
        await release.promise;
        try {
          return await set(key, ...args);
        } finally {
          finished.resolve();
        }
      }
      return set(key, ...args);
    });
    vi.useFakeTimers();
    let endedSignal: AbortSignal | undefined;
    let liveSignal: AbortSignal | undefined;
    const ended = withDeadline(
      (signal) => {
        endedSignal = signal;
        return f.connector.listTools(root.contextFor(f.id, BASE, requestScope, { signal }));
      },
      { timeoutMs: 100, timeoutError: new Error("Ended listing") },
    );
    const rejected = expect(ended).rejects.toThrow("Ended listing");
    await entered.promise;
    const live = withDeadline(
      (signal) => {
        liveSignal = signal;
        return f.connector.listTools(root.contextFor(f.id, BASE, requestScope, { signal }));
      },
      { timeoutMs: 2_000, timeoutError: new Error("Live listing starved") },
    );
    try {
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(endedSignal?.aborted).toBe(true);
      expect(liveSignal).not.toBe(endedSignal);
      // The live listing must complete while the old storage write is blocked.
      await expect(live).resolves.toHaveLength(1);
      expect(f.listings()).toBe(2);
      expect(chunks).toBe(3);
      const before = await Promise.all(
        (await f.store.list(responseCacheKeys.prefix(f.id)))
          .filter((key) => !key.includes(":chunk:"))
          .map(async (key) => [key, await f.store.get(key)]),
      );
      release.resolve();
      await finished.promise;
      await settled.promise;
      await ended.catch(() => {});
      const after = await Promise.all(
        (await f.store.list(responseCacheKeys.prefix(f.id)))
          .filter((key) => !key.includes(":chunk:"))
          .map(async (key) => [key, await f.store.get(key)]),
      );
      expect(after).toEqual(before);
      expect(chunks).toBe(3);
      await f.connector.listTools(root.contextFor(f.id, BASE, requestScope));
      expect(f.listings()).toBe(2);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await finished.promise;
      await settled.promise;
      await ended.catch(() => {});
      await live.catch(() => {});
    }
  });

  it.each([
    { ttl: 1, min: 2, max: 4, expected: 2_000 },
    { ttl: 50_000, min: 2, max: 4, expected: 4_000 },
    { legacy: true, fallback: 3, expected: 3_000 },
  ])("INV-7: honors hinted, legacy, and bounded TTL $expected on SQL", async (options) => {
    const f = await fixture(options);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const initial = f.registry();
    const initialTools = await f.read(initial);
    expect(catalogIsFresh(initialTools)).toBe(true);
    const fetched = now;
    now += 1;
    const restarted = f.registry();
    const cachedTools = await f.read(restarted);
    expect(catalogIsFresh(cachedTools)).toBe(true);
    expect(restarted.catalogAgeMs(f.id)).toBe(now - fetched);
    expect(f.listings()).toBe(1);
    now += options.expected - 2;
    await f.read(f.registry());
    expect(f.listings()).toBe(1);
    now += 2;
    expect(catalogIsFresh(cachedTools)).toBe(false);
    await f.read(f.registry());
    expect(f.listings()).toBe(2);
  });

  it.each([0, 0.5])("INV-8: never reuses an invalid or zero hint %s", async (ttl) => {
    const f = await fixture({ ttl });
    // Invalid modern wire hints fail validation; no catalog may be cached.
    const first = await f.read(f.registry()).catch((error) => error);
    const second = await f.read(f.registry()).catch((error) => error);
    expect(f.listings()).toBe(2);
    if (ttl === 0) {
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
    } else {
      expect(first).toBeInstanceOf(Error);
      expect(second).toBeInstanceOf(Error);
    }
  });

  it("INV-4 INV-5: private catalogs never cross principals or pools, including shared-auth connectors", async () => {
    const f = await fixture({ ttl: 60_000, scope: "private", sharedCredential: true });
    const root = f.registry();
    await f.read(root, "a", "one");
    await f.read(root, "a", "one");
    await f.read(root, "a", "two");
    await f.read(root, "b", "one");
    expect(f.listings()).toBe(3);
    await f.read(f.registry(), "b", "one");
    expect(f.listings()).toBe(3);
  });

  it("INV-4 INV-10: B.1 operation services partition negotiation and private fallback for alice on crm and bob on tickets", async () => {
    const f = await fixture({ ttl: 60_000, scope: "private", sharedCredential: true });
    const root = f.registry();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const negotiations = async () =>
      (await f.store.list(scopes.connector(f.id))).filter((key) => key.includes("negotiation:v1:"));

    await f.read(root, "alice", "crm");
    expect(await negotiations()).toHaveLength(1);
    await f.read(root, "bob", "tickets");
    expect(await negotiations()).toHaveLength(2);
    await f.read(root, "alice", "crm");
    expect(await negotiations()).toHaveLength(2);
    expect(f.listings()).toBe(2);

    now += 60_001;
    f.mode("transient");
    const alice = await f.read(root, "alice", "crm");
    const bob = await f.read(root, "bob", "tickets");
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(catalogIsFresh(alice)).toBe(false);
    expect(catalogIsFresh(bob)).toBe(false);
    await expect(f.read(root, "alice", "tickets")).rejects.toBeInstanceOf(Error);
    await expect(f.read(root, "bob", "crm")).rejects.toBeInstanceOf(Error);
    expect(f.listings()).toBe(6);
  });

  it("INV-4 INV-5: public hints cannot share Alice's private workspace with Bob or another pool", async () => {
    const f = await fixture({
      ttl: 60_000,
      scope: "public",
      description: "Private Alice workspace: acquisition-budget-2027",
    });
    await f.read(f.registry(), "a", "P");
    f.mode("error");
    await expect(f.read(f.registry(), "b", "Q")).rejects.toMatchObject({ code: "provider_permission_denied" });
    await expect(f.read(f.registry(), "a", "Q")).rejects.toMatchObject({ code: "provider_permission_denied" });
    await expect(f.read(f.registry(), "a", "P", {}, "https://other-connecta.test")).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(f.listings()).toBe(4);
    await expect(f.read(f.registry(), "a", "P")).resolves.toMatchObject([
      { description: "Private Alice workspace: acquisition-budget-2027" },
    ]);
    expect(f.listings()).toBe(4);
  });

  it("INV-4 INV-5: a rotated request token cannot reuse the same principal's public-hinted catalog", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public" });
    await f.read(f.registry());
    f.rotate("replacement-request-token");
    f.mode("error");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied" });
    expect(f.listings()).toBe(2);
  });

  it("INV-4 INV-5: operator-shared public catalogs reuse within a pool and stay separate across pools", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public", operatorShared: true });
    await f.read(f.registry(), "a", "P");
    await f.read(f.registry(), "b", "P");
    expect(f.listings()).toBe(1);
    await f.read(f.registry(), "a", "Q");
    expect(f.listings()).toBe(2);
  });

  it("INV-5 INV-6: public hints preserve request-token isolation and intake redaction", async () => {
    const f = await fixture({ ttl: 60_000, scope: "public" });
    const a = await f.read(f.registry());
    const scopeB = {};
    const b = await f.read(f.registry(), "b", "two", scopeB);
    expect(b).toEqual(a);
    expect(f.listings()).toBe(2);
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
    f.mode("name");
    await expect(f.read(f.registry())).rejects.toThrow("tool name");
    f.mode("partial");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied" });
    f.mode("ok");
    await expect(f.read(f.registry())).resolves.toHaveLength(1);
    expect(f.listings()).toBe(4);
    expect(sdkList).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1_000])("INV-8: later pages narrow public scope and TTL to %s before SDK publication", async (ttl) => {
    const f = await fixture({
      ttl: 60_000,
      scope: "public",
      sharedCredential: true,
      nextPage: { ttl, scope: "private" },
    });
    f.mode("paged");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await f.read(f.registry());
    await f.read(f.registry());
    expect(f.listings()).toBe(ttl === 0 ? 4 : 2);
    await f.read(f.registry(), "b", "two");
    expect(f.listings()).toBe(ttl === 0 ? 6 : 4);
    now += 1_001;
    await f.read(f.registry());
    expect(f.listings()).toBe(ttl === 0 ? 8 : 6);
  });

  it("INV-6 INV-8: invalid header declarations fail before SDK logging or caching", async () => {
    const f = await fixture({ ttl: 60_000 });
    const warning = vi.spyOn(console, "warn");
    f.mode("header");
    await expect(f.read(f.registry())).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      message: "Downstream tool has an invalid x-mcp-header declaration.",
    });
    expect(warning).not.toHaveBeenCalled();
    f.mode("ok");
    await f.read(f.registry());
    expect(f.listings()).toBe(2);
  });

  it("INV-8: incomplete SQL writes are misses and never hide a live failure", async () => {
    const f = await fixture({ ttl: 60_000 });
    const original = f.store.set.bind(f.store);
    vi.spyOn(f.store, "set").mockImplementation((key, ...args) =>
      key.includes(":chunk:") ? Promise.reject(new Error("Write refused")) : original(key, ...args),
    );
    await f.read(f.registry());
    f.mode("error");
    await expect(f.read(f.registry())).rejects.toMatchObject({ code: "provider_permission_denied", retryable: false });
    expect(f.listings()).toBe(2);
  });

  it("INV-4 INV-6: public keys bind connector configuration and TTL policy rather than server identity", async () => {
    const store = await storage();
    const ctx = connectorContext(store);
    attachCatalogCache(ctx, {
      storage: store,
      partition: "a/pool",
      defaultTtlMs: 300_000,
      minTtlMs: 0,
      maxTtlMs: 86_400_000,
    });
    const id = `configuration_${crypto.randomUUID().replaceAll("-", "")}`;
    const a = await catalogClientOptions(ctx, id, "configuration-a", "grant", undefined, undefined, "shared");
    const key = { method: "tools/list", partition: JSON.stringify(["self-reported-server-a", ""]) };
    const value = JSON.stringify({
      resultType: "complete",
      tools: [{ name: "read", inputSchema: { type: "object" } }],
      ttlMs: 60_000,
      cacheScope: "public",
    });
    await a.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "public" });
    expect(
      await a.responseCacheStore!.get({ ...key, partition: JSON.stringify(["self-reported-server-b", ""]) }),
    ).toBeDefined();
    const changed = await catalogClientOptions(ctx, id, "configuration-b", "grant", undefined, undefined, "shared");
    const otherConnector = await catalogClientOptions(
      ctx,
      id + "_other",
      "configuration-a",
      "grant",
      undefined,
      undefined,
      "shared",
    );
    expect(await changed.responseCacheStore!.get(key)).toBeUndefined();
    expect(await otherConnector.responseCacheStore!.get(key)).toBeUndefined();
    attachCatalogCache(ctx, {
      storage: store,
      partition: "a/pool",
      defaultTtlMs: 300_000,
      minTtlMs: 0,
      maxTtlMs: 30_000,
    });
    const bounded = await catalogClientOptions(ctx, id, "configuration-a", "grant", undefined, undefined, "shared");
    expect(await bounded.responseCacheStore!.get(key)).toBeUndefined();
  });

  it.each(
    (
      [
        { oldScope: "private", newScope: "public" },
        { oldScope: "public", newScope: "private" },
      ] as const
    ).flatMap((scopes) =>
      (["legacy", "auto"] as const).map((versionNegotiation) => ({ ...scopes, versionNegotiation })),
    ),
  )(
    "INV-4 INV-6 INV-8: real $versionNegotiation SDK list_changed fences late $oldScope publication after a $newScope listing",
    async ({ oldScope, newScope, versionNegotiation }) => {
      const store = await storage();
      const id = `notification_${crypto.randomUUID().replaceAll("-", "")}`;
      // Both clients start in one established generation. The first refresh
      // must pin it even though the SDK deliberately skips all cache reads.
      await new Registry([], { storage: store, logger: silentLogger }).invalidateStored(id);
      const entered = deferred<void>();
      const release = deferred<void>();
      const servers: Server[] = [];
      let listings = 0;
      let deletes = 0;
      const sdkList = Client.prototype.listTools;
      let first = true;
      vi.spyOn(Client.prototype, "listTools").mockImplementation(function (this: Client, params, options) {
        // A refresh skips cache reads. Its first eventual publication must
        // already belong to the generation from before the wire request.
        const refresh = first;
        first = false;
        return sdkList.call(this, params, refresh ? { ...options, cacheMode: "refresh" } : options);
      });
      const deletion = store.delete.bind(store);
      vi.spyOn(store, "delete").mockImplementation(async (key) => {
        await deletion(key);
        deletes++;
      });
      const connector = remoteMcp(id, {
        url: "https://downstream.test/mcp",
        versionNegotiation,
        _transportFactory: () => {
          const [client, peer] = InMemoryTransport.createLinkedPair();
          const server = new Server(
            { name: "downstream", version: "1" },
            { capabilities: { tools: { listChanged: true } } },
          );
          const index = servers.length;
          servers.push(server);
          server.setRequestHandler("tools/list", async () => {
            listings++;
            if (index === 0) {
              entered.resolve();
              await release.promise;
            }
            return {
              tools: [
                {
                  name: index === 0 ? "old_catalog" : "new_catalog",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
              ttlMs: 60_000,
              cacheScope: index === 0 ? oldScope : newScope,
            };
          });
          const connected = server.connect(peer);
          closers.push(async () => {
            await connected;
            await server.close();
          });
          return client;
        },
      });
      const context = (principal: string) => {
        const ctx = { ...connectorContext(store), requestScope: {} };
        attachCatalogCache(ctx, {
          storage: store,
          partition: `${principal}/pool`,
          defaultTtlMs: 300_000,
          minTtlMs: 0,
          maxTtlMs: 86_400_000,
        });
        closers.push(() => connector.closeScope!(ctx));
        return ctx;
      };
      const old = connector.listTools(context("a"));
      try {
        await entered.promise;
        expect((await connector.listTools(context("b"))).map((tool) => tool.name)).toEqual(["new_catalog"]);
        const generation = await store.get(responseCacheKeys.generation(id));
        deletes = 0;
        await servers[1]!.notification({ method: "notifications/tools/list_changed" });
        // Wait for the real SDK eviction to finish before releasing the old wire
        // response. SDK 2.3.1 deletes both slots; a rotated generation also makes
        // them unreachable, without depending on an arbitrary sleep.
        await waitFor(async () => deletes === 2 || (await store.get(responseCacheKeys.generation(id))) !== generation);
        release.resolve();
        expect((await old).map((tool) => tool.name)).toEqual(["old_catalog"]);
        expect((await connector.listTools(context("a"))).map((tool) => tool.name)).toEqual(["new_catalog"]);
        expect(listings).toBe(3);
        expect((await connector.listTools(context("a"))).map((tool) => tool.name)).toEqual(["new_catalog"]);
        expect(listings).toBe(3);
        const warning = vi.spyOn(silentLogger, "warn");
        const writing = store.set.bind(store);
        vi.spyOn(store, "set").mockImplementation((key, ...args) =>
          key === responseCacheKeys.generation(id)
            ? Promise.reject(new Error(`Fence refused ${TOKEN_A}`))
            : writing(key, ...args),
        );
        await servers[1]!.notification({ method: "notifications/tools/list_changed" });
        await waitFor(() => warning.mock.calls.length > 0);
        expect(JSON.stringify(warning.mock.calls)).not.toContain(TOKEN_A);
        expect(JSON.stringify(warning.mock.calls)).not.toContain("Fence refused");
        expect((await connector.listTools(context("a"))).map((tool) => tool.name)).toEqual(["new_catalog"]);
      } finally {
        release.resolve();
        await old.catch(() => {});
      }
    },
  );

  it.each(["deadline"] as const)(
    "INV-7 INV-8: starts no cache I/O after %s while a chunk write is pending",
    async (ending) => {
      const f = await fixture({ ttl: 60_000, description: "x".repeat(MAX_CATALOG_CHUNK_BYTES + 100) });
      const entered = deferred<void>();
      const release = deferred<void>();
      const settled = deferred<void>();
      let ctx: ConnectorContext | undefined;
      let closed = false;
      let chunks = 0;
      const late: string[] = [];
      // Discovery health settles in the request after its probe; it is not cache I/O.
      const start = (operation: string, key?: string) => {
        if (key?.startsWith("connector-health:")) return;
        if (closed || ctx?.signal?.aborted) late.push(operation);
      };
      const listTools = f.connector.listTools.bind(f.connector);
      vi.spyOn(f.connector, "listTools").mockImplementation(async (context) => {
        ctx = context;
        try {
          return await listTools(context);
        } finally {
          settled.resolve();
        }
      });
      const get = f.store.get.bind(f.store);
      const set = f.store.set.bind(f.store);
      const deletion = f.store.delete.bind(f.store);
      const cas = f.store.compareAndSet.bind(f.store);
      vi.spyOn(f.store, "get").mockImplementation((key) => {
        start("get", key);
        return get(key);
      });
      vi.spyOn(f.store, "delete").mockImplementation((key) => {
        start("delete", key);
        return deletion(key);
      });
      const publication = vi.spyOn(f.store, "compareAndSet").mockImplementation((...args) => {
        start("compareAndSet", args[0]);
        return cas(...args);
      });
      vi.spyOn(f.store, "set").mockImplementation(async (key, ...args) => {
        start("set", key);
        if (key.includes(":chunk:") && !key.includes(":refresh-digest:") && ++chunks === 1) {
          entered.resolve();
          await release.promise;
        }
        return set(key, ...args);
      });
      const root = f.registry();
      const requestScope = {};
      const search =
        ending === "deadline"
          ? new CatalogService(root, BASE, { requestScope, probeTimeoutMs: 1_000 }).search({ connector: f.id })
          : f.connector.listTools(root.contextFor(f.id, BASE, requestScope));
      try {
        await entered.promise;
        if (ending === "deadline") {
          const result = (await search) as Awaited<ReturnType<CatalogService["search"]>>;
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
        expect(
          publication.mock.calls.filter(
            ([key]) => key.startsWith(responseCacheKeys.prefix(f.id)) && !key.endsWith(":generation"),
          ),
        ).toEqual([]);
        const keys = await f.store.list(responseCacheKeys.prefix(f.id));
        expect(keys.filter((key) => !key.includes(":chunk:") && !key.endsWith(":generation"))).toEqual([]);
        vi.restoreAllMocks();
        await f.read(f.registry());
        expect(f.listings()).toBe(2);
      } finally {
        release.resolve();
        await settled.promise;
        await search.catch(() => {});
      }
    },
  );

  it("INV-7: bounds teardown while notification invalidation storage is blocked", async () => {
    const store = await storage();
    const id = `teardown_${crypto.randomUUID().replaceAll("-", "")}`;
    const [transport, peer] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler("tools/list", async () => ({ tools: [], ttlMs: 60_000 }));
    const connected = server.connect(peer);
    closers.push(async () => {
      await connected;
      await server.close();
    });
    const connector = remoteMcp(id, { url: "https://downstream.test/mcp", _transportFactory: () => transport });
    const ctx = new Registry([connector], { storage: store, logger: silentLogger }).contextFor(id, BASE, {});
    await connector.listTools(ctx);
    closers.push(() => connector.closeScope!(ctx));
    const entered = deferred<void>();
    const release = deferred<void>();
    const settled = deferred<void>();
    const set = store.set.bind(store);
    let writes = 0;
    vi.spyOn(store, "set").mockImplementation(async (key, ...args) => {
      if (key === responseCacheKeys.generation(id)) {
        writes++;
        entered.resolve();
        await release.promise;
        try {
          return await set(key, ...args);
        } finally {
          settled.resolve();
        }
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
      release.resolve();
      vi.useRealTimers();
      await settled.promise;
      await closing;
    }
  });
});

it.each([0, 1_000])(
  "INV-9: host expiry records original fetch age and zero TTL %s through cache hits",
  async (ttlMs) => {
    const store = await storage();
    const ctx = connectorContext(store);
    const connector = remoteMcp(`expiry_${crypto.randomUUID().replaceAll("-", "")}`, {
      url: "https://downstream.test/mcp",
      _transportFactory: () => {
        const [client, peer] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler("tools/list", async () => ({
          tools: [{ name: "read", inputSchema: { type: "object" } }],
          ttlMs,
          cacheScope: "private",
        }));
        const connected = server.connect(peer);
        closers.push(async () => {
          await connected;
          await server.close();
        });
        return client;
      },
    });
    closers.push(() => connector.closeScope!(ctx));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await connector.listTools(ctx);
    const fetched = now;
    expect(catalogExpiry(ctx)).toEqual({ fetchedAt: fetched, ttlMs, expiresAt: fetched + ttlMs, staleFallback: false });
    now += 500;
    await connector.listTools(ctx);
    expect(catalogExpiry(ctx)).toEqual({
      fetchedAt: ttlMs ? fetched : now,
      ttlMs,
      expiresAt: (ttlMs ? fetched : now) + ttlMs,
      staleFallback: false,
    });
  },
);

it("INV-9 INV-8: stale tool fallback preserves expiry, remains partitioned and ends after five minutes", async () => {
  const f = await fixture({ ttl: 1_000 });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const root = f.registry();
  await f.read(root);
  now += 1_100;
  f.mode("error");
  // Permission failures never reuse stale facts.
  await expect(f.read(root)).rejects.toMatchObject({ code: "provider_permission_denied" });
  f.mode("transient");
  const fallback = await f.read(root);
  expect(fallback).toHaveLength(1);
  expect(catalogIsFresh(fallback)).toBe(false);
  expect(root.catalogAgeMs(f.id)).toBe(1_100);
  expect((await root.statusFor(f.id, BASE)).catalogAccess?.state).toBe("stale");
  await expect(f.read(root, "b")).rejects.toMatchObject({ code: "connector_call_failed" });
  now += 300_000;
  await expect(f.read(root)).rejects.toMatchObject({ code: "connector_call_failed" });
});

it("INV-9 INV-8: an explicit zero-TTL refresh removes a previous reusable listing", async () => {
  const store = await storage();
  const ctx = connectorContext(store);
  const cache = await catalogClientOptions(
    ctx,
    `zero_${crypto.randomUUID().replaceAll("-", "")}`,
    "configuration",
    "grant",
  );
  const key = { method: "tools/list", partition: JSON.stringify(["server", cache.cachePartition]) };
  const tools = [{ name: "read", inputSchema: { type: "object" as const } }];
  await cache.responseCacheStore!.set(key, {
    value: JSON.stringify({ tools, ttlMs: 60_000 }),
    expiresAt: Date.now() + 60_000,
  });
  expect(await cache.responseCacheStore!.get(key)).toBeDefined();
  await cache.responseCacheStore!.set(key, { value: JSON.stringify({ tools, ttlMs: 0 }), expiresAt: Date.now() });
  expect(await cache.responseCacheStore!.get(key)).toBeUndefined();
});

it.each(["zero-TTL write", "cleanup delete"] as const)(
  "INV-8: a %s removes an older catalog published after the listing read the slot as missing",
  async (removal) => {
    const store = await storage();
    const id = `race_${crypto.randomUUID().replaceAll("-", "")}`;
    // One stored generation, so every instance addresses the same slot.
    await invalidateCatalogCache(store, id);
    const instance = async () => {
      const ctx = connectorContext(store);
      const cache = await catalogClientOptions(ctx, id, "configuration", "grant");
      return { ctx, cache, store: cache.responseCacheStore! };
    };
    const a = await instance();
    const b = await instance();
    const key = { method: "tools/list", partition: JSON.stringify(["server", a.cache.cachePartition]) };
    await a.cache.withListing(a.ctx, async () => {
      // A reads the slot as missing and lists the downstream.
      expect(await a.store.get(key)).toBeUndefined();
      // B, holding an older catalog with a positive TTL, publishes into the slot.
      await b.store.set(key, {
        value: JSON.stringify({ tools: [{ name: "stale", inputSchema: { type: "object" } }], ttlMs: 60_000 }),
        expiresAt: Date.now() + 60_000,
      });
      // A's newer answer refuses reuse; the slot must not keep B's catalog.
      if (removal === "zero-TTL write")
        await a.store.set(key, {
          value: JSON.stringify({ tools: [{ name: "fresh", inputSchema: { type: "object" } }], ttlMs: 0 }),
          expiresAt: Date.now(),
        });
      else await a.store.delete(key);
    });
    // A later request, connectionless or not, finds nothing to serve.
    const later = await instance();
    expect(await later.store.get(key)).toBeUndefined();
    expect(await later.cache.cachedTools(later.ctx)).toBeUndefined();
  },
);

/** A stateful 2025-era downstream: every connection pays initialize, initialized, a standalone GET and a DELETE. */
function legacyDownstream(name: string, hint: { ttlMs?: number } = {}) {
  const requests: string[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body =
      request.method === "POST"
        ? ((await request
            .clone()
            .json()
            .catch(() => null)) as { method?: string; id?: unknown } | null)
        : null;
    requests.push(request.method === "POST" ? (body?.method ?? "response") : request.method);
    const session = sessions.get(request.headers.get("mcp-session-id") ?? "");
    if (session) return session.handleRequest(request);
    if (body?.method !== "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32000, message: "Server not initialized" } },
        { status: 400 },
      );
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
      },
    });
    const server = new Server({ name, version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({
      tools: [{ name: `${name}_read`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      ...(hint.ttlMs !== undefined ? { ttlMs: hint.ttlMs } : {}),
    }));
    await server.connect(transport);
    return transport.handleRequest(request);
  };
  return {
    fetch,
    requests,
    listings: () => requests.filter((method) => method === "tools/list").length,
    handshakes: () => requests.filter((method) => method === "initialize").length,
  };
}

describe("pre-connect cached catalogs", () => {
  async function deployment(
    hint: { ttlMs?: number } = {},
    options: { store?: KVStorage; suffix?: string; vaultKey?: number; header?: string; url?: string } = {},
  ) {
    const store = options.store ?? (await storage());
    const vault = new CredentialVault(
      store,
      btoa(String.fromCharCode(...new Uint8Array(32).fill(options.vaultKey ?? 7))),
    );
    const suffix = options.suffix ?? crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const shared = legacyDownstream("crm", hint);
    const keyed = legacyDownstream("tickets", hint);
    const pinned = legacyDownstream("notes", hint);
    const ids = { shared: `crm_${suffix}`, keyed: `tickets_${suffix}`, pinned: `notes_${suffix}` };
    const connectors = [
      // Negotiates once, then reuses the stored legacy verdict.
      remoteMcp(ids.shared, {
        url: options.url ?? "https://crm.test/mcp",
        fetch: shared.fetch,
        auth: { type: "headers", headers: { Authorization: `Bearer ${options.header ?? TOKEN_A}` } },
      }),
      remoteMcp(ids.keyed, { url: "https://tickets.test/mcp", fetch: keyed.fetch, auth: { type: "credential" } }),
      remoteMcp(ids.pinned, { url: "https://notes.test/mcp", fetch: pinned.fetch, versionNegotiation: "legacy" }),
      calcConnector,
    ];
    await vault.set(ids.keyed, TOKEN_A, "operator");
    const downstreams = [shared, keyed, pinned];
    // Each search is one request: a fresh registry over the same storage, as
    // in a new isolate, whose connector scopes close when it ends.
    const search = async (registry = makeRegistry(connectors, { storage: store, credentialVault: vault })) => {
      const requestScope = {};
      try {
        return await new CatalogService(registry, BASE, { requestScope }).search({ query: "read" });
      } finally {
        for (const connector of connectors)
          await connector.closeScope?.(registry.contextFor(connector.id, BASE, requestScope));
      }
    };
    return {
      store,
      vault,
      ids,
      downstreams,
      search,
      requests: () => downstreams.reduce((sum, downstream) => sum + downstream.requests.length, 0),
      listings: () => downstreams.reduce((sum, downstream) => sum + downstream.listings(), 0),
      handshakes: () => downstreams.reduce((sum, downstream) => sum + downstream.handshakes(), 0),
      reset: () => {
        for (const downstream of downstreams) downstream.requests.length = 0;
      },
    };
  }
  const names = (result: Awaited<ReturnType<CatalogService["search"]>>) =>
    result.entries.map((entry) => entry.tool.name).sort();

  it("INV-8 INV-10: a warm search over cached legacy connectors sends no downstream request and writes nothing", async () => {
    const d = await deployment();
    // A miss connects every legacy connector and publishes its complete catalog.
    const cold = await d.search();
    expect(names(cold)).toEqual(["crm_read", "notes_read", "tickets_read"]);
    expect(d.handshakes()).toBe(3);
    expect(d.listings()).toBe(3);
    d.reset();
    const writes = (["set", "compareAndSet", "delete"] as const).map((method) => vi.spyOn(d.store, method));
    const warm = await d.search();
    expect(names(warm)).toEqual(names(cold));
    expect(warm.queryAnalysis?.catalogError).toBeUndefined();
    // Budget: zero handshakes, zero listings, zero session cleanup.
    expect(d.downstreams.map((downstream) => downstream.requests)).toEqual([[], [], []]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("INV-8: an expired catalog connects and lists again", async () => {
    const d = await deployment();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await d.search();
    d.reset();
    now += 299_000;
    await d.search();
    expect(d.requests()).toBe(0);
    now += 2_000;
    const expired = await d.search();
    expect(names(expired)).toEqual(["crm_read", "notes_read", "tickets_read"]);
    expect(d.handshakes()).toBe(3);
    expect(d.listings()).toBe(3);
  });

  it("INV-8: an explicit zero TTL is never reused, so every listing connects", async () => {
    const d = await deployment({ ttlMs: 0 });
    await d.search();
    d.reset();
    await d.search();
    expect(d.handshakes()).toBe(3);
    expect(d.listings()).toBe(3);
  });

  it("INV-5 INV-10: a rotated credential misses the previous partition and connects with the new value", async () => {
    const d = await deployment();
    await d.search();
    d.reset();
    await d.vault.set(d.ids.keyed, TOKEN_B, "operator");
    await d.search();
    const [shared, keyed, pinned] = d.downstreams;
    expect(shared!.requests).toEqual([]);
    expect(pinned!.requests).toEqual([]);
    expect(keyed!.handshakes()).toBe(1);
    expect(keyed!.listings()).toBe(1);
    d.reset();
    // The new partition is now warm; the old value's entry is never consulted.
    await d.search();
    expect(d.requests()).toBe(0);
  });

  // Every stored row that addresses a downstream catalog or negotiation verdict.
  const cacheRows = async (store: KVStorage) =>
    Promise.all(
      (await store.list(""))
        .filter((key) => key.includes("response-cache:") || key.includes("negotiation:"))
        .map(async (key) => [key, (await store.get(key)) ?? ""] as const),
    );

  it("INV-5 INV-6: secret-bearing cache keys depend on the deployment key, never on a guessable secret alone", async () => {
    const store = await storage();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const url = `https://crm.test/mcp?key=${TOKEN_B}`;
    const first = await deployment({}, { store, suffix, url });
    await first.search();
    const before = await cacheRows(store);
    // No row holds a configured secret, or a plain digest of a guess at one.
    const guesses = [TOKEN_A, TOKEN_B, `Bearer ${TOKEN_A}`, `?key=${TOKEN_B}`, url];
    const digests = await Promise.all(guesses.map((guess) => sha256Hex(guess)));
    for (const [key, value] of before)
      for (const needle of [...guesses, ...guesses.map(encodeURIComponent), ...digests]) {
        expect(key).not.toContain(needle);
        expect(value).not.toContain(needle);
      }
    // The same secrets under another deployment key address none of those
    // rows: a stored key is no function of public inputs and a guessed secret.
    const second = await deployment({}, { store, suffix, url, vaultKey: 9 });
    await second.search();
    const [shared, keyed, pinned] = second.downstreams;
    expect([shared!.handshakes(), keyed!.handshakes()]).toEqual([1, 1]);
    expect([shared!.listings(), keyed!.listings()]).toEqual([1, 1]);
    // A connector without secret configuration keeps its keys and its cache.
    expect(pinned!.requests).toEqual([]);
    const secretKeys = (rows: (readonly [string, string])[]) =>
      new Set(rows.map(([key]) => key).filter((key) => !key.includes(first.ids.pinned)));
    const after = secretKeys(await cacheRows(store));
    const earlier = [...secretKeys(before)].filter((key) => !key.endsWith(":generation"));
    expect(earlier.length).toBeGreaterThan(0);
    for (const key of earlier.filter((key) => !key.includes(":refresh-digest:")))
      expect(after.has(key) && (await store.get(key)) !== null).toBe(true);
    const fresh = [...after].filter((key) => !earlier.includes(key) && !key.endsWith(":generation"));
    expect(fresh.some((key) => key.includes(first.ids.shared))).toBe(true);
    expect(fresh.some((key) => key.includes(first.ids.keyed))).toBe(true);
  });

  it("INV-4 INV-5: a static header changed by redeploy misses the previous partition at once", async () => {
    const store = await storage();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    await (await deployment({}, { store, suffix })).search();
    const rotated = await deployment({}, { store, suffix, header: TOKEN_B });
    await rotated.search();
    const [shared, keyed, pinned] = rotated.downstreams;
    expect([shared!.handshakes(), shared!.listings()]).toEqual([1, 1]);
    expect([...keyed!.requests, ...pinned!.requests]).toEqual([]);
    // Each header keeps its own partition: the earlier one is still warm.
    const restored = await deployment({}, { store, suffix });
    await restored.search();
    expect(restored.requests()).toBe(0);
  });

  it("INV-5: without a vault, secret-bearing keys use a per-process key and still partition by header", async () => {
    const store = await storage();
    const downstream = legacyDownstream("crm");
    const id = `crm_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const search = async (token: string) => {
      const connector = remoteMcp(id, {
        url: "https://crm.test/mcp",
        fetch: downstream.fetch,
        auth: { type: "headers", headers: { Authorization: `Bearer ${token}` } },
      });
      const registry = makeRegistry([connector], { storage: store });
      const requestScope = {};
      try {
        return await new CatalogService(registry, BASE, { requestScope }).search({ query: "read" });
      } finally {
        await connector.closeScope?.(registry.contextFor(id, BASE, requestScope));
      }
    };
    await search(TOKEN_A);
    await search(TOKEN_A);
    expect([downstream.handshakes(), downstream.listings()]).toEqual([1, 1]);
    await search(TOKEN_B);
    expect([downstream.handshakes(), downstream.listings()]).toEqual([2, 2]);
    const digest = await sha256Hex(`Bearer ${TOKEN_A}`);
    for (const [key, value] of await cacheRows(store)) expect(`${key}${value}`).not.toContain(digest);
  });

  it("INV-8: an invalidated catalog connects and lists again", async () => {
    const d = await deployment();
    await d.search();
    d.reset();
    await invalidateCatalogCache(d.store, d.ids.shared);
    await d.search();
    const [shared, keyed, pinned] = d.downstreams;
    expect([shared!.handshakes(), shared!.listings()]).toEqual([1, 1]);
    expect([...keyed!.requests, ...pinned!.requests]).toEqual([]);
  });

  it("INV-5 INV-10: an OAuth catalog is served without connecting only for the live grant's tokens", async () => {
    const store = await storage();
    const id = `calendar_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const downstream = legacyDownstream("calendar");
    vi.stubGlobal("fetch", downstream.fetch);
    const connector = remoteMcp(id, { url: "https://calendar.test/mcp", auth: { type: "oauth" } });
    const grant = (accessToken: string, epoch = "v3:seeded") =>
      seedGrant(
        store,
        { issuer: "https://calendar.test", tokens: { access_token: accessToken, token_type: "Bearer" } },
        epoch,
        scopes.connector(id),
      );
    const search = async () => {
      const registry = makeRegistry([connector], { storage: store });
      const requestScope = {};
      try {
        return await new CatalogService(registry, BASE, { requestScope }).search({ query: "read" });
      } finally {
        await connector.closeScope!(registry.contextFor(id, BASE, requestScope));
      }
    };
    await grant("access-1");
    expect(names(await search())).toEqual(["calendar_read"]);
    expect([downstream.handshakes(), downstream.listings()]).toEqual([1, 1]);
    downstream.requests.length = 0;
    const writes = (["set", "compareAndSet", "delete"] as const).map((method) => vi.spyOn(store, method));
    expect(names(await search())).toEqual(["calendar_read"]);
    expect(downstream.requests).toEqual([]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    // New tokens in the same epoch are a new identity: the pre-connect read misses.
    await grant("access-2");
    await search();
    expect([downstream.handshakes(), downstream.listings()]).toEqual([1, 1]);
    downstream.requests.length = 0;
    // A re-authorization moves the epoch, which partitions the catalog anew.
    await grant("access-2", "v3:reauthorized");
    await search();
    expect([downstream.handshakes(), downstream.listings()]).toEqual([1, 1]);
    downstream.requests.length = 0;
    // A grant without tokens is never served from the cache; the connect decides.
    await seedGrant(store, { issuer: "https://calendar.test" }, "v3:reauthorized", scopes.connector(id));
    await search();
    expect(downstream.handshakes()).toBe(1);
  });

  /** One OAuth connector over a legacy downstream, searched by a fresh registry per request. */
  async function oauthDeployment(
    options: { vault?: boolean; vaultKey?: number; store?: KVStorage; id?: string; clientMetadataUrl?: string } = {},
  ) {
    const store = options.store ?? (await storage());
    const vault = options.vault
      ? new CredentialVault(store, btoa(String.fromCharCode(...new Uint8Array(32).fill(options.vaultKey ?? 7))))
      : undefined;
    const id = options.id ?? `calendar_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const downstream = legacyDownstream("calendar");
    vi.stubGlobal("fetch", downstream.fetch);
    const connector = remoteMcp(id, {
      url: "https://calendar.test/mcp",
      auth: {
        type: "oauth",
        ...(options.clientMetadataUrl !== undefined ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
      },
    });
    const grantKey = scopes.connector(id) + oauthGrantKeys.grant;
    const grant = (accessToken: string, epoch = "v3:seeded") =>
      seedGrant(
        store,
        { issuer: "https://calendar.test", tokens: { access_token: accessToken, token_type: "Bearer" } },
        epoch,
        scopes.connector(id),
      );
    const search = async () => {
      const registry = makeRegistry([connector], { storage: store, ...(vault ? { credentialVault: vault } : {}) });
      const requestScope = {};
      try {
        return await new CatalogService(registry, BASE, { requestScope }).search({ query: "read" });
      } finally {
        await connector.closeScope!(registry.contextFor(id, BASE, requestScope));
      }
    };
    return { store, downstream, grantKey, grant, search };
  }

  it("INV-5 INV-6: a client metadata URL's query reaches cache keys only through the deployment key", async () => {
    const store = await storage();
    const id = `calendar_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const metadata = (token: string) => `https://client.test/connecta/client.json?key=${token}`;
    const search = async (token: string, vaultKey: number) => {
      const d = await oauthDeployment({ vault: true, vaultKey, store, id, clientMetadataUrl: metadata(token) });
      await d.search();
      return d.downstream;
    };
    await seedGrant(
      store,
      { issuer: "https://calendar.test", tokens: { access_token: "access-1", token_type: "Bearer" } },
      "v3:seeded",
      scopes.connector(id),
    );
    // The configuration digest each catalog namespace is stored under.
    const configs = async () =>
      new Set(
        (await store.list(responseCacheKeys.prefix(id)))
          .map((key) => /^(sha256:\d+:[0-9a-f]{64}):/.exec(key.slice(responseCacheKeys.prefix(id).length))?.[1])
          .filter((config): config is string => config !== undefined),
      );
    expect((await search(TOKEN_A, 7)).listings()).toBe(1);
    expect((await search(TOKEN_A, 7)).requests).toEqual([]);
    const first = await configs();
    expect(first.size).toBe(1);
    // The query partitions exactly: another value lists for itself.
    expect((await search(TOKEN_B, 7)).listings()).toBe(1);
    expect((await configs()).size).toBe(2);
    // No row holds the query, or a plain digest of a guess at the URL or its query.
    const guesses = [TOKEN_A, TOKEN_B, metadata(TOKEN_A), metadata(TOKEN_B), `?key=${TOKEN_A}`, `?key=${TOKEN_B}`];
    const needles = [
      ...guesses,
      ...guesses.map(encodeURIComponent),
      ...(await Promise.all(guesses.map((guess) => sha256Hex(guess)))),
    ];
    const rows = await cacheRows(store);
    expect(rows.length).toBeGreaterThan(0);
    for (const [key, value] of rows)
      for (const needle of needles) {
        expect(key).not.toContain(needle);
        expect(value).not.toContain(needle);
      }
    // A rotated deployment key stores the same configuration under a new
    // digest, and addresses none of the earlier entries; the original key
    // finds them again.
    const before = await configs();
    expect((await search(TOKEN_A, 9)).listings()).toBe(1);
    const rotated = [...(await configs())].filter((config) => !before.has(config));
    expect(rotated).toHaveLength(1);
    expect(first.has(rotated[0]!)).toBe(false);
    expect((await search(TOKEN_A, 7)).requests).toEqual([]);
  });

  it("INV-5: an epoch replaced during the pre-connect read never serves the previous epoch's catalog", async () => {
    const d = await oauthDeployment();
    await d.grant("access-1", "v3:first");
    await d.search();
    d.downstream.requests.length = 0;
    // The first grant read sees the old epoch; every later read sees a
    // re-authorization that happens to carry the same token bytes.
    const get = d.store.get.bind(d.store);
    let swapped = false;
    vi.spyOn(d.store, "get").mockImplementation(async (key) => {
      const value = await get(key);
      if (key === d.grantKey && !swapped) {
        swapped = true;
        await d.grant("access-1", "v3:second");
      }
      return value;
    });
    expect(names(await d.search())).toEqual(["calendar_read"]);
    expect(swapped).toBe(true);
    // The pre-read refused the stale partition, and the connect bound the new epoch.
    expect([d.downstream.handshakes(), d.downstream.listings()]).toEqual([1, 1]);
  });

  it("INV-10: a pre-connect hit never seals a plaintext OAuth grant in place", async () => {
    const d = await oauthDeployment({ vault: true });
    await d.grant("access-1");
    await d.search();
    // The connect sealed the grant. Restore the plaintext layout-3 record.
    expect(JSON.parse((await d.store.get(d.grantKey))!).sealed).toBeDefined();
    await d.grant("access-1");
    const plaintext = await d.store.get(d.grantKey);
    expect(JSON.parse(plaintext!).body.tokens.access_token).toBe("access-1");
    d.downstream.requests.length = 0;
    const writes = (["set", "compareAndSet", "delete"] as const).map((method) => vi.spyOn(d.store, method));
    expect(names(await d.search())).toEqual(["calendar_read"]);
    expect(d.downstream.requests).toEqual([]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(await d.store.get(d.grantKey)).toBe(plaintext);
  });

  it("INV-8 INV-10: a connectionless read never claims a generation that expires mid-read", async () => {
    const store = await storage();
    const ctx = { ...connectorContext(store), requestScope: {} };
    const id = `expiring_${crypto.randomUUID().replaceAll("-", "")}`;
    const writer = await catalogClientOptions(ctx, id, "configuration", "grant");
    const key = { method: "tools/list", params: "", partition: JSON.stringify(["server", writer.cachePartition]) };
    const value = JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000 });
    await writer.withListing(ctx, async () =>
      writer.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000, scope: "private" }),
    );
    const generationKey = responseCacheKeys.generation(id);
    const reader = await catalogClientOptions(
      ctx,
      id,
      "configuration",
      "grant",
      undefined,
      undefined,
      "private",
      undefined,
      true,
    );
    expect((await reader.cachedTools(ctx))?.tools.map((tool) => tool.name)).toEqual(["read"]);
    // The generation expires right after the listing pins it.
    const get = store.get.bind(store);
    let expired = false;
    vi.spyOn(store, "get").mockImplementation(async (requested) => {
      const result = await get(requested);
      if (requested === generationKey && !expired) {
        expired = true;
        await store.delete(generationKey);
      }
      return result;
    });
    const claims = vi.spyOn(store, "compareAndSet");
    expect(await reader.cachedTools(ctx)).toBeUndefined();
    expect(expired).toBe(true);
    expect(claims).not.toHaveBeenCalled();
    expect(await get(generationKey)).toBeNull();
  });

  it("a credential test lists live against a modern server whose catalog the SDK has cached", async () => {
    const store = await storage();
    const vault = new CredentialVault(store, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const id = `modern_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let listings = 0;
    const downstream = httpDownstream(
      (mcp) => mcp.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [] })),
      {
        catalogTtlMs: 60_000,
        capture: async (request) => {
          if (request.method !== "POST") return;
          if (((await request.json()) as { method?: string }).method === "tools/list") listings++;
        },
      },
    );
    const connector = remoteMcp(id, { url: downstream.url, fetch: downstream.fetch, auth: { type: "credential" } });
    await vault.set(id, TOKEN_A, "operator");
    const withRegistry = async <T>(run: (ctx: ConnectorContext) => Promise<T>) => {
      const registry = makeRegistry([connector], { storage: store, credentialVault: vault });
      const ctx = registry.contextFor(id, BASE, {});
      try {
        return await run(ctx);
      } finally {
        await connector.closeScope!(ctx);
      }
    };
    await withRegistry((ctx) => connector.listTools(ctx));
    expect(listings).toBe(1);
    // A modern connection reads the cached catalog without a request.
    await withRegistry((ctx) => connector.listTools(ctx));
    expect(listings).toBe(1);
    expect(await withRegistry((ctx) => connector.testCredential!(TOKEN_A, ctx))).toMatchObject({ ok: true });
    expect(listings).toBe(2);
  });

  it("a credential test proves the stored value live even when its catalog is cached", async () => {
    const d = await deployment();
    await d.search();
    d.reset();
    const connector = remoteMcp(d.ids.keyed, {
      url: "https://tickets.test/mcp",
      fetch: d.downstreams[1]!.fetch,
      auth: { type: "credential" },
    });
    const ctx = {
      ...connectorContext(d.store),
      requestScope: {},
      credential: {
        get: () => d.vault.get(d.ids.keyed),
        getAll: () => d.vault.getAll(d.ids.keyed),
      },
    } as unknown as ConnectorContext;
    expect(await connector.testCredential!(TOKEN_A, ctx)).toMatchObject({ ok: true });
    expect(d.downstreams[1]!.handshakes()).toBe(1);
  });
});
