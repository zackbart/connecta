import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Result,
} from "effect";
import type { CredentialVault } from "./credential-contract.js";
import type {
  CatalogAccessObservation,
  CatalogDriftCounts,
  CatalogDriftReport,
  Connector,
  ConnectorContext,
  ConnectorStatus,
  KVStorage,
  Logger,
  ToolDef,
} from "./types.js";
import {
  type DeferredWork,
} from "./connector-scope.js";
import {
  type CatalogDriftActivityContext,
} from "./activity.js";
import {
  storedCredentialShape,
} from "./credential-rules.js";
import { ConnectorCallError, msg } from "./errors.js";
import {
  ConnectorCallAdmissionController,
  aggregateCallAdmissionSnapshots,
  type CallAdmissionPermit,
  type ConnectorCallAdmissionSnapshot,
} from "./call-admission.js";
import { boundedCatalogDrift } from "./catalog-drift.js";
import {
  fingerprintSerializedCatalog,
  snapshotCatalog,
  type CatalogSnapshot,
} from "./catalog-fingerprint.js";
import {
  MAX_CATALOG_CHUNK_BYTES,
  MAX_CATALOG_TOOLS,
  MAX_SERIALIZED_CATALOG_BYTES,
} from "./catalog-limits.js";
import { ObservedOutputSchemas } from "./result-shapes.js";
import {
  GUIDE_SUMMARY_LENGTH,
  normalizeGuideSummary,
} from "./skills.js";
import { attachOAuthSealer, vaultOAuthSealer } from "./oauth-sealing.js";
import { closeScopeOnExit } from "./runtime/connector-scope.js";
import { detach, runEdge, withDeadlineEffect } from "./runtime/run.js";
import { SharedRead } from "./runtime/shared-read.js";
import { Logger as LoggerService, type Storage } from "./runtime/services.js";
import {
  runOnPartition,
  storageDelete,
  storageGet,
  storageSet,
} from "./runtime/storage.js";
import { DEFAULT_PROBE_TIMEOUT_MS, normalizeTimeoutMs } from "./timeout.js";

const ID_RE = /^[a-z0-9_-]+$/;
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_STALE_SECONDS = 3600;
const CATALOG_CHUNK_TTL_GRACE_SECONDS = 300;
const DEFAULT_MAX_RESULT_BYTES = 24_000;
const encoder = new TextEncoder();

/**
 * Split `"<connectorId>.<toolName>"` on the first dot. Connector ids contain
 * no dots, so a downstream tool name may. Exported because an address that
 * resolves to nothing is still an address the invocation path has to record
 * activity for — a connector id an agent invented is the most common address
 * mistake, and the one an operator most needs to see.
 */
export function splitAddress(
  address: string,
): { connectorId: string; toolName: string } | null {
  const dot = address.indexOf(".");
  if (dot <= 0 || dot === address.length - 1) return null;
  return {
    connectorId: address.slice(0, dot),
    toolName: address.slice(dot + 1),
  };
}

/**
 * Smallest accepted inline-result cap. One byte is pathological but harmless:
 * `alignEndToCharBoundary` widens a window narrower than the codepoint at the
 * offset, so even a 1-byte cap still truncates sanely and still pages. Caps
 * that small already ship in the test suite (4 and 5), so the floor is placed
 * where it excludes only values that are *broken* rather than merely tiny.
 */
export const MIN_MAX_RESULT_BYTES = 1;

/**
 * The one definition of a usable `maxResultBytes`: a finite whole number of at
 * least {@link MIN_MAX_RESULT_BYTES} bytes. Shared by all three intake points
 * — `calls.maxResultBytes`, the per-connector override, and `get_result`'s
 * `maxBytes` argument — so a value that is valid at one is valid at all.
 *
 * Everything else is rejected rather than coerced, because each rejected shape
 * silently does something *worse* than the default: `0`/`NaN` serve an empty
 * head (`slice(0, 0)`) and make paging fail to advance, negatives serve a
 * LARGER head than asked for (`slice(0, -1)` counts from the end) while still
 * claiming truncation, and `Infinity` disables the guard with no notice.
 */
export function isValidMaxResultBytes(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_MAX_RESULT_BYTES;
}

/**
 * Resolve a configured cap against the value it inherits, dropping anything
 * `isValidMaxResultBytes` rejects. Operator-facing surfaces pair this with a
 * startup warning (see `Registry.checkResultCaps`) so the fallback is never
 * silent; the resolution itself stays total so no call site has to cope with
 * a broken cap.
 */
export function resolveMaxResultBytes(
  value: number | undefined,
  inherited: number,
): number {
  return value !== undefined && isValidMaxResultBytes(value)
    ? value
    : inherited;
}

interface CacheEntry {
  tools: ToolDef[];
  fingerprint: string;
  exp: number; // epoch ms
  staleUntil: number;
}

interface CatalogRefreshFlight {
  generation: number;
  /**
   * Epoch ms at which the flight is abandoned: its owner's deadline, or the
   * default probe timeout for an owner with none. A connector that ignores
   * its abort signal can go on listing past it, but nobody waits for it any
   * longer, and what it lists then reaches neither cache layer (#570).
   */
  abandonAt: number;
  /** Set once a reader gives up on it; its result can no longer publish. */
  abandoned: boolean;
  /**
   * Completed once: by the request that owns the refresh, when its work and
   * teardown are done, or by the reader that abandons it at its bound. Every
   * other caller only awaits it, each through a Promise edge of its own. No
   * fiber outlives a request to hold it open.
   */
  outcome: Deferred.Deferred<ToolDef[], unknown>;
  /** One caught/logged tail shared by every stale reader that joins. */
  deferredTail?: Promise<void>;
}

/**
 * What a joiner hears from a flight that will not answer for it: one that
 * passed its bound, or failed for a reason that was its owner's alone. It
 * never reaches a caller; a joiner that hears it makes a fresh attempt.
 */
class AbandonedCatalogRefresh extends Error {
  constructor(id: string) {
    super(`The catalog refresh of "${id}" was abandoned.`);
    this.name = "AbandonedCatalogRefresh";
  }
}

interface PersistedCatalogManifest {
  version: 2;
  revision: string;
  toolCount: number;
  byteCount: number;
  chunkCount: number;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
}

interface PersistedCatalog {
  tools: ToolDef[];
  fingerprint: string;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
}

const CATALOG_CHUNK_IO_CONCURRENCY = 4;

/**
 * Run `operation` over every chunk index or chunk with the fixed chunk I/O
 * bound, settling each: one failure neither interrupts its siblings nor
 * leaves their storage calls running behind the caller. Results keep input
 * order, so the first failure by index is the one a caller reports.
 */
function forEachChunk<T, A>(
  items: readonly T[],
  operation: (item: T, index: number) => Effect.Effect<A, unknown, Storage>,
): Effect.Effect<Array<Result.Result<A, unknown>>, never, Storage> {
  return Effect.forEach(
    items,
    (item, index) => Effect.result(operation(item, index)),
    { concurrency: CATALOG_CHUNK_IO_CONCURRENCY },
  );
}

/**
 * A persisted-catalog mutation that logs its storage failure rather than
 * failing, so its turn in the mutation queue always ends.
 */
function warnOnFailure<R>(
  mutation: Effect.Effect<void, unknown, R>,
  failed: string,
): Effect.Effect<void, never, R | LoggerService> {
  return Effect.catch(mutation, (err) =>
    LoggerService.use((logger) =>
      Effect.sync(() => logger.warn(`[connecta] ${failed}: ${msg(err)}`)),
    ),
  );
}

export interface RegistryOptions {
  storage: KVStorage;
  logger: Logger;
  credentialVault?: CredentialVault | undefined;
  credentialUi?: boolean | undefined;
  /** Internal owner partition used by a personal registry. */
  credentialOwner?: string | undefined;
  /** Internal child registries skip deployment-wide construction warnings. */
  constructionChecks?: boolean | undefined;
  toolCacheTtlSeconds?: number | undefined;
  persistToolCatalog?: boolean | undefined;
  toolCatalogStaleSeconds?: number | undefined;
  /**
   * Cap on inline result size before truncation + get_result paging. Must be a
   * whole number of bytes >= 1; anything else warns at startup and falls back
   * to the default 24_000.
   */
  maxResultBytes?: number | undefined;
  results?: { maxStashBytes?: number; maxStashEntries?: number } | undefined;
  /**
   * Where payload-free catalog-drift observations go. Present only when the
   * deployment configured an activity store; drift is reported through
   * connector status either way.
   */
  catalogDriftActivity?:
    | Omit<CatalogDriftActivityContext, "logger">
    | undefined;
}

function namespaced(storage: KVStorage, prefix: string): KVStorage {
  return {
    get: (k) => storage.get(prefix + k),
    set: (k, v, o) => storage.set(prefix + k, v, o),
    delete: (k) => storage.delete(prefix + k),
    ...(storage.list
      ? {
          list: async (keyPrefix: string) =>
            (await storage.list!(prefix + keyPrefix)).map((key) =>
              key.slice(prefix.length),
            ),
        }
      : {}),
    ...(storage.compareAndSet
      ? {
          compareAndSet: (
            k: string,
            expected: string | null,
            next: string | null,
            o?: { ttlSeconds?: number },
          ) => storage.compareAndSet!(prefix + k, expected, next, o),
        }
      : {}),
  };
}

export type ConnectorOperationOptions = Pick<
  ConnectorContext,
  "signal" | "timeoutMs"
>;

/** Agent-only catalog behavior. This never enters a ConnectorContext. */
export interface CatalogReadOptions {
  defer?: DeferredWork;
  /** Fresh deadline for a deferred refresh; never an inbound signal. */
  refreshTimeoutMs: number;
}

/**
 * The registry surface a per-connection MCP server consumes: every meta-tool
 * (`src/meta-tools.ts`) and the `execute_code` sandbox bridge (`src/execute.ts`)
 * is typed against THIS, never against the concrete `Registry`.
 *
 * The read-only seam remains useful even without scoped views: meta-tools can
 * consume registry behavior without depending on the concrete implementation
 * or its construction-only methods.
 */
export interface RegistryView {
  credentialUiAvailable(): boolean;
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
    callOptions?: ConnectorOperationOptions,
    readOptions?: CatalogReadOptions,
  ): Promise<ToolDef[]>;
  contextFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions?: ConnectorOperationOptions,
  ): ConnectorContext;
  /** Acquire the connector's shared downstream-call permit. */
  admitCall(
    id: string,
    input: { toolName: string; args: unknown; signal?: AbortSignal },
  ): Promise<CallAdmissionPermit>;
  resultsStorage(): KVStorage;
  /** Reserve runtime-wide capacity before writing a paging envelope's chunks. */
  stashResult(key: string, chunks: readonly string[], ttlSeconds: number): Promise<boolean>;
  /** Local declared-vs-stored credential mismatch, with no downstream I/O. */
  credentialDriftFor(id: string): Promise<string | undefined>;
  /** Value-free shape learned from successful calls, never a provider declaration. */
  observedOutputSchema(
    connectorId: string,
    definition: ToolDef,
  ): ToolDef["outputSchema"] | undefined;
  /** Passively learn one successful unwrapped result; failures stay isolated. */
  observeOutputShape(
    connectorId: string,
    definition: ToolDef,
    value: unknown,
  ): void;
  statusFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions?: ConnectorOperationOptions,
  ): Promise<ConnectorStatus>;
  invalidateStored(id: string): Promise<void>;
  /** Bind returned OAuth state to this view's personal storage partition. */
  bindOAuthHandoff(id: string, authorizationUrl: string): Promise<void>;
}

/**
 * Connector id → the only tool names this view may see on it. A connector
 * absent from the map is visible whole. Derived from `connectorAccess`
 * addresses at the auth gate; never from caller input.
 */
export type ToolAccess = ReadonlyMap<string, ReadonlySet<string>>;

export interface RegistryScope {
  connectorIds: "all" | readonly string[];
  toolAccess?: ToolAccess;
  subjectKey?: string;
  principalKey?: string;
}

const MAX_PERSONAL_REGISTRIES = 1_024;
const MAX_ABSENT_GRANT_WARNINGS = 1_024;
const OAUTH_HANDOFF_TTL_SECONDS = 15 * 60;

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Holds the connector set, resolves addresses, and caches per-connector tool
 * lists in memory with a TTL. Connector failures are isolated: a broken
 * connector surfaces status "error"; the rest keep working.
 */
export class Registry implements RegistryView {
  private readonly connectors = new Map<string, Connector>();
  private readonly callAdmission = new Map<
    string,
    ConnectorCallAdmissionController
  >();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly invalidated = new Set<string>();
  /** Per-connector epoch preventing a pre-invalidation refresh from publishing. */
  private readonly catalogGenerations = new Map<string, number>();
  // The last queued mutation per connector, as the turn its own request
  // completes once its storage work is done; see enqueueCatalogMutation.
  /** Serialize persisted catalog set/delete operations within this isolate. */
  private readonly catalogMutations = new Map<string, Deferred.Deferred<void>>();
  /** Same-request cold loads share one read without retaining the request.
   * See documentation/architecture.md#the-two-lifetimes. */
  private readonly requestCatalogLoads = new WeakMap<
    object,
    Map<string, SharedRead<ToolDef[]>>
  >();
  /** One live refresh per connector across agent and operator requests. */
  private readonly catalogRefreshes = new Map<
    string,
    CatalogRefreshFlight
  >();
  /** Last payload-free agent catalog access in this runtime. */
  private readonly catalogAccess = new Map<
    string,
    CatalogAccessObservation
  >();
  /** Last drift counts reported to activity, per connector, in this runtime. */
  private readonly reportedDrift = new Map<string, CatalogDriftCounts>();
  private readonly observedOutputSchemas: ObservedOutputSchemas;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly persistToolCatalog: boolean;
  /** Result-size guard cap threaded to the meta-tools. */
  readonly maxResultBytes: number;
  /** Only keys, byte counts, and expiry survive requests; never write promises. */
  private readonly resultStash = new Map<string, {
    /** Every backing key this envelope wrote, so expiry reclaims all of them. */
    keys: readonly string[];
    bytes: number;
    expiresAt: number;
    busy: boolean;
  }>();
  private resultStashBytes = 0;
  private readonly configuredConnectors: Connector[];
  private readonly personalRegistries = new Map<string, Registry>();
  private callAdmissionClosed = false;
  /** Bounded FIFO of absent grants already warned about. */
  private readonly warnedAbsentGrants = new Set<string>();

  constructor(
    connectors: Connector[],
    private readonly opts: RegistryOptions,
  ) {
    this.configuredConnectors = [...connectors];
    this.observedOutputSchemas = new ObservedOutputSchemas();
    this.ttlMs =
      (opts.toolCacheTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.staleMs =
      (opts.toolCatalogStaleSeconds ?? DEFAULT_STALE_SECONDS) * 1000;
    this.persistToolCatalog = opts.persistToolCatalog ?? true;
    this.maxResultBytes = resolveMaxResultBytes(
      opts.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
    );
    for (const c of connectors) {
      if ("handleRequest" in c) {
        throw new Error(
          `Connector "${c.id}" declares removed handleRequest. ` +
            "Move custom HTTP routes into the deployment's fetch handler.",
        );
      }
      if (!ID_RE.test(c.id)) {
        throw new Error(
          `Invalid connector id "${c.id}": must match ${ID_RE.source}`,
        );
      }
      if (this.connectors.has(c.id)) {
        throw new Error(`Duplicate connector id "${c.id}"`);
      }
      if (
        c.authScope !== undefined &&
        c.authScope !== "shared" &&
        c.authScope !== "personal"
      ) {
        throw new Error(
          `Invalid authScope on connector "${c.id}": expected "shared" or "personal"`,
        );
      }
      const configuredGuideSummary =
        typeof c.usageGuide === "object"
          ? normalizeGuideSummary(c.usageGuide.summary ?? "")
          : undefined;
      if (
        configuredGuideSummary !== undefined &&
        configuredGuideSummary.length > GUIDE_SUMMARY_LENGTH
      ) {
        throw new Error(
          `Connector "${c.id}" usageGuide.summary is ` +
            `${configuredGuideSummary.length} characters after whitespace ` +
            `normalization; the discovery bound is ${GUIDE_SUMMARY_LENGTH}. ` +
            "Shorten it or omit it to derive one.",
        );
      }
      this.connectors.set(c.id, c);
      if (c.callAdmission) {
        this.callAdmission.set(
          c.id,
          new ConnectorCallAdmissionController(c.id, c.callAdmission),
        );
      }
    }
    if (opts.constructionChecks !== false) {
      this.checkConventions(opts.logger);
      this.checkResultCaps(opts.logger, opts.maxResultBytes);
    }
  }

  personalRegistry(principalKey: string): Registry {
    const existing = this.personalRegistries.get(principalKey);
    if (existing) {
      this.personalRegistries.delete(principalKey);
      this.personalRegistries.set(principalKey, existing);
      return existing;
    }
    if (this.personalRegistries.size >= MAX_PERSONAL_REGISTRIES) {
      // Eviction must not reset a live rolling budget or orphan queued calls.
      // Nor may it drop catalog work in flight: a replacement for the same
      // principal starts with no generations and no mutation queue, so a
      // refresh the evicted registry finishes later would persist a listing
      // that a credential change on the replacement had just deleted.
      const idle = [...this.personalRegistries].find(([, candidate]) =>
        [...candidate.callAdmission.values()].every(admission => admission.isIdle()) &&
        candidate.catalogRefreshes.size === 0 &&
        candidate.catalogMutations.size === 0,
      );
      if (!idle) {
        throw new Error("Personal connector capacity is exhausted; retry after calls, rolling budgets, and catalog refreshes drain.");
      }
      idle[1].closeCallAdmission();
      this.personalRegistries.delete(idle[0]);
    }
    const registry = new Registry(
      this.configuredConnectors.filter(
        (connector) => connector.authScope === "personal",
      ),
      {
        ...this.opts,
        storage: namespaced(this.opts.storage, `principal:${principalKey}:`),
        credentialOwner: principalKey,
        constructionChecks: false,
      },
    );
    if (this.callAdmissionClosed) registry.closeCallAdmission();
    this.personalRegistries.set(principalKey, registry);
    return registry;
  }

  /** Build the only connector view an authenticated request receives. */
  scoped(scope: RegistryScope): RegistryView {
    const requested = scope.connectorIds === "all"
      ? new Set(this.connectors.keys())
      : new Set(scope.connectorIds);
    for (const id of requested) {
      if (!this.connectors.has(id)) {
        throw new Error(
          `Identity access resolver returned unknown connector "${id}"`,
        );
      }
    }
    return new ScopedRegistryView(this, requested, scope);
  }

  scopedStorage(subjectKey: string): KVStorage {
    return namespaced(this.opts.storage, `subject:${subjectKey}:`);
  }

  /**
   * A granted `connector.tool` address the live catalog does not contain is
   * unreachable, which is the fail-closed outcome; this only makes the
   * misconfiguration visible. Remote catalogs load lazily, so construction
   * cannot check it, and a catalog that drifts later cannot widen a grant.
   */
  noteAbsentGrant(connectorId: string, toolName: string): void {
    const key = `${connectorId}.${toolName}`;
    if (this.warnedAbsentGrants.has(key)) return;
    this.warnedAbsentGrants.add(key);
    if (this.warnedAbsentGrants.size > MAX_ABSENT_GRANT_WARNINGS) {
      const oldest = this.warnedAbsentGrants.values().next().value;
      if (oldest !== undefined) this.warnedAbsentGrants.delete(oldest);
    }
    // Grant names are operator data but may carry any non-control character;
    // quote them so a line terminator a log reader honours cannot forge a line.
    const quoted = JSON.stringify(key).replace(
      /[\u2028\u2029]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
    );
    this.opts.logger.warn(
      `connectorAccess grants ${quoted} but connector "${connectorId}" lists no such tool; the grant is unreachable`,
    );
  }

  private oauthHandoffKey(connectorId: string, stateHash: string): string {
    return `oauth-handoff:v1:${connectorId}:${stateHash}`;
  }

  async storeOAuthHandoff(
    connectorId: string,
    state: string,
    principalKey: string,
  ): Promise<void> {
    const key = this.oauthHandoffKey(connectorId, await sha256Hex(state));
    const existing = await this.opts.storage.get(key);
    if (existing && existing !== principalKey) {
      throw new Error(
        `Connector "${connectorId}" reused one OAuth state across principals`,
      );
    }
    await this.opts.storage.set(
      key,
      principalKey,
      { ttlSeconds: OAUTH_HANDOFF_TTL_SECONDS },
    );
  }

  async oauthCallbackView(
    connectorId: string,
    state: string | null,
  ): Promise<{
    registry: RegistryView;
    principalKey?: string;
  } | null> {
    const connector = this.connectors.get(connectorId);
    if (!connector) return null;
    if (connector.authScope !== "personal") return { registry: this };
    if (!state) return null;
    const principalKey = await this.opts.storage.get(
      this.oauthHandoffKey(connectorId, await sha256Hex(state)),
    );
    if (!principalKey) return null;
    return {
      registry: this.scoped({
        connectorIds: [connectorId],
        subjectKey: principalKey,
        principalKey,
      }),
      principalKey,
    };
  }

  async clearOAuthHandoff(
    connectorId: string,
    state: string | null,
  ): Promise<void> {
    if (!state) return;
    await this.opts.storage.delete(
      this.oauthHandoffKey(connectorId, await sha256Hex(state)),
    );
  }

  /**
   * Warn once per unusable result cap, at construction time — the same
   * "runs fine but is surely unintended" channel as the insecure-config
   * warnings in `createConnecta`. A rejected cap can't be honoured, and
   * honouring it *approximately* is exactly the inversion issue #32 is about,
   * so the value is dropped in favour of what it inherits and the operator is
   * told which one is actually in force.
   */
  private checkResultCaps(
    logger: Logger,
    configured: number | undefined,
  ): void {
    if (configured !== undefined && !isValidMaxResultBytes(configured)) {
      logger.warn(
        `[connecta] calls.maxResultBytes ${configured} is not a whole number of ` +
          `bytes >= ${MIN_MAX_RESULT_BYTES}: it would serve an empty, ` +
          "oversized, or unguarded result instead of truncating. Using the " +
          `default ${DEFAULT_MAX_RESULT_BYTES} instead.`,
      );
    }
    for (const c of this.connectors.values()) {
      if (
        c.maxResultBytes !== undefined &&
        !isValidMaxResultBytes(c.maxResultBytes)
      ) {
        // The number quoted here is `this.maxResultBytes` because that is
        // literally what a call falls back to: meta-tools reads the inherited
        // cap off `RegistryView.maxResultBytes`, so the warned value and the
        // runtime value are the same field rather than two copies of it.
        logger.warn(
          `[connecta] connector "${c.id}" sets maxResultBytes ` +
            `${c.maxResultBytes}, which is not a whole number of bytes >= ` +
            `${MIN_MAX_RESULT_BYTES}. Ignoring the override — the connector ` +
            `inherits the deployment-wide cap calls fall back to ` +
            `(${this.maxResultBytes}).`,
        );
      }
    }
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
    callOptions: ConnectorOperationOptions = {},
  ): ConnectorContext {
    const credentialConfig = this.connectors.get(id)?.credential;
    let credentialAccess: ConnectorContext["credential"];
    if (this.opts.credentialVault && credentialConfig) {
      const vault = this.opts.credentialVault;
      const readValues = async () => {
        const values = await vault.getAll(id, this.opts.credentialOwner);
        const shape = storedCredentialShape(credentialConfig, values);
        if (shape.state === "mismatch") {
          throw new ConnectorCallError("auth_required", shape.message);
        }
        return values;
      };
      credentialAccess = {
        get: async (field = "value") =>
          (await readValues())?.[field] ?? null,
        getAll: readValues,
      };
    }
    const context: ConnectorContext = {
      storage: namespaced(this.opts.storage, `conn:${id}:`),
      logger: this.opts.logger,
      baseUrl,
      ...(credentialAccess ? { credential: credentialAccess } : {}),
      requestScope,
      ...callOptions,
    };
    // Downstream OAuth state is sealed under the vault key, bound to this
    // connector and owner. The sealer rides beside the context, not on it.
    return this.opts.credentialVault
      ? attachOAuthSealer(
          context,
          vaultOAuthSealer(
            this.opts.credentialVault,
            id,
            this.opts.credentialOwner,
            this.opts.logger,
          ),
        )
      : context;
  }

  admitCall(
    id: string,
    input: { toolName: string; args: unknown; signal?: AbortSignal },
  ): Promise<CallAdmissionPermit> {
    const admission = this.callAdmission.get(id);
    if (admission) return admission.acquire(input);
    return Promise.resolve({ waitMs: 0, release() {} });
  }

  /** Connector totals across root and personal controllers; health removes ids. */
  callAdmissionSnapshot(): Record<string, ConnectorCallAdmissionSnapshot> {
    const snapshots = new Map<string, ConnectorCallAdmissionSnapshot[]>();
    for (const [id, admission] of this.callAdmission) {
      snapshots.set(id, [admission.snapshot()]);
    }
    for (const registry of this.personalRegistries.values()) {
      for (const [id, admission] of registry.callAdmission) {
        snapshots.get(id)?.push(admission.snapshot());
      }
    }
    return Object.fromEntries([...snapshots].map(([id, values]) => [
      id, aggregateCallAdmissionSnapshots(values),
    ]));
  }

  /**
   * Payload-free drift counts for the open health endpoint, so `connecta
   * doctor` can report a stale allowlist without asking any downstream
   * anything. Only connectors that ship a vetted manifest *and* have already
   * served a refresh *in this runtime* appear — a process or isolate that has
   * answered no catalog request yet honestly reports nothing, and drift is not
   * persisted the way the catalog itself is.
   *
   * Every report is rebuilt by {@link boundedCatalogDrift} on the way out:
   * `Connector.catalogDrift()` is the open plugin seam, and this snapshot is
   * serialized into an unauthenticated response.
   */
  catalogDriftSnapshot(): Record<string, CatalogDriftReport> {
    const snapshot: Record<string, CatalogDriftReport> = {};
    for (const connector of this.connectors.values()) {
      const report = boundedCatalogDrift(connector.catalogDrift?.());
      if (report) snapshot[connector.id] = report;
    }
    return snapshot;
  }

  /**
   * Turn the observation a refresh just took into at most one activity event.
   *
   * Emitted on change rather than on every refresh: an identical report every
   * TTL is a heartbeat, not news, and the current counts are already on
   * connector status. A first observation that is clean is not an event
   * either — nothing moved — but a later return to clean is, because "the
   * drift is gone" is exactly what an operator watching the timeline is
   * waiting for.
   */
  private observeCatalogDrift(connector: Connector): void {
    const report = boundedCatalogDrift(connector.catalogDrift?.());
    if (!report) return;
    const previous = this.reportedDrift.get(connector.id);
    // Bounded counts, so a seam returning NaN cannot make every refresh look
    // like a change and emit an event per refresh forever.
    const counts: CatalogDriftCounts = {
      unclassifiedTools: report.unclassifiedTools,
      unservedTools: report.unservedTools,
      annotationConflicts: report.annotationConflicts,
      schemaChanges: report.schemaChanges,
    };
    const unchanged =
      previous !== undefined &&
      previous.unclassifiedTools === counts.unclassifiedTools &&
      previous.unservedTools === counts.unservedTools &&
      previous.annotationConflicts === counts.annotationConflicts &&
      previous.schemaChanges === counts.schemaChanges;
    if (unchanged) return;
    const clean =
      counts.unclassifiedTools === 0 &&
      counts.unservedTools === 0 &&
      counts.annotationConflicts === 0 &&
      counts.schemaChanges === 0;
    this.reportedDrift.set(connector.id, counts);
    if (previous === undefined && clean) return;
    this.opts.catalogDriftActivity?.recordDrift?.(
      this.opts.catalogDriftActivity
        ? { ...this.opts.catalogDriftActivity, logger: this.opts.logger }
        : undefined,
      { connectorId: connector.id, ...counts },
    );
  }

  /** Reject queued/future downstream admission; active permits release safely. */
  closeCallAdmission(): void {
    this.callAdmissionClosed = true;
    for (const admission of this.callAdmission.values()) admission.close();
    for (const registry of this.personalRegistries.values()) registry.closeCallAdmission();
  }

  /**
   * Reserve capacity and write one ASCII paging envelope in this runtime.
   *
   * `chunks[0]` lands on `<prefix><key>` and `chunks[n]` on `<prefix><key>#<n>`
   * — the layout get_result reads back, so a page fetches only the chunks it
   * covers instead of the whole stored result (issue #540). Chunking is a
   * read-cost decision, not a capacity one: however many keys an envelope
   * occupies, it is one stash entry charged its total ASCII length.
   */
  stashResult(key: string, chunks: readonly string[], ttlSeconds: number, prefix = "results:"): Promise<boolean> {
    // The fiber runs synchronously up to its first storage call. With nothing
    // expired to reclaim, that is the first chunk write, after the
    // reservation: a concurrent stash already sees this one's charge.
    return runOnPartition(Effect.gen({ self: this }, function* () {
      const maxBytes = this.opts.results?.maxStashBytes ?? 8 * 1024 * 1024;
      const maxEntries = this.opts.results?.maxStashEntries ?? 64;
      // The paging envelope is ASCII, so its string length is its stored byte count.
      const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (bytes > maxBytes || maxEntries === 0) return false;
      const now = yield* Clock.currentTimeMillis;
      for (const [oldKey, entry] of this.resultStash) {
        if (entry.busy || entry.expiresAt > now) continue;
        entry.busy = true;
        // TTL alone cannot reclaim a lazy backend. Keep the charge until
        // deletion succeeds, including writes which persisted before throwing;
        // a failed delete fails this stash, and the entry waits for the next.
        yield* Effect.gen({ self: this }, function* () {
          for (const staleKey of entry.keys) yield* storageDelete(staleKey);
          this.resultStash.delete(oldKey);
          this.resultStashBytes -= entry.bytes;
        }).pipe(Effect.ensuring(Effect.sync(() => { entry.busy = false; })));
      }
      if (this.resultStash.size >= maxEntries || this.resultStashBytes + bytes > maxBytes) return false;
      const fullKey = prefix + key;
      const keys = chunks.map((_, index) => index === 0 ? fullKey : `${fullKey}#${index}`);
      const entry = { keys, bytes, expiresAt: Infinity, busy: true };
      this.resultStash.set(fullKey, entry);
      this.resultStashBytes += bytes;
      // Trailing chunks first: the header chunk is what makes an id readable, so
      // a write that fails midway leaves no envelope pointing at absent chunks.
      yield* Effect.gen(function* () {
        for (let index = keys.length - 1; index >= 0; index--) {
          yield* storageSet(keys[index]!, chunks[index]!, { ttlSeconds });
        }
      }).pipe(
        // A failed write expires at once, still charged, so the next stash
        // reclaims every key it may have persisted before failing.
        Effect.onExit((exit) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((writtenAt) => {
              entry.expiresAt = Exit.isSuccess(exit)
                ? writtenAt + ttlSeconds * 1000
                : 0;
              entry.busy = false;
            }),
          ),
        ),
      );
      return true;
    }), this.opts);
  }

  /**
   * Storage namespaced to the meta-tool result store (`results:` prefix), kept
   * separate from any connector's `conn:<id>:` namespace. Backs get_result.
   */
  resultsStorage(): KVStorage {
    return namespaced(this.opts.storage, "results:");
  }

  credentialUiAvailable(): boolean { return Boolean(this.opts.credentialUi); }

  async bindOAuthHandoff(): Promise<void> {
    // Shared OAuth already resolves in deployment-wide connector storage.
  }

  observedOutputSchema(
    connectorId: string,
    definition: ToolDef,
  ): ToolDef["outputSchema"] | undefined {
    return this.observedOutputSchemas.get(connectorId, definition);
  }

  observeOutputShape(
    connectorId: string,
    definition: ToolDef,
    value: unknown,
  ): void {
    this.observedOutputSchemas.observe(connectorId, definition, value);
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

  private catalogChunkKey(id: string, revision: string, index: number): string {
    return `${this.catalogKey(id)}:chunk:${revision}:${index}`;
  }

  private validCatalogTools(value: unknown[]): value is ToolDef[] {
    return value.every(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        typeof (tool as ToolDef).name === "string",
    );
  }

  private validCatalogManifest(
    value: unknown,
  ): PersistedCatalogManifest | null {
    if (!value || typeof value !== "object") return null;
    const manifest = value as Partial<PersistedCatalogManifest>;
    const maxChunks =
      Math.ceil(MAX_SERIALIZED_CATALOG_BYTES / MAX_CATALOG_CHUNK_BYTES) + 1;
    if (
      manifest.version !== 2 ||
      typeof manifest.revision !== "string" ||
      !/^sha256:[0-9]{1,8}:[0-9a-f]{64}$/.test(manifest.revision) ||
      !Number.isInteger(manifest.toolCount) ||
      manifest.toolCount! < 0 ||
      manifest.toolCount! > MAX_CATALOG_TOOLS ||
      !Number.isInteger(manifest.byteCount) ||
      manifest.byteCount! < 2 ||
      manifest.byteCount! > MAX_SERIALIZED_CATALOG_BYTES ||
      !manifest.revision.startsWith(`sha256:${manifest.byteCount}:`) ||
      !Number.isInteger(manifest.chunkCount) ||
      manifest.chunkCount! < 1 ||
      manifest.chunkCount! > maxChunks ||
      typeof manifest.fetchedAt !== "number" ||
      typeof manifest.expiresAt !== "number" ||
      typeof manifest.staleUntil !== "number"
    ) {
      return null;
    }
    return manifest as PersistedCatalogManifest;
  }

  private parseCatalogManifest(
    raw: string | null,
  ): PersistedCatalogManifest | null {
    if (!raw) return null;
    try {
      return this.validCatalogManifest(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private splitCatalogChunks(snapshot: CatalogSnapshot): string[] {
    const chunks: string[] = [];
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    });
    let offset = 0;
    while (offset < snapshot.serializedBytes.byteLength) {
      let end = Math.min(
        offset + MAX_CATALOG_CHUNK_BYTES,
        snapshot.serializedBytes.byteLength,
      );
      // Move a boundary that landed inside a multibyte UTF-8 sequence back to
      // the next character start. Every stored string then remains valid UTF-8.
      while (
        end < snapshot.serializedBytes.byteLength &&
        ((snapshot.serializedBytes[end] ?? 0) & 0xc0) === 0x80
      ) {
        end--;
      }
      chunks.push(
        decoder.decode(snapshot.serializedBytes.subarray(offset, end)),
      );
      offset = end;
    }
    return chunks;
  }

  // The persisted catalog's one reader: the manifest at `catalog:<id>`, then
  // the chunks it names. A storage failure fails the effect, and the caller
  // logs it; a manifest or chunk that is invalid, missing, torn, or does not
  // match its fingerprint is logged here and read as no catalog, because a
  // catalog is complete or it is nothing.
  private readCatalog(
    id: string,
    now: number,
  ): Effect.Effect<PersistedCatalog | null, unknown, Storage | LoggerService> {
    return Effect.gen({ self: this }, function* () {
      const raw = yield* storageGet(this.catalogKey(id));
      if (!raw) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }

      const logger = yield* LoggerService;
      const manifest = this.validCatalogManifest(parsed);
      if (!manifest) {
        logger.warn(
          `[connecta] connector "${id}" catalog manifest is invalid; ignoring persisted catalog.`,
        );
        return null;
      }
      if (manifest.staleUntil <= now) return null;

      const chunkReads = yield* forEachChunk(
        Array.from({ length: manifest.chunkCount }, (_, index) => index),
        (index) => storageGet(this.catalogChunkKey(id, manifest.revision, index)),
      );
      const chunks: string[] = [];
      let chunkBytes = 0;
      for (const [index, read] of chunkReads.entries()) {
        if (Result.isFailure(read)) return yield* Effect.fail(read.failure);
        const chunk = read.success;
        if (chunk === null) {
          logger.warn(
            `[connecta] connector "${id}" catalog chunk ${index + 1}/${manifest.chunkCount} is missing; ignoring persisted catalog.`,
          );
          return null;
        }
        const byteLength = encoder.encode(chunk).byteLength;
        chunkBytes += byteLength;
        if (
          byteLength > MAX_CATALOG_CHUNK_BYTES ||
          chunkBytes > manifest.byteCount
        ) {
          logger.warn(
            `[connecta] connector "${id}" catalog chunk bounds do not match its manifest; ignoring persisted catalog.`,
          );
          return null;
        }
        chunks.push(chunk);
      }

      const serializedTools = chunks.join("");
      const stored = yield* Effect.tryPromise({
        try: () => fingerprintSerializedCatalog(serializedTools),
        catch: (error) => error,
      });
      if (
        stored.byteLength !== manifest.byteCount ||
        stored.fingerprint !== manifest.revision
      ) {
        logger.warn(
          `[connecta] connector "${id}" catalog fingerprint mismatch; ignoring persisted catalog.`,
        );
        return null;
      }

      let tools: unknown;
      try {
        tools = JSON.parse(serializedTools);
      } catch {
        logger.warn(
          `[connecta] connector "${id}" catalog chunks are torn; ignoring persisted catalog.`,
        );
        return null;
      }
      if (!Array.isArray(tools) || !this.validCatalogTools(tools)) {
        logger.warn(
          `[connecta] connector "${id}" catalog chunks contain invalid tools; ignoring persisted catalog.`,
        );
        return null;
      }
      if (tools.length !== manifest.toolCount) {
        logger.warn(
          `[connecta] connector "${id}" catalog tool count does not match its manifest; ignoring persisted catalog.`,
        );
        return null;
      }
      return {
        tools,
        fingerprint: stored.fingerprint,
        fetchedAt: manifest.fetchedAt,
        expiresAt: manifest.expiresAt,
        staleUntil: manifest.staleUntil,
      };
    });
  }

  // Persist one complete catalog: every chunk, then the manifest. A snapshot
  // only reaches here after the tool and byte ceilings accepted it whole.
  private storeCatalog(
    id: string,
    snapshot: CatalogSnapshot,
  ): Effect.Effect<void, unknown, Storage> {
    return Effect.gen({ self: this }, function* () {
      if (!this.persistToolCatalog) return;
      const fetchedAt = yield* Clock.currentTimeMillis;
      const expiresAt = fetchedAt + this.ttlMs;
      const staleUntil = expiresAt + this.staleMs;
      const ttlSeconds = Math.max(
        60,
        Math.ceil((this.ttlMs + this.staleMs) / 1000),
      );
      const chunks = this.splitCatalogChunks(snapshot);
      const chunkWrites = yield* forEachChunk(chunks, (chunk, index) =>
        storageSet(this.catalogChunkKey(id, snapshot.fingerprint, index), chunk, {
          ttlSeconds: ttlSeconds + CATALOG_CHUNK_TTL_GRACE_SECONDS,
        }),
      );
      for (const write of chunkWrites) {
        if (Result.isFailure(write)) return yield* Effect.fail(write.failure);
      }
      // The manifest is the only publication point. A failed/partial chunk write
      // therefore leaves the previous manifest authoritative (or no catalog);
      // unreachable chunks carry a bounded TTL and require no prefix scan.
      const manifest: PersistedCatalogManifest = {
        version: 2,
        revision: snapshot.fingerprint,
        toolCount: snapshot.tools.length,
        byteCount: snapshot.serializedBytes.byteLength,
        chunkCount: chunks.length,
        fetchedAt,
        expiresAt,
        staleUntil,
      };
      yield* storageSet(this.catalogKey(id), JSON.stringify(manifest), {
        ttlSeconds,
      });
    });
  }

  // Remove the persisted catalog: the manifest always, then the chunks it
  // names. Every delete is attempted; the effect fails with the manifest
  // read's error first, then the first chunk delete's.
  private deleteCatalog(id: string): Effect.Effect<void, unknown, Storage> {
    return Effect.gen({ self: this }, function* () {
      const read = yield* Effect.result(storageGet(this.catalogKey(id)));
      const manifest = Result.isSuccess(read)
        ? this.parseCatalogManifest(read.success)
        : null;
      // The root is authoritative, so attempt its deletion even when the
      // best-effort read needed for physical chunk cleanup failed.
      yield* storageDelete(this.catalogKey(id));
      let firstError: Result.Failure<void, unknown> | undefined;
      for (let index = 0; manifest && index < manifest.chunkCount; index++) {
        const deleted = yield* Effect.result(
          storageDelete(this.catalogChunkKey(id, manifest.revision, index)),
        );
        if (Result.isFailure(deleted)) firstError ??= deleted;
      }
      if (Result.isFailure(read)) return yield* Effect.fail(read.failure);
      if (firstError) return yield* Effect.fail(firstError.failure);
    });
  }

  private catalogGeneration(id: string): number {
    return this.catalogGenerations.get(id) ?? 0;
  }

  private advanceCatalogGeneration(id: string): void {
    this.catalogGenerations.set(id, this.catalogGeneration(id) + 1);
  }

  /**
   * Keep this isolate's writes and invalidations ordered. Without the queue, an
   * old refresh can finish its storage.set after a credential change deletes
   * the catalog and resurrect the pre-change listing.
   */
  private async enqueueCatalogMutation(
    id: string,
    operation: Effect.Effect<void, never, Storage | LoggerService>,
  ): Promise<void> {
    // Mutations run in arrival order, each taking its turn from the one
    // queued before it. That one may belong to another request, and
    // completing a Deferred resumes its waiters inside the completing call,
    // so the wait is an edge of its own and this request's storage work
    // starts only after it. (Effect's Semaphore would do neither: it resumes
    // a waiter from the releasing fiber, and a newcomer can take the permit
    // before a waiter that queued earlier.) An operation logs its own storage
    // failure, so a turn always ends.
    const previous = this.catalogMutations.get(id);
    const turn = Deferred.makeUnsafe<void>();
    this.catalogMutations.set(id, turn);
    try {
      if (previous) await runEdge(Deferred.await(previous));
      await runOnPartition(operation, this.opts);
    } finally {
      if (this.catalogMutations.get(id) === turn) {
        this.catalogMutations.delete(id);
      }
      Deferred.doneUnsafe(turn, Exit.void);
    }
  }

  private async refreshToolsWithContext(
    id: string,
    connector: Connector,
    ctx: ConnectorContext,
    skipPublicationWhenAborted = false,
    flight?: CatalogRefreshFlight,
  ): Promise<ToolDef[]> {
    const generation = this.catalogGeneration(id);
    const tools = await connector.listTools(ctx);
    // The listing a maintained proxy just served is also the only catalog
    // comparison connecta ever makes. It rides this refresh whether or not the
    // result reaches a cache, because what drifted drifted.
    this.observeCatalogDrift(connector);
    // A deferred deadline may close the owned scope while a connector that
    // ignores abort is still listing. The completed list remains a valid drift
    // observation, but must not overwrite a newer same-generation refresh.
    // Blocking callers do not set this flag and retain their prior publication
    // behavior when an inbound abort races a completed listing.
    if (skipPublicationWhenAborted && ctx.signal?.aborted) return tools;
    // The caller that began this refresh may still use its result, but a
    // credential/OAuth change that landed while listTools was in flight, or a
    // flight abandoned while it listed, means the listing must not enter
    // either shared cache layer.
    if (!this.mayPublish(id, generation, flight)) return tools;
    if (tools.length > MAX_CATALOG_TOOLS) {
      const message =
        `Connector "${id}" returned ${tools.length} tools, over the ` +
        `${MAX_CATALOG_TOOLS}-tool catalog ceiling; refusing the complete catalog.`;
      this.opts.logger.warn(`[connecta] ${message}`);
      throw new Error(message);
    }
    const previous = this.cache.get(id);
    const snapshot = await snapshotCatalog(tools);
    if (
      !this.mayPublish(id, generation, flight) ||
      (skipPublicationWhenAborted && ctx.signal?.aborted)
    ) {
      return tools;
    }
    if (snapshot.serializedBytes.byteLength > MAX_SERIALIZED_CATALOG_BYTES) {
      const message =
        `Connector "${id}" returned a ${snapshot.serializedBytes.byteLength}-byte ` +
        `serialized catalog, over the ${MAX_SERIALIZED_CATALOG_BYTES}-byte ceiling; ` +
        "refusing the complete catalog.";
      this.opts.logger.warn(`[connecta] ${message}`);
      throw new Error(message);
    }
    const now = Date.now();
    const catalogChanged =
      !previous || previous.fingerprint !== snapshot.fingerprint;
    const shouldPersist =
      catalogChanged ||
      (previous !== undefined && previous.exp <= now) ||
      this.invalidated.has(id);
    this.cache.set(id, {
      tools,
      fingerprint: snapshot.fingerprint,
      exp: now + this.ttlMs,
      staleUntil: now + this.ttlMs + this.staleMs,
    });
    this.invalidated.delete(id);
    if (shouldPersist) {
      await this.enqueueCatalogMutation(
        id,
        // The generation is read when the turn comes, not when it is queued:
        // an invalidation queued meanwhile has already deleted the catalog.
        warnOnFailure(
          Effect.suspend(() =>
            generation === this.catalogGeneration(id)
              ? this.storeCatalog(id, snapshot)
              : Effect.void,
          ),
          `connector "${id}" catalog persistence failed`,
        ),
      );
    }
    return tools;
  }

  /**
   * Whether a refresh may still enter the shared cache layers: its generation
   * is current, and the flight it runs in has been neither abandoned nor
   * outlived its bound. Asked at each publication point, since listing and
   * snapshotting both yield, and a late result must never overwrite the one a
   * fresh attempt published in the meantime.
   */
  private mayPublish(
    id: string,
    generation: number,
    flight: CatalogRefreshFlight | undefined,
  ): boolean {
    return (
      generation === this.catalogGeneration(id) &&
      (!flight || (!flight.abandoned && Date.now() < flight.abandonAt))
    );
  }

  /**
   * Publish one shared refresh before starting its connector work. The first
   * caller owns the scope and signal, and the flight lives `boundMs` from now
   * at most; every later caller joins the result without gaining access to
   * that context. A flight found past its bound is abandoned here, and this
   * caller starts the fresh attempt.
   */
  private startCatalogRefresh(
    id: string,
    generation: number,
    boundMs: number,
    work: (flight: CatalogRefreshFlight) => Effect.Effect<ToolDef[], unknown>,
    ownerLeft: () => boolean = () => false,
  ): {
    flight: CatalogRefreshFlight;
    // Present only for the caller that published the flight, which must run
    // it, in its own request, at once.
    owner?: Effect.Effect<ToolDef[], unknown>;
  } {
    const existing = this.catalogRefreshes.get(id);
    if (existing?.generation === generation) {
      if (Date.now() < existing.abandonAt) return { flight: existing };
      this.abandonCatalogRefresh(id, existing);
    }
    const flight: CatalogRefreshFlight = {
      generation,
      abandonAt: Date.now() + boundMs,
      abandoned: false,
      outcome: Deferred.makeUnsafe(),
    };
    this.catalogRefreshes.set(id, flight);
    const owner = Effect.onExit(work(flight), (exit) =>
      Effect.sync(() => {
        if (this.catalogRefreshes.get(id) === flight) {
          this.catalogRefreshes.delete(id);
        }
        // A failure that was the owner's alone is no answer for anyone
        // else: its own cancellation (its signal, read here in its own
        // request), or anything that arrives once the flight is past its
        // bound. Joiners make a fresh attempt under their own deadlines.
        const ownersAlone =
          Exit.isFailure(exit) &&
          (flight.abandoned ||
            Date.now() >= flight.abandonAt ||
            ownerLeft());
        // Last, because joined fibers resume inside this call.
        Deferred.doneUnsafe(
          flight.outcome,
          ownersAlone ? Exit.fail(new AbandonedCatalogRefresh(id)) : exit,
        );
      }),
    );
    return { flight, owner };
  }

  /**
   * Give up on a flight that outlived its bound. Later readers start a fresh
   * attempt, its joiners are told to, and nothing its owner lists from now on
   * reaches a cache. The owner's work is left alone: it belongs to another
   * request, which nothing here may reach into, and it can no longer publish.
   */
  private abandonCatalogRefresh(
    id: string,
    flight: CatalogRefreshFlight,
  ): void {
    if (flight.abandoned) return;
    flight.abandoned = true;
    if (this.catalogRefreshes.get(id) === flight) {
      this.catalogRefreshes.delete(id);
    }
    this.opts.logger.warn(
      `[connecta] connector "${id}" catalog refresh outlived its bound; abandoning it for a fresh attempt.`,
    );
    Deferred.doneUnsafe(
      flight.outcome,
      Exit.fail(new AbandonedCatalogRefresh(id)),
    );
  }

  /**
   * Wait on another caller's flight, no longer than its bound. Succeeds with
   * its tools, or with `undefined` when it will not answer for this caller —
   * past its bound, when this waiter abandons it, or failed for its owner
   * alone — so the caller makes a fresh attempt. The timer is this waiter's
   * own: on workerd it is what keeps a request that waits on another alive,
   * and bounded.
   */
  private joinCatalogRefresh(
    id: string,
    flight: CatalogRefreshFlight,
  ): Effect.Effect<ToolDef[] | undefined, unknown> {
    return Effect.suspend(() =>
      Deferred.await(flight.outcome).pipe(
        Effect.timeoutOption(
          Duration.millis(Math.max(0, flight.abandonAt - Date.now())),
        ),
        Effect.flatMap((joined) =>
          Option.isSome(joined)
            ? Effect.succeed<ToolDef[] | undefined>(joined.value)
            : Effect.sync(() => {
                this.abandonCatalogRefresh(id, flight);
                return undefined;
              }),
        ),
        Effect.catch((error) =>
          error instanceof AbandonedCatalogRefresh
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      ),
    );
  }

  /** Force a live listTools refresh and replace both catalog cache layers. */
  private async refreshTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    if (connector.staticTools) return connector.staticTools;
    // A flight lives as long as its owner will wait for it. Past that, the
    // owner may have answered and gone, and on workerd its I/O went with it.
    const boundMs =
      normalizeTimeoutMs(callOptions.timeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
    for (;;) {
      const { flight, owner } = this.startCatalogRefresh(
        id,
        this.catalogGeneration(id),
        boundMs,
        (flight) =>
          Effect.tryPromise({
            try: () =>
              this.refreshToolsWithContext(
                id,
                connector,
                this.contextFor(id, baseUrl, requestScope, callOptions),
                false,
                flight,
              ),
            catch: (error) => error,
          }),
        () => callOptions.signal?.aborted === true,
      );
      // The owner lists in its own request. A joiner waits through an edge of
      // its own, under its own signal, and whatever it does with the tools
      // happens after that, back in its request (see "Effect inside" in
      // documentation/architecture.md). A flight that will not answer for it
      // sends it round again, to join a fresh attempt or to own one.
      if (owner) return runEdge(owner);
      const joined = await runEdge(this.joinCatalogRefresh(id, flight), {
        signal: callOptions.signal,
      });
      if (joined) return joined;
    }
  }

  private observeCatalogAccess(
    id: string,
    state: CatalogAccessObservation["state"],
  ): void {
    this.catalogAccess.set(id, {
      state,
      observedAt: new Date().toISOString(),
    });
  }

  /**
   * Start or join one shared refresh. A newly deferred task owns its scope,
   * deadline, and teardown; no inbound signal or request scope crosses into it.
   */
  private deferCatalogRefresh(
    id: string,
    baseUrl: string,
    expectedGeneration: number,
    options: CatalogReadOptions,
  ): void {
    const connector = this.connectors.get(id);
    const defer = options.defer;
    if (!connector || connector.staticTools || !defer) return;
    // The refresh this request starts, if none of this generation is live.
    // Its scope is closed however it ends, deadline included, before the
    // flight completes.
    const refresh = (flight: CatalogRefreshFlight) => withDeadlineEffect(
      (signal) =>
        Effect.gen({ self: this }, function* () {
          const current = this.cache.get(id);
          if (current && current.exp > Date.now()) return current.tools;
          if (
            expectedGeneration !== this.catalogGeneration(id) ||
            this.invalidated.has(id)
          ) {
            return yield* Effect.fail(
              new Error(
                `Deferred catalog refresh of "${id}" was invalidated before it started.`,
              ),
            );
          }
          const ctx = this.contextFor(id, baseUrl, {}, {
            signal,
            timeoutMs: options.refreshTimeoutMs,
          });
          yield* closeScopeOnExit(connector, ctx, defer);
          return yield* Effect.tryPromise({
            try: () =>
              this.refreshToolsWithContext(id, connector, ctx, true, flight),
            catch: (error) => error,
          });
        }),
      {
        timeoutMs: options.refreshTimeoutMs,
        timeoutError: new Error(
          `deferred catalog refresh of "${id}" timed out after ${options.refreshTimeoutMs}ms`,
        ),
      },
    );
    const logFailure = (err: unknown) => {
      this.opts.logger.warn(
        `[connecta] connector "${id}" deferred catalog refresh failed: ${msg(err)}`,
      );
    };
    const { flight, owner } = this.startCatalogRefresh(
      id,
      expectedGeneration,
      options.refreshTimeoutMs,
      (flight) => Effect.scoped(refresh(flight)),
    );
    if (owner) {
      // Runs past this response, under the runtime's waitUntil below.
      flight.deferredTail = detach(
        Effect.catchCause(owner, (cause) =>
          Effect.sync(() => logFailure(Cause.squash(cause))),
        ),
      );
    }
    // A stale reader that joins a blocking refresh logs its failure once for
    // every reader after it, and waits through an edge of its own, no longer
    // than the flight's bound.
    flight.deferredTail ??= runEdge(this.joinCatalogRefresh(id, flight)).then(
      () => {},
      logFailure,
    );
    try {
      defer(flight.deferredTail);
    } catch (err) {
      this.opts.logger.warn(
        `[connecta] connector "${id}" deferred catalog refresh could not attach to the runtime: ${msg(err)}`,
      );
    }
  }

  /** Cached listTools with in-memory + persisted serializable catalog layers. */
  private async loadTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    readOptions?: CatalogReadOptions,
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    if (connector.staticTools) return connector.staticTools;

    const now = Date.now();
    const requestGeneration = this.catalogGeneration(id);
    const hit = this.cache.get(id);
    if (hit && hit.exp > now) {
      if (readOptions?.defer) this.observeCatalogAccess(id, "fresh");
      return hit.tools;
    }

    let stale =
      hit && hit.staleUntil > now
        ? { tools: hit.tools, staleUntil: hit.staleUntil }
        : undefined;
    if (this.persistToolCatalog && !this.invalidated.has(id)) {
      const generation = this.catalogGeneration(id);
      let persisted: PersistedCatalog | null = null;
      try {
        persisted = await runOnPartition(
          this.readCatalog(id, now),
          this.opts,
        );
      } catch (err) {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog read failed: ${msg(err)}`,
        );
      }
      if (generation !== this.catalogGeneration(id)) {
        persisted = null;
        stale = undefined;
      }
      // Storage can yield while another request finishes a live refresh. Read
      // the shared cache again before an older manifest gets any authority.
      // The candidate with the later fresh deadline wins; both candidates have
      // already passed their own fingerprint and completeness checks.
      const reconciledAt = Date.now();
      const current = this.cache.get(id);
      const usableCurrent =
        current && current.staleUntil > reconciledAt ? current : undefined;
      if (usableCurrent) {
        stale = {
          tools: usableCurrent.tools,
          staleUntil: usableCurrent.staleUntil,
        };
        if (usableCurrent.exp > reconciledAt) {
          if (readOptions?.defer) this.observeCatalogAccess(id, "fresh");
          return usableCurrent.tools;
        }
      }
      if (
        persisted &&
        persisted.staleUntil > reconciledAt &&
        (!usableCurrent || persisted.expiresAt > usableCurrent.exp)
      ) {
        this.cache.set(id, {
          tools: persisted.tools,
          fingerprint: persisted.fingerprint,
          exp: persisted.expiresAt,
          staleUntil: persisted.staleUntil,
        });
        if (persisted.expiresAt > reconciledAt) {
          if (readOptions?.defer) this.observeCatalogAccess(id, "fresh");
          return persisted.tools;
        }
        stale = {
          tools: persisted.tools,
          staleUntil: persisted.staleUntil,
        };
      }
    }

    if (
      stale &&
      stale.staleUntil > Date.now() &&
      readOptions?.defer &&
      requestGeneration === this.catalogGeneration(id) &&
      !this.invalidated.has(id)
    ) {
      this.deferCatalogRefresh(
        id,
        baseUrl,
        requestGeneration,
        readOptions,
      );
      // Invalidation can land synchronously while the refresh is attached.
      // Repeat the authority check at the exact stale publication point.
      if (
        stale.staleUntil > Date.now() &&
        requestGeneration === this.catalogGeneration(id) &&
        !this.invalidated.has(id)
      ) {
        this.observeCatalogAccess(id, "stale");
        return stale.tools;
      }
    }

    try {
      const tools = await this.refreshTools(
        id,
        baseUrl,
        requestScope,
        callOptions,
      );
      if (readOptions?.defer) this.observeCatalogAccess(id, "fresh");
      return tools;
    } catch (err) {
      if (
        stale &&
        stale.staleUntil > Date.now() &&
        requestGeneration === this.catalogGeneration(id) &&
        !this.invalidated.has(id)
      ) {
        if (readOptions?.defer) this.observeCatalogAccess(id, "stale");
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog refresh failed; serving stale catalog: ${msg(err)}`,
        );
        return stale.tools;
      }
      throw err;
    }
  }

  /**
   * Coalesce one connector's catalog traversal inside one inbound request. The
   * WeakMap neither roots the request scope nor lets its connector context
   * escape into another request; settled entries are also removed eagerly.
   *
   * The read owns its signal, and each caller waits under its own: one that
   * is cancelled while others wait leaves with its own failure, and the read
   * is cancelled only when every caller has gone (src/runtime/shared-read.ts).
   *
   * The deployment-wide flight below this layer coalesces the actual live
   * refresh across requests. Its owner's context governs the listing, and its
   * owner's deadline bounds it; later callers join only its result, never its
   * request scope, and a failure that was the owner's alone sends them to a
   * fresh attempt rather than to them.
   */
  async getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    readOptions?: CatalogReadOptions,
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    if (connector.staticTools) return connector.staticTools;
    if (!requestScope) {
      return this.loadTools(
        id,
        baseUrl,
        requestScope,
        callOptions,
        readOptions,
      );
    }

    let loads = this.requestCatalogLoads.get(requestScope);
    if (!loads) {
      loads = new Map();
      this.requestCatalogLoads.set(requestScope, loads);
    }
    const requestLoads = loads;
    let load = requestLoads.get(id);
    if (!load) {
      const started: SharedRead<ToolDef[]> = new SharedRead(
        (signal) =>
          this.loadTools(
            id,
            baseUrl,
            requestScope,
            { ...callOptions, signal },
            readOptions,
          ),
        // Settled or cancelled, the read leaves the map before any caller
        // resumes, so the next one asks the caches afresh.
        () => {
          if (requestLoads.get(id) === started) requestLoads.delete(id);
          if (requestLoads.size === 0) {
            this.requestCatalogLoads.delete(requestScope);
          }
        },
      );
      requestLoads.set(id, started);
      load = started;
    }
    return runEdge(load.join(callOptions.signal));
  }

  async credentialDriftFor(id: string): Promise<string | undefined> {
    const credential = this.connectors.get(id)?.credential;
    const vault = this.opts.credentialVault;
    if (!credential || !vault) return undefined;
    try {
      const values = await vault.getAll(id, this.opts.credentialOwner);
      const shape = storedCredentialShape(credential, values);
      return shape.state === "mismatch" ? shape.message : undefined;
    } catch (error) {
      this.opts.logger.warn(
        `[connecta] connector "${id}" credential shape read failed: ${msg(error)}`,
      );
      return undefined;
    }
  }

  /** Best-effort connector status for the operator UI. */
  async statusFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
    callOptions: ConnectorOperationOptions = {},
  ): Promise<ConnectorStatus> {
    const connector = this.connectors.get(id);
    if (!connector) return { state: "error", message: "Unknown connector" };
    const ctx = this.contextFor(id, baseUrl, requestScope, callOptions);
    // Whatever the state turns out to be, it carries the drift the last
    // refresh saw. Reading it is a lookup, not a probe: a connector that has
    // listed nothing yet reports nothing, and status never lists on its own to
    // make the field appear.
    // The report is rebuilt rather than spread through: what the seam returned
    // is third-party output, and status is read by the operator UI and copied
    // into responses.
    const withObservations = (status: ConnectorStatus): ConnectorStatus => {
      const report = boundedCatalogDrift(connector.catalogDrift?.());
      const access = this.catalogAccess.get(id);
      // Connector.status is an open plugin seam. Rebuild its public fields so
      // a connector cannot smuggle payload through either registry-owned
      // observation when this runtime has not made one.
      const boundedStatus: ConnectorStatus = {
        state: status.state,
        ...(status.message !== undefined ? { message: status.message } : {}),
      };
      return {
        ...boundedStatus,
        ...(report ? { catalogDrift: report } : {}),
        ...(access ? { catalogAccess: { ...access } } : {}),
      };
    };
    if (connector.status) {
      try {
        return withObservations(await connector.status(ctx));
      } catch (err) {
        return withObservations({ state: "error", message: msg(err) });
      }
    }
    try {
      await this.getTools(id, baseUrl, requestScope, callOptions);
      return withObservations({ state: "ok" });
    } catch (err) {
      return withObservations({ state: "error", message: msg(err) });
    }
  }

  private markCatalogInvalid(id: string): void {
    this.advanceCatalogGeneration(id);
    this.cache.delete(id);
    this.invalidated.add(id);
  }

  private deleteStoredCatalog(id: string): Promise<void> {
    return this.enqueueCatalogMutation(
      id,
      warnOnFailure(
        this.deleteCatalog(id),
        `connector "${id}" catalog invalidation failed`,
      ),
    );
  }

  /** Drop a connector's cached tool list (e.g. after auth completes). */
  invalidate(id: string): void {
    this.markCatalogInvalid(id);
    if (this.persistToolCatalog) void this.deleteStoredCatalog(id);
  }

  /** Drop both in-memory and persisted tool catalogs. */
  async invalidateStored(id: string): Promise<void> {
    this.markCatalogInvalid(id);
    if (this.persistToolCatalog) await this.deleteStoredCatalog(id);
  }
}

class ScopedRegistryView implements RegistryView {
  readonly maxResultBytes: number;
  private readonly personal: Registry | undefined;

  constructor(
    private readonly root: Registry,
    private readonly allowed: ReadonlySet<string>,
    private readonly scope: RegistryScope,
  ) {
    this.maxResultBytes = root.maxResultBytes;
    this.personal = scope.principalKey
      ? root.personalRegistry(scope.principalKey)
      : undefined;
  }

  private registryFor(id: string): Registry | undefined {
    if (!this.allowed.has(id)) return undefined;
    const connector = this.root.getConnector(id);
    if (!connector) return undefined;
    return connector.authScope === "personal" ? this.personal : this.root;
  }

  listConnectors(): Connector[] {
    return this.root.listConnectors().filter(
      (connector) => this.registryFor(connector.id) !== undefined,
    );
  }

  getConnector(id: string): Connector | undefined {
    return this.registryFor(id)?.getConnector(id);
  }

  resolveAddress(
    address: string,
  ): { connector: Connector; toolName: string } | null {
    const parsed = splitAddress(address);
    if (!parsed) return null;
    const connector = this.getConnector(parsed.connectorId);
    return connector ? { connector, toolName: parsed.toolName } : null;
  }

  async getTools(...args: Parameters<RegistryView["getTools"]>): Promise<ToolDef[]> {
    const registry = this.registryFor(args[0]);
    if (!registry) {
      throw new Error(`Unknown connector "${args[0]}"`);
    }
    const tools = await registry.getTools(...args);
    const granted = this.scope.toolAccess?.get(args[0]);
    if (!granted) return tools;
    // Every consumer — search, describe, call_tool, and a program's
    // connecta.call — resolves through this list, so an ungranted tool is
    // indistinguishable from one the connector never had.
    const visible = tools.filter((tool) => granted.has(tool.name));
    if (visible.length < granted.size) {
      const present = new Set(visible.map((tool) => tool.name));
      for (const name of granted) {
        if (!present.has(name)) this.root.noteAbsentGrant(args[0], name);
      }
    }
    return visible;
  }

  contextFor(
    ...args: Parameters<RegistryView["contextFor"]>
  ): ConnectorContext {
    const registry = this.registryFor(args[0]);
    if (!registry) throw new Error(`Unknown connector "${args[0]}"`);
    return registry.contextFor(...args);
  }

  admitCall(
    ...args: Parameters<RegistryView["admitCall"]>
  ): Promise<CallAdmissionPermit> {
    const registry = this.registryFor(args[0]);
    if (!registry) {
      return Promise.reject(new Error(`Unknown connector "${args[0]}"`));
    }
    return registry.admitCall(...args);
  }

  stashResult(key: string, chunks: readonly string[], ttlSeconds: number): Promise<boolean> {
    return this.root.stashResult(key, chunks, ttlSeconds,
      this.scope.subjectKey ? `subject:${this.scope.subjectKey}:` : "results:");
  }

  resultsStorage(): KVStorage {
    return this.scope.subjectKey
      ? this.root.scopedStorage(this.scope.subjectKey)
      : this.root.resultsStorage();
  }

  credentialDriftFor(id: string): Promise<string | undefined> {
    const registry = this.registryFor(id);
    return registry
      ? registry.credentialDriftFor(id)
      : Promise.resolve(undefined);
  }

  observedOutputSchema(
    connectorId: string,
    definition: ToolDef,
  ): ToolDef["outputSchema"] | undefined {
    return this.registryFor(connectorId)?.observedOutputSchema(
      connectorId,
      definition,
    );
  }

  observeOutputShape(
    connectorId: string,
    definition: ToolDef,
    value: unknown,
  ): void {
    this.registryFor(connectorId)?.observeOutputShape(
      connectorId,
      definition,
      value,
    );
  }

  statusFor(
    ...args: Parameters<RegistryView["statusFor"]>
  ): Promise<ConnectorStatus> {
    const registry = this.registryFor(args[0]);
    return registry
      ? registry.statusFor(...args)
      : Promise.resolve({ state: "error", message: "Unknown connector" });
  }

  invalidateStored(id: string): Promise<void> {
    const registry = this.registryFor(id);
    return registry ? registry.invalidateStored(id) : Promise.resolve();
  }

  credentialUiAvailable(): boolean { return this.root.credentialUiAvailable(); }

  async bindOAuthHandoff(
    id: string,
    authorizationUrl: string,
  ): Promise<void> {
    const connector = this.getConnector(id);
    if (connector?.authScope !== "personal" || !this.scope.principalKey) return;
    let state: string | null = null;
    try {
      state = new URL(authorizationUrl).searchParams.get("state");
    } catch {
      return;
    }
    if (state) {
      await this.root.storeOAuthHandoff(
        id,
        state,
        this.scope.principalKey,
      );
    }
  }
}
