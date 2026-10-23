import type { ToolDef } from "./types.js";

/** Deployment override, then fail-closed annotations. */
export function classifyTool(definition: ToolDef, override?: "read" | "write"): "read" | "write" {
  if (override !== undefined) return override;

  return definition.annotations?.readOnlyHint === true && definition.annotations?.destructiveHint !== true
    ? "read"
    : "write";
}

// Source policy is fail-closed annotations.
// Deployment overrides never enter it. It is private metadata, not catalog data.
// Keep it through host-owned clones without exposing it to tools or storage.
const sourceClassifications = new WeakMap<ToolDef, "read" | "write">();

export function sourceClassification(tool: ToolDef): "read" | "write" {
  return sourceClassifications.get(tool) ?? classifyTool(tool);
}

export function carryToolClassification(source: ToolDef, served: ToolDef): ToolDef {
  sourceClassifications.set(served, sourceClassification(source));
  return served;
}

/** Replay and outcome policy only; admission and presentation use the served class. */
export function isWriteLike(tool: ToolDef): boolean {
  return tool.classification !== "read" || sourceClassification(tool) === "write";
}

export function cloneTool(tool: ToolDef): ToolDef {
  return carryToolClassification(tool, structuredClone(tool));
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
