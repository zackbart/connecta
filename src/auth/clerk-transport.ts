import { byteReadResponse } from "../byte-read-response.js";
import { failureRecord, logFailure } from "../operator-record.js";
import { runEdge } from "../runtime/run.js";
import type { ClerkClientOptions, ClerkSdkClient } from "./clerk-sdk/client.js";
import { createClerkClient as createIsolatedClerkClient } from "./clerk-sdk/client.js";
import {
  authCatch,
  authFetch,
  authFlow,
  authInvoke,
  authMethod,
  authProgram,
  authValue,
  registerAuth,
} from "./native.js";

// Bound even an SDK path that ignores a body (204/errors), or reads a clone.
// Only buffered bytes reach the SDK; no upstream body escapes this transport.
const MAX_SDK_RESPONSE_BYTES = 1_048_576;

function sdkFetch(input: RequestInfo | URL, init: RequestInit | undefined, owner?: AbortSignal): Promise<Response> {
  return runEdge(authProgram<Response>(sdkFetchNative, [input, init, owner]));
}
const sdkFetchNative = /* @__PURE__ */ registerAuth(
  sdkFetch,
  function (input: RequestInfo | URL, init: RequestInit | undefined, owner?: AbortSignal) {
    return authFlow<Response>(function* () {
      const ended = new AbortController();
      const signal = AbortSignal.any([
        ended.signal,
        ...(owner ? [owner] : []),
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]);
      const timer = setTimeout(() => ended.abort(new Error("Clerk SDK request timed out")), 10000);
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      try {
        signal.throwIfAborted();
        response = (yield authFetch(input, { ...init, signal })) as Response;
        reader = response.body?.getReader();
        void reader?.closed.catch(() => {});
        signal.addEventListener("abort", cancel, { once: true });
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          signal.throwIfAborted();
          const { done, value } = (yield authInvoke(reader, "read", [])) as ReadableStreamReadResult<
            Uint8Array<ArrayBufferLike>
          >;
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
        (yield authCatch(authInvoke(reader, "cancel", []), () => {})) as void | undefined;
        reader?.releaseLock();
        (yield authCatch(authInvoke(response?.body, "cancel", []), () => {})) as void | undefined;
      }
    });
  },
);

/** All SDK network paths, including fresh opaque-verification clients. */
export function createByteReadingClerkClient(
  options: ClerkClientOptions,
  signal?: AbortSignal,
  pending?: Set<Promise<unknown>>,
): ClerkSdkClient {
  const client = createIsolatedClerkClient({
    ...options,
    telemetry: { disabled: true },
    fetch: authMethod((input: RequestInfo | URL, init?: RequestInit) => {
      return authFlow<Response>(function* () {
        const operation = sdkFetch(input, init, signal);
        pending?.add(operation);
        void operation.finally(() => pending?.delete(operation)).catch(() => {});
        return (yield authValue(() => operation)) as Response;
      });
    }),
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
