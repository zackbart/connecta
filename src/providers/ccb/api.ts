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
import { ConnectorCallError } from "../../errors.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { restSafety } from "../../http/safety.js";
import type { HatchDeclaration } from "../../http/hatch.js";
import type { HatchPageAdapter } from "../../http/hatch-paging.js";
import { openapi } from "./openapi.generated.js";
import { CCB_VALUE_SAFETY } from "./safety.js";
import { CCB_VERDICTS } from "./lib/verdicts.js";
export { CCB_VERDICTS };
import type { ApiOAuthConfig } from "../../connectors/api-connector.js";
import { bearer } from "../../http/oauth.js";
import { get, type Connection } from "../../http/vendor.js";
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
  list_individual_notes: "GET /individuals/{id}/notes",
  get_giving_metrics: (args) =>
    args["familyId"] !== undefined ? "GET /families/{id}/metrics/giving" : "GET /individuals/{id}/metrics/giving",
  search_records: (args) => `POST /search/${typeof args["domain"] === "string" ? args["domain"] : "?"}/results`,
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
    const method =
      toolName === "ccb_api_read"
        ? typeof args["method"] === "string"
          ? args["method"]
          : "GET"
        : typeof args["method"] === "string"
          ? args["method"]
          : "?";
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

const summaries: Readonly<Record<string, string>> = {
  "GET /individuals": "List people (person profiles, individuals), search names, email and phone",
  "GET /individuals/{id}": "Get a person profile (individual) for identity or update reconciliation",
  "PUT /individuals/{id}": "Update a person's email or edit a person profile, name or phone (individual)",
  "POST /individuals": "Create or add a person profile (individual)",
  "POST /individuals/{id}/notes": "Add or create a pastoral note for a person (individual)",
  "GET /families": "List households and families",
  "GET /groups/{id}/members": "List church group members and leaders, roster",
  "POST /search/individuals/results": "Search people and individual profiles with advanced configuration and filters",
  "GET /campuses": "List church campuses, timezone and public gift message",
};
const details = JSON.parse(openapi.details) as {
  d: unknown[];
  o: Array<0 | [Array<[string, string, number, unknown, string?]>, unknown]>;
};
for (const row of details.o) {
  if (row)
    for (const parameter of row[0])
      if (!parameter[4])
        parameter[4] =
          (
            {
              id: "Record id from a prior read; resolve the target before acting.",
              page: "Vendor page number restored from the signed continuation.",
              per_page: "Page size: 25, 50, 75 or 100; defaults to 25.",
              name: "Partial name search.",
            } as Record<string, string>
          )[parameter[0]] ?? `${parameter[0].replaceAll("_", " ")} ${parameter[1]} parameter from the vendor contract.`;
}
export const CCB_INDEX = new OperationIndex(
  {
    ...openapi,
    details: JSON.stringify(details),
    ops: openapi.ops.map((row) => {
      const summary = summaries[`${row[0]} ${row[1]}`];
      const label = summary ? `${summary}; ${row[3]}` : row[3];
      return row[5] === undefined
        ? ([row[0], row[1], row[2], label, row[4]] as const)
        : ([row[0], row[1], row[2], label, row[4], row[5]] as const);
    }),
  },
  { vendor: "ccb", title: "CCB" },
);
export const getMe = get("getMe", "/me", { success: Schema.Unknown });
export const CcbApi = indexedVendor("CCB", CCB_INDEX, [getMe]);
const safety = valueSafety(CCB_VALUE_SAFETY, () => CCB_INDEX);
export const CCB_PAGE_HEADERS = ["x-page", "x-next-page", "x-total-pages", "x-total"] as const;
export function ccbPageInfo(
  headers: Readonly<Record<string, string>>,
  page: number,
  size: number,
  rows: number,
): number | null {
  const number = (name: string) => {
    const raw = headers[name];
    if (raw === undefined || raw === "") return undefined;
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new ConnectorCallError("connector_call_failed", "CCB returned invalid paging metadata.", {
        retryable: false,
      });
    return Number(raw);
  };
  const current = number("x-page") ?? page;
  if (current !== page)
    throw new ConnectorCallError("connector_call_failed", "CCB returned a different page than requested.", {
      retryable: false,
    });
  let next: number | null;
  if (Object.hasOwn(headers, "x-next-page")) next = number("x-next-page") ?? null;
  else {
    const pages = number("x-total-pages");
    next = pages === undefined ? (rows >= size ? page + 1 : null) : page < pages ? page + 1 : null;
  }
  if (next !== null && (!rows || next <= page))
    throw new ConnectorCallError("connector_call_failed", "CCB returned a nonadvancing or empty continuing page.", {
      retryable: false,
    });
  return next;
}
const pageAdapter: HatchPageAdapter = {
  param: "page",
  in: "query",
  headers: CCB_PAGE_HEADERS,
  decode: (cursor) => {
    const value = Number(cursor);
    if (!/^[1-9]\d*$/.test(String(cursor)) || !Number.isSafeInteger(value))
      throw new ConnectorCallError("invalid_args", "This CCB cursor contains no valid page number.");
    return value;
  },
  next: (data, call) => {
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(asRecord(data)["items"])
        ? asRecord(data)["items"]
        : undefined;
    if (!rows && !Object.hasOwn(call.headers, "x-next-page") && !Object.hasOwn(call.headers, "x-total-pages"))
      return undefined;
    return ccbPageInfo(
      call.headers,
      Number(call.query["page"] ?? 1),
      Number(call.query["per_page"] ?? 25),
      rows?.length ?? 1,
    );
  },
};
export const CCB_PAGES: NonNullable<HatchDeclaration["pages"]> = Object.fromEntries(
  CCB_INDEX.ops
    .filter(
      (op) =>
        CCB_VERDICTS[`${op.method} ${op.path}` as keyof typeof CCB_VERDICTS] === "read" &&
        op.path !== "/search/schedules_totals/results" &&
        CCB_INDEX.contract(op).parameters.some((p) => p.in === "query" && p.name === "page"),
    )
    .map((op) => [`${op.method} ${op.path}`, pageAdapter]),
);
export const CCB_NAMED: NonNullable<HatchDeclaration["named"]> = {
  "GET /me": "get_me",
  "GET /individuals": "list_individuals",
  "GET /individuals/{id}": "get_individual",
  "GET /families": "list_families",
  "GET /families/{id}": "get_family",
  "GET /groups": "list_groups",
  "GET /groups/{id}": "get_group",
  "GET /groups/{id}/members": "list_group_members",
  "GET /individuals/{id}/groups": "list_individual_groups",
  "GET /events": "list_events",
  "GET /events/{id}": "get_event",
  "GET /events/{id}/attendance/{occurrence}": "get_event_attendance",
  "GET /events/{id}/attendance/{occurrence}/attendees": "list_event_attendees",
  "GET /individuals/{id}/notes": "list_individual_notes",
  "GET /individuals/{id}/metrics/giving": "get_giving_metrics",
  "GET /families/{id}/metrics/giving": "get_giving_metrics",
  ...Object.fromEntries(SEARCH_DOMAINS.map((domain) => [`POST /search/${domain}/results`, "search_records"])),
};
function pathProblem(path: string): string | undefined {
  return !path.startsWith("/") ||
    path.startsWith("//") ||
    /[%;\\?#]/.test(path) ||
    path.split("/").some((p) => p === "." || p === "..") ||
    /^\/oauth(?:\/|$)/i.test(path)
    ? "CCB paths must be canonical indexed API paths; OAuth and encoded or traversal paths are refused."
    : undefined;
}
export const ccbBinding = ({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<CcbOptions>;
}): NonNullable<HatchDeclaration["binding"]> => ({
  review:
    "CCB v2 uses JSON bodies, repeated form-array query parameters and deep-object bracket keys on its fixed environment origin. The index, safety and OAuth grant own admission and dispatch.",
  refuse: (call) => {
    const denied = safety.refusal(call.method, call.op.path);
    if (denied) return denied;
    const path = pathProblem(call.path);
    if (path) return path;
    if (
      CCB_VERDICTS[`${call.method} ${call.op.path}` as keyof typeof CCB_VERDICTS] !== "read" &&
      !resolveScopes(options).some((scope) => !scope.startsWith("read:"))
    )
      return "This CCB connection has only read scopes; writes are refused.";
    const size = call.query["per_page"];
    if (size !== undefined && !/^(25|50|75|100)$/.test(String(size)))
      return "CCB per_page must be one of 25, 50, 75, 100.";
    const page = call.query["page"];
    if (page !== undefined && (!/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))))
      return "CCB page must be a positive whole number.";
    const content = CCB_INDEX.bodyType(call.op);
    return call.body !== undefined && content && !/^application\/(?:[^/]+\+)?json$/.test(content)
      ? "CCB's indexed hatch supports JSON requests; upload files in the vendor application."
      : undefined;
  },
  send: (call, settings) =>
    connection.sendPath(
      {
        method: call.method,
        path: call.path,
        template: call.op.path,
        query: queryPairs(call.query),
        ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
      },
      settings,
    ),
});
function queryPairs(query: Readonly<Record<string, unknown>>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const add = (name: string, value: unknown) => {
    if (Array.isArray(value)) for (const item of value) add(name, item);
    else if (value !== null && typeof value === "object")
      for (const [key, item] of Object.entries(value)) add(`${name}[${key}]`, item);
    else if (value !== undefined) out.push([name, String(value ?? "")]);
  };
  for (const [name, value] of Object.entries(query)) add(name, value);
  return out;
}
/** Uniform v2 privacy review, including the legacy hatches' unindexed paths. */
export function ccbSafety(options: Readonly<CcbOptions>): SafetyOptions {
  return {
    reviewed: restSafety(safety, CCB_INDEX),
    sensitiveFields: { names: CCB_SENSITIVE_FIELDS, choice: options.sensitiveFields ?? "drop" },
  };
}
export type Query = Readonly<Record<string, string | number | boolean | readonly (string | number)[] | undefined>>;
export interface CcbRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Query;
  readonly body?: unknown;
}
export function callCcb(connection: Connection, request: CcbRequest) {
  return Effect.gen(function* () {
    const query = Object.fromEntries(Object.entries(request.query ?? {}).filter(([, value]) => value !== undefined));
    const op = yield* checked(() => {
      const problem = pathProblem(request.path);
      if (problem) throw new ConnectorCallError("invalid_args", problem);
      const { op } = CCB_INDEX.resolve(request.method, request.path);
      CCB_INDEX.check(op, query, request.body);
      return op;
    });
    const answer = yield* connection.sendPath(
      {
        method: request.method,
        path: request.path,
        template: op.path,
        query: queryPairs(query),
        ...(request.body === undefined ? {} : { json: JSON.stringify(request.body) }),
      },
      { responseHeaders: CCB_PAGE_HEADERS },
    );
    return { body: answer.data, headers: new Headers(answer.headers) };
  });
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
  return detail ? `CCB HTTP ${status}: ${detail}${/[.!?]$/.test(detail) ? "" : "."}` : `CCB returned HTTP ${status}.`;
}

export const errors: VendorErrors = {
  meanings: { unknownId: "not_found", provesAbsence: true, conflicts: [] },
  bodyFailures: {
    statusOnly: [],
    review:
      "An incomplete response body does not establish malformed JSON. Preserve CCB OAuth and write settlement semantics.",
    readFailed: "CCB's response body could not be read completely.",
  },
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
    resetAfterMs: {
      header: "x-ratelimit-reset",
      format: "epoch-seconds",
      review: "CCB endpoint rate-limit reset time in epoch seconds.",
    },
    bodyRetryAfterMs: {
      path: ["retry_after"],
      format: "seconds",
      review: "CCB rate-limit response body delay in seconds.",
    },
  },
  provider: "CCB",
  facts: () => ({}),
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
    412: () => ({ code: "invalid_args" }),
    429: ({ retryAfterMs, numbers }) => {
      const wait = retryAfterMs ?? numbers["resetAfterMs"] ?? numbers["bodyRetryAfterMs"];
      return {
        code: "rate_limited",
        retryAfterMs: wait,
        words: (detail) => `${detail} CCB limits each endpoint per API client.`,
        advice: "; wait before calling this endpoint again",
      };
    },
  },
};
