// Internal provider kit (decision 0011 S5). Unreachable from src/index.ts.
//
// `fields` narrows a result to the dot paths an agent names. It runs on the
// result a tool already built (after value safety, the privacy projection and
// any named projection), so it can only remove. A list narrows each item.
import { Schema } from "effect";
import { ConnectorCallError } from "../errors.js";
import { ArgumentProblems, type ArgumentFix } from "./argument-problems.js";
import { isMaxChars, isMinChars } from "./json-schema.js";

const MAX_FIELDS = 50;

/** The `fields` argument: at most 50 dot paths of 1 to 200 characters. */
export function fieldsInput(description: string) {
  return Schema.Array(Schema.String.check(isMinChars(1), isMaxChars(200)))
    .check(Schema.isMaxLength(MAX_FIELDS))
    .annotate({ description });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Record every `fields` path whose first segment is not a property the result
 * can carry. Named tools pass their output Schema's property names and the
 * hatch its operation's declared response roots, so a bad path fails before
 * anything is sent. Each bad path is dropped from the example call.
 */
export function fieldsIssues(
  problems: ArgumentProblems,
  fields: readonly string[] | undefined,
  names: ReadonlySet<string>,
  of: string,
  /** The corrected path when the result's shape determines it; default drops the path. */
  fix: (field: string) => ArgumentFix = () => "omit",
): void {
  const choices = names.size > 0 && names.size <= 40 ? `one of ${[...names].join(", ")}` : "a declared property";
  fields?.forEach((field, index) => {
    if (!names.has(field.replace(/\[\](?=\.|$)/g, "").split(".")[0]!))
      problems.add(`/fields/${index}`, `a path beginning with a property of ${of}: ${choices}`, { fix: fix(field) });
  });
}

/** The single refusal naming every bad `fields` path, if any. */
export function fieldsProblem(
  fields: readonly string[] | undefined,
  names: ReadonlySet<string>,
  of: string,
): ConnectorCallError | undefined {
  const problems = new ArgumentProblems();
  fieldsIssues(problems, fields, names, of);
  return problems.refusal("Invalid fields", fields === undefined ? undefined : { fields }, undefined);
}

/** Keep only the named dot paths; arrays are narrowed item by item. */
export function selectFields(data: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length) return data;
  const pick = (value: unknown, paths: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((item) => pick(item, paths));
    if (!record(value)) return value;
    const children = new Map<string, string[]>();
    for (const path of paths) {
      const [key, ...tail] = path.replace(/\[\](?=\.|$)/g, "").split(".");
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
