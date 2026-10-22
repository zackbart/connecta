// Node-only: owned undici dispatcher and Node stream adapters, reached via /node.
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Client } from "undici";
import type { GuardedTransport } from "../guarded-transport.js";

/**
 * One Client per send, no shared/global dispatcher or interceptor. request()
 * avoids fetch's 421 retry; HTTP/1.1 and non-idempotent dispatch disable the
 * HTTP/2 REFUSED_STREAM and pipeline recovery paths, for every method.
 * The response/abort owns the client until the body ends or is cancelled.
 */
export const nodeGuardedTransport: GuardedTransport = {
  async send(url, init) {
    const framed = new Request(url, init);
    const client = new Client(url.origin, {
      allowH2: false,
      pipelining: 0,
      interceptors: { Client: [] },
    });
    try {
      const answer = await client.request({
        path: `${url.pathname}${url.search}`,
        method: framed.method as Parameters<Client["request"]>[0]["method"],
        headers: Object.fromEntries(framed.headers),
        body: framed.body ? Readable.fromWeb(framed.body as Parameters<typeof Readable.fromWeb>[0]) : null,
        signal: framed.signal,
        idempotent: false,
        maxRedirections: 0,
      });
      const headers = new Headers();
      for (const [name, values] of Object.entries(answer.headers)) {
        for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) {
          headers.append(name, value);
        }
      }
      const raw = answer.body;
      const close = () => void client.destroy().catch(() => {});
      raw.once("close", close);
      if (framed.method === "HEAD" || [204, 205, 304].includes(answer.statusCode)) {
        raw.destroy();
        return new Response(null, { status: answer.statusCode, headers });
      }
      let body: Readable = raw;
      // Native fetch decodes content encodings before exposing response bytes.
      // Bound the number of decoders; an unsupported chain fails closed.
      const encodings = (headers.get("content-encoding") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const unreadable = () => {
        raw.destroy();
        // Preserve the physical status (notably a write's 401) even when
        // the content encoding cannot be read. A body failure is not a lost reply.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("Unsupported response content encoding."));
            },
          }),
          { status: answer.statusCode, headers },
        );
      };
      if (encodings.length > 5) return unreadable();
      for (const encoding of encodings.reverse()) {
        if (encoding === "identity") continue;
        const decode =
          encoding === "gzip" || encoding === "x-gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : undefined;
        if (!decode) return unreadable();
        const previous = body;
        previous.once("error", (error) => decode.destroy(error));
        decode.once("close", () => previous.destroy());
        body = previous.pipe(decode);
      }
      return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: answer.statusCode, headers });
    } catch (error) {
      await client.destroy().catch(() => {});
      throw error;
    }
  },
};
