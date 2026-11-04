import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport, specTypeSchemas } from "@modelcontextprotocol/client";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  catalogClientOptions,
  catalogExpiry,
  attachCatalogCache,
  invalidateCatalogCache,
  observeCompletedCatalogRefresh,
  type CompletedCatalogRefresh,
} from "../src/catalog-cache.js";
import { catalogIsFresh, catalogStaleness } from "../src/catalog-freshness.js";
import { sha256Hex } from "../src/bytes.js";
import { CatalogService } from "../src/catalog-service.js";
import { CredentialVault } from "../src/credentials.js";
import { MAX_CATALOG_CHUNK_BYTES } from "../src/catalog-limits.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { callerOf } from "../src/connector-caller.js";
import { d1Storage } from "../src/d1.js";
import { claimDiscoveryProbe, type HealthSlot } from "../src/discovery-health.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { Registry } from "../src/registry.js";
import { runEdge } from "../src/runtime/run.js";
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
  let mode:
    | "ok"
    | "name"
    | "error"
    | "unauthorized"
    | "denied"
    | "transient"
    | "partial"
    | "header"
    | "paged"
    | "stalled"
    | "renamed" = "ok";
  let resolvedTokens = 0;
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
    // Refused at every step, the handshake included.
    if (mode === "denied" && body?.method) return new Response("Refused", { status: 403 });
    if (body?.method === "tools/list") {
      listings++;
      const token = request.headers.get("authorization")!.slice(7);
      if (mode === "transient") return new Response(null, { status: 503 });
      if (mode === "unauthorized") return new Response(null, { status: 401 });
      if (mode === "stalled")
        await new Promise((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
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
                : mode === "renamed"
                  ? "read_renamed"
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
  const newConnector = () =>
    remoteMcp(id, {
      url: server.url,
      versionNegotiation: options.legacy ? "legacy" : "auto",
      auth: options.operatorShared
        ? { type: "headers", headers: { Authorization: `Bearer ${TOKEN_A}` } }
        : {
            type: "request",
            token: async (ctx) => {
              resolvedTokens++;
              return !options.sharedCredential && callerOf(ctx)?.identity.actor.id === "b" ? TOKEN_B : tokenA;
            },
          },
    });
  const connector = newConnector();
  const registry = (instance = connector) =>
    new Registry([instance], {
      storage: store,
      logger: silentLogger,
      toolCacheTtlSeconds: options.fallback ?? 300,
      catalogMinTtlSeconds: options.min ?? 0,
      catalogMaxTtlSeconds: options.max ?? 86_400,
    });
  const viewFor = (
    root: Registry,
    principal = "a",
    pool = "one",
    toolAccess?: ReadonlyMap<string, ReadonlySet<string>>,
  ) =>
    root.scoped({
      connectorIds: [id],
      principalKey: principal,
      caller: {
        identity: { actor: { kind: "human", id: principal, namespace: "test" }, interactive: true },
        authenticated: true,
        pool,
      },
      ...(toolAccess ? { toolAccess } : {}),
    });
  // One unscoped search as one request, with the search and the call after it sharing its service.
  const discover = async <T>(
    view: ReturnType<typeof viewFor>,
    use: (service: CatalogService) => Promise<T>,
    options: ConstructorParameters<typeof CatalogService>[2] = {},
  ) => {
    const requestScope = {};
    try {
      return await use(
        new CatalogService(view, BASE, {
          requestScope,
          probeTimeoutMs: 1_000,
          unscopedProbeTimeoutMs: 100,
          ...options,
        }),
      );
    } finally {
      await view.getConnector(id)?.closeScope?.(view.contextFor(id, BASE, requestScope));
    }
  };
  const read = async (root: Registry, principal = "a", pool = "one", requestScope = {}, baseUrl = BASE) => {
    const view = viewFor(root, principal, pool);
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
    newConnector,
    registry,
    read,
    viewFor,
    discover,
    requests,
    resolvedTokens: () => resolvedTokens,
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
  // Permission failures never reuse stale facts, and a later outage cannot bring them back.
  await expect(f.read(root)).rejects.toMatchObject({ code: "provider_permission_denied" });
  f.mode("transient");
  await expect(f.read(root)).rejects.toMatchObject({ code: "connector_call_failed" });
  // A listing that succeeds is what restores reuse.
  f.mode("ok");
  await f.read(root);
  now += 1_100;
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

describe("stale catalog listing", () => {
  const search = (service: CatalogService) => service.search({ query: "read" });
  const clock = () => {
    const time = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => time.now);
    return time;
  };

  it("INV-8: lists the last complete catalog on a timeout, marked with its age, up to the fixed limit", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    f.mode("stalled");
    time.now += 2_000;
    const page = await f.discover(f.viewFor(root), search);
    expect(page.entries.map((entry) => entry.tool.name)).toEqual(["read"]);
    expect(page.total).toBe(1);
    expect(page.catalogErrors).toEqual([
      {
        connector: f.id,
        code: "timeout",
        message: `Connector "${f.id}" did not answer discovery (timeout), so its tools are listed from its last complete catalog. Calls still check the live catalog. Search with connector "${f.id}" to try it now.`,
        retryable: true,
        stale: true,
        ageMs: 2_000,
      },
    ]);
    // A scoped search asks for the live answer, so it reports the failure and lists nothing.
    const scoped = await f.discover(f.viewFor(root), (service) => service.search({ query: "read", connector: f.id }));
    expect(scoped.entries).toEqual([]);
    expect(scoped.catalogErrors[0]).toMatchObject({ code: "timeout" });
    expect(scoped.catalogErrors[0]?.stale).toBeUndefined();
    time.now += 86_400_000;
    const expired = await f.discover(f.viewFor(root), search);
    expect(expired.entries).toEqual([]);
    expect(expired.catalogErrors[0]?.stale).toBeUndefined();
  });

  it("INV-8: a skipped connector stays listed, so total holds across a browse's pages", async () => {
    const f = await fixture({ ttl: 1_000, nextPage: { ttl: 1_000, scope: "private" } });
    const time = clock();
    const root = f.registry();
    f.mode("paged");
    await f.read(root);
    f.mode("stalled");
    time.now += 2_000;
    const first = await f.discover(f.viewFor(root), (service) => service.search({ query: "", limit: 1 }));
    const listings = f.listings();
    const second = await f.discover(f.viewFor(root), (service) =>
      service.search({ query: "", limit: 1, offset: first.nextOffset! }),
    );
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(second.entries.map((entry) => entry.tool.name)).not.toEqual(first.entries.map((entry) => entry.tool.name));
    expect(second.catalogErrors[0]).toMatchObject({ code: "timeout", stale: true });
    expect(second.catalogErrors[0]?.retryAfterMs).toBeGreaterThan(50_000);
    // The record still spares the connector: the second page asked nothing.
    expect(f.listings()).toBe(listings);
  });

  it("INV-1 INV-8: a listed stale tool grants nothing: a call resolves the live catalog", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    f.mode("stalled");
    time.now += 2_000;
    await f.discover(f.viewFor(root), async (service) => {
      expect((await search(service)).entries).toHaveLength(1);
      // Still hanging: the call fails on its own deadline. Nothing stale resolves it.
      await expect(service.resolveTool(`${f.id}.read`, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
      // The downstream removed the tool: the listed address is unknown to a call.
      f.mode("renamed");
      const removed = await service.resolveTool(`${f.id}.read`);
      expect(removed).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    });
  });

  it("INV-1 INV-2: deployment classification and pool grants bind a stale listing", async () => {
    const f = await fixture({ ttl: 1_000, nextPage: { ttl: 1_000, scope: "private" } });
    const time = clock();
    const root = f.registry();
    f.mode("paged");
    await f.read(root);
    f.mode("stalled");
    time.now += 2_000;
    const granted = await f.discover(f.viewFor(root, "a", "one", new Map([[f.id, new Set(["read"])]])), search);
    expect(granted.entries.map((entry) => entry.tool.name)).toEqual(["read"]);
    const hidden = new Registry([f.connector], {
      storage: f.store,
      logger: silentLogger,
      classification: { [f.id]: { read: "hidden", read_next: "write" } },
    });
    const overridden = await f.discover(f.viewFor(hidden), (service) => service.search({ query: "" }));
    expect(overridden.entries.map((entry) => [entry.tool.name, entry.tool.classification])).toEqual([
      ["read_next", "write"],
    ]);
    const readOnly = await f.discover(f.viewFor(hidden), (service) => service.search({ query: "" }), {
      readOnly: true,
    });
    expect(readOnly.entries).toEqual([]);
  });

  it("INV-5 INV-8: another owner, a rotated credential or an invalidated generation finds no stale entry", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    f.mode("stalled");
    time.now += 2_000;
    const other = await f.discover(f.viewFor(root, "b"), search);
    expect(other.entries).toEqual([]);
    expect(other.catalogErrors[0]?.stale).toBeUndefined();
    const otherPool = await f.discover(f.viewFor(root, "a", "two"), search);
    expect(otherPool.entries).toEqual([]);
    f.rotate("replacement-request-token");
    const rotated = await f.discover(f.viewFor(root), search);
    expect(rotated.entries).toEqual([]);
    expect(rotated.catalogErrors[0]?.stale).toBeUndefined();
    f.rotate(TOKEN_A);
    await invalidateCatalogCache(f.store, f.id);
    const invalidated = await f.discover(f.viewFor(root), search);
    expect(invalidated.entries).toEqual([]);
  });

  it("INV-5: an auth or permission failure never lists a stale catalog", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    f.mode("error");
    time.now += 2_000;
    // A generous deadline: the downstream's refusal is what this search must see.
    const page = await f.discover(f.viewFor(root), search, { probeTimeoutMs: 5_000, unscopedProbeTimeoutMs: 5_000 });
    expect(page.entries).toEqual([]);
    expect(page.catalogErrors).toEqual([expect.objectContaining({ code: "provider_permission_denied" })]);
    expect(page.catalogErrors[0]?.stale).toBeUndefined();
  });

  it("INV-8: a transient listing failure is reported stale inside and past the five-minute call fallback", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    f.mode("transient");
    time.now += 2_000;
    const within = await f.discover(f.viewFor(root), async (service) => ({
      page: await search(service),
      resolved: await service.resolveTool(`${f.id}.read`),
    }));
    expect(within.page.entries).toHaveLength(1);
    expect(within.page.catalogErrors).toEqual([
      expect.objectContaining({ connector: f.id, code: "unavailable", stale: true, ageMs: 2_000 }),
    ]);
    expect(within.resolved.ok).toBe(true);
    time.now += 300_000;
    const past = await f.discover(f.viewFor(root), async (service) => ({
      page: await search(service),
      resolved: await service.resolveTool(`${f.id}.read`),
    }));
    expect(past.page.entries).toHaveLength(1);
    expect(past.page.catalogErrors[0]).toMatchObject({ code: "connector_call_failed", stale: true });
    // Past the call fallback the listing remains and the call does not.
    expect(past.resolved.ok).toBe(false);
  });

  it("INV-10: a peek writes nothing and hands its read to the listing, so a resolver runs once", async () => {
    const f = await fixture({ ttl: 60_000 });
    const root = f.registry();
    await f.read(root);
    const before = f.resolvedTokens();
    const requests = f.requests.length;
    const writes = (["set", "compareAndSet", "delete"] as const).map((method) => vi.spyOn(f.store, method));
    const page = await f.discover(f.viewFor(root), search);
    expect(page.entries).toHaveLength(1);
    expect(page.catalogErrors).toEqual([]);
    expect(f.resolvedTokens() - before).toBe(1);
    expect(f.requests.length).toBe(requests);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("removes a superseded revision's chunks when a newer catalog is published", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    const chunks = async () =>
      (await f.store.list(`response-cache:`)).filter((key) => key.includes(f.id) && key.includes(":chunk:"));
    const published = (await chunks()).length;
    expect(published).toBeGreaterThan(0);
    time.now += 2_000;
    await f.read(root);
    expect(f.listings()).toBe(2);
    expect((await chunks()).length).toBe(published);
  });

  it("INV-7 INV-8: refreshes past the probe deadline under defer, in a scope of its own", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    const deferred: Promise<unknown>[] = [];
    const defer = (work: Promise<unknown>) => void deferred.push(work);
    await f.discover(
      f.viewFor(root),
      async (service) => {
        const page = await search(service);
        expect(page.catalogErrors[0]).toMatchObject({ stale: true });
      },
      { defer },
    );
    expect(deferred).toHaveLength(1);
    // The downstream recovers after the request ended; the tail's listing owns its own signal and connection.
    f.mode("ok");
    await Promise.all(deferred);
    const listings = f.listings();
    const page = await f.discover(f.viewFor(root), search, { defer });
    // A warmed cache with a cleared record: the next search reports nothing and asks nothing.
    expect(page.catalogErrors).toEqual([]);
    expect(page.entries).toHaveLength(1);
    expect(f.listings()).toBe(listings);
  });

  it("INV-7 INV-8: a refresh that keeps hanging ends at its deadline and publishes nothing", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    const deferred: Promise<unknown>[] = [];
    await f.discover(f.viewFor(root), search, {
      defer: (work) => void deferred.push(work),
      probeTimeoutMs: 800,
      unscopedProbeTimeoutMs: 50,
    });
    const started = performance.now();
    await Promise.all(deferred);
    expect(performance.now() - started).toBeLessThan(2_000);
    const page = await f.discover(f.viewFor(root), search);
    expect(page.catalogErrors[0]).toMatchObject({ code: "timeout", stale: true, ageMs: 2_000 });
    expect(page.catalogErrors[0]?.retryAfterMs).toBeGreaterThan(50_000);
  });

  it("does not refresh without a runtime tail, or when a probe already had the longest deadline", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    const listed = f.listings();
    await f.discover(f.viewFor(root), search);
    expect(f.listings() - listed).toBe(1);
    const deferred: Promise<unknown>[] = [];
    time.now += 61_000;
    await f.discover(f.viewFor(root), search, {
      defer: (work) => void deferred.push(work),
      probeTimeoutMs: 100,
      unscopedProbeTimeoutMs: 100,
    });
    expect(deferred).toEqual([]);
  });

  describe("a refused listing retires stale reuse", () => {
    const generous = { probeTimeoutMs: 5_000, unscopedProbeTimeoutMs: 5_000 };

    it.each([
      ["a 403 on tools/list", "error", {}, "provider_permission_denied"],
      ["a 401 on tools/list", "unauthorized", {}, "auth_required"],
      ["a 403 during the handshake", "denied", { legacy: true }, "provider_permission_denied"],
    ] as const)(
      "INV-5 INV-8: %s holds until a listing succeeds, in every isolate",
      async (_name, mode, options, code) => {
        const f = await fixture({ ttl: 1_000, ...options });
        const time = clock();
        const root = f.registry();
        await f.read(root);
        time.now += 2_000;
        f.mode(mode);
        const refused = await f.discover(f.viewFor(root), search, generous);
        expect(refused.entries).toEqual([]);
        expect(refused.catalogErrors).toEqual([expect.objectContaining({ code })]);
        // The next request times out: the denied catalog does not come back.
        f.mode("stalled");
        const after = await f.discover(f.viewFor(root), search);
        expect(after.entries).toEqual([]);
        expect(after.catalogErrors[0]?.stale).toBeUndefined();
        // Nor in another isolate, which shares nothing with this one but storage.
        const elsewhere = await f.discover(f.viewFor(f.registry(f.newConnector())), search);
        expect(elsewhere.entries).toEqual([]);
        expect(elsewhere.catalogErrors[0]?.stale).toBeUndefined();
        // A complete listing restores reuse, of the catalog it just published.
        f.mode("ok");
        time.now += 61_000;
        expect(await f.read(root)).toHaveLength(1);
        time.now += 2_000;
        f.mode("stalled");
        const restored = await f.discover(f.viewFor(f.registry(f.newConnector())), search);
        expect(restored.entries.map((entry) => entry.tool.name)).toEqual(["read"]);
        expect(restored.catalogErrors[0]).toMatchObject({ code: "timeout", stale: true });
      },
    );

    it("INV-5: fences one caller's credential, and every caller of a shared one", async () => {
      const own = await fixture({ ttl: 1_000 });
      const time = clock();
      const root = own.registry();
      await own.read(root);
      await own.read(root, "b");
      time.now += 2_000;
      own.mode("error");
      await own.discover(own.viewFor(root), search, generous);
      own.mode("stalled");
      // Another person's refusal says nothing about this person's access.
      const unaffected = await own.discover(own.viewFor(root, "b"), search);
      expect(unaffected.entries).toHaveLength(1);
      expect(unaffected.catalogErrors[0]).toMatchObject({ stale: true });
      // The same refusal of a credential everyone shares says it about all of them.
      const shared = await fixture({ ttl: 1_000, operatorShared: true });
      const sharedRoot = shared.registry();
      await shared.read(sharedRoot);
      await shared.read(sharedRoot, "b", "two");
      time.now += 2_000;
      shared.mode("stalled");
      // Listed until the refusal, so what follows is the fence and not a miss.
      expect((await shared.discover(shared.viewFor(sharedRoot, "b", "two"), search)).entries).toHaveLength(1);
      shared.mode("error");
      await shared.discover(shared.viewFor(sharedRoot), search, generous);
      shared.mode("stalled");
      const fenced = await shared.discover(shared.viewFor(sharedRoot, "b", "two"), search);
      expect(fenced.entries).toEqual([]);
      expect(fenced.catalogErrors[0]?.stale).toBeUndefined();
    });

    it("INV-5 INV-8: a listing already running when the refusal lands does not lift the fence", async () => {
      const store = await storage();
      const id = `fence_${crypto.randomUUID().replaceAll("-", "")}`;
      await invalidateCatalogCache(store, id);
      const instance = async () => {
        const ctx = { ...connectorContext(store), requestScope: {} };
        const cache = await catalogClientOptions(ctx, id, "configuration", "grant");
        const key = { method: "tools/list", partition: JSON.stringify(["server", cache.cachePartition]) };
        return { ctx, cache, key, store: cache.responseCacheStore! };
      };
      const tools = [{ name: "read", inputSchema: { type: "object" as const } }];
      const publish = (a: Awaited<ReturnType<typeof instance>>) =>
        a.store.set(a.key, { value: JSON.stringify({ tools, ttlMs: 60_000 }), expiresAt: Date.now() + 60_000 });
      const running = await instance();
      await running.cache.withListing(running.ctx, async () => {
        await running.store.get(running.key);
        const other = await instance();
        await other.cache.fenceTools(other.ctx, await other.cache.bindListing(other.ctx));
        await publish(running);
      });
      const fenced = await instance();
      const read = (a: Awaited<ReturnType<typeof instance>>) =>
        a.cache.withListing(a.ctx, () => a.store.get(a.key) as Promise<unknown>);
      expect(await read(fenced)).toBeUndefined();
      const next = await instance();
      await next.cache.withListing(next.ctx, async () => {
        await next.store.get(next.key);
        await publish(next);
      });
      expect(await read(await instance())).toBeDefined();
    });

    // Holds the next wire request of this method; it is answered as the mode says once released.
    const holdNext = (method: string) => {
      const inner = globalThis.fetch;
      const started = deferred<void>();
      const released = deferred<void>();
      let held = false;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.method === "POST" ? ((await request.clone().json()) as { method?: string }) : undefined;
        if (!held && body?.method === method) {
          held = true;
          started.resolve();
          await released.promise;
        }
        return inner(input, init);
      });
      return { started: started.promise, release: () => released.resolve() };
    };

    it("INV-5 INV-8: a remote listing begun before a refusal elsewhere cannot lift it", async () => {
      const f = await fixture({ ttl: 1_000 });
      const time = clock();
      const root = f.registry();
      await f.read(root);
      time.now += 2_000;
      const hold = holdNext("tools/list");
      const running = f.read(root);
      await hold.started;
      f.mode("error");
      const refused = await f.discover(f.viewFor(f.registry(f.newConnector())), search, generous);
      expect(refused.catalogErrors).toEqual([expect.objectContaining({ code: "provider_permission_denied" })]);
      f.mode("ok");
      hold.release();
      await running;
      f.mode("stalled");
      const after = await f.discover(f.viewFor(f.registry(f.newConnector())), search);
      expect(after.entries).toEqual([]);
      expect(after.catalogErrors[0]?.stale).toBeUndefined();
    });

    it.each([
      ["tools/list", "tools/list", "error", {}],
      ["the handshake", "initialize", "denied", { legacy: true }],
    ] as const)(
      "INV-5: a refusal of %s fences the credential that attempt sent, not the one current when it answers",
      async (_name, method, mode, options) => {
        const f = await fixture({ ttl: 1_000, ...options });
        const time = clock();
        const root = f.registry();
        await f.read(root);
        f.rotate(TOKEN_B);
        await f.read(root);
        f.rotate(TOKEN_A);
        time.now += 2_000;
        f.mode(mode);
        const hold = holdNext(method);
        const attempt = f.read(root);
        await hold.started;
        f.rotate(TOKEN_B);
        hold.release();
        await expect(attempt).rejects.toMatchObject({ code: "provider_permission_denied" });
        // B was never refused, so its catalog still stands in for it.
        f.mode("stalled");
        const unrefused = await f.discover(f.viewFor(root), search);
        expect(unrefused.entries).toHaveLength(1);
        expect(unrefused.catalogErrors[0]).toMatchObject({ stale: true });
        // A was, so neither a later failure nor a timeout brings its catalog back.
        f.rotate(TOKEN_A);
        f.mode("transient");
        await expect(f.read(root)).rejects.toMatchObject({ code: "connector_call_failed" });
        f.mode("stalled");
        const fenced = await f.discover(f.viewFor(f.registry(f.newConnector())), search);
        expect(fenced.entries).toEqual([]);
        expect(fenced.catalogErrors[0]?.stale).toBeUndefined();
      },
    );

    const cacheFixture = async (identity?: () => string) => {
      const store = await storage();
      const id = `fence_${crypto.randomUUID().replaceAll("-", "")}`;
      await invalidateCatalogCache(store, id);
      const open = async () => {
        const ctx = { ...connectorContext(store), requestScope: {} };
        const cache = await catalogClientOptions(
          ctx,
          id,
          "configuration",
          "grant",
          undefined,
          undefined,
          "private",
          identity ? async () => identity() : undefined,
        );
        const key = { method: "tools/list", partition: JSON.stringify(["server", cache.cachePartition]) };
        return { ctx, cache, key, store: cache.responseCacheStore! };
      };
      type Open = Awaited<ReturnType<typeof open>>;
      const publish = async (a: Open) =>
        await a.store.set(a.key, {
          value: JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000 }),
          expiresAt: Date.now() + 60_000,
        });
      const list = (a: Open) => a.cache.withListing(a.ctx, () => a.store.get(a.key) as Promise<unknown>);
      const refused = async () => {
        const other = await open();
        await other.cache.fenceTools(other.ctx, await other.cache.bindListing(other.ctx));
      };
      return { open, publish, list, refused };
    };

    it("INV-5 INV-8: a listing that skips the cache read lifts only the fence captured before it dispatched", async () => {
      const f = await cacheFixture();
      // With nothing captured a publication lifts nothing, whatever it reads at the end.
      const first = await f.open();
      await first.cache.withListing(first.ctx, async () => {
        await f.refused();
        await f.publish(first);
      });
      expect(await f.list(await f.open())).toBeUndefined();
      // What an SDK refresh captures before it asks: the fence already there is lifted.
      const refresh = await f.open();
      await refresh.cache.withListing(refresh.ctx, async () => {
        await refresh.cache.captureFence();
        await f.publish(refresh);
      });
      expect(await f.list(await f.open())).toBeDefined();
      // And one landing after that capture stays.
      const raced = await f.open();
      await raced.cache.withListing(raced.ctx, async () => {
        await raced.cache.captureFence();
        await f.refused();
        await f.publish(raced);
      });
      expect(await f.list(await f.open())).toBeUndefined();
    });

    it("INV-5: a fence keeps the identity and generation its attempt was bound to", async () => {
      let identity = "tokens-a";
      const f = await cacheFixture(() => identity);
      const seed = async () => {
        const a = await f.open();
        await a.cache.withListing(a.ctx, () => f.publish(a));
      };
      const reads = async (value: string) => {
        identity = value;
        return (await f.list(await f.open())) !== undefined;
      };
      await seed();
      identity = "tokens-b";
      await seed();
      // A listing's own refusal, after the grant moved on.
      identity = "tokens-a";
      const running = await f.open();
      await running.cache.withListing(running.ctx, async () => {
        identity = "tokens-b";
        await running.cache.fenceListing();
      });
      expect(await reads("tokens-b")).toBe(true);
      expect(await reads("tokens-a")).toBe(false);
      // A handshake's: the credential read for it is pinned, and the resolver is not asked again.
      const handshake = await f.open();
      identity = "tokens-c";
      const bound = await handshake.cache.bindListing(handshake.ctx, { credentialIdentity: "tokens-b" });
      await handshake.cache.fenceTools(handshake.ctx, bound);
      expect(await reads("tokens-c")).toBe(false);
      expect(await reads("tokens-b")).toBe(false);
      // An invalidation since retired that generation, so its fence reaches nothing newer.
      identity = "tokens-d";
      await seed();
      const late = await f.open();
      const older = await late.cache.bindListing(late.ctx);
      await late.cache.fenceTools(late.ctx, { ...older, generation: crypto.randomUUID() });
      expect(await reads("tokens-d")).toBe(true);
    });

    const customFixture = async () => {
      const store = await storage();
      const id = `custom_${crypto.randomUUID().replaceAll("-", "")}`;
      const vault = new CredentialVault(store, btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
      await vault.set(id, TOKEN_A, "operator");
      const tools = [{ name: "read", inputSchema: { type: "object" as const }, annotations: { readOnlyHint: true } }];
      const denied = () => new ConnectorCallError("provider_permission_denied", "Refused.");
      let answer = async (_ctx: ConnectorContext) => tools as typeof tools;
      const root = new Registry(
        [
          {
            id,
            kind: "mcp" as const,
            credential: { label: "Key" },
            listTools: (ctx) => answer(ctx),
            callTool: async () => ({}),
          },
        ],
        { storage: store, logger: silentLogger, credentialVault: vault },
      );
      const view = root.scoped({
        connectorIds: [id],
        principalKey: "a",
        caller: {
          identity: { actor: { kind: "human", id: "a", namespace: "test" }, interactive: true },
          authenticated: true,
          pool: "one",
        },
      });
      const list = () => view.getTools(id, BASE, {});
      // The connector hangs, so what discovery lists is whatever stands in for it.
      const hungSearch = async () => {
        const before = answer;
        answer = () => new Promise<never>(() => undefined);
        try {
          return await search(
            new CatalogService(view, BASE, { requestScope: {}, probeTimeoutMs: 60, unscopedProbeTimeoutMs: 60 }),
          );
        } finally {
          answer = before;
        }
      };
      // The next listing waits for release; `started` says it has been dispatched.
      const holdNext = (outcome: (ctx: ConnectorContext) => Promise<typeof tools>) => {
        const started = deferred<void>();
        const released = deferred<void>();
        const healthy = answer;
        answer = async (ctx) => {
          answer = healthy;
          started.resolve();
          await released.promise;
          return outcome(ctx);
        };
        return { started: started.promise, release: () => released.resolve() };
      };
      return {
        id,
        vault,
        tools,
        denied,
        list,
        hungSearch,
        holdNext,
        refuseNext: () => {
          const healthy = answer;
          answer = async () => {
            answer = healthy;
            throw denied();
          };
        },
        // A skip from the last hung search must not stand between tests of one store.
        clearHealth: async () => {
          for (const key of await store.list("connector-health:")) await store.delete(key);
        },
      };
    };

    it("INV-5 INV-8: a custom listing begun before a refusal cannot lift it, and one begun after can", async () => {
      const f = await customFixture();
      await f.list();
      expect((await f.hungSearch()).entries).toHaveLength(1);
      const running = f.holdNext(async () => f.tools);
      const older = f.list();
      await running.started;
      f.refuseNext();
      await expect(f.list()).rejects.toMatchObject({ code: "provider_permission_denied" });
      running.release();
      await older;
      await f.clearHealth();
      const fenced = await f.hungSearch();
      expect(fenced.entries).toEqual([]);
      expect(fenced.catalogErrors[0]?.stale).toBeUndefined();
      await f.list();
      await f.clearHealth();
      const restored = await f.hungSearch();
      expect(restored.entries).toHaveLength(1);
      expect(restored.catalogErrors[0]).toMatchObject({ stale: true });
    });

    it("INV-5: a custom refusal with an unchanged credential fences only that credential", async () => {
      const f = await customFixture();
      await f.list();
      await f.vault.set(f.id, TOKEN_B, "operator");
      await f.list();
      await f.vault.set(f.id, TOKEN_A, "operator");
      f.refuseNext();
      await expect(f.list()).rejects.toMatchObject({ code: "provider_permission_denied" });
      await f.vault.set(f.id, TOKEN_B, "operator");
      await f.clearHealth();
      const unrefused = await f.hungSearch();
      expect(unrefused.entries).toHaveLength(1);
      expect(unrefused.catalogErrors[0]).toMatchObject({ stale: true });
      await f.vault.set(f.id, TOKEN_A, "operator");
      await f.clearHealth();
      const fenced = await f.hungSearch();
      expect(fenced.entries).toEqual([]);
      expect(fenced.catalogErrors[0]?.stale).toBeUndefined();
    });

    it.each<[string, (f: Awaited<ReturnType<typeof customFixture>>, ctx: ConnectorContext) => Promise<unknown>]>([
      ["ctx.credential.getAll", (_f, ctx) => ctx.credential!.getAll()],
      ["ctx.credential.get", (_f, ctx) => ctx.credential!.get()],
      ["its own read of the vault", (f) => f.vault.getAll(f.id, undefined)],
    ])(
      "INV-5 INV-8: a credential rotated before a custom connector reads it through %s retires both catalogs",
      async (_route, read) => {
        const f = await customFixture();
        await f.list();
        await f.vault.set(f.id, TOKEN_B, "operator");
        await f.list();
        await f.vault.set(f.id, TOKEN_A, "operator");
        const refused = f.holdNext(async (ctx) => {
          expect(JSON.stringify(await read(f, ctx))).toContain(TOKEN_B);
          throw f.denied();
        });
        const attempt = f.list();
        await refused.started;
        await f.vault.set(f.id, TOKEN_B, "operator");
        refused.release();
        await expect(attempt).rejects.toMatchObject({ code: "provider_permission_denied" });
        for (const token of [TOKEN_B, TOKEN_A]) {
          await f.vault.set(f.id, token, "operator");
          await f.clearHealth();
          const retired = await f.hungSearch();
          expect(retired.entries).toEqual([]);
          expect(retired.catalogErrors[0]?.stale).toBeUndefined();
        }
        await f.vault.set(f.id, TOKEN_B, "operator");
        await f.list();
        await f.clearHealth();
        const restored = await f.hungSearch();
        expect(restored.entries).toHaveLength(1);
        expect(restored.catalogErrors[0]).toMatchObject({ stale: true });
      },
    );

    it("INV-5 INV-8: a custom answer outlived by its credential is retained for neither credential", async () => {
      const f = await customFixture();
      const running = f.holdNext(async () => f.tools);
      const attempt = f.list();
      await running.started;
      await f.vault.set(f.id, TOKEN_B, "operator");
      running.release();
      await attempt;
      expect((await f.hungSearch()).entries).toEqual([]);
      await f.vault.set(f.id, TOKEN_A, "operator");
      await f.clearHealth();
      expect((await f.hungSearch()).entries).toEqual([]);
    });

    it("a fence write that fails is logged and never replaces the refusal", async () => {
      const f = await fixture({ ttl: 1_000 });
      const time = clock();
      const warning = vi.spyOn(silentLogger, "warn");
      const root = f.registry();
      await f.read(root);
      time.now += 2_000;
      const set = f.store.set.bind(f.store);
      vi.spyOn(f.store, "set").mockImplementation((key, ...rest) =>
        key.startsWith("response-cache:") ? Promise.reject(new Error(`Write refused ${TOKEN_A}`)) : set(key, ...rest),
      );
      f.mode("error");
      await expect(f.read(root)).rejects.toMatchObject({ code: "provider_permission_denied" });
      expect(warning.mock.calls.map(([message]) => message)).toContain("[connecta] catalog fence failed");
      expect(JSON.stringify(warning.mock.calls)).not.toContain(TOKEN_A);
    });

    it("INV-10: a refusal writes one key beside the catalog, and a success with no fence writes none", async () => {
      const f = await fixture({ ttl: 1_000 });
      const time = clock();
      const root = f.registry();
      await f.read(root);
      const keys = async () => new Set(await f.store.list("response-cache:"));
      const before = await keys();
      time.now += 2_000;
      f.mode("error");
      await expect(f.read(root)).rejects.toMatchObject({ code: "provider_permission_denied" });
      const added = [...(await keys())].filter((key) => !before.has(key));
      expect(added).toHaveLength(1);
      f.mode("ok");
      await f.read(root);
      expect(await keys()).not.toContain(added[0]);
    });
  });

  it.each(["this isolate", "another isolate"])(
    "INV-5 INV-8: an invalidation from %s during a hanging probe retires what was peeked before it",
    async (from) => {
      const f = await fixture({ ttl: 1_000 });
      const time = clock();
      const root = f.registry();
      await f.read(root);
      time.now += 2_000;
      f.mode("stalled");
      const listed = f.listings();
      const searching = f.discover(f.viewFor(root), search, { unscopedProbeTimeoutMs: 300 });
      await waitFor(async () => f.listings() > listed);
      if (from === "this isolate") await invalidateCatalogCache(f.store, f.id);
      else await f.store.set(responseCacheKeys.generation(f.id), crypto.randomUUID());
      const page = await searching;
      expect(page.entries).toEqual([]);
      expect(page.catalogErrors[0]?.stale).toBeUndefined();
    },
  );

  it("INV-5 INV-8: a refusal elsewhere during a hanging probe retires what was peeked before it", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    const listed = f.listings();
    const searching = f.discover(f.viewFor(root), search, { unscopedProbeTimeoutMs: 500 });
    await waitFor(async () => f.listings() > listed);
    f.mode("error");
    await expect(f.read(f.registry(f.newConnector()))).rejects.toMatchObject({ code: "provider_permission_denied" });
    const page = await searching;
    expect(page.entries).toEqual([]);
    expect(page.catalogErrors[0]?.stale).toBeUndefined();
  });

  it("INV-7: concurrent failures start one refresh, whichever settles last", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    const listed = f.listings();
    const deferred: Promise<unknown>[] = [];
    const pages = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.discover(f.viewFor(root), search, {
          defer: (work) => void deferred.push(work),
          probeTimeoutMs: 1_600,
          unscopedProbeTimeoutMs: 300,
        }),
      ),
    );
    for (let settled = 0; settled < deferred.length; settled++) await deferred[settled];
    // A search that started late skips the record, which carries a retry time; the rest each asked once.
    const asked = pages.filter((page) => page.catalogErrors[0]?.retryAfterMs === undefined).length;
    // The record's one owner asked once more.
    expect(f.listings() - listed).toBe(asked + 1);
  });

  it("INV-7: a settlement that did not land owns no refresh", async () => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    const compareAndSet = f.store.compareAndSet.bind(f.store);
    vi.spyOn(f.store, "compareAndSet").mockImplementation(async (key, ...rest) =>
      key.includes("discovery") ? false : compareAndSet(key, ...rest),
    );
    const listed = f.listings();
    const deferred: Promise<unknown>[] = [];
    const page = await f.discover(f.viewFor(root), search, {
      defer: (work) => void deferred.push(work),
      probeTimeoutMs: 400,
      unscopedProbeTimeoutMs: 50,
    });
    await Promise.all(deferred);
    expect(page.catalogErrors[0]).toMatchObject({ code: "timeout", stale: true });
    expect(f.listings() - listed).toBe(1);
  });

  it("INV-7: only one of two requests claims a record neither of them saw", async () => {
    const f = await fixture({ ttl: 1_000 });
    const slot = (): HealthSlot => ({
      storage: f.store,
      key: `conn:${f.id}:discovery-claim-probe`,
      logger: silentLogger,
      generation: null,
      raw: null,
    });
    const claims = await Promise.all(
      [slot(), slot()].map((claimant) => runEdge(claimDiscoveryProbe(claimant, Date.now() + 5_000))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ["claim", 2, 0],
    ["settlement", 3, 1],
  ] as const)("INV-7: a slow %s stays inside the refresh's tail", async (_name, slowCall, dispatched) => {
    const f = await fixture({ ttl: 1_000 });
    const time = clock();
    const root = f.registry();
    await f.read(root);
    time.now += 2_000;
    f.mode("stalled");
    // Health writes in order: the search's settlement, the claim, the refresh's settlement.
    let healthWrites = 0;
    const slowed = async (key: string) => {
      if (key.includes("discovery") && ++healthWrites === slowCall)
        await new Promise((resolve) => setTimeout(resolve, 3_000));
    };
    const compareAndSet = f.store.compareAndSet.bind(f.store);
    vi.spyOn(f.store, "compareAndSet").mockImplementation(async (key, ...rest) => {
      await slowed(key);
      return compareAndSet(key, ...rest);
    });
    const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, "set").mockImplementation(async (key, ...rest) => {
      await slowed(key);
      return set(key, ...rest);
    });
    const listed = f.listings();
    const deferred: Promise<unknown>[] = [];
    await f.discover(f.viewFor(root), search, {
      defer: (work) => void deferred.push(work),
      probeTimeoutMs: 400,
      unscopedProbeTimeoutMs: 50,
    });
    const started = performance.now();
    for (let settled = 0; settled < deferred.length; settled++) await deferred[settled];
    expect(performance.now() - started).toBeLessThan(2_500);
    // One ask from the search, and one from the refresh only if its claim landed in time.
    expect(f.listings() - listed).toBe(1 + dispatched);
  });

  it("carries the provider's retry delay into a stale listing", async () => {
    const store = await storage();
    const id = `limited_${crypto.randomUUID().replaceAll("-", "")}`;
    let limited = false;
    const root = new Registry(
      [
        {
          id,
          kind: "mcp" as const,
          listTools: async () => {
            if (limited)
              throw new ConnectorCallError("rate_limited", "Slow down.", { retryable: true, retryAfterMs: 120_000 });
            return [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
          },
          callTool: async () => ({}),
        },
      ],
      { storage: store, logger: silentLogger, toolCacheTtlSeconds: 1 },
    );
    const view = root.scoped({
      connectorIds: [id],
      principalKey: "a",
      caller: {
        identity: { actor: { kind: "human", id: "a", namespace: "test" }, interactive: true },
        authenticated: true,
        pool: "one",
      },
    });
    const service = () => new CatalogService(view, BASE, { requestScope: {} });
    await search(service());
    limited = true;
    const time = clock();
    time.now += 2_000;
    const page = await search(service());
    expect(page.entries).toHaveLength(1);
    expect(page.catalogErrors).toEqual([
      expect.objectContaining({ code: "rate_limited", stale: true, retryAfterMs: 120_000 }),
    ]);
    expect(page.catalogErrors[0]!.message).toContain("Wait 120000 ms");
    expect(page.catalogErrors[0]!.message).not.toContain("try it now");
  });
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
  const control = { stalled: false };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // A connector too slow for any deadline: it ends only when its caller gives up.
    if (control.stalled)
      await new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
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
    control,
    listings: () => requests.filter((method) => method === "tools/list").length,
    handshakes: () => requests.filter((method) => method === "initialize").length,
  };
}

describe("pre-connect cached catalogs", () => {
  async function deployment(
    hint: { ttlMs?: number } = {},
    options: {
      store?: KVStorage;
      suffix?: string;
      vaultKey?: number;
      header?: string;
      url?: string;
      /** The shared connector without auth, so its URL is its only configured value. */
      bare?: boolean;
    } = {},
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
        ...(options.bare
          ? {}
          : { auth: { type: "headers" as const, headers: { Authorization: `Bearer ${options.header ?? TOKEN_A}` } } }),
      }),
      remoteMcp(ids.keyed, { url: "https://tickets.test/mcp", fetch: keyed.fetch, auth: { type: "credential" } }),
      remoteMcp(ids.pinned, { url: "https://notes.test/mcp", fetch: pinned.fetch, versionNegotiation: "legacy" }),
      calcConnector,
    ];
    await vault.set(ids.keyed, TOKEN_A, "operator");
    const downstreams = [shared, keyed, pinned];
    // Each search is one request: a fresh registry over the same storage, as
    // in a new isolate, whose connector scopes close when it ends.
    const search = async (
      registry = makeRegistry(connectors, { storage: store, credentialVault: vault }),
      service: ConstructorParameters<typeof CatalogService>[2] = {},
    ) => {
      const requestScope = {};
      try {
        return await new CatalogService(registry, BASE, { requestScope, ...service }).search({ query: "read" });
      } finally {
        for (const connector of connectors)
          await connector.closeScope?.(registry.contextFor(connector.id, BASE, requestScope));
      }
    };
    return {
      store,
      vault,
      ids,
      connectors,
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

  it("INV-8: slow connectors keep their last complete catalog in an unscoped search after its TTL expires", async () => {
    const d = await deployment();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const warm = await d.search();
    expect(names(warm)).toEqual(["crm_read", "notes_read", "tickets_read"]);
    now += 301_000;
    for (const downstream of d.downstreams) downstream.control.stalled = true;
    const slow = await d.search(undefined, { probeTimeoutMs: 100 });
    expect(names(slow)).toEqual(["crm_read", "notes_read", "tickets_read"]);
    expect(slow.total).toBe(3);
    expect(slow.catalogErrors.map((error) => [error.connector, error.code, error.stale, error.ageMs]).sort()).toEqual(
      [d.ids.shared, d.ids.pinned, d.ids.keyed].sort().map((id) => [id, "timeout", true, 301_000]),
    );
  });

  it("a current catalog takes no probe slot, so it never waits behind a connector that must be asked", async () => {
    const d = await deployment();
    await d.search();
    // Only the first connector has lost its catalog, and it now has to be asked.
    await invalidateCatalogCache(d.store, d.ids.shared);
    d.downstreams[0]!.control.stalled = true;
    // One slot, spent whole by the first connector before the budget ends.
    const page = await d.search(undefined, { concurrency: 1, unscopedProbeTimeoutMs: 400, discoveryBudgetMs: 150 });
    expect(names(page)).toEqual(["notes_read", "tickets_read"]);
    expect(page.catalogErrors.map((error) => error.connector)).toEqual([d.ids.shared]);
    expect(page.catalogErrors[0]).toMatchObject({ code: "timeout" });
    expect(page.catalogErrors[0]?.stale).toBeUndefined();
  });

  it("INV-8: a native listing keeps a stale catalog, but a native call's resolution never sees it", async () => {
    const d = await deployment();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await d.search();
    now += 301_000;
    for (const downstream of d.downstreams) downstream.control.stalled = true;
    const list = async (allowStale: boolean) => {
      const requestScope = {};
      const registry = makeRegistry(d.connectors, { storage: d.store, credentialVault: d.vault });
      try {
        return await new CatalogService(registry, BASE, {
          requestScope,
          probeTimeoutMs: 100,
          concurrency: 8,
        }).listCatalogs(true, registry.listConnectors(), allowStale);
      } finally {
        for (const connector of d.connectors)
          await connector.closeScope?.(registry.contextFor(connector.id, BASE, requestScope));
      }
    };
    const listed = await list(true);
    expect(listed.flatMap((entry) => ("tools" in entry ? entry.tools.map((tool) => tool.name) : [])).sort()).toEqual(
      expect.arrayContaining(["crm_read", "notes_read", "tickets_read"]),
    );
    expect(listed.filter((entry) => "tools" in entry && catalogStaleness(entry.tools))).toHaveLength(3);
    const resolving = await list(false);
    expect(resolving.filter((entry) => "error" in entry)).toHaveLength(3);
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

  // Every stored row that addresses a downstream catalog, negotiation verdict or health record.
  const cacheRows = async (store: KVStorage) =>
    Promise.all(
      (await store.list(""))
        .filter((key) => /response-cache:|negotiation:|connector-health:/.test(key))
        .map(async (key) => [key, (await store.get(key)) ?? ""] as const),
    );

  it("INV-5 INV-6: cache keys depend on the deployment key, never on a guessable configured value alone", async () => {
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
    // Every connector's configuration is keyed whole, so each lists again.
    expect(second.downstreams.map((downstream) => downstream.listings())).toEqual([1, 1, 1]);
    expect(second.handshakes()).toBe(3);
    const keys = (rows: (readonly [string, string])[]) =>
      new Set(rows.map(([key]) => key).filter((key) => !key.endsWith(":generation")));
    const earlier = keys(before);
    expect(earlier.size).toBeGreaterThan(0);
    const fresh = [...keys(await cacheRows(store))].filter((key) => !earlier.has(key));
    for (const id of Object.values(first.ids)) expect(fresh.some((key) => key.includes(id))).toBe(true);
  });

  it("INV-4 INV-5 INV-6: an endpoint path token keys its partitions only through the deployment key", async () => {
    const store = await storage();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const [tokenA, tokenB] = ["pt7Qw2Zr9Lk4Vx", "pt3Hm8Ns1Bd6Jc"];
    const url = (token: string) => `https://crm.test/mcp/${token}`;
    const search = async (token: string, vaultKey = 7) => {
      const d = await deployment({}, { store, suffix, url: url(token), vaultKey, bare: true });
      await d.search();
      return d;
    };
    const shared = `crm_${suffix}`;
    // The catalog configuration digests and negotiation keys stored for the endpoint.
    const fingerprints = async () =>
      new Set(
        (await store.list("")).flatMap((key) => {
          if (key.startsWith(responseCacheKeys.prefix(shared))) {
            const config = /^(sha256:\d+:[0-9a-f]{64}):/.exec(key.slice(responseCacheKeys.prefix(shared).length));
            return config ? [config[1]!] : [];
          }
          return key.startsWith(scopes.connector(shared)) && key.includes("negotiation:") ? [key] : [];
        }),
      );
    expect((await search(tokenA)).downstreams[0]!.listings()).toBe(1);
    // The same token is warm.
    expect((await search(tokenA)).requests()).toBe(0);
    const first = await fingerprints();
    expect(first.size).toBe(2);
    // Another token is its own partition; the other connectors stay warm.
    const other = await search(tokenB);
    expect(other.downstreams.map((downstream) => downstream.listings())).toEqual([1, 0, 0]);
    expect((await fingerprints()).size).toBe(4);
    // A rotated deployment key changes both fingerprints for the same token;
    // the original key finds its entries again.
    const before = await fingerprints();
    expect((await search(tokenA, 9)).downstreams[0]!.listings()).toBe(1);
    const rotated = [...(await fingerprints())].filter((fingerprint) => !before.has(fingerprint));
    expect(rotated).toHaveLength(2);
    expect((await search(tokenA)).requests()).toBe(0);
    // No row holds a path token, or a plain digest of it or of the URL.
    const guesses = [tokenA, tokenB, url(tokenA), url(tokenB), `/mcp/${tokenA}`, `/mcp/${tokenB}`];
    const needles = [
      ...guesses,
      ...guesses.map(encodeURIComponent),
      ...(await Promise.all(guesses.map((guess) => sha256Hex(guess)))),
    ];
    for (const [key, value] of await cacheRows(store))
      for (const needle of needles) {
        expect(key).not.toContain(needle);
        expect(value).not.toContain(needle);
      }
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
    // A grant without tokens can neither reuse the cache nor connect anonymously.
    await seedGrant(store, { issuer: "https://calendar.test" }, "v3:reauthorized", scopes.connector(id));
    expect(names(await search())).toEqual([]);
    expect([downstream.handshakes(), downstream.listings()]).toEqual([0, 0]);
    expect(downstream.requests).toEqual([]);
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

  it("INV-5: a refused OAuth handshake fences the tokens it sent, not the grant current when it answers", async () => {
    const d = await oauthDeployment();
    const time = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => time.now);
    await d.grant("access-1");
    expect((await d.search()).entries).toHaveLength(1);
    await d.grant("access-2");
    expect((await d.search()).entries).toHaveLength(1);
    await d.grant("access-1");
    time.now += 301_000;
    const started = deferred<void>();
    const released = deferred<void>();
    let refuse = true;
    vi.stubGlobal("fetch", async () => {
      if (!refuse) return new Response(null, { status: 503 });
      started.resolve();
      await released.promise;
      return new Response("Refused", { status: 403 });
    });
    const refused = d.search();
    await started.promise;
    await d.grant("access-2");
    released.resolve();
    expect((await refused).catalogErrors).toEqual([expect.objectContaining({ code: "provider_permission_denied" })]);
    refuse = false;
    // The next searches have no answer, so what they list is what stands in for each grant.
    time.now += 61_000;
    const unrefused = await d.search();
    expect(unrefused.entries).toHaveLength(1);
    expect(unrefused.catalogErrors[0]).toMatchObject({ stale: true });
    await d.grant("access-1");
    time.now += 61_000;
    const fenced = await d.search();
    expect(fenced.entries).toEqual([]);
    expect(fenced.catalogErrors[0]?.stale).toBeUndefined();
  });

  it.each([
    ["path", (token: string) => `https://client.test/${encodeURIComponent(token)}/client.json`],
    ["query", (token: string) => `https://client.test/connecta/client.json?key=${token}`],
  ] as const)(
    "INV-5 INV-6: a client metadata URL's %s reaches cache keys only through the deployment key",
    async (_shape, metadata) => {
      const store = await storage();
      const id = `calendar_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const search = async (token: string, vaultKey: number) => {
        const d = await oauthDeployment({ vault: true, vaultKey, store, id, clientMetadataUrl: metadata(token) });
        await d.search();
        return d.downstream;
      };
      const seed = () =>
        seedGrant(
          store,
          { issuer: "https://calendar.test", tokens: { access_token: "access-1", token_type: "Bearer" } },
          "v3:seeded",
          scopes.connector(id),
        );
      await seed();
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
      const guesses = [
        TOKEN_A,
        TOKEN_B,
        metadata(TOKEN_A),
        metadata(TOKEN_B),
        `?key=${TOKEN_A}`,
        `?key=${TOKEN_B}`,
        `https://client.test/${encodeURIComponent(TOKEN_A)}/client.json`,
        `/${encodeURIComponent(TOKEN_B)}/client.json`,
      ];
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
      // Reconnect under each key: a grant sealed by the previous deployment
      // cannot authorize an anonymous catalog read after key rotation.
      await seed();
      expect((await search(TOKEN_A, 9)).listings()).toBe(1);
      const rotated = [...(await configs())].filter((config) => !before.has(config));
      expect(rotated).toHaveLength(1);
      expect(first.has(rotated[0]!)).toBe(false);
      await seed();
      expect((await search(TOKEN_A, 7)).requests).toEqual([]);
    },
  );

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

it("reuses only frozen validated JSON after fresh storage checks, without WeakRef", async () => {
  const store = await storage();
  const id = `reuse_${crypto.randomUUID().replaceAll("-", "")}`;
  const open = () => catalogClientOptions(connectorContext(store), id, "configuration", "grant");
  const writer = await open();
  const key = { method: "tools/list", params: "", partition: JSON.stringify(["server", writer.cachePartition]) };
  const value = JSON.stringify({
    tools: [{ name: id, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    ttlMs: 60_000,
  });
  await writer.responseCacheStore!.set(key, { value, expiresAt: Date.now() + 60_000 });
  const validate = vi.spyOn(specTypeSchemas.ListToolsResult["~standard"], "validate");
  const parse = vi.spyOn(JSON, "parse");
  const read = async () => (await open()).responseCacheStore!.get(key);
  const first = await read();
  expect(first).toBeDefined();
  expect(validate).toHaveBeenCalledTimes(1);
  const validated = await validate.mock.results[0]!.value;
  expect(Object.isFrozen(validated.value.tools[0].inputSchema)).toBe(true);
  const parses = () => parse.mock.calls.filter(([raw]) => raw.includes(`"name":"${id}"`)).length;
  expect(parses()).toBe(1);
  // Separate request, no weak references: neither catalog parse nor validation.
  expect(await read()).toEqual(first);
  expect(validate).toHaveBeenCalledTimes(1);
  expect(parses()).toBe(1);
  const copy = JSON.parse(first!.value);
  copy.tools[0].annotations.readOnlyHint = false;
  expect(JSON.parse((await read())!.value).tools[0].annotations.readOnlyHint).toBe(true);

  vi.restoreAllMocks();
  vi.stubGlobal("WeakRef", undefined);
  vi.stubGlobal("FinalizationRegistry", undefined);
  let withoutWeakRefs;
  try {
    withoutWeakRefs = await read();
  } finally {
    vi.unstubAllGlobals();
  }
  expect(withoutWeakRefs).toEqual(first);

  // A missing chunk is still a miss even with an already validated object.
  const keys = await store.list("");
  const chunk = keys.find((entry) => entry.includes(id) && entry.includes(":chunk:"));
  expect(chunk).toBeDefined();
  await store.delete(chunk!);
  expect(await read()).toBeUndefined();
});

it("never accepts warm facts when the generation rotates during the chunk read", async () => {
  const backing = await storage();
  const id = `rotation_${crypto.randomUUID().replaceAll("-", "")}`;
  let rotate = false;
  let rotated = false;
  const store: KVStorage = {
    ...backing,
    async get(key) {
      const value = await backing.get(key);
      if (rotate && key.includes(":chunk:")) {
        rotated = true;
        await invalidateCatalogCache(backing, id);
      }
      return value;
    },
  };
  const open = () => catalogClientOptions(connectorContext(store), id, "configuration", "grant");
  const writer = await open();
  const key = { method: "tools/list", params: "", partition: JSON.stringify(["server", writer.cachePartition]) };
  await writer.responseCacheStore!.set(key, {
    value: JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" } }], ttlMs: 60_000 }),
    expiresAt: Date.now() + 60_000,
  });
  expect(await (await open()).responseCacheStore!.get(key)).toBeDefined();
  rotate = true;
  expect(await (await open()).responseCacheStore!.get(key)).toBeUndefined();
  expect(rotated).toBe(true);
  rotate = false;
  const replacement = await open();
  await replacement.responseCacheStore!.set(key, {
    value: JSON.stringify({
      tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }],
      ttlMs: 60_000,
    }),
    expiresAt: Date.now() + 60_000,
  });
  const current = await (await open()).responseCacheStore!.get(key);
  expect(JSON.parse(current!.value).tools[0].annotations).toEqual({ destructiveHint: true });
});

it("bounds warm partitions and does not reuse public facts across owners", async () => {
  const store = await storage();
  const id = `bounded_${crypto.randomUUID().replaceAll("-", "")}`;
  const open = (owner: string) => {
    const ctx = connectorContext(store);
    attachCatalogCache(ctx, {
      storage: store,
      partition: owner,
      sharedPartition: "deployment",
      defaultTtlMs: 60_000,
      minTtlMs: 0,
      maxTtlMs: 60_000,
    });
    return catalogClientOptions(ctx, id, "configuration", "grant", undefined, undefined, "shared");
  };
  const writer = await open("alice");
  const key = { method: "tools/list", params: "", partition: JSON.stringify(["server", ""]) };
  await writer.responseCacheStore!.set(key, {
    value: JSON.stringify({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
      ttlMs: 60_000,
      cacheScope: "public",
    }),
    expiresAt: Date.now() + 60_000,
    scope: "public",
  });
  const validate = vi.spyOn(specTypeSchemas.ListToolsResult["~standard"], "validate");
  const read = async (owner: string) => (await open(owner)).responseCacheStore!.get(key);
  for (const owner of ["alice", "bob", "carol", "dave", "erin"]) {
    expect(await read(owner)).toBeDefined();
    expect(await read(owner)).toBeDefined();
  }
  expect(validate).toHaveBeenCalledTimes(5);
  // The fifth partition evicted the first; SQL still supplies a valid catalog.
  expect(await read("alice")).toBeDefined();
  expect(validate).toHaveBeenCalledTimes(6);
});
