/**
 * A plain MCP client session against a running deployment, over HTTP, using
 * the SDK client — the same wire any host speaks. Used by the smoke checks,
 * the latency probe, and the scripted reference solutions.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

interface ToolResult {
  isError: boolean;
  text: string;
  structured: unknown;
}

export interface ListedTool {
  name: string;
  readOnly: boolean;
}

export interface McpSession {
  serverName: string | undefined;
  listTools(): Promise<ListedTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export async function connectMcp(
  url: string,
  headers: Record<string, string>,
): Promise<McpSession> {
  const client = new Client({ name: "connecta-eval", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return {
    serverName: client.getServerVersion()?.name,
    async listTools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        readOnly: tool.annotations?.readOnlyHint === true,
      }));
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        isError: result.isError === true,
        text: content
          .map((block) =>
            typeof block === "object" && block !== null && "text" in block
              ? String((block as { text: unknown }).text)
              : "",
          )
          .join("\n"),
        structured: result.structuredContent,
      };
    },
    close: () => client.close(),
  };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
