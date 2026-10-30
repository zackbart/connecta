// Private, request-free discovery facts. No provider, schema, handler or I/O dependency.
import { lexicalSearchContent, lexicalQueryTerms } from "./catalog.js";
import type { Connector, ToolDef } from "./types.js";

/** A fully determined read: its route's `{ path }` alone is the complete call. */
type Ready = { readonly path: string; readonly summary: string };
type Row = {
  readonly text: string;
  readonly route: string | undefined;
  readonly write: boolean;
  /** `operationId` names the resource with the path; the summary never does. */
  readonly ready?: (Ready & { readonly operationId: string }) | undefined;
};
/**
 * A ready row's resource identity. Each path segment, and the operationId
 * without its action and version words, is one whole name: `event_destinations`
 * is ["event", "destination"], never "event" alone. `terms` holds all their words.
 */
type Resource = {
  readonly names: readonly (readonly string[])[];
  readonly last: readonly string[];
  readonly terms: ReadonlySet<string>;
};
type Groups = readonly (readonly string[])[];
type Vocabulary = (
  query: string,
  visible: ReadonlySet<string>,
  safety: string | undefined,
  readOnly: boolean,
  synonyms?: Groups,
) => { matched: boolean; ready: Array<Ready & { route: string }> };
/** Ready calls one vocabulary offers a search: only its top-ranked operation. */
const MAX_READY_PER_VOCABULARY = 1;
/**
 * Normalized action words. A summary may supply these; every other query word
 * names an object and must match the operation's resource identity.
 */
const ACTIONS = new Set(["get", "list", "count", "show", "create", "update", "delete"]);
/** Path tokens that version an API rather than name a resource. */
const VERSION = /^v?\d+$/;
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
/** Resource words of a path segment or operation id, without version or action words. */
const identity = (text: string) => terms(text).filter((word) => !VERSION.test(word) && !ACTIONS.has(word));
function resourceOf(path: string, operationId: string): Resource {
  const segments = path.slice(0, OPERATION_VOCABULARY_BOUNDS.rowChars).split("/").map(identity);
  const names = [...segments, identity(operationId.slice(0, OPERATION_VOCABULARY_BOUNDS.rowChars))].filter(
    (name) => name.length > 0,
  );
  return { names, last: segments.at(-1) ?? [], terms: new Set(names.flat()) };
}

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
  const routes: Array<Pick<Row, "route" | "write"> & { ready?: Ready & Resource }> = [];
  const cache = new Map<string, readonly number[]>();
  tools.set(tool, (query, visible, safety, readOnly, synonyms) => {
    const none = { matched: false, ready: [] };
    if (query.length > OPERATION_VOCABULARY_BOUNDS.queryChars) return none;
    const wanted = terms(query);
    if (!wanted.length || wanted.length > OPERATION_VOCABULARY_BOUNDS.terms) return none;
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
        routes.push({
          route: row.route,
          write: row.write,
          ...(row.ready
            ? {
                ready: {
                  path: row.ready.path,
                  summary: row.ready.summary.slice(0, OPERATION_VOCABULARY_BOUNDS.rowChars),
                  ...resourceOf(row.ready.path, row.ready.operationId),
                },
              }
            : {}),
        });
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
    // The same endpoint, safety and visibility checks decide both answers.
    const admitted = found.filter((id) => {
      const row = routes[id]!;
      if (row.write && readOnly) return false;
      if ((safety === "readOnly" && row.write) || (safety === "approvalRequired" && !row.write)) return false;
      return row.route !== undefined && visible.has(row.route);
    });
    // A ready call must name what the query asks for. Every object word, or
    // a declared synonym, belongs to a whole resource name whose words the
    // query states in order. A word met only in a summary, or only as part of
    // a compound name, can route a search, never stand in for the resource.
    const objects = alternatives.filter((words) => !ACTIONS.has(words[0]!));
    const at = (name: readonly string[], start: number) =>
      start + name.length <= objects.length && name.every((word, offset) => objects[start + offset]!.includes(word));
    const covers = (names: readonly (readonly string[])[]) => {
      const covered = objects.map(() => false);
      for (const name of names)
        for (let start = 0; start < objects.length; start++)
          if (at(name, start)) name.forEach((_, offset) => (covered[start + offset] = true));
      return covered.every(Boolean);
    };
    const asked = new Set(alternatives.flat());
    return {
      matched: admitted.length > 0,
      ready: objects.length
        ? admitted
            .flatMap((id) => {
              const { route, write, ready } = routes[id]!;
              if (!ready || write || !route || !covers(ready.names)) return [];
              return [
                {
                  path: ready.path,
                  summary: ready.summary,
                  route,
                  id,
                  // Relevance first: the last segment names the resource asked
                  // for, then the fewest resource words the query did not ask for.
                  last: Number(objects.some((_, start) => ready.last.length > 0 && at(ready.last, start))),
                  extra: [...ready.terms].filter((word) => !asked.has(word) && !ACTIONS.has(word)).length,
                },
              ];
            })
            .sort((a, b) => b.last - a.last || a.extra - b.extra || a.path.length - b.path.length || a.id - b.id)
            .slice(0, MAX_READY_PER_VOCABULARY)
            .map(({ path, summary, route }) => ({ path, summary, route }))
        : [],
    };
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

/**
 * Read tools whose operation vocabulary matches every query word, and the
 * fully determined reads among those operations, each through a visible read
 * tool of `catalog`: the caller's view, after endpoint, connector, hidden-tool
 * and grant filtering.
 */
export function operationVocabularyMatches(
  connector: Connector,
  catalog: readonly ToolDef[],
  query: string,
  safety: string | undefined,
  readOnly: boolean,
): { tools: ToolDef[]; ready: Array<Ready & { tool: ToolDef }> } {
  const registered = connectors.get(connector);
  const tools: ToolDef[] = [];
  const ready: Array<Ready & { tool: ToolDef }> = [];
  if (!registered) return { tools, ready };
  const visible = new Set(catalog.map((tool) => tool.name));
  const synonyms = groupsOf(connector);
  for (const tool of catalog) {
    const vocabulary = tool.classification === "read" ? registered.get(tool.name) : undefined;
    const found = vocabulary?.(query, visible, safety, readOnly || connector.readOnly === true, synonyms);
    if (!found?.matched) continue;
    tools.push(tool);
    for (const { route, ...call } of found.ready) {
      const target = catalog.find((candidate) => candidate.name === route);
      if (target?.classification === "read") ready.push({ ...call, tool: target });
    }
  }
  return { tools, ready };
}
