import { Effect } from "effect";
import { withAuthenticationDeadline } from "../auth-admission.js";
import { validIdentityReference } from "../identity.js";
import { authorizationCredential } from "../inbound-credential.js";
import { attachFailureFacts, type AuthDenialReason } from "../operator-record.js";
import type { AuthResult, InboundAuth, InboundAuthRuntimeContext } from "../types.js";
import { authCall, authFlow, authMethod } from "./native.js";
import { decodeJwt, jwksKeys, rs256Header, validJwtTime, verifyRs256 } from "./rs256-jwt.js";

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
  reason: AuthDenialReason = problem === "identity_unavailable" ? "access_identity_unavailable" : problem,
  identityLookup?: {
    outcome: "timeout" | "rejected" | "cancelled";
    durationMs: number;
    cold: boolean;
    inFlight: number;
  },
): AuthResult {
  return {
    ok: false,
    response: attachFailureFacts(
      Response.json(
        { error: "Cloudflare Access identity unavailable", problem },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
      ),
      { reason, ...(identityLookup ? { identityLookup } : {}) },
    ),
  };
}

// Access service credentials can pass the edge, but connecta machines must
// present a cta_ token to the machine provider instead.
function forbidden(error = "Cloudflare Access human identity required"): AuthResult {
  return {
    ok: false,
    response: Response.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } }),
  };
}

/** One human from `getIdentity()` (`user_uuid`) or a verified assertion (`sub`), `email` as fallback. */
function human(identity: unknown, id: "user_uuid" | "sub"): AuthResult {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return forbidden();
  const fields = identity as Record<string, unknown>;
  if (
    fields.service_token_status === true ||
    identityString(fields, "service_token_id") ||
    identityString(fields, "common_name") ||
    // A service token's assertion names its client in `common_name` and has an empty `sub`.
    (id === "sub" && (fields.common_name !== undefined || fields.sub === ""))
  )
    return forbidden();
  const userId = identityString(fields, id) ?? identityString(fields, "email");
  if (!userId) return forbidden("Cloudflare Access user identity required");
  return { ok: true, userId, subjectId: userId };
}

/** Optional verification of Access's own assertion when Cloudflare omits `ctx.access`. */
export interface CloudflareAccessOptions {
  /**
   * The team domain (`<team>.cloudflareaccess.com`, with or without
   * `https://`) and the Worker-level Access application's AUD tag. Without
   * it, a request whose assertion arrives without `ctx.access` gets a
   * retryable 503.
   */
  assertion?: { teamDomain: string; audience: string };
}

const OPTIONS_ERROR =
  "cloudflareAccessAuth: `assertion` needs exactly `teamDomain` (<team>.cloudflareaccess.com) and `audience` (the Access application's AUD tag)";

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertionSettings(options: unknown): { issuer: string; audience: string } | undefined {
  if (options === undefined) return undefined;
  if (!plain(options) || Object.keys(options).some((key) => key !== "assertion"))
    throw new TypeError("cloudflareAccessAuth: the only option is `assertion`");
  const assertion = options.assertion;
  if (assertion === undefined) return undefined;
  if (!plain(assertion) || Object.keys(assertion).sort().join() !== "audience,teamDomain")
    throw new TypeError(OPTIONS_ERROR);
  const { teamDomain, audience } = assertion;
  const team =
    typeof teamDomain === "string"
      ? /^(?:https:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cloudflareaccess\.com\/?$/i.exec(teamDomain)?.[1]
      : undefined;
  if (!team || typeof audience !== "string" || !/^[\x21-\x7e]{1,256}$/.test(audience))
    throw new TypeError(OPTIONS_ERROR);
  return { issuer: `https://${team.toLowerCase()}.cloudflareaccess.com`, audience };
}

let lookups = 0;
let isolateCold = true;
const lookupSettled = () => {
  lookups--;
};
// getIdentity() is a JS RPC call to Access's binding Worker. workerd holds
// that call open until the caller disposes its result, so dispose every
// result once it settles, a late one included. Its plain identity fields stay
// readable, and a failed disposer never changes the auth outcome.
const disposeIdentity = (identity: unknown) => {
  if (typeof identity === "object" && identity !== null) {
    try {
      const dispose = Reflect.get(identity, Symbol.dispose);
      if (typeof dispose === "function") dispose.call(identity);
    } catch {
      /* The identity read does not depend on disposal. */
    }
  }
  return identity;
};
function lookupIdentity(access: NonNullable<InboundAuthRuntimeContext["access"]>) {
  lookups++;
  try {
    return Promise.resolve(access.getIdentity()).then(disposeIdentity).finally(lookupSettled);
  } catch (error) {
    lookups--;
    throw error;
  }
}

/**
 * Trust the identity Cloudflare Access attached to this direct Worker
 * invocation. Access has already validated the browser session, Managed OAuth
 * token, or service-token headers before the Worker runs. When Cloudflare
 * omits `ctx.access`, as on some fresh isolates, an unconfigured adapter
 * treats the assertion header only as a hint that verification is missing and
 * answers a retryable 503. With `assertion` configured it instead verifies
 * that header as Access's own RS256 JWT for the team and application, and any
 * failure keeps the same 503. Present context is trusted and the header is
 * never consulted.
 */
export function cloudflareAccessAuth(options?: CloudflareAccessOptions): InboundAuth {
  const settings = assertionSettings(options);
  const verifier = settings && { ...settings, keys: jwksKeys(`${settings.issuer}/cdn-cgi/access/certs`) };
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
        if (!access) {
          const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
          if (assertion === null) return unauthorized("access_context_missing");
          if (!verifier) return unavailable("access_context_unavailable");
          const { issuer, audience, keys } = verifier;
          let claims: Record<string, unknown> | undefined;
          try {
            claims = (yield authCall(withAuthenticationDeadline, [
              request,
              authMethod((signal: AbortSignal) =>
                authFlow<Record<string, unknown> | undefined>(function* () {
                  const jwt = decodeJwt(assertion);
                  const c = jwt?.claims;
                  if (
                    !jwt ||
                    !c ||
                    !rs256Header(jwt.header) ||
                    c.iss !== issuer ||
                    !(c.aud === audience || (Array.isArray(c.aud) && c.aud.length <= 16 && c.aud.includes(audience))) ||
                    c.type !== "app" ||
                    !validJwtTime(c)
                  )
                    return undefined;
                  // A key-set failure throws: unavailable, never a verdict on the caller.
                  const key = (yield authCall(keys, [jwt.header.kid, signal])) as JsonWebKey | undefined;
                  if (!key) return undefined;
                  let valid = false;
                  try {
                    valid = (yield authCall(verifyRs256, [jwt, key, signal])) as boolean;
                  } catch {
                    signal.throwIfAborted();
                  }
                  return valid && validJwtTime(c) ? c : undefined;
                }),
              ),
            ])) as Record<string, unknown> | undefined;
          } catch {
            return unavailable("access_context_unavailable", "access_keys_unavailable");
          }
          return claims ? human(claims, "sub") : unavailable("access_context_unavailable", "access_assertion_invalid");
        }
        if (typeof access.aud !== "string" || !/^[\x21-\x7e]{1,256}$/.test(access.aud))
          return unavailable("access_audience_invalid");
        let identity: Record<string, unknown> | undefined;
        const started = performance.now();
        const cold = isolateCold;
        isolateCold = false;
        let rejected = false;
        try {
          identity = (yield authCall(withAuthenticationDeadline, [
            request,
            authMethod((signal: AbortSignal) =>
              authFlow(function* () {
                for (let attempt = 0; ; attempt++) {
                  signal.throwIfAborted();
                  try {
                    return (yield authCall(lookupIdentity, [access])) as Record<string, unknown> | undefined;
                  } catch (error) {
                    if (attempt === 1) {
                      rejected = true;
                      throw error;
                    }
                  }
                  // Only a rejected identity lookup retries. A hung lookup never
                  // overlaps a second one; this sleep shares the original deadline.
                  yield Effect.sleep(100 + Math.floor(Math.random() * 151));
                }
              }),
            ),
          ])) as Record<string, unknown> | undefined;
        } catch {
          return unavailable("identity_unavailable", undefined, {
            outcome: request.signal.aborted ? "cancelled" : rejected ? "rejected" : "timeout",
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            cold,
            inFlight: lookups,
          });
        }
        // Access binds ctx.access.aud to its Worker application at the edge.
        return human(identity, "user_uuid");
      });
    }),
  };
}
