import { Effect } from "effect";
import { withAuthenticationDeadline } from "../auth-admission.js";
import { validIdentityReference } from "../identity.js";
import { authorizationCredential } from "../inbound-credential.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext } from "../types.js";
import { authCall, authFlow, authInvoke, authMethod } from "./native.js";

function identityString(identity: Record<string, unknown>, field: string): string | undefined {
  const value = identity[field];
  return typeof value === "string" && validIdentityReference({ namespace: "cloudflare-access", id: value })
    ? value
    : undefined;
}

function unauthorized(): AuthResult {
  return {
    ok: false,
    response: Response.json(
      { error: "Cloudflare Access authentication required" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="openid email"', "Cache-Control": "no-store" } },
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
    recognizesCredential: (request, context) =>
      authorizationCredential(request).kind === "absent" && Boolean(context?.access),
    challenge: () => 'Bearer scope="openid email"',
    activityActorNamespace: "cloudflare-access",
    uiAuth: { kind: "cloudflare-access" },

    authorize: authMethod(function (
      request: Request,
      _baseUrl: string,
      runtimeContext: InboundAuthRuntimeContext | undefined,
    ) {
      return authFlow<AuthResult>(function* () {
        if (authorizationCredential(request).kind !== "absent") return unauthorized();
        const access = runtimeContext?.access;
        if (!access || typeof access.aud !== "string" || !/^[\x21-\x7e]{1,256}$/.test(access.aud))
          return unauthorized();
        let identity: Record<string, unknown> | undefined;
        try {
          identity = (yield authCall(withAuthenticationDeadline, [
            request,
            authMethod(() => {
              return authInvoke(access, "getIdentity", []) as Effect.Effect<
                Record<string, unknown> | undefined,
                unknown
              >;
            }),
          ])) as Record<string, unknown> | undefined;
        } catch {
          return {
            ok: false,
            response: Response.json(
              { error: "Cloudflare Access identity unavailable", problem: "identity_unavailable" },
              { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
            ),
          };
        }
        const forbidden = (): AuthResult => ({
          ok: false,
          response: Response.json(
            { error: "Cloudflare Access human identity required" },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          ),
        });
        if (!identity || typeof identity !== "object" || Array.isArray(identity)) return forbidden();
        const userId = identityString(identity, "user_uuid") ?? identityString(identity, "email");
        if (
          identity.service_token_status === true ||
          identityString(identity, "service_token_id") ||
          identityString(identity, "common_name")
        )
          return forbidden();
        if (!userId) {
          return {
            ok: false,
            response: Response.json(
              { error: "Cloudflare Access user identity required" },
              { status: 403, headers: { "Cache-Control": "no-store" } },
            ),
          };
        }
        return { ok: true, userId, subjectId: userId };
      });
    }),
  };
}
