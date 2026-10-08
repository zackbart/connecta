/**
 * Breeze ChMS — rebranded "Tithely Church Management" on 2025-11-11 — as a
 * hand-written `api()` surface. No SDK exists worth wrapping: Breeze's API is
 * authenticated `GET` with query parameters against one church's own host, so
 * Web APIs alone keep this provider Workers-clean and every import relative.
 *
 * What makes this provider unlike the others is that **every Breeze call is a
 * GET, writes included** — `people/add`, `people/update?fields_json=…`,
 * `tags/assign`, and `giving/delete` all travel as query strings. The HTTP
 * method therefore says nothing about safety, and the escape-hatch split
 * cannot be made by method the way Cloudflare's and Vercel's is. It is made by
 * *endpoint*:
 *
 * - `breeze_api_get` is read-only and admits only a reviewed allowlist of read
 *   endpoints, each with its own allowlist of query parameter names. Anything
 *   unlisted is refused locally before a request exists. A denylist of write
 *   verbs (add/update/delete/remove/…) was rejected: it fails open on the next
 *   verb Breeze invents (`destroy`, `assign`, `unassign`, and `edit` are
 *   already four that a naive list misses), and `/people/{id}` would sit one
 *   typo away from `/people/delete`. The parameter allowlist closes the
 *   remaining hole — a PHP front controller that routes on a query parameter,
 *   or a read endpoint with an undocumented side-effecting flag — at the cost
 *   of refusing undocumented read parameters, which the mutate hatch still
 *   reaches with approval.
 * - `breeze_api_mutate` reaches every endpoint, read or write, documented or
 *   not, and is always destructive. That is where "full coverage" lives.
 *
 * Giving (`giving/*`, `funds/*`, `pledges/*`) left Breeze's public reference
 * around September 2023 but is still served: without a key those routes answer
 * 403 "API Key required" while an unknown controller answers 404 (checked
 * 2026-10-05 — note the 404 only proves the *controller* is unknown; an
 * unknown action under a live controller also answers 403, so no action can
 * be proven live without a key). They are shipped as named reads anyway,
 * because they are the practical read path for church giving: Tithe.ly 2.0
 * syncs processed gifts into Breeze contributions nightly, per deposit, so
 * Breeze is where an agent finds giving next to the people it belongs to.
 * The parameters come from Breeze's own reference as archived on 2023-06-07
 * (web.archive.org/web/20230607234759/https://app.breezechms.com/api) and are
 * corroborated by the pyBreezeChMS wrapper's `list_contributions` and
 * `list_funds`. The guide tells agents they are undocumented and may change.
 * Giving *writes* (`giving/add`, `giving/edit`, `giving/delete`) alter a
 * church's financial records and stay on the destructive mutate hatch.
 *
 * Drift is review-only. Breeze publishes no machine-readable specification —
 * the reference at https://app.breezechms.com/api is hand-written HTML whose
 * argument tables sometimes contradict their own examples (giving dates are
 * "DD-MM-YYYY" in the table and `2022-1-15` in the example request) — so there
 * is nothing for `scripts/drift-check.mjs` to digest honestly. A release
 * reviewer re-reads that page against `READ_ENDPOINTS` below and the named
 * tools' paths; the documented endpoint set reviewed for this release is the
 * 42 endpoint rows of the page's table of contents as of 2026-10-05 (41
 * distinct paths: the Tags section's "List People" points back at /people)
 * plus the 2023 giving, funds, and pledges sections.
 */
import { apiConnector as api, defined, type ApiTool } from "../connectors/api-connector.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  JsonSchema,
} from "../types.js";
import { keys, optionsOf } from "../config-schema.js";
import { PROVIDER_COMMON } from "../connectors/option-shapes.js";
import { asProvider } from "../provider.js";

/** Every church's API lives at `https://<subdomain>.breezechms.com/api`. */
export const BREEZE_HOST_SUFFIX = ".breezechms.com";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 3_000;
/**
 * A people list with details can be large; the read hatch can ask Breeze for
 * every person at once. A ceiling on absurdity, not a quota.
 */
const BREEZE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** One DNS label: what `<subdomain>.breezechms.com` can actually be. */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface BreezeOptions {
  /**
   * The church's Breeze subdomain — `gracechurch` for
   * `gracechurch.breezechms.com`. Required, validated as one hostname label at
   * construction, and the only host input: no argument can steer a request
   * (or the API key) anywhere else.
   */
  subdomain: string;
  /** Which church this connection serves, and for whom. */
  purpose: string;
  /** Human-readable display name; defaults to "Breeze ChMS (<subdomain>)". */
  title?: string;
  /** Church-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Optional per-runtime downstream call-admission policy. None is declared by
   * default: Breeze documents no rate limit, and the only number in
   * circulation (~20 requests per minute) is a third party's. An operator who
   * wants to stay under it can supply, for example,
   * `{ rules: [{ maxConcurrency: 2, budget: { kind: "rolling-window", maxCalls: 20, windowMs: 60_000 } }] }`.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Default `list_people` page size. Defaults to 100; connecta's cap is 1,000. */
  defaultPageSize?: number;
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
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/** Breeze writes "no time" as MySQL's zero date; a projection says null. */
function timestamp(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "" || value.startsWith("0000-00-00")) {
    return null;
  }
  return value;
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return value === true || value === 1 || value === "1";
}

function idString(value: unknown): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : String(value);
}

// --- Transport and failures ---------------------------------------------------

/**
 * The one place the credential becomes headers. Breeze takes a per-account key
 * in `Api-Key`; a future OAuth-issued bearer would replace this function and
 * nothing else, because every request already reaches it through
 * `guardedFetch`'s `authenticate` hook.
 */
async function apiKeyHeaders(ctx: ConnectorContext): Promise<Record<string, string>> {
  const key = (await ctx.credential?.get())?.trim();
  if (!key) {
    throw new ConnectorCallError(
      "auth_required",
      "No Breeze API key is configured for this connector. Call authorize_connector for recovery options. When available, an operator can add the key in this connection in the operator UI.",
    );
  }
  return { "Api-Key": key };
}

function breezeTransport(subdomain: string): GuardedTransport {
  return guardedFetch({
    provider: "Breeze",
    baseUrl: `https://${subdomain}${BREEZE_HOST_SUFFIX}/api`,
    headers: { Accept: "application/json" },
    maxResponseBytes: BREEZE_MAX_RESPONSE_BYTES,
    authenticate: apiKeyHeaders,
  });
}

/**
 * Breeze's failure bodies are short plain text ("Invalid API Key") or an HTML
 * page. Quote the former, never the latter.
 */
function bodyDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.length > 200) return "";
  return ` Breeze said: ${trimmed}`;
}

/** Map a non-2xx Breeze response by the caller's next move. */
function breezeFailure(
  status: number,
  headers: Headers,
  text: string,
): ConnectorCallError {
  const detail = bodyDetail(text);
  if (status === 429) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `Breeze is throttling requests (HTTP 429).${detail} Breeze publishes no limit; slow the fan-out before retrying.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  // Breeze keys are account-wide with no scopes, so a 401/403 is the key
  // itself — missing, revoked, or from another church — never a permission gap
  // a different argument could avoid.
  if (status === 401 || status === 403) {
    return new ConnectorCallError(
      "auth_required",
      `Breeze rejected the configured API key (HTTP ${status}).${detail} An operator must replace it with the key from this church's Extensions → API page.`,
    );
  }
  // With an account-wide key there is no permission gap to hide behind a 404:
  // it is an absent endpoint (a mistyped hatch path) or record.
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `Breeze has no such endpoint or record (HTTP 404). Check the path against the API reference, or re-read the id from its list tool.`,
    );
  }
  if (status === 400 || status === 422) {
    return new ConnectorCallError(
      "invalid_args",
      `Breeze rejected the request (HTTP ${status}).${detail}`,
    );
  }
  if (status >= 500) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `Breeze is failing upstream (HTTP ${status}).`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `Breeze request failed (HTTP ${status}).${detail}`,
    { retryable: false },
  );
}

function shortText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Breeze can report a failure inside a 200: `{ success: false, errors: … }`
 * or an `errorCode`. The giving endpoints' success shape is
 * `{ success: true, errors: null }`, so a null or empty `errors` is not one.
 */
function reportedFailure(payload: unknown): ConnectorCallError | undefined {
  const root = asRecord(payload);
  const errors = root["errors"];
  const hasErrors =
    errors !== undefined &&
    errors !== null &&
    errors !== false &&
    errors !== "" &&
    !(Array.isArray(errors) && errors.length === 0) &&
    !(typeof errors === "object" && !Array.isArray(errors) && Object.keys(errors).length === 0);
  if (root["success"] !== false && root["errorCode"] === undefined && !hasErrors) {
    return undefined;
  }
  const message =
    shortText(root["errorMessage"]) ??
    shortText(root["message"]) ??
    shortText(errors) ??
    shortText(root["errorCode"]) ??
    "no detail";
  // Breeze uses the same envelope for a rejected argument and a missing
  // record, so the code stays the honest generic one and the message says so.
  return new ConnectorCallError(
    "connector_call_failed",
    `Breeze reported a failure: ${message}. Breeze does not say whether an argument or a record is at fault; re-check ids with the list tools before retrying.`,
    { retryable: false },
  );
}

async function callBreeze(
  send: GuardedTransport,
  request: GuardedRequest,
  ctx: ConnectorContext,
  options: { raw?: boolean } = {},
): Promise<unknown> {
  return await send(request, ctx, async (response) => {
    const text = await response.text();
    if (!response.ok) {
      throw breezeFailure(response.status, response.headers, text);
    }
    if (!text.trim()) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // Breeze labels JSON text/html, so the content type proves nothing;
      // only the parse does. A hatch hands back what arrived.
      if (options.raw) return text;
      throw new ConnectorCallError(
        "connector_call_failed",
        "Breeze returned a non-JSON successful response.",
        { retryable: false },
      );
    }
    const failure = reportedFailure(payload);
    if (failure) throw failure;
    return payload;
  });
}

/** A named write whose response is a bare boolean reports `false` on failure. */
function requireTrue(payload: unknown, action: string): void {
  if (payload === false) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `Breeze answered false to ${action}. Breeze gives no reason; confirm the ids with their list tools before retrying.`,
      { retryable: false },
    );
  }
}

// --- The read hatch's allowlist ----------------------------------------------

/**
 * Every read endpoint `breeze_api_get` may reach, with the query parameter
 * names each one documents. Paths are relative to `/api`, lowercase, exact;
 * `/people/{id}` is the one templated row and accepts digits only, so it can
 * never spell `/people/add` or `/people/delete`. Rows are added here only
 * after a reviewer has read the endpoint as observational.
 */
const READ_ENDPOINTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["/people", ["details", "filter_json", "limit", "offset"]],
  ["/people/{id}", ["details"]],
  ["/profile", []],
  ["/tags/list_tags", ["folder_id"]],
  ["/tags/list_folders", []],
  ["/events", ["start", "end", "category_id", "calendar_id", "eligible", "details", "limit"]],
  ["/events/list_event", ["instance_id", "schedule", "schedule_direction", "schedule_limit", "eligible", "details"]],
  ["/events/calendars/list", []],
  ["/events/locations", []],
  ["/events/attendance/list", ["instance_id", "details", "type"]],
  ["/events/attendance/eligible", ["instance_id"]],
  ["/forms/list_forms", ["is_archived"]],
  ["/forms/list_form_fields", ["form_id"]],
  ["/forms/list_form_entries", ["form_id", "details"]],
  ["/volunteers/list", ["instance_id"]],
  ["/volunteers/list_roles", ["instance_id", "show_quantity"]],
  ["/account/summary", []],
  ["/account/list_log", ["action", "start", "end", "user_id", "details", "limit"]],
  // Undocumented since ~2023-09; parameters from the 2023-06-07 reference.
  ["/giving/list", ["start", "end", "person_id", "include_family", "amount_min", "amount_max", "method_ids", "fund_ids", "envelope_number", "batches", "forms", "pledge_ids"]],
  ["/giving/view", ["payment_id"]],
  ["/funds/list", ["include_totals"]],
  ["/pledges/list_campaigns", []],
  ["/pledges/list_pledges", ["campaign_id"]],
]);

/** A Breeze path: lowercase segments of letters, digits, and underscores. */
const PATH_PATTERN = /^(\/[a-z0-9_]+)+\/?$/;

function normalizedPath(raw: unknown): string {
  const path = typeof raw === "string" ? raw : "";
  if (!PATH_PATTERN.test(path)) {
    throw new ConnectorCallError(
      "invalid_args",
      "A Breeze path is relative to /api, begins with '/', and uses only lowercase letters, digits, underscores, and '/' — for example /tags/list_folders. No query string, host, or dot segments.",
    );
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function readEndpointFor(path: string): readonly string[] {
  const template = /^\/people\/\d+$/.test(path) ? "/people/{id}" : path;
  const parameters = READ_ENDPOINTS.get(template);
  if (!parameters) {
    throw new ConnectorCallError(
      "invalid_args",
      `breeze_api_get reaches only reviewed read endpoints, and ${path} is not one. Breeze sends writes as GET too, so the read hatch is an allowlist: ${[...READ_ENDPOINTS.keys()].join(", ")}. Use breeze_api_mutate for anything else.`,
    );
  }
  return parameters;
}

type QueryValue = string | number | boolean;

function queryPairs(value: unknown): Record<string, QueryValue> {
  // Null-prototype, so a parameter named __proto__ or constructor is a key
  // like any other rather than a reach into Object.prototype.
  const query: Record<string, QueryValue> = Object.create(null);
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    const name = pair["name"];
    if (typeof name !== "string") continue;
    if (name in query) {
      throw new ConnectorCallError(
        "invalid_args",
        `Query parameter ${name} appears more than once; Breeze reads one value per name.`,
      );
    }
    const item = pair["value"];
    query[name] =
      item !== null && typeof item === "object" ? JSON.stringify(item) : item;
  }
  return query;
}

// --- Projections -------------------------------------------------------------

function projectPersonSummary(value: unknown): JsonRecord {
  const person = asRecord(value);
  return compact({
    id: idString(person["id"]),
    firstName: person["first_name"],
    forceFirstName: person["force_first_name"],
    lastName: person["last_name"],
  });
}

function projectFamilyMember(value: unknown): JsonRecord {
  const member = asRecord(value);
  const details = asRecord(member["details"]);
  return compact({
    personId: idString(member["person_id"] ?? details["id"]),
    familyId: idString(member["family_id"]),
    role: member["role_name"],
    firstName: details["first_name"],
    lastName: details["last_name"],
  });
}

/** Drops photo paths; keeps the profile-field `details` map Breeze returned. */
function projectPerson(value: unknown): JsonRecord {
  const person = asRecord(value);
  const family = asArray(person["family"]);
  const details = person["details"];
  return compact({
    ...projectPersonSummary(person),
    nickName: person["nick_name"] || undefined,
    middleName: person["middle_name"] || undefined,
    maidenName: person["maiden_name"] || undefined,
    details:
      details && typeof details === "object" && !Array.isArray(details)
        ? details
        : undefined,
    family: family.length ? family.map(projectFamilyMember) : undefined,
  });
}

function projectProfileFields(value: unknown): JsonRecord[] {
  const fields: JsonRecord[] = [];
  for (const sectionValue of asArray(value)) {
    const section = asRecord(sectionValue);
    for (const fieldValue of asArray(section["fields"])) {
      const field = asRecord(fieldValue);
      const options = asArray(field["options"]).map((optionValue) => {
        const option = asRecord(optionValue);
        return compact({
          optionId: idString(option["option_id"] ?? option["id"]),
          name: option["name"],
        });
      });
      fields.push(
        compact({
          fieldId: idString(field["field_id"]),
          name: field["name"],
          type: field["field_type"],
          section: section["name"],
          options: options.length ? options : undefined,
        }),
      );
    }
  }
  return fields;
}

function projectEvent(value: unknown): JsonRecord {
  const event = asRecord(value);
  return compact({
    id: idString(event["id"]),
    eventId: idString(event["event_id"]),
    name: event["name"],
    calendarId: idString(event["category_id"]),
    startsAt: timestamp(event["start_datetime"]),
    endsAt: timestamp(event["end_datetime"]),
  });
}

function projectContribution(value: unknown): JsonRecord {
  const payment = asRecord(value);
  const paidOn = payment["paid_on"];
  return compact({
    id: idString(payment["id"]),
    paidOn: typeof paidOn === "string" ? paidOn.slice(0, 10) : undefined,
    amount: idString(payment["amount"]),
    method: payment["method"],
    methodId: idString(payment["method_id"]),
    personId: idString(payment["person_id"]),
    firstName: payment["first_name"],
    lastName: payment["last_name"],
    envelopeNumber: idString(payment["envelope_number"]),
    batchNumber: idString(payment["num"] ?? payment["batch_num"]),
    note: payment["note"] || undefined,
    funds: asArray(payment["funds"]).map((fundValue) => {
      const fund = asRecord(fundValue);
      return compact({
        fundId: idString(fund["fund_id"]),
        name: fund["fund_name"],
        amount: idString(fund["amount"]),
        taxDeductible: flag(fund["tax_deductible"]),
      });
    }),
  });
}

/**
 * Sum decimal strings in integer cents, so a giving total never inherits
 * floating-point error. Null when any amount is not a plain decimal.
 */
function totalAmount(amounts: unknown[]): string | null {
  let cents = 0;
  for (const amount of amounts) {
    const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount ?? "").trim());
    if (!match) return null;
    const value = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
    cents += match[1] ? -value : value;
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function parsedObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// --- Schemas -----------------------------------------------------------------

function namedInput(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "Return Breeze's untouched rows instead of the lean projection.",
};

const ID_PATTERN = "^[0-9]+$";

function idProperty(description: string): JsonSchema {
  return { type: "string", pattern: ID_PATTERN, maxLength: 20, description };
}

const PERSON_ID = idProperty("Breeze person id from list_people.");
const INSTANCE_ID = idProperty("Event instance id (list_events id, not eventId).");
const FORM_ID = idProperty("Form id from list_forms.");

const DATE_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

function dateProperty(description: string): JsonSchema {
  return { type: "string", pattern: DATE_PATTERN, description };
}

const ID_LIST: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: { type: "string", pattern: ID_PATTERN, description: "Numeric id." },
};

const QUERY_PROPERTY: JsonSchema = {
  type: "array",
  maxItems: 30,
  description: "Query parameters as name/value pairs.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64, description: "Parameter name, e.g. fields_json." },
      value: {
        type: ["string", "number", "boolean", "object", "array"],
        description: "Value; objects and arrays are JSON-encoded for *_json parameters.",
      },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

const PATH_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 2,
  maxLength: 100,
  description: "Path below /api, e.g. /tags/list_folders. No query string.",
};

const RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { result: { description: "Breeze's untouched response." } },
  required: ["result"],
};

const PERSON_SUMMARY: Record<string, JsonSchema> = {
  id: { type: "string" },
  firstName: { type: "string" },
  forceFirstName: { type: "string", description: "Breeze's display first name." },
  lastName: { type: "string" },
};

const PERSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ...PERSON_SUMMARY,
    nickName: { type: "string" },
    middleName: { type: "string" },
    maidenName: { type: "string" },
    details: { type: "object", description: "Values keyed by profile fieldId." },
    family: { type: "array", items: { type: "object" } },
  },
  required: ["id"],
};

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean", description: "True when the page came back full." },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

const TRUNCATED_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "True when the result filled limit; narrow the range.",
};

const WROTE_SCHEMA = (key: string): JsonSchema => ({
  type: "object",
  properties: { [key]: { type: "boolean" } },
  required: [key],
});

const PROFILE_FIELD_TYPES = [
  "text",
  "textarea",
  "radio",
  "checkbox",
  "date",
  "birthdate",
  "email",
  "phone",
  "address",
  "family_role",
] as const;

/** Field types whose value rides in `details`, with `response: true`. */
const DETAIL_FIELD_TYPES = new Set(["email", "phone", "address", "family_role"]);

const FIELDS_PROPERTY: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  description: "Profile values to set. fieldId and option ids come from list_profile_fields.",
  items: {
    type: "object",
    properties: {
      fieldId: { type: "string", pattern: ID_PATTERN, description: "Profile fieldId." },
      type: {
        type: "string",
        enum: [...PROFILE_FIELD_TYPES],
        description: "radio covers multiple choice and dropdown.",
      },
      response: {
        type: ["string", "boolean"],
        description: "Text, M/D/YYYY date, or option id; true for detail types.",
      },
      details: {
        type: "object",
        description: "email {address}; phone {phone_mobile|phone_home|phone_work}; address {street_address,city,state,zip}; family_role {person_id,role_id 1-5}.",
      },
    },
    required: ["fieldId", "type"],
    additionalProperties: false,
  },
};

function fieldsJson(value: unknown): string {
  const fields = asArray(value).map((row) => {
    const field = asRecord(row);
    const type = String(field["type"]);
    const needsDetails = DETAIL_FIELD_TYPES.has(type);
    if (needsDetails && !field["details"]) {
      throw new ConnectorCallError(
        "invalid_args",
        `A ${type} field carries its value in details; field ${String(field["fieldId"])} has none.`,
      );
    }
    if (!needsDetails && field["response"] === undefined) {
      throw new ConnectorCallError(
        "invalid_args",
        `A ${type} field needs a response; field ${String(field["fieldId"])} has none.`,
      );
    }
    return compact({
      field_id: field["fieldId"],
      field_type: type,
      response: field["response"] ?? (needsDetails ? true : undefined),
      details: field["details"],
    });
  });
  return JSON.stringify(fields);
}

// --- Tools -------------------------------------------------------------------

function tools(send: GuardedTransport, defaultPageSize: number): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const additive = { readOnlyHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const get = (
    path: string,
    query: NonNullable<GuardedRequest["query"]>,
    ctx: ConnectorContext,
    options?: { raw?: boolean },
  ) => callBreeze(send, { method: "GET", path, query }, ctx, options);

  return [
    {
      name: "breeze_api_get",
      description:
        "Call a reviewed Breeze read endpoint and return its untouched response. Refuses every path and parameter not on the read allowlist, since Breeze writes are GETs too.",
      annotations: readOnly,
      inputSchema: namedInput({ path: PATH_PROPERTY, query: QUERY_PROPERTY }, ["path"]),
      outputSchema: RESULT_SCHEMA,
      handler: async (args, ctx) => {
        const path = normalizedPath(args["path"]);
        const allowed = readEndpointFor(path);
        const query = queryPairs(args["query"]);
        const stray = Object.keys(query).filter((name) => !allowed.includes(name));
        if (stray.length) {
          throw new ConnectorCallError(
            "invalid_args",
            `breeze_api_get refuses ${stray.join(", ")} on ${path}; its reviewed parameters are ${allowed.join(", ") || "none"}. Use breeze_api_mutate for anything else.`,
          );
        }
        return { result: await get(path, query, ctx, { raw: true }) };
      },
    },
    {
      name: "breeze_api_mutate",
      description:
        "Call any Breeze API endpoint, including writes and undocumented routes, and return its untouched response. The approval-gated hatch; Breeze takes writes as GET query parameters.",
      annotations: destructive,
      inputSchema: namedInput({ path: PATH_PROPERTY, query: QUERY_PROPERTY }, ["path"]),
      outputSchema: RESULT_SCHEMA,
      handler: async (args, ctx) => ({
        result: await get(normalizedPath(args["path"]), queryPairs(args["query"]), ctx, { raw: true }),
      }),
    },
    {
      name: "get_account_summary",
      description:
        "Get the Breeze account's church name, subdomain, timezone, country, and currency. Use it to read giving amounts in the right currency.",
      annotations: readOnly,
      inputSchema: namedInput({}),
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" }, subdomain: { type: "string" },
          timezone: { type: "string" }, country: { type: "string" }, currency: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (_args, ctx) => {
        const account = asRecord(await get("/account/summary", {}, ctx));
        const details = asRecord(account["details"]);
        const country = asRecord(details["country"]);
        return compact({
          id: idString(account["id"]),
          name: account["name"],
          subdomain: account["subdomain"],
          timezone: details["timezone"],
          country: country["name"],
          currency: country["currency"],
        });
      },
    },
    {
      name: "list_people",
      description:
        "List people in Breeze, optionally filtered by tag or profile-field values, with id and names or full profile details. No name search; filter names in code.",
      annotations: readOnly,
      inputSchema: namedInput({
        tagId: idProperty("Only people carrying this tag id from list_tags."),
        filter: {
          type: "object",
          description: "Breeze filter_json: profile fieldId to option ids joined by '-', e.g. {\"2000138015\":\"226-227\"}.",
        },
        includeDetails: { type: "boolean", description: "Include every profile field (slower, larger). Defaults to false." },
        limit: {
          type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE,
          description: `People per page, 1 to connecta's ${MAX_PAGE_SIZE}. Defaults to ${defaultPageSize}.`,
        },
        cursor: { type: "string", pattern: ID_PATTERN, description: "Opaque nextCursor from the previous page." },
        raw: RAW_PROPERTY,
      }),
      outputSchema: {
        type: "object",
        properties: { people: { type: "array", items: PERSON_SCHEMA }, page: PAGE_SCHEMA },
        required: ["people", "page"],
      },
      handler: async (args, ctx) => {
        const filter = { ...asRecord(args["filter"]) };
        if (args["tagId"] !== undefined) {
          if (filter["tag_contains"] !== undefined) {
            throw new ConnectorCallError("invalid_args", "Pass tagId or filter.tag_contains, not both.");
          }
          filter["tag_contains"] = `y_${args["tagId"]}`;
        }
        const limit: number = args["limit"] ?? defaultPageSize;
        const offset = args["cursor"] === undefined ? 0 : Number(args["cursor"]);
        const rows = asArray(await get("/people", {
          details: args["includeDetails"] === true ? 1 : 0,
          filter_json: Object.keys(filter).length ? JSON.stringify(filter) : undefined,
          limit,
          offset,
        }, ctx));
        // Breeze returns no total, so a full page is the only "maybe more"
        // signal it gives; the page after an exact multiple comes back empty.
        const hasMore = rows.length >= limit;
        return {
          people: args["raw"] === true ? rows : rows.map(projectPerson),
          page: { hasMore, nextCursor: hasMore ? String(offset + rows.length) : null },
        };
      },
    },
    {
      name: "get_person",
      description:
        "Get one person by Breeze id with profile details keyed by fieldId and family members. Decode fieldIds with list_profile_fields.",
      annotations: readOnly,
      inputSchema: namedInput({
        personId: PERSON_ID,
        includeDetails: { type: "boolean", description: "Include profile details. Defaults to true." },
        raw: RAW_PROPERTY,
      }, ["personId"]),
      outputSchema: PERSON_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await get(`/people/${args["personId"]}`, {
          details: args["includeDetails"] === false ? 0 : 1,
        }, ctx);
        // An account-wide key cannot be refused a person, so an empty answer
        // is an absence rather than a permission gap.
        if (!asRecord(payload)["id"]) {
          throw new ConnectorCallError(
            "not_found",
            `Breeze has no person ${args["personId"]}. Re-read the id from list_people.`,
          );
        }
        return args["raw"] === true ? payload : projectPerson(payload);
      },
    },
    {
      name: "list_profile_fields",
      description:
        "List profile fields with fieldId, type, section, and option ids. Decodes person details and builds list_people filters and update_person values.",
      annotations: readOnly,
      inputSchema: namedInput({ raw: RAW_PROPERTY }),
      outputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fieldId: { type: "string" }, name: { type: "string" }, type: { type: "string" },
                section: { type: "string" }, options: { type: "array", items: { type: "object" } },
              },
              required: ["fieldId", "name", "type"],
            },
          },
        },
        required: ["fields"],
      },
      handler: async (args, ctx) => {
        const payload = await get("/profile", {}, ctx);
        return { fields: args["raw"] === true ? asArray(payload) : projectProfileFields(payload) };
      },
    },
    {
      name: "list_tags",
      description:
        "List Breeze tags with id, name, and folder. Tags model groups and lists; pass a tag id to list_people or assign_tag.",
      annotations: readOnly,
      inputSchema: namedInput({
        folderId: idProperty("Only tags in this folder. Folders come from breeze_api_get /tags/list_folders."),
      }),
      outputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" }, folderId: { type: "string" } },
              required: ["id", "name"],
            },
          },
        },
        required: ["tags"],
      },
      handler: async (args, ctx) => ({
        tags: asArray(await get("/tags/list_tags", { folder_id: args["folderId"] }, ctx)).map((value) => {
          const tag = asRecord(value);
          return compact({ id: idString(tag["id"]), name: tag["name"], folderId: idString(tag["folder_id"]) });
        }),
      }),
    },
    {
      name: "list_events",
      description:
        "List event instances between two dates with instance id, series id, calendar, and times. Breeze caches this list for up to 15 minutes.",
      annotations: readOnly,
      inputSchema: namedInput({
        start: dateProperty("First day, YYYY-MM-DD. Defaults to the first of this month."),
        end: dateProperty("Last day, YYYY-MM-DD. Defaults to the end of this month."),
        calendarId: idProperty("Only events on this calendar from list_calendars."),
        limit: {
          type: "integer", minimum: 1, maximum: MAX_EVENT_LIMIT,
          description: `Instances returned, 1 to Breeze's ${MAX_EVENT_LIMIT}. Defaults to ${DEFAULT_EVENT_LIMIT}.`,
        },
        raw: RAW_PROPERTY,
      }),
      outputSchema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Instance id." }, eventId: { type: "string", description: "Series id." },
                name: { type: "string" }, calendarId: { type: "string" },
                startsAt: { type: ["string", "null"] }, endsAt: { type: ["string", "null"] },
              },
              required: ["id", "name"],
            },
          },
          truncated: TRUNCATED_PROPERTY,
        },
        required: ["events", "truncated"],
      },
      handler: async (args, ctx) => {
        const limit: number = args["limit"] ?? DEFAULT_EVENT_LIMIT;
        const rows = asArray(await get("/events", {
          start: args["start"], end: args["end"], category_id: args["calendarId"], limit,
        }, ctx));
        return {
          events: args["raw"] === true ? rows : rows.map(projectEvent),
          truncated: rows.length >= limit,
        };
      },
    },
    {
      name: "list_calendars",
      description:
        "List Breeze event calendars with id, name, and color. Omits each calendar's private iCal feed address, which works without a key.",
      annotations: readOnly,
      inputSchema: namedInput({}),
      outputSchema: {
        type: "object",
        properties: {
          calendars: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" }, color: { type: "string" } },
              required: ["id", "name"],
            },
          },
        },
        required: ["calendars"],
      },
      handler: async (_args, ctx) => ({
        calendars: asArray(await get("/events/calendars/list", {}, ctx)).map((value) => {
          const calendar = asRecord(value);
          return compact({ id: idString(calendar["id"]) ?? "0", name: calendar["name"], color: calendar["color"] });
        }),
      }),
    },
    {
      name: "list_attendance",
      description:
        "List people checked in to one event instance, with check-in and check-out times. Not anonymous head counts; those come from breeze_api_get.",
      annotations: readOnly,
      inputSchema: namedInput({
        instanceId: INSTANCE_ID,
        includeNames: { type: "boolean", description: "Add each attendee's name. Contact details need raw." },
        raw: RAW_PROPERTY,
      }, ["instanceId"]),
      outputSchema: {
        type: "object",
        properties: {
          attendance: {
            type: "array",
            items: {
              type: "object",
              properties: {
                personId: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" },
                checkedInAt: { type: ["string", "null"] }, checkedOutAt: { type: ["string", "null"] },
              },
              required: ["personId"],
            },
          },
        },
        required: ["attendance"],
      },
      handler: async (args, ctx) => {
        const wantDetails = args["includeNames"] === true || args["raw"] === true;
        const rows = asArray(await get("/events/attendance/list", {
          instance_id: args["instanceId"], type: "person", details: wantDetails ? "true" : "false",
        }, ctx));
        if (args["raw"] === true) return { attendance: rows };
        return {
          attendance: rows.map((value) => {
            const record = asRecord(value);
            const person = asRecord(record["details"]);
            return compact({
              personId: idString(record["person_id"]),
              firstName: person["first_name"],
              lastName: person["last_name"],
              checkedInAt: timestamp(record["created_on"]),
              checkedOutAt: timestamp(record["check_out"]),
            });
          }),
        };
      },
    },
    {
      name: "list_forms",
      description: "List Breeze forms with id, name, and URL slug. Active forms by default; archived ones on request.",
      annotations: readOnly,
      inputSchema: namedInput({
        archived: { type: "boolean", description: "List archived forms instead of active ones." },
      }),
      outputSchema: {
        type: "object",
        properties: {
          forms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, name: { type: "string" }, slug: { type: "string" },
                archived: { type: "boolean" }, createdAt: { type: "string" },
              },
              required: ["id", "name"],
            },
          },
        },
        required: ["forms"],
      },
      handler: async (args, ctx) => ({
        forms: asArray(await get("/forms/list_forms", { is_archived: args["archived"] === true ? 1 : 0 }, ctx)).map((value) => {
          const form = asRecord(value);
          return compact({
            id: idString(form["id"]), name: form["name"], slug: form["url_slug"],
            archived: flag(form["is_archived"]), createdAt: form["created_on"],
          });
        }),
      }),
    },
    {
      name: "list_form_fields",
      description: "List one form's fields with fieldId, name, type, and options. Decodes the responses list_form_entries returns.",
      annotations: readOnly,
      inputSchema: namedInput({ formId: FORM_ID }, ["formId"]),
      outputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fieldId: { type: "string" }, name: { type: "string" }, type: { type: "string" },
                options: { type: "array", items: { type: "object" } },
              },
              required: ["fieldId", "name"],
            },
          },
        },
        required: ["fields"],
      },
      handler: async (args, ctx) => ({
        // Form fields share the profile-field row shape, minus a section.
        fields: projectProfileFields([
          { fields: await get("/forms/list_form_fields", { form_id: args["formId"] }, ctx) },
        ]),
      }),
    },
    {
      name: "list_form_entries",
      description:
        "List one form's entries with entry id, person id, and submission time; responses keyed by form fieldId on request. Not paginated.",
      annotations: readOnly,
      inputSchema: namedInput({
        formId: FORM_ID,
        includeResponses: { type: "boolean", description: "Include each entry's answers keyed by fieldId." },
      }, ["formId"]),
      outputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, personId: { type: ["string", "null"] },
                createdAt: { type: "string" }, responses: { type: "object" },
              },
              required: ["id"],
            },
          },
        },
        required: ["entries"],
      },
      handler: async (args, ctx) => ({
        entries: asArray(await get("/forms/list_form_entries", {
          form_id: args["formId"], details: args["includeResponses"] === true ? 1 : 0,
        }, ctx)).map((value) => {
          const entry = asRecord(value);
          return compact({
            id: idString(entry["id"]),
            personId: idString(entry["person_id"]) ?? null,
            createdAt: entry["created_on"],
            responses: args["includeResponses"] === true ? entry["response"] : undefined,
          });
        }),
      }),
    },
    {
      name: "list_volunteers",
      description: "List people scheduled to volunteer at one event instance, with their role ids and RSVP state.",
      annotations: readOnly,
      inputSchema: namedInput({ instanceId: INSTANCE_ID }, ["instanceId"]),
      outputSchema: {
        type: "object",
        properties: {
          volunteers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                personId: { type: "string" }, roleIds: { type: "array", items: { type: "string" } },
                response: { type: "string" }, comment: { type: "string" }, rsvpedAt: { type: ["string", "null"] },
              },
              required: ["personId", "roleIds"],
            },
          },
        },
        required: ["volunteers"],
      },
      handler: async (args, ctx) => ({
        volunteers: asArray(await get("/volunteers/list", { instance_id: args["instanceId"] }, ctx)).map((value) => {
          const volunteer = asRecord(value);
          return compact({
            personId: idString(volunteer["person_id"]),
            roleIds: asArray(volunteer["role_ids"]).map(String),
            response: idString(volunteer["response"]),
            comment: volunteer["comment"] || undefined,
            rsvpedAt: timestamp(volunteer["rsvped_on"]),
          });
        }),
      }),
    },
    {
      name: "list_volunteer_roles",
      description: "List the volunteer roles defined on one event instance with id, name, and quantity needed.",
      annotations: readOnly,
      inputSchema: namedInput({ instanceId: INSTANCE_ID }, ["instanceId"]),
      outputSchema: {
        type: "object",
        properties: {
          roles: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" }, quantity: { type: "number" } },
              required: ["id", "name"],
            },
          },
        },
        required: ["roles"],
      },
      handler: async (args, ctx) => ({
        roles: asArray(await get("/volunteers/list_roles", { instance_id: args["instanceId"], show_quantity: 1 }, ctx)).map((value) => {
          const role = asRecord(value);
          const quantity = Number(role["quantity"]);
          return compact({
            id: idString(role["id"]), name: role["name"],
            quantity: Number.isFinite(quantity) ? quantity : undefined,
          });
        }),
      }),
    },
    {
      name: "list_account_log",
      description:
        "List logged account actions of one type, such as person_updated or contribution_added, with object ids and times. The way to find what changed since a date.",
      annotations: readOnly,
      inputSchema: namedInput({
        action: {
          type: "string", pattern: "^[a-z_]+$", maxLength: 40,
          description: "Logged action, e.g. person_updated, tag_assign, contribution_added; the guide lists all.",
        },
        start: dateProperty("Only actions on or after this day, YYYY-MM-DD."),
        end: dateProperty("Only actions on or before this day, YYYY-MM-DD."),
        userId: idProperty("Only actions by this Breeze user id."),
        includeDetails: { type: "boolean", description: "Include Breeze's unstandardized description." },
        limit: {
          type: "integer", minimum: 1, maximum: MAX_LOG_LIMIT,
          description: `Rows returned, 1 to Breeze's ${MAX_LOG_LIMIT}. Defaults to ${DEFAULT_LOG_LIMIT}.`,
        },
      }, ["action"]),
      outputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, action: { type: "string" }, userId: { type: "string" },
                object: { description: "Parsed object_json, usually the affected id." },
                createdAt: { type: "string" }, details: {},
              },
              required: ["id", "action"],
            },
          },
          truncated: TRUNCATED_PROPERTY,
        },
        required: ["entries", "truncated"],
      },
      handler: async (args, ctx) => {
        const limit: number = args["limit"] ?? DEFAULT_LOG_LIMIT;
        const rows = asArray(await get("/account/list_log", {
          action: args["action"], start: args["start"], end: args["end"], user_id: args["userId"],
          details: args["includeDetails"] === true ? 1 : 0, limit,
        }, ctx));
        return {
          entries: rows.map((value) => {
            const entry = asRecord(value);
            return compact({
              id: idString(entry["id"]),
              action: entry["action"],
              userId: idString(entry["user_id"]),
              object: parsedObject(entry["object_json"]),
              createdAt: entry["created_on"],
              details: args["includeDetails"] === true ? entry["details"] : undefined,
            });
          }),
          truncated: rows.length >= limit,
        };
      },
    },
    {
      name: "list_contributions",
      description:
        "List giving transactions between two dates with donor, amount, method, batch, and fund split, plus a count and exact total. Undocumented by Breeze since 2023.",
      annotations: readOnly,
      inputSchema: namedInput({
        start: dateProperty("First gift date, YYYY-MM-DD."),
        end: dateProperty("Last gift date, YYYY-MM-DD."),
        personId: idProperty("Only this donor's gifts."),
        includeFamily: { type: "boolean", description: "With personId, include the donor's family." },
        amountMin: { type: "number", minimum: 0, description: "Gift amount at least this." },
        amountMax: { type: "number", minimum: 0, description: "Gift amount at most this." },
        fundIds: { ...ID_LIST, description: "Only gifts to these funds from list_funds." },
        methodIds: { ...ID_LIST, description: "Only these payment method ids." },
        batchNumbers: { ...ID_LIST, description: "Only these batch numbers." },
        envelopeNumber: { type: "string", maxLength: 20, description: "Only this envelope number." },
        raw: RAW_PROPERTY,
      }, ["start", "end"]),
      outputSchema: {
        type: "object",
        properties: {
          contributions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, paidOn: { type: "string" }, amount: { type: "string" },
                method: { type: "string" }, personId: { type: "string" }, firstName: { type: "string" },
                lastName: { type: "string" }, batchNumber: { type: "string" }, funds: { type: "array", items: { type: "object" } },
              },
              required: ["id", "amount"],
            },
          },
          count: { type: "integer" },
          totalAmount: { type: ["string", "null"], description: "Exact decimal sum." },
        },
        required: ["contributions", "count", "totalAmount"],
      },
      handler: async (args, ctx) => {
        if (args["includeFamily"] === true && args["personId"] === undefined) {
          throw new ConnectorCallError("invalid_args", "includeFamily needs a personId.");
        }
        const joined = (value: unknown) =>
          Array.isArray(value) ? value.join("-") : undefined;
        // Breeze's 2023 table says DD-MM-YYYY while its own example request
        // sends 2022-1-15; the server parses both, so the unambiguous ISO day
        // is what the schema accepts and what goes on the wire.
        const rows = asArray(await get("/giving/list", {
          start: args["start"], end: args["end"], person_id: args["personId"],
          include_family: args["includeFamily"] === true ? 1 : undefined,
          amount_min: args["amountMin"], amount_max: args["amountMax"],
          fund_ids: joined(args["fundIds"]), method_ids: joined(args["methodIds"]),
          batches: joined(args["batchNumbers"]), envelope_number: args["envelopeNumber"],
        }, ctx));
        return {
          contributions: args["raw"] === true ? rows : rows.map(projectContribution),
          count: rows.length,
          totalAmount: totalAmount(rows.map((row) => asRecord(row)["amount"])),
        };
      },
    },
    {
      name: "list_funds",
      description:
        "List giving funds with id, name, tax-deductible flag, and default flag. Supplies fundIds for list_contributions. Undocumented by Breeze since 2023.",
      annotations: readOnly,
      inputSchema: namedInput({}),
      outputSchema: {
        type: "object",
        properties: {
          funds: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, name: { type: "string" },
                taxDeductible: { type: "boolean" }, isDefault: { type: "boolean" },
              },
              required: ["id", "name"],
            },
          },
        },
        required: ["funds"],
      },
      handler: async (_args, ctx) => ({
        funds: asArray(await get("/funds/list", {}, ctx)).map((value) => {
          const fund = asRecord(value);
          return compact({
            id: idString(fund["id"]), name: fund["name"],
            taxDeductible: flag(fund["tax_deductible"]), isDefault: flag(fund["is_default"]),
          });
        }),
      }),
    },
    {
      name: "add_person",
      description:
        "Create a new person profile with a first and last name and optional profile values. Does not check for duplicates; search list_people first.",
      annotations: additive,
      inputSchema: namedInput({
        firstName: { type: "string", minLength: 1, maxLength: 100, description: "First name." },
        lastName: { type: "string", minLength: 1, maxLength: 100, description: "Last name." },
        fields: FIELDS_PROPERTY,
      }, ["firstName", "lastName"]),
      outputSchema: PERSON_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await get("/people/add", {
          first: args["firstName"], last: args["lastName"],
          fields_json: args["fields"] === undefined ? undefined : fieldsJson(args["fields"]),
        }, ctx);
        const person = Array.isArray(payload) ? payload[0] : payload;
        if (!asRecord(person)["id"]) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Breeze accepted the new person without returning it; check list_people before retrying so it is not added twice.",
            { retryable: false },
          );
        }
        return projectPerson(person);
      },
    },
    {
      name: "update_person",
      description:
        "Set profile values on one person: contact details, multiple choice, dates, text, or family role. Replaces each named field's value.",
      annotations: destructive,
      inputSchema: namedInput({ personId: PERSON_ID, fields: FIELDS_PROPERTY }, ["personId", "fields"]),
      outputSchema: PERSON_SCHEMA,
      handler: async (args, ctx) => {
        const fields = fieldsJson(args["fields"]);
        const payload = await get("/people/update", { person_id: args["personId"], fields_json: fields }, ctx);
        requireTrue(payload, "the person update");
        const person = Array.isArray(payload) ? payload[0] : payload;
        return asRecord(person)["id"] ? projectPerson(person) : { id: String(args["personId"]) };
      },
    },
    {
      name: "assign_tag",
      description: "Add one tag to one person. Tag ids come from list_tags; adding a tag the person already has changes nothing.",
      annotations: additive,
      inputSchema: namedInput({ personId: PERSON_ID, tagId: idProperty("Tag id from list_tags.") }, ["personId", "tagId"]),
      outputSchema: WROTE_SCHEMA("assigned"),
      handler: async (args, ctx) => {
        requireTrue(await get("/tags/assign", { person_id: args["personId"], tag_id: args["tagId"] }, ctx), "the tag assignment");
        return { assigned: true };
      },
    },
    {
      name: "unassign_tag",
      description: "Remove one tag from one person. The tag itself and its other people are untouched.",
      annotations: destructive,
      inputSchema: namedInput({ personId: PERSON_ID, tagId: idProperty("Tag id from list_tags.") }, ["personId", "tagId"]),
      outputSchema: WROTE_SCHEMA("unassigned"),
      handler: async (args, ctx) => {
        requireTrue(await get("/tags/unassign", { person_id: args["personId"], tag_id: args["tagId"] }, ctx), "the tag removal");
        return { unassigned: true };
      },
    },
    {
      name: "record_check_in",
      description:
        "Record one person's attendance at one event instance. Check-out and removing a record go through breeze_api_mutate.",
      annotations: additive,
      inputSchema: namedInput({ personId: PERSON_ID, instanceId: INSTANCE_ID }, ["personId", "instanceId"]),
      outputSchema: WROTE_SCHEMA("checkedIn"),
      handler: async (args, ctx) => {
        requireTrue(await get("/events/attendance/add", {
          person_id: args["personId"], instance_id: args["instanceId"], direction: "in",
        }, ctx), "the check-in");
        return { checkedIn: true };
      },
    },
  ];
}

// --- Guide -------------------------------------------------------------------

function usageGuide(
  subdomain: string,
  purpose: string,
  instructions: string | undefined,
): string {
  const churchInstructions = instructions?.trim();
  return `# Breeze ChMS usage

Church database for ${subdomain}.breezechms.com (Breeze ChMS, now Tithely Church Management): people, tags, events, attendance, forms, volunteers, and giving.

Church purpose: ${purpose}

## Sensitive data: reduce in code

People records carry home addresses, phones, birthdates, and family ties, and
giving records reveal who gives and how much — religious affiliation by proxy.
Read them inside \`execute_code\` and return only the counts, totals, or the
few fields the task needs. Never echo whole profiles or donor lists.

## Ids and profile fields

- Ids are numeric strings. Read them from a list tool; never guess one.
- Events have two ids: an instance id (\`list_events\` \`id\`) for one
  occurrence, and a series \`eventId\`. Attendance, volunteers, and
  check-in take the instance id.
- Person \`details\` are keyed by profile \`fieldId\`, not by name. Call
  \`list_profile_fields\` once and map ids to names in code. Multiple-choice
  values and \`list_people\` filters use option ids from the same call;
  join several with \`-\`.
- \`list_people\` has no name search. List without details and match names
  in code, then \`get_person\` the hits.
- Projections rename Breeze's snake_case fields to camelCase and drop photo
  paths and internal columns; \`raw: true\` returns Breeze's rows.

## Pagination

\`list_people\` pages by \`cursor\`: continue while \`page.hasMore\`. Breeze
reports no total, so a full page sets \`hasMore\` and the next may be empty.
\`list_events\` and \`list_account_log\` do not page: \`truncated: true\`
means narrow the date range. Other lists return everything.

## Giving

\`list_contributions\` and \`list_funds\` call endpoints Breeze removed from
its public reference in 2023 but still serves. They may change or vanish
without notice; a failure there is not your argument's fault. Amounts are
decimal strings; \`totalAmount\` is an exact sum. Online gifts processed by
Tithe.ly arrive through its sync, batched per deposit, so the latest days
may be missing. Read the currency from \`get_account_summary\`.

## Writes and the hatches

- Every write, \`add_person\`, \`assign_tag\`, and \`record_check_in\`
  included, is a \`call_destructive_tool\` call unless the deployment exempts
  it in \`execute.approval\`; a program inside \`execute_code\` is refused
  the rest. Those three only add, and \`add_person\` never deduplicates.
- \`update_person\` field values: text, date (M/D/YYYY), or option id in
  \`response\`; email, phone, address, and family_role values in \`details\`.
- Every Breeze call is a GET, writes included, so the hatches split by
  endpoint. \`breeze_api_get\` admits only reviewed read endpoints and their
  documented parameters, such as \`/tags/list_folders\`,
  \`/events/list_event\`, \`/events/attendance/eligible\`, \`/giving/view\`,
  and \`/pledges/list_campaigns\`; it refuses anything else. Everything else
  — event, family, volunteer, and form writes, giving writes, check-out,
  undocumented parameters — is \`breeze_api_mutate\`. Paths are below
  \`/api\`; \`*_json\` values may be passed as objects.
- \`list_account_log\` actions include person_created, person_updated,
  person_deleted, tag_assign, tag_unassign, event_created,
  attendance_deleted, form_entry_updated, contribution_added,
  contribution_updated, contribution_deleted, and batch_updated.

## Rate limits

Breeze publishes no limit and sends no rate headers; a third party reports
about 20 requests per minute. Keep loops sequential and prefer one list call
over many single reads.
${churchInstructions ? `\n## Church instructions\n\n${churchInstructions}\n` : ""}`;
}

// --- Construction --------------------------------------------------------------

function normalizeSubdomain(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!SUBDOMAIN_PATTERN.test(value)) {
    throw new Error(
      'breeze() subdomain must be the one hostname label before .breezechms.com — "gracechurch" for gracechurch.breezechms.com — not a URL or host.',
    );
  }
  return value;
}


/** The closed options breeze() accepts; see `assertKnownOptions`. */
const BREEZE_OPTIONS = optionsOf<BreezeOptions>()({ ...PROVIDER_COMMON, ...keys("subdomain", "defaultPageSize") });

/** A maintained Breeze ChMS connection for one church's subdomain. */
export function breeze(id: string, options: BreezeOptions): Connector {
  return asProvider("breeze", BREEZE_OPTIONS, id, options, breezeConnector);
}

function breezeConnector(id: string, options: BreezeOptions): Connector {
  const purpose = typeof options.purpose === "string" ? options.purpose.trim() : "";
  if (!purpose) {
    throw new Error("breeze() requires a non-empty church purpose.");
  }
  const subdomain = normalizeSubdomain(options.subdomain);
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(defaultPageSize) ||
    defaultPageSize < 1 ||
    defaultPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `breeze() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  const send = breezeTransport(subdomain);

  return api(id, {
    ...defined({
      authScope: options.authScope,
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? `Breeze ChMS (${subdomain})`,
    description: `Breeze ChMS church database at ${subdomain}${BREEZE_HOST_SUFFIX}: ${purpose}`,
    credential: {
      label: "Breeze API key",
      description: `The church's API key from Breeze → Extensions → API (https://${subdomain}${BREEZE_HOST_SUFFIX}/extensions/api). It has no scopes: it reaches the whole account, giving included. The connector sends it only to ${subdomain}${BREEZE_HOST_SUFFIX}.`,
      placeholder: "Paste Breeze API key",
    },
    testCredential: async (value, ctx) => {
      try {
        const account = asRecord(await callBreeze(
          send,
          { method: "GET", path: "/account/summary" },
          { ...ctx, credential: { get: async () => value, getAll: async () => ({ value }) } },
        ));
        const reported = typeof account["subdomain"] === "string" ? account["subdomain"].toLowerCase() : undefined;
        if (reported && reported !== subdomain) {
          return { ok: false, message: `The key belongs to ${reported}${BREEZE_HOST_SUFFIX}, not ${subdomain}${BREEZE_HOST_SUFFIX}.` };
        }
        return { ok: true, message: `Authenticated to ${String(account["name"] ?? "the church account")} (${subdomain}${BREEZE_HOST_SUFFIX}).` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof ConnectorCallError ? error.message : "Breeze rejected the key.",
        };
      }
    },
    usageGuide: {
      content: usageGuide(subdomain, purpose, options.instructions),
      summary:
        "Sensitive church data, fieldId decoding, two id kinds, undocumented giving reads, and endpoint-split hatches.",
      // Required because correct use rests on conventions no schema carries:
      // person details are keyed by profile fieldId, filters and multiple-
      // choice values are option ids joined by '-', and the giving reads ride
      // undocumented endpoints whose failures mean something different.
      required: true,
    },
    tools: tools(send, defaultPageSize),
  });
}
