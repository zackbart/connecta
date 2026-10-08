import { describeConfigSources } from "./config-value-sources.js";
import {
  credentialTestRule,
  describeCredentialTestMismatch,
} from "./credential-rules.js";
import { Registry } from "./registry.js";
import { intersectAccess, parseConnectorAccess, POOL_NAME_RE } from "./connector-access.js";
import type { ConnectorAccess, ResolvedPool } from "./connector-access.js";
import { createFetchHandler } from "./server.js";
import { createExecuteTool, runClaimMs } from "./execute.js";
import {
  droppedBrandingUrls,
  droppedThemeTokens,
  droppedUiAuthUrls,
} from "./branding.js";
import {
  executeLimits,
  readConfig,
  type ConnectaConfig,
  type ResolvedConfig,
} from "./config.js";
import { describeConfig, type ConnectaConfigDescription } from "./describe-config.js";
export { customExecutor, type CustomExecutorOptions } from "./executor-contract.js";
import {
  AdmissionController,
  executorName,
  isAdmittingExecutor,
  withExecutorAdmission,
} from "./executor-admission.js";
export type {
  AccessTokensModule,
  ActivityModule,
  ArtifactsModule,
  ArtifactsModuleDescription,
  OperatorSurface,
} from "./module-contracts.js";
export type { CredentialVault, CredentialMetadata } from "./credential-contract.js";
export { defineConfig } from "./config.js";
export type {
  AdmissionPoolConfig,
  ConnectaAdmissionConfig,
  ConnectaCallsConfig,
  ConnectaConfig,
  ConnectaDiscoveryConfig,
  ConnectaExecuteConfig,
  ConnectaIdentityConfig,
  ConnectaPoolConfig,
  ConnectaResultsConfig,
  ConnectorPermission,
  RequestAdmissionConfig,
} from "./config.js";
export type {
  ConfigValueSource,
  ConnectaConfigDescription,
  DescribedConnector,
  DescribedLimit,
} from "./describe-config.js";
export interface Connecta {
  /** Web-standard fetch handler. Usable as `export default { fetch: connecta.fetch }`. */
  fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response>;
  registry: Registry;
  /**
   * A secret-free snapshot of the configuration this deployment runs with,
   * built once at construction: limits and where each came from, auth
   * providers, identity rules, pools, modules, and every connector's source,
   * endpoint, auth mode, and static tools. Header values, keys, client
   * secrets, credentials, and functions never appear. The same object is
   * returned on every call.
   */
  describeConfig: () => ConnectaConfigDescription;
  /** Drain and release configured executor resources. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Validate declared pools against the connector set. Everything checkable at
 * construction throws here: a malformed name, an unparseable grant, an
 * unknown connector id, a tool address on an `api()` connector whose static
 * catalog lacks it. Remote catalogs load lazily, so their addresses are
 * checked at catalog load instead and stay unreachable until they match.
 */
function resolvePools(
  pools: ResolvedConfig["pools"],
  registry: Registry,
): Map<string, ResolvedPool> {
  const resolved = new Map<string, ResolvedPool>();
  if (!pools) return resolved;
  // The schema has already refused a pool that is not an object, a missing or
  // non-array `tools`, a non-function `grant`, and a misspelled key — a
  // misspelled `grant` would otherwise boot as a deny-all pool.
  for (const [name, pool] of Object.entries(pools)) {
    if (!POOL_NAME_RE.test(name)) {
      throw new Error(`ConnectaConfig.pools: pool name "${name}" must match [a-z0-9_-]+`);
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
    resolved.set(name, { access, trust: pool.trust, grant: pool.grant ?? (() => false) });
  }
  return resolved;
}

/** Construction warnings for valid but usually unintended deployment choices. */
function warnInsecureConfig(config: ResolvedConfig): void {
  const { auth: inboundAuth, logger } = config;
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
        "Configure Clerk, Cloudflare Access on Workers, or accessTokens(storage) to gate access.",
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
  // Every structural check runs here, before any work: what comes back is the
  // configuration the deployment runs with, defaults applied once.
  const { input, resolved } = readConfig(config);
  const { logger } = resolved;
  const storage = resolved.storage;
  const registry = new Registry([...resolved.connectors], {
    storage,
    logger,
    publicUrl: resolved.publicUrl,
    oauthClientName: resolved.serverInfo.name,
    credentialVault: resolved.vault,
    credentialUi: Boolean(resolved.ui),
    catalogDriftActivity: resolved.activity?.store
      ? {
          sink: resolved.activity.store,
          recordDrift: resolved.activity.recordDrift,
          serverInfo: resolved.serverInfo,
          ...(resolved.activity.deploymentId !== undefined
            ? { deploymentId: resolved.activity.deploymentId }
            : {}),
        }
      : undefined,
    toolCacheTtlSeconds: resolved.discovery.catalogTtlSeconds,
    persistToolCatalog: resolved.discovery.persistCatalog,
    toolCatalogStaleSeconds: resolved.discovery.staleCatalogSeconds,
    maxResultBytes: resolved.calls.maxResultBytes,
    results: resolved.results,
    classification: resolved.classification,
  });
  const pools = resolvePools(resolved.pools, registry);
  warnInsecureConfig(resolved);
  const requestAdmission = new AdmissionController(resolved.admission.requests);
  let codeAdmission: AdmissionController | undefined;
  let executor = resolved.executor;
  // Read the identity off the configured executor, before any wrapper hides
  // it behind an anonymous object literal.
  const configuredExecutorName = executorName(executor);
  const executorAdmits = isAdmittingExecutor(executor);
  if (!executorAdmits) {
    codeAdmission = new AdmissionController(resolved.admission.code);
    executor = withExecutorAdmission(executor, codeAdmission);
  } else if (input.admission?.code) {
    logger.warn(
      "[connecta] admission.code is ignored because the configured executor " +
        "implements acquire() and owns its admission pool; configure that " +
        "executor's concurrency and queue options instead.",
    );
  }
  if (resolved.artifacts?.bindRefresh) {
    const sharedIds = registry.listConnectors()
      .filter((connector) => connector.id !== "artifacts" && connector.authScope !== "personal")
      .map((connector) => connector.id);
    const refreshConfig = {
      ...executeLimits(resolved),
      failOnInvocationFailure: true,
      trust: "read-only" as const,
    };
    const identity = resolved.identity;
    resolved.artifacts.bindRefresh({
      ...(resolved.ui?.branding ? { branding: resolved.ui.branding } : {}),
      claimMs: runClaimMs(refreshConfig),
      execute: async (program, owner, signal, options) => {
        if (!owner) throw new Error("Refresh owner is missing; reconfigure this program.");
        let access = parseConnectorAccess(identity.connectorAccess
          ? await identity.connectorAccess(owner.identity) : "all", { allowReadOnly: true });
        if (owner.pool) {
          const pool = pools.get(owner.pool);
          if (!pool || await pool.grant(owner.identity) !== true) {
            throw new Error("Refresh owner's pool grant is no longer available.");
          }
          access = intersectAccess(access, pool.access);
        }
        if (access.connectorIds !== "all" && !access.connectorIds.includes("artifacts")) {
          throw new Error("Refresh owner no longer has artifact publishing access.");
        }
        if (access.toolAccess?.get("artifacts") &&
          !access.toolAccess.get("artifacts")!.has("set_refresh")) {
          throw new Error("Refresh owner no longer has refresh configuration access.");
        }
        if (access.guardedToolAccess?.get("artifacts")?.has("set_refresh")) {
          throw new Error("A read-only guarded grant cannot configure refresh.");
        }
        access = intersectAccess(access, { connectorIds: sharedIds });
        if (signal.aborted) throw new Error("Refresh deadline expired before execution.");
        const view = registry.scoped({ connectorIds: access.connectorIds,
          ...(access.toolAccess ? { toolAccess: access.toolAccess } : {}),
          ...(access.guardedToolAccess ? { guardedToolAccess: access.guardedToolAccess } : {}) });
        const execute = createExecuteTool(view, resolved.publicUrl!, executor, logger, undefined, {
          ...refreshConfig, waitForAdmission: options?.waitForAdmission,
        });
        return execute({ code: program }, { signal });
      },
    });
  }
  // Built once, from values construction already validated; never per call.
  const description = describeConfig({
    registry,
    raw: input,
    config: resolved,
    executorName: configuredExecutorName,
    executorAdmits,
  });
  const handler = createFetchHandler({
    config: resolved,
    configDescription: description,
    configValueSources: describeConfigSources(description, input),
    registry,
    pools,
    executor,
    executorName: configuredExecutorName,
    requestAdmission,
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
    describeConfig: () => description,
    close: async () => {
      closePromise ??= Promise.resolve().then(async () => {
        requestAdmission.close();
        codeAdmission?.close();
        registry.closeCallAdmission();
        await resolved.executor.close?.();
      });
      await closePromise;
    },
  };
}
export { remoteMcp } from "./connectors/remote-mcp.js";
export { api } from "./connectors/api.js";
export { keys, optionsOf, array, opaque, instance, strings, variants } from "./config-schema.js";
export { defineProvider, PROVIDER_COMMON } from "./provider.js";
export type {
  ProviderContext,
  ProviderDefinition,
  ProviderFactory,
  ProviderGuideInput,
  ProviderKind,
  ProviderOptions,
  ProviderSkill,
} from "./provider.js";
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
export type {
  ApiHandlerContext,
  ApiOAuthAccess,
  ApiOAuthClientAuthentication,
  ApiOAuthConfig,
  ApiOptions,
  ApiTool,
} from "./connectors/api.js";
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
  ConnectorAuthDescription,
  ConnectorDescription,
  ConnectorToolDescription,
  ConnectorUsageGuide,
  DescribedEndpoint,
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
  ReviewedTool,
  ToolClassification,
  ToolDef,
  ToolAnnotations,
  ToolVerdict,
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

export { META_TOOL_NAMES } from "./meta-tool-names.js";
