import { closeConnectorScope } from "../connector-scope.js";
import type {
  ConnectorStatus,
} from "../types.js";
import { isSafeHttpUrl } from "../ui.js";
import {
  authorizeUiIdentity,
  mayManageConnector,
  validateAuthPermissions,
  isSameOrigin,
  msg,
  privateJson,
  type RouteContext,
} from "./shared.js";

async function handleOAuthManagementRequest(
  context: RouteContext,
  connectorId: string,
): Promise<Response> {
  const { request, baseUrl, opts, defer } = context;
  if (!isSameOrigin(request, baseUrl)) {
    return privateJson(
      { error: "same-origin request required" },
      { status: 403 },
    );
  }
  const authz = await authorizeUiIdentity(
    request,
    baseUrl,
    opts.auth,
    "OAuth management",
    context.runtimeContext,
    opts.identity,
  );
  if (!authz.ok) return authz.response;
  let registry;
  try {
    validateAuthPermissions(authz, opts.registry);
    registry = opts.registry.scoped({
      connectorIds: authz.connectorIds,
      ...(authz.subjectKey ? { subjectKey: authz.subjectKey } : {}),
      ...(authz.principalKey ? { principalKey: authz.principalKey } : {}),
    });
  } catch (error) {
    return privateJson({ error: msg(error) }, { status: 403 });
  }

  const connector = registry.getConnector(connectorId);
  if (!connector?.disconnectAuth || !connector.startAuth) {
    return privateJson(
      { error: "unknown OAuth connector" },
      { status: 404 },
    );
  }
  if (!mayManageConnector(authz, connector)) return privateJson({ error: "credential management is not permitted" }, { status: 403 });
  if (connector.authScope === "personal" && !authz.principalKey) {
    return privateJson({ error: "forbidden" }, { status: 403 });
  }
  if (request.method !== "DELETE" && request.method !== "POST") {
    return privateJson({ error: "method not allowed" }, { status: 405 });
  }

  const requestScope = {};
  const ctx = registry.contextFor(connectorId, baseUrl, requestScope);
  try {
    let result: ConnectorStatus | undefined;
    let operationError: unknown;
    try {
      if (request.method === "DELETE") {
        await connector.disconnectAuth(ctx);
      } else {
        result = await connector.startAuth(ctx, { force: true });
        if (result.authorizationUrl) {
          await registry.bindOAuthHandoff(
            connectorId,
            result.authorizationUrl,
          );
        }
      }
    } catch (error) {
      operationError = error;
    }

    // The old grant and its cached catalog are invalid after either operation,
    // including a partially failed physical cleanup whose epoch fence succeeded.
    try {
      await registry.invalidateStored(connectorId);
    } catch (error) {
      operationError ??= error;
    }
    if (operationError) {
      return privateJson({ error: msg(operationError) }, { status: 400 });
    }
    if (request.method === "DELETE") {
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    const authorizationUrl = isSafeHttpUrl(result!.authorizationUrl)
      ? result!.authorizationUrl
      : undefined;
    if (result!.state === "error") {
      return privateJson(
        { error: result!.message || "OAuth authorization could not start" },
        { status: 502 },
      );
    }
    if (result!.state === "auth_required" && !authorizationUrl) {
      return privateJson(
        {
          error:
            result!.message ||
            "OAuth authorization requires consent but no safe URL is available",
        },
        { status: 502 },
      );
    }
    return privateJson({
      state: result!.state,
      ...(result!.message ? { message: result!.message } : {}),
      ...(authorizationUrl ? { authorizationUrl } : {}),
    });
  } finally {
    await closeConnectorScope(connector, ctx, defer);
  }
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
  return handleOAuthManagementRequest(context, connectorId);
}
