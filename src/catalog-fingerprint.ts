import type { ToolDef } from "./types.js";

const encoder = new TextEncoder();

export interface CatalogSnapshot {
  tools: ToolDef[];
  /** SHA-256 over the exact serialized tool array, prefixed with its size. */
  fingerprint: string;
  /** UTF-8 form reused by hashing, size enforcement, and chunking. */
  serializedBytes: Uint8Array;
}

async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${bytes.byteLength}:${hex}`;
}

/** Fingerprint an already serialized catalog without parsing/reserializing it. */
export async function fingerprintSerializedCatalog(
  serializedTools: string,
): Promise<{ fingerprint: string; byteLength: number }> {
  const bytes = encoder.encode(serializedTools);
  return {
    fingerprint: await fingerprintBytes(bytes),
    byteLength: bytes.byteLength,
  };
}

/**
 * Capture every persisted/discovered field in one deterministic snapshot.
 * Object key order is allowed to cause a conservative extra write; changing
 * any serialized field must change the digest.
 */
export async function snapshotCatalog(
  tools: ToolDef[],
): Promise<CatalogSnapshot> {
  const serializedTools = JSON.stringify(tools);
  if (serializedTools === undefined) {
    throw new TypeError("Tool catalog is not JSON-serializable.");
  }
  const bytes = encoder.encode(serializedTools);
  return {
    tools,
    fingerprint: await fingerprintBytes(bytes),
    serializedBytes: bytes,
  };
}
