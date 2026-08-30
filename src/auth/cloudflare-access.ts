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
      { status: 401 },
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
    activityActorNamespace: "cloudflare-access",
    uiAuth: { kind: "cloudflare-access" },

    async authorize(_request, _baseUrl, runtimeContext): Promise<AuthResult> {
      const access = runtimeContext?.access;
      if (!access) return unauthorized();

      let identity: Record<string, unknown> | undefined;
      try {
        identity = await access.getIdentity();
      } catch {
        return unauthorized();
      }
      if (!identity) return unauthorized();

      const userId = identityString(identity, "user_uuid") ??
        identityString(identity, "email");
      const commonName = identityString(identity, "common_name");
      const serviceTokenId = identityString(identity, "service_token_id");
      if (
        identity.service_token_status === true ||
        serviceTokenId ||
        (!userId && commonName)
      ) {
        const subjectId = serviceTokenId ?? commonName;
        return subjectId
          ? { ok: true, subjectId }
          : {
              ok: false,
              response: Response.json(
                { error: "Cloudflare Access service identity required" },
                { status: 403 },
              ),
            };
      }

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
