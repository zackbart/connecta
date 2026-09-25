import type { CredentialVault } from "./credential-contract.js";
import {
  credentialTestRule,
  describeCredentialTestMismatch,
} from "./credential-rules.js";
import { Registry } from "./registry.js";
import { parseConnectorAccess, POOL_NAME_RE } from "./connector-access.js";
import type { ConnectorAccess, ResolvedPool } from "./connector-access.js";
import { createFetchHandler } from "./server.js";
import {
  droppedBrandingUrls,
  droppedThemeTokens,
  droppedUiAuthUrls,
} from "./branding.js";
import { memoryStorage } from "./storage/memory.js";
import { CONNECTA_VERSION } from "./version.js";
import {
  AdmissionController,
  executorName,
  isAdmittingExecutor,
  withExecutorAdmission,
} from "./executor-admission.js";
import type {
  ActivityModule,
  ArtifactsModule,
  OperatorSurface,
} from "./module-contracts.js";
import {
  DEFAULT_MAX_WRITES,
  DEFAULT_PAUSED_RUN_TTL_SECONDS,
} from "./resumable.js";
import { disposeEdgeRuntime } from "./runtime/run.js";
import { NO_EXEMPTIONS, type ApprovalPolicy } from "./tool-safety.js";
import { createCoreRuntime, resolveLogger } from "./runtime/services.js";
export type {
  ActivityModule,
  ArtifactsModule,
  OperatorSurface,
} from "./module-contracts.js";
export type { CredentialVault, CredentialMetadata } from "./credential-contract.js";
import type {
  AuthenticatedIdentity,
  Connector,
  Executor,
  IdentityReference,
  InboundAuth,
  KVStorage,
  Logger,
} from "./types.js";

// These types are the canonical record of the configuration surface: every
// field's default and operator-facing meaning belongs in its own doc comment
// below, where a deployment author reads it from the editor.

/** Tool-catalog caching, persistence, stale fallback, and probe deadlines. */
export interface ConnectaDiscoveryConfig {
  /**
   * Maximum connector catalogs/status probes fetched at once by discovery
   * operations. Default 4.
   */
  concurrency?: number;
  /** Tool-list cache TTL (seconds). Default 300. */
  catalogTtlSeconds?: number;
  /**
   * Persist serializable remote tool catalogs in storage so cold isolates can
   * discover tools without a downstream handshake. Default true.
   */
  persistCatalog?: boolean;
  /**
   * How long an expired persisted catalog remains available as a fallback
   * when a live refresh fails. Default 3600 seconds.
   */
  staleCatalogSeconds?: number;
  /**
   * Deadline (ms) for each downstream probe/catalog call fanned out by
   * `search_tools` and by `connecta.search`/`connecta.describe` inside
   * `execute_code`. Defaults to 30_000. A timed-out connector degrades
   * independently; this does not apply to tool calls. Catalog walks receive the
   * same cancellation signal, which aborts an in-flight page where supported and
   * prevents another from starting.
   */
  probeTimeoutMs?: number;
}

/** Deployment-wide call deadlines and inline-result paging thresholds. */
export interface ConnectaCallsConfig {
  /**
   * Deadline (ms) for `call_tool`/`call_destructive_tool` calls that pass no
   * `timeoutMs`. An explicit per-call value wins. Opt-in: unset by default, so
   * existing long-running calls gain no surprise deadline.
   *
   * Each call makes one attempt. `execute_code` host calls are
   * unaffected because they already carry their own bound.
   */
  defaultTimeoutMs?: number;
  /**
   * Max inline result size (bytes) before truncation and `get_result` paging.
   * Must be a finite whole number >= 1; invalid values warn and fall back to
   * 24_000. Connectors may override it individually.
   */
  maxResultBytes?: number;
}

/** Runtime-wide bounds for transient direct-call result paging. */
export interface ConnectaResultsConfig {
  /** Stored bytes, including the paging envelope. Default 8 MiB. Zero disables stashing. */
  maxStashBytes?: number;
  /** Stored or in-flight entries. Default 64. Zero disables stashing. */
  maxStashEntries?: number;
}

/** Budgets for execute_code programs: host calls and rich output (`connecta.emit`). */
export interface ConnectaExecuteConfig {
  /**
   * Aggregate serialized bytes `connecta.emit` accepts per run. Default
   * 4_000_000 — a transport bound, not a context bound: emitted image/audio
   * blocks reach the model as media, not base64 text. Invalid values fall
   * back to the default.
   */
  maxEmittedBytes?: number;
  /** Content blocks `connecta.emit` accepts per run. Default 32. */
  maxEmittedBlocks?: number;
  /**
   * Host calls one program may make. Default 20. Invalid values fall back to
   * the default.
   */
  maxHostCalls?: number;
  /**
   * Deadline for each host call a program makes, in milliseconds. Default
   * 15_000. Raise it for providers whose legitimate calls run longer, such as
   * analytics queries; `call_tool`'s own `timeoutMs` is unaffected. Invalid
   * values fall back to the default.
   */
  hostCallTimeoutMs?: number;
  /**
   * Hard ceiling on one execution, in milliseconds, enforced outside the
   * sandbox. Default 120_000, above both executors' own deadlines (QuickJS
   * 30_000, the Dynamic Worker 60_000), so it only ends a run whose executor
   * never settled; that run fails as unresponsive and its admission slot is
   * released. Keep it above any raised executor deadline. Invalid values
   * fall back to the default.
   */
  watchdogMs?: number;
  /**
   * Let programs write. A call to a tool that is not explicitly read-only
   * pauses the run before anything is sent and returns the exact write with
   * a token; `resume_execution` repeating it is the approval, and the
   * program replays from a journal to send it and continue. Needs `storage`
   * with `compareAndSet`, because two resumes of one pause must send its
   * writes at most once. Omitted, it is on exactly when the storage has one
   * (a single startup warning says when it is not); `true` over storage
   * without one refuses to construct; `false` keeps E4's refusal.
   * `resume_execution` is listed either way.
   */
  resumableWrites?: boolean;
  /**
   * Consequential calls one run may send, on top of the host-call budget
   * every call already spends. Default 10. A replayed write spends it again,
   * so it bounds the run, not each play. Invalid values fall back to the
   * default.
   */
  maxWrites?: number;
  /**
   * How long a paused run can be resumed, in seconds from its first pause.
   * Default 1_800. A later pause in the same run keeps the first deadline, so
   * a run never replays reads older than this. Invalid values fall back to
   * the default.
   */
  pausedRunTtlSeconds?: number;
  /**
   * Which writes a program may make without pausing for approval. Keys are
   * connector ids (all of that connector's tools) or `connector.tool`
   * addresses (that tool); values are `"never"` (never ask) or `"ask"`. The
   * most specific key wins, and `"ask"` switches off a connector's own
   * default. An exempt write still spends the write budget, is recorded in
   * activity, and is journaled like any other; it is never read-only
   * anywhere else — discovery still lists it as approval-required and
   * `call_tool` still refuses it. Works with resumable writes off too. An
   * unknown connector id, or an `api()` address its tools do not include,
   * refuses to construct; a remote connector's tool names load later, so an
   * address naming one it never serves simply never matches.
   */
  approval?: Readonly<Record<string, "never" | "ask">>;
}

export interface AdmissionPoolConfig {
  /** Simultaneous work admitted to this pool. */
  concurrency?: number;
  /** Callers allowed to wait behind active work. Set zero to fail fast. */
  maxQueueSize?: number;
  /** Maximum queue wait in milliseconds. */
  queueTimeoutMs?: number;
  /** Retry hint returned with overload failures, in milliseconds. */
  retryAfterMs?: number;
}

/**
 * Runtime-portable server-memory boundaries. `/health` and operator routes do
 * not consume these permits, so they remain responsive during MCP saturation.
 */
export interface ConnectaAdmissionConfig {
  /**
   * The `/mcp` request boundary. Defaults to 16 active, 32 queued, and a
   * 5-second maximum wait.
   */
  requests?: AdmissionPoolConfig;
  /**
   * Fallback pool for an `executor` that does not implement its own `acquire`.
   * Defaults to 2 active, 8 queued, and a 5-second maximum wait. Bounded
   * executors (including `quickJsExecutor`) keep their own tighter pool.
   */
  code?: AdmissionPoolConfig;
}

/** Config-owned identity rules for one deployment and tenant. */
export type ConnectorPermission = "all" | "none" | readonly string[];

export interface ConnectaIdentityConfig {
  /**
   * What this admitted identity may discover and call: `"all"`, or a list
   * whose entries are connector ids (the whole connector) and `connector.tool`
   * addresses (that tool only). Grants are additive. An address naming a tool
   * the catalog lacks is unreachable and warned once, never widened.
   */
  connectorAccess?(
    identity: Readonly<AuthenticatedIdentity>,
  ): "all" | readonly string[] | Promise<"all" | readonly string[]>;
  /** Global payload-free activity reads. Defaults to interactive humans. */
  activityAccess?(
    principal: Readonly<IdentityReference>,
  ): boolean | Promise<boolean>;
  /** Shared credential and OAuth administration. Defaults to none. */
  credentialAdministration?(
    identity: Readonly<AuthenticatedIdentity>,
  ): ConnectorPermission | Promise<ConnectorPermission>;
  /** Connecting or changing the caller's personal account. Defaults to none. */
  personalConnection?(
    identity: Readonly<AuthenticatedIdentity>,
  ): ConnectorPermission | Promise<ConnectorPermission>;

}

/**
 * A named tool pool served at `/mcp/<name>`. The pool is the slice a client
 * pointed at that endpoint may see; the identity's own `connectorAccess`
 * remains its ceiling and the pool can only narrow it.
 */
export interface ConnectaPoolConfig {
  /** Connector ids and exact `connector.tool` addresses in this pool. */
  tools: readonly string[];
  /**
   * Whether this admitted identity may open the pool. Denied by default:
   * a pool with no grant serves nobody. A false return, a throw, and an
   * undeclared pool name are the same 404.
   */
  grant?(identity: Readonly<AuthenticatedIdentity>): boolean | Promise<boolean>;
}

export interface ConnectaConfig {
  connectors: Connector[];
  /** Inbound auth adapters. Includes bearerToken(...); omit for open (dev). */
  auth?: InboundAuth | InboundAuth[];
  /** Code-derived connection visibility and independent management permissions. */
  identity?: ConnectaIdentityConfig;
  /** Named tool pools, each served at `/mcp/<name>` to identities its grant admits. */
  pools?: Record<string, ConnectaPoolConfig>;
  /** KVStorage impl. Defaults to memoryStorage(). */
  storage?: KVStorage;
  /**
   * Public base URL. Defaults to the request origin per-request. Configuring an
   * HTTPS URL also redirects matching inbound HTTP requests to HTTPS.
   */
  publicUrl?: string;
  /**
   * Exact browser MCP origins, or "*". Defaults to publicUrl's origin and
   * HTTP(S) loopback origins at any port. Originless clients are admitted.
   */
  allowedOrigins?: readonly string[] | "*";
  /** Optional recorder and reader, created by activityHistory() from /activity. */
  activity?: ActivityModule;
  /** Replaceable owner-partitioned credential storage. Omit for config-owned secrets. */
  vault?: CredentialVault;
  /** Optional connection UI, created by operatorUi() from /ui. */
  ui?: OperatorSurface;
  /**
   * Optional team pages over stored data, created by artifacts() from
   * /artifacts. Adds the built-in `artifacts` connector; needs `publicUrl`,
   * because the links it hands out are shared.
   */
  artifacts?: ArtifactsModule;
  /** Optional dedicated HTTPS origin that serves only artifact pages and their library. */
  artifactOrigin?: string;
  /** Tool-catalog caching, persistence, stale fallback, and probe deadlines. */
  discovery?: ConnectaDiscoveryConfig;
  /** Deployment-wide call deadlines and result paging threshold. */
  calls?: ConnectaCallsConfig;
  /** Runtime-wide transient result stash limits, shared across subjects. */
  results?: ConnectaResultsConfig;
  /** Budgets for the `connecta.emit` rich-output channel in execute_code. */
  execute?: ConnectaExecuteConfig;
  /** Bounded MCP and fallback code-mode admission. */
  admission?: ConnectaAdmissionConfig;
  /** Diagnostic output. Use "silent" to disable all diagnostic logging. */
  logger?: Logger | "silent";
  serverInfo?: {
    name?: string;
    version?: string;
    /** Human-readable name clients may show instead of `name`. */
    title?: string;
    /** Homepage clients may link from the server listing. */
    websiteUrl?: string;
    /** MCP icons-spec entries; clients render these instead of a scraped favicon. */
    icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
  };
  /** Deployment metadata exposed by /health (for example a Worker version). */
  deploymentInfo?: Record<string, unknown>;
  /**
   * Required sandbox for `execute_code`. Workers use
   * `new DynamicWorkerExecutor({ loader: env.LOADER })` from
   * `@cloudflare/codemode`; Node uses `quickJsExecutor()` from
   * `@zackbart/connecta/quickjs`.
   */
  executor: Executor;
}

export interface Connecta {
  /** Web-standard fetch handler. Usable as `export default { fetch: connecta.fetch }`. */
  fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response>;
  registry: Registry;
  /** Drain and release configured executor resources. Idempotent. */
  close: () => Promise<void>;
}

const REQUEST_ADMISSION_DEFAULTS = {
  concurrency: 16,
  maxQueueSize: 32,
  queueTimeoutMs: 5_000,
  retryAfterMs: 1_000,
} as const;

const CODE_ADMISSION_DEFAULTS = {
  concurrency: 2,
  maxQueueSize: 8,
  queueTimeoutMs: 5_000,
  retryAfterMs: 1_000,
} as const;

function admissionController(
  options: AdmissionPoolConfig | undefined,
  defaults: typeof REQUEST_ADMISSION_DEFAULTS | typeof CODE_ADMISSION_DEFAULTS,
): AdmissionController {
  return new AdmissionController({
    concurrency: options?.concurrency ?? defaults.concurrency,
    maxQueueSize: options?.maxQueueSize ?? defaults.maxQueueSize,
    queueTimeoutMs: options?.queueTimeoutMs ?? defaults.queueTimeoutMs,
    retryAfterMs: options?.retryAfterMs ?? defaults.retryAfterMs,
  });
}

/** Bearer providers are checked before Clerk (per spec). */
function normalizeAuth(auth: ConnectaConfig["auth"]): InboundAuth[] {
  const list = auth ? (Array.isArray(auth) ? auth : [auth]) : [];
  return [...list].sort((a, b) => {
    const rank = (x: InboundAuth) => (x.kind === "bearer" ? 0 : 1);
    return rank(a) - rank(b);
  });
}

type OptionSchema =
  | null
  | { readonly [key: string]: OptionSchema }
  | readonly [OptionSchema];

type ClosedOptionSchema<T extends object> = {
  readonly [K in keyof T]-?: OptionSchema;
};

const admissionPoolSchema = {
  concurrency: null,
  maxQueueSize: null,
  queueTimeoutMs: null,
  retryAfterMs: null,
} as const satisfies ClosedOptionSchema<AdmissionPoolConfig>;

const CONFIG_SCHEMA = {
  connectors: null,
  auth: null,
  identity: {
    connectorAccess: null,
    activityAccess: null,
    credentialAdministration: null,
    personalConnection: null,
  } satisfies ClosedOptionSchema<ConnectaIdentityConfig>,
  pools: null,
  storage: null,
  publicUrl: null,
  allowedOrigins: null,
  activity: null,
  vault: null,
  ui: null,
  artifacts: null,
  artifactOrigin: null,
  discovery: {
    concurrency: null,
    catalogTtlSeconds: null,
    persistCatalog: null,
    staleCatalogSeconds: null,
    probeTimeoutMs: null,
  } satisfies ClosedOptionSchema<ConnectaDiscoveryConfig>,
  results: {
    maxStashBytes: null,
    maxStashEntries: null,
  } satisfies ClosedOptionSchema<ConnectaResultsConfig>,
  calls: {
    defaultTimeoutMs: null,
    maxResultBytes: null,
  } satisfies ClosedOptionSchema<ConnectaCallsConfig>,
  execute: {
    maxEmittedBytes: null,
    maxEmittedBlocks: null,
    maxHostCalls: null,
    hostCallTimeoutMs: null,
    watchdogMs: null,
    resumableWrites: null,
    maxWrites: null,
    pausedRunTtlSeconds: null,
    approval: null,
  } satisfies ClosedOptionSchema<ConnectaExecuteConfig>,
  admission: {
    requests: admissionPoolSchema,
    code: admissionPoolSchema,
  } satisfies ClosedOptionSchema<ConnectaAdmissionConfig>,
  logger: null,
  serverInfo: {
    name: null,
    version: null,
    title: null,
    websiteUrl: null,
    icons: [
      {
        src: null,
        mimeType: null,
        sizes: null,
      } satisfies ClosedOptionSchema<
        NonNullable<NonNullable<ConnectaConfig["serverInfo"]>["icons"]>[number]
      >,
    ],
  } satisfies ClosedOptionSchema<NonNullable<ConnectaConfig["serverInfo"]>>,
  deploymentInfo: null,
  executor: null,
} as const satisfies Record<keyof ConnectaConfig, OptionSchema>;

function unknownOptionPaths(
  value: unknown,
  path: string,
  schema: OptionSchema,
): string[] {
  if (schema === null) return [];
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry, index) =>
      unknownOptionPaths(entry, `${path}[${index}]`, schema[0]),
    );
  }
  if (typeof value !== "object" || value === null) return [];
  const known = new Set(Object.keys(schema));
  const unknown = Reflect.ownKeys(value)
    .filter((key) => typeof key !== "string" || !known.has(key))
    .map((key) => `${path}.${String(key)}`)
    .sort();
  if (unknown.length > 0) return unknown;
  for (const [key, childSchema] of Object.entries(schema)) {
    unknown.push(
      ...unknownOptionPaths(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        childSchema,
      ),
    );
  }
  return unknown;
}

function rejectUnknownOptions(paths: string[]): void {
  if (paths.length === 0) return;
  throw new Error(
    `Unknown Connecta configuration option${paths.length === 1 ? "" : "s"}:\n` +
      paths.map((path) => `- ${path}`).join("\n") +
      (paths.includes("ConnectaConfig.credentials") ? "\nUse vault: encryptedCredentialVault(storage, key) from @zackbart/connecta/credentials." : "") +
      (paths.includes("ConnectaConfig.accessTokens") ? "\nConnecta-issued tokens were removed. Configure an inbound auth adapter instead." : "") +
      (paths.includes("ConnectaConfig.branding") ? "\nMove branding into ui: operatorUi({ branding }) from @zackbart/connecta/ui." : ""),
  );
}

/** Reject JavaScript typos and removed options before construction does work. */
function assertKnownConfig(config: ConnectaConfig): void {
  rejectUnknownOptions(
    unknownOptionPaths(config, "ConnectaConfig", CONFIG_SCHEMA),
  );
  if (config.results !== undefined) {
    if (!config.results || typeof config.results !== "object" || Array.isArray(config.results)) {
      throw new Error("ConnectaConfig.results must be an object");
    }
    for (const key of ["maxStashBytes", "maxStashEntries"] as const) {
      const value = config.results[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`ConnectaConfig.results.${key} must be a non-negative safe integer`);
      }
    }
  }
  if (config.vault && (["get", "getAll", "set", "setAll", "metadata", "delete"].some(key => typeof (config.vault as unknown as Record<string, unknown>)[key] !== "function") || ["seal", "open"].some(key => !["undefined", "function"].includes(typeof (config.vault as unknown as Record<string, unknown>)[key])))) throw new Error("ConnectaConfig.vault must implement CredentialVault");
  if (config.ui && (typeof config.ui.handle !== "function" || typeof config.ui.credentialHandoffUrl !== "function" || !Array.isArray(config.ui.reservedPaths))) throw new Error("ConnectaConfig.ui must be created with operatorUi(...)");
  const activity = config.activity as unknown;
  if (
    activity !== undefined &&
    (typeof activity !== "object" ||
      activity === null ||
      typeof (activity as ActivityModule).recordTool !== "function")
  ) {
    throw new Error(
      "ConnectaConfig.activity must be created with activityHistory(...)",
    );
  }
  const artifacts = config.artifacts as unknown;
  if (artifacts !== undefined) {
    const connector = (artifacts as Partial<ArtifactsModule> | null)?.connector;
    if (
      typeof artifacts !== "object" ||
      artifacts === null ||
      !connector ||
      connector.id !== "artifacts" ||
      typeof connector.callTool !== "function" ||
      typeof (artifacts as Partial<ArtifactsModule>).handle !== "function"
    ) {
      throw new Error(
        "ConnectaConfig.artifacts must be created with artifacts(...) from @zackbart/connecta/artifacts",
      );
    }
    if (config.connectors?.some((candidate) => candidate?.id === "artifacts")) {
      throw new Error(
        'Connector id "artifacts" is reserved by the artifacts module; rename ' +
          "your connector or drop the artifacts option",
      );
    }
    if (!config.publicUrl) {
      throw new Error(
        "ConnectaConfig.artifacts needs publicUrl: artifact links are shared " +
          "with teammates, so they must name the deployment's own origin, never " +
          "one taken from a request's Host header",
      );
    }
  }
  if (config.artifactOrigin !== undefined) {
    if (!config.artifacts || !config.ui || !config.publicUrl) {
      throw new Error("ConnectaConfig.artifactOrigin needs artifacts, ui, and publicUrl");
    }
    if (typeof config.artifactOrigin !== "string") {
      throw new Error("ConnectaConfig.artifactOrigin must be an HTTPS origin");
    }
    let origin: URL;
    try {
      origin = new URL(config.artifactOrigin);
    } catch {
      throw new Error("ConnectaConfig.artifactOrigin must be an HTTPS origin");
    }
    if (
      origin.protocol !== "https:" ||
      origin.toString() !== `${origin.origin}/` ||
      origin.origin === new URL(config.publicUrl).origin
    ) {
      throw new Error("ConnectaConfig.artifactOrigin must be a distinct HTTPS origin");
    }
  }
}

/**
 * Validate declared pools against the connector set. Everything checkable at
 * construction throws here: a malformed name, an unparseable grant, an
 * unknown connector id, a tool address on an `api()` connector whose static
 * catalog lacks it. Remote catalogs load lazily, so their addresses are
 * checked at catalog load instead and stay unreachable until they match.
 */
function resolvePools(
  pools: Record<string, ConnectaPoolConfig> | undefined,
  registry: Registry,
): Map<string, ResolvedPool> {
  const resolved = new Map<string, ResolvedPool>();
  if (!pools) return resolved;
  if (typeof pools !== "object" || Array.isArray(pools)) {
    throw new Error("ConnectaConfig.pools must be an object keyed by pool name");
  }
  for (const [name, pool] of Object.entries(pools)) {
    if (!POOL_NAME_RE.test(name)) {
      throw new Error(`ConnectaConfig.pools: pool name "${name}" must match [a-z0-9_-]+`);
    }
    if (!pool || typeof pool !== "object" || !Array.isArray(pool.tools)) {
      throw new Error(`ConnectaConfig.pools.${name}: tools must be an array of connector ids or connector.tool addresses`);
    }
    if (pool.grant !== undefined && typeof pool.grant !== "function") {
      throw new Error(`ConnectaConfig.pools.${name}: grant must be a function`);
    }
    // A misspelled `grant` would otherwise boot as a deny-all pool with only a
    // per-request log line to say so; that is fail-closed, but the rule here
    // is that structural mistakes refuse to boot.
    for (const key of Object.keys(pool)) {
      if (key !== "tools" && key !== "grant") {
        throw new Error(`ConnectaConfig.pools.${name}: unknown option "${key}"`);
      }
    }
    let access: ConnectorAccess;
    try {
      access = parseConnectorAccess(pool.tools);
    } catch {
      throw new Error(`ConnectaConfig.pools.${name}: tools must be connector ids or connector.tool addresses`);
    }
    if (access.connectorIds === "all" || access.connectorIds.length === 0) {
      throw new Error(`ConnectaConfig.pools.${name}: a pool must name at least one connector or tool`);
    }
    for (const id of access.connectorIds) {
      const connector = registry.getConnector(id);
      if (!connector) {
        throw new Error(`ConnectaConfig.pools.${name}: unknown connector "${id}"`);
      }
      const granted = access.toolAccess?.get(id);
      if (!granted || !connector.staticTools) continue;
      const known = new Set(connector.staticTools.map((tool) => tool.name));
      for (const tool of granted) {
        if (!known.has(tool)) {
          throw new Error(`ConnectaConfig.pools.${name}: connector "${id}" has no tool "${tool}"`);
        }
      }
    }
    resolved.set(name, { access, grant: pool.grant ?? (() => false) });
  }
  return resolved;
}

/**
 * Validate `execute.approval` against the connector set, like the pools: a
 * malformed key or value, an unknown connector, and an `api()` address its
 * tools do not include all throw. Remote catalogs load lazily, so an address
 * on one is kept and simply never matches a tool it does not serve.
 */
function resolveApprovalPolicy(
  approval: ConnectaExecuteConfig["approval"],
  registry: Registry,
): ApprovalPolicy {
  for (const connector of registry.listConnectors()) {
    if (connector.approval !== undefined && connector.approval !== "never") {
      throw new Error(
        `Connector "${connector.id}": approval must be "never" or omitted`,
      );
    }
  }
  if (approval === undefined) return NO_EXEMPTIONS;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw new Error(
      "ConnectaConfig.execute.approval must be an object keyed by connector ids and connector.tool addresses",
    );
  }
  const connectors = new Map<string, "never" | "ask">();
  const tools = new Map<string, "never" | "ask">();
  for (const [key, value] of Object.entries(approval)) {
    const where = `ConnectaConfig.execute.approval[${JSON.stringify(key)}]`;
    if (value !== "never" && value !== "ask") {
      throw new Error(`${where} must be "never" or "ask"`);
    }
    const dot = key.indexOf(".");
    const id = dot === -1 ? key : key.slice(0, dot);
    const tool = dot === -1 ? undefined : key.slice(dot + 1);
    if (!id || tool === "") {
      throw new Error(`${where}: keys are connector ids or connector.tool addresses`);
    }
    const connector = registry.getConnector(id);
    if (!connector) throw new Error(`${where}: unknown connector "${id}"`);
    if (tool === undefined) {
      connectors.set(id, value);
      continue;
    }
    if (
      connector.staticTools &&
      !connector.staticTools.some((candidate) => candidate.name === tool)
    ) {
      throw new Error(`${where}: connector "${id}" has no tool "${tool}"`);
    }
    tools.set(key, value);
  }
  return { connectors, tools };
}

/** A positive whole number, or the default when the value is unusable. */
function positiveWhole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

/**
 * Resumable writes' deployment settings, or undefined when they are off.
 * Omitted, they are on exactly when the storage can claim atomically, and a
 * deployment left without them hears so once. Asked for over storage that
 * cannot claim, they throw: at-most-once delivery of an approved write rests
 * on exactly one resume winning the claim, and a read-then-write stand-in
 * would let two win.
 */
function resolveResumableWrites(
  execute: ConnectaExecuteConfig | undefined,
  storage: KVStorage,
  logger: Logger,
): { maxWrites: number; ttlSeconds: number } | undefined {
  const enabled = execute?.resumableWrites;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("ConnectaConfig.execute.resumableWrites must be a boolean");
  }
  if (enabled === false) return undefined;
  if (enabled === undefined && typeof storage.compareAndSet !== "function") {
    logger.warn(
      "[connecta] resumable writes are off: the configured storage has no " +
        "compareAndSet, so programs refuse writes (E4) and resume_execution " +
        "answers resumable_writes_unavailable. Use storage with an atomic " +
        "compareAndSet (the Worker example's D1 store, fileStorage, " +
        "memoryStorage) to let programs pause for approval, or set " +
        "execute.resumableWrites: false to keep this and silence the warning.",
    );
    return undefined;
  }
  if (typeof storage.compareAndSet !== "function") {
    throw new Error(
      "ConnectaConfig.execute.resumableWrites needs storage with compareAndSet: " +
        "two resumes of one paused run must send its writes at most once, which " +
        "takes an atomic claim. memoryStorage() and fileStorage() provide it, as " +
        "does the Worker example's D1 store; Cloudflare KV cannot.",
    );
  }
  return {
    maxWrites: positiveWhole(execute?.maxWrites, DEFAULT_MAX_WRITES),
    ttlSeconds: positiveWhole(
      execute?.pausedRunTtlSeconds,
      DEFAULT_PAUSED_RUN_TTL_SECONDS,
    ),
  };
}

/**
 * One-time construction warnings for deployment shapes that run fine but are
 * usually unintended. Warning-only — never throws and never changes behavior;
 * each deployment-wide condition emits at most one `logger.warn`, and each
 * per-connector condition at most one per connector it names.
 */
function warnInsecureConfig(
  config: ConnectaConfig,
  inboundAuth: InboundAuth[],
  logger: Logger,
): void {
  const oauthConnectors = config.connectors.filter((c) => c.finishAuth);
  const hasCredentialConnector = config.connectors.some((c) => c.credential);

  // Static API headers can carry secrets without declaring credential hooks.
  // Any configured connector warrants the open-deployment warning.
  if (
    inboundAuth.length === 0 &&
    (config.connectors.length > 0 || config.artifacts)
  ) {
    logger.warn(
      "[connecta] running with no inbound authentication: any caller can " +
        "invoke every shared connector. " +
        (hasCredentialConnector || oauthConnectors.length > 0
          ? "Configured credentials and downstream OAuth grants are exposed to those calls. "
          : "") +
        "Configure `auth` (for example bearerToken(...) or Clerk) to gate access.",
    );
  }

  // Artifact pages mount inside the operator UI and open only for an
  // authenticated viewer; either missing leaves the connector with no page.
  if (config.artifacts && !config.ui) {
    logger.warn(
      "[connecta] artifacts is configured without ui: agents can publish and " +
        "read artifacts, but there is no viewer, so their links answer 404. " +
        "Add ui: operatorUi() to serve artifact pages.",
    );
  } else if (config.artifacts && inboundAuth.length === 0) {
    logger.warn(
      "[connecta] artifacts is configured with no inbound authentication: " +
        "artifact pages refuse every request, because there is no team to " +
        "show them to. Configure `auth` to open them.",
    );
  }

  // Unset publicUrl with OAuth connectors: the downstream redirect_uri is
  // derived per-request from the attacker-influenced inbound Host header.
  if (oauthConnectors.length > 0 && !config.publicUrl) {
    logger.warn(
      "[connecta] publicUrl is unset while OAuth connectors are configured: " +
        "the downstream OAuth redirect_uri is derived per-request from the " +
        "inbound Host header, so an attacker who controls that header can point " +
        "it at their own host and capture the authorization code. Set " +
        "`publicUrl` to a fixed https origin.",
    );
  }

  // Branding URLs that failed their scheme gate. Rendering silently falls back
  // (a bad URL must not take the page down), so this warning is the only way an
  // operator learns their value never reached the page.
  const dropped = droppedBrandingUrls(config.ui?.branding);
  if (dropped.length > 0) {
    logger.warn(
      `[connecta] branding ${dropped.join(", ")} dropped: a branding URL is ` +
        "used as an href, so it must be an absolute http(s) URL (favicon.href " +
        "may also be a root-relative path). The default is rendered instead.",
    );
  }

  // Theme tokens are written into a `:root` block, so each is gated
  // syntactically and a rejected value takes the stylesheet's default. Same
  // reason as the branding URLs above: the page still renders, so without this
  // line the only evidence is that the operator's color never showed up.
  const droppedTheme = droppedThemeTokens(config.ui?.branding?.theme);
  if (droppedTheme.length > 0) {
    logger.warn(
      `[connecta] branding ${droppedTheme.join(", ")} dropped: accent must be ` +
        "a hex color, radius a CSS length, the font families a plain " +
        "font-family list, and colorScheme one of system/light/dark. The " +
        "default is rendered instead.",
    );
  }

  // Operator shells render exactly one provider's browser sign-in config — the
  // first that offers one, matching the server route's `find` — and that
  // provider's URLs reach the browser: frontendApiUrl as the loader's
  // `<script src>`, signInUrl/signUpUrl as the addresses ClerkJS navigates to.
  // Gate-or-drop like a branding href: rendering drops a rejected value and the
  // operator page then reports that Clerk could not load or quietly signs in
  // through Clerk's defaults — both confusing symptoms without this line naming
  // the cause. Checking only the rendered provider keeps the claim true — a
  // later provider's uiAuth never reaches the page, so there is nothing there
  // to warn about.
  const uiAuthProvider = inboundAuth.find((provider) => provider.uiAuth);
  const droppedUiAuth = droppedUiAuthUrls(uiAuthProvider?.uiAuth);
  if (uiAuthProvider && droppedUiAuth.length > 0) {
    logger.warn(
      `[connecta] inbound auth provider "${uiAuthProvider.kind}" had ` +
        `${droppedUiAuth.join(", ")} dropped: every uiAuth URL reaches the ` +
        "browser — as the sign-in loader's source, or as a place Clerk sends " +
        "the operator — so each must be an absolute https URL. A dropped " +
        "value reaches no part of the page: without frontendApiUrl the operator shell renders " +
        "no loader and cannot start a sign-in, and without signInUrl/signUpUrl " +
        "it signs in through Clerk's defaults.",
    );
  }

  // A credential test hook that cannot test the declared credential shape.
  // The shape picks the hook (see `credentialTestRule`) and the other one is
  // never substituted, so the connection offers no Test action in the operator
  // UI and the route answers 400. Without this line the only way to discover
  // the mistake is to click a button that isn't there.
  for (const connector of config.connectors) {
    const { mismatch } = credentialTestRule(connector);
    if (!mismatch) continue;
    logger.warn(
      `[connecta] connector "${connector.id}" cannot test its credential: ` +
        `${describeCredentialTestMismatch(mismatch)}. The connection in the operator UI offers no Test ` +
        `action and POST /ui/credentials/${connector.id}/test answers 400 ` +
        "until the matching hook is implemented.",
    );
  }

  // A vault written before seal/open existed encrypts credentials but cannot
  // seal downstream OAuth state, so tokens stay plaintext at rest beside them.
  const vault = config.vault;
  if (vault && (typeof vault.seal !== "function" || typeof vault.open !== "function")) {
    for (const connector of config.connectors) {
      if (!connector.startAuth) continue;
      logger.warn(
        `[connecta] connector "${connector.id}" stores its downstream OAuth ` +
          "tokens, client registration, and PKCE verifier as plaintext: the " +
          "configured vault implements no `seal`/`open`. Use " +
          "encryptedCredentialVault(...) or add both methods to seal them.",
      );
    }
  }

  // OAuth connectors whose callback cannot perform a state/CSRF check. The
  // public route refuses every callback for these connectors rather than hand
  // an unverified code to finishAuth, so this warning explains why auth cannot
  // complete instead of describing a vulnerability the server permits.
  for (const connector of oauthConnectors) {
    if (!connector.verifyState) {
      logger.warn(
        `[connecta] connector "${connector.id}" has an OAuth callback with no ` +
          `state/CSRF check: /oauth/callback/${connector.id} refuses every ` +
          "callback rather than exchange an unverified code. Implement " +
          "`verifyState` to complete authorization (the shipped remoteMcp " +
          "connector already does).",
      );
    }
  }
}

export function createConnecta(config: ConnectaConfig): Connecta {
  assertKnownConfig(config);
  if (!config.executor) {
    throw new Error(
      "ConnectaConfig.executor is required. Configure quickJsExecutor() from " +
        '"@zackbart/connecta/quickjs" on Node, or ' +
        "new DynamicWorkerExecutor({ loader: env.LOADER }) from " +
        '"@cloudflare/codemode" on Workers.',
    );
  }
  const storage = config.storage ?? memoryStorage();
  const logger = resolveLogger(config.logger);
  const credentialVault = config.vault;
  const configuredAuth = normalizeAuth(config.auth);
  const serverInfo = {
    ...config.serverInfo,
    name: config.serverInfo?.name ?? "connecta",
    version: config.serverInfo?.version ?? CONNECTA_VERSION,
  };
  // The artifacts module contributes one prebuilt connector, appended like any
  // configured one: same catalog, invocation, admission, and activity.
  const connectors = config.artifacts
    ? [...config.connectors, config.artifacts.connector]
    : config.connectors;
  const registry = new Registry(connectors, {
    storage,
    logger,
    credentialVault,
    credentialUi: Boolean(config.ui),
    catalogDriftActivity: config.activity?.store
      ? {
          sink: config.activity.store,
          recordDrift: config.activity.recordDrift,
          serverInfo,
          ...(config.activity.deploymentId !== undefined
            ? { deploymentId: config.activity.deploymentId }
            : {}),
        }
      : undefined,
    toolCacheTtlSeconds: config.discovery?.catalogTtlSeconds,
    persistToolCatalog: config.discovery?.persistCatalog,
    toolCatalogStaleSeconds: config.discovery?.staleCatalogSeconds,
    maxResultBytes: config.calls?.maxResultBytes,
    results: config.results,
  });
  const inboundAuth = configuredAuth;
  const pools = resolvePools(config.pools, registry);
  const resumable = resolveResumableWrites(config.execute, storage, logger);
  const approval = resolveApprovalPolicy(config.execute?.approval, registry);
  // Exempt writes need a budget whether or not programs can pause.
  const maxWrites = positiveWhole(config.execute?.maxWrites, DEFAULT_MAX_WRITES);
  warnInsecureConfig(config, inboundAuth, logger);
  const requestAdmission = admissionController(
    config.admission?.requests,
    REQUEST_ADMISSION_DEFAULTS,
  );
  const configuredCodeAdmission = admissionController(
    config.admission?.code,
    CODE_ADMISSION_DEFAULTS,
  );
  let codeAdmission: AdmissionController | undefined;
  let executor = config.executor;
  // Read the identity off the configured executor, before any wrapper hides
  // it behind an anonymous object literal.
  const configuredExecutorName = executorName(executor);
  if (!isAdmittingExecutor(executor)) {
    codeAdmission = configuredCodeAdmission;
    executor = withExecutorAdmission(executor, codeAdmission);
  } else if (config.admission?.code) {
    logger.warn(
      "[connecta] admission.code is ignored because the configured executor " +
        "implements acquire() and owns its admission pool; configure that " +
        "executor's concurrency and queue options instead.",
    );
  }
  // Every structural check has passed, so this is the configuration the
  // deployment runs with. Creating the runtime builds nothing — a Worker may
  // construct its Connecta at global scope, where no fiber may start.
  const runtime = createCoreRuntime(registry, {
    storage,
    logger,
    vault: credentialVault,
    activity: config.activity,
    config: {
      config,
      serverInfo,
      auth: inboundAuth,
      pools,
      executorName: configuredExecutorName,
    },
  });
  const handler = createFetchHandler({
    registry,
    auth: inboundAuth,
    identity: config.identity,
    pools,
    publicUrl: config.publicUrl,
    artifactOrigin: config.artifactOrigin,
    allowedOrigins: config.allowedOrigins,
    serverInfo,
    logger,
    activity: config.activity?.store,
    activityModule: config.activity,
    artifactsModule: config.artifacts,
    activityReadGate: config.activity?.readGate,
    activityDeploymentId: config.activity?.deploymentId,
    executor,
    executorName: configuredExecutorName,
    requestAdmission,
    defaultToolTimeoutMs: config.calls?.defaultTimeoutMs,
    probeTimeoutMs: config.discovery?.probeTimeoutMs,
    discoveryConcurrency: config.discovery?.concurrency,
    maxEmittedBytes: config.execute?.maxEmittedBytes,
    maxEmittedBlocks: config.execute?.maxEmittedBlocks,
    maxHostCalls: config.execute?.maxHostCalls,
    hostCallTimeoutMs: config.execute?.hostCallTimeoutMs,
    watchdogMs: config.execute?.watchdogMs,
    resumable,
    approval,
    maxWrites,
    credentialVault,
    ui: config.ui,
    deploymentInfo: config.deploymentInfo,
    branding: config.ui?.branding,
  });
  let closePromise: Promise<void> | undefined;
  return {
    fetch: (request, _env, ctx) =>
      handler(
        request,
        ctx && typeof (ctx as { waitUntil?: unknown }).waitUntil === "function"
          ? (ctx as import("./routes/shared.js").RuntimeExecutionContext)
          : undefined,
      ),
    registry,
    close: async () => {
      closePromise ??= Promise.resolve().then(async () => {
        try {
          requestAdmission.close();
          codeAdmission?.close();
          registry.closeCallAdmission();
          await config.executor?.close?.();
        } finally {
          // Last, and whether or not the executor closed cleanly. A fiber
          // already running keeps the services it was given; only a run
          // started after this is refused.
          await disposeEdgeRuntime(runtime);
        }
      });
      await closePromise;
    },
  };
}

export { remoteMcp } from "./connectors/remote-mcp.js";
export { api } from "./connectors/api.js";
export { ConnectorCallError } from "./errors.js";
export type { ConnectorCallErrorCode, CallErrorDetails } from "./errors.js";
// The same argument validation api() performs, usable by connectors that
// implement the Connector interface directly. Returns the error rather than
// throwing so the caller decides what to do with it.
export { validateToolInput } from "./validate.js";
export type { ValidateToolInputOptions } from "./validate.js";
export { memoryStorage } from "./storage/memory.js";
export { CONNECTA_VERSION } from "./version.js";
// Registry is reachable through `Connecta.registry`, so its type is public;
// the class itself, the credential vault, and the meta-tool/sandbox factories
// are internal factoring and are deliberately not part of the API surface.
export type { Registry } from "./registry.js";

export type {
  RemoteMcpOptions,
  RemoteMcpAuth,
  RemoteMcpRedirectPolicy,
} from "./connectors/remote-mcp.js";
export type { ApiOptions, ApiTool } from "./connectors/api.js";
export type {
  CatalogDriftCounts,
  CatalogDriftReport,
  ConnectaBranding,
  ConnectaTheme,
  Connector,
  ConnectorCallAdmissionInput,
  ConnectorCallAdmissionPolicy,
  ConnectorCallAdmissionRule,
  ConnectorRollingWindowBudget,
  ConnectorCredentialAccess,
  ConnectorCredentialConfig,
  ConnectorCredentialFieldConfig,
  ConnectorCredentialValues,
  ConnectorContext,
  ConnectorUsageGuide,
  ConnectorStatus,
  CredentialTestResult,
  AdmittingExecutor,
  AdmissionSnapshot,
  ExecuteResult,
  Executor,
  ExecutorLease,
  ExecutorProvider,
  InboundAuth,
  InboundAuthRuntimeContext,
  UiAuthConfig,
  AuthResult,
  AuthenticatedIdentity,
  IdentityReference,
  JsonSchema,
  KVStorage,
  Logger,
  ToolDef,
  ToolAnnotations,
} from "./types.js";
export type {
  ActivityActor,
  ActivityCallSource,
  ActivityOutcome,
  ActivityPage,
  ActivityReadActor,
  ActivityReadEvent,
  ActivityReader,
  ActivityReadGate,
  ActivityReadPage,
  ActivitySink,
  ActivityStore,
  AgentFriction,
  CatalogDriftActivityEvent,
  ToolCallActivityEvent,
} from "./activity.js";
