// The token endpoint as one connector runtime's OAuth flows reach it: one
// redemption per refresh generation, joined by concurrent requests, and early
// renewal of a token about to expire.
import type { FetchLike, OAuthTokens } from "@modelcontextprotocol/client";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { Effect, Exit } from "effect";
import { oauthPartitionFor, retainOAuthPartition } from "../../oauth-partition.js";
import { fromSignal, runEdge } from "../../runtime/run.js";
import { Settlement } from "../../runtime/settlement.js";
import type { ConnectorContext } from "../../types.js";
import {
  authCall,
  authCatch,
  authDetached,
  authFlow,
  authInvoke,
  authMethod,
  authProgram,
  authThen,
  registerAuth,
  authMethods,
} from "../native.js";
import {
  isOAuthCredentialRequest,
  isRefreshTokenRequest,
  refreshResponseOutcome,
  sdkSafeTokenResponse,
  tokenGrantType,
  type RefreshFailure,
  type RefreshResponseOutcome,
} from "../oauth-token-response.js";
import { oauthStateDigest } from "./consent.js";
import type { KvOAuthProvider } from "../downstream-oauth.js";
import type { RefreshLease } from "./refresh-records.js";

type RefreshFlightOutcome =
  | { status: "refreshed"; tokens: OAuthTokens }
  /** A reset fenced the epoch: joiners read again and find their flow superseded. */
  | { status: "retired" }
  /** `verdict` is present when the token endpoint's answer (or silence) decided it. */
  | { status: "failed"; error: unknown; verdict?: RefreshFailure };

const REFRESH_REQUEST_DEADLINE_MS = 20_000;
const REFRESH_COMMIT_DEADLINE_MS = 20_000;
const REFRESH_WAIT_DEADLINE_MS = 35_000;

/** The access token an early renewal replaces, carried on its token request's init. */
const EARLY_RENEWAL: unique symbol = Symbol("connecta.oauth.earlyRenewal");

/**
 * The token endpoint as an early renewal of `due` reaches it: the coordinator
 * hands back a token another request already rotated in instead of redeeming
 * the refresh token again (`OAuthRefreshCoordinator.refresh`).
 */
export function earlyRenewalFetch(send: FetchLike, due: string): FetchLike {
  return (input, init) => send(input, { ...init, [EARLY_RENEWAL]: due } as RequestInit);
}

/**
 * Access tokens one request's early renewals replaced or produced, so a
 * check later in the request does not renew a produced token again while it
 * is within its stored expiry. One already expired when produced (a zero
 * lifetime) is spared the next check only. A replaced token stands for its
 * replacement; any other token, another isolate's rotation included, is
 * checked as usual.
 */
export class EarlyRenewals {
  /** A replaced token's replacement, or a produced token's expiry (0: the next check only). */
  private readonly scopes = new WeakMap<object, Map<string, string | number>>();

  record(scope: object, due: string, fresh: string, expiresAt: number | undefined): void {
    let tokens = this.scopes.get(scope);
    if (!tokens) this.scopes.set(scope, (tokens = new Map()));
    if (fresh !== due) tokens.set(due, fresh);
    tokens.set(fresh, expiresAt !== undefined && expiresAt > Date.now() ? expiresAt : 0);
  }

  /** Whether `due` needs no renewal now; spends a next-check-only exemption. */
  settled(scope: object, due: string): boolean {
    const tokens = this.scopes.get(scope);
    const replacement = tokens?.get(due);
    const token = typeof replacement === "string" ? replacement : due;
    const until = tokens?.get(token);
    if (until === 0) tokens!.delete(token);
    return until === 0 || (typeof until === "number" && Date.now() < until);
  }
}

function earlyRenewalOf(init: RequestInit | undefined): string | undefined {
  const due: unknown = (init as { [EARLY_RENEWAL]?: unknown } | undefined)?.[EARLY_RENEWAL];
  return typeof due === "string" ? due : undefined;
}

/** Caller-owned reads become coordinator-owned at the first submitted durable write. */
export interface RefreshWait {
  signal: AbortSignal;
  readonly requestStarted: boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
  transfer(): void;
  beginRequest(): void;
  close(): void;
}

export function refreshWait(signal?: AbortSignal, timeoutMs = REFRESH_WAIT_DEADLINE_MS): RefreshWait {
  const deadline = new AbortController();
  let timer = setTimeout(() => deadline.abort(), timeoutMs);
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
        // A race's losing operation may still start. Check before constructing it,
        // then again before handing a late result back to preparation.
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
  outcome: Settlement<RefreshFlightOutcome>;
}

export function aborted(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * The outcome of a flight another request owns, failures included. Rejects
 * only with this caller's own abort.
 *
 * The owner settles the flight from its own request. Settlement wakes this
 * waiter through a Promise this request created, so the wait — and the
 * caller's storage reads after it — resume here, never inside the owner's
 * call (src/runtime/settlement.ts).
 */
function waitForRefreshFlight(
  flight: RefreshFlight,
  signal?: AbortSignal,
  deadline?: AbortSignal,
): Promise<RefreshFlightOutcome> {
  const settled = flight.outcome.wait();
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
export function tokenResponse(tokens: OAuthTokens): Response {
  const { issuer: _issuer, ...answer } = tokens as OAuthTokens & { issuer?: unknown };
  return Response.json(answer);
}

export function refreshTokensDigest(tokens: OAuthTokens): Promise<string> {
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
 * A refresh generation is redeemed once per owner partition: the first request
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
          // Freeze the form before any await: classification and the spent digest
          // must describe the exact token sent, even if its caller mutates a form.
          const early = earlyRenewalOf(init);
          init = init
            ? { ...init, ...(init.body instanceof URLSearchParams ? { body: new URLSearchParams(init.body) } : {}) }
            : undefined;
          if (early !== undefined) delete (init as { [EARLY_RENEWAL]?: string })[EARLY_RENEWAL];
          // Production adapters resolve the required host policy before a code or
          // refresh claim can consume its single-use credential. Custom SDK leaves
          // may supply their own policy; this hook performs no I/O and owns no data.
          if (isOAuthCredentialRequest(init)) prepareCredentialRequest?.();
          if (isRefreshTokenRequest(init)) {
            const signal =
              requestSignal && init?.signal
                ? AbortSignal.any([requestSignal, init.signal])
                : (requestSignal ?? init?.signal ?? undefined);
            return (yield authInvoke(this, "refresh", [
              provider,
              input,
              init,
              baseFetch,
              signal,
              defer,
              early,
            ])) as Response;
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
                // Credential-bearing OAuth requests use the raw send path. A redirect
                // is a dispatched failure, never authority to send the form again.
                // Its tokens' lifetime starts no later than this send.
                if (grantType !== undefined) provider.tokenRequestSent = Date.now();
                return (yield tokenRequest
                  ? authCall(baseFetch, [input, { ...init, redirect: "manual", ...(signal ? { signal } : {}) }])
                  : authCall(resourceFetch, [input, { ...init, ...(signal ? { signal } : {}) }])) as Response;
              }.bind(this),
            );
          });
          // Await the composed fetch here so workerd associates a rejection with
          // the fetch the SDK is already awaiting.
          const response = (yield exchange
            ? authInvoke(provider, "dispatchCodeExchange", [dispatch, input])
            : authCall(dispatch, [])) as Response;
          if (!tokenRequest) return response;
          // A code exchange's failure is the SDK's to log as well.
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

  declare private refresh: (
    provider: KvOAuthProvider,
    input: string | URL,
    init: RequestInit | undefined,
    baseFetch: FetchLike,
    signal: AbortSignal | undefined,
    defer: ConnectorContext["defer"],
    early?: string,
  ) => Promise<Response>;

  declare private redeem: (
    provider: KvOAuthProvider,
    epoch: string,
    requested: string | null,
    input: string | URL,
    init: RequestInit | undefined,
    baseFetch: FetchLike,
    waiting: RefreshWait,
  ) => Promise<Response>;

  /** A reset fenced `epoch`: wake its joiners now rather than at the answer. */
  retire(epoch: string): void {
    const flight = this.flights.get(epoch);
    if (!flight) return;
    this.flights.delete(epoch);
    flight.outcome.settle(Exit.succeed({ status: "retired" }));
  }

  static {
    authMethods(OAuthRefreshCoordinator.prototype, {
      refresh: function (
        this: OAuthRefreshCoordinator,
        provider: KvOAuthProvider,
        input: string | URL,
        init: RequestInit | undefined,
        baseFetch: FetchLike,
        signal: AbortSignal | undefined,
        defer: ConnectorContext["defer"],
        early: string | undefined,
      ) {
        return authFlow<Response>(
          function* (this: OAuthRefreshCoordinator) {
            if (signal?.aborted) throw aborted(signal);
            const waiting = refreshWait(signal);
            let redeeming = false;
            try {
              // A verdict belongs to one refresh; never let an older one decide this.
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
                // Preparation reads share the same bound as later claim waits.
                const current = (yield authInvoke(waiting, "run", [
                  authMethod(() => {
                    return authInvoke(provider, "storedTokens", [waiting.signal]) as Effect.Effect<
                      OAuthTokens | undefined,
                      unknown
                    >;
                  }),
                ])) as OAuthTokens | undefined;
                if (this.flights.has(epoch)) continue;
                if (
                  current?.refresh_token &&
                  (current.refresh_token !== requested ||
                    provider.refreshedSinceRead(current, epoch) ||
                    // An early renewal is answered by any token that replaced the
                    // one it found near expiry, whoever refreshed it.
                    (early !== undefined && current.access_token !== early))
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
                // Claim submission transfers renewal, including preparation, token
                // request and commit, to a bounded native coordinator. Only
                // this caller's wait races its signal; the coordinator receives
                // no request/call Context authority or caller-owned deadline.
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
      redeem: function (
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
            const flight: RefreshFlight = { outcome: new Settlement() };
            this.flights.set(epoch, flight);
            // Pin the owner partition until this coordinator exits, whoever is waiting.
            const release = this.retainPartition();
            let settled = false;
            const settle = (outcome: RefreshFlightOutcome) => {
              if (settled) return;
              settled = true;
              if (this.flights.get(epoch) === flight) this.flights.delete(epoch);
              release();
              // Last: joined waiters wake in their own requests, after this.
              flight.outcome.settle(Exit.succeed(outcome));
            };
            const fail = (error: unknown, verdict?: RefreshFailure) => {
              if (verdict) provider.recordRefreshFailure(verdict);
              settle({ status: "failed", error, ...(verdict ? { verdict } : {}) });
            };
            let dispatched = false;
            /** When the token request left: the earliest its tokens' lifetime can start. */
            let issuedAt = 0;
            const unknownOutcome = () =>
              new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
            // One budget for the entire commit/cleanup phase, including retries
            // and lease release. Interrupt native continuations, never detach a
            // Promise whose late read could still start a credential write.
            const complete = authMethod(<A>(operation: () => Promise<A>) => {
              const completion = refreshWait(undefined, REFRESH_COMMIT_DEADLINE_MS);
              return authInvoke<A>(completion, "run", [operation]).pipe(
                Effect.catch((error) => Effect.fail(completion.signal.aborted ? unknownOutcome() : error)),
                Effect.ensuring(Effect.sync(() => completion.close())),
              );
            });
            try {
              // The authorization server this redemption answers to, fixed now.
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
                        OAuthTokens | undefined,
                        unknown
                      >;
                    }),
                  ])) as OAuthTokens | undefined;
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
                            issuedAt = Date.now();
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
                  // Only the coordinator's own preparation deadline can interrupt a
                  // submitted claim. Caller cancellation no longer reaches this work.
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
                // A sent request without a definitive answer may have rotated the token.
                // Persist the refusal before dropping tokens, so interrupted cleanup or a
                // later write of the same fingerprint cannot make it redeemable again.
                const failure = new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
                (yield authCall(complete, [
                  authMethod(() =>
                    authFlow<void>(function* () {
                      (yield authCall(releaseLease, [{ kind: "dead" }])) as void;
                      (yield authInvoke(provider, "discardRefusedGrant", [requested, epoch])) as void;
                    }),
                  ),
                ])) as void;
                fail(failure, { kind: "dead" });
                throw failure;
              } finally {
                waiting.close();
              }
              return (yield authCall(complete, [
                authMethod(() =>
                  authFlow<Response>(function* () {
                    // An answer exists from here on, and is committed whatever the owner does.
                    if (outcome.failure) {
                      // Drop a refused grant while the flight still stands: a caller arriving
                      // meanwhile joins it instead of redeeming the dead token again.
                      (yield authInvoke(provider, "discardRefusedGrant", [requested, epoch])) as void;
                      (yield authCall(releaseLease, [outcome.verdict, "resolved"])) as void;
                      fail(outcome.failure, outcome.verdict);
                      return outcome.forSdk;
                    }
                    // The server consumed the old refresh token; the SDK merges it back the
                    // same way when a rotation omits one.
                    const accepted: OAuthTokens = {
                      ...outcome.tokens,
                      ...(outcome.tokens.refresh_token === undefined && requested !== null
                        ? { refresh_token: requested }
                        : {}),
                    };
                    let committed: OAuthTokens | undefined;
                    try {
                      committed = (yield authInvoke(provider, "storeRefresh", [
                        epoch,
                        requested,
                        accepted,
                        issuer,
                        issuedAt,
                      ])) as OAuthTokens | undefined;
                    } catch {
                      const failure = new UnauthorizedError(
                        "OAuth refresh could not be committed; authorization required.",
                      );
                      (yield authCall(releaseLease, [{ kind: "dead" }, "resolved"])) as void;
                      (yield authInvoke(provider, "discardRefusedGrant", [requested, epoch])) as void;
                      fail(failure, { kind: "dead" });
                      throw failure;
                    }
                    if (!committed) {
                      // Restart, Disconnect, or another consent decides the newer grant.
                      (yield authCall(releaseLease, [{ kind: "dead" }, "resolved"])) as void;
                      const failure = new UnauthorizedError("OAuth refresh grant is no longer active.");
                      fail(failure, { kind: "dead" });
                      throw failure;
                    }
                    (yield authInvoke(provider, "releaseRefresh", [lease, undefined, committed, "resolved"])) as void;
                    settle({ status: "refreshed", tokens: committed });
                    return provider.adoptRefresh(committed);
                  }),
                ),
              ])) as Response;
            } catch (error) {
              fail(error, dispatched ? { kind: "dead" } : provider.refreshVerdict());
              throw error;
            } finally {
              waiting.close();
              // No storage in this finalizer: even interruption or a failed
              // cleanup must drop the local flight and its owner retention.
              if (!settled) fail(unknownOutcome(), dispatched ? { kind: "dead" } : provider.refreshVerdict());
            }
          }.bind(this),
        );
      },
    });
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
