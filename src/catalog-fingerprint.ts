import type { ToolDef } from "./types.js";

const encoder = new TextEncoder();

export interface CatalogSnapshot {
  tools: ToolDef[];
  /** SHA-256 over the exact serialized tool array, prefixed with its size. */
  fingerprint: string;
  /** Reused by persistence so the full catalog is serialized only once. */
  serializedTools: string;
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
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    tools,
    fingerprint: `sha256:${bytes.byteLength}:${hex}`,
    serializedTools,
  };
}
