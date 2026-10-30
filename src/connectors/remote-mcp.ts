import { wrapViewCredentials } from "../runtime/call.js";
import { withStoredAuth } from "../auth/stored-observation.js";
import { authView } from "../auth/native-call.js";
import { authFlow, authCall, authInvoke, authValue, authMethod, authCatch } from "../auth/native.js";
import { viewServices, viewSignal } from "../runtime/call.js";
import { declareSelfHostedClient, type RemoteOAuthClient } from "../auth/downstream-client-metadata.js";
import { Client, isInputRequiredResult } from "@modelcontextprotocol/client";
import type { FetchLike, OAuthTokens, Transport } from "@modelcontextprotocol/client";
import { Duration, Effect, Exit, Scope } from "effect";
import { byteReadResponse } from "../byte-read-response.js";
import { redactSentSecrets, requestSentSecrets, sentSecretsFor } from "../sent-secrets.js";
import { closeCatalogCacheScope } from "../catalog-cache.js";
import { connectorScopeCleanupClaimed } from "../connector-scope.js";
import { ConnectorCallError, msg, unavailableCallError } from "../errors.js";
import { failureStatus, labelErrorClass, ownStatus } from "../operator-record.js";
import { oauthPartitionFor, retainOAuthPartition } from "../oauth-partition.js";
import { RequestScope } from "../runtime/request-scope.js";
import { registerCallEntry } from "../runtime/call-entry.js";
import { Context } from "effect";
import { registerInvocationAuth } from "../invocation-auth.js";
import { assertDownstreamOutputSafe } from "../downstream-input-context.js";
import { runEdge } from "../runtime/run.js";
import { credentialProbe } from "../runtime/credential-probe.js";
import { credentialFailureClass } from "../credential-verification.js";
import type { PrincipalForwarding, RequestToken } from "../request-token.js";
import { tagPrincipalForwarding } from "../request-principal.js";
import { describedEndpoint, describedUrl } from "../described.js";
import { callerOf } from "../connector-caller.js";
import { providerBoundary } from "../provider-call.js";
import type {
  Connector,
  ConnectorAuthDescription,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorSkill,
  ConnectorSkillResourceContents,
  ConnectorStatus,
  ConnectorUsageGuide,
  CredentialTestResult,
  Logger,
  ToolDef,
} from "../types.js";
import { downstreamCallError, hasSdkPayload, payloadFree, remoteMcpErrors } from "./remote-mcp/errors.js";
import { LOCAL_CLOSE_BUDGET_MS, REDIRECT_STATUSES, remoteMcpTransport } from "./remote-mcp/transport.js";
import { remoteMcpConfig } from "./remote-mcp/config.js";
import type { RemoteMcpRuntime } from "./remote-mcp/runtime.js";
import { remoteMcpConnection } from "./remote-mcp/connection.js";
import { remoteMcpOAuth } from "./remote-mcp/oauth.js";
import { remoteMcpCatalog } from "./remote-mcp/catalog.js";
import { remoteMcpResources } from "./remote-mcp/resources.js";
import { remoteMcpCall } from "./remote-mcp/call.js";

/**
 * A static downstream credential supplied through the connection in the
 * operator UI rather than baked into deployment source.
 *
 * The connector, its endpoint, and the credential *slot* stay declared in
 * code; only the secret arrives through the operator route, exactly as for
 * `api()`. One reserved `value` field, deliberately: a header is assembled
 * from a name, a framing scheme, and one secret, and anything that needs two
 * secrets composed into one header is a provider integration, not a proxy
 * config ([#439](https://github.com/zackbart/connecta/issues/439)).
 */
interface RemoteMcpCredentialAuth {
  type: "credential";
  /**
   * Slot description rendered in the connection in the operator UI. Defaults
   * to `{ label: "API key" }`; a maintained provider passes the name the provider
   * itself uses. Named `fields` are refused — this shape reads the reserved
   * `value` field only.
   */
  credential?: ConnectorCredentialConfig;
  /** Header the credential rides. Defaults to `Authorization`. */
  header?: string;
  /**
   * Framing token placed before the value. Defaults to `"Bearer"`. `null` (or
   * an empty string) sends the stored value verbatim, for an endpoint that
   * reads a bare key. A scheme whose last token is `Basic` declares
   * HTTP Basic credentials: the stored `user:secret` is base64-encoded first,
   * so `"Basic"` produces `Basic <base64>` and a nested
   * `"Bearer Basic"` produces `Bearer Basic <base64>`.
   */
  scheme?: string | null;
}

/**
 * Request-local Bearer auth. With `principal`, the resolver also receives the
 * caller inbound auth admitted, for a trusted first-party downstream.
 */
export type RemoteMcpRequestAuth =
  | {
      type: "request";
      /** Resolve a Bearer token inside this request. Never persisted or described. */
      token: RequestToken;
      principal?: never;
      /** Static protocol/catalog headers, never Authorization. */
      headers?: Record<string, string>;
    }
  | {
      type: "request";
      token?: never;
      /**
       * Resolve the Bearer token for the admitted caller instead. Callers the
       * policy does not accept are refused before the resolver runs.
       */
      principal: PrincipalForwarding;
      /** Static protocol/catalog headers, never Authorization. */
      headers?: Record<string, string>;
    };

export type RemoteMcpAuth =
  | RemoteMcpRequestAuth
  | { type: "headers"; headers: Record<string, string> }
  | RemoteMcpCredentialAuth
  | {
      type: "oauth";
      /** Public HTTPS client metadata document, for servers supporting URL-based client IDs. */
      clientMetadataUrl?: string;
      /** Pre-registered client, bound to its configured issuer; excludes clientMetadataUrl. */
      client?: RemoteOAuthClient;
      /** Space-separated default scopes when the resource server does not advertise them. */
      scope?: string;
      /** Non-secret browser authorization parameters; protocol fields are reserved. Changes require reconnect. */
      authorizationParams?: Record<string, string>;
    };

export type RemoteMcpRedirectPolicy = "none" | "same-origin";

export interface RemoteMcpOptions {
  url: string;
  /** Human-readable display name; the connector id remains the address prefix. */
  title?: string;
  description?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Max inline result size (bytes) for this connector's tools before
   * call_tool truncates and stashes the full text for connecta.result
   * paging. Overrides the deployment's `calls.maxResultBytes`; omit to inherit
   * it. Must be a whole number of bytes >= 1; anything else refuses to
   * construct.
   */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /**
   * Optional agent-facing usage guide served by `skills` as
   * `connector:<id>`. A string is markdown; the structured form adds bounded
   * discovery metadata. See `Connector.usageGuide`.
   */
  usageGuide?: string | ConnectorUsageGuide;
  /** Opt in to downstream Skills listing and resource reads. Defaults to false. */
  skills?: boolean;
  auth?: RemoteMcpAuth;
  /**
   * Non-secret resource context headers. Never credentials: use auth for those.
   * Auth-owned, HTTP transport/session and OAuth client-auth headers are
   * reserved. Cannot be combined with inline headers auth. Sent only at the
   * resource URL path. Values are never treated as sent secrets: arguments and
   * echoes equal to them pass unchanged.
   */
  headers?: Record<string, string>;
  /**
   * Downstream MCP version-negotiation mode. Defaults to `"auto"`, which
   * probes with `server/discover` and falls back to the legacy lifecycle when
   * the response identifies a legacy server. Set `"legacy"` only for a known
   * legacy downstream that cannot safely receive the discovery probe; that
   * path starts directly with the ordinary 2025 `initialize` handshake.
   */
  versionNegotiation?: "auto" | "legacy";
  /**
   * Downstream HTTP redirect policy. Defaults to `"none"`: every redirect is
   * rejected. `"same-origin"` follows at most five redirects while preserving
   * standard 301/302/303/307/308 method semantics. Cross-origin redirects and
   * HTTPS downgrades are always refused, so credentials never cross the
   * configured request's origin. A write is never sent to a redirect target
   * under either policy: a redirect answering a write fails it as an unknown
   * outcome (INV-9), so set `url` to the endpoint that answers directly.
   */
  redirects?: RemoteMcpRedirectPolicy;
  /**
   * Refuse to connect to a non-`https://` `url` at construction (default
   * false). Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) are always
   * allowed for local development. Off by default, static `headers` credentials
   * over a cleartext connection are warned about but permitted; set this true
   * to make that misconfiguration a hard error instead.
   */
  requireHttps?: boolean;
  /**
   * Destination for the cleartext-credential warning emitted at construction.
   * Default console.
   */
  logger?: Logger;
  /**
   * Send every MCP request through this fetch instead of the global one, such
   * as a Workers service binding: `(input, init) => env.NOTES.fetch(input, init)`.
   * `url` still names the logical origin, and the HTTPS, redirect and
   * same-origin rules apply to it. Each request, writes included, is handed
   * over once with `redirect: "manual"`; the function must not retry or follow
   * redirects. Cannot be combined with `auth: { type: "oauth" }`.
   */
  fetch?: FetchLike;
  /**
   * @internal Testing seam. When set, this transport is used instead of the
   * HTTP transport, letting tests point the connector at an in-process MCP
   * server (e.g. via InMemoryTransport). Not part of the public API.
   */
  _transportFactory?: (ctx: ConnectorContext) => Transport;
}

export const MAX_REMOTE_REDIRECT_HOPS = 5;
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
];

export class RemoteMcpRedirectError extends ConnectorCallError {
  constructor(connectorId: string, reason: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" redirect policy rejected the downstream response: ${reason}.`,
    );
    this.name = "RemoteMcpRedirectError";
  }
}
labelErrorClass(RemoteMcpRedirectError, "RemoteMcpRedirectError");

function redirectedInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const becomesGet =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  if (!becomesGet) return init;
  const headers = new Headers(init.headers);
  for (const name of BODY_HEADERS) headers.delete(name);
  const redirected = { ...init, method: "GET", headers };
  delete redirected.body;
  return redirected;
}

/**
 * Wrap fetch with explicit, bounded redirect handling.
 *
 * The starting URL of each fetch call is trusted by its caller (the configured
 * MCP endpoint, or an OAuth URL the pinned SDK discovered and
 * `learnedUrlSafeFetch` already admitted). Only Location
 * values are policy-controlled here. No rejected target is ever fetched, so
 * arbitrary static header names receive the same protection as Authorization.
 */
export function redirectSafeFetch(
  connectorId: string,
  policy: RemoteMcpRedirectPolicy = "none",
  baseFetch: FetchLike = fetch,
): FetchLike {
  return authMethod((input: string | URL, initialInit: RequestInit | undefined = {}) =>
    authFlow<Response>(function* () {
      let current = new URL(input);
      let init = initialInit;
      const seen = new Set<string>([current.href]);
      let hops = 0;
      while (true) {
        let response: Response;
        try {
          response = (yield authCall(baseFetch, [
            current,
            {
              ...init,
              redirect: "manual",
            },
          ])) as Response;
        } catch (cause) {
          if (cause instanceof ConnectorCallError) throw downstreamCallError(cause);
          throw unavailableCallError(
            cause,
            current.href,
            undefined,
            hasSdkPayload(cause) ? undefined : (init.signal ?? undefined),
          );
        }
        if (!REDIRECT_STATUSES.has(response.status)) return byteReadResponse(response);
        const location = response.headers.get("location");
        (yield authCatch(
          authValue(() => response.body?.cancel()),
          () => {},
        )) as void | undefined;
        if (!location) {
          throw new RemoteMcpRedirectError(connectorId, `HTTP ${response.status} carried no Location header`);
        }
        if (policy === "none") {
          throw new RemoteMcpRedirectError(connectorId, `HTTP ${response.status} redirects are disabled`);
        }
        if (hops >= MAX_REMOTE_REDIRECT_HOPS) {
          throw new RemoteMcpRedirectError(connectorId, `the redirect chain exceeded ${MAX_REMOTE_REDIRECT_HOPS} hops`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new RemoteMcpRedirectError(connectorId, `HTTP ${response.status} carried an invalid Location header`);
        }
        if (current.protocol === "https:" && next.protocol !== "https:") {
          throw new RemoteMcpRedirectError(connectorId, "an HTTPS-to-HTTP downgrade is not allowed");
        }
        if (next.origin !== current.origin) {
          throw new RemoteMcpRedirectError(connectorId, "a cross-origin redirect is not allowed");
        }
        if (next.username || next.password) {
          throw new RemoteMcpRedirectError(connectorId, "a redirect target containing URL credentials is not allowed");
        }
        if (seen.has(next.href)) {
          throw new RemoteMcpRedirectError(connectorId, "the redirect chain loops");
        }
        seen.add(next.href);
        hops++;
        init = redirectedInit(init, response.status);
        current = next;
      }
    }),
  );
}

/**
 * Proxy a downstream remote MCP server. SDK clients and transports are scoped
 * to one inbound request: reused by calls within a batch/execute_code run, but
 * never carried into a later Cloudflare Worker request. Static-header auth
 * passes headers via requestInit; "oauth" runs the full downstream OAuth flow
 * via KvOAuthProvider.
 *
 * Auth failures degrade the connector to "auth_required" (never crash the
 * server or hide other connectors).
 */
export function remoteMcp(id: string, opts: RemoteMcpOptions): Connector {
  // Each seam's factory contributes to one runtime, in this order; none calls
  // another seam until an operation runs, after construction completes.
  const rt = remoteMcpConfig(id, opts) as RemoteMcpRuntime;
  opts = rt.opts;
  const {
    clientMetadataUrl,
    requestAuth,
    credentialAuth,
    credentialHeader,
    credentialScheme,
    isOauth,
    authorizationParams,
    oauthScope,
    extraHeaders,
    skillsEnabled,
    credentialConfig,
    principalPolicy,
    staticClient,
  } = rt;
  Object.assign(rt, remoteMcpErrors(rt));
  Object.assign(rt, remoteMcpTransport(rt));
  Object.assign(rt, remoteMcpConnection(rt));
  Object.assign(rt, remoteMcpOAuth(rt));
  Object.assign(rt, remoteMcpCatalog(rt));
  Object.assign(rt, remoteMcpResources(rt));
  Object.assign(rt, remoteMcpCall(rt));
  const {
    listSkills,
    readSkill,
    liveListings,
    listToolsOperation,
    callToolOperation,
    readResourceOperation,
    entryFor,
    cacheOwner,
    reset,
    stateFor,
    newProvider,
    resourceTemplateRefusals,
    ensureConnected,
    granted,
    connectedProviders,
    CredentialRequiredError,
    OperatorDisconnectedError,
    UnresolvedTokenError,
    oauthSurface,
    activeContexts,
    states,
    isClosed,
    scopeEndedError,
    operatorDisconnectedError,
    authRequiredError,
    renewBeforeCall,
  } = rt;

  // Built once from construction-time values: names, framing, and public
  // URLs only. A static header's value and a stored credential never reach
  // it, and a URL keeps origin and path: a CIMD document's query may carry a
  // token even though the document itself is public.
  const describedClientMetadataUrl = describedUrl(clientMetadataUrl);
  const authDescription: ConnectorAuthDescription = requestAuth
    ? {
        mode: "request",
        header: "Authorization",
        scheme: "Bearer",
        ...(requestAuth.headers ? { headerNames: Object.keys(requestAuth.headers) } : {}),
      }
    : opts.auth?.type === "headers"
      ? { mode: "headers", headerNames: Object.keys(opts.auth.headers) }
      : credentialAuth
        ? { mode: "credential", header: credentialHeader, scheme: credentialScheme }
        : isOauth
          ? {
              mode: "oauth",
              ...(authorizationParams.length
                ? { authorizationParamNames: authorizationParams.map(([name]) => name) }
                : {}),
              ...(oauthScope !== undefined ? { scope: oauthScope } : {}),
              ...(describedClientMetadataUrl !== undefined ? { clientMetadataUrl: describedClientMetadataUrl } : {}),
            }
          : { mode: "none" };
  if (extraHeaders)
    authDescription.headerNames = [...new Set([...(authDescription.headerNames ?? []), ...Object.keys(extraHeaders)])];
  const endpoint = describedEndpoint(opts.url);

  const optionSources = Object.freeze({
    "source.kind": "default" as const,
    "auth.mode": opts.auth === undefined ? ("default" as const) : ("config" as const),
    "auth.header": credentialAuth?.header === undefined ? ("default" as const) : ("config" as const),
    "auth.scheme": credentialAuth?.scheme === undefined ? ("default" as const) : ("config" as const),
    "credential.label": credentialAuth?.credential === undefined ? ("default" as const) : ("config" as const),
    ...Object.fromEntries(
      ["versionNegotiation", "redirects", "requireHttps"].map(
        (key) =>
          [
            `transport.${key}`,
            opts[key as "versionNegotiation" | "redirects" | "requireHttps"] === undefined ? "default" : "config",
          ] as const,
      ),
    ),
  });

  const connector: Connector = {
    id,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    kind: "mcp",
    describe: () => ({
      optionSources,
      source: { kind: "remote-mcp" },
      ...(endpoint ? { endpoint } : {}),
      auth: authDescription,
      transport: {
        versionNegotiation: opts.versionNegotiation ?? "auto",
        redirects: opts.redirects ?? "none",
        requireHttps: opts.requireHttps ?? false,
      },
    }),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.authScope !== undefined ? { authScope: opts.authScope } : {}),
    ...(opts.maxResultBytes !== undefined ? { maxResultBytes: opts.maxResultBytes } : {}),
    ...(opts.callAdmission !== undefined ? { callAdmission: opts.callAdmission } : {}),
    ...(opts.usageGuide !== undefined ? { usageGuide: opts.usageGuide } : {}),
    ...(skillsEnabled
      ? {
          downstreamSkills: {
            list: listSkills,
            read: readSkill,
          },
        }
      : {}),
    // Declaring the slot is what makes the rest of the operator surface work:
    // the connection's credential form renders it, the shape check compares
    // against it, and authorize_connector returns the operator handoff rather than
    // an OAuth URL this connector has none of.
    ...(credentialAuth
      ? {
          credential: credentialConfig,
          /**
           * The honest test for a proxy is the catalog: connect with the
           * given value and count what the downstream serves. Nothing else
           * here is connecta's to verify — the credential's scope, project,
           * and mode are the provider's answer, not ours. The value may be a
           * candidate the operator has not saved: the probe's view sends it,
           * never the stored one, and nothing about it is written.
           */
          testCredential: (value: string, ctx: ConnectorContext) =>
            credentialProbe(ctx, { value }, (view) =>
              runEdge(
                authFlow<CredentialTestResult>(function* () {
                  try {
                    liveListings.add(view);
                    const tools = (yield authInvoke(connector, "listTools", [view])) as ToolDef[];
                    return {
                      ok: true,
                      message: `Connected — the downstream served ${tools.length} tool${tools.length === 1 ? "" : "s"}.`,
                    };
                  } catch (err) {
                    return { ok: false, message: msg(err), failure: credentialFailureClass(err) };
                  } finally {
                    liveListings.delete(view);
                    if (!connectorScopeCleanupClaimed(ctx, id))
                      (yield authCall<void>(connector.closeScope, [view], connector)) as void | undefined;
                  }
                }),
              ),
            ),
        }
      : {}),

    listTools: listToolsOperation,

    callTool: callToolOperation,

    readResource: readResourceOperation,

    closeScope: authMethod((ctx: ConnectorContext) =>
      authFlow<void>(function* () {
        // Revocation and all finalizers start before any caller guard. Cleanup
        // retains its own bounded settlement even after the request has closed.
        const state = entryFor(ctx);
        const release = Scope.closeUnsafe(state.scope, Exit.void);
        const cacheClosing = closeCatalogCacheScope(ctx, id, cacheOwner);
        reset(state);
        const closing = runEdge(
          Effect.all(
            [
              release ?? Effect.void,
              cacheClosing
                ? Effect.raceAllFirst([
                    Effect.promise(() => cacheClosing),
                    Effect.sleep(Duration.millis(LOCAL_CLOSE_BUDGET_MS)),
                  ])
                : Effect.void,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.asVoid),
        );
        void closing.catch(() => {});
        if (viewSignal(ctx, true).aborted) return yield authValue(() => closing);
        return yield authView<void>(
          ctx,
          authMethod(() => authValue(() => closing)),
          true,
        );
      }),
    ),

    status: authMethod((ctx: ConnectorContext) =>
      authFlow<ConnectorStatus>(function* () {
        if (principalPolicy && !callerOf(ctx)?.authenticated)
          return ownStatus({ state: "per_caller", message: "Authenticates as each caller; verified on use." });
        const state = stateFor(ctx);
        const report = authMethod((status: ConnectorStatus) =>
          authFlow<ConnectorStatus>(function* () {
            const path = isOauth
              ? ((yield authInvoke(newProvider(ctx, state), "registrationPath", [])) as
                  | "cimd"
                  | "dcr"
                  | "static"
                  | undefined)
              : undefined;
            return ownStatus({
              ...status,
              ...(path ? { registrationPath: path } : {}),
              ...(resourceTemplateRefusals.size ? { resourceTemplateRefusals: [...resourceTemplateRefusals] } : {}),
            });
          }),
        );
        try {
          const client = (yield authCall(ensureConnected, [ctx, state])) as Client;
          // The grant decides, as it does for a call: a downstream that
          // answers without credentials is not connected for this owner.
          if (isOauth && !((yield authCall(granted, [connectedProviders.get(client)!])) as boolean))
            return (yield authCall(report, [
              { state: "auth_required", message: "Authorization required \u2014 open the URL to connect." },
            ])) as ConnectorStatus;
          return (yield authCall(report, [{ state: "ok" }])) as ConnectorStatus;
        } catch (err) {
          if (err instanceof CredentialRequiredError) {
            return (yield authCall(report, [{ state: "auth_required", message: err.message }])) as ConnectorStatus;
          }
          if (err instanceof OperatorDisconnectedError) {
            return (yield authCall(report, [{ state: "auth_required", message: err.message }])) as ConnectorStatus;
          }
          if (
            state.authRequired ||
            (err instanceof ConnectorCallError &&
              err.code === "auth_required" &&
              !(err instanceof UnresolvedTokenError))
          ) {
            return (yield authCall(report, [
              {
                state: "auth_required",
                message: credentialAuth
                  ? "Authorization required \u2014 the downstream rejected this connector's stored credential."
                  : "Authorization required \u2014 open the URL to connect.",
              },
            ])) as ConnectorStatus;
          }
          return failureStatus(id, err);
        }
      }),
    ),
  };
  rt.connector = connector;

  if (isOauth) oauthSurface(connector);

  const retainOperation = <Args extends unknown[], A>(
    operation: (...args: Args) => Promise<A>,
    contextIndex: number,
  ): ((...args: Args) => Promise<A>) =>
    authMethod((...args: Args) =>
      authFlow<A>(function* () {
        const release = retainOAuthPartition(oauthPartitionFor(args[contextIndex] as ConnectorContext));
        try {
          return yield authCall<A>(operation, args);
        } finally {
          release();
        }
      }),
    );

  const withActiveSecrets = authMethod(
    <T>(ctx: ConnectorContext, run: () => Promise<T>, redactResult: boolean = true, preserveInput: boolean = false) =>
      authFlow<T>(function* () {
        wrapViewCredentials(ctx);
        const secrets = sentSecretsFor(ctx);
        if (opts.auth?.type === "headers") {
          for (const value of Object.values(opts.auth.headers)) secrets.header(value);
        }
        const state = entryFor(ctx);
        let active = activeContexts.get(state);
        if (!active) {
          active = new Set();
          activeContexts.set(state, active);
        }
        active.add(ctx);
        try {
          const result = (yield authCall(run, [])) as Awaited<T>;
          if (!preserveInput || !isInputRequiredResult(result))
            assertDownstreamOutputSafe(ctx.requestScope ?? ctx, result);
          return (preserveInput && isInputRequiredResult(result)) || !redactResult
            ? result
            : redactSentSecrets(ctx, result);
        } catch (error) {
          assertDownstreamOutputSafe(ctx.requestScope ?? ctx, error);
          throw requestSentSecrets(ctx).redact(error);
        } finally {
          active.delete(ctx);
        }
      }),
  );
  const callTool = connector.callTool;
  connector.callTool = authMethod(
    (
      name: string,
      args: unknown,
      ctx: ConnectorContext,
      options:
        | {
            definition?: ToolDef;
            input?:
              | {
                  requestState?: string;
                  inputResponses: Record<string, unknown>;
                }
              | undefined;
          }
        | undefined,
    ) =>
      authCall(withActiveSecrets, [
        ctx,
        authMethod(() => authCall(callTool, [name, args, ctx, options]) as Effect.Effect<unknown, unknown>),
        true,
        true,
      ]) as Effect.Effect<unknown, unknown>,
  );
  const listTools = connector.listTools;
  connector.listTools = authMethod(
    (ctx: ConnectorContext) =>
      authCall(withActiveSecrets, [
        ctx,
        authMethod(() => authCall(listTools, [ctx]) as Effect.Effect<ToolDef[], unknown>),
      ]) as Effect.Effect<ToolDef[], unknown>,
  );
  const readResource = connector.readResource!;
  connector.readResource = authMethod(
    (uri: string, ctx: ConnectorContext) =>
      authCall(withActiveSecrets, [
        ctx,
        authMethod(() => authCall(readResource, [uri, ctx]) as Effect.Effect<unknown, unknown>),
      ]) as Effect.Effect<unknown, unknown>,
  );
  if (connector.downstreamSkills) {
    const { list, read } = connector.downstreamSkills;
    connector.downstreamSkills.list = authMethod(
      (ctx: ConnectorContext) =>
        authCall(withActiveSecrets, [
          ctx,
          authMethod(() => authCall(list, [ctx]) as Effect.Effect<ConnectorSkill[], unknown>),
          false,
        ]) as Effect.Effect<ConnectorSkill[], unknown>,
    );
    connector.downstreamSkills.read = authMethod(
      (uri: string, ctx: ConnectorContext) =>
        authCall(withActiveSecrets, [
          ctx,
          authMethod(() => authCall(read, [uri, ctx]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>),
          false,
        ]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>,
    );
  }

  if (isOauth && !staticClient && clientMetadataUrl === undefined) declareSelfHostedClient(connector, oauthScope);
  if (isOauth) {
    const start = connector.startAuth!;
    connector.startAuth = authMethod((...args: Parameters<NonNullable<Connector["startAuth"]>>) =>
      authFlow<ConnectorStatus>(function* () {
        const status = (yield authCall(start, [...args])) as ConnectorStatus;
        const path = (yield authInvoke(newProvider(args[0], stateFor(args[0])), "registrationPath", [])) as
          | "cimd"
          | "dcr"
          | "static"
          | undefined;
        return { ...status, ...(path ? { registrationPath: path } : {}) };
      }),
    );
  }
  // Every published Promise operation owns its whole wait, including local
  // storage, digest, registration-path and result processing seams. callTool
  // settles inside its write decider; closeScope starts cleanup before racing
  // the join, and finishAuth already owns its request-scoped exchange boundary.
  const settlingOperation = <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
    contextIndex: number,
    requestOwned = false,
  ): ((...args: Args) => Promise<Result>) =>
    authMethod((...args: Args) =>
      authFlow<Result>(function* () {
        const ctx = args[contextIndex] as ConnectorContext;
        const state = states.get(Context.get(viewServices(ctx), RequestScope));
        if (state && isClosed(state)) return (yield Effect.fail(scopeEndedError())) as Awaited<Result>;
        return (yield authView(
          ctx,
          authMethod(() => authCall(operation, [...args]) as Effect.Effect<Result, unknown>),
          requestOwned,
        )) as Awaited<Result>;
      }),
    );
  connector.listTools = settlingOperation(connector.listTools, 0);
  connector.readResource = settlingOperation(connector.readResource!, 1);
  if (connector.downstreamSkills) {
    connector.downstreamSkills.list = settlingOperation(connector.downstreamSkills.list, 0);
    connector.downstreamSkills.read = settlingOperation(connector.downstreamSkills.read, 1);
  }
  const status = connector.status!;
  connector.status = authMethod(
    (ctx: ConnectorContext) =>
      authCatch(
        authView(
          ctx,
          authMethod(() => authCall(status, [ctx]) as Effect.Effect<ConnectorStatus, unknown>),
        ),
        (error: any) => failureStatus(id, error),
      ) as Effect.Effect<ConnectorStatus, unknown>,
  );
  if (connector.testCredential) connector.testCredential = settlingOperation(connector.testCredential, 1);
  if (isOauth) {
    connector.startAuth = settlingOperation(connector.startAuth!, 0);
    connector.disconnectAuth = settlingOperation(connector.disconnectAuth!, 0);
    connector.verifyState = settlingOperation(connector.verifyState!, 1, true);
    connector.verifyCallbackIssuer = settlingOperation(connector.verifyCallbackIssuer!, 1, true);
    connector.consumeAuthError = settlingOperation(connector.consumeAuthError!, 0, true);
    // Pin before the first asynchronous storage/discovery read, not only once
    // a refresh flight exists. These operations do not take call admission.
    const retain = retainOperation;
    connector.listTools = retain(connector.listTools, 0);
    connector.callTool = retain(connector.callTool, 2);
    connector.readResource = retain(connector.readResource, 1);
    if (connector.downstreamSkills) {
      connector.downstreamSkills.list = retain(connector.downstreamSkills.list, 0);
      connector.downstreamSkills.read = retain(connector.downstreamSkills.read, 1);
    }
    connector.status = retain(connector.status!, 0);
    connector.startAuth = retain(connector.startAuth!, 0);
    connector.disconnectAuth = retain(connector.disconnectAuth!, 0);
    connector.verifyState = retain(connector.verifyState!, 1);
    connector.verifyCallbackIssuer = retain(connector.verifyCallbackIssuer!, 1);
    connector.consumeAuthError = retain(connector.consumeAuthError!, 0);
    connector.finishAuth = retain(connector.finishAuth!, 1);
  }
  connector.listTools = payloadFree(connector.listTools);
  connector.callTool = payloadFree(connector.callTool);
  connector.readResource = payloadFree(connector.readResource);
  if (connector.downstreamSkills) {
    connector.downstreamSkills.list = payloadFree(connector.downstreamSkills.list);
    connector.downstreamSkills.read = payloadFree(connector.downstreamSkills.read);
  }
  if (connector.startAuth) connector.startAuth = payloadFree(connector.startAuth);
  if (connector.finishAuth) connector.finishAuth = payloadFree(connector.finishAuth);
  // This boundary's identity in a logical call: this object with its
  // published, fully wrapped function, fixed now, never what the property or
  // a copy holds by then.
  providerBoundary(connector);
  const ownCall = connector.callTool;
  registerCallEntry(connector, (name, args, ctx, options) => authCall(ownCall, [name, args, ctx, options]));
  if (isOauth)
    registerInvocationAuth(
      connector,
      retainOperation(
        settlingOperation(
          authMethod((ctx: ConnectorContext) =>
            authFlow<void>(function* () {
              const provider = newProvider(ctx, stateFor(ctx));
              if ((yield authInvoke(provider, "operatorDisconnected", [])) as boolean)
                throw operatorDisconnectedError();
              if (!((yield authInvoke(provider, "tokens", [])) as OAuthTokens | undefined))
                throw authRequiredError(ctx);
              // That read decides whether the token is about to expire.
              const due = provider.renewalDue();
              if (due !== undefined) (yield authCall(renewBeforeCall, [ctx, due])) as void;
            }),
          ),
          0,
        ),
        0,
      ),
    );
  if (isOauth) withStoredAuth(connector, (ctx) => newProvider(ctx).storedAuthorization());
  if (principalPolicy) tagPrincipalForwarding(connector);
  return connector;
}
