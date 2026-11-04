/** The 0.29 tools, shared by both runners and the deployment smoke. */
export const META_TOOLS = [
  "authorize_connector",
  "call_destructive_tool",
  "call_tool",
  "execute_code",
  "search_tools",
  "skills",
] as const;

export type Surface =
  | "six"
  | "five"
  | "code"
  | "native"
  | "native-no-code"
  | "native-hints"
  | "native-bound"
  | "read-six"
  | "read-five"
  | "pinned";
export const FIVE_TOOLS = META_TOOLS.filter((name) => name !== "search_tools");
export const CODE_TOOLS = ["authorize_connector", "execute_code", "skills"] as const;

export function parseSurface(value = "six"): Surface {
  if (
    ![
      "six",
      "five",
      "code",
      "native",
      "native-no-code",
      "native-hints",
      "native-bound",
      "read-six",
      "read-five",
      "pinned",
    ].includes(value)
  )
    throw new Error(
      "--surface must be six, five, code, native, native-no-code, native-hints, read-six, read-five or pinned",
    );
  return value as Surface;
}

export function assertSurface(names: string[], surface: Surface = "six"): void {
  const actual = names.map((name) => name.replace(/^mcp__connecta__/, "")).sort();
  if (surface === "pinned") {
    const pinned = actual.filter((name) => !META_TOOLS.includes(name as (typeof META_TOOLS)[number]));
    if (
      !META_TOOLS.every((name) => actual.includes(name)) ||
      pinned.length === 0 ||
      pinned.length > 30 ||
      pinned.some((name) => !name.includes("__"))
    )
      throw new Error(`Expected the six meta-tools and pinned native tools; got ${actual.join(", ")}`);
    return;
  }
  if (surface === "read-six" || surface === "read-five") {
    const expected = [...(surface === "read-six" ? META_TOOLS : FIVE_TOOLS), "execute_read_code"].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`Expected ${expected.join(", ")}; got ${actual.join(", ")}`);
    return;
  }
  if (
    surface === "native" ||
    surface === "native-no-code" ||
    surface === "native-hints" ||
    surface === "native-bound"
  ) {
    const local =
      surface !== "native-no-code"
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
    JSON.stringify(surface === "six" ? META_TOOLS : surface === "five" ? FIVE_TOOLS : CODE_TOOLS)
  ) {
    throw new Error(`Expected the ${surface} meta-tools; got ${actual.join(", ")}`);
  }
}
