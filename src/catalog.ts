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
  if (Array.isArray(s.allOf)) {
    return (
      s.allOf.map((a) => renderSchema(a, defs, seen, depth + 1)).join(" & ") ||
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
