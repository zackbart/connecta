import type { ServerOptions } from "./routes/shared.js";
import { oauthConnectKeys } from "./storage/keys.js";

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

export function oauthConnectUnavailable(opts: Pick<ServerOptions, "config">): string | undefined {
  if (!opts.config.auth.some(provider => provider.interactiveOperator &&
    (provider.uiAuth?.kind === "clerk" || provider.uiAuth?.kind === "cloudflare-access"))) {
    return INTERACTIVE_OAUTH_REQUIRED;
  }
  if (!opts.config.vault?.signOAuthHandoff || !opts.config.vault.verifyOAuthHandoff) {
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
  opaque = false,
): Promise<string> {
  return (await oauthConnectLink(opts, baseUrl, connectorId, principal, force, opaque)).url;
}

export async function oauthConnectLink(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  principal: string | undefined,
  force = false,
  opaque = false,
): Promise<{ url: string; nonce: string }> {
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
  const vault = opts.config.vault!;
  if (opaque && (!vault.seal || !vault.open)) throw new Error("URL elicitation requires a sealing credential vault.");
  const payload = opaque
    ? `v2:${btoa(await vault.seal!(connectorId, "connecta:connect-link:v2", JSON.stringify(handoff)))}`
    : btoa(JSON.stringify(handoff));
  const signature = await opts.config.vault!.signOAuthHandoff!(payload);
  const url = new URL(`/connect/${connectorId}`, baseUrl);
  url.searchParams.set("h", `${payload}.${signature}`);
  return { url: url.toString(), nonce: handoff.nonce };
}

/** A claim precedes OAuth reset; only a completed start can prove recovery. */
export async function oauthConnectLinkProgress(opts: ServerOptions, baseUrl: string, id: string, nonce: string): Promise<"claimed" | "started" | undefined> {
  const stage = await opts.registry.contextFor(id, baseUrl).storage.get(oauthConnectKeys.used(nonce));
  return stage === "used" ? "claimed" : stage === "started" ? "started" : undefined;
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
    if (!await opts.config.vault?.verifyOAuthHandoff?.(payload, signature)) return null;
    const h: Handoff = JSON.parse(payload.startsWith("v2:")
      ? await opts.config.vault!.open!(connectorId, "connecta:connect-link:v2", atob(payload.slice(3)))
      : atob(payload));
    const connector = opts.registry.getConnector(connectorId);
    if (!connector || h.connector !== connectorId || typeof h.principal !== "string" || !h.principal ||
      h.owner !== (connector.authScope === "personal" ? h.principal : "shared") ||
      h.origin !== new URL(baseUrl).origin || !Number.isSafeInteger(h.expiresAt) ||
      h.expiresAt <= Date.now() || h.expiresAt > Date.now() + HANDOFF_TTL_MS ||
      typeof h.nonce !== "string" || !h.nonce || typeof h.force !== "boolean") return null;
    if (await opts.registry.contextFor(connectorId, baseUrl).storage.get(oauthConnectKeys.used(h.nonce))) return null;
    return h;
  } catch {
    return null;
  }
}

/** Claim only after browser identity and permissions pass, before starting OAuth. */
export async function consumeOAuthConnectLink(opts: ServerOptions, handoff: Handoff): Promise<boolean> {
  if (handoff.expiresAt <= Date.now()) return false;
  const storage = opts.registry.contextFor(handoff.connector, handoff.origin).storage;
  const expiry = { ttlSeconds: Math.max(1, Math.ceil((handoff.expiresAt - Date.now()) / 1000)) };
  return storage.compareAndSet(oauthConnectKeys.used(handoff.nonce), null, "used", expiry);
}

/** Mark only after the start, reset, and consent binding have finished. */
export async function completeOAuthConnectStart(opts: ServerOptions, handoff: Handoff): Promise<boolean> {
  if (handoff.expiresAt <= Date.now()) return false;
  const storage = opts.registry.contextFor(handoff.connector, handoff.origin).storage;
  const expiry = { ttlSeconds: Math.max(1, Math.ceil((handoff.expiresAt - Date.now()) / 1000)) };
  return storage.compareAndSet(oauthConnectKeys.used(handoff.nonce), "used", "started", expiry);
}
