// Clerk as the OAuth 2.1 authorization server; connecta is the resource server.
// Single tenant, no tenant-tag requirement, optional allowedDomains/gate() with
// ~60s identity caching.

import { createClerkClient } from "@clerk/backend";
import {
  resolveToolkitBinding,
  type ToolkitBindingOptions,
} from "../toolkits.js";
import type { AuthResult, InboundAuth } from "../types.js";

type ClerkClient = ReturnType<typeof createClerkClient>;
type ClerkUser = Awaited<ReturnType<ClerkClient["users"]["getUser"]>>;

export interface ClerkAuthOptions extends ToolkitBindingOptions {
  publishableKey: string;
  secretKey: string;
  /** Public base URL of this deployment. Defaults to the request origin. */
  publicUrl?: string;
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

/**
 * Bounded, escaped form of the denied domain for the operator log — the same
 * treatment `src/server.ts` gives a rejected toolkit name. An email domain is
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
 * `allowedDomains` and `gate` decide WHO is admitted (both must pass);
 * `toolkits` decides WHICH view the admitted user gets.
 *
 * `toolkits` binds every user this provider admits to those toolkits
 * (documentation/toolkits.md). For a per-team split, configure one `clerkAuth(...)` per
 * team — the same keys, a `gate` naming that team's users, and that team's
 * `toolkits`. The server tries providers in order and the first that admits the
 * user supplies the binding, so a user one gate rejects falls through to the
 * next.
 */
export function clerkAuth(opts: ClerkAuthOptions): InboundAuth {
  const clerk = createClerkClient({
    secretKey: opts.secretKey,
    publishableKey: opts.publishableKey,
  });
  const toolkitBinding = resolveToolkitBinding("clerkAuth", opts);
  const allowedDomains = normalizeAllowedDomains(opts.allowedDomains);
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
    activityLabelCache.delete(userId);
    activityLabelCache.set(userId, {
      ...(label ? { label } : {}),
      exp:
        Date.now() +
        (label ? ACTIVITY_LABEL_TTL_MS : ACTIVITY_LABEL_MISS_TTL_MS),
    });
    if (activityLabelCache.size > GATE_CACHE_MAX_IDENTITIES) {
      const oldest = activityLabelCache.keys().next();
      if (!oldest.done) activityLabelCache.delete(oldest.value);
    }
  };

  const resolveActivityLabel = async (
    userId: string,
  ): Promise<string | undefined> => {
    const cached = activityLabelCache.get(userId);
    if (cached) {
      if (Date.now() < cached.exp) {
        activityLabelCache.delete(userId);
        activityLabelCache.set(userId, cached);
        return cached.label;
      }
      activityLabelCache.delete(userId);
    }
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
    const hit = gateCache.get(userId);
    if (hit) {
      if (Date.now() < hit.exp) {
        // Map iteration order is the LRU order. Refreshing a valid hit keeps a
        // small active identity set resident when one-off identities churn.
        gateCache.delete(userId);
        gateCache.set(userId, hit);
        return hit.allowed;
      }
      gateCache.delete(userId);
    }
    let allowed = false;
    try {
      allowed =
        (await checkDomain(userId)) &&
        (opts.gate ? await opts.gate(userId, clerk) : true);
    } catch {
      allowed = false;
    }
    gateCache.set(userId, {
      allowed,
      exp:
        Date.now() +
        (allowed ? GATE_ALLOWED_TTL_MS : GATE_FORBIDDEN_TTL_MS),
    });
    if (gateCache.size > GATE_CACHE_MAX_IDENTITIES) {
      const oldest = gateCache.keys().next();
      if (!oldest.done) gateCache.delete(oldest.value);
    }
    return allowed;
  };

  return {
    kind: "clerk",
    activityActorNamespace: fapiUrl(opts.publishableKey),
    ...(toolkitBinding ? { toolkitBinding } : {}),
    activityActorLabel: resolveActivityLabel,
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
          // MCP clients use Clerk OAuth access tokens; the browser operator UI
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
