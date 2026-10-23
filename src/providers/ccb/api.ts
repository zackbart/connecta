import {
  CCB_MEDIA_TYPE,
  CCB_ENVIRONMENTS,
  CCB_READ_SCOPES,
  CCB_WRITE_SCOPES,
  CCB_SENSITIVE_FIELDS,
} from "./lib/constants.js";
// Pushpay ChMS v2 JSON contracts, OAuth, status meanings, admission and privacy.
// The legacy per-church XML API is outside this provider's scope.
import { Effect, Schema } from "effect";
import type { ApiOAuthConfig } from "../../connectors/api-connector.js";
import { Integer } from "../../http/json-schema.js";
import { bearer } from "../../http/oauth.js";
import { get, post, vendor, type Connection } from "../../http/vendor.js";
import type { VendorErrors } from "../../http/errors.js";
import type { SafetyOptions } from "../../http/safety.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import type { CcbOptions } from "./index.js";
export const authenticate = bearer;
const SCOPE_SHAPE = /^(read|write|delete):[a-z_]+$/;

/** CCB's own minimum, which is also the cheapest honest first read. */
export const DEFAULT_PER_PAGE = 25;
/**
 * A ceiling on absurdity rather than a budget: at 100 rows per page the
 * fattest documented list (individuals with addresses) stays far below it.
 */
export const CCB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * CCB meters the v2 API per endpoint and per API client: one request a second
 * sustained with a burst of 60 (docs.pushpay.io/chms-v2/docs/general). Three
 * endpoints are stricter and allow no burst — `/individuals/{id}` at one a
 * second, `/scheduling/categories/{id}/schedules` at one per two seconds, and
 * `/search/individuals/results` at one per five.
 *
 * What ships is one rolling window of 60 calls per 60 seconds, partitioned by
 * endpoint (method plus path template), which is the documented default
 * transcribed as faithfully as one rule can: it never admits more than the
 * token bucket would in any minute, because a bucket of 60 refilling at one a
 * second can pass up to 120 in a minute and the window passes 60. Partitioning
 * matters — a single connector-wide window would throttle a healthy program
 * that touches ten endpoints to a tenth of what CCB allows.
 *
 * What it cannot express is the three no-burst overrides: this release
 * enforces one rule, and a rule has one budget for every partition. Those are
 * left to CCB's own 429, which carries `retry-after` and maps to a
 * `rate_limited` failure with that wait; the guide says to space those calls.
 * No `maxConcurrency` is declared: per-endpoint concurrency would not keep a
 * fast loop under one a second, and the window already bounds the burst.
 *
 * Per runtime, and per API client only as far as one runtime is the whole
 * client: other deployments, isolates, or integrations using the same client
 * spend from CCB's bucket without spending from this window.
 */
export const CCB_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      budget: { kind: "rolling-window", maxCalls: 60, windowMs: 60_000 },
      partitionKey: ({ toolName, args }) => endpointPartition(toolName, args),
    },
  ],
};

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Admission partitions
// ---------------------------------------------------------------------------

/** The method and path template each named tool calls. */
const NAMED_ENDPOINTS: Readonly<Record<string, string | ((args: JsonRecord) => string)>> = {
  get_me: "GET /me",
  list_individuals: "GET /individuals",
  get_individual: "GET /individuals/{id}",
  list_families: "GET /families",
  get_family: "GET /families/{id}",
  list_groups: "GET /groups",
  get_group: "GET /groups/{id}",
  list_group_members: "GET /groups/{id}/members",
  list_individual_groups: "GET /individuals/{id}/groups",
  list_events: "GET /events",
  get_event: "GET /events/{id}",
  get_event_attendance: "GET /events/{id}/attendance/{occurrence}",
  list_event_attendees: "GET /events/{id}/attendance/{occurrence}/attendees",
  list_forms: "GET /forms",
  list_form_responses: "GET /forms/{id}/responses",
  list_processes: "GET /processes",
  list_queues: "GET /queues",
  list_queue_individuals: "GET /queues_individuals",
  list_scheduling_categories: "GET /scheduling/categories",
  list_schedules: "GET /scheduling/categories/{id}/schedules",
  list_individual_assignments: "GET /individuals/{id}/assignments",
  list_individual_notes: "GET /individuals/{id}/notes",
  get_giving_metrics: (args) =>
    args["familyId"] !== undefined ? "GET /families/{id}/metrics/giving" : "GET /individuals/{id}/metrics/giving",
  list_individual_pledges: "GET /individuals/{id}/pledges",
  ccb_api_search: (args) => `POST /search/${typeof args["domain"] === "string" ? args["domain"] : "?"}/results`,
};

/** `/individuals/123/notes` → `/individuals/{id}/notes`; the key never holds an id. */
function pathTemplate(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? "{id}" : segment))
    .join("/");
}

const MAX_PARTITION_KEY_CHARS = 120;

/**
 * The CCB endpoint one call will spend from, as a bounded, id-free key. Runs
 * before argument validation, so it reads arguments defensively and never
 * throws: a malformed hatch path falls into one shared partition and is then
 * refused by the handler.
 */
function endpointPartition(toolName: string, raw: unknown): string {
  const args = asRecord(raw);
  const named = NAMED_ENDPOINTS[toolName];
  let key: string;
  if (typeof named === "string") key = named;
  else if (named) key = named(args);
  else {
    const method = toolName === "ccb_api_get" ? "GET" : typeof args["method"] === "string" ? args["method"] : "?";
    const path = typeof args["path"] === "string" ? args["path"] : "";
    key = `${method} ${pathTemplate(path)}`;
  }
  // ASCII-only after templating in every realistic case; the slice keeps an
  // absurd path inside the admission controller's 128-byte key limit anyway.
  return [...key]
    .filter((c) => c.charCodeAt(0) < 128)
    .join("")
    .slice(0, MAX_PARTITION_KEY_CHARS);
}

export function resolveScopes(options: Readonly<CcbOptions>): readonly string[] {
  if (options.scopes !== undefined && options.access !== undefined) {
    throw new Error("ccb() takes access or scopes, not both: scopes is the exact list and replaces access.");
  }
  if (options.scopes === undefined) {
    const access = options.access ?? "read";
    if (access !== "read" && access !== "read-write") {
      throw new Error('ccb() access must be "read" or "read-write".');
    }
    return access === "read" ? CCB_READ_SCOPES : [...CCB_READ_SCOPES, ...CCB_WRITE_SCOPES];
  }
  if (!Array.isArray(options.scopes) || options.scopes.length === 0) {
    throw new Error("ccb() scopes must be a non-empty list.");
  }
  const seen = new Set<string>();
  for (const scope of options.scopes) {
    if (typeof scope !== "string" || !SCOPE_SHAPE.test(scope)) {
      throw new Error(`ccb() scope "${String(scope)}" is not a CCB scope; CCB scopes look like read:individuals.`);
    }
    if (seen.has(scope)) throw new Error(`ccb() scope "${scope}" is listed twice.`);
    seen.add(scope);
  }
  return [...options.scopes];
}

export const SEARCH_DOMAINS = [
  "assignments",
  "categories",
  "department_detail",
  "groups",
  "individual_event_attendance",
  "individual_groups",
  "individuals",
  "organizers",
  "positions",
  "schedules",
  "schedules_totals",
  "scheduling_files",
  "scheduling_individuals",
  "songs",
  "volunteers",
] as const;

const ErrorEnvelope = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
export const getMe = get("getMe", "/me", { success: Schema.Unknown, error: ErrorEnvelope });
export const CcbApi = vendor(
  "CCB",
  post("getAccessToken", "/oauth/token", { success: Schema.Unknown, error: ErrorEnvelope }),
  getMe,
  get("getIndividuals", "/individuals", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getIndividual", "/individuals/:id", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getFamilies", "/families", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getFamily", "/families/:id", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getGroups", "/groups", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getGroup", "/groups/:id", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getGroupMembers", "/groups/:id/members", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getIndividualsGroups", "/individuals/:id/groups", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getEvents", "/events", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getEvent", "/events/:id", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getEventSummary", "/events/:id/attendance/:occurrence", {
    params: Schema.Struct({ "id": Integer, "occurrence": Schema.String }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getEventAttendees", "/events/:id/attendance/:occurrence/attendees", {
    params: Schema.Struct({ "id": Integer, "occurrence": Schema.String }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getForms", "/forms", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getFormResponses", "/forms/:id/responses", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getProcesses", "/processes", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("listQueues", "/queues", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getStepIndividuals", "/queues_individuals", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getScheduleCategories", "/scheduling/categories", { success: Schema.Unknown, error: ErrorEnvelope }),
  get("getSchedules", "/scheduling/categories/:id/schedules", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getIndividualAssignments", "/individuals/:id/assignments", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getIndividualNotes", "/individuals/:id/notes", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getIndividualMetricsGiving", "/individuals/:id/metrics/giving", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getFamilyMetricsGiving", "/families/:id/metrics/giving", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  get("getIndividualPledges", "/individuals/:id/pledges", {
    params: Schema.Struct({ "id": Integer }),
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getSchedulingAssignmentAdvancedSearchResults", "/search/assignments/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getSchedulingCategoriesAdvancedSearchResults", "/search/categories/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getDepartmentDetailAdvancedSearchResults", "/search/department_detail/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getGroupAdvancedSearchResults", "/search/groups/results", { success: Schema.Unknown, error: ErrorEnvelope }),
  post("getEventAttendanceAdvancedSearchResults", "/search/individual_event_attendance/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getIndividualGroupAdvancedSearchResults", "/search/individual_groups/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getIndividualAdvancedSearchResults", "/search/individuals/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getSchedulingOrganizerAdvancedSearchResults", "/search/organizers/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getSchedulingPositionAdvancedSearchResults", "/search/positions/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getScheduleAdvancedSearchResults", "/search/schedules/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getScheduleTotalAdvancedSearchResults", "/search/schedules_totals/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getScheduleFileAdvancedSearchResults", "/search/scheduling_files/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getSchedulingIndividualAdvancedSearchResults", "/search/scheduling_individuals/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
  post("getSongAdvancedSearchResults", "/search/songs/results", { success: Schema.Unknown, error: ErrorEnvelope }),
  post("getSchedulingVolunteerAdvancedSearchResults", "/search/volunteers/results", {
    success: Schema.Unknown,
    error: ErrorEnvelope,
  }),
);
/** Uniform v2 privacy review, including the legacy hatches' unindexed paths. */
export function ccbSafety(options: Readonly<CcbOptions>): SafetyOptions {
  return {
    review:
      "CCB v2 returns church records rather than stored API credentials. Its documented private fields are removed at every depth, before any projection, raw result, hatch or pagination reads them; only deployment configuration permits their return.",
    sensitiveFields: { names: CCB_SENSITIVE_FIELDS, choice: options.sensitiveFields ?? "drop" },
  };
}
export type Query = Readonly<Record<string, string | number | boolean | undefined>>;
export interface CcbRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Query;
  readonly body?: unknown;
}
/** Keep only the already-redacted paging headers beside the JSON body through value safety. */
export const result = (body: unknown, answer: { headers: Headers }) =>
  Effect.succeed({
    body,
    pageHeaders: [...answer.headers].filter(([name]) =>
      ["x-page", "x-next-page", "x-total-pages", "x-total"].includes(name),
    ),
  });
export function callCcb(connection: Connection, request: CcbRequest) {
  return connection
    .sendPath({
      method: request.method,
      path: request.path,
      template: request.path,
      query: Object.entries(request.query ?? {})
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([name, value]) => [name, String(value)] as [string, string]),
      ...(request.body !== undefined ? { json: JSON.stringify(request.body) } : {}),
    })
    .pipe(
      Effect.map(({ data }) => {
        const envelope = asRecord(data);
        return { body: envelope["body"], headers: new Headers(envelope["pageHeaders"]) };
      }),
    );
}
export function oauth(options: Readonly<CcbOptions>): ApiOAuthConfig {
  const endpoints = CCB_ENVIRONMENTS[options.environment];
  return {
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: `${endpoints.apiOrigin}/oauth/token`,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scope: resolveScopes(options).join(" "),
    authorizationParams: {
      ...(options.mode === "identity" ? { resource_owner_auth: "true" } : {}),
      ...(options.subdomain?.trim() ? { subdomain: options.subdomain.trim() } : {}),
    },
    tokenRequestHeaders: { Accept: CCB_MEDIA_TYPE },
    apiOrigins: [endpoints.apiOrigin],
  };
}
function errorDetail(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const parts: string[] = [];
  for (const key of ["message", "error_description", "error"]) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(value.trim());
      break;
    }
  }
  for (const item of asArray(root["errors"]).slice(0, 5)) {
    if (typeof item === "string" && item.trim()) parts.push(item.trim());
    else {
      const message = asRecord(item)["message"];
      if (typeof message === "string" && message.trim()) parts.push(message.trim());
    }
  }
  const detail = parts.join("; ").slice(0, 500);
  return detail ? `CCB HTTP ${status}: ${detail}` : `CCB returned HTTP ${status}.`;
}

export const errors: VendorErrors = {
  provider: "CCB",
  facts: (body) => {
    const value = Number(asRecord(body)["retry_after"]);
    return { retryAfter: Number.isFinite(value) && value >= 0 ? Math.trunc(value * 1000) : undefined };
  },
  headers: ["x-ratelimit-reset"],
  detail: ({ body, status }) => errorDetail(body, status),
  unreadable: "CCB returned a successful response that is not JSON.",
  statuses: {
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} CCB rejected the connection's access token. Call authorize_connector for this connector.`,
      advice: ", then retry",
    }),
    403: () => ({
      code: "provider_permission_denied",
      retryable: false,
      words: (detail) =>
        `${detail} The grant lacks this endpoint's scope, or (Identity Auth) the signed-in person lacks the permission in CCB. Ask the CCB administrator to grant this endpoint's scope or the signed-in person's permission. Re-authorizing alone will not fix it.`,
    }),
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `${detail} Re-read the id from its list tool; CCB reports a permission gap as 403, so this record does not exist.`,
    }),
    409: () => ({ code: "conflict" }),
    412: () => ({ code: "invalid_args" }),
    429: ({ retryAfterMs, headers, facts }) => {
      const reset = Number(headers["x-ratelimit-reset"]);
      const wait =
        retryAfterMs ??
        (headers["x-ratelimit-reset"] && Number.isFinite(reset)
          ? Math.max(0, Math.trunc(reset * 1000 - Date.now()))
          : typeof facts["retryAfter"] === "number"
            ? facts["retryAfter"]
            : undefined);
      return {
        code: "rate_limited",
        retryAfterMs: wait,
        words: (detail) => `${detail} CCB limits each endpoint per API client.`,
        advice: "; wait before calling this endpoint again",
      };
    },
    serverError: ({ retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs,
      words: (detail) => `${detail} CCB is failing upstream.`,
    }),
  },
};
