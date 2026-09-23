import { UnauthorizedError } from "@modelcontextprotocol/client";
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
import type { OAuthStateSealer } from "../oauth-sealing.js";
import type { KVStorage } from "../types.js";

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

const LEGACY_GENERATION = "legacy";
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
const MAX_CLEANUP_BACKLOG = 1_000;

function isRefreshTokenRequest(init: RequestInit | undefined): boolean {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token";
  }
  if (typeof body !== "string") return false;
  return new URLSearchParams(body).get("grant_type") === "refresh_token";
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

/** What the SDK sees for a refused grant it would otherwise misread. */
function refusedGrantResponse(original: Response): Response {
  void original.body?.cancel().catch(() => {});
  return Response.json(
    {
      error: "invalid_grant",
      error_description: "The authorization server refused the refresh token.",
    },
    { status: 400 },
  );
}

/** What the SDK sees for an outage whose body names a restarting code. */
function outageResponse(original: Response): Response {
  void original.body?.cancel().catch(() => {});
  const retryAfter = original.headers.get("retry-after");
  return Response.json(
    {
      error: "server_error",
      error_description: "The authorization server is temporarily unavailable.",
    },
    {
      status: original.status,
      ...(retryAfter !== null ? { headers: { "retry-after": retryAfter } } : {}),
    },
  );
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
 * `@modelcontextprotocol/client` 2.0.0, `dist/index.mjs`: `authInternal()`
 * swallows a refresh failure that is not an `OAuthError`, or is `server_error`,
 * and falls through to `startAuthorization` (`state()`, `saveCodeVerifier()`,
 * `redirectToAuthorization()`); it rethrows every other `OAuthError`, and
 * `auth()` retries once after `invalidateCredentials()` only for
 * `invalid_grant` (tokens) and `invalid_client`/`unauthorized_client` (client
 * and tokens). `executeTokenRequest()` turns a 2xx body carrying `error` into
 * an `OAuthError` with that code. So a dead grant the SDK would rethrow
 * (`bad_refresh_token`, `invalid_scope`, …) reaches it as `invalid_grant`, and
 * an outage whose body names any code but `server_error` reaches it as
 * `server_error` — a 5xx `invalid_grant` must not make the SDK drop a grant
 * nobody refused. The provider hooks below finish the job. If the SDK moves,
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
            ? response
            : refusedGrantResponse(response),
      };
    }
    return {
      failure,
      verdict: transientFailure(`answered HTTP ${response.status}`, response),
      forSdk:
        code !== undefined && code !== "server_error"
          ? outageResponse(response)
          : response,
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
      forSdk: response,
    };
  }
  if (sdkAcceptsOAuthTokens(parsed)) return { tokens: parsed as OAuthTokens };
  if (oauthErrorCode(parsed) !== undefined) {
    return {
      failure: new Error("OAuth refresh was refused by the authorization server."),
      verdict: { kind: "dead" },
      forSdk: refusedGrantResponse(response),
    };
  }
  return {
    failure: new Error("OAuth refresh response did not match the token schema."),
    verdict: transientFailure("answered without a token response", response),
    forSdk: response,
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
  done: Promise<OAuthRefreshFlightOutcome>;
  release: (outcome: OAuthRefreshFlightOutcome) => void;
  stopObservingOwnerAbort: () => void;
  mutationId: object;
  writing: boolean;
  /**
   * Set once the token endpoint answered with valid tokens: the authorization
   * server has consumed the rotating refresh token, so if the SDK's own
   * saveTokens never arrives (owner cancelled, redirected, or invalidated),
   * `fail` persists this copy itself rather than stranding the marker or
   * letting a contender redeem the retired token.
   */
  acceptedTokens?: OAuthTokens;
  persist?: (tokens: OAuthTokens) => Promise<void>;
}

function aborted(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("This operation was aborted", "AbortError")
  );
}

/** The flight's outcome, failures included; rejects only on the waiter's own abort. */
async function waitForRefreshFlight(
  flight: OAuthRefreshFlight,
  signal?: AbortSignal,
): Promise<OAuthRefreshFlightOutcome> {
  let outcome: OAuthRefreshFlightOutcome;
  if (!signal) {
    outcome = await flight.done;
  } else {
    outcome = await new Promise<OAuthRefreshFlightOutcome>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(aborted(signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      void flight.done.then((result) => finish(() => resolve(result)));
      // Abort may land between the caller's check and listener registration.
      if (signal.aborted) onAbort();
    });
  }
  return outcome;
}

/**
 * Share one rotating-token redemption within one connector runtime and OAuth
 * generation. The first request still owns the real fetch and response. Its
 * abort signal has one bounded listener until the exact flight settles, so a
 * cancellation after the response cannot strand waiters during token storage.
 * Followers wait for that provider to save tokens, then re-read storage. The
 * map never retains a token response or transport.
 *
 * This is intentionally runtime-local. KVStorage has no atomic coordination
 * operation, so a second isolate can still race the same refresh token.
 */
export class OAuthRefreshCoordinator {
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
    this.advanceStateRevision();
    flight.stopObservingOwnerAbort();
    flight.release(outcome);
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
      if (!isRefreshTokenRequest(init)) return await baseFetch(input, init);

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

        let release!: (outcome: OAuthRefreshFlightOutcome) => void;
        const flight: OAuthRefreshFlight = {
          done: new Promise<OAuthRefreshFlightOutcome>((resolve) => {
            release = resolve;
          }),
          release: (outcome) => release(outcome),
          stopObservingOwnerAbort: () => {},
          mutationId: {},
          writing: false,
          persist: (tokens) => provider.saveTokens(tokens),
        };
        this.flights.set(generation, flight);
        this.advanceStateRevision();
        provider.captureRefreshFlight(generation, flight);
        if (requestSignal) {
          let observing = true;
          const onOwnerAbort = () => {
            this.fail(generation, flight, aborted(requestSignal));
          };
          flight.stopObservingOwnerAbort = () => {
            if (!observing) return;
            observing = false;
            requestSignal.removeEventListener("abort", onOwnerAbort);
          };
          requestSignal.addEventListener("abort", onOwnerAbort, { once: true });
          // Abort may land between flight publication and listener registration.
          if (requestSignal.aborted) onOwnerAbort();
        }
        let answered = false;
        try {
          const response = await baseFetch(
            input,
            requestSignal ? { ...init, signal: requestSignal } : init,
          );
          // Failed responses never reach a successful saveTokens callback. Give
          // current waiters a bounded failure now, carrying the verdict, and
          // hand the SDK an answer it classifies the same way.
          const outcome = await refreshResponseOutcome(response);
          answered = true;
          if (outcome.failure) {
            provider.recordRefreshFailure(outcome.verdict);
            if (outcome.verdict.kind === "dead") {
              // Drop the refused grant while the flight still stands: a caller
              // arriving meanwhile joins it instead of redeeming the dead token
              // again, and no later request or isolate can replay it.
              await provider.discardRefusedGrant(
                requestedRefreshToken,
                generation,
              );
            }
            this.fail(generation, flight, outcome.failure, outcome.verdict);
            return outcome.forSdk;
          }
          // A valid response means the authorization server has consumed the
          // rotating refresh token. The SDK's saveTokens normally persists it;
          // keep this copy so `fail` can persist it instead if that callback
          // never comes (the SDK merges the old refresh token the same way).
          const rotatedRefreshToken =
            outcome.tokens.refresh_token ?? currentTokens?.refresh_token;
          flight.acceptedTokens = {
            ...outcome.tokens,
            ...(rotatedRefreshToken !== undefined
              ? { refresh_token: rotatedRefreshToken }
              : {}),
          };
          if (!this.markMutationPending(generation, flight)) {
            // Already settled (the owner was cancelled first). Still write the
            // rotation: losing it would leave a dead credential.
            void flight.persist?.(flight.acceptedTokens).catch(() => {});
            throw new Error("OAuth refresh ended before tokens could be saved.");
          }
          if (requestSignal?.aborted) {
            // Same recovery as an abort landing later: `fail` persists.
            this.fail(generation, flight, aborted(requestSignal));
            throw aborted(requestSignal);
          }
          return response;
        } catch (error) {
          // No answer at all — the network, or a body too large to be one —
          // is an outage. A refusal connecta itself raised (a redirect the
          // policy forbids) and this owner's own cancellation are not.
          const verdict =
            !answered &&
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
          this.fail(generation, flight, error, verdict);
          throw error;
        }
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
      flight.persist !== undefined &&
      this.pendingMutations.get(generation) === flight.mutationId
    ) {
      flight.writing = true;
      void flight.persist(tokens).then(
        () => {
          if (this.finishMutation(generation, flight)) {
            this.settle(generation, flight, { status: "refreshed" });
          }
        },
        (writeError: unknown) => {
          if (this.finishMutation(generation, flight)) {
            this.settle(generation, flight, { status: "failed", error: writeError });
          }
        },
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

interface StoredOAuthValue<T> {
  connectaOAuthVersion: typeof STORED_VALUE_VERSION;
  generation: string;
  issuer?: string;
  value: T;
}

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
 * OAuthClientProvider implemented over KVStorage for a single downstream
 * connector. Keys live in the connector's namespace as `oauth:<field>`.
 *
 * Headless twist: redirectToAuthorization() cannot navigate a user agent, so it
 * STORES the authorization URL; the registry surfaces it as status
 * "auth_required" and the operator opens it. The /oauth/callback/<id> route then
 * drives transport.finishAuth(code).
 */
export class KvOAuthProvider implements OAuthClientProvider {
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
  /** Tokens this request's issuer-aware auth flow decided to refresh. */
  private refreshBasis:
    | {
        accessToken: string;
        refreshToken?: string;
        generation: string;
        successIdentity?: object;
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
  ) {}

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
  ): Promise<void> {
    const generation = await this.writeGeneration();
    await this.storeInGeneration(key, generation, () => {
      const stored: StoredOAuthValue<T> = {
        connectaOAuthVersion: STORED_VALUE_VERSION,
        generation,
        ...(issuer !== undefined ? { issuer } : {}),
        value,
      };
      return isModernGeneration(generation) || issuer !== undefined
        ? JSON.stringify(stored)
        : serializeLegacy(value);
    });
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
  ): Promise<void> {
    if (
      generation.startsWith(RESETTING_GENERATION_PREFIX) ||
      generation.startsWith(DISCONNECTED_GENERATION_PREFIX) ||
      (await this.generation()) !== generation
    ) {
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
    if (expected === undefined) {
      await this.storage.set(physicalKey, serialized);
    } else if (!(await this.replaceExactly(physicalKey, expected, serialized))) {
      return;
    }
    // If reset landed after the pre-write check and completed its cleanup
    // before this set, remove the now-unreachable residue ourselves. The epoch
    // key already provides correctness; this second check is physical hygiene.
    const current = await this.generation();
    if (current !== generation) {
      try {
        await this.storage.delete(physicalKey);
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
    { value: T; generation: string; issuer?: string } | undefined
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
        stored: { value: T; generation: string; issuer?: string };
        raw: string;
        plaintextCredential: boolean;
      }
    | undefined
  > {
    const generation = await this.generation();
    const physicalKey = oauthValueStorageKey(key, generation);
    const raw = await this.storage.get(physicalKey);
    if (raw === null) return undefined;
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
  ): { value: T; generation: string; issuer?: string } | undefined {
    if (storedOAuthValue<T>(parsed)) {
      return parsed.generation === generation
        ? {
            value: parsed.value,
            generation,
            ...(parsed.issuer !== undefined ? { issuer: parsed.issuer } : {}),
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
   * Values written before issuer binding are bound on their first read with a
   * validated SDK issuer, preserving an existing grant across this upgrade.
   * A later issuer change is different: publish a new generation before
   * returning no credentials, so every isolate drops the old registration and
   * token set and the SDK starts authorization from scratch.
   */
  private async readIssuerBoundValue<T>(
    key: "oauth:client" | "oauth:tokens",
    parseLegacy: (raw: string) => T,
    serializeLegacy: (value: T) => string,
    ctx?: OAuthClientInformationContext,
  ): Promise<T | undefined> {
    const stored = await this.readValue(key, parseLegacy);
    if (!stored || !ctx) return stored?.value;
    if (stored.issuer === undefined) {
      await this.writeValue(key, stored.value, serializeLegacy, ctx.issuer);
      return stored.value;
    }
    if (stored.issuer === ctx.issuer) return stored.value;

    try {
      await this.resetAuthorization();
    } finally {
      // The issuer-aware flow may continue after the reset. Stamp any later
      // writes into the replacement epoch; the connector's generation check
      // still discards this connection attempt before caching it.
      this.captureGeneration(await this.generation());
    }
    return undefined;
  }

  /** Attempt every key deletion, then report the first backend failure. */
  private async deleteAll(keys: readonly string[]): Promise<void> {
    let firstError: unknown;
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async cleanupBacklog(generation: string): Promise<string[]> {
    const raw = await this.storage.get(cleanupBacklogKey(generation));
    if (raw === null) return [];
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
    return [...new Set(parsed)];
  }

  private async rememberRetiredGeneration(
    active: string,
    retired: string,
  ): Promise<void> {
    const backlog = await this.cleanupBacklog(active);
    if (backlog.includes(retired)) return;
    if (backlog.length >= MAX_CLEANUP_BACKLOG) {
      throw new Error(
        `OAuth cleanup backlog for "${this.connectorId}" is full`,
      );
    }
    await this.storage.set(
      cleanupBacklogKey(active),
      JSON.stringify([...backlog, retired]),
    );
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
    };
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<OAuthClientInformationMixed | undefined> {
    return this.readIssuerBoundValue(
      "oauth:client",
      (raw) => JSON.parse(raw) as OAuthClientInformationMixed,
      (value) => JSON.stringify(value),
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
      (value) => JSON.stringify(value),
      ctx,
    );
    if (ctx && tokens && refreshGeneration !== undefined) {
      this.refreshBasis = {
        accessToken: tokens.access_token,
        generation: refreshGeneration,
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
    // A retired flight (the owner was cancelled or superseded after the
    // token response) still writes: the authorization server has already
    // consumed the old refresh token, so dropping the rotated one would leave a
    // dead credential. writeValue itself refuses when the generation moved.
    // Only the coordinator bookkeeping belongs to the exact live flight.
    const owned = this.refreshFlight;
    const coordinated =
      owned !== undefined &&
      this.refreshCoordinator?.beginMutation(owned.generation, owned.flight) === true;
    try {
      await this.writeValue(
        "oauth:tokens",
        tokens,
        (value) => JSON.stringify(value),
        ctx?.issuer,
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
    const expected = await this.readValue("oauth:state", (raw) => raw);
    if (!expected || candidate === null) return false;
    const matches = timingSafeEqual(candidate, expected.value);
    if (matches) this.captureGeneration(expected.generation);
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
      await this.writeValue(
        "oauth:pending",
        authorizationUrl.toString(),
        (raw) => raw,
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
   */
  async resetAuthorization(operatorDisconnected = false): Promise<void> {
    const nonce = crypto.randomUUID();
    const previous = await this.generation();
    const inherited = await this.cleanupBacklog(previous);
    const active = `${
      operatorDisconnected
        ? DISCONNECTED_GENERATION_PREFIX
        : ACTIVE_GENERATION_PREFIX
    }${nonce}`;
    const retired = [...new Set([...inherited, previous])];
    if (retired.length > MAX_CLEANUP_BACKLOG) {
      throw new Error(
        `OAuth cleanup backlog for "${this.connectorId}" is full`,
      );
    }
    // Publish the complete inherited cleanup work under the prospective epoch
    // before making that epoch active. A crash or later retry can therefore
    // always recover the older namespaces without a storage prefix scan.
    await this.storage.set(
      cleanupBacklogKey(active),
      JSON.stringify(retired),
    );
    // This is the one authoritative transition. From this point onward every
    // old physical namespace is unreadable. There is deliberately no second
    // "finalize" write: concurrent resets therefore cannot overwrite a newer
    // reset's epoch after their cleanup finishes out of order.
    try {
      await this.storage.set("oauth:generation", active);
      this.refreshCoordinator?.retire(previous);
    } catch (error) {
      try {
        await this.storage.delete(cleanupBacklogKey(active));
      } catch {
        // Best-effort removal of a manifest for an epoch never activated.
      }
      throw error;
    }

    let firstError: unknown;
    for (const generation of retired) {
      try {
        await this.deleteAll(this.valueKeysForGeneration(generation));
        await this.storage.delete(cleanupBacklogKey(generation));
      } catch (error) {
        firstError ??= error;
      }
    }
    // Keep the active manifest immutable for the epoch's whole lifetime, even
    // after successful cleanup. A late old-epoch write can land after cleanup;
    // if its self-delete fails, the next reset must still inherit the complete
    // lineage without racing a manifest shrink/delete. The successor copies
    // this manifest before activation and then removes this retired copy.
    if (firstError) throw firstError;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const endsRefresh = scope === "all" || scope === "tokens";
    try {
      const generation = await this.writeGeneration();
      if (scope === "all") {
        await this.deleteAll([
          oauthValueStorageKey("oauth:client", generation),
          oauthValueStorageKey("oauth:tokens", generation),
          oauthValueStorageKey("oauth:verifier", generation),
          oauthValueStorageKey("oauth:discovery", generation),
        ]);
      } else if (scope === "client") {
        await this.storage.delete(
          oauthValueStorageKey("oauth:client", generation),
        );
      } else if (scope === "tokens") {
        await this.storage.delete(
          oauthValueStorageKey("oauth:tokens", generation),
        );
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
