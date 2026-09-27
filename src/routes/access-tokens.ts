import type { AccessTokenManager } from "../access-tokens.js";
import {
  authorizeUiIdentity,
  isSameOrigin,
  privateJson,
  type RouteContext,
} from "./shared.js";

async function readName(
  request: Request,
): Promise<
  { ok: true; name: unknown } | { ok: false; response: Response }
> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return {
      ok: false,
      response: privateJson(
        { error: "Content-Type must be application/json" },
        { status: 415 },
      ),
    };
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000) {
          reader.cancel().catch(() => {});
          return { ok: false, response: privateJson({ error: "request body is too large" }, { status: 413 }) };
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  if (raw.length > 1_000) {
    return {
      ok: false,
      response: privateJson(
        { error: "request body is too large" },
        { status: 413 },
      ),
    };
  }
  try {
    const body = JSON.parse(raw) as { name?: unknown };
    return { ok: true, name: body.name };
  } catch {
    return {
      ok: false,
      response: privateJson({ error: "invalid JSON body" }, { status: 400 }),
    };
  }
}

/**
 * Interactive-operator lifecycle for deployment access tokens. The token itself
 * is deliberately never an administrator credential and cannot reach here.
 */
export async function routeAccessTokens(
  context: RouteContext,
  manager: AccessTokenManager,
): Promise<Response | null> {
  const match =
    /^\/ui\/access-tokens(?:\/([0-9a-f-]{36}))?$/.exec(context.path);
  if (!match) return null;
  const { request, baseUrl, opts } = context;
  if (request.method === "OPTIONS") {
    return privateJson({ error: "CORS is not allowed" }, { status: 403 });
  }
  const mutating = request.method !== "GET";
  if (mutating && !isSameOrigin(request, baseUrl)) {
    return privateJson(
      { error: "same-origin request required" },
      { status: 403 },
    );
  }
  const admin = await authorizeUiIdentity(
    request,
    baseUrl,
    opts.auth,
    "access token management",
    context.runtimeContext,
    opts.identity,
  );
  if (!admin.ok) return admin.response;
  if (!admin.accessTokenManagement || !admin.identity.principal) {
    return privateJson({ error: "access token management permission required" }, { status: 403 });
  }

  const id = match[1];
  try {
    if (!id && request.method === "GET") {
      return privateJson({ accessTokens: await manager.list() });
    }
    if (!id && request.method === "POST") {
      const input = await readName(request);
      if (!input.ok) return input.response;
      return privateJson(
        await manager.create(
          input.name,
          admin.identity.principal,
        ),
        { status: 201 },
      );
    }
    if (id && request.method === "PUT") {
      const input = await readName(request);
      if (!input.ok) return input.response;
      const accessToken = await manager.rename(id, input.name);
      return accessToken
        ? privateJson({ accessToken })
        : privateJson({ error: "unknown access token" }, { status: 404 });
    }
    if (id && request.method === "DELETE") {
      const accessToken = await manager.revoke(id, `${admin.identity.principal.namespace}:${admin.identity.principal.id}`);
      return accessToken
        ? privateJson({ accessToken })
        : privateJson({ error: "unknown access token" }, { status: 404 });
    }
    return privateJson({ error: "method not allowed" }, { status: 405 });
  } catch {
    return privateJson({ error: "Access token operation failed; check the name, capacity, and storage" }, { status: 400 });
  }
}
