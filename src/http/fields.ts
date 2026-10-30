// Internal provider kit (decision 0011 S5). Unreachable from src/index.ts.
//
// `fields` narrows a result to the dot paths an agent names. It runs on the
// result a tool already built (after value safety, the privacy projection and
// any named projection), so it can only remove. A list narrows each item.
//
// Every `fields` argument states where its paths start, its anchor, in the
// schema description, derived here from the same contract that validates it:
// a named read's result, each item of a list's `items`, or a hatch's response
// body in `data`. A path is checked against the published output schema as
// deep as that schema is closed, so a path outside the declared contract is
// refused before anything is sent. A declared path the response happens to
// lack is never refused: absent optional values and empty lists are ordinary.
import { Schema } from "effect";
import { ConnectorCallError } from "../errors.js";
import type { JsonSchema } from "../types.js";
import { ArgumentProblems } from "./argument-problems.js";
import { catalogSchema, isMaxChars, isMinChars } from "./json-schema.js";

const MAX_FIELDS = 50;
/** Choices listed in a refusal or a warning; more read as "a declared property". */
const MAX_CHOICES = 40;

/** Where a tool's `fields` paths start. */
export type FieldsAnchor = "result" | "item" | "data";

const ANCHORS: Readonly<Record<FieldsAnchor, string>> = {
  result: "the result",
  item: "each item in items",
  data: "the response body in data, each item when the body is a list",
};

/** The description of a `fields` argument: its anchor, one valid example, then any tool note. */
export function fieldsDescription(anchor: FieldsAnchor, example: string, note = "It only narrows the result."): string {
  return `Dot paths to keep. Paths start at ${ANCHORS[anchor]}, e.g. ${JSON.stringify([example])}. ${note}`;
}

/** The `fields` argument: at most 50 dot paths of 1 to 200 characters. */
export function fieldsInput(description: string) {
  return Schema.Array(Schema.String.check(isMinChars(1), isMaxChars(200)))
    .check(Schema.isMaxLength(MAX_FIELDS))
    .annotate({ description });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A dot path's property names; `a[].b` and `a.b` both select `b` in each item of `a`. */
const segments = (path: string) => path.replace(/\[\](?=\.|$)/g, "").split(".");

/**
 * Collect the properties a path segment may name at a schema position into
 * `into`, false when the position is open (any key may appear: `{}`, a bare
 * object or array, a record, a reference). Arrays are transparent, as
 * selection narrows them item by item; a leaf adds nothing and stays closed.
 * Below the first segment, JSON Schema's default applies: an object is closed
 * only when it says `additionalProperties: false`. The first segment keeps the
 * declared properties of the result or item as its closed set.
 */
function propertiesAt(node: unknown, into: Map<string, unknown[]>, root: boolean): boolean {
  if (!record(node)) return node === false;
  const additional = node["additionalProperties"];
  if ("$ref" in node || "allOf" in node || (additional !== undefined && additional !== false)) return false;
  const branches = [node["anyOf"], node["oneOf"]].flatMap((value) => (Array.isArray(value) ? value : []));
  if (!branches.every((branch) => propertiesAt(branch, into, root))) return false;
  if (node["items"] !== undefined && !propertiesAt(node["items"], into, root)) return false;
  const properties = node["properties"];
  if (record(properties)) {
    for (const [name, child] of Object.entries(properties)) into.set(name, [...(into.get(name) ?? []), child]);
    return root || additional === false;
  }
  if (branches.length || node["items"] !== undefined || "enum" in node || "const" in node) return true;
  const types = [node["type"]].flat();
  return node["type"] !== undefined && !types.includes("object") && !types.includes("array");
}

const choices = (names: readonly string[]) =>
  names.length > 0 && names.length <= MAX_CHOICES ? `one of ${names.join(", ")}` : "a declared property";

/**
 * Record every `fields` path the contract cannot carry. A JSON Schema is the
 * published shape at the anchor (a result, or a list's item), checked as deep
 * as it is closed; a set names only the first segments, which is all a hatch's
 * pinned index can promise. A finding names the entry's index, its segment
 * position and the declared properties there, never the submitted text.
 */
function fieldsIssues(
  problems: ArgumentProblems,
  fields: readonly string[] | undefined,
  contract: JsonSchema | ReadonlySet<string>,
  of: string,
): void {
  const root =
    contract instanceof Set
      ? { type: "object", properties: Object.fromEntries([...contract].map((n) => [n, {}])) }
      : contract;
  fields?.forEach((field, index) => {
    let nodes: unknown[] = [root];
    for (const [depth, name] of segments(field).entries()) {
      const at = new Map<string, unknown[]>();
      // Selection keeps a scalar a path runs past, so below the first segment only a closed object refuses.
      if (!nodes.every((node) => propertiesAt(node, at, depth === 0)) || (depth > 0 && at.size === 0)) return;
      const next = at.get(name);
      if (next) {
        nodes = next;
        continue;
      }
      const declared = [...at.keys()];
      problems.add(
        `/fields/${index}`,
        depth === 0
          ? `a path beginning with a property of ${of}: ${choices(declared)}`
          : `a declared path of ${of}; segment ${depth + 1} names a property declared at that level: ${choices(declared)}`,
      );
      return;
    }
  });
}

/** The single refusal naming every bad `fields` path, if any; `withheld` says why it has no example. */
export function fieldsProblem(
  fields: readonly string[] | undefined,
  contract: JsonSchema | ReadonlySet<string>,
  of: string,
  withheld?: string,
): ConnectorCallError | undefined {
  const problems = new ArgumentProblems();
  fieldsIssues(problems, fields, contract, of);
  return problems.refusal("Invalid fields", undefined, withheld);
}

/** A `fields` argument and its checks, built from the published schema of what it narrows. */
export interface FieldsContract {
  /** The argument's description: the anchor and an example from the contract. */
  readonly description: string;
  /** The argument Schema with that description. */
  readonly input: ReturnType<typeof fieldsInput>;
  readonly issues: (problems: ArgumentProblems, fields: readonly string[] | undefined) => void;
  readonly problem: (fields: readonly string[] | undefined) => ConnectorCallError | undefined;
}

/**
 * The `fields` contract for a named read's result (`"result"`) or a list's
 * item (`"item"`). `shape` is that result or item: a Schema rendered as the
 * catalog renders it, or the catalog JSON Schema itself. Its first declared
 * property is the description's example, so the example is always valid.
 */
export function fieldsContract(
  anchor: "result" | "item",
  shape: Schema.Top | JsonSchema,
  note?: string,
  of = anchor === "item" ? "an item" : "the result",
): FieldsContract {
  const schema = "ast" in shape ? catalogSchema(shape as Schema.Top, "output") : shape;
  const at = new Map<string, unknown[]>();
  propertiesAt(schema, at, true);
  const example = [...at.keys()][0];
  if (example === undefined) throw new Error("fields needs a contract that declares at least one property.");
  const description = fieldsDescription(anchor, example, note);
  return {
    description,
    input: fieldsInput(description),
    issues: (problems, fields) => fieldsIssues(problems, fields, schema, of),
    problem: (fields) => fieldsProblem(fields, schema, of),
  };
}

/** Keep only the named dot paths; arrays are narrowed item by item. */
export function selectFields(data: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length) return data;
  const pick = (value: unknown, paths: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((item) => pick(item, paths));
    if (!record(value)) return value;
    const children = new Map<string, string[]>();
    for (const path of paths) {
      const [key, ...tail] = segments(path);
      children.set(key!, [...(children.get(key!) ?? []), tail.join(".")]);
    }
    return Object.fromEntries(
      [...children].flatMap(([key, tails]) =>
        Object.hasOwn(value, key) ? [[key, tails.includes("") ? value[key] : pick(value[key], tails)]] : [],
      ),
    );
  };
  return pick(data, fields);
}

const empty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) ? value.length === 0 : record(value) && !Object.keys(value).length);

/** Warning bounds: each warning's characters, the count kept, and every kept warning's characters together. */
export const WARNING_BUDGET = { chars: 512, warnings: 10, totalChars: 4096 } as const;

/**
 * Keep warnings within WARNING_BUDGET in order, cutting a long one with an
 * ellipsis, then one count of what was omitted. Merged reviewed warnings and
 * `fields` reports share the budget.
 */
export function boundWarnings(warnings: readonly string[]): string[] {
  const kept: string[] = [];
  let total = 0;
  for (const warning of warnings) {
    const text = warning.length > WARNING_BUDGET.chars ? `${warning.slice(0, WARNING_BUDGET.chars - 1)}…` : warning;
    // Leave room for the omitted count.
    if (kept.length >= WARNING_BUDGET.warnings || total + text.length > WARNING_BUDGET.totalChars - 64) break;
    kept.push(text);
    total += text.length;
  }
  const omitted = warnings.length - kept.length;
  return omitted ? [...kept, `${omitted} more warning${omitted === 1 ? "" : "s"} omitted.`] : kept;
}

/** Declared names listed in one warning, within its character budget. */
function named(names: readonly string[]): string {
  let text = "";
  let shown = 0;
  for (const name of names) {
    const next = text ? `${text}, ${name}` : name;
    if (next.length > WARNING_BUDGET.chars - 200) break;
    text = next;
    shown += 1;
  }
  return shown < names.length ? `${text}${text ? " and " : ""}${names.length - shown} more` : text;
}

/**
 * One warning per `fields` entry that matched nothing in a nonempty response,
 * for contracts that cannot refuse it in advance. It names the entry's index,
 * the segment where matching stopped and the properties the contract declares
 * there, from `declared` (paths in `fields` coordinates). It never lists the
 * response's own keys, which in an open map are data, nor the submitted text.
 * A path some item matched, a path past a scalar (kept whole), or any path of
 * an empty response, is no warning.
 */
export function fieldsMisses(
  data: unknown,
  fields: readonly string[] | undefined,
  declared: readonly string[] = [],
): string[] {
  if (!fields?.length || empty(data)) return [];
  const flat = (values: readonly unknown[]): unknown[] =>
    values.flatMap((value) => (Array.isArray(value) ? flat(value) : [value]));
  const contract = declared.map((path) => segments(path.replace(/^\[\]\.?/, "")));
  return fields.flatMap((field, index) => {
    const path = segments(field);
    let values = flat([data]);
    for (const [depth, name] of path.entries()) {
      const holders = values.filter((value) => record(value) && Object.hasOwn(value, name));
      if (holders.length) {
        values = flat(holders.map((value) => (value as Record<string, unknown>)[name]));
        continue;
      }
      // Selection keeps a scalar or null a path runs past, so only an object lacking the key is a miss.
      if (!values.some(record)) return [];
      const prefix = path.slice(0, depth);
      const names = [
        ...new Set(
          contract
            .filter((parts) => parts.length > depth && prefix.every((part, at) => parts[at] === part))
            .map((parts) => parts[depth]!),
        ),
      ];
      return [
        `fields/${index} matched nothing in this response after value safety and privacy filtering, at segment ${depth + 1}; ${
          names.length ? `declared there: ${named(names)}` : "the operation declares no properties there"
        }.`,
      ];
    }
    return [];
  });
}
