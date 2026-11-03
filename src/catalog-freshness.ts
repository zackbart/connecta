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

// Primitive accepted-generation evidence lives only beside the current request.
const generations = new WeakMap<object, Map<string, string>>();
export function markCatalogGeneration(
  scope: object | undefined,
  connector: string,
  generation: string | undefined,
): void {
  if (!scope || generation === undefined) return;
  let values = generations.get(scope);
  if (!values) generations.set(scope, (values = new Map()));
  values.set(connector, generation);
}
export function catalogGenerationFor(scope: object, connector: string): string | undefined {
  return generations.get(scope)?.get(connector);
}
