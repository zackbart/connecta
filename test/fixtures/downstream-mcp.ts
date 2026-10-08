import type { FetchLike, Transport } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

export type DownstreamTools = (server: McpServer) => void;

export async function inMemoryDownstream(tools: DownstreamTools) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "downstream", version: "1.0.0" });
  tools(server);
  await server.connect(serverTransport);
  return { server, clientTransport };
}

export function httpDownstream(
  tools: DownstreamTools,
  options: {
    capture?: (request: Request) => void | Promise<void>;
    url?: string;
    catalogTtlMs?: number;
  } = {},
) {
  const url = options.url ?? "https://downstream.test/mcp";
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "downstream", version: "1.0.0" });
    tools(server);
    return server;
  });
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    await options.capture?.(request.clone());
    const catalogRequest = options.catalogTtlMs !== undefined ? request.clone() : undefined;
    const response = await handler.fetch(request);
    if (options.catalogTtlMs !== undefined && request.method === "POST" && response.headers.get("content-type")?.includes("application/json")) {
      const message = await catalogRequest!.json() as { method?: string };
      if (message.method === "tools/list") {
        const body = await response.json() as { result?: Record<string, unknown> };
        if (body.result) Object.assign(body.result, { ttlMs: options.catalogTtlMs, cacheScope: "public" });
        return Response.json(body, { status: response.status, headers: response.headers });
      }
    }
    return response;
  };
  return {
    url,
    fetch,
    transport: () =>
      new StreamableHTTPClientTransport(new URL(url), { fetch }) as unknown as Transport,
  };
}

export function throwingTransport(
  err: Error,
  onStart?: () => Promise<void> | void,
): Transport {
  return {
    async start() {
      await onStart?.();
      throw err;
    },
    async send() {},
    async close() {},
  } as unknown as Transport;
}
