// The per-request-scope connection state machine: one connect attempt per
// scope, credential and OAuth epoch checks before reuse, and a cached catalog
// served without connecting (INV-10).
import { routePhrases } from "../../agent-routes.js";
import { authView } from "../../auth/native-call.js";
import { authFlow, authCall, authInvoke, authMethod } from "../../auth/native.js";
import { openRequest, viewServices, viewSignal } from "../../runtime/call.js";
import { secretDigest } from "../../storage-digest.js";
import {
  downstreamClientMetadata,
  downstreamRedirectUri,
  remoteClientAuthMethod,
  selfHostedClientUrl,
} from "../../auth/downstream-client-metadata.js";
import { Client, SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import type { OAuthTokens, PriorDiscovery, ListToolsResult, Tool, Transport } from "@modelcontextprotocol/client";
import { Deferred, Effect, Exit, Scope } from "effect";
import { KvOAuthProvider, refreshCoordinatorsByPartition } from "../../auth/downstream-oauth.js";
import { trackOAuthStartReset } from "../../auth/oauth-start-reset.js";
import { sentSecretsFor } from "../../sent-secrets.js";
import { catalogClientOptions, observeCatalogChange } from "../../catalog-cache.js";
import { ConnectorCallError, resendAdvice } from "../../errors.js";
import { carryFailureFacts, failureRecord, logFailure } from "../../operator-record.js";
import { CONNECTA_VERSION } from "../../version.js";
import { oauthSealerFor } from "../../oauth-sealing.js";
import { RequestScope } from "../../runtime/request-scope.js";
import { Context } from "effect";
import { downstreamInputCapabilities } from "../../downstream-input-context.js";
import { detach, runEdge } from "../../runtime/run.js";
import type { RequestPrincipal } from "../../request-token.js";
import { requestPrincipalFor } from "../../request-principal.js";
import { callerOf } from "../../connector-caller.js";
import { forgetNegotiation, readNegotiation, storeNegotiation } from "../negotiation-cache.js";
import type { ConnectorContext } from "../../types.js";
import type { CallDispatch } from "./transport.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";
import { carriesIllegalHeaderChar, credentialHeaderValue } from "./config.js";
import { AUTH_OR_THROTTLE, promised, recordWireErrors, requiresAuthorization } from "./errors.js";
import { MAX_TOOL_PAGES } from "./catalog.js";
import { SKILLS_EXTENSION } from "./resources.js";

/** What a pre-connect catalog read already resolved, for the connect it falls back to. */
export interface Preread {
  credential?: string;
  negotiation?: { digest: string; prior: PriorDiscovery | undefined };
}

export interface ConnectionState {
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

/** One connector's connection states, credential reads and connect attempts. */
export function remoteMcpConnection(
  rt: RemoteMcpRuntime,
): Pick<
  RemoteMcpShared,
  | "entryFor"
  | "newProvider"
  | "isClosed"
  | "refreshCoordinatorFor"
  | "closeHalf"
  | "connectedProviders"
  | "stateFor"
  | "ensureConnected"
  | "requestOptions"
  | "cachedCatalog"
  | "cacheOwner"
  | "reset"
  | "states"
> {
  const {
    requestAuth,
    forwarding,
    id,
    staticClient,
    clientMetadataUrl,
    opts,
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
  } = rt;
  // Weak keys ensure a completed request does not leave its SDK client,
  // transport, response bodies, AbortSignals, or connect attempt reachable
  // from the isolate singleton. Those are request-bound in Cloudflare Workers.
  // A closed scope keeps its (emptied) entry, so a late or future lookup finds
  // it closed rather than recreating an ownerless connection under it.
  const states = new WeakMap<object, ConnectionState>();
  // Post-connect auth checks keep the exact provider that bound this client,
  // even if another attempt has since replaced the request scope's state.
  const connectedProviders = new WeakMap<Client, KvOAuthProvider>();
  const cacheOwner = {};
  const connectingWaiters = new WeakMap<Deferred.Deferred<Client, unknown>, number>();
  // Long-lived enough for distinct request scopes in this connector runtime to
  // join one token redemption. It owns no client, transport, or request state.
  const refreshCoordinatorFor = refreshCoordinatorsByPartition();

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
          throw new rt.UnresolvedTokenError();
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
        throw new rt.CredentialRequiredError(
          `Connector "${id}" needs an operator-managed credential, but ` +
            `credential storage is not configured. Configure vault in deployment code and redeploy. ${routePhrases(ctx).authorizeFor("recovery options")}.`,
        );
      }
      const value = ((yield authInvoke(ctx.credential, "get", [])) as string | null)?.trim();
      if (!value) {
        throw new rt.CredentialRequiredError(
          `Connector "${id}" has no stored credential — ${routePhrases(ctx).authorizeAndFollow(id)}.`,
        );
      }
      if (carriesIllegalHeaderChar(value)) {
        throw new rt.CredentialRequiredError(
          `Connector "${id}"'s stored credential contains a character a header ` +
            "cannot carry (a line break or other control character). " +
            `${routePhrases(ctx).authorizeFor("recovery options")}. When available, re-enter ` +
            "it in this connection in the operator UI. The value is not shown or logged.",
        );
      }
      return value;
    }),
  );

  const requestOptions = (ctx: ConnectorContext) =>
    ctx.timeoutMs || ctx.signal
      ? {
          ...(ctx.timeoutMs ? { timeout: ctx.timeoutMs } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }
      : undefined;

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
    if (isClosed(state)) throw rt.scopeEndedError();
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
  // Stored keys see a connector's configuration only through the keyed digest,
  // whole: every configured URL (endpoint, client metadata document, static
  // client issuer, redirect URI), header values and the static client's secret.
  // The catalog cache's configuration, partition and sharing are derived the
  // same way for a connect and for a pre-connect cache read, so both address
  // exactly the same entries.
  const catalogConfigFor = (ctx: ConnectorContext) =>
    secretDigest(
      ctx,
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
      }),
    );
  const catalogSharing: "private" | "shared" = requestAuth || opts.authScope === "personal" ? "private" : "shared";
  const catalogIdentityFor = (ctx: ConnectorContext, provider: KvOAuthProvider) =>
    authMethod(() =>
      authFlow<string>(function* () {
        const tokens = yield authInvoke(provider, "tokens", []);
        return yield authCall<string>(secretDigest, [ctx, JSON.stringify(tokens)]);
      }),
    );

  // The verdict's key: everything that decides how this connector's handshake
  // negotiates, through the keyed digest.
  const negotiationKey = (ctx: ConnectorContext, credentialDigest: string | null, epoch: string) =>
    secretDigest(
      ctx,
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
      ]),
    );

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
            (reason) => new rt.CredentialRequiredError(`Connector "${id}" ${reason}.`),
          )
        : undefined;
      const preread: Preread = {};
      let credentialDigest: string | null = null;
      if (credentialAuth || requestAuth) {
        preread.credential = (yield authCall(readCredential, [ctx, principal])) as string;
        credentialDigest = (yield authCall(secretDigest, [
          ctx,
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
              return yield authCall<string>(secretDigest, [ctx, JSON.stringify(current.tokens)]);
            }),
          );
        }
        if (opts.versionNegotiation !== "legacy") {
          const digest = (yield authCall(negotiationKey, [ctx, credentialDigest, epoch])) as string;
          const prior = (yield authCall(readNegotiation, [ctx, digest])) as PriorDiscovery | undefined;
          preread.negotiation = { digest, prior };
          if (prior?.kind === "modern") return preread;
        }
        const cache = (yield authCall(catalogClientOptions, [
          ctx,
          id,
          (yield authCall(catalogConfigFor, [ctx])) as string,
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
          throw rt.authRequiredError(ctx);
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
            throw rt.operatorDisconnectedError();
          }
        }
        if (state.client && oauthGeneration !== undefined && state.connectedGeneration !== null) {
          if (isClosed(state)) throw rt.scopeEndedError();
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
              (reason) => new rt.CredentialRequiredError(`Connector "${id}" ${reason}.`),
            )
          : undefined;
        if (credentialAuth || requestAuth) {
          credentialValue = preread?.credential ?? ((yield authCall(readCredential, [ctx, principal])) as string);
          credentialFramed = credentialHeaderValue(credentialScheme, credentialValue);
          // The principal joins the client's identity: another principal never
          // reuses this client, even if its resolver returns the same token.
          credentialDigest = (yield authCall(secretDigest, [
            ctx,
            principal ? JSON.stringify([principal, credentialValue]) : credentialValue,
          ])) as string;
          if (
            (state.client || state.connecting) &&
            state.credentialDigest !== null &&
            state.credentialDigest !== credentialDigest
          ) {
            const observedConnection = state.client ?? state.connecting;
            const currentCredential = (yield authCall(readCredential, [ctx, principal])) as string;
            if (isClosed(state)) throw rt.scopeEndedError();
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
        if (isClosed(state)) throw rt.scopeEndedError();
        if (state.client && rt.eraRefused.has(state.client)) closeHalf(state);
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
        if (isClosed(state)) throw rt.scopeEndedError();
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
              return rt.closeConnection(held.client, held.transport, ctx.logger);
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
        if (!owned()) return yield* Effect.fail(rt.scopeEndedError());
        if (provider) state.attemptProvider = provider;
        if (provider?.isOperatorDisconnectedEpoch(genAtStart)) {
          return yield* Effect.fail(rt.operatorDisconnectedError());
        }
        // SDK v2 selects its validator by runtime export condition: AJV on
        // Node and @cfworker/json-schema under workerd. The Workers-safe path
        // no longer needs Connecta-specific wiring.
        const negotiationDigest = yield* promised(
          authMethod(
            () => authCall(negotiationKey, [ctx, state.credentialDigest, genAtStart]) as Effect.Effect<string, unknown>,
          ),
        );
        let prior =
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
        if (!owned()) return yield* Effect.fail(rt.scopeEndedError());
        const catalogConfig = yield* promised(
          authMethod(() => authCall(catalogConfigFor, [ctx]) as Effect.Effect<string, unknown>),
        );
        const cacheOptions = yield* promised(
          authMethod(
            () =>
              authCall(catalogClientOptions, [
                ctx,
                id,
                catalogConfig,
                JSON.stringify([genAtStart, state.credentialDigest]),
                connectionAbort.signal,
                cacheOwner,
                catalogSharing,
                provider ? catalogIdentityFor(ctx, provider) : undefined,
              ]) as Effect.Effect<Awaited<ReturnType<typeof catalogClientOptions>>, unknown>,
          ),
        );
        if (!owned()) return yield* Effect.fail(rt.scopeEndedError());
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
          rt.installCatalogIntake(client, ctx, cacheOptions);
          return client;
        };
        let c = makeClient();
        let t = rt.buildTransport(
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
          return yield* Effect.fail(rt.scopeEndedError());
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
                // A server that stopped answering the legacy handshake its
                // verdict recorded refuses it with a 4xx (a modern-only server
                // names its versions). Negotiate afresh rather than wait out
                // the verdict; the handshake is not a write.
                const refused =
                  prior?.kind === "legacy" &&
                  error instanceof SdkHttpError &&
                  error.status >= 400 &&
                  error.status < 500 &&
                  !AUTH_OR_THROTTLE.includes(error.status);
                if (
                  !owned() ||
                  handshakeAbort.signal.aborted ||
                  (!refused &&
                    (prior ||
                      opts.versionNegotiation === "legacy" ||
                      !(error instanceof SdkHttpError) ||
                      error.code !== SdkErrorCode.EraNegotiationFailed ||
                      error.status < 500 ||
                      error.status >= 600))
                )
                  throw error;
                c = makeClient();
                t = rt.buildTransport(
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
                if (refused) prior = undefined;
                (yield authInvoke(c, "connect", [
                  t,
                  { signal: handshakeAbort.signal, ...(refused ? {} : { prior: { kind: "legacy" } }) },
                ])) as void;
              }
            }),
          ),
        ).pipe(
          Effect.mapError((err) =>
            rt.atMcpBoundary(
              ctx,
              // First, while the runtime's text can still be read for it.
              rt.withoutCredential(ctx, err, credentialValue, credentialFramed),
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
        if (!owned()) return yield* Effect.fail(rt.scopeEndedError());
        // A force re-auth that landed WHILE we were connecting wiped the
        // credentials this client just bound to. Discard it rather than cache
        // a stale-isolate connection.
        if (provider) {
          const generation = yield* promised(
            authMethod(() => authInvoke(provider, "liveEpoch", []) as Effect.Effect<string, unknown>),
          ).pipe(Effect.mapError((error) => (owned() ? error : rt.scopeEndedError())));
          // closeScope can land while the epoch read is pending, after
          // connect succeeded but before this client is cached. Discard the
          // client on that side of the await too.
          if (!owned()) return yield* Effect.fail(rt.scopeEndedError());
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
        // A modern connection, adopted or just negotiated, rests on the stored verdict.
        const era = discover ? rt.eraRefusals.get(t) : undefined;
        if (era)
          era.refused = () => {
            era.refused = undefined;
            rt.eraRefused.add(c);
            return forgetNegotiation(ctx, negotiationDigest);
          };
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
        if (!owned()) return yield* Effect.fail(rt.scopeEndedError());
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
            detach(rt.closeConnection(held.client, held.transport, ctx.logger));
          }
          if (err instanceof UnauthorizedError) {
            return Effect.fail(carryFailureFacts(err, rt.authRequiredError(ctx)));
          }
          // Defense in depth for the one error class that can quote the
          // credential: a runtime refusing the assembled header.
          // `readCredential` already rejects a value that cannot ride one, so
          // reaching this is a gap in that check rather than a routine
          // outcome.
          return Effect.fail(rt.withoutCredential(ctx, err, credentialValue, credentialFramed));
        }),
      );
    });
  };
  return {
    entryFor,
    newProvider,
    isClosed,
    refreshCoordinatorFor,
    closeHalf,
    connectedProviders,
    stateFor,
    ensureConnected,
    requestOptions,
    cachedCatalog,
    cacheOwner,
    reset,
    states,
  };
}
