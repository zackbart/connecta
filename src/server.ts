import { isAdmittingExecutor } from "./executor-admission.js";
import { routeAccessTokens } from "./routes/access-tokens.js";
import { routeActivity } from "./routes/activity.js";
import { routeCredentials } from "./routes/credentials.js";
import { createMcpRoute, MCP_CORS_HEADERS } from "./routes/mcp.js";
import {
  routeOAuthCallback,
  routeOAuthManagement,
} from "./routes/oauth.js";
import {
  withSecurityHeaders,
  type RouteContext,
  type RuntimeExecutionContext,
  type ServerOptions,
} from "./routes/shared.js";
import { routeUi } from "./routes/ui.js";

export type { ServerOptions } from "./routes/shared.js";

/**
 * Build the Web-standard fetch handler.
 *
 * Route ordering is the contract: private mutation routes precede wildcard
 * OPTIONS, every built-in precedes connector-owned routes, and the security
 * wrapper is applied to every response.
 */
export function createFetchHandler(
  opts: ServerOptions,
): (
  request: Request,
  runtimeContext?: RuntimeExecutionContext,
) => Promise<Response> {
  const { auth, publicUrl, registry } = opts;
  const routeMcp = createMcpRoute(opts);

  return async function fetch(
    request: Request,
    runtimeContext?: RuntimeExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = publicUrl ?? url.origin;
    const path = url.pathname;
    const defer = runtimeContext
      ? runtimeContext.waitUntil.bind(runtimeContext)
      : undefined;

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
      return withSecurityHeaders(
        new Response(null, {
          status: 308,
          headers: { Location: target.toString() },
        }),
        url,
        path,
      );
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

    const route = async (): Promise<Response> => {
      // Private mutations own OPTIONS so they never inherit wildcard CORS.
      const accessTokens = await routeAccessTokens(context);
      if (accessTokens) return accessTokens;

      const credentials = await routeCredentials(context);
      if (credentials) return credentials;

      const oauthManagement = await routeOAuthManagement(context);
      if (oauthManagement) return oauthManagement;

      if (request.method === "OPTIONS") {
        for (const provider of auth) {
          if (provider.handleMetadata) {
            const response = await provider.handleMetadata(request, baseUrl);
            if (response) return response;
          }
        }
        return new Response(null, {
          status: 204,
          headers: MCP_CORS_HEADERS,
        });
      }

      if (path.startsWith("/.well-known/")) {
        for (const provider of auth) {
          if (provider.handleMetadata) {
            const response = await provider.handleMetadata(request, baseUrl);
            if (response) return response;
          }
        }
        return new Response("Not Found", { status: 404 });
      }

      if (path === "/health") {
        // The executor is required, so code admission always has a shape to
        // report: either the executor's own pool or the fallback controller
        // wrapped around it at construction.
        const codeAdmission = isAdmittingExecutor(opts.executor)
          ? opts.executor.admissionSnapshot?.()
          : undefined;
        return Response.json({
          status: "ok",
          connectors: registry.listConnectors().length,
          server: opts.serverInfo,
          // Which sandbox, not how it is tuned: `connecta doctor` reports the
          // executor it just exercised rather than assuming one, and a
          // deployment whose executor identifies as nothing omits the key
          // instead of inviting a guess (#368).
          ...(opts.executorName !== undefined
            ? { executor: { name: opts.executorName } }
            : {}),
          // Counts only, from refreshes that already happened — the endpoint
          // asks no downstream anything, and `connecta doctor` reads it to
          // report a stale allowlist without a probe of its own (#343).
          catalogDrift: registry.catalogDriftSnapshot(),
          admission: {
            policy: "global-fifo",
            requests: opts.requestAdmission.snapshot(),
            code: codeAdmission ?? { managedByExecutor: true },
            downstreamCalls: {
              policy: "connector-partitioned-per-runtime",
              connectors: registry.callAdmissionSnapshot(),
            },
            reservedRoutes: [
              "/health",
              "/",
              "/credentials",
              "/tokens",
              "/activity",
              "/ui",
              "/ui/*",
            ],
          },
          ...(opts.deploymentInfo ? { deployment: opts.deploymentInfo } : {}),
        });
      }

      const oauthCallback = await routeOAuthCallback(context);
      if (oauthCallback) return oauthCallback;

      const ui = await routeUi(context);
      if (ui) return ui;

      const activity = await routeActivity(context);
      if (activity) return activity;

      const mcp = await routeMcp(context);
      if (mcp) return mcp;

      // Connector-owned public routes, dispatched last: a connector can add a
      // route but never shadow one of connecta's own. A throw here is the
      // connector's bug, not a missing route, so it surfaces as 500 rather
      // than falling through to 404.
      for (const connector of registry.listConnectors()) {
        if (!connector.handleRequest) continue;
        try {
          const response = await connector.handleRequest(
            request,
            registry.contextFor(connector.id, baseUrl),
          );
          if (response) return response;
        } catch (error) {
          opts.logger.error(
            `[connecta] connector "${connector.id}" handleRequest failed`,
            error,
          );
          return new Response("Internal Server Error", { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    };

    return withSecurityHeaders(await route(), url, path);
  };
}
