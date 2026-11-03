// Node-only: owned undici dispatcher and Node stream adapters, reached via /node.
import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { learnedDestination, type LearnedRequestInit } from "../guarded-transport.js";
import { learnedUrlRefusal } from "../url-safety.js";
import { OAuthRequestNotSentError } from "../auth/oauth-request-not-sent.js";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Client, ProxyAgent, type Dispatcher, type buildConnector } from "undici";
import { ConnectorCallError } from "../errors.js";
import type { GuardedTransport } from "../guarded-transport.js";

/** Each lookup owns its DNS channels; cancellation closes them before returning. */
async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly LookupAddress[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    for (const result of results) {
      if (result.status === "rejected" && !["ENODATA", "ENOTFOUND"].includes(result.reason?.code)) throw result.reason;
    }
    return results.flatMap((result, index) =>
      result.status === "fulfilled" ? result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })) : [],
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    resolver.cancel();
  }
}

/** Observe even a misbehaving injected resolver, without holding the request open. */
async function boundedLookup(
  lookup: (hostname: string, signal: AbortSignal) => Promise<readonly LookupAddress[]>,
  hostname: string,
  requestSignal?: AbortSignal | null,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal?.reason);
  const timer = setTimeout(() => controller.abort(new Error("DNS resolution timed out.")), 10_000);
  requestSignal?.addEventListener("abort", abort, { once: true });
  let onAbort: (() => void) | undefined;
  let resolution: Promise<readonly LookupAddress[]> | undefined;
  try {
    if (requestSignal?.aborted) abort();
    controller.signal.throwIfAborted();
    resolution = lookup(hostname, controller.signal);
    return await Promise.race([
      resolution,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    // Drain the owned resolver after cancelling its channels (INV-7). Test
    // injections may ignore cancellation, but cannot hold send() open.
    if (lookup === resolveAddresses) await resolution?.catch(() => {});
  }
}

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
export function createNodeGuardedTransport(
  proxy?: string,
  lookup: (hostname: string, signal: AbortSignal) => Promise<readonly LookupAddress[]> = resolveAddresses,
): GuardedTransport {
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
      const configured = (init as LearnedRequestInit)[learnedDestination];
      let pinned: LookupAddress | undefined;
      if (configured && url.origin !== configured.origin) {
        const refuse = () =>
          new OAuthRequestNotSentError(
            "connector_call_failed",
            "The learned URL resolved to an unsafe destination; nothing was sent.",
            { retryable: false },
          );
        if (learnedUrlRefusal(configured, url)) throw refuse();
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        let addresses: readonly LookupAddress[];
        try {
          addresses = isIP(hostname)
            ? [{ address: hostname, family: isIP(hostname) }]
            : await boundedLookup(lookup, hostname, init.signal);
        } catch {
          init.signal?.throwIfAborted();
          throw refuse();
        }
        init.signal?.throwIfAborted();
        if (
          addresses.length === 0 ||
          addresses.some(({ address, family }) => {
            if (!isIP(address) || isIP(address) !== family) return true;
            const resolved = new URL(url);
            resolved.hostname = family === 6 ? `[${address}]` : address;
            return learnedUrlRefusal(configured, resolved) !== undefined;
          })
        )
          throw refuse();
        pinned = addresses[0];
      }
      const destination = new URL(url);
      if (pinned && proxyUri) destination.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
      const framed = new Request(url, init);
      if (pinned) framed.headers.set("host", url.host);
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
            ...(pinned ? { requestTls: { servername: isIP(url.hostname) ? "" : url.hostname } } : {}),
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
                    { ...parameters, ...(name ? { servername: isIP(name.replace(/^\[|\]$/g, "")) ? "" : name } : {}) },
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
        : new Client(url.origin, {
            ...clientOptions,
            ...(pinned
              ? {
                  connect: {
                    // No second resolver can replace the checked address. The Client
                    // retains the URL hostname for SNI and certificate verification.
                    lookup: (_hostname, _options, callback) => callback(null, pinned!.address, pinned!.family),
                    autoSelectFamily: false,
                  },
                }
              : {}),
          });
      const destroy = () => Promise.allSettled([tunnelClient?.destroy(), client.destroy()]);
      const abort = () => {
        void destroy();
      };
      framed.signal.addEventListener("abort", abort, { once: true });
      try {
        framed.signal.throwIfAborted();
        if (!proxyUri) dispatch();
        const answer = await client.request({
          origin: destination.origin,
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
