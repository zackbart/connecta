export type RewrittenArm = "terse" | "disambiguation" | "example";

/** Per-arm property text: a string replaces or adds text, null removes it. */
type PropertyOverrides = Partial<Record<RewrittenArm, Readonly<Record<string, string | null>>>>;

export type ToolEntry = Readonly<Record<RewrittenArm, string>> & { readonly properties?: PropertyOverrides };

export interface ProviderTable {
  readonly tools: Readonly<Record<string, ToolEntry>>;
}

/** The two discovery hatches read alike on every provider; only the title and example differ. */
export function hatchDiscovery(
  title: string,
  searchExample: string,
  detailsExample: string,
  prefix: string,
): Record<string, ToolEntry> {
  return {
    [`${prefix}_api_search`]: {
      terse: `Find ${title} API operations by keyword or path; reads no account data.`,
      disambiguation: `Find the ${title} API operation for a need no named tool covers; reads no account data. Then ${prefix}_api_details gives its contract.`,
      example: `Find ${title} API operations; reads no account data. Example: ${searchExample}.`,
    },
    [`${prefix}_api_details`]: {
      terse: `Read one ${title} API operation's request contract, response fields and refusal; reads no account data.`,
      disambiguation: `Read one ${title} operation's exact parameters and response fields before calling it; reads no account data.`,
      example: `Read one ${title} API operation's contract; reads no account data. Example: ${detailsExample}.`,
    },
  };
}
