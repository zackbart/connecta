import { Context, Effect, Scheduler } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { notFoundResponse } from "../branding.js";
import { authorizationCredential } from "../inbound-credential.js";
import { failureRecord, logFailure } from "../operator-record.js";
import { isAgentPath } from "./agent-path.js";
import { MCP_CORS_HEADERS } from "./mcp.js";
import { routeConnect } from "./connect.js";
import { routeOAuthCallback } from "./oauth.js";
import { routeOAuthClientMetadata } from "./oauth-client-metadata.js";
import type { RouteContext } from "./shared.js";

// Only execution provides this service. Registration never sees request state.
class CurrentRoute extends Context.Service<
  CurrentRoute,
  {
    readonly context: RouteContext;
    entered: boolean;
  }
>()("connecta/CurrentRoute") {}

type Program = (context: RouteContext) => Effect.Effect<Response, unknown>;
type Dispatcher = ReturnType<HttpRouter.HttpRouter["asHttpEffect"]>;

/** Private, request-free route tables, owned by one fetch handler. */
export function createRouteDispatcher(
  mcp: (context: RouteContext) => Effect.Effect<Response | null, unknown>,
  metadata: (request: Request, baseUrl: string) => Effect.Effect<Response | null>,
  health: () => Promise<Response>,
): Program {
  let tables: { human: Dispatcher; agent: Dispatcher } | undefined;

  const missing = (context: RouteContext) => notFoundResponse(context.request, context.opts.config);
  const fallback: Program = (context) =>
    Effect.gen(function* () {
      if (context.request.method === "OPTIONS") {
        return (
          (yield* mcp(context)) ??
          (yield* metadata(context.request, context.baseUrl)) ??
          new Response(null, { status: 204, headers: MCP_CORS_HEADERS })
        );
      }
      return (yield* mcp(context)) ?? missing(context);
    });
  const afterUi =
    (program: Program): Program =>
    (context) =>
      Effect.gen(function* () {
        const ui = context.opts.config.ui;
        // The operator surface is a Promise edge that owns the request's
        // signal: when the caller leaves, its routes stop on their own. Wait
        // for it to settle rather than abandoning it, so writes it has
        // already started end inside this request (INV-7).
        const response = ui ? yield* Effect.uninterruptible(Effect.promise(() => ui.handle(context))) : null;
        if (response?.status === 401) {
          const authorizationHeader = authorizationCredential(context.request).kind;
          logFailure(
            context.opts.config.logger,
            "operator_refused",
            failureRecord(
              {
                reason: authorizationHeader === "invalid" ? "authorization_header_invalid" : "authentication_failed",
                accessContext: Boolean(context.runtimeContext?.access),
                authorizationHeader,
              },
              response,
            ),
          );
        }
        return response ?? (yield* program(context));
      });
  const optional =
    (program: (context: RouteContext) => Effect.Effect<Response | null, unknown>): Program =>
    (context) =>
      Effect.flatMap(program(context), (response) => (response ? Effect.succeed(response) : fallback(context)));
  const agentProgram: Program = (context) => Effect.map(mcp(context), (response) => response ?? missing(context));
  const wrap = (program: Program) =>
    Effect.flatMap(CurrentRoute, (current) => {
      current.entered = true;
      return Effect.map(
        Effect.suspend(() => program(current.context)),
        HttpServerResponse.raw,
      );
    });

  // make/addAll/asHttpEffect are entirely synchronous for these fixed tables.
  // Bound only their registration/publication so concurrent first edges cannot
  // yield halfway through and build duplicate tables. No callbacks or I/O here.
  const initialize = Effect.suspend(() => {
    if (tables) return Effect.succeed(tables);
    return Effect.gen(function* () {
      const human = yield* HttpRouter.make;
      const agent = yield* HttpRouter.make;
      const humanRoutes = [
        HttpRouter.route(
          "*",
          "/oauth/client-metadata/*",
          wrap((context) => {
            const response = routeOAuthClientMetadata(context);
            return response ? Effect.succeed(response) : afterUi(fallback)(context);
          }),
        ),
        HttpRouter.route("*", "/connect/*", wrap(afterUi(optional(routeConnect)))),
        HttpRouter.route("*", "/oauth/callback/*", wrap(afterUi(optional(routeOAuthCallback)))),
        HttpRouter.route(
          "*",
          "/.well-known/*",
          wrap(
            afterUi((context) => {
              if (!context.path.startsWith("/.well-known/")) return fallback(context);
              return Effect.gen(function* () {
                return (
                  (yield* mcp(context)) ??
                  (yield* metadata(context.request, context.baseUrl)) ??
                  (context.request.method === "OPTIONS"
                    ? new Response(null, { status: 204, headers: MCP_CORS_HEADERS })
                    : missing(context))
                );
              });
            }),
          ),
        ),
        HttpRouter.route(
          "*",
          "/health",
          wrap(
            afterUi((context) =>
              context.path === "/health" && context.request.method !== "OPTIONS"
                ? Effect.promise(health)
                : fallback(context),
            ),
          ),
        ),
        HttpRouter.route("*", "/mcp/*", wrap(afterUi(fallback))),
      ];
      // addAll's Request markers describe execution dependencies, not services
      // used during registration. CurrentRoute is supplied below on every call;
      // the error marker is handled by the existing edge, never by registration.
      yield* human.addAll(humanRoutes) as Effect.Effect<void>;
      yield* agent.addAll([HttpRouter.route("*", "*", wrap(agentProgram))]) as Effect.Effect<void>;
      tables = { human: human.asHttpEffect(), agent: agent.asHttpEffect() };
      return tables;
    });
  }).pipe(
    Effect.provideService(HttpRouter.RouterConfig, {
      ignoreDuplicateSlashes: false,
      ignoreTrailingSlash: false,
      caseSensitive: true,
    }),
    Effect.provideService(Scheduler.PreventSchedulerYield, true),
    Effect.uninterruptible,
  );

  return (context) =>
    Effect.gen(function* () {
      const routers = yield* initialize;
      const current = { context, entered: false };
      const agent = isAgentPath(context.path);
      // Dispatch only selects paths. Methods, body and headers belong to the
      // original request in CurrentRoute; a GET projection also covers arbitrary
      // extension methods outside FindMyWay's finite wildcard-method list.
      // Escape '%' once so the matcher cannot decode raw prefixes or reject an
      // invalid escape in an otherwise owned suffix; ';' is its query delimiter.
      const request = HttpServerRequest.fromWeb(new Request(context.url)).modify({
        url: context.path.replaceAll("%", "%25").replaceAll(";", "%3B"),
      });
      return yield* Effect.scoped(agent ? routers.agent : routers.human).pipe(
        Effect.provideService(CurrentRoute, current),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.map(HttpServerResponse.toWeb),
        Effect.catch((error) =>
          !current.entered &&
          HttpServerError.isHttpServerError(error) &&
          error.reason instanceof HttpServerError.RouteNotFound
            ? agent
              ? agentProgram(context)
              : afterUi(fallback)(context)
            : Effect.fail(error),
        ),
      );
    });
}
