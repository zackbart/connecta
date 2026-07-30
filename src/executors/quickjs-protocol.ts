import type { ExecuteResult } from "../types.js";
import type { QuickJsRuntimeOptions } from "./quickjs-runtime.js";

// An execution result is serialized once into payloadJson and again as that
// string is embedded in ChildToParentMessage. Captured logs therefore get a
// separate 512 KiB budget measured after both JSON encodings. The final result
// is shaped to 24k characters; even if every character takes its worst-case
// seven transport bytes, that leaves ample structural overhead below this hard
// process.send ceiling.
export const MAX_QUICKJS_IPC_BYTES = 1024 * 1024;
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

/**
 * How a host call should be named in an error a program will read. The lazy
 * connector namespaces all dispatch through one internal function, so the raw
 * provider/function pair would report every shortcut call as
 * `connecta.__callNamespace` — an internal name that appears nowhere in the
 * documented surface. Report the address the program actually called.
 */
export function hostCallLabel(payload: {
  namespace: string;
  functionName: string;
  args: unknown[];
}): string {
  if (payload.functionName === "__callNamespace") {
    const [connectorId, toolAlias] = payload.args;
    return `${String(connectorId)}.${String(toolAlias)}`;
  }
  return `${payload.namespace}.${payload.functionName}`;
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
