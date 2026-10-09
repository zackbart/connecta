import type { CallErrorDetails } from "../errors.js";
import type { ExecuteResult } from "../types.js";
import type { QuickJsRuntimeOptions } from "./quickjs-runtime.js";

// Result messages remain bounded even when a full return travels in chunks.
// The host's presentation guard stashes the completed value after assembly.
export const MAX_QUICKJS_IPC_BYTES = 1024 * 1024;
/** Aggregate result transport bound, independent of per-message IPC and log caps. */
export const MAX_QUICKJS_RESULT_BYTES = 64 * 1024 * 1024;
export const QUICKJS_RESULT_CHUNK_CHARS = 65_536;
export const MAX_QUICKJS_LOG_TRANSPORT_BYTES = 512 * 1024;
/** Preserve #84's stopgap before a host value enters the child/WASM process. */
export const MAX_QUICKJS_HOST_RPC_BYTES = 256 * 1024;

export interface RunPayload {
  id: number;
  code: string;
  providers: Array<{ name: string; prelude?: string }>;
  options: QuickJsRuntimeOptions;
}

export type ParentToChildMessage =
  | { type: "run"; payloadJson: string }
  | {
      type: "host-result";
      jobId: number;
      callId: number;
      payloadJson: string;
    };

export type ChildToParentMessage =
  | { type: "ready" }
  | {
      type: "host-call";
      jobId: number;
      callId: number;
      payloadJson: string;
    }
  | { type: "log"; jobId: number; payloadJson: string }
  | { type: "result-chunk"; jobId: number; payloadJson: string }
  | { type: "result"; jobId: number; payloadJson: string };

export interface HostCallPayload {
  namespace: string;
  functionName: string;
  args: unknown[];
}

export type HostResultPayload = { ok: true; value: unknown } | { ok: false; error: string; call?: CallErrorDetails };

export interface ExecutionPayload {
  outcome: ExecuteResult;
  /**
   * Set by the runtime on wall-clock expiry. The parent recycles the child on
   * this flag, never on error text a guest can fabricate.
   */
  timedOut?: boolean;
}

export function hostCallLabel(payload: { namespace: string; functionName: string; args: unknown[] }): string {
  if (payload.namespace === "connecta" && payload.functionName === "call") {
    return String(payload.args[0]);
  }
  return `${payload.namespace}.${payload.functionName}`;
}

export function serializedBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function stringifyBounded(value: unknown, label: string, limit = MAX_QUICKJS_IPC_BYTES): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`${label} is not JSON-serializable.`);
  }
  const bytes = serializedBytes(json);
  if (bytes > limit) {
    throw new RangeError(`${label} is ${bytes} UTF-8 bytes, over the ${limit}-byte IPC limit.`);
  }
  return json;
}
