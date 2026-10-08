import { oauthVault } from "./fixtures/oauth.js";
import { memoryStorage } from "../src/storage/memory.js";
import { describe, expect, it, vi } from "vitest";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import type { InboundAuthRuntimeContext } from "../src/types.js";
import { authorize } from "../src/routes/shared.js";
import { fakeClerkAuth, makeDeployment, mcpRpc } from "./fixtures/http.js";

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

  it("INV-4: maps a human to its stable Access principal and result owner", async () => {
    const result = await authorize(request, BASE, [cloudflareAccessAuth()], workerRuntime({ user_uuid: "user-123" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.principal).toEqual({ namespace: "cloudflare-access", id: "user-123" });
      expect(result.identity.subject).toEqual(result.identity.principal);
      expect(result.identity.interactive).toBe(true);
    }
  });

  it("uses a verified Access email when local development supplies no UUID", async () => {
    const result = await cloudflareAccessAuth().authorize(request, BASE, runtime({ email: "ada@example.com" }));
    expect(result).toEqual({
      ok: true,
      userId: "ada@example.com",
      subjectId: "ada@example.com",
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

  it.each(["valid", "invalid", "expired", "wrong-audience"])(
    "INV-4: refuses %s caller JWTs without edge-validated context on Node and Workers",
    async (verdict) => {
      const header = btoa(JSON.stringify({ alg: "none" }));
      const payload = btoa(
        JSON.stringify({
          sub: "human",
          aud: verdict === "wrong-audience" ? "other-app" : "access-app",
          exp: verdict === "expired" ? 1 : 9999999999,
        }),
      );
      const jwt = verdict === "invalid" ? "invalid" : `${header}.${payload}.signature`;
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

  it.each(["", undefined, 123, "bad aud"])(
    "INV-4: refuses malformed trusted application AUD %j before identity lookup",
    async (aud) => {
      const getIdentity = vi.fn(async () => ({ user_uuid: "human" }));
      const result = await cloudflareAccessAuth().authorize(request, BASE, {
        access: { aud: aud as string, getIdentity },
      });
      expect(result.ok).toBe(false);
      expect(getIdentity).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Access or its identity is unavailable", async () => {
    const auth = cloudflareAccessAuth();
    const missing = await auth.authorize(request, BASE);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.response.status).toBe(401);

    const getIdentity = vi.fn().mockRejectedValue(new Error("Access failed"));
    const failed = await auth.authorize(request, BASE, {
      access: { aud: "access-app", getIdentity },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.response.status).toBe(401);
  });

  it("refuses Access-only machine MCP calls and operator mutation", async () => {
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth(),
      connectors: [
        {
          id: "oauth",
          kind: "mcp",
          listTools: async () => [],
          callTool: async () => null,
          startAuth: async () => ({ state: "ok" }),
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
      vault: oauthVault(memoryStorage()),
      connectors: [
        {
          id: "oauth",
          kind: "mcp",
          listTools: async () => [],
          callTool: async () => null,
          startAuth: async () => ({ state: "ok" }),
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

  it("keeps Clerk as the pre-Access shell and switches to ambient auth at the edge", async () => {
    const deployment = makeDeployment({
      auth: [cloudflareAccessAuth(), fakeClerkAuth({ token: "clerk-session" })],
    });

    const beforeAccess = await deployment.fetch(new Request(`${BASE}/`));
    const clerkShell = await beforeAccess.text();
    expect(clerkShell).toContain('"auth":{"kind":"clerk"');
    expect(clerkShell).toContain("clerk.browser.js");

    const afterAccess = await deployment.fetch(
      new Request(`${BASE}/`),
      undefined,
      workerRuntime({ user_uuid: "operator-1" }),
    );
    const accessShell = await afterAccess.text();
    expect(accessShell).toContain('"auth":{"kind":"cloudflare-access"}');
    expect(accessShell).not.toContain("clerk.browser.js");
    const explicit = await deployment.fetch(
      new Request(`${BASE}/`, { headers: { Authorization: "Basic unknown" } }),
      undefined,
      workerRuntime({ user_uuid: "operator-1" }),
    );
    expect(await explicit.text()).toContain('"auth":{"kind":"clerk"');
  });
});
