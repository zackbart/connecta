import type { IdentityReference } from "./types.js";

const IDENTITY_PART_RE = /^[\x21-\x7e]{1,256}$/;
const encoder = new TextEncoder();

export function validIdentityReference(
  value: IdentityReference | undefined,
): value is IdentityReference {
  return Boolean(
    value &&
      IDENTITY_PART_RE.test(value.namespace) &&
      IDENTITY_PART_RE.test(value.id),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic pseudonymous partition; raw emails and ids do not enter keys. */
export async function identityStorageKey(
  identity: IdentityReference,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${identity.namespace}\n${identity.id}`),
  );
  return bytesToHex(new Uint8Array(digest));
}
