import { assertRemoteOAuthClient, declareSelfHostedClient, downstreamClientMetadata, downstreamRedirectUri, remoteClientAuthMethod, selfHostedClientUrl, trackRemoteClientRequest, type RemoteOAuthClient } from "../auth/downstream-client-metadata.js";
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
  isJSONRPCErrorResponse,
  specTypeSchemas,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  FetchLike,
  ListToolsResult,
  StandardSchemaV1,
  Tool,
  Transport,
} from "@modelcontextprotocol/client";
import { Deferred, Duration, Effect, Exit, Scope } from "effect";
import {
  assertOAuthScope,
  authorizingContext,
  KvOAuthProvider,
  OAuthRequestNotSentError,
  refreshCoordinatorsByPartition,
} from "../auth/downstream-oauth.js";
import { trackOAuthStartReset } from "../auth/oauth-start-reset.js";
import { byteReadResponse } from "../byte-read-response.js";
import { redactCatalog, redactSentSecrets, sentSecretsFor, trackCredentialReads, type SentSecrets } from "../sent-secrets.js";
import { MAX_CATALOG_TOOLS } from "../catalog-limits.js";
import { reviewedClassification } from "../catalog-drift.js";
import { connectorScopeCleanupClaimed } from "../connector-scope.js";
import {
  boundedEchoText,
  ConnectorCallError,
  msg,
  networkErrorCode,
  unavailableCallError,
  WithheldTextError,
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
import { detach, runEdge } from "../runtime/run.js";
import { assertKnownOptions, keys, optionsOf } from "../config-schema.js";
import { describedEndpoint, describedUrl } from "../described.js";
import { retryAfterMs } from "./guarded-fetch.js";
import { CALL_ADMISSION, REMOTE_MCP_AUTH, USAGE_GUIDE } from "./option-shapes.js";
import type {
  Connector,
  ConnectorAuthDescription,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorStatus,
  ConnectorUsageGuide,
  CredentialTestResult,
  Logger,
  ToolClassification,
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
   * so `"Basic"` produces `Basic <base64>` and Mixpanel's documented
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

/**
 * Apply a maintained provider's slot copy and header framing to credential
 * auth the deployment left bare.
 *
 * A provider knows what its own key is called and how the endpoint expects it
 * framed; a deployment that states either one keeps its answer. Every other
 * auth shape passes through untouched, so a provider can hand this its whole
 * `auth` option without branching first.
 */
export function withCredentialDefaults(
  auth: RemoteMcpAuth,
  defaults: {
    credential: ConnectorCredentialConfig;
    /** Provider framing; omit to leave the `Bearer` default in place. */
    scheme?: string | null;
  },
): RemoteMcpAuth {
  if (auth.type !== "credential") return auth;
  return {
    ...auth,
    credential: auth.credential ?? defaults.credential,
    ...(auth.scheme === undefined && defaults.scheme !== undefined
      ? { scheme: defaults.scheme }
      : {}),
  };
}

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
   * call_tool truncates and stashes the full text for get_result
   * paging. Overrides the deployment's `calls.maxResultBytes`; omit to inherit
   * it. Must be a whole number of bytes >= 1; anything else refuses to
   * construct.
   */
  maxResultBytes?: number;
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /**
   * Optional agent-facing usage guide served by `skills` as
   * `connector:<id>`. A string is markdown; the structured form adds bounded
   * discovery metadata. See `Connector.usageGuide`.
   */
  usageGuide?: string | ConnectorUsageGuide;
  auth?: RemoteMcpAuth;
  /**
   * Reviewed read/write verdicts for this downstream's tools, by exact name.
   * Validated at construction. A listed read fills downstream silence but
   * never overrules an explicit write annotation; a listed write or
   * destructive tool stays a write whatever the downstream claims; an unlisted
   * tool is read-only only when it says so explicitly; a listed tool whose
   * `schemaDigest` no longer matches, or cannot be checked, is served as a
   * write. Setting it also reports
   * catalog drift against the list: unclassified, unserved, contradicted, and
   * schema-changed tools, as counts. The connector carries it as
   * `classification`, and its `listTools` returns the downstream's listing
   * unclassified: the registry classifies every read. Omit it to keep the
   * downstream's own annotations, which still fail closed.
   */
  classify?: ToolClassification | undefined;
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
   * configured request's origin.
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
    "url", "title", "description", "authScope", "maxResultBytes", "versionNegotiation",
    "redirects", "requireHttps", "logger", "_transportFactory", "classify",
  ),
  callAdmission: CALL_ADMISSION,
  usageGuide: USAGE_GUIDE,
  auth: REMOTE_MCP_AUTH,
});

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

/**
 * Absolute backstop on `tools/list` pages in one refresh — a runaway guard, not
 * the primary defense.
 *
 * The walk terminates on its own well before this: a cursor handed back twice
 * is a definite loop, two consecutive pages that add no new tools are a server
 * going nowhere, and MAX_CATALOG_TOOLS caps what any of it can accumulate.
 * This exists only so the loop is finite even if a downstream somehow
 * satisfies all three forever on a path with no discovery deadline. Set high
 * enough that no honest server reaches it.
 */
const MAX_TOOL_PAGES = 10_000;

/** One entry of the SDK's `tools/list` result, before it becomes a ToolDef. */
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * Compatibility concession for hand-rolled servers that serialize
 * end-of-pagination as `null`. Only the cursor is widened; every tool and every
 * other result field still passes through the SDK's pinned schema.
 */
const CompatibleListToolsResultSchema: StandardSchemaV1<
  unknown,
  ListToolsResult
> = {
  "~standard": {
    version: 1,
    vendor: "connecta",
    validate(value) {
      const normalized =
        typeof value === "object" &&
        value !== null &&
        "nextCursor" in value &&
        value.nextCursor === null
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
function startMessage(err: unknown): string {
  const details = err instanceof ConnectorCallError ? err.details : undefined;
  const facts = [details?.host, details?.code].filter(Boolean).join(", ");
  return facts ? `${msg(err)} (${facts})` : msg(err);
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
function terminateSession(
  transport: Transport,
  logger: Logger,
  connectorId: string,
): Effect.Effect<void> {
  // SDK v2's Client.close() does not send the legacy session DELETE on our
  // behalf. Connecta's own endpoint creates no protocol session, but a stateful
  // legacy downstream can still issue `Mcp-Session-Id`, and every path that
  // abandons one — scope teardown, credential rotation, OAuth retirement, an
  // abandoned connect — owes it this best-effort, one-second DELETE.
  const terminate = (
    transport as Transport & { terminateSession?: () => Promise<void> }
  ).terminateSession;
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
    promised(() => Promise.resolve(terminate.call(transport))).pipe(
      Effect.catch((error) =>
        // The SDK's error quotes the downstream's status text, and its `data`
        // the body, so the record keeps only the status it answered with.
        warn(() =>
          logFailure(
            logger,
            "session termination refused or failed; the downstream session may remain until its provider timeout",
            failureRecord(
              { connector: connectorId },
              error instanceof SdkHttpError
                ? attachFailureFacts(error, { httpStatus: error.status })
                : error,
            ),
          ),
        ),
      ),
    ),
    Effect.sleep(Duration.millis(TERMINATE_SESSION_BUDGET_MS)).pipe(
      Effect.andThen(
        warn(() => logger.warn(
          `[connecta] connector "${connectorId}" session termination was not ` +
            `acknowledged within ${TERMINATE_SESSION_BUDGET_MS} ms; the ` +
            "downstream may still finish the headers-only DELETE, otherwise " +
            "the session will remain until its provider timeout.",
        )),
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
function closeLocally(
  client: Client | null,
  transport: Transport | null,
): Effect.Effect<void> {
  if (!client && !transport) return Effect.void;
  return Effect.raceAllFirst([
    promised(() =>
      Promise.resolve(client ? client.close() : transport?.close()),
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
  return error instanceof UnauthorizedError ||
    (error instanceof ConnectorCallError &&
      (error.code === "auth_required" || error.code === "downstream_oauth_required"));
}

/** Classify SDK/runtime facts, dropping every SDK payload and cause chain. */
function downstreamCallError(error: unknown, httpStatus?: number, wait?: number, oauthStep?: OAuthStep, secrets?: SentSecrets): unknown {
  if (error instanceof ConnectorCallError) {
    return hasSdkPayload(error.cause) ? carryFailureFacts(error, withheldAs(error.message, error)) : error;
  }
  if (error instanceof WithheldTextError || error instanceof UnauthorizedError) return error;
  const network = !(error instanceof SdkError) && !(error instanceof OAuthClientFlowError)
    ? networkErrorCode(error) : undefined;
  if (network) {
    return network === "timeout" || network === "ETIMEDOUT" || network.endsWith("_TIMEOUT")
      ? new ConnectorCallError("timeout", "The downstream request timed out.")
      : unavailableCallError(error);
  }
  const status = error instanceof SdkHttpError || error instanceof RegistrationRejectedError
    ? error.status : httpStatus;
  if (error instanceof InsufficientScopeError || (status === 403 && !(error instanceof RegistrationRejectedError)) ||
      (error instanceof OAuthError && ["insufficient_scope", "invalid_scope", "access_denied"].includes(error.code))) {
    return new ConnectorCallError("provider_permission_denied",
      "The provider denied this operation. Check the account's permissions and the tool's required access with the provider or an administrator.");
  }
  // Token endpoints return typed OAuth recovery codes on HTTP 400. Other
  // OAuth steps, especially registration, keep their HTTP status verdict.
  if (error instanceof OAuthError && OAUTH_ERROR_CODES.has(error.code) &&
      (status === undefined || oauthStep === "token request")) {
    return new ConnectorCallError(
      ["invalid_client", "invalid_grant", "invalid_token", "unauthorized_client"].includes(error.code)
        ? "downstream_oauth_required" : error.code === "too_many_requests" ? "rate_limited"
          : ["server_error", "temporarily_unavailable"].includes(error.code) ? "unavailable" : "connector_call_failed",
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
      status === 401 && !(error instanceof RegistrationRejectedError) ? "auth_required"
        : status === 429 ? "rate_limited" : status === 408 && !(error instanceof RegistrationRejectedError)
        ? "timeout" : "connector_call_failed",
      boundedEchoText(secrets?.text(message) ?? message),
      { retryable: [429, 502, 503, 504].includes(status) ||
          (status === 408 && !(error instanceof RegistrationRejectedError)),
        ...(wait !== undefined ? { retryAfterMs: wait } : {}) },
    );
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new ConnectorCallError("timeout", "The downstream request timed out.");
  }
  // ProtocolError.data is server-chosen even when its message is allowed.
  if (error instanceof ProtocolError) {
    return new ConnectorCallError(error.code === -32602 ? "invalid_args" : "connector_call_failed",
      boundedEchoText(secrets?.text(error.message) ?? error.message));
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
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Assemble the one header a credential-auth connector sends.
 *
 * A scheme ending in `Basic` names HTTP Basic credentials wherever a provider
 * nests it, so the `user:secret` it frames is base64-encoded — that is what
 * makes plain `Basic` and Mixpanel's `Bearer Basic` one rule instead of two.
 */
function credentialHeaderValue(scheme: string | null, value: string): string {
  if (scheme === null) return value;
  return /(?:^|\s)basic$/i.test(scheme)
    ? `${scheme} ${base64Utf8(value)}`
    : `${scheme} ${value}`;
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
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
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
          hasSdkPayload(cause) ? undefined : init.signal ?? undefined,
        );
      }
      // Every MCP and OAuth exchange reads its answer through here, and the
      // SDK reads bodies with `.text()` and `.json()`: as bytes, never text.
      if (!REDIRECT_STATUSES.has(response.status)) return byteReadResponse(response);

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new RemoteMcpRedirectError(
          connectorId,
          `HTTP ${response.status} carried no Location header`,
        );
      }
      if (policy === "none") {
        throw new RemoteMcpRedirectError(
          connectorId,
          `HTTP ${response.status} redirects are disabled`,
        );
      }
      if (hops >= MAX_REMOTE_REDIRECT_HOPS) {
        throw new RemoteMcpRedirectError(
          connectorId,
          `the redirect chain exceeded ${MAX_REMOTE_REDIRECT_HOPS} hops`,
        );
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new RemoteMcpRedirectError(
          connectorId,
          `HTTP ${response.status} carried an invalid Location header`,
        );
      }
      if (current.protocol === "https:" && next.protocol !== "https:") {
        throw new RemoteMcpRedirectError(
          connectorId,
          "an HTTPS-to-HTTP downgrade is not allowed",
        );
      }
      if (next.origin !== current.origin) {
        throw new RemoteMcpRedirectError(
          connectorId,
          "a cross-origin redirect is not allowed",
        );
      }
      if (next.username || next.password) {
        throw new RemoteMcpRedirectError(
          connectorId,
          "a redirect target containing URL credentials is not allowed",
        );
      }
      if (seen.has(next.href)) {
        throw new RemoteMcpRedirectError(
          connectorId,
          "the redirect chain loops",
        );
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
function learnedUrlSafeFetch(
  connectorId: string,
  configured: URL,
  baseFetch: FetchLike,
): FetchLike {
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
function recordWireErrors(transport: Transport): void {
  const seen = new Set<string>();
  wireErrors.set(transport, seen);
  transport.onmessage = (message) => {
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
    return transport !== undefined &&
      wireErrors.get(transport)?.has(wireErrorKey(err.code, err.message)) === true;
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
  [/^Structured content does not match the tool's output schema/, "the result did not match the tool's declared output schema"],
  [/^Tool .* has an output schema but did not return structured content/s, "the result did not return structured content although the tool declares an output schema"],
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
  return err instanceof SdkError &&
    err.code === SdkErrorCode.RequestTimeout &&
    signals.some((signal) => signal?.aborted === true && err.message === String(signal.reason));
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
function tracedOAuthFetch(
  trail: OAuthTrail,
  endpoint: URL,
  baseFetch: FetchLike,
): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    if (url.href === endpoint.href) {
      trail.last = undefined;
    } else {
      const body = init?.body;
      const step: OAuthStep =
        (init?.method ?? "GET").toUpperCase() === "GET"
          ? "discovery"
          : body instanceof URLSearchParams ||
              (typeof body === "string" &&
                new URLSearchParams(body).has("grant_type"))
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
    return typeof code === "string" && OAUTH_ERROR_CODES.has(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
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
  const classification =
    opts.classify === undefined
      ? undefined
      : reviewedClassification(opts.classify, `connector "${id}"`);
  const clientMetadataUrl = opts.auth?.type === "oauth" ? opts.auth.clientMetadataUrl : undefined;
  const oauthScope = opts.auth?.type === "oauth" ? opts.auth.scope : undefined;
  assertOAuthScope(id, oauthScope);
  const staticClient = opts.auth?.type === "oauth" && opts.auth.client ? { ...opts.auth.client } : undefined;
  assertRemoteOAuthClient(id, staticClient);
  if (staticClient && clientMetadataUrl !== undefined) throw new Error(`[connecta] connector "${id}" OAuth client and clientMetadataUrl are mutually exclusive.`);
  if (clientMetadataUrl !== undefined) {
    let valid = false;
    try {
      const url = new URL(clientMetadataUrl);
      valid = url.protocol === "https:" && url.pathname !== "/" &&
        !url.username && !url.password && !url.hash;
    } catch { /* Invalid configuration is rejected below without echoing its value. */ }
    if (!valid) throw new Error(`[connecta] connector "${id}" clientMetadataUrl must be an HTTPS URL with a non-root path, without credentials or a fragment.`);
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
  // A cached transport may dispatch concurrent calls and listings. Register
  // its actual sent auth with every operation using that client, including
  // handshake/discovery requests and OAuth rotations. Remove settled users.
  const activeSecrets = new WeakMap<ConnectionState, Set<SentSecrets>>();
  const trackSentRequest = (ctx: ConnectorContext, input: RequestInfo | URL, init?: RequestInit): void => {
    const recipients = new Set([sentSecretsFor(ctx), ...activeSecrets.get(entryFor(ctx)) ?? []]);
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

  const credentialAuth =
    opts.auth?.type === "credential" ? opts.auth : undefined;
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
    } catch { throw new Error(`remoteMcp(${JSON.stringify(id)}) requires valid request auth headers without Authorization.`); }
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
  const insecureDestination =
    destination.protocol !== "https:" && !isLoopbackHost(destination.hostname);
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
  const withoutAuthorizationServerText = (
    err: unknown,
    trail: OAuthTrail,
    signals: readonly (AbortSignal | undefined)[],
  ): unknown => {
    if (ownAbortReason(err, signals) && !hasSdkPayload(err)) return err;
    if (err instanceof RegistrationRejectedError) {
      const code = registrationErrorCode(err.body);
      const facts = {
        step: "OAuth client registration" as const,
        ...(trail.registration ? { origin: trail.registration } : {}),
        httpStatus: err.status,
        ...(code ? { oauthError: code } : {}),
      };
      return attachFailureFacts(carryFailureFacts(err, withheldAs(
        `Connector "${id}" could not register an OAuth client with ` +
          `${trail.registration ?? "its authorization server"}: the ` +
          `registration endpoint answered HTTP ${err.status}` +
          `${code ? ` with OAuth error ${code}` : ""}. Its response is ` +
          "withheld because it can quote the request or anything the server " +
          "chose to add. Check the server's client registration policy, then " +
          "retry authorization.",
        downstreamCallError(err, undefined, trail.last?.retryAfterMs),
      )), facts);
    }
    const leg = trail.last;
    const facts = leg
      ? { step: `OAuth ${leg.step}` as const, origin: leg.host, ...(leg.httpStatus ? { httpStatus: leg.httpStatus } : {}) }
      : { step: "OAuth flow" as const };
    if (err instanceof UnauthorizedError || err instanceof ConnectorCallError || err instanceof WithheldTextError) {
      return attachFailureFacts(downstreamCallError(err), facts);
    }
    const classified = downstreamCallError(err, leg?.httpStatus, leg?.retryAfterMs, leg?.step);
    if (err instanceof OAuthError || (classified instanceof ConnectorCallError && classified.code === "provider_permission_denied")) {
      return attachFailureFacts(carryFailureFacts(err, classified), facts);
    }
    return attachFailureFacts(carryFailureFacts(err, withheldAs(
      `Connector "${id}" OAuth ${leg ? `${leg.step} with ${leg.host}` : "flow"} ` +
        `failed${errorKind(err)}. The error is withheld because its text can ` +
        "quote what the server sent. Check the server's OAuth metadata, then " +
        "retry authorization.",
      classified,
    )), facts);
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
    step: "MCP handshake" | "tools/list" | "tools/call",
    transport: Transport | undefined,
    signals: readonly (AbortSignal | undefined)[],
  ): unknown => {
    // An OAuth flow already attached the step and origin it failed at. The
    // outer MCP operation must not replace them with the endpoint's facts.
    if (failureRecord({}, err).step?.startsWith("OAuth ")) return downstreamCallError(err);
    const httpStatus = err instanceof SdkHttpError ? err.status : undefined;
    const facts = { step, origin: endpointOrigin, ...(httpStatus ? { httpStatus } : {}) };
    const classified = downstreamCallError(redactSentSecrets(ctx, err), undefined, undefined, undefined, sentSecretsFor(ctx));
    const verdict = isOauth && classified instanceof ConnectorCallError && classified.code === "auth_required"
      ? carryFailureFacts(err, authRequiredError()) : classified;
    if (ownAbortReasonAsSdkReports(err, signals)) {
      return attachFailureFacts(carryFailureFacts(err, withheldAs(msg(err), verdict)), facts);
    }
    if (err instanceof InsufficientScopeError) {
      return attachFailureFacts(carryFailureFacts(err, verdict), facts);
    }
    if (requestAuth && httpStatus === 401) {
      return attachFailureFacts(new ConnectorCallError("auth_required", "The downstream rejected this request's Bearer token."), facts);
    }
    if (
      ownAbortReason(err, signals) ||
      keepsItsText(err, transport)
    ) {
      return attachFailureFacts(carryFailureFacts(err, redactSentSecrets(ctx,
        err instanceof UnauthorizedError || (ownAbortReason(err, signals) && !hasSdkPayload(err))
          ? err : verdict)), facts);
    }
    // The SDK wraps a failure of connecta's own fetch (a refused redirect, an
    // unreachable host) in an error of its own, such as the version probe's;
    // that failure's words are connecta's, and they say what happened.
    const ours = connectaErrorWithin(err);
    if (ours) {
      return attachFailureFacts(carryFailureFacts(ours, withheldAs(ours.message, ours)), facts);
    }
    const status = httpStatus ? ` with HTTP ${httpStatus}` : "";
    return attachFailureFacts(carryFailureFacts(err, withheldAs(
      `Connector "${id}" ${step} with ${endpointOrigin} failed${status}` +
        `${errorKind(err)}${sdkCheckFailed(err)}. The error is withheld because ` +
        "its text can quote what the server sent.",
      verdict,
    )), facts);
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
  ): void => {
    type FlowContext = { fetchFn?: FetchLike } & Record<string, unknown>;
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
    ): Promise<T> => {
      const trail: OAuthTrail = {};
      try {
        return await start((fetchFn) => tracedOAuthFetch(trail, endpoint, async (input, init) => {
          trackSentRequest(ctx, input, init);
          return await fetchFn(input, init);
        }));
      } catch (err) {
        throw withoutAuthorizationServerText(err, trail, signals);
      }
    };
    adapted.onUnauthorized = (ctx) =>
      flow((trace) =>
        onUnauthorized.call(adapted, { ...ctx, fetchFn: trace(ctx.fetchFn ?? fetch) }),
      );
    internals._stepUpAuthorize = (challenge, retries) =>
      flow((trace) => {
        const traced = trace(internals._fetchWithInit ?? fetch);
        // The step-up reads its fetch from `this`; everything else it reads
        // and writes stays the transport's own.
        const self = new Proxy(transport, {
          get: (target, key) =>
            key === "_fetchWithInit" ? traced : Reflect.get(target, key, target),
          set: (target, key, value) => Reflect.set(target, key, value, target),
        });
        return stepUp.call(self, challenge, retries);
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
      try { value = await requestAuth.token(ctx); } catch (error) {
        if (error instanceof ConnectorCallError) throw error;
        throw new ConnectorCallError("auth_required", "The request token could not be resolved.");
      }
      ctx.signal?.throwIfAborted();
      if (typeof value !== "string" || !value.trim() || Array.from(value).some((char) => { const code = char.charCodeAt(0); return code <= 32 || (code >= 127 && code <= 159); })) {
        throw new ConnectorCallError("auth_required", "The request token is empty or cannot be sent as a Bearer header.");
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
  const withoutCredential = (
    err: unknown,
    ...secrets: (string | null)[]
  ): unknown => {
    const quoted = secrets.filter(
      (secret): secret is string => typeof secret === "string" && secret !== "",
    );
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
  const scopeEndedError = () =>
    new ScopeEndedError(`Connector "${id}" scope ended during connection.`);

  const requestOptions = (ctx: ConnectorContext) =>
    ctx.timeoutMs || ctx.signal
      ? {
          ...(ctx.timeoutMs ? { timeout: ctx.timeoutMs } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }
      : undefined;

  /**
   * One `tools/list` request. The SDK schema is retained wholesale except for
   * accepting `null` as the common, unambiguous end-of-chain spelling. Other
   * cursor shapes still get a useful connector-level diagnosis.
   */
  const listPage = async (
    client: Client,
    cursor: string | undefined,
    ctx: ConnectorContext,
  ) => {
    try {
      return await client.request(
        {
          method: "tools/list",
          ...(cursor === undefined ? {} : { params: { cursor } }),
        },
        CompatibleListToolsResultSchema,
        requestOptions(ctx),
      );
    } catch (err) {
      if (!isCursorShapeError(err)) {
        throw atMcpBoundary(ctx, err, "tools/list", client.transport, [ctx.signal]);
      }
      // No cause: the validator's error describes the downstream's page.
      throw new Error(
        `Connector "${id}" returned a tools/list page whose nextCursor is neither a string, null, nor absent — this catalog cannot be walked.`,
      );
    }
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
        connecting: null,
        authRequired: false,
        provider: null,
        connectedGeneration: null,
        attemptProvider: null,
        credentialDigest: null,
      };
      states.set(key, state);
    }
    return state;
  };

  const isClosed = (state: ConnectionState): boolean =>
    state.scope.state._tag === "Closed";

  const stateFor = (ctx: ConnectorContext): ConnectionState => {
    const state = entryFor(ctx);
    if (isClosed(state)) throw scopeEndedError();
    return state;
  };

  const newProvider = (
    ctx: ConnectorContext,
    state?: ConnectionState,
    signal: AbortSignal | undefined = ctx.signal,
  ): KvOAuthProvider => {
    if (state?.provider) return state.provider;
    const metadataUrl = staticClient ? undefined : clientMetadataUrl ?? selfHostedClientUrl(ctx.publicUrl, id);
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
        clientMetadata: downstreamClientMetadata(redirectUri, oauthScope, ctx.oauthClientName,
          staticClient ? remoteClientAuthMethod(staticClient) : "none"),
        authScope: opts.authScope ?? "shared",
        versionNegotiation: opts.versionNegotiation ?? "auto",
        redirects: opts.redirects ?? "none",
        clientMetadataUrl: metadataUrl,
        ...(staticClient ? { client: { issuer: staticClient.issuer, clientId: staticClient.clientId, tokenEndpointAuthMethod: staticClient.tokenEndpointAuthMethod } } : {}),
      }),
      (reset) => trackOAuthStartReset(ctx.requestScope ?? ctx, reset),
      metadataUrl,
      oauthScope,
      undefined,
      { name: ctx.oauthClientName, client: staticClient },
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
    signal: AbortSignal | undefined = ctx.signal,
    /** The raw value behind `credentialFramed`, under the same terms. */
    credentialValue: string | null = null,
  ): Transport => {
    if (opts._transportFactory) return opts._transportFactory(ctx);
    const url = new URL(opts.url);
    const trackedFetch: FetchLike = async (input, init) => {
      trackSentRequest(ctx, input, init);
      return await fetch(input, init);
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
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider: oauthProvider,
        onInsufficientScope: "throw",
        fetch: refreshCoordinatorFor(ctx).coordinatedFetch(
          oauthProvider,
          learnedUrlSafeFetch(id, url, trackedFetch),
          signal,
          ctx.defer,
          learnedUrlSafeFetch(id, url, guardedFetch),
        ),
      });
      boundOAuthFlows(ctx, transport, url, [signal, ctx.signal]);
      return transport;
    }
    const headers =
      opts.auth?.type === "headers"
        ? opts.auth.headers
        : (credentialAuth || requestAuth) && credentialFramed !== null
          ? { ...requestAuth?.headers, [credentialHeader]: credentialFramed }
          : undefined;
    return new StreamableHTTPClientTransport(url, {
      ...(headers ? { requestInit: { headers } } : {}),
      fetch: guardedFetch,
    });
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
  const closeConnection = (
    client: Client | null,
    transport: Transport | null,
    logger: Logger,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const previous = transport && closingSessions.get(transport);
      if (previous) return Deferred.await(previous);
      const closed = Deferred.makeUnsafe<void>();
      // A connect can acquire a session after an early close. Deduplicate only
      // once that session exists, so its late abandonment still sends DELETE.
      if (transport?.sessionId) closingSessions.set(transport, closed);
      return (
        transport ? terminateSession(transport, logger, id) : Effect.void
      ).pipe(
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

  const ensureConnected = async (
    ctx: ConnectorContext,
    state: ConnectionState,
  ): Promise<Client> => {
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
      const provider = newProvider(ctx, state);
      oauthGeneration = await provider.liveEpoch();
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
      credentialFramed = credentialHeaderValue(
        credentialScheme,
        credentialValue,
      );
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
        if (isClosed(state)) throw scopeEndedError();
        closeHalf(state);
      }
    }
    if (isClosed(state)) throw scopeEndedError();
    if (state.client) return state.client;
    const attempt =
      state.connecting ??
      startConnect(ctx, state, credentialValue, credentialFramed, credentialDigest);
    // A Promise edge of its own, as architecture.md's "Effect inside" requires
    // of every shared wait: whatever this caller does next with the client is
    // its own I/O, so it resumes in its own continuation rather than inside the
    // call that completed the attempt.
    connectingWaiters.set(attempt, (connectingWaiters.get(attempt) ?? 0) + 1);
    let client: Client;
    try {
      client = await runEdge(Deferred.await(attempt), { signal: ctx.signal });
    } finally {
      const remaining = (connectingWaiters.get(attempt) ?? 1) - 1;
      if (remaining > 0) connectingWaiters.set(attempt, remaining);
      else {
        connectingWaiters.delete(attempt);
        // A cancelled waiter leaves its siblings' handshake alone. Once every
        // waiter has left, abandon the attempt and its OAuth refresh too.
        if (ctx.signal?.aborted && state.connecting === attempt) closeHalf(state);
      }
    }
    // Teardown can land between the attempt completing and this caller
    // resuming. The client it would hand back is being closed, and this scope
    // is over.
    if (isClosed(state)) throw scopeEndedError();
    return client;
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
      // Keep OAuth work cancellable by the connection's own lifetime instead;
      // requestOptions still passes each call's signal to the SDK separately.
      const connectionAbort = new AbortController();
      // Own cancellation before beginFlow's storage reads.
      // The lease first owns just the signal, then the transport it creates.
      const lease = Scope.forkUnsafe(state.scope);
      const handshakeAbort = new AbortController();
      const held: { client: Client | null; transport: Transport | null } = {
        client: null, transport: null,
      };
      yield* Scope.addFinalizer(
        lease,
        Effect.sync(() => handshakeAbort.abort()).pipe(
          Effect.andThen(Effect.suspend(() => {
            if (!held.transport) connectionAbort.abort();
            return closeConnection(held.client, held.transport, ctx.logger);
          })),
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
        const c = new Client(
          { name: "connecta", version: CONNECTA_VERSION },
          {
            versionNegotiation: {
              mode: opts.versionNegotiation ?? "auto",
            },
            // Connecta has no interactive relay. Surface the result manually
            // below as one structured, non-retryable connector failure.
            inputRequired: { autoFulfill: false },
          },
        );
        const t = buildTransport(ctx, provider, credentialFramed, connectionAbort.signal, credentialValue);
        if (!owned()) {
          held.transport = t;
          return yield* Effect.fail(scopeEndedError());
        }
        state.transport = t;
        held.transport = t;
        recordWireErrors(t);
        yield* promised(() => c.connect(t, { signal: handshakeAbort.signal })).pipe(
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
          const generation = yield* promised(() => provider.liveEpoch());
          // closeScope can land while the epoch read is pending, after
          // connect succeeded but before this client is cached. Discard the
          // client on that side of the await too.
          if (!owned()) return yield* Effect.fail(scopeEndedError());
          if (generation !== genAtStart) {
            return yield* Effect.fail(
              new UnauthorizedError(
                "Connector was re-authorized during connect; reconnect required.",
              ),
            );
          }
        }
        state.client = c;
        state.connectedGeneration = genAtStart;
        state.authRequired = false;
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
          return Effect.fail(
            withoutCredential(err, credentialValue, credentialFramed),
          );
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
      ? provider.disconnectAuthorization(learnedUrlSafeFetch(id, new URL(opts.url), async (input, init) => {
          trackSentRequest(ctx, input, init);
          return await fetch(input, init);
        }))
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
  const authDescription: ConnectorAuthDescription =
    requestAuth
      ? { mode: "request", header: "Authorization", scheme: "Bearer", ...(requestAuth.headers ? { headerNames: Object.keys(requestAuth.headers) } : {}) }
      : opts.auth?.type === "headers"
      ? { mode: "headers", headerNames: Object.keys(opts.auth.headers) }
      : credentialAuth
        ? { mode: "credential", header: credentialHeader, scheme: credentialScheme }
        : isOauth
          ? {
              mode: "oauth",
              ...(oauthScope !== undefined ? { scope: oauthScope } : {}),
              ...(describedClientMetadataUrl !== undefined
                ? { clientMetadataUrl: describedClientMetadataUrl }
                : {}),
            }
          : { mode: "none" };
  const endpoint = describedEndpoint(opts.url);

  const connector: Connector = {
    id,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    kind: "mcp",
    describe: () => ({
      source: { kind: "remote-mcp" },
      ...(endpoint ? { endpoint } : {}),
      auth: authDescription,
      transport: {
        versionNegotiation: opts.versionNegotiation ?? "auto",
        redirects: opts.redirects ?? "none",
        requireHttps: opts.requireHttps ?? false,
      },
    }),
    ...(opts.description !== undefined
      ? { description: opts.description }
      : {}),
    ...(opts.authScope !== undefined ? { authScope: opts.authScope } : {}),
    ...(opts.maxResultBytes !== undefined
      ? { maxResultBytes: opts.maxResultBytes }
      : {}),
    ...(opts.callAdmission !== undefined
      ? { callAdmission: opts.callAdmission }
      : {}),
    ...(opts.usageGuide !== undefined ? { usageGuide: opts.usageGuide } : {}),
    // Data the registry classifies every read with; listTools below returns
    // the downstream's listing unclassified.
    ...(classification !== undefined ? { classification } : {}),
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
          testCredential: async (
            value: string,
            ctx: ConnectorContext,
          ): Promise<CredentialTestResult> => {
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

    // `tools/list` is cursor-paginated: the server chooses the page size and
    // signals "there is more" with a `nextCursor`, which the SDK's
    // Client.listTools() returns without following. Collect the whole chain
    // here, because a half-collected catalog is indistinguishable from a small
    // one — later-page tools would simply appear not to exist, unsearchable and
    // unaddressable, with nothing anywhere saying why.
    //
    // All pages ride the one request-scoped client already connected above, and
    // the accumulator is returned rather than stored: a cursor is opaque and
    // session-bound, so nothing here may outlive this call.
    async listTools(ctx) {
      // The catalog contract: a downstream catalog is complete or it is a
      // failure. Follow every page to the end of the cursor chain, preserve
      // schemas and annotations, and never cache or serve a partial walk.
      const state = stateFor(ctx);
      // The client this call connected or joined, bound once so the whole walk
      // provably rides one session — a cursor is only meaningful to the
      // connection that issued it. Never re-read from `state`: a force reset
      // or rotation can null it before this call resumes, and teardown is
      // caught instead by the `closed` check before every page.
      const client = await ensureConnected(ctx, state);
      // Collect SDK tools for same-scope calls; sanitize the completed walk
      // before retaining definitions or returning cross-request metadata.
      const listed: ListedTool[] = [];
      const names = new Set<string>();
      const spent = new Set<string>();
      let cursor: string | undefined;
      /** Consecutive pages that advertised a successor but added nothing. */
      let barren = 0;
      let complete = false;
      try {
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          // The scope can end between pages (probe timeout, teardown). Stop
          // rather than keep paging into a transport that is being closed.
          if (isClosed(state)) throw scopeEndedError();
          // A discovery deadline uses the same signal for the whole chain.
          // Check it before issuing each page as well as passing it to the
          // in-flight SDK request, so expiry never starts one more round trip.
          if (ctx.signal?.aborted) {
            throw ctx.signal.reason instanceof Error
              ? ctx.signal.reason
              : new Error(`Connector "${id}" catalog deadline expired.`);
          }
          // Page one sends no params at all, so a non-paginated server sees
          // exactly the request it saw before pagination existed.
          const res = await listPage(client, cursor, ctx);
          let added = 0;
          for (const t of res.tools) {
            // First page wins. An unstable cursor can serve the same tool on
            // two pages — a duplicate would inflate `toolCount`, double the
            // `search_tools` row, and churn catalog persistence.
            if (names.has(t.name)) continue;
            names.add(t.name);
            listed.push(t);
            added++;
          }
          // Pagination ends when `nextCursor` is absent or null — never merely
          // falsy. Empty string is present and means "keep going".
          const next = res.nextCursor;
          if (next === undefined || next === null) {
            complete = true;
            break;
          }
          // A page that adds nothing and still claims a successor made no
          // progress. Allow exactly one: the widespread idiom is to advertise
          // a cursor whenever a page came back full and then serve one empty
          // page to terminate. Two in a row is a downstream going nowhere.
          if (added === 0 && ++barren > 1) {
            throw new Error(
              `Connector "${id}" returned two consecutive tools/list pages that added no tools and still advertised another — the catalog is not advancing.`,
            );
          }
          if (added > 0) barren = 0;
          // A cursor handed back a second time is a loop, not a slow server.
          if (spent.has(next)) {
            throw new Error(
              `Connector "${id}" handed back a tools/list cursor it had already issued — the pagination chain loops.`,
            );
          }
          // Checked here rather than on arrival: this bounds what a *walk* may
          // accumulate; a one-page server was always free to send its page.
          if (listed.length > MAX_CATALOG_TOOLS) {
            throw new Error(
              `Connector "${id}" advertised further tools/list pages past ${listed.length} tools, over the ${MAX_CATALOG_TOOLS}-tool ceiling one catalog refresh will collect.`,
            );
          }
          // Opaque by contract: handed straight back, never parsed, rewritten,
          // or persisted.
          spent.add(next);
          cursor = next;
        }
      } catch (err) {
        // A grant can be revoked after connect and after any earlier page.
        // Classify that exactly like connect-time and call-time authorization
        // failures, and latch it for the rest of this request scope.
        if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
        if (requiresAuthorization(err)) {
          if (state.client === client) state.authRequired = true;
          if (err instanceof UnauthorizedError) throw carryFailureFacts(err, authRequiredError());
        }
        throw err;
      }
      // Fail the refresh outright. Returning what we have would publish a
      // partial catalog that looks complete; throwing lets the registry keep
      // serving the last complete one via its stale fallback.
      if (!complete) {
        throw new Error(
          `Connector "${id}" kept advertising more tools/list pages after ${MAX_TOOL_PAGES} — refusing to page further.`,
        );
      }
      // Publish definitions only after the full walk succeeds. A later-page
      // failure must not leave a partial validation/header view behind.
      const clean = redactCatalog(ctx, listed);
      state.toolDefinitions = new Map(clean.map((tool) => [tool.name, tool]));
      return clean.map((t) => ({
        name: t.name,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.icons !== undefined
          ? {
              // Inline images can consume the catalog ceiling and storage chunks.
              // The SDK needs no icons for validation or parameter mirroring.
              icons: t.icons.filter((icon) => !/^data:/i.test(icon.src)) as
                NonNullable<ToolDef["icons"]>,
            }
          : {}),
        ...(t.execution !== undefined
          ? { execution: t.execution as NonNullable<ToolDef["execution"]> }
          : {}),
        // SEP-2243 declarations live in inputSchema. SDK validation and header
        // mirroring need no _meta keys, so arbitrary downstream metadata stays
        // out of the persisted catalog.
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined
          ? {
              inputSchema: t.inputSchema as NonNullable<
                ToolDef["inputSchema"]
              >,
            }
          : {}),
        ...(t.outputSchema !== undefined
          ? {
              outputSchema: t.outputSchema as NonNullable<
                ToolDef["outputSchema"]
              >,
            }
          : {}),
        ...(t.annotations !== undefined
          ? {
              annotations: t.annotations as NonNullable<
                ToolDef["annotations"]
              >,
            }
          : {}),
      }));
    },

    async callTool(name, args, ctx, options) {
      if (classification?.unlisted === "hide" && !Object.hasOwn(classification.tools, name)) {
        throw new ConnectorCallError("invalid_args", "This tool is not in the connector allowlist.");
      }
      const state = stateFor(ctx);
      const client = await ensureConnected(ctx, state);
      try {
        const definition = options?.definition;
        const toolDefinition = definition
          ? {
              ...definition,
              // Older stored catalogs and custom connectors may omit inputSchema.
              inputSchema: (definition.inputSchema ?? { type: "object" }) as
                Tool["inputSchema"],
            }
          : state.toolDefinitions.get(name);
        if (toolDefinition?.execution?.taskSupport === "required") {
          throw new ConnectorCallError("connector_call_failed",
            `Tool "${name}" requires task-based execution, which Connecta does not support.`,
          );
        }
        const result = await client
          .callTool(
            {
              name,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            {
              ...requestOptions(ctx),
              allowInputRequired: true,
              ...(toolDefinition ? { toolDefinition } : {}),
            },
          )
          .catch((err: unknown) => {
            throw atMcpBoundary(ctx, err, "tools/call", client.transport, [ctx.signal]);
          });
        if (isInputRequiredResult(result)) {
          throw new ConnectorCallError(
            "input_required_unsupported",
            `Connector "${id}" returned input_required for "${name}". ` +
              "Connecta cannot relay multi-round-trip input yet; this " +
              "capability is gated pending real host and downstream adoption.",
          );
        }
        return result;
      } catch (err) {
        // A grant revoked after connect surfaces here, not in ensureConnected.
        if (ownAbortReason(err, [ctx.signal]) && !hasSdkPayload(err)) throw err;
        if (requiresAuthorization(err)) {
          if (state.client === client) state.authRequired = true;
          if (err instanceof UnauthorizedError) throw carryFailureFacts(err, authRequiredError());
        }
        throw downstreamCallError(err, undefined, undefined, undefined, sentSecretsFor(ctx));
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
      reset(state);
      // Runs the live connection's lease finalizer, if there is one.
      if (release) await runEdge(release);
    },

    async status(ctx): Promise<ConnectorStatus> {
      const state = stateFor(ctx);
      const report = async (status: ConnectorStatus) => {
        const path = isOauth ? await newProvider(ctx, state).registrationPath() : undefined;
        return ownStatus({ ...status, ...(path ? { registrationPath: path } : {}) });
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
      // Always a transport of the exchange's own, over the provider that
      // verified the state: that provider holds the consent's claim, and the
      // fence before the token request is its to cross. A connection this
      // scope opened earlier speaks for its connect attempt, not this callback.
      const t = buildTransport(ctx, provider) as StreamableHTTPClientTransport;
      const trail: OAuthTrail = {};
      const internals = t as unknown as { _fetchWithInit?: FetchLike };
      const traced = tracedOAuthFetch(trail, new URL(opts.url), internals._fetchWithInit ?? fetch);
      const exchange = new Proxy(t, {
        get: (target, key) => key === "_fetchWithInit" ? traced : Reflect.get(target, key, target),
        set: (target, key, value) => Reflect.set(target, key, value, target),
      });
      try {
        await exchange.finishAuth(callbackParams);
        // Reset so the next use reconnects with the freshly stored tokens.
        closeHalf(state);
      } catch (err) {
        throw withoutAuthorizationServerText(err, trail, [ctx.signal]);
      } finally {
        // This exchange-only transport has no lease in the request scope.
        detach(closeConnection(null, t, ctx.logger));
      }
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
            authorizationUrl = await state.attemptProvider?.consentUrl();
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

  const withActiveSecrets = async <T>(ctx: ConnectorContext, run: () => Promise<T>): Promise<T> => {
    trackCredentialReads(ctx);
    const secrets = sentSecretsFor(ctx);
    if (opts.auth?.type === "headers") {
      for (const value of Object.values(opts.auth.headers)) secrets.header(value);
    }
    const state = entryFor(ctx);
    let active = activeSecrets.get(state);
    if (!active) { active = new Set(); activeSecrets.set(state, active); }
    active.add(secrets);
    try { return redactSentSecrets(ctx, await run()); }
    catch (error) { throw redactSentSecrets(ctx, error); }
    finally { active.delete(secrets); }
  };
  const callTool = connector.callTool;
  connector.callTool = (name, args, ctx, options) =>
    withActiveSecrets(ctx, () => callTool(name, args, ctx, options));
  const listTools = connector.listTools;
  connector.listTools = (ctx) => withActiveSecrets(ctx, () => listTools(ctx));

  if (isOauth && !staticClient && clientMetadataUrl === undefined) declareSelfHostedClient(connector, oauthScope);
  if (isOauth) {
    const start = connector.startAuth!;
    connector.startAuth = async (...args) => {
      const status = await start(...args);
      const path = await newProvider(args[0], stateFor(args[0])).registrationPath();
      return { ...status, ...(path ? { registrationPath: path } : {}) };
    };
    // Pin before the first asynchronous storage/discovery read, not only once
    // a refresh flight exists. These operations do not take call admission.
    const retain = retainingOAuthPartition;
    connector.listTools = retain(connector.listTools, 0);
    connector.callTool = retain(connector.callTool, 2);
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
  if (connector.startAuth) connector.startAuth = payloadFree(connector.startAuth);
  if (connector.finishAuth) connector.finishAuth = payloadFree(connector.finishAuth);
  return connector;
}
