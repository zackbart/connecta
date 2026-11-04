import type { ToolDef } from "./types.js";

type SourceFacts = "read" | "silent" | "declared_write";

function sourceFactsOf(annotations: ToolDef["annotations"]): SourceFacts {
  const readOnly = annotations?.readOnlyHint;
  const destructive = annotations?.destructiveHint;
  if (readOnly === true && destructive !== true) return "read";
  // Anything but a clean read or silence counts as declared, including contradictory
  // or malformed hints: an override must not turn an unclear statement into a read.
  return readOnly === undefined && destructive !== true ? "silent" : "declared_write";
}

// Source policy is fail-closed annotations, with silence kept apart from a
// declared write. Deployment overrides never enter it. It is private metadata,
// not catalog data. Keep it through host-owned clones without exposing it to
// tools or storage.
const sourceFacts = new WeakMap<ToolDef, SourceFacts>();

const factsFor = (tool: ToolDef): SourceFacts => sourceFacts.get(tool) ?? sourceFactsOf(tool.annotations);

export function sourceClassification(tool: ToolDef): "read" | "write" {
  return factsFor(tool) === "read" ? "read" : "write";
}

/** The source said this tool writes, as opposed to saying nothing. */
export function sourceDeclaresWrite(tool: ToolDef): boolean {
  return factsFor(tool) === "declared_write";
}

/**
 * Deployment override, then fail-closed annotations. A read override speaks
 * only where the source is silent: a declared write stays a write, because a
 * read annotation lets a host resend the call.
 */
export function classifyTool(definition: ToolDef, override?: "read" | "write"): "read" | "write" {
  if (override === "write" || (override === "read" && !sourceDeclaresWrite(definition))) return override;
  return sourceClassification(definition);
}

export function carryToolClassification(source: ToolDef, served: ToolDef): ToolDef {
  sourceFacts.set(served, factsFor(source));
  return served;
}

/** Replay and outcome policy only; admission and presentation use the served class. */
export function isWriteLike(tool: ToolDef): boolean {
  return tool.classification !== "read" || sourceClassification(tool) === "write";
}

/** The surface that runs a read-only program: it never dispatches a write-like call. */
export const READ_PROGRAM_SOURCE = "execute_read_code" as const;

export function cloneTool(tool: ToolDef): ToolDef {
  return carryToolClassification(tool, structuredClone(tool));
}

/**
 * The only permission decision for a connector call. Approval is client-owned.
 * A read-only endpoint refuses every write on every surface; a writable one
 * sends writes through call_destructive_tool and writing programs, never call_tool
 * or a read program.
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
