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
   * paging. Overrides the deployment's `calls.maxResultBytes`; omit to inherit
   * it. Must be a whole number of bytes >= 1; anything else warns at startup
   * and is ignored.
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

/**
 * How long a downstream gets to answer the session-termination DELETE before
 * teardown stops waiting. Deliberately a fraction of the core's scope-close
 * budget (`closeConnectorScope`), so the whole teardown still lands inside the
 * window that budget makes safe on an edge runtime: whatever is still in flight
 * when this expires is aborted by the close that immediately follows. What that
 * costs is only the acknowledgement — the DELETE is headers-only and has long
 * since gone out — so a slow provider still usually ends the session; it just
 * does not get to tell us so.
 */
const TERMINATE_SESSION_BUDGET_MS = 50;

/**
 * Ceiling on the tools one catalog refresh will accumulate while walking
 * `tools/list`.
 *
 * This is the bound that matters, and pages are the wrong dimension to put it
 * in: the *server* picks the page size, so a page ceiling is a tool ceiling
 * multiplied by a number connecta can neither observe in advance nor control.
 * At ten tools a page, 100 pages is 1,000 tools; at a hundred, 10,000 — and
 * connecta's own large-catalog envelope is benchmarked to 100,000 (issue #82).
 * A page ceiling low enough to be a real defense therefore sits *inside* the
 * catalog sizes this product exists to serve. Worse, the common conformant
 * idiom is to advertise a `nextCursor` whenever a page came back full and then
 * serve one empty page to terminate, so a perfectly well-behaved 10,000-tool
 * server paging at 100 spends 101 requests: bound the pages and its entire
 * catalog fails, for doing nothing wrong.
 *
 * So the ceiling goes on accumulated tools — the thing actually held in memory
 * — and it sits at the top of the benchmarked envelope rather than below it.
 * Deliberately the same philosophy as issue #82's discovery-response bounds:
 * cap the bytes a caller can be made to hold, not the number of round trips it
 * took to get them.
 */
const MAX_TOOLS = 100_000;

/**
 * Absolute backstop on `tools/list` pages in one refresh — a runaway guard, not
 * the primary defense.
 *
 * The walk terminates on its own well before this: a cursor handed back twice
 * is a definite loop, two consecutive pages that add no new tools are a server
 * going nowhere, and MAX_TOOLS caps what any of it can accumulate. This exists
 * only so the loop is finite even if a downstream somehow satisfies all three
 * forever, because the caller's probe deadline abandons the *caller*, not the
 * loop. Set high enough that no honest server reaches it.
 */
const MAX_TOOL_PAGES = 10_000;

/** One entry of the SDK's `tools/list` result, before it becomes a ToolDef. */
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * Re-prime an SDK client's tool-metadata cache from the *full* walked catalog.
 *
 * `Client.listTools()` ends by calling its private `cacheToolMetadata`, which
 * **clears** the output-schema validators and the task-support sets before
 * repopulating them from the page it just received. Call it once per page —
 * which walking the chain necessarily does — and the request-scoped client is
 * left holding metadata for the *last* page alone. `callTool` then finds no
 * validator for every earlier-page tool and silently skips both the "declared
 * an outputSchema but returned no structuredContent" check and the
 * structured-content validation, and finds no task requirement so a
 * required-task tool is dispatched as a plain `tools/call`. Enforcement would
 * depend on which page a tool happened to land on, which is not enforcement.
 *
 * So hand the whole aggregated list back deliberately, once, at the end. The
 * SDK types the method `private`, hence the cast; the SDK version is pinned
 * exactly and `test/remote-mcp-pagination.test.ts` asserts the method still
 * exists, so a bump that renames it fails CI rather than quietly restoring the
 * bug.
 */
function primeToolMetadata(client: Client, tools: ListedTool[]): void {
  const prime = (
    client as unknown as {
      cacheToolMetadata?: (tools: ListedTool[]) => void;
    }
  ).cacheToolMetadata;
  if (typeof prime !== "function") return;
  prime.call(client, tools);
}

/**
 * True for a result-parse failure caused by the page's `nextCursor` itself —
 * in practice `nextCursor: null`, a very common JSON idiom for "no more pages"
 * that the MCP schema does not accept (the chain ends on an *absent* cursor).
 * Duck-typed rather than `instanceof ZodError`: the SDK may parse with its own
 * zod instance, and cross-instance `instanceof` is a coin flip.
 */
function isCursorShapeError(err: unknown): boolean {
  const issues = (err as { issues?: unknown } | null)?.issues;
  return (
    Array.isArray(issues) &&
    issues.some((issue) => {
      const path = (issue as { path?: unknown }).path;
      return Array.isArray(path) && path[0] === "nextCursor";
    })
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * End the downstream's session before the connection is torn down.
 *
 * `Client.close()` only unwinds our side — it aborts the transport's controller
 * and fires `onclose`. Spec session termination is a separate DELETE carrying
 * `Mcp-Session-Id`, and without it a stateful provider keeps the session alive
 * until its own (often hour-long) timeout, which a periodic probe would then
 * accumulate several of per connector.
 *
 * Ordering is load-bearing: the SDK sends that DELETE on the transport's
 * AbortSignal, so calling this *after* close would abort the request on issue
 * and silently do nothing. Everything else is best-effort — a transport with no
 * `terminateSession` (a custom one, or an older SDK), a downstream that refuses
 * (405 is a legal answer), errors, or never replies all fall through to the
 * close with the session left to age out as it did before.
 */
async function terminateSession(transport: Transport): Promise<void> {
  const terminate = (
    transport as Transport & { terminateSession?: () => Promise<void> }
  ).terminateSession;
  if (typeof terminate !== "function") return;
  // The SDK issues no request at all when no `mcp-session-id` was captured, so
  // a stateless downstream never sees a spurious DELETE.
  const done = (async () => terminate.call(transport))().catch(() => {
    // The session is being abandoned either way; a refusal changes nothing.
    // Caught here rather than at the await below so a late rejection — one
    // arriving after the budget expired — is still consumed.
  });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TERMINATE_SESSION_BUDGET_MS);
    done.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  /**
   * One-way latch: set by closeScope and never cleared, so neither a late
   * connect nor a `reset()` can cache a client into a scope that is already
   * gone — that client would have no owner left to close it.
   */
  closed: boolean;
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

  const scopeEndedError = () =>
    new Error(`Connector "${id}" scope ended during connection.`);

  /**
   * One `tools/list` request. The only thing wrapped here is the diagnosis of a
   * `nextCursor` the MCP result schema refuses — overwhelmingly `null`, which
   * plenty of servers use to mean "no more pages" but the spec spells as an
   * *absent* cursor. The SDK surfaces that as a raw validation dump about a
   * field the operator never sees; say which server broke which rule instead.
   * Accepting `null` as end-of-chain outright is issue #99.
   */
  const listPage = async (client: Client, cursor: string | undefined) => {
    try {
      return await client.listTools(
        cursor === undefined ? undefined : { cursor },
      );
    } catch (err) {
      if (!isCursorShapeError(err)) throw err;
      throw new Error(
        `Connector "${id}" returned a tools/list page whose nextCursor is neither a string nor absent (a null cursor is the usual culprit) — MCP ends pagination on an absent nextCursor, so this catalog cannot be walked.`,
        { cause: err },
      );
    }
  };

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
        closed: false,
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
    // `closed` is deliberately not cleared — see ConnectionState.
  };

  const ensureConnected = async (
    ctx: ConnectorContext,
    state: ConnectionState,
  ): Promise<void> => {
    // Cross-isolate force re-auth: another isolate bumped the KV generation and
    // wiped credentials. This request's cached client still speaks the old
    // token — drop it so the next connect runs against current state.
    if (state.client && isOauth && state.connectedGeneration !== null) {
      const generation = await getProvider(ctx, state).generation();
      if (state.closed) throw scopeEndedError();
      if (generation !== state.connectedGeneration) {
        reset(state);
      }
    }
    if (state.closed) throw scopeEndedError();
    if (state.client) return;
    state.connecting ??= (async () => {
      const provider = isOauth ? getProvider(ctx, state) : null;
      const genAtStart = provider ? await provider.generation() : 0;
      if (state.closed) throw scopeEndedError();
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
        // A probe deadline can end its scope while connect is still in flight.
        // The transport is closed immediately by closeScope; if connect wins
        // that race anyway, close the resulting client rather than resurrecting
        // a session in the detached state object.
        if (state.closed) {
          try {
            await c.close();
          } catch {
            // The scope has already been discarded either way.
          }
          throw scopeEndedError();
        }
        // A force re-auth that landed WHILE we were connecting wiped the creds
        // this client just bound to. Discard it rather than cache a connection
        // that resurrects the wiped-and-reauthorized connector from a stale
        // isolate. Surfaces as auth_required — the connector genuinely needs
        // re-consent now.
        if (provider) {
          const generation = await provider.generation();
          // closeScope can land while the generation read is pending, after
          // connect succeeded but before this client is cached. Discard the
          // client on that side of the await too.
          if (state.closed) {
            try {
              await c.close();
            } catch {
              // The scope has already been discarded either way.
            }
            throw scopeEndedError();
          }
          if (generation !== genAtStart) {
            try {
              await c.close();
            } catch {
              // discarding either way
            }
            throw new UnauthorizedError(
              "Connector was re-authorized during connect; reconnect required.",
            );
          }
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
      const state = stateFor(ctx);
      await ensureConnected(ctx, state);
      // Bind the client once so the whole walk provably rides one session — a
      // cursor is only meaningful to the connection that issued it, and a
      // re-read could in principle pick up a different one. It is NOT guarding
      // against closeScope nulling state.client mid-loop: closeScope sets
      // `closed` and nulls `client` in one synchronous run, and the loop
      // re-checks `closed` before every page, so the nulled client is
      // unreachable from here.
      const client = state.client!;
      // Raw SDK tools, not ToolDefs: the metadata re-prime below needs fields
      // (task support) that a ToolDef deliberately does not carry.
      const listed: ListedTool[] = [];
      const names = new Set<string>();
      const spent = new Set<string>();
      let cursor: string | undefined;
      /** Consecutive pages that advertised a successor but added nothing. */
      let barren = 0;
      let complete = false;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        // The scope can end between pages (probe timeout, teardown). Stop
        // rather than keep paging into a transport that is being closed.
        if (state.closed) throw scopeEndedError();
        // Page one sends no params at all, so a non-paginated server sees
        // exactly the request it saw before pagination existed.
        const res = await listPage(client, cursor);
        let added = 0;
        for (const t of res.tools) {
          // First page wins. An unstable cursor can serve the same tool on two
          // pages — a failure mode that did not exist while only page one was
          // read — and a duplicate would inflate `toolCount`, double the tool's
          // `search_tools` row, and churn the registry's catalog-changed
          // comparison into a persistence write on every refresh.
          if (names.has(t.name)) continue;
          names.add(t.name);
          listed.push(t);
          added++;
        }
        // Pagination ends when `nextCursor` is ABSENT — not when it is falsy.
        // An empty string is a legal cursor and means "keep going"; `if
        // (!next)` here would silently truncate that server's catalog.
        const next = res.nextCursor;
        if (typeof next !== "string") {
          complete = true;
          break;
        }
        // A page that adds nothing and still claims a successor made no
        // progress. Allow exactly one: the widespread idiom is to advertise a
        // cursor whenever a page came back full and then serve one empty page
        // to terminate, and that server is conformant. Two in a row is a
        // downstream going nowhere, and this kills a "fresh cursor forever, no
        // tools" adversary in a couple of round trips instead of thousands.
        if (added === 0 && ++barren > 1) {
          throw new Error(
            `Connector "${id}" returned two consecutive tools/list pages that added no tools and still advertised another — the catalog is not advancing.`,
          );
        }
        if (added > 0) barren = 0;
        // A cursor handed back a second time is not a slow server, it is a
        // loop. Fail now rather than walking it until a ceiling notices.
        if (spent.has(next)) {
          throw new Error(
            `Connector "${id}" handed back a tools/list cursor it had already issued — the pagination chain loops.`,
          );
        }
        // Checked here rather than on arrival: this bounds what a *walk* may
        // accumulate, and a server that answers in one page was always free to
        // send whatever it sends.
        if (listed.length > MAX_TOOLS) {
          throw new Error(
            `Connector "${id}" advertised further tools/list pages past ${listed.length} tools, over the ${MAX_TOOLS}-tool ceiling one catalog refresh will collect.`,
          );
        }
        // Opaque by contract: handed straight back, never parsed, rewritten,
        // or persisted.
        spent.add(next);
        cursor = next;
      }
      // Fail the refresh outright. Returning what we have would publish a
      // partial catalog that looks complete; throwing lets the registry keep
      // serving the last complete one via its stale fallback.
      if (!complete) {
        throw new Error(
          `Connector "${id}" kept advertising more tools/list pages after ${MAX_TOOL_PAGES} — refusing to page further.`,
        );
      }
      // Repair what the per-page listTools calls left behind before any of
      // these tools can be called. See primeToolMetadata.
      primeToolMetadata(client, listed);
      return listed.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as ToolDef["inputSchema"],
        outputSchema: t.outputSchema as ToolDef["outputSchema"],
        annotations: t.annotations as ToolDef["annotations"],
      }));
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

    async closeScope(ctx) {
      const scope = ctx.requestScope ?? ctx;
      const state = states.get(scope);
      if (!state) return;

      // Delete before awaiting: a duplicate teardown is a no-op, and no later
      // lookup can reuse the state while its client is closing.
      states.delete(scope);
      state.closed = true;
      const client = state.client;
      const transport = state.transport;
      state.client = null;
      state.transport = null;
      state.connecting = null;
      state.authRequired = false;
      state.connectedGeneration = null;

      // Ask the downstream to drop its session first — closing only aborts our
      // side, and the DELETE that frees the server's rides on the very
      // AbortSignal the close is about to trip.
      if (transport) await terminateSession(transport);

      // Client.close() owns its connected transport. During an unfinished or
      // failed connect there is no cached client yet, so close the transport
      // directly to abort/release that half-open session.
      if (client) {
        await client.close();
      } else {
        await transport?.close();
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
    // The credential liveness checks (issue #24) probe only connectors that
    // actually hold a stored grant: with no tokens there is nothing whose
    // liveness could have lapsed, and a `status()` probe would kick off DCR +
    // consent on a timer for a connector nobody has authorized yet.
    connector.hasStoredCredential = async (ctx) => {
      const state = stateFor(ctx);
      return (await getProvider(ctx, state).tokens()) !== undefined;
    };

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
