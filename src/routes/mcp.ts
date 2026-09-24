import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Effect, Exit, Result, Scope } from "effect";
import type { ActivityActor, ActivityRequestContext } from "../activity.js";
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
import { instructionsFor } from "../skills.js";
import { msg } from "../errors.js";
import { detach } from "../runtime/run.js";
import type { Logger } from "../types.js";
import {
  authorize,
  loggableValue,
  mayManageConnector,
  validateAuthPermissions,
  type RouteContext,
  type RuntimeExecutionContext,
  type ServerOptions,
} from "./shared.js";

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
    "WWW-Authenticate, Retry-After, mcp-session-id, mcp-protocol-version",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestAdmissionFailure(error: ExecutorAdmissionError): Response {
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
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        // MCP 2026-07-28 basic#error-codes forbids new allocations in the
        // legacy -32000..-32019 range. Use application codes outside the
        // JSON-RPC reserved range, avoiding retired protocol meanings.
        code: overloaded ? -31001 : -31002,
        message: overloaded
          ? "Server capacity is exhausted. Retry later."
          : "Server is shutting down.",
        data,
      },
    }),
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
    // reject. Consume both outcomes: `.finally(release)` would release the
    // permit but preserve the rejection as an unhandled promise.
    void reader.cancel(signal.reason).then(release, release);
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
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
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
function toolkitRetired(logger: Logger): Response {
  logger.warn(
    "[connecta] rejected an /mcp connection carrying ?toolkit= with 404: " +
      "toolkits were retired in issue #178 (see ethos.md) — one deployment " +
      "serves one audience. The client sees a transport-level failure and " +
      "never the reason, so remove the ?toolkit= value from its MCP endpoint " +
      "URL, or point it at the deployment for its audience.",
  );
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "This deployment does not accept ?toolkit=. Toolkits were retired " +
          "in issue #178 — remove the ?toolkit= value from the MCP endpoint " +
          "URL, or ask the operator for the deployment serving this audience.",
      },
    }),
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
  opts: ServerOptions,
  baseUrl: string,
  actor: ActivityActor,
  registry: RegistryView,
  canManageAuth: (connectorId: string) => boolean,
  runtimeContext?: RuntimeExecutionContext,
): Effect.Effect<Response, never, Scope.Scope> {
  // Every McpServer the request builds is fresh and closes with its scope.
  // The modern handler tears its own down after the exchange; the legacy
  // transport never does, and neither may stay wired to an ended request.
  const servers: McpServer[] = [];
  const createServer = (): McpServer => {
    const server = new McpServer(opts.serverInfo, {
      instructions: instructionsFor(),
      cacheHints: {
        "tools/list": {
          ttlMs: 3_600_000,
          cacheScope: "private",
        },
      },
    });
    const activity: ActivityRequestContext | undefined = opts.activity
      ? {
          sink: opts.activity,
          recordTool: opts.activityModule?.recordTool,
          actor,
          requestId: crypto.randomUUID(),
          serverInfo: opts.serverInfo,
          ...(opts.activityDeploymentId
            ? { deploymentId: opts.activityDeploymentId }
            : {}),
          ...(runtimeContext?.waitUntil
            ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
            : {}),
          logger: opts.logger,
        }
      : undefined;
    registerMetaTools(server, registry, {
      baseUrl,
      canManageAuth,
      credentialHandoffUrl: opts.ui?.credentialHandoffUrl(baseUrl),
      ...(activity ? { activity } : {}),
      ...(opts.defaultToolTimeoutMs !== undefined
        ? { defaultToolTimeoutMs: opts.defaultToolTimeoutMs }
        : {}),
      ...(opts.probeTimeoutMs !== undefined
        ? { probeTimeoutMs: opts.probeTimeoutMs }
        : {}),
      ...(opts.discoveryConcurrency !== undefined
        ? { discoveryConcurrency: opts.discoveryConcurrency }
        : {}),
      requestSignal: request.signal,
      ...(runtimeContext?.waitUntil
        ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
        : {}),
    });
    registerExecuteTool(server, registry, {
      baseUrl,
      executor: opts.executor,
      logger: opts.logger,
      ...(activity ? { activity } : {}),
      requestSignal: request.signal,
      ...(runtimeContext?.waitUntil
        ? { defer: runtimeContext.waitUntil.bind(runtimeContext) }
        : {}),
      ...(opts.discoveryConcurrency !== undefined
        ? { discoveryConcurrency: opts.discoveryConcurrency }
        : {}),
      ...(opts.probeTimeoutMs !== undefined
        ? { probeTimeoutMs: opts.probeTimeoutMs }
        : {}),
      ...(opts.maxEmittedBytes !== undefined
        ? { maxEmittedBytes: opts.maxEmittedBytes }
        : {}),
      ...(opts.maxEmittedBlocks !== undefined
        ? { maxEmittedBlocks: opts.maxEmittedBlocks }
        : {}),
      ...(opts.maxHostCalls !== undefined
        ? { maxHostCalls: opts.maxHostCalls }
        : {}),
      ...(opts.hostCallTimeoutMs !== undefined
        ? { hostCallTimeoutMs: opts.hostCallTimeoutMs }
        : {}),
      ...(opts.watchdogMs !== undefined
        ? { watchdogMs: opts.watchdogMs }
        : {}),
    });
    servers.push(server);
    return server;
  };

  const exchange = async (): Promise<Response> => {
    // The v2 entry's built-in legacy fallback streams 2025 results as SSE.
    // Connecta's established wire contract is JSON, so retain the documented
    // user-land legacy branch with the same transport setting while the modern
    // branch uses the fetch-native handler.
    if (!(await isLegacyRequest(request))) {
      return createMcpHandler(createServer, {
        legacy: "reject",
        onerror: (error) => opts.logger.error("[connecta] MCP handler error", error),
      }).fetch(request);
    }

    // Fresh server + transport per legacy request, stateless and JSON-shaped.
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  return Effect.addFinalizer(() => Effect.sync(() => {
    for (const server of servers) void server.close().catch(() => {});
  })).pipe(Effect.andThen(Effect.promise(exchange)));
}

export function createMcpRoute(
  opts: ServerOptions,
): {
  handle(context: RouteContext): Effect.Effect<Response | null, unknown>;
  rejectOrigin(request: Request): Response | null;
} {
  const configuredOrigins = opts.allowedOrigins;
  const isExactOrigin = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  };
  if (
    configuredOrigins !== undefined && configuredOrigins !== "*" &&
    (!Array.isArray(configuredOrigins) || !configuredOrigins.every(isExactOrigin))
  ) {
    throw new TypeError('ConnectaConfig.allowedOrigins must be an array of exact HTTP(S) origins or "*".');
  }
  const origins = new Set(configuredOrigins === undefined
    ? opts.publicUrl ? [new URL(opts.publicUrl).origin] : []
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
    return withMcpCors(new Response('{"error":"origin not allowed"}', {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }), request, null);
  };
  let lastAdmissionWarningAt = 0;
  let suppressedAdmissionWarnings = 0;
  const warnAdmissionRejected = (error: ExecutorAdmissionError): void => {
    const now = Date.now();
    if (now - lastAdmissionWarningAt < 1_000) {
      suppressedAdmissionWarnings++;
      return;
    }
    opts.logger.warn("[connecta] MCP request admission rejected", {
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
    return scopedToBody(Effect.gen(function* () {
      const admission = yield* Effect.result(
        admitted(opts.requestAdmission, request.signal),
      );
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
        return cors(requestAdmissionFailure(error));
      }
      if (admission.success.waitMs > 0) {
        opts.logger.debug("[connecta] MCP request admitted after queue wait", {
          waitMs: admission.success.waitMs,
          active: opts.requestAdmission.activeCount,
          queued: opts.requestAdmission.queuedCount,
        });
      }
      // Promise code the fiber stops waiting on when the caller leaves. An
      // Effect `authorize` would put Effect in the /activity bundle, which
      // shares it, to save only the lookups an abandoned authorization
      // finishes on its own.
      const authz = yield* Effect.promise(() => authorize(
        request,
        baseUrl,
        opts.auth,
        runtimeContext,
        opts.identity,
      ));
      if (!authz.ok) return cors(authz.response);
      // A pool endpoint narrows the identity's own view and nothing else. An
      // undeclared name, a grant that refuses, and a grant that throws are
      // one identical 404 so a credential never enumerates the other pools;
      // the operator log is where the reason lives.
      let access: ConnectorAccess = authz;
      if (poolName !== undefined) {
        const pool = opts.pools?.get(poolName);
        const reason = !pool ? "undeclared" : yield* Effect.promise(async () => {
          try {
            return (await pool.grant(authz.identity)) === true ? "granted" : "refused";
          } catch {
            return "grant threw";
          }
        });
        if (!pool || reason !== "granted") {
          opts.logger.warn(
            `[connecta] refused /mcp/${poolName} with 404: pool ${reason}` +
              (authz.actor.id ? ` for ${loggableValue(authz.actor.id)}` : ""),
          );
          return cors(new Response("Not Found", { status: 404 }));
        }
        access = intersectAccess(authz, pool.access);
      }
      let scopedRegistry: RegistryView;
      try {
        validateAuthPermissions(authz, opts.registry);
        scopedRegistry = opts.registry.scoped({
          connectorIds: access.connectorIds,
          ...(access.toolAccess ? { toolAccess: access.toolAccess } : {}),
          ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}),
          ...(authz.principalKey ? { principalKey: authz.principalKey } : {}),
        });
      } catch (error) {
        return cors(
          new Response(JSON.stringify({ error: msg(error) }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (new URL(request.url).searchParams.has("toolkit")) {
        return cors(toolkitRetired(opts.logger));
      }
      return cors(yield* serveMcp(
        request,
        opts,
        baseUrl,
        authz.actor,
        scopedRegistry,
        id => { const connector = scopedRegistry.getConnector(id); return Boolean(connector && mayManageConnector(authz, connector)); },
        runtimeContext,
      ));
    }), request.signal);
  }
  return { handle: routeMcp, rejectOrigin };
}
