import type { ExecuteResult } from "../types.js";
import type { QuickJsRuntimeOptions } from "./quickjs-runtime.js";

// The guest result is shaped to 24k characters before transport and QuickJS
// capture already bounds logs to 256k characters. Every complete message is
// measured against this ceiling before process.send; one MiB leaves room for
// multibyte log text and envelope escaping while remaining a hard IPC bound.
export const MAX_QUICKJS_IPC_BYTES = 1024 * 1024;
/** Preserve #84's stopgap before a host value enters the child/WASM process. */
export const MAX_QUICKJS_HOST_RPC_BYTES = 256 * 1024;

export interface RunPayload {
  id: number;
  code: string;
  providerNames: string[];
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
  | { type: "result"; jobId: number; payloadJson: string };

export interface HostCallPayload {
  namespace: string;
  functionName: string;
  args: unknown[];
}

export type HostResultPayload =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface ExecutionPayload {
  outcome: ExecuteResult;
  /**
   * Set by the runtime on wall-clock expiry. The parent recycles the child on
   * this flag, never on error text a guest can fabricate.
   */
  timedOut?: boolean;
}

export function serializedBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function stringifyBounded(
  value: unknown,
  label: string,
  limit = MAX_QUICKJS_IPC_BYTES,
): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`${label} is not JSON-serializable.`);
  }
  const bytes = serializedBytes(json);
  if (bytes > limit) {
    throw new RangeError(
      `${label} is ${bytes} UTF-8 bytes, over the ${limit}-byte IPC limit.`,
    );
  }
  return json;
}
