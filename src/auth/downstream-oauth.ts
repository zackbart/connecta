import type {
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { Deferred, Effect } from "effect";
import { byteReadResponse } from "../byte-read-response.js";
import { deriveContext } from "../derived-context.js";
import { ConnectorCallError, resendAdvice } from "../errors.js";
import { oauthPartitionFor, retainOAuthPartition } from "../oauth-partition.js";
import type { OAuthStateSealer } from "../oauth-sealing.js";
import { keepErrorName } from "../redaction-identity.js";
import { fromSignal, runEdge } from "../runtime/run.js";
import { SentSecrets } from "../sent-secrets.js";
import {
  OAUTH_FLOW_TTL_SECONDS,
  OAUTH_REFRESH_LEASE_SECONDS,
  oauthFlowKeys,
  oauthGrantKeys,
  oauthRefreshActiveKeys,
  oauthRefreshKeys,
  oauthRefreshSpentKeys,
} from "../storage/keys.js";
import type { ConnectorContext, KVStorage } from "../types.js";
import {
  authenticateRemoteClient,
  downstreamClientMetadata,
  remoteClientAuthMethod,
  type RemoteOAuthClient,
} from "./downstream-client-metadata.js";
import { revokeDownstreamGrant } from "./downstream-revocation.js";
import {
  authAwait,
  authCall,
  authCatch,
  authDetached,
  authFlow,
  authInvoke,
  authMethod,
  authOwnMethod,
  authProgram,
  authStorage,
  authThen,
  authValue,
  registerAuth,
  registerAuthMethod,
} from "./native.js";
import {
  isOAuthCredentialRequest,
  isRefreshTokenRequest,
  refreshResponseOutcome,
  sdkSafeTokenResponse,
  tokenGrantType,
  type RefreshFailure,
  type RefreshResponseOutcome,
} from "./oauth-token-response.js";
import {
  deleteV2Keys,
  discoveryIssuer,
  readV2Grant,
  type MigratedGrant,
  type MigratedGrantBody,
} from "./oauth-v2-migration.js";

/** @internal Keep the SDK's cloned body reads inside the code exchange's request. */
export function codeExchangeResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  void reader.closed.catch(() => {});
  let closed = false;
  let abort: () => void;
  const release = () => {
    closed = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        void reader.cancel().catch(() => {});
        release();
        controller.error(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (!closed) {
          release();
          controller.error(error);
        }
      }
    },
    cancel() {
      if (!closed) {
        void reader.cancel().catch(() => {});
        release();
      }
    },
  });
  return byteReadResponse(
    new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
  );
}

/** RFC 6749 section 3.3: one or more scope tokens, separated by single spaces. */
const OAUTH_SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/;

/** Refuse, at construction, a configured scope no authorization server could parse. */
export function assertOAuthScope(connectorId: string, scope: string | undefined): void {
  if (scope !== undefined && !OAUTH_SCOPE.test(scope)) {
    throw new Error(`[connecta] connector "${connectorId}" OAuth scope must contain space-separated scope tokens.`);
  }
}

/**
 * The context an explicit authorization start runs under: allowed to begin
 * consent, in the same request scope, and derived so the registry's sealer,
 * owner partition, and every other call-state entry carry across the copy.
 * Only `startAuth` builds one; status reads and calls never do, which is what
 * keeps them from starting authorization.
 */
export function authorizingContext(ctx: ConnectorContext): ConnectorContext {
  return deriveContext(ctx, { allowAuthorization: true });
}

/**
 * A callback whose consent another callback already claimed: fixed text, and
 * nothing was sent. Its own class so the callback route can answer it as the
 * already-used link it is, not as an exchange the provider refused.
 */
export class OAuthCallbackClaimedError extends ConnectorCallError {
  constructor(connectorId: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" authorization callback was already used by another request; nothing was exchanged.`,
    );
    this.name = "OAuthCallbackClaimedError";
  }
}
keepErrorName(OAuthCallbackClaimedError, "OAuthCallbackClaimedError");

/** A local destination guard proved that no OAuth HTTP request left. */
export class OAuthRequestNotSentError extends ConnectorCallError {}

/** A 256-bit random opaque value, hex-encoded — used for the OAuth `state`. */
function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase hex SHA-256 of a consent's `state`: the name of its flow record. */
export async function oauthStateDigest(state: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type RefreshFlightOutcome =
  | { status: "refreshed"; tokens: OAuthTokens }
  /** A reset fenced the epoch: joiners read again and find their flow superseded. */
  | { status: "retired" }
  /** `verdict` is present when the token endpoint's answer (or silence) decided it. */
  | { status: "failed"; error: unknown; verdict?: RefreshFailure };

/**
 * One redemption of one epoch's refresh token. It holds no request state: the
 * owner settles it from its own request, and joined requests only await it.
 */
interface RefreshLease {
  spentKey: string;
  spentExpected: string | null;
  spentRaw?: string;
  key: string;
  raw: string;
}

interface StoredRefreshSpent {
  connectaOAuthRefreshSpent: 1;
  epoch: string;
  holder: string;
  activeKey: string;
  state: "outstanding" | "ambiguous" | "resolved";
  resolvedAt?: number;
}

function storedRefreshSpent(raw: string | null): StoredRefreshSpent | undefined {
  const value = raw === null ? undefined : parsed(raw);
  return plainObject(value) &&
    value.connectaOAuthRefreshSpent === 1 &&
    typeof value.epoch === "string" &&
    typeof value.holder === "string" &&
    typeof value.activeKey === "string" &&
    (value.state === "outstanding" ||
      value.state === "ambiguous" ||
      (value.state === "resolved" && typeof value.resolvedAt === "number" && Number.isFinite(value.resolvedAt)))
    ? (value as unknown as StoredRefreshSpent)
    : undefined;
}

interface StoredRefreshLease {
  connectaOAuthRefresh: 1;
  holder: string;
  state: "claimed" | "dispatched";
  activeKey?: string;
  expiresAt: number;
  verdict?: RefreshFailure;
  completed?: true;
  tokenDigest?: string;
}

const REFRESH_REQUEST_DEADLINE_MS = 20_000;
const REFRESH_WAIT_DEADLINE_MS = 35_000;

/** Caller-owned reads become coordinator-owned at the first submitted durable write. */
interface RefreshWait {
  signal: AbortSignal;
  readonly requestStarted: boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
  transfer(): void;
  beginRequest(): void;
  close(): void;
}

function refreshWait(signal?: AbortSignal): RefreshWait {
  const deadline = new AbortController();
  let timer = setTimeout(() => deadline.abort(), REFRESH_WAIT_DEADLINE_MS);
  let closed = false;
  let transferred = false;
  let requestStarted = false;
  const abort = () => deadline.abort(aborted(signal));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    signal: deadline.signal,
    get requestStarted() {
      return requestStarted;
    },
    run: authMethod(<T>(operation: () => Promise<T>) => {
      return authFlow<T | T>(function* () {
        if (deadline.signal.aborted) return (yield Effect.fail(aborted(deadline.signal))) as Awaited<T>;
        return (yield authThen(
          Effect.raceAllFirst<Effect.Effect<T, unknown>>([fromSignal(deadline.signal), authCall<T>(operation, [])]),
          (value: T) => {
            if (deadline.signal.aborted) throw aborted(deadline.signal);
            return value;
          },
        )) as Awaited<T> | Awaited<T>;
      });
    }),
    transfer: () => {
      if (deadline.signal.aborted) throw aborted(deadline.signal);
      if (transferred) return;
      // Synchronous with CAS submission: cancellation can prevent the write
      // only before this point. Keep the independent preparation timer alive.
      signal?.removeEventListener("abort", abort);
      transferred = true;
    },
    beginRequest: () => {
      if (deadline.signal.aborted) throw aborted(deadline.signal);
      requestStarted = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        deadline.abort(new DOMException("OAuth refresh timed out", "TimeoutError"));
      }, REFRESH_REQUEST_DEADLINE_MS);
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

interface RefreshFlight {
  outcome: Deferred.Deferred<RefreshFlightOutcome>;
}

function aborted(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * The outcome of a flight another request owns, failures included. Rejects
 * only with this caller's own abort.
 *
 * This wait is a Promise edge of its own, and the caller's storage reads stay
 * outside it, on purpose. The owner settles the Deferred from its own request,
 * and Deferred resumes a waiting fiber synchronously inside that call — on
 * Workers, inside the owner's I/O context. Resolving this caller's promise
 * instead hands the rest of its work back to its own request, as workerd does
 * for any promise resolved from another one.
 */
function waitForRefreshFlight(
  flight: RefreshFlight,
  signal?: AbortSignal,
  deadline?: AbortSignal,
): Promise<RefreshFlightOutcome> {
  const settled = Deferred.await(flight.outcome);
  // The abort goes first, so a caller that has already left never joins.
  return runEdge(
    Effect.raceAllFirst<Effect.Effect<RefreshFlightOutcome, unknown>>([
      ...(signal ? [fromSignal(signal)] : []),
      ...(deadline ? [fromSignal(deadline)] : []),
      settled,
    ]),
  );
}

/** Tokens as a token response the SDK parses: only the client stamps an issuer. */
function tokenResponse(tokens: OAuthTokens): Response {
  const { issuer: _issuer, ...answer } = tokens as OAuthTokens & { issuer?: unknown };
  return Response.json(answer);
}

function refreshTokensDigest(tokens: OAuthTokens): Promise<string> {
  return runEdge(authProgram<string>(refreshTokensDigestNative, [tokens]));
}
const refreshTokensDigestNative = /* @__PURE__ */ registerAuth(refreshTokensDigest, function (tokens: OAuthTokens) {
  return authFlow<string>(function* () {
    const { issuer: _issuer, ...answer } = tokens as OAuthTokens & {
      issuer?: unknown;
    };
    return (yield authCall(oauthStateDigest, [
      JSON.stringify(
        Object.fromEntries(
          Object.entries(answer).sort(
            ([a]: [string, string | number | undefined], [b]: [string, string | number | undefined]) =>
              a.localeCompare(b),
          ),
        ),
      ),
    ])) as string;
  });
});

function requestedRefreshToken(init: RequestInit | undefined): string | null {
  return init?.body instanceof URLSearchParams
    ? init.body.get("refresh_token")
    : new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
}

/**
 * The token endpoint as one connector runtime's OAuth flows reach it.
 *
 * A refresh is redeemed once per owner partition and epoch: the first request
 * owns the fetch, classifies the answer, and stores an accepted rotation, by
 * compare-and-set, before anyone is released, so a cancelled owner or an SDK
 * that redirects instead of saving cannot strand a spent refresh token.
 * Requests that arrive meanwhile join its outcome; a request whose token read
 * predates a stored refresh is handed that refresh instead of redeeming again.
 * A shared-storage lease prevents concurrent redemption across isolates;
 * the grant CAS also fences stale rotations.
 *
 * A code exchange claims its consent's flow record and re-checks the epoch in
 * the turn that dispatches it (`KvOAuthProvider.claimCodeExchange`,
 * `dispatchCodeExchange`). Every token answer the SDK parses is rebuilt from
 * the OAuth `error` code alone unless it is a token response.
 */
export class OAuthRefreshCoordinator {
  private readonly flights = new Map<string, RefreshFlight>();

  constructor(private readonly retainPartition: () => () => void = () => () => {}) {}

  coordinatedFetch(
    provider: KvOAuthProvider,
    baseFetch: FetchLike,
    requestSignal?: AbortSignal,
    defer?: ConnectorContext["defer"],
    resourceFetch: FetchLike = baseFetch,
    prepareCredentialRequest?: () => void,
  ): FetchLike {
    return authMethod((input: string | URL, init: RequestInit | undefined) => {
      return authFlow<Response>(
        function* (this: OAuthRefreshCoordinator) {
          init = init
            ? { ...init, ...(init.body instanceof URLSearchParams ? { body: new URLSearchParams(init.body) } : {}) }
            : undefined;
          if (isOAuthCredentialRequest(init)) prepareCredentialRequest?.();
          if (isRefreshTokenRequest(init)) {
            const signal =
              requestSignal && init?.signal
                ? AbortSignal.any([requestSignal, init.signal])
                : (requestSignal ?? init?.signal ?? undefined);
            return (yield authInvoke(this, "refresh", [provider, input, init, baseFetch, signal, defer])) as Response;
          }
          const grantType = tokenGrantType(init);
          const tokenRequest = isOAuthCredentialRequest(init);
          const exchange = grantType === "authorization_code";
          if (exchange) {
            const answered = (yield authInvoke(provider, "claimCodeExchange", [])) as Response | undefined;
            if (answered) return answered;
          }
          const dispatch = authMethod(() => {
            return authFlow<Response>(
              function* (this: OAuthRefreshCoordinator) {
                if (requestSignal?.aborted) throw aborted(requestSignal);
                const signal = requestSignal
                  ? init?.signal
                    ? AbortSignal.any([requestSignal, init.signal])
                    : requestSignal
                  : init?.signal;
                return (yield tokenRequest
                  ? authCall(baseFetch, [input, { ...init, redirect: "manual", ...(signal ? { signal } : {}) }])
                  : authCall(resourceFetch, [input, { ...init, ...(signal ? { signal } : {}) }])) as Response;
              }.bind(this),
            );
          });
          const response = (yield exchange
            ? authInvoke(provider, "dispatchCodeExchange", [dispatch, input])
            : authCall(dispatch, [])) as Response;
          if (!tokenRequest) return response;
          const forSdk = (yield authCall(sdkSafeTokenResponse, [
            response,
            exchange
              ? authMethod((tokens: OAuthTokens) => {
                  return authInvoke(provider, "recordCodeExchangeTokens", [tokens]) as Effect.Effect<void, unknown>;
                })
              : undefined,
          ])) as Response;
          if (exchange && forSdk !== response) provider.recordCodeExchangeRefusal(forSdk);
          return forSdk;
        }.bind(this),
      );
    });
  }

  private refresh(
    provider: KvOAuthProvider,
    input: string | URL,
    init: RequestInit | undefined,
    baseFetch: FetchLike,
    signal: AbortSignal | undefined,
    defer: ConnectorContext["defer"],
  ): Promise<Response> {
    return runEdge(
      authOwnMethod<Response>(OAuthRefreshCoordinator.prototype, this, "refresh", [
        provider,
        input,
        init,
        baseFetch,
        signal,
        defer,
      ]),
    );
  }

  private redeem(
    provider: KvOAuthProvider,
    epoch: string,
    requested: string | null,
    input: string | URL,
    init: RequestInit | undefined,
    baseFetch: FetchLike,
    waiting: RefreshWait,
  ): Promise<Response> {
    return runEdge(
      authOwnMethod<Response>(OAuthRefreshCoordinator.prototype, this, "redeem", [
        provider,
        epoch,
        requested,
        input,
        init,
        baseFetch,
        waiting,
      ]),
    );
  }

  /** A reset fenced `epoch`: wake its joiners now rather than at the answer. */
  retire(epoch: string): void {
    const flight = this.flights.get(epoch);
    if (!flight) return;
    this.flights.delete(epoch);
    Deferred.doneUnsafe(flight.outcome, Effect.succeed({ status: "retired" }));
  }

  static {
    registerAuthMethod(
      OAuthRefreshCoordinator.prototype,
      "refresh",
      function (
        this: OAuthRefreshCoordinator,
        provider: KvOAuthProvider,
        input: string | URL,
        init: RequestInit | undefined,
        baseFetch: FetchLike,
        signal: AbortSignal | undefined,
        defer: ConnectorContext["defer"],
      ) {
        return authFlow<Response>(
          function* (this: OAuthRefreshCoordinator) {
            if (signal?.aborted) throw aborted(signal);
            const waiting = refreshWait(signal);
            let redeeming = false;
            try {
              provider.recordRefreshFailure(undefined);
              const epoch = (yield authInvoke(waiting, "run", [
                authMethod(() => {
                  return authInvoke(provider, "flowEpoch", []) as Effect.Effect<string, unknown>;
                }),
              ])) as string;
              const requested = requestedRefreshToken(init);
              for (let attempt = 0; attempt < 8; attempt++) {
                if (signal?.aborted) throw aborted(signal);
                const joined = this.flights.get(epoch);
                if (joined) {
                  const outcome = (yield authCall(waitForRefreshFlight, [
                    joined,
                    signal,
                    waiting.signal,
                  ])) as RefreshFlightOutcome;
                  if (signal?.aborted) throw aborted(signal);
                  if (outcome.status === "failed") {
                    provider.recordRefreshFailure(outcome.verdict);
                    throw outcome.error;
                  }
                  if (outcome.status === "refreshed") return provider.adoptRefresh(outcome.tokens);
                  continue;
                }
                const current = (yield authInvoke(waiting, "run", [
                  authMethod(() => {
                    return authInvoke(provider, "storedTokens", [waiting.signal]) as Effect.Effect<
                      | {
                          access_token: string;
                          token_type: string;
                          id_token?: string | undefined;
                          expires_in?: number | undefined;
                          scope?: string | undefined;
                          refresh_token?: string | undefined;
                          issuer?: string | undefined;
                        }
                      | undefined,
                      unknown
                    >;
                  }),
                ])) as
                  | {
                      access_token: string;
                      token_type: string;
                      id_token?: string | undefined;
                      expires_in?: number | undefined;
                      scope?: string | undefined;
                      refresh_token?: string | undefined;
                      issuer?: string | undefined;
                    }
                  | undefined;
                if (this.flights.has(epoch)) continue;
                if (
                  current?.refresh_token &&
                  (current.refresh_token !== requested || provider.refreshedSinceRead(current, epoch))
                ) {
                  return provider.adoptRefresh(current);
                }
                if (current?.refresh_token !== requested) {
                  provider.recordRefreshFailure({ kind: "dead" });
                  return Response.json(
                    { error: "invalid_grant", error_description: "Refresh token is no longer active." },
                    { status: 400 },
                  );
                }
                redeeming = true;
                // Claim submission transfers to a bounded native coordinator;
                // its runner receives no request/call Context authority.
                const redemption = authDetached(
                  authInvoke<Response>(this, "redeem", [
                    provider,
                    epoch,
                    requested,
                    input,
                    init,
                    baseFetch,
                    waiting,
                  ]).pipe(Effect.ensuring(Effect.sync(() => waiting.close()))),
                  defer,
                );
                return (yield signal ? Effect.raceFirst(redemption, fromSignal(signal)) : redemption) as Response;
              }
              throw provider.refreshContended();
            } catch (error) {
              if (signal?.aborted) throw aborted(signal);
              if (waiting.signal.aborted && !waiting.requestStarted) throw provider.refreshContended();
              throw error;
            } finally {
              if (!redeeming) waiting.close();
            }
          }.bind(this),
        );
      },
      OAuthRefreshCoordinator.prototype.refresh,
    );
    registerAuthMethod(
      OAuthRefreshCoordinator.prototype,
      "redeem",
      function (
        this: OAuthRefreshCoordinator,
        provider: KvOAuthProvider,
        epoch: string,
        requested: string | null,
        input: string | URL,
        init: RequestInit | undefined,
        baseFetch: FetchLike,
        waiting: RefreshWait,
      ) {
        return authFlow<Response>(
          function* (this: OAuthRefreshCoordinator) {
            const flight: RefreshFlight = { outcome: Deferred.makeUnsafe() };
            this.flights.set(epoch, flight);
            const release = this.retainPartition();
            const settle = (outcome: RefreshFlightOutcome) => {
              if (this.flights.get(epoch) === flight) this.flights.delete(epoch);
              release();
              Deferred.doneUnsafe(flight.outcome, Effect.succeed(outcome));
            };
            const fail = (error: unknown, verdict?: RefreshFailure) => {
              if (verdict) provider.recordRefreshFailure(verdict);
              settle({ status: "failed", error, ...(verdict ? { verdict } : {}) });
            };
            const issuer = provider.refreshIssuer(epoch);
            let lease: RefreshLease;
            try {
              const claim = (yield authInvoke(provider, "claimRefresh", [epoch, requested, undefined, waiting])) as
                | Response
                | RefreshLease;
              if (claim instanceof Response) {
                const tokens = (yield authInvoke(waiting, "run", [
                  authMethod(() => {
                    return authInvoke(provider, "storedTokens", [waiting.signal]) as Effect.Effect<
                      | {
                          access_token: string;
                          token_type: string;
                          id_token?: string | undefined;
                          expires_in?: number | undefined;
                          scope?: string | undefined;
                          refresh_token?: string | undefined;
                          issuer?: string | undefined;
                        }
                      | undefined,
                      unknown
                    >;
                  }),
                ])) as
                  | {
                      access_token: string;
                      token_type: string;
                      id_token?: string | undefined;
                      expires_in?: number | undefined;
                      scope?: string | undefined;
                      refresh_token?: string | undefined;
                      issuer?: string | undefined;
                    }
                  | undefined;
                if (tokens) settle({ status: "refreshed", tokens });
                else settle({ status: "retired" });
                return claim;
              }
              lease = claim;
            } catch (error) {
              fail(error, provider.refreshVerdict());
              throw error;
            }
            const releaseLease = authMethod(
              (verdict?: RefreshFailure, resolution: "resolved" | "ambiguous" = "ambiguous") => {
                return authFlow<void>(
                  function* (this: OAuthRefreshCoordinator) {
                    (yield authInvoke(provider, "releaseRefresh", [lease, verdict, undefined, resolution])) as void;
                  }.bind(this),
                );
              },
            );
            let outcome: RefreshResponseOutcome;
            const deadline = waiting.signal;
            let dispatched = false;
            try {
              const read = authFlow<RefreshResponseOutcome>(
                function* (this: OAuthRefreshCoordinator) {
                  const response = (yield authInvoke(provider, "dispatchRefresh", [
                    lease,
                    authMethod(() =>
                      authFlow<Response>(
                        function* (this: OAuthRefreshCoordinator) {
                          waiting.beginRequest();
                          dispatched = true;
                          return (yield authCall(baseFetch, [
                            input,
                            { ...init, redirect: "manual", signal: deadline },
                          ])) as Response;
                        }.bind(this),
                      ),
                    ),
                    waiting,
                  ])) as Response;
                  if (deadline.aborted) {
                    void response.body?.cancel().catch(() => {});
                    throw aborted(deadline);
                  }
                  return (yield authCall(refreshResponseOutcome, [response, deadline])) as RefreshResponseOutcome;
                }.bind(this),
              );
              outcome = (yield Effect.raceFirst(read, fromSignal(deadline))) as RefreshResponseOutcome;
              if (deadline.aborted) throw aborted(deadline);
            } catch (error) {
              if (!dispatched) {
                if (!waiting.signal.aborted) {
                  (yield authCatch(
                    authInvoke(waiting, "run", [
                      authMethod(() => {
                        return authCall(releaseLease, []) as Effect.Effect<void, unknown>;
                      }),
                    ]),
                    () => {},
                  )) as void;
                  if (provider.refreshVerdict()?.kind === "dead") {
                    (yield authCatch(
                      authInvoke(waiting, "run", [
                        authMethod(() => {
                          return authInvoke(provider, "discardRefusedGrant", [requested, epoch]) as Effect.Effect<
                            void,
                            unknown
                          >;
                        }),
                      ]),
                      () => {},
                    )) as void;
                  }
                }
                const failure = waiting.signal.aborted ? provider.refreshContended() : error;
                fail(failure, provider.refreshVerdict());
                throw failure;
              }
              const failure = new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
              (yield authCall(releaseLease, [{ kind: "dead" }])) as void;
              (yield authInvoke(provider, "discardRefusedGrant", [requested, epoch])) as void;
              fail(failure, { kind: "dead" });
              throw failure;
            } finally {
              waiting.close();
            }
            if (outcome.failure) {
              (yield authInvoke(provider, "discardRefusedGrant", [requested, epoch])) as void;
              (yield authCall(releaseLease, [outcome.verdict, "resolved"])) as void;
              fail(outcome.failure, outcome.verdict);
              return outcome.forSdk;
            }
            const accepted: OAuthTokens = {
              ...outcome.tokens,
              ...(outcome.tokens.refresh_token === undefined && requested !== null ? { refresh_token: requested } : {}),
            };
            let committed: OAuthTokens | undefined;
            try {
              committed = (yield authInvoke(provider, "storeRefresh", [epoch, requested, accepted, issuer])) as
                | {
                    access_token: string;
                    token_type: string;
                    id_token?: string | undefined;
                    expires_in?: number | undefined;
                    scope?: string | undefined;
                    refresh_token?: string | undefined;
                    issuer?: string | undefined;
                  }
                | undefined;
            } catch {
              const failure = new UnauthorizedError("OAuth refresh could not be committed; authorization required.");
              (yield authCall(releaseLease, [{ kind: "dead" }, "resolved"])) as void;
              (yield authInvoke(provider, "discardRefusedGrant", [requested, epoch])) as void;
              fail(failure, { kind: "dead" });
              throw failure;
            }
            if (!committed) {
              (yield authCall(releaseLease, [{ kind: "dead" }, "resolved"])) as void;
              const failure = new UnauthorizedError("OAuth refresh grant is no longer active.");
              fail(failure, { kind: "dead" });
              throw failure;
            }
            (yield authInvoke(provider, "releaseRefresh", [lease, undefined, committed, "resolved"])) as void;
            settle({ status: "refreshed", tokens: committed });
            return provider.adoptRefresh(committed);
          }.bind(this),
        );
      },
      OAuthRefreshCoordinator.prototype.redeem,
    );
  }
}

/**
 * One refresh coordinator per owner partition, for one connector runtime.
 * Long-lived enough for distinct request scopes to join one token redemption;
 * it owns no client, transport, or request state. Production contexts carry a
 * stable registry partition; hand-written contexts coordinate by their shared
 * storage object instead.
 */
export function refreshCoordinatorsByPartition(): (ctx: ConnectorContext) => OAuthRefreshCoordinator {
  const coordinators = new WeakMap<object, OAuthRefreshCoordinator>();
  return (ctx) => {
    const partition = oauthPartitionFor(ctx) ?? ctx.storage;
    let coordinator = coordinators.get(partition);
    if (!coordinator) {
      coordinator = new OAuthRefreshCoordinator(() => retainOAuthPartition(partition));
      coordinators.set(partition, coordinator);
    }
    return coordinator;
  };
}

const GRANT = oauthGrantKeys.grant;
/** The epoch of an owner with no grant record yet. */
const INITIAL_EPOCH = "initial";
/** The epoch of a record that does not parse: readers see no grant in it. */
const UNREADABLE_EPOCH = "unreadable";
const ACTIVE_EPOCH_PREFIX = "v3:";
const DISCONNECTED_EPOCH_PREFIX = "disconnected:";
const GRANT_VERSION = 3;
const FLOW_VERSION = 1;
/** Attempts at one grant write while other writers keep winning. */
const MAX_GRANT_WRITES = 32;
/**
 * How long a pending authorization URL may be handed out again instead of
 * starting a fresh flow. The authorization server's half of it expires: a
 * pushed request URI lives seconds to minutes (RFC 9126), and login
 * transactions are commonly held for minutes. Past this age a reissued URL
 * more likely lands on an expired session than on consent, and a fresh start
 * costs one authorization request, not a registration. It sits inside the
 * flow record's fifteen minutes.
 */
const PENDING_AUTHORIZATION_MAX_AGE_MS = 10 * 60 * 1000;

type GrantBody = MigratedGrantBody & {
  /** The exact resolved storage write observed before this consent committed. */
  refreshConsent?: { digest: string; resolution: string };
};

/**
 * One owner's grant: its epoch, the state digest of the epoch's latest
 * consent, and one authorization server's client, tokens, and discovery.
 * A value written for another server replaces the body whole, so a grant
 * never mixes servers and nothing it holds is sent to one that did not
 * issue it.
 */
interface Grant {
  cleanupPending?: true;
  epoch: string;
  flow?: string;
  body: GrantBody;
}

/** A grant as stored: the body sealed when the vault can seal. */
interface StoredGrant {
  cleanupPending?: true;
  connectaOAuth: typeof GRANT_VERSION;
  epoch: string;
  flow?: string;
  sealed?: string;
  body?: GrantBody;
}

interface FlowBinding {
  issRequired?: true;
  issuer?: string | undefined;
  clientId?: string | undefined;
  tokenEndpoint?: string | undefined;
  discovery?: string | undefined;
}

function discoveryBinding(state: OAuthDiscoveryState | undefined): Promise<FlowBinding> {
  return runEdge(authProgram<FlowBinding>(discoveryBindingNative, [state]));
}
const discoveryBindingNative = /* @__PURE__ */ registerAuth(
  discoveryBinding,
  function (state: OAuthDiscoveryState | undefined) {
    return authFlow<FlowBinding>(function* () {
      return state
        ? {
            issuer: discoveryIssuer(state),
            tokenEndpoint: state.authorizationServerMetadata?.token_endpoint,
            ...(state.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true
              ? { issRequired: true as const }
              : {}),
            discovery: (yield authCall(oauthStateDigest, [JSON.stringify(state)])) as string,
          }
        : {};
    });
  },
);

/** One consent, by its state's digest. A claimed one keeps only its epoch. */
interface Flow {
  binding?: FlowBinding;
  epoch: string;
  /** Epoch milliseconds the consent was written. */
  at: number;
  url?: string;
  verifier?: string;
  consumed?: true;
}

interface StoredFlow {
  binding?: FlowBinding;
  connectaOAuthFlow: typeof FLOW_VERSION;
  epoch: string;
  at: number;
  url?: string;
  verifier?: string;
  /** The verifier is ciphertext. */
  sealed?: true;
  consumed?: true;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function storedGrant(raw: string): StoredGrant | undefined {
  const value = parsed(raw);
  return plainObject(value) &&
    value.connectaOAuth === GRANT_VERSION &&
    typeof value.epoch === "string" &&
    (value.flow === undefined || typeof value.flow === "string") &&
    (value.sealed === undefined || typeof value.sealed === "string")
    ? (value as unknown as StoredGrant)
    : undefined;
}

/** The epoch a raw grant record names, without opening its body. */
function epochOf(raw: string | null): string {
  if (raw === null) return INITIAL_EPOCH;
  return storedGrant(raw)?.epoch ?? UNREADABLE_EPOCH;
}

/** Nothing here trusts stored bytes: keep only what has the expected shape. */
function grantBody(value: unknown): GrantBody {
  if (!plainObject(value)) return {};
  const { issuer, client, tokens, discovery, refreshConsent } = value;
  return {
    ...(typeof issuer === "string" ? { issuer } : {}),
    ...(plainObject(client) && plainObject(client.value) && typeof client.value.client_id === "string"
      ? {
          client: {
            value: client.value as unknown as OAuthClientInformationMixed,
            ...(typeof client.binding === "string" ? { binding: client.binding } : {}),
            ...(client.carried === true ? { carried: true as const } : {}),
            ...(client.registrationPath === "cimd" ||
            client.registrationPath === "dcr" ||
            client.registrationPath === "static"
              ? { registrationPath: client.registrationPath }
              : {}),
          },
        }
      : {}),
    ...(plainObject(tokens) && typeof tokens.access_token === "string"
      ? { tokens: tokens as unknown as OAuthTokens }
      : {}),
    ...(discoveryIssuer(discovery) !== undefined ? { discovery: discovery as unknown as OAuthDiscoveryState } : {}),
    ...(plainObject(refreshConsent) &&
    typeof refreshConsent.digest === "string" &&
    typeof refreshConsent.resolution === "string"
      ? { refreshConsent: { digest: refreshConsent.digest, resolution: refreshConsent.resolution } }
      : {}),
  };
}

/** What an invalidation compares: the value exactly as this flow saw it. */
function fingerprint(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

function isDisconnectedEpoch(epoch: string): boolean {
  return epoch.startsWith(DISCONNECTED_EPOCH_PREFIX);
}

/**
 * OAuthClientProvider over one owner's grant record and its consents' flow
 * records, in one connector's namespace.
 *
 * Headless: `redirectToAuthorization()` cannot navigate a user agent, so it
 * stores the consent; the registry surfaces its URL, and the
 * `/oauth/callback/<id>` route drives the exchange.
 *
 * A flow — a connect attempt, an `api()` call or start, or a callback — binds
 * to one epoch. Its reads fail once another epoch is live, and its writes are
 * compare-and-sets against the record it read, so a restart or disconnect,
 * which replaces the epoch, fences every flow that began before it.
 */
export class KvOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  readonly addClientAuthentication?: NonNullable<OAuthClientProvider["addClientAuthentication"]>;
  /** The epoch this provider's flow reads and writes in, once known. */
  private epoch: string | undefined;
  /** Set when a flow binds: from then on a replaced epoch fails the flow. */
  private bound = false;
  /** The consent being started, held until `redirectToAuthorization` stores it. */
  private consentDiscovery: OAuthDiscoveryState | undefined;
  private consent: { state?: string; verifier?: string } = {};
  /** The consent this provider stored, for the start that asked for it. */
  private published: { epoch: string; url: string } | undefined;
  /** The consent a matching `verifyState` found, which the exchange claims. */
  private callback: { key: string; raw: string; flow: Flow; claimed: boolean } | undefined;
  /** Set by `bindFlow`: this provider exchanges a code. */
  private codeExchange = false;
  /** The token endpoint's refusal of this exchange's code, for the SDK's retry. */
  private exchangeRefusal: Response | undefined;
  /** Resolution observed when the code answer completed, before the SDK saves. */
  private exchangeConsent: GrantBody["refreshConsent"];
  /**
   * The client and tokens as this flow last saw them. An invalidation removes
   * only these, never a value another flow wrote meanwhile.
   */
  private seen: { client?: string | undefined; tokens?: string | undefined } = {};
  /** How the last refresh this provider took part in failed, if it did. */
  private refreshFailure: RefreshFailure | undefined;
  /** The tokens this flow's issuer-aware read handed the SDK to refresh. */
  private refreshBasis: { accessToken: string; epoch: string; issuer: string } | undefined;
  /** The access token of a refresh the coordinator already stored. */
  private storedRefresh: string | undefined;

  constructor(
    private readonly connectorId: string,
    private readonly storage: KVStorage,
    private readonly redirectUri: string,
    private readonly refreshCoordinator?: OAuthRefreshCoordinator,
    private readonly allowAuthorization = true,
    /** Present when the deployment's vault can seal; the grant is then ciphertext. */
    private readonly sealer?: OAuthStateSealer,
    /** SDK hook ownership; renewal ignores it after claim submission. */
    private readonly signal?: AbortSignal,
    /** Stable connector configuration bound to dynamically registered clients. */
    private readonly clientBinding?: string,
    /** Request-local observer so the operator route drains every reset it began. */
    private readonly onReset?: (reset: Promise<void>) => void,
    /** SDK uses this only when the authorization server advertises support. */
    clientMetadataUrl?: string,
    private readonly scope?: string,
    /** Isolate-local clock, used only for claims that have never been sent. */
    private readonly refreshNow: () => number = Date.now,
    private readonly clientOptions?: {
      name?: string | undefined;
      client?: RemoteOAuthClient | undefined;
      secrets?: SentSecrets | undefined;
    },
  ) {
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
    const client = clientOptions?.client;
    if (client) this.addClientAuthentication = (headers, params) => authenticateRemoteClient(client, headers, params);
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const client = this.clientOptions?.client;
    return downstreamClientMetadata(
      this.redirectUri,
      this.scope,
      this.clientOptions?.name,
      client ? remoteClientAuthMethod(client) : "none",
    );
  }

  /** A preparation await owns no continuation after its call/request closes.
   * null explicitly selects coordinator/reset ownership, never the caller. */
  private wait<T>(work: () => Promise<T>, signal: AbortSignal | null | undefined = this.signal): Promise<T> {
    return runEdge(authOwnMethod<T>(KvOAuthProvider.prototype, this, "wait", [work, signal]));
  }

  /** Legacy helpers must fence their inner reads/deletes too, not just our join. */
  private preparationStorage(signal: AbortSignal | null | undefined): KVStorage {
    if (!signal) return this.storage;
    const storage = this.storage;
    return {
      ...storage,
      get: authMethod((key: string) => {
        return authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(storage, "get", [key]) as Effect.Effect<string | null, unknown>;
          }),
          signal,
        ]) as Effect.Effect<string | null, unknown>;
      }),
      list: authMethod((prefix: string) => {
        return authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(storage, "list", [prefix]) as Effect.Effect<string[], unknown>;
          }),
          signal,
        ]) as Effect.Effect<string[], unknown>;
      }),
      delete: authMethod((key: string) => {
        return authInvoke(this, "wait", [
          authMethod(() => {
            return authStorage(storage, "delete", [key]) as Effect.Effect<void, unknown>;
          }),
          signal,
        ]) as Effect.Effect<void, unknown>;
      }),
    };
  }

  // --- the grant record ---------------------------------------------------

  /** The grant's additional authenticated data: record and epoch. */
  private grantLabel(epoch: string): string {
    return `${GRANT}:${epoch}`;
  }

  private encodeGrant(grant: Grant, signal: AbortSignal | null | undefined = this.signal): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "encodeGrant", [grant, signal]));
  }

  /**
   * Open a stored grant. A body that does not open — tampered, under a
   * rotated key, moved from another connector, owner, or epoch, or sealed
   * with no sealer configured — reads as empty: authorization again.
   */
  private openGrant(raw: string | null, signal: AbortSignal | null | undefined = this.signal): Promise<Grant> {
    return runEdge(authOwnMethod<Grant>(KvOAuthProvider.prototype, this, "openGrant", [raw, signal]));
  }

  /**
   * The grant as stored now, migrating layout 2 on first sight. A plaintext
   * body, written before the vault could seal, is sealed where it lies by
   * compare-and-set; a failure leaves it readable for the next write to seal.
   */
  private readGrant(signal: AbortSignal | null | undefined = this.signal): Promise<{
    raw: string | null;
    grant: Grant;
  }> {
    return runEdge(
      authOwnMethod<{
        raw: string | null;
        grant: Grant;
      }>(KvOAuthProvider.prototype, this, "readGrant", [signal]),
    );
  }

  /** Layout 2 migration and its cleanup retain the reading operation's owner. */
  private migrate(signal: AbortSignal | null | undefined): Promise<string | null> {
    return runEdge(authOwnMethod<string | null>(KvOAuthProvider.prototype, this, "migrate", [signal]));
  }

  /** Deletion is retried on every read, including reads after a reset. */
  private cleanupV2(raw: string, signal: AbortSignal | null | undefined = this.signal): Promise<string | null> {
    return runEdge(authOwnMethod<string | null>(KvOAuthProvider.prototype, this, "cleanupV2", [raw, signal]));
  }

  /** The grant a bound flow reads: a replaced epoch fails it. */
  private boundGrant(signal: AbortSignal | null | undefined = this.signal): Promise<Grant> {
    return runEdge(authOwnMethod<Grant>(KvOAuthProvider.prototype, this, "boundGrant", [signal]));
  }

  /** SDK preparation is call/request-owned; coordinator reads explicitly opt out. */
  private activeGrant(): Promise<Grant> {
    return runEdge(authOwnMethod<Grant>(KvOAuthProvider.prototype, this, "activeGrant", []));
  }

  /**
   * The one way a grant changes: read, change, compare-and-set, again while
   * other writers win. The write belongs to `epoch` (default: the flow's,
   * captured now if unset) and lands nowhere once another is live: `quiet`
   * drops it silently, otherwise a bound flow fails as superseded. `commit`
   * writes after the request's abort too. `change` returning undefined
   * leaves the grant as it is.
   */
  private updateGrant(
    change: (grant: Grant) => Grant | undefined,
    options: {
      epoch?: string;
      quiet?: boolean;
      commit?: boolean;
      beforeWrite?: () => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    return runEdge(authOwnMethod<boolean>(KvOAuthProvider.prototype, this, "updateGrant", [change, options]));
  }

  /** Store a client or tokens for `issuer`'s grant, replacing another server's. */
  private writeCredential(
    field: "client" | "tokens",
    value: NonNullable<GrantBody["client"] | GrantBody["tokens"]>,
    issuer: string | undefined,
    refreshConsent?: GrantBody["refreshConsent"],
  ): Promise<void> {
    return runEdge(
      authOwnMethod<void>(KvOAuthProvider.prototype, this, "writeCredential", [field, value, issuer, refreshConsent]),
    );
  }

  private withIssuer(grant: Grant, body: GrantBody): Grant {
    if (grant.body.issuer !== undefined && grant.body.issuer !== body.issuer) {
      if (this.codeExchange) throw this.flowSuperseded();
      return {
        epoch: `${ACTIVE_EPOCH_PREFIX}${crypto.randomUUID()}`,
        ...(grant.cleanupPending ? { cleanupPending: true as const } : {}),
        body,
      };
    }
    return { ...grant, body };
  }

  /** Static clients bind to deployment configuration without storing secrets. */
  protected configuredAuthorizationBinding(): FlowBinding | undefined {
    return undefined;
  }

  private bindingForGrant(grant: Grant): Promise<FlowBinding> {
    return runEdge(authOwnMethod<FlowBinding>(KvOAuthProvider.prototype, this, "bindingForGrant", [grant]));
  }

  private checkFlowBinding(grant: Grant): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "checkFlowBinding", [grant]));
  }

  /** Validate RFC 9207 against the server this consent selected. */
  validateCallbackIssuer(issuer: string | null): void {
    if (
      !this.callback ||
      (issuer === null
        ? this.callback.flow.binding?.issRequired === true
        : issuer !== this.callback.flow.binding?.issuer)
    ) {
      throw new ConnectorCallError(
        "connector_call_failed",
        `Connector "${this.connectorId}" authorization callback issuer does not match its consent; nothing was exchanged.`,
      );
    }
  }

  // --- flow records ---------------------------------------------------------

  private flowLabel(key: string, epoch: string): string {
    return `${key}:${epoch}`;
  }

  private encodeFlow(key: string, flow: Flow): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "encodeFlow", [key, flow]));
  }

  /** A flow record, its verifier opened only when `withVerifier`. */
  private openFlow(key: string, raw: string, withVerifier: boolean): Promise<Flow | undefined> {
    return runEdge(
      authOwnMethod<Flow | undefined>(KvOAuthProvider.prototype, this, "openFlow", [key, raw, withVerifier]),
    );
  }

  /** The live epoch's latest consent, until a callback claims it. */
  private latestConsent(): Promise<
    | (Flow & {
        url: string;
      })
    | undefined
  > {
    return runEdge(
      authOwnMethod<
        | (Flow & {
            url: string;
          })
        | undefined
      >(KvOAuthProvider.prototype, this, "latestConsent", []),
    );
  }

  // --- flows and epochs -----------------------------------------------------

  /** The live epoch; an owner with no grant yet has the initial one. */
  liveEpoch(): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "liveEpoch", []));
  }

  /** True only after an operator disconnect, until an explicit start replaces it. */
  operatorDisconnected(): Promise<boolean> {
    return runEdge(authOwnMethod<boolean>(KvOAuthProvider.prototype, this, "operatorDisconnected", []));
  }

  isOperatorDisconnectedEpoch(epoch: string): boolean {
    return isDisconnectedEpoch(epoch);
  }

  /**
   * Begin a flow — a connect, whose 401 may refresh or start consent, or an
   * `api()` call or start — in the live epoch, and return it. Nothing about
   * the grant is decided here: a grant belongs to one server by construction.
   */
  beginFlow(): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "beginFlow", []));
  }

  /** The epoch this flow is bound to, or the live one. */
  flowEpoch(): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "flowEpoch", []));
  }

  /**
   * Bind a code exchange: to the epoch its verified consent was written in, or
   * the live one for an exchange no callback verified. An epoch already
   * replaced fails here, before the SDK can send anything. What the grant
   * holds now is all a refused code may invalidate.
   */
  bindFlow(): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "bindFlow", []));
  }

  /** Retain an already verified snapshot only for the exact same state. */
  verifyCallbackState(state: string): Promise<boolean> {
    return runEdge(authOwnMethod<boolean>(KvOAuthProvider.prototype, this, "verifyCallbackState", [state]));
  }

  /** Whether `verifyState` matched a consent on this provider. */
  verified(): boolean {
    return this.callback !== undefined;
  }

  /** The fixed, retryable failure of a flow a later reset superseded. */
  private flowSuperseded(): ConnectorCallError {
    return resendAdvice(
      new ConnectorCallError(
        "unavailable",
        `Connector "${this.connectorId}" authorization changed while this request was in flight.`,
      ),
      "; try again",
    );
  }

  /**
   * A credential write that storage refused, in fixed text and with no cause
   * attached. Retryable: the grant it held is untouched.
   */
  private credentialWriteError(): ConnectorCallError {
    return resendAdvice(
      new ConnectorCallError("unavailable", `Connector "${this.connectorId}" could not store its OAuth credentials.`),
      "; try again shortly",
    );
  }

  /** @internal Other requests kept refreshing faster than this one could join. */
  refreshContended(): ConnectorCallError {
    this.recordRefreshFailure({ kind: "contended" });
    return resendAdvice(
      new ConnectorCallError(
        "unavailable",
        `Connector "${this.connectorId}" could not refresh its OAuth grant while other requests were.`,
      ),
      "; retry",
    );
  }

  /**
   * A passive call cannot start consent. A waiter deadline remains retryable;
   * any dispatched failure requires consent because its token is spent.
   */
  private authorizationRefused(): Error {
    // The SDK catches a refresh cancellation and falls back to consent. Keep
    // the ended caller's own reason instead of turning it into an auth verdict.
    if (this.signal?.aborted) throw aborted(this.signal);
    const failure = this.refreshFailure;
    if (failure?.kind === "contended") return this.refreshContended();
    return new UnauthorizedError("Authorization required. Use authorize_connector or Connect to start consent.");
  }

  // --- the SDK's hooks --------------------------------------------------------

  clientInformation(ctx?: OAuthClientInformationContext): Promise<OAuthClientInformationMixed | undefined> {
    return runEdge(
      authOwnMethod<OAuthClientInformationMixed | undefined>(KvOAuthProvider.prototype, this, "clientInformation", [
        ctx,
      ]),
    );
  }

  saveClientInformation(info: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "saveClientInformation", [info, ctx]));
  }

  registrationPath(): Promise<"cimd" | "dcr" | "static" | undefined> {
    return runEdge(
      authOwnMethod<"cimd" | "dcr" | "static" | undefined>(KvOAuthProvider.prototype, this, "registrationPath", []),
    );
  }

  /** Intake and saved URLs share a guard. Include the current grant's secrets
   * so a fresh request can reject an older cache before sending credentials. */
  private assertCredentialFree(value: unknown, body: GrantBody, consentUrl = false): void {
    // OAuth intentionally puts its public client identity in consent. Exempt
    // only that parameter when it equals the bound/configured client, leaving
    // every other occurrence subject to the credential check. The URL itself
    // is never changed, only this matching view.
    if (consentUrl && typeof value === "string") {
      const url = new URL(value);
      const clientId =
        this.clientOptions?.client?.clientId ??
        body.client?.value.client_id ??
        this.configuredAuthorizationBinding()?.clientId;
      const ids = url.searchParams.getAll("client_id");
      if (clientId && ids.length === 1 && ids[0] === clientId) url.searchParams.delete("client_id");
      value = url.href;
    }
    const secrets = new SentSecrets();
    for (const value of [
      body.tokens?.access_token,
      body.tokens?.refresh_token,
      body.client?.value.client_secret,
      this.clientOptions?.client?.clientSecret,
    ]) {
      if (typeof value === "string") secrets.secret(value);
    }
    if (body.client?.value.client_secret) secrets.identifier(body.client.value.client_id);
    if (this.clientOptions?.client?.clientSecret) secrets.identifier(this.clientOptions.client.clientId);
    const urls: string[] = [];
    const collect = (item: unknown): void => {
      if (typeof item === "string") {
        try {
          urls.push(new URL(item).href);
        } catch {
          /* Not a URL field. */
        }
      } else if (item && typeof item === "object") for (const field of Object.values(item)) collect(field);
    };
    collect(value);
    if (
      [secrets, this.clientOptions?.secrets].some(
        (source) => source && (source.changes(value) || urls.some((url) => source.containsUrl(url))),
      )
    ) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "OAuth metadata or consent URL contains a credential; refusing authorization.",
        { retryable: false },
      );
    }
  }

  /** Only metadata bound to the discovered issuer can supply operator origins. */
  validatedIssuerOrigin(): Promise<string | undefined> {
    return runEdge(authOwnMethod<string | undefined>(KvOAuthProvider.prototype, this, "validatedIssuerOrigin", []));
  }

  discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return runEdge(
      authOwnMethod<OAuthDiscoveryState | undefined>(KvOAuthProvider.prototype, this, "discoveryState", []),
    );
  }

  /**
   * Discovery names the grant's server: the same one keeps the client and
   * tokens beside it, another replaces them. The SDK discovers afresh only
   * without a cached record — a restart's carried client, say — and what a
   * different server leaves behind would never be sent to it anyway.
   */
  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "saveDiscoveryState", [state]));
  }

  /**
   * The grant's tokens, for the server that issued them only. An
   * issuer-aware read records what it handed the SDK, so the coordinator can
   * tell a refresh another request completed since.
   */
  tokens(ctx?: OAuthClientInformationContext): Promise<OAuthTokens | undefined> {
    return runEdge(
      authOwnMethod<
        | {
            access_token: string;
            token_type: string;
            id_token?: string | undefined;
            expires_in?: number | undefined;
            scope?: string | undefined;
            refresh_token?: string | undefined;
            issuer?: string | undefined;
          }
        | undefined
      >(KvOAuthProvider.prototype, this, "tokens", [ctx]),
    );
  }

  saveTokens(tokens: OAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "saveTokens", [tokens, ctx]));
  }

  /**
   * OAuth `state`: 256 random bits the consent URL carries and the callback
   * must present, so nobody holding a consent URL can complete it with their
   * own account (login CSRF). Stored, by digest, with the consent.
   */
  state(): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "state", []));
  }

  saveCodeVerifier(verifier: string): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "saveCodeVerifier", [verifier]));
  }

  codeVerifier(): Promise<string> {
    return runEdge(authOwnMethod<string>(KvOAuthProvider.prototype, this, "codeVerifier", []));
  }

  /**
   * Store the consent: its flow record first, by state digest with the
   * link's lifetime, then the grant's pointer to it, in the flow's epoch. A
   * reset that replaced the epoch fails the start, and the record is removed,
   * so no start hands out a consent its callback could not complete.
   */
  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "redirectToAuthorization", [authorizationUrl]));
  }

  /** The consent this provider stored, while its epoch is still live. */
  consentUrl(signal: AbortSignal | undefined = this.signal): Promise<string | undefined> {
    return runEdge(authOwnMethod<string | undefined>(KvOAuthProvider.prototype, this, "consentUrl", [signal]));
  }

  /** The live epoch's pending consent URL, if one is unclaimed. */
  pendingAuthorizationUrl(): Promise<string | undefined> {
    return runEdge(authOwnMethod<string | undefined>(KvOAuthProvider.prototype, this, "pendingAuthorizationUrl", []));
  }

  /**
   * The pending consent URL, only while it is still worth handing out again:
   * unclaimed, written within PENDING_AUTHORIZATION_MAX_AGE_MS of now in
   * either direction (clock skew between isolates), and naming the grant's
   * client. A callback whose exchange the server refused with
   * `invalid_client` drops the client, and its URL would send the operator to
   * a consent the server has already refused.
   */
  reusablePendingAuthorizationUrl(): Promise<string | undefined> {
    return runEdge(
      authOwnMethod<string | undefined>(KvOAuthProvider.prototype, this, "reusablePendingAuthorizationUrl", []),
    );
  }

  /**
   * Find the consent a callback's `state` names. One read whatever the
   * answer; the callback route's refusals pay the same. A claimed consent
   * no longer matches.
   */
  verifyState(candidate: string | null): Promise<boolean> {
    return runEdge(authOwnMethod<boolean>(KvOAuthProvider.prototype, this, "verifyState", [candidate]));
  }

  /**
   * @internal The first half of the fence a code exchange crosses after every
   * read it depends on, just before the code leaves: claim the consent by
   * compare-and-set from the exact record `verifyState` found to a claimed
   * one. Of several callbacks carrying one state, exactly one wins; the
   * others send nothing. A claim that fails because a restart swept the
   * consent reports the supersession. The claim is spent whether or not the
   * exchange succeeds; the SDK's one retry after a refused code is answered
   * with that refusal, never sent again.
   */
  claimCodeExchange(): Promise<Response | undefined> {
    return runEdge(authOwnMethod<Response | undefined>(KvOAuthProvider.prototype, this, "claimCodeExchange", []));
  }

  /** Terminate the verified consent on an error, sharing the code exchange CAS. */
  consumeAuthError(): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "consumeAuthError", []));
  }

  private claimConsent(): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "claimConsent", []));
  }

  /**
   * @internal The second half: read the live epoch and, in the reaction to
   * that read, dispatch. No await stands between the check and `send`. A
   * reset published at or before the read fails the exchange with nothing
   * sent; one published after it, while the request is leaving, cannot be
   * ordered before the send without a lock across requests, and its tokens
   * are refused by the grant's compare-and-set: one more consent.
   */
  dispatchCodeExchange(send: () => Promise<Response>, endpoint?: string | URL): Promise<Response> {
    return runEdge(authOwnMethod<Response>(KvOAuthProvider.prototype, this, "dispatchCodeExchange", [send, endpoint]));
  }

  /** @internal Keep a refused code's answer for the SDK's retry to read. */
  recordCodeExchangeRefusal(forSdk: Response): void {
    this.exchangeRefusal = forSdk.clone();
  }

  /** @internal Observe resolution while accepting the code response, never on a later SDK save. */
  recordCodeExchangeTokens(tokens: OAuthTokens): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "recordCodeExchangeTokens", [tokens]));
  }

  /**
   * Remove what the SDK asks, but only as this flow saw it: a refused code or
   * refresh says nothing about a client or tokens another flow wrote since.
   * The verifier lives in its consent, which the claim already spent.
   */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "invalidateCredentials", [scope]));
  }

  // --- refresh, for the coordinator ---------------------------------------------

  /**
   * @internal How the refresh this provider owned or joined failed; undefined
   * clears it. The hooks the SDK calls next (`state`, `saveCodeVerifier`,
   * `redirectToAuthorization`, `invalidateCredentials`, `saveTokens`) read it.
   */
  recordRefreshFailure(failure: RefreshFailure | undefined): void {
    this.refreshFailure = failure;
  }

  /** @internal A shared-storage claim precedes every refresh dispatch. */
  claimRefresh(
    epoch: string,
    requested: string | null,
    signal?: AbortSignal,
    sharedWait?: RefreshWait,
  ): Promise<RefreshLease | Response> {
    return runEdge(
      authOwnMethod<Response | RefreshLease>(KvOAuthProvider.prototype, this, "claimRefresh", [
        epoch,
        requested,
        signal,
        sharedWait,
      ]),
    );
  }

  /** @internal Only the successful claimed-to-dispatched CAS may send. */
  dispatchRefresh(lease: RefreshLease, send: () => Promise<Response>, waiting: RefreshWait): Promise<Response> {
    return runEdge(authOwnMethod<Response>(KvOAuthProvider.prototype, this, "dispatchRefresh", [lease, send, waiting]));
  }

  /** @internal Release by CAS after a commit or a classified failure. */
  releaseRefresh(
    lease: RefreshLease,
    verdict?: RefreshFailure,
    tokens?: OAuthTokens,
    resolution: "resolved" | "ambiguous" = "ambiguous",
  ): Promise<void> {
    return runEdge(
      authOwnMethod<void>(KvOAuthProvider.prototype, this, "releaseRefresh", [lease, verdict, tokens, resolution]),
    );
  }

  private resolveRefreshSpent(lease: RefreshLease, state: "resolved" | "ambiguous"): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "resolveRefreshSpent", [lease, state]));
  }

  /** @internal The same typed verdict for local and cross-isolate joiners. */
  refreshVerdict(): RefreshFailure | undefined {
    return this.refreshFailure;
  }

  /** @internal The grant's tokens as stored, in the flow's epoch. */
  storedTokens(signal: AbortSignal | null = null): Promise<OAuthTokens | undefined> {
    return runEdge(
      authOwnMethod<
        | {
            access_token: string;
            token_type: string;
            id_token?: string | undefined;
            expires_in?: number | undefined;
            scope?: string | undefined;
            refresh_token?: string | undefined;
            issuer?: string | undefined;
          }
        | undefined
      >(KvOAuthProvider.prototype, this, "storedTokens", [signal]),
    );
  }

  /** @internal True when a refresh landed after this flow's issuer-aware read. */
  refreshedSinceRead(current: OAuthTokens, epoch: string): boolean {
    const basis = this.refreshBasis;
    return basis !== undefined && basis.epoch === epoch && basis.accessToken !== current.access_token;
  }

  /** @internal The issuer this flow's issuer-aware read bound its refresh to. */
  refreshIssuer(epoch: string): string | undefined {
    const basis = this.refreshBasis;
    return basis?.epoch === epoch ? basis.issuer : undefined;
  }

  /** @internal Hand the SDK tokens already stored, so its save is not repeated. */
  adoptRefresh(tokens: OAuthTokens): Response {
    this.storedRefresh = tokens.access_token;
    return tokenResponse(tokens);
  }

  /**
   * @internal Store an accepted rotation in `epoch`, even after the request
   * that redeemed it has left, unless a newer rotation, another server's
   * grant, or another epoch is there now. A token response names no issuer:
   * the one the refreshed grant was bound to is stamped here.
   */
  storeRefresh(
    epoch: string,
    requested: string | null,
    tokens: OAuthTokens,
    issuer: string | undefined,
  ): Promise<OAuthTokens | undefined> {
    return runEdge(
      authOwnMethod<
        | {
            access_token: string;
            token_type: string;
            id_token?: string | undefined;
            expires_in?: number | undefined;
            scope?: string | undefined;
            refresh_token?: string | undefined;
            issuer?: string | undefined;
          }
        | undefined
      >(KvOAuthProvider.prototype, this, "storeRefresh", [epoch, requested, tokens, issuer]),
    );
  }

  /**
   * @internal Drop the tokens the authorization server just refused, only
   * while the grant still holds that refresh token in `epoch`: a consent
   * that completed meanwhile survives. Best effort: if storage fails, the
   * next refresh is refused again and ends the same way.
   */
  discardRefusedGrant(
    refreshToken: string | null,
    epoch: string,
    beforeWrite?: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return runEdge(
      authOwnMethod<void>(KvOAuthProvider.prototype, this, "discardRefusedGrant", [
        refreshToken,
        epoch,
        beforeWrite,
        signal,
      ]),
    );
  }

  // --- restart and disconnect ---------------------------------------------------

  /**
   * Replace the epoch, by one compare-and-set: the grant goes with it, and
   * every flow bound to the old epoch fails at its next read or write. A
   * forced restart may carry the registration forward (`carriableClient`);
   * a disconnect leaves only its epoch, which no passive request leaves.
   * Then the old epochs' consents are removed; that is hygiene, since their
   * callbacks fail the epoch check anyway and the records expire.
   */
  resetAuthorization(operatorDisconnected = false, preserveClient = false): Promise<void> {
    return runEdge(
      authOwnMethod<void>(KvOAuthProvider.prototype, this, "resetAuthorization", [
        operatorDisconnected,
        preserveClient,
      ]),
    );
  }

  /** Remove the local grant before a bounded, best-effort RFC 7009 request. */
  disconnectAuthorization(send: FetchLike): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "disconnectAuthorization", [send]));
  }

  private performReset(operatorDisconnected: boolean, preserveClient: boolean, revoke?: FetchLike): Promise<void> {
    return runEdge(
      authOwnMethod<void>(KvOAuthProvider.prototype, this, "performReset", [
        operatorDisconnected,
        preserveClient,
        revoke,
      ]),
    );
  }

  /**
   * Remove every consent of an epoch no longer live. The records are read
   * before the epoch, and epochs never recur, so a consent whose epoch is not
   * the live one then can never complete; each goes by compare-and-set
   * against what was read. Best effort.
   */
  private sweepConsents(): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "sweepConsents", []));
  }

  private sweepRefreshLeases(): Promise<void> {
    return runEdge(authOwnMethod<void>(KvOAuthProvider.prototype, this, "sweepRefreshLeases", []));
  }

  /**
   * The registration a forced restart may carry into its new epoch, or
   * nothing. It must be bound to a server (`issuer`) and registered under this
   * connector's exact configuration, redirect URI, and client metadata
   * (`binding`), in this owner's own grant. Never carried:
   *
   * - A URL-based client (`clientMetadataUrl`): nothing was registered, and
   *   leaving it behind makes the SDK ask fresh metadata whether the server
   *   still accepts one.
   * - One whose `client_secret_expires_at` has passed (RFC 7591: zero means
   *   never).
   * - One a previous restart carried that has not since earned tokens. The
   *   SDK builds a consent URL locally and sends nothing that could answer
   *   `invalid_client`, and RFC 6749 section 4.1.2.1 forbids redirecting an
   *   unknown client to the callback, so tokens are the only proof the server
   *   still knows it. Without them the next restart registers again.
   */
  private carriableClient(grant: Grant): GrantBody | undefined {
    const { issuer, client, tokens } = grant.body;
    const clientId: unknown = client?.value.client_id;
    const expiresAt: unknown = client?.value.client_secret_expires_at;
    if (
      !this.clientBinding ||
      issuer === undefined ||
      !client ||
      client.binding !== this.clientBinding ||
      typeof clientId !== "string" ||
      client.registrationPath === "cimd" ||
      client.registrationPath === "static" ||
      // Legacy records have no mechanism field: retain their conservative
      // URL-client refusal, but never reinterpret a recorded DCR identity.
      (client.registrationPath === undefined && clientId === this.clientMetadataUrl) ||
      this.clientOptions?.client !== undefined ||
      (typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1000 <= Date.now()) ||
      (client.carried && !tokens)
    ) {
      return undefined;
    }
    return {
      issuer,
      client: {
        value: client.value,
        binding: client.binding,
        carried: true,
        ...(client.registrationPath ? { registrationPath: client.registrationPath } : {}),
      },
    };
  }

  static {
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "wait",
      function <T>(this: KvOAuthProvider, work: () => Promise<T>, signal: AbortSignal | null | undefined) {
        signal = signal === undefined ? this.signal : signal;
        return authFlow<T>(function* () {
          if (signal?.aborted) throw aborted(signal);
          const value = signal
            ? ((yield authAwait(authCall<T>(work, []), { signal }.signal)) as Awaited<T>)
            : ((yield authCall(work, [])) as Awaited<T>);
          if (signal?.aborted) throw aborted(signal);
          return value;
        });
      },
      KvOAuthProvider.prototype.wait,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "encodeGrant",
      function (this: KvOAuthProvider, grant: Grant, signal: AbortSignal | null | undefined) {
        signal = signal === undefined ? this.signal : signal;

        return authFlow<string>(
          function* (this: KvOAuthProvider) {
            this.assertCredentialFree({ issuer: grant.body.issuer, discovery: grant.body.discovery }, grant.body);
            const stored: StoredGrant = {
              connectaOAuth: GRANT_VERSION,
              epoch: grant.epoch,
              ...(grant.cleanupPending ? { cleanupPending: true as const } : {}),
              ...(grant.flow !== undefined ? { flow: grant.flow } : {}),
            };
            if (Object.keys(grant.body).length > 0) {
              if (this.sealer) {
                stored.sealed = (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authInvoke(this.sealer!, "seal", [
                      this.grantLabel(grant.epoch),
                      JSON.stringify(grant.body),
                    ]) as Effect.Effect<string, unknown>;
                  }),
                  signal,
                ])) as string;
              } else {
                stored.body = grant.body;
              }
            }
            return JSON.stringify(stored);
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.encodeGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "openGrant",
      function (this: KvOAuthProvider, raw: string | null, signal: AbortSignal | null | undefined) {
        signal = signal === undefined ? this.signal : signal;

        return authFlow<Grant>(
          function* (this: KvOAuthProvider) {
            if (raw === null) return { epoch: INITIAL_EPOCH, body: {} };
            const stored = storedGrant(raw);
            if (!stored) return { epoch: UNREADABLE_EPOCH, body: {} };
            let body: unknown = stored.body;
            if (stored.sealed !== undefined) {
              body = undefined;
              try {
                if (this.sealer)
                  body = parsed(
                    (yield authInvoke(this, "wait", [
                      authMethod(() => {
                        return authInvoke(this.sealer!, "open", [
                          this.grantLabel(stored.epoch),
                          stored.sealed!,
                        ]) as Effect.Effect<string, unknown>;
                      }),
                      signal,
                    ])) as string,
                  );
              } catch {
                if (signal?.aborted) throw aborted(signal);
                this.sealer?.warn(
                  `[connecta] connector "${this.connectorId}" has a sealed OAuth grant ` +
                    "the configured vault cannot open; treating it as absent, so the " +
                    "connector needs authorization again. A changed vault key or " +
                    "tampered storage causes this.",
                );
              }
            }
            return {
              epoch: stored.epoch,
              ...(stored.cleanupPending ? { cleanupPending: true as const } : {}),
              ...(stored.flow !== undefined ? { flow: stored.flow } : {}),
              body: grantBody(body),
            };
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.openGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "readGrant",
      function (this: KvOAuthProvider, signal: AbortSignal | null | undefined) {
        signal = signal === undefined ? this.signal : signal;

        return authFlow<{ raw: string | null; grant: Grant }>(
          function* (this: KvOAuthProvider) {
            let raw = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
              }),
              signal,
            ])) as string | null;
            if (raw === null) raw = (yield authInvoke(this, "migrate", [signal])) as string | null;
            if (raw !== null && storedGrant(raw)?.cleanupPending)
              raw = (yield authInvoke(this, "cleanupV2", [raw, signal])) as string | null;
            const grant = (yield authInvoke(this, "openGrant", [raw, signal])) as Grant;
            if (raw !== null && this.sealer && storedGrant(raw)?.body !== undefined) {
              const sealed = (yield authInvoke(this, "encodeGrant", [grant, signal])) as string;
              if (
                (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authCatch(
                      authStorage(this.storage, "compareAndSet", [GRANT, raw, sealed]),
                      () => false,
                    ) as Effect.Effect<boolean, unknown>;
                  }),
                  signal,
                ])) as boolean
              )
                raw = sealed;
            }
            return { raw, grant };
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.readGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "migrate",
      function (this: KvOAuthProvider, signal: AbortSignal | null | undefined) {
        return authFlow<string | null>(
          function* (this: KvOAuthProvider) {
            const sealer = this.sealer;
            const found = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authCall(readV2Grant, [
                  this.preparationStorage(signal),
                  sealer && {
                    ...sealer,
                    open: authMethod((label: string, value: string) => {
                      return authInvoke(this, "wait", [
                        authMethod(() => {
                          return authInvoke(sealer, "open", [label, value]) as Effect.Effect<string, unknown>;
                        }),
                        signal,
                      ]) as Effect.Effect<string, unknown>;
                    }),
                  },
                ]) as Effect.Effect<MigratedGrant | undefined, unknown>;
              }),
              signal,
            ])) as MigratedGrant | undefined;
            if (!found) return null;
            const prefix = found.disconnected ? DISCONNECTED_EPOCH_PREFIX : ACTIVE_EPOCH_PREFIX;
            const encoded = (yield authInvoke(this, "encodeGrant", [
              {
                epoch: `${prefix}${crypto.randomUUID()}`,
                body: found.body,
                cleanupPending: true,
              },
              signal,
            ])) as string;
            let written: boolean;
            try {
              written = (yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authStorage(this.storage, "compareAndSet", [GRANT, null, encoded]) as Effect.Effect<
                    boolean,
                    unknown
                  >;
                }),
                signal,
              ])) as boolean;
            } catch {
              if (signal?.aborted) throw aborted(signal);
              throw this.credentialWriteError();
            }
            return (yield written
              ? authValue(() => encoded)
              : authInvoke(this, "wait", [
                  authMethod(() => {
                    return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
                  }),
                  signal,
                ])) as string | null;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.migrate,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "cleanupV2",
      function (this: KvOAuthProvider, raw: string, signal: AbortSignal | null | undefined) {
        signal = signal === undefined ? this.signal : signal;

        return authFlow<string | null>(
          function* (this: KvOAuthProvider) {
            try {
              if (
                !((yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authCall(deleteV2Keys, [this.preparationStorage(signal)]) as Effect.Effect<boolean, unknown>;
                  }),
                  signal,
                ])) as boolean)
              )
                return raw;
              const grant = (yield authInvoke(this, "openGrant", [raw, signal])) as Grant;
              delete grant.cleanupPending;
              const cleared = (yield authInvoke(this, "encodeGrant", [grant, signal])) as string;
              if (
                (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authStorage(this.storage, "compareAndSet", [GRANT, raw, cleared]) as Effect.Effect<
                      boolean,
                      unknown
                    >;
                  }),
                  signal,
                ])) as boolean
              )
                return cleared;
              return (yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
                }),
                signal,
              ])) as string | null;
            } catch {
              if (signal?.aborted) throw aborted(signal);
              return raw;
            }
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.cleanupV2,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "boundGrant",
      function (this: KvOAuthProvider, signal: AbortSignal | null | undefined) {
        signal = signal === undefined ? this.signal : signal;

        return authFlow<Grant>(
          function* (this: KvOAuthProvider) {
            const { grant } = (yield authInvoke(this, "readGrant", [signal])) as {
              raw: string | null;
              grant: Grant;
            };
            if (this.bound && grant.epoch !== this.epoch) throw this.flowSuperseded();
            return grant;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.boundGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "activeGrant",
      function (this: KvOAuthProvider) {
        return authInvoke(this, "boundGrant", []) as Effect.Effect<Grant, unknown>;
      },
      KvOAuthProvider.prototype.activeGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "updateGrant",
      function (
        this: KvOAuthProvider,
        change: (grant: Grant) => Grant | undefined,
        options: {
          epoch?: string;
          quiet?: boolean;
          commit?: boolean;
          beforeWrite?: () => void;
          signal?: AbortSignal;
        } = {},
      ) {
        return authFlow<boolean>(
          function* (this: KvOAuthProvider) {
            const signal = options.signal ?? (options.commit ? null : this.signal);
            for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
              if (!options.commit && this.signal?.aborted) return false;
              const { raw, grant } = (yield authInvoke(this, "readGrant", [signal])) as {
                raw: string | null;
                grant: Grant;
              };
              const epoch = options.epoch ?? (this.epoch ??= grant.epoch);
              if (grant.epoch !== epoch) {
                if (options.quiet || !this.bound) return false;
                throw this.flowSuperseded();
              }
              if (isDisconnectedEpoch(epoch)) return false;
              const next = change(grant);
              if (next === undefined) return true;
              const encoded = (yield authInvoke(this, "encodeGrant", [next, signal])) as string;
              if (!options.commit && this.signal?.aborted) return false;
              let written: boolean;
              try {
                written = (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authStorage<boolean>(
                      this.storage,
                      "compareAndSet",
                      [GRANT, raw, encoded],
                      options.beforeWrite && (() => options.beforeWrite?.()),
                    );
                  }),
                  signal,
                ])) as boolean;
              } catch {
                if (signal?.aborted) throw aborted(signal);
                throw this.credentialWriteError();
              }
              if (written) {
                if (next.epoch !== grant.epoch) this.epoch = next.epoch;
                return true;
              }
            }
            throw this.credentialWriteError();
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.updateGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "writeCredential",
      function (
        this: KvOAuthProvider,
        field: "client" | "tokens",
        value: NonNullable<GrantBody["client"] | GrantBody["tokens"]>,
        issuer: string | undefined,
        refreshConsent?: GrantBody["refreshConsent"],
      ) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            (yield authInvoke(this, "updateGrant", [
              (grant: Grant) => {
                const body: GrantBody =
                  issuer !== undefined && grant.body.issuer !== issuer ? { issuer } : { ...grant.body };
                if (field === "client") body.client = value as NonNullable<GrantBody["client"]>;
                else {
                  body.tokens = value as OAuthTokens;
                  delete body.refreshConsent;
                  if (refreshConsent) body.refreshConsent = refreshConsent;
                }
                return this.withIssuer(grant, body);
              },
            ])) as boolean;
            this.seen[field] = fingerprint(
              field === "client" ? (value as NonNullable<GrantBody["client"]>).value : value,
            );
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.writeCredential,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "bindingForGrant",
      function (this: KvOAuthProvider, grant: Grant) {
        return authFlow<FlowBinding>(
          function* (this: KvOAuthProvider) {
            const configured = this.configuredAuthorizationBinding();
            return configured
              ? { ...configured, issuer: grant.body.issuer }
              : {
                  ...((yield authInvoke(this, "wait", [
                    authMethod(() => {
                      return authCall(discoveryBinding, [grant.body.discovery]) as Effect.Effect<FlowBinding, unknown>;
                    }),
                  ])) as FlowBinding),
                  issuer: grant.body.issuer,
                  clientId: grant.body.client?.value.client_id,
                };
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.bindingForGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "checkFlowBinding",
      function (this: KvOAuthProvider, grant: Grant) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const binding = this.callback?.flow.binding;
            if (
              !binding ||
              fingerprint(binding) !== fingerprint((yield authInvoke(this, "bindingForGrant", [grant])) as FlowBinding)
            ) {
              throw this.flowSuperseded();
            }
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.checkFlowBinding,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "encodeFlow",
      function (this: KvOAuthProvider, key: string, flow: Flow) {
        return authFlow<string>(
          function* (this: KvOAuthProvider) {
            const { verifier, ...rest } = flow;
            const stored: StoredFlow = { connectaOAuthFlow: FLOW_VERSION, ...rest };
            if (verifier !== undefined) {
              if (this.sealer) {
                stored.verifier = (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authInvoke(this.sealer!, "seal", [
                      this.flowLabel(key, flow.epoch),
                      verifier,
                    ]) as Effect.Effect<string, unknown>;
                  }),
                ])) as string;
                stored.sealed = true;
              } else {
                stored.verifier = verifier;
              }
            }
            return JSON.stringify(stored);
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.encodeFlow,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "openFlow",
      function (this: KvOAuthProvider, key: string, raw: string, withVerifier: boolean) {
        return authFlow<Flow | undefined>(
          function* (this: KvOAuthProvider) {
            const value = parsed(raw);
            if (
              !plainObject(value) ||
              value.connectaOAuthFlow !== FLOW_VERSION ||
              typeof value.epoch !== "string" ||
              typeof value.at !== "number" ||
              (value.url !== undefined && typeof value.url !== "string") ||
              (value.verifier !== undefined && typeof value.verifier !== "string")
            ) {
              return undefined;
            }
            const flow: Flow = {
              epoch: value.epoch,
              at: value.at,
              ...(plainObject(value.binding) ? { binding: value.binding as FlowBinding } : {}),
              ...(typeof value.url === "string" ? { url: value.url } : {}),
              ...(value.consumed === true ? { consumed: true as const } : {}),
            };
            if (!withVerifier || typeof value.verifier !== "string") return flow;
            if (value.sealed !== true) return { ...flow, verifier: value.verifier };
            try {
              if (!this.sealer) return undefined;
              return {
                ...flow,
                verifier: (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authInvoke(this.sealer!, "open", [
                      this.flowLabel(key, flow.epoch),
                      value.verifier as string,
                    ]) as Effect.Effect<string, unknown>;
                  }),
                ])) as string,
              };
            } catch {
              if (this.signal?.aborted) throw aborted(this.signal);
              this.sealer?.warn(
                `[connecta] connector "${this.connectorId}" has a sealed OAuth consent ` +
                  "the configured vault cannot open; its callback is refused.",
              );
              return undefined;
            }
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.openFlow,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "latestConsent",
      function (this: KvOAuthProvider) {
        return authFlow<(Flow & { url: string }) | undefined>(
          function* (this: KvOAuthProvider) {
            const grant = (yield authInvoke(this, "boundGrant", [])) as Grant;
            if (grant.flow === undefined) return undefined;
            const key = oauthFlowKeys.flow(grant.flow);
            const raw = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage(this.storage, "get", [key]) as Effect.Effect<string | null, unknown>;
              }),
            ])) as string | null;
            const flow =
              raw === null ? undefined : ((yield authInvoke(this, "openFlow", [key, raw, false])) as Flow | undefined);
            return flow && !flow.consumed && flow.epoch === grant.epoch && flow.url !== undefined
              ? { ...flow, url: flow.url }
              : undefined;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.latestConsent,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "liveEpoch",
      function (this: KvOAuthProvider) {
        return authFlow<string>(
          function* (this: KvOAuthProvider) {
            return (
              (yield authInvoke(this, "readGrant", [])) as {
                raw: string | null;
                grant: Grant;
              }
            ).grant.epoch;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.liveEpoch,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "operatorDisconnected",
      function (this: KvOAuthProvider) {
        return authFlow<boolean>(
          function* (this: KvOAuthProvider) {
            return isDisconnectedEpoch((yield authInvoke(this, "liveEpoch", [])) as string);
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.operatorDisconnected,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "beginFlow",
      function (this: KvOAuthProvider) {
        return authFlow<string>(
          function* (this: KvOAuthProvider) {
            const epoch = (yield authInvoke(this, "liveEpoch", [])) as string;
            this.epoch = epoch;
            this.bound = true;
            return epoch;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.beginFlow,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "flowEpoch",
      function (this: KvOAuthProvider) {
        return authFlow<string>(
          function* (this: KvOAuthProvider) {
            return this.epoch ?? ((yield authInvoke(this, "liveEpoch", [])) as string);
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.flowEpoch,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "bindFlow",
      function (this: KvOAuthProvider) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const { grant } = (yield authInvoke(this, "readGrant", [])) as {
              raw: string | null;
              grant: Grant;
            };
            const epoch = this.callback?.flow.epoch ?? this.epoch ?? grant.epoch;
            if (grant.epoch !== epoch) throw this.flowSuperseded();
            this.epoch = epoch;
            this.bound = true;
            this.codeExchange = true;
            (yield authInvoke(this, "checkFlowBinding", [grant])) as void;
            this.seen = {
              client: fingerprint(grant.body.client?.value),
              tokens: fingerprint(grant.body.tokens),
            };
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.bindFlow,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "verifyCallbackState",
      function (this: KvOAuthProvider, state: string) {
        return authFlow<boolean>(
          function* (this: KvOAuthProvider) {
            if (
              this.callback?.key ===
              oauthFlowKeys.flow(
                (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authCall(oauthStateDigest, [state]) as Effect.Effect<string, unknown>;
                  }),
                ])) as string,
              )
            )
              return true;
            return (yield authInvoke(this, "verifyState", [state])) as boolean;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.verifyCallbackState,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "clientInformation",
      function (this: KvOAuthProvider, ctx?: OAuthClientInformationContext) {
        return authFlow<OAuthClientInformationMixed | undefined>(
          function* (this: KvOAuthProvider) {
            if (this.signal?.aborted) throw aborted(this.signal);
            const { body } = (yield authInvoke(this, "activeGrant", [])) as Grant;
            if (this.signal?.aborted) throw aborted(this.signal);
            const client = this.clientOptions?.client;
            if (!body.client && !this.allowAuthorization) throw this.authorizationRefused();
            if (client) {
              if ((ctx && ctx.issuer !== client.issuer) || body.issuer !== client.issuer) throw this.flowSuperseded();
              if (
                body.client &&
                (body.client.value.client_id !== client.clientId || body.client.binding !== this.clientBinding)
              )
                throw this.flowSuperseded();
              return {
                client_id: client.clientId,
                issuer: client.issuer,
                token_endpoint_auth_method: this.clientMetadata.token_endpoint_auth_method,
                ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}),
              };
            }
            if (!body.client || (ctx && body.issuer !== ctx.issuer)) return undefined;
            this.seen.client = fingerprint(body.client.value);
            return ctx ? { ...body.client.value, issuer: ctx.issuer } : body.client.value;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.clientInformation,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "saveClientInformation",
      function (this: KvOAuthProvider, info: OAuthClientInformationMixed, ctx?: OAuthClientInformationContext) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            try {
              const { body } = (yield authInvoke(this, "boundGrant", [])) as Grant;
              const registrationPath = this.clientOptions?.client
                ? "static"
                : body.client?.value.client_id === info.client_id && body.client.registrationPath
                  ? body.client.registrationPath
                  : this.clientMetadataUrl &&
                      body.discovery?.authorizationServerMetadata?.client_id_metadata_document_supported === true
                    ? "cimd"
                    : "dcr";
              (yield authInvoke(this, "writeCredential", [
                "client",
                {
                  value: this.clientOptions?.client ? { client_id: this.clientOptions.client.clientId } : info,
                  registrationPath,
                  ...(this.clientBinding !== undefined ? { binding: this.clientBinding } : {}),
                },
                ctx?.issuer,
              ])) as void;
            } catch (error) {
              if (!this.signal?.aborted) throw error;
            }
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.saveClientInformation,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "registrationPath",
      function (this: KvOAuthProvider) {
        return authFlow<"cimd" | "dcr" | "static" | undefined>(
          function* (this: KvOAuthProvider) {
            const { body } = (yield authInvoke(this, "boundGrant", [])) as Grant;
            return body.client?.registrationPath;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.registrationPath,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "validatedIssuerOrigin",
      function (this: KvOAuthProvider) {
        return authFlow<string | undefined>(
          function* (this: KvOAuthProvider) {
            const { body } = (yield authInvoke(this, "boundGrant", [])) as Grant;
            const state = body.discovery;
            if (
              !state ||
              state.authorizationServerMetadata?.issuer !== state.authorizationServerUrl ||
              body.issuer !== state.authorizationServerUrl
            )
              return undefined;
            this.assertCredentialFree(state, body);
            return new URL(state.authorizationServerUrl).origin;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.validatedIssuerOrigin,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "discoveryState",
      function (this: KvOAuthProvider) {
        return authFlow<OAuthDiscoveryState | undefined>(
          function* (this: KvOAuthProvider) {
            if (this.signal?.aborted) throw aborted(this.signal);
            const { body } = (yield authInvoke(this, "activeGrant", [])) as Grant;
            if (this.signal?.aborted) throw aborted(this.signal);
            const state = body.discovery;
            this.assertCredentialFree(state, body);
            this.consentDiscovery = state;
            return state;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.discoveryState,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "saveDiscoveryState",
      function (this: KvOAuthProvider, state: OAuthDiscoveryState) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            this.assertCredentialFree(state, ((yield authInvoke(this, "boundGrant", [])) as Grant).body);
            const issuer = discoveryIssuer(state);
            if (this.clientOptions?.client && issuer !== this.clientOptions.client.issuer) throw this.flowSuperseded();
            if (!this.allowAuthorization && !((yield authInvoke(this, "boundGrant", [])) as Grant).body.client)
              throw this.authorizationRefused();
            this.consentDiscovery = state;
            (yield authInvoke(this, "updateGrant", [
              (grant: Grant) => {
                const body: GrantBody =
                  grant.body.issuer !== issuer ? (issuer !== undefined ? { issuer } : {}) : { ...grant.body };
                this.assertCredentialFree(state, grant.body);
                body.discovery = state;
                return this.withIssuer(grant, body);
              },
            ])) as boolean;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.saveDiscoveryState,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "tokens",
      function (this: KvOAuthProvider, ctx?: OAuthClientInformationContext) {
        return authFlow<
          | {
              access_token: string;
              token_type: string;
              id_token?: string | undefined;
              expires_in?: number | undefined;
              scope?: string | undefined;
              refresh_token?: string | undefined;
              issuer?: string | undefined;
            }
          | undefined
        >(
          function* (this: KvOAuthProvider) {
            if (this.signal?.aborted) throw aborted(this.signal);
            const grant = (yield authInvoke(this, "activeGrant", [])) as Grant;
            if (this.signal?.aborted) throw aborted(this.signal);
            const { tokens } = grant.body;
            if (!tokens || (ctx && grant.body.issuer !== ctx.issuer)) return undefined;
            this.seen.tokens = fingerprint(tokens);
            if (!ctx) return tokens;
            this.refreshBasis = { accessToken: tokens.access_token, epoch: grant.epoch, issuer: ctx.issuer };
            return { ...tokens, issuer: ctx.issuer };
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.tokens,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "saveTokens",
      function (this: KvOAuthProvider, tokens: OAuthTokens, ctx?: OAuthClientInformationContext) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            if (this.signal?.aborted) throw aborted(this.signal);
            if (this.refreshFailure?.kind === "dead") throw this.authorizationRefused();
            if (this.storedRefresh !== undefined && tokens.access_token === this.storedRefresh) return;
            const refreshConsent =
              this.exchangeConsent &&
              tokens.refresh_token !== undefined &&
              this.exchangeConsent.digest ===
                ((yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authCall(oauthStateDigest, [tokens.refresh_token!]) as Effect.Effect<string, unknown>;
                  }),
                ])) as string)
                ? this.exchangeConsent
                : undefined;
            (yield authInvoke(this, "writeCredential", ["tokens", tokens, ctx?.issuer, refreshConsent])) as void;
            this.refreshFailure = undefined;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.saveTokens,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "state",
      function (this: KvOAuthProvider) {
        return authValue<string>(() => {
          if (!this.allowAuthorization) throw this.authorizationRefused();
          const state = randomState();
          this.consent = { state };
          return state;
        });
      },
      KvOAuthProvider.prototype.state,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "saveCodeVerifier",
      function (this: KvOAuthProvider, verifier: string) {
        return authValue<void>(() => {
          if (this.signal?.aborted) throw aborted(this.signal);
          if (!this.allowAuthorization) throw this.authorizationRefused();
          this.consent = { ...this.consent, verifier };
        });
      },
      KvOAuthProvider.prototype.saveCodeVerifier,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "codeVerifier",
      function (this: KvOAuthProvider) {
        return authValue<string>(() => {
          const verifier = this.callback?.flow.verifier ?? this.consent.verifier;
          if (verifier === undefined) {
            throw new Error(`No PKCE code verifier for "${this.connectorId}"`);
          }
          return verifier;
        });
      },
      KvOAuthProvider.prototype.codeVerifier,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "redirectToAuthorization",
      function (this: KvOAuthProvider, authorizationUrl: URL) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            if (this.signal?.aborted) return;
            if (!this.allowAuthorization) throw this.authorizationRefused();
            this.assertCredentialFree(
              authorizationUrl.toString(),
              ((yield authInvoke(this, "boundGrant", [])) as Grant).body,
              true,
            );
            const state = this.consent.state ?? authorizationUrl.searchParams.get("state");
            if (!state) throw new Error(`OAuth consent for "${this.connectorId}" carries no state`);
            const client = this.clientOptions?.client;
            if (client && !((yield authInvoke(this, "boundGrant", [])) as Grant).body.client) {
              (yield authInvoke(this, "saveClientInformation", [
                { client_id: client.clientId },
                { issuer: client.issuer },
              ])) as void;
            }
            const configured = this.configuredAuthorizationBinding();
            if (configured?.issuer !== undefined) {
              const issuer = configured.issuer;
              (yield authInvoke(this, "updateGrant", [
                (grant: Grant) => (grant.body.issuer === issuer ? undefined : this.withIssuer(grant, { issuer })),
              ])) as boolean;
            }
            const epoch = (yield authInvoke(this, "flowEpoch", [])) as string;
            this.epoch = epoch;
            const digest = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authCall(oauthStateDigest, [state]) as Effect.Effect<string, unknown>;
              }),
            ])) as string;
            const key = oauthFlowKeys.flow(digest);
            const url = authorizationUrl.toString();
            const { verifier } = this.consent;
            const grant = (yield authInvoke(this, "boundGrant", [])) as Grant;
            this.assertCredentialFree(url, grant.body, true);
            const binding = this.configuredAuthorizationBinding() ?? {
              ...((yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authCall(discoveryBinding, [this.consentDiscovery ?? grant.body.discovery]) as Effect.Effect<
                    FlowBinding,
                    unknown
                  >;
                }),
              ])) as FlowBinding),
              issuer: discoveryIssuer(this.consentDiscovery) ?? grant.body.issuer,
              clientId: authorizationUrl.searchParams.get("client_id") ?? grant.body.client?.value.client_id,
            };
            const record = (yield authInvoke(this, "encodeFlow", [
              key,
              {
                epoch,
                at: Date.now(),
                binding,
                url,
                ...(verifier !== undefined ? { verifier } : {}),
              },
            ])) as string;
            if (this.signal?.aborted) return;
            if (
              !((yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authStorage(this.storage, "compareAndSet", [
                    key,
                    null,
                    record,
                    { ttlSeconds: OAUTH_FLOW_TTL_SECONDS },
                  ]) as Effect.Effect<boolean, unknown>;
                }),
              ])) as boolean)
            ) {
              throw new Error(`OAuth consent for "${this.connectorId}" reused a state`);
            }
            let published = false;
            try {
              published = (yield authInvoke(this, "updateGrant", [
                (grant: Grant) => ({ ...grant, flow: digest }),
                { epoch },
              ])) as boolean;
            } finally {
              if (!published)
                (yield authCatch(
                  authInvoke(this, "wait", [
                    authMethod(() => {
                      return authStorage(this.storage, "compareAndSet", [key, record, null]) as Effect.Effect<
                        boolean,
                        unknown
                      >;
                    }),
                  ]),
                  () => {},
                )) as boolean | void;
            }
            if (published) this.published = { epoch, url };
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.redirectToAuthorization,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "consentUrl",
      function (this: KvOAuthProvider, signal: AbortSignal | undefined) {
        signal = signal === undefined ? this.signal : signal;

        return authFlow<string | undefined>(
          function* (this: KvOAuthProvider) {
            const published = this.published;
            if (!published) return undefined;
            if (
              epochOf(
                (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
                  }),
                  signal,
                ])) as string | null,
              ) !== published.epoch
            )
              throw this.flowSuperseded();
            this.assertCredentialFree(
              published.url,
              ((yield authInvoke(this, "boundGrant", [signal])) as Grant).body,
              true,
            );
            return published.url;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.consentUrl,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "pendingAuthorizationUrl",
      function (this: KvOAuthProvider) {
        return authFlow<string | undefined>(
          function* (this: KvOAuthProvider) {
            const url = (
              (yield authInvoke(this, "latestConsent", [])) as
                | (Flow & {
                    url: string;
                  })
                | undefined
            )?.url;
            this.assertCredentialFree(url, ((yield authInvoke(this, "boundGrant", [])) as Grant).body, true);
            return url;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.pendingAuthorizationUrl,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "reusablePendingAuthorizationUrl",
      function (this: KvOAuthProvider) {
        return authFlow<string | undefined>(
          function* (this: KvOAuthProvider) {
            const consent = (yield authInvoke(this, "latestConsent", [])) as
              | (Flow & {
                  url: string;
                })
              | undefined;
            if (!consent || Math.abs(Date.now() - consent.at) >= PENDING_AUTHORIZATION_MAX_AGE_MS) {
              return undefined;
            }
            this.assertCredentialFree(consent.url, ((yield authInvoke(this, "boundGrant", [])) as Grant).body, true);
            let clientId: string | null;
            try {
              clientId = new URL(consent.url).searchParams.get("client_id");
            } catch {
              return undefined;
            }
            const client = (yield authInvoke(this, "clientInformation", [])) as OAuthClientInformationMixed | undefined;
            return clientId !== null && client?.client_id === clientId ? consent.url : undefined;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.reusablePendingAuthorizationUrl,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "verifyState",
      function (this: KvOAuthProvider, candidate: string | null) {
        return authFlow<boolean>(
          function* (this: KvOAuthProvider) {
            this.callback = undefined;
            if (candidate === null) return false;
            const key = oauthFlowKeys.flow(
              (yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authCall(oauthStateDigest, [candidate]) as Effect.Effect<string, unknown>;
                }),
              ])) as string,
            );
            const raw = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage(this.storage, "get", [key]) as Effect.Effect<string | null, unknown>;
              }),
            ])) as string | null;
            const flow =
              raw === null ? undefined : ((yield authInvoke(this, "openFlow", [key, raw, true])) as Flow | undefined);
            if (raw === null || !flow || flow.consumed) return false;
            this.callback = { key, raw, flow, claimed: false };
            this.epoch = flow.epoch;
            return true;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.verifyState,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "claimCodeExchange",
      function (this: KvOAuthProvider) {
        return authFlow<Response | undefined>(
          function* (this: KvOAuthProvider) {
            if (this.exchangeRefusal) return this.exchangeRefusal.clone();
            (yield authInvoke(this, "claimConsent", [])) as void;
            return undefined;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.claimCodeExchange,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "consumeAuthError",
      function (this: KvOAuthProvider) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const { grant } = (yield authInvoke(this, "readGrant", [])) as {
              raw: string | null;
              grant: Grant;
            };
            if (!this.callback || grant.epoch !== this.callback.flow.epoch) throw this.flowSuperseded();
            (yield authInvoke(this, "checkFlowBinding", [grant])) as void;
            (yield authInvoke(this, "claimConsent", [])) as void;
            this.callback = undefined;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.consumeAuthError,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "claimConsent",
      function (this: KvOAuthProvider) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const callback = this.callback;
            if (!callback) throw this.flowSuperseded();
            if (callback.claimed) throw new OAuthCallbackClaimedError(this.connectorId);
            callback.claimed = true;
            const { epoch, at } = callback.flow;
            const claimed = JSON.stringify({
              connectaOAuthFlow: FLOW_VERSION,
              epoch,
              at,
              consumed: true,
            } satisfies StoredFlow);
            const remaining = Math.ceil((at + OAUTH_FLOW_TTL_SECONDS * 1000 - Date.now()) / 1000);
            const ttlSeconds = Math.min(OAUTH_FLOW_TTL_SECONDS, Math.max(1, remaining));
            if (
              (yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authStorage(this.storage, "compareAndSet", [
                    callback.key,
                    callback.raw,
                    claimed,
                    { ttlSeconds },
                  ]) as Effect.Effect<boolean, unknown>;
                }),
              ])) as boolean
            ) {
              return;
            }
            if (
              epochOf(
                (yield authInvoke(this, "wait", [
                  authMethod(() => {
                    return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
                  }),
                ])) as string | null,
              ) !== epoch
            )
              throw this.flowSuperseded();
            throw new OAuthCallbackClaimedError(this.connectorId);
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.claimConsent,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "dispatchCodeExchange",
      function (this: KvOAuthProvider, send: () => Promise<Response>, endpoint?: string | URL) {
        return authFlow<Response>(
          function* (this: KvOAuthProvider) {
            const epoch = this.epoch;
            if (!this.codeExchange || epoch === undefined) throw this.flowSuperseded();
            const raw = (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authStorage(this.storage, "get", [GRANT]) as Effect.Effect<string | null, unknown>;
              }),
            ])) as string | null;
            const grant = (yield authInvoke(this, "openGrant", [raw])) as Grant;
            if (grant.epoch !== epoch) throw this.flowSuperseded();
            (yield authInvoke(this, "checkFlowBinding", [grant])) as void;
            if (endpoint !== undefined && this.callback?.flow.binding?.tokenEndpoint !== String(endpoint)) {
              throw this.flowSuperseded();
            }
            return (yield authInvoke(this, "wait", [
              authMethod(() => {
                return authThen(
                  authStorage(this.storage, "get", [GRANT]),
                  authMethod((current: string | null) => {
                    return authFlow<Response>(
                      function* (this: KvOAuthProvider) {
                        if (this.signal?.aborted) throw aborted(this.signal);
                        if (current !== raw) throw this.flowSuperseded();
                        const sent = send();
                        sent.catch(() => {});
                        return (yield authValue(() => sent)) as Response;
                      }.bind(this),
                    );
                  }),
                ) as Effect.Effect<Response, unknown>;
              }),
            ])) as Response;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.dispatchCodeExchange,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "recordCodeExchangeTokens",
      function (this: KvOAuthProvider, tokens: OAuthTokens) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            this.exchangeConsent = undefined;
            if (tokens.refresh_token === undefined) return;
            try {
              const digest = (yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authCall(oauthStateDigest, [tokens.refresh_token!]) as Effect.Effect<string, unknown>;
                }),
              ])) as string;
              const resolution = (yield authInvoke(this, "wait", [
                authMethod(() => {
                  return authStorage(this.storage, "get", [oauthRefreshSpentKeys.spent(digest)]) as Effect.Effect<
                    string | null,
                    unknown
                  >;
                }),
              ])) as string | null;
              const spent = storedRefreshSpent(resolution);
              if (spent?.state === "resolved") this.exchangeConsent = { digest, resolution: resolution! };
            } catch {
              if (this.signal?.aborted) throw aborted(this.signal);
              throw this.credentialWriteError();
            }
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.recordCodeExchangeTokens,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "invalidateCredentials",
      function (this: KvOAuthProvider, scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            if (this.signal?.aborted) throw aborted(this.signal);
            const fields = {
              all: ["client", "tokens", "discovery"],
              client: ["client"],
              tokens: ["tokens"],
              discovery: ["discovery"],
              verifier: [],
            }[scope] as Array<"client" | "tokens" | "discovery">;
            if (fields.length > 0) {
              (yield authInvoke(this, "updateGrant", [
                (grant: Grant) => {
                  const body: GrantBody = { ...grant.body };
                  let changed = false;
                  for (const field of fields) {
                    const current = field === "client" ? body.client?.value : body[field];
                    if (current === undefined) continue;
                    if (field !== "discovery" && fingerprint(current) !== this.seen[field]) continue;
                    delete body[field];
                    changed = true;
                  }
                  return changed ? { ...grant, body } : undefined;
                },
                { quiet: true },
              ])) as boolean;
            }
            if (!this.allowAuthorization && this.refreshFailure?.kind === "dead") {
              throw this.authorizationRefused();
            }
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.invalidateCredentials,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "claimRefresh",
      function (
        this: KvOAuthProvider,
        epoch: string,
        requested: string | null,
        signal?: AbortSignal,
        sharedWait?: RefreshWait,
      ) {
        return authFlow<Response | RefreshLease>(
          function* (this: KvOAuthProvider) {
            const waiting = sharedWait ?? refreshWait(signal);
            const wait = waiting.run;
            let delay = 10;
            try {
              const digest = (yield authCall(wait, [
                authMethod(() => {
                  return authCall(oauthStateDigest, [requested ?? ""]) as Effect.Effect<string, unknown>;
                }),
              ])) as string;
              const key = oauthRefreshKeys.lease(epoch, digest);
              const spentKey = oauthRefreshSpentKeys.spent(digest);
              while (!waiting.signal.aborted) {
                const current = (yield authCall(wait, [
                  authMethod(() => {
                    return authInvoke(this, "storedTokens", [waiting.signal]) as Effect.Effect<
                      | {
                          access_token: string;
                          token_type: string;
                          id_token?: string | undefined;
                          expires_in?: number | undefined;
                          scope?: string | undefined;
                          refresh_token?: string | undefined;
                          issuer?: string | undefined;
                        }
                      | undefined,
                      unknown
                    >;
                  }),
                ])) as
                  | {
                      access_token: string;
                      token_type: string;
                      id_token?: string | undefined;
                      expires_in?: number | undefined;
                      scope?: string | undefined;
                      refresh_token?: string | undefined;
                      issuer?: string | undefined;
                    }
                  | undefined;
                if (current?.refresh_token !== requested || (current && this.refreshedSinceRead(current, epoch))) {
                  if (!current) this.recordRefreshFailure({ kind: "dead" });
                  return current
                    ? this.adoptRefresh(current)
                    : Response.json({ error: "invalid_grant" }, { status: 400 });
                }
                const raw = (yield authCall(wait, [
                  authMethod(() => {
                    return authStorage(this.storage, "get", [key]) as Effect.Effect<string | null, unknown>;
                  }),
                ])) as string | null;
                const stored = raw === null ? undefined : parsed(raw);
                if (
                  plainObject(stored) &&
                  stored.completed === true &&
                  current &&
                  stored.tokenDigest ===
                    ((yield authCall(wait, [
                      authMethod(() => {
                        return authCall(refreshTokensDigest, [current]) as Effect.Effect<string, unknown>;
                      }),
                    ])) as string)
                ) {
                  return this.adoptRefresh(current);
                }
                if (plainObject(stored) && (plainObject(stored.verdict) || stored.completed === true)) {
                  this.recordRefreshFailure({ kind: "dead" });
                  (yield authCall(wait, [
                    authMethod(() => {
                      return authInvoke(this, "discardRefusedGrant", [
                        requested,
                        epoch,
                        waiting.transfer,
                        waiting.signal,
                      ]) as Effect.Effect<void, unknown>;
                    }),
                  ])) as void;
                  throw new UnauthorizedError("OAuth refresh grant is no longer active.");
                }
                if (plainObject(stored) && stored.state !== "claimed") {
                  const active =
                    typeof stored.activeKey === "string"
                      ? ((yield authCall(wait, [
                          authMethod(() => {
                            return authStorage(this.storage, "get", [stored.activeKey as string]) as Effect.Effect<
                              string | null,
                              unknown
                            >;
                          }),
                        ])) as string | null)
                      : null;
                  if (active === null) {
                    const refused = JSON.stringify({ ...stored, verdict: { kind: "dead" } });
                    if (
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authStorage<boolean>(this.storage, "compareAndSet", [key, raw, refused], () =>
                            waiting.transfer(),
                          );
                        }),
                      ])) as boolean
                    ) {
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authInvoke(this, "resolveRefreshSpent", [
                            { key, spentKey, spentExpected: null, raw: raw! },
                            "ambiguous",
                          ]) as Effect.Effect<void, unknown>;
                        }),
                      ])) as void;
                      this.recordRefreshFailure({ kind: "dead" });
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authInvoke(this, "discardRefusedGrant", [
                            requested,
                            epoch,
                            waiting.transfer,
                            waiting.signal,
                          ]) as Effect.Effect<void, unknown>;
                        }),
                      ])) as void;
                      throw new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
                    }
                    continue;
                  }
                } else {
                  const spentExpected = (yield authCall(wait, [
                    authMethod(() => {
                      return authStorage(this.storage, "get", [spentKey]) as Effect.Effect<string | null, unknown>;
                    }),
                  ])) as string | null;
                  if (spentExpected !== null) {
                    const spent = storedRefreshSpent(spentExpected);
                    const consent = (
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authInvoke(this, "boundGrant", [waiting.signal]) as Effect.Effect<Grant, unknown>;
                        }),
                      ])) as Grant
                    ).body.refreshConsent;
                    if (
                      spent?.state !== "resolved" ||
                      spent.epoch === epoch ||
                      consent?.digest !== digest ||
                      consent.resolution !== spentExpected
                    ) {
                      if (
                        spent?.state === "outstanding" &&
                        ((yield authCall(wait, [
                          authMethod(() => {
                            return authStorage(this.storage, "get", [spent.activeKey]) as Effect.Effect<
                              string | null,
                              unknown
                            >;
                          }),
                        ])) as string | null) === null
                      ) {
                        (yield authCall(wait, [
                          authMethod(() => {
                            return authStorage<boolean>(
                              this.storage,
                              "compareAndSet",
                              [spentKey, spentExpected, JSON.stringify({ ...spent, state: "ambiguous" })],
                              () => waiting.transfer(),
                            );
                          }),
                        ])) as boolean;
                      }
                      this.recordRefreshFailure({ kind: "dead" });
                      (yield authCall(wait, [
                        authMethod(() => {
                          return authInvoke(this, "discardRefusedGrant", [
                            requested,
                            epoch,
                            waiting.transfer,
                            waiting.signal,
                          ]) as Effect.Effect<void, unknown>;
                        }),
                      ])) as void;
                      throw new UnauthorizedError("OAuth refresh token was already spent; authorization required.");
                    }
                  }
                  if (
                    raw === null ||
                    (plainObject(stored) &&
                      typeof stored.expiresAt === "number" &&
                      stored.expiresAt <= this.refreshNow())
                  ) {
                    const claimed = JSON.stringify({
                      connectaOAuthRefresh: 1,
                      holder: crypto.randomUUID(),
                      state: "claimed",
                      expiresAt: this.refreshNow() + OAUTH_REFRESH_LEASE_SECONDS * 1000,
                    } satisfies StoredRefreshLease);
                    let won: boolean;
                    try {
                      won = (yield authCall(wait, [
                        authMethod(() => {
                          return authStorage<boolean>(this.storage, "compareAndSet", [key, raw, claimed], () =>
                            waiting.transfer(),
                          );
                        }),
                      ])) as boolean;
                    } catch {
                      throw this.credentialWriteError();
                    }
                    if (won) {
                      try {
                        const latest = (yield authCall(wait, [
                          authMethod(() => {
                            return authInvoke(this, "storedTokens", [waiting.signal]) as Effect.Effect<
                              | {
                                  access_token: string;
                                  token_type: string;
                                  id_token?: string | undefined;
                                  expires_in?: number | undefined;
                                  scope?: string | undefined;
                                  refresh_token?: string | undefined;
                                  issuer?: string | undefined;
                                }
                              | undefined,
                              unknown
                            >;
                          }),
                        ])) as
                          | {
                              access_token: string;
                              token_type: string;
                              id_token?: string | undefined;
                              expires_in?: number | undefined;
                              scope?: string | undefined;
                              refresh_token?: string | undefined;
                              issuer?: string | undefined;
                            }
                          | undefined;
                        if (latest?.refresh_token !== requested || (latest && this.refreshedSinceRead(latest, epoch))) {
                          (yield authCall(wait, [
                            authMethod(() => {
                              return authInvoke(this, "releaseRefresh", [
                                { key, spentKey, spentExpected, raw: claimed },
                              ]) as Effect.Effect<void, unknown>;
                            }),
                          ])) as void;
                          return latest
                            ? this.adoptRefresh(latest)
                            : Response.json({ error: "invalid_grant" }, { status: 400 });
                        }
                        return { key, spentKey, spentExpected, raw: claimed };
                      } catch (error) {
                        if (!waiting.signal.aborted) {
                          (yield authCall(wait, [
                            authMethod(() => {
                              return authInvoke(this, "releaseRefresh", [
                                { key, spentKey, spentExpected, raw: claimed },
                              ]) as Effect.Effect<void, unknown>;
                            }),
                          ])) as void;
                        }
                        throw error;
                      }
                    }
                  }
                }
                (yield Effect.raceAllFirst([Effect.sleep(delay), fromSignal(waiting.signal)])) as void;
                delay = Math.min(250, delay * 2);
              }
            } catch (error) {
              if (!waiting.signal.aborted) throw error;
            } finally {
              if (!sharedWait) waiting.close();
            }
            throw this.refreshContended();
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.claimRefresh,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "dispatchRefresh",
      function (this: KvOAuthProvider, lease: RefreshLease, send: () => Promise<Response>, waiting: RefreshWait) {
        return authFlow<Response>(
          function* (this: KvOAuthProvider) {
            const stored = parsed(lease.raw) as StoredRefreshLease;
            const epoch = (yield authInvoke(waiting, "run", [
              authMethod(() => {
                return authInvoke(this, "flowEpoch", []) as Effect.Effect<string, unknown>;
              }),
            ])) as string;
            const activeKey = oauthRefreshActiveKeys.holder(epoch, stored.holder);
            (yield authInvoke(waiting, "run", [
              authMethod(() => {
                return authStorage(this.storage, "set", [
                  activeKey,
                  JSON.stringify({ connectaOAuthRefresh: 1 }),
                  {
                    ttlSeconds: OAUTH_REFRESH_LEASE_SECONDS,
                  },
                ]) as Effect.Effect<void, unknown>;
              }),
            ])) as void;
            const dispatched = JSON.stringify({
              ...stored,
              state: "dispatched",
              activeKey,
            } satisfies StoredRefreshLease);
            const won = (yield authInvoke(waiting, "run", [
              authMethod(() => authStorage<boolean>(this.storage, "compareAndSet", [lease.key, lease.raw, dispatched])),
            ])) as boolean;
            if (!won) throw this.refreshContended();
            lease.raw = dispatched;
            if (waiting.signal.aborted) throw aborted(waiting.signal);
            lease.spentRaw = JSON.stringify({
              connectaOAuthRefreshSpent: 1,
              epoch,
              holder: stored.holder,
              activeKey,
              state: "outstanding",
            } satisfies StoredRefreshSpent);
            let unspent: boolean;
            try {
              unspent = (yield authInvoke(waiting, "run", [
                authMethod(() =>
                  authStorage<boolean>(this.storage, "compareAndSet", [
                    lease.spentKey,
                    lease.spentExpected,
                    lease.spentRaw,
                  ]),
                ),
              ])) as boolean;
            } catch {
              this.recordRefreshFailure({ kind: "dead" });
              throw new UnauthorizedError("OAuth refresh dispatch could not be recorded; authorization required.");
            }
            if (!unspent) {
              this.recordRefreshFailure({ kind: "dead" });
              throw new UnauthorizedError("OAuth refresh token was already spent; authorization required.");
            }
            // Final owner check and physical submission share one reaction.
            if (waiting.signal.aborted) throw aborted(waiting.signal);
            return (yield authCall<Response>(send, [])) as Response;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.dispatchRefresh,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "releaseRefresh",
      function (
        this: KvOAuthProvider,
        lease: RefreshLease,
        verdict?: RefreshFailure,
        tokens?: OAuthTokens,
        resolution: "resolved" | "ambiguous" = "ambiguous",
      ) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const stored = parsed(lease.raw) as StoredRefreshLease;
            const next =
              stored.state === "claimed"
                ? null
                : JSON.stringify({
                    ...stored,
                    ...(tokens
                      ? {
                          completed: true as const,
                          tokenDigest: (yield authCall(refreshTokensDigest, [tokens])) as string,
                        }
                      : { verdict: { kind: "dead" } }),
                  } satisfies StoredRefreshLease);
            if (verdict) this.recordRefreshFailure(verdict);
            (yield authInvoke(this, "resolveRefreshSpent", [lease, resolution])) as void;
            const released = (yield authCatch(
              authStorage(this.storage, "compareAndSet", [lease.key, lease.raw, next]),
              () => false,
            )) as boolean;
            if (released && stored.activeKey)
              (yield authCatch(authStorage(this.storage, "delete", [stored.activeKey]), () => {})) as void;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.releaseRefresh,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "resolveRefreshSpent",
      function (this: KvOAuthProvider, lease: RefreshLease, state: "resolved" | "ambiguous") {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            try {
              const raw =
                lease.spentRaw ?? ((yield authStorage(this.storage, "get", [lease.spentKey])) as string | null);
              const spent = storedRefreshSpent(raw);
              const holder = (parsed(lease.raw) as StoredRefreshLease).holder;
              if (spent?.state !== "outstanding" || spent.holder !== holder) return;
              (yield authStorage(this.storage, "compareAndSet", [
                lease.spentKey,
                raw,
                JSON.stringify({
                  ...spent,
                  state,
                  ...(state === "resolved" ? { resolvedAt: Date.now() } : {}),
                }),
              ])) as boolean;
            } catch {}
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.resolveRefreshSpent,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "storedTokens",
      function (this: KvOAuthProvider, signal: AbortSignal | null = null) {
        return authFlow<
          | {
              access_token: string;
              token_type: string;
              id_token?: string | undefined;
              expires_in?: number | undefined;
              scope?: string | undefined;
              refresh_token?: string | undefined;
              issuer?: string | undefined;
            }
          | undefined
        >(
          function* (this: KvOAuthProvider) {
            return ((yield authInvoke(this, "boundGrant", [signal])) as Grant).body.tokens;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.storedTokens,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "storeRefresh",
      function (
        this: KvOAuthProvider,
        epoch: string,
        requested: string | null,
        tokens: OAuthTokens,
        issuer: string | undefined,
      ) {
        return authFlow<
          | {
              access_token: string;
              token_type: string;
              id_token?: string | undefined;
              expires_in?: number | undefined;
              scope?: string | undefined;
              refresh_token?: string | undefined;
              issuer?: string | undefined;
            }
          | undefined
        >(
          function* (this: KvOAuthProvider) {
            for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
              try {
                const { raw, grant } = (yield authInvoke(this, "readGrant", [null])) as {
                  raw: string | null;
                  grant: Grant;
                };
                if (grant.epoch !== epoch || (issuer !== undefined && grant.body.issuer !== issuer)) return undefined;
                if (grant.body.tokens?.refresh_token !== requested) return grant.body.tokens;
                const committed = issuer !== undefined ? { ...tokens, issuer } : tokens;
                const encoded = (yield authInvoke(this, "encodeGrant", [
                  { ...grant, body: { ...grant.body, tokens: committed } },
                  null,
                ])) as string;
                if ((yield authStorage(this.storage, "compareAndSet", [GRANT, raw, encoded])) as boolean)
                  return committed;
              } catch {}
            }
            throw this.credentialWriteError();
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.storeRefresh,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "discardRefusedGrant",
      function (
        this: KvOAuthProvider,
        refreshToken: string | null,
        epoch: string,
        beforeWrite?: () => void,
        signal?: AbortSignal,
      ) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            try {
              (yield authInvoke(this, "updateGrant", [
                (grant: Grant) => {
                  if (grant.body.tokens?.refresh_token !== refreshToken) return undefined;
                  const { tokens: _refused, ...body } = grant.body;
                  return { ...grant, body };
                },
                {
                  epoch,
                  quiet: true,
                  commit: true,
                  ...(beforeWrite ? { beforeWrite } : {}),
                  ...(signal ? { signal } : {}),
                },
              ])) as boolean;
            } catch {}
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.discardRefusedGrant,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "resetAuthorization",
      function (this: KvOAuthProvider, operatorDisconnected: boolean = false, preserveClient: boolean = false) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const operation = authInvoke<void>(this, "performReset", [operatorDisconnected, preserveClient]);
            if (!this.onReset) return (yield operation) as void;
            const reset = runEdge(operation);
            this.onReset?.(reset);
            return (yield authValue(() => reset)) as void;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.resetAuthorization,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "disconnectAuthorization",
      function (this: KvOAuthProvider, send: FetchLike) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const operation = authInvoke<void>(this, "performReset", [true, false, send]);
            if (!this.onReset) return (yield operation) as void;
            const reset = runEdge(operation);
            this.onReset?.(reset);
            return (yield authValue(() => reset)) as void;
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.disconnectAuthorization,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "performReset",
      function (this: KvOAuthProvider, operatorDisconnected: boolean, preserveClient: boolean, revoke?: FetchLike) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            const epoch = `${operatorDisconnected ? DISCONNECTED_EPOCH_PREFIX : ACTIVE_EPOCH_PREFIX}${crypto.randomUUID()}`;
            for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
              const { raw, grant } = (yield authInvoke(this, "readGrant", [null])) as {
                raw: string | null;
                grant: Grant;
              };
              const carried = preserveClient && !operatorDisconnected ? this.carriableClient(grant) : undefined;
              const encoded = (yield authInvoke(this, "encodeGrant", [
                { epoch, body: carried ?? {}, cleanupPending: true },
                null,
              ])) as string;
              let written: boolean;
              try {
                written = (yield authStorage(this.storage, "compareAndSet", [GRANT, raw, encoded])) as boolean;
              } catch {
                throw this.credentialWriteError();
              }
              if (written) {
                this.refreshCoordinator?.retire(grant.epoch);
                try {
                  (yield authInvoke(this, "cleanupV2", [encoded, null])) as string | null;
                  (yield authInvoke(this, "sweepConsents", [])) as void;
                  (yield authInvoke(this, "sweepRefreshLeases", [])) as void;
                } finally {
                  if (revoke)
                    (yield authCall(revokeDownstreamGrant, [grant.body, revoke, this.clientOptions?.client])) as void;
                }
                return;
              }
            }
            throw this.credentialWriteError();
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.performReset,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "sweepConsents",
      function (this: KvOAuthProvider) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            try {
              const consents: Array<[string, string]> = [];
              for (const key of (yield authStorage(this.storage, "list", [oauthFlowKeys.prefix])) as string[]) {
                const raw = (yield authStorage(this.storage, "get", [key])) as string | null;
                if (raw !== null) consents.push([key, raw]);
              }
              const live = epochOf((yield authStorage(this.storage, "get", [GRANT])) as string | null);
              for (const [key, raw] of consents) {
                const flow = parsed(raw);
                if (plainObject(flow) && flow.epoch === live) continue;
                (yield authStorage(this.storage, "compareAndSet", [key, raw, null])) as boolean;
              }
            } catch {}
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.sweepConsents,
    );
    registerAuthMethod(
      KvOAuthProvider.prototype,
      "sweepRefreshLeases",
      function (this: KvOAuthProvider) {
        return authFlow<void>(
          function* (this: KvOAuthProvider) {
            try {
              const records: Array<[string, string]> = [];
              for (const key of (yield authStorage(this.storage, "list", [oauthRefreshKeys.prefix])) as string[]) {
                const raw = (yield authStorage(this.storage, "get", [key])) as string | null;
                if (raw !== null) records.push([key, raw]);
              }
              const live = epochOf((yield authStorage(this.storage, "get", [GRANT])) as string | null);
              for (const [key, raw] of records) {
                if (!key.startsWith(`${oauthRefreshKeys.prefix}${live}:`)) {
                  (yield authStorage(this.storage, "compareAndSet", [key, raw, null])) as boolean;
                }
              }
            } catch {}
          }.bind(this),
        );
      },
      KvOAuthProvider.prototype.sweepRefreshLeases,
    );
  }
}
