// Downstream MCP response bodies, bounded while they stream: a body past its
// bound is cancelled at the bound, never buffered whole first.

const BLOCK_BYTES = 65_536;

/**
 * Bytes retained in owned fixed-size blocks. Network chunk count and
 * backing-buffer size are untrusted, so a body is never kept as one object per
 * incoming chunk, nor as a view that pins a larger buffer.
 */
export class OwnedBlocks {
  private blocks: Uint8Array[] = [];
  private current: Uint8Array | undefined;
  private used = 0;
  /** Bytes held now. */
  bytes = 0;

  push(chunk: Uint8Array): void {
    for (let offset = 0; offset < chunk.byteLength;) {
      this.current ??= new Uint8Array(BLOCK_BYTES);
      const size = Math.min(BLOCK_BYTES - this.used, chunk.byteLength - offset);
      this.current.set(chunk.subarray(offset, offset + size), this.used);
      offset += size;
      this.used += size;
      if (this.used === BLOCK_BYTES) {
        this.blocks.push(this.current);
        this.current = undefined;
        this.used = 0;
      }
    }
    this.bytes += chunk.byteLength;
  }

  /** Every held block in order, leaving nothing held. */
  take(): Uint8Array[] {
    const blocks = this.blocks;
    if (this.current && this.used) blocks.push(this.current.subarray(0, this.used));
    this.blocks = [];
    this.current = undefined;
    this.used = 0;
    this.bytes = 0;
    return blocks;
  }
}

/** A response like `response` whose body yields `blocks`, releasing each as it is read. */
export function blocksResponse(blocks: Uint8Array[], response: Response, headers = response.headers): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const block = blocks.shift();
        if (block) controller.enqueue(block);
        else controller.close();
      },
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

/**
 * Bound a `tools/call` response body to `limit` bytes.
 *
 * Any body but an event stream is read here, before the SDK sees it: past
 * `limit` (declared or counted) it is cancelled and `exceeded()` is thrown.
 *
 * An event stream stays a stream, because the SDK acts on its progress
 * notifications and server requests as they arrive. Each complete event is
 * passed on whole; no one event may exceed `limit`. When one does, the source
 * is cancelled and the stream ends with a JSON-RPC error answering `rpcId`,
 * after `exceeded()` records the failure. The SDK settles a request only from
 * an answer, not from a broken body, so ending the stream any other way would
 * leave the call waiting for its deadline.
 */
export async function boundedToolCallResponse(
  response: Response,
  limit: number,
  rpcId: string | number,
  signal: AbortSignal | null | undefined,
  exceeded: () => Error,
): Promise<Response> {
  if (!response.body) return response;
  if (isEventStream(response)) return boundedEventStream(response, limit, rpcId, signal, exceeded);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body.cancel().catch(() => {});
    throw exceeded();
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const held = new OwnedBlocks();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (chunk.done) break;
      if (held.bytes + chunk.value.byteLength > limit) throw exceeded();
      held.push(chunk.value);
    }
    return blocksResponse(held.take(), response);
  } catch (error) {
    held.take();
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function boundedEventStream(
  response: Response,
  limit: number,
  rpcId: string | number,
  signal: AbortSignal | null | undefined,
  exceeded: () => Error,
): Response {
  const reader = response.body!.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const release = () => {
    signal?.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {}
  };
  // The bytes of the event not yet ended by a blank line.
  const event = new OwnedBlocks();
  // Whether the last byte ended a line (the stream starts at a line start),
  // and whether it was a CR whose LF, if next, belongs to the same line end.
  let lineStart = true;
  let afterCr = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            for (const block of event.take()) controller.enqueue(block);
            controller.close();
            release();
            return;
          }
          const bytes = chunk.value;
          let start = 0;
          let forwarded = false;
          for (let index = 0; index < bytes.length; index++) {
            const byte = bytes[index]!;
            if (afterCr) {
              afterCr = false;
              if (byte === 10) continue;
            }
            if (byte !== 10 && byte !== 13) {
              lineStart = false;
              continue;
            }
            afterCr = byte === 13;
            if (!lineStart) {
              lineStart = true;
              continue;
            }
            // A blank line: the event ends with this byte.
            if (event.bytes + index + 1 - start > limit) return overflow(controller);
            for (const block of event.take()) controller.enqueue(block);
            controller.enqueue(bytes.subarray(start, index + 1));
            start = index + 1;
            forwarded = true;
          }
          if (event.bytes + bytes.length - start > limit) return overflow(controller);
          event.push(bytes.subarray(start));
          if (forwarded) return;
        }
      } catch (error) {
        event.take();
        release();
        throw error;
      }
    },
    async cancel(reason) {
      event.take();
      await reader.cancel(reason).catch(() => {});
      release();
    },
  });
  const overflow = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    event.take();
    await reader.cancel().catch(() => {});
    release();
    const error = exceeded();
    const answer = JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32603, message: error.message } });
    controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${answer}\n\n`));
    controller.close();
  };
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
