import {
  authorizeUiAdmin,
  isSameOrigin,
  msg,
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
  const raw = await request.text();
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
): Promise<Response | null> {
  const match =
    /^\/ui\/access-tokens(?:\/([0-9a-f-]{36}))?$/.exec(context.path);
  if (!match) return null;
  const { request, baseUrl, opts } = context;
  if (request.method === "OPTIONS") {
    return privateJson({ error: "CORS is not allowed" }, { status: 403 });
  }
  if (!opts.accessTokens) {
    return privateJson(
      { error: "access token management is not configured" },
      { status: 404 },
    );
  }
  const mutating = request.method !== "GET";
  if (mutating && !isSameOrigin(request, baseUrl)) {
    return privateJson(
      { error: "same-origin request required" },
      { status: 403 },
    );
  }
  const admin = await authorizeUiAdmin(
    request,
    baseUrl,
    opts.auth,
    "access token management",
    context.runtimeContext,
    opts.identity,
  );
  if (!admin.ok) return admin.response;

  const id = match[1];
  try {
    if (!id && request.method === "GET") {
      return privateJson({ accessTokens: await opts.accessTokens.list() });
    }
    if (!id && request.method === "POST") {
      const input = await readName(request);
      if (!input.ok) return input.response;
      return privateJson(
        await opts.accessTokens.create(
          input.name,
          admin.principal ?? admin.userId,
        ),
        { status: 201 },
      );
    }
    if (id && request.method === "PUT") {
      const input = await readName(request);
      if (!input.ok) return input.response;
      const accessToken = await opts.accessTokens.rename(id, input.name);
      return accessToken
        ? privateJson({ accessToken })
        : privateJson({ error: "unknown access token" }, { status: 404 });
    }
    if (id && request.method === "DELETE") {
      const accessToken = await opts.accessTokens.revoke(id, admin.userId);
      return accessToken
        ? privateJson({ accessToken })
        : privateJson({ error: "unknown access token" }, { status: 404 });
    }
    return privateJson({ error: "method not allowed" }, { status: 405 });
  } catch (error) {
    return privateJson({ error: msg(error) }, { status: 400 });
  }
}
