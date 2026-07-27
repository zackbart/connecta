import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Connecta } from "./index.js";

export { fileStorage } from "./storage/file.js";
export type { FileStorageOptions } from "./storage/file.js";

/** 10 MiB. Tool arguments are JSON; nothing legitimate approaches this. */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface ListenOptions {
  port: number;
  /** Interface to bind. Defaults to Node's own (all interfaces). */
  host?: string;
  /** Reject request bodies larger than this with 413. Default 10 MiB. */
  maxBodyBytes?: number;
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

async function toRequest(
  req: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Request | typeof BODY_TOO_LARGE> {
  const host = req.headers.host ?? "localhost";
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const url = `${proto}://${host}${req.url ?? "/"}`;
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

async function writeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  // Stream rather than buffer: a connector-served route may return a large
  // proxied file body, and materializing it would hold the whole thing in
  // memory before the first byte reaches the client.
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    res,
  );
}

/**
 * Serve a Connecta over node:http. Thin adapter: IncomingMessage → Request,
 * Response → ServerResponse, plus the process-level concerns a long-running
 * container needs (body cap, response streaming, graceful shutdown). No
 * dependencies beyond node core.
 */
export function listen(
  connecta: Connecta,
  portOrOptions: number | ListenOptions,
): Server {
  const opts: ListenOptions =
    typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

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

  const server = createServer((req, res) => {
    void (async () => {
      const controller = new AbortController();
      const abortRequest = () => {
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
      try {
        const request = await toRequest(
          req,
          maxBodyBytes,
          controller.signal,
        );
        if (request === BODY_TOO_LARGE) {
          res.statusCode = 413;
          // The request stream was abandoned mid-body, so this connection
          // cannot be reused — say so rather than leaving the client to
          // discover it as a reset.
          res.setHeader("Connection", "close");
          res.end("Payload Too Large");
          return;
        }
        const response = await connecta.fetch(request, undefined, ctx);
        await writeResponse(res, response);
      } catch (error) {
        // A client that deliberately went away can make either the request
        // handler or response pipeline reject. The request's abort signal is
        // the authoritative classification: there is no caller left to answer,
        // and logging an expected disconnect would turn cancellation into an
        // error-log spam vector.
        if (controller.signal.aborted) return;
        // A headless deployment has nothing else to go on; never swallow this.
        console.error("[connecta] request failed", error);
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
        req.removeListener("aborted", abortRequest);
        req.removeListener("close", abortIncompleteRequest);
        res.removeListener("close", abortIncompleteResponse);
      }
    })();
  });

  if (opts.gracefulShutdown !== false) {
    const timeoutMs = opts.shutdownTimeoutMs ?? 10_000;
    let shuttingDown = false;
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
      // close() alone waits on idle keep-alive sockets, so a single browser
      // tab would stall every shutdown until the force-exit deadline.
      server.closeIdleConnections();
      server.close(() => {
        void Promise.allSettled([...pending, executorClose]).then(() => {
          clearTimeout(forced);
          process.exit(0);
        });
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  if (opts.host) server.listen(opts.port, opts.host);
  else server.listen(opts.port);
  return server;
}
