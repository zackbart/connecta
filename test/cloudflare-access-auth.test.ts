import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticationSnapshot } from "../src/auth-admission.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { InboundAuthRuntimeContext } from "../src/types.js";
import { makeDeployment, mcpRpc } from "./fixtures/http.js";
import { oauthVault } from "./fixtures/oauth.js";

const BASE = "https://connecta.test";
const request = new Request(`${BASE}/mcp`);

function runtime(identity?: Record<string, unknown>): InboundAuthRuntimeContext {
  return {
    access: {
      aud: "access-app",
      getIdentity: async () => identity,
    },
  };
}

function workerRuntime(identity?: Record<string, unknown>) {
  return {
    ...runtime(identity),
    waitUntil() {},
  };
}

describe("cloudflareAccessAuth", () => {
  it.each(["/ui/connectors/calc", "/ui/api/config", "/mcp"])(
    "fails retryably before connector work when the first %s request has an assertion but no Access context",
    async (path) => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const deployment = makeDeployment({ auth: cloudflareAccessAuth(), maintainers: ["operator-1"], logger });
      const listTools = vi.spyOn(deployment.registry.getConnector("calc")!, "listTools");
      const request = () => {
        const value = path === "/mcp" ? mcpRpc("tools/list", {}) : new Request(`${BASE}${path}`);
        value.headers.set("Cf-Access-Jwt-Assertion", "untrusted-assertion-must-not-be-logged");
        return value;
      };
      try {
        const first = await deployment.fetch(request(), undefined, { waitUntil() {} });
        expect(first.status).toBe(503);
        expect(first.headers.get("Retry-After")).toBe("1");
        expect(first.headers.get("Cache-Control")).toBe("no-store");
        expect(first.headers.has("WWW-Authenticate")).toBe(false);
        await expect(first.json()).resolves.toMatchObject({ problem: "access_context_unavailable" });
        expect(listTools).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith("[connecta] Cloudflare Access verification unavailable", {
          reason: "access_context_unavailable",
          accessContext: false,
          authorizationHeader: "absent",
        });

        const next = await deployment.fetch(request(), undefined, workerRuntime({ user_uuid: "operator-1" }));
        expect(next.status).toBe(200);
        await next.body?.cancel();
        const missingAgain = await deployment.fetch(request(), undefined, { waitUntil() {} });
        expect(missingAgain.status).toBe(503);
      } finally {
        listTools.mockRestore();
        await deployment.close();
      }
    },
  );

  it("does not treat an assertion header as verified identity or fall back while its context is unavailable", async () => {
    const fallback = vi.fn(() => ({ ok: true as const, userId: "operator-1" }));
    const deployment = makeDeployment({
      auth: [{ kind: "fallback", authorize: fallback }, cloudflareAccessAuth()],
      maintainers: [{ namespace: "cloudflare-access", id: "operator-1" }],
      logger: "silent",
    });
    try {
      const response = await deployment.fetch(
        new Request(`${BASE}/ui/data`, { headers: { "Cf-Access-Jwt-Assertion": "forged" } }),
      );
      expect(response.status).toBe(503);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      await deployment.close();
    }
  });

  it("admits the first request of a fresh instance with trusted context without consulting caller assertions", async () => {
    const deployment = makeDeployment({ auth: cloudflareAccessAuth(), maintainers: ["operator-1"], logger: "silent" });
    try {
      const response = await deployment.fetch(
        new Request(`${BASE}/ui/connectors/calc`, { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } }),
        undefined,
        workerRuntime({ user_uuid: "operator-1" }),
      );
      expect(response.status).toBe(200);
    } finally {
      await deployment.close();
    }
  });

  it.each(["/ui/data", "/ui/api/config", "/ui/connectors/calc", "/ui/oauth/calc"])(
    "logs classified facts once for every operator 401 at %s without reading provider text",
    async (path) => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const deployment = makeDeployment({
        auth: {
          kind: "fixture",
          interactiveOperator: true,
          authorize: () => ({
            ok: false,
            response: Response.json({ error: "provider-secret", code: "secret-code" }, { status: 401 }),
          }),
        },
        maintainers: [{ namespace: "fixture", id: "operator-1" }],
        logger,
      });
      try {
        for (const [authorization, kind] of [
          [undefined, "absent"],
          ["Bearer secret-token", "bearer"],
          ["Basic secret-credentials", "invalid"],
        ] as const) {
          logger.warn.mockClear();
          const headers = {
            Origin: BASE,
            Cookie: "secret-cookie",
            ...(authorization ? { Authorization: authorization } : {}),
          };
          const response = await deployment.fetch(
            new Request(`${BASE}${path}?secret=query`, { method: path.includes("/oauth/") ? "POST" : "GET", headers }),
            undefined,
            workerRuntime({ user_uuid: "secret-user", email: "secret@example.com" }),
          );
          expect(response.status).toBe(401);
          expect(logger.warn.mock.calls).toEqual([
            [
              "[connecta] operator_refused",
              {
                reason: kind === "invalid" ? "authorization_header_invalid" : "authentication_failed",
                accessContext: true,
                authorizationHeader: kind,
              },
            ],
          ]);
        }
      } finally {
        await deployment.close();
      }
    },
  );

  it("uses the trusted Worker identity as ambient operator auth", async () => {
    const auth = cloudflareAccessAuth();
    expect(auth).toMatchObject({
      kind: "cloudflare-access",
      interactiveOperator: true,
      uiAuth: { kind: "cloudflare-access" },
    });
    await expect(
      auth.authorize(request, BASE, runtime({ user_uuid: "user-123", email: "ada@example.com" })),
    ).resolves.toEqual({
      ok: true,
      userId: "user-123",
      subjectId: "user-123",
    });
  });

  it("INV-4: refuses Access service identities; machines need cta_ tokens", async () => {
    for (const identity of [
      undefined,
      { common_name: "service-client-id.access" },
      { service_token_id: "service-id" },
      { user_uuid: "human", service_token_status: true },
    ]) {
      const result = await cloudflareAccessAuth().authorize(request, BASE, runtime(identity));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  });

  it("INV-7: disposes each RPC identity result once, admitted or refused, despite a failed disposer", async () => {
    // workerd adds a non-enumerable disposer to every object a JS RPC call returns.
    for (const [identity, ok] of [
      [{ user_uuid: "user-123" }, true],
      [{ user_uuid: "human", service_token_status: true }, false],
    ] as const) {
      for (const fails of [false, true]) {
        const dispose = vi.fn(() => {
          if (fails) throw new Error("broken identity disposer");
        });
        const result = await cloudflareAccessAuth().authorize(request, BASE, {
          access: {
            aud: "access-app",
            getIdentity: async () => Object.defineProperty({ ...identity }, Symbol.dispose, { value: dispose }),
          },
        });
        expect(result.ok).toBe(ok);
        if (result.ok) expect(result).toMatchObject({ userId: "user-123" });
        else expect(result.response.status).toBe(403);
        expect(dispose).toHaveBeenCalledOnce();
      }
    }
  });

  it.each(["valid", "expired"])(
    "INV-4: refuses %s caller JWTs without edge-validated context on Node and Workers",
    async (verdict) => {
      const header = btoa(JSON.stringify({ alg: "none" }));
      const payload = btoa(
        JSON.stringify({
          sub: "human",
          aud: "access-app",
          exp: verdict === "expired" ? 1 : 9999999999,
        }),
      );
      const jwt = `${header}.${payload}.signature`;
      const fetcher = vi.spyOn(globalThis, "fetch");
      const result = await cloudflareAccessAuth().authorize(
        new Request(`${BASE}/mcp`, { headers: { "Cf-Access-Jwt-Assertion": jwt, Authorization: `Bearer ${jwt}` } }),
        BASE,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
        expect(result.response.headers.get("WWW-Authenticate")).toBe('Bearer scope="openid email"');
      }
      expect(fetcher).not.toHaveBeenCalled();
      fetcher.mockRestore();
    },
  );

  it.each([undefined, "bad aud"])(
    "INV-4: refuses malformed trusted application AUD %j before identity lookup",
    async (aud) => {
      const getIdentity = vi.fn(async () => ({ user_uuid: "human" }));
      const result = await cloudflareAccessAuth().authorize(request, BASE, {
        access: { aud: aud as string, getIdentity },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(503);
        expect(result.response.headers.get("Retry-After")).toBe("1");
        expect(result.response.headers.has("WWW-Authenticate")).toBe(false);
        await expect(result.response.json()).resolves.toMatchObject({ problem: "access_audience_invalid" });
      }
      expect(getIdentity).not.toHaveBeenCalled();
    },
  );

  it("logs the missing-context 401 without an assertion and preserves explicit-header precedence", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deployment = makeDeployment({ auth: cloudflareAccessAuth(), maintainers: ["operator-1"], logger });
    const getIdentity = vi.fn(async () => ({ user_uuid: "operator-1" }));
    try {
      const missing = await deployment.fetch(new Request(`${BASE}/ui/data`), undefined, { waitUntil() {} });
      expect(missing.status).toBe(401);
      expect(missing.headers.has("WWW-Authenticate")).toBe(true);
      expect(logger.warn).toHaveBeenLastCalledWith("[connecta] operator_refused", {
        reason: "access_context_missing",
        accessContext: false,
        authorizationHeader: "absent",
      });

      const explicit = await deployment.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: {
            Authorization: "Bearer untrusted-token",
            "Cf-Access-Jwt-Assertion": "untrusted-assertion",
          },
        }),
        undefined,
        { waitUntil() {}, access: { aud: "app", getIdentity } },
      );
      expect(explicit.status).toBe(401);
      expect(getIdentity).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenLastCalledWith("[connecta] operator_refused", {
        reason: "access_authorization_header_rejected",
        accessContext: true,
        authorizationHeader: "bearer",
      });
    } finally {
      await deployment.close();
    }
  });

  it("classifies an unavailable first identity lookup, never logs its exception, and admits a later verified request", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deployment = makeDeployment({ auth: cloudflareAccessAuth(), maintainers: ["operator-1"], logger });
    const getIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error("identity-lookup-secret"))
      .mockRejectedValueOnce(new Error("identity-lookup-secret"))
      .mockResolvedValue({ user_uuid: "operator-1" });
    const context = { waitUntil() {}, access: { aud: "app", getIdentity } };
    try {
      const first = await deployment.fetch(new Request(`${BASE}/ui/connectors/calc`), undefined, context);
      expect(first.status).toBe(503);
      expect(first.headers.has("WWW-Authenticate")).toBe(false);
      await expect(first.json()).resolves.toMatchObject({ problem: "identity_unavailable" });
      expect(logger.warn.mock.calls).toEqual([
        [
          "[connecta] Cloudflare Access verification unavailable",
          {
            reason: "access_identity_unavailable",
            identityLookup: {
              outcome: "rejected",
              durationMs: expect.any(Number),
              cold: expect.any(Boolean),
              inFlight: expect.any(Number),
            },
            accessContext: true,
            authorizationHeader: "absent",
          },
        ],
      ]);
      const next = await deployment.fetch(new Request(`${BASE}/ui/connectors/calc`), undefined, context);
      expect(next.status).toBe(200);
    } finally {
      await deployment.close();
    }
  });

  it("INV-4 INV-7: returns at the native Access deadline, never admits its late result, and disposes it", async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      let resolve!: (identity: Record<string, unknown>) => void;
      const pending = cloudflareAccessAuth().authorize(request, BASE, {
        access: {
          aud: "access-app",
          getIdentity: () =>
            new Promise((done) => {
              resolve = done;
            }),
        },
      });
      await vi.advanceTimersByTimeAsync(5001);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(503);
        expect(result.response.headers.get("Cache-Control")).toBe("no-store");
      }
      resolve(Object.defineProperty({ user_uuid: "late-human" }, Symbol.dispose, { value: dispose }));
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses Access-only machine MCP calls and operator mutation", async () => {
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth(),
      maintainers: ["operator-1"],
      connectors: [
        {
          id: "oauth",
          kind: "mcp",
          listTools: async () => [],
          callTool: async () => null,
          startAuth: async () => ({ state: "ok" }),
          finishAuth: async () => {},
          verifyState: async () => true,
          disconnectAuth: async () => {},
        },
      ],
    });
    const context = workerRuntime();

    const mcpRequest = mcpRpc("tools/list", {});
    const mcp = await deployment.fetch(mcpRequest, undefined, context);
    expect(mcp.status).toBe(403);

    const mutation = await deployment.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "POST",
        headers: {
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "forbidden" }),
      }),
      undefined,
      context,
    );
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toEqual({
      error: "Cloudflare Access human identity required",
    });
  });

  it("lets a human Access identity use same-origin operator mutation", async () => {
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth(),
      maintainers: ["operator-1"],
      vault: oauthVault(memoryStorage()),
      connectors: [
        {
          id: "oauth",
          kind: "mcp",
          listTools: async () => [],
          callTool: async () => null,
          startAuth: async () => ({ state: "ok" }),
          finishAuth: async () => {},
          verifyState: async () => true,
          disconnectAuth: async () => {},
        },
      ],
    });
    const context = workerRuntime({ user_uuid: "operator-1" });
    const crossOrigin = await deployment.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "forbidden" }),
      }),
      undefined,
      context,
    );
    expect(crossOrigin.status).toBe(403);

    const response = await deployment.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "POST",
        headers: {
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "agent" }),
      }),
      undefined,
      context,
    );
    expect(response.status).toBe(200);
  });
});

describe("Access identity lookup recovery", () => {
  it("INV-4: 20 concurrent admitted contexts recover transient rejection without crossing identities", async () => {
    vi.useFakeTimers();
    try {
      const auth = cloudflareAccessAuth();
      const lookups = Array.from({ length: 20 }, (_, i) =>
        vi
          .fn()
          .mockRejectedValueOnce(new Error("private identity failure"))
          .mockResolvedValue({ user_uuid: `human-${i}` }),
      );
      const pending = Promise.all(
        lookups.map((getIdentity, i) =>
          auth.authorize(
            new Request(`${BASE}/mcp`, { headers: { "Cf-Access-Jwt-Assertion": "same-caller-supplied-header" } }),
            BASE,
            { access: { aud: `app-${i % 2}`, getIdentity } },
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(300);
      const results = await pending;
      results.forEach((result, i) => {
        expect(result).toMatchObject({ ok: true, userId: `human-${i}` });
        expect(lookups[i]).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("INV-4: one retry cannot admit a failed identity or reuse an earlier success", async () => {
    vi.useFakeTimers();
    try {
      const auth = cloudflareAccessAuth();
      const getIdentity = vi
        .fn()
        .mockResolvedValueOnce({ user_uuid: "alice" })
        .mockRejectedValue(new Error("private vendor failure"));
      const context = { access: { aud: "app", getIdentity } };
      expect(await auth.authorize(request, BASE, context)).toMatchObject({ ok: true, userId: "alice" });
      for (let i = 0; i < 2; i++) {
        const pending = auth.authorize(request, BASE, context);
        await vi.advanceTimersByTimeAsync(300);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(503);
          expect(result.response.headers.get("Retry-After")).toBe("1");
          expect(await result.response.text()).not.toContain("private vendor failure");
        }
      }
      expect(getIdentity).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("INV-7: a rejected lookup followed by a stall shares the original deadline", async () => {
    vi.useFakeTimers();
    try {
      const getIdentity = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockImplementation(() => new Promise(() => {}));
      const pending = cloudflareAccessAuth().authorize(request, BASE, { access: { aud: "app", getIdentity } });
      await vi.advanceTimersByTimeAsync(5001);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(503);
      expect(getIdentity).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Access assertion verification without context", () => {
  const TEAM = "https://team.cloudflareaccess.com";
  const CERTS = `${TEAM}/cdn-cgi/access/certs`;
  const AUD = "a".repeat(64);
  const assertion = { teamDomain: "team.cloudflareaccess.com", audience: AUD };
  let current: CryptoKeyPair;
  let next: CryptoKeyPair;
  let publicCurrent: JsonWebKey;
  let publicNext: JsonWebKey;
  const now = () => Math.floor(Date.now() / 1000);
  const b64 = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const json = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));

  beforeAll(async () => {
    const generate = () =>
      crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      ) as Promise<CryptoKeyPair>;
    current = await generate();
    next = await generate();
    publicCurrent = (await crypto.subtle.exportKey("jwk", current.publicKey)) as JsonWebKey;
    publicNext = (await crypto.subtle.exportKey("jwk", next.publicKey)) as JsonWebKey;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The application token Access forwards to the origin; its `sub` is the user id.
  async function token(
    changes: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
    key = current.privateKey,
  ) {
    const claims = {
      aud: [AUD],
      email: "alice@example.com",
      exp: now() + 3600,
      iat: now(),
      nbf: now(),
      iss: TEAM,
      type: "app",
      identity_nonce: "nonce",
      sub: "operator-1",
      country: "US",
      ...changes,
    };
    const input = `${json({ alg: "RS256", kid: "current", typ: "JWT", ...header })}.${json(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
    return `${input}.${b64(new Uint8Array(signature))}`;
  }

  function certs(keys: () => JsonWebKey[] = () => [{ ...publicCurrent, kid: "current", alg: "RS256", use: "sig" }]) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(new Request(url, init).url).toBe(CERTS);
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ keys: keys(), public_cert: { kid: "current", cert: "PEM" } });
    });
  }

  const asserted = (value: string, path = "/mcp") =>
    new Request(`${BASE}${path}`, { headers: { "Cf-Access-Jwt-Assertion": value } });

  async function refused(result: Awaited<ReturnType<ReturnType<typeof cloudflareAccessAuth>["authorize"]>>) {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Retry-After")).toBe("1");
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.response.headers.has("WWW-Authenticate")).toBe(false);
    await expect(result.response.json()).resolves.toEqual({
      error: "Cloudflare Access identity unavailable",
      problem: "access_context_unavailable",
    });
  }

  it("INV-4: admits a verified assertion with the principal trusted context yields, and only without context", async () => {
    const fetcher = certs();
    const auth = cloudflareAccessAuth({ assertion });
    const value = await token();
    const expected = { ok: true, userId: "operator-1", subjectId: "operator-1" };
    await expect(auth.authorize(asserted(value), BASE)).resolves.toEqual(expected);
    await expect(auth.authorize(asserted(value), BASE, { waitUntil() {} } as never)).resolves.toEqual(expected);
    await expect(
      auth.authorize(asserted(value), BASE, runtime({ user_uuid: "operator-1", email: "alice@example.com" })),
    ).resolves.toEqual(expected);
    // Present context is trusted as before: the assertion is never consulted.
    await expect(auth.authorize(asserted("not-a-jwt"), BASE, runtime({ user_uuid: "operator-1" }))).resolves.toEqual(
      expected,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      auth.authorize(asserted(await token({ sub: undefined, email: "alice@example.com" })), BASE),
    ).resolves.toMatchObject({ ok: true, userId: "alice@example.com" });
  });

  it.each([
    ["the wrong audience", { aud: ["other-application"] }, {}],
    ["a string audience for another application", { aud: "other-application" }, {}],
    ["the wrong issuer", { iss: "https://other.cloudflareaccess.com" }, {}],
    ["a look-alike issuer", { iss: `${TEAM}.attacker.test` }, {}],
    ["an org session token", { type: "org" }, {}],
    ["an expired token", { exp: now() - 31, iat: now() - 3600 }, {}],
    ["a token not valid yet", { nbf: now() + 120 }, {}],
    ["a token without iat", { iat: undefined }, {}],
    ["an HS256 header", {}, { alg: "HS256" }],
    ["an unsigned header", {}, { alg: "none" }],
    ["a missing kid", {}, { kid: undefined }],
    ["a critical extension", {}, { crit: ["exp"] }],
  ])("INV-4: refuses %s retryably without identity or a key fetch", async (_label, claims, header) => {
    const fetcher = certs();
    const auth = cloudflareAccessAuth({ assertion });
    await refused(await auth.authorize(asserted(await token(claims, header)), BASE));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("INV-4: refuses bad signatures, unknown keys and malformed assertions without identity", async () => {
    const fetcher = certs();
    const auth = cloudflareAccessAuth({ assertion });
    const valid = await token();
    const [head, body] = valid.split(".");
    for (const value of [
      await token({}, {}, next.privateKey),
      `${head}.${json({ ...JSON.parse(atob(body!.replace(/-/g, "+").replace(/_/g, "/"))), sub: "operator-2" })}.${valid.split(".")[2]}`,
      `${head}.${body}.not*base64`,
      `${head}.${body}.`,
      `${head}.${body}`,
      "",
      "forged",
      `${valid}, ${valid}`,
    ]) {
      await refused(await auth.authorize(asserted(value), BASE));
    }
    await refused(await auth.authorize(asserted(await token({}, { kid: "unknown" })), BASE));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("INV-4: refuses verified service-token assertions as it refuses their trusted identities", async () => {
    certs();
    const auth = cloudflareAccessAuth({ assertion });
    for (const claims of [
      { sub: "", email: undefined, common_name: "client-id.access" },
      { sub: "", email: undefined },
      { common_name: "client-id.access" },
    ]) {
      const result = await auth.authorize(asserted(await token(claims)), BASE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        await expect(result.response.json()).resolves.toEqual({ error: "Cloudflare Access human identity required" });
      }
    }
    const nobody = await auth.authorize(asserted(await token({ sub: undefined, email: undefined })), BASE);
    expect(nobody.ok).toBe(false);
    if (!nobody.ok) expect(nobody.response.status).toBe(403);
  });

  it("INV-4: keeps the missing-header 401 and explicit-header precedence without fetching keys", async () => {
    const fetcher = certs();
    const auth = cloudflareAccessAuth({ assertion });
    const missing = await auth.authorize(new Request(`${BASE}/mcp`), BASE);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.response.status).toBe(401);
    const value = await token();
    const explicit = await auth.authorize(
      new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${value}`, "Cf-Access-Jwt-Assertion": value } }),
      BASE,
    );
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) expect(explicit.response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("INV-4 INV-7: fails closed with a retryable 503 when the key set cannot be read, then recovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const value = await token({ exp: now() + 7200 });
    const auth = cloudflareAccessAuth({ assertion });
    const outages: Array<() => Promise<Response>> = [
      async () => new Response("unavailable", { status: 503 }),
      async () => {
        throw new TypeError("network failure");
      },
      async () => new Response("{not json", { status: 200 }),
      async () => new Response(null, { status: 302, headers: { Location: "https://attacker.test/certs" } }),
      async () => Response.json({ keys: [{ ...publicCurrent, kid: "current", d: "private" }] }),
      async () => Response.json({ keys: [] }),
    ];
    for (const outage of outages) {
      const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(outage);
      await refused(await auth.authorize(asserted(value), BASE));
      // A failed read blocks key fetches for thirty seconds rather than retrying per request.
      await refused(await auth.authorize(asserted(value), BASE));
      expect(fetcher).toHaveBeenCalledTimes(1);
      fetcher.mockRestore();
      vi.setSystemTime(Date.now() + 30_001);
    }
    const fetcher = certs();
    await expect(auth.authorize(asserted(value), BASE)).resolves.toMatchObject({ ok: true, userId: "operator-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("INV-7: ends a hanging key fetch at its own deadline and backs off before fetching again", async () => {
    const value = await token({ exp: now() + 7200 });
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    const auth = cloudflareAccessAuth({ assertion });
    const pending = auth.authorize(asserted(value), BASE);
    await vi.advanceTimersByTimeAsync(4_001);
    await refused(await pending);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    // A deadline is a failed read: no request starts another for thirty seconds.
    for (let i = 0; i < 5; i++) await refused(await auth.authorize(asserted(value), BASE));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    fetcher.mockImplementation(async () => Response.json({ keys: [{ ...publicCurrent, kid: "current" }] }));
    await expect(auth.authorize(asserted(value), BASE)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("INV-7: repeated disconnects start at most two key fetches, charged to their starters until they fill the cache", async () => {
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth({ assertion }),
      maintainers: ["operator-1"],
      logger: "silent",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      await gate;
      init?.signal?.throwIfAborted();
      return Response.json({ keys: [{ ...publicCurrent, kid: "current" }] });
    });
    const kept: Promise<unknown>[] = [];
    const context = { waitUntil: (pending: Promise<unknown>) => void kept.push(pending) };
    const baseline = authenticationSnapshot().active;
    try {
      const value = await token();
      for (let i = 0; i < 20; i++) {
        const controller = new AbortController();
        const request = new Request(`${BASE}/ui/connectors/calc`, {
          headers: { "Cf-Access-Jwt-Assertion": value },
          signal: controller.signal,
        });
        const pending = deployment.fetch(request, undefined, context);
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();
        await pending.then(
          (response) => response.body?.cancel(),
          () => {},
        );
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
      // Each fetch outlives the caller that left, still charged and kept runnable.
      for (const call of fetcher.mock.calls) expect(call[1]?.signal?.aborted).toBe(false);
      expect(authenticationSnapshot().active).toBe(baseline + 2);
      release();
      await Promise.all(kept);
      expect(authenticationSnapshot().active).toBe(baseline);
      const admitted = await deployment.fetch(
        new Request(`${BASE}/ui/connectors/calc`, { headers: { "Cf-Access-Jwt-Assertion": value } }),
        undefined,
        { waitUntil() {} },
      );
      expect(admitted.status).toBe(200);
      await admitted.body?.cancel();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await deployment.close();
    }
  });

  it("INV-4 INV-7: follows key rotation with one bounded refresh and keeps the previous key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let keys = [{ ...publicCurrent, kid: "current" }];
    const fetcher = certs(() => keys);
    const auth = cloudflareAccessAuth({ assertion });
    const before = await token({ exp: now() + 7200 });
    await expect(auth.authorize(asserted(before), BASE)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Access publishes the new key beside the previous one.
    keys = [
      { ...publicNext, kid: "next" },
      { ...publicCurrent, kid: "current" },
    ];
    const rotated = await token({ exp: now() + 7200 }, { kid: "next" }, next.privateKey);
    await expect(auth.authorize(asserted(rotated), BASE)).resolves.toMatchObject({ ok: true });
    await expect(auth.authorize(asserted(before), BASE)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Unknown kids refresh at most once every thirty seconds.
    const unknown = await token({ exp: now() + 7200 }, { kid: "unknown" });
    await refused(await auth.authorize(asserted(unknown), BASE));
    await refused(await auth.authorize(asserted(unknown), BASE));
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 30_001);
    await refused(await auth.authorize(asserted(unknown), BASE));
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Cached keys expire after five minutes; a retired key then stops verifying.
    keys = [{ ...publicNext, kid: "next" }];
    vi.setSystemTime(Date.now() + 300_001);
    await refused(await auth.authorize(asserted(before), BASE));
    await expect(auth.authorize(asserted(rotated), BASE)).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("admits a fresh isolate's first request and logs classified assertion failures through the route", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth({ assertion }),
      maintainers: ["operator-1"],
      logger,
    });
    const listTools = vi.spyOn(deployment.registry.getConnector("calc")!, "listTools");
    const fetcher = certs();
    try {
      const value = await token();
      for (const path of ["/ui/connectors/calc", "/mcp"]) {
        const request = path === "/mcp" ? mcpRpc("tools/list", {}) : new Request(`${BASE}${path}`);
        request.headers.set("Cf-Access-Jwt-Assertion", value);
        const response = await deployment.fetch(request, undefined, { waitUntil() {} });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();

      listTools.mockClear();
      const forged = await token({ aud: ["other-application"] });
      const refusedResponse = await deployment.fetch(
        new Request(`${BASE}/ui/connectors/calc`, { headers: { "Cf-Access-Jwt-Assertion": forged } }),
        undefined,
        { waitUntil() {} },
      );
      expect(refusedResponse.status).toBe(503);
      expect(listTools).not.toHaveBeenCalled();
      expect(logger.warn.mock.calls).toEqual([
        [
          "[connecta] Cloudflare Access verification unavailable",
          { reason: "access_assertion_invalid", accessContext: false, authorizationHeader: "absent" },
        ],
      ]);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(forged);

      logger.warn.mockClear();
      const outage = cloudflareAccessAuth({ assertion });
      const unreadable = makeDeployment({ auth: outage, maintainers: ["operator-1"], logger });
      fetcher.mockImplementation(async () => new Response("unavailable", { status: 500 }));
      try {
        const response = await unreadable.fetch(
          new Request(`${BASE}/ui/connectors/calc`, { headers: { "Cf-Access-Jwt-Assertion": value } }),
          undefined,
          { waitUntil() {} },
        );
        expect(response.status).toBe(503);
        expect(logger.warn.mock.calls).toEqual([
          [
            "[connecta] Cloudflare Access verification unavailable",
            { reason: "access_keys_unavailable", accessContext: false, authorizationHeader: "absent" },
          ],
        ]);
      } finally {
        await unreadable.close();
      }
    } finally {
      listTools.mockRestore();
      await deployment.close();
    }
  });

  it("INV-11: rejects partial or malformed assertion settings without echoing them", () => {
    const secretish = "https://attacker.example";
    for (const options of [
      { assertion: { teamDomain: "team.cloudflareaccess.com" } },
      { assertion: { audience: AUD } },
      { assertion: { teamDomain: secretish, audience: AUD } },
      { assertion: { teamDomain: "team.cloudflareaccess.com.attacker.example", audience: AUD } },
      { assertion: { teamDomain: "https://team.cloudflareaccess.com/path", audience: AUD } },
      { assertion: { teamDomain: "http://team.cloudflareaccess.com", audience: AUD } },
      { assertion: { teamDomain: "team.cloudflareaccess.com", audience: "" } },
      { assertion: { teamDomain: "team.cloudflareaccess.com", audience: `${AUD} ` } },
      { assertion: { teamDomain: "team.cloudflareaccess.com", audience: AUD, issuer: secretish } },
      { assertion: "team.cloudflareaccess.com" },
      { teamDomain: "team.cloudflareaccess.com", audience: AUD },
    ]) {
      expect(() => cloudflareAccessAuth(options as never)).toThrow(TypeError);
      try {
        cloudflareAccessAuth(options as never);
      } catch (error) {
        expect(String(error)).not.toContain("attacker");
      }
    }
    for (const teamDomain of [
      "team.cloudflareaccess.com",
      "https://team.cloudflareaccess.com",
      "https://Team.cloudflareaccess.com/",
    ])
      expect(() => cloudflareAccessAuth({ assertion: { teamDomain, audience: AUD } })).not.toThrow();
    expect(() => cloudflareAccessAuth({})).not.toThrow();
  });
});
