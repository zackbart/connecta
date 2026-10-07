import type { ServerOptions } from "./routes/shared.js";

const HANDOFF_TTL_MS = 15 * 60_000;
const INTERACTIVE_OAUTH_REQUIRED = "An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.";

interface Handoff {
  connector: string;
  owner: string;
  principal: string;
  origin: string;
  expiresAt: number;
  nonce: string;
  force: boolean;
}

export function oauthConnectUnavailable(opts: Pick<ServerOptions, "auth" | "credentialVault">): string | undefined {
  if (!opts.auth.some(provider => provider.interactiveOperator &&
    (provider.uiAuth?.kind === "clerk" || provider.uiAuth?.kind === "cloudflare-access"))) {
    return INTERACTIVE_OAUTH_REQUIRED;
  }
  if (!opts.credentialVault?.signOAuthHandoff || !opts.credentialVault.verifyOAuthHandoff) {
    return "Connecting OAuth connectors requires a credential vault with a handoff signing key. Configure encryptedCredentialVault(storage, key).";
  }
  return undefined;
}

export async function oauthConnectUrl(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  principal: string | undefined,
  force = false,
): Promise<string> {
  const unavailable = oauthConnectUnavailable(opts);
  if (unavailable) throw new Error(unavailable);
  const connector = opts.registry.getConnector(connectorId);
  if (!connector || !principal) throw new Error("OAuth connection requires an initiating user identity.");
  const handoff: Handoff = {
    connector: connectorId,
    owner: connector.authScope === "personal" ? principal : "shared",
    principal,
    origin: new URL(baseUrl).origin,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
    nonce: crypto.randomUUID(),
    force,
  };
  const payload = btoa(JSON.stringify(handoff));
  const signature = await opts.credentialVault!.signOAuthHandoff!(payload);
  const url = new URL(`/connect/${connectorId}`, baseUrl);
  url.searchParams.set("h", `${payload}.${signature}`);
  return url.toString();
}

export async function verifyOAuthHandoff(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  token: string | null,
): Promise<Handoff | null> {
  if (!token || token.length > 4096) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length) return null;
  try {
    if (!await opts.credentialVault?.verifyOAuthHandoff?.(payload, signature)) return null;
    const h: Handoff = JSON.parse(atob(payload));
    const connector = opts.registry.getConnector(connectorId);
    if (!connector || h.connector !== connectorId || typeof h.principal !== "string" || !h.principal ||
      h.owner !== (connector.authScope === "personal" ? h.principal : "shared") ||
      h.origin !== new URL(baseUrl).origin || !Number.isSafeInteger(h.expiresAt) ||
      h.expiresAt <= Date.now() || h.expiresAt > Date.now() + HANDOFF_TTL_MS ||
      typeof h.nonce !== "string" || !h.nonce || typeof h.force !== "boolean") return null;
    return h;
  } catch {
    return null;
  }
}
