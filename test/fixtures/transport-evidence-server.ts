// Runs in Vitest's Node coordinator; both projects use native fetch over TCP.
// Real connect failures and resets, so a test can see what each runtime's
// fetch reports when a write's connection fails, and how many request bytes
// the server received before it did (#902).
import { createServer } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Origin of a server whose routes are listed in `setup`. */
    evidenceHttpServer: string;
    /** Port zero cannot become a listener: listen(0) allocates a nonzero port. */
    unreachableHttpOrigin: string;
    /** Native coordinator error, including Darwin's port-zero rejection. */
    unreachableHttpCode: "ECONNREFUSED" | "EADDRNOTAVAIL";
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
  // A released ephemeral port can be reused by another fixture. Port zero
  // remains unreachable even while other servers allocate their own ports.
  // Verify a native connect failure, rather than an HTTP or fetch-policy error.
  const unreachable = "http://127.0.0.1:0";
  const unreachableCode = await fetch(unreachable).then(
    () => {
      throw new Error("The transport fixture's unreachable origin answered.");
    },
    (error: unknown) => {
      const code = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
      if (code !== "ECONNREFUSED" && code !== "EADDRNOTAVAIL") throw error;
      return code;
    },
  );
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
  project.provide("evidenceHttpServer", `http://127.0.0.1:${address.port}`);
  project.provide("unreachableHttpOrigin", unreachable);
  project.provide("unreachableHttpCode", unreachableCode);
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
}
