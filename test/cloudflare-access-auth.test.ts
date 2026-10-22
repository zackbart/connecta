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
      expect(getIdentity).not.toHaveBeenCalled();
    },
  );

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
