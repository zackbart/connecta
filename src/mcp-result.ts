import type { Connector } from "./types.js";

interface McpishResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
  toolResult?: unknown;
}

/**
 * Unwrap an MCP CallToolResult into an ordinary JavaScript value:
 * `toolResult` wins when present, then `structuredContent`; all-text content is
 * JSON-parsed when possible. Downstream `isError` results become exceptions.
 * Non-MCP connectors already return plain values.
 */
export function unwrapMcpResult(
  kind: Connector["kind"],
  result: unknown,
): unknown {
  if (kind !== "mcp" || result == null || typeof result !== "object") {
    return result;
  }
  const r = result as McpishResult;
  if ("toolResult" in r) return r.toolResult;
  const content = Array.isArray(r.content) ? r.content : [];
  if (r.isError) {
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    throw new Error(text || "Tool call failed");
  }
  if (r.structuredContent != null) return r.structuredContent;
  if (content.length > 0 && content.every((c) => c.type === "text")) {
    const text = content.map((c) => c.text ?? "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}
