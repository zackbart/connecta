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
