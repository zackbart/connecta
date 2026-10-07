import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { bearerToken } from "../src/auth/bearer.js";
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
  await Promise.all(deployments.splice(0).map(app => app.close()));
});

function setup(provider: "clerk" | "access", authScope: "personal" | "shared", options: { vault?: boolean; interactive?: boolean; bobAdmin?: boolean; hostedSignIn?: boolean } = {}) {
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
    id: "service", kind: "mcp", authScope,
    listTools: async () => [], callTool: async () => null,
    status: async () => ({ state: "auth_required", authorizationUrl: `${AS}?private` }),
    startAuth, finishAuth,
    verifyState: async (candidate, ctx) => candidate !== null && candidate === await ctx.storage.get("state"),
    disconnectAuth: async () => {},
  };
  const auth = options.interactive === false ? bearerToken("machine") : provider === "access" ? cloudflareAccessAuth() : ["alice", "bob"].map(user => ({
    ...fakeClerkAuth({ token: user, userId: user, ...(options.hostedSignIn === false ? {} : { signInUrl: "https://accounts.example/sign-in" }) }),
    activityActorNamespace: "https://clerk.example.test",
  }));
  const app = createTestConnecta({ connectors: [connector], auth, storage, publicUrl: BASE, logger: "silent",
    ...(options.vault === false ? {} : { vault: encryptedCredentialVault(storage, CREDENTIAL_KEY) }),
    identity: {
      credentialAdministration: identity => permitted && (identity.principal?.id === "alice" || options.bobAdmin) ? "all" : "none",
      personalConnection: () => permitted ? "all" : "none",
    },
  });
  deployments.push(app);
  const runtime = (user?: string) => provider === "access" ? { waitUntil() {}, access: { aud: "test-app", getIdentity: async () => user ? { user_uuid: user } : undefined } } : undefined;
  const headers = (user?: string) => user && provider === "clerk" ? { Cookie: `__session=${user}` } : {};
  const browser = (url: string, user?: string) => app.fetch(new Request(url, { headers: headers(user) }), undefined, runtime(user));
  const authorize = async (user = "alice", force = false) => {
    const result = await readJsonRpc(await app.fetch(mcpRpc("tools/call", {
      name: "authorize_connector", arguments: { connector: "service", force },
    }, options.interactive === false ? { token: "machine" } : provider === "clerk" ? { token: user } : {}), undefined, runtime(user)));
    return JSON.parse(result.result.content[0].text);
  };
  const callback = (user?: string, candidate = state) => browser(`${BASE}/oauth/callback/service?code=code&state=${candidate}`, user);
  return { app, browser, authorize, callback, startAuth, finishAuth, storage, headers, runtime, revoke: () => { permitted = false; } };
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

      it("keeps status reads passive and replaces a connector's consent URL", async () => {
        const flow = setup(provider, scope);
        const response = await flow.app.fetch(new Request(`${BASE}/ui/connectors/service`, { headers: flow.headers("alice") }), undefined, flow.runtime("alice"));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(`${BASE}/connect/service?h=`);
        expect(text).not.toContain(AS);
        expect(flow.startAuth).not.toHaveBeenCalled();
        const started = await flow.app.fetch(new Request(`${BASE}/ui/oauth/service?mode=restart`, { method: "POST", headers: { ...flow.headers("alice"), Origin: BASE } }), undefined, flow.runtime("alice"));
        const payload = await started.json() as { authorizationUrl: string };
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
        expect((await flow.browser(handoff.authorizationUrl.replace("/service?", "/other?"), "alice")).status).toBe(400);
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
  expect(result.message).toBe("An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.");
  const response = await flow.browser(`${BASE}/connect/service?h=anything`);
  expect(response.status).toBe(403);
  expect(await response.text()).toContain(result.message);
  expect(flow.startAuth).not.toHaveBeenCalled();
});

it("returns an unauthenticated Clerk browser from hosted sign-in to the same connect link", async () => {
  const flow = setup("clerk", "personal");
  const link = await flow.authorize();
  const response = await flow.browser(link.authorizationUrl);
  expect(response.status).toBe(302);
  const signin = new URL(response.headers.get("Location")!);
  expect(signin.origin).toBe("https://accounts.example");
  expect(signin.searchParams.get("redirect_url")).toBe(link.authorizationUrl);
  expect(flow.startAuth).not.toHaveBeenCalled();
});

it("serves local Clerk sign-in when no hosted page is configured", async () => {
  const flow = setup("clerk", "personal", { hostedSignIn: false });
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
  expect(await response.text()).toContain("An interactive provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.");
});
