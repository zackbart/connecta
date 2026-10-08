import { skill } from "./skill.generated.js";
/**
 * No official `cloudflare` SDK on purpose. What the SDK sells — typed request
 * wrappers and pagination helpers — is what this connection replaces: an agent
 * gets a projected result and a `page.hasMore` boolean, so the SDK's types
 * would be re-projected away at the boundary, and the dependency would cost an
 * optional peer, an install step, and an import that never belongs in the root
 * graph. Cloudflare's v4 API is authenticated `fetch` over a uniform
 * `{ success, errors, messages, result, result_info }` envelope, so Web APIs
 * alone keep this provider Workers-clean. `test/package-surface.node.test.ts` pins
 * it: no `cloudflare` package in any dependency field, every import relative.
 */
import { apiConnector as api, type ApiTool } from "../../connectors/api-connector.js";
import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../../connectors/remote-mcp.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type {
  Connector,
  ToolClassification,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  JsonSchema,
} from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { CREDENTIAL, PROVIDER_COMMON, REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { defineProvider, type ProviderContext } from "../../provider.js";

/** Cloudflare's v4 REST base. Override only for a proxy or a test double. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
/** Cloudflare's official whole-API hosted MCP endpoint. */
export const CLOUDFLARE_MCP_ENDPOINT = "https://mcp.cloudflare.com/mcp";

/** Authentication schemes accepted by Cloudflare's v4 API. */
export type CloudflareAuthentication = "apiToken" | "globalApiKey";

/**
 * The 21 record types Cloudflare accepts. Eight carry a single `content`
 * string; the other thirteen carry a per-type structured `data` object.
 * `list_dns_records` filters on all 21 because reading them costs nothing.
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
 * Content-valued types only, and the only types `create_dns_record` and
 * `update_dns_record` accept. Covering the thirteen structured-`data` types
 * would mean either a free-form `data` passthrough — the untyped body this
 * connection exists to avoid — or thirteen more hand-written schemas for record
 * types that are rare in day-to-day zone administration. They stay fully
 * readable; writing one goes through the approval-gated raw mutation tool with
 * Cloudflare's documented per-type `data` body.
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

interface CloudflareCommonOptions {
  /** Human-readable display name; defaults identify the selected interface. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which account/estate this connection administers, and for whom. */
  purpose: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

export interface CloudflareApiOptions extends CloudflareCommonOptions {
  /** Select the REST complement explicitly; hosted MCP is the default. */
  surface: "api";
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
  /** Simultaneous downstream calls. Defaults to 6. */
  maxConcurrency?: number;
}

export interface CloudflareMcpOptions extends CloudflareCommonOptions {
  surface?: "mcp";
  /** OAuth by default, or a scoped API token for a headless deployment. */
  auth?: RemoteMcpAuth;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/** Backward-compatible API options; existing consumers may extend this interface. */
export interface CloudflareOptions extends CloudflareApiOptions {}

/** Select one Cloudflare interface when deployment configuration constructs it. */
export type CloudflareConnectionOptions =
  | CloudflareOptions
  | CloudflareMcpOptions;

/**
 * Cloudflare documents a global limit of 1,200 requests per five minutes per
 * user, counted cumulatively across the dashboard, API keys, and API tokens
 * (developers.cloudflare.com/fundamentals/api/reference/limits/). The matching
 * rolling window here is a best-effort approximation, not an enforcement: each
 * runtime keeps its own counter, so N isolates or processes can each admit
 * 1,200, and a human's dashboard traffic counts for Cloudflare but not for us.
 * `maxConcurrency` is the bound that actually protects a shared credential,
 * because one `execute_code` program can fan out faster than the window
 * notices.
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

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
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
 * error" but has also been observed reusing it as a generic validation code
 * ("domain_name is required", "Invalid pagination cursor"), so routing on it
 * would risk telling an agent its token was broken when its arguments were.
 * Genuine 10000 auth failures arrive with 401 or 403 and are caught by status.
 *
 * Provenance worth knowing before editing this set: Cloudflare publishes no
 * official table mapping error codes to causes, so these six — and the 10000
 * observation above — come from community reports and probing rather than
 * documentation. They are well-supported readings Cloudflare could invalidate
 * without notice; prefer `verify_api_token` or `verify_global_api_key` when a
 * diagnosis actually matters.
 *
 * Cloudflare also rate-limits authentication failures separately from the
 * global limit: a few requests with a bad token return 429 with code 10502.
 * That is one more reason to diagnose a broken token once with a verify tool
 * rather than by retrying real calls.
 */
const AUTH_ERROR_CODES = new Set([1001, 6003, 6111, 9103, 9106, 9107]);

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
  // 429 is checked before the authentication codes on purpose: Cloudflare
  // reuses the generic 10000 code on throttled responses, and reading a rate
  // limit as an auth failure would tell an agent to stop when it should wait.
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
  if (status === 401 || authCoded) {
    return new ConnectorCallError(
      "auth_required",
      `Cloudflare rejected the configured credential (HTTP ${status}). ${detail} Check that it is valid and has permission to access this resource.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `Cloudflare refused access to this resource (HTTP 403). ${detail} Verify the configured credential first; if valid, ask the account administrator to grant the required resource permission and token scope.`,
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new ConnectorCallError(
      "invalid_args",
      `Cloudflare rejected the request (HTTP ${status}). ${detail}`,
    );
  }
  // Cloudflare refuses a token that may not touch a resource with 401 or 403,
  // so a 404 here is a real absence rather than a permission gap wearing a
  // miss — the unambiguous case `not_found` exists for, and something an agent
  // can act on by re-running discovery for the id.
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

async function readAuthenticationHeaders(
  ctx: ConnectorContext,
  authentication: CloudflareAuthentication,
): Promise<Record<string, string>> {
  if (authentication === "globalApiKey") {
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
function cloudflareTransport(
  baseUrl: string,
  authentication: CloudflareAuthentication,
): GuardedTransport {
  return guardedFetch({
    provider: "Cloudflare",
    baseUrl,
    headers: { Accept: "application/json" },
    maxResponseBytes: CLOUDFLARE_MAX_RESPONSE_BYTES,
    authenticate: (ctx) => readAuthenticationHeaders(ctx, authentication),
  });
}

async function callCloudflare(
  send: GuardedTransport,
  spec: GuardedRequest,
  ctx: ConnectorContext,
): Promise<CloudflareResponse> {
  return await send(spec, ctx, async (response) => {
    const parsed = await response.jsonResult();
    const envelope =
      "value" in parsed
        ? (parsed.value as CloudflareEnvelope | undefined)
        : undefined;
    if (envelope === undefined) {
      // A gateway error page or an empty body, not an envelope: the status is
      // the only real signal left.
      // No cause: the parser's error quotes the body it could not read.
      throw response.ok
        ? new ConnectorCallError(
            "unavailable",
            "Cloudflare returned a non-JSON body for a successful status.",
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

async function testCloudflareCredential(
  send: GuardedTransport,
  spec: GuardedRequest,
  ctx: ConnectorContext,
  success: (result: unknown) => { ok: boolean; message: string },
): Promise<{ ok: boolean; message: string }> {
  try {
    const { result } = await callCloudflare(send, spec, ctx);
    return success(result);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
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
      let envelope: CloudflareEnvelope | undefined;
      try {
        const parsed = await response.jsonResult();
        envelope =
          "value" in parsed
            ? (parsed.value as CloudflareEnvelope | undefined)
            : undefined;
      } catch {
        // Content reads classify an already-failed status even when its error
        // body exceeds the transport ceiling.
      }
      const errors =
        envelope && Array.isArray(envelope.errors) ? envelope.errors : [];
      throw failureFor(response.status, response.headers, errors);
    }
    const common = compact({
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      etag: response.headers.get("etag") ?? undefined,
    });
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
  return compact({
    page,
    perPage: typeof info.per_page === "number" ? info.per_page : 0,
    count: typeof info.count === "number" ? info.count : 0,
    totalCount: typeof info.total_count === "number" ? info.total_count : undefined,
    totalPages,
    hasMore: totalPages !== undefined ? page < totalPages : false,
  }) as unknown as PageInfo;
}

function pagedList(
  key: string,
  project: (value: unknown) => unknown,
): (
  result: unknown,
  resultInfo: CloudflareResultInfo | undefined,
  raw: boolean,
) => JsonRecord {
  return (result, resultInfo, raw) => ({
    [key]: raw ? result : asArray(result).map(project),
    page: pageInfo(resultInfo),
  });
}

function cursorResult(cursor: unknown): { nextCursor?: string } {
  return typeof cursor === "string" && cursor !== ""
    ? { nextCursor: cursor }
    : {};
}

function projectAccount(value: unknown): JsonRecord {
  const account = asRecord(value);
  return compact({
    id: account["id"],
    name: account["name"],
    type: account["type"],
    createdOn: account["created_on"],
  });
}

function projectZone(value: unknown): JsonRecord {
  const zone = asRecord(value);
  const account = asRecord(zone["account"]);
  const plan = asRecord(zone["plan"]);
  const nameServers = Array.isArray(zone["name_servers"])
    ? zone["name_servers"]
    : undefined;
  return compact({
    id: zone["id"],
    name: zone["name"],
    status: zone["status"],
    paused: zone["paused"],
    type: zone["type"],
    accountId: account["id"],
    accountName: account["name"],
    plan: plan["name"],
    nameServers,
    createdOn: zone["created_on"],
    modifiedOn: zone["modified_on"],
  });
}

function projectZoneSetting(value: unknown): JsonRecord {
  const setting = asRecord(value);
  return compact({
    id: setting["id"],
    value: setting["value"],
    editable: setting["editable"],
    modifiedOn: setting["modified_on"],
  });
}

function projectDnsRecord(value: unknown): JsonRecord {
  const record = asRecord(value);
  const comment = record["comment"] ? record["comment"] : undefined;
  const tags = Array.isArray(record["tags"]) && record["tags"].length > 0
    ? record["tags"]
    : undefined;
  return compact({
    id: record["id"],
    name: record["name"],
    type: record["type"],
    content: record["content"],
    ttl: record["ttl"],
    proxied: record["proxied"],
    priority: record["priority"],
    comment,
    tags,
    createdOn: record["created_on"],
    modifiedOn: record["modified_on"],
  });
}

function projectWorkerScript(value: unknown): JsonRecord {
  const script = asRecord(value);
  return compact({
    id: script["id"],
    createdOn: script["created_on"],
    modifiedOn: script["modified_on"],
    usageModel: script["usage_model"],
  });
}

function projectWorkerSettings(value: unknown): JsonRecord {
  const settings = asRecord(value);
  return compact({
    compatibilityDate: settings["compatibility_date"],
    compatibilityFlags: settings["compatibility_flags"],
    bindings: settings["bindings"],
    limits: settings["limits"],
    observability: settings["observability"],
    placement: settings["placement"],
    usageModel: settings["usage_model"],
    tailConsumers: settings["tail_consumers"],
    logpush: settings["logpush"],
  });
}

function projectKvNamespace(value: unknown): JsonRecord {
  const namespace = asRecord(value);
  return compact({
    id: namespace["id"],
    title: namespace["title"],
    supportsUrlEncoding: namespace["supports_url_encoding"],
    jurisdiction: namespace["jurisdiction"],
  });
}

function projectKvBulkValues(value: unknown): JsonRecord {
  const result = asRecord(value);
  return compact({ values: result["values"] });
}

function projectR2Bucket(value: unknown): JsonRecord {
  const bucket = asRecord(value);
  return compact({
    name: bucket["name"],
    location: bucket["location"],
    storageClass: bucket["storage_class"],
    jurisdiction: bucket["jurisdiction"],
    creationDate: bucket["creation_date"],
  });
}

function projectR2Object(value: unknown): JsonRecord {
  const object = asRecord(value);
  return compact({
    key: object["key"],
    size: object["size"],
    etag: object["etag"],
    lastModified: object["last_modified"],
    storageClass: object["storage_class"],
    httpMetadata: object["http_metadata"],
    customMetadata: object["custom_metadata"],
  });
}

function projectR2Cors(value: unknown): JsonRecord {
  const cors = asRecord(value);
  return compact({ rules: cors["rules"] });
}

function projectKvKey(value: unknown): JsonRecord {
  const key = asRecord(value);
  return compact({
    name: key["name"],
    expiration: key["expiration"],
    metadata: key["metadata"],
  });
}

function projectWorkerDeployment(value: unknown): JsonRecord {
  const deployment = asRecord(value);
  return compact({
    id: deployment["id"],
    createdOn: deployment["created_on"],
    source: deployment["source"],
    strategy: deployment["strategy"],
    versions: deployment["versions"],
  });
}

function projectPagesDeployment(value: unknown): JsonRecord {
  const deployment = asRecord(value);
  return compact({
    id: deployment["id"],
    projectName: deployment["project_name"],
    environment: deployment["environment"],
    url: deployment["url"],
    aliases: deployment["aliases"],
    stage: deployment["stage"],
    latestStage: deployment["latest_stage"],
    createdOn: deployment["created_on"],
    modifiedOn: deployment["modified_on"],
  });
}

function projectPagesDomain(value: unknown): JsonRecord {
  const domain = asRecord(value);
  return compact({
    id: domain["id"],
    name: domain["name"],
    status: domain["status"],
    verificationData: domain["verification_data"],
    createdOn: domain["created_on"],
  });
}

function projectRuleset(value: unknown): JsonRecord {
  const ruleset = asRecord(value);
  return compact({
    id: ruleset["id"],
    name: ruleset["name"],
    kind: ruleset["kind"],
    phase: ruleset["phase"],
    description: ruleset["description"],
    version: ruleset["version"],
    lastUpdated: ruleset["last_updated"],
    rules: ruleset["rules"],
  });
}

function projectPagesProject(value: unknown): JsonRecord {
  const project = asRecord(value);
  const latest = asRecord(project["latest_deployment"]);
  const domains = Array.isArray(project["domains"])
    ? project["domains"]
    : undefined;
  const latestDeployment = latest["id"] === undefined
    ? undefined
    : compact({
        id: latest["id"],
        environment: latest["environment"],
        url: latest["url"],
        createdOn: latest["created_on"],
      });
  return compact({
    name: project["name"],
    subdomain: project["subdomain"],
    domains,
    productionBranch: project["production_branch"],
    createdOn: project["created_on"],
    latestDeployment,
  });
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
 * Local enforcement of a `perPage` range is only a favor when the bound is
 * really Cloudflare's, so `bounds` decides what the description admits to.
 * `list_accounts`/`list_zones` (5–50) and `list_kv_namespaces` (1–1000) are
 * Cloudflare's documented bounds. `list_dns_records` takes Cloudflare's
 * minimum but is `clamped` at 1,000: Cloudflare's schema documents `per_page`
 * on `/zones/{id}/dns_records` up to 5,000,000, a nominal ceiling no listing
 * will honor, and a local cap an agent is told about beats a page size that
 * fails somewhere inside Cloudflare. `list_pages_projects` is `undocumented` —
 * Cloudflare publishes no bounds and no default for it, so 1–100 is ours.
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
 * Four endpoints — `list_zone_rulesets`, `list_r2_buckets`, `list_r2_objects`,
 * `list_kv_keys` — page by cursor and get no `page` object. Both the argument
 * and the result say so, so the loop condition is legible from either end of
 * one tool rather than only to a reader who compared all of them.
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


function requireString(args: JsonRecord, key: string): string {
  const value = optionalString(args, key);
  if (value) return value;
  throw new ConnectorCallError("invalid_args", `${key} must not be blank.`);
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

function rawSpec(
  args: JsonRecord,
): Pick<GuardedRequest, "path" | "query" | "headers"> {
  return compact({
    path: cloudflareApiPath(args["path"]),
    query: queryFromArgs(args["query"]),
    headers: headersFromArgs(args["headers"]),
  }) as Pick<GuardedRequest, "path" | "query" | "headers">;
}

// The hosted helper accepts contentType/rawBody but no R2 jurisdiction header.
// Ordinary headers such as Accept are not a reason to restore JSON duplicates.
function needsMutationHeaders(spec: Pick<GuardedRequest, "path" | "headers">): boolean {
  return /^\/accounts\/[^/]+\/r2\/buckets\/[^/]+(?:\/|$)/.test(spec.path) &&
    Object.entries(spec.headers ?? {}).some(([name, value]) => name.toLowerCase() === "cf-r2-jurisdiction" && typeof value === "string" && value.trim().length > 0);
}

// Reviewed raw-body families, rather than a Content-Type assertion that could
// send an ordinary JSON DNS/configuration mutation through the upload tool.
function isUploadEndpoint(path: string): boolean {
  return /^\/accounts\/[^/]+\/(?:workers\/scripts\/[^/]+|storage\/kv\/namespaces\/[^/]+\/values\/.+|r2\/buckets\/[^/]+\/objects\/.+|images\/v1|stream(?:\/.*)?|pages\/assets\/upload|pages\/projects\/[^/]+\/deployments)\/?$/.test(path);
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

const ZONE_SETTING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    value: {
      type: ["string", "number", "boolean", "array", "object", "null"],
      items: {},
      additionalProperties: true,
    },
    editable: { type: "boolean" },
    modifiedOn: { type: "string" },
  },
  required: ["id", "value"],
};

const RULESET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    kind: { type: "string" },
    phase: { type: "string" },
    description: { type: "string" },
    version: { type: "string" },
    lastUpdated: { type: "string" },
    rules: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["id", "name"],
};

const WORKER_SETTINGS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    compatibilityDate: { type: "string" },
    compatibilityFlags: { type: "array", items: { type: "string" } },
    bindings: { type: "array", items: { type: "object", additionalProperties: true } },
    limits: { type: "object", additionalProperties: true },
    observability: { type: "object", additionalProperties: true },
    placement: { type: "object", additionalProperties: true },
    usageModel: { type: "string" },
    tailConsumers: { type: "array", items: { type: "object", additionalProperties: true } },
    logpush: { type: "boolean" },
  },
};

const WORKER_DEPLOYMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    createdOn: { type: "string" },
    source: { type: "string" },
    strategy: { type: "string" },
    versions: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  required: ["id"],
};

const KV_NAMESPACE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    supportsUrlEncoding: { type: "boolean" },
    jurisdiction: { type: "string", enum: ["eu", "fedramp", "us"] },
    renamed: { type: "boolean" },
    namespaceId: { type: "string" },
  },
};

const KV_BULK_VALUES_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    values: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["values"],
};

const R2_CORS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["rules"],
};

const PAGES_DEPLOYMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    projectName: { type: "string" },
    environment: { type: "string" },
    url: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    stage: { type: "object", additionalProperties: true },
    latestStage: { type: "object", additionalProperties: true },
    createdOn: { type: "string" },
    modifiedOn: { type: "string" },
  },
  required: ["id"],
};

const PAGES_DOMAIN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    verificationData: { type: "object", additionalProperties: true },
    createdOn: { type: "string" },
  },
  required: ["name"],
};

const PAGES_PROJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    subdomain: { type: "string" },
    domains: { type: "array", items: { type: "string" } },
    productionBranch: { type: "string" },
    createdOn: { type: "string" },
    latestDeployment: PAGES_DEPLOYMENT_SCHEMA,
  },
  required: ["name"],
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

// Connector-owned and refused: Authorization, Cookie, Host, Content-Length,
// Content-Type, Transfer-Encoding — authentication, host selection, content
// type, and request framing are not the caller's to set. That list stays out of
// this description on purpose: the compact renderer inlines a shared property
// description once per tool, and spelling the six out three times pushed
// cloudflare_api_upload's compact input past the 1,024-byte discovery budget.
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
  enum: ["default", "eu", "us", "fedramp"],
  description:
    "Bucket jurisdiction. Omit for ordinary buckets; set eu, us, or fedramp for jurisdictional buckets.",
};

const R2_BUCKET_NAME_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 3,
  maxLength: 64,
  description: "R2 bucket name.",
};

const SCRIPT_NAME_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Worker script name from list_worker_scripts.",
};

const NAMESPACE_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "KV namespace id from list_kv_namespaces.",
};

const PROJECT_NAME_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Pages project name from list_pages_projects.",
};

const PAGES_PROJECT_NAME_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Pages project name.",
};

const DEPLOYMENT_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Deployment id from list_pages_deployments.",
};

const WORKER_DEPLOYMENT_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Deployment id from list_worker_deployments.",
};

const SETTING_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "Cloudflare zone setting id, such as ssl, brotli, webmcp_enabled, or webmcp_packs.",
};

const RECORD_ID_PROPERTY: JsonSchema = {
  type: "string",
  description: "DNS record id, from list_dns_records.",
};

const R2_BUCKET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    location: { type: "string" },
    storageClass: { type: "string" },
    jurisdiction: { type: "string", enum: ["default", "eu", "us", "fedramp"] },
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

function cfTool(
  name: string,
  description: string,
  annotations: ApiTool["annotations"],
  scopeKind: "zoneId" | "accountId" | undefined,
  scopeFallback: string | undefined,
  properties: Record<string, JsonSchema>,
  required: string[],
  outputSchema: JsonSchema,
  handler: ApiTool["handler"],
): ApiTool {
  return {
    name,
    description,
    annotations,
    inputSchema: {
      type: "object",
      properties: scopeKind
        ? {
            [scopeKind]: scopeProperty(scopeKind, scopeFallback),
            ...properties,
          }
        : properties,
      required: scopeKind
        ? [...scopeRequired(scopeKind, scopeFallback), ...required]
        : required,
      additionalProperties: false,
    },
    outputSchema,
    handler,
  };
}

function getResult(
  send: GuardedTransport,
  request: (args: JsonRecord) => GuardedRequest,
  project: (result: unknown, args: JsonRecord) => unknown = (result) => result,
): ApiTool["handler"] {
  return async (args, ctx) => {
    const { result } = await callCloudflare(send, request(args), ctx);
    return project(result, args);
  };
}

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
      ? cfTool(
          "verify_api_token",
          "Verify the configured Cloudflare API token and report its status. Use this first when any other tool fails with an authentication error, to separate a bad token from a missing permission.",
          readOnly,
          undefined,
          undefined,
          {},
          [],
          {
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
          async (_args, ctx) => {
                      const { result } = await callCloudflare(
                        send,
                        { method: "GET", path: "/user/tokens/verify" },
                        ctx,
                      );
                      const token = asRecord(result);
                      return compact({
                        id: token["id"],
                        status: token["status"],
                        notBefore: token["not_before"],
                        expiresOn: token["expires_on"],
                      });
                    },
        )
      : cfTool(
          "verify_global_api_key",
          "Verify the configured Cloudflare Global API Key and account email by retrieving the authenticated user. Use this first when another tool fails with an authentication error.",
          readOnly,
          undefined,
          undefined,
          {},
          [],
          {
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
          async (_args, ctx) => {
                      const { result } = await callCloudflare(
                        send,
                        { method: "GET", path: "/user" },
                        ctx,
                      );
                      const user = asRecord(result);
                      return { id: user["id"], email: user["email"], status: "active" };
                    },
        ),
    cfTool(
      "cloudflare_api_get",
      "Call any GET endpoint under Cloudflare's v4 API with this connector's credential. Prefer a named tool when one exists; this read-only hatch covers the products the named surface does not reach, such as Images, Stream, D1, and Queues.",
      readOnly,
      undefined,
      undefined,
      {
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
                }
            },
      ["path"],
      {
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
      async (args: JsonRecord, ctx) => {
              const raw = rawSpec(args);
              const responseType = optionalString(args, "responseType") ?? "json";
              const spec = compact({
                method: "GET",
                ...raw,
              }) as unknown as GuardedRequest;
              if (responseType === "text" || responseType === "base64") {
                return await callCloudflareContent(send, spec, ctx, responseType);
              }
              const { result, resultInfo } = await callCloudflare(
                send,
                spec,
                ctx,
              );
              return compact({
                result,
                resultInfo,
              });
            },
    ),
    cfTool(
      "cloudflare_api_mutate",
      "Call JSON mutations using an explicit Global API Key identity, or R2 bucket endpoints requiring cf-r2-jurisdiction. API-token ordinary JSON mutations belong to hosted MCP execute. No multipart or binary uploads.",
      { readOnlyHint: false, destructiveHint: true },
      undefined,
      undefined,
      {
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
                }
            },
      ["method", "path"],
      {
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
      async (args: JsonRecord, ctx) => {
              const method = String(args["method"]) as GuardedRequest["method"];
              const spec = rawSpec(args);
              if (authentication === "apiToken" && !needsMutationHeaders(spec)) {
                throw new ConnectorCallError("invalid_args", "Use the Cloudflare MCP execute tool for JSON mutations with an API token. This REST tool is reserved for Global API Key identity or R2 bucket operations requiring cf-r2-jurisdiction.");
              }
              const { result, resultInfo } = await callCloudflare(
                send,
                compact({
                  method,
                  ...spec,
                  body: args["body"],
                }) as unknown as GuardedRequest,
                ctx,
              );
              return compact({
                result,
                resultInfo,
              });
            },
    ),
    cfTool(
      "cloudflare_api_upload",
      "Upload raw text, base64 bytes, or multipart form data to a Cloudflare v4 POST or PUT endpoint. Covers Worker modules, R2/KV objects, Images, Stream, and Pages upload endpoints. Reads no local files; content must be supplied explicitly.",
      { readOnlyHint: false, destructiveHint: true },
      undefined,
      undefined,
      {
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
                }
            },
      ["method", "path"],
      {
              type: "object",
              properties: {
                result: {
                  description: "Cloudflare's unprojected upload result.",
                },
              },
              required: ["result"],
            },
      async (args: JsonRecord, ctx) => {
              const spec = rawSpec(args);
              if (authentication === "apiToken" && !isUploadEndpoint(spec.path)) {
                throw new ConnectorCallError("invalid_args", "Use the Cloudflare MCP execute tool for this mutation. REST uploads are confined to Workers, KV values, R2 objects, Images, Stream and Pages upload endpoints.");
              }
              const upload = uploadBody(args);
              const { result } = await callCloudflare(
                send,
                compact({
                  method: String(args["method"]) as "POST" | "PUT",
                  ...spec,
                  headers:
                    spec.headers !== undefined || upload.headers !== undefined
                      ? { ...spec.headers, ...upload.headers }
                      : undefined,
                  rawBody: upload.rawBody,
                }) as unknown as GuardedRequest,
                ctx,
              );
              return { result };
            },
    ),
    cfTool(
      "list_accounts",
      "List Cloudflare accounts this token can see. Supplies the accountId that the Workers, KV, R2, and Pages tools need.",
      readOnly,
      undefined,
      undefined,
      {
              name: {
                  type: "string",
                  description: "Filter by exact account name.",
                },
                ...pagingInputProperties(5, 50, { defaultPerPage: 20 }),
                raw: RAW_INPUT_PROPERTY
            },
      [],
      listOutputSchema("accounts", ACCOUNT_SCHEMA),
      async (args: JsonRecord, ctx) => {
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
              return pagedList("accounts", projectAccount)(result, resultInfo, args["raw"] === true);
            },
    ),
    cfTool(
      "list_zones",
      "List zones (domains) this token can see, with their ids and status. This is the zoneId discovery step for every DNS and cache tool.",
      readOnly,
      undefined,
      undefined,
      {
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
                raw: RAW_INPUT_PROPERTY
            },
      [],
      listOutputSchema("zones", ZONE_SCHEMA),
      async (args: JsonRecord, ctx) => {
              const { result, resultInfo } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: "/zones",
                  query: {
                    name: optionalString(args, "name"),
                    // Undefaulted on purpose: list_zones is the discovery step,
                    // and quietly filtering it by a configured accountId would
                    // be a restriction in all but name — one with no argument
                    // that escapes it, since an empty accountId would fall back
                    // to the default again.
                    "account.id": optionalString(args, "accountId"),
                    status: optionalString(args, "status"),
                    page: optionalNumber(args, "page"),
                    per_page: optionalNumber(args, "perPage"),
                  },
                },
                ctx,
              );
              return pagedList("zones", projectZone)(result, resultInfo, args["raw"] === true);
            },
    ),
    cfTool(
      "get_zone",
      "Fetch one zone's settings summary by id: status, plan, name servers, and owning account.",
      readOnly,
      "zoneId",
      scope.zoneId,
      {
              raw: RAW_INPUT_PROPERTY
            },
      [],
      ZONE_SCHEMA,
      getResult(
        send,
        (args) => ({ method: "GET", path: `/zones/${encodeURIComponent(zoneArg(args))}` }),
        (result, args) => args["raw"] === true ? result : projectZone(result),
      ),
    ),
    // No bulk `list_zone_settings` on purpose (#361): Cloudflare's published
    // document marks GET /zones/{zoneId}/settings and its PATCH sibling
    // deprecated with no bulk replacement, and the tool projected nothing while
    // *growing* the payload 22.7% by wrapping an unpaginated settings array in a
    // page object. Read one setting here; an operator who genuinely wants the
    // whole set names /zones/{zoneId}/settings through cloudflare_api_get, at
    // the caller's risk rather than promised by connecta's catalog.
    cfTool(
      "get_zone_setting",
      "Get one zone setting by its Cloudflare setting id, such as ssl, always_use_https, min_tls_version, brotli, or development_mode.",
      readOnly,
      "zoneId",
      scope.zoneId,
      {
              settingId: SETTING_ID_PROPERTY,
                raw: RAW_INPUT_PROPERTY
            },
      ["settingId"],
      ZONE_SETTING_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/zones/${encodeURIComponent(zoneArg(args))}/settings/${encodeURIComponent(requireString(args, "settingId"))}`,
                }),
        (result, args) => args["raw"] === true ? result : projectZoneSetting(result),
      ),
    ),
    cfTool(
      "list_zone_rulesets",
      "List zone rulesets for WAF, redirects, transforms, cache rules, configuration rules, and other Ruleset Engine phases.",
      readOnly,
      "zoneId",
      scope.zoneId,
      {
              perPage: {
                  type: "integer",
                  minimum: 1,
                  maximum: 50,
                  description: "Rulesets per request, 1 to 50.",
                },
                cursor: CURSOR_INPUT_PROPERTY
            },
      [],
      {
              type: "object",
              properties: {
                rulesets: { type: "array", items: RULESET_SCHEMA },
                nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
              },
              required: ["rulesets"],
            },
      async (args: JsonRecord, ctx) => {
              const { result, resultInfo } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/zones/${encodeURIComponent(zoneArg(args))}/rulesets`,
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
                ...cursorResult(cursor),
              };
            },
    ),
    cfTool(
      "get_zone_ruleset",
      "Get one zone ruleset including its ordered rules, expressions, actions, parameters, and enabled state.",
      readOnly,
      "zoneId",
      scope.zoneId,
      {
              rulesetId: {
                  type: "string",
                  minLength: 1,
                  description: "Ruleset id from list_zone_rulesets.",
                }
            },
      ["rulesetId"],
      RULESET_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/zones/${encodeURIComponent(zoneArg(args))}/rulesets/${encodeURIComponent(requireString(args, "rulesetId"))}`,
                }),
        projectRuleset,
      ),
    ),
    cfTool(
      "list_dns_records",
      "List DNS records in a zone, filtered by name, type, or content. Returns record ids, which update_dns_record and delete_dns_record require.",
      readOnly,
      "zoneId",
      scope.zoneId,
      {
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
                raw: RAW_INPUT_PROPERTY
            },
      [],
      listOutputSchema("records", DNS_RECORD_SCHEMA),
      async (args: JsonRecord, ctx) => {
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
              return pagedList("records", projectDnsRecord)(result, resultInfo, args["raw"] === true);
            },
    ),
    cfTool(
      "get_dns_record",
      "Fetch one DNS record by its record id.",
      readOnly,
      "zoneId",
      scope.zoneId,
      {
              recordId: RECORD_ID_PROPERTY,
                raw: RAW_INPUT_PROPERTY
            },
      ["recordId"],
      DNS_RECORD_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/zones/${encodeURIComponent(zoneArg(args))}/dns_records/${encodeURIComponent(
                    String(args["recordId"]),
                  )}`,
                }),
        (result, args) => args["raw"] === true ? result : projectDnsRecord(result),
      ),
    ),
    cfTool(
      "list_worker_scripts",
      "List Workers scripts deployed in an account, with their last-modified times.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              raw: RAW_INPUT_PROPERTY
            },
      [],
      listOutputSchema("scripts", {
              type: "object",
              properties: {
                id: { type: "string", description: "Script name." },
                createdOn: { type: "string" },
                modifiedOn: { type: "string" },
                usageModel: { type: "string" },
              },
              required: ["id"],
            }),
      async (args: JsonRecord, ctx) => {
              const { result, resultInfo } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/workers/scripts`,
                },
                ctx,
              );
              return pagedList("scripts", projectWorkerScript)(result, resultInfo, args["raw"] === true);
            },
    ),
    cfTool(
      "get_worker_settings",
      "Get a Worker's compatibility date and flags, bindings, limits, observability, placement, usage model, and other script settings.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              scriptName: SCRIPT_NAME_PROPERTY,
                raw: RAW_INPUT_PROPERTY
            },
      ["scriptName"],
      WORKER_SETTINGS_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/workers/scripts/${encodeURIComponent(requireString(args, "scriptName"))}/settings`,
                }),
        (result, args) => args["raw"] === true ? result : projectWorkerSettings(result),
      ),
    ),
    cfTool(
      "list_worker_deployments",
      "List deployments of a Worker script, including version traffic allocations and deployment strategy.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              scriptName: SCRIPT_NAME_PROPERTY
            },
      ["scriptName"],
      listOutputSchema("deployments", WORKER_DEPLOYMENT_SCHEMA),
      async (args: JsonRecord, ctx) => {
              const { result } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/workers/scripts/${encodeURIComponent(requireString(args, "scriptName"))}/deployments`,
                },
                ctx,
              );
              const record = asRecord(result);
              const deployments = Array.isArray(result)
                ? result
                : asArray(record["deployments"]);
              return { deployments: deployments.map(projectWorkerDeployment) };
            },
    ),
    cfTool(
      "get_worker_deployment",
      "Get one Worker deployment and its version traffic allocations.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              scriptName: SCRIPT_NAME_PROPERTY,
                deploymentId: WORKER_DEPLOYMENT_ID_PROPERTY
            },
      ["scriptName", "deploymentId"],
      WORKER_DEPLOYMENT_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/workers/scripts/${encodeURIComponent(requireString(args, "scriptName"))}/deployments/${encodeURIComponent(requireString(args, "deploymentId"))}`,
                }),
        projectWorkerDeployment,
      ),
    ),
    cfTool(
      "list_kv_namespaces",
      "List Workers KV namespaces in an account, with the namespace ids bindings refer to.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              ...pagingInputProperties(1, 1000, { defaultPerPage: 20 }),
                raw: RAW_INPUT_PROPERTY
            },
      [],
      listOutputSchema("namespaces", {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                supportsUrlEncoding: { type: "boolean" },
                jurisdiction: { type: "string", enum: ["eu", "fedramp", "us"] },
              },
              required: ["id", "title"],
            }),
      async (args: JsonRecord, ctx) => {
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
              return pagedList("namespaces", projectKvNamespace)(result, resultInfo, args["raw"] === true);
            },
    ),
    cfTool(
      "get_kv_namespace",
      "Get one Workers KV namespace by id.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              namespaceId: NAMESPACE_ID_PROPERTY
            },
      ["namespaceId"],
      KV_NAMESPACE_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/storage/kv/namespaces/${encodeURIComponent(requireString(args, "namespaceId"))}`,
                }),
        projectKvNamespace,
      ),
    ),
    cfTool(
      "list_kv_keys",
      "List keys and metadata in a Workers KV namespace by prefix, using cursor pagination.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              namespaceId: NAMESPACE_ID_PROPERTY,
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
                cursor: CURSOR_INPUT_PROPERTY
            },
      ["namespaceId"],
      {
              type: "object",
              properties: {
                keys: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      expiration: { type: "number" },
                      metadata: {},
                    },
                    required: ["name"],
                  },
                },
                nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
              },
              required: ["keys"],
            },
      async (args: JsonRecord, ctx) => {
              const { result, resultInfo } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/storage/kv/namespaces/${encodeURIComponent(requireString(args, "namespaceId"))}/keys`,
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
                ...cursorResult(cursor),
              };
            },
    ),
    cfTool(
      "bulk_get_kv_values",
      "Read up to 100 Workers KV values in one request. This JSON endpoint is suitable for text and JSON values; use the raw API for specialized response types.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              namespaceId: NAMESPACE_ID_PROPERTY,
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
                }
            },
      ["namespaceId", "keys"],
      KV_BULK_VALUES_SCHEMA,
      async (args: JsonRecord, ctx) => {
              const { result } = await callCloudflare(
                send,
                {
                  method: "POST",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/storage/kv/namespaces/${encodeURIComponent(requireString(args, "namespaceId"))}/bulk/get`,
                  body: compact({
                    keys: args["keys"],
                    withMetadata: args["withMetadata"],
                    type: args["type"],
                  }),
                },
                ctx,
              );
              return projectKvBulkValues(result);
            },
    ),
    cfTool(
      "list_r2_buckets",
      "List R2 buckets in an account, with location and storage class.",
      readOnly,
      "accountId",
      scope.accountId,
      {
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
                raw: RAW_INPUT_PROPERTY
            },
      [],
      {
              type: "object",
              properties: {
                buckets: {
                  type: "array",
                  items: R2_BUCKET_SCHEMA,
                },
                nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
              },
              required: ["buckets"],
            },
      async (args: JsonRecord, ctx) => {
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
              const next = cursorResult(cursor);
              if (args["raw"] === true) return { buckets: result, ...next };
              return {
                buckets: asArray(asRecord(result)["buckets"]).map(projectR2Bucket),
                ...next,
              };
            },
    ),
    cfTool(
      "get_r2_bucket",
      "Get one R2 bucket's location, jurisdiction, storage class, and creation time.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              bucketName: R2_BUCKET_NAME_PROPERTY,
                jurisdiction: R2_JURISDICTION_PROPERTY
            },
      ["bucketName"],
      R2_BUCKET_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/r2/buckets/${encodeURIComponent(requireString(args, "bucketName"))}`,
                  headers: r2Headers(args),
                }),
        projectR2Bucket,
      ),
    ),
    cfTool(
      "list_r2_objects",
      "List object keys and metadata in an R2 bucket by prefix, with delimiter grouping and cursor pagination.",
      readOnly,
      "accountId",
      scope.accountId,
      {
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
                cursor: CURSOR_INPUT_PROPERTY
            },
      ["bucketName"],
      {
              type: "object",
              properties: {
                objects: { type: "array", items: R2_OBJECT_SCHEMA },
                commonPrefixes: { type: "array", items: { type: "string" } },
                nextCursor: NEXT_CURSOR_OUTPUT_PROPERTY,
                truncated: { type: "boolean" },
              },
              required: ["objects", "truncated"],
            },
      async (args: JsonRecord, ctx) => {
              const { result, resultInfo } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/r2/buckets/${encodeURIComponent(requireString(args, "bucketName"))}/objects`,
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
                ...cursorResult(cursor),
                truncated: resultInfo?.is_truncated === true,
              };
            },
    ),
    // No `get_r2_metrics`, `set_r2_cors`, or `delete_r2_cors` on purpose (#350).
    // A named tool is a permanent line item in every deployment's catalog, and
    // these lost the comparison against the escape hatches: `get_r2_metrics`
    // took an account id, put it in a path, and returned the response untouched,
    // which `cloudflare_api_get` at /accounts/{accountId}/r2/metrics already
    // does. `set_r2_cors` declared its rule list as free-form objects — the
    // untyped body refused everywhere else — and returned Cloudflare's response
    // unprojected, so it beat the raw route on nothing. `delete_r2_cors`
    // validated fine and went anyway, because naming only the delete would mean
    // one CORS policy is set through the raw route and cleared through a named
    // tool. Read with `get_r2_cors`; write with `cloudflare_api_mutate` at
    // PUT/DELETE /accounts/{accountId}/r2/buckets/{bucketName}/cors.
    cfTool(
      "get_r2_cors",
      "Get the browser CORS rules configured on an R2 bucket.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              bucketName: R2_BUCKET_NAME_PROPERTY,
                jurisdiction: R2_JURISDICTION_PROPERTY
            },
      ["bucketName"],
      R2_CORS_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/r2/buckets/${encodeURIComponent(requireString(args, "bucketName"))}/cors`,
                  headers: r2Headers(args),
                }),
        projectR2Cors,
      ),
    ),
    cfTool(
      "list_pages_projects",
      "List Cloudflare Pages projects in an account, with their production branch and latest deployment.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              ...pagingInputProperties(1, 100, { bounds: "undocumented" }),
                raw: RAW_INPUT_PROPERTY
            },
      [],
      listOutputSchema("projects", PAGES_PROJECT_SCHEMA),
      async (args: JsonRecord, ctx) => {
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
              return pagedList("projects", projectPagesProject)(result, resultInfo, args["raw"] === true);
            },
    ),
    cfTool(
      "get_pages_project",
      "Get one Pages project, including build configuration, deployment configuration, domains, and latest deployment.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              projectName: PROJECT_NAME_PROPERTY,
                raw: RAW_INPUT_PROPERTY
            },
      ["projectName"],
      PAGES_PROJECT_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/pages/projects/${encodeURIComponent(requireString(args, "projectName"))}`,
                }),
        (result, args) => args["raw"] === true ? result : projectPagesProject(result),
      ),
    ),
    cfTool(
      "list_pages_deployments",
      "List production and preview deployments for a Pages project.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              projectName: PROJECT_NAME_PROPERTY,
                env: {
                  type: "string",
                  enum: ["production", "preview"],
                  description: "Optional deployment environment filter.",
                },
                ...pagingInputProperties(1, 100, { bounds: "undocumented" })
            },
      ["projectName"],
      listOutputSchema("deployments", PAGES_DEPLOYMENT_SCHEMA),
      async (args: JsonRecord, ctx) => {
              const { result, resultInfo } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/pages/projects/${encodeURIComponent(requireString(args, "projectName"))}/deployments`,
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
    ),
    cfTool(
      "get_pages_deployment",
      "Get one Pages deployment including its environment, URLs, stages, source, and build configuration.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              projectName: PROJECT_NAME_PROPERTY,
                deploymentId: DEPLOYMENT_ID_PROPERTY,
                raw: RAW_INPUT_PROPERTY
            },
      ["projectName", "deploymentId"],
      PAGES_DEPLOYMENT_SCHEMA,
      getResult(
        send,
        (args) => ({
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/pages/projects/${encodeURIComponent(requireString(args, "projectName"))}/deployments/${encodeURIComponent(requireString(args, "deploymentId"))}`,
                }),
        (result, args) => args["raw"] === true ? result : projectPagesDeployment(result),
      ),
    ),
    cfTool(
      "list_pages_domains",
      "List custom domains attached to a Pages project and their validation status.",
      readOnly,
      "accountId",
      scope.accountId,
      {
              projectName: PAGES_PROJECT_NAME_PROPERTY
            },
      ["projectName"],
      listOutputSchema("domains", PAGES_DOMAIN_SCHEMA),
      async (args: JsonRecord, ctx) => {
              const { result } = await callCloudflare(
                send,
                {
                  method: "GET",
                  path: `/accounts/${encodeURIComponent(accountArg(args))}/pages/projects/${encodeURIComponent(requireString(args, "projectName"))}/domains`,
                },
                ctx,
              );
              return { domains: asArray(result).map(projectPagesDomain) };
            },
    ),
  ];
  return tools;
}

function apiUsageGuide(
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
      ? "The API token is operator-managed and scoped by permission. An `auth_required` failure means the token is missing or invalid. A `provider_permission_denied` failure asks an administrator to grant resource permission and token scope. Call `verify_api_token` first."
      : "The Global API Key and account email are operator-managed. The key has the same access as its Cloudflare user. An `auth_required` failure means one field is missing or the pair is invalid. A `provider_permission_denied` failure asks an administrator to grant the user access. Call `verify_global_api_key` first.";
  return `# Cloudflare usage

Account purpose: ${purpose}

- ${zoneLine}
- ${accountLine}${skill.fragments.guide_0}${authenticationLine}${skill.fragments.guide_1}${
    accountInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n`
      : ""
  }`;
}

/**
 * Reviewed in #705's provider audit against https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/.
 * Retains the release-reviewed inventory, including names absent from today's
 * public reference. Live annotations were not reverified without credentials.
 * No schema digest is asserted without a captured schema to review.
 */
const CLOUDFLARE_MCP_CLASSIFICATION: ToolClassification = {
  tools: {
    "search": {"verdict": "read", "reason": "Searches the Cloudflare OpenAPI contract without executing API methods."},
    "execute": {"verdict": "destructive", "reason": "Can mix HTTP methods across the Cloudflare API; no input schema proves a program only reads."},
  },
};

function mcpUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  return `# Cloudflare MCP usage

Official whole-API MCP interface: ${purpose}${skill.fragments.guide_2}${
    accountInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n`
      : ""
  }`;
}

function cloudflareMcp(
  id: string,
  purpose: string,
  options: CloudflareMcpOptions,
  provider: ProviderContext,
): Connector {
  const connector = remoteMcp(id, {
    url: CLOUDFLARE_MCP_ENDPOINT,
    ...provider.connectorOptions,
    title: options.title ?? "Cloudflare (MCP)",
    description: `Cloudflare's official whole-API MCP interface: ${purpose}`,
    auth: withCredentialDefaults(options.auth ?? { type: "oauth" }, {
      credential: {
        label: "Cloudflare API token",
        description:
          "A scoped Cloudflare API token. Connecta sends it as a bearer token to mcp.cloudflare.com and stores it encrypted.",
        placeholder: "Paste Cloudflare API token",
      },
    }),
    requireHttps: true,
    classify: provider.classify,
    usageGuide: {
      content: mcpUsageGuide(purpose, options.instructions),
      summary:
        "Official whole-API MCP. Search the OpenAPI document; execute programs always classify as writes.",
      required: true,
    },
  });
  return connector;
}

function cloudflareApi(
  id: string,
  purpose: string,
  options: CloudflareApiOptions,
): Connector {
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
    send: cloudflareTransport(
      options.baseUrl?.trim() || CLOUDFLARE_API_BASE,
      authentication,
    ),
    accountId: options.accountId?.trim() || undefined,
    zoneId: options.zoneId?.trim() || undefined,
  };
  return api(id, {
    ...(options.authScope ? { authScope: options.authScope } : {}),
    title: options.title ?? "Cloudflare",
    description: `Cloudflare control-plane access for zones, DNS, Workers, KV, R2, Pages, media, email, and other v4 APIs — ${purpose}`,
    credential: credentialConfig(authentication, options.credential),
    callAdmission: admissionPolicy(maxConcurrency),
    usageGuide: {
      content: apiUsageGuide(purpose, scope, options.instructions, authentication),
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
            return await testCloudflareCredential(
              scope.send,
              { method: "GET", path: "/user/tokens/verify" },
              {
                ...ctx,
                credential: {
                  get: async () => value,
                  getAll: async () => ({ value }),
                },
              },
              (result) => {
              const status = asRecord(result)["status"];
              return status === "active"
                ? { ok: true, message: "Token verified: active." }
                : { ok: false, message: `Token status is "${String(status)}".` };
              },
            );
          },
        }
      : {
          async testCredentials(
            values: Record<string, string>,
            ctx: ConnectorContext,
          ) {
            return await testCloudflareCredential(
              scope.send,
              { method: "GET", path: "/user" },
              {
                ...ctx,
                credential: {
                  get: async (field?: string) =>
                    field ? values[field] ?? null : null,
                  getAll: async () => values,
                },
              },
              (result) => ({
                ok: true,
                message: `Global API Key verified for ${String(asRecord(result)["email"])}.`,
              }),
            );
          },
        }),
  });
}


/** The closed options cloudflare() accepts; see `assertKnownOptions`. */
const CLOUDFLARE_OPTIONS = variants("surface", {
  api: optionsOf<CloudflareApiOptions>()({
    ...keys("title", "authScope", "purpose", "instructions", "maxResultBytes"),
    ...keys("surface", "accountId", "zoneId", "baseUrl", "authentication", "maxConcurrency"),
    credential: CREDENTIAL,
  }).shape,
  mcp: optionsOf<CloudflareMcpOptions>()({
    ...PROVIDER_COMMON,
    ...keys("surface"),
    auth: REMOTE_MCP_AUTH,
  }).shape,
}, "mcp");

/** A maintained Cloudflare connection using the selected provider interface. */
export const cloudflare = defineProvider<CloudflareConnectionOptions>({
  name: "cloudflare",
  title: "Cloudflare",
  kind: "composed",
  readme: "Cloudflare",
  bundle: {"baselineGzip":151186,"maxGzip":211186},
  skill,
  options: CLOUDFLARE_OPTIONS,
  classify: CLOUDFLARE_MCP_CLASSIFICATION,
  create: cloudflareConnector,
});

function cloudflareConnector(
  id: string,
  options: CloudflareConnectionOptions,
  provider: ProviderContext,
): Connector {
  const purpose = options.purpose.trim();
  return options.surface === "api"
    ? cloudflareApi(id, purpose, options)
    : cloudflareMcp(id, purpose, options, provider);
}

/** @deprecated Read `cloudflare.definition.classify` instead. Kept for existing imports. */
export const CLOUDFLARE_MCP_VETTED_CATALOG = reviewedCatalog(
  cloudflare.definition.classify!,
  'defineProvider("cloudflare")',
);
