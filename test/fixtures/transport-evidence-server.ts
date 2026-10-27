// Runs in Vitest's Node coordinator; both projects use native fetch over TCP.
// Real refused and reset connections, so a test can see what each runtime's
// fetch reports when a write's connection fails, and how many request bytes
// the server received before it did (#902).
import { createServer } from "node:http";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Origin of a server whose routes are listed in `setup`. */
    evidenceHttpServer: string;
    /** A reserved loopback origin nothing listens on: connecting is refused. */
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
 * - `POST /<id>/status/<code>`: read the whole request, then answer HTTP
 *   `<code>` with the `body` query parameter (default `{}`) as JSON.
 * - `GET /<id>/exchanges`: what the server received for `<id>`.
 */
export default async function setup(project: TestProject) {
  const exchanges = new Map<string, Exchange[]>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const [, id, route, code] = url.pathname.split("/");
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
      else if (route === "status")
        response
          .writeHead(Number(code), { "content-type": "application/json" })
          .end(url.searchParams.get("body") ?? "{}");
      else if (route !== "hold") response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Transport evidence fixture has no TCP address.");
  // An outgoing socket reserves its local port without listening there.
  // Releasing a temporary listener lets later test servers claim the port.
  const peers = new Set<Socket>();
  const reservation = createTcpServer((socket) => peers.add(socket));
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const reservationAddress = reservation.address();
  if (!reservationAddress || typeof reservationAddress === "string")
    throw new Error("Refused-port reservation has no TCP address.");
  const holder = createConnection({ host: "127.0.0.1", port: reservationAddress.port });
  await new Promise<void>((resolve, reject) => holder.once("connect", resolve).once("error", reject));
  const refusedPort = holder.localPort;
  if (!refusedPort) throw new Error("Refused-port socket has no local port.");
  project.provide("evidenceHttpServer", `http://127.0.0.1:${address.port}`);
  project.provide("refusedHttpOrigin", `http://127.0.0.1:${refusedPort}`);
  return async () => {
    holder.destroy();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
}
