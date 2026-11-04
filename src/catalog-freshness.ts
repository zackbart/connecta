import type { ToolDef } from "./types.js";

// Host-only provenance follows catalog copies, never connector definitions or
// serialized listings. Unknown provenance cannot authorize post-entry recovery.
const deadlines = new WeakMap<readonly ToolDef[], number>();

export function markCatalogFreshness(tools: ToolDef[], freshUntil: number): ToolDef[] {
  deadlines.set(tools, freshUntil);
  return tools;
}

export function carryCatalogFreshness(source: readonly ToolDef[], copy: ToolDef[]): ToolDef[] {
  const stale = staleCatalogs.get(source);
  if (stale) staleCatalogs.set(copy, stale);
  return markCatalogFreshness(copy, deadlines.get(source) ?? 0);
}

/** Why a request served a catalog older than its TTL, and how old it is. */
export interface CatalogStaleness {
  code: string;
  /** Milliseconds since the downstream last confirmed this catalog. */
  ageMs: number;
  retryAfterMs?: number;
}
const staleCatalogs = new WeakMap<readonly ToolDef[], CatalogStaleness>();

/** Host-only, beside freshness: a stale listing is never fresh and never grants anything. */
export function markCatalogStale(tools: ToolDef[], staleness: CatalogStaleness): ToolDef[] {
  staleCatalogs.set(tools, staleness);
  return tools;
}

export function catalogStaleness(tools: readonly ToolDef[]): CatalogStaleness | undefined {
  return staleCatalogs.get(tools);
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
