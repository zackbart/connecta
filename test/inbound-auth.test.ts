import { afterEach, describe, expect, it, vi } from "vitest";
import { clerkAuth } from "../src/auth/clerk.js";
import { accessTokens } from "../src/access-tokens.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { api } from "../src/connectors/api.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { authorize, authorizeUiIdentity } from "../src/routes/shared.js";
import type { InboundAuth } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";

vi.mock("../src/auth/clerk-transport.js", () => ({
  createByteReadingClerkClient: () => ({ authenticateRequest: async () => ({ toAuth: () => ({ isAuthenticated: false }) }) }),
}));
const BASE = "https://connecta.test";
const PK = `pk_test_${btoa("clerk.example.com$")}`;
const clerk = () => clerkAuth({ publishableKey: PK, secretKey: "sk_test_fake", publicUrl: BASE });
const request = (path = "/mcp", token?: string) => new Request(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const context = { waitUntil() {}, access: { aud: "application-aud", getIdentity: async () => ({ user_uuid: "human" }) } };
afterEach(() => vi.restoreAllMocks());

function unrelated(): InboundAuth {
  return { kind: "unrelated", interactiveOperator: true,
    handleMetadata: req => new URL(req.url).pathname === "/.well-known/unrelated" ? Response.json({ unrelated: true }) : null,
    challenge: () => 'Bearer scope="wrong"',
    authorize: () => ({ ok: false, response: new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="wrong"' } }) }),
  };
}

describe("inbound credential ownership", () => {
  it("INV-4: never falls back from a recognized invalid machine credential to an ambient Access human", async () => {
    const machine = accessTokens(memoryStorage()).auth;
    const result = await authorize(request("/mcp", "cta_bad"), BASE, [machine, cloudflareAccessAuth()], context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("INV-4: reserves cta_ credentials without the optional token verifier, even on open deployments", async () => {
    for (const providers of [[], [cloudflareAccessAuth()], [clerk(), cloudflareAccessAuth()]]) {
      const result = await authorize(request("/mcp", "cta_bad"), BASE, providers, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    }
    const storage = memoryStorage();
    const app = createTestConnecta({ connectors: [api("secret", { credential: { label: "API token" }, tools: [] })],
      auth: cloudflareAccessAuth(), storage, vault: encryptedCredentialVault(storage, btoa("x".repeat(32))), publicUrl: BASE, logger: "silent" });
    try {
      const result = await app.fetch(new Request(`${BASE}/ui/credentials/secret`, {
        method: "PUT", headers: { Authorization: "Bearer cta_bad", Origin: BASE, "Content-Type": "application/json" },
        body: JSON.stringify({ value: "should-never-save" }),
      }), undefined, context);
      expect(result.status).toBe(403);
      expect(await storage.list("")).toEqual([]);
      const human = await authorizeUiIdentity(request("/connect/service", "cta_bad"), BASE, [cloudflareAccessAuth()], "connect", context);
      expect(human.ok).toBe(false);
      if (!human.ok) expect(human.response.status).toBe(403);
    } finally { await app.close(); }
  });

  it("INV-4: rejects recognized machine credentials on human routes without storage or human verification", async () => {
    const storage = memoryStorage();
    const get = vi.spyOn(storage, "get");
    const human = { ...cloudflareAccessAuth(), authorize: vi.fn(cloudflareAccessAuth().authorize) };
    const result = await authorizeUiIdentity(request("/ui/access-tokens", "cta_bad"), BASE, [accessTokens(storage).auth, human], "tokens", context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(human.authorize).not.toHaveBeenCalled();
  });

  it("INV-4: stops after a recognized interactive refusal or redirect", async () => {
    for (const status of [401, 403, 307]) {
      const next = vi.fn(() => ({ ok: true as const, userId: "other" }));
      const first: InboundAuth = { kind: "first", interactiveOperator: true, recognizesCredential: () => true,
        authorize: () => ({ ok: false, response: new Response(null, { status }) }) };
      const result = await authorizeUiIdentity(request("/connect/service"), BASE, [first, { kind: "other", interactiveOperator: true, authorize: next }], "connect");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(status);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("INV-4: rejects non-boolean recognition rather than falling through", async () => {
    for (const value of [undefined, "yes", Promise.resolve(true)]) {
      const result = await authorize(request(), BASE, [{ kind: "broken", recognizesCredential: (() => value) as never,
        authorize: () => ({ ok: true, userId: "wrong" }) }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  });

  it("INV-11: refuses retired refusal markers and invalid auth hooks at construction", () => {
    const auth = { kind: "custom", authorize: () => ({ ok: true as const }) };
    for (const key of ["recognizesCredential", "handleMetadata", "challenge"]) {
      expect(() => createTestConnecta({ connectors: [], auth: { ...auth, [key]: "bad" } as never })).toThrow("inbound auth adapter");
    }
    expect(() => createTestConnecta({ connectors: [], auth: { ...auth, recognizesCredential: async () => true } as never })).toThrow("must be synchronous");
    expect(() => createTestConnecta({ connectors: [], auth: { ...auth, finalRefusals: true } as never })).toThrow("finalRefusals is retired");
  });

  it("INV-6: consumes rejected recognition promises without exposing their text", async () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const result = await authorize(request(), BASE, [{ kind: "broken",
      recognizesCredential: (() => Promise.reject(new Error("SECRET_TOKEN"))) as never,
      authorize: () => ({ ok: true, userId: "wrong" }) }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("INV-6: fails closed without logging thrown credential-recognition text", async () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const verify = vi.fn(() => ({ ok: true as const }));
    const result = await authorize(request(), BASE, [{ kind: "custom", recognizesCredential: () => { throw new Error("SECRET_TOKEN"); }, authorize: verify }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("metadata-owned challenges", () => {
  it("INV-4: an unrelated metadata hook cannot override Clerk's 401 challenge", async () => {
    const providers = [unrelated(), clerk()];
    const app = createTestConnecta({ connectors: [], auth: providers, publicUrl: BASE, logger: "silent" });
    try {
      const metadata = await app.fetch(request("/.well-known/oauth-protected-resource/mcp/support"));
      expect(await metadata.json()).toMatchObject({ resource: `${BASE}/mcp/support` });
      const result = await authorize(request("/mcp/support"), BASE, providers);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/support", scope="openid profile email"`);
    } finally { await app.close(); }
  });

  it("INV-4: the final human-route 401 retains the actual metadata owner's challenge", async () => {
    const result = await authorizeUiIdentity(request("/ui/access-tokens"), BASE, [clerk(), unrelated()], "tokens");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", scope="openid profile email"`);
  });

  it("uses Clerk discovery for a recognized invalid cta_ token without verifying Clerk", async () => {
    const result = await authorize(request("/mcp/support", "cta_bad"), BASE, [accessTokens(memoryStorage()).auth, clerk()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.headers.get("WWW-Authenticate")).toBe(`Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/support", scope="openid profile email"`);
  });

  it("serves only Clerk protected-resource metadata, including OPTIONS", async () => {
    const auth = clerk();
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/unrelated", "/.well-known/oauth-protected-resource/mcp/support/extra"]) {
      expect(await auth.handleMetadata!(request(path), BASE)).toBeNull();
      expect(await auth.handleMetadata!(new Request(`${BASE}${path}`, { method: "OPTIONS" }), BASE)).toBeNull();
    }
    expect((await auth.handleMetadata!(new Request(`${BASE}/.well-known/oauth-protected-resource`, { method: "OPTIONS" }), BASE))?.status).toBe(204);
  });

  it("INV-11: rejects challenge scope injection without quoting the configured value", () => {
    for (const scope of ['openid"SECRET', "bad\\SECRET", "bad\nSECRET", "two scopes"]) {
      expect(() => clerkAuth({ publishableKey: PK, secretKey: "unused", scopes: [scope] })).toThrow("`scopes`");
      try { clerkAuth({ publishableKey: PK, secretKey: "unused", scopes: [scope] }); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
    }
  });
});
