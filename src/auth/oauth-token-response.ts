import type { OAuthTokens } from "@modelcontextprotocol/client";

// The token endpoint's answers as downstream OAuth classifies them and the SDK
// gets to parse them: a refresh's re-consent verdict, and every failure
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

class OversizedRefreshResponse extends Error {
  constructor() {
    super(`OAuth refresh response exceeded ${MAX_REFRESH_RESPONSE_BYTES} bytes.`);
  }
}

async function readRefreshResponse(response: Response, signal?: AbortSignal, clone = true): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_REFRESH_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new OversizedRefreshResponse();
  }
  const reader = (clone ? response.clone() : response).body?.getReader();
  if (!reader) return undefined;
  void reader.closed.catch(() => {});
  const cancel = () => {
    void reader.cancel().catch(() => {});
    void response.body?.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
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
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** A dispatched fingerprint has only a committed outcome or a re-consent verdict. */
export type RefreshFailure =
  | { kind: "dead" }
  /** A waiter exhausted its deadline without changing the grant. */
  | { kind: "contended" };

function oauthErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const code = (body as { error?: unknown }).error;
  return typeof code === "string" ? code : undefined;
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
 * Classify the token endpoint's answer once with a bounded read, and keep the parsed
 * tokens: a valid response has already consumed the rotating refresh token, so
 * the coordinator stores it before releasing anyone, rather than trusting the
 * SDK's later `saveTokens` to arrive on a request that may already be cancelled.
 *
 * A failure also decides what the SDK gets to parse. Pinned against
 * `@modelcontextprotocol/client` 2.3.1, `src/client/auth.ts`: `authInternal()`
 * swallows a refresh failure that is not an `OAuthError`, or is `server_error`,
 * and falls through to `startAuthorization`. All dispatched failures reach the
 * SDK as `invalid_grant`, except client refusals that also clear registration.
 * Provider hooks preserve the re-consent verdict for passive calls. Rebuilding
 * the response keeps provider text out of SDK output.
 */
export async function refreshResponseOutcome(
  response: Response,
  signal?: AbortSignal,
): Promise<RefreshResponseOutcome> {
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = await readRefreshResponse(response, signal, false);
      if (body && typeof body === "object" && ("access_token" in body || "refresh_token" in body)) {
        // A provider issuing tokens while reporting failure may have rotated.
        throw new Error("OAuth refresh failure response may contain a rotation.");
      }
      code = oauthErrorCode(body);
    } catch (error) {
      // Complete non-JSON failures still require re-consent. A lost body or
      // evidence of issued tokens cannot prove a committed outcome.
      if (!(error instanceof SyntaxError)) throw error;
    }
    const failure = new Error(`OAuth refresh failed with HTTP ${response.status}.`);
    return {
      failure,
      verdict: { kind: "dead" },
      forSdk: sdkTokenFailure(response, code === "invalid_client" || code === "unauthorized_client" ? code : "invalid_grant", 400),
    };
  }
  // A successful HTTP status may have consumed the token even when its
  // body cannot be read or parsed. The coordinator refuses the fingerprint.
  const parsed = await readRefreshResponse(response, signal, false);
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
  throw new Error("OAuth refresh response did not match the token schema.");
}
