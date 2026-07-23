import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Connecta } from "./index.js";

export { fileStorage } from "./storage/file.js";

async function toRequest(req: IncomingMessage): Promise<Request> {
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
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length) body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(url, {
    method,
    headers,
    body,
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
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

/**
 * Serve a Connecta over node:http. Thin adapter: IncomingMessage → Request,
 * Response → ServerResponse. No dependencies beyond node core.
 */
export function listen(connecta: Connecta, port: number): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const request = await toRequest(req);
        const response = await connecta.fetch(request);
        await writeResponse(res, response);
      } catch {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    })();
  });
  server.listen(port);
  return server;
}
