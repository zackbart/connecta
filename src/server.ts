import { isAdmittingExecutor } from "./executor-admission.js";
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
  const { registry, auth, publicUrl } = opts;
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

    const sweepCredentials = (): void => {
      try {
        const sweep = registry.sweepCredentialHealthIfDue(baseUrl, defer);
        if (!sweep) return;
        const settled = sweep.then(
          () => {},
          (err) => {
            opts.logger.warn("[connecta] credential health sweep failed", err);
          },
        );
        if (defer) defer(settled);
        else void settled;
      } catch (err) {
        opts.logger.warn("[connecta] credential health sweep failed", err);
      }
    };

    // Internal probes may reach /health over loopback HTTP; all other routes
    // upgrade to the configured public HTTPS origin before dispatch.
    if (
      publicUrl &&
      path !== "/health" &&
      new URL(publicUrl).protocol === "https:" &&
      url.protocol === "http:"
    ) {
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
      sweepCredentials,
    };

    const route = async (): Promise<Response> => {
      // Private mutations own OPTIONS so they never inherit wildcard CORS.
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
        const codeAdmission =
          opts.executor && isAdmittingExecutor(opts.executor)
            ? opts.executor.admissionSnapshot?.()
            : undefined;
        return Response.json({
          status: "ok",
          connectors: registry.listConnectors().length,
          server: opts.serverInfo,
          admission: {
            policy: "global-fifo",
            requests: opts.requestAdmission.snapshot(),
            code: opts.executor
              ? (codeAdmission ?? { managedByExecutor: true })
              : null,
            downstreamCalls: {
              policy: "connector-partitioned-per-runtime",
              connectors: registry.callAdmissionSnapshot(),
            },
            reservedRoutes: [
              "/health",
              "/",
              "/credentials",
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

      // Connector-owned public routes are deliberately last and can never
      // shadow a built-in surface.
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
