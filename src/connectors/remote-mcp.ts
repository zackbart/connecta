import { wrapViewCredentials } from "../runtime/call.js";
import { sha256Hex, utf8Length } from "../bytes.js";
import { withStoredAuth } from "../auth/stored-observation.js";
import { authorizationParamsFor } from "../auth/oauth-authorization-params.js";
import { authView } from "../auth/native-call.js";
import { authFlow, authCall, authInvoke, authValue, authMethod, authCatch } from "../auth/native.js";
import { isOAuthCredentialRequest } from "../auth/oauth-token-response.js";
import { deriveContext } from "../derived-context.js";
import { operationContext, openRequest, viewServices, viewSignal } from "../runtime/call.js";
import {
  assertRemoteOAuthClient,
  declareSelfHostedClient,
  downstreamClientMetadata,
  downstreamRedirectUri,
  remoteClientAuthMethod,
  selfHostedClientUrl,
  trackRemoteClientRequest,
  type RemoteOAuthClient,
} from "../auth/downstream-client-metadata.js";
import {
  AuthorizationServerMismatchError,
  Client,
  InsecureTokenEndpointError,
  InsufficientScopeError,
  IssuerMismatchError,
  MissingRequiredClientCapabilityError,
  OAuthClientFlowError,
  OAuthError,
  ProtocolError,
  RegistrationRejectedError,
  ResourceNotFoundError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SseError,
  UnsupportedProtocolVersionError,
  UrlElicitationRequiredError,
  isInputRequiredResult,
  fromJsonSchema,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  extractWWWAuthenticateParams,
  specTypeSchemas,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  FetchLike,
  JsonSchemaType,
  CacheableRequestOptions,
  CallToolResult,
  JSONRPCMessage,
  ListResourcesResult,
  ListResourceTemplatesResult,
  OAuthTokens,
  PriorDiscovery,
  ReadResourceResult,
  ListToolsResult,
  RequestOptions,
  StandardSchemaV1,
  Tool,
  Transport,
} from "@modelcontextprotocol/client";
import { Deferred, Duration, Effect, Exit, Scope } from "effect";
import {
  assertOAuthScope,
  authorizingContext,
  codeExchangeResponse,
  EarlyRenewals,
  earlyRenewalFetch,
  KvOAuthProvider,
  OAuthRequestNotSentError,
  refreshCoordinatorsByPartition,
} from "../auth/downstream-oauth.js";
import { trackOAuthStartReset } from "../auth/oauth-start-reset.js";
import { byteReadResponse } from "../byte-read-response.js";
import {
  redactCatalog,
  redactSentSecrets,
  requestSentSecrets,
  sentSecretsFor,
  shortSecretWarning,
  type SentSecrets,
} from "../sent-secrets.js";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "../catalog-limits.js";
import {
  catalogClientOptions,
  catalogItems,
  observeCompletedCatalogRefresh,
  type CatalogMethod,
  type CompletedCatalogRefresh,
  type CatalogResult,
  closeCatalogCacheScope,
  observeCatalogChange,
  observeCatalogFetch,
  observeCatalogExpiry,
} from "../catalog-cache.js";
import { connectorScopeCleanupClaimed } from "../connector-scope.js";
import {
  boundedEchoText,
  ConnectorCallError,
  msg,
  networkErrorCode,
  resendAdvice,
  resendAdviceOf,
  unavailableCallError,
  WithheldTextError,
  withResendAdvice,
} from "../errors.js";
import {
  attachFailureFacts,
  carryFailureFacts,
  errorLabel,
  failureRecord,
  failureStatus,
  labelErrorClass,
  logFailure,
  OAUTH_ERROR_CODES,
  ownStatus,
} from "../operator-record.js";
import { CONNECTA_VERSION } from "../version.js";
import { learnedUrlRefusal } from "../url-safety.js";
import { oauthSealerFor } from "../oauth-sealing.js";
import { oauthPartitionFor, retainOAuthPartition } from "../oauth-partition.js";
import { RequestScope } from "../runtime/request-scope.js";
import { registerCallEntry } from "../runtime/call-entry.js";
import { Context } from "effect";
import { registerInvocationAuth } from "../invocation-auth.js";
import {
  downstreamInputCapabilities,
  assertDownstreamOutputSafe,
  downstreamWriteContinuation,
} from "../downstream-input-context.js";
import { detach, runEdge } from "../runtime/run.js";
import { assertKnownOptions, keys, optionsOf, strings } from "../config-schema.js";
import type { PrincipalForwarding, RequestPrincipal, RequestToken } from "../request-token.js";
import { requestPrincipalFor, tagPrincipalForwarding } from "../request-principal.js";
import { describedEndpoint, describedUrl } from "../described.js";
import { retryAfterMs } from "../http-policy.js";
import { resourceUriMatchesTemplates, type ResourceTemplateRefusal } from "./resource-uri.js";
import { callerOf } from "../connector-caller.js";
import { callClassification } from "../call-classification.js";
import { guardedTransport, sendGuarded, sendCredentialPost, type GuardedTransport } from "../guarded-transport.js";
import { sourceClassification } from "../tool-safety.js";
import {
  dispatchProviderRequest,
  recordProviderResponse,
  enterProviderBoundary,
  knownProviderFailure,
  providerBoundary,
  providerRequest,
  renewedAfterUnauthorized,
  vendorRefusal,
  type ProviderRequest,
} from "../provider-call.js";
import { providerCallFailure, unsentAfterUnauthorized } from "../write-outcome.js";
import { recordRequestField } from "../provider-call-facts.js";
import { readNegotiation, storeNegotiation } from "./negotiation-cache.js";
import { READ_ONLY, CALL_ADMISSION, REMOTE_MCP_AUTH, USAGE_GUIDE } from "./option-shapes.js";
import type {
  Connector,
  ConnectorAuthDescription,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorSkill,
  ConnectorSkillResourceContents,
  ConnectorStatus,
  ConnectorUsageGuide,
  CredentialTestResult,
  Logger,
  ToolDef,
} from "../types.js";

/**
 * A static downstream credential supplied through the connection in the
 * operator UI rather than baked into deployment source.
 *
 * The connector, its endpoint, and the credential *slot* stay declared in
 * code; only the secret arrives through the operator route, exactly as for
 * `api()`. One reserved `value` field, deliberately: a header is assembled
 * from a name, a framing scheme, and one secret, and anything that needs two
 * secrets composed into one header is a provider integration, not a proxy
 * config ([#439](https://github.com/zackbart/connecta/issues/439)).
 */
interface RemoteMcpCredentialAuth {
  type: "credential";
  /**
   * Slot description rendered in the connection in the operator UI. Defaults
   * to `{ label: "API key" }`; a maintained provider passes the name the provider
   * itself uses. Named `fields` are refused — this shape reads the reserved
   * `value` field only.
   */
  credential?: ConnectorCredentialConfig;
  /** Header the credential rides. Defaults to `Authorization`. */
  header?: string;
  /**
   * Framing token placed before the value. Defaults to `"Bearer"`. `null` (or
   * an empty string) sends the stored value verbatim, for an endpoint that
   * reads a bare key. A scheme whose last token is `Basic` declares
   * HTTP Basic credentials: the stored `user:secret` is base64-encoded first,
   * so `"Basic"` produces `Basic <base64>` and a nested
   * `"Bearer Basic"` produces `Bearer Basic <base64>`.
   */
  scheme?: string | null;
}

/**
 * Request-local Bearer auth. With `principal`, the resolver also receives the
 * caller inbound auth admitted, for a trusted first-party downstream.
 */
export type RemoteMcpRequestAuth =
  | {
      type: "request";
      /** Resolve a Bearer token inside this request. Never persisted or described. */
      token: RequestToken;
      principal?: never;
      /** Static protocol/catalog headers, never Authorization. */
      headers?: Record<string, string>;
    }
  | {
      type: "request";
      token?: never;
      /**
       * Resolve the Bearer token for the admitted caller instead. Callers the
       * policy does not accept are refused before the resolver runs.
       */
      principal: PrincipalForwarding;
      /** Static protocol/catalog headers, never Authorization. */
      headers?: Record<string, string>;
    };

interface RequestAuthFields {
  type: "request";
  token?: RequestToken;
  principal?: PrincipalForwarding;
  headers?: Record<string, string>;
}

export type RemoteMcpAuth =
  | RemoteMcpRequestAuth
  | { type: "headers"; headers: Record<string, string> }
  | RemoteMcpCredentialAuth
  | {
      type: "oauth";
      /** Public HTTPS client metadata document, for servers supporting URL-based client IDs. */
      clientMetadataUrl?: string;
      /** Pre-registered client, bound to its configured issuer; excludes clientMetadataUrl. */
      client?: RemoteOAuthClient;
      /** Space-separated default scopes when the resource server does not advertise them. */
      scope?: string;
      /** Non-secret browser authorization parameters; protocol fields are reserved. Changes require reconnect. */
      authorizationParams?: Record<string, string>;
    };

export type RemoteMcpRedirectPolicy = "none" | "same-origin";

export interface RemoteMcpOptions {
  url: string;
  /** Human-readable display name; the connector id remains the address prefix. */
  title?: string;
  description?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Max inline result size (bytes) for this connector's tools before
   * call_tool truncates and stashes the full text for connecta.result
   * paging. Overrides the deployment's `calls.maxResultBytes`; omit to inherit
   * it. Must be a whole number of bytes >= 1; anything else refuses to
   * construct.
   */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /**
   * Optional agent-facing usage guide served by `skills` as
   * `connector:<id>`. A string is markdown; the structured form adds bounded
   * discovery metadata. See `Connector.usageGuide`.
   */
  usageGuide?: string | ConnectorUsageGuide;
  /** Opt in to downstream Skills listing and resource reads. Defaults to false. */
  skills?: boolean;
  auth?: RemoteMcpAuth;
  /**
   * Non-secret resource context headers. Never credentials: use auth for those.
   * Auth-owned, HTTP transport/session and OAuth client-auth headers are
   * reserved. Cannot be combined with inline headers auth. Sent only at the
   * resource URL path. Values are never treated as sent secrets: arguments and
   * echoes equal to them pass unchanged.
   */
  headers?: Record<string, string>;
  /**
   * Downstream MCP version-negotiation mode. Defaults to `"auto"`, which
   * probes with `server/discover` and falls back to the legacy lifecycle when
   * the response identifies a legacy server. Set `"legacy"` only for a known
   * legacy downstream that cannot safely receive the discovery probe; that
   * path starts directly with the ordinary 2025 `initialize` handshake.
   */
  versionNegotiation?: "auto" | "legacy";
  /**
   * Downstream HTTP redirect policy. Defaults to `"none"`: every redirect is
   * rejected. `"same-origin"` follows at most five redirects while preserving
   * standard 301/302/303/307/308 method semantics. Cross-origin redirects and
   * HTTPS downgrades are always refused, so credentials never cross the
   * configured request's origin. A write is never sent to a redirect target
   * under either policy: a redirect answering a write fails it as an unknown
   * outcome (INV-9), so set `url` to the endpoint that answers directly.
   */
  redirects?: RemoteMcpRedirectPolicy;
  /**
   * Refuse to connect to a non-`https://` `url` at construction (default
   * false). Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) are always
   * allowed for local development. Off by default, static `headers` credentials
   * over a cleartext connection are warned about but permitted; set this true
   * to make that misconfiguration a hard error instead.
   */
  requireHttps?: boolean;
  /**
   * Destination for the cleartext-credential warning emitted at construction.
   * Default console.
   */
  logger?: Logger;
  /**
   * Send every MCP request through this fetch instead of the global one, such
   * as a Workers service binding: `(input, init) => env.NOTES.fetch(input, init)`.
   * `url` still names the logical origin, and the HTTPS, redirect and
   * same-origin rules apply to it. Each request, writes included, is handed
   * over once with `redirect: "manual"`; the function must not retry or follow
   * redirects. Cannot be combined with `auth: { type: "oauth" }`.
   */
  fetch?: FetchLike;
  /**
   * @internal Testing seam. When set, this transport is used instead of the
   * HTTP transport, letting tests point the connector at an in-process MCP
   * server (e.g. via InMemoryTransport). Not part of the public API.
   */
  _transportFactory?: (ctx: ConnectorContext) => Transport;
}

/** The closed options remoteMcp() accepts; see `assertKnownOptions`. */
const REMOTE_MCP_OPTIONS = optionsOf<RemoteMcpOptions>()({
  ...keys(
    "url",
    "title",
    "description",
    "authScope",
    "maxResultBytes",
    "versionNegotiation",
    "redirects",
    "requireHttps",
    "logger",
    "fetch",
    "_transportFactory",
    "skills",
  ),
  readOnly: READ_ONLY,
  callAdmission: CALL_ADMISSION,
  usageGuide: USAGE_GUIDE,
  auth: REMOTE_MCP_AUTH,
  headers: strings(),
});

/** Extra headers are immutable code configuration, not another auth channel. */
function extraResourceHeaders(id: string, opts: RemoteMcpOptions): Readonly<Record<string, string>> | undefined {
  if (opts.headers === undefined) return undefined;
  const refuse = () =>
    new Error(
      `remoteMcp(${JSON.stringify(id)}).headers requires non-secret resource headers without reserved or auth-owned names; use auth for credentials.`,
    );
  if (opts.auth?.type === "headers") throw refuse();
  const authNames = new Set([
    "authorization",
    ...(opts.auth?.type === "credential" ? [opts.auth.header?.trim().toLowerCase() || "authorization"] : []),
    ...(opts.auth?.type === "request" ? Object.keys(opts.auth.headers ?? {}).map((name) => name.toLowerCase()) : []),
  ]);
  const normalized: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(opts.headers)) {
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME_TOKEN.test(name) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value) ||
      Object.hasOwn(normalized, lower) ||
      authNames.has(lower) ||
      /^(?:accept|cookie|host|origin|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|last-event-id|dpop|www-authenticate)$/.test(
        lower,
      ) ||
      /^(?:content-|mcp-)/.test(lower) ||
      /(?:api[-_]?key|token|secret|password|credential|authorization|signature|session)/.test(lower)
    )
      throw refuse();
    try {
      normalized[lower] = new Headers({ [lower]: value }).get(lower)!;
    } catch {
      throw refuse();
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * How long a downstream gets to answer the session-termination DELETE before
 * teardown stops waiting. This is a network round-trip budget, deliberately
 * independent of the core's 100 ms caller-facing scope-close window: an
 * already-established cross-internet connection avoids setup, but 50 ms is
 * still too short for an ordinary round trip plus modest provider scheduling.
 * The bounded tail is deferred on runtimes that can keep it alive after the
 * response, while callers continue to wait at most 100 ms.
 */
const TERMINATE_SESSION_BUDGET_MS = 1_000;

/**
 * How long the local close gets after the DELETE: the second of the two
 * seconds the core's deferred scope-close tail allows (see
 * `src/runtime/connector-scope.ts`). The SDK's own transports close at once;
 * this bounds one that never does.
 */
const LOCAL_CLOSE_BUDGET_MS = 1_000;

function unadvertisedResource(): ConnectorCallError {
  return new ConnectorCallError("not_found", "The resource URI is not advertised by this connector.", {
    retryable: false,
  });
}

/** SDK aggregation cap; intake also refuses loops and non-progress (INV-8). */
const MAX_TOOL_PAGES = 10_000;
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const MAX_SKILLS = 10_000;
const MAX_SKILL_FILES = 512;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;
// A valid UTF-8 text file can expand sixfold when JSON escapes control bytes.
// Leave room for the envelope while accepting every file up to the spec limit.
const MAX_SKILL_READ_RPC_BYTES = 6 * MAX_SKILL_BYTES + 1024 * 1024;

/** Count UTF-8 without allocating another full copy of a bounded response. */

function skillObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillJsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

function validSkill(value: unknown): value is ConnectorSkill {
  if (
    !skillObject(value) ||
    typeof value.uri !== "string" ||
    !value.uri ||
    !skillObject(value.frontmatter) ||
    typeof value.frontmatter.name !== "string" ||
    !value.frontmatter.name ||
    typeof value.frontmatter.description !== "string" ||
    !value.frontmatter.description
  )
    return false;
  if (value.resources === "dynamic") return true;
  if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > MAX_SKILL_FILES)
    return false;
  const uris = new Set<string>();
  let bytes = 0;
  for (const resource of value.resources) {
    if (
      !skillObject(resource) ||
      typeof resource.uri !== "string" ||
      !resource.uri ||
      uris.has(resource.uri) ||
      typeof resource.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(resource.digest) ||
      typeof resource.size !== "number" ||
      !Number.isSafeInteger(resource.size) ||
      resource.size < 0
    )
      return false;
    uris.add(resource.uri);
    bytes += resource.size;
    if (bytes > MAX_SKILL_BYTES) return false;
  }
  return uris.has(value.uri);
}

function completeSkillResult(value: unknown): value is Record<string, unknown> {
  // The modern SDK codec rejects non-complete wire results and removes
  // resultType before invoking an explicit result schema.
  return (
    skillObject(value) &&
    typeof value.ttlMs === "number" &&
    Number.isSafeInteger(value.ttlMs) &&
    value.ttlMs >= 0 &&
    (value.cacheScope === "public" || value.cacheScope === "private")
  );
}

interface SkillPage {
  skills: ConnectorSkill[];
  nextCursor?: string;
  bytes: number;
}

const SkillPageSchema: StandardSchemaV1<unknown, SkillPage> = {
  "~standard": {
    version: 1,
    vendor: "connecta",
    validate(value) {
      if (
        !completeSkillResult(value) ||
        !Array.isArray(value.skills) ||
        value.skills.length > MAX_SKILLS ||
        !value.skills.every(validSkill) ||
        (value.nextCursor !== undefined && typeof value.nextCursor !== "string")
      ) {
        return { issues: [{ message: "Invalid or incomplete Skills listing." }] };
      }
      const bytes = skillJsonBytes(value);
      if (bytes > MAX_SERIALIZED_CATALOG_BYTES)
        return { issues: [{ message: "Skills listing exceeds the byte limit." }] };
      return {
        value: {
          skills: value.skills,
          bytes,
          ...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
        },
      };
    },
  },
};

function skillReadSchema(uri: string): StandardSchemaV1<unknown, ConnectorSkillResourceContents[]> {
  return {
    "~standard": {
      version: 1,
      vendor: "connecta",
      validate(value) {
        if (
          !completeSkillResult(value) ||
          !Array.isArray(value.contents) ||
          value.contents.length !== 1 ||
          skillJsonBytes(value) > MAX_SKILL_READ_RPC_BYTES
        ) {
          return { issues: [{ message: "Invalid or incomplete skill resource response." }] };
        }
        const content: unknown = value.contents[0];
        if (
          !skillObject(content) ||
          content.uri !== uri ||
          (content.mimeType !== undefined && typeof content.mimeType !== "string")
        ) {
          return { issues: [{ message: "Unexpected skill resource contents." }] };
        }
        const mimeType = typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {};
        if (typeof content.text === "string" && !("blob" in content) && utf8Length(content.text) <= MAX_SKILL_BYTES) {
          return { value: [{ uri, ...mimeType, text: content.text }] };
        }
        if (
          typeof content.blob === "string" &&
          !("text" in content) &&
          content.blob.length % 4 === 0 &&
          !/[^A-Za-z0-9+/]/.test(content.blob.replace(/={1,2}$/, ""))
        ) {
          const bytes =
            (content.blob.length / 4) * 3 - (content.blob.endsWith("==") ? 2 : content.blob.endsWith("=") ? 1 : 0);
          if (bytes <= MAX_SKILL_BYTES) return { value: [{ uri, ...mimeType, blob: content.blob }] };
        }
        return { issues: [{ message: "Invalid or oversized skill resource bytes." }] };
      },
    },
  };
}

/** Bound the body before SDK consumption, including its detached SSE reader. */
async function boundedSkillResponse(
  response: Response,
  limit: number,
  rpcId: unknown,
  signal?: AbortSignal | null,
): Promise<Response> {
  const exceeded = () =>
    new ConnectorCallError("connector_call_failed", "Downstream Skills response exceeds the RPC byte limit.");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel().catch(() => {});
    throw exceeded();
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let buffer: Uint8Array | undefined;
  let buffered = 0;
  const sse = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
  // Decode an entire SSE message once. Its byte buffer has no per-chunk or
  // per-line objects, and preserves embedded resource BOMs on workerd too.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });
  let data = new Uint8Array(0);
  let dataBytes = 0;
  let hasData = false;
  const newline = new Uint8Array([10]);
  const field = [100, 97, 116, 97, 58]; // data:
  const bom = [239, 187, 191];
  let bomOffset = 0;
  let fieldOffset = 0;
  // 0: field prefix, 1: optional value space, 2: data value, 3: ignored line.
  let state = 0;
  let lineBytes = false;
  let skipLf = false;
  const append = (value: Uint8Array) => {
    const needed = dataBytes + value.byteLength;
    if (needed > limit) throw exceeded();
    if (needed > data.length) {
      const next = new Uint8Array(Math.min(limit, Math.max(65_536, needed, data.length * 2)));
      next.set(data.subarray(0, dataBytes));
      data = next;
    }
    data.set(value, dataBytes);
    dataBytes = needed;
  };
  const beginData = () => {
    if (hasData) append(newline);
    hasData = true;
  };
  const consume = (chunk: Uint8Array): string | undefined => {
    for (let offset = 0; offset < chunk.length;) {
      const byte = chunk[offset]!;
      if (skipLf) {
        skipLf = false;
        if (byte === 10) {
          offset++;
          continue;
        }
      }
      // Strip exactly one initial UTF-8 BOM, even across single-byte chunks.
      if (bomOffset >= 0) {
        if (byte === bom[bomOffset]) {
          if (++bomOffset === bom.length) bomOffset = -1;
          offset++;
          continue;
        }
        if (bomOffset) {
          lineBytes = true;
          state = 3;
        }
        bomOffset = -1;
      }
      if (byte === 10 || byte === 13) {
        if (lineBytes) {
          if (state === 0 && fieldOffset === 4) beginData();
        } else {
          const json = hasData && dataBytes ? decoder.decode(data.subarray(0, dataBytes)) : "";
          dataBytes = 0;
          hasData = false;
          if (json) {
            const message: unknown = JSON.parse(json);
            if (skillObject(message) && message.id === rpcId && ("result" in message || "error" in message)) {
              data = new Uint8Array(0);
              return json;
            }
          }
        }
        state = 0;
        fieldOffset = 0;
        lineBytes = false;
        skipLf = byte === 13;
        offset++;
        continue;
      }
      lineBytes = true;
      if (state === 0) {
        if (byte === field[fieldOffset]) {
          if (++fieldOffset === field.length) {
            beginData();
            state = 1;
          }
        } else state = 3;
        offset++;
        continue;
      }
      if (state === 1) {
        state = 2;
        if (byte === 32) {
          offset++;
          continue;
        }
      }
      let end = offset;
      while (end < chunk.length && chunk[end] !== 13 && chunk[end] !== 10) end++;
      if (state === 2) append(chunk.subarray(offset, end));
      offset = end;
    }
  };
  const terminalResponse = async (json: string) => {
    // The SDK's detached SSE consumer does not settle body-read errors. Hand
    // it the bounded terminal answer and close a server-kept-open stream.
    await reader.cancel().catch(() => {});
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return new Response(json, { status: response.status, statusText: response.statusText, headers });
  };
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw exceeded();
      if (!sse) {
        // Network chunk count and backing-buffer size are untrusted. Retain
        // only owned fixed-size blocks, never one object per incoming byte.
        for (let offset = 0; offset < chunk.value.byteLength;) {
          buffer ??= new Uint8Array(65_536);
          const size = Math.min(buffer.length - buffered, chunk.value.byteLength - offset);
          buffer.set(chunk.value.subarray(offset, offset + size), buffered);
          offset += size;
          buffered += size;
          if (buffered === buffer.length) {
            chunks.push(buffer);
            buffer = undefined;
            buffered = 0;
          }
        }
        continue;
      }
      const terminal = consume(chunk.value);
      if (terminal !== undefined) return await terminalResponse(terminal);
    }
    if (sse)
      throw new ConnectorCallError(
        "connector_call_failed",
        "Downstream Skills stream ended without a terminal RPC response.",
      );
    if (buffer && buffered) chunks.push(buffer.subarray(0, buffered));
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/**
 * Compatibility concession for hand-rolled servers that serialize
 * end-of-pagination as `null`. Only the cursor is widened; every tool and every
 * other result field still passes through the SDK's pinned schema.
 */
const CompatibleListToolsResultSchema: StandardSchemaV1<unknown, ListToolsResult> = {
  "~standard": {
    version: 1,
    vendor: "connecta",
    validate(value) {
      const normalized =
        typeof value === "object" && value !== null && "nextCursor" in value && value.nextCursor === null
          ? (() => {
              const copy = { ...value };
              delete copy.nextCursor;
              return copy;
            })()
          : value;
      return specTypeSchemas.ListToolsResult["~standard"].validate(normalized);
    },
  },
};

/**
 * True for a result-parse failure caused by the page's `nextCursor` itself.
 * `null` is accepted deliberately; other non-string values remain a named
 * downstream nonconformance instead of surfacing as a raw validation dump.
 * Duck-typed rather than `instanceof ZodError`: the SDK may parse with its own
 * zod instance, and cross-instance `instanceof` is a coin flip.
 */
function isCursorShapeError(err: unknown): boolean {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (
    Array.isArray(issues) &&
    issues.some((issue) => {
      const path = (issue as { path?: unknown }).path;
      return Array.isArray(path) && path[0] === "nextCursor";
    })
  ) {
    return true;
  }
  // SDK v2 wraps Standard Schema failures in a ProtocolError and preserves the
  // failing path in the message rather than exposing the validator's issues.
  return msg(err).startsWith("Invalid result for tools/list: nextCursor:");
}

/**
 * An `authorize_connector` start message for a failure: its text, which has
 * passed the MCP and OAuth boundaries, and the origin and errno connecta
 * derived for it, which a message alone would drop.
 */
/** An authorization start's failure for authorize_connector: no write's, so its advice stays. */
function startMessage(err: unknown): string {
  const details = err instanceof ConnectorCallError ? err.details : undefined;
  const facts = [details?.host, details?.code].filter(Boolean).join(", ");
  return withResendAdvice(facts ? `${msg(err)} (${facts})` : msg(err), resendAdviceOf(err));
}

/**
 * End the downstream's session before the connection is torn down.
 *
 * `Client.close()` only unwinds our side — it aborts the transport's controller
 * and fires `onclose`. Spec session termination is a separate DELETE carrying
 * `Mcp-Session-Id`, and without it a stateful provider keeps the session alive
 * until its own (often hour-long) timeout, accumulating abandoned sessions.
 *
 * Ordering is load-bearing: the SDK sends that DELETE on the transport's
 * AbortSignal, so calling this *after* close would abort the request on issue
 * and silently do nothing. Everything else is best-effort — a transport with no
 * `terminateSession` (a custom one, or an older SDK), a downstream that refuses
 * (405 is a legal answer), errors, or never replies all fall through to the
 * close with the session left to age out as it did before.
 */
function terminateSession(transport: Transport, logger: Logger, connectorId: string): Effect.Effect<void> {
  // SDK v2's Client.close() does not send the legacy session DELETE on our
  // behalf. Connecta's own endpoint creates no protocol session, but a stateful
  // legacy downstream can still issue `Mcp-Session-Id`, and every path that
  // abandons one — scope teardown, credential rotation, OAuth retirement, an
  // abandoned connect — owes it this best-effort, one-second DELETE.
  const terminate = (transport as Transport & { terminateSession?: () => Promise<void> }).terminateSession;
  if (typeof terminate !== "function") return Effect.void;
  const warn = (log: () => void) =>
    Effect.sync(() => {
      try {
        log();
      } catch {
        // A diagnostic sink cannot make best-effort teardown observable to the
        // caller in the one way this contract forbids: by replacing its result.
      }
    });
  // Whichever finishes first wins and the other is interrupted: an answer
  // clears the timer, and a failure that lands after the timeout is consumed
  // by the interrupted wait rather than warned about a second time.
  return Effect.raceAllFirst([
    // The SDK issues no request at all when no `mcp-session-id` was captured,
    // so a stateless downstream never sees a spurious DELETE.
    promised(
      authMethod(() => authInvoke(Reflect, "apply", [terminate, transport, []]) as Effect.Effect<void, unknown>),
    ).pipe(
      Effect.catch((error) =>
        // The SDK's error quotes the downstream's status text, and its `data`
        // the body, so the record keeps only the status it answered with.
        warn(() =>
          logFailure(
            logger,
            "session termination refused or failed; the downstream session may remain until its provider timeout",
            failureRecord(
              { connector: connectorId },
              error instanceof SdkHttpError ? attachFailureFacts(error, { httpStatus: error.status }) : error,
            ),
          ),
        ),
      ),
    ),
    Effect.sleep(Duration.millis(TERMINATE_SESSION_BUDGET_MS)).pipe(
      Effect.andThen(
        warn(() =>
          logger.warn(
            `[connecta] connector "${connectorId}" session termination was not ` +
              `acknowledged within ${TERMINATE_SESSION_BUDGET_MS} ms; the ` +
              "downstream may still finish the headers-only DELETE, otherwise " +
              "the session will remain until its provider timeout.",
          ),
        ),
      ),
    ),
  ]);
}

/**
 * The local half of a close: the SDK client's close once a client owns the
 * transport, the bare transport's until then. Never fails, and stops waiting
 * after LOCAL_CLOSE_BUDGET_MS — a transport whose close never settles would
 * otherwise hold every caller that awaits the scope close, the credential Test
 * action among them.
 */
function closeLocally(client: Client | null, transport: Transport | null): Effect.Effect<void> {
  if (!client && !transport) return Effect.void;
  return Effect.raceAllFirst([
    promised(
      authMethod(
        () =>
          (client ? authInvoke(client, "close", []) : authValue(() => transport?.close())) as Effect.Effect<
            void | undefined,
            unknown
          >,
      ),
    ).pipe(Effect.ignore),
    Effect.sleep(Duration.millis(LOCAL_CLOSE_BUDGET_MS)),
  ]);
}

/**
 * One Promise step of an Effect program. It fails with exactly what the
 * promise rejected with, never a wrapper, because callers check the SDK's and
 * connecta's own error classes. `evaluate` takes no signal, so the step
 * allocates no AbortController.
 */
function promised<A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return authCall(evaluate, []);
}

/** A retained cause chain must not smuggle an SDK payload past the boundary. */
function hasSdkPayload(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof ProtocolError || current instanceof SdkError) return true;
    seen.add(current);
  }
  return false;
}

/** Cancellation can bypass an inner SDK catch and return the signal's reason. */
function payloadFree<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return authMethod((...args: A) =>
    authFlow<R>(function* () {
      try {
        return (yield authCall(run, [...args])) as Awaited<R>;
      } catch (error) {
        throw hasSdkPayload(error) ? carryFailureFacts(error, downstreamCallError(error)) : error;
      }
    }),
  );
}

/** Both the SDK's auth signal and its classified form invalidate a live client. */
function requiresAuthorization(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof ConnectorCallError &&
      (error.code === "auth_required" || error.code === "downstream_oauth_required"))
  );
}

/** Classify SDK/runtime facts, dropping every SDK payload and cause chain. */
function downstreamCallError(
  error: unknown,
  httpStatus?: number,
  wait?: number,
  oauthStep?: OAuthStep,
  secrets?: SentSecrets,
): unknown {
  if (error instanceof ConnectorCallError) {
    return hasSdkPayload(error.cause) ? carryFailureFacts(error, withheldAs(error.message, error)) : error;
  }
  if (error instanceof WithheldTextError || error instanceof UnauthorizedError) return error;
  const network =
    !(error instanceof SdkError) && !(error instanceof OAuthClientFlowError) ? networkErrorCode(error) : undefined;
  if (network) {
    return network === "timeout" || network === "ETIMEDOUT" || network.endsWith("_TIMEOUT")
      ? new ConnectorCallError("timeout", "The downstream request timed out.")
      : unavailableCallError(error);
  }
  const status =
    error instanceof SdkHttpError || error instanceof RegistrationRejectedError ? error.status : httpStatus;
  if (
    error instanceof InsufficientScopeError ||
    (status === 403 && !(error instanceof RegistrationRejectedError)) ||
    (error instanceof OAuthError && ["insufficient_scope", "invalid_scope", "access_denied"].includes(error.code))
  ) {
    return new ConnectorCallError(
      "provider_permission_denied",
      "The provider denied this operation. Check the account's permissions and the tool's required access with the provider or an administrator.",
    );
  }
  // Token endpoints return typed OAuth recovery codes on HTTP 400. Other
  // OAuth steps, especially registration, keep their HTTP status verdict.
  if (
    error instanceof OAuthError &&
    OAUTH_ERROR_CODES.has(error.code) &&
    (status === undefined || oauthStep === "token request")
  ) {
    return new ConnectorCallError(
      ["invalid_client", "invalid_grant", "invalid_token", "unauthorized_client"].includes(error.code)
        ? "downstream_oauth_required"
        : error.code === "too_many_requests"
          ? "rate_limited"
          : ["server_error", "temporarily_unavailable"].includes(error.code)
            ? "unavailable"
            : "connector_call_failed",
      `OAuth failed with error ${error.code}.`,
    );
  }
  if (status !== undefined && status >= 400) {
    let message = `The downstream service answered HTTP ${status}.`;
    if (error instanceof SdkHttpError && status < 500 && typeof error.data.text === "string") {
      message = error.message;
      try {
        const body = JSON.parse(error.data.text);
        const detail = body?.message ?? body?.error?.message ?? body?.error_description;
        if (typeof detail === "string") message = detail;
      } catch {
        // Non-JSON MCP refusals retain only a bounded diagnostic.
      }
    }
    return new ConnectorCallError(
      status === 401 && !(error instanceof RegistrationRejectedError)
        ? "auth_required"
        : status === 429
          ? "rate_limited"
          : status === 408 && !(error instanceof RegistrationRejectedError)
            ? "timeout"
            : "connector_call_failed",
      boundedEchoText(secrets?.text(message) ?? message),
      {
        retryable:
          [429, 502, 503, 504].includes(status) || (status === 408 && !(error instanceof RegistrationRejectedError)),
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      },
    );
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new ConnectorCallError("timeout", "The downstream request timed out.");
  }
  // ProtocolError.data is server-chosen even when its message is allowed.
  if (error instanceof ProtocolError) {
    return new ConnectorCallError(
      error.code === -32602 ? "invalid_args" : "connector_call_failed",
      boundedEchoText(secrets?.text(error.message) ?? error.message),
    );
  }
  return new ConnectorCallError("connector_call_failed", "The downstream operation failed.");
}

const encoder = new TextEncoder();

/** Base64 of a UTF-8 string, Web-API only so the core still runs on workerd. */
function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Assemble the one header a credential-auth connector sends.
 *
 * A scheme ending in `Basic` names HTTP Basic credentials wherever a provider
 * nests it, so the `user:secret` it frames is base64-encoded — that is what
 * makes plain `Basic` and nested `Bearer Basic` one rule instead of two.
 */
function credentialHeaderValue(scheme: string | null, value: string): string {
  if (scheme === null) return value;
  return /(?:^|\s)basic$/i.test(scheme) ? `${scheme} ${base64Utf8(value)}` : `${scheme} ${value}`;
}

/**
 * True when a stored credential carries a character a header cannot.
 *
 * The fetch specification refuses NUL, CR, and LF outright, and the runtime
 * that refuses them says so in a `TypeError` that quotes the whole offending
 * value — a message that would otherwise travel to the agent. The remaining C0
 * controls and DEL are refused here too: no real API key contains one, and a
 * paste that picked one up is a paste to redo rather than a request to send.
 * Leading and trailing whitespace is already gone by the time this runs.
 *
 * A scan rather than a regular expression, because a character class over the
 * control range is exactly what `no-control-regex` exists to flag, and the
 * suppression would be less readable than the loop it suppressed.
 */
function carriesIllegalHeaderChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** RFC 9110 field-name token, checked once at construction. */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export const MAX_REMOTE_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
];

export class RemoteMcpRedirectError extends ConnectorCallError {
  constructor(connectorId: string, reason: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" redirect policy rejected the downstream response: ${reason}.`,
    );
    this.name = "RemoteMcpRedirectError";
  }
}
labelErrorClass(RemoteMcpRedirectError, "RemoteMcpRedirectError");

function redirectedInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const becomesGet =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  if (!becomesGet) return init;
  const headers = new Headers(init.headers);
  for (const name of BODY_HEADERS) headers.delete(name);
  const redirected = { ...init, method: "GET", headers };
  delete redirected.body;
  return redirected;
}

/**
 * Wrap fetch with explicit, bounded redirect handling.
 *
 * The starting URL of each fetch call is trusted by its caller (the configured
 * MCP endpoint, or an OAuth URL the pinned SDK discovered and
 * `learnedUrlSafeFetch` already admitted). Only Location
 * values are policy-controlled here. No rejected target is ever fetched, so
 * arbitrary static header names receive the same protection as Authorization.
 */
export function redirectSafeFetch(
  connectorId: string,
  policy: RemoteMcpRedirectPolicy = "none",
  baseFetch: FetchLike = fetch,
): FetchLike {
  return authMethod((input: string | URL, initialInit: RequestInit | undefined = {}) =>
    authFlow<Response>(function* () {
      let current = new URL(input);
      let init = initialInit;
      const seen = new Set<string>([current.href]);
      let hops = 0;
      while (true) {
        let response: Response;
        try {
          response = (yield authCall(baseFetch, [
            current,
            {
              ...init,
              redirect: "manual",
            },
          ])) as Response;
        } catch (cause) {
          if (cause instanceof ConnectorCallError) throw downstreamCallError(cause);
          throw unavailableCallError(
            cause,
            current.href,
            undefined,
            hasSdkPayload(cause) ? undefined : (init.signal ?? undefined),
          );
        }
        if (!REDIRECT_STATUSES.has(response.status)) return byteReadResponse(response);
        const location = response.headers.get("location");
        (yield authCatch(
          authValue(() => response.body?.cancel()),
          () => {},
        )) as void | undefined;
        if (!location) {
          throw new RemoteMcpRedirectError(connectorId, `HTTP ${response.status} carried no Location header`);
        }
        if (policy === "none") {
          throw new RemoteMcpRedirectError(connectorId, `HTTP ${response.status} redirects are disabled`);
        }
        if (hops >= MAX_REMOTE_REDIRECT_HOPS) {
          throw new RemoteMcpRedirectError(connectorId, `the redirect chain exceeded ${MAX_REMOTE_REDIRECT_HOPS} hops`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new RemoteMcpRedirectError(connectorId, `HTTP ${response.status} carried an invalid Location header`);
        }
        if (current.protocol === "https:" && next.protocol !== "https:") {
          throw new RemoteMcpRedirectError(connectorId, "an HTTPS-to-HTTP downgrade is not allowed");
        }
        if (next.origin !== current.origin) {
          throw new RemoteMcpRedirectError(connectorId, "a cross-origin redirect is not allowed");
        }
        if (next.username || next.password) {
          throw new RemoteMcpRedirectError(connectorId, "a redirect target containing URL credentials is not allowed");
        }
        if (seen.has(next.href)) {
          throw new RemoteMcpRedirectError(connectorId, "the redirect chain loops");
        }
        seen.add(next.href);
        hops++;
        init = redirectedInit(init, response.status);
        current = next;
      }
    }),
  );
}

class RemoteMcpDestinationError extends OAuthRequestNotSentError {
  constructor(connectorId: string, reason: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" refused an OAuth URL the downstream advertised: ${reason}.`,
    );
    this.name = "RemoteMcpDestinationError";
  }
}
labelErrorClass(RemoteMcpDestinationError, "RemoteMcpDestinationError");

/** A connection whose request scope ended while it was being made. */
class ScopeEndedError extends Error {
  override readonly name = "ScopeEndedError";
}
labelErrorClass(ScopeEndedError, "ScopeEndedError");

/** The MCP client's transport lacks the OAuth flow seams this release is pinned against. */
class UnboundOAuthFlowsError extends Error {
  override readonly name = "UnboundOAuthFlowsError";
}
labelErrorClass(UnboundOAuthFlowsError, "UnboundOAuthFlowsError");

// The pinned SDK's exported errors, labelled by identity for records and
// connecta's fixed text.
for (const [ctor, label] of [
  [SdkError, "SdkError"],
  [SdkHttpError, "SdkHttpError"],
  [ProtocolError, "ProtocolError"],
  [MissingRequiredClientCapabilityError, "MissingRequiredClientCapabilityError"],
  [ResourceNotFoundError, "ResourceNotFoundError"],
  [UnsupportedProtocolVersionError, "UnsupportedProtocolVersionError"],
  [UrlElicitationRequiredError, "UrlElicitationRequiredError"],
  [SseError, "SseError"],
  [OAuthError, "OAuthError"],
  [UnauthorizedError, "UnauthorizedError"],
  [OAuthClientFlowError, "OAuthClientFlowError"],
  [AuthorizationServerMismatchError, "AuthorizationServerMismatchError"],
  [InsecureTokenEndpointError, "InsecureTokenEndpointError"],
  [InsufficientScopeError, "InsufficientScopeError"],
  [IssuerMismatchError, "IssuerMismatchError"],
  [RegistrationRejectedError, "RegistrationRejectedError"],
] as const) {
  labelErrorClass(ctor, label);
}

/**
 * Refuse, before any request leaves, a URL the downstream taught the OAuth
 * flow that points somewhere connecta must not go (see `url-safety.ts`).
 *
 * The SDK learns authorization-server, token, and registration URLs from the
 * downstream's own metadata and fetches them through the transport's fetch,
 * so this sits below the refresh coordinator on both send paths. Resource
 * redirects stay same-origin; credential-bearing token requests bypass the
 * redirect wrapper. The typed local refusal proves that this guard sent nothing;
 * failures after an HTTP dispatch keep their permanent ambiguous verdict.
 */
function learnedUrlSafeFetch(connectorId: string, configured: URL, baseFetch: FetchLike): FetchLike {
  return authMethod((input: string | URL, init: RequestInit | undefined) =>
    authFlow<Response>(function* () {
      const reason = learnedUrlRefusal(configured, new URL(input));
      if (reason !== undefined) {
        throw new RemoteMcpDestinationError(connectorId, reason);
      }
      return byteReadResponse((yield authCall(baseFetch, [input, init])) as Response);
    }),
  );
}

/** The JSON-RPC error answers each transport delivered, as `code\0message`. */
const wireErrors = new WeakMap<Transport, Set<string>>();
/** Answers remembered per transport; one request scope rarely sees more. */
const MAX_WIRE_ERRORS = 64;

function wireErrorKey(code: unknown, message: unknown): string {
  return `${String(code)}\u0000${String(message)}`;
}

/**
 * Remember every JSON-RPC error response `transport` delivers, so that a
 * `ProtocolError` can be told apart as the downstream's own answer. The SDK
 * builds its local refusals (an output schema it cannot compile, a result
 * that fails it) from the same class, with its own text about what the
 * downstream sent; only one whose code and message arrived on the wire is
 * the answer. Installed before `Client.connect`, whose protocol calls the
 * `onmessage` it finds there ahead of its own for every message, and whose
 * version probe restores it when the probe is done.
 */
function recordWireErrors(transport: Transport, catalogChanged: () => void): void {
  const seen = new Set<string>();
  wireErrors.set(transport, seen);
  transport.onmessage = (message) => {
    // The public transport observer runs before SDK 2.3.1's delete-based
    // eviction. Ordinary opposite-scope cleanup never rotates this fence.
    if (
      isJSONRPCNotification(message) &&
      (message.method === "notifications/tools/list_changed" ||
        message.method === "notifications/resources/list_changed")
    )
      catalogChanged();
    if (isJSONRPCErrorResponse(message) && seen.size < MAX_WIRE_ERRORS) {
      seen.add(wireErrorKey(message.error.code, message.error.message));
    }
  };
}

/**
 * Whether an error leaving the SDK may keep its own text. The boundary is an
 * allow-list: a JSON-RPC error the downstream answered with, an HTTP 4xx
 * refusal from the MCP endpoint, and errors already in connecta's words (its
 * own classes, an OAuth error the token responses were rebuilt into, and
 * `UnauthorizedError`, whose class is the whole verdict and whose text is
 * never shown). The request's own abort reason is checked by identity before
 * this. Everything else is withheld.
 */
function keepsItsText(err: unknown, transport: Transport | undefined): boolean {
  if (
    err instanceof ConnectorCallError ||
    err instanceof WithheldTextError ||
    err instanceof UnauthorizedError ||
    err instanceof OAuthError
  ) {
    return true;
  }
  if (err instanceof SdkHttpError) return err.status >= 400 && err.status < 500;
  if (err instanceof ProtocolError) {
    return transport !== undefined && wireErrors.get(transport)?.has(wireErrorKey(err.code, err.message)) === true;
  }
  return false;
}

/**
 * The SDK's own checks of a tool's output schema, recognized by how the
 * pinned SDK (2.3.1) begins their messages, and told in connecta's words.
 * Recognition reads the SDK's text only to choose connecta's: none of it, nor
 * the validator's account that follows, is repeated.
 */
const SDK_OUTPUT_SCHEMA_CHECKS: readonly (readonly [RegExp, string])[] = [
  [
    /^Structured content does not match the tool's output schema/,
    "the result did not match the tool's declared output schema",
  ],
  [
    /^Tool .* has an output schema but did not return structured content/s,
    "the result did not return structured content although the tool declares an output schema",
  ],
  [/^Tool .* has an invalid outputSchema/s, "the tool's declared output schema could not be compiled"],
];

function sdkCheckFailed(err: unknown): string {
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return ": the request timed out";
  if (!(err instanceof ProtocolError)) return "";
  const check = SDK_OUTPUT_SCHEMA_CHECKS.find(([pattern]) => pattern.test(err.message));
  return check ? `: ${check[1]}` : "";
}

/** The first error in `err`'s cause chain already told in connecta's words. */
function connectaErrorWithin(err: unknown): ConnectorCallError | WithheldTextError | undefined {
  const seen = new Set<unknown>();
  for (
    let current: unknown = err instanceof Error ? err.cause : undefined;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (current instanceof ConnectorCallError || current instanceof WithheldTextError) return current;
  }
  return undefined;
}

/** The request's own abort reason, by identity, never by name or class. */
function ownAbortReason(err: unknown, signals: readonly (AbortSignal | undefined)[]): boolean {
  return signals.some((signal) => signal?.aborted === true && err === signal.reason);
}

/**
 * The request's own abort reason as the SDK hands it back: a request it
 * cancels rejects with `new SdkError(RequestTimeout, String(reason))` unless
 * the reason already is one (pinned against client 2.3.1). Its text is the
 * caller's, so it passes as the SDK wrote it.
 */
function ownAbortReasonAsSdkReports(err: unknown, signals: readonly (AbortSignal | undefined)[]): boolean {
  return (
    err instanceof SdkError &&
    err.code === SdkErrorCode.RequestTimeout &&
    signals.some((signal) => signal?.aborted === true && err.message === String(signal.reason))
  );
}

/** An error's class name, when it is a plain identifier worth naming. */
function errorKind(err: unknown): string {
  const label = errorLabel(err);
  return label && label !== "Error" ? ` (${label})` : "";
}

/**
 * Replace text while keeping a verdict already derived from structured facts.
 * Never retain the original SDK error as a cause.
 */
function withheldAs(message: string, verdict: unknown): Error {
  if (verdict instanceof ConnectorCallError) {
    return new ConnectorCallError(verdict.code, message, {
      retryable: verdict.retryable,
      ...(verdict.retryAfterMs !== undefined ? { retryAfterMs: verdict.retryAfterMs } : {}),
      ...(verdict.details ? { details: verdict.details } : {}),
      ...(verdict.validation ? { validation: verdict.validation } : {}),
      ...(verdict.current ? { current: verdict.current } : {}),
      ...(verdict.writeOutcome ? { writeOutcome: verdict.writeOutcome } : {}),
    });
  }
  return new WithheldTextError(message, verdict);
}

/** An OAuth step, named by the shape the pinned SDK gives its request. */
type OAuthStep = "discovery" | "client registration" | "token request";

/**
 * Where one OAuth flow last went, kept so that a failure whose text is
 * withheld still says which step failed and against which host. Origins
 * only, as `details.host` carries them. One per flow, never shared.
 */
interface OAuthTrail {
  /** The flow's latest request, if it was not to the MCP endpoint. */
  last?: { step: OAuthStep; host: string; httpStatus?: number; retryAfterMs?: number } | undefined;
  /** The origin a client registration was last sent to. */
  registration?: string;
}

/**
 * Record each OAuth request on `trail` before sending it. Pinned against
 * `@modelcontextprotocol/client` 2.3.1: every request the SDK sends anywhere
 * but the MCP endpoint is a discovery GET, a token request (a form carrying
 * `grant_type`), or the JSON POST of dynamic client registration.
 */
function tracedOAuthFetch(trail: OAuthTrail, endpoint: URL, baseFetch: FetchLike): FetchLike {
  return authMethod((input: string | URL, init: RequestInit | undefined) =>
    authFlow<Response>(function* () {
      const url = new URL(input);
      if (url.href === endpoint.href) {
        trail.last = undefined;
      } else {
        const body = init?.body;
        const step: OAuthStep =
          (init?.method ?? "GET").toUpperCase() === "GET"
            ? "discovery"
            : body instanceof URLSearchParams ||
                (typeof body === "string" && new URLSearchParams(body).has("grant_type"))
              ? "token request"
              : "client registration";
        trail.last = { step, host: url.origin };
        if (step === "client registration") trail.registration = url.origin;
      }
      const leg = trail.last;
      const response = (yield authCall(baseFetch, [input, init])) as Response;
      if (leg) {
        leg.httpStatus = response.status;
        const wait = retryAfterMs(response.headers);
        if (wait !== undefined) leg.retryAfterMs = wait;
      }
      return byteReadResponse(response);
    }),
  );
}

function registrationErrorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: unknown } | null)?.error;
    return typeof code === "string" && OAUTH_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One logical `tools/call` as its requests meet the wire. The pinned SDK can
 * send one call more than once: after a 401 it renews the grant and resends
 * the message, a redirect hop sends its body again, and a `HeaderMismatch`
 * answer makes `callTool` relist and send the call again under a new JSON-RPC
 * id. So a write is held to one send by its call, never by any one message
 * (INV-9). Reads keep the SDK's recoveries.
 */
interface CallDispatch {
  /** At most one request for this call may leave connecta. */
  write: boolean;
  /** Source policy requires write outcome accounting even when served as a read. */
  sourceWrite: boolean;
  /** A request for this call was handed to fetch; no other one may be. */
  sent: boolean;
  /** The answer was a 401, so the SDK renews the grant and resends. */
  unauthorized: boolean;
  /** The answer was a redirect, whose next hop would send the write again. */
  redirected: boolean;
  /** A further send of this call was stopped before it left. */
  resendRefused: boolean;
  /**
   * Its entry in the call's ledger and logical call, recorded as it leaves
   * and is answered, with the context it was called under. A read is
   * auxiliary there: it cannot be the write.
   */
  request?: { entry: ProviderRequest; ctx: ConnectorContext };
  /** The `Authorization` its one send carried, for a renewal to be compared with. */
  authorization?: string | null;
}

/**
 * The key a `tools/call`'s params carry its dispatch under. Object spread
 * copies a symbol-keyed property, and the pinned SDK only spreads a request's
 * params (to add a progress token or its `_meta` envelope); `JSON.stringify`
 * skips symbol keys, so nothing of it reaches the wire.
 */
const DISPATCH = Symbol("connecta.dispatch");

function newDispatch(write: boolean, sourceWrite: boolean): CallDispatch {
  return { write, sourceWrite, sent: false, unauthorized: false, redirected: false, resendRefused: false };
}

function withDispatch<T extends object>(params: T, dispatch: CallDispatch): T {
  Object.defineProperty(params, DISPATCH, { value: dispatch, enumerable: true });
  return params;
}

function dispatchOf(params: unknown): CallDispatch | undefined {
  return params !== null && typeof params === "object"
    ? (params as { [DISPATCH]?: CallDispatch })[DISPATCH]
    : undefined;
}

/** A further request for a write that already left, stopped before it does. */
function resendRefused(dispatch: CallDispatch): ConnectorCallError {
  dispatch.resendRefused = true;
  return new ConnectorCallError("connector_call_failed", "This write was already sent once; it was not sent again.", {
    retryable: false,
    writeOutcome: "unknown",
  });
}

/** Lost tracking cannot prove whether an earlier message already sent a write. */
function missingDispatch(): ConnectorCallError {
  return new ConnectorCallError(
    "connector_call_failed",
    "The downstream call lost its dispatch record and cannot be proven read-only. It was not sent; whether an earlier write took effect is unknown. Check the target before repeating it.",
    { retryable: false, writeOutcome: "unknown" },
  );
}

/** What a pre-connect catalog read already resolved, for the connect it falls back to. */
interface Preread {
  credential?: string;
  negotiation?: { digest: string; prior: PriorDiscovery | undefined };
}

interface ConnectionState {
  /**
   * The request scope's lifetime, closed once, by closeScope, and never
   * reopened. Closed is terminal: neither a late connect nor a `reset()` can
   * cache a client into a scope that is already gone, because that client
   * would have no owner left to close it.
   */
  scope: Scope.Closeable;
  /**
   * The live connection's lifetime, a child of `scope`, taken out when its
   * provider reads storage or a transport is built. Closing it cancels the
   * provider and closes that transport — through its client once connected —
   * and closing `scope` closes it too.
   */
  lease: Scope.Closeable | null;
  client: Client | null;
  transport: Transport | null;
  /**
   * The last complete redacted catalog, retained only for this request scope.
   *
   * SDK v2 exposes `toolDefinition` as the public call-time seam for output
   * validation and header mirroring, replacing the v1 private
   * `cacheToolMetadata` reach-through.
   */
  toolDefinitions: Map<string, Tool>;
  /** Active logical calls prove read safety if a message loses its dispatch. */
  dispatches: Map<CallDispatch, string>;
  /**
   * The connect in flight, published before any of it runs so every call
   * that arrives meanwhile joins it rather than starting a second. Completed
   * once, by the attempt itself, with the client it connected.
   */
  connecting: Deferred.Deferred<Client, unknown> | null;
  authRequired: boolean;
  provider: KvOAuthProvider | null;
  connectedGeneration: string | null;
  /**
   * The provider of the latest connect attempt: the consent it stored, if
   * any, is the one a start hands out, while its epoch is live.
   */
  attemptProvider: KvOAuthProvider | null;
  /**
   * Digest of the operator-managed credential this scope's client is bound to
   * — or, while a connect is still in flight, the one that attempt is using.
   * Null for every other auth shape. Set when the attempt starts rather than
   * when it succeeds, so a rotation that lands mid-connect is seen by the
   * waiter that would otherwise ride the rotated-away key. The value itself is
   * never held here: it lives in the connect attempt's local scope and nowhere
   * else.
   */
  credentialDigest: string | null;
}

/**
 * Proxy a downstream remote MCP server. SDK clients and transports are scoped
 * to one inbound request: reused by calls within a batch/execute_code run, but
 * never carried into a later Cloudflare Worker request. Static-header auth
 * passes headers via requestInit; "oauth" runs the full downstream OAuth flow
 * via KvOAuthProvider.
 *
 * Auth failures degrade the connector to "auth_required" (never crash the
 * server or hide other connectors).
 */
export function remoteMcp(id: string, opts: RemoteMcpOptions): Connector {
  opts = assertKnownOptions(opts, `remoteMcp(${JSON.stringify(id)})`, REMOTE_MCP_OPTIONS);
  if (opts.readOnly !== undefined) READ_ONLY.parse(opts.readOnly, `Connector(${JSON.stringify(id)}).readOnly`);
  if (opts.callAdmission !== undefined)
    CALL_ADMISSION.parse(opts.callAdmission, `remoteMcp(${JSON.stringify(id)}).callAdmission`);
  const extraHeaders = extraResourceHeaders(id, opts);
  const skillsEnabled = opts.skills;
  if (skillsEnabled !== undefined && typeof skillsEnabled !== "boolean") {
    throw new Error(`[connecta] connector "${id}" skills must be a boolean.`);
  }
  const clientMetadataUrl = opts.auth?.type === "oauth" ? opts.auth.clientMetadataUrl : undefined;
  const oauthScope = opts.auth?.type === "oauth" ? opts.auth.scope : undefined;
  assertOAuthScope(id, oauthScope);
  const authorizationParams = authorizationParamsFor(
    opts.auth?.type === "oauth" ? opts.auth.authorizationParams : undefined,
    `remoteMcp(${JSON.stringify(id)}).auth.authorizationParams`,
  );
  const staticClient = opts.auth?.type === "oauth" && opts.auth.client ? { ...opts.auth.client } : undefined;
  assertRemoteOAuthClient(id, staticClient);
  if (staticClient && clientMetadataUrl !== undefined)
    throw new Error(`[connecta] connector "${id}" OAuth client and clientMetadataUrl are mutually exclusive.`);
  if (clientMetadataUrl !== undefined) {
    let valid = false;
    try {
      const url = new URL(clientMetadataUrl);
      valid = url.protocol === "https:" && url.pathname !== "/" && !url.username && !url.password && !url.hash;
    } catch {
      /* Invalid configuration is rejected below without echoing its value. */
    }
    if (!valid)
      throw new Error(
        `[connecta] connector "${id}" clientMetadataUrl must be an HTTPS URL with a non-root path, without credentials or a fragment.`,
      );
  }
  if (opts.authScope === "personal" && opts.auth?.type === "headers") {
    throw new Error(
      `[connecta] connector "${id}" cannot combine authScope "personal" ` +
        "with static headers. Use credential or OAuth auth so each principal " +
        "can own a different grant.",
    );
  }
  // Weak keys ensure a completed request does not leave its SDK client,
  // transport, response bodies, AbortSignals, or connect attempt reachable
  // from the isolate singleton. Those are request-bound in Cloudflare Workers.
  // A closed scope keeps its (emptied) entry, so a late or future lookup finds
  // it closed rather than recreating an ownerless connection under it.
  const states = new WeakMap<object, ConnectionState>();
  // Post-connect auth checks keep the exact provider that bound this client,
  // even if another attempt has since replaced the request scope's state.
  const connectedProviders = new WeakMap<Client, KvOAuthProvider>();
  // Each OAuth transport's early renewal: its bound 401 flow, run before a
  // call sends a token about to expire, owned by that call's signal.
  const earlyRenewals = new WeakMap<Transport, (due: string, signal: AbortSignal | undefined) => Promise<void>>();
  // A connection opened earlier in the request may still hold a replaced
  // token, and one that lives under a minute is due again at once: the
  // invocation's check renews it, and `callTool` sends it while it is unexpired.
  const earlyRenewed = new EarlyRenewals();
  const cacheOwner = {};
  // Listings that must reach the downstream: a credential test proves the
  // stored value against the server, never against a cached catalog.
  const liveListings = new WeakSet<ConnectorContext>();
  // A cached transport may dispatch concurrent calls and listings. Register
  // its actual sent auth with every operation using that client, including
  // handshake/discovery requests and OAuth rotations. Remove settled users.
  const activeContexts = new WeakMap<ConnectionState, Set<ConnectorContext>>();
  // Resource headers are non-secret context by contract. They never join the
  // sent set, so arguments and results equal to them pass unchanged.
  // An argument mirrored as `Mcp-Param-*` carrying a resource value is the
  // same context under a name the tracker may read as credential-shaped.
  const resourceValues = new Set(Object.values(extraHeaders ?? {}));
  const withoutResourceHeaders = (input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined => {
    if (!extraHeaders) return init;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(extraHeaders)) if (headers.get(name) === value) headers.delete(name);
    const mirrored: string[] = [];
    for (const [name, value] of headers)
      if (name.startsWith("mcp-param-") && resourceValues.has(value)) mirrored.push(name);
    for (const name of mirrored) headers.delete(name);
    return { ...init, headers };
  };
  const trackSentRequest = (ctx: ConnectorContext, input: RequestInfo | URL, init?: RequestInit): void => {
    const active = activeContexts.get(entryFor(ctx));
    const recipients = new Set([sentSecretsFor(ctx), ...[...(active ?? [])].map(sentSecretsFor)]);
    const tracked = withoutResourceHeaders(input, init);
    for (const secrets of recipients) {
      if (opts.auth?.type === "oauth") trackRemoteClientRequest(secrets, input, tracked);
      else secrets.request(input, tracked);
    }
  };
  const connectingWaiters = new WeakMap<Deferred.Deferred<Client, unknown>, number>();
  const isOauth = opts.auth?.type === "oauth";
  // Long-lived enough for distinct request scopes in this connector runtime to
  // join one token redemption. It owns no client, transport, or request state.
  const refreshCoordinatorFor = refreshCoordinatorsByPartition();
  const logger = opts.logger ?? console;
  const warnShortSecret = shortSecretWarning();
  warnShortSecret(staticClient?.clientSecret, logger);
  if (opts.auth?.type === "headers") {
    for (const [name, value] of Object.entries(opts.auth.headers)) {
      if (!/key|token|secret|password|auth|signature|session/i.test(name)) continue;
      const basic = /^Basic\s+(.+)$/i.exec(value);
      if (basic) {
        try {
          const decoded = atob(basic[1]!);
          const colon = decoded.indexOf(":");
          if (colon !== -1) warnShortSecret(decoded.slice(colon + 1), logger);
        } catch {
          /* Invalid Basic configuration is not a short password. */
        }
      } else warnShortSecret(value.replace(/^(?:Bearer|token)\s+/i, ""), logger);
    }
  }

  const credentialAuth = opts.auth?.type === "credential" ? opts.auth : undefined;
  if (credentialAuth?.credential?.fields?.length) {
    throw new Error(
      `[connecta] connector "${id}" credential auth declares named fields; ` +
        "this shape sends one secret in one header and reads the reserved " +
        "`value` field only.",
    );
  }
  // Both request shapes, read field by field; a mixture is refused below.
  const requestAuth: RequestAuthFields | undefined = opts.auth?.type === "request" ? opts.auth : undefined;
  // Opt-in only: without it the resolver keeps receiving the context alone.
  // `principal` replaces `token`; a malformed or mixed shape has no resolver.
  const forwarding = requestAuth?.principal;
  const requestToken = forwarding
    ? requestAuth?.token === undefined && (forwarding.accept === "human" || forwarding.accept === "human-or-agent")
      ? forwarding.token
      : undefined
    : requestAuth?.token;
  if (requestAuth && (typeof requestToken !== "function" || opts.authScope === "personal")) {
    throw new Error(`remoteMcp(${JSON.stringify(id)}) requires a request token callback and shared authScope.`);
  }
  const principalPolicy = forwarding?.accept;
  const customFetch = opts.fetch;
  // OAuth discovery, registration and token requests reach authorization
  // servers the downstream names, through the owned credential sender. A
  // custom fetch would split that traffic between two transports.
  if (customFetch !== undefined && (typeof customFetch !== "function" || opts.auth?.type === "oauth")) {
    throw new Error(`remoteMcp(${JSON.stringify(id)}).fetch must be a function, without OAuth auth.`);
  }
  // No delayed dispatch: a write counts as sent once it is handed to the function.
  const customSender: GuardedTransport | undefined = customFetch && { send: customFetch };
  if (requestAuth?.headers) {
    try {
      if (Object.keys(requestAuth.headers).some((name) => name.toLowerCase() === "authorization")) throw new Error();
      new Headers(requestAuth.headers);
    } catch {
      throw new Error(`remoteMcp(${JSON.stringify(id)}) requires valid request auth headers without Authorization.`);
    }
  }
  const credentialConfig: ConnectorCredentialConfig = credentialAuth?.credential ?? {
    label: "API key",
  };
  const credentialHeader = credentialAuth?.header?.trim() || "Authorization";
  // A structural mistake in the deployment file, beside the `fields` refusal
  // above: an unsendable header name is not worth discovering on the first
  // request, where only a runtime error can report it.
  if (credentialAuth && !HEADER_NAME_TOKEN.test(credentialHeader)) {
    throw new Error(
      `[connecta] connector "${id}" credential auth declares header ` +
        `"${credentialHeader}", which is not a valid HTTP field name.`,
    );
  }
  // `undefined` means "not stated" and takes the bearer default; `null` and
  // `""` both mean "send the stored value verbatim", which some providers
  // require for a bare API key.
  const credentialScheme =
    credentialAuth === undefined || credentialAuth.scheme === undefined
      ? "Bearer"
      : (credentialAuth.scheme?.trim() ?? "") || null;

  // Check the destination scheme once at construction: buildTransport (and the
  // SDK's fetch) attach any static credentials to every request, so an http://
  // endpoint sends bearer tokens / API keys in cleartext. Loopback is exempt
  // for local development.
  const destination = new URL(opts.url);
  // Only a web URL reaches a remote MCP server. Another scheme cannot, and a
  // wrapping one (`blob:https://…`) would also carry its inner URL, userinfo
  // and all, into every place the endpoint is reported; the value is not echoed.
  if (destination.protocol !== "https:" && destination.protocol !== "http:") {
    throw new Error(`[connecta] connector "${id}" url must be an http(s) URL.`);
  }
  const insecureDestination = destination.protocol !== "https:" && !isLoopbackHost(destination.hostname);
  if (insecureDestination) {
    if (opts.requireHttps || requestAuth) {
      throw new Error(
        `[connecta] connector "${id}" url ${opts.url} is not https:// (and not loopback) — refusing to connect (requireHttps).`,
      );
    }
    // Both static shapes send a secret on every request; that an operator
    // typed one into the operator UI rather than a deployment file changes
    // who owns it, not whether the wire carries it in the clear.
    if (opts.auth?.type === "headers" || credentialAuth) {
      logger.warn(
        `[connecta] connector "${id}" sends static credentials to ${opts.url} over a non-https:// connection — those tokens will be transmitted in cleartext.`,
      );
    }
  }

  /**
   * Typed per-call auth signal. The `UnauthorizedError` behind it is not kept
   * as cause: the class is the whole verdict, and a logger rendering the
   * chain would render whatever text the error carried.
   */
  const authRequiredError = () =>
    new ConnectorCallError(
      isOauth ? "downstream_oauth_required" : "auth_required",
      `Connector "${id}" requires authorization — call authorize_connector({ connector: "${id}" }) and open the returned URL.`,
    );

  /**
   * Tell a failure of one OAuth flow in connecta's words.
   *
   * The SDK builds these errors from what a downstream or its authorization
   * server sent: a refused registration quotes the response body whole, an
   * issuer mismatch quotes the issuers, a discovery failure the URL or the
   * metadata it could not accept. Any of them can echo what the request
   * carried, or text the server planted for an agent to read. What survives
   * is the step and host of the flow's last request, the classification, and
   * for a registration the status and a registered OAuth error code.
   * Anything not already in connecta's words is withheld, including a store's
   * error while the flow saves what it discovered, which can quote it.
   */
  const withoutAuthorizationServerText = authMethod(
    (ctx: ConnectorContext, err: unknown, trail: OAuthTrail, signals: readonly (AbortSignal | undefined)[]) =>
      authFlow<unknown>(function* () {
        const safeOrigin = authMethod((host: string | undefined) =>
          authFlow<string | undefined>(function* () {
            if (!host || sentSecretsFor(ctx).contains(host, true)) return undefined;
            if (host === destination.origin || (staticClient && host === new URL(staticClient.issuer).origin))
              return host;
            try {
              return host === ((yield authInvoke(newProvider(ctx), "validatedIssuerOrigin", [])) as string | undefined)
                ? host
                : undefined;
            } catch {
              return undefined;
            }
          }),
        );
        if (ownAbortReason(err, signals) && !hasSdkPayload(err)) return err;
        if (err instanceof RegistrationRejectedError) {
          const code = registrationErrorCode(err.body);
          const origin = (yield authCall(safeOrigin, [trail.registration])) as string | undefined;
          const facts = {
            step: "OAuth client registration" as const,
            ...(origin ? { origin } : {}),
            httpStatus: err.status,
            ...(code ? { oauthError: code } : {}),
          };
          return attachFailureFacts(
            carryFailureFacts(
              err,
              resendAdvice(
                withheldAs(
                  `Connector "${id}" could not register an OAuth client with ` +
                    `${origin ?? "its authorization server"}: the ` +
                    `registration endpoint answered HTTP ${err.status}` +
                    `${code ? ` with OAuth error ${code}` : ""}. Its response is ` +
                    "withheld because it can quote the request or anything the server " +
                    "chose to add. Check the server's client registration policy.",
                  downstreamCallError(err, undefined, trail.last?.retryAfterMs),
                ),
                ", then retry authorization",
              ),
            ),
            facts,
          );
        }
        const leg = trail.last;
        const origin = (yield authCall(safeOrigin, [leg?.host])) as string | undefined;
        const facts = leg
          ? {
              step: `OAuth ${leg.step}` as const,
              ...(origin ? { origin } : {}),
              ...(leg.httpStatus ? { httpStatus: leg.httpStatus } : {}),
            }
          : { step: "OAuth flow" as const };
        if (err instanceof UnauthorizedError || err instanceof ConnectorCallError || err instanceof WithheldTextError) {
          return attachFailureFacts(downstreamCallError(err), facts);
        }
        const classified = downstreamCallError(err, leg?.httpStatus, leg?.retryAfterMs, leg?.step);
        if (
          err instanceof OAuthError ||
          (classified instanceof ConnectorCallError && classified.code === "provider_permission_denied")
        ) {
          return attachFailureFacts(carryFailureFacts(err, classified), facts);
        }
        return attachFailureFacts(
          carryFailureFacts(
            err,
            resendAdvice(
              withheldAs(
                `Connector "${id}" OAuth ${leg ? `${leg.step}${origin ? ` with ${origin}` : ""}` : "flow"} ` +
                  `failed${errorKind(err)}. The error is withheld because its text can ` +
                  "quote what the server sent. Check the server's OAuth metadata.",
                classified,
              ),
              ", then retry authorization",
            ),
          ),
          facts,
        );
      }),
  );

  const endpointOrigin = new URL(opts.url).origin;

  /**
   * The MCP boundary, where an error leaves the SDK at the handshake, a
   * `tools/list` page, or a `tools/call`. The request's own abort reason
   * passes first, by identity, then what `keepsItsText` allows. Anything else
   * (a parser's or validator's account, a non-4xx body, a runtime's message)
   * is told as the step, the endpoint's origin, the HTTP status if there was
   * one, and the error's class, classified as `verdict` would have been.
   */
  const atMcpBoundary = (
    ctx: ConnectorContext,
    err: unknown,
    step: "MCP handshake" | "tools/list" | "tools/call" | "skills/list" | "resources/read",
    transport: Transport | undefined,
    signals: readonly (AbortSignal | undefined)[],
  ): unknown => {
    // An OAuth flow already attached the step and origin it failed at. The
    // outer MCP operation must not replace them with the endpoint's facts.
    if (failureRecord({}, err).step?.startsWith("OAuth ")) return downstreamCallError(err);
    const httpStatus = err instanceof SdkHttpError ? err.status : undefined;
    // Skills operations retain the existing closed operator-record vocabulary.
    const facts = {
      ...(step === "skills/list" || step === "resources/read" ? {} : { step }),
      origin: endpointOrigin,
      ...(httpStatus ? { httpStatus } : {}),
    };
    const classified = downstreamCallError(
      redactSentSecrets(ctx, err),
      undefined,
      undefined,
      undefined,
      requestSentSecrets(ctx),
    );
    const verdict =
      isOauth && classified instanceof ConnectorCallError && classified.code === "auth_required"
        ? carryFailureFacts(err, authRequiredError())
        : classified;
    if (ownAbortReasonAsSdkReports(err, signals)) {
      return attachFailureFacts(carryFailureFacts(err, withheldAs(msg(err), verdict)), facts);
    }
    if (err instanceof InsufficientScopeError) {
      return attachFailureFacts(carryFailureFacts(err, verdict), facts);
    }
    if (requestAuth && httpStatus === 401) {
      return attachFailureFacts(
        new ConnectorCallError("auth_required", "The downstream rejected this request's Bearer token."),
        facts,
      );
    }
    if (ownAbortReason(err, signals) || keepsItsText(err, transport)) {
      return attachFailureFacts(
        carryFailureFacts(
          err,
          redactSentSecrets(
            ctx,
            err instanceof UnauthorizedError || (ownAbortReason(err, signals) && !hasSdkPayload(err)) ? err : verdict,
          ),
        ),
        facts,
      );
    }
    // The SDK wraps a failure of connecta's own fetch (a refused redirect, an
    // unreachable host) in an error of its own, such as the version probe's;
    // that failure's words are connecta's, and they say what happened.
    const ours = connectaErrorWithin(err);
    if (ours) {
      return attachFailureFacts(carryFailureFacts(ours, withheldAs(ours.message, ours)), facts);
    }
    const status = httpStatus ? ` with HTTP ${httpStatus}` : "";
    return attachFailureFacts(
      carryFailureFacts(
        err,
        withheldAs(
          `Connector "${id}" ${step} with ${endpointOrigin} failed${status}` +
            `${errorKind(err)}${sdkCheckFailed(err)}. The error is withheld because ` +
            "its text can quote what the server sent.",
          verdict,
        ),
      ),
      facts,
    );
  };

  /**
   * Run every OAuth flow the SDK starts on `transport` inside a boundary of
   * its own: a trail only that flow's requests write to, and
   * `withoutAuthorizationServerText` on whatever the flow throws. Calls on
   * one client can each start a flow at once, so no flow's failure is ever
   * told by another flow's last request.
   *
   * Pinned against `@modelcontextprotocol/client` 2.3.1, whose transport
   * offers no public seam for this. A flow starts in exactly two places, each
   * handing `auth()` the fetch to use: the adapted provider's
   * `onUnauthorized` (a 401, at connect or on a live client), given the fetch
   * in its context, and `_stepUpAuthorize` (a 403 `insufficient_scope`),
   * which reads `this._fetchWithInit`. The callback's code exchange runs
   * outside both, and the callback route repeats nothing it throws. If an
   * upgrade moves either seam, this refuses to build the transport rather
   * than run flows unbounded.
   */
  const boundOAuthFlows = (
    ctx: ConnectorContext,
    transport: StreamableHTTPClientTransport,
    endpoint: URL,
    /** The request's and connection's signals: only their reasons pass as written. */
    signals: readonly (AbortSignal | undefined)[],
    renewalSignal: (response: Response) => AbortSignal | undefined,
  ): void => {
    type FlowContext = { response: Response; fetchFn?: FetchLike } & Record<string, unknown>;
    const internals = transport as unknown as {
      _authProvider?: { onUnauthorized?: (ctx: FlowContext) => Promise<void> };
      _stepUpAuthorize?: (challenge: unknown, retries: number) => Promise<unknown>;
      _fetchWithInit?: FetchLike;
    };
    const adapted = internals._authProvider;
    const onUnauthorized = adapted?.onUnauthorized;
    const stepUp = internals._stepUpAuthorize;
    if (!adapted || typeof onUnauthorized !== "function" || typeof stepUp !== "function") {
      // Its own class, so that a status record, which carries no message, says so.
      throw new UnboundOAuthFlowsError(
        `[connecta] connector "${id}": the MCP client's transport no longer ` +
          "has the OAuth flow seams this release is pinned against, so its " +
          "flows cannot be bounded. Pin @modelcontextprotocol/client to the " +
          "version this release ships with.",
      );
    }
    const flow = authMethod(
      <T>(start: (trace: (fetchFn: FetchLike) => FetchLike) => Promise<T>, signal?: AbortSignal) =>
        authFlow<T>(function* () {
          const trail: OAuthTrail = {};
          try {
            return (yield authCall(start, [
              (fetchFn: FetchLike) =>
                tracedOAuthFetch(
                  trail,
                  endpoint,
                  authMethod((input: string | URL, init: RequestInit | undefined) =>
                    authFlow<Response>(function* () {
                      trackSentRequest(ctx, input, init);
                      return (yield authCall(fetchFn, [
                        input,
                        signal
                          ? {
                              ...init,
                              signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                            }
                          : init,
                      ])) as Response;
                    }),
                  ),
                ),
            ])) as Awaited<T>;
          } catch (err) {
            throw (yield authCall(withoutAuthorizationServerText, [ctx, err, trail, [...signals, signal]])) as unknown;
          }
        }),
    );
    adapted.onUnauthorized = authMethod(
      (ctx: FlowContext) =>
        authCall(flow, [
          authMethod((trace: (fetchFn: FetchLike) => FetchLike) =>
            authFlow<void>(function* () {
              // This seam receives every 401, during status, starts, and live
              // calls. Use the SDK's parser so the check covers exactly the
              // challenged URL it would honor. The provider separately drops
              // foreign cached resource metadata on every SDK discovery read,
              // including callbacks and flows without a challenge.
              const { resourceMetadataUrl } = extractWWWAuthenticateParams(ctx.response);
              if (resourceMetadataUrl && resourceMetadataUrl.origin !== destination.origin) {
                throw new RemoteMcpDestinationError(
                  id,
                  "resource metadata outside the configured resource origin is not allowed",
                );
              }
              yield authInvoke(Reflect, "apply", [
                onUnauthorized,
                adapted,
                [{ ...ctx, fetchFn: trace(ctx.fetchFn ?? fetch) }],
              ]);
            }),
          ),
          renewalSignal(ctx.response),
        ]) as Effect.Effect<void, unknown>,
    );
    internals._stepUpAuthorize = authMethod(
      (challenge: unknown, retries: number) =>
        authCall(flow, [
          authMethod((trace: (fetchFn: FetchLike) => FetchLike) =>
            authFlow<unknown>(function* () {
              const traced = trace(internals._fetchWithInit ?? fetch);
              const self = new Proxy(transport, {
                get: (target: StreamableHTTPClientTransport, key: string | symbol) =>
                  key === "_fetchWithInit" ? traced : Reflect.get(target, key, target),
                set: (target: StreamableHTTPClientTransport, key: string | symbol, value: any) =>
                  Reflect.set(target, key, value, target),
              });
              return (yield authInvoke(Reflect, "apply", [stepUp, self, [challenge, retries]])) as unknown;
            }),
          ),
        ]) as Effect.Effect<unknown, unknown>,
    );
  };

  class OperatorDisconnectedError extends ConnectorCallError {
    constructor() {
      super(
        "downstream_oauth_required",
        `Connector "${id}" was disconnected by an operator — explicitly start authorization to reconnect it.`,
      );
    }
  }
  const operatorDisconnectedError = () => new OperatorDisconnectedError();

  /**
   * The credential slot is declared but the vault has nothing in it (or has no
   * key to read it with). Deliberately the same `auth_required` code an absent
   * OAuth grant produces: the agent's next move is `authorize_connector`
   * either way, and that tool reads `connector.credential` to hand the
   * operator the connection in the UI when available instead of a consent URL.
   */
  class CredentialRequiredError extends ConnectorCallError {
    constructor(message: string) {
      super("auth_required", message);
    }
  }

  /**
   * A request resolver threw something untyped. Calls still fail with
   * `auth_required`, but status reports an error: the resolver's own outage
   * is not an authorization the operator can grant.
   */
  class UnresolvedTokenError extends ConnectorCallError {
    constructor() {
      super("auth_required", "The request token could not be resolved.");
    }
  }

  /**
   * Read this request's credential. Called before every connect and before
   * trusting any cached client, so an operator's replacement is picked up
   * without a redeploy. The value stays in the caller's local scope.
   */
  const readCredential = authMethod((ctx: ConnectorContext, principal?: RequestPrincipal) =>
    authFlow<string>(function* () {
      if (requestAuth) {
        let value: string;
        try {
          // A fresh frozen input per resolution: one resolver cannot alter another's.
          value = (yield authInvoke(
            forwarding ?? requestAuth,
            "token",
            principal ? [ctx, Object.freeze({ principal })] : [ctx],
          )) as string;
        } catch (error) {
          if (error instanceof ConnectorCallError) throw error;
          throw new UnresolvedTokenError();
        }
        ctx.signal?.throwIfAborted();
        if (
          typeof value !== "string" ||
          !value.trim() ||
          Array.from(value).some((char: string) => {
            const code = char.charCodeAt(0);
            return code <= 32 || (code >= 127 && code <= 159);
          })
        ) {
          throw new ConnectorCallError(
            "auth_required",
            "The request token is empty or cannot be sent as a Bearer header.",
          );
        }
        return value;
      }
      if (!ctx.credential) {
        throw new CredentialRequiredError(
          `Connector "${id}" needs an operator-managed credential, but ` +
            "credential storage is not configured. Configure vault in deployment code and redeploy. Call authorize_connector for recovery options.",
        );
      }
      const value = ((yield authInvoke(ctx.credential, "get", [])) as string | null)?.trim();
      if (!value) {
        throw new CredentialRequiredError(
          `Connector "${id}" has no stored credential — call ` +
            `authorize_connector({ connector: "${id}" }) and follow the ` +
            "operator handoff it returns.",
        );
      }
      if (carriesIllegalHeaderChar(value)) {
        throw new CredentialRequiredError(
          `Connector "${id}"'s stored credential contains a character a header ` +
            "cannot carry (a line break or other control character). Call " +
            "authorize_connector for recovery options. When available, re-enter " +
            "it in this connection in the operator UI. The value is not shown or logged.",
        );
      }
      return value;
    }),
  );

  /**
   * Replace, never edit.
   *
   * Any error whose message quotes the credential — the raw value or the
   * framed header it becomes — is discarded whole and replaced with a fixed
   * sentence. Nothing is substringed, masked, or truncated out of the original:
   * a redaction that keeps part of a secret is still a leak, and the original
   * error is not worth one. This is defense in depth behind the validation
   * above, which is what keeps an unsendable value from reaching a transport
   * at all.
   */
  const withoutCredential = (err: unknown, ...secrets: (string | null)[]): unknown => {
    const quoted = secrets.filter((secret): secret is string => typeof secret === "string" && secret !== "");
    if (quoted.length === 0) return err;
    const seen = new Set<unknown>();
    let current: unknown = err;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      // Decided already, beneath the transport, and wrapped by the SDK on
      // the way up (the version probe's error, say).
      if (current instanceof CredentialRequiredError) return current;
      if (quoted.some((secret) => current instanceof Error && current.message.includes(secret))) {
        return new CredentialRequiredError(
          `Connector "${id}" could not send its stored credential as a ` +
            "header. Call authorize_connector for recovery options. When available, " +
            "re-enter it in this connection in the operator UI. " +
            "The value is not shown or logged.",
        );
      }
      current = current.cause;
    }
    return err;
  };

  // Its own class, so that a status record, which carries no message, still says so.
  const scopeEndedError = () => new ScopeEndedError(`Connector "${id}" scope ended during connection.`);

  const requestOptions = (ctx: ConnectorContext) =>
    ctx.timeoutMs || ctx.signal
      ? {
          ...(ctx.timeoutMs ? { timeout: ctx.timeoutMs } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }
      : undefined;

  /** Wrap the public request seam, before listTools aggregates or auto-caches.
   * SDK 2.3.1 treats an identical repeated page as completion. Refuse it here:
   * an advertised successor is never proof of a complete catalog (INV-8). */
  const listingContexts = new WeakMap<RequestOptions, ConnectorContext>();
  const installCatalogIntake = (
    client: Client,
    ctx: ConnectorContext,
    cache: Awaited<ReturnType<typeof catalogClientOptions>>,
  ): void => {
    let toolPages = 0;
    const listingContext = (options?: RequestOptions) => {
      const { signal: _signal, timeoutMs: _timeout, ...base } = ctx;
      return (
        (options && listingContexts.get(options)) ?? {
          ...base,
          requestScope: ctx.requestScope ?? ctx,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
        }
      );
    };
    const listTools = client.listTools.bind(client);
    client.listTools = authMethod(
      (
        params:
          | {
              _meta?:
                | {
                    [x: string]: unknown;
                    progressToken?: string | number | undefined;
                    "io.modelcontextprotocol/related-task"?:
                      | {
                          taskId: string;
                        }
                      | undefined;
                  }
                | undefined;
              cursor?: string | undefined;
            }
          | undefined,
        options: CacheableRequestOptions | undefined,
      ) =>
        authInvoke(cache, "withListing", [
          listingContext(options),
          authMethod(() =>
            authFlow<ListToolsResult>(function* () {
              const before = toolPages;
              let result: ListToolsResult;
              try {
                result = (yield authCall(listTools, [params, options])) as ListToolsResult;
              } catch (error) {
                const bounded = atMcpBoundary(cache.currentContext(), error, "tools/list", client.transport, [
                  cache.currentContext().signal,
                ]);
                const transient =
                  (error instanceof SdkHttpError && [502, 503, 504].includes(error.status)) ||
                  (bounded instanceof ConnectorCallError && bounded.code === "unavailable");
                const fallback =
                  transient && toolPages === before
                    ? ((yield authInvoke(cache, "fallbackTools", [])) as ListToolsResult | undefined)
                    : undefined;
                if (!fallback) throw error;
                return fallback;
              }
              if (toolPages !== before && params?.cursor === undefined) {
                const refresh = (yield authInvoke(cache, "completeCatalogRefresh", [result])) as
                  | CompletedCatalogRefresh
                  | undefined;
                if (refresh) {
                  try {
                    (yield authCall(observeCompletedCatalogRefresh, [cache.currentContext(), refresh])) as void;
                  } catch (error) {
                    logFailure(
                      cache.currentContext().logger,
                      "catalog refresh observation failed",
                      failureRecord({ connector: id }, error),
                    );
                  }
                }
              }
              return result;
            }),
          ),
        ]) as Effect.Effect<ListToolsResult, unknown>,
    );
    const listResources = client.listResources.bind(client);
    client.listResources = authMethod(
      (
        params:
          | {
              _meta?:
                | {
                    [x: string]: unknown;
                    progressToken?: string | number | undefined;
                    "io.modelcontextprotocol/related-task"?:
                      | {
                          taskId: string;
                        }
                      | undefined;
                  }
                | undefined;
              cursor?: string | undefined;
            }
          | undefined,
        options: CacheableRequestOptions | undefined,
      ) =>
        authInvoke(cache, "withListing", [
          listingContext(options),
          authMethod(() => authCall(listResources, [params, options]) as Effect.Effect<ListResourcesResult, unknown>),
        ]) as Effect.Effect<ListResourcesResult, unknown>,
    );
    const listResourceTemplates = client.listResourceTemplates.bind(client);
    client.listResourceTemplates = authMethod(
      (
        params:
          | {
              _meta?:
                | {
                    [x: string]: unknown;
                    progressToken?: string | number | undefined;
                    "io.modelcontextprotocol/related-task"?:
                      | {
                          taskId: string;
                        }
                      | undefined;
                  }
                | undefined;
              cursor?: string | undefined;
            }
          | undefined,
        options: CacheableRequestOptions | undefined,
      ) =>
        authInvoke(cache, "withListing", [
          listingContext(options),
          authMethod(
            () =>
              authCall(listResourceTemplates, [params, options]) as Effect.Effect<ListResourceTemplatesResult, unknown>,
          ),
        ]) as Effect.Effect<ListResourceTemplatesResult, unknown>,
    );
    const request = client.request.bind(client);
    const walks = new WeakMap<
      object,
      {
        names: Set<string>;
        cursors: Set<string>;
        barren: number;
        bytes: number;
        first?: CatalogResult & { ttlMs: number; cacheScope: "public" | "private" };
      }
    >();
    client.request = authMethod((...args: unknown[]) =>
      authFlow<any>(function* () {
        const message = args[0] as {
          method: string;
          params?: {
            cursor?: string;
          };
        };
        if (
          message.method !== "tools/list" &&
          message.method !== "resources/list" &&
          message.method !== "resources/templates/list"
        )
          return yield authCall(request, args, client);
        const method: CatalogMethod = message.method;
        const ctx = cache.currentContext();
        const options = (args.length === 3 ? args[2] : args[1]) as RequestOptions | undefined;
        if (isClosed(entryFor(ctx))) throw scopeEndedError();
        if (options?.signal?.aborted) throw options.signal.reason;
        const key = options ?? message;
        let walk = walks.get(key);
        if (message.params?.cursor === undefined || !walk) {
          walk = { names: new Set(), cursors: new Set(), barren: 0, bytes: 0 };
          walks.set(key, walk);
        }
        let page: CatalogResult;
        try {
          page = (yield authCall(request, [
            message as Parameters<Client["request"]>[0],
            method === "tools/list"
              ? CompatibleListToolsResultSchema
              : method === "resources/list"
                ? specTypeSchemas.ListResourcesResult
                : specTypeSchemas.ListResourceTemplatesResult,
            options,
          ])) as ListToolsResult | ListResourcesResult | ListResourceTemplatesResult;
        } catch (error) {
          if (isCursorShapeError(error))
            throw new ConnectorCallError(
              "connector_call_failed",
              "Downstream catalog nextCursor must be a string, null, or absent.",
              { retryable: false },
            );
          throw error;
        }
        assertDownstreamOutputSafe(ctx.requestScope ?? ctx, page);
        const clean = cache.intake(ctx, method, page);
        if (method === "tools/list") toolPages++;
        if (message.params?.cursor === undefined) observeCatalogFetch(ctx, Date.now(), method);
        const tools = catalogItems(method, clean).filter(
          (
            item:
              | Tool
              | ListResourcesResult["resources"][number]
              | {
                  uriTemplate: string;
                  name: string;
                  description?: string | undefined;
                  mimeType?: string | undefined;
                  annotations?:
                    | {
                        audience?: ("user" | "assistant")[] | undefined;
                        priority?: number | undefined;
                        lastModified?: string | undefined;
                      }
                    | undefined;
                  _meta?:
                    | {
                        [x: string]: unknown;
                      }
                    | undefined;
                  icons?:
                    | {
                        src: string;
                        mimeType?: string | undefined;
                        sizes?: string[] | undefined;
                        theme?: "light" | "dark" | undefined;
                      }[]
                    | undefined;
                  title?: string | undefined;
                },
          ) => {
            const name =
              method === "tools/list"
                ? item.name
                : method === "resources/list"
                  ? (
                      item as {
                        uri: string;
                      }
                    ).uri
                  : (
                      item as {
                        uriTemplate: string;
                      }
                    ).uriTemplate;
            if (walk.names.has(name)) return false;
            walk.names.add(name);
            return true;
          },
        );
        walk.bytes += new TextEncoder().encode(JSON.stringify(tools)).byteLength;
        if (walk.names.size > MAX_CATALOG_TOOLS || walk.bytes > MAX_SERIALIZED_CATALOG_BYTES) {
          throw new ConnectorCallError(
            "connector_call_failed",
            "Downstream catalog exceeds the complete-catalog ceiling.",
            { retryable: false },
          );
        }
        if (clean.nextCursor !== undefined) {
          if (walk.cursors.has(clean.nextCursor))
            throw new ConnectorCallError("connector_call_failed", "Downstream catalog pagination chain loops.", {
              retryable: false,
            });
          if (tools.length === 0 && ++walk.barren > 1)
            throw new ConnectorCallError("connector_call_failed", "Downstream catalog pagination is not advancing.", {
              retryable: false,
            });
          if (tools.length > 0) walk.barren = 0;
          walk.cursors.add(clean.nextCursor);
        }
        const field =
          method === "tools/list" ? "tools" : method === "resources/list" ? "resources" : "resourceTemplates";
        const result = { ...clean, [field]: tools };
        if (!walk.first) walk.first = result;
        else {
          walk.first.ttlMs = Math.min(walk.first.ttlMs, clean.ttlMs);
          if (clean.cacheScope !== "public") walk.first.cacheScope = "private";
        }
        observeCatalogExpiry(ctx, method, walk.first.ttlMs);
        return result;
      }),
    ) as Client["request"];
  };

  /** This request scope's entry, open or closed, created on first sight. */
  const entryFor = (ctx: ConnectorContext): ConnectionState => {
    const owner = Context.get(viewServices(ctx), RequestScope);
    const key = owner;
    let state = states.get(key);
    if (!state) {
      state = {
        scope: Scope.makeUnsafe(),
        lease: null,
        client: null,
        transport: null,
        toolDefinitions: new Map(),
        dispatches: new Map(),
        connecting: null,
        authRequired: false,
        provider: null,
        connectedGeneration: null,
        attemptProvider: null,
        credentialDigest: null,
      };
      states.set(key, state);
      const owned = state;
      owner.own(() => {
        const closing = Scope.closeUnsafe(owned.scope, Exit.void);
        reset(owned);
        if (closing) detach(closing);
      });
    }
    return state;
  };

  const isClosed = (state: ConnectionState): boolean => state.scope.state._tag === "Closed";

  const stateFor = (ctx: ConnectorContext): ConnectionState => {
    const state = entryFor(ctx);
    if (isClosed(state)) throw scopeEndedError();
    return state;
  };

  const newProvider = (
    ctx: ConnectorContext,
    state?: ConnectionState,
    signal: AbortSignal | undefined = viewSignal(ctx, true),
  ): KvOAuthProvider => {
    if (state?.provider) return state.provider;
    const metadataUrl = staticClient ? undefined : (clientMetadataUrl ?? selfHostedClientUrl(ctx.publicUrl, id));
    const redirectUri = downstreamRedirectUri(ctx.baseUrl, ctx.publicUrl, id);
    const provider = new KvOAuthProvider(
      id,
      ctx.storage,
      redirectUri,
      refreshCoordinatorFor(ctx),
      ctx.allowAuthorization === true,
      oauthSealerFor(ctx),
      signal,
      JSON.stringify({
        url: new URL(opts.url).href,
        redirectUri,
        clientMetadata: downstreamClientMetadata(
          redirectUri,
          oauthScope,
          ctx.oauthClientName,
          staticClient ? remoteClientAuthMethod(staticClient) : "none",
        ),
        ...(authorizationParams.length ? { authorizationParams } : {}),
        authScope: opts.authScope ?? "shared",
        versionNegotiation: opts.versionNegotiation ?? "auto",
        redirects: opts.redirects ?? "none",
        clientMetadataUrl: metadataUrl,
        ...(staticClient
          ? {
              client: {
                issuer: staticClient.issuer,
                clientId: staticClient.clientId,
                tokenEndpointAuthMethod: staticClient.tokenEndpointAuthMethod,
              },
            }
          : {}),
      }),
      (reset) => trackOAuthStartReset(ctx.requestScope ?? ctx, reset),
      metadataUrl,
      oauthScope,
      undefined,
      {
        name: ctx.oauthClientName,
        client: staticClient,
        secrets: sentSecretsFor(ctx),
        authorizationParams,
        resourceOrigin: destination.origin,
      },
    );
    if (state) state.provider = provider;
    return provider;
  };

  const buildTransport = (
    ctx: ConnectorContext,
    provider: KvOAuthProvider | null,
    /**
     * This attempt's assembled header value, for credential auth only — framed
     * by the caller so the raw secret is not passed around twice. Never
     * retained past the transport it configures.
     */
    credentialFramed: string | null = null,
    signal: AbortSignal | undefined = viewSignal(ctx, true),
    /** The raw value behind `credentialFramed`, under the same terms. */
    credentialValue: string | null = null,
    /** A code exchange never transfers ownership to the refresh coordinator. */
    exchangeOnly = false,
    /** The admitted principal `credentialValue` was resolved for, under the same terms. */
    principal: RequestPrincipal | undefined = undefined,
  ): Transport => {
    const resourceInit = (input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined => {
      if (!extraHeaders) return init;
      const target = new URL(input instanceof Request ? input.url : String(input));
      const resource = new URL(opts.url);
      if (target.origin !== resource.origin || target.pathname !== resource.pathname) return init;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
      return { ...init, headers };
    };
    const responseOwner = Context.get(viewServices(ctx), RequestScope);
    const initiatingSignal = ctx.signal;
    ctx = deriveContext(operationContext(ctx), signal ? { signal } : {});
    if (opts._transportFactory) return opts._transportFactory(ctx);
    const url = new URL(opts.url);
    // Missing records never acquire a fresh write attempt. Only active calls
    // for this exact tool, all classified read, can prove a recordless message
    // safe. Catalog hints alone cannot prove the invocation's served verdict.
    const untrackedRead = (params: unknown): boolean => {
      if (!skillObject(params) || typeof params.name !== "string") return false;
      let read = false;
      for (const [dispatch, name] of entryFor(ctx).dispatches) {
        if (name !== params.name) continue;
        if (dispatch.write) return false;
        read = true;
      }
      return read;
    };
    // This transport's calls on the wire, by JSON-RPC id, while each is sent.
    const flights = new Map<string | number, CallDispatch>();
    const trackedFetch: FetchLike = authMethod((input: string | URL, init: RequestInit | undefined) =>
      authFlow<Response>(function* () {
        let rpc: unknown;
        if (typeof init?.body === "string") {
          try {
            rpc = JSON.parse(init.body);
          } catch {}
        }
        const toolCall = init?.method === "POST" && skillObject(rpc) && rpc.method === "tools/call" ? rpc : undefined;
        const writeContinuation = downstreamWriteContinuation(ctx.requestScope ?? ctx) && toolCall !== undefined;
        const flight =
          toolCall && (typeof toolCall.id === "string" || typeof toolCall.id === "number")
            ? flights.get(toolCall.id)
            : undefined;
        if (toolCall && !flight && !untrackedRead(toolCall.params)) throw missingDispatch();
        const credentialPost =
          isOauth && (init?.method ?? "GET").toUpperCase() === "POST" && (!skillObject(rpc) || rpc.jsonrpc !== "2.0");
        // A custom transport reaches only the configured origin; redirects are
        // already same-origin, and OAuth cannot be combined with it.
        if (customFetch && new URL(input instanceof Request ? input.url : String(input)).origin !== destination.origin)
          throw new ConnectorCallError(
            "connector_call_failed",
            `Connector "${id}" refused a request outside its origin; nothing was sent.`,
            { retryable: false },
          );
        // The deployment's fetch owns the wire: each write is handed over once.
        const sender = flight?.write ? (customSender ?? guardedTransport(true)) : undefined;
        if (flight?.write) {
          if (flight.sent) {
            if (flight.request && flight.authorization)
              renewedAfterUnauthorized(
                flight.request.entry,
                flight.authorization,
                new Headers(init?.headers).get("authorization") ?? flight.authorization,
              );
            throw resendRefused(flight);
          }
          flight.authorization = new Headers(init?.headers).get("authorization");
        }
        const request = flight?.request;
        if (request?.entry.dispatched)
          request.entry = providerRequest(request.ctx, !flight?.write, request.entry.provider, {
            method: init?.method ?? "GET",
          });
        const entry = request?.entry;
        const dispatch = () => {
          if (flight?.write) {
            if (flight.sent) throw resendRefused(flight);
            flight.sent = true;
          }
          if (request && entry) {
            if (flight?.sourceWrite) recordRequestField(entry, "sourceWrite", true);
            dispatchProviderRequest(request.ctx, entry, init?.headers, init?.method ?? "GET");
          }
        };
        trackSentRequest(ctx, input, init);
        // Attach retained settlement facts at the physical Promise leaf.
        // Cancellation may end the native waiter before it resumes; neither
        // the status nor a 401 verdict may disappear with that live authority.
        const response = (yield authValue(() => {
          const pending = credentialPost
            ? sendCredentialPost(input, init ?? {}, dispatch)
            : sender
              ? sendGuarded(
                  sender,
                  new URL(input instanceof Request ? input.url : String(input)),
                  { ...init, redirect: "manual" },
                  dispatch,
                )
              : (() => {
                  dispatch();
                  const send = customFetch ?? fetch;
                  return writeContinuation ? send(input, { ...init, redirect: "manual" }) : send(input, init);
                })();
          return pending.then((response) => {
            // RPC fetch adapters can return a disposable Response. Own it at
            // the physical Promise leaf, including a late answer after close,
            // and keep its body live until the existing request boundary.
            const dispose = (response as Response & Partial<Disposable>)[Symbol.dispose];
            if (dispose) responseOwner.own(() => dispose.call(response));
            if (entry) recordProviderResponse(entry, response.status);
            if (flight?.write) {
              if (response.status === 401) flight.unauthorized = true;
              else if (REDIRECT_STATUSES.has(response.status)) flight.redirected = true;
            }
            if (init?.signal?.aborted || request?.ctx.signal?.aborted) void response.body?.cancel().catch(() => {});
            return response;
          });
        })) as Response;
        if (response.status === 401 && requestToken?.invalidate && credentialValue !== null) {
          // Invalidate the exact bytes this transport sent, never a newer token.
          // Preserve the original 401 even if an operator hook fails. No replay.
          (yield authCatch(
            authInvoke(
              requestToken,
              "invalidate",
              principal ? [credentialValue, ctx, Object.freeze({ principal })] : [credentialValue, ctx],
            ),
            () => {},
          )) as void;
        }
        if (credentialPost && !isOAuthCredentialRequest(init) && REDIRECT_STATUSES.has(response.status)) {
          (yield authCatch(
            authValue(() => response.body?.cancel()),
            () => {},
          )) as void | undefined;
          throw new ConnectorCallError(
            "connector_call_failed",
            "OAuth registration endpoint redirected; the request was not repeated.",
            { retryable: false },
          );
        }
        if (writeContinuation && (response.status === 401 || (response.status >= 300 && response.status < 400))) {
          (yield authCatch(
            authValue(() => response.body?.cancel()),
            () => {},
          )) as void | undefined;
          if (response.status === 401) throw authRequiredError();
          throw new ConnectorCallError(
            "connector_call_failed",
            "The downstream redirected a write continuation; it was not repeated.",
            { retryable: false, writeOutcome: "unknown" },
          );
        }
        if (flight?.redirected) {
          (yield authCatch(
            authValue(() => response.body?.cancel()),
            () => {},
          )) as void | undefined;
          throw new ConnectorCallError(
            "connector_call_failed",
            "The downstream answered this write with a redirect; it was not sent again.",
            { retryable: false, writeOutcome: "unknown" },
          );
        }
        if (skillsEnabled && skillObject(rpc) && (rpc.method === "skills/list" || rpc.method === "resources/read")) {
          return (yield authCall(boundedSkillResponse, [
            response,
            rpc.method === "skills/list" ? MAX_SERIALIZED_CATALOG_BYTES : MAX_SKILL_READ_RPC_BYTES,
            rpc.id,
            init?.signal,
          ])) as Response;
        }
        return response;
      }),
    );
    // A runtime refusing the assembled header quotes it, and the transport
    // error below keeps none of what the runtime said. So whether the
    // rejection quoted the credential is decided here, first, and survives
    // as the class of the error rather than as its text.
    const guardedFetch = redirectSafeFetch(
      id,
      opts.redirects,
      credentialFramed === null
        ? trackedFetch
        : authMethod((input: string | URL, init: RequestInit | undefined) =>
            authFlow<Response>(function* () {
              try {
                return (yield authCall(trackedFetch, [input, init])) as Response;
              } catch (err) {
                throw withoutCredential(err, credentialValue, credentialFramed);
              }
            }),
          ),
    );
    if (opts.auth?.type === "oauth") {
      const oauthProvider = provider ?? newProvider(ctx, undefined, signal);
      // The session/provider belong to the request. A renewal belongs to the
      // exact call whose HTTP response challenged it, until claim submission.
      // Carry that ownership on the response the SDK passes to onUnauthorized;
      // a shared mutable "current call" would borrow a concurrent call's lease.
      const renewalSignals = new WeakMap<Response, AbortSignal>();
      const exchangeFetch = (send: FetchLike): FetchLike =>
        exchangeOnly
          ? authMethod(
              (input: string | URL, init: RequestInit | undefined) =>
                authView(
                  ctx,
                  authMethod((requestSignal: AbortSignal) =>
                    authFlow<Response>(function* () {
                      const response = (yield authCall(send, [
                        input,
                        {
                          ...init,
                          signal: init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal,
                        },
                      ])) as Response;
                      if (requestSignal.aborted) {
                        void response.body?.cancel().catch(() => {});
                        throw requestSignal.reason;
                      }
                      return codeExchangeResponse(response, requestSignal);
                    }),
                  ),
                  true,
                ) as Effect.Effect<Response, unknown>,
            )
          : send;
      const coordinatedFetch = refreshCoordinatorFor(ctx).coordinatedFetch(
        oauthProvider,
        exchangeFetch(learnedUrlSafeFetch(id, url, trackedFetch)),
        signal,
        ctx.defer,
        exchangeFetch(
          learnedUrlSafeFetch(
            id,
            url,
            authMethod(
              (input: string | URL, init: RequestInit | undefined) =>
                authCall(guardedFetch, [input, resourceInit(input, init)]) as Effect.Effect<Response, unknown>,
            ),
          ),
        ),
        () => {
          guardedTransport(true);
        },
      );
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider: oauthProvider,
        onInsufficientScope: "throw",
        fetch: authMethod((input: string | URL, init: RequestInit | undefined) =>
          authFlow<Response>(function* () {
            const response = (yield authCall(coordinatedFetch, [input, init])) as Response;
            if (response.status === 401) {
              let owner: AbortSignal | undefined;
              if (typeof init?.body === "string") {
                try {
                  const rpc: unknown = JSON.parse(init.body);
                  if (skillObject(rpc)) {
                    if (rpc.method === "initialize" || rpc.method === "server/discover") owner = initiatingSignal;
                    else if (typeof rpc.id === "string" || typeof rpc.id === "number")
                      owner = flights.get(rpc.id)?.request?.ctx.signal;
                  }
                } catch {}
              }
              const ownedSignal =
                owner && init?.signal ? AbortSignal.any([owner, init.signal]) : (owner ?? init?.signal);
              if (ownedSignal) renewalSignals.set(response, ownedSignal);
            }
            return response;
          }),
        ),
      });
      boundOAuthFlows(ctx, transport, url, [signal, ctx.signal], (response) => renewalSignals.get(response));
      earlyRenewals.set(
        transport,
        authMethod((due: string, owner: AbortSignal | undefined) => {
          // Exactly the flow a 401 starts, through the same refresh coordinator,
          // with nothing sent to the MCP endpoint. The token request carries
          // `due`, so a rotation another request finished is adopted instead.
          const internals = transport as unknown as {
            _authProvider: {
              onUnauthorized: (flow: { response: Response; serverUrl: URL; fetchFn: FetchLike }) => Promise<void>;
            };
            _fetchWithInit: FetchLike;
          };
          const response = new Response(null, { status: 401 });
          if (owner) renewalSignals.set(response, owner);
          return authInvoke(internals._authProvider, "onUnauthorized", [
            { response, serverUrl: url, fetchFn: earlyRenewalFetch(internals._fetchWithInit, due) },
          ]) as Effect.Effect<void, unknown>;
        }),
      );
      return sendingEachWriteOnce(transport, flights, untrackedRead);
    }
    const headers =
      opts.auth?.type === "headers"
        ? opts.auth.headers
        : (credentialAuth || requestAuth) && credentialFramed !== null
          ? { ...requestAuth?.headers, [credentialHeader]: credentialFramed }
          : undefined;
    return sendingEachWriteOnce(
      new StreamableHTTPClientTransport(url, {
        ...(headers ? { requestInit: { headers } } : {}),
        fetch: authMethod(
          (input: string | URL, init: RequestInit | undefined) =>
            authCall(guardedFetch, [input, resourceInit(input, init)]) as Effect.Effect<Response, unknown>,
        ),
      }),
      flights,
      untrackedRead,
    );
  };

  /**
   * Admit a write's call to the wire once, whatever JSON-RPC id a later
   * message for it carries, and show `trackedFetch` which call each message
   * belongs to while it is sent. A missing record fails closed unless active
   * calls prove the tool is read (INV-1, INV-9).
   */
  const sendingEachWriteOnce = (
    transport: StreamableHTTPClientTransport,
    flights: Map<string | number, CallDispatch>,
    untrackedRead: (params: unknown) => boolean,
  ): StreamableHTTPClientTransport => {
    const send = transport.send.bind(transport);
    transport.send = authMethod(
      (
        message: JSONRPCMessage | JSONRPCMessage[],
        options:
          | {
              resumptionToken?: string;
              onresumptiontoken?: (token: string) => void;
              requestSignal?: AbortSignal;
              onRequestStreamEnd?: () => void;
              headers?: Readonly<Record<string, string>>;
            }
          | undefined,
      ) =>
        authFlow<void>(function* () {
          const request =
            !Array.isArray(message) && "method" in message && message.method === "tools/call" && "id" in message
              ? message
              : undefined;
          if (!request) return (yield authCall(send, [message, options])) as void;
          const dispatch = dispatchOf(request.params);
          if (!dispatch) {
            if (!untrackedRead(request.params)) throw missingDispatch();
            return (yield authCall(send, [message, options])) as void;
          }
          if (dispatch.write && dispatch.sent) throw resendRefused(dispatch);
          flights.set(request.id, dispatch);
          try {
            return (yield authCall(send, [message, options])) as void;
          } finally {
            flights.delete(request.id);
          }
        }),
    );
    return transport;
  };

  const reset = (state: ConnectionState) => {
    state.lease = null;
    state.client = null;
    state.transport = null;
    state.toolDefinitions.clear();
    state.connecting = null;
    state.authRequired = false;
    state.provider = null;
    state.connectedGeneration = null;
    state.credentialDigest = null;
    // `scope` is deliberately left as it is — see ConnectionState.
  };

  // Detached exits start this bounded best-effort tail immediately;
  // closeScope awaits its own tail so the core
  // can pass it to the runtime's deferred channel. Terminating and closing are
  // each bounded, so no close waits more than two seconds in all.
  const closingSessions = new WeakMap<Transport, Deferred.Deferred<void>>();
  const closeConnection = (client: Client | null, transport: Transport | null, logger: Logger): Effect.Effect<void> =>
    Effect.suspend(() => {
      const previous = transport && closingSessions.get(transport);
      if (previous) return Deferred.await(previous);
      const closed = Deferred.makeUnsafe<void>();
      // A connect can acquire a session after an early close. Deduplicate only
      // once that session exists, so its late abandonment still sends DELETE.
      if (transport?.sessionId) closingSessions.set(transport, closed);
      return (transport ? terminateSession(transport, logger, id) : Effect.void).pipe(
        Effect.andThen(closeLocally(client, transport)),
        Effect.ensuring(Deferred.done(closed, Exit.void)),
      );
    });

  /**
   * Forget the live connection and close its lease without waiting. A connect
   * still in flight is unpublished with it, and sees at its next check that it
   * has been abandoned.
   */
  const closeHalf = (state: ConnectionState): void => {
    const lease = state.lease;
    reset(state);
    const release = lease && Scope.closeUnsafe(lease, Exit.void);
    if (release) detach(release);
  };

  const waitForConnection = (attempt: Deferred.Deferred<Client, unknown>, signal?: AbortSignal): Promise<Client> =>
    runEdge(Deferred.await(attempt), signal ? { signal } : {});

  const oauthConfigFor = (ctx: ConnectorContext) =>
    isOauth
      ? {
          client: staticClient,
          clientMetadataUrl: staticClient ? undefined : (clientMetadataUrl ?? selfHostedClientUrl(ctx.publicUrl, id)),
          redirectUri: downstreamRedirectUri(ctx.baseUrl, ctx.publicUrl, id),
          clientName: ctx.oauthClientName,
        }
      : undefined;
  // The catalog cache's configuration, partition and sharing are derived the
  // same way for a connect and for a pre-connect cache read, so both address
  // exactly the same entries.
  const catalogConfigFor = (ctx: ConnectorContext) =>
    JSON.stringify({
      url: new URL(opts.url).href,
      auth: opts.auth?.type ?? null,
      headers: opts.auth?.type === "headers" ? opts.auth.headers : requestAuth?.headers,
      ...(extraHeaders ? { extraHeaders } : {}),
      credentialHeader,
      credentialScheme,
      authScope: opts.authScope ?? "shared",
      redirects: opts.redirects ?? "none",
      versionNegotiation: opts.versionNegotiation ?? "auto",
      oauthConfig: oauthConfigFor(ctx),
      oauthScope,
    });
  const catalogSharing: "private" | "shared" = requestAuth || opts.authScope === "personal" ? "private" : "shared";
  const catalogIdentityFor = (provider: KvOAuthProvider) =>
    authMethod(() =>
      authFlow<string>(function* () {
        const tokens = yield authInvoke(provider, "tokens", []);
        return yield authCall<string>(sha256Hex, [JSON.stringify(tokens)]);
      }),
    );

  // Everything that decides how this connector's handshake negotiates.
  const negotiationInputs = (ctx: ConnectorContext, credentialDigest: string | null, epoch: string) =>
    JSON.stringify([
      opts.url,
      opts.versionNegotiation ?? "auto",
      opts.auth?.type,
      opts.auth?.type === "headers" ? opts.auth.headers : requestAuth?.headers,
      ...(extraHeaders ? [extraHeaders] : []),
      credentialHeader,
      credentialScheme,
      opts.authScope ?? "shared",
      opts.redirects ?? "none",
      oauthConfigFor(ctx),
      oauthScope,
      credentialDigest,
      epoch,
      callerOf(ctx),
      skillsEnabled === true,
    ]);

  /**
   * Serve a complete, unexpired cached catalog without connecting. The read
   * derives the partition a connect would bind — the owner's live OAuth epoch
   * and tokens, or the digest of this caller's credential — from storage reads
   * alone: no transport, no handshake, no authorization started and no auth or
   * capability state changed (INV-10). Only the catalog cache's own complete
   * entries are served (INV-8); a miss, an expired or `ttlMs: 0` catalog, an
   * operator-disconnected or token-less grant, or a failed cache read all
   * return no tools, and the caller connects. A downstream whose stored
   * negotiation verdict is modern connects without a handshake and reads the
   * same cache through the SDK, so it skips this read. What was already read
   * is handed to that connect, so a resolver runs once per listing.
   */
  const cachedCatalog = authMethod((ctx: ConnectorContext) =>
    authFlow<Preread & { tools?: Tool[] }>(function* () {
      const principal = principalPolicy
        ? requestPrincipalFor(
            principalPolicy,
            ctx,
            (reason) => new CredentialRequiredError(`Connector "${id}" ${reason}.`),
          )
        : undefined;
      const preread: Preread = {};
      let credentialDigest: string | null = null;
      if (credentialAuth || requestAuth) {
        preread.credential = (yield authCall(readCredential, [ctx, principal])) as string;
        credentialDigest = (yield authCall(sha256Hex, [
          principal ? JSON.stringify([principal, preread.credential]) : preread.credential,
        ])) as string;
      }
      try {
        let epoch = "";
        let identity: (() => Promise<string>) | undefined;
        if (isOauth) {
          // Read-only grant snapshots: no in-place sealing, epoch binding or
          // refresh. Every identity check during cache acceptance re-reads the
          // grant and refuses unless both the epoch this partition was derived
          // from and the token digest still hold, as a bound connect would.
          const provider = newProvider(ctx);
          const snapshot = (yield authInvoke(provider, "peekGrant", [])) as { epoch: string; tokens?: OAuthTokens };
          epoch = snapshot.epoch;
          if (provider.isOperatorDisconnectedEpoch(epoch) || !snapshot.tokens) return preread;
          const bound = epoch;
          identity = authMethod(() =>
            authFlow<string>(function* () {
              const current = (yield authInvoke(provider, "peekGrant", [])) as { epoch: string; tokens?: OAuthTokens };
              // A distinct value per refusal never matches the listing's identity.
              if (current.epoch !== bound || !current.tokens) return `superseded:${crypto.randomUUID()}`;
              return yield authCall<string>(sha256Hex, [JSON.stringify(current.tokens)]);
            }),
          );
        }
        if (opts.versionNegotiation !== "legacy") {
          const digest = (yield authCall(sha256Hex, [negotiationInputs(ctx, credentialDigest, epoch)])) as string;
          const prior = (yield authCall(readNegotiation, [ctx, digest])) as PriorDiscovery | undefined;
          preread.negotiation = { digest, prior };
          if (prior?.kind === "modern") return preread;
        }
        const cache = (yield authCall(catalogClientOptions, [
          ctx,
          id,
          catalogConfigFor(ctx),
          JSON.stringify([epoch, credentialDigest]),
          undefined,
          cacheOwner,
          catalogSharing,
          identity,
          true,
        ])) as Awaited<ReturnType<typeof catalogClientOptions>>;
        const result = (yield authInvoke(cache, "cachedTools", [ctx])) as ListToolsResult | undefined;
        if (result) return { tools: result.tools };
      } catch (error) {
        if (viewSignal(ctx).aborted) throw error;
        logFailure(ctx.logger, "catalog read failed", failureRecord({ connector: id }, error));
      }
      return preread;
    }),
  );

  const ensureConnected = authMethod((ctx: ConnectorContext, state: ConnectionState, preread?: Preread) =>
    authFlow<Client>(function* () {
      let joined = state.connecting;
      if (joined) connectingWaiters.set(joined, (connectingWaiters.get(joined) ?? 0) + 1);
      const leave = () => {
        if (!joined) return;
        const remaining = (connectingWaiters.get(joined) ?? 1) - 1;
        if (remaining > 0) connectingWaiters.set(joined, remaining);
        else {
          connectingWaiters.delete(joined);
          if (ctx.signal?.aborted && state.connecting === joined) closeHalf(state);
        }
      };
      try {
        if (state.authRequired) {
          throw authRequiredError();
        }
        let oauthGeneration: string | undefined;
        if (isOauth && (state.client || state.connecting)) {
          const provider = newProvider(ctx, state, openRequest(ctx.requestScope ?? ctx).signal);
          oauthGeneration = (yield authView(
            ctx,
            authMethod(() => authInvoke(provider, "liveEpoch", []) as Effect.Effect<string, unknown>),
          )) as string;
          if (provider.isOperatorDisconnectedEpoch(oauthGeneration)) {
            closeHalf(state);
            throw operatorDisconnectedError();
          }
        }
        if (state.client && oauthGeneration !== undefined && state.connectedGeneration !== null) {
          if (isClosed(state)) throw scopeEndedError();
          if (oauthGeneration !== state.connectedGeneration) {
            closeHalf(state);
          }
        }
        let credentialValue: string | null = null;
        let credentialFramed: string | null = null;
        let credentialDigest: string | null = null;
        // Only the admitted caller on this operation's context, never an argument.
        // Refused before the resolver runs, so no token is minted for anyone else.
        const principal = principalPolicy
          ? requestPrincipalFor(
              principalPolicy,
              ctx,
              (reason) => new CredentialRequiredError(`Connector "${id}" ${reason}.`),
            )
          : undefined;
        if (credentialAuth || requestAuth) {
          credentialValue = preread?.credential ?? ((yield authCall(readCredential, [ctx, principal])) as string);
          credentialFramed = credentialHeaderValue(credentialScheme, credentialValue);
          // The principal joins the client's identity: another principal never
          // reuses this client, even if its resolver returns the same token.
          credentialDigest = (yield authCall(sha256Hex, [
            principal ? JSON.stringify([principal, credentialValue]) : credentialValue,
          ])) as string;
          if (
            (state.client || state.connecting) &&
            state.credentialDigest !== null &&
            state.credentialDigest !== credentialDigest
          ) {
            const observedConnection = state.client ?? state.connecting;
            const currentCredential = (yield authCall(readCredential, [ctx, principal])) as string;
            if (isClosed(state)) throw scopeEndedError();
            if (currentCredential !== credentialValue || (state.client ?? state.connecting) !== observedConnection) {
              throw resendAdvice(
                new ConnectorCallError("connector_call_failed", "The downstream credential changed while connecting.", {
                  retryable: true,
                }),
                "; retry the operation",
              );
            }
            closeHalf(state);
          }
        }
        viewSignal(ctx).throwIfAborted();
        if (isClosed(state)) throw scopeEndedError();
        if (state.client) return state.client;
        const attempt =
          state.connecting ??
          startConnect(
            ctx,
            state,
            credentialValue,
            credentialFramed,
            credentialDigest,
            principal,
            preread?.negotiation,
          );
        if (joined !== attempt) {
          leave();
          joined = attempt;
          connectingWaiters.set(attempt, (connectingWaiters.get(attempt) ?? 0) + 1);
        }
        const client = (yield authCall(waitForConnection, [attempt, ctx.signal])) as Client;
        if (isClosed(state)) throw scopeEndedError();
        return client;
      } finally {
        leave();
      }
    }),
  );

  /**
   * Start this scope's connect attempt, publishing it before any of it runs.
   * The attempt completes its Deferred itself, and every caller — the one that
   * started it included — waits on that; nothing awaits the run directly,
   * which is why handing it to `detach` orphans nothing.
   */
  const startConnect = (
    ctx: ConnectorContext,
    state: ConnectionState,
    credentialValue: string | null,
    credentialFramed: string | null,
    credentialDigest: string | null,
    principal: RequestPrincipal | undefined,
    negotiation: Preread["negotiation"],
  ): Deferred.Deferred<Client, unknown> => {
    const attempt = Deferred.makeUnsafe<Client, unknown>();
    state.connecting = attempt;
    // Published with the attempt, not with its result: a rotation that lands
    // while this connect is in flight has to be visible to the next caller,
    // which would otherwise wait on a client bound to the older key.
    state.credentialDigest = credentialDigest;
    detach(
      connect(ctx, state, attempt, credentialValue, credentialFramed, principal, negotiation).pipe(
        // The connection belongs to this request, without the first waiter's
        // call/credential/budget authority. Refresh coordinators stay separate.
        Effect.provideService(RequestScope, Context.get(viewServices(ctx), RequestScope)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            // Force reset may have abandoned this attempt and installed a new
            // one in the same request scope. An old completion must not erase
            // the new attempt and allow a third concurrent connect.
            if (state.connecting === attempt) state.connecting = null;
            // Last: a Deferred resumes its waiters inside this call.
            Deferred.doneUnsafe(attempt, exit);
          }),
        ),
      ),
    );
    return attempt;
  };

  const connect = (
    ctx: ConnectorContext,
    state: ConnectionState,
    attempt: Deferred.Deferred<Client, unknown>,
    credentialValue: string | null,
    credentialFramed: string | null,
    principal: RequestPrincipal | undefined,
    negotiation: Preread["negotiation"],
  ): Effect.Effect<Client, unknown> => {
    // Force reset, rotation, and teardown all abandon an attempt the same way:
    // they unpublish it and close the lease it holds, if it holds one yet.
    const owned = () => state.connecting === attempt && !isClosed(state);
    return Effect.gen(function* () {
      // The transport and its OAuth provider are shared by every call in this
      // scope. A call's deadline signal is aborted even on success, so retaining
      // the first caller's signal here would abort its siblings and later calls.
      // The provider uses the connection's lifetime. Each challenged response
      // separately binds renewal preparation to the call that initiated it.
      const connectionAbort = new AbortController();
      // Own cancellation before beginFlow's storage reads.
      // The lease first owns just the signal, then the transport it creates.
      const lease = Scope.forkUnsafe(state.scope);
      const handshakeAbort = new AbortController();
      const held: { client: Client | null; transport: Transport | null } = {
        client: null,
        transport: null,
      };
      yield* Scope.addFinalizer(
        lease,
        Effect.sync(() => handshakeAbort.abort()).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (!held.transport) connectionAbort.abort();
              return closeConnection(held.client, held.transport, ctx.logger);
            }),
          ),
          // Let session termination use the OAuth fetch wrapper before ending
          // its lifetime. Local transport close aborts all active MCP fetches.
          Effect.ensuring(Effect.sync(() => connectionAbort.abort())),
        ),
      );
      state.lease = lease;
      return yield* Effect.gen(function* () {
        // A provider belongs to exactly one connect attempt. A force reset can
        // abandon that attempt while its transport still holds the provider;
        // the replacement must never mutate the abandoned provider's epoch.
        const provider = isOauth ? newProvider(ctx, undefined, connectionAbort.signal) : null;
        // Every OAuth run of this attempt — a 401's refresh or consent, a
        // step-up — happens inside the SDK, bound to the epoch live now: a
        // reset meanwhile fails the attempt rather than handing it the next
        // epoch's grant.
        const genAtStart = provider
          ? yield* promised(authMethod(() => authInvoke(provider, "beginFlow", []) as Effect.Effect<string, unknown>))
          : "";
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        if (provider) state.attemptProvider = provider;
        if (provider?.isOperatorDisconnectedEpoch(genAtStart)) {
          return yield* Effect.fail(operatorDisconnectedError());
        }
        // SDK v2 selects its validator by runtime export condition: AJV on
        // Node and @cfworker/json-schema under workerd. The Workers-safe path
        // no longer needs Connecta-specific wiring.
        const negotiationDigest = yield* promised(
          authMethod(
            () =>
              authCall(sha256Hex, [negotiationInputs(ctx, state.credentialDigest, genAtStart)]) as Effect.Effect<
                string,
                unknown
              >,
          ),
        );
        const prior =
          opts.versionNegotiation === "legacy"
            ? undefined
            : negotiation?.digest === negotiationDigest
              ? negotiation.prior
              : yield* promised(
                  authMethod(
                    () =>
                      authCall(readNegotiation, [ctx, negotiationDigest]) as Effect.Effect<
                        PriorDiscovery | undefined,
                        unknown
                      >,
                  ),
                );
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        const cacheOptions = yield* promised(
          authMethod(
            () =>
              authCall(catalogClientOptions, [
                ctx,
                id,
                catalogConfigFor(ctx),
                JSON.stringify([genAtStart, state.credentialDigest]),
                connectionAbort.signal,
                cacheOwner,
                catalogSharing,
                provider ? catalogIdentityFor(provider) : undefined,
              ]) as Effect.Effect<Awaited<ReturnType<typeof catalogClientOptions>>, unknown>,
          ),
        );
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        const makeClient = () => {
          const {
            intake: _intake,
            completeCatalogRefresh: _refresh,
            withListing: _listing,
            currentContext: _context,
            cachedTools: _cached,
            ...clientOptions
          } = cacheOptions;
          const client = new Client(
            { name: "connecta", version: CONNECTA_VERSION },
            {
              ...clientOptions,
              listMaxPages: MAX_TOOL_PAGES,
              versionNegotiation: {
                mode: opts.versionNegotiation ?? "auto",
              },
              capabilities: {
                ...downstreamInputCapabilities(ctx.requestScope ?? ctx),
                ...(skillsEnabled ? { extensions: { [SKILLS_EXTENSION]: {} } } : {}),
              },
              // The host owns each sealed continuation; never auto-retry a write.
              inputRequired: { autoFulfill: false },
            },
          );
          installCatalogIntake(client, ctx, cacheOptions);
          return client;
        };
        let c = makeClient();
        let t = buildTransport(
          ctx,
          provider,
          credentialFramed,
          connectionAbort.signal,
          credentialValue,
          false,
          principal,
        );
        if (!owned()) {
          held.transport = t;
          return yield* Effect.fail(scopeEndedError());
        }
        state.transport = t;
        held.transport = t;
        recordWireErrors(t, () => observeCatalogChange(ctx, id, connectionAbort.signal, cacheOwner));
        yield* promised(
          authMethod(() =>
            authFlow<void>(function* () {
              try {
                (yield authInvoke(c, "connect", [
                  t,
                  { signal: handshakeAbort.signal, ...(prior ? { prior } : {}) },
                ])) as void;
              } catch (error) {
                if (
                  prior ||
                  opts.versionNegotiation === "legacy" ||
                  !(error instanceof SdkHttpError) ||
                  error.code !== SdkErrorCode.EraNegotiationFailed ||
                  error.status < 500 ||
                  error.status >= 600 ||
                  !owned() ||
                  handshakeAbort.signal.aborted
                )
                  throw error;
                c = makeClient();
                t = buildTransport(
                  ctx,
                  provider,
                  credentialFramed,
                  connectionAbort.signal,
                  credentialValue,
                  false,
                  principal,
                );
                state.transport = held.transport = t;
                recordWireErrors(t, () => observeCatalogChange(ctx, id, connectionAbort.signal, cacheOwner));
                (yield authInvoke(c, "connect", [
                  t,
                  { signal: handshakeAbort.signal, prior: { kind: "legacy" } },
                ])) as void;
              }
            }),
          ),
        ).pipe(
          Effect.mapError((err) =>
            atMcpBoundary(
              ctx,
              // First, while the runtime's text can still be read for it.
              withoutCredential(err, credentialValue, credentialFramed),
              "MCP handshake",
              t,
              [ctx.signal, connectionAbort.signal, handshakeAbort.signal],
            ),
          ),
        );
        held.client = c;
        // A probe deadline can end its scope while connect is still in flight.
        // The transport is closed immediately by closeScope; if connect wins
        // that race anyway, close the resulting client rather than resurrecting
        // a session in the detached state object.
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        // A force re-auth that landed WHILE we were connecting wiped the
        // credentials this client just bound to. Discard it rather than cache
        // a stale-isolate connection.
        if (provider) {
          const generation = yield* promised(
            authMethod(() => authInvoke(provider, "liveEpoch", []) as Effect.Effect<string, unknown>),
          ).pipe(Effect.mapError((error) => (owned() ? error : scopeEndedError())));
          // closeScope can land while the epoch read is pending, after
          // connect succeeded but before this client is cached. Discard the
          // client on that side of the await too.
          if (!owned()) return yield* Effect.fail(scopeEndedError());
          if (generation !== genAtStart) {
            return yield* Effect.fail(
              new UnauthorizedError("Connector was re-authorized during connect; reconnect required."),
            );
          }
        }
        state.client = c;
        if (provider) connectedProviders.set(c, provider);
        state.connectedGeneration = genAtStart;
        state.authRequired = false;
        const discover = c.getDiscoverResult();
        if (!prior)
          yield* promised(
            authMethod(
              () =>
                authCall(storeNegotiation, [
                  ctx,
                  negotiationDigest,
                  discover ? { kind: "modern", discover } : { kind: "legacy" },
                ]) as Effect.Effect<void, unknown>,
            ),
          );
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        return c;
      }).pipe(
        Effect.catchDefect(Effect.fail),
        Effect.catch((err) => {
          // Close the failed connection through its client, without waiting.
          if (owned()) {
            state.lease = null;
            state.transport = null;
            // Only a real 401/UnauthorizedError means auth is the problem —
            // a network error on an oauth connector must surface as "error",
            // not "auth_required".
            if (requiresAuthorization(err)) state.authRequired = true;
            const release = Scope.closeUnsafe(lease, Exit.void);
            if (release) detach(release);
          } else {
            // Whoever abandoned this attempt closed the lease already, while
            // the connect was in flight. A session it acquired after that
            // close still owes its DELETE.
            detach(closeConnection(held.client, held.transport, ctx.logger));
          }
          if (err instanceof UnauthorizedError) {
            return Effect.fail(carryFailureFacts(err, authRequiredError()));
          }
          // Defense in depth for the one error class that can quote the
          // credential: a runtime refusing the assembled header.
          // `readCredential` already rejects a value that cannot ride one, so
          // reaching this is a gap in that check rather than a routine
          // outcome.
          return Effect.fail(withoutCredential(err, credentialValue, credentialFramed));
        }),
      );
    });
  };

  const disconnectAuthorization = authMethod(
    (
      ctx: ConnectorContext,
      state: ConnectionState,
      operatorDisconnected: boolean = false,
      preserveClient: boolean = false,
    ) =>
      authFlow<void>(function* () {
        const provider = newProvider(ctx, state);
        const reset = operatorDisconnected
          ? authInvoke<void>(provider, "disconnectAuthorization", [
              learnedUrlSafeFetch(
                id,
                new URL(opts.url),
                authMethod((input: string | URL, init: RequestInit | undefined) =>
                  authFlow<Response>(function* () {
                    trackSentRequest(ctx, input, init);
                    return (yield authCall(sendCredentialPost, [input, init ?? {}])) as Response;
                  }),
                ),
              ),
            ])
          : authInvoke<void>(provider, "resetAuthorization", [false, preserveClient]);
        try {
          yield reset;
        } finally {
          closeHalf(state);
        }
      }),
  );

  /**
   * Whether the owner's grant holds tokens, read the way the invocation gate
   * reads it. A downstream may answer its handshake and listing without
   * credentials, so a healthy connection proves nothing about the grant.
   * Read after connecting: connect has bound the epoch, migrated an older
   * layout, and refused a disconnected one within the scope's lifetime.
   */
  const granted = authMethod((provider: KvOAuthProvider) =>
    authFlow<boolean>(function* () {
      return Boolean(yield authInvoke(provider, "tokens", []));
    }),
  );

  /**
   * Renew `due`, an access token within a minute of its stored expiry,
   * through `transport`'s bound 401 flow and the shared refresh coordinator.
   * Nothing is sent to the MCP endpoint. Only calls come here: status,
   * listing and discovery never renew (INV-10).
   */
  const renewEarly = authMethod((ctx: ConnectorContext, transport: Transport, provider: KvOAuthProvider, due: string) =>
    authFlow<void>(function* () {
      const renew = earlyRenewals.get(transport);
      if (!renew) return;
      try {
        (yield authCall(renew, [due, ctx.signal])) as void;
        const fresh = provider.adoptedRefresh();
        if (fresh !== undefined)
          earlyRenewed.record(ctx.requestScope ?? ctx, due, fresh, provider.observedExpiry(fresh));
      } catch (err) {
        if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
        throw err instanceof UnauthorizedError
          ? carryFailureFacts(err, authRequiredError())
          : downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
      }
    }),
  );

  /**
   * The invocation's renewal, before it enters `callTool`: a failure there is
   * the call's authorization verdict with nothing sent, so a write never
   * draws the 401 it could not be repeated after (INV-9). The transport is
   * built for its flow and never started, so it holds nothing to close.
   */
  const renewBeforeCall = authMethod((ctx: ConnectorContext, due: string) =>
    authFlow<void>(function* () {
      if (opts._transportFactory) return;
      const provider = newProvider(ctx);
      (yield authInvoke(provider, "beginFlow", [])) as string;
      (yield authCall(renewEarly, [ctx, buildTransport(ctx, provider), provider, due])) as void;
    }),
  );

  /**
   * A connection reused later in the request renews again once its token
   * comes due, before `callTool` sends it. The grant's last read decides
   * (`KvOAuthProvider.renewalDue`, memory only).
   */
  const renewBeforeDispatch = authMethod((ctx: ConnectorContext, state: ConnectionState, client: Client) =>
    authFlow<void>(function* () {
      const provider = connectedProviders.get(client);
      const due = provider?.renewalDue();
      if (due === undefined || !provider || !client.transport) return;
      if (earlyRenewed.settled(ctx.requestScope ?? ctx, due)) return;
      try {
        (yield authCall(renewEarly, [ctx, client.transport, provider, due])) as void;
      } catch (err) {
        if (requiresAuthorization(err) && state.client === client) state.authRequired = true;
        throw err;
      }
    }),
  );

  /**
   * Start consent for a downstream that answered without challenging. The
   * transport's bound 401 seam runs the SDK flow exactly as a challenge
   * without `resource_metadata` would: RFC 9728 discovery at the resource's
   * well-known URLs, the same issuer and resource checks, consent state, and
   * CIMD/DCR/static client order. Nothing is sent to the MCP endpoint.
   */
  const startUnchallenged = authMethod((ctx: ConnectorContext, connectedProvider: KvOAuthProvider) =>
    authFlow<ConnectorStatus>(function* () {
      const required = {
        state: "auth_required",
        message: "Authorization required \u2014 open the URL to connect.",
      } as const;
      // A test transport carries no OAuth flow to start.
      if (opts._transportFactory) return required;
      // A cached connection may belong to a passive status or call. Give this
      // explicit start its own authorization-capable provider without widening
      // the transport's authority or adopting a Restart's replacement epoch.
      const epoch = (yield authInvoke(connectedProvider, "flowEpoch", [])) as string;
      const provider = newProvider(ctx);
      (yield authInvoke(provider, "beginFlow", [epoch])) as string;
      // Never started, this transport holds no session or stream to close.
      const transport = buildTransport(ctx, provider) as StreamableHTTPClientTransport;
      const internals = transport as unknown as {
        _authProvider: {
          onUnauthorized: (flow: { response: Response; serverUrl: URL; fetchFn: FetchLike }) => Promise<void>;
        };
        _fetchWithInit: FetchLike;
      };
      try {
        (yield authInvoke(internals._authProvider, "onUnauthorized", [
          {
            response: new Response(null, { status: 401 }),
            serverUrl: new URL(opts.url),
            fetchFn: internals._fetchWithInit,
          },
        ])) as void;
        // Authorized without consent: nothing is pending to hand back.
        return { state: "ok", message: "Already authorized \u2014 connection is healthy." };
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
      }
      const authorizationUrl = (yield authInvoke(provider, "consentUrl", [viewSignal(ctx, true)])) as
        | string
        | undefined;
      return { ...required, ...(authorizationUrl !== undefined ? { authorizationUrl } : {}) };
    }),
  );

  // Built once from construction-time values: names, framing, and public
  // URLs only. A static header's value and a stored credential never reach
  // it, and a URL keeps origin and path: a CIMD document's query may carry a
  // token even though the document itself is public.
  const describedClientMetadataUrl = describedUrl(clientMetadataUrl);
  const authDescription: ConnectorAuthDescription = requestAuth
    ? {
        mode: "request",
        header: "Authorization",
        scheme: "Bearer",
        ...(requestAuth.headers ? { headerNames: Object.keys(requestAuth.headers) } : {}),
      }
    : opts.auth?.type === "headers"
      ? { mode: "headers", headerNames: Object.keys(opts.auth.headers) }
      : credentialAuth
        ? { mode: "credential", header: credentialHeader, scheme: credentialScheme }
        : isOauth
          ? {
              mode: "oauth",
              ...(authorizationParams.length
                ? { authorizationParamNames: authorizationParams.map(([name]) => name) }
                : {}),
              ...(oauthScope !== undefined ? { scope: oauthScope } : {}),
              ...(describedClientMetadataUrl !== undefined ? { clientMetadataUrl: describedClientMetadataUrl } : {}),
            }
          : { mode: "none" };
  if (extraHeaders)
    authDescription.headerNames = [...new Set([...(authDescription.headerNames ?? []), ...Object.keys(extraHeaders)])];
  const endpoint = describedEndpoint(opts.url);

  const optionSources = Object.freeze({
    "source.kind": "default" as const,
    "auth.mode": opts.auth === undefined ? ("default" as const) : ("config" as const),
    "auth.header": credentialAuth?.header === undefined ? ("default" as const) : ("config" as const),
    "auth.scheme": credentialAuth?.scheme === undefined ? ("default" as const) : ("config" as const),
    "credential.label": credentialAuth?.credential === undefined ? ("default" as const) : ("config" as const),
    ...Object.fromEntries(
      ["versionNegotiation", "redirects", "requireHttps"].map(
        (key) =>
          [
            `transport.${key}`,
            opts[key as "versionNegotiation" | "redirects" | "requireHttps"] === undefined ? "default" : "config",
          ] as const,
      ),
    ),
  });
  const resourceTemplateRefusals = new Set<ResourceTemplateRefusal>();
  const skillScopeOpen = (ctx: ConnectorContext, state: ConnectionState) => {
    if (isClosed(state)) throw scopeEndedError();
    if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : scopeEndedError();
  };

  const withSkillsClient = authMethod(
    <T>(
      ctx: ConnectorContext,
      method: "skills/list" | "resources/read",
      run: (client: Client, state: ConnectionState) => Promise<T>,
    ) =>
      authFlow<T>(function* () {
        const state = stateFor(ctx);
        const client = (yield authCall(ensureConnected, [ctx, state])) as Client;
        try {
          skillScopeOpen(ctx, state);
          const capabilities = client.getServerCapabilities();
          const extension = capabilities?.extensions?.[SKILLS_EXTENSION];
          if (
            client.getProtocolEra() !== "modern" ||
            !skillObject(capabilities?.resources) ||
            !skillObject(extension) ||
            (extension.directoryRead !== undefined && typeof extension.directoryRead !== "boolean")
          ) {
            throw new ConnectorCallError(
              "connector_call_failed",
              "The downstream did not declare a valid Skills extension and resources capability.",
            );
          }
          const result = (yield authCall(run, [client, state])) as Awaited<T>;
          skillScopeOpen(ctx, state);
          return result;
        } catch (error) {
          if (ownAbortReason(error, [ctx.signal]) && !hasSdkPayload(error)) throw error;
          const classified = atMcpBoundary(ctx, error, method, client.transport, [ctx.signal]);
          if (requiresAuthorization(classified) && state.client === client) state.authRequired = true;
          throw carryFailureFacts(classified, withheldAs(`Connector "${id}" downstream ${method} failed.`, classified));
        }
      }),
  );

  const connector: Connector = {
    id,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    kind: "mcp",
    describe: () => ({
      optionSources,
      source: { kind: "remote-mcp" },
      ...(endpoint ? { endpoint } : {}),
      auth: authDescription,
      transport: {
        versionNegotiation: opts.versionNegotiation ?? "auto",
        redirects: opts.redirects ?? "none",
        requireHttps: opts.requireHttps ?? false,
      },
    }),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.authScope !== undefined ? { authScope: opts.authScope } : {}),
    ...(opts.maxResultBytes !== undefined ? { maxResultBytes: opts.maxResultBytes } : {}),
    ...(opts.callAdmission !== undefined ? { callAdmission: opts.callAdmission } : {}),
    ...(opts.usageGuide !== undefined ? { usageGuide: opts.usageGuide } : {}),
    ...(skillsEnabled
      ? {
          downstreamSkills: {
            list: authMethod(
              (ctx: ConnectorContext) =>
                authCall(withSkillsClient, [
                  ctx,
                  "skills/list",
                  authMethod((client: Client, state: ConnectionState) =>
                    authFlow<ConnectorSkill[]>(function* () {
                      const listed: ConnectorSkill[] = [];
                      const uris = new Set<string>();
                      const cursors = new Set<string>();
                      let cursor: string | undefined;
                      let bytes = 0;
                      for (let page = 0; page < MAX_SKILLS; page++) {
                        skillScopeOpen(ctx, state);
                        const result = (yield authInvoke(client, "request", [
                          { method: "skills/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
                          SkillPageSchema,
                          requestOptions(ctx),
                        ])) as SkillPage;
                        bytes += result.bytes;
                        if (bytes > MAX_SERIALIZED_CATALOG_BYTES || listed.length + result.skills.length > MAX_SKILLS) {
                          throw new ConnectorCallError(
                            "connector_call_failed",
                            "Downstream Skills listing exceeds the aggregate limit.",
                          );
                        }
                        for (const skill of result.skills) {
                          if (uris.has(skill.uri))
                            throw new ConnectorCallError(
                              "connector_call_failed",
                              "Downstream Skills listing contains duplicate skill URIs.",
                            );
                          uris.add(skill.uri);
                          listed.push(skill);
                        }
                        if (result.nextCursor === undefined) return listed;
                        if (!result.skills.length || cursors.has(result.nextCursor)) {
                          throw new ConnectorCallError(
                            "connector_call_failed",
                            "Downstream Skills pagination loops or makes no progress.",
                          );
                        }
                        cursors.add(result.nextCursor);
                        cursor = result.nextCursor;
                      }
                      throw new ConnectorCallError(
                        "connector_call_failed",
                        "Downstream Skills listing exceeds the page limit.",
                      );
                    }),
                  ),
                ]) as Effect.Effect<ConnectorSkill[], unknown>,
            ),
            read: authMethod(
              (uri: string, ctx: ConnectorContext) =>
                authCall(withSkillsClient, [
                  ctx,
                  "resources/read",
                  authMethod(
                    (client: Client) =>
                      authInvoke(client, "request", [
                        { method: "resources/read", params: { uri } },
                        skillReadSchema(uri),
                        requestOptions(ctx),
                      ]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>,
                  ),
                ]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>,
            ),
          },
        }
      : {}),
    // Declaring the slot is what makes the rest of the operator surface work:
    // the connection's credential form renders it, the shape check compares
    // against it, and authorize_connector returns the operator handoff rather than
    // an OAuth URL this connector has none of.
    ...(credentialAuth
      ? {
          credential: credentialConfig,
          /**
           * The honest test for a proxy is the catalog: connect with the
           * stored value and count what the downstream serves. Nothing else
           * here is connecta's to verify — the credential's scope, project,
           * and mode are the provider's answer, not ours.
           */
          testCredential: authMethod((value: string, ctx: ConnectorContext) =>
            authFlow<CredentialTestResult>(function* () {
              try {
                const stored = (
                  (yield authCall<string | null | undefined>(ctx.credential?.get, [], ctx.credential)) as
                    | string
                    | null
                    | undefined
                )?.trim();
                if (stored !== value.trim()) {
                  return {
                    ok: false,
                    message:
                      "This connector tests the credential that is currently " +
                      "saved. Save the value first, then test it.",
                  };
                }
                liveListings.add(ctx);
                const tools = (yield authInvoke(connector, "listTools", [ctx])) as ToolDef[];
                return {
                  ok: true,
                  message: `Connected — the downstream served ${tools.length} tool${tools.length === 1 ? "" : "s"}.`,
                };
              } catch (err) {
                return { ok: false, message: msg(err) };
              } finally {
                liveListings.delete(ctx);
                if (!connectorScopeCleanupClaimed(ctx, id))
                  (yield authCall<void>(connector.closeScope, [ctx], connector)) as void | undefined;
              }
            }),
          ),
        }
      : {}),

    // The SDK walks the whole chain and writes one complete result. Intake
    // runs on its public request seam before any page can enter that cache.
    listTools: authMethod((ctx: ConnectorContext) =>
      authFlow<ToolDef[]>(function* () {
        const state = stateFor(ctx);
        // Without a connection in this scope, a complete cached catalog is
        // served as it stands. A live connection reads the same cache through
        // the SDK, and a credential test always lists live.
        const cached =
          state.client || state.connecting || state.authRequired || liveListings.has(ctx)
            ? {}
            : ((yield authCall(cachedCatalog, [ctx])) as Preread & { tools?: Tool[] });
        let clean: ListToolsResult["tools"];
        if (cached.tools) clean = redactCatalog(ctx, cached.tools);
        else {
          const client = (yield authCall(ensureConnected, [ctx, state, cached])) as Client;
          // A credential test must observe the downstream answer itself, never
          // the SDK cache a modern connection reads without any request.
          const options: CacheableRequestOptions = {
            ...requestOptions(ctx),
            ...(liveListings.has(ctx) ? { cacheMode: "bypass" as const } : {}),
          };
          listingContexts.set(options, ctx);
          try {
            const result = (yield authInvoke(client, "listTools", [undefined, options])) as ListToolsResult;
            clean = redactCatalog(ctx, result.tools);
          } catch (err) {
            if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
            const bounded = atMcpBoundary(ctx, err, "tools/list", client.transport, [ctx.signal]);
            if (requiresAuthorization(bounded)) {
              if (state.client === client) state.authRequired = true;
              if (bounded instanceof UnauthorizedError) throw carryFailureFacts(bounded, authRequiredError());
            }
            throw bounded;
          } finally {
            listingContexts.delete(options);
          }
        }
        state.toolDefinitions = new Map(clean.map((tool: Tool) => [tool.name, tool]));
        return clean.map((t: Tool) => ({
          name: t.name,
          ...(t.title !== undefined ? { title: t.title } : {}),
          ...(t.icons !== undefined
            ? {
                icons: t.icons.filter((icon) => !/^data:/i.test(icon.src)) as NonNullable<ToolDef["icons"]>,
              }
            : {}),
          ...(t.execution !== undefined ? { execution: t.execution as NonNullable<ToolDef["execution"]> } : {}),
          ...(t.description !== undefined ? { description: t.description } : {}),
          ...(t.inputSchema !== undefined
            ? {
                inputSchema: t.inputSchema as NonNullable<ToolDef["inputSchema"]>,
              }
            : {}),
          ...(t.outputSchema !== undefined
            ? {
                outputSchema: t.outputSchema as NonNullable<ToolDef["outputSchema"]>,
              }
            : {}),
          ...(t.annotations !== undefined
            ? {
                annotations: t.annotations as NonNullable<ToolDef["annotations"]>,
              }
            : {}),
        }));
      }),
    ),

    callTool: authMethod(
      (
        name: string,
        args: unknown,
        ctx: ConnectorContext,
        options:
          | {
              definition?: ToolDef;
              input?:
                | {
                    requestState?: string;
                    inputResponses: Record<string, unknown>;
                  }
                | undefined;
            }
          | undefined,
      ) =>
        authFlow<CallToolResult>(function* () {
          enterProviderBoundary(ctx, connector);
          let active:
            | {
                state: ConnectionState;
                client: Client;
                dispatch: CallDispatch;
                write: boolean;
              }
            | undefined;
          try {
            return (yield authView(
              ctx,
              authMethod(() =>
                authFlow<CallToolResult>(function* () {
                  const state = stateFor(ctx);
                  const client = (yield authCatch(authCall(ensureConnected, [ctx, state]), (error: unknown) => {
                    throw knownProviderFailure(error);
                  })) as Client;
                  if (isOauth)
                    (yield authCatch(authCall(renewBeforeDispatch, [ctx, state, client]), (error: unknown) => {
                      throw knownProviderFailure(error);
                    })) as void;
                  const definition = options?.definition;
                  const facts = definition ?? state.toolDefinitions.get(name) ?? { name };
                  const sourceFacts = definition ?? {
                    name,
                    ...(facts.annotations
                      ? { annotations: facts.annotations as NonNullable<ToolDef["annotations"]> }
                      : {}),
                  };
                  const source = sourceClassification(sourceFacts);
                  const serverWrite = source === "write";
                  const write =
                    serverWrite || (callClassification(ctx) ?? definition?.classification ?? source) === "write";
                  const dispatch = newDispatch(write, serverWrite);
                  dispatch.request = {
                    entry: providerRequest(ctx, !write, `Connector "${id}"'s MCP server`, { method: "POST" }),
                    ctx,
                  };
                  active = { state, client, dispatch, write };
                  state.dispatches.set(dispatch, name);
                  const toolDefinition = definition
                    ? {
                        ...definition,
                        inputSchema: (definition.inputSchema ?? { type: "object" }) as Tool["inputSchema"],
                      }
                    : state.toolDefinitions.get(name);
                  if (toolDefinition?.execution?.taskSupport === "required") {
                    throw new ConnectorCallError(
                      "connector_call_failed",
                      `Tool "${name}" requires task-based execution, which Connecta does not support.`,
                    );
                  }
                  let output: StandardSchemaV1 | undefined;
                  const outputError = (code: number, message: string): unknown =>
                    atMcpBoundary(ctx, new ProtocolError(code, message), "tools/call", client.transport, [ctx.signal]);
                  if (toolDefinition?.outputSchema) {
                    try {
                      output = fromJsonSchema(toolDefinition.outputSchema as JsonSchemaType);
                    } catch {
                      throw outputError(
                        -32602,
                        `Tool '${name}' has an invalid outputSchema: schema could not be compiled`,
                      );
                    }
                  }
                  const result = (yield authCatch(
                    authInvoke(client, "callTool", [
                      withDispatch(
                        {
                          name,
                          arguments: (args ?? {}) as Record<string, unknown>,
                          ...options?.input,
                        },
                        dispatch,
                      ),
                      {
                        ...requestOptions(ctx),
                        allowInputRequired: true,
                        ...(toolDefinition
                          ? { toolDefinition: { ...toolDefinition, outputSchema: undefined } }
                          : write
                            ? { toolDefinition: { name, inputSchema: { type: "object" } as Tool["inputSchema"] } }
                            : {}),
                      },
                    ]),
                    (err: unknown) => {
                      assertDownstreamOutputSafe(ctx.requestScope ?? ctx, err);
                      throw atMcpBoundary(ctx, err, "tools/call", client.transport, [ctx.signal]);
                    },
                  )) as CallToolResult;
                  if (isInputRequiredResult(result)) {
                    return result;
                  }
                  assertDownstreamOutputSafe(ctx.requestScope ?? ctx, result);
                  if (output && !result.isError) {
                    if (result.structuredContent === undefined)
                      throw outputError(
                        -32600,
                        `Tool ${name} has an output schema but did not return structured content`,
                      );
                    const validation = (yield authInvoke(output["~standard"], "validate", [
                      result.structuredContent,
                    ])) as StandardSchemaV1.Result<unknown>;
                    if (validation.issues)
                      throw outputError(
                        -32602,
                        "Structured content does not match the tool's output schema: validation failed",
                      );
                  }
                  return result;
                }),
              ),
            )) as CallToolResult;
          } catch (err) {
            if (!active) throw knownProviderFailure(err);
            const { state, client, dispatch, write } = active;
            const direct = write && callClassification(ctx) === undefined;
            const ownAbort = ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err);
            // The SDK can reject its wait synchronously from the abort event,
            // before the physical response's Promise observer records its facts.
            // Yield only settlement; no closed caller regains live authority.
            if (ownAbort) yield Effect.yieldNow;
            if (ownAbort && !direct) throw err;
            if (requiresAuthorization(err) && state.client === client) state.authRequired = true;
            const failure = ownAbort
              ? err
              : err instanceof UnauthorizedError
                ? carryFailureFacts(err, authRequiredError())
                : downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
            if (!write) throw failure;
            const renewal = dispatch.request?.entry.renewed
              ? undefined
              : dispatch.resendRefused
                ? authRequiredError()
                : failure;
            const unsent = (entry: ProviderRequest | undefined) => {
              const verdict = unsentAfterUnauthorized(
                `Connector "${id}"'s MCP server`,
                renewal,
                isOauth ? "downstream_oauth_required" : "auth_required",
              );
              return entry ? vendorRefusal(verdict, entry) : verdict;
            };
            const verdict = dispatch.unauthorized
              ? unsent(dispatch.request?.entry)
              : dispatch.redirected || dispatch.resendRefused
                ? new ConnectorCallError(
                    "connector_call_failed",
                    `Connector "${id}"'s MCP server ` +
                      (dispatch.redirected
                        ? "answered this write with a redirect, and the write was not sent again, "
                        : "was sent this write, and a second send of it was stopped, ") +
                      "so whether it took effect is unknown: check the target before repeating it.",
                    { retryable: false, writeOutcome: "unknown" },
                  )
                : failure;
            const vendor = { title: `connector "${id}"` };
            const status = failureRecord({}, err).httpStatus;
            const settled = providerCallFailure(ctx, vendor, verdict, {
              dispatched: dispatch.sent,
              ...(status === undefined ? {} : { status }),
              fallback: "write",
              request: dispatch.request?.entry,
            });
            throw settled === failure ? failure : carryFailureFacts(failure, settled);
          } finally {
            if (active) active.state.dispatches.delete(active.dispatch);
          }
        }),
    ),

    readResource: authMethod((uri: string, ctx: ConnectorContext) =>
      authFlow<ReadResourceResult>(function* () {
        const state = stateFor(ctx);
        const client = (yield authCall(ensureConnected, [ctx, state])) as Client;
        try {
          const options = requestOptions(ctx) ?? {};
          listingContexts.set(options, ctx);
          try {
            if (!client.getServerCapabilities()?.resources) throw unadvertisedResource();
            const resources = (yield authInvoke(client, "listResources", [undefined, options])) as ListResourcesResult;
            const templates = (yield authInvoke(client, "listResourceTemplates", [
              undefined,
              options,
            ])) as ListResourceTemplatesResult;
            const exact = resources.resources.some(
              (resource: ListResourcesResult["resources"][number]) => resource.uri === uri,
            );
            if (!exact) {
              const match = resourceUriMatchesTemplates(
                uri,
                templates.resourceTemplates,
                (code: ResourceTemplateRefusal) => resourceTemplateRefusals.add(code),
              );
              if (!match.matched) {
                if (match.refusal)
                  throw new ConnectorCallError(
                    match.refusal,
                    match.refusal === "resource_template_ambiguous"
                      ? "The advertised resource templates have ambiguous expression boundaries."
                      : "Resource template matching exceeds the read work limit.",
                    { retryable: false },
                  );
                throw unadvertisedResource();
              }
            }
          } catch (err) {
            throw atMcpBoundary(ctx, err, "resources/read", client.transport, [ctx.signal]);
          } finally {
            listingContexts.delete(options);
          }
          const result = (yield authCatch(
            authInvoke(client, "readResource", [
              { uri },
              {
                ...requestOptions(ctx),
                cacheMode: "bypass",
                allowInputRequired: true,
              },
            ]),
            (err: unknown) => {
              if (err instanceof ResourceNotFoundError) {
                throw new ConnectorCallError("not_found", "The downstream resource does not exist.");
              }
              throw atMcpBoundary(ctx, err, "resources/read", client.transport, [ctx.signal]);
            },
          )) as ReadResourceResult;
          if (isInputRequiredResult(result)) {
            throw new ConnectorCallError(
              "input_required_unsupported",
              "Resource reads inside programs cannot request mid-call input.",
            );
          }
          return result;
        } catch (err) {
          if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
          if (requiresAuthorization(err)) {
            if (state.client === client) state.authRequired = true;
            if (err instanceof UnauthorizedError) throw carryFailureFacts(err, authRequiredError());
          }
          throw downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
        }
      }),
    ),

    closeScope: authMethod((ctx: ConnectorContext) =>
      authFlow<void>(function* () {
        // Revocation and all finalizers start before any caller guard. Cleanup
        // retains its own bounded settlement even after the request has closed.
        const state = entryFor(ctx);
        const release = Scope.closeUnsafe(state.scope, Exit.void);
        const cacheClosing = closeCatalogCacheScope(ctx, id, cacheOwner);
        reset(state);
        const closing = runEdge(
          Effect.all(
            [
              release ?? Effect.void,
              cacheClosing
                ? Effect.raceAllFirst([
                    Effect.promise(() => cacheClosing),
                    Effect.sleep(Duration.millis(LOCAL_CLOSE_BUDGET_MS)),
                  ])
                : Effect.void,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.asVoid),
        );
        void closing.catch(() => {});
        if (viewSignal(ctx, true).aborted) return yield authValue(() => closing);
        return yield authView<void>(
          ctx,
          authMethod(() => authValue(() => closing)),
          true,
        );
      }),
    ),

    status: authMethod((ctx: ConnectorContext) =>
      authFlow<ConnectorStatus>(function* () {
        if (principalPolicy && !callerOf(ctx)?.authenticated)
          return ownStatus({ state: "per_caller", message: "Authenticates as each caller; verified on use." });
        const state = stateFor(ctx);
        const report = authMethod((status: ConnectorStatus) =>
          authFlow<ConnectorStatus>(function* () {
            const path = isOauth
              ? ((yield authInvoke(newProvider(ctx, state), "registrationPath", [])) as
                  | "cimd"
                  | "dcr"
                  | "static"
                  | undefined)
              : undefined;
            return ownStatus({
              ...status,
              ...(path ? { registrationPath: path } : {}),
              ...(resourceTemplateRefusals.size ? { resourceTemplateRefusals: [...resourceTemplateRefusals] } : {}),
            });
          }),
        );
        try {
          const client = (yield authCall(ensureConnected, [ctx, state])) as Client;
          // The grant decides, as it does for a call: a downstream that
          // answers without credentials is not connected for this owner.
          if (isOauth && !((yield authCall(granted, [connectedProviders.get(client)!])) as boolean))
            return (yield authCall(report, [
              { state: "auth_required", message: "Authorization required \u2014 open the URL to connect." },
            ])) as ConnectorStatus;
          return (yield authCall(report, [{ state: "ok" }])) as ConnectorStatus;
        } catch (err) {
          if (err instanceof CredentialRequiredError) {
            return (yield authCall(report, [{ state: "auth_required", message: err.message }])) as ConnectorStatus;
          }
          if (err instanceof OperatorDisconnectedError) {
            return (yield authCall(report, [{ state: "auth_required", message: err.message }])) as ConnectorStatus;
          }
          if (
            state.authRequired ||
            (err instanceof ConnectorCallError &&
              err.code === "auth_required" &&
              !(err instanceof UnresolvedTokenError))
          ) {
            return (yield authCall(report, [
              {
                state: "auth_required",
                message: credentialAuth
                  ? "Authorization required \u2014 the downstream rejected this connector's stored credential."
                  : "Authorization required \u2014 open the URL to connect.",
              },
            ])) as ConnectorStatus;
          }
          return failureStatus(id, err);
        }
      }),
    ),
  };

  if (isOauth) {
    connector.finishAuth = authMethod(
      (code: string, ctx: ConnectorContext, callbackParams: URLSearchParams) =>
        authView(
          ctx,
          authMethod((signal: AbortSignal) =>
            authFlow<void>(function* () {
              const state = stateFor(ctx);
              const provider = newProvider(ctx, state);
              const consent = callbackParams?.get("state") ?? null;
              if (!consent || !((yield authInvoke(provider, "verifyCallbackState", [consent])) as boolean)) {
                throw new ConnectorCallError(
                  "connector_call_failed",
                  `Connector "${id}" authorization callback matches no pending consent; nothing was exchanged.`,
                );
              }
              provider.validateCallbackIssuer(callbackParams?.get("iss") ?? null);
              (yield authInvoke(provider, "bindFlow", [])) as void;
              signal.throwIfAborted();
              const t = buildTransport(ctx, provider, null, signal, null, true) as StreamableHTTPClientTransport;
              const trail: OAuthTrail = {};
              const internals = t as unknown as {
                _fetchWithInit?: FetchLike;
              };
              const traced = tracedOAuthFetch(trail, new URL(opts.url), internals._fetchWithInit ?? fetch);
              const exchange = new Proxy(t, {
                get: (target: StreamableHTTPClientTransport, key: string | symbol) =>
                  key === "_fetchWithInit" ? traced : Reflect.get(target, key, target),
                set: (target: StreamableHTTPClientTransport, key: string | symbol, value: any) =>
                  Reflect.set(target, key, value, target),
              });
              try {
                (yield authInvoke(exchange, "finishAuth", [callbackParams])) as void;
                closeHalf(state);
              } catch (err) {
                throw (yield authCall(withoutAuthorizationServerText, [
                  ctx,
                  err,
                  trail,
                  [signal, ctx.signal],
                ])) as unknown;
              } finally {
                detach(closeConnection(null, t, ctx.logger));
              }
            }),
          ),
          true,
        ) as Effect.Effect<void, unknown>,
    );

    connector.verifyState = authMethod((oauthState: string | null, ctx: ConnectorContext) =>
      authFlow<boolean>(function* () {
        const state = stateFor(ctx);
        return (yield authInvoke(newProvider(ctx, state), "verifyState", [oauthState])) as boolean;
      }),
    );

    connector.verifyCallbackIssuer = authMethod((issuer: string | null, ctx: ConnectorContext) =>
      Effect.try({
        try: () => {
          newProvider(ctx, stateFor(ctx)).validateCallbackIssuer(issuer);
          return true as const;
        },
        catch: (error) => error,
      }),
    );

    connector.consumeAuthError = authMethod((ctx: ConnectorContext) =>
      authFlow<void>(function* () {
        (yield authInvoke(newProvider(ctx, stateFor(ctx)), "consumeAuthError", [])) as void;
      }),
    );

    connector.disconnectAuth = authMethod((ctx: ConnectorContext) =>
      authFlow<void>(function* () {
        (yield authCall(disconnectAuthorization, [ctx, stateFor(ctx), true])) as void;
      }),
    );

    connector.startAuth = authMethod(
      (
        ctx: ConnectorContext,
        startOpts:
          | {
              force?: boolean;
            }
          | undefined,
      ) =>
        authFlow<ConnectorStatus>(function* () {
          ctx = authorizingContext(ctx);
          const state = stateFor(ctx);
          state.provider = null;
          const p = newProvider(ctx, state);
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          const disconnected = startOpts?.force
            ? false
            : ((yield authInvoke(p, "operatorDisconnected", [])) as boolean);
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          if (startOpts?.force || disconnected) {
            (yield authCall(disconnectAuthorization, [ctx, state, false, startOpts?.force === true])) as void;
          } else {
            const pending = (yield authInvoke(p, "reusablePendingAuthorizationUrl", [])) as string | undefined;
            if (pending) {
              return {
                state: "auth_required",
                authorizationUrl: pending,
                authorizationReused: true,
                message: "Authorization required \u2014 open the URL to connect.",
              };
            }
          }
          if (ctx.signal?.aborted) throw ctx.signal.reason;
          try {
            // A passive call's refusal stays latched for status and calls. A
            // successful connection with no tokens still permits explicit
            // consent, bound to that connection rather than the live grant.
            if (state.authRequired && state.client) {
              const provider = connectedProviders.get(state.client)!;
              if (!((yield authCall(granted, [provider])) as boolean))
                return (yield authCall(startUnchallenged, [ctx, provider])) as ConnectorStatus;
            }
            // The handshake runs first, so a 401 challenge's
            // `resource_metadata` starts consent as it always has.
            const client = (yield authCall(ensureConnected, [ctx, state])) as Client;
            const provider = connectedProviders.get(client)!;
            if (!((yield authCall(granted, [provider])) as boolean))
              return (yield authCall(startUnchallenged, [ctx, provider])) as ConnectorStatus;
            return {
              state: "ok",
              message: "Already authorized \u2014 connection is healthy.",
            };
          } catch (err) {
            if (state.authRequired && requiresAuthorization(err)) {
              let authorizationUrl: string | undefined;
              try {
                authorizationUrl = (yield state.attemptProvider
                  ? authInvoke<string | undefined>(state.attemptProvider, "consentUrl", [viewSignal(ctx, true)])
                  : Effect.succeed(undefined)) as string | undefined;
              } catch (readErr) {
                return { state: "error", message: startMessage(readErr) };
              }
              return {
                state: "auth_required",
                ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
                message: "Authorization required \u2014 open the URL to connect.",
              };
            }
            return { state: "error", message: startMessage(err) };
          }
        }),
    );
  }

  const retainOperation = <Args extends unknown[], A>(
    operation: (...args: Args) => Promise<A>,
    contextIndex: number,
  ): ((...args: Args) => Promise<A>) =>
    authMethod((...args: Args) =>
      authFlow<A>(function* () {
        const release = retainOAuthPartition(oauthPartitionFor(args[contextIndex] as ConnectorContext));
        try {
          return yield authCall<A>(operation, args);
        } finally {
          release();
        }
      }),
    );

  const withActiveSecrets = authMethod(
    <T>(ctx: ConnectorContext, run: () => Promise<T>, redactResult: boolean = true, preserveInput: boolean = false) =>
      authFlow<T>(function* () {
        wrapViewCredentials(ctx);
        const secrets = sentSecretsFor(ctx);
        if (opts.auth?.type === "headers") {
          for (const value of Object.values(opts.auth.headers)) secrets.header(value);
        }
        const state = entryFor(ctx);
        let active = activeContexts.get(state);
        if (!active) {
          active = new Set();
          activeContexts.set(state, active);
        }
        active.add(ctx);
        try {
          const result = (yield authCall(run, [])) as Awaited<T>;
          if (!preserveInput || !isInputRequiredResult(result))
            assertDownstreamOutputSafe(ctx.requestScope ?? ctx, result);
          return (preserveInput && isInputRequiredResult(result)) || !redactResult
            ? result
            : redactSentSecrets(ctx, result);
        } catch (error) {
          assertDownstreamOutputSafe(ctx.requestScope ?? ctx, error);
          throw requestSentSecrets(ctx).redact(error);
        } finally {
          active.delete(ctx);
        }
      }),
  );
  const callTool = connector.callTool;
  connector.callTool = authMethod(
    (
      name: string,
      args: unknown,
      ctx: ConnectorContext,
      options:
        | {
            definition?: ToolDef;
            input?:
              | {
                  requestState?: string;
                  inputResponses: Record<string, unknown>;
                }
              | undefined;
          }
        | undefined,
    ) =>
      authCall(withActiveSecrets, [
        ctx,
        authMethod(() => authCall(callTool, [name, args, ctx, options]) as Effect.Effect<unknown, unknown>),
        true,
        true,
      ]) as Effect.Effect<unknown, unknown>,
  );
  const listTools = connector.listTools;
  connector.listTools = authMethod(
    (ctx: ConnectorContext) =>
      authCall(withActiveSecrets, [
        ctx,
        authMethod(() => authCall(listTools, [ctx]) as Effect.Effect<ToolDef[], unknown>),
      ]) as Effect.Effect<ToolDef[], unknown>,
  );
  const readResource = connector.readResource!;
  connector.readResource = authMethod(
    (uri: string, ctx: ConnectorContext) =>
      authCall(withActiveSecrets, [
        ctx,
        authMethod(() => authCall(readResource, [uri, ctx]) as Effect.Effect<unknown, unknown>),
      ]) as Effect.Effect<unknown, unknown>,
  );
  if (connector.downstreamSkills) {
    const { list, read } = connector.downstreamSkills;
    connector.downstreamSkills.list = authMethod(
      (ctx: ConnectorContext) =>
        authCall(withActiveSecrets, [
          ctx,
          authMethod(() => authCall(list, [ctx]) as Effect.Effect<ConnectorSkill[], unknown>),
          false,
        ]) as Effect.Effect<ConnectorSkill[], unknown>,
    );
    connector.downstreamSkills.read = authMethod(
      (uri: string, ctx: ConnectorContext) =>
        authCall(withActiveSecrets, [
          ctx,
          authMethod(() => authCall(read, [uri, ctx]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>),
          false,
        ]) as Effect.Effect<ConnectorSkillResourceContents[], unknown>,
    );
  }

  if (isOauth && !staticClient && clientMetadataUrl === undefined) declareSelfHostedClient(connector, oauthScope);
  if (isOauth) {
    const start = connector.startAuth!;
    connector.startAuth = authMethod((...args: Parameters<NonNullable<Connector["startAuth"]>>) =>
      authFlow<ConnectorStatus>(function* () {
        const status = (yield authCall(start, [...args])) as ConnectorStatus;
        const path = (yield authInvoke(newProvider(args[0], stateFor(args[0])), "registrationPath", [])) as
          | "cimd"
          | "dcr"
          | "static"
          | undefined;
        return { ...status, ...(path ? { registrationPath: path } : {}) };
      }),
    );
  }
  // Every published Promise operation owns its whole wait, including local
  // storage, digest, registration-path and result processing seams. callTool
  // settles inside its write decider; closeScope starts cleanup before racing
  // the join, and finishAuth already owns its request-scoped exchange boundary.
  const settlingOperation = <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
    contextIndex: number,
    requestOwned = false,
  ): ((...args: Args) => Promise<Result>) =>
    authMethod((...args: Args) =>
      authFlow<Result>(function* () {
        const ctx = args[contextIndex] as ConnectorContext;
        const state = states.get(Context.get(viewServices(ctx), RequestScope));
        if (state && isClosed(state)) return (yield Effect.fail(scopeEndedError())) as Awaited<Result>;
        return (yield authView(
          ctx,
          authMethod(() => authCall(operation, [...args]) as Effect.Effect<Result, unknown>),
          requestOwned,
        )) as Awaited<Result>;
      }),
    );
  connector.listTools = settlingOperation(connector.listTools, 0);
  connector.readResource = settlingOperation(connector.readResource!, 1);
  if (connector.downstreamSkills) {
    connector.downstreamSkills.list = settlingOperation(connector.downstreamSkills.list, 0);
    connector.downstreamSkills.read = settlingOperation(connector.downstreamSkills.read, 1);
  }
  const status = connector.status!;
  connector.status = authMethod(
    (ctx: ConnectorContext) =>
      authCatch(
        authView(
          ctx,
          authMethod(() => authCall(status, [ctx]) as Effect.Effect<ConnectorStatus, unknown>),
        ),
        (error: any) => failureStatus(id, error),
      ) as Effect.Effect<ConnectorStatus, unknown>,
  );
  if (connector.testCredential) connector.testCredential = settlingOperation(connector.testCredential, 1);
  if (isOauth) {
    connector.startAuth = settlingOperation(connector.startAuth!, 0);
    connector.disconnectAuth = settlingOperation(connector.disconnectAuth!, 0);
    connector.verifyState = settlingOperation(connector.verifyState!, 1, true);
    connector.verifyCallbackIssuer = settlingOperation(connector.verifyCallbackIssuer!, 1, true);
    connector.consumeAuthError = settlingOperation(connector.consumeAuthError!, 0, true);
    // Pin before the first asynchronous storage/discovery read, not only once
    // a refresh flight exists. These operations do not take call admission.
    const retain = retainOperation;
    connector.listTools = retain(connector.listTools, 0);
    connector.callTool = retain(connector.callTool, 2);
    connector.readResource = retain(connector.readResource, 1);
    if (connector.downstreamSkills) {
      connector.downstreamSkills.list = retain(connector.downstreamSkills.list, 0);
      connector.downstreamSkills.read = retain(connector.downstreamSkills.read, 1);
    }
    connector.status = retain(connector.status!, 0);
    connector.startAuth = retain(connector.startAuth!, 0);
    connector.disconnectAuth = retain(connector.disconnectAuth!, 0);
    connector.verifyState = retain(connector.verifyState!, 1);
    connector.verifyCallbackIssuer = retain(connector.verifyCallbackIssuer!, 1);
    connector.consumeAuthError = retain(connector.consumeAuthError!, 0);
    connector.finishAuth = retain(connector.finishAuth!, 1);
  }
  connector.listTools = payloadFree(connector.listTools);
  connector.callTool = payloadFree(connector.callTool);
  connector.readResource = payloadFree(connector.readResource);
  if (connector.downstreamSkills) {
    connector.downstreamSkills.list = payloadFree(connector.downstreamSkills.list);
    connector.downstreamSkills.read = payloadFree(connector.downstreamSkills.read);
  }
  if (connector.startAuth) connector.startAuth = payloadFree(connector.startAuth);
  if (connector.finishAuth) connector.finishAuth = payloadFree(connector.finishAuth);
  // This boundary's identity in a logical call: this object with its
  // published, fully wrapped function, fixed now, never what the property or
  // a copy holds by then.
  providerBoundary(connector);
  const ownCall = connector.callTool;
  registerCallEntry(connector, (name, args, ctx, options) => authCall(ownCall, [name, args, ctx, options]));
  if (isOauth)
    registerInvocationAuth(
      connector,
      retainOperation(
        settlingOperation(
          authMethod((ctx: ConnectorContext) =>
            authFlow<void>(function* () {
              const provider = newProvider(ctx, stateFor(ctx));
              if ((yield authInvoke(provider, "operatorDisconnected", [])) as boolean)
                throw operatorDisconnectedError();
              if (
                !((yield authInvoke(provider, "tokens", [])) as
                  | {
                      access_token: string;
                      token_type: string;
                      id_token?: string | undefined;
                      expires_in?: number | undefined;
                      scope?: string | undefined;
                      refresh_token?: string | undefined;
                      issuer?: string | undefined;
                    }
                  | undefined)
              )
                throw authRequiredError();
              // That read decides whether the token is about to expire.
              const due = provider.renewalDue();
              if (due !== undefined) (yield authCall(renewBeforeCall, [ctx, due])) as void;
            }),
          ),
          0,
        ),
        0,
      ),
    );
  if (isOauth) withStoredAuth(connector, (ctx) => newProvider(ctx).storedAuthorization());
  if (principalPolicy) tagPrincipalForwarding(connector);
  return connector;
}
