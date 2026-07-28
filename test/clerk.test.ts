import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    authenticateRequest: mocks.authenticateRequest,
    users: { getUser: mocks.getUser },
  }),
}));

import { clerkAuth } from "../src/auth/clerk.js";

const BASE = "https://connecta.test";
const domain = "clerk.example.com$";
const publishableKey =
  "pk_test_" + Buffer.from(domain, "utf8").toString("base64");
const friendlyUser = (fullName = "Ada Lovelace") => ({
  fullName,
  firstName: "Ada",
  lastName: "Lovelace",
  username: "ada",
  primaryEmailAddressId: "primary",
  emailAddresses: [
    {
      id: "primary",
      emailAddress: "ada@example.com",
      verification: { status: "verified" },
    },
  ],
});

describe("clerkAuth inbound auth", () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockReset();
    mocks.getUser.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes public ClerkJS configuration to the status UI", () => {
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      publicUrl: BASE,
      signInUrl: "https://accounts.example.com/sign-in",
      signUpUrl: "https://accounts.example.com/sign-up",
    });

    expect(auth.uiAuth).toEqual({
      kind: "clerk",
      publishableKey,
      frontendApiUrl: "https://clerk.example.com",
      signInUrl: "https://accounts.example.com/sign-in",
      signUpUrl: "https://accounts.example.com/sign-up",
    });
    expect(auth.activityActorNamespace).toBe("https://clerk.example.com");
  });

  it("resolves and caches friendly activity labels without affecting auth", async () => {
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      publicUrl: BASE,
    });
    mocks.getUser.mockResolvedValue({
      fullName: "  Zack   Bart ",
      firstName: "Zack",
      lastName: "Bart",
      username: "zack",
      primaryEmailAddressId: "primary",
      emailAddresses: [
        {
          id: "primary",
          emailAddress: "zack@example.com",
          verification: { status: "verified" },
        },
      ],
    });

    await expect(auth.activityActorLabel!("user_123")).resolves.toBe(
      "Zack Bart",
    );
    await expect(auth.activityActorLabel!("user_123")).resolves.toBe(
      "Zack Bart",
    );
    expect(mocks.getUser).toHaveBeenCalledTimes(1);

    mocks.getUser.mockResolvedValue({
      fullName: null,
      firstName: null,
      lastName: null,
      username: null,
      primaryEmailAddressId: "primary",
      emailAddresses: [
        {
          id: "primary",
          emailAddress: "operator@example.com",
          verification: { status: "verified" },
        },
      ],
    });
    await expect(auth.activityActorLabel!("user_email")).resolves.toBe(
      "operator@example.com",
    );

    mocks.getUser.mockRejectedValue(new Error("Clerk unavailable"));
    await expect(
      auth.activityActorLabel!("user_offline"),
    ).resolves.toBeUndefined();
    const callsAfterFailure = mocks.getUser.mock.calls.length;
    await expect(
      auth.activityActorLabel!("user_offline"),
    ).resolves.toBeUndefined();
    expect(mocks.getUser).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it("does not use an unverified email as an activity label", async () => {
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
    });
    mocks.getUser.mockResolvedValue({
      fullName: null,
      firstName: null,
      lastName: null,
      username: "friendly-handle",
      primaryEmailAddressId: "primary",
      emailAddresses: [
        {
          id: "primary",
          emailAddress: "unverified@example.com",
          verification: { status: "unverified" },
        },
      ],
    });

    await expect(auth.activityActorLabel!("user_123")).resolves.toBe(
      "friendly-handle",
    );
  });

  it("coalesces concurrent activity label lookups for one id", async () => {
    let resolveUser!: (user: ReturnType<typeof friendlyUser>) => void;
    mocks.getUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
    });

    const first = auth.activityActorLabel!("user_123");
    const second = auth.activityActorLabel!("user_123");
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    resolveUser(friendlyUser());

    await expect(first).resolves.toBe("Ada Lovelace");
    await expect(second).resolves.toBe("Ada Lovelace");
  });

  it("bounds labels and refreshes them after the success TTL", async () => {
    vi.useFakeTimers();
    mocks.getUser.mockResolvedValue(friendlyUser(`  ${"A".repeat(200)}  `));
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
    });

    const first = await auth.activityActorLabel!("user_123");
    expect(first).toBe("A".repeat(160));
    mocks.getUser.mockResolvedValue(friendlyUser("Grace Hopper"));
    await expect(auth.activityActorLabel!("user_123")).resolves.toBe(first);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(auth.activityActorLabel!("user_123")).resolves.toBe(
      "Grace Hopper",
    );
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
  });

  it("caps hung Clerk activity lookups across concurrent readers", async () => {
    vi.useFakeTimers();
    mocks.getUser.mockImplementation(() => new Promise(() => {}));
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
    });

    const lookups = Array.from({ length: 12 }, (_, index) =>
      auth.activityActorLabel!(`user_${index}`),
    );
    expect(mocks.getUser).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(Promise.all(lookups)).resolves.toEqual(
      Array(12).fill(undefined),
    );

    // Caller-facing promises and pending-map entries have settled, but the
    // eight raw Clerk calls are still physically hung. Do not start a ninth.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(
      auth.activityActorLabel!("user_after_timeout"),
    ).resolves.toBeUndefined();
    expect(mocks.getUser).toHaveBeenCalledTimes(8);
  });

  it("uses a late Clerk result after the caller-facing lookup timed out", async () => {
    vi.useFakeTimers();
    let resolveUser!: (user: ReturnType<typeof friendlyUser>) => void;
    mocks.getUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
    });

    const first = auth.activityActorLabel!("user_123");
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(first).resolves.toBeUndefined();

    resolveUser(friendlyUser());
    await vi.advanceTimersByTimeAsync(0);
    await expect(auth.activityActorLabel!("user_123")).resolves.toBe(
      "Ada Lovelace",
    );
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });

  // One clerkAuth per team — same keys, that team's `gate`, that team's
  // toolkits — is how a Clerk deployment binds users to views (documentation/toolkits.md).
  it("declares the toolkit binding for the users it admits", () => {
    const bound = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      gate: (userId) => userId === "user_support",
      toolkits: ["support"],
    });
    expect(bound.toolkitBinding).toEqual({ toolkits: ["support"] });
    expect(
      clerkAuth({ publishableKey, secretKey: "sk_test_fake" }).toolkitBinding,
    ).toBeUndefined();
    expect(() =>
      clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        unscoped: true,
      }),
    ).toThrow("clerkAuth: `unscoped` only means something beside `toolkits`");
  });

  it("accepts Clerk OAuth and browser session tokens for the connecta origin", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      toAuth: () => ({ isAuthenticated: true, userId: "user_123" }),
    });
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      publicUrl: BASE,
    });
    const request = new Request(`${BASE}/ui/data`, {
      headers: { Authorization: "Bearer clerk-session-jwt" },
    });

    await expect(auth.authorize(request, BASE)).resolves.toEqual({
      ok: true,
      userId: "user_123",
    });
    // authorizedParties must not be passed: OAuth access tokens may carry no
    // azp claim and Clerk rejects azp=undefined when it is set.
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(request, {
      acceptsToken: ["oauth_token", "session_token"],
    });
  });

  it("accepts an OAuth access token without an azp claim", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      toAuth: () => ({
        isAuthenticated: true,
        userId: "user_oauth",
        tokenType: "oauth_token",
      }),
    });
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      publicUrl: BASE,
    });
    const request = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer azp-less-oauth-jwt" },
    });

    await expect(auth.authorize(request, BASE)).resolves.toEqual({
      ok: true,
      userId: "user_oauth",
    });
  });

  it("still rejects a session token minted for a sibling origin", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      toAuth: () => ({
        isAuthenticated: true,
        userId: "user_123",
        tokenType: "session_token",
        sessionClaims: { azp: "https://billing.example.com" },
      }),
    });
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      publicUrl: BASE,
    });
    const request = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer replayed-session-jwt" },
    });

    const result = await auth.authorize(request, BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  // allowedDomains decides WHO is admitted to the org (documentation/auth.md); a
  // toolkit binding decides WHICH view they get once admitted
  // (documentation/toolkits.md).
  describe("allowedDomains", () => {
    /** A Clerk user with one primary email, verified unless told otherwise. */
    const userWithEmail = (
      emailAddress: string,
      status: string | null = "verified",
    ) => ({
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        {
          id: "idn_primary",
          emailAddress,
          verification: status === null ? null : { status },
        },
      ],
    });

    const authorize = async (
      options: Partial<Parameters<typeof clerkAuth>[0]>,
    ) => {
      mocks.authenticateRequest.mockResolvedValue({
        toAuth: () => ({ isAuthenticated: true, userId: "user_123" }),
      });
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
        ...options,
      });
      return auth.authorize(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: { Authorization: "Bearer oauth-token" },
        }),
        BASE,
      );
    };

    it("rejects a garbage allowlist at construction", () => {
      const build = (allowedDomains: unknown) =>
        clerkAuth({
          publishableKey,
          secretKey: "sk_test_fake",
          allowedDomains: allowedDomains as string[],
        });
      // An empty list is fail-closed if honored and fail-open if read as "no
      // restriction" — neither is what anyone meant to write.
      expect(() => build([])).toThrow("`allowedDomains` is empty");
      expect(() => build("acme.com")).toThrow("must be an array");
      expect(() => build([""])).toThrow("is not a domain");
      expect(() => build(["acme"])).toThrow("is not a domain");
      expect(() => build(["acme .com"])).toThrow("is not a domain");
      expect(() => build(["-acme.com"])).toThrow("is not a domain");
      expect(() => build(["acme.com."])).toThrow("is not a domain");
      expect(() => build(["https://acme.com"])).toThrow("is not a domain");
      // A Unicode lookalike must be spelled in punycode, so the allowlist can
      // never contain a domain the operator cannot tell from theirs by eye.
      expect(() => build(["acmé.com"])).toThrow("is not a domain");
      expect(() => build([42])).toThrow("is not a string");
      expect(() => build(["me@acme.com"])).toThrow(
        "Write the domain alone, with no `@`",
      );
      expect(() => build(["ACME.com", " acme.co.uk "])).not.toThrow();
    });

    it("admits a user whose verified primary email is on an allowed domain", async () => {
      mocks.getUser.mockResolvedValue(userWithEmail("dev@acme.com"));
      await expect(authorize({ allowedDomains: ["acme.com"] })).resolves.toEqual(
        { ok: true, userId: "user_123" },
      );
    });

    it("matches the domain case-insensitively on both sides", async () => {
      mocks.getUser.mockResolvedValue(userWithEmail("Dev@ACME.Com"));
      await expect(
        authorize({ allowedDomains: [" Acme.COM "] }),
      ).resolves.toEqual({ ok: true, userId: "user_123" });
    });

    it("rejects a user on a domain nobody listed, with the gate's 403", async () => {
      mocks.getUser.mockResolvedValue(userWithEmail("dev@other.com"));
      const result = await authorize({ allowedDomains: ["acme.com"] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        // No hint about WHY — the caller learns only that they are not welcome.
        await expect(result.response.json()).resolves.toEqual({
          error: "forbidden",
        });
      }
    });

    it("rejects lookalikes, subdomains and substrings of an allowed domain", async () => {
      for (const email of [
        "dev@evil-acme.com", // substring on the left
        "dev@acme.com.evil.com", // substring on the right
        "dev@mail.acme.com", // subdomain, not spelled
        "dev@acme.co", // prefix of the label
        "dev@xacme.com",
        '"dev@acme.com"@evil.com', // allowed domain hidden in the local part
      ]) {
        mocks.getUser.mockResolvedValue(userWithEmail(email));
        const result = await authorize({ allowedDomains: ["acme.com"] });
        expect(result.ok, email).toBe(false);
      }
    });

    it("admits a subdomain only when it is spelled out", async () => {
      mocks.getUser.mockResolvedValue(userWithEmail("dev@mail.acme.com"));
      await expect(
        authorize({ allowedDomains: ["mail.acme.com"] }),
      ).resolves.toEqual({ ok: true, userId: "user_123" });
    });

    it("fails closed when the email is missing, unverified or malformed", async () => {
      const cases = [
        { primaryEmailAddressId: null, emailAddresses: [] },
        { primaryEmailAddressId: "idn_primary", emailAddresses: [] },
        userWithEmail("dev@acme.com", "unverified"),
        userWithEmail("dev@acme.com", null),
        userWithEmail("not-an-email"),
        userWithEmail("@acme.com"),
      ];
      for (const user of cases) {
        mocks.getUser.mockResolvedValue(user);
        const result = await authorize({ allowedDomains: ["acme.com"] });
        expect(result.ok, JSON.stringify(user)).toBe(false);
        if (!result.ok) expect(result.response.status).toBe(403);
      }
    });

    // A malformed address must never be *repaired* into a match: trimming,
    // stripping the root dot, or case-folding a Unicode lookalike would each
    // turn one of these into `acme.com`. They deny instead — the last two are
    // deliberate fail-closed false negatives, not matches we merely lost.
    it("denies a malformed address rather than normalizing it into a match", async () => {
      for (const email of [
        "dev@ acme.com", // leading space inside the domain
        "dev@acme.com ", // trailing space
        "dev@\tacme.com", // tab
        "dev@acme.com\n", // newline
        "dev@acme.com　", // ideographic space
        "dev@acme.com.", // trailing root dot — equivalent to a mail system
        "dev@aKme.com", // KELVIN SIGN, which toLowerCase folds to "k"
      ]) {
        mocks.getUser.mockResolvedValue(userWithEmail(email));
        // `akme.com` is listed too, so the KELVIN SIGN case is denied by the
        // grammar running first, not by the fold landing outside the list.
        const result = await authorize({
          allowedDomains: ["acme.com", "akme.com"],
        });
        expect(result.ok, JSON.stringify(email)).toBe(false);
      }
      // The same fold on the allowlist side is a construction error, not a
      // silently ASCII-ified entry.
      expect(() =>
        clerkAuth({
          publishableKey,
          secretKey: "sk_test_fake",
          allowedDomains: ["aKme.com"],
        }),
      ).toThrow("is not a domain");
    });

    it("fails closed when the Clerk lookup itself fails", async () => {
      mocks.getUser.mockRejectedValue(new Error("clerk 500"));
      const result = await authorize({ allowedDomains: ["acme.com"] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    });

    it("composes with `gate` — either one can deny", async () => {
      mocks.getUser.mockResolvedValue(userWithEmail("dev@acme.com"));
      await expect(
        authorize({ allowedDomains: ["acme.com"], gate: () => true }),
      ).resolves.toEqual({ ok: true, userId: "user_123" });

      // The gate denies a user the domain admits.
      expect(
        (await authorize({ allowedDomains: ["acme.com"], gate: () => false }))
          .ok,
      ).toBe(false);

      // The domain denies a user the gate admits — and the allowlist runs
      // first, so an outsider never reaches operator gate code.
      const gate = vi.fn(() => true);
      mocks.getUser.mockResolvedValue(userWithEmail("dev@other.com"));
      expect((await authorize({ allowedDomains: ["acme.com"], gate })).ok).toBe(
        false,
      );
      expect(gate).not.toHaveBeenCalled();
    });

    it("logs the denied domain bounded, and never the address", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A denial names the domain for the operator — bounded, so a 253-byte
      // domain cannot flood the log — and never the local part.
      mocks.getUser.mockResolvedValue(
        userWithEmail(
          `secret-person@${"a".repeat(60)}.${"b".repeat(60)}.example.com`,
        ),
      );
      await authorize({ allowedDomains: ["acme.com"] });
      const denied = warn.mock.calls.map(String).join("\n");
      expect(denied).toContain("user_123");
      expect(denied).toContain("(truncated)");
      expect(denied.length).toBeLessThan(250);
      expect(denied).not.toContain("secret-person");

      // A malformed address never reaches that line at all, so a
      // caller-controlled newline has nothing to forge a log line with.
      warn.mockClear();
      mocks.getUser.mockResolvedValue(
        userWithEmail("secret-person@evil.com\n[connecta] forged"),
      );
      await authorize({ allowedDomains: ["acme.com"] });
      const malformed = warn.mock.calls.map(String).join("\n");
      expect(malformed).toContain("no verified primary email");
      expect(malformed).not.toContain("secret-person");
      expect(malformed).not.toContain("forged");
      warn.mockRestore();
    });

    it("caches the combined verdict, so composing costs no extra Clerk calls", async () => {
      mocks.authenticateRequest.mockResolvedValue({
        toAuth: () => ({ isAuthenticated: true, userId: "user_123" }),
      });
      mocks.getUser.mockResolvedValue(userWithEmail("dev@acme.com"));
      const gate = vi.fn(() => true);
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
        allowedDomains: ["acme.com"],
        gate,
      });
      const request = () =>
        auth.authorize(
          new Request(`${BASE}/mcp`, {
            method: "POST",
            headers: { Authorization: "Bearer oauth-token" },
          }),
          BASE,
        );

      await expect(request()).resolves.toEqual({ ok: true, userId: "user_123" });
      await expect(request()).resolves.toEqual({ ok: true, userId: "user_123" });
      expect(mocks.getUser).toHaveBeenCalledTimes(1);
      expect(gate).toHaveBeenCalledTimes(1);
    });

    it("bounds denied identities and re-checks an evicted identity", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.authenticateRequest.mockImplementation(async (request: Request) => {
        const userId = request.headers
          .get("authorization")!
          .replace("Bearer ", "");
        return {
          toAuth: () => ({ isAuthenticated: true, userId }),
        };
      });
      mocks.getUser.mockImplementation(async (userId: string) =>
        userWithEmail(`${userId}@outside.example`),
      );
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
        allowedDomains: ["acme.com"],
      });
      const request = (userId: string) =>
        auth.authorize(
          new Request(`${BASE}/mcp`, {
            method: "POST",
            headers: { Authorization: `Bearer ${userId}` },
          }),
          BASE,
        );

      // Fill the 1,024-identity bound, then make the oldest entry recently used.
      for (let index = 0; index < 1_024; index++) {
        const result = await request(`user_${index}`);
        expect(result.ok).toBe(false);
      }
      expect(mocks.getUser).toHaveBeenCalledTimes(1_024);
      expect((await request("user_0")).ok).toBe(false);
      expect(mocks.getUser).toHaveBeenCalledTimes(1_024);

      // A 1,025th distinct denial displaces the least recently used entry
      // rather than growing the Map.
      expect((await request("user_1024")).ok).toBe(false);
      expect(mocks.getUser).toHaveBeenCalledTimes(1_025);

      // The touched entry remains cached, while user_1 was evicted. The latter
      // is checked with Clerk again and remains denied; eviction can never turn
      // a refusal into an admission.
      expect((await request("user_0")).ok).toBe(false);
      expect(mocks.getUser).toHaveBeenCalledTimes(1_025);
      expect((await request("user_1")).ok).toBe(false);
      expect(mocks.getUser).toHaveBeenCalledTimes(1_026);
      warn.mockRestore();
    });

    it("keeps allow and deny TTLs unchanged for a small steady set", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-26T12:00:00Z"));
      mocks.authenticateRequest.mockImplementation(async (request: Request) => {
        const userId = request.headers
          .get("authorization")!
          .replace("Bearer ", "");
        return {
          toAuth: () => ({ isAuthenticated: true, userId }),
        };
      });
      mocks.getUser.mockImplementation(async (userId: string) =>
        userWithEmail(
          userId === "allowed" ? "dev@acme.com" : "dev@outside.example",
        ),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
        allowedDomains: ["acme.com"],
      });
      const request = (userId: string) =>
        auth.authorize(
          new Request(`${BASE}/mcp`, {
            method: "POST",
            headers: { Authorization: `Bearer ${userId}` },
          }),
          BASE,
        );
      const lookupCount = (userId: string) =>
        mocks.getUser.mock.calls.filter(([id]) => id === userId).length;

      expect((await request("allowed")).ok).toBe(true);
      expect((await request("denied")).ok).toBe(false);
      await request("allowed");
      await request("denied");
      expect(lookupCount("allowed")).toBe(1);
      expect(lookupCount("denied")).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      await request("allowed");
      await request("denied");
      expect(lookupCount("allowed")).toBe(1);
      expect(lookupCount("denied")).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000);
      await request("allowed");
      await request("denied");
      expect(lookupCount("allowed")).toBe(2);
      expect(lookupCount("denied")).toBe(3);
      warn.mockRestore();
    });

    it("changes nothing when the option is unset", async () => {
      await expect(authorize({})).resolves.toEqual({
        ok: true,
        userId: "user_123",
      });
      // No allowlist ⇒ no user lookup at all, exactly as before.
      expect(mocks.getUser).not.toHaveBeenCalled();

      const gate = vi.fn(() => true);
      await expect(authorize({ gate })).resolves.toEqual({
        ok: true,
        userId: "user_123",
      });
      expect(gate).toHaveBeenCalledWith("user_123", expect.anything());
      expect(mocks.getUser).not.toHaveBeenCalled();
    });
  });

  it("accepts a session token whose azp matches this deployment", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      toAuth: () => ({
        isAuthenticated: true,
        userId: "user_123",
        tokenType: "session_token",
        sessionClaims: { azp: BASE },
      }),
    });
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      publicUrl: BASE,
    });
    const request = new Request(`${BASE}/ui/data`, {
      headers: { Authorization: "Bearer clerk-session-jwt" },
    });

    await expect(auth.authorize(request, BASE)).resolves.toEqual({
      ok: true,
      userId: "user_123",
    });
  });
});
