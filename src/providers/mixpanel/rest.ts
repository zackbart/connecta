import type { ApiTool } from "../../connectors/api-connector.js";
import { retryAfterMs, type GuardedTransport } from "../../connectors/guarded-fetch.js";
import { credentialProbeContext } from "../../runtime/credential-probe.js";
import { ConnectorCallError, resendAdvice } from "../../errors.js";
import type { ConnectorContext, ConnectorCallAdmissionPolicy, CredentialTestResult, JsonSchema } from "../../types.js";
import { OperationIndex, type RestMethod } from "../_shared/rest/operation-index.js";
import { callRest, restCall, restTools, restTransport, type RestVendor, type RestCall } from "../_shared/rest/tools.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { openapi } from "./operations.js";
import { MIXPANEL_VALUE_SAFETY } from "./value-safety.js";
import type { MixpanelRegion } from "./index.js";

/** Per runtime and connection, conservatively shared across its projects and API families. */
export const MIXPANEL_API_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 5,
      budget: { kind: "rolling-window", maxCalls: 60, windowMs: 3_600_000 },
      maxQueueSize: 16,
      queueTimeoutMs: 5_000,
    },
  ],
};

const INDEX = new OperationIndex(openapi, { vendor: "mixpanel", title: "Mixpanel" });
const SAFETY = valueSafety(MIXPANEL_VALUE_SAFETY, () => INDEX);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}
function project(value: unknown, defaultProjectId?: number): number {
  const id = value ?? defaultProjectId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    invalid("Supply a positive project_id from list_projects or configure defaultProjectId; never guess one.");
  return id;
}
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
function failure(status: number, headers: Headers): ConnectorCallError {
  if (status === 401)
    return new ConnectorCallError(
      "auth_required",
      "Mixpanel rejected the service account. An operator must set username:secret in this connection's operator UI.",
    );
  if (status === 403)
    return new ConnectorCallError(
      "provider_permission_denied",
      "Mixpanel refused access. Check the service account's project membership, data sensitivity and role; import needs Owner or Admin.",
      { retryable: false },
    );
  if (status === 429)
    return resendAdvice(
      new ConnectorCallError("rate_limited", "Mixpanel's project API budget is spent.", {
        retryAfterMs: retryAfterMs(headers) ?? 60_000,
      }),
      "; respect the retry window",
    );
  const wait = retryAfterMs(headers);
  if (status >= 500)
    return new ConnectorCallError(
      "unavailable",
      `Mixpanel returned HTTP ${status}.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  return new ConnectorCallError(
    "connector_call_failed",
    `Mixpanel returned HTTP ${status}. Check the documented parameters, project access and region. Import failures can partially ingest valid records; inspect the target before repeating.`,
    { retryable: false },
  );
}
async function authenticate(ctx: ConnectorContext): Promise<Record<string, string>> {
  const pair = await ctx.credential?.get();
  if (!pair)
    throw new ConnectorCallError(
      "auth_required",
      "An operator must set the Mixpanel service account as username:secret in this connection's operator UI.",
    );
  const colon = pair.indexOf(":");
  if (colon < 1 || colon === pair.length - 1 || /[\r\n]/.test(pair))
    throw new ConnectorCallError(
      "auth_required",
      "The Mixpanel service account must be username:secret, with both fields non-empty.",
    );
  const bytes = encoder.encode(pair);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { Authorization: `Basic ${btoa(binary)}` };
}
function encode(call: RestCall) {
  if (call.op.path === "/api/query/engage") {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(call.body as Record<string, unknown>)) {
      if (value !== undefined)
        form.set(key, Array.isArray(value) || record(value) ? JSON.stringify(value) : String(value));
    }
    return {
      query: call.query as Record<string, string | number>,
      rawBody: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    };
  }
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(call.query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) query[key] = JSON.stringify(value);
    else if (["string", "number", "boolean"].includes(typeof value)) query[key] = value as string | number | boolean;
    else invalid(`Mixpanel query ${key} must be a scalar or JSON array.`);
  }
  return { query, ...(call.body !== undefined ? { body: call.body } : {}) };
}

/** Every dispatch has one fixed documented operation and residency host. */
export function mixpanelRest(
  region: MixpanelRegion,
  defaultProjectId?: number,
): { tools: ApiTool[]; testCredential(value: string, ctx: ConnectorContext): Promise<CredentialTestResult> } {
  const app = region === "us" ? "mixpanel.com" : `${region}.mixpanel.com`;
  const suffix = region === "us" ? "" : `-${region}`;
  const origins = {
    query: `https://${app}`,
    app: `https://${app}`,
    export: `https://data${suffix}.mixpanel.com`,
    ingestion: `https://api${suffix}.mixpanel.com`,
  };
  const transports = Object.fromEntries(
    Object.entries(origins).map(([server, baseUrl]) => [
      server,
      restTransport({
        provider: "Mixpanel",
        baseUrl,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        timeoutMs: 60_000,
        authenticate,
      }),
    ]),
  ) as Record<string, GuardedTransport>;
  const vendor: RestVendor = {
    vendor: "mixpanel",
    title: "Mixpanel",
    index: INDEX,
    valueSafety: SAFETY,
    transport: (server) => transports[server ?? "query"] ?? "Mixpanel admits only its reviewed residency hosts.",
    failure,
    encode,
    readPosts: [["POST", "/api/query/engage", "Queries existing profiles; no profile mutation or ingestion occurs."]],
    scope: (call) =>
      call.path === "/api/app/me"
        ? call
        : { ...call, query: { ...call.query, project_id: project(call.query.project_id, defaultProjectId) } },
    result: (body) => {
      if (record(body) && (body.status === "error" || body.status === 0 || body.error))
        throw new ConnectorCallError(
          "connector_call_failed",
          "Mixpanel reported a failure in a successful HTTP response. Check parameters and project access.",
          { retryable: false },
        );
      return body;
    },
  };
  const request = (
    ctx: ConnectorContext,
    method: RestMethod,
    path: string,
    query: Record<string, unknown> = {},
    body?: unknown,
  ) => callRest(vendor, restCall(vendor, method, path, { query, body }), ctx);

  async function exportEvents(args: Record<string, unknown>, ctx: ConnectorContext) {
    dates(args);
    const maxBytes = args.max_bytes ?? DEFAULT_EXPORT_BYTES;
    const limit = args.limit ?? 1000;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EXPORT_BYTES)
      invalid("max_bytes must be 1..1048576, Connecta's export ceiling.");
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100_000)
      invalid("limit must be 1..100000, Mixpanel's export event ceiling.");
    const call = restCall(vendor, "GET", "/api/2.0/export", { query: { ...args, max_bytes: undefined, limit } });
    const framing = encode(call);
    return transports.export!(
      { method: "GET", path: call.path, query: framing.query, prefixOnly: true },
      ctx,
      async (response) => {
        if (!response.ok) {
          // Cancel the unread error stream without waiting for its first chunk.
          // Await it so a direct connector call also owns the body's lifetime.
          try {
            await response.cancel();
          } catch {
            /* The status still describes an unreadable error response. */
          }
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          throw failure(response.status, response.headers);
        }
        const { bytes, truncated: byteTruncated } = await response.prefix(maxBytes);
        const text = new TextDecoder().decode(bytes);
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
          events: SAFETY.redact(events.slice(0, limit), "GET", call.path),
          bytes_read: bytes.length,
          truncated,
          notice: truncated
            ? "Export may omit events at the byte or event cap. There is no cursor; narrow the date range or filters. Never infer absence from this sample."
            : "Complete response for the requested range and filters.",
        };
      },
    );
  }

  function readTool(
    name: string,
    description: string,
    path: string,
    properties: Record<string, JsonSchema>,
    required: string[],
    handler?: ApiTool["handler"],
  ): ApiTool {
    return {
      name,
      description,
      annotations: READ,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      outputSchema: OUT,
      handler:
        handler ??
        (async (args, ctx) => {
          const { raw: _raw, ...query } = args;
          if (query.from_date !== undefined || query.to_date !== undefined) dates(query);
          if (path === "/api/query/retention") retention(query);
          return await request(ctx, "GET", path, query);
        }),
    };
  }
  const generic = restTools(vendor)
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
                const call = restCall(vendor, "GET", path, { query });
                INDEX.check(call.op, call.query, call.body);
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
                return { status: 200, data: await exportEvents({ ...query, event }, ctx) };
              }
              if (query.from_date !== undefined || query.to_date !== undefined) dates(query);
              if (path === "/api/query/retention") retention(query);
              return await tool.handler({ ...args, query }, ctx);
            },
          },
    );
  const tools: ApiTool[] = [
    ...generic,
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
      handler: exportEvents,
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
      async (args, ctx) => {
        dates(args);
        const { distinct_id, raw, ...query } = args;
        const result = await request(ctx, "GET", "/api/query/stream/query", { ...query, distinct_ids: [distinct_id] });
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
      },
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
      async (args, ctx) => {
        const { project_id, workspace_id, raw, ...body } = args;
        if (typeof body.page === "number" && body.page > 0 && !body.session_id)
          invalid("A nonzero profile page requires session_id from the previous response.");
        if (body.distinct_id !== undefined && body.distinct_ids !== undefined)
          invalid("Use distinct_id or distinct_ids, not both.");
        const result = await request(ctx, "POST", "/api/query/engage", { project_id, workspace_id }, body);
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
          throw new ConnectorCallError("connector_call_failed", "Mixpanel returned an unexpected profile page shape.", {
            retryable: false,
          });
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
          page: { hasMore, ...(hasMore ? { next: String(data.page + 1), param: "page", in: "body" as const } : {}) },
        };
      },
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
      handler: async (args, ctx) => {
        const events = args.events as unknown[];
        validateImport(events);
        return await request(ctx, "POST", "/import", { project_id: args.project_id, strict: "1" }, events);
      },
    },
  ];
  return {
    tools,
    async testCredential(value, ctx) {
      try {
        await request(credentialProbeContext(ctx, { value }), "GET", "/api/app/me");
        return {
          ok: true,
          message: "Authenticated Mixpanel service account; list_projects returns its reachable project metadata.",
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof ConnectorCallError ? error.message : "Mixpanel rejected the service account.",
        };
      }
    },
  };
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
