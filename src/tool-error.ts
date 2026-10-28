import type { ToolResult } from "./meta-tools.js";

export function toolError(error: Record<string, unknown>, fields: Record<string, unknown> = {}): ToolResult {
  const structuredContent = { ...fields, error };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}
