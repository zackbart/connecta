import { Effect, Result } from "effect";
import { oauthStartReset } from "../auth/oauth-start-reset.js";
import { closeScope } from "../runtime/connector-scope.js";
import { withDeadlineEffect } from "../runtime/run.js";
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

/** Bounds the start and its handoff; invalidation and scope close finish after it. */
const OAUTH_START_TIMEOUT_MS = 30_000;

/**
 * How a POST starts authorization, from its `mode` query parameter:
 * `restart` (the default) resets the connector to a fresh epoch — wiping the
 * grant, the client registration, and discovery — before starting over;
 * `continue` hands back a recent pending authorization URL when one exists
 * and otherwise starts a flow in the current epoch, keeping the stored
 * registration. `null` is a malformed request.
 */
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

    let ctx: ReturnType<typeof registry.contextFor> | undefined;
    // The connector scope this request opened ends with it, however it ends.
    yield* Effect.addFinalizer(() =>
      ctx ? closeScope(connector, ctx, defer) : Effect.void,
    );

    const timeoutError = new Error("OAuth authorization start timed out");

    const operation = yield* Effect.result(
      withDeadlineEffect((signal) => Effect.tryPromise({
        try: async (): Promise<ConnectorStatus | undefined> => {
          ctx = registry.contextFor(connectorId, baseUrl, {}, { signal });
          if (disconnecting) {
            await disconnectAuth(ctx);
            return undefined;
          }
          const started = await startAuth(ctx, { force: mode === "restart" });
          if (signal.aborted) throw signal.reason;
          if (started.authorizationUrl) {
            await registry.bindOAuthHandoff(connectorId, started.authorizationUrl);
          }
          return started;
        },
        catch: (error) => error,
      }), {
        // A disconnect deliberately ignores both browser cancellation and
        // this start deadline so its reset reaches invalidation.
        ...(disconnecting ? {} : { timeoutMs: OAUTH_START_TIMEOUT_MS }),
        ...(disconnecting ? {} : { signal: request.signal }),
        timeoutError,
      }),
    );
    if (Result.isFailure(operation) && ctx) {
      const reset = oauthStartReset(ctx.requestScope ?? ctx);
      // Storage has no abort contract. If a reset's generation write is still
      // pending, answering now would let it publish over a newer flow.
      if (reset) yield* Effect.promise(() => reset.then(() => {}, () => {}));
    }
    // A disconnect or a restart invalidates the old grant and its cached
    // catalog, even when a partially failed physical cleanup left its epoch
    // fence standing. So does a continued start that had to begin a new flow:
    // the grant it found was missing or refused. A continued start that
    // reused a pending URL or found the connection healthy changed nothing,
    // so the catalog stays. (A continue does reset a disconnected connector,
    // but the disconnect already invalidated that catalog.)
    const started = Result.isSuccess(operation) ? operation.success : undefined;
    const reused =
      mode === "continue" && started?.authorizationReused === true;
    const unchanged =
      mode === "continue" && (reused || started?.state === "ok");
    const invalidated = unchanged
      ? Result.succeed(undefined)
      : yield* Effect.result(
          Effect.tryPromise({
            try: () => registry.invalidateStored(connectorId),
            catch: (error) => error,
          }),
        );
    // Every failure below answers in the route's own fixed words. A hook's
    // rejection and a status message can quote a token endpoint's error body
    // or a provider's refusal, either of which can quote the secret it was
    // sent, so that text goes to the deployment's log and nowhere else.
    const failed = (detail: string, fixed: string, status: number) => {
      opts.logger.warn(
        `[connecta] connector "${connectorId}" OAuth ${disconnecting ? "disconnect" : mode} failed: ${detail}`,
      );
      return refuse(fixed, status);
    };
    const couldNot = disconnecting
      ? "OAuth disconnect failed"
      : "OAuth authorization could not start";
    // A Result, not a caught value, decides whether it failed: a hook that
    // rejects with no reason at all still failed.
    if (Result.isFailure(operation)) {
      if (operation.failure === timeoutError) {
        return yield* failed(
          `start exceeded ${OAUTH_START_TIMEOUT_MS} ms`,
          "OAuth authorization start timed out",
          504,
        );
      }
      return yield* failed(msg(operation.failure), couldNot, 400);
    }
    if (Result.isFailure(invalidated)) {
      return yield* failed(
        `stored-state invalidation: ${msg(invalidated.failure)}`,
        couldNot,
        400,
      );
    }

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
      return yield* failed(
        result.message || "the connector reported an error state",
        couldNot,
        502,
      );
    }
    if (result.state === "auth_required" && !authorizationUrl) {
      return yield* failed(
        result.message || "consent is required but no safe authorization URL was returned",
        "OAuth authorization requires consent but no safe URL is available",
        502,
      );
    }
    // No message: a status message is the same text the Connections page
    // stopped shipping, and the state and the link are the whole answer.
    return privateJson({
      state: result.state,
      ...(authorizationUrl ? { authorizationUrl, reused } : {}),
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
