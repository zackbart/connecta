import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { KvOAuthProvider } from "../auth/downstream-oauth.js";
import { ConnectorCallError } from "../errors.js";
import { CONNECTA_VERSION } from "../version.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorStatus,
  Logger,
  ToolDef,
} from "../types.js";

export type RemoteMcpAuth =
  | { type: "headers"; headers: Record<string, string> }
  | { type: "oauth" };

export interface RemoteMcpOptions {
  url: string;
  /** Human-readable display name; the connector id remains the address prefix. */
  title?: string;
  description?: string;
  /**
   * Max inline result size (bytes) for this connector's tools before
   * call_tool/batch_call truncate and stash the full text for get_result
   * paging. Overrides the deployment's `maxResultBytes`; omit to inherit it.
   * Must be a whole number of bytes >= 1; anything else warns at startup and
   * is ignored.
   */
  maxResultBytes?: number;
  /**
   * Optional agent-facing usage guide (markdown) served by the `skills`
   * meta-tool as `connector:<id>`. See `Connector.usageGuide`.
   */
  usageGuide?: string;
  auth?: RemoteMcpAuth;
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

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

interface ConnectionState {
  client: Client | null;
  transport: Transport | null;
  connecting: Promise<void> | null;
  authRequired: boolean;
  provider: KvOAuthProvider | null;
  connectedGeneration: number | null;
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
  // Weak keys ensure a completed request does not leave its SDK client,
  // transport, response bodies, AbortSignals, or connection promise reachable
  // from the isolate singleton. Those are request-bound in Cloudflare Workers.
  const states = new WeakMap<object, ConnectionState>();
  const isOauth = opts.auth?.type === "oauth";
  const logger = opts.logger ?? console;

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
    if (opts.auth?.type === "headers") {
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

  const stateFor = (ctx: ConnectorContext): ConnectionState => {
    const scope = ctx.requestScope ?? ctx;
    let state = states.get(scope);
    if (!state) {
      state = {
        client: null,
        transport: null,
        connecting: null,
        authRequired: false,
        provider: null,
        connectedGeneration: null,
      };
      states.set(scope, state);
    }
    return state;
  };

  const getProvider = (
    ctx: ConnectorContext,
    state: ConnectionState,
  ): KvOAuthProvider => {
    state.provider ??= new KvOAuthProvider(
      id,
      ctx.storage,
      `${ctx.baseUrl}/oauth/callback/${id}`,
    );
    return state.provider;
  };

  // NOTE: StreamableHTTPClientTransport speaks over fetch, which transparently
  // follows 3xx redirects. A malicious or compromised downstream MCP could
  // redirect to an internal address (e.g. http://169.254.169.254/…) and fetch
  // would re-issue the request — potentially carrying static auth headers. The
  // scheme check above only guards the first hop; a fully robust guard (manual
  // redirect handling + per-hop re-validation + stripping auth headers cross-
  // origin) lives in the SDK transport and is deferred to a future non-patch
  // release rather than reimplemented here.
  const buildTransport = (
    ctx: ConnectorContext,
    state: ConnectionState,
  ): Transport => {
    if (opts._transportFactory) return opts._transportFactory(ctx);
    const url = new URL(opts.url);
    if (opts.auth?.type === "oauth") {
      return new StreamableHTTPClientTransport(url, {
        authProvider: getProvider(ctx, state),
      });
    }
    const headers =
      opts.auth?.type === "headers" ? opts.auth.headers : undefined;
    return new StreamableHTTPClientTransport(
      url,
      headers ? { requestInit: { headers } } : undefined,
    );
  };

  const reset = (state: ConnectionState) => {
    state.client = null;
    state.transport = null;
    state.connecting = null;
    state.authRequired = false;
    state.connectedGeneration = null;
  };

  const ensureConnected = async (
    ctx: ConnectorContext,
    state: ConnectionState,
  ): Promise<void> => {
    // Cross-isolate force re-auth: another isolate bumped the KV generation and
    // wiped credentials. This request's cached client still speaks the old
    // token — drop it so the next connect runs against current state.
    if (state.client && isOauth && state.connectedGeneration !== null) {
      if (
        (await getProvider(ctx, state).generation()) !==
        state.connectedGeneration
      ) {
        reset(state);
      }
    }
    if (state.client) return;
    state.connecting ??= (async () => {
      const provider = isOauth ? getProvider(ctx, state) : null;
      const genAtStart = provider ? await provider.generation() : 0;
      // Stamp the provider so any saveTokens/saveClientInformation the SDK fires
      // during this connect (code exchange, DCR) — or during a later refresh on
      // the resulting client — is dropped if a concurrent force bumps the
      // generation past this point, instead of re-persisting wiped credentials.
      provider?.captureGeneration(genAtStart);
      // The SDK defaults to AJV, which compiles every advertised outputSchema
      // with `new Function`. Cloudflare Workers prohibit dynamic code
      // generation, so a remote such as Stripe fails during tools/list unless
      // the SDK's edge-safe validator is selected explicitly.
      const c = new Client(
        { name: "connecta", version: CONNECTA_VERSION },
        { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      );
      const t = buildTransport(ctx, state);
      state.transport = t;
      try {
        await c.connect(t);
        // A force re-auth that landed WHILE we were connecting wiped the creds
        // this client just bound to. Discard it rather than cache a connection
        // that resurrects the wiped-and-reauthorized connector from a stale
        // isolate. Surfaces as auth_required — the connector genuinely needs
        // re-consent now.
        if (provider && (await provider.generation()) !== genAtStart) {
          try {
            await c.close();
          } catch {
            // discarding either way
          }
          throw new UnauthorizedError(
            "Connector was re-authorized during connect; reconnect required.",
          );
        }
        state.client = c;
        state.connectedGeneration = genAtStart;
        state.authRequired = false;
      } catch (err) {
        // Only a real 401/UnauthorizedError means auth is the problem — a
        // network error on an oauth connector must surface as "error", not
        // "auth_required".
        if (err instanceof UnauthorizedError) {
          state.authRequired = true;
          throw authRequiredError(err);
        }
        throw err;
      } finally {
        state.connecting = null;
      }
    })();
    return state.connecting;
  };

  const connector: Connector = {
    id,
    title: opts.title,
    kind: "mcp",
    description: opts.description,
    maxResultBytes: opts.maxResultBytes,
    usageGuide: opts.usageGuide,

    async listTools(ctx) {
      const state = stateFor(ctx);
      await ensureConnected(ctx, state);
      const res = await state.client!.listTools();
      return res.tools.map(
        (t): ToolDef => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as ToolDef["inputSchema"],
          outputSchema: t.outputSchema as ToolDef["outputSchema"],
          annotations: t.annotations as ToolDef["annotations"],
        }),
      );
    },

    async callTool(name, args, ctx) {
      const state = stateFor(ctx);
      await ensureConnected(ctx, state);
      try {
        return await state.client!.callTool(
          {
            name,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          undefined,
          ctx.timeoutMs || ctx.signal
            ? {
                ...(ctx.timeoutMs ? { timeout: ctx.timeoutMs } : {}),
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              }
            : undefined,
        );
      } catch (err) {
        // A grant revoked after connect surfaces here, not in ensureConnected.
        if (err instanceof UnauthorizedError) {
          state.authRequired = true;
          throw authRequiredError(err);
        }
        throw err;
      }
    },

    async status(ctx): Promise<ConnectorStatus> {
      const state = stateFor(ctx);
      try {
        await ensureConnected(ctx, state);
        return { state: "ok" };
      } catch (err) {
        if (state.authRequired) {
          const url = await getProvider(ctx, state).pendingAuthorizationUrl();
          return {
            state: "auth_required",
            authorizationUrl: url,
            message: "Authorization required — open the URL to connect.",
          };
        }
        return { state: "error", message: msg(err) };
      }
    },

    async finishAuth(code, ctx) {
      const state = stateFor(ctx);
      const provider = getProvider(ctx, state);
      // The provider here may carry no captured generation, so its token saves
      // fail open. That is safe only because generation advances solely via the
      // force path, which always wipes oauth:state — so verifyState rejects any
      // pre-force callback before this runs. Keep those two facts coupled.
      const t = (state.transport ??
        buildTransport(ctx, state)) as StreamableHTTPClientTransport;
      await t.finishAuth(code);
      await provider.clearPending();
      // Reset so the next use reconnects with the freshly stored tokens.
      reset(state);
    },
  };

  if (opts.auth?.type === "oauth") {
    connector.verifyState = async (oauthState, ctx) => {
      const state = stateFor(ctx);
      return getProvider(ctx, state).verifyState(oauthState);
    };

    connector.startAuth = async (ctx, startOpts) => {
      const state = stateFor(ctx);
      const p = getProvider(ctx, state);
      if (startOpts?.force) {
        // Wipe stored credentials and drop the live connection so the next
        // connect attempt runs the flow from scratch (DCR + PKCE + consent).
        // Fence the in-flight connect first: a late-completing attempt must not
        // resurrect the credentials we're about to wipe, nor leave `client` set
        // (which would make ensureConnected below report already-authorized and
        // silently defeat force).
        await state.connecting?.catch(() => {});
        try {
          await state.client?.close();
        } catch {
          // best-effort; the connection is being discarded either way
        }
        // Bump the shared generation FIRST so any other isolate — one mid-
        // connect, or on its next tool call — sees the advance and drops its
        // client instead of keeping the token we're about to revoke.
        await p.bumpGeneration();
        // Wipe KV before dropping in-memory state so nothing racing back in can
        // write tokens over a half-cleared slot.
        await p.invalidateCredentials("all");
        await p.clearPending();
        reset(state);
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
          return {
            state: "auth_required",
            authorizationUrl: await p.pendingAuthorizationUrl(),
            message: "Authorization required — open the URL to connect.",
          };
        }
        return { state: "error", message: msg(err) };
      }
    };
  }

  return connector;
}
