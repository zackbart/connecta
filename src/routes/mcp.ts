import { bindActivityRequest } from "../activity-request.js";
import { closeConnectorScope } from "../connector-scope.js";
import { executeLimits } from "../config.js";
import { oauthConnectUrl, oauthConnectUnavailable } from "../oauth-handoff.js";
import { AuthElicitation } from "../auth-elicitation.js";
import {
  classifyInboundRequest,
  createMcpHandler,
  isJSONRPCErrorResponse,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Duration, Effect, Exit, Option, Result, Scope } from "effect";
import type { ActivityActor, ActivityRequestContext } from "../activity.js";
import type { McpClientContext } from "../mcp-client-context.js";
import { registerExecuteTool } from "../execute.js";
import {
  ExecutorAdmissionError,
  type AdmissionController,
  type AdmissionLease,
} from "../executor-admission.js";
import { registerMetaTools } from "../meta-tools.js";
import type { RegistryView } from "../registry.js";
import { intersectAccess } from "../connector-access.js";
import type { ConnectorAccess } from "../connector-access.js";
import { CONNECTA_INSTRUCTIONS } from "../skills.js";
import { failureRecord, logFailure } from "../operator-record.js";
import { redactAgentOutput, sentSecretsForRequest, type SentSecrets } from "../sent-secrets.js";
import { detach } from "../runtime/run.js";
import type { Logger } from "../types.js";
import {
  authorize,
  mayManageConnector,
  validateAuthPermissions,
  type RouteContext,
  type RuntimeExecutionContext,
  type ServerOptions,
} from "./shared.js";

/**
 * The SDK's own bound on the body it reads. Since server 2.1.0 the SDK
 * answers anything over 4 MiB with its own 413, which would quietly shadow
 * the bound the host already enforces: `listen()`'s `maxBodyBytes` on Node,
 * the platform's request limit on Workers. The host owns that decision, as it
 * did before the SDK had an opinion, so the SDK is told to have none. Its
 * option must be finite.
 */
const SDK_BODY_BOUND = { maxRequestBodySize: Number.MAX_SAFE_INTEGER };

// Identity, not a status/header a custom auth response could imitate.
const deadlineResponses = new WeakSet<Response>();

async function isModernListen(request: Request, signal: AbortSignal): Promise<boolean> {
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
    void request.body?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > SDK_BODY_BOUND.maxRequestBodySize) return false;
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) return false;
    const protocolVersion = request.headers.get("MCP-Protocol-Version");
    const method = request.headers.get("Mcp-Method");
    const route = classifyInboundRequest({
      httpMethod: request.method,
      ...(protocolVersion !== null ? { protocolVersionHeader: protocolVersion } : {}),
      ...(method !== null ? { mcpMethodHeader: method } : {}),
      body: JSON.parse(text + decoder.decode()),
    });
    return route.kind === "modern" && route.messageKind === "request" &&
      route.message.method === "subscriptions/listen";
  } catch {
    // Leave unreadable, malformed, and legacy bodies to the normal SDK path.
    return false;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name",
};

// Browser-based MCP clients call /mcp cross-origin. Without CORS on every
// response — errors included — the browser hides the 401, the client cannot
// read WWW-Authenticate, and OAuth discovery silently never starts.
function withMcpCors(
  response: Response,
  request: Request,
  allowedOrigin: string | null,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) {
    headers.set(name, value);
  }
  headers.delete("Access-Control-Allow-Origin");
  if (allowedOrigin !== null) headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.append("Vary", "Origin");
  if (request.method === "OPTIONS") {
    // Browsers do not interpret a prefix wildcard in Allow-Headers. Echo only
    // valid SEP-2243 field names; unrelated requested headers stay disallowed.
    const paramHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
      .toLowerCase().split(",").map(name => name.trim())
      .filter(name => /^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name));
    if (paramHeaders.length) {
      headers.append("Access-Control-Allow-Headers", [...new Set(paramHeaders)].join(", "));
    }
    headers.append("Vary", "Access-Control-Request-Headers");
  }
  headers.set(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Retry-After, mcp-session-id, mcp-protocol-version, Connecta-Error-Code, Connecta-Recovery",
  );
  const wrapped = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (deadlineResponses.has(response)) deadlineResponses.add(wrapped);
  return wrapped;
}

/** Transport refusals occur before the RPC body is decoded, so its id is unknown. */
function mcpRefusal(sentSecrets: SentSecrets, status: number, code: number, message: string): Response {
  const response = Response.json(redactAgentOutput(sentSecrets, { jsonrpc: "2.0", error: { code, message } }), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
  if (status === 504 && code === -33003) deadlineResponses.add(response);
  return response;
}

function requestAdmissionFailure(sentSecrets: SentSecrets, error: ExecutorAdmissionError): Response {
  const overloaded = error.code === "executor_overloaded";
  const data = {
    code: overloaded ? "server_overloaded" : "server_shutting_down",
    retryable: overloaded,
    ...(overloaded && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  if (overloaded && error.retryAfterMs !== undefined) {
    headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
    );
  }
  return new Response(
    JSON.stringify(redactAgentOutput(sentSecrets, {
      jsonrpc: "2.0",
      error: {
        // MCP 2026-07-28 basic#error-codes forbids new allocations in the
        // legacy -32000..-32019 range. Use application codes outside the
        // JSON-RPC reserved range, avoiding retired protocol meanings.
        code: overloaded ? -33001 : -33002,
        message: overloaded
          ? "Server capacity is exhausted. Retry later."
          : "Server is shutting down.",
        data,
      },
    })),
    { status: 503, headers },
  );
}

/**
 * Hand a response the Scope that holds what its request acquired.
 *
 * A request owns its permit and its McpServer through the response body, not
 * merely until the handler returns. `close` runs once, on whichever comes
 * first: the body is read to its end or fails, its reader cancels it, or the
 * request's signal aborts. This is what makes slow clients and response-stream
 * failure part of the same bounded lifecycle as success, error, and
 * cancellation.
 */
function closeWithBody(
  response: Response,
  signal: AbortSignal,
  close: () => void,
): Response {
  let released = false;
  let onAbort = () => {};
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", onAbort);
    close();
  };
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  onAbort = () => {
    // `cancel()` belongs to an operator/auth/SDK-provided stream and may
    // reject or never settle. Release now; consume either outcome separately.
    release();
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Run a request's handler in a Scope that outlives it.
 *
 * The handler acquires into the scope and its response carries the scope
 * out, for `closeWithBody` to close when the body ends. A handler that fails,
 * or is interrupted because the request's signal aborted, closes it at once:
 * nothing it acquired waits on a body that will never be read.
 */
function scopedToBody(
  handler: Effect.Effect<Response, unknown, Scope.Scope>,
  signal: AbortSignal,
): Effect.Effect<Response, unknown> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const exit = yield* Effect.exit(restore(Scope.provide(scope)(handler)));
      if (Exit.isFailure(exit)) {
        yield* Scope.close(scope, exit);
        return yield* exit;
      }
      // A deadline can finish with a fresh error response after aborting the
      // request. Release request resources now, without cancelling that body.
      if (signal.aborted && deadlineResponses.has(exit.value)) {
        yield* Scope.close(scope, Exit.void);
        return exit.value;
      }
      // Every finalizer in the scope is synchronous, so the close has run by
      // the time detach returns: the permit is back, and handed to the next
      // queued request, inside the read or cancel that ended the body.
      return closeWithBody(exit.value, signal, () => {
        void detach(Scope.close(scope, Exit.void));
      });
    }),
  );
}

/**
 * The request's admission permit, owned by its Scope.
 *
 * Admission goes through the controller's Promise rather than its Effect
 * program (`acquireScoped`), on purpose. The pool is shared by every request
 * in the isolate, and a queued request is handed its permit from inside the
 * request whose body just ended. A fiber resumed there would authorize and
 * serve this request in that one's I/O context, which workerd refuses;
 * awaiting `acquire()`'s promise resumes it in its own.
 *
 * The wait stays interruptible, and a permit granted just as it was
 * interrupted still arrives, later, to be released on arrival.
 */
function admitted(
  controller: AdmissionController,
  signal: AbortSignal,
): Effect.Effect<AdmissionLease, unknown, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const pending = controller.acquire({ signal });
      return Effect.tryPromise({ try: () => pending, catch: (error) => error })
        .pipe(Effect.onInterrupt(() => Effect.sync(() => {
          pending.then((lease) => lease.release(), () => {});
        })));
    }),
    (lease) => Effect.sync(() => lease.release()),
    { interruptible: true },
  );
}

/**
 * 404 for any `?toolkit=` value, kept after the feature's retirement (#178).
 *
 * Toolkits are gone, but the URLs that named them are not: clients were handed
 * MCP endpoint URLs with `?toolkit=` baked in, and nothing about upgrading the
 * server rotates them. Silently serving those clients the full registry would
 * turn a former scoping boundary into fail-open — so a request still sending
 * the param gets the same explicit 404 an unknown toolkit got before, plus an
 * operator-side log line, which (as ever — issue #47) is the channel that
 * actually reaches a human.
 */
function toolkitRetired(logger: Logger, sentSecrets: SentSecrets): Response {
  logger.warn(
    "[connecta] rejected an /mcp connection carrying ?toolkit= with 404: " +
      "toolkits were retired in issue #178 (see PRINCIPLES.md) — one deployment " +
      "serves one audience. The client sees a transport-level failure and " +
      "never the reason, so remove the ?toolkit= value from its MCP endpoint " +
      "URL, or point it at the deployment for its audience.",
  );
  return new Response(
    JSON.stringify(redactAgentOutput(sentSecrets, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "This deployment does not accept ?toolkit=. Toolkits were retired " +
          "in issue #178 — remove the ?toolkit= value from the MCP endpoint " +
          "URL, or ask the operator for the deployment serving this audience.",
      },
    })),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

function serveMcp(
  request: Request,
  requestSignal: AbortSignal,
  requestScope: object,
  opts: ServerOptions,
  baseUrl: string,
  actor: ActivityActor,
  registry: RegistryView,
  canManageAuth: (connectorId: string) => boolean,
  principalKey: string | undefined,
  runtimeContext?: RuntimeExecutionContext,
  trust: import("../tool-safety.js").PoolTrust = "read-only",
  pool?: string,
  principalActor?: ActivityActor,
): Effect.Effect<Response, never, Scope.Scope> {
  const sentSecrets = sentSecretsForRequest(requestScope);
  // Every McpServer the request builds is fresh and closes with its scope.
  // The modern handler tears its own down after the exchange; the legacy
  // transport never does, and neither may stay wired to an ended request.
  const servers: McpServer[] = [];
  const createServer = (): McpServer => {
    const authElicitation = new AuthElicitation({
      vault: opts.config.vault,
      publicUrl: opts.config.publicUrl,
      endpoint: new URL(new URL(request.url).pathname, baseUrl).href,
      principal: principalKey,
      registry,
      canManage: canManageAuth,
      connectUrl: (id, force) => oauthConnectUrl(opts, opts.config.publicUrl ?? baseUrl, id, principalKey, force,
        Boolean(opts.config.vault?.seal && opts.config.vault.open)),
      unavailable: oauthConnectUnavailable(opts),
      credentialUi: Boolean(opts.config.ui && opts.config.vault),
    });
    const server = new McpServer(opts.config.serverInfo, {
      // A request-local server cannot publish catalog changes. Set this before
      // tool registration, whose SDK default otherwise advertises listChanged.
      capabilities: { tools: { listChanged: false }, extensions: {} },
      instructions: CONNECTA_INSTRUCTIONS,
      inputRequired: { legacyShim: false },
      requestState: { verify: (state, context) => authElicitation.verify(state, context) },
      cacheHints: {
        "server/discover": { ttlMs: 3_600_000, cacheScope: "private" },
        "tools/list": {
          ttlMs: 3_600_000,
          cacheScope: "private",
        },
      },
    });
    const activity: ActivityRequestContext | undefined = opts.config.activity?.store
      ? {
          sink: opts.config.activity?.store,
          recordTool: opts.config.activity?.recordTool,
          actor,
          ...(principalActor ? { principalActor } : {}),
          requestId: crypto.randomUUID(),
          ...(pool !== undefined ? { pool } : {}),
          serverInfo: opts.config.serverInfo,
          ...(opts.config.activity?.deploymentId
            ? { deploymentId: opts.config.activity?.deploymentId }
            : {}),
          ...(runtimeContext?.waitUntil
            ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
            : {}),
          logger: opts.config.logger,
        }
      : undefined;
    if (activity) bindActivityRequest(requestScope, activity);
    const client: McpClientContext = {};
    registerMetaTools(server, registry, {
      authElicitation,
      client,
      baseUrl,
      requestScope,
      trust,
      canManageAuth,
      oauthConnectUrl: (id, force) => oauthConnectUrl(opts, baseUrl, id, principalKey, force),
      oauthConnectUnavailable: oauthConnectUnavailable(opts),
      credentialHandoffUrl: opts.config.ui?.credentialHandoffUrl(baseUrl),
      ...(activity ? { activity } : {}),
      defaultToolTimeoutMs: opts.config.calls.defaultTimeoutMs ?? opts.config.execute.hostCallTimeoutMs,
      probeTimeoutMs: opts.config.discovery.probeTimeoutMs,
      discoveryConcurrency: opts.config.discovery.concurrency,
      requestSignal,
      ...(runtimeContext?.waitUntil
        ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
        : {}),
    });
    registerExecuteTool(server, registry, {
      authElicitation,
      client,
      baseUrl,
      requestScope,
      executor: opts.executor,
      defaultToolTimeoutMs: opts.config.calls.defaultTimeoutMs ?? opts.config.execute.hostCallTimeoutMs,
      logger: opts.config.logger,
      ...(activity ? { activity } : {}),
      requestSignal,
      ...(runtimeContext?.waitUntil
        ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
        : {}),
      ...executeLimits(opts.config),
      trust,
    });
    servers.push(server);
    return server;
  };

  const exchange = async (): Promise<Response> => {
    // The v2 entry's built-in legacy fallback streams 2025 results as SSE.
    // Connecta's established wire contract is JSON, so retain the documented
    // user-land legacy branch with the same transport setting while the modern
    // branch uses the fetch-native handler.
    if (!(await isLegacyRequest(request, undefined, SDK_BODY_BOUND))) {
      const response = await createMcpHandler(createServer, {
        ...SDK_BODY_BOUND,
        legacy: "reject",
        // Keep the SDK's validation and prevent it from opening an SSE stream.
        // Its capacity error below becomes our permanent unsupported method.
        maxSubscriptions: 0,
        onerror: (error) => logFailure(opts.config.logger, "MCP handler error", failureRecord({}, error), "error"),
      }).fetch(request);
      if (request.headers.get("Mcp-Method") === "subscriptions/listen" && response.status === 200) {
        const body = await response.clone().json();
        if (isJSONRPCErrorResponse(body) && body.error.code === -32603 && body.error.message === "Subscription limit reached") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found: subscriptions/listen" },
          }), { status: 404, headers: response.headers });
        }
      }
      return response;
    }

    // Fresh server + transport per legacy request, stateless and JSON-shaped.
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      ...SDK_BODY_BOUND,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  return Effect.addFinalizer(() => Effect.sync(() => {
    for (const server of servers) void server.close().catch(() => {});
  })).pipe(Effect.andThen(Effect.promise(async () => {
    const response = await exchange();
    // Both SDK transports serialize here. This also covers SDK-generated
    // JSON-RPC errors and allowed HTTP 4xx text, outside tool result shaping.
    if (!response.body) return response;
    let body = await response.text();
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      // Structured redaction also joins text blocks before a secret split
      // across them can cross the serialization boundary.
      try { body = JSON.stringify(redactAgentOutput(sentSecrets, JSON.parse(body))); }
      catch { /* Non-JSON diagnostics still pass through the text boundary. */ }
    }
    const text = redactAgentOutput(sentSecrets, body);
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  })));
}

export function createMcpRoute(
  opts: ServerOptions,
): {
  handle(context: RouteContext): Effect.Effect<Response | null, unknown>;
  rejectOrigin(request: Request): Response | null;
} {
  const configuredOrigins = opts.config.allowedOrigins;
  const isExactOrigin = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  };
  // The schema has already refused anything but exact origins or "*".
  const origins = new Set(configuredOrigins === undefined
    ? opts.config.publicUrl ? [new URL(opts.config.publicUrl).origin] : []
    : configuredOrigins === "*" ? [] : configuredOrigins);
  const allowsOrigin = (origin: string): boolean => {
    if (configuredOrigins === "*") return true;
    if (!isExactOrigin(origin)) return false;
    if (origins.has(origin)) return true;
    if (configuredOrigins !== undefined) return false;
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  };
  const rejectOrigin = (request: Request): Response | null => {
    const path = new URL(request.url).pathname;
    if (path !== "/mcp" && !path.startsWith("/mcp/")) return null;
    const origin = request.headers.get("Origin");
    if (origin === null || allowsOrigin(origin)) return null;
    return withMcpCors(mcpRefusal(sentSecretsForRequest(request), 403, -33005, "MCP access is forbidden."), request, null);
  };
  let lastAdmissionWarningAt = 0;
  let suppressedAdmissionWarnings = 0;
  const warnAdmissionRejected = (error: ExecutorAdmissionError): void => {
    const now = Date.now();
    if (now - lastAdmissionWarningAt < 1_000) {
      suppressedAdmissionWarnings++;
      return;
    }
    opts.config.logger.warn("[connecta] MCP request admission rejected", {
      retryAfterMs: error.retryAfterMs,
      active: opts.requestAdmission.activeCount,
      queued: opts.requestAdmission.queuedCount,
      suppressedSinceLastWarning: suppressedAdmissionWarnings,
    });
    lastAdmissionWarningAt = now;
    suppressedAdmissionWarnings = 0;
  };


  function routeMcp(
    context: RouteContext,
  ): Effect.Effect<Response | null, unknown> {
    const {
      path,
      request,
      baseUrl,
      runtimeContext,
    } = context;
    if (path !== "/mcp" && !path.startsWith("/mcp/")) return Effect.succeed(null);
    // Admission, refusal bodies, SDK serialization and connector work share
    // one set. Connector contexts still receive an opaque scope, never the
    // inbound Request or its headers.
    const requestScope = {};
    const sentSecrets = sentSecretsForRequest(requestScope, sentSecretsForRequest(request));
    const poolName = path === "/mcp" ? undefined : path.slice("/mcp/".length);
    const origin = request.headers.get("Origin");
    const allowed = origin === null || allowsOrigin(origin);
    const cors = (response: Response): Response => withMcpCors(
      response, request, configuredOrigins === "*" ? "*" : allowed ? origin : null,
    );
    // DNS-rebinding refusals cost neither a permit nor an auth lookup. This
    // local header check also guards OPTIONS before any provider metadata.
    const refusal = rejectOrigin(request);
    if (refusal) return Effect.succeed(refusal);
    if (request.method === "OPTIONS") {
      return Effect.succeed(cors(new Response(null, { status: 204 })));
    }
    // This controller belongs to this request. Its signal reaches auth and
    // every registered tool; a controller sweep never touches it.
    const localAbort = new AbortController();
    const onCallerAbort = () => localAbort.abort(request.signal.reason);
    request.signal.addEventListener("abort", onCallerAbort, { once: true });
    if (request.signal.aborted) onCallerAbort();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    return scopedToBody(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (!localAbort.signal.aborted) {
          localAbort.abort(request.signal.reason ?? new Error("MCP request ended."));
        }
        request.signal.removeEventListener("abort", onCallerAbort);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }));
      // Only a body-confirmed modern listen may skip admission. Trusting the
      // method header alone would let a legacy tools/call bypass the pool.
      const startedAt = Date.now();
      const maxDurationMs = opts.requestAdmission.maxDurationMs;
      let listen = false;
      if (request.method === "POST" && request.headers.get("Mcp-Method") === "subscriptions/listen") {
        const classify = Effect.promise(() => isModernListen(request, localAbort.signal));
        const prepared = maxDurationMs === undefined
          ? Option.some(yield* classify)
          : yield* classify.pipe(Effect.timeoutOption(Duration.millis(maxDurationMs)));
        if (Option.isNone(prepared)) {
          localAbort.abort(new Error("MCP request lifetime exceeded."));
          return cors(mcpRefusal(sentSecrets, 504, -33003, "MCP request lifetime exceeded."));
        }
        listen = prepared.value;
      }
      const admission = listen
        ? Result.succeed(undefined)
        : yield* Effect.result(admitted(opts.requestAdmission, request.signal));
      if (Result.isFailure(admission)) {
        const error = admission.failure;
        if (!(error instanceof ExecutorAdmissionError)) {
          return yield* Effect.fail(error);
        }
        if (error.code === "executor_cancelled") {
          return yield* Effect.fail(request.signal.reason ?? error);
        }
        if (error.code === "executor_overloaded") {
          warnAdmissionRejected(error);
        }
        return cors(requestAdmissionFailure(sentSecrets, error));
      }
      const remainingMs = admission.success
        ? admission.success.remainingMs()
        : maxDurationMs === undefined ? undefined : maxDurationMs - (Date.now() - startedAt);
      if (remainingMs !== undefined && remainingMs <= 0) {
        admission.success?.release();
        return cors(mcpRefusal(sentSecrets, 504, -33003, "MCP request lifetime exceeded."));
      }
      if (remainingMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          localAbort.abort(new Error("MCP request lifetime exceeded."));
        }, remainingMs);
      }
      const localRequest = new Request(request, { signal: localAbort.signal });
      if (admission.success && admission.success.waitMs > 0) {
        opts.config.logger.debug("[connecta] MCP request admitted after queue wait", {
          waitMs: admission.success.waitMs,
          active: opts.requestAdmission.activeCount,
          queued: opts.requestAdmission.queuedCount,
        });
      }
      // Promise code the fiber stops waiting on when the caller leaves. An
      // Effect `authorize` would put Effect in the /activity bundle, which
      // shares it, to save only the lookups an abandoned authorization
      // finishes on its own.
      const handled = Effect.gen(function* () {
      const authz = yield* Effect.promise(() => authorize(
        localRequest,
        baseUrl,
        opts.config.auth,
        runtimeContext,
        opts.config.identity,
      ));
      if (!authz.ok) {
        const response = authz.response;
        // Preserve the auth adapter's challenge and status. The MCP host must
        // repair its connection to connecta before any connector can be called.
        if (response.status !== 401 && response.status !== 403) return cors(response);
        const headers = new Headers(response.headers);
        headers.set("Connecta-Error-Code", "host_auth_required");
        headers.set("Connecta-Recovery", "host_connection");
        // Custom adapters may own a streaming or non-JSON response. Preserve
        // that body and its request lifetime, and carry recovery in headers.
        if (!response.headers.get("Content-Type")?.includes("application/json")) {
          return cors(new Response(response.body, { status: response.status, headers }));
        }
        headers.set("Content-Type", "application/json");
        headers.delete("Content-Length");
        void response.body?.cancel().catch(() => {});
        return cors(new Response(JSON.stringify(redactAgentOutput(sentSecrets, {
          error: {
            code: "host_auth_required",
            message: "The host is not authorized to connect to this endpoint. Sign in or update the host's connecta access token and endpoint grants.",
            retryable: false,
            recovery: "host_connection",
          },
        })), { status: response.status, headers }));
      }
      // A pool endpoint narrows the identity's own view and nothing else. An
      // undeclared name, a grant that refuses, and a grant that throws are
      // one identical 404 so a credential never enumerates the other pools;
      // the operator log is where the reason lives.
      let access: ConnectorAccess = authz;
      let trust = opts.config.trust;
      if (poolName !== undefined) {
        const pool = opts.pools?.get(poolName);
        const denialReason = !pool ? "pool_not_declared" : yield* Effect.promise(async () => {
          try {
            return (await pool.grant(authz.identity)) === true ? undefined : "pool_grant_denied" as const;
          } catch {
            return "pool_grant_threw" as const;
          }
        });
        if (!pool || denialReason !== undefined) {
          logFailure(opts.config.logger, "MCP pool request denied", failureRecord({ reason: denialReason ?? "pool_not_declared" }));
          return cors(mcpRefusal(sentSecrets, 404, -33004, "MCP endpoint not found."));
        }
        access = intersectAccess(authz, pool.access);
        trust = pool.trust;
      }
      let scopedRegistry: RegistryView;
      try {
        validateAuthPermissions(authz, opts.registry);
        scopedRegistry = opts.registry.scoped({
          connectorIds: access.connectorIds,
          ...(access.toolAccess ? { toolAccess: access.toolAccess } : {}),
          ...(access.guardedToolAccess ? { guardedToolAccess: access.guardedToolAccess } : {}),
          ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}),
          ...(authz.principalKey ? { principalKey: authz.principalKey } : {}),
          endpoint: new URL(request.url).pathname,
          origin: request.headers.get("Origin"),
          currentResultAccess: async (address, classification, signal) => {
            signal?.throwIfAborted();
            const current = await authorize(localRequest, baseUrl, opts.config.auth, runtimeContext, opts.config.identity);
            if (!current.ok) {
              await current.response.body?.cancel().catch(() => {});
              return false;
            }
            if (current.subjectKey !== authz.subjectKey || current.principalKey !== authz.principalKey) return false;
            validateAuthPermissions(current, opts.registry);
            let currentAccess: ConnectorAccess = current;
            let currentTrust = opts.config.trust;
            if (poolName !== undefined) {
              const pool = opts.pools.get(poolName);
              if (!pool || await pool.grant(current.identity) !== true) return false;
              currentAccess = intersectAccess(current, pool.access);
              currentTrust = pool.trust;
            }
            const view = opts.registry.scoped({
              ...currentAccess,
              ...(current.subjectKey ? { subjectKey: current.subjectKey } : {}),
              ...(current.principalKey ? { principalKey: current.principalKey } : {}),
            });
            const resolved = view.resolveAddress(address);
            if (!resolved) return false;
            const requestScope = {};
            try {
              const tool = (await view.getTools(resolved.connector.id, baseUrl, requestScope, signal ? { signal } : {}))
                .find(tool => tool.name === resolved.toolName);
              signal?.throwIfAborted();
              return Boolean(tool && ((classification === "read" && tool.classification === "read") || currentTrust === "trusted"));
            } finally {
              await closeConnectorScope(resolved.connector, view.contextFor(resolved.connector.id, baseUrl, requestScope),
                runtimeContext?.waitUntil?.bind(runtimeContext));
            }
          },
          caller: {
            identity: authz.identity,
            // `authorize` admits an open deployment's every request as the
            // anonymous actor; only a provider's `ok` is an authentication.
            authenticated: opts.config.auth.length > 0,
            ...(poolName !== undefined ? { pool: poolName } : {}),
          },
        });
      } catch {
        return cors(mcpRefusal(sentSecrets, 403, -33005, "MCP access is forbidden."));
      }
      if (new URL(request.url).searchParams.has("toolkit")) {
        return cors(toolkitRetired(opts.config.logger, sentSecrets));
      }
      return cors(yield* serveMcp(
        localRequest,
        localAbort.signal,
        requestScope,
        opts,
        baseUrl,
        authz.actor,
        scopedRegistry,
        id => { const connector = scopedRegistry.getConnector(id); return Boolean(connector && mayManageConnector(authz, connector)); },
        authz.principalKey,
        runtimeContext,
        trust,
        poolName,
        authz.identity.principal ? { kind: authz.actor.kind, id: authz.identity.principal.id, namespace: authz.identity.principal.namespace } : undefined,
      ));
      });
      if (remainingMs === undefined) return yield* handled;
      const bounded = yield* handled.pipe(
        Effect.timeoutOption(Duration.millis(remainingMs)),
      );
      if (Option.isNone(bounded)) localAbort.abort(new Error("MCP request lifetime exceeded."));
      return Option.isSome(bounded)
        ? bounded.value
        : cors(mcpRefusal(sentSecrets, 504, -33003, "MCP request lifetime exceeded."));
    }), localAbort.signal);
  }
  return { handle: routeMcp, rejectOrigin };
}
