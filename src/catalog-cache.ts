// The SDK owns aggregation and freshness. This adapter stores only complete,
// intake-redacted tools/list successes in the deployment's SQL-backed KV.
import type { CacheKey, ClientOptions, ListToolsResult, ResponseCacheStore } from "@modelcontextprotocol/client";
import { MAX_CACHE_TTL_MS, specTypeSchemas } from "@modelcontextprotocol/client";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { ConnectorCallError } from "./errors.js";
import { fingerprintSerializedCatalog } from "./catalog-fingerprint.js";
import { MAX_CATALOG_CHUNK_BYTES, MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "./catalog-limits.js";
import { redactCatalog, sentSecretsForRequest } from "./sent-secrets.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { responseCacheKeys } from "./storage/keys.js";
import type { ConnectorContext, KVStorage } from "./types.js";

interface CatalogCacheSettings {
  storage: KVStorage;
  partition: string;
  defaultTtlMs: number;
  minTtlMs: number;
  maxTtlMs: number;
}
const fetchedAt = new WeakMap<ConnectorContext, number>();
export function observeCatalogFetch(ctx: ConnectorContext, at: number): void { fetchedAt.set(ctx, at); }
export function catalogFetchedAt(ctx: ConnectorContext): number | undefined { return fetchedAt.get(ctx); }
const settings = new WeakMap<ConnectorContext, CatalogCacheSettings>();
export function attachCatalogCache(ctx: ConnectorContext, value: CatalogCacheSettings): void { settings.set(ctx, value); }
interface CacheScope { closed: boolean; invalidating?: Promise<void> }
const scopes = new WeakMap<object, Map<string, CacheScope>>();
function cacheScope(ctx: ConnectorContext, connectorId: string): CacheScope {
  const key = ctx.requestScope ?? ctx;
  let connectors = scopes.get(key);
  if (!connectors) { connectors = new Map(); scopes.set(key, connectors); }
  let scope = connectors.get(connectorId);
  if (!scope) { scope = { closed: false }; connectors.set(connectorId, scope); }
  return scope;
}
/** Start the fence before SDK eviction; teardown joins already-started I/O. */
export function observeCatalogChange(ctx: ConnectorContext, connectorId: string): void {
  const scope = cacheScope(ctx, connectorId);
  if (scope.closed || ctx.signal?.aborted) return;
  const writing = invalidateCatalogCache(settings.get(ctx)?.storage ?? ctx.storage, connectorId).catch(error => {
    logFailure(ctx.logger, "catalog invalidation failed", failureRecord({ connector: connectorId }, error));
  });
  scope.invalidating = scope.invalidating ? Promise.all([scope.invalidating, writing]).then(() => {}) : writing;
}
export function closeCatalogCacheScope(ctx: ConnectorContext, connectorId: string): Promise<void> | undefined {
  const scope = cacheScope(ctx, connectorId);
  scope.closed = true;
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

/** Keys ignore self-reported serverInfo and bind the configured connector instead. */
export async function catalogClientOptions(
  ctx: ConnectorContext,
  connectorId: string,
  config: string,
  authPartition: string,
): Promise<Pick<ClientOptions, "responseCacheStore" | "cachePartition" | "defaultCacheTtlMs">> {
  const policy = settings.get(ctx);
  const partition = JSON.stringify([policy?.partition ?? "unscoped", authPartition]);
  const storage = policy?.storage ?? ctx.storage;
  const configHash = (await fingerprintSerializedCatalog(JSON.stringify([config, policy?.defaultTtlMs ?? 300_000, policy?.minTtlMs ?? 0, policy?.maxTtlMs ?? MAX_CACHE_TTL_MS]))).fingerprint;
  const scope = cacheScope(ctx, connectorId);
  let unavailable = false;
  const stopped = () => unavailable || scope.closed || ctx.signal?.aborted === true;
  let generation: string | undefined;
  let lastStamp = 0;
  const currentGeneration = async (): Promise<string | undefined> => {
    const key = responseCacheKeys.generation(connectorId);
    for (let attempt = 0; attempt < 16; attempt++) {
      if (stopped()) return undefined;
      const current = await storage.get(key);
      if (stopped()) return undefined;
      if (current) return current;
      const next = generation ?? crypto.randomUUID();
      const claimed = await storage.compareAndSet(key, null, next, { ttlSeconds: GENERATION_TTL_SECONDS });
      if (stopped()) return undefined;
      if (claimed) return next;
    }
    throw new Error("Catalog cache generation is busy.");
  };
  const namespace = async (): Promise<string | undefined> => {
    const current = await currentGeneration();
    if (!current || stopped()) return undefined;
    generation ??= current;
    return generation === current ? responseCacheKeys.namespace(connectorId, configHash, generation) : undefined;
  };
  const address = async (key: CacheKey): Promise<string | undefined> => {
    if (stopped() || key.method !== "tools/list" || key.params) return undefined;
    let pair: unknown;
    try { pair = JSON.parse(key.partition ?? ""); } catch { return undefined; }
    if (!Array.isArray(pair) || pair.length !== 2 || (pair[1] !== "" && pair[1] !== partition)) return undefined;
    const prefix = await namespace();
    if (!prefix || stopped()) return undefined;
    // Hash the admitted principal/pool/auth partition; no identities or server text in keys.
    const digest = (await fingerprintSerializedCatalog(pair[1])).fingerprint;
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
  const store: ResponseCacheStore = {
    async get(key) {
      const root = await address(key);
      if (!root || stopped()) return undefined;
      const m = manifest(await storage.get(root));
      if (stopped() || !m || m.expiresAt <= Date.now()) return undefined;
      const chunks: string[] = [];
      for (let i = 0; i < m.chunkCount; i++) {
        if (stopped()) return undefined;
        const chunk = await storage.get(responseCacheKeys.chunk(root, m.revision, i));
        if (stopped() || chunk === null || new TextEncoder().encode(chunk).byteLength > MAX_CATALOG_CHUNK_BYTES) return undefined;
        chunks.push(chunk);
      }
      const value = chunks.join("");
      const fingerprint = await fingerprintSerializedCatalog(value);
      if (stopped() || fingerprint.byteLength > MAX_SERIALIZED_CATALOG_BYTES || fingerprint.fingerprint !== m.fingerprint || !await namespace() || stopped()) return undefined;
      const result = JSON.parse(value) as ListToolsResult;
      if (!Array.isArray(result.tools) || result.tools.length > MAX_CATALOG_TOOLS || "nextCursor" in result ||
        (result.resultType !== undefined && result.resultType !== "complete")) return undefined;
      const validated = await specTypeSchemas.ListToolsResult["~standard"].validate(result);
      if (stopped() || validated.issues) return undefined;
      const clean = JSON.stringify(catalogIntake(ctx, validated.value));
      observeCatalogFetch(ctx, m.fetchedAt);
      return { value: clean, stamp: m.stamp, expiresAt: m.expiresAt, scope: m.scope };
    },
    async set(key, entry) {
      const root = await address(key);
      if (!root || stopped()) return 0;
      const result = JSON.parse(entry.value) as ListToolsResult;
      if (!Array.isArray(result.tools) || "nextCursor" in result ||
        (result.resultType !== undefined && result.resultType !== "complete")) return 0;
      // Defence in depth: the SDK catches store failures, so intake also runs on
      // the request path, where a secret-bearing name refuses the entire list.
      const value = JSON.stringify(catalogIntake(ctx, result));
      const fingerprint = await fingerprintSerializedCatalog(value);
      const expiresAt = Math.min(entry.expiresAt ?? Date.now(), (catalogFetchedAt(ctx) ?? Date.now()) + catalogTtlMs(ctx, result.ttlMs));
      if (stopped() || expiresAt <= Date.now() || !await namespace() || stopped()) return 0;
      const revision = crypto.randomUUID();
      const bytes = new TextEncoder().encode(value);
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let offset = 0; let chunkCount = 0;
      const ttlSeconds = () => Math.max(0.001, (expiresAt - Date.now()) / 1000);
      while (offset < bytes.length) {
        if (stopped() || expiresAt <= Date.now()) return 0;
        let end = Math.min(offset + MAX_CATALOG_CHUNK_BYTES, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        await storage.set(responseCacheKeys.chunk(root, revision, chunkCount++), decoder.decode(bytes.subarray(offset, end)), { ttlSeconds: ttlSeconds() });
        if (stopped()) return 0;
        offset = end;
      }
      for (let attempt = 0; attempt < 16; attempt++) {
        if (stopped() || expiresAt <= Date.now() || !await namespace() || stopped()) return 0;
        const previous = await storage.get(root);
        if (stopped() || expiresAt <= Date.now()) return 0;
        const stamp = Math.max(Date.now(), (manifest(previous)?.stamp ?? 0) + 1, lastStamp + 1);
        const m: Manifest = { stamp, expiresAt, fetchedAt: catalogFetchedAt(ctx) ?? Date.now(), scope: result.cacheScope === "public" ? "public" : "private", revision, chunkCount, fingerprint: fingerprint.fingerprint };
        const published = await storage.compareAndSet(root, previous, JSON.stringify(m), { ttlSeconds: ttlSeconds() });
        if (stopped()) return 0;
        if (published) { lastStamp = stamp; return stamp; }
      }
      throw new Error("Catalog cache publication is busy.");
    },
    async delete(key) { const root = await address(key); if (root && !stopped()) await storage.delete(root); },
    async evict(method) { if (method === "tools/list") await store.clear(); },
    async clear() { if (!stopped()) await invalidateCatalogCache(storage, connectorId); },
  };
  // Refresh/bypass listings may never call get(). Pin before any wire I/O so
  // their first late publication cannot adopt a post-notification generation.
  // Reading an absent generation pins a nonce without mutating storage before
  // negotiation/auth succeeds. The first cache operation may claim that nonce.
  try {
    if (!stopped()) {
      const current = await storage.get(responseCacheKeys.generation(connectorId));
      if (!stopped()) generation = current ?? crypto.randomUUID();
    }
  }
  catch (error) {
    unavailable = true;
    logFailure(ctx.logger, "catalog read failed", failureRecord({ connector: connectorId }, error));
  }
  return { responseCacheStore: store, cachePartition: partition, defaultCacheTtlMs: policy?.defaultTtlMs ?? CONFIG_DEFAULTS.discovery.catalogTtlSeconds * 1000 };
}
