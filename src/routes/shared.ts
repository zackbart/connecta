import type { Implementation } from "@modelcontextprotocol/server";
import type { ActivityModule, OperatorSurface } from "../module-contracts.js";
import type { ActivityActor, ActivityReadGate, ActivityStore } from "../activity.js";
import type { CredentialVault } from "../credential-contract.js";
import type { DeferredWork } from "../connector-scope.js";
import type { AdmissionController } from "../executor-admission.js";
import type { Registry } from "../registry.js";
import type {
  AuthenticatedIdentity,
  ConnectaBranding,
  Executor,
  InboundAuth,
  InboundAuthRuntimeContext,
  Logger,
} from "../types.js";
import { identityStorageKey, validIdentityReference } from "../identity.js";
import type { ConnectorPermission, ConnectaIdentityConfig } from "../index.js";
export { msg } from "../errors.js";

export interface ServerOptions {
  registry: Registry;
  auth: InboundAuth[];
  identity?: ConnectaIdentityConfig | undefined;
  publicUrl?: string | undefined;
  // The SDK's Implementation shape: name/version plus optional title,
  // websiteUrl, and icons (MCP icons spec) that clients may render.
  serverInfo: Implementation;
  logger: Logger;
  activity?: ActivityStore | undefined;
  activityReadGate?: ActivityReadGate | undefined;
  activityDeploymentId?: string | undefined;
  deploymentInfo?: Record<string, unknown> | undefined;
  /** Deadline for call_tool/call_destructive_tool calls that pass no timeoutMs. Off when unset. */
  defaultToolTimeoutMs?: number | undefined;
  /** Per-connector deadline for the search/describe probe fan-out. Default 30_000. */
  probeTimeoutMs?: number | undefined;
  /** Maximum simultaneous connector discovery operations. Default 4. */
  discoveryConcurrency?: number | undefined;
  /** Aggregate serialized-byte budget for connecta.emit per run. Default 4_000_000. */
  maxEmittedBytes?: number | undefined;
  /** Block-count budget for connecta.emit per run. Default 32. */
  maxEmittedBlocks?: number | undefined;
  /** Host calls one execute_code program may make. Default 20. */
  maxHostCalls?: number | undefined;
  /** Deadline per execute_code host call. Default 15_000. */
  hostCallTimeoutMs?: number | undefined;
  /** Required sandbox backing the execute_code meta-tool. */
  executor: Executor;
  /** Sanitized identity of the configured sandbox, when it has one. */
  executorName?: string | undefined;
  /** Global FIFO boundary for all non-preflight `/mcp` requests. */
  requestAdmission: AdmissionController;
  /** Encrypted connector-credential storage backing the Credentials page. */
  credentialVault?: CredentialVault | undefined;
  /** Optional browser routes, with no implementation import in core. */
  ui?: OperatorSurface | undefined;
  activityModule?: ActivityModule | undefined;
  /** Optional browser UI and OAuth result-page labels. */
  branding?: ConnectaBranding | undefined;
}

export interface RuntimeExecutionContext extends InboundAuthRuntimeContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RouteContext {
  request: Request;
  url: URL;
  path: string;
  baseUrl: string;
  opts: ServerOptions;
  defer: DeferredWork | undefined;
  runtimeContext: RuntimeExecutionContext | undefined;
}

export function privateJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { ...init, headers });
}

const MAX_LOGGED_VALUE_LENGTH = 64;

/**
 * Bounded, escaped form of a caller-influenced value (an identity id or OAuth
 * callback connector id) for the operator log. Goes
 * through JSON.stringify so a caller-controlled newline or control character
 * cannot forge a log line, plus a hand-rolled escape for U+2028/U+2029, which
 * JSON.stringify leaves raw even though a log reader treats them as line
 * terminators. Truncated to a small shared cap so an oversized value cannot
 * flood the log either.
 */
export function loggableValue(requested: string): string {
  const bounded = requested.slice(0, MAX_LOGGED_VALUE_LENGTH);
  const escaped = JSON.stringify(bounded).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
  return escaped + (bounded.length < requested.length ? " (truncated)" : "");
}

const ACTIVITY_ACTOR_NAMESPACE_RE = /^[\x21-\x7e]{1,256}$/;

export function activityActorNamespace(
  provider: InboundAuth,
): string | undefined {
  return typeof provider.activityActorNamespace === "string" &&
    ACTIVITY_ACTOR_NAMESPACE_RE.test(provider.activityActorNamespace)
    ? provider.activityActorNamespace
    : undefined;
}

export async function authorize(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  runtimeContext?: RuntimeExecutionContext,
  identityConfig?: ConnectaIdentityConfig,
  partitionIdentity = true,
): Promise<
  | {
      ok: true;
      actor: ActivityActor;
      identity: AuthenticatedIdentity;
      subjectKey?: string;
      principalKey?: string;
      connectorIds: "all" | readonly string[];
      operator: boolean;
      credentialAdministration: ConnectorPermission;
      personalConnection: ConnectorPermission;
      /** Backward-compatible name used by operator views. */
      uiAdminEligible?: boolean;
    }
  | { ok: false; response: Response }
> {
  if (auth.length === 0) {
    const actor = { kind: "anonymous" } as const;
    const identity: AuthenticatedIdentity = { actor, interactive: false };
    let connectorIds: "all" | readonly string[] = "all";
    try {
      connectorIds = identityConfig?.connectorAccess ? await identityConfig.connectorAccess(identity) : "all";
      if (connectorIds !== "all" && (!Array.isArray(connectorIds) || !connectorIds.every(id => typeof id === "string" && /^[a-z0-9_-]+$/.test(id)))) throw new Error("invalid connector permission");
    } catch {
      return {
        ok: false,
        response: privateJson({ error: "identity access resolution failed" }, { status: 403 }),
      };
    }
    return { ok: true, actor, identity, connectorIds, operator: false, credentialAdministration: "none", personalConnection: "none" };
  }
  let lastResponse: Response | null = null;
  for (const provider of auth) {
    const result = await provider.authorize(request, baseUrl, runtimeContext);
    if (result.ok) {
      const subjectId = result.subjectId ?? result.userId;
      const actorNamespace = activityActorNamespace(provider);
      const subject = subjectId && actorNamespace
        ? { namespace: actorNamespace, id: subjectId }
        : undefined;
      const derivedPrincipal = result.userId && actorNamespace
        ? { namespace: actorNamespace, id: result.userId }
        : undefined;
      const principal = validIdentityReference(result.principal)
        ? result.principal
        : derivedPrincipal;
      const interactive = Boolean(result.userId && provider.interactiveOperator);
      const actor: ActivityActor = {
        kind: provider.kind,
        ...(subjectId ? { id: subjectId } : {}),
        ...(subject ? { namespace: subject.namespace } : {}),
      };
      const identity: AuthenticatedIdentity = {
        actor,
        ...(subject ? { subject } : {}),
        ...(principal ? { principal } : {}),
        interactive,
      };
      let operator = interactive;
      let credentialAdministration: ConnectorPermission = "none";
      let personalConnection: ConnectorPermission = "none";
      let connectorIds: "all" | readonly string[] = "all";
      try {
        if (identityConfig?.activityAccess) {
          operator = interactive && principal
            ? await identityConfig.activityAccess(principal)
            : false;
        }
        connectorIds = identityConfig?.connectorAccess ? await identityConfig.connectorAccess(identity) : "all";
        if (interactive) {
          credentialAdministration = identityConfig?.credentialAdministration ? await identityConfig.credentialAdministration(identity) : "none";
          personalConnection = principal && identityConfig?.personalConnection ? await identityConfig.personalConnection(identity) : "none";
        }
        if (typeof operator !== "boolean") throw new Error("invalid activity permission");
        for (const permission of [connectorIds, credentialAdministration, personalConnection]) {
          if (permission !== "all" && permission !== "none" && (!Array.isArray(permission) || !permission.every(id => typeof id === "string" && /^[a-z0-9_-]+$/.test(id)))) throw new Error("invalid identity permission");
        }
      } catch {
        return {
          ok: false,
          response: privateJson(
            { error: "identity access resolution failed" },
            { status: 403 },
          ),
        };
      }
      return {
        ok: true,
        actor,
        identity,
        ...(subject && partitionIdentity
          ? { subjectKey: await identityStorageKey(subject) }
          : {}),
        ...(principal && partitionIdentity
          ? { principalKey: await identityStorageKey(principal) }
          : {}),
        connectorIds,
        credentialAdministration,
        personalConnection,
        operator,
        ...(operator ? { uiAdminEligible: true } : {}),
      };
    }
    lastResponse = result.response;
  }
  return {
    ok: false,
    response:
      lastResponse ??
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      }),
  };
}

export async function authorizeUiIdentity(
  request: Request,
  baseUrl: string,
  auth: InboundAuth[],
  purpose: string,
  runtimeContext?: RuntimeExecutionContext,
  identityConfig?: ConnectaIdentityConfig,
): Promise<
  | Extract<Awaited<ReturnType<typeof authorize>>, { ok: true }>
  | { ok: false; response: Response }
> {
  const providers = auth.filter((candidate) => candidate.interactiveOperator);
  if (providers.length === 0) {
    return {
      ok: false,
      response: privateJson(
        { error: `${purpose} requires interactive user authentication` },
        { status: 403 },
      ),
    };
  }
  let lastResponse: Response | undefined;
  for (const provider of providers) {
    const authz = await authorize(
      request,
      baseUrl,
      [provider],
      runtimeContext,
      identityConfig,
    );
    if (!authz.ok) {
      lastResponse = authz.response;
      continue;
    }
    if (authz.identity.interactive) return authz;
    lastResponse = privateJson(
      { error: "authenticated user required" },
      { status: 403 },
    );
  }
  return {
    ok: false,
    response: lastResponse ?? privateJson(
      { error: `${purpose} requires interactive user authentication` },
      { status: 403 },
    ),
  };
}

export function isSameOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function withSecurityHeaders(
  response: Response,
  requestUrl: URL,
  _path: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (requestUrl.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type AuthorizedIdentity = Extract<Awaited<ReturnType<typeof authorize>>, { ok: true }>;

/** Unknown configured ids refuse the complete view, including management rights. */
export function validateAuthPermissions(
  authz: AuthorizedIdentity,
  registry: Registry,
): void {
  for (const value of [
    authz.connectorIds,
    authz.credentialAdministration,
    authz.personalConnection,
  ]) {
    if (value === "all" || value === "none") continue;
    if (!Array.isArray(value) || value.some(id => !registry.getConnector(id))) {
      throw new Error("invalid identity permission connector ids");
    }
  }
}

export function mayManageConnector(
  authz: AuthorizedIdentity,
  connector: { id: string; authScope?: "shared" | "personal" },
): boolean {
  if (!authz.identity.interactive) return false;
  if (authz.connectorIds !== "all" && !authz.connectorIds.includes(connector.id)) {
    return false;
  }
  const permission = connector.authScope === "personal"
    ? authz.personalConnection
    : authz.credentialAdministration;
  return permission === "all" ||
    (permission !== "none" && permission.includes(connector.id));
}
