import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getUser: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../src/auth/clerk-transport.js", () => ({
  createByteReadingClerkClient: (_options: unknown, signal?: AbortSignal) => ({
    authenticateRequest: mocks.authenticateRequest,
    users: { getUser: (id: string) => mocks.getUser(id, signal) },
  }),
}));

import { clerkAuth } from "../src/auth/clerk.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";

import type { Connector } from "../src/types.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { oauthVault } from "./fixtures/oauth.js";

describe("OAuth browser token policy", () => {
  it("requires a browser session on every callback method", async () => {
    const authScope = "personal";
    mocks.authenticateRequest.mockReset();
    mocks.authenticateRequest.mockImplementation(
      async (request: Request, options: { acceptsToken: string | string[] }) => {
        const oauth = request.headers.get("authorization") === "Bearer mcp-oauth-token";
        const session = request.headers.get("cookie") === "__session=alice";
        const accepted = session || (oauth && [options.acceptsToken].flat().includes("oauth_token"));
        return {
          status: accepted ? "signed-in" : "signed-out",
          headers: new Headers(),
          toAuth: () =>
            accepted
              ? session
                ? { isAuthenticated: true, userId: "alice", tokenType: "session_token", sessionClaims: { azp: BASE } }
                : browserFlowMcpAuth("alice")
              : { isAuthenticated: false },
        };
      },
    );
    const finishAuth = vi.fn(async () => {});
    const connector: Connector = {
      id: "service",
      authScope,
      listTools: async () => [],
      callTool: async () => null,
      startAuth: async (ctx) => {
        await ctx.storage.set("state", "flow-state");
        return { state: "auth_required", authorizationUrl: "https://consent.example/authorize?state=flow-state" };
      },
      verifyState: async (state, ctx) => state === (await ctx.storage.get("state")),
      finishAuth,
    };
    const storage = memoryStorage();
    const app = createTestConnecta({
      connectors: [connector],
      storage,
      publicUrl: BASE,
      logger: "silent",
      vault: oauthVault(storage),
      auth: clerkAuth({ publishableKey, secretKey: "sk_test_fake", publicUrl: BASE }),
      maintainers: ["alice"],
    });
    try {
      const rpc = await readJsonRpc(
        await mcpRpc(
          app,
          "tools/call",
          { name: "authorize_connector", arguments: { connector: "service" } },
          { token: "mcp-oauth-token" },
        ),
      );
      const link = JSON.parse(rpc.result.content[0].text).authorizationUrl;
      const refusedStart = await app.fetch(new Request(link, { headers: { Authorization: "Bearer mcp-oauth-token" } }));
      expect(refusedStart.status).toBe(401);
      expect(refusedStart.headers.get("WWW-Authenticate")).toContain('scope="openid profile email"');
      expect((await app.fetch(new Request(`${link}&start=1`, { headers: { Cookie: "__session=alice" } }))).status).toBe(
        302,
      );
      const callback = `${BASE}/oauth/callback/service?code=code&state=flow-state`;
      const refusedCallback = await app.fetch(
        new Request(callback, { headers: { Authorization: "Bearer mcp-oauth-token" } }),
      );
      expect(refusedCallback.status).toBe(401);
      expect(refusedCallback.headers.get("WWW-Authenticate")).toContain('scope="openid profile email"');
      expect(finishAuth).not.toHaveBeenCalled();
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        const result = await app.fetch(
          new Request(callback, { method, headers: { Authorization: "Bearer mcp-oauth-token" } }),
        );
        expect(result.status).toBe(405);
        expect(result.headers.get("Allow")).toBe("GET");
        expect(finishAuth).not.toHaveBeenCalled();
      }
      expect((await app.fetch(new Request(callback, { headers: { Cookie: "__session=alice" } }))).status).toBe(200);
      expect(finishAuth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

const BASE = "https://connecta.test";
const domain = "clerk.example.com$";
const publishableKey = "pk_test_" + Buffer.from(domain, "utf8").toString("base64");
// Browser-flow setup enters through MCP with a resource-bound OAuth token.
function browserFlowMcpAuth(userId: string) {
  const token = [
    btoa(JSON.stringify({ alg: "RS256", typ: "at+jwt" })),
    btoa(JSON.stringify({ sub: userId, aud: `${BASE}/mcp` })),
    btoa("signature"),
  ]
    .map((part) => part.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"))
    .join(".");
  return {
    isAuthenticated: true,
    userId,
    tokenType: "oauth_token",
    clientId: "client_connecta",
    getToken: async () => token,
  };
}

const opaqueVerification = (claims: Record<string, unknown> = {}) => ({
  object: "clerk_idp_oauth_access_token",
  id: "oat_verified",
  client_id: "client_connecta",
  subject: "user_123",
  scopes: ["openid", "profile", "email"],
  revoked: false,
  revocation_reason: null,
  expired: false,
  expiration: Date.now() + 300_000,
  created_at: Date.now(),
  updated_at: Date.now(),
  ...claims,
});

describe("clerkAuth inbound auth", () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockReset();
    mocks.getUser.mockReset();
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async () => {
      const state = await mocks.authenticateRequest.mock.results.at(-1)!.value;
      const auth = state.toAuth();
      return Response.json(opaqueVerification({ subject: auth.userId, client_id: auth.clientId }));
    });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("resolves and caches friendly activity labels without affecting auth", async () => {
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      allowedOAuthClientIds: ["client_connecta"],
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

    await expect(auth.activityActorLabel!("user_123")).resolves.toBe("Zack Bart");
    await expect(auth.activityActorLabel!("user_123")).resolves.toBe("Zack Bart");
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
    await expect(auth.activityActorLabel!("user_email")).resolves.toBe("operator@example.com");

    mocks.getUser.mockRejectedValue(new Error("Clerk unavailable"));
    await expect(auth.activityActorLabel!("user_offline")).resolves.toBeUndefined();
    const callsAfterFailure = mocks.getUser.mock.calls.length;
    await expect(auth.activityActorLabel!("user_offline")).resolves.toBeUndefined();
    expect(mocks.getUser).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it("INV-7: aborts the Clerk label transport and refuses a late cache write", async () => {
    let release!: (user: { fullName: string }) => void;
    mocks.getUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const auth = clerkAuth({ publishableKey, secretKey: "sk_test_fake" });
    const owner = new AbortController();
    const lookup = auth.activityActorLabel!("alice", owner.signal);
    await Promise.resolve();
    const signal = mocks.getUser.mock.calls.at(-1)![1] as AbortSignal;
    owner.abort();
    await expect(lookup).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    release({ fullName: "Late name" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.getUser.mockResolvedValueOnce({ fullName: "Current name" });
    await expect(auth.activityActorLabel!("alice")).resolves.toBe("Current name");
  });

  it("caps hung Clerk activity lookups across concurrent readers", async () => {
    vi.useFakeTimers();
    mocks.getUser.mockImplementation(() => new Promise(() => {}));
    const auth = clerkAuth({
      publishableKey,
      secretKey: "sk_test_fake",
      allowedOAuthClientIds: ["client_connecta"],
    });

    const lookups = Array.from({ length: 12 }, (_, index) => auth.activityActorLabel!(`user_${index}`));
    await Promise.resolve();
    expect(mocks.getUser).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(Promise.all(lookups)).resolves.toEqual(Array(12).fill(undefined));

    // Caller-facing promises and pending-map entries have settled, but the
    // eight raw Clerk calls are still physically hung. Do not start a ninth.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(auth.activityActorLabel!("user_after_timeout")).resolves.toBeUndefined();
    expect(mocks.getUser).toHaveBeenCalledTimes(8);
  });

  it("refreshes Clerk browser sessions on connect and callback for OAuth", async () => {
    const authScope = "personal";
    const signedIn = () => ({
      status: "signed-in",
      headers: new Headers({ "Set-Cookie": "__session=fresh; Secure; HttpOnly" }),
      toAuth: () => ({
        isAuthenticated: true,
        userId: "alice",
        tokenType: "session_token",
        sessionClaims: { azp: BASE },
      }),
    });
    mocks.authenticateRequest.mockImplementation(async (request: Request) => {
      if (request.headers.get("authorization") === "Bearer alice") {
        return { status: "signed-in", headers: new Headers(), toAuth: () => browserFlowMcpAuth("alice") };
      }
      if (request.headers.get("cookie") === "__session=expired") {
        return {
          status: "handshake",
          headers: new Headers({
            Location: `https://clerk.example.com/v1/client/handshake?redirect_url=${encodeURIComponent(request.url)}`,
            "Set-Cookie": "__clerk_hs=refresh; Secure",
          }),
          toAuth: () => {
            throw new Error("handshake is not an identity");
          },
        };
      }
      return signedIn();
    });
    const finishAuth = vi.fn(async () => {});
    const connector: Connector = {
      id: "service",
      authScope,
      listTools: async () => [],
      callTool: async () => null,
      startAuth: async (ctx) => {
        await ctx.storage.set("state", "flow-state");
        return { state: "auth_required", authorizationUrl: "https://consent.example/authorize?state=flow-state" };
      },
      verifyState: async (state, ctx) => state === (await ctx.storage.get("state")),
      finishAuth,
    };
    const storage = memoryStorage();
    const app = createTestConnecta({
      connectors: [connector],
      storage,
      publicUrl: BASE,
      logger: "silent",
      vault: oauthVault(storage),
      auth: clerkAuth({ publishableKey, secretKey: "sk_test_fake", publicUrl: BASE }),
      maintainers: ["alice"],
    });
    try {
      const rpc = await readJsonRpc(
        await mcpRpc(
          app,
          "tools/call",
          { name: "authorize_connector", arguments: { connector: "service" } },
          { token: "alice" },
        ),
      );
      const link = JSON.parse(rpc.result.content[0].text).authorizationUrl;
      const handshake = await app.fetch(new Request(link, { headers: { Cookie: "__session=expired" } }));
      expect(handshake.status).toBe(307);
      expect(handshake.headers.get("Set-Cookie")).toContain("__clerk_hs=refresh");
      const started = await app.fetch(new Request(`${link}&start=1`, { headers: { Cookie: "__session=fresh" } }));
      expect(started.status).toBe(302);
      expect(mocks.authenticateRequest).toHaveBeenLastCalledWith(expect.any(Request), {
        acceptsToken: "session_token",
      });
      expect(started.headers.get("Location")).toContain("https://consent.example/authorize?");
      expect(started.headers.get("Set-Cookie")).toContain("__session=fresh");
      const callbackUrl = `${BASE}/oauth/callback/service?code=code&state=flow-state`;
      const refresh = await app.fetch(new Request(callbackUrl, { headers: { Cookie: "__session=expired" } }));
      expect(refresh.status).toBe(307);
      expect(new URL(refresh.headers.get("Location")!).searchParams.get("redirect_url")).toBe(callbackUrl);
      expect(finishAuth).not.toHaveBeenCalled();
      const completed = await app.fetch(new Request(callbackUrl, { headers: { Cookie: "__session=fresh" } }));
      expect(completed.status).toBe(200);
      expect(completed.headers.get("Set-Cookie")).toContain("__session=fresh");
      expect(finishAuth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
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
      allowedOAuthClientIds: ["client_connecta"],
      publicUrl: BASE,
    });
    const request = new Request(`${BASE}/ui/data`, {
      method: "POST",
      headers: { Authorization: "Bearer replayed-session-jwt" },
    });

    const result = await auth.authorize(request, BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  describe("MCP OAuth resource binding", () => {
    const jwt = (claims: Record<string, unknown>) =>
      [
        btoa(JSON.stringify({ alg: "RS256", typ: "at+jwt", kid: "test" })),
        btoa(JSON.stringify({ sub: "user_123", ...claims })),
        btoa("signature"),
      ]
        .map((part) => part.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"))
        .join(".");

    function deployment(allowedOAuthClientIds: readonly string[] | undefined = ["client_connecta"]) {
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
        allowedOAuthClientIds,
      });
      return createTestConnecta({
        publicUrl: BASE,
        auth,
        storage: memoryStorage(),
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
        maintainers: ["user_123"],
        pools: { support: { tools: ["calc"], members: ["user_123"] } },
      });
    }

    function authenticateOAuth(token: string, clientId = "client_connecta") {
      // The SDK boundary has already verified this exact token. Its OAuth
      // auth object exposes clientId/scopes but drops the JWT's aud/resource.
      mocks.authenticateRequest.mockResolvedValue({
        toAuth: () => ({
          isAuthenticated: true,
          tokenType: "oauth_token",
          userId: "user_123",
          clientId,
          scopes: ["openid", "profile", "email"],
          getToken: async () => token,
        }),
      });
    }

    function mcpRequest(path: string) {
      return new Request(`${BASE}${path}`, {
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
    }

    async function expectUnauthorized(c: ReturnType<typeof deployment>, path = "/mcp") {
      const response = await c.fetch(mcpRequest(path));
      expect(response.status).toBe(401);
      const metadataPath = path === "/mcp" ? "" : path;
      expect(response.headers.get("WWW-Authenticate")).toBe(
        `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource${metadataPath}", scope="openid profile email"`,
      );
      expect(await response.json()).toMatchObject({ error: { code: "host_auth_required", retryable: false } });
      const metadata = await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource${metadataPath}`));
      expect(await metadata.json()).toMatchObject({ resource: `${BASE}${path}` });
    }

    it.each([
      { aud: "https://other.test/mcp" },
      { aud: [] },
      { aud: [123, `${BASE}/mcp`] },
      { aud: `${BASE}/mcp`, resource: "https://other.test/mcp" },
    ])("rejects an unmatched or malformed binding even for an allowlisted client: %j", async (claims) => {
      authenticateOAuth(jwt(claims));
      await expectUnauthorized(deployment());
    });

    it.each(["/mcp", "/mcp/support"])(
      "accepts the canonical resource audience at %s without a fallback allowlist",
      async (path) => {
        authenticateOAuth(jwt({ aud: `${BASE}${path}` }));
        const response = await deployment([]).fetch(mcpRequest(path));
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('"serverInfo"');
        expect(mocks.authenticateRequest).toHaveBeenCalledWith(expect.any(Request), { acceptsToken: "oauth_token" });
      },
    );

    it("INV-4: does not treat the base resource audience as a pool audience", async () => {
      authenticateOAuth(jwt({ aud: `${BASE}/mcp` }));
      await expectUnauthorized(deployment(), "/mcp/support");
      authenticateOAuth(jwt({ aud: `${BASE}/mcp/support` }));
      await expectUnauthorized(deployment());
    });

    it("keeps allowlisted unbound tokens working on pools", async () => {
      authenticateOAuth("oat_verified");
      const response = await deployment().fetch(mcpRequest("/mcp/support"));
      expect(response.status).toBe(200);
      await response.text();
    });

    it("rejects session tokens on MCP and keeps the same session working through authorizeUiIdentity", async () => {
      mocks.authenticateRequest.mockResolvedValue({
        toAuth: () => ({
          isAuthenticated: true,
          tokenType: "session_token",
          userId: "user_123",
          sessionClaims: { azp: BASE },
        }),
      });
      const c = deployment([]);
      await expectUnauthorized(c);
      await expectUnauthorized(c, "/mcp/support");
      const response = await c.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: "Bearer supplied-token" },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ connectors: [{ id: "calc" }] });
      expect(mocks.authenticateRequest).toHaveBeenLastCalledWith(expect.any(Request), {
        acceptsToken: "session_token",
      });
    });

    it.each([{ expired: true }, { subject: "user_other" }, { client_id: "client_other" }])(
      "rejects an opaque verification response that disagrees with SDK authentication: %j",
      async (claims) => {
        authenticateOAuth("oat_verified");
        mocks.fetch.mockResolvedValue(Response.json(opaqueVerification({ aud: [`${BASE}/mcp`], ...claims })));
        await expectUnauthorized(deployment());
      },
    );

    it.each([
      () => Response.json({ message: "oat_private" }, { status: 503 }),
      // A redirect is not an answer, even one carrying a valid verification.
      () =>
        Response.json(opaqueVerification({ aud: [`${BASE}/mcp`] }), {
          status: 302,
          headers: { Location: "https://api.clerk.com/oat_private" },
        }),
      () => {
        throw new Error("oat_private");
      },
    ])("fails closed on opaque verification failure without logging response contents", async (response) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        authenticateOAuth("oat_private");
        mocks.fetch.mockImplementation(response);
        await expectUnauthorized(deployment());
        expect(warn.mock.calls).toEqual([["[connecta] Clerk request denied", { reason: "oauth_verification_failed" }]]);
      } finally {
        warn.mockRestore();
      }
    });

    it("INV-6: does not log SDK rejection details or thrown errors", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mocks.authenticateRequest.mockResolvedValue({
          status: "private-status",
          reason: "private-reason",
          message: "oat_private",
          toAuth: () => ({ isAuthenticated: false }),
        });
        await expectUnauthorized(deployment());
        mocks.authenticateRequest.mockRejectedValue(new Error("oat_private"));
        await expectUnauthorized(deployment());
        expect(warn.mock.calls).toEqual([
          ["[connecta] Clerk request denied", { reason: "authentication_failed" }],
          ["[connecta] Clerk request denied", { reason: "authentication_failed" }],
        ]);
        expect(mocks.fetch).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("INV-4: rechecks opaque revocation on every request without an audience cache", async () => {
      authenticateOAuth("oat_verified");
      mocks.fetch
        .mockResolvedValueOnce(Response.json(opaqueVerification({ aud: `${BASE}/mcp` })))
        .mockResolvedValueOnce(Response.json(opaqueVerification({ aud: `${BASE}/mcp`, revoked: true })));
      const auth = clerkAuth({ publishableKey, secretKey: "sk_test_fake", publicUrl: BASE });
      expect((await auth.authorize(mcpRequest("/mcp"), BASE)).ok).toBe(true);
      expect((await auth.authorize(mcpRequest("/mcp"), BASE)).ok).toBe(false);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it("checks token binding on every request even after caching an admitted user", async () => {
      const gate = vi.fn(() => true);
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
        allowedOAuthClientIds: ["client_connecta"],
        gate,
      });
      authenticateOAuth("oat_verified");
      expect((await auth.authorize(mcpRequest("/mcp"), BASE)).ok).toBe(true);
      authenticateOAuth(jwt({ aud: "https://other.test/mcp" }));
      const result = await auth.authorize(mcpRequest("/mcp"), BASE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect(gate).toHaveBeenCalledTimes(1);
    });
  });

  // allowedDomains decides who this deployment admits (documentation/auth.md).
  describe("allowedDomains", () => {
    /** A Clerk user with one primary email, verified unless told otherwise. */
    const userWithEmail = (emailAddress: string, status: string | null = "verified") => ({
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        {
          id: "idn_primary",
          emailAddress,
          verification: status === null ? null : { status },
        },
      ],
    });

    const authorize = async (options: Partial<Parameters<typeof clerkAuth>[0]>) => {
      mocks.authenticateRequest.mockResolvedValue({
        toAuth: () => ({
          isAuthenticated: true,
          userId: "user_123",
          tokenType: "oauth_token",
          clientId: "client_connecta",
          getToken: async () => "oat_verified",
        }),
      });
      const auth = clerkAuth({
        publishableKey,
        secretKey: "sk_test_fake",
        allowedOAuthClientIds: ["client_connecta"],
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

    it("fails closed when the Clerk lookup itself fails", async () => {
      mocks.getUser.mockRejectedValue(new Error("clerk 500"));
      const result = await authorize({ allowedDomains: ["acme.com"] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    });

    it("composes with `gate` — either one can deny", async () => {
      mocks.getUser.mockResolvedValue(userWithEmail("dev@acme.com"));
      await expect(authorize({ allowedDomains: ["acme.com"], gate: () => true })).resolves.toEqual({
        ok: true,
        userId: "user_123",
      });

      // The gate denies a user the domain admits.
      expect((await authorize({ allowedDomains: ["acme.com"], gate: () => false })).ok).toBe(false);

      // The domain denies a user the gate admits — and the allowlist runs
      // first, so an outsider never reaches operator gate code.
      const gate = vi.fn(() => true);
      mocks.getUser.mockResolvedValue(userWithEmail("dev@other.com"));
      expect((await authorize({ allowedDomains: ["acme.com"], gate })).ok).toBe(false);
      expect(gate).not.toHaveBeenCalled();
    });

    it("INV-6: logs checked domain denial reasons without user IDs, addresses, or domains", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const domain = `${"a".repeat(60)}.${"b".repeat(60)}.example.com`;
      mocks.getUser.mockResolvedValue(userWithEmail(`secret-person@${domain}`));
      await authorize({ allowedDomains: ["acme.com"] });
      expect(warn.mock.calls).toEqual([["[connecta] Clerk request denied", { reason: "email_domain_denied" }]]);
      const denied = JSON.stringify(warn.mock.calls);
      for (const canary of ["user_123", "secret-person", domain]) expect(denied).not.toContain(canary);

      warn.mockClear();
      mocks.getUser.mockResolvedValue(userWithEmail("secret-person@evil.com\n[connecta] forged"));
      await authorize({ allowedDomains: ["acme.com"] });
      expect(warn.mock.calls).toEqual([["[connecta] Clerk request denied", { reason: "verified_email_invalid" }]]);
      const malformed = JSON.stringify(warn.mock.calls);
      for (const canary of ["user_123", "secret-person", "evil.com", "forged"]) expect(malformed).not.toContain(canary);
      warn.mockRestore();
    });
  });

  // A key that cannot yield a Frontend API origin is a structural mistake, and
  // PRINCIPLES.md says those throw at construction. Before this check the failure
  // was `atob`'s DOMException raised from inside the returned object: on the
  // Workers shape, which builds per request, that made every route — /health
  // included — a 500 whose stack named base64, not the misconfigured variable.
  describe("publishableKey validation", () => {
    const construct = (key: unknown) =>
      clerkAuth({
        publishableKey: key as string,
        secretKey: "sk_test_fake",
        allowedOAuthClientIds: ["client_connecta"],
        publicUrl: BASE,
      });

    it.each([
      // What examples/worker/wrangler.jsonc ships unedited.
      ["the shipped placeholder", "pk_test_replace-me"],
      // Every character is legal base64 and the length is not, which is the
      // one way to reach `atob` and have it throw.
      ["a key whose payload is not decodable base64", "pk_test_A"],
      // Decodable, but nothing a Frontend API could live at.
      ["a key that decodes to a non-domain", `pk_test_${btoa("localhost$")}`],
      // The commonest paste error of all.
      ["a secret key in the publishable slot", "sk_test_deadbeef"],
    ])("refuses %s at construction", (_label, key) => {
      expect(() => construct(key)).toThrowError(/^clerkAuth: `publishableKey`/);
      // Never a DOMException, and never the value itself in the log line.
      expect(() => construct(key)).not.toThrowError(/atob|base64-encoded data/);
      if (typeof key === "string" && key !== "") {
        expect(() => construct(key)).not.toThrowError(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  });
});
