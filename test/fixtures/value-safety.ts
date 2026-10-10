// The shared value-safety harness (decision 0005, "Value safety"). Every REST
// vendor runs it from its own `value-safety.node.test.ts` over its reviewed
// table, its pinned index, and the candidates `providers:spec` derived from
// the pinned spec. `reviewProblems` is pure, so `test/value-safety-harness`
// can prove that a wrong table fails it. It fails on:
//
// - candidates derived from another pin, detector format, or detector option;
// - a flagged operation without a verdict;
// - a verdict for an operation the pinned index does not carry;
// - a verdict without a reason, a redact verdict without paths, or a path
//   outside the path language;
// - a reviewed path the pinned response schema does not have (`providers:spec`
//   stamps the paths that resolve; `value-safety.absent.json` acknowledges
//   shared paths an operation's schema lacks), or a stale stamp;
// - a flagged response field no `redact` path, `keep`, vendor-wide field
//   review, or scope map accounts for;
// - a flagged field, built in the shape the pinned schema gives it, that
//   survives redaction when its review says it goes;
// - a `keep` (by path or by field name) that exempts anything below it, or a
//   vendor-wide keep of a credential name;
// - a resource rule path that leaves its value at the top level, in a list,
//   in an expansion, or in an event's `data.object` and partial copies;
// - a `refuse` verdict that reaches transport through the generic tools;
// - a reviewed operation whose failure echoes the vendor's error text;
// - a moved verdict count (a reviewed change updates it with the table).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorCallError } from "../../src/errors.js";
import type { OperationIndex } from "../../src/providers/_shared/rest/operation-index.js";
import {
  CREDENTIAL_SUFFIX,
  CREDENTIAL_WORDS,
  METADATA_NAMES,
  METADATA_SUFFIXES,
  credentialName,
  REDACTED,
  validPath,
  valueSafety,
  type ValueSafetyTable,
} from "../../src/providers/_shared/rest/value-safety.js";
import type { Connector, ConnectorContext } from "../../src/types.js";

const script = (await import(new URL("../../scripts/value-safety.mjs", import.meta.url).href)) as {
  VALUE_SAFETY_FORMAT: number;
  CREDENTIAL_WORDS: string[];
  CREDENTIAL_SUFFIX: RegExp;
  METADATA_SUFFIXES: string[];
  METADATA_NAMES: string[];
  credentialName(name: string): boolean;
};

export interface Candidates {
  format: number;
  digest: string;
  options?: unknown;
  candidates: Record<string, { fields: string[]; named: boolean }>;
  /** The table paths `providers:spec` found in the pinned response schemas. */
  reviewed?: { operations: Record<string, string[]>; resources: Record<string, string[]> };
}

/** Table paths an operation's (or resource's) pinned schema lacks, acknowledged in `value-safety.absent.json`. */
export interface Absent {
  operations?: Record<string, string[]>;
  resources?: Record<string, string[]>;
}

export interface ValueSafetyReview {
  readonly table: ValueSafetyTable;
  readonly index: OperationIndex;
  /** The provider's `openapi.source.json`. */
  readonly source: { digest: string; options?: { valueSafety?: unknown } };
  /** The provider's `value-safety.candidates.json`. */
  readonly candidates: Candidates;
  /** The provider's `value-safety.absent.json`, when it has one. */
  readonly absent?: Absent;
  /**
   * A flagged spec field as the path into the data a tool returns ("" for
   * the whole data), or undefined for a field the tools never return (an
   * envelope's paging metadata). Defaults to the field itself.
   */
  dataPath?(field: string): string | undefined;
  /** Per resource type with a `when` condition, fields that make it hold (a Checkout Session's `customer`). */
  readonly resourceExamples?: Record<string, Record<string, unknown>>;
}

export interface ValueSafetyHarness extends ValueSafetyReview {
  /** `{ refuse, redact, safe }`: a moved count is a reviewed change. */
  readonly counts: { refuse: number; redact: number; safe: number };
  /** A connector over this table, for the refusal sweep. */
  connector(): Connector;
  /** A context whose credential is set. */
  ctx(): ConnectorContext;
  /** A concrete path for a template; defaults to every `{param}` as `x`. */
  fill?(template: string): string;
  /** A reviewed operation answering a failure that echoes a marker; its vendor text must be withheld. */
  readonly echo: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    respond(marker: string): Response;
  };
}

/** Names that are a credential wherever they appear; no vendor-wide review may keep one. */
const CORE_CREDENTIALS: ReadonlySet<string> = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passphrase",
  "apikey",
  "api_key",
  "access_token",
  "accesstoken",
  "refresh_token",
  "private_key",
  "privatekey",
  "client_secret",
  "clientsecret",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "jwt",
  "signature",
]);

/** A path's named segments as the coverage check compares them: list markers dropped, maps as `*`. */
function segments(path: string): string[] {
  return path
    .replace(/^(?:url|origin):/, "")
    .replace(/#url$/, "")
    .replace(/\{\}/g, ".*")
    .replace(/\[\??[a-z]*\]|@keys/g, "")
    .split(".")
    .filter(Boolean);
}

/** Whether a reviewed path covers a field: the field, anything inside it, or a reviewed part of it. */
function covers(cover: string, field: string): boolean {
  const parts = segments(cover);
  const at = segments(field);
  const length = Math.min(parts.length, at.length);
  return parts.slice(0, length).every((part, index) => part === "*" || at[index] === "*" || part === at[index]);
}

/** Whether a reviewed path names exactly this field. */
function names(cover: string, field: string): boolean {
  const parts = segments(cover);
  const at = segments(field);
  return parts.length === at.length && covers(cover, field);
}

/**
 * Whether a reviewed path reaches a field as the engine applies it: each of
 * its segments names the field's segment or is a wildcard. A map in the field
 * (`{}`) is reached only by a wildcard.
 */
function reaches(cover: string, field: string): boolean {
  const parts = segments(cover);
  const at = segments(field);
  const length = Math.min(parts.length, at.length);
  return parts.slice(0, length).every((part, index) => part === "*" || part === at[index]);
}

/** A path's tokens after its first `count` named segments: the part of a deeper reviewed path below a field. */
function beyond(path: string, count: number): string[] {
  const all = tokens(path);
  let named = 0;
  let at = 0;
  while (at < all.length && named < count) {
    if (!all[at]!.startsWith("[") && all[at] !== "@keys") named += 1;
    at += 1;
  }
  // Markers right after the last shared name belong to the deeper part (`services` → `[]`, `routes`).
  return all.slice(at);
}

/** Every path segment with its list and map markers: `a[].b{}` → `a`, `[]`, `b`, `{}`. */
function tokens(path: string): string[] {
  return path
    .replace(/^(?:url|origin):/, "")
    .replace(/#url$/, "")
    .split(".")
    .flatMap((part) => part.match(/\[\??[a-z]*\]|\{\}|@keys|[^[\]{}@]+/g) ?? []);
}

/** A body that holds `leaf` at a path, lists and maps where the path says. */
function nest(path: string, leaf: unknown): unknown {
  let value = leaf;
  for (const part of [...tokens(path)].reverse()) {
    if (part.startsWith("[")) value = [filtered(value, part)];
    else if (part === "{}" || part === "*") value = { any: value };
    else if (part !== "@keys") value = { [part]: value };
  }
  return value;
}

/** The field a filtered list item carries so its filter (`[?env]`, `[?header]`, `[?credential]`) selects it. */
const FILTERS: Readonly<Record<string, Record<string, string>>> = {
  "[?env]": { type: "env" },
  "[?header]": { type: "header" },
  "[?credential]": { key: "api_token" },
};

function filtered(item: unknown, marker: string): unknown {
  const fields = FILTERS[marker];
  return fields && typeof item === "object" && item !== null && !Array.isArray(item) ? { ...item, ...fields } : item;
}

/** Give a probe built in a field's shape the list-item fields a reviewed path's filters select on. */
function decorate(body: unknown, cover: string): unknown {
  let nodes: unknown[] = [body];
  for (const token of tokens(cover)) {
    if (token === "@keys") break;
    if (token.startsWith("[")) {
      nodes = nodes.flatMap((node) => (Array.isArray(node) ? node : []));
      const fields = FILTERS[token];
      if (fields) for (const node of nodes) if (typeof node === "object" && node !== null) Object.assign(node, fields);
      continue;
    }
    nodes = nodes
      .flatMap((node) => (Array.isArray(node) ? node : [node]))
      .flatMap((node) => {
        if (typeof node !== "object" || node === null) return [];
        const record = node as Record<string, unknown>;
        if (token === "*" || token === "{}") return Object.values(record);
        return Object.hasOwn(record, token) ? [record[token]] : [];
      });
  }
  return body;
}

/** A value a reviewed path must remove: a URL whose userinfo and credential parameter carry it, or a plain string. */
function leafFor(path: string, marker: string): string {
  return /^(?:url|origin):|#url$/.test(path) ? `https://user:${marker}@example.com/?token=${marker}` : marker;
}

const verdictPaths = (verdict: ValueSafetyTable["operations"][string]): string[] =>
  verdict.verdict === "refuse" ? [] : [...(verdict.verdict === "redact" ? verdict.paths : []), ...(verdict.keep ?? [])];

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

export interface ReviewProblems {
  stale: string[];
  unreviewed: string[];
  invalid: string[];
  unresolved: string[];
  uncovered: string[];
  shapeLeaks: string[];
  keepLeaks: string[];
  pathLeaks: string[];
  resourceLeaks: string[];
}

/**
 * Every static check a reviewed table must pass, as lists of problems: empty
 * lists pass. Pure, so a mutated table can be shown to fail it.
 */
export function reviewProblems(review: ValueSafetyReview): ReviewProblems {
  const { table, index, candidates } = review;
  const safety = valueSafety(table, () => index);
  const operations = Object.entries(table.operations);
  const fields = table.fields ?? {};
  const resources = table.resources;
  const dataPath = review.dataPath ?? ((field: string) => field);
  const problems: ReviewProblems = {
    stale: [],
    unreviewed: [],
    invalid: [],
    unresolved: [],
    uncovered: [],
    shapeLeaks: [],
    keepLeaks: [],
    pathLeaks: [],
    resourceLeaks: [],
  };

  // Candidates come from the pinned document, the current detector, and the source record's options.
  if (candidates.digest !== review.source.digest) problems.stale.push("candidates digest is not the pinned digest");
  if (candidates.format !== script.VALUE_SAFETY_FORMAT) problems.stale.push("candidates format is not the detector's");
  const options = review.source.options?.valueSafety;
  if (
    JSON.stringify(candidates.options ?? {}) !==
    JSON.stringify(typeof options === "object" && options !== null ? options : {})
  ) {
    problems.stale.push("candidates options are not the source record's");
  }

  for (const key of Object.keys(candidates.candidates)) {
    if (!Object.hasOwn(table.operations, key)) problems.unreviewed.push(key);
  }

  for (const [key, verdict] of operations) {
    const [method, path] = key.split(" ") as [string, string];
    if (!index.operation(method, path)) problems.invalid.push(`${key}: not in the pinned index`);
    if (verdict.reason.trim() === "") problems.invalid.push(`${key}: no reason`);
    if (verdict.verdict === "redact" && verdict.paths.length === 0) problems.invalid.push(`${key}: no redact paths`);
    for (const reviewed of verdictPaths(verdict)) {
      if (!validPath(reviewed)) problems.invalid.push(`${key}: ${reviewed} is not in the path language`);
    }
  }
  for (const [field, reviewed] of Object.entries(fields)) {
    if (reviewed.reason.trim() === "") problems.invalid.push(`fields ${field}: no reason`);
    if (reviewed.verdict === "keep" && CORE_CREDENTIALS.has(field.toLowerCase())) {
      problems.invalid.push(`fields ${field}: a vendor-wide keep of a credential name`);
    }
  }
  for (const [type, rule] of Object.entries(resources?.rules ?? {})) {
    if (rule.reason.trim() === "") problems.invalid.push(`resource ${type}: no reason`);
    for (const reviewed of [...(rule.paths ?? []), ...(rule.withheld ?? []), ...(rule.verbatim ?? [])]) {
      if (!validPath(reviewed)) problems.invalid.push(`resource ${type}: ${reviewed} is not in the path language`);
    }
    if (rule.when && !review.resourceExamples?.[type]) {
      problems.invalid.push(`resource ${type}: a conditional rule needs an example that makes it hold`);
    }
  }

  // Every reviewed path names something the pinned response schema can return.
  const stamped = candidates.reviewed;
  const check = (label: string, paths: readonly string[], resolved: readonly string[], absent: readonly string[]) => {
    for (const reviewed of new Set(paths)) {
      if (resolved.includes(reviewed) || absent.includes(reviewed)) continue;
      problems.unresolved.push(`${label}: ${reviewed} (not in the pinned response schema; run providers:spec)`);
    }
    for (const reviewed of absent) {
      if (!paths.includes(reviewed)) problems.unresolved.push(`${label}: ${reviewed} acknowledged absent, not in the table`);
      if (resolved.includes(reviewed)) problems.unresolved.push(`${label}: ${reviewed} acknowledged absent, but it resolves`);
    }
    if (!sameSet([...new Set(paths)].filter((reviewed) => !absent.includes(reviewed)), resolved)) {
      problems.unresolved.push(`${label}: stamped paths differ from the table; run providers:spec`);
    }
  };
  for (const [key, verdict] of operations) {
    const paths = verdictPaths(verdict);
    if (paths.length === 0 && !stamped?.operations[key]) continue;
    check(key, paths, stamped?.operations[key] ?? [], review.absent?.operations?.[key] ?? []);
  }
  for (const key of Object.keys(stamped?.operations ?? {})) {
    if (!Object.hasOwn(table.operations, key)) problems.unresolved.push(`${key}: stamped, but the table lacks it`);
  }
  for (const [type, rule] of Object.entries(resources?.rules ?? {})) {
    const paths = [...(rule.paths ?? []), ...(rule.withheld ?? []), ...(rule.verbatim ?? [])];
    check(`resource ${type}`, paths, stamped?.resources[type] ?? [], review.absent?.resources?.[type] ?? []);
  }

  // Every flagged field is accounted for, and the ones a review removes are removed in their schema shape.
  const marker = "SCHEMA-SHAPED-SECRET";
  for (const [key, { fields: flagged }] of Object.entries(candidates.candidates)) {
    const verdict = table.operations[key];
    if (!verdict || verdict.verdict === "refuse") continue;
    const [method, template] = key.split(" ") as [string, string];
    const redacts = verdict.verdict === "redact" ? verdict.paths : [];
    const keeps = verdict.keep ?? [];
    for (const field of flagged) {
      const path = dataPath(field);
      if (path === undefined || path === "") continue;
      const named = segments(path);
      const scoped = named.length > 1 && (table.scopeMaps ?? []).includes(named.at(-2)!);
      const reviewedName = named.find((segment) => Object.hasOwn(fields, segment));
      const covered =
        scoped || reviewedName !== undefined || [...redacts, ...keeps].some((cover) => covers(cover, path));
      if (!covered) {
        problems.uncovered.push(`${key}: ${path}`);
        continue;
      }
      // Reviewed metadata stays: a keep naming the field, a kept field name, or a scope map.
      const kept =
        scoped ||
        keeps.some((cover) => names(cover, path)) ||
        (named.at(-1) !== undefined && fields[named.at(-1)!]?.verdict === "keep");
      if (kept) continue;
      const probes: string[] = [];
      for (const cover of redacts) {
        if (!reaches(cover, path) || /@keys/.test(cover)) continue;
        // A reviewed path deeper than the field names the part of it that goes, lists and maps included.
        const shaped = nest([path, ...beyond(cover, named.length)].join("."), leafFor(cover, marker));
        probes.push(JSON.stringify(decorate(shaped, cover)));
      }
      const fieldReviewed = named.some((segment) => fields[segment]?.verdict === "redact");
      if (fieldReviewed) probes.push(JSON.stringify(nest(path, marker)));
      // Covered only by redact paths, none of which reaches the field as the engine applies it.
      if (probes.length === 0 && reviewedName === undefined && !keeps.some((cover) => covers(cover, path))) {
        problems.shapeLeaks.push(`${key}: ${path} is covered by no redact path that reaches it`);
      }
      for (const probe of probes) {
        const out = JSON.stringify(safety.redact(JSON.parse(probe), method, template));
        if (out.includes(marker)) problems.shapeLeaks.push(`${key}: ${path} survives in ${out}`);
      }
    }
  }

  // Keeps exempt only the reviewed field. One level down, so a reviewed
  // `@keys` redaction of the same map still leaves the secret to find.
  const keepMarker = "KEEP-SUBTREE-SECRET";
  const below = { entry: { access_token: keepMarker, nested: { private_key: keepMarker, api_key: keepMarker } } };
  for (const [key, verdict] of operations) {
    if (verdict.verdict === "refuse") continue;
    const [method, path] = key.split(" ") as [string, string];
    for (const keep of verdict.keep ?? []) {
      if (JSON.stringify(safety.redact(nest(keep, below), method, path)).includes(keepMarker)) {
        problems.keepLeaks.push(`${key}: ${keep}`);
      }
    }
  }
  for (const [field, reviewed] of Object.entries(fields)) {
    if (reviewed.verdict !== "keep") continue;
    if (JSON.stringify(safety.redact({ [field]: below }, "GET", "/")).includes(keepMarker)) {
      problems.keepLeaks.push(`fields: ${field}`);
    }
  }

  // Every redact path and redacted field name removes its value.
  const pathMarker = "REDACT-PATH-SECRET";
  for (const [key, verdict] of operations) {
    if (verdict.verdict !== "redact") continue;
    const [method, path] = key.split(" ") as [string, string];
    for (const reviewed of verdict.paths) {
      // Map keys (`@keys`) need their own shape; their providers test them.
      if (/@keys/.test(reviewed)) continue;
      const out = safety.redact(nest(reviewed, leafFor(reviewed, pathMarker)), method, path);
      if (JSON.stringify(out).includes(pathMarker)) problems.pathLeaks.push(`${key}: ${reviewed}`);
    }
  }
  for (const [field, reviewed] of Object.entries(fields)) {
    if (reviewed.verdict !== "redact") continue;
    if (JSON.stringify(safety.redact({ deep: [{ [field]: pathMarker }] }, "GET", "/")).includes(pathMarker)) {
      problems.pathLeaks.push(`fields: ${field}`);
    }
  }

  // Resource rules hold wherever the object sits, and in partial copies beside it.
  if (resources) {
    const resourceMarker = "RESOURCE-RULE-SECRET";
    for (const [type, rule] of Object.entries(resources.rules)) {
      const example = review.resourceExamples?.[type] ?? {};
      const cases: Array<[string, readonly string[], Record<string, unknown>]> = [
        ["paths", rule.paths ?? [], {}],
        ["withheld", rule.when ? (rule.withheld ?? []) : [], example],
      ];
      for (const [label, paths, extra] of cases) {
        for (const reviewed of paths) {
          if (/@keys/.test(reviewed)) continue;
          const leaf = leafFor(reviewed, resourceMarker);
          const object = { ...(nest(reviewed, leaf) as object), ...extra, [resources.key]: type };
          const placements: Record<string, unknown> = {
            top: object,
            list: { [resources.key]: "list", data: [object] },
            expansion: { [resources.key]: "parent", child: { nested: [object] } },
            ...Object.fromEntries(
              (resources.partials ?? []).map((partial) => [
                `event ${partial}`,
                { [resources.key]: "event", data: { [resources.key]: object, [partial]: nest(reviewed, leaf) } },
              ]),
            ),
          };
          for (const [where, body] of Object.entries(placements)) {
            if (JSON.stringify(safety.redact(body, "GET", "/")).includes(resourceMarker)) {
              problems.resourceLeaks.push(`${type} ${label} ${reviewed}: ${where}`);
            }
          }
        }
      }
      // A reviewed verbatim URL comes back whole only while the rule's condition does not hold.
      for (const field of rule.verbatim ?? []) {
        const url = "https://pay.example.com/c/pay/cs_1#opaque-token-state";
        const plain = safety.redact({ [resources.key]: type, [field]: url }, "GET", "/") as Record<string, unknown>;
        if (plain[field] !== url) problems.resourceLeaks.push(`${type} verbatim ${field}: altered`);
        if (rule.when) {
          const bound = safety.redact({ ...example, [resources.key]: type, [field]: url }, "GET", "/") as Record<
            string,
            unknown
          >;
          if (bound[field] === url) problems.resourceLeaks.push(`${type} verbatim ${field}: kept while withheld`);
        }
      }
    }
  }
  return problems;
}

const EMPTY: ReviewProblems = {
  stale: [],
  unreviewed: [],
  invalid: [],
  unresolved: [],
  uncovered: [],
  shapeLeaks: [],
  keepLeaks: [],
  pathLeaks: [],
  resourceLeaks: [],
};

export function describeValueSafety(name: string, harness: ValueSafetyHarness): void {
  const { table } = harness;
  const operations = Object.entries(table.operations);

  describe(`${name} value safety`, () => {
    it("matches the detection script's credential vocabulary and metadata lists", () => {
      expect(CREDENTIAL_WORDS).toEqual(script.CREDENTIAL_WORDS);
      expect(CREDENTIAL_SUFFIX.source).toBe(script.CREDENTIAL_SUFFIX.source);
      expect(METADATA_SUFFIXES).toEqual(script.METADATA_SUFFIXES);
      expect(METADATA_NAMES).toEqual(script.METADATA_NAMES);
      for (const sample of ["clientSecret", "x-vercel-protection-bypass", "privateKeyPem", "jwt", "tokenId", "input_tokens"]) {
        expect(credentialName(sample), sample).toBe(script.credentialName(sample));
      }
    });

    it("INV-5: reviews every flagged operation, every path against the pinned schema, and every flagged field in its shape", () => {
      expect(reviewProblems(harness)).toEqual(EMPTY);
    });

    it("INV-5: holds the reviewed verdict counts", () => {
      const counts = { refuse: 0, redact: 0, safe: 0 };
      for (const [, verdict] of operations) counts[verdict.verdict] += 1;
      expect(counts).toEqual(harness.counts);
    });

    it("INV-5: a reviewed path removes a client secret by name on any operation", () => {
      const safety = valueSafety(table, () => harness.index);
      expect(safety.redact({ client_secret: "S" }, "GET", "/")).toEqual({ client_secret: REDACTED });
    });

    describe("refusals", () => {
      const realFetch = globalThis.fetch;
      let sent = 0;
      let respond: (() => Response) | undefined;
      beforeEach(() => {
        sent = 0;
        respond = undefined;
        globalThis.fetch = (async () => {
          sent += 1;
          return respond ? respond() : Response.json({});
        }) as typeof fetch;
      });
      afterEach(() => {
        globalThis.fetch = realFetch;
      });

      it("INV-3: the generic tools refuse every refuse verdict before anything is sent", async () => {
        const connector = harness.connector();
        const tool = (kind: string) => `${table.title.toLowerCase()}_api_${kind}`;
        const fill = harness.fill ?? ((template: string) => template.replace(/\{[^}]+\}/g, "x"));
        const reached: string[] = [];
        for (const [key, verdict] of operations) {
          if (verdict.verdict !== "refuse") continue;
          const [method, template] = key.split(" ") as [string, string];
          const read = method === "GET" || method === "HEAD";
          const error = await connector
            .callTool(
              read ? tool("read") : tool("write"),
              { ...(read && method === "GET" ? {} : { method }), path: fill(template) },
              harness.ctx(),
            )
            .then(
              () => undefined,
              (caught: unknown) => caught,
            );
          if (
            !(error instanceof ConnectorCallError) ||
            !error.message.includes(`Connecta refuses ${method} ${template}.`)
          ) {
            reached.push(`${key}: ${error instanceof Error ? error.message : "answered"}`);
          }
        }
        expect(reached).toEqual([]);
        expect(sent).toBe(0);
      });

      it("INV-5: withholds the vendor's error text for a reviewed operation", async () => {
        const marker = "ECHOED-SECRET-VALUE";
        respond = () => harness.echo.respond(marker);
        const error = await harness
          .connector()
          .callTool(harness.echo.tool, harness.echo.args, harness.ctx())
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(ConnectorCallError);
        expect(sent).toBe(1);
        expect((error as ConnectorCallError).message).not.toContain(marker);
      });
    });
  });
}
