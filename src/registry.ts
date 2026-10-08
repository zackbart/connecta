import { markCatalogFreshness, carryCatalogFreshness } from "./catalog-freshness.js";
import { activityRequest } from "./activity-request.js";
import type { CatalogDriftActivityContext } from "./activity.js";
import {
  attachCatalogCache,
  catalogExpiry,
  customCatalogFallback,
  storeCustomCatalogFallback,
  catalogFetchedAt,
  invalidateCatalogCache,
  observeUncachedCatalogRefresh,
  type CatalogToolFingerprint,
} from "./catalog-cache.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { assertStaticToolNames, hasControlCharacters } from "./tool-name.js";
import { Clock, Duration, Effect, Random } from "effect";
import type { CredentialVault } from "./credential-contract.js";
import type {
  CatalogAccessObservation,
  CatalogDriftReport,
  Connector,
  ConnectorContext,
  ConnectorStatus,
  KVStorage,
  Logger,
  ToolDef,
} from "./types.js";
import { storedCredentialShape } from "./credential-rules.js";
import { ConnectorCallError } from "./errors.js";
import { boundedStatus, failureRecord, failureStatus, logFailure, ownStatus } from "./operator-record.js";
import {
  ConnectorCallAdmissionController,
  aggregateCallAdmissionSnapshots,
  type CallAdmissionPermit,
  type ConnectorCallAdmissionSnapshot,
} from "./call-admission.js";
import {
  boundedCatalogDrift,
  catalogReviewOf,
  classifyCatalog,
  observeReviewedDrift,
  observedCatalogDrift,
} from "./catalog-drift.js";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "./catalog-limits.js";
import { ObservedOutputSchemas } from "./result-shapes.js";
import { redactCatalog, sentSecretsFor, sentSecretsForRequest, trackCredentialReads } from "./sent-secrets.js";
import { GUIDE_SUMMARY_LENGTH, normalizeGuideSummary } from "./skills.js";
import { attachOAuthSealer, vaultOAuthSealer } from "./oauth-sealing.js";
import { attachOAuthPartition, oauthPartitionIdle } from "./oauth-partition.js";
import { attachCaller, type ConnectorCaller } from "./connector-caller.js";
import { runEdge } from "./runtime/run.js";
import { SharedRead } from "./runtime/shared-read.js";
import { type Storage } from "./runtime/services.js";
import { runOnPartition, storageCompareAndSet, storageDelete, storageGet, storageSet } from "./runtime/storage.js";
import {
  jsonCodec,
  OAUTH_HANDOFF_TTL_SECONDS,
  oauthHandoffKeys,
  resultKeys,
  scopes,
  stashLedgerKeys,
} from "./storage/keys.js";
import { classifyTool } from "./tool-safety.js";

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

/** Freeze registry-owned facts so review digest memoization remains valid. */
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
  classification?: Readonly<Record<string, Readonly<Record<string, "read" | "write">>>> | undefined;
  storage: KVStorage;
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
  return {
    get: (k) => storage.get(prefix + k),
    set: (k, v, o) => storage.set(prefix + k, v, o),
    delete: (k) => storage.delete(prefix + k),
    list: async (keyPrefix) => (await storage.list(prefix + keyPrefix)).map((key) => key.slice(prefix.length)),
    compareAndSet: (k, expected, next, o) => storage.compareAndSet(prefix + k, expected, next, o),
  };
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
  /** Recheck live auth/grants and pool admission before exposing stored data. */
  recheckResultAccess(address: string, classification: "read" | "write", signal?: AbortSignal): Promise<boolean>;
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
  invalidateStored(id: string): Promise<void>;
  /** Bind returned OAuth state to its initiating user for either owner scope. */
  bindOAuthHandoff(id: string, authorizationUrl: string, principalKey?: string): Promise<void>;
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
  guardedToolAccess?: ToolAccess;
  subjectKey?: string;
  principalKey?: string;
  endpoint?: string;
  origin?: string | null;
  currentResultAccess?: (address: string, classification: "read" | "write", signal?: AbortSignal) => Promise<boolean>;
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
/**
 * Slack past the latest possible chunk expiry before its charge leaves the
 * ledger, and the longest one chunk write may take before the stash fails.
 * A failed write can still persist, so its completion also bounds expiry.
 */
const STASH_LEDGER_GRACE_MS = 30_000;

/** One live stash charge: its header key, bytes, and expiry (epoch ms). */
type StashCharge = readonly [key: string, bytes: number, expiresAt: number];

/**
 * Live charges in a stored ledger. Anything malformed reads as empty: the
 * ledger bounds an advisory cache, and the next successful swap replaces it.
 */
function liveStashCharges(raw: string | null, now: number): StashCharge[] {
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
      typeof entry[2] === "number" &&
      entry[2] > now,
  );
}

/**
 * Rewrite the stash ledger by compare-and-set. `plan` sees the live charges
 * and the time it read them at, and answers its result with the entries to
 * store, or without them when there is nothing to write. Only `plan` refuses:
 * a lost swap backs off and plans again from a fresh read. Answers undefined
 * once the attempts run out.
 */
function swapStashLedger<A>(
  plan: (live: StashCharge[], now: number) => { readonly entries?: StashCharge[]; readonly result: A },
): Effect.Effect<A | undefined, unknown, Storage> {
  return Effect.gen(function* () {
    const ledger = stashLedgerKeys.ledger;
    for (let attempt = 0; attempt < STASH_LEDGER_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const window = Math.min(STASH_LEDGER_BACKOFF_CAP_MS, STASH_LEDGER_BACKOFF_MS * 2 ** (attempt - 1));
        yield* Effect.sleep(Duration.millis(Math.floor((yield* Random.next) * window) + 1));
      }
      const raw = yield* storageGet(ledger);
      const now = yield* Clock.currentTimeMillis;
      const planned = plan(liveStashCharges(raw, now), now);
      if (planned.entries === undefined) return planned.result;
      if (yield* storageCompareAndSet(ledger, raw, jsonCodec.encode({ v: 1, entries: planned.entries }))) {
        return planned.result;
      }
    }
    return undefined;
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
  /** Count-only intake findings, including catalogs loaded from storage. */
  private droppedToolNames = new Map<string, { count: number; observedAt: string }>();
  /**
   * Schema digest verification per reviewed facts array. Only the registry's
   * own deep-frozen arrays are keys, so an entry stays true while they live.
   */
  private readonly verifiedFacts = new WeakMap<readonly ToolDef[], ReadonlySet<string>>();
  private readonly observedOutputSchemas: ObservedOutputSchemas;
  /** Result-size guard cap threaded to the meta-tools. */
  readonly maxResultBytes: number;
  private readonly classification: Readonly<Record<string, Readonly<Record<string, "read" | "write">>>>;
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
      // Validated here, before any request (INV-11), and read once per
      // connector object.
      if (catalogReviewOf(c) && c.staticTools) {
        throw new Error(
          `Connector "${c.id}" declares both staticTools and a classification; ` + "annotate static tools directly.",
        );
      }
      this.connectors.set(c.id, c);
      if (c.callAdmission) {
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
        if (!name || (verdict !== "read" && verdict !== "write")) {
          throw new Error(`ConnectaConfig.classification.${id}.${name}: expected "read" or "write"`);
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
        credentialOwner: principalKey,
        catalogStorage: this.opts.catalogStorage ?? this.opts.storage,
        constructionChecks: false,
      },
    );
    // Counts only, like the connector-wide reviewed drift observation. No
    // principal, credentials, or catalog payload crosses this registry boundary.
    registry.droppedToolNames = this.droppedToolNames;
    if (this.callAdmissionClosed) registry.closeCallAdmission();
    this.personalRegistries.set(principalKey, registry);
    return registry;
  }

  /** Build the only connector view an authenticated request receives. */
  scoped(scope: RegistryScope): RegistryView {
    const requested = scope.connectorIds === "all" ? new Set(this.connectors.keys()) : new Set(scope.connectorIds);
    for (const id of requested) {
      if (!this.connectors.has(id)) {
        throw new Error(`Identity access resolver returned unknown connector "${id}"`);
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
      logFailure(this.opts.logger, "connectorAccess grant is unreachable", failureRecord({ connector: connectorId }));
      return;
    }
    // Grant names are operator data but may carry any non-control character;
    // quote them so a line terminator a log reader honours cannot forge a line.
    const quoted = JSON.stringify(key).replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
    this.opts.logger.warn(
      `connectorAccess grants ${quoted} but connector "${connectorId}" lists no such tool; the grant is unreachable`,
    );
  }

  async storeOAuthHandoff(connectorId: string, state: string, principalKey: string): Promise<void> {
    const key = oauthHandoffKeys.handoff(connectorId, await sha256Hex(state));
    for (let attempt = 0; attempt < 32; attempt++) {
      const existing = await this.opts.storage.get(key);
      if (existing && existing !== principalKey) {
        throw new Error(`Connector "${connectorId}" reused one OAuth state across principals`);
      }
      // Bind ownership atomically, including renewal of the same owner's
      // handoff. Two owners reading a miss must not overwrite each other.
      if (
        await this.opts.storage.compareAndSet(key, existing, principalKey, {
          ttlSeconds: OAUTH_HANDOFF_TTL_SECONDS,
        })
      )
        return;
    }
    throw new Error(`OAuth handoff for "${connectorId}" is busy; retry authorization`);
  }

  async oauthCallbackView(
    connectorId: string,
    state: string | null,
  ): Promise<{
    registry: RegistryView;
    principalKey?: string;
  } | null> {
    if (!state) return null;
    const principalKey = await this.opts.storage.get(oauthHandoffKeys.handoff(connectorId, await sha256Hex(state)));
    const connector = this.connectors.get(connectorId);
    if (!connector || !principalKey) return null;
    return {
      registry:
        connector.authScope === "personal"
          ? this.scoped({
              connectorIds: [connectorId],
              subjectKey: principalKey,
              principalKey,
            })
          : this,
      principalKey,
    };
  }

  async consumeOAuthHandoff(connectorId: string, state: string | null, principalKey: string): Promise<boolean> {
    if (!state) return false;
    const key = oauthHandoffKeys.handoff(connectorId, await sha256Hex(state));
    return this.opts.storage.compareAndSet(key, principalKey, null);
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
        get: async (field = "value") => {
          const values = await readValues();
          return values && Object.hasOwn(values, field) ? values[field]! : null;
        },
        getAll: readValues,
      };
    }
    const context: ConnectorContext = {
      storage: namespaced(this.opts.storage, scopes.connector(id)),
      logger: this.opts.logger,
      baseUrl,
      ...(this.opts.publicUrl !== undefined ? { publicUrl: this.opts.publicUrl } : {}),
      ...(this.opts.oauthClientName !== undefined ? { oauthClientName: this.opts.oauthClientName } : {}),
      ...(credentialAccess ? { credential: credentialAccess } : {}),
      requestScope,
      ...callOptions,
    };
    attachCaller(context, scope?.caller);
    attachCatalogCache(context, {
      storage: this.opts.catalogStorage ?? this.opts.storage,
      partition: JSON.stringify([
        scope?.principalKey ?? this.opts.credentialOwner ?? null,
        scope?.subjectKey ?? null,
        scope?.caller?.identity ?? null,
        scope?.caller?.authenticated ?? false,
        scope?.caller?.pool ?? null,
      ]),
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

  /**
   * The drift a connector last showed in this runtime: the registry's own
   * observation against a connector's `classification`, otherwise whatever
   * the connector's `catalogDrift()` seam reports, bounded either way.
   */
  private catalogDriftOf(connector: Connector): CatalogDriftReport | undefined {
    const report = boundedCatalogDrift(
      catalogReviewOf(connector) ? observedCatalogDrift(connector) : connector.catalogDrift?.(),
    );
    const dropped = this.droppedToolNames.get(connector.id);
    if (!dropped) return report;
    return {
      ...(report ?? {
        unclassifiedTools: 0,
        unservedTools: 0,
        annotationConflicts: 0,
        schemaChanges: 0,
      }),
      observedAt: dropped.observedAt,
      ...(dropped.count > 0 ? { droppedTools: dropped.count } : {}),
    };
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
   * same entries and bytes. A pending write keeps its charge reserved; after
   * writing, the charge expires past every chunk's possible expiry. The
   * storage TTL reclaims the rows themselves.
   */
  stashResult(
    id: string,
    chunks: readonly string[],
    ttlSeconds: number,
    partition: string = scopes.results,
  ): Promise<boolean> {
    return runOnPartition(
      Effect.gen({ self: this }, function* () {
        const maxBytes = this.opts.results?.maxStashBytes ?? CONFIG_DEFAULTS.results.maxStashBytes;
        const maxEntries = this.opts.results?.maxStashEntries ?? CONFIG_DEFAULTS.results.maxStashEntries;
        // The paging envelope is ASCII, so its string length is its stored byte count.
        const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (bytes > maxBytes || maxEntries === 0) return false;
        const keys = chunks.map((_, index) => partition + resultKeys.chunk(id, index));
        const charge = keys[0]!;
        // Chunk TTLs use one deadline. Reserve the charge while writes are
        // pending: a slow write can persist after any precomputed expiry.
        // Once every write settles, replace the reservation with a deadline
        // covering the latest possible chunk expiry, including failed writes.
        const deadline = yield* swapStashLedger((live, now) => {
          const used = live.reduce((sum, entry) => sum + entry[1], 0);
          if (live.length >= maxEntries || used + bytes > maxBytes) return { result: undefined };
          const end = now + ttlSeconds * 1000;
          return { entries: [...live, [charge, bytes, Number.MAX_SAFE_INTEGER]], result: end };
        });
        if (deadline === undefined) return false;
        let expiresAt = deadline + STASH_LEDGER_GRACE_MS;
        const settle = swapStashLedger((live) => ({
          entries: live.map((entry) => (entry[0] === charge ? [charge, bytes, expiresAt] : entry)),
          result: undefined,
        })).pipe(Effect.ignore);
        // A failed write may still have persisted. Delete every key it could
        // have written and release the charge only when all of them are gone;
        // otherwise the charge stays booked until it expires, by which time the
        // storage TTL has removed whatever did land.
        const release = Effect.gen(function* () {
          for (const key of keys) yield* storageDelete(key);
          yield* swapStashLedger((live) =>
            live.some((entry) => entry[0] === charge)
              ? { entries: live.filter((entry) => entry[0] !== charge), result: undefined }
              : { result: undefined },
          );
        }).pipe(
          Effect.catch(() => settle),
          Effect.ignore,
        );
        // Trailing chunks first: the header chunk is what makes an id readable, so
        // a write that fails midway leaves no envelope pointing at absent chunks.
        const written = yield* Effect.gen(function* () {
          for (let index = keys.length - 1; index >= 0; index--) {
            const before = yield* Clock.currentTimeMillis;
            const remaining = Math.floor((deadline - before) / 1000);
            // Zero would mean no expiry: a stash that outlasts its deadline fails.
            if (remaining < 1) return false;
            yield* storageSet(keys[index]!, chunks[index]!, { ttlSeconds: remaining }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  // A relative TTL starts no later than the write settles. Keep
                  // this bound even if the store persisted and then rejected.
                  const after = yield* Clock.currentTimeMillis;
                  expiresAt = Math.max(expiresAt, after + remaining * 1000 + STASH_LEDGER_GRACE_MS);
                }),
              ),
            );
            if ((yield* Clock.currentTimeMillis) - before > STASH_LEDGER_GRACE_MS) return false;
          }
          return true;
        }).pipe(Effect.onError(() => release));
        if (!written) yield* release;
        else yield* settle;
        return written;
      }),
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

  recheckResultAccess(_address: string, _classification: "read" | "write", _signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve(true);
  }

  resultsStorage(): KVStorage {
    return namespaced(this.opts.storage, scopes.results);
  }

  credentialUiAvailable(): boolean {
    return Boolean(this.opts.credentialUi);
  }

  async bindOAuthHandoff(id: string, authorizationUrl: string, principalKey?: string): Promise<void> {
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state || !principalKey) throw new Error("OAuth requires state and an initiating user");
    await this.storeOAuthHandoff(id, state, principalKey);
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

  private async loadDownstreamTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    if (connector.staticTools) return markCatalogFreshness(connector.staticTools, Infinity);
    const ctx = this.contextFor(id, baseUrl, requestScope, callOptions, scope);
    let listed: ToolDef[];
    try {
      listed = await connector.listTools(ctx);
    } catch (error) {
      const fallback =
        error instanceof ConnectorCallError && error.code === "unavailable"
          ? await customCatalogFallback(ctx, id).catch(() => undefined)
          : undefined;
      if (!fallback) throw sentSecretsForRequest(ctx.requestScope ?? ctx).redact(error);
      listed = fallback;
    }
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
    this.observeDroppedToolNames(connector, facts.length - accepted.length);
    const review = catalogReviewOf(connector);
    if (review) await observeReviewedDrift(connector, review, accepted, this.opts.logger);
    if (catalogFetchedAt(ctx) === undefined) {
      try {
        await storeCustomCatalogFallback(ctx, id, facts);
      } catch (error) {
        logFailure(this.opts.logger, "catalog refresh observation failed", failureRecord({ connector: id }, error));
      }
      try {
        await observeUncachedCatalogRefresh(ctx, id, facts);
      } catch (error) {
        logFailure(this.opts.logger, "catalog refresh observation failed", failureRecord({ connector: id }, error));
      }
    }
    this.catalogObservedAt.set(id, catalogFetchedAt(ctx) ?? Date.now());
    const provenance = catalogExpiry(ctx);
    const freshUntil = provenance && !provenance.staleFallback ? provenance.expiresAt : 0;
    this.catalogAccess.set(id, {
      state: freshUntil > Date.now() ? "fresh" : "stale",
      observedAt: new Date().toISOString(),
    });
    return markCatalogFreshness(facts, freshUntil);
  }

  /** The served catalog excludes control-character names; raw caches stay complete. */
  private acceptToolNames(tools: ToolDef[]): ToolDef[] {
    const accepted = tools.filter((tool) => !hasControlCharacters(tool.name));
    return accepted.length === tools.length ? tools : accepted;
  }

  /** Observe intake once, never while serving an older cached listing. */
  private observeDroppedToolNames(connector: Connector, count: number): void {
    if (count > 0 || this.droppedToolNames.has(connector.id)) {
      this.droppedToolNames.set(connector.id, { count, observedAt: new Date().toISOString() });
    }
  }

  /**
   * One connector's catalog as served: the cached downstream facts, classified
   * on every read by the connector's `classification`, into fresh objects.
   * Safety is derived here and nowhere else, so no cache layer can carry a
   * stale verdict — from an older review, an older release, or a stale
   * fallback — and nothing a caller or decorator does to a served tool reaches
   * the next read.
   */
  private async loadTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Promise<ToolDef[]> {
    const tools = await this.loadDownstreamTools(id, baseUrl, requestScope, callOptions, scope);
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    const accepted = this.acceptToolNames(tools);
    const overrides = this.classification[id];
    this.validateClassification(id, accepted, overrides);
    const review = catalogReviewOf(connector);
    return carryCatalogFreshness(
      tools,
      review
        ? await classifyCatalog(review, id, accepted, this.opts.logger, this.verifiedFacts, overrides)
        : accepted.map((tool) => this.publishUnreviewedTool(id, tool)),
    );
  }

  private publishUnreviewedTool(id: string, tool: ToolDef): ToolDef {
    const override = this.classification[id]?.[tool.name];
    return {
      ...structuredClone(tool),
      classification: classifyTool(tool, override),
      ...(override !== undefined
        ? {
            annotations: {
              ...structuredClone(tool.annotations),
              readOnlyHint: override === "read",
              destructiveHint: override === "write",
            },
          }
        : {}),
    };
  }

  /** Construction-only view for the secret-free static config description. */
  describeStaticTools(id: string): ToolDef[] | undefined {
    const tools = this.connectors.get(id)?.staticTools;
    return tools?.map((tool) => this.publishUnreviewedTool(id, tool));
  }

  private validateClassification(
    id: string,
    tools: readonly ToolDef[],
    overrides?: Readonly<Record<string, "read" | "write">>,
  ): void {
    const known = new Set(tools.map((tool) => tool.name));
    for (const name of Object.keys(overrides ?? {})) {
      if (!known.has(name)) throw new Error(`ConnectaConfig.classification: connector "${id}" has no tool "${name}"`);
    }
  }

  async getTools(
    id: string,
    baseUrl: string,
    requestScope?: object,
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Promise<ToolDef[]> {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`Unknown connector "${id}"`);
    if (!requestScope) {
      return this.loadTools(id, baseUrl, requestScope, callOptions, scope);
    }

    let loads = this.requestCatalogLoads.get(requestScope);
    if (!loads) {
      loads = new Map();
      this.requestCatalogLoads.set(requestScope, loads);
    }
    const requestLoads = loads;
    const key = JSON.stringify([id, scope?.principalKey, scope?.subjectKey, scope?.caller]);
    let load = requestLoads.get(key);
    if (!load) {
      const started: SharedRead<ToolDef[]> = new SharedRead(
        (signal) => this.loadTools(id, baseUrl, requestScope, { ...callOptions, signal }, scope),
        // Settled or cancelled, the read leaves the map before any caller
        // resumes, so the next one asks the caches afresh.
        () => {
          if (requestLoads.get(key) === started) requestLoads.delete(key);
          if (requestLoads.size === 0) {
            this.requestCatalogLoads.delete(requestScope);
          }
        },
      );
      requestLoads.set(key, started);
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
      logFailure(this.opts.logger, "credential shape read failed", failureRecord({ connector: id }, error));
      return undefined;
    }
  }

  /** Age of a complete cache entry; reads never refresh it. */
  catalogAgeMs(id: string): number | null {
    const observedAt = this.catalogObservedAt.get(id);
    return observedAt === undefined ? null : Math.max(0, Date.now() - observedAt);
  }

  /** Best-effort connector status for the operator UI. */
  async statusFor(
    id: string,
    baseUrl: string,
    requestScope: object = {},
    callOptions: ConnectorOperationOptions = {},
    scope?: RegistryScope,
  ): Promise<ConnectorStatus> {
    const connector = this.connectors.get(id);
    if (!connector) return ownStatus({ state: "error", message: "Unknown connector" });
    const ctx = this.contextFor(id, baseUrl, requestScope, callOptions, scope);
    // Whatever the state turns out to be, it carries the drift the last
    // refresh saw. Reading it is a lookup, not a probe: a connector that has
    // listed nothing yet reports nothing, and status never lists on its own to
    // make the field appear.
    // The report is rebuilt rather than spread through: what the seam returned
    // is third-party output, and status is read by the operator UI and copied
    // into responses.
    const withObservations = (status: ConnectorStatus): ConnectorStatus => {
      const report = this.catalogDriftOf(connector);
      const access = this.catalogAccess.get(id);
      // Connector.status is an open plugin seam. Rebuild its public fields so
      // a connector cannot smuggle payload through either registry-owned
      // observation when this runtime has not made one, nor through its
      // message, which survives only when connecta wrote it (INV-6).
      return Object.assign(boundedStatus(status), {
        ...(report ? { catalogDrift: report } : {}),
        ...(access ? { catalogAccess: { ...access } } : {}),
      });
    };
    // Credential declarations own their readiness even when a static catalog
    // or a plugin status would otherwise report success. Never probe an empty slot.
    if (connector.credential) {
      try {
        const values = (await this.opts.credentialVault?.getAll(id, this.opts.credentialOwner)) ?? null;
        const shape = storedCredentialShape(connector.credential, values);
        if (shape.state === "missing") return withObservations(ownStatus({ state: "credential_required" }));
        if (shape.state === "mismatch") return withObservations(ownStatus({ state: "auth_required" }));
      } catch (err) {
        return withObservations(failureStatus(id, err));
      }
    }
    if (connector.status) {
      try {
        return withObservations(await connector.status(ctx));
      } catch (err) {
        return withObservations(failureStatus(id, err));
      }
    }
    try {
      await this.getTools(id, baseUrl, requestScope, callOptions, scope);
      return withObservations({ state: "ok" });
    } catch (err) {
      return withObservations(failureStatus(id, err));
    }
  }

  /** Rotate the storage generation; in-flight old readers cannot republish it. */
  invalidate(id: string): void {
    void this.invalidateStored(id);
  }

  async invalidateStored(id: string): Promise<void> {
    this.catalogObservedAt.delete(id);
    try {
      await invalidateCatalogCache(this.opts.catalogStorage ?? this.opts.storage, id);
    } catch (error) {
      logFailure(this.opts.logger, "catalog invalidation failed", failureRecord({ connector: id }, error));
    }
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
    if (connector.authScope !== "personal") return this.root;
    return admission ? this.admissionPersonal : this.personal;
  }

  listConnectors(): Connector[] {
    return this.root.listConnectors().filter((connector) => this.registryFor(connector.id) !== undefined);
  }

  canReadConnectorSkills(id: string): boolean {
    return (
      this.registryFor(id) !== undefined && !this.scope.toolAccess?.has(id) && !this.scope.guardedToolAccess?.has(id)
    );
  }

  getConnector(id: string): Connector | undefined {
    return this.registryFor(id)?.getConnector(id);
  }

  getResourceConnector(id: string): Connector | undefined {
    if (this.scope.toolAccess?.has(id) || this.scope.guardedToolAccess?.has(id)) return undefined;
    return this.getConnector(id);
  }

  resolveAddress(address: string): { connector: Connector; toolName: string } | null {
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
    const tools = await registry.getTools(args[0], args[1], args[2], args[3], this.scope);
    const guarded = this.scope.guardedToolAccess?.get(args[0]);
    const granted = this.scope.toolAccess?.get(args[0]) ?? guarded;
    if (!granted) return tools;
    // Every consumer — search, describe, call_tool, and a program's
    // connecta.call — resolves through this list, so an ungranted tool is
    // indistinguishable from one the connector never had.
    const visible = tools.filter(
      (tool) => granted.has(tool.name) && (!guarded?.has(tool.name) || tool.classification === "read"),
    );
    if (visible.length < granted.size) {
      const present = new Set(tools.map((tool) => tool.name));
      for (const name of granted) {
        if (!present.has(name)) this.root.noteAbsentGrant(args[0], name);
      }
    }
    return carryCatalogFreshness(tools, visible);
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

  recheckResultAccess(address: string, classification: "read" | "write", signal?: AbortSignal): Promise<boolean> {
    return this.scope.currentResultAccess?.(address, classification, signal) ?? Promise.resolve(true);
  }

  resultsStorage(): KVStorage {
    return this.scope.subjectKey ? this.root.scopedStorage(this.scope.subjectKey) : this.root.resultsStorage();
  }

  credentialDriftFor(id: string): Promise<string | undefined> {
    const registry = this.registryFor(id);
    return registry ? registry.credentialDriftFor(id) : Promise.resolve(undefined);
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
    const registry = this.registryFor(args[0]);
    return registry
      ? registry.statusFor(args[0], args[1], args[2], args[3], this.scope)
      : Promise.resolve({ state: "error", message: "Unknown connector" });
  }

  invalidateStored(id: string): Promise<void> {
    const registry = this.registryFor(id);
    return registry ? registry.invalidateStored(id) : Promise.resolve();
  }

  credentialUiAvailable(): boolean {
    return this.root.credentialUiAvailable();
  }

  async bindOAuthHandoff(id: string, authorizationUrl: string, principalKey?: string): Promise<void> {
    await this.root.bindOAuthHandoff(id, authorizationUrl, principalKey ?? this.scope.principalKey);
  }
}
