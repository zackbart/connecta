import { auth, OAuthError, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationContext,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import { byteReadResponse } from "../byte-read-response.js";
import type {
  ApiOAuthClientAuthentication,
  ApiOAuthConfig,
  ApiOAuthHooks,
} from "../connectors/api-connector.js";
import { redirectSafeFetch } from "../connectors/remote-mcp.js";
import { ConnectorCallError, msg } from "../errors.js";
import {
  oauthPartitionFor,
  retainOAuthPartition,
  retainingOAuthPartition,
} from "../oauth-partition.js";
import { oauthSealerFor } from "../oauth-sealing.js";
import { describeFailure } from "../operator-record.js";
import type { ConnectorContext, ConnectorStatus } from "../types.js";
import {
  assertOAuthScope,
  authorizingContext,
  KvOAuthProvider,
  LEGACY_GENERATION,
  refreshCoordinatorsByPartition,
} from "./downstream-oauth.js";
import type { OAuthRefreshCoordinator } from "./downstream-oauth.js";
import { trackOAuthStartReset } from "./oauth-start-reset.js";

/**
 * Downstream OAuth for a hand-written `api()` connector: the authorization
 * code grant against endpoints and a pre-registered client the deployment
 * declares, rather than ones a server advertises.
 *
 * Everything that makes the `remoteMcp()` grant safe is reused, not copied.
 * `StaticOAuthProvider` is a `KvOAuthProvider` — the same epochs, sealing,
 * owner partitions, generation fence, reset lineage, and refresh-failure
 * verdicts — whose discovery state and client are constants, and the SDK's
 * own `auth()` drives it through the same `OAuthRefreshCoordinator`. What a
 * static configuration subtracts is the network learning: no RFC 9728 or 8414
 * discovery and no dynamic registration, so no URL here was taught to
 * connecta by a downstream.
 */

/** Parameters the grant itself owns; a deployment may not restate them. */
const RESERVED_AUTHORIZATION_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "resource",
]);

/** Token-request headers the grant owns: client authentication and framing. */
const RESERVED_TOKEN_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "content-type",
  "content-length",
  "cookie",
  "host",
]);

/** An RFC 9110 field-name token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const CLIENT_AUTHENTICATION: ReadonlySet<string> = new Set([
  "client_secret_basic",
  "client_secret_post",
  "none",
]);

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** An absolute HTTPS URL (or HTTP on loopback), without credentials or fragment. */
function configuredUrl(id: string, option: string, value: unknown): URL {
  let url: URL | undefined;
  try {
    url = new URL(String(value));
  } catch {
    // Reported below without echoing the value.
  }
  if (
    !url ||
    !(url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      `[connecta] connector "${id}" oauth.${option} must be an absolute https URL ` +
        "(http only on loopback), without credentials or a fragment.",
    );
  }
  return url;
}

interface StaticOAuthSettings {
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  clientId: string;
  clientSecret?: string;
  clientAuthentication: ApiOAuthClientAuthentication;
  scope?: string;
  pkce: boolean;
  authorizationParams: ReadonlyArray<readonly [string, string]>;
  tokenRequestHeaders: ReadonlyArray<readonly [string, string]>;
  apiOrigins: ReadonlySet<string>;
  /** Where the SDK's `serverUrl` points: the first API origin. */
  serverUrl: URL;
  /**
   * The authorization server identity tokens are bound to. A static
   * configuration has no advertised issuer, so the token endpoint stands in:
   * repointing it is repointing the grant, and the issuer-bound read then
   * fences the old tokens behind a new epoch instead of sending them to the
   * new server.
   */
  identity: string;
}

/** Structural mistakes throw here, where they are written. */
function settingsFor(id: string, config: ApiOAuthConfig): StaticOAuthSettings {
  if (!config || typeof config !== "object") {
    throw new Error(`[connecta] connector "${id}" oauth must be an object.`);
  }
  const authorizationEndpoint = configuredUrl(id, "authorizationEndpoint", config.authorizationEndpoint);
  const tokenEndpoint = configuredUrl(id, "tokenEndpoint", config.tokenEndpoint);
  if (tokenEndpoint.search) {
    throw new Error(`[connecta] connector "${id}" oauth.tokenEndpoint must not carry a query.`);
  }
  if (typeof config.clientId !== "string" || config.clientId.trim() === "") {
    throw new Error(`[connecta] connector "${id}" oauth.clientId must be a non-empty string.`);
  }
  if (
    config.clientSecret !== undefined &&
    (typeof config.clientSecret !== "string" || config.clientSecret === "")
  ) {
    // Usually an unset environment variable read as "". Never echo it.
    throw new Error(
      `[connecta] connector "${id}" oauth.clientSecret must be a non-empty string when set.`,
    );
  }
  const clientAuthentication =
    config.tokenEndpointAuthMethod ??
    (config.clientSecret !== undefined ? "client_secret_basic" : "none");
  if (!CLIENT_AUTHENTICATION.has(clientAuthentication)) {
    throw new Error(
      `[connecta] connector "${id}" oauth.tokenEndpointAuthMethod must be ` +
        '"client_secret_basic", "client_secret_post", or "none".',
    );
  }
  if (clientAuthentication === "none" && config.clientSecret !== undefined) {
    throw new Error(
      `[connecta] connector "${id}" oauth declares a clientSecret with ` +
        'tokenEndpointAuthMethod "none"; a public client sends no secret.',
    );
  }
  if (clientAuthentication !== "none" && config.clientSecret === undefined) {
    throw new Error(
      `[connecta] connector "${id}" oauth.tokenEndpointAuthMethod ` +
        `"${clientAuthentication}" needs a clientSecret.`,
    );
  }
  assertOAuthScope(id, config.scope);
  const authorizationParams: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(config.authorizationParams ?? {})) {
    if (RESERVED_AUTHORIZATION_PARAMS.has(name)) {
      throw new Error(
        `[connecta] connector "${id}" oauth.authorizationParams may not set ` +
          `"${name}"; the authorization request owns it.`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `[connecta] connector "${id}" oauth.authorizationParams.${name} must be a string.`,
      );
    }
    authorizationParams.push([name, value]);
  }
  const tokenRequestHeaders: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(config.tokenRequestHeaders ?? {})) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(
        `[connecta] connector "${id}" oauth.tokenRequestHeaders has an invalid header name.`,
      );
    }
    if (RESERVED_TOKEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `[connecta] connector "${id}" oauth.tokenRequestHeaders may not set ` +
          `"${name}"; the token request owns it.`,
      );
    }
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n") || value.includes("\0")) {
      throw new Error(
        `[connecta] connector "${id}" oauth.tokenRequestHeaders.${name} must be a single-line string.`,
      );
    }
    tokenRequestHeaders.push([name, value]);
  }
  const origins = Array.isArray(config.apiOrigins) ? config.apiOrigins : [];
  if (origins.length === 0) {
    throw new Error(
      `[connecta] connector "${id}" oauth.apiOrigins must name at least one ` +
        "origin; ctx.oauth.fetch sends the access token nowhere else.",
    );
  }
  const apiOrigins = new Set<string>();
  for (const origin of origins) {
    const url = configuredUrl(id, "apiOrigins", origin);
    if (url.origin !== origin) {
      throw new Error(
        `[connecta] connector "${id}" oauth.apiOrigins entries must be exact ` +
          'origins, like "https://api.example.com", with no path or trailing slash.',
      );
    }
    apiOrigins.add(url.origin);
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    clientId: config.clientId,
    ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    clientAuthentication,
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    pkce: config.pkce ?? true,
    authorizationParams,
    tokenRequestHeaders,
    apiOrigins,
    serverUrl: new URL(origins[0]!),
    identity: tokenEndpoint.href,
  };
}

/**
 * A `KvOAuthProvider` whose discovery and client are constants. Storage,
 * sealing, epochs, refresh coordination, and the authorization hooks are the
 * base class's, unchanged; only what discovery and registration would have
 * written is answered from configuration and never written.
 */
class StaticOAuthProvider extends KvOAuthProvider {
  /** Set only for the code exchange of a PKCE-less flow. */
  private exchangeCode: string | undefined;

  constructor(
    connectorId: string,
    ctx: ConnectorContext,
    coordinator: OAuthRefreshCoordinator,
    private readonly settings: StaticOAuthSettings,
  ) {
    super(
      connectorId,
      ctx.storage,
      `${ctx.baseUrl}/oauth/callback/${connectorId}`,
      coordinator,
      ctx.allowAuthorization === true,
      oauthSealerFor(ctx),
      ctx.signal,
      // No client binding: the client is configuration, so there is no
      // registration for a restart to carry forward or discard.
      undefined,
      (reset) => trackOAuthStartReset(ctx.requestScope ?? ctx, reset),
      undefined,
      settings.scope,
    );
  }

  /**
   * The pre-registered client, answered from configuration. Its secret is
   * never written to storage, sealed or otherwise: it is deployment config,
   * not grant state, and an operator disconnect cannot delete it.
   */
  override async clientInformation(): Promise<StoredOAuthClientInformation> {
    const { settings } = this;
    return {
      client_id: settings.clientId,
      ...(settings.clientSecret !== undefined
        ? { client_secret: settings.clientSecret }
        : {}),
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: settings.clientAuthentication,
      issuer: settings.identity,
    };
  }

  override async saveClientInformation(): Promise<void> {
    // Nothing to save: the SDK only saves a client it registered or stamped.
  }

  /**
   * Discovery as a constant. Supplying both halves keeps the SDK from
   * fetching either: no protected-resource probe of the API origin, and no
   * metadata request to an authorization server that may not publish any.
   * The metadata names no `issuer`, so the SDK binds grants to the configured
   * token endpoint and does not demand an RFC 9207 `iss` it cannot know.
   */
  override async discoveryState(): Promise<OAuthDiscoveryState> {
    const { settings } = this;
    const metadata = {
      authorization_endpoint: settings.authorizationEndpoint.href,
      token_endpoint: settings.tokenEndpoint.href,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [settings.clientAuthentication],
    } as unknown as AuthorizationServerMetadata;
    return {
      authorizationServerUrl: settings.identity,
      authorizationServerMetadata: metadata,
      resourceMetadata: { resource: settings.serverUrl.origin },
    };
  }

  override async saveDiscoveryState(): Promise<void> {
    // Configuration is the discovery; there is nothing to remember.
  }

  /** Configuration names the server a grant here belongs to. */
  protected override async recordedIssuer(): Promise<string> {
    return this.settings.identity;
  }

  /** No RFC 8707 `resource` parameter: a plain REST API names no resource. */
  async validateResourceURL(): Promise<URL | undefined> {
    return undefined;
  }

  /**
   * The code exchange without `code_verifier`, for a flow whose authorization
   * request carried no challenge. Undefined everywhere else, which hands the
   * SDK back its own request.
   */
  prepareTokenRequest(): URLSearchParams | undefined {
    if (this.settings.pkce || this.exchangeCode === undefined) return undefined;
    return new URLSearchParams({
      grant_type: "authorization_code",
      code: this.exchangeCode,
      redirect_uri: this.redirectUrl,
    });
  }

  /** @internal Remember the code a PKCE-less exchange sends. */
  exchanging(code: string): void {
    this.exchangeCode = code;
  }

  override async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    for (const [name, value] of this.settings.authorizationParams) {
      authorizationUrl.searchParams.set(name, value);
    }
    if (!this.settings.pkce) {
      authorizationUrl.searchParams.delete("code_challenge");
      authorizationUrl.searchParams.delete("code_challenge_method");
    }
    await super.redirectToAuthorization(authorizationUrl);
  }
}

const AUTH_REQUIRED_MESSAGE = "Authorization required — open the URL to connect.";

/** The grant behind one `api()` connector's `oauth`, as the hooks it exposes. */
export function staticOAuth(id: string, config: ApiOAuthConfig): ApiOAuthHooks {
  const settings = settingsFor(id, config);
  const issuerContext: OAuthClientInformationContext = { issuer: settings.identity };
  const coordinatorFor = refreshCoordinatorsByPartition();
  // Keyed by request scope, so nothing here outlives the request that set it.
  const callbackProviders = new WeakMap<object, StaticOAuthProvider>();
  const rejectedScopes = new WeakSet<object>();
  const scopeOf = (ctx: ConnectorContext): object => ctx.requestScope ?? ctx;

  const providerFor = (ctx: ConnectorContext) =>
    new StaticOAuthProvider(id, ctx, coordinatorFor(ctx), settings);

  /**
   * The global `fetch`, read per request, with the configured token-request
   * headers laid over the SDK's own. With discovery and registration answered
   * from configuration the token endpoint is the only URL the SDK fetches here;
   * the check keeps the headers on it even if that ever changes.
   */
  const tokenEndpointFetch = (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    if (
      settings.tokenRequestHeaders.length === 0 ||
      `${url.origin}${url.pathname}` !== settings.identity
    ) {
      return fetch(input, init);
    }
    const headers = new Headers(init.headers);
    for (const [name, value] of settings.tokenRequestHeaders) headers.set(name, value);
    return fetch(input, { ...init, headers });
  };

  /**
   * The SDK's `auth()` over this provider. The token endpoint is fetched
   * through the refresh coordinator — rotation, coalescing, and dead-versus-
   * outage verdicts — above a fetch that refuses every redirect, as the
   * `remoteMcp()` default does.
   */
  const runAuth = (
    provider: StaticOAuthProvider,
    ctx: ConnectorContext,
    exchange?: { authorizationCode: string; iss?: string },
  ) =>
    auth(provider, {
      serverUrl: settings.serverUrl,
      ...exchange,
      fetchFn: coordinatorFor(ctx).coordinatedFetch(
        provider,
        redirectSafeFetch(id, "none", tokenEndpointFetch),
        ctx.signal,
      ),
    });

  // No cause, as in remoteMcp(): the `UnauthorizedError` class is the whole
  // verdict, and a logger rendering the chain renders whatever it says.
  const authRequiredError = () =>
    new ConnectorCallError(
      "downstream_oauth_required",
      `Connector "${id}" requires authorization — call authorize_connector({ connector: "${id}" }) and open the returned URL.`,
    );
  const disconnectedMessage =
    `Connector "${id}" was disconnected by an operator — explicitly start authorization to reconnect it.`;

  /**
   * One request through the owner's grant. A 401 earns exactly one recovery:
   * a token another request has already rotated in, or else one coordinated
   * refresh. A second 401 is `auth_required`, latched for the request scope
   * so a program's later calls do not each spend a refresh on it.
   */
  const authorizedFetch = async (
    ctx: ConnectorContext,
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(input);
    if (!settings.apiOrigins.has(url.origin)) {
      throw new ConnectorCallError(
        "connector_call_failed",
        `Connector "${id}" sends its OAuth access token only to its declared ` +
          `apiOrigins, and ${url.origin} is not one of them.`,
        { retryable: false },
      );
    }
    if (init.body instanceof ReadableStream) {
      throw new TypeError(
        `Connector "${id}": ctx.oauth.fetch may replay a request once after a ` +
          "refresh, so it cannot send a stream body. Buffer the body first.",
      );
    }
    const headers = new Headers(init.headers);
    if (headers.has("authorization")) {
      throw new ConnectorCallError(
        "connector_call_failed",
        `Connector "${id}": a request through ctx.oauth.fetch may not set ` +
          "Authorization; the connector's grant owns it.",
        { retryable: false },
      );
    }
    const signal =
      init.signal && ctx.signal
        ? AbortSignal.any([init.signal, ctx.signal])
        : (init.signal ?? ctx.signal);
    const send = async (accessToken: string) => {
      const sent = new Headers(headers);
      sent.set("Authorization", `Bearer ${accessToken}`);
      // The token rides to a declared origin and no further: a redirect is
      // handed back to the handler unfollowed rather than re-sent anywhere.
      // The handler reads the answer with `.json()` or `.text()`, which read
      // bytes here: workerd quotes a text read's non-text Content-Type in
      // its own log, out of the handler's reach.
      const response = await fetch(url, {
        ...init,
        headers: sent,
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
      return byteReadResponse(response);
    };

    if (rejectedScopes.has(scopeOf(ctx))) throw authRequiredError();
    const release = retainOAuthPartition(oauthPartitionFor(ctx));
    try {
      if (signal?.aborted) throw signal.reason;
      const provider = providerFor(ctx);
      // Decide the grant before anything reads it, and bind this call's reads
      // and writes to the resulting epoch: a reset landing meanwhile fails
      // the call rather than handing it another flow's grant.
      const generation = await provider.beginFlow();
      if (provider.isOperatorDisconnectedGeneration(generation)) {
        throw new ConnectorCallError("downstream_oauth_required", disconnectedMessage);
      }
      const tokens = await provider.tokens(issuerContext);
      if (!tokens) throw authRequiredError();
      const first = await send(tokens.access_token);
      if (first.status !== 401) return first;
      void first.body?.cancel().catch(() => {});

      let accessToken: string;
      const current = await provider.tokens(issuerContext);
      if (current && current.access_token !== tokens.access_token) {
        accessToken = current.access_token;
      } else {
        if ((await runAuth(provider, ctx)) !== "AUTHORIZED") throw authRequiredError();
        const refreshed = await provider.tokens(issuerContext);
        if (!refreshed) throw authRequiredError();
        accessToken = refreshed.access_token;
      }
      const second = await send(accessToken);
      if (second.status !== 401) return second;
      void second.body?.cancel().catch(() => {});
      rejectedScopes.add(scopeOf(ctx));
      throw authRequiredError();
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        rejectedScopes.add(scopeOf(ctx));
        throw authRequiredError();
      }
      // The coordinator's answer while another request is still committing
      // a rotation it redeemed. The SDK rethrows it untouched; it is a
      // moment, not a verdict on the grant.
      if (error instanceof OAuthError && error.code === "temporarily_unavailable") {
        throw new ConnectorCallError(
          "unavailable",
          `Connector "${id}" could not refresh its OAuth grant while another ` +
            "request was saving one. The grant is kept; retry.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      release();
    }
  };

  const status = async (ctx: ConnectorContext): Promise<ConnectorStatus> => {
    if (rejectedScopes.has(scopeOf(ctx))) {
      return {
        state: "auth_required",
        message: "Authorization required — the downstream rejected this connector's OAuth grant.",
      };
    }
    // A status read never starts authorization: this provider cannot, and
    // nothing here calls the SDK. A stored grant is healthy until a call
    // says otherwise — the downstream is asked nothing.
    const provider = providerFor(ctx);
    if (await provider.operatorDisconnected()) {
      return { state: "auth_required", message: disconnectedMessage };
    }
    return (await provider.tokens())
      ? { state: "ok" }
      : { state: "auth_required", message: AUTH_REQUIRED_MESSAGE };
  };

  const startAuth = async (
    original: ConnectorContext,
    opts?: { force?: boolean },
  ): Promise<ConnectorStatus> => {
    const ctx = authorizingContext(original);
    const provider = providerFor(ctx);
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    const disconnected = opts?.force ? false : await provider.operatorDisconnected();
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (opts?.force || disconnected) {
      await provider.resetAuthorization();
      rejectedScopes.delete(scopeOf(original));
    } else {
      // Hand back a recent consent URL rather than overwrite the verifier
      // the operator may be mid-consent on.
      const pending = await provider.reusablePendingAuthorizationUrl();
      if (pending) {
        return {
          state: "auth_required",
          authorizationUrl: pending,
          authorizationReused: true,
          message: AUTH_REQUIRED_MESSAGE,
        };
      }
    }
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    try {
      // Born modern. The legacy generation exists so a `remoteMcp()` grant
      // from before epochs survives an upgrade; this connector has no such
      // past, and a flow started there writes an untimed pending URL that a
      // second Connect could not hand back.
      if ((await provider.generation()) === LEGACY_GENERATION) await provider.bumpGeneration();
      // A grant from a since-repointed token endpoint is retired here, before
      // it could be reported healthy.
      await provider.beginFlow();
      if (await provider.tokens(issuerContext)) {
        return { state: "ok", message: "Already authorized — connection is healthy." };
      }
      if ((await runAuth(provider, ctx)) === "AUTHORIZED") {
        return { state: "ok", message: "Already authorized — connection is healthy." };
      }
      const authorizationUrl = await provider.pendingAuthorizationUrl();
      return {
        state: "auth_required",
        ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
        message: AUTH_REQUIRED_MESSAGE,
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return { state: "auth_required", message: AUTH_REQUIRED_MESSAGE };
      }
      // Reaches the agent through authorize_connector. Text already in
      // connecta's words passes (token responses are rebuilt before the SDK
      // reads them); anything else is told from its record.
      return {
        state: "error",
        message:
          error instanceof ConnectorCallError || error instanceof OAuthError
            ? msg(error)
            : describeFailure(id, error),
      };
    }
  };

  const disconnectAuth = async (ctx: ConnectorContext): Promise<void> => {
    rejectedScopes.delete(scopeOf(ctx));
    await providerFor(ctx).resetAuthorization(true);
  };

  const verifyState = async (
    state: string | null,
    ctx: ConnectorContext,
  ): Promise<boolean> => {
    // The provider that verified the state captured its flow's epoch, and the
    // exchange must write under exactly that one.
    const provider = providerFor(ctx);
    callbackProviders.set(scopeOf(ctx), provider);
    return provider.verifyState(state);
  };

  const finishAuth = async (
    code: string,
    ctx: ConnectorContext,
    callbackParams?: URLSearchParams,
  ): Promise<void> => {
    const provider = callbackProviders.get(scopeOf(ctx)) ?? providerFor(ctx);
    callbackProviders.delete(scopeOf(ctx));
    const authorizationCode = callbackParams?.get("code") ?? code;
    const iss = callbackParams?.get("iss") ?? undefined;
    provider.exchanging(authorizationCode);
    await provider.bindFlow();
    const result = await runAuth(provider, ctx, {
      authorizationCode,
      ...(iss !== undefined ? { iss } : {}),
    });
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize");
    }
    await provider.clearPending();
    rejectedScopes.delete(scopeOf(ctx));
  };

  return {
    status: retainingOAuthPartition(status, 0),
    startAuth: retainingOAuthPartition(startAuth, 0),
    disconnectAuth: retainingOAuthPartition(disconnectAuth, 0),
    verifyState: retainingOAuthPartition(verifyState, 1),
    finishAuth: retainingOAuthPartition(finishAuth, 1),
    access: (ctx) => ({
      fetch: (input, init) => authorizedFetch(ctx, input, init),
    }),
  };
}
