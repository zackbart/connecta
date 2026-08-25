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
  closeConnectorScope,
  type DeferredWork,
} from "./connector-scope.js";
import {
  recordCatalogDriftActivity,
  type CatalogDriftActivityContext,
} from "./activity.js";
import {
  storedCredentialShape,
  type CredentialVault,
} from "./credentials.js";
import { ConnectorCallError, msg } from "./errors.js";
import {
  ConnectorCallAdmissionController,
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
import { mapSettledWithConcurrency } from "./concurrency.js";
import { ObservedOutputSchemas } from "./result-shapes.js";
import {
  GUIDE_SUMMARY_LENGTH,
  normalizeGuideSummary,
} from "./skills.js";
import { withDeadline } from "./timeout.js";

const ID_RE = /^[a-z0-9_-]+$/;
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_STALE_SECONDS = 3600;
const CATALOG_CHUNK_TTL_GRACE_SECONDS = 300;
const DEFAULT_MAX_RESULT_BYTES = 50_000;
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
  promise: Promise<ToolDef[]>;
  /** One caught/logged tail shared by every stale reader that joins. */
  deferredTail?: Promise<void>;
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

export interface RegistryOptions {
  storage: KVStorage;
  logger: Logger;
  credentialVault?: CredentialVault | undefined;
  toolCacheTtlSeconds?: number | undefined;
  persistToolCatalog?: boolean | undefined;
  toolCatalogStaleSeconds?: number | undefined;
  /**
   * Cap on inline result size before truncation + get_result paging. Must be a
   * whole number of bytes >= 1; anything else warns at startup and falls back
   * to the default 50_000.
   */
  maxResultBytes?: number | undefined;
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
  /** Serialize persisted catalog set/delete operations within this isolate. */
  private readonly catalogMutations = new Map<string, Promise<void>>();
  /** Same-request cold loads share one promise without retaining the request.
   * See documentation/architecture.md#the-two-lifetimes. */
  private readonly requestCatalogLoads = new WeakMap<
    object,
    Map<string, Promise<ToolDef[]>>
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

  constructor(
    connectors: Connector[],
    private readonly opts: RegistryOptions,
  ) {
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
      if (!ID_RE.test(c.id)) {
        throw new Error(
          `Invalid connector id "${c.id}": must match ${ID_RE.source}`,
        );
      }
      if (this.connectors.has(c.id)) {
        throw new Error(`Duplicate connector id "${c.id}"`);
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
    this.checkConventions(opts.logger);
    this.checkResultCaps(opts.logger, opts.maxResultBytes);
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
        const values = await vault.getAll(id);
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
    return {
      storage: namespaced(this.opts.storage, `conn:${id}:`),
      logger: this.opts.logger,
      baseUrl,
      ...(credentialAccess ? { credential: credentialAccess } : {}),
      requestScope,
      ...callOptions,
    };
  }

  admitCall(
    id: string,
    input: { toolName: string; args: unknown; signal?: AbortSignal },
  ): Promise<CallAdmissionPermit> {
    const admission = this.callAdmission.get(id);
    if (admission) return admission.acquire(input);
    return Promise.resolve({ waitMs: 0, release() {} });
  }

  /** Payload-free aggregate state for the open health endpoint. */
  callAdmissionSnapshot(): Record<string, ConnectorCallAdmissionSnapshot> {
    return Object.fromEntries(
      [...this.callAdmission].map(([id, admission]) => [
        id,
        admission.snapshot(),
      ]),
    );
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
    recordCatalogDriftActivity(
      this.opts.catalogDriftActivity
        ? { ...this.opts.catalogDriftActivity, logger: this.opts.logger }
        : undefined,
      { connectorId: connector.id, ...counts },
    );
  }

  /** Reject queued/future downstream admission; active permits release safely. */
  closeCallAdmission(): void {
    for (const admission of this.callAdmission.values()) admission.close();
  }

  /**
   * Storage namespaced to the meta-tool result store (`results:` prefix), kept
   * separate from any connector's `conn:<id>:` namespace. Backs get_result.
   */
  resultsStorage(): KVStorage {
    return namespaced(this.opts.storage, "results:");
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

  private async readCatalog(
    id: string,
    raw: string | null,
    now: number,
  ): Promise<PersistedCatalog | null> {
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const manifest = this.validCatalogManifest(parsed);
    if (!manifest) {
      this.opts.logger.warn(
        `[connecta] connector "${id}" catalog manifest is invalid; ignoring persisted catalog.`,
      );
      return null;
    }
    if (manifest.staleUntil <= now) return null;

    const chunkReads = await mapSettledWithConcurrency(
      Array.from({ length: manifest.chunkCount }, (_, index) => index),
      CATALOG_CHUNK_IO_CONCURRENCY,
      (index) =>
        this.opts.storage.get(
          this.catalogChunkKey(id, manifest.revision, index),
        ),
    );
    const chunks: string[] = [];
    let chunkBytes = 0;
    for (const [index, result] of chunkReads.entries()) {
      if (result.status === "rejected") throw result.reason;
      const chunk = result.value;
      if (chunk === null) {
        this.opts.logger.warn(
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
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog chunk bounds do not match its manifest; ignoring persisted catalog.`,
        );
        return null;
      }
      chunks.push(chunk);
    }

    const serializedTools = chunks.join("");
    const stored = await fingerprintSerializedCatalog(serializedTools);
    if (
      stored.byteLength !== manifest.byteCount ||
      stored.fingerprint !== manifest.revision
    ) {
      this.opts.logger.warn(
        `[connecta] connector "${id}" catalog fingerprint mismatch; ignoring persisted catalog.`,
      );
      return null;
    }

    let tools: unknown;
    try {
      tools = JSON.parse(serializedTools);
    } catch {
      this.opts.logger.warn(
        `[connecta] connector "${id}" catalog chunks are torn; ignoring persisted catalog.`,
      );
      return null;
    }
    if (!Array.isArray(tools) || !this.validCatalogTools(tools)) {
      this.opts.logger.warn(
        `[connecta] connector "${id}" catalog chunks contain invalid tools; ignoring persisted catalog.`,
      );
      return null;
    }
    if (tools.length !== manifest.toolCount) {
      this.opts.logger.warn(
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
  }

  private async storeCatalog(
    id: string,
    snapshot: CatalogSnapshot,
  ): Promise<void> {
    if (!this.persistToolCatalog) return;
    const fetchedAt = Date.now();
    const expiresAt = fetchedAt + this.ttlMs;
    const staleUntil = expiresAt + this.staleMs;
    const ttlSeconds = Math.max(
      60,
      Math.ceil((this.ttlMs + this.staleMs) / 1000),
    );
    const chunks = this.splitCatalogChunks(snapshot);
    const chunkWrites = await mapSettledWithConcurrency(
      chunks,
      CATALOG_CHUNK_IO_CONCURRENCY,
      (chunk, index) =>
        this.opts.storage.set(
          this.catalogChunkKey(id, snapshot.fingerprint, index),
          chunk,
          { ttlSeconds: ttlSeconds + CATALOG_CHUNK_TTL_GRACE_SECONDS },
        ),
    );
    for (const result of chunkWrites) {
      if (result.status === "rejected") throw result.reason;
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
    await this.opts.storage.set(this.catalogKey(id), JSON.stringify(manifest), {
      ttlSeconds,
    });
  }

  private async deleteCatalog(id: string): Promise<void> {
    let raw: string | null = null;
    let readError: unknown;
    try {
      raw = await this.opts.storage.get(this.catalogKey(id));
    } catch (err) {
      readError = err;
    }
    const manifest = this.parseCatalogManifest(raw);
    // The root is authoritative, so attempt its deletion even when the
    // best-effort read needed for physical chunk cleanup failed.
    await this.opts.storage.delete(this.catalogKey(id));
    if (!manifest) {
      if (readError) throw readError;
      return;
    }
    let firstError: unknown;
    for (let index = 0; index < manifest.chunkCount; index++) {
      try {
        await this.opts.storage.delete(
          this.catalogChunkKey(id, manifest.revision, index),
        );
      } catch (err) {
        firstError ??= err;
      }
    }
    if (readError) throw readError;
    if (firstError) throw firstError;
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
  private enqueueCatalogMutation(
    id: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.catalogMutations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.catalogMutations.set(id, next);
    void next
      .finally(() => {
        if (this.catalogMutations.get(id) === next) {
          this.catalogMutations.delete(id);
        }
      })
      .catch(() => {});
    return next;
  }

  private async refreshToolsWithContext(
    id: string,
    connector: Connector,
    ctx: ConnectorContext,
    skipPublicationWhenAborted = false,
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
    // credential/OAuth change that landed while listTools was in flight means
    // the listing must not enter either shared cache layer.
    if (generation !== this.catalogGeneration(id)) return tools;
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
      generation !== this.catalogGeneration(id) ||
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
      await this.enqueueCatalogMutation(id, async () => {
        if (generation !== this.catalogGeneration(id)) return;
        try {
          await this.storeCatalog(id, snapshot);
        } catch (err) {
          this.opts.logger.warn(
            `[connecta] connector "${id}" catalog persistence failed: ${msg(err)}`,
          );
        }
      });
    }
    return tools;
  }

  /**
   * Publish one shared refresh promise before starting its connector work.
   * The first caller owns the scope and deadline; every later caller joins the
   * result without gaining access to that context.
   */
  private startCatalogRefresh(
    id: string,
    generation: number,
    start: () => Promise<ToolDef[]>,
    finish?: () => Promise<void>,
  ): CatalogRefreshFlight {
    const existing = this.catalogRefreshes.get(id);
    if (existing?.generation === generation) return existing;
    let resolveWork!: (tools: ToolDef[]) => void;
    let rejectWork!: (reason?: unknown) => void;
    const work = new Promise<ToolDef[]>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    let flight!: CatalogRefreshFlight;
    const promise = work
      .finally(async () => {
        if (finish) await finish();
      })
      .finally(() => {
        if (this.catalogRefreshes.get(id) === flight) {
          this.catalogRefreshes.delete(id);
        }
      });
    flight = { generation, promise };
    this.catalogRefreshes.set(id, flight);
    try {
      Promise.resolve(start()).then(resolveWork, rejectWork);
    } catch (err) {
      rejectWork(err);
    }
    return flight;
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
    const ctx = this.contextFor(id, baseUrl, requestScope, callOptions);
    return this.startCatalogRefresh(id, this.catalogGeneration(id), () =>
      this.refreshToolsWithContext(id, connector, ctx),
    ).promise;
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
    if (!connector || connector.staticTools || !options.defer) return;
    let flight = this.catalogRefreshes.get(id);
    if (flight?.generation !== expectedGeneration) flight = undefined;
    if (!flight) {
      const requestScope = {};
      let ctx: ConnectorContext | undefined;
      flight = this.startCatalogRefresh(
        id,
        expectedGeneration,
        () =>
          withDeadline(
            (signal) => {
              const current = this.cache.get(id);
              if (current && current.exp > Date.now()) {
                return Promise.resolve(current.tools);
              }
              if (
                expectedGeneration !== this.catalogGeneration(id) ||
                this.invalidated.has(id)
              ) {
                return Promise.reject(
                  new Error(
                    `Deferred catalog refresh of "${id}" was invalidated before it started.`,
                  ),
                );
              }
              ctx = this.contextFor(id, baseUrl, requestScope, {
                signal,
                timeoutMs: options.refreshTimeoutMs,
              });
              return this.refreshToolsWithContext(id, connector, ctx, true);
            },
            {
              timeoutMs: options.refreshTimeoutMs,
              timeoutError: new Error(
                `deferred catalog refresh of "${id}" timed out after ${options.refreshTimeoutMs}ms`,
              ),
            },
          ),
        async () => {
          if (ctx) await closeConnectorScope(connector, ctx, options.defer);
        },
      );
    }
    if (!flight.deferredTail) {
      // Attach the rejection handler before handing the tail to waitUntil.
      flight.deferredTail = flight.promise.then(
        () => {},
        (err) => {
          this.opts.logger.warn(
            `[connecta] connector "${id}" deferred catalog refresh failed: ${msg(err)}`,
          );
        },
      );
    }
    try {
      options.defer(flight.deferredTail);
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
        persisted = await this.readCatalog(
          id,
          await this.opts.storage.get(this.catalogKey(id)),
          now,
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
   * The deployment-wide flight below this layer coalesces the actual live
   * refresh across requests. Its first caller's context and deadline govern;
   * later callers join only its result, never its request scope.
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
    const existing = loads.get(id);
    if (existing) return existing;
    const loading = this.loadTools(
      id,
      baseUrl,
      requestScope,
      callOptions,
      readOptions,
    );
    loads.set(id, loading);
    try {
      return await loading;
    } finally {
      if (loads.get(id) === loading) loads.delete(id);
      if (loads.size === 0) this.requestCatalogLoads.delete(requestScope);
    }
  }

  async credentialDriftFor(id: string): Promise<string | undefined> {
    const credential = this.connectors.get(id)?.credential;
    const vault = this.opts.credentialVault;
    if (!credential || !vault) return undefined;
    try {
      const values = await vault.getAll(id);
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
        ...(status.authorizationUrl !== undefined
          ? { authorizationUrl: status.authorizationUrl }
          : {}),
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
    return this.enqueueCatalogMutation(id, async () => {
      try {
        await this.deleteCatalog(id);
      } catch (err) {
        this.opts.logger.warn(
          `[connecta] connector "${id}" catalog invalidation failed: ${msg(err)}`,
        );
      }
    });
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
