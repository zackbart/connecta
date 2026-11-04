import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Connecta } from "./index.js";
import { failureRecord, logFailure } from "./operator-record.js";
import { configureGuardedTransport } from "./guarded-transport.js";
import { createNodeGuardedTransport } from "./http/node-transport.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { ConfigError } from "./config-schema.js";

/** The adapter buffers before auth, bounded by the same default as the core. */
const DEFAULT_MAX_BODY_BYTES = CONFIG_DEFAULTS.admission.requests.maxBodyBytes;
/** Sixteen full default bodies; well above ordinary MCP traffic, whose bodies are small. */
const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES = 64 * 1024 * 1024;

export interface ListenOptions {
  port: number;
  /** Explicit HTTP(S) CONNECT proxy for owned outbound sends. Never read from the environment. */
  proxy?: string;
  /** Interface to bind. Defaults to Node's own (all interfaces). */
  host?: string;
  /** Pre-auth buffer cap, independent of the authenticated MCP cap. Default 4 MiB. */
  maxBodyBytes?: number;
  /**
   * Cap on the body bytes all in-flight requests hold together, counted as
   * each arrives and released when its response finishes or its client leaves.
   * Past it a request is answered 503 with `Retry-After`. Default 64 MiB, or
   * `maxBodyBytes` when larger. May not be below `maxBodyBytes`.
   */
  maxInFlightBodyBytes?: number;
  /**
   * Stop accepting connections on SIGTERM/SIGINT, let in-flight requests
   * finish, drain deferred work, then exit. Default true — Docker sends
   * SIGTERM on every `compose up` recreate and Node's default is to die
   * mid-request. Set false to install your own handlers.
   */
  gracefulShutdown?: boolean;
  /** Shutdown deadline before forcing exit. Default 10s (Docker's own grace). */
  shutdownTimeoutMs?: number;
}

const BODY_TOO_LARGE = Symbol("body-too-large");
const BODIES_AT_CAPACITY = Symbol("bodies-at-capacity");

/** A name, IPv4 or bracketed IPv6 host with an optional port, and nothing else. */
const REQUEST_HOST = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** `Host`, `X-Forwarded-Proto` or the request target is not a URL part; answered 400. */
class InvalidRequestUrl extends Error {}

/**
 * The request's URL, read from values a client chooses. Each is checked on its
 * own and the origin is parsed before the target joins it, so no value can move
 * the boundary between authority, path and query for the routes behind it.
 */
function requestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  // Origin-form only. Absolute-form and `*` have no path to route.
  const target = req.url ?? "/";
  if (!REQUEST_HOST.test(host) || typeof proto !== "string" || !/^https?$/i.test(proto) || !target.startsWith("/")) {
    throw new InvalidRequestUrl();
  }
  try {
    return `${new URL(`${proto}://${host}`).origin}${target}`;
  } catch {
    throw new InvalidRequestUrl();
  }
}

async function toRequest(
  req: IncomingMessage,
  maxBodyBytes: number,
  holdBodyBytes: (bytes: number) => boolean,
  signal: AbortSignal,
): Promise<Request | typeof BODY_TOO_LARGE | typeof BODIES_AT_CAPACITY> {
  const url = requestUrl(req);
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Stop reading as soon as the cap is passed rather than buffering the
      // rest of a body we have already decided to reject.
      if (size > maxBodyBytes) return BODY_TOO_LARGE;
      if (!holdBodyBytes((chunk as Buffer).length)) return BODIES_AT_CAPACITY;
      chunks.push(chunk as Buffer);
    }
    if (chunks.length) body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(url, {
    method,
    headers,
    body,
    signal,
    // Required by Node's fetch when sending a body stream.
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  // Stream rather than buffer: a connector-served route may return a large
  // proxied file body, and materializing it would hold the whole thing in
  // memory before the first byte reaches the client.
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

/**
 * Serve a Connecta over node:http. Thin adapter: IncomingMessage → Request,
 * Response → ServerResponse, plus the process-level concerns a long-running
 * container needs (body cap, response streaming, graceful shutdown). Outbound HTTP uses an owned undici dispatcher configured here.
 */
export function listen(connecta: Connecta, portOrOptions: number | ListenOptions): Server {
  const opts: ListenOptions = typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
  configureGuardedTransport(createNodeGuardedTransport(opts.proxy));
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxInFlightBodyBytes =
    opts.maxInFlightBodyBytes === undefined
      ? Math.max(DEFAULT_MAX_IN_FLIGHT_BODY_BYTES, maxBodyBytes)
      : opts.maxInFlightBodyBytes;
  if (!Number.isSafeInteger(maxInFlightBodyBytes) || maxInFlightBodyBytes < 1 || maxInFlightBodyBytes < maxBodyBytes) {
    throw new ConfigError("listen: maxInFlightBodyBytes must be a whole number of bytes, at least maxBodyBytes.");
  }
  let inFlightBodyBytes = 0;

  // Node has no ExecutionContext, so deferred work (activity sinks) would
  // otherwise be an untracked floating promise. Track it here and drain it on
  // shutdown so both runtimes behave the same.
  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(promise: Promise<unknown>): void {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    },
  };

  const awaitingRequest = new Set<Socket>();
  const activeResponses = new Map<Socket, number>();
  let shuttingDown = false;
  const server = createServer((req, res) => {
    // Before the body: a client's timer has been running through its upload too.
    const requestArrivedAt = Date.now();
    awaitingRequest.delete(req.socket);
    const socket = req.socket;
    activeResponses.set(socket, (activeResponses.get(socket) ?? 0) + 1);
    const finished = () => {
      res.removeListener("finish", finished);
      res.removeListener("close", finished);
      const remaining = (activeResponses.get(socket) ?? 1) - 1;
      if (remaining > 0) activeResponses.set(socket, remaining);
      else {
        activeResponses.delete(socket);
        // finish means the response was handed to the socket; destroySoon
        // flushes its queued bytes before closing, including an SSE trailer.
        // Count pipelined responses so an earlier finish cannot cut a later
        // admitted response off. Before shutdown Node's keepalive is unchanged.
        if (shuttingDown) socket.destroySoon();
      }
    };
    res.once("finish", finished);
    res.once("close", finished);
    void (async () => {
      const controller = new AbortController();
      let heldBodyBytes = 0;
      let bodyBytesReleased = false;
      // Pipeline teardown can wait forever on a response stream's cancel().
      // Release on the HTTP lifecycle too, and forbid late upload reservations.
      const releaseBodyBytes = () => {
        if (bodyBytesReleased) return;
        bodyBytesReleased = true;
        inFlightBodyBytes -= heldBodyBytes;
        heldBodyBytes = 0;
      };
      const abortRequest = () => {
        releaseBodyBytes();
        if (!controller.signal.aborted) {
          controller.abort(new Error("HTTP client disconnected."));
        }
      };
      const abortIncompleteRequest = () => {
        if (!req.complete) abortRequest();
      };
      const abortIncompleteResponse = () => {
        if (!res.writableFinished) abortRequest();
      };
      req.once("aborted", abortRequest);
      req.once("close", abortIncompleteRequest);
      res.once("close", abortIncompleteResponse);
      res.once("finish", releaseBodyBytes);
      res.once("close", releaseBodyBytes);
      // A queued pipelined response gets neither finish nor close when the
      // socket goes away, and its completed upload's request is already closed.
      socket.once("close", abortRequest);
      const holdBodyBytes = (bytes: number): boolean => {
        if (bodyBytesReleased || inFlightBodyBytes + bytes > maxInFlightBodyBytes) return false;
        inFlightBodyBytes += bytes;
        heldBodyBytes += bytes;
        return true;
      };
      try {
        const request = await toRequest(req, maxBodyBytes, holdBodyBytes, controller.signal);
        if (request === BODIES_AT_CAPACITY) {
          res.statusCode = 503;
          res.setHeader("Retry-After", "1");
          // Abandoned mid-body, like the 413 below.
          res.setHeader("Connection", "close");
          res.end("Service Unavailable");
          return;
        }
        if (request === BODY_TOO_LARGE) {
          res.statusCode = 413;
          // The request stream was abandoned mid-body, so this connection
          // cannot be reused — say so rather than leaving the client to
          // discover it as a reset.
          res.setHeader("Connection", "close");
          res.end("Payload Too Large");
          return;
        }
        const response = await connecta.fetch(request, undefined, { ...ctx, requestArrivedAt });
        await writeResponse(res, response);
      } catch (error) {
        if (error instanceof InvalidRequestUrl) {
          res.statusCode = 400;
          // Refused before reading the body, so the connection cannot be reused.
          res.setHeader("Connection", "close");
          res.end("Bad Request");
          return;
        }
        // A client that deliberately went away can make either the request
        // handler or response pipeline reject. The request's abort signal is
        // the authoritative classification: there is no caller left to answer,
        // and logging an expected disconnect would turn cancellation into an
        // error-log spam vector.
        if (controller.signal.aborted) return;
        // A headless deployment has nothing else to go on; never swallow this.
        logFailure(console, "request failed", failureRecord({}, error), "error");
        if (res.headersSent) {
          // Mid-stream failure: appending an error string here would corrupt
          // the partial body the client has already begun reading. Cutting
          // the connection is the only honest signal left.
          res.destroy();
          return;
        }
        res.statusCode = 500;
        res.end("Internal Server Error");
      } finally {
        releaseBodyBytes();
        res.removeListener("finish", releaseBodyBytes);
        res.removeListener("close", releaseBodyBytes);
        socket.removeListener("close", abortRequest);
        req.removeListener("aborted", abortRequest);
        req.removeListener("close", abortIncompleteRequest);
        res.removeListener("close", abortIncompleteResponse);
      }
    })();
  });

  if (opts.gracefulShutdown !== false) {
    const timeoutMs = opts.shutdownTimeoutMs ?? 10_000;
    // closeIdleConnections() only knows sockets that have served a request.
    // A client's spare connection (or incomplete first headers) must not hold
    // shutdown open without ever having been admitted to the application.
    server.on("connection", (socket) => {
      if (shuttingDown) {
        socket.destroy();
        return;
      }
      awaitingRequest.add(socket);
      socket.once("close", () => awaitingRequest.delete(socket));
    });
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.info(`[connecta] ${signal} received, draining`);
      const forced = setTimeout(() => {
        console.warn("[connecta] shutdown timed out, exiting");
        process.exit(1);
      }, timeoutMs);
      forced.unref?.();
      // Stop queued/running sandbox work now, not after server.close has
      // waited for the very requests those children are holding open.
      const executorClose = connecta.close();
      server.close(() => {
        void Promise.allSettled([...pending, executorClose]).then(() => {
          clearTimeout(forced);
          process.exit(0);
        });
      });
      server.closeIdleConnections();
      for (const socket of awaitingRequest) socket.destroy();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  if (opts.host) server.listen(opts.port, opts.host);
  else server.listen(opts.port);
  return server;
}
