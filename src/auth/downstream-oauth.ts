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
import { retryAfterMs } from "../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../errors.js";
import {
  attachOAuthPartition,
  oauthPartitionFor,
  retainOAuthPartition,
} from "../oauth-partition.js";
import { inheritOAuthSealer } from "../oauth-sealing.js";
import type { OAuthStateSealer } from "../oauth-sealing.js";
import { detach, fromSignal, runEdge } from "../runtime/run.js";
import type { ConnectorContext, KVStorage } from "../types.js";

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

/** A 256-bit random opaque value, hex-encoded — used for the OAuth `state`. */
function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-safe, constant-time string compare (no early-exit on first mismatch). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const LEGACY_GENERATION = "legacy";
const ACTIVE_GENERATION_PREFIX = "v2:";
const RESETTING_GENERATION_PREFIX = "reset:";
const DISCONNECTED_GENERATION_PREFIX = "disconnected:";
const STORED_VALUE_VERSION = 2;
const OAUTH_VALUE_KEYS = [
  "oauth:client",
  "oauth:tokens",
  "oauth:pending",
  "oauth:verifier",
  "oauth:state",
  "oauth:discovery",
] as const;
/**
 * The values that are credentials: tokens, a registered client (which may
 * carry a secret), and the PKCE verifier. With a sealing vault they are
 * ciphertext at rest. Flow bookkeeping — state, pending URL, discovery, and
 * the generation — stays plaintext: the callback route reads state directly,
 * and none of it authenticates anything on its own.
 */
const SEALED_OAUTH_KEYS: ReadonlySet<string> = new Set([
  "oauth:client",
  "oauth:tokens",
  "oauth:verifier",
]);
const SEALED_VALUE_VERSION = 1;
/**
 * The longest cleanup lineage a reset publishes. A reset's storage work no
 * longer depends on the lineage's length — it deletes one retired generation
 * after the fence and sweeps at most MAX_EXPIRED_SWEEP before it — so this
 * guards only the size of the two records every reset reads. A generation
 * name is 39 characters, so 5,000 entries is about 210 KB of manifest and
 * 280 KB of times: far under Workers KV's 25 MiB value limit, and a few
 * milliseconds to parse. Reaching it takes more than 4,000 resets of one
 * connector in a day on top of the 1,000 an earlier release allowed, which
 * is a loop, not an operator. An earlier release refuses a lineage longer
 * than 1,000, so rolling back past this one wedges only a connector that
 * went beyond that — which that release would have wedged anyway.
 */
const MAX_CLEANUP_BACKLOG = 5_000;
/**
 * How long a retired generation stays in the cleanup lineage. A late write
 * lands in a retired namespace only from a request that captured that
 * generation before the reset and is still running — an OAuth flow, a token
 * refresh, or a reader whose eventually consistent store (Workers KV serves a
 * stale generation for a minute or more) has not yet seen the fence. None of
 * those outlive a day. A late writer's own cleanup deletes what it wrote, and
 * if that delete fails it records the generation as retired again from that
 * moment; residue it leaves is unreadable behind the fence either way. Once
 * the grace has passed, a reset sweeps the generation, and one whose keys
 * are confirmed deleted cannot be written again, so it leaves the lineage.
 * That is an assumption, not a proof: a request that holds a retired
 * generation for longer than this and dies between its write and its own
 * cleanup leaves residue no reset tracks. It is still unreadable — the epoch
 * fence, not this cleanup, is what keeps an old namespace out of use.
 */
const CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * The most past-grace generations one reset sweeps before publishing. The
 * rest stay in the lineage for a later reset, so a backlog built by a burst
 * of resets drains over several resets instead of in one request.
 */
const MAX_EXPIRED_SWEEP = 16;
/**
 * Independent storage deletes one cleanup keeps in flight: Workers allows six
 * simultaneous open connections per invocation, and more would only queue.
 */
const DELETE_CONCURRENCY = 6;
/**
 * How many of the most recently retired generations a reset checks for an
 * unfinished cleanup. The case that matters is the one just before: an
 * operator whose Disconnect or Restart reported a failed cleanup retries, and
 * that retry must delete the grant the failure left behind. Eight covers that
 * with room for a burst of failing restarts, costs eight small reads per
 * reset, and bounds a retry to eight generations' deletes; anything older is
 * reclaimed by the past-grace sweep instead.
 */
const RETRY_PROBES = 8;
/**
 * How long a pending authorization URL may be handed out again instead of
 * starting a fresh flow. The URL itself never expires on connecta's side, but
 * the authorization server's half of it does: a pushed request URI lives
 * seconds to minutes (RFC 9126), and login transactions are commonly held
 * for minutes, not hours. Past this age a reissued URL is more likely to land
 * the operator on an expired-session page than on consent, and a fresh start
 * costs one authorization request, not a client registration. It also sits
 * inside the registry's 15-minute personal-auth handoff.
 */
const PENDING_AUTHORIZATION_MAX_AGE_MS = 10 * 60 * 1000;

/** One entry of a cleanup lineage: a retired generation and when it retired. */
interface RetiredGeneration {
  generation: string;
  /** Epoch milliseconds. An entry with no recorded time reads as "now". */
  retiredAt: number;
}

/**
 * Union two lineages by generation, keeping the later retirement time, so a
 * merge can only ever lengthen a generation's grace. Order is first-seen.
 */
function mergeLineage(
  ...lineages: ReadonlyArray<readonly RetiredGeneration[]>
): RetiredGeneration[] {
  const merged = new Map<string, number>();
  for (const lineage of lineages) {
    for (const { generation, retiredAt } of lineage) {
      const known = merged.get(generation);
      merged.set(
        generation,
        known === undefined ? retiredAt : Math.max(known, retiredAt),
      );
    }
  }
  return [...merged].map(([generation, retiredAt]) => ({
    generation,
    retiredAt,
  }));
}

/**
 * A limiter admitting at most `limit` storage operations at once. A finished
 * operation hands its slot straight to the next waiter, so the bound holds
 * even when new callers arrive between the two.
 */
function concurrencyLimit(
  limit: number,
): <A>(run: () => Promise<A>) => Promise<A> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (run) => {
    if (active < limit) active++;
    else await new Promise<void>((resume) => waiting.push(resume));
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

type StorageLimit = ReturnType<typeof concurrencyLimit>;

/**
 * The first rejection in input order, as `{ reason }`. The wrapper matters: a
 * store may reject with `undefined` or another falsy value, and that is still
 * a failed delete.
 */
function firstRejection(
  results: readonly PromiseSettledResult<unknown>[],
): { reason: unknown } | undefined {
  for (const result of results) {
    if (result.status === "rejected") return { reason: result.reason };
  }
  return undefined;
}

/**
 * A bound credential as an issuer-aware read hands it back: carrying the
 * issuer its envelope is bound to. Connecta binds the envelope, so a value
 * written before binding has no stamp of its own, and the SDK's matching
 * SEP-2352 check would otherwise warn on the console at every read.
 */
function stampedValue<T>(value: T, issuer: string): T {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, issuer }
    : value;
}

/** The `grant_type` of a token request, or undefined for any other request. */
function tokenGrantType(init: RequestInit | undefined): string | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return undefined;
  const body = init?.body;
  if (body instanceof URLSearchParams) return body.get("grant_type") ?? undefined;
  if (typeof body !== "string") return undefined;
  return new URLSearchParams(body).get("grant_type") ?? undefined;
}

function isRefreshTokenRequest(init: RequestInit | undefined): boolean {
  return tokenGrantType(init) === "refresh_token";
}

function sdkAcceptsOAuthTokens(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.access_token !== "string" ||
    typeof candidate.token_type !== "string"
  ) {
    return false;
  }
  for (const key of ["id_token", "scope", "refresh_token"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
      return false;
    }
  }
  if (candidate.expires_in !== undefined) {
    try {
      if (!Number.isFinite(Number(candidate.expires_in))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const MAX_REFRESH_RESPONSE_BYTES = 65_536;

class OversizedRefreshResponse extends Error {
  constructor() {
    super(`OAuth refresh response exceeded ${MAX_REFRESH_RESPONSE_BYTES} bytes.`);
  }
}

async function readRefreshResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_REFRESH_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new OversizedRefreshResponse();
  }
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REFRESH_RESPONSE_BYTES) {
        // A cloned body's cancellation can await its sibling. Cancel both,
        // without making the refusal wait for the provider to finish sending.
        void reader.cancel().catch(() => {});
        void response.body?.cancel().catch(() => {});
        throw new OversizedRefreshResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/**
 * What a failed refresh says about the grant.
 *
 * `dead`: the authorization server refused the refresh token or the client —
 * any 4xx except 408, 425, and 429, or a 2xx carrying an OAuth `error` the way
 * GitHub answers `bad_refresh_token`. Only consent repairs that, so the call is
 * `auth_required` and the refused token is never sent again.
 *
 * `transient`: the server could not answer now — 5xx, 408, 425, 429, a network
 * failure, or a 2xx that is not a token response. The grant is kept and the
 * call is a retryable outage; a passive call never turns it into consent.
 */
type RefreshFailure =
  | { kind: "dead" }
  | {
      kind: "transient";
      /** Completes "the authorization server …" in the agent-facing message. */
      reason: string;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    };

type TransientRefreshFailure = Extract<RefreshFailure, { kind: "transient" }>;

/** Client-error statuses that describe the moment, not the grant. */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * OAuth `error` codes on which the SDK's own `auth()` drops state and starts
 * over. Handing the SDK one of these is how a dead grant reaches consent on an
 * explicit authorization, and `auth_required` on a passive call.
 */
const SDK_RESTARTING_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

function oauthErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const code = (body as { error?: unknown }).error;
  return typeof code === "string" ? code : undefined;
}

function transientFailure(
  reason: string,
  response?: Response,
  cause?: unknown,
): TransientRefreshFailure {
  const wait = response ? retryAfterMs(response.headers) : undefined;
  return {
    kind: "transient",
    reason,
    ...(response ? { status: response.status } : {}),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * The OAuth `error` codes a token-endpoint failure may carry to the SDK, each
 * with the only description it will ever see beside it. RFC 6749's error
 * codes, RFC 8707's, and RFC 9449's: the SDK decides its control flow on the
 * code, so the code is all that has to survive.
 */
const SDK_TOKEN_ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  invalid_request: "The authorization server refused the token request.",
  invalid_client: "The authorization server refused the client.",
  invalid_grant: "The authorization server refused the grant.",
  unauthorized_client: "The authorization server refused the client for this grant.",
  unsupported_grant_type: "The authorization server refused the grant type.",
  invalid_scope: "The authorization server refused the requested scope.",
  invalid_target: "The authorization server refused the requested resource.",
  server_error: "The authorization server is temporarily unavailable.",
  temporarily_unavailable: "The authorization server is temporarily unavailable.",
  invalid_dpop_proof: "The authorization server refused the DPoP proof.",
  use_dpop_nonce: "The authorization server requires a DPoP nonce.",
};

/**
 * A token-endpoint failure as the SDK gets to parse it: the OAuth `error`
 * code, a fixed description, the status, and `Retry-After`, and nothing else
 * the server wrote. Since client 2.1.0 the SDK writes a failure's description
 * to `console.warn` when it restarts or falls through to consent, and a body
 * that is no OAuth error at all goes there raw. A token endpoint that echoes
 * the form it refused would put the refresh token and client secret in the
 * host's console, below any logger the deployment configured.
 */
function sdkTokenFailure(
  original: Response,
  code: string,
  status = original.status,
): Response {
  void original.body?.cancel().catch(() => {});
  const retryAfter = original.headers.get("retry-after");
  const known = code in SDK_TOKEN_ERROR_DESCRIPTIONS ? code : "invalid_request";
  return Response.json(
    { error: known, error_description: SDK_TOKEN_ERROR_DESCRIPTIONS[known] },
    {
      status,
      ...(retryAfter !== null ? { headers: { "retry-after": retryAfter } } : {}),
    },
  );
}

/**
 * Rebuild a code exchange's answer (or any token request's but a refresh,
 * which `refreshResponseOutcome` classifies) before the SDK parses it, unless
 * it is a token response the SDK accepts. Whatever fails that check is a
 * failure, and the SDK puts a failure's body in its error message whole — a
 * 200 whose `error` is `null`, a number, or an object included. A code outside
 * the registered set becomes `invalid_request`, and a body without a string
 * code becomes `server_error`, the classes the SDK already gave them.
 */
async function sdkSafeTokenResponse(response: Response): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await readRefreshResponse(response);
  } catch {
    // Not JSON, or too large to be a token response: only the status is left.
    return sdkTokenFailure(response, "server_error");
  }
  if (response.ok && sdkAcceptsOAuthTokens(parsed)) return response;
  return sdkTokenFailure(response, oauthErrorCode(parsed) ?? "server_error");
}

type RefreshResponseOutcome =
  | {
      failure: Error;
      verdict: RefreshFailure;
      /** The answer the SDK parses: the original unless it would misread it. */
      forSdk: Response;
      tokens?: undefined;
    }
  | { failure?: undefined; tokens: OAuthTokens };

/**
 * Classify the token endpoint's answer once, on a clone, and keep the parsed
 * tokens: a valid response has already consumed the rotating refresh token, so
 * the host persists it (`coordinatedFetch`) rather than trusting the SDK's
 * later `saveTokens` to arrive on a request that may already be cancelled.
 *
 * A failure also decides what the SDK gets to parse. Pinned against
 * `@modelcontextprotocol/client` 2.3.1, `src/client/auth.ts`: `authInternal()`
 * swallows a refresh failure that is not an `OAuthError`, or is `server_error`,
 * and falls through to `startAuthorization` (`state()`, `saveCodeVerifier()`,
 * `redirectToAuthorization()`); it rethrows every other `OAuthError`, and
 * `auth()` retries once after `invalidateCredentials()` only for
 * `invalid_grant` and `invalid_dpop_proof` (tokens) and
 * `invalid_client`/`unauthorized_client` (client and tokens). A `saveTokens`
 * failure after a successful refresh propagates instead of falling through,
 * as it has since 2.1.0. `executeTokenRequest()` turns a 2xx body carrying
 * `error` into an `OAuthError` with that code. So a dead grant the SDK would rethrow
 * (`bad_refresh_token`, `invalid_scope`, …) reaches it as `invalid_grant`, and
 * an outage whose body names any code but `server_error` reaches it as
 * `server_error` — a 5xx `invalid_grant` must not make the SDK drop a grant
 * nobody refused. Every failure reaches it rebuilt by `sdkTokenFailure`, so
 * nothing the server wrote but the code it chose is ever the SDK's to log.
 * The provider hooks below finish the job. If the SDK moves,
 * the tests under "remoteMcp() dead and transient refresh grants" fail first.
 */
async function refreshResponseOutcome(
  response: Response,
): Promise<RefreshResponseOutcome> {
  if (!response.ok) {
    let code: string | undefined;
    try {
      code = oauthErrorCode(await readRefreshResponse(response));
    } catch {
      // Not JSON, or too large to be an OAuth error: the status decides.
    }
    const failure = new Error(`OAuth refresh failed with HTTP ${response.status}.`);
    if (
      response.status >= 400 &&
      response.status < 500 &&
      !TRANSIENT_CLIENT_STATUSES.has(response.status)
    ) {
      return {
        failure,
        verdict: { kind: "dead" },
        forSdk:
          code !== undefined && SDK_RESTARTING_CODES.has(code)
            ? sdkTokenFailure(response, code)
            : sdkTokenFailure(response, "invalid_grant", 400),
      };
    }
    return {
      failure,
      verdict: transientFailure(`answered HTTP ${response.status}`, response),
      forSdk: sdkTokenFailure(response, "server_error"),
    };
  }
  let parsed: unknown;
  try {
    parsed = await readRefreshResponse(response);
  } catch (error) {
    if (error instanceof OversizedRefreshResponse) throw error;
    return {
      failure: new Error("OAuth refresh response did not contain JSON tokens."),
      verdict: transientFailure("answered without a token response", response),
      forSdk: sdkTokenFailure(response, "server_error"),
    };
  }
  if (sdkAcceptsOAuthTokens(parsed)) {
    // An `issuer` names the server a grant is bound to, and only the client
    // stamps it — never the server answering, as the SDK's own parse agrees.
    const { issuer: _ignored, ...tokens } = parsed as OAuthTokens;
    return { tokens };
  }
  if (oauthErrorCode(parsed) !== undefined) {
    return {
      failure: new Error("OAuth refresh was refused by the authorization server."),
      verdict: { kind: "dead" },
      forSdk: sdkTokenFailure(response, "invalid_grant", 400),
    };
  }
  return {
    failure: new Error("OAuth refresh response did not match the token schema."),
    verdict: transientFailure("answered without a token response", response),
    forSdk: sdkTokenFailure(response, "server_error"),
  };
}

function refreshMutationPendingResponse(): Response {
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description:
        "OAuth refresh is temporarily unavailable while previous credentials commit.",
    },
    { status: 503 },
  );
}

type OAuthRefreshFlightOutcome =
  | { status: "refreshed" }
  | { status: "retired" }
  /** `verdict` is present when the token endpoint's answer (or silence) decided it. */
  | { status: "failed"; error: unknown; verdict?: RefreshFailure };

interface OAuthRefreshFlight {
  /**
   * Completed once, by `settle`, and only ever from the owning request: its
   * fiber, its provider's saveTokens/redirect/invalidate hooks, or its abort.
   * Joined requests only await it. No fiber outlives a request to hold a
   * flight open.
   */
  outcome: Deferred.Deferred<OAuthRefreshFlightOutcome>;
  stopObservingOwnerAbort: () => void;
  mutationId: object;
  writing: boolean;
  // A cancelled or retired flight can still receive a consumed grant's answer.
  // Keep its registry pinned until that answer and any recovery save drain.
  answerPending: boolean;
  recoveryPending: boolean;
  settled: boolean;
  releasePartition: () => void;
  /**
   * Set once the token endpoint answered with valid tokens: the authorization
   * server has consumed the rotating refresh token, so if the SDK's own
   * saveTokens never arrives (owner cancelled, redirected, or invalidated),
   * `fail` persists this copy itself rather than stranding the marker or
   * letting a contender redeem the retired token.
   */
  acceptedTokens?: OAuthTokens;
  /** SDK and cancellation recovery join one commit of this accepted answer. */
  persistence?: Promise<void>;
  persist: (tokens: OAuthTokens) => Promise<void>;
}

function aborted(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ?? new DOMException("This operation was aborted", "AbortError")
  );
}

/**
 * Call `onAbort` once when `signal` aborts, at once if it already has, until
 * the returned function stops watching. The owner's abort needs a listener
 * rather than an interrupt once the SDK holds the answer: the SDK saves the
 * tokens after `coordinatedFetch` has returned, when no fiber of the owner's
 * is left to interrupt.
 */
function whenAborted(signal: AbortSignal, onAbort: () => void): () => void {
  let watching = true;
  const stop = () => {
    if (!watching) return;
    watching = false;
    signal.removeEventListener("abort", listener);
  };
  const listener = () => {
    stop();
    onAbort();
  };
  signal.addEventListener("abort", listener, { once: true });
  if (signal.aborted) listener();
  return stop;
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
  flight: OAuthRefreshFlight,
  signal?: AbortSignal,
): Promise<OAuthRefreshFlightOutcome> {
  const settled = Deferred.await(flight.outcome);
  // The abort goes first, so a caller that has already left never joins.
  return runEdge(
    signal
      ? Effect.raceAllFirst<Effect.Effect<OAuthRefreshFlightOutcome, unknown>>([
          fromSignal(signal),
          settled,
        ])
      : settled,
  );
}

/**
 * Share one rotating-token redemption within one connector runtime and OAuth
 * generation. The first request still owns the real fetch and response, and
 * its abort ends the flight at any point until the flight settles: first by
 * interrupting the redemption, then, once the SDK holds the answer, through
 * one bounded listener, so a cancellation cannot strand waiters during token
 * storage. Followers wait on the flight's Deferred for that provider to save
 * tokens, then re-read storage. The map never retains a token response or
 * transport.
 *
 * This is intentionally runtime-local. KVStorage has no atomic coordination
 * operation, so a second isolate can still race the same refresh token.
 */
export class OAuthRefreshCoordinator {
  constructor(private readonly retainPartition: () => () => void = () => () => {}) {}

  /** Keep an accepted credential write alive independently of its caller. */
  retainWork(): () => void {
    return this.retainPartition();
  }

  private releaseFlightPartition(flight: OAuthRefreshFlight): void {
    if (flight.settled && !flight.answerPending && !flight.recoveryPending) {
      flight.releasePartition();
    }
  }
  private readonly flights = new Map<string, OAuthRefreshFlight>();
  /** Opaque identities only: no request promise, signal, callback, or response. */
  private readonly pendingMutations = new Map<string, object>();
  /** One bounded latest-success slot, containing only generation + identity. */
  private successfulRefresh:
    | { generation: string; identity: object }
    | undefined;
  /** Replaced on every map mutation, closing flight/pending ABA across awaits. */
  private stateRevision: object = {};

  private advanceStateRevision(): void {
    this.stateRevision = {};
  }

  private observeAuthoritativeGeneration(generation: string): void {
    const staleGenerations = new Set([
      ...this.flights.keys(),
      ...this.pendingMutations.keys(),
    ]);
    for (const stale of staleGenerations) {
      if (stale !== generation) this.retire(stale);
    }
    if (
      this.successfulRefresh &&
      this.successfulRefresh.generation !== generation
    ) {
      this.successfulRefresh = undefined;
      this.advanceStateRevision();
    }
  }

  private settle(
    generation: string,
    flight: OAuthRefreshFlight,
    outcome: OAuthRefreshFlightOutcome,
  ): void {
    if (this.flights.get(generation) !== flight) return;
    this.flights.delete(generation);
    flight.settled = true;
    this.advanceStateRevision();
    flight.stopObservingOwnerAbort();
    this.releaseFlightPartition(flight);
    // Last, because joined fibers resume inside this call.
    Deferred.doneUnsafe(flight.outcome, Effect.succeed(outcome));
  }

  private markMutationPending(
    generation: string,
    flight: OAuthRefreshFlight,
  ): boolean {
    if (this.flights.get(generation) !== flight) return false;
    this.pendingMutations.set(generation, flight.mutationId);
    this.advanceStateRevision();
    return true;
  }

  private finishMutation(
    generation: string,
    flight: OAuthRefreshFlight,
  ): boolean {
    if (this.pendingMutations.get(generation) === flight.mutationId) {
      this.pendingMutations.delete(generation);
      this.advanceStateRevision();
      return true;
    }
    return false;
  }

  /** @internal Opaque basis for issuer-aware provider token reads. */
  successfulRefreshIdentity(generation: string): object | undefined {
    return this.successfulRefresh?.generation === generation
      ? this.successfulRefresh.identity
      : undefined;
  }

  coordinatedFetch(
    provider: KvOAuthProvider,
    baseFetch: FetchLike,
    requestSignal?: AbortSignal,
  ): FetchLike {
    return async (input, init) => {
      // Await passthrough failures here so workerd associates the rejection
      // with the fetch the SDK is already awaiting, rather than reporting the
      // adopted inner promise as an unhandled rejection.
      if (!isRefreshTokenRequest(init)) {
        const grantType = tokenGrantType(init);
        // The last step before an authorization code leaves: every read the
        // exchange depends on has completed, so this is where the callback
        // claims its state and proves its epoch is still the live one.
        const exchange = grantType === "authorization_code";
        if (exchange) {
          const answered = await provider.fenceCodeExchange();
          if (answered) return answered;
        }
        if (requestSignal?.aborted) throw aborted(requestSignal);
        const signal = requestSignal
          ? init?.signal
            ? AbortSignal.any([requestSignal, init.signal])
            : requestSignal
          : init?.signal;
        const response = await baseFetch(input, { ...init, ...(signal ? { signal } : {}) });
        if (grantType === undefined) return response;
        // A code exchange's failure is the SDK's to log as well.
        const forSdk = await sdkSafeTokenResponse(response);
        if (exchange && forSdk !== response) provider.recordCodeExchangeRefusal(forSdk);
        return forSdk;
      }

      // A verdict belongs to one refresh; never let an older one decide this.
      provider.recordRefreshFailure(undefined);
      const generation = await provider.flowGeneration();
      const requestedRefreshToken =
        init?.body instanceof URLSearchParams
          ? init.body.get("refresh_token")
          : new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
      for (let attempt = 0; attempt < 64; attempt++) {
        if (requestSignal?.aborted) throw aborted(requestSignal);
        const revisionBeforeReads = this.stateRevision;
        const activeGeneration = await provider.generation();
        this.observeAuthoritativeGeneration(activeGeneration);
        if (activeGeneration !== generation) this.retire(generation);
        const activeFlight = this.flights.get(generation);
        const pendingMutation = this.pendingMutations.get(generation);
        if (
          activeGeneration === generation &&
          pendingMutation &&
          activeFlight?.mutationId !== pendingMutation
        ) {
          return refreshMutationPendingResponse();
        }
        let currentTokens =
          activeGeneration === generation ? await provider.tokens() : undefined;
        const latestGeneration = await provider.generation();
        this.observeAuthoritativeGeneration(latestGeneration);
        if (latestGeneration !== generation) {
          this.retire(generation);
          currentTokens = undefined;
        }

        if (this.stateRevision !== revisionBeforeReads) continue;

        // Re-check both identities after every storage await. An owner can
        // abort while this caller reads tokens, leaving only the mutation
        // marker; a reset can likewise retire this caller's captured epoch.
        const existing = this.flights.get(generation);
        const latestPendingMutation = this.pendingMutations.get(generation);
        if (
          latestGeneration === generation &&
          latestPendingMutation &&
          existing?.mutationId !== latestPendingMutation
        ) {
          return refreshMutationPendingResponse();
        }

        // This flow may have read a token just before another flow saved its
        // rotation. Replaying the retired token would recreate the race after
        // the first network response. Give the SDK the already-saved rotating
        // credential instead. A tokenless current value cannot do that: the
        // SDK would merge the requested old refresh token back into it.
        if (
          currentTokens?.refresh_token &&
          (currentTokens.refresh_token !== requestedRefreshToken ||
            provider.refreshBasisChanged(currentTokens, generation))
        ) {
          return Response.json(currentTokens);
        }
        if (currentTokens?.refresh_token !== requestedRefreshToken) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Refresh token is no longer active.",
            },
            { status: 400 },
          );
        }

        if (existing) {
          const outcome = await waitForRefreshFlight(existing, requestSignal);
          if (outcome.status === "failed") {
            // A joined caller inherits the owner's verdict, so every scope on
            // one flight ends the same way: auth_required or a retryable outage.
            provider.recordRefreshFailure(outcome.verdict);
            throw outcome.error;
          }
          if (outcome.status === "refreshed") {
            const activeGeneration = await provider.generation();
            const refreshedTokens =
              activeGeneration === generation
                ? await provider.tokens()
                : undefined;
            if (refreshedTokens?.refresh_token) {
              return Response.json(refreshedTokens);
            }
          }
          continue;
        }

        // An owner that has already left never publishes a flight, and never
        // reaches the token endpoint.
        if (requestSignal?.aborted) throw aborted(requestSignal);
        // The authorization server this redemption answers to, fixed now: a
        // recovery save outlives the SDK flow that would have stamped it.
        const issuer = provider.refreshIssuer(generation);
        const flight: OAuthRefreshFlight = {
          outcome: Deferred.makeUnsafe(),
          stopObservingOwnerAbort: () => {},
          mutationId: {},
          writing: false,
          answerPending: true,
          recoveryPending: false,
          settled: false,
          releasePartition: this.retainWork(),
          persist: (tokens) =>
            provider.saveAcceptedRefreshTokens(tokens, generation, flight, issuer),
        };
        this.flights.set(generation, flight);
        this.advanceStateRevision();
        provider.captureRefreshFlight(generation, flight);
        const currentRefreshToken = currentTokens?.refresh_token;
        // The token request starts now, as a plain promise: an owner that
        // stops waiting for its answer can still hand the answer on.
        const answer = (async () => {
          const response = await baseFetch(
            input,
            requestSignal ? { ...init, signal: requestSignal } : init,
          );
          return { response, outcome: await refreshResponseOutcome(response) };
        })();

        // Record what the token endpoint said, then settle the flight or
        // hand it to the SDK's saveTokens.
        const commit = ({
          response,
          outcome,
        }: Awaited<typeof answer>): Effect.Effect<Response, Error> => {
          if (outcome.failure) {
            // Failed responses never reach a successful saveTokens callback.
            // Give current waiters a bounded failure now, carrying the
            // verdict, and hand the SDK an answer it classifies the same way.
            provider.recordRefreshFailure(outcome.verdict);
            // Drop a refused grant while the flight still stands: a caller
            // arriving meanwhile joins it instead of redeeming the dead token
            // again, and no later request or isolate can replay it.
            const discard =
              outcome.verdict.kind === "dead"
                ? Effect.promise(() =>
                    provider.discardRefusedGrant(requestedRefreshToken, generation),
                  )
                : Effect.void;
            return discard.pipe(
              Effect.map(() => {
                this.fail(generation, flight, outcome.failure, outcome.verdict);
                return outcome.forSdk;
              }),
            );
          }
          // A valid response means the authorization server has consumed the
          // rotating refresh token. The SDK's saveTokens normally persists it;
          // keep this copy so `fail` can persist it instead if that callback
          // never comes (the SDK merges the old refresh token the same way).
          const rotatedRefreshToken =
            outcome.tokens.refresh_token ?? currentRefreshToken;
          const accepted: OAuthTokens = {
            ...outcome.tokens,
            ...(rotatedRefreshToken !== undefined
              ? { refresh_token: rotatedRefreshToken }
              : {}),
          };
          flight.acceptedTokens = accepted;
          if (!this.markMutationPending(generation, flight)) {
            // Already settled (the owner was cancelled first). Still write the
            // rotation: losing it would leave a dead credential.
            flight.recoveryPending = true;
            detach(Effect.promise(() => flight.persist(accepted)).pipe(
              Effect.ensuring(Effect.sync(() => {
                flight.recoveryPending = false;
                this.releaseFlightPartition(flight);
              })),
            ));
            return Effect.fail(
              new Error("OAuth refresh ended before tokens could be saved."),
            );
          }
          // The SDK holds the answer from here, after this fiber is gone, so
          // a listener watches for the owner leaving before it saves. Then
          // `fail` persists the rotation instead.
          if (requestSignal) {
            flight.stopObservingOwnerAbort = whenAborted(requestSignal, () =>
              this.fail(generation, flight, aborted(requestSignal)),
            );
          }
          return Effect.succeed(response);
        };
        const finishAnswer = Effect.sync(() => {
          flight.answerPending = false;
          this.releaseFlightPartition(flight);
        });
        const commitAnswer = (value: Awaited<typeof answer>) =>
          commit(value).pipe(Effect.ensuring(finishAnswer));

        // The owner's redemption. Its abort interrupts the wait for the token
        // endpoint and nothing after it: an answer, once it exists, is
        // committed before anyone is released, so no caller is let go to
        // redeem a token the server has already refused or spent. An answer
        // that arrives after the owner left is committed in the background,
        // as the foreground would have.
        const redemption = Effect.uninterruptibleMask((restore) =>
          restore(
            Effect.tryPromise({ try: () => answer, catch: (error) => error }),
          ).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                this.fail(generation, flight, aborted(requestSignal));
                detach(Effect.promise(() => answer).pipe(
                  Effect.flatMap(commitAnswer),
                  Effect.ensuring(finishAnswer),
                ));
              }),
            ),
            Effect.catch((error) => {
              // No answer at all — the network, or a body too large to be
              // one — is an outage. A refusal connecta itself raised (a
              // redirect the policy forbids) and this owner's own
              // cancellation are not.
              const verdict =
                !requestSignal?.aborted &&
                !(error instanceof ConnectorCallError && !error.retryable)
                  ? transientFailure(
                      error instanceof OversizedRefreshResponse
                        ? "answered with an oversized response"
                        : "could not be reached",
                      undefined,
                      error,
                    )
                  : undefined;
              if (verdict) provider.recordRefreshFailure(verdict);
              flight.answerPending = false;
              this.fail(generation, flight, error, verdict);
              // Retirement may already have removed the flight from the map.
              // Its rejected answer still finishes the retained partition work.
              this.releaseFlightPartition(flight);
              return Effect.fail(error);
            }),
            Effect.flatMap(commitAnswer),
          ),
        );
        return await runEdge(
          requestSignal
            ? Effect.raceAllFirst<Effect.Effect<Response, unknown>>([
                redemption,
                fromSignal(requestSignal),
              ])
            : redemption,
        );
      }
      return refreshMutationPendingResponse();
    };
  }

  /** Start storage only while this owner still holds its exact flight. */
  beginMutation(generation: string, flight: OAuthRefreshFlight): boolean {
    if (this.flights.get(generation) !== flight) return false;
    flight.writing = true;
    return true;
  }

  /** Publish one exact owner's successful save without disturbing a newer try. */
  succeedMutation(generation: string, flight: OAuthRefreshFlight): void {
    if (this.finishMutation(generation, flight)) {
      this.successfulRefresh = { generation, identity: {} };
      this.advanceStateRevision();
    }
    this.settle(generation, flight, { status: "refreshed" });
  }

  /**
   * Give joined callers a fetch/flow failure, without rejecting the gate. A
   * `verdict` travels with it only when the token endpoint decided the
   * failure; an abort or a write failure carries none.
   */
  fail(
    generation: string,
    flight: OAuthRefreshFlight,
    error: unknown,
    verdict?: RefreshFailure,
  ): void {
    // Only saveTokens owns a live credential write. If it has started, its
    // success/failure callback clears the marker even after owner cancellation.
    if (flight.writing) {
      this.settle(generation, flight, { status: "failed", error });
      return;
    }
    // The token endpoint already answered with valid tokens but the SDK will
    // not save them (the owner was cancelled, redirected, or invalidated).
    // The old refresh token is spent, so the host persists the rotation
    // itself and keeps contenders behind the marker until it lands. Joined
    // callers then receive the saved rotation, never a retired token to
    // redeem again. saveTokens' own bookkeeping settles the flight when the
    // provider still holds it; otherwise settle here once the write ends.
    const tokens = flight.acceptedTokens;
    if (
      tokens !== undefined &&
      this.pendingMutations.get(generation) === flight.mutationId
    ) {
      flight.writing = true;
      flight.recoveryPending = true;
      const written = (outcome: OAuthRefreshFlightOutcome) => {
        if (this.finishMutation(generation, flight)) {
          this.settle(generation, flight, outcome);
        }
      };
      detach(
        Effect.tryPromise({
          try: () => flight.persist(tokens),
          catch: (writeError) => writeError,
        }).pipe(
          Effect.match({
            onSuccess: () => written({ status: "refreshed" }),
            onFailure: (error) => written({ status: "failed", error }),
          }),
          Effect.ensuring(Effect.sync(() => {
            flight.recoveryPending = false;
            this.releaseFlightPartition(flight);
          })),
        ),
      );
      return;
    }
    // A response alone is not a write and must never strand the generation.
    this.finishMutation(generation, flight);
    this.settle(generation, flight, {
      status: "failed",
      error,
      ...(verdict !== undefined ? { verdict } : {}),
    });
  }

  /** Finish an exact failed credential write, then publish its failure. */
  failMutation(
    generation: string,
    flight: OAuthRefreshFlight,
    error: unknown,
  ): void {
    this.finishMutation(generation, flight);
    this.settle(generation, flight, { status: "failed", error });
  }

  /** Force reauthorization fences and wakes every waiter on the retired epoch. */
  retire(generation: string): void {
    if (this.pendingMutations.delete(generation)) {
      this.advanceStateRevision();
    }
    if (this.successfulRefresh?.generation === generation) {
      this.successfulRefresh = undefined;
      this.advanceStateRevision();
    }
    const flight = this.flights.get(generation);
    if (!flight) return;
    this.settle(generation, flight, { status: "retired" });
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

interface StoredOAuthValue<T> {
  connectaOAuthVersion: typeof STORED_VALUE_VERSION;
  generation: string;
  issuer?: string;
  /** Connector and redirect metadata under which a client was registered. */
  binding?: string;
  /**
   * Set on a client registration a forced restart copied into this epoch.
   * Absent on one the SDK registered or stamped here. Older readers ignore it.
   */
  carried?: true;
  /**
   * Epoch milliseconds the value was written, where its age matters (the
   * pending authorization URL). Older readers ignore the field.
   */
  writtenAt?: number;
  value: T;
}

/** A value read from the active epoch, with the envelope fields beside it. */
type OAuthValueRead<T> = Omit<StoredOAuthValue<T>, "connectaOAuthVersion">;

interface LegacyStoredOAuthValue<T> {
  connectaOAuthVersion: 1;
  generation: string;
  value: T;
}

function storedOAuthValue<T>(
  value: unknown,
): value is StoredOAuthValue<T> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredOAuthValue<T>>;
  return (
    candidate.connectaOAuthVersion === STORED_VALUE_VERSION &&
    typeof candidate.generation === "string" &&
    (candidate.issuer === undefined || typeof candidate.issuer === "string") &&
    (candidate.binding === undefined || typeof candidate.binding === "string") &&
    (candidate.carried === undefined || candidate.carried === true) &&
    "value" in candidate
  );
}

function legacyStoredOAuthValue<T>(
  value: unknown,
): value is LegacyStoredOAuthValue<T> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyStoredOAuthValue<T>>;
  return (
    candidate.connectaOAuthVersion === 1 &&
    typeof candidate.generation === "string" &&
    "value" in candidate
  );
}

interface SealedOAuthValue {
  connectaOAuthSealed: typeof SEALED_VALUE_VERSION;
  sealed: string;
}

function sealedOAuthValue(value: unknown): value is SealedOAuthValue {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SealedOAuthValue>;
  return (
    candidate.connectaOAuthSealed === SEALED_VALUE_VERSION &&
    typeof candidate.sealed === "string"
  );
}

function isModernGeneration(generation: string): boolean {
  return (
    generation.startsWith(ACTIVE_GENERATION_PREFIX) ||
    generation.startsWith(RESETTING_GENERATION_PREFIX) ||
    generation.startsWith(DISCONNECTED_GENERATION_PREFIX)
  );
}

/**
 * Physical key for an OAuth value in one authorization epoch. Legacy values
 * keep their historical names so upgrades can read an existing grant. Modern
 * values get an epoch-specific namespace: a stale write or delete can then
 * affect only its own flow, even if it lands after a replacement flow.
 */
export function oauthValueStorageKey(
  key: string,
  generation: string | null,
): string {
  return generation !== null && isModernGeneration(generation)
    ? `${key}:epoch:${generation}`
    : key;
}

function cleanupBacklogKey(generation: string): string {
  return `oauth:cleanup:${encodeURIComponent(generation)}`;
}

/**
 * Retirement times for a lineage, beside it rather than inside it: the
 * manifest stays the plain array of generation names every release reads, so
 * rolling back to one that predates the times still resets and cleans up.
 * Membership belongs to the manifest alone. A time with no manifest entry is
 * ignored, and an entry with no time reads as retired "now", so any
 * interleaving of the two keys errs toward a longer grace.
 */
function cleanupTimesKey(generation: string): string {
  return `oauth:cleanup-at:${encodeURIComponent(generation)}`;
}

/** Parse a times record, reading anything malformed as "no times known". */
function retirementTimes(raw: string | null): Map<string, number> {
  const times = new Map<string, number>();
  if (raw === null) return times;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return times;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return times;
  }
  for (const [generation, retiredAt] of Object.entries(parsed)) {
    if (typeof retiredAt === "number" && Number.isFinite(retiredAt)) {
      times.set(generation, retiredAt);
    }
  }
  return times;
}

/**
 * OAuthClientProvider implemented over KVStorage for a single downstream
 * connector. Keys live in the connector's namespace as `oauth:<field>`.
 *
 * Headless twist: redirectToAuthorization() cannot navigate a user agent, so it
 * STORES the authorization URL; the registry surfaces it as status
 * "auth_required" and the operator opens it. The /oauth/callback/<id> route then
 * drives transport.finishAuth(code).
 */
export class KvOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  /**
   * The reset generation this provider's flow started under. Every OAuth value
   * it writes carries this epoch, so a late write can land after a reset without
   * becoming readable under the new generation.
   */
  private capturedGeneration: string | null = null;
  private refreshFlight:
    | { generation: string; flight: OAuthRefreshFlight }
    | undefined;
  /** How the last refresh this provider took part in failed, if it did. */
  private refreshFailure: RefreshFailure | undefined;
  /**
   * Set once a flow has begun (`beginFlow`, `bindFlow`). From then on every
   * read and write the flow makes is bound to `capturedGeneration`: a
   * superseded epoch is never followed to the live one, and the flow fails.
   */
  private flowBound = false;
  /**
   * The callback this provider verified, set by a matching `verifyState`.
   * `state` is the exact stored string it matched, which the exchange claims
   * before the code leaves. `basis` is the raw client and tokens the epoch
   * held when the exchange was bound — or that the exchange itself wrote
   * since — and a failed exchange invalidates nothing else. `refusal` is the
   * token endpoint's answer to a code it refused, handed back to the SDK's
   * own retry instead of sending the code a second time.
   */
  private callback:
    | {
        state: string;
        basis?: { client: string | null; tokens: string | null };
        claimed: boolean;
        refusal?: Response;
      }
    | undefined;
  /** Tokens this request's issuer-aware auth flow decided to refresh. */
  private refreshBasis:
    | {
        accessToken: string;
        refreshToken?: string;
        generation: string;
        successIdentity?: object;
        /** The issuer the read was bound to, which a refresh answers to. */
        issuer: string;
      }
    | undefined;

  constructor(
    private readonly connectorId: string,
    private readonly storage: KVStorage,
    private readonly redirectUri: string,
    private readonly refreshCoordinator?: OAuthRefreshCoordinator,
    private readonly allowAuthorization = true,
    /** Present when the deployment's vault can seal; credentials are then ciphertext. */
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
  ) {
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
  }

  /**
   * Stamp the force-reauth generation the current connect flow started under.
   * Called by the connector once per connect, before c.connect(). The callback
   * path captures the generation stored beside its verified state instead.
   */
  captureGeneration(gen: string): void {
    this.capturedGeneration = gen;
  }

  /** The generation captured for this flow, before a concurrent reset. */
  async flowGeneration(): Promise<string> {
    return this.capturedGeneration ?? this.generation();
  }

  /** @internal Record the refresh attempt this provider owns. */
  captureRefreshFlight(
    generation: string,
    flight: OAuthRefreshFlight,
  ): void {
    this.refreshFlight = { generation, flight };
  }

  /**
   * @internal How the refresh this provider owned or joined failed, recorded by
   * the coordinator; `undefined` clears it. The SDK learns nothing from this
   * directly — the hooks it calls next (`state`, `saveCodeVerifier`,
   * `redirectToAuthorization`, `invalidateCredentials`) read it.
   */
  recordRefreshFailure(failure: RefreshFailure | undefined): void {
    this.refreshFailure = failure;
  }

  /**
   * @internal Delete the grant the authorization server just refused, but only
   * while storage still holds exactly that refresh token in this generation: a
   * consent that completed meanwhile must survive. Where the store has
   * `compareAndSet`, the delete is conditional on the exact raw string read
   * (ciphertext, when sealed), so a write landing in between wins. A store
   * without it (Workers KV) gets the read followed by a plain delete, and a
   * write landing between the two can still be lost — the same window the
   * SDK's own invalidation has. Best effort: if storage fails, the next
   * refresh is refused again and ends the same way.
   */
  async discardRefusedGrant(
    refreshToken: string | null,
    generation: string,
  ): Promise<void> {
    try {
      const read = await this.readStoredValue(
        "oauth:tokens",
        (raw) => JSON.parse(raw) as OAuthTokens,
      );
      if (
        !read ||
        read.stored.generation !== generation ||
        read.stored.value.refresh_token !== refreshToken
      ) {
        return;
      }
      const physicalKey = oauthValueStorageKey("oauth:tokens", generation);
      if (this.storage.compareAndSet) {
        await this.storage.compareAndSet(physicalKey, read.raw, null);
      } else {
        await this.storage.delete(physicalKey);
      }
    } catch {
      // See above: a refusal that could not be recorded recurs, it does not hide.
    }
  }

  /**
   * Why a passive request cannot start consent. After a transient refresh
   * failure that is a retryable outage, not an authorization problem: the SDK
   * falls through to authorization on any refresh it could not parse, and
   * answering that with `UnauthorizedError` would tell the agent a working
   * grant needs consent.
   */
  /**
   * A credential write that storage refused, in fixed text and with no
   * cause attached. Retryable: the grant it held is untouched, so the next
   * call either refreshes again or meets the server's verdict on it.
   */
  private credentialWriteError(): ConnectorCallError {
    return new ConnectorCallError(
      "unavailable",
      `Connector "${this.connectorId}" could not store its OAuth credentials; try again shortly.`,
    );
  }

  private authorizationRefused(): Error {
    const failure = this.refreshFailure;
    return failure?.kind === "transient"
      ? this.refreshOutage(failure)
      : new UnauthorizedError(
          "Authorization required. Use authorize_connector or Connect to start consent.",
        );
  }

  private refreshOutage(failure: TransientRefreshFailure): ConnectorCallError {
    const { cause } = failure;
    return new ConnectorCallError(
      failure.status === 429 ? "rate_limited" : "unavailable",
      `Connector "${this.connectorId}" could not refresh its OAuth grant: the ` +
        `authorization server ${failure.reason}. The grant is kept; retry later.`,
      {
        ...(cause !== undefined ? { cause } : {}),
        ...(failure.retryAfterMs !== undefined
          ? { retryAfterMs: failure.retryAfterMs }
          : {}),
        ...(cause instanceof ConnectorCallError && cause.details
          ? { details: cause.details }
          : {}),
      },
    );
  }

  private failRefreshFlight(error: unknown): void {
    const owned = this.refreshFlight;
    this.refreshFlight = undefined;
    if (owned) {
      this.refreshCoordinator?.fail(owned.generation, owned.flight, error);
    }
  }

  /** @internal The issuer this flow's issuer-aware read bound its refresh to. */
  refreshIssuer(generation: string): string | undefined {
    const basis = this.refreshBasis;
    return basis?.generation === generation ? basis.issuer : undefined;
  }

  /** True when another request saved a refresh result after this flow's read. */
  refreshBasisChanged(current: OAuthTokens, generation: string): boolean {
    const basis = this.refreshBasis;
    return Boolean(
      basis &&
        basis.generation === generation &&
        (basis.accessToken !== current.access_token ||
          basis.refreshToken !== current.refresh_token ||
          basis.successIdentity !==
            this.refreshCoordinator?.successfulRefreshIdentity(generation)),
    );
  }

  /**
   * The epoch this provider writes under. Direct unit/custom use lazily captures
   * the current generation; connector-driven connect and callback paths stamp it
   * explicitly before the SDK can write.
   */
  private async writeGeneration(): Promise<string> {
    this.capturedGeneration ??= await this.generation();
    return this.capturedGeneration;
  }

  /**
   * Store a value in the flow's physical epoch namespace. The pre-write check
   * avoids needless stale residue. The namespaced key closes the remaining
   * check-then-write race: a late old write cannot overwrite a replacement
   * flow's value because the two writes have different physical keys.
   */
  private async writeValue<T>(
    key: string,
    value: T,
    serializeLegacy: (value: T) => string,
    issuer?: string,
    writtenAt?: number,
    binding?: string,
    commitAcceptedRefresh = false,
  ): Promise<void> {
    const generation = await this.writeGeneration();
    await this.storeInGeneration(key, generation, () => {
      const stored: StoredOAuthValue<T> = {
        connectaOAuthVersion: STORED_VALUE_VERSION,
        generation,
        ...(issuer !== undefined ? { issuer } : {}),
        ...(binding !== undefined ? { binding } : {}),
        ...(writtenAt !== undefined ? { writtenAt } : {}),
        value,
      };
      return isModernGeneration(generation) || issuer !== undefined
        ? JSON.stringify(stored)
        : serializeLegacy(value);
    }, undefined, commitAcceptedRefresh);
  }

  /**
   * The generation fence every write goes through: refuse unless `generation`
   * is still the live, writable epoch, write (sealed when the key holds a
   * credential and a sealer exists), then clean up if the epoch moved under
   * the write. With `expected`, the write also requires the physical key to
   * still hold exactly that raw value, so re-encoding cannot resurrect a value
   * another request replaced in the meantime.
   */
  private async storeInGeneration(
    key: string,
    generation: string,
    serialize: () => string,
    expected?: string,
    commitAcceptedRefresh = false,
  ): Promise<void> {
    if (
      (!commitAcceptedRefresh && this.signal?.aborted) ||
      generation.startsWith(RESETTING_GENERATION_PREFIX) ||
      generation.startsWith(DISCONNECTED_GENERATION_PREFIX)
    ) {
      return;
    }
    if ((await this.generation()) !== generation) {
      // A flow bound to a superseded epoch fails there: it must not hand back
      // a consent URL it could not store. A late commit of an accepted
      // rotation stays silent, as it always was.
      if (this.flowBound && !commitAcceptedRefresh && generation === this.capturedGeneration) {
        throw this.flowSuperseded();
      }
      return;
    }
    const physicalKey = oauthValueStorageKey(key, generation);
    const plaintext = serialize();
    const serialized =
      this.sealer && SEALED_OAUTH_KEYS.has(key)
        ? JSON.stringify({
            connectaOAuthSealed: SEALED_VALUE_VERSION,
            sealed: await this.sealer.seal(physicalKey, plaintext),
          } satisfies SealedOAuthValue)
        : plaintext;
    if (!commitAcceptedRefresh && this.signal?.aborted) return;
    try {
      if (expected === undefined) {
        await this.storage.set(physicalKey, serialized);
      } else if (!(await this.replaceExactly(physicalKey, expected, serialized))) {
        return;
      }
    } catch (error) {
      // A store's own error can quote the value it refused, and from here a
      // failed credential write reaches the SDK, its console, and the agent.
      if (SEALED_OAUTH_KEYS.has(key)) throw this.credentialWriteError();
      throw error;
    }
    // A credential the exchange itself wrote is one it may invalidate again.
    const basis = this.callback?.basis;
    if (basis && generation === this.capturedGeneration) {
      if (key === "oauth:client") basis.client = serialized;
      else if (key === "oauth:tokens") basis.tokens = serialized;
    }
    // If reset landed after the pre-write check and completed its cleanup
    // before this set, remove the now-unreachable residue ourselves. The epoch
    // key already provides correctness; this second check is physical hygiene.
    const current = await this.generation();
    const superseded =
      current !== generation &&
      this.flowBound &&
      !commitAcceptedRefresh &&
      generation === this.capturedGeneration;
    if (current !== generation || (!commitAcceptedRefresh && this.signal?.aborted)) {
      try {
        // On cancellation the generation may still be active. A newer flow
        // could have written this key while the old storage set was pending.
        if (this.storage.compareAndSet) {
          await this.storage.compareAndSet(physicalKey, serialized, null);
        } else if ((await this.storage.get(physicalKey)) === serialized) {
          await this.storage.delete(physicalKey);
        }
      } catch {
        // Make a transient cleanup failure retryable by the next force reset.
        // This is still best-effort if storage cannot accept the backlog write.
        try {
          await this.rememberRetiredGeneration(current, generation);
        } catch {
          // The old namespace is already unreadable; storage availability is
          // the remaining physical-hygiene boundary.
        }
      }
    }
    // A bound flow's write that a reset overtook mid-flight is cleaned up
    // above, but it did not succeed: the flow must not go on as if it had —
    // a consent URL it reports would be one it could not store.
    if (superseded) throw this.flowSuperseded();
  }

  /**
   * Compare-and-set where the store has it. A store without it gets a re-read
   * immediately before the write: it narrows the race to one round trip, the
   * same exposure that store already has for every other OAuth write.
   */
  private async replaceExactly(
    physicalKey: string,
    expected: string,
    next: string,
  ): Promise<boolean> {
    if (this.storage.compareAndSet) {
      return this.storage.compareAndSet(physicalKey, expected, next);
    }
    if ((await this.storage.get(physicalKey)) !== expected) return false;
    await this.storage.set(physicalKey, next);
    return true;
  }

  /**
   * Open a sealed credential. Anything that does not open — a tampered value,
   * a rotated vault key, ciphertext copied from another connector or owner, or
   * sealed state with no sealer configured — reads as absent, which fails
   * closed to reauthorization.
   */
  private async openValue(
    key: string,
    physicalKey: string,
    sealed: string,
  ): Promise<string | undefined> {
    if (!this.sealer || !SEALED_OAUTH_KEYS.has(key)) return undefined;
    try {
      return await this.sealer.open(physicalKey, sealed);
    } catch {
      this.sealer.warn(
        `[connecta] connector "${this.connectorId}" has sealed OAuth state ` +
          `(${key}) the configured vault cannot open; treating it as absent, ` +
          "so the connector needs authorization again. A changed vault key " +
          "or tampered storage causes this.",
      );
      return undefined;
    }
  }

  /**
   * Re-encode plaintext an older release (or a vault-less deployment) wrote,
   * in place and byte-for-byte, through the same generation fence as every
   * write. A failure leaves the plaintext readable; the next write seals it.
   */
  private async sealInPlace(
    key: string,
    generation: string,
    raw: string,
  ): Promise<void> {
    try {
      await this.storeInGeneration(key, generation, () => raw, raw);
    } catch {
      this.sealer?.warn(
        `[connecta] connector "${this.connectorId}" could not seal plaintext ` +
          `OAuth state (${key}); it stays readable and is sealed on its next write.`,
      );
    }
  }

  /**
   * Read a value only when it belongs to the active generation. Plain legacy
   * values remain readable until the first v2 reset, so upgrades do not discard
   * an existing grant; once a modern epoch exists, untagged residue fails
   * closed. With a sealer, a credential found in plaintext is returned and
   * then sealed where it lies.
   */
  private async readValue<T>(
    key: string,
    parseLegacy: (raw: string) => T,
  ): Promise<
    | OAuthValueRead<T>
    | undefined
  > {
    const read = await this.readStoredValue(key, parseLegacy);
    if (!read) return undefined;
    if (read.plaintextCredential) {
      await this.sealInPlace(key, read.stored.generation, read.raw);
    }
    return read.stored;
  }

  /**
   * `readValue` without the in-place sealing, keeping the exact raw string
   * (ciphertext, when sealed) the value came from, for a compare-and-set.
   */
  private async readStoredValue<T>(
    key: string,
    parseLegacy: (raw: string) => T,
  ): Promise<
    | {
        stored: OAuthValueRead<T>;
        raw: string;
        plaintextCredential: boolean;
      }
    | undefined
  > {
    let generation: string;
    let raw: string | null;
    if (this.flowBound && this.capturedGeneration !== null) {
      // The flow's own epoch, read beside the live one: a flow whose epoch a
      // later reset replaced must not read on into the newer epoch.
      generation = this.capturedGeneration;
      const [live, value] = await Promise.all([
        this.generation(),
        this.storage.get(oauthValueStorageKey(key, generation)),
      ]);
      if (live !== generation) throw this.flowSuperseded();
      raw = value;
    } else {
      generation = await this.generation();
      raw = await this.storage.get(oauthValueStorageKey(key, generation));
    }
    if (raw === null) return undefined;
    return this.openStoredValue(key, generation, raw, parseLegacy);
  }

  /** Decode one physical value: unseal it, then read its envelope or legacy form. */
  private async openStoredValue<T>(
    key: string,
    generation: string,
    raw: string,
    parseLegacy: (raw: string) => T,
  ): Promise<
    | {
        stored: OAuthValueRead<T>;
        raw: string;
        plaintextCredential: boolean;
      }
    | undefined
  > {
    const physicalKey = oauthValueStorageKey(key, generation);
    if (
      generation.startsWith(RESETTING_GENERATION_PREFIX) ||
      generation.startsWith(DISCONNECTED_GENERATION_PREFIX)
    ) {
      return undefined;
    }

    let text = raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Raw string state from a pre-envelope deployment is handled below.
    }
    let plaintextCredential = false;
    if (sealedOAuthValue(parsed)) {
      const opened = await this.openValue(key, physicalKey, parsed.sealed);
      if (opened === undefined) return undefined;
      text = opened;
      parsed = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A sealed raw legacy string, handled below like its plaintext form.
      }
    } else {
      plaintextCredential = this.sealer !== undefined && SEALED_OAUTH_KEYS.has(key);
    }

    const stored = this.interpretValue(text, parsed, generation, parseLegacy);
    return stored ? { stored, raw, plaintextCredential } : undefined;
  }

  private interpretValue<T>(
    raw: string,
    parsed: unknown,
    generation: string,
    parseLegacy: (raw: string) => T,
  ):
    | OAuthValueRead<T>
    | undefined {
    if (storedOAuthValue<T>(parsed)) {
      return parsed.generation === generation
        ? {
            value: parsed.value,
            generation,
            ...(parsed.issuer !== undefined ? { issuer: parsed.issuer } : {}),
            ...(parsed.binding !== undefined ? { binding: parsed.binding } : {}),
            ...(parsed.carried === true ? { carried: true as const } : {}),
            // Only a finite number is a time; anything else reads as untimed.
            ...(typeof parsed.writtenAt === "number" &&
            Number.isFinite(parsed.writtenAt)
              ? { writtenAt: parsed.writtenAt }
              : {}),
          }
        : undefined;
    }
    if (legacyStoredOAuthValue<T>(parsed)) {
      return parsed.generation === generation
        ? { value: parsed.value, generation }
        : undefined;
    }
    if (isModernGeneration(generation)) return undefined;
    return { value: parseLegacy(raw), generation };
  }

  /**
   * Read credentials only for the authorization server that issued them.
   *
   * Nothing is retired here. `beginFlow` decided, before the SDK ran, whether
   * the grant in the flow's epoch belongs to the server it will use; a value
   * bound to any other server is simply not this flow's, and the SDK goes on
   * to register and consent within the same epoch.
   */
  private async readIssuerBoundValue<T>(
    key: "oauth:client" | "oauth:tokens",
    parseLegacy: (raw: string) => T,
    ctx?: OAuthClientInformationContext,
  ): Promise<T | undefined> {
    const read = await this.readStoredValue(key, parseLegacy);
    if (!read) return undefined;
    const stored = read.stored;
    if (!ctx || stored.issuer !== undefined) {
      if (read.plaintextCredential) {
        await this.sealInPlace(key, stored.generation, read.raw);
      }
      if (!ctx) return stored.value;
    }
    // Unstamped, or stamped for another server: never this flow's to send.
    return stored.issuer === ctx.issuer
      ? stampedValue(stored.value, ctx.issuer)
      : undefined;
  }

  /**
   * Begin an issuer-aware flow — a connect, whose 401 may refresh or start
   * consent, or an `api()` call or start — before the SDK is handed this
   * provider. The grant in the live epoch is decided here, once:
   *
   * - A grant is kept when every credential in it carries a stamp, the stamps
   *   agree, and they name the server the epoch's discovery names, if it kept
   *   one. With discovery cached the SDK uses it, so the flow cannot meet
   *   another server; without it (a grant from before v0.22.3 not refreshed
   *   since, or a forced restart's carried client) the SDK discovers afresh,
   *   and a server other than the stamp's is handed nothing by the
   *   issuer-bound reads below. The SDK then registers and consents within
   *   the same epoch, and the mixed grant that leaves is retired by the next
   *   flow's entry.
   * - Anything else — a value written before issuer binding (v0.8.1 and
   *   earlier), or stamps that disagree with each other or with the epoch's
   *   discovery — is retired before anything it holds is sent.
   *
   * Every read and write of the flow is then bound to the resulting epoch;
   * once a later reset supersedes it the flow fails, and is retried afresh.
   * Returns that epoch.
   */
  async beginFlow(): Promise<string> {
    this.flowBound = false;
    const generation = await this.generation();
    let epoch = generation;
    if (
      !generation.startsWith(RESETTING_GENERATION_PREFIX) &&
      !generation.startsWith(DISCONNECTED_GENERATION_PREFIX)
    ) {
      const json = (raw: string) => JSON.parse(raw) as unknown;
      const [client, tokens, issuer] = await Promise.all([
        this.readStoredValueIn("oauth:client", generation, json),
        this.readStoredValueIn("oauth:tokens", generation, json),
        this.recordedIssuer(generation),
      ]);
      // Every stored credential must carry a stamp, the stamps must agree, and
      // they must name the server the epoch's discovery names, if it kept one.
      const stamps = [client, tokens]
        .filter((read) => read !== undefined)
        .map((read) => read.stored.issuer);
      const keep = stamps.every(
        (stamp) => stamp !== undefined && stamp === stamps[0] && (issuer === undefined || stamp === issuer),
      );
      if (!keep) {
        if (this.signal?.aborted) throw this.signal.reason;
        epoch = await this.retireGrant(generation);
      }
    }
    this.captureGeneration(epoch);
    this.flowBound = true;
    return epoch;
  }

  /**
   * Bind a flow that already has its epoch — a callback, whose state check
   * captured the epoch its consent was written in — without deciding
   * anything about the grant there. An epoch a later reset already replaced
   * fails here, before the SDK can send the code anywhere.
   */
  async bindFlow(): Promise<void> {
    const captured = this.capturedGeneration ?? (await this.generation());
    const callback = this.callback;
    // A verified callback also records what credentials its epoch holds as
    // the exchange begins, beside the epoch check rather than after it.
    const [live, client, tokens] = await Promise.all([
      this.generation(),
      callback ? this.storage.get(oauthValueStorageKey("oauth:client", captured)) : null,
      callback ? this.storage.get(oauthValueStorageKey("oauth:tokens", captured)) : null,
    ]);
    if (live !== captured) throw this.flowSuperseded();
    if (callback) callback.basis = { client, tokens };
    this.captureGeneration(captured);
    this.flowBound = true;
  }

  /**
   * @internal The fence a code exchange crosses immediately before the token
   * request leaves, after every read it depends on — client, verifier,
   * discovery — has completed.
   *
   * A verified callback claims its state here: on a store with
   * `compareAndSet` the claim swaps out the exact value `verifyState`
   * matched, so of several callbacks carrying one state exactly one wins and
   * the rest send nothing. A store without it gets a re-read and a delete,
   * which stops a duplicate that arrives after the winner's claim and narrows
   * — without closing — the race between two that arrive together. Beside the
   * claim, the live epoch is read once more: a value read can complete after
   * its own epoch check, so a restart published in that gap is caught here,
   * before the code, verifier, or client secret is sent anywhere.
   *
   * The claim is spent whether or not the exchange then succeeds. The SDK
   * retries a refused code once after invalidating credentials; that retry is
   * answered with the refusal already received rather than sent again.
   */
  async fenceCodeExchange(): Promise<Response | undefined> {
    const callback = this.callback;
    const generation = this.capturedGeneration;
    if (callback?.refusal) return callback.refusal.clone();
    if (!callback || generation === null) {
      // Not a callback this provider verified: a bound flow still fences its
      // epoch, and anything else (direct use of the provider) is unchanged.
      if (this.flowBound && generation !== null && (await this.generation()) !== generation) {
        throw this.flowSuperseded();
      }
      return undefined;
    }
    if (callback.claimed) throw this.callbackAlreadyClaimed();
    callback.claimed = true;
    const stateKey = oauthValueStorageKey("oauth:state", generation);
    const claim = this.storage.compareAndSet
      ? this.storage.compareAndSet(stateKey, callback.state, null)
      : this.storage.get(stateKey).then(async (raw) => {
          if (raw !== callback.state) return false;
          await this.storage.delete(stateKey);
          return true;
        });
    const [claimed, live] = await Promise.all([claim, this.generation()]);
    if (live !== generation) throw this.flowSuperseded();
    if (!claimed) throw this.callbackAlreadyClaimed();
    return undefined;
  }

  /** @internal Keep a refused code's answer for the SDK's retry to read. */
  recordCodeExchangeRefusal(forSdk: Response): void {
    if (this.callback) this.callback.refusal = forSdk.clone();
  }

  /** A callback whose state another callback already claimed: fixed text, nothing sent. */
  private callbackAlreadyClaimed(): ConnectorCallError {
    return new ConnectorCallError(
      "connector_call_failed",
      `Connector "${this.connectorId}" authorization callback was already used by another request; nothing was exchanged.`,
    );
  }

  /** The issuer the epoch's own discovery names, as the SDK would derive it. */
  protected async recordedIssuer(generation: string): Promise<string | undefined> {
    const read = await this.readStoredValueIn(
      "oauth:discovery",
      generation,
      (raw) => JSON.parse(raw) as OAuthDiscoveryState,
    );
    const state = read?.stored.value as Partial<OAuthDiscoveryState> | undefined;
    if (!state || typeof state !== "object" || !state.authorizationServerUrl) return undefined;
    const issuer = state.authorizationServerMetadata?.issuer ?? String(state.authorizationServerUrl);
    return typeof issuer === "string" && issuer !== "" ? issuer : undefined;
  }

  /** A stored value in a named epoch, outside any flow's binding. */
  private async readStoredValueIn<T>(
    key: string,
    generation: string,
    parseLegacy: (raw: string) => T,
  ) {
    const raw = await this.storage.get(oauthValueStorageKey(key, generation));
    if (raw === null) return undefined;
    return this.openStoredValue(key, generation, raw, parseLegacy);
  }

  /** The fixed, retryable failure of a flow a later reset superseded. */
  private flowSuperseded(): ConnectorCallError {
    return new ConnectorCallError(
      "unavailable",
      `Connector "${this.connectorId}" authorization changed while this request was in flight; try again.`,
    );
  }

  /**
   * Attempt every key deletion, a bounded number at a time, then report the
   * first failure in key order. The deletes are independent, so none waits
   * on another's round trip.
   */
  private async deleteAll(
    keys: readonly string[],
    limit: StorageLimit = concurrencyLimit(DELETE_CONCURRENCY),
  ): Promise<void> {
    const failure = firstRejection(
      await Promise.allSettled(
        keys.map((key) => limit(() => this.storage.delete(key))),
      ),
    );
    if (failure) throw failure.reason;
  }

  /**
   * Delete each retired generation's values, then its own manifest and times
   * once every value is gone, sharing one bound across all of them. Settles
   * one result per generation, in input order.
   */
  private cleanupGenerations(
    generations: readonly string[],
    limit: StorageLimit,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      generations.map(async (generation) => {
        await this.deleteAll(this.valueKeysForGeneration(generation), limit);
        await this.deleteAll(
          [cleanupBacklogKey(generation), cleanupTimesKey(generation)],
          limit,
        );
      }),
    );
  }

  /**
   * The cleanup lineage published for `generation`, with retirement times,
   * and the times record exactly as stored. An entry with no recorded time —
   * written by an earlier release, or whose time write failed — reads as
   * retired `now`, which can only lengthen its grace.
   */
  private async cleanupBacklog(
    generation: string,
    now: number,
  ): Promise<{
    lineage: RetiredGeneration[];
    recorded: Map<string, number>;
    /** Whether `generation` has a manifest at all. */
    published: boolean;
  }> {
    const reads = await Promise.allSettled([
      this.storage.get(cleanupBacklogKey(generation)),
      this.storage.get(cleanupTimesKey(generation)),
    ]);
    const failure = firstRejection(reads);
    if (failure) throw failure.reason;
    const [raw, rawTimes] = reads.map((read) =>
      read.status === "fulfilled" ? read.value : null,
    );
    const recorded = retirementTimes(rawTimes ?? null);
    if (raw === null || raw === undefined) {
      return { lineage: [], recorded, published: false };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_CLEANUP_BACKLOG ||
      !parsed.every((value) => typeof value === "string")
    ) {
      throw new Error(
        `Invalid OAuth cleanup backlog for "${this.connectorId}"`,
      );
    }
    return {
      lineage: mergeLineage(
        (parsed as string[]).map((entry) => ({
          generation: entry,
          retiredAt: recorded.get(entry) ?? now,
        })),
      ),
      recorded,
      published: true,
    };
  }

  private timesRecord(
    lineage: Iterable<readonly [string, number]>,
  ): string {
    return JSON.stringify(Object.fromEntries(lineage));
  }

  /** Write a lineage's manifest and its times, reporting the first failure. */
  private async publishLineage(
    generation: string,
    lineage: readonly RetiredGeneration[],
  ): Promise<void> {
    const failure = firstRejection(
      await Promise.allSettled([
        this.storage.set(
          cleanupBacklogKey(generation),
          JSON.stringify(lineage.map((entry) => entry.generation)),
        ),
        this.storage.set(
          cleanupTimesKey(generation),
          this.timesRecord(
            lineage.map((entry) => [entry.generation, entry.retiredAt] as const),
          ),
        ),
      ]),
    );
    if (failure) throw failure.reason;
  }

  /**
   * Record that a write just landed in `retired` after `active` fenced it,
   * so its grace starts over from now. A generation not yet listed is
   * appended. One already listed keeps its place in the manifest and has
   * only its time moved: a reset that is sweeping it re-reads the lineage
   * before publishing, sees the new time, and keeps it.
   *
   * Only the times record is rewritten for a listed generation, so this can
   * never drop a manifest entry. Two late writers racing here can lose one
   * time update to the other: a lost bump leaves the older time, which
   * shortens that generation's grace back to what it was before the write
   * (no worse than never recording it), and a time dropped from the record
   * reads as retired "now", which only lengthens a grace.
   */
  private async rememberRetiredGeneration(
    active: string,
    ...retired: string[]
  ): Promise<void> {
    const now = Date.now();
    const { lineage, recorded } = await this.cleanupBacklog(active, now);
    const listed = new Set(lineage.map((entry) => entry.generation));
    const appended = retired.filter((generation) => !listed.has(generation));
    if (appended.length === 0) {
      await this.storage.set(
        cleanupTimesKey(active),
        this.timesRecord([
          ...recorded,
          ...retired.map((generation) => [generation, now] as const),
        ]),
      );
      return;
    }
    if (lineage.length + appended.length > MAX_CLEANUP_BACKLOG) {
      throw new Error(
        `OAuth cleanup backlog for "${this.connectorId}" is full`,
      );
    }
    await this.publishLineage(active, mergeLineage(
      lineage,
      retired.map((generation) => ({ generation, retiredAt: now })),
    ));
  }

  /**
   * After an entry retirement's activation on a store without
   * `compareAndSet`, record as retired under `active` any epoch another reset
   * published from `previous` meanwhile — one this write has just replaced.
   *
   * The retirement rechecked `previous` before its plain write, and a restart
   * can still run start to finish between the two: publish its epoch, retire
   * `previous`, complete its consent. The write then replaces that epoch, and
   * no lineage names it, because neither reset read the other's. Its grant is
   * unreachable — one more consent, which only an atomic swap could have
   * spared — and, unless it is recorded here, never deleted either.
   *
   * The sign is `previous`'s own manifest. It existed when this reset read
   * it, and only a reset that retired `previous` deletes it, after that
   * reset's own activation and the deletion of `previous`'s values. Gone now,
   * a sibling has retired `previous`. Its name is not recorded anywhere this
   * reset can read directly, so the manifests are listed: an epoch with one
   * that this lineage does not name is the sibling, or one that followed it,
   * or residue a failed retirement abandoned. Each is recorded, at most
   * MAX_EXPIRED_SWEEP of them, and the next Disconnect or Restart deletes
   * those still carrying a manifest; the sweep reclaims the rest once their
   * grace has passed. Nothing is read on any other reset.
   *
   * Best effort, as all cleanup is. It needs `list`; it misses a sibling
   * whose own cleanup has not yet deleted `previous`'s manifest; and an
   * eventually consistent store can list late. A failure here never fails the
   * retirement — the fence, not this, keeps a replaced grant out of use.
   */
  private async adoptReplacedSiblings(
    previous: string,
    active: string,
    lineage: readonly RetiredGeneration[],
  ): Promise<void> {
    const list = this.storage.list?.bind(this.storage);
    if (!list) return;
    try {
      if ((await this.storage.get(cleanupBacklogKey(previous))) !== null) return;
      const prefix = cleanupBacklogKey("");
      const named = new Set([
        active,
        previous,
        ...lineage.map((entry) => entry.generation),
      ]);
      const siblings: string[] = [];
      for (const key of await list(prefix)) {
        let generation: string;
        try {
          generation = decodeURIComponent(key.slice(prefix.length));
        } catch {
          continue;
        }
        if (named.has(generation) || !isModernGeneration(generation)) continue;
        siblings.push(generation);
        if (siblings.length >= MAX_EXPIRED_SWEEP) break;
      }
      if (siblings.length > 0) {
        await this.rememberRetiredGeneration(active, ...siblings);
      }
    } catch {
      // Hygiene only, as above.
    }
  }

  private valueKeysForGeneration(generation: string): string[] {
    return OAUTH_VALUE_KEYS.map((key) =>
      oauthValueStorageKey(key, generation),
    );
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUri],
      client_name: "connecta",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
    };
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<OAuthClientInformationMixed | undefined> {
    return this.readIssuerBoundValue(
      "oauth:client",
      (raw) => JSON.parse(raw) as OAuthClientInformationMixed,
      ctx,
    );
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.writeValue(
      "oauth:client",
      info,
      (value) => JSON.stringify(value),
      ctx?.issuer,
      undefined,
      this.clientBinding,
    );
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (
      await this.readValue(
        "oauth:discovery",
        (raw) => JSON.parse(raw) as OAuthDiscoveryState,
      )
    )?.value;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.writeValue(
      "oauth:discovery",
      state,
      (value) => JSON.stringify(value),
    );
  }

  async tokens(
    ctx?: OAuthClientInformationContext,
  ): Promise<OAuthTokens | undefined> {
    const refreshGeneration = ctx ? await this.flowGeneration() : undefined;
    const successIdentity =
      refreshGeneration !== undefined
        ? this.refreshCoordinator?.successfulRefreshIdentity(refreshGeneration)
        : undefined;
    const tokens = await this.readIssuerBoundValue(
      "oauth:tokens",
      (raw) => JSON.parse(raw) as OAuthTokens,
      ctx,
    );
    if (ctx && tokens && refreshGeneration !== undefined) {
      this.refreshBasis = {
        accessToken: tokens.access_token,
        generation: refreshGeneration,
        issuer: ctx.issuer,
        ...(tokens.refresh_token !== undefined
          ? { refreshToken: tokens.refresh_token }
          : {}),
        ...(successIdentity !== undefined ? { successIdentity } : {}),
      };
    }
    return tokens;
  }

  async saveTokens(
    tokens: OAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const owned = this.refreshFlight;
    if (owned?.flight.acceptedTokens !== undefined) {
      await this.persistAcceptedTokens(tokens, ctx, owned);
    } else {
      await this.persistTokens(tokens, ctx, false, owned);
    }
  }

  /**
   * @internal Commit an already redeemed rotation even after its request
   * leaves. A token response names no issuer, so the one the refreshed grant
   * was bound to is stamped here as the SDK's own save would: an unbound
   * rotation would read as legacy state and bind to whichever authorization
   * server the connector names next.
   */
  async saveAcceptedRefreshTokens(
    tokens: OAuthTokens,
    generation: string,
    flight: OAuthRefreshFlight,
    issuer?: string,
  ): Promise<void> {
    const stamped: OAuthTokens =
      issuer !== undefined ? { ...tokens, issuer } : tokens;
    await this.persistAcceptedTokens(
      stamped,
      issuer !== undefined ? { issuer } : undefined,
      { generation, flight },
    );
  }

  private persistAcceptedTokens(
    tokens: OAuthTokens,
    ctx: OAuthClientInformationContext | undefined,
    owned: { generation: string; flight: OAuthRefreshFlight },
  ): Promise<void> {
    // The SDK can save the same response while cancellation recovery is
    // writing it. A second write could land after the next rotation, so both
    // paths await this exact flight's one commit, including its failure.
    return owned.flight.persistence ??= this.persistTokens(tokens, ctx, true, owned);
  }

  private async persistTokens(
    tokens: OAuthTokens,
    ctx: OAuthClientInformationContext | undefined,
    commitAcceptedRefresh: boolean,
    owned: { generation: string; flight: OAuthRefreshFlight } | undefined,
  ): Promise<void> {
    const releasePartition = this.refreshCoordinator?.retainWork();
    // A retired flight (the owner was cancelled or superseded after the
    // token response) still writes: the authorization server has already
    // consumed the old refresh token, so dropping the rotated one would leave a
    // dead credential. writeValue itself refuses when the generation moved.
    // Only the coordinator bookkeeping belongs to the exact live flight.
    const coordinated =
      owned !== undefined &&
      this.refreshCoordinator?.beginMutation(owned.generation, owned.flight) === true;
    try {
      await this.writeValue(
        "oauth:tokens",
        tokens,
        (value) => JSON.stringify(value),
        ctx?.issuer,
        undefined,
        undefined,
        commitAcceptedRefresh,
      );
      if (coordinated) this.refreshCoordinator?.succeedMutation(owned.generation, owned.flight);
      this.refreshFailure = undefined;
    } catch (error) {
      if (coordinated) this.refreshCoordinator?.failMutation(owned.generation, owned.flight, error);
      throw error;
    } finally {
      // The write owns this identity even if an SDK failure callback has
      // already detached the provider's flight while storage was pending.
      if (this.refreshFlight === owned) this.refreshFlight = undefined;
      releasePartition?.();
    }
  }

  /**
   * OAuth `state`. The SDK calls this (when present) and appends the value to
   * the authorization URL. We generate a fresh random value and persist it so
   * the public /oauth/callback route can prove the callback belongs to a flow
   * WE started. Without it, anyone holding a pending authorization URL could
   * complete consent with their own account (login CSRF) — PKCE does not help,
   * since the verifier belongs to connecta, not the attacker. Cleared in
   * clearPending() once the flow completes.
   */
  async state(): Promise<string> {
    if (!this.allowAuthorization) throw this.authorizationRefused();
    const value = randomState();
    await this.writeValue("oauth:state", value, (raw) => raw);
    return value;
  }

  /**
   * Constant-time check of a callback's `state` against the stored one-shot
   * value. Absent stored state or absent candidate → false (fail closed).
   */
  async verifyState(candidate: string | null): Promise<boolean> {
    this.callback = undefined;
    // State is flow bookkeeping, never sealed, so this is the read `readValue`
    // would make — keeping the exact stored string the exchange will claim.
    const expected = await this.readStoredValue("oauth:state", (raw) => raw);
    if (!expected || candidate === null) return false;
    const matches = timingSafeEqual(candidate, expected.stored.value);
    if (matches) {
      this.captureGeneration(expected.stored.generation);
      this.callback = { state: expected.raw, claimed: false };
    }
    return matches;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.allowAuthorization) throw this.authorizationRefused();
    await this.writeValue("oauth:verifier", verifier, (raw) => raw);
  }

  async codeVerifier(): Promise<string> {
    const stored = await this.readValue("oauth:verifier", (raw) => raw);
    if (!stored) {
      throw new Error(`No PKCE code verifier for "${this.connectorId}"`);
    }
    return stored.value;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    try {
      if (!this.allowAuthorization) throw this.authorizationRefused();
      // Timestamped so a later start can tell a URL worth reissuing from a
      // stale one. A pre-envelope (legacy-generation) write keeps its raw
      // format for older readers and carries no time.
      await this.writeValue(
        "oauth:pending",
        authorizationUrl.toString(),
        (raw) => raw,
        undefined,
        Date.now(),
      );
      this.failRefreshFlight(
        new Error(
          "OAuth refresh required reauthorization before tokens were saved.",
        ),
      );
    } catch (error) {
      this.failRefreshFlight(error);
      throw error;
    }
  }

  /** The stored authorization URL, if a flow is pending. */
  async pendingAuthorizationUrl(): Promise<string | undefined> {
    return (
      await this.readValue("oauth:pending", (raw) => raw)
    )?.value;
  }

  /**
   * The pending authorization URL, only while it is still worth handing out
   * again: written within PENDING_AUTHORIZATION_MAX_AGE_MS of now, in either
   * direction to tolerate clock skew between isolates. A URL with no write
   * time — stored by an earlier release, or under a pre-envelope generation —
   * is treated as stale, so the caller starts a fresh flow instead.
   *
   * The URL must also still name the epoch's client. A callback whose code
   * exchange the server refused with `invalid_client` leaves the URL behind
   * but drops the client; handing that URL back would send the operator to a
   * consent the server has already refused, where a fresh flow registers.
   */
  async reusablePendingAuthorizationUrl(): Promise<string | undefined> {
    const [pending, state] = await Promise.all([
      this.readValue("oauth:pending", (raw) => raw),
      this.readValue("oauth:state", (raw) => raw),
    ]);
    if (
      pending?.writtenAt === undefined ||
      Math.abs(Date.now() - pending.writtenAt) >= PENDING_AUTHORIZATION_MAX_AGE_MS
    ) {
      return undefined;
    }
    let clientId: string | null;
    let urlState: string | null;
    try {
      const params = new URL(pending.value).searchParams;
      clientId = params.get("client_id");
      urlState = params.get("state");
    } catch {
      return undefined;
    }
    // A callback claims the state when its exchange begins, and the claim
    // outlives a failed exchange: a URL whose state is spent would only send
    // the operator to a consent whose callback is refused.
    if (urlState !== null && urlState !== state?.value) return undefined;
    const client = await this.clientInformation();
    return clientId !== null && client?.client_id === clientId
      ? pending.value
      : undefined;
  }

  /** Clear one-shot flow state after the callback completes. */
  async clearPending(): Promise<void> {
    const generation = await this.writeGeneration();
    await this.deleteAll([
      oauthValueStorageKey("oauth:pending", generation),
      oauthValueStorageKey("oauth:verifier", generation),
      oauthValueStorageKey("oauth:state", generation),
    ]);
  }

  /**
   * Force-reauth epoch shared across isolates through storage. Old numeric
   * generations remain valid strings for migration; new resets use unique
   * nonces, avoiding the lost-update race of read/increment/write.
   */
  async generation(): Promise<string> {
    return (await this.storage.get("oauth:generation")) ?? LEGACY_GENERATION;
  }

  /** True only after an operator disconnect, until an explicit authorization starts. */
  async operatorDisconnected(): Promise<boolean> {
    return this.isOperatorDisconnectedGeneration(await this.generation());
  }

  /** Interpret a generation already read by a connector without another KV lookup. */
  isOperatorDisconnectedGeneration(generation: string): boolean {
    return generation.startsWith(DISCONNECTED_GENERATION_PREFIX);
  }

  /** Publish a unique active epoch without a read/modify/write race. */
  async bumpGeneration(): Promise<string> {
    const next = `${ACTIVE_GENERATION_PREFIX}${crypto.randomUUID()}`;
    await this.storage.set("oauth:generation", next);
    return next;
  }

  /**
   * Fence every flow that could still write, then remove all durable and
   * one-shot authorization state. The generation is intentionally retained:
   * it is the epoch fence that tells another isolate not to resurrect
   * credentials it read before this reset.
   *
   * Once the fence is durable, attempt every deletion even if one fails. A
   * partial backend outage should not leave unrelated secrets behind merely
   * because an earlier key happened to be the first failed delete.
   *
   * A reset's storage work does not grow with the resets before it. After
   * the fence it deletes the one generation it retired, and retries any of
   * the RETRY_PROBES most recent ones whose cleanup failed. Before publishing,
   * it sweeps at most MAX_EXPIRED_SWEEP generations retired more than
   * CLEANUP_GRACE_MS ago — every value, then its manifest and times — and
   * only a generation whose sweep fully succeeded is left out of the new
   * lineage. Everything else is carried with its retirement time: a
   * generation still inside its grace whose cleanup finished is not deleted
   * again, because a late write into it is unreadable behind the fence and
   * the late writer deletes it itself, or records the generation again if it
   * cannot; the sweep reclaims whatever is left once the grace has passed.
   * The live manifest is never rewritten: an entry leaves the lineage only by
   * being absent from the next epoch's manifest, which no other request
   * writes until that epoch is active.
   */
  resetAuthorization(
    operatorDisconnected = false,
    preserveClient = false,
  ): Promise<void> {
    const reset = this.performResetAuthorization(operatorDisconnected, preserveClient)
      .then(() => {});
    this.onReset?.(reset);
    return reset;
  }

  /**
   * Retire the grant a flow inspected in `inspected`, and return the epoch
   * this retirement published. The decision was made about that epoch's
   * grant, so it acts only on that epoch: if another reset has replaced it —
   * a restart that has since completed its own consent, say — the flow is
   * abandoned with nothing touched, rather than retiring a grant it never
   * looked at.
   */
  private retireGrant(inspected: string): Promise<string> {
    const published = this.performResetAuthorization(false, false, inspected);
    if (this.onReset) this.onReset(published.then(() => {}));
    return published;
  }

  /**
   * The epoch it published. With `expected`, the reset is conditional on the
   * live epoch still being that one: it is checked before anything is
   * touched, and the activation is a compare-and-set where the store offers
   * one (a recheck just before the write where it cannot).
   */
  private async performResetAuthorization(
    operatorDisconnected: boolean,
    preserveClient: boolean,
    expected?: string,
  ): Promise<string> {
    const nonce = crypto.randomUUID();
    const rawGeneration = await this.storage.get("oauth:generation");
    const previous = rawGeneration ?? LEGACY_GENERATION;
    if (expected !== undefined && previous !== expected) throw this.flowSuperseded();
    // Only an explicitly forced restart may carry a registration forward, and
    // only one this connector registered: an operator disconnect, an issuer
    // mismatch, and every unforced reset discard it. Discovery is never
    // copied: the SDK must select the authorization server again, then its
    // issuer-aware clientInformation hook checks the issuer.
    const reusableClient =
      preserveClient && !operatorDisconnected && this.clientBinding
        ? await this.carriableClient(previous)
        : undefined;
    const now = Date.now();
    const inherited = await this.cleanupBacklog(previous, now);
    const active = `${
      operatorDisconnected
        ? DISCONNECTED_GENERATION_PREFIX
        : ACTIVE_GENERATION_PREFIX
    }${nonce}`;
    const limit = concurrencyLimit(DELETE_CONCURRENCY);
    const withinGrace = (entry: RetiredGeneration) =>
      now - entry.retiredAt < CLEANUP_GRACE_MS;

    let lineage = inherited.lineage;
    const expired = lineage
      .filter((entry) => !withinGrace(entry))
      .sort((a, b) => a.retiredAt - b.retiredAt)
      .slice(0, MAX_EXPIRED_SWEEP)
      .map((entry) => entry.generation);
    if (expired.length > 0) {
      const swept = await this.cleanupGenerations(expired, limit);
      const reclaimed = new Set(
        expired.filter((_, index) => swept[index]?.status === "fulfilled"),
      );
      // The sweep widened the window between reading the live manifest and
      // publishing its successor. A stale writer's cleanup may have appended
      // to it meanwhile, so read it again and carry the union — and keep a
      // swept generation after all if that append restarted its grace.
      const latest = await this.cleanupBacklog(previous, now);
      lineage = mergeLineage(lineage, latest.lineage).filter(
        (entry) => withinGrace(entry) || !reclaimed.has(entry.generation),
      );
    }
    const retired = mergeLineage(lineage, [
      { generation: previous, retiredAt: now },
    ]);
    if (retired.length > MAX_CLEANUP_BACKLOG) {
      throw new Error(
        `OAuth cleanup backlog for "${this.connectorId}" is full`,
      );
    }
    // Publish the complete inherited cleanup work under the prospective epoch
    // before making that epoch active. A crash or later retry can therefore
    // always recover the older namespaces without a storage prefix scan.
    await this.publishLineage(active, retired);
    // This is the one authoritative transition. From this point onward every
    // old physical namespace is unreadable. There is deliberately no second
    // "finalize" write: concurrent resets therefore cannot overwrite a newer
    // reset's epoch after their cleanup finishes out of order.
    // A rejection may follow a committed fence. Keep its lineage even when
    // the answer is lost: the next reset must still find the retired grants.
    // A manifest for an epoch that never activated is harmless residue.
    if (expected === undefined) {
      await this.storage.set("oauth:generation", active);
    } else if (this.storage.compareAndSet) {
      if (!(await this.storage.compareAndSet("oauth:generation", rawGeneration, active))) {
        throw this.flowSuperseded();
      }
    } else {
      // An eventually consistent store has no atomic swap; recheck as late
      // as possible, and leave the residue an abandoned manifest is.
      if ((await this.generation()) !== expected) throw this.flowSuperseded();
      await this.storage.set("oauth:generation", active);
      if (inherited.published) {
        await this.adoptReplacedSiblings(previous, active, retired);
      }
    }
    this.refreshCoordinator?.retire(previous);

    if (reusableClient && !this.signal?.aborted) {
      // readValue opened the old physical key; the write seals the plaintext
      // under the new one. Copying ciphertext would fail its AAD check.
      this.captureGeneration(active);
      await this.storeInGeneration("oauth:client", active, () =>
        JSON.stringify({
          connectaOAuthVersion: STORED_VALUE_VERSION,
          generation: active,
          issuer: reusableClient.issuer,
          binding: reusableClient.binding,
          carried: true,
          value: reusableClient.value,
        } satisfies StoredOAuthValue<OAuthClientInformationMixed>),
      );
    }

    // Delete the generation just retired: its values, then the lineage it
    // published, which the new epoch has copied. Then retry the newest few
    // younger entries whose own cleanup failed. A generation's manifest is
    // deleted only after all of its values, so a manifest still present means
    // its cleanup did not finish (or a late writer recorded into it after it
    // did); an absent one means there is nothing to retry. That keeps the
    // 0.26.0 promise that the next reset retries a failed cleanup of the
    // grant being retired, at a bounded cost: RETRY_PROBES reads, and a full
    // cleanup only for generations that need one. Everything older waits for
    // its grace to pass (see above).
    const probed = retired
      .filter((entry) => entry.generation !== previous && withinGrace(entry))
      .sort((a, b) => b.retiredAt - a.retiredAt)
      .slice(0, RETRY_PROBES)
      .map((entry) => entry.generation);
    const probes = await Promise.allSettled(
      probed.map((generation) =>
        limit(() => this.storage.get(cleanupBacklogKey(generation))),
      ),
    );
    const unfinished = probed.filter((_, index) => {
      const probe = probes[index];
      // A probe that could not read is retried rather than assumed clean.
      return probe?.status !== "fulfilled" || probe.value !== null;
    });
    const failure = firstRejection(
      await this.cleanupGenerations([previous, ...unfinished], limit),
    );
    // Keep the active manifest immutable for the epoch's whole lifetime, even
    // after successful cleanup. A late old-epoch write can land after cleanup;
    // if its self-delete fails, the next reset must still inherit the complete
    // lineage without racing a manifest shrink/delete. The successor copies
    // this manifest before activation and then removes this retired copy.
    if (failure) throw failure.reason;
    return active;
  }

  /**
   * The registration a forced restart may copy out of `previous`, or nothing.
   *
   * It must have been registered in that epoch for this authorization server
   * (an issuer stamp) under this connector's exact configuration, redirect
   * URI, and client metadata (the binding), and it is read through this
   * owner's own storage, so another principal's partition is never a source.
   * Three registrations are never carried:
   *
   * - A URL-based client (`clientMetadataUrl`). Nothing was registered, so
   *   nothing is saved by copying it, and leaving it behind makes the SDK ask
   *   the freshly discovered metadata whether the server still accepts one.
   * - One whose `client_secret_expires_at` has passed (RFC 7591: zero means
   *   never). The token endpoint would refuse it.
   * - One a previous restart carried that has not since earned a grant. The
   *   SDK builds a consent URL locally and sends nothing that could answer
   *   `invalid_client`, and RFC 6749 section 4.1.2.1 forbids an authorization
   *   server from redirecting a client it does not recognize, so a forgotten
   *   registration never reaches the callback. Tokens in the epoch are the
   *   only proof the server still knows the client. Without them the second
   *   restart registers again, which bounds a forgotten registration to one
   *   refused consent rather than a restart loop only a disconnect escapes.
   */
  private async carriableClient(
    previous: string,
  ): Promise<
    | (OAuthValueRead<OAuthClientInformationMixed> & { issuer: string; binding: string })
    | undefined
  > {
    const prior = await this.readValue("oauth:client", (raw) => {
      try {
        return JSON.parse(raw) as OAuthClientInformationMixed;
      } catch {
        return {} as OAuthClientInformationMixed;
      }
    });
    const clientId: unknown = prior?.value?.client_id;
    const expiresAt: unknown = prior?.value?.client_secret_expires_at;
    if (
      prior?.generation !== previous ||
      prior.issuer === undefined ||
      prior.binding === undefined ||
      prior.binding !== this.clientBinding ||
      typeof clientId !== "string" ||
      clientId === this.clientMetadataUrl ||
      (typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1000 <= Date.now())
    ) {
      return undefined;
    }
    const carriable = { ...prior, issuer: prior.issuer, binding: prior.binding };
    if (!prior.carried) return carriable;
    const earnedGrant =
      (await this.storage.get(oauthValueStorageKey("oauth:tokens", previous))) !== null;
    return earnedGrant ? carriable : undefined;
  }

  /**
   * Delete one credential the SDK asked to invalidate.
   *
   * Outside a verified callback this is the plain delete it always was. Inside
   * one, the SDK is invalidating after the token endpoint refused a code, and
   * the credential in storage may no longer be the one the exchange began
   * with: a duplicate callback that won its claim, or a refresh, can have
   * written a grant meanwhile, and a refused code says nothing about that
   * grant. So the delete is conditional on the raw value the exchange began
   * with (or wrote itself), and an exchange that began with nothing deletes
   * nothing. With `compareAndSet` that condition is atomic. Without it, a
   * client is re-read and deleted only while unchanged, which leaves one
   * round trip in which a new registration could be lost; tokens are kept
   * outright, because the duplicate callback that could write a grant inside
   * that round trip is exactly the case this exists for. A token set left
   * behind is refreshed or refused on its next use, as any other.
   */
  private async invalidateCredential(
    key: "oauth:client" | "oauth:tokens",
    generation: string,
  ): Promise<void> {
    const physicalKey = oauthValueStorageKey(key, generation);
    const basis = this.callback?.basis;
    if (basis === undefined || generation !== this.capturedGeneration) {
      await this.storage.delete(physicalKey);
      return;
    }
    const began = key === "oauth:client" ? basis.client : basis.tokens;
    if (began === null) return;
    if (this.storage.compareAndSet) {
      await this.storage.compareAndSet(physicalKey, began, null);
    } else if (key === "oauth:client" && (await this.storage.get(physicalKey)) === began) {
      await this.storage.delete(physicalKey);
    }
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const endsRefresh = scope === "all" || scope === "tokens";
    try {
      const generation = await this.writeGeneration();
      if (scope === "all") {
        const failure = firstRejection(await Promise.allSettled([
          this.invalidateCredential("oauth:client", generation),
          this.invalidateCredential("oauth:tokens", generation),
          this.deleteAll([
            oauthValueStorageKey("oauth:verifier", generation),
            oauthValueStorageKey("oauth:discovery", generation),
          ]),
        ]));
        if (failure) throw failure.reason;
      } else if (scope === "client") {
        await this.invalidateCredential("oauth:client", generation);
      } else if (scope === "tokens") {
        await this.invalidateCredential("oauth:tokens", generation);
      } else if (scope === "verifier") {
        await this.storage.delete(
          oauthValueStorageKey("oauth:verifier", generation),
        );
      } else if (scope === "discovery") {
        await this.storage.delete(
          oauthValueStorageKey("oauth:discovery", generation),
        );
      }
      if (endsRefresh) {
        this.failRefreshFlight(
          new Error(
            "OAuth refresh invalidated credentials before tokens were saved.",
          ),
        );
      }
    } catch (error) {
      if (endsRefresh) this.failRefreshFlight(error);
      throw error;
    }
    // The SDK invalidates after a refused refresh and then starts over, which
    // on `invalid_client` means registering a new client. A passive request
    // must not begin authorization, so it ends here, as auth_required.
    if (!this.allowAuthorization && this.refreshFailure?.kind === "dead") {
      throw this.authorizationRefused();
    }
  }
}
