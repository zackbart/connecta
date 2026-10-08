import type { OAuthTokens } from "@modelcontextprotocol/client";
import { retryAfterMs } from "../connectors/guarded-fetch.js";

// The token endpoint's answers as downstream OAuth classifies them and the SDK
// gets to parse them: a refresh's dead-or-outage verdict, and every failure
// rebuilt from its OAuth `error` code alone, so nothing else a token endpoint
// wrote reaches the SDK's console output (#695).

/** The `grant_type` of a token request, or undefined for any other request. */
export function tokenGrantType(init: RequestInit | undefined): string | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return undefined;
  const body = init?.body;
  if (body instanceof URLSearchParams) return body.get("grant_type") ?? undefined;
  if (typeof body !== "string") return undefined;
  return new URLSearchParams(body).get("grant_type") ?? undefined;
}

export function isRefreshTokenRequest(init: RequestInit | undefined): boolean {
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

export class OversizedRefreshResponse extends Error {
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
 *
 * `unstored`: the server answered with a rotation storage would not keep.
 */
export type RefreshFailure =
  | { kind: "dead" }
  | {
      kind: "transient";
      /** Completes "the authorization server …" in the agent-facing message. */
      reason: string;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    }
  /** A valid rotation storage refused to keep: retryable, grant untouched. */
  | { kind: "unstored" };

export type TransientRefreshFailure = Extract<RefreshFailure, { kind: "transient" }>;

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

export function transientFailure(
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
export async function sdkSafeTokenResponse(response: Response): Promise<Response> {
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

export type RefreshResponseOutcome =
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
 * the coordinator stores it before releasing anyone, rather than trusting the
 * SDK's later `saveTokens` to arrive on a request that may already be cancelled.
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
export async function refreshResponseOutcome(
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
