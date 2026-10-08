import { UnauthorizedError } from "@modelcontextprotocol/client";
import { Deferred, Effect } from "effect";
import type {
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { revokeDownstreamGrant } from "./downstream-revocation.js";
import { authenticateRemoteClient, downstreamClientMetadata, type RemoteOAuthClient } from "./downstream-client-metadata.js";
import { ConnectorCallError } from "../errors.js";
import {
  attachOAuthPartition,
  oauthPartitionFor,
  retainOAuthPartition,
} from "../oauth-partition.js";
import { inheritOAuthSealer } from "../oauth-sealing.js";
import type { OAuthStateSealer } from "../oauth-sealing.js";
import { detach, fromSignal, runEdge } from "../runtime/run.js";
import { OAUTH_FLOW_TTL_SECONDS, OAUTH_REFRESH_LEASE_SECONDS, oauthFlowKeys, oauthGrantKeys, oauthRefreshKeys, oauthRefreshSpentKeys, oauthRefreshActiveKeys } from "../storage/keys.js";
import type { ConnectorContext, KVStorage } from "../types.js";
import {
  isRefreshTokenRequest,
  isOAuthCredentialRequest,
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
  type MigratedGrantBody,
} from "./oauth-v2-migration.js";

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
 * consent, with a request scope of its own, carrying the registry's sealer and
 * owner partition across the copy. Only `startAuth` builds one; status reads
 * and calls never do, which is what keeps them from starting authorization.
 */
export function authorizingContext(ctx: ConnectorContext): ConnectorContext {
  return attachOAuthPartition(inheritOAuthSealer(ctx, {
    ...ctx,
    requestScope: ctx.requestScope ?? ctx,
    allowAuthorization: true,
  }), oauthPartitionFor(ctx));
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
  return plainObject(value) && value.connectaOAuthRefreshSpent === 1 &&
    typeof value.epoch === "string" && typeof value.holder === "string" && typeof value.activeKey === "string" &&
    (value.state === "outstanding" || value.state === "ambiguous" ||
      (value.state === "resolved" && typeof value.resolvedAt === "number" && Number.isFinite(value.resolvedAt)))
    ? value as unknown as StoredRefreshSpent : undefined;
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

/** One deadline covers preparation, shared claims, and local joiners. */
interface RefreshWait {
  signal: AbortSignal;
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

function refreshWait(signal?: AbortSignal): RefreshWait {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REFRESH_WAIT_DEADLINE_MS);
  let closed = false;
  const abort = () => deadline.abort(aborted(signal));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    signal: deadline.signal,
    run: <T>(operation: () => Promise<T>) => runEdge(Effect.raceAllFirst<Effect.Effect<T, unknown>>([
      fromSignal(deadline.signal),
      Effect.tryPromise({ try: operation, catch: (error) => error }),
    ])),
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
  return (
    signal?.reason ?? new DOMException("This operation was aborted", "AbortError")
  );
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
  return runEdge(Effect.raceAllFirst<Effect.Effect<RefreshFlightOutcome, unknown>>([
    ...(signal ? [fromSignal(signal)] : []),
    ...(deadline ? [fromSignal(deadline)] : []),
    settled,
  ]));
}

/** Tokens as a token response the SDK parses: only the client stamps an issuer. */
function tokenResponse(tokens: OAuthTokens): Response {
  const { issuer: _issuer, ...answer } = tokens as OAuthTokens & { issuer?: unknown };
  return Response.json(answer);
}

function refreshTokensDigest(tokens: OAuthTokens): Promise<string> {
  const { issuer: _issuer, ...answer } = tokens as OAuthTokens & { issuer?: unknown };
  return oauthStateDigest(JSON.stringify(Object.fromEntries(Object.entries(answer).sort(([a], [b]) => a.localeCompare(b)))));
}

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
  ): FetchLike {
    return async (input, init) => {
      // Freeze the form before any await: classification and the spent digest
      // must describe the exact token sent, even if its caller mutates a form.
      init = init ? { ...init, ...(init.body instanceof URLSearchParams ? { body: new URLSearchParams(init.body) } : {}) } : undefined;
      if (isRefreshTokenRequest(init)) {
        const signal = requestSignal && init?.signal
          ? AbortSignal.any([requestSignal, init.signal])
          : requestSignal ?? init?.signal ?? undefined;
        return this.refresh(provider, input, init, baseFetch, signal, defer);
      }
      const grantType = tokenGrantType(init);
      const tokenRequest = isOAuthCredentialRequest(init);
      const exchange = grantType === "authorization_code";
      if (exchange) {
        const answered = await provider.claimCodeExchange();
        if (answered) return answered;
      }
      const dispatch = () => {
        if (requestSignal?.aborted) throw aborted(requestSignal);
        const signal = requestSignal
          ? init?.signal
            ? AbortSignal.any([requestSignal, init.signal])
            : requestSignal
          : init?.signal;
        // Credential-bearing OAuth requests use the raw send path. A redirect
        // is a dispatched failure, never authority to send the form again.
        return tokenRequest
          ? baseFetch(input, { ...init, redirect: "manual", ...(signal ? { signal } : {}) })
          : resourceFetch(input, { ...init, ...(signal ? { signal } : {}) });
      };
      // Awaited here so workerd associates a rejection with the fetch the SDK
      // is already awaiting, not with an adopted inner promise.
      const response = await (exchange ? provider.dispatchCodeExchange(dispatch, input) : dispatch());
      if (!tokenRequest) return response;
      // A code exchange's failure is the SDK's to log as well.
      const forSdk = await sdkSafeTokenResponse(response, exchange ? (tokens) => provider.recordCodeExchangeTokens(tokens) : undefined);
      if (exchange && forSdk !== response) provider.recordCodeExchangeRefusal(forSdk);
      return forSdk;
    };
  }

  private async refresh(
    provider: KvOAuthProvider,
    input: string | URL,
    init: RequestInit | undefined,
    baseFetch: FetchLike,
    signal: AbortSignal | undefined,
    defer: ConnectorContext["defer"],
  ): Promise<Response> {
    const waiting = refreshWait(signal);
    try {
      // A verdict belongs to one refresh; never let an older one decide this.
      provider.recordRefreshFailure(undefined);
      const epoch = await waiting.run(() => provider.flowEpoch());
      const requested = requestedRefreshToken(init);
      for (let attempt = 0; attempt < 8; attempt++) {
        if (signal?.aborted) throw aborted(signal);
        const joined = this.flights.get(epoch);
        if (joined) {
          const outcome = await waitForRefreshFlight(joined, signal, waiting.signal);
          if (outcome.status === "failed") {
            provider.recordRefreshFailure(outcome.verdict);
            throw outcome.error;
          }
          if (outcome.status === "refreshed") return provider.adoptRefresh(outcome.tokens);
          continue;
        }
        // Preparation reads share the same bound as later claim waits.
        const current = await waiting.run(() => provider.storedTokens());
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
        const redemption = this.redeem(provider, epoch, requested, input, init, baseFetch, signal, waiting);
        // The refresh owns its completion after dispatch, including storage.
        // Attach it before yielding so a cancelled Worker keeps that work alive.
        try {
          detach(Effect.promise(() => redemption), defer ? { waitUntil: defer } : undefined);
        } catch {
          // A missing or refusing runtime hook still leaves the promise running.
        }
        if (!signal) return await redemption;
        return await runEdge(Effect.raceAllFirst<Effect.Effect<Response, unknown>>([
          Effect.tryPromise({ try: () => redemption, catch: (error) => error }),
          fromSignal(signal),
        ]));
      }
      throw provider.refreshContended();
    } catch (error) {
      if (signal?.aborted) throw aborted(signal);
      if (waiting.signal.aborted) throw provider.refreshContended();
      throw error;
    } finally {
      waiting.close();
    }
  }

  private async redeem(
    provider: KvOAuthProvider,
    epoch: string,
    requested: string | null,
    input: string | URL,
    init: RequestInit | undefined,
    baseFetch: FetchLike,
    signal: AbortSignal | undefined,
    waiting: RefreshWait,
  ): Promise<Response> {
    const flight: RefreshFlight = { outcome: Deferred.makeUnsafe() };
    this.flights.set(epoch, flight);
    // Pin the owner partition until the flight settles, whoever is waiting.
    const release = this.retainPartition();
    const settle = (outcome: RefreshFlightOutcome) => {
      if (this.flights.get(epoch) === flight) this.flights.delete(epoch);
      release();
      // Last, because joined fibers resume inside this call.
      Deferred.doneUnsafe(flight.outcome, Effect.succeed(outcome));
    };
    const fail = (error: unknown, verdict?: RefreshFailure) => {
      if (verdict) provider.recordRefreshFailure(verdict);
      settle({ status: "failed", error, ...(verdict ? { verdict } : {}) });
    };
    // The authorization server this redemption answers to, fixed now.
    const issuer = provider.refreshIssuer(epoch);
    let lease: RefreshLease;
    try {
      const claim = await provider.claimRefresh(epoch, requested, signal, waiting);
      if (claim instanceof Response) {
        const tokens = await waiting.run(() => provider.storedTokens());
        if (tokens) settle({ status: "refreshed", tokens });
        else settle({ status: "retired" });
        return claim;
      }
      lease = claim;
    } catch (error) {
      fail(error, provider.refreshVerdict());
      throw error;
    }
    const releaseLease = async (verdict?: RefreshFailure, resolution: "resolved" | "ambiguous" = "ambiguous") => {
      await provider.releaseRefresh(lease, verdict, undefined, resolution);
    };
    let outcome: RefreshResponseOutcome;
    const deadline = new AbortController();
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = provider.dispatchRefresh(lease, () => {
        if (signal?.aborted) throw aborted(signal);
        if (init?.signal?.aborted) throw aborted(init.signal);
        dispatched = true;
        // Preparation remains bounded through the send transition. After
        // dispatch, caller cancellation must not prevent an answer's commit.
        waiting.close();
        // Start the deadline at dispatch, including the response body read.
        timer = setTimeout(() => {
          deadline.abort(new DOMException("OAuth refresh timed out", "TimeoutError"));
        }, REFRESH_REQUEST_DEADLINE_MS);
        return baseFetch(input, { ...init, redirect: "manual", signal: deadline.signal });
      }, waiting).then((response) => {
        if (deadline.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw aborted(deadline.signal);
        }
        return refreshResponseOutcome(response, deadline.signal);
      });
      // The deadline can settle the race before a late fetch/body rejects.
      void read.catch(() => {});
      outcome = await runEdge(Effect.raceAllFirst<Effect.Effect<RefreshResponseOutcome, unknown>>([
        Effect.tryPromise({ try: () => read, catch: (error) => error }),
        fromSignal(deadline.signal),
      ]));
      if (deadline.signal.aborted) throw aborted(deadline.signal);
    } catch (error) {
      if (!dispatched) {
        // A cancelled or timed-out unsent holder leaves a safely expiring
        // claim. Cleanup must not retain its local flight or partition pin.
        if (!waiting.signal.aborted && !signal?.aborted && !init?.signal?.aborted) {
          await waiting.run(() => releaseLease()).catch(() => {});
          if (provider.refreshVerdict()?.kind === "dead") {
            await waiting.run(() => provider.discardRefusedGrant(requested, epoch)).catch(() => {});
          }
        }
        const failure = !signal?.aborted && waiting.signal.aborted ? provider.refreshContended() : error;
        fail(failure, provider.refreshVerdict());
        throw failure;
      }
      // A sent request without a definitive answer may have rotated the token.
      // Persist the refusal before dropping tokens, so interrupted cleanup or a
      // later write of the same fingerprint cannot make it redeemable again.
      const failure = new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
      await releaseLease({ kind: "dead" });
      await provider.discardRefusedGrant(requested, epoch);
      fail(failure, { kind: "dead" });
      throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // An answer exists from here on, and is committed whatever the owner does.
    if (outcome.failure) {
      // Drop a refused grant while the flight still stands: a caller arriving
      // meanwhile joins it instead of redeeming the dead token again.
      await provider.discardRefusedGrant(requested, epoch);
      await releaseLease(outcome.verdict, "resolved");
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
      committed = await provider.storeRefresh(epoch, requested, accepted, issuer);
    } catch {
      const failure = new UnauthorizedError("OAuth refresh could not be committed; authorization required.");
      await releaseLease({ kind: "dead" }, "resolved");
      await provider.discardRefusedGrant(requested, epoch);
      fail(failure, { kind: "dead" });
      throw failure;
    }
    if (!committed) {
      // Restart, Disconnect, or another consent decides the newer grant.
      await releaseLease({ kind: "dead" }, "resolved");
      const failure = new UnauthorizedError("OAuth refresh grant is no longer active.");
      fail(failure, { kind: "dead" });
      throw failure;
    }
    await provider.releaseRefresh(lease, undefined, committed, "resolved");
    settle({ status: "refreshed", tokens: committed });
    return provider.adoptRefresh(committed);
  }

  /** A reset fenced `epoch`: wake its joiners now rather than at the answer. */
  retire(epoch: string): void {
    const flight = this.flights.get(epoch);
    if (!flight) return;
    this.flights.delete(epoch);
    Deferred.doneUnsafe(flight.outcome, Effect.succeed({ status: "retired" }));
  }
}

/**
 * One refresh coordinator per owner partition, for one connector runtime.
 * Long-lived enough for distinct request scopes to join one token redemption;
 * it owns no client, transport, or request state. Production contexts carry a
 * stable registry partition; hand-written contexts coordinate by their shared
 * storage object instead.
 */
export function refreshCoordinatorsByPartition(): (
  ctx: ConnectorContext,
) => OAuthRefreshCoordinator {
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

async function discoveryBinding(state: OAuthDiscoveryState | undefined): Promise<FlowBinding> {
  return state ? {
    issuer: discoveryIssuer(state),
    tokenEndpoint: state.authorizationServerMetadata?.token_endpoint,
    ...(state.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true ? { issRequired: true as const } : {}),
    discovery: await oauthStateDigest(JSON.stringify(state)),
  } : {};
}

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
          },
        }
      : {}),
    ...(plainObject(tokens) && typeof tokens.access_token === "string"
      ? { tokens: tokens as unknown as OAuthTokens }
      : {}),
    ...(discoveryIssuer(discovery) !== undefined
      ? { discovery: discovery as unknown as OAuthDiscoveryState }
      : {}),
    ...(plainObject(refreshConsent) && typeof refreshConsent.digest === "string" && typeof refreshConsent.resolution === "string"
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
  private callback:
    | { key: string; raw: string; flow: Flow; claimed: boolean }
    | undefined;
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
    /** Request ownership for a start; a timed-out SDK hook may still resume. */
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
    private readonly clientOptions?: { name?: string | undefined; client?: RemoteOAuthClient | undefined },
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
    return downstreamClientMetadata(this.redirectUri, this.scope, this.clientOptions?.name,
      client?.tokenEndpointAuthMethod ?? (client?.clientSecret === undefined ? "none" : "client_secret_basic"));
  }

  // --- the grant record ---------------------------------------------------

  /** The grant's additional authenticated data: record and epoch. */
  private grantLabel(epoch: string): string {
    return `${GRANT}:${epoch}`;
  }

  private async encodeGrant(grant: Grant): Promise<string> {
    const stored: StoredGrant = {
      connectaOAuth: GRANT_VERSION,
      epoch: grant.epoch,
      ...(grant.cleanupPending ? { cleanupPending: true as const } : {}),
      ...(grant.flow !== undefined ? { flow: grant.flow } : {}),
    };
    if (Object.keys(grant.body).length > 0) {
      if (this.sealer) {
        stored.sealed = await this.sealer.seal(this.grantLabel(grant.epoch), JSON.stringify(grant.body));
      } else {
        stored.body = grant.body;
      }
    }
    return JSON.stringify(stored);
  }

  /**
   * Open a stored grant. A body that does not open — tampered, under a
   * rotated key, moved from another connector, owner, or epoch, or sealed
   * with no sealer configured — reads as empty: authorization again.
   */
  private async openGrant(raw: string | null): Promise<Grant> {
    if (raw === null) return { epoch: INITIAL_EPOCH, body: {} };
    const stored = storedGrant(raw);
    if (!stored) return { epoch: UNREADABLE_EPOCH, body: {} };
    let body: unknown = stored.body;
    if (stored.sealed !== undefined) {
      body = undefined;
      try {
        if (this.sealer) body = parsed(await this.sealer.open(this.grantLabel(stored.epoch), stored.sealed));
      } catch {
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
  }

  /**
   * The grant as stored now, migrating layout 2 on first sight. A plaintext
   * body, written before the vault could seal, is sealed where it lies by
   * compare-and-set; a failure leaves it readable for the next write to seal.
   */
  private async readGrant(): Promise<{ raw: string | null; grant: Grant }> {
    let raw = await this.storage.get(GRANT);
    if (raw === null) raw = await this.migrate();
    if (raw !== null && storedGrant(raw)?.cleanupPending) raw = await this.cleanupV2(raw);
    const grant = await this.openGrant(raw);
    if (raw !== null && this.sealer && storedGrant(raw)?.body !== undefined && !this.signal?.aborted) {
      const sealed = await this.encodeGrant(grant);
      if (await this.storage.compareAndSet(GRANT, raw, sealed).catch(() => false)) raw = sealed;
    }
    return { raw, grant };
  }

  /**
   * Layout 2's grant, written once as this owner's record. Whichever request
   * writes first wins; the layout 2 keys are deleted once a record exists.
   */
  private async migrate(): Promise<string | null> {
    const found = await readV2Grant(this.storage, this.sealer);
    // A request that has already left writes nothing, this included.
    if (!found || this.signal?.aborted) return null;
    const prefix = found.disconnected ? DISCONNECTED_EPOCH_PREFIX : ACTIVE_EPOCH_PREFIX;
    const encoded = await this.encodeGrant({ epoch: `${prefix}${crypto.randomUUID()}`, body: found.body, cleanupPending: true });
    let written: boolean;
    try {
      written = await this.storage.compareAndSet(GRANT, null, encoded);
    } catch {
      // A store's own error can quote the value it refused.
      throw this.credentialWriteError();
    }
    const raw = written ? encoded : await this.storage.get(GRANT);
    return raw;
  }

  /** Deletion is retried on every read, including reads after a reset. */
  private async cleanupV2(raw: string): Promise<string | null> {
    try {
      if (!(await deleteV2Keys(this.storage))) return raw;
      const grant = await this.openGrant(raw);
      delete grant.cleanupPending;
      const cleared = await this.encodeGrant(grant);
      if (await this.storage.compareAndSet(GRANT, raw, cleared)) return cleared;
      return this.storage.get(GRANT);
    } catch {
      // The durable marker survives both deletion and marker-clear failures.
      return raw;
    }
  }

  /** The grant a bound flow reads: a replaced epoch fails it. */
  private async boundGrant(): Promise<Grant> {
    const { grant } = await this.readGrant();
    if (this.bound && grant.epoch !== this.epoch) throw this.flowSuperseded();
    return grant;
  }

  /**
   * The one way a grant changes: read, change, compare-and-set, again while
   * other writers win. The write belongs to `epoch` (default: the flow's,
   * captured now if unset) and lands nowhere once another is live: `quiet`
   * drops it silently, otherwise a bound flow fails as superseded. `commit`
   * writes after the request's abort too. `change` returning undefined
   * leaves the grant as it is.
   */
  private async updateGrant(
    change: (grant: Grant) => Grant | undefined,
    options: { epoch?: string; quiet?: boolean; commit?: boolean } = {},
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
      if (!options.commit && this.signal?.aborted) return false;
      const { raw, grant } = await this.readGrant();
      const epoch = options.epoch ?? (this.epoch ??= grant.epoch);
      if (grant.epoch !== epoch) {
        if (options.quiet || !this.bound) return false;
        throw this.flowSuperseded();
      }
      // A disconnect's epoch holds nothing until an explicit start replaces it.
      if (isDisconnectedEpoch(epoch)) return false;
      const next = change(grant);
      if (next === undefined) return true;
      const encoded = await this.encodeGrant(next);
      if (!options.commit && this.signal?.aborted) return false;
      let written: boolean;
      try {
        written = await this.storage.compareAndSet(GRANT, raw, encoded);
      } catch {
        // A store's own error can quote the value it refused.
        throw this.credentialWriteError();
      }
      if (written) {
        if (next.epoch !== grant.epoch) this.epoch = next.epoch;
        return true;
      }
    }
    throw this.credentialWriteError();
  }

  /** Store a client or tokens for `issuer`'s grant, replacing another server's. */
  private async writeCredential(
    field: "client" | "tokens",
    value: NonNullable<GrantBody["client"] | GrantBody["tokens"]>,
    issuer: string | undefined,
    refreshConsent?: GrantBody["refreshConsent"],
  ): Promise<void> {
    await this.updateGrant((grant) => {
      const body: GrantBody =
        issuer !== undefined && grant.body.issuer !== issuer ? { issuer } : { ...grant.body };
      if (field === "client") body.client = value as NonNullable<GrantBody["client"]>;
      else {
        body.tokens = value as OAuthTokens;
        delete body.refreshConsent;
        if (refreshConsent) body.refreshConsent = refreshConsent;
      }
      return this.withIssuer(grant, body);
    });
    // A flow may invalidate what it wrote itself.
    this.seen[field] = fingerprint(field === "client"
      ? (value as NonNullable<GrantBody["client"]>).value
      : value);
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

  private async bindingForGrant(grant: Grant): Promise<FlowBinding> {
    const configured = this.configuredAuthorizationBinding();
    return configured ? { ...configured, issuer: grant.body.issuer } : {
      ...await discoveryBinding(grant.body.discovery),
      issuer: grant.body.issuer,
      clientId: grant.body.client?.value.client_id,
    };
  }

  private async checkFlowBinding(grant: Grant): Promise<void> {
    const binding = this.callback?.flow.binding;
    if (!binding || fingerprint(binding) !== fingerprint(await this.bindingForGrant(grant))) {
      throw this.flowSuperseded();
    }
  }

  /** Validate RFC 9207 against the server this consent selected. */
  validateCallbackIssuer(issuer: string | null): void {
    if (!this.callback || (issuer === null ? this.callback.flow.binding?.issRequired === true : issuer !== this.callback.flow.binding?.issuer)) {
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

  private async encodeFlow(key: string, flow: Flow): Promise<string> {
    const { verifier, ...rest } = flow;
    const stored: StoredFlow = { connectaOAuthFlow: FLOW_VERSION, ...rest };
    if (verifier !== undefined) {
      if (this.sealer) {
        stored.verifier = await this.sealer.seal(this.flowLabel(key, flow.epoch), verifier);
        stored.sealed = true;
      } else {
        stored.verifier = verifier;
      }
    }
    return JSON.stringify(stored);
  }

  /** A flow record, its verifier opened only when `withVerifier`. */
  private async openFlow(key: string, raw: string, withVerifier: boolean): Promise<Flow | undefined> {
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
      return { ...flow, verifier: await this.sealer.open(this.flowLabel(key, flow.epoch), value.verifier) };
    } catch {
      this.sealer?.warn(
        `[connecta] connector "${this.connectorId}" has a sealed OAuth consent ` +
          "the configured vault cannot open; its callback is refused.",
      );
      return undefined;
    }
  }

  /** The live epoch's latest consent, until a callback claims it. */
  private async latestConsent(): Promise<Flow & { url: string } | undefined> {
    const grant = await this.boundGrant();
    if (grant.flow === undefined) return undefined;
    const key = oauthFlowKeys.flow(grant.flow);
    const raw = await this.storage.get(key);
    const flow = raw === null ? undefined : await this.openFlow(key, raw, false);
    return flow && !flow.consumed && flow.epoch === grant.epoch && flow.url !== undefined
      ? { ...flow, url: flow.url }
      : undefined;
  }

  // --- flows and epochs -----------------------------------------------------

  /** The live epoch; an owner with no grant yet has the initial one. */
  async liveEpoch(): Promise<string> {
    return (await this.readGrant()).grant.epoch;
  }

  /** True only after an operator disconnect, until an explicit start replaces it. */
  async operatorDisconnected(): Promise<boolean> {
    return isDisconnectedEpoch(await this.liveEpoch());
  }

  isOperatorDisconnectedEpoch(epoch: string): boolean {
    return isDisconnectedEpoch(epoch);
  }

  /**
   * Begin a flow — a connect, whose 401 may refresh or start consent, or an
   * `api()` call or start — in the live epoch, and return it. Nothing about
   * the grant is decided here: a grant belongs to one server by construction.
   */
  async beginFlow(): Promise<string> {
    const epoch = await this.liveEpoch();
    this.epoch = epoch;
    this.bound = true;
    return epoch;
  }

  /** The epoch this flow is bound to, or the live one. */
  async flowEpoch(): Promise<string> {
    return this.epoch ?? (await this.liveEpoch());
  }

  /**
   * Bind a code exchange: to the epoch its verified consent was written in, or
   * the live one for an exchange no callback verified. An epoch already
   * replaced fails here, before the SDK can send anything. What the grant
   * holds now is all a refused code may invalidate.
   */
  async bindFlow(): Promise<void> {
    const { grant } = await this.readGrant();
    const epoch = this.callback?.flow.epoch ?? this.epoch ?? grant.epoch;
    if (grant.epoch !== epoch) throw this.flowSuperseded();
    this.epoch = epoch;
    this.bound = true;
    this.codeExchange = true;
    await this.checkFlowBinding(grant);
    this.seen = {
      client: fingerprint(grant.body.client?.value),
      tokens: fingerprint(grant.body.tokens),
    };
  }

  /** Retain an already verified snapshot only for the exact same state. */
  async verifyCallbackState(state: string): Promise<boolean> {
    if (this.callback?.key === oauthFlowKeys.flow(await oauthStateDigest(state))) return true;
    return this.verifyState(state);
  }

  /** Whether `verifyState` matched a consent on this provider. */
  verified(): boolean {
    return this.callback !== undefined;
  }

  /** The fixed, retryable failure of a flow a later reset superseded. */
  private flowSuperseded(): ConnectorCallError {
    return new ConnectorCallError(
      "unavailable",
      `Connector "${this.connectorId}" authorization changed while this request was in flight; try again.`,
    );
  }

  /**
   * A credential write that storage refused, in fixed text and with no cause
   * attached. Retryable: the grant it held is untouched.
   */
  private credentialWriteError(): ConnectorCallError {
    return new ConnectorCallError(
      "unavailable",
      `Connector "${this.connectorId}" could not store its OAuth credentials; try again shortly.`,
    );
  }

  /** @internal Other requests kept refreshing faster than this one could join. */
  refreshContended(): ConnectorCallError {
    this.recordRefreshFailure({ kind: "contended" });
    return new ConnectorCallError(
      "unavailable",
      `Connector "${this.connectorId}" could not refresh its OAuth grant while other requests were; retry.`,
    );
  }

  /**
   * A passive call cannot start consent. A waiter deadline remains retryable;
   * any dispatched failure requires consent because its token is spent.
   */
  private authorizationRefused(): Error {
    const failure = this.refreshFailure;
    if (failure?.kind === "contended") return this.refreshContended();
    return new UnauthorizedError(
      "Authorization required. Use authorize_connector or Connect to start consent.",
    );
  }

  // --- the SDK's hooks --------------------------------------------------------

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<OAuthClientInformationMixed | undefined> {
    const { body } = await this.boundGrant();
    const client = this.clientOptions?.client;
    if (client) {
      if ((ctx && ctx.issuer !== client.issuer) || body.issuer !== client.issuer) throw this.flowSuperseded();
      if (!body.client) await this.saveClientInformation({ client_id: client.clientId }, { issuer: client.issuer });
      else if (body.client.value.client_id !== client.clientId || body.client.binding !== this.clientBinding) throw this.flowSuperseded();
      return { client_id: client.clientId, issuer: client.issuer,
        token_endpoint_auth_method: this.clientMetadata.token_endpoint_auth_method,
        ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {}) };
    }
    if (!body.client || (ctx && body.issuer !== ctx.issuer)) return undefined;
    this.seen.client = fingerprint(body.client.value);
    return ctx ? { ...body.client.value, issuer: ctx.issuer } : body.client.value;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.writeCredential(
      "client",
      { value: this.clientOptions?.client ? { client_id: this.clientOptions.client.clientId } : info, ...(this.clientBinding !== undefined ? { binding: this.clientBinding } : {}) },
      ctx?.issuer,
    );
  }

  async registrationPath(): Promise<"cimd" | "dcr" | "static" | undefined> {
    const { body } = await this.boundGrant();
    if (!body.client) return undefined;
    if (this.clientOptions?.client) return body.issuer === this.clientOptions.client.issuer && body.client.value.client_id === this.clientOptions.client.clientId ? "static" : undefined;
    return body.client.value.client_id === this.clientMetadataUrl ? "cimd" : "dcr";
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = (await this.boundGrant()).body.discovery;
    this.consentDiscovery = state;
    return state;
  }

  /**
   * Discovery names the grant's server: the same one keeps the client and
   * tokens beside it, another replaces them. The SDK discovers afresh only
   * without a cached record — a restart's carried client, say — and what a
   * different server leaves behind would never be sent to it anyway.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const issuer = discoveryIssuer(state);
    if (this.clientOptions?.client && issuer !== this.clientOptions.client.issuer) throw this.flowSuperseded();
    this.consentDiscovery = state;
    await this.updateGrant((grant) => {
      const body: GrantBody = grant.body.issuer !== issuer
        ? (issuer !== undefined ? { issuer } : {})
        : { ...grant.body };
      body.discovery = state;
      return this.withIssuer(grant, body);
    });
  }

  /**
   * The grant's tokens, for the server that issued them only. An
   * issuer-aware read records what it handed the SDK, so the coordinator can
   * tell a refresh another request completed since.
   */
  async tokens(ctx?: OAuthClientInformationContext): Promise<OAuthTokens | undefined> {
    const grant = await this.boundGrant();
    const { tokens } = grant.body;
    if (!tokens || (ctx && grant.body.issuer !== ctx.issuer)) return undefined;
    this.seen.tokens = fingerprint(tokens);
    if (!ctx) return tokens;
    this.refreshBasis = { accessToken: tokens.access_token, epoch: grant.epoch, issuer: ctx.issuer };
    return { ...tokens, issuer: ctx.issuer };
  }

  async saveTokens(tokens: OAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    if (this.refreshFailure?.kind === "dead") throw this.authorizationRefused();
    // The coordinator stored this refresh already, or handed on another's.
    if (this.storedRefresh !== undefined && tokens.access_token === this.storedRefresh) return;
    const refreshConsent = this.exchangeConsent && tokens.refresh_token !== undefined &&
      this.exchangeConsent.digest === await oauthStateDigest(tokens.refresh_token) ? this.exchangeConsent : undefined;
    await this.writeCredential("tokens", tokens, ctx?.issuer, refreshConsent);
    this.refreshFailure = undefined;
  }

  /**
   * OAuth `state`: 256 random bits the consent URL carries and the callback
   * must present, so nobody holding a consent URL can complete it with their
   * own account (login CSRF). Stored, by digest, with the consent.
   */
  async state(): Promise<string> {
    if (!this.allowAuthorization) throw this.authorizationRefused();
    const state = randomState();
    this.consent = { state };
    return state;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.allowAuthorization) throw this.authorizationRefused();
    this.consent = { ...this.consent, verifier };
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.callback?.flow.verifier ?? this.consent.verifier;
    if (verifier === undefined) {
      throw new Error(`No PKCE code verifier for "${this.connectorId}"`);
    }
    return verifier;
  }

  /**
   * Store the consent: its flow record first, by state digest with the
   * link's lifetime, then the grant's pointer to it, in the flow's epoch. A
   * reset that replaced the epoch fails the start, and the record is removed,
   * so no start hands out a consent its callback could not complete.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.allowAuthorization) throw this.authorizationRefused();
    const state = this.consent.state ?? authorizationUrl.searchParams.get("state");
    if (!state) throw new Error(`OAuth consent for "${this.connectorId}" carries no state`);
    const configured = this.configuredAuthorizationBinding();
    if (configured?.issuer !== undefined) {
      const issuer = configured.issuer;
      // Static adapters do not save discovery or client configuration. Publish
      // their server identity before consent so a changed endpoint fences the
      // old grant before any code exchange can leave.
      await this.updateGrant((grant) => grant.body.issuer === issuer
        ? undefined
        : this.withIssuer(grant, { issuer }));
    }
    const epoch = await this.flowEpoch();
    this.epoch = epoch;
    const digest = await oauthStateDigest(state);
    const key = oauthFlowKeys.flow(digest);
    const url = authorizationUrl.toString();
    const { verifier } = this.consent;
    const grant = await this.boundGrant();
    const binding = this.configuredAuthorizationBinding() ?? {
      ...await discoveryBinding(this.consentDiscovery ?? grant.body.discovery),
      issuer: discoveryIssuer(this.consentDiscovery) ?? grant.body.issuer,
      clientId: authorizationUrl.searchParams.get("client_id") ?? grant.body.client?.value.client_id,
    };
    const record = await this.encodeFlow(key, {
      epoch,
      at: Date.now(),
      binding,
      url,
      ...(verifier !== undefined ? { verifier } : {}),
    });
    if (this.signal?.aborted) return;
    if (!(await this.storage.compareAndSet(key, null, record, { ttlSeconds: OAUTH_FLOW_TTL_SECONDS }))) {
      throw new Error(`OAuth consent for "${this.connectorId}" reused a state`);
    }
    let published = false;
    try {
      published = await this.updateGrant((grant) => ({ ...grant, flow: digest }), { epoch });
    } finally {
      if (!published) await this.storage.compareAndSet(key, record, null).catch(() => {});
    }
    if (published) this.published = { epoch, url };
  }

  /** The consent this provider stored, while its epoch is still live. */
  async consentUrl(): Promise<string | undefined> {
    const published = this.published;
    if (!published) return undefined;
    if (epochOf(await this.storage.get(GRANT)) !== published.epoch) throw this.flowSuperseded();
    return published.url;
  }

  /** The live epoch's pending consent URL, if one is unclaimed. */
  async pendingAuthorizationUrl(): Promise<string | undefined> {
    return (await this.latestConsent())?.url;
  }

  /**
   * The pending consent URL, only while it is still worth handing out again:
   * unclaimed, written within PENDING_AUTHORIZATION_MAX_AGE_MS of now in
   * either direction (clock skew between isolates), and naming the grant's
   * client. A callback whose exchange the server refused with
   * `invalid_client` drops the client, and its URL would send the operator to
   * a consent the server has already refused.
   */
  async reusablePendingAuthorizationUrl(): Promise<string | undefined> {
    const consent = await this.latestConsent();
    if (!consent || Math.abs(Date.now() - consent.at) >= PENDING_AUTHORIZATION_MAX_AGE_MS) {
      return undefined;
    }
    let clientId: string | null;
    try {
      clientId = new URL(consent.url).searchParams.get("client_id");
    } catch {
      return undefined;
    }
    const client = await this.clientInformation();
    return clientId !== null && client?.client_id === clientId ? consent.url : undefined;
  }

  /**
   * Find the consent a callback's `state` names. One read whatever the
   * answer; the callback route's refusals pay the same. A claimed consent
   * no longer matches.
   */
  async verifyState(candidate: string | null): Promise<boolean> {
    this.callback = undefined;
    if (candidate === null) return false;
    const key = oauthFlowKeys.flow(await oauthStateDigest(candidate));
    const raw = await this.storage.get(key);
    const flow = raw === null ? undefined : await this.openFlow(key, raw, true);
    if (raw === null || !flow || flow.consumed) return false;
    this.callback = { key, raw, flow, claimed: false };
    this.epoch = flow.epoch;
    return true;
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
  async claimCodeExchange(): Promise<Response | undefined> {
    if (this.exchangeRefusal) return this.exchangeRefusal.clone();
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
    if (await this.storage.compareAndSet(callback.key, callback.raw, claimed, { ttlSeconds })) {
      return undefined;
    }
    if (epochOf(await this.storage.get(GRANT)) !== epoch) throw this.flowSuperseded();
    throw new OAuthCallbackClaimedError(this.connectorId);
  }

  /**
   * @internal The second half: read the live epoch and, in the reaction to
   * that read, dispatch. No await stands between the check and `send`. A
   * reset published at or before the read fails the exchange with nothing
   * sent; one published after it, while the request is leaving, cannot be
   * ordered before the send without a lock across requests, and its tokens
   * are refused by the grant's compare-and-set: one more consent.
   */
  async dispatchCodeExchange(send: () => Promise<Response>, endpoint?: string | URL): Promise<Response> {
    const epoch = this.epoch;
    if (!this.codeExchange || epoch === undefined) throw this.flowSuperseded();
    const raw = await this.storage.get(GRANT);
    const grant = await this.openGrant(raw);
    if (grant.epoch !== epoch) throw this.flowSuperseded();
    await this.checkFlowBinding(grant);
    if (endpoint !== undefined && this.callback?.flow.binding?.tokenEndpoint !== String(endpoint)) {
      throw this.flowSuperseded();
    }
    // Opening ciphertext may yield. Re-read the exact record after opening,
    // then check and send in the same reaction, without another await.
    return this.storage.get(GRANT).then((current) => {
      if (current !== raw) throw this.flowSuperseded();
      const sent = send();
      sent.catch(() => {});
      return sent;
    });
  }

  /** @internal Keep a refused code's answer for the SDK's retry to read. */
  recordCodeExchangeRefusal(forSdk: Response): void {
    this.exchangeRefusal = forSdk.clone();
  }

  /** @internal Observe resolution while accepting the code response, never on a later SDK save. */
  async recordCodeExchangeTokens(tokens: OAuthTokens): Promise<void> {
    this.exchangeConsent = undefined;
    if (tokens.refresh_token === undefined) return;
    try {
      const digest = await oauthStateDigest(tokens.refresh_token);
      const resolution = await this.storage.get(oauthRefreshSpentKeys.spent(digest));
      const spent = storedRefreshSpent(resolution);
      // Observing the exact resolved storage write before consent completion
      // proves their order without comparing isolate clocks. A consent that
      // saw outstanding/ambiguous cannot become eligible on a delayed save.
      if (spent?.state === "resolved") this.exchangeConsent = { digest, resolution: resolution! };
    } catch {
      throw this.credentialWriteError();
    }
  }

  /**
   * Remove what the SDK asks, but only as this flow saw it: a refused code or
   * refresh says nothing about a client or tokens another flow wrote since.
   * The verifier lives in its consent, which the claim already spent.
   */
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const fields = {
      all: ["client", "tokens", "discovery"],
      client: ["client"],
      tokens: ["tokens"],
      discovery: ["discovery"],
      verifier: [],
    }[scope] as Array<"client" | "tokens" | "discovery">;
    if (fields.length > 0) {
      await this.updateGrant((grant) => {
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
      }, { quiet: true });
    }
    // The SDK invalidates after a refused refresh and then starts over, which
    // on `invalid_client` means registering a new client. A passive request
    // must not begin authorization, so it ends here, as auth_required.
    if (!this.allowAuthorization && this.refreshFailure?.kind === "dead") {
      throw this.authorizationRefused();
    }
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
  async claimRefresh(epoch: string, requested: string | null, signal?: AbortSignal, sharedWait?: RefreshWait): Promise<RefreshLease | Response> {
    const waiting = sharedWait ?? refreshWait(signal);
    const wait = waiting.run;
    let delay = 10;
    try {
      const digest = await wait(() => oauthStateDigest(requested ?? ""));
      const key = oauthRefreshKeys.lease(epoch, digest);
      const spentKey = oauthRefreshSpentKeys.spent(digest);
      while (!waiting.signal.aborted) {
        if (signal?.aborted) throw aborted(signal);
        const current = await wait(() => this.storedTokens());
        if (current?.refresh_token !== requested || (current && this.refreshedSinceRead(current, epoch))) {
          if (!current) this.recordRefreshFailure({ kind: "dead" });
          return current ? this.adoptRefresh(current) : Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const raw = await wait(() => this.storage.get(key));
        const stored = raw === null ? undefined : parsed(raw);
        if (plainObject(stored) && stored.completed === true && current &&
          stored.tokenDigest === await wait(() => refreshTokensDigest(current))) {
          return this.adoptRefresh(current);
        }
        if (plainObject(stored) && (plainObject(stored.verdict) || stored.completed === true)) {
          this.recordRefreshFailure({ kind: "dead" });
          await wait(() => this.discardRefusedGrant(requested, epoch));
          throw new UnauthorizedError("OAuth refresh grant is no longer active.");
        }
        if (plainObject(stored) && stored.state !== "claimed") {
          // Never compare another isolate's clock for a sent request. The
          // durable record survives expiry of this storage-owned liveness key.
          const active = typeof stored.activeKey === "string" ? await wait(() => this.storage.get(stored.activeKey as string)) : null;
          if (active === null) {
            const refused = JSON.stringify({ ...stored, verdict: { kind: "dead" } });
            if (await wait(() => this.storage.compareAndSet(key, raw, refused))) {
              await wait(() => this.resolveRefreshSpent({ key, spentKey, spentExpected: null, raw: raw! }, "ambiguous"));
              this.recordRefreshFailure({ kind: "dead" });
              await wait(() => this.discardRefusedGrant(requested, epoch));
              throw new UnauthorizedError("OAuth refresh outcome is unknown; authorization required.");
            }
            continue;
          }
        } else {
          const spentExpected = await wait(() => this.storage.get(spentKey));
          if (spentExpected !== null) {
            const spent = storedRefreshSpent(spentExpected);
            const consent = (await wait(() => this.boundGrant())).body.refreshConsent;
            if (spent?.state !== "resolved" || spent.epoch === epoch ||
              consent?.digest !== digest || consent.resolution !== spentExpected) {
              // Reset can sweep the old lease while its request remains live.
              // Only storage-owned expiry can make an outstanding send ambiguous.
              if (spent?.state === "outstanding" && await wait(() => this.storage.get(spent.activeKey)) === null) {
                await wait(() => this.storage.compareAndSet(spentKey, spentExpected, JSON.stringify({ ...spent, state: "ambiguous" })));
              }
              this.recordRefreshFailure({ kind: "dead" });
              await wait(() => this.discardRefusedGrant(requested, epoch));
              throw new UnauthorizedError("OAuth refresh token was already spent; authorization required.");
            }
          }
          if (raw === null || (plainObject(stored) && typeof stored.expiresAt === "number" && stored.expiresAt <= this.refreshNow())) {
            // Clock skew can replace an unsent claim; its dispatch CAS then loses.
            const claimed = JSON.stringify({
              connectaOAuthRefresh: 1,
              holder: crypto.randomUUID(),
              state: "claimed",
              expiresAt: this.refreshNow() + OAUTH_REFRESH_LEASE_SECONDS * 1000,
            } satisfies StoredRefreshLease);
            let won: boolean;
            try {
              won = await wait(() => this.storage.compareAndSet(key, raw, claimed));
            } catch {
              throw this.credentialWriteError();
            }
            if (won) {
              try {
                const latest = await wait(() => this.storedTokens());
                if (latest?.refresh_token !== requested || (latest && this.refreshedSinceRead(latest, epoch))) {
                  await wait(() => this.releaseRefresh({ key, spentKey, spentExpected, raw: claimed }));
                  return latest ? this.adoptRefresh(latest) : Response.json({ error: "invalid_grant" }, { status: 400 });
                }
                if (signal?.aborted) throw aborted(signal);
                return { key, spentKey, spentExpected, raw: claimed };
              } catch (error) {
                // An unsent claim can expire safely. A caller that has left must
                // settle its local flight without awaiting cleanup storage.
                if (!waiting.signal.aborted && !signal?.aborted) {
                  await wait(() => this.releaseRefresh({ key, spentKey, spentExpected, raw: claimed }));
                }
                throw error;
              }
            }
          }
        }
        await runEdge(Effect.raceAllFirst([
          Effect.sleep(delay), fromSignal(waiting.signal), ...(signal ? [fromSignal(signal)] : []),
        ]));
        delay = Math.min(250, delay * 2);
      }
    } catch (error) {
      if (signal?.aborted) throw aborted(signal);
      if (!waiting.signal.aborted) throw error;
    } finally {
      if (!sharedWait) waiting.close();
    }
    throw this.refreshContended();
  }

  /** @internal Only the successful claimed-to-dispatched CAS may send. */
  async dispatchRefresh(lease: RefreshLease, send: () => Promise<Response>, waiting: RefreshWait): Promise<Response> {
    const stored = parsed(lease.raw) as StoredRefreshLease;
    const epoch = await waiting.run(() => this.flowEpoch());
    const activeKey = oauthRefreshActiveKeys.holder(epoch, stored.holder);
    await waiting.run(() => this.storage.set(activeKey, JSON.stringify({ connectaOAuthRefresh: 1 }), { ttlSeconds: OAUTH_REFRESH_LEASE_SECONDS }));
    const dispatched = JSON.stringify({ ...stored, state: "dispatched", activeKey } satisfies StoredRefreshLease);
    const transition = this.storage.compareAndSet(lease.key, lease.raw, dispatched).then((won) => {
      if (!won) throw this.refreshContended();
      lease.raw = dispatched;
      if (waiting.signal.aborted) throw aborted(waiting.signal);
    });
    void transition.catch(() => {});
    await waiting.run(() => transition);
    // One CAS owns the fingerprint across every epoch. Only a later consent
    // that observed a resolved write may replace it. No TTL or deletion path.
    lease.spentRaw = JSON.stringify({
      connectaOAuthRefreshSpent: 1, epoch, holder: stored.holder, activeKey, state: "outstanding",
    } satisfies StoredRefreshSpent);
    const preparation = this.storage.compareAndSet(lease.spentKey, lease.spentExpected, lease.spentRaw).catch(() => {
      this.recordRefreshFailure({ kind: "dead" });
      throw new UnauthorizedError("OAuth refresh dispatch could not be recorded; authorization required.");
    }).then((unspent) => {
      if (!unspent) {
        this.recordRefreshFailure({ kind: "dead" });
        throw new UnauthorizedError("OAuth refresh token was already spent; authorization required.");
      }
      // A storage operation can finish after its waiter left. Never send from
      // abandoned preparation, even if both CAS operations succeeded.
      if (waiting.signal.aborted) throw aborted(waiting.signal);
      const sent = send();
      sent.catch(() => {});
      return { sent };
    });
    void preparation.catch(() => {});
    const { sent } = await waiting.run(() => preparation);
    return sent;
  }

  /** @internal Release by CAS after a commit or a classified failure. */
  async releaseRefresh(lease: RefreshLease, verdict?: RefreshFailure, tokens?: OAuthTokens, resolution: "resolved" | "ambiguous" = "ambiguous"): Promise<void> {
    const stored = parsed(lease.raw) as StoredRefreshLease;
    // Only an unsent claim may be removed. Dispatched outcomes never reopen it.
    const next = stored.state === "claimed" ? null : JSON.stringify({
      ...stored,
      ...(tokens ? { completed: true as const, tokenDigest: await refreshTokensDigest(tokens) } : { verdict: { kind: "dead" } }),
    } satisfies StoredRefreshLease);
    // Verdicts contain fixed typed facts; no downstream causes or text.
    if (verdict) this.recordRefreshFailure(verdict);
    await this.resolveRefreshSpent(lease, resolution);
    const released = await this.storage.compareAndSet(lease.key, lease.raw, next).catch(() => false);
    if (released && stored.activeKey) await this.storage.delete(stored.activeKey).catch(() => {});
  }

  private async resolveRefreshSpent(lease: RefreshLease, state: "resolved" | "ambiguous"): Promise<void> {
    try {
      const raw = lease.spentRaw ?? await this.storage.get(lease.spentKey);
      const spent = storedRefreshSpent(raw);
      const holder = (parsed(lease.raw) as StoredRefreshLease).holder;
      if (spent?.state !== "outstanding" || spent.holder !== holder) return;
      // The timestamp belongs to this resolution write, never to dispatch.
      // Consent copies the exact stored receipt, so wall clocks grant no sends.
      await this.storage.compareAndSet(lease.spentKey, raw, JSON.stringify({
        ...spent, state, ...(state === "resolved" ? { resolvedAt: Date.now() } : {}),
      }));
    } catch {
      // A lost resolution answer leaves outstanding or the durable outcome;
      // either blocks replay until a later consent observes a resolved write.
    }
  }

  /** @internal The same typed verdict for local and cross-isolate joiners. */
  refreshVerdict(): RefreshFailure | undefined {
    return this.refreshFailure;
  }

  /** @internal The grant's tokens as stored, in the flow's epoch. */
  async storedTokens(): Promise<OAuthTokens | undefined> {
    return (await this.boundGrant()).body.tokens;
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
  async storeRefresh(
    epoch: string,
    requested: string | null,
    tokens: OAuthTokens,
    issuer: string | undefined,
  ): Promise<OAuthTokens | undefined> {
    for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
      try {
        const { raw, grant } = await this.readGrant();
        if (grant.epoch !== epoch || (issuer !== undefined && grant.body.issuer !== issuer)) return undefined;
        if (grant.body.tokens?.refresh_token !== requested) return grant.body.tokens;
        const committed = issuer !== undefined ? { ...tokens, issuer } : tokens;
        const encoded = await this.encodeGrant({ ...grant, body: { ...grant.body, tokens: committed } });
        if (await this.storage.compareAndSet(GRANT, raw, encoded)) return committed;
      } catch {
        // A failed or lost CAS answer may still have committed. Re-read the
        // epoch and retry these in-memory tokens without another HTTP request.
      }
    }
    throw this.credentialWriteError();
  }

  /**
   * @internal Drop the tokens the authorization server just refused, only
   * while the grant still holds that refresh token in `epoch`: a consent
   * that completed meanwhile survives. Best effort: if storage fails, the
   * next refresh is refused again and ends the same way.
   */
  async discardRefusedGrant(refreshToken: string | null, epoch: string): Promise<void> {
    try {
      await this.updateGrant((grant) => {
        if (grant.body.tokens?.refresh_token !== refreshToken) return undefined;
        const { tokens: _refused, ...body } = grant.body;
        return { ...grant, body };
      }, { epoch, quiet: true, commit: true });
    } catch {
      // See above: a refusal that could not be recorded recurs, it does not hide.
    }
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
    const reset = this.performReset(operatorDisconnected, preserveClient);
    this.onReset?.(reset);
    return reset;
  }

  /** Remove the local grant before a bounded, best-effort RFC 7009 request. */
  disconnectAuthorization(send: FetchLike): Promise<void> {
    const reset = this.performReset(true, false, send);
    this.onReset?.(reset);
    return reset;
  }

  private async performReset(operatorDisconnected: boolean, preserveClient: boolean, revoke?: FetchLike): Promise<void> {
    const epoch = `${operatorDisconnected ? DISCONNECTED_EPOCH_PREFIX : ACTIVE_EPOCH_PREFIX}${crypto.randomUUID()}`;
    for (let attempt = 0; attempt < MAX_GRANT_WRITES; attempt++) {
      const { raw, grant } = await this.readGrant();
      const carried = preserveClient && !operatorDisconnected ? this.carriableClient(grant) : undefined;
      const encoded = await this.encodeGrant({ epoch, body: carried ?? {}, cleanupPending: true });
      let written: boolean;
      try {
        written = await this.storage.compareAndSet(GRANT, raw, encoded);
      } catch {
        throw this.credentialWriteError();
      }
      if (written) {
        this.refreshCoordinator?.retire(grant.epoch);
        try {
          await this.cleanupV2(encoded);
          await this.sweepConsents();
          await this.sweepRefreshLeases();
        } finally {
          if (revoke) await revokeDownstreamGrant(grant.body, revoke, this.clientOptions?.client);
        }
        return;
      }
    }
    throw this.credentialWriteError();
  }

  /**
   * Remove every consent of an epoch no longer live. The records are read
   * before the epoch, and epochs never recur, so a consent whose epoch is not
   * the live one then can never complete; each goes by compare-and-set
   * against what was read. Best effort.
   */
  private async sweepConsents(): Promise<void> {
    try {
      const consents: Array<[string, string]> = [];
      for (const key of await this.storage.list(oauthFlowKeys.prefix)) {
        const raw = await this.storage.get(key);
        if (raw !== null) consents.push([key, raw]);
      }
      const live = epochOf(await this.storage.get(GRANT));
      for (const [key, raw] of consents) {
        const flow = parsed(raw);
        if (plainObject(flow) && flow.epoch === live) continue;
        await this.storage.compareAndSet(key, raw, null);
      }
    } catch {
      // Hygiene only: the epoch, not this, fences a stale consent.
    }
  }

  private async sweepRefreshLeases(): Promise<void> {
    try {
      const records: Array<[string, string]> = [];
      // A reset may sweep an old lease while its HTTP request is still live.
      // Keep holder liveness until completion or its storage-owned TTL: spent
      // records in later epochs still use it to distinguish live from crashed.
      for (const key of await this.storage.list(oauthRefreshKeys.prefix)) {
        const raw = await this.storage.get(key);
        if (raw !== null) records.push([key, raw]);
      }
      const live = epochOf(await this.storage.get(GRANT));
      for (const [key, raw] of records) {
        if (!key.startsWith(`${oauthRefreshKeys.prefix}${live}:`)) {
          await this.storage.compareAndSet(key, raw, null);
        }
      }
    } catch {
      // Stale dispatch records cannot grant credentials: epochs never recur.
    }
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
      clientId === this.clientMetadataUrl ||
      this.clientOptions?.client !== undefined ||
      (typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1000 <= Date.now()) ||
      (client.carried && !tokens)
    ) {
      return undefined;
    }
    return { issuer, client: { value: client.value, binding: client.binding, carried: true } };
  }
}
