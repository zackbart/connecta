// The SDK owns aggregation and freshness. This adapter stores only complete,
// intake-redacted catalog successes in the deployment's SQL-backed KV.
import type { CacheKey, ClientOptions, ListToolsResult, ListResourcesResult, ListResourceTemplatesResult, ResponseCacheStore } from "@modelcontextprotocol/client";
import { MAX_CACHE_TTL_MS, specTypeSchemas } from "@modelcontextprotocol/client";
import { callerOf } from "./connector-caller.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { ConnectorCallError } from "./errors.js";
import { fingerprintSerializedCatalog } from "./catalog-fingerprint.js";
import { MAX_CATALOG_CHUNK_BYTES, MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "./catalog-limits.js";
import { redactCatalog, sentSecretsForRequest } from "./sent-secrets.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { responseCacheKeys } from "./storage/keys.js";
import type { ConnectorContext, KVStorage, ToolDef } from "./types.js";

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
export interface CatalogToolFingerprint { name: string; fact: string }
interface RefreshBaseline { digest: string; tools: CatalogToolFingerprint[] }
interface RefreshManifest { digest: string; revision: string; chunkCount: number; fingerprint: string }
/** Publish one accepted catalog refresh, with its partitioned drift baseline. */
export async function observeCompletedCatalogRefresh(ctx: ConnectorContext, refresh: CompletedCatalogRefresh): Promise<void> {
  await settings.get(ctx)?.onCompletedCatalogRefresh?.(refresh, ctx);
}
/** Hash-only facts preserve change counts without storing tool names or schemas. */
async function catalogFingerprints(tools: readonly { name: string }[]): Promise<CatalogToolFingerprint[]> {
  const facts: CatalogToolFingerprint[] = [];
  for (let offset = 0; offset < tools.length; offset += 128) {
    facts.push(...await Promise.all(tools.slice(offset, offset + 128).map(async tool => ({
      name: (await fingerprintSerializedCatalog(tool.name)).fingerprint,
      fact: (await fingerprintSerializedCatalog(JSON.stringify(tool))).fingerprint,
    }))));
  }
  return facts;
}
async function refreshBaseline(storage: KVStorage, key: string, raw: string | null, io: CacheOperation["io"]): Promise<RefreshBaseline | undefined> {
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as RefreshManifest;
    const hash = (v: unknown) => typeof v === "string" && /^sha256:[0-9]+:[0-9a-f]{64}$/.test(v);
    if (!hash(value.digest) || !hash(value.fingerprint) || !/^[0-9a-f-]{36}$/.test(value.revision) ||
      !Number.isInteger(value.chunkCount) || value.chunkCount < 1 || value.chunkCount > Math.ceil(MAX_SERIALIZED_CATALOG_BYTES / MAX_CATALOG_CHUNK_BYTES)) return;
    const chunks: string[] = [];
    for (let index = 0; index < value.chunkCount; index++) {
      const chunk = await io(() => storage.get(responseCacheKeys.chunk(key, value.revision, index)));
      if (chunk === null || new TextEncoder().encode(chunk).byteLength > MAX_CATALOG_CHUNK_BYTES) return;
      chunks.push(chunk);
    }
    const serialized = chunks.join("");
    if ((await fingerprintSerializedCatalog(serialized)).fingerprint !== value.fingerprint) return;
    const tools = JSON.parse(serialized) as CatalogToolFingerprint[];
    if (Array.isArray(tools) && tools.length <= MAX_CATALOG_TOOLS && tools.every(tool => tool && hash(tool.name) && hash(tool.fact))) return { digest: value.digest, tools };
  } catch { /* Retired or torn baselines establish a new count baseline. */ }
}
async function acceptCatalogRefresh(
  storage: KVStorage, key: string, connectorId: string, digest: string, tools: readonly { name: string }[],
  privateCatalog: boolean, current: () => Promise<boolean>, io: CacheOperation["io"],
): Promise<CompletedCatalogRefresh | undefined> {
  const next = await catalogFingerprints(tools);
  const serialized = JSON.stringify(next);
  const revision = crypto.randomUUID();
  const fingerprint = (await fingerprintSerializedCatalog(serialized)).fingerprint;
  // Fingerprints are ASCII. Chunk them under the same platform value ceiling
  // as catalogs, then publish their manifest in one compare-and-set.
  const chunkCount = Math.ceil(serialized.length / MAX_CATALOG_CHUNK_BYTES);
  for (let index = 0; index < chunkCount; index++) {
    if (!await current()) return;
    const chunk = serialized.slice(index * MAX_CATALOG_CHUNK_BYTES, (index + 1) * MAX_CATALOG_CHUNK_BYTES);
    await io(() => storage.set(responseCacheKeys.chunk(key, revision, index), chunk, { ttlSeconds: GENERATION_TTL_SECONDS + 300 }));
  }
  const manifest: RefreshManifest = { digest, revision, chunkCount, fingerprint };
  for (let attempt = 0; attempt < 16; attempt++) {
    if (!await current()) return;
    const raw = await io(() => storage.get(key));
    const previous = await refreshBaseline(storage, key, raw, io);
    if (!await current()) return;
    const published = await io(() => storage.compareAndSet(key, raw, JSON.stringify(manifest), { ttlSeconds: GENERATION_TTL_SECONDS }));
    if (!await current()) return;
    if (published) return { connectorId, digest, next, private: privateCatalog,
      ...(previous ? { previousDigest: previous.digest, previous: previous.tools } : {}) };
  }
  throw new Error("Catalog refresh baseline is busy.");
}
/** Custom dynamic connectors have no SDK cache; publish their complete intake here. */
export async function observeUncachedCatalogRefresh(ctx: ConnectorContext, connectorId: string, tools: readonly { name: string }[]): Promise<void> {
  const policy = settings.get(ctx);
  if (!policy?.onCompletedCatalogRefresh) return;
  const config = (await fingerprintSerializedCatalog("custom-connector")).fingerprint;
  const partition = (await fingerprintSerializedCatalog(JSON.stringify([policy.partition, ctx.baseUrl, ctx.publicUrl]))).fingerprint;
  const digest = (await fingerprintSerializedCatalog(JSON.stringify(tools))).fingerprint;
  const refresh = await acceptCatalogRefresh(policy.storage, responseCacheKeys.refreshDigest(connectorId, config, partition),
    connectorId, digest, tools, true, async () => !ctx.signal?.aborted, read => read());
  if (refresh) await observeCompletedCatalogRefresh(ctx, refresh);
}
export type CatalogMethod = "tools/list" | "resources/list" | "resources/templates/list";
export type CatalogResult = ListToolsResult | ListResourcesResult | ListResourceTemplatesResult;
export function catalogItems(method: CatalogMethod, result: CatalogResult) {
  if (method === "tools/list") return (result as ListToolsResult).tools;
  if (method === "resources/list") return (result as ListResourcesResult).resources;
  return (result as ListResourceTemplatesResult).resourceTemplates;
}
function catalogSchema(method: CatalogMethod) {
  return method === "tools/list" ? specTypeSchemas.ListToolsResult : method === "resources/list" ? specTypeSchemas.ListResourcesResult : specTypeSchemas.ListResourceTemplatesResult;
}

export interface CatalogExpiry {
  fetchedAt: number;
  ttlMs: number;
  expiresAt: number;
  staleFallback: boolean;
}
const expiry = new WeakMap<ConnectorContext, Map<CatalogMethod, CatalogExpiry>>();
const fetches = new WeakMap<ConnectorContext, Map<CatalogMethod, number>>();
export function observeCatalogFetch(ctx: ConnectorContext, at: number, method: CatalogMethod = "tools/list"): void {
  const methods = fetches.get(ctx) ?? new Map();
  methods.set(method, at); fetches.set(ctx, methods);
}
export function catalogFetchedAt(ctx: ConnectorContext, method: CatalogMethod = "tools/list"): number | undefined { return fetches.get(ctx)?.get(method); }
export function catalogExpiry(ctx: ConnectorContext, method: CatalogMethod = "tools/list"): CatalogExpiry | undefined { return expiry.get(ctx)?.get(method); }
export function observeCatalogExpiry(ctx: ConnectorContext, method: CatalogMethod, ttlMs: number, expiresAt?: number, staleFallback = false): void {
  const fetchedAt = catalogFetchedAt(ctx, method) ?? Date.now();
  const methods = expiry.get(ctx) ?? new Map();
  methods.set(method, { fetchedAt, ttlMs, expiresAt: Math.min(expiresAt ?? Infinity, fetchedAt + ttlMs), staleFallback });
  expiry.set(ctx, methods);
}
// Tool facts remain available for ordinary calls after a transient listing
// failure for five minutes. Resources never use stale inventories. A fallback
// carries its original expired deadline and cannot authorize auth recovery.
const STALE_FALLBACK_MS = 300_000;
const settings = new WeakMap<ConnectorContext, CatalogCacheSettings>();
export function attachCatalogCache(ctx: ConnectorContext, value: CatalogCacheSettings): void { settings.set(ctx, value); }
interface CacheScope { closed: boolean; abort: AbortController; invalidating?: Promise<void> }
const defaultOwner = {};
const scopes = new WeakMap<object, Map<string, WeakMap<object, CacheScope>>>();
function cacheScope(ctx: ConnectorContext, connectorId: string, owner = defaultOwner): CacheScope {
  const key = ctx.requestScope ?? ctx;
  let connectors = scopes.get(key);
  if (!connectors) { connectors = new Map(); scopes.set(key, connectors); }
  let owners = connectors.get(connectorId);
  if (!owners) { owners = new WeakMap(); connectors.set(connectorId, owners); }
  let scope = owners.get(owner);
  if (!scope) { scope = { closed: false, abort: new AbortController() }; owners.set(owner, scope); }
  return scope;
}
/** Start the fence before SDK eviction; teardown joins already-started I/O. */
export function observeCatalogChange(ctx: ConnectorContext, connectorId: string, connectionSignal?: AbortSignal, owner?: object): void {
  const scope = cacheScope(ctx, connectorId, owner);
  if (scope.closed || connectionSignal?.aborted) return;
  const writing = invalidateCatalogCache(settings.get(ctx)?.storage ?? ctx.storage, connectorId).catch(error => {
    logFailure(ctx.logger, "catalog invalidation failed", failureRecord({ connector: connectorId }, error));
  });
  scope.invalidating = scope.invalidating ? Promise.all([scope.invalidating, writing]).then(() => {}) : writing;
}
export function closeCatalogCacheScope(ctx: ConnectorContext, connectorId: string, owner?: object): Promise<void> | undefined {
  const scope = cacheScope(ctx, connectorId, owner);
  scope.closed = true;
  scope.abort.abort();
  return scope.invalidating;
}

/** Zero is an explicit refusal to reuse. Positive hints use the configured bounds. */
function catalogTtlMs(ctx: ConnectorContext, hint: unknown): number {
  const policy = settings.get(ctx);
  const ttl = hint === undefined ? Math.floor(policy?.defaultTtlMs ?? CONFIG_DEFAULTS.discovery.catalogTtlSeconds * 1000) : hint;
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) return 0;
  return Math.floor(Math.min(Math.max(ttl, policy?.minTtlMs ?? 0), policy?.maxTtlMs ?? MAX_CACHE_TTL_MS, MAX_CACHE_TTL_MS));
}

/** Sanitize before SDK automatic writes and before its derived tool index. */
export function catalogIntake(ctx: ConnectorContext, result: ListToolsResult): ListToolsResult & { ttlMs: number; cacheScope: "public" | "private" } {
  const tools = redactCatalog(ctx, result.tools).map(({ _meta: _ignored, icons, ...tool }) => ({
    ...tool, ...(icons ? { icons: icons.filter(icon => !/^data:/i.test(icon.src)) } : {}),
  }));
  if (tools.length > MAX_CATALOG_TOOLS) throw catalogCeiling();
  const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redact({ ...result, tools });
  if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > MAX_SERIALIZED_CATALOG_BYTES) throw catalogCeiling();
  for (const tool of clean.tools) assertHeaderDeclarations(tool.inputSchema);
  return { ...clean, ttlMs: catalogTtlMs(ctx, result.ttlMs), cacheScope: result.cacheScope === "public" ? "public" : "private" };
}
/** Refuse before SDK 2.3.1's header exclusion path logs downstream names/reasons.
 * Match its schema keyword walk; errors carry no downstream text (INV-6/8). */
function assertHeaderDeclarations(schema: unknown): void {
  const names = new Set<string>();
  const maps = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);
  const branches = ["items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties",
    "unevaluatedItems", "propertyNames", ...maps, "oneOf", "anyOf", "allOf", "not", "if", "then", "else"];
  const invalid = () => { throw new ConnectorCallError("connector_call_failed", "Downstream tool has an invalid x-mcp-header declaration.", { retryable: false }); };
  const visit = (node: unknown, reachable: boolean, property: boolean): void => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if ("x-mcp-header" in value) {
      const header = value["x-mcp-header"];
      if (!reachable || !property || typeof header !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header) ||
        !["string", "integer", "boolean", "number"].includes(value.type as string) || names.has(header.toLowerCase())) invalid();
      names.add((header as string).toLowerCase());
    }
    if (value.properties && typeof value.properties === "object") {
      for (const child of Object.values(value.properties)) visit(child, reachable, true);
    }
    for (const keyword of branches) {
      const sub = value[keyword];
      const children = Array.isArray(sub) ? sub : sub && typeof sub === "object" && maps.has(keyword) ? Object.values(sub) : [sub];
      for (const child of children) visit(child, false, false);
    }
  };
  visit(schema, true, false);
}

function catalogCeiling(): ConnectorCallError {
  return new ConnectorCallError("connector_call_failed", "Downstream catalog exceeds the complete-catalog ceiling.", { retryable: false });
}

const GENERATION_TTL_SECONDS = MAX_CACHE_TTL_MS * 2 / 1000;
export async function invalidateCatalogCache(storage: KVStorage, connectorId: string): Promise<void> {
  await storage.set(responseCacheKeys.generation(connectorId), crypto.randomUUID(), { ttlSeconds: GENERATION_TTL_SECONDS });
}
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
export async function catalogClientOptions(
  ctx: ConnectorContext,
  connectorId: string,
  config: string,
  authPartition: string,
  connectionSignal?: AbortSignal,
  owner?: object,
  sharing: "private" | "shared" = "private",
  resolveCredentialIdentity?: () => Promise<string>,
): Promise<Pick<ClientOptions, "responseCacheStore" | "cachePartition" | "defaultCacheTtlMs"> & {
  intake: (ctx: ConnectorContext, method: CatalogMethod, result: CatalogResult) => CatalogResult & { ttlMs: number; cacheScope: "public" | "private" };
  completeCatalogRefresh: (result: ListToolsResult) => Promise<CompletedCatalogRefresh | undefined>;
  withListing: <T>(ctx: ConnectorContext, read: () => Promise<T>) => Promise<T>;
  currentContext: () => ConnectorContext;
  fallbackTools: () => Promise<ListToolsResult | undefined>;
}> {
  const policy = settings.get(ctx);
  const partition = JSON.stringify([policy?.partition ?? JSON.stringify(callerOf(ctx) ?? null), ctx.baseUrl, ctx.publicUrl, authPartition]);
  const sharedPartition = JSON.stringify(["host-shared", policy?.sharedPartition ?? JSON.stringify([ctx.baseUrl, ctx.publicUrl, callerOf(ctx)?.pool]), authPartition]);
  const storage = policy?.storage ?? ctx.storage;
  const configHash = (await fingerprintSerializedCatalog(JSON.stringify([config, policy?.defaultTtlMs ?? 300_000, policy?.minTtlMs ?? 0, policy?.maxTtlMs ?? MAX_CACHE_TTL_MS]))).fingerprint;
  const scope = cacheScope(ctx, connectorId, owner);
  let unavailable = false;
  const connectionGeneration: Listing["generation"] = {};
  let active: Listing | undefined;
  // ResponseCacheStore has no per-call options. A method snapshots its binding
  // before any await; an abandoned storage promise never adopts a later listing.
  const capture = (listing = active): CacheOperation => {
    const signals = [scope.abort.signal, connectionSignal, listing?.ctx.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const ended = () => scope.closed || listing?.ended === true || signals.some(signal => signal.aborted);
    const reason = () => signals.find(signal => signal.aborted)?.reason ?? new ConnectorCallError("connector_call_failed", "Catalog cache operation ended.");
    return {
      ctx: listing?.ctx ?? ctx,
      generation: listing?.generation ?? { ...connectionGeneration },
      credentialIdentity: listing?.credentialIdentity,
      listing,
      stopped: () => unavailable || ended(),
      io: read => new Promise((resolve, reject) => {
        const cleanup = () => { for (const signal of signals) signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(reason()); };
        if (ended()) { abort(); return; }
        for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
        // Storage cannot cancel dispatched I/O. Stop waiting, but attach both
        // outcomes so its eventual completion cannot continue cache publication.
        try { read().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); }); }
        catch (error) { cleanup(); reject(error); }
      }),
    };
  };
  let lastStamp = 0;
  let staleTools: { result: ListToolsResult; manifest: Manifest } | undefined;
  const currentGeneration = async ({ stopped, io, generation }: CacheOperation): Promise<string | undefined> => {
    const key = responseCacheKeys.generation(connectorId);
    for (let attempt = 0; attempt < 16; attempt++) {
      if (stopped()) return undefined;
      const current = await io(() => storage.get(key));
      if (stopped()) return undefined;
      if (current) return current;
      const next = generation.value ?? crypto.randomUUID();
      const claimed = await io(() => storage.compareAndSet(key, null, next, { ttlSeconds: GENERATION_TTL_SECONDS }));
      if (stopped()) return undefined;
      if (claimed) return next;
    }
    throw new Error("Catalog cache generation is busy.");
  };
  const namespace = async (operation: CacheOperation): Promise<string | undefined> => {
    const { stopped, generation, io } = operation;
    if (resolveCredentialIdentity && await io(resolveCredentialIdentity) !== operation.credentialIdentity) return undefined;
    const current = await currentGeneration(operation);
    if (!current || stopped()) return undefined;
    generation.value ??= current;
    return generation.value === current ? responseCacheKeys.namespace(connectorId, configHash, generation.value) : undefined;
  };
  const address = async (key: CacheKey, operation: CacheOperation): Promise<string | undefined> => {
    const { stopped } = operation;
    if (stopped() || !isCatalogMethod(key.method) || key.params) return undefined;
    let pair: unknown;
    try { pair = JSON.parse(key.partition ?? ""); } catch { return undefined; }
    if (!Array.isArray(pair) || pair.length !== 2 || (pair[1] !== partition && (pair[1] !== "" || sharing !== "shared"))) return undefined;
    const prefix = await namespace(operation);
    if (!prefix || stopped()) return undefined;
    // Hash the admitted principal/pool/auth partition; no identities or server text in keys.
    const digest = (await fingerprintSerializedCatalog(JSON.stringify([key.method, pair[1] === "" ? sharedPartition : partition, operation.credentialIdentity ?? null]))).fingerprint;
    return stopped() ? undefined : responseCacheKeys.entry(prefix, digest);
  };
  const manifest = (raw: string | null): Manifest | undefined => {
    if (!raw) return undefined;
    try {
      const m = JSON.parse(raw) as Manifest;
      return Number.isSafeInteger(m.stamp) && m.stamp > 0 && Number.isFinite(m.expiresAt) &&
        Number.isFinite(m.fetchedAt) && m.fetchedAt >= 0 && m.fetchedAt <= m.expiresAt &&
        (m.scope === "public" || m.scope === "private") && typeof m.revision === "string" &&
        /^[0-9a-f-]{36}$/.test(m.revision) && Number.isInteger(m.chunkCount) && m.chunkCount > 0 &&
        m.chunkCount <= Math.ceil(MAX_SERIALIZED_CATALOG_BYTES / MAX_CATALOG_CHUNK_BYTES) + 1 &&
        /^sha256:[0-9]+:[0-9a-f]{64}$/.test(m.fingerprint) ? m : undefined;
    } catch { return undefined; }
  };
  const intake = (ctx: ConnectorContext, method: CatalogMethod, result: CatalogResult) => {
    const body = sharing === "private" ? { ...result, cacheScope: "private" as const } : result;
    if (method === "tools/list") return catalogIntake(ctx, body as ListToolsResult);
    const field = method === "resources/list" ? "resources" : "resourceTemplates";
    const items = catalogItems(method, body).map(({ _meta: _ignored, ...item }) => item);
    if (items.length > MAX_CATALOG_TOOLS) throw catalogCeiling();
    const clean = sentSecretsForRequest(ctx.requestScope ?? ctx).redact({ ...body, [field]: items });
    if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > MAX_SERIALIZED_CATALOG_BYTES) throw catalogCeiling();
    return { ...clean, ttlMs: catalogTtlMs(ctx, body.ttlMs), cacheScope: body.cacheScope === "public" ? "public" as const : "private" as const };
  };
  const completeCatalogRefresh = async (result: ListToolsResult) => {
    const listing = active;
    const operation = capture();
    const { stopped, io } = operation;
    if (!listing || stopped()) return;
    const clean = intake(listing.ctx, "tools/list", result);
    const digest = (await fingerprintSerializedCatalog(JSON.stringify(clean))).fingerprint;
    const partitionDigest = (await fingerprintSerializedCatalog(JSON.stringify([
      clean.cacheScope === "public" ? sharedPartition : partition, operation.credentialIdentity ?? null,
    ]))).fingerprint;
    try {
      return await acceptCatalogRefresh(storage, responseCacheKeys.refreshDigest(connectorId, configHash, partitionDigest),
        connectorId, digest, (clean as ListToolsResult).tools, clean.cacheScope !== "public",
        async () => !stopped() && !!await namespace(operation) && !stopped(), io);
    } catch (error) {
      if (!stopped()) logFailure(listing.ctx.logger, "catalog refresh observation failed", failureRecord({ connector: connectorId }, error));
    }
  };
  const store: ResponseCacheStore = {
    async get(key) {
      const operation = capture();
      const { ctx, stopped, io } = operation;
      const root = await address(key, operation);
      if (!root || stopped()) return undefined;
      const m = manifest(await io(() => storage.get(root)));
      if (stopped() || !m || m.expiresAt <= Date.now() &&
          (key.method !== "tools/list" || m.expiresAt + STALE_FALLBACK_MS <= Date.now())) return undefined;
      const chunks: string[] = [];
      for (let i = 0; i < m.chunkCount; i++) {
        if (stopped()) return undefined;
        const chunk = await io(() => storage.get(responseCacheKeys.chunk(root, m.revision, i)));
        if (stopped() || chunk === null || new TextEncoder().encode(chunk).byteLength > MAX_CATALOG_CHUNK_BYTES) return undefined;
        chunks.push(chunk);
      }
      const value = chunks.join("");
      const fingerprint = await fingerprintSerializedCatalog(value);
      if (stopped() || fingerprint.byteLength > MAX_SERIALIZED_CATALOG_BYTES || fingerprint.fingerprint !== m.fingerprint || !await namespace(operation) || stopped()) return undefined;
      const result = JSON.parse(value) as CatalogResult;
      const method = key.method as CatalogMethod;
      const items = catalogItems(method, result);
      if (!Array.isArray(items) || items.length > MAX_CATALOG_TOOLS || "nextCursor" in result ||
        (result.resultType !== undefined && result.resultType !== "complete")) return undefined;
      const validated = await catalogSchema(method)["~standard"].validate(result);
      if (stopped() || validated.issues) return undefined;
      const clean = intake(ctx, method, validated.value);
      if (m.expiresAt <= Date.now()) {
        if (method === "tools/list" && (!staleTools || staleTools.manifest.fetchedAt < m.fetchedAt)) staleTools = { result: clean as ListToolsResult, manifest: m };
        return undefined;
      }
      observeCatalogFetch(ctx, m.fetchedAt, method);
      observeCatalogExpiry(ctx, method, clean.ttlMs, m.expiresAt);
      return { value: JSON.stringify(clean), stamp: m.stamp, expiresAt: m.expiresAt, scope: m.scope };
    },
    async set(key, entry) {
      const operation = capture();
      const { ctx, stopped, io } = operation;
      const root = await address(key, operation);
      if (!root || stopped()) return 0;
      const result = JSON.parse(entry.value) as CatalogResult;
      const method = key.method as CatalogMethod;
      if (catalogTtlMs(ctx, result.ttlMs) === 0) {
        if (!stopped() && await namespace(operation) && !stopped()) await io(() => storage.delete(root));
        return 0;
      }
      if (!Array.isArray(catalogItems(method, result)) || "nextCursor" in result ||
        (result.resultType !== undefined && result.resultType !== "complete")) return 0;
      // Defence in depth: the SDK catches store failures, so intake also runs on
      // the request path, where a secret-bearing name refuses the entire list.
      const value = JSON.stringify(intake(ctx, method, result));
      const fingerprint = await fingerprintSerializedCatalog(value);
      const expiresAt = Math.min(entry.expiresAt ?? Date.now(), (catalogFetchedAt(ctx, method) ?? Date.now()) + catalogTtlMs(ctx, result.ttlMs));
      if (stopped() || expiresAt <= Date.now() || !await namespace(operation) || stopped()) return 0;
      const revision = crypto.randomUUID();
      const bytes = new TextEncoder().encode(value);
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let offset = 0; let chunkCount = 0;
      const ttlSeconds = () => Math.max(0.001, (expiresAt + (method === "tools/list" ? STALE_FALLBACK_MS : 0) - Date.now()) / 1000);
      while (offset < bytes.length) {
        if (stopped() || expiresAt <= Date.now()) return 0;
        let end = Math.min(offset + MAX_CATALOG_CHUNK_BYTES, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        const chunk = responseCacheKeys.chunk(root, revision, chunkCount++);
        await io(() => storage.set(chunk, decoder.decode(bytes.subarray(offset, end)), { ttlSeconds: ttlSeconds() }));
        if (stopped()) return 0;
        offset = end;
      }
      for (let attempt = 0; attempt < 16; attempt++) {
        if (stopped() || expiresAt <= Date.now() || !await namespace(operation) || stopped()) return 0;
        const previous = await io(() => storage.get(root));
        if (stopped() || expiresAt <= Date.now()) return 0;
        const stamp = Math.max(Date.now(), (manifest(previous)?.stamp ?? 0) + 1, lastStamp + 1);
        const m: Manifest = { stamp, expiresAt, fetchedAt: catalogFetchedAt(ctx, method) ?? Date.now(), scope: sharing === "shared" && result.cacheScope === "public" ? "public" : "private", revision, chunkCount, fingerprint: fingerprint.fingerprint };
        const published = await io(() => storage.compareAndSet(root, previous, JSON.stringify(m), { ttlSeconds: ttlSeconds() }));
        if (stopped()) return 0;
        if (published) { lastStamp = stamp; return stamp; }
      }
      throw new Error("Catalog cache publication is busy.");
    },
    async delete(key) {
      const operation = capture();
      const root = await address(key, operation);
      if (root && !operation.stopped()) await operation.io(() => storage.delete(root));
    },
    async evict(method) { if (isCatalogMethod(method)) await store.clear(); },
    async clear() { const operation = capture(); if (!operation.stopped()) await operation.io(() => invalidateCatalogCache(storage, connectorId)); },
  };
  // Refresh/bypass listings may never call get(). Pin before any wire I/O so
  // their first late publication cannot adopt a post-notification generation.
  // Reading an absent generation pins a nonce without mutating storage before
  // negotiation/auth succeeds. The first cache operation may claim that nonce.
  try {
    const { stopped, io } = capture({ ctx, generation: connectionGeneration, ended: false });
    if (!stopped()) {
      const current = await io(() => storage.get(responseCacheKeys.generation(connectorId)));
      if (!stopped()) connectionGeneration.value = current ?? crypto.randomUUID();
    }
  }
  catch (error) {
    unavailable = true;
    logFailure(ctx.logger, "catalog read failed", failureRecord({ connector: connectorId }, error));
  }
  let tail = Promise.resolve();
  const withListing = <T>(listingCtx: ConnectorContext, read: () => Promise<T>): Promise<T> => {
    const pending = tail.then(async () => {
      if (scope.closed || connectionSignal?.aborted) throw new ConnectorCallError("connector_call_failed", "Catalog cache scope ended.");
      if (listingCtx.signal?.aborted) throw listingCtx.signal.reason;
      if (policy && !settings.has(listingCtx)) settings.set(listingCtx, policy);
      const listing: Listing = { ctx: listingCtx, generation: {}, ended: false };
      active = listing;
      staleTools = undefined;
      const operation = capture();
      try {
        if (resolveCredentialIdentity) listing.credentialIdentity = await operation.io(resolveCredentialIdentity);
        // Each new listing pins before even a refresh's first wire page. A
        // notification fences this listing, while a later listing can refresh.
        if (!operation.stopped()) {
          try {
            listing.generation.value = await operation.io(() => storage.get(responseCacheKeys.generation(connectorId))) ?? crypto.randomUUID();
            connectionGeneration.value = listing.generation.value;
          }
          catch (error) {
            if (operation.stopped()) throw error;
            unavailable = true;
            logFailure(ctx.logger, "catalog read failed", failureRecord({ connector: connectorId }, error));
          }
        }
        return await read();
      } finally { listing.ended = true; active = undefined; }
    });
    // Keep the binding through the entire SDK method, including its opposite
    // partition delete even when set() failed. Only then may a sibling bind.
    tail = pending.then(() => {}, () => {});
    return pending;
  };
  const fallbackTools = async (): Promise<ListToolsResult | undefined> => {
    const operation = capture();
    if (!staleTools || operation.stopped() || !await namespace(operation) || operation.stopped() ||
        staleTools.manifest.expiresAt + STALE_FALLBACK_MS <= Date.now()) return;
    const { result, manifest } = staleTools;
    observeCatalogFetch(operation.ctx, manifest.fetchedAt);
    observeCatalogExpiry(operation.ctx, "tools/list", typeof result.ttlMs === "number" ? result.ttlMs : 0, manifest.expiresAt, true);
    return result;
  };
  return { intake, completeCatalogRefresh, fallbackTools, responseCacheStore: store, cachePartition: partition, defaultCacheTtlMs: policy?.defaultTtlMs ?? CONFIG_DEFAULTS.discovery.catalogTtlSeconds * 1000, withListing, currentContext: () => active?.ctx ?? ctx };
}

function isCatalogMethod(method: string): method is CatalogMethod {
  return method === "tools/list" || method === "resources/list" || method === "resources/templates/list";
}

async function customCatalogCache(ctx: ConnectorContext, connectorId: string) {
  const credential = await ctx.credential?.getAll();
  const auth = (await fingerprintSerializedCatalog(JSON.stringify(credential ?? null))).fingerprint;
  const cache = await catalogClientOptions(ctx, connectorId, "custom-connector", auth);
  const key: CacheKey = { method: "tools/list", partition: JSON.stringify(["custom-connector", cache.cachePartition]) };
  return { cache, key };
}
/** Custom listings always fetch. Only an authenticated owner may retain a
 * complete private fallback; unscoped/operator reads start no cache I/O. */
export async function storeCustomCatalogFallback(ctx: ConnectorContext, connectorId: string, tools: readonly ToolDef[]): Promise<void> {
  const ttlMs = catalogTtlMs(ctx, undefined);
  observeCatalogFetch(ctx, Date.now());
  observeCatalogExpiry(ctx, "tools/list", ttlMs);
  if (!ttlMs || !callerOf(ctx)?.authenticated) return;
  const { cache, key } = await customCatalogCache(ctx, connectorId);
  await cache.withListing(ctx, async () => {
    const result = catalogIntake(ctx, { tools: tools.map(tool => ({ ...tool, inputSchema: tool.inputSchema ?? { type: "object" } })) as ListToolsResult["tools"], ttlMs, cacheScope: "private" });
    await cache.responseCacheStore!.set(key, { value: JSON.stringify(result), expiresAt: catalogExpiry(ctx)!.expiresAt, scope: "private" });
  });
}
export async function customCatalogFallback(ctx: ConnectorContext, connectorId: string): Promise<ToolDef[] | undefined> {
  if (!callerOf(ctx)?.authenticated) return;
  const { cache, key } = await customCatalogCache(ctx, connectorId);
  return cache.withListing(ctx, async () => {
    await cache.responseCacheStore!.get(key);
    return (await cache.fallbackTools())?.tools as ToolDef[] | undefined;
  });
}
