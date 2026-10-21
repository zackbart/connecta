import { afterEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "@clerk/backend/jwt";
import { clerkAuth } from "../src/auth/clerk.js";
import { createByteReadingClerkClient } from "../src/auth/clerk-transport.js";
import { authorize as authorizeIdentity, authorizeUiIdentity } from "../src/routes/shared.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { accessTokens, AccessTokenManager } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";
import { activityHistory } from "../src/activity.js";
import type { ConnectaPoolConfig } from "../src/config.js";
import type { InboundAuth } from "../src/types.js";

const BASE = "https://connecta.test";
const FRONTEND = "https://clerk.example.com";
const publishableKey = `pk_test_${btoa("clerk.example.com$")}`;
const secretKey = "sk_test_fake";
const SENTINEL = "planted-clerk-upstream-7f3a9c";

function captureOutput() {
  return ["log", "info", "warn", "error", "debug"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation(() => {}),
  );
}
function output(spies: ReturnType<typeof captureOutput>) {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

async function session(userId = "user_123") {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicKey = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const kid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      sub: userId,
      sid: "sess_test",
      iss: FRONTEND,
      azp: BASE,
      exp: now + 300,
      nbf: now - 5,
      iat: now - 5,
    },
    privateKey,
    { algorithm: "RS256", header: { typ: "JWT", kid } },
  );
  return { token, privateKey, kid, jwks: { keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }] } };
}

function auth() {
  return clerkAuth({ publishableKey, secretKey, publicUrl: BASE });
}
function browser(nonce?: string) {
  return new Request(`${BASE}/connect/service${nonce ? `?__clerk_handshake_nonce=${nonce}` : ""}`, {
    headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
  });
}

async function assertDenialSinks(
  provider: InboundAuth,
  request: Request,
  status: number,
  spies: ReturnType<typeof captureOutput>,
  context?: {
    waitUntil(promise: Promise<unknown>): void;
    access: { aud: string; getIdentity(): Promise<Record<string, unknown>> };
  },
  options: { pools?: Record<string, ConnectaPoolConfig>; reason?: string; canaries?: string[] } = {},
) {
  const lines: unknown[][] = [];
  const sink = (...args: unknown[]) => {
    lines.push(args);
  };
  const record = vi.fn();
  const storage = memoryStorage();
  const call = vi.fn(async () => null);
  const app = createTestConnecta({
    publicUrl: BASE,
    auth: provider,
    // A bare id resolves in the one interactive provider's namespace; nobody
    // these tests admit is a maintainer or a pool member (#837).
    maintainers: ["maintainer"],
    pools: options.pools,
    connectors: [
      {
        id: "service",
        kind: "mcp",
        description: "Service",
        listTools: async () => [],
        callTool: call,
        status: async () => ({ state: "ok" }),
      },
    ],
    accessTokens: accessTokens(storage),
    activity: activityHistory({ store: { record } }),
    logger: { debug: sink, info: sink, warn: sink, error: sink },
  });
  try {
    const response = await app.fetch(request, undefined, context);
    expect(response.status).toBe(status);
    const health = await app.fetch(new Request(`${BASE}/health`));
    const connectorStatus = await app.registry.statusFor("service", BASE);
    const operatorData = JSON.stringify({
      lines,
      activity: record.mock.calls,
      connectorStatus,
      config: app.describeConfig(),
      health: await health.json(),
      refusal: await response.text(),
    });
    for (const canary of [SENTINEL, ...(options.canaries ?? [])]) {
      expect(operatorData).not.toContain(canary);
      expect(output(spies)).not.toContain(canary);
    }
    if (options.reason) expect(lines).toEqual([["[connecta] MCP pool request denied", { reason: options.reason }]]);
    expect(record).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Clerk operator output with the real SDK", () => {
  it.each(["domain-denied", "lookup-failed", "gate-failed"])(
    "INV-6: Clerk %s exposes no provider identity in logs, activity, or status",
    async (denial) => {
      const spies = captureOutput();
      const userId = `${SENTINEL}-user`;
      const domain = `${SENTINEL}.example.com`;
      const email = `${SENTINEL}@${domain}`;
      const { token, privateKey, kid, jwks } = await session(userId);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          if (url.pathname === "/v1/jwks") return Response.json(jwks);
          expect(url.pathname).toBe(`/v1/users/${userId}`);
          if (denial === "lookup-failed") throw new Error(`${userId} ${email} ${domain}`);
          return Response.json({
            object: "user",
            id: userId,
            primary_email_address_id: "primary",
            email_addresses: [
              {
                object: "email_address",
                id: "primary",
                linked_to: [],
                email_address: email,
                verification: { status: "verified" },
              },
            ],
            phone_numbers: [],
            web3_wallets: [],
            external_accounts: [],
          });
        }),
      );
      const provider = clerkAuth({
        publishableKey,
        secretKey,
        publicUrl: BASE,
        ...(denial.startsWith("gate-")
          ? {
              gate: () => {
                throw new Error(`${userId} ${email} ${domain}`);
              },
            }
          : { allowedDomains: ["allowed.example.com"] }),
      });
      await assertDenialSinks(
        provider,
        new Request(`${BASE}/ui/access-tokens`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        403,
        spies,
      );
      const now = Math.floor(Date.now() / 1000);
      const oauthToken = await signJwt(
        {
          sub: userId,
          iss: FRONTEND,
          client_id: "client_connecta",
          scope: "openid profile email",
          aud: `${BASE}/mcp`,
          exp: now + 300,
          nbf: now - 5,
          iat: now - 5,
        },
        privateKey,
        { algorithm: "RS256", header: { typ: "at+jwt", kid } },
      );
      await assertDenialSinks(
        provider,
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${oauthToken}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
        403,
        spies,
      );
      const reasons: Record<string, string> = {
        "domain-denied": "email_domain_denied",
        "lookup-failed": "email_lookup_failed",
        "gate-failed": "gate_failed",
      };
      expect(output(spies)).toContain(`"reason":"${reasons[denial]}"`);
    },
  );

  it.each(["service", "identity-failed"])(
    "INV-6: Access %s exposes no provider identity in logs, activity, or status",
    async (denial) => {
      const spies = captureOutput();
      const identity = { user_uuid: `${SENTINEL}-user`, email: `${SENTINEL}@${SENTINEL}.example.com` };
      const getIdentity = vi.fn(async () => {
        if (denial === "identity-failed") throw new Error(JSON.stringify(identity));
        return { ...identity, service_token_status: true, common_name: `${SENTINEL}.example.com` };
      });
      const context = { waitUntil() {}, access: { aud: "app", getIdentity } };
      const request = new Request(`${BASE}/ui/access-tokens`);
      await assertDenialSinks(
        cloudflareAccessAuth(),
        request,
        denial === "identity-failed" ? 503 : 403,
        spies,
        context,
      );
      await assertDenialSinks(
        cloudflareAccessAuth(),
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: {
            ...Object.fromEntries(request.headers),
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
        denial === "identity-failed" ? 503 : 403,
        spies,
        context,
      );
    },
  );

  it.each([
    { provider: "clerk", reason: "not_pool_member" },
    { provider: "access-email", reason: "pool_not_declared" },
  ])(
    "INV-4 INV-6: $provider $reason exposes no provider identity in pool refusal sinks",
    async ({ provider: kind, reason }) => {
      const spies = captureOutput();
      const userId = `${SENTINEL}-user`;
      const email = "denied-canary@example.test";
      const name = `${SENTINEL}-name`;
      const identity = { email, name };
      const getIdentity = vi.fn(async () => identity);
      const context = kind === "clerk" ? undefined : { waitUntil() {}, access: { aud: "app", getIdentity } };
      const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      });
      if (kind === "clerk") {
        const { privateKey, kid, jwks } = await session(userId);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Response.json(jwks)),
        );
        const now = Math.floor(Date.now() / 1000);
        const token = await signJwt(
          {
            sub: userId,
            iss: FRONTEND,
            client_id: "client_connecta",
            scope: "openid profile email",
            aud: `${BASE}/mcp/support`,
            exp: now + 300,
            nbf: now - 5,
            iat: now - 5,
          },
          privateKey,
          { algorithm: "RS256", header: { typ: "at+jwt", kid } },
        );
        headers.set("Authorization", `Bearer ${token}`);
      }
      await assertDenialSinks(
        kind === "clerk" ? auth() : cloudflareAccessAuth(),
        new Request(`${BASE}/mcp/support`, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
        404,
        spies,
        context,
        {
          // The pool's one member is someone else, so the caller is refused.
          pools: reason === "pool_not_declared" ? {} : { support: { tools: ["service"], members: ["someone-else"] } },
          reason,
          canaries: [userId, email, "example.test", name],
        },
      );
      if (context) expect(getIdentity).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/ui/access-tokens", "/connect/service", "/mcp"])(
    "INV-4: explicit Authorization owns %s with another user's real session cookie",
    async (path) => {
      captureOutput();
      const { token: cookie, privateKey, kid, jwks } = await session("cookie_user");
      const now = Math.floor(Date.now() / 1000);
      const isMcp = path.startsWith("/mcp");
      const headerToken = await signJwt(
        {
          sub: "header_user",
          iss: FRONTEND,
          exp: now + 300,
          nbf: now - 5,
          iat: now - 5,
          ...(isMcp
            ? { client_id: "client_connecta", scope: "openid profile email", aud: `${BASE}${path}` }
            : { sid: "sess_header", azp: BASE }),
        },
        privateKey,
        { algorithm: "RS256", header: { typ: isMcp ? "at+jwt" : "JWT", kid } },
      );
      const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(jwks));
      vi.stubGlobal("fetch", fetcher);
      const provider = auth();
      const manager = new AccessTokenManager(memoryStorage(), { agents: ["machine"] });
      const machine = await manager.rotate("machine");
      const getIdentity = vi.fn(async () => ({ user_uuid: "ambient_access_user" }));
      const context = { waitUntil() {}, access: { aud: "app", getIdentity } };
      const providers = [manager.auth, cloudflareAccessAuth(), provider];
      const verify = (request: Request) =>
        isMcp
          ? authorizeIdentity(request, BASE, providers, context)
          : authorizeUiIdentity(request, BASE, providers, "human route", context);
      for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
        const request = new Request(`${BASE}${path}`, {
          headers: {
            Authorization: `${scheme} ${headerToken}`,
            Cookie: `__session=${cookie}; __client_uat=${now - 10}; __clerk_db_jwt=dev-browser`,
          },
        });
        const result = await verify(request);
        expect(result.ok, scheme).toBe(true);
        if (result.ok) expect(result.identity.principal).toEqual({ namespace: FRONTEND, id: "header_user" });
        expect(await provider.authorize(request, BASE)).toEqual({ ok: true, userId: "header_user" });
      }
      for (const header of [
        "",
        "Basic unknown",
        "Unknown unknown",
        "Bearer",
        "Bearer ",
        `Bearer  ${headerToken}`,
        `Bearer\t${headerToken}`,
        `Bearer ${headerToken}, Bearer ${cookie}`,
        "bearer invalid",
      ]) {
        const request = new Request(`${BASE}${path}?__clerk_handshake_nonce=ambient`, {
          headers: {
            Authorization: header,
            Cookie: `__session=${cookie}; __client_uat=${now - 10}; __clerk_db_jwt=dev-browser`,
          },
        });
        const result = await verify(request);
        expect(result.ok, header).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(401);
          expect(result.response.headers.get("WWW-Authenticate")).toBe(provider.challenge!(request, BASE));
        }
        const direct = await provider.authorize(request, BASE);
        expect(direct.ok).toBe(false);
        if (!direct.ok) expect(direct.response.status).toBe(401);
      }
      const machineResult = await verify(
        new Request(`${BASE}${path}`, {
          headers: {
            Authorization: `bEaReR ${machine.token}`,
            Cookie: `__session=${cookie}; __client_uat=${now - 10}; __clerk_db_jwt=dev-browser`,
          },
        }),
      );
      // Human endpoints refuse an agent token (#837), never falling back to the
      // cookie or Access identity: 401 at MCP endpoints, 403 at UI identity routes.
      expect(machineResult.ok).toBe(false);
      if (!machineResult.ok) expect(machineResult.response.status).toBe(isMcp ? 401 : 403);
      if (!isMcp) {
        const cookieResult = await authorizeUiIdentity(
          new Request(`${BASE}${path}`, {
            headers: { Cookie: `__session=${cookie}; __client_uat=${now - 10}; __clerk_db_jwt=dev-browser` },
          }),
          BASE,
          [provider],
          "human route",
        );
        expect(cookieResult.ok).toBe(true);
        if (cookieResult.ok)
          expect(cookieResult.identity.principal).toEqual({ namespace: FRONTEND, id: "cookie_user" });
      }
      expect(getIdentity).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([input]) => new URL(String(input)).pathname === "/v1/jwks")).toBe(true);
    },
  );

  it("INV-6: withholds handshake HTTP 400 error code, message, long_message, and headers", async () => {
    const spies = captureOutput();
    const upstream = Response.json(
      {
        errors: [
          { code: `${SENTINEL}-code`, message: `${SENTINEL}-message`, long_message: `${SENTINEL}-long-message` },
        ],
        clerk_trace_id: `${SENTINEL}-trace`,
      },
      { status: 400, statusText: `${SENTINEL}-status`, headers: { "cf-ray": `${SENTINEL}-ray` } },
    );
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
    expect(output(spies)).toContain('"reason":"authentication_failed"');
    expect(output(spies)).not.toContain("HandshakeService");
  });

  it("INV-6: rejects a JWKS failure with planted error text and Content-Type using a fixed reason", async () => {
    const spies = captureOutput();
    const { token } = await session();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ code: "clerk_key_invalid", message: SENTINEL, long_message: SENTINEL }],
            }),
            { status: 400, headers: { "Content-Type": `application/${SENTINEL}` } },
          ),
      ),
    );
    const request = browser();
    request.headers.set("Authorization", `Bearer ${token}`);
    expect((await auth().authorize(request, BASE)).ok).toBe(false);
    expect(output(spies)).not.toContain(SENTINEL);
    expect(output(spies)).toContain('"reason":"authentication_failed"');
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
    expect(await auth().authorize(browser("valid-nonce"), BASE)).toEqual({
      ok: true,
      userId: "user_123",
      sessionCookies: [cookie],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output(spies)).toBe("[]");
  });

  it("INV-6: byte-reads a fresh SDK opaque-verification client and preserves resource binding", async () => {
    const spies = captureOutput();
    const responses: Response[] = [];
    const nativeReaders: ReturnType<typeof vi.spyOn>[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => {
      const response = Response.json({
        object: "clerk_idp_oauth_access_token",
        id: "oat_verified",
        client_id: "client_connecta",
        subject: "user_123",
        type: "oauth_token",
        scopes: ["openid"],
        revoked: false,
        revocation_reason: null,
        expired: false,
        expiration: Date.now() + 300_000,
        created_at: Date.now(),
        updated_at: Date.now(),
        aud: `${BASE}/mcp`,
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
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
    expect(output(spies)).toBe("[]");
  });

  it("INV-4 INV-6: verifies valid, invalid, expired and wrong-audience OAuth JWTs through the bundled SDK", async () => {
    const spies = captureOutput();
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const publicKey = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const kid = crypto.randomUUID();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [{ ...publicKey, kid, alg: "RS256", use: "sig" }] })),
    );
    const now = Math.floor(Date.now() / 1000);
    const provider = auth();
    for (const verdict of ["valid", "invalid", "expired", "wrong-audience"]) {
      let token = await signJwt(
        {
          sub: "user_123",
          iss: FRONTEND,
          client_id: "client_connecta",
          scope: "openid profile email",
          iat: now - 300,
          nbf: now - 300,
          exp: verdict === "expired" ? now - 60 : now + 300,
          aud: verdict === "wrong-audience" ? "https://other.test/mcp" : `${BASE}/mcp`,
        },
        privateKey,
        { algorithm: "RS256", header: { typ: "at+jwt", kid } },
      );
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

  it("INV-6: contains handshake network and malformed-directive errors before SDK diagnostics", async () => {
    for (const fetcher of [
      vi.fn(async () => {
        throw new Error(SENTINEL);
      }),
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
});
