import { Effect, Result } from "effect";
import { closeScope } from "../runtime/connector-scope.js";
import type { ConnectorStatus } from "../types.js";
import { isSafeHttpUrl } from "../ui.js";
import {
  authorizedPerson,
  refuse,
  serveOperator,
  visibleRegistry,
  type Answer,
} from "./operator.js";
import {
  mayManageConnector,
  isSameOrigin,
  msg,
  privateJson,
  type RouteContext,
} from "./shared.js";

function oauthManagementRequest(
  context: RouteContext,
  connectorId: string,
): Effect.Effect<Response, Answer> {
  const { request, baseUrl, defer } = context;
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

    const ctx = registry.contextFor(connectorId, baseUrl, {});
    // The connector scope this request opened ends with it, however it ends.
    yield* Effect.addFinalizer(() => closeScope(connector, ctx, defer));

    const operation = yield* Effect.result(
      Effect.tryPromise({
        try: async (): Promise<ConnectorStatus | undefined> => {
          if (disconnecting) {
            await disconnectAuth(ctx);
            return undefined;
          }
          const started = await startAuth(ctx, { force: true });
          if (started.authorizationUrl) {
            await registry.bindOAuthHandoff(connectorId, started.authorizationUrl);
          }
          return started;
        },
        catch: (error) => error,
      }),
    );
    // The old grant and its cached catalog are invalid after either operation,
    // including a partially failed physical cleanup whose epoch fence succeeded.
    const invalidated = yield* Effect.result(
      Effect.tryPromise({
        try: () => registry.invalidateStored(connectorId),
        catch: (error) => error,
      }),
    );
    // A Result, not a caught value, decides whether it failed: a hook that
    // rejects with no reason at all still failed.
    if (Result.isFailure(operation)) return yield* refuse(msg(operation.failure), 400);
    if (Result.isFailure(invalidated)) return yield* refuse(msg(invalidated.failure), 400);

    const result = operation.success;
    if (!result) {
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    const authorizationUrl = isSafeHttpUrl(result.authorizationUrl)
      ? result.authorizationUrl
      : undefined;
    if (result.state === "error") {
      return yield* refuse(
        result.message || "OAuth authorization could not start",
        502,
      );
    }
    if (result.state === "auth_required" && !authorizationUrl) {
      return yield* refuse(
        result.message ||
          "OAuth authorization requires consent but no safe URL is available",
        502,
      );
    }
    return privateJson({
      state: result.state,
      ...(result.message ? { message: result.message } : {}),
      ...(authorizationUrl ? { authorizationUrl } : {}),
    });
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
