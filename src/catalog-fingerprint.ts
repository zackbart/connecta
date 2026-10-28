import { bytesToHex } from "./bytes.js";

const encoder = new TextEncoder();

async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  const hex = bytesToHex(digest);
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
