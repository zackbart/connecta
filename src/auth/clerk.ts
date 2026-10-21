import { authorizationCredential, authorizationRequest, isMachineCredential } from "../inbound-credential.js";
// Clerk as the OAuth 2.1 authorization server; connecta is the resource server.
// Single tenant, no tenant-tag requirement, optional organizationId,
// allowedDomains, and gate() with ~60s identity caching.

import type { ClerkGateClient, ClerkUser } from "./clerk-sdk/client.js";
import { createByteReadingClerkClient } from "./clerk-transport.js";
import { decodeJwt } from "@clerk/backend/jwt";
import { failureRecord, logFailure, type AuthDenialReason } from "../operator-record.js";
import { assertNoRetiredToolkitOptions } from "../retired-toolkits.js";
import type { AuthResult, InboundAuth } from "../types.js";

export type { ClerkGateClient, ClerkUser } from "./clerk-sdk/client.js";

function logDenial(reason: AuthDenialReason, failure?: unknown): void {
  logFailure(console, "Clerk request denied", failureRecord({ reason }, failure));
}

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
   * The one Clerk Organization this deployment admits, as its `org_…` ID,
   * so one Clerk instance can serve many deployments. Every admitted Clerk
   * user must be a member: connecta asks Clerk's Backend API and caches the
   * answer per organization and user for 60 seconds from the start of the
   * lookup (30 for a non-member). Organization claims in tokens and sessions
   * are never read. A failed or timed-out lookup refuses admission. Requires
   * resource-bound tokens, so it cannot be
   * combined with a nonempty `allowedOAuthClientIds`. Organization roles grant
   * nothing; `maintainers` and pool `members` still decide what an admitted
   * user reaches.
   */
  organizationId?: string;
  /**
   * Email domains this deployment admits, e.g. `["acme.com"]`. An
   * authenticated user whose verified primary email is not on one of them is
   * rejected exactly like a `gate` rejection. Matching is exact on the whole
   * domain and case-insensitive: `acme.com` admits neither `evil-acme.com` nor
   * `mail.acme.com` — spell a subdomain out to allow it. Entries must be ASCII
   * (punycode for an internationalized domain) and are validated at
   * construction. Absent ⇒ every authenticated user passes this check, as
   * before the option existed. Governs Clerk sign-in only: a co-configured machine
   * access token has no email to read and is admitted without a domain check.
   */
  allowedDomains?: readonly string[];
  /** Optional allow-list hook using Connecta's bundled user lookup client. */
  gate?: (userId: string, clerk: ClerkGateClient) => boolean | Promise<boolean>;
  /** Advertised scopes in protected-resource metadata. */
  scopes?: string[];
  /** Optional hosted Account Portal sign-in URL for operator pages. Absolute https only. */
  signInUrl?: string;
  /** Optional hosted Account Portal sign-up URL for operator pages. Absolute https only. */
  signUpUrl?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
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
    throw new Error("clerkAuth: `publishableKey` is missing or not a string." + shape);
  }
  const encoded = /^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/.exec(publishableKey)?.[1];
  if (encoded === undefined) {
    throw new Error("clerkAuth: `publishableKey` is not a Clerk publishable key." + shape);
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error("clerkAuth: `publishableKey` does not carry decodable base64." + shape);
  }
  // Clerk terminates the encoded domain with `$`; everything else is the host.
  const domain = decoded.replace(/\$$/, "");
  if (!isDomain(domain)) {
    throw new Error("clerkAuth: `publishableKey` does not decode to a Frontend API domain." + shape);
  }
  return `https://${domain}`;
}

const GATE_ALLOWED_TTL_MS = 60 * 1000;
const GATE_FORBIDDEN_TTL_MS = 30 * 1000;
const BACKEND_LOOKUP_TIMEOUT_MS = 10_000;
// Per organization-mode clerkAuth/isolate, shared by membership and the extra
// opaque verification. Clerk's quota is per instance (100/10s development,
// 1,000/10s production), not per deployment. These cap bursts, not request
// rates: ingress rate limiting must protect the shared quota. No queue or
// request-owned object is retained; only counters and a backoff timestamp.
const ORGANIZATION_MAX_BACKEND_LOOKUPS = 16;
const ORGANIZATION_MAX_BACKEND_LOOKUPS_PER_IDENTITY = 2;
const BACKEND_RETRY_DEFAULT_MS = 10_000;
const BACKEND_RETRY_MAX_MS = 60_000;
// A user-filtered membership list holds at most one row, and a token
// verification describes one token.
const MAX_BACKEND_RESPONSE_BYTES = 65_536;
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

function readIdentityCache<K, V extends { exp: number }>(cache: Map<K, V>, key: K): V | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  if (Date.now() >= hit.exp) return undefined;
  cache.set(key, hit);
  return hit;
}

function writeIdentityCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= GATE_CACHE_MAX_IDENTITIES) return;
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

function cleanActivityLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return Array.from(compact).slice(0, ACTIVITY_LABEL_MAX_LENGTH).join("");
}

/** Prefer a person's name, then a verified primary email, then username. */
function activityLabelForUser(user: ClerkUser): string | undefined {
  const fullName = user.fullName ?? [user.firstName, user.lastName].filter(Boolean).join(" ");
  const primary = user.emailAddresses?.find(
    (address) => address.id === user.primaryEmailAddressId && address.verification?.status === "verified",
  );
  return cleanActivityLabel(fullName) ?? cleanActivityLabel(primary?.emailAddress) ?? cleanActivityLabel(user.username);
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
function normalizeAllowedDomains(value: readonly string[] | undefined): ReadonlySet<string> | undefined {
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
      throw new Error(`clerkAuth: \`allowedDomains\` entry ${JSON.stringify(entry)} is not a string.`);
    }
    // Surrounding whitespace is the one thing forgiven, and only here: this is
    // operator config read at construction, where a stray space is a typo the
    // operator can see in the throw. Nothing is forgiven on the email side.
    const domain = entry.trim();
    if (!isDomain(domain)) {
      const hint = domain.includes("@") ? " Write the domain alone, with no `@` and no local part." : "";
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
        "clerkAuth: `allowedOAuthClientIds` entries must be nonempty, " + "non-wildcard client IDs without whitespace.",
      );
    }
  }
  return new Set(value);
}

/**
 * Checked at construction because the ID becomes a Backend API path segment,
 * and a typo would otherwise refuse every person at request time.
 */
function normalizeOrganizationId(value: string | undefined, allowedOAuthClientIds: ReadonlySet<string>) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^org_[A-Za-z0-9_]{27}$/.test(value)) {
    throw new Error(
      "clerkAuth: `organizationId` is not a Clerk organization ID. Copy it from " +
        "the Clerk dashboard: `org_` followed by 27 letters and digits.",
    );
  }
  // On a shared instance every deployment's OAuth clients and tokens come
  // from one issuer, so the resource-bound audience is what keeps a token for
  // one deployment out of another. An unbound-token fallback removes it.
  if (allowedOAuthClientIds.size > 0) {
    throw new Error(
      "clerkAuth: `organizationId` requires resource-bound OAuth tokens. Remove " +
        "`allowedOAuthClientIds` and enable Clerk's resource audiences.",
    );
  }
  return value;
}

/**
 * Is this user a member of the organization, according to Clerk now? The
 * given signal and a ten-second deadline bound the call. Any response that is
 * not a clear answer throws, so the caller refuses.
 */
async function organizationMember(
  secretKey: string,
  organizationId: string,
  userId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const url = new URL(`https://api.clerk.com/v1/organizations/${encodeURIComponent(organizationId)}/memberships`);
  url.searchParams.set("user_id", userId);
  const list = await backendJson(
    url,
    { headers: { Authorization: `Bearer ${secretKey}`, "Clerk-API-Version": "2026-05-12" } },
    signal,
  );
  if (!isRecord(list) || !Array.isArray(list.data)) {
    throw new Error("Organization membership response invalid");
  }
  // The filter narrows the list; membership is still read exactly from each
  // row, so an ignored or widened filter cannot admit someone else's row.
  return list.data.some(
    (membership) =>
      isRecord(membership) &&
      membership.object === "organization_membership" &&
      isRecord(membership.organization) &&
      membership.organization.id === organizationId &&
      isRecord(membership.public_user_data) &&
      membership.public_user_data.user_id === userId,
  );
}

/**
 * One Backend API request, bounded by the signal, a ten-second deadline, and
 * `MAX_BACKEND_RESPONSE_BYTES`. A redirect, a non-2xx status, or an unreadable
 * body throws. Every exit aborts the request and cancels its body, so no
 * upstream outlives the caller's decision (INV-7).
 */
async function backendJson(url: URL | string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const settled = new AbortController();
  const request = AbortSignal.any([signal, settled.signal, AbortSignal.timeout(BACKEND_LOOKUP_TIMEOUT_MS)]);
  let response: Response | undefined;
  try {
    // Workers reject `redirect: "error"`; `manual` returns a redirect
    // unfollowed, and a redirect is not an answer. Workers and Node return
    // its 3xx; an `opaqueredirect` has status 0, which `ok` refuses.
    response = await fetch(url, { ...init, redirect: "manual", signal: request });
    if (response.status === 429) throw new BackendRateLimited(backendRetryMs(response.headers.get("Retry-After")));
    if (response.status >= 300 && response.status < 400) throw new Error("Clerk Backend API request redirected");
    if (!response.ok) throw new Error("Clerk Backend API request failed");
    return JSON.parse(await boundedText(response, request));
  } finally {
    settled.abort();
    void response?.body?.cancel().catch(() => {});
  }
}

/** Only locally parsed, bounded timing facts leave the response's request. */
class BackendRateLimited extends Error {
  constructor(readonly retryMs: number) {
    super("Clerk Backend API rate limited");
  }
}

class OrganizationLookupBusy extends Error {
  constructor(readonly retrySeconds: number) {
    super("Clerk organization lookup busy");
  }
}

/** Clerk sends seconds; accept an HTTP date too. Never trust an unbounded delay. */
function backendRetryMs(value: string | null): number {
  let delay = BACKEND_RETRY_DEFAULT_MS;
  if (value !== null) {
    const parsed = /^\d+$/.test(value)
      ? Number(value) * 1_000
      : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
        ? Date.parse(value) - Date.now()
        : NaN;
    if (!Number.isNaN(parsed)) delay = parsed;
  }
  return Math.max(1_000, Math.min(BACKEND_RETRY_MAX_MS, delay));
}

/**
 * The body as text, read as bytes (see `byteReadResponse`) and refused past
 * `MAX_BACKEND_RESPONSE_BYTES`. An abort cancels a read the upstream has
 * stopped feeding, so the caller's deadline holds while a body stays open.
 */
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  void reader.closed.catch(() => {});
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BACKEND_RESPONSE_BYTES) throw new Error("Clerk Backend API response too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * A cached membership answer: when its lookup started by the wall clock, and
 * its place in start order. Plain values only, because every lookup's fetch,
 * signal, and body belong to the request that made it (INV-7). Once found
 * expired, an entry keeps its place without `member`, so no later clock step
 * revives it and no older lookup writes over it.
 */
interface MembershipVerdict {
  readonly member?: boolean;
  readonly started: number;
  readonly sequence: number;
}

/**
 * Valid only while the clock reads from the lookup's start to start + ttl.
 * A step back before the start expires the entry, and a step forward can
 * only expire it early.
 */
function withinTtl(started: number, ttl: number): boolean {
  const age = Date.now() - started;
  return age >= 0 && age < ttl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only verified claims reach this comparison; resource URLs match exactly. */
function oauthBindingRejection(
  claims: Record<string, unknown>,
  resource: string,
  clientId: string,
  allowedClientIds: ReadonlySet<string>,
): "oauth_client_not_allowed" | "oauth_binding_mismatch" | null {
  const bindings = ["aud", "resource"].filter((key) => Object.prototype.hasOwnProperty.call(claims, key));
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
  const claims = await backendJson(
    "https://api.clerk.com/v1/oauth_applications/access_tokens/verify",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        "Clerk-API-Version": "2026-05-12",
      },
      body: JSON.stringify({ access_token: token }),
    },
    signal,
  );
  if (
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims) ||
    !("object" in claims) ||
    claims.object !== "clerk_idp_oauth_access_token" ||
    !("subject" in claims) ||
    claims.subject !== userId ||
    !("client_id" in claims) ||
    claims.client_id !== clientId ||
    !("revoked" in claims) ||
    claims.revoked !== false ||
    !("expired" in claims) ||
    claims.expired !== false
  ) {
    throw new Error("Opaque OAuth verification response invalid");
  }
  return claims as Record<string, unknown>;
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
 * `organizationId`, `allowedDomains`, and `gate` decide who is admitted; each
 * configured check must pass.
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
  const clerk = createByteReadingClerkClient({
    secretKey: opts.secretKey,
    publishableKey: opts.publishableKey,
  });
  const allowedDomains = normalizeAllowedDomains(opts.allowedDomains);
  const allowedOAuthClientIds = normalizeOAuthClientIds(opts.allowedOAuthClientIds);
  const organizationId = normalizeOrganizationId(opts.organizationId, allowedOAuthClientIds);
  const requestedScopes = opts.scopes ?? ["openid", "profile", "email"];
  if (
    !Array.isArray(requestedScopes) ||
    requestedScopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
  ) {
    throw new Error("clerkAuth: `scopes` must contain OAuth scope tokens without whitespace, quotes, or backslashes.");
  }
  const scopes = [...requestedScopes];
  const gateCache = new Map<string, { allowed: boolean; exp: number }>();
  const membershipCache = new Map<string, MembershipVerdict>();
  // Membership lookups started, in order, and the latest start among the
  // entries the cache has evicted.
  let membershipLookupsStarted = 0;
  let evictedMembershipSequence = 0;
  let activeOrganizationLookups = 0;
  const organizationLookupsByIdentity = new Map<string, number>();
  // Wall-clock end of the current 429 backoff. Like the membership TTLs it
  // assumes the clock does not step back: a rollback lengthens the remaining
  // window by the size of the step.
  let organizationRetryUntil = 0;

  const organizationLookup = async <T>(userId: string, signal: AbortSignal, lookup: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    if (now < organizationRetryUntil) {
      throw new OrganizationLookupBusy(Math.ceil((organizationRetryUntil - now) / 1_000));
    }
    const activeForIdentity = organizationLookupsByIdentity.get(userId) ?? 0;
    if (
      activeOrganizationLookups >= ORGANIZATION_MAX_BACKEND_LOOKUPS ||
      activeForIdentity >= ORGANIZATION_MAX_BACKEND_LOOKUPS_PER_IDENTITY
    ) {
      throw new OrganizationLookupBusy(1);
    }
    signal.throwIfAborted();
    activeOrganizationLookups++;
    organizationLookupsByIdentity.set(userId, activeForIdentity + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeOrganizationLookups--;
      const remaining = organizationLookupsByIdentity.get(userId)! - 1;
      if (remaining === 0) organizationLookupsByIdentity.delete(userId);
      else organizationLookupsByIdentity.set(userId, remaining);
    };
    // workerd may discard the awaited continuation when its caller leaves.
    // Release in that request's own abort handler too; finally is idempotent.
    // The same caller signal cancels backendJson's request-owned upstream.
    signal.addEventListener("abort", release, { once: true });
    try {
      return await lookup();
    } catch (error) {
      if (error instanceof BackendRateLimited) {
        organizationRetryUntil = Math.max(organizationRetryUntil, Date.now() + error.retryMs);
        throw new OrganizationLookupBusy(Math.ceil((organizationRetryUntil - Date.now()) / 1_000));
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  };
  const activityLabelCache = new Map<string, { label?: string; exp: number }>();
  const pendingActivityLabels = new Map<string, Promise<string | undefined>>();
  const inFlightActivityLabelIds = new Set<string>();
  let activeActivityLabelLookups = 0;

  const resolveBase = (baseUrl: string) => opts.publicUrl ?? baseUrl;

  const cacheActivityLabel = (userId: string, label: string | undefined): void => {
    writeIdentityCache(activityLabelCache, userId, {
      ...(label ? { label } : {}),
      exp: Date.now() + (label ? ACTIVITY_LABEL_TTL_MS : ACTIVITY_LABEL_MISS_TTL_MS),
    });
  };

  const resolveActivityLabel = async (userId: string): Promise<string | undefined> => {
    const cached = readIdentityCache(activityLabelCache, userId);
    if (cached) return cached.label;
    const existing = pendingActivityLabels.get(userId);
    if (existing) return existing;
    // The Clerk SDK's getUser call has no AbortSignal. Keep the real upstream
    // concurrency bounded even when requests hang forever: do not queue more
    // identities in memory, and do not start a duplicate for an id whose raw
    // lookup outlived its caller-facing deadline.
    if (inFlightActivityLabelIds.has(userId) || activeActivityLabelLookups >= ACTIVITY_LABEL_MAX_IN_FLIGHT) {
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

  const challenge = (request: Request, baseUrl: string): string => {
    const tokenPresent = authorizationCredential(request).kind !== "absent";
    const error = tokenPresent ? `error="invalid_token", ` : "";
    // A pool endpoint is its own protected resource: the challenge names the
    // metadata document whose `resource` matches the URL the client used, or
    // RFC 9728 tells it to reject the mismatch.
    const pool = mcpPoolSuffix(new URL(request.url).pathname);
    const meta = `${resolveBase(baseUrl)}/.well-known/oauth-protected-resource${pool ? `/mcp${pool}` : ""}`;
    const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `Bearer ${error}resource_metadata="${quote(meta)}", scope="${scopes.join(" ")}"`;
  };
  const unauthorized = (baseUrl: string, _tokenPresent: boolean, request: Request): Response => {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": challenge(request, baseUrl),
      },
    });
  };

  const forbidden = (): Response =>
    new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });

  const organizationBusy = (error: OrganizationLookupBusy): Response => {
    logDenial("organization_lookup_busy");
    return Response.json(
      {
        error: {
          code: "organization_lookup_busy",
          message: "Organization admission is temporarily busy. Retry later.",
          retryable: true,
        },
      },
      { status: 503, headers: { "Retry-After": String(error.retrySeconds) } },
    );
  };

  /**
   * The domain half of admission. Fails CLOSED on every uncertainty — no
   * primary email, an unverified one, a malformed address, or the lookup
   * itself failing — because "we could not tell" and "they belong here" must
   * not be the same answer for a membership rule. A failed or cancelled
   * lookup is `undefined`, not a verdict, so it refuses without being cached.
   */
  const checkDomain = async (userId: string, clerk: ClerkGateClient): Promise<boolean | undefined> => {
    if (!allowedDomains) return true;
    let email: string | undefined;
    try {
      const user = await clerk.users.getUser(userId);
      const primary = user.emailAddresses?.find((address) => address.id === user.primaryEmailAddressId);
      if (primary?.verification?.status === "verified") {
        email = primary.emailAddress;
      }
    } catch (error) {
      logDenial("email_lookup_failed", error);
      return undefined;
    }
    const domain = email ? emailDomain(email) : null;
    if (!domain) {
      logDenial("verified_email_invalid");
      return false;
    }
    if (!allowedDomains.has(domain)) {
      logDenial("email_domain_denied");
      return false;
    }
    return true;
  };

  /** A cached answer still within its TTL, counted from its lookup's start. */
  const cachedMembership = (key: string): boolean | undefined => {
    const verdict = membershipCache.get(key);
    if (verdict?.member === undefined) return undefined;
    if (!withinTtl(verdict.started, verdict.member ? GATE_ALLOWED_TTL_MS : GATE_FORBIDDEN_TTL_MS)) {
      membershipCache.set(key, { started: verdict.started, sequence: verdict.sequence });
      return undefined;
    }
    membershipCache.delete(key);
    membershipCache.set(key, verdict);
    return verdict.member;
  };

  /**
   * Cache a lookup's answer unless a lookup that started later has already
   * written this key. Evicting an entry raises a floor under every key,
   * because the evicted entry no longer guards its own: a lookup that started
   * before it never writes. Either way an older answer never replaces a
   * newer verdict. A floor-suppressed answer invalidates an older entry for
   * its own key rather than leaving that older verdict authoritative.
   */
  const cacheMembership = (key: string, verdict: MembershipVerdict & { member: boolean }): void => {
    const current = membershipCache.get(key);
    if (current && current.sequence > verdict.sequence) return;
    if (verdict.sequence <= evictedMembershipSequence) {
      // The floor may have advanced past both lookups while an older verdict
      // for this key remained cached. Suppressing the newer answer must not
      // preserve that older admission. Forget it; the floor still prevents
      // either lookup (or an evicted, newer one) from being overwritten.
      if (current && current.sequence < verdict.sequence) membershipCache.delete(key);
      return;
    }
    membershipCache.delete(key);
    membershipCache.set(key, verdict);
    if (membershipCache.size <= GATE_CACHE_MAX_IDENTITIES) return;
    const [oldestKey, oldest] = membershipCache.entries().next().value!;
    membershipCache.delete(oldestKey);
    evictedMembershipSequence = Math.max(evictedMembershipSequence, oldest.sequence);
  };

  /**
   * The organization half of admission, checked before the domain allowlist
   * and `gate`, for every token type and session. No claim answers it or is
   * read: an OAuth JWT verifies offline and can outlive a removed membership
   * by a day, and a member's token is audience-bound to this deployment
   * whichever organization they chose at consent. Membership always comes
   * from the Backend API, cached per organization and user for 60 seconds
   * from the start of the lookup that answered (30 for a non-member), since
   * Clerk answered no earlier. With a clock that does not step back unseen
   * within the TTL window, every request reaching this check 60 seconds or
   * more after a member's removal is refused. An unseen rollback within that
   * window can extend admission beyond 60 seconds of elapsed time.
   *
   * Each request that misses the cache runs and owns its own lookup. On
   * Workers one request may not touch another's fetch, signal, or body, so
   * concurrent misses within the plain-counter bounds each ask Clerk, and a caller that leaves cancels only
   * its own lookup. A failed or abandoned lookup is not an answer, so it
   * refuses without being cached.
   */
  const checkOrganization = async (userId: string, signal: AbortSignal): Promise<boolean | Response> => {
    if (!organizationId) return true;
    const key = `${organizationId}/${userId}`;
    const cached = cachedMembership(key);
    if (cached !== undefined) return cached;
    const started = Date.now();
    const sequence = ++membershipLookupsStarted;
    let member: boolean;
    try {
      member = await organizationLookup(userId, signal, () =>
        organizationMember(opts.secretKey, organizationId, userId, signal),
      );
    } catch (error) {
      if (error instanceof OrganizationLookupBusy) return organizationBusy(error);
      logDenial("organization_lookup_failed");
      return false;
    }
    cacheMembership(key, { member, started, sequence });
    if (!member) logDenial("organization_membership_denied");
    return member;
  };

  /**
   * Is this authenticated user admitted? The domain allowlist and `gate` both
   * have to say yes, and the allowlist runs first so an outsider never reaches
   * operator gate code. One cached verdict covers both, so composing them costs
   * no more Clerk calls than `gate` alone did.
   */
  const checkGate = async (userId: string, clerk: ClerkGateClient, signal: AbortSignal): Promise<boolean> => {
    if (!opts.gate && !allowedDomains) return true;
    const hit = readIdentityCache(gateCache, userId);
    if (hit) return hit.allowed;
    let allowed: boolean;
    try {
      const domainAllowed = await checkDomain(userId, clerk);
      if (domainAllowed === undefined) return false;
      signal.throwIfAborted();
      allowed = domainAllowed && (opts.gate ? await opts.gate(userId, clerk) : true);
      // `clerk` is bound to this signal; a gate may turn its cancelled
      // lookup into `false`. Only a completed, uncancelled verdict is cached.
      signal.throwIfAborted();
      if (domainAllowed && !allowed) logDenial("gate_denied");
    } catch {
      logDenial("gate_failed");
      return false;
    }
    writeIdentityCache(gateCache, userId, {
      allowed,
      exp: Date.now() + (allowed ? GATE_ALLOWED_TTL_MS : GATE_FORBIDDEN_TTL_MS),
    });
    return allowed;
  };

  return {
    kind: "clerk",
    interactiveOperator: true,
    recognizesCredential: (request) => {
      if (authorizationCredential(request).kind !== "absent") return !isMachineCredential(request);
      return (
        /(?:^|;\s*)__session(?:_[^=;]+)?=/.test(request.headers.get("cookie") ?? "") ||
        new URL(request.url).searchParams.has("__clerk_synced")
      );
    },
    challenge,
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
      const protectedResource =
        pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp" ||
        /^\/\.well-known\/oauth-protected-resource\/mcp\/[a-z0-9_-]+$/.test(pathname);
      if (!protectedResource) return null;
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
        return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" } });
      }

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

      return null;
    },

    async authorize(request, baseUrl): Promise<AuthResult> {
      const credential = authorizationCredential(request);
      const tokenPresent = credential.kind !== "absent";
      if (credential.kind === "invalid" || isMachineCredential(request)) {
        logDenial("authorization_header_invalid");
        return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
      }
      const finished = new AbortController();
      const signal = AbortSignal.any([request.signal, finished.signal]);
      const timer = setTimeout(
        () => finished.abort(new Error("Clerk authentication timed out")),
        BACKEND_LOOKUP_TIMEOUT_MS,
      );
      const pending = new Set<Promise<unknown>>();
      // SDK-created verification clients, JWKS, handshakes, domain lookups and
      // gate calls all close over this authorization's signal, never another
      // request's client. The long-lived client above serves display labels only.
      const clerk = createByteReadingClerkClient(opts, signal, pending);
      try {
        signal.throwIfAborted();
        const browserOAuthRoute = /^\/(?:connect|oauth\/callback)\//.test(new URL(request.url).pathname);
        let userId: string | undefined;
        let sessionCookies: string[] | undefined;
        try {
          const pathname = new URL(request.url).pathname;
          const isMcp = pathname === "/mcp" || pathname.startsWith("/mcp/");
          const state = await clerk.authenticateRequest(authorizationRequest(request), {
            acceptsToken: isMcp ? "oauth_token" : "session_token",
          });
          const browserOAuth = !tokenPresent && browserOAuthRoute;
          // Consent can outlast Clerk's session JWT. Preserve the SDK's browser
          // handshake, which returns here with a refreshed, verified session.
          if (browserOAuth && state.status === "handshake" && state.headers.has("location")) {
            return {
              ok: false,
              response: new Response(null, {
                status: 307,
                headers: state.headers,
              }),
            };
          }
          if (browserOAuth) sessionCookies = state.headers?.getSetCookie();
          const auth = state.toAuth();
          if (!auth?.isAuthenticated) {
            logDenial("authentication_failed");
            return {
              ok: false,
              response: unauthorized(baseUrl, tokenPresent, request),
            };
          }
          if (isMcp) {
            const resource = `${resolveBase(baseUrl)}/mcp${mcpPoolSuffix(pathname) ?? ""}`;
            if (auth.tokenType !== "oauth_token") {
              logDenial("token_type_mismatch");
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
            const token = await auth.getToken();
            let claims: Record<string, unknown>;
            if (token.startsWith("oat_")) {
              try {
                const verify = () => opaqueOAuthClaims(token, opts.secretKey, auth.userId, auth.clientId, signal);
                claims = await (organizationId ? organizationLookup(auth.userId ?? "", signal, verify) : verify());
              } catch (error) {
                if (error instanceof OrganizationLookupBusy) return { ok: false, response: organizationBusy(error) };
                logDenial("oauth_verification_failed");
                return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
              }
            } else {
              claims = decodeJwt(token).payload as Record<string, unknown>;
            }
            const rejection = oauthBindingRejection(claims, resource, auth.clientId, allowedOAuthClientIds);
            if (rejection) {
              logDenial(rejection);
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
            // The membership lookup is keyed by subject, so on a shared
            // instance the issuer and subject must be this instance's and the
            // SDK's. An opaque token's claims come from this instance's Backend
            // API, which has already matched the subject and carries no issuer.
            if (
              organizationId &&
              !token.startsWith("oat_") &&
              (claims.iss !== frontendApiUrl || claims.sub !== auth.userId)
            ) {
              logDenial("token_identity_mismatch");
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
          } else {
            if (auth.tokenType !== "session_token") {
              logDenial("token_type_mismatch");
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
            // Browser session origins retain their existing deployment pin.
            const azp = auth.sessionClaims?.azp;
            const origin = new URL(resolveBase(baseUrl)).origin;
            if (azp && azp !== origin) {
              logDenial("session_origin_mismatch");
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
            // The session's active organization is not read; membership is.
            if (
              organizationId &&
              (auth.sessionClaims.iss !== frontendApiUrl || auth.sessionClaims.sub !== auth.userId)
            ) {
              logDenial("token_identity_mismatch");
              return { ok: false, response: unauthorized(baseUrl, tokenPresent, request) };
            }
          }
          userId = auth.userId ?? undefined;
        } catch {
          logDenial("authentication_failed");
          return { ok: false, response: unauthorized(baseUrl, true, request) };
        }
        if (!userId) {
          logDenial("user_missing");
          return { ok: false, response: unauthorized(baseUrl, true, request) };
        }
        const membership = await checkOrganization(userId, signal);
        if (membership instanceof Response) return { ok: false, response: membership };
        if (!membership || !(await checkGate(userId, clerk, signal))) {
          return { ok: false, response: forbidden() };
        }
        signal.throwIfAborted();
        return { ok: true, userId, ...(sessionCookies?.length ? { sessionCookies } : {}) };
      } finally {
        clearTimeout(timer);
        finished.abort();
        await Promise.allSettled(pending);
      }
    },
  };
}
