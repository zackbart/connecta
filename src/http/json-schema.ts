// Internal prototype for decision 0010 (B.4). Unreachable from src/index.ts.
//
// One Schema is a tool's type, its argument decoder, and its catalog JSON
// Schema. Effect's generator is correct but spells some things differently
// from the catalogs agents already read, and catalog bytes may not change
// without a recorded decision. This renders the "connecta dialect": the same
// constraints, minus what JSON Schema already defaults or Effect adds for its
// own decoder.
//
// - `additionalProperties: true` is the default and is dropped. Inputs are
//   closed (`onExcessProperty: "error"`), and their root always names
//   `required`, as every hand-written input does.
// - Nothing the decoder enforces is dropped. `Schema.Int` refuses integers
//   past 2^53 and says so (`minimum`/`maximum`); catalogs have always meant
//   any whole number, so kit Schemas use `Integer` below, which decodes and
//   renders exactly that.
// - An array's own keywords (`maxItems`, `description`) come before `items`.
// - `anyOf` over primitive branches with disjoint types, each constrained only
//   by keywords that apply to its own type, becomes one `type` array. JSON
//   Schema applies `minLength` only to strings and `minimum` only to numbers,
//   so the two spellings accept exactly the same values.
//
// Only the stable `effect` Schema module is used here.

import { Schema } from "effect";
import type { JsonSchema } from "../types.js";

type Node = Record<string, unknown>;

const NUMERIC = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const OWN_KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set(["minLength", "maxLength", "pattern", "format"]),
  integer: NUMERIC,
  number: NUMERIC,
  boolean: new Set(),
  null: new Set(),
};

/**
 * A whole number, as JSON Schema's `type: integer` and api()'s validator mean
 * it: finite, with no safe-integer bound. Use it, not `Schema.Int`, wherever a
 * catalog or a request encodes an integer.
 */
export const Integer = Schema.Finite.check(
  Schema.makeFilter((value: number) => Number.isInteger(value), {
    expected: "an integer",
    toJsonSchema: () => ({ type: "integer" }),
  }),
);

/** Render a Schema as catalog JSON Schema. Throws on a schema that needs `$defs`. */
export function catalogSchema(schema: Schema.Top, mode: "input" | "output"): JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema, mode === "input" ? { onExcessProperty: "error" } : {});
  if (Object.keys(document.definitions).length > 0) {
    throw new Error("A catalog schema is rendered inline; remove the identifier that asked for a definition.");
  }
  const root = normalize(document.schema) as Node;
  if (mode === "input" && root["type"] === "object" && !("required" in root)) {
    return Object.fromEntries(
      Object.entries(root).flatMap(([key, value]) =>
        key === "properties"
          ? [
              [key, value],
              ["required", []],
            ]
          : [[key, value]],
      ),
    );
  }
  return root;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const node = value as Node;
  const out: Node = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === "additionalProperties" && child === true) continue;
    if (key === "properties") {
      out[key] = Object.fromEntries(Object.entries(child as Node).map(([name, schema]) => [name, normalize(schema)]));
      continue;
    }
    if (key === "anyOf") {
      const branches = (child as unknown[]).map(normalize) as Node[];
      const merged = collapse(branches);
      if (merged) Object.assign(out, merged);
      else out[key] = branches;
      continue;
    }
    out[key] = key === "items" || key === "additionalProperties" ? normalize(child) : child;
  }
  // Hand-written catalogs spell an array's own keywords before its `items`.
  if ("items" in out) {
    const { items, ...rest } = out;
    return { ...rest, items };
  }
  return out;
}

/** One `type` array for primitive branches whose constraints cannot collide, else undefined. */
function collapse(branches: Node[]): Node | undefined {
  const types: string[] = [];
  const merged: Node = {};
  for (const branch of branches) {
    const type = branch["type"];
    if (typeof type !== "string" || types.includes(type) || !OWN_KEYWORDS[type]) return undefined;
    for (const [key, keyword] of Object.entries(branch)) {
      if (key === "type") continue;
      if (!OWN_KEYWORDS[type]!.has(key) || key in merged) return undefined;
      merged[key] = keyword;
    }
    types.push(type);
  }
  // integer and number share keywords, so they never merge.
  if (types.includes("integer") && types.includes("number")) return undefined;
  return { type: types, ...merged };
}
