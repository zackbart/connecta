import { createClerkClient as createIsolatedClerkClient } from "./clerk-sdk/client.js";
import type { ClerkClientOptions, ClerkSdkClient } from "./clerk-sdk/client.js";
import { byteReadResponse } from "../byte-read-response.js";
import { failureRecord, logFailure } from "../operator-record.js";

// Bound even an SDK path that ignores a body (204/errors), or reads a clone.
// Only buffered bytes reach the SDK; no upstream body escapes this transport.
const MAX_SDK_RESPONSE_BYTES = 1_048_576;

async function sdkFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  owner?: AbortSignal,
): Promise<Response> {
  const ended = new AbortController();
  const signal = AbortSignal.any([
    ended.signal,
    ...(owner ? [owner] : []),
    ...(init?.signal ? [init.signal] : []),
    ...(input instanceof Request ? [input.signal] : []),
  ]);
  const timer = setTimeout(() => ended.abort(new Error("Clerk SDK request timed out")), 10_000);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    response = await fetch(input, { ...init, signal });
    reader = response.body?.getReader();
    void reader?.closed.catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SDK_RESPONSE_BYTES) throw new Error("Clerk SDK response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return byteReadResponse(new Response(response.body ? bytes : null, response));
  } finally {
    clearTimeout(timer);
    ended.abort();
    signal.removeEventListener("abort", cancel);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await response?.body?.cancel().catch(() => {});
  }
}

/** All SDK network paths, including fresh opaque-verification clients. */
export function createByteReadingClerkClient(
  options: ClerkClientOptions,
  signal?: AbortSignal,
  pending?: Set<Promise<unknown>>,
): ClerkSdkClient {
  const client = createIsolatedClerkClient({
    ...options,
    telemetry: { disabled: true },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const operation = sdkFetch(input, init, signal);
      pending?.add(operation);
      void operation.finally(() => pending?.delete(operation)).catch(() => {});
      return operation;
    },
  });
  // The upstream disabled flag does not cover recordLog or debug output.
  client.telemetry.record = () => {};
  client.telemetry.recordLog = () => {};
  return client;
}

/** The generated SDK never forwards its diagnostic text to a console. */
export function clerkSdkFailure(failure?: unknown): void {
  logFailure(console, "Clerk authentication failed", failureRecord({}, failure));
}
