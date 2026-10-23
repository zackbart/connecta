// Cloudflare's pinned REST contracts, confinement, framing and failure semantics.
import { Effect, Option, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import {
  Refusal,
  StatusFailure,
  toConnectorCallError,
  type HttpFailure,
  type VendorErrors,
  type OperationRef,
} from "../../http/errors.js";
import { Budget, Credentials, Classification, Dispatches, Signal, type CallServices } from "../../http/services.js";
import { restSafety, type SafetyOptions } from "../../http/safety.js";
import {
  get,
  post,
  vendor as declareVendor,
  type Connection,
  type ConnectOptions,
  type Operation as KitOperation,
} from "../../http/vendor.js";
import { callMemo, Operation as ContextView } from "../../runtime/call.js";
import type { CredentialTestResult } from "../../types.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import { Integer } from "../../http/json-schema.js";
import { OperationIndex, type Operation, type RestMethod } from "../_shared/rest/operation-index.js";
import type { RestCall, RestFraming, RestPage, RestReadPost, RestResult } from "../_shared/rest/tools.js";
import {
  valueSafety,
  withholdEmbeddedUrlsIn,
  refuseWithheldLinks,
  refuseWithheldUpload,
  refuseWithheldBase64,
} from "../_shared/rest/value-safety.js";
import { CLOUDFLARE_VALUE_SAFETY } from "./safety.js";
import { openapi } from "./openapi.generated.js";
import type { CloudflareOptions } from "./index.js";
import { CLOUDFLARE_API_BASE, type CloudflareRestOptions, type CloudflarePin } from "./lib/config.js";
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Zone-ownership reads a pin check may spend: per tool call, and per five minutes per connector. */
const MAX_LOOKUPS_PER_CALL = 3;
const MAX_LOOKUPS_PER_WINDOW = 60;
const LOOKUP_WINDOW_MS = 300_000;
export const READ_CAP_MS = 60_000;
export const WRITE_STEPS = Object.freeze({ lookup1: "once", lookup2: "once", lookup3: "once", write: "once" } as const);

/**
 * POSTs that only read, admitted by `cloudflare_api_read`, each reviewed
 * against the pinned spec for four disqualifiers: it persists state, it is
 * billed per call or runs a model, it sends traffic outside Cloudflare, or it
 * activates something. Requests that look like reads but are not stay writes:
 * D1 `…/query` and `…/raw` and Durable Object `…/query/v2` run SQL that can
 * write; Workers AI `…/ai/run`, AI Search and AutoRAG search (query rewriting
 * and reranking run billed models), browser rendering, web search and brand
 * logo search run models or fetch the web; monetization "checks" activate an
 * entitlement; flag evaluation is metered; robots.txt bulk reads fetch
 * origins; previews, tests, scans, exports and ownership challenges create
 * state or send traffic; and token or credential POSTs are refused outright
 * (`CLOUDFLARE_VALUE_SAFETY`).
 */
export const READ_POSTS: readonly RestReadPost[] = [
  [
    "POST",
    "/accounts/{account_id}/resource-library/applications/lookup",
    "Looks up application names in a sentence; changes no application or rule.",
  ],
  [
    "POST",
    "/accounts/{account_id}/data-security/posture/finding_types/validate",
    "Checks a candidate finding definition without creating or reserving it.",
  ],
  ["POST", "/accounts/{account_id}/analytics/query/{dataset}/summary", "Analytics query; aggregates only."],
  ["POST", "/accounts/{account_id}/analytics/query/{dataset}/timeseries", "Analytics query; aggregates only."],
  ["POST", "/accounts/{account_id}/analytics/query/{dataset}/top-n", "Analytics query; aggregates only."],
  [
    "POST",
    "/accounts/{account_id}/analytics/query/data-security/content-findings/top-n",
    "Analytics query; aggregates only.",
  ],
  [
    "POST",
    "/accounts/{account_id}/analytics/query/data-security/findings/summary",
    "Analytics query; aggregates only.",
  ],
  [
    "POST",
    "/accounts/{account_id}/analytics/query/data-security/findings/timeseries",
    "Analytics query; aggregates only.",
  ],
  [
    "POST",
    "/accounts/{account_id}/analytics_engine/sql",
    "Analytics Engine SQL is SELECT-only; the body is the query.",
  ],
  ["POST", "/accounts/{account_tag}/analytics/sql", "SQL API over analytics datasets; read-only by contract."],
  ["POST", "/analytics/sql", "SQL API over analytics datasets; read-only by contract."],
  ["POST", "/accounts/{account_id}/logs/explorer/query/sql", "Log Explorer SQL query; reads stored logs."],
  ["POST", "/zones/{zone_id}/logs/explorer/query/sql", "Log Explorer SQL query; reads stored logs."],
  ["POST", "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk/get", "Reads several KV values at once."],
  ["POST", "/accounts/{account_id}/vectorize/v2/indexes/{index_name}/query", "Nearest-vector query; no model runs."],
  ["POST", "/accounts/{account_id}/vectorize/v2/indexes/{index_name}/get_by_ids", "Reads vectors by id."],
  ["POST", "/accounts/{account_id}/workers/observability/telemetry/query", "Runs a telemetry query; saves nothing."],
  ["POST", "/accounts/{account_id}/workers/observability/telemetry/keys", "Lists telemetry keys."],
  ["POST", "/accounts/{account_id}/workers/observability/telemetry/values", "Lists telemetry values."],
  [
    "POST",
    "/accounts/{account_id}/browser-extension/config/logs/extension-events/search",
    "Searches extension event logs.",
  ],
  [
    "POST",
    "/accounts/{account_id}/browser-extension/config/logs/extension-events/timeseries",
    "Extension event aggregates.",
  ],
  ["POST", "/accounts/{account_id}/billable/usage", "Filtered usage read; Cloudflare documents it read-only."],
  ["POST", "/accounts/{account_id}/cloudforce-one/events", "Filters and lists threat events."],
  ["POST", "/accounts/{account_id}/cloudforce-one/requests", "Lists intelligence requests."],
  ["POST", "/accounts/{account_id}/cloudforce-one/requests/priority", "Lists priority intelligence requirements."],
  ["POST", "/accounts/{account_id}/cloudforce-one/requests/{request_id}/asset", "Lists request assets."],
  ["POST", "/accounts/{account_id}/cloudforce-one/requests/{request_id}/message", "Lists request messages."],
  [
    "POST",
    "/accounts/{account_id}/cloudforce-one/v2/brand-protection/takedown-notices/lookup",
    "Looks up takedown notices.",
  ],
  ["POST", "/accounts/{account_id}/cloudforce-one/v2/collections/{collection_id}/search", "Searches collection items."],
  ["POST", "/accounts/{account_id}/cloudforce-one/v2/priority-intelligence/quota", "Reads the PIR quota."],
  ["POST", "/accounts/{account_id}/cloudforce-one/rules/validate", "Validates a rule; stores nothing."],
  ["POST", "/accounts/{account_id}/cloudforce-one/rules/structured/validate", "Validates a rule; stores nothing."],
  ["POST", "/accounts/{account_id}/access/custom_pages/validate", "Validates a page template; stores nothing."],
  ["POST", "/accounts/{account_id}/dlp/patterns/validate", "Validates a regex; stores nothing."],
  ["POST", "/accounts/{account_id}/pipelines/v1/validate_sql", "Validates SQL; stores nothing."],
  ["POST", "/accounts/{account_id}/logpush/validate/origin", "Validates logpull options; stores nothing."],
  ["POST", "/zones/{zone_id}/logpush/validate/origin", "Validates logpull options; stores nothing."],
  ["POST", "/accounts/{account_id}/logpush/transformers/preview", "Stateless transformer preview."],
  ["POST", "/accounts/{account_id}/registrar/domain-check", "Domain availability check."],
  ["POST", "/accounts/{account_id}/registrar/domain-transfer-check", "Transfer eligibility check."],
  ["POST", "/accounts/{account_id}/registrar-sandbox/domain-check", "Domain availability check."],
  ["POST", "/accounts/{account_id}/pay-per-crawl/zones_can_be_enabled/query", "Reads a zone setting."],
  ["POST", "/accounts/{account_id}/ai-gateway/billing/topup/eligibility", "Eligibility check; starts nothing."],
  ["POST", "/accounts/{account_id}/ai-gateway/billing/topup/status", "Reads a payment status."],
  ["POST", "/accounts/{account_id}/request-tracer/trace", "Simulated trace; sends no traffic."],
  ["POST", "/accounts/{account_id}/magic/cloud/resources/policy-preview", "Evaluates a policy against the catalog."],
  ["POST", "/accounts/{account_id}/magic/cloud/onramps/{onramp_id}/export", "Renders Terraform; changes nothing."],
  ["POST", "/zones/{zone_id}/email/sending/subdomains/preview", "Previews DNS records; stores nothing."],
  ["POST", "/zones/{zone_id}/token_validation/rules/preview", "Previews a rule; stores nothing."],
];

/**
 * Operations `cloudflare_api_upload` sends, by method and template: Workers
 * scripts and versions (including Workers for Platforms), KV values, R2
 * objects, Pages deployments, Images, Stream, DNS zone-file import, and
 * Snippets. Other multipart operations are refused rather than guessed at.
 */
export const UPLOADS: ReadonlyArray<readonly [method: string, template: string]> = [
  ["PUT", "/accounts/{account_id}/workers/scripts/{script_name}"],
  ["PUT", "/accounts/{account_id}/workers/scripts/{script_name}/content"],
  ["PATCH", "/accounts/{account_id}/workers/scripts/{script_name}/settings"],
  ["POST", "/accounts/{account_id}/workers/scripts/{script_name}/versions"],
  ["PUT", "/accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}"],
  ["PUT", "/accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/content"],
  ["PATCH", "/accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/settings"],
  ["PUT", "/accounts/{account_id}/workers/services/{service_name}/environments/{environment_name}/content"],
  ["PUT", "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}"],
  ["PUT", "/accounts/{account_id}/r2/buckets/{bucket_name}/objects/{object_key}"],
  ["POST", "/accounts/{account_id}/pages/projects/{project_name}/deployments"],
  ["POST", "/accounts/{account_id}/images/v1"],
  ["POST", "/accounts/{account_id}/stream"],
  ["PUT", "/accounts/{account_id}/stream/{identifier}/captions/{language}"],
  ["POST", "/zones/{zone_id}/dns_records/import"],
  ["PUT", "/zones/{zone_id}/snippets/{snippet_name}"],
];

/**
 * Operations with no account or zone in their path that a pinned connector
 * still admits, each holding to the pin some other way: the identity reads
 * name only the credential's own user, the three lists are filtered to the
 * pin, zone creation must name a pinned account, and the rest is public data.
 * Every other unscoped operation is refused under a pin (default deny).
 */
export const PIN_SAFE_UNSCOPED: ReadonlySet<string> = new Set([
  "GET /user",
  "GET /user/tokens/verify",
  "GET /accounts",
  "GET /zones",
  "POST /zones",
  "GET /memberships",
  "GET /ips",
  // CWS category definitions and filter-builder schema are global catalogs,
  // not account policy, credential, or deployment records.
  "GET /cws/categories/apis",
  "GET /cws/categories/applications",
  "GET /cws/categories/applications/{application_key}/versions",
  "GET /cws/categories/applications/{application_key}/versions/latest",
  "GET /cws/categories/applications/{application_key}/versions/{version_tag}",
  "GET /cws/categories/operations",
  "GET /cws/filter-schema",
  "POST /graphql",
]);

/** Why each family of unscoped operations is refused under a pin; `test` checks every one is covered. */
export const PIN_REFUSED_UNSCOPED: Readonly<Record<string, string>> = {
  accounts: "creates or moves accounts outside the pin",
  analytics: "queries datasets across every account; use POST /accounts/{account_tag}/analytics/sql",
  api: "is an internal health route",
  billing: "is user-level billing",
  certificates: "manages Origin CA certificates across every zone the user holds",
  internal: "is an internal route",
  live: "is an internal health route",
  memberships: "changes or reads one of the user's memberships, which may be another account's",
  oauth: "lists user-level OAuth scopes",
  organizations: "spans several accounts",
  pages: "uses a Pages upload token, not this connector's credential",
  produce: "writes to a pipeline the path does not scope",
  radar: "is not a GET",
  ready: "is an internal health route",
  "signed-url": "is an internal test route",
  subscriptions: "reads or acknowledges a stream the path does not scope",
  tenants: "spans several accounts",
  user: "acts on user-level settings shared by every account",
  workers: "triggers a deploy hook the path does not scope",
  zones: "is not a list or a create",
};

/** Request headers the generic tools accept; both are R2's. */
export const HEADERS: Readonly<Record<string, string>> = {
  "cf-r2-jurisdiction":
    "R2 only: default, eu, us, fedramp, or fedramp-high, for a bucket outside the default jurisdiction.",
  "cf-r2-storage-class": "R2 only: Standard or InfrequentAccess.",
};
const HEADER_VALUES: Readonly<Record<string, readonly string[]>> = {
  "cf-r2-jurisdiction": ["default", "eu", "us", "fedramp", "fedramp-high"],
  "cf-r2-storage-class": ["Standard", "InfrequentAccess"],
};

/** Path parameters whose values may carry an encoded "/": R2 object keys and KV key names. */
const SLASH_PARAMS = ["object_key", "key_name"];

type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

interface EnvelopeError {
  code?: number;
  message?: string;
  error_chain?: EnvelopeError[];
}

function errorsOf(body: unknown): EnvelopeError[] {
  const errors = record(body)["errors"];
  return Array.isArray(errors)
    ? (errors.filter((entry) => typeof entry === "object" && entry !== null) as EnvelopeError[])
    : [];
}

/** Flatten Cloudflare's error array (and any nested chain) into one line. */
export function describeErrors(errors: EnvelopeError[]): string {
  const parts: string[] = [];
  const walk = (list: EnvelopeError[]): void => {
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) {
        parts.push("Unknown error");
        continue;
      }
      const code = typeof entry.code === "number" ? entry.code : undefined;
      const message = typeof entry.message === "string" ? entry.message.slice(0, 500) : "Unknown error";
      parts.push(code === undefined ? message : `${code}: ${message}`);
      if (Array.isArray(entry.error_chain)) walk(entry.error_chain);
    }
  };
  walk(errors.slice(0, 10));
  return parts.length > 0 ? parts.join("; ") : "Cloudflare reported no detail.";
}

function errorCodes(errors: EnvelopeError[]): Set<number> {
  const codes = new Set<number>();
  const walk = (list: EnvelopeError[]): void => {
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      if (typeof entry.code === "number") codes.add(entry.code);
      if (Array.isArray(entry.error_chain)) walk(entry.error_chain);
    }
  };
  walk(errors);
  return codes;
}

/**
 * Credential-shaped Cloudflare error codes that are *not* already implied by a
 * 401 or 403: a missing or malformed `Authorization` header, and the legacy
 * key/email headers. These arrive on HTTP 400, so status alone would misfile
 * them as an argument problem the agent could repair.
 *
 * Deliberately excludes 10000. Cloudflare returns 10000 for "Authentication
 * error" but has also been observed reusing it as a generic validation code,
 * so routing on it would risk telling an agent its token was broken when its
 * arguments were. Genuine 10000 auth failures arrive with 401 or 403.
 *
 * Cloudflare publishes no table mapping codes to causes; these six come from
 * community reports and probing. Prefer `verify_credential` when a diagnosis
 * matters. Cloudflare also rate-limits authentication failures separately
 * (429 with code 10502), one more reason to verify once rather than retry.
 */
const AUTH_ERROR_CODES = new Set([1001, 6003, 6111, 9103, 9106, 9107]);

/**
 * The reviewed value-safety table over the pinned index: refusals, redaction
 * of every successful body, and which operations withhold error text (any
 * reviewed operation, or one whose request accepts a credential, header, or
 * environment value, since a vendor error may echo what was submitted).
 */
export const SAFETY = valueSafety(CLOUDFLARE_VALUE_SAFETY, () => cloudflareIndex);

interface CloudflareFacts {
  readonly [key: string]: readonly number[] | undefined;
  readonly codes: readonly number[];
}
const rejected = ({ status }: { status: number }) => ({
  code: "invalid_args" as const,
  words: (detail: string) => `Cloudflare rejected the request (HTTP ${status}). ${detail}`,
});
const authFailure = ({ status }: { status: number }) => ({
  code: "auth_required" as const,
  words: (detail: string) =>
    `Cloudflare rejected the configured credential (HTTP ${status}). ${detail} An operator must check or replace it in this connection; call verify_credential to confirm.`,
});
export const cloudflareErrors: VendorErrors<CloudflareFacts> = {
  provider: "Cloudflare",
  facts: (body) => ({ codes: [...errorCodes(errorsOf(body))] }),
  headers: ["cf-ray"],
  detail: ({ facts, headers, withheld, body }) => {
    const codes = facts.codes;
    const described = withheld
      ? `${codes.length ? `Cloudflare error code ${codes.join(", ")}.` : "Cloudflare reported an error."} Its text is withheld because this operation handles credentials.`
      : describeErrors(errorsOf(withholdEmbeddedUrlsIn(body)));
    return `${described}${headers["cf-ray"] ? ` Ray ${headers["cf-ray"]}.` : ""}`;
  },
  classify: [
    ({ status, facts }) =>
      status !== 429 && facts.codes.some((code) => AUTH_ERROR_CODES.has(code)) ? authFailure({ status }) : undefined,
  ],
  statuses: {
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: retryAfterMs ?? 300_000,
      words: (detail) =>
        `Cloudflare rate limit reached (HTTP 429). ${detail} The documented limit is 1,200 requests per five minutes per user, counted across the dashboard and every token.`,
    }),
    401: authFailure,
    403: () => ({
      code: "provider_permission_denied",
      words: (detail) =>
        `Cloudflare refused access to this resource (HTTP 403). ${detail} Verify the credential first; if it is valid, the token or user lacks this permission or resource.`,
    }),
    400: rejected,
    409: rejected,
    422: rejected,
    405: rejected,
    415: rejected,
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `Cloudflare found no such resource (HTTP 404). ${detail} Confirm the id with list_zones, list_accounts, or a list read.`,
    }),
    serverError: ({ status }) => ({
      code: "unavailable",
      words: (detail) => `Cloudflare is unavailable (HTTP ${status}). ${detail}`,
    }),
    otherwise: ({ status }) => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) => `Cloudflare request failed (HTTP ${status}). ${detail}`,
    }),
  },
  unreadable: "Cloudflare returned malformed JSON.",
};
function isEnvelope(body: unknown): body is JsonRecord {
  const value = record(body);
  return typeof value["success"] === "boolean" && ("result" in value || "errors" in value);
}

// --- Pins --------------------------------------------------------------------

const ACCOUNT_KEYS = new Set(["account_id", "accountId", "account.id", "account_tag", "accountTag"]);
const ZONE_KEYS = new Set(["zone_id", "zoneId", "zone.id", "zone_tag", "zoneTag"]);

/** Every account and zone id a call names in its path, query, or top-level body. */
function scopeIds(call: RestCall): { accounts: string[]; zones: string[]; template: readonly string[] } {
  const template = call.op.path.slice(1).split("/");
  const accounts: string[] = [];
  const zones: string[] = [];
  template.forEach((part, index) => {
    if (!part.startsWith("{")) return;
    const value = call.params[part.slice(1, -1)];
    if (value === undefined) return;
    if (template[index - 1] === "accounts") accounts.push(decodeURIComponent(value));
    if (template[index - 1] === "zones") zones.push(decodeURIComponent(value));
  });
  const scan = (source: JsonRecord): void => {
    for (const [key, value] of Object.entries(source)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item !== "string") continue;
        if (ACCOUNT_KEYS.has(key)) accounts.push(item);
        if (ZONE_KEYS.has(key)) zones.push(item);
      }
    }
  };
  scan(record(call.query));
  const body = record(call.body);
  scan(body);
  const account = text(record(body["account"])["id"]);
  if (account) accounts.push(account);
  const zone = text(record(body["zone"])["id"]);
  if (zone) zones.push(zone);
  return { accounts, zones, template };
}

// --- Framing -----------------------------------------------------------------

/** A pre-framed upload body, carried through `RestCall.body` to `encode`. */
export class RawUpload {
  constructor(
    readonly body: string | Uint8Array<ArrayBuffer> | FormData,
    readonly contentType: string | undefined,
  ) {}
}

export function bytesFromBase64(value: string, field: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return invalid(`${field} must be valid base64.`);
  }
}

function queryOf(call: RestCall): RestFraming["query"] {
  const query: NonNullable<RestFraming["query"]> = {};
  const scalar = (item: unknown): item is string | number | boolean =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  for (const [name, value] of Object.entries(call.query)) {
    if (value === undefined) continue;
    if (scalar(value) || (Array.isArray(value) && value.every(scalar))) query[name] = value;
    else invalid(`Cloudflare query parameter ${name} takes a string, number, boolean, or a list of them.`);
  }
  return query;
}

// --- The vendor ----------------------------------------------------------------

export const cloudflareIndex = new OperationIndex(openapi, {
  vendor: "cloudflare",
  title: "Cloudflare",
  slashParams: SLASH_PARAMS,
});

export const getUser = get("getUser", "/user", { success: Schema.Unknown });
export const verifyToken = get("verifyToken", "/user/tokens/verify", { success: Schema.Unknown });
export const verifyAccountToken = get("verifyAccountToken", "/accounts/:account_id/tokens/verify", {
  params: { account_id: Schema.String },
  success: Schema.Unknown,
});
const PageQuery = { page: Schema.optionalKey(Integer), per_page: Schema.optionalKey(Integer) };
export const listAccounts = get("listAccounts", "/accounts", {
  query: { ...PageQuery, name: Schema.optionalKey(Schema.String) },
  success: Schema.Unknown,
});
export const listZones = get("listZones", "/zones", {
  query: {
    ...PageQuery,
    name: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
    "account.id": Schema.optionalKey(Schema.String),
  },
  success: Schema.Unknown,
});
export const graphqlQuery = post("graphqlQuery", "/graphql", {
  payload: Schema.Struct({
    query: Schema.String,
    variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    operationName: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    data: Schema.optionalKey(Schema.Unknown),
    errors: Schema.optionalKey(Schema.Union([Schema.Array(Schema.Unknown), Schema.Null])),
  }),
});
const typed = [getUser, verifyToken, verifyAccountToken, listAccounts, listZones] as const;
const indexed = indexedVendor("cloudflare", cloudflareIndex, typed);
const binaryType = (type: string) =>
  type !== "" &&
  !/\bjson\b|\+json\b|\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type) &&
  !/^text\/|\bxml\b|\bcsv\b/.test(type);
export const CloudflareApi = {
  ...indexed,
  api: declareVendor("cloudflare", ...typed, graphqlQuery).api,
  indexed: {
    operations: [...indexed.indexed!.operations, "POST /graphql"].sort(),
    api: () => {
      const rest = Object.values(indexed.indexed!.api().groups["operations"]!.endpoints) as [
        KitOperation,
        ...KitOperation[],
      ];
      return declareVendor("cloudflare", ...rest, graphqlQuery).api;
    },
  },
  textBodies: {
    review:
      "Legacy REST replies use JSON, text/XML/CSV, NDJSON or bounded binary by response media type. Errors remain JSON-only.",
    forResponse: (status: number, _operation: OperationRef, type = "") =>
      status >= 200 &&
      status <= 299 &&
      _operation.flags?.["ownership"] !== true &&
      (!/\bjson\b|\+json\b/.test(type) || /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type))
        ? ("text" as const)
        : undefined,
  },
  binaryBodies: {
    review:
      "Cloudflare's KV/R2 downloads and other legacy binary replies retain bounded bytes with sent-secret checks before encoding.",
    forResponse: (_status: number, operation: OperationRef, type: string) =>
      operation.flags?.["ownership"] !== true && binaryType(type),
  },
};
const canonical = (operation: OperationRef) => operation.template.replace(/\/:([^/]+)/g, "/{$1}");
export const safety = (): SafetyOptions => {
  const reviewed = restSafety(SAFETY, cloudflareIndex);
  return {
    reviewed: {
      ...reviewed,
      resolve: (method, path) =>
        method === "POST" && path === "/graphql" ? { method, template: path } : reviewed.resolve!(method, path),
      redact: (body, operation) =>
        isEnvelope(body)
          ? { ...body, result: SAFETY.redact(body["result"], operation.method, canonical(operation)) }
          : SAFETY.redact(body, operation.method, canonical(operation)),
      withholdsErrors: (operation) =>
        operation.method === "POST" && operation.template === "/graphql" ? false : reviewed.withholdsErrors(operation),
    },
    sensitiveFields: { names: [], choice: "drop" },
  };
};
export const result: NonNullable<ConnectOptions["result"]> = (raw, answer) =>
  Effect.suspend(() => {
    let body = raw;
    if (answer.bodyFormat === "text" && typeof body === "string") {
      const type = (answer.headers.get("content-type") ?? "").toLowerCase();
      body = /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type)
        ? body
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
              try {
                return JSON.parse(line) as unknown;
              } catch {
                return { line };
              }
            })
        : body === ""
          ? null
          : body;
    }
    if (answer.operation.flags?.["ownership"] !== true && isEnvelope(body) && body["success"] === false)
      return Effect.fail(
        new StatusFailure({
          status: answer.status === 200 ? 400 : answer.status,
          headers: answer.headers,
          body,
          operation: answer.operation,
        }),
      );
    return Effect.succeed(body ?? null);
  });
export const authenticate = (options: Readonly<CloudflareOptions>) =>
  Effect.gen(function* () {
    const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
    if (options.auth.type === "globalApiKey") {
      const email = values?.["email"]?.trim(),
        apiKey = values?.["apiKey"]?.trim();
      if (!email || !apiKey)
        return yield* Effect.fail(
          new Refusal({
            error: new ConnectorCallError(
              "auth_required",
              "No Cloudflare Global API Key and account email are configured for this connector. An operator must add both in this connection in the operator UI.",
            ),
          }),
        );
      return { "X-Auth-Email": email, "X-Auth-Key": apiKey };
    }
    const token = values?.["value"]?.trim();
    if (!token)
      return yield* Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "auth_required",
            "No Cloudflare API token is configured for this connector. An operator must add one in this connection in the operator UI.",
          ),
        }),
      );
    return { Authorization: `Bearer ${token}` };
  });
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
const failure = (error: unknown) =>
  error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error);

const runtimes = new WeakMap<Connection, ReturnType<typeof makeRuntime>>();
export function cloudflareRuntime(connection: Connection, options: CloudflareRestOptions) {
  let runtime = runtimes.get(connection);
  if (!runtime) {
    runtime = makeRuntime(connection, options);
    runtimes.set(connection, runtime);
  }
  return runtime;
}
function makeRuntime(connection: Connection, options: CloudflareRestOptions) {
  const operations = cloudflareIndex;
  const { auth, pin } = options;
  const pinnedAccounts = pin?.accountIds ? new Set(pin.accountIds) : undefined;
  const pinnedZones = pin?.zoneIds ? new Set(pin.zoneIds) : undefined;
  // --- Pin enforcement (default deny) ---------------------------------------
  /** Zone id → owning account id, learned from a GET /zones/{id} read or a zone list. */
  const owners = new Map<string, string>();
  /** Times of internal ownership reads, bounded per rolling window. */
  const lookups: number[] = [];
  const lookupKey = {};
  const pinRefusal = (what: string): never => {
    throw new ConnectorCallError(
      "provider_permission_denied",
      `${what} is outside this connector's pin. The deployment pins it to ${[
        pinnedAccounts ? `accounts ${[...pinnedAccounts].join(", ")}` : "",
        pinnedZones ? `zones ${[...pinnedZones].join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" and ")}; a different account or zone needs its own connector.`,
      { retryable: false },
    );
  };
  const assertAccount = (account: string): void => {
    if (!pinnedAccounts?.has(account)) pinRefusal(`Account ${account}`);
  };
  /**
   * Charge one internal ownership read: at most `MAX_LOOKUPS_PER_CALL` per
   * tool call and `MAX_LOOKUPS_PER_WINDOW` per five minutes per connector, so
   * one call cannot spend the user's shared request limit on pin checks.
   */
  const chargeLookup = (ctx: NonNullable<import("../../types.js").ConnectorContext>): number => {
    const state = callMemo(ctx, lookupKey, () => ({ used: 0 }));
    const used = state.used;
    if (used >= MAX_LOOKUPS_PER_CALL) {
      throw new ConnectorCallError(
        "invalid_args",
        `This call names more than ${MAX_LOOKUPS_PER_CALL} zones whose account the pin must check. Name fewer zones per call, or list them in pin.zoneIds.`,
      );
    }
    const now = Date.now();
    while (lookups.length > 0 && lookups[0]! <= now - LOOKUP_WINDOW_MS) lookups.shift();
    if (lookups.length >= MAX_LOOKUPS_PER_WINDOW) {
      throw new ConnectorCallError(
        "rate_limited",
        "This connector's zone-ownership checks reached their per-window budget.",
        { retryAfterMs: Math.max(1_000, lookups[0]! + LOOKUP_WINDOW_MS - now) },
      );
    }
    lookups.push(now);
    state.used = used + 1;
    return state.used;
  };

  const assertZone = (zone: string): Effect.Effect<void, HttpFailure, CallServices> =>
    Effect.gen(function* () {
      if (pinnedZones?.has(zone)) return;
      yield* checked(() => {
        if (!pinnedAccounts) pinRefusal(`Zone ${zone}`);
      });
      let owner = owners.get(zone);
      if (owner === undefined) {
        const view = yield* Effect.serviceOption(ContextView);
        const ctx = Option.isSome(view) ? view.value : undefined;
        const lookup = yield* checked(() => {
          if (!ctx) throw new Error("Ownership lookup has no call context.");
          return chargeLookup(ctx);
        });
        yield* (yield* Budget).charge.pipe(Effect.catch(failure));
        const reply = yield* connection
          .sendPath(
            { method: "GET", path: `/zones/${encodeURIComponent(zone)}`, template: "/zones/{zone_id}" },
            { effect: "read", step: `lookup${lookup}`, flags: { ownership: true } },
          )
          .pipe(
            Effect.catch((error): Effect.Effect<{ status: number; data: unknown }, HttpFailure, CallServices> => {
              if (error._tag === "UnreadableBody") return Effect.succeed({ status: 200, data: undefined });
              if (error._tag !== "ResponseTooLarge") return Effect.fail(error);
              return Dispatches.use((dispatches) => {
                const own = dispatches.filter((dispatch) => dispatch.operation?.flags?.["ownership"] === true).at(-1);
                const length = Number(own?.headers?.get("content-length"));
                // Legacy pin reads swallowed a streamed-body decode failure, but not a declared ceiling.
                return own?.status === 200 && !(length > MAX_RESPONSE_BYTES)
                  ? Effect.succeed({ status: 200, data: undefined })
                  : Effect.fail(error);
              });
            }),
          );
        owner = text(record(record(record(reply.data)["result"])["account"])["id"]) ?? "";
        if (owner) owners.set(zone, owner);
      }
      yield* checked(() => {
        if (!owner || !pinnedAccounts?.has(owner)) pinRefusal(`Zone ${zone}`);
      });
    });
  const admit = (call: RestCall) =>
    Effect.gen(function* () {
      if (
        call.method !== "GET" &&
        call.method !== "HEAD" &&
        !READ_POSTS.some(([method, path]) => method === call.method && path === call.op.path)
      ) {
        yield* checked(() => refuseWithheldLinks([call.query, call.path], "Cloudflare"));
        if (call.body instanceof RawUpload)
          yield* attempt(() => refuseWithheldUpload((call.body as RawUpload).body, "Cloudflare"));
        else yield* checked(() => refuseWithheldLinks(call.body, "Cloudflare"));
        if (
          call.method === "PUT" &&
          call.op.path === "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk" &&
          Array.isArray(call.body)
        ) {
          for (const entry of call.body)
            if (record(entry)["base64"] === true)
              yield* attempt(() => refuseWithheldBase64(record(entry)["value"], "Cloudflare", 25 * 1024 * 1024));
        }
      }
      if (!pin) return;
      const { accounts, zones, template } = scopeIds(call);
      yield* checked(() => {
        const scoped = template.some(
          (part, index) =>
            part.startsWith("{") && (template[index - 1] === "accounts" || template[index - 1] === "zones"),
        );
        if (!scoped) {
          const key = `${call.op.method} ${call.op.path}`;
          if (!PIN_SAFE_UNSCOPED.has(key) && !(call.op.method === "GET" && template[0] === "radar")) {
            const reason = PIN_REFUSED_UNSCOPED[template[0] ?? ""] ?? "names no account or zone this pin can verify";
            throw new ConnectorCallError(
              "provider_permission_denied",
              `${key} ${reason}, so a pinned connector refuses it.`,
              { retryable: false },
            );
          }
          if (key === "POST /zones") {
            const account = text(record(record(call.body)["account"])["id"]);
            if (!account) invalid("A pinned connector creates a zone only in a pinned account: set body.account.id.");
            assertAccount(account);
          }
        }
        for (const account of accounts) assertAccount(account);
      });
      for (const zone of zones) yield* assertZone(zone);
    });
  /** A pinned connector's account and zone lists show only what the pin admits. */
  const filterListed = (op: Operation, result: unknown): unknown => {
    if (!pin || op.method !== "GET" || !Array.isArray(result)) return result;
    if (op.path === "/accounts") return result.filter((item) => pinnedAccounts?.has(String(record(item)["id"])));
    if (op.path === "/memberships") {
      return result.filter((item) => pinnedAccounts?.has(String(record(record(item)["account"])["id"])));
    }
    if (op.path === "/zones") {
      return result.filter((item) => {
        const zone = record(item);
        const id = String(zone["id"]);
        const account = String(record(zone["account"])["id"]);
        if (account && id) owners.set(id, account);
        return pinnedZones?.has(id) || pinnedAccounts?.has(account);
      });
    }
    return result;
  };

  // --- Framing ---------------------------------------------------------------
  const encode = (call: RestCall): RestFraming => {
    const query = queryOf(call);
    const headers: Record<string, string> = { ...call.headers };
    if (call.body instanceof RawUpload) {
      if (call.body.contentType) headers["Content-Type"] = call.body.contentType;
      return { query, headers, rawBody: call.body.body };
    }
    if (call.body === undefined) return { query, headers };
    const type = (operations.bodyType(call.op) ?? "application/json").toLowerCase();
    if (/^text\/|javascript/.test(type)) {
      if (typeof call.body !== "string")
        invalid(`${call.op.method} ${call.op.path} takes a ${type} body: send it as a string.`);
      return { query, headers: { ...headers, "Content-Type": type }, rawBody: call.body };
    }
    if (/ndjson|jsonl/.test(type)) {
      const lines =
        typeof call.body === "string"
          ? call.body
          : Array.isArray(call.body)
            ? call.body.map((item) => JSON.stringify(item)).join("\n")
            : invalid(`${call.op.method} ${call.op.path} takes newline-delimited JSON: send a list of objects.`);
      return { query, headers: { ...headers, "Content-Type": type }, rawBody: lines };
    }
    if (type === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(record(call.body))) {
        if (value !== undefined && value !== null)
          form.append(name, typeof value === "string" ? value : JSON.stringify(value));
      }
      return { query, headers: { ...headers, "Content-Type": type }, rawBody: form.toString() };
    }
    if (typeof call.body === "string") invalid(`${call.op.method} ${call.op.path} takes a JSON body, not a string.`);
    if (type.endsWith("+json"))
      return { query, headers: { ...headers, "Content-Type": type }, rawBody: JSON.stringify(call.body) };
    return { query, headers, body: call.body };
  };

  /** Fill configured default ids into `{account_id}` and `{zone_id}` placeholders. */
  const fillDefaults = (path: string): string => {
    if (!options.accountId && !options.zoneId) return path;
    const parts = path.split("/");
    return parts
      .map((part, position) => {
        const previous = parts[position - 1];
        if (options.accountId && previous === "accounts" && /^\{(account_id|account_tag|accountId)\}$/.test(part)) {
          return encodeURIComponent(options.accountId);
        }
        if (options.zoneId && previous === "zones" && /^\{(zone_id|zone_identifier|zoneId)\}$/.test(part)) {
          return encodeURIComponent(options.zoneId);
        }
        return part;
      })
      .join("/");
  };

  const scope = (call: RestCall): RestCall => {
    // NDJSON operations take a list of records; frame it before validation,
    // so the index checks the string the vendor receives.
    const type = (operations.bodyType(call.op) ?? "").toLowerCase();
    if (/ndjson|jsonl/.test(type) && Array.isArray(call.body)) {
      if (!call.body.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
        invalid(`${call.op.method} ${call.op.path} takes newline-delimited JSON: send a list of objects.`);
      }
      call = { ...call, body: call.body.map((item) => JSON.stringify(item)).join("\n") };
    }
    for (const [name, value] of Object.entries(call.headers ?? {})) {
      if (!/^\/accounts\/\{[^/]+\}\/r2\//.test(call.op.path)) {
        invalid(`${name} applies only to R2 operations under /accounts/{account_id}/r2/.`);
      }
      if (!HEADER_VALUES[name]?.includes(value)) {
        invalid(`${name} must be one of ${HEADER_VALUES[name]?.join(", ") ?? "its documented values"}.`);
      }
    }
    return call;
  };

  /** Argument- and auth-dependent refusals; the table's own run in the generic tools. */
  const refuse = (call: RestCall): string | undefined => {
    const { method, op } = call;
    if (method === "GET") return undefined;
    if (auth === "globalApiKey" && /^\/(?:user|memberships)(?:\/|$)/.test(op.path)) {
      return "A Global API Key connector never writes user-level settings or memberships: the key is the user's own identity. Make that change in the Cloudflare dashboard.";
    }
    return undefined;
  };

  /** Next page: page numbers from result_info, or a cursor. */
  const page = (body: unknown, call: RestCall): RestPage | undefined => {
    if (!isEnvelope(body)) return undefined;
    const info = record(body["result_info"]);
    if (Object.keys(info).length === 0) return undefined;
    const rawCursor = text(info["cursor"]) ?? text(record(info["cursors"])["after"]);
    // Never echo or offer a modified cursor: it would not address the next page.
    const cursor = rawCursor === undefined || withholdEmbeddedUrlsIn(rawCursor) === rawCursor ? rawCursor : undefined;
    if (cursor !== undefined || "cursor" in info || "cursors" in info) {
      const accepted = operations.contract(call.op).parameters.map((parameter) => parameter.name);
      const param = accepted.includes("cursor") ? "cursor" : accepted.includes("after") ? "after" : "cursor";
      const truncated = info["is_truncated"];
      const hasMore = cursor !== undefined && truncated !== false && truncated !== "false";
      return { hasMore, ...(hasMore ? { next: cursor, param } : {}) };
    }
    const current = typeof info["page"] === "number" ? info["page"] : undefined;
    if (current === undefined) return undefined;
    const perPage = typeof info["per_page"] === "number" ? info["per_page"] : 0;
    const totalPages = typeof info["total_pages"] === "number" ? info["total_pages"] : undefined;
    const totalCount = typeof info["total_count"] === "number" ? info["total_count"] : undefined;
    const count = typeof info["count"] === "number" ? info["count"] : 0;
    const hasMore =
      totalPages !== undefined
        ? current < totalPages
        : totalCount !== undefined
          ? current * perPage < totalCount
          : perPage > 0 && count >= perPage;
    return { hasMore, ...(hasMore ? { next: String(current + 1), param: "page" } : {}) };
  };

  const checkServer = (server: string | undefined) =>
    server === undefined ? undefined : `This operation is served from ${server}, which this connector does not reach.`;
  const call = (
    method: RestMethod,
    path: string,
    input: { query?: JsonRecord; body?: unknown; headers?: Record<string, string> } = {},
  ): RestCall => {
    path = fillDefaults(path);
    const { op, params } = operations.resolve(method, path);
    return scope({
      method,
      path,
      op,
      params,
      query: input.query ?? {},
      body: input.body,
      ...(input.headers ? { headers: input.headers } : {}),
    });
  };
  const send = (call: RestCall): Effect.Effect<RestResult, HttpFailure, CallServices> =>
    checked(() => {
      const refusal = checkServer(call.op.server);
      if (refusal) invalid(refusal);
    }).pipe(
      Effect.andThen(admit(call)),
      Effect.andThen(
        checked(() => {
          const framing = call.op.path === "/graphql" ? { body: call.body } : encode(call);
          const query = Object.entries(framing.query ?? {}).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).map((value) => [name, String(value)] as const),
          );
          return {
            method: call.method,
            path: call.path,
            template: call.op.path,
            query,
            ...(framing.headers
              ? {
                  headers: Object.fromEntries(
                    Object.entries(framing.headers).filter(
                      (entry): entry is [string, string] => entry[1] !== undefined,
                    ),
                  ),
                }
              : {}),
            ...(framing.rawBody !== undefined
              ? { rawBody: framing.rawBody as RawUpload["body"] }
              : framing.body !== undefined
                ? { json: JSON.stringify(framing.body) }
                : {}),
          };
        }),
      ),
      Effect.flatMap((request) => connection.sendPath(request)),
      Effect.map((reply) => {
        const body = reply.data;
        const data = isEnvelope(body) ? filterListed(call.op, body["result"]) : body;
        const next = call.op.path === "/graphql" ? undefined : page(body, call);
        return { status: reply.status, data, ...(next ? { page: next } : {}) };
      }),
    );
  const read = (method: RestMethod, path: string, input: Parameters<typeof call>[2] = {}) =>
    checked(() => call(method, path, input)).pipe(Effect.flatMap(send));
  const verify = (): Effect.Effect<JsonRecord, HttpFailure, CallServices> => {
    if (auth === "globalApiKey")
      return read("GET", "/user").pipe(
        Effect.map(({ data }) => {
          const user = record(data);
          return { auth, status: "active", id: user["id"] ?? null, email: user["email"] ?? null, scope: "user" };
        }),
      );
    return read("GET", "/user/tokens/verify").pipe(
      Effect.map(({ data }) => {
        const token = record(data);
        return {
          auth,
          status: token["status"] ?? null,
          id: token["id"] ?? null,
          expiresOn: token["expires_on"] ?? null,
          scope: "user",
        } as JsonRecord;
      }),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const account = options.accountId ?? (pin?.accountIds?.length === 1 ? pin.accountIds[0] : undefined);
          const mapped = toConnectorCallError(error, cloudflareErrors, {
            classification: yield* Classification,
            dispatches: yield* Dispatches,
            withholds: connection.safety.withholdsErrors,
            signal: yield* Signal,
          });
          if (!account || mapped.code !== "auth_required") return yield* Effect.fail(error);
          const { data } = yield* read("GET", `/accounts/${encodeURIComponent(account)}/tokens/verify`);
          const token = record(data);
          return {
            auth,
            status: token["status"] ?? null,
            id: token["id"] ?? null,
            expiresOn: token["expires_on"] ?? null,
            scope: "account",
            accountId: account,
          };
        }),
      ),
    );
  };
  return { send, read, call, verify, assertAccount, assertZone, refuse, fillDefaults, scope, checkServer };
}
export function describeProbe(data: unknown, options: Readonly<CloudflareOptions>): CredentialTestResult {
  const verified = record(data);
  if (options.auth.type === "globalApiKey")
    return { ok: true, message: `Global API Key verified for ${String(verified["email"])}.` };
  return verified["status"] === "active"
    ? {
        ok: true,
        message: `Token verified: active${verified["scope"] === "account" ? ` (account token for ${String(verified["accountId"])})` : ""}.`,
      }
    : { ok: false, message: `Token status is "${String(verified["status"])}".` };
}

function idsOf(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw new Error(`${path} must be a non-empty list of ids.`);
  }
  return value.map((item: string) => item.trim());
}

function optionalId(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || /[/?#\s]/.test(value.trim())) {
    throw new Error(`${path} must be a Cloudflare id.`);
  }
  return value.trim();
}

/** Normalized construction-only routing and confinement settings. */
export function settings(options: Readonly<CloudflareOptions>): CloudflareRestOptions {
  const auth = options.auth.type;
  if (auth !== "apiToken" && auth !== "globalApiKey")
    throw new Error(
      "remoteMcp() with ConnectaConfig.classification for hosted MCP connections; use a distinct id beside the API connector.",
    );
  const maxConcurrency = options.maxConcurrency ?? 6;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer.`);
  }
  let pin: CloudflarePin | undefined;
  if (options.pin !== undefined) {
    const accountIds = idsOf(options.pin.accountIds, "pin.accountIds");
    const zoneIds = idsOf(options.pin.zoneIds, "pin.zoneIds");
    if (!accountIds && !zoneIds) throw new Error(`pin names accountIds, zoneIds, or both.`);
    pin = {
      ...(accountIds ? { accountIds } : {}),
      ...(zoneIds ? { zoneIds } : {}),
    };
  }
  if (auth === "globalApiKey") {
    const unpinned = (options as Extract<CloudflareOptions, { auth: { type: "globalApiKey" } }>).unpinned;
    if (unpinned !== undefined && unpinned !== true) {
      throw new Error(`unpinned must be true when set.`);
    }
    if (pin && unpinned) throw new Error(`takes pin or unpinned: true, not both.`);
    if (!pin && !unpinned) {
      throw new Error(
        `requires pin: { accountIds, zoneIds } with globalApiKey auth, or unpinned: true: a Global API Key reaches every account and zone its user can.`,
      );
    }
  }
  const accountId = optionalId(options.accountId, "accountId");
  const zoneId = optionalId(options.zoneId, "zoneId");
  if (pin && accountId && pin.accountIds && !pin.accountIds.includes(accountId)) {
    throw new Error(`accountId ${accountId} is outside its pin.`);
  }
  if (pin && zoneId && pin.zoneIds && !pin.accountIds && !pin.zoneIds.includes(zoneId)) {
    throw new Error(`zoneId ${zoneId} is outside its pin.`);
  }
  return { auth, baseUrl: options.baseUrl?.trim() || CLOUDFLARE_API_BASE, accountId, zoneId, pin };
}
