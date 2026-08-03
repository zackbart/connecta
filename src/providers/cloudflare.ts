/**
 * Cloudflare's REST API as a deliberate, hand-written tool surface.
 *
 * Deliberately SDK-free. The `cloudflare` npm package is a generated client
 * whose value is typed wrappers and pagination helpers — both of which this
 * connection re-projects anyway, because an agent needs a lean result shape,
 * not Cloudflare's full response object. Every call here is `fetch` against
 * documented paths with a Bearer token, which keeps the provider Workers-clean,
 * adds no dependency (optional peer or otherwise), and leaves the published
 * surface exactly where `ethos.md` puts it.
 *
 * The tools are hand-written rather than generated because a generated wrapper
 * is what motivated this file: a compact schema that says `arguments?: {}[]`
 * forces an agent to read operation documentation before it can call anything.
 * Every tool below therefore carries a complete input schema, an accurate
 * required-key list, and a declared output shape.
 */
import { api, type ApiTool } from "../connectors/api.js";
import { ConnectorCallError } from "../errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  JsonSchema,
} from "../types.js";

/** Cloudflare's v4 REST base. Override only for a proxy or a test double. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Every DNS record type the records API accepts, for filtering a list.
 * Enumerated in the schema so an agent picks a legal type without reading
 * Cloudflare's documentation.
 */
export const CLOUDFLARE_DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CAA",
  "CERT",
  "CNAME",
  "DNSKEY",
  "DS",
  "HTTPS",
  "LOC",
  "MX",
  "NAPTR",
  "NS",
  "OPENPGPKEY",
  "PTR",
  "SMIMEA",
  "SRV",
  "SSHFP",
  "SVCB",
  "TLSA",
  "TXT",
  "URI",
] as const;

/**
 * The record types whose value is a single `content` string — the eight this
 * connection can create and update.
 *
 * The other thirteen (CAA, CERT, DNSKEY, DS, HTTPS, LOC, NAPTR, SMIMEA, SRV,
 * SSHFP, SVCB, TLSA, URI) carry a per-type structured `data` object instead,
 * each with its own field set. Accepting them here would mean either a
 * free-form `data` passthrough — exactly the untyped `{}` this connection
 * exists to avoid — or thirteen more hand-written schemas for record types
 * that are rare in the day-to-day work this surface is for. They remain fully
 * readable and filterable; only creating and updating them is out of scope.
 */
export const CLOUDFLARE_CONTENT_DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "OPENPGPKEY",
  "PTR",
  "TXT",
] as const;

export interface CloudflareOptions {
  /** Human-readable display name; defaults to "Cloudflare". */
  title?: string;
  /** Which account/estate this connection administers, and for whom. */
  purpose: string;
  /**
   * Default account id for account-scoped tools. When set, `accountId` becomes
   * an optional argument; when omitted, agents must pass one and can find it
   * with `list_accounts`.
   */
  accountId?: string;
  /**
   * Default zone id for zone-scoped tools. When set, `zoneId` becomes an
   * optional argument; when omitted, agents must pass one and can find it with
   * `list_zones`.
   */
  zoneId?: string;
  /** API base override for a proxy or a test double. Defaults to the v4 API. */
  baseUrl?: string;
  /** Credential presentation override; the token is always operator-managed. */
  credential?: ConnectorCredentialConfig;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Simultaneous downstream calls. Defaults to 6. */
  maxConcurrency?: number;
}

/**
 * Cloudflare documents a global limit of 1,200 requests per five minutes per
 * user, counted cumulatively across the dashboard, API keys, and API tokens.
 * The budget mirrors that window; `maxConcurrency` is the part that actually
 * protects a shared token, because a single `execute_code` program can fan out
 * far faster than the window notices.
 */
function admissionPolicy(maxConcurrency: number): ConnectorCallAdmissionPolicy {
  return {
    rules: [
      {
        maxConcurrency,
        budget: {
          kind: "rolling-window",
          maxCalls: 1200,
          windowMs: 300_000,
        },
      },
    ],
  };
}

const DEFAULT_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Cloudflare API token",
  description:
    "A scoped API token (My Profile → API Tokens → Create Token), not a Global API Key. Grant only the permissions the deployment needs: zone-scoped \"Zone Read\" and \"DNS Write\" for DNS work and \"Cache Purge\" for purges; account-scoped \"Workers Scripts Read\", \"Workers KV Storage Read\", \"Workers R2 Storage Read\", or \"Cloudflare Pages Read\" for the platform reads.",
  placeholder: "Paste API token",
};

// --- Cloudflare's response envelope -----------------------------------------

interface CloudflareEnvelopeError {
  code?: number;
  message?: string;
  error_chain?: CloudflareEnvelopeError[];
}

interface CloudflareResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  total_pages?: number;
  /** Cursor-paginated endpoints (R2 buckets, KV keys) report this instead. */
  cursor?: string;
}

interface CloudflareEnvelope {
  success?: boolean;
  errors?: CloudflareEnvelopeError[];
  messages?: unknown[];
  result?: unknown;
  result_info?: CloudflareResultInfo;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Flatten Cloudflare's error array (and any nested chain) into one line. */
function describeErrors(errors: CloudflareEnvelopeError[]): string {
  const parts: string[] = [];
  const walk = (list: CloudflareEnvelopeError[]): void => {
    for (const entry of list) {
      const code = typeof entry.code === "number" ? entry.code : undefined;
      const message =
        typeof entry.message === "string" ? entry.message : "Unknown error";
      parts.push(code === undefined ? message : `${code}: ${message}`);
      if (Array.isArray(entry.error_chain)) walk(entry.error_chain);
    }
  };
  walk(errors);
  return parts.length > 0 ? parts.join("; ") : "Cloudflare reported no detail.";
}

function errorCodes(errors: CloudflareEnvelopeError[]): Set<number> {
  const codes = new Set<number>();
  const walk = (list: CloudflareEnvelopeError[]): void => {
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
 * error" but also reuses it as a generic validation code ("domain_name is
 * required", "Invalid pagination cursor"), so routing on it would tell an
 * agent its token was broken when its arguments were. Genuine 10000 auth
 * failures arrive with 401 or 403 and are caught by status.
 *
 * All of these route to `auth_required`, whose recovery mode resolves to
 * `operator_config` because this connection declares an operator-managed
 * credential rather than an OAuth flow.
 */
const AUTH_ERROR_CODES = new Set([1001, 6003, 6111, 9103, 9106, 9107]);

/** Seconds in a `retry-after` header, converted to the milliseconds the core wants. */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.trunc(seconds * 1000);
}

/**
 * Turn a failed Cloudflare response into a typed connector failure.
 *
 * Status is the primary signal and the error codes refine it, because
 * Cloudflare returns 403 for both "this token is invalid" and "this token
 * cannot do that" — an agent needs to stop retrying either way, and the
 * operator needs to know the token is the thing to fix.
 */
function failureFor(
  status: number,
  headers: Headers,
  errors: CloudflareEnvelopeError[],
): ConnectorCallError {
  const detail = describeErrors(errors);
  const codes = errorCodes(errors);
  // 429 is checked before the auth codes on purpose: Cloudflare reuses the
  // generic 10000 code on throttled responses too, and reading a rate limit as
  // an auth failure would tell an agent to stop when it should wait.
  if (status === 429) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `Cloudflare rate limit reached (HTTP 429). ${detail} The documented limit is 1,200 requests per five minutes per user, counted across the dashboard and every token.`,
      // Cloudflare blocks the remainder of the five-minute window when the
      // global limit trips, so the honest fallback is the whole window.
      { retryAfterMs: wait ?? 300_000 },
    );
  }
  const authCoded = [...codes].some((code) => AUTH_ERROR_CODES.has(code));
  if (status === 401 || status === 403 || authCoded) {
    return new ConnectorCallError(
      "auth_required",
      `Cloudflare rejected the API token (HTTP ${status}). ${detail} Check that the token is valid and carries the permission this call needs.`,
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new ConnectorCallError(
      "invalid_args",
      `Cloudflare rejected the request (HTTP ${status}). ${detail}`,
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "connector_call_failed",
      `Cloudflare found no such resource (HTTP 404). ${detail} Confirm the zone or account id with list_zones or list_accounts.`,
    );
  }
  if (status >= 500) {
    return new ConnectorCallError(
      "unavailable",
      `Cloudflare is unavailable (HTTP ${status}). ${detail}`,
    );
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `Cloudflare request failed (HTTP ${status}). ${detail}`,
  );
}

// --- The request path --------------------------------------------------------

interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface CloudflareResponse {
  result: unknown;
  resultInfo: CloudflareResultInfo | undefined;
}

async function readToken(ctx: ConnectorContext): Promise<string> {
  const token = await ctx.credential?.get();
  if (!token) {
    throw new ConnectorCallError(
      "auth_required",
      "No Cloudflare API token is configured for this connector. An operator must add one before any call can run.",
    );
  }
  return token;
}

function buildUrl(base: string, spec: RequestSpec): string {
  const url = new URL(`${base.replace(/\/+$/, "")}${spec.path}`);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function callCloudflare(
  base: string,
  spec: RequestSpec,
  ctx: ConnectorContext,
): Promise<CloudflareResponse> {
  const token = await readToken(ctx);
  let response: Response;
  try {
    response = await fetch(buildUrl(base, spec), {
      method: spec.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(spec.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(spec.body !== undefined
        ? { body: JSON.stringify(spec.body) }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (cause) {
    throw new ConnectorCallError(
      "unavailable",
      `Could not reach the Cloudflare API: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  let envelope: CloudflareEnvelope;
  try {
    envelope = (await response.json()) as CloudflareEnvelope;
  } catch (cause) {
    // A gateway error page, not JSON: the status is the only real signal left.
    throw response.ok
      ? new ConnectorCallError(
          "unavailable",
          "Cloudflare returned a non-JSON body for a successful status.",
          { cause },
        )
      : failureFor(response.status, response.headers, []);
  }

  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  if (!response.ok || envelope.success === false) {
    throw failureFor(response.status, response.headers, errors);
  }
  return {
    result: envelope.result,
    resultInfo: envelope.result_info,
  };
}

// --- Projections -------------------------------------------------------------

interface PageInfo {
  page: number;
  perPage: number;
  count: number;
  totalCount?: number;
  totalPages?: number;
  hasMore: boolean;
}

/**
 * Cloudflare's `result_info` reshaped into the one question an agent actually
 * asks — is there another page? — with the raw counters kept alongside it.
 */
function pageInfo(info: CloudflareResultInfo | undefined): PageInfo | undefined {
  if (!info) return undefined;
  // A cursor-only result_info carries no page counters; inventing them would
  // report `hasMore: false` on a listing that has more.
  if (
    info.page === undefined &&
    info.total_pages === undefined &&
    info.count === undefined
  ) {
    return undefined;
  }
  const page = typeof info.page === "number" ? info.page : 1;
  const totalPages =
    typeof info.total_pages === "number" ? info.total_pages : undefined;
  return {
    page,
    perPage: typeof info.per_page === "number" ? info.per_page : 0,
    count: typeof info.count === "number" ? info.count : 0,
    ...(typeof info.total_count === "number"
      ? { totalCount: info.total_count }
      : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
    hasMore: totalPages !== undefined ? page < totalPages : false,
  };
}

function projectAccount(value: unknown): JsonRecord {
  const account = asRecord(value);
  return {
    id: account["id"],
    name: account["name"],
    ...(account["type"] !== undefined ? { type: account["type"] } : {}),
    ...(account["created_on"] !== undefined
      ? { createdOn: account["created_on"] }
      : {}),
  };
}

function projectZone(value: unknown): JsonRecord {
  const zone = asRecord(value);
  const account = asRecord(zone["account"]);
  const plan = asRecord(zone["plan"]);
  return {
    id: zone["id"],
    name: zone["name"],
    status: zone["status"],
    paused: zone["paused"],
    type: zone["type"],
    accountId: account["id"],
    accountName: account["name"],
    ...(plan["name"] !== undefined ? { plan: plan["name"] } : {}),
    ...(Array.isArray(zone["name_servers"])
      ? { nameServers: zone["name_servers"] }
      : {}),
    createdOn: zone["created_on"],
    modifiedOn: zone["modified_on"],
  };
}

function projectDnsRecord(value: unknown): JsonRecord {
  const record = asRecord(value);
  return {
    id: record["id"],
    name: record["name"],
    type: record["type"],
    content: record["content"],
    ttl: record["ttl"],
    ...(record["proxied"] !== undefined
      ? { proxied: record["proxied"] }
      : {}),
    ...(record["priority"] !== undefined
      ? { priority: record["priority"] }
      : {}),
    ...(record["comment"] ? { comment: record["comment"] } : {}),
    ...(Array.isArray(record["tags"]) && record["tags"].length > 0
      ? { tags: record["tags"] }
      : {}),
    createdOn: record["created_on"],
    modifiedOn: record["modified_on"],
  };
}

function projectWorkerScript(value: unknown): JsonRecord {
  const script = asRecord(value);
  return {
    id: script["id"],
    createdOn: script["created_on"],
    modifiedOn: script["modified_on"],
    ...(script["usage_model"] !== undefined
      ? { usageModel: script["usage_model"] }
      : {}),
  };
}

function projectKvNamespace(value: unknown): JsonRecord {
  const namespace = asRecord(value);
  return {
    id: namespace["id"],
    title: namespace["title"],
    ...(namespace["supports_url_encoding"] !== undefined
      ? { supportsUrlEncoding: namespace["supports_url_encoding"] }
      : {}),
  };
}

function projectR2Bucket(value: unknown): JsonRecord {
  const bucket = asRecord(value);
  return {
    name: bucket["name"],
    ...(bucket["location"] !== undefined
      ? { location: bucket["location"] }
      : {}),
    ...(bucket["storage_class"] !== undefined
      ? { storageClass: bucket["storage_class"] }
      : {}),
    ...(bucket["creation_date"] !== undefined
      ? { creationDate: bucket["creation_date"] }
      : {}),
  };
}

function projectPagesProject(value: unknown): JsonRecord {
  const project = asRecord(value);
  const latest = asRecord(project["latest_deployment"]);
  return {
    name: project["name"],
    subdomain: project["subdomain"],
    ...(Array.isArray(project["domains"])
      ? { domains: project["domains"] }
      : {}),
    ...(project["production_branch"] !== undefined
      ? { productionBranch: project["production_branch"] }
      : {}),
    createdOn: project["created_on"],
    ...(latest["id"] !== undefined
      ? {
          latestDeployment: {
            id: latest["id"],
            environment: latest["environment"],
            url: latest["url"],
            createdOn: latest["created_on"],
          },
        }
      : {}),
  };
}

// --- Schema fragments --------------------------------------------------------

const PAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Pagination counters from Cloudflare's result_info. Absent when the endpoint does not paginate.",
  properties: {
    page: { type: "integer" },
    perPage: { type: "integer" },
    count: { type: "integer", description: "Items on this page." },
    totalCount: { type: "integer" },
    totalPages: { type: "integer" },
    hasMore: {
      type: "boolean",
      description: "True when a further page exists; request page + 1.",
    },
  },
  required: ["page", "perPage", "count", "hasMore"],
};

const RAW_INPUT_PROPERTY: JsonSchema = {
  type: "boolean",
  description:
    "Return Cloudflare's unprojected result instead of the lean shape. Use only when a field the projection drops is genuinely needed; the raw shape is much larger.",
};

/**
 * Cloudflare's per-page bounds differ per endpoint and it rejects an
 * out-of-range value with a 400, so each caller passes its own. Encoding them
 * in the schema turns a wasted round trip into a local repair.
 */
function pagingInputProperties(
  minPerPage: number,
  maxPerPage: number,
): Record<string, JsonSchema> {
  return {
    page: {
      type: "integer",
      minimum: 1,
      description: "1-based page number. Defaults to 1.",
    },
    perPage: {
      type: "integer",
      minimum: minPerPage,
      maximum: maxPerPage,
      description: `Items per page, ${minPerPage} to ${maxPerPage}. Defaults to 20.`,
    },
  };
}

function listOutputSchema(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { [key]: { type: "array", items: item }, page: PAGE_OUTPUT_SCHEMA },
    required: [key],
  };
}

const ACCOUNT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    type: { type: "string" },
    createdOn: { type: "string" },
  },
  required: ["id", "name"],
};

const ZONE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Zone id — the argument every zone-scoped tool wants." },
    name: { type: "string", description: "Apex domain, e.g. example.com." },
    status: { type: "string" },
    paused: { type: "boolean" },
    type: { type: "string" },
    accountId: { type: "string" },
    accountName: { type: "string" },
    plan: { type: "string" },
    nameServers: { type: "array", items: { type: "string" } },
    createdOn: { type: "string" },
    modifiedOn: { type: "string" },
  },
  required: ["id", "name", "status"],
};

const DNS_RECORD_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string", description: "Fully qualified record name." },
    type: { type: "string", enum: [...CLOUDFLARE_DNS_RECORD_TYPES] },
    content: { type: "string" },
    ttl: { type: "integer", description: "Seconds; 1 means automatic." },
    proxied: { type: "boolean" },
    priority: { type: "integer" },
    comment: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    createdOn: { type: "string" },
    modifiedOn: { type: "string" },
  },
  required: ["id", "name", "type", "content", "ttl"],
};

// --- Tool construction -------------------------------------------------------

interface Scoping {
  base: string;
  accountId: string | undefined;
  zoneId: string | undefined;
}

/**
 * Resolve a scope id from the call or the deployment default.
 *
 * The second layer, not the first: when the deployment declares no default the
 * schema already lists the key in `required`, so `api()` rejects an omitted id
 * before the handler runs. This catches what a JSON Schema string cannot — a
 * blank or whitespace-only id — and answers with the discovery tool's name
 * rather than a Cloudflare round trip that would 404.
 */
function requireScope(
  provided: unknown,
  fallback: string | undefined,
  kind: "zoneId" | "accountId",
): string {
  const value = typeof provided === "string" ? provided.trim() : "";
  if (value) return value;
  if (fallback) return fallback;
  const discovery = kind === "zoneId" ? "list_zones" : "list_accounts";
  throw new ConnectorCallError(
    "invalid_args",
    `${kind} is required: this connector has no default ${kind}. Call ${discovery} to find it.`,
    {
      validation: {
        issues: [
          {
            path: `/${kind}`,
            code: "required",
            expected: `a Cloudflare ${kind === "zoneId" ? "zone" : "account"} id`,
          },
        ],
      },
    },
  );
}

/** A scope argument is only required when the deployment declared no default. */
function scopeProperty(
  kind: "zoneId" | "accountId",
  fallback: string | undefined,
): JsonSchema {
  const noun = kind === "zoneId" ? "Zone" : "Account";
  const discovery = kind === "zoneId" ? "list_zones" : "list_accounts";
  return {
    type: "string",
    minLength: 1,
    description: fallback
      ? `${noun} id. Optional — defaults to this connector's configured ${kind}. Pass one to address a different ${noun.toLowerCase()}; ${discovery} lists them.`
      : `${noun} id. Required — this connector declares no default; ${discovery} returns it.`,
  };
}

function scopeRequired(
  kind: "zoneId" | "accountId",
  fallback: string | undefined,
): string[] {
  return fallback ? [] : [kind];
}

function optionalString(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function optionalNumber(args: JsonRecord, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function buildTools(scope: Scoping): ApiTool[] {
  const { base } = scope;
  const zoneArg = (args: JsonRecord): string =>
    requireScope(args["zoneId"], scope.zoneId, "zoneId");
  const accountArg = (args: JsonRecord): string =>
    requireScope(args["accountId"], scope.accountId, "accountId");

  const readOnly = { readOnlyHint: true, destructiveHint: false } as const;

  return [
    {
      name: "verify_api_token",
      description:
        "Verify the configured Cloudflare API token and report its status. Use this first when any other tool fails with an authentication error, to separate a bad token from a missing permission.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            description: "\"active\" for a usable token.",
          },
          notBefore: { type: "string" },
          expiresOn: { type: "string" },
        },
        required: ["status"],
      },
      handler: async (_args, ctx) => {
        const { result } = await callCloudflare(
          base,
          { method: "GET", path: "/user/tokens/verify" },
          ctx,
        );
        const token = asRecord(result);
        return {
          id: token["id"],
          status: token["status"],
          ...(token["not_before"] !== undefined
            ? { notBefore: token["not_before"] }
            : {}),
          ...(token["expires_on"] !== undefined
            ? { expiresOn: token["expires_on"] }
            : {}),
        };
      },
    },
    {
      name: "list_accounts",
      description:
        "List Cloudflare accounts this token can see. Supplies the accountId that the Workers, KV, R2, and Pages tools need.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Filter by exact account name.",
          },
          ...pagingInputProperties(5, 50),
          raw: RAW_INPUT_PROPERTY,
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("accounts", ACCOUNT_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: "/accounts",
            query: {
              name: optionalString(args, "name"),
              page: optionalNumber(args, "page"),
              per_page: optionalNumber(args, "perPage"),
            },
          },
          ctx,
        );
        if (args["raw"] === true) return { accounts: result, page: pageInfo(resultInfo) };
        return {
          accounts: asArray(result).map(projectAccount),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      name: "list_zones",
      description:
        "List zones (domains) this token can see, with their ids and status. This is the zoneId discovery step for every DNS and cache tool.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Filter by zone name, e.g. example.com.",
          },
          accountId: {
            type: "string",
            description:
              "Restrict to one account. Defaults to every account the token can see.",
          },
          status: {
            type: "string",
            enum: ["initializing", "pending", "active", "moved"],
            description: "Filter by zone status.",
          },
          ...pagingInputProperties(5, 50),
          raw: RAW_INPUT_PROPERTY,
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("zones", ZONE_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: "/zones",
            query: {
              name: optionalString(args, "name"),
              "account.id":
                optionalString(args, "accountId") ?? scope.accountId,
              status: optionalString(args, "status"),
              page: optionalNumber(args, "page"),
              per_page: optionalNumber(args, "perPage"),
            },
          },
          ctx,
        );
        if (args["raw"] === true) return { zones: result, page: pageInfo(resultInfo) };
        return {
          zones: asArray(result).map(projectZone),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      name: "get_zone",
      description:
        "Fetch one zone's settings summary by id: status, plan, name servers, and owning account.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("zoneId", scope.zoneId),
        additionalProperties: false,
      },
      outputSchema: ZONE_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          base,
          { method: "GET", path: `/zones/${encodeURIComponent(zoneArg(args))}` },
          ctx,
        );
        return args["raw"] === true ? result : projectZone(result);
      },
    },
    {
      name: "list_dns_records",
      description:
        "List DNS records in a zone, filtered by name, type, or content. Returns record ids, which update_dns_record and delete_dns_record require.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          name: {
            type: "string",
            description:
              "Exact record name, fully qualified, e.g. www.example.com.",
          },
          type: {
            type: "string",
            enum: [...CLOUDFLARE_DNS_RECORD_TYPES],
            description: "Filter by record type.",
          },
          content: {
            type: "string",
            description: "Exact record content, e.g. an IP address.",
          },
          order: {
            type: "string",
            enum: ["type", "name", "content", "ttl", "proxied"],
            description: "Sort field.",
          },
          direction: { type: "string", enum: ["asc", "desc"] },
          ...pagingInputProperties(5, 100),
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("zoneId", scope.zoneId),
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("records", DNS_RECORD_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: `/zones/${encodeURIComponent(zoneArg(args))}/dns_records`,
            query: {
              name: optionalString(args, "name"),
              type: optionalString(args, "type"),
              content: optionalString(args, "content"),
              order: optionalString(args, "order"),
              direction: optionalString(args, "direction"),
              page: optionalNumber(args, "page"),
              per_page: optionalNumber(args, "perPage"),
            },
          },
          ctx,
        );
        if (args["raw"] === true)
          return { records: result, page: pageInfo(resultInfo) };
        return {
          records: asArray(result).map(projectDnsRecord),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      name: "get_dns_record",
      description: "Fetch one DNS record by its record id.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          recordId: {
            type: "string",
            description: "DNS record id, from list_dns_records.",
          },
          raw: RAW_INPUT_PROPERTY,
        },
        required: [...scopeRequired("zoneId", scope.zoneId), "recordId"],
        additionalProperties: false,
      },
      outputSchema: DNS_RECORD_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          base,
          {
            method: "GET",
            path: `/zones/${encodeURIComponent(zoneArg(args))}/dns_records/${encodeURIComponent(
              String(args["recordId"]),
            )}`,
          },
          ctx,
        );
        return args["raw"] === true ? result : projectDnsRecord(result);
      },
    },
    {
      name: "list_worker_scripts",
      description:
        "List Workers scripts deployed in an account, with their last-modified times.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("accountId", scope.accountId),
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("scripts", {
        type: "object",
        properties: {
          id: { type: "string", description: "Script name." },
          createdOn: { type: "string" },
          modifiedOn: { type: "string" },
          usageModel: { type: "string" },
        },
        required: ["id"],
      }),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: `/accounts/${encodeURIComponent(accountArg(args))}/workers/scripts`,
          },
          ctx,
        );
        if (args["raw"] === true)
          return { scripts: result, page: pageInfo(resultInfo) };
        return {
          scripts: asArray(result).map(projectWorkerScript),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      name: "list_kv_namespaces",
      description:
        "List Workers KV namespaces in an account, with the namespace ids bindings refer to.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          ...pagingInputProperties(1, 1000),
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("accountId", scope.accountId),
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("namespaces", {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          supportsUrlEncoding: { type: "boolean" },
        },
        required: ["id", "title"],
      }),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: `/accounts/${encodeURIComponent(accountArg(args))}/storage/kv/namespaces`,
            query: {
              page: optionalNumber(args, "page"),
              per_page: optionalNumber(args, "perPage"),
            },
          },
          ctx,
        );
        if (args["raw"] === true)
          return { namespaces: result, page: pageInfo(resultInfo) };
        return {
          namespaces: asArray(result).map(projectKvNamespace),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      name: "list_r2_buckets",
      description:
        "List R2 buckets in an account, with location and storage class.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          nameContains: {
            type: "string",
            description: "Filter to buckets whose name contains this string.",
          },
          perPage: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Buckets per request, 1 to 1000. Defaults to 20.",
          },
          cursor: {
            type: "string",
            description:
              "Opaque cursor from a previous call's nextCursor. R2 paginates by cursor, not page number.",
          },
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("accountId", scope.accountId),
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          buckets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                location: { type: "string" },
                storageClass: { type: "string" },
                creationDate: { type: "string" },
              },
              required: ["name"],
            },
          },
          nextCursor: {
            type: "string",
            description:
              "Pass back as `cursor` to continue. Absent when the listing is complete.",
          },
        },
        required: ["buckets"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: `/accounts/${encodeURIComponent(accountArg(args))}/r2/buckets`,
            query: {
              name_contains: optionalString(args, "nameContains"),
              per_page: optionalNumber(args, "perPage"),
              cursor: optionalString(args, "cursor"),
            },
          },
          ctx,
        );
        // R2 nests its list under `buckets` rather than returning a bare array,
        // and its result_info carries a cursor instead of page counters.
        const cursor = resultInfo?.cursor;
        const next =
          typeof cursor === "string" && cursor !== ""
            ? { nextCursor: cursor }
            : {};
        if (args["raw"] === true) return { buckets: result, ...next };
        return {
          buckets: asArray(asRecord(result)["buckets"]).map(projectR2Bucket),
          ...next,
        };
      },
    },
    {
      name: "list_pages_projects",
      description:
        "List Cloudflare Pages projects in an account, with their production branch and latest deployment.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          ...pagingInputProperties(1, 100),
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("accountId", scope.accountId),
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("projects", {
        type: "object",
        properties: {
          name: { type: "string" },
          subdomain: { type: "string" },
          domains: { type: "array", items: { type: "string" } },
          productionBranch: { type: "string" },
          createdOn: { type: "string" },
          latestDeployment: {
            type: "object",
            properties: {
              id: { type: "string" },
              environment: { type: "string" },
              url: { type: "string" },
              createdOn: { type: "string" },
            },
          },
        },
        required: ["name"],
      }),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          base,
          {
            method: "GET",
            path: `/accounts/${encodeURIComponent(accountArg(args))}/pages/projects`,
            query: {
              page: optionalNumber(args, "page"),
              per_page: optionalNumber(args, "perPage"),
            },
          },
          ctx,
        );
        if (args["raw"] === true)
          return { projects: result, page: pageInfo(resultInfo) };
        return {
          projects: asArray(result).map(projectPagesProject),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      // Additive: brings a record into being and destroys nothing, so
      // `destructiveHint` stays unset. `readOnlyHint: false` already routes it
      // through call_destructive_tool.
      name: "create_dns_record",
      description:
        "Create a content-based DNS record (A, AAAA, CNAME, MX, NS, OPENPGPKEY, PTR, TXT) in a zone. Check for an existing record with list_dns_records first: Cloudflare rejects a duplicate rather than replacing it. Record types that carry structured data, such as SRV and CAA, are readable here but not creatable.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          type: {
            type: "string",
            enum: [...CLOUDFLARE_CONTENT_DNS_RECORD_TYPES],
            description: "Record type.",
          },
          name: {
            type: "string",
            description:
              "Record name. Use the apex domain for the root, or a fully qualified subdomain, e.g. www.example.com.",
          },
          content: {
            type: "string",
            description:
              "Record value: an IPv4 address for A, IPv6 for AAAA, a hostname for CNAME/MX/NS, or the text body for TXT.",
          },
          ttl: {
            type: "integer",
            minimum: 1,
            maximum: 86400,
            description:
              "Time to live in seconds. 1 means automatic, which is what a proxied record must use; any other value must be at least 60 (30 on Enterprise zones). Defaults to 1.",
          },
          proxied: {
            type: "boolean",
            description:
              "Route through Cloudflare's proxy. Only A, AAAA, and CNAME records are proxiable. Defaults to false.",
          },
          priority: {
            type: "integer",
            minimum: 0,
            maximum: 65535,
            description: "Mail-server preference. MX records only.",
          },
          comment: {
            type: "string",
            description: "Operator-facing note stored with the record.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Custom tags, available on paid plans.",
          },
        },
        required: [
          ...scopeRequired("zoneId", scope.zoneId),
          "type",
          "name",
          "content",
        ],
        additionalProperties: false,
      },
      outputSchema: DNS_RECORD_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          base,
          {
            method: "POST",
            path: `/zones/${encodeURIComponent(zoneArg(args))}/dns_records`,
            body: {
              type: args["type"],
              name: args["name"],
              content: args["content"],
              ttl: optionalNumber(args, "ttl") ?? 1,
              ...(args["proxied"] !== undefined
                ? { proxied: args["proxied"] }
                : {}),
              ...(args["priority"] !== undefined
                ? { priority: args["priority"] }
                : {}),
              ...(args["comment"] !== undefined
                ? { comment: args["comment"] }
                : {}),
              ...(args["tags"] !== undefined ? { tags: args["tags"] } : {}),
            },
          },
          ctx,
        );
        return projectDnsRecord(result);
      },
    },
    {
      // Destructive: it overwrites what a record already resolves to.
      name: "update_dns_record",
      description:
        "Update fields on an existing DNS record. Only the supplied fields change; everything else keeps its current value. Changing content on a live record repoints traffic immediately.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          recordId: {
            type: "string",
            description: "DNS record id, from list_dns_records.",
          },
          type: {
            type: "string",
            enum: [...CLOUDFLARE_CONTENT_DNS_RECORD_TYPES],
            description:
              "Record type. Send it whenever content changes; Cloudflare treats type and content as a pair.",
          },
          name: { type: "string", description: "Fully qualified record name." },
          content: { type: "string", description: "New record value." },
          ttl: {
            type: "integer",
            minimum: 1,
            maximum: 86400,
            description:
              "Seconds; 1 means automatic, otherwise at least 60 (30 on Enterprise zones).",
          },
          proxied: { type: "boolean" },
          priority: {
            type: "integer",
            minimum: 0,
            maximum: 65535,
            description: "Mail-server preference. MX records only.",
          },
          comment: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: [...scopeRequired("zoneId", scope.zoneId), "recordId"],
        additionalProperties: false,
      },
      outputSchema: DNS_RECORD_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const body: JsonRecord = {};
        for (const key of [
          "type",
          "name",
          "content",
          "ttl",
          "proxied",
          "priority",
          "comment",
          "tags",
        ]) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        if (Object.keys(body).length === 0) {
          throw new ConnectorCallError(
            "invalid_args",
            "update_dns_record needs at least one field to change besides zoneId and recordId.",
            {
              validation: {
                issues: [
                  {
                    path: "/",
                    code: "anyOf",
                    expected: "at least one of type, name, content, ttl, proxied, priority, comment, tags",
                  },
                ],
              },
            },
          );
        }
        const { result } = await callCloudflare(
          base,
          {
            method: "PATCH",
            path: `/zones/${encodeURIComponent(zoneArg(args))}/dns_records/${encodeURIComponent(
              String(args["recordId"]),
            )}`,
            body,
          },
          ctx,
        );
        return projectDnsRecord(result);
      },
    },
    {
      name: "delete_dns_record",
      description:
        "Delete a DNS record by id. The record stops resolving immediately and Cloudflare keeps no undo.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          recordId: {
            type: "string",
            description: "DNS record id, from list_dns_records.",
          },
        },
        required: [...scopeRequired("zoneId", scope.zoneId), "recordId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          recordId: { type: "string" },
        },
        required: ["deleted", "recordId"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const recordId = String(args["recordId"]);
        await callCloudflare(
          base,
          {
            method: "DELETE",
            path: `/zones/${encodeURIComponent(zoneArg(args))}/dns_records/${encodeURIComponent(recordId)}`,
          },
          ctx,
        );
        // Cloudflare answers a delete with `{ "result": { "id": ... } }` and
        // nothing else; the useful acknowledgement is the boolean.
        return { deleted: true, recordId };
      },
    },
    {
      name: "purge_cache",
      description:
        "Purge Cloudflare's edge cache for a zone. Prefer files, tags, hosts, or prefixes; everything discards the entire zone cache and sends every subsequent request to the origin until the cache refills.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          everything: {
            type: "boolean",
            description:
              "Purge the entire zone cache. Mutually exclusive with the targeted options below, and a real load event for the origin.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 100,
            description:
              "Absolute URLs to purge, e.g. https://example.com/style.css. Up to 100 per request (500 on Enterprise).",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 100,
            description:
              "Cache-Tag values to purge. Up to 100 per request; available on every plan.",
          },
          hosts: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 100,
            description:
              "Hostnames to purge. Up to 100 per request; available on every plan.",
          },
          prefixes: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 100,
            description:
              "URL prefixes to purge, e.g. example.com/assets. Up to 100 per request; available on every plan.",
          },
        },
        required: scopeRequired("zoneId", scope.zoneId),
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          purged: { type: "boolean" },
          zoneId: { type: "string" },
          scope: {
            type: "string",
            description:
              "Which variant ran: everything, files, tags, hosts, or prefixes.",
          },
        },
        required: ["purged", "zoneId", "scope"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const zoneId = zoneArg(args);
        const targeted = (["files", "tags", "hosts", "prefixes"] as const).filter(
          (key) => Array.isArray(args[key]) && (args[key] as unknown[]).length > 0,
        );
        const everything = args["everything"] === true;
        // Cloudflare's purge body accepts exactly one variant. Refusing here
        // turns a confusing provider 400 into a schema-shaped failure.
        if (everything && targeted.length > 0) {
          throw new ConnectorCallError(
            "invalid_args",
            "purge_cache takes either everything: true or one targeted list, never both.",
            {
              validation: {
                issues: [
                  {
                    path: "/everything",
                    code: "oneOf",
                    expected: "everything: true alone, or exactly one of files, tags, hosts, prefixes",
                  },
                ],
              },
            },
          );
        }
        if (!everything && targeted.length !== 1) {
          throw new ConnectorCallError(
            "invalid_args",
            targeted.length === 0
              ? "purge_cache needs everything: true or one of files, tags, hosts, or prefixes."
              : `purge_cache takes exactly one targeted list; received ${targeted.join(", ")}.`,
            {
              validation: {
                issues: [
                  {
                    path: "/",
                    code: "oneOf",
                    expected: "everything: true, or exactly one of files, tags, hosts, prefixes",
                  },
                ],
              },
            },
          );
        }
        const variant = everything ? "everything" : targeted[0]!;
        await callCloudflare(
          base,
          {
            method: "POST",
            path: `/zones/${encodeURIComponent(zoneId)}/purge_cache`,
            body: everything
              ? { purge_everything: true }
              : { [variant]: args[variant] },
          },
          ctx,
        );
        return { purged: true, zoneId, scope: variant };
      },
    },
  ];
}

function usageGuide(
  purpose: string,
  scope: Scoping,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  const zoneLine = scope.zoneId
    ? `This connector defaults to zone \`${scope.zoneId}\`; omit \`zoneId\` unless the request names a different domain.`
    : "This connector declares no default zone. Start with `list_zones` (filter by `name`) and carry the returned `id` into every zone-scoped call.";
  const accountLine = scope.accountId
    ? `It defaults to account \`${scope.accountId}\`; omit \`accountId\` unless the request names a different account.`
    : "It declares no default account. `list_accounts` supplies the `accountId` the Workers, KV, R2, and Pages tools need.";
  return `# Cloudflare usage

Account purpose: ${purpose}

- ${zoneLine}
- ${accountLine}
- Every tool's schema is complete. The arguments a call needs are in \`required\`, and the values a field accepts are in its \`enum\` — you do not need to read Cloudflare's API documentation to make a call here.
- Lists paginate with \`page\` and \`perPage\` and return a \`page\` object; request the next page only when \`page.hasMore\` is true. \`list_r2_buckets\` is unpaginated and filters with \`nameContains\`.
- Results are projected to the fields that identify and describe a resource. Pass \`raw: true\` on a read when you genuinely need a field the projection drops.
- The API token is operator-managed and scoped by permission, not by role. An \`auth_required\` failure means the token is missing, invalid, or lacks that call's permission — it is never fixed by retrying. Call \`verify_api_token\` to tell a dead token from a missing permission, then report which permission is needed rather than trying other tools.
- A \`rate_limited\` failure carries the wait window. Cloudflare's limit is 1,200 requests per five minutes per user, counted across the dashboard and every token, so do not fan out speculatively; filter server-side with \`name\`, \`type\`, and \`content\` instead of listing everything and filtering locally.
- Writes: \`create_dns_record\` is additive; \`update_dns_record\`, \`delete_dns_record\`, and \`purge_cache\` change or discard live state and are annotated destructive. Read the current record with \`list_dns_records\` before changing or deleting one, and prefer a targeted \`purge_cache\` over \`everything\`.
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

/** A maintained Cloudflare REST API connection. */
export function cloudflare(id: string, options: CloudflareOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("cloudflare() requires a non-empty account purpose.");
  }
  const maxConcurrency = options.maxConcurrency ?? 6;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("cloudflare() maxConcurrency must be a positive integer.");
  }
  const scope: Scoping = {
    base: options.baseUrl?.trim() || CLOUDFLARE_API_BASE,
    accountId: options.accountId?.trim() || undefined,
    zoneId: options.zoneId?.trim() || undefined,
  };
  return api(id, {
    title: options.title ?? "Cloudflare",
    description: `Cloudflare zones, DNS, cache, and platform resources — ${purpose}`,
    credential: options.credential ?? DEFAULT_CREDENTIAL,
    callAdmission: admissionPolicy(maxConcurrency),
    usageGuide: usageGuide(purpose, scope, options.instructions),
    // The schemas are hand-written and closed; a schema that cannot be
    // enforced is a bug in this file, not input to pass through.
    strictValidation: true,
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
    tools: buildTools(scope),
    async testCredential(value, ctx) {
      try {
        const { result } = await callCloudflare(
          scope.base,
          { method: "GET", path: "/user/tokens/verify" },
          {
            ...ctx,
            credential: { get: async () => value, getAll: async () => ({ value }) },
          },
        );
        const status = asRecord(result)["status"];
        return status === "active"
          ? { ok: true, message: "Token verified: active." }
          : { ok: false, message: `Token status is "${String(status)}".` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
