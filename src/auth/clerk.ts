// Clerk as the OAuth 2.1 authorization server; connecta is the resource server.
// Single tenant, no tenant-tag requirement, optional allowedDomains/gate() with
// ~60s identity caching.

import { createClerkClient } from "@clerk/backend";
import { decodeJwt } from "@clerk/backend/jwt";
import { assertNoRetiredToolkitOptions } from "../retired-toolkits.js";
import type { AuthResult, InboundAuth } from "../types.js";

type ClerkClient = ReturnType<typeof createClerkClient>;
type ClerkUser = Awaited<ReturnType<ClerkClient["users"]["getUser"]>>;

export interface ClerkAuthOptions {
  publishableKey: string;
  secretKey: string;
  /** Public base URL of this deployment. Defaults to the request origin. */
  publicUrl?: string;
  /**
   * OAuth client IDs dedicated to this deployment, used only when a verified
   * access token has no audience/resource claim. Omitted or `[]` requires
   * resource-bound tokens, both JWT and opaque. Enable Clerk's
   * `aud_claim_enabled` setting and request the endpoint URL as `resource`.
   * A present audience/resource must match
   * the canonical `/mcp` or `/mcp/<pool>` URL even for an allowlisted client.
   * Never share these clients with another resource server. Pool grants still
   * narrow access; the fallback client list applies to every pool.
   */
  allowedOAuthClientIds?: readonly string[];
  /**
   * Email domains this deployment admits, e.g. `["acme.com"]`. An
   * authenticated user whose verified primary email is not on one of them is
   * rejected exactly like a `gate` rejection. Matching is exact on the whole
   * domain and case-insensitive: `acme.com` admits neither `evil-acme.com` nor
   * `mail.acme.com` — spell a subdomain out to allow it. Entries must be ASCII
   * (punycode for an internationalized domain) and are validated at
   * construction. Absent ⇒ every authenticated user passes this check, as
   * before the option existed. Governs Clerk sign-in only: a co-configured
   * `bearerToken` has no email to read and is admitted without a domain check.
   */
  allowedDomains?: readonly string[];
  /** Optional allow-list hook. Return false to reject an authenticated user. */
  gate?: (userId: string, clerk: ClerkClient) => boolean | Promise<boolean>;
  /** Advertised scopes in protected-resource metadata. */
  scopes?: string[];
  /** Optional hosted Account Portal sign-in URL for operator pages. Absolute https only. */
  signInUrl?: string;
  /** Optional hosted Account Portal sign-up URL for operator pages. Absolute https only. */
  signUpUrl?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-protocol-version",
};

/**
 * Clerk Frontend API origin, derived from pk_(test|live)_<b64 domain>.
 *
 * The key is operator config, and a key that cannot yield an origin is a
 * structural mistake: it throws here, at construction, in the same voice as the
 * `allowedDomains` checks. Left unvalidated, `atob` raises a bare
 * `InvalidCharacterError` from inside the returned object — which, on a
 * deployment that builds per request (the Workers shape), turns every route
 * including `/health` into a 500 with a stack that names base64 rather than the
 * environment variable the operator has to fix.
 *
 * The rejected value is never quoted back. A publishable key is public, but the
 * commonest way to land here is pasting the *secret* key into the publishable
 * slot, and a startup error is a log line.
 */
function fapiUrl(publishableKey: string): string {
  const shape =
    " Copy the publishable key from the Clerk dashboard: `pk_test_` or " +
    "`pk_live_` followed by the base64-encoded Frontend API domain.";
  if (typeof publishableKey !== "string" || publishableKey === "") {
    throw new Error(
      "clerkAuth: `publishableKey` is missing or not a string." + shape,
    );
  }
  const encoded = /^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/.exec(
    publishableKey,
  )?.[1];
  if (encoded === undefined) {
    throw new Error(
      "clerkAuth: `publishableKey` is not a Clerk publishable key." + shape,
    );
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error(
      "clerkAuth: `publishableKey` does not carry decodable base64." + shape,
    );
  }
  // Clerk terminates the encoded domain with `$`; everything else is the host.
  const domain = decoded.replace(/\$$/, "");
  if (!isDomain(domain)) {
    throw new Error(
      "clerkAuth: `publishableKey` does not decode to a Frontend API domain." +
        shape,
    );
  }
  return `https://${domain}`;
}

const GATE_ALLOWED_TTL_MS = 60 * 1000;
const GATE_FORBIDDEN_TTL_MS = 30 * 1000;
const ACTIVITY_LABEL_TTL_MS = 5 * 60 * 1000;
const ACTIVITY_LABEL_MISS_TTL_MS = 30 * 1000;
const ACTIVITY_LABEL_LOOKUP_TIMEOUT_MS = 1_250;
const ACTIVITY_LABEL_MAX_IN_FLIGHT = 8;
// Per clerkAuth instance. This is deliberately fixed rather than an operator
// knob: admission correctness never depends on retaining an entry, and 1,024
// keeps the common steady identity set hot without letting one-off denied
// identities define the isolate's lifetime memory footprint.
const GATE_CACHE_MAX_IDENTITIES = 1_024;
const ACTIVITY_LABEL_MAX_LENGTH = 160;

function readIdentityCache<K, V extends { exp: number }>(
  cache: Map<K, V>,
  key: K,
): V | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  if (Date.now() >= hit.exp) return undefined;
  cache.set(key, hit);
  return hit;
}

function writeIdentityCache<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= GATE_CACHE_MAX_IDENTITIES) return;
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

function cleanActivityLabel(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return Array.from(compact).slice(0, ACTIVITY_LABEL_MAX_LENGTH).join("");
}

/** Prefer a person's name, then a verified primary email, then username. */
function activityLabelForUser(user: ClerkUser): string | undefined {
  const fullName =
    user.fullName ??
    [user.firstName, user.lastName].filter(Boolean).join(" ");
  const primary = user.emailAddresses?.find(
    (address) =>
      address.id === user.primaryEmailAddressId &&
      address.verification?.status === "verified",
  );
  return (
    cleanActivityLabel(fullName) ??
    cleanActivityLabel(primary?.emailAddress) ??
    cleanActivityLabel(user.username)
  );
}

/**
 * One label of a domain: ASCII letters/digits, interior hyphens only, 63
 * characters at most. ASCII-only is deliberate — an internationalized domain
 * must be in its punycode (`xn--…`) form, so a Unicode confusable can neither be
 * typed into the allowlist nor arrive in an email address and pass for a domain
 * the operator cannot tell from theirs by eye.
 */
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Is this string a domain, before any case folding? Both sides of the
 * comparison — the operator's allowlist entries and the domain read off a
 * user's email — are checked against this one grammar, so neither side can be
 * *repaired* into a match by the normalization that follows: `"acme.com\n"` and
 * `" acme.com"` are malformed, not `acme.com`, and an `akme.com` spelled with a
 * U+212A KELVIN SIGN is rejected here rather than folded to plain ASCII `k` by
 * `toLowerCase`.
 */
function isDomain(domain: string): boolean {
  return (
    domain.length > 0 &&
    domain.length <= 253 &&
    domain.includes(".") &&
    domain.split(".").every((label) => DOMAIN_LABEL_RE.test(label))
  );
}

/**
 * Validate and lowercase `allowedDomains` at construction. Everything here
 * throws rather than dropping the entry: an allowlist that does not say what
 * its author meant is invisible until the day it admits the wrong caller.
 */
function normalizeAllowedDomains(
  value: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("clerkAuth: `allowedDomains` must be an array of domains.");
  }
  if (value.length === 0) {
    // Fail-closed, an empty list admits nobody and the deployment is dead on
    // arrival; read as "no restriction", it is the one shape here that fails
    // OPEN. Neither is what anyone meant to write.
    throw new Error(
      "clerkAuth: `allowedDomains` is empty. List at least one domain, or " +
        "drop the option to admit every authenticated user.",
    );
  }
  const domains = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `clerkAuth: \`allowedDomains\` entry ${JSON.stringify(entry)} is not a string.`,
      );
    }
    // Surrounding whitespace is the one thing forgiven, and only here: this is
    // operator config read at construction, where a stray space is a typo the
    // operator can see in the throw. Nothing is forgiven on the email side.
    const domain = entry.trim();
    if (!isDomain(domain)) {
      const hint = domain.includes("@")
        ? " Write the domain alone, with no `@` and no local part."
        : "";
      throw new Error(
        `clerkAuth: \`allowedDomains\` entry ${JSON.stringify(entry)} is not a ` +
          `domain (expected something like "acme.com").${hint}`,
      );
    }
    domains.add(domain.toLowerCase());
  }
  return domains;
}

/** No wildcard or implicit all-clients mode for unbound OAuth tokens. */
function normalizeOAuthClientIds(value: readonly string[] | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    throw new Error(
      "clerkAuth: `allowedOAuthClientIds` must be an array of OAuth client IDs. " +
        "Omit it or use [] to require resource-bound OAuth tokens.",
    );
  }
  for (const id of value) {
    if (typeof id !== "string" || !/^[\x21-\x7e]+$/.test(id) || id === "*") {
      throw new Error(
        "clerkAuth: `allowedOAuthClientIds` entries must be nonempty, " +
          "non-wildcard client IDs without whitespace.",
      );
    }
  }
  return new Set(value);
}

/** Only verified claims reach this comparison; resource URLs match exactly. */
function oauthBindingRejection(
  claims: Record<string, unknown>,
  resource: string,
  clientId: string,
  allowedClientIds: ReadonlySet<string>,
): "oauth_client_not_allowed" | "oauth_binding_mismatch" | null {
  const bindings = ["aud", "resource"].filter((key) =>
    Object.prototype.hasOwnProperty.call(claims, key),
  );
  if (bindings.length === 0) {
    return allowedClientIds.has(clientId) ? null : "oauth_client_not_allowed";
  }
  const matches = bindings.every((key) => {
    const value = claims[key];
    const audiences = Array.isArray(value) ? value : [value];
    return (
      audiences.length > 0 &&
      audiences.every((audience) => typeof audience === "string" && audience.length > 0) &&
      audiences.includes(resource)
    );
  });
  return matches ? null : "oauth_binding_mismatch";
}

/**
 * Clerk 3.12's OAuth deserializer drops `aud`. Read the same verification
 * endpoint directly after SDK authentication, without a shared response cache
 * or SDK patch. Its subject/client and active verdict must still agree.
 */
async function opaqueOAuthClaims(
  token: string,
  secretKey: string,
  userId: string | null,
  clientId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.clerk.com/v1/oauth_applications/access_tokens/verify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      "Clerk-API-Version": "2026-05-12",
    },
    body: JSON.stringify({ access_token: token }),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("Opaque OAuth verification failed");
  const claims: unknown = await response.json();
  if (
    !claims || typeof claims !== "object" || Array.isArray(claims) ||
    !("object" in claims) || claims.object !== "clerk_idp_oauth_access_token" ||
    !("subject" in claims) || claims.subject !== userId ||
    !("client_id" in claims) || claims.client_id !== clientId ||
    !("revoked" in claims) || claims.revoked !== false ||
    !("expired" in claims) || claims.expired !== false
  ) {
    throw new Error("Opaque OAuth verification response invalid");
  }
  return claims as Record<string, unknown>;
}

/**
 * Bounded, escaped form of the denied domain for the operator log — the same
 * treatment server logs give other caller-controlled values. An email domain is
 * caller-influenced (anyone who controls a mailbox controls its domain): the
 * bound is what a 253-byte domain needs, and the escaping — JSON.stringify plus
 * the hand-rolled U+2028/U+2029 pass it leaves raw — is defense in depth behind
 * `isDomain`, which has already ruled out the newline that would forge a line.
 */
function loggableDomain(domain: string): string {
  const bounded = domain.slice(0, 100);
  const escaped = JSON.stringify(bounded).replace(
    /[\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16)}`,
  );
  return escaped + (bounded.length < domain.length ? " (truncated)" : "");
}

/**
 * The domain of an email address, lowercased for comparison, or null when the
 * address does not have exactly one well-formed domain to read.
 *
 * Nothing here repairs the input. The domain is validated as it arrived and
 * only then lowercased, so `dev@ acme.com`, `dev@acme.com\n` and `dev@acme.com.`
 * are malformed addresses that DENY, rather than whitespace-trimmed or
 * dot-stripped into a match for `acme.com`. The split is on the last `@`, the
 * part a mail system routes on, so this reads the same domain that would
 * receive the mail. (Under exact set matching a first-`@` split could not fail
 * open either — it would just read a domain nobody delivers to.)
 */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1);
  return isDomain(domain) ? domain.toLowerCase() : null;
}

/**
 * Clerk inbound auth.
 *
 * `allowedDomains` and `gate` decide who is admitted; both must pass.
 */
/** `"/<pool>"` for a pool endpoint path, null for `/mcp` and anything else. */
function mcpPoolSuffix(pathname: string): string | null {
  const match = /^\/mcp(\/[a-z0-9_-]+)$/.exec(pathname);
  return match ? match[1]! : null;
}

export function clerkAuth(opts: ClerkAuthOptions): InboundAuth {
  assertNoRetiredToolkitOptions("clerkAuth", opts);
  // Before the Clerk client, so a malformed key fails as a connecta
  // configuration error rather than however the SDK happens to treat it.
  const frontendApiUrl = fapiUrl(opts.publishableKey);
  const clerk = createClerkClient({
    secretKey: opts.secretKey,
    publishableKey: opts.publishableKey,
  });
  const allowedDomains = normalizeAllowedDomains(opts.allowedDomains);
  const allowedOAuthClientIds = normalizeOAuthClientIds(opts.allowedOAuthClientIds);
  const scopes = opts.scopes ?? ["openid", "profile", "email"];
  const gateCache = new Map<string, { allowed: boolean; exp: number }>();
  const activityLabelCache = new Map<
    string,
    { label?: string; exp: number }
  >();
  const pendingActivityLabels = new Map<
    string,
    Promise<string | undefined>
  >();
  const inFlightActivityLabelIds = new Set<string>();
  let activeActivityLabelLookups = 0;

  const resolveBase = (baseUrl: string) => opts.publicUrl ?? baseUrl;

  const cacheActivityLabel = (
    userId: string,
    label: string | undefined,
  ): void => {
    writeIdentityCache(activityLabelCache, userId, {
      ...(label ? { label } : {}),
      exp:
        Date.now() +
        (label ? ACTIVITY_LABEL_TTL_MS : ACTIVITY_LABEL_MISS_TTL_MS),
    });
  };

  const resolveActivityLabel = async (
    userId: string,
  ): Promise<string | undefined> => {
    const cached = readIdentityCache(activityLabelCache, userId);
    if (cached) return cached.label;
    const existing = pendingActivityLabels.get(userId);
    if (existing) return existing;
    // The Clerk SDK's getUser call has no AbortSignal. Keep the real upstream
    // concurrency bounded even when requests hang forever: do not queue more
    // identities in memory, and do not start a duplicate for an id whose raw
    // lookup outlived its caller-facing deadline.
    if (
      inFlightActivityLabelIds.has(userId) ||
      activeActivityLabelLookups >= ACTIVITY_LABEL_MAX_IN_FLIGHT
    ) {
      cacheActivityLabel(userId, undefined);
      return undefined;
    }

    activeActivityLabelLookups++;
    inFlightActivityLabelIds.add(userId);
    const upstream = clerk.users
      .getUser(userId)
      .then((user) => {
        const label = activityLabelForUser(user);
        cacheActivityLabel(userId, label);
        return label;
      })
      .catch(() => {
        cacheActivityLabel(userId, undefined);
        return undefined;
      })
      .finally(() => {
        activeActivityLabelLookups--;
        inFlightActivityLabelIds.delete(userId);
      });
    const lookup = new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (label: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(label);
      };
      const timer = setTimeout(() => {
        cacheActivityLabel(userId, undefined);
        finish(undefined);
      }, ACTIVITY_LABEL_LOOKUP_TIMEOUT_MS);
      void upstream.then(finish);
    }).finally(() => {
      pendingActivityLabels.delete(userId);
    });
    pendingActivityLabels.set(userId, lookup);
    return lookup;
  };

  const unauthorized = (baseUrl: string, tokenPresent: boolean, request: Request): Response => {
    const error = tokenPresent ? `error="invalid_token", ` : "";
    // A pool endpoint is its own protected resource: the challenge names the
    // metadata document whose `resource` matches the URL the client used, or
    // RFC 9728 tells it to reject the mismatch.
    const pool = mcpPoolSuffix(new URL(request.url).pathname);
    const meta = `${resolveBase(baseUrl)}/.well-known/oauth-protected-resource${pool ? `/mcp${pool}` : ""}`;
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

  /**
   * The domain half of admission. Fails CLOSED on every uncertainty — no
   * primary email, an unverified one, a malformed address, or the lookup
   * itself failing — because "we could not tell" and "they belong here" must
   * not be the same answer for a membership rule.
   */
  const checkDomain = async (userId: string): Promise<boolean> => {
    if (!allowedDomains) return true;
    let email: string | undefined;
    try {
      const user = await clerk.users.getUser(userId);
      const primary = user.emailAddresses?.find(
        (address) => address.id === user.primaryEmailAddressId,
      );
      if (primary?.verification?.status === "verified") {
        email = primary.emailAddress;
      }
    } catch (error) {
      console.warn(
        `[connecta] clerk email lookup failed for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        } — denying`,
      );
      return false;
    }
    const domain = email ? emailDomain(email) : null;
    if (!domain) {
      // One line for three cases (no primary email, unverified, or an address
      // with no readable domain) because the caller must not be able to tell
      // them apart — but it must not claim the email is missing when it is
      // there and malformed.
      console.warn(
        `[connecta] clerk user ${userId} has no verified primary email with a ` +
          "well-formed domain — denying",
      );
      return false;
    }
    if (!allowedDomains.has(domain)) {
      // The domain, never the address: this is an operator log, not a place to
      // spill the local part of someone's email on every denied request.
      console.warn(
        `[connecta] clerk user ${userId} denied: email domain ` +
          `${loggableDomain(domain)} is not on allowedDomains`,
      );
      return false;
    }
    return true;
  };

  /**
   * Is this authenticated user admitted? The domain allowlist and `gate` both
   * have to say yes, and the allowlist runs first so an outsider never reaches
   * operator gate code. One cached verdict covers both, so composing them costs
   * no more Clerk calls than `gate` alone did.
   */
  const checkGate = async (userId: string): Promise<boolean> => {
    if (!opts.gate && !allowedDomains) return true;
    const hit = readIdentityCache(gateCache, userId);
    if (hit) return hit.allowed;
    let allowed = false;
    try {
      allowed =
        (await checkDomain(userId)) &&
        (opts.gate ? await opts.gate(userId, clerk) : true);
    } catch {
      allowed = false;
    }
    writeIdentityCache(gateCache, userId, {
      allowed,
      exp:
        Date.now() +
        (allowed ? GATE_ALLOWED_TTL_MS : GATE_FORBIDDEN_TTL_MS),
    });
    return allowed;
  };

  return {
    kind: "clerk",
    interactiveOperator: true,
    activityActorNamespace: frontendApiUrl,
    activityActorLabel: resolveActivityLabel,
    uiAuth: {
      kind: "clerk",
      publishableKey: opts.publishableKey,
      frontendApiUrl,
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
      const pool = pathname.startsWith("/.well-known/oauth-protected-resource/mcp/")
        ? mcpPoolSuffix(pathname.slice("/.well-known/oauth-protected-resource".length))
        : null;
      if (
        pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp" ||
        pool
      ) {
        return Response.json(
          {
            resource: `${base}/mcp${pool ?? ""}`,
            authorization_servers: [frontendApiUrl],
            bearer_methods_supported: ["header"],
            scopes_supported: scopes,
          },
          { headers: CORS_HEADERS },
        );
      }

      if (pathname === "/.well-known/oauth-authorization-server") {
        try {
          const upstream = await fetch(
            `${frontendApiUrl}/.well-known/oauth-authorization-server`,
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
      const browserOAuthRoute = /^\/(?:connect|oauth\/callback)\//.test(new URL(request.url).pathname);
      let userId: string | undefined;
      let sessionCookies: string[] | undefined;
      try {
        const pathname = new URL(request.url).pathname;
        const isMcp = pathname === "/mcp" || pathname.startsWith("/mcp/");
        const state = await clerk.authenticateRequest(request, {
          acceptsToken: isMcp ? "oauth_token" : "session_token",
        });
        const browserOAuth = !tokenPresent && browserOAuthRoute;
        // Consent can outlast Clerk's session JWT. Preserve the SDK's browser
        // handshake, which returns here with a refreshed, verified session.
        if (browserOAuth && state.status === "handshake" && state.headers.has("location")) {
          return { ok: false, final: true, response: new Response(null, {
            status: 307, headers: state.headers,
          }) };
        }
        if (browserOAuth) sessionCookies = state.headers?.getSetCookie();
        const auth = state.toAuth();
        if (!auth?.isAuthenticated) {
          console.warn("[connecta] clerk rejected request: reason=authentication_failed");
          return {
            ok: false,
            response: unauthorized(baseUrl, tokenPresent, request),
          };
        }
        if (isMcp) {
          const resource = `${resolveBase(baseUrl)}/mcp${mcpPoolSuffix(pathname) ?? ""}`;
          if (auth.tokenType !== "oauth_token") {
            console.warn("[connecta] clerk rejected request: reason=token_type_mismatch");
            return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
          }
          const token = await auth.getToken();
          let claims: Record<string, unknown>;
          if (token.startsWith("oat_")) {
            try {
              claims = await opaqueOAuthClaims(token, opts.secretKey, auth.userId, auth.clientId, request.signal);
            } catch {
              console.warn("[connecta] clerk rejected request: reason=oauth_verification_failed");
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
          } else {
            claims = decodeJwt(token).payload as Record<string, unknown>;
          }
          const reason = oauthBindingRejection(claims, resource, auth.clientId, allowedOAuthClientIds);
          if (reason) {
            console.warn(`[connecta] clerk rejected request: reason=${reason}`);
            return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
          }
        } else {
          if (auth.tokenType !== "session_token") {
            console.warn("[connecta] clerk rejected request: reason=token_type_mismatch");
            return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
          }
          // Browser session origins retain their existing deployment pin.
          const azp = auth.sessionClaims?.azp;
          const origin = new URL(resolveBase(baseUrl)).origin;
          if (azp && azp !== origin) {
            console.warn("[connecta] clerk rejected request: reason=session_origin_mismatch");
            return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
          }
        }
        userId = auth.userId ?? undefined;
      } catch {
        console.warn("[connecta] clerk rejected request: reason=authentication_failed");
        return { ok: false, response: unauthorized(baseUrl, true, request) };
      }
      if (!userId) {
        console.warn("[connecta] clerk rejected request: reason=user_missing");
        return { ok: false, response: unauthorized(baseUrl, true, request) };
      }
      if (!(await checkGate(userId))) {
        return { ok: false, response: forbidden() };
      }
      return { ok: true, userId, ...(sessionCookies?.length ? { sessionCookies } : {}) };
    },
  };
}
