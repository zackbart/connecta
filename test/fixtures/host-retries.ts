// Node-only fixture: hostile buffering global dispatcher, independent of owned senders.
import { Agent, RetryAgent, fetch as dispatcherFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { onTestFinished, vi } from "vitest";

/** A host interceptor makes fetch's streamed JSON body replayable by RetryAgent. */
export function installHostRetries() {
  const previous = getGlobalDispatcher();
  const retry = new RetryAgent(new Agent(), {
    methods: ["POST"],
    statusCodes: [503],
    maxRetries: 1,
    minTimeout: 1,
    maxTimeout: 1,
  });
  setGlobalDispatcher(
    retry.compose((dispatch) => (options, handler) => {
      void (async () => {
        const chunks: Buffer[] = [];
        if (options.body)
          for await (const chunk of options.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        dispatch({ ...options, body: Buffer.concat(chunks) }, handler);
      })().catch((error: Error) => handler.onError?.(error));
      return true;
    }),
  );
  // Node 26's bundled undici uses dispatcher protocol v2. Exercise the pinned
  // v1 fetch there; on supported Node 22 this uses native fetch unchanged.
  if (Number(process.versions.undici?.split(".")[0]) >= 8) vi.stubGlobal("fetch", dispatcherFetch);
  onTestFinished(async () => {
    vi.unstubAllGlobals();
    setGlobalDispatcher(previous);
    await retry.close();
  });
}

