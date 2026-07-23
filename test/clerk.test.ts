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
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(request, {
      acceptsToken: ["oauth_token", "session_token"],
      authorizedParties: [BASE],
    });
  });
});
