import { skill } from "./skill.generated.js";
/**
 * Church Community Builder — sold today as Pushpay ChMS — through its v2 JSON
 * REST API, hand-written over `api()`'s downstream OAuth grant.
 *
 * Why `ccb()` and not `pushpayChms()`: every wire contract this file depends
 * on says CCB — the `api.ccbchurch.com` host, the
 * `application/vnd.ccbchurch.v2+json` media type, the OAuth hosts — and so do
 * the churches that use it. "Pushpay" also names a separate giving platform
 * with its own API, so a `pushpay()` export would collide with the provider
 * that one day wraps it. The title says both names, so neither reader guesses.
 *
 * Considered and rejected: Pushpay hosts ReadMe "docs MCP" servers
 * (https://pushpay-chmsv2.readme.io/mcp). They search the documentation and
 * proxy raw HAR-shaped requests; they own no OAuth grant, project nothing,
 * classify nothing, and would hand an agent a generic request tool whose
 * safety class it chooses per call. This connector is the opposite trade:
 * named reads with projections, and raw access split by safety.
 *
 * Out of scope on purpose: transaction and batch listing exists only in the
 * legacy v1 XML API (`<church>.ccbchurch.com/api.php`, per-church API users,
 * a daily cap). v2 exposes giving only as per-person and per-family metrics,
 * pledges, scheduled gifts, and financial settings, and that is all this
 * connector reaches.
 *
 * Drift is handled the Vercel way: `src/providers/ccb/drift.json` records
 * every endpoint a named tool touches, and
 * `npm run providers:check -- --provider ccb` compares those rows with the
 * published, credential-free OpenAPI document at
 * https://docs.pushpay.io/chms-v2/openapi/chms-api-specs.json.
 */
import { api } from "../../connectors/api.js";
import { defined, type ApiTool } from "../../connectors/api-connector.js";
import {
  guardedFetch,
  oauthBearer,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  JsonSchema,
} from "../../types.js";
import { keys, optionsOf } from "../../config-schema.js";
import { CALL_ADMISSION } from "../../connectors/option-shapes.js";
import { asProviderFactory } from "../../provider.js";

/** CCB's v2 media type. The API and its token endpoint both require it. */
export const CCB_MEDIA_TYPE = "application/vnd.ccbchurch.v2+json";

/**
 * The two published environments. Credentials do not cross: sandbox clients
 * work only against the sandbox hosts and production clients only against
 * production, so the environment is part of the client, not a preference.
 */
export const CCB_ENVIRONMENTS = {
  production: {
    apiOrigin: "https://api.ccbchurch.com",
    authorizationEndpoint: "https://oauth.ccbchurch.com/oauth/authorize",
  },
  sandbox: {
    apiOrigin: "https://api-beta.ccbchurch.com",
    authorizationEndpoint: "https://beta-oauth.ccbchurch.com/oauth/authorize",
  },
} as const;

/**
 * The read scopes the named tools and the search hatch need, from the
 * `security` requirements of the operations they call (spec revision recorded
 * in the drift manifest). `read:campuses` and `read:church` are there so the
 * ids every projection carries — campus, membership type — can be resolved
 * through `ccb_api_get`. Request these on Pushpay's API access form.
 */
export const CCB_READ_SCOPES: readonly string[] = [
  "read:advanced_searches",
  "read:campuses",
  "read:church",
  "read:event_attendance",
  "read:events",
  "read:forms",
  "read:group_members",
  "read:groups",
  "read:individual_groups",
  "read:individual_notes",
  "read:individual_pledges",
  "read:individuals",
  "read:individuals_metrics",
  "read:process_queues",
  "read:queue_individuals",
  "read:scheduling",
];

/**
 * What `access: "read-write"` adds: the writes of the everyday staff jobs —
 * profiles, groups, events and attendance, form responses, notes, process
 * queues, scheduling. No `delete:` scope, nothing financial, no background
 * checks, and no privacy settings: those are deliberate, so they are only
 * ever requested through an explicit `scopes` list.
 */
export const CCB_WRITE_SCOPES: readonly string[] = [
  "write:event_attendance",
  "write:events",
  "write:form_responses",
  "write:group_members",
  "write:groups",
  "write:individual_groups",
  "write:individual_notes",
  "write:individuals",
  "write:notes",
  "write:queue_individuals",
  "write:scheduling",
];

const SCOPE_SHAPE = /^(read|write|delete):[a-z_]+$/;

const PER_PAGE_VALUES = [25, 50, 75, 100] as const;
/** CCB's own minimum, which is also the cheapest honest first read. */
const DEFAULT_PER_PAGE = 25;
/**
 * A ceiling on absurdity rather than a budget: at 100 rows per page the
 * fattest documented list (individuals with addresses) stays far below it.
 */
const CCB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
const CCB_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      budget: { kind: "rolling-window", maxCalls: 60, windowMs: 60_000 },
      partitionKey: ({ toolName, args }) => endpointPartition(toolName, args),
    },
  ],
};

/** How the grant acts: for the whole church, or as one signed-in person. */
export type CcbMode = "system" | "identity";

/** Which Pushpay environment the client was issued for. */
export type CcbEnvironment = keyof typeof CCB_ENVIRONMENTS;

export interface CcbOptions {
  /** Which church this connection reaches and what it is for. Required. */
  purpose: string;
  /** Human-readable display name; the default names environment, mode, and access. */
  title?: string;
  /** Church-specific conventions appended to the maintained guide. */
  instructions?: string;
  /**
   * The environment the OAuth client was issued for. Required, with no
   * default: sandbox credentials work only against the sandbox hosts and
   * production credentials only against production, and nothing in a client
   * id says which it is. A wrong guess fails at consent with CCB's opaque
   * "Error accessing page".
   */
  environment: CcbEnvironment;
  /**
   * `"system"` (System Auth): a Master Administrator, or someone who can edit
   * system-wide settings, approves the connection once for the whole church,
   * and every caller shares that one grant. `"identity"` (Identity Auth,
   * `resource_owner_auth=true`): each person signs in as themselves, CCB
   * applies that person's own permissions, and every grant is personal. Identity
   * Auth works only after the church has completed System Auth for the same
   * client. Required: the two modes reach different data for different people.
   */
  mode: CcbMode;
  /**
   * The OAuth client id Pushpay issued. Clients are issued by hand through
   * Pushpay's API access request form
   * (https://vendor.ccbchurch.com/goto/forms/15/responses/new), which also
   * fixes the scopes and the redirect URI — register
   * `<publicUrl>/oauth/callback/<id>` there, character for character.
   */
  clientId: string;
  /** The client secret, from deployment configuration. Never stored. */
  clientSecret: string;
  /**
   * `"read"` (default) requests {@link CCB_READ_SCOPES} and ships no write
   * tool; `"read-write"` adds {@link CCB_WRITE_SCOPES} and the approval-gated
   * `ccb_api_mutate`. Exclusive with `scopes`.
   */
  access?: "read" | "read-write";
  /**
   * The exact scope list to request, replacing `access`: narrower (drop
   * `read:individual_notes`) or wider (add `read:background_checks` for the
   * hatch). Must be a subset of what Pushpay granted the client. Any `write:`
   * or `delete:` scope ships `ccb_api_mutate`.
   */
  scopes?: readonly string[];
  /**
   * The church's CCB subdomain (`mychurch` for mychurch.ccbchurch.com). Sent
   * at consent so the approver skips typing it. Optional.
   */
  subdomain?: string;
  /** Default rows per page for list tools: 25 (default), 50, 75, or 100. */
  defaultPerPage?: 25 | 50 | 75 | 100;
  /**
   * Replaces the per-endpoint default admission policy. Pass your own to
   * account for other integrations spending from the same API client.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as T;
}

/** An object that is empty after compaction reads as absent. */
function present(value: JsonRecord): JsonRecord | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
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
    args["familyId"] !== undefined
      ? "GET /families/{id}/metrics/giving"
      : "GET /individuals/{id}/metrics/giving",
  list_individual_pledges: "GET /individuals/{id}/pledges",
  ccb_api_search: (args) =>
    `POST /search/${typeof args["domain"] === "string" ? args["domain"] : "?"}/results`,
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
      toolName === "ccb_api_get"
        ? "GET"
        : typeof args["method"] === "string"
          ? args["method"]
          : "?";
    const path = typeof args["path"] === "string" ? args["path"] : "";
    key = `${method} ${pathTemplate(path)}`;
  }
  // ASCII-only after templating in every realistic case; the slice keeps an
  // absurd path inside the admission controller's 128-byte key limit anyway.
  return [...key].filter((c) => c.charCodeAt(0) < 128).join("").slice(0, MAX_PARTITION_KEY_CHARS);
}

// ---------------------------------------------------------------------------
// Transport and typed failures
// ---------------------------------------------------------------------------

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

/** The wait CCB states: `retry-after`, else the `x-ratelimit-reset` epoch. */
function rateLimitWaitMs(headers: Headers, payload: unknown): number | undefined {
  const stated = retryAfterMs(headers);
  if (stated !== undefined) return stated;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-reset") && Number.isFinite(reset)) {
    return Math.max(0, Math.trunc(reset * 1_000 - Date.now()));
  }
  const body = Number(asRecord(payload)["retry_after"]);
  return Number.isFinite(body) && body >= 0 ? Math.trunc(body * 1_000) : undefined;
}

/**
 * Map a CCB failure by what the caller does next.
 *
 * A 401 rarely reaches here: `ctx.oauth.fetch` answers one with a refresh and
 * a replay and throws `auth_required` itself when that fails. A 403 is not
 * `auth_required`, because re-consenting with the same scopes cannot fix it:
 * either the client was not granted the scope (an operator widens `scopes`
 * and restarts authorization) or, in Identity Auth, the signed-in person
 * lacks the permission in CCB. CCB answers a permission gap with 403 and an
 * absence with 404, so 404 is a genuine `not_found`.
 */
function ccbFailure(
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const detail = errorDetail(payload, status);
  if (status === 429) {
    const wait = rateLimitWaitMs(headers, payload);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} CCB limits each endpoint per API client; wait before calling this endpoint again.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} CCB rejected the connection's access token. Call authorize_connector for this connector, then retry.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} The grant lacks this endpoint's scope, or (Identity Auth) the signed-in person lacks the permission in CCB. Ask the CCB administrator to grant this endpoint's scope or the signed-in person's permission. Re-authorizing alone will not fix it.`,
      { retryable: false },
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `${detail} Re-read the id from its list tool; CCB reports a permission gap as 403, so this record does not exist.`,
    );
  }
  if (status === 409) return new ConnectorCallError("conflict", detail);
  if (status === 400 || status === 412 || status === 422) {
    return new ConnectorCallError("invalid_args", detail);
  }
  if (status >= 500) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `${detail} CCB is failing upstream.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError("connector_call_failed", detail, { retryable: false });
}

function ccbTransport(apiOrigin: string): GuardedTransport {
  return guardedFetch({
    provider: "CCB",
    baseUrl: apiOrigin,
    headers: { Accept: CCB_MEDIA_TYPE },
    maxResponseBytes: CCB_MAX_RESPONSE_BYTES,
    ...oauthBearer("CCB"),
  });
}

interface CcbResult {
  body: unknown;
  headers: Headers;
}

async function callCcb(
  send: GuardedTransport,
  request: GuardedRequest,
  ctx: ConnectorContext,
): Promise<CcbResult> {
  return await send(request, ctx, async (response) => {
    const parsed = await response.jsonResult();
    if (!response.ok) {
      throw ccbFailure(
        response.status,
        response.headers,
        "value" in parsed ? parsed.value : undefined,
      );
    }
    if (!("value" in parsed)) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "CCB returned a successful response that is not JSON.",
        { retryable: false },
      );
    }
    return { body: parsed.value, headers: response.headers };
  });
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

interface PageInfo {
  hasMore: boolean;
  nextPage: number | null;
  total: number | null;
}

/**
 * One branch for every list: `hasMore`, from `x-next-page` when CCB sends it
 * (empty on the last page), else `x-page` against `x-total-pages`, else — a
 * list that sent neither — a full page is read as "maybe more".
 */
function pageInfo(headers: Headers, page: number, perPage: number, rows: number): PageInfo {
  const current = headerInt(headers, "x-page") ?? page;
  const totalPages = headerInt(headers, "x-total-pages");
  let nextPage: number | null;
  if (headers.has("x-next-page")) nextPage = headerInt(headers, "x-next-page") ?? null;
  else if (totalPages !== undefined) nextPage = current < totalPages ? current + 1 : null;
  else nextPage = rows >= perPage ? current + 1 : null;
  return {
    hasMore: nextPage !== null,
    nextPage,
    total: headerInt(headers, "x-total") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Projections
//
// One mechanical rule: CCB's snake_case becomes camelCase, nested references
// flatten to an id and a name, and permission flags (`actions`), images,
// creator and modifier records are dropped everywhere. Sensitive fields are
// dropped too — allergies, giving numbers, envelope ids, giving dates and
// statement dates, prayer requests and meeting notes on attendance, payment
// details on form responses. `raw: true` returns CCB's row untouched.
// ---------------------------------------------------------------------------

function phones(value: unknown): JsonRecord | undefined {
  const phone = asRecord(value);
  return present(compact({
    mobile: phone["mobile"] || undefined,
    home: phone["home"] || undefined,
    work: phone["work"] || undefined,
  }));
}

function address(value: unknown): JsonRecord | undefined {
  const row = asRecord(value);
  return present(compact({
    street: row["street"] || undefined,
    city: row["city"] || undefined,
    state: row["state"] || undefined,
    zip: row["zip"] || undefined,
    country: row["country_iso"] || undefined,
  }));
}

function projectPerson(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    firstName: row["first_name"],
    lastName: row["last_name"],
    email: row["email"] || undefined,
    phones: phones(row["phone"]),
    birthday: row["birthday"],
    familyId: row["family_id"],
    familyPosition: row["family_position"],
    campusId: row["campus_id"],
    membershipTypeId: row["membership_type_id"],
    active: row["active"],
    deceased: row["deceased"],
  });
}

function projectIndividual(value: unknown): JsonRecord {
  const row = asRecord(value);
  const addresses = asRecord(row["addresses"]);
  return compact({
    ...projectPerson(row),
    gender: row["gender"],
    maritalStatus: row["marital_status"],
    homeAddress: address(addresses["home"]),
    mailingAddress: address(addresses["mailing"]),
    campusName: row["campus_name"],
    membershipTypeName: row["membership_type_name"],
    membershipDate: row["membership_date"],
    schoolGrade: row["school_grade"],
    baptized: row["baptized"],
    baptizedDate: row["baptized_date"],
    lastAttendedDate: row["last_attended_date"],
    limitedAccessUser: row["limited_access_user"],
    listed: row["listed"],
    created: row["created"],
    modified: row["modified"],
    customFields: present(Object.fromEntries(
      asArray(row["custom_fields"])
        .map(asRecord)
        .filter((field) => field["id"] !== undefined)
        .map((field) => [String(field["id"]), field["value"]]),
    )),
  });
}

function projectFamily(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    lastName: row["last_name"],
    address: address(row["address"]),
    members: Array.isArray(row["members"]) ? row["members"].map(projectPerson) : undefined,
  });
}

function ref(value: unknown): JsonRecord | undefined {
  const row = asRecord(value);
  return row["id"] === undefined && row["name"] === undefined
    ? undefined
    : compact({ id: row["id"], name: row["name"] });
}

function projectGroup(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    campusId: row["campus_id"],
    inactive: row["inactive"],
    groupType: asRecord(row["group_type"])["name"],
    interactionType: row["interaction_type"],
    membershipType: row["membership_type"],
    mainLeader: ref(row["main_leader"]),
    departmentId: asRecord(row["department"])["id"],
    description: row["description"],
    memberCount: row["member_count"],
    childcare: row["childcare"],
    listed: row["listed"],
    full: row["full"],
    meetDay: asRecord(row["meet_day"])["name"],
    meetTime: asRecord(row["meet_time"])["name"],
    area: asRecord(row["area"])["name"],
    address: address(row["address"]),
  });
}

function projectMembership(value: unknown): JsonRecord {
  const row = asRecord(value);
  const person = asRecord(row["individual"]);
  const group = asRecord(row["group"]);
  return compact({
    groupId: row["group_id"],
    individualId: row["individual_id"],
    status: row["status"],
    dateAdded: row["date_added"],
    name: person["name"],
    email: person["email"] || undefined,
    phones: phones(person["phone"]),
    groupName: group["name"],
    groupType: asRecord(group["group_type"])["name"],
    groupInactive: group["inactive"],
  });
}

function projectOccurrence(value: unknown): JsonRecord {
  const row = asRecord(value);
  const event = asRecord(row["event"]);
  const group = asRecord(event["group"]);
  return compact({
    eventId: row["event_id"] ?? event["id"],
    occurrence: row["occurrence"],
    start: row["start"],
    end: row["end"],
    name: event["name"],
    campusId: event["campus_id"],
    recurs: event["recurs"],
    groupId: group["id"] === undefined ? undefined : Number(group["id"]),
    groupName: group["name"],
  });
}

function projectEvent(value: unknown): JsonRecord {
  const row = asRecord(value);
  const attendance = asRecord(row["attendance"]);
  return compact({
    id: row["id"],
    name: row["name"],
    description: row["description"],
    campusId: row["campus_id"],
    start: row["start"],
    end: row["end"],
    recurs: row["recurs"],
    recurEndDate: row["recur_end_date"],
    approvalStatus: row["approval_status"],
    address: address(row["address"]),
    guestCounts: present(compact({ ...asRecord(row["guest_counts"]) })),
    group: ref(row["group"]),
    attendance: present(compact({
      status: attendance["status"],
      totalAttendance: attendance["total_attendance"],
      visitors: attendance["visitors"],
    })),
  });
}

function projectAttendance(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    eventId: row["event_id"],
    occurrence: row["occurrence"],
    status: row["status"],
    totalAttendance: row["total_attendance"],
    visitors: row["visitors"],
    topic: row["topic"],
  });
}

function projectAttendee(value: unknown): JsonRecord {
  const row = asRecord(value);
  const person = asRecord(row["individual"]);
  return compact({
    individualId: row["individual_id"] ?? person["id"],
    name: person["name"],
    familyId: person["family_id"],
    occurrenceDate: row["occurrence_date"],
  });
}

function projectForm(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    title: row["title"],
    status: row["status"],
    campusId: row["campus_id"],
    start: row["start"],
    end: row["end"],
    public: row["public"],
    url: row["url"],
  });
}

function projectResponse(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    formId: row["form_id"],
    individualId: row["individual_id"],
    created: row["created"],
    paymentStatus: row["payment_status"],
    answers: asArray(row["answers"]).map((answer) => {
      const item = asRecord(answer);
      return compact({ questionId: item["question_id"], answer: item["answer"] });
    }),
  });
}

function projectProcess(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    campusId: row["campus_id"],
    ownerId: row["owner_id"],
    hidden: row["hidden"],
    archived: row["archived"],
    managers: Array.isArray(row["process_managers"])
      ? row["process_managers"].map(ref).filter(Boolean)
      : undefined,
  });
}

function projectQueue(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    processId: row["process_id"],
    processName: row["process_name"] ?? asRecord(row["process"])["name"],
    description: row["description"] || undefined,
    assignedCount: row["assigned_count"],
    unassignedCount: row["unassigned_count"],
  });
}

function projectQueueIndividual(value: unknown): JsonRecord {
  const row = asRecord(value);
  const queue = asRecord(row["queue"]);
  const process = asRecord(row["process"]);
  return compact({
    queueIndividualId: row["queue_individual_id"],
    queueId: row["queue_id"],
    queueName: queue["name"],
    processId: process["id"] ?? queue["process_id"],
    processName: process["name"] ?? queue["process_name"],
    individualId: row["individual_id"],
    name: asRecord(row["individual"])["name"],
    status: row["status"],
    due: row["due"],
    created: row["created"],
    completed: row["completed"],
  });
}

function projectCategory(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    name: row["name"],
    campus: ref(row["campus"]),
    organizer: ref(row["organizer"]),
    archived: row["archived"],
    teams: Array.isArray(row["teams"]) ? row["teams"].map(ref).filter(Boolean) : undefined,
  });
}

function projectSchedule(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    categoryId: row["category_id"],
    name: row["name"],
    start: row["start"],
    end: row["end"],
    needed: row["needed"],
    events: Array.isArray(row["events"])
      ? row["events"].map((event) => {
          const item = asRecord(event);
          return compact({ id: item["id"], name: item["name"], start: item["start"], end: item["end"] });
        })
      : undefined,
    metrics: present(compact({ ...asRecord(row["metrics"]) })),
  });
}

function projectAssignment(value: unknown): JsonRecord {
  const row = asRecord(value);
  const volunteer = asRecord(row["volunteer"]);
  const person = asRecord(volunteer["individual"]);
  return compact({
    id: row["id"],
    categoryId: row["category_id"],
    scheduleId: row["schedule_id"],
    eventId: row["event_id"],
    eventPositionId: row["event_position_id"],
    status: row["status"],
    statusReason: row["status_reason"] || undefined,
    dateNotified: row["date_notified"],
    individualId: person["id"],
    name: person["name"],
  });
}

function projectNote(value: unknown): JsonRecord {
  const row = asRecord(value);
  return compact({
    id: row["id"],
    individualId: row["individual_id"],
    note: row["note"],
    date: row["date"],
    sharingLevel: row["sharing_level"],
    context: row["context"],
    contextId: row["context_id"],
    creator: ref(row["creator"]),
  });
}

function projectPledge(value: unknown): JsonRecord {
  const row = asRecord(value);
  const recurrence = asRecord(row["recurrence"]);
  return compact({
    id: row["id"],
    campusId: row["campus_id"],
    fund: asRecord(row["coa"])["name"],
    pledged: row["pledged"],
    paid: row["paid"],
    expected: row["expected"],
    total: row["total"],
    frequency: recurrence["frequency"],
    start: row["start"],
    end: recurrence["end"],
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const INT: JsonSchema = { type: "integer" };
const STR: JsonSchema = { type: "string" };
const BOOL: JsonSchema = { type: "boolean" };
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

function obj(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

function idProperty(description: string): JsonSchema {
  return { type: "integer", minimum: 1, description };
}

const RAW: JsonSchema = {
  type: "boolean",
  description: "Return CCB's untouched rows, including the fields the projection drops.",
};
const PAGE: JsonSchema = {
  type: "integer",
  minimum: 1,
  description: "1-based page number; pass page.nextPage from the previous result.",
};

function perPageProperty(defaultPerPage: number): JsonSchema {
  return {
    type: "integer",
    enum: [...PER_PAGE_VALUES],
    description: `Rows per page. CCB accepts only these values; defaults to ${defaultPerPage}.`,
  };
}

const PAGE_SCHEMA: JsonSchema = obj({
  hasMore: BOOL,
  nextPage: { type: ["integer", "null"] },
  total: { type: ["integer", "null"] },
});

function listOutput(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { [key]: { type: "array", items: item }, page: PAGE_SCHEMA },
    required: [key, "page"],
  };
}

function rowsOutput(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { [key]: { type: "array", items: item } },
    required: [key],
  };
}

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const PHONES = obj({ mobile: STR, home: STR, work: STR });
const PERSON_SCHEMA = obj({
  id: INT, name: STR, firstName: STR, lastName: STR, email: STR, phones: PHONES,
  birthday: STR, familyId: INT, familyPosition: STR, campusId: INT,
  membershipTypeId: INT, active: BOOL, deceased: STR,
});
const ADDRESS = obj({ street: STR, city: STR, state: STR, zip: STR, country: STR });
const INDIVIDUAL_SCHEMA = obj({
  ...(PERSON_SCHEMA as { properties: Record<string, JsonSchema> }).properties,
  gender: STR, maritalStatus: STR, homeAddress: ADDRESS, mailingAddress: ADDRESS,
  campusName: STR, membershipTypeName: STR, membershipDate: STR, baptized: BOOL,
  lastAttendedDate: STR, listed: BOOL, customFields: { type: "object" },
});
const FAMILY_SCHEMA = obj({ id: INT, lastName: STR, address: ADDRESS, members: { type: "array", items: PERSON_SCHEMA } });
const REF = obj({ id: INT, name: STR });
const GROUP_SCHEMA = obj({
  id: INT, name: STR, campusId: INT, inactive: BOOL, groupType: STR,
  interactionType: STR, membershipType: STR, mainLeader: REF, departmentId: INT,
});
const GROUP_DETAIL_SCHEMA = obj({
  ...(GROUP_SCHEMA as { properties: Record<string, JsonSchema> }).properties,
  description: STR, memberCount: INT, childcare: BOOL, listed: BOOL, full: BOOL,
  meetDay: STR, meetTime: STR, area: STR, address: ADDRESS,
});
const MEMBERSHIP_SCHEMA = obj({
  groupId: INT, individualId: INT, status: STR, dateAdded: STR, name: STR, email: STR,
  phones: PHONES, groupName: STR, groupType: STR, groupInactive: BOOL,
});
const OCCURRENCE_SCHEMA = obj({
  eventId: INT, occurrence: STR, start: STR, end: STR, name: STR, campusId: INT,
  recurs: BOOL, groupId: INT, groupName: STR,
});
const EVENT_SCHEMA = obj({
  id: INT, name: STR, description: STR, campusId: INT, start: STR, end: STR,
  recurs: BOOL, recurEndDate: STR, approvalStatus: STR, address: ADDRESS,
  guestCounts: { type: "object" }, group: REF,
  attendance: obj({ status: STR, totalAttendance: INT, visitors: INT }),
});
const ATTENDANCE_SCHEMA = obj({
  eventId: INT, occurrence: STR, status: STR, totalAttendance: INT, visitors: INT, topic: STR,
});
const ATTENDEE_SCHEMA = obj({ individualId: INT, name: STR, familyId: INT, occurrenceDate: STR });
const FORM_SCHEMA = obj({
  id: INT, title: STR, status: STR, campusId: INT, start: STR, end: STR, public: BOOL, url: STR,
});
const RESPONSE_SCHEMA = obj({
  id: INT, formId: INT, individualId: INT, created: STR, paymentStatus: STR,
  answers: { type: "array", items: obj({ questionId: INT, answer: STR }) },
});
const PROCESS_SCHEMA = obj({
  id: INT, name: STR, campusId: INT, ownerId: INT, hidden: BOOL, archived: BOOL,
  managers: { type: "array", items: REF },
});
const QUEUE_SCHEMA = obj({
  id: INT, name: STR, processId: INT, processName: STR, description: STR,
  assignedCount: INT, unassignedCount: INT,
});
const QUEUE_INDIVIDUAL_SCHEMA = obj({
  queueIndividualId: INT, queueId: INT, queueName: STR, processId: INT, processName: STR,
  individualId: INT, name: STR, status: STR, due: STR, created: STR, completed: STR,
});
const CATEGORY_SCHEMA = obj({
  id: INT, name: STR, campus: REF, organizer: REF, archived: BOOL,
  teams: { type: "array", items: REF },
});
const SCHEDULE_SCHEMA = obj({
  id: INT, categoryId: INT, name: STR, start: STR, end: STR, needed: INT,
  events: { type: "array", items: obj({ id: INT, name: STR, start: STR, end: STR }) },
  metrics: { type: "object" },
});
const ASSIGNMENT_SCHEMA = obj({
  id: INT, categoryId: INT, scheduleId: INT, eventId: INT, eventPositionId: INT,
  status: STR, statusReason: STR, dateNotified: STR, individualId: INT, name: STR,
});
const NOTE_SCHEMA = obj({
  id: INT, individualId: INT, note: STR, date: STR, sharingLevel: STR,
  context: STR, contextId: INT, creator: REF,
});
const PLEDGE_SCHEMA = obj({
  id: INT, campusId: INT, fund: STR, pledged: { type: "number" }, paid: { type: "number" },
  expected: { type: "number" }, total: { type: "number" }, frequency: STR, start: STR, end: STR,
});
const ME_SCHEMA = obj({
  id: INT, name: STR, email: STR, username: STR, familyId: INT, campusId: INT,
  userTypes: { type: "array", items: STR },
});

/** Domains with a `POST /search/{domain}/results` endpoint in the v2 spec. */
const SEARCH_DOMAINS = [
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

const HATCH_PATH: JsonSchema = {
  type: "string",
  minLength: 2,
  maxLength: 512,
  pattern: "^/[^?#]*$",
  description: "Path below the API origin beginning with '/', such as /campuses. No query string; no /oauth paths.",
};

const QUERY: JsonSchema = {
  type: "object",
  description: "Query parameters by name, one value each, such as { per_page: 50 }.",
  additionalProperties: { type: ["string", "number", "boolean"] },
};

const RESULT_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    result: { description: "CCB's untouched response body, or null when empty." },
    page: PAGE_SCHEMA,
  },
  required: ["result"],
};

/**
 * The hatch path, refused locally where it could only fail or should not be
 * sent: the token endpoint shares the API origin, and sending the grant's
 * bearer token to `/oauth/*` is never what a call meant.
 */
function hatchPath(value: unknown): string {
  const path = String(value);
  // Judged after the same normalization the transport applies, and after
  // percent-decoding, so `/groups/../oauth/token` and `/%6Fauth/token` are
  // the token endpoint they resolve to.
  let resolved = path;
  try {
    resolved = new URL(`https://ccb.invalid${path.startsWith("/") ? path : `/${path}`}`).pathname;
    resolved = decodeURIComponent(resolved);
  } catch {
    // An unparseable path is refused by the transport's own confinement.
  }
  if (/^\/+oauth(\/|$)/i.test(path) || /^\/+oauth(\/|$)/i.test(resolved)) {
    throw new ConnectorCallError(
      "invalid_args",
      "CCB /oauth paths belong to the connector's grant, not to API calls.",
    );
  }
  return path;
}

/** Scalar query values only; the schema admits nothing else. */
function hatchQuery(value: unknown): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {};
  for (const [name, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      query[name] = item;
    }
  }
  return query;
}

function pageQuery(args: JsonRecord, defaultPerPage: number): { page: number; per_page: number } {
  return {
    page: typeof args["page"] === "number" ? args["page"] : 1,
    per_page: typeof args["perPage"] === "number" ? args["perPage"] : defaultPerPage,
  };
}

function compactDate(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/-/g, "") : undefined;
}

const OCCURRENCE: JsonSchema = {
  type: "string",
  pattern: "^\\d{4}-?\\d{2}-?\\d{2}$",
  description: "Occurrence date, YYYYMMDD or YYYY-MM-DD, from list_events.",
};

function dateProperty(description: string): JsonSchema {
  return { type: "string", pattern: DATE_PATTERN, description };
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function tools(
  send: GuardedTransport,
  defaultPerPage: number,
  writable: boolean,
): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const perPage = perPageProperty(defaultPerPage);

  /** A page-numbered list: one GET, projected rows, and the page signal. */
  const list = (
    path: string,
    args: JsonRecord,
    ctx: ConnectorContext,
    key: string,
    project: (row: unknown) => JsonRecord,
    query: GuardedRequest["query"] = {},
  ) =>
    callCcb(send, { method: "GET", path, query: { ...query, ...pageQuery(args, defaultPerPage) } }, ctx).then(
      ({ body, headers }) => {
        const rows = asArray(body);
        const paging = pageQuery(args, defaultPerPage);
        return {
          [key]: args["raw"] === true ? rows : rows.map(project),
          page: pageInfo(headers, paging.page, paging.per_page, rows.length),
        };
      },
    );

  /** An unpaged GET whose body is one record. */
  const one = async (
    path: string,
    args: JsonRecord,
    ctx: ConnectorContext,
    project: (row: unknown) => JsonRecord,
    query: GuardedRequest["query"] = {},
  ) => {
    const { body } = await callCcb(send, { method: "GET", path, query }, ctx);
    return args["raw"] === true ? body : project(body);
  };

  const id = (value: unknown) => encodeURIComponent(String(value));

  const named: ApiTool[] = [
    {
      name: "get_me",
      description:
        "Get the CCB individual the access token belongs to. Under Identity Auth that is the signed-in person whose permissions every call carries.",
      annotations: readOnly,
      inputSchema: input({}),
      outputSchema: ME_SCHEMA,
      handler: async (_args, ctx) => {
        const { body } = await callCcb(send, { method: "GET", path: "/me" }, ctx);
        const row = asRecord(body);
        return compact({
          id: row["id"],
          name: row["name"],
          email: row["email"] || undefined,
          username: row["username"],
          familyId: row["family_id"],
          campusId: row["campus_id"],
          userTypes: Array.isArray(row["user_types"]) ? row["user_types"] : undefined,
        });
      },
    },
    {
      name: "list_individuals",
      description:
        "Find CCB individuals by partial name, phone, or email. Returns lean profiles with family and campus ids; not the advanced search.",
      annotations: readOnly,
      inputSchema: input({
        query: { type: "string", minLength: 1, maxLength: 200, description: "Partial name, phone number, or email. Omit to page everyone." },
        includeInactive: { type: "boolean", description: "Include inactive individuals." },
        includeDeceased: { type: "boolean", description: "Include deceased individuals." },
        campusScope: { type: "string", enum: ["all", "current", "other"], description: "Campuses to search relative to the connection's own." },
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("individuals", PERSON_SCHEMA),
      handler: (args, ctx) =>
        list("/individuals", args, ctx, "individuals", projectPerson, {
          name: args["query"],
          include_inactive: args["includeInactive"],
          include_deceased: args["includeDeceased"],
          campus_scope: args["campusScope"],
        }),
    },
    {
      name: "get_individual",
      description:
        "Get one CCB individual's profile: contact, addresses, membership, and custom fields. CCB allows one call a second; prefer list_individuals for many people.",
      annotations: readOnly,
      inputSchema: input({ individualId: idProperty("Individual id from list_individuals."), raw: RAW }, ["individualId"]),
      outputSchema: INDIVIDUAL_SCHEMA,
      handler: (args, ctx) => one(`/individuals/${id(args["individualId"])}`, args, ctx, projectIndividual),
    },
    {
      name: "list_families",
      description:
        "Find CCB families by partial last name, email, or mobile phone. Returns family ids and addresses; get_family lists the members.",
      annotations: readOnly,
      inputSchema: input({
        lastName: { type: "string", minLength: 1, maxLength: 200, description: "Partial last name." },
        email: { type: "string", minLength: 1, maxLength: 200, description: "Partial email." },
        phone: { type: "string", minLength: 1, maxLength: 50, description: "Partial mobile phone." },
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("families", FAMILY_SCHEMA),
      handler: (args, ctx) =>
        list("/families", args, ctx, "families", projectFamily, {
          last_name: args["lastName"],
          email: args["email"],
          phone: args["phone"],
        }),
    },
    {
      name: "get_family",
      description: "Get one CCB family with every member's lean profile and family position.",
      annotations: readOnly,
      inputSchema: input({
        familyId: idProperty("Family id from an individual's familyId or list_families."),
        includeInactive: { type: "boolean", description: "Include inactive members." },
        includeDeceased: { type: "boolean", description: "Include deceased members." },
        raw: RAW,
      }, ["familyId"]),
      outputSchema: FAMILY_SCHEMA,
      handler: (args, ctx) =>
        one(`/families/${id(args["familyId"])}`, args, ctx, projectFamily, {
          include_inactive: args["includeInactive"],
          include_deceased: args["includeDeceased"],
        }),
    },
    {
      name: "list_groups",
      description: "List or search CCB groups by partial name, optionally for one campus. Returns group type, leader, and membership mode.",
      annotations: readOnly,
      inputSchema: input({
        name: { type: "string", minLength: 1, maxLength: 200, description: "Partial group name." },
        campusId: idProperty("Only groups at this campus."),
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("groups", GROUP_SCHEMA),
      handler: (args, ctx) =>
        list("/groups", args, ctx, "groups", projectGroup, {
          name: args["name"],
          campus_ids: args["campusId"],
        }),
    },
    {
      name: "get_group",
      description: "Get one CCB group: description, member count, meeting day, time, area, and address.",
      annotations: readOnly,
      inputSchema: input({ groupId: idProperty("Group id from list_groups."), raw: RAW }, ["groupId"]),
      outputSchema: GROUP_DETAIL_SCHEMA,
      handler: (args, ctx) => one(`/groups/${id(args["groupId"])}`, args, ctx, projectGroup),
    },
    {
      name: "list_group_members",
      description: "List one CCB group's participants with role and date added. Filter by leader or member status, or partial name.",
      annotations: readOnly,
      inputSchema: input({
        groupId: idProperty("Group id from list_groups."),
        status: { type: "string", enum: ["all", "leader", "member"], description: "Participant role filter." },
        name: { type: "string", minLength: 1, maxLength: 200, description: "Partial participant name." },
        page: PAGE,
        perPage,
        raw: RAW,
      }, ["groupId"]),
      outputSchema: listOutput("members", MEMBERSHIP_SCHEMA),
      handler: (args, ctx) =>
        list(`/groups/${id(args["groupId"])}/members`, args, ctx, "members", projectMembership, {
          status: args["status"],
          name: args["name"],
        }),
    },
    {
      name: "list_individual_groups",
      description: "List the CCB groups one individual belongs to, with their role. Defaults to member and leader roles.",
      annotations: readOnly,
      inputSchema: input({
        individualId: idProperty("Individual id."),
        includeInactive: { type: "boolean", description: "List inactive groups instead of active ones." },
        page: PAGE,
        perPage,
        raw: RAW,
      }, ["individualId"]),
      outputSchema: listOutput("groups", MEMBERSHIP_SCHEMA),
      handler: (args, ctx) =>
        list(`/individuals/${id(args["individualId"])}/groups`, args, ctx, "groups", projectMembership, {
          inactive: args["includeInactive"],
        }),
    },
    {
      name: "list_events",
      description: "List CCB event occurrences by name and time range. Each row's eventId and occurrence feed the attendance tools.",
      annotations: readOnly,
      inputSchema: input({
        name: { type: "string", minLength: 1, maxLength: 200, description: "Partial event name." },
        range: { type: "string", enum: ["ALL", "PAST", "CURRENT", "FUTURE"], description: "Time range relative to now." },
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("occurrences", OCCURRENCE_SCHEMA),
      handler: (args, ctx) =>
        list("/events", args, ctx, "occurrences", projectOccurrence, {
          name: args["name"],
          range_type: args["range"],
        }),
    },
    {
      name: "get_event",
      description: "Get one CCB event's details, optionally for one occurrence with its attendance totals.",
      annotations: readOnly,
      inputSchema: input({
        eventId: idProperty("Event id from list_events."),
        occurrence: { ...OCCURRENCE, description: "Occurrence date, YYYYMMDD or YYYY-MM-DD. Omit for the series." },
        withAttendance: { type: "boolean", description: "Add attendance totals for the occurrence." },
        raw: RAW,
      }, ["eventId"]),
      outputSchema: EVENT_SCHEMA,
      handler: (args, ctx) =>
        one(`/events/${id(args["eventId"])}`, args, ctx, projectEvent, {
          occurrence: compactDate(args["occurrence"]),
          attendance_info: args["withAttendance"],
        }),
    },
    {
      name: "get_event_attendance",
      description: "Get one CCB event occurrence's attendance summary: met or not, totals, visitors, topic. Drops leader notes and prayer requests unless raw.",
      annotations: readOnly,
      inputSchema: input({ eventId: idProperty("Event id from list_events."), occurrence: OCCURRENCE, raw: RAW }, ["eventId", "occurrence"]),
      outputSchema: ATTENDANCE_SCHEMA,
      handler: (args, ctx) =>
        one(`/events/${id(args["eventId"])}/attendance/${compactDate(args["occurrence"])}`, args, ctx, projectAttendance),
    },
    {
      name: "list_event_attendees",
      description: "List who attended one CCB event occurrence. Returns individual ids and names.",
      annotations: readOnly,
      inputSchema: input({ eventId: idProperty("Event id from list_events."), occurrence: OCCURRENCE, page: PAGE, perPage, raw: RAW }, ["eventId", "occurrence"]),
      outputSchema: listOutput("attendees", ATTENDEE_SCHEMA),
      handler: (args, ctx) =>
        list(`/events/${id(args["eventId"])}/attendance/${compactDate(args["occurrence"])}/attendees`, args, ctx, "attendees", projectAttendee),
    },
    {
      name: "list_forms",
      description: "List or search CCB forms by partial title, status, or campus. Returns form ids for list_form_responses.",
      annotations: readOnly,
      inputSchema: input({
        title: { type: "string", minLength: 1, maxLength: 200, description: "Partial form title." },
        status: { type: "string", enum: ["ACTIVE", "SCHEDULED", "UNPUBLISHED", "EXPIRED", "ARCHIVED"], description: "Form status." },
        campusId: idProperty("Only forms at this campus."),
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("forms", FORM_SCHEMA),
      handler: (args, ctx) =>
        list("/forms", args, ctx, "forms", projectForm, {
          title: args["title"],
          status: args["status"],
          campus_id: args["campusId"],
        }),
    },
    {
      name: "list_form_responses",
      description: "List one CCB form's responses with answers by question id and payment status. Drops payment details unless raw.",
      annotations: readOnly,
      inputSchema: input({ formId: idProperty("Form id from list_forms."), page: PAGE, perPage, raw: RAW }, ["formId"]),
      outputSchema: listOutput("responses", RESPONSE_SCHEMA),
      handler: (args, ctx) => list(`/forms/${id(args["formId"])}/responses`, args, ctx, "responses", projectResponse),
    },
    {
      name: "list_processes",
      description: "List CCB processes (assimilation and follow-up pipelines) by name or status. Returns process ids for list_queues.",
      annotations: readOnly,
      inputSchema: input({
        name: { type: "string", minLength: 1, maxLength: 200, description: "Process name search." },
        status: { type: "string", enum: ["HIDDEN", "ACTIVE", "ARCHIVED"], description: "Process status." },
        managedByMe: { type: "boolean", description: "Only processes the connection's individual manages." },
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("processes", PROCESS_SCHEMA),
      handler: (args, ctx) =>
        list("/processes", args, ctx, "processes", projectProcess, {
          name: args["name"],
          statuses: args["status"],
          managed_by_me: args["managedByMe"],
        }),
    },
    {
      name: "list_queues",
      description: "List CCB process queues, optionally for one process, with assigned and unassigned counts.",
      annotations: readOnly,
      inputSchema: input({
        processId: idProperty("Only queues in this process."),
        search: { type: "string", minLength: 1, maxLength: 200, description: "Queue name search." },
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("queues", QUEUE_SCHEMA),
      handler: (args, ctx) =>
        list("/queues", args, ctx, "queues", projectQueue, {
          process_ids: args["processId"],
          search_term: args["search"],
        }),
    },
    {
      name: "list_queue_individuals",
      description: "List people in CCB process queues the connection can see, by status or assignment. CCB offers no per-queue filter here; filter on queueId.",
      annotations: readOnly,
      inputSchema: input({
        status: { type: "string", enum: ["NOT_STARTED", "WAITING", "IN_PROCESS", "DONE"], description: "Queue status." },
        assignment: { type: "string", enum: ["ASSIGNED_TO_ME", "UNASSIGNED"], description: "Omit for both." },
        page: PAGE,
        perPage,
        raw: RAW,
      }),
      outputSchema: listOutput("queueIndividuals", QUEUE_INDIVIDUAL_SCHEMA),
      handler: (args, ctx) =>
        list("/queues_individuals", args, ctx, "queueIndividuals", projectQueueIndividual, {
          statuses: args["status"],
          assignment: args["assignment"],
        }),
    },
    {
      name: "list_scheduling_categories",
      description: "List CCB scheduling categories (serving ministries) with teams and organizer. Category ids feed list_schedules.",
      annotations: readOnly,
      inputSchema: input({
        search: { type: "string", minLength: 1, maxLength: 200, description: "Category name search." },
        status: { type: "string", enum: ["ACTIVE", "ARCHIVED", "ACTIVE_AND_ARCHIVED"], description: "Defaults to CCB's own (active)." },
        raw: RAW,
      }),
      outputSchema: rowsOutput("categories", CATEGORY_SCHEMA),
      handler: async (args, ctx) => {
        const { body } = await callCcb(
          send,
          { method: "GET", path: "/scheduling/categories", query: { search_term: args["search"], status: args["status"] } },
          ctx,
        );
        const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
        return { categories: args["raw"] === true ? rows : rows.map(projectCategory) };
      },
    },
    {
      name: "list_schedules",
      description: "List one CCB scheduling category's schedules with events and assignment metrics. CCB allows one call per two seconds here.",
      annotations: readOnly,
      inputSchema: input({
        categoryId: idProperty("Category id from list_scheduling_categories."),
        after: dateProperty("Only schedules ending after this date, YYYY-MM-DD."),
        before: dateProperty("Only schedules ending before this date, YYYY-MM-DD."),
        page: PAGE,
        perPage,
        raw: RAW,
      }, ["categoryId"]),
      outputSchema: listOutput("schedules", SCHEDULE_SCHEMA),
      handler: (args, ctx) =>
        list(`/scheduling/categories/${id(args["categoryId"])}/schedules`, args, ctx, "schedules", projectSchedule, {
          after: args["after"],
          before: args["before"],
          withMetrics: true,
        }),
    },
    {
      name: "list_individual_assignments",
      description: "List one CCB individual's serving assignments with status, schedule, and event ids.",
      annotations: readOnly,
      inputSchema: input({
        individualId: idProperty("Individual id."),
        startDate: dateProperty("Earliest assignment date, YYYY-MM-DD."),
        endDate: dateProperty("Latest assignment date, YYYY-MM-DD."),
        page: PAGE,
        perPage,
        raw: RAW,
      }, ["individualId"]),
      outputSchema: listOutput("assignments", ASSIGNMENT_SCHEMA),
      // The spec declares start_date and end_date as this GET's request body
      // (getIndividualAssignments), which fetch cannot send; they ride the
      // query, as list_scheduling_categories' body fields do.
      handler: (args, ctx) =>
        list(`/individuals/${id(args["individualId"])}/assignments`, args, ctx, "assignments", projectAssignment, {
          start_date: args["startDate"],
          end_date: args["endDate"],
        }),
    },
    {
      name: "list_individual_notes",
      description: "List the notes on one CCB individual that the connection may read, with sharing level and context. Pastoral content; reduce before returning.",
      annotations: readOnly,
      inputSchema: input({
        individualId: idProperty("Individual id."),
        context: { type: "string", enum: ["GROUP", "DEPARTMENT", "PROCESS_QUEUE", "GENERAL"], description: "Only notes in this context." },
        page: PAGE,
        perPage,
        raw: RAW,
      }, ["individualId"]),
      outputSchema: listOutput("notes", NOTE_SCHEMA),
      handler: (args, ctx) =>
        list(`/individuals/${id(args["individualId"])}/notes`, args, ctx, "notes", projectNote, {
          context: args["context"],
          include_creator: true,
        }),
    },
    {
      name: "get_giving_metrics",
      description: "Get gift counts by period for one CCB individual or family, over at most 12 months. Counts only; v2 exposes no amounts or transactions.",
      annotations: readOnly,
      inputSchema: input({
        individualId: idProperty("Individual id. Exactly one of individualId or familyId."),
        familyId: idProperty("Family id. Exactly one of individualId or familyId."),
        start: dateProperty("Start date, YYYY-MM-DD. CCB caps the range at 12 months."),
        end: dateProperty("End date, YYYY-MM-DD."),
        raw: RAW,
      }),
      outputSchema: obj({
        periods: {
          type: "array",
          items: obj({ start: STR, count: INT, members: { type: "array", items: obj({ individualId: INT, count: INT }) } }),
        },
      }),
      handler: async (args, ctx) => {
        const individual = args["individualId"] !== undefined;
        if (individual === (args["familyId"] !== undefined)) {
          throw new ConnectorCallError("invalid_args", "Pass exactly one of individualId or familyId.");
        }
        if (
          typeof args["start"] === "string" &&
          typeof args["end"] === "string" &&
          Date.parse(args["end"]) - Date.parse(args["start"]) > 366 * DAY_MS
        ) {
          throw new ConnectorCallError("invalid_args", "CCB caps giving metrics at a 12-month range; narrow start and end.");
        }
        const path = individual
          ? `/individuals/${id(args["individualId"])}/metrics/giving`
          : `/families/${id(args["familyId"])}/metrics/giving`;
        const { body } = await callCcb(send, { method: "GET", path, query: { start: args["start"], end: args["end"] } }, ctx);
        const rows = asArray(body);
        if (args["raw"] === true) return { periods: rows };
        return {
          periods: rows.map((value) => {
            const row = asRecord(value);
            return compact({
              start: row["start"] ?? row["date"],
              count: row["count"],
              members: Array.isArray(row["members"])
                ? row["members"].map((member) => {
                    const item = asRecord(member);
                    return compact({ individualId: item["id"], count: item["count"] });
                  })
                : undefined,
            });
          }),
        };
      },
    },
    {
      name: "list_individual_pledges",
      description: "List one CCB individual's pledges: fund, pledged, paid, and expected amounts, and recurrence.",
      annotations: readOnly,
      inputSchema: input({ individualId: idProperty("Individual id."), page: PAGE, perPage, raw: RAW }, ["individualId"]),
      outputSchema: listOutput("pledges", PLEDGE_SCHEMA),
      handler: (args, ctx) => list(`/individuals/${id(args["individualId"])}/pledges`, args, ctx, "pledges", projectPledge),
    },
  ];

  const hatches: ApiTool[] = [
    {
      name: "ccb_api_get",
      description:
        "Call any CCB v2 GET endpoint and return its untouched body. Use named reads first; they project and page for you.",
      annotations: readOnly,
      inputSchema: input({ path: HATCH_PATH, query: QUERY }, ["path"]),
      outputSchema: RESULT_OUTPUT,
      handler: async (args, ctx) => {
        const scalars = hatchQuery(args["query"]);
        const { body, headers } = await callCcb(send, { method: "GET", path: hatchPath(args["path"]), query: scalars }, ctx);
        const page = typeof scalars["page"] === "number" ? scalars["page"] : 1;
        const per = typeof scalars["per_page"] === "number" ? scalars["per_page"] : DEFAULT_PER_PAGE;
        return defined({
          result: body ?? null,
          page: Array.isArray(body) && (headers.has("x-page") || headers.has("x-next-page"))
            ? pageInfo(headers, page, per, body.length)
            : undefined,
        });
      },
    },
    {
      name: "ccb_api_search",
      description:
        "Run a CCB advanced search (POST /search/{domain}/results) and return untouched rows. Read-only; individuals allows one call per five seconds.",
      annotations: readOnly,
      inputSchema: input({
        // A pattern, not an enum: fifteen domain names render past the
        // 256-byte annotation budget and would truncate the whole tool in
        // search (H7). The handler refuses anything outside the list.
        domain: {
          type: "string",
          pattern: "^[a-z_]{1,40}$",
          description: `Search domain: ${SEARCH_DOMAINS.join(", ")}.`,
        },
        body: {
          type: "object",
          description: "Search body as CCB documents it for the domain, e.g. { configuration, filters }.",
        },
        page: PAGE,
        perPage,
      }, ["domain", "body"]),
      outputSchema: RESULT_OUTPUT,
      handler: async (args, ctx) => {
        if (!(SEARCH_DOMAINS as readonly string[]).includes(args["domain"])) {
          throw new ConnectorCallError(
            "invalid_args",
            `CCB has no advanced search domain "${String(args["domain"]).slice(0, 40)}"; use one of ${SEARCH_DOMAINS.join(", ")}.`,
          );
        }
        const paging = pageQuery(args, defaultPerPage);
        const { body, headers } = await callCcb(
          send,
          { method: "POST", path: `/search/${args["domain"]}/results`, query: paging, body: args["body"] },
          ctx,
        );
        return {
          result: body ?? null,
          page: pageInfo(headers, paging.page, paging.per_page, asArray(body).length),
        };
      },
    },
  ];

  if (writable) {
    hatches.push({
      name: "ccb_api_mutate",
      description:
        "Call any CCB v2 JSON POST, PUT, PATCH, or DELETE endpoint. The approval-gated hatch for every write; no file uploads.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input({
        method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"], description: "HTTP method the endpoint documents." },
        path: HATCH_PATH,
        query: QUERY,
        body: {
          type: ["object", "array", "string", "number", "boolean", "null"],
          description: "JSON body exactly as CCB documents it. Omit when the endpoint takes none.",
        },
      }, ["method", "path"]),
      outputSchema: RESULT_OUTPUT,
      handler: async (args, ctx) => {
        const { body } = await callCcb(
          send,
          {
            method: args["method"],
            path: hatchPath(args["path"]),
            query: hatchQuery(args["query"]),
            ...(args["body"] !== undefined ? { body: args["body"] } : {}),
          },
          ctx,
        );
        return { result: body ?? null };
      },
    });
  }

  return [...named, ...hatches];
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

function routingLine(environment: CcbEnvironment, mode: CcbMode, writable: boolean): string {
  return [
    environment === "sandbox" ? "Sandbox church data" : "Production church data",
    mode === "identity"
      ? "acting as each signed-in person with their own CCB permissions (Identity Auth)"
      : "church-wide under one administrator-approved grant (System Auth)",
    writable ? "reads plus approval-gated writes" : "read-only",
  ].join(", ");
}

function usageGuide(
  purpose: string,
  environment: CcbEnvironment,
  mode: CcbMode,
  scopes: readonly string[],
  writable: boolean,
  instructions: string | undefined,
): string {
  const extra = instructions?.trim();
  return `# Church Community Builder (Pushpay ChMS)

${routingLine(environment, mode, writable)}: ${purpose}${skill.fragments.guide_0}${mode === "identity" ? "- Results are what the signed-in person may see in CCB. A 403 means that person lacks the permission, not that the connection is broken.\n" : ""}${skill.fragments.guide_1}${writable ? " `ccb_api_mutate` reaches every POST, PUT, PATCH, and DELETE and always needs approval." : " This connection is read-only, so it ships no write tool."} Paths are below the API origin, such as \`/church/membership_types\`.
Granted scopes: ${scopes.join(" ")}. A call outside them fails with 403.
${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

function resolveScopes(options: CcbOptions): readonly string[] {
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

function defaultTitle(environment: CcbEnvironment, mode: CcbMode, writable: boolean): string {
  const qualifiers = [
    ...(environment === "sandbox" ? ["sandbox"] : []),
    ...(mode === "identity" ? ["per-person"] : []),
    ...(writable ? [] : ["read-only"]),
  ];
  return `Pushpay ChMS (CCB)${qualifiers.length ? ` — ${qualifiers.join(", ")}` : ""}`;
}


/** The closed options ccb() accepts; see `assertKnownOptions`. */
const CCB_OPTIONS = optionsOf<CcbOptions>()({
  ...keys(
    "purpose", "title", "instructions", "environment", "mode", "clientId", "clientSecret",
    "access", "scopes", "subdomain", "defaultPerPage", "maxResultBytes",
  ),
  callAdmission: CALL_ADMISSION,
});

/** A maintained Church Community Builder (Pushpay ChMS) v2 connection. */
export const ccb = asProviderFactory<CcbOptions>({
  name: "ccb",
  title: "Church Community Builder",
  kind: "api",
  readme: "Church Community Builder",
  bundle: {"baselineGzip":120479,"maxGzip":180479,"note":"./providers/ccb starts at 120,479 B gzip: the hand-written surface plus api()'s static OAuth grant over the SDK's auth client, with no remoteMcp() transport. The cap uses the baseline + 60,000 B policy."},
  skill,
  options: CCB_OPTIONS,
  create: ccbConnector,
});

function ccbConnector(id: string, options: CcbOptions): Connector {
  const purpose = typeof options.purpose === "string" ? options.purpose.trim() : "";
  if (!purpose) throw new Error("ccb() requires a non-empty church purpose.");
  if (options.environment !== "production" && options.environment !== "sandbox") {
    throw new Error(
      'ccb() requires environment: "production" or "sandbox" — the one the OAuth client was issued for. Credentials do not cross environments.',
    );
  }
  if (options.mode !== "system" && options.mode !== "identity") {
    throw new Error(
      'ccb() requires mode: "system" (one church-wide grant an administrator approves) or "identity" (each person signs in as themselves).',
    );
  }
  const subdomain = options.subdomain?.trim();
  if (subdomain !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(subdomain)) {
    throw new Error("ccb() subdomain must be the bare CCB subdomain, such as mychurch.");
  }
  const defaultPerPage = options.defaultPerPage ?? DEFAULT_PER_PAGE;
  if (!(PER_PAGE_VALUES as readonly number[]).includes(defaultPerPage)) {
    throw new Error("ccb() defaultPerPage must be 25, 50, 75, or 100 — the only page sizes CCB accepts.");
  }
  const scopes = resolveScopes(options);
  const writable = scopes.some((scope) => !scope.startsWith("read:"));
  const { environment, mode } = options;
  const endpoints = CCB_ENVIRONMENTS[environment];

  return api(id, {
    title: options.title ?? defaultTitle(environment, mode, writable),
    description: `Church Community Builder (Pushpay ChMS) — ${routingLine(environment, mode, writable)}: ${purpose}`,
    // System Auth is one administrator's approval for the whole church, so
    // the grant is the deployment's; a personal one would send every user to
    // find a Master Administrator. Identity Auth acts as the person who
    // signed in, so sharing it would let everyone act as whoever connected
    // first. The mode decides, and there is no separate override to contradict it.
    authScope: mode === "identity" ? "personal" : "shared",
    oauth: {
      authorizationEndpoint: endpoints.authorizationEndpoint,
      tokenEndpoint: `${endpoints.apiOrigin}/oauth/token`,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scope: scopes.join(" "),
      authorizationParams: {
        ...(mode === "identity" ? { resource_owner_auth: "true" } : {}),
        ...(subdomain ? { subdomain } : {}),
      },
      tokenRequestHeaders: { Accept: CCB_MEDIA_TYPE },
      apiOrigins: [endpoints.apiOrigin],
    },
    usageGuide: {
      content: usageGuide(purpose, environment, mode, scopes, writable, options.instructions),
      summary: `${environment === "sandbox" ? "Sandbox" : "Production"} CCB, ${mode === "identity" ? "per person" : "church-wide"}: id resolution, sensitive data, paging, rate limits, hatches.`,
      required: true,
    },
    callAdmission: options.callAdmission ?? CCB_ADMISSION,
    ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
    tools: tools(ccbTransport(endpoints.apiOrigin), defaultPerPage, writable),
  });
}
