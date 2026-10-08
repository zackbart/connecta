import type { AuthResult, InboundAuth } from "../types.js";

function identityString(
  identity: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = identity[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unauthorized(): AuthResult {
  return {
    ok: false,
    response: Response.json(
      { error: "Cloudflare Access authentication required" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="openid email"' } },
    ),
  };
}

/**
 * Trust the identity Cloudflare Access attached to this direct Worker
 * invocation. Access has already validated the browser session, Managed OAuth
 * token, or service-token headers before the Worker runs; this adapter does
 * not accept or parse a caller-supplied JWT.
 */
export function cloudflareAccessAuth(): InboundAuth {
  return {
    kind: "cloudflare-access",
    interactiveOperator: true,
    recognizesCredential: (_request, context) => Boolean(context?.access),
    activityActorNamespace: "cloudflare-access",
    uiAuth: { kind: "cloudflare-access" },

    async authorize(_request, _baseUrl, runtimeContext): Promise<AuthResult> {
      const access = runtimeContext?.access;
      if (!access || typeof access.aud !== "string" || !/^[\x21-\x7e]{1,256}$/.test(access.aud)) return unauthorized();

      let identity: Record<string, unknown> | undefined;
      try {
        identity = await access.getIdentity();
      } catch {
        return unauthorized();
      }
      // Access binds ctx.access.aud to its Worker application at the edge.
      // Service credentials can pass that edge, but connecta machines must
      // present a cta_ token to the machine provider instead.
      const forbidden = (): AuthResult => ({ ok: false, response: Response.json(
        { error: "Cloudflare Access human identity required" }, { status: 403 },
      ) });
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) return forbidden();
      const userId = identityString(identity, "user_uuid") ?? identityString(identity, "email");
      if (identity.service_token_status === true || identityString(identity, "service_token_id") || identityString(identity, "common_name")) return forbidden();

      if (!userId) {
        return {
          ok: false,
          response: Response.json(
            { error: "Cloudflare Access user identity required" },
            { status: 403 },
          ),
        };
      }
      return { ok: true, userId, subjectId: userId };
    },
  };
}
