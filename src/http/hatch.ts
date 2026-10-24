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
  type OperationField,
  type OperationIndex,
  type RestMethod,
} from "../providers/_shared/rest/operation-index.js";
import { refuseWithheldValues } from "../providers/_shared/rest/value-safety.js";
import { Refusal } from "./errors.js";
import { fieldsInput, fieldsProblem, selectFields } from "./fields.js";
import { Integer, isMaxChars, isMinChars } from "./json-schema.js";
import { boundCursor, StandardPage } from "./paging.js";
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

/** A method enum; a single method renders as a plain enum, not a one-branch anyOf. */
function methodEnum(methods: readonly RestMethod[]) {
  return methods.length === 1 ? Schema.Literal(methods[0]!) : Schema.Literals(methods);
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

const cap = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** One piece of a contract that may travel alone: a parameter, a body property, the body, or a long label. */
type Piece =
  | { readonly kind: "parameter"; readonly of: string; readonly value: OperationContract["parameters"][number] }
  | { readonly kind: "frame"; readonly of: string; readonly value: Readonly<Record<string, unknown>> }
  | {
      readonly kind: "property";
      readonly of: string;
      readonly name: string;
      readonly value: unknown;
      readonly required: boolean;
    }
  | { readonly kind: "body"; readonly of: string; readonly value: unknown }
  | { readonly kind: "text"; readonly of: "operationId" | "summary"; readonly value: string };

/**
 * Every piece of a contract, in order: long labels, parameters, then the body.
 * An object body travels as its frame (every keyword but `properties` and
 * `required`: type, description, additionalProperties, …) and one piece per
 * property, each carrying whether it is required, so pages and chunks
 * together reconstruct the whole schema. Any other body travels whole.
 */
function piecesOf(contract: OperationContract, capped: { operationId: boolean; summary: boolean }): Piece[] {
  const schema = contract.body?.schema as Record<string, unknown> | undefined;
  const properties = schema?.["properties"];
  const required = new Set(Array.isArray(schema?.["required"]) ? (schema["required"] as string[]) : []);
  const object = properties !== null && typeof properties === "object" && !Array.isArray(properties);
  const frame = object
    ? Object.fromEntries(Object.entries(schema!).filter(([key]) => key !== "properties" && key !== "required"))
    : undefined;
  return [
    ...(capped.operationId ? [{ kind: "text" as const, of: "operationId" as const, value: contract.operationId }] : []),
    ...(capped.summary ? [{ kind: "text" as const, of: "summary" as const, value: contract.summary }] : []),
    ...contract.parameters.map((value) => ({ kind: "parameter" as const, of: `parameters.${value.name}`, value })),
    ...(contract.body === undefined
      ? []
      : frame
        ? [
            { kind: "frame" as const, of: "body.schema", value: frame },
            ...Object.entries(properties as Record<string, unknown>).map(([name, value]) => ({
              kind: "property" as const,
              of: `body.schema.properties.${name}`,
              name,
              value,
              required: required.has(name),
            })),
          ]
        : [{ kind: "body" as const, of: "body.schema", value: contract.body.schema }]),
  ];
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
  // and words three in four operations carry (id, status) decide nothing.
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
    // Eligibility and rarity count every declared path, nested ones included; depth only lowers rank.
    const carries = (op: Operation, term: string) =>
      index.fields(op).some((field) => leaf(field).some((word) => same(term, word)));
    const weights = new Map(
      [...new Set(words(query))].flatMap((term) => {
        const share = candidates.filter((op) => carries(op, term)).length;
        return share > 0 && share <= Math.max(1, (candidates.length * 3) / 4)
          ? [[term, Math.log2(1 + candidates.length / share)] as const]
          : [];
      }),
    );
    if (weights.size === 0) return [];
    const order = new Map(index.ops.map((op, position) => [op, position]));
    return candidates
      .filter((op) => !found.has(op))
      .flatMap((op) => {
        const best = index
          .fields(op)
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
  const defaultRead: RestMethod = readMethods.includes("GET") || readMethods.length !== 1 ? "GET" : readMethods[0]!;
  const writeMethods = methodsWith((verdict) => verdict === "write" || verdict === "destructive");
  const Method = methodEnum(index.methods);
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
  const detailsTool = tool("details");
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
        truncated: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: `Entry labels cut for size; ${detailsTool} on that method and path returns them whole.`,
          }),
        ),
        page: StandardPage,
      }),
      run: (args) =>
        Effect.gen(function* () {
          const scope = {
            revision: yield* Effect.promise(() => index.cursorRevision()),
            query: args.query,
            ...(args.method ? { method: args.method } : {}),
          };
          const continuation =
            args.cursor === undefined ? undefined : yield* boundCursor.decode(searchTool, scope, args.cursor);
          const offset = continuation === undefined ? 0 : Number(continuation);
          if (!Number.isSafeInteger(offset) || (continuation !== undefined && !/^[1-9][0-9]*$/.test(continuation)))
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
          const reachable = ranked.filter(({ op }) => [...op.path].length <= 2048).length;
          if (continuation !== undefined && offset >= reachable)
            return yield* Effect.fail(
              new Refusal({
                error: new ConnectorCallError("invalid_args", "This search cursor is not one search returned."),
              }),
            );
          // Search entries are compact: long labels are cut (details serves them whole), and a
          // path the read and write tools cannot take (over 2,048 characters) is never routed.
          const truncated: string[] = [];
          const operations = ranked
            .filter(({ op }) => [...op.path].length <= 2048)
            .slice(offset, offset + (args.limit ?? SEARCH_BUDGET.hits))
            .map(({ op, field }, position) => {
              const { named: authored, ...routed } = route(op);
              const label = (key: string, text: string) => {
                if (text.length > SEARCH_BUDGET.summaryChars) truncated.push(`operations[${position}].${key}`);
                return cap(text, SEARCH_BUDGET.summaryChars);
              };
              return {
                method: op.method,
                path: op.path,
                operationId: label("operationId", op.operationId),
                summary: label("summary", op.summary),
                ...routed,
                // A named tool's projection may omit the matched field, so a field match points at the hatch only.
                ...(field
                  ? { matched: label("matched", `${field.in} field ${field.path}`) }
                  : authored
                    ? { named: authored }
                    : {}),
              };
            });
          // The budget holds for the whole answer, page and cursor included, before it leaves the tool;
          // what it cuts stays reachable by cursor.
          const answer = function* () {
            const next = offset + operations.length;
            const shown = truncated.filter((path) => Number(/\[(\d+)\]/.exec(path)![1]) < operations.length);
            return {
              operations,
              revision: index.revision,
              ...(shown.length ? { truncated: shown } : {}),
              page:
                next < reachable
                  ? { hasMore: true, nextCursor: yield* boundCursor.encode(searchTool, scope, String(next)) }
                  : { hasMore: false },
            };
          };
          let result = yield* answer();
          while (operations.length > 1 && bytes(result) > SEARCH_BUDGET.bytes) {
            operations.pop();
            result = yield* answer();
          }
          return result;
        }),
    }),
    read(connection, {
      name: detailsTool,
      description: `Read one ${title} API operation's request contract: path, query and body parameters with types and required names. Reads no account data.`,
      input: Schema.Struct({
        method: Method.annotate({ description: "The operation's HTTP method." }),
        path: Path.annotate({ description: "The path template from search, or a concrete path." }),
        param: Schema.optionalKey(text(1, 200).annotate({ description: "Return only this parameter, in full." })),
        cursor: Schema.optionalKey(
          text(1, 1024).annotate({
            description: "page.nextCursor from the previous details call with the same method, path and param.",
          }),
        ),
      }),
      output: Schema.Struct({
        method: Method,
        path: Schema.String,
        operationId: Schema.String,
        summary: Schema.String,
        server: Schema.optionalKey(Schema.String),
        parameters: Schema.Array(Schema.Unknown).annotate({ description: "Path and query parameters." }),
        body: Schema.optionalKey(
          ObjectValue.annotate({
            description:
              "Body content type and schema. When paged: this page's properties, the required names it delivers or chunks, and the schema's other keywords on the page that carries them.",
          }),
        ),
        verdict: Schema.Literals(["read", "write", "destructive", "refuse"]),
        ...Routing,
        revision: Schema.String,
        chunk: Schema.optionalKey(
          Schema.Struct({
            of: Schema.String.annotate({ description: "The piece this text belongs to, such as parameters.limit." }),
            text: Schema.String.annotate({
              description: "Part of that piece's JSON; join the parts in page order, then parse them.",
            }),
          }),
        ),
        truncated: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "Labels cut for size; their full text arrives as chunks.",
          }),
        ),
        page: Schema.optionalKey(
          StandardPage.annotate({
            description: "Present when the contract exceeds one answer: pass nextCursor back for the next pieces.",
          }),
        ),
      }),
      run: (args) =>
        Effect.gen(function* () {
          const { op, contract } = yield* checked(() => {
            const op = index.operation(args.method, args.path) ?? index.resolve(args.method, args.path).op;
            return { op, contract: index.contract(op, args.param) };
          });
          const tail = { verdict: verdictOf(op), ...route(op), revision: index.revision };
          const whole = { ...contract, ...tail };
          if (args.cursor === undefined && bytes(whole) <= DETAILS_BUDGET_BYTES) return whole;
          // Bounded pages: every parameter and body property arrives whole on some page, and a
          // piece too large for one page arrives as consecutive chunks of its JSON. Nothing is dropped.
          const scope = {
            revision: yield* Effect.promise(() => index.cursorRevision()),
            method: args.method,
            path: args.path,
            ...(args.param ? { param: args.param } : {}),
          };
          let at = { i: 0, o: 0 };
          if (args.cursor !== undefined) {
            const decoded = yield* boundCursor.decode(detailsTool, scope, args.cursor);
            const parsed = yield* Effect.try({
              try: () => JSON.parse(decoded) as unknown,
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined));
            at = parsed as typeof at;
          }
          const capped = {
            operationId: contract.operationId.length > SEARCH_BUDGET.summaryChars,
            summary: contract.summary.length > SEARCH_BUDGET.summaryChars,
          };
          const pieces = piecesOf(contract, capped);
          if (
            !Number.isSafeInteger(at?.i) ||
            !Number.isSafeInteger(at?.o) ||
            at.i < 0 ||
            at.o < 0 ||
            at.i >= pieces.length ||
            (args.cursor !== undefined && at.i === 0 && at.o === 0) ||
            (at.o > 0 &&
              (() => {
                const json = JSON.stringify(pieces[at.i]!.value);
                return at.o >= json.length || /[\uD800-\uDBFF]/.test(json[at.o - 1]!);
              })())
          )
            return yield* Effect.fail(
              new Refusal({
                error: new ConnectorCallError("invalid_args", "This details cursor is not one details returned."),
              }),
            );
          const base = {
            method: contract.method,
            path: contract.path,
            operationId: cap(contract.operationId, SEARCH_BUDGET.summaryChars),
            summary: cap(contract.summary, SEARCH_BUDGET.summaryChars),
            ...(contract.server ? { server: contract.server } : {}),
          };
          const truncated = (["operationId", "summary"] as const).filter((key) => capped[key]);
          const parameters: unknown[] = [];
          const properties: Record<string, unknown> = {};
          const required: string[] = [];
          let frame: Readonly<Record<string, unknown>> | undefined;
          let body: unknown;
          let chunk: { of: string; text: string } | undefined;
          // A paged object body carries the frame keywords on the page that delivers them,
          // this page's properties, and the required names of the properties it delivers or chunks.
          const compose = (page: { readonly hasMore: boolean; readonly nextCursor?: string }) => ({
            ...base,
            parameters,
            ...(contract.body === undefined
              ? {}
              : {
                  body: {
                    contentType: contract.body.contentType,
                    ...(contract.body.required ? { required: true } : {}),
                    schema: body ?? {
                      ...frame,
                      properties,
                      ...(required.length ? { required } : {}),
                    },
                  },
                }),
            ...tail,
            ...(chunk ? { chunk } : {}),
            ...(truncated.length ? { truncated } : {}),
            page,
          });
          // Room for the largest cursor this contract can need.
          const reserve = {
            hasMore: true,
            nextCursor: yield* boundCursor.encode(
              detailsTool,
              scope,
              `{"i":${pieces.length},"o":${Number.MAX_SAFE_INTEGER}}`,
            ),
          };
          const fits = () => bytes(compose(reserve)) <= DETAILS_BUDGET_BYTES;
          let { i, o } = at;
          while (i < pieces.length) {
            const piece = pieces[i]!;
            if (o === 0 && piece.kind !== "text") {
              if (piece.kind === "parameter") parameters.push(piece.value);
              else if (piece.kind === "body") body = piece.value;
              else if (piece.kind === "frame") frame = piece.value;
              else {
                properties[piece.name] = piece.value;
                if (piece.required) required.push(piece.name);
              }
              if (fits()) {
                i += 1;
                continue;
              }
              if (piece.kind === "parameter") parameters.pop();
              else if (piece.kind === "body") body = undefined;
              else if (piece.kind === "frame") frame = undefined;
              else {
                delete properties[piece.name];
                if (piece.required) required.pop();
              }
            }
            // A piece that cannot share a page arrives alone, in as many chunks as it needs; a
            // chunked required property keeps its name in this page's required list.
            if (
              parameters.length === 0 &&
              Object.keys(properties).length === 0 &&
              body === undefined &&
              frame === undefined
            ) {
              const json = JSON.stringify(piece.value);
              if (piece.kind === "property" && piece.required) required.push(piece.name);
              chunk = { of: piece.of, text: "" };
              let low = o + 1;
              let high = json.length;
              let end = Math.min(o + 1, json.length);
              while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                chunk.text = json.slice(o, middle);
                if (fits()) {
                  end = middle;
                  low = middle + 1;
                } else high = middle - 1;
              }
              // Never split a surrogate pair across chunks.
              if (end < json.length && end > o + 1 && /[\uD800-\uDBFF]/.test(json[end - 1]!)) end -= 1;
              chunk.text = json.slice(o, end);
              o = end;
              if (o >= json.length) {
                i += 1;
                o = 0;
              }
            }
            break;
          }
          return compose(
            i < pieces.length
              ? { hasMore: true, nextCursor: yield* boundCursor.encode(detailsTool, scope, JSON.stringify({ i, o })) }
              : { hasMore: false },
          );
        }),
    }),
  ];

  const run = (kind: "read" | "write", args: CallArgs) =>
    checked((): WriteRequest => {
      refuseWithheldValues({ path: args.path, query: args.query }, name, true);
      refuseWithheldValues(args.body, name);
      const method = args.method ?? defaultRead;
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
      index.check(op, query, args.body);
      // S5: a bad first segment is refused before anything is sent, against the
      // declared success contract, never against whatever one answer happens to hold.
      if (args.fields?.length) {
        const roots = index.responseRoots(op);
        if (!roots) invalid(`${method} ${op.path} declares no response properties, so fields cannot narrow it.`);
        const problem = fieldsProblem(args.fields, roots, "data");
        if (problem) throw problem;
      }
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
      // Selection narrows the answer value safety and the privacy projection already made.
      Effect.map((answer) => ({
        status: answer.status,
        data: selectFields(answer.data === undefined ? null : answer.data, args.fields),
      })),
    );

  const note = (sentence: string | undefined) => (sentence ? ` ${sentence}` : "");
  const nonGetReads = readMethods.filter((method) => method !== "GET" && method !== "HEAD");
  // Field order follows the REST hatch: path, method, body, query, then fields.
  const readFields: Record<string, Schema.Top & { readonly DecodingServices: never }> = { path: Path };
  // `method` is omitted only when GET is the one reviewed read method; a sole other method is the
  // default, and several non-GET read methods must be named.
  if (readMethods.length > 0 && !(readMethods.length === 1 && readMethods[0] === "GET")) {
    const methods = methodEnum(readMethods);
    readFields["method"] =
      readMethods.includes("GET") || readMethods.length === 1
        ? Schema.optionalKey(
            methods.annotate({
              description: `${defaultRead} by default; another method only for an operation search routes here.`,
            }),
          )
        : methods.annotate({ description: "The reviewed read method of the operation search routes here." });
  }
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
          method: methodEnum(writeMethods).annotate({ description: "The operation's HTTP method." }),
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
