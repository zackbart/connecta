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
function withoutCalendarFeeds(path: string, body: unknown): unknown {
  if (path !== "/events/calendars/list") return body;
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "address" && key !== "embed_key")
        .map(([key, child]) => [key, strip(child)]),
    );
  };
  return strip(body);
}

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
  "id oid first_name force_first_name last_name nick_name middle_name maiden_name path thumb_path details family street_address city state zip",
);
const ProfileField = loose("id oid field_id field_type name position profile_id profile_section_id created_on options");
const Event = loose(
  "id oid event_id name category_id settings_id is_modified created_on start_datetime end_datetime description check_in_settings eligible",
);
const Tag = loose("id name created_on folder_id");
const TagFolder = loose("id name parent_id created_on");
const FamilyAnswer = loose("success");
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
  "/tags/list_tags": Schema.Array(Tag),
  "/tags/list_folders": Schema.Array(TagFolder),
  "/tags/add_tag": Schema.Array(Tag),
  "/tags/add_tag_folder": Schema.Array(TagFolder),
  "/events": Schema.Array(Event),
  "/events/list_event": Schema.Union([Event, Schema.Array(Event)]),
  "/events/add": Schema.Array(Event),
  "/events/calendars/list": Schema.Array(loose("id oid name color created_on address embed_key")),
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
  "/account/list_log": Schema.Array(loose("id oid user_id action object_json created_on details")),
  "/families/create": FamilyAnswer,
  "/families/destroy": FamilyAnswer,
  "/families/add": FamilyAnswer,
  "/families/remove": FamilyAnswer,
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
// Reviewed against the endpoint descriptions/examples in the public and archived reference.
const summaries: Readonly<Record<string, string>> = {
  "/account/list_log": "Read the account audit log of actions on people and other records.",
  "/account/summary": "Read account identity, timezone, country and giving currency.",
  "/events": "List event occurrences in a date range, with series ids and times.",
  "/events/add": "Create an event occurrence, optionally in an existing series.",
  "/events/delete": "Delete an event occurrence by instance id.",
  "/events/list_event": "Read one event occurrence and optionally its series schedule.",
  "/events/calendars/list": "List event calendars; private feed addresses and embed keys are removed.",
  "/events/locations": "List event locations and their ids.",
  "/events/attendance/add": "Record attendance: check in or check out a person at an event occurrence.",
  "/events/attendance/delete": "Delete a person's attendance record for an event occurrence.",
  "/events/attendance/eligible": "List people eligible to attend an event occurrence.",
  "/events/attendance/list": "List attendance for an event occurrence, including check-out times.",
  "/families/add": "Add people to the family of a target person, replacing previous family associations.",
  "/families/create": "Create a family from the specified people.",
  "/families/destroy": "Destroy family associations for the specified people.",
  "/families/remove": "Remove specified people from their family associations.",
  "/forms/list_forms": "List forms, optionally selecting archived forms.",
  "/forms/list_form_fields": "Read a form's field definitions for decoding entry responses.",
  "/forms/list_form_entries": "List entries submitted to a form, optionally including response details.",
  "/forms/remove_form_entry": "Delete a submitted form entry by entry id.",
  "/funds/list": "List giving funds, optionally including contribution totals.",
  "/giving/add": "Record a giving contribution or donation with donor and fund allocations.",
  "/giving/delete": "Delete a giving contribution or donation by payment id.",
  "/giving/edit": "Edit a giving contribution or donation; the payment id may change.",
  "/giving/list": "List giving contributions or donations by date, donor, amount and fund filters.",
  "/giving/view": "Read one giving contribution or donation by payment id.",
  "/people": "List people with optional profile details and tag or profile-field filters.",
  "/people/add": "Create a person with first/last names and optional profile values.",
  "/people/delete": "Delete a person profile by person id.",
  "/people/update": "Update a person's profile values by field id.",
  "/people/{PERSON_ID}": "Read a person profile and optionally field-id details and family members.",
  "/pledges/list_campaigns": "List pledge campaigns before reading their individual pledges.",
  "/pledges/list_pledges": "List a campaign's pledge rows, amounts, donors and payment progress.",
  "/profile": "List profile sections, field definitions and multiple-choice option ids.",
  "/tags/add_tag": "Create a tag, optionally within a tag folder.",
  "/tags/add_tag_folder": "Create a tag folder, optionally within a parent folder.",
  "/tags/assign": "Assign a tag to a person.",
  "/tags/delete_tag": "Delete a tag by tag id.",
  "/tags/delete_tag_folder": "Delete a tag folder by folder id.",
  "/tags/list_folders": "List tag folders and their parent ids.",
  "/tags/list_tags": "List tags, optionally within a folder.",
  "/tags/unassign": "Unassign a tag from a person.",
  "/volunteers/add": "Assign a person to volunteer at an event occurrence.",
  "/volunteers/add_role": "Create a volunteer role for an event occurrence.",
  "/volunteers/list": "List volunteers assigned to an event occurrence and their responses.",
  "/volunteers/list_roles": "List volunteer roles for an event occurrence.",
  "/volunteers/remove": "Remove a person's volunteer assignment from an event occurrence.",
  "/volunteers/remove_role": "Delete a volunteer role from an event occurrence.",
  "/volunteers/update": "Update a person's volunteer roles at an event occurrence.",
};
const parameterDescriptions: Readonly<Record<string, string>> = {
  action: "Account-log action to match, for example person_updated.",
  start: "First date in the requested range; use YYYY-MM-DD.",
  end: "Last date in the requested range; use YYYY-MM-DD.",
  user_id: "Account user id whose actions to list.",
  details: "Set 1 to include the endpoint's expanded record details; 0 omits them.",
  limit: "Maximum rows requested from the vendor; a full result can require paging or a narrower range.",
  offset: "Opaque nextCursor from the preceding people page; omit on the first call.",
  category_id: "Event category id to select or assign.",
  calendar_id: "Calendar id from /events/calendars/list.",
  eligible: "Set 1 to include check-in eligibility settings and associated tags.",
  name: "Name of the record being created or edited.",
  starts_on: "Event start as a Unix timestamp in seconds.",
  ends_on: "Event end as a Unix timestamp in seconds; defaults to one hour after starts_on.",
  all_day: "Set 1 for an all-day event, 0 otherwise.",
  description: "Event description text.",
  event_id: "Existing event series id when adding an occurrence to that series.",
  direction: "Attendance direction: in records check-in, out records check-out; default in.",
  person_id: "Person id from /people; resolve the target before writing.",
  instance_id: "Event occurrence id, not the recurring series event_id.",
  type: "Attendance selector: person for people, anonymous for anonymous counts.",
  schedule: "Set 1 to include the event series schedule.",
  schedule_direction: "Schedule direction relative to this occurrence: before or after; default before.",
  schedule_limit: "Maximum scheduled occurrences to include.",
  people_ids_json: "JSON-encoded array of person ids for the family operation.",
  target_person_id: "Person whose family receives the specified people.",
  form_id: "Form id from /forms/list_forms.",
  is_archived: "Set 1 for archived forms, 0 for active forms.",
  entry_id: "Submitted form entry id from /forms/list_form_entries.",
  include_totals: "Set 1 to include each fund's contribution total.",
  date: "Giving transaction date; the archived parameter table specifies DD-MM-YYYY.",
  person_json: "JSON-encoded donor details when supplying an unassociated donor.",
  uid: "External donor id from the giving platform, used with processor when the Breeze person id is unknown.",
  processor: "Payment processor name associated with the transaction.",
  method: "Giving payment method name, for example Cash or Check.",
  funds_json: "JSON-encoded array of fund allocations with name, amount and optional id; amounts must sum to amount.",
  amount: "Giving transaction amount as an exact decimal string.",
  group: "Unique group for a giving batch; repeated groups reuse the remembered batch.",
  batch_number: "Giving batch number to assign.",
  batch_name: "Giving batch name to assign.",
  note: "Giving transaction note.",
  payment_id: "Giving transaction id from /giving/list; editing can return a new id.",
  include_family: "Set 1 to include giving from the person's family.",
  amount_min: "Minimum giving amount as an exact decimal string.",
  amount_max: "Maximum giving amount as an exact decimal string.",
  method_ids: "Giving method ids to include, separated by dashes.",
  fund_ids: "Giving fund ids to include, separated by dashes.",
  envelope_number: "Donor envelope number to match.",
  batches: "Giving batch numbers to include, separated by dashes.",
  forms: "Giving form ids to include, separated by dashes.",
  pledge_ids: "Pledge campaign ids to include in the giving filter, separated by dashes.",
  filter_json: "JSON-encoded profile-field and tag filters; resolve field, option and tag ids first.",
  first: "Person's first name.",
  last: "Person's last name.",
  fields_json: "JSON-encoded profile values keyed by field_id, with field_type and response or details.",
  campaign_id: "Pledge campaign id from /pledges/list_campaigns.",
  folder_id: "Tag folder id from /tags/list_folders.",
  parent_id: "Parent tag-folder id; omit to use the root.",
  tag_id: "Tag id from /tags/list_tags.",
  quantity: "Number of volunteer positions for the role.",
  show_quantity: "Set 1 to include the number of positions for each volunteer role.",
  role_id: "Volunteer role id from /volunteers/list_roles.",
  role_ids_json: "JSON-encoded array of volunteer role ids to assign.",
};
const PEOPLE_LIMIT_PATTERN = "^(?:0|[1-9][0-9]{0,2}|1000)$";
const details = JSON.parse(openapi.details) as { o: Array<0 | [Array<[string, string, number]>, unknown]> };
const declared = openapi.ops.map(([, path, name], row) => {
  const params = Object.fromEntries(
    [...path.matchAll(/\{([^}]+)\}/g)].map((m) => [
      m[1]!,
      Schema.String.annotate({ description: "Numeric person id from /people." }),
    ]),
  );
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
    names.map((key) => {
      const value =
        path === "/people" && key === "limit"
          ? Schema.String.check(
              Schema.makeFilter((raw: string) => new RegExp(PEOPLE_LIMIT_PATTERN).test(raw), {
                toJsonSchema: () => ({ pattern: PEOPLE_LIMIT_PATTERN }),
              }),
            )
          : Schema.String;
      const description =
        path === "/people" && key === "limit"
          ? "Whole decimal count from 1 to 1000; 0 or omission requests all people without paging."
          : path === "/giving/edit" && key === "name"
            ? "Donor name, as shown in the archived edit example."
            : parameterDescriptions[key];
      if (!description) throw new Error(`Breeze parameter ${path} ${key} needs a reviewed description.`);
      return [
        key,
        (requiredByPath[path]?.includes(key) ? value : Schema.optionalKey(value)).pipe(
          Schema.annotateKey({
            description,
          }),
        ),
      ];
    }),
  );
  if (!summaries[path]) throw new Error(`Breeze operation ${path} needs a reviewed summary.`);
  const summary =
    summaries[path] +
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

/** Breeze accepts one value per query name; REST-style repeated scalars are not a batch. */
export const admit = (url: URL): Effect.Effect<void, Refusal> => {
  // The compact vendor index does not preserve string-pattern constraints.
  const limit = url.searchParams.get("limit");
  if (url.pathname === "/api/people" && limit !== null && !new RegExp(PEOPLE_LIMIT_PATTERN).test(limit))
    return Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "invalid_args",
          "Breeze people limit must be a whole decimal count from 0 to 1000; 0 requests all people without paging.",
        ),
      }),
    );
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (seen.has(name))
      return Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "invalid_args",
            `Breeze takes one value for query parameter ${name}; serialize JSON parameters as strings.`,
          ),
        }),
      );
    seen.add(name);
  }
  return Effect.void;
};

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
function bodyDetail(text: string, status: number): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.length > 200) return `Breeze returned HTTP ${status}.`;
  return `Breeze said: ${trimmed}${/[.!?]$/.test(trimmed) ? "" : "."}`;
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
  detail: ({ body, status }) => bodyDetail(typeof body === "string" ? body : "", status),
  meanings: { unknownId: "not_found", provesAbsence: true, conflicts: [] },
  unreadable: "Breeze returned a non-JSON successful response.",
  statuses: {
    401: ({ status }) => ({
      code: "auth_required",
      words: (detail) =>
        `Breeze rejected the configured API key (HTTP ${status}). ${detail} An operator must replace it with the key from this church's Extensions → API page.`,
    }),
    403: ({ status }) => ({
      code: "auth_required",
      words: (detail) =>
        `Breeze rejected the configured API key (HTTP ${status}). ${detail} An operator must replace it with the key from this church's Extensions → API page.`,
    }),
    404: () => ({
      code: "not_found",
      words: () =>
        "Breeze has no such endpoint or record (HTTP 404). Check the path against the API reference, or re-read the id from its list tool.",
    }),
  },
};
export const result = (
  body: unknown,
  answer: { readonly operation: OperationRef },
): Effect.Effect<unknown, HttpFailure, RequestSecrets> => {
  return RequestSecrets.use((secrets) => {
    if (
      body === false &&
      answer.operation.method === "GET" &&
      BREEZE_VERDICTS[`GET ${answer.operation.template}`] === "destructive"
    )
      return Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "connector_call_failed",
            `Breeze answered false to ${answer.operation.template}. Breeze gives no reason; check the target and confirm the ids with their list tools before any fresh call.`,
            { retryable: false },
          ),
        }),
      );
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
