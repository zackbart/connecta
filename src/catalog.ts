import type { JsonSchema, ToolDef } from "./types.js";

const DEFAULT_DESCRIPTION_LENGTH = 240;

export function summarizeDescription(
  text: string | undefined,
  full: boolean,
): string | undefined {
  if (!text) return undefined;
  if (full) return text;
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= DEFAULT_DESCRIPTION_LENGTH) return compact;
  return `${compact.slice(0, DEFAULT_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface SearchDocument {
  tool: ToolDef;
  name: string;
  description: string;
}

const searchDocuments = new WeakMap<ToolDef[], SearchDocument[]>();

function documentsFor(tools: ToolDef[]): SearchDocument[] {
  let docs = searchDocuments.get(tools);
  if (!docs) {
    docs = tools.map((tool) => ({
      tool,
      name: normalized(tool.name),
      description: normalized(tool.description ?? ""),
    }));
    searchDocuments.set(tools, docs);
  }
  return docs;
}

function scoreDocument(
  doc: SearchDocument,
  phrase: string,
  terms: string[],
): number | null {
  if (!phrase) return 0;
  const haystack = `${doc.name} ${doc.description}`;
  if (!terms.every((term) => haystack.includes(term))) return null;

  let score = 0;
  if (doc.name === phrase) score += 1_000;
  else if (doc.name.startsWith(phrase)) score += 800;
  else if (doc.name.includes(phrase)) score += 600;
  for (const term of terms) {
    if (doc.name === term) score += 200;
    else if (doc.name.startsWith(term)) score += 120;
    else if (doc.name.includes(term)) score += 80;
    if (doc.description.includes(term)) score += 10;
  }
  return score;
}

/** Rank a connector's tools while caching its normalized plain-data index. */
export function rankTools(
  tools: ToolDef[],
  query: string,
): Array<{ tool: ToolDef; score: number; order: number }> {
  const phrase = normalized(query);
  const terms = phrase.split(/\s+/).filter(Boolean);
  const ranked: Array<{ tool: ToolDef; score: number; order: number }> = [];
  documentsFor(tools).forEach((doc, order) => {
    const score = scoreDocument(doc, phrase, terms);
    if (score !== null) ranked.push({ tool: doc.tool, score, order });
  });
  return ranked;
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

/**
 * Whether a schema declares anything renderSchema knows how to render on its
 * own. Used to decide if the non-allOf half of a schema is worth rendering:
 * without this, a plain `{ allOf: [...] }` would render its (empty) local half
 * through the raw-JSON fallback and emit `{} & …`.
 */
function declaresShape(s: Record<string, unknown>): boolean {
  return (
    typeof s.$ref === "string" ||
    Array.isArray(s.oneOf) ||
    Array.isArray(s.anyOf) ||
    Array.isArray(s.enum) ||
    s.const !== undefined ||
    s.items !== undefined ||
    s.properties !== undefined ||
    s.type !== undefined
  );
}

/**
 * Parenthesize a top-level union so it doesn't read as part of a surrounding
 * `&`. Only separators outside braces count, so a nested union or a property
 * description containing a pipe doesn't trigger stray parentheses.
 */
function grouped(part: string): string {
  let nesting = 0;
  for (let i = 0; i < part.length; i += 1) {
    const char = part[i];
    if (char === "{" || char === "(" || char === "[") nesting += 1;
    else if (char === "}" || char === ")" || char === "]") nesting -= 1;
    else if (nesting === 0 && part.startsWith(" | ", i)) return `(${part})`;
  }
  return part;
}

function renderSchema(
  schema: unknown,
  defs: Record<string, unknown>,
  seen: Set<string>,
  depth: number,
): string {
  if (depth > 4) return "…";
  if (schema === null || typeof schema !== "object") {
    return JSON.stringify(schema);
  }
  const s = schema as Record<string, unknown>;

  // allOf composes rather than replaces: it is checked before every other
  // keyword, and renders the schema's own shape alongside its members instead
  // of returning early. A schema carrying both allOf and properties (the usual
  // OpenAPI-derived "extend this base" shape, and equally legal with $ref,
  // enum, const, or items) would otherwise silently drop whichever half lost
  // the branch race. The schema's own shape comes first, being the more
  // specific half, and is rendered at the current depth because its members
  // sit at this nesting level, not one below.
  if (Array.isArray(s.allOf)) {
    const { allOf: _members, ...own } = s;
    const parts = declaresShape(own)
      ? [renderSchema(own, defs, seen, depth)]
      : [];
    for (const member of s.allOf) {
      parts.push(renderSchema(member, defs, seen, depth + 1));
    }
    if (parts.length === 0) return "unknown";
    if (parts.length === 1) return parts[0] as string;
    return parts.map(grouped).join(" & ");
  }

  if (typeof s.$ref === "string") {
    const name = refName(s.$ref);
    if (seen.has(name)) return name;
    const target = defs[name];
    if (target === undefined) return name;
    seen.add(name);
    const rendered = renderSchema(target, defs, seen, depth);
    seen.delete(name);
    return rendered;
  }

  const union = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(union)) {
    return (
      union.map((u) => renderSchema(u, defs, seen, depth + 1)).join(" | ") ||
      "unknown"
    );
  }
  if (Array.isArray(s.enum)) {
    return s.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  // Checked before type/properties so a discriminator like
  // { type: "string", const: "emoji" } renders as "emoji" rather than string.
  // JSON.stringify(undefined) returns undefined (not a string), so an explicit
  // `const: undefined` must fall through to the regular type rendering.
  if (s.const !== undefined) return JSON.stringify(s.const);

  const type = s.type;
  if (type === "array" || s.items) {
    const items = s.items
      ? renderSchema(s.items, defs, seen, depth + 1)
      : "unknown";
    return `${items}[]`;
  }
  if (type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set(
      (Array.isArray(s.required) ? s.required : []) as string[],
    );
    const keys = Object.keys(props);
    if (keys.length === 0) return "{}";
    return `{ ${keys
      .map((key) => {
        const optional = required.has(key) ? "" : "?";
        const rendered = renderSchema(props[key], defs, seen, depth + 1);
        const description = (
          props[key] as Record<string, unknown> | null
        )?.description;
        const comment =
          typeof description === "string" ? ` // ${description}` : "";
        return `${key}${optional}: ${rendered}${comment}`;
      })
      .join(", ")} }`;
  }
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.join(" | ");
  return JSON.stringify(schema);
}

const compactSchemas = new WeakMap<JsonSchema, string>();

/** Render and cache a compact TypeScript-like representation of JSON Schema. */
export function compactSchema(schema: JsonSchema): string {
  const cached = compactSchemas.get(schema);
  if (cached) return cached;
  const defs = {
    ...((schema.$defs as Record<string, unknown>) ?? {}),
    ...((schema.definitions as Record<string, unknown>) ?? {}),
  };
  let rendered: string;
  try {
    rendered = renderSchema(schema, defs, new Set(), 0);
  } catch {
    rendered = JSON.stringify(schema);
  }
  compactSchemas.set(schema, rendered);
  return rendered;
}
