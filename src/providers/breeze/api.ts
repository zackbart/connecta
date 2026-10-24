// Breeze's reviewed GET-only vendor. HTTP methods do not establish safety: see tools.ts.
import { type Context, Effect, Schema } from "effect";
import { ConnectorCallError, resendAdvice } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors, type OperationRef } from "../../http/errors.js";
import { Credentials, RequestSecrets } from "../../http/services.js";
import { get, Summary, vendor, type Vendor } from "../../http/vendor.js";
import type { SafetyOptions } from "../../http/safety.js";
import { vendorIndex } from "../../http/vendor-index.js";
import type { HatchPageAdapter } from "../../http/hatch-paging.js";
import { openapi } from "./openapi.generated.js";
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;
export const BREEZE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export type JsonRecord = Record<string, any>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- The read hatch's allowlist ----------------------------------------------

/** Reviewed observational endpoints and their documented query names. GET alone establishes nothing. */
export const READ_ENDPOINTS: ReadonlyMap<string, readonly string[]> = new Map([
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
  [
    "/giving/list",
    [
      "start",
      "end",
      "person_id",
      "include_family",
      "amount_min",
      "amount_max",
      "method_ids",
      "fund_ids",
      "envelope_number",
      "batches",
      "forms",
      "pledge_ids",
    ],
  ],
  ["/giving/view", ["payment_id"]],
  ["/funds/list", ["include_totals"]],
  ["/pledges/list_campaigns", []],
  ["/pledges/list_pledges", ["campaign_id"]],
]);

/** A Breeze path: lowercase segments of letters, digits, and underscores. */
const PATH_PATTERN = /^(\/[a-z0-9_]+)+\/?$/;

/**
 * `/events/calendars/list` answers each calendar's private iCal feed address,
 * which reads the calendar without a key, and its embed key. Neither hatch
 * returns them.
 */
export function withoutCalendarFeeds(path: string, body: unknown): unknown {
  if (path !== "/events/calendars/list" || !Array.isArray(body)) return body;
  return body.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const { address: _address, embed_key: _embedKey, ...calendar } = row as JsonRecord;
    return calendar;
  });
}

export function normalizedPath(raw: unknown): string {
  const path = typeof raw === "string" ? raw : "";
  if (!PATH_PATTERN.test(path)) {
    throw new ConnectorCallError(
      "invalid_args",
      "A Breeze path is relative to /api, begins with '/', and uses only lowercase letters, digits, underscores, and '/' — for example /tags/list_folders. No query string, host, or dot segments.",
    );
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// --- Projections -------------------------------------------------------------

// The HTML pin/conversion remains drift evidence. These reviewed declarations
// are the hatch's one runtime operation list; success properties are lenient
// discovery/selection metadata, never response decoders.
const loose = (names: string, extra: Schema.Struct.Fields = {}) =>
  Schema.Struct({
    ...Object.fromEntries(
      names
        .split(" ")
        .filter(Boolean)
        .map((name) => [name, Schema.optionalKey(Schema.Unknown)]),
    ),
    ...extra,
  });
const Person = loose(
  "id oid first_name force_first_name last_name nick_name middle_name maiden_name path thumb_path details family",
);
const ProfileField = loose("id oid field_id field_type name position profile_id created_on options");
const Event = loose(
  "id oid event_id name category_id start_datetime end_datetime description check_in_settings eligible",
);
const Payment = loose(
  "id oid paid_on created_on num method method_id amount note person_id first_name last_name envelope_number meta batch_num batch_id person",
  {
    funds: Schema.optionalKey(
      Schema.Array(loose("id oid payment_id fund_id amount created_on fund_name tax_deductible")),
    ),
  },
);
const GivingAnswer = loose("success errors payment_id", { payment: Schema.optionalKey(Payment) });
const responseByPath: Readonly<Record<string, Schema.Top>> = {
  "/people": Schema.Array(Person),
  "/people/{PERSON_ID}": Person,
  "/people/add": Schema.Union([Person, Schema.Array(Person)]),
  "/people/update": Schema.Union([Person, Schema.Array(Person), Schema.Boolean]),
  "/profile": Schema.Array(
    loose("id oid section_id name column_id position profile_id created_on", {
      fields: Schema.optionalKey(Schema.Array(ProfileField)),
    }),
  ),
  "/tags/list_tags": Schema.Array(loose("id name created_on folder_id")),
  "/tags/list_folders": Schema.Array(loose("id name parent_id")),
  "/events": Schema.Array(Event),
  "/events/list_event": Schema.Union([Event, Schema.Array(Event)]),
  "/events/calendars/list": Schema.Array(loose("id name color address embed_key")),
  "/events/locations": Schema.Array(loose("id name")),
  "/events/attendance/list": Schema.Array(loose("id instance_id person_id created_on check_out details")),
  "/events/attendance/eligible": Schema.Array(Person),
  "/forms/list_forms": Schema.Array(loose("id name url_slug is_archived created_on")),
  "/forms/list_form_fields": Schema.Array(ProfileField),
  "/forms/list_form_entries": Schema.Array(loose("id form_id created_on person_id response")),
  "/volunteers/list": Schema.Array(
    loose("id oid instance_id person_id response comment rsvped_on created_on role_ids"),
  ),
  "/volunteers/list_roles": Schema.Array(loose("id name quantity")),
  "/volunteers/add_role": loose("id name quantity"),
  "/account/summary": loose("id name subdomain status created_on", {
    details: Schema.optionalKey(
      loose("timezone", { country: Schema.optionalKey(loose("id name currency currency_symbol")) }),
    ),
  }),
  "/account/list_log": Schema.Array(loose("id user_id action object_json created_on details")),
  "/giving/list": Schema.Array(Payment),
  "/giving/view": GivingAnswer,
  "/giving/add": GivingAnswer,
  "/giving/edit": GivingAnswer,
  "/giving/delete": GivingAnswer,
  "/funds/list": Schema.Array(loose("id name tax_deductible is_default created_on total")),
  "/pledges/list_campaigns": Schema.Array(loose("id oid name created_on number_of_pledges total_pledged")),
  "/pledges/list_pledges": Schema.Array(
    loose(
      "id oid person_id fundraiser_id amount started_on ends_type ends_date ends_number frequency fund_ids_json note include_family created_on first_name last_name fundraiser_name total_pledged family_id total_paid paid_percent",
    ),
  ),
};
// Required identities and values follow the public and archived reference's
// endpoint tables/examples. Optional names (including query JSON strings) stay optional.
const requiredByPath: Readonly<Record<string, readonly string[]>> = {
  "/people/add": ["first", "last"],
  "/people/update": ["person_id", "fields_json"],
  "/people/delete": ["person_id"],
  "/tags/add_tag": ["name"],
  "/tags/add_tag_folder": ["name"],
  "/tags/delete_tag": ["tag_id"],
  "/tags/delete_tag_folder": ["folder_id"],
  "/tags/assign": ["person_id", "tag_id"],
  "/tags/unassign": ["person_id", "tag_id"],
  "/events/add": ["name", "starts_on"],
  "/events/delete": ["instance_id"],
  "/events/list_event": ["instance_id"],
  "/events/attendance/add": ["instance_id", "person_id"],
  "/events/attendance/delete": ["instance_id", "person_id"],
  "/events/attendance/list": ["instance_id"],
  "/events/attendance/eligible": ["instance_id"],
  "/forms/list_form_fields": ["form_id"],
  "/forms/list_form_entries": ["form_id"],
  "/forms/remove_form_entry": ["entry_id"],
  "/volunteers/list": ["instance_id"],
  "/volunteers/add": ["instance_id", "person_id"],
  "/volunteers/remove": ["instance_id", "person_id"],
  "/volunteers/update": ["instance_id", "person_id"],
  "/volunteers/list_roles": ["instance_id"],
  "/volunteers/add_role": ["instance_id", "name"],
  "/volunteers/remove_role": ["instance_id", "role_id"],
  "/families/create": ["people_ids_json"],
  "/families/destroy": ["people_ids_json"],
  "/families/remove": ["people_ids_json"],
  "/families/add": ["people_ids_json", "target_person_id"],
  "/account/list_log": ["action"],
  "/giving/view": ["payment_id"],
  "/giving/edit": ["payment_id"],
  "/giving/delete": ["payment_id"],
  "/pledges/list_pledges": ["campaign_id"],
};
const GIVING_QUERY = [
  "date",
  "person_id",
  "person_json",
  "uid",
  "processor",
  "method",
  "funds_json",
  "amount",
  "group",
  "batch_number",
  "batch_name",
  "note",
];
// Explicitly reviewed write endpoints; the absence of a read review never grants one.
const WRITES = new Set([
  "/events/add",
  "/events/attendance/add",
  "/events/attendance/delete",
  "/events/delete",
  "/families/add",
  "/families/create",
  "/families/destroy",
  "/families/remove",
  "/forms/remove_form_entry",
  "/giving/add",
  "/giving/edit",
  "/giving/delete",
  "/people/add",
  "/people/delete",
  "/people/update",
  "/tags/add_tag",
  "/tags/add_tag_folder",
  "/tags/assign",
  "/tags/delete_tag",
  "/tags/delete_tag_folder",
  "/tags/unassign",
  "/volunteers/add",
  "/volunteers/add_role",
  "/volunteers/remove",
  "/volunteers/remove_role",
  "/volunteers/update",
]);
const details = JSON.parse(openapi.details) as { o: Array<0 | [Array<[string, string, number]>, unknown]> };
const declared = openapi.ops.map(([, path, name], row) => {
  const params = Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1]!, Schema.String]));
  const entry = details.o[row];
  const names =
    path === "/giving/add"
      ? GIVING_QUERY
      : path === "/giving/edit"
        ? ["payment_id", "name", ...GIVING_QUERY]
        : entry === 0 || !entry
          ? []
          : entry[0].filter(([, at]) => at === "query").map(([name]) => name);
  const query = Object.fromEntries(
    names.map((key) => [
      key,
      (requiredByPath[path]?.includes(key) ? Schema.String : Schema.optionalKey(Schema.String)).pipe(
        Schema.annotateKey({
          description: key.endsWith("_json")
            ? "JSON-encoded string; objects and arrays must be serialized before calling."
            : key.replaceAll("_", " "),
        }),
      ),
    ]),
  );
  const summary =
    name.replaceAll("_", " ") +
    (path.startsWith("/giving/") || path.startsWith("/pledges/") || path === "/funds/list"
      ? " (archival API; verify support)"
      : "") +
    (path === "/giving/add" ? "; requiredness is not specified in the archived contract" : "");
  return get(name, path.replace(/\{([^}]+)\}/g, ":$1") as `/${string}`, {
    params,
    query,
    success: responseByPath[path] ?? Schema.Unknown,
  }).annotate(Summary, summary);
});
export const BreezeApi: Vendor = {
  ...vendor("Breeze", declared[0]!, ...declared.slice(1)),
  textBodies: {
    review: "Breeze error responses are bounded text or HTML; successes require JSON.",
    forResponse: (status) => (status < 200 || status > 299 ? "text" : undefined),
  },
};
export const BREEZE_INDEX = vendorIndex(BreezeApi, {
  prefix: "breeze",
  title: "Breeze ChMS",
  revision: openapi.revision,
});
export const BREEZE_VERDICTS = Object.fromEntries(
  BREEZE_INDEX.ops.map((op) => {
    const read = READ_ENDPOINTS.has(op.path === "/people/{PERSON_ID}" ? "/people/{id}" : op.path);
    if (!read && !WRITES.has(op.path)) throw new Error(`Breeze operation ${op.path} needs a review.`);
    return [`${op.method} ${op.path}`, read ? "read" : "destructive"];
  }),
) as Readonly<Record<`GET ${string}`, "read" | "destructive">>;
export const BREEZE_NAMED = {
  "GET /account/summary": "get_account_summary",
  "GET /people": "list_people",
  "GET /people/{PERSON_ID}": "get_person",
  "GET /profile": "list_profile_fields",
  "GET /tags/list_tags": "list_tags",
  "GET /events": "list_events",
  "GET /events/attendance/list": "list_attendance",
  "GET /giving/list": "list_contributions",
  "GET /funds/list": "list_funds",
  "GET /people/add": "add_person",
  "GET /people/update": "update_person",
} as const;
/** Breeze returns all people when limit is absent/zero, so only a positive explicit limit pages. */
export const breezePeoplePage: HatchPageAdapter = {
  param: "offset",
  in: "query",
  decode: (cursor) => {
    const value = Number(cursor);
    if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(value) || value < 0)
      throw new ConnectorCallError("invalid_args", "Breeze needs a nonnegative whole offset.");
    return value;
  },
  next(data, call) {
    const limit = Number(call.query["limit"] ?? 0),
      offset = Number(call.query["offset"] ?? 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Array.isArray(data) ||
      !Number.isSafeInteger(offset + data.length)
    )
      throw new ConnectorCallError("connector_call_failed", "Breeze returned invalid people paging data.", {
        retryable: false,
      });
    return limit === 0 ? undefined : data.length >= limit ? offset + data.length : null;
  },
};
export const accountSummary = declared.find((operation) => operation.identifier === "account_summary")!;

export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const key = values?.["value"]?.trim();
  if (!key)
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "No Breeze API key is configured for this connector. Call authorize_connector for recovery options. When available, an operator can add the key in this connection in the operator UI.",
        ),
      }),
    );
  return { "Api-Key": key };
});
function bodyDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.length > 200) return "";
  return ` Breeze said: ${trimmed}`;
}

// These account-wide keys have no scopes: 401 and 403 both mean key recovery;
// a 404 is an absent endpoint or record. No evidence establishes auth before execution.
export const errors: VendorErrors = {
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
  },
  provider: "Breeze",
  facts: () => ({}),
  detail: ({ body }) => bodyDetail(typeof body === "string" ? body : ""),
  meanings: { unknownId: "not_found", provesAbsence: true, conflicts: [] },
  unreadable: "Breeze returned a non-JSON successful response.",
  statuses: {
    401: ({ status }) => ({
      code: "auth_required",
      words: (detail) =>
        `Breeze rejected the configured API key (HTTP ${status}).${detail} An operator must replace it with the key from this church's Extensions → API page.`,
    }),
    403: ({ status }) => ({
      code: "auth_required",
      words: (detail) =>
        `Breeze rejected the configured API key (HTTP ${status}).${detail} An operator must replace it with the key from this church's Extensions → API page.`,
    }),
    404: () => ({
      code: "not_found",
      words: () =>
        "Breeze has no such endpoint or record (HTTP 404). Check the path against the API reference, or re-read the id from its list tool.",
    }),
  },
};
export const result = (body: unknown): Effect.Effect<unknown, HttpFailure, RequestSecrets> => {
  return RequestSecrets.use((secrets) => {
    const failure = reportedFailure(body, secrets);
    return failure ? Effect.fail(new Refusal({ error: failure })) : Effect.succeed(body ?? null);
  });
};

// The only documented capability-bearing response values are calendar feeds.
// Every result passes through the same drop before any projection or fields selection.
export const breezeSafety: SafetyOptions = {
  review:
    "Breeze's indexed hatch admits only reviewed operations. The reviewed reference exposes no stored credential values outside calendar feed addresses and embed keys, which are dropped on every result path. Unknown paths are refused.",
  reviewed: {
    resolve: (method, path): OperationRef => ({
      method,
      template: (() => {
        const op = BREEZE_INDEX.resolve(method, normalizedPath(path)).op;
        if (op.path === "/people/{PERSON_ID}" && !/^\/people\/\d+\/?$/.test(path))
          throw new ConnectorCallError("invalid_args", "A Breeze person path requires a numeric person id.");
        return op.path;
      })(),
    }),
    redact: (body, op) => withoutCalendarFeeds(op.template, body),
    withholdsErrors: () => false,
  },
  sensitiveFields: { names: [], choice: "drop" },
};
function shortText(value: unknown, secrets: Context.Service.Shape<typeof RequestSecrets>): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  // The kit redacted the answer's values and kept its keys (#703); serialized, a key is text
  // the cut below could split, so the whole text is checked before it is cut.
  const text = secrets.redact(JSON.stringify(value));
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Breeze can report a failure inside a 200: `{ success: false, errors: … }`
 * or an `errorCode`. The giving endpoints' success shape is
 * `{ success: true, errors: null }`, so a null or empty `errors` is not one.
 */
function reportedFailure(
  payload: unknown,
  secrets: Context.Service.Shape<typeof RequestSecrets>,
): ConnectorCallError | undefined {
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
    shortText(root["errorMessage"], secrets) ??
    shortText(root["message"], secrets) ??
    shortText(root["errors"], secrets) ??
    shortText(root["errorCode"], secrets) ??
    "no detail";
  // Breeze uses the same envelope for a rejected argument and a missing
  // record, so the code stays the honest generic one and the message says so.
  return resendAdvice(
    new ConnectorCallError(
      "connector_call_failed",
      `Breeze reported a failure: ${message}. Breeze does not say whether an argument or a record is at fault.`,
      { retryable: false },
    ),
    "; re-check ids with the list tools before retrying",
  );
}
