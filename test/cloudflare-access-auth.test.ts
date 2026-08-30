import { describe, expect, it, vi } from "vitest";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import type { InboundAuthRuntimeContext } from "../src/types.js";
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
      auth.authorize(
        request,
        BASE,
        runtime({ user_uuid: "user-123", email: "ada@example.com" }),
      ),
    ).resolves.toEqual({
      ok: true,
      userId: "user-123",
      subjectId: "user-123",
    });
  });

  it("uses a verified Access email when local development supplies no UUID", async () => {
    const result = await cloudflareAccessAuth().authorize(
      request,
      BASE,
      runtime({ email: "ada@example.com" }),
    );
    expect(result).toEqual({
      ok: true,
      userId: "ada@example.com",
      subjectId: "ada@example.com",
    });
  });

  it("admits service tokens without granting a user identity", async () => {
    const result = await cloudflareAccessAuth().authorize(
      request,
      BASE,
      runtime(),
    );
    expect(result).toEqual({
      ok: true,
      subjectId: "access-app",
    });

    // Keep accepting assertion-shaped identities for runtimes that expose
    // them, even though production service tokens currently return no user
    // identity from getIdentity().
    const assertionShape = await cloudflareAccessAuth().authorize(
      request,
      BASE,
      runtime({ common_name: "service-client-id.access" }),
    );
    expect(assertionShape).toEqual({
      ok: true,
      subjectId: "service-client-id.access",
    });
  });

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

  it("admits MCP service calls but refuses service-token operator mutation", async () => {
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth(),
      accessTokens: {},
    });
    const context = workerRuntime();

    const mcpRequest = mcpRpc("tools/list", {});
    const mcp = await deployment.fetch(mcpRequest, undefined, context);
    expect(mcp.status).toBe(200);

    const mutation = await deployment.fetch(
      new Request(`${BASE}/ui/access-tokens`, {
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
      error: "authenticated user required",
    });
  });

  it("lets a human Access identity use same-origin operator mutation", async () => {
    const deployment = makeDeployment({
      auth: cloudflareAccessAuth(),
      accessTokens: {},
    });
    const context = workerRuntime({ user_uuid: "operator-1" });
    const crossOrigin = await deployment.fetch(
      new Request(`${BASE}/ui/access-tokens`, {
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
      new Request(`${BASE}/ui/access-tokens`, {
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
    expect(response.status).toBe(201);
  });

  it("keeps Clerk as the pre-Access shell and switches to ambient auth at the edge", async () => {
    const deployment = makeDeployment({
      auth: [
        cloudflareAccessAuth(),
        fakeClerkAuth({ token: "clerk-session" }),
      ],
    });

    const beforeAccess = await deployment.fetch(new Request(`${BASE}/`));
    const clerkShell = await beforeAccess.text();
    expect(clerkShell).toContain('const AUTH = {"kind":"clerk"');
    expect(clerkShell).toContain("clerk.browser.js");

    const afterAccess = await deployment.fetch(
      new Request(`${BASE}/`),
      undefined,
      workerRuntime({ user_uuid: "operator-1" }),
    );
    const accessShell = await afterAccess.text();
    expect(accessShell).toContain(
      'const AUTH = {"kind":"cloudflare-access"}',
    );
    expect(accessShell).not.toContain("clerk.browser.js");
  });
});
