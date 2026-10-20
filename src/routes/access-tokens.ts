import { AccessTokenError, isSlotRevision, type AccessTokenManager } from "../access-tokens.js";
import {
  authorizeUiIdentity,
  boundedText,
  isSameOrigin,
  managesAgentTokens,
  privateJson,
  type RouteContext,
} from "./shared.js";

/** The longest body, in characters, a token mutation accepts: `{ "expect": "<revision>" }` with room to spare. */
const MAX_BODY_CHARS = 1_024;

/**
 * The slot revision a mutation names. POST takes it only as a JSON body,
 * `{ "expect": "<revision>" }`; DELETE takes that body or, for clients that
 * cannot send a body with DELETE, `?expect=<revision>`, but not both. Read
 * only after the caller is authorized.
 */
async function expectedRevision(request: Request): Promise<{ expect: string } | { status: number; error: string }> {
  const query = new URL(request.url).searchParams.getAll("expect");
  if (query.length > 0 && request.method !== "DELETE") {
    return { status: 400, error: "expect belongs in the JSON body" };
  }
  const raw = await boundedText(request, MAX_BODY_CHARS);
  if (raw === undefined) return { status: 413, error: "request body is too large" };
  let candidate: unknown;
  if (raw !== "") {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return { status: 415, error: "Content-Type must be application/json" };
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400, error: "invalid JSON body" };
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { status: 400, error: "invalid JSON body" };
    }
    if (query.length > 0) return { status: 400, error: "give expect once, in the body or the query" };
    candidate = (body as { expect?: unknown }).expect;
  } else if (query.length === 1) {
    candidate = query[0];
  }
  if (candidate === undefined) {
    return { status: 400, error: "expect is required: the slot revision from GET /ui/access-tokens" };
  }
  return isSlotRevision(candidate) ? { expect: candidate } : { status: 400, error: "expect is not a slot revision" };
}

/**
 * Interactive-operator lifecycle for agent tokens: list one slot per declared
 * agent, issue or rotate its token, and revoke it. Each mutation names the
 * slot revision it decided from, so a stale view refuses with 409
 * `slot_changed` instead of issuing over a token or rotating over someone
 * else's fresh rotation. Agents themselves come only
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
    opts.config.logger,
    context.invocation,
  );
  if (!admin.ok) return admin.response;
  // Interactive maintainers alone manage agent tokens (#837); anyone else
  // gets the same private 404 every operator route gives them.
  if (!managesAgentTokens(opts, admin) || !admin.identity.principal) {
    return privateJson({ error: "not found" }, { status: 404 });
  }
  const operator = `${admin.identity.principal.namespace}:${admin.identity.principal.id}`;

  const name = match[1];
  try {
    if (!name && request.method === "GET") {
      return privateJson({ agents: await manager.list() });
    }
    if (!name || (request.method !== "POST" && request.method !== "DELETE")) {
      return privateJson({ error: "method not allowed" }, { status: 405 });
    }
    const expected = await expectedRevision(request);
    if (!("expect" in expected)) return privateJson({ error: expected.error }, { status: expected.status });
    // The request's signal bounds each mutation: a caller that leaves before
    // the slot commit publishes nothing, and one that leaves after a rotation
    // commits has the slot revoked, since its secret cannot be delivered.
    const options = { signal: request.signal, expect: expected.expect };
    if (request.method === "POST") return privateJson(await manager.rotate(name, operator, options));
    return privateJson({ agent: await manager.revoke(name, options) });
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
    if (error instanceof AccessTokenError && error.code === "slot_changed") {
      return privateJson(
        { error: "The agent's token slot changed; reload and retry", code: "slot_changed" },
        { status: 409 },
      );
    }
    if (error instanceof AccessTokenError && error.code === "conflict") {
      return privateJson({ error: "The agent's token changed meanwhile; reload and retry" }, { status: 409 });
    }
    return privateJson({ error: "Access token operation failed; check storage" }, { status: 400 });
  }
}
