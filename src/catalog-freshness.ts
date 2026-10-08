import type { ToolDef } from "./types.js";

// Host-only provenance follows catalog copies, never connector definitions or
// serialized listings. Unknown provenance cannot authorize post-entry recovery.
const deadlines = new WeakMap<readonly ToolDef[], number>();

export function markCatalogFreshness(tools: ToolDef[], freshUntil: number): ToolDef[] {
  deadlines.set(tools, freshUntil);
  return tools;
}

export function carryCatalogFreshness(source: readonly ToolDef[], copy: ToolDef[]): ToolDef[] {
  return markCatalogFreshness(copy, deadlines.get(source) ?? 0);
}

export function catalogIsFresh(tools: readonly ToolDef[]): boolean {
  return (deadlines.get(tools) ?? 0) > Date.now();
}
