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

function lexicalTokens(text: string): string[] {
  return text
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalized(text: string): string {
  return lexicalTokens(text).join(" ");
}

/**
 * Conversational framing selected by the #188 research run before the #189
 * holdout existed. Action-bearing terms such as get/list/search/find/create
 * deliberately remain: arbitrary connector catalogs need those distinctions.
 */
const CONVERSATIONAL_QUERY_WORDS = new Set([
  "a",
  "all",
  "an",
  "and",
  "are",
  "can",
  "could",
  "current",
  "for",
  "from",
  "i",
  "in",
  "into",
  "it",
  "latest",
  "let",
  "me",
  "most",
  "of",
  "on",
  "our",
  "please",
  "right",
  "show",
  "that",
  "the",
  "this",
  "to",
  "up",
  "want",
  "when",
  "which",
  "with",
  "you",
]);

/**
 * Remove conversational framing before the all-term/partial decision. If
 * every term is framing, retain the original query rather than turning a
 * search into an unfiltered catalog browse.
 */
export function lexicalSearchQuery(query: string): string {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  const contentTerms = terms.filter(
    (term) => !CONVERSATIONAL_QUERY_WORDS.has(term),
  );
  return contentTerms.length > 0 ? contentTerms.join(" ") : query;
}

interface SearchDocument {
  tool: ToolDef;
  name: string;
  nameTokens: string[];
  descriptionTokens: string[];
}

export type LexicalMatchMode = "all" | "partial";

export interface RankedTool {
  tool: ToolDef;
  score: number;
  order: number;
}

const searchDocuments = new WeakMap<ToolDef[], SearchDocument[]>();

function documentsFor(tools: ToolDef[]): SearchDocument[] {
  let docs = searchDocuments.get(tools);
  if (!docs) {
    docs = tools.map((tool) => {
      const nameTokens = lexicalTokens(tool.name);
      const descriptionTokens = lexicalTokens(tool.description ?? "");
      return {
        tool,
        name: nameTokens.join(" "),
        nameTokens,
        descriptionTokens,
      };
    });
    searchDocuments.set(tools, docs);
  }
  return docs;
}

/**
 * Whole-token equality is the ordinary lexical match. A deliberately narrow
 * inflection check retains useful singular/plural and past-tense recall
 * without bringing back arbitrary substring matches (`list` must not match
 * `enlist`, and `record` must not match the noun `recording`).
 */
function tokenMatches(token: string, term: string): boolean {
  if (token === term) return true;
  const variants = (base: string, candidate: string) =>
    candidate === `${base}s` ||
    candidate === `${base}es` ||
    candidate === `${base}ed` ||
    (base.endsWith("e") &&
      candidate === `${base}d`) ||
    (base.endsWith("y") &&
      (candidate === `${base.slice(0, -1)}ies` ||
        candidate === `${base.slice(0, -1)}ied`));
  return variants(term, token) || variants(token, term);
}

function documentMatchesTerm(doc: SearchDocument, term: string): boolean {
  return (
    doc.nameTokens.some((token) => tokenMatches(token, term)) ||
    doc.descriptionTokens.some((token) => tokenMatches(token, term))
  );
}

export interface LexicalCorpusStatistics {
  documentCount: number;
  documentFrequency: ReadonlyMap<string, number>;
}

/**
 * Compute query-specific document frequencies across every available catalog.
 * The caller does this once per search and shares the result with each
 * connector rank, so ubiquitous words contribute less than discriminative
 * ones without making any action word a stopword.
 */
export function lexicalCorpusStatistics(
  toolSets: ToolDef[][],
  query: string,
): LexicalCorpusStatistics {
  const terms = [...new Set(lexicalTokens(query))];
  if (terms.length === 0) {
    return {
      documentCount: toolSets.reduce(
        (total, tools) => total + tools.length,
        0,
      ),
      documentFrequency: new Map(),
    };
  }
  const documentFrequency = new Map(terms.map((term) => [term, 0]));
  let documentCount = 0;

  for (const tools of toolSets) {
    for (const doc of documentsFor(tools)) {
      documentCount += 1;
      for (const term of terms) {
        if (documentMatchesTerm(doc, term)) {
          documentFrequency.set(
            term,
            (documentFrequency.get(term) ?? 0) + 1,
          );
        }
      }
    }
  }
  return { documentCount, documentFrequency };
}

function inverseDocumentFrequency(
  term: string,
  statistics: LexicalCorpusStatistics,
): number {
  const frequency = statistics.documentFrequency.get(term) ?? 0;
  return Math.log(
    1 +
      (statistics.documentCount - frequency + 0.5) /
        (frequency + 0.5),
  );
}

function scoreDocument(
  doc: SearchDocument,
  phrase: string,
  terms: string[],
  mode: LexicalMatchMode,
  statistics: LexicalCorpusStatistics,
): number | null {
  if (!phrase) return 0;
  const matchedTerms = terms.filter((term) =>
    documentMatchesTerm(doc, term),
  );
  if (mode === "all" && matchedTerms.length !== terms.length) return null;
  if (matchedTerms.length === 0) return null;

  // Coverage remains meaningful in partial mode, but is IDF-weighted rather
  // than a raw term count: one rare domain term can beat several ubiquitous
  // catalog verbs.
  let score = matchedTerms.reduce(
    (total, term) =>
      total + 4 * inverseDocumentFrequency(term, statistics),
    0,
  );
  const phraseWeight = terms.reduce(
    (total, term) =>
      total + inverseDocumentFrequency(term, statistics),
    0,
  );
  if (doc.name === phrase) score += 40 * phraseWeight;
  else if (doc.name.startsWith(`${phrase} `)) score += 24 * phraseWeight;
  else if (` ${doc.name} `.includes(` ${phrase} `)) {
    score += 16 * phraseWeight;
  }

  for (const term of matchedTerms) {
    const weight = inverseDocumentFrequency(term, statistics);
    if (doc.nameTokens.includes(term)) score += 12 * weight;
    else if (doc.nameTokens.some((token) => tokenMatches(token, term))) {
      score += 8 * weight;
    }
    if (doc.descriptionTokens.includes(term)) score += 3 * weight;
    else if (
      doc.descriptionTokens.some((token) => tokenMatches(token, term))
    ) {
      score += 1.5 * weight;
    }
  }
  return score;
}

/** Rank a connector's tools while caching its normalized plain-data index. */
export function rankTools(
  tools: ToolDef[],
  query: string,
  mode: LexicalMatchMode = "all",
  statistics: LexicalCorpusStatistics = lexicalCorpusStatistics(
    [tools],
    query,
  ),
): RankedTool[] {
  const phrase = normalized(query);
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  const ranked: RankedTool[] = [];
  documentsFor(tools).forEach((doc, order) => {
    const score = scoreDocument(doc, phrase, terms, mode, statistics);
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
    ...(schema.$defs as Record<string, unknown>),
    ...(schema.definitions as Record<string, unknown>),
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
