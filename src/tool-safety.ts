import type { ToolDef, ToolVerdict } from "./types.js";

/** Deployment override, then verified provider review, then fail-closed hints. */
export function classifyTool(
  definition: ToolDef,
  override?: "read" | "write",
  review?: { verdict: ToolVerdict; stale?: boolean },
): "read" | "write" {
  if (override !== undefined) return override;
  if (review) {
    if (review.stale || review.verdict !== "read") return "write";
    // An explicit downstream contradiction invalidates a reviewed read (#721).
    if (definition.annotations?.readOnlyHint === false || definition.annotations?.destructiveHint === true)
      return "write";
    return "read";
  }
  return definition.annotations?.readOnlyHint === true && definition.annotations?.destructiveHint !== true
    ? "read"
    : "write";
}

/**
 * The only permission decision for a connector call. Approval is client-owned.
 * A read-only endpoint refuses every write on every surface; a writable one
 * sends writes through call_destructive_tool and programs, never call_tool.
 */
export function writeRefusal(
  classification: ToolDef["classification"],
  surface: string,
  readOnly = false,
): "read_only_endpoint" | "destructive_tool_requires_approval" | undefined {
  if (classification === "read") return undefined;
  if (readOnly) return "read_only_endpoint";
  return surface === "call_destructive_tool" || surface === "execute_code"
    ? undefined
    : "destructive_tool_requires_approval";
}
