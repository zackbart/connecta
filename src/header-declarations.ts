import { ConnectorCallError } from "./errors.js";

const MAPS = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"]);
const BRANCHES = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  ...MAPS,
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
];
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_TYPES = new Set(["string", "integer", "boolean"]);

/**
 * Whether the SDK's SEP-2243 scan (2.4.0) would reject `schema`'s
 * `x-mcp-header` declarations. Its client excludes such a tool and its server
 * logs the tool name and property path, so callers refuse first (INV-6).
 */
export function hasInvalidHeaderDeclaration(schema: unknown): boolean {
  const names = new Set<string>();
  const visit = (node: unknown, reachable: boolean, property: boolean): boolean => {
    if (!node || typeof node !== "object") return false;
    const value = node as Record<string, unknown>;
    if ("x-mcp-header" in value) {
      const header = value["x-mcp-header"];
      if (
        !reachable ||
        !property ||
        typeof header !== "string" ||
        !HEADER_TOKEN.test(header) ||
        !HEADER_TYPES.has(value.type as string) ||
        names.has(header.toLowerCase())
      )
        return true;
      names.add(header.toLowerCase());
    }
    if (value.properties && typeof value.properties === "object") {
      for (const child of Object.values(value.properties)) if (visit(child, reachable, true)) return true;
    }
    for (const keyword of BRANCHES) {
      const sub = value[keyword];
      const children = Array.isArray(sub)
        ? sub
        : sub && typeof sub === "object" && MAPS.has(keyword)
          ? Object.values(sub)
          : [sub];
      for (const child of children) if (visit(child, false, false)) return true;
    }
    return false;
  };
  return visit(schema, true, false);
}

/** A listing refused whole, typed and payload-free (INV-6, INV-8). */
export function assertListedHeaderDeclarations(tools: readonly { inputSchema?: unknown }[]): void {
  if (tools.some((tool) => hasInvalidHeaderDeclaration(tool.inputSchema)))
    throw new ConnectorCallError("connector_call_failed", "Downstream tool has an invalid x-mcp-header declaration.", {
      retryable: false,
    });
}
