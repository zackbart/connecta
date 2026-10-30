// Keyed digests of secret material that addresses stored entries.
//
// Some stored keys must tell credentials apart: a catalog or negotiation
// verdict cached under one header, token or vault credential is never served
// under another (INV-4, INV-5). A plain hash of that material would let anyone
// who reads the store, or a backup of it, check a guessed secret offline. Each
// such part goes through HMAC-SHA-256 under a key that never enters storage:
// the vault's storage digest key, derived from the deployment's credential
// key, or without one a random key held only in this process. A process key
// keeps the partitions exact; its entries are simply not found by another
// process or isolate, and expire on their own TTLs.
import type { CredentialVault } from "./credential-contract.js";
import { Context } from "effect";
import { bytesToHex } from "./bytes.js";
import { serviceFor, setViewService } from "./runtime/call.js";
import type { ConnectorContext } from "./types.js";

class StorageDigestKey extends Context.Service<StorageDigestKey, () => Promise<CryptoKey>>()(
  "connecta/operation/StorageDigestKey",
) {}

const importHmac = (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

// Drawn synchronously on first use, so concurrent first digests share one key.
let processBytes: Uint8Array | undefined;
let processKey: Promise<CryptoKey> | undefined;
const fallbackKey = () => (processKey ??= importHmac((processBytes ??= crypto.getRandomValues(new Uint8Array(32)))));

const vaultKeys = new WeakMap<CredentialVault, () => Promise<CryptoKey>>();

/** Bind the vault's storage digest key to a registry-built context, when it has one. */
export function attachStorageDigestKey(ctx: ConnectorContext, vault: CredentialVault | undefined): void {
  const derive = vault?.storageDigestKey;
  if (typeof derive !== "function") return;
  let key = vaultKeys.get(vault!);
  if (!key) {
    let pending: Promise<CryptoKey> | undefined;
    key = () => (pending ??= derive.call(vault));
    vaultKeys.set(vault!, key);
  }
  setViewService(ctx, StorageDigestKey, key);
}

/**
 * `hmac:<hex>` of a secret-bearing value, for a stored key only. Stable for one
 * deployment key, so equal inputs still address the same entry.
 */
export async function secretDigest(ctx: ConnectorContext, value: string): Promise<string> {
  const key = await (serviceFor(ctx, StorageDigestKey) ?? fallbackKey)();
  return `hmac:${bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))))}`;
}
