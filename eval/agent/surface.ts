/** The 0.29 tools, shared by both runners and the deployment smoke. */
export const META_TOOLS = [
  "authorize_connector",
  "call_destructive_tool",
  "call_tool",
  "execute_code",
  "search_tools",
  "skills",
] as const;

export type Surface = "six" | "code";
export const CODE_TOOLS = ["authorize_connector", "execute_code", "skills"] as const;

export function parseSurface(value = "six"): Surface {
  if (value !== "six" && value !== "code") throw new Error("--surface must be six or code");
  return value;
}

export function assertSurface(names: string[], surface: Surface = "six"): void {
  const actual = names.map((name) => name.replace(/^mcp__connecta__/, "")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(surface === "six" ? META_TOOLS : CODE_TOOLS)) {
    throw new Error(`Expected the ${surface} meta-tools; got ${actual.join(", ")}`);
  }
}
