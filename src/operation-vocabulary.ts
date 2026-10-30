// Private, request-free discovery facts. No provider, schema, handler or I/O dependency.
import { lexicalSearchContent, lexicalQueryTerms } from "./catalog.js";
import type { Connector, ToolDef } from "./types.js";

type Row = { readonly text: string; readonly route: string | undefined; readonly write: boolean };
type Groups = readonly (readonly string[])[];
type Vocabulary = (
  query: string,
  visible: ReadonlySet<string>,
  safety: string | undefined,
  readOnly: boolean,
  synonyms?: Groups,
) => boolean;
const tools = new WeakMap<object, Vocabulary>();
const connectors = new WeakMap<object, ReadonlyMap<string, Vocabulary>>();
const synonymGroups = new WeakMap<object, Groups>();
const OPERATION_VOCABULARY_BOUNDS = {
  operations: 8192,
  rowChars: 1024,
  chars: 2_097_152,
  terms: 8,
  queryChars: 200,
  cache: 128,
} as const;

const token = (word: string) =>
  word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word;
const aliases: Readonly<Record<string, string>> = {
  retrieve: "get",
  read: "get",
  fetch: "get",
  find: "list",
  search: "list",
  add: "create",
  new: "create",
  edit: "update",
  change: "update",
  modify: "update",
  remove: "delete",
};
const normal = (word: string) => aliases[word] ?? token(word);
const terms = (text: string) => [...new Set(lexicalQueryTerms(lexicalSearchContent(text)).map(normal))];

/**
 * Attach a maintained provider's lexical synonym groups to its connector. Each
 * group's words are interchangeable query terms for that connector's tool
 * ranking and operation vocabulary; nothing is inferred.
 */
export function registerSearchSynonyms(connector: Connector, groups: Groups): void {
  synonymGroups.set(connector, groups);
}

/** A connector's groups, including those a provider stamp inherits. */
function groupsOf(connector: Connector): Groups | undefined {
  let target: object | null = connector;
  while (target && !synonymGroups.has(target)) target = Object.getPrototypeOf(target);
  return target ? synonymGroups.get(target) : undefined;
}

/** The other words of every group holding `word`, each word under `normalize`. */
function synonymsIn(groups: Groups, word: string, normalize = (raw: string) => raw): string[] {
  return groups.flatMap((group) => {
    const words = group.map(normalize);
    return words.includes(word) ? words.filter((other) => other !== word) : [];
  });
}

/** Word to its declared synonyms for a connector's tool ranking, when its provider declares any. */
export function searchSynonyms(connector: Connector): ((word: string) => string[]) | undefined {
  const groups = groupsOf(connector);
  return groups && ((word) => synonymsIn(groups, word));
}

/** Register only construction-authored compact summaries; never whole request/response schemas. */
export function registerOperationVocabulary(tool: object, rows: () => Iterable<Row>): void {
  let postings: Map<string, number[]> | undefined;
  const routes: Array<Pick<Row, "route" | "write">> = [];
  const cache = new Map<string, readonly number[]>();
  tools.set(tool, (query, visible, safety, readOnly, synonyms) => {
    if (query.length > OPERATION_VOCABULARY_BOUNDS.queryChars) return false;
    const wanted = terms(query);
    if (!wanted.length || wanted.length > OPERATION_VOCABULARY_BOUNDS.terms) return false;
    // Each wanted word matches through itself or any declared synonym.
    const alternatives = wanted.map((word) => [word, ...(synonyms ? synonymsIn(synonyms, word, normal) : [])]);
    if (!postings) {
      postings = new Map();
      let chars = 0;
      for (const row of rows()) {
        const text = row.text.slice(0, OPERATION_VOCABULARY_BOUNDS.rowChars);
        if (
          routes.length >= OPERATION_VOCABULARY_BOUNDS.operations ||
          chars + text.length > OPERATION_VOCABULARY_BOUNDS.chars
        )
          break;
        chars += text.length;
        const id = routes.length;
        routes.push({ route: row.route, write: row.write });
        for (const word of terms(text)) {
          const hits = postings.get(word);
          if (hits) hits.push(id);
          else postings.set(word, [id]);
        }
      }
    }
    const key = alternatives.map((words) => words.join("|")).join(" ");
    let found = cache.get(key);
    if (!found) {
      const lists = alternatives
        .map((words) => [...new Set(words.flatMap((word) => postings!.get(word) ?? []))])
        .sort((a, b) => a.length - b.length);
      const rest = lists.slice(1).map((list) => new Set(list));
      found = lists[0]!.filter((id) => rest.every((set) => set.has(id)));
      if (cache.size >= OPERATION_VOCABULARY_BOUNDS.cache) cache.delete(cache.keys().next().value!);
      cache.set(key, found);
    }
    return found.some((id) => {
      const row = routes[id]!;
      if (row.write && readOnly) return false;
      if ((safety === "readOnly" && row.write) || (safety === "approvalRequired" && !row.write)) return false;
      return row.route !== undefined && visible.has(row.route);
    });
  });
}

/** Move private facts across the public ApiTool -> Connector construction boundary. */
export function registerConnectorVocabulary(connector: Connector, declarations: readonly { name: string }[]): void {
  const entries = declarations.flatMap((tool) => {
    const vocabulary = tools.get(tool);
    return vocabulary ? [[tool.name, vocabulary] as const] : [];
  });
  if (entries.length) connectors.set(connector, new Map(entries));
}

export function operationVocabularyMatches(
  connector: Connector,
  catalog: readonly ToolDef[],
  query: string,
  safety: string | undefined,
  readOnly: boolean,
): ToolDef[] {
  const registered = connectors.get(connector);
  if (!registered) return [];
  const visible = new Set(catalog.map((tool) => tool.name));
  const synonyms = groupsOf(connector);
  return catalog.filter(
    (tool) =>
      tool.classification === "read" &&
      registered.get(tool.name)?.(query, visible, safety, readOnly || connector.readOnly === true, synonyms),
  );
}
