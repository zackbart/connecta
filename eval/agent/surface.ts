/** The 0.29 tools, shared by both runners and the deployment smoke. */
export const META_TOOLS = [
  "authorize_connector",
  "call_destructive_tool",
  "call_tool",
  "execute_code",
  "search_tools",
  "skills",
] as const;

export type Surface = "six" | "read" | "five" | "code" | "native" | "native-no-code";
/** The six plus the read program route, which a writable meta endpoint lists. */
export const READ_TOOLS = [...META_TOOLS, "execute_read_code"].sort();
export const FIVE_TOOLS = META_TOOLS.filter((name) => name !== "search_tools");
export const CODE_TOOLS = ["authorize_connector", "execute_code", "skills"] as const;

export function parseSurface(value = "six"): Surface {
  if (!["six", "read", "five", "code", "native", "native-no-code"].includes(value))
    throw new Error("--surface must be six, read, five, code, native or native-no-code");
  return value as Surface;
}

/**
 * `endpoint` is the URL the host connected to. A task reaching a writable endpoint
 * on the six arm also sees the read program route.
 */
export function assertSurface(names: string[], surface: Surface = "six", endpoint?: string): void {
  const actual = names.map((name) => name.replace(/^mcp__connecta__/, "")).sort();
  if (surface === "six" && endpoint !== undefined && JSON.stringify(actual) === JSON.stringify(READ_TOOLS)) return;
  if (surface === "native" || surface === "native-no-code") {
    const local =
      surface === "native"
        ? ["authorize_connector", "execute_code", "skills"]
        : ["authorize_connector", "read_result", "skills"];
    const downstream = actual.filter((name) => !local.includes(name));
    if (
      new Set(actual).size !== actual.length ||
      !local.every((name) => actual.includes(name)) ||
      downstream.length === 0 ||
      downstream.some((name) => !/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(name))
    )
      throw new Error(`Expected ${surface} downstream tools and ${local.join(", ")}; got ${actual.join(", ")}`);
    return;
  }
  if (
    JSON.stringify(actual) !==
    JSON.stringify(
      surface === "six" ? META_TOOLS : surface === "read" ? READ_TOOLS : surface === "five" ? FIVE_TOOLS : CODE_TOOLS,
    )
  ) {
    throw new Error(`Expected the ${surface} meta-tools; got ${actual.join(", ")}`);
  }
}
