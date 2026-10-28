import { Effect } from "effect";
import { withAuthenticationDeadline } from "../auth-admission.js";
import { validIdentityReference } from "../identity.js";
import { authorizationCredential } from "../inbound-credential.js";
import { attachFailureFacts, type AuthDenialReason } from "../operator-record.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext } from "../types.js";
import { authCall, authFlow, authInvoke, authMethod } from "./native.js";

function identityString(identity: Record<string, unknown>, field: string): string | undefined {
  const value = identity[field];
  return typeof value === "string" && validIdentityReference({ namespace: "cloudflare-access", id: value })
    ? value
    : undefined;
}

function unauthorized(reason: AuthDenialReason): AuthResult {
  return {
    ok: false,
    response: attachFailureFacts(
      Response.json(
        { error: "Cloudflare Access authentication required" },
        { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="openid email"', "Cache-Control": "no-store" } },
      ),
      { reason },
    ),
  };
}

function unavailable(
  problem: "access_context_unavailable" | "access_audience_invalid" | "identity_unavailable",
): AuthResult {
  return {
    ok: false,
    response: attachFailureFacts(
      Response.json(
        { error: "Cloudflare Access identity unavailable", problem },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
      ),
      { reason: problem === "identity_unavailable" ? "access_identity_unavailable" : problem },
    ),
  };
}

/**
 * Trust the identity Cloudflare Access attached to this direct Worker
 * invocation. Access has already validated the browser session, Managed OAuth
 * token, or service-token headers before the Worker runs; this adapter does
 * not accept or parse a caller-supplied JWT. An assertion header without
 * trusted context is only a hint that verification infrastructure is missing,
 * never evidence of an authenticated caller.
 */
export function cloudflareAccessAuth(): InboundAuth {
  return {
    kind: "cloudflare-access",
    interactiveOperator: true,
    recognizesCredential: (request, context) =>
      authorizationCredential(request).kind === "absent" &&
      (Boolean(context?.access) || request.headers.has("Cf-Access-Jwt-Assertion")),
    challenge: () => 'Bearer scope="openid email"',
    activityActorNamespace: "cloudflare-access",
    uiAuth: { kind: "cloudflare-access" },

    authorize: authMethod(function (
      request: Request,
      _baseUrl: string,
      runtimeContext: InboundAuthRuntimeContext | undefined,
    ) {
      return authFlow<AuthResult>(function* () {
        if (authorizationCredential(request).kind !== "absent")
          return unauthorized("access_authorization_header_rejected");
        const access = runtimeContext?.access;
        if (!access)
          return request.headers.has("Cf-Access-Jwt-Assertion")
            ? unavailable("access_context_unavailable")
            : unauthorized("access_context_missing");
        if (typeof access.aud !== "string" || !/^[\x21-\x7e]{1,256}$/.test(access.aud))
          return unavailable("access_audience_invalid");
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
          return unavailable("identity_unavailable");
        }
        // Access binds ctx.access.aud to its Worker application at the edge.
        // Service credentials can pass that edge, but connecta machines must
        // present a cta_ token to the machine provider instead.
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
