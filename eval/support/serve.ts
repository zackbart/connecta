/**
 * A loopback HTTP server around a fetch handler, for the fake downstreams.
 *
 * Deliberately not connecta's `listen()`: the fakes stand in for somebody
 * else's service, and a harness that borrowed connecta's own adapter to host
 * them would share a bug with the thing it measures.
 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface Served {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function serveFetch(
  handler: (request: Request) => Promise<Response>,
  port = 0,
): Promise<Served> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value == null) continue;
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const method = req.method ?? "GET";
        const request = new Request(
          `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`,
          {
            method,
            headers,
            ...(method !== "GET" && method !== "HEAD" && chunks.length
              ? { body: new Uint8Array(Buffer.concat(chunks)) }
              : {}),
          },
        );
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (!response.body) {
          res.end();
          return;
        }
        await pipeline(
          Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0],
          ),
          res,
        );
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(error));
        } else {
          res.destroy();
        }
      }
    })();
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nobody holds right now, for a server that must know it up front. */
export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
