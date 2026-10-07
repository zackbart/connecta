import { Effect, Result } from "effect";
import { closeScope } from "../runtime/connector-scope.js";
import { oauthConnectUrl, oauthConnectUnavailable } from "../oauth-handoff.js";
import {
  authorizedPerson,
  refuse,
  serveOperator,
  visibleRegistry,
  Answer,
} from "./operator.js";
import {
  mayManageConnector,
  isSameOrigin,
  msg,
  privateJson,
  type RouteContext,
} from "./shared.js";

/** A UI action signs its requested mode; the verified /connect visit applies it. */
function startMode(url: URL): "continue" | "restart" | null {
  const modes = url.searchParams.getAll("mode");
  if (modes.length === 0) return "restart";
  const [mode] = modes;
  return modes.length === 1 && (mode === "continue" || mode === "restart")
    ? mode
    : null;
}

function oauthManagementRequest(
  context: RouteContext,
  connectorId: string,
): Effect.Effect<Response, Answer> {
  const { request, baseUrl, defer, opts } = context;
  return Effect.gen(function* () {
    if (!isSameOrigin(request, baseUrl)) {
      return yield* refuse("same-origin request required", 403);
    }
    const authz = yield* authorizedPerson(context, "OAuth management");
    const registry = yield* visibleRegistry(context, authz);

    const connector = registry.getConnector(connectorId);
    const disconnectAuth = connector?.disconnectAuth?.bind(connector);
    const startAuth = connector?.startAuth?.bind(connector);
    if (!connector || !disconnectAuth || !startAuth) {
      return yield* refuse("unknown OAuth connector", 404);
    }
    if (!mayManageConnector(authz, connector)) {
      return yield* refuse("credential management is not permitted", 403);
    }
    if (connector.authScope === "personal" && !authz.principalKey) {
      return yield* refuse("forbidden", 403);
    }
    const disconnecting = request.method === "DELETE";
    if (!disconnecting && request.method !== "POST") {
      return yield* refuse("method not allowed", 405);
    }
    const mode = disconnecting ? undefined : startMode(context.url);
    if (mode === null) {
      return yield* refuse('mode must be "continue" or "restart"', 400);
    }

    if (!disconnecting) {
      const unavailable = oauthConnectUnavailable(opts);
      if (unavailable) return yield* refuse(unavailable, 403);
      const authorizationUrl = yield* Effect.tryPromise({
        try: () => oauthConnectUrl(opts, baseUrl, connectorId, authz.principalKey, mode === "restart"),
        catch: () => new Answer(privateJson({ error: "OAuth connection link could not be created" }, { status: 502 })),
      });
      return privateJson({ state: "auth_required", authorizationUrl });
    }

    let ctx: ReturnType<typeof registry.contextFor> | undefined;
    // The connector scope this request opened ends with it, however it ends.
    yield* Effect.addFinalizer(() =>
      ctx ? closeScope(connector, ctx, defer) : Effect.void,
    );

    // A disconnect commits through invalidation even if its hook rejects or
    // the browser leaves. It has no start deadline or request signal.
    ctx = registry.contextFor(connectorId, baseUrl);
    const operation = yield* Effect.result(Effect.tryPromise({
      try: () => disconnectAuth(ctx!), catch: error => error,
    }));
    const invalidated = yield* Effect.result(Effect.tryPromise({
      try: () => registry.invalidateStored(connectorId), catch: error => error,
    }));
    if (Result.isFailure(operation) || Result.isFailure(invalidated)) {
      const error = Result.isFailure(operation) ? operation.failure : Result.isFailure(invalidated) ? invalidated.failure : undefined;
      opts.logger.warn(`[connecta] connector "${connectorId}" OAuth disconnect failed: ${msg(error)}`);
      return yield* refuse("OAuth disconnect failed", 400);
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }).pipe(Effect.scoped);
}

export async function routeOAuthManagement(
  context: RouteContext,
): Promise<Response | null> {
  const match = /^\/ui\/oauth\/([a-z0-9_-]+)$/.exec(context.path);
  if (!match) return null;
  const connectorId = match[1];
  if (!connectorId) return null;
  if (context.request.method === "OPTIONS") {
    return privateJson({ error: "method not allowed" }, { status: 405 });
  }
  // No signal: a disconnect that has started runs through to its invalidation.
  return serveOperator(oauthManagementRequest(context, connectorId));
}
