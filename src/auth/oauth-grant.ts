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
  discovery?: OAuthDiscoveryState;
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
