import { authorizationCredential, authorizationRequest, isMachineCredential } from "../inbound-credential.js";
import type { ActivityActor } from "../activity.js";
import type { DeferredWork } from "../connector-scope.js";
import { htmlSecurityHeaders } from "../html-security.js";
import type { AdmissionController } from "../executor-admission.js";
import type { Registry } from "../registry.js";
import { isMaintainer, isMember, type ResolvedPool } from "../membership.js";
import type {
  AuthenticatedIdentity,
  Executor,
  IdentityReference,
  InboundAuth,
  InboundAuthRuntimeContext,
} from "../types.js";
import { identityStorageKey, validIdentityReference } from "../identity.js";
import { assertsAgents, isAgentName } from "../agent-identity.js";
import type { ResolvedConfig } from "../config.js";
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
  configValueSources?: Readonly<Record<string, "default" | "config">>;
  registry: Registry;
  /** Resolved `maintainers`: the only principals plain `/mcp` and operator routes admit. */
  maintainers: readonly IdentityReference[];
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

export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/**
 * The body as text, or undefined once it is longer than `maxChars`. No UTF-16
 * unit costs more than three bytes, and a malformed sequence decodes to one
 * U+FFFD per at most three bytes, so a body past three bytes per character is
 * past the limit too — and reading stops there, instead of buffering whatever
 * a client cares to send before measuring it.
 */
export async function boundedText(request: Request, maxChars: number): Promise<string | undefined> {
  if (!request.body) return "";
  const maxBytes = maxChars * 3;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return text.length > maxChars ? undefined : text;
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
  const escaped = JSON.stringify(bounded).replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
  return escaped + (bounded.length < requested.length ? " (truncated)" : "");
}

const ACTIVITY_ACTOR_NAMESPACE_RE = /^[\x21-\x7e]{1,256}$/;

export function activityActorNamespace(provider: InboundAuth): string | undefined {
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
  refusingProvider?: InboundAuth,
): Promise<Response> {
  const privateHeaders = new Headers(response.headers);
  privateHeaders.set("Cache-Control", "no-store");
  response = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: privateHeaders,
  });
  if (response.status !== 401) return response;
  if (!response.headers.has("WWW-Authenticate")) {
    const headers = new Headers(response.headers);
    headers.set("WWW-Authenticate", refusingProvider?.challenge?.(request, baseUrl) ?? "Bearer");
    response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const path = new URL(request.url).pathname;
  const pool = /^\/mcp\/([a-z0-9_-]+)$/.exec(path)?.[1];
  const metadataRequest = new Request(
    new URL(`/.well-known/oauth-protected-resource${pool ? `/mcp/${pool}` : ""}`, baseUrl),
    { signal: request.signal },
  );
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

function recognizedProvider(
  request: Request,
  auth: readonly InboundAuth[],
  runtimeContext?: RuntimeExecutionContext,
): InboundAuth | undefined {
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
    }
  | { ok: false; response: Response }
> {
  const credential = authorizationCredential(request);
  const explicit = credential.kind !== "absent";
  if (credential.kind === "invalid") {
    const challenge =
      auth.find((provider) => provider.kind !== "access_token")?.challenge?.(request, baseUrl) ?? "Bearer";
    return {
      ok: false,
      response: await providerChallenge(
        privateJson(
          { error: "unauthorized" },
          {
            status: 401,
            headers: { "WWW-Authenticate": challenge },
          },
        ),
        request,
        baseUrl,
        auth,
      ),
    };
  }
  request = authorizationRequest(request);
  if (explicit && runtimeContext) runtimeContext = { waitUntil: runtimeContext.waitUntil.bind(runtimeContext) };
  const machineCredential = isMachineCredential(request);
  if (interactiveOnly && machineCredential) {
    return { ok: false, response: privateJson({ error: "authenticated user required" }, { status: 403 }) };
  }
  // Every caller of this function is a human route. Agents reach pools only at
  // `/agent/<pool>` (#837), so a `cta_` token refuses here without consulting
  // token storage, and never falls back to a cookie, session, or Access context.
  if (machineCredential) {
    return {
      ok: false,
      response: await providerChallenge(
        privateJson(
          { error: "unauthorized" },
          {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          },
        ),
        request,
        baseUrl,
        auth,
      ),
    };
  }
  if (auth.length === 0 && !interactiveOnly && !explicit) {
    const actor = { kind: "anonymous" } as const;
    const identity: AuthenticatedIdentity = { actor, interactive: false };
    return { ok: true, actor, identity };
  }
  // The built-in agent adapter answers only agent endpoints. A deployment
  // whose only provider is that adapter still refuses here, never opens.
  const humanAuth = auth.filter((provider) => !assertsAgents(provider));
  let recognized: InboundAuth | undefined;
  try {
    recognized = recognizedProvider(request, humanAuth, runtimeContext);
  } catch {
    return { ok: false, response: privateJson({ error: "credential recognition failed" }, { status: 403 }) };
  }
  if (interactiveOnly && recognized && !recognized.interactiveOperator) {
    return { ok: false, response: privateJson({ error: "authenticated user required" }, { status: 403 }) };
  }
  let lastResponse: Response | null = null;
  const eligible = humanAuth.filter(
    (provider) =>
      (!interactiveOnly || provider.interactiveOperator) &&
      (!explicit || provider.kind !== "access_token" || !provider.recognizesCredential),
  );
  // A header owns one verdict even for adapters without a recognition hook.
  const candidates = recognized ? [recognized] : explicit ? eligible.slice(0, 1) : eligible;
  for (const provider of candidates) {
    const result = await provider.authorize(request, baseUrl, runtimeContext);
    // Only the built-in access-token adapter asserts an agent, and it never
    // answers here. Any `agent` claim refuses like an unknown token.
    const agent = result.ok ? result.agent : undefined;
    if (result.ok && agent !== undefined) {
      lastResponse = privateJson(
        { error: "unauthorized" },
        {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        },
      );
      break;
    }
    if (result.ok) {
      if (interactiveOnly && !result.userId) {
        return { ok: false, response: privateJson({ error: "authenticated user required" }, { status: 403 }) };
      }
      const subjectId = result.subjectId ?? result.userId;
      const actorNamespace = activityActorNamespace(provider);
      const derivedPrincipal =
        result.userId && actorNamespace ? { namespace: actorNamespace, id: result.userId } : undefined;
      const principal = validIdentityReference(result.principal) ? result.principal : derivedPrincipal;
      const subject = subjectId
        ? { namespace: actorNamespace ?? `connecta:auth:${provider.kind}`, id: subjectId }
        : principal;
      const interactive = Boolean(result.userId && provider.interactiveOperator);
      // Principal-only API callers still need a stable typed actor for history
      // ownership. Never collapse distinct personal partitions into { kind }.
      const actorId = agent ?? subjectId ?? principal?.id;
      const recordNamespace = actorNamespace ?? (subjectId === undefined ? principal?.namespace : undefined);
      const actor: ActivityActor = {
        kind: provider.kind,
        ...(actorId ? { id: actorId } : {}),
        ...(actorId && recordNamespace ? { namespace: recordNamespace } : {}),
      };
      const identity: AuthenticatedIdentity = {
        actor,
        ...(subject ? { subject } : {}),
        ...(principal ? { principal } : {}),
        ...(agent !== undefined ? { agent } : {}),
        interactive,
      };
      return {
        ok: true,
        actor,
        identity,
        ...(result.sessionCookies?.length ? { sessionCookies: result.sessionCookies } : {}),
        ...(subject && partitionIdentity ? { subjectKey: await identityStorageKey(subject) } : {}),
        ...(principal && partitionIdentity ? { principalKey: await identityStorageKey(principal) } : {}),
      };
    }
    lastResponse = result.response;
    if (recognized || result.response.status !== 401) break;
  }
  return {
    ok: false,
    response: await providerChallenge(
      lastResponse ??
        privateJson(
          { error: "unauthorized" },
          {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          },
        ),
      request,
      baseUrl,
      auth,
      explicit ? candidates[0] : undefined,
    ),
  };
}

/** The machine-only challenge: Bearer, with no authorization server to discover. */
function agentChallenge(): { ok: false; response: Response } {
  return {
    ok: false,
    response: privateJson({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
  };
}

/**
 * Admission at an agent endpoint, `/agent/<pool>` (#837). Only the built-in
 * `cta_` adapter is consulted: Clerk and Access never run, cookies and Clerk
 * handshake parameters are stripped, and the runtime context, which carries
 * Access's `ctx.access` even on a bypassed path, is never passed. Anything but
 * an admitted declared agent gets the machine-only challenge.
 */
export async function authorizeAgent(
  request: Request,
  baseUrl: string,
  auth: readonly InboundAuth[],
): Promise<Awaited<ReturnType<typeof authorize>>> {
  const provider = auth.find(assertsAgents);
  if (!provider || !isMachineCredential(request)) return agentChallenge();
  let result: Awaited<ReturnType<InboundAuth["authorize"]>>;
  try {
    result = await provider.authorize(authorizationRequest(request), baseUrl, undefined);
  } catch {
    return agentChallenge();
  }
  if (!result.ok) {
    void result.response.body?.cancel().catch(() => {});
    return agentChallenge();
  }
  const { agent } = result;
  if (!isAgentName(agent) || result.userId !== undefined || result.principal !== undefined) return agentChallenge();
  const namespace = activityActorNamespace(provider);
  const subject = { namespace: namespace ?? `connecta:auth:${provider.kind}`, id: result.subjectId ?? agent };
  const actor: ActivityActor = { kind: provider.kind, id: agent, ...(namespace ? { namespace } : {}) };
  return {
    ok: true,
    actor,
    identity: { actor, subject, agent, interactive: false },
    subjectKey: await identityStorageKey(subject),
  };
}

/** Human routes reject machine credentials before any verification or storage I/O. */
export async function authorizeUiIdentity(
  request: Request,
  baseUrl: string,
  auth: readonly InboundAuth[],
  purpose: string,
  runtimeContext?: RuntimeExecutionContext,
): Promise<Awaited<ReturnType<typeof authorize>>> {
  if (!auth.some((provider) => provider.interactiveOperator)) {
    return {
      ok: false,
      response: privateJson({ error: `${purpose} requires interactive user authentication` }, { status: 403 }),
    };
  }
  return authorize(request, baseUrl, auth, runtimeContext, true, true);
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

export function withSecurityHeaders(response: Response, requestUrl: URL, _path: string): Response {
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

/**
 * Plain `/mcp` and every operator route admit a maintainer (#837). An open
 * deployment has no inbound auth and so no maintainers: its one anonymous
 * caller keeps the whole default endpoint, as the startup warning says.
 */
export function admitsMaintainer(opts: ServerOptions, authz: AuthorizedIdentity): boolean {
  return opts.config.auth.length === 0 || isMaintainer(opts.maintainers, authz.identity);
}

/**
 * The declared pool `/mcp/<name>` serves to this person, or undefined for the
 * same 404. An agent is never admitted here, even when listed (#837).
 */
export function memberPool(
  opts: ServerOptions,
  name: string,
  identity: Readonly<AuthenticatedIdentity>,
): ResolvedPool | undefined {
  if (identity.agent !== undefined) return undefined;
  const pool = opts.pools.get(name);
  return pool?.members.some((member) => isMember(member, identity)) ? pool : undefined;
}

/** The declared pool `/agent/<name>` serves to this agent, or undefined for the same 404. */
export function agentPool(
  opts: ServerOptions,
  name: string,
  identity: Readonly<AuthenticatedIdentity>,
): ResolvedPool | undefined {
  if (identity.agent === undefined) return undefined;
  const pool = opts.pools.get(name);
  return pool?.members.some((member) => member.kind === "agent" && isMember(member, identity)) ? pool : undefined;
}

/**
 * The connectors of every pool this identity is a member of (#837): what a
 * pool member may ever manage, and only their personal ones among these.
 */
export function memberConnectors(
  opts: ServerOptions,
  identity: Readonly<AuthenticatedIdentity>,
): "all" | ReadonlySet<string> {
  const ids = new Set<string>();
  for (const name of opts.pools.keys()) {
    const pool = memberPool(opts, name, identity);
    if (!pool) continue;
    if (pool.access.connectorIds === "all") return "all";
    for (const id of pool.access.connectorIds) ids.add(id);
  }
  return ids;
}

/**
 * Whether this identity may start, finish, or remove a connector's auth
 * (#837). Only an interactive person ever may; an agent or any other machine
 * credential manages nothing. Shared auth is deployment-wide, so it takes a
 * maintainer. A personal connector takes a stable principal that is a
 * maintainer, whose plain `/mcp` includes it, or a member of a pool that
 * contains it; either way it is always the caller's own partition, which
 * callers bind by principal. Every path that issues a link, starts,
 * completes, or disconnects auth, or writes a credential, asks this.
 */
export function mayManageConnector(
  opts: ServerOptions,
  authz: AuthorizedIdentity,
  connector: { id: string; authScope?: "shared" | "personal" },
): boolean {
  const identity = authz.identity;
  if (!identity.interactive || identity.agent !== undefined || !identity.principal) return false;
  if (isMaintainer(opts.maintainers, identity)) return true;
  if (connector.authScope !== "personal") return false;
  const pools = memberConnectors(opts, identity);
  return pools === "all" || pools.has(connector.id);
}

/** Agent token list, issue, rotate, and revoke: an interactive maintainer only (#837). */
export function managesAgentTokens(opts: ServerOptions, authz: AuthorizedIdentity): boolean {
  return (
    authz.identity.interactive && authz.identity.agent === undefined && isMaintainer(opts.maintainers, authz.identity)
  );
}

/**
 * Activity reads: a maintainer principal, interactive or not (#837). Members
 * and agents read none, and an open deployment has no maintainer.
 */
export function readsActivity(opts: ServerOptions, authz: AuthorizedIdentity): boolean {
  return isMaintainer(opts.maintainers, authz.identity);
}

/** Preserve refreshed browser cookies on the redirect or completion page. */
export function withSessionCookies(response: Response, cookies?: readonly string[]): Response {
  if (!cookies?.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
