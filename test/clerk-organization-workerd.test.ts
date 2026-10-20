// Organization membership lookups (src/auth/clerk.ts) inside workerd, with
// nothing in place of fetch. The workers project builds
// test/fixtures/clerk-organization-worker.ts into its own Worker, with the
// Worker example's compatibility settings, binds it here as
// CLERK_ORGANIZATION, and sends that Worker's outbound fetches over TCP to the
// Backend API stand-in in test/fixtures/clerk-backend-server.ts. Each call
// below is a separate request to that Worker, so lookups meet workerd's own
// Request validation and its rule that one request may not touch another's
// I/O. In the Node project the binding is absent and the suite skips.
import { describe, expect, inject, it, vi } from "vitest";
import { ORGANIZATION_ID, PUBLIC_URL } from "./fixtures/clerk-organization-deployment.js";

const worker = await (async () => {
  try {
    const testModule = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ testModule)) as { env: { CLERK_ORGANIZATION?: Fetcher } };
    return env.CLERK_ORGANIZATION;
  } catch {
    return undefined;
  }
})();

interface Exchange {
  path: string;
  outcome: "pending" | "answered" | "closed";
}

const backend = `http://${inject("clerkBackendServer")}/control`;

/** A user no other test touches, since every test shares the Worker's cache. */
function newUser(): string {
  return `user_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** An SDK-verified JWT access token for this deployment's `/mcp`. */
function jwt(userId: string): string {
  return [
    { alg: "RS256", typ: "at+jwt", kid: "test" },
    { sub: userId, iss: "https://clerk.example.com", aud: `${PUBLIC_URL}/mcp` },
    "signature",
  ]
    .map((part) => btoa(typeof part === "string" ? part : JSON.stringify(part)))
    .map((part) => part.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"))
    .join(".");
}

/** One request to the Worker, answered with its status and denial reasons. */
async function authorize(
  token: string,
  signal?: AbortSignal,
): Promise<{ status: number; denials: unknown[]; retryAfter?: string }> {
  const response = await worker!.fetch(`${PUBLIC_URL}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  return response.json();
}

async function control(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${backend}/${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body ?? null),
  });
  return response.json();
}

const script = (userId: string, steps: string[]) => control(`script/${userId}`, steps);
const release = (userId: string, index: number, member: boolean) =>
  control(`release/${userId}/${index}`, member ? "member" : "non-member");
const exchanges = (userId: string) => control(`log/${userId}`) as Promise<Exchange[]>;
const membershipPath = (userId: string) =>
  `api.clerk.com/v1/organizations/${ORGANIZATION_ID}/memberships?user_id=${userId}`;

/** Wait until the stand-in has seen `count` exchanges for this user. */
async function sent(userId: string, count: number): Promise<Exchange[]> {
  let seen: Exchange[] = [];
  await vi.waitFor(
    async () => {
      seen = await exchanges(userId);
      expect(seen).toHaveLength(count);
    },
    { timeout: 10_000, interval: 20 },
  );
  return seen;
}

describe.skipIf(!worker)("clerkAuth organization lookups in workerd", () => {
  it("INV-7: a membership lookup reaches the Backend API through workerd's fetch, and a redirect is refused", async () => {
    const member = newUser();
    await script(member, ["member"]);
    await expect(authorize(jwt(member))).resolves.toEqual({ status: 200, denials: [] });
    expect(await exchanges(member)).toEqual([{ path: membershipPath(member), outcome: "answered" }]);

    const redirected = newUser();
    await script(redirected, ["redirect", "member"]);
    await expect(authorize(jwt(redirected))).resolves.toEqual({
      status: 403,
      denials: [{ reason: "organization_lookup_failed" }],
    });
    // The redirect was not followed, and it was not cached.
    await expect(authorize(jwt(redirected))).resolves.toEqual({ status: 200, denials: [] });
    expect(await exchanges(redirected)).toEqual([
      { path: membershipPath(redirected), outcome: "answered" },
      { path: membershipPath(redirected), outcome: "answered" },
    ]);
  });

  it("INV-7: an opaque token's verification reaches the Backend API through workerd's fetch, and a redirect is refused", async () => {
    const userId = newUser();
    await control(`verifications/${userId}`, ["redirect"]);
    await script(userId, ["member"]);
    await expect(authorize(`oat_${userId}`)).resolves.toEqual({
      status: 401,
      denials: [{ reason: "oauth_verification_failed" }],
    });
    await expect(authorize(`oat_${userId}`)).resolves.toEqual({ status: 200, denials: [] });
    const verify = "api.clerk.com/v1/oauth_applications/access_tokens/verify";
    expect(await exchanges(userId)).toEqual([
      { path: verify, outcome: "answered" },
      { path: verify, outcome: "answered" },
      { path: membershipPath(userId), outcome: "answered" },
    ]);
  });

  it("INV-7: separate requests that miss the cache together each run their own lookup", async () => {
    const userId = newUser();
    await script(userId, ["hold", "hold"]);
    const first = authorize(jwt(userId));
    await sent(userId, 1);
    const second = authorize(jwt(userId));
    await sent(userId, 2);

    await release(userId, 1, true);
    await expect(second).resolves.toEqual({ status: 200, denials: [] });
    await release(userId, 0, true);
    await expect(first).resolves.toEqual({ status: 200, denials: [] });
    // The answer is cached for the next request.
    await expect(authorize(jwt(userId))).resolves.toEqual({ status: 200, denials: [] });
    expect((await exchanges(userId)).map(({ outcome }) => outcome)).toEqual(["answered", "answered"]);
  });

  it("INV-7: a request that leaves cancels only its own lookup", async () => {
    const userId = newUser();
    await script(userId, ["hold", "hold"]);
    const caller = new AbortController();
    const leaving = authorize(jwt(userId), caller.signal);
    await sent(userId, 1);
    const staying = authorize(jwt(userId));
    await sent(userId, 2);

    caller.abort();
    await expect(leaving).rejects.toThrow();
    await vi.waitFor(
      async () => expect((await exchanges(userId)).map(({ outcome }) => outcome)).toEqual(["closed", "pending"]),
      { timeout: 10_000, interval: 20 },
    );
    await release(userId, 1, true);
    await expect(staying).resolves.toEqual({ status: 200, denials: [] });
    await expect(authorize(jwt(userId))).resolves.toEqual({ status: 200, denials: [] });
    expect(await exchanges(userId)).toHaveLength(2);
  });

  it.each([
    ["an older member answer after a newer refusal", true, false],
    ["an older refusal after a newer member answer", false, true],
  ])("INV-4: across requests, never lets %s replace the newer verdict", async (_name, older, newer) => {
    const userId = newUser();
    await script(userId, ["hold", "hold"]);
    const first = authorize(jwt(userId));
    await sent(userId, 1);
    const second = authorize(jwt(userId));
    await sent(userId, 2);

    await release(userId, 1, newer);
    expect((await second).status).toBe(newer ? 200 : 403);
    await release(userId, 0, older);
    expect((await first).status).toBe(older ? 200 : 403);
    expect((await authorize(jwt(userId))).status).toBe(newer ? 200 : 403);
    expect(await exchanges(userId)).toHaveLength(2);
  });
  it("INV-6 INV-7: separate requests share only counters for the two-lookups-per-identity cap", async () => {
    const userId = newUser();
    await script(userId, ["hold", "hold", "member"]);
    const first = authorize(jwt(userId));
    await sent(userId, 1);
    const second = authorize(jwt(userId));
    await sent(userId, 2);
    await expect(authorize(jwt(userId))).resolves.toEqual({
      status: 503,
      denials: [{ reason: "organization_lookup_busy" }],
      retryAfter: "1",
    });
    expect(await exchanges(userId)).toHaveLength(2);
    await release(userId, 0, false);
    expect((await first).status).toBe(403);
    await release(userId, 1, true);
    expect((await second).status).toBe(200);
    // The cache is served; the busy refusal did not become a cached denial.
    expect((await authorize(jwt(userId))).status).toBe(200);
    expect(await exchanges(userId)).toHaveLength(2);
  });

  it("INV-7: separate requests enforce the sixteen-lookup isolate cap and release every slot", async () => {
    const users = Array.from({ length: 16 }, newUser);
    const pending: Promise<{ status: number }>[] = [];
    try {
      for (const userId of users) {
        await script(userId, ["hold"]);
        pending.push(authorize(jwt(userId)));
        await sent(userId, 1);
      }
      const extra = newUser();
      await script(extra, ["member"]);
      await expect(authorize(jwt(extra))).resolves.toEqual({
        status: 503,
        denials: [{ reason: "organization_lookup_busy" }],
        retryAfter: "1",
      });
      expect(await exchanges(extra)).toHaveLength(0);
      await Promise.all(users.map((userId) => release(userId, 0, false)));
      expect((await Promise.all(pending)).map(({ status }) => status)).toEqual(Array(16).fill(403));
      expect((await authorize(jwt(extra))).status).toBe(200);
      expect(await exchanges(extra)).toHaveLength(1);
    } finally {
      await Promise.all(users.map((userId) => release(userId, 0, false)));
      await Promise.allSettled(pending);
    }
  }, 15_000);

  it("INV-6 INV-7: a separate request's native 429 starts backoff for other misses while cache hits still work", async () => {
    const member = newUser();
    await script(member, ["member"]);
    expect((await authorize(jwt(member))).status).toBe(200);
    const limited = newUser();
    await script(limited, ["rate-limited", "member"]);
    await expect(authorize(jwt(limited))).resolves.toEqual({
      status: 503,
      denials: [{ reason: "organization_lookup_busy" }],
      retryAfter: "1",
    });
    const other = newUser();
    await expect(authorize(jwt(other))).resolves.toEqual({
      status: 503,
      denials: [{ reason: "organization_lookup_busy" }],
      retryAfter: "1",
    });
    expect(await exchanges(other)).toHaveLength(0);
    expect((await authorize(jwt(member))).status).toBe(200);
    expect(await exchanges(member)).toHaveLength(1);
    await vi.waitFor(async () => expect((await authorize(jwt(limited))).status).toBe(200), {
      timeout: 5_000,
      interval: 50,
    });
    expect(await exchanges(limited)).toEqual([
      { path: membershipPath(limited), outcome: "answered" },
      { path: membershipPath(limited), outcome: "answered" },
    ]);
    expect((await authorize(jwt(other))).status).toBe(403);
    expect(await exchanges(other)).toHaveLength(1);
  });
});
