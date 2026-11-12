// Downstream response bodies, bounded as they stream: nothing past a bound
// is read, so no answer is ever buffered whole before it is measured.

/** An HTTP error or 202 body is only ever quoted or discarded: keep this much. */
const UNPARSED_BYTES = 65_536;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BodyBound {
  limit: number;
  /** The JSON-RPC request an event stream answers, when known. */
  rpcId?: string | number | undefined;
  exceeded: () => Error;
  /** Each SSE event id the stream carries, for a resumption to find its call. */
  onEventId?: ((id: string) => void) | undefined;
}

/**
 * Bound one MCP transport response, whatever its status.
 *
 * An HTTP error or 202 keeps its status, so authentication recovery and write
 * outcomes are unchanged, and its body ends after its first 64 KiB. A JSON
 * body past `limit`, declared or counted, fails with `exceeded()`. An event
 * stream passes events on as they arrive and bounds each one to `limit`; past
 * it, the source is cancelled and, when `rpcId` is known, the stream ends with
 * a JSON-RPC error answering it, because the SDK settles a request only from
 * an answer, never from a broken body.
 */
export function boundedMcpBody(response: Response, bound: BodyBound): Response {
  const parsed = response.ok && response.status !== 202 && response.status !== 204;
  const sse =
    parsed && response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
  return boundBody(response, bound, parsed, sse);
}

/** Strict whole-body bound for every HTTP status and media type. */
export function boundedBody(response: Response, bound: BodyBound): Response {
  return boundBody(response, bound, true, false);
}

function boundBody(response: Response, bound: BodyBound, parsed: boolean, sse: boolean): Response {
  const source = response.body;
  if (!source) return response;
  if (parsed && !sse && Number(response.headers.get("content-length")) > bound.limit) {
    void source.cancel().catch(() => {});
    throw bound.exceeded();
  }
  const reader = source.getReader();
  void reader.closed.catch(() => {});
  // Every way out releases the source, so nothing holds its lock afterwards.
  const release = () => {
    try {
      reader.releaseLock();
    } catch {}
  };
  const stop = () => reader.cancel().then(release, release);
  // Bytes so far: of the body, or of the SSE event not yet ended by a blank line.
  let total = 0;
  // SSE scanning: at a line start, after a CR, and this line's bytes while it may be `id:`.
  let lineStart = true;
  let afterCr = false;
  let line: number[] | undefined = [];
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read().catch((error: unknown) => {
        release();
        throw error;
      });
      if (done) {
        release();
        return controller.close();
      }
      if (!parsed) {
        const keep = UNPARSED_BYTES - total;
        total += value.byteLength;
        if (value.byteLength <= keep) return controller.enqueue(value);
        controller.enqueue(value.subarray(0, keep));
        controller.close();
        return void (await stop());
      }
      if (!sse) {
        total += value.byteLength;
        if (total <= bound.limit) return controller.enqueue(value);
        void stop();
        return controller.error(bound.exceeded());
      }
      for (let index = 0; index < value.length; index++) {
        const byte = value[index]!;
        if (afterCr && byte === 10) {
          afterCr = false;
          continue;
        }
        afterCr = byte === 13;
        if (byte !== 10 && byte !== 13) {
          lineStart = false;
          if (line) line = line.length < 512 ? (line.push(byte), line) : undefined;
          if (++total > bound.limit) {
            await stop();
            const error = bound.exceeded();
            // End the partial event, then answer the request.
            const answer =
              bound.rpcId === undefined
                ? ""
                : `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: bound.rpcId, error: { code: -32603, message: error.message } })}\n\n`;
            controller.enqueue(value.subarray(0, index));
            controller.enqueue(encoder.encode(`\n\n${answer}`));
            return controller.close();
          }
          continue;
        }
        if (line?.[0] === 105 && line[1] === 100 && line[2] === 58)
          bound.onEventId?.(decoder.decode(new Uint8Array(line.slice(line[3] === 32 ? 4 : 3))));
        line = [];
        if (lineStart) total = 0;
        lineStart = true;
      }
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason).then(release, release),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
