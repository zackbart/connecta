import {
  Client,
  ProtocolError,
  SdkHttpError,
  isInputRequiredResult,
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
  KvOAuthProvider,
  OAuthRefreshCoordinator,
} from "../auth/downstream-oauth.js";
import { MAX_CATALOG_TOOLS } from "../catalog-limits.js";
import {
  boundedEchoText,
  ConnectorCallError,
  msg,
  unavailableCallError,
} from "../errors.js";
import { CONNECTA_VERSION } from "../version.js";
import { learnedUrlRefusal } from "../url-safety.js";
import { inheritOAuthSealer, oauthSealerFor } from "../oauth-sealing.js";
import { detach, runEdge } from "../runtime/run.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
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
   * so `"Basic"` produces `Basic <base64>` and Mixpanel's documented
   * `"Bearer Basic"` produces `Bearer Basic <base64>`.
   */
  scheme?: string | null;
}

export type RemoteMcpAuth =
  | { type: "headers"; headers: Record<string, string> }
  | RemoteMcpCredentialAuth
  | { type: "oauth" };

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
   * it. Must be a whole number of bytes >= 1; anything else warns at startup
   * and is ignored.
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
  const warn = (message: string, error?: unknown) =>
    Effect.sync(() => {
      try {
        if (error === undefined) logger.warn(message);
        else logger.warn(message, error);
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
        warn(
          `[connecta] connector "${connectorId}" session termination was ` +
            "refused or failed; the downstream session may remain until its " +
            "provider timeout.",
          error,
        ),
      ),
    ),
    Effect.sleep(Duration.millis(TERMINATE_SESSION_BUDGET_MS)).pipe(
      Effect.andThen(
        warn(
          `[connecta] connector "${connectorId}" session termination was not ` +
            `acknowledged within ${TERMINATE_SESSION_BUDGET_MS} ms; the ` +
            "downstream may still finish the headers-only DELETE, otherwise " +
            "the session will remain until its provider timeout.",
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

/** Classify protocol/status facts; provider prose never decides retryability. */
function downstreamCallError(error: unknown): unknown {
  if (error instanceof ProtocolError && error.code === -32602) {
    return new ConnectorCallError("invalid_args", boundedEchoText(error.message));
  }
  if (error instanceof SdkHttpError && error.status >= 400 && error.status < 500) {
    let message = error.message;
    if (typeof error.data.text === "string") {
      try {
        const body = JSON.parse(error.data.text);
        const detail = body?.message ?? body?.error?.message ?? body?.error_description;
        if (typeof detail === "string") message = detail;
      } catch {
        // Non-JSON refusals still retain a bounded diagnostic.
      }
    }
    return new ConnectorCallError(
      error.status === 429 ? "rate_limited" : error.status === 408 ? "timeout" : "connector_call_failed",
      boundedEchoText(message),
    );
  }
  return error;
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
        if (cause instanceof ConnectorCallError) throw cause;
        throw unavailableCallError(cause, current.href);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;

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

class RemoteMcpDestinationError extends ConnectorCallError {
  constructor(connectorId: string, reason: string) {
    super(
      "connector_call_failed",
      `Connector "${connectorId}" refused an OAuth URL the downstream advertised: ${reason}.`,
    );
    this.name = "RemoteMcpDestinationError";
  }
}

/**
 * Refuse, before any request leaves, a URL the downstream taught the OAuth
 * flow that points somewhere connecta must not go (see `url-safety.ts`).
 *
 * The SDK learns authorization-server, token, and registration URLs from the
 * downstream's own metadata and fetches them through the transport's fetch,
 * so this sits on that fetch: above `redirectSafeFetch`, whose same-origin
 * rule keeps every hop on the host checked here, and below the refresh
 * coordinator, which already treats a non-retryable `ConnectorCallError` as
 * connecta's own refusal rather than a token-endpoint verdict.
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
    return await baseFetch(input, init);
  };
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
   * transport is built. Closing it closes that transport — through its client
   * once one is cached — and closing `scope` closes it too.
   */
  lease: Scope.Closeable | null;
  client: Client | null;
  transport: Transport | null;
  /**
   * The last complete raw catalog, retained only for this request scope.
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
  const isOauth = opts.auth?.type === "oauth";
  // Long-lived enough for distinct request scopes in this connector runtime to
  // join one token redemption. It owns no client, transport, or request state.
  const refreshCoordinator = new OAuthRefreshCoordinator();
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
  const insecureDestination =
    destination.protocol !== "https:" && !isLoopbackHost(destination.hostname);
  if (insecureDestination) {
    if (opts.requireHttps) {
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

  /** Typed per-call auth signal; the SDK's UnauthorizedError stays as cause. */
  const authRequiredError = (cause: unknown) =>
    new ConnectorCallError(
      "auth_required",
      `Connector "${id}" requires authorization — call authorize_connector({ connector: "${id}" }) and open the returned URL.`,
      { cause },
    );

  class OperatorDisconnectedError extends ConnectorCallError {
    constructor() {
      super(
        "auth_required",
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

  const scopeEndedError = () =>
    new Error(`Connector "${id}" scope ended during connection.`);

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
      if (!isCursorShapeError(err)) throw err;
      throw new Error(
        `Connector "${id}" returned a tools/list page whose nextCursor is neither a string, null, nor absent — this catalog cannot be walked.`,
        { cause: err },
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
  ): KvOAuthProvider => {
    if (state?.provider) return state.provider;
    const provider = new KvOAuthProvider(
      id,
      ctx.storage,
      `${ctx.baseUrl}/oauth/callback/${id}`,
      refreshCoordinator,
      ctx.allowAuthorization === true,
      oauthSealerFor(ctx),
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
  ): Transport => {
    if (opts._transportFactory) return opts._transportFactory(ctx);
    const url = new URL(opts.url);
    const guardedFetch = redirectSafeFetch(id, opts.redirects);
    if (opts.auth?.type === "oauth") {
      const oauthProvider = provider ?? newProvider(ctx);
      return new StreamableHTTPClientTransport(url, {
        authProvider: oauthProvider,
        fetch: refreshCoordinator.coordinatedFetch(
          oauthProvider,
          learnedUrlSafeFetch(id, url, guardedFetch),
          ctx.signal,
        ),
      });
    }
    const headers =
      opts.auth?.type === "headers"
        ? opts.auth.headers
        : credentialAuth && credentialFramed !== null
          ? { [credentialHeader]: credentialFramed }
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

  // The context has no deferred-work hook. Detached exits start this bounded
  // best-effort tail immediately; closeScope awaits its own tail so the core
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
      throw authRequiredError(
        new UnauthorizedError("Downstream authorization is no longer valid."),
      );
    }
    // Read the OAuth epoch before trusting either a cached client or starting a
    // transport. A disconnected epoch is a durable operator instruction, not
    // merely the absence of credentials: passive status/tool probes must not
    // turn it back into a pending consent flow.
    let oauthGeneration: string | undefined;
    if (isOauth && (state.client || state.connecting)) {
      const provider = newProvider(ctx, state);
      oauthGeneration = await provider.generation();
      if (provider.isOperatorDisconnectedGeneration(oauthGeneration)) {
        closeHalf(state);
        throw operatorDisconnectedError();
      }
    }
    // Cross-isolate force re-auth: another isolate bumped the KV generation and
    // wiped credentials. This request's cached client still speaks the old
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
    if (credentialAuth) {
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
    const client = await runEdge(Deferred.await(attempt));
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
      // A provider belongs to exactly one connect attempt. A force reset can
      // abandon that attempt while its transport still holds the provider;
      // the replacement must never mutate the abandoned provider's epoch.
      const provider = isOauth ? newProvider(ctx) : null;
      const genAtStart = provider ? yield* promised(() => provider.generation()) : "";
      if (!owned()) return yield* Effect.fail(scopeEndedError());
      if (provider?.isOperatorDisconnectedGeneration(genAtStart)) {
        return yield* Effect.fail(operatorDisconnectedError());
      }
      provider?.captureGeneration(genAtStart);
      // SDK v2 selects its validator by runtime export condition: AJV on
      // Node and @cfworker/json-schema under workerd. The Workers-safe path
      // no longer needs Connecta-specific wiring.
      const handshakeAbort = new AbortController();
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
      // @modelcontextprotocol/client 2.0.0 can attempt the legacy initialized
      // notification after we close its transport. Its rejected Promise is
      // unhandled under workerd even though connect() has a caller. This
      // connection is already abandoned, so skip only that final handshake
      // notification after our abort. Remove when the SDK owns this race.
      const notify = c.notification.bind(c);
      c.notification = (message, options) => {
        if (handshakeAbort.signal.aborted && message.method === "notifications/initialized") {
          return Promise.resolve();
        }
        return notify(message, options);
      };
      const t = buildTransport(ctx, provider, credentialFramed);
      if (!owned()) {
        detach(closeConnection(null, t, ctx.logger));
        return yield* Effect.fail(scopeEndedError());
      }
      // From here the connection has a lease on the scope, and closing it —
      // force reset, rotation, teardown — closes this transport: through the
      // client once one is cached, the bare transport until then, which is
      // what aborts a connect still in flight.
      const lease = Scope.forkUnsafe(state.scope);
      const held: { client: Client | null } = { client: null };
      yield* Scope.addFinalizer(
        lease,
        Effect.sync(() => handshakeAbort.abort()).pipe(
          Effect.andThen(Effect.suspend(() => closeConnection(held.client, t, ctx.logger))),
        ),
      );
      state.lease = lease;
      state.transport = t;
      return yield* Effect.gen(function* () {
        yield* promised(() => c.connect(t, { signal: handshakeAbort.signal }));
        // A probe deadline can end its scope while connect is still in flight.
        // The transport is closed immediately by closeScope; if connect wins
        // that race anyway, close the resulting client rather than resurrecting
        // a session in the detached state object.
        if (!owned()) return yield* Effect.fail(scopeEndedError());
        // A force re-auth that landed WHILE we were connecting wiped the
        // credentials this client just bound to. Discard it rather than cache
        // a stale-isolate connection.
        if (provider) {
          const generation = yield* promised(() => provider.generation());
          // closeScope can land while the generation read is pending, after
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
        held.client = c;
        state.client = c;
        state.connectedGeneration = genAtStart;
        state.authRequired = false;
        return c;
      }).pipe(
        Effect.catch((err) => {
          // Close the failed connection through its client, without waiting.
          held.client = c;
          if (owned()) {
            state.lease = null;
            state.transport = null;
            // Only a real 401/UnauthorizedError means auth is the problem —
            // a network error on an oauth connector must surface as "error",
            // not "auth_required".
            if (err instanceof UnauthorizedError) state.authRequired = true;
            const release = Scope.closeUnsafe(lease, Exit.void);
            if (release) detach(release);
          } else {
            // Whoever abandoned this attempt closed the lease already, while
            // the connect was in flight. A session it acquired after that
            // close still owes its DELETE.
            detach(closeConnection(c, t, ctx.logger));
          }
          if (err instanceof UnauthorizedError) {
            return Effect.fail(authRequiredError(err));
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
  ): Promise<void> => {
    const provider = newProvider(ctx, state);
    // Publish the replacement epoch before waiting on or closing any
    // request-local transport. A hung connect therefore cannot delay the
    // fence, and every late OAuth write stays in the older namespace.
    try {
      await provider.resetAuthorization(operatorDisconnected);
    } finally {
      // Abandon any connect in flight and close whichever half of the
      // client/transport exists. Reset is unconditional because KV may already
      // be fenced behind a newer epoch after a cleanup error.
      closeHalf(state);
    }
  };

  const connector: Connector = {
    id,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    kind: "mcp",
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
              // A test owns the scope it just opened; leaving the session for
              // the downstream to age out is not this button's to spend.
              await connector.closeScope?.(ctx);
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
      // Raw SDK tools, not ToolDefs: the metadata re-prime below needs fields
      // (task support) that a ToolDef deliberately does not carry.
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
        if (err instanceof UnauthorizedError) {
          if (state.client === client) state.authRequired = true;
          throw authRequiredError(err);
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
      state.toolDefinitions = new Map(listed.map((tool) => [tool.name, tool]));
      return listed.map((t) => ({
        name: t.name,
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

    async callTool(name, args, ctx) {
      const state = stateFor(ctx);
      const client = await ensureConnected(ctx, state);
      try {
        const toolDefinition = state.toolDefinitions.get(name);
        if (toolDefinition?.execution?.taskSupport === "required") {
          throw new Error(
            `Tool "${name}" requires task-based execution, which Connecta does not support.`,
          );
        }
        const result = await client.callTool(
          {
            name,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          {
            ...requestOptions(ctx),
            allowInputRequired: true,
            ...(toolDefinition ? { toolDefinition } : {}),
          },
        );
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
        if (err instanceof UnauthorizedError) {
          if (state.client === client) state.authRequired = true;
          throw authRequiredError(err);
        }
        throw downstreamCallError(err);
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
      try {
        await ensureConnected(ctx, state);
        return { state: "ok" };
      } catch (err) {
        // An empty slot, or one with no vault behind it, is reported the way a
        // missing grant is: present, unauthenticated, and repairable — never a
        // boot failure and never a silently absent connector.
        if (err instanceof CredentialRequiredError) {
          return { state: "auth_required", message: err.message };
        }
        if (state.authRequired) {
          // Only an OAuth connector has a pending consent URL to offer. A
          // credential connector's downstream 401 is repaired in the operator
          // UI connection, so do not reach into OAuth storage to look for one.
          return {
            state: "auth_required",
            message: credentialAuth
              ? "Authorization required — the downstream rejected this connector's stored credential."
              : "Authorization required — open the URL to connect.",
          };
        }
        if (err instanceof OperatorDisconnectedError) {
          return { state: "auth_required", message: err.message };
        }
        return { state: "error", message: msg(err) };
      }
    },

    async finishAuth(code, ctx, callbackParams) {
      const state = stateFor(ctx);
      const provider = newProvider(ctx, state);
      // verifyState ran on this request-scoped provider first and captured the
      // pending flow's generation. If force reset races the exchange, any late
      // token write remains tagged with that older generation and is unreadable.
      // A transport an attempt built belongs to that attempt's lease; one built
      // here for the exchange alone belongs to this call, which closes it.
      const leased = state.transport;
      const t = (leased ??
        buildTransport(ctx, provider)) as StreamableHTTPClientTransport;
      if (callbackParams !== undefined) {
        await t.finishAuth(callbackParams);
      } else {
        await t.finishAuth(code);
      }
      await provider.clearPending();
      // Reset so the next use reconnects with the freshly stored tokens.
      closeHalf(state);
      if (!leased) detach(closeConnection(null, t, ctx.logger));
    },
  };

  if (opts.auth?.type === "oauth") {
    connector.verifyState = async (oauthState, ctx) => {
      const state = stateFor(ctx);
      return newProvider(ctx, state).verifyState(oauthState);
    };

    connector.disconnectAuth = async (ctx) => {
      await disconnectAuthorization(ctx, stateFor(ctx), true);
    };

    connector.startAuth = async (ctx, startOpts) => {
      ctx = inheritOAuthSealer(ctx, {
        ...ctx,
        requestScope: ctx.requestScope ?? ctx,
        allowAuthorization: true,
      });
      const state = stateFor(ctx);
      state.provider = null;
      const p = newProvider(ctx, state);
      if (startOpts?.force || (await p.operatorDisconnected())) {
        await disconnectAuthorization(ctx, state);
      } else {
        // A consent URL already outstanding? Re-issue it rather than re-running
        // the SDK flow, which would overwrite the PKCE verifier and invalidate
        // the URL the operator may be mid-consent on.
        const pending = await p.pendingAuthorizationUrl();
        if (pending) {
          return {
            state: "auth_required",
            authorizationUrl: pending,
            message: "Authorization required — open the URL to connect.",
          };
        }
      }
      try {
        await ensureConnected(ctx, state);
        return {
          state: "ok",
          message: "Already authorized — connection is healthy.",
        };
      } catch (err) {
        if (state.authRequired) {
          const authorizationUrl = await p.pendingAuthorizationUrl();
          return {
            state: "auth_required",
            ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
            message: "Authorization required — open the URL to connect.",
          };
        }
        return { state: "error", message: msg(err) };
      }
    };
  }

  return connector;
}
