// Internal kit hatch (decision 0010, B.4). Unreachable from src/index.ts.
// The pinned REST index validates requests; only an explicit verdict routes
// them. Connection.sendPath owns admission, dispatch and result safety.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import { type Operation, type OperationIndex, type RestMethod } from "../providers/_shared/rest/operation-index.js";
import { refuseWithheldLinks } from "../providers/_shared/rest/value-safety.js";
import { Refusal } from "./errors.js";
import { Integer, isMaxChars, isMinChars } from "./json-schema.js";
import { read, write } from "./tools.js";
import type { Connection } from "./vendor.js";
import type { Parameters, WriteRequest } from "./write-request.js";

type Verdict = "read" | "write" | "destructive" | "refuse";

const text = (min: number, max: number) => Schema.String.check(isMinChars(min), isMaxChars(max));
const Path = text(2, 2048).annotate({
  description: "Concrete provider-relative path, with ids filled in and no query string.",
});
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const Fields = Schema.Array(text(1, 200)).check(Schema.isMaxLength(50)).annotate({
  description: "Dot paths to keep in data, applied to each item of an array, after value safety and privacy filtering.",
});
const RequestInput = {
  path: Path,
  query: Schema.optionalKey(ObjectValue),
  body: Schema.optionalKey(Schema.Union([ObjectValue, Schema.Array(Schema.Unknown)])),
  fields: Schema.optionalKey(Fields),
};
const Envelope = Schema.Struct({ status: Integer, data: Schema.Unknown });

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

/** REST select semantics, now named fields; first segments must exist in the safe data. */
function project(data: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length) return data;
  const rows = Array.isArray(data) ? data : [data];
  const names = new Set(rows.flatMap((row) => (record(row) ? Object.keys(row) : [])));
  for (const field of fields) {
    if (!names.has(field.split(".")[0]!)) invalid(`fields path ${field} does not begin with a property of data.`);
  }
  const pick = (value: unknown, paths: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((item) => pick(item, paths));
    if (!record(value)) return value;
    const children = new Map<string, string[]>();
    for (const path of paths) {
      const [key, ...tail] = path.split(".");
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

/** The standard hatch over an existing REST index; a missing verdict refuses every method. */
export function hatch(options: {
  readonly name: string;
  readonly index: OperationIndex;
  readonly verdicts: Readonly<Record<`${RestMethod} ${string}`, Verdict>>;
  readonly connection: Connection;
}): ApiTool[] {
  const { name, index, connection } = options;
  if (!name.trim()) throw new Error("A hatch needs a nonempty tool prefix.");
  // Snapshot reviews: a retained declaration cannot widen a served hatch.
  const verdicts = new Map(Object.entries(options.verdicts));
  for (const [key, verdict] of verdicts) {
    if (!index.ops.some((op) => `${op.method} ${op.path}` === key)) {
      throw new Error(`Hatch verdict ${key} is not in the pinned API index.`);
    }
    if (!["read", "write", "destructive", "refuse"].includes(verdict)) {
      throw new Error(`Hatch verdict ${key} must be read, write, destructive, or refuse.`);
    }
  }
  const verdictOf = (op: Operation): Verdict => verdicts.get(`${op.method} ${op.path}`) ?? "refuse";
  const tool = (kind: string) => `${name}_api_${kind}`;
  const route = (op: Operation) => {
    const verdict = verdictOf(op);
    return verdict === "refuse" ? {} : { tool: tool(verdict === "read" ? "read" : "write") };
  };
  const Method = Schema.Literals(index.methods);
  const VerdictSchema = Schema.Literals(["read", "write", "destructive", "refuse"]);
  const tools = [
    read(connection, {
      name: tool("search"),
      description: `Find ${name} API operations in the pinned index. Reads no account data; refused operations have no calling tool.`,
      input: Schema.Struct({
        query: text(1, 200),
        method: Schema.optionalKey(Method),
        limit: Schema.optionalKey(Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50))),
      }),
      output: Schema.Struct({
        operations: Schema.Array(
          Schema.Struct({
            method: Method,
            path: Schema.String,
            operationId: Schema.String,
            summary: Schema.String,
            tag: Schema.String,
            verdict: VerdictSchema,
            tool: Schema.optionalKey(Schema.String),
          }),
        ),
        revision: Schema.String,
      }),
      run: (args) =>
        checked(() => ({
          operations: index
            .search(args.query, { ...(args.method ? { method: args.method } : {}), limit: args.limit ?? 10 })
            .map((op) => ({
              method: op.method,
              path: op.path,
              operationId: op.operationId,
              summary: op.summary,
              tag: op.tag,
              verdict: verdictOf(op),
              ...route(op),
            })),
          revision: index.revision,
        })),
    }),
    read(connection, {
      name: tool("details"),
      description: `Read one ${name} API operation's pinned request contract and verdict. Reads no account data.`,
      input: Schema.Struct({ method: Method, path: Path, param: Schema.optionalKey(text(1, 200)) }),
      output: Schema.Struct({
        method: Method,
        path: Schema.String,
        operationId: Schema.String,
        summary: Schema.String,
        server: Schema.optionalKey(Schema.String),
        parameters: Schema.Array(Schema.Unknown),
        body: Schema.optionalKey(ObjectValue),
        verdict: VerdictSchema,
        tool: Schema.optionalKey(Schema.String),
        revision: Schema.String,
      }),
      run: (args) =>
        checked(() => {
          const op = index.operation(args.method, args.path) ?? index.resolve(args.method, args.path).op;
          return { ...index.contract(op, args.param), verdict: verdictOf(op), ...route(op), revision: index.revision };
        }),
    }),
  ];

  const run = (
    kind: "read" | "write",
    args: {
      readonly method?: RestMethod;
      readonly path: string;
      readonly query?: Readonly<Record<string, unknown>>;
      readonly body?: unknown;
      readonly fields?: readonly string[];
    },
  ) =>
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
        checked(() => ({
          status: answer.status,
          data: project(answer.data === undefined ? null : answer.data, args.fields),
        })),
      ),
    );

  const readSpec = {
    name: tool("read"),
    description: `Call an explicitly reviewed ${name} read. The pinned index validates arguments before dispatch.`,
    input: Schema.Struct({ ...RequestInput, method: Schema.optionalKey(Method) }),
    output: Envelope,
    // The explicit per-operation read table replaces REST readPosts. The
    // builder's review permits its non-GET reads; run checks the exact row.
    review: "Only operations explicitly classified read in the hatch's snapshotted verdict table are admitted.",
  };
  // Let the Schema infer the program arguments rather than the shared field declarations.
  tools.push(read(connection, { ...readSpec, run: (args) => run("read", args) }));
  if (index.ops.some((op) => verdictOf(op) === "write" || verdictOf(op) === "destructive")) {
    tools.push(
      write(connection, {
        name: tool("write"),
        description: `Call an explicitly reviewed ${name} write, including GET writes. Method and path are stated for approval.`,
        input: Schema.Struct({ method: Method, ...RequestInput }),
        output: Envelope,
        destructive: true,
        run: (args) => run("write", args),
      }),
    );
  }
  return tools;
}
