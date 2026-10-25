// Compatibility candidate only. Never imported by production or published.
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { notFoundResponse } from "../../../src/branding.js";
import { isAgentPath } from "../../../src/routes/agent-path.js";
import { MCP_CORS_HEADERS } from "../../../src/routes/mcp.js";
import { routeOAuthCallback } from "../../../src/routes/oauth.js";
import { routeOAuthClientMetadata } from "../../../src/routes/oauth-client-metadata.js";
import { routeConnect } from "../../../src/routes/connect.js";
import type { RouteContext } from "../../../src/routes/shared.js";

class Unowned {
  readonly _tag = "ProofUnowned";
}

/**
 * One optional module, one matcher, no runtime and no body conversion. Keep
 * raw ownership checks inside modules: router matching is not authorization.
 * Use wildcard methods so each module retains its established HEAD/405/Allow.
 */
export function matchModule(
  context: RouteContext,
  paths: ReadonlyArray<HttpRouter.PathInput>,
  handle: Effect.Effect<Response | null, unknown>,
): Effect.Effect<Response | null, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      let entered = false;
      const handler = Effect.suspend(() => {
        entered = true;
        return Effect.flatMap(handle, (response) =>
        response === null ? Effect.fail(new Unowned()) : Effect.succeed(HttpServerResponse.raw(response)),
        );
      });
      const app = Layer.effectDiscard(Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        for (const path of paths) yield* router.add("*", path, handler);
      }));
      const route = yield* HttpRouter.toHttpEffect(app).pipe(Effect.provideService(HttpRouter.RouterConfig, {
        ignoreDuplicateSlashes: false,
        ignoreTrailingSlash: false,
        caseSensitive: true,
      }));
      return yield* route.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(context.request)),
        Effect.map((response) => HttpServerResponse.toWeb(response)),
        Effect.catch((error) => {
          if (error instanceof Unowned) return Effect.succeed(null);
          if (!entered && HttpServerError.isHttpServerError(error) && error.reason instanceof HttpServerError.RouteNotFound) return Effect.succeed(null);
          return Effect.fail(error);
        }),
      );
    }),
  );
}

/** Existing programs and response ownership, matched through public HttpRouter. */
export function routeWithHttpRouter(
  context: RouteContext,
  mcp: (context: RouteContext) => Effect.Effect<Response | null, unknown>,
  metadata: (request: Request, baseUrl: string) => Effect.Effect<Response | null>,
  health: () => Promise<Response>,
): Effect.Effect<Response, unknown> {
  return Effect.gen(function* () {
    const { request, path, baseUrl, opts } = context;
    const missing = () => notFoundResponse(request, opts.config);
    // Access bypass equivalence deliberately precedes every router matcher.
    if (isAgentPath(path)) return (yield* mcp(context)) ?? missing();
    const client = yield* matchModule(context, ["/oauth/client-metadata/*"], Effect.sync(() => routeOAuthClientMetadata(context)));
    if (client) return client;
    // An optional module owns its paths. A wildcard preserves its null fallthrough
    // without importing the optional implementation into the root graph.
    if (opts.config.ui) {
      const ui = yield* matchModule(context, ["*"], Effect.promise(() => opts.config.ui!.handle(context)));
      if (ui) return ui;
    }
    const connect = yield* matchModule(context, ["/connect/*"], routeConnect(context));
    if (connect) return connect;
    const callback = yield* matchModule(context, ["/oauth/callback/*"], routeOAuthCallback(context));
    if (callback) return callback;
    if (request.method === "OPTIONS") {
      return (yield* mcp(context)) ?? (yield* metadata(request, baseUrl)) ?? new Response(null, {
        status: 204, headers: MCP_CORS_HEADERS,
      });
    }
    const known = yield* matchModule(context, ["/.well-known/*"], Effect.gen(function* () {
      return (yield* mcp(context)) ?? (yield* metadata(request, baseUrl)) ?? missing();
    }));
    if (known) return known;
    // FindMyWay decodes unreserved escapes even with strict slash/case config.
    // Keep byte-exact ownership for every exact route (observed /%68ealth).
    const live = yield* matchModule(context, ["/health"], Effect.suspend(() => path === "/health" ? Effect.promise(health) : Effect.succeed(null)));
    if (live) return live;
    return (yield* mcp(context)) ?? missing();
  });
}
