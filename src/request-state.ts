import { ProtocolError, INVALID_PARAMS } from "@modelcontextprotocol/server";

export const REQUEST_STATE_TTL_MS = 10 * 60_000;
export const MAX_INPUT_ROUNDS = 3;

export function stateObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function invalidRequestState(): never {
  throw new ProtocolError(INVALID_PARAMS, "Invalid or expired requestState", { reason: "invalid_request_state" });
}

/** Object order is immaterial; array order and every submitted value are bound. */
export function canonicalState(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => stateObject(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export async function requestDigest(tool: string, args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalState({ tool, args }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
