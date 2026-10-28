// A first-party MCP downstream reached over a Workers service binding
// (test/remote-mcp-principal-forwarding.test.ts). Only the `connecta`
// entrypoint, which a binding alone can reach, reads the forwarded identity.
// The public default export never does.
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WorkerEntrypoint } from "cloudflare:workers";

/** The identity a short-lived assertion names; the assertion itself is never echoed. */
function notes(bearer: string) {
  const principal = bearer.split(".")[0]!;
  return createMcpHandler(() => {
    const server = new McpServer({ name: "notes", version: "1.0.0" });
    server.registerTool(
      "whoami",
      {
        description: "Report the identity this entrypoint received",
        inputSchema: z.object({}).passthrough(),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: principal }], structuredContent: { principal } }),
    );
    return server;
  });
}

export const connecta = {
  async fetch(request: Request): Promise<Response> {
    const bearer = /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer) return new Response("missing identity", { status: 401 });
    return notes(bearer).fetch(request);
  },
};

export default {
  async fetch(): Promise<Response> {
    return new Response("identity is accepted only through the binding entrypoint", { status: 403 });
  },
};

// A custom RPC method returns a disposable Response, unlike native fetch.
export class NotesRpc extends WorkerEntrypoint {
  async request(url: string, init?: RequestInit): Promise<Response> {
    return connecta.fetch(new Request(url, init));
  }
}
