import type {
  Connector,
  ConnectorContext,
  ConnectorStatus,
  KVStorage,
  Logger,
  ToolDef,
} from "./types.js";
import type { CredentialVault } from "./credentials.js";
import { splitAddress, type Toolkit } from "./toolkits.js";

const ID_RE = /^[a-z0-9_-]+$/;
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_STALE_SECONDS = 3600;
const DEFAULT_MAX_RESULT_BYTES = 50_000;

interface CacheEntry {
  tools: ToolDef[];
  exp: number; // epoch ms
  staleUntil: number;
}

interface PersistedCatalog {
  tools: ToolDef[];
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
}

export interface HealthObservation {
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastLatencyMs?: number;
  consecutiveFailures: number;
  lastError?: string;
}

/**
 * Recent real-call outcomes per connector, as observed by ONE view.
 *
 * The deployment keeps one log, and each toolkit keeps its own. That split is a
 * scope boundary, not bookkeeping: `lastError` is a downstream error string
 * that routinely names the tool that failed, and `list_connectors` returns the
 * observation verbatim. Sharing one log would let a toolkit read back the tools
 * and failures of a sibling toolkit through a connector they happen to share —
 * and let a sibling's failures flip this view's reported status. A scoped view
 * reads back only the calls it made itself.
 */
export class HealthLog {
  private readonly observations = new Map<string, HealthObservation>();

  recordSuccess(id: string, latencyMs: number): void {
    const previous = this.observations.get(id);
    this.observations.set(id, {
      ...previous,
      lastSuccessAt: new Date().toISOString(),
      lastLatencyMs: latencyMs,
      consecutiveFailures: 0,
      lastError: undefined,
    });
  }

  recordFailure(id: string, latencyMs: number, error: unknown): void {
    const previous = this.observations.get(id);
    this.observations.set(id, {
      ...previous,
      lastFailureAt: new Date().toISOString(),
      lastLatencyMs: latencyMs,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      lastError: msg(error),
    });
  }

  get(id: string): HealthObservation | undefined {
    const observation = this.observations.get(id);
    return observation ? { ...observation } : undefined;
  }
}

export interface RegistryOptions {
  storage: KVStorage;
  logger: Logger;
  credentialVault?: CredentialVault;
  toolCacheTtlSeconds?: number;
  persistToolCatalog?: boolean;
  toolCatalogStaleSeconds?: number;
  /** Cap on inline result size before truncation + get_result paging. Default 50_000. */
  maxResultBytes?: number;
}

function namespaced(storage: KVStorage, prefix: string): KVStorage {
  return {
    get: (k) => storage.get(prefix + k),
    set: (k, v, o) => storage.set(prefix + k, v, o),
    delete: (k) => storage.delete(prefix + k),
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The registry surface a per-connection MCP server consumes: every meta-tool
 * (`src/meta-tools.ts`) and the `execute_code` sandbox bridge (`src/execute.ts`)
 * is typed against THIS, never against the concrete `Registry`.
 *
 * That indirection is the toolkit boundary (issue #22): a scoped connection is
 * handed a `ScopedRegistry` instead of the registry, and every meta-tool
 * inherits the scope from one place. Reaching for a registry method that isn't
 * here is a compile error, and adding one here is a compile error until
 * `ScopedRegistry` filters it — so a new meta-tool cannot quietly step around
 * the boundary.
 */
export interface RegistryView {
  /** Deployment-wide result-size cap threaded to the meta-tools. */
  readonly maxResultBytes: number;
  listConnectors(): Connector[];
  getConnector(id: string): Connector | undefined;
  resolveAddress(
    address: string,
  ): { connector: Connector; toolName: string } | null;
  getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ToolDef[]>;
  refreshTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ToolDef[]>;
  peekTools(id: string): ToolDef[] | undefined;
  contextFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions?: { signal?: AbortSignal; timeoutMs?: number },
  ): ConnectorContext;
  resultsStorage(): KVStorage;
  recordSuccess(id: string, latencyMs: number): void;
  recordFailure(id: string, latencyMs: number, error: unknown): void;
  healthFor(id: string): HealthObservation | undefined;
  hasObservedSuccess(id: string): boolean;
  statusFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ConnectorStatus>;
  invalidateStored(id: string): Promise<void>;
}

/**
 * Holds the connector set, resolves addresses, and caches per-connector tool
 * lists in memory with a TTL. Connector failures are isolated: a broken
 * connector surfaces status "error"; the rest keep working.
 */
export class Registry implements RegistryView {
  private readonly connectors = new Map<string, Connector>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly invalidated = new Set<string>();
  /** Deployment-wide observations — every call, whatever view made it. */
  private readonly health = new HealthLog();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly persistToolCatalog: boolean;
  /** Result-size guard cap threaded to the meta-tools. */
  readonly maxResultBytes: number;

  constructor(
    connectors: Connector[],
    private readonly opts: RegistryOptions,
  ) {
    this.ttlMs =
      (opts.toolCacheTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.staleMs =
      (opts.toolCatalogStaleSeconds ?? DEFAULT_STALE_SECONDS) * 1000;
    this.persistToolCatalog = opts.persistToolCatalog ?? true;
    this.maxResultBytes = opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    for (const c of connectors) {
      if (!ID_RE.test(c.id)) {
        throw new Error(
          `Invalid connector id "${c.id}": must match ${ID_RE.source}`,
        );
      }
      if (this.connectors.has(c.id)) {
        throw new Error(`Duplicate connector id "${c.id}"`);
      }
      this.connectors.set(c.id, c);
    }
    this.checkConventions(opts.logger);
  }

  /**
   * Warn once per convention violation at construction time. Static only —
   * never calls listTools() (remote connectors are lazy/network); tool-level
   * checks apply to connectors that expose `staticTools` (i.e. api()).
   */
  private checkConventions(logger: Logger): void {
    for (const c of this.connectors.values()) {
      if (!c.description) {
        logger.warn(
          `[connecta] connector "${c.id}" has no description — add one (convention: "<Service> — <top capabilities>")`,
        );
      }
      for (const t of c.staticTools ?? []) {
        const address = `${c.id}.${t.name}`;
        if (!t.description) {
          logger.warn(
            `[connecta] tool "${address}" has no description — add one (convention: imperative one-liner, e.g. "Send an email via Resend")`,
          );
        }
        if (!t.inputSchema) {
          logger.warn(
            `[connecta] tool "${address}" has no inputSchema — add one (convention: { type: "object" } with a description on every property)`,
          );
        }
      }
    }
  }

  listConnectors(): Connector[] {
    return [...this.connectors.values()];
  }

  getConnector(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  contextFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
    callOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): ConnectorContext {
    return {
      storage: namespaced(this.opts.storage, `conn:${id}:`),
      logger: this.opts.logger,
      baseUrl,
      ...(this.opts.credentialVault && this.connectors.get(id)?.credential
        ? {
            credential: {
              get: (field?: string) =>
                this.opts.credentialVault!.get(id, field),
              getAll: () => this.opts.credentialVault!.getAll(id),
            },
          }
        : {}),
      requestScope,
      ...callOptions,
    };
  }

  /**
   * Storage namespaced to the meta-tool result store (`results:` prefix), kept
   * separate from any connector's `conn:<id>:` namespace. Backs get_result.
   */
  resultsStorage(): KVStorage {
    return namespaced(this.opts.storage, "results:");
  }

  /** Resolve "<connectorId>.<toolName>" → connector + tool name. */
  resolveAddress(
    address: string,
  ): { connector: Connector; toolName: string } | null {
    const parts = splitAddress(address);
    if (!parts) return null;
    const connector = this.connectors.get(parts.connectorId);
    if (!connector) return null;
    return { connector, toolName: parts.toolName };
  }

  private catalogKey(id: string): string {
    return `catalog:${id}`;
  }

  private validCatalog(raw: string | null): PersistedCatalog | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<PersistedCatalog>;
      if (
        !Array.isArray(value.tools) ||
        typeof value.fetchedAt !== "number" ||
        typeof value.expiresAt !== "number" ||
        typeof value.staleUntil !== "number" ||
        !value.tools.every(
          (tool) =>
            tool !== null &&
            typeof tool === "object" &&
            typeof (tool as ToolDef).name === "string",
        )
      ) {
        return null;
      }
      return value as PersistedCatalog;
    } catch {
      return null;
    }
  }

  private async storeCatalog(id: string, tools: ToolDef[]): Promise<void> {
    if (!this.persistToolCatalog) return;
    const fetchedAt = Date.now();
    const catalog: PersistedCatalog = {
      tools,
      fetchedAt,
      expiresAt: fetchedAt + this.ttlMs,
      staleUntil: fetchedAt + this.ttlMs + this.staleMs,
    };
    await this.opts.storage.set(this.catalogKey(id), JSON.stringify(catalog), {
      ttlSeconds: Math.max(
        60,
        Math.ceil((this.ttlMs + this.staleMs) / 1000),
      ),
    });
  }

  /** Force a live listTools refresh and replace both catalog cache layers. */
  async refreshTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    const tools = connector.staticTools
      ? connector.staticTools
      : await connector.listTools(
          this.contextFor(id, baseUrl, requestScope),
        );
    const now = Date.now();
    const previous = this.cache.get(id);
    const catalogChanged =
      !previous || JSON.stringify(previous.tools) !== JSON.stringify(tools);
    const shouldPersist =
      !connector.staticTools &&
      (catalogChanged || previous.exp <= now || this.invalidated.has(id));
    this.cache.set(id, {
      tools,
      exp: now + this.ttlMs,
      staleUntil: now + this.ttlMs + this.staleMs,
    });
    this.invalidated.delete(id);
    if (shouldPersist) {
      try {
        await this.storeCatalog(id, tools);
      } catch (err) {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog persistence failed: ${msg(err)}`,
        );
      }
    }
    return tools;
  }

  /** Cached listTools with in-memory + persisted serializable catalog layers. */
  async getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    if (connector.staticTools) return connector.staticTools;

    const now = Date.now();
    const hit = this.cache.get(id);
    if (hit && hit.exp > now) return hit.tools;

    let stale = hit && hit.staleUntil > now ? hit.tools : undefined;
    if (this.persistToolCatalog && !this.invalidated.has(id)) {
      let persisted: PersistedCatalog | null = null;
      try {
        persisted = this.validCatalog(
          await this.opts.storage.get(this.catalogKey(id)),
        );
      } catch (err) {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog read failed: ${msg(err)}`,
        );
      }
      if (persisted && persisted.staleUntil > now) {
        this.cache.set(id, {
          tools: persisted.tools,
          exp: persisted.expiresAt,
          staleUntil: persisted.staleUntil,
        });
        if (persisted.expiresAt > now) return persisted.tools;
        stale = persisted.tools;
      }
    }

    try {
      return await this.refreshTools(id, baseUrl, requestScope);
    } catch (err) {
      if (stale) {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog refresh failed; serving stale catalog: ${msg(err)}`,
        );
        return stale;
      }
      throw err;
    }
  }

  /** Return a cached catalog without performing storage or network I/O. */
  peekTools(id: string): ToolDef[] | undefined {
    const connector = this.connectors.get(id);
    if (connector?.staticTools) return connector.staticTools;
    const hit = this.cache.get(id);
    return hit && hit.staleUntil > Date.now() ? hit.tools : undefined;
  }

  recordSuccess(id: string, latencyMs: number): void {
    this.health.recordSuccess(id, latencyMs);
  }

  recordFailure(id: string, latencyMs: number, error: unknown): void {
    this.health.recordFailure(id, latencyMs, error);
  }

  healthFor(id: string): HealthObservation | undefined {
    return this.health.get(id);
  }

  /**
   * Whether ANY view of this deployment has seen a successful call to `id` —
   * a bare boolean, never the observation. Connector liveness (reachable,
   * credentials still valid) is a deployment-level fact, not a per-view one, so
   * `list_connectors` may classify a connector as ok/unknown from it. The
   * observation itself — `lastError` above all, which names the tool that
   * failed — stays strictly per view.
   */
  hasObservedSuccess(id: string): boolean {
    return this.health.get(id)?.lastSuccessAt !== undefined;
  }

  /** Best-effort connector status for list_connectors. */
  async statusFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
  ): Promise<ConnectorStatus> {
    const connector = this.connectors.get(id);
    if (!connector) return { state: "error", message: "Unknown connector" };
    const ctx = this.contextFor(id, baseUrl, requestScope);
    if (connector.status) {
      try {
        return await connector.status(ctx);
      } catch (err) {
        return { state: "error", message: msg(err) };
      }
    }
    try {
      await this.getTools(id, baseUrl, requestScope);
      return { state: "ok" };
    } catch (err) {
      return { state: "error", message: msg(err) };
    }
  }

  /** Drop a connector's cached tool list (e.g. after auth completes). */
  invalidate(id: string): void {
    this.cache.delete(id);
    this.invalidated.add(id);
    if (this.persistToolCatalog) {
      void this.opts.storage.delete(this.catalogKey(id)).catch((err) => {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog invalidation failed: ${msg(err)}`,
        );
      });
    }
  }

  /** Drop both in-memory and persisted tool catalogs. */
  async invalidateStored(id: string): Promise<void> {
    this.cache.delete(id);
    this.invalidated.add(id);
    if (this.persistToolCatalog) {
      try {
        await this.opts.storage.delete(this.catalogKey(id));
      } catch (err) {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog invalidation failed: ${msg(err)}`,
        );
      }
    }
  }
}

/**
 * Per-toolkit HealthLogs, keyed by registry and then by toolkit name.
 *
 * Module-scoped rather than a `Registry` member on purpose: `Registry`'s type
 * is part of the public API surface (`Connecta.registry`), and this is internal
 * factoring only `ScopedRegistry` may touch. The WeakMap keeps the logs alive
 * exactly as long as their registry, and the inner map is bounded by the
 * number of configured toolkits.
 */
const toolkitHealthLogs = new WeakMap<Registry, Map<string, HealthLog>>();

/** The long-lived log one toolkit records into; created on first use. */
function toolkitHealthLog(base: Registry, toolkitName: string): HealthLog {
  let logs = toolkitHealthLogs.get(base);
  if (!logs) {
    logs = new Map<string, HealthLog>();
    toolkitHealthLogs.set(base, logs);
  }
  let log = logs.get(toolkitName);
  if (!log) {
    log = new HealthLog();
    logs.set(toolkitName, log);
  }
  return log;
}

/**
 * THE toolkit enforcement point (issue #22).
 *
 * A filtered VIEW of one long-lived `Registry`: same connectors, same tool
 * caches, same health — narrowed to the connectors and tool addresses one
 * toolkit selects. `serveMcp` builds it once per scoped connection and hands it
 * to `registerMetaTools`/`registerExecuteTool`, so `list_connectors`,
 * `search_tools`, `describe_tools`, `call_tool`, `call_destructive_tool`,
 * `batch_call`, `authorize_connector`, `get_result`, `skills`, and the
 * `execute_code` host bridge all inherit the boundary from here instead of
 * re-implementing nine checks.
 *
 * Two invariants make it reviewable:
 *
 * 1. **Indistinguishability.** Out-of-scope input fails through the SAME code
 *    path, with the same error class and message, as input naming something
 *    that does not exist at all. An out-of-scope CONNECTOR disappears from
 *    `resolveAddress`/`getConnector` (→ `Unknown address` / `Unknown
 *    connector`); an out-of-scope TOOL disappears from the catalog this view
 *    returns (→ `Unknown tool "<t>" on connector "<c>"`), which is exactly the
 *    error a misspelled tool name already produced. Scoping deliberately does
 *    NOT reject at `resolveAddress` for tools: that would answer with the
 *    connector-level message and make "hidden here" distinguishable from
 *    "never existed".
 * 2. **It filters views, never state.** Every read delegates to the shared
 *    registry and filters the returned array, so the tool cache, the persisted
 *    catalog, and the health map stay whole and shared across scopes.
 */
export class ScopedRegistry implements RegistryView {
  /** This toolkit's own health observations — see HealthLog. */
  private readonly health: HealthLog;

  constructor(
    private readonly base: Registry,
    private readonly toolkit: Toolkit,
  ) {
    this.health = toolkitHealthLog(base, toolkit.name);
  }

  get maxResultBytes(): number {
    return this.base.maxResultBytes;
  }

  /** In scope AND actually registered. */
  private visible(id: string): boolean {
    return (
      this.toolkit.hasConnector(id) && this.base.getConnector(id) !== undefined
    );
  }

  /** Byte-identical to what the unscoped registry throws for an unknown id. */
  private unknownConnector(id: string): Error {
    return new Error(`Unknown connector "${id}"`);
  }

  private inScopeTools(id: string, tools: ToolDef[]): ToolDef[] {
    return tools.filter((tool) => this.toolkit.hasTool(id, tool.name));
  }

  listConnectors(): Connector[] {
    return this.base
      .listConnectors()
      .filter((connector) => this.toolkit.hasConnector(connector.id));
  }

  getConnector(id: string): Connector | undefined {
    return this.visible(id) ? this.base.getConnector(id) : undefined;
  }

  resolveAddress(
    address: string,
  ): { connector: Connector; toolName: string } | null {
    const resolved = this.base.resolveAddress(address);
    if (!resolved) return null;
    // Connector-level only — see invariant 1 above.
    return this.toolkit.hasConnector(resolved.connector.id) ? resolved : null;
  }

  async getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ToolDef[]> {
    if (!this.visible(id)) throw this.unknownConnector(id);
    return this.inScopeTools(
      id,
      await this.base.getTools(id, baseUrl, requestScope),
    );
  }

  async refreshTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): Promise<ToolDef[]> {
    if (!this.visible(id)) throw this.unknownConnector(id);
    return this.inScopeTools(
      id,
      await this.base.refreshTools(id, baseUrl, requestScope),
    );
  }

  peekTools(id: string): ToolDef[] | undefined {
    if (!this.visible(id)) return undefined;
    const tools = this.base.peekTools(id);
    return tools ? this.inScopeTools(id, tools) : undefined;
  }

  contextFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
    callOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): ConnectorContext {
    // Unreachable through the meta-tools (they resolve first), so a throw here
    // is a loud backstop rather than a silent grant of connector storage and
    // credentials to a scope that may not see the connector.
    if (!this.visible(id)) throw this.unknownConnector(id);
    return this.base.contextFor(id, baseUrl, requestScope, callOptions);
  }

  /**
   * Stashed oversized results are bound to the scope that produced them: a
   * scoped session cannot page a result it could not have produced, and an id
   * from another scope reads back as the ordinary "Unknown or expired result
   * id". Unscoped sessions keep the historical `results:` prefix untouched.
   */
  resultsStorage(): KVStorage {
    return namespaced(
      this.base.resultsStorage(),
      `toolkit:${this.toolkit.name}:`,
    );
  }

  // Outcomes are recorded twice on purpose: the deployment-wide log keeps the
  // operator surfaces complete, while the toolkit's own log is the ONLY one
  // this view reads back — so `list_connectors` here never reports a sibling
  // toolkit's failures, or the tool names their error strings carry.
  recordSuccess(id: string, latencyMs: number): void {
    if (!this.visible(id)) return;
    this.base.recordSuccess(id, latencyMs);
    this.health.recordSuccess(id, latencyMs);
  }

  recordFailure(id: string, latencyMs: number, error: unknown): void {
    if (!this.visible(id)) return;
    this.base.recordFailure(id, latencyMs, error);
    this.health.recordFailure(id, latencyMs, error);
  }

  healthFor(id: string): HealthObservation | undefined {
    return this.visible(id) ? this.health.get(id) : undefined;
  }

  /**
   * Deliberately NOT per view: whether the connector has ever answered is a
   * fact about the connector, not about a team's traffic, and withholding it
   * would report every remote connector as "unknown" to a scoped session that
   * has not called it yet. It carries no tool name, error text, or count — the
   * per-view isolation of those, above, is unchanged.
   */
  hasObservedSuccess(id: string): boolean {
    return this.visible(id) ? this.base.hasObservedSuccess(id) : false;
  }

  async statusFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
  ): Promise<ConnectorStatus> {
    // Same shape the unscoped registry returns for an unregistered id.
    if (!this.visible(id)) {
      return { state: "error", message: "Unknown connector" };
    }
    return this.base.statusFor(id, baseUrl, requestScope);
  }

  async invalidateStored(id: string): Promise<void> {
    if (!this.visible(id)) return;
    await this.base.invalidateStored(id);
  }
}
