import { CredentialVault } from "./credentials.js";
import { Registry } from "./registry.js";
import { createFetchHandler } from "./server.js";
import { droppedBrandingUrls, droppedUiAuthUrls } from "./ui.js";
import {
  resolveToolkits,
  type Toolkit,
  type ToolkitConfig,
} from "./toolkits.js";
import { memoryStorage } from "./storage/memory.js";
import { CONNECTA_VERSION } from "./version.js";
import type { ActivityReadGate, ActivityStore } from "./activity.js";
import type {
  Connector,
  ConnectaBranding,
  Executor,
  InboundAuth,
  KVStorage,
  Logger,
} from "./types.js";

export interface ConnectaConfig {
  connectors: Connector[];
  /**
   * Named scoped views over `connectors`, selected per client connection with
   * `?toolkit=<name>` on the `/mcp` URL. One deployment belongs to one org;
   * a toolkit is the slice of it a group of team members sees.
   *
   * ```ts
   * toolkits: {
   *   support: { connectors: ["zendesk", "notion"] },
   *   exec: {
   *     connectors: ["zendesk", "notion", "gmail"],
   *     excludeTools: ["gmail.send_message"],
   *   },
   * }
   * ```
   *
   * Inside a toolkit-scoped session every meta-tool behaves as if out-of-scope
   * connectors and tools do not exist, and an out-of-scope address fails
   * exactly as a nonexistent one does. No `?toolkit=` ⇒ the full registry, so
   * adding toolkits changes nothing for connections that don't ask for one; an
   * unknown name is an error, never a silent fallback.
   *
   * Toolkits scope VISIBILITY, not identity: they do not decide *which* team
   * member may select which toolkit. Gate that in `auth` (per-member binding is
   * a follow-up).
   *
   * Definitions are validated at construction: an unknown connector id, an
   * empty connector selection, an empty `includeTools`, a malformed tool
   * address, or an address naming no tool on an in-code connector all throw.
   */
  toolkits?: ToolkitConfig;
  /**
   * Privacy-minimal downstream tool activity storage. Writes are best-effort
   * and never change tool results. Implement `list` to enable the Activity UI.
   */
  activity?: ActivityStore;
  /**
   * Optional authorization gate for the Activity read API. MCP authentication
   * is still required first. Omit to admit every authenticated actor.
   */
  activityReadGate?: ActivityReadGate;
  /** Stable deployment label included in activity events, e.g. "production". */
  activityDeploymentId?: string;
  /** Inbound auth adapters. Includes bearerToken(...); omit for open (dev). */
  auth?: InboundAuth | InboundAuth[];
  /** KVStorage impl. Defaults to memoryStorage(). */
  storage?: KVStorage;
  /**
   * Public base URL. Defaults to the request origin per-request. Configuring an
   * HTTPS URL also redirects matching inbound HTTP requests to HTTPS.
   */
  publicUrl?: string;
  /**
   * Base64-encoded 32-byte AES key for connector credentials managed in /ui.
   * Keep this in the runtime's secret store, never in KV or source control.
   */
  credentialEncryptionKey?: string;
  /** Optional browser UI and OAuth result-page labels. */
  branding?: ConnectaBranding;
  logger?: Logger;
  /** Tool-list cache TTL (seconds). Default 300. */
  toolCacheTtlSeconds?: number;
  /**
   * Persist serializable remote tool catalogs in storage so cold isolates can
   * discover tools without a downstream handshake. Default true.
   */
  persistToolCatalog?: boolean;
  /**
   * How long an expired persisted catalog remains available as a fallback
   * when a live refresh fails. Default 3600 seconds.
   */
  toolCatalogStaleSeconds?: number;
  /**
   * Max inline result size (bytes) before call_tool/batch_call truncate and
   * stash the full text for get_result paging. Must be a whole number of bytes
   * >= 1; anything else (0, negative, fractional, NaN, Infinity) warns at
   * startup and falls back to the default 50_000.
   */
  maxResultBytes?: number;
  /**
   * Deadline (ms) applied to call_tool/batch_call calls that pass no
   * `timeoutMs`, giving the connector both a budget (`ctx.timeoutMs`) and a
   * cancellation signal (`ctx.signal`). An explicit per-call `timeoutMs` always
   * wins. **Opt-in — undefined by default**, because switching it on globally
   * would put a deadline on every call in an existing deployment and the
   * failure mode is a working long-running call starting to time out.
   * `execute_code` host calls are unaffected; they already carry a 15 s bound.
   *
   * Bounds a single attempt, not the whole call — the same as an explicit
   * `timeoutMs` has always done. A call that also passes `maxRetries` can
   * therefore run to roughly `(maxRetries + 1)` times this value plus backoff.
   * `maxRetries` defaults to 0, so this is the total for every call that does
   * not explicitly ask to retry.
   */
  defaultToolTimeoutMs?: number;
  /**
   * Deadline (ms) applied to each individual downstream probe/catalog call that
   * the discovery meta-tools fan out — `list_connectors` (with `probe`),
   * `search_tools`, and `describe_tools` — so a single hung connector can no
   * longer stall the whole meta-tool call. **Defaults to a generous 30_000**,
   * chosen to trip only on a pathological hang, not on a realistically slow
   * probe, so having it on by default will not break existing deployments.
   * Bounds one downstream call, not the whole fan-out: a connector that outruns
   * it degrades to an unavailable/errored entry while the rest are unaffected.
   *
   * Does NOT apply to `call_tool`/`batch_call` — those carry their own budget
   * via `defaultToolTimeoutMs` or a per-call `timeoutMs`. Note this bounds the
   * caller-facing wait only; the underlying fetch is not currently aborted, so
   * real cancellation of the downstream request is a deferred follow-up.
   */
  probeTimeoutMs?: number;
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
   * Sandbox for the optional execute_code meta-tool (code mode). Omit → the
   * tool is not registered and connecta serves the nine base tools. Workers:
   * `new DynamicWorkerExecutor({ loader: env.LOADER })` from
   * `@cloudflare/codemode`. Node: `quickJsExecutor()` from "@zackbart/connecta/quickjs".
   */
  executor?: Executor;
}

export interface Connecta {
  /** Web-standard fetch handler. Usable as `export default { fetch: connecta.fetch }`. */
  fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response>;
  registry: Registry;
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

/**
 * One-time construction warnings for deployment shapes that run fine but are
 * usually unintended. Warning-only — never throws and never changes behavior;
 * each condition emits at most one `logger.warn`. Iterates connectors once.
 */
function warnInsecureConfig(
  config: ConnectaConfig,
  inboundAuth: InboundAuth[],
  toolkits: ReadonlyMap<string, Toolkit> | undefined,
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

  // Toolkits with no inbound auth: a toolkit is a scoped VIEW selected by the
  // caller, not an authentication boundary. With nothing gating /mcp, any
  // caller picks any toolkit — or omits the parameter and sees everything.
  //
  // Keyed off the RESOLVED toolkits, which is the same map `?toolkit=` resolves
  // against, rather than the presence of the config key: `toolkits: {}` is a
  // truthy object that resolves to nothing selectable, so warning about a
  // choice no caller can make would name a risk that does not exist. The
  // open-mode warning above still covers the deployment being unauthenticated.
  if (inboundAuth.length === 0 && toolkits) {
    logger.warn(
      "[connecta] toolkits are configured but there is no inbound " +
        "authentication: a toolkit is a scoped view a client selects with " +
        "?toolkit=, not an access check, so any caller can choose any toolkit " +
        "or omit the parameter and see every connector. Configure `auth` " +
        "(for example bearerToken(...) or Clerk).",
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

  // A provider's uiAuth.frontendApiUrl becomes the `<script src>` of /ui's
  // sign-in loader, so it takes the same gate-or-drop treatment as a branding
  // href. Rendering omits the loader entirely for a rejected value — the
  // dashboard then reports that Clerk could not load — which is a confusing
  // symptom without this line naming the cause.
  for (const provider of inboundAuth) {
    const droppedUiAuth = droppedUiAuthUrls(provider.uiAuth);
    if (droppedUiAuth.length > 0) {
      logger.warn(
        `[connecta] inbound auth provider "${provider.kind}" had ` +
          `${droppedUiAuth.join(", ")} dropped: the browser sign-in loader is ` +
          "fetched from this origin, so it must be an absolute https URL. /ui " +
          "renders without the loader and cannot start a sign-in.",
      );
    }
  }

  // OAuth connectors whose callback performs no state/CSRF check: the public
  // /oauth/callback/<id> route would exchange any delivered code.
  for (const connector of oauthConnectors) {
    if (!connector.verifyState) {
      logger.warn(
        `[connecta] connector "${connector.id}" has an OAuth callback with no ` +
          `state/CSRF check: /oauth/callback/${connector.id} will exchange any ` +
          "delivered code. Implement `verifyState` (the shipped remoteMcp " +
          "connector already does).",
      );
    }
  }
}

export function createConnecta(config: ConnectaConfig): Connecta {
  const storage = config.storage ?? memoryStorage();
  const logger = config.logger ?? defaultLogger();
  const credentialConnectors = config.connectors.filter((c) => c.credential);
  if (credentialConnectors.length > 0 && !config.credentialEncryptionKey) {
    throw new Error(
      `credentialEncryptionKey is required by connector credentials: ${credentialConnectors.map((c) => c.id).join(", ")}`,
    );
  }
  const credentialVault = config.credentialEncryptionKey
    ? new CredentialVault(storage, config.credentialEncryptionKey)
    : undefined;
  const registry = new Registry(config.connectors, {
    storage,
    logger,
    credentialVault,
    toolCacheTtlSeconds: config.toolCacheTtlSeconds,
    persistToolCatalog: config.persistToolCatalog,
    toolCatalogStaleSeconds: config.toolCatalogStaleSeconds,
    maxResultBytes: config.maxResultBytes,
  });
  // Throws on every structural mistake it can see (see resolveToolkits): a
  // typo must not become a scope the operator never wrote. Note this is about
  // the scope being *intended*, not about it being an access check — a toolkit
  // scopes visibility, and `auth` remains the thing deciding who gets in.
  const toolkits = resolveToolkits(config.toolkits, config.connectors);
  const inboundAuth = normalizeAuth(config.auth);
  warnInsecureConfig(config, inboundAuth, toolkits, logger);
  const handler = createFetchHandler({
    registry,
    auth: inboundAuth,
    publicUrl: config.publicUrl,
    serverInfo: {
      ...config.serverInfo,
      name: config.serverInfo?.name ?? "connecta",
      version: config.serverInfo?.version ?? CONNECTA_VERSION,
    },
    logger,
    activity: config.activity,
    activityReadGate: config.activityReadGate,
    activityDeploymentId: config.activityDeploymentId,
    executor: config.executor,
    defaultToolTimeoutMs: config.defaultToolTimeoutMs,
    probeTimeoutMs: config.probeTimeoutMs,
    credentialVault,
    deploymentInfo: config.deploymentInfo,
    branding: config.branding,
    ...(toolkits ? { toolkits } : {}),
  });
  return {
    fetch: (request, _env, ctx) =>
      handler(
        request,
        ctx && typeof (ctx as { waitUntil?: unknown }).waitUntil === "function"
          ? (ctx as { waitUntil(promise: Promise<unknown>): void })
          : undefined,
      ),
    registry,
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
export { memoryStorage } from "./storage/memory.js";
export { CONNECTA_VERSION } from "./version.js";
// Registry is reachable through `Connecta.registry`, so its type is public;
// the class itself, the credential vault, and the meta-tool/sandbox factories
// are internal factoring and are deliberately not part of the API surface.
export type { Registry } from "./registry.js";
// Config-as-code shapes for `ConnectaConfig.toolkits`. The resolved `Toolkit`
// and the `ScopedRegistry` that enforces it are internal factoring.
export type { ToolkitConfig, ToolkitDefinition } from "./toolkits.js";

export type { RemoteMcpOptions, RemoteMcpAuth } from "./connectors/remote-mcp.js";
export type { ApiOptions, ApiTool } from "./connectors/api.js";
export type {
  Connector,
  ConnectaBranding,
  ConnectorCredentialAccess,
  ConnectorCredentialConfig,
  ConnectorCredentialFieldConfig,
  ConnectorCredentialValues,
  ConnectorContext,
  ConnectorStatus,
  CredentialTestResult,
  ExecuteResult,
  Executor,
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
  ActivityReader,
  ActivityReadGate,
  ActivitySink,
  ActivityStore,
  ToolCallActivityEvent,
} from "./activity.js";
export { InvalidActivityCursorError } from "./activity.js";
