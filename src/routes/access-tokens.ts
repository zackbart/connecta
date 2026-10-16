import { AccessTokenError, type AccessTokenManager } from "../access-tokens.js";
import { authorizeUiIdentity, isSameOrigin, privateJson, type RouteContext } from "./shared.js";

/**
 * Interactive-operator lifecycle for agent tokens: list one slot per declared
 * agent, issue or rotate its token, and revoke it. Agents themselves come only
 * from code, so nothing here creates, renames, or rebinds one. The token itself
 * is deliberately never an administrator credential and cannot reach here.
 */
export async function routeAccessTokens(context: RouteContext, manager: AccessTokenManager): Promise<Response | null> {
  const match = /^\/ui\/access-tokens(?:\/([a-z0-9_-]{1,64}))?$/.exec(context.path);
  if (!match) return null;
  const { request, baseUrl, opts } = context;
  if (request.method === "OPTIONS") {
    return privateJson({ error: "CORS is not allowed" }, { status: 403 });
  }
  const mutating = request.method !== "GET";
  if (mutating && !isSameOrigin(request, baseUrl)) {
    return privateJson({ error: "same-origin request required" }, { status: 403 });
  }
  const admin = await authorizeUiIdentity(
    request,
    baseUrl,
    opts.config.auth,
    "access token management",
    context.runtimeContext,
    opts.config.identity,
  );
  if (!admin.ok) return admin.response;
  if (!admin.accessTokenManagement || !admin.identity.principal) {
    return privateJson({ error: "access token management permission required" }, { status: 403 });
  }
  const operator = `${admin.identity.principal.namespace}:${admin.identity.principal.id}`;

  const name = match[1];
  try {
    if (!name && request.method === "GET") {
      return privateJson({ agents: await manager.list() });
    }
    // The request's signal bounds each mutation: a caller that leaves before
    // the slot commit publishes nothing, and one that leaves after a rotation
    // commits has the slot revoked, since its secret cannot be delivered.
    const signal = request.signal;
    if (name && request.method === "POST") {
      return privateJson(await manager.rotate(name, operator, { signal }));
    }
    if (name && request.method === "DELETE") {
      return privateJson({ agent: await manager.revoke(name, { signal }) });
    }
    return privateJson({ error: "method not allowed" }, { status: 405 });
  } catch (error) {
    if (error instanceof AccessTokenError && error.code === "unknown_agent") {
      return privateJson({ error: "unknown agent" }, { status: 404 });
    }
    if (error instanceof AccessTokenError && error.code === "aborted") {
      return privateJson({ error: "request ended" }, { status: 499 });
    }
    if (error instanceof AccessTokenError && error.code === "outcome_unknown") {
      // A fixed, operation-specific sentence; it never carries storage text.
      return privateJson({ error: error.message }, { status: 503 });
    }
    if (error instanceof AccessTokenError && error.code === "conflict") {
      return privateJson({ error: "The agent's token changed meanwhile; reload and retry" }, { status: 409 });
    }
    return privateJson({ error: "Access token operation failed; check storage" }, { status: 400 });
  }
}
