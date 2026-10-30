// The transport each connect builds, and write-once dispatch: every write's
// call reaches the wire at most once (INV-1, INV-9), and session close is bounded.
import { authView } from "../../auth/native-call.js";
import { authFlow, authCall, authInvoke, authValue, authMethod, authCatch } from "../../auth/native.js";
import { isOAuthCredentialRequest } from "../../auth/oauth-token-response.js";
import { deriveContext } from "../../derived-context.js";
import { operationContext, viewServices, viewSignal } from "../../runtime/call.js";
import { trackRemoteClientRequest } from "../../auth/downstream-client-metadata.js";
import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FetchLike, JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { Deferred, Duration, Effect, Exit } from "effect";
import {
  codeExchangeResponse,
  earlyRenewalFetch,
  KvOAuthProvider,
  OAuthRequestNotSentError,
} from "../../auth/downstream-oauth.js";
import { byteReadResponse } from "../../byte-read-response.js";
import { sentSecretsFor } from "../../sent-secrets.js";
import { MAX_SERIALIZED_CATALOG_BYTES } from "../../catalog-limits.js";
import { ConnectorCallError } from "../../errors.js";
import { attachFailureFacts, failureRecord, labelErrorClass, logFailure } from "../../operator-record.js";
import { learnedUrlRefusal } from "../../url-safety.js";
import { RequestScope } from "../../runtime/request-scope.js";
import { Context } from "effect";
import { downstreamWriteContinuation } from "../../downstream-input-context.js";
import type { RequestPrincipal } from "../../request-token.js";
import { guardedTransport, sendGuarded, sendCredentialPost } from "../../guarded-transport.js";
import {
  dispatchProviderRequest,
  recordProviderResponse,
  providerRequest,
  renewedAfterUnauthorized,
  type ProviderRequest,
} from "../../provider-call.js";
import { recordRequestField } from "../../provider-call-facts.js";
import type { ConnectorContext, Logger } from "../../types.js";
import { AUTH_OR_THROTTLE, errorBodyText, jsonRpcErrorBody, keepsModernVerdict, promised } from "./errors.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";
import type { ConnectionState } from "./connection.js";
import { MAX_SKILL_READ_RPC_BYTES, boundedSkillResponse, skillObject } from "./resources.js";
// The redirect guard keeps its published path; nothing here reads it while
// modules load, so this import cycle with the entry is inert.
import { redirectSafeFetch } from "../remote-mcp.js";

/**
 * How long a downstream gets to answer the session-termination DELETE before
 * teardown stops waiting. This is a network round-trip budget, deliberately
 * independent of the core's 100 ms caller-facing scope-close window: an
 * already-established cross-internet connection avoids setup, but 50 ms is
 * still too short for an ordinary round trip plus modest provider scheduling.
 * The bounded tail is deferred on runtimes that can keep it alive after the
 * response, while callers continue to wait at most 100 ms.
 */
const TERMINATE_SESSION_BUDGET_MS = 1_000;

/**
 * How long the local close gets after the DELETE: the second of the two
 * seconds the core's deferred scope-close tail allows (see
 * `src/runtime/connector-scope.ts`). The SDK's own transports close at once;
 * this bounds one that never does.
 */
export const LOCAL_CLOSE_BUDGET_MS = 1_000;

/**
 * End the downstream's session before the connection is torn down.
 *
 * `Client.close()` only unwinds our side — it aborts the transport's controller
 * and fires `onclose`. Spec session termination is a separate DELETE carrying
 * `Mcp-Session-Id`, and without it a stateful provider keeps the session alive
 * until its own (often hour-long) timeout, accumulating abandoned sessions.
 *
 * Ordering is load-bearing: the SDK sends that DELETE on the transport's
 * AbortSignal, so calling this *after* close would abort the request on issue
 * and silently do nothing. Everything else is best-effort — a transport with no
 * `terminateSession` (a custom one, or an older SDK), a downstream that refuses
 * (405 is a legal answer), errors, or never replies all fall through to the
 * close with the session left to age out as it did before.
 */
function terminateSession(transport: Transport, logger: Logger, connectorId: string): Effect.Effect<void> {
  // SDK v2's Client.close() does not send the legacy session DELETE on our
  // behalf. Connecta's own endpoint creates no protocol session, but a stateful
  // legacy downstream can still issue `Mcp-Session-Id`, and every path that
  // abandons one — scope teardown, credential rotation, OAuth retirement, an
  // abandoned connect — owes it this best-effort, one-second DELETE.
  const terminate = (transport as Transport & { terminateSession?: () => Promise<void> }).terminateSession;
  if (typeof terminate !== "function") return Effect.void;
  const warn = (log: () => void) =>
    Effect.sync(() => {
      try {
        log();
      } catch {
        // A diagnostic sink cannot make best-effort teardown observable to the
        // caller in the one way this contract forbids: by replacing its result.
      }
    });
  // Whichever finishes first wins and the other is interrupted: an answer
  // clears the timer, and a failure that lands after the timeout is consumed
  // by the interrupted wait rather than warned about a second time.
  return Effect.raceAllFirst([
    // The SDK issues no request at all when no `mcp-session-id` was captured,
    // so a stateless downstream never sees a spurious DELETE.
    promised(
      authMethod(() => authInvoke(Reflect, "apply", [terminate, transport, []]) as Effect.Effect<void, unknown>),
    ).pipe(
      Effect.catch((error) =>
        // The SDK's error quotes the downstream's status text, and its `data`
        // the body, so the record keeps only the status it answered with.
        warn(() =>
          logFailure(
            logger,
            "session termination refused or failed; the downstream session may remain until its provider timeout",
            failureRecord(
              { connector: connectorId },
              error instanceof SdkHttpError ? attachFailureFacts(error, { httpStatus: error.status }) : error,
            ),
          ),
        ),
      ),
    ),
    Effect.sleep(Duration.millis(TERMINATE_SESSION_BUDGET_MS)).pipe(
      Effect.andThen(
        warn(() =>
          logger.warn(
            `[connecta] connector "${connectorId}" session termination was not ` +
              `acknowledged within ${TERMINATE_SESSION_BUDGET_MS} ms; the ` +
              "downstream may still finish the headers-only DELETE, otherwise " +
              "the session will remain until its provider timeout.",
          ),
        ),
      ),
    ),
  ]);
}

/**
 * The local half of a close: the SDK client's close once a client owns the
 * transport, the bare transport's until then. Never fails, and stops waiting
 * after LOCAL_CLOSE_BUDGET_MS — a transport whose close never settles would
 * otherwise hold every caller that awaits the scope close, the credential Test
 * action among them.
 */
function closeLocally(client: Client | null, transport: Transport | null): Effect.Effect<void> {
  if (!client && !transport) return Effect.void;
  return Effect.raceAllFirst([
    promised(
      authMethod(
        () =>
          (client ? authInvoke(client, "close", []) : authValue(() => transport?.close())) as Effect.Effect<
            void | undefined,
            unknown
          >,
      ),
    ).pipe(Effect.ignore),
    Effect.sleep(Duration.millis(LOCAL_CLOSE_BUDGET_MS)),
  ]);
}
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class RemoteMcpDestinationError extends OAuthRequestNotSentError {
  constructor(connectorId: string, reason: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" refused an OAuth URL the downstream advertised: ${reason}.`,
    );
    this.name = "RemoteMcpDestinationError";
  }
}
labelErrorClass(RemoteMcpDestinationError, "RemoteMcpDestinationError");

/**
 * Refuse, before any request leaves, a URL the downstream taught the OAuth
 * flow that points somewhere connecta must not go (see `url-safety.ts`).
 *
 * The SDK learns authorization-server, token, and registration URLs from the
 * downstream's own metadata and fetches them through the transport's fetch,
 * so this sits below the refresh coordinator on both send paths. Resource
 * redirects stay same-origin; credential-bearing token requests bypass the
 * redirect wrapper. The typed local refusal proves that this guard sent nothing;
 * failures after an HTTP dispatch keep their permanent ambiguous verdict.
 */
export function learnedUrlSafeFetch(connectorId: string, configured: URL, baseFetch: FetchLike): FetchLike {
  return authMethod((input: string | URL, init: RequestInit | undefined) =>
    authFlow<Response>(function* () {
      const reason = learnedUrlRefusal(configured, new URL(input));
      if (reason !== undefined) {
        throw new RemoteMcpDestinationError(connectorId, reason);
      }
      return byteReadResponse((yield authCall(baseFetch, [input, init])) as Response);
    }),
  );
}

/**
 * One logical `tools/call` as its requests meet the wire. The pinned SDK can
 * send one call more than once: after a 401 it renews the grant and resends
 * the message, a redirect hop sends its body again, and a `HeaderMismatch`
 * answer makes `callTool` relist and send the call again under a new JSON-RPC
 * id. So a write is held to one send by its call, never by any one message
 * (INV-9). Reads keep the SDK's recoveries.
 */
/** Set while a connection rests on a modern verdict; see `eraRefusals`. */
export interface EraRefusal {
  refused?: (() => Promise<void>) | undefined;
}
export interface CallDispatch {
  /** At most one request for this call may leave connecta. */
  write: boolean;
  /** Source policy requires write outcome accounting even when served as a read. */
  sourceWrite: boolean;
  /** A request for this call was handed to fetch; no other one may be. */
  sent: boolean;
  /** The answer was a 401, so the SDK renews the grant and resends. */
  unauthorized: boolean;
  /** The answer was a redirect, whose next hop would send the write again. */
  redirected: boolean;
  /** An HTTP refusal without a JSON-RPC error body, perhaps a gateway's after the server acted. */
  ambiguous?: boolean;
  /** A further send of this call was stopped before it left. */
  resendRefused: boolean;
  /**
   * Its entry in the call's ledger and logical call, recorded as it leaves
   * and is answered, with the context it was called under. A read is
   * auxiliary there: it cannot be the write.
   */
  request?: { entry: ProviderRequest; ctx: ConnectorContext };
  /** The `Authorization` its one send carried, for a renewal to be compared with. */
  authorization?: string | null;
}

/**
 * The key a `tools/call`'s params carry its dispatch under. Object spread
 * copies a symbol-keyed property, and the pinned SDK only spreads a request's
 * params (to add a progress token or its `_meta` envelope); `JSON.stringify`
 * skips symbol keys, so nothing of it reaches the wire.
 */
const DISPATCH = Symbol("connecta.dispatch");

export function newDispatch(write: boolean, sourceWrite: boolean): CallDispatch {
  return { write, sourceWrite, sent: false, unauthorized: false, redirected: false, resendRefused: false };
}

export function withDispatch<T extends object>(params: T, dispatch: CallDispatch): T {
  Object.defineProperty(params, DISPATCH, { value: dispatch, enumerable: true });
  return params;
}

function dispatchOf(params: unknown): CallDispatch | undefined {
  return params !== null && typeof params === "object"
    ? (params as { [DISPATCH]?: CallDispatch })[DISPATCH]
    : undefined;
}

/** A further request for a write that already left, stopped before it does. */
function resendRefused(dispatch: CallDispatch): ConnectorCallError {
  dispatch.resendRefused = true;
  return new ConnectorCallError("connector_call_failed", "This write was already sent once; it was not sent again.", {
    retryable: false,
    writeOutcome: "unknown",
  });
}

/** Lost tracking cannot prove whether an earlier message already sent a write. */
function missingDispatch(): ConnectorCallError {
  return new ConnectorCallError(
    "connector_call_failed",
    "The downstream call lost its dispatch record and cannot be proven read-only. It was not sent; whether an earlier write took effect is unknown. Check the target before repeating it.",
    { retryable: false, writeOutcome: "unknown" },
  );
}

/** One connector's transports, sent-secret tracking and session close. */
export function remoteMcpTransport(
  rt: RemoteMcpRuntime,
): Pick<
  RemoteMcpShared,
  | "trackSentRequest"
  | "eraRefused"
  | "closeConnection"
  | "buildTransport"
  | "eraRefusals"
  | "earlyRenewals"
  | "activeContexts"
> {
  const {
    extraHeaders,
    opts,
    isOauth,
    customFetch,
    destination,
    id,
    customSender,
    requestToken,
    skillsEnabled,
    credentialAuth,
    requestAuth,
    credentialHeader,
  } = rt;
  // Each OAuth transport's early renewal: its bound 401 flow, run before a
  // call sends a token about to expire, owned by that call's signal.
  const earlyRenewals = new WeakMap<Transport, (due: string, signal: AbortSignal | undefined) => Promise<void>>();
  // A cached transport may dispatch concurrent calls and listings. Register
  // its actual sent auth with every operation using that client, including
  // handshake/discovery requests and OAuth rotations. Remove settled users.
  const activeContexts = new WeakMap<ConnectionState, Set<ConnectorContext>>();
  // Resource headers are non-secret context by contract. They never join the
  // sent set, so arguments and results equal to them pass unchanged.
  // An argument mirrored as `Mcp-Param-*` carrying a resource value is the
  // same context under a name the tracker may read as credential-shaped.
  const resourceValues = new Set(Object.values(extraHeaders ?? {}));
  const withoutResourceHeaders = (input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined => {
    if (!extraHeaders) return init;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(extraHeaders)) if (headers.get(name) === value) headers.delete(name);
    const mirrored: string[] = [];
    for (const [name, value] of headers)
      if (name.startsWith("mcp-param-") && resourceValues.has(value)) mirrored.push(name);
    for (const name of mirrored) headers.delete(name);
    return { ...init, headers };
  };
  const trackSentRequest = (ctx: ConnectorContext, input: RequestInfo | URL, init?: RequestInit): void => {
    const active = activeContexts.get(rt.entryFor(ctx));
    const recipients = new Set([sentSecretsFor(ctx), ...[...(active ?? [])].map(sentSecretsFor)]);
    const tracked = withoutResourceHeaders(input, init);
    for (const secrets of recipients) {
      if (opts.auth?.type === "oauth") trackRemoteClientRequest(secrets, input, tracked);
      else secrets.request(input, tracked);
    }
  };

  const buildTransport = (
    ctx: ConnectorContext,
    provider: KvOAuthProvider | null,
    /**
     * This attempt's assembled header value, for credential auth only — framed
     * by the caller so the raw secret is not passed around twice. Never
     * retained past the transport it configures.
     */
    credentialFramed: string | null = null,
    signal: AbortSignal | undefined = viewSignal(ctx, true),
    /** The raw value behind `credentialFramed`, under the same terms. */
    credentialValue: string | null = null,
    /** A code exchange never transfers ownership to the refresh coordinator. */
    exchangeOnly = false,
    /** The admitted principal `credentialValue` was resolved for, under the same terms. */
    principal: RequestPrincipal | undefined = undefined,
  ): Transport => {
    const resourceInit = (input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined => {
      if (!extraHeaders) return init;
      const target = new URL(input instanceof Request ? input.url : String(input));
      const resource = new URL(opts.url);
      if (target.origin !== resource.origin || target.pathname !== resource.pathname) return init;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
      return { ...init, headers };
    };
    const responseOwner = Context.get(viewServices(ctx), RequestScope);
    const initiatingSignal = ctx.signal;
    ctx = deriveContext(operationContext(ctx), signal ? { signal } : {});
    if (opts._transportFactory) return opts._transportFactory(ctx);
    const url = new URL(opts.url);
    // Missing records never acquire a fresh write attempt. Only active calls
    // for this exact tool, all classified read, can prove a recordless message
    // safe. Catalog hints alone cannot prove the invocation's served verdict.
    const untrackedRead = (params: unknown): boolean => {
      if (!skillObject(params) || typeof params.name !== "string") return false;
      let read = false;
      for (const [dispatch, name] of rt.entryFor(ctx).dispatches) {
        if (name !== params.name) continue;
        if (dispatch.write) return false;
        read = true;
      }
      return read;
    };
    // This transport's calls on the wire, by JSON-RPC id, while each is sent.
    const flights = new Map<string | number, CallDispatch>();
    const era: EraRefusal = {};
    const trackedFetch: FetchLike = authMethod((input: string | URL, init: RequestInit | undefined) =>
      authFlow<Response>(function* () {
        let rpc: unknown;
        if (typeof init?.body === "string") {
          try {
            rpc = JSON.parse(init.body);
          } catch {}
        }
        const toolCall = init?.method === "POST" && skillObject(rpc) && rpc.method === "tools/call" ? rpc : undefined;
        const writeContinuation = downstreamWriteContinuation(ctx.requestScope ?? ctx) && toolCall !== undefined;
        const flight =
          toolCall && (typeof toolCall.id === "string" || typeof toolCall.id === "number")
            ? flights.get(toolCall.id)
            : undefined;
        if (toolCall && !flight && !untrackedRead(toolCall.params)) throw missingDispatch();
        const credentialPost =
          isOauth && (init?.method ?? "GET").toUpperCase() === "POST" && (!skillObject(rpc) || rpc.jsonrpc !== "2.0");
        // A custom transport reaches only the configured origin; redirects are
        // already same-origin, and OAuth cannot be combined with it.
        if (customFetch && new URL(input instanceof Request ? input.url : String(input)).origin !== destination.origin)
          throw new ConnectorCallError(
            "connector_call_failed",
            `Connector "${id}" refused a request outside its origin; nothing was sent.`,
            { retryable: false },
          );
        // The deployment's fetch owns the wire: each write is handed over once.
        const sender = flight?.write ? (customSender ?? guardedTransport(true)) : undefined;
        if (flight?.write) {
          if (flight.sent) {
            if (flight.request && flight.authorization)
              renewedAfterUnauthorized(
                flight.request.entry,
                flight.authorization,
                new Headers(init?.headers).get("authorization") ?? flight.authorization,
              );
            throw resendRefused(flight);
          }
          flight.authorization = new Headers(init?.headers).get("authorization");
        }
        const request = flight?.request;
        if (request?.entry.dispatched)
          request.entry = providerRequest(request.ctx, !flight?.write, request.entry.provider, {
            method: init?.method ?? "GET",
          });
        const entry = request?.entry;
        const dispatch = () => {
          if (flight?.write) {
            if (flight.sent) throw resendRefused(flight);
            flight.sent = true;
          }
          if (request && entry) {
            if (flight?.sourceWrite) recordRequestField(entry, "sourceWrite", true);
            dispatchProviderRequest(request.ctx, entry, init?.headers, init?.method ?? "GET");
          }
        };
        trackSentRequest(ctx, input, init);
        // Attach retained settlement facts at the physical Promise leaf.
        // Cancellation may end the native waiter before it resumes; neither
        // the status nor a 401 verdict may disappear with that live authority.
        const response = (yield authValue(() => {
          const pending = credentialPost
            ? sendCredentialPost(input, init ?? {}, dispatch)
            : sender
              ? sendGuarded(
                  sender,
                  new URL(input instanceof Request ? input.url : String(input)),
                  { ...init, redirect: "manual" },
                  dispatch,
                )
              : (() => {
                  dispatch();
                  const send = customFetch ?? fetch;
                  return writeContinuation ? send(input, { ...init, redirect: "manual" }) : send(input, init);
                })();
          return pending.then((response) => {
            // RPC fetch adapters can return a disposable Response. Own it at
            // the physical Promise leaf, including a late answer after close,
            // and keep its body live until the existing request boundary.
            const dispose = (response as Response & Partial<Disposable>)[Symbol.dispose];
            if (dispose) responseOwner.own(() => dispose.call(response));
            if (entry) recordProviderResponse(entry, response.status);
            if (flight?.write) {
              if (response.status === 401) flight.unauthorized = true;
              else if (REDIRECT_STATUSES.has(response.status)) flight.redirected = true;
            }
            if (init?.signal?.aborted || request?.ctx.signal?.aborted) void response.body?.cancel().catch(() => {});
            return response;
          });
        })) as Response;
        const refused = response.status === 400 ? era.refused : undefined;
        if (
          (flight?.write || refused) &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          !AUTH_OR_THROTTLE.includes(response.status)
        ) {
          const lifetimes = [init?.signal ?? undefined, request?.ctx.signal, signal];
          const text = (yield authCall(errorBodyText, [response, lifetimes])) as string | undefined;
          const ended = lifetimes.find((lifetime) => lifetime?.aborted);
          if (ended) {
            // Nothing will consume the original either: release its source.
            void response.body?.cancel().catch(() => {});
            throw ended.reason;
          }
          const error = jsonRpcErrorBody(text);
          // Only a JSON-RPC error proves the server refused the write.
          if (flight?.write && !error) flight.ambiguous = true;
          // Per the transport's backward-compatibility rule, a 400 that is no
          // recognized modern error is a legacy refusal, and an
          // UnsupportedProtocolVersion that drops the selected version leaves
          // the verdict unusable; either ends it. The call itself still fails.
          if (
            refused &&
            text !== undefined &&
            !keepsModernVerdict(error, new Headers(init?.headers).get("mcp-protocol-version"))
          )
            (yield authCall(refused, [])) as void;
        }
        if (response.status === 401 && requestToken?.invalidate && credentialValue !== null) {
          // Invalidate the exact bytes this transport sent, never a newer token.
          // Preserve the original 401 even if an operator hook fails. No replay.
          (yield authCatch(
            authInvoke(
              requestToken,
              "invalidate",
              principal ? [credentialValue, ctx, Object.freeze({ principal })] : [credentialValue, ctx],
            ),
            () => {},
          )) as void;
        }
        if (credentialPost && !isOAuthCredentialRequest(init) && REDIRECT_STATUSES.has(response.status)) {
          (yield authCatch(
            authValue(() => response.body?.cancel()),
            () => {},
          )) as void | undefined;
          throw new ConnectorCallError(
            "connector_call_failed",
            "OAuth registration endpoint redirected; the request was not repeated.",
            { retryable: false },
          );
        }
        if (writeContinuation && (response.status === 401 || (response.status >= 300 && response.status < 400))) {
          (yield authCatch(
            authValue(() => response.body?.cancel()),
            () => {},
          )) as void | undefined;
          if (response.status === 401) throw rt.authRequiredError(ctx);
          throw new ConnectorCallError(
            "connector_call_failed",
            "The downstream redirected a write continuation; it was not repeated.",
            { retryable: false, writeOutcome: "unknown" },
          );
        }
        if (flight?.redirected) {
          (yield authCatch(
            authValue(() => response.body?.cancel()),
            () => {},
          )) as void | undefined;
          throw new ConnectorCallError(
            "connector_call_failed",
            "The downstream answered this write with a redirect; it was not sent again.",
            { retryable: false, writeOutcome: "unknown" },
          );
        }
        if (skillsEnabled && skillObject(rpc) && (rpc.method === "skills/list" || rpc.method === "resources/read")) {
          return (yield authCall(boundedSkillResponse, [
            response,
            rpc.method === "skills/list" ? MAX_SERIALIZED_CATALOG_BYTES : MAX_SKILL_READ_RPC_BYTES,
            rpc.id,
            init?.signal,
          ])) as Response;
        }
        return response;
      }),
    );
    // A runtime refusing the assembled header quotes it, and the transport
    // error below keeps none of what the runtime said. So whether the
    // rejection quoted the credential is decided here, first, and survives
    // as the class of the error rather than as its text.
    const guardedFetch = redirectSafeFetch(
      id,
      opts.redirects,
      credentialFramed === null
        ? trackedFetch
        : authMethod((input: string | URL, init: RequestInit | undefined) =>
            authFlow<Response>(function* () {
              try {
                return (yield authCall(trackedFetch, [input, init])) as Response;
              } catch (err) {
                throw rt.withoutCredential(ctx, err, credentialValue, credentialFramed);
              }
            }),
          ),
    );
    if (opts.auth?.type === "oauth") {
      const oauthProvider = provider ?? rt.newProvider(ctx, undefined, signal);
      // The session/provider belong to the request. A renewal belongs to the
      // exact call whose HTTP response challenged it, until claim submission.
      // Carry that ownership on the response the SDK passes to onUnauthorized;
      // a shared mutable "current call" would borrow a concurrent call's lease.
      const renewalSignals = new WeakMap<Response, AbortSignal>();
      const exchangeFetch = (send: FetchLike): FetchLike =>
        exchangeOnly
          ? authMethod(
              (input: string | URL, init: RequestInit | undefined) =>
                authView(
                  ctx,
                  authMethod((requestSignal: AbortSignal) =>
                    authFlow<Response>(function* () {
                      const response = (yield authCall(send, [
                        input,
                        {
                          ...init,
                          signal: init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal,
                        },
                      ])) as Response;
                      if (requestSignal.aborted) {
                        void response.body?.cancel().catch(() => {});
                        throw requestSignal.reason;
                      }
                      return codeExchangeResponse(response, requestSignal);
                    }),
                  ),
                  true,
                ) as Effect.Effect<Response, unknown>,
            )
          : send;
      const coordinatedFetch = rt.refreshCoordinatorFor(ctx).coordinatedFetch(
        oauthProvider,
        exchangeFetch(learnedUrlSafeFetch(id, url, trackedFetch)),
        signal,
        ctx.defer,
        exchangeFetch(
          learnedUrlSafeFetch(
            id,
            url,
            authMethod(
              (input: string | URL, init: RequestInit | undefined) =>
                authCall(guardedFetch, [input, resourceInit(input, init)]) as Effect.Effect<Response, unknown>,
            ),
          ),
        ),
        () => {
          guardedTransport(true);
        },
      );
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider: oauthProvider,
        onInsufficientScope: "throw",
        fetch: authMethod((input: string | URL, init: RequestInit | undefined) =>
          authFlow<Response>(function* () {
            const response = (yield authCall(coordinatedFetch, [input, init])) as Response;
            if (response.status === 401) {
              let owner: AbortSignal | undefined;
              if (typeof init?.body === "string") {
                try {
                  const rpc: unknown = JSON.parse(init.body);
                  if (skillObject(rpc)) {
                    if (rpc.method === "initialize" || rpc.method === "server/discover") owner = initiatingSignal;
                    else if (typeof rpc.id === "string" || typeof rpc.id === "number")
                      owner = flights.get(rpc.id)?.request?.ctx.signal;
                  }
                } catch {}
              }
              const ownedSignal =
                owner && init?.signal ? AbortSignal.any([owner, init.signal]) : (owner ?? init?.signal);
              if (ownedSignal) renewalSignals.set(response, ownedSignal);
            }
            return response;
          }),
        ),
      });
      rt.boundOAuthFlows(ctx, transport, url, [signal, ctx.signal], (response) => renewalSignals.get(response));
      earlyRenewals.set(
        transport,
        authMethod((due: string, owner: AbortSignal | undefined) => {
          // Exactly the flow a 401 starts, through the same refresh coordinator,
          // with nothing sent to the MCP endpoint. The token request carries
          // `due`, so a rotation another request finished is adopted instead.
          const internals = transport as unknown as {
            _authProvider: {
              onUnauthorized: (flow: { response: Response; serverUrl: URL; fetchFn: FetchLike }) => Promise<void>;
            };
            _fetchWithInit: FetchLike;
          };
          const response = new Response(null, { status: 401 });
          if (owner) renewalSignals.set(response, owner);
          return authInvoke(internals._authProvider, "onUnauthorized", [
            { response, serverUrl: url, fetchFn: earlyRenewalFetch(internals._fetchWithInit, due) },
          ]) as Effect.Effect<void, unknown>;
        }),
      );
      return sendingEachWriteOnce(transport, flights, untrackedRead, era);
    }
    const headers =
      opts.auth?.type === "headers"
        ? opts.auth.headers
        : (credentialAuth || requestAuth) && credentialFramed !== null
          ? { ...requestAuth?.headers, [credentialHeader]: credentialFramed }
          : undefined;
    return sendingEachWriteOnce(
      new StreamableHTTPClientTransport(url, {
        ...(headers ? { requestInit: { headers } } : {}),
        fetch: authMethod(
          (input: string | URL, init: RequestInit | undefined) =>
            authCall(guardedFetch, [input, resourceInit(input, init)]) as Effect.Effect<Response, unknown>,
        ),
      }),
      flights,
      untrackedRead,
      era,
    );
  };

  /**
   * Admit a write's call to the wire once, whatever JSON-RPC id a later
   * message for it carries, and show `trackedFetch` which call each message
   * belongs to while it is sent. A missing record fails closed unless active
   * calls prove the tool is read (INV-1, INV-9).
   */
  const sendingEachWriteOnce = (
    transport: StreamableHTTPClientTransport,
    flights: Map<string | number, CallDispatch>,
    untrackedRead: (params: unknown) => boolean,
    era: EraRefusal,
  ): StreamableHTTPClientTransport => {
    eraRefusals.set(transport, era);
    const send = transport.send.bind(transport);
    transport.send = authMethod(
      (
        message: JSONRPCMessage | JSONRPCMessage[],
        options:
          | {
              resumptionToken?: string;
              onresumptiontoken?: (token: string) => void;
              requestSignal?: AbortSignal;
              onRequestStreamEnd?: () => void;
              headers?: Readonly<Record<string, string>>;
            }
          | undefined,
      ) =>
        authFlow<void>(function* () {
          const request =
            !Array.isArray(message) && "method" in message && message.method === "tools/call" && "id" in message
              ? message
              : undefined;
          if (!request) return (yield authCall(send, [message, options])) as void;
          const dispatch = dispatchOf(request.params);
          if (!dispatch) {
            if (!untrackedRead(request.params)) throw missingDispatch();
            return (yield authCall(send, [message, options])) as void;
          }
          if (dispatch.write && dispatch.sent) throw resendRefused(dispatch);
          flights.set(request.id, dispatch);
          try {
            return (yield authCall(send, [message, options])) as void;
          } finally {
            flights.delete(request.id);
          }
        }),
    );
    return transport;
  };

  // Detached exits start this bounded best-effort tail immediately;
  // closeScope awaits its own tail so the core
  // can pass it to the runtime's deferred channel. Terminating and closing are
  // each bounded, so no close waits more than two seconds in all.
  const closingSessions = new WeakMap<Transport, Deferred.Deferred<void>>();
  // On a modern connection, adopted from a stored verdict or just negotiated, a 400 whose body is
  // no recognized modern error is a legacy refusal (see `trackedFetch`): the
  // verdict is forgotten and the client retired.
  const eraRefusals = new WeakMap<Transport, EraRefusal>();
  const eraRefused = new WeakSet<Client>();
  const closeConnection = (client: Client | null, transport: Transport | null, logger: Logger): Effect.Effect<void> =>
    Effect.suspend(() => {
      const previous = transport && closingSessions.get(transport);
      if (previous) return Deferred.await(previous);
      const closed = Deferred.makeUnsafe<void>();
      // A connect can acquire a session after an early close. Deduplicate only
      // once that session exists, so its late abandonment still sends DELETE.
      if (transport?.sessionId) closingSessions.set(transport, closed);
      return (transport ? terminateSession(transport, logger, id) : Effect.void).pipe(
        Effect.andThen(closeLocally(client, transport)),
        Effect.ensuring(Deferred.done(closed, Exit.void)),
      );
    });
  return { trackSentRequest, eraRefused, closeConnection, buildTransport, eraRefusals, earlyRenewals, activeContexts };
}
