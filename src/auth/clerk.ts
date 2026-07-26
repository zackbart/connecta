// Clerk as the OAuth 2.1 authorization server; connecta is the resource server.
// Single tenant, no tenant-tag requirement, optional gate() with ~60s identity
// caching.

import { createClerkClient } from "@clerk/backend";
import {
  resolveToolkitBinding,
  type ToolkitBindingOptions,
} from "../toolkits.js";
import type { AuthResult, InboundAuth } from "../types.js";

type ClerkClient = ReturnType<typeof createClerkClient>;

export interface ClerkAuthOptions extends ToolkitBindingOptions {
  publishableKey: string;
  secretKey: string;
  /** Public base URL of this deployment. Defaults to the request origin. */
  publicUrl?: string;
  /** Optional allow-list hook. Return false to reject an authenticated user. */
  gate?: (userId: string, clerk: ClerkClient) => boolean | Promise<boolean>;
  /** Advertised scopes in protected-resource metadata. */
  scopes?: string[];
  /** Optional hosted Account Portal sign-in URL for `/ui`. */
  signInUrl?: string;
  /** Optional hosted Account Portal sign-up URL for `/ui`. */
  signUpUrl?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-protocol-version",
};

/** Coarse bearer shape for diagnostics — never the token itself. */
function tokenShape(request: Request): string {
  const header = request.headers.get("authorization");
  if (!header) return "none";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token.startsWith("oat_")) return "oauth-opaque";
  if (token.startsWith("eyJ")) return "jwt";
  return "other";
}

/** Clerk Frontend API origin, derived from pk_(test|live)_<b64 domain>. */
function fapiUrl(publishableKey: string): string {
  const key = publishableKey.replace(/^pk_(test|live)_/, "");
  const decoded = atob(key).replace(/\$$/, "");
  return `https://${decoded}`;
}

const GATE_ALLOWED_TTL_MS = 60 * 1000;
const GATE_FORBIDDEN_TTL_MS = 30 * 1000;

/**
 * Clerk inbound auth.
 *
 * `toolkits` binds every user this provider admits to those toolkits (§16). For
 * a per-team split, configure one `clerkAuth(...)` per team — the same keys, a
 * `gate` naming that team's users, and that team's `toolkits`. The server tries
 * providers in order and the first that admits the user supplies the binding, so
 * a user one gate rejects falls through to the next.
 */
export function clerkAuth(opts: ClerkAuthOptions): InboundAuth {
  const clerk = createClerkClient({
    secretKey: opts.secretKey,
    publishableKey: opts.publishableKey,
  });
  const toolkitBinding = resolveToolkitBinding("clerkAuth", opts);
  const scopes = opts.scopes ?? ["openid", "profile", "email"];
  const gateCache = new Map<string, { allowed: boolean; exp: number }>();

  const resolveBase = (baseUrl: string) => opts.publicUrl ?? baseUrl;

  const unauthorized = (baseUrl: string, tokenPresent: boolean): Response => {
    const error = tokenPresent ? `error="invalid_token", ` : "";
    const meta = `${resolveBase(baseUrl)}/.well-known/oauth-protected-resource`;
    return new Response(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer ${error}resource_metadata="${meta}"`,
        },
      },
    );
  };

  const forbidden = (): Response =>
    new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );

  const checkGate = async (userId: string): Promise<boolean> => {
    if (!opts.gate) return true;
    const hit = gateCache.get(userId);
    if (hit && Date.now() < hit.exp) return hit.allowed;
    let allowed = false;
    try {
      allowed = await opts.gate(userId, clerk);
    } catch {
      allowed = false;
    }
    gateCache.set(userId, {
      allowed,
      exp:
        Date.now() +
        (allowed ? GATE_ALLOWED_TTL_MS : GATE_FORBIDDEN_TTL_MS),
    });
    return allowed;
  };

  return {
    kind: "clerk",
    ...(toolkitBinding ? { toolkitBinding } : {}),
    uiAuth: {
      kind: "clerk",
      publishableKey: opts.publishableKey,
      frontendApiUrl: fapiUrl(opts.publishableKey),
      ...(opts.signInUrl ? { signInUrl: opts.signInUrl } : {}),
      ...(opts.signUpUrl ? { signUpUrl: opts.signUpUrl } : {}),
    },

    async handleMetadata(request, baseUrl) {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith("/.well-known/")) return null;

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const base = resolveBase(baseUrl);
      if (
        pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return Response.json(
          {
            resource: `${base}/mcp`,
            authorization_servers: [fapiUrl(opts.publishableKey)],
            bearer_methods_supported: ["header"],
            scopes_supported: scopes,
          },
          { headers: CORS_HEADERS },
        );
      }

      if (pathname === "/.well-known/oauth-authorization-server") {
        try {
          const upstream = await fetch(
            `${fapiUrl(opts.publishableKey)}/.well-known/oauth-authorization-server`,
          );
          if (!upstream.ok) {
            return Response.json(
              { error: "upstream authorization server metadata unavailable" },
              { status: 502, headers: CORS_HEADERS },
            );
          }
          return Response.json(await upstream.json(), { headers: CORS_HEADERS });
        } catch {
          return Response.json(
            { error: "upstream authorization server metadata unavailable" },
            { status: 502, headers: CORS_HEADERS },
          );
        }
      }

      return null;
    },

    async authorize(request, baseUrl): Promise<AuthResult> {
      const tokenPresent = Boolean(request.headers.get("authorization"));
      let userId: string | undefined;
      try {
        const state = await clerk.authenticateRequest(request, {
          // MCP clients use Clerk OAuth access tokens; the browser dashboard
          // uses the signed-in operator's short-lived Clerk session token.
          // authorizedParties must NOT be passed here: OAuth access tokens may
          // be JWTs without an azp claim, and Clerk rejects azp=undefined when
          // that option is set. The sibling-subdomain pin it provided is
          // enforced below, only for session tokens that actually carry azp.
          acceptsToken: ["oauth_token", "session_token"],
        });
        const auth = state.toAuth();
        if (!auth?.isAuthenticated) {
          // Reason (not the token) in the logs: bearer rejections are
          // otherwise indistinguishable 401s in `wrangler tail`.
          const detail = state as { reason?: string; message?: string };
          console.warn(
            `[connecta] clerk rejected request: status=${state.status}` +
              ` reason=${detail.reason ?? "?"} message=${detail.message ?? ""}` +
              ` tokenShape=${tokenShape(request)}`,
          );
          return {
            ok: false,
            response: unauthorized(baseUrl, tokenPresent),
          };
        }
        // Session JWTs carry `azp` (the origin they were minted for); pin it
        // to this connecta deployment so a sibling subdomain's cookie/token
        // cannot be replayed here. OAuth access tokens may have no azp.
        const typed = auth as {
          tokenType?: string;
          sessionClaims?: { azp?: string } | null;
          userId?: string | null;
        };
        if (typed.tokenType === "session_token") {
          const azp = typed.sessionClaims?.azp;
          const origin = new URL(resolveBase(baseUrl)).origin;
          if (azp && azp !== origin) {
            console.warn(
              `[connecta] session token azp mismatch: azp=${azp} expected=${origin}`,
            );
            return {
              ok: false,
              response: unauthorized(baseUrl, tokenPresent),
            };
          }
        }
        userId = typed.userId ?? undefined;
      } catch (error) {
        console.warn(
          `[connecta] clerk authenticateRequest threw: ${
            error instanceof Error ? error.message : String(error)
          } tokenShape=${tokenShape(request)}`,
        );
        return { ok: false, response: unauthorized(baseUrl, true) };
      }
      if (!userId) {
        return { ok: false, response: unauthorized(baseUrl, true) };
      }
      if (!(await checkGate(userId))) {
        return { ok: false, response: forbidden() };
      }
      return { ok: true, userId };
    },
  };
}
