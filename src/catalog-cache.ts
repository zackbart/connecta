import { traceFor } from "./timing-trace.js";
import { markCatalogGeneration } from "./catalog-freshness.js";
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
  authStorageMany,
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
import { advanceCatalogRevision, catalogRevision } from "./catalog-revision.js";
import { callerOf } from "./connector-caller.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { Context } from "effect";
import { ownerReads, RequestScope } from "./runtime/request-scope.js";
import { serviceFor, setViewService, viewServices } from "./runtime/call.js";
import { ConnectorCallError } from "./errors.js";
import { fingerprintSerializedCatalog } from "./catalog-fingerprint.js";
import {
  CATALOG_CHUNKS_PER_READ as CHUNKS_PER_READ,
  MAX_CATALOG_CHUNK_BYTES,
  MAX_CATALOG_TOOLS,
  MAX_SERIALIZED_CATALOG_BYTES,
} from "./catalog-limits.js";
import { redactCatalog, sentSecretsForRequest } from "./sent-secrets.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { secretDigest } from "./storage-digest.js";
import { responseCacheKeys } from "./storage/keys.js";
import { CatalogPolicy, type CatalogCacheSettings } from "./catalog-policy.js";
import type { ConnectorCatalogPeek, ConnectorContext, ConnectorCredentialValues, KVStorage, ToolDef } from "./types.js";

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
  /** When this baseline was written; absent on baselines written before it was recorded. */
  writtenAt?: number;
}
/**
 * An unchanged refresh leaves a baseline younger than this in place instead of
 * rewriting it, so a baseline outlives every refresh by at least the baseline
 * TTL minus this interval.
 */
const BASELINE_REWRITE_AGE_MS = 60 * 60 * 1000;
const refreshHash = (v: unknown) => typeof v === "string" && /^sha256:[0-9]+:[0-9a-f]{64}$/.test(v);
function refreshManifest(raw: string | null): RefreshManifest | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as RefreshManifest;
    if (
      refreshHash(value.digest) &&
      refreshHash(value.fingerprint) &&
      /^[0-9a-f-]{36}$/.test(value.revision) &&
      Number.isInteger(value.chunkCount) &&
      value.chunkCount >= 1 &&
      value.chunkCount <= Math.ceil(MAX_SERIALIZED_CATALOG_BYTES / MAX_CATALOG_CHUNK_BYTES)
    )
      return value;
  } catch {}
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
      const value = refreshManifest(raw);
      if (!value) return;
      try {
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
          tools.every((tool: CatalogToolFingerprint) => tool && refreshHash(tool.name) && refreshHash(tool.fact))
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
      // An identical catalog cannot drift, and its baseline, written within
      // the last hour, needs no rewrite: such a refresh writes nothing. The
      // stored chunks always outlive their manifest, since a manifest is only
      // ever written with fresh chunks.
      const stored = (yield authCall(io, [
        authMethod(() => authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>),
      ])) as string | null;
      const baseline = refreshManifest(stored);
      if (
        baseline?.digest === digest &&
        baseline.writtenAt !== undefined &&
        Date.now() - baseline.writtenAt < BASELINE_REWRITE_AGE_MS
      )
        return;
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
      const manifest: RefreshManifest = { digest, revision, chunkCount, fingerprint, writtenAt: Date.now() };
      for (let attempt = 0; attempt < 16; attempt++) {
        if (!((yield authCall(current, [])) as boolean)) return;
        // The first attempt publishes against the manifest read above; a lost
        // compare-and-set reads it again.
        const raw =
          attempt === 0
            ? stored
            : ((yield authCall(io, [
                authMethod(() => authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>),
              ])) as string | null);
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
/** One complete cached tools/list entry and the times its manifest recorded. */
export interface CatalogPeekEntry {
  result: ListToolsResult;
  fetchedAt: number;
  expiresAt: number;
}
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
/**
 * How long past its expiry a complete tool catalog stays listable when its
 * connector does not answer discovery in time. The listing only: a call always
 * resolves through STALE_FALLBACK_MS at most. One day matches the longest TTL a
 * deployment can configure, so this retains nothing it could not already hold.
 * A refusal retires it sooner, for that credential: see `fenceTools`.
 */
const STALE_DISCOVERY_MS = 86_400_000;
/** A fence outlives every entry it could be keeping from reuse. */
const CATALOG_FENCE_TTL_SECONDS = (MAX_CACHE_TTL_MS + STALE_DISCOVERY_MS) / 1000;
/** What a refusal's fence is keyed by, beside the catalog: one credential's slot within one generation. */
const catalogFenceFingerprint = (
  sharing: "private" | "shared",
  partition: string,
  authPartition: string,
  credentialIdentity: string | undefined,
) =>
  authCall<{ fingerprint: string }>(fingerprintSerializedCatalog, [
    // A shared credential gets one answer whoever asks, so one fence covers all its callers.
    JSON.stringify(["fence", sharing === "shared" ? authPartition : partition, credentialIdentity ?? null]),
  ]);
export function attachCatalogCache(ctx: ConnectorContext, value: CatalogCacheSettings): void {
  setViewService(ctx, CatalogPolicy, value);
}

/** Revalidate retained reads without storage I/O or credential material. */
export function retainedCatalogIdentity(ctx: ConnectorContext): string {
  const policy = serviceFor(ctx, CatalogPolicy);
  return JSON.stringify([
    policy?.partition ?? JSON.stringify(callerOf(ctx) ?? null),
    ctx.baseUrl,
    ctx.publicUrl,
    catalogRevision(policy?.storage ?? ctx.storage),
    policy?.credentialRevision?.() ?? 0,
  ]);
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
      advanceCatalogRevision(storage);
      try {
        (yield authStorage(storage, "set", [
          responseCacheKeys.generation(connectorId),
          crypto.randomUUID(),
          {
            ttlSeconds: GENERATION_TTL_SECONDS,
          },
        ])) as void;
      } finally {
        // A read started while the durable fence was pending must also expire.
        advanceCatalogRevision(storage);
      }
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

// Only detached JSON facts cross requests: no context, storage, promises or
// callbacks. FIFO bounds retained partitions, JSON/key text (UTF-16 worst
// case) and structural slots. No WeakRef or timers required.
const catalogStores = new WeakMap<KVStorage, string>();
const validatedCatalogs = new Map<string, { value: CatalogResult; bytes: number }>();
let validatedBytes = 0;
const VALIDATED_BYTES = 8 * 1024 * 1024;
function rememberValidated(key: string, value: CatalogResult, bytes: number): void {
  bytes = bytes * 2 + key.length * 2;
  if (bytes > VALIDATED_BYTES || validatedCatalogs.has(key)) return;
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const child of Object.values(item)) {
      // Charge structural overhead too: tiny JSON objects/arrays can occupy
      // much more heap than their serialized bytes alone suggest.
      bytes += 64;
      if (bytes > VALIDATED_BYTES) return;
      pending.push(child);
    }
  }
  while (validatedCatalogs.size >= 4 || validatedBytes + bytes > VALIDATED_BYTES) {
    const oldest = validatedCatalogs.keys().next().value!;
    validatedBytes -= validatedCatalogs.get(oldest)!.bytes;
    validatedCatalogs.delete(oldest);
  }
  validatedCatalogs.set(key, { value, bytes });
  validatedBytes += bytes;
}

const storeIdentityOf = (storage: KVStorage): string => {
  let identity = catalogStores.get(storage);
  if (!identity) catalogStores.set(storage, (identity = crypto.randomUUID()));
  return identity;
};

// The last verified revision of each catalog slot this isolate read or
// published, so a later request's locating read can also select that
// revision's chunks. A hint holds no catalog data and authorizes nothing:
// chunks are used only when the manifest read with them names the same
// revision, every one is present and their joined fingerprint matches, and
// the fresh post-chunk fence still decides. Chunk keys carry the revision, so
// another isolate's republication is read as a different revision and its
// chunks are read as before. The key binds the store, connector, configuration
// and the slot's partition digest (owner partition and credential identity),
// so one principal's hint never addresses another's entry. FIFO-bounded.
interface ChunkHint {
  revision: string;
  chunkCount: number;
}
const chunkHints = new Map<string, ChunkHint>();
const CHUNK_HINTS = 256;
const chunkHintKey = (storage: KVStorage, connectorId: string, configHash: string, digest: string) =>
  JSON.stringify([storeIdentityOf(storage), connectorId, configHash, digest]);
function rememberChunkHint(key: string, hint: ChunkHint | undefined): void {
  chunkHints.delete(key);
  if (!hint) return;
  if (chunkHints.size >= CHUNK_HINTS) chunkHints.delete(chunkHints.keys().next().value!);
  chunkHints.set(key, hint);
}
/** Locator suffixes of hinted chunks for slots in probe order, at most one read's worth. */
function hintedChunkSuffixes(
  storage: KVStorage,
  connectorId: string,
  configHash: string,
  digests: readonly string[],
): string[] {
  const suffixes: string[] = [];
  for (const digest of digests) {
    const hint = chunkHints.get(chunkHintKey(storage, connectorId, configHash, digest));
    for (let index = 0; hint && index < hint.chunkCount && suffixes.length < CHUNKS_PER_READ; index++)
      suffixes.push(responseCacheKeys.chunkSuffix(digest, hint.revision, index));
  }
  return suffixes;
}

interface Listing {
  ctx: ConnectorContext;
  generation: { value?: string | undefined };
  ended: boolean;
  credentialIdentity?: string | undefined;
  /** Whether the generation was read from storage rather than newly drawn. */
  generationStored?: boolean | undefined;
  manifests?: Map<string, string | null>;
  /** The fence read before this listing dispatched, and so the only one its success can lift. */
  fence?: string | null | undefined;
}
/**
 * What a downstream attempt was dispatched under, captured before it leaves.
 * Its outcome is about this credential and generation, whatever they are by the
 * time it answers, so nothing is resolved again to record that outcome.
 */
export type ListingBinding = Pick<Listing, "credentialIdentity" | "generationStored" | "fence"> & {
  generation?: string | undefined;
};
interface CacheOperation {
  ctx: ConnectorContext;
  generation: Listing["generation"];
  credentialIdentity?: string | undefined;
  listing?: Listing | undefined;
  stopped: () => boolean;
  io: <T>(read: () => Promise<T>) => Promise<T>;
}

const catalogLocation = authMethod((ctx: ConnectorContext, config: string, authPartition: string) =>
  authFlow<{ partition: string; sharedPartition: string; configHash: string }>(function* () {
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
    return { partition, sharedPartition, configHash };
  }),
);

/** Prefetch candidates only; authority, identity and acceptance stay fresh. */
export const prefetchCatalog = authMethod(
  (
    ctx: ConnectorContext,
    connectorId: string,
    config: string,
    authPartition: string,
    sharing: "private" | "shared",
    credentialIdentity: string | undefined,
    negotiationKey: string,
  ) =>
    authFlow<void>(function* () {
      const { partition, sharedPartition, configHash } = yield authCall<{
        partition: string;
        sharedPartition: string;
        configHash: string;
      }>(catalogLocation, [ctx, config, authPartition]);
      const slots = sharing === "shared" ? [partition, sharedPartition] : [partition];
      const digests: string[] = [];
      for (const slot of slots)
        digests.push(
          (yield authCall<{ fingerprint: string }>(fingerprintSerializedCatalog, [
            JSON.stringify(["tools/list", slot, credentialIdentity ?? null]),
          ])).fingerprint,
        );
      const storage = serviceFor(ctx, CatalogPolicy)?.storage ?? ctx.storage;
      // Hinted chunks join the manifests they belong to in the same snapshot.
      const suffixes: string[] = [
        (yield catalogFenceFingerprint(sharing, partition, authPartition, credentialIdentity)).fingerprint,
        ...digests,
        ...hintedChunkSuffixes(storage, connectorId, configHash, digests),
      ];
      yield ownerReads(Context.get(viewServices(ctx), RequestScope)).prefetch(
        [
          { storage: ctx.storage, key: negotiationKey },
          { storage, key: responseCacheKeys.generation(connectorId) },
        ],
        (storage, keys) => authStorageMany(storage, keys),
        {
          storage,
          generationKey: responseCacheKeys.generation(connectorId),
          prefix: responseCacheKeys.locatorPrefix(connectorId, configHash),
          suffixes,
        },
      );
    }),
);

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
  connectionless = false,
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
    withListing: <T>(ctx: ConnectorContext, read: () => Promise<T>, bound?: Partial<ListingBinding>) => Promise<T>;
    currentContext: () => ConnectorContext;
    fallbackTools: () => Promise<ListToolsResult | undefined>;
    cachedTools: (ctx: ConnectorContext) => Promise<ListToolsResult | undefined>;
    peekTools: (ctx: ConnectorContext, serverIdentity?: string) => Promise<CatalogPeekEntry | undefined>;
    bindListing: (
      ctx: ConnectorContext,
      pinned?: Pick<ListingBinding, "credentialIdentity">,
      readFence?: boolean,
    ) => Promise<ListingBinding>;
    captureFence: () => Promise<void>;
    fenceListing: () => Promise<void>;
    fenceTools: (ctx: ConnectorContext, bound: ListingBinding) => Promise<void>;
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
      connectionless,
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
    connectionless = false,
  ) =>
    authFlow<Awaited<ReturnType<typeof catalogClientOptions>>>(function* () {
      const request = Context.get(viewServices(ctx), RequestScope);
      // Generation reads that only locate an entry are memoized for this
      // request; every acceptance or publication check reads it fresh. A
      // generation is never reused once replaced, so a stale one only
      // addresses an entry that the fresh check then refuses.
      const reads = ownerReads(request);
      const generationRead = (memoized: boolean) => {
        const key = responseCacheKeys.generation(connectorId);
        return reads.read(
          storage,
          key,
          authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>,
          !memoized,
        );
      };
      // SDK callbacks start at their own Promise edge. Reprovide only their
      // canonical request owner, never the initiating call's live services.
      const cacheMethod = <Args extends unknown[], A>(program: (...args: Args) => Effect.Effect<A, unknown>) =>
        authMethod((...args: Args) => program(...args).pipe(Effect.provideService(RequestScope, request)));
      const policy = serviceFor(ctx, CatalogPolicy);
      const { partition, sharedPartition, configHash } = yield authCall<{
        partition: string;
        sharedPartition: string;
        configHash: string;
      }>(catalogLocation, [ctx, config, authPartition]);
      const storage = policy?.storage ?? ctx.storage;
      const storeIdentity = storeIdentityOf(storage);
      /** The hint slot of an entry this connection addressed under `generation`. */
      const hintKey = (root: string, generation: string) => {
        const namespace = responseCacheKeys.namespace(connectorId, configHash, generation);
        return root.startsWith(namespace)
          ? chunkHintKey(storage, connectorId, configHash, root.slice(namespace.length))
          : undefined;
      };
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
      const currentGeneration = cacheMethod(({ stopped, io, generation }: CacheOperation, memoized: boolean = false) =>
        authFlow<string | undefined>(function* () {
          const key = responseCacheKeys.generation(connectorId);
          for (let attempt = 0; attempt < 16; attempt++) {
            if (stopped()) return undefined;
            // A retry after a lost claim always reads fresh.
            const current = (yield authCall(io, [cacheMethod(() => generationRead(memoized && attempt === 0))])) as
              | string
              | null;
            if (stopped()) return undefined;
            if (current) return current;
            // A connectionless reader never claims or recreates a generation: a
            // missing one is a miss at every check, never a reused namespace.
            if (connectionless) return undefined;
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
      const namespace = cacheMethod((operation: CacheOperation, memoized: boolean = false) =>
        authFlow<string | undefined>(function* () {
          const { stopped, generation, io } = operation;
          if (
            !memoized &&
            resolveCredentialIdentity &&
            ((yield authCall(io, [resolveCredentialIdentity])) as string) !== operation.credentialIdentity
          )
            return undefined;
          const current = (yield authCall(currentGeneration, [operation, memoized])) as string | undefined;
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
          // Locate with the listing's pinned identity and generation. Neither
          // authorizes acceptance: get's post-chunk fence and set's publication
          // re-read both, so rotation or disconnect during I/O refuses the entry.
          const prefix = (yield authCall(namespace, [operation, true])) as string | undefined;
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
      const fenceKey = cacheMethod((operation: CacheOperation, generation: string) =>
        authFlow<string>(function* () {
          const { fingerprint } = (yield catalogFenceFingerprint(
            sharing,
            partition,
            authPartition,
            operation.credentialIdentity,
          )) as { fingerprint: string };
          return responseCacheKeys.entry(responseCacheKeys.namespace(connectorId, configHash, generation), fingerprint);
        }),
      );
      // Whether an expired catalog may stand in now. Read past this request's
      // memo: a refusal or invalidation in another isolate retires it at once.
      const staleAllowed = cacheMethod((operation: CacheOperation) =>
        authFlow<boolean>(function* () {
          if (operation.stopped() || !((yield authCall(namespace, [operation])) as string | undefined)) return false;
          const key = (yield authCall(fenceKey, [operation, operation.generation.value!])) as string;
          const fence = (yield authCall(operation.io, [
            cacheMethod(() =>
              reads.read(
                storage,
                key,
                authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>,
                true,
              ),
            ),
          ])) as string | null;
          return fence === null && !operation.stopped();
        }),
      );
      // Read before the listing dispatches: a refusal after this point writes a
      // value this listing never saw. An older memoized read only lifts less.
      const readListingFence = cacheMethod((operation: CacheOperation) =>
        authFlow<void>(function* () {
          const { listing, stopped, io } = operation;
          if (!listing || listing.fence !== undefined || stopped()) return;
          // A generation claimed later holds no fence this listing could know of.
          if (!listing.generationStored) {
            listing.fence = null;
            return;
          }
          const key = (yield authCall(fenceKey, [operation, listing.generation.value!])) as string;
          listing.fence = (yield authCall(io, [
            cacheMethod(() =>
              reads.read(storage, key, authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>),
            ),
          ])) as string | null;
        }),
      );
      // A complete listing's answer lifts the fence captured before it was
      // asked, and only that one: a refusal that landed while it ran wrote
      // another, which stays. With nothing captured it lifts nothing, so the
      // next listing that reads the fence first does it instead.
      const liftFence = cacheMethod((operation: CacheOperation) =>
        authFlow<void>(function* () {
          const { listing, stopped, io } = operation;
          if (!listing?.fence || stopped()) return;
          try {
            const key = (yield authCall(fenceKey, [operation, operation.generation.value!])) as string;
            const lifted = (yield authCall(io, [
              cacheMethod(
                () =>
                  authStorage(storage, "compareAndSet", [key, listing.fence, null]) as Effect.Effect<boolean, unknown>,
              ),
            ])) as boolean;
            if (lifted) listing.fence = null;
          } catch (error) {
            if (!stopped())
              logFailure(ctx.logger, "catalog fence failed", failureRecord({ connector: connectorId }, error));
          }
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
            const trace = traceFor(ctx.requestScope);
            trace?.record("catalog.cache.lookup");
            const root = (yield authCall(address, [key, operation])) as string | undefined;
            if (!root || stopped()) return undefined;
            // The SDK probes private, then public. Derive both addresses from
            // the already-bound locating generation and identity, and fetch
            // them in one statement. The post-chunk namespace check stays fresh.
            const listing = operation.listing;
            if (listing && !listing.manifests?.has(root)) {
              const slots = sharing === "shared" ? [partition, sharedPartition] : [partition];
              const namespace = responseCacheKeys.namespace(connectorId, configHash, operation.generation.value!);
              const digests: string[] = [];
              for (const slot of slots)
                digests.push(
                  (
                    (yield authCall(fingerprintSerializedCatalog, [
                      JSON.stringify([key.method, slot, operation.credentialIdentity ?? null]),
                    ])) as { fingerprint: string }
                  ).fingerprint,
                );
              const roots = digests.map((digest) => responseCacheKeys.entry(namespace, digest));
              const fence = (yield authCall(fenceKey, [operation, operation.generation.value!])) as string;
              const chunks = hintedChunkSuffixes(storage, connectorId, configHash, digests).map((suffix) =>
                responseCacheKeys.entry(namespace, suffix),
              );
              yield reads.prefetch(
                [...roots, fence, ...chunks].map((key) => ({ storage, key })),
                (storage, keys) => authStorageMany(storage, keys),
              );
              (yield authCall(readListingFence, [operation])) as void;
              const values: (string | null)[] = [];
              for (const root of roots)
                values.push(
                  yield reads.read(
                    storage,
                    root,
                    authStorage(storage, "get", [root]) as Effect.Effect<string | null, unknown>,
                  ),
                );
              listing.manifests ??= new Map();
              roots.forEach((root, i) => listing.manifests!.set(root, values[i] ?? null));
            }
            // A refused credential is listed anew, whatever its catalog's age.
            if (listing?.fence && key.method === "tools/list") return undefined;
            const m = manifest(
              listing?.manifests?.has(root)
                ? listing.manifests.get(root)!
                : ((yield authCall(io, [
                    cacheMethod(() => authStorage(storage, "get", [root]) as Effect.Effect<string | null, unknown>),
                  ])) as string | null),
            );
            if (!m) {
              const hint = hintKey(root, operation.generation.value!);
              if (hint) rememberChunkHint(hint, undefined);
            }
            if (
              stopped() ||
              !m ||
              (m.expiresAt <= Date.now() &&
                (key.method !== "tools/list" || m.expiresAt + STALE_DISCOVERY_MS <= Date.now()))
            )
              return undefined;
            // Up to CHUNKS_PER_READ chunks per round trip, so one answer stays a
            // few megabytes; the generation fence below still decides whether
            // what was read may be served.
            const chunks: string[] = [];
            for (let first = 0; first < m.chunkCount; first += CHUNKS_PER_READ) {
              if (stopped()) return undefined;
              const keys = Array.from({ length: Math.min(CHUNKS_PER_READ, m.chunkCount - first) }, (_, i) =>
                responseCacheKeys.chunk(root, m.revision, first + i),
              );
              // Chunks the locating read selected by this isolate's hint. Their
              // keys carry the revision this manifest names, so they are its
              // chunks; anything absent is read again rather than trusted.
              const located = keys.map((key) => reads.take(storage, key));
              const read = located.every((chunk) => typeof chunk === "string")
                ? located
                : ((yield authCall(io, [cacheMethod(() => authStorageMany(storage, keys))])) as (string | null)[]);
              for (const chunk of read) {
                if (stopped() || chunk === null || new TextEncoder().encode(chunk).byteLength > MAX_CATALOG_CHUNK_BYTES)
                  return undefined;
                chunks.push(chunk);
              }
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
            const hint = hintKey(root, operation.generation.value!);
            if (hint) rememberChunkHint(hint, { revision: m.revision, chunkCount: m.chunkCount });
            const method = key.method as CatalogMethod;
            // root binds connector/config/generation/scope/credential; partition
            // also binds the current owner/deployment even for public entries.
            // Hash the chunks again above, never trust the manifest alone.
            const reuseKey = JSON.stringify([storeIdentity, root, partition, m.fingerprint]);
            let accepted = validatedCatalogs.get(reuseKey)?.value;
            trace?.record(accepted ? "catalog.validated.hit" : "catalog.validated.miss");
            if (!accepted) {
              const result = JSON.parse(value) as CatalogResult;
              trace?.record("catalog.decode", 0, fingerprint.byteLength);
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
                | StandardSchemaV1.SuccessResult<CatalogResult>;
              trace?.record("catalog.validate");
              if (stopped() || validated.issues) return undefined;
              accepted = validated.value;
            }
            // Redaction depends on this request's sent credentials. It must
            // still run, and returns detached objects from the frozen facts.
            const clean = intake(ctx, method, accepted);
            trace?.record("catalog.intake");
            trace?.record("catalog.chunks", 0, fingerprint.byteLength, 0, 0, m.chunkCount);
            rememberValidated(reuseKey, accepted, fingerprint.byteLength);
            if (m.expiresAt <= Date.now()) {
              trace?.record("catalog.cache.expired");
              if (method === "tools/list" && (!staleTools || staleTools.manifest.fetchedAt < m.fetchedAt))
                staleTools = { result: clean as ListToolsResult, manifest: m };
              return undefined;
            }
            trace?.record("catalog.cache.hit");
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
              operation.listing?.manifests?.delete(root);
              const result = JSON.parse(entry.value) as CatalogResult;
              const method = key.method as CatalogMethod;
              if (catalogTtlMs(ctx, result.ttlMs) === 0) {
                if (!stopped() && ((yield authCall(namespace, [operation])) as string | undefined) && !stopped())
                  (yield authCall(io, [
                    cacheMethod(() => authStorage(storage, "delete", [root]) as Effect.Effect<void, unknown>),
                  ])) as void;
                if (method === "tools/list") (yield authCall(liftFence, [operation])) as void;
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
                Math.max(0.001, (expiresAt + (method === "tools/list" ? STALE_DISCOVERY_MS : 0) - Date.now()) / 1000);
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
                  const hint = hintKey(root, operation.generation.value!);
                  if (hint) rememberChunkHint(hint, { revision, chunkCount });
                  // Tool chunks outlive their manifest by the stale limit, so a
                  // superseded revision is removed now rather than retained for
                  // a day. A reader holding it misses and lists again; a failed
                  // removal leaves the chunks to their TTL.
                  const superseded = manifest(previous);
                  if (superseded && superseded.revision !== revision) {
                    try {
                      for (let index = 0; index < superseded.chunkCount && !stopped(); index++)
                        (yield authCall(io, [
                          cacheMethod(
                            () =>
                              authStorage(storage, "delete", [
                                responseCacheKeys.chunk(root, superseded.revision, index),
                              ]) as Effect.Effect<void, unknown>,
                          ),
                        ])) as void;
                    } catch (error) {
                      if (!stopped())
                        logFailure(
                          ctx.logger,
                          "catalog chunk cleanup failed",
                          failureRecord({ connector: connectorId }, error),
                        );
                    }
                  }
                  if (method === "tools/list") (yield authCall(liftFence, [operation])) as void;
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
            if (root && !operation.stopped()) {
              operation.listing?.manifests?.delete(root);
              (yield authInvoke(operation, "io", [
                cacheMethod(() => authStorage(storage, "delete", [root]) as Effect.Effect<void, unknown>),
              ])) as void;
            }
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
        // A connectionless reader only lists, and each listing reads its own
        // generation; there are no connection-owned writes to fence.
        if (!connectionless && !stopped()) {
          // Memoized: a connection's writes publish only after a fresh check.
          const current = (yield authCall(io, [cacheMethod(() => generationRead(true))])) as string | null;
          if (!stopped()) connectionGeneration.value = current ?? crypto.randomUUID();
        }
      } catch (error) {
        unavailable = true;
        logFailure(ctx.logger, "catalog read failed", failureRecord({ connector: connectorId }, error));
      }
      // The queue retains only a Promise turn. Awaiting it in this caller's
      // request preserves workerd I/O ownership; the listing program stays native.
      let tail = Promise.resolve();
      const withListing = cacheMethod(
        <T>(listingCtx: ConnectorContext, read: () => Promise<T>, bound?: Partial<ListingBinding>) =>
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
                if (bound && "credentialIdentity" in bound) listing.credentialIdentity = bound.credentialIdentity;
                else if (resolveCredentialIdentity)
                  listing.credentialIdentity = yield authInvoke<string>(operation, "io", [resolveCredentialIdentity]);
                if (bound?.fence !== undefined) listing.fence = bound.fence;
                if (bound?.generationStored !== undefined) {
                  listing.generationStored = bound.generationStored;
                  listing.generation.value = bound.generation;
                } else if (!operation.stopped()) {
                  try {
                    // Memoized: it locates the listing's entries, which the
                    // fresh fence in get accepts or refuses.
                    const stored = (yield authInvoke<string | null>(operation, "io", [
                      cacheMethod(() => generationRead(true)),
                    ])) as string | null;
                    const generation = stored ?? crypto.randomUUID();
                    listing.generationStored = stored !== null;
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
                const result = yield authCall<T>(read, []);
                markCatalogGeneration(listingCtx.requestScope, connectorId, listing.generation.value);
                return result;
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
      // Capture what an attempt is about to run under. `pinned` names a
      // credential the caller has already read for it.
      const bindListing = cacheMethod(
        (listingCtx: ConnectorContext, pinned?: Pick<ListingBinding, "credentialIdentity">, readFence = false) =>
          authCall<ListingBinding>(withListing, [
            listingCtx,
            cacheMethod(() =>
              authFlow<ListingBinding>(function* () {
                const operation = capture();
                if (readFence) (yield authCall(readListingFence, [operation])) as void;
                const listing = operation.listing!;
                return {
                  credentialIdentity: listing.credentialIdentity,
                  generation: listing.generation.value,
                  generationStored: listing.generationStored ?? false,
                  fence: listing.fence,
                };
              }),
            ),
            pinned,
          ]),
      );
      // A complete, unexpired tools/list entry, read before any connection
      // exists. This is the SDK's own two-probe read: the private slot
      // `[serverIdentity, cachePartition]`, then a shared connector's public
      // slot `[serverIdentity, ""]`, served only when written as public.
      // `address` binds the configured connector rather than the self-reported
      // identity, so the pre-connect `""` identity selects the same entries.
      // Expired, partial, refused (`ttlMs: 0`) and invalidated entries miss,
      // and the read writes nothing.
      const cachedTools = cacheMethod((listingCtx: ConnectorContext) =>
        authCall<ListToolsResult | undefined>(withListing, [
          listingCtx,
          cacheMethod(() =>
            authFlow<ListToolsResult | undefined>(function* () {
              // No stored generation means no entry, and claiming one is a write.
              if (!active?.generationStored) return undefined;
              const read = (slot: string) =>
                authInvoke<CacheEntry | undefined>(store, "get", [
                  { method: "tools/list", params: "", partition: JSON.stringify(["", slot]) },
                ]);
              let entry = (yield read(partition)) as CacheEntry | undefined;
              if (entry === undefined && sharing === "shared") {
                const shared = (yield read("")) as CacheEntry | undefined;
                entry = shared?.scope === "public" ? shared : undefined;
              }
              if (entry?.expiresAt === undefined || !(entry.expiresAt > Date.now())) return undefined;
              const result = JSON.parse(entry.value) as ListToolsResult;
              return Array.isArray(result.tools) ? result : undefined;
            }),
          ),
        ]),
      );
      // The newest complete tools/list entry this caller could be served, fresh
      // or within STALE_DISCOVERY_MS of expiry, with its original times. Reads
      // only, through the same address, fingerprint, generation and credential
      // fences as a listing, so another owner's entry, an invalidated generation
      // or a rotated credential is a miss. Never a source for call resolution.
      const peekTools = cacheMethod((listingCtx: ConnectorContext, serverIdentity = "") =>
        authCall<CatalogPeekEntry | undefined>(withListing, [
          listingCtx,
          cacheMethod(() =>
            authFlow<CatalogPeekEntry | undefined>(function* () {
              if (!active?.generationStored) return undefined;
              const read = (slot: string) =>
                authInvoke<CacheEntry | undefined>(store, "get", [
                  { method: "tools/list", params: "", partition: JSON.stringify([serverIdentity, slot]) },
                ]);
              let entry = (yield read(partition)) as CacheEntry | undefined;
              let stale = staleTools;
              if (entry === undefined && sharing === "shared") {
                staleTools = undefined;
                const shared = (yield read("")) as CacheEntry | undefined;
                entry = shared?.scope === "public" ? shared : undefined;
                // Set by the read above, which control flow analysis cannot see.
                const sharedStale = staleTools as { result: ListToolsResult; manifest: Manifest } | undefined;
                if (
                  sharedStale?.manifest.scope === "public" &&
                  (!stale || stale.manifest.fetchedAt < sharedStale.manifest.fetchedAt)
                )
                  stale = sharedStale;
              }
              if (entry?.expiresAt !== undefined && entry.expiresAt > Date.now()) {
                const result = JSON.parse(entry.value) as ListToolsResult;
                if (!Array.isArray(result.tools)) return undefined;
                return {
                  result,
                  fetchedAt: catalogFetchedAt(listingCtx) ?? Date.now(),
                  expiresAt: entry.expiresAt,
                };
              }
              const operation = capture();
              if (
                !stale ||
                !((yield authCall(staleAllowed, [operation])) as boolean) ||
                stale.manifest.expiresAt + STALE_DISCOVERY_MS <= Date.now()
              )
                return undefined;
              return { result: stale.result, fetchedAt: stale.manifest.fetchedAt, expiresAt: stale.manifest.expiresAt };
            }),
          ),
        ]),
      );
      // The downstream refused this credential, which says more than a TTL can:
      // nothing cached for it may stand in again until a listing succeeds. One
      // key beside the catalog, durable across requests and isolates, in the
      // namespace of the generation the refused attempt ran under, so a change
      // of credential or a disconnect discards it with the entries it guards. An
      // attempt that found no generation fences the one claimed since, if any:
      // that is where a listing beside it published. Nothing is stored while no
      // generation is, since then nothing is cached to retire. A failed write is
      // logged and never masks the refusal.
      const writeFence = cacheMethod((operation: CacheOperation) =>
        authFlow<void>(function* () {
          const { listing, stopped, io } = operation;
          if (!listing || stopped()) return;
          try {
            const generation = listing.generationStored
              ? listing.generation.value
              : ((yield authCall(io, [cacheMethod(() => generationRead(false))])) as string | null);
            if (!generation || stopped()) return;
            const key = (yield authCall(fenceKey, [operation, generation])) as string;
            (yield authCall(io, [
              cacheMethod(
                () =>
                  authStorage(storage, "set", [
                    key,
                    crypto.randomUUID(),
                    { ttlSeconds: CATALOG_FENCE_TTL_SECONDS },
                  ]) as Effect.Effect<void, unknown>,
              ),
            ])) as void;
          } catch (error) {
            if (!stopped())
              logFailure(ctx.logger, "catalog fence failed", failureRecord({ connector: connectorId }, error));
          }
        }),
      );
      // The refusal of the listing now running, as that listing was bound.
      const fenceListing = cacheMethod(() => authCall<void>(writeFence, [capture()]));
      // The refusal of an attempt bound earlier, outside any listing.
      const fenceTools = cacheMethod((listingCtx: ConnectorContext, bound: ListingBinding) =>
        authCall<void>(withListing, [listingCtx, cacheMethod(() => authCall<void>(writeFence, [capture()])), bound]),
      );
      // For a listing that never reads the cache before it dispatches.
      const captureFence = cacheMethod(() =>
        authFlow<void>(function* () {
          const operation = capture();
          try {
            (yield authCall(readListingFence, [operation])) as void;
          } catch (error) {
            if (!operation.stopped())
              logFailure(ctx.logger, "catalog fence failed", failureRecord({ connector: connectorId }, error));
          }
        }),
      );
      const fallbackTools = cacheMethod(() =>
        authFlow<ListToolsResult | undefined>(function* () {
          const operation = capture();
          if (
            !staleTools ||
            !((yield authCall(staleAllowed, [operation])) as boolean) ||
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
        cachedTools,
        peekTools,
        bindListing,
        captureFence,
        fenceListing,
        fenceTools,
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

interface CustomCatalogCache {
  cache: Awaited<ReturnType<typeof catalogClientOptions>>;
  key: CacheKey;
  auth: string;
}
/** A custom listing's ticket: the slot and fence it was dispatched under. */
export interface CustomCatalogListing extends CustomCatalogCache {
  bound: ListingBinding;
}
function customCatalogCache(ctx: ConnectorContext, connectorId: string) {
  return runEdge(authProgram<CustomCatalogCache>(customCatalogCacheNative, [ctx, connectorId]));
}
const customCatalogAuth = authMethod((ctx: ConnectorContext) =>
  authFlow<string>(function* () {
    const credential = (yield authValue(() => ctx.credential?.getAll())) as
      | ConnectorCredentialValues
      | null
      | undefined;
    // Credential values enter the stored partition only through a keyed digest.
    return credential == null
      ? (
          (yield authCall(fingerprintSerializedCatalog, ["null"])) as {
            fingerprint: string;
            byteLength: number;
          }
        ).fingerprint
      : ((yield authCall(secretDigest, [ctx, JSON.stringify(credential)])) as string);
  }),
);
const customCatalogCacheNative = /* @__PURE__ */ registerAuth(
  customCatalogCache,
  (ctx: ConnectorContext, connectorId: string) =>
    authFlow<CustomCatalogCache>(function* () {
      const auth = (yield authCall(customCatalogAuth, [ctx])) as string;
      const cache = (yield authCall(catalogClientOptions, [ctx, connectorId, "custom-connector", auth])) as Awaited<
        ReturnType<typeof catalogClientOptions>
      >;
      const key: CacheKey = {
        method: "tools/list",
        partition: JSON.stringify(["custom-connector", cache.cachePartition]),
      };
      return { cache, key, auth };
    }),
);
/**
 * Before a custom listing dispatches: only an authenticated owner may retain a
 * complete private fallback, and unscoped/operator reads start no cache I/O.
 * Its answer is recorded against this ticket, never a later read of the store.
 */
export function bindCustomCatalogListing(
  ctx: ConnectorContext,
  connectorId: string,
): Promise<CustomCatalogListing | undefined> {
  return runEdge(authProgram<CustomCatalogListing | undefined>(bindCustomCatalogListingNative, [ctx, connectorId]));
}
const bindCustomCatalogListingNative = /* @__PURE__ */ registerAuth(
  bindCustomCatalogListing,
  (ctx: ConnectorContext, connectorId: string) =>
    authFlow<CustomCatalogListing | undefined>(function* () {
      if (!catalogTtlMs(ctx, undefined) || !callerOf(ctx)?.authenticated) return;
      const custom = (yield authCall(customCatalogCache, [ctx, connectorId])) as CustomCatalogCache;
      const bound = (yield authInvoke(custom.cache, "bindListing", [ctx, undefined, true])) as ListingBinding;
      return { ...custom, bound };
    }),
);
/** Custom listings always fetch; the ticket says whether and where one is retained. */
export function storeCustomCatalogFallback(
  ctx: ConnectorContext,
  tools: readonly ToolDef[],
  listing: CustomCatalogListing | undefined,
): Promise<void> {
  return runEdge(authProgram<void>(storeCustomCatalogFallbackNative, [ctx, tools, listing]));
}
const storeCustomCatalogFallbackNative = /* @__PURE__ */ registerAuth(
  storeCustomCatalogFallback,
  (ctx: ConnectorContext, tools: readonly ToolDef[], listing: CustomCatalogListing | undefined) =>
    authFlow<void>(function* () {
      const ttlMs = catalogTtlMs(ctx, undefined);
      observeCatalogFetch(ctx, Date.now());
      observeCatalogExpiry(ctx, "tools/list", ttlMs);
      if (!ttlMs || !listing) return;
      // The connector read its own credential, so a change while it ran leaves
      // this answer belonging to neither: it is retained for neither.
      if (((yield authCall(customCatalogAuth, [ctx])) as string) !== listing.auth) return;
      const { cache, key, bound } = listing;
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
        bound,
      ])) as void;
    }),
);
/** A custom connector's retained catalog, for discovery only. Same owner rule as its fallback. */
export function customCatalogPeek(
  ctx: ConnectorContext,
  connectorId: string,
): Promise<ConnectorCatalogPeek | undefined> {
  return runEdge(authProgram<ConnectorCatalogPeek | undefined>(customCatalogPeekNative, [ctx, connectorId]));
}
const customCatalogPeekNative = /* @__PURE__ */ registerAuth(
  customCatalogPeek,
  (ctx: ConnectorContext, connectorId: string) =>
    authFlow<ConnectorCatalogPeek | undefined>(function* () {
      if (!callerOf(ctx)?.authenticated) return;
      const { cache } = (yield authCall(customCatalogCache, [ctx, connectorId])) as CustomCatalogCache;
      const entry = (yield authInvoke(cache, "peekTools", [ctx, "custom-connector"])) as CatalogPeekEntry | undefined;
      return entry
        ? { tools: entry.result.tools as ToolDef[], fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt }
        : undefined;
    }),
);
/**
 * A custom connector's refusal. It reads its own credential, by any route, so
 * only one unchanged since the ticket identifies what was refused: that
 * catalog stands in for nothing until a listing succeeds. A change, or a failed
 * read, leaves it unknown, so every catalog retained for this connector goes.
 */
export function fenceCustomCatalog(
  ctx: ConnectorContext,
  connectorId: string,
  listing: CustomCatalogListing,
): Promise<void> {
  return runEdge(authProgram<void>(fenceCustomCatalogNative, [ctx, connectorId, listing]));
}
const fenceCustomCatalogNative = /* @__PURE__ */ registerAuth(
  fenceCustomCatalog,
  (ctx: ConnectorContext, connectorId: string, listing: CustomCatalogListing) =>
    authFlow<void>(function* () {
      const current = (yield (authCall(customCatalogAuth, [ctx]) as Effect.Effect<string, unknown>).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )) as string | undefined;
      if (current === listing.auth) (yield authInvoke(listing.cache, "fenceTools", [ctx, listing.bound])) as void;
      else
        (yield authCall(invalidateCatalogCache, [
          serviceFor(ctx, CatalogPolicy)?.storage ?? ctx.storage,
          connectorId,
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
      const { cache, key } = (yield authCall(customCatalogCache, [ctx, connectorId])) as CustomCatalogCache;
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
