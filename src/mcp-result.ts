import { boundedEchoText } from "./errors.js";
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
export function downstreamValue(kind: Connector["kind"], result: unknown): { data: unknown; format: "json" | "text" } {
  if (kind !== "mcp" || result == null || typeof result !== "object") {
    return { data: result, format: typeof result === "string" ? "text" : "json" };
  }
  const r = result as McpishResult;
  if ("toolResult" in r) return { data: r.toolResult, format: "json" };
  const content = Array.isArray(r.content) ? r.content : [];
  if (r.isError) {
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    throw new Error(boundedEchoText(text || "Tool call failed"));
  }
  if (r.structuredContent !== undefined) return { data: r.structuredContent, format: "json" };
  if (content.length > 0 && content.every((c) => c.type === "text")) {
    const text = content.map((c) => c.text ?? "").join("\n");
    try {
      return { data: JSON.parse(text), format: "json" };
    } catch {
      return { data: text, format: "text" };
    }
  }
  return { data: result, format: "json" };
}

/** Preserve the raw-value API for internal callers that already know its format. */
export function unwrapMcpResult(kind: Connector["kind"], result: unknown): unknown {
  return downstreamValue(kind, result).data;
}
