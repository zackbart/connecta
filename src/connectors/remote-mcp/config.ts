// remoteMcp() options and validation: the closed option set, resource and
// credential header rules, and every construction-time refusal, in order.
import { authorizationParamsFor } from "../../auth/oauth-authorization-params.js";
import { assertRemoteOAuthClient, type RemoteOAuthClient } from "../../auth/downstream-client-metadata.js";
import { assertOAuthScope } from "../../auth/downstream-oauth.js";
import { shortSecretWarning } from "../../sent-secrets.js";
import { assertKnownOptions, keys, optionsOf, strings } from "../../config-schema.js";
import type { PrincipalForwarding, RequestToken } from "../../request-token.js";
import { type GuardedTransport } from "../../guarded-transport.js";
import { READ_ONLY, CALL_ADMISSION, REMOTE_MCP_AUTH, USAGE_GUIDE } from "../option-shapes.js";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { ConnectorCredentialConfig } from "../../types.js";
import type { RemoteMcpAuth, RemoteMcpOptions } from "../remote-mcp.js";

interface RequestAuthFields {
  type: "request";
  token?: RequestToken;
  principal?: PrincipalForwarding;
  headers?: Record<string, string>;
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
export function credentialHeaderValue(scheme: string | null, value: string): string {
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
export function carriesIllegalHeaderChar(value: string): boolean {
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

/** What every seam reads of one connector's validated configuration. */
export interface RemoteMcpConfig {
  id: string;
  opts: RemoteMcpOptions;
  extraHeaders: Readonly<Record<string, string>> | undefined;
  skillsEnabled: boolean | undefined;
  clientMetadataUrl: string | undefined;
  oauthScope: string | undefined;
  authorizationParams: readonly (readonly [string, string])[];
  staticClient: RemoteOAuthClient | undefined;
  isOauth: boolean;
  credentialAuth: Extract<RemoteMcpAuth, { type: "credential" }> | undefined;
  requestAuth: RequestAuthFields | undefined;
  forwarding: PrincipalForwarding | undefined;
  requestToken: PrincipalForwarding["token"] | RequestToken | undefined;
  principalPolicy: PrincipalForwarding["accept"] | undefined;
  customFetch: FetchLike | undefined;
  customSender: GuardedTransport | undefined;
  credentialConfig: ConnectorCredentialConfig;
  credentialHeader: string;
  credentialScheme: string | null;
  destination: URL;
  endpointOrigin: string;
}
/** Validate `opts` once, at construction, and derive what every seam reads. */
export function remoteMcpConfig(id: string, opts: RemoteMcpOptions): RemoteMcpConfig {
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
  const isOauth = opts.auth?.type === "oauth";
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

  const endpointOrigin = new URL(opts.url).origin;
  return {
    id,
    opts,
    requestAuth,
    forwarding,
    staticClient,
    clientMetadataUrl,
    oauthScope,
    authorizationParams,
    destination,
    isOauth,
    extraHeaders,
    credentialHeader,
    credentialScheme,
    skillsEnabled,
    principalPolicy,
    credentialAuth,
    customFetch,
    customSender,
    requestToken,
    endpointOrigin,
    credentialConfig,
  };
}
