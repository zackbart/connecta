import type {
  Connector,
  ConnectorContext,
  ConnectorStatus,
  KVStorage,
  Logger,
  ToolDef,
} from "./types.js";
import type { CredentialVault } from "./credentials.js";

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
 * Holds the connector set, resolves addresses, and caches per-connector tool
 * lists in memory with a TTL. Connector failures are isolated: a broken
 * connector surfaces status "error"; the rest keep working.
 */
export class Registry {
  private readonly connectors = new Map<string, Connector>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly invalidated = new Set<string>();
  private readonly health = new Map<string, HealthObservation>();
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
    const dot = address.indexOf(".");
    if (dot <= 0 || dot === address.length - 1) return null;
    const id = address.slice(0, dot);
    const toolName = address.slice(dot + 1);
    const connector = this.connectors.get(id);
    if (!connector) return null;
    return { connector, toolName };
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
    const previous = this.health.get(id);
    this.health.set(id, {
      ...previous,
      lastSuccessAt: new Date().toISOString(),
      lastLatencyMs: latencyMs,
      consecutiveFailures: 0,
      lastError: undefined,
    });
  }

  recordFailure(id: string, latencyMs: number, error: unknown): void {
    const previous = this.health.get(id);
    this.health.set(id, {
      ...previous,
      lastFailureAt: new Date().toISOString(),
      lastLatencyMs: latencyMs,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      lastError: msg(error),
    });
  }

  healthFor(id: string): HealthObservation | undefined {
    const observation = this.health.get(id);
    return observation ? { ...observation } : undefined;
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
