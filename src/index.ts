import {
  CredentialVault,
  credentialTestRule,
  describeCredentialTestMismatch,
} from "./credentials.js";
import { AccessTokenManager } from "./access-tokens.js";
import { Registry } from "./registry.js";
import { createFetchHandler } from "./server.js";
import { droppedBrandingUrls, droppedUiAuthUrls } from "./ui.js";
import { memoryStorage } from "./storage/memory.js";
import { CONNECTA_VERSION } from "./version.js";
import {
  AdmissionController,
  executorName,
  isAdmittingExecutor,
  withExecutorAdmission,
} from "./executor-admission.js";
import type { ActivityReadGate, ActivityStore } from "./activity.js";
import type {
  Connector,
  ConnectaBranding,
  Executor,
  InboundAuth,
  KVStorage,
  Logger,
} from "./types.js";

// Configuration defaults and operator-facing meanings are canonical in
// documentation/operations.md#configuration; these types only define intake.

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

/** Operator-issued credentials for clients connecting to this deployment. */
export interface ConnectaAccessTokensConfig {
  /** Maximum simultaneously active access tokens. Defaults to 100. */
  maxActive?: number;
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
}

/** Budgets for rich output emitted by execute_code programs (`connecta.emit`). */
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
  /**
   * Named, revocable Bearer tokens for MCP clients. Creation and mutation
   * require an eligible Clerk operator; token secrets are returned once.
   */
  accessTokens?: ConnectaAccessTokensConfig;
  /** Tool-catalog caching, persistence, stale fallback, and probe deadlines. */
  discovery?: ConnectaDiscoveryConfig;
  /** Deployment-wide call deadlines and result paging threshold. */
  calls?: ConnectaCallsConfig;
  /** Budgets for the `connecta.emit` rich-output channel in execute_code. */
  execute?: ConnectaExecuteConfig;
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

type OptionSchema =
  | null
  | { readonly [key: string]: OptionSchema }
  | readonly [OptionSchema];

const admissionPoolSchema = {
  concurrency: null,
  maxQueueSize: null,
  queueTimeoutMs: null,
  retryAfterMs: null,
} as const satisfies OptionSchema;

const CONFIG_SCHEMA = {
  connectors: null,
  auth: null,
  storage: null,
  publicUrl: null,
  activity: { store: null, readGate: null, deploymentId: null },
  credentials: { encryptionKey: null },
  accessTokens: { maxActive: null },
  discovery: {
    concurrency: null,
    catalogTtlSeconds: null,
    persistCatalog: null,
    staleCatalogSeconds: null,
    probeTimeoutMs: null,
  },
  calls: { defaultTimeoutMs: null, maxResultBytes: null },
  execute: { maxEmittedBytes: null, maxEmittedBlocks: null },
  admission: {
    requests: admissionPoolSchema,
    code: admissionPoolSchema,
  },
  branding: {
    productName: null,
    productUrl: null,
    ownerName: null,
    ownerUrl: null,
    description: null,
    pageTitle: null,
    favicon: { svg: null, ico: null, href: null },
    themeColor: null,
  },
  logger: null,
  serverInfo: {
    name: null,
    version: null,
    title: null,
    websiteUrl: null,
    icons: [{ src: null, mimeType: null, sizes: null }],
  },
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
      paths.map((path) => `- ${path}`).join("\n"),
  );
}

/** Reject JavaScript typos and removed options before construction does work. */
function assertKnownConfig(config: ConnectaConfig): void {
  rejectUnknownOptions(
    unknownOptionPaths(config, "ConnectaConfig", CONFIG_SCHEMA),
  );
  const activity = config.activity as unknown;
  if (
    activity !== undefined &&
    (typeof activity !== "object" ||
      activity === null ||
      typeof (activity as ConnectaActivityConfig).store?.record !== "function")
  ) {
    throw new Error(
      "ConnectaConfig.activity.store must implement record(event)",
    );
  }
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
  const configuredAuth = normalizeAuth(config.auth);
  const accessTokens = config.accessTokens
    ? new AccessTokenManager(storage, config.accessTokens)
    : undefined;
  if (
    accessTokens &&
    !configuredAuth.some((provider) => provider.uiAuth?.kind === "clerk")
  ) {
    throw new Error(
      "accessTokens requires a Clerk auth provider: only an eligible Clerk " +
        "operator may create, rename, or revoke deployment access tokens",
    );
  }
  const serverInfo = {
    ...config.serverInfo,
    name: config.serverInfo?.name ?? "connecta",
    version: config.serverInfo?.version ?? CONNECTA_VERSION,
  };
  const registry = new Registry(config.connectors, {
    storage,
    logger,
    credentialVault,
    catalogDriftActivity: config.activity?.store
      ? {
          sink: config.activity.store,
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
  });
  const inboundAuth = normalizeAuth(
    accessTokens ? [accessTokens.auth, ...configuredAuth] : configuredAuth,
  );
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
  const handler = createFetchHandler({
    registry,
    auth: inboundAuth,
    publicUrl: config.publicUrl,
    serverInfo,
    logger,
    activity: config.activity?.store,
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
    credentialVault,
    accessTokens,
    deploymentInfo: config.deploymentInfo,
    branding: config.branding,
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
export type {
  AccessTokenMetadata,
  CreatedAccessToken,
} from "./access-tokens.js";
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
  Connector,
  ConnectorCallAdmissionInput,
  ConnectorCallAdmissionPolicy,
  ConnectorCallAdmissionRule,
  ConnectorRollingWindowBudget,
  ConnectaBranding,
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
  AgentFriction,
  CatalogDriftActivityEvent,
  ToolCallActivityEvent,
} from "./activity.js";
export { InvalidActivityCursorError } from "./activity.js";
