import { CredentialVault } from "./credentials.js";
import { Registry } from "./registry.js";
import { createFetchHandler } from "./server.js";
import { droppedBrandingUrls, droppedUiAuthUrls } from "./ui.js";
import {
  resolveToolkits,
  validateToolkitBindings,
  type Toolkit,
  type ToolkitConfig,
} from "./toolkits.js";
import { memoryStorage } from "./storage/memory.js";
import { CONNECTA_VERSION } from "./version.js";
import type { ActivityReadGate, ActivityStore } from "./activity.js";
import type {
  CredentialCheckResult,
  CredentialHealthConfig,
} from "./credential-health.js";
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
   * Selection is self-service until a toolkit is BOUND to an inbound identity:
   * pass `toolkits` to an auth adapter — `bearerToken(secret, { toolkits:
   * ["support"] })` — and that credential may open only those toolkits, and may
   * not connect unscoped unless it also passes `unscoped: true`. An unbound
   * identity keeps the self-service behavior.
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
  /**
   * Tuning for the proactive credential liveness checks (issue #24) that let a
   * connector's status flip to `auth_required` *before* an agent's call fails.
   * Defaults are safe to leave alone: at most one check per connector per 15
   * minutes, four in flight, 30 s each, triggered opportunistically by inbound
   * authenticated traffic. Only connectors holding a credential connecta stores
   * — an operator-managed `credential`, or a downstream-OAuth grant — are ever
   * checked, and a check never calls a downstream tool.
   *
   * `Connecta.checkCredentials()` is the same check on demand, for a Worker cron
   * trigger or a Node interval.
   */
  credentialHealth?: CredentialHealthConfig;
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
  /**
   * Check the stored downstream credentials now — the scheduler-facing half of
   * credential health (issue #24). Wire it to whatever timer the runtime has:
   *
   * ```ts
   * // Cloudflare Workers (wrangler.jsonc: "triggers": { "crons": ["*\/15 * * * *"] })
   * async scheduled(_c, env, ctx) { ctx.waitUntil(build(env).checkCredentials()); }
   * // Node
   * setInterval(() => void connecta.checkCredentials(), 15 * 60_000).unref();
   * ```
   *
   * Returns one outcome per connector considered, including why a connector was
   * skipped (`fresh` is the rate limit: a connector checked less than
   * `credentialHealth.intervalSeconds` ago is not re-checked unless `force`).
   * Never rejects on a connector failure — a broken connector becomes an `error`
   * verdict. Needs a base URL for connector contexts: `publicUrl` supplies it,
   * or pass one.
   */
  checkCredentials: (opts?: {
    baseUrl?: string;
    force?: boolean;
    ids?: string[];
  }) => Promise<CredentialCheckResult[]>;
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

  // Toolkits that nothing binds to an identity: selection is then self-service,
  // and the boundary organizes the surface rather than protecting it. Three
  // distinct shapes, so three distinct warnings — an operator can only act on
  // the one they are actually in.
  //
  // All are keyed off the RESOLVED toolkits, which is the same map `?toolkit=`
  // resolves against, rather than the presence of the config key: `toolkits: {}`
  // is a truthy object that resolves to nothing selectable, so warning about a
  // choice no caller can make would name a risk that does not exist.
  if (toolkits) {
    const unbound = inboundAuth.filter((provider) => !provider.toolkitBinding);
    if (inboundAuth.length === 0) {
      // No auth at all ⇒ no identity exists to bind, so binding is not even the
      // fix here. The open-mode warning above covers the wider exposure.
      logger.warn(
        "[connecta] toolkits are configured but there is no inbound " +
          "authentication: with no identity to bind a toolkit to, any caller " +
          "can choose any toolkit or omit ?toolkit= and see every connector. " +
          "Configure `auth` (for example bearerToken(...) or Clerk), then bind " +
          "each credential with `toolkits: [...]`.",
      );
    } else if (unbound.length === inboundAuth.length) {
      // Authenticated, but every credential may still select every view. This is
      // the shape issue #37 exists to close, and it is invisible without a line
      // saying so: nothing fails, the teams are simply not separated.
      logger.warn(
        "[connecta] toolkits are configured but no inbound identity is bound " +
          "to one: every credential `auth` admits can select any toolkit, or " +
          "omit ?toolkit= and see the whole deployment, so a token handed to " +
          "one team also opens the others' views. Bind each credential with " +
          "`toolkits: [...]` on its auth adapter (add `unscoped: true` for an " +
          "operator credential that should still see everything).",
      );
    } else if (unbound.length > 0) {
      // The dangerous middle: SOME credentials are bound, which is exactly when
      // an operator believes the deployment is separated — while one forgotten
      // provider still opens every view and the whole deployment-wide surface.
      // Naming the unbound providers is the point; an intentionally unrestricted
      // credential says so with `unscoped: true` and stops appearing here.
      const counted = new Map<string, number>();
      for (const provider of unbound) {
        counted.set(provider.kind, (counted.get(provider.kind) ?? 0) + 1);
      }
      const named = [...counted]
        .map(([kind, count]) => (count > 1 ? `${kind} x${count}` : kind))
        .join(", ");
      logger.warn(
        `[connecta] toolkits are bound on some inbound auth providers but not ` +
          `all: ${named} ${unbound.length === 1 ? "declares" : "declare"} no ` +
          "binding, so a caller that provider admits can still select any " +
          "toolkit, connect unscoped, and read the deployment-wide operator " +
          "surfaces — whatever the bound credentials beside it allow. Bind it " +
          "too, or declare the exemption with `toolkits: [...], unscoped: true` " +
          "if it is meant to be an operator credential.",
      );
    }
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

  // /ui renders exactly one provider's browser sign-in config — the first that
  // offers one, which is the same `find` the /ui route performs — and that
  // provider's frontendApiUrl becomes the loader's `<script src>`. Gate-or-drop
  // like a branding href: rendering omits the loader for a rejected value and
  // the dashboard then reports that Clerk could not load, a confusing symptom
  // without this line naming the cause. Checking only the rendered provider
  // keeps the claim true — a later provider's uiAuth never reaches the page, so
  // there is nothing there to warn about.
  const uiAuthProvider = inboundAuth.find((provider) => provider.uiAuth);
  const droppedUiAuth = droppedUiAuthUrls(uiAuthProvider?.uiAuth);
  if (uiAuthProvider && droppedUiAuth.length > 0) {
    logger.warn(
      `[connecta] inbound auth provider "${uiAuthProvider.kind}" had ` +
        `${droppedUiAuth.join(", ")} dropped: the browser sign-in loader is ` +
        "fetched from this origin, so it must be an absolute https URL. /ui " +
        "renders without the loader and cannot start a sign-in.",
    );
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
    credentialHealth: config.credentialHealth,
  });
  // Throws on every structural mistake it can see (see resolveToolkits): a
  // typo must not become a scope the operator never wrote. Note this is about
  // the scope being *intended*, not about it being an access check — a toolkit
  // scopes visibility, and `auth` remains the thing deciding who gets in.
  const toolkits = resolveToolkits(config.toolkits, config.connectors);
  const inboundAuth = normalizeAuth(config.auth);
  // Same contract for the identity half: a binding that names a toolkit this
  // deployment does not declare would deny that credential every connection,
  // with a 403 its client reports as a transport failure. Throw here instead.
  validateToolkitBindings(inboundAuth, toolkits);
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
    checkCredentials: (opts = {}) => {
      // A scheduled check has no inbound request to derive an origin from, and
      // a connector context without one would mint OAuth redirect URIs against
      // a guess. Say so instead: the fix is one config line.
      const baseUrl = opts.baseUrl ?? config.publicUrl;
      if (!baseUrl) {
        // Rejected, not thrown: the callers this is written for are
        // `ctx.waitUntil(...)` and `.catch(...)` on the returned promise, and a
        // synchronous throw escapes both — it would take down a scheduled
        // handler instead of being reported by it.
        return Promise.reject(
          new Error(
            "checkCredentials() needs a base URL: set `publicUrl` on the " +
              "config (recommended — it is also what downstream OAuth " +
              "callbacks use) or pass checkCredentials({ baseUrl }).",
          ),
        );
      }
      return registry.checkCredentialHealth(baseUrl, {
        ...(opts.force !== undefined ? { force: opts.force } : {}),
        ...(opts.ids ? { ids: opts.ids } : {}),
      });
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
// Config-as-code shapes for `ConnectaConfig.toolkits` and the identity bindings
// that gate them. The resolved `Toolkit` and the `ScopedRegistry` that enforces
// it are internal factoring.
export type {
  ToolkitBindingOptions,
  ToolkitConfig,
  ToolkitDefinition,
} from "./toolkits.js";
// Credential health: the config shape, and the result shape a scheduled
// `checkCredentials()` returns. The checker itself is internal factoring.
export type {
  CredentialCheckResult,
  CredentialCheckSkip,
  CredentialCheckState,
  CredentialHealthConfig,
  CredentialHealthRecord,
} from "./credential-health.js";

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
  ToolkitBinding,
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
