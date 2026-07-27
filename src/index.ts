import {
  CredentialVault,
  credentialTestRule,
  describeCredentialTestMismatch,
} from "./credentials.js";
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

/** Operator-vault encryption and proactive credential-health tuning. */
export interface ConnectaCredentialsConfig {
  /**
   * Base64-encoded 32-byte AES key for connector credentials managed in /ui.
   * Keep this in the runtime's secret store, never in KV or source control.
   */
  encryptionKey?: string;
  /**
   * Tuning for proactive credential liveness checks that let a connector's
   * status flip to `auth_required` before an agent's call fails. Defaults: one
   * check per connector per 15 minutes, four in flight, 30 seconds each,
   * triggered opportunistically by inbound authenticated traffic.
   *
   * Optional even without an encryption key because downstream OAuth connectors
   * manage their own grants. `Connecta.checkCredentials()` runs the same checks
   * on demand for a Worker cron trigger or Node interval.
   */
  health?: CredentialHealthConfig;
}

/** Tool-catalog caching, persistence, stale fallback, and probe deadlines. */
export interface ConnectaDiscoveryConfig {
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
   * to tool calls or currently abort the underlying fetch.
   */
  probeTimeoutMs?: number;
}

/** Deployment-wide call deadlines and inline-result paging threshold. */
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
}

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
  /** Operator credential vault and proactive liveness-check settings. */
  credentials?: ConnectaCredentialsConfig;
  /** Tool-catalog caching, persistence, stale fallback, and probe deadlines. */
  discovery?: ConnectaDiscoveryConfig;
  /** Deployment-wide call deadlines and result paging threshold. */
  calls?: ConnectaCallsConfig;
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
   * `credentials.health.intervalSeconds` ago is not re-checked unless `force`).
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

const LEGACY_CONFIG_MIGRATIONS = [
  ["activityReadGate", "activity.readGate"],
  ["activityDeploymentId", "activity.deploymentId"],
  ["credentialEncryptionKey", "credentials.encryptionKey"],
  ["credentialHealth", "credentials.health"],
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
  // provider's URLs reach the browser: frontendApiUrl as the loader's
  // `<script src>`, signInUrl/signUpUrl as the addresses ClerkJS navigates to.
  // Gate-or-drop like a branding href: rendering drops a rejected value and the
  // dashboard then either reports that Clerk could not load or quietly signs in
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
        "value reaches no part of the page: without frontendApiUrl /ui renders " +
        "no loader and cannot start a sign-in, and without signInUrl/signUpUrl " +
        "it signs in through Clerk's defaults.",
    );
  }

  // A credential test hook that cannot test the declared credential shape.
  // The shape picks the hook (see `credentialTestRule`) and the other one is
  // never substituted, so the connector is simply not testable: /ui offers no
  // Test action and the route answers 400. Without this line the only way to
  // discover the mistake is to click a button that isn't there.
  for (const connector of config.connectors) {
    const { mismatch } = credentialTestRule(connector);
    if (!mismatch) continue;
    logger.warn(
      `[connecta] connector "${connector.id}" cannot test its credential: ` +
        `${describeCredentialTestMismatch(mismatch)}. /ui offers no Test ` +
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
  assertNoLegacyConfig(config);
  const storage = config.storage ?? memoryStorage();
  const logger = config.logger ?? defaultLogger();
  const credentialConnectors = config.connectors.filter((c) => c.credential);
  const encryptionKey = config.credentials?.encryptionKey;
  if (credentialConnectors.length > 0 && !encryptionKey) {
    throw new Error(
      `credentials.encryptionKey is required by connector credentials: ${credentialConnectors.map((c) => c.id).join(", ")}`,
    );
  }
  const credentialVault = encryptionKey
    ? new CredentialVault(storage, encryptionKey)
    : undefined;
  const registry = new Registry(config.connectors, {
    storage,
    logger,
    credentialVault,
    toolCacheTtlSeconds: config.discovery?.catalogTtlSeconds,
    persistToolCatalog: config.discovery?.persistCatalog,
    toolCatalogStaleSeconds: config.discovery?.staleCatalogSeconds,
    maxResultBytes: config.calls?.maxResultBytes,
    credentialHealth: config.credentials?.health,
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
    activity: config.activity?.store,
    activityReadGate: config.activity?.readGate,
    activityDeploymentId: config.activity?.deploymentId,
    executor: config.executor,
    defaultToolTimeoutMs: config.calls?.defaultTimeoutMs,
    probeTimeoutMs: config.discovery?.probeTimeoutMs,
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
