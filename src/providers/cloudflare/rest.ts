// Cloudflare's configuration of the shared REST connector: API-token and
// Global API Key authentication, the v4 envelope, account/zone defaults and
// pins, reviewed read-only POSTs and refusals, two pagination shapes, and the
// named tools (credential check, accounts, zones, GraphQL analytics, uploads).
import type { ApiTool } from "../../connectors/api-connector.js";
import { retryAfterMs, type GuardedTransport } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext, CredentialTestResult, JsonSchema } from "../../types.js";
import type { Operation } from "../_shared/rest/operation-index.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import {
  callRest,
  restCall,
  restTransport,
  type RestCall,
  type RestFraming,
  type RestPage,
  type RestReadPost,
  type RestVendor,
} from "../_shared/rest/tools.js";
import { inspectGraphqlQuery } from "./graphql.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { CLOUDFLARE_VALUE_SAFETY } from "./value-safety.js";
import { openapi } from "./openapi.generated.js";

/** Cloudflare's v4 REST base. Override only for a proxy or a test double. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** The two key schemes Cloudflare's v4 API accepts. */
export type CloudflareKeyAuth = "apiToken" | "globalApiKey";

/** Accounts and zones a connector may touch; everything else is refused. */
export interface CloudflarePin {
  accountIds?: readonly string[];
  zoneIds?: readonly string[];
}

export interface CloudflareRestOptions {
  auth: CloudflareKeyAuth;
  baseUrl: string;
  accountId: string | undefined;
  zoneId: string | undefined;
  pin: CloudflarePin | undefined;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Zone-ownership reads a pin check may spend: per tool call, and per five minutes per connector. */
const MAX_LOOKUPS_PER_CALL = 3;
const MAX_LOOKUPS_PER_WINDOW = 60;
const LOOKUP_WINDOW_MS = 300_000;
const READ_CAP_MS = 60_000;

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
const READ_POSTS: readonly RestReadPost[] = [
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
const UPLOADS: ReadonlyArray<readonly [method: string, template: string]> = [
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
const HEADERS: Readonly<Record<string, string>> = {
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

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

// --- Envelope and failures ---------------------------------------------------

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
function describeErrors(errors: EnvelopeError[]): string {
  const parts: string[] = [];
  const walk = (list: EnvelopeError[]): void => {
    for (const entry of list) {
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
const SAFETY = valueSafety(CLOUDFLARE_VALUE_SAFETY, () => cloudflareIndex());

/**
 * Map a failed Cloudflare response by the caller's next move (H11). For an
 * operation in a reviewed secret family the vendor's error text is withheld
 * (it may echo a submitted secret); the status and numeric codes still route.
 */
function failureFor(status: number, headers: Headers, body: unknown, call?: RestCall): ConnectorCallError {
  const errors = errorsOf(body);
  const ray = headers.get("cf-ray");
  const codes = errorCodes(errors);
  const withheld = call !== undefined && SAFETY.withholdsErrors(call.op);
  const described = withheld
    ? `${codes.size ? `Cloudflare error code ${[...codes].join(", ")}.` : "Cloudflare reported an error."} Its text is withheld because this operation handles credentials.`
    : describeErrors(errors);
  const detail = `${described}${ray ? ` Ray ${ray}.` : ""}`;
  // 429 before the authentication codes: Cloudflare reuses 10000 on throttled
  // responses, and reading a rate limit as an auth failure would tell an
  // agent to stop when it should wait.
  if (status === 429) {
    return new ConnectorCallError(
      "rate_limited",
      `Cloudflare rate limit reached (HTTP 429). ${detail} The documented limit is 1,200 requests per five minutes per user, counted across the dashboard and every token.`,
      // Cloudflare blocks the rest of the five-minute window when the global
      // limit trips, so without Retry-After the honest wait is the window.
      { retryAfterMs: retryAfterMs(headers) ?? 300_000 },
    );
  }
  if (status === 401 || [...codes].some((code) => AUTH_ERROR_CODES.has(code))) {
    return new ConnectorCallError(
      "auth_required",
      `Cloudflare rejected the configured credential (HTTP ${status}). ${detail} An operator must check or replace it in this connection; call verify_credential to confirm.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `Cloudflare refused access to this resource (HTTP 403). ${detail} Verify the credential first; if it is valid, the token or user lacks this permission or resource.`,
    );
  }
  if (status === 400 || status === 409 || status === 422 || status === 405 || status === 415) {
    return new ConnectorCallError("invalid_args", `Cloudflare rejected the request (HTTP ${status}). ${detail}`);
  }
  // Cloudflare refuses a credential that may not touch a resource with 401
  // or 403, so a 404 is a real absence an agent can act on.
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `Cloudflare found no such resource (HTTP 404). ${detail} Confirm the id with list_zones, list_accounts, or a list read.`,
    );
  }
  if (status >= 500) {
    return new ConnectorCallError("unavailable", `Cloudflare is unavailable (HTTP ${status}). ${detail}`);
  }
  return new ConnectorCallError("connector_call_failed", `Cloudflare request failed (HTTP ${status}). ${detail}`, {
    retryable: false,
  });
}

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
class RawUpload {
  constructor(
    readonly body: BodyInit,
    readonly contentType: string | undefined,
  ) {}
}

function bytesFromBase64(value: string, field: string): Uint8Array<ArrayBuffer> {
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

/** The pinned index, shared by every Cloudflare REST connector in the deployment. */
let index: OperationIndex | undefined;

function cloudflareIndex(): OperationIndex {
  index ??= new OperationIndex(openapi, { vendor: "cloudflare", title: "Cloudflare", slashParams: SLASH_PARAMS });
  return index;
}

export interface CloudflareRest {
  vendor: RestVendor;
  tools: ApiTool[];
  testCredential(value: string, ctx: ConnectorContext): Promise<CredentialTestResult>;
  testCredentials(values: Record<string, string>, ctx: ConnectorContext): Promise<CredentialTestResult>;
}

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  description: "Pass next as the param query argument for the following page.",
  properties: {
    hasMore: { type: "boolean", description: "Whether another page exists." },
    next: { type: "string", description: "The next page number or cursor." },
    param: { type: "string", description: "The query parameter that takes next." },
  },
  required: ["hasMore"],
};

const PAGING_INPUT: Record<string, JsonSchema> = {
  page: { type: "integer", minimum: 1, maximum: 10_000, description: "Page number; default 1." },
  perPage: {
    type: "integer",
    minimum: 5,
    maximum: 50,
    description: "Results per page; default 20, Cloudflare's max 50.",
  },
};

function closed(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Cloudflare's REST vendor, its named tools, and its credential tests. */
export function cloudflareRest(options: CloudflareRestOptions): CloudflareRest {
  const operations = cloudflareIndex();
  const { auth, pin } = options;
  const pinnedAccounts = pin?.accountIds ? new Set(pin.accountIds) : undefined;
  const pinnedZones = pin?.zoneIds ? new Set(pin.zoneIds) : undefined;
  const send: GuardedTransport = restTransport({
    provider: "Cloudflare",
    baseUrl: options.baseUrl,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: READ_CAP_MS,
    authenticate: async (ctx) => {
      if (auth === "globalApiKey") {
        const values = await ctx.credential?.getAll();
        const email = values?.["email"]?.trim();
        const apiKey = values?.["apiKey"]?.trim();
        if (!email || !apiKey) {
          throw new ConnectorCallError(
            "auth_required",
            "No Cloudflare Global API Key and account email are configured for this connector. An operator must add both in this connection in the operator UI.",
          );
        }
        return { "X-Auth-Email": email, "X-Auth-Key": apiKey };
      }
      const token = (await ctx.credential?.get())?.trim();
      if (!token) {
        throw new ConnectorCallError(
          "auth_required",
          "No Cloudflare API token is configured for this connector. An operator must add one in this connection in the operator UI.",
        );
      }
      return { Authorization: `Bearer ${token}` };
    },
  });

  // --- Pin enforcement (default deny) ---------------------------------------
  /** Zone id → owning account id, learned from a GET /zones/{id} read or a zone list. */
  const owners = new Map<string, string>();
  /** Times of internal ownership reads, bounded per rolling window. */
  const lookups: number[] = [];
  const lookupsPerCall = new WeakMap<ConnectorContext, number>();
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
  const chargeLookup = (ctx: ConnectorContext): void => {
    const used = lookupsPerCall.get(ctx) ?? 0;
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
    lookupsPerCall.set(ctx, used + 1);
  };
  const assertZone = async (zone: string, ctx: ConnectorContext): Promise<void> => {
    if (pinnedZones?.has(zone)) return;
    if (!pinnedAccounts) pinRefusal(`Zone ${zone}`);
    let owner = owners.get(zone);
    if (owner === undefined) {
      chargeLookup(ctx);
      owner = await send({ method: "GET", path: `/zones/${encodeURIComponent(zone)}` }, ctx, async (response) => {
        const body = await response.jsonResult().catch(() => ({ value: undefined }));
        const value = "value" in body ? body.value : undefined;
        if (!response.ok) throw failureFor(response.status, response.headers, value);
        return text(record(record(record(value)["result"])["account"])["id"]) ?? "";
      });
      if (owner) owners.set(zone, owner);
    }
    if (!owner || !pinnedAccounts?.has(owner)) pinRefusal(`Zone ${zone}`);
  };
  /**
   * Under a pin, an operation is admitted only if every account and zone it
   * names is pinned (zones by verified ownership), and an operation that names
   * neither is admitted only from the reviewed `PIN_SAFE_UNSCOPED` set.
   */
  const admit = async (call: RestCall, ctx: ConnectorContext): Promise<void> => {
    if (!pin) return;
    const { accounts, zones, template } = scopeIds(call);
    const scoped = template.some(
      (part, index) => part.startsWith("{") && (template[index - 1] === "accounts" || template[index - 1] === "zones"),
    );
    if (!scoped) {
      const key = `${call.op.method} ${call.op.path}`;
      const radar = call.op.method === "GET" && template[0] === "radar";
      if (!PIN_SAFE_UNSCOPED.has(key) && !radar) {
        const reason = PIN_REFUSED_UNSCOPED[template[0] ?? ""] ?? "names no account or zone this pin can verify";
        throw new ConnectorCallError(
          "provider_permission_denied",
          `${key} ${reason}, so a pinned connector refuses it.`,
          { retryable: false },
        );
      }
      if (key === "POST /zones") {
        // Cloudflare places the zone by body.account.id alone; other spellings are ignored.
        const account = text(record(record(call.body)["account"])["id"]);
        if (!account) invalid("A pinned connector creates a zone only in a pinned account: set body.account.id.");
        assertAccount(account);
      }
    }
    for (const account of accounts) assertAccount(account);
    for (const zone of zones) await assertZone(zone, ctx);
  };
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
    return {
      query,
      headers: { ...headers, ...(type.endsWith("+json") ? { "Content-Type": type } : {}) },
      body: call.body,
    };
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
    const cursor = text(info["cursor"]) ?? text(record(info["cursors"])["after"]);
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

  // Unwrap the v4 envelope; the shared value-safety pass then redacts the
  // result on every method and tool.
  const result = (body: unknown, call: RestCall, response: { status: number; headers: Headers }): unknown => {
    if (!isEnvelope(body)) return body;
    if (body["success"] === false)
      throw failureFor(response.status === 200 ? 400 : response.status, response.headers, body, call);
    return filterListed(call.op, body["result"]);
  };

  const vendor: RestVendor = {
    vendor: "cloudflare",
    title: "Cloudflare",
    index: operations,
    transport(server) {
      if (server === undefined) return send;
      return `This operation is served from ${server}, which this connector does not reach.`;
    },
    failure: failureFor,
    readPosts: READ_POSTS,
    valueSafety: SAFETY,
    refuse,
    path: fillDefaults,
    scope,
    admit,
    result,
    encode,
    page,
    headers: HEADERS,
    textBodies: true,
    pathExample: "/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records",
    upload: "Send multipart, binary, and file bodies with cloudflare_api_upload.",
    bodyHint: "a string for text, SQL, or script operations, a list of objects for NDJSON",
  };

  const verify = async (ctx: ConnectorContext): Promise<JsonRecord> => {
    if (auth === "globalApiKey") {
      const { data } = await callRest(vendor, restCall(vendor, "GET", "/user"), ctx);
      const user = record(data);
      return { auth, status: "active", id: user["id"] ?? null, email: user["email"] ?? null, scope: "user" };
    }
    try {
      const { data } = await callRest(vendor, restCall(vendor, "GET", "/user/tokens/verify"), ctx);
      const token = record(data);
      return {
        auth,
        status: token["status"] ?? null,
        id: token["id"] ?? null,
        expiresOn: token["expires_on"] ?? null,
        scope: "user",
      };
    } catch (error) {
      // An account-owned token is verified under its account, not /user.
      const account = options.accountId ?? (pin?.accountIds?.length === 1 ? pin.accountIds[0] : undefined);
      if (!account || !(error instanceof ConnectorCallError) || error.code !== "auth_required") throw error;
      const { data } = await callRest(
        vendor,
        restCall(vendor, "GET", `/accounts/${encodeURIComponent(account)}/tokens/verify`),
        ctx,
      );
      const token = record(data);
      return {
        auth,
        status: token["status"] ?? null,
        id: token["id"] ?? null,
        expiresOn: token["expires_on"] ?? null,
        scope: "account",
        accountId: account,
      };
    }
  };

  const withValues = (ctx: ConnectorContext, values: Record<string, string>): ConnectorContext => ({
    ...ctx,
    credential: {
      get: async (field?: string) => (field ? (values[field] ?? null) : (values["value"] ?? null)),
      getAll: async () => values,
    },
  });

  const credentialTest = async (ctx: ConnectorContext): Promise<CredentialTestResult> => {
    try {
      const verified = await verify(ctx);
      if (auth === "globalApiKey")
        return { ok: true, message: `Global API Key verified for ${String(verified["email"])}.` };
      return verified["status"] === "active"
        ? {
            ok: true,
            message: `Token verified: active${verified["scope"] === "account" ? ` (account token for ${String(verified["accountId"])})` : ""}.`,
          }
        : { ok: false, message: `Token status is "${String(verified["status"])}".` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Cloudflare rejected the credential." };
    }
  };

  const projectZone = (value: unknown): JsonRecord => {
    const zone = record(value);
    const account = record(zone["account"]);
    return {
      id: zone["id"],
      name: zone["name"],
      status: zone["status"] ?? null,
      paused: zone["paused"] ?? null,
      type: zone["type"] ?? null,
      accountId: account["id"] ?? null,
      accountName: account["name"] ?? null,
      nameServers: Array.isArray(zone["name_servers"]) ? zone["name_servers"] : [],
      plan: record(zone["plan"])["name"] ?? null,
    };
  };

  const tools: ApiTool[] = [
    {
      name: "verify_credential",
      description:
        "Verify the configured Cloudflare credential and report its status. Call this first when another call fails with auth_required.",
      annotations: { readOnlyHint: true },
      inputSchema: closed({}),
      outputSchema: {
        type: "object",
        properties: {
          auth: { type: "string", enum: ["apiToken", "globalApiKey"] },
          status: { type: ["string", "null"], description: '"active" for a usable credential.' },
          id: { type: ["string", "null"] },
          email: { type: ["string", "null"], description: "The Global API Key's user." },
          expiresOn: { type: ["string", "null"] },
          scope: { type: "string", enum: ["user", "account"], description: "Who owns the token." },
          accountId: { type: "string" },
        },
        required: ["auth", "status", "scope"],
      },
      handler: async (_args: unknown, ctx: ConnectorContext) => await verify(ctx),
    },
    {
      name: "list_accounts",
      description:
        "List the Cloudflare accounts this credential reaches (only pinned ones when the connector is pinned). Supplies account ids for /accounts/{account_id} paths.",
      annotations: { readOnlyHint: true },
      inputSchema: closed({
        name: { type: "string", minLength: 1, maxLength: 200, description: "Exact account name." },
        ...PAGING_INPUT,
      }),
      outputSchema: {
        type: "object",
        properties: {
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string" } },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["accounts"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const query: JsonRecord = { page: args["page"] ?? 1, per_page: args["perPage"] ?? 20 };
        if (typeof args["name"] === "string") query["name"] = args["name"];
        const { data, page: next } = await callRest(vendor, restCall(vendor, "GET", "/accounts", { query }), ctx);
        return {
          accounts: (Array.isArray(data) ? data : []).map((item) => {
            const account = record(item);
            return { id: account["id"], name: account["name"], type: account["type"] ?? null };
          }),
          ...(next ? { page: next } : {}),
        };
      },
    },
    {
      name: "list_zones",
      description:
        "List Cloudflare zones (domains) by name, status, or account; only pinned ones when the connector is pinned. Supplies zone ids for /zones/{zone_id} paths.",
      annotations: { readOnlyHint: true },
      inputSchema: closed({
        name: { type: "string", minLength: 1, maxLength: 253, description: "Exact domain name, e.g. example.com." },
        status: {
          type: "string",
          enum: ["initializing", "pending", "active", "moved"],
          description: "Only zones in this status.",
        },
        accountId: { type: "string", minLength: 1, maxLength: 64, description: "Only zones in this account." },
        ...PAGING_INPUT,
      }),
      outputSchema: {
        type: "object",
        properties: {
          zones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                status: { type: ["string", "null"] },
                accountId: { type: ["string", "null"] },
                nameServers: { type: "array" },
              },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["zones"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const query: JsonRecord = { page: args["page"] ?? 1, per_page: args["perPage"] ?? 20 };
        if (typeof args["name"] === "string") query["name"] = args["name"];
        if (typeof args["status"] === "string") query["status"] = args["status"];
        if (typeof args["accountId"] === "string") query["account.id"] = args["accountId"];
        const { data, page: next } = await callRest(vendor, restCall(vendor, "GET", "/zones", { query }), ctx);
        return { zones: (Array.isArray(data) ? data : []).map(projectZone), ...(next ? { page: next } : {}) };
      },
    },
    {
      name: "graphql_query",
      description:
        "Run a read-only GraphQL Analytics API query (POST /graphql). Mutations and subscriptions are refused before sending; filter by zoneTag or accountTag.",
      annotations: { readOnlyHint: true },
      inputSchema: closed(
        {
          query: { type: "string", minLength: 1, maxLength: 20_000, description: "A GraphQL query document." },
          variables: { type: "object", description: "Variables the query declares, as JSON." },
          operationName: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Which query to run when the document has several.",
          },
        },
        ["query"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          data: { description: "The query result." },
          errors: { type: "array", description: "GraphQL errors, when Cloudflare returned partial data." },
        },
        required: ["data"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const source = String(args["query"]);
        const variables = record(args["variables"]);
        const scoped = inspectGraphqlQuery(source, variables, {
          strict: pin !== undefined,
          ...(typeof args["operationName"] === "string" ? { operationName: args["operationName"] } : {}),
        });
        if (pin) {
          if (scoped.openTags.length > 0) {
            invalid(
              `A pinned connector filters GraphQL by zoneTag or accountTag equality or _in, not ${scoped.openTags.join(", ")}.`,
            );
          }
          if (scoped.unscopedFields.length > 0 || scoped.accountTags.length + scoped.zoneTags.length === 0) {
            invalid(
              "A pinned connector's GraphQL queries filter every accounts and zones field by a pinned accountTag or zoneTag.",
            );
          }
          for (const account of scoped.accountTags) assertAccount(account);
          for (const zone of scoped.zoneTags) await assertZone(zone, ctx);
        }
        const graphql: Operation = Object.freeze({
          method: "POST",
          path: "/graphql",
          operationId: "graphql",
          summary: "GraphQL Analytics API",
          tag: "graphql",
          server: undefined,
          row: -1,
        });
        const body: JsonRecord = { query: source };
        if (args["variables"] !== undefined) body["variables"] = variables;
        if (typeof args["operationName"] === "string") body["operationName"] = args["operationName"];
        const response = await callRest(
          { ...vendor, encode: (call) => ({ body: call.body }), page: () => undefined },
          { method: "POST", path: "/graphql", op: graphql, params: {}, query: {}, body },
          ctx,
        );
        const document = record(response.data);
        const errors = Array.isArray(document["errors"]) ? document["errors"] : [];
        if ((document["data"] === undefined || document["data"] === null) && errors.length > 0) {
          invalid(`Cloudflare GraphQL rejected the query: ${describeErrors(errors as EnvelopeError[])}`);
        }
        return { data: document["data"] ?? null, ...(errors.length > 0 ? { errors } : {}) };
      },
    },
    {
      name: "cloudflare_api_upload",
      description:
        "Upload text, base64 bytes, or multipart parts to a reviewed Cloudflare upload operation. Covers Workers scripts, KV values, R2 objects, Pages, Images, Stream, DNS import, and Snippets; never reads local files.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: closed(
        {
          method: { type: "string", enum: ["POST", "PUT", "PATCH"], description: "The operation's HTTP method." },
          path: {
            type: "string",
            minLength: 2,
            maxLength: 2048,
            description: "Concrete path from cloudflare_api_search; encode a / inside an R2 or KV key as %2F.",
          },
          query: { type: "object", description: "Query parameters as JSON, named as details lists them." },
          headers: {
            type: "object",
            description: "Optional R2 headers.",
            properties: Object.fromEntries(
              Object.entries(HEADERS).map(([name, description]) => [
                name,
                { type: "string", minLength: 1, maxLength: 40, description },
              ]),
            ),
            additionalProperties: false,
          },
          contentType: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Content-Type of a text or base64 body.",
          },
          textBody: { type: "string", description: "A UTF-8 body; exclusive with base64Body and parts." },
          base64Body: { type: "string", description: "Body bytes as base64; exclusive with textBody and parts." },
          parts: {
            type: "array",
            maxItems: 100,
            description: "multipart/form-data parts; a part with fileName is sent as a file.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1, maxLength: 200, description: "Form field name, e.g. metadata." },
                text: { type: "string", description: "Text value; exclusive with base64." },
                base64: { type: "string", description: "Bytes as base64; exclusive with text." },
                fileName: {
                  type: "string",
                  minLength: 1,
                  maxLength: 500,
                  description: "Send as a file with this name.",
                },
                contentType: { type: "string", minLength: 1, maxLength: 200, description: "The part's Content-Type." },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "integer", description: "HTTP status." },
          data: { description: "Cloudflare's result." },
        },
        required: ["status", "data"],
      },
      handler: async (args: JsonRecord, ctx: ConnectorContext) => {
        const method = String(args["method"]) as "POST" | "PUT" | "PATCH";
        const prepared = restCall(vendor, method, String(args["path"]), {
          query: record(args["query"]),
          ...(Object.keys(record(args["headers"])).length
            ? { headers: record(args["headers"]) as Record<string, string> }
            : {}),
        });
        const refusal = SAFETY.refusal(prepared.method, prepared.op.path) ?? refuse(prepared);
        if (refusal) invalid(refusal);
        if (!UPLOADS.some(([verb, template]) => verb === prepared.op.method && template === prepared.op.path)) {
          invalid(
            `${prepared.op.method} ${prepared.op.path} is not a reviewed upload operation; JSON writes go through cloudflare_api_write.`,
          );
        }
        const accepted = operations.contract(prepared.op).parameters.filter((parameter) => parameter.in === "query");
        for (const name of Object.keys(prepared.query)) {
          if (!accepted.some((parameter) => parameter.name === name)) {
            invalid(
              `${prepared.op.path} has no query parameter ${name}; it accepts ${accepted.map((parameter) => parameter.name).join(", ") || "none"}.`,
            );
          }
        }
        const parts = Array.isArray(args["parts"]) ? args["parts"].map(record) : [];
        const textBody = typeof args["textBody"] === "string" ? args["textBody"] : undefined;
        const base64Body = typeof args["base64Body"] === "string" ? args["base64Body"] : undefined;
        if (Number(parts.length > 0) + Number(textBody !== undefined) + Number(base64Body !== undefined) !== 1) {
          invalid("cloudflare_api_upload needs exactly one body: textBody, base64Body, or parts.");
        }
        let upload: RawUpload;
        if (parts.length > 0) {
          const form = new FormData();
          for (const part of parts) {
            const name = String(part["name"]);
            const value = typeof part["text"] === "string" ? part["text"] : undefined;
            const bytes = typeof part["base64"] === "string" ? part["base64"] : undefined;
            if (Number(value !== undefined) + Number(bytes !== undefined) !== 1) {
              invalid(`Multipart part ${name} needs exactly one of text or base64.`);
            }
            const fileName = text(part["fileName"]);
            const type = text(part["contentType"]);
            if (fileName || type || bytes !== undefined) {
              const blob = new Blob([value ?? bytesFromBase64(bytes!, `part ${name}`)], {
                type: type ?? "application/octet-stream",
              });
              form.append(name, blob, fileName ?? name);
            } else {
              form.append(name, value!);
            }
          }
          upload = new RawUpload(form, undefined);
        } else {
          upload = new RawUpload(
            textBody ?? bytesFromBase64(base64Body!, "base64Body"),
            text(args["contentType"]) ??
              (textBody !== undefined ? "text/plain; charset=utf-8" : "application/octet-stream"),
          );
        }
        const { status, data } = await callRest(vendor, { ...prepared, body: upload }, ctx);
        return { status, data };
      },
    },
  ];

  return {
    vendor,
    tools,
    testCredential: async (value, ctx) => await credentialTest(withValues(ctx, { value: value.trim() })),
    testCredentials: async (values, ctx) => await credentialTest(withValues(ctx, values)),
  };
}
