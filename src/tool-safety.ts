import type { ToolDef } from "./types.js";

/**
 * The one fail-closed classification shared by discovery and invocation.
 *
 * A tool is read-only only when it says so without also saying it is
 * destructive. Missing, false, and contradictory annotations all require the
 * approval-visible call path.
 */
export function isExplicitlyReadOnly(definition: ToolDef): boolean {
  return (
    definition.annotations?.readOnlyHint === true &&
    definition.annotations?.destructiveHint !== true
  );
}
