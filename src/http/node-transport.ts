// Node-only: owned undici dispatcher and Node stream adapters, reached via /node.
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Client, ProxyAgent, type Dispatcher, type buildConnector } from "undici";
import { ConnectorCallError } from "../errors.js";
import type { GuardedTransport } from "../guarded-transport.js";

/** Pull-based bridge: Node 22's Readable.toWeb can enqueue after Web cancellation. */
function responseBody(body: Readable, signal: AbortSignal): ReadableStream<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  let closed = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await chunks.next();
        if (closed) return;
        if (chunk.done) {
          closed = true;
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        if (closed) return;
        closed = true;
        controller.error(signal.aborted ? signal.reason : error);
      }
    },
    cancel() {
      closed = true;
      body.destroy();
      // A pending next() can still settle: it checks closed before touching
      // the canceled controller, and every iterator rejection is observed.
      void chunks.return?.().catch(() => {});
    },
  });
}

/**
 * One Client per send, no shared/global dispatcher or interceptor. request()
 * avoids fetch's 421 retry; HTTP/1.1 and non-idempotent dispatch disable the
 * HTTP/2 REFUSED_STREAM and pipeline recovery paths, for every method.
 * The response/abort owns the client until the body ends or is cancelled.
 */
export function createNodeGuardedTransport(proxy?: string): GuardedTransport {
  let proxyUri: string | undefined;
  let proxyToken: string | undefined;
  if (proxy !== undefined) {
    try {
      const url = new URL(proxy);
      if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash)
        throw new Error();
      if (url.username || url.password) {
        if (!url.username) throw new Error();
        proxyToken = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
      }
      url.username = "";
      url.password = "";
      proxyUri = url.href;
    } catch {
      // Configuration can contain passwords: never include the input or cause.
      throw new Error("proxy must be an absolute HTTP(S) proxy URL with no path, query or fragment.");
    }
  }
  return {
    delaysDispatch: true,
    async send(url, init, beforeDispatch = () => {}) {
      const framed = new Request(url, init);
      if (!framed.headers.has("user-agent")) framed.headers.set("user-agent", "connecta");
      let dispatched = false;
      const dispatch = () => {
        framed.signal.throwIfAborted();
        if (dispatched) throw new Error("A transport send cannot open a second connection.");
        beforeDispatch();
        dispatched = true;
      };
      const clientOptions = { allowH2: false, pipelining: 0, interceptors: { Client: [] } };
      let tunnelClient: Client | undefined;
      const client: Dispatcher = proxyUri
        ? new ProxyAgent({
            uri: proxyUri,
            ...(proxyToken ? { token: proxyToken } : {}),
            proxyTunnel: true,
            ...clientOptions,
            interceptors: { Agent: [], Client: [] },
            // Neither side of CONNECT uses a Pool, interceptor or global dispatcher.
            clientFactory: (origin, options) => {
              const connect = (options as { connect: buildConnector.connector }).connect;
              return (tunnelClient = new Client(origin, {
                ...options,
                ...clientOptions,
                connect: (parameters, callback) => {
                  const name = parameters.servername;
                  // ProxyAgent 6 explicitly sets SNI to the proxy hostname.
                  // Node 26 rejects IP SNI. Omit it for literal IPs; tls.connect
                  // still checks the certificate against its connection host.
                  connect(
                    { ...parameters, ...(name && isIP(name.replace(/^\[|\]$/g, "")) ? { servername: "" } : {}) },
                    callback,
                  );
                },
              }));
            },
            factory: (origin, options) => {
              const connect = (options as { connect: buildConnector.connector }).connect;
              return new Client(origin, {
                ...options,
                ...clientOptions,
                connect: (options, callback) => {
                  let settled = false;
                  connect(options, (error, socket) => {
                    // undici 6's refused HTTP CONNECT can invoke its callback twice.
                    if (settled) return;
                    settled = true;
                    if (error || !socket) {
                      // A CONNECT reset is pre-send, never a recoverable
                      // UND_ERR_SOCKET that Client may silently reconnect.
                      callback(new Error("Outbound proxy tunnel failed."), null);
                      return;
                    }
                    try {
                      dispatch();
                    } catch (error) {
                      socket.destroy();
                      callback(error as Error, null);
                      return;
                    }
                    callback(null, socket);
                  });
                },
              });
            },
          })
        : new Client(url.origin, clientOptions);
      const destroy = () => Promise.allSettled([tunnelClient?.destroy(), client.destroy()]);
      const abort = () => {
        void destroy();
      };
      framed.signal.addEventListener("abort", abort, { once: true });
      try {
        framed.signal.throwIfAborted();
        if (!proxyUri) dispatch();
        const answer = await client.request({
          origin: url.origin,
          path: `${url.pathname}${url.search}`,
          method: framed.method as Parameters<Client["request"]>[0]["method"],
          headers: Object.fromEntries(framed.headers),
          // Keep serialized SDK/provider bodies sized: undici computes their exact
          // UTF-8 Content-Length instead of using chunked transfer encoding.
          body:
            typeof init.body === "string"
              ? init.body
              : init.body instanceof URLSearchParams
                ? init.body.toString()
                : framed.body
                  ? Readable.fromWeb(framed.body as Parameters<typeof Readable.fromWeb>[0])
                  : null,
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
        // Undici emits AbortError even for a deliberate destroy() with no
        // consumer (HEAD or an unsupported encoding). Active Web/decode stream
        // listeners still receive read failures; cleanup always has an observer.
        raw.on("error", () => {});
        const close = () => {
          framed.signal.removeEventListener("abort", abort);
          void destroy();
        };
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
        return new Response(responseBody(body, framed.signal), { status: answer.statusCode, headers });
      } catch (error) {
        // ProxyAgent destroys its destination Agent before its CONNECT Client.
        // An unfinished CONNECT holds the former's connector open: cancel both
        // together so a reset/abort cannot deadlock cleanup.
        framed.signal.removeEventListener("abort", abort);
        await destroy();
        if (framed.signal.aborted) throw framed.signal.reason;
        if (proxyUri)
          throw new ConnectorCallError(
            "unavailable",
            dispatched
              ? "The proxied request did not return a confirmed response."
              : "The outbound proxy tunnel could not be established; the destination request was not sent.",
            { retryable: false },
          );
        throw error;
      }
    },
  };
}
