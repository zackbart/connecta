import type {
  AuthorizationServerMetadata,
  OAuthClientInformationContext,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import { auth, OAuthError, UnauthorizedError, type AuthResult } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { byteReadResponse } from "../byte-read-response.js";
import type { ApiOAuthClientAuthentication, ApiOAuthConfig, ApiOAuthHooks } from "../connectors/api-connector.js";
import { deriveContext } from "../derived-context.js";
import { ConnectorCallError, msg, resendAdviceOf, withResendAdvice } from "../errors.js";
import { guardedTransport, sendCredentialPost } from "../guarded-transport.js";
import { oauthPartitionFor, retainOAuthPartition } from "../oauth-partition.js";
import { oauthSealerFor } from "../oauth-sealing.js";
import { describeFailure } from "../operator-record.js";
import {
  assertProviderCallOpen,
  bindProviderResponse,
  dispatchProviderRequest,
  providerRequest,
  readRequest,
  recordingFetch,
  recordProviderResponse,
  renewedAfterUnauthorized,
  takeProviderHandoff,
  vendorRefusal,
  type ProviderRequest,
} from "../provider-call.js";
import { viewSignal } from "../runtime/call.js";
import { runEdge } from "../runtime/run.js";
import { SharedRead } from "../runtime/shared-read.js";
import type { SentSecrets } from "../sent-secrets.js";
import { sentSecretsFetch, sentSecretsFor, shortSecretWarning } from "../sent-secrets.js";
import type { ConnectorContext, ConnectorStatus } from "../types.js";
import { unsentAfterUnauthorized } from "../write-outcome.js";
import { trackRemoteClientRequest } from "./downstream-client-metadata.js";
import type { OAuthRefreshCoordinator } from "./downstream-oauth.js";
import {
  assertOAuthScope,
  authorizingContext,
  codeExchangeResponse,
  KvOAuthProvider,
  refreshCoordinatorsByPartition,
} from "./downstream-oauth.js";
import { authorizationParamsFor } from "./oauth-authorization-params.js";
import { authView } from "./native-call.js";
import {
  authCall,
  authFlow,
  authInvoke,
  authMethod,
  authOwnMethod,
  authProgram,
  authValue,
  registerAuth,
  registerAuthMethod,
} from "./native.js";
import { trackOAuthStartReset } from "./oauth-start-reset.js";
import type { MigratedGrantBody } from "./oauth-v2-migration.js";
import { bindRenewableGrant, OAUTH_CHALLENGE_MAX_BYTES, type RenewableGrant } from "./renewable-grant.js";

/**
 * Token-request header values Connecta itself sends, by lowercase name: JSON
 * content negotiation and the media types maintained providers configure.
 * Registering one would redact a vendor's name wherever its fragments recur.
 * Any other configured value, under any name, may carry a credential and is
 * registered.
 */
export const PUBLIC_TOKEN_REQUEST_HEADERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["accept", new Set(["application/json", "application/vnd.ccbchurch.v2+json"])],
]);

/**
 * Downstream OAuth for a hand-written `api()` connector: the authorization
 * code grant against endpoints and a pre-registered client the deployment
 * declares, rather than ones a server advertises.
 *
 * Everything that makes the `remoteMcp()` grant safe is reused, not copied.
 * `StaticOAuthProvider` is a `KvOAuthProvider` — the same grant record and
 * consents, sealing, owner partitions, epoch fence, and refresh-failure
 * verdicts — whose discovery state and client are constants, and the SDK's
 * own `auth()` drives it through the same `OAuthRefreshCoordinator`. What a
 * static configuration subtracts is the network learning: no RFC 9728 or 8414
 * discovery and no dynamic registration, so no URL here was taught to
 * connecta by a downstream.
 */

/** Protocol response fields have their own validation, never static assertions. */
const RESERVED_CALLBACK_PARAMS: ReadonlySet<string> = new Set([
  "code",
  "state",
  "iss",
  "error",
  "error_description",
  "error_uri",
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

const CLIENT_AUTHENTICATION: ReadonlySet<string> = new Set(["client_secret_basic", "client_secret_post", "none"]);

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
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
  revocationEndpoint?: URL;
  revocationRequestFormat: "form" | "json";
  clientId: string;
  clientSecret?: string;
  clientAuthentication: ApiOAuthClientAuthentication;
  scope?: string;
  pkce: boolean;
  authorizationParams: ReadonlyArray<readonly [string, string]>;
  expectedCallbackParameters: ReadonlyArray<readonly [string, string]>;
  tokenRequestHeaders: ReadonlyArray<readonly [string, string]>;
  apiOrigins: ReadonlySet<string>;
  /** Where the SDK's `serverUrl` points: the first API origin. */
  serverUrl: URL;
  /**
   * The authorization server identity tokens are bound to. A static
   * configuration has no advertised issuer, so the token endpoint stands in:
   * repointing it is repointing the grant, and the issuer-bound read then
   * leaves the old tokens unsent until a consent replaces them.
   */
  identity: string;
}

/** Structural mistakes throw here, where they are written. */
function settingsFor(id: string, config: ApiOAuthConfig): StaticOAuthSettings {
  if (!config || typeof config !== "object") {
    throw new Error(`[connecta] connector "${id}" oauth must be an object.`);
  }
  const invalid = (detail: string): never => {
    throw new Error(`[connecta] connector "${id}" oauth.${detail}`);
  };
  const authorizationEndpoint = configuredUrl(id, "authorizationEndpoint", config.authorizationEndpoint);
  const tokenEndpoint = configuredUrl(id, "tokenEndpoint", config.tokenEndpoint);
  const revocationEndpoint =
    config.revocationEndpoint === undefined
      ? undefined
      : configuredUrl(id, "revocationEndpoint", config.revocationEndpoint);
  if (revocationEndpoint?.search) invalid(`revocationEndpoint must not carry a query.`);
  const revocationRequestFormat = config.revocationRequestFormat ?? "form";
  if (
    (revocationRequestFormat !== "form" && revocationRequestFormat !== "json") ||
    (config.revocationRequestFormat !== undefined && !revocationEndpoint)
  )
    invalid(`revocationRequestFormat requires an endpoint and form or json.`);
  if (tokenEndpoint.search) {
    invalid(`tokenEndpoint must not carry a query.`);
  }
  if (typeof config.clientId !== "string" || config.clientId.trim() === "") {
    invalid(`clientId must be a non-empty string.`);
  }
  if (config.clientSecret !== undefined && (typeof config.clientSecret !== "string" || config.clientSecret === "")) {
    // Usually an unset environment variable read as "". Never echo it.
    invalid(`clientSecret must be a non-empty string when set.`);
  }
  const clientAuthentication =
    config.tokenEndpointAuthMethod ?? (config.clientSecret !== undefined ? "client_secret_basic" : "none");
  if (!CLIENT_AUTHENTICATION.has(clientAuthentication)) {
    invalid(`tokenEndpointAuthMethod must be ` + '"client_secret_basic", "client_secret_post", or "none".');
  }
  if (clientAuthentication === "none" && config.clientSecret !== undefined) {
    throw new Error(
      `[connecta] connector "${id}" oauth declares a clientSecret with ` +
        'tokenEndpointAuthMethod "none"; a public client sends no secret.',
    );
  }
  if (clientAuthentication !== "none" && config.clientSecret === undefined) {
    invalid(`tokenEndpointAuthMethod ` + `"${clientAuthentication}" needs a clientSecret.`);
  }
  assertOAuthScope(id, config.scope);
  const authorizationParams = authorizationParamsFor(
    config.authorizationParams,
    `api(${JSON.stringify(id)}).oauth.authorizationParams`,
  );
  const expectedCallbackParameters: Array<readonly [string, string]> = [];
  if (
    config.expectedCallbackParameters !== undefined &&
    (!config.expectedCallbackParameters ||
      typeof config.expectedCallbackParameters !== "object" ||
      Array.isArray(config.expectedCallbackParameters))
  ) {
    invalid(`expectedCallbackParameters must be a string record.`);
  }
  for (const [name, value] of Object.entries(config.expectedCallbackParameters ?? {})) {
    if (
      !/^[A-Za-z0-9_.-]+$/.test(name) ||
      RESERVED_CALLBACK_PARAMS.has(name) ||
      typeof value !== "string" ||
      value === ""
    ) {
      invalid(
        `expectedCallbackParameters must use nonempty parameter names ` +
          "(ASCII letters, digits, dots, underscores or hyphens), nonempty string values, and no OAuth response fields.",
      );
    }
    expectedCallbackParameters.push([name, value]);
  }
  const tokenRequestHeaders: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(config.tokenRequestHeaders ?? {})) {
    if (!HEADER_NAME.test(name)) {
      invalid(`tokenRequestHeaders has an invalid header name.`);
    }
    if (RESERVED_TOKEN_HEADERS.has(name.toLowerCase())) {
      invalid(`tokenRequestHeaders may not set ` + `"${name}"; the token request owns it.`);
    }
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n") || value.includes("\0")) {
      invalid(`tokenRequestHeaders.${name} must be a single-line string.`);
    }
    tokenRequestHeaders.push([name, value]);
  }
  const origins = Array.isArray(config.apiOrigins) ? config.apiOrigins : [];
  if (origins.length === 0) {
    invalid(`apiOrigins must name at least one ` + "origin; ctx.oauth.fetch sends the access token nowhere else.");
  }
  const apiOrigins = new Set<string>();
  for (const origin of origins) {
    const url = configuredUrl(id, "apiOrigins", origin);
    if (url.origin !== origin) {
      invalid(
        `apiOrigins entries must be exact ` +
          'origins, like "https://api.example.com", with no path or trailing slash.',
      );
    }
    apiOrigins.add(url.origin);
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    revocationRequestFormat,
    clientId: config.clientId,
    ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    clientAuthentication,
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    pkce: config.pkce ?? true,
    authorizationParams,
    expectedCallbackParameters,
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
    requestOwned = false,
  ) {
    super(
      connectorId,
      ctx.storage,
      `${ctx.baseUrl}/oauth/callback/${connectorId}`,
      coordinator,
      ctx.allowAuthorization === true,
      oauthSealerFor(ctx),
      viewSignal(ctx, requestOwned),
      // No client binding: the client is configuration, so there is no
      // registration for a restart to carry forward or discard.
      undefined,
      (reset) => trackOAuthStartReset(ctx.requestScope ?? ctx, reset),
      undefined,
      settings.scope,
      undefined,
      { secrets: sentSecretsFor(ctx), authorizationParams: settings.authorizationParams },
    );
  }

  /**
   * The pre-registered client, answered from configuration. Its secret is
   * never written to storage, sealed or otherwise: it is deployment config,
   * not grant state, and an operator disconnect cannot delete it.
   */
  override clientInformation(): Promise<StoredOAuthClientInformation> {
    return runEdge(
      authOwnMethod<StoredOAuthClientInformation>(StaticOAuthProvider.prototype, this, "clientInformation", []),
    );
  }

  protected override configuredAuthorizationBinding() {
    return {
      issuer: this.settings.identity,
      clientId: this.settings.clientId,
      tokenEndpoint: this.settings.tokenEndpoint.href,
    };
  }

  private configuredClientInformation(): StoredOAuthClientInformation {
    const { settings } = this;
    return {
      client_id: settings.clientId,
      ...(settings.clientSecret !== undefined ? { client_secret: settings.clientSecret } : {}),
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: settings.clientAuthentication,
      issuer: settings.identity,
    };
  }

  protected override revocationSnapshot(body: MigratedGrantBody) {
    const { settings } = this;
    return {
      body: {
        ...body,
        client: { value: this.configuredClientInformation() },
        discovery: {
          authorizationServerUrl: settings.identity,
          authorizationServerMetadata: { revocation_endpoint: settings.revocationEndpoint!.href },
        } as OAuthDiscoveryState,
      },
    };
  }

  override saveClientInformation(): Promise<void> {
    return runEdge(authOwnMethod<void>(StaticOAuthProvider.prototype, this, "saveClientInformation", []));
  }

  /**
   * Discovery as a constant. Supplying both halves keeps the SDK from
   * fetching either: no protected-resource probe of the API origin, and no
   * metadata request to an authorization server that may not publish any.
   * The metadata names no `issuer`, so the SDK binds grants to the configured
   * token endpoint and does not demand an RFC 9207 `iss` it cannot know.
   */
  override discoveryState(): Promise<OAuthDiscoveryState> {
    return runEdge(authOwnMethod<OAuthDiscoveryState>(StaticOAuthProvider.prototype, this, "discoveryState", []));
  }

  override saveDiscoveryState(): Promise<void> {
    return runEdge(authOwnMethod<void>(StaticOAuthProvider.prototype, this, "saveDiscoveryState", []));
  }

  /** No RFC 8707 `resource` parameter: a plain REST API names no resource. */
  validateResourceURL(): Promise<URL | undefined> {
    return runEdge(authOwnMethod<URL | undefined>(StaticOAuthProvider.prototype, this, "validateResourceURL", []));
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

  override redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    return runEdge(
      authOwnMethod<void>(StaticOAuthProvider.prototype, this, "redirectToAuthorization", [authorizationUrl]),
    );
  }

  static {
    registerAuthMethod(
      StaticOAuthProvider.prototype,
      "clientInformation",
      function (this: StaticOAuthProvider) {
        return authValue(() => this.configuredClientInformation());
      },
      StaticOAuthProvider.prototype.clientInformation,
    );
    registerAuthMethod(
      StaticOAuthProvider.prototype,
      "saveClientInformation",
      function (this: StaticOAuthProvider) {
        // Nothing to save: the SDK only saves a client it registered or stamped.
        return Effect.void;
      },
      StaticOAuthProvider.prototype.saveClientInformation,
    );
    registerAuthMethod(
      StaticOAuthProvider.prototype,
      "discoveryState",
      function (this: StaticOAuthProvider) {
        return authValue<OAuthDiscoveryState>(() => {
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
        });
      },
      StaticOAuthProvider.prototype.discoveryState,
    );
    registerAuthMethod(
      StaticOAuthProvider.prototype,
      "saveDiscoveryState",
      function (this: StaticOAuthProvider) {
        // Configuration is the discovery; there is nothing to remember.
        return Effect.void;
      },
      StaticOAuthProvider.prototype.saveDiscoveryState,
    );
    registerAuthMethod(
      StaticOAuthProvider.prototype,
      "validateResourceURL",
      function (this: StaticOAuthProvider) {
        return authValue<URL | undefined>(() => {
          return undefined;
        });
      },
      StaticOAuthProvider.prototype.validateResourceURL,
    );
    registerAuthMethod(
      StaticOAuthProvider.prototype,
      "redirectToAuthorization",
      function (this: StaticOAuthProvider, authorizationUrl: URL) {
        return authFlow<void>(
          function* (this: StaticOAuthProvider) {
            if (!this.settings.pkce) {
              authorizationUrl.searchParams.delete("code_challenge");
              authorizationUrl.searchParams.delete("code_challenge_method");
            }
            (yield authCall(KvOAuthProvider.prototype.redirectToAuthorization, [authorizationUrl], this)) as void;
          }.bind(this),
        );
      },
      StaticOAuthProvider.prototype.redirectToAuthorization,
    );
  }
}

const AUTH_REQUIRED_MESSAGE = "Authorization required — open the URL to connect.";

/** Release the resource body before renewal, bounding even the facade's discarded challenge. */
function readChallenge(response: Response, signal: AbortSignal, method: string | undefined): Promise<void> {
  return runEdge(authProgram<void>(readChallengeNative, [response, signal, method]));
}
const readChallengeNative = /* @__PURE__ */ registerAuth(
  readChallenge,
  function (response: Response, signal: AbortSignal, method: string | undefined) {
    return authFlow<void>(function* () {
      if (method?.toUpperCase() === "HEAD") {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const oversized = () =>
        new ConnectorCallError("connector_call_failed", "The OAuth challenge exceeded its response ceiling.", {
          retryable: false,
        });
      if (Number(response.headers.get("content-length")) > OAUTH_CHALLENGE_MAX_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw oversized();
      }
      if (!response.body) return;
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      let total = 0;
      try {
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = (yield authInvoke(reader, "read", [])) as ReadableStreamReadResult<any>;
          } catch {
            // Like the guarded client, a broken challenge body cannot replace its 401.
            break;
          }
          if (signal.aborted) throw signal.reason;
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > OAUTH_CHALLENGE_MAX_BYTES) {
            cancel();
            throw oversized();
          }
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    });
  },
);

/** The grant behind one `api()` connector's `oauth`, as the hooks it exposes. */
export function staticOAuth(id: string, config: ApiOAuthConfig): ApiOAuthHooks {
  const settings = settingsFor(id, config);
  const callbackParametersMatch = (params?: URLSearchParams): boolean =>
    settings.expectedCallbackParameters.every(([name, expected]) => {
      const values = params?.getAll(name);
      return values?.length === 1 && values[0] === expected;
    });
  const issuerContext: OAuthClientInformationContext = { issuer: settings.identity };
  const coordinatorFor = refreshCoordinatorsByPartition();
  // Keyed by request scope, so nothing here outlives the request that set it.
  const callbackProviders = new WeakMap<object, StaticOAuthProvider>();
  const rejectedScopes = new WeakSet<object>();
  const scopeOf = (ctx: ConnectorContext): object => ctx.requestScope ?? ctx;

  const warnShortSecret = shortSecretWarning();
  const providerFor = (ctx: ConnectorContext, requestOwned = false) => {
    warnShortSecret(settings.clientSecret, ctx.logger);
    return new StaticOAuthProvider(id, ctx, coordinatorFor(ctx), settings, requestOwned);
  };

  /**
   * The owned credential transport, with the configured token-request
   * headers laid over the SDK's own. With discovery and registration answered
   * from configuration the token endpoint is the only URL the SDK fetches here;
   * the check keeps the headers on it even if that ever changes.
   */
  const tokenEndpointFetch = authMethod((secrets: SentSecrets, input: string | URL, init: RequestInit = {}) => {
    return authFlow<Response>(function* () {
      const url = new URL(input);
      const request: RequestInit = { ...init, redirect: "manual" };
      if (settings.tokenRequestHeaders.length && `${url.origin}${url.pathname}` === settings.identity) {
        const headers = new Headers(init.headers);
        for (const [name, value] of settings.tokenRequestHeaders) headers.set(name, value);
        for (const [name, value] of settings.tokenRequestHeaders)
          if (!PUBLIC_TOKEN_REQUEST_HEADERS.get(name.toLowerCase())?.has(value)) secrets.header(value);
        request.headers = headers;
      }
      trackRemoteClientRequest(secrets, input, request);
      // The coordinator or code-exchange wrapper authorizes this send. Refresh
      // claim submission may outlive the caller; this transport uses no
      // request-owned capability and changes no closed resource-call ledger.
      const dispatch: ProviderRequest = {
        dispatched: false,
        auxiliary: true,
        provider: id,
        method: request.method ?? "GET",
      };
      secrets.request(input, request);
      const response = (yield authCall(sendCredentialPost, [
        input,
        request,
        () => dispatchProviderRequest(undefined, dispatch, request.headers),
      ])) as Response;
      recordProviderResponse(dispatch, response.status);
      return byteReadResponse(response);
    });
  });

  /**
   * The SDK's `auth()` over this provider. The token endpoint is fetched
   * through the refresh coordinator, with permanent spent fingerprints,
   * rotation commits, and re-consent verdicts. Credential-bearing requests
   * never follow redirects in either OAuth adapter.
   */
  const runAuth = authMethod(
    (
      provider: StaticOAuthProvider,
      ctx: ConnectorContext,
      exchange?: {
        authorizationCode: string;
        iss?: string;
      },
      requestOwned: boolean = false,
    ) => {
      return authFlow<AuthResult>(function* () {
        const secrets = sentSecretsFor(ctx);
        return (yield authCall(auth, [
          provider,
          {
            serverUrl: settings.serverUrl,
            ...exchange,
            fetchFn: coordinatorFor(ctx).coordinatedFetch(
              provider,
              authMethod((input: string | URL, init: RequestInit | undefined) => {
                return authFlow<Response>(function* () {
                  if (exchange) {
                    // A code exchange has no submitted refresh claim transferring
                    // ownership. Only explicit scope revocation stops a callback:
                    // the production callback route remains uninterruptible and
                    // does not revoke its own scope while exchanging a code.
                    return (yield authView(
                      ctx,
                      authMethod((signal: AbortSignal) => {
                        return authFlow<Response>(function* () {
                          assertProviderCallOpen(ctx, id, true);
                          const response = (yield authCall(tokenEndpointFetch, [
                            secrets,
                            input,
                            {
                              ...init,
                              signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
                            },
                          ])) as Response;
                          // An override can ignore abort. Never hand its late tokens
                          // to the SDK, which would otherwise persist both credentials.
                          if (signal.aborted) {
                            void response.body?.cancel().catch(() => {});
                            throw signal.reason;
                          }
                          // The SDK clones and reads this body after fetch resolves.
                          // Revocation must cancel that read even for a custom fetch.
                          return codeExchangeResponse(response, signal);
                        });
                      }),
                      true,
                    )) as Response;
                  }
                  return (yield authCall(tokenEndpointFetch, [secrets, input, init])) as Response;
                });
              }),
              viewSignal(ctx, requestOwned || exchange !== undefined),
              ctx.defer,
              undefined,
              () => {
                guardedTransport(true);
              },
            ),
          },
        ])) as AuthResult;
      });
    },
  );

  // No cause, as in remoteMcp(): the `UnauthorizedError` class is the whole
  // verdict, and a logger rendering the chain renders whatever it says.
  const authRequiredError = () =>
    new ConnectorCallError(
      "downstream_oauth_required",
      `Connector "${id}" requires authorization — call authorize_connector({ connector: "${id}" }) and open the returned URL.`,
    );
  const disconnectedMessage = `Connector "${id}" was disconnected by an operator — explicitly start authorization to reconnect it.`;

  /**
   * The token to send after `spent` drew a 401: one another request has
   * already rotated in, or else one coordinated refresh.
   */
  const renewedToken = authMethod(
    (provider: StaticOAuthProvider, ctx: ConnectorContext, spent: string, requestOwned: boolean = false) => {
      return authFlow<string>(function* () {
        // Only renewal whose claim CAS was submitted may survive this call.
        // Race each preparation read too, and never resume SDK work or consume a
        // rotated token after closure, even if a storage promise completes late.
        const live = authMethod(<A>(work: () => Promise<A>) => {
          return authFlow<A>(function* () {
            if (ctx.signal?.aborted) throw ctx.signal.reason;
            const value = (yield authView(ctx, work, requestOwned)) as Awaited<A>;
            if (ctx.signal?.aborted) throw ctx.signal.reason;
            return value;
          });
        });
        const current = (yield authCall(live, [
          authMethod(() => {
            return authInvoke(provider, "tokens", [issuerContext]) as Effect.Effect<
              | {
                  access_token: string;
                  token_type: string;
                  id_token?: string | undefined;
                  expires_in?: number | undefined;
                  scope?: string | undefined;
                  refresh_token?: string | undefined;
                  issuer?: string | undefined;
                }
              | undefined,
              unknown
            >;
          }),
        ])) as
          | {
              access_token: string;
              token_type: string;
              id_token?: string | undefined;
              expires_in?: number | undefined;
              scope?: string | undefined;
              refresh_token?: string | undefined;
              issuer?: string | undefined;
            }
          | undefined;
        if (current && current.access_token !== spent) return current.access_token;
        if (
          ((yield authCall(live, [
            authMethod(() => {
              return authCall(runAuth, [provider, ctx, undefined, requestOwned]) as Effect.Effect<AuthResult, unknown>;
            }),
          ])) as AuthResult) !== "AUTHORIZED"
        )
          throw authRequiredError();
        const refreshed = (yield authCall(live, [
          authMethod(() => {
            return authInvoke(provider, "tokens", [issuerContext]) as Effect.Effect<
              | {
                  access_token: string;
                  token_type: string;
                  id_token?: string | undefined;
                  expires_in?: number | undefined;
                  scope?: string | undefined;
                  refresh_token?: string | undefined;
                  issuer?: string | undefined;
                }
              | undefined,
              unknown
            >;
          }),
        ])) as
          | {
              access_token: string;
              token_type: string;
              id_token?: string | undefined;
              expires_in?: number | undefined;
              scope?: string | undefined;
              refresh_token?: string | undefined;
              issuer?: string | undefined;
            }
          | undefined;
        if (!refreshed) throw authRequiredError();
        return refreshed.access_token;
      });
    },
  );

  /** One call's grant use; submitted refresh work keeps the coordinator's owner. */
  const grantFor = (ctx: ConnectorContext, requestOwned = false): RenewableGrant => {
    let provider: SharedRead<StaticOAuthProvider> | undefined;
    const use = authMethod(<A>(work: (provider: StaticOAuthProvider, live: ConnectorContext) => Promise<A>) => {
      return authView(
        ctx,
        authMethod((signal: AbortSignal) => {
          return authFlow<A>(function* () {
            assertProviderCallOpen(ctx, id, requestOwned);
            if (rejectedScopes.has(scopeOf(ctx))) throw authRequiredError();
            const live = deriveContext(ctx, { signal });
            const release = retainOAuthPartition(oauthPartitionFor(live));
            try {
              provider ??= new SharedRead(
                () =>
                  authView(
                    live,
                    authMethod(() => {
                      return authFlow<StaticOAuthProvider>(function* () {
                        const value = providerFor(live, requestOwned);
                        const epoch = (yield authInvoke(value, "beginFlow", [])) as string;
                        if (value.isOperatorDisconnectedEpoch(epoch)) {
                          throw new ConnectorCallError("downstream_oauth_required", disconnectedMessage);
                        }
                        return value;
                      });
                    }),
                    requestOwned,
                  ),
                undefined,
                ctx.requestScope ?? ctx,
              );
              return (yield authCall(work, [(yield provider.join(signal)) as StaticOAuthProvider, live])) as Awaited<A>;
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              if (error instanceof UnauthorizedError) {
                rejectedScopes.add(scopeOf(ctx));
                throw authRequiredError();
              }
              throw error;
            } finally {
              release();
            }
          });
        }),
        requestOwned,
      ) as Effect.Effect<A, unknown>;
    });
    return {
      token: authMethod(() => {
        return authCall(use, [
          authMethod((provider: StaticOAuthProvider) => {
            return authFlow<string>(function* () {
              const tokens = (yield authInvoke(provider, "tokens", [issuerContext])) as
                | {
                    access_token: string;
                    token_type: string;
                    id_token?: string | undefined;
                    expires_in?: number | undefined;
                    scope?: string | undefined;
                    refresh_token?: string | undefined;
                    issuer?: string | undefined;
                  }
                | undefined;
              if (!tokens) throw authRequiredError();
              return tokens.access_token;
            });
          }),
        ]) as Effect.Effect<string, unknown>;
      }),
      refresh: authMethod((stale: string) => {
        return authCall(use, [
          authMethod((provider: StaticOAuthProvider, live: ConnectorContext) => {
            return authCall(renewedToken, [provider, live, stale, requestOwned]) as Effect.Effect<string, unknown>;
          }),
        ]) as Effect.Effect<string, unknown>;
      }),
      rejected: authMethod(() => {
        return authView(
          ctx,
          authMethod(() => {
            return authValue<never>(() => {
              rejectedScopes.add(scopeOf(ctx));
              throw authRequiredError();
            });
          }),
          requestOwned,
        ) as Effect.Effect<never, unknown>;
      }),
    };
  };

  /**
   * One request through the owner's grant. A 401 earns exactly one recovery
   * ({@link renewedToken}). A read is then sent once more; a write never is
   * (INV-9), since a server may act on a request before it rejects the
   * token. Whatever recovery meets is never reported as retryable: an
   * authorization verdict keeps its code, and anything else (a disconnect or
   * reset racing the refresh) leaves the outcome unknown. A second 401 is
   * `auth_required`, latched for the request scope so a program's later
   * calls do not each spend a refresh on it.
   */
  const authorizedFetch = authMethod((ctx: ConnectorContext, input: string | URL, init: RequestInit = {}) => {
    return authFlow<Response>(function* () {
      let prepared = takeProviderHandoff(init);
      const auxiliary = prepared?.auxiliary === true;
      // Own the complete token preparation and fetch helper. The coordinator
      // still owns a submitted refresh claim independently of this wait.
      return (yield authView(
        ctx,
        authMethod((owned: AbortSignal) => {
          return authFlow<Response>(function* () {
            // A call that already ended reads no token and sends nothing more.
            assertProviderCallOpen(ctx, id, auxiliary);
            const owner = prepared;
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
            const signal = init.signal ? AbortSignal.any([init.signal, owned]) : owned;
            ctx = deriveContext(ctx, { signal });
            const detachAnswers: Array<() => void> = [];
            const send = authMethod((accessToken: string) => {
              return authFlow<{
                response: Response;
                dispatch: ProviderRequest;
              }>(function* () {
                if (signal?.aborted) throw signal.reason;
                sentSecretsFor(ctx).add(accessToken);
                const sent = new Headers(headers);
                sent.set("Authorization", `Bearer ${accessToken}`);
                // The token rides to a declared origin and no further: a redirect is
                // handed back to the handler unfollowed rather than re-sent anywhere.
                // The handler reads the answer with `.json()` or `.text()`, which read
                // bytes here: workerd quotes a text read's non-text Content-Type in
                // its own log, out of the handler's reach.
                const request: RequestInit = {
                  ...init,
                  headers: sent,
                  redirect: "manual",
                  ...(signal ? { signal } : {}),
                };
                const dispatch = prepared ?? providerRequest(ctx, auxiliary, id);
                prepared = undefined;
                dispatchProviderRequest(ctx, dispatch, sent, request.method ?? "GET");
                // A native waiter can close before fetch settles. This leaf
                // observer records only immutable response facts, and cancels
                // a late body; it never resumes request-owned preparation.
                const pending = sentSecretsFetch(ctx)(url, request).then((response) => {
                  recordProviderResponse(dispatch, response.status);
                  if (response.status === 401) {
                    // Closure can settle the handler before renewal's catch maps
                    // this answer. Preserve its OAuth verdict in the ledger first;
                    // only the final write decider reports it. A live renewal keeps
                    // its own precise verdict and never replays a write.
                    const abandoned = () => {
                      vendorRefusal(
                        unsentAfterUnauthorized(`Connector "${id}"'s API`, signal.reason, "downstream_oauth_required"),
                        dispatch,
                      );
                    };
                    if (signal.aborted) abandoned();
                    else {
                      signal.addEventListener("abort", abandoned, { once: true });
                      detachAnswers.push(() => signal.removeEventListener("abort", abandoned));
                    }
                  }
                  // A custom fetch may answer after revocation. Its physical status
                  // remains a fact, but its body belongs to no live helper or handler.
                  if (signal.aborted) void response.body?.cancel().catch(() => {});
                  return response;
                });
                const response = (yield authValue(() => pending)) as Response;
                if (signal.aborted) throw signal.reason;
                const answer = byteReadResponse(response);
                bindProviderResponse(answer, dispatch, owner);
                return { response: answer, dispatch };
              });
            });
            const release = retainOAuthPartition(oauthPartitionFor(ctx));
            try {
              if (signal?.aborted) throw signal.reason;
              const grant = grantFor(ctx, auxiliary);
              const stale = (yield authInvoke(grant, "token", [])) as string;
              const { response: first, dispatch } = (yield authCall(send, [stale])) as {
                response: Response;
                dispatch: ProviderRequest;
              };
              if (first.status !== 401) return first;
              try {
                (yield authCall(readChallenge, [first, signal, init.method])) as void;
              } catch (error) {
                if (signal.aborted) throw signal.reason;
                if (!readRequest(dispatch)) {
                  throw vendorRefusal(
                    unsentAfterUnauthorized(`Connector "${id}"'s API`, error, "downstream_oauth_required"),
                    dispatch,
                  );
                }
                throw error;
              }
              if (!readRequest(dispatch)) {
                let renewal: unknown;
                try {
                  const fresh = (yield authInvoke(grant, "refresh", [stale])) as string;
                  if (signal?.aborted) throw signal.reason;
                  // The call's ledger keeps this 401's verdict, or that renewal
                  // replaced the token this request sent (Q8). The same token back
                  // renewed nothing.
                  renewedAfterUnauthorized(dispatch, stale, fresh);
                  if (fresh === stale) renewal = authRequiredError();
                } catch (error) {
                  if (error instanceof UnauthorizedError) rejectedScopes.add(scopeOf(ctx));
                  renewal = error instanceof UnauthorizedError ? authRequiredError() : error;
                }
                throw vendorRefusal(
                  unsentAfterUnauthorized(`Connector "${id}"'s API`, renewal, "downstream_oauth_required"),
                  dispatch,
                );
              }
              const accessToken = (yield authInvoke(grant, "refresh", [stale])) as string;
              if (signal?.aborted) throw signal.reason;
              renewedAfterUnauthorized(dispatch, stale, accessToken);
              const { response: second } = (yield authCall(send, [accessToken])) as {
                response: Response;
                dispatch: ProviderRequest;
              };
              if (second.status !== 401) return second;
              void second.body?.cancel().catch(() => {});
              return (yield authInvoke(grant, "rejected", [])) as never;
            } catch (error) {
              // The SDK can replace cancellation with its passive-consent refusal,
              // and write recovery normally replaces errors with a 401 verdict. A
              // closed capability must still fail promptly with its own close reason;
              // the invocation's ledger retains the write's uncertainty and handoff.
              if (signal?.aborted) throw signal.reason;
              if (error instanceof UnauthorizedError) {
                rejectedScopes.add(scopeOf(ctx));
                throw authRequiredError();
              }
              throw error;
            } finally {
              for (const detach of detachAnswers) detach();
              release();
            }
          });
        }),
        auxiliary,
      )) as Response;
    });
  });

  const status = authMethod((ctx: ConnectorContext) => {
    return authFlow<ConnectorStatus>(function* () {
      if (rejectedScopes.has(scopeOf(ctx))) {
        return {
          state: "auth_required",
          message: "Authorization required \u2014 the downstream rejected this connector's OAuth grant.",
        };
      }
      // A status read never starts authorization: this provider cannot, and
      // nothing here calls the SDK. A stored grant for the configured token
      // endpoint is healthy until a call says otherwise — the downstream is
      // asked nothing.
      const provider = providerFor(ctx);
      if ((yield authInvoke(provider, "operatorDisconnected", [])) as boolean) {
        return { state: "auth_required", message: disconnectedMessage };
      }
      return ((yield authInvoke(provider, "tokens", [issuerContext])) as
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
        ? { state: "ok" }
        : { state: "auth_required", message: AUTH_REQUIRED_MESSAGE };
    });
  });

  const startAuth = authMethod(
    (
      original: ConnectorContext,
      opts?: {
        force?: boolean;
      },
    ) => {
      return authFlow<ConnectorStatus>(function* () {
        const ctx = authorizingContext(original);
        const provider = providerFor(ctx);
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        const disconnected = opts?.force
          ? false
          : ((yield authInvoke(provider, "operatorDisconnected", [])) as boolean);
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        if (opts?.force || disconnected) {
          (yield authInvoke(provider, "resetAuthorization", [])) as void;
          rejectedScopes.delete(scopeOf(original));
        } else {
          // Hand back a recent consent URL rather than overwrite the verifier
          // the operator may be mid-consent on.
          const pending = (yield authInvoke(provider, "reusablePendingAuthorizationUrl", [])) as string | undefined;
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
          // A grant from a since-repointed token endpoint reads as absent here,
          // and the consent this start begins replaces it.
          (yield authInvoke(provider, "beginFlow", [])) as string;
          if (
            (yield authInvoke(provider, "tokens", [issuerContext])) as
              | {
                  access_token: string;
                  token_type: string;
                  id_token?: string | undefined;
                  expires_in?: number | undefined;
                  scope?: string | undefined;
                  refresh_token?: string | undefined;
                  issuer?: string | undefined;
                }
              | undefined
          ) {
            return { state: "ok", message: "Already authorized \u2014 connection is healthy." };
          }
          if (((yield authCall(runAuth, [provider, ctx])) as AuthResult) === "AUTHORIZED") {
            return { state: "ok", message: "Already authorized \u2014 connection is healthy." };
          }
          const authorizationUrl = (yield authInvoke(provider, "consentUrl", [])) as string | undefined;
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
          // connecta's words passes with its advice to try again, since this is
          // no write's failure (token responses are rebuilt before the SDK reads
          // them); anything else is told from its record.
          return {
            state: "error",
            message:
              error instanceof ConnectorCallError || error instanceof OAuthError
                ? withResendAdvice(msg(error), resendAdviceOf(error))
                : describeFailure(id, error),
          };
        }
      });
    },
  );

  const disconnectAuth = authMethod((ctx: ConnectorContext) => {
    return authFlow<void>(function* () {
      rejectedScopes.delete(scopeOf(ctx));
      if (!settings.revocationEndpoint) {
        (yield authInvoke(providerFor(ctx), "resetAuthorization", [true])) as void;
        return;
      }
      (yield authInvoke(providerFor(ctx), "disconnectAuthorization", [
        authMethod((input: string | URL, init: RequestInit = {}) => {
          // Register the standard form's credentials before any JSON framing.
          trackRemoteClientRequest(sentSecretsFor(ctx), input, init);
          if (settings.revocationRequestFormat === "json" && init.body instanceof URLSearchParams) {
            const params = new URLSearchParams(init.body);
            params.delete("token_type_hint");
            const headers = new Headers(init.headers);
            headers.set("Content-Type", "application/json");
            headers.set("Accept", "application/json");
            init = { ...init, headers, body: JSON.stringify(Object.fromEntries(params)) };
          }
          return authCall(tokenEndpointFetch, [sentSecretsFor(ctx), input, init]);
        }),
      ])) as void;
    });
  });

  const verifyState = authMethod((state: string | null, ctx: ConnectorContext) => {
    return authFlow<boolean>(function* () {
      // The provider that verified the state captured its flow's epoch, and the
      // exchange must write under exactly that one.
      const provider = providerFor(ctx);
      callbackProviders.set(scopeOf(ctx), provider);
      return (yield authInvoke(provider, "verifyState", [state])) as boolean;
    });
  });

  const finishAuth = authMethod((code: string, ctx: ConnectorContext, callbackParams?: URLSearchParams) => {
    return authView(
      ctx,
      authMethod(() => {
        return authFlow<void>(function* () {
          const provider = callbackProviders.get(scopeOf(ctx)) ?? providerFor(ctx);
          callbackProviders.delete(scopeOf(ctx));
          const authorizationCode = callbackParams?.get("code") ?? code;
          const iss = callbackParams?.get("iss") ?? undefined;
          // Every exchange names and claims its own consent, including without PKCE.
          const consent = callbackParams?.get("state") ?? null;
          if (!consent || !((yield authInvoke(provider, "verifyCallbackState", [consent])) as boolean)) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `Connector "${id}" authorization callback matches no pending consent; nothing was exchanged.`,
            );
          }
          if (!callbackParametersMatch(callbackParams)) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `Connector "${id}" authorization callback did not match its configured parameters; nothing was exchanged.`,
            );
          }
          provider.validateCallbackIssuer(callbackParams?.get("iss") ?? null);
          provider.exchanging(authorizationCode);
          (yield authInvoke(provider, "bindFlow", [])) as void;
          const result = (yield authCall(runAuth, [
            provider,
            ctx,
            {
              authorizationCode,
              ...(iss !== undefined ? { iss } : {}),
            },
          ])) as AuthResult;
          if (result !== "AUTHORIZED") {
            throw new UnauthorizedError("Failed to authorize");
          }
          rejectedScopes.delete(scopeOf(ctx));
        });
      }),
      true,
    ) as Effect.Effect<void, unknown>;
  });

  return {
    status: retainAuthPartition(status, 0),
    startAuth: retainAuthPartition(startAuth, 0),
    disconnectAuth: retainAuthPartition(disconnectAuth, 0),
    verifyState: retainAuthPartition(verifyState, 1),
    verifyCallbackParameters: retainAuthPartition(
      authMethod((params: URLSearchParams, _ctx: ConnectorContext) => authValue(() => callbackParametersMatch(params))),
      1,
    ),
    verifyCallbackIssuer: retainAuthPartition(
      authMethod((issuer: string | null, ctx: ConnectorContext) => {
        return authValue<boolean>(() => {
          const provider = callbackProviders.get(scopeOf(ctx));
          if (!provider) return false;
          provider.validateCallbackIssuer(issuer);
          return true;
        });
      }),
      1,
    ),
    consumeAuthError: retainAuthPartition(
      authMethod((ctx: ConnectorContext) => {
        return authFlow<void>(function* () {
          const provider = callbackProviders.get(scopeOf(ctx));
          callbackProviders.delete(scopeOf(ctx));
          if (!provider)
            throw new ConnectorCallError("connector_call_failed", "OAuth error callback matches no pending consent.");
          (yield authInvoke(provider, "consumeAuthError", [])) as void;
        });
      }),
      0,
    ),
    finishAuth: retainAuthPartition(finishAuth, 1),
    access: (ctx) =>
      bindRenewableGrant(
        {
          fetch: recordingFetch(
            authMethod((input: string | URL, init?: RequestInit) => {
              return authCall(authorizedFetch, [ctx, input, init]) as Effect.Effect<Response, unknown>;
            }),
          ),
        },
        grantFor(ctx),
      ),
  };
}

// Hook calls keep the existing owner partition pinned while their native
// program settles. Each Promise shell enters its own registered program.
function retainAuthPartition<F extends (...args: any[]) => Promise<any>>(operation: F, contextIndex = 0): F {
  return authMethod((...args: Parameters<F>) =>
    authFlow<Awaited<ReturnType<F>>>(function* () {
      const release = retainOAuthPartition(oauthPartitionFor(args[contextIndex]));
      try {
        return (yield authCall(operation, args)) as Awaited<ReturnType<F>>;
      } finally {
        release();
      }
    }),
  ) as F;
}
