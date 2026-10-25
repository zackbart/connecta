import { Clock, Duration, Effect, Random } from "effect";
import { activityRequest } from "./activity-request.js";
import type { CatalogDriftActivityContext } from "./activity.js";
import {
  aggregateCallAdmissionSnapshots,
  ConnectorCallAdmissionController,
  type CallAdmissionPermit,
  type ConnectorCallAdmissionSnapshot,
} from "./call-admission.js";
import {
  attachCatalogCache,
  catalogExpiry,
  catalogFetchedAt,
  customCatalogFallback,
  invalidateCatalogCache,
  observeUncachedCatalogRefresh,
  storeCustomCatalogFallback,
  type CatalogToolFingerprint,
} from "./catalog-cache.js";
import { carryCatalogFreshness, markCatalogFreshness } from "./catalog-freshness.js";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "./catalog-limits.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { usesCallerIdentity, type ConnectorCaller } from "./connector-caller.js";
import { canonicalJson } from "./canonical-json.js";
import type { CredentialVault } from "./credential-contract.js";
import { storedCredentialShape } from "./credential-rules.js";
import { ConnectorCallError } from "./errors.js";
import { attachOAuthPartition, oauthPartitionIdle } from "./oauth-partition.js";
import { attachOAuthSealer, vaultOAuthSealer } from "./oauth-sealing.js";
import { boundedStatus, failureRecord, failureStatus, logFailure, ownStatus } from "./operator-record.js";
import { ObservedOutputSchemas } from "./result-shapes.js";
import {
  ContinuationBinding,
  OperationCredentials,
  ContinuationStorage,
  operationView,
  setViewService,
  duringViewEffect,
} from "./runtime/call.js";
import { hasNativeStorage, registerNativeStorage } from "./runtime/native-storage.js";
import { provideRegistryPrograms, registryEdgeProgram, registryProgram } from "./runtime/registry.js";
import { causeError, runEdge } from "./runtime/run.js";
import { Storage } from "./runtime/services.js";
import { SharedRead } from "./runtime/shared-read.js";
import {
  runOnPartition,
  storageCompareAndSet,
  storageDelete,
  storageGet,
  storageSet,
  storageList,
} from "./runtime/storage.js";
import { redactCatalog, sentSecretsFor, sentSecretsForRequest, trackCredentialReads } from "./sent-secrets.js";
import { GUIDE_SUMMARY_LENGTH, normalizeGuideSummary } from "./skills.js";
import {
  jsonCodec,
  OAUTH_HANDOFF_TTL_SECONDS,
  oauthHandoffKeys,
  resultKeys,
  scopes,
  stashExpiryKeys,
  stashLedgerKeys,
} from "./storage/keys.js";
import { assertStaticToolNames, hasControlCharacters } from "./tool-name.js";
import { carryToolClassification, classifyTool } from "./tool-safety.js";
import type {
  CatalogAccessObservation,
  Connector,
  ConnectorContext,
  ConnectorStatus,
  KVStorage,
  Logger,
  ToolDef,
} from "./types.js";
import { isWorkspaceAddress } from "./workspace-address.js";
import { workspaceSubjectOf } from "./workspace-subject.js";

const ID_RE = /^[a-z0-9_-]+$/;
const DEFAULT_MAX_RESULT_BYTES = CONFIG_DEFAULTS.calls.maxResultBytes;
const encoder = new TextEncoder();

/**
 * Split `"<connectorId>.<toolName>"` on the first dot. Connector ids contain
 * no dots, so a downstream tool name may. Exported because an address that
 * resolves to nothing is still an address the invocation path has to record
 * activity for — a connector id an agent invented is the most common address
 * mistake, and the one an operator most needs to see.
 */
export function splitAddress(address: string): { connectorId: string; toolName: string } | null {
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
 * — `calls.maxResultBytes`, the per-connector override, and `connecta.result`'s
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
 * `isValidMaxResultBytes` rejects. Construction already refuses an unusable
 * cap (`Registry.assertResultCaps`); the resolution stays total so no call
 * site has to cope with a broken one.
 */
export function resolveMaxResultBytes(value: number | undefined, inherited: number): number {
  return value !== undefined && isValidMaxResultBytes(value) ? value : inherited;
}

/** Freeze registry-owned catalog facts before caching. */
function frozenFacts(tools: ToolDef[]): ToolDef[] {
  const pending: unknown[] = [tools];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const item of Object.values(value)) pending.push(item);
  }
  return tools;
}

export interface RegistryOptions {
  publicUrl?: string | undefined;
  oauthClientName?: string | undefined;
  classification?: Readonly<Record<string, Readonly<Record<string, "read" | "write" | "hidden">>>> | undefined;
  storage: KVStorage;
  /** Internal deployment root, preserved when a personal registry partitions storage. */
  rootStorage?: KVStorage;
  catalogStorage?: KVStorage;
  logger: Logger;
  credentialVault?: CredentialVault | undefined;
  credentialUi?: boolean | undefined;
  /** Internal owner partition used by a personal registry. */
  credentialOwner?: string | undefined;
  /** Internal child registries skip deployment-wide construction warnings. */
  constructionChecks?: boolean | undefined;
  catalogDriftActivity?: Omit<CatalogDriftActivityContext, "logger"> | undefined;
  toolCacheTtlSeconds?: number | undefined;
  catalogMinTtlSeconds?: number | undefined;
  catalogMaxTtlSeconds?: number | undefined;
  /**
   * Cap on inline result size before truncation + connecta.result paging. Must be a
   * whole number of bytes >= 1; anything else throws at construction. Default
   * 24_000.
   */
  maxResultBytes?: number | undefined;
  results?: { maxStashBytes?: number; maxStashEntries?: number } | undefined;
}

function namespaced(storage: KVStorage, prefix: string): KVStorage {
  const edge: KVStorage = {
    capabilities: storage.capabilities,
    get: (k) => storage.get(prefix + k),
    set: (k, v, o) => storage.set(prefix + k, v, o),
    delete: (k) => storage.delete(prefix + k),
    list: async (keyPrefix) => (await storage.list(prefix + keyPrefix)).map((key) => key.slice(prefix.length)),
    compareAndSet: (k, expected, next, o) => storage.compareAndSet(prefix + k, expected, next, o),
  };
  return hasNativeStorage(storage)
    ? registerNativeStorage(edge, {
        // Select against the underlying current methods at dispatch. A
        // namespace created during a decoration regains the native path when
        // that decoration is restored, without capturing stale capabilities.
        get: (key) => storageGet(prefix + key).pipe(Effect.provideService(Storage, storage)),
        set: (key, value, options) =>
          storageSet(prefix + key, value, options).pipe(Effect.provideService(Storage, storage)),
        delete: (key) => storageDelete(prefix + key).pipe(Effect.provideService(Storage, storage)),
        list: (keyPrefix) =>
          storageList(prefix + keyPrefix).pipe(
            Effect.provideService(Storage, storage),
            Effect.map((keys) => keys.map((key) => key.slice(prefix.length))),
          ),
        compareAndSet: (key, expected, next, options) =>
          storageCompareAndSet(prefix + key, expected, next, options).pipe(Effect.provideService(Storage, storage)),
      })
    : edge;
}

export type ConnectorOperationOptions = Pick<ConnectorContext, "signal" | "timeoutMs" | "defer">;

/**
 * The registry surface a per-connection MCP server consumes: every meta-tool
 * (`src/meta-tools.ts`) and the `execute_code` sandbox bridge (`src/execute.ts`)
 * is typed against THIS, never against the concrete `Registry`.
 *
 * The read-only seam remains useful even without scoped views: meta-tools can
 * consume registry behavior without depending on the concrete implementation
 * or its construction-only methods.
 */
/** Host-admitted identity and endpoint bindings for result paging. */
export interface ResultIdentity {
  subject: string | null;
  principal: string | null;
  endpoint: string;
  origin: string | null;
}

export interface ProgramResultDependency {
  /** Catalog metadata needs visibility, not permission to invoke a write. */
  access?: "catalog";
  connector: string;
  tool?: string;
  classification: "read" | "write";
}

export interface RegistryView {
  credentialUiAvailable(): boolean;
  /** Deployment-wide result-size cap threaded to the meta-tools. */
  readonly maxResultBytes: number;
  listConnectors(): Connector[];
  /** Whole-connector permission for downstream skill files, which have no tool grants. */
  canReadConnectorSkills(id: string): boolean;
  getConnector(id: string): Connector | undefined;
  /** Only whole-connector grants authorize resource reads. */
  getResourceConnector(id: string): Connector | undefined;
  resolveAddress(address: string): { connector: Connector; toolName: string } | null;
  getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions?: ConnectorOperationOptions,
  ): Promise<ToolDef[]>;
  contextFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions?: ConnectorOperationOptions,
  ): ConnectorContext;
  /** Acquire the connector's shared downstream-call permit. */
  admitCall(id: string, input: { toolName: string; args: unknown; signal?: AbortSignal }): Promise<CallAdmissionPermit>;
  resultsStorage(): KVStorage;
  resultIdentity(): ResultIdentity;
  /** One validation pass: admit once, then check every dependency under that scope. */
  recheckResultAccess(
    dependencies: readonly ProgramResultDependency[],
    classification: "read" | "write",
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Reserve deployment-wide capacity before writing a paging envelope's chunks. */
  stashResult(id: string, chunks: readonly string[], ttlSeconds: number): Promise<boolean>;
  /** Local declared-vs-stored credential mismatch, with no downstream I/O. */
  credentialDriftFor(id: string): Promise<string | undefined>;
  /** Value-free shape learned from successful calls, never a provider declaration. */
  observedOutputSchema(connectorId: string, definition: ToolDef): ToolDef["outputSchema"] | undefined;
  /** Passively learn one successful unwrapped result; failures stay isolated. */
  observeOutputShape(connectorId: string, definition: ToolDef, value: unknown): void;
  /** Age of the complete cached catalog; null for static or unobserved catalogs. */
  catalogAgeMs(id: string): number | null;
  statusFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions?: ConnectorOperationOptions,
  ): Promise<ConnectorStatus>;
  /** Rebuild a status with this partition's latest bounded observations, without probing. */
  withCatalogObservations(id: string, baseUrl: string, status: ConnectorStatus): ConnectorStatus;
  invalidateStored(id: string): Promise<void>;
  /** Bind returned OAuth state to its initiating user for either owner scope. */
  bindOAuthHandoff(id: string, authorizationUrl: string, principalKey?: string): Promise<void>;
}

/**
 * Connector id → the only tool names this view may see on it. A connector
 * absent from the map is visible whole. Derived from a pool's `tools`
 * addresses at construction; never from caller input.
 */
export type ToolAccess = ReadonlyMap<string, ReadonlySet<string>>;

export interface RegistryScope {
  connectorIds: "all" | readonly string[];
  toolAccess?: ToolAccess;
  subjectKey?: string;
  principalKey?: string;
  endpoint?: string;
  origin?: string | null;
  currentResultAccess?: RegistryView["recheckResultAccess"];
  /** The admitted caller, readable only by built-in connectors; see connector-caller.ts. */
  caller?: ConnectorCaller;
}

const MAX_PERSONAL_REGISTRIES = 1_024;
const MAX_ABSENT_GRANT_WARNINGS = 1_024;
/**
 * Compare-and-set attempts one stash makes on the ledger. A lost swap means
 * another stash changed the ledger first, never that capacity ran out, so
 * the loser re-reads and plans again after a jittered, growing pause: of 64
 * simultaneous claims, each one either books a charge or meets a full ledger.
 * Exhausting the attempts takes seconds of sustained contention on the one
 * ledger record, and then the caller keeps its preview.
 */
const STASH_LEDGER_ATTEMPTS = 32;
/** First backoff window after a lost swap; it doubles up to the cap. */
const STASH_LEDGER_BACKOFF_MS = 4;
const STASH_LEDGER_BACKOFF_CAP_MS = 250;
/** Whole chunk-write phase, measured from booking, including the header. */
const STASH_WRITE_TIMEOUT_MS = 30_000;
/** Total cleanup/release or settlement budget, including ledger retries. */
const STASH_COMPLETION_TIMEOUT_MS = 15_000;

/** Stop waiting without starting background storage work after the deadline. */
function completeStash(effect: Effect.Effect<unknown, unknown, Storage>): Effect.Effect<void, unknown, Storage> {
  return effect.pipe(
    Effect.asVoid,
    Effect.timeoutOrElse({ duration: Duration.millis(STASH_COMPLETION_TIMEOUT_MS), orElse: () => Effect.void }),
    // onError finalizers are otherwise uninterruptible, including their I/O.
    Effect.interruptible,
  );
}

/** One live stash charge: reservation id, bytes, and expiry (epoch ms). */
type StashCharge = readonly [reservation: string, bytes: number, expiresAt: number];

/**
 * Live charges in a stored ledger. Anything malformed reads as empty: the
 * ledger bounds an advisory cache, and the next successful swap replaces it.
 */
function stashCharges(raw: string | null): StashCharge[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = jsonCodec.decode(raw);
  } catch {
    return [];
  }
  const entries = (parsed as { v?: unknown; entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is StashCharge =>
      Array.isArray(entry) &&
      entry.length === 3 &&
      typeof entry[0] === "string" &&
      Number.isSafeInteger(entry[1]) &&
      entry[1] >= 0 &&
      Number.isSafeInteger(entry[2]),
  );
}

/** Caller time can nominate a charge for pruning, but only storage proves expiry. */
function liveStashCharges(raw: string | null, now: number): Effect.Effect<StashCharge[], unknown, Storage> {
  return Effect.gen(function* () {
    const live: StashCharge[] = [];
    const expired = new Map<number, boolean>();
    for (const entry of stashCharges(raw)) {
      const deadline = entry[2];
      if (deadline > now) {
        live.push(entry);
        continue;
      }
      let proven = expired.get(deadline);
      if (proven === undefined) {
        // A successful absolute-expiry write followed by an absent read proves
        // storage has passed this deadline, even when the caller runs ahead.
        // These probes expire at the deadline they check; no cleanup is needed.
        const key = stashExpiryKeys.deadline(deadline);
        yield* storageSet(key, "live", { expiresAtMs: deadline });
        proven = (yield* storageGet(key)) === null;
        expired.set(deadline, proven);
      }
      if (!proven) live.push(entry);
    }
    return live;
  });
}

type StashSwap<A> = { readonly status: "applied"; readonly result: A } | { readonly status: "exhausted" };

/** Rewrite the ledger with bounded retries; every stored charge already expires. */
function swapStashLedger<A>(
  plan: (live: StashCharge[], now: number) => { readonly entries?: StashCharge[]; readonly result: A },
): Effect.Effect<StashSwap<A>, never, Storage> {
  return Effect.gen(function* () {
    const ledger = stashLedgerKeys.ledger;
    for (let attempt = 0; attempt < STASH_LEDGER_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const window = Math.min(STASH_LEDGER_BACKOFF_CAP_MS, STASH_LEDGER_BACKOFF_MS * 2 ** (attempt - 1));
        yield* Effect.sleep(Duration.millis(Math.floor((yield* Random.next) * window) + 1));
      }
      const outcome = yield* Effect.gen(function* () {
        const raw = yield* storageGet(ledger);
        const now = yield* Clock.currentTimeMillis;
        const planned = plan(yield* liveStashCharges(raw, now), now);
        if (planned.entries !== undefined) {
          const entries = planned.entries;
          // The ledger row itself expires with its last charge. A delayed CAS
          // cannot create an immortal row or restart any reservation's lifetime.
          const next = entries.length ? jsonCodec.encode({ v: 1, entries }) : null;
          const expiresAtMs = entries.reduce((latest, entry) => Math.max(latest, entry[2]), entries[0]?.[2] ?? now);
          if (!(yield* storageCompareAndSet(ledger, raw, next, { expiresAtMs }))) return undefined;
        }
        return { status: "applied", result: planned.result } as const;
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (outcome !== undefined) return outcome;
    }
    // The final CAS can commit and then throw too. Confirm a read-only plan
    // once more, especially an already-booked reservation, without another CAS.
    return yield* Effect.gen(function* () {
      const raw = yield* storageGet(ledger);
      const now = yield* Clock.currentTimeMillis;
      const planned = plan(yield* liveStashCharges(raw, now), now);
      return planned.entries === undefined
        ? ({ status: "applied", result: planned.result } as const)
        : ({ status: "exhausted" } as const);
    }).pipe(Effect.catch(() => Effect.succeed({ status: "exhausted" } as const)));
  });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Holds the connector set, resolves addresses, and coalesces tool listings
 * within one request. Remote MCP clients own persisted response caching. Connector failures are isolated: a broken
 * connector surfaces status "error"; the rest keep working.
 */
export class Registry implements RegistryView {
  private readonly connectors = new Map<string, Connector>();
  private readonly callAdmission = new Map<string, ConnectorCallAdmissionController>();
  /** Coalesce listings only within one request and authorization partition. */
  private readonly requestCatalogLoads = new WeakMap<object, Map<string, SharedRead<ToolDef[]>>>();
  private readonly catalogObservedAt = new Map<string, number>();
  /** Last payload-free agent catalog access in this runtime. */
  private readonly catalogAccess = new Map<string, CatalogAccessObservation>();
  /** Bounded tokens isolating count-only observations by catalog identity. */
  private readonly catalogObservationPartitions = new Map<string, object>();
  private readonly overrideWarningCatalogs = new WeakMap<object, string>();
  private readonly observedOutputSchemas: ObservedOutputSchemas;
  /** Result-size guard cap threaded to the meta-tools. */
  readonly maxResultBytes: number;
  private readonly classification: Readonly<Record<string, Readonly<Record<string, "read" | "write" | "hidden">>>>;
  private readonly configuredConnectors: Connector[];
  private readonly personalRegistries = new Map<string, Registry>();
  private readonly oauthPartition = {};
  private callAdmissionClosed = false;
  /** Bounded FIFO of absent grants already warned about. */
  private readonly warnedAbsentGrants = new Set<string>();

  constructor(
    connectors: Connector[],
    private readonly opts: RegistryOptions,
  ) {
    this.configuredConnectors = [...connectors];
    this.observedOutputSchemas = new ObservedOutputSchemas();
    this.maxResultBytes = resolveMaxResultBytes(opts.maxResultBytes, DEFAULT_MAX_RESULT_BYTES);
    for (const c of connectors) {
      assertStaticToolNames(c.staticTools ?? [], `Connector(${JSON.stringify(c.id)}).staticTools`);
      if ("handleRequest" in c) {
        throw new Error(
          `Connector "${c.id}" declares removed handleRequest. ` +
            "Move custom HTTP routes into the deployment's fetch handler.",
        );
      }
      if (!ID_RE.test(c.id)) {
        throw new Error(`Invalid connector id "${c.id}": must match ${ID_RE.source}`);
      }
      if (this.connectors.has(c.id)) {
        throw new Error(`Duplicate connector id "${c.id}"`);
      }
      if (c.readOnly !== undefined && typeof c.readOnly !== "boolean") {
        throw new Error(`Connector "${c.id}" readOnly must be a boolean.`);
      }
      if (c.authScope !== undefined && c.authScope !== "shared" && c.authScope !== "personal") {
        throw new Error(`Invalid authScope on connector "${c.id}": expected "shared" or "personal"`);
      }
      const configuredGuideSummary =
        typeof c.usageGuide === "object" ? normalizeGuideSummary(c.usageGuide.summary ?? "") : undefined;
      if (configuredGuideSummary !== undefined && configuredGuideSummary.length > GUIDE_SUMMARY_LENGTH) {
        throw new Error(
          `Connector "${c.id}" usageGuide.summary is ` +
            `${configuredGuideSummary.length} characters after whitespace ` +
            `normalization; the discovery bound is ${GUIDE_SUMMARY_LENGTH}. ` +
            "Shorten it or omit it to derive one.",
        );
      }
      this.connectors.set(c.id, c);
      if (c.callAdmission !== undefined) {
        this.callAdmission.set(c.id, new ConnectorCallAdmissionController(c.id, c.callAdmission));
      }
    }
    this.classification = Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(opts.classification ?? {}).map(([id, tools]) => [
          id,
          Object.freeze(Object.assign(Object.create(null), tools)),
        ]),
      ),
    );
    Object.freeze(this.classification);
    for (const [id, overrides] of Object.entries(this.classification)) {
      for (const [name, verdict] of Object.entries(overrides)) {
        if (!name || (verdict !== "read" && verdict !== "write" && verdict !== "hidden")) {
          throw new Error(`ConnectaConfig.classification.${id}.${name}: expected "read", "write", or "hidden"`);
        }
      }
      const connector = this.connectors.get(id);
      if (!connector) throw new Error(`ConnectaConfig.classification: unknown connector "${id}"`);
      if (connector.staticTools) this.validateClassification(id, connector.staticTools, overrides);
    }
    this.assertResultCaps(opts.maxResultBytes);
    if (opts.constructionChecks !== false) {
      this.checkConventions(opts.logger);
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
      // OAuth status/start work bypasses both gates, and accepted rotations
      // may still be saving after their caller leaves. Preserve its partition.
      const idle = [...this.personalRegistries].find(
        ([, candidate]) =>
          [...candidate.callAdmission.values()].every((admission) => admission.isIdle()) &&
          oauthPartitionIdle(candidate.oauthPartition),
      );
      if (!idle) {
        throw new Error(
          "Personal connector capacity is exhausted; retry after calls, rolling budgets, and catalog refreshes drain.",
        );
      }
      idle[1].closeCallAdmission();
      this.personalRegistries.delete(idle[0]);
    }
    const registry = new Registry(
      this.configuredConnectors.filter((connector) => connector.authScope === "personal"),
      {
        ...this.opts,
        classification: Object.fromEntries(
          Object.entries(this.classification).filter(([id]) => this.connectors.get(id)?.authScope === "personal"),
        ),
        storage: namespaced(this.opts.storage, scopes.principal(principalKey)),
        rootStorage: this.opts.rootStorage ?? this.opts.storage,
        credentialOwner: principalKey,
        catalogStorage: this.opts.catalogStorage ?? this.opts.storage,
        constructionChecks: false,
      },
    );
    if (this.callAdmissionClosed) registry.closeCallAdmission();
    this.personalRegistries.set(principalKey, registry);
    return registry;
  }

  /** Build the only connector view an authenticated request receives. */
  scoped(scope: RegistryScope): RegistryView {
    const requested = scope.connectorIds === "all" ? new Set(this.connectors.keys()) : new Set(scope.connectorIds);
    for (const id of requested) {
      if (!this.connectors.has(id)) {
        throw new Error(`Registry scope names unknown connector "${id}"`);
      }
    }
    return new ScopedRegistryView(this, requested, scope);
  }

  scopedStorage(subjectKey: string): KVStorage {
    return namespaced(this.opts.storage, scopes.subject(subjectKey));
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
    if (hasControlCharacters(toolName)) {
      logFailure(this.opts.logger, "pool tool grant is unreachable", failureRecord({ connector: connectorId }));
      return;
    }
    // Grant names are operator data but may carry any non-control character;
    // quote them so a line terminator a log reader honours cannot forge a line.
    const quoted = JSON.stringify(key).replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
    this.opts.logger.warn(
      `a pool grants ${quoted} but connector "${connectorId}" lists no such tool; the grant is unreachable`,
    );
  }

  storeOAuthHandoff(connectorId: string, state: string, principalKey: string): Promise<void> {
    return runEdge(
      registryEdgeProgram(Registry.prototype, this, "storeOAuthHandoff", connectorId, state, principalKey),
    );
  }

  oauthCallbackView(
    connectorId: string,
    state: string | null,
  ): Promise<{
    registry: RegistryView;
    principalKey?: string;
  } | null> {
    return runEdge(registryEdgeProgram(Registry.prototype, this, "oauthCallbackView", connectorId, state));
  }

  consumeOAuthHandoff(connectorId: string, state: string | null, principalKey: string): Promise<boolean> {
    return runEdge(
      registryEdgeProgram(Registry.prototype, this, "consumeOAuthHandoff", connectorId, state, principalKey),
    );
  }

  /**
   * Refuse an unusable result cap at construction, like every other
   * structural mistake (INV-11). A rejected cap can't be honoured, and
   * honouring it *approximately* is exactly the inversion issue #32 is about;
   * falling back with a warning let a deployment boot on a value nobody
   * chose.
   */
  private assertResultCaps(configured: number | undefined): void {
    if (configured !== undefined && !isValidMaxResultBytes(configured)) {
      throw new Error(
        `ConnectaConfig.calls.maxResultBytes must be a whole number of bytes >= ${MIN_MAX_RESULT_BYTES}.`,
      );
    }
    for (const c of this.connectors.values()) {
      if (c.maxResultBytes !== undefined && !isValidMaxResultBytes(c.maxResultBytes)) {
        throw new Error(
          `Connector "${c.id}" maxResultBytes must be a whole number of bytes >= ` +
            `${MIN_MAX_RESULT_BYTES}; omit it to inherit the deployment-wide cap.`,
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

  getResourceConnector(id: string): Connector | undefined {
    return this.getConnector(id);
  }

  canReadConnectorSkills(id: string): boolean {
    return this.connectors.has(id);
  }

  contextFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): ConnectorContext {
    const connector = this.connectors.get(id);
    const credentialConfig = connector?.credential;
    let credentialAccess: ConnectorContext["credential"];
    let credentialProgram: Effect.Effect<import("./types.js").ConnectorCredentialValues | null, unknown> | undefined;
    if (this.opts.credentialVault && credentialConfig) {
      const vault = this.opts.credentialVault;
      credentialProgram = Effect.tryPromise({
        try: () => vault.getAll(id, this.opts.credentialOwner),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((values) => {
          const shape = storedCredentialShape(credentialConfig, values);
          return shape.state === "mismatch"
            ? Effect.fail(new ConnectorCallError("auth_required", shape.message))
            : Effect.succeed(values);
        }),
      );
      const readValues = () => runEdge(credentialProgram!);
      credentialAccess = {
        get: async (field = "value") => {
          const values = await readValues();
          return values && Object.hasOwn(values, field) ? values[field]! : null;
        },
        getAll: readValues,
      };
    }
    const context = operationView(
      {
        storage: namespaced(this.opts.storage, scopes.connector(id)),
        logger: this.opts.logger,
        baseUrl,
        ...(this.opts.publicUrl !== undefined ? { publicUrl: this.opts.publicUrl } : {}),
        ...(this.opts.oauthClientName !== undefined ? { oauthClientName: this.opts.oauthClientName } : {}),
        ...(credentialAccess ? { credential: credentialAccess } : {}),
        requestScope,
        ...callOptions,
      },
      scope?.caller,
    );
    setViewService(context, OperationCredentials, credentialProgram);
    setViewService(context, ContinuationStorage, this.opts.rootStorage ?? this.opts.storage);
    const owner = this.opts.credentialOwner ?? null;
    setViewService(context, ContinuationBinding, {
      connection: id,
      // Include every admitted input a subject mapping can inspect, including
      // the pool owner for an agent. This value enters only the HMAC claims.
      principal: connector && usesCallerIdentity(connector) ? canonicalJson([owner, scope?.caller ?? null]) : owner,
    });
    attachCatalogCache(context, {
      storage: this.opts.catalogStorage ?? this.opts.storage,
      partition: this.catalogPartition(scope),
      sharedPartition: JSON.stringify([baseUrl, this.opts.publicUrl ?? null, scope?.caller?.pool ?? null]),
      defaultTtlMs: (this.opts.toolCacheTtlSeconds ?? CONFIG_DEFAULTS.discovery.catalogTtlSeconds) * 1000,
      minTtlMs: (this.opts.catalogMinTtlSeconds ?? CONFIG_DEFAULTS.discovery.catalogMinTtlSeconds) * 1000,
      maxTtlMs: (this.opts.catalogMaxTtlSeconds ?? CONFIG_DEFAULTS.discovery.catalogMaxTtlSeconds) * 1000,
      ...(this.opts.catalogDriftActivity?.recordChange
        ? {
            onCompletedCatalogRefresh: (refresh, ctx) =>
              this.recordCatalogDrift(refresh.previous, refresh.next, {
                id,
                connector: this.connectors.get(id)!,
                ctx,
                privateCatalog: refresh.private,
              }),
          }
        : {}),
    });
    sentSecretsFor(context);
    trackCredentialReads(context);
    attachOAuthPartition(context, this.oauthPartition);
    // Downstream OAuth state is sealed under the vault key, bound to this
    // connector and owner. The sealer rides beside the context, not on it.
    return this.opts.credentialVault
      ? attachOAuthSealer(
          context,
          vaultOAuthSealer(this.opts.credentialVault, id, this.opts.credentialOwner, this.opts.logger),
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
    return Object.fromEntries([...snapshots].map(([id, values]) => [id, aggregateCallAdmissionSnapshots(values)]));
  }

  /** The admitted identity fields used by both catalog caching and reporting. */
  private catalogPartition(scope?: RegistryScope): string {
    return JSON.stringify([
      scope?.principalKey ?? this.opts.credentialOwner ?? null,
      scope?.subjectKey ?? null,
      scope?.caller?.identity ?? null,
      scope?.caller?.authenticated ?? false,
      scope?.caller?.pool ?? null,
    ]);
  }

  /** Bounded, in-memory tokens; no principal or catalog data is persisted. */
  private catalogObservationPartition(
    id: string,
    baseUrl: string,
    scope?: RegistryScope,
    create = false,
  ): object | undefined {
    const key = JSON.stringify([id, this.catalogPartition(scope), baseUrl, this.opts.publicUrl ?? null]);
    let partition = this.catalogObservationPartitions.get(key);
    if (!partition && create) {
      partition = {};
      this.catalogObservationPartitions.set(key, partition);
      if (this.catalogObservationPartitions.size > 1024)
        this.catalogObservationPartitions.delete(this.catalogObservationPartitions.keys().next().value!);
    }
    return partition;
  }

  /** Reject queued/future downstream admission; active permits release safely. */
  closeCallAdmission(): void {
    this.callAdmissionClosed = true;
    for (const admission of this.callAdmission.values()) admission.close();
    for (const registry of this.personalRegistries.values()) registry.closeCallAdmission();
  }

  /**
   * Reserve capacity and write one ASCII paging envelope.
   *
   * `chunks[n]` lands on `resultKeys.chunk(id, n)` inside `partition` — the
   * layout connecta.result reads back, so a page fetches only the chunks it covers
   * instead of the whole stored result (issue #540). Chunking is a read-cost
   * decision, not a capacity one: however many keys an envelope occupies, it
   * is one stash entry charged its total ASCII length.
   *
   * The bounds are the deployment's, not this isolate's. Every charge is a
   * row in one ledger record in storage, booked by compare-and-set before any
   * chunk is written, so every isolate and process sharing the store sees the
   * same entries and bytes. A pending write keeps its finite charge reserved.
   * Writes stop after 30 seconds; absolute chunk expiries cannot pass the
   * booked deadline even on late commit. Rejected responses leave writes
   * unconfirmed and retain their charge. Cleanup/release and settlement each
   * stop waiting after 15 seconds. Storage TTL reclaims the rows.
   */
  stashResult(
    id: string,
    chunks: readonly string[],
    ttlSeconds: number,
    partition: string = scopes.results,
  ): Promise<boolean> {
    return runOnPartition(
      registryEdgeProgram(Registry.prototype, this, "stashResult", id, chunks, ttlSeconds, partition),
      this.opts,
    );
  }

  /**
   * Storage namespaced to the root result partition, kept separate from any
   * connector's namespace. Backs connecta.result.
   */
  resultIdentity(): ResultIdentity {
    return { subject: null, principal: null, endpoint: "/mcp", origin: null };
  }

  recheckResultAccess(
    _dependencies: readonly ProgramResultDependency[],
    _classification: "read" | "write",
    _signal?: AbortSignal,
  ): Promise<boolean> {
    return Promise.resolve(true);
  }

  resultsStorage(): KVStorage {
    return namespaced(this.opts.storage, scopes.results);
  }

  credentialUiAvailable(): boolean {
    return Boolean(this.opts.credentialUi);
  }

  bindOAuthHandoff(id: string, authorizationUrl: string, principalKey?: string): Promise<void> {
    return runEdge(
      registryEdgeProgram(Registry.prototype, this, "bindOAuthHandoff", id, authorizationUrl, principalKey),
    );
  }

  observedOutputSchema(connectorId: string, definition: ToolDef): ToolDef["outputSchema"] | undefined {
    return this.observedOutputSchemas.get(connectorId, definition);
  }

  observeOutputShape(connectorId: string, definition: ToolDef, value: unknown): void {
    this.observedOutputSchemas.observe(connectorId, definition, value);
  }

  /** Resolve "<connectorId>.<toolName>" → connector + tool name. */
  resolveAddress(address: string): { connector: Connector; toolName: string } | null {
    const parts = splitAddress(address);
    if (!parts) return null;
    const connector = this.connectors.get(parts.connectorId);
    if (!connector) return null;
    return { connector, toolName: parts.toolName };
  }

  /** Compare only the fingerprints accepted in this exact cache partition. */
  private recordCatalogDrift(
    previous: readonly CatalogToolFingerprint[] | undefined,
    next: readonly CatalogToolFingerprint[],
    attribution: { id: string; connector: Connector; ctx: ConnectorContext; privateCatalog: boolean },
  ): void {
    if (!previous) return;
    const { id, connector, ctx, privateCatalog } = attribution;
    const before = new Map(previous.map((tool) => [tool.name, tool.fact]));
    const after = new Map(next.map((tool) => [tool.name, tool.fact]));
    const addedTools = [...after.keys()].filter((name) => !before.has(name)).length;
    const removedTools = [...before.keys()].filter((name) => !after.has(name)).length;
    const changedTools = [...after].filter(([name, fact]) => before.has(name) && before.get(name) !== fact).length;
    if (addedTools || removedTools || changedTools)
      this.opts.catalogDriftActivity?.recordChange?.(
        { ...this.opts.catalogDriftActivity, logger: this.opts.logger, ...(ctx.defer ? { defer: ctx.defer } : {}) },
        {
          connectorId: id,
          drift: { kind: "catalog_changed", addedTools, removedTools, changedTools },
          privateCatalog,
          ...(connector.authScope === "personal" ? { personal: true } : {}),
        },
        activityRequest(ctx.requestScope),
      );
  }

  private loadDownstreamTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Effect.Effect<ToolDef[], unknown> {
    return Effect.gen({ self: this }, function* () {
      const connector = this.connectors.get(id);
      if (!connector) throw new Error(`Unknown connector "${id}"`);
      if (connector.staticTools) return markCatalogFreshness(connector.staticTools, Infinity);
      const ctx = this.contextFor(id, baseUrl, requestScope, callOptions, scope);
      const listed = yield* Effect.tryPromise({ try: () => connector.listTools(ctx), catch: (error) => error }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const fallback =
              error instanceof ConnectorCallError && error.code === "unavailable"
                ? yield* Effect.tryPromise({
                    try: () => customCatalogFallback(ctx, id),
                    catch: (failure) => failure,
                  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined;
            return fallback
              ? fallback
              : yield* Effect.fail(sentSecretsForRequest(ctx.requestScope ?? ctx).redact(error));
          }),
        ),
      );
      const tools = redactCatalog(ctx, listed).map(({ classification: _ignored, ...fact }) => fact);
      if (
        tools.length > MAX_CATALOG_TOOLS ||
        encoder.encode(JSON.stringify(tools)).byteLength > MAX_SERIALIZED_CATALOG_BYTES
      ) {
        throw new ConnectorCallError(
          "connector_call_failed",
          "Downstream catalog exceeds the complete-catalog ceiling.",
          { retryable: false },
        );
      }
      const facts = frozenFacts(structuredClone(tools));
      const accepted = this.acceptToolNames(facts);
      if (catalogFetchedAt(ctx) === undefined) {
        for (const observe of [storeCustomCatalogFallback, observeUncachedCatalogRefresh]) {
          yield* Effect.tryPromise({ try: () => observe(ctx, id, facts), catch: (error) => error }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                logFailure(
                  this.opts.logger,
                  "catalog refresh observation failed",
                  failureRecord({ connector: id }, error),
                ),
              ),
            ),
          );
        }
      }
      this.catalogObservedAt.set(id, catalogFetchedAt(ctx) ?? Date.now());
      const provenance = catalogExpiry(ctx);
      const freshUntil = provenance && !provenance.staleFallback ? provenance.expiresAt : 0;
      this.catalogAccess.set(id, {
        state: freshUntil > Date.now() ? "fresh" : "stale",
        observedAt: new Date().toISOString(),
      });
      return markCatalogFreshness(accepted, freshUntil);
    });
  }

  /** The served catalog excludes control-character names; raw caches stay complete. */
  private acceptToolNames(tools: ToolDef[]): ToolDef[] {
    const accepted = tools.filter((tool) => !hasControlCharacters(tool.name));
    return accepted.length === tools.length ? tools : accepted;
  }

  /**
   * One connector's catalog as served: the cached downstream facts, classified
   * on every read by annotations and deployment overrides, into fresh objects.
   * No cache or caller mutation can carry a stale verdict into the next read.
   */
  private loadTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Effect.Effect<ToolDef[], unknown> {
    return Effect.gen({ self: this }, function* () {
      const tools = yield* this.loadDownstreamTools(id, baseUrl, requestScope, callOptions, scope);
      const connector = this.connectors.get(id);
      if (!connector) throw new Error(`Unknown connector "${id}"`);
      const accepted = this.acceptToolNames(tools);
      const overrides = this.classification[id];
      this.validateClassification(id, accepted, overrides, this.catalogObservationPartition(id, baseUrl, scope, true));
      const visible = accepted.filter((tool) => overrides?.[tool.name] !== "hidden");
      const served = visible.map((tool) => this.publishTool(id, tool));
      return carryCatalogFreshness(tools, served);
    });
  }

  private publishTool(id: string, tool: ToolDef): ToolDef {
    const override = this.classification[id]?.[tool.name];
    return carryToolClassification(tool, {
      ...structuredClone(tool),
      classification: classifyTool(tool, override === "hidden" ? undefined : override),
      ...(override !== undefined
        ? {
            annotations: {
              ...structuredClone(tool.annotations),
              readOnlyHint: override === "read",
              destructiveHint: override === "write",
            },
          }
        : {}),
    });
  }

  /** Construction-only view for the secret-free static config description. */
  describeStaticTools(id: string): ToolDef[] | undefined {
    const tools = this.connectors.get(id)?.staticTools;
    return tools
      ?.filter((tool) => this.classification[id]?.[tool.name] !== "hidden")
      .map((tool) => this.publishTool(id, tool));
  }

  private validateClassification(
    id: string,
    tools: readonly ToolDef[],
    overrides?: Readonly<Record<string, "read" | "write" | "hidden">>,
    partition?: object,
  ): void {
    if (!overrides) return;
    if (partition) {
      const catalog = JSON.stringify(tools);
      if (this.overrideWarningCatalogs.get(partition) === catalog) return;
      this.overrideWarningCatalogs.set(partition, catalog);
    }
    const known = new Set(tools.map((tool) => tool.name));
    for (const name of Object.keys(overrides ?? {})) {
      if (known.has(name)) continue;
      if (this.connectors.get(id)?.staticTools) {
        throw new Error(`ConnectaConfig.classification: connector "${id}" has no tool "${name}"`);
      }
      // Only deployment-authored names, never downstream text. JSON quoting
      // prevents control characters from forging operator log lines.
      const quoted = JSON.stringify(`${id}.${name}`).replace(
        /[\u2028\u2029]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
      );
      this.opts.logger.warn(
        `classification override ${quoted} is dormant because the runtime catalog lists no such tool`,
      );
    }
  }

  getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Promise<ToolDef[]> {
    return runEdge(
      registryEdgeProgram(Registry.prototype, this, "getTools", id, baseUrl, requestScope, callOptions, scope),
    );
  }

  credentialDriftFor(id: string): Promise<string | undefined> {
    return runEdge(registryEdgeProgram(Registry.prototype, this, "credentialDriftFor", id));
  }

  /** Age of a complete cache entry; reads never refresh it. */
  catalogAgeMs(id: string): number | null {
    const observedAt = this.catalogObservedAt.get(id);
    return observedAt === undefined ? null : Math.max(0, Date.now() - observedAt);
  }

  /** Pure lookup shared by status probes and operator catalog refreshes. */
  withCatalogObservations(
    id: string,
    _baseUrl: string,
    status: ConnectorStatus,
    _scope?: RegistryScope,
  ): ConnectorStatus {
    const connector = this.connectors.get(id);
    if (!connector) return ownStatus({ state: "error", message: "Unknown connector" });
    const access = this.catalogAccess.get(id);
    // Connector.status is an open plugin seam. Rebuild its public fields so
    // it cannot smuggle payload or another partition's observations (INV-6).
    return Object.assign(boundedStatus(status), access ? { catalogAccess: { ...access } } : {});
  }

  /** Best-effort connector status for the operator UI. */
  statusFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Promise<ConnectorStatus> {
    return runEdge(
      registryEdgeProgram(Registry.prototype, this, "statusFor", id, baseUrl, requestScope, callOptions, scope),
    );
  }

  /** Rotate the storage generation; in-flight old readers cannot republish it. */
  invalidate(id: string): void {
    void this.invalidateStored(id);
  }

  invalidateStored(id: string): Promise<void> {
    return runEdge(registryEdgeProgram(Registry.prototype, this, "invalidateStored", id));
  }

  static {
    provideRegistryPrograms(Registry.prototype, {
      stashResult: (self, id, chunks, ttlSeconds, partition = scopes.results) =>
        Effect.gen({ self }, function* () {
          const maxBytes = this.opts.results?.maxStashBytes ?? CONFIG_DEFAULTS.results.maxStashBytes;
          const maxEntries = this.opts.results?.maxStashEntries ?? CONFIG_DEFAULTS.results.maxStashEntries;
          // The paging envelope is ASCII, so its string length is its stored byte count.
          const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (bytes > maxBytes || maxEntries === 0) return false;
          const keys = chunks.map((_, index) => partition + resultKeys.chunk(id, index));
          // IDs belong to reservations, not reusable result IDs or subjects.
          const charge = crypto.randomUUID();
          const ttlMs = ttlSeconds * 1000;
          if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return false;
          const booking = yield* swapStashLedger((live, now) => {
            // A committed CAS with a lost response is already our booking, even
            // at full capacity. Reuse its deadline instead of adding a second slot.
            const own = live.find((entry) => entry[0] === charge);
            if (own) return { result: own[2] };
            const used = live.reduce((sum, entry) => sum + entry[1], 0);
            if (live.length >= maxEntries || used + bytes > maxBytes) return { result: undefined };
            const deadline = now + STASH_WRITE_TIMEOUT_MS + ttlMs;
            if (!Number.isSafeInteger(deadline)) return { result: undefined };
            return { entries: [...live, [charge, bytes, deadline]], result: deadline };
          });
          if (booking.status === "exhausted" || booking.result === undefined) return false;
          const deadline = booking.result;
          const writeDeadline = deadline - ttlMs;
          const chunkExpiry = deadline - STASH_WRITE_TIMEOUT_MS;
          const owns = (entry: StashCharge) => entry[0] === charge;
          const settle = swapStashLedger((live) =>
            live.some((entry) => owns(entry) && entry[2] > chunkExpiry)
              ? {
                  entries: live.map((entry) =>
                    owns(entry) ? [charge, bytes, Math.min(entry[2], chunkExpiry)] : entry,
                  ),
                  result: undefined,
                }
              : { result: undefined },
          );
          let pendingWrite = false;
          // A rejected or timed-out driver call may still commit after deletion.
          // Only a confirmed write response clears pendingWrite.
          const release = completeStash(
            Effect.gen(function* () {
              const deleted = yield* Effect.gen(function* () {
                for (const key of keys) yield* storageDelete(key);
                return true;
              }).pipe(Effect.catch(() => Effect.succeed(false)));
              if (pendingWrite) return;
              if (deleted) {
                const released = yield* swapStashLedger((live) =>
                  live.some(owns)
                    ? { entries: live.filter((entry) => !owns(entry)), result: undefined }
                    : { result: undefined },
                );
                if (released.status === "applied") return;
              }
              yield* settle;
            }),
          );
          // Trailing chunks first, then the header. The caller receives no result
          // ID after failure or timeout, including a late header commit.
          const remaining = Math.max(0, writeDeadline - (yield* Clock.currentTimeMillis));
          const written = yield* Effect.gen(function* () {
            for (let index = keys.length - 1; index >= 0; index--) {
              const before = yield* Clock.currentTimeMillis;
              if (before >= writeDeadline || before >= chunkExpiry) return false;
              pendingWrite = true;
              yield* storageSet(keys[index]!, chunks[index]!, { expiresAtMs: chunkExpiry }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    pendingWrite = false;
                  }),
                ),
              );
              if ((yield* Clock.currentTimeMillis) >= writeDeadline) return false;
            }
            return true;
          }).pipe(
            Effect.timeoutOrElse({ duration: Duration.millis(remaining), orElse: () => Effect.succeed(false) }),
            Effect.onError(() => release.pipe(Effect.ignore)),
          );
          if (!written) yield* release;
          else yield* completeStash(settle);
          return written;
        }).pipe(Effect.provideService(Storage, self.opts.storage)),
      recheckResultAccess: () => Effect.succeed(true),
      storeOAuthHandoff: (self, connectorId, state, principalKey) =>
        Effect.gen(function* () {
          const key = oauthHandoffKeys.handoff(
            connectorId,
            yield* Effect.tryPromise({ try: () => sha256Hex(state), catch: (error) => error }),
          );
          for (let attempt = 0; attempt < 32; attempt++) {
            const existing = yield* storageGet(key);
            if (existing && existing !== principalKey)
              throw new Error(`Connector "${connectorId}" reused one OAuth state across principals`);
            if (yield* storageCompareAndSet(key, existing, principalKey, { ttlSeconds: OAUTH_HANDOFF_TTL_SECONDS }))
              return;
          }
          throw new Error(`OAuth handoff for "${connectorId}" is busy; retry authorization`);
        }).pipe(Effect.provideService(Storage, self.opts.storage)),
      oauthCallbackView: (self, connectorId, state) =>
        Effect.gen(function* () {
          if (!state) return null;
          const digest = yield* Effect.tryPromise({ try: () => sha256Hex(state), catch: (error) => error });
          const principalKey = yield* storageGet(oauthHandoffKeys.handoff(connectorId, digest));
          const connector = self.connectors.get(connectorId);
          if (!connector || !principalKey) return null;
          return {
            registry:
              connector.authScope === "personal"
                ? self.scoped({ connectorIds: [connectorId], subjectKey: principalKey, principalKey })
                : self,
            principalKey,
          };
        }).pipe(Effect.provideService(Storage, self.opts.storage)),
      consumeOAuthHandoff: (self, connectorId, state, principalKey) =>
        Effect.gen(function* () {
          if (!state) return false;
          const digest = yield* Effect.tryPromise({ try: () => sha256Hex(state), catch: (error) => error });
          return yield* storageCompareAndSet(oauthHandoffKeys.handoff(connectorId, digest), principalKey, null);
        }).pipe(Effect.provideService(Storage, self.opts.storage)),
      bindOAuthHandoff: (self, id, authorizationUrl, principalKey) =>
        Effect.gen(function* () {
          const state = new URL(authorizationUrl).searchParams.get("state");
          if (!state || !principalKey) throw new Error("OAuth requires state and an initiating user");
          yield* registryProgram(self, "storeOAuthHandoff", id, state, principalKey);
        }),
      getTools: (self, id, baseUrl, requestScope, callOptions = {}, scope) =>
        Effect.suspend(() => {
          if (!self.connectors.has(id)) return Effect.fail(new Error(`Unknown connector "${id}"`));
          const owner = self.contextFor(id, baseUrl, requestScope, callOptions, scope);
          return duringViewEffect(owner, (signal) => {
            if (!requestScope)
              return self.loadTools(id, baseUrl, owner.requestScope, { ...callOptions, signal }, scope);
            let loads = self.requestCatalogLoads.get(requestScope);
            if (!loads) {
              loads = new Map();
              self.requestCatalogLoads.set(requestScope, loads);
            }
            const requestLoads = loads;
            const key = JSON.stringify([id, scope?.principalKey, scope?.subjectKey, scope?.caller]);
            let load = requestLoads.get(key);
            if (!load) {
              const started = new SharedRead(
                (signal) => self.loadTools(id, baseUrl, requestScope, { ...callOptions, signal }, scope),
                () => {
                  if (requestLoads.get(key) === started) requestLoads.delete(key);
                  if (requestLoads.size === 0) self.requestCatalogLoads.delete(requestScope);
                },
                requestScope,
              );
              requestLoads.set(key, started);
              load = started;
            }
            return load.join(signal);
          });
        }),
      credentialDriftFor: (self, id) =>
        Effect.gen(function* () {
          const credential = self.connectors.get(id)?.credential;
          const vault = self.opts.credentialVault;
          if (!credential || !vault) return undefined;
          return yield* Effect.tryPromise({
            try: () => vault.getAll(id, self.opts.credentialOwner),
            catch: (error) => error,
          }).pipe(
            Effect.map((values) => {
              const shape = storedCredentialShape(credential, values);
              return shape.state === "mismatch" ? shape.message : undefined;
            }),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                logFailure(
                  self.opts.logger,
                  "credential shape read failed",
                  failureRecord({ connector: id }, causeError(cause)),
                );
                return undefined;
              }),
            ),
          );
        }),
      statusFor: (self, id, baseUrl, requestScope = {}, callOptions = {}, scope) =>
        Effect.suspend(() => {
          const connector = self.connectors.get(id);
          if (!connector)
            return Effect.succeed<ConnectorStatus>(ownStatus({ state: "error", message: "Unknown connector" }));
          const ctx = self.contextFor(id, baseUrl, requestScope, callOptions, scope);
          const withObservations = (status: ConnectorStatus) =>
            self.withCatalogObservations(id, baseUrl, status, scope);
          return duringViewEffect(ctx, () =>
            Effect.gen(function* () {
              if (connector.credential) {
                const values = yield* Effect.tryPromise({
                  try: () => self.opts.credentialVault?.getAll(id, self.opts.credentialOwner) ?? Promise.resolve(null),
                  catch: (error) => error,
                });
                const shape = storedCredentialShape(connector.credential, values);
                if (shape.state === "missing") return withObservations(ownStatus({ state: "credential_required" }));
                if (shape.state === "mismatch") return withObservations(ownStatus({ state: "auth_required" }));
              }
              if (connector.status)
                return withObservations(
                  yield* Effect.tryPromise({ try: () => connector.status!(ctx), catch: (error) => error }),
                );
              yield* registryProgram(self, "getTools", id, baseUrl, requestScope, callOptions, scope);
              return withObservations({ state: "ok" });
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed(withObservations(failureStatus(id, causeError(cause, ctx.signal)))),
            ),
          );
        }),
      invalidateStored: (self, id) =>
        Effect.suspend(() => {
          self.catalogObservedAt.delete(id);
          return Effect.tryPromise({
            try: () => invalidateCatalogCache(self.opts.catalogStorage ?? self.opts.storage, id),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                logFailure(self.opts.logger, "catalog invalidation failed", failureRecord({ connector: id }, error)),
              ),
            ),
          );
        }),
    });
  }
}

class ScopedRegistryView implements RegistryView {
  readonly maxResultBytes: number;
  /** An evicted view's admission controller must remain closed. */
  private readonly admissionPersonal: Registry | undefined;

  private get personal(): Registry | undefined {
    return this.scope.principalKey ? this.root.personalRegistry(this.scope.principalKey) : undefined;
  }

  constructor(
    private readonly root: Registry,
    private readonly allowed: ReadonlySet<string>,
    private readonly scope: RegistryScope,
  ) {
    this.maxResultBytes = root.maxResultBytes;
    // Check capacity at construction, then resolve the current registry on
    // use. A retained view must not revive one evicted while it was idle.
    this.admissionPersonal = scope.principalKey ? root.personalRegistry(scope.principalKey) : undefined;
  }

  private registryFor(id: string, admission = false): Registry | undefined {
    if (!this.allowed.has(id)) return undefined;
    const connector = this.root.getConnector(id);
    if (!connector) return undefined;
    // An agent has no Workspace account: on a mapping-subject Workspace
    // connector it acts as the pool's owner. Without one there is no account
    // to act as, so the connector is absent, as a personal connector is.
    if (this.agentWithoutOwner && workspaceSubjectOf(connector)?.kind === "mapping") return undefined;
    if (connector.authScope !== "personal") return this.root;
    return admission ? this.admissionPersonal : this.personal;
  }

  /** An agent admitted through a pool that names no Workspace owner. */
  private get agentWithoutOwner(): boolean {
    const caller = this.scope.caller;
    if (caller?.identity.agent === undefined) return false;
    // The same test the Workspace provider applies before acting as the owner.
    return caller.pool === undefined || !isWorkspaceAddress(caller.poolOwner);
  }

  listConnectors(): Connector[] {
    return this.root.listConnectors().filter((connector) => this.registryFor(connector.id) !== undefined);
  }

  canReadConnectorSkills(id: string): boolean {
    return this.registryFor(id) !== undefined && !this.scope.toolAccess?.has(id);
  }

  getConnector(id: string): Connector | undefined {
    return this.registryFor(id)?.getConnector(id);
  }

  getResourceConnector(id: string): Connector | undefined {
    if (this.scope.toolAccess?.has(id)) return undefined;
    return this.getConnector(id);
  }

  resolveAddress(address: string): { connector: Connector; toolName: string } | null {
    const parsed = splitAddress(address);
    if (!parsed) return null;
    const connector = this.getConnector(parsed.connectorId);
    return connector ? { connector, toolName: parsed.toolName } : null;
  }

  getTools(...args: Parameters<RegistryView["getTools"]>): Promise<ToolDef[]> {
    return runEdge(registryEdgeProgram(ScopedRegistryView.prototype, this, "getTools", ...args));
  }

  contextFor(...args: Parameters<RegistryView["contextFor"]>): ConnectorContext {
    const registry = this.registryFor(args[0]);
    if (!registry) throw new Error(`Unknown connector "${args[0]}"`);
    return registry.contextFor(args[0], args[1], args[2], args[3], this.scope);
  }

  admitCall(...args: Parameters<RegistryView["admitCall"]>): Promise<CallAdmissionPermit> {
    const registry = this.registryFor(args[0], true);
    if (!registry) {
      return Promise.reject(new Error(`Unknown connector "${args[0]}"`));
    }
    return registry.admitCall(...args);
  }

  stashResult(id: string, chunks: readonly string[], ttlSeconds: number): Promise<boolean> {
    return this.root.stashResult(
      id,
      chunks,
      ttlSeconds,
      this.scope.subjectKey ? scopes.subject(this.scope.subjectKey) : scopes.results,
    );
  }

  resultIdentity(): ResultIdentity {
    return {
      subject: this.scope.subjectKey ?? null,
      principal: this.scope.principalKey ?? null,
      endpoint: this.scope.endpoint ?? "/mcp",
      origin: this.scope.origin ?? null,
    };
  }

  recheckResultAccess(
    dependencies: readonly ProgramResultDependency[],
    classification: "read" | "write",
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.scope.currentResultAccess?.(dependencies, classification, signal) ?? Promise.resolve(true);
  }

  resultsStorage(): KVStorage {
    return this.scope.subjectKey ? this.root.scopedStorage(this.scope.subjectKey) : this.root.resultsStorage();
  }

  credentialDriftFor(id: string): Promise<string | undefined> {
    return runEdge(registryEdgeProgram(ScopedRegistryView.prototype, this, "credentialDriftFor", id));
  }

  observedOutputSchema(connectorId: string, definition: ToolDef): ToolDef["outputSchema"] | undefined {
    return this.registryFor(connectorId)?.observedOutputSchema(connectorId, definition);
  }

  observeOutputShape(connectorId: string, definition: ToolDef, value: unknown): void {
    this.registryFor(connectorId)?.observeOutputShape(connectorId, definition, value);
  }

  catalogAgeMs(id: string): number | null {
    return this.registryFor(id)?.catalogAgeMs(id) ?? null;
  }

  statusFor(...args: Parameters<RegistryView["statusFor"]>): Promise<ConnectorStatus> {
    return runEdge(registryEdgeProgram(ScopedRegistryView.prototype, this, "statusFor", ...args));
  }

  withCatalogObservations(id: string, baseUrl: string, status: ConnectorStatus): ConnectorStatus {
    return (
      this.registryFor(id)?.withCatalogObservations(id, baseUrl, status, this.scope) ??
      ownStatus({ state: "error", message: "Unknown connector" })
    );
  }

  invalidateStored(id: string): Promise<void> {
    return runEdge(registryEdgeProgram(ScopedRegistryView.prototype, this, "invalidateStored", id));
  }

  credentialUiAvailable(): boolean {
    return this.root.credentialUiAvailable();
  }

  async bindOAuthHandoff(id: string, authorizationUrl: string, principalKey?: string): Promise<void> {
    return runEdge(
      registryEdgeProgram(ScopedRegistryView.prototype, this, "bindOAuthHandoff", id, authorizationUrl, principalKey),
    );
  }
  static {
    provideRegistryPrograms(ScopedRegistryView.prototype, {
      stashResult: (self, id, chunks, ttlSeconds) =>
        registryProgram(
          self.root,
          "stashResult",
          id,
          chunks,
          ttlSeconds,
          self.scope.subjectKey ? scopes.subject(self.scope.subjectKey) : scopes.results,
        ),
      recheckResultAccess: (self, dependencies, classification, signal) =>
        Effect.tryPromise({
          try: () => self.scope.currentResultAccess?.(dependencies, classification, signal) ?? Promise.resolve(true),
          catch: (error) => error,
        }),
      getTools: (self, ...args) =>
        Effect.gen(function* () {
          const registry = self.registryFor(args[0]);
          if (!registry) {
            throw new Error(`Unknown connector "${args[0]}"`);
          }
          const tools = yield* registryProgram(registry, "getTools", args[0], args[1], args[2], args[3], self.scope);
          const granted = self.scope.toolAccess?.get(args[0]);
          if (!granted) return tools;
          // Every consumer — search, describe, call_tool, and a program's
          // connecta.call — resolves through this list, so an ungranted tool is
          // indistinguishable from one the connector never had.
          const visible = tools.filter((tool) => granted.has(tool.name));
          if (visible.length < granted.size) {
            const present = new Set(tools.map((tool) => tool.name));
            for (const name of granted) {
              if (!present.has(name)) self.root.noteAbsentGrant(args[0], name);
            }
          }
          return carryCatalogFreshness(tools, visible);
        }),
      credentialDriftFor: (self, id) =>
        Effect.suspend(() => {
          const registry = self.registryFor(id);
          return registry ? registryProgram(registry, "credentialDriftFor", id) : Effect.succeed(undefined);
        }),
      statusFor: (self, ...args) =>
        Effect.suspend(() => {
          const registry = self.registryFor(args[0]);
          return registry
            ? registryProgram(registry, "statusFor", args[0], args[1], args[2], args[3], self.scope)
            : Effect.succeed({ state: "error", message: "Unknown connector" });
        }),
      invalidateStored: (self, id) =>
        Effect.suspend(() => {
          const registry = self.registryFor(id);
          return registry ? registryProgram(registry, "invalidateStored", id) : Effect.succeed(undefined);
        }),
      bindOAuthHandoff: (self, id, authorizationUrl, principalKey) =>
        registryProgram(self.root, "bindOAuthHandoff", id, authorizationUrl, principalKey ?? self.scope.principalKey),
    });
  }
}
