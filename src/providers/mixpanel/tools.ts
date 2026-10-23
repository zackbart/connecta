// Step-1 Mixpanel tools retain catalog, projection and paging bytes on kit leases.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import type { CallServices } from "../../http/services.js";
import { read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import type { JsonSchema } from "../../types.js";
import { catalogOrder, checked, restKitTools, schema } from "../_shared/rest/kit.js";
import type { RestMethod } from "../_shared/rest/operation-index.js";
import { INDEX, SAFETY, READ_POSTS, record, invalid, regionalConnection, scopedCall, sendMixpanel } from "./api.js";
import type { MixpanelApiOptions } from "./index.js";

const MAX_EXPORT_BYTES = 1024 * 1024;
const DEFAULT_EXPORT_BYTES = 64 * 1024;
const MAX_IMPORT_BYTES = 10_000_000;
const encoder = new TextEncoder();
const READ = { readOnlyHint: true } as const;
const PROJECT: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "Project id from list_projects or project settings; omitted only with defaultProjectId.",
};
const WORKSPACE: JsonSchema = {
  type: "integer",
  minimum: 1,
  description: "Data view workspace id when the project requires one.",
};
const DATE: JsonSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Inclusive date, YYYY-MM-DD. Export uses the vendor's project-age timezone rules.",
};
const TEXT: JsonSchema = { type: "string", minLength: 1, description: "Documented Mixpanel value." };
const RAW: JsonSchema = {
  type: "boolean",
  description: "Return the redacted vendor envelope instead of the named tool's projection.",
};
const OUT: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "integer" },
    data: { description: "Redacted Mixpanel result." },
    page: {
      type: "object",
      description: "When hasMore is true, repeat the same filters with the next page and session id.",
    },
  },
  required: ["status", "data"],
};
const EXPORT_PROPERTIES: Record<string, JsonSchema> = {
  project_id: PROJECT,
  from_date: DATE,
  to_date: DATE,
  event: {
    type: "array",
    items: { ...TEXT, description: "Exact event name." },
    minItems: 1,
    description: "Optional event-name filter, encoded as JSON on the wire.",
  },
  where: { ...TEXT, description: "Mixpanel segmentation expression to filter events." },
  time_in_ms: { type: "boolean", description: "Request millisecond timestamps instead of the default seconds." },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 100_000,
    description: "Mixpanel event cap is 100000; Connecta defaults to 1000.",
  },
  max_bytes: {
    type: "integer",
    minimum: 1,
    maximum: MAX_EXPORT_BYTES,
    description: "Connecta's byte ceiling, default 65536 and maximum 1048576; partial trailing lines are discarded.",
  },
};

function dates(input: Record<string, unknown>): void {
  for (const key of ["from_date", "to_date"]) {
    const value = input[key];
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      invalid(`${key} must be a valid YYYY-MM-DD date.`);
  }
  if (String(input.from_date) > String(input.to_date)) invalid("from_date must be on or before to_date.");
}
function retention(query: Record<string, unknown>): void {
  if ((query.unit === undefined || query.unit === "day") && typeof query.interval === "number" && query.interval > 90) {
    invalid("Day retention intervals must not exceed 90; unit defaults to day.");
  }
  if (
    (query.retention_type === undefined || query.retention_type === "birth") &&
    (typeof query.born_event !== "string" || query.born_event.trim() === "")
  ) {
    invalid("birth retention, including the default, requires born_event. Use compounded for recurring retention.");
  }
}
type Program = (args: Record<string, any>) => Effect.Effect<any, HttpFailure, CallServices>;
type Declaration = Omit<ApiTool, "handler"> & { run: Program };
const authored = <A>(work: Effect.Effect<A, HttpFailure, CallServices>) =>
  work.pipe(
    Effect.catchDefect((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
function inputSchema(node: JsonSchema): Schema.Codec<any> {
  if (Object.keys(node.properties ?? {}).length === 0) return Schema.Record(Schema.String, Schema.Never);
  const required = (node.required ?? []) as string[];
  return Schema.Struct(
    Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([key, property]) => {
        const value =
          typeof property.pattern === "string"
            ? Schema.String.check(
                Schema.makeFilter((value: string) => new RegExp(String(property.pattern)).test(value), {
                  toJsonSchema: () => ({ pattern: property.pattern }),
                }),
              ).annotate({ description: property.description! })
            : schema(property);
        return [key, required.includes(key) ? value : Schema.optionalKey(value)];
      }),
    ),
  );
}
export function mixpanelTools({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<MixpanelApiOptions>;
}): ApiTool[] {
  const exports = regionalConnection(options, "export");
  const ingestion = regionalConnection(options, "ingestion");
  const call = (
    method: RestMethod,
    path: string,
    input: { query?: Readonly<Record<string, unknown>>; body?: unknown } = {},
  ) => scopedCall(options, method, path, input);
  const send = (prepared: ReturnType<typeof call>) =>
    prepared.path === "/api/2.0/export"
      ? exportEvents({
          ...prepared.query,
          ...(typeof prepared.query.event === "string" ? { event: JSON.parse(prepared.query.event) } : {}),
        }).pipe(Effect.map((data) => ({ status: 200, data })))
      : sendMixpanel(connection, exports, ingestion, prepared).pipe(
          Effect.map(({ status, data }) => ({ status, data: data ?? null })),
        );
  const request = (method: RestMethod, path: string, query: Record<string, unknown> = {}, body?: unknown) =>
    checked(() => call(method, path, { query, body })).pipe(Effect.flatMap(send));
  const exportEvents: Program = (args) =>
    authored(
      Effect.gen(function* () {
        dates(args);
        const maxBytes = args.max_bytes ?? DEFAULT_EXPORT_BYTES;
        const limit = args.limit ?? 1000;
        if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EXPORT_BYTES)
          invalid("max_bytes must be 1..1048576, Connecta's export ceiling.");
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100_000)
          invalid("limit must be 1..100000, Mixpanel's export event ceiling.");
        const prepared = call("GET", "/api/2.0/export", { query: { ...args, max_bytes: undefined, limit } });
        const answer = yield* sendMixpanel(connection, exports, ingestion, prepared, { maxBytes });
        const text = typeof answer.data === "string" ? answer.data : "";
        const byteTruncated = answer.prefix!.truncated;
        const complete = byteTruncated ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
        const lines = complete.split("\n").filter((line) => line.trim() !== "");
        let events: unknown[];
        try {
          events = lines.map((line) => JSON.parse(line) as unknown);
        } catch {
          throw new ConnectorCallError("connector_call_failed", "Mixpanel returned malformed JSONL.", {
            retryable: false,
          });
        }
        if (events.some((event) => !record(event) || typeof event.event !== "string" || !record(event.properties)))
          throw new ConnectorCallError("connector_call_failed", "Mixpanel returned an unexpected export event shape.", {
            retryable: false,
          });
        const truncated = byteTruncated || events.length >= limit;
        return {
          events: SAFETY.redact(events.slice(0, limit), "GET", prepared.path),
          bytes_read: answer.prefix!.bytes,
          truncated,
          notice: truncated
            ? "Export may omit events at the byte or event cap. There is no cursor; narrow the date range or filters. Never infer absence from this sample."
            : "Complete response for the requested range and filters.",
        };
      }),
    );

  function readTool(
    name: string,
    description: string,
    path: string,
    properties: Record<string, JsonSchema>,
    required: string[],
    run?: Program,
  ): Declaration {
    return {
      name,
      description,
      annotations: READ,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      outputSchema: OUT,
      run:
        run ??
        ((args) =>
          authored(
            Effect.gen(function* () {
              const { raw: _raw, ...query } = args;
              if (query.from_date !== undefined || query.to_date !== undefined) dates(query);
              if (path === "/api/query/retention") retention(query);
              return yield* request("GET", path, query);
            }),
          )),
    };
  }
  const generic = restKitTools({
    vendor: "mixpanel",
    title: "Mixpanel",
    index: INDEX,
    valueSafety: SAFETY,
    readPosts: READ_POSTS,
    connection,
    send,
    scope: (prepared) => call(prepared.method, prepared.path, { query: prepared.query, body: prepared.body }),
  })
    .filter((tool) => tool.name !== "mixpanel_api_write")
    .map((tool): ApiTool =>
      tool.name !== "mixpanel_api_read"
        ? {
            ...tool,
            handler: async (args, ctx) => {
              const result = (await tool.handler(args, ctx)) as Record<string, unknown>;
              const routed = (row: Record<string, unknown>) => ({
                ...row,
                tool:
                  row.path === "/import"
                    ? "import_events"
                    : row.path === "/api/query/engage"
                      ? "query_profiles"
                      : "mixpanel_api_read",
              });
              return Array.isArray(result.operations)
                ? { ...result, operations: result.operations.map(routed) }
                : routed(result);
            },
          }
        : {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                path: (tool.inputSchema!.properties as Record<string, JsonSchema>).path!,
                project_id: PROJECT,
                query: {
                  type: "object",
                  description:
                    "Documented query parameters; use details to resolve required names. No auth headers or body.",
                },
                select: (tool.inputSchema!.properties as Record<string, JsonSchema>).select!,
              },
            },
            description:
              "GET a reviewed Mixpanel operation on this region's hosts. No arbitrary URLs, profile updates or service-account administration.",
            handler: async (args, ctx) => {
              if (args.method !== undefined && args.method !== "GET")
                invalid(
                  "mixpanel_api_read permits GET only; use query_profiles for Engage and import_events for ingestion.",
                );
              const path = args.path as string;
              const query = { ...(record(args.query) ? args.query : {}) };
              if (args.project_id !== undefined) {
                if (query.project_id !== undefined && query.project_id !== args.project_id)
                  invalid("Conflicting project_id values; use the top-level project_id.");
                query.project_id = args.project_id;
              }
              if (path === "/api/2.0/export") {
                const prepared = call("GET", path, { query });
                INDEX.check(prepared.op, prepared.query, prepared.body);
                let event = query.event;
                if (typeof event === "string") {
                  try {
                    event = JSON.parse(event) as unknown;
                  } catch {
                    invalid("event must be a JSON array of names.");
                  }
                }
                if (
                  event !== undefined &&
                  (!Array.isArray(event) || event.length === 0 || !event.every((name) => typeof name === "string"))
                )
                  invalid("event must be a JSON array of names.");
                if (args.select !== undefined)
                  invalid("Generic export does not accept select; reduce the bounded export data in execute_code.");
                return await tool.handler(
                  { path: args.path, ...(args.select === undefined ? {} : { select: args.select }), query },
                  ctx,
                );
              }
              if (query.from_date !== undefined || query.to_date !== undefined) dates(query);
              if (path === "/api/query/retention") retention(query);
              return await tool.handler(
                { path: args.path, ...(args.select === undefined ? {} : { select: args.select }), query },
                ctx,
              );
            },
          },
    );
  const declarations: Declaration[] = [
    readTool(
      "list_projects",
      "Read service-account identity and reachable project metadata. Project tokens and credentials are redacted.",
      "/api/app/me",
      {},
      [],
    ),
    {
      name: "export_events",
      description:
        "Export bounded raw JSONL events for a date range. Truncation is explicit; narrow filters to establish absence.",
      annotations: READ,
      inputSchema: {
        type: "object",
        properties: EXPORT_PROPERTIES,
        required: ["from_date", "to_date"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          events: { type: "array", items: { type: "object" } },
          bytes_read: { type: "integer" },
          truncated: { type: "boolean" },
          notice: { type: "string" },
        },
        required: ["events", "bytes_read", "truncated", "notice"],
      },
      run: exportEvents,
    },
    readTool(
      "get_profile_activity",
      "Read one user's events, ordered by timestamp. Mixpanel's activity endpoint is in maintenance mode; use export for complete analysis.",
      "/api/query/stream/query",
      {
        project_id: PROJECT,
        workspace_id: WORKSPACE,
        distinct_id: { ...TEXT, description: "Exact distinct_id of the user whose event history to read." },
        from_date: DATE,
        to_date: DATE,
        raw: RAW,
      },
      ["distinct_id", "from_date", "to_date"],
      (args) =>
        authored(
          Effect.gen(function* () {
            dates(args);
            const { distinct_id, raw, ...query } = args;
            const result = yield* request("GET", "/api/query/stream/query", { ...query, distinct_ids: [distinct_id] });
            if (raw) return result;
            const body = result.data;
            const events = record(body) && record(body.results) ? body.results.events : undefined;
            if (
              !Array.isArray(events) ||
              events.some((e) => !record(e) || !record(e.properties) || typeof e.properties.time !== "number")
            )
              throw new ConnectorCallError("connector_call_failed", "Mixpanel returned an unexpected activity shape.", {
                retryable: false,
              });
            return {
              status: result.status,
              data: {
                events: [...events].sort((a, b) => a.properties.time - b.properties.time),
                notice: "Maintenance endpoint; Mixpanel documents no completeness guarantee or pagination cursor.",
              },
            };
          }),
        ),
    ),
    readTool(
      "query_profiles",
      "Query existing Engage profiles. This POST is read-only; continue with the returned session_id and next page, preserving filters.",
      "/api/query/engage",
      {
        project_id: PROJECT,
        workspace_id: WORKSPACE,
        distinct_id: { ...TEXT, description: "Profile distinct id." },
        distinct_ids: { type: "array", items: TEXT, description: "Exact profile ids, JSON encoded." },
        where: { ...TEXT, description: "Mixpanel profile selector expression." },
        output_properties: { type: "array", items: TEXT, description: "Profile property names to return." },
        session_id: { ...TEXT, description: "Session from the previous response; repeat it unchanged." },
        page: { type: "integer", minimum: 0, description: "Zero-based page; a nonzero page requires session_id." },
        raw: RAW,
      },
      [],
      (args) =>
        authored(
          Effect.gen(function* () {
            const { project_id, workspace_id, raw, ...body } = args;
            if (typeof body.page === "number" && body.page > 0 && !body.session_id)
              invalid("A nonzero profile page requires session_id from the previous response.");
            if (body.distinct_id !== undefined && body.distinct_ids !== undefined)
              invalid("Use distinct_id or distinct_ids, not both.");
            const result = yield* request("POST", "/api/query/engage", { project_id, workspace_id }, body);
            if (raw) return result;
            const data = result.data;
            if (
              !record(data) ||
              !Array.isArray(data.results) ||
              typeof data.page_size !== "number" ||
              data.page_size < 1 ||
              typeof data.page !== "number" ||
              typeof data.session_id !== "string"
            )
              throw new ConnectorCallError(
                "connector_call_failed",
                "Mixpanel returned an unexpected profile page shape.",
                {
                  retryable: false,
                },
              );
            const hasMore = data.results.length >= data.page_size;
            return {
              ...result,
              data: {
                results: data.results,
                total: data.total,
                page: data.page,
                session_id: data.session_id,
                page_size: data.page_size,
              },
              page: {
                hasMore,
                ...(hasMore ? { next: String(data.page + 1), param: "page", in: "body" as const } : {}),
              },
            };
          }),
        ),
    ),
    readTool(
      "get_insights_report",
      "Read a saved Insights report by bookmark_id from its report URL. The id is project-local.",
      "/api/query/insights",
      {
        project_id: PROJECT,
        workspace_id: WORKSPACE,
        bookmark_id: { ...PROJECT, description: "Saved Insights bookmark id from the report URL." },
      },
      ["bookmark_id"],
    ),
    readTool(
      "get_funnel_report",
      "Read a saved funnel by funnel_id and date range. Use mixpanel_api_read on /api/query/funnels/list to resolve ids.",
      "/api/query/funnels",
      {
        project_id: PROJECT,
        workspace_id: WORKSPACE,
        funnel_id: { ...PROJECT, description: "Saved funnel id from the vendor list or report URL." },
        from_date: DATE,
        to_date: DATE,
      },
      ["funnel_id", "from_date", "to_date"],
    ),
    readTool(
      "query_retention",
      "Query retention by events and date range. Mixpanel documents no saved Retention bookmark-id endpoint.",
      "/api/query/retention",
      {
        project_id: PROJECT,
        workspace_id: WORKSPACE,
        from_date: DATE,
        to_date: DATE,
        event: { ...TEXT, description: "Returning event name." },
        born_event: { ...TEXT, description: "Initial event name for birth retention." },
        retention_type: {
          type: "string",
          enum: ["birth", "compounded"],
          description: "First-time or recurring retention, respectively.",
        },
        interval: {
          type: "integer",
          minimum: 1,
          description: "Bucket interval; Mixpanel caps day intervals at 90.",
        },
        interval_count: {
          type: "integer",
          minimum: 1,
          description: "Number of buckets, in addition to the zeroth interval.",
        },
        unit: { type: "string", enum: ["day", "week", "month"], description: "Interval unit, default day." },
      },
      ["from_date", "to_date"],
    ),
    {
      name: "import_events",
      description:
        "Import up to 2000 events and 10MB uncompressed JSON. Owner/Admin required; validation errors may still ingest valid events. Never replay automatically.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          project_id: PROJECT,
          events: {
            type: "array",
            minItems: 1,
            maxItems: 2000,
            description: "Mixpanel event batch; supply stable insert ids for deduplication.",
            items: {
              type: "object",
              description: "One event, smaller than 1MB uncompressed.",
              properties: {
                event: { ...TEXT, description: "Exact event name." },
                properties: {
                  type: "object",
                  description:
                    "Event properties with time (integer seconds/milliseconds), distinct_id (string) and stable $insert_id (1..36 alphanumeric/hyphen bytes). Fewer than 255 keys; nested depth 3.",
                },
              },
              required: ["event", "properties"],
              additionalProperties: false,
            },
          },
        },
        required: ["events"],
        additionalProperties: false,
      },
      outputSchema: OUT,
      run: (args) =>
        authored(
          Effect.gen(function* () {
            const events = args.events as unknown[];
            validateImport(events);
            return yield* request("POST", "/import", { project_id: args.project_id, strict: "1" }, events);
          }),
        ),
    },
  ];
  return [
    ...generic,
    ...declarations.map((declaration) => {
      const spec = {
        inputOrder: "original" as const,
        name: declaration.name,
        description: declaration.description,
        input: inputSchema(declaration.inputSchema!),
        output: schema(declaration.outputSchema!),
        run: declaration.run,
      };
      const tool = declaration.annotations?.readOnlyHint
        ? read(connection, { ...spec, review: "Queries existing profiles; no profile mutation or ingestion occurs." })
        : write(connection, { ...spec, destructive: false, writeSteps: { write: "once" } });
      Object.assign(tool, {
        inputSchema: catalogOrder(tool.inputSchema, declaration.inputSchema),
        outputSchema: catalogOrder(tool.outputSchema, declaration.outputSchema),
      });
      return tool;
    }),
  ];
}

function validateImport(events: unknown[]): void {
  if (events.length < 1 || events.length > 2000) invalid("Mixpanel import requires 1..2000 events.");
  if (encoder.encode(JSON.stringify(events)).length > MAX_IMPORT_BYTES)
    invalid("Mixpanel import is limited to 10MB of uncompressed JSON per batch.");
  const walk = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) {
      if (value.length >= 255) invalid("Mixpanel array properties must have fewer than 255 elements.");
      for (const item of value) walk(item, depth);
    } else if (record(value)) {
      if (depth > 3) invalid("Mixpanel nested object properties may be at most three levels deep.");
      if (Object.keys(value).length >= 255) invalid("Mixpanel objects must have fewer than 255 keys.");
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  for (const event of events) {
    if (!record(event) || !record(event.properties)) invalid("Each Mixpanel event requires a properties object.");
    const props = event.properties;
    if (
      typeof props.time !== "number" ||
      !Number.isSafeInteger(props.time) ||
      typeof props.distinct_id !== "string" ||
      typeof props.$insert_id !== "string" ||
      !/^[A-Za-z0-9-]{1,36}$/.test(props.$insert_id)
    )
      invalid(
        "Mixpanel import needs integer time, string distinct_id and a 1..36-byte alphanumeric/hyphen $insert_id.",
      );
    const forbidden = new Set([
      "00000000-0000-0000-0000-000000000000",
      "anon",
      "anonymous",
      "nil",
      "none",
      "null",
      "n/a",
      "na",
      "undefined",
      "unknown",
      "<nil>",
      "0",
      "-1",
      "true",
      "false",
      "[]",
      "{}",
    ]);
    if (forbidden.has(props.distinct_id) || forbidden.has(props.$insert_id))
      invalid("Mixpanel refuses this distinct_id or $insert_id placeholder value.");
    if (encoder.encode(JSON.stringify(event)).length >= 1_000_000)
      invalid("Each Mixpanel event must be smaller than 1MB of uncompressed JSON.");
    walk(event.properties, 0);
    const time = event.properties.time as number;
    const earliest = Date.UTC(1971, 0, 1);
    const latest = Date.now() + 3_600_000;
    const seconds = time >= earliest / 1000 && time <= latest / 1000;
    const milliseconds = time >= earliest && time <= latest;
    if (!seconds && !milliseconds)
      invalid("Mixpanel event time must be after 1971-01-01 and no more than one hour in the future.");
  }
}
