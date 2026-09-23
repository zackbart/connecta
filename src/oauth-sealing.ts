import type { CredentialVault } from "./credential-contract.js";
import type { ConnectorContext, Logger } from "./types.js";

/**
 * Seals one connector's downstream OAuth state for one owner. The registry
 * binds connector id and owner, so a provider only names the physical key.
 */
export interface OAuthStateSealer {
  seal(physicalKey: string, plaintext: string): Promise<string>;
  /** Rejects when the value was not sealed for this connector, owner, and key. */
  open(physicalKey: string, sealed: string): Promise<string>;
  warn(message: string): void;
}

/**
 * Contexts the registry built with a sealing vault. Internal on purpose: the
 * public ConnectorContext type does not change, and a connector cannot hand
 * itself a sealer another connector's context carries.
 */
const sealers = new WeakMap<ConnectorContext, OAuthStateSealer>();

/** A sealer over the vault, or undefined when the vault cannot seal. */
export function vaultOAuthSealer(
  vault: CredentialVault,
  connectorId: string,
  owner: string | undefined,
  logger: Logger,
): OAuthStateSealer | undefined {
  const { seal, open } = vault;
  if (typeof seal !== "function" || typeof open !== "function") return undefined;
  return {
    seal: (physicalKey, plaintext) =>
      seal.call(vault, connectorId, physicalKey, plaintext, owner),
    open: (physicalKey, sealed) =>
      open.call(vault, connectorId, physicalKey, sealed, owner),
    warn: (message) => logger.warn(message),
  };
}

export function attachOAuthSealer(
  ctx: ConnectorContext,
  sealer: OAuthStateSealer | undefined,
): ConnectorContext {
  if (sealer) sealers.set(ctx, sealer);
  return ctx;
}

export function oauthSealerFor(
  ctx: ConnectorContext,
): OAuthStateSealer | undefined {
  return sealers.get(ctx);
}

/** Carry the sealer onto a context derived by spreading another. */
export function inheritOAuthSealer(
  from: ConnectorContext,
  to: ConnectorContext,
): ConnectorContext {
  return attachOAuthSealer(to, sealers.get(from));
}
