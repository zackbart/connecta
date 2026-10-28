import { sha256Hex } from "./bytes.js";
import type { IdentityReference } from "./types.js";

const IDENTITY_PART_RE = /^[\x21-\x7e]{1,256}$/;

export function validIdentityReference(value: IdentityReference | undefined): value is IdentityReference {
  return Boolean(
    value &&
    typeof value.namespace === "string" &&
    typeof value.id === "string" &&
    IDENTITY_PART_RE.test(value.namespace) &&
    IDENTITY_PART_RE.test(value.id),
  );
}

/** Deterministic pseudonymous partition; raw emails and ids do not enter keys. */
export async function identityStorageKey(identity: IdentityReference): Promise<string> {
  return sha256Hex(`${identity.namespace}\n${identity.id}`);
}
