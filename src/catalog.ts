import type { JsonSchema, ToolDef } from "./types.js";

const DEFAULT_DESCRIPTION_LENGTH = 240;
const DISCOVERY_DESCRIPTION_LENGTH = 160;
export const MAX_COMPACT_DISCOVERY_SCHEMA_BYTES = 1_024;
const MAX_COMPACT_DISCOVERY_ENUM_BYTES =
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES / 4;
const MAX_COMPACT_DISCOVERY_CONSTRAINT_BYTES =
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES / 4;
const schemaEncoder = new TextEncoder();
const COMPACT_DISCOVERY_TRUNCATION = " /* truncated */";

export function summarizeDescription(
  text: string | undefined,
  full: boolean,
): string | undefined {
  return summarizeToLength(text, full, DEFAULT_DESCRIPTION_LENGTH);
}

export function summarizeDiscoveryDescription(
  text: string | undefined,
  full: boolean,
): string | undefined {
  return summarizeToLength(text, full, DISCOVERY_DESCRIPTION_LENGTH);
}

function summarizeToLength(
  text: string | undefined,
  full: boolean,
  maxLength: number,
): string | undefined {
  if (!text) return undefined;
  if (full) return text;
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
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

/** Distinct normalized terms in query order, shared by ranking and feedback. */
export function lexicalQueryTerms(query: string): string[] {
  return [...new Set(lexicalTokens(query))];
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

interface SearchIndex {
  documents: SearchDocument[];
  nameTokenDocuments: ReadonlyMap<string, readonly ToolDef[]>;
  descriptionTokenDocuments: ReadonlyMap<string, readonly ToolDef[]>;
}

export type LexicalMatchMode = "all" | "partial";

export interface RankedTool {
  tool: ToolDef;
  score: number;
  order: number;
  exactName: boolean;
  matchedTermCount: number;
}

const searchIndexes = new WeakMap<ToolDef[], SearchIndex>();

function indexFor(tools: ToolDef[]): SearchIndex {
  let index = searchIndexes.get(tools);
  if (!index) {
    const nameTokenDocuments = new Map<string, ToolDef[]>();
    const descriptionTokenDocuments = new Map<string, ToolDef[]>();
    const addTokens = (
      target: Map<string, ToolDef[]>,
      tokens: string[],
      tool: ToolDef,
    ) => {
      for (const token of new Set(tokens)) {
        const documents = target.get(token) ?? [];
        documents.push(tool);
        target.set(token, documents);
      }
    };
    const documents = tools.map((tool) => {
      const nameTokens = lexicalTokens(tool.name);
      const descriptionTokens = lexicalTokens(tool.description ?? "");
      addTokens(nameTokenDocuments, nameTokens, tool);
      addTokens(descriptionTokenDocuments, descriptionTokens, tool);
      return {
        tool,
        name: nameTokens.join(" "),
        nameTokens,
        descriptionTokens,
      };
    });
    index = {
      documents,
      nameTokenDocuments,
      descriptionTokenDocuments,
    };
    searchIndexes.set(tools, index);
  }
  return index;
}

function documentsFor(tools: ToolDef[]): SearchDocument[] {
  return indexFor(tools).documents;
}

/**
 * Whole-token equality is the ordinary lexical match. A deliberately narrow
 * inflection check retains useful singular/plural and past-tense recall
 * without bringing back arbitrary substring matches (`list` must not match
 * `enlist`, and `record` must not match the noun `recording`).
 */
function inflectionVariants(base: string): string[] {
  return [
    `${base}s`,
    `${base}es`,
    `${base}ed`,
    ...(base.endsWith("e") ? [`${base}d`] : []),
    ...(base.endsWith("y")
      ? [
          `${base.slice(0, -1)}ies`,
          `${base.slice(0, -1)}ied`,
        ]
      : []),
  ];
}

function matchingTokenCandidates(term: string): Set<string> {
  const candidates = new Set([term, ...inflectionVariants(term)]);
  const possibleBases = [
    ...(term.endsWith("s") ? [term.slice(0, -1)] : []),
    ...(term.endsWith("es") ? [term.slice(0, -2)] : []),
    ...(term.endsWith("ed") ? [term.slice(0, -2)] : []),
    ...(term.endsWith("d") ? [term.slice(0, -1)] : []),
    ...(term.endsWith("ies")
      ? [`${term.slice(0, -3)}y`]
      : []),
    ...(term.endsWith("ied")
      ? [`${term.slice(0, -3)}y`]
      : []),
  ];
  for (const base of possibleBases) {
    if (base && inflectionVariants(base).includes(term)) {
      candidates.add(base);
    }
  }
  return candidates;
}

/**
 * Whether one query term matches a whole token of arbitrary text, under the
 * same inflection rules the tool index uses.
 *
 * Connector identity — an `id` or a `title` — is deliberately not a document in
 * that index: making it one would move ranking for every query that already
 * matches tools. This lets a caller ask the index's question of a string that
 * never became a document, which is what the no-match analysis needs to tell
 * "nothing like this exists here" from "that word is a connector".
 */
export function matchesLexicalTerm(text: string, term: string): boolean {
  const tokens = new Set(lexicalTokens(text));
  if (tokens.size === 0) return false;
  for (const candidate of matchingTokenCandidates(term)) {
    if (tokens.has(candidate)) return true;
  }
  return false;
}

export interface LexicalCorpusStatistics {
  documentCount: number;
  documentFrequency: ReadonlyMap<string, number>;
  nameMatches: ReadonlyMap<string, ReadonlySet<ToolDef>>;
  descriptionMatches: ReadonlyMap<string, ReadonlySet<ToolDef>>;
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
  const terms = lexicalQueryTerms(query);
  if (terms.length === 0) {
    return {
      documentCount: toolSets.reduce(
        (total, tools) => total + tools.length,
        0,
      ),
      documentFrequency: new Map(),
      nameMatches: new Map(),
      descriptionMatches: new Map(),
    };
  }
  const nameMatches = new Map<string, Set<ToolDef>>();
  const descriptionMatches = new Map<string, Set<ToolDef>>();
  for (const term of terms) {
    const termNameMatches = new Set<ToolDef>();
    const termDescriptionMatches = new Set<ToolDef>();
    for (const tools of toolSets) {
      const index = indexFor(tools);
      for (const candidate of matchingTokenCandidates(term)) {
        for (const tool of index.nameTokenDocuments.get(candidate) ?? []) {
          termNameMatches.add(tool);
        }
        for (
          const tool of
          index.descriptionTokenDocuments.get(candidate) ?? []
        ) {
          termDescriptionMatches.add(tool);
        }
      }
    }
    nameMatches.set(term, termNameMatches);
    descriptionMatches.set(term, termDescriptionMatches);
  }
  const documentFrequency = new Map(
    terms.map((term) => [
      term,
      new Set([
        ...(nameMatches.get(term) ?? []),
        ...(descriptionMatches.get(term) ?? []),
      ]).size,
    ]),
  );
  return {
    documentCount: toolSets.reduce(
      (total, tools) => total + tools.length,
      0,
    ),
    documentFrequency,
    nameMatches,
    descriptionMatches,
  };
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
): { score: number; matchedTermCount: number } | null {
  if (!phrase) return { score: 0, matchedTermCount: 0 };
  const matchedTerms = terms.filter((term) =>
    statistics.nameMatches.get(term)?.has(doc.tool) ||
    statistics.descriptionMatches.get(term)?.has(doc.tool),
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
    else if (statistics.nameMatches.get(term)?.has(doc.tool)) {
      score += 8 * weight;
    }
    if (doc.descriptionTokens.includes(term)) score += 3 * weight;
    else if (statistics.descriptionMatches.get(term)?.has(doc.tool)) {
      score += 1.5 * weight;
    }
  }
  return { score, matchedTermCount: matchedTerms.length };
}

function queryContainsExactName(doc: SearchDocument, phrase: string): boolean {
  if (!doc.name || !phrase) return false;
  return (` ${phrase} `).includes(` ${doc.name} `);
}

/**
 * Rank a connector's tools while caching its normalized plain-data index.
 * `exactNameQuery` may retain framing removed from the scoring query: those
 * words are weak term evidence, but remain part of a real tool-name phrase.
 */
export function rankTools(
  tools: ToolDef[],
  query: string,
  mode: LexicalMatchMode = "all",
  statistics: LexicalCorpusStatistics = lexicalCorpusStatistics(
    [tools],
    query,
  ),
  exactNameQuery: string = query,
): RankedTool[] {
  const phrase = normalized(query);
  const exactNamePhrase = normalized(exactNameQuery);
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  const ranked: RankedTool[] = [];
  documentsFor(tools).forEach((doc, order) => {
    const scored = scoreDocument(doc, phrase, terms, mode, statistics);
    if (scored !== null) {
      ranked.push({
        tool: doc.tool,
        score: scored.score,
        order,
        exactName: queryContainsExactName(doc, exactNamePhrase),
        matchedTermCount: scored.matchedTermCount,
      });
    }
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
    s.type !== undefined ||
    constraintEntries(s).length > 0
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

function renderEnum(
  values: unknown[],
  byteLimit: number | undefined,
  onTruncated: (() => void) | undefined,
): string {
  if (values.length === 0) return "never";
  const renderedValues = values.map((value) => JSON.stringify(value));
  const full = renderedValues.join(" | ");
  if (
    byteLimit === undefined ||
    schemaEncoder.encode(full).length <= byteLimit
  ) {
    return full;
  }

  onTruncated?.();
  const marker = (omitted: number) =>
    `unknown /* ${omitted} enum ${omitted === 1 ? "value" : "values"} omitted */`;
  let rendered = `(${marker(values.length)})`;
  const prefix: string[] = [];
  for (let index = 0; index < renderedValues.length - 1; index += 1) {
    prefix.push(renderedValues[index] as string);
    const omitted = renderedValues.length - prefix.length;
    const candidate = `(${prefix.join(" | ")} | ${marker(omitted)})`;
    if (schemaEncoder.encode(candidate).length > byteLimit) break;
    rendered = candidate;
  }
  return rendered;
}

function safeConstraintValue(value: string): string {
  return JSON.stringify(value).replaceAll("*/", "*\\/");
}

function constraintEntries(schema: Record<string, unknown>): string[] {
  const entries: string[] = [];
  const number = (keyword: string, label: string) => {
    const value = schema[keyword];
    if (typeof value === "number" && Number.isFinite(value)) {
      entries.push(`${label} ${value}`);
    }
  };
  const integer = (keyword: string, label: string) => {
    const value = schema[keyword];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      entries.push(`${label} ${value}`);
    }
  };

  number("minimum", ">=");
  number("exclusiveMinimum", ">");
  number("maximum", "<=");
  number("exclusiveMaximum", "<");
  number("multipleOf", "multiple of");
  integer("minLength", "length >=");
  integer("maxLength", "length <=");
  if (typeof schema.format === "string") {
    entries.push(`format ${safeConstraintValue(schema.format)}`);
  }
  if (typeof schema.pattern === "string") {
    entries.push(`pattern ${safeConstraintValue(schema.pattern)}`);
  }
  return entries;
}

function renderConstraints(
  base: string,
  schema: Record<string, unknown>,
  byteLimit: number | undefined,
  onTruncated: (() => void) | undefined,
): string {
  const entries = constraintEntries(schema);
  if (entries.length === 0) return base;

  const kept: string[] = [];
  for (const entry of entries) {
    const candidate = ` /* ${[...kept, entry].join("; ")} */`;
    if (
      byteLimit !== undefined &&
      schemaEncoder.encode(candidate).length > byteLimit
    ) {
      onTruncated?.();
      continue;
    }
    kept.push(entry);
  }
  return kept.length === 0
    ? base
    : `${grouped(base)} /* ${kept.join("; ")} */`;
}

function renderSchema(
  schema: unknown,
  defs: Record<string, unknown>,
  seen: Set<string>,
  depth: number,
  options: {
    propertyDescriptions: boolean;
    requiredFirst: boolean;
    enumByteLimit?: number;
    onEnumTruncated?: () => void;
    renderConstraints: boolean;
    constraintByteLimit?: number;
    onConstraintTruncated?: () => void;
  },
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
      ? [renderSchema(own, defs, seen, depth, options)]
      : [];
    for (const member of s.allOf) {
      parts.push(renderSchema(member, defs, seen, depth + 1, options));
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
    const rendered = renderSchema(target, defs, seen, depth, options);
    seen.delete(name);
    return options.renderConstraints
      ? renderConstraints(
          rendered,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : rendered;
  }

  const union = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(union)) {
    const rendered =
      union
        .map((u) => renderSchema(u, defs, seen, depth + 1, options))
        .join(" | ") ||
      "unknown";
    return options.renderConstraints
      ? renderConstraints(
          rendered,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : rendered;
  }
  if (Array.isArray(s.enum)) {
    const rendered = renderEnum(
      s.enum,
      options.enumByteLimit,
      options.onEnumTruncated,
    );
    return options.renderConstraints
      ? renderConstraints(
          rendered,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : rendered;
  }
  // Checked before type/properties so a discriminator like
  // { type: "string", const: "emoji" } renders as "emoji" rather than string.
  // JSON.stringify(undefined) returns undefined (not a string), so an explicit
  // `const: undefined` must fall through to the regular type rendering.
  if (s.const !== undefined) {
    const rendered = JSON.stringify(s.const);
    return options.renderConstraints
      ? renderConstraints(
          rendered,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : rendered;
  }

  const type = s.type;
  if (type === "array" || s.items) {
    const items = s.items
      ? renderSchema(s.items, defs, seen, depth + 1, options)
      : "unknown";
    return `${items}[]`;
  }
  if (type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set(
      (Array.isArray(s.required) ? s.required : []) as string[],
    );
    const declaredKeys = Object.keys(props);
    const keys = options.requiredFirst
      ? [
          ...declaredKeys.filter((key) => required.has(key)),
          ...declaredKeys.filter((key) => !required.has(key)),
        ]
      : declaredKeys;
    if (keys.length === 0) return "{}";
    return `{ ${keys
      .map((key) => {
        const optional = required.has(key) ? "" : "?";
        const rendered = renderSchema(
          props[key],
          defs,
          seen,
          depth + 1,
          options,
        );
        const description = (
          props[key] as Record<string, unknown> | null
        )?.description;
        const comment =
          options.propertyDescriptions && typeof description === "string"
            ? ` // ${description}`
            : "";
        return `${key}${optional}: ${rendered}${comment}`;
      })
      .join(", ")} }`;
  }
  if (typeof type === "string") {
    return options.renderConstraints
      ? renderConstraints(
          type,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : type;
  }
  if (Array.isArray(type)) {
    const rendered = type.join(" | ");
    return options.renderConstraints
      ? renderConstraints(
          rendered,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : rendered;
  }
  if (options.renderConstraints && constraintEntries(s).length > 0) {
    return renderConstraints(
      "unknown",
      s,
      options.constraintByteLimit,
      options.onConstraintTruncated,
    );
  }
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
    rendered = renderSchema(schema, defs, new Set(), 0, {
      propertyDescriptions: true,
      requiredFirst: false,
      renderConstraints: true,
    });
  } catch {
    rendered = JSON.stringify(schema);
  }
  compactSchemas.set(schema, rendered);
  return rendered;
}

export interface CompactDiscoverySchema {
  text: string;
  truncated: boolean;
}

const compactDiscoverySchemas = new WeakMap<
  JsonSchema,
  CompactDiscoverySchema
>();

/**
 * A valid, bounded replacement for a discovery shape too large to carry.
 *
 * Required object keys come first and every retained key is JSON-quoted, so
 * arbitrary downstream names remain valid TypeScript property signatures.
 * Types become `unknown`: pretending a severed nested type is exact would be
 * worse than making the existing truncation flag's recovery route explicit.
 */
function truncatedDiscoverySchema(schema: JsonSchema): string {
  const keys = schemaObjectKeys(schema);
  if (!keys) return `unknown${COMPACT_DISCOVERY_TRUNCATION}`;
  const required = new Set(keys.required);
  const ordered = [
    ...keys.properties.filter((key) => required.has(key)),
    ...keys.properties.filter((key) => !required.has(key)),
  ];
  const parts: string[] = [];
  for (const key of ordered) {
    const part = `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: unknown`;
    const candidate = `{ ${[...parts, part].join(", ")} }${COMPACT_DISCOVERY_TRUNCATION}`;
    if (
      schemaEncoder.encode(candidate).length >
      MAX_COMPACT_DISCOVERY_SCHEMA_BYTES
    ) {
      break;
    }
    parts.push(part);
  }
  if (parts.length === 0 && ordered.length > 0) {
    return `unknown${COMPACT_DISCOVERY_TRUNCATION}`;
  }
  return `{ ${parts.join(", ")} }${COMPACT_DISCOVERY_TRUNCATION}`;
}

/**
 * Render the schema shape carried by search results.
 *
 * Search is a routing step, so repeated property prose does not earn its
 * context cost there. Required inputs render first, and the result has a hard
 * UTF-8 budget; exact JSON and the prose-rich compact rendering remain
 * available through the existing full retrieval paths.
 */
export function compactDiscoverySchema(
  schema: JsonSchema,
): CompactDiscoverySchema {
  const cached = compactDiscoverySchemas.get(schema);
  if (cached) return cached;
  const defs = {
    ...(schema.$defs as Record<string, unknown>),
    ...(schema.definitions as Record<string, unknown>),
  };
  let rendered: string;
  let enumTruncated = false;
  let constraintTruncated = false;
  try {
    rendered = renderSchema(schema, defs, new Set(), 0, {
      propertyDescriptions: false,
      requiredFirst: true,
      // Three near-cap enums spend about three quarters of the complete shape
      // budget, leaving the final quarter for surrounding syntax before the
      // unchanged global fallback applies. Whole values keep this UTF-8 safe.
      enumByteLimit: MAX_COMPACT_DISCOVERY_ENUM_BYTES,
      onEnumTruncated: () => {
        enumTruncated = true;
      },
      renderConstraints: true,
      constraintByteLimit: MAX_COMPACT_DISCOVERY_CONSTRAINT_BYTES,
      onConstraintTruncated: () => {
        constraintTruncated = true;
      },
    });
  } catch {
    rendered = JSON.stringify(schema);
  }
  if (
    schemaEncoder.encode(rendered).length >
    MAX_COMPACT_DISCOVERY_SCHEMA_BYTES
  ) {
    try {
      rendered = renderSchema(schema, defs, new Set(), 0, {
        propertyDescriptions: false,
        requiredFirst: true,
        enumByteLimit: MAX_COMPACT_DISCOVERY_ENUM_BYTES,
        onEnumTruncated: () => {
          enumTruncated = true;
        },
        renderConstraints: false,
      });
      constraintTruncated = true;
    } catch {
      rendered = JSON.stringify(schema);
    }
  }
  const bytes = schemaEncoder.encode(rendered);
  let result: CompactDiscoverySchema;
  if (bytes.length <= MAX_COMPACT_DISCOVERY_SCHEMA_BYTES) {
    result = {
      text: rendered,
      truncated: enumTruncated || constraintTruncated,
    };
  } else {
    result = {
      text: truncatedDiscoverySchema(schema),
      truncated: true,
    };
  }
  compactDiscoverySchemas.set(schema, result);
  return result;
}

/** The property and required names a schema resolves to, or undefined. */
export interface SchemaObjectKeys {
  properties: string[];
  required: string[];
}

/**
 * Walk a schema the way renderSchema does — composing `allOf` and resolving
 * `$ref` against the root's `$defs`/`definitions` — and collect the top-level
 * property names it would render. A shallow `Object.keys(schema.properties)`
 * disagrees with the rendered compact schema for exactly the shapes real
 * connectors emit (a top-level `$ref` to a `$defs` entry, or the OpenAPI
 * "extend this base" `allOf`), which is worse than no metadata at all: it
 * reports an empty field list for a tool that plainly has fields.
 *
 * Returns undefined when the schema is not an object shape at all — a union,
 * array, enum, or unresolvable `$ref`. Absent metadata tells a caller to read
 * the rendered schema instead; an empty array would claim the tool takes no
 * fields.
 */
export function schemaObjectKeys(
  schema: JsonSchema | undefined,
): SchemaObjectKeys | undefined {
  if (!schema) return undefined;
  const defs = {
    ...(schema.$defs as Record<string, unknown>),
    ...(schema.definitions as Record<string, unknown>),
  };
  try {
    return objectKeys(schema, defs, new Set(), 0);
  } catch {
    return undefined;
  }
}

/** Merge in declaration order, first occurrence winning, as renderSchema renders. */
function mergedKeys(
  parts: readonly SchemaObjectKeys[],
): SchemaObjectKeys | undefined {
  if (parts.length === 0) return undefined;
  return {
    properties: [...new Set(parts.flatMap((part) => part.properties))],
    required: [...new Set(parts.flatMap((part) => part.required))],
  };
}

/** The key-collecting twin of renderSchema; the branch order must match it. */
function objectKeys(
  schema: unknown,
  defs: Record<string, unknown>,
  seen: Set<string>,
  depth: number,
): SchemaObjectKeys | undefined {
  if (depth > 4) return undefined;
  if (schema === null || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.allOf)) {
    const { allOf: _members, ...own } = s;
    const parts = declaresShape(own)
      ? [objectKeys(own, defs, seen, depth)]
      : [];
    for (const member of s.allOf) {
      parts.push(objectKeys(member, defs, seen, depth + 1));
    }
    // An allOf whose members are not all object shapes renders as an
    // intersection with a non-object half; no single key list describes it.
    return parts.every((part) => part !== undefined)
      ? mergedKeys(parts as SchemaObjectKeys[])
      : undefined;
  }

  if (typeof s.$ref === "string") {
    const name = refName(s.$ref);
    if (seen.has(name)) return undefined;
    const target = defs[name];
    if (target === undefined) return undefined;
    seen.add(name);
    const resolved = objectKeys(target, defs, seen, depth);
    seen.delete(name);
    return resolved;
  }

  if (Array.isArray(s.oneOf ?? s.anyOf)) return undefined;
  if (Array.isArray(s.enum)) return undefined;
  if (s.const !== undefined) return undefined;
  if (s.type === "array" || s.items) return undefined;
  if (s.type === "object" || s.properties) {
    const props = s.properties;
    if (props === null || Array.isArray(props) || typeof props !== "object") {
      return { properties: [], required: [] };
    }
    return {
      properties: Object.keys(props as Record<string, unknown>),
      required: Array.isArray(s.required)
        ? s.required.filter((key): key is string => typeof key === "string")
        : [],
    };
  }
  return undefined;
}
