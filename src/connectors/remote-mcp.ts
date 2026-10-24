import { deriveContext } from "../derived-context.js";
import { duringViewCall, operationContext, openRequest, settleOnClose, viewSignal } from "../runtime/call.js";
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
  specTypeSchemas,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  FetchLike,
  JsonSchemaType,
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
  trackCredentialReads,
  type SentSecrets,
} from "../sent-secrets.js";
import { MAX_CATALOG_TOOLS, MAX_SERIALIZED_CATALOG_BYTES } from "../catalog-limits.js";
import {
  catalogClientOptions,
  catalogItems,
  observeCompletedCatalogRefresh,
  type CatalogMethod,
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
import { retainingOAuthPartition } from "../oauth-partition.js";
import { registerInvocationAuth } from "../invocation-auth.js";
import {
  downstreamInputCapabilities,
  assertDownstreamOutputSafe,
  downstreamWriteContinuation,
} from "../downstream-input-context.js";
import { detach, runEdge } from "../runtime/run.js";
import { assertKnownOptions, keys, optionsOf, strings } from "../config-schema.js";
import { describedEndpoint, describedUrl } from "../described.js";
import { retryAfterMs } from "../http-policy.js";
import { resourceUriMatchesTemplates, type ResourceTemplateRefusal } from "./resource-uri.js";
import { callerOf } from "../connector-caller.js";
import { callClassification } from "../call-classification.js";
import { guardedTransport } from "../guarded-transport.js";
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

export type RemoteMcpAuth =
  | {
      type: "request";
      /** Resolve a Bearer token inside this request. Never persisted or described. */
      token: (ctx: ConnectorContext) => Promise<string>;
      /** Static protocol/catalog headers, never Authorization. */
      headers?: Record<string, string>;
    }
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
   * resource URL path; echoed values are redacted at eight characters or more.
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
function skillTextBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function skillObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillJsonBytes(value: unknown): number {
  return skillTextBytes(JSON.stringify(value));
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
        if (
          typeof content.text === "string" &&
          !("blob" in content) &&
          skillTextBytes(content.text) <= MAX_SKILL_BYTES
        ) {
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
    promised(() => Promise.resolve(Reflect.apply(terminate, transport, []))).pipe(
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
    promised(() => Promise.resolve(client ? client.close() : transport?.close())).pipe(Effect.ignore),
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
  return Effect.tryPromise({ try: evaluate, catch: (error) => error });
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
  return async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      throw hasSdkPayload(error) ? carryFailureFacts(error, downstreamCallError(error)) : error;
    }
  };
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
 * Hex SHA-256 of a credential, used only to notice that a cached client
 * connected with a value the vault no longer holds. WebCrypto rather than a
 * `node:` hash: the whole core has to keep running unchanged on Workers.
 */
async function digestOf(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
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
  return async (input, initialInit = {}) => {
    let current = new URL(input);
    let init = initialInit;
    const seen = new Set<string>([current.href]);
    let hops = 0;

    while (true) {
      let response: Response;
      try {
        response = await baseFetch(current, {
          ...init,
          redirect: "manual",
        });
      } catch (cause) {
        if (cause instanceof ConnectorCallError) throw downstreamCallError(cause);
        throw unavailableCallError(
          cause,
          current.href,
          undefined,
          hasSdkPayload(cause) ? undefined : (init.signal ?? undefined),
        );
      }
      // Every MCP and OAuth exchange reads its answer through here, and the
      // SDK reads bodies with `.text()` and `.json()`: as bytes, never text.
      if (!REDIRECT_STATUSES.has(response.status)) return byteReadResponse(response);

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
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
  };
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
  return async (input, init) => {
    const reason = learnedUrlRefusal(configured, new URL(input));
    if (reason !== undefined) {
      throw new RemoteMcpDestinationError(connectorId, reason);
    }
    return byteReadResponse(await baseFetch(input, init));
  };
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
  return async (input, init) => {
    const url = new URL(input);
    if (url.href === endpoint.href) {
      trail.last = undefined;
    } else {
      const body = init?.body;
      const step: OAuthStep =
        (init?.method ?? "GET").toUpperCase() === "GET"
          ? "discovery"
          : body instanceof URLSearchParams || (typeof body === "string" && new URLSearchParams(body).has("grant_type"))
            ? "token request"
            : "client registration";
      trail.last = { step, host: url.origin };
      if (step === "client registration") trail.registration = url.origin;
    }
    const leg = trail.last;
    const response = await baseFetch(input, init);
    if (leg) {
      leg.httpStatus = response.status;
      const wait = retryAfterMs(response.headers);
      if (wait !== undefined) leg.retryAfterMs = wait;
    }
    return byteReadResponse(response);
  };
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
  const cacheOwner = {};
  // A cached transport may dispatch concurrent calls and listings. Register
  // its actual sent auth with every operation using that client, including
  // handshake/discovery requests and OAuth rotations. Remove settled users.
  const activeContexts = new WeakMap<ConnectionState, Set<ConnectorContext>>();
  const trackSentRequest = (ctx: ConnectorContext, input: RequestInfo | URL, init?: RequestInit): void => {
    const active = activeContexts.get(entryFor(ctx));
    const recipients = new Set([sentSecretsFor(ctx), ...[...(active ?? [])].map(sentSecretsFor)]);
    for (const secrets of recipients) {
      if (opts.auth?.type === "oauth") trackRemoteClientRequest(secrets, input, init);
      else secrets.request(input, init);
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
  const requestAuth = opts.auth?.type === "request" ? opts.auth : undefined;
  if (requestAuth && (typeof requestAuth.token !== "function" || opts.authScope === "personal")) {
    throw new Error(`remoteMcp(${JSON.stringify(id)}) requires a request token callback and shared authScope.`);
  }
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
  const withoutAuthorizationServerText = async (
    ctx: ConnectorContext,
    err: unknown,
    trail: OAuthTrail,
    signals: readonly (AbortSignal | undefined)[],
  ): Promise<unknown> => {
    const safeOrigin = async (host: string | undefined): Promise<string | undefined> => {
      if (!host || sentSecretsFor(ctx).contains(host, true)) return undefined;
      if (host === destination.origin || (staticClient && host === new URL(staticClient.issuer).origin)) return host;
      try {
        return host === (await newProvider(ctx).validatedIssuerOrigin()) ? host : undefined;
      } catch {
        return undefined;
      }
    };
    if (ownAbortReason(err, signals) && !hasSdkPayload(err)) return err;
    if (err instanceof RegistrationRejectedError) {
      const code = registrationErrorCode(err.body);
      const origin = await safeOrigin(trail.registration);
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
    const origin = await safeOrigin(leg?.host);
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
  };

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
    const flow = async <T>(
      start: (trace: (fetchFn: FetchLike) => FetchLike) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> => {
      const trail: OAuthTrail = {};
      try {
        return await start((fetchFn) =>
          tracedOAuthFetch(trail, endpoint, async (input, init) => {
            trackSentRequest(ctx, input, init);
            return await fetchFn(
              input,
              signal
                ? {
                    ...init,
                    signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                  }
                : init,
            );
          }),
        );
      } catch (err) {
        throw await withoutAuthorizationServerText(ctx, err, trail, [...signals, signal]);
      }
    };
    adapted.onUnauthorized = (ctx) =>
      flow(
        (trace) => Reflect.apply(onUnauthorized, adapted, [{ ...ctx, fetchFn: trace(ctx.fetchFn ?? fetch) }]),
        renewalSignal(ctx.response),
      );
    internals._stepUpAuthorize = (challenge, retries) =>
      flow((trace) => {
        const traced = trace(internals._fetchWithInit ?? fetch);
        // The step-up reads its fetch from `this`; everything else it reads
        // and writes stays the transport's own.
        const self = new Proxy(transport, {
          get: (target, key) => (key === "_fetchWithInit" ? traced : Reflect.get(target, key, target)),
          set: (target, key, value) => Reflect.set(target, key, value, target),
        });
        return Reflect.apply(stepUp, self, [challenge, retries]);
      });
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
   * Read this request's credential. Called before every connect and before
   * trusting any cached client, so an operator's replacement is picked up
   * without a redeploy. The value stays in the caller's local scope.
   */
  const readCredential = async (ctx: ConnectorContext): Promise<string> => {
    if (requestAuth) {
      let value: string;
      try {
        value = await requestAuth.token(ctx);
      } catch (error) {
        if (error instanceof ConnectorCallError) throw error;
        throw new ConnectorCallError("auth_required", "The request token could not be resolved.");
      }
      ctx.signal?.throwIfAborted();
      if (
        typeof value !== "string" ||
        !value.trim() ||
        Array.from(value).some((char) => {
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
    // A stored-shape mismatch already arrives as a typed auth_required from
    // the registry's accessor; nothing to reclassify here.
    const value = (await ctx.credential.get())?.trim();
    if (!value) {
      throw new CredentialRequiredError(
        `Connector "${id}" has no stored credential — call ` +
          `authorize_connector({ connector: "${id}" }) and follow the ` +
          "operator handoff it returns.",
      );
    }
    // Refuse a value a header cannot carry BEFORE anything frames it. A
    // wrapped newline in a pasted key is the ordinary way this happens, and
    // the runtime that rejects the header quotes the whole value back in its
    // TypeError — a message that travels to status, to the activity log, and
    // to the agent. So the check lives here, and says only what is wrong.
    if (carriesIllegalHeaderChar(value)) {
      throw new CredentialRequiredError(
        `Connector "${id}"'s stored credential contains a character a header ` +
          "cannot carry (a line break or other control character). Call " +
          "authorize_connector for recovery options. When available, re-enter " +
          "it in this connection in the operator UI. The value is not shown or logged.",
      );
    }
    return value;
  };

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
    client.listTools = (params, options) =>
      cache.withListing(listingContext(options), async () => {
        const before = toolPages;
        let result: ListToolsResult;
        try {
          result = await listTools(params, options);
        } catch (error) {
          const bounded = atMcpBoundary(cache.currentContext(), error, "tools/list", client.transport, [
            cache.currentContext().signal,
          ]);
          const transient =
            (error instanceof SdkHttpError && [502, 503, 504].includes(error.status)) ||
            (bounded instanceof ConnectorCallError && bounded.code === "unavailable");
          const fallback = transient && toolPages === before ? await cache.fallbackTools() : undefined;
          if (!fallback) throw error;
          return fallback;
        }
        if (toolPages !== before && params?.cursor === undefined) {
          const refresh = await cache.completeCatalogRefresh(result);
          if (refresh) {
            try {
              await observeCompletedCatalogRefresh(cache.currentContext(), refresh);
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
      });
    const listResources = client.listResources.bind(client);
    client.listResources = (params, options) =>
      cache.withListing(listingContext(options), () => listResources(params, options));
    const listResourceTemplates = client.listResourceTemplates.bind(client);
    client.listResourceTemplates = (params, options) =>
      cache.withListing(listingContext(options), () => listResourceTemplates(params, options));
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
    client.request = (async (...args: unknown[]) => {
      const message = args[0] as { method: string; params?: { cursor?: string } };
      if (
        message.method !== "tools/list" &&
        message.method !== "resources/list" &&
        message.method !== "resources/templates/list"
      )
        return Reflect.apply(request, client, args);
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
        page = await request(
          message as Parameters<Client["request"]>[0],
          method === "tools/list"
            ? CompatibleListToolsResultSchema
            : method === "resources/list"
              ? specTypeSchemas.ListResourcesResult
              : specTypeSchemas.ListResourceTemplatesResult,
          options,
        );
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
      const tools = catalogItems(method, clean).filter((item) => {
        const name =
          method === "tools/list"
            ? item.name
            : method === "resources/list"
              ? (item as { uri: string }).uri
              : (item as { uriTemplate: string }).uriTemplate;
        if (walk.names.has(name)) return false;
        walk.names.add(name);
        return true;
      });
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
      const field = method === "tools/list" ? "tools" : method === "resources/list" ? "resources" : "resourceTemplates";
      const result = { ...clean, [field]: tools };
      if (!walk.first) walk.first = result;
      else {
        // SDK aggregation retains page-one metadata. A later page may only
        // narrow its reuse grant, never broaden the complete catalog's scope.
        walk.first.ttlMs = Math.min(walk.first.ttlMs, clean.ttlMs);
        if (clean.cacheScope !== "public") walk.first.cacheScope = "private";
      }
      observeCatalogExpiry(ctx, method, walk.first.ttlMs);
      return result;
    }) as Client["request"];
  };

  /** This request scope's entry, open or closed, created on first sight. */
  const entryFor = (ctx: ConnectorContext): ConnectionState => {
    const key = ctx.requestScope ?? ctx;
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
      openRequest(key).own(() => {
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
      { name: ctx.oauthClientName, client: staticClient, secrets: sentSecretsFor(ctx) },
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
    const trackedFetch: FetchLike = async (input, init) => {
      let rpc: unknown;
      if (typeof init?.body === "string") {
        try {
          rpc = JSON.parse(init.body);
        } catch {
          /* OAuth exchanges can send form-encoded bodies. */
        }
      }
      const toolCall = init?.method === "POST" && skillObject(rpc) && rpc.method === "tools/call" ? rpc : undefined;
      const writeContinuation = downstreamWriteContinuation(ctx.requestScope ?? ctx) && toolCall !== undefined;
      // Every request a write sends passes here. The first leaves; any other
      // stops before it does (INV-9), whatever sent it: the SDK's resend after
      // a 401 or a step-up, which still renews the grant for a deliberate
      // repeat, or a redirect hop.
      const flight =
        toolCall && (typeof toolCall.id === "string" || typeof toolCall.id === "number")
          ? flights.get(toolCall.id)
          : undefined;
      if (toolCall && !flight && !untrackedRead(toolCall.params)) throw missingDispatch();
      // Native Node fetch can replay below this guard (421 or a host retry
      // dispatcher). Resolve the owned sender before claiming dispatch, so
      // a Node deployment without /node refuses the write while still unsent.
      const sender = flight?.write ? guardedTransport(true) : undefined;
      if (flight?.write) {
        if (flight.sent) {
          // The SDK renewed the grant and tried to send again: a renewal of
          // this request's own credential only if the token changed (Q8).
          if (flight.request && flight.authorization)
            renewedAfterUnauthorized(
              flight.request.entry,
              flight.authorization,
              new Headers(init?.headers).get("authorization") ?? flight.authorization,
            );
          throw resendRefused(flight);
        }
        flight.sent = true;
        flight.authorization = new Headers(init?.headers).get("authorization");
      }
      const request = flight?.request;
      if (request?.entry.dispatched)
        request.entry = providerRequest(request.ctx, !flight?.write, request.entry.provider, {
          method: init?.method ?? "GET",
        });
      const entry = request?.entry;
      if (request && entry) {
        if (flight?.sourceWrite) recordRequestField(entry, "sourceWrite", true);
        dispatchProviderRequest(request.ctx, entry, init?.headers, init?.method ?? "GET");
      }
      trackSentRequest(ctx, input, init);
      const response = sender
        ? await sender.send(new URL(input instanceof Request ? input.url : String(input)), {
            ...init,
            redirect: "manual",
          })
        : writeContinuation
          ? await fetch(input, { ...init, redirect: "manual" })
          : await fetch(input, init);
      if (entry) recordProviderResponse(entry, response.status);
      if (flight?.write) {
        if (response.status === 401) flight.unauthorized = true;
        else if (REDIRECT_STATUSES.has(response.status)) flight.redirected = true;
      }
      if (writeContinuation && (response.status === 401 || (response.status >= 300 && response.status < 400))) {
        await response.body?.cancel().catch(() => {});
        // Stop before the SDK can refresh auth or follow a redirect and resend
        // this write. The host's one-use continuation nonce remains spent.
        if (response.status === 401) throw authRequiredError();
        throw new ConnectorCallError(
          "connector_call_failed",
          "The downstream redirected a write continuation; it was not repeated.",
          { retryable: false, writeOutcome: "unknown" },
        );
      }
      if (flight?.redirected) {
        await response.body?.cancel().catch(() => {});
        // A 307 or 308 keeps the method and body, so following it would send
        // the write again; the server may have acted before redirecting.
        throw new ConnectorCallError(
          "connector_call_failed",
          "The downstream answered this write with a redirect; it was not sent again.",
          { retryable: false, writeOutcome: "unknown" },
        );
      }
      if (skillsEnabled && skillObject(rpc) && (rpc.method === "skills/list" || rpc.method === "resources/read")) {
        return boundedSkillResponse(
          response,
          rpc.method === "skills/list" ? MAX_SERIALIZED_CATALOG_BYTES : MAX_SKILL_READ_RPC_BYTES,
          rpc.id,
          init?.signal,
        );
      }
      return response;
    };
    // A runtime refusing the assembled header quotes it, and the transport
    // error below keeps none of what the runtime said. So whether the
    // rejection quoted the credential is decided here, first, and survives
    // as the class of the error rather than as its text.
    const guardedFetch = redirectSafeFetch(
      id,
      opts.redirects,
      credentialFramed === null
        ? trackedFetch
        : async (input, init) => {
            try {
              return await trackedFetch(input, init);
            } catch (err) {
              throw withoutCredential(err, credentialValue, credentialFramed);
            }
          },
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
          ? (input, init) =>
              duringViewCall(
                ctx,
                async (requestSignal) => {
                  const response = await send(input, {
                    ...init,
                    signal: init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal,
                  });
                  // An override may ignore abort. Cancel its late response before
                  // the SDK can consume it, including a cloned pending body read.
                  if (requestSignal.aborted) {
                    void response.body?.cancel().catch(() => {});
                    throw requestSignal.reason;
                  }
                  return codeExchangeResponse(response, requestSignal);
                },
                true,
              )
          : send;
      const coordinatedFetch = refreshCoordinatorFor(ctx).coordinatedFetch(
        oauthProvider,
        exchangeFetch(learnedUrlSafeFetch(id, url, trackedFetch)),
        signal,
        ctx.defer,
        exchangeFetch(learnedUrlSafeFetch(id, url, (input, init) => guardedFetch(input, resourceInit(input, init)))),
      );
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider: oauthProvider,
        onInsufficientScope: "throw",
        fetch: async (input, init) => {
          const response = await coordinatedFetch(input, init);
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
              } catch {
                // OAuth forms and request-owned protocol fetches have no call id.
              }
            }
            const ownedSignal = owner && init?.signal ? AbortSignal.any([owner, init.signal]) : (owner ?? init?.signal);
            if (ownedSignal) renewalSignals.set(response, ownedSignal);
          }
          return response;
        },
      });
      boundOAuthFlows(ctx, transport, url, [signal, ctx.signal], (response) => renewalSignals.get(response));
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
        fetch: (input, init) => guardedFetch(input, resourceInit(input, init)),
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
    transport.send = async (message, options) => {
      const request =
        !Array.isArray(message) && "method" in message && message.method === "tools/call" && "id" in message
          ? message
          : undefined;
      if (!request) return await send(message, options);
      const dispatch = dispatchOf(request.params);
      if (!dispatch) {
        if (!untrackedRead(request.params)) throw missingDispatch();
        return await send(message, options);
      }
      if (dispatch.write && dispatch.sent) throw resendRefused(dispatch);
      flights.set(request.id, dispatch);
      try {
        return await send(message, options);
      } finally {
        flights.delete(request.id);
      }
    };
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

  const ensureConnected = async (ctx: ConnectorContext, state: ConnectionState): Promise<Client> => {
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
      // A 401 after connect is a verdict for the whole request scope, not merely
      // for the one call that observed it. Do not let the still-cached client make
      // a later status or call in the same scope report healthy.
      if (state.authRequired) {
        throw authRequiredError();
      }
      // Read the OAuth epoch before trusting either a cached client or starting a
      // transport. A disconnected epoch is a durable operator instruction, not
      // merely the absence of credentials: passive status/tool probes must not
      // turn it back into a pending consent flow.
      let oauthGeneration: string | undefined;
      if (isOauth && (state.client || state.connecting)) {
        // Count an existing handshake waiter before subscribing its signal:
        // cancelling a sibling must not close the handshake beneath it.
        const provider = newProvider(ctx, state, openRequest(ctx.requestScope ?? ctx).signal);
        // The read belongs to the request; this caller's wait still ends with
        // its call. Closing one call must not revoke the shared provider.
        oauthGeneration = await duringViewCall(ctx, () => provider.liveEpoch());
        if (provider.isOperatorDisconnectedEpoch(oauthGeneration)) {
          closeHalf(state);
          throw operatorDisconnectedError();
        }
      }
      // Cross-isolate force re-auth: another isolate replaced the grant's epoch,
      // and the grant with it. This request's cached client still speaks the old
      // token — drop it so the next connect runs against current state.
      if (state.client && oauthGeneration !== undefined && state.connectedGeneration !== null) {
        if (isClosed(state)) throw scopeEndedError();
        if (oauthGeneration !== state.connectedGeneration) {
          closeHalf(state);
        }
      }
      // The static-credential counterpart of the epoch read above, and
      // deliberately beside it: the vault is read before any cached client is
      // trusted, so an operator's rotation in the UI takes effect on the next
      // call rather than the next deploy. Compared by digest — the
      // plaintext lives in this function's scope and never reaches `state`.
      let credentialValue: string | null = null;
      let credentialFramed: string | null = null;
      let credentialDigest: string | null = null;
      if (credentialAuth || requestAuth) {
        credentialValue = await readCredential(ctx);
        credentialFramed = credentialHeaderValue(credentialScheme, credentialValue);
        credentialDigest = await digestOf(credentialValue);
        // Gated on a connect in flight as well as a cached client, exactly like
        // the epoch read above: a rotation that lands while the first caller is
        // still connecting must not let the second one ride the key the vault
        // has already replaced.
        if (
          (state.client || state.connecting) &&
          state.credentialDigest !== null &&
          state.credentialDigest !== credentialDigest
        ) {
          // A slow vault/token read or digest can resume after a newer caller
          // connected with the replacement. Never let that stale read tear down
          // the newer connection and install the rotated-away credential.
          const observedConnection = state.client ?? state.connecting;
          const currentCredential = await readCredential(ctx);
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
      // Credential preparation belongs to this caller, even when the session
      // it may join belongs to the request. A late preparation cannot acquire
      // or reuse a session after its operation boundary has refused the call.
      viewSignal(ctx).throwIfAborted();
      if (isClosed(state)) throw scopeEndedError();
      if (state.client) return state.client;
      const attempt = state.connecting ?? startConnect(ctx, state, credentialValue, credentialFramed, credentialDigest);
      // A Promise edge of its own, as architecture.md's "Effect inside" requires
      // of every shared wait: whatever this caller does next with the client is
      // its own I/O, so it resumes in its own continuation rather than inside the
      // call that completed the attempt.
      if (joined !== attempt) {
        leave();
        joined = attempt;
        connectingWaiters.set(attempt, (connectingWaiters.get(attempt) ?? 0) + 1);
      }
      const client = await runEdge(Deferred.await(attempt), { signal: ctx.signal });
      // Teardown may land before this continuation receives the client.
      if (isClosed(state)) throw scopeEndedError();
      return client;
    } finally {
      leave();
    }
  };

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
  ): Deferred.Deferred<Client, unknown> => {
    const attempt = Deferred.makeUnsafe<Client, unknown>();
    state.connecting = attempt;
    // Published with the attempt, not with its result: a rotation that lands
    // while this connect is in flight has to be visible to the next caller,
    // which would otherwise wait on a client bound to the older key.
    state.credentialDigest = credentialDigest;
    detach(
      connect(ctx, state, attempt, credentialValue, credentialFramed).pipe(
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
        const genAtStart = provider ? yield* promised(() => provider.beginFlow()) : "";
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        if (provider) state.attemptProvider = provider;
        if (provider?.isOperatorDisconnectedEpoch(genAtStart)) {
          return yield* Effect.fail(operatorDisconnectedError());
        }
        // SDK v2 selects its validator by runtime export condition: AJV on
        // Node and @cfworker/json-schema under workerd. The Workers-safe path
        // no longer needs Connecta-specific wiring.
        const oauthConfig = isOauth
          ? {
              client: staticClient,
              clientMetadataUrl: staticClient
                ? undefined
                : (clientMetadataUrl ?? selfHostedClientUrl(ctx.publicUrl, id)),
              redirectUri: downstreamRedirectUri(ctx.baseUrl, ctx.publicUrl, id),
              clientName: ctx.oauthClientName,
            }
          : undefined;
        const negotiationDigest = yield* promised(() =>
          digestOf(
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
              oauthConfig,
              oauthScope,
              state.credentialDigest,
              genAtStart,
              callerOf(ctx),
              skillsEnabled === true,
            ]),
          ),
        );
        const prior =
          opts.versionNegotiation === "legacy"
            ? undefined
            : yield* promised(() => readNegotiation(ctx, negotiationDigest));
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        const cacheOptions = yield* promised(() =>
          catalogClientOptions(
            ctx,
            id,
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
              oauthConfig,
              oauthScope,
            }),
            JSON.stringify([genAtStart, state.credentialDigest]),
            connectionAbort.signal,
            cacheOwner,
            requestAuth || opts.authScope === "personal" ? "private" : "shared",
            provider ? async () => digestOf(JSON.stringify(await provider.tokens())) : undefined,
          ),
        );
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        const makeClient = () => {
          const {
            intake: _intake,
            completeCatalogRefresh: _refresh,
            withListing: _listing,
            currentContext: _context,
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
        let t = buildTransport(ctx, provider, credentialFramed, connectionAbort.signal, credentialValue);
        if (!owned()) {
          held.transport = t;
          return yield* Effect.fail(scopeEndedError());
        }
        state.transport = t;
        held.transport = t;
        recordWireErrors(t, () => observeCatalogChange(ctx, id, connectionAbort.signal, cacheOwner));
        yield* promised(async () => {
          try {
            await c.connect(t, { signal: handshakeAbort.signal, ...(prior ? { prior } : {}) });
          } catch (error) {
            // Some legacy servers crash on an unknown pre-initialize method.
            // Only an auto probe's typed HTTP 5xx permits a fresh legacy
            // handshake. An auth failure, timeout or initialize failure does not.
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
            // The SDK closed the failed probe transport. Its replacement owns
            // a new connection, with the same credential and OAuth generation.
            c = makeClient();
            t = buildTransport(ctx, provider, credentialFramed, connectionAbort.signal, credentialValue);
            state.transport = held.transport = t;
            recordWireErrors(t, () => observeCatalogChange(ctx, id, connectionAbort.signal, cacheOwner));
            await c.connect(t, { signal: handshakeAbort.signal, prior: { kind: "legacy" } });
          }
        }).pipe(
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
          const generation = yield* promised(() => provider.liveEpoch()).pipe(
            Effect.mapError((error) => (owned() ? error : scopeEndedError())),
          );
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
        state.connectedGeneration = genAtStart;
        state.authRequired = false;
        const discover = c.getDiscoverResult();
        if (!prior)
          yield* promised(() =>
            storeNegotiation(ctx, negotiationDigest, discover ? { kind: "modern", discover } : { kind: "legacy" }),
          );
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        return c;
      }).pipe(
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

  const disconnectAuthorization = async (
    ctx: ConnectorContext,
    state: ConnectionState,
    operatorDisconnected = false,
    preserveClient = false,
  ): Promise<void> => {
    const provider = newProvider(ctx, state);
    // Publish the replacement epoch before waiting on or closing any
    // request-local transport. A hung connect therefore cannot delay the
    // fence, and every late OAuth write stays in the older namespace.
    const reset = operatorDisconnected
      ? provider.disconnectAuthorization(
          learnedUrlSafeFetch(id, new URL(opts.url), async (input, init) => {
            trackSentRequest(ctx, input, init);
            return await fetch(input, init);
          }),
        )
      : provider.resetAuthorization(false, preserveClient);
    try {
      await reset;
    } finally {
      // Abandon any connect in flight and close whichever half of the
      // client/transport exists. Reset is unconditional because storage may already
      // be fenced behind a newer epoch after a cleanup error.
      closeHalf(state);
    }
  };

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

  const withSkillsClient = async <T>(
    ctx: ConnectorContext,
    method: "skills/list" | "resources/read",
    run: (client: Client, state: ConnectionState) => Promise<T>,
  ): Promise<T> => {
    const state = stateFor(ctx);
    const client = await ensureConnected(ctx, state);
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
      const result = await run(client, state);
      skillScopeOpen(ctx, state);
      return result;
    } catch (error) {
      if (ownAbortReason(error, [ctx.signal]) && !hasSdkPayload(error)) throw error;
      const classified = atMcpBoundary(ctx, error, method, client.transport, [ctx.signal]);
      if (requiresAuthorization(classified) && state.client === client) state.authRequired = true;
      // The SDK and downstream can quote whole manifests or bodies in errors.
      // Keep their typed verdict and operator facts, never the quoted payload.
      throw carryFailureFacts(classified, withheldAs(`Connector "${id}" downstream ${method} failed.`, classified));
    }
  };

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
            list: (ctx: ConnectorContext) =>
              withSkillsClient(ctx, "skills/list", async (client, state) => {
                const listed: ConnectorSkill[] = [];
                const uris = new Set<string>();
                const cursors = new Set<string>();
                let cursor: string | undefined;
                let bytes = 0;
                for (let page = 0; page < MAX_SKILLS; page++) {
                  skillScopeOpen(ctx, state);
                  const result = await client.request(
                    { method: "skills/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
                    SkillPageSchema,
                    requestOptions(ctx),
                  );
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
            read: (uri: string, ctx: ConnectorContext) =>
              withSkillsClient(ctx, "resources/read", async (client) => {
                // The registry admits only advertised manifest URIs. An explicit
                // request bypasses the SDK readResource response cache entirely and
                // validates the raw result before its resource union drops fields.
                return client.request(
                  { method: "resources/read", params: { uri } },
                  skillReadSchema(uri),
                  requestOptions(ctx),
                );
              }),
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
          testCredential: async (value: string, ctx: ConnectorContext): Promise<CredentialTestResult> => {
            try {
              // The connect below reads the vault itself — the header is
              // assembled deep inside `ensureConnected`, and handing a
              // candidate down that path would mean threading a second secret
              // through the whole connection state. `/ui/credentials/<id>/test`
              // reads the stored value and passes it here, so today the two are
              // the same string. Check rather than assume: a route that later
              // tested an unsaved candidate would otherwise silently report on
              // the old value, which is the one answer worse than refusing.
              const stored = (await ctx.credential?.get())?.trim();
              if (stored !== value.trim()) {
                return {
                  ok: false,
                  message:
                    "This connector tests the credential that is currently " +
                    "saved. Save the value first, then test it.",
                };
              }
              const tools = await connector.listTools(ctx);
              return {
                ok: true,
                message: `Connected — the downstream served ${tools.length} tool${tools.length === 1 ? "" : "s"}.`,
              };
            } catch (err) {
              return { ok: false, message: msg(err) };
            } finally {
              // Standalone tests own their scope; an operator route owns
              // bounded teardown for the context it supplied to this hook.
              if (!connectorScopeCleanupClaimed(ctx, id)) await connector.closeScope?.(ctx);
            }
          },
        }
      : {}),

    // The SDK walks the whole chain and writes one complete result. Intake
    // runs on its public request seam before any page can enter that cache.
    async listTools(ctx) {
      const state = stateFor(ctx);
      const client = await ensureConnected(ctx, state);
      let clean: ListToolsResult["tools"];
      const options = requestOptions(ctx) ?? {};
      listingContexts.set(options, ctx);
      try {
        const result = await client.listTools(undefined, options);
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
      state.toolDefinitions = new Map(clean.map((tool) => [tool.name, tool]));
      return clean.map((t) => ({
        name: t.name,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.icons !== undefined
          ? {
              // Inline images can consume the catalog ceiling and storage chunks.
              // The SDK needs no icons for validation or parameter mirroring.
              icons: t.icons.filter((icon) => !/^data:/i.test(icon.src)) as NonNullable<ToolDef["icons"]>,
            }
          : {}),
        ...(t.execution !== undefined ? { execution: t.execution as NonNullable<ToolDef["execution"]> } : {}),
        // SEP-2243 declarations live in inputSchema. SDK validation and header
        // mirroring need no _meta keys, so arbitrary downstream metadata stays
        // out of the persisted catalog.
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
    },

    async callTool(name, args, ctx, options) {
      enterProviderBoundary(ctx, connector);
      let active: { state: ConnectionState; client: Client; dispatch: CallDispatch; write: boolean } | undefined;
      try {
        // Race the entire operation inside its write decider. Cancellation must
        // retain the exact request ledger and a dispatched write's verdict.
        return await settleOnClose(ctx, async () => {
          const state = stateFor(ctx);
          const client = await ensureConnected(ctx, state).catch((error: unknown) => {
            throw knownProviderFailure(error);
          });
          const definition = options?.definition;
          // The registry's verdict for this call; outside an invocation, the
          // dispatched definition's, otherwise the server annotations.
          const facts = definition ?? state.toolDefinitions.get(name) ?? { name };
          const sourceFacts = definition ?? {
            name,
            ...(facts.annotations ? { annotations: facts.annotations as NonNullable<ToolDef["annotations"]> } : {}),
          };
          // Deployment overrides never enter the source class.
          const source = sourceClassification(sourceFacts);
          const serverWrite = source === "write";
          const write = serverWrite || (callClassification(ctx) ?? definition?.classification ?? source) === "write";
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
                // Older stored catalogs and custom connectors may omit inputSchema.
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
              throw outputError(-32602, `Tool '${name}' has an invalid outputSchema: schema could not be compiled`);
            }
          }
          const result = await client
            .callTool(
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
                // SDK 2.3.1's callTool checks outputSchema even for a suspension.
                // Retain its header mirroring, then validate only final results.
                // Given a definition, it never relists and sends a call again
                // after a HeaderMismatch answer, so a write always has one.
                ...(toolDefinition
                  ? { toolDefinition: { ...toolDefinition, outputSchema: undefined } }
                  : write
                    ? { toolDefinition: { name, inputSchema: { type: "object" } as Tool["inputSchema"] } }
                    : {}),
              },
            )
            .catch((err: unknown) => {
              assertDownstreamOutputSafe(ctx.requestScope ?? ctx, err);
              throw atMcpBoundary(ctx, err, "tools/call", client.transport, [ctx.signal]);
            });
          if (isInputRequiredResult(result)) {
            return result;
          }
          assertDownstreamOutputSafe(ctx.requestScope ?? ctx, result);
          if (output && !result.isError) {
            if (result.structuredContent === undefined)
              throw outputError(-32600, `Tool ${name} has an output schema but did not return structured content`);
            const validation = await output["~standard"].validate(result.structuredContent);
            if (validation.issues)
              throw outputError(
                -32602,
                "Structured content does not match the tool's output schema: validation failed",
              );
          }
          return result;
        });
      } catch (err) {
        // The boundary refuses preparation too; before a dispatch record
        // exists, this call is still a proven unsent failure.
        if (!active) throw knownProviderFailure(err);
        const { state, client, dispatch, write } = active;
        const direct = write && callClassification(ctx) === undefined;
        // Served calls defer their abort to invocation, whose ledger retains
        // source-write provenance even when the effective class is read.
        const ownAbort = ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err);
        if (ownAbort && !direct) throw err;
        // A grant revoked after connect surfaces here, not in ensureConnected.
        if (requiresAuthorization(err) && state.client === client) state.authRequired = true;
        const failure = ownAbort
          ? err
          : err instanceof UnauthorizedError
            ? carryFailureFacts(err, authRequiredError())
            : downstreamCallError(err, undefined, undefined, undefined, requestSentSecrets(ctx));
        if (!write) throw failure;
        // A write that left is never advertised as safe to repeat (INV-9):
        // not after a 401, whatever the grant's recovery met; not after a
        // redirect or a further send stopped here; and not after a gateway's
        // 502 to 504, a timeout, or a connection lost once it was sent.
        // A resend stopped after the SDK renewed the grant renewed this
        // write's credential only when the token changed (Q8); the same token
        // back is a grant that still needs authorization.
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
          // Recorded as this request's 401 verdict, for the call that decides Q8.
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
        // Whether this call's tools/call reached fetch is the dispatch ledger;
        // the HTTP status the endpoint answered is its served verdict. Once
        // sent, a JSON-RPC error (-32602 included: a server can run the
        // handler and then reject its result), an unreadable result, or a
        // failed output validation is no refusal, direct or served.
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
    },

    async readResource(uri, ctx) {
      const state = stateFor(ctx);
      const client = await ensureConnected(ctx, state);
      try {
        const options = requestOptions(ctx) ?? {};
        listingContexts.set(options, ctx);
        try {
          if (!client.getServerCapabilities()?.resources) throw unadvertisedResource();
          const resources = await client.listResources(undefined, options);
          const templates = await client.listResourceTemplates(undefined, options);
          const exact = resources.resources.some((resource) => resource.uri === uri);
          if (!exact) {
            const match = resourceUriMatchesTemplates(uri, templates.resourceTemplates, (code) =>
              resourceTemplateRefusals.add(code),
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
        const result = await client
          .readResource(
            { uri },
            {
              ...requestOptions(ctx),
              cacheMode: "bypass",
              allowInputRequired: true,
            },
          )
          .catch((err: unknown) => {
            if (err instanceof ResourceNotFoundError) {
              throw new ConnectorCallError("not_found", "The downstream resource does not exist.");
            }
            throw atMcpBoundary(ctx, err, "resources/read", client.transport, [ctx.signal]);
          });
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
    },

    async closeScope(ctx) {
      // A scope closed before its first use gets an entry too, closed at once,
      // so it cannot spring into existence later.
      const state = entryFor(ctx);
      // Closed before any await, and before the finalizers run: every check
      // from here on sees the scope ended. A duplicate teardown finds it
      // closed and has nothing to run.
      const release = Scope.closeUnsafe(state.scope, Exit.void);
      const cacheClosing = closeCatalogCacheScope(ctx, id, cacheOwner);
      // Storage cannot cancel an already-started write. Bound the join in
      // parallel with transport cleanup so it adds no unbounded teardown tail.
      const cacheClosed =
        cacheClosing &&
        runEdge(
          Effect.raceAllFirst([
            Effect.promise(() => cacheClosing),
            Effect.sleep(Duration.millis(LOCAL_CLOSE_BUDGET_MS)),
          ]),
        );
      reset(state);
      // Start every finalizer before checking the caller's owner. Teardown is
      // revocation machinery and must still run for an already-ended request.
      const closing = Promise.all([release ? runEdge(release) : undefined, cacheClosed]).then(() => {});
      void closing.catch(() => {});
      if (viewSignal(ctx, true).aborted) return closing;
      return settleOnClose(ctx, () => closing, true);
    },

    async status(ctx): Promise<ConnectorStatus> {
      const state = stateFor(ctx);
      const report = async (status: ConnectorStatus) => {
        const path = isOauth ? await newProvider(ctx, state).registrationPath() : undefined;
        return ownStatus({
          ...status,
          ...(path ? { registrationPath: path } : {}),
          ...(resourceTemplateRefusals.size ? { resourceTemplateRefusals: [...resourceTemplateRefusals] } : {}),
        });
      };
      try {
        await ensureConnected(ctx, state);
        return report({ state: "ok" });
      } catch (err) {
        // An empty slot, or one with no vault behind it, is reported the way a
        // missing grant is: present, unauthenticated, and repairable — never a
        // boot failure and never a silently absent connector.
        if (err instanceof CredentialRequiredError) {
          return report({ state: "auth_required", message: err.message });
        }
        if (err instanceof OperatorDisconnectedError) {
          return report({ state: "auth_required", message: err.message });
        }
        if (state.authRequired) {
          // Only an OAuth connector has a pending consent URL to offer. A
          // credential connector's downstream 401 is repaired in the operator
          // UI connection, so do not reach into OAuth storage to look for one.
          return report({
            state: "auth_required",
            message: credentialAuth
              ? "Authorization required — the downstream rejected this connector's stored credential."
              : "Authorization required — open the URL to connect.",
          });
        }
        // An operator surface: the record, never the error's own text.
        return failureStatus(id, err);
      }
    },

    async finishAuth(code, ctx, callbackParams) {
      return duringViewCall(
        ctx,
        async (signal) => {
          const state = stateFor(ctx);
          const provider = newProvider(ctx, state);
          // verifyState ran on this request-scoped provider first and found the
          // consent; a programmatic exchange names it by its callback's state.
          const consent = callbackParams?.get("state") ?? null;
          if (!consent || !(await provider.verifyCallbackState(consent))) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `Connector "${id}" authorization callback matches no pending consent; nothing was exchanged.`,
            );
          }
          // The exchange reads and writes only the epoch its consent was written
          // in; it decides nothing about the grant there.
          provider.validateCallbackIssuer(callbackParams?.get("iss") ?? null);
          await provider.bindFlow();
          signal.throwIfAborted();
          // Always a transport of the exchange's own, over the provider that
          // verified the state: that provider holds the consent's claim, and the
          // fence before the token request is its to cross. A connection this
          // scope opened earlier speaks for its connect attempt, not this callback.
          const t = buildTransport(ctx, provider, null, signal, null, true) as StreamableHTTPClientTransport;
          const trail: OAuthTrail = {};
          const internals = t as unknown as { _fetchWithInit?: FetchLike };
          const traced = tracedOAuthFetch(trail, new URL(opts.url), internals._fetchWithInit ?? fetch);
          const exchange = new Proxy(t, {
            get: (target, key) => (key === "_fetchWithInit" ? traced : Reflect.get(target, key, target)),
            set: (target, key, value) => Reflect.set(target, key, value, target),
          });
          try {
            await exchange.finishAuth(callbackParams);
            // Reset so the next use reconnects with the freshly stored tokens.
            closeHalf(state);
          } catch (err) {
            throw await withoutAuthorizationServerText(ctx, err, trail, [signal, ctx.signal]);
          } finally {
            // This exchange-only transport has no lease in the request scope.
            detach(closeConnection(null, t, ctx.logger));
          }
        },
        true,
      );
    },
  };

  if (opts.auth?.type === "oauth") {
    connector.verifyState = async (oauthState, ctx) => {
      const state = stateFor(ctx);
      return newProvider(ctx, state).verifyState(oauthState);
    };

    connector.verifyCallbackIssuer = async (issuer, ctx) => {
      newProvider(ctx, stateFor(ctx)).validateCallbackIssuer(issuer);
      return true;
    };

    connector.consumeAuthError = async (ctx) => {
      await newProvider(ctx, stateFor(ctx)).consumeAuthError();
    };

    connector.disconnectAuth = async (ctx) => {
      await disconnectAuthorization(ctx, stateFor(ctx), true);
    };

    connector.startAuth = async (ctx, startOpts) => {
      ctx = authorizingContext(ctx);
      const state = stateFor(ctx);
      state.provider = null;
      const p = newProvider(ctx, state);
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      const disconnected = startOpts?.force ? false : await p.operatorDisconnected();
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (startOpts?.force || disconnected) {
        await disconnectAuthorization(ctx, state, false, startOpts?.force === true);
      } else {
        // A consent URL already outstanding? Re-issue it rather than re-running
        // the SDK flow, which would overwrite the PKCE verifier and invalidate
        // the URL the operator may be mid-consent on. Only a recent one: an
        // old or untimed URL falls through to a fresh flow in this same
        // epoch, which keeps the stored client registration and discovery.
        const pending = await p.reusablePendingAuthorizationUrl();
        if (pending) {
          return {
            state: "auth_required",
            authorizationUrl: pending,
            authorizationReused: true,
            message: "Authorization required — open the URL to connect.",
          };
        }
      }
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      try {
        await ensureConnected(ctx, state);
        return {
          state: "ok",
          message: "Already authorized — connection is healthy.",
        };
      } catch (err) {
        if (state.authRequired) {
          // The consent this start's attempt stored, while its epoch is live:
          // one a later reset published belongs to another flow, and this
          // start fails rather than hand it out.
          let authorizationUrl: string | undefined;
          try {
            authorizationUrl = await state.attemptProvider?.consentUrl(viewSignal(ctx, true));
          } catch (readErr) {
            return { state: "error", message: startMessage(readErr) };
          }
          return {
            state: "auth_required",
            ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
            message: "Authorization required — open the URL to connect.",
          };
        }
        return { state: "error", message: startMessage(err) };
      }
    };
  }

  const withActiveSecrets = async <T>(
    ctx: ConnectorContext,
    run: () => Promise<T>,
    redactResult = true,
    preserveInput = false,
  ): Promise<T> => {
    trackCredentialReads(ctx);
    const secrets = sentSecretsFor(ctx);
    if (opts.auth?.type === "headers") {
      for (const value of Object.values(opts.auth.headers)) secrets.header(value);
    }
    for (const value of Object.values(extraHeaders ?? {})) secrets.header(value);
    const state = entryFor(ctx);
    let active = activeContexts.get(state);
    if (!active) {
      active = new Set();
      activeContexts.set(state, active);
    }
    active.add(ctx);
    try {
      const result = await run();
      // Opaque state must reach the sealing handler byte-exact. Invocation
      // intercepts it before ordinary result processing or guest exposure.
      if (!preserveInput || !isInputRequiredResult(result)) assertDownstreamOutputSafe(ctx.requestScope ?? ctx, result);
      return (preserveInput && isInputRequiredResult(result)) || !redactResult
        ? result
        : redactSentSecrets(ctx, result);
    } catch (error) {
      assertDownstreamOutputSafe(ctx.requestScope ?? ctx, error);
      // The request's whole set: an outer wrapper may still cut what passes here.
      throw requestSentSecrets(ctx).redact(error);
    } finally {
      active.delete(ctx);
    }
  };
  const callTool = connector.callTool;
  connector.callTool = (name, args, ctx, options) =>
    withActiveSecrets(ctx, () => callTool(name, args, ctx, options), true, true);
  const listTools = connector.listTools;
  connector.listTools = (ctx) => withActiveSecrets(ctx, () => listTools(ctx));
  const readResource = connector.readResource!;
  connector.readResource = (uri, ctx) => withActiveSecrets(ctx, () => readResource(uri, ctx));
  if (connector.downstreamSkills) {
    const { list, read } = connector.downstreamSkills;
    connector.downstreamSkills.list = (ctx) => withActiveSecrets(ctx, () => list(ctx), false);
    connector.downstreamSkills.read = (uri, ctx) => withActiveSecrets(ctx, () => read(uri, ctx), false);
  }

  if (isOauth && !staticClient && clientMetadataUrl === undefined) declareSelfHostedClient(connector, oauthScope);
  if (isOauth) {
    const start = connector.startAuth!;
    connector.startAuth = async (...args) => {
      const status = await start(...args);
      const path = await newProvider(args[0], stateFor(args[0])).registrationPath();
      return { ...status, ...(path ? { registrationPath: path } : {}) };
    };
  }
  // Every published Promise operation owns its whole wait, including local
  // storage, digest, registration-path and result processing seams. callTool
  // settles inside its write decider; closeScope starts cleanup before racing
  // the join, and finishAuth already owns its request-scoped exchange boundary.
  const settlingOperation =
    <Args extends unknown[], Result>(
      operation: (...args: Args) => Promise<Result>,
      contextIndex: number,
      requestOwned = false,
    ): ((...args: Args) => Promise<Result>) =>
    (...args) => {
      const ctx = args[contextIndex] as ConnectorContext;
      const state = states.get(ctx.requestScope ?? ctx);
      // A connector scope already revoked by teardown keeps its established
      // refusal, before the enclosing request's more general close boundary.
      if (state && isClosed(state)) return Promise.reject(scopeEndedError());
      return settleOnClose(ctx, () => operation(...args), requestOwned);
    };
  connector.listTools = settlingOperation(connector.listTools, 0);
  connector.readResource = settlingOperation(connector.readResource!, 1);
  if (connector.downstreamSkills) {
    connector.downstreamSkills.list = settlingOperation(connector.downstreamSkills.list, 0);
    connector.downstreamSkills.read = settlingOperation(connector.downstreamSkills.read, 1);
  }
  const status = connector.status!;
  connector.status = (ctx) => settleOnClose(ctx, () => status(ctx)).catch((error) => failureStatus(id, error));
  if (connector.testCredential) connector.testCredential = settlingOperation(connector.testCredential, 1);
  if (isOauth) {
    connector.startAuth = settlingOperation(connector.startAuth!, 0);
    connector.disconnectAuth = settlingOperation(connector.disconnectAuth!, 0);
    connector.verifyState = settlingOperation(connector.verifyState!, 1, true);
    connector.verifyCallbackIssuer = settlingOperation(connector.verifyCallbackIssuer!, 1, true);
    connector.consumeAuthError = settlingOperation(connector.consumeAuthError!, 0, true);
    // Pin before the first asynchronous storage/discovery read, not only once
    // a refresh flight exists. These operations do not take call admission.
    const retain = retainingOAuthPartition;
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
  if (isOauth)
    registerInvocationAuth(
      connector,
      retainingOAuthPartition(
        settlingOperation(async (ctx: ConnectorContext) => {
          // Only inspect local grant state here. Discovery, refresh, and MCP
          // transports remain inside callTool and cannot establish retry safety.
          const provider = newProvider(ctx, stateFor(ctx));
          if (await provider.operatorDisconnected()) throw operatorDisconnectedError();
          if (!(await provider.tokens())) throw authRequiredError();
        }, 0),
        0,
      ),
    );
  return connector;
}
