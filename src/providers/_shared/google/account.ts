// Which Google account an OAuth-mode consent signed into (#1381), for core's
// account check (`oauth.account`, src/oauth-account.ts).
//
// The source is the OpenID Connect ID token in Google's own token response,
// verified as Google documents: an RS256 signature by a key from Google's
// published JWKS, issuer `accounts.google.com`, this OAuth client as the
// audience, and a current lifetime. OIDC would let a client that received it
// directly from the token endpoint over TLS skip the signature; checking it
// anyway costs one cached key read and refuses a token no one at Google signed,
// whatever path delivered it. The ID token is bound to this client by `aud`,
// which an access token is not, and reading it sends no credential anywhere.
//
// Only a verified address counts (`email_verified`), and only Google's `hd`
// claim attests a Workspace domain: a consumer account may carry a verified
// address at any domain, so a domain rule never matches on the address alone.

import { decodeJwt, jwksKeys, rs256Header, validJwtTime, verifyRs256 } from "../../../auth/rs256-jwt.js";
import type { OAuthAccount, OAuthExchangedTokens } from "../../../oauth-account.js";

/** Google's published OAuth 2.0 / OpenID Connect signing keys. */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** The two issuer spellings Google documents for its ID tokens. */
const GOOGLE_ISSUERS: ReadonlySet<unknown> = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** The scopes the account check adds to a product's own; nothing else widens. */
export const GOOGLE_ACCOUNT_SCOPES = ["openid", "email"] as const;

/** One bounded key cache for every Google connection in this runtime. */
let googleKeys: ReturnType<typeof jwksKeys> | undefined;

/** Whether the token names this client as its audience, and only party authorized. */
function audienceIs(claims: Record<string, unknown>, clientId: string): boolean {
  const { aud, azp } = claims;
  if (aud === clientId) return azp === undefined || azp === clientId;
  return Array.isArray(aud) && aud.includes(clientId) && azp === clientId;
}

/**
 * `identify` for a Google OAuth client: the account the ID token in this code
 * exchange's token response verifiably names. Throws, naming no claim value,
 * when there is no such token or any check fails.
 */
export function googleAccountIdentity(
  clientId: string,
): (tokens: OAuthExchangedTokens, init: { signal: AbortSignal }) => Promise<OAuthAccount> {
  return async ({ idToken }, { signal }) => {
    if (!idToken) throw new Error("Google's token response carried no ID token; openid and email were not granted.");
    const jwt = decodeJwt(idToken);
    if (!jwt || !rs256Header(jwt.header)) throw new Error("Google's ID token is not an RS256-signed JWT.");
    const key = await (googleKeys ??= jwksKeys(GOOGLE_JWKS_URL))(jwt.header.kid, signal);
    if (!key || !(await verifyRs256(jwt, key, signal))) {
      throw new Error("Google's ID token is not signed by a published Google key.");
    }
    const claims = jwt.claims;
    if (!GOOGLE_ISSUERS.has(claims.iss) || !audienceIs(claims, clientId) || !validJwtTime(claims)) {
      throw new Error("Google's ID token names another issuer or audience, or is not current.");
    }
    if (typeof claims.email !== "string" || claims.email_verified !== true) {
      throw new Error("Google's ID token carries no verified email address.");
    }
    return {
      address: claims.email,
      ...(typeof claims.hd === "string" && claims.hd !== "" ? { domain: claims.hd } : {}),
    };
  };
}
