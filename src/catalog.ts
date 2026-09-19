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
const MAX_COMPACT_DESCRIPTION_SCHEMA_BYTES = 8_192;
const MAX_SCHEMA_WORK = 2_000;
const schemaWorkExceeded = Symbol("schema work budget exceeded");
const schemaSizeExceeded = Symbol("schema byte budget exceeded");

class SchemaWork {
  private remaining = MAX_SCHEMA_WORK;
  truncated = false;
  readonly refs = new Map<string, string>();

  constructor(readonly byteLimit = MAX_COMPACT_DISCOVERY_SCHEMA_BYTES) {}

  visit(): void {
    if (this.remaining-- <= 0) throw schemaWorkExceeded;
  }

  text(value: string): string {
    // Check code units first so encoding a hostile scalar is itself bounded.
    if (
      value.length > this.byteLimit ||
      schemaEncoder.encode(value).length > this.byteLimit
    ) {
      throw schemaSizeExceeded;
    }
    return value;
  }

  json(value: unknown): string {
    // The raw-JSON fallback and const/enum values must spend the same work
    // budget as schema nodes, including values nested inside unknown keywords.
    const visit = this.visit.bind(this);
    const text = this.text.bind(this);
    const ancestors: object[] = [];
    let serializedBytes = 0;
    const addSerialized = (value: string): void => {
      serializedBytes += schemaEncoder.encode(value).length;
      if (serializedBytes > this.byteLimit) throw schemaSizeExceeded;
    };
    return this.text(JSON.stringify(value, function (key, item: unknown) {
      visit();
      text(key);
      if (typeof item === "string") text(item);
      const omitted =
        item === undefined || typeof item === "function" || typeof item === "symbol";
      const root = key === "" && ancestors.length === 0;
      if (!omitted) {
        // Array indexes are implicit in JSON. Object keys and primitive values
        // are the useful lower bound; the final text check remains authoritative
        // for braces, commas, and values whose encoding is larger than this bound.
        if (!root && !Array.isArray(this)) addSerialized(JSON.stringify(key));
        if (typeof item !== "object" || item === null) {
          addSerialized(JSON.stringify(item));
        }
      }
      if (item !== null && typeof item === "object") {
        while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop();
        }
        if (ancestors.length > 32) throw schemaWorkExceeded;
        ancestors.push(item);
      }
      return item;
    }));
  }
}

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
  indexFor(tools).documents.forEach((doc, order) => {
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
    typeof s.$dynamicRef === "string" ||
    Array.isArray(s.allOf) ||
    Array.isArray(s.prefixItems) ||
    s.dependentSchemas !== undefined ||
    s.if !== undefined ||
    s.then !== undefined ||
    s.else !== undefined ||
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
  work: SchemaWork,
  byteLimit: number | undefined,
  onTruncated: (() => void) | undefined,
): string {
  if (values.length === 0) return "never";
  const limit = byteLimit ?? MAX_COMPACT_DISCOVERY_ENUM_BYTES;
  const marker = (omitted: number) =>
    `unknown /* ${omitted} enum ${omitted === 1 ? "value" : "values"} omitted */`;
  let rendered = `(${marker(values.length)})`;
  const prefix: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    let value: string;
    try {
      value = work.json(values[index]);
    } catch (error) {
      if (error !== schemaSizeExceeded) throw error;
      break;
    }
    prefix.push(value);
    const full = prefix.join(" | ");
    if (schemaEncoder.encode(full).length > limit) break;
    if (index === values.length - 1) return full;
    const omitted = values.length - prefix.length;
    const candidate = `(${full} | ${marker(omitted)})`;
    if (schemaEncoder.encode(candidate).length <= limit) rendered = candidate;
  }
  onTruncated?.();
  return rendered;
}

function safeConstraintValue(value: string): string {
  if (value.length > MAX_COMPACT_DESCRIPTION_SCHEMA_BYTES) {
    // This placeholder only participates in the byte check and is dropped whole.
    return "x".repeat(MAX_COMPACT_DESCRIPTION_SCHEMA_BYTES + 1);
  }
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

interface RenderOptions {
  work: SchemaWork;
  propertyDescriptions: boolean;
  requiredFirst: boolean;
  enumByteLimit?: number;
  onEnumTruncated?: () => void;
  renderConstraints: boolean;
  constraintByteLimit?: number;
  onConstraintTruncated?: () => void;
}

function boundedParts(
  work: SchemaWork,
  separator: string,
  prefix: string,
  suffix: string,
): { add(part: string): void; finish(): string; readonly length: number } {
  // Check each addition before joining so a rejected schema never creates a
  // large intermediate string just to discover that the final result is over.
  const parts: string[] = [];
  let bytes =
    schemaEncoder.encode(prefix).length + schemaEncoder.encode(suffix).length;
  const separatorBytes = schemaEncoder.encode(separator).length;
  return {
    get length() {
      return parts.length;
    },
    add(part) {
      const partBytes = schemaEncoder.encode(part).length;
      const added = partBytes + (parts.length > 0 ? separatorBytes : 0);
      if (bytes + added > work.byteLimit) throw schemaSizeExceeded;
      parts.push(part);
      bytes += added;
    },
    finish() {
      return `${prefix}${parts.join(separator)}${suffix}`;
    },
  };
}

function renderSchema(
  schema: unknown,
  defs: JsonSchema,
  seen: Set<string>,
  depth: number,
  options: RenderOptions,
): string {
  options.work.visit();
  return options.work.text(renderSchemaNode(schema, defs, seen, depth, options));
}

function renderSchemaNode(
  schema: unknown,
  defs: JsonSchema,
  seen: Set<string>,
  depth: number,
  options: RenderOptions,
): string {
  if (depth > 4) return "…";
  if (schema === null || typeof schema !== "object") {
    return options.work.json(schema);
  }
  const s = schema as Record<string, unknown>;
  const constrain = (rendered: string) =>
    options.renderConstraints
      ? renderConstraints(
          rendered,
          s,
          options.constraintByteLimit,
          options.onConstraintTruncated,
        )
      : rendered;

  // Conditions cannot be expressed by a single static shape. Preserve the
  // base and send callers to the exact schema instead of hiding the rules.
  if (
    s.dependentSchemas !== undefined || s.if !== undefined ||
    s.then !== undefined || s.else !== undefined
  ) {
    options.work.truncated = true;
    const base: Record<string, unknown> = Object.create(null);
    for (const key of propertyNames(s, options.work)) {
      if (!["dependentSchemas", "if", "then", "else"].includes(key)) base[key] = s[key];
    }
    const rendered = declaresShape(base)
      ? renderSchema(base, defs, seen, depth, options)
      : "unknown";
    return `${rendered} /* conditional */`;
  }

  // allOf composes rather than replaces: it is checked before every other
  // shape keyword, and renders the schema's own shape alongside its members instead
  // of returning early. A schema carrying both allOf and properties (the usual
  // OpenAPI-derived "extend this base" shape, and equally legal with $ref,
  // enum, const, or items) would otherwise silently drop whichever half lost
  // the branch race. The schema's own shape comes first, being the more
  // specific half, and is rendered at the current depth because its members
  // sit at this nesting level, not one below.
  if (Array.isArray(s.allOf)) {
    const own: Record<string, unknown> = Object.create(null);
    for (const key of propertyNames(s, options.work)) {
      if (key !== "allOf") own[key] = s[key];
    }
    const parts = boundedParts(options.work, " & ", "", "");
    const groupParts = declaresShape(own)
      ? s.allOf.length > 0
      : s.allOf.length > 1;
    if (declaresShape(own)) {
      const rendered = renderSchema(own, defs, seen, depth, options);
      parts.add(groupParts ? grouped(rendered) : rendered);
    }
    for (const member of s.allOf) {
      const rendered = renderSchema(member, defs, seen, depth + 1, options);
      parts.add(groupParts ? grouped(rendered) : rendered);
    }
    if (parts.length === 0) return "unknown";
    return parts.finish();
  }

  const reference = s.$ref ?? s.$dynamicRef;
  if (typeof reference === "string") {
    const dynamic = s.$ref === undefined;
    const rawName = refName(options.work.text(reference));
    const name = dynamic ? rawName.replace(/^#/, "") : rawName;
    if (seen.has(name)) return name;
    const target = resolveDefinition(defs, name);
    if (target === undefined) {
      if (dynamic) options.work.truncated = true;
      return dynamic ? "unknown" : name;
    }
    const cacheKey = JSON.stringify([name, depth, [...seen]]);
    let rendered = options.work.refs.get(cacheKey);
    if (rendered === undefined) {
      seen.add(name);
      rendered = renderSchema(target, defs, seen, depth, options);
      seen.delete(name);
      options.work.refs.set(cacheKey, rendered);
    }
    return constrain(rendered);
  }

  const union = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(union)) {
    const parts = boundedParts(options.work, " | ", "", "");
    for (const member of union) {
      parts.add(renderSchema(member, defs, seen, depth + 1, options));
    }
    const rendered = parts.finish() || "unknown";
    return constrain(rendered);
  }
  if (Array.isArray(s.enum)) {
    const rendered = renderEnum(
      s.enum,
      options.work,
      options.enumByteLimit,
      options.onEnumTruncated,
    );
    return constrain(rendered);
  }
  // Checked before type/properties so a discriminator like
  // { type: "string", const: "emoji" } renders as "emoji" rather than string.
  // JSON.stringify(undefined) returns undefined (not a string), so an explicit
  // `const: undefined` must fall through to the regular type rendering.
  if (s.const !== undefined) {
    const rendered = options.work.json(s.const);
    return constrain(rendered);
  }

  const type = s.type;
  if (Array.isArray(s.prefixItems)) {
    const parts = boundedParts(options.work, ", ", "[", "]");
    for (const item of s.prefixItems) {
      parts.add(renderSchema(item, defs, seen, depth + 1, options));
    }
    if (s.items !== false) {
      const rest = s.items === undefined || s.items === true
        ? "unknown"
        : renderSchema(s.items, defs, seen, depth + 1, options);
      parts.add(`...${grouped(rest)}[]`);
    }
    return parts.finish();
  }
  if (type === "array" || s.items) {
    const items = s.items
      ? renderSchema(s.items, defs, seen, depth + 1, options)
      : "unknown";
    return `${items}[]`;
  }
  if (type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set(schemaRequired(s, options.work));
    const declaredKeys = propertyNames(props, options.work);
    const keys = options.requiredFirst
      ? [
          ...declaredKeys.filter((key) => required.has(key)),
          ...declaredKeys.filter((key) => !required.has(key)),
        ]
      : declaredKeys;
    if (keys.length === 0) return "{}";
    const parts = boundedParts(options.work, ", ", "{ ", " }");
    for (const key of keys) {
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
      if (options.propertyDescriptions && typeof description === "string") {
        options.work.text(description);
      }
      options.work.text(key);
      const comment =
        options.propertyDescriptions && typeof description === "string"
          ? ` // ${description}`
          : "";
      parts.add(`${key}${optional}: ${rendered}${comment}`);
    }
    return parts.finish();
  }
  if (typeof type === "string") {
    return constrain(options.work.text(type));
  }
  if (Array.isArray(type)) {
    const parts = boundedParts(options.work, " | ", "", "");
    for (const item of type) {
      options.work.visit();
      parts.add(options.work.text(String(item)));
    }
    const rendered = parts.finish();
    return constrain(rendered);
  }
  if (options.renderConstraints && constraintEntries(s).length > 0) {
    return renderConstraints(
      "unknown",
      s,
      options.constraintByteLimit,
      options.onConstraintTruncated,
    );
  }
  return options.work.json(schema);
}

const compactSchemas = new WeakMap<JsonSchema, CompactDiscoverySchema>();

function resolveDefinition(schema: JsonSchema, name: string): unknown {
  const definitions = schema.definitions as Record<string, unknown> | undefined;
  const defs = schema.$defs as Record<string, unknown> | undefined;
  return definitions && Object.hasOwn(definitions, name)
    ? definitions[name]
    : defs && Object.hasOwn(defs, name) ? defs[name] : undefined;
}

/** Render and cache a compact TypeScript-like representation of JSON Schema. */
export function compactSchema(schema: JsonSchema): string {
  return compactDescriptionSchema(schema).text;
}

/** Describe allows 8 KiB for property prose, with the same work cap as search. */
export function compactDescriptionSchema(
  schema: JsonSchema,
): CompactDiscoverySchema {
  const cached = compactSchemas.get(schema);
  if (cached) return cached;
  const result = boundedCompactSchema(schema, true);
  compactSchemas.set(schema, result);
  return result;
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
function truncatedDiscoverySchema(schema: JsonSchema, work: SchemaWork): string {
  let keys: SchemaObjectKeys | undefined;
  try {
    keys = objectKeys(schema, schema, new Set(), 0, work);
  } catch { /* An exhausted walk has no reliable key inventory. */ }
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
  const result = boundedCompactSchema(schema, false);
  compactDiscoverySchemas.set(schema, result);
  return result;
}

function boundedCompactSchema(
  schema: JsonSchema,
  description: boolean,
): CompactDiscoverySchema {
  const work = new SchemaWork(
    description ? MAX_COMPACT_DESCRIPTION_SCHEMA_BYTES : MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
  );
  const options: RenderOptions = {
    work,
    propertyDescriptions: description,
    requiredFirst: !description,
    enumByteLimit: description ? work.byteLimit : MAX_COMPACT_DISCOVERY_ENUM_BYTES,
    onEnumTruncated: () => { work.truncated = true; },
    renderConstraints: true,
    constraintByteLimit: description ? work.byteLimit : MAX_COMPACT_DISCOVERY_CONSTRAINT_BYTES,
    onConstraintTruncated: () => { work.truncated = true; },
  };
  try {
    const text = renderSchema(schema, schema, new Set(), 0, options);
    return { text, truncated: work.truncated };
  } catch (error) {
    // A constraint-free retry shares the original work budget. Repeated refs
    // are memoized only within each pass because their text includes constraints.
    if (error === schemaSizeExceeded && !description) {
      work.refs.clear();
      try {
        return {
          text: renderSchema(schema, schema, new Set(), 0, {
            ...options,
            renderConstraints: false,
          }),
          truncated: true,
        };
      } catch { /* Fall through to a bounded key-only shape. */ }
    }
    return { text: truncatedDiscoverySchema(schema, work), truncated: true };
  }
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
  try {
    return objectKeys(schema, schema, new Set(), 0, new SchemaWork());
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
  defs: JsonSchema,
  seen: Set<string>,
  depth: number,
  work: SchemaWork,
): SchemaObjectKeys | undefined {
  work.visit();
  if (depth > 4) return undefined;
  if (schema === null || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.allOf)) {
    const own: Record<string, unknown> = Object.create(null);
    for (const key of propertyNames(s, work)) {
      if (key !== "allOf") own[key] = s[key];
    }
    const parts = declaresShape(own)
      ? [objectKeys(own, defs, seen, depth, work)]
      : [];
    for (const member of s.allOf) {
      const keys = objectKeys(member, defs, seen, depth + 1, work);
      if (!keys) return undefined;
      parts.push(keys);
    }
    // An allOf whose members are not all object shapes renders as an
    // intersection with a non-object half; no single key list describes it.
    return parts.every((part) => part !== undefined)
      ? mergedKeys(parts as SchemaObjectKeys[])
      : undefined;
  }

  const reference = s.$ref ?? s.$dynamicRef;
  if (typeof reference === "string") {
    const rawName = refName(work.text(reference));
    const name = s.$ref === undefined ? rawName.replace(/^#/, "") : rawName;
    if (seen.has(name)) return undefined;
    const target = resolveDefinition(defs, name);
    if (target === undefined) return undefined;
    seen.add(name);
    const resolved = objectKeys(target, defs, seen, depth, work);
    seen.delete(name);
    return resolved;
  }

  if (Array.isArray(s.oneOf ?? s.anyOf)) return undefined;
  if (Array.isArray(s.enum)) return undefined;
  if (s.const !== undefined) return undefined;
  if (s.type === "array" || s.items || Array.isArray(s.prefixItems)) return undefined;
  if (s.type === "object" || s.properties) {
    const props = s.properties;
    if (props === null || Array.isArray(props) || typeof props !== "object") {
      return { properties: [], required: [] };
    }
    const properties = propertyNames(props as Record<string, unknown>, work);
    const declared = new Set(properties);
    return {
      properties,
      required: schemaRequired(s, work).filter((key) => declared.has(key)),
    };
  }
  return undefined;
}

function propertyNames(props: Record<string, unknown>, work: SchemaWork): string[] {
  const names: string[] = [];
  for (const name in props) {
    work.visit();
    if (Object.hasOwn(props, name)) names.push(work.text(name));
  }
  return names;
}

function schemaRequired(schema: Record<string, unknown>, work: SchemaWork): string[] {
  if (!Array.isArray(schema.required)) return [];
  const names: string[] = [];
  for (const key of schema.required) {
    work.visit();
    if (typeof key === "string") names.push(work.text(key));
  }
  return names;
}
