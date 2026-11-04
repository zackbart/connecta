/**
 * Written property rules, applied to today's exact text. Text no rule names is
 * kept: units, formats, exclusivity, id sources and write semantics live there.
 *
 * Shared by every rewritten arm:
 * - Remove prose that only restates a schema keyword (enum, maximum, default).
 * - Remove prose restating the conventions every provider guide generates.
 * - Shorten `fields`, `cursor`, `path`, `query` and `body` to anchor and shape.
 *
 * `terse` further removes what the name and type already say.
 */
import type { RewrittenArm } from "./types.js";

type Rule = readonly [RegExp, string | null | ((match: RegExpExecArray) => string | null)];

const SHARED: readonly Rule[] = [
  // Hatch `fields`: the anchor and example survive; the source of declared paths survives outside terse.
  [
    /^Dot paths to keep\. Paths start at the response body in data, each item when the body is a list, e\.g\. (\[[^\]]*\])\. Copy declared paths from (\w+) response\.fields\. Applied after value safety and privacy filtering\.$/,
    (m) => `Dot paths in the response body, each item of a list, e.g. ${m[1]}; ${m[2]} lists them.`,
  ],
  // Named `fields`: where paths start and one example.
  [
    /^Dot paths to keep\. Paths start at (the result|each item in items), e\.g\. (\[[^\]]*\])\.[^]*$/,
    (m) => `Dot paths from ${m[1]}, e.g. ${m[2]}.`,
  ],
  [/^Opaque nextCursor from the previous page\. Pass it back unchanged\.$/, "nextCursor from the previous page."],
  [
    /^Opaque page\.nextCursor from this same read; omit raw query anchors when continuing\.$/,
    "page.nextCursor from this read; omit raw query anchors.",
  ],
  [/^page\.nextCursor from the previous search with the same query\.$/, "page.nextCursor from this search."],
  [
    /^page\.nextCursor from the previous details call with the same method, path and param\.$/,
    "page.nextCursor from this call.",
  ],
  [/^Allowed page sizes are 25, 50, 75, and 100\. The vendor default is 25\.$/, null],
  [/^Results per page: 5 to 50; default 20\.$/, null],
  [/^Rows per page, default 25, at most 100\. A bounded extra row detects continuation\.$/, null],
  [/^The operation's HTTP method\.$/, null],
  [/^Only operations with this method\.$/, null],
  [/^Most operations to return\.$/, null],
  [/^Keywords or a path, e\.g\. refund charge\.$/, "Keywords or a path."],
  [/^The path template from search, or a concrete path\.$/, "Path template from search."],
  [/^Query parameters as JSON, named as details lists them\.$/, "Query parameters, named as details lists them."],
  [
    /^Request body as JSON fields, named as details lists them; form operations are encoded for you\.$/,
    "JSON fields, named as details lists them; forms are encoded for you.",
  ],
  [
    /^Concrete path from search with ids filled in, e\.g\. ([^ ]+)\. No query string\.$/,
    (m) => `Concrete path with ids filled in, e.g. ${m[1]}; no query string.`,
  ],
  [/^Body for a reviewed read-only POST\.$/, "Read-only POST body."],
  [
    /^GET by default; another method only for an operation search routes here\.$/,
    "GET unless search routes another method here.",
  ],
];

const TERSE: readonly Rule[] = [
  // The source of declared paths goes: `fields` refusals list them on demand.
  [
    /^Dot paths in the response body, each item of a list, e\.g\. (\[[^\]]*\]); \w+ lists them\.$/,
    (m) => `Dot paths in the response body, e.g. ${m[1]}.`,
  ],
  [/^nextCursor from the previous page\.$/, null],
  [/^page\.nextCursor from this search\.$/, null],
  [/^page\.nextCursor from this call\.$/, null],
  [/^Path template from search\.$/, null],
  [/^Read-only POST body\.$/, null],
  [/^Include (inactive|deceased) (individuals|members)\.$/, null],
  [/^Partial group name\.$/, null],
  [/^Partial event name\.$/, null],
  [/^Grid (rows|columns)\.$/, null],
  [/^Title on one line\.$/, null],
  [/^Pull request number\.$/, null],
  [/^Resource to search\.$/, null],
  [/^Form field name, e\.g\. metadata\.$/, null],
  [/^The part's Content-Type\.$/, null],
  [/^Content-Type of a text or base64 body\.$/, null],
  [/^A GraphQL query document\.$/, null],
  [/^Return only this parameter, in full\.$/, null],
];

function applied(rules: readonly Rule[], text: string): string | null {
  for (const [pattern, replacement] of rules) {
    const match = pattern.exec(text);
    if (match) return typeof replacement === "function" ? replacement(match) : replacement;
  }
  return text;
}

/** The property text an arm serves in place of today's `text`. */
export function propertyText(arm: RewrittenArm, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const shared = applied(SHARED, text);
  if (shared === null) return undefined;
  if (arm !== "terse") return shared;
  return applied(TERSE, shared) ?? undefined;
}
