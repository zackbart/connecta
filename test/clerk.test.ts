import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("clerkAuth inbound auth", () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockReset();
    mocks.getUser.mockReset();
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
  });

  // One clerkAuth per team — same keys, that team's `gate`, that team's
  // toolkits — is how a Clerk deployment binds users to views (§16).
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

  // allowedDomains decides WHO is admitted to the org (§5); a toolkit binding
  // decides WHICH view they get once admitted (§16).
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
