import { Effect } from "effect";
import { notFoundResponse } from "./branding.js";
import { aggregateCallAdmissionSnapshots } from "./call-admission.js";
import { isAdmittingExecutor } from "./executor-admission.js";
import { createMcpRoute, MCP_CORS_HEADERS } from "./routes/mcp.js";
import {
  routeOAuthCallback,
} from "./routes/oauth.js";
import { routeOAuthClientMetadata } from "./routes/oauth-client-metadata.js";
import { routeConnect } from "./routes/connect.js";
import { runEdge } from "./runtime/run.js";
import {
  authMetadata,
  withSecurityHeaders,
  type RouteContext,
  type RuntimeExecutionContext,
  type ServerOptions,
} from "./routes/shared.js";

export type { ServerOptions } from "./routes/shared.js";

/**
 * Build the Web-standard fetch handler.
 *
 * Route ordering is the contract: private mutation routes precede wildcard
 * OPTIONS, and the security wrapper is applied to every response, including 404s.
 *
 * Each request is one fiber tied to `request.signal`: when its caller leaves,
 * the request stops waiting on whatever it was waiting on, and what it holds
 * is released (routes/mcp.ts). It runs on no Connecta runtime, because
 * `/health` and a closed deployment's 503 must keep answering after
 * `close()` has disposed that runtime.
 */
export function createFetchHandler(
  opts: ServerOptions,
): (
  request: Request,
  runtimeContext?: RuntimeExecutionContext,
) => Promise<Response> {
  const { registry } = opts;
  const { auth, publicUrl } = opts.config;
  const routeMcp = createMcpRoute(opts);

  const metadata = (request: Request, baseUrl: string): Effect.Effect<Response | null> =>
    Effect.promise(async () => (await authMetadata(request, baseUrl, auth))?.response ?? null);

  const health = async (): Promise<Response> => {
    // The executor is required, so code admission always has a shape to
    // report: either the executor's own pool or the fallback controller
    // wrapped around it at construction.
    const codeAdmission = isAdmittingExecutor(opts.executor)
      ? opts.executor.admissionSnapshot?.()
      : undefined;
    return Response.json({
      status: "ok",
      connectors: registry.listConnectors().length,
      server: opts.config.serverInfo,
      // Which sandbox, not how it is tuned: `connecta doctor` reports the
      // executor it just exercised rather than assuming one, and a
      // deployment whose executor identifies as nothing omits the key
      // instead of inviting a guess (#368).
      ...(opts.executorName !== undefined
        ? { executor: { name: opts.executorName } }
        : {}),
      admission: {
        policy: "global-fifo",
        requests: opts.requestAdmission.snapshot(),
        code: codeAdmission ?? { managedByExecutor: true },
        downstreamCalls: {
          policy: "connector-partitioned-per-runtime",
          aggregate: aggregateCallAdmissionSnapshots(
            Object.values(registry.callAdmissionSnapshot()),
          ),
        },
        reservedRoutes: [
          "/health",
          ...(opts.config.ui?.reservedPaths ?? []),
          ...(opts.config.ui && opts.config.activity?.store.list ? ["/activity"] : []),
          ...(opts.config.ui && opts.config.accessTokens ? ["/tokens"] : []),
        ],
      },
      ...(opts.config.deploymentInfo ? { deployment: opts.config.deploymentInfo } : {}),
    });
  };

  const route = (context: RouteContext): Effect.Effect<Response, unknown> =>
    Effect.gen(function* () {
      const { request, path, baseUrl } = context;
      const clientMetadata = routeOAuthClientMetadata(context);
      if (clientMetadata) return clientMetadata;

      // Private mutations own OPTIONS so they never inherit wildcard CORS.
      const ui = opts.config.ui;
      if (ui) {
        const uiResponse = yield* Effect.promise(() => ui.handle(context));
        if (uiResponse) return uiResponse;
      }

      const connect = yield* routeConnect(context);
      if (connect) return connect;

      const oauthCallback = yield* routeOAuthCallback(context);
      if (oauthCallback) return oauthCallback;

      if (request.method === "OPTIONS") {
        const preflight = yield* routeMcp.handle(context);
        if (preflight) return preflight;
        const response = yield* metadata(request, baseUrl);
        if (response) return response;
        return new Response(null, {
          status: 204,
          headers: MCP_CORS_HEADERS,
        });
      }

      if (path.startsWith("/.well-known/")) {
        const response = yield* metadata(request, baseUrl);
        if (response) return response;
        return notFoundResponse(request, opts.config);
      }

      if (path === "/health") return yield* Effect.promise(health);

      const mcp = yield* routeMcp.handle(context);
      if (mcp) return mcp;

      return notFoundResponse(request, opts.config);
    });

  const serve = (
    request: Request,
    runtimeContext: RuntimeExecutionContext | undefined,
  ): Effect.Effect<Response, unknown> =>
    Effect.suspend(() => {
      const url = new URL(request.url);
      const baseUrl = publicUrl ?? url.origin;
      const path = url.pathname;
      const defer = runtimeContext
        ? runtimeContext.waitUntil.bind(runtimeContext)
        : undefined;

      const originRefusal = routeMcp.rejectOrigin(request);
      if (originRefusal) {
        return Effect.succeed(withSecurityHeaders(originRefusal, url, path));
      }

      // Container and orchestrator probes reach /health over plain HTTP on
      // loopback, where no proxy has set X-Forwarded-Proto. Redirecting them to
      // the public origin would make an internal liveness check depend on
      // external DNS, TLS, and the tunnel in front of connecta — so /health is
      // exempt. It is unauthenticated, returns no user data, and sets no
      // cookies, so forcing HTTPS on it protects nothing.
      if (
        publicUrl &&
        path !== "/health" &&
        new URL(publicUrl).protocol === "https:" &&
        url.protocol === "http:"
      ) {
        // Assign the path and query onto the configured URL instead of resolving
        // attacker-controlled text against it. A pathname beginning with `//`
        // (including a backslash form normalized by URL parsing) is an authority
        // when passed to `new URL(value, base)` and would otherwise replace the
        // deployment host. `/ui` is canonicalized while upgrading it so an old
        // bookmark reaches the new Connections entry point in one permanent
        // redirect.
        const target = new URL(publicUrl);
        target.pathname = path === "/ui" ? "/" : url.pathname;
        target.search = url.search;
        target.hash = "";
        return Effect.succeed(withSecurityHeaders(
          new Response(null, {
            status: 308,
            headers: { Location: target.toString() },
          }),
          url,
          path,
        ));
      }

      const context: RouteContext = {
        request,
        url,
        path,
        baseUrl,
        opts,
        defer,
        runtimeContext,
      };
      return Effect.map(route(context), (response) =>
        withSecurityHeaders(response, url, path),
      );
    });

  return function fetch(
    request: Request,
    runtimeContext?: RuntimeExecutionContext,
  ): Promise<Response> {
    return runEdge(serve(request, runtimeContext), { signal: request.signal });
  };
}
