import { isMachineCredential } from "../inbound-credential.js";
import type { ActivityActor } from "../activity.js";
import type { DeferredWork } from "../connector-scope.js";
import { htmlSecurityHeaders } from "../html-security.js";
import type { AdmissionController } from "../executor-admission.js";
import type { Registry, ToolAccess } from "../registry.js";
import { parseConnectorAccess } from "../connector-access.js";
import type { ConnectorAccess, ResolvedPool } from "../connector-access.js";
import type {
  AuthenticatedIdentity,
  Executor,
  InboundAuth,
  InboundAuthRuntimeContext,
} from "../types.js";
import { identityStorageKey, validIdentityReference } from "../identity.js";
import type { ConnectorPermission, ConnectaIdentityConfig, ResolvedConfig } from "../config.js";
export { msg } from "../errors.js";

export interface ServerOptions {
  /**
   * Everything createConnecta resolved from configuration: auth, identity,
   * URLs, modules, logger, and every limit with its default applied. Routes
   * read it here rather than from fields copied out of it one by one.
   */
  config: ResolvedConfig;
  /** Construction-time allowlisted snapshot, frozen by describeConfig. */
  configDescription: import("../describe-config.js").ConnectaConfigDescription;
  registry: Registry;
  /** Validated named pools served at `/mcp/<name>`; empty when none declared. */
  pools: ReadonlyMap<string, ResolvedPool>;
  /** Required sandbox backing execute_code, wrapped in fallback admission if needed. */
  executor: Executor;
  /** Sanitized identity of the configured sandbox, when it has one. */
  executorName?: string | undefined;
  /** Global FIFO boundary for all non-preflight `/mcp` requests. */
  requestAdmission: AdmissionController;
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

/** Metadata routing and challenge selection use the same first actual answer. */
export async function authMetadata(
  request: Request,
  baseUrl: string,
  auth: readonly InboundAuth[],
): Promise<{ provider: InboundAuth; response: Response } | null> {
  for (const provider of auth) {
    const response = await provider.handleMetadata?.(request, baseUrl);
    if (response) return { provider, response };
  }
  return null;
}

async function providerChallenge(
  response: Response,
  request: Request,
  baseUrl: string,
  auth: readonly InboundAuth[],
): Promise<Response> {
  if (response.status !== 401) return response;
  const path = new URL(request.url).pathname;
  const pool = /^\/mcp\/([a-z0-9_-]+)$/.exec(path)?.[1];
  const metadataRequest = new Request(new URL(
    `/.well-known/oauth-protected-resource${pool ? `/mcp/${pool}` : ""}`,
    baseUrl,
  ), { signal: request.signal });
  const owner = await authMetadata(metadataRequest, baseUrl, auth);
  if (!owner) return response;
  // Metadata is an ordinary bounded response, never retained across requests.
  await owner.response.body?.cancel();
  const challenge = owner.provider.challenge?.(request, baseUrl);
  if (!challenge) return response;
  const headers = new Headers(response.headers);
  headers.set("WWW-Authenticate", challenge);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function recognizedProvider(request: Request, auth: readonly InboundAuth[], runtimeContext?: RuntimeExecutionContext): InboundAuth | undefined {
  for (const provider of auth) {
    if (!provider.recognizesCredential) continue;
    const recognized = provider.recognizesCredential(request, runtimeContext);
    if (typeof recognized !== "boolean") {
      // A misimplemented hook may return a rejected Promise. Refuse without
      // letting its arbitrary rejection reach an unhandled-rejection sink.
      void Promise.resolve(recognized).catch(() => {});
      throw new Error("invalid credential recognition verdict");
    }
    if (recognized) return provider;
  }
  return undefined;
}

export async function authorize(
  request: Request,
  baseUrl: string,
  auth: readonly InboundAuth[],
  runtimeContext?: RuntimeExecutionContext,
  identityConfig?: ConnectaIdentityConfig,
  partitionIdentity = true,
  interactiveOnly = false,
): Promise<
  | {
      ok: true;
      actor: ActivityActor;
      identity: AuthenticatedIdentity;
      sessionCookies?: readonly string[];
      subjectKey?: string;
      principalKey?: string;
      connectorIds: "all" | readonly string[];
      /** Per-connector tool allowlist for connectors granted by address only. */
      toolAccess?: ToolAccess;
      /** Granted addresses that still require the catalog's read-only hint. */
      guardedToolAccess?: ToolAccess;
      operator: boolean;
      accessTokenManagement: boolean;
      credentialAdministration: ConnectorPermission;
      personalConnection: ConnectorPermission;
      /** Backward-compatible name used by operator views. */
      uiAdminEligible?: boolean;
    }
  | { ok: false; response: Response }
> {
  const machineCredential = isMachineCredential(request);
  if (interactiveOnly && machineCredential) {
    return { ok: false, response: privateJson({ error: "authenticated user required" }, { status: 403 }) };
  }
  if (auth.length === 0 && !interactiveOnly && !machineCredential) {
    const actor = { kind: "anonymous" } as const;
    const identity: AuthenticatedIdentity = { actor, interactive: false };
    let access: ConnectorAccess;
    try {
      access = parseConnectorAccess(
        identityConfig?.connectorAccess ? await identityConfig.connectorAccess(identity) : "all",
        { allowReadOnly: true },
      );
    } catch {
      return {
        ok: false,
        response: privateJson({ error: "identity access resolution failed" }, { status: 403 }),
      };
    }
    return { ok: true, actor, identity, ...access, operator: false, accessTokenManagement: false, credentialAdministration: "none", personalConnection: "none" };
  }
  let recognized: InboundAuth | undefined;
  try {
    recognized = recognizedProvider(request, machineCredential
      ? auth.filter(provider => provider.kind === "access_token")
      : auth, runtimeContext);
  } catch {
    return { ok: false, response: privateJson({ error: "credential recognition failed" }, { status: 403 }) };
  }
  if (machineCredential && !recognized) {
    return { ok: false, response: await providerChallenge(privateJson({ error: "unauthorized" }, {
      status: 401, headers: { "WWW-Authenticate": "Bearer" },
    }), request, baseUrl, auth) };
  }
  if (interactiveOnly && recognized && !recognized.interactiveOperator) {
    return { ok: false, response: privateJson({ error: "authenticated user required" }, { status: 403 }) };
  }
  let lastResponse: Response | null = null;
  const candidates = recognized ? [recognized] : auth.filter(provider => !interactiveOnly || provider.interactiveOperator);
  for (const provider of candidates) {
    const result = await provider.authorize(request, baseUrl, runtimeContext);
    if (result.ok) {
      if (interactiveOnly && !result.userId) {
        return { ok: false, response: privateJson({ error: "authenticated user required" }, { status: 403 }) };
      }
      const subjectId = result.subjectId ?? result.userId;
      const actorNamespace = activityActorNamespace(provider);
      const derivedPrincipal = result.userId && actorNamespace
        ? { namespace: actorNamespace, id: result.userId }
        : undefined;
      const principal = validIdentityReference(result.principal)
        ? result.principal
        : derivedPrincipal;
      const subject = subjectId
        ? { namespace: actorNamespace ?? `connecta:auth:${provider.kind}`, id: subjectId }
        : principal;
      const interactive = Boolean(result.userId && provider.interactiveOperator);
      const actor: ActivityActor = {
        kind: provider.kind,
        ...(subjectId ? { id: subjectId } : {}),
        ...(subjectId && actorNamespace ? { namespace: actorNamespace } : {}),
      };
      const identity: AuthenticatedIdentity = {
        actor,
        ...(subject ? { subject } : {}),
        ...(principal ? { principal } : {}),
        interactive,
      };
      let operator = interactive;
      let accessTokenManagement = false;
      let credentialAdministration: ConnectorPermission = "none";
      let personalConnection: ConnectorPermission = "none";
      let access: ConnectorAccess;
      try {
        if (identityConfig?.activityAccess) {
          operator = interactive && principal
            ? await identityConfig.activityAccess(principal)
            : false;
        }
        access = parseConnectorAccess(
          identityConfig?.connectorAccess ? await identityConfig.connectorAccess(identity) : "all",
          { allowReadOnly: true },
        );
        if (interactive) {
          accessTokenManagement = identityConfig?.accessTokenManagement ? await identityConfig.accessTokenManagement(identity) : false;
          if (typeof accessTokenManagement !== "boolean") throw new Error("invalid token management permission");
          credentialAdministration = identityConfig?.credentialAdministration ? await identityConfig.credentialAdministration(identity) : "none";
          personalConnection = principal && identityConfig?.personalConnection ? await identityConfig.personalConnection(identity) : "none";
        }
        if (typeof operator !== "boolean") throw new Error("invalid activity permission");
        for (const permission of [credentialAdministration, personalConnection]) {
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
        ...(result.sessionCookies?.length ? { sessionCookies: result.sessionCookies } : {}),
        ...(subject && partitionIdentity
          ? { subjectKey: await identityStorageKey(subject) }
          : {}),
        ...(principal && partitionIdentity
          ? { principalKey: await identityStorageKey(principal) }
          : {}),
        ...access,
        accessTokenManagement,
        credentialAdministration,
        personalConnection,
        operator,
        ...(operator ? { uiAdminEligible: true } : {}),
      };
    }
    lastResponse = result.response;
    if (recognized || result.response.status !== 401) break;
  }
  return {
    ok: false,
    response: await providerChallenge(lastResponse ?? privateJson({ error: "unauthorized" }, {
      status: 401, headers: { "WWW-Authenticate": "Bearer" },
    }), request, baseUrl, auth),
  };
}

/** Human routes reject machine credentials before any verification or storage I/O. */
export async function authorizeUiIdentity(
  request: Request,
  baseUrl: string,
  auth: readonly InboundAuth[],
  purpose: string,
  runtimeContext?: RuntimeExecutionContext,
  identityConfig?: ConnectaIdentityConfig,
): Promise<Awaited<ReturnType<typeof authorize>>> {
  if (!auth.some(provider => provider.interactiveOperator)) {
    return { ok: false, response: privateJson(
      { error: `${purpose} requires interactive user authentication` }, { status: 403 },
    ) };
  }
  return authorize(request, baseUrl, auth, runtimeContext, identityConfig, true, true);
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
  const headers = response.headers.get("Content-Type")?.toLowerCase().startsWith("text/html")
    ? htmlSecurityHeaders(response.headers)
    : new Headers(response.headers);
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

/**
 * Whether this identity may open artifact pages: exactly whoever may read the
 * `artifacts` connector — it is visible to them and `get_artifact` is among
 * its tools they were granted. Viewing grants nothing a program could not
 * already read (PRINCIPLES.md, INV-4).
 */
export function mayViewArtifacts(authz: AuthorizedIdentity, registry: Registry): boolean {
  if (authz.connectorIds !== "all" && !authz.connectorIds.includes("artifacts")) {
    return false;
  }
  const tools = authz.toolAccess?.get("artifacts");
  if (tools && !tools.has("get_artifact")) return false;
  if (!authz.guardedToolAccess?.get("artifacts")?.has("get_artifact")) return true;
  return registry.describeStaticTools("artifacts")?.some((tool) =>
    tool.name === "get_artifact" && tool.classification === "read") === true;
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

/** Preserve refreshed browser cookies on the redirect or completion page. */
export function withSessionCookies(response: Response, cookies?: readonly string[]): Response {
  if (!cookies?.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
