import { CredentialVault } from "./credentials.js";
import { Registry } from "./registry.js";
import { createFetchHandler } from "./server.js";
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
   * stash the full text for get_result paging. Default 50_000.
   */
  maxResultBytes?: number;
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
  const handler = createFetchHandler({
    registry,
    auth: normalizeAuth(config.auth),
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
    credentialVault,
    deploymentInfo: config.deploymentInfo,
    branding: config.branding,
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
export { bearerToken } from "./auth/bearer.js";
export { memoryStorage } from "./storage/memory.js";
export { CONNECTA_VERSION } from "./version.js";
// Registry is reachable through `Connecta.registry`, so its type is public;
// the class itself, the credential vault, and the meta-tool/sandbox factories
// are internal factoring and are deliberately not part of the API surface.
export type { Registry } from "./registry.js";

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
