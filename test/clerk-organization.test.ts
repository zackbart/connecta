import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getUser: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../src/auth/clerk-transport.js", () => ({
  createByteReadingClerkClient: () => ({
    authenticateRequest: mocks.authenticateRequest,
    users: { getUser: mocks.getUser },
  }),
}));

import { signJwt } from "@clerk/backend/jwt";
import { clerkAuth, type ClerkAuthOptions } from "../src/auth/clerk.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import { stalledResponse } from "./fixtures/http.js";
import { createTestConnecta } from "./helpers.js";

// One Clerk instance, one Organization per deployment (documentation/auth.md).
const BASE = "https://connecta.test";
const FRONTEND = "https://clerk.example.com";
const publishableKey = `pk_test_${btoa("clerk.example.com$")}`;
const ORG = `org_${"A".repeat(27)}`;
const OTHER_ORG = `org_${"B".repeat(27)}`;
const ALICE = "user_alice";
const BOB = "user_bob";
const MEMBERSHIPS = `/v1/organizations/${ORG}/memberships`;

/** An already SDK-verified JWT access token for `/mcp`, issued by this instance. */
function jwt(claims: Record<string, unknown> = {}) {
  return [
    { alg: "RS256", typ: "at+jwt", kid: "test" },
    { sub: ALICE, iss: FRONTEND, aud: `${BASE}/mcp`, ...claims },
    "signature",
  ]
    .map((part) => btoa(typeof part === "string" ? part : JSON.stringify(part)))
    .map((part) => part.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"))
    .join(".");
}

function oauth(token: string, userId = ALICE) {
  mocks.authenticateRequest.mockResolvedValue({
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: "oauth_token",
      userId,
      clientId: "client_connecta",
      getToken: async () => token,
    }),
  });
}

function session(claims: { iss?: string; sub?: string } = {}) {
  mocks.authenticateRequest.mockResolvedValue({
    headers: new Headers(),
    toAuth: () => ({
      isAuthenticated: true,
      tokenType: "session_token",
      userId: ALICE,
      sessionClaims: { azp: BASE, iss: claims.iss ?? FRONTEND, sub: claims.sub ?? ALICE },
    }),
  });
}

/** A Backend API membership row, shaped like the pinned contract's. */
function membershipRow(organizationId: string, userId: string, role = "org:member") {
  return {
    object: "organization_membership",
    id: `orgmem_${userId}`,
    role,
    permissions: [],
    public_metadata: {},
    created_at: 0,
    updated_at: 0,
    organization: { object: "organization", id: organizationId, name: "Alpha", slug: "alpha" },
    public_user_data: { user_id: userId, identifier: `${userId}@example.com` },
  };
}

/** Clerk's membership answers, as `<organization>/<user>`. Tests edit it. */
const members = new Set<string>();

function backendApi(input: RequestInfo | URL): Response {
  const url = new URL(String(input));
  if (url.pathname === "/v1/oauth_applications/access_tokens/verify") {
    return Response.json({
      object: "clerk_idp_oauth_access_token",
      id: "oat_verified",
      client_id: "client_connecta",
      subject: ALICE,
      scopes: ["openid"],
      aud: [`${BASE}/mcp`],
      revoked: false,
      revocation_reason: null,
      expired: false,
      expiration: null,
      created_at: 0,
      updated_at: 0,
    });
  }
  const organizationId = /^\/v1\/organizations\/([^/]+)\/memberships$/.exec(url.pathname)?.[1];
  if (organizationId) {
    const users = url.searchParams.getAll("user_id");
    const data = [...members]
      .map((key) => key.split("/") as [string, string])
      .filter(([org, user]) => org === organizationId && users.includes(user))
      .map(([org, user]) => membershipRow(org, user));
    return Response.json({ data, total_count: data.length });
  }
  throw new Error(`unexpected Backend API request ${url.pathname}`);
}

function lookups() {
  return mocks.fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/memberships"));
}

function orgAuth(options: Partial<ClerkAuthOptions> = {}) {
  return clerkAuth({ publishableKey, secretKey: "sk_test_fake", publicUrl: BASE, organizationId: ORG, ...options });
}

function mcp(signal?: AbortSignal) {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer supplied-token" },
    ...(signal ? { signal } : {}),
  });
}

/**
 * The next membership lookup answers only when `answer` says so and, like a
 * real fetch, rejects once its signal aborts. `sent` resolves once it is sent.
 */
function heldLookup(userId = ALICE) {
  let answer!: (member: boolean) => void;
  let send!: () => void;
  const sent = new Promise<void>((resolve) => {
    send = resolve;
  });
  mocks.fetch.mockImplementationOnce((_input, { signal }: RequestInit) => {
    send();
    return new Promise<Response>((resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      answer = (member) => {
        const data = member ? [membershipRow(ORG, userId)] : [];
        resolve(Response.json({ data, total_count: data.length }));
      };
    });
  });
  return { sent, answer: (member: boolean) => answer(member) };
}

function lookupSignal(index = 0) {
  return (lookups()[index]![1] as RequestInit).signal!;
}

function operator() {
  return new Request(`${BASE}/ui/api/config`, { headers: { Authorization: "Bearer clerk-session-jwt" } });
}

let warn: { mock: { calls: unknown[][] }; mockClear(): void };

function denials(spy: typeof warn) {
  return spy.mock.calls.filter(([event]) => event === "[connecta] Clerk request denied").map(([, record]) => record);
}

beforeEach(() => {
  mocks.authenticateRequest.mockReset();
  mocks.getUser.mockReset();
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => backendApi(input));
  members.clear();
  vi.stubGlobal("fetch", mocks.fetch);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("clerkAuth organizationId construction", () => {
  it.each([`org_${"A".repeat(26)}`, `${ORG}\n`, 123])(
    "INV-11: refuses a malformed organizationId at construction: %j",
    (organizationId) => {
      expect(() => orgAuth({ organizationId } as never)).toThrow("`organizationId` is not a Clerk organization ID");
    },
  );

  it("INV-11: refuses the unbound-token client fallback in organization mode", () => {
    expect(() => orgAuth({ allowedOAuthClientIds: ["client_connecta"] })).toThrow(
      "`organizationId` requires resource-bound OAuth tokens",
    );
    // Malformed fallback lists keep their own, earlier error.
    expect(() => orgAuth({ allowedOAuthClientIds: ["*"] })).toThrow("allowedOAuthClientIds");
    expect(() => orgAuth({ allowedOAuthClientIds: [] })).not.toThrow();
    expect(() => orgAuth()).not.toThrow();
  });
});

describe("clerkAuth organization membership on MCP OAuth tokens", () => {
  it("INV-4: confirms membership with the Backend API for every token", async () => {
    members.add(`${ORG}/${ALICE}`);
    oauth(jwt());
    await expect(orgAuth().authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(1);
    const [input, init] = lookups()[0]! as [URL, RequestInit];
    expect(String(input)).toBe(`https://api.clerk.com${MEMBERSHIPS}?user_id=${ALICE}`);
    expect(init.headers).toEqual({ Authorization: "Bearer sk_test_fake", "Clerk-API-Version": "2026-05-12" });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // A member's token is audience-bound to this deployment whichever
  // organization they chose at consent, and a non-member is refused by the
  // lookup, so the claim decides nothing.
  it.each([ORG, OTHER_ORG])("INV-4: never reads a token's org_id; membership alone decides: %j", async (orgId) => {
    oauth(jwt({ org_id: orgId }));
    const refused = await orgAuth().authorize(mcp(), BASE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    expect(denials(warn)).toEqual([{ reason: "organization_membership_denied" }]);
    members.add(`${ORG}/${ALICE}`);
    await expect(orgAuth().authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(2);
  });

  it("INV-6: refuses a non-member with 403 and a payload-free reason", async () => {
    members.add(`${OTHER_ORG}/${ALICE}`);
    oauth(jwt());
    const result = await orgAuth().authorize(mcp(), BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(denials(warn)).toEqual([{ reason: "organization_membership_denied" }]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/user_alice|org_A|org_B/);
  });

  it.each([
    ["a row for another user", () => Response.json({ data: [membershipRow(ORG, BOB)], total_count: 1 })],
    [
      "a row for another organization",
      () => Response.json({ data: [membershipRow(OTHER_ORG, ALICE)], total_count: 1 }),
    ],
    [
      "a row of another object type",
      () =>
        Response.json({ data: [{ ...membershipRow(ORG, ALICE), object: "organization_invitation" }], total_count: 1 }),
    ],
  ])("reads membership from each row exactly, not from the filter: %s", async (_name, answer) => {
    mocks.fetch.mockImplementation(async () => answer());
    oauth(jwt());
    const result = await orgAuth().authorize(mcp(), BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(denials(warn)).toEqual([{ reason: "organization_membership_denied" }]);
  });

  it.each([
    ["a 500", () => new Response("planted-upstream-text", { status: 500 })],
    [
      "a thrown network error",
      () => {
        throw new Error("planted-upstream-text");
      },
    ],
    // A redirect is not an answer, even one whose body names a membership.
    [
      "a redirect",
      () =>
        Response.json(
          { data: [membershipRow(ORG, ALICE)], total_count: 1 },
          { status: 302, headers: { Location: "https://api.clerk.com/planted-upstream-text" } },
        ),
    ],
    ["a non-array data", () => Response.json({ data: "planted-upstream-text" })],
  ])("INV-6: fails closed on %s without caching the failure", async (_name, failure) => {
    members.add(`${ORG}/${ALICE}`);
    mocks.fetch.mockImplementationOnce(async () => failure());
    oauth(jwt());
    const auth = orgAuth();
    const refused = await auth.authorize(mcp(), BASE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    expect(denials(warn)).toEqual([{ reason: "organization_lookup_failed" }]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/planted-upstream-text|user_alice|org_A/);
    // A failed lookup is not an answer: the next request asks again.
    await expect(auth.authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(2);
  });

  it("INV-4: refuses a member removed within the token's lifetime once the 60-second cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    members.add(`${ORG}/${ALICE}`);
    // A day-long JWT naming this organization stays verifiable offline.
    const issued = Math.floor(Date.now() / 1000);
    oauth(jwt({ org_id: ORG, iat: issued, exp: issued + 86_400 }));
    const auth = orgAuth();
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);

    members.delete(`${ORG}/${ALICE}`);
    vi.setSystemTime(Date.now() + 59_000);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
    expect(lookups()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1_000);
    const removed = await auth.authorize(mcp(), BASE);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.response.status).toBe(403);
    expect(lookups()).toHaveLength(2);
    expect(denials(warn)).toEqual([{ reason: "organization_membership_denied" }]);
  });

  it("caches each user's answer separately, and a refusal for 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    members.add(`${ORG}/${ALICE}`);
    const auth = orgAuth();
    oauth(jwt(), ALICE);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
    oauth(jwt({ sub: BOB }), BOB);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    expect(lookups().map(([input]) => new URL(String(input)).searchParams.get("user_id"))).toEqual([ALICE, BOB]);

    members.add(`${ORG}/${BOB}`);
    vi.setSystemTime(Date.now() + 29_000);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    vi.setSystemTime(Date.now() + 1_000);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
    expect(lookups()).toHaveLength(3);
  });

  it("INV-4: checks audience, issuer, and subject before the membership lookup", async () => {
    members.add(`${ORG}/${ALICE}`);
    const cases: [Record<string, unknown>, string][] = [
      [{ aud: "https://other.test/mcp" }, "oauth_binding_mismatch"],
      [{ iss: "https://clerk.other.example" }, "token_identity_mismatch"],
      [{ iss: undefined }, "token_identity_mismatch"],
      [{ sub: BOB }, "token_identity_mismatch"],
    ];
    for (const [claims, reason] of cases) {
      warn.mockClear();
      oauth(jwt(claims));
      const result = await orgAuth().authorize(mcp(), BASE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect(denials(warn)).toEqual([{ reason }]);
    }
    expect(lookups()).toHaveLength(0);
  });

  it("INV-4: confirms membership for opaque tokens", async () => {
    oauth("oat_verified");
    const refused = await orgAuth().authorize(mcp(), BASE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    members.add(`${ORG}/${ALICE}`);
    await expect(orgAuth().authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(2);
  });

  it.each([
    ["a non-2xx status", 500, "planted-upstream-text", undefined],
    ["an oversized body", 200, " ".repeat(65_537), undefined],
    ["the ten-second deadline", 200, '{"data":[', "deadline"],
  ] as const)("INV-7: ends a membership lookup whose body never closes on %s", async (_name, status, chunk, leave) => {
    members.add(`${ORG}/${ALICE}`);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const { response, cancelled, waiting } = stalledResponse(status, chunk);
    mocks.fetch.mockResolvedValueOnce(response);
    oauth(jwt());
    const caller = new AbortController();
    const auth = orgAuth();
    const pending = auth.authorize(mcp(caller.signal), BASE);
    if (leave) {
      await waiting;
      deadline.abort();
    }
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect((lookups()[0]![1] as RequestInit).signal!.aborted).toBe(true);
    expect(denials(warn)).toEqual([{ reason: "organization_lookup_failed" }]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/planted-upstream-text/);
    timeout.mockRestore();
    await expect(auth.authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
  });

  it("runs before allowedDomains and gate, which still narrow admission", async () => {
    const gate = vi.fn(() => false);
    oauth(jwt());
    expect((await orgAuth({ gate }).authorize(mcp(), BASE)).ok).toBe(false);
    expect(gate).not.toHaveBeenCalled();

    members.add(`${ORG}/${ALICE}`);
    const refused = await orgAuth({ gate }).authorize(mcp(), BASE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    expect(gate).toHaveBeenCalledWith(ALICE, expect.anything());

    mocks.getUser.mockResolvedValue({
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: "alice@example.com", verification: { status: "verified" } }],
    });
    await expect(orgAuth({ allowedDomains: ["example.com"] }).authorize(mcp(), BASE)).resolves.toEqual({
      ok: true,
      userId: ALICE,
    });
    expect((await orgAuth({ allowedDomains: ["acme.com"] }).authorize(mcp(), BASE)).ok).toBe(false);
  });

  it("INV-4: organization roles grant nothing; maintainers and pool members stay in code", async () => {
    const app = createTestConnecta({
      publicUrl: BASE,
      auth: orgAuth(),
      storage: memoryStorage(),
      logger: "silent",
      connectors: [
        api("calc", {
          description: "Test calculator",
          tools: [
            {
              name: "ping",
              description: "Return a test response",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
              handler: async () => "pong",
            },
          ],
        }),
      ],
      maintainers: [BOB],
      pools: { support: { tools: ["calc"], members: [BOB] } },
    });
    try {
      // Alice administers the organization in Clerk; the deployment names Bob.
      mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        const userId = new URL(String(input)).searchParams.get("user_id")!;
        return Response.json({ data: [membershipRow(ORG, userId, "org:admin")], total_count: 1 });
      });
      const initialize = (path: string) =>
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: {
            Authorization: "Bearer supplied-token",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
          }),
        });
      for (const path of ["/mcp", "/mcp/support"]) {
        oauth(jwt({ aud: `${BASE}${path}`, org_id: ORG }), ALICE);
        const refused = await app.fetch(initialize(path));
        expect(refused.status).toBe(404);
        await refused.text();
        oauth(jwt({ aud: `${BASE}${path}`, sub: BOB }), BOB);
        const admitted = await app.fetch(initialize(path));
        expect(admitted.status).toBe(200);
        await admitted.text();
      }
    } finally {
      await app.close();
    }
  });
});

describe("clerkAuth membership lookups, one per request", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    oauth(jwt());
  });

  it.each([
    ["a member", true, 60_000],
    ["a non-member", false, 30_000],
  ])(
    "INV-4: counts the cache for %s from the lookup's start, so a slow answer does not extend it",
    async (_name, member, ttl) => {
      const started = Date.now();
      const lookup = heldLookup();
      const auth = orgAuth();
      const first = auth.authorize(mcp(), BASE);
      await lookup.sent;
      vi.setSystemTime(started + 9_000);
      lookup.answer(member);
      expect((await first).ok).toBe(member);

      // Clerk's answer changes after it answered.
      if (!member) members.add(`${ORG}/${ALICE}`);
      vi.setSystemTime(started + ttl - 1);
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(member);
      expect(lookups()).toHaveLength(1);

      vi.setSystemTime(started + ttl);
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(!member);
      expect(lookups()).toHaveLength(2);
    },
  );

  it("INV-7: requests that miss the cache together each run and end their own lookup", async () => {
    const started = Date.now();
    const held = [heldLookup(), heldLookup()];
    const auth = orgAuth();
    const first = auth.authorize(mcp(), BASE);
    await held[0]!.sent;
    const second = auth.authorize(mcp(), BASE);
    await held[1]!.sent;
    expect(lookups()).toHaveLength(2);
    expect(lookupSignal(0)).not.toBe(lookupSignal(1));

    held[1]!.answer(true);
    held[0]!.answer(true);
    await expect(first).resolves.toEqual({ ok: true, userId: ALICE });
    await expect(second).resolves.toEqual({ ok: true, userId: ALICE });
    expect([lookupSignal(0).aborted, lookupSignal(1).aborted]).toEqual([true, true]);
    await expect(auth.authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(2);

    // Alice was removed meanwhile. The answer expires 60 seconds after the
    // lookups began.
    vi.setSystemTime(started + 60_000);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    expect(lookups()).toHaveLength(3);
  });

  it("INV-4: never lets an older member answer replace a newer refusal", async () => {
    const [stale, fresh] = [heldLookup(), heldLookup()];
    const auth = orgAuth();
    const first = auth.authorize(mcp(), BASE);
    await stale.sent;
    vi.setSystemTime(Date.now() + 1_000);
    const second = auth.authorize(mcp(), BASE);
    await fresh.sent;

    // The newer lookup answers first and the older one last. Each request
    // gets its own lookup's answer.
    fresh.answer(false);
    expect((await second).ok).toBe(false);
    stale.answer(true);
    expect((await first).ok).toBe(true);

    vi.setSystemTime(Date.now() + 28_000);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    expect(lookups()).toHaveLength(2);
  });

  it("INV-7: a caller that leaves cancels only its own lookup and body", async () => {
    const { response, cancelled, waiting } = stalledResponse(200, '{"data":[');
    mocks.fetch.mockResolvedValueOnce(response);
    const held = heldLookup();
    const auth = orgAuth();
    const leaving = new AbortController();
    const left = auth.authorize(mcp(leaving.signal), BASE);
    await waiting;
    const staying = auth.authorize(mcp(), BASE);
    await held.sent;

    leaving.abort();
    expect((await left).ok).toBe(false);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(lookupSignal(0).aborted).toBe(true);
    expect(lookupSignal(1).aborted).toBe(false);

    held.answer(true);
    await expect(staying).resolves.toEqual({ ok: true, userId: ALICE });
    expect(denials(warn)).toEqual([{ reason: "organization_lookup_failed" }]);
    // The staying request's answer reaches the cache; the abandoned one does not.
    await expect(auth.authorize(mcp(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(2);
  });

  it("INV-4: evicts past 1,024 identities, and an older answer never writes after the newer verdict is evicted", async () => {
    const stale = heldLookup();
    const auth = orgAuth();
    const older = auth.authorize(mcp(), BASE);
    await stale.sent;
    // A newer lookup refuses Alice. Then 1,024 other identities push that
    // verdict out of the cache.
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    for (let index = 0; index < 1_024; index++) {
      const user = `user_${index}`;
      oauth(jwt({ sub: user }), user);
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    }
    oauth(jwt());
    stale.answer(true);
    expect((await older).ok).toBe(true);

    // The older member answer was not cached, so Clerk is asked again.
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    expect(lookups()).toHaveLength(1_027);
    // Real loops of 1,027 authorizations run slowly on a loaded workerd.
  }, 15_000);
});

describe("clerkAuth membership cache eviction completion order", () => {
  it("INV-4: suppressing a newer refusal invalidates an older admission with 1024 other cached identities", async () => {
    oauth(jwt());
    const stale = heldLookup();
    const fresh = heldLookup();
    const auth = orgAuth();
    const older = auth.authorize(mcp(), BASE);
    await stale.sent;
    const newer = auth.authorize(mcp(), BASE);
    await fresh.sent;
    // These start later than Alice's lookups, so evicting any of them
    // raises the floor above both.
    for (let index = 0; index < 1_024; index++) {
      const user = `user_${index}`;
      oauth(jwt({ sub: user }), user);
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    }
    stale.answer(true);
    expect((await older).ok).toBe(true);
    fresh.answer(false);
    expect((await newer).ok).toBe(false);
    oauth(jwt());
    // The floor may suppress the refusal, but must not preserve the older
    // cached member answer. A fresh lookup still refuses Alice.
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    expect(lookups()).toHaveLength(1_027);
  }, 15_000);
});

/** Assert the fixed, retryable refusal without treating it as a membership answer. */
async function busy(result: Awaited<ReturnType<ReturnType<typeof orgAuth>["authorize"]>>, retry = "1") {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected busy refusal");
  expect(result.response.status).toBe(503);
  expect(result.response.headers.get("Retry-After")).toBe(retry);
  expect(await result.response.json()).toEqual({
    error: {
      code: "organization_lookup_busy",
      message: "Organization admission is temporarily busy. Retry later.",
      retryable: true,
    },
  });
}

describe("clerkAuth organization Backend API bounds", () => {
  beforeEach(() => oauth(jwt()));

  it("INV-6 INV-7: caps one identity at two request-owned lookups, refuses fast, and releases cancelled slots", async () => {
    const first = heldLookup();
    const second = heldLookup();
    const auth = orgAuth();
    const caller = new AbortController();
    const leaving = auth.authorize(mcp(caller.signal), BASE);
    await first.sent;
    const staying = auth.authorize(mcp(), BASE);
    await second.sent;
    for (const result of await Promise.all(Array.from({ length: 126 }, () => auth.authorize(mcp(), BASE)))) {
      await busy(result);
    }
    expect(lookups()).toHaveLength(2);
    expect(denials(warn)).toEqual(Array.from({ length: 126 }, () => ({ reason: "organization_lookup_busy" })));
    caller.abort();
    expect((await leaving).ok).toBe(false);
    // A cancelled lookup releases its slot. The busy refusals were not cached.
    const third = heldLookup();
    const replacement = auth.authorize(mcp(), BASE);
    await third.sent;
    third.answer(true);
    expect((await replacement).ok).toBe(true);
    second.answer(false);
    expect((await staying).ok).toBe(false);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
    expect(lookups()).toHaveLength(3);
  });

  it("INV-4 INV-7: caps Backend API calls at sixteen even for a full-server subscriptions/listen header probe", async () => {
    mocks.authenticateRequest.mockImplementation(async (request: Request) => {
      const userId = request.headers.get("Authorization")!.slice("Bearer ".length);
      return {
        toAuth: () => ({
          isAuthenticated: true,
          tokenType: "oauth_token",
          userId,
          clientId: "client_connecta",
          getToken: async () => jwt({ sub: userId }),
        }),
      };
    });
    const auth = orgAuth();
    const app = createTestConnecta({
      connectors: [],
      auth,
      storage: memoryStorage(),
      publicUrl: BASE,
      maintainers: [ALICE],
      logger: "silent",
    });
    const request = (userId: string) => {
      const req = mcp();
      req.headers.set("Authorization", `Bearer ${userId}`);
      req.headers.set("Mcp-Method", "subscriptions/listen");
      return app.fetch(req);
    };
    const held = Array.from({ length: 16 }, (_, index) => heldLookup(`user_${index}`));
    const pending: Promise<Response>[] = [];
    try {
      for (let index = 0; index < held.length; index++) {
        pending.push(request(`user_${index}`));
        await held[index]!.sent;
      }
      const refused = await Promise.all(Array.from({ length: 48 }, (_, index) => request(`user_over_${index}`)));
      for (const response of refused) {
        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
        expect(await response.json()).toMatchObject({ error: { code: "authentication_busy", retryable: true } });
      }
      expect(lookups()).toHaveLength(16);
      for (const lookup of held) lookup.answer(false);
      for (const response of await Promise.all(pending)) {
        expect(response.status).toBe(403);
        await response.text();
      }
      // All successful upstream completions release their counters too.
      const response = await request("user_next");
      expect(response.status).toBe(403);
      await response.text();
      expect(lookups()).toHaveLength(17);
    } finally {
      for (const lookup of held) lookup.answer(false);
      await Promise.allSettled(pending);
      await app.close();
    }
  });

  it("INV-7: caps the extra opaque verification in the same identity budget as membership", async () => {
    const held = [heldLookup(), heldLookup()];
    const auth = orgAuth();
    const pending = [auth.authorize(mcp(), BASE), auth.authorize(mcp(), BASE)];
    await Promise.all(held.map((lookup) => lookup.sent));
    oauth("oat_private");
    await busy(await auth.authorize(mcp(), BASE));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    held.forEach((lookup) => lookup.answer(false));
    await Promise.all(pending);
  });

  it.each([
    ["seconds", "2", 2_000],
    ["malformed", "planted-upstream-text", 10_000],
    ["bounded maximum", "99999999999999999999999", 60_000],
  ])(
    "INV-6 INV-7: backs off on 429 with %s Retry-After, serves cache hits, and retries only after expiry",
    async (_name, retryAfter, delay) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = new Date("2026-10-20T12:00:00Z").getTime();
      vi.setSystemTime(start);
      members.add(`${ORG}/${ALICE}`);
      const auth = orgAuth();
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
      oauth(jwt({ sub: BOB }), BOB);
      const { response, cancelled } = stalledResponse(429, "planted-upstream-text");
      if (retryAfter !== null) response.headers.set("Retry-After", retryAfter);
      mocks.fetch.mockResolvedValueOnce(response);
      await busy(await auth.authorize(mcp(), BASE), String(delay / 1_000));
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(lookupSignal(1).aborted).toBe(true);
      // An instance-level backoff blocks other identities too, without caching a denial.
      oauth(jwt({ sub: "user_other" }), "user_other");
      vi.setSystemTime(start + delay - 1);
      await busy(await auth.authorize(mcp(), BASE));
      oauth(jwt());
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
      expect(lookups()).toHaveLength(2);
      oauth(jwt({ sub: BOB }), BOB);
      vi.setSystemTime(start + delay);
      expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
      expect(lookups()).toHaveLength(3);
      expect(denials(warn)).toEqual([
        { reason: "organization_lookup_busy" },
        { reason: "organization_lookup_busy" },
        { reason: "organization_membership_denied" },
      ]);
    },
  );
});

describe("clerkAuth membership cache under clock steps", () => {
  const start = new Date("2026-10-20T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    oauth(jwt());
  });

  /** Alice is admitted and cached at `start`, then removed in Clerk. */
  async function removedAfterAdmission() {
    members.add(`${ORG}/${ALICE}`);
    const auth = orgAuth();
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(true);
    members.delete(`${ORG}/${ALICE}`);
    return auth;
  }

  it("INV-4: a member's answer expires when the clock steps back to before the lookup started", async () => {
    const auth = await removedAfterAdmission();
    vi.setSystemTime(start - 1);
    const result = await auth.authorize(mcp(), BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(lookups()).toHaveLength(2);
  });

  it("INV-4: an answer found expired stays expired when the clock steps back", async () => {
    const auth = await removedAfterAdmission();
    vi.setSystemTime(start + 61_000);
    // This lookup fails, so no newer answer replaces the expired one.
    mocks.fetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    vi.setSystemTime(start + 30_000);
    expect((await auth.authorize(mcp(), BASE)).ok).toBe(false);
    expect(lookups()).toHaveLength(3);
    expect(denials(warn)).toEqual([
      { reason: "organization_lookup_failed" },
      { reason: "organization_membership_denied" },
    ]);
  });
});

describe("clerkAuth organization membership on operator sessions", () => {
  it("INV-4: confirms membership for every operator session", async () => {
    session();
    const refused = await orgAuth().authorize(operator(), BASE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(403);
    members.add(`${ORG}/${ALICE}`);
    await expect(orgAuth().authorize(operator(), BASE)).resolves.toEqual({ ok: true, userId: ALICE });
    expect(lookups()).toHaveLength(2);
  });

  it("INV-6: refuses a session from another issuer before any lookup", async () => {
    members.add(`${ORG}/${ALICE}`);
    session({ iss: "https://clerk.other.example" });
    const result = await orgAuth().authorize(operator(), BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(lookups()).toHaveLength(0);
    expect(denials(warn)).toEqual([{ reason: "token_identity_mismatch" }]);
  });

  it("INV-4: ignores the organization a real v2 or v1 session names; membership decides", async () => {
    const { createClerkClient } = await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
    const keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const publicDer = new Uint8Array((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer);
    const jwtKey = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...publicDer))}\n-----END PUBLIC KEY-----`;
    const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)) as JsonWebKey;
    const clerk = createClerkClient({
      publishableKey,
      secretKey: "sk_test_fake",
      jwtKey,
      telemetry: { disabled: true },
    });
    mocks.authenticateRequest.mockImplementation((request, options) => clerk.authenticateRequest(request, options));
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>) =>
      signJwt(
        {
          sub: ALICE,
          sid: "sess_test",
          iss: FRONTEND,
          azp: BASE,
          iat: now - 5,
          nbf: now - 5,
          exp: now + 60,
          ...claims,
        },
        privateKey,
        { algorithm: "RS256", header: { typ: "JWT", kid: "test" } },
      );
    const cases: Record<string, unknown>[] = [{ v: 2, o: { id: ORG, rol: "admin", slg: "alpha" } }, { org_id: ORG }];
    for (const claims of cases) {
      const token = await sign(claims);
      for (const member of [true, false]) {
        if (member) members.add(`${ORG}/${ALICE}`);
        else members.clear();
        const request = operator();
        request.headers.set("Authorization", `Bearer ${token}`);
        const result = await orgAuth().authorize(request, BASE);
        expect(result.ok ? 200 : result.response.status).toBe(member ? 200 : 403);
      }
    }
    expect(lookups()).toHaveLength(4);
    // Real RSA key generation and verification run slowly on a loaded workerd.
  }, 15_000);
});
