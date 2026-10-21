// Runs in Vitest's Node coordinator; both projects use native fetch over TCP.
// Real refused and reset connections, so a test can see what each runtime's
// fetch reports when a write's connection fails, and how many request bytes
// the server received before it did (#902).
import { createServer } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Origin of a server whose routes are listed in `setup`. */
    evidenceHttpServer: string;
    /** A loopback origin nothing listens on: connecting is refused. */
    refusedHttpOrigin: string;
  }
}

interface Exchange {
  method: string;
  bytes: number;
}

/**
 * - `POST /<id>/reset`: read the whole request, then destroy the socket
 *   without answering.
 * - `POST /<id>/sink`: count body bytes as they arrive; destroy the socket if
 *   the request breaks off, answer 200 if it ends.
 * - `POST /<id>/hold`: read the whole request and never answer, until the
 *   client gives up.
 * - `GET /<id>/exchanges`: what the server received for `<id>`.
 */
export default async function setup(project: TestProject) {
  const exchanges = new Map<string, Exchange[]>();
  const server = createServer((request, response) => {
    const [, id, route] = new URL(request.url!, "http://localhost").pathname.split("/");
    if (!id) {
      response.writeHead(404).end();
      return;
    }
    if (route === "exchanges") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(exchanges.get(id) ?? []));
      return;
    }
    const exchange: Exchange = { method: request.method ?? "", bytes: 0 };
    exchanges.set(id, [...(exchanges.get(id) ?? []), exchange]);
    request.on("data", (chunk: Buffer) => {
      exchange.bytes += chunk.byteLength;
    });
    request.on("error", () => response.destroy());
    request.on("aborted", () => response.destroy());
    request.on("end", () => {
      if (route === "reset") response.destroy();
      else if (route !== "hold") response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Transport evidence fixture has no TCP address.");
  // Bind a port, then release it: connecting to it afterwards is refused.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedAddress = closed.address();
  if (!closedAddress || typeof closedAddress === "string") throw new Error("Refused-port fixture has no TCP address.");
  await new Promise<void>((resolve, reject) => closed.close((error) => (error ? reject(error) : resolve())));
  project.provide("evidenceHttpServer", `http://127.0.0.1:${address.port}`);
  project.provide("refusedHttpOrigin", `http://127.0.0.1:${closedAddress.port}`);
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
}
