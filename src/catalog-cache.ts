import { detach, runEdge } from "./runtime/run.js";
import { Deferred, Effect } from "effect";
import {
  authFlow,
  authCall,
  authInvoke,
  authValue,
  authMethod,
  authProgram,
  registerAuth,
  authStorage,
  authMap,
  authAwait,
} from "./auth/native.js";
// The SDK owns aggregation and freshness. This adapter stores only complete,
// intake-redacted catalog successes in the deployment's SQL-backed KV.
import type {
  CacheKey,
  CacheEntry,
  StandardSchemaV1,
  ClientOptions,
  ListToolsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ResponseCacheStore,
} from "@modelcontextprotocol/client";
import { MAX_CACHE_TTL_MS, specTypeSchemas } from "@modelcontextprotocol/client";
import { callerOf } from "./connector-caller.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { Context } from "effect";
import { RequestScope } from "./runtime/request-scope.js";
import { serviceFor, setViewService, viewServices } from "./runtime/call.js";
import { ConnectorCallError } from "./errors.js";
import { fingerprintSerializedCatalog } from "./catalog-fingerprint.js";
import { MAX_CATALOG_CHUNK_BYTES, MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "./catalog-limits.js";
import { redactCatalog, sentSecretsForRequest } from "./sent-secrets.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { responseCacheKeys } from "./storage/keys.js";
import type { ConnectorContext, ConnectorCredentialValues, KVStorage, ToolDef } from "./types.js";

interface CatalogCacheSettings {
  storage: KVStorage;
  partition: string;
  sharedPartition?: string;
  defaultTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
  onCompletedCatalogRefresh?: (refresh: CompletedCatalogRefresh, ctx: ConnectorContext) => void | Promise<void>;
}
export interface CompletedCatalogRefresh {
  connectorId: string;
  previousDigest?: string;
  digest: string;
  previous?: readonly CatalogToolFingerprint[];
  next: readonly CatalogToolFingerprint[];
  private: boolean;
}
export interface CatalogToolFingerprint {
  name: string;
  fact: string;
}
interface RefreshBaseline {
  digest: string;
  tools: CatalogToolFingerprint[];
}
interface RefreshManifest {
  digest: string;
  revision: string;
  chunkCount: number;
  fingerprint: string;
}
/** Publish one accepted catalog refresh, with its partitioned drift baseline. */
export function observeCompletedCatalogRefresh(ctx: ConnectorContext, refresh: CompletedCatalogRefresh): Promise<void> {
  return runEdge(authProgram<void>(observeCompletedCatalogRefreshNative, [ctx, refresh]));
}
const observeCompletedCatalogRefreshNative = /* @__PURE__ */ registerAuth(
  observeCompletedCatalogRefresh,
  (ctx: ConnectorContext, refresh: CompletedCatalogRefresh) =>
    authFlow<void>(function* () {
      (yield authValue(() => serviceFor(ctx, CatalogPolicy)?.onCompletedCatalogRefresh?.(refresh, ctx))) as
        | void
        | undefined;
    }),
);
/** Hash-only facts preserve change counts without storing tool names or schemas. */
function catalogFingerprints(
  tools: readonly {
    name: string;
  }[],
): Promise<CatalogToolFingerprint[]> {
  return runEdge(authProgram<CatalogToolFingerprint[]>(catalogFingerprintsNative, [tools]));
}
const catalogFingerprintsNative = /* @__PURE__ */ registerAuth(
  catalogFingerprints,
  (
    tools: readonly {
      name: string;
    }[],
  ) =>
    authFlow<CatalogToolFingerprint[]>(function* () {
      const facts: CatalogToolFingerprint[] = [];
      for (let offset = 0; offset < tools.length; offset += 128) {
        facts.push(
          ...((yield authMap(
            tools.slice(offset, offset + 128),
            (value) =>
              authCall(
                authMethod((tool: { name: string }) =>
                  authFlow<{
                    name: string;
                    fact: string;
                  }>(function* () {
                    return {
                      name: (
                        (yield authCall(fingerprintSerializedCatalog, [tool.name])) as {
                          fingerprint: string;
                          byteLength: number;
                        }
                      ).fingerprint,
                      fact: (
                        (yield authCall(fingerprintSerializedCatalog, [JSON.stringify(tool)])) as {
                          fingerprint: string;
                          byteLength: number;
                        }
                      ).fingerprint,
                    };
                  }),
                ),
                [value],
              ),
            false,
          )) as {
            name: string;
            fact: string;
          }[]),
        );
      }
      return facts;
    }),
);
function refreshBaseline(
  storage: KVStorage,
  key: string,
  raw: string | null,
  io: CacheOperation["io"],
): Promise<RefreshBaseline | undefined> {
  return runEdge(authProgram<RefreshBaseline | undefined>(refreshBaselineNative, [storage, key, raw, io]));
}
const refreshBaselineNative = /* @__PURE__ */ registerAuth(
  refreshBaseline,
  (storage: KVStorage, key: string, raw: string | null, io: CacheOperation["io"]) =>
    authFlow<RefreshBaseline | undefined>(function* () {
      if (!raw) return;
      try {
        const value = JSON.parse(raw) as RefreshManifest;
        const hash = (v: unknown) => typeof v === "string" && /^sha256:[0-9]+:[0-9a-f]{64}$/.test(v);
        if (
          !hash(value.digest) ||
          !hash(value.fingerprint) ||
          !/^[0-9a-f-]{36}$/.test(value.revision) ||
          !Number.isInteger(value.chunkCount) ||
          value.chunkCount < 1 ||
          value.chunkCount > Math.ceil(MAX_SERIALIZED_CATALOG_BYTES / MAX_CATALOG_CHUNK_BYTES)
        )
          return;
        const chunks: string[] = [];
        for (let index = 0; index < value.chunkCount; index++) {
          const chunk = (yield authCall(io, [
            authMethod(
              () =>
                authStorage(storage, "get", [responseCacheKeys.chunk(key, value.revision, index)]) as Effect.Effect<
                  string | null,
                  unknown
                >,
            ),
          ])) as string | null;
          if (chunk === null || new TextEncoder().encode(chunk).byteLength > MAX_CATALOG_CHUNK_BYTES) return;
          chunks.push(chunk);
        }
        const serialized = chunks.join("");
        if (
          (
            (yield authCall(fingerprintSerializedCatalog, [serialized])) as {
              fingerprint: string;
              byteLength: number;
            }
          ).fingerprint !== value.fingerprint
        )
          return;
        const tools = JSON.parse(serialized) as CatalogToolFingerprint[];
        if (
          Array.isArray(tools) &&
          tools.length <= MAX_CATALOG_TOOLS &&
          tools.every((tool: CatalogToolFingerprint) => tool && hash(tool.name) && hash(tool.fact))
        )
          return { digest: value.digest, tools };
      } catch {}
    }),
);
function acceptCatalogRefresh(
  storage: KVStorage,
  key: string,
  connectorId: string,
  digest: string,
  tools: readonly {
    name: string;
  }[],
  privateCatalog: boolean,
  current: () => Promise<boolean>,
  io: CacheOperation["io"],
): Promise<CompletedCatalogRefresh | undefined> {
  return runEdge(
    authProgram<CompletedCatalogRefresh | undefined>(acceptCatalogRefreshNative, [
      storage,
      key,
      connectorId,
      digest,
      tools,
      privateCatalog,
      current,
      io,
    ]),
  );
}
const acceptCatalogRefreshNative = /* @__PURE__ */ registerAuth(
  acceptCatalogRefresh,
  (
    storage: KVStorage,
    key: string,
    connectorId: string,
    digest: string,
    tools: readonly {
      name: string;
    }[],
    privateCatalog: boolean,
    current: () => Promise<boolean>,
    io: CacheOperation["io"],
  ) =>
    authFlow<CompletedCatalogRefresh | undefined>(function* () {
      const next = (yield authCall(catalogFingerprints, [tools])) as CatalogToolFingerprint[];
      const serialized = JSON.stringify(next);
      const revision = crypto.randomUUID();
      const fingerprint = (
        (yield authCall(fingerprintSerializedCatalog, [serialized])) as {
          fingerprint: string;
          byteLength: number;
        }
      ).fingerprint;
      const chunkCount = Math.ceil(serialized.length / MAX_CATALOG_CHUNK_BYTES);
      for (let index = 0; index < chunkCount; index++) {
        if (!((yield authCall(current, [])) as boolean)) return;
        const chunk = serialized.slice(index * MAX_CATALOG_CHUNK_BYTES, (index + 1) * MAX_CATALOG_CHUNK_BYTES);
        (yield authCall(io, [
          authMethod(
            () =>
              authStorage(storage, "set", [
                responseCacheKeys.chunk(key, revision, index),
                chunk,
                { ttlSeconds: GENERATION_TTL_SECONDS + 300 },
              ]) as Effect.Effect<void, unknown>,
          ),
        ])) as void;
      }
      const manifest: RefreshManifest = { digest, revision, chunkCount, fingerprint };
      for (let attempt = 0; attempt < 16; attempt++) {
        if (!((yield authCall(current, [])) as boolean)) return;
        const raw = (yield authCall(io, [
          authMethod(() => authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>),
        ])) as string | null;
        const previous = (yield authCall(refreshBaseline, [storage, key, raw, io])) as RefreshBaseline | undefined;
        if (!((yield authCall(current, [])) as boolean)) return;
        const published = (yield authCall(io, [
          authMethod(
            () =>
              authStorage(storage, "compareAndSet", [
                key,
                raw,
                JSON.stringify(manifest),
                { ttlSeconds: GENERATION_TTL_SECONDS },
              ]) as Effect.Effect<boolean, unknown>,
          ),
        ])) as boolean;
        if (!((yield authCall(current, [])) as boolean)) return;
        if (published)
          return {
            connectorId,
            digest,
            next,
            private: privateCatalog,
            ...(previous ? { previousDigest: previous.digest, previous: previous.tools } : {}),
          };
      }
      throw new Error("Catalog refresh baseline is busy.");
    }),
);
/** Custom dynamic connectors have no SDK cache; publish their complete intake here. */
export function observeUncachedCatalogRefresh(
  ctx: ConnectorContext,
  connectorId: string,
  tools: readonly {
    name: string;
  }[],
): Promise<void> {
  return runEdge(authProgram<void>(observeUncachedCatalogRefreshNative, [ctx, connectorId, tools]));
}
const observeUncachedCatalogRefreshNative = /* @__PURE__ */ registerAuth(
  observeUncachedCatalogRefresh,
  (
    ctx: ConnectorContext,
    connectorId: string,
    tools: readonly {
      name: string;
    }[],
  ) =>
    authFlow<void>(function* () {
      const policy = serviceFor(ctx, CatalogPolicy);
      if (!policy?.onCompletedCatalogRefresh) return;
      const config = (
        (yield authCall(fingerprintSerializedCatalog, ["custom-connector"])) as {
          fingerprint: string;
          byteLength: number;
        }
      ).fingerprint;
      const partition = (
        (yield authCall(fingerprintSerializedCatalog, [
          JSON.stringify([policy.partition, ctx.baseUrl, ctx.publicUrl]),
        ])) as {
          fingerprint: string;
          byteLength: number;
        }
      ).fingerprint;
      const digest = (
        (yield authCall(fingerprintSerializedCatalog, [JSON.stringify(tools)])) as {
          fingerprint: string;
          byteLength: number;
        }
      ).fingerprint;
      const refresh = (yield authCall(acceptCatalogRefresh, [
        policy.storage,
        responseCacheKeys.refreshDigest(connectorId, config, partition),
        connectorId,
        digest,
        tools,
        true,
        authMethod(() => Effect.sync(() => !ctx.signal?.aborted)),
        authMethod(<T>(read: () => Promise<T>) => authCall(read, []) as Effect.Effect<T, unknown>),
      ])) as CompletedCatalogRefresh | undefined;
      if (refresh) (yield authCall(observeCompletedCatalogRefresh, [ctx, refresh])) as void;
    }),
);
export type CatalogMethod = "tools/list" | "resources/list" | "resources/templates/list";
export type CatalogResult = ListToolsResult | ListResourcesResult | ListResourceTemplatesResult;
export function catalogItems(method: CatalogMethod, result: CatalogResult) {
  if (method === "tools/list") return (result as ListToolsResult).tools;
  if (method === "resources/list") return (result as ListResourcesResult).resources;
  return (result as ListResourceTemplatesResult).resourceTemplates;
}
function catalogSchema(method: CatalogMethod) {
  return method === "tools/list"
    ? specTypeSchemas.ListToolsResult
    : method === "resources/list"
      ? specTypeSchemas.ListResourcesResult
      : specTypeSchemas.ListResourceTemplatesResult;
}

export interface CatalogExpiry {
  fetchedAt: number;
  ttlMs: number;
  expiresAt: number;
  staleFallback: boolean;
}
class CatalogExpiryService extends Context.Service<CatalogExpiryService, Map<CatalogMethod, CatalogExpiry>>()(
  "connecta/operation/CatalogExpiryService",
) {}
class CatalogFetches extends Context.Service<CatalogFetches, Map<CatalogMethod, number>>()(
  "connecta/operation/CatalogFetches",
) {}
export function observeCatalogFetch(ctx: ConnectorContext, at: number, method: CatalogMethod = "tools/list"): void {
  const methods = serviceFor(ctx, CatalogFetches) ?? new Map();
  methods.set(method, at);
  setViewService(ctx, CatalogFetches, methods);
}
export function catalogFetchedAt(ctx: ConnectorContext, method: CatalogMethod = "tools/list"): number | undefined {
  return serviceFor(ctx, CatalogFetches)?.get(method);
}
export function catalogExpiry(ctx: ConnectorContext, method: CatalogMethod = "tools/list"): CatalogExpiry | undefined {
  return serviceFor(ctx, CatalogExpiryService)?.get(method);
}
export function observeCatalogExpiry(
  ctx: ConnectorContext,
  method: CatalogMethod,
  ttlMs: number,
  expiresAt?: number,
  staleFallback = false,
): void {
  const fetchedAt = catalogFetchedAt(ctx, method) ?? Date.now();
  const methods = serviceFor(ctx, CatalogExpiryService) ?? new Map();
  methods.set(method, {
    fetchedAt,
    ttlMs,
    expiresAt: Math.min(expiresAt ?? Infinity, fetchedAt + ttlMs),
    staleFallback,
  });
  setViewService(ctx, CatalogExpiryService, methods);
}
// Tool facts remain available for ordinary calls after a transient listing
// failure for five minutes. Resources never use stale inventories. A fallback
// carries its original expired deadline and cannot authorize auth recovery.
const STALE_FALLBACK_MS = 300_000;
class CatalogPolicy extends Context.Service<CatalogPolicy, CatalogCacheSettings>()(
  "connecta/operation/CatalogPolicy",
) {}
export function attachCatalogCache(ctx: ConnectorContext, value: CatalogCacheSettings): void {
  setViewService(ctx, CatalogPolicy, value);
}
interface CacheScope {
  closed: boolean;
  abort: AbortController;
  invalidating?: Deferred.Deferred<void, unknown>;
}
const defaultOwner = {};
const scopes = new WeakMap<object, Map<string, WeakMap<object, CacheScope>>>();
function cacheScope(ctx: ConnectorContext, connectorId: string, owner = defaultOwner): CacheScope {
  const request = Context.get(viewServices(ctx), RequestScope);
  const key = request;
  let connectors = scopes.get(key);
  if (!connectors) {
    connectors = new Map();
    scopes.set(key, connectors);
  }
  let owners = connectors.get(connectorId);
  if (!owners) {
    owners = new WeakMap();
    connectors.set(connectorId, owners);
  }
  let scope = owners.get(owner);
  if (!scope) {
    scope = { closed: false, abort: new AbortController() };
    owners.set(owner, scope);
    const owned = scope;
    request.own(() => {
      owned.closed = true;
      owned.abort.abort();
    });
  }
  return scope;
}
/** Start the fence before SDK eviction; teardown joins already-started I/O. */
export function observeCatalogChange(
  ctx: ConnectorContext,
  connectorId: string,
  connectionSignal?: AbortSignal,
  owner?: object,
): void {
  const scope = cacheScope(ctx, connectorId, owner);
  if (scope.closed || connectionSignal?.aborted) return;
  const previous = scope.invalidating;
  const settled = Deferred.makeUnsafe<void, unknown>();
  scope.invalidating = settled;
  const writing = authCall<void>(invalidateCatalogCache, [
    serviceFor(ctx, CatalogPolicy)?.storage ?? ctx.storage,
    connectorId,
  ]).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        logFailure(ctx.logger, "catalog invalidation failed", failureRecord({ connector: connectorId }, error)),
      ),
    ),
  );
  // Start the fence in this SDK callback's request, and retain only its native
  // settlement for teardown. Concurrent notifications still begin immediately.
  detach(
    Effect.all([previous ? Deferred.await(previous) : Effect.void, writing], { concurrency: "unbounded" }).pipe(
      Effect.asVoid,
      Effect.provideService(RequestScope, Context.get(viewServices(ctx), RequestScope)),
      Effect.onExit((exit) => Deferred.done(settled, exit)),
    ),
  );
}
export function closeCatalogCacheScope(
  ctx: ConnectorContext,
  connectorId: string,
  owner?: object,
): Promise<void> | undefined {
  const scope = cacheScope(ctx, connectorId, owner);
  scope.closed = true;
  scope.abort.abort();
  return scope.invalidating ? runEdge(Deferred.await(scope.invalidating)) : undefined;
}

/** Zero is an explicit refusal to reuse. Positive hints use the configured bounds. */
function catalogTtlMs(ctx: ConnectorContext, hint: unknown): number {
  const policy = serviceFor(ctx, CatalogPolicy);
  const ttl =
    hint === undefined ? Math.floor(policy?.defaultTtlMs ?? CONFIG_DEFAULTS.discovery.catalogTtlSeconds * 1000) : hint;
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) return 0;
  return Math.floor(
    Math.min(Math.max(ttl, policy?.minTtlMs ?? 0), policy?.maxTtlMs ?? MAX_CACHE_TTL_MS, MAX_CACHE_TTL_MS),
  );
}

/** Sanitize before SDK automatic writes and before its derived tool index. */
export function catalogIntake(
  ctx: ConnectorContext,
  result: ListToolsResult,
): ListToolsResult & { ttlMs: number; cacheScope: "public" | "private" } {
  const tools = redactCatalog(ctx, result.tools).map(({ _meta: _ignored, icons, ...tool }) => ({
    ...tool,
    ...(icons ? { icons: icons.filter((icon) => !/^data:/i.test(icon.src)) } : {}),
  }));
  if (tools.length > MAX_CATALOG_TOOLS) throw catalogCeiling();
  const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redactCredentials({ ...result, tools });
  if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > MAX_SERIALIZED_CATALOG_BYTES) throw catalogCeiling();
  for (const tool of clean.tools) assertHeaderDeclarations(tool.inputSchema);
  return {
    ...clean,
    ttlMs: catalogTtlMs(ctx, result.ttlMs),
    cacheScope: result.cacheScope === "public" ? "public" : "private",
  };
}
/** Refuse before SDK 2.3.1's header exclusion path logs downstream names/reasons.
 * Match its schema keyword walk; errors carry no downstream text (INV-6/8). */
function assertHeaderDeclarations(schema: unknown): void {
  const names = new Set<string>();
  const maps = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);
  const branches = [
    "items",
    "prefixItems",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    ...maps,
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
  ];
  const invalid = () => {
    throw new ConnectorCallError("connector_call_failed", "Downstream tool has an invalid x-mcp-header declaration.", {
      retryable: false,
    });
  };
  const visit = (node: unknown, reachable: boolean, property: boolean): void => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if ("x-mcp-header" in value) {
      const header = value["x-mcp-header"];
      if (
        !reachable ||
        !property ||
        typeof header !== "string" ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header) ||
        !["string", "integer", "boolean", "number"].includes(value.type as string) ||
        names.has(header.toLowerCase())
      )
        invalid();
      names.add((header as string).toLowerCase());
    }
    if (value.properties && typeof value.properties === "object") {
      for (const child of Object.values(value.properties)) visit(child, reachable, true);
    }
    for (const keyword of branches) {
      const sub = value[keyword];
      const children = Array.isArray(sub)
        ? sub
        : sub && typeof sub === "object" && maps.has(keyword)
          ? Object.values(sub)
          : [sub];
      for (const child of children) visit(child, false, false);
    }
  };
  visit(schema, true, false);
}

function catalogCeiling(): ConnectorCallError {
  return new ConnectorCallError("connector_call_failed", "Downstream catalog exceeds the complete-catalog ceiling.", {
    retryable: false,
  });
}

const GENERATION_TTL_SECONDS = (MAX_CACHE_TTL_MS * 2) / 1000;
export function invalidateCatalogCache(storage: KVStorage, connectorId: string): Promise<void> {
  return runEdge(authProgram<void>(invalidateCatalogCacheNative, [storage, connectorId]));
}
const invalidateCatalogCacheNative = /* @__PURE__ */ registerAuth(
  invalidateCatalogCache,
  (storage: KVStorage, connectorId: string) =>
    authFlow<void>(function* () {
      (yield authStorage(storage, "set", [
        responseCacheKeys.generation(connectorId),
        crypto.randomUUID(),
        {
          ttlSeconds: GENERATION_TTL_SECONDS,
        },
      ])) as void;
    }),
);
interface Manifest {
  stamp: number;
  expiresAt: number;
  fetchedAt: number;
  scope: "public" | "private";
  revision: string;
  chunkCount: number;
  fingerprint: string;
}

interface Listing {
  ctx: ConnectorContext;
  generation: { value?: string };
  ended: boolean;
  credentialIdentity?: string | undefined;
}
interface CacheOperation {
  ctx: ConnectorContext;
  generation: Listing["generation"];
  credentialIdentity?: string | undefined;
  listing?: Listing | undefined;
  stopped: () => boolean;
  io: <T>(read: () => Promise<T>) => Promise<T>;
}

/** Keys ignore self-reported serverInfo and bind the configured connector instead. */
export function catalogClientOptions(
  ctx: ConnectorContext,
  connectorId: string,
  config: string,
  authPartition: string,
  connectionSignal?: AbortSignal,
  owner?: object,
  sharing: "private" | "shared" = "private",
  resolveCredentialIdentity?: () => Promise<string>,
): Promise<
  Pick<ClientOptions, "responseCacheStore" | "cachePartition" | "defaultCacheTtlMs"> & {
    intake: (
      ctx: ConnectorContext,
      method: CatalogMethod,
      result: CatalogResult,
    ) => CatalogResult & {
      ttlMs: number;
      cacheScope: "public" | "private";
    };
    completeCatalogRefresh: (result: ListToolsResult) => Promise<CompletedCatalogRefresh | undefined>;
    withListing: <T>(ctx: ConnectorContext, read: () => Promise<T>) => Promise<T>;
    currentContext: () => ConnectorContext;
    fallbackTools: () => Promise<ListToolsResult | undefined>;
  }
> {
  return runEdge(
    authProgram<Awaited<ReturnType<typeof catalogClientOptions>>>(catalogClientOptionsNative, [
      ctx,
      connectorId,
      config,
      authPartition,
      connectionSignal,
      owner,
      sharing,
      resolveCredentialIdentity,
    ]),
  );
}
const catalogClientOptionsNative = /* @__PURE__ */ registerAuth(
  catalogClientOptions,
  (
    ctx: ConnectorContext,
    connectorId: string,
    config: string,
    authPartition: string,
    connectionSignal?: AbortSignal,
    owner?: object,
    sharing: "private" | "shared" = "private",
    resolveCredentialIdentity?: () => Promise<string>,
  ) =>
    authFlow<Awaited<ReturnType<typeof catalogClientOptions>>>(function* () {
      const request = Context.get(viewServices(ctx), RequestScope);
      // SDK callbacks start at their own Promise edge. Reprovide only their
      // canonical request owner, never the initiating call's live services.
      const cacheMethod = <Args extends unknown[], A>(program: (...args: Args) => Effect.Effect<A, unknown>) =>
        authMethod((...args: Args) => program(...args).pipe(Effect.provideService(RequestScope, request)));
      const policy = serviceFor(ctx, CatalogPolicy);
      const partition = JSON.stringify([
        policy?.partition ?? JSON.stringify(callerOf(ctx) ?? null),
        ctx.baseUrl,
        ctx.publicUrl,
        authPartition,
      ]);
      const sharedPartition = JSON.stringify([
        "host-shared",
        policy?.sharedPartition ?? JSON.stringify([ctx.baseUrl, ctx.publicUrl, callerOf(ctx)?.pool]),
        authPartition,
      ]);
      const storage = policy?.storage ?? ctx.storage;
      const configHash = (
        (yield authCall(fingerprintSerializedCatalog, [
          JSON.stringify([
            config,
            policy?.defaultTtlMs ?? 300000,
            policy?.minTtlMs ?? 0,
            policy?.maxTtlMs ?? MAX_CACHE_TTL_MS,
          ]),
        ])) as {
          fingerprint: string;
          byteLength: number;
        }
      ).fingerprint;
      const scope = cacheScope(ctx, connectorId, owner);
      let unavailable = false;
      const connectionGeneration: Listing["generation"] = {};
      let active: Listing | undefined;
      const capture = (listing: Listing | undefined = active): CacheOperation => {
        const signals = [scope.abort.signal, connectionSignal, listing?.ctx.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        );
        const ended = () => scope.closed || listing?.ended === true || signals.some((signal) => signal.aborted);
        const reason = () =>
          signals.find((signal) => signal.aborted)?.reason ??
          new ConnectorCallError("connector_call_failed", "Catalog cache operation ended.");
        return {
          ctx: listing?.ctx ?? ctx,
          generation: listing?.generation ?? { ...connectionGeneration },
          credentialIdentity: listing?.credentialIdentity,
          listing,
          stopped: () => unavailable || ended(),
          io: cacheMethod(<T>(read: () => Promise<T>) =>
            authFlow<T>(function* () {
              if (ended()) throw reason();
              return yield authAwait(authCall<T>(read, []), AbortSignal.any(signals));
            }),
          ),
        };
      };
      let lastStamp = 0;
      let staleTools:
        | {
            result: ListToolsResult;
            manifest: Manifest;
          }
        | undefined;
      const currentGeneration = cacheMethod(({ stopped, io, generation }: CacheOperation) =>
        authFlow<string | undefined>(function* () {
          const key = responseCacheKeys.generation(connectorId);
          for (let attempt = 0; attempt < 16; attempt++) {
            if (stopped()) return undefined;
            const current = (yield authCall(io, [
              cacheMethod(() => authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>),
            ])) as string | null;
            if (stopped()) return undefined;
            if (current) return current;
            const next = generation.value ?? crypto.randomUUID();
            const claimed = (yield authCall(io, [
              cacheMethod(
                () =>
                  authStorage(storage, "compareAndSet", [
                    key,
                    null,
                    next,
                    { ttlSeconds: GENERATION_TTL_SECONDS },
                  ]) as Effect.Effect<boolean, unknown>,
              ),
            ])) as boolean;
            if (stopped()) return undefined;
            if (claimed) return next;
          }
          throw new Error("Catalog cache generation is busy.");
        }),
      );
      const namespace = cacheMethod((operation: CacheOperation) =>
        authFlow<string | undefined>(function* () {
          const { stopped, generation, io } = operation;
          if (
            resolveCredentialIdentity &&
            ((yield authCall(io, [resolveCredentialIdentity])) as string) !== operation.credentialIdentity
          )
            return undefined;
          const current = (yield authCall(currentGeneration, [operation])) as string | undefined;
          if (!current || stopped()) return undefined;
          generation.value ??= current;
          return generation.value === current
            ? responseCacheKeys.namespace(connectorId, configHash, generation.value)
            : undefined;
        }),
      );
      const address = cacheMethod((key: CacheKey, operation: CacheOperation) =>
        authFlow<string | undefined>(function* () {
          const { stopped } = operation;
          if (stopped() || !isCatalogMethod(key.method) || key.params) return undefined;
          let pair: unknown;
          try {
            pair = JSON.parse(key.partition ?? "");
          } catch {
            return undefined;
          }
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            (pair[1] !== partition && (pair[1] !== "" || sharing !== "shared"))
          )
            return undefined;
          const prefix = (yield authCall(namespace, [operation])) as string | undefined;
          if (!prefix || stopped()) return undefined;
          const digest = (
            (yield authCall(fingerprintSerializedCatalog, [
              JSON.stringify([
                key.method,
                pair[1] === "" ? sharedPartition : partition,
                operation.credentialIdentity ?? null,
              ]),
            ])) as {
              fingerprint: string;
              byteLength: number;
            }
          ).fingerprint;
          return stopped() ? undefined : responseCacheKeys.entry(prefix, digest);
        }),
      );
      const manifest = (raw: string | null): Manifest | undefined => {
        if (!raw) return undefined;
        try {
          const m = JSON.parse(raw) as Manifest;
          return Number.isSafeInteger(m.stamp) &&
            m.stamp > 0 &&
            Number.isFinite(m.expiresAt) &&
            Number.isFinite(m.fetchedAt) &&
            m.fetchedAt >= 0 &&
            m.fetchedAt <= m.expiresAt &&
            (m.scope === "public" || m.scope === "private") &&
            typeof m.revision === "string" &&
            /^[0-9a-f-]{36}$/.test(m.revision) &&
            Number.isInteger(m.chunkCount) &&
            m.chunkCount > 0 &&
            m.chunkCount <= Math.ceil(MAX_SERIALIZED_CATALOG_BYTES / MAX_CATALOG_CHUNK_BYTES) + 1 &&
            /^sha256:[0-9]+:[0-9a-f]{64}$/.test(m.fingerprint)
            ? m
            : undefined;
        } catch {
          return undefined;
        }
      };
      const intake = (ctx: ConnectorContext, method: CatalogMethod, result: CatalogResult) => {
        const body = sharing === "private" ? { ...result, cacheScope: "private" as const } : result;
        if (method === "tools/list") return catalogIntake(ctx, body as ListToolsResult);
        const field = method === "resources/list" ? "resources" : "resourceTemplates";
        const items = catalogItems(method, body).map(({ _meta: _ignored, ...item }) => item);
        if (items.length > MAX_CATALOG_TOOLS) throw catalogCeiling();
        const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redactCredentials({ ...body, [field]: items });
        if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > MAX_SERIALIZED_CATALOG_BYTES)
          throw catalogCeiling();
        return {
          ...clean,
          ttlMs: catalogTtlMs(ctx, body.ttlMs),
          cacheScope: body.cacheScope === "public" ? ("public" as const) : ("private" as const),
        };
      };
      const completeCatalogRefresh = cacheMethod((result: ListToolsResult) =>
        authFlow<CompletedCatalogRefresh | undefined>(function* () {
          const listing = active;
          const operation = capture();
          const { stopped, io } = operation;
          if (!listing || stopped()) return;
          const clean = intake(listing.ctx, "tools/list", result);
          const digest = (
            (yield authCall(fingerprintSerializedCatalog, [JSON.stringify(clean)])) as {
              fingerprint: string;
              byteLength: number;
            }
          ).fingerprint;
          const partitionDigest = (
            (yield authCall(fingerprintSerializedCatalog, [
              JSON.stringify([
                clean.cacheScope === "public" ? sharedPartition : partition,
                operation.credentialIdentity ?? null,
              ]),
            ])) as {
              fingerprint: string;
              byteLength: number;
            }
          ).fingerprint;
          try {
            return (yield authCall(acceptCatalogRefresh, [
              storage,
              responseCacheKeys.refreshDigest(connectorId, configHash, partitionDigest),
              connectorId,
              digest,
              (clean as ListToolsResult).tools,
              clean.cacheScope !== "public",
              cacheMethod(() =>
                authFlow<boolean>(function* () {
                  return !stopped() && !!((yield authCall(namespace, [operation])) as string | undefined) && !stopped();
                }),
              ),
              io,
            ])) as CompletedCatalogRefresh | undefined;
          } catch (error) {
            if (!stopped())
              logFailure(
                listing.ctx.logger,
                "catalog refresh observation failed",
                failureRecord({ connector: connectorId }, error),
              );
          }
        }),
      );
      const store: ResponseCacheStore = {
        get: cacheMethod((key: CacheKey) =>
          authFlow<
            | {
                value: string;
                stamp: number;
                expiresAt: number;
                scope: "private" | "public";
              }
            | undefined
          >(function* () {
            const operation = capture();
            const { ctx, stopped, io } = operation;
            const root = (yield authCall(address, [key, operation])) as string | undefined;
            if (!root || stopped()) return undefined;
            const m = manifest(
              (yield authCall(io, [
                cacheMethod(() => authStorage(storage, "get", [root]) as Effect.Effect<string | null, unknown>),
              ])) as string | null,
            );
            if (
              stopped() ||
              !m ||
              (m.expiresAt <= Date.now() &&
                (key.method !== "tools/list" || m.expiresAt + STALE_FALLBACK_MS <= Date.now()))
            )
              return undefined;
            const chunks: string[] = [];
            for (let i = 0; i < m.chunkCount; i++) {
              if (stopped()) return undefined;
              const chunk = (yield authCall(io, [
                cacheMethod(
                  () =>
                    authStorage(storage, "get", [responseCacheKeys.chunk(root, m.revision, i)]) as Effect.Effect<
                      string | null,
                      unknown
                    >,
                ),
              ])) as string | null;
              if (stopped() || chunk === null || new TextEncoder().encode(chunk).byteLength > MAX_CATALOG_CHUNK_BYTES)
                return undefined;
              chunks.push(chunk);
            }
            const value = chunks.join("");
            const fingerprint = (yield authCall(fingerprintSerializedCatalog, [value])) as {
              fingerprint: string;
              byteLength: number;
            };
            if (
              stopped() ||
              fingerprint.byteLength > MAX_SERIALIZED_CATALOG_BYTES ||
              fingerprint.fingerprint !== m.fingerprint ||
              !((yield authCall(namespace, [operation])) as string | undefined) ||
              stopped()
            )
              return undefined;
            const result = JSON.parse(value) as CatalogResult;
            const method = key.method as CatalogMethod;
            const items = catalogItems(method, result);
            if (
              !Array.isArray(items) ||
              items.length > MAX_CATALOG_TOOLS ||
              "nextCursor" in result ||
              (result.resultType !== undefined && result.resultType !== "complete")
            )
              return undefined;
            const validated = (yield authInvoke(catalogSchema(method)["~standard"], "validate", [result])) as
              | StandardSchemaV1.FailureResult
              | StandardSchemaV1.SuccessResult<ListToolsResult>
              | StandardSchemaV1.SuccessResult<ListResourceTemplatesResult>
              | StandardSchemaV1.SuccessResult<ListResourcesResult>;
            if (stopped() || validated.issues) return undefined;
            const clean = intake(ctx, method, validated.value);
            if (m.expiresAt <= Date.now()) {
              if (method === "tools/list" && (!staleTools || staleTools.manifest.fetchedAt < m.fetchedAt))
                staleTools = { result: clean as ListToolsResult, manifest: m };
              return undefined;
            }
            observeCatalogFetch(ctx, m.fetchedAt, method);
            observeCatalogExpiry(ctx, method, clean.ttlMs, m.expiresAt);
            return { value: JSON.stringify(clean), stamp: m.stamp, expiresAt: m.expiresAt, scope: m.scope };
          }),
        ),
        set: cacheMethod(
          (
            key: CacheKey,
            entry: {
              value: string;
              expiresAt?: number;
              scope?: "public" | "private";
            },
          ) =>
            authFlow<number>(function* () {
              const operation = capture();
              const { ctx, stopped, io } = operation;
              const root = (yield authCall(address, [key, operation])) as string | undefined;
              if (!root || stopped()) return 0;
              const result = JSON.parse(entry.value) as CatalogResult;
              const method = key.method as CatalogMethod;
              if (catalogTtlMs(ctx, result.ttlMs) === 0) {
                if (!stopped() && ((yield authCall(namespace, [operation])) as string | undefined) && !stopped())
                  (yield authCall(io, [
                    cacheMethod(() => authStorage(storage, "delete", [root]) as Effect.Effect<void, unknown>),
                  ])) as void;
                return 0;
              }
              if (
                !Array.isArray(catalogItems(method, result)) ||
                "nextCursor" in result ||
                (result.resultType !== undefined && result.resultType !== "complete")
              )
                return 0;
              const value = JSON.stringify(intake(ctx, method, result));
              const fingerprint = (yield authCall(fingerprintSerializedCatalog, [value])) as {
                fingerprint: string;
                byteLength: number;
              };
              const expiresAt = Math.min(
                entry.expiresAt ?? Date.now(),
                (catalogFetchedAt(ctx, method) ?? Date.now()) + catalogTtlMs(ctx, result.ttlMs),
              );
              if (
                stopped() ||
                expiresAt <= Date.now() ||
                !((yield authCall(namespace, [operation])) as string | undefined) ||
                stopped()
              )
                return 0;
              const revision = crypto.randomUUID();
              const bytes = new TextEncoder().encode(value);
              const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
              let offset = 0;
              let chunkCount = 0;
              const ttlSeconds = () =>
                Math.max(0.001, (expiresAt + (method === "tools/list" ? STALE_FALLBACK_MS : 0) - Date.now()) / 1000);
              while (offset < bytes.length) {
                if (stopped() || expiresAt <= Date.now()) return 0;
                let end = Math.min(offset + MAX_CATALOG_CHUNK_BYTES, bytes.length);
                while (end < bytes.length && (bytes[end]! & 192) === 128) end--;
                const chunk = responseCacheKeys.chunk(root, revision, chunkCount++);
                (yield authCall(io, [
                  cacheMethod(
                    () =>
                      authStorage(storage, "set", [
                        chunk,
                        decoder.decode(bytes.subarray(offset, end)),
                        { ttlSeconds: ttlSeconds() },
                      ]) as Effect.Effect<void, unknown>,
                  ),
                ])) as void;
                if (stopped()) return 0;
                offset = end;
              }
              for (let attempt = 0; attempt < 16; attempt++) {
                if (
                  stopped() ||
                  expiresAt <= Date.now() ||
                  !((yield authCall(namespace, [operation])) as string | undefined) ||
                  stopped()
                )
                  return 0;
                const previous = (yield authCall(io, [
                  cacheMethod(() => authStorage(storage, "get", [root]) as Effect.Effect<string | null, unknown>),
                ])) as string | null;
                if (stopped() || expiresAt <= Date.now()) return 0;
                const stamp = Math.max(Date.now(), (manifest(previous)?.stamp ?? 0) + 1, lastStamp + 1);
                const m: Manifest = {
                  stamp,
                  expiresAt,
                  fetchedAt: catalogFetchedAt(ctx, method) ?? Date.now(),
                  scope: sharing === "shared" && result.cacheScope === "public" ? "public" : "private",
                  revision,
                  chunkCount,
                  fingerprint: fingerprint.fingerprint,
                };
                const published = (yield authCall(io, [
                  cacheMethod(
                    () =>
                      authStorage(storage, "compareAndSet", [
                        root,
                        previous,
                        JSON.stringify(m),
                        { ttlSeconds: ttlSeconds() },
                      ]) as Effect.Effect<boolean, unknown>,
                  ),
                ])) as boolean;
                if (stopped()) return 0;
                if (published) {
                  lastStamp = stamp;
                  return stamp;
                }
              }
              throw new Error("Catalog cache publication is busy.");
            }),
        ),
        delete: cacheMethod((key: CacheKey) =>
          authFlow<void>(function* () {
            const operation = capture();
            const root = (yield authCall(address, [key, operation])) as string | undefined;
            if (root && !operation.stopped())
              (yield authInvoke(operation, "io", [
                cacheMethod(() => authStorage(storage, "delete", [root]) as Effect.Effect<void, unknown>),
              ])) as void;
          }),
        ),
        evict: cacheMethod((method: string) =>
          authFlow<void>(function* () {
            if (isCatalogMethod(method)) (yield authInvoke(store, "clear", [])) as void;
          }),
        ),
        clear: cacheMethod(() =>
          authFlow<void>(function* () {
            const operation = capture();
            if (!operation.stopped())
              (yield authInvoke(operation, "io", [
                cacheMethod(
                  () => authCall(invalidateCatalogCache, [storage, connectorId]) as Effect.Effect<void, unknown>,
                ),
              ])) as void;
          }),
        ),
      };
      try {
        const { stopped, io } = capture({ ctx, generation: connectionGeneration, ended: false });
        if (!stopped()) {
          const current = (yield authCall(io, [
            cacheMethod(
              () =>
                authStorage(storage, "get", [responseCacheKeys.generation(connectorId)]) as Effect.Effect<
                  string | null,
                  unknown
                >,
            ),
          ])) as string | null;
          if (!stopped()) connectionGeneration.value = current ?? crypto.randomUUID();
        }
      } catch (error) {
        unavailable = true;
        logFailure(ctx.logger, "catalog read failed", failureRecord({ connector: connectorId }, error));
      }
      // The queue retains only a Promise turn. Awaiting it in this caller's
      // request preserves workerd I/O ownership; the listing program stays native.
      let tail = Promise.resolve();
      const withListing = cacheMethod(<T>(listingCtx: ConnectorContext, read: () => Promise<T>) =>
        authFlow<T>(function* () {
          const previous = tail;
          let release!: () => void;
          tail = new Promise<void>((resolve) => {
            release = resolve;
          });
          let entered = false;
          try {
            yield authValue(() => previous);
            entered = true;
            if (scope.closed || connectionSignal?.aborted)
              throw new ConnectorCallError("connector_call_failed", "Catalog cache scope ended.");
            if (listingCtx.signal?.aborted) throw listingCtx.signal.reason;
            if (policy && serviceFor(listingCtx, CatalogPolicy) === undefined)
              setViewService(listingCtx, CatalogPolicy, policy);
            const listing: Listing = { ctx: listingCtx, generation: {}, ended: false };
            active = listing;
            staleTools = undefined;
            const operation = capture();
            try {
              if (resolveCredentialIdentity)
                listing.credentialIdentity = yield authInvoke<string>(operation, "io", [resolveCredentialIdentity]);
              if (!operation.stopped()) {
                try {
                  const generation: string =
                    (yield authInvoke<string | null>(operation, "io", [
                      cacheMethod(() =>
                        authStorage<string | null>(storage, "get", [responseCacheKeys.generation(connectorId)]),
                      ),
                    ])) ?? crypto.randomUUID();
                  listing.generation.value = generation;
                  connectionGeneration.value = generation;
                } catch (error) {
                  if (operation.stopped()) throw error;
                  unavailable = true;
                  logFailure(
                    listingCtx.logger,
                    "catalog read failed",
                    failureRecord({ connector: connectorId }, error),
                  );
                }
              }
              return yield authCall<T>(read, []);
            } finally {
              listing.ended = true;
              active = undefined;
            }
          } finally {
            // A cancelled queued waiter cannot unlock the listing ahead of it.
            if (entered) release();
            else void previous.then(release);
          }
        }),
      );
      const fallbackTools = cacheMethod(() =>
        authFlow<ListToolsResult | undefined>(function* () {
          const operation = capture();
          if (
            !staleTools ||
            operation.stopped() ||
            !((yield authCall(namespace, [operation])) as string | undefined) ||
            operation.stopped() ||
            staleTools.manifest.expiresAt + STALE_FALLBACK_MS <= Date.now()
          )
            return;
          const { result, manifest } = staleTools;
          observeCatalogFetch(operation.ctx, manifest.fetchedAt);
          observeCatalogExpiry(
            operation.ctx,
            "tools/list",
            typeof result.ttlMs === "number" ? result.ttlMs : 0,
            manifest.expiresAt,
            true,
          );
          return result;
        }),
      );
      return {
        intake,
        completeCatalogRefresh,
        fallbackTools,
        responseCacheStore: store,
        cachePartition: partition,
        defaultCacheTtlMs: policy?.defaultTtlMs ?? CONFIG_DEFAULTS.discovery.catalogTtlSeconds * 1000,
        withListing,
        currentContext: () => active?.ctx ?? ctx,
      };
    }),
);

function isCatalogMethod(method: string): method is CatalogMethod {
  return method === "tools/list" || method === "resources/list" || method === "resources/templates/list";
}

function customCatalogCache(ctx: ConnectorContext, connectorId: string) {
  return runEdge(
    authProgram<{ cache: Awaited<ReturnType<typeof catalogClientOptions>>; key: CacheKey }>(customCatalogCacheNative, [
      ctx,
      connectorId,
    ]),
  );
}
const customCatalogCacheNative = /* @__PURE__ */ registerAuth(
  customCatalogCache,
  (ctx: ConnectorContext, connectorId: string) =>
    authFlow<{ cache: Awaited<ReturnType<typeof catalogClientOptions>>; key: CacheKey }>(function* () {
      const credential = (yield authValue(() => ctx.credential?.getAll())) as
        | ConnectorCredentialValues
        | null
        | undefined;
      const auth = (
        (yield authCall(fingerprintSerializedCatalog, [JSON.stringify(credential ?? null)])) as {
          fingerprint: string;
          byteLength: number;
        }
      ).fingerprint;
      const cache = (yield authCall(catalogClientOptions, [ctx, connectorId, "custom-connector", auth])) as Awaited<
        ReturnType<typeof catalogClientOptions>
      >;
      const key: CacheKey = {
        method: "tools/list",
        partition: JSON.stringify(["custom-connector", cache.cachePartition]),
      };
      return { cache, key };
    }),
);
/** Custom listings always fetch. Only an authenticated owner may retain a
 * complete private fallback; unscoped/operator reads start no cache I/O. */
export function storeCustomCatalogFallback(
  ctx: ConnectorContext,
  connectorId: string,
  tools: readonly ToolDef[],
): Promise<void> {
  return runEdge(authProgram<void>(storeCustomCatalogFallbackNative, [ctx, connectorId, tools]));
}
const storeCustomCatalogFallbackNative = /* @__PURE__ */ registerAuth(
  storeCustomCatalogFallback,
  (ctx: ConnectorContext, connectorId: string, tools: readonly ToolDef[]) =>
    authFlow<void>(function* () {
      const ttlMs = catalogTtlMs(ctx, undefined);
      observeCatalogFetch(ctx, Date.now());
      observeCatalogExpiry(ctx, "tools/list", ttlMs);
      if (!ttlMs || !callerOf(ctx)?.authenticated) return;
      const { cache, key } = (yield authCall(customCatalogCache, [ctx, connectorId])) as {
        cache: Awaited<ReturnType<typeof catalogClientOptions>>;
        key: CacheKey;
      };
      (yield authInvoke(cache, "withListing", [
        ctx,
        authMethod(() =>
          authFlow<void>(function* () {
            const result = catalogIntake(ctx, {
              tools: tools.map((tool: ToolDef) => ({
                ...tool,
                inputSchema: tool.inputSchema ?? { type: "object" },
              })) as ListToolsResult["tools"],
              ttlMs,
              cacheScope: "private",
            });
            (yield authInvoke(cache.responseCacheStore!, "set", [
              key,
              {
                value: JSON.stringify(result),
                expiresAt: catalogExpiry(ctx)!.expiresAt,
                scope: "private",
              },
            ])) as number;
          }),
        ),
      ])) as void;
    }),
);
export function customCatalogFallback(ctx: ConnectorContext, connectorId: string): Promise<ToolDef[] | undefined> {
  return runEdge(authProgram<ToolDef[] | undefined>(customCatalogFallbackNative, [ctx, connectorId]));
}
const customCatalogFallbackNative = /* @__PURE__ */ registerAuth(
  customCatalogFallback,
  (ctx: ConnectorContext, connectorId: string) =>
    authFlow<ToolDef[] | undefined>(function* () {
      if (!callerOf(ctx)?.authenticated) return;
      const { cache, key } = (yield authCall(customCatalogCache, [ctx, connectorId])) as {
        cache: Awaited<ReturnType<typeof catalogClientOptions>>;
        key: CacheKey;
      };
      return (yield authInvoke(cache, "withListing", [
        ctx,
        authMethod(() =>
          authFlow<ToolDef[] | undefined>(function* () {
            (yield authInvoke(cache.responseCacheStore!, "get", [key])) as CacheEntry | undefined;
            return ((yield authInvoke(cache, "fallbackTools", [])) as ListToolsResult | undefined)?.tools as
              | ToolDef[]
              | undefined;
          }),
        ),
      ])) as ToolDef[] | undefined;
    }),
);
