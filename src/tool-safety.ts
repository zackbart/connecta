import type { ToolDef, ToolVerdict } from "./types.js";

export type PoolTrust = "trusted" | "read-only";

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

/** The only permission decision for a connector call. Approval is host-owned. */
export function surfaceAllowsTool(
  classification: ToolDef["classification"],
  surface: string,
  trust: PoolTrust = "read-only",
): boolean {
  return (
    classification === "read" ||
    surface === "call_destructive_tool" ||
    (surface === "execute_code" && trust === "trusted")
  );
}
