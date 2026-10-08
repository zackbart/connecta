import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";

const BASE = "https://connecta.test";
const AS = "https://consent.example/authorize";
const deployments: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(deployments.splice(0).map((app) => app.close()));
});

function setup(
  provider: "clerk" | "access",
  authScope: "personal" | "shared",
  options: { vault?: boolean; interactive?: boolean; bobAdmin?: boolean; hostedSignIn?: boolean; ui?: boolean } = {},
) {
  const storage = memoryStorage();
  let state = "";
  let permitted = true;
  const startAuth = vi.fn(async (ctx, opts) => {
    state = crypto.randomUUID();
    await ctx.storage.set("state", state);
    return { state: "auth_required" as const, authorizationUrl: `${AS}?state=${state}&force=${opts?.force}` };
  });
  const finishAuth = vi.fn(async () => {});
  const connector: Connector = {
    id: "service",
    kind: "mcp",
    authScope,
    listTools: async () => [],
    callTool: async () => null,
    status: async () => ({ state: "auth_required", authorizationUrl: `${AS}?private` }),
    startAuth,
    finishAuth,
    verifyState: async (candidate, ctx) => candidate !== null && candidate === (await ctx.storage.get("state")),
    disconnectAuth: async () => {},
  };
  const auth =
    options.interactive === false
      ? machineAuth("machine")
      : provider === "access"
        ? cloudflareAccessAuth()
        : ["alice", "bob"].map((user) => ({
            ...fakeClerkAuth({
              token: user,
              userId: user,
              ...(options.hostedSignIn === false ? {} : { signInUrl: "https://accounts.example/sign-in" }),
            }),
            activityActorNamespace: "https://clerk.example.test",
          }));
  const app = createTestConnecta({
    ...(options.ui === false ? { ui: undefined } : {}),
    connectors: [connector],
    auth,
    storage,
    publicUrl: BASE,
    logger: "silent",
    ...(options.vault === false ? {} : { vault: encryptedCredentialVault(storage, CREDENTIAL_KEY) }),
    identity: {
      credentialAdministration: (identity) =>
        permitted && (identity.principal?.id === "alice" || options.bobAdmin) ? "all" : "none",
      personalConnection: () => (permitted ? "all" : "none"),
    },
  });
  deployments.push(app);
  const runtime = (user?: string) =>
    provider === "access"
      ? {
          waitUntil() {},
          access: { aud: "test-app", getIdentity: async () => (user ? { user_uuid: user } : undefined) },
        }
      : undefined;
  const headers = (user?: string) => (user && provider === "clerk" ? { Cookie: `__session=${user}` } : {});
  // Existing lifecycle cases continue from the new page's explicit Connect
  // action. Playwright covers the initial page hand-off itself.
  const browser = async (url: string, user?: string) => {
    const response = await app.fetch(new Request(url, { headers: headers(user) }), undefined, runtime(user));
    const location = response.headers.get("Location");
    if (user && location && new URL(location).pathname === "/connectors/service") {
      const start = new URL(url);
      start.searchParams.set("start", "1");
      return app.fetch(new Request(start, { headers: headers(user) }), undefined, runtime(user));
    }
    return response;
  };
  const authorize = async (user = "alice", force = false) => {
    const result = await readJsonRpc(
      await app.fetch(
        mcpRpc(
          "tools/call",
          {
            name: "authorize_connector",
            arguments: { connector: "service", force },
          },
          options.interactive === false ? { token: "machine" } : provider === "clerk" ? { token: user } : {},
        ),
        undefined,
        runtime(user),
      ),
    );
    return JSON.parse(result.result.content[0].text);
  };
  const callback = (user?: string, candidate = state) =>
    browser(`${BASE}/oauth/callback/service?code=code&state=${candidate}`, user);
  return {
    app,
    browser,
    authorize,
    callback,
    startAuth,
    finishAuth,
    storage,
    headers,
    runtime,
    revoke: () => {
      permitted = false;
    },
  };
}

for (const provider of ["clerk", "access"] as const) {
  for (const scope of ["personal", "shared"] as const) {
    describe(`${provider} ${scope} OAuth connection`, () => {
      it("binds the connect link and callback to the initiating user, including another admin", async () => {
        const flow = setup(provider, scope, { bobAdmin: true });
        const handoff = await flow.authorize();
        expect(handoff.authorizationUrl).toMatch(new RegExp(`^${BASE}/connect/service\\?h=`));
        expect(JSON.stringify(handoff)).not.toContain(AS);
        expect(flow.startAuth).not.toHaveBeenCalled();
        expect((await flow.browser(handoff.authorizationUrl, "bob")).status).toBe(403);
        expect(flow.startAuth).not.toHaveBeenCalled();
        const begun = await flow.browser(handoff.authorizationUrl, "alice");
        expect(begun.status).toBe(302);
        expect(begun.headers.get("Location")).toContain(AS);
        expect((await flow.callback()).status).toBe(400);
        expect((await flow.callback("bob")).status).toBe(400);
        expect((await flow.callback("alice", "wrong")).status).toBe(400);
        expect(flow.finishAuth).not.toHaveBeenCalled();
        expect((await flow.callback("alice")).status).toBe(200);
        expect(flow.finishAuth).toHaveBeenCalledOnce();
        expect((await flow.callback("alice")).status).toBe(400);
      });

      it("allows only GET for connection starts and callbacks", async () => {
        const flow = setup(provider, scope);
        const { authorizationUrl } = await flow.authorize();
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
          const response = await flow.app.fetch(
            new Request(authorizationUrl, { method, headers: flow.headers("alice") }),
            undefined,
            flow.runtime("alice"),
          );
          expect(response.status).toBe(405);
          expect(response.headers.get("Allow")).toBe("GET");
        }
        expect(flow.startAuth).not.toHaveBeenCalled();
        const started = await flow.browser(authorizationUrl, "alice");
        const state = new URL(started.headers.get("Location")!).searchParams.get("state")!;
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
          const response = await flow.app.fetch(
            new Request(`${BASE}/oauth/callback/service?code=code&state=${state}`, {
              method,
              headers: flow.headers("alice"),
            }),
            undefined,
            flow.runtime("alice"),
          );
          expect(response.status).toBe(405);
          expect(response.headers.get("Allow")).toBe("GET");
        }
        expect(flow.finishAuth).not.toHaveBeenCalled();
        expect((await flow.callback("alice")).status).toBe(200);
      });

      it("claims one callback when state verification completes concurrently", async () => {
        const flow = setup(provider, scope);
        const { authorizationUrl } = await flow.authorize();
        await flow.browser(authorizationUrl, "alice");
        const connector = flow.app.registry.getConnector("service")!;
        const verify = connector.verifyState!;
        let arrivals = 0;
        let release!: () => void;
        const bothVerified = new Promise<void>((resolve) => {
          release = resolve;
        });
        connector.verifyState = async (state, ctx) => {
          const matched = await verify(state, ctx);
          if (++arrivals === 2) release();
          await bothVerified;
          return matched;
        };
        const responses = await Promise.all([flow.callback("alice"), flow.callback("alice")]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
        expect(flow.finishAuth).toHaveBeenCalledOnce();
      });

      it("uses a restart link only once, including before completion", async () => {
        const flow = setup(provider, scope);
        const { authorizationUrl } = await flow.authorize("alice", true);
        const responses = await Promise.all([
          flow.browser(authorizationUrl, "alice"),
          flow.browser(authorizationUrl, "alice"),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
        expect(flow.startAuth).toHaveBeenCalledOnce();
        expect((await flow.callback("alice")).status).toBe(200);
        expect((await flow.browser(authorizationUrl, "alice")).status).toBe(400);
        expect(flow.startAuth).toHaveBeenCalledOnce();
      });

      it("keeps status reads passive and replaces a connector's consent URL", async () => {
        const flow = setup(provider, scope);
        const response = await flow.app.fetch(
          new Request(`${BASE}/ui/connectors/service`, { headers: flow.headers("alice") }),
          undefined,
          flow.runtime("alice"),
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(`${BASE}/connect/service?h=`);
        expect(text).not.toContain(AS);
        expect(flow.startAuth).not.toHaveBeenCalled();
        const started = await flow.app.fetch(
          new Request(`${BASE}/ui/oauth/service?mode=restart`, {
            method: "POST",
            headers: { ...flow.headers("alice"), Origin: BASE },
          }),
          undefined,
          flow.runtime("alice"),
        );
        const payload = (await started.json()) as { authorizationUrl: string };
        expect(payload.authorizationUrl).toContain(`${BASE}/connect/service?h=`);
        expect(flow.startAuth).not.toHaveBeenCalled();
        expect((await flow.browser(payload.authorizationUrl, "alice")).status).toBe(302);
        expect(flow.startAuth).toHaveBeenCalledWith(expect.anything(), { force: true });
      });

      it("rechecks permission at the browser visit and at completion", async () => {
        const beforeStart = setup(provider, scope);
        const first = await beforeStart.authorize();
        beforeStart.revoke();
        expect((await beforeStart.browser(first.authorizationUrl, "alice")).status).toBe(403);
        expect(beforeStart.startAuth).not.toHaveBeenCalled();
        const beforeCallback = setup(provider, scope);
        const second = await beforeCallback.authorize();
        expect((await beforeCallback.browser(second.authorizationUrl, "alice")).status).toBe(302);
        beforeCallback.revoke();
        expect((await beforeCallback.callback("alice")).status).toBe(400);
        expect(beforeCallback.finishAuth).not.toHaveBeenCalled();
      });

      it("rejects tampered, expired, and cross-connector handoffs", async () => {
        const flow = setup(provider, scope);
        const handoff = await flow.authorize();
        const url = new URL(handoff.authorizationUrl);
        url.searchParams.set("h", `${url.searchParams.get("h")!.slice(0, -2)}xx`);
        expect((await flow.browser(url.href, "alice")).status).toBe(400);
        expect((await flow.browser(handoff.authorizationUrl.replace("/service?", "/other?"), "alice")).status).toBe(
          400,
        );
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
        expect((await flow.browser(handoff.authorizationUrl, "alice")).status).toBe(400);
        expect(flow.startAuth).not.toHaveBeenCalled();
      });
    });
  }
  it(`${provider} requires shared credential administration`, async () => {
    const flow = setup(provider, "shared");
    expect((await flow.authorize("bob")).recovery).toBe("unavailable");
    const link = await flow.authorize();
    expect((await flow.browser(link.authorizationUrl, "alice")).status).toBe(302);
    expect((await flow.callback("alice")).status).toBe(200);
  });
  it(`${provider} lets another shared admin complete their own flow`, async () => {
    const flow = setup(provider, "shared", { bobAdmin: true });
    const link = await flow.authorize("bob");
    expect((await flow.browser(link.authorizationUrl, "bob")).status).toBe(302);
    expect((await flow.callback("bob")).status).toBe(200);
    expect(flow.finishAuth).toHaveBeenCalledOnce();
  });
  it(`${provider} refuses connection without a signing key`, async () => {
    const flow = setup(provider, "personal", { vault: false });
    expect((await flow.authorize()).message).toContain("handoff signing key");
    expect((await flow.browser(`${BASE}/connect/service?h=anything`, "alice")).status).toBe(403);
    expect(flow.startAuth).not.toHaveBeenCalled();
  });
}

it("requires Clerk or Cloudflare Access rather than a machine bearer", async () => {
  const flow = setup("clerk", "shared", { interactive: false });
  const result = await flow.authorize();
  expect(result.message).toBe(
    "An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.",
  );
  const response = await flow.browser(`${BASE}/connect/service?h=anything`);
  expect(response.status).toBe(403);
  expect(await response.text()).toContain(result.message);
  expect(flow.startAuth).not.toHaveBeenCalled();
});

it("returns an unauthenticated Clerk browser from hosted sign-in to the same connect link", async () => {
  const flow = setup("clerk", "personal", { ui: false });
  const link = await flow.authorize();
  const response = await flow.browser(link.authorizationUrl);
  expect(response.status).toBe(302);
  const signin = new URL(response.headers.get("Location")!);
  expect(signin.origin).toBe("https://accounts.example");
  expect(signin.searchParams.get("redirect_url")).toBe(link.authorizationUrl);
  expect(flow.startAuth).not.toHaveBeenCalled();
});

it("serves local Clerk sign-in when no hosted page is configured", async () => {
  const flow = setup("clerk", "personal", { hostedSignIn: false, ui: false });
  const link = await flow.authorize();
  const response = await flow.browser(link.authorizationUrl);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
  const body = await response.text();
  expect(body).toContain("window.Clerk.mountSignIn");
  expect(body).toContain("forceRedirectUrl:");
  expect(body).toContain("/connect/service?h=");
  expect(body).not.toContain(AS);
  expect(flow.startAuth).not.toHaveBeenCalled();
});

it("refuses browser OAuth when no inbound provider is configured", async () => {
  const app = createTestConnecta({ connectors: [], publicUrl: BASE, logger: "silent" });
  deployments.push(app);
  const response = await app.fetch(new Request(`${BASE}/connect/service?h=anything`));
  expect(response.status).toBe(403);
  expect(await response.text()).toContain(
    "An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.",
  );
});

describe("OAuth identity and signature boundaries", () => {
  it.each(["clerk", "access"] as const)(
    "INV-4: explicit header refusals stay 401 on %s connect and callback routes",
    async (provider) => {
      const flow = setup(provider, "personal");
      const { authorizationUrl } = await flow.authorize();
      const headers = [
        "",
        "Basic unknown",
        "Unknown unknown",
        "Bearer",
        "Bearer  malformed",
        "bearer invalid",
        "Bearer a, Bearer b",
      ];
      const challenge = provider === "clerk" ? "Bearer" : 'Bearer scope="openid email"';
      for (const authorization of headers) {
        const response = await flow.app.fetch(
          new Request(authorizationUrl, {
            headers: { Authorization: authorization, Cookie: "__session=alice" },
          }),
          undefined,
          flow.runtime("alice"),
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe(challenge);
        expect(response.headers.has("location")).toBe(false);
      }
      expect(flow.startAuth).not.toHaveBeenCalled();
      const begun = await flow.browser(authorizationUrl, "alice");
      expect(begun.status).toBe(302);
      const state = new URL(begun.headers.get("Location")!).searchParams.get("state")!;
      for (const authorization of headers) {
        const response = await flow.app.fetch(
          new Request(`${BASE}/oauth/callback/service?code=code&state=${state}`, {
            headers: { Authorization: authorization, Cookie: "__session=alice" },
          }),
          undefined,
          flow.runtime("alice"),
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe(challenge);
      }
      expect(flow.finishAuth).not.toHaveBeenCalled();
      expect((await flow.callback("alice")).status).toBe(200);
    },
  );

  it.each(["personal", "shared"] as const)(
    "refuses Access service identities for %s starts and callbacks",
    async (scope) => {
      const flow = setup("access", scope);
      const { authorizationUrl } = await flow.authorize();
      const pending = await flow.authorize();
      const begun = await flow.browser(pending.authorizationUrl, "alice");
      const state = new URL(begun.headers.get("Location")!).searchParams.get("state")!;
      for (const identity of [
        undefined,
        { common_name: "service" },
        { user_uuid: "alice", service_token_id: "service", service_token_status: true },
      ]) {
        const runtime = { waitUntil() {}, access: { aud: "test-app", getIdentity: async () => identity } };
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
          const headers = { "CF-Access-Client-Id": "service", "CF-Access-Client-Secret": "secret" };
          expect(
            (await flow.app.fetch(new Request(authorizationUrl, { method, headers }), undefined, runtime)).status,
          ).toBe(method === "GET" ? 403 : 405);
          expect(
            (
              await flow.app.fetch(
                new Request(`${BASE}/oauth/callback/service?code=code&state=${state}`, { method, headers }),
                undefined,
                runtime,
              )
            ).status,
          ).toBe(method === "GET" ? 400 : 405);
          expect(flow.finishAuth).not.toHaveBeenCalled();
        }
      }
      expect((await flow.callback("alice")).status).toBe(200);
    },
  );

  it.each([
    ["clerk", "personal"],
    ["clerk", "shared"],
    ["access", "personal"],
    ["access", "shared"],
  ] as const)("keeps principal-bound cta tokens out of %s %s browser consent", async (provider, authScope) => {
    const { AccessTokenManager } = await import("../src/access-tokens.js");
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage);
    const { token } = await manager.create("machine", {
      namespace: provider === "clerk" ? "https://clerk.example.test" : "cloudflare-access",
      id: "alice",
    });
    let state = "";
    const startAuth = vi.fn(async (ctx) => {
      state = crypto.randomUUID();
      await ctx.storage.set("state", state);
      return { state: "auth_required" as const, authorizationUrl: `${AS}?state=${state}` };
    });
    const finishAuth = vi.fn(async () => {});
    const connector: Connector = {
      id: "service",
      authScope,
      listTools: async () => [],
      callTool: async () => null,
      startAuth,
      verifyState: async (candidate, ctx) => candidate === (await ctx.storage.get("state")),
      finishAuth,
    };
    const humanAuth =
      provider === "clerk" ? fakeClerkAuth({ token: "alice", userId: "alice" }) : cloudflareAccessAuth();
    const runtime = (human = false) =>
      provider === "access"
        ? {
            waitUntil() {},
            access: { aud: "test-app", getIdentity: async () => (human ? { user_uuid: "alice" } : undefined) },
          }
        : undefined;
    const app = createTestConnecta({
      connectors: [connector],
      auth: [manager.auth, humanAuth],
      storage,
      publicUrl: BASE,
      vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
      logger: "silent",
    });
    deployments.push(app);
    const rpc = await readJsonRpc(
      await mcpRpc(app, "tools/call", { name: "authorize_connector", arguments: { connector: "service" } }, { token }),
    );
    expect(JSON.parse(rpc.result.content[0].text).recovery).toBe("unavailable");
    const humanRpc = await readJsonRpc(
      await app.fetch(
        mcpRpc(
          "tools/call",
          { name: "authorize_connector", arguments: { connector: "service" } },
          provider === "clerk" ? { token: "alice" } : {},
        ),
        undefined,
        runtime(true),
      ),
    );
    const link = JSON.parse(humanRpc.result.content[0].text).authorizationUrl;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await app.fetch(
        new Request(link, { method, headers: { Authorization: `Bearer ${token}` } }),
        undefined,
        runtime(),
      );
      expect(response.status).toBe(method === "GET" ? 403 : 405);
    }
    expect(startAuth).not.toHaveBeenCalled();
    expect(
      (await app.fetch(new Request(link, { headers: { Cookie: "__session=alice" } }), undefined, runtime(true))).status,
    ).toBe(302);
    expect(startAuth).not.toHaveBeenCalled();
    expect(
      (
        await app.fetch(
          new Request(`${link}&start=1`, { headers: { Cookie: "__session=alice" } }),
          undefined,
          runtime(true),
        )
      ).status,
    ).toBe(302);
    const callback = `${BASE}/oauth/callback/service?code=code&state=${state}`;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await app.fetch(
        new Request(callback, { method, headers: { Authorization: `Bearer ${token}` } }),
        undefined,
        runtime(),
      );
      expect(response.status).toBe(method === "GET" ? 400 : 405);
    }
    expect(finishAuth).not.toHaveBeenCalled();
    expect(
      (await app.fetch(new Request(callback, { headers: { Cookie: "__session=alice" } }), undefined, runtime(true)))
        .status,
    ).toBe(200);
  });

  it("binds signatures to payload bytes, deployment origin, and vault key", async () => {
    const flow = setup("clerk", "personal");
    const { authorizationUrl } = await flow.authorize();
    const original = new URL(authorizationUrl);
    const [payload, signature] = original.searchParams.get("h")!.split(".");
    const metadata = JSON.parse(atob(payload!));
    const altered = new URL(original);
    altered.searchParams.set("h", `${btoa(JSON.stringify({ ...metadata, principal: "bob" }))}.${signature}`);
    expect((await flow.browser(altered.href, "alice")).status).toBe(400);
    const crossOrigin = new URL(original);
    crossOrigin.hostname = "another-deployment.test";
    const withoutFixedOrigin = createTestConnecta({
      connectors: [flow.app.registry.getConnector("service")!],
      auth: fakeClerkAuth({ token: "alice", userId: "alice" }),
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
      logger: "silent",
    });
    deployments.push(withoutFixedOrigin);
    expect(
      (await withoutFixedOrigin.fetch(new Request(crossOrigin, { headers: { Cookie: "__session=alice" } }))).status,
    ).toBe(400);
    const wrongKey = createTestConnecta({
      connectors: [flow.app.registry.getConnector("service")!],
      auth: fakeClerkAuth({ token: "alice", userId: "alice" }),
      publicUrl: BASE,
      vault: encryptedCredentialVault(memoryStorage(), btoa(String.fromCharCode(...new Uint8Array(32).fill(93)))),
      logger: "silent",
    });
    deployments.push(wrongKey);
    expect((await wrongKey.fetch(new Request(original, { headers: { Cookie: "__session=alice" } }))).status).toBe(400);
    expect(flow.startAuth).not.toHaveBeenCalled();
  });
});
