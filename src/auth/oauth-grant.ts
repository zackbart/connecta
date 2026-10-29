import type { OAuthClientInformationMixed, OAuthDiscoveryState, OAuthTokens } from "@modelcontextprotocol/client";

/** A grant body as layout 3 stores it. */
export interface OAuthGrantBody {
  issuer?: string;
  client?: {
    value: OAuthClientInformationMixed;
    binding?: string;
    carried?: true;
    registrationPath?: "cimd" | "dcr" | "static";
  };
  tokens?: OAuthTokens;
  /**
   * Epoch milliseconds the access token in `tokens` expires: its `expires_in`
   * counted from just before the request that issued it was sent, so a zero
   * lifetime expires at issuance. Written with the tokens it describes and
   * dropped with them. A grant stored before this field existed, or whose
   * server sent no `expires_in`, has none and is refreshed only after a 401.
   */
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}

/** How long before `expiresAt` a call refreshes instead of sending the token. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;

/**
 * The expiry a token response's `expires_in` gives, counted from `issuedAt`.
 * Zero is a token already expired, never a missing expiry: the next call
 * refreshes before sending it.
 */
export function tokenExpiry(tokens: OAuthTokens, issuedAt: number): number | undefined {
  const lifetime = tokens.expires_in;
  return typeof lifetime === "number" && Number.isFinite(lifetime) && lifetime >= 0
    ? issuedAt + lifetime * 1000
    : undefined;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The issuer a discovery record names, as the SDK derives it. */
export function discoveryIssuer(state: unknown): string | undefined {
  if (!plainObject(state) || typeof state.authorizationServerUrl !== "string") return undefined;
  const metadata = state.authorizationServerMetadata;
  const issuer =
    plainObject(metadata) && typeof metadata.issuer === "string" ? metadata.issuer : state.authorizationServerUrl;
  return issuer === "" ? undefined : issuer;
}
