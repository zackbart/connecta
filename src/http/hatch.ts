// Internal kit hatch (decisions 0010 B.4, 0011 S1, 0014). Unreachable from src/index.ts.
// The operation index validates requests; only an explicit verdict routes
// them. Connection.sendPath owns admission, dispatch and result safety.
//
// Argument and envelope names follow the REST family's hatch (`path`,
// `method`, `query`, `body`, `{ status, data }`), with S5's `fields` for its
// `select`. Discovery stays inside 0014's budget: search returns compact
// entries (8 at most, 16 KiB of JSON at most, with an explicit continuation
// cursor) and details return at most 32 KiB, cutting only optional parts and
// listing them in `truncated`; a required parameter or body field is never cut.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import {
  type Operation,
  type OperationContract,
  type OperationIndex,
  type RestMethod,
} from "../providers/_shared/rest/operation-index.js";
import { refuseWithheldLinks } from "../providers/_shared/rest/value-safety.js";
import { Refusal } from "./errors.js";
import { dataKeys, fieldsInput, fieldsProblem, selectFields } from "./fields.js";
import { Integer, isMaxChars, isMinChars } from "./json-schema.js";
import { boundCursor, StandardPage } from "./paging.js";
import { operationFields, type OperationField } from "./vendor-index.js";
import { read, write } from "./tools.js";
import type { Connection } from "./vendor.js";
import type { Parameters, WriteRequest } from "./write-request.js";

type Verdict = "read" | "write" | "destructive" | "refuse";
interface CallArgs {
  readonly method?: RestMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly fields?: readonly string[];
}
type OperationKey = `${RestMethod} ${string}`;

/** 0014's starting discovery budgets, measured as serialized JSON bytes of the tool's own result. */
export const SEARCH_BUDGET = { hits: 6, maxHits: 8, bytes: 16 * 1024, summaryChars: 300 } as const;
export const DETAILS_BUDGET_BYTES = 32 * 1024;

/** What a provider declares; the kit adds the connection. */
export interface HatchDeclaration {
  /** Tool prefix: `<name>_api_search`, `_details`, `_read`, `_write`. */
  readonly name: string;
  /** Display name in descriptions; defaults to `name`. */
  readonly title?: string;
  readonly index: OperationIndex;
  readonly verdicts: Readonly<Record<OperationKey, Verdict>>;
  /** The authored tool serving an operation: search names it so agents prefer it, and the hatch stays callable. */
  readonly named?: Readonly<Record<OperationKey, string>>;
  /** A concrete path for the path argument's description. */
  readonly pathExample?: string;
}

const text = (min: number, max: number) => Schema.String.check(isMinChars(min), isMaxChars(max));
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const Envelope = Schema.Struct({
  status: Integer.annotate({ description: "HTTP status." }),
  data: Schema.Unknown.pipe(
    Schema.annotateKey({ description: "Response body after value safety and the connection's privacy filtering." }),
  ),
});
const HATCH_FIELDS = fieldsInput(
  "Dot paths to keep in data, applied to each item of an array, after value safety and privacy filtering.",
);

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

/** Keep the index's structured argument repairs, while unexpected failures remain withheld defects. */
function checked<A>(run: () => A) {
  return Effect.try({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The binding carries ordered string pairs, preserving scalar arrays as repeated parameters. */
function parameters(values: Readonly<Record<string, unknown>>): Parameters {
  return Object.entries(values).flatMap(([name, value]): Array<[string, string]> => {
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((item) => {
      if (
        typeof item !== "string" &&
        typeof item !== "boolean" &&
        !(typeof item === "number" && Number.isFinite(item))
      ) {
        invalid(`Parameter ${name} takes a string, finite number, boolean, or a list of them.`);
      }
      return [name, String(item)];
    });
  });
}

/**
 * Fit a contract inside the details budget by cutting optional parts only:
 * first optional body property schemas, then optional parameter schemas.
 * Names stay, so `param` fetches any one in full.
 */
function withinBudget<T extends { parameters: OperationContract["parameters"]; body?: OperationContract["body"] }>(
  contract: T,
): T & { truncated?: string[] } {
  // Leave room for the verdict, routing and revision the tool adds.
  const budget = DETAILS_BUDGET_BYTES - 512;
  if (bytes(contract) <= budget) return contract;
  const truncated: string[] = [];
  const out = structuredClone(contract) as T & { truncated?: string[] };
  const fits = () => bytes({ ...out, truncated }) <= budget;
  const schema = out.body?.schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const required = new Set(schema?.required ?? []);
  for (const name of Object.keys(schema?.properties ?? {}).reverse()) {
    if (fits()) break;
    if (required.has(name)) continue;
    schema!.properties![name] = {};
    truncated.push(`body.schema.properties.${name}`);
  }
  if (!fits() && out.parameters.some((parameter) => !parameter.required)) {
    out.parameters = out.parameters.map((parameter) =>
      parameter.required ? parameter : ({ name: parameter.name, in: parameter.in, required: false } as never),
    );
    truncated.push("parameters[].schema", "parameters[].description");
  }
  return { ...out, truncated };
}

/** The standard hatch over an operation index; a missing verdict refuses every method. */
export function hatch(
  options: HatchDeclaration & {
    readonly connection: Connection;
    /** Connection-dependent sentences appended to the read and write descriptions, such as the privacy mode. */
    readonly notes?: { readonly read?: string; readonly write?: string };
  },
): ApiTool[] {
  const { name, index, connection } = options;
  const title = options.title ?? name;
  if (!name.trim()) throw new Error("A hatch needs a nonempty tool prefix.");
  const known = (key: string) => index.ops.some((op) => `${op.method} ${op.path}` === key);
  // Snapshot reviews: a retained declaration cannot widen a served hatch.
  const verdicts = new Map(Object.entries(options.verdicts));
  for (const [key, verdict] of verdicts) {
    if (!known(key)) throw new Error(`Hatch verdict ${key} is not in the API index.`);
    if (!["read", "write", "destructive", "refuse"].includes(verdict)) {
      throw new Error(`Hatch verdict ${key} must be read, write, destructive, or refuse.`);
    }
  }
  const named = new Map(Object.entries(options.named ?? {}));
  for (const [key, tool] of named) {
    if (!known(key) || !tool.trim()) throw new Error(`Hatch named tool for ${key} needs an indexed operation.`);
  }
  const verdictOf = (op: Operation): Verdict => verdicts.get(`${op.method} ${op.path}`) ?? "refuse";
  const tool = (kind: string) => `${name}_api_${kind}`;
  const route = (op: Operation) => {
    const verdict = verdictOf(op);
    const authored = named.get(`${op.method} ${op.path}`);
    return {
      ...(verdict === "refuse" ? {} : { tool: tool(verdict === "read" ? "read" : "write") }),
      ...(authored ? { named: authored } : {}),
    };
  };
  // 0014: exact path nouns and root collections ahead of related resources,
  // and authored operations ahead of equal ones, over the index's own order.
  const rank = (found: readonly Operation[], query: string): Operation[] => {
    const terms = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const literal = (op: Operation) => op.path.split("/").filter((part) => part && !part.startsWith("{"));
    const exact = (op: Operation) =>
      literal(op).some((part) =>
        part
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .some((word) => terms.has(word)),
      );
    const order = new Map(found.map((op, position) => [op, position]));
    const lead = found
      .filter(exact)
      .sort(
        (a, b) =>
          a.path.split("/").length - b.path.split("/").length ||
          Number(named.has(`${b.method} ${b.path}`)) - Number(named.has(`${a.method} ${a.path}`)) ||
          order.get(a)! - order.get(b)!,
      );
    return [...lead, ...found.filter((op) => !exact(op))];
  };
  // Find operations by the request or response properties they declare: a
  // query word must equal a word of a property's name. Rarer words weigh more,
  // and words most operations' own records carry (id, status) decide nothing.
  // Reads, then the shallowest best match, lead.
  const words = (text: string) =>
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2);
  const same = (term: string, word: string) => term === word || term === `${word}s` || word === `${term}s`;
  const byField = (query: string, method: RestMethod | undefined, found: ReadonlySet<Operation>) => {
    const candidates = index.ops.filter((op) => method === undefined || op.method === method);
    const leaf = (field: OperationField) => words(field.path.split(".").at(-1)!);
    // Commonness counts the record's own properties, not those of records embedded in it.
    const carries = (op: Operation, term: string) =>
      operationFields(index, op).some(
        (field) => field.path.split(".").length <= 2 && leaf(field).some((word) => same(term, word)),
      );
    const weights = new Map(
      [...new Set(words(query))].flatMap((term) => {
        const share = candidates.filter((op) => carries(op, term)).length;
        return share > 0 && share <= Math.max(1, (candidates.length * 2) / 3)
          ? [[term, Math.log2(1 + candidates.length / share)] as const]
          : [];
      }),
    );
    if (weights.size === 0) return [];
    const order = new Map(index.ops.map((op, position) => [op, position]));
    return candidates
      .filter((op) => !found.has(op))
      .flatMap((op) => {
        const best = operationFields(index, op)
          .map((field) => ({
            field,
            score: [...weights].reduce(
              (sum, [term, weight]) => sum + (leaf(field).some((word) => same(term, word)) ? weight : 0),
              0,
            ),
            depth: field.path.split(".").length + (field.in === "body" ? 0.5 : 0),
          }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.depth - b.depth)[0];
        return best ? [{ op, ...best }] : [];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.op.method === "GET") - Number(a.op.method === "GET") ||
          a.depth - b.depth ||
          a.op.path.split("/").length - b.op.path.split("/").length ||
          order.get(a.op)! - order.get(b.op)!,
      )
      .map(({ op, field }) => ({ op, field }));
  };
  const methodsWith = (wanted: (verdict: Verdict) => boolean) =>
    index.methods.filter((method) => index.ops.some((op) => op.method === method && wanted(verdictOf(op))));
  const readMethods = methodsWith((verdict) => verdict === "read");
  const writeMethods = methodsWith((verdict) => verdict === "write" || verdict === "destructive");
  const Method = Schema.Literals(index.methods);
  const Path = text(2, 2048).annotate({
    description: `Concrete path from search with ids filled in${options.pathExample ? `, e.g. ${options.pathExample}` : ""}. No query string.`,
  });
  const Query = ObjectValue.annotate({ description: "Query parameters as JSON, named as details lists them." });
  const Routing = {
    tool: Schema.optionalKey(Schema.String.annotate({ description: "The tool that calls it; absent when refused." })),
    named: Schema.optionalKey(
      Schema.String.annotate({
        description: "A named tool serving this operation with a projected result; prefer it.",
      }),
    ),
  };
  const Matched = Schema.optionalKey(
    Schema.String.annotate({
      description: "The request or response field this operation was found by; call its tool to read the field.",
    }),
  );
  const searchTool = tool("search");
  const tools = [
    read(connection, {
      name: searchTool,
      description: `Find ${title} API operations by keyword or path. Returns up to ${SEARCH_BUDGET.maxHits} compact matches with the tool that calls each; reads no account data.`,
      input: Schema.Struct({
        query: text(1, 200).annotate({ description: "Keywords or a path, e.g. refund charge." }),
        method: Schema.optionalKey(Method.annotate({ description: "Only operations with this method." })),
        limit: Schema.optionalKey(
          Integer.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_BUDGET.maxHits })).annotate({
            description: "Most operations to return.",
            default: SEARCH_BUDGET.hits,
          }),
        ),
        cursor: Schema.optionalKey(
          text(1, 512).annotate({ description: "page.nextCursor from the previous search with the same query." }),
        ),
      }),
      output: Schema.Struct({
        operations: Schema.Array(
          Schema.Struct({
            method: Method,
            path: Schema.String,
            operationId: Schema.String,
            summary: Schema.String,
            ...Routing,
            matched: Matched,
          }),
        ),
        revision: Schema.String.annotate({ description: "Operation index revision." }),
        page: StandardPage,
      }),
      run: (args) =>
        Effect.gen(function* () {
          const scope = { query: args.query, ...(args.method ? { method: args.method } : {}) };
          const offset =
            args.cursor === undefined ? 0 : Number(yield* boundCursor.decode(searchTool, scope, args.cursor));
          if (!Number.isSafeInteger(offset) || offset < 0)
            return yield* Effect.fail(
              new Refusal({
                error: new ConnectorCallError("invalid_args", "This search cursor is not one search returned."),
              }),
            );
          const primary = rank(
            yield* checked(() => index.search(args.query, { ...scope, limit: index.ops.length })),
            args.query,
          );
          // Operations found only by a field they return or take rank after every path, id or summary match.
          const ranked: Array<{ op: Operation; field?: OperationField }> = [
            ...primary.map((op) => ({ op })),
            ...byField(args.query, args.method, new Set(primary)),
          ];
          const operations = ranked.slice(offset, offset + (args.limit ?? SEARCH_BUDGET.hits)).map(({ op, field }) => {
            const { named: authored, ...routed } = route(op);
            return {
              method: op.method,
              path: op.path,
              operationId: op.operationId,
              summary:
                op.summary.length > SEARCH_BUDGET.summaryChars
                  ? `${op.summary.slice(0, SEARCH_BUDGET.summaryChars - 1)}…`
                  : op.summary,
              ...routed,
              // A named tool's projection may omit the matched field, so a field match points at the hatch only.
              ...(field ? { matched: `${field.in} field ${field.path}` } : authored ? { named: authored } : {}),
            };
          });
          // The budget holds before the result leaves the tool; what it cuts stays reachable by cursor.
          while (operations.length > 1 && bytes({ operations, revision: index.revision }) > SEARCH_BUDGET.bytes)
            operations.pop();
          const next = offset + operations.length;
          return {
            operations,
            revision: index.revision,
            page:
              next < ranked.length
                ? { hasMore: true, nextCursor: yield* boundCursor.encode(searchTool, scope, String(next)) }
                : { hasMore: false },
          };
        }),
    }),
    read(connection, {
      name: tool("details"),
      description: `Read one ${title} API operation's request contract: path, query and body parameters with types and required names. Reads no account data.`,
      input: Schema.Struct({
        method: Method.annotate({ description: "The operation's HTTP method." }),
        path: Path.annotate({ description: "The path template from search, or a concrete path." }),
        param: Schema.optionalKey(text(1, 200).annotate({ description: "Return only this parameter, in full." })),
      }),
      output: Schema.Struct({
        method: Method,
        path: Schema.String,
        operationId: Schema.String,
        summary: Schema.String,
        server: Schema.optionalKey(Schema.String),
        parameters: Schema.Array(Schema.Unknown).annotate({ description: "Path and query parameters." }),
        body: Schema.optionalKey(
          ObjectValue.annotate({ description: "Body content type and schema; required names are always complete." }),
        ),
        verdict: Schema.Literals(["read", "write", "destructive", "refuse"]),
        ...Routing,
        revision: Schema.String,
        truncated: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "Optional parts cut for size; read one in full with param.",
          }),
        ),
      }),
      run: (args) =>
        checked(() => {
          const op = index.operation(args.method, args.path) ?? index.resolve(args.method, args.path).op;
          const contract = index.contract(op, args.param);
          return {
            ...(args.param === undefined ? withinBudget(contract) : contract),
            verdict: verdictOf(op),
            ...route(op),
            revision: index.revision,
          };
        }),
    }),
  ];

  const run = (kind: "read" | "write", args: CallArgs) =>
    checked((): WriteRequest => {
      const method = args.method ?? "GET";
      const { op } = index.resolve(method, args.path);
      const verdict = verdictOf(op);
      if (verdict === "refuse") invalid(`Connecta refuses ${method} ${op.path}: it has no admitted hatch verdict.`);
      if ((verdict === "read") !== (kind === "read")) {
        invalid(`${method} ${op.path} must be called with ${tool(verdict === "read" ? "read" : "write")}.`);
      }
      // The current path binding has one origin and JSON/form bodies. Do not
      // silently send another server's operation or reinterpret an upload.
      if (op.server) invalid(`${method} ${op.path} uses a different server; this connection cannot send it.`);
      const contentType = index.bodyType(op)?.split(";", 1)[0]!.trim().toLowerCase();
      if (
        contentType &&
        contentType !== "application/x-www-form-urlencoded" &&
        !/^application\/(?:[^/]+\+)?json$/.test(contentType)
      ) {
        invalid(
          `${method} ${op.path} takes ${contentType}; this connection's path binding supports only JSON and form bodies.`,
        );
      }
      const query = args.query ?? {};
      if ((method === "GET" || method === "HEAD") && args.body !== undefined)
        invalid(`A ${method} operation takes query, not body.`);
      if (kind === "write") refuseWithheldLinks({ path: args.path, query, body: args.body }, name);
      index.check(op, query, args.body);
      return {
        method,
        path: args.path,
        template: op.path,
        query: parameters(query),
        ...(args.body === undefined
          ? {}
          : contentType === "application/x-www-form-urlencoded"
            ? { form: parameters(record(args.body) ? args.body : invalid("A form body must be an object.")) }
            : { json: JSON.stringify(args.body) }),
      };
    }).pipe(
      Effect.flatMap((request) => connection.sendPath(request)),
      Effect.flatMap((answer) =>
        checked(() => {
          const data = answer.data === undefined ? null : answer.data;
          const problem = fieldsProblem(args.fields, dataKeys(data), "data");
          if (problem) throw problem;
          return { status: answer.status, data: selectFields(data, args.fields) };
        }),
      ),
    );

  const note = (sentence: string | undefined) => (sentence ? ` ${sentence}` : "");
  const nonGetReads = readMethods.filter((method) => method !== "GET" && method !== "HEAD");
  // Field order follows the REST hatch: path, method, body, query, then fields.
  const readFields: Record<string, Schema.Top & { readonly DecodingServices: never }> = { path: Path };
  if (readMethods.length > 1)
    readFields["method"] = Schema.optionalKey(
      Schema.Literals(readMethods).annotate({
        description: "GET by default; another method only for an operation search routes here.",
      }),
    );
  if (nonGetReads.length)
    readFields["body"] = Schema.optionalKey(
      ObjectValue.annotate({ description: "Body for a reviewed read-only POST." }),
    );
  readFields["query"] = Schema.optionalKey(Query);
  readFields["fields"] = Schema.optionalKey(HATCH_FIELDS);
  const readSpec = {
    name: tool("read"),
    description: `Call a reviewed ${title} API read${nonGetReads.length ? `, including reviewed read-only ${nonGetReads.join(" and ")}` : ""}. The operation index checks arguments before anything is sent.${note(options.notes?.read)}`,
    input: Schema.Struct(readFields),
    output: Envelope,
    // The explicit per-operation read table replaces REST readPosts. The
    // builder's review permits its non-GET reads; run checks the exact row.
    review: "Only operations explicitly classified read in the hatch's snapshotted verdict table are admitted.",
  };
  // Let the Schema infer the program arguments rather than the shared field declarations.
  tools.push(read(connection, { ...readSpec, run: (args) => run("read", args as unknown as CallArgs) }));
  if (writeMethods.length > 0) {
    tools.push(
      write(connection, {
        name: tool("write"),
        description: `Call a reviewed ${title} API write; method and path are stated for approval, and the operation index checks arguments first.${note(options.notes?.write)}`,
        input: Schema.Struct({
          method: Schema.Literals(writeMethods).annotate({ description: "The operation's HTTP method." }),
          path: Path,
          query: Schema.optionalKey(Query),
          body: Schema.optionalKey(
            Schema.Union([ObjectValue, Schema.Array(Schema.Unknown)]).annotate({
              description:
                "Request body as JSON fields, named as details lists them; form operations are encoded for you.",
            }),
          ),
          fields: Schema.optionalKey(HATCH_FIELDS),
        }),
        output: Envelope,
        destructive: true,
        run: (args) => run("write", args),
      }),
    );
  }
  return tools;
}
