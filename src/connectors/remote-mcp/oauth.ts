// The downstream OAuth surface: bounded SDK flows, early renewal before a
// call, unchallenged consent starts, and the connector's auth operations.
import { authView } from "../../auth/native-call.js";
import { authFlow, authCall, authInvoke, authMethod } from "../../auth/native.js";
import { viewSignal } from "../../runtime/call.js";
import {
  Client,
  OAuthError,
  RegistrationRejectedError,
  extractWWWAuthenticateParams,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { FetchLike, Transport } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { authorizingContext, EarlyRenewals, KvOAuthProvider } from "../../auth/downstream-oauth.js";
import { byteReadResponse } from "../../byte-read-response.js";
import { requestSentSecrets, sentSecretsFor } from "../../sent-secrets.js";
import { ConnectorCallError, resendAdvice, WithheldTextError } from "../../errors.js";
import { attachFailureFacts, carryFailureFacts, OAUTH_ERROR_CODES } from "../../operator-record.js";
import { detach } from "../../runtime/run.js";
import { retryAfterMs } from "../../http-policy.js";
import { sendCredentialPost } from "../../guarded-transport.js";
import type { Connector, ConnectorContext, ConnectorStatus } from "../../types.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";
import {
  UnboundOAuthFlowsError,
  downstreamCallError,
  errorKind,
  hasSdkPayload,
  ownAbortReason,
  requiresAuthorization,
  startMessage,
  withheldAs,
} from "./errors.js";
import { RemoteMcpDestinationError, learnedUrlSafeFetch } from "./transport.js";
import type { ConnectionState } from "./connection.js";

/** An OAuth step, named by the shape the pinned SDK gives its request. */
export type OAuthStep = "discovery" | "client registration" | "token request";

/**
 * Where one OAuth flow last went, kept so that a failure whose text is
 * withheld still says which step failed and against which host. Origins
 * only, as `details.host` carries them. One per flow, never shared.
 */
interface OAuthTrail {
  /** The flow's latest request, if it was not to the MCP endpoint. */
  last?: { step: OAuthStep; host: string; httpStatus?: number; retryAfterMs?: number } | undefined;
  /** The origin a client registration was last sent to. */
  registration?: string;
}

/**
 * Record each OAuth request on `trail` before sending it. Pinned against
 * `@modelcontextprotocol/client` 2.3.1: every request the SDK sends anywhere
 * but the MCP endpoint is a discovery GET, a token request (a form carrying
 * `grant_type`), or the JSON POST of dynamic client registration.
 */
function tracedOAuthFetch(trail: OAuthTrail, endpoint: URL, baseFetch: FetchLike): FetchLike {
  return authMethod((input: string | URL, init: RequestInit | undefined) =>
    authFlow<Response>(function* () {
      const url = new URL(input);
      if (url.href === endpoint.href) {
        trail.last = undefined;
      } else {
        const body = init?.body;
        const step: OAuthStep =
          (init?.method ?? "GET").toUpperCase() === "GET"
            ? "discovery"
            : body instanceof URLSearchParams ||
                (typeof body === "string" && new URLSearchParams(body).has("grant_type"))
              ? "token request"
              : "client registration";
        trail.last = { step, host: url.origin };
        if (step === "client registration") trail.registration = url.origin;
      }
      const leg = trail.last;
      const response = (yield authCall(baseFetch, [input, init])) as Response;
      if (leg) {
        leg.httpStatus = response.status;
        const wait = retryAfterMs(response.headers);
        if (wait !== undefined) leg.retryAfterMs = wait;
      }
      return byteReadResponse(response);
    }),
  );
}

function registrationErrorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: unknown } | null)?.error;
    return typeof code === "string" && OAUTH_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** One connector's OAuth flows, renewals and authorization operations. */
export function remoteMcpOAuth(
  rt: RemoteMcpRuntime,
): Pick<RemoteMcpShared, "boundOAuthFlows" | "renewBeforeDispatch" | "granted" | "oauthSurface" | "renewBeforeCall"> {
  const { destination, staticClient, id, opts } = rt;
  // A connection opened earlier in the request may still hold a replaced
  // token, and one that lives under a minute is due again at once: the
  // invocation's check renews it, and `callTool` sends it while it is unexpired.
  const earlyRenewed = new EarlyRenewals();

  /**
   * Tell a failure of one OAuth flow in connecta's words.
   *
   * The SDK builds these errors from what a downstream or its authorization
   * server sent: a refused registration quotes the response body whole, an
   * issuer mismatch quotes the issuers, a discovery failure the URL or the
   * metadata it could not accept. Any of them can echo what the request
   * carried, or text the server planted for an agent to read. What survives
   * is the step and host of the flow's last request, the classification, and
   * for a registration the status and a registered OAuth error code.
   * Anything not already in connecta's words is withheld, including a store's
   * error while the flow saves what it discovered, which can quote it.
   */
  const withoutAuthorizationServerText = authMethod(
    (ctx: ConnectorContext, err: unknown, trail: OAuthTrail, signals: readonly (AbortSignal | undefined)[]) =>
      authFlow<unknown>(function* () {
        const safeOrigin = authMethod((host: string | undefined) =>
          authFlow<string | undefined>(function* () {
            if (!host || sentSecretsFor(ctx).contains(host, true)) return undefined;
            if (host === destination.origin || (staticClient && host === new URL(staticClient.issuer).origin))
              return host;
            try {
              return host ===
                ((yield authInvoke(rt.newProvider(ctx), "validatedIssuerOrigin", [])) as string | undefined)
                ? host
                : undefined;
            } catch {
              return undefined;
            }
          }),
        );
        if (ownAbortReason(err, signals) && !hasSdkPayload(err)) return err;
        if (err instanceof RegistrationRejectedError) {
          const code = registrationErrorCode(err.body);
          const origin = (yield authCall(safeOrigin, [trail.registration])) as string | undefined;
          const facts = {
            step: "OAuth client registration" as const,
            ...(origin ? { origin } : {}),
            httpStatus: err.status,
            ...(code ? { oauthError: code } : {}),
          };
          return attachFailureFacts(
            carryFailureFacts(
              err,
              resendAdvice(
                withheldAs(
                  `Connector "${id}" could not register an OAuth client with ` +
                    `${origin ?? "its authorization server"}: the ` +
                    `registration endpoint answered HTTP ${err.status}` +
                    `${code ? ` with OAuth error ${code}` : ""}. Its response is ` +
                    "withheld because it can quote the request or anything the server " +
                    "chose to add. Check the server's client registration policy.",
                  downstreamCallError(err, undefined, trail.last?.retryAfterMs),
                ),
                ", then retry authorization",
              ),
            ),
            facts,
          );
        }
        const leg = trail.last;
        const origin = (yield authCall(safeOrigin, [leg?.host])) as string | undefined;
        const facts = leg
          ? {
              step: `OAuth ${leg.step}` as const,
              ...(origin ? { origin } : {}),
              ...(leg.httpStatus ? { httpStatus: leg.httpStatus } : {}),
            }
          : { step: "OAuth flow" as const };
        if (err instanceof UnauthorizedError || err instanceof ConnectorCallError || err instanceof WithheldTextError) {
          return attachFailureFacts(downstreamCallError(err), facts);
        }
        const classified = downstreamCallError(err, leg?.httpStatus, leg?.retryAfterMs, leg?.step);
        if (
          err instanceof OAuthError ||
          (classified instanceof ConnectorCallError && classified.code === "provider_permission_denied")
        ) {
          return attachFailureFacts(carryFailureFacts(err, classified), facts);
        }
        return attachFailureFacts(
          carryFailureFacts(
            err,
            resendAdvice(
              withheldAs(
                `Connector "${id}" OAuth ${leg ? `${leg.step}${origin ? ` with ${origin}` : ""}` : "flow"} ` +
                  `failed${errorKind(err)}. The error is withheld because its text can ` +
                  "quote what the server sent. Check the server's OAuth metadata.",
                classified,
              ),
              ", then retry authorization",
            ),
          ),
          facts,
        );
      }),
  );

  /**
   * Run every OAuth flow the SDK starts on `transport` inside a boundary of
   * its own: a trail only that flow's requests write to, and
   * `withoutAuthorizationServerText` on whatever the flow throws. Calls on
   * one client can each start a flow at once, so no flow's failure is ever
   * told by another flow's last request.
   *
   * Pinned against `@modelcontextprotocol/client` 2.3.1, whose transport
   * offers no public seam for this. A flow starts in exactly two places, each
   * handing `auth()` the fetch to use: the adapted provider's
   * `onUnauthorized` (a 401, at connect or on a live client), given the fetch
   * in its context, and `_stepUpAuthorize` (a 403 `insufficient_scope`),
   * which reads `this._fetchWithInit`. The callback's code exchange runs
   * outside both, and the callback route repeats nothing it throws. If an
   * upgrade moves either seam, this refuses to build the transport rather
   * than run flows unbounded.
   */
  const boundOAuthFlows = (
    ctx: ConnectorContext,
    transport: StreamableHTTPClientTransport,
    endpoint: URL,
    /** The request's and connection's signals: only their reasons pass as written. */
    signals: readonly (AbortSignal | undefined)[],
    renewalSignal: (response: Response) => AbortSignal | undefined,
  ): void => {
    type FlowContext = { response: Response; fetchFn?: FetchLike } & Record<string, unknown>;
    const internals = transport as unknown as {
      _authProvider?: { onUnauthorized?: (ctx: FlowContext) => Promise<void> };
      _stepUpAuthorize?: (challenge: unknown, retries: number) => Promise<unknown>;
      _fetchWithInit?: FetchLike;
    };
    const adapted = internals._authProvider;
    const onUnauthorized = adapted?.onUnauthorized;
    const stepUp = internals._stepUpAuthorize;
    if (!adapted || typeof onUnauthorized !== "function" || typeof stepUp !== "function") {
      // Its own class, so that a status record, which carries no message, says so.
      throw new UnboundOAuthFlowsError(
        `[connecta] connector "${id}": the MCP client's transport no longer ` +
          "has the OAuth flow seams this release is pinned against, so its " +
          "flows cannot be bounded. Pin @modelcontextprotocol/client to the " +
          "version this release ships with.",
      );
    }
    const flow = authMethod(
      <T>(start: (trace: (fetchFn: FetchLike) => FetchLike) => Promise<T>, signal?: AbortSignal) =>
        authFlow<T>(function* () {
          const trail: OAuthTrail = {};
          try {
            return (yield authCall(start, [
              (fetchFn: FetchLike) =>
                tracedOAuthFetch(
                  trail,
                  endpoint,
                  authMethod((input: string | URL, init: RequestInit | undefined) =>
                    authFlow<Response>(function* () {
                      rt.trackSentRequest(ctx, input, init);
                      return (yield authCall(fetchFn, [
                        input,
                        signal
                          ? {
                              ...init,
                              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                            }
                          : init,
                      ])) as Response;
                    }),
                  ),
                ),
            ])) as Awaited<T>;
          } catch (err) {
            throw (yield authCall(withoutAuthorizationServerText, [ctx, err, trail, [...signals, signal]])) as unknown;
          }
        }),
    );
    adapted.onUnauthorized = authMethod(
      (ctx: FlowContext) =>
        authCall(flow, [
          authMethod((trace: (fetchFn: FetchLike) => FetchLike) =>
            authFlow<void>(function* () {
              // This seam receives every 401, during status, starts, and live
              // calls. Use the SDK's parser so the check covers exactly the
              // challenged URL it would honor. The provider separately drops
              // foreign cached resource metadata on every SDK discovery read,
              // including callbacks and flows without a challenge.
              const { resourceMetadataUrl } = extractWWWAuthenticateParams(ctx.response);
              if (resourceMetadataUrl && resourceMetadataUrl.origin !== destination.origin) {
                throw new RemoteMcpDestinationError(
                  id,
                  "resource metadata outside the configured resource origin is not allowed",
                );
              }
              yield authInvoke(Reflect, "apply", [
                onUnauthorized,
                adapted,
                [{ ...ctx, fetchFn: trace(ctx.fetchFn ?? fetch) }],
              ]);
            }),
          ),
          renewalSignal(ctx.response),
        ]) as Effect.Effect<void, unknown>,
    );
    internals._stepUpAuthorize = authMethod(
      (challenge: unknown, retries: number) =>
        authCall(flow, [
          authMethod((trace: (fetchFn: FetchLike) => FetchLike) =>
            authFlow<unknown>(function* () {
              const traced = trace(internals._fetchWithInit ?? fetch);
              const self = new Proxy(transport, {
                get: (target: StreamableHTTPClientTransport, key: string | symbol) =>
                  key === "_fetchWithInit" ? traced : Reflect.get(target, key, target),
                set: (target: StreamableHTTPClientTransport, key: string | symbol, value: any) =>
                  Reflect.set(target, key, value, target),
              });
              return (yield authInvoke(Reflect, "apply", [stepUp, self, [challenge, retries]])) as unknown;
            }),
          ),
        ]) as Effect.Effect<unknown, unknown>,
    );
  };

  const disconnectAuthorization = authMethod(
    (
      ctx: ConnectorContext,
      state: ConnectionState,
      operatorDisconnected: boolean = false,
      preserveClient: boolean = false,
    ) =>
      authFlow<void>(function* () {
        const provider = rt.newProvider(ctx, state);
        const reset = operatorDisconnected
          ? authInvoke<void>(provider, "disconnectAuthorization", [
              learnedUrlSafeFetch(
                id,
                new URL(opts.url),
                authMethod((input: string | URL, init: RequestInit | undefined) =>
                  authFlow<Response>(function* () {
                    rt.trackSentRequest(ctx, input, init);
                    return (yield authCall(sendCredentialPost, [input, init ?? {}])) as Response;
                  }),
                ),
              ),
            ])
          : authInvoke<void>(provider, "resetAuthorization", [false, preserveClient]);
        try {
          yield reset;
        } finally {
          rt.closeHalf(state);
        }
      }),
  );

  /**
   * Whether the owner's grant holds tokens, read the way the invocation gate
   * reads it. A downstream may answer its handshake and listing without
   * credentials, so a healthy connection proves nothing about the grant.
   * Read after connecting: connect has bound the epoch, migrated an older
   * layout, and refused a disconnected one within the scope's lifetime.
   */
  const granted = authMethod((provider: KvOAuthProvider) =>
    authFlow<boolean>(function* () {
      return Boolean(yield authInvoke(provider, "tokens", []));
    }),
  );

  /**
   * Renew `due`, an access token within a minute of its stored expiry,
   * through `transport`'s bound 401 flow and the shared refresh coordinator.
   * Nothing is sent to the MCP endpoint. Only calls come here: status,
   * listing and discovery never renew (INV-10).
   */
  const renewEarly = authMethod((ctx: ConnectorContext, transport: Transport, provider: KvOAuthProvider, due: string) =>
    authFlow<void>(function* () {
      const renew = rt.earlyRenewals.get(transport);
      if (!renew) return;
      try {
        (yield authCall(renew, [due, ctx.signal])) as void;
        const fresh = provider.adoptedRefresh();
        if (fresh !== undefined)
          earlyRenewed.record(ctx.requestScope ?? ctx, due, fresh, provider.observedExpiry(fresh));
      } catch (err) {
        if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
        throw err instanceof UnauthorizedError
          ? carryFailureFacts(err, rt.authRequiredError(ctx))
          : downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
      }
    }),
  );

  /**
   * The invocation's renewal, before it enters `callTool`: a failure there is
   * the call's authorization verdict with nothing sent, so a write never
   * draws the 401 it could not be repeated after (INV-9). The transport is
   * built for its flow and never started, so it holds nothing to close.
   */
  const renewBeforeCall = authMethod((ctx: ConnectorContext, due: string) =>
    authFlow<void>(function* () {
      if (opts._transportFactory) return;
      const provider = rt.newProvider(ctx);
      (yield authInvoke(provider, "beginFlow", [])) as string;
      (yield authCall(renewEarly, [ctx, rt.buildTransport(ctx, provider), provider, due])) as void;
    }),
  );

  /**
   * A connection reused later in the request renews again once its token
   * comes due, before `callTool` sends it. The grant's last read decides
   * (`KvOAuthProvider.renewalDue`, memory only).
   */
  const renewBeforeDispatch = authMethod((ctx: ConnectorContext, state: ConnectionState, client: Client) =>
    authFlow<void>(function* () {
      const provider = rt.connectedProviders.get(client);
      const due = provider?.renewalDue();
      if (due === undefined || !provider || !client.transport) return;
      if (earlyRenewed.settled(ctx.requestScope ?? ctx, due)) return;
      try {
        (yield authCall(renewEarly, [ctx, client.transport, provider, due])) as void;
      } catch (err) {
        if (requiresAuthorization(err) && state.client === client) state.authRequired = true;
        throw err;
      }
    }),
  );

  /**
   * Start consent for a downstream that answered without challenging. The
   * transport's bound 401 seam runs the SDK flow exactly as a challenge
   * without `resource_metadata` would: RFC 9728 discovery at the resource's
   * well-known URLs, the same issuer and resource checks, consent state, and
   * CIMD/DCR/static client order. Nothing is sent to the MCP endpoint.
   */
  const startUnchallenged = authMethod((ctx: ConnectorContext, connectedProvider: KvOAuthProvider) =>
    authFlow<ConnectorStatus>(function* () {
      const required = {
        state: "auth_required",
        message: "Authorization required \u2014 open the URL to connect.",
      } as const;
      // A test transport carries no OAuth flow to start.
      if (opts._transportFactory) return required;
      // A cached connection may belong to a passive status or call. Give this
      // explicit start its own authorization-capable provider without widening
      // the transport's authority or adopting a Restart's replacement epoch.
      const epoch = (yield authInvoke(connectedProvider, "flowEpoch", [])) as string;
      const provider = rt.newProvider(ctx);
      (yield authInvoke(provider, "beginFlow", [epoch])) as string;
      // Never started, this transport holds no session or stream to close.
      const transport = rt.buildTransport(ctx, provider) as StreamableHTTPClientTransport;
      const internals = transport as unknown as {
        _authProvider: {
          onUnauthorized: (flow: { response: Response; serverUrl: URL; fetchFn: FetchLike }) => Promise<void>;
        };
        _fetchWithInit: FetchLike;
      };
      try {
        (yield authInvoke(internals._authProvider, "onUnauthorized", [
          {
            response: new Response(null, { status: 401 }),
            serverUrl: new URL(opts.url),
            fetchFn: internals._fetchWithInit,
          },
        ])) as void;
        // Authorized without consent: nothing is pending to hand back.
        return { state: "ok", message: "Already authorized \u2014 connection is healthy." };
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
      }
      const authorizationUrl = (yield authInvoke(provider, "consentUrl", [viewSignal(ctx, true)])) as
        | string
        | undefined;
      return { ...required, ...(authorizationUrl !== undefined ? { authorizationUrl } : {}) };
    }),
  );

  const oauthSurface = (connector: Connector): void => {
    connector.finishAuth = authMethod(
      (code: string, ctx: ConnectorContext, callbackParams: URLSearchParams) =>
        authView(
          ctx,
          authMethod((signal: AbortSignal) =>
            authFlow<void>(function* () {
              const state = rt.stateFor(ctx);
              const provider = rt.newProvider(ctx, state);
              const consent = callbackParams?.get("state") ?? null;
              if (!consent || !((yield authInvoke(provider, "verifyCallbackState", [consent])) as boolean)) {
                throw new ConnectorCallError(
                  "connector_call_failed",
                  `Connector "${id}" authorization callback matches no pending consent; nothing was exchanged.`,
                );
              }
              provider.validateCallbackIssuer(callbackParams?.get("iss") ?? null);
              (yield authInvoke(provider, "bindFlow", [])) as void;
              signal.throwIfAborted();
              const t = rt.buildTransport(ctx, provider, null, signal, null, true) as StreamableHTTPClientTransport;
              const trail: OAuthTrail = {};
              const internals = t as unknown as {
                _fetchWithInit?: FetchLike;
              };
              const traced = tracedOAuthFetch(trail, new URL(opts.url), internals._fetchWithInit ?? fetch);
              const exchange = new Proxy(t, {
                get: (target: StreamableHTTPClientTransport, key: string | symbol) =>
                  key === "_fetchWithInit" ? traced : Reflect.get(target, key, target),
                set: (target: StreamableHTTPClientTransport, key: string | symbol, value: any) =>
                  Reflect.set(target, key, value, target),
              });
              try {
                (yield authInvoke(exchange, "finishAuth", [callbackParams])) as void;
                rt.closeHalf(state);
              } catch (err) {
                throw (yield authCall(withoutAuthorizationServerText, [
                  ctx,
                  err,
                  trail,
                  [signal, ctx.signal],
                ])) as unknown;
              } finally {
                detach(rt.closeConnection(null, t, ctx.logger));
              }
            }),
          ),
          true,
        ) as Effect.Effect<void, unknown>,
    );

    connector.verifyState = authMethod((oauthState: string | null, ctx: ConnectorContext) =>
      authFlow<boolean>(function* () {
        const state = rt.stateFor(ctx);
        return (yield authInvoke(rt.newProvider(ctx, state), "verifyState", [oauthState])) as boolean;
      }),
    );

    connector.verifyCallbackIssuer = authMethod((issuer: string | null, ctx: ConnectorContext) =>
      Effect.try({
        try: () => {
          rt.newProvider(ctx, rt.stateFor(ctx)).validateCallbackIssuer(issuer);
          return true as const;
        },
        catch: (error) => error,
      }),
    );

    connector.consumeAuthError = authMethod((ctx: ConnectorContext) =>
      authFlow<void>(function* () {
        (yield authInvoke(rt.newProvider(ctx, rt.stateFor(ctx)), "consumeAuthError", [])) as void;
      }),
    );

    connector.disconnectAuth = authMethod((ctx: ConnectorContext) =>
      authFlow<void>(function* () {
        (yield authCall(disconnectAuthorization, [ctx, rt.stateFor(ctx), true])) as void;
      }),
    );

    connector.startAuth = authMethod(
      (
        ctx: ConnectorContext,
        startOpts:
          | {
              force?: boolean;
            }
          | undefined,
      ) =>
        authFlow<ConnectorStatus>(function* () {
          ctx = authorizingContext(ctx);
          const state = rt.stateFor(ctx);
          state.provider = null;
          const p = rt.newProvider(ctx, state);
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          const disconnected = startOpts?.force
            ? false
            : ((yield authInvoke(p, "operatorDisconnected", [])) as boolean);
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          if (startOpts?.force || disconnected) {
            (yield authCall(disconnectAuthorization, [ctx, state, false, startOpts?.force === true])) as void;
          } else {
            const pending = (yield authInvoke(p, "reusablePendingAuthorizationUrl", [])) as string | undefined;
            if (pending) {
              return {
                state: "auth_required",
                authorizationUrl: pending,
                authorizationReused: true,
                message: "Authorization required \u2014 open the URL to connect.",
              };
            }
          }
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          try {
            // A passive call's refusal stays latched for status and calls. A
            // successful connection with no tokens still permits explicit
            // consent, bound to that connection rather than the live grant.
            if (state.authRequired && state.client) {
              const provider = rt.connectedProviders.get(state.client)!;
              if (!((yield authCall(granted, [provider])) as boolean))
                return (yield authCall(startUnchallenged, [ctx, provider])) as ConnectorStatus;
            }
            // The handshake runs first, so a 401 challenge's
            // `resource_metadata` starts consent as it always has.
            const client = (yield authCall(rt.ensureConnected, [ctx, state])) as Client;
            const provider = rt.connectedProviders.get(client)!;
            if (!((yield authCall(granted, [provider])) as boolean))
              return (yield authCall(startUnchallenged, [ctx, provider])) as ConnectorStatus;
            return {
              state: "ok",
              message: "Already authorized \u2014 connection is healthy.",
            };
          } catch (err) {
            if (state.authRequired && requiresAuthorization(err)) {
              let authorizationUrl: string | undefined;
              try {
                authorizationUrl = (yield state.attemptProvider
                  ? authInvoke<string | undefined>(state.attemptProvider, "consentUrl", [viewSignal(ctx, true)])
                  : Effect.succeed(undefined)) as string | undefined;
              } catch (readErr) {
                return { state: "error", message: startMessage(readErr) };
              }
              return {
                state: "auth_required",
                ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
                message: "Authorization required \u2014 open the URL to connect.",
              };
            }
            return { state: "error", message: startMessage(err) };
          }
        }),
    );
  };
  return { boundOAuthFlows, renewBeforeDispatch, granted, oauthSurface, renewBeforeCall };
}
