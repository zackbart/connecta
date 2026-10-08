/** The 0.29 tools, shared by both runners and the deployment smoke. */
export const META_TOOLS = [
  "authorize_connector", "call_destructive_tool", "call_tool",
  "execute_code", "search_tools", "skills",
] as const;

export function assertSurface(names: string[]): void {
  const actual = names.map(name => name.replace(/^mcp__connecta__/, "")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(META_TOOLS)) {
    throw new Error(`Expected the six 0.29 meta-tools; got ${actual.join(", ")}`);
  }
}
