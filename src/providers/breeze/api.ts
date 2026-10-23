// Breeze's reviewed GET-only vendor. HTTP methods do not establish safety: see tools.ts.
import { type Context, Effect, Schema } from "effect";
import { ConnectorCallError, resendAdvice } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors, type OperationRef } from "../../http/errors.js";
import { Credentials, RequestSecrets } from "../../http/services.js";
import { get, vendor, type Vendor } from "../../http/vendor.js";
import type { SafetyOptions } from "../../http/safety.js";
import { openapi } from "./openapi.generated.js";
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;
export const BREEZE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LEGACY_HATCH = { legacyHatch: true } as const;
export type JsonRecord = Record<string, any>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- The read hatch's allowlist ----------------------------------------------

/**
 * Every read endpoint `breeze_api_get` may reach, with the query parameter
 * names each one documents. Paths are relative to `/api`, lowercase, exact;
 * `/people/{id}` is the one templated row and accepts digits only, so it can
 * never spell `/people/add` or `/people/delete`. Rows are added here only
 * after a reviewer has read the endpoint as observational.
 */
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
 * returns them, any more than `list_calendars` does.
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

export function readEndpointFor(path: string): readonly string[] {
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

export function queryPairs(value: unknown): Record<string, QueryValue> {
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
    query[name] = item !== null && typeof item === "object" ? JSON.stringify(item) : item;
  }
  return query;
}

// --- Projections -------------------------------------------------------------

// This reviewed HTML conversion records every documented operation plus the
// archival giving routes. It is evidence, not permission to call a path as a read.
const details = JSON.parse(openapi.details) as { o: Array<0 | [Array<[string, string, number]>, unknown]> };
const declared = openapi.ops.map(([, path, name], row) => {
  const params = Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map((match) => [match[1]!, Schema.String]));
  const fields = details.o[row];
  const query = Object.fromEntries(
    (fields === 0 || !fields ? [] : fields[0])
      .filter(([, at]) => at === "query")
      .map(([name]) => [name, Schema.optionalKey(Schema.String)]),
  );
  return get(name, path.replace(/\{([^}]+)\}/g, ":$1") as `/${string}`, { params, query, success: Schema.Unknown });
});
export const BreezeApi: Vendor = {
  ...vendor("Breeze", declared[0]!, ...declared.slice(1)),
  textBodies: {
    review:
      "Breeze error responses are short text or HTML, not a JSON contract. Only legacy hatches admit non-JSON successes; named tools still require JSON.",
    forResponse: (status, operation) =>
      status < 200 || status > 299 ? "text" : operation.flags?.["legacyHatch"] === true ? "json-or-text" : undefined,
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
  provider: "Breeze",
  facts: () => ({}),
  detail: ({ body }) => bodyDetail(typeof body === "string" ? body : ""),
  unreadable: "Breeze returned a non-JSON successful response.",
  statuses: {
    400: ({ status }) => ({
      code: "invalid_args",
      words: (detail) => `Breeze rejected the request (HTTP ${status}).${detail}`,
    }),
    422: ({ status }) => ({
      code: "invalid_args",
      words: (detail) => `Breeze rejected the request (HTTP ${status}).${detail}`,
    }),
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
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs,
      words: (detail) => `Breeze is throttling requests (HTTP 429).${detail} Breeze publishes no limit.`,
      advice: "; slow the fan-out before retrying",
    }),
    serverError: ({ status, retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs,
      words: () => `Breeze is failing upstream (HTTP ${status}).`,
    }),
    otherwise: ({ status }) => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) => `Breeze request failed (HTTP ${status}).${detail}`,
    }),
  },
};
export const result = (
  body: unknown,
  answer: { readonly bodyFormat: "json" | "text" | "empty" },
): Effect.Effect<unknown, HttpFailure, RequestSecrets> => {
  // Legacy hatches returned null for a blank response, but kept a JSON string even when blank.
  if (answer.bodyFormat === "text" && typeof body === "string" && !body.trim()) return Effect.succeed(null);
  return RequestSecrets.use((secrets) => {
    const failure = reportedFailure(body, secrets);
    return failure ? Effect.fail(new Refusal({ error: failure })) : Effect.succeed(body ?? null);
  });
};

// The only documented capability-bearing response values are calendar feeds.
// Raw results and both hatches pass through this same drop. Unindexed paths
// remain available exclusively through the explicitly destructive legacy hatch.
export const breezeSafety: SafetyOptions = {
  review:
    "Breeze's legacy destructive hatch admits unindexed confined paths. The reviewed reference exposes no stored credential values outside calendar feed addresses and embed keys, which are dropped on every result path. Unknown paths never become reads.",
  reviewed: {
    resolve: (method, path): OperationRef => ({
      method,
      template: /^\/people\/\d+$/.test(path) ? "/people/:PERSON_ID" : path,
    }),
    redact: (body, op) => withoutCalendarFeeds(op.template, body),
    withholdsErrors: () => false,
  },
  sensitiveFields: { names: [], choice: "drop" },
};
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
  // The kit redacted the answer's values; shortText cuts serialized JSON, so its keys are
  // checked too before the cut (#703).
  const reported = secrets.redact(root);
  const message =
    shortText(reported["errorMessage"]) ??
    shortText(reported["message"]) ??
    shortText(reported["errors"]) ??
    shortText(reported["errorCode"]) ??
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
