import { describe, expect, it, vi } from "vitest";
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

  it("INV-4 INV-7: returns at the native Access deadline and never admits its late result", async () => {
    vi.useFakeTimers();
    try {
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
      resolve({ user_uuid: "late-human" });
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
