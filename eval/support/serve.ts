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

/** Injected per-request latency by served port; see eval/fakes/injection.ts. */
const latencies = new Map<number, number>();

/** Delay every request the fake at `url` answers by `ms`, until the release runs. */
export function delayServed(url: string, ms: number): () => void {
  const port = Number(new URL(url).port);
  if (ms <= 0) return () => {};
  if (latencies.has(port)) throw new Error(`Latency already injected for ${url}`);
  latencies.set(port, ms);
  return () => {
    if (latencies.get(port) === ms) latencies.delete(port);
  };
}

export async function serveFetch(handler: (request: Request) => Promise<Response>, port = 0): Promise<Served> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      // A fake answers only for the address it published. Other processes on
      // a shared host sweep `localhost:<port>`; such a probe must never reach
      // a fake's ledger as a vendor call.
      if (req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}`) {
        req.resume();
        res.statusCode = 421;
        res.end("Misdirected request");
        return;
      }
      try {
        const delay = latencies.get((server.address() as AddressInfo).port);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value == null) continue;
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const method = req.method ?? "GET";
        const request = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
          method,
          headers,
          ...(method !== "GET" && method !== "HEAD" && chunks.length
            ? { body: new Uint8Array(Buffer.concat(chunks)) }
            : {}),
        });
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (!response.body) {
          res.end();
          return;
        }
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
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
