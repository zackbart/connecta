import { afterEach, describe, expect, it, vi } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { api } from "../src/connectors/api.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { authorize, authorizeUiIdentity } from "../src/routes/shared.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { InboundAuth } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";

vi.mock("../src/auth/clerk-transport.js", () => ({
  createByteReadingClerkClient: () => ({
    authenticateRequest: async () => ({ toAuth: () => ({ isAuthenticated: false }) }),
  }),
}));
const BASE = "https://connecta.test";
const PK = `pk_test_${btoa("clerk.example.com$")}`;
const clerk = () => clerkAuth({ publishableKey: PK, secretKey: "sk_test_fake", publicUrl: BASE });
const request = (path = "/mcp", token?: string) =>
  new Request(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const context = {
  waitUntil() {},
  access: { aud: "application-aud", getIdentity: async () => ({ user_uuid: "human" }) },
};
afterEach(() => vi.restoreAllMocks());

function unrelated(): InboundAuth {
  return {
    kind: "unrelated",
    interactiveOperator: true,
    handleMetadata: (req) =>
      new URL(req.url).pathname === "/.well-known/unrelated" ? Response.json({ unrelated: true }) : null,
    challenge: () => 'Bearer scope="wrong"',
    authorize: () => ({
      ok: false,
      response: new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="wrong"' } }),
    }),
  };
}

describe("inbound credential ownership", () => {
  it("INV-4 INV-7: gives custom providers one normalized header verdict without ambient credentials or consuming the route body", async () => {
    const later = vi.fn(() => ({ ok: true as const, userId: "ambient" }));
    const first: InboundAuth = {
      kind: "header",
      interactiveOperator: true,
      challenge: () => 'Bearer scope="header"',
      authorize: (req, _base, runtime) => {
        expect(req.headers.get("Authorization")).toBe("Bearer explicit");
        expect(req.headers.has("cookie")).toBe(false);
        expect(runtime?.access).toBeUndefined();
        return { ok: false, response: new Response(null, { status: 401 }) };
      },
    };
    const req = new Request(`${BASE}/mcp`, {
      method: "POST",
      body: "route body",
      headers: { Authorization: "bEaReR explicit", Cookie: "__session=ambient" },
    });
    const result = await authorize(req, BASE, [first, { kind: "other", authorize: later }], context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.headers.get("WWW-Authenticate")).toBe('Bearer scope="header"');
    expect(later).not.toHaveBeenCalled();
    expect(await req.text()).toBe("route body");
  });

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
    const app = createTestConnecta({
      connectors: [api("secret", { credential: { label: "API token" }, tools: [] })],
      auth: cloudflareAccessAuth(),
      maintainers: ["human"],
      storage,
      vault: encryptedCredentialVault(storage, btoa("x".repeat(32))),
      publicUrl: BASE,
      logger: "silent",
    });
    try {
      const result = await app.fetch(
        new Request(`${BASE}/ui/credentials/secret`, {
          method: "PUT",
          headers: { Authorization: "Bearer cta_bad", Origin: BASE, "Content-Type": "application/json" },
          body: JSON.stringify({ value: "should-never-save" }),
        }),
        undefined,
        context,
      );
      expect(result.status).toBe(403);
      expect(await storage.list("")).toEqual([]);
      const human = await authorizeUiIdentity(
        request("/connect/service", "cta_bad"),
        BASE,
        [cloudflareAccessAuth()],
        "connect",
        context,
      );
      expect(human.ok).toBe(false);
      if (!human.ok) expect(human.response.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("INV-4: rejects recognized machine credentials on human routes without storage or human verification", async () => {
    const storage = memoryStorage();
    const get = vi.spyOn(storage, "get");
    const human = { ...cloudflareAccessAuth(), authorize: vi.fn(cloudflareAccessAuth().authorize) };
    const result = await authorizeUiIdentity(
      request("/ui/access-tokens", "cta_bad"),
      BASE,
      [accessTokens(storage).auth, human],
      "tokens",
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(human.authorize).not.toHaveBeenCalled();
  });

  it("INV-4: stops after a recognized interactive refusal or redirect", async () => {
    for (const status of [401, 403, 307]) {
      const next = vi.fn(() => ({ ok: true as const, userId: "other" }));
      const first: InboundAuth = {
        kind: "first",
        interactiveOperator: true,
        recognizesCredential: () => true,
        authorize: () => ({ ok: false, response: new Response(null, { status }) }),
      };
      const result = await authorizeUiIdentity(
        request("/connect/service"),
        BASE,
        [first, { kind: "other", interactiveOperator: true, authorize: next }],
        "connect",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(status);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("INV-6: fails closed without logging thrown credential-recognition text", async () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const verify = vi.fn(() => ({ ok: true as const }));
    const result = await authorize(request(), BASE, [
      {
        kind: "custom",
        recognizesCredential: () => {
          throw new Error("SECRET_TOKEN");
        },
        authorize: verify,
      },
    ]);
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
    const app = createTestConnecta({
      connectors: [],
      auth: providers,
      maintainers: [{ namespace: "https://clerk.example.com", id: "user_operator" }],
      publicUrl: BASE,
      logger: "silent",
    });
    try {
      const metadata = await app.fetch(request("/.well-known/oauth-protected-resource/mcp/support"));
      expect(await metadata.json()).toMatchObject({ resource: `${BASE}/mcp/support` });
      const result = await authorize(request("/mcp/support"), BASE, providers);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.response.headers.get("WWW-Authenticate")).toBe(
          `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/support", scope="openid profile email"`,
        );
    } finally {
      await app.close();
    }
  });

  it("INV-4: the final human-route 401 retains the actual metadata owner's challenge", async () => {
    const result = await authorizeUiIdentity(request("/ui/access-tokens"), BASE, [clerk(), unrelated()], "tokens");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.response.headers.get("WWW-Authenticate")).toBe(
        `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", scope="openid profile email"`,
      );
  });
});
