import { Effect, Exit } from "effect";
import { causeError, runEdge } from "../runtime/run.js";
import { credentialProbe } from "../runtime/credential-probe.js";
import { ContinuationBinding, serviceFor, setViewService, settleOnClose, duringViewEffect } from "../runtime/call.js";
import { registerCallEntry, toolEntry, type NativeCall } from "../runtime/call-entry.js";
import { ConnectorCallError, networkErrorCode, unavailableCallError, WithheldTextError } from "../errors.js";
import { attachFailureFacts, carryFailureFacts, errorLabel } from "../operator-record.js";
import { compileValidator, normalizeToolInput, validateCatalogToolInput } from "../validate.js";
import { array, assertKnownOptions, instance, keys, optionsOf, strings } from "../config-schema.js";
import { describedEndpoint, describedOrigin, describedTools } from "../described.js";
import { READ_ONLY, CALL_ADMISSION, CREDENTIAL, USAGE_GUIDE } from "./option-shapes.js";
import { assertStaticToolNames } from "../tool-name.js";
import { registerInvocationAuth } from "../invocation-auth.js";
import { redactCatalog, redactSentSecrets, sentSecretsFetch, trackCredentialReads } from "../sent-secrets.js";
import { callClassification } from "../call-classification.js";
import { classifyTool } from "../tool-safety.js";
import {
  closeProviderCall,
  enterProviderBoundary,
  inLogicalCall,
  knownProviderFailure,
  nestedProviderRequests,
  providerBoundary,
  providerCallContext,
  providerFetch,
  providerRequests,
  tracksRequests,
} from "../provider-call.js";
import { providerCallFailure, providerCallResult } from "../write-outcome.js";
import { deriveContext } from "../derived-context.js";
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

export function defined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
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
export type ApiOAuthClientAuthentication = "client_secret_basic" | "client_secret_post" | "none";

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
   * coordinated refresh. Only a positively read-classified GET/HEAD without
   * method-override headers is sent once more; a write's never is, and the call fails with `connector_call_failed`
   * whose outcome is unknown, so the agent checks the target before
   * repeating it. A second 401, a refused refresh, or no grant at all throws
   * `auth_required`, and an authorization-server outage throws a retryable
   * `unavailable`.
   */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** The context an `api()` handler receives. */
export interface ApiHandlerContext extends ConnectorContext {
  /** Fetch with final outgoing credential headers and query values registered. */
  fetch: typeof fetch;
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
  testCredential?: (value: string, ctx: ConnectorContext) => Promise<CredentialTestResult>;
  /** Optional validation for named multi-field credentials. */
  testCredentials?: (values: ConnectorCredentialValues, ctx: ConnectorContext) => Promise<CredentialTestResult>;
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
  ...keys("title", "description", "authScope", "maxResultBytes", "testCredential", "testCredentials", "validateArgs"),
  readOnly: READ_ONLY,
  callAdmission: CALL_ADMISSION,
  usageGuide: USAGE_GUIDE,
  credential: CREDENTIAL,
  oauth: optionsOf<ApiOAuthConfig>()({
    ...keys(
      "authorizationEndpoint",
      "tokenEndpoint",
      "clientId",
      "clientSecret",
      "tokenEndpointAuthMethod",
      "scope",
      "pkce",
      "apiOrigins",
    ),
    authorizationParams: strings(),
    tokenRequestHeaders: strings(),
  }),
  // A tool's annotations stay open: MCP lets a tool carry hints Connecta
  // does not interpret, and its schemas are JSON Schema, not options. A tool
  // carries its handler, so it is checked in place and kept, never copied.
  tools: array(
    instance(
      optionsOf<ApiTool>()(keys("name", "description", "inputSchema", "outputSchema", "annotations", "handler")),
    ),
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
    tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod ?? (confidential ? "client_secret_basic" : "none"),
    confidentialClient: confidential,
    pkce: oauth.pkce ?? true,
    ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
    ...(oauth.authorizationParams ? { authorizationParamNames: Object.keys(oauth.authorizationParams) } : {}),
    ...(oauth.tokenRequestHeaders ? { tokenRequestHeaderNames: Object.keys(oauth.tokenRequestHeaders) } : {}),
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
  startAuth(ctx: ConnectorContext, opts?: { force?: boolean }): Promise<ConnectorStatus>;
  disconnectAuth(ctx: ConnectorContext): Promise<void>;
  verifyState(state: string | null, ctx: ConnectorContext): Promise<boolean>;
  verifyCallbackIssuer(issuer: string | null, ctx: ConnectorContext): Promise<boolean>;
  consumeAuthError(ctx: ConnectorContext): Promise<void>;
  /** Requires callbackParams with a nonempty state, including without PKCE. */
  finishAuth(code: string, ctx: ConnectorContext, callbackParams: URLSearchParams): Promise<void>;
  /** The handler-facing accessor for one call's context; a write's request is never resent. */
  access(ctx: ConnectorContext, call: { write: boolean }): ApiOAuthAccess;
}

/**
 * A static connector; every tool passes {@link checkToolContract} first.
 *
 * The builder behind `api()`, without the downstream OAuth machinery: credential-free
 * providers import this without paying for a grant they cannot declare.
 */
export function apiConnector(id: string, opts: ApiOptions, oauth?: ApiOAuthHooks): Connector {
  opts = assertKnownOptions(opts, `api(${JSON.stringify(id)})`, API_OPTIONS);
  if (opts.readOnly !== undefined) READ_ONLY.parse(opts.readOnly, `Connector(${JSON.stringify(id)}).readOnly`);
  if (opts.callAdmission !== undefined)
    CALL_ADMISSION.parse(opts.callAdmission, `api(${JSON.stringify(id)}).callAdmission`);
  assertStaticToolNames(opts.tools, `api(${JSON.stringify(id)}).tools`);
  if (opts.oauth !== undefined && oauth === undefined) {
    throw new Error(`api() connector "${id}" declares oauth but was built without its grant; construct it with api().`);
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
  const connector: Connector = {
    id,
    ...defined({ title: opts.title }),
    kind: "api",
    describe: () => ({ source: { kind: "api" }, auth, tools: describedTools(defs) }),
    ...defined({
      description: opts.description,
      authScope: opts.authScope,
      readOnly: opts.readOnly,
      maxResultBytes: opts.maxResultBytes,
      callAdmission: opts.callAdmission,
      usageGuide: opts.usageGuide,
      credential: opts.credential,
      testCredential: opts.testCredential
        ? (value: string, ctx: ConnectorContext) =>
            credentialProbe(ctx, { value }, (view) => settleOnClose(view, () => opts.testCredential!(value, view)))
        : undefined,
      testCredentials: opts.testCredentials
        ? (values: ConnectorCredentialValues, ctx: ConnectorContext) =>
            credentialProbe(ctx, values, (view) => settleOnClose(view, () => opts.testCredentials!(values, view)))
        : undefined,
    }),
    ...(oauth
      ? {
          status: (ctx: ConnectorContext) => settleOnClose(ctx, () => oauth.status(ctx)),
          startAuth: (ctx: ConnectorContext, options?: { force?: boolean }) =>
            settleOnClose(ctx, () => oauth.startAuth(ctx, options)),
          disconnectAuth: (ctx: ConnectorContext) => settleOnClose(ctx, () => oauth.disconnectAuth(ctx)),
          // Callback work belongs to its request, including the route's
          // uninterruptible exchange, rather than any resource call.
          verifyState: (state: string | null, ctx: ConnectorContext) =>
            settleOnClose(ctx, () => oauth.verifyState(state, ctx), true),
          verifyCallbackIssuer: (issuer: string | null, ctx: ConnectorContext) =>
            settleOnClose(ctx, () => oauth.verifyCallbackIssuer(issuer, ctx), true),
          consumeAuthError: (ctx: ConnectorContext) => settleOnClose(ctx, () => oauth.consumeAuthError(ctx), true),
          finishAuth: (code: string, ctx: ConnectorContext, callbackParams: URLSearchParams) =>
            settleOnClose(ctx, () => oauth.finishAuth(code, ctx, callbackParams), true),
        }
      : {}),
    staticTools: defs,
    async listTools(ctx) {
      return settleOnClose(ctx, async () => redactCatalog(ctx, defs));
    },
    callTool: (name, args, ctx, options) => runEdge(core(name, args, ctx, options)),
  };
  const core: NativeCall = (name, args, ctx) =>
    Effect.gen(function* () {
      trackCredentialReads(ctx);
      enterProviderBoundary(ctx, connector);
      const tool = byName.get(name);
      // Refusals before the handler runs are known failures: nothing was sent.
      if (!tool) {
        throw knownProviderFailure(new Error(`Unknown tool "${name}" on connector "${id}"`));
      }
      // `await` (not a bare promise return) so a handler that throws before
      // its first await never sits handler-less for the thenable-adoption
      // microtask — workerd and vitest both report that gap as an unhandled
      // rejection even though the caller catches the failure.
      // Derived, never mutated: the registry's context stays as it was, and
      // the call state beside it (caller, admission permit, recovery facts,
      // sent secrets) resolves through the handler's copy. The grant sends a
      // write once: the registry's classification of this call decides, else
      // the rule the registry would apply to the tool (INV-1).
      const write = (callClassification(ctx) ?? classifyTool(tool)) === "write";
      const callCtx = providerCallContext(ctx, providerRequests(ctx) ? classifyTool(tool) : write ? "write" : "read");
      const handlerCtx = deriveContext<ApiHandlerContext>(callCtx, {
        fetch: providerFetch(callCtx, opts.title ?? id, false, sentSecretsFetch(ctx)),
        ...(oauth ? { oauth: oauth.access(callCtx, { write }) } : {}),
      });
      setViewService(handlerCtx, ContinuationBinding, {
        connection: serviceFor(ctx, ContinuationBinding)?.connection || id,
        principal: serviceFor(ctx, ContinuationBinding)?.principal ?? null,
      });
      let handlerStarted = false;
      const handled = yield* Effect.exit(
        Effect.gen(function* () {
          const input = normalizeToolInput(args ?? {});
          if (validateArgs && tool.inputSchema) {
            const invalid = validateCatalogToolInput(
              tool.inputSchema,
              input,
              {
                address: `${id}.${name}`,
                logger: ctx.logger,
                // Always: the schema compiled at construction, so anything that
                // fails here is a schema that cannot be enforced, and a surface we
                // wrote ourselves does not get to admit unvalidated input quietly.
                failClosed: true,
              },
              { connector: id, tool },
            );
            if (invalid) throw knownProviderFailure(invalid);
          }
          handlerStarted = true;
          // The opaque handler may await a helper, swallow its rejection, or
          // wait elsewhere. Its boundary remains call-owned; auxiliary helpers
          // retain their separate request ownership. Ledger settlement below
          // must see the close reason before this call's Promise rejects.
          const native = toolEntry(tool);
          return yield* native
            ? duringViewEffect(callCtx, () => native(input, handlerCtx))
            : Effect.tryPromise({
                // Custom handlers retain their Promise revocation bridge and
                // synchronous entry, including their helpers' fact ordering.
                try: () => settleOnClose(callCtx, () => Promise.resolve(tool.handler(input, handlerCtx))),
                catch: (error) => error,
              });
        }),
      );
      if (Exit.isFailure(handled)) {
        const error = causeError(handled.cause, callCtx.signal);
        // Settled before anything is decided or reported: a request that has
        // not left by now (a sibling awaiting its credential) never will.
        closeProviderCall(callCtx);
        if (!handlerStarted) {
          throw knownProviderFailure(
            error instanceof ConnectorCallError
              ? error
              : new ConnectorCallError(
                  "invalid_args",
                  `Cannot validate arguments for "${id}.${name}": its inputSchema could not be evaluated`,
                ),
          );
        }
        // A handler owns its destinations. ctx.baseUrl is Connecta's inbound
        // URL, so it must never masquerade as the failed downstream host.
        const settle = (failure: unknown) =>
          redactSentSecrets(
            ctx,
            providerCallFailure(handlerCtx, { title: opts.title ?? id }, failure, {
              dispatched: true,
              fallback: write ? "write" : "read",
              finalize: true,
              // Only a declared provider's ledger can see every request.
              untracked: !tracksRequests(connector),
            }),
          );
        // The request's own abort reason, by identity, is the caller's. The
        // invocation reports it for its logical call; any other write's is
        // settled like any other failure: it may have left.
        if (ctx.signal?.aborted === true && error === ctx.signal.reason) {
          if (!write || inLogicalCall(ctx)) throw error;
          throw settle(error);
        }
        if (error instanceof ConnectorCallError) throw settle(error);
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
          throw settle(
            attachFailureFacts(
              carryFailureFacts(
                error,
                new WithheldTextError(
                  `Connector "${id}" tool "${name}" handler failed` +
                    `${kind ? ` (${kind})` : ""}. Its text is withheld because it ` +
                    "can quote what the downstream sent.",
                  error,
                ),
              ),
              { step: "handler" },
            ),
          );
        }
        // A handler is opaque: by the time its fetch failed it may already
        // have sent the write, so no network code proves a write unsent.
        const unreachable = unavailableCallError(error, undefined, undefined, ctx.signal);
        // A raw handler with no tracked requests remains opaque, as before.
        // Once guarded requests exist, its own or a nested api() boundary's,
        // the ledgers supply the dispatch proof.
        if (providerRequests(handlerCtx)?.length || nestedProviderRequests(handlerCtx).length)
          throw settle(unreachable);
        throw providerCallFailure(ctx, { title: opts.title ?? id }, unreachable, {
          dispatched: true,
          fallback: classifyTool(tool),
        });
      }
      closeProviderCall(callCtx);
      // A write an undeclared 401 left unknown fails however its handler returned.
      const unknown = providerCallResult(handlerCtx, write ? "write" : "read");
      if (unknown) throw redactSentSecrets(ctx, unknown);
      return redactSentSecrets(ctx, handled.value);
    }).pipe(Effect.catchDefect((error) => Effect.fail(error)));
  // This boundary's identity in a logical call, fixed now: this object with
  // this function, never whatever the property or a copy holds by then.
  providerBoundary(connector);
  registerCallEntry(connector, core);
  if (oauth)
    registerInvocationAuth(connector, async (ctx) => {
      // The built-in static OAuth status only reads the stored grant. It never
      // refreshes, invokes a handler, or sends a downstream request.
      if ((await settleOnClose(ctx, () => oauth.status(ctx))).state === "auth_required") {
        throw new ConnectorCallError(
          "downstream_oauth_required",
          `Connector "${id}" requires authorization. Call authorize_connector.`,
        );
      }
    });
  return connector;
}
