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
import {
  guardedFetch,
  type GuardedRequest,
  type GuardedTransport,
} from "../connectors/guarded-fetch.js";
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

/** Authentication schemes accepted by Cloudflare's v4 API. */
export type CloudflareAuthentication = "apiToken" | "globalApiKey";

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
 * readable and filterable; only the named create/update tools omit them. The
 * guarded raw mutation tool remains available for their documented bodies.
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
  /** Authentication scheme. Defaults to the recommended scoped API token. */
  authentication?: CloudflareAuthentication;
  /** Credential presentation override; credentials are always operator-managed. */
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

const API_TOKEN_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Cloudflare API token",
  description:
    "A scoped API token (My Profile → API Tokens → Create Token), not a Global API Key. Grant only the permissions the deployment needs: zone-scoped \"Zone Read\", \"Zone Settings Write\", \"DNS Write\", \"Cache Purge\", and the phase-specific Rules product Read permissions as needed; account-scoped \"Workers Scripts Read/Write\", \"Workers KV Storage Read/Write\", \"Workers R2 Storage Read/Write\", or \"Cloudflare Pages Read/Write\" for the platform tools.",
  placeholder: "Paste API token",
};

const GLOBAL_API_KEY_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Cloudflare Global API Key",
  description:
    "Legacy user-scoped authentication. The key has the same access as its Cloudflare user across every account and zone that user can reach. Prefer a scoped API token when possible.",
  fields: [
    {
      name: "email",
      label: "Account email",
      description: "The verified email address for the Cloudflare user that owns the Global API Key.",
      placeholder: "you@example.com",
      inputType: "email",
    },
    {
      name: "apiKey",
      label: "Global API Key",
      description: "The legacy Global API Key from My Profile → API Tokens.",
      placeholder: "Paste Global API Key",
      inputType: "password",
    },
  ],
};

function credentialConfig(
  authentication: CloudflareAuthentication,
  override: ConnectorCredentialConfig | undefined,
): ConnectorCredentialConfig {
  if (authentication === "apiToken") {
    const credential = override ?? API_TOKEN_CREDENTIAL;
    if (credential.fields?.length) {
      throw new Error(
        "cloudflare() API token authentication requires a single-value credential.",
      );
    }
    return credential;
  }

  const credential = override
    ? {
        ...GLOBAL_API_KEY_CREDENTIAL,
        ...override,
        fields: override.fields ?? GLOBAL_API_KEY_CREDENTIAL.fields!,
      }
    : GLOBAL_API_KEY_CREDENTIAL;
  const fields = credential.fields?.map((field) => field.name).sort();
  if (fields?.join(",") !== "apiKey,email") {
    throw new Error(
      'cloudflare() Global API Key authentication requires credential fields named "email" and "apiKey".',
    );
  }
  return credential;
}

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
  is_truncated?: boolean;
  delimited?: string[];
  cursors?: { after?: string; before?: string };
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
 * Provenance matters here: Cloudflare publishes no official code table, so this
 * set comes from community reports and observed responses rather than
 * documentation. It is a narrow, well-attested list, not an authoritative one —
 * which is why status is the primary signal and these six only rescue the 400s
 * status gets wrong.
 *
 * Deliberately excludes 10000. Cloudflare returns 10000 for "Authentication
 * error" but has also been observed reusing it as a generic validation code
 * ("domain_name is required", "Invalid pagination cursor"), so routing on it
 * would risk telling an agent its token was broken when its arguments were.
 * Genuine 10000 auth failures arrive with 401 or 403 and are caught by status.
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
      `Cloudflare rejected the configured credential (HTTP ${status}). ${detail} Check that it is valid and has permission to access this resource.`,
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new ConnectorCallError(
      "invalid_args",
      `Cloudflare rejected the request (HTTP ${status}). ${detail}`,
    );
  }
  // Cloudflare's 404 is an honest absence: a token that may not touch a
  // resource is refused with 401 or 403 above, not hidden behind a miss, so
  // this is the unambiguous case `not_found` exists for — re-address, do not
  // retry and do not re-authorize.
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
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

/**
 * The largest response this connection will read.
 *
 * Generous rather than tight, because `cloudflare_api_get` legitimately
 * downloads Worker scripts and R2 objects. It is a ceiling on absurdity, not a
 * quota: anything approaching it is already far past whatever `maxResultBytes`
 * the deployment set, so the caller was never going to see it whole.
 */
const CLOUDFLARE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface CloudflareResponse {
  result: unknown;
  resultInfo: CloudflareResultInfo | undefined;
}

const AUTHENTICATION_CONTEXT = Symbol("cloudflareAuthentication");

type CloudflareContext = ConnectorContext & {
  [AUTHENTICATION_CONTEXT]?: CloudflareAuthentication;
};

function withAuthentication(
  ctx: ConnectorContext,
  authentication: CloudflareAuthentication,
): CloudflareContext {
  return { ...ctx, [AUTHENTICATION_CONTEXT]: authentication };
}

async function readAuthenticationHeaders(
  ctx: CloudflareContext,
): Promise<Record<string, string>> {
  if (ctx[AUTHENTICATION_CONTEXT] === "globalApiKey") {
    const values = await ctx.credential?.getAll();
    const email = values?.["email"];
    const apiKey = values?.["apiKey"];
    if (!email || !apiKey) {
      throw new ConnectorCallError(
        "auth_required",
        "No Cloudflare Global API Key and account email are configured for this connector. An operator must add both before any call can run.",
      );
    }
    return { "X-Auth-Email": email, "X-Auth-Key": apiKey };
  }

  const token = await ctx.credential?.get();
  if (!token) {
    throw new ConnectorCallError(
      "auth_required",
      "No Cloudflare API token is configured for this connector. An operator must add one before any call can run.",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * The one transport every Cloudflare tool goes through.
 *
 * URL confinement, `ctx.signal`, redirect refusal, bounded reads, and the
 * "could not reach the provider" normalization all live in the shared helper.
 * What stays here is what only Cloudflare knows: which headers prove identity,
 * and what a status code means once it arrives.
 */
function cloudflareTransport(baseUrl: string): GuardedTransport {
  return guardedFetch({
    provider: "Cloudflare",
    baseUrl,
    headers: { Accept: "application/json" },
    maxResponseBytes: CLOUDFLARE_MAX_RESPONSE_BYTES,
    authenticate: (ctx) => readAuthenticationHeaders(ctx as CloudflareContext),
  });
}

async function callCloudflare(
  send: GuardedTransport,
  spec: GuardedRequest,
  ctx: ConnectorContext,
): Promise<CloudflareResponse> {
  return await send(spec, ctx, async (response) => {
    let envelope: CloudflareEnvelope | undefined;
    let parseFailure: unknown;
    try {
      envelope = (await response.json()) as CloudflareEnvelope | undefined;
    } catch (cause) {
      // A transport failure is not a parse failure. The connector's byte
      // ceiling fires from inside this read and is deliberately non-retryable;
      // routing it through the branch below would relabel it as a retryable
      // `unavailable` and tell an agent to retry a response that will exceed
      // the ceiling every time.
      if (cause instanceof ConnectorCallError) throw cause;
      parseFailure = cause;
    }
    if (envelope === undefined) {
      // A gateway error page or an empty body, not an envelope: the status is
      // the only real signal left.
      throw response.ok
        ? new ConnectorCallError(
            "unavailable",
            "Cloudflare returned a non-JSON body for a successful status.",
            parseFailure !== undefined ? { cause: parseFailure } : {},
          )
        : failureFor(response.status, response.headers, []);
    }

    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    if (!response.ok || envelope.success === false) {
      throw failureFor(response.status, response.headers, errors);
    }
    const isV4Envelope =
      "success" in envelope ||
      "result" in envelope ||
      "result_info" in envelope ||
      "messages" in envelope;
    return {
      // `/graphql` and a small number of product APIs return ordinary JSON
      // instead of the standard v4 envelope. Preserve that document whole so
      // the raw tools cover them too.
      result: isV4Envelope ? envelope.result : envelope,
      resultInfo: isV4Envelope ? envelope.result_info : undefined,
    };
  });
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function callCloudflareContent(
  send: GuardedTransport,
  spec: GuardedRequest,
  ctx: ConnectorContext,
  responseType: "text" | "base64",
): Promise<JsonRecord> {
  return await send(spec, ctx, async (response) => {
    if (!response.ok) {
      let errors: CloudflareEnvelopeError[] = [];
      try {
        const envelope = (await response.json()) as
          | CloudflareEnvelope
          | undefined;
        if (envelope && Array.isArray(envelope.errors)) errors = envelope.errors;
      } catch {
        // A raw or gateway error body has no structured detail to preserve,
        // and one past the byte ceiling has none worth reporting over the
        // status that already failed this call. Either way the throw below
        // classifies the status, so nothing is swallowed into a success.
      }
      throw failureFor(response.status, response.headers, errors);
    }
    const common = {
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      ...(response.headers.get("etag")
        ? { etag: response.headers.get("etag")! }
        : {}),
    };
    if (responseType === "text") {
      return { ...common, text: await response.text() };
    }
    return { ...common, base64: base64FromBytes(await response.bytes()) };
  });
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
    ...(bucket["jurisdiction"] !== undefined
      ? { jurisdiction: bucket["jurisdiction"] }
      : {}),
    ...(bucket["creation_date"] !== undefined
      ? { creationDate: bucket["creation_date"] }
      : {}),
  };
}

function projectR2Object(value: unknown): JsonRecord {
  const object = asRecord(value);
  return {
    key: object["key"],
    size: object["size"],
    etag: object["etag"],
    lastModified: object["last_modified"],
    ...(object["storage_class"] !== undefined
      ? { storageClass: object["storage_class"] }
      : {}),
    ...(object["http_metadata"] !== undefined
      ? { httpMetadata: object["http_metadata"] }
      : {}),
    ...(object["custom_metadata"] !== undefined
      ? { customMetadata: object["custom_metadata"] }
      : {}),
  };
}

function projectKvKey(value: unknown): JsonRecord {
  const key = asRecord(value);
  return {
    name: key["name"],
    ...(key["expiration"] !== undefined ? { expiration: key["expiration"] } : {}),
    ...(key["metadata"] !== undefined ? { metadata: key["metadata"] } : {}),
  };
}

function projectWorkerDeployment(value: unknown): JsonRecord {
  const deployment = asRecord(value);
  return {
    id: deployment["id"],
    ...(deployment["created_on"] !== undefined
      ? { createdOn: deployment["created_on"] }
      : {}),
    ...(deployment["source"] !== undefined ? { source: deployment["source"] } : {}),
    ...(deployment["strategy"] !== undefined
      ? { strategy: deployment["strategy"] }
      : {}),
    ...(deployment["versions"] !== undefined
      ? { versions: deployment["versions"] }
      : {}),
  };
}

function projectPagesDeployment(value: unknown): JsonRecord {
  const deployment = asRecord(value);
  return {
    id: deployment["id"],
    ...(deployment["project_name"] !== undefined
      ? { projectName: deployment["project_name"] }
      : {}),
    ...(deployment["environment"] !== undefined
      ? { environment: deployment["environment"] }
      : {}),
    ...(deployment["url"] !== undefined ? { url: deployment["url"] } : {}),
    ...(deployment["aliases"] !== undefined ? { aliases: deployment["aliases"] } : {}),
    ...(deployment["stage"] !== undefined ? { stage: deployment["stage"] } : {}),
    ...(deployment["latest_stage"] !== undefined
      ? { latestStage: deployment["latest_stage"] }
      : {}),
    ...(deployment["created_on"] !== undefined
      ? { createdOn: deployment["created_on"] }
      : {}),
    ...(deployment["modified_on"] !== undefined
      ? { modifiedOn: deployment["modified_on"] }
      : {}),
  };
}

function projectPagesDomain(value: unknown): JsonRecord {
  const domain = asRecord(value);
  return {
    id: domain["id"],
    name: domain["name"],
    ...(domain["status"] !== undefined ? { status: domain["status"] } : {}),
    ...(domain["verification_data"] !== undefined
      ? { verificationData: domain["verification_data"] }
      : {}),
    ...(domain["created_on"] !== undefined
      ? { createdOn: domain["created_on"] }
      : {}),
  };
}

function projectRuleset(value: unknown): JsonRecord {
  const ruleset = asRecord(value);
  return {
    id: ruleset["id"],
    name: ruleset["name"],
    kind: ruleset["kind"],
    phase: ruleset["phase"],
    ...(ruleset["description"] !== undefined
      ? { description: ruleset["description"] }
      : {}),
    ...(ruleset["version"] !== undefined ? { version: ruleset["version"] } : {}),
    ...(ruleset["last_updated"] !== undefined
      ? { lastUpdated: ruleset["last_updated"] }
      : {}),
    ...(ruleset["rules"] !== undefined ? { rules: ruleset["rules"] } : {}),
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
 * Cloudflare's per-page bounds and default differ per endpoint and it rejects
 * an out-of-range value with a 400, so each caller passes its own. Encoding
 * them in the schema turns a wasted round trip into a local repair — but only
 * where the bound is really Cloudflare's. `bounds` records who chose the
 * range, because `api()` refuses an out-of-range `perPage` locally and an
 * agent deserves to know whether the wall it hit is the API's or ours:
 *
 * - `"cloudflare"` — the schema's own documented minimum and maximum.
 * - `"clamped"` — Cloudflare accepts more; this connection caps it lower.
 * - `"undocumented"` — Cloudflare documents no bounds at all for the endpoint,
 *   so the range is entirely this connection's choice.
 */
function pagingInputProperties(
  minPerPage: number,
  maxPerPage: number,
  options: {
    defaultPerPage?: number;
    bounds?: "cloudflare" | "clamped" | "undocumented";
  } = {},
): Record<string, JsonSchema> {
  const { defaultPerPage, bounds = "cloudflare" } = options;
  const defaultNote =
    defaultPerPage === undefined
      ? " Cloudflare chooses the default."
      : ` Defaults to ${defaultPerPage}.`;
  const boundsNote =
    bounds === "clamped"
      ? ` The ${maxPerPage} ceiling is this connection's cap, not Cloudflare's limit.`
      : bounds === "undocumented"
        ? " Cloudflare documents no bounds for this endpoint; the range is this connection's own."
        : "";
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
      description: `Items per page, ${minPerPage} to ${maxPerPage}.${defaultNote}${boundsNote}`,
    },
  };
}

/**
 * The second pagination convention, and the schemas say so.
 *
 * Rulesets, KV keys, and both R2 listings page by cursor rather than by page
 * number, because that is how Cloudflare built them. The guide names the four,
 * but an agent reading one tool's schema should not have to fetch the guide to
 * learn that the `page` object it expected is not coming: absence of
 * `nextCursor` is the loop condition here, and it is stated on both ends
 * ([#342](https://github.com/zackbart/connecta/issues/342)).
 */
const CURSOR_INPUT_PROPERTY: JsonSchema = {
  type: "string",
  description:
    "Opaque cursor from a previous call's nextCursor. This endpoint pages by cursor, not page number.",
};

const NEXT_CURSOR_OUTPUT_PROPERTY: JsonSchema = {
  type: "string",
  description:
    "Pass back as `cursor` to continue. Absent when the listing is complete — this is the only signal; there is no page object.",
};

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
  send: GuardedTransport;
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

function optionalBoolean(args: JsonRecord, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireString(args: JsonRecord, key: string): string {
  const value = optionalString(args, key);
  if (value) return value;
  throw new ConnectorCallError("invalid_args", `${key} must not be blank.`);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function encodeObjectKey(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new ConnectorCallError(
          "invalid_args",
          "objectKey cannot contain '.' or '..' path segments because URL normalization would change the target resource.",
        );
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

function cloudflareApiPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConnectorCallError("invalid_args", "path must be a string.");
  }
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new ConnectorCallError(
      "invalid_args",
      "path must be a relative Cloudflare v4 path beginning with one slash and containing no backslashes.",
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new ConnectorCallError(
      "invalid_args",
      "Put query parameters in the query array; path cannot contain '?' or '#'.",
    );
  }
  for (const segment of path.split("/")) {
    let decoded = segment;
    let stable = false;
    for (let pass = 0; pass < 20; pass += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new ConnectorCallError(
          "invalid_args",
          "path contains invalid percent encoding.",
        );
      }
      if (next === decoded) {
        stable = true;
        break;
      }
      decoded = next;
    }
    if (!stable) {
      throw new ConnectorCallError(
        "invalid_args",
        "path contains too many layers of percent encoding.",
      );
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new ConnectorCallError(
        "invalid_args",
        "path cannot contain encoded or literal traversal, slash, or backslash segments.",
      );
    }
  }
  const normalized = new URL(`https://connecta.invalid/client/v4${path}`);
  if (!normalized.pathname.startsWith("/client/v4/")) {
    throw new ConnectorCallError(
      "invalid_args",
      "path normalization escaped the Cloudflare v4 API base.",
    );
  }
  return path;
}

function queryFromArgs(
  value: unknown,
): Record<string, string | number | boolean | undefined> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const query: Record<string, string> = {};
  for (const item of value) {
    const entry = asRecord(item);
    query[String(entry["name"])] = String(entry["value"]);
  }
  return query;
}

function headersFromArgs(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const headers: Record<string, string> = {};
  const forbidden = new Set([
    "authorization",
    "x-auth-email",
    "x-auth-key",
    "cookie",
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
  ]);
  for (const item of value) {
    const entry = asRecord(item);
    const name = String(entry["name"]).trim();
    if (forbidden.has(name.toLowerCase())) {
      throw new ConnectorCallError(
        "invalid_args",
        `The raw Cloudflare tools do not allow the ${name} header. Authentication and request framing are connector-owned; use contentType for a raw upload body.`,
      );
    }
    headers[name] = String(entry["value"]);
  }
  return headers;
}

function r2Headers(args: JsonRecord): Record<string, string | undefined> {
  return { "cf-r2-jurisdiction": optionalString(args, "jurisdiction") };
}

function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (cause) {
    throw new ConnectorCallError(
      "invalid_args",
      "base64Body and multipart file base64 values must be valid base64.",
      { cause },
    );
  }
}

function uploadBody(args: JsonRecord): {
  rawBody: BodyInit;
  headers?: Record<string, string | undefined>;
} {
  const fields = asArray(args["fields"]);
  const files = asArray(args["files"]);
  const hasMultipart = fields.length > 0 || files.length > 0;
  const textBody = typeof args["textBody"] === "string" ? args["textBody"] : undefined;
  const base64Body =
    typeof args["base64Body"] === "string" ? args["base64Body"] : undefined;
  const rawCount = Number(textBody !== undefined) + Number(base64Body !== undefined);
  if ((hasMultipart && rawCount > 0) || (!hasMultipart && rawCount !== 1)) {
    throw new ConnectorCallError(
      "invalid_args",
      "cloudflare_api_upload needs exactly one body shape: textBody, base64Body, or multipart fields/files.",
    );
  }
  if (hasMultipart) {
    const form = new FormData();
    for (const value of fields) {
      const field = asRecord(value);
      const name = String(field["name"]);
      const contentType = optionalString(field, "contentType");
      if (contentType) {
        form.append(
          name,
          new Blob([String(field["value"])], { type: contentType }),
          optionalString(field, "fileName") ?? name,
        );
      } else {
        form.append(name, String(field["value"]));
      }
    }
    for (const value of files) {
      const file = asRecord(value);
      const text = typeof file["text"] === "string" ? file["text"] : undefined;
      const base64 =
        typeof file["base64"] === "string" ? file["base64"] : undefined;
      if (Number(text !== undefined) + Number(base64 !== undefined) !== 1) {
        throw new ConnectorCallError(
          "invalid_args",
          "Each multipart file needs exactly one of text or base64.",
        );
      }
      const blob = new Blob(
        [text ?? bytesFromBase64(base64!)],
        { type: String(file["contentType"] ?? "application/octet-stream") },
      );
      form.append(String(file["name"]), blob, String(file["fileName"]));
    }
    return { rawBody: form };
  }
  return {
    rawBody: textBody ?? bytesFromBase64(base64Body!),
    headers: {
      "Content-Type":
        optionalString(args, "contentType") ??
        (textBody !== undefined ? "text/plain; charset=utf-8" : "application/octet-stream"),
    },
  };
}

const OPEN_OBJECT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  description: "Cloudflare's result object. Its fields depend on the endpoint.",
  additionalProperties: true,
};

const QUERY_INPUT_PROPERTY: JsonSchema = {
  type: "array",
  description:
    "Query parameters as name/value pairs; each name may appear once.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      value: { type: ["string", "number", "boolean"] },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

// Shared by all three escape hatches, and the compact renderer inlines it
// three times over. The refused-header list is the connector's boundary rather
// than a fact the caller composes with, so it lives in the usage guide; keeping
// it here pushed cloudflare_api_upload's compact input past the 1,024-byte
// budget ([#342](https://github.com/zackbart/connecta/issues/342)).
const HEADERS_INPUT_PROPERTY: JsonSchema = {
  type: "array",
  description:
    "Endpoint headers as name/value pairs, e.g. cf-r2-jurisdiction or Range. Connector-owned headers are refused.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      value: { type: "string" },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

const R2_JURISDICTION_PROPERTY: JsonSchema = {
  type: "string",
  enum: ["default", "eu", "fedramp"],
  description:
    "Bucket jurisdiction. Omit for ordinary buckets; set eu or fedramp for jurisdictional buckets.",
};

const R2_BUCKET_NAME_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 3,
  maxLength: 64,
  description: "R2 bucket name.",
};

const R2_BUCKET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    location: { type: "string" },
    storageClass: { type: "string" },
    jurisdiction: { type: "string" },
    creationDate: { type: "string" },
  },
  required: ["name"],
};

const R2_OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    size: { type: "number" },
    etag: { type: "string" },
    lastModified: { type: "string" },
    storageClass: { type: "string" },
    httpMetadata: { type: "object" },
    customMetadata: { type: "object" },
  },
  required: ["key"],
};

function buildTools(
  scope: Scoping,
  authentication: CloudflareAuthentication,
): ApiTool[] {
  const { send } = scope;
  const zoneArg = (args: JsonRecord): string =>
    requireScope(args["zoneId"], scope.zoneId, "zoneId");
  const accountArg = (args: JsonRecord): string =>
    requireScope(args["accountId"], scope.accountId, "accountId");

  const readOnly = { readOnlyHint: true, destructiveHint: false } as const;

  const tools: ApiTool[] = [
    authentication === "apiToken"
      ? {
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
              send,
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
        }
      : {
          name: "verify_global_api_key",
          description:
            "Verify the configured Cloudflare Global API Key and account email by retrieving the authenticated user. Use this first when another tool fails with an authentication error.",
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
              email: { type: "string" },
              status: {
                type: "string",
                description: "\"active\" when Cloudflare accepts the email and key.",
              },
            },
            required: ["email", "status"],
          },
          handler: async (_args, ctx) => {
            const { result } = await callCloudflare(
              send,
              { method: "GET", path: "/user" },
              ctx,
            );
            const user = asRecord(result);
            return { id: user["id"], email: user["email"], status: "active" };
          },
        },
    {
      name: "cloudflare_api_get",
      description:
        "Call any GET endpoint under Cloudflare's v4 API with this connector's credential. Prefer a named tool when one exists; this read-only hatch covers the products the named surface does not reach, such as Images, Stream, D1, and Queues.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description:
              "Relative path below /client/v4, beginning with '/', for example /accounts/<id>/images/v1 or /zones/<id>/email/routing/rules. Do not include a query string.",
          },
          query: QUERY_INPUT_PROPERTY,
          headers: HEADERS_INPUT_PROPERTY,
          responseType: {
            type: "string",
            enum: ["json", "text", "base64"],
            description:
              "How to read a successful response. Defaults to json; use text or base64 for object, log, script, and media downloads.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          result: {
            description: "Cloudflare's unprojected result for the endpoint.",
          },
          resultInfo: {
            type: "object",
            description:
              "Cloudflare's unprojected pagination metadata, when the endpoint returns it.",
          },
          text: { type: "string", description: "Text response body when responseType is text." },
          base64: { type: "string", description: "Base64 response bytes when responseType is base64." },
          contentType: { type: "string", description: "Response Content-Type for text/base64 reads." },
          etag: { type: "string", description: "Response ETag when Cloudflare supplies one." },
        },
        required: [],
      },
      handler: async (args: JsonRecord, ctx) => {
        const query = queryFromArgs(args["query"]);
        const headers = headersFromArgs(args["headers"]);
        const responseType = optionalString(args, "responseType") ?? "json";
        const spec: GuardedRequest = {
          method: "GET",
          path: cloudflareApiPath(args["path"]),
          ...(query !== undefined ? { query } : {}),
          ...(headers !== undefined ? { headers } : {}),
        };
        if (responseType === "text" || responseType === "base64") {
          return await callCloudflareContent(send, spec, ctx, responseType);
        }
        const { result, resultInfo } = await callCloudflare(
          send,
          spec,
          ctx,
        );
        return {
          result,
          ...(resultInfo !== undefined ? { resultInfo } : {}),
        };
      },
    },
    {
      name: "cloudflare_api_mutate",
      description:
        "Call any JSON POST, PUT, PATCH, or DELETE endpoint under Cloudflare's v4 API with this connector's credential. The approval-gated write hatch for products the named surface does not reach. No multipart or binary uploads.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["POST", "PUT", "PATCH", "DELETE"],
            description: "HTTP mutation method required by the Cloudflare endpoint.",
          },
          path: {
            type: "string",
            minLength: 1,
            description:
              "Relative path below /client/v4, beginning with '/'. Do not include a query string.",
          },
          query: QUERY_INPUT_PROPERTY,
          headers: HEADERS_INPUT_PROPERTY,
          body: {
            type: ["object", "array", "string", "number", "boolean", "null"],
            description:
              "JSON request body exactly as documented by Cloudflare. Omit for endpoints with no body.",
          },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          result: {
            description: "Cloudflare's unprojected result for the endpoint.",
          },
          resultInfo: {
            type: "object",
            description:
              "Cloudflare's unprojected pagination metadata, when the endpoint returns it.",
          },
        },
        required: ["result"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const method = String(args["method"]) as GuardedRequest["method"];
        const query = queryFromArgs(args["query"]);
        const headers = headersFromArgs(args["headers"]);
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method,
            path: cloudflareApiPath(args["path"]),
            ...(query !== undefined ? { query } : {}),
            ...(headers !== undefined ? { headers } : {}),
            ...(args["body"] !== undefined ? { body: args["body"] } : {}),
          },
          ctx,
        );
        return {
          result,
          ...(resultInfo !== undefined ? { resultInfo } : {}),
        };
      },
    },
    {
      name: "cloudflare_api_upload",
      description:
        "Upload raw text, base64 bytes, or multipart form data to a Cloudflare v4 POST or PUT endpoint. Covers Worker modules, R2/KV objects, Images, Stream, and Pages upload endpoints. Reads no local files; content must be supplied explicitly.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["POST", "PUT"],
            description: "Upload method the Cloudflare endpoint requires.",
          },
          path: {
            type: "string",
            minLength: 1,
            description:
              "Path below /client/v4, beginning with '/'. No query string.",
          },
          query: QUERY_INPUT_PROPERTY,
          headers: HEADERS_INPUT_PROPERTY,
          contentType: {
            type: "string",
            minLength: 1,
            description:
              "Content-Type for a raw text or base64 body. Omit for multipart.",
          },
          textBody: {
            type: "string",
            description: "Raw UTF-8 body. Exclusive with base64Body and fields/files.",
          },
          base64Body: {
            type: "string",
            description: "Base64-encoded body bytes. Exclusive with textBody and fields/files.",
          },
          fields: {
            type: "array",
            description: "String fields of a multipart/form-data request.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1 },
                value: { type: "string" },
                contentType: { type: "string", minLength: 1 },
                fileName: { type: "string", minLength: 1 },
              },
              required: ["name", "value"],
              additionalProperties: false,
            },
          },
          files: {
            type: "array",
            description:
              "Multipart file parts. Each needs exactly one of text or base64.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1 },
                fileName: { type: "string", minLength: 1 },
                contentType: { type: "string", minLength: 1 },
                text: { type: "string" },
                base64: { type: "string" },
              },
              required: ["name", "fileName", "contentType"],
              additionalProperties: false,
            },
          },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          result: {
            description: "Cloudflare's unprojected upload result.",
          },
        },
        required: ["result"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const query = queryFromArgs(args["query"]);
        const headers = headersFromArgs(args["headers"]);
        const upload = uploadBody(args);
        const { result } = await callCloudflare(
          send,
          {
            method: String(args["method"]) as "POST" | "PUT",
            path: cloudflareApiPath(args["path"]),
            ...(query !== undefined ? { query } : {}),
            ...(headers !== undefined || upload.headers !== undefined
              ? { headers: { ...headers, ...upload.headers } }
              : {}),
            rawBody: upload.rawBody,
          },
          ctx,
        );
        return { result };
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
          ...pagingInputProperties(5, 50, { defaultPerPage: 20 }),
          raw: RAW_INPUT_PROPERTY,
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("accounts", ACCOUNT_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
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
          ...pagingInputProperties(5, 50, { defaultPerPage: 20 }),
          raw: RAW_INPUT_PROPERTY,
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("zones", ZONE_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method: "GET",
            path: "/zones",
            query: {
              name: optionalString(args, "name"),
              // Deliberately not defaulted to `scope.accountId`. This is the
              // discovery tool: a deployment default that silently narrowed
              // what an agent can see would contradict the property's own
              // description, and there would be no argument that escapes it.
              "account.id": optionalString(args, "accountId"),
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
          send,
          { method: "GET", path: `/zones/${encodeURIComponent(zoneArg(args))}` },
          ctx,
        );
        return args["raw"] === true ? result : projectZone(result);
      },
    },
    // There is deliberately no bulk zone-settings read here. Cloudflare
    // publishes `GET /zones/{zone_id}/settings` as deprecated (#361), the
    // per-setting operations below are not, and the tool that wrapped the bulk
    // read projected nothing. See the Cloudflare guide's "What the named
    // surface deliberately leaves out".
    {
      name: "get_zone_setting",
      description:
        "Get one zone setting by its Cloudflare setting id, such as ssl, always_use_https, min_tls_version, brotli, or development_mode.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          settingId: {
            type: "string",
            minLength: 1,
            description:
              "Cloudflare zone setting id, such as ssl, brotli, http3, or min_tls_version.",
          },
        },
        required: [...scopeRequired("zoneId", scope.zoneId), "settingId"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/zones/${encodePathSegment(zoneArg(args))}/settings/${encodePathSegment(requireString(args, "settingId"))}`,
          },
          ctx,
        );
        return result;
      },
    },
    {
      name: "update_zone_setting",
      description:
        "Set one editable zone setting. Read it first: allowed value types and plan restrictions differ by setting.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          settingId: {
            type: "string",
            minLength: 1,
            description:
              "Cloudflare zone setting id, such as ssl, brotli, http3, or min_tls_version.",
          },
          value: {
            type: ["string", "number", "boolean", "array"],
            description:
              "New setting value in the type returned by get_zone_setting. Arrays must contain strings.",
            items: { type: "string" },
          },
        },
        required: [...scopeRequired("zoneId", scope.zoneId), "settingId", "value"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "PATCH",
            path: `/zones/${encodePathSegment(zoneArg(args))}/settings/${encodePathSegment(requireString(args, "settingId"))}`,
            body: { value: args["value"] },
          },
          ctx,
        );
        return result;
      },
    },
    {
      name: "list_zone_rulesets",
      description:
        "List zone rulesets for WAF, redirects, transforms, cache rules, configuration rules, and other Ruleset Engine phases.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          perPage: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Rulesets per request, 1 to 50.",
          },
          cursor: CURSOR_INPUT_PROPERTY,
        },
        required: scopeRequired("zoneId", scope.zoneId),
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          rulesets: { type: "array", items: OPEN_OBJECT_OUTPUT_SCHEMA },
          nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
        },
        required: ["rulesets"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/zones/${encodePathSegment(zoneArg(args))}/rulesets`,
            query: {
              per_page: optionalNumber(args, "perPage"),
              cursor: optionalString(args, "cursor"),
            },
          },
          ctx,
        );
        const cursor = resultInfo?.cursors?.after;
        return {
          rulesets: asArray(result).map(projectRuleset),
          ...(typeof cursor === "string" && cursor !== ""
            ? { nextCursor: cursor }
            : {}),
        };
      },
    },
    {
      name: "get_zone_ruleset",
      description:
        "Get one zone ruleset including its ordered rules, expressions, actions, parameters, and enabled state.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          zoneId: scopeProperty("zoneId", scope.zoneId),
          rulesetId: {
            type: "string",
            minLength: 1,
            description: "Ruleset id from list_zone_rulesets.",
          },
        },
        required: [...scopeRequired("zoneId", scope.zoneId), "rulesetId"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/zones/${encodePathSegment(zoneArg(args))}/rulesets/${encodePathSegment(requireString(args, "rulesetId"))}`,
          },
          ctx,
        );
        return projectRuleset(result);
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
          direction: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort direction for `order`. Defaults to asc.",
          },
          // Cloudflare documents 1 to 5,000,000 here with a default of 100; the
          // ceiling is nominal, so this connection caps it at a page size that
          // actually returns.
          ...pagingInputProperties(1, 1000, {
            defaultPerPage: 100,
            bounds: "clamped",
          }),
          raw: RAW_INPUT_PROPERTY,
        },
        required: scopeRequired("zoneId", scope.zoneId),
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("records", DNS_RECORD_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
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
          send,
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
          send,
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
      name: "get_worker_settings",
      description:
        "Get a Worker's compatibility date and flags, bindings, limits, observability, placement, usage model, and other script settings.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          scriptName: {
            type: "string",
            minLength: 1,
            description: "Worker script name from list_worker_scripts.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "scriptName"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/workers/scripts/${encodePathSegment(requireString(args, "scriptName"))}/settings`,
          },
          ctx,
        );
        return result;
      },
    },
    {
      name: "list_worker_deployments",
      description:
        "List deployments of a Worker script, including version traffic allocations and deployment strategy.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          scriptName: {
            type: "string",
            minLength: 1,
            description: "Worker script name from list_worker_scripts.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "scriptName"],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("deployments", OPEN_OBJECT_OUTPUT_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/workers/scripts/${encodePathSegment(requireString(args, "scriptName"))}/deployments`,
          },
          ctx,
        );
        const record = asRecord(result);
        const deployments = Array.isArray(result)
          ? result
          : asArray(record["deployments"]);
        return { deployments: deployments.map(projectWorkerDeployment) };
      },
    },
    {
      name: "get_worker_deployment",
      description: "Get one Worker deployment and its version traffic allocations.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          scriptName: {
            type: "string",
            minLength: 1,
            description: "Worker script name from list_worker_scripts.",
          },
          deploymentId: {
            type: "string",
            minLength: 1,
            description: "Deployment id from list_worker_deployments.",
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "scriptName",
          "deploymentId",
        ],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/workers/scripts/${encodePathSegment(requireString(args, "scriptName"))}/deployments/${encodePathSegment(requireString(args, "deploymentId"))}`,
          },
          ctx,
        );
        return projectWorkerDeployment(result);
      },
    },
    {
      name: "delete_worker_script",
      description:
        "Delete a Worker script and stop traffic served by that script. This cannot be undone from the API.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          scriptName: {
            type: "string",
            minLength: 1,
            description: "Worker script name from list_worker_scripts.",
          },
          force: {
            type: "boolean",
            description:
              "Pass Cloudflare's force=true option when the script has dependencies that permit forced removal.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "scriptName"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          scriptName: { type: "string" },
        },
        required: ["deleted", "scriptName"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const scriptName = requireString(args, "scriptName");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/workers/scripts/${encodePathSegment(scriptName)}`,
            query: { force: optionalBoolean(args, "force") },
          },
          ctx,
        );
        return { deleted: true, scriptName };
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
          ...pagingInputProperties(1, 1000, { defaultPerPage: 20 }),
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
          send,
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
      name: "get_kv_namespace",
      description: "Get one Workers KV namespace by id.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "namespaceId"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(requireString(args, "namespaceId"))}`,
          },
          ctx,
        );
        return projectKvNamespace(result);
      },
    },
    {
      name: "create_kv_namespace",
      description: "Create a Workers KV namespace.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          title: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Human-readable namespace title.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "title"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces`,
            body: { title: requireString(args, "title") },
          },
          ctx,
        );
        return projectKvNamespace(result);
      },
    },
    {
      name: "rename_kv_namespace",
      description: "Rename an existing Workers KV namespace without changing its id or keys.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Replacement namespace title.",
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "namespaceId",
          "title",
        ],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "PUT",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(requireString(args, "namespaceId"))}`,
            body: { title: requireString(args, "title") },
          },
          ctx,
        );
        return result ?? { renamed: true, namespaceId: args["namespaceId"] };
      },
    },
    {
      name: "delete_kv_namespace",
      description: "Permanently delete a Workers KV namespace and every key stored in it.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "namespaceId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          namespaceId: { type: "string" },
        },
        required: ["deleted", "namespaceId"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const namespaceId = requireString(args, "namespaceId");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(namespaceId)}`,
          },
          ctx,
        );
        return { deleted: true, namespaceId };
      },
    },
    {
      name: "list_kv_keys",
      description:
        "List keys and metadata in a Workers KV namespace by prefix, using cursor pagination.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
          prefix: {
            type: "string",
            description: "Return only keys beginning with this prefix.",
          },
          limit: {
            type: "integer",
            minimum: 10,
            maximum: 1000,
            description: "Keys per request, 10 to 1000. Defaults to 1000.",
          },
          cursor: CURSOR_INPUT_PROPERTY,
        },
        required: [...scopeRequired("accountId", scope.accountId), "namespaceId"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          keys: { type: "array", items: OPEN_OBJECT_OUTPUT_SCHEMA },
          nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
        },
        required: ["keys"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(requireString(args, "namespaceId"))}/keys`,
            query: {
              prefix: optionalString(args, "prefix"),
              limit: optionalNumber(args, "limit"),
              cursor: optionalString(args, "cursor"),
            },
          },
          ctx,
        );
        const cursor = resultInfo?.cursor;
        return {
          keys: asArray(result).map(projectKvKey),
          ...(typeof cursor === "string" && cursor !== ""
            ? { nextCursor: cursor }
            : {}),
        };
      },
    },
    {
      name: "bulk_get_kv_values",
      description:
        "Read up to 100 Workers KV values in one request. This JSON endpoint is suitable for text and JSON values; use the raw API for specialized response types.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
          keys: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 512 },
            description: "Key names to retrieve, up to 100.",
          },
          withMetadata: {
            type: "boolean",
            description: "Include each key's metadata and expiration when true.",
          },
          type: {
            type: "string",
            enum: ["text", "json"],
            description: "Return strings as stored, or parse JSON values before returning them.",
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "namespaceId",
          "keys",
        ],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(requireString(args, "namespaceId"))}/bulk/get`,
            body: {
              keys: args["keys"],
              ...(args["withMetadata"] !== undefined
                ? { withMetadata: args["withMetadata"] }
                : {}),
              ...(args["type"] !== undefined ? { type: args["type"] } : {}),
            },
          },
          ctx,
        );
        return asRecord(result);
      },
    },
    {
      name: "bulk_write_kv_values",
      description:
        "Create or replace multiple Workers KV values, with optional expirations and JSON metadata.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
          entries: {
            type: "array",
            minItems: 1,
            maxItems: 10_000,
            description: "Key/value entries to write, up to Cloudflare's 10,000-key bulk limit.",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  minLength: 1,
                  maxLength: 512,
                  description: "Key name, up to Cloudflare's 512 bytes.",
                },
                value: {
                  type: "string",
                  maxLength: 26_214_400,
                  description: "Value, up to Cloudflare's 25 MiB.",
                },
                expiration: {
                  type: "number",
                  description: "Absolute expiry as a Unix timestamp in seconds.",
                },
                expiration_ttl: {
                  type: "number",
                  minimum: 60,
                  description: "Relative expiry in seconds; Cloudflare's floor is 60.",
                },
                metadata: {
                  type: ["object", "array", "string", "number", "boolean", "null"],
                  description: "JSON metadata returned beside the key by list_kv_keys.",
                },
                base64: {
                  type: "boolean",
                  description: "Treat value as base64 and store the decoded bytes.",
                },
              },
              required: ["key", "value"],
              additionalProperties: false,
            },
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "namespaceId",
          "entries",
        ],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "PUT",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(requireString(args, "namespaceId"))}/bulk`,
            body: args["entries"],
          },
          ctx,
        );
        return asRecord(result);
      },
    },
    {
      name: "bulk_delete_kv_values",
      description: "Permanently delete multiple keys from a Workers KV namespace.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          namespaceId: {
            type: "string",
            minLength: 1,
            description: "KV namespace id from list_kv_namespaces.",
          },
          keys: {
            type: "array",
            minItems: 1,
            maxItems: 10_000,
            items: { type: "string", minLength: 1, maxLength: 512 },
            description: "Key names to delete, up to Cloudflare's 10,000-key bulk limit.",
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "namespaceId",
          "keys",
        ],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/storage/kv/namespaces/${encodePathSegment(requireString(args, "namespaceId"))}/bulk/delete`,
            body: args["keys"],
          },
          ctx,
        );
        return asRecord(result);
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
          cursor: CURSOR_INPUT_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
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
                jurisdiction: { type: "string" },
                creationDate: { type: "string" },
              },
              required: ["name"],
            },
          },
          nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
        },
        required: ["buckets"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodeURIComponent(accountArg(args))}/r2/buckets`,
            query: {
              name_contains: optionalString(args, "nameContains"),
              per_page: optionalNumber(args, "perPage"),
              cursor: optionalString(args, "cursor"),
            },
            headers: r2Headers(args),
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
      name: "get_r2_bucket",
      description: "Get one R2 bucket's location, jurisdiction, storage class, and creation time.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
        },
        required: [...scopeRequired("accountId", scope.accountId), "bucketName"],
        additionalProperties: false,
      },
      outputSchema: R2_BUCKET_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets/${encodePathSegment(requireString(args, "bucketName"))}`,
            headers: r2Headers(args),
          },
          ctx,
        );
        return projectR2Bucket(result);
      },
    },
    {
      name: "create_r2_bucket",
      description: "Create an R2 bucket with an optional location hint and default storage class.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
          locationHint: {
            type: "string",
            enum: ["apac", "eeur", "enam", "weur", "wnam", "oc"],
            description: "Optional placement hint for the new bucket.",
          },
          storageClass: {
            type: "string",
            enum: ["Standard", "InfrequentAccess"],
            description: "Default storage class for new objects.",
          },
        },
        required: [...scopeRequired("accountId", scope.accountId), "bucketName"],
        additionalProperties: false,
      },
      outputSchema: R2_BUCKET_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets`,
            headers: r2Headers(args),
            body: {
              name: requireString(args, "bucketName"),
              ...(args["locationHint"] !== undefined
                ? { locationHint: args["locationHint"] }
                : {}),
              ...(args["storageClass"] !== undefined
                ? { storageClass: args["storageClass"] }
                : {}),
            },
          },
          ctx,
        );
        return projectR2Bucket(result);
      },
    },
    {
      name: "update_r2_bucket",
      description: "Change the default storage class used for newly uploaded objects in an R2 bucket.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
          storageClass: {
            type: "string",
            enum: ["Standard", "InfrequentAccess"],
            description: "New default storage class for future uploads.",
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "bucketName",
          "storageClass",
        ],
        additionalProperties: false,
      },
      outputSchema: R2_BUCKET_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "PATCH",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets/${encodePathSegment(requireString(args, "bucketName"))}`,
            headers: {
              ...r2Headers(args),
              "cf-r2-storage-class": String(args["storageClass"]),
            },
          },
          ctx,
        );
        return projectR2Bucket(result);
      },
    },
    {
      name: "delete_r2_bucket",
      description:
        "Permanently delete an empty R2 bucket and all of its configuration. Cloudflare refuses non-empty buckets.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
        },
        required: [...scopeRequired("accountId", scope.accountId), "bucketName"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          bucketName: { type: "string" },
        },
        required: ["deleted", "bucketName"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const bucketName = requireString(args, "bucketName");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets/${encodePathSegment(bucketName)}`,
            headers: r2Headers(args),
          },
          ctx,
        );
        return { deleted: true, bucketName };
      },
    },
    {
      name: "list_r2_objects",
      description:
        "List object keys and metadata in an R2 bucket by prefix, with delimiter grouping and cursor pagination.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
          prefix: {
            type: "string",
            description: "Return only object keys beginning with this prefix.",
          },
          delimiter: {
            type: "string",
            minLength: 1,
            maxLength: 1,
            description: "One character used to group path-like keys, usually '/'.",
          },
          startAfter: {
            type: "string",
            description: "Begin after this key in lexicographic order.",
          },
          perPage: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Objects per request, 1 to 1000.",
          },
          cursor: CURSOR_INPUT_PROPERTY,
        },
        required: [...scopeRequired("accountId", scope.accountId), "bucketName"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          objects: { type: "array", items: R2_OBJECT_SCHEMA },
          commonPrefixes: { type: "array", items: { type: "string" } },
          nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
          truncated: { type: "boolean" },
        },
        required: ["objects", "truncated"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets/${encodePathSegment(requireString(args, "bucketName"))}/objects`,
            headers: r2Headers(args),
            query: {
              prefix: optionalString(args, "prefix"),
              delimiter: optionalString(args, "delimiter"),
              start_after: optionalString(args, "startAfter"),
              per_page: optionalNumber(args, "perPage"),
              cursor: optionalString(args, "cursor"),
            },
          },
          ctx,
        );
        const cursor = resultInfo?.cursor;
        return {
          objects: asArray(result).map(projectR2Object),
          ...(Array.isArray(resultInfo?.delimited)
            ? { commonPrefixes: resultInfo.delimited }
            : {}),
          ...(typeof cursor === "string" && cursor !== ""
            ? { nextCursor: cursor }
            : {}),
          truncated: resultInfo?.is_truncated === true,
        };
      },
    },
    {
      name: "delete_r2_object",
      description: "Permanently delete one object from an R2 bucket by key.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
          objectKey: {
            type: "string",
            minLength: 1,
            description: "Exact object key. Slashes are preserved as path separators.",
          },
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "bucketName",
          "objectKey",
        ],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deleted: { type: "boolean" },
          objectKey: { type: "string" },
        },
        required: ["deleted", "objectKey"],
      },
      handler: async (args: JsonRecord, ctx) => {
        const objectKey = requireString(args, "objectKey");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets/${encodePathSegment(requireString(args, "bucketName"))}/objects/${encodeObjectKey(objectKey)}`,
            headers: r2Headers(args),
          },
          ctx,
        );
        return { deleted: true, objectKey };
      },
    },
    // No `get_r2_metrics`, `set_r2_cors`, or `delete_r2_cors` here on purpose.
    // The #350 measurement found `get_r2_metrics` an unprojected,
    // output-schema-less wrapper around a path, and `set_r2_cors` carrying a
    // free-form `additionalProperties: true` rule body, so its schema did not
    // validate the part of the call that actually fails. `delete_r2_cors`
    // measured clean — a fixed `{deleted}` confirmation behind a closed output
    // schema — and went anyway, as the other half of one policy pair: with the
    // write unnamed, a named delete would change a CORS policy through a
    // different route than setting it does. Reading a policy is still named;
    // changing one takes the approval-gated raw route, exactly as
    // structured-data DNS records already do.
    {
      name: "get_r2_cors",
      description: "Get the browser CORS rules configured on an R2 bucket.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          bucketName: R2_BUCKET_NAME_PROPERTY,
          jurisdiction: R2_JURISDICTION_PROPERTY,
        },
        required: [...scopeRequired("accountId", scope.accountId), "bucketName"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/r2/buckets/${encodePathSegment(requireString(args, "bucketName"))}/cors`,
            headers: r2Headers(args),
          },
          ctx,
        );
        return asRecord(result);
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
          ...pagingInputProperties(1, 100, { bounds: "undocumented" }),
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
          send,
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
      name: "get_pages_project",
      description: "Get one Pages project, including build configuration, deployment configuration, domains, and latest deployment.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: {
            type: "string",
            minLength: 1,
            description: "Pages project name from list_pages_projects.",
          },
          raw: RAW_INPUT_PROPERTY,
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}`,
          },
          ctx,
        );
        return args["raw"] === true ? result : projectPagesProject(result);
      },
    },
    {
      name: "list_pages_deployments",
      description: "List production and preview deployments for a Pages project.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: {
            type: "string",
            minLength: 1,
            description: "Pages project name from list_pages_projects.",
          },
          env: {
            type: "string",
            enum: ["production", "preview"],
            description: "Optional deployment environment filter.",
          },
          ...pagingInputProperties(1, 100, { bounds: "undocumented" }),
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName"],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("deployments", OPEN_OBJECT_OUTPUT_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result, resultInfo } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/deployments`,
            query: {
              env: optionalString(args, "env"),
              page: optionalNumber(args, "page"),
              per_page: optionalNumber(args, "perPage"),
            },
          },
          ctx,
        );
        return {
          deployments: asArray(result).map(projectPagesDeployment),
          page: pageInfo(resultInfo),
        };
      },
    },
    {
      name: "get_pages_deployment",
      description: "Get one Pages deployment including its environment, URLs, stages, source, and build configuration.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: {
            type: "string",
            minLength: 1,
            description: "Pages project name from list_pages_projects.",
          },
          deploymentId: {
            type: "string",
            minLength: 1,
            description: "Deployment id from list_pages_deployments.",
          },
          raw: RAW_INPUT_PROPERTY,
        },
        required: [
          ...scopeRequired("accountId", scope.accountId),
          "projectName",
          "deploymentId",
        ],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/deployments/${encodePathSegment(requireString(args, "deploymentId"))}`,
          },
          ctx,
        );
        return args["raw"] === true ? result : projectPagesDeployment(result);
      },
    },
    {
      name: "retry_pages_deployment",
      description: "Retry a failed or cancelled Pages deployment using its existing source and build configuration.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
          deploymentId: { type: "string", minLength: 1, description: "Deployment id to retry." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName", "deploymentId"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/deployments/${encodePathSegment(requireString(args, "deploymentId"))}/retry`,
          },
          ctx,
        );
        return projectPagesDeployment(result);
      },
    },
    {
      name: "rollback_pages_deployment",
      description: "Promote a previous Pages deployment to production, replacing the currently served production deployment.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
          deploymentId: { type: "string", minLength: 1, description: "Previous deployment id to promote." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName", "deploymentId"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/deployments/${encodePathSegment(requireString(args, "deploymentId"))}/rollback`,
          },
          ctx,
        );
        return projectPagesDeployment(result);
      },
    },
    {
      name: "delete_pages_deployment",
      description: "Permanently delete a Pages deployment and its immutable deployment URL.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
          deploymentId: { type: "string", minLength: 1, description: "Deployment id to delete." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName", "deploymentId"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { deleted: { type: "boolean" }, deploymentId: { type: "string" } }, required: ["deleted", "deploymentId"] },
      handler: async (args: JsonRecord, ctx) => {
        const deploymentId = requireString(args, "deploymentId");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/deployments/${encodePathSegment(deploymentId)}`,
          },
          ctx,
        );
        return { deleted: true, deploymentId };
      },
    },
    {
      name: "list_pages_domains",
      description: "List custom domains attached to a Pages project and their validation status.",
      annotations: readOnly,
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName"],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema("domains", OPEN_OBJECT_OUTPUT_SCHEMA),
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "GET",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/domains`,
          },
          ctx,
        );
        return { domains: asArray(result).map(projectPagesDomain) };
      },
    },
    {
      name: "add_pages_domain",
      description: "Attach a custom domain to a Pages project. DNS ownership and validation still apply.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
          domain: { type: "string", minLength: 1, description: "Fully qualified custom domain to attach." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName", "domain"],
        additionalProperties: false,
      },
      outputSchema: OPEN_OBJECT_OUTPUT_SCHEMA,
      handler: async (args: JsonRecord, ctx) => {
        const { result } = await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/domains`,
            body: { name: requireString(args, "domain") },
          },
          ctx,
        );
        return projectPagesDomain(result);
      },
    },
    {
      name: "delete_pages_domain",
      description: "Detach a custom domain from a Pages project.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
          domain: { type: "string", minLength: 1, description: "Custom domain to detach." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName", "domain"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { deleted: { type: "boolean" }, domain: { type: "string" } }, required: ["deleted", "domain"] },
      handler: async (args: JsonRecord, ctx) => {
        const domain = requireString(args, "domain");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/domains/${encodePathSegment(domain)}`,
          },
          ctx,
        );
        return { deleted: true, domain };
      },
    },
    {
      name: "purge_pages_build_cache",
      description: "Clear a Pages project's build cache so its next deployment rebuilds dependencies and artifacts from scratch.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { purged: { type: "boolean" } }, required: ["purged"] },
      handler: async (args: JsonRecord, ctx) => {
        await callCloudflare(
          send,
          {
            method: "POST",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(requireString(args, "projectName"))}/purge_build_cache`,
          },
          ctx,
        );
        return { purged: true };
      },
    },
    {
      name: "delete_pages_project",
      description: "Permanently delete a Pages project, its deployments, and project configuration.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          accountId: scopeProperty("accountId", scope.accountId),
          projectName: { type: "string", minLength: 1, description: "Pages project name to delete." },
        },
        required: [...scopeRequired("accountId", scope.accountId), "projectName"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { deleted: { type: "boolean" }, projectName: { type: "string" } }, required: ["deleted", "projectName"] },
      handler: async (args: JsonRecord, ctx) => {
        const projectName = requireString(args, "projectName");
        await callCloudflare(
          send,
          {
            method: "DELETE",
            path: `/accounts/${encodePathSegment(accountArg(args))}/pages/projects/${encodePathSegment(projectName)}`,
          },
          ctx,
        );
        return { deleted: true, projectName };
      },
    },
    {
      // Additive: brings a record into being and destroys nothing, so
      // `destructiveHint` stays unset. `readOnlyHint: false` already routes it
      // through call_destructive_tool.
      name: "create_dns_record",
      description:
        "Create a content-based DNS record in a zone; the type enum lists the creatable types. Check list_dns_records first — Cloudflare rejects a duplicate rather than replacing it. Structured types like SRV and CAA are readable but not creatable.",
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
          send,
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
          proxied: {
            type: "boolean",
            description:
              "Route through Cloudflare's proxy. Only A, AAAA, and CNAME records are proxiable, and a proxied record must use ttl 1.",
          },
          priority: {
            type: "integer",
            minimum: 0,
            maximum: 65535,
            description: "Mail-server preference. MX records only.",
          },
          comment: {
            type: "string",
            description:
              "Operator-facing note stored with the record. Replaces the existing note.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Custom tags, available on paid plans. Replaces the existing tag set rather than adding to it.",
          },
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
          send,
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
          send,
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
          send,
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
  return tools.map((tool) => ({
    ...tool,
    handler: (args, ctx) =>
      tool.handler(args, withAuthentication(ctx, authentication)),
  }));
}

function usageGuide(
  purpose: string,
  scope: Scoping,
  instructions: string | undefined,
  authentication: CloudflareAuthentication,
): string {
  const accountInstructions = instructions?.trim();
  const zoneLine = scope.zoneId
    ? `This connector defaults to zone \`${scope.zoneId}\`; omit \`zoneId\` unless the request names a different domain.`
    : "This connector declares no default zone. Start with `list_zones` (filter by `name`) and carry the returned `id` into every zone-scoped call.";
  const accountLine = scope.accountId
    ? `It defaults to account \`${scope.accountId}\`; omit \`accountId\` unless the request names a different account.`
    : "It declares no default account. `list_accounts` supplies the `accountId` the Workers, KV, R2, and Pages tools need.";
  const authenticationLine =
    authentication === "apiToken"
      ? "The API token is operator-managed and scoped by permission. An `auth_required` failure means the token is missing, invalid, or lacks that call's permission. Call `verify_api_token` first."
      : "The Global API Key and account email are operator-managed. The key has the same access as its Cloudflare user. An `auth_required` failure means one field is missing, the pair is invalid, or the user lacks access. Call `verify_global_api_key` first.";
  return `# Cloudflare usage

Account purpose: ${purpose}

- ${zoneLine}
- ${accountLine}
- Prefer a named tool: its schema is complete, projected, and enough to call it without provider documentation. For an operation without a named tool, use \`cloudflare_api_get\` for GET, \`cloudflare_api_mutate\` for JSON POST/PUT/PATCH/DELETE, or \`cloudflare_api_upload\` for raw and multipart content. Raw tools take a path below \`/client/v4\`; their argument schemas are complete, but endpoint-specific query, header, and body fields come from Cloudflare's API reference. Use \`headers\` for endpoint-specific controls such as \`cf-r2-jurisdiction\`, \`Range\`, \`If-None-Match\`, and Cloudflare product metadata. \`Authorization\`, \`Cookie\`, \`Host\`, \`Content-Length\`, \`Content-Type\`, and \`Transfer-Encoding\` are connector-owned and refused: authentication, host, content type, and request framing are not the caller's to set.
- The raw tools cover the wider control plane without weakening routing: GET is explicitly read-only; every mutation and upload is destructive and must cross the host's approval boundary. The configured Cloudflare credential remains the hard provider-side permission boundary. Absolute URLs, traversal, and query strings embedded in \`path\` are refused locally.
- Useful raw paths include \`/accounts/{accountId}/images/v1\` (Images), \`/accounts/{accountId}/stream\` (Stream), \`/zones/{zoneId}/email/routing/rules\` (Email Routing), \`/accounts/{accountId}/d1/database\` (D1), and \`/accounts/{accountId}/queues\` (Queues). On GET, use \`responseType: "text"\` or \`"base64"\` for non-JSON content. Direct-upload endpoints can issue upload URLs; \`cloudflare_api_upload\` can also send explicit text, base64 bytes, or multipart fields/files.
- Three areas are deliberately unnamed. Read a bucket's CORS policy with \`get_r2_cors\`, then change it with \`cloudflare_api_mutate\` — \`PUT\` or \`DELETE /accounts/{accountId}/r2/buckets/{bucketName}/cors\`, rule fields per Cloudflare's reference — and read account storage totals with \`cloudflare_api_get\` at \`/accounts/{accountId}/r2/metrics\`. Zone settings are read one at a time with \`get_zone_setting\`: Cloudflare deprecated the bulk \`/zones/{zoneId}/settings\` read and published no replacement for it, so reach for the whole set through \`cloudflare_api_get\` only when one setting genuinely will not do.
- Lists paginate with \`page\` and \`perPage\` and return a \`page\` object; request the next page only when \`page.hasMore\` is true. \`list_zone_rulesets\`, \`list_r2_buckets\`, \`list_r2_objects\`, and \`list_kv_keys\` page by cursor instead: pass \`cursor\`, continue while \`nextCursor\` is present, and expect no \`page\` object. Their schemas say so too. \`list_worker_scripts\` is unpaginated.
- Results are projected to the fields that identify and describe a resource. Pass \`raw: true\` on a read when you genuinely need a field the projection drops.
- ${authenticationLine}
- A \`rate_limited\` failure carries the wait window. Cloudflare's limit is 1,200 requests per five minutes per user, counted across the dashboard and every token, so do not fan out speculatively; filter server-side with \`name\`, \`type\`, and \`content\` instead of listing everything and filtering locally.
- Named creates that only add a resource are write-routed without claiming destruction. Updates, overwrites, deletes, rollbacks, cache purges, \`cloudflare_api_mutate\`, and \`cloudflare_api_upload\` are destructive. Read current state before changing it, and prefer a targeted \`purge_cache\` over \`everything\`.
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
  const authentication = options.authentication ?? "apiToken";
  if (authentication !== "apiToken" && authentication !== "globalApiKey") {
    throw new Error(
      'cloudflare() authentication must be "apiToken" or "globalApiKey".',
    );
  }
  const scope: Scoping = {
    send: cloudflareTransport(options.baseUrl?.trim() || CLOUDFLARE_API_BASE),
    accountId: options.accountId?.trim() || undefined,
    zoneId: options.zoneId?.trim() || undefined,
  };
  return api(id, {
    title: options.title ?? "Cloudflare",
    description: `Cloudflare control-plane access for zones, DNS, Workers, KV, R2, Pages, media, email, and other v4 APIs — ${purpose}`,
    credential: credentialConfig(authentication, options.credential),
    callAdmission: admissionPolicy(maxConcurrency),
    usageGuide: {
      content: usageGuide(purpose, scope, options.instructions, authentication),
      // Explicit rather than derived: the first content line is the zone
      // scoping rule, which varies per deployment and reads as an instruction
      // rather than as the routing fact a browsing agent needs.
      summary:
        "Zone and account scoping, named-vs-raw routing, two pagination shapes, and lean-vs-raw results.",
      // Deliberately not `required`. Every named tool's schema is complete
      // enough to call it correctly on its own, and the scoping convention the
      // guide carries is repeated on each `zoneId` and `accountId` property —
      // so forcing the guide into context before every operation would spend
      // tokens on a sequence the schemas already express.
    },
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
    tools: buildTools(scope, authentication),
    ...(authentication === "apiToken"
      ? {
          async testCredential(value: string, ctx: ConnectorContext) {
            try {
              const { result } = await callCloudflare(
                scope.send,
                { method: "GET", path: "/user/tokens/verify" },
                withAuthentication(
                  {
                    ...ctx,
                    credential: {
                      get: async () => value,
                      getAll: async () => ({ value }),
                    },
                  },
                  authentication,
                ),
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
        }
      : {
          async testCredentials(
            values: Record<string, string>,
            ctx: ConnectorContext,
          ) {
            try {
              const { result } = await callCloudflare(
                scope.send,
                { method: "GET", path: "/user" },
                withAuthentication(
                  {
                    ...ctx,
                    credential: {
                      get: async (field?: string) =>
                        field ? values[field] ?? null : null,
                      getAll: async () => values,
                    },
                  },
                  authentication,
                ),
              );
              const email = asRecord(result)["email"];
              return {
                ok: true,
                message: `Global API Key verified for ${String(email)}.`,
              };
            } catch (error) {
              return {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          },
        }),
  });
}
