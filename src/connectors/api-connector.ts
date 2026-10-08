import {
  ConnectorCallError,
  networkErrorCode,
  unavailableCallError,
  WithheldTextError,
} from "../errors.js";
import { attachFailureFacts, carryFailureFacts, errorLabel } from "../operator-record.js";
import { compileValidator, validateCatalogToolInput } from "../validate.js";
import { array, assertKnownOptions, instance, keys, optionsOf, strings } from "../config-schema.js";
import { describedEndpoint, describedOrigin, describedTools } from "../described.js";
import { CALL_ADMISSION, CREDENTIAL, USAGE_GUIDE } from "./option-shapes.js";
import { assertStaticToolNames } from "../tool-name.js";
import type {
  Connector,
  ConnectorAuthDescription,
  ConnectorCallAdmissionPolicy,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  ConnectorContext,
  ConnectorStatus,
  ConnectorUsageGuide,
  CredentialTestResult,
  JsonSchema,
  ToolAnnotations,
  ToolDef,
} from "../types.js";

export function defined<T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export interface ApiTool {
  name: string;
  /**
   * Required, non-empty. Discovery has nothing else to go on: a nameless
   * capability costs the agent a guess, and a guess costs a wrong call.
   */
  description: string;
  /**
   * A plain JSON Schema object describing the tool input. Optional, but what
   * you supply must be a schema the validator can compile — `api()` refuses to
   * construct otherwise.
   */
  inputSchema?: JsonSchema;
  /** A plain JSON Schema object describing the tool's structured output. */
  outputSchema?: JsonSchema;
  /**
   * Standard MCP-style behavior hints, with an explicit `readOnlyHint`
   * required: `true` declares a read and admits the tool to call_tool and
   * execute_code, `false` declares work that must cross
   * `call_destructive_tool` where a host can ask a human. Connecta never
   * infers the classification from a name, a description, a schema, or the
   * other annotations.
   */
  annotations: ToolAnnotations & { readOnlyHint: boolean };
  handler: (args: any, ctx: ApiHandlerContext) => Promise<unknown> | unknown;
}

/** How a pre-registered client authenticates at the token endpoint. */
export type ApiOAuthClientAuthentication =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

/**
 * Downstream OAuth 2.0 authorization code grant for a hand-written API whose
 * provider issues clients by hand and publishes no discovery metadata. Every
 * endpoint is declared here; nothing is learned from the network.
 */
export interface ApiOAuthConfig {
  /** Where the operator's browser is sent for consent. Absolute https URL. */
  authorizationEndpoint: string;
  /** Where codes are exchanged and refresh tokens redeemed. Absolute https URL. */
  tokenEndpoint: string;
  /** The client id the provider issued for this deployment. */
  clientId: string;
  /**
   * The client secret, from deployment configuration (an environment variable
   * or Worker secret), never a literal in source. Omit for a public client.
   * It is never written to storage.
   */
  clientSecret?: string;
  /**
   * Token-endpoint client authentication. Defaults to `client_secret_basic`
   * with a secret and `none` without one.
   */
  tokenEndpointAuthMethod?: ApiOAuthClientAuthentication;
  /** Space-separated scopes requested at consent. */
  scope?: string;
  /** PKCE with S256 (default true). Disable only for a server that rejects it. */
  pkce?: boolean;
  /**
   * Extra authorization-request parameters, such as a provider's
   * `access_type`. The grant's own parameters cannot be overridden.
   */
  authorizationParams?: Record<string, string>;
  /**
   * Headers added to every token-endpoint request — the code exchange and
   * each refresh — for a provider whose token endpoint demands its own
   * framing, such as Church Community Builder's
   * `Accept: application/vnd.ccbchurch.v2+json`. They replace the grant's
   * defaults of the same name; `Authorization`, `Content-Type`,
   * `Content-Length`, `Cookie`, and `Host` stay the grant's.
   */
  tokenRequestHeaders?: Record<string, string>;
  /**
   * The exact origins `ctx.oauth.fetch` sends the access token to, such as
   * `"https://api.ccbchurch.com"`. A request anywhere else is refused before
   * it is sent, so an untrusted URL in a response cannot carry the token off.
   */
  apiOrigins: readonly string[];
}

/** A handler's use of its connector's OAuth grant, never the grant itself. */
export interface ApiOAuthAccess {
  /**
   * `fetch` with the calling owner's access token as `Authorization: Bearer`.
   * Only to `apiOrigins`; redirects are returned unfollowed. A 401 earns one
   * coordinated refresh and one replay; a second 401, a refused refresh, or
   * no grant at all throws `auth_required`, and an authorization-server
   * outage throws a retryable `unavailable`.
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** The context an `api()` handler receives. */
export interface ApiHandlerContext extends ConnectorContext {
  /** Present exactly when the connector declares `oauth`. */
  oauth?: ApiOAuthAccess;
}

export interface ApiOptions {
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
  /** Optional operator-managed credential exposed through ctx.credential and the connection in the operator UI. */
  credential?: ConnectorCredentialConfig;
  /**
   * Optional downstream OAuth, exposed to handlers as `ctx.oauth` and managed
   * like a `remoteMcp()` grant: Connect in the operator UI, or
   * `authorize_connector`. Exclusive with `credential` — one connector, one
   * way to authenticate, so `auth_required` has one recovery.
   */
  oauth?: ApiOAuthConfig;
  /** Optional validation behind the connection's Test action in the operator UI. */
  testCredential?: (
    value: string,
    ctx: ConnectorContext,
  ) => Promise<CredentialTestResult>;
  /** Optional validation for named multi-field credentials. */
  testCredentials?: (
    values: ConnectorCredentialValues,
    ctx: ConnectorContext,
  ) => Promise<CredentialTestResult>;
  /**
   * Validate call arguments against each tool's `inputSchema` before invoking
   * the handler (default true). Mismatches fail with a non-retryable
   * `invalid_args` ConnectorCallError instead of reaching the handler. Set
   * false to restore the pre-validation pass-through for deployments relying
   * on loose coercion.
   */
  validateArgs?: boolean;
  tools: ApiTool[];
}

/**
 * Three things a hand-written surface is refused for at construction rather
 * than in production (#340): no description (discovery has nothing to route on
 * and a guess costs a call), no explicit `readOnlyHint` (connecta never infers
 * the safety class, so an unclassified tool is a deployment bug), and an
 * `inputSchema` the validator cannot compile (declaring one is optional;
 * declaring an unenforceable one is not). None of this reaches a proxied
 * catalog — the contract binds the surfaces we write, not the ones we relay.
 */
function checkToolContract(id: string, tool: ApiTool): void {
  const address = `${id}.${tool.name}`;
  if (typeof tool.description !== "string" || tool.description.trim() === "") {
    throw new Error(
      `api() tool "${address}" needs a non-empty description — it is what an ` +
        "agent reads to choose the tool (convention: imperative one-liner, " +
        'e.g. "Send an email via Resend").',
    );
  }
  if (typeof tool.annotations?.readOnlyHint !== "boolean") {
    throw new Error(
      `api() tool "${address}" needs an explicit annotations.readOnlyHint: ` +
        "true for a read, false for work that must cross " +
        "call_destructive_tool. Connecta never infers the classification " +
        "from a tool name, description, schema, or other annotations.",
    );
  }
  if (typeof tool.handler !== "function") {
    throw new Error(`api() tool "${address}" needs a handler function.`);
  }
  if (tool.inputSchema) compileValidator(tool.inputSchema, { address });
}

/** The closed options api() accepts; see `assertKnownOptions`. */
export const API_OPTIONS = optionsOf<ApiOptions>()({
  ...keys(
    "title", "description", "authScope", "maxResultBytes", "testCredential", "testCredentials",
    "validateArgs",
  ),
  callAdmission: CALL_ADMISSION,
  usageGuide: USAGE_GUIDE,
  credential: CREDENTIAL,
  oauth: optionsOf<ApiOAuthConfig>()({
    ...keys(
      "authorizationEndpoint", "tokenEndpoint", "clientId", "clientSecret", "tokenEndpointAuthMethod",
      "scope", "pkce", "apiOrigins",
    ),
    authorizationParams: strings(),
    tokenRequestHeaders: strings(),
  }),
  // A tool's annotations stay open: MCP lets a tool carry hints Connecta
  // does not interpret, and its schemas are JSON Schema, not options. A tool
  // carries its handler, so it is checked in place and kept, never copied.
  tools: array(
    instance(optionsOf<ApiTool>()(
      keys("name", "description", "inputSchema", "outputSchema", "annotations", "handler"),
    )),
  ),
});

/**
 * How an `api()` connector authenticates, as names and public endpoints. The
 * client id and secret, extra parameter values, and token-request header
 * values never leave the options.
 */
function describedApiAuth(opts: ApiOptions): ConnectorAuthDescription {
  const oauth = opts.oauth;
  if (!oauth) return { mode: opts.credential ? "credential" : "none" };
  const confidential = typeof oauth.clientSecret === "string" && oauth.clientSecret !== "";
  const authorizationEndpoint = describedEndpoint(oauth.authorizationEndpoint);
  const tokenEndpoint = describedEndpoint(oauth.tokenEndpoint);
  const apiOrigins = Array.isArray(oauth.apiOrigins)
    ? oauth.apiOrigins.flatMap((origin) => describedOrigin(origin) ?? [])
    : [];
  return {
    mode: "oauth",
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    apiOrigins,
    tokenEndpointAuthMethod:
      oauth.tokenEndpointAuthMethod ?? (confidential ? "client_secret_basic" : "none"),
    confidentialClient: confidential,
    pkce: oauth.pkce ?? true,
    ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
    ...(oauth.authorizationParams
      ? { authorizationParamNames: Object.keys(oauth.authorizationParams) }
      : {}),
    ...(oauth.tokenRequestHeaders
      ? { tokenRequestHeaderNames: Object.keys(oauth.tokenRequestHeaders) }
      : {}),
  };
}

/**
 * The OAuth half of an `api()` connector: the hooks the callback route,
 * operator UI, and `authorize_connector` key on, and the handler accessor.
 * Supplied by `api()` from `src/auth/static-oauth.ts`; defined here so this
 * module never imports the grant machinery.
 */
export interface ApiOAuthHooks {
  status(ctx: ConnectorContext): Promise<ConnectorStatus>;
  startAuth(
    ctx: ConnectorContext,
    opts?: { force?: boolean },
  ): Promise<ConnectorStatus>;
  disconnectAuth(ctx: ConnectorContext): Promise<void>;
  verifyState(state: string | null, ctx: ConnectorContext): Promise<boolean>;
  finishAuth(
    code: string,
    ctx: ConnectorContext,
    callbackParams?: URLSearchParams,
  ): Promise<void>;
  /** The handler-facing accessor for one call's context. */
  access(ctx: ConnectorContext): ApiOAuthAccess;
}

/**
 * A static connector; every tool passes {@link checkToolContract} first.
 *
 * The builder behind `api()`, without the downstream OAuth machinery: a
 * module that only ever builds credential-free connectors (the artifacts
 * connector) imports this and pays nothing for a grant it cannot declare.
 */
export function apiConnector(
  id: string,
  opts: ApiOptions,
  oauth?: ApiOAuthHooks,
): Connector {
  opts = assertKnownOptions(opts, `api(${JSON.stringify(id)})`, API_OPTIONS);
  assertStaticToolNames(opts.tools, `api(${JSON.stringify(id)}).tools`);
  if (opts.oauth !== undefined && oauth === undefined) {
    throw new Error(
      `api() connector "${id}" declares oauth but was built without its grant; construct it with api().`,
    );
  }
  const names = new Set<string>();
  for (const tool of opts.tools) {
    if (names.has(tool.name)) {
      throw new Error(
        `api() tool "${id}.${tool.name}" is declared more than once; discovery and dispatch must use one definition.`,
      );
    }
    names.add(tool.name);
    checkToolContract(id, tool);
  }
  const defs: ToolDef[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...defined({
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }),
    annotations: t.annotations,
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const validateArgs = opts.validateArgs ?? true;
  const auth = describedApiAuth(opts);
  return {
    id,
    ...defined({ title: opts.title }),
    kind: "api",
    describe: () => ({ source: { kind: "api" }, auth, tools: describedTools(defs) }),
    ...defined({
      description: opts.description,
      authScope: opts.authScope,
      maxResultBytes: opts.maxResultBytes,
      callAdmission: opts.callAdmission,
      usageGuide: opts.usageGuide,
      credential: opts.credential,
      testCredential: opts.testCredential,
      testCredentials: opts.testCredentials,
    }),
    ...(oauth
      ? {
          status: oauth.status,
          startAuth: oauth.startAuth,
          disconnectAuth: oauth.disconnectAuth,
          verifyState: oauth.verifyState,
          finishAuth: oauth.finishAuth,
        }
      : {}),
    staticTools: defs,
    async listTools() {
      return defs;
    },
    async callTool(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`Unknown tool "${name}" on connector "${id}"`);
      }
      const input = args ?? {};
      if (validateArgs && tool.inputSchema) {
        const invalid = validateCatalogToolInput(tool.inputSchema, input, {
          address: `${id}.${name}`,
          logger: ctx.logger,
          // Always: the schema compiled at construction, so anything that
          // fails here is a schema that cannot be enforced, and a surface we
          // wrote ourselves does not get to admit unvalidated input quietly.
          failClosed: true,
        }, { connector: id, tool });
        if (invalid) throw invalid;
      }
      // `await` (not a bare promise return) so a handler that throws before
      // its first await never sits handler-less for the thenable-adoption
      // microtask — workerd and vitest both report that gap as an unhandled
      // rejection even though the caller catches the failure.
      // The accessor closes over the registry's own context, not this copy,
      // so the grant it reaches is the one that context's owner holds.
      const handlerCtx: ApiHandlerContext = oauth
        ? { ...ctx, oauth: oauth.access(ctx) }
        : ctx;
      try {
        return await tool.handler(input, handlerCtx);
      } catch (error) {
        // The request's own abort reason, by identity, is the caller's.
        if (ctx.signal?.aborted === true && error === ctx.signal.reason) throw error;
        // A handler owns its destinations. ctx.baseUrl is Connecta's inbound
        // URL, so it must never masquerade as the failed downstream host.
        if (error instanceof ConnectorCallError) throw error;
        if (!networkErrorCode(error)) {
          // Anything else is a runtime's, parser's, or stream's account of
          // what the handler read (a JSON parser quotes the reply it choked
          // on; a body stream rejects with whatever the runtime says), so it
          // is told in connecta's words, classified as the original would
          // have been, and rebuilt without its cause or nested errors. A
          // handler that means the agent to read its words throws a
          // ConnectorCallError. No host is named: connecta does not know
          // which destination the handler read.
          const kind = errorLabel(error);
          throw attachFailureFacts(
            carryFailureFacts(error, new WithheldTextError(
              `Connector "${id}" tool "${name}" handler failed` +
                `${kind ? ` (${kind})` : ""}. Its text is withheld because it ` +
                "can quote what the downstream sent.",
              error,
            )),
            { step: "handler" },
          );
        }
        throw unavailableCallError(error, undefined, undefined, ctx.signal);
      }
    },
  };
}
