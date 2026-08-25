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
    return handler.fetch(request);
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
