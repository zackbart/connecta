/**
 * Planning Center Online as a hand-written `api()` provider: named tools for
 * the jobs a church staff agent actually does, plus two hatches split by safety
 * that reach every endpoint of every product.
 *
 * Why not the hosted MCP server. Planning Center operates its own at
 * `https://mcp.planningcenteronline.com/mcp` (GA 2026-08-20). It was considered
 * and passed over for this connection: its writes stop at People, and a proxy
 * owns none of the names, schemas, projections, or errors (P1), so Services
 * scheduling, Groups membership, workflow cards, and the Giving reads would
 * all be out of reach. Full REST coverage is the maintainer's choice; the
 * hosted server remains reachable through `remoteMcp()` for a deployment that
 * wants it.
 *
 * Why no SDK. Planning Center publishes none worth a dependency, and the API is
 * uniform JSON:API 1.0 over HTTP Basic, so Web `fetch` behind the guarded
 * transport is the whole client and the provider stays Workers-clean.
 *
 * Drift. Planning Center publishes an OpenAPI 3.1 document per product and
 * dated version (`/<app>/v2/open_api/<version>`) and a credential-free
 * documentation graph listing every version (`/<app>/v2/documentation`).
 * `scripts/drift/planning-center-endpoints.json` records each endpoint a named
 * tool calls, digested at the version pinned below, and
 * `npm run providers:check -- --provider planning-center` reports a touched
 * contract that moved and a newly published version of any pinned product.
 * Both are evidence only: no tool here is generated from either document.
 */
import { apiConnector as api, type ApiTool } from "../connectors/api-connector.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../errors.js";
import { CONNECTA_VERSION } from "../version.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  CredentialTestResult,
  JsonSchema,
} from "../types.js";

/** Planning Center's REST origin. Override only for a proxy or test double. */
export const PLANNING_CENTER_API_BASE_URL = "https://api.planningcenteronline.com";

/** The products behind `/<app>/v2`, in the order their guides list them. */
export const PLANNING_CENTER_APPS = [
  "people",
  "services",
  "groups",
  "check-ins",
  "calendar",
  "registrations",
  "giving",
  "publishing",
  "webhooks",
  "api",
] as const;

export type PlanningCenterApp = (typeof PLANNING_CENTER_APPS)[number];

/**
 * One reviewed `X-PCO-API-Version` per product, sent on every request.
 *
 * The header is optional, and omitting it is the trap: Planning Center then
 * applies a per-application default chosen in a web dashboard, so behavior
 * would follow whoever last clicked there rather than this file. Each date is
 * the newest non-beta version in the product's documentation graph on
 * 2026-10-05, and every projection below is written against it. A breaking
 * change arrives as a new dated version, never inside this one, so moving a
 * pin is a reviewed change to this table, its drift manifest, and whatever
 * projection the version's change list touches. Notes worth keeping:
 *
 * - groups `2023-07-10` removed every person attribute from `Membership`, so a
 *   membership is nameless without `include=person`.
 * - calendar `2026-06-22` may return `BookedEvent*` stubs in place of events on
 *   booking and conflict traversals for users without access to the event.
 * - webhooks `2022-10-20` renamed `Subscription` to `WebhookSubscription`.
 * - services `2018-11-01` and giving `2019-10-18` are simply the newest there is.
 *
 * The hatches send the same pin for the app their path names and accept a
 * per-call `version` override for an endpoint only a newer version serves.
 */
export const PLANNING_CENTER_API_VERSIONS: Readonly<Record<PlanningCenterApp, string>> = {
  people: "2026-06-04",
  services: "2018-11-01",
  groups: "2023-07-10",
  "check-ins": "2025-05-28",
  calendar: "2026-06-22",
  registrations: "2025-05-01",
  giving: "2019-10-18",
  publishing: "2024-03-25",
  webhooks: "2022-10-20",
  api: "2026-09-24",
};

/** Planning Center's own cap on `per_page`; its default is 25. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/**
 * A ceiling on absurdity, not a budget. `per_page` tops out at 100, and the
 * heaviest projection here — 100 people with emails and phone numbers
 * included — is a few hundred kilobytes.
 */
const PLANNING_CENTER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Planning Center documents 100 requests per 20 seconds per authenticated user
 * (429 with `Retry-After` in seconds past it, and `X-PCO-API-Request-Rate-*`
 * headers on every response). The rolling window transcribes that number, as
 * Cloudflare's per-user limit is transcribed: a per-runtime approximation, not
 * an enforcement, because N isolates each keep their own counter and every
 * other integration the token's user runs draws on the same bucket.
 * `maxConcurrency: 5` is connecta's choice, not Planning Center's — the bound
 * that stops one `execute_code` fan-out from spending the window in a tick.
 * Admission meters tool calls, not requests: `get_plan` spends three.
 */
const PLANNING_CENTER_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 5,
      budget: { kind: "rolling-window", maxCalls: 100, windowMs: 20_000 },
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  ],
};

/** Planning Center refuses a request without a descriptive one (HTTP 403). */
const DEFAULT_USER_AGENT = `connecta/${CONNECTA_VERSION} (+https://github.com/zackbart/connecta)`;

export interface PlanningCenterOptions {
  /** Which organization this is and what it should be used for. Required. */
  purpose: string;
  /** Human-readable display name. Defaults to "Planning Center". */
  title?: string;
  /** Organization-specific conventions appended to the maintained guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /**
   * The `User-Agent` Planning Center sees. It asks integrations to identify
   * themselves and refuses a request without one; name your deployment and a
   * contact. Defaults to one naming connecta.
   */
  userAgent?: string;
  /** Default `per_page` for list tools. Defaults to 25; Planning Center's maximum is 100. */
  defaultPageSize?: number;
  /**
   * Replaces the default per-runtime budget (100 calls per 20 seconds, five at
   * a time). Split it when two connections share one token's user, because
   * Planning Center meters that user once.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** API origin override for a proxy or test double. */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * The one seam a second credential shape plugs into. A personal access token
 * is the only server-to-server credential Planning Center offers, and it
 * carries the permissions of the user who created it. Planning Center also runs
 * OAuth 2.0 (authorize and token under `/oauth`, per-product scopes, two-hour
 * access tokens with 90-day refresh, PKCE); when `api()` grows an OAuth slot,
 * that arrives as a second `PlanningCenterAuth` returning a bearer header, and
 * nothing else in this file changes.
 */
interface PlanningCenterAuth {
  credential: ConnectorCredentialConfig;
  headers(ctx: ConnectorContext): Promise<Record<string, string>>;
}

const PERSONAL_ACCESS_TOKEN: PlanningCenterAuth = {
  credential: {
    label: "Planning Center personal access token",
    description:
      "Create one at api.planningcenteronline.com/oauth/applications → Personal Access Tokens. It acts with the permissions of the user who creates it, in every product that user can open, so create it as a user whose access matches this connection's purpose.",
    fields: [
      {
        name: "applicationId",
        label: "Application ID",
        description: "The personal access token's Application ID.",
        placeholder: "Paste Application ID",
        inputType: "text",
      },
      {
        name: "secret",
        label: "Secret",
        description: "The personal access token's Secret, shown once when the token is created.",
        placeholder: "Paste Secret",
        inputType: "password",
      },
    ],
  },
  async headers(ctx) {
    const applicationId = (await ctx.credential?.get("applicationId"))?.trim();
    const secret = (await ctx.credential?.get("secret"))?.trim();
    if (!applicationId || !secret) {
      throw new ConnectorCallError(
        "auth_required",
        "No Planning Center personal access token is configured for this connector; it needs both the Application ID and the Secret. Call authorize_connector for recovery options. When available, an operator can add the token in this connection in the operator UI.",
      );
    }
    // HTTP Basic is `id:secret` in Latin-1 base64. A colon in the id, or any
    // whitespace or non-ASCII character, is a pasting mistake no real token
    // contains — and btoa would either throw or frame it ambiguously.
    if (applicationId.includes(":") || /[^\x21-\x7e]/.test(applicationId + secret)) {
      throw new ConnectorCallError(
        "auth_required",
        "The configured Planning Center Application ID or Secret contains characters a token never has. An operator must re-paste both fields.",
      );
    }
    return { Authorization: `Basic ${btoa(`${applicationId}:${secret}`)}` };
  },
};

// ---------------------------------------------------------------------------
// JSON:API plumbing
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, any>;
type Query = Record<string, string | number | boolean | undefined>;

interface Resource {
  id: string;
  type: string;
  attributes?: JsonRecord;
  relationships?: Record<string, { data?: unknown } | undefined>;
}

type Included = Map<string, Resource>;

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

function isResource(value: unknown): value is Resource {
  const record = asRecord(value);
  return typeof record["id"] === "string" && typeof record["type"] === "string";
}

function resources(value: unknown): Resource[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter(isResource);
}

function indexIncluded(document: JsonRecord): Included {
  const index: Included = new Map();
  for (const resource of resources(document["included"])) {
    index.set(`${resource.type}:${resource.id}`, resource);
  }
  return index;
}

function relationshipData(resource: Resource, name: string): unknown {
  return resource.relationships?.[name]?.data;
}

/** The related id, `null` when Planning Center says there is none. */
function relId(resource: Resource, name: string): string | null | undefined {
  const data = relationshipData(resource, name);
  if (data === null) return null;
  const id = asRecord(data)["id"];
  return typeof id === "string" ? id : undefined;
}

function related(resource: Resource, name: string, index: Included): Resource | undefined {
  const data = asRecord(relationshipData(resource, name));
  return typeof data["type"] === "string" && typeof data["id"] === "string"
    ? index.get(`${data["type"]}:${data["id"]}`)
    : undefined;
}

function relatedMany(resource: Resource, name: string, index: Included): Resource[] {
  return asArray(relationshipData(resource, name))
    .map((entry) => {
      const ref = asRecord(entry);
      return index.get(`${String(ref["type"])}:${String(ref["id"])}`);
    })
    .filter((item): item is Resource => item !== undefined);
}

/** `{ id, ...the named attributes }`, keeping Planning Center's own names. */
function pick(resource: Resource, names: readonly string[]): JsonRecord {
  const attributes = resource.attributes ?? {};
  const out: JsonRecord = { id: resource.id };
  for (const name of names) {
    if (attributes[name] !== undefined) out[name] = attributes[name];
  }
  return out;
}

function attribute(resource: Resource | undefined, name: string): unknown {
  return resource?.attributes?.[name];
}

/** A JSON:API write document. `undefined` drops a key; `null` clears a field. */
function writeDocument(type: string, attributes: JsonRecord): JsonRecord {
  return { data: { type, attributes: compact(attributes) } };
}

interface Page {
  hasMore: boolean;
  nextOffset: number | null;
  totalCount: number | null;
}

/** One branchable signal: `meta.next.offset`, Planning Center's own cursor. */
function pageOf(document: JsonRecord): Page {
  const meta = asRecord(document["meta"]);
  const next = asRecord(meta["next"])["offset"];
  const nextOffset = typeof next === "number" && Number.isInteger(next) ? next : null;
  const total = meta["total_count"];
  return {
    hasMore: nextOffset !== null,
    nextOffset,
    totalCount: typeof total === "number" ? total : null,
  };
}

// ---------------------------------------------------------------------------
// Transport and typed failures
// ---------------------------------------------------------------------------

/** A request any tool makes: the app is read from the path, never passed. */
interface PlanningCenterRequest {
  method: GuardedRequest["method"];
  /** `/<app>/v2/...`, exactly as Planning Center documents it. */
  path: string;
  query?: Query;
  body?: unknown;
  /** Only the hatches override the pinned version. */
  version?: string;
}

const APP_PATH = /^\/([a-z-]+)\/v2(?:\/|$)/;

function isApp(value: string): value is PlanningCenterApp {
  return (PLANNING_CENTER_APPS as readonly string[]).includes(value);
}

/**
 * The product a path addresses, read after URL normalization — the same
 * normalization the guarded transport applies — so `..` cannot carry a request
 * from `/people/v2` to `/oauth` or anywhere else outside a product.
 */
function appForPath(path: string): PlanningCenterApp {
  let normalized: string | undefined;
  if (path.startsWith("/") && !path.startsWith("//")) {
    try {
      normalized = new URL(`https://planning-center.invalid${path}`).pathname;
    } catch {
      normalized = undefined;
    }
  }
  const app = normalized === undefined ? undefined : APP_PATH.exec(normalized)?.[1];
  if (!app || !isApp(app)) {
    throw new ConnectorCallError(
      "invalid_args",
      `A Planning Center path begins with /<app>/v2, where app is one of ${PLANNING_CENTER_APPS.join(", ")} — for example /people/v2/people. No host, query string, or traversal.`,
    );
  }
  return app;
}

function errorDetail(payload: unknown, status: number): string {
  const parts: string[] = [];
  for (const entry of asArray(asRecord(payload)["errors"])) {
    const error = asRecord(entry);
    const title = typeof error["title"] === "string" ? error["title"].trim() : "";
    const detail = typeof error["detail"] === "string" ? error["detail"].trim() : "";
    const source = asRecord(error["source"]);
    const at =
      typeof source["pointer"] === "string"
        ? ` (${source["pointer"]})`
        : typeof source["parameter"] === "string"
          ? ` (${source["parameter"]})`
          : "";
    const text = [title, detail].filter(Boolean).join(": ");
    if (text) parts.push(`${text}${at}`);
  }
  return parts.length > 0
    ? `Planning Center: ${parts.join("; ")}`
    : `Planning Center returned HTTP ${status}.`;
}

/**
 * Map by the caller's next move.
 *
 * - **401** is the token: revoked, mistyped, or the id and secret of two
 *   different tokens. Only an operator can fix it.
 * - **403** is the token's *user*, not the token: Planning Center permissions
 *   belong to whoever created it, per product and per record. Neither
 *   `authorize_connector` nor a retry helps, so it is a non-retryable failure
 *   that says so.
 * - **404** is absence — Planning Center answers a permission gap with 403 —
 *   but a person id that used to work was most often merged into another.
 */
function planningCenterFailure(
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const detail = errorDetail(payload, status);
  if (status === 429) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} Planning Center allows 100 requests per 20 seconds per user, shared by every integration that user's tokens run.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} The personal access token was rejected: revoked, mistyped, or an Application ID and Secret from different tokens. An operator must replace it.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} The token's Planning Center user lacks permission for this product or record. Permissions belong to that user; an operator must raise them or use another user's token. Retrying will not help.`,
      { retryable: false },
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `${detail} Confirm the id with its list tool. A person id that used to resolve was probably merged: look it up in /people/v2/person_mergers with where[person_to_remove_id].`,
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new ConnectorCallError("invalid_args", detail);
  }
  if (status >= 500) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `${detail} Planning Center is failing upstream.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError("connector_call_failed", detail, {
    retryable: false,
  });
}

type Call = (request: PlanningCenterRequest, ctx: ConnectorContext) => Promise<any>;

function planningCenterCall(
  send: GuardedTransport,
  versions: Readonly<Record<PlanningCenterApp, string>>,
): Call {
  return async (request, ctx) => {
    const app = appForPath(request.path);
    return await send(
      compact({
        method: request.method,
        path: request.path,
        query: request.query,
        body: request.body,
        headers: { "X-PCO-API-Version": request.version ?? versions[app] },
      }) as GuardedRequest,
      ctx,
      async (response) => {
        const parsed = await response.jsonResult();
        if (!response.ok) {
          throw planningCenterFailure(
            response.status,
            response.headers,
            "value" in parsed ? parsed.value : undefined,
          );
        }
        if ("parseError" in parsed) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Planning Center returned a successful response that is not JSON.",
            { retryable: false },
          );
        }
        return parsed.value;
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const STRING = { type: "string" } as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;
const INTEGER = { type: "integer" } as const;
const NULLABLE_INTEGER = { type: ["integer", "null"] } as const;
const BOOLEAN = { type: "boolean" } as const;
const ARRAY = { type: "array" } as const;
const OBJECT = { type: "object" } as const;

function record(
  properties: Record<string, JsonSchema>,
  required: string[] = ["id"],
): JsonSchema {
  return { type: "object", properties, required };
}

function input(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function idProperty(description: string): JsonSchema {
  return { type: "string", pattern: "^[0-9]+$", description };
}

const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "Return Planning Center's untouched JSON:API resources (and `included`) instead of the lean projection.",
};

const OFFSET_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 0,
  description: "Rows to skip. Pass page.nextOffset back unchanged; omit for the first page.",
};

const DATE_PROPERTY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(T[0-9:.]+(Z|[+-]\\d{2}:?\\d{2})?)?$";

function dateProperty(description: string): JsonSchema {
  return {
    type: "string",
    pattern: DATE_PROPERTY_PATTERN,
    description: `${description} ISO 8601 date or date-time; a bare date is the organization's local day.`,
  };
}

function perPageProperty(defaultPageSize: number): JsonSchema {
  return {
    type: "integer",
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    description: `Rows per page, 1 to Planning Center's maximum of ${MAX_PAGE_SIZE}. Defaults to this connector's ${defaultPageSize}.`,
  };
}

function orderProperty(values: readonly string[]): JsonSchema {
  return {
    type: "string",
    enum: values.flatMap((value) => [value, `-${value}`]),
    description: "Sort attribute; a leading '-' reverses it.",
  };
}

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: BOOLEAN,
    nextOffset: { type: ["integer", "null"], description: "Pass back as offset while hasMore is true." },
    totalCount: NULLABLE_INTEGER,
  },
  required: ["hasMore", "nextOffset"],
};

function listOutput(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      [key]: { type: "array", items: item },
      page: PAGE_SCHEMA,
      included: { type: "array", description: "Sideloaded resources, only with raw: true." },
    },
    required: [key, "page"],
  };
}

const QUERY_PROPERTY: JsonSchema = {
  type: "array",
  description: "Query parameters as name/value pairs, e.g. where[status]=active, include=emails, order=-created_at, per_page, offset.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "Parameter name, brackets literal: where[first_name]." },
      value: {
        type: ["string", "number", "boolean"],
        description: "Parameter value; the transport encodes it once.",
      },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

const HATCH_PATH_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Path beginning /<app>/v2, as Planning Center documents it: /people/v2/people/1/emails. No host or query string.",
};

const VERSION_PROPERTY: JsonSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "X-PCO-API-Version override. Omit to send this connector's reviewed pin for the path's app.",
};

function queryPairs(value: unknown): Query {
  const query: Query = {};
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    if (typeof pair["name"] !== "string") continue;
    const item = pair["value"];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      query[pair["name"]] = item;
    }
  }
  return query;
}

// --- Output records ---------------------------------------------------------

const PERSON_SUMMARY: Record<string, JsonSchema> = {
  id: STRING,
  name: STRING,
  first_name: STRING,
  last_name: STRING,
  nickname: NULLABLE_STRING,
  status: STRING,
  membership: NULLABLE_STRING,
  child: BOOLEAN,
  primary_email: NULLABLE_STRING,
  primary_phone: NULLABLE_STRING,
  updated_at: STRING,
};

const PERSON_SUMMARY_SCHEMA = record(PERSON_SUMMARY);

const PERSON_SCHEMA = record({
  ...PERSON_SUMMARY,
  given_name: NULLABLE_STRING,
  middle_name: NULLABLE_STRING,
  birthdate: NULLABLE_STRING,
  anniversary: NULLABLE_STRING,
  gender: NULLABLE_STRING,
  grade: NULLABLE_INTEGER,
  inactivated_at: NULLABLE_STRING,
  created_at: STRING,
  primary_campus: OBJECT,
  emails: ARRAY,
  phone_numbers: ARRAY,
  addresses: ARRAY,
  households: ARRAY,
});

const EMAIL_SCHEMA = record({ id: STRING, address: STRING, location: NULLABLE_STRING, primary: BOOLEAN, person_id: STRING });
const PHONE_SCHEMA = record({ id: STRING, number: STRING, location: NULLABLE_STRING, primary: BOOLEAN, person_id: STRING });

const CARD_SCHEMA = record({
  id: STRING,
  stage: STRING,
  person_id: NULLABLE_STRING,
  person_name: NULLABLE_STRING,
  assignee_id: NULLABLE_STRING,
  current_step_id: NULLABLE_STRING,
  current_step_name: NULLABLE_STRING,
  moved_to_step_at: NULLABLE_STRING,
  snooze_until: NULLABLE_STRING,
  overdue: BOOLEAN,
  completed_at: NULLABLE_STRING,
  removed_at: NULLABLE_STRING,
});

const NOTE_SCHEMA = record({
  id: STRING,
  note: STRING,
  note_category_id: STRING,
  category: NULLABLE_STRING,
  person_id: STRING,
  display_date: NULLABLE_STRING,
  created_at: STRING,
  created_by_id: NULLABLE_STRING,
});

const PLAN_PERSON_SCHEMA = record({
  id: STRING,
  name: STRING,
  status: STRING,
  team_position_name: NULLABLE_STRING,
  team_id: NULLABLE_STRING,
  team_name: NULLABLE_STRING,
  person_id: NULLABLE_STRING,
  decline_reason: NULLABLE_STRING,
});

const ITEM_SCHEMA = record({
  id: STRING,
  sequence: INTEGER,
  item_type: STRING,
  title: STRING,
  length: NULLABLE_INTEGER,
  key_name: NULLABLE_STRING,
  service_position: NULLABLE_STRING,
  song_id: NULLABLE_STRING,
  arrangement_id: NULLABLE_STRING,
});

const MEMBERSHIP_SCHEMA = record({
  id: STRING,
  role: STRING,
  joined_at: NULLABLE_STRING,
  person_id: STRING,
  first_name: STRING,
  last_name: STRING,
});

const DESIGNATIONS: JsonSchema = {
  type: "array",
  items: record({ fund_id: NULLABLE_STRING, fund: NULLABLE_STRING, amount_cents: INTEGER }, ["amount_cents"]),
};

const DONATION_SCHEMA = record({
  id: STRING,
  amount_cents: INTEGER,
  amount_currency: STRING,
  fee_cents: NULLABLE_INTEGER,
  received_at: NULLABLE_STRING,
  payment_method: NULLABLE_STRING,
  payment_status: NULLABLE_STRING,
  refunded: BOOLEAN,
  person_id: NULLABLE_STRING,
  batch_id: NULLABLE_STRING,
  campus_id: NULLABLE_STRING,
  designations: DESIGNATIONS,
});

// --- Projections ------------------------------------------------------------

function primaryOf(rows: Resource[], key: string): string | null {
  const primary = rows.find((row) => attribute(row, "primary") === true) ?? rows[0];
  const value = attribute(primary, key);
  return typeof value === "string" ? value : null;
}

function personSummary(person: Resource, index: Included): JsonRecord {
  return {
    ...pick(person, ["name", "first_name", "last_name", "nickname", "status", "membership", "child"]),
    primary_email: primaryOf(relatedMany(person, "emails", index), "address"),
    primary_phone: primaryOf(relatedMany(person, "phone_numbers", index), "number"),
    ...pick(person, ["updated_at"]),
    id: person.id,
  };
}

function emailRecord(email: Resource): JsonRecord {
  return compact({ ...pick(email, ["address", "location", "primary"]), person_id: relId(email, "person") ?? undefined });
}

function phoneRecord(phone: Resource): JsonRecord {
  return compact({ ...pick(phone, ["number", "location", "primary"]), person_id: relId(phone, "person") ?? undefined });
}

function personRecord(person: Resource, index: Included): JsonRecord {
  const campus = related(person, "primary_campus", index);
  return compact({
    ...personSummary(person, index),
    ...pick(person, [
      "given_name",
      "middle_name",
      "birthdate",
      "anniversary",
      "gender",
      "grade",
      "inactivated_at",
      "created_at",
    ]),
    id: person.id,
    primary_campus: campus
      ? { id: campus.id, name: attribute(campus, "name") }
      : relId(person, "primary_campus")
        ? { id: relId(person, "primary_campus") }
        : undefined,
    emails: relatedMany(person, "emails", index).map((email) => pick(email, ["address", "location", "primary"])),
    phone_numbers: relatedMany(person, "phone_numbers", index).map((phone) =>
      pick(phone, ["number", "location", "primary"]),
    ),
    addresses: relatedMany(person, "addresses", index).map((address) =>
      pick(address, ["street_line_1", "street_line_2", "city", "state", "zip", "country_code", "location", "primary"]),
    ),
    households: relatedMany(person, "households", index).map((household) =>
      pick(household, ["name", "primary_contact_id", "member_count"]),
    ),
  });
}

function cardRecord(card: Resource, index: Included): JsonRecord {
  const person = related(card, "person", index);
  const step = related(card, "current_step", index);
  return {
    ...pick(card, ["stage"]),
    person_id: relId(card, "person") ?? null,
    person_name: attribute(person, "name") ?? null,
    assignee_id: relId(card, "assignee") ?? null,
    current_step_id: relId(card, "current_step") ?? null,
    current_step_name: attribute(step, "name") ?? null,
    ...pick(card, ["moved_to_step_at", "snooze_until", "overdue", "completed_at", "removed_at"]),
    id: card.id,
  };
}

function noteRecord(note: Resource, index: Included): JsonRecord {
  // `include=category` sideloads what the resource itself calls
  // `note_category`; the flat `note_category_id` settles it either way.
  const category =
    related(note, "category", index) ??
    related(note, "note_category", index) ??
    index.get(`NoteCategory:${String(attribute(note, "note_category_id"))}`);
  return {
    ...pick(note, ["note", "note_category_id", "person_id", "display_date", "created_at", "created_by_id"]),
    category: attribute(category, "name") ?? null,
  };
}

function planPersonRecord(member: Resource, index: Included): JsonRecord {
  const team = related(member, "team", index);
  return {
    ...pick(member, ["name", "status", "team_position_name", "decline_reason"]),
    team_id: relId(member, "team") ?? null,
    team_name: attribute(team, "name") ?? null,
    person_id: relId(member, "person") ?? null,
  };
}

function itemRecord(item: Resource): JsonRecord {
  return {
    ...pick(item, ["sequence", "item_type", "title", "length", "key_name", "service_position"]),
    song_id: relId(item, "song") ?? null,
    arrangement_id: relId(item, "arrangement") ?? null,
  };
}

function membershipRecord(membership: Resource, index: Included): JsonRecord {
  const person = related(membership, "person", index);
  return {
    ...pick(membership, ["role", "joined_at"]),
    person_id: relId(membership, "person") ?? null,
    first_name: attribute(person, "first_name") ?? null,
    last_name: attribute(person, "last_name") ?? null,
  };
}

function designations(owner: Resource, index: Included): JsonRecord[] {
  return relatedMany(owner, "designations", index).map((designation) => {
    const fund = related(designation, "fund", index);
    return {
      fund_id: relId(designation, "fund") ?? null,
      fund: attribute(fund, "name") ?? null,
      amount_cents: attribute(designation, "amount_cents"),
    };
  });
}

function donationRecord(donation: Resource, index: Included): JsonRecord {
  return {
    ...pick(donation, [
      "amount_cents",
      "amount_currency",
      "fee_cents",
      "received_at",
      "payment_method",
      "payment_status",
      "refunded",
    ]),
    person_id: relId(donation, "person") ?? null,
    batch_id: relId(donation, "batch") ?? null,
    campus_id: relId(donation, "campus") ?? null,
    designations: designations(donation, index),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const READ = { readOnlyHint: true } as const;
/** Creates a record and changes nothing that existed: write-routed, not destructive. */
const ADDITIVE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

interface ListToolSpec {
  name: string;
  description: string;
  key: string;
  item: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  path: (args: JsonRecord) => string;
  query?: (args: JsonRecord) => Query;
  include?: string;
  project: (resource: Resource, index: Included) => JsonRecord;
}

/**
 * A hand-written list tool. The spec is authored per tool; the helper only
 * owns the parts every list shares — paging, `raw`, and the envelope.
 */
function listTool(call: Call, defaultPageSize: number, spec: ListToolSpec): ApiTool {
  return {
    name: spec.name,
    description: spec.description,
    annotations: READ,
    inputSchema: input(
      {
        ...spec.properties,
        perPage: perPageProperty(defaultPageSize),
        offset: OFFSET_PROPERTY,
        raw: RAW_PROPERTY,
      },
      spec.required,
    ),
    outputSchema: listOutput(spec.key, spec.item),
    handler: async (args: JsonRecord, ctx) => {
      const document = asRecord(
        await call(
          {
            method: "GET",
            path: spec.path(args),
            query: {
              ...spec.query?.(args),
              include: spec.include,
              per_page: args["perPage"] ?? defaultPageSize,
              offset: args["offset"],
            },
          },
          ctx,
        ),
      );
      const rows = resources(document["data"]);
      if (args["raw"] === true) {
        return { [spec.key]: rows, included: asArray(document["included"]), page: pageOf(document) };
      }
      const index = indexIncluded(document);
      return { [spec.key]: rows.map((row) => spec.project(row, index)), page: pageOf(document) };
    },
  };
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value));
}

/** The single resource a response carries, or a refusal to invent one. */
function created(document: unknown, what: string): Resource {
  const resource = resources(asRecord(document)["data"])[0];
  if (!resource) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `Planning Center answered without the ${what} it should return.`,
      { retryable: false },
    );
  }
  return resource;
}

/** `where[a][b][gte]` and `[lt]` for a half-open range on a (nested) attribute. */
function range(attribute: readonly string[], after: unknown, before: unknown): Query {
  const key = `where[${attribute.join("][")}]`;
  return {
    [`${key}[gte]`]: typeof after === "string" ? after : undefined,
    [`${key}[lt]`]: typeof before === "string" ? before : undefined,
  };
}

const PERSON_ID = idProperty("Person id from search_people. The same id resolves in every Planning Center product.");
const SERVICE_TYPE_ID = idProperty("Service type id from list_service_types.");
const PLAN_ID = idProperty("Plan id from list_plans.");

const PERSON_WRITE_PROPERTIES: Record<string, JsonSchema> = {
  firstName: { type: "string", minLength: 1, description: "First name." },
  lastName: { type: "string", minLength: 1, description: "Last name." },
  nickname: { type: ["string", "null"], description: "Nickname; null clears it." },
  middleName: { type: ["string", "null"], description: "Middle name; null clears it." },
  birthdate: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Birthdate, YYYY-MM-DD; null clears it." },
  anniversary: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Anniversary, YYYY-MM-DD; null clears it." },
  gender: { type: ["string", "null"], description: "Gender as the organization records it, e.g. Male or Female." },
  membership: { type: ["string", "null"], description: "Membership type, one of the organization's own values such as Member or Visitor." },
  child: { type: "boolean", description: "Whether the person is a child." },
  primaryCampusId: { type: "string", pattern: "^[0-9]+$", description: "Campus id from /people/v2/campuses." },
};

function personAttributes(args: JsonRecord): JsonRecord {
  return {
    first_name: args["firstName"],
    last_name: args["lastName"],
    nickname: args["nickname"],
    middle_name: args["middleName"],
    birthdate: args["birthdate"],
    anniversary: args["anniversary"],
    gender: args["gender"],
    membership: args["membership"],
    child: args["child"],
    primary_campus_id: args["primaryCampusId"],
    status: args["status"],
  };
}

const WORKFLOW_CARD_ACTIONS = [
  "promote",
  "go_back",
  "skip_step",
  "snooze",
  "unsnooze",
  "remove",
  "restore",
] as const;

function tools(call: Call, defaultPageSize: number): ApiTool[] {
  const perPage = (args: JsonRecord) => args["perPage"] ?? defaultPageSize;
  const list = (spec: ListToolSpec) => listTool(call, defaultPageSize, spec);
  return [
    // --- Hatches ------------------------------------------------------------
    {
      name: "pco_api_get",
      description:
        "Call any Planning Center GET endpoint in any product and return its untouched JSON:API body. Prefer a named read; this one does not flatten or resolve includes.",
      annotations: READ,
      inputSchema: input(
        { path: HATCH_PATH_PROPERTY, query: QUERY_PROPERTY, version: VERSION_PROPERTY },
        ["path"],
      ),
      outputSchema: {
        type: "object",
        properties: { result: { description: "Planning Center's untouched response body." } },
        required: ["result"],
      },
      handler: async (args: JsonRecord, ctx) => ({
        result:
          (await call(
            compact({
              method: "GET" as const,
              path: String(args["path"]),
              query: queryPairs(args["query"]),
              version: args["version"],
            }),
            ctx,
          )) ?? null,
      }),
    },
    {
      name: "pco_api_mutate",
      description:
        "Call any Planning Center POST, PATCH, or DELETE endpoint with a JSON:API body. The approval-gated hatch for writes, actions, and money movement no named tool covers.",
      annotations: DESTRUCTIVE,
      inputSchema: input(
        {
          method: {
            type: "string",
            enum: ["POST", "PATCH", "DELETE"],
            description: "Mutation method; Planning Center uses PATCH, never PUT, for updates.",
          },
          path: HATCH_PATH_PROPERTY,
          query: QUERY_PROPERTY,
          body: {
            type: "object",
            description: 'JSON:API document, never flat attributes: {"data":{"type":"Email","attributes":{...}}}. Omit for DELETE and bodiless actions.',
          },
          version: VERSION_PROPERTY,
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: { result: { description: "Planning Center's untouched response body, or null for 204." } },
        required: ["result"],
      },
      handler: async (args: JsonRecord, ctx) => ({
        result:
          (await call(
            compact({
              method: args["method"] as GuardedRequest["method"],
              path: String(args["path"]),
              query: queryPairs(args["query"]),
              body: args["body"],
              version: args["version"],
            }),
            ctx,
          )) ?? null,
      }),
    },

    // --- People -------------------------------------------------------------
    {
      name: "get_me",
      description:
        "Get the Planning Center person this token acts as, with the organization's name and time zone. Supplies personId for my-schedule and assignee questions.",
      annotations: READ,
      inputSchema: input({}),
      outputSchema: record({
        id: STRING,
        name: STRING,
        first_name: STRING,
        last_name: STRING,
        status: STRING,
        organization: record({ id: STRING, name: STRING, time_zone: STRING }),
      }),
      handler: async (_args, ctx) => {
        const document = asRecord(
          await call({ method: "GET", path: "/people/v2/me", query: { include: "organization" } }, ctx),
        );
        const me = created(document, "person record");
        const organization = resources(document["included"]).find((row) => row.type === "Organization");
        return {
          ...pick(me, ["name", "first_name", "last_name", "status"]),
          ...(organization ? { organization: pick(organization, ["name", "time_zone"]) } : {}),
        };
      },
    },
    list({
      name: "search_people",
      description:
        "Search People profiles by name, email, or phone, with each person's primary email and phone. Omit search to list everyone; never searches custom fields or notes.",
      key: "people",
      item: PERSON_SUMMARY_SCHEMA,
      properties: {
        search: { type: "string", minLength: 1, description: "Matches name, email address, or phone number." },
        status: { type: "string", enum: ["active", "inactive"], description: "Profile status." },
        membership: { type: "string", minLength: 1, description: "Exact membership type, e.g. Member." },
        updatedSince: dateProperty("Only people updated at or after this time."),
        order: orderProperty(["last_name", "first_name", "created_at", "updated_at"]),
      },
      path: () => "/people/v2/people",
      query: (args) => ({
        "where[search_name_or_email_or_phone_number]": args["search"],
        "where[status]": args["status"],
        "where[membership]": args["membership"],
        "where[updated_at][gte]": args["updatedSince"],
        order: args["order"],
      }),
      include: "emails,phone_numbers",
      project: personSummary,
    }),
    {
      name: "get_person",
      description:
        "Get one person's profile with every email, phone number, address, household, and primary campus. Custom fields are list_person_field_data.",
      annotations: READ,
      inputSchema: input({ personId: PERSON_ID, raw: RAW_PROPERTY }, ["personId"]),
      outputSchema: PERSON_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const document = asRecord(
          await call(
            {
              method: "GET",
              path: `/people/v2/people/${segment(args["personId"])}`,
              query: { include: "emails,phone_numbers,addresses,households,primary_campus" },
            },
            ctx,
          ),
        );
        const person = created(document, "person record");
        return args["raw"] === true
          ? { ...person, included: asArray(document["included"]) }
          : personRecord(person, indexIncluded(document));
      },
    },
    {
      name: "create_person",
      description:
        "Create a People profile. Emails and phone numbers are separate records; add them after with add_person_email and add_person_phone_number.",
      annotations: ADDITIVE,
      inputSchema: input(PERSON_WRITE_PROPERTIES, ["firstName", "lastName"]),
      outputSchema: PERSON_SUMMARY_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const document = await call(
          { method: "POST", path: "/people/v2/people", body: writeDocument("Person", personAttributes(args)) },
          ctx,
        );
        return personSummary(created(document, "person"), new Map());
      },
    },
    {
      name: "update_person",
      description:
        "Update fields on one People profile; omitted fields stay as they are. status inactive archives the person reversibly; this never deletes a profile.",
      annotations: DESTRUCTIVE,
      inputSchema: input(
        {
          personId: PERSON_ID,
          ...PERSON_WRITE_PROPERTIES,
          status: { type: "string", enum: ["active", "inactive"], description: "inactive archives the profile; active restores it." },
        },
        ["personId"],
      ),
      outputSchema: PERSON_SUMMARY_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const attributes = compact(personAttributes(args));
        if (Object.keys(attributes).length === 0) {
          throw new ConnectorCallError("invalid_args", "Nothing to update: provide at least one profile field.");
        }
        const document = await call(
          {
            method: "PATCH",
            path: `/people/v2/people/${segment(args["personId"])}`,
            body: { data: { type: "Person", id: String(args["personId"]), attributes } },
          },
          ctx,
        );
        return personSummary(created(document, "person update"), new Map());
      },
    },
    {
      name: "add_person_email",
      description:
        "Add an email address to a person. Making it primary demotes the current primary; edit or delete existing addresses with pco_api_mutate.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          personId: PERSON_ID,
          address: { type: "string", minLength: 3, description: "Email address." },
          location: { type: "string", minLength: 1, description: "Label such as Home or Work. Defaults to Home." },
          primary: { type: "boolean", description: "Make this the primary address." },
        },
        ["personId", "address"],
      ),
      outputSchema: EMAIL_SCHEMA,
      handler: async (args: JsonRecord, ctx) =>
        emailRecord(
          created(
            await call(
              {
                method: "POST",
                path: `/people/v2/people/${segment(args["personId"])}/emails`,
                body: writeDocument("Email", {
                  address: args["address"],
                  location: args["location"] ?? "Home",
                  primary: args["primary"],
                }),
              },
              ctx,
            ),
            "email",
          ),
        ),
    },
    {
      name: "add_person_phone_number",
      description:
        "Add a phone number to a person. Making it primary demotes the current primary; edit or delete existing numbers with pco_api_mutate.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          personId: PERSON_ID,
          number: { type: "string", minLength: 3, description: "Phone number as dialed; Planning Center formats it." },
          location: { type: "string", minLength: 1, description: "Label such as Mobile, Home, or Work. Defaults to Mobile." },
          primary: { type: "boolean", description: "Make this the primary number." },
        },
        ["personId", "number"],
      ),
      outputSchema: PHONE_SCHEMA,
      handler: async (args: JsonRecord, ctx) =>
        phoneRecord(
          created(
            await call(
              {
                method: "POST",
                path: `/people/v2/people/${segment(args["personId"])}/phone_numbers`,
                body: writeDocument("PhoneNumber", {
                  number: args["number"],
                  location: args["location"] ?? "Mobile",
                  primary: args["primary"],
                }),
              },
              ctx,
            ),
            "phone number",
          ),
        ),
    },
    list({
      name: "list_lists",
      description:
        "List People lists (saved, rule-based searches) with size and last refresh. Members come from list_list_people; results are only as fresh as refreshed_at.",
      key: "lists",
      item: record({
        id: STRING,
        name: NULLABLE_STRING,
        description: NULLABLE_STRING,
        total_people: INTEGER,
        status: STRING,
        refreshed_at: NULLABLE_STRING,
        auto_refresh: BOOLEAN,
        automations_active: BOOLEAN,
      }),
      properties: {
        name: { type: "string", minLength: 1, description: "Exact list name; end it with % for a prefix match." },
        order: orderProperty(["name", "updated_at", "refreshed_at"]),
      },
      path: () => "/people/v2/lists",
      query: (args) => ({ "where[name]": args["name"], order: args["order"] }),
      project: (row) =>
        pick(row, ["name", "description", "total_people", "status", "refreshed_at", "auto_refresh", "automations_active"]),
    }),
    list({
      name: "list_list_people",
      description:
        "List the people in one People list as of its last refresh, with primary email and phone. Call run_list first when the results must be current.",
      key: "people",
      item: PERSON_SUMMARY_SCHEMA,
      properties: { listId: idProperty("List id from list_lists.") },
      required: ["listId"],
      path: (args) => `/people/v2/lists/${segment(args["listId"])}/people`,
      include: "emails,phone_numbers",
      project: personSummary,
    }),
    {
      name: "run_list",
      description:
        "Refresh a People list's results now. Destructive: a refresh can fire the list's automations, such as adding people to workflows or forms.",
      annotations: DESTRUCTIVE,
      inputSchema: input({ listId: idProperty("List id from list_lists.") }, ["listId"]),
      outputSchema: record({ listId: STRING, queued: BOOLEAN }, ["listId", "queued"]),
      handler: async (args: JsonRecord, ctx) => {
        await call({ method: "POST", path: `/people/v2/lists/${segment(args["listId"])}/run` }, ctx);
        return { listId: String(args["listId"]), queued: true };
      },
    },
    list({
      name: "list_workflows",
      description:
        "List People workflows with their steps and ready, overdue, and unassigned card counts. Archived workflows are excluded unless asked for.",
      key: "workflows",
      item: record({
        id: STRING,
        name: STRING,
        total_cards_count: INTEGER,
        total_ready_card_count: INTEGER,
        total_overdue_card_count: INTEGER,
        total_unassigned_card_count: INTEGER,
        my_ready_card_count: INTEGER,
        archived_at: NULLABLE_STRING,
        steps: ARRAY,
      }),
      properties: {
        name: { type: "string", minLength: 1, description: "Exact workflow name; end it with % for a prefix match." },
        includeArchived: { type: "boolean", description: "Include archived workflows." },
      },
      path: () => "/people/v2/workflows",
      query: (args) => ({
        "where[name]": args["name"],
        filter: args["includeArchived"] === true ? undefined : "not_archived",
      }),
      include: "steps",
      project: (row, index) => ({
        ...pick(row, [
          "name",
          "total_cards_count",
          "total_ready_card_count",
          "total_overdue_card_count",
          "total_unassigned_card_count",
          "my_ready_card_count",
          "archived_at",
        ]),
        steps: relatedMany(row, "steps", index)
          .map((step) => pick(step, ["name", "sequence"]))
          .sort((a, b) => Number(a["sequence"] ?? 0) - Number(b["sequence"] ?? 0)),
      }),
    }),
    list({
      name: "list_workflow_cards",
      description:
        "List the cards in one workflow with each card's person, assignee, and current step. Card actions need both the card id and its person_id.",
      key: "cards",
      item: CARD_SCHEMA,
      properties: {
        workflowId: idProperty("Workflow id from list_workflows."),
        stage: { type: "string", minLength: 1, description: "Card stage as Planning Center reports it, e.g. ready, snoozed, completed, removed." },
        stepId: idProperty("Only cards on this step (list_workflows steps[].id)."),
        assigneeId: idProperty("Only cards assigned to this person id."),
        overdue: { type: "boolean", description: "Only overdue (true) or on-time (false) cards." },
        order: orderProperty(["created_at", "moved_to_step_at", "last_name"]),
      },
      required: ["workflowId"],
      path: (args) => `/people/v2/workflows/${segment(args["workflowId"])}/cards`,
      query: (args) => ({
        "where[stage]": args["stage"],
        "where[step_id]": args["stepId"],
        "where[assignee_id]": args["assigneeId"],
        "where[overdue]": args["overdue"],
        order: args["order"],
      }),
      include: "person,current_step",
      project: cardRecord,
    }),
    {
      name: "add_workflow_card",
      description:
        "Add a person to a workflow as a new card on its first step. Optionally assign it; the workflow's own step defaults apply otherwise.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          workflowId: idProperty("Workflow id from list_workflows."),
          personId: PERSON_ID,
          assigneeId: idProperty("Person id to assign the card to."),
        },
        ["workflowId", "personId"],
      ),
      outputSchema: CARD_SCHEMA,
      handler: async (args: JsonRecord, ctx) =>
        cardRecord(
          created(
            await call(
              {
                method: "POST",
                path: `/people/v2/workflows/${segment(args["workflowId"])}/cards`,
                body: writeDocument("WorkflowCard", { person_id: args["personId"], assignee_id: args["assigneeId"] }),
              },
              ctx,
            ),
            "workflow card",
          ),
          new Map(),
        ),
    },
    {
      name: "apply_workflow_card_action",
      description:
        "Promote, send back, skip a step on, snooze, unsnooze, remove, or restore one workflow card. Never emails; sending a card email is pco_api_mutate.",
      annotations: DESTRUCTIVE,
      inputSchema: input(
        {
          personId: { ...PERSON_ID, description: "The card's person_id from list_workflow_cards." },
          cardId: idProperty("Workflow card id from list_workflow_cards."),
          action: {
            type: "string",
            enum: [...WORKFLOW_CARD_ACTIONS],
            description: "promote completes the step; skip_step moves on without completing it; go_back returns to the previous step.",
          },
          snoozeDays: { type: "integer", minimum: 1, maximum: 365, description: "Days to snooze; required with action snooze and refused otherwise." },
        },
        ["personId", "cardId", "action"],
      ),
      outputSchema: record({ cardId: STRING, action: STRING, applied: BOOLEAN }, ["cardId", "action", "applied"]),
      handler: async (args: JsonRecord, ctx) => {
        const snooze = args["action"] === "snooze";
        if (snooze !== (args["snoozeDays"] !== undefined)) {
          throw new ConnectorCallError(
            "invalid_args",
            snooze ? "action snooze needs snoozeDays." : "snoozeDays applies only to action snooze.",
          );
        }
        await call(
          {
            method: "POST",
            path: `/people/v2/people/${segment(args["personId"])}/workflow_cards/${segment(args["cardId"])}/${String(args["action"])}`,
            ...(snooze ? { body: { data: { attributes: { duration: args["snoozeDays"] } } } } : {}),
          },
          ctx,
        );
        return { cardId: String(args["cardId"]), action: String(args["action"]), applied: true };
      },
    },
    {
      name: "add_workflow_card_note",
      description: "Add a note to one workflow card's activity. Notifies nobody by itself and does not move the card.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          personId: { ...PERSON_ID, description: "The card's person_id from list_workflow_cards." },
          cardId: idProperty("Workflow card id from list_workflow_cards."),
          note: { type: "string", minLength: 1, description: "Note text." },
        },
        ["personId", "cardId", "note"],
      ),
      outputSchema: record({ id: STRING, note: STRING, created_at: STRING }),
      handler: async (args: JsonRecord, ctx) =>
        pick(
          created(
            await call(
              {
                method: "POST",
                path: `/people/v2/people/${segment(args["personId"])}/workflow_cards/${segment(args["cardId"])}/notes`,
                body: writeDocument("WorkflowCardNote", { note: args["note"] }),
              },
              ctx,
            ),
            "card note",
          ),
          ["note", "created_at"],
        ),
    },
    list({
      name: "list_person_notes",
      description:
        "List the notes on one person's profile with their category names, newest first by default. Workflow card notes are not profile notes.",
      key: "notes",
      item: NOTE_SCHEMA,
      properties: {
        personId: PERSON_ID,
        noteCategoryId: idProperty("Only notes in this category (/people/v2/note_categories)."),
        order: orderProperty(["created_at", "display_date"]),
      },
      required: ["personId"],
      path: (args) => `/people/v2/people/${segment(args["personId"])}/notes`,
      query: (args) => ({ "where[note_category_id]": args["noteCategoryId"], order: args["order"] ?? "-created_at" }),
      include: "category",
      project: noteRecord,
    }),
    {
      name: "add_person_note",
      description:
        "Add a note to a person's profile in a note category. Category subscribers may be notified; read categories at /people/v2/note_categories.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          personId: PERSON_ID,
          note: { type: "string", minLength: 1, description: "Note text." },
          noteCategoryId: idProperty("Note category id; Planning Center files every note under one."),
        },
        ["personId", "note", "noteCategoryId"],
      ),
      outputSchema: NOTE_SCHEMA,
      handler: async (args: JsonRecord, ctx) =>
        noteRecord(
          created(
            await call(
              {
                method: "POST",
                path: `/people/v2/people/${segment(args["personId"])}/notes`,
                body: writeDocument("Note", { note: args["note"], note_category_id: args["noteCategoryId"] }),
              },
              ctx,
            ),
            "note",
          ),
          new Map(),
        ),
    },
    list({
      name: "list_person_field_data",
      description:
        "List one person's custom field values, each labeled with its field name and data type. Writing a value is pco_api_mutate at /people/v2/field_data.",
      key: "fields",
      item: record({
        id: STRING,
        field_definition_id: STRING,
        field: NULLABLE_STRING,
        data_type: NULLABLE_STRING,
        value: NULLABLE_STRING,
        file_name: NULLABLE_STRING,
      }),
      properties: { personId: PERSON_ID },
      required: ["personId"],
      path: (args) => `/people/v2/people/${segment(args["personId"])}/field_data`,
      include: "field_definition",
      project: (row, index) => {
        const definition = related(row, "field_definition", index);
        return {
          id: row.id,
          field_definition_id: relId(row, "field_definition") ?? null,
          field: attribute(definition, "name") ?? null,
          data_type: attribute(definition, "data_type") ?? null,
          value: attribute(row, "value") ?? null,
          file_name: attribute(row, "file_name") ?? null,
        };
      },
    }),
    list({
      name: "list_forms",
      description: "List People forms with their submission counts and public URLs. Archived forms are excluded unless asked for.",
      key: "forms",
      item: record({
        id: STRING,
        name: STRING,
        description: NULLABLE_STRING,
        active: BOOLEAN,
        submission_count: INTEGER,
        public_url: NULLABLE_STRING,
        archived_at: NULLABLE_STRING,
      }),
      properties: { includeArchived: { type: "boolean", description: "Include archived forms." } },
      path: () => "/people/v2/forms",
      query: (args) => ({ filter: args["includeArchived"] === true ? undefined : "not_archived" }),
      project: (row) => pick(row, ["name", "description", "active", "submission_count", "public_url", "archived_at"]),
    }),
    list({
      name: "list_form_submissions",
      description:
        "List one form's submissions with each answer labeled by its field, newest first by default. Read-only; the API cannot submit a form.",
      key: "submissions",
      item: record({
        id: STRING,
        created_at: STRING,
        person_id: NULLABLE_STRING,
        person_name: NULLABLE_STRING,
        values: { type: "array", items: record({ field: NULLABLE_STRING, value: NULLABLE_STRING }, []) },
      }),
      properties: {
        formId: idProperty("Form id from list_forms."),
        submittedAfter: dateProperty("Only submissions created at or after this time."),
        order: orderProperty(["created_at"]),
      },
      required: ["formId"],
      path: (args) => `/people/v2/forms/${segment(args["formId"])}/form_submissions`,
      query: (args) => ({ "where[created_at][gte]": args["submittedAfter"], order: args["order"] ?? "-created_at" }),
      include: "form_submission_values,form_fields,person",
      project: (row, index) => {
        const person = related(row, "person", index);
        const values = relatedMany(row, "form_submission_values", index);
        return {
          id: row.id,
          created_at: attribute(row, "created_at"),
          person_id: relId(row, "person") ?? null,
          person_name: attribute(person, "name") ?? null,
          values: values.map((value) => ({
            field: attribute(related(value, "form_field", index), "label") ?? null,
            value: attribute(value, "display_value") ?? attribute(value, "value") ?? null,
          })),
        };
      },
    }),

    // --- Services -----------------------------------------------------------
    list({
      name: "list_service_types",
      description: "List Services service types — the recurring services such as Sunday Morning. Supplies serviceTypeId for plans and teams.",
      key: "serviceTypes",
      item: record({ id: STRING, name: STRING, frequency: NULLABLE_STRING, sequence: NULLABLE_INTEGER, parent_id: NULLABLE_STRING }),
      path: () => "/services/v2/service_types",
      query: () => ({ order: "sequence" }),
      project: (row) => ({ ...pick(row, ["name", "frequency", "sequence"]), parent_id: relId(row, "parent") ?? null }),
    }),
    list({
      name: "list_plans",
      description:
        "List one service type's plans (individual services) by date. Defaults to upcoming plans, soonest first; get_plan returns the order of service and team.",
      key: "plans",
      item: record({
        id: STRING,
        title: NULLABLE_STRING,
        series_title: NULLABLE_STRING,
        dates: STRING,
        sort_date: NULLABLE_STRING,
        items_count: INTEGER,
        plan_people_count: INTEGER,
        needed_positions_count: INTEGER,
        planning_center_url: STRING,
      }),
      properties: {
        serviceTypeId: SERVICE_TYPE_ID,
        when: { type: "string", enum: ["future", "past", "all"], description: "future (default) sorts soonest first; past sorts most recent first." },
      },
      required: ["serviceTypeId"],
      path: (args) => `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans`,
      query: (args) => {
        const when = args["when"] ?? "future";
        return {
          filter: when === "all" ? undefined : when,
          order: when === "past" ? "-sort_date" : "sort_date",
        };
      },
      project: (row) =>
        pick(row, [
          "title",
          "series_title",
          "dates",
          "sort_date",
          "items_count",
          "plan_people_count",
          "needed_positions_count",
          "planning_center_url",
        ]),
    }),
    {
      name: "get_plan",
      description:
        "Get one plan with its times, order of service, and scheduled team in a single call. Flags a section past 100 rows rather than dropping it silently.",
      annotations: READ,
      inputSchema: input({ serviceTypeId: SERVICE_TYPE_ID, planId: PLAN_ID, raw: RAW_PROPERTY }, ["serviceTypeId", "planId"]),
      outputSchema: {
        type: "object",
        properties: {
          plan: OBJECT,
          items: { type: "array", items: ITEM_SCHEMA },
          teamMembers: { type: "array", items: PLAN_PERSON_SCHEMA },
          itemsTruncated: BOOLEAN,
          teamMembersTruncated: BOOLEAN,
        },
        required: ["plan", "items", "teamMembers", "itemsTruncated", "teamMembersTruncated"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const base = `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans/${segment(args["planId"])}`;
        const [planDocument, itemDocument, teamDocument] = (await Promise.all([
          call({ method: "GET", path: base, query: { include: "plan_times" } }, ctx),
          call({ method: "GET", path: `${base}/items`, query: { per_page: MAX_PAGE_SIZE } }, ctx),
          call({ method: "GET", path: `${base}/team_members`, query: { include: "team", per_page: MAX_PAGE_SIZE } }, ctx),
        ])).map(asRecord) as [JsonRecord, JsonRecord, JsonRecord];
        const plan = created(planDocument, "plan record");
        const items = resources(itemDocument["data"]);
        const members = resources(teamDocument["data"]);
        const truncation = {
          itemsTruncated: pageOf(itemDocument).hasMore,
          teamMembersTruncated: pageOf(teamDocument).hasMore,
        };
        if (args["raw"] === true) {
          return {
            plan: { ...plan, included: asArray(planDocument["included"]) },
            items,
            teamMembers: members,
            ...truncation,
          };
        }
        const planIndex = indexIncluded(planDocument);
        const teamIndex = indexIncluded(teamDocument);
        return {
          plan: {
            ...pick(plan, ["title", "series_title", "dates", "sort_date", "total_length", "needed_positions_count", "planning_center_url"]),
            times: relatedMany(plan, "plan_times", planIndex).map((time) =>
              pick(time, ["name", "time_type", "starts_at", "ends_at"]),
            ),
          },
          items: items
            .map(itemRecord)
            .sort((a, b) => Number(a["sequence"] ?? 0) - Number(b["sequence"] ?? 0)),
          teamMembers: members.map((member) => planPersonRecord(member, teamIndex)),
          ...truncation,
        };
      },
    },
    list({
      name: "list_teams",
      description: "List one service type's teams with their positions. Supplies teamId and position names for schedule_plan_person.",
      key: "teams",
      item: record({ id: STRING, name: STRING, archived_at: NULLABLE_STRING, positions: ARRAY }),
      properties: { serviceTypeId: SERVICE_TYPE_ID },
      required: ["serviceTypeId"],
      path: (args) => `/services/v2/service_types/${segment(args["serviceTypeId"])}/teams`,
      include: "team_positions",
      project: (row, index) => ({
        ...pick(row, ["name", "archived_at"]),
        positions: relatedMany(row, "team_positions", index).map((position) => pick(position, ["name"])),
      }),
    }),
    list({
      name: "list_person_schedules",
      description:
        "List where one person is scheduled to serve across every service type, with team, position, and response. Defaults to upcoming.",
      key: "schedules",
      item: record({
        id: STRING,
        dates: STRING,
        sort_date: NULLABLE_STRING,
        service_type_name: STRING,
        team_name: NULLABLE_STRING,
        team_position_name: NULLABLE_STRING,
        status: STRING,
        decline_reason: NULLABLE_STRING,
        plan_id: NULLABLE_STRING,
      }),
      properties: {
        personId: PERSON_ID,
        when: { type: "string", enum: ["future", "past"], description: "future (default) or past schedules." },
      },
      required: ["personId"],
      path: (args) => `/services/v2/people/${segment(args["personId"])}/schedules`,
      query: (args) => ({ filter: args["when"] ?? "future", order: args["when"] === "past" ? "-starts_at" : "starts_at" }),
      project: (row) => ({
        ...pick(row, ["dates", "sort_date", "service_type_name", "team_name", "team_position_name", "status", "decline_reason"]),
        plan_id: relId(row, "plan") ?? null,
      }),
    }),
    {
      name: "schedule_plan_person",
      description:
        "Schedule a person on a plan's team, unconfirmed by default. Prepares a notification only when asked; Planning Center sends it, not this call.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          serviceTypeId: SERVICE_TYPE_ID,
          planId: PLAN_ID,
          personId: PERSON_ID,
          teamId: idProperty("Team id from list_teams."),
          teamPositionName: { type: "string", minLength: 1, description: "Position name from list_teams positions[].name." },
          status: { type: "string", enum: ["U", "C"], description: "U unconfirmed (default) or C confirmed." },
          prepareNotification: { type: "boolean", description: "Queue Planning Center's scheduling notification for this person." },
          notes: { type: "string", description: "Note shown to the person." },
        },
        ["serviceTypeId", "planId", "personId", "teamId"],
      ),
      outputSchema: PLAN_PERSON_SCHEMA,
      handler: async (args: JsonRecord, ctx) =>
        planPersonRecord(
          created(
            await call(
              {
                method: "POST",
                path: `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans/${segment(args["planId"])}/team_members`,
                body: writeDocument("PlanPerson", {
                  person_id: args["personId"],
                  team_id: args["teamId"],
                  team_position_name: args["teamPositionName"],
                  status: args["status"] ?? "U",
                  prepare_notification: args["prepareNotification"],
                  notes: args["notes"],
                }),
              },
              ctx,
            ),
            "scheduled person",
          ),
          new Map(),
        ),
    },
    {
      name: "add_plan_item",
      description:
        "Add an item — a song, header, or other element — to a plan's order of service. A songId makes a song item; media_ids, set through pco_api_mutate, make a media item.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          serviceTypeId: SERVICE_TYPE_ID,
          planId: PLAN_ID,
          title: { type: "string", minLength: 1, description: "Item title; for a song, usually the song title." },
          itemType: {
            type: "string",
            enum: ["item", "header"],
            description:
              "header for a section header, fixed at creation; item (the default) for anything else. Song and media types follow from what is attached, never this.",
          },
          songId: idProperty("Song id from list_songs, for a song item."),
          arrangementId: idProperty("Arrangement id from list_song_arrangements."),
          keyId: idProperty("Key id from list_song_arrangements keys[].id."),
          length: { type: "integer", minimum: 0, maximum: 86_400, description: "Length in seconds." },
          sequence: { type: "integer", minimum: 0, description: "Position in the order; omit to append." },
          servicePosition: { type: "string", enum: ["pre", "during", "post"], description: "Before, during, or after the service. Defaults to during." },
          description: { type: "string", description: "Item description." },
        },
        ["serviceTypeId", "planId", "title"],
      ),
      outputSchema: ITEM_SCHEMA,
      handler: async (args: JsonRecord, ctx) =>
        itemRecord(
          created(
            await call(
              {
                method: "POST",
                path: `/services/v2/service_types/${segment(args["serviceTypeId"])}/plans/${segment(args["planId"])}/items`,
                body: writeDocument("Item", {
                  title: args["title"],
                  // Planning Center assigns only `header`; omitting it is `item`.
                  item_type: args["itemType"] === "header" ? "header" : undefined,
                  song_id: args["songId"],
                  arrangement_id: args["arrangementId"],
                  key_id: args["keyId"],
                  length: args["length"],
                  sequence: args["sequence"],
                  service_position: args["servicePosition"],
                  description: args["description"],
                }),
              },
              ctx,
            ),
            "plan item",
          ),
        ),
    },
    list({
      name: "list_songs",
      description: "Search the Services song library by title, author, CCLI number, or theme. Lyrics and chord charts live on arrangements.",
      key: "songs",
      item: record({
        id: STRING,
        title: STRING,
        author: NULLABLE_STRING,
        ccli_number: NULLABLE_INTEGER,
        themes: NULLABLE_STRING,
        hidden: BOOLEAN,
        last_scheduled_at: NULLABLE_STRING,
      }),
      properties: {
        title: { type: "string", minLength: 1, description: "Song title; end it with % for a prefix match." },
        author: { type: "string", minLength: 1, description: "Author." },
        ccliNumber: { type: "integer", minimum: 1, description: "CCLI song number." },
        theme: { type: "string", minLength: 1, description: "Theme." },
        order: orderProperty(["title", "last_scheduled_at"]),
      },
      path: () => "/services/v2/songs",
      query: (args) => ({
        "where[title]": args["title"],
        "where[author]": args["author"],
        "where[ccli_number]": args["ccliNumber"],
        "where[themes]": args["theme"],
        order: args["order"],
      }),
      project: (row) => pick(row, ["title", "author", "ccli_number", "themes", "hidden", "last_scheduled_at"]),
    }),
    list({
      name: "list_song_arrangements",
      description: "List one song's arrangements with tempo, meter, sequence, and keys. Supplies arrangementId and keyId for add_plan_item.",
      key: "arrangements",
      item: record({
        id: STRING,
        name: STRING,
        bpm: { type: ["number", "null"] },
        meter: NULLABLE_STRING,
        length: NULLABLE_INTEGER,
        chord_chart_key: NULLABLE_STRING,
        sequence_short: ARRAY,
        keys: ARRAY,
      }),
      properties: { songId: idProperty("Song id from list_songs.") },
      required: ["songId"],
      path: (args) => `/services/v2/songs/${segment(args["songId"])}/arrangements`,
      include: "keys",
      project: (row, index) => ({
        ...pick(row, ["name", "bpm", "meter", "length", "chord_chart_key", "sequence_short"]),
        keys: relatedMany(row, "keys", index).map((key) => pick(key, ["name", "starting_key", "ending_key"])),
      }),
    }),

    // --- Groups -------------------------------------------------------------
    list({
      name: "list_groups",
      description: "List Groups groups with type, schedule, and member count. Archived groups are excluded unless asked for; the API cannot create a group.",
      key: "groups",
      item: record({
        id: STRING,
        name: STRING,
        memberships_count: INTEGER,
        schedule: NULLABLE_STRING,
        group_type_id: NULLABLE_STRING,
        contact_email: NULLABLE_STRING,
        archived_at: NULLABLE_STRING,
        public_church_center_web_url: NULLABLE_STRING,
      }),
      properties: {
        name: { type: "string", minLength: 1, description: "Exact group name; end it with % for a prefix match." },
        groupTypeId: idProperty("Only groups of this type (/groups/v2/group_types)."),
        archived: { type: "string", enum: ["exclude", "include", "only"], description: "Archived groups: exclude (default), include, or only." },
        order: orderProperty(["name", "created_at", "memberships_count"]),
      },
      path: () => "/groups/v2/groups",
      query: (args) => ({
        "where[name]": args["name"],
        "where[group_type][id]": args["groupTypeId"],
        "where[archive_status]": args["archived"] === "include" || args["archived"] === "only" ? args["archived"] : undefined,
        order: args["order"],
      }),
      project: (row) => ({
        ...pick(row, ["name", "memberships_count", "schedule", "contact_email", "archived_at", "public_church_center_web_url"]),
        group_type_id: relId(row, "group_type") ?? null,
      }),
    }),
    list({
      name: "list_group_memberships",
      description: "List one group's members and leaders with their names and join dates. Contact details come from get_person with person_id.",
      key: "memberships",
      item: MEMBERSHIP_SCHEMA,
      properties: {
        groupId: idProperty("Group id from list_groups."),
        role: { type: "string", enum: ["member", "leader"], description: "Only members or only leaders." },
        order: orderProperty(["last_name", "first_name", "joined_at", "role"]),
      },
      required: ["groupId"],
      path: (args) => `/groups/v2/groups/${segment(args["groupId"])}/memberships`,
      query: (args) => ({ "where[role]": args["role"], order: args["order"] }),
      include: "person",
      project: membershipRecord,
    }),
    {
      name: "add_group_member",
      description: "Add a person to a group as a member or leader. Fails when they already belong; change a role or remove someone with pco_api_mutate.",
      annotations: ADDITIVE,
      inputSchema: input(
        {
          groupId: idProperty("Group id from list_groups."),
          personId: PERSON_ID,
          role: { type: "string", enum: ["member", "leader"], description: "Defaults to member." },
          joinedAt: dateProperty("When they joined. Defaults to now."),
        },
        ["groupId", "personId"],
      ),
      outputSchema: MEMBERSHIP_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const document = asRecord(
          await call(
            {
              method: "POST",
              path: `/groups/v2/groups/${segment(args["groupId"])}/memberships`,
              query: { include: "person" },
              body: writeDocument("Membership", {
                person_id: args["personId"],
                role: args["role"] ?? "member",
                joined_at: args["joinedAt"],
              }),
            },
            ctx,
          ),
        );
        return membershipRecord(created(document, "membership"), indexIncluded(document));
      },
    },
    list({
      name: "list_group_events",
      description: "List Groups meetings in a date range, for one group or all groups. Read-only: the API cannot create events or record attendance.",
      key: "events",
      item: record({
        id: STRING,
        name: STRING,
        starts_at: STRING,
        ends_at: NULLABLE_STRING,
        canceled: BOOLEAN,
        group_id: NULLABLE_STRING,
        visitors_count: NULLABLE_INTEGER,
        virtual_location_url: NULLABLE_STRING,
      }),
      properties: {
        groupId: idProperty("One group's events. Omit for every group."),
        startsAfter: dateProperty("Only events starting at or after this time."),
        startsBefore: dateProperty("Only events starting before this time."),
        includeCanceled: { type: "boolean", description: "Include canceled events." },
      },
      path: (args) => args["groupId"] ? `/groups/v2/groups/${segment(args["groupId"])}/events` : "/groups/v2/events",
      query: (args) => ({
        ...range(["starts_at"], args["startsAfter"], args["startsBefore"]),
        filter: args["includeCanceled"] === true ? undefined : "not_canceled",
        order: "starts_at",
      }),
      project: (row) => ({
        ...pick(row, ["name", "starts_at", "ends_at", "canceled", "visitors_count", "virtual_location_url"]),
        group_id: relId(row, "group") ?? null,
      }),
    }),

    // --- Check-Ins (read-only product) ---------------------------------------
    list({
      name: "list_check_in_events",
      description: "List Check-Ins events, the recurring things people check in to. Supplies eventId for event periods and check-ins.",
      key: "events",
      item: record({ id: STRING, name: STRING, frequency: NULLABLE_STRING, archived_at: NULLABLE_STRING }),
      properties: {
        name: { type: "string", minLength: 1, description: "Exact event name; end it with % for a prefix match." },
        includeArchived: { type: "boolean", description: "Include archived events." },
      },
      path: () => "/check-ins/v2/events",
      query: (args) => ({ "where[name]": args["name"], filter: args["includeArchived"] === true ? undefined : "not_archived" }),
      project: (row) => pick(row, ["name", "frequency", "archived_at"]),
    }),
    list({
      name: "list_check_in_event_periods",
      description:
        "List one Check-Ins event's dated occurrences with regular, guest, and volunteer counts — the cheapest attendance answer. Newest first.",
      key: "periods",
      item: record({
        id: STRING,
        starts_at: STRING,
        ends_at: NULLABLE_STRING,
        regular_count: INTEGER,
        guest_count: INTEGER,
        volunteer_count: INTEGER,
        unique_total_count: NULLABLE_INTEGER,
        note: NULLABLE_STRING,
      }),
      properties: {
        eventId: idProperty("Check-Ins event id from list_check_in_events."),
        startsAfter: dateProperty("Only periods starting at or after this time."),
        startsBefore: dateProperty("Only periods starting before this time."),
      },
      required: ["eventId"],
      path: (args) => `/check-ins/v2/events/${segment(args["eventId"])}/event_periods`,
      query: (args) => ({ ...range(["starts_at"], args["startsAfter"], args["startsBefore"]), order: "-starts_at" }),
      project: (row) =>
        pick(row, ["starts_at", "ends_at", "regular_count", "guest_count", "volunteer_count", "unique_total_count", "note"]),
    }),
    list({
      name: "list_check_ins",
      description:
        "List individual check-ins, scoped by service date through the event period. Read-only: the API cannot check anyone in or out.",
      key: "checkIns",
      item: record({
        id: STRING,
        first_name: STRING,
        last_name: STRING,
        kind: STRING,
        number: NULLABLE_INTEGER,
        security_code: NULLABLE_STRING,
        created_at: STRING,
        checked_out_at: NULLABLE_STRING,
        one_time_guest: BOOLEAN,
        person_id: NULLABLE_STRING,
        event_period_id: NULLABLE_STRING,
      }),
      properties: {
        eventId: idProperty("Only this Check-Ins event. Omit for every event."),
        serviceAfter: dateProperty("Only check-ins whose event period starts at or after this time."),
        serviceBefore: dateProperty("Only check-ins whose event period starts before this time."),
        kind: { type: "string", enum: ["regular", "guest", "volunteer"], description: "Only this kind of check-in." },
        order: orderProperty(["created_at", "last_name", "first_name"]),
      },
      path: (args) => args["eventId"] ? `/check-ins/v2/events/${segment(args["eventId"])}/check_ins` : "/check-ins/v2/check_ins",
      query: (args) => ({
        ...range(["event_period", "starts_at"], args["serviceAfter"], args["serviceBefore"]),
        filter: args["kind"],
        order: args["order"],
      }),
      project: (row) => ({
        ...pick(row, ["first_name", "last_name", "kind", "number", "security_code", "created_at", "checked_out_at", "one_time_guest"]),
        person_id: relId(row, "person") ?? null,
        event_period_id: relId(row, "event_period") ?? null,
      }),
    }),

    // --- Calendar (events read-only) ----------------------------------------
    list({
      name: "list_calendar_event_instances",
      description:
        "List what is on the Calendar in a date range: each occurrence with times and location, recurrence expanded. Events cannot be written through the API.",
      key: "instances",
      item: record({
        id: STRING,
        name: NULLABLE_STRING,
        starts_at: STRING,
        ends_at: STRING,
        all_day_event: BOOLEAN,
        location: NULLABLE_STRING,
        kind: NULLABLE_STRING,
        recurrence_description: NULLABLE_STRING,
        event_id: NULLABLE_STRING,
        church_center_url: NULLABLE_STRING,
      }),
      properties: {
        startsAfter: dateProperty("Only occurrences starting at or after this time."),
        startsBefore: dateProperty("Only occurrences starting before this time."),
        eventName: { type: "string", minLength: 1, description: "Exact event name; end it with % for a prefix match." },
      },
      path: () => "/calendar/v2/event_instances",
      query: (args) => ({
        ...range(["starts_at"], args["startsAfter"], args["startsBefore"]),
        "where[event_name]": args["eventName"],
        order: "starts_at",
      }),
      project: (row) => ({
        ...pick(row, ["name", "starts_at", "ends_at", "all_day_event", "location", "kind", "recurrence_description", "church_center_url"]),
        event_id: relId(row, "event") ?? null,
      }),
    }),

    // --- Registrations (read-only product) ----------------------------------
    list({
      name: "list_signups",
      description: "List Registrations signups (registration events) with open, close, and capacity state. Read-only: the API cannot register anyone.",
      key: "signups",
      item: record({
        id: STRING,
        name: STRING,
        open: BOOLEAN,
        closed: BOOLEAN,
        open_at: NULLABLE_STRING,
        close_at: NULLABLE_STRING,
        maximum_capacity: NULLABLE_INTEGER,
        at_maximum_capacity: BOOLEAN,
        archived: BOOLEAN,
        new_registration_url: NULLABLE_STRING,
      }),
      properties: {
        archived: { type: "string", enum: ["unarchived", "archived", "all"], description: "unarchived (default), archived, or all." },
      },
      path: () => "/registrations/v2/signups",
      query: (args) => ({ filter: args["archived"] === "all" ? undefined : (args["archived"] ?? "unarchived") }),
      project: (row) =>
        pick(row, ["name", "open", "closed", "open_at", "close_at", "maximum_capacity", "at_maximum_capacity", "archived", "new_registration_url"]),
    }),
    list({
      name: "list_signup_attendees",
      description: "List one signup's attendees with active, waitlisted, and canceled state. person_id joins them to People.",
      key: "attendees",
      item: record({
        id: STRING,
        name: NULLABLE_STRING,
        active: BOOLEAN,
        waitlisted: BOOLEAN,
        canceled: BOOLEAN,
        complete: BOOLEAN,
        created_at: STRING,
        person_id: NULLABLE_STRING,
      }),
      properties: {
        signupId: idProperty("Signup id from list_signups."),
        status: { type: "string", enum: ["active", "waitlist", "canceled"], description: "Only attendees in this state." },
      },
      required: ["signupId"],
      path: (args) => `/registrations/v2/signups/${segment(args["signupId"])}/attendees`,
      query: (args) => ({ filter: args["status"] }),
      include: "person",
      project: (row) => ({
        ...pick(row, ["name", "active", "waitlisted", "canceled", "complete", "created_at"]),
        person_id: relId(row, "person") ?? null,
      }),
    }),

    // --- Giving (reads; money moves only through pco_api_mutate) -------------
    list({
      name: "list_donations",
      description:
        "List Giving donations with their fund designations, newest first, by date, fund, or donor. Amounts are integer cents. Read-only.",
      key: "donations",
      item: DONATION_SCHEMA,
      properties: {
        personId: idProperty("Only this donor's donations."),
        receivedAfter: dateProperty("Only donations received at or after this time."),
        receivedBefore: dateProperty("Only donations received before this time."),
        fundId: idProperty("Only donations designated to this fund (list_funds)."),
        succeededOnly: { type: "boolean", description: "Exclude pending and failed card or ACH payments." },
        order: orderProperty(["received_at", "created_at", "updated_at"]),
      },
      path: (args) => args["personId"] ? `/giving/v2/people/${segment(args["personId"])}/donations` : "/giving/v2/donations",
      query: (args) => ({
        ...range(["received_at"], args["receivedAfter"], args["receivedBefore"]),
        "where[fund_id]": args["fundId"],
        filter: args["succeededOnly"] === true ? "succeeded" : undefined,
        order: args["order"] ?? "-received_at",
      }),
      include: "designations,designations.fund",
      project: donationRecord,
    }),
    list({
      name: "list_funds",
      description: "List Giving funds with ledger codes and visibility. Supplies fundId for donation filters.",
      key: "funds",
      item: record({ id: STRING, name: STRING, ledger_code: NULLABLE_STRING, visibility: STRING, default: BOOLEAN, description: NULLABLE_STRING }),
      path: () => "/giving/v2/funds",
      project: (row) => pick(row, ["name", "ledger_code", "visibility", "default", "description"]),
    }),
    list({
      name: "list_batches",
      description: "List Giving batches with totals and commit state, most recently updated first. Committing a batch is pco_api_mutate.",
      key: "batches",
      item: record({
        id: STRING,
        description: NULLABLE_STRING,
        status: STRING,
        donations_count: INTEGER,
        total_cents: INTEGER,
        total_currency: STRING,
        committed_at: NULLABLE_STRING,
        created_at: STRING,
        batch_group_id: NULLABLE_STRING,
      }),
      properties: {
        status: { type: "string", enum: ["committed", "in_progress"], description: "Only committed or in-progress batches." },
      },
      path: () => "/giving/v2/batches",
      query: (args) => ({ filter: args["status"], order: "-updated_at" }),
      project: (row) => ({
        ...pick(row, ["description", "status", "donations_count", "total_cents", "total_currency", "committed_at", "created_at"]),
        batch_group_id: relId(row, "batch_group") ?? null,
      }),
    }),
    list({
      name: "list_pledge_campaigns",
      description: "List Giving pledge campaigns with goal and received totals in cents. Supplies pledgeCampaignId for list_pledges.",
      key: "campaigns",
      item: record({
        id: STRING,
        name: STRING,
        starts_at: NULLABLE_STRING,
        ends_at: NULLABLE_STRING,
        goal_cents: NULLABLE_INTEGER,
        received_total_from_pledges_cents: INTEGER,
        received_total_outside_of_pledges_cents: INTEGER,
        fund_id: NULLABLE_STRING,
      }),
      path: () => "/giving/v2/pledge_campaigns",
      query: () => ({ order: "-starts_at" }),
      project: (row) => ({
        ...pick(row, [
          "name",
          "starts_at",
          "ends_at",
          "goal_cents",
          "received_total_from_pledges_cents",
          "received_total_outside_of_pledges_cents",
        ]),
        fund_id: relId(row, "fund") ?? null,
      }),
    }),
    list({
      name: "list_pledges",
      description: "List the pledges in one Giving pledge campaign with pledged and donated totals in cents per donor.",
      key: "pledges",
      item: record({
        id: STRING,
        amount_cents: INTEGER,
        donated_total_cents: INTEGER,
        joint_giver_amount_cents: NULLABLE_INTEGER,
        person_id: NULLABLE_STRING,
        created_at: STRING,
      }),
      properties: { pledgeCampaignId: idProperty("Pledge campaign id from list_pledge_campaigns.") },
      required: ["pledgeCampaignId"],
      path: (args) => `/giving/v2/pledge_campaigns/${segment(args["pledgeCampaignId"])}/pledges`,
      project: (row) => ({
        ...pick(row, ["amount_cents", "donated_total_cents", "joint_giver_amount_cents", "created_at"]),
        person_id: relId(row, "person") ?? null,
      }),
    }),
    list({
      name: "list_recurring_donations",
      description: "List Giving recurring donations with schedule, status, next occurrence, and fund designations. Read-only; amounts in cents.",
      key: "recurringDonations",
      item: record({
        id: STRING,
        amount_cents: INTEGER,
        amount_currency: STRING,
        schedule: NULLABLE_STRING,
        status: STRING,
        next_occurrence: NULLABLE_STRING,
        last_donation_received_at: NULLABLE_STRING,
        person_id: NULLABLE_STRING,
        designations: DESIGNATIONS,
      }),
      properties: { status: { type: "string", minLength: 1, description: "Status as Planning Center reports it, e.g. active." } },
      path: () => "/giving/v2/recurring_donations",
      query: (args) => ({ "where[status]": args["status"] }),
      include: "designations,designations.fund",
      project: (row, index) => ({
        ...pick(row, ["amount_cents", "amount_currency", "schedule", "status", "next_occurrence", "last_donation_received_at"]),
        person_id: relId(row, "person") ?? null,
        designations: designations(row, index),
      }),
    }),

    // --- Webhooks -----------------------------------------------------------
    {
      name: "list_webhook_subscriptions",
      description:
        "List the organization's webhook subscriptions: event name, URL, and active state. Never returns the signing secret; that needs pco_api_get.",
      annotations: READ,
      inputSchema: input({ perPage: perPageProperty(defaultPageSize), offset: OFFSET_PROPERTY }),
      outputSchema: listOutput(
        "subscriptions",
        record({ id: STRING, name: STRING, url: STRING, active: BOOLEAN, application_id: NULLABLE_STRING, created_at: STRING }),
      ),
      handler: async (args: JsonRecord, ctx) => {
        const document = asRecord(
          await call(
            { method: "GET", path: "/webhooks/v2/webhook_subscriptions", query: { per_page: perPage(args), offset: args["offset"] } },
            ctx,
          ),
        );
        // `authenticity_secret` verifies deliveries. A projection is the
        // place it never appears, so this read has no `raw` mode.
        return {
          subscriptions: resources(document["data"]).map((row) =>
            pick(row, ["name", "url", "active", "application_id", "created_at"]),
          ),
          page: pageOf(document),
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Guide and construction
// ---------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const organizationInstructions = instructions?.trim();
  return `# Planning Center usage

Planning Center Online church management — People, Services, Groups, Check-Ins, Calendar, Registrations, Giving, Publishing, Webhooks — for: ${purpose}

## Identity first

- A person id is the join key across every product: the id \`search_people\` returns is the \`personId\` for Services schedules, Groups memberships, Giving donations, and Check-Ins. Resolve ids with list tools; never guess one.
- A person id that used to resolve and now answers \`not_found\` was most likely merged. Read \`/people/v2/person_mergers\` with \`where[person_to_remove_id]\` and follow \`person_to_keep_id\`.
- \`get_me\` names the user this token acts as. Every read and write runs with that user's permissions, product by product; a \`connector_call_failed\` naming permission means the user cannot, not that the call was wrong.

## Results and paging

- Records keep Planning Center's own snake_case attribute names; a relationship appears as \`<relationship>_id\`. Pass \`raw: true\` for the untouched JSON:API resources and \`included\`.
- Lists page by offset: \`perPage\` up to 100, then pass \`page.nextOffset\` back as \`offset\` while \`page.hasMore\` is true. \`page.totalCount\` answers "how many" without paging — request \`perPage: 1\`.
- A bare date in a date filter is the organization's local day; pass a full timestamp for exact bounds. Name filters are exact; end one with \`%\` for a prefix match.
- \`get_plan\` fetches the plan, its items, and its team in one call and sets \`itemsTruncated\`/\`teamMembersTruncated\` past 100 rows; page the rest with \`pco_api_get\`.

## What each product lets the API write

- People: full read/write. \`update_person\` with \`status: inactive\` archives reversibly; a DELETE is permanent and only reachable through \`pco_api_mutate\`. \`run_list\` can fire list automations.
- Services: full read/write. A plan's dates come from its plan times. Scheduling needs a team.
- Groups: memberships and group settings are writable; groups cannot be created, and events and attendance are read-only.
- Check-Ins and Registrations: read-only. Nobody can be checked in or registered through the API.
- Calendar: events, instances, and times are read-only; tags, resources, rooms, and folders are writable through \`pco_api_mutate\`.
- Giving: the named tools only read, amounts in integer cents. Creating or editing donations, refunds, and committing a batch move money and go through \`pco_api_mutate\`.
- Publishing and the \`api\` product (organization, OAuth applications, personal access tokens) have no named tools; use the hatches.

## The hatches

- \`pco_api_get\` reaches any GET; \`pco_api_mutate\` any POST, PATCH, or DELETE, always approval-gated. Paths start \`/<app>/v2\`, exactly as Planning Center documents them; the connector owns host, auth, content type, and the \`X-PCO-API-Version\` header.
- Bodies are JSON:API documents: \`{"data":{"type":"Email","attributes":{...}}}\`. \`null\` clears an attribute; an omitted key is left alone.
- Each product is pinned to a reviewed API version: ${PLANNING_CENTER_APPS.map((app) => `${app} ${PLANNING_CENTER_API_VERSIONS[app]}`).join(", ")}. Pass \`version\` only for an endpoint those versions lack.
- Query parameters are name/value pairs with literal brackets: \`where[status]\`, \`include\`, \`order\`, \`filter\`, \`fields[Person]\`. Every list response's \`meta\` names the \`can_query_by\`, \`can_order_by\`, and \`can_include\` values for that endpoint; an unknown \`where\` key is ignored rather than refused.
- File uploads go to a separate host (upload.planningcenteronline.com), which this connection does not reach.

## Rate limits

Planning Center allows 100 requests per 20 seconds per user, shared by every integration running as that user. This connection admits 100 calls per 20 seconds, five at a time, per runtime — an approximation, not a guarantee. A \`rate_limited\` failure carries Planning Center's wait. Filter server-side and use \`totalCount\` rather than paging to count.
${
    organizationInstructions
      ? `\n## Organization instructions\n\n${organizationInstructions}\n`
      : ""
  }`;
}

/** A maintained Planning Center Online connection over the REST API. */
export function planningCenter(id: string, options: PlanningCenterOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("planningCenter() requires a non-empty organization purpose.");
  }
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(defaultPageSize) || defaultPageSize < 1 || defaultPageSize > MAX_PAGE_SIZE) {
    throw new Error(
      `planningCenter() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  const userAgent = options.userAgent?.trim() ?? DEFAULT_USER_AGENT;
  if (!userAgent || /[\r\n]/.test(userAgent)) {
    throw new Error("planningCenter() userAgent must be a non-empty single line.");
  }
  const auth = PERSONAL_ACCESS_TOKEN;
  const send = guardedFetch({
    provider: "Planning Center",
    baseUrl: options.baseUrl?.trim() || PLANNING_CENTER_API_BASE_URL,
    headers: { Accept: "application/json", "User-Agent": userAgent },
    maxResponseBytes: PLANNING_CENTER_MAX_RESPONSE_BYTES,
    authenticate: (ctx) => auth.headers(ctx),
  });
  const call = planningCenterCall(send, PLANNING_CENTER_API_VERSIONS);

  return api(id, {
    ...(options.authScope ? { authScope: options.authScope } : {}),
    title: options.title ?? "Planning Center",
    description: `Planning Center church management — People, Services, Groups, Check-Ins, Calendar, Registrations, and Giving: ${purpose}`,
    credential: auth.credential,
    async testCredentials(values: ConnectorCredentialValues, ctx: ConnectorContext): Promise<CredentialTestResult> {
      try {
        const document = asRecord(
          await call(
            { method: "GET", path: "/people/v2/me", query: { include: "organization" } },
            {
              ...ctx,
              credential: {
                get: async (field?: string) => (field ? values[field] ?? null : null),
                getAll: async () => values,
              },
            },
          ),
        );
        const me = created(document, "person record");
        const organization = resources(document["included"]).find((row) => row.type === "Organization");
        const name = attribute(me, "name") ?? `person ${me.id}`;
        const where = attribute(organization, "name");
        return {
          ok: true,
          message: `Authenticated as ${String(name)} (person ${me.id})${where ? ` in ${String(where)}` : ""}.`,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof ConnectorCallError ? error.message : "Planning Center rejected the token.",
        };
      }
    },
    callAdmission: options.callAdmission ?? PLANNING_CENTER_ADMISSION,
    usageGuide: {
      content: usageGuide(purpose, options.instructions),
      summary:
        "Person ids join every product, offset paging, per-product write limits, JSON:API hatches, pinned versions.",
      // Deliberately not `required`. Every named tool's schema is complete
      // enough to call it on its own; the guide carries the cross-product
      // facts (merges, write limits, hatch framing) an agent needs only when
      // it leaves the named surface or hits one of them.
    },
    ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
    tools: tools(call, defaultPageSize),
  });
}
