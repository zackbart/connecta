import { afterEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "@clerk/backend/jwt";
import { clerkAuth } from "../src/auth/clerk.js";
import { createByteReadingClerkClient } from "../src/auth/clerk-transport.js";
import { createClerkClient } from "@clerk/backend";
import { authorize as authorizeIdentity } from "../src/routes/shared.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";

const BASE = "https://connecta.test";
const FRONTEND = "https://clerk.example.com";
const publishableKey = `pk_test_${btoa("clerk.example.com$")}`;
const secretKey = "sk_test_fake";
const SENTINEL = "planted-clerk-upstream-7f3a9c";

function captureOutput() {
  return ["log", "info", "warn", "error", "debug"].map(method =>
    vi.spyOn(console, method as "log").mockImplementation(() => {}),
  );
}
function output(spies: ReturnType<typeof captureOutput>) {
  return JSON.stringify(spies.flatMap(spy => spy.mock.calls));
}

async function session() {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]) as CryptoKeyPair;
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  const kid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt({
    sub: "user_123", sid: "sess_test", iss: FRONTEND, azp: BASE,
    exp: now + 300, nbf: now - 5,
  }, privateKey, { algorithm: "RS256", header: { typ: "JWT", kid } });
  return { token, jwks: { keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }] } };
}

function auth() { return clerkAuth({ publishableKey, secretKey, publicUrl: BASE }); }
function browser(nonce?: string) {
  return new Request(`${BASE}/connect/service${nonce ? `?__clerk_handshake_nonce=${nonce}` : ""}`, {
    headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Clerk operator output with the real SDK", () => {
  it("INV-6: withholds handshake HTTP 400 error code, message, long_message, and headers", async () => {
    const spies = captureOutput();
    const upstream = Response.json({
      errors: [{ code: `${SENTINEL}-code`, message: `${SENTINEL}-message`, long_message: `${SENTINEL}-long-message` }],
      clerk_trace_id: `${SENTINEL}-trace`,
    }, { status: 400, statusText: `${SENTINEL}-status`, headers: { "cf-ray": `${SENTINEL}-ray` } });
    const nativeJson = vi.spyOn(upstream, "json");
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => upstream);
    vi.stubGlobal("fetch", fetcher);
    const result = await auth().authorize(browser("nonce"), BASE);
    expect(result.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toContain("/v1/clients/handshake_payload?nonce=nonce");
    expect(nativeJson).not.toHaveBeenCalled();
    expect(output(spies)).not.toContain(SENTINEL);
    expect(output(spies)).toContain("[connecta] Clerk authentication failed");
    expect(output(spies)).toContain("reason=authentication_failed");
    expect(output(spies)).not.toContain("HandshakeService");
  });

  it("INV-6: verifies JWKS with planted non-text Content-Type without native text or json reads", async () => {
    const spies = captureOutput();
    const { token, jwks } = await session();
    const upstream = new Response(JSON.stringify(jwks), { headers: { "Content-Type": `application/${SENTINEL}` } });
    const nativeJson = vi.spyOn(upstream, "json");
    const nativeText = vi.spyOn(upstream, "text");
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => upstream);
    vi.stubGlobal("fetch", fetcher);
    const request = browser();
    request.headers.set("Authorization", `Bearer ${token}`);
    expect(await auth().authorize(request, BASE)).toEqual({ ok: true, userId: "user_123" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.clerk.com/v1/jwks");
    expect(nativeJson).not.toHaveBeenCalled();
    expect(nativeText).not.toHaveBeenCalled();
    expect(output(spies)).not.toContain(SENTINEL);
  });

  it("INV-6: rejects a JWKS failure with planted error text and Content-Type using a fixed reason", async () => {
    const spies = captureOutput();
    const { token } = await session();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      errors: [{ code: "clerk_key_invalid", message: SENTINEL, long_message: SENTINEL }],
    }), { status: 400, headers: { "Content-Type": `application/${SENTINEL}` } })));
    const request = browser();
    request.headers.set("Authorization", `Bearer ${token}`);
    expect((await auth().authorize(request, BASE)).ok).toBe(false);
    expect(output(spies)).not.toContain(SENTINEL);
    expect(output(spies)).toContain("reason=authentication_failed");
  });

  it("INV-6: completes a successful nonce handshake and preserves its verified session cookies", async () => {
    const spies = captureOutput();
    const { token, jwks } = await session();
    const cookie = `__session=${token}; Path=/; Secure; HttpOnly`;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/jwks") return Response.json(jwks);
      expect(url.pathname).toBe("/v1/clients/handshake_payload");
      return Response.json({ directives: [cookie] });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await auth().authorize(browser("valid-nonce"), BASE)).toEqual({ ok: true, userId: "user_123", sessionCookies: [cookie] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output(spies)).toBe("[]");
  });

  it("INV-4 INV-6: verifies valid, invalid, expired and wrong-audience OAuth JWTs through the bundled SDK", async () => {
    const spies = captureOutput();
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
    const kid = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }] })));
    const now = Math.floor(Date.now() / 1000);
    const provider = auth();
    for (const verdict of ["valid", "invalid", "expired", "wrong-audience"]) {
      let token = await signJwt({ sub: "user_123", iss: FRONTEND, client_id: "client_connecta",
        scope: "openid profile email", iat: now - 300, nbf: now - 300,
        exp: verdict === "expired" ? now - 60 : now + 300,
        aud: verdict === "wrong-audience" ? "https://other.test/mcp" : `${BASE}/mcp`,
      }, privateKey, { algorithm: "RS256", header: { typ: "at+jwt", kid } });
      if (verdict === "invalid") {
        const parts = token.split(".");
        parts[2] = (parts[2]!.startsWith("a") ? "b" : "a") + parts[2]!.slice(1);
        token = parts.join(".");
      }
      const request = new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
      const result = await authorizeIdentity(request, BASE, [provider]);
      expect(result.ok, verdict).toBe(verdict === "valid");
      if (result.ok) {
        expect(result.identity.principal).toEqual({ namespace: FRONTEND, id: "user_123" });
        expect(result.identity.subject).toEqual(result.identity.principal);
        expect(result.identity.interactive).toBe(true);
      } else {
        expect(result.response.status).toBe(401);
        expect(result.response.headers.get("WWW-Authenticate")).toContain('scope="openid profile email"');
      }
      expect(output(spies)).not.toContain(token);
    }
  });

  it("INV-6: byte-reads a fresh SDK opaque-verification client and preserves resource binding", async () => {
    const spies = captureOutput();
    const responses: Response[] = [];
    const nativeReaders: ReturnType<typeof vi.spyOn>[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => {
      const response = Response.json({
        object: "clerk_idp_oauth_access_token", id: "oat_verified", client_id: "client_connecta",
        subject: "user_123", type: "oauth_token", scopes: ["openid"], revoked: false,
        revocation_reason: null, expired: false, expiration: Date.now() + 300_000,
        created_at: Date.now(), updated_at: Date.now(), aud: `${BASE}/mcp`,
      });
      nativeReaders.push(vi.spyOn(response, "json"), vi.spyOn(response, "text"));
      responses.push(response);
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const request = new Request(`${BASE}/mcp`, { headers: { Authorization: "Bearer oat_verified" } });
    expect(await auth().authorize(request, BASE)).toEqual({ ok: true, userId: "user_123" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const spy of nativeReaders) expect(spy).not.toHaveBeenCalled();
    expect(responses.every(response => response.bodyUsed)).toBe(true);
    expect(output(spies)).toBe("[]");
  });

  it("INV-6: contains handshake network and malformed-directive errors before SDK diagnostics", async () => {
    for (const fetcher of [
      vi.fn(async () => { throw new Error(SENTINEL); }),
      vi.fn(async () => Response.json({ directives: [SENTINEL + "\r\ninjected"] })),
    ]) {
      const spies = captureOutput();
      vi.stubGlobal("fetch", fetcher);
      expect((await auth().authorize(browser("nonce"), BASE)).ok).toBe(false);
      expect(output(spies)).not.toContain(SENTINEL);
      expect(output(spies)).toContain("[connecta] Clerk authentication failed");
      vi.restoreAllMocks();
    }
  });

  it("INV-6: byte-reads backend text responses and preserves normal user deserialization", async () => {
    const spies = captureOutput();
    const upstream = new Response(JSON.stringify({
      object: "user", id: "user_123", first_name: "Ada", last_name: "Lovelace",
      email_addresses: [], phone_numbers: [], web3_wallets: [], external_accounts: [],
    }), { headers: { "Content-Type": `application/json; sentinel=${SENTINEL}` } });
    // Preserve the SDK's existing exact Content-Type comparison. A parameter
    // makes it select text; a normal JSON response still yields a User.
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL) => upstream));
    expect(await auth().activityActorLabel!("user_123")).toBeUndefined();
    expect(output(spies)).not.toContain(SENTINEL);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ object: "user", id: "user_123", first_name: "Ada", last_name: "Lovelace", email_addresses: [], phone_numbers: [], web3_wallets: [], external_accounts: [] })));
    expect(await auth().activityActorLabel!("user_123")).toBe("Ada Lovelace");
  });

  it("INV-6: makes telemetry events and logs inert even when upstream debug output is enabled", () => {
    const spies = captureOutput();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("CLERK_TELEMETRY_DEBUG", "1");
    const client = createByteReadingClerkClient({ publishableKey, secretKey });
    client.telemetry.record({ event: "METHOD_CALLED", payload: { method: SENTINEL } });
    client.telemetry.recordLog({ message: SENTINEL, level: "error", timestamp: Date.now() });
    expect(fetcher).not.toHaveBeenCalled();
    expect(output(spies)).toBe("[]");
  });

  it("preserves the reviewed bundled client's runtime endpoint methods", () => {
    const original = createClerkClient({ publishableKey, secretKey, telemetry: { disabled: true } });
    const isolated = createByteReadingClerkClient({ publishableKey, secretKey });
    for (const key of Object.keys(original)) {
      const before = original[key as keyof typeof original];
      const after: unknown = Reflect.get(isolated, key);
      expect(after, key).toBeDefined();
      if (typeof before !== "object" || before === null || key === "telemetry") continue;
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(before))
        .filter(name => name !== "constructor" && typeof (before as unknown as Record<string, unknown>)[name] === "function");
      for (const method of methods) expect(typeof (after as unknown as Record<string, unknown>)[method], `${key}.${method}`).toBe("function");
    }
  });

  it("INV-6: never fetches JWKS or certs in the Cloudflare Access adapter", async () => {
    const spies = captureOutput();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const adapter = cloudflareAccessAuth();
    const request = new Request(BASE, { headers: { "Cf-Access-Jwt-Assertion": SENTINEL } });
    expect((await adapter.authorize(request, BASE)).ok).toBe(false);
    expect(await adapter.authorize(request, BASE, { access: { aud: "access-app", getIdentity: async () => ({ user_uuid: "access-user" }) } })).toEqual({ ok: true, userId: "access-user", subjectId: "access-user" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(output(spies)).not.toContain(SENTINEL);
  });
});
