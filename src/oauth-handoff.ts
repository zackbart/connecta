import type { ServerOptions } from "./routes/shared.js";
import { oauthConnectKeys } from "./storage/keys.js";

const HANDOFF_TTL_MS = 15 * 60_000;
const INTERACTIVE_OAUTH_REQUIRED =
  "An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.";

interface Handoff {
  connector: string;
  owner: string;
  principal: string;
  origin: string;
  expiresAt: number;
  nonce: string;
  force: boolean;
  after?: string;
}

// Length-prefixed fields avoid JSON keys and escaping without reserving any
// character in an identity. This is an opaque wire encoding, not encryption.
function encodeHandoff(h: Handoff): string {
  return [
    h.connector,
    h.owner,
    h.principal,
    h.origin,
    h.expiresAt.toString(36),
    h.nonce,
    h.force ? "1" : "0",
    h.after ?? "",
  ]
    .map((field) => `${field.length}:${field}`)
    .join("");
}

function decodeHandoff(value: string): Handoff {
  const fields: string[] = [];
  let offset = 0;
  while (offset < value.length && fields.length < 8) {
    const colon = value.indexOf(":", offset);
    const lengthText = value.slice(offset, colon);
    if (colon < offset || !/^(0|[1-9][0-9]*)$/.test(lengthText)) throw new Error("Invalid handoff field");
    const length = Number(lengthText);
    offset = colon + 1;
    if (!Number.isSafeInteger(length) || length > value.length - offset) throw new Error("Invalid handoff length");
    fields.push(value.slice(offset, offset + length));
    offset += length;
  }
  const [connector, owner, principal, origin, expiry, nonce, force, after] = fields;
  if (fields.length !== 8 || offset !== value.length || !/^[0-9a-z]+$/.test(expiry!) || !/^[01]$/.test(force!))
    throw new Error("Invalid handoff fields");
  return {
    connector: connector!,
    owner: owner!,
    principal: principal!,
    origin: origin!,
    expiresAt: parseInt(expiry!, 36),
    nonce: nonce!,
    force: force === "1",
    ...(after ? { after } : {}),
  };
}

function encodeSegment(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid handoff encoding");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
  if (encodeSegment(decoded) !== value) throw new Error("Noncanonical handoff encoding");
  return decoded;
}

export function oauthConnectUnavailable(opts: Pick<ServerOptions, "config">): string | undefined {
  if (
    !opts.config.auth.some(
      (provider) =>
        provider.interactiveOperator &&
        (provider.uiAuth?.kind === "clerk" || provider.uiAuth?.kind === "cloudflare-access"),
    )
  ) {
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
  after?: string,
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
    ...(after ? { after } : {}),
  };
  const vault = opts.config.vault!;
  if (opaque && (!vault.seal || !vault.open)) throw new Error("URL elicitation requires a sealing credential vault.");
  const compact = encodeHandoff(handoff);
  const payload = opaque
    ? `v4.${encodeSegment(await vault.seal!(connectorId, "connecta:connect-link:v4", compact))}`
    : `v3.${encodeSegment(compact)}`;
  // Preserve the vault's entire signature and its representation, including
  // custom vaults, while keeping every URL segment unpadded base64url.
  const signature = encodeSegment(await vault.signOAuthHandoff!(payload));
  const url = new URL(`/connect/${connectorId}`, baseUrl);
  url.searchParams.set("h", `${payload}.${signature}`);
  return { url: url.toString(), nonce: handoff.nonce };
}

/** A claim precedes OAuth reset; only a completed start can prove recovery. */
export async function oauthConnectLinkProgress(
  opts: ServerOptions,
  baseUrl: string,
  id: string,
  nonce: string,
): Promise<"claimed" | "started" | "failed" | undefined> {
  const stage = await opts.registry.contextFor(id, baseUrl).storage.get(oauthConnectKeys.used(nonce));
  return stage === "used" ? "claimed" : stage === "started" || stage === "failed" ? stage : undefined;
}

/** Make outstanding flow links single-use refusals before a completion check. */
export async function closeOAuthConnectLinks(
  opts: ServerOptions,
  baseUrl: string,
  id: string,
  nonces: string[],
): Promise<void> {
  const storage = opts.registry.contextFor(id, baseUrl).storage;
  for (const nonce of nonces) {
    await storage.compareAndSet(oauthConnectKeys.used(nonce), null, "closed", { ttlSeconds: HANDOFF_TTL_MS / 1000 });
  }
}

/** Consuming a round prevents replay from creating sibling retry lineages. */
export async function claimAuthRetry(
  opts: ServerOptions,
  baseUrl: string,
  id: string,
  nonce: string,
): Promise<boolean> {
  return opts.registry
    .contextFor(id, baseUrl)
    .storage.compareAndSet(oauthConnectKeys.retry(nonce), null, "used", { ttlSeconds: HANDOFF_TTL_MS / 1000 });
}

export async function verifyOAuthHandoff(
  opts: ServerOptions,
  baseUrl: string,
  connectorId: string,
  token: string | null,
): Promise<Handoff | null> {
  if (!token || token.length > 4096) return null;
  try {
    const parts = token.split(".");
    let h: Handoff;
    if (parts.length === 3 && (parts[0] === "v3" || parts[0] === "v4")) {
      const [version, body, signature] = parts;
      const payload = `${version}.${body}`;
      if (!(await opts.config.vault?.verifyOAuthHandoff?.(payload, decodeSegment(signature!)))) return null;
      const decoded = decodeSegment(body!);
      h = decodeHandoff(
        version === "v4" ? await opts.config.vault!.open!(connectorId, "connecta:connect-link:v4", decoded) : decoded,
      );
    } else {
      // Keep pre-upgrade JSON and sealed v2 links until their original expiry.
      // Authenticate their exact original text; never normalize before verifying.
      const [payload, signature, ...rest] = parts;
      if (!payload || !signature || rest.length) return null;
      if (!(await opts.config.vault?.verifyOAuthHandoff?.(payload, signature))) return null;
      h = JSON.parse(
        payload.startsWith("v2:")
          ? await opts.config.vault!.open!(connectorId, "connecta:connect-link:v2", atob(payload.slice(3)))
          : atob(payload),
      );
    }
    const connector = opts.registry.getConnector(connectorId);
    if (
      !connector ||
      h.connector !== connectorId ||
      typeof h.principal !== "string" ||
      !h.principal ||
      h.owner !== (connector.authScope === "personal" ? h.principal : "shared") ||
      h.origin !== new URL(baseUrl).origin ||
      !Number.isSafeInteger(h.expiresAt) ||
      h.expiresAt <= Date.now() ||
      h.expiresAt > Date.now() + HANDOFF_TTL_MS ||
      typeof h.nonce !== "string" ||
      !h.nonce ||
      typeof h.force !== "boolean"
    )
      return null;
    if (
      h.after !== undefined &&
      (typeof h.after !== "string" || !/^[a-f0-9-]{36}$/.test(h.after) || h.after === h.nonce || h.force)
    )
      return null;
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
  if (handoff.after && (await storage.get(oauthConnectKeys.used(handoff.after))) !== "started") return false;
  const expiry = { ttlSeconds: Math.max(1, Math.ceil((handoff.expiresAt - Date.now()) / 1000)) };
  return storage.compareAndSet(oauthConnectKeys.used(handoff.nonce), null, "used", expiry);
}

/** Terminal marker only after the start and every tracked reset have settled. */
export async function finishOAuthConnectStart(
  opts: ServerOptions,
  handoff: Handoff,
  outcome: "started" | "failed",
): Promise<boolean> {
  if (handoff.expiresAt <= Date.now()) return false;
  const storage = opts.registry.contextFor(handoff.connector, handoff.origin).storage;
  const expiry = { ttlSeconds: Math.max(1, Math.ceil((handoff.expiresAt - Date.now()) / 1000)) };
  return storage.compareAndSet(oauthConnectKeys.used(handoff.nonce), "used", outcome, expiry);
}
