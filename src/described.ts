// Small, allowlisting builders shared by every `Connector.describe()` and by
// `describeConfig()` itself. Each one copies named fields of known types and
// nothing else, so a value that carries a secret — a URL's userinfo or query,
// a header's value, a function's source — has no path into a description.

import { assertKnownOptions, type Field } from "./config-schema.js";
import { isExplicitlyReadOnly } from "./tool-safety.js";
import type {
  ConnectorDescription,
  ConnectorToolDescription,
  DescribedEndpoint,
  JsonSchema,
  ToolAnnotations,
  ToolDef,
} from "./types.js";

/**
 * Origin and path of an absolute http(s) URL; undefined for anything else.
 *
 * The scheme is allowlisted, not just parsed: `blob:` and other schemes that
 * wrap a URL report the inner URL's origin while their `pathname` is the
 * whole inner URL, userinfo included, and `data:` or `javascript:` carry
 * their payload in the path. Every field a description reports is a web
 * URL, so any other scheme is omitted rather than reduced.
 */
export function describedEndpoint(value: unknown): DescribedEndpoint | undefined {
  if (typeof value !== "string" && !(value instanceof URL)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin === "null") return undefined;
    return { origin: url.origin, path: url.pathname };
  } catch {
    return undefined;
  }
}

/**
 * An absolute URL as `origin + path`: userinfo, query, and fragment dropped.
 * Every URL a description emits as a string goes through this or
 * {@link describedHref}, so none carries a token a deployment put in it.
 */
export function describedUrl(value: unknown): string | undefined {
  const endpoint = describedEndpoint(value);
  return endpoint ? `${endpoint.origin}${endpoint.path}` : undefined;
}

/** An origin alone, from any absolute URL. */
export function describedOrigin(value: unknown): string | undefined {
  return describedEndpoint(value)?.origin;
}

/**
 * An href that may be root-relative (`/favicon.svg?v=…`): an absolute one as
 * {@link describedUrl}, a relative one as its path alone.
 */
export function describedHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const absolute = describedUrl(value);
  if (absolute !== undefined) return absolute;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  try {
    return new URL(value, "https://connecta.invalid").pathname;
  } catch {
    return undefined;
  }
}

const ANNOTATION_KEYS = {
  title: "string",
  readOnlyHint: "boolean",
  destructiveHint: "boolean",
  idempotentHint: "boolean",
  openWorldHint: "boolean",
} as const;

function describedAnnotations(value: unknown): ToolAnnotations | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: ToolAnnotations = {};
  for (const [key, type] of Object.entries(ANNOTATION_KEYS)) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === type) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A JSON Schema as plain data. Schemas are declared in source and describe
 * arguments, never hold them; the round trip drops anything that is not JSON.
 */
function describedSchema(value: unknown): JsonSchema | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonSchema;
  } catch {
    return undefined;
  }
}

/** Static tool definitions as `describeConfig()` reports them. */
export function describedTools(tools: readonly ToolDef[]): ConnectorToolDescription[] {
  return tools.map((tool) => {
    const annotations = describedAnnotations(tool.annotations);
    const inputSchema = describedSchema(tool.inputSchema);
    const outputSchema = describedSchema(tool.outputSchema);
    return {
      name: String(tool.name),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(annotations ? { annotations } : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      classification: isExplicitlyReadOnly(tool) ? "read" : "write",
    };
  });
}

/**
 * Build a maintained provider's connector: refuse unknown options and
 * accessors by path before the builder reads any of them, then stamp the
 * provider onto its description, so the operator surface can say "Linear"
 * rather than "remote MCP".
 */
export function asProvider<O, C extends { describe?(): ConnectorDescription }>(
  provider: string,
  shape: Field<unknown, unknown>,
  id: string,
  options: O,
  build: (id: string, options: O) => C,
): C {
  // The factory a deployment called: "planning-center" is planningCenter().
  const factory = provider.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  options = assertKnownOptions(options, `${factory}(${JSON.stringify(id)})`, shape);
  const connector = build(id, options);
  const describe = connector.describe?.bind(connector);
  return {
    ...connector,
    describe: (): ConnectorDescription => {
      const base = describe?.() ?? { source: { kind: "custom" as const } };
      return { ...base, source: { ...base.source, provider } };
    },
  };
}
