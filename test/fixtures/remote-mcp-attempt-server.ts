// Node coordinator: real MCP handlers behind sockets, shared with workerd.
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    remoteMcpAttemptServer: string;
  }
}

async function listening(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No probe TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

export default async function setup(project: TestProject) {
  const probes = new Map<string, { server: Server; received: string[]; closed: number; wire: unknown[] }>();
  const control = createServer(async (request, response) => {
    const key = request.url!.slice(1);
    if (request.method === "GET") {
      const probe = probes.get(key);
      if (!probe) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: probe.received, closed: probe.closed, wire: probe.wire }));
      return;
    }
    const received: string[] = [];
    const wire: unknown[] = [];
    let probe: { server: Server; received: string[]; closed: number; wire: unknown[] };
    const downstream = createMcpHandler(() => {
      const mcp = new McpServer({ name: "attempt-probe", version: "1.0.0" });
      for (const name of ["create_item", "list_items"]) {
        mcp.registerTool(name, { inputSchema: z.object({ label: z.string().optional() }), annotations: { readOnlyHint: name === "list_items" } }, async () => ({
          content: [{ type: "text", text: "ok" }],
        }));
      }
      mcp.registerResource("items", "fixture://items", {}, async (uri) => ({
        contents: [{ uri: uri.href, text: "ok" }],
      }));
      return mcp;
    }, { responseMode: key === "sse" ? "sse" : key === "json" ? "json" : "auto" });
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      if (key === "401") {
        const json = (value: unknown, status = 200) => outgoing.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        if (incoming.url!.startsWith("/.well-known/oauth-protected-resource")) {
          json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
          return;
        }
        if (incoming.url!.startsWith("/.well-known/")) {
          json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;
        }
        if (incoming.url === "/token") {
          json({ error: "invalid_grant" }, 400);
          return;
        }
      }
      const rpc = body ? (JSON.parse(body) as { method?: string }) : undefined;
      if (rpc?.method === "tools/call" || rpc?.method === "resources/read") {
        received.push(body);
        wire.push({ method: incoming.method, headers: incoming.headers, body });
        outgoing.once("close", () => { probe.closed++; });
        if (key === "401") {
          outgoing.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          }).end("{}");
          return;
        }
        if (received.length === 1 && ["421-closed", "421-open", "reset", "retry-reset", "retry-503"].includes(key)) {
          if (key === "421-closed") server.close();
          if (key === "reset" || key === "retry-reset") {
            outgoing.destroy();
            return;
          }
          outgoing.writeHead(key === "retry-503" ? 503 : 421, {
            "content-type": "application/json",
            connection: "close",
          }).end("{}");
          return;
        }
      }
      try {
        const answer = await downstream.fetch(new Request("http://downstream.test/mcp", {
          method: incoming.method ?? "GET",
          headers: incoming.headers as Record<string, string>,
          ...(body ? { body } : {}),
        }));
        if (key === "sse-hold" && rpc?.method === "tools/call") {
          // The real handler completed the write. Hold its answer stream until
          // the caller cancels, so the owned response/client must be released.
          await answer.arrayBuffer();
          outgoing.writeHead(200, { "content-type": "text/event-stream" });
          outgoing.write(": waiting\n\n");
          return;
        }
        outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
        if (answer.body) await pipeline(Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]), outgoing);
        else outgoing.end();
      } catch {
        outgoing.destroy();
      }
    });
    const origin = await listening(server);
    const id = crypto.randomUUID();
    probe = { server, received, closed: 0, wire };
    probes.set(id, probe);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ origin, id }));
  });
  project.provide("remoteMcpAttemptServer", await listening(control));
  return async () => {
    for (const server of [control, ...[...probes.values()].map((probe) => probe.server)]) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
