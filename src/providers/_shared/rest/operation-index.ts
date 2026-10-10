// The pinned operation index a REST connector validates against before it
// sends anything. `scripts/generate-openapi.mjs` compiles a vendor's OpenAPI
// document into `OpenApiData` (search rows plus request-side details as one
// lazily parsed JSON string); this module reads it. Nothing here does I/O.
//
// The index is the contract: a path no operation matches is refused with the
// nearest operations, and query or body names the operation does not declare
// are refused with the accepted names, because a guessed argument is the most
// common way an agent wastes a call. Drift between the pin and the vendor is
// caught by `providers:check` and refreshed by `providers:spec`.
import { ConnectorCallError, type ArgumentRepairDetails, type ArgumentValidationIssue } from "../../../errors.js";
import type { JsonSchema } from "../../../types.js";

export type RestMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One request-side schema, compacted: `t` type, `e` enum, `f` format (only
 * `binary`), `n` nullable, `d` description, `a` anyOf/oneOf, `p` properties,
 * `r` required, `i` items, `m` additionalProperties, `x` truncated at the
 * generation depth (unvalidated below), `$` a shared subtree.
 */
export interface SchemaNode {
  readonly t?: string | readonly string[];
  readonly e?: readonly unknown[];
  readonly f?: string;
  readonly n?: 1;
  readonly d?: string;
  readonly a?: readonly SchemaNode[];
  readonly p?: Readonly<Record<string, SchemaNode>>;
  readonly r?: readonly string[];
  readonly i?: SchemaNode;
  readonly m?: SchemaNode;
  readonly x?: 1;
  readonly $?: number;
}

/** `[method, path template, operationId, summary, tag index, server index?]` */
type OperationRow = readonly [string, string, string, string, number, number?];

/** What `scripts/generate-openapi.mjs` writes to `openapi.generated.ts`. */
export interface OpenApiData {
  /** The pinned document's URL. */
  readonly source: string;
  /** The pin: a tag, commit, or content hash. */
  readonly revision: string;
  /** `sha256:` digest of the pinned document's bytes. */
  readonly digest: string;
  /** The document's `info.version`; Stripe sends it as `Stripe-Version`. */
  readonly version: string;
  /** `[0]` is the default origin; later entries are per-operation servers. */
  readonly servers: readonly string[];
  readonly tags: readonly string[];
  readonly ops: readonly OperationRow[];
  /** JSON: `{ d: SchemaNode[], o: (0 | [params, body])[] }`, aligned with `ops`. */
  readonly details: string;
}

type ParamRow = readonly [
  name: string,
  at: "path" | "query",
  required: 0 | 1,
  schema: SchemaNode,
  description?: string,
];
type BodyRow = readonly [contentType: string, schema: SchemaNode, required?: 1];
type DetailsRow = readonly [params: readonly ParamRow[], body: 0 | BodyRow];

export interface Operation {
  readonly method: RestMethod;
  /** The path template, e.g. `/v1/customers/{customer}`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tag: string;
  /** A non-default origin this operation is served from, if any. */
  readonly server: string | undefined;
  /** Position in `OpenApiData.ops`. */
  readonly row: number;
}

/** A concrete call matched to its operation. */
export interface OperationMatch {
  readonly op: Operation;
  /** Path parameter values, exactly as the caller sent them. */
  readonly params: Readonly<Record<string, string>>;
}

/** One operation's request contract, expanded to JSON Schema for an agent. */
export interface OperationContract {
  method: RestMethod;
  path: string;
  operationId: string;
  summary: string;
  server?: string;
  parameters: { name: string; in: "path" | "query"; required: boolean; description?: string; schema: JsonSchema }[];
  body?: { contentType: string; required?: true; schema: JsonSchema };
}

const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_ISSUES = 20;

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, issues?: ArgumentValidationIssue[], repair?: ArgumentRepairDetails): never {
  throw new ConnectorCallError("invalid_args", message, {
    ...(issues ? { validation: { issues } } : {}),
    ...(repair ? { repair } : {}),
  });
}

function typesOf(node: SchemaNode): readonly string[] {
  return node.t === undefined ? [] : typeof node.t === "string" ? [node.t] : node.t;
}

/** Edit distance, for naming the parameter a misspelling meant. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The accepted names, bounded and led by the likeliest intended one; repair details carry the full list. */
function oneOf(names: readonly string[], given?: string): string {
  const close =
    given === undefined
      ? undefined
      : names
          .map((name) => ({ name, cost: distance(given.toLowerCase(), name.toLowerCase()) }))
          .filter(({ cost }) => cost <= Math.max(2, Math.floor(given.length / 3)))
          .sort((a, b) => a.cost - b.cost)[0]?.name;
  const shown = names.slice(0, 12).join(", ");
  const list = names.length > 12 ? `one of ${shown}, … (${names.length} in all)` : `one of ${shown}`;
  return close ? `${close}? ${list}` : list;
}

function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/**
 * Split a caller's path into segments, refusing anything that could resolve
 * somewhere other than the operation it was validated as: dot segments in any
 * spelling (the URL parser treats `%2e%2e` as `..`), encoded separators,
 * empty segments, control characters, and unfilled `{placeholders}`.
 */
function segmentsOf(path: string, title: string, search: string): string[] {
  if (typeof path !== "string" || !path.startsWith("/")) {
    invalid(`A ${title} path begins with "/" and names one API operation, such as one ${search} returned.`);
  }
  if (/[?#]/.test(path)) invalid(`A ${title} path carries no query or fragment; put query parameters in query.`);
  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "") invalid(`A ${title} path has no empty segments or trailing slash.`);
    if (/[{}]/.test(segment)) {
      invalid(`The ${title} path still contains a {placeholder}; substitute the real id from an earlier result.`);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return invalid(`A ${title} path segment is not valid percent-encoding.`);
    }
    const control = [...decoded].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f");
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded) || control) {
      invalid(`A ${title} path segment may not be a dot segment, an encoded separator, or a control character.`);
    }
  }
  return segments;
}

/** The read side of one vendor's pinned index. */
export class OperationIndex {
  readonly version: string;
  readonly revision: string;
  readonly ops: readonly Operation[];
  /** The methods any operation uses, in a stable order. */
  readonly methods: readonly RestMethod[];
  readonly #data: OpenApiData;
  readonly #title: string;
  readonly #vendor: string;
  readonly #segments: readonly (readonly string[])[];
  #details: { d: readonly SchemaNode[]; o: readonly (0 | DetailsRow)[] } | undefined;
  #words: readonly { path: Set<string>; summary: Set<string>; id: Set<string> }[] | undefined;

  /** `vendor` is the tool-name prefix; `title` the display name in refusals. */
  constructor(data: OpenApiData, names: { vendor: string; title: string }) {
    const { title } = names;
    this.#data = data;
    this.#title = title;
    this.#vendor = names.vendor;
    this.version = data.version;
    this.revision = data.revision;
    this.ops = data.ops.map(([method, path, operationId, summary, tag, server], row) => {
      if (!METHODS.has(method))
        throw new Error(`${title} operation index row ${row} has unsupported method ${method}.`);
      return Object.freeze({
        method: method as RestMethod,
        path,
        operationId,
        summary,
        tag: data.tags[tag] ?? "",
        server: server === undefined ? undefined : data.servers[server],
        row,
      });
    });
    this.#segments = this.ops.map((op) => op.path.slice(1).split("/"));
    this.methods = [...METHODS].filter((method) => this.ops.some((op) => op.method === method)) as RestMethod[];
  }

  /** The operation with this exact method and path template, if any. */
  operation(method: string, template: string): Operation | undefined {
    return this.ops.find((op) => op.method === method && op.path === template);
  }

  /**
   * Match a concrete call to its operation. Literal segments outrank
   * parameters, as OpenAPI requires (`/v1/customers/search` before
   * `/v1/customers/{customer}`); the most specific template that fits decides,
   * and a method it does not define is refused rather than retried against a
   * looser template.
   */
  resolve(method: string, path: string): OperationMatch {
    const segments = segmentsOf(path, this.#title, this.#vendorTool("search"));
    let best: { score: number; rows: number[] } = { score: -1, rows: [] };
    this.#segments.forEach((template, row) => {
      if (template.length !== segments.length) return;
      let score = 0;
      for (const [index, part] of template.entries()) {
        if (part.startsWith("{")) continue;
        if (part !== segments[index]) return;
        score += 1;
      }
      if (score > best.score) best = { score, rows: [row] };
      else if (score === best.score) best.rows.push(row);
    });
    if (best.rows.length === 0) {
      invalid(
        `${this.#title} has no ${path} operation in the pinned API index (${this.revision}). ` +
          `Nearest: ${this.nearest(method, segments).join("; ")}. Find operations with ${this.#vendorTool("search")}.`,
      );
    }
    const templates = new Set(best.rows.map((row) => this.ops[row]!.path));
    const op = best.rows.map((row) => this.ops[row]!).find((candidate) => candidate.method === method);
    if (!op) {
      const allowed = [...new Set(best.rows.map((row) => this.ops[row]!.method))].join(", ");
      invalid(`${this.#title} ${[...templates].join(" or ")} accepts ${allowed}, not ${method}.`);
    }
    const template = this.#segments[op.row]!;
    const params: Record<string, string> = {};
    template.forEach((part, index) => {
      if (part.startsWith("{")) params[part.slice(1, -1)] = segments[index]!;
    });
    return { op, params };
  }

  /** Up to five operations whose paths most resemble a missed one. */
  nearest(method: string, segments: readonly string[]): string[] {
    // Shared leading characters, so `customer` sits next to `customers`.
    const likeness = (a: string, b: string): number => {
      let same = 0;
      while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
      return same / Math.max(a.length, b.length, 1);
    };
    const scored = this.ops.map((op) => {
      const template = this.#segments[op.row]!;
      let score = 0;
      for (let index = 0; index < Math.min(template.length, segments.length); index += 1) {
        const part = template[index]!;
        score += part.startsWith("{") ? 0.6 : likeness(part, segments[index]!) * 2;
      }
      score -= Math.abs(template.length - segments.length) * 0.75;
      if (op.method === method) score += 0.25;
      return { op, score };
    });
    return scored
      .sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length)
      .slice(0, 5)
      .map(({ op }) => `${op.method} ${op.path}`);
  }

  /**
   * Rank operations for a free-text query: every query word must appear in
   * the path, summary, operationId, or tag (plural-insensitive, prefixes of
   * three letters count), and path matches weigh most. A query that starts
   * with "/" also matches the templates that fit it.
   */
  search(query: string, options: { method?: RestMethod; limit: number }): Operation[] {
    this.#words ??= this.ops.map((op) => ({
      path: new Set(
        op.path
          .split("/")
          .filter((part) => !part.startsWith("{"))
          .flatMap(words)
          .concat(words(op.tag)),
      ),
      summary: new Set(words(op.summary)),
      id: new Set(words(op.operationId)),
    }));
    const terms = [...new Set(words(query))];
    const candidates = this.ops.filter((op) => options.method === undefined || op.method === options.method);
    const fits = new Set<number>();
    if (query.trim().startsWith("/")) {
      const path = query.trim().split(/\s/)[0]!;
      for (const op of candidates) {
        try {
          if (this.resolve(op.method, path).op.row === op.row) fits.add(op.row);
        } catch {
          // Not this template.
        }
      }
    }
    const match = (set: Set<string>, term: string): number => {
      if (set.has(term)) return 2;
      for (const word of set) {
        if (word === `${term}s` || term === `${word}s` || word === `${term}es` || term === `${word}es`) return 2;
        if (term.length >= 3 && word.startsWith(term)) return 1;
      }
      return 0;
    };
    const ranked = candidates.flatMap((op) => {
      const indexed = this.#words![op.row]!;
      let score = fits.has(op.row) ? 100 : 0;
      let matched = 0;
      for (const term of terms) {
        const path = match(indexed.path, term);
        const summary = match(indexed.summary, term);
        const id = match(indexed.id, term);
        if (path + summary + id > 0) matched += 1;
        score += path * 3 + summary * 1.5 + id;
      }
      if (!fits.has(op.row) && (terms.length === 0 || matched < terms.length)) return [];
      return [{ op, score }];
    });
    return ranked
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.op.path.split("/").length - b.op.path.split("/").length ||
          a.op.path.localeCompare(b.op.path),
      )
      .slice(0, options.limit)
      .map(({ op }) => op);
  }

  /** Whether the operation takes a body, and in which framing. */
  bodyType(op: Operation): string | undefined {
    const row = this.#row(op);
    return row && row[1] !== 0 ? row[1][0] : undefined;
  }

  /** The operation's request contract as JSON Schema, optionally one parameter only. */
  contract(op: Operation, only?: string): OperationContract {
    const row = this.#row(op);
    const parameters = (row ? row[0] : [])
      .filter(([name]) => only === undefined || name === only)
      .map(([name, at, required, schema, description]) => ({
        name,
        in: at,
        required: required === 1,
        ...(description ? { description } : {}),
        schema: this.#schema(schema),
      }));
    let body: OperationContract["body"];
    if (row && row[1] !== 0) {
      const [contentType, schema] = row[1];
      const node = this.#deref(schema);
      if (only !== undefined && node.p?.[only] !== undefined) {
        body = {
          contentType,
          schema: {
            type: "object",
            properties: { [only]: this.#schema(node.p[only]!) },
            ...(node.r?.includes(only) ? { required: [only] } : {}),
          },
        };
      } else if (only === undefined) {
        body = { contentType, ...(row[1][2] === 1 ? { required: true } : {}), schema: this.#schema(schema) };
      }
    }
    if (only !== undefined && parameters.length === 0 && body === undefined) {
      invalid(`${op.method} ${op.path} has no parameter named ${only}.`);
    }
    return {
      method: op.method,
      path: op.path,
      operationId: op.operationId,
      summary: op.summary,
      ...(op.server ? { server: op.server } : {}),
      parameters,
      ...(body ? { body } : {}),
    };
  }

  /**
   * Check query and body names, required members, enums, and object/array
   * shapes against the operation, to the depth the index carries. Scalars are
   * not type-policed beyond that: vendors coerce form strings, and a wrong
   * number is the vendor's to explain. `null` and `""` pass anywhere, since
   * they are how form APIs unset a field.
   */
  check(op: Operation, query: Readonly<Record<string, unknown>>, body: unknown): void {
    const row = this.#row(op);
    const issues: ArgumentValidationIssue[] = [];
    const repair: ArgumentRepairDetails["issues"] = [];
    const declared = (row ? row[0] : []).filter(([, at]) => at === "query");
    const accepted = declared.map(([name]) => name);
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      const param = declared.find(([key]) => key === name);
      if (!param) {
        issues.push({
          path: `/query/${name}`,
          code: "additionalProperties",
          expected: accepted.length ? oneOf(accepted, name) : "no query parameters",
        });
        repair.push({ path: `/query/${name}`, receivedType: valueType(value), acceptedKeys: accepted });
        continue;
      }
      this.#check(param[3], value, `/query/${name}`, issues, repair);
    }
    for (const [name, , required] of declared) {
      if (required === 1 && query[name] === undefined) {
        issues.push({ path: `/query/${name}`, code: "required", expected: "a value" });
      }
    }
    const bodyRow = row && row[1] !== 0 ? row[1] : undefined;
    if (body !== undefined) {
      if (!bodyRow) {
        issues.push({ path: "/body", code: "false", expected: "no body for this operation" });
      } else {
        this.#check(bodyRow[1], body, "/body", issues, repair);
      }
    } else if (bodyRow?.[2] === 1) {
      // An optional body may be omitted whole; a required one may not.
      issues.push({ path: "/body", code: "required", expected: `a ${bodyRow[0]} body` });
    }
    if (issues.length > 0) {
      const shown = issues
        .slice(0, 5)
        .map((issue) => `${issue.path} (${issue.code}: ${issue.expected})`)
        .join("; ");
      invalid(
        `Not sent: the arguments do not match ${op.method} ${op.path} in the pinned API index: ${shown}` +
          `${issues.length > 5 ? `; ${issues.length - 5} more` : ""}. Read ${this.#vendorTool("details")} for the contract.`,
        issues.slice(0, MAX_ISSUES),
        repair.length ? { issues: repair.slice(0, 5) } : undefined,
      );
    }
  }

  #vendorTool(kind: string): string {
    return `${this.#vendor}_api_${kind}`;
  }

  #row(op: Operation): DetailsRow | undefined {
    this.#details ??= JSON.parse(this.#data.details) as { d: SchemaNode[]; o: (0 | DetailsRow)[] };
    const row = this.#details.o[op.row];
    return row === 0 ? undefined : row;
  }

  #deref(node: SchemaNode): SchemaNode {
    let current = node;
    for (let hops = 0; current.$ !== undefined && hops < 32; hops += 1) {
      current = this.#details!.d[current.$] ?? {};
    }
    return current;
  }

  #schema(node: SchemaNode): JsonSchema {
    const resolved = this.#deref(node);
    const out: Record<string, unknown> = {};
    if (resolved.t !== undefined) out["type"] = resolved.t;
    if (resolved.d !== undefined) out["description"] = resolved.d;
    if (resolved.e !== undefined) out["enum"] = resolved.e;
    if (resolved.f !== undefined) out["format"] = resolved.f;
    if (resolved.n === 1) out["nullable"] = true;
    if (resolved.a) out["anyOf"] = resolved.a.map((branch) => this.#schema(branch));
    if (resolved.p) {
      out["properties"] = Object.fromEntries(
        Object.entries(resolved.p).map(([key, value]) => [key, this.#schema(value)]),
      );
    }
    if (resolved.r) out["required"] = resolved.r;
    if (resolved.i) out["items"] = this.#schema(resolved.i);
    if (resolved.m) out["additionalProperties"] = this.#schema(resolved.m);
    if (resolved.x === 1) out["truncated"] = true;
    return out as JsonSchema;
  }

  #check(
    node: SchemaNode,
    value: unknown,
    at: string,
    issues: ArgumentValidationIssue[],
    repair: ArgumentRepairDetails["issues"],
  ): void {
    if (issues.length >= MAX_ISSUES) return;
    const schema = this.#deref(node);
    if (schema.x === 1) return;
    // Conflicting composed constraints (disjoint enums or types) admit nothing,
    // not even the null or "" that otherwise unsets a field.
    if (schema.e?.length === 0) {
      issues.push({ path: at, code: "enum", expected: "no value: this field's combined constraints admit none" });
      return;
    }
    if (value === null || value === "") return;
    if (schema.a) {
      let fewest: { issues: ArgumentValidationIssue[]; repair: ArgumentRepairDetails["issues"] } | undefined;
      for (const branch of schema.a) {
        const attempt = { issues: [] as ArgumentValidationIssue[], repair: [] as ArgumentRepairDetails["issues"] };
        this.#check(branch, value, at, attempt.issues, attempt.repair);
        if (attempt.issues.length === 0) return;
        if (!fewest || attempt.issues.length < fewest.issues.length) fewest = attempt;
      }
      if (fewest) {
        issues.push(...fewest.issues);
        repair.push(...fewest.repair);
      }
      return;
    }
    const types = typesOf(schema);
    if (schema.e && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      if (!schema.e.some((option) => option === value || String(option) === String(value))) {
        issues.push({ path: at, code: "enum", expected: oneOf(schema.e.map(String)) });
      }
      return;
    }
    if (schema.p || types.includes("object")) {
      if (!isRecord(value)) {
        if (types.length === 0 || types.includes("object")) {
          issues.push({ path: at, code: "type", expected: "object" });
        }
        return;
      }
      const properties = schema.p ?? {};
      const accepted = Object.keys(properties);
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const child = properties[key];
        if (child) this.#check(child, item, `${at}/${key}`, issues, repair);
        else if (schema.m) this.#check(schema.m, item, `${at}/${key}`, issues, repair);
        else if (schema.p) {
          issues.push({
            path: `${at}/${key}`,
            code: "additionalProperties",
            expected: accepted.length ? oneOf(accepted, key) : "no properties",
          });
          repair.push({ path: `${at}/${key}`, receivedType: valueType(item), acceptedKeys: accepted });
        }
      }
      for (const key of schema.r ?? []) {
        if (value[key] === undefined) issues.push({ path: `${at}/${key}`, code: "required", expected: "a value" });
      }
      return;
    }
    if (schema.i || types.includes("array")) {
      if (!Array.isArray(value)) {
        issues.push({ path: at, code: "type", expected: "array" });
        return;
      }
      if (schema.i) value.forEach((item, index) => this.#check(schema.i!, item, `${at}/${index}`, issues, repair));
      return;
    }
    if (types.length > 0 && (isRecord(value) || Array.isArray(value))) {
      issues.push({ path: at, code: "type", expected: types.join(" or ") });
    }
  }
}
