import {
  CredentialVault,
  credentialTestRule,
  describeCredentialTestMismatch,
} from "./credentials.js";
import { Registry } from "./registry.js";
import { createFetchHandler } from "./server.js";
import { droppedBrandingUrls, droppedUiAuthUrls } from "./ui.js";
import { memoryStorage } from "./storage/memory.js";
import { CONNECTA_VERSION } from "./version.js";
import {
  AdmissionController,
  isAdmittingExecutor,
  withExecutorAdmission,
} from "./executor-admission.js";
import type { ActivityReadGate, ActivityStore } from "./activity.js";
import type {
  Connector,
  ConnectaBranding,
  ConnectaSurface,
  Executor,
  InboundAuth,
  KVStorage,
  Logger,
} from "./types.js";

/** Payload-free activity storage and operator-read policy. */
export interface ConnectaActivityConfig {
  /**
   * Privacy-minimal downstream tool activity storage. Writes are best-effort
   * and never change tool results. Implement `list` to enable the Activity UI.
   */
  store: ActivityStore;
  /**
   * Optional authorization gate for the Activity read API. MCP authentication
   * is still required first. Omit to admit every authenticated actor.
   */
  readGate?: ActivityReadGate;
  /** Stable deployment label included in activity events, e.g. "production". */
  deploymentId?: string;
}

/** Operator-vault encryption. */
export interface ConnectaCredentialsConfig {
  /**
   * Base64-encoded 32-byte AES key for credentials managed on /credentials.
   * Keep this in the runtime's secret store, never in KV or source control.
   */
  encryptionKey?: string;
}

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
   * `list_connectors`, `search_tools`, and `describe_tools`. Defaults to
   * 30_000. A timed-out connector degrades independently; this does not apply
   * to tool calls. Catalog walks receive the same cancellation signal, which
   * aborts an in-flight page where supported and prevents another from starting.
   */
  probeTimeoutMs?: number;
}

/** Deployment-wide call deadlines and inline-result paging thresholds. */
export interface ConnectaCallsConfig {
  /**
   * Deadline (ms) for `call_tool`/`batch_call` calls that pass no `timeoutMs`.
   * An explicit per-call value wins. Opt-in: unset by default, so existing
   * long-running calls gain no surprise deadline.
   *
   * This bounds one attempt, not all retries. `execute_code` host calls are
   * unaffected because they already carry their own bound.
   */
  defaultTimeoutMs?: number;
  /**
   * Max inline result size (bytes) before truncation and `get_result` paging.
   * Must be a finite whole number >= 1; invalid values warn and fall back to
   * 50_000. Connectors may override it individually.
   */
  maxResultBytes?: number;
  /**
   * Max serialized `batch_call` envelope size (bytes) before the full batch is
   * stashed for `get_result` and only an ordered outcome summary is returned
   * inline. Must be a finite whole number >= 1; invalid values warn and fall
   * back to 100_000. This cap is independent of per-connector child caps.
   */
  maxBatchResultBytes?: number;
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

export interface ConnectaConfig {
  connectors: Connector[];
  /** Inbound auth adapters. Includes bearerToken(...); omit for open (dev). */
  auth?: InboundAuth | InboundAuth[];
  /** KVStorage impl. Defaults to memoryStorage(). */
  storage?: KVStorage;
  /**
   * Public base URL. Defaults to the request origin per-request. Configuring an
   * HTTPS URL also redirects matching inbound HTTP requests to HTTPS.
   */
  publicUrl?: string;
  /** Payload-free tool activity storage and operator-read policy. */
  activity?: ConnectaActivityConfig;
  /** Operator credential vault settings. */
  credentials?: ConnectaCredentialsConfig;
  /** Tool-catalog caching, persistence, stale fallback, and probe deadlines. */
  discovery?: ConnectaDiscoveryConfig;
  /** Deployment-wide call deadlines and result paging threshold. */
  calls?: ConnectaCallsConfig;
  /** Bounded MCP and fallback code-mode admission. */
  admission?: ConnectaAdmissionConfig;
  /** Optional browser UI and OAuth result-page labels. */
  branding?: ConnectaBranding;
  logger?: Logger;
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
   * Sandbox for `execute_code`, and the switch that decides the surface: with
   * an executor a model sees the seven code-first tools, without one the nine
   * classic ones. Workers: `new DynamicWorkerExecutor({ loader: env.LOADER })`
   * from `@cloudflare/codemode`. Node: `quickJsExecutor()` from
   * "@zackbart/connecta/quickjs".
   */
  executor?: Executor;
  /**
   * Override the surface the `executor` implies. The only reason to set it is
   * `"classic"` alongside an executor — ten tools, the shape the eval gate's
   * control arm measures against. `"code-first"` is the default wherever an
   * executor exists and throws without one.
   */
  surface?: ConnectaSurface;
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

function defaultLogger(): Logger {
  return {
    debug: (...a) => console.debug("[connecta]", ...a),
    info: (...a) => console.info("[connecta]", ...a),
    warn: (...a) => console.warn("[connecta]", ...a),
    error: (...a) => console.error("[connecta]", ...a),
  };
}

/** Bearer providers are checked before Clerk (per spec). */
function normalizeAuth(auth: ConnectaConfig["auth"]): InboundAuth[] {
  const list = auth ? (Array.isArray(auth) ? auth : [auth]) : [];
  return [...list].sort((a, b) => {
    const rank = (x: InboundAuth) => (x.kind === "bearer" ? 0 : 1);
    return rank(a) - rank(b);
  });
}

const LEGACY_CONFIG_MIGRATIONS = [
  ["activityReadGate", "activity.readGate"],
  ["activityDeploymentId", "activity.deploymentId"],
  ["credentialEncryptionKey", "credentials.encryptionKey"],
  ["toolCacheTtlSeconds", "discovery.catalogTtlSeconds"],
  ["persistToolCatalog", "discovery.persistCatalog"],
  ["toolCatalogStaleSeconds", "discovery.staleCatalogSeconds"],
  ["probeTimeoutMs", "discovery.probeTimeoutMs"],
  ["defaultToolTimeoutMs", "calls.defaultTimeoutMs"],
  ["maxResultBytes", "calls.maxResultBytes"],
] as const;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * Fail closed at the public boundary: a JavaScript caller on the v0.6 shape
 * must receive one complete migration error, never silently lose an option to
 * a default. This runs before createConnecta reads any other config field.
 */
function assertNoLegacyConfig(config: ConnectaConfig): void {
  const candidate = config as unknown as Record<PropertyKey, unknown>;
  if (hasOwn(candidate, "toolkits")) {
    throw new Error(
      "ConnectaConfig.toolkits was removed in issue #178. Deploy one " +
        "connecta instance per audience instead; see ethos.md.",
    );
  }
  const credentials = candidate.credentials;
  const hasNestedHealth =
    typeof credentials === "object" &&
    credentials !== null &&
    hasOwn(credentials, "health");
  if (hasOwn(candidate, "credentialHealth") || hasNestedHealth) {
    throw new Error(
      "`credentials.health` and legacy `credentialHealth` were removed in " +
        "issue #179. Credentials now fail at use; see ethos.md.",
    );
  }
  const found: Array<readonly [string, string]> = [];
  if (hasOwn(candidate, "activity")) {
    const activity = candidate.activity;
    const isObject =
      typeof activity === "object" && activity !== null;
    // A valid v0.6 ActivityStore can itself own a backend field named `store`.
    // Its required `record` method (including a prototype method) therefore
    // takes precedence over the otherwise-new wrapper shape.
    const hasLegacyRecord =
      isObject &&
      typeof (activity as { record?: unknown }).record === "function";
    if (
      activity !== undefined &&
      (!isObject ||
        hasLegacyRecord ||
        !hasOwn(activity, "store"))
    ) {
      found.push(["activity", "activity.store"]);
    }
  }
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    if (hasOwn(candidate, migration[0])) found.push(migration);
  }
  if (found.length === 0) return;
  throw new Error(
    "Unsupported v0.6.x ConnectaConfig options. Migrate each path for v0.7.0:\n" +
      found.map(([oldPath, newPath]) => `- ${oldPath} -> ${newPath}`).join("\n"),
  );
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

  // Open mode (no inbound auth) with connectors that expose credentials or
  // downstream OAuth: any caller reaches everything, including the vault.
  if (
    inboundAuth.length === 0 &&
    (hasCredentialConnector || oauthConnectors.length > 0)
  ) {
    logger.warn(
      "[connecta] running with no inbound authentication: any caller can " +
        "invoke every connector and read or overwrite stored credentials. " +
        "Configure `auth` (for example bearerToken(...) or Clerk) to gate access.",
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
  const dropped = droppedBrandingUrls(config.branding);
  if (dropped.length > 0) {
    logger.warn(
      `[connecta] branding ${dropped.join(", ")} dropped: a branding URL is ` +
        "used as an href, so it must be an absolute http(s) URL (favicon.href " +
        "may also be a root-relative path). The default is rendered instead.",
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
  // never substituted, so the connector is simply not testable: /credentials offers no
  // Test action and the route answers 400. Without this line the only way to
  // discover the mistake is to click a button that isn't there.
  for (const connector of config.connectors) {
    const { mismatch } = credentialTestRule(connector);
    if (!mismatch) continue;
    logger.warn(
      `[connecta] connector "${connector.id}" cannot test its credential: ` +
        `${describeCredentialTestMismatch(mismatch)}. /credentials offers no Test ` +
        `action and POST /ui/credentials/${connector.id}/test answers 400 ` +
        "until the matching hook is implemented.",
    );
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

/**
 * The advertised surface: the executor is the switch. Configure one and the
 * deployment serves the seven-tool code-first surface; omit it and there is no
 * program to fold discovery and batching into, so it serves classic.
 *
 * Two mistakes are structural rather than recoverable, so neither is warned
 * past: a surface name connecta does not implement, which would otherwise
 * resolve to something the operator did not ask for; and `code-first` without
 * an executor, which would advertise six tools and no program surface.
 */
function resolveSurface(config: ConnectaConfig): ConnectaSurface {
  const surface = config.surface;
  if (surface === undefined) {
    return config.executor ? "code-first" : "classic";
  }
  if (surface !== "classic" && surface !== "code-first") {
    throw new Error(
      `ConnectaConfig.surface must be "classic" or "code-first", not ` +
        `${JSON.stringify(surface)}.`,
    );
  }
  if (surface === "code-first" && !config.executor) {
    throw new Error(
      'ConnectaConfig.surface "code-first" requires an executor: it folds ' +
        "list_connectors, describe_tools, and batch_call into connecta.search, " +
        "connecta.describe, and connecta.batch inside execute_code, so without " +
        "an executor there is nothing left to reach them through. Configure " +
        "one (quickJsExecutor() from \"@zackbart/connecta/quickjs\" on Node, " +
        "new DynamicWorkerExecutor({ loader: env.LOADER }) on Workers).",
    );
  }
  return surface;
}

export function createConnecta(config: ConnectaConfig): Connecta {
  assertNoLegacyConfig(config);
  const surface = resolveSurface(config);
  const storage = config.storage ?? memoryStorage();
  const logger = config.logger ?? defaultLogger();
  const credentialConnectors = config.connectors.filter((c) => c.credential);
  const encryptionKey = config.credentials?.encryptionKey;
  if (credentialConnectors.length > 0 && !encryptionKey) {
    logger.warn(
      "Operator-managed credentials are unavailable because " +
        "credentials.encryptionKey is not configured for connectors: " +
        credentialConnectors.map((c) => c.id).join(", "),
    );
  }
  const credentialVault = encryptionKey
    ? new CredentialVault(storage, encryptionKey)
    : undefined;
  const registry = new Registry(config.connectors, {
    storage,
    logger,
    ...(credentialVault !== undefined ? { credentialVault } : {}),
    ...(config.discovery?.catalogTtlSeconds !== undefined
      ? { toolCacheTtlSeconds: config.discovery.catalogTtlSeconds }
      : {}),
    ...(config.discovery?.persistCatalog !== undefined
      ? { persistToolCatalog: config.discovery.persistCatalog }
      : {}),
    ...(config.discovery?.staleCatalogSeconds !== undefined
      ? { toolCatalogStaleSeconds: config.discovery.staleCatalogSeconds }
      : {}),
    ...(config.calls?.maxResultBytes !== undefined
      ? { maxResultBytes: config.calls.maxResultBytes }
      : {}),
    ...(config.calls?.maxBatchResultBytes !== undefined
      ? { maxBatchResultBytes: config.calls.maxBatchResultBytes }
      : {}),
  });
  const inboundAuth = normalizeAuth(config.auth);
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
  if (executor && !isAdmittingExecutor(executor)) {
    codeAdmission = configuredCodeAdmission;
    executor = withExecutorAdmission(executor, codeAdmission);
  } else if (executor && config.admission?.code) {
    logger.warn(
      "[connecta] admission.code is ignored because the configured executor " +
        "implements acquire() and owns its admission pool; configure that " +
        "executor's concurrency and queue options instead.",
    );
  }
  const handler = createFetchHandler({
    registry,
    auth: inboundAuth,
    ...(config.publicUrl !== undefined ? { publicUrl: config.publicUrl } : {}),
    serverInfo: {
      ...config.serverInfo,
      name: config.serverInfo?.name ?? "connecta",
      version: config.serverInfo?.version ?? CONNECTA_VERSION,
    },
    logger,
    ...(config.activity?.store !== undefined
      ? { activity: config.activity.store }
      : {}),
    ...(config.activity?.readGate !== undefined
      ? { activityReadGate: config.activity.readGate }
      : {}),
    ...(config.activity?.deploymentId !== undefined
      ? { activityDeploymentId: config.activity.deploymentId }
      : {}),
    ...(executor !== undefined ? { executor } : {}),
    surface,
    requestAdmission,
    ...(config.calls?.defaultTimeoutMs !== undefined
      ? { defaultToolTimeoutMs: config.calls.defaultTimeoutMs }
      : {}),
    ...(config.discovery?.probeTimeoutMs !== undefined
      ? { probeTimeoutMs: config.discovery.probeTimeoutMs }
      : {}),
    ...(config.discovery?.concurrency !== undefined
      ? { discoveryConcurrency: config.discovery.concurrency }
      : {}),
    ...(credentialVault !== undefined ? { credentialVault } : {}),
    ...(config.deploymentInfo !== undefined
      ? { deploymentInfo: config.deploymentInfo }
      : {}),
    ...(config.branding !== undefined ? { branding: config.branding } : {}),
  });
  let closePromise: Promise<void> | undefined;
  return {
    fetch: (request, _env, ctx) =>
      handler(
        request,
        ctx && typeof (ctx as { waitUntil?: unknown }).waitUntil === "function"
          ? (ctx as { waitUntil(promise: Promise<unknown>): void })
          : undefined,
      ),
    registry,
    close: async () => {
      closePromise ??= Promise.resolve().then(async () => {
        requestAdmission.close();
        codeAdmission?.close();
        registry.closeCallAdmission();
        await config.executor?.close?.();
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
export { bearerToken } from "./auth/bearer.js";
export type { BearerTokenOptions } from "./auth/bearer.js";
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
  Connector,
  ConnectorCallAdmissionInput,
  ConnectorCallAdmissionPolicy,
  ConnectorCallAdmissionRule,
  ConnectorRollingWindowBudget,
  ConnectaBranding,
  ConnectaSurface,
  ConnectorCredentialAccess,
  ConnectorCredentialConfig,
  ConnectorCredentialFieldConfig,
  ConnectorCredentialValues,
  ConnectorContext,
  ConnectorStatus,
  CredentialTestResult,
  AdmittingExecutor,
  AdmissionSnapshot,
  ExecuteResult,
  Executor,
  ExecutorLease,
  ExecutorProvider,
  InboundAuth,
  UiAuthConfig,
  AuthResult,
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
  ToolCallActivityEvent,
} from "./activity.js";
export { InvalidActivityCursorError } from "./activity.js";
