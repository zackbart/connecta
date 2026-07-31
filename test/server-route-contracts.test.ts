import { describe, expect, it, vi } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const TOKEN = "route-contract-token";
const CREDENTIAL_KEY = btoa("0123456789abcdef0123456789abcdef");

function testConnector(id: string): Connector {
  return api(id, {
    description: `${id} route-contract connector`,
    tools: [
      {
        name: "read",
        description: `Read from ${id}`,
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: async () => ({ id }),
      },
    ],
  });
}

function surfaceConnector(
  overrides: Partial<Connector> = {},
): Connector {
  return {
    ...testConnector("surface"),
    credential: { label: "API token" },
    async startAuth() {
      return {
        state: "auth_required",
        authorizationUrl: "https://provider.example/authorize",
      };
    },
    async disconnectAuth() {},
    async verifyState() {
      return false;
    },
    async finishAuth() {},
    ...overrides,
  };
}

function expectGlobalSecurityHeaders(response: Response): void {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Strict-Transport-Security")).toBe(
    "max-age=31536000",
  );
}

function expectPrivateJson(response: Response): void {
  expectGlobalSecurityHeaders(response);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
}

function expectMcpCors(response: Response): void {
  expectGlobalSecurityHeaders(response);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
    "WWW-Authenticate, Retry-After, mcp-session-id, mcp-protocol-version",
  );
  expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
    "Content-Type, Authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name",
  );
}

let requestId = 0;
function mcpRequest(
  connecta: { fetch(request: Request): Promise<Response> },
  options: { token?: string; query?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  return connecta.fetch(
    new Request(`${BASE}/mcp${options.query ?? ""}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: {
          name: "search_tools",
          arguments: { query: "read" },
        },
      }),
    }),
  );
}

async function responseShape(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

describe("server route contracts", () => {
  it("keeps every built-in ahead of connector-owned routes and inside the security wrapper", async () => {
    const handledPaths: string[] = [];
    const connector = surfaceConnector({
      async handleRequest(request) {
        handledPaths.push(new URL(request.url).pathname);
        return new Response("connector-owned");
      },
    });
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });

    const builtIns: Array<{
      path: string;
      init?: RequestInit;
      status: number;
    }> = [
      { path: "/health", status: 200 },
      { path: "/", status: 200 },
      { path: "/credentials", status: 200 },
      { path: "/activity", status: 200 },
      { path: "/tokens", status: 200 },
      { path: "/ui", status: 308 },
      { path: "/ui/data", status: 401 },
      { path: "/ui/activity", status: 401 },
      {
        path: "/ui/credentials/surface",
        init: { method: "OPTIONS" },
        status: 405,
      },
      {
        path: "/ui/oauth/surface",
        init: { method: "OPTIONS" },
        status: 405,
      },
      {
        path: "/oauth/callback/surface?code=abc&state=wrong",
        status: 400,
      },
      { path: "/favicon.svg", status: 200 },
      { path: "/favicon.ico", status: 200 },
      { path: "/.well-known/not-configured", status: 404 },
      { path: "/anything", init: { method: "OPTIONS" }, status: 204 },
    ];

    for (const contract of builtIns) {
      const response = await connecta.fetch(
        new Request(`${BASE}${contract.path}`, contract.init),
      );
      expect(response.status, contract.path).toBe(contract.status);
      expectGlobalSecurityHeaders(response);
      await response.arrayBuffer();
    }

    const mcp = await mcpRequest(connecta);
    expect(mcp.status).toBe(401);
    expectMcpCors(mcp);
    expect(await mcp.text()).toBe('{"error":"unauthorized"}');
    expect(handledPaths).toEqual([]);

    const owned = await connecta.fetch(new Request(`${BASE}/owned`));
    expect(owned.status).toBe(200);
    expectGlobalSecurityHeaders(owned);
    expect(await owned.text()).toBe("connector-owned");
    expect(handledPaths).toEqual(["/owned"]);
  });

  it("keeps operator shells open, framed off, and data-free", async () => {
    const connecta = createTestConnecta({
      connectors: [surfaceConnector()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });

    for (const path of ["/", "/credentials", "/tokens", "/activity"]) {
      const response = await connecta.fetch(new Request(`${BASE}${path}`));
      const body = await response.text();
      expect(response.status).toBe(200);
      expectGlobalSecurityHeaders(response);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(body).not.toContain("surface route-contract connector");
      expect(body).not.toContain("API token");
    }

    const compatibilityRedirect = await connecta.fetch(
      new Request(`${BASE}/ui?from=bookmark`),
    );
    expect(compatibilityRedirect.status).toBe(308);
    expect(compatibilityRedirect.headers.get("Location")).toBe(
      `${BASE}/?from=bookmark`,
    );
    expect(compatibilityRedirect.headers.get("X-Frame-Options")).toBe("DENY");
    expect(compatibilityRedirect.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none'",
    );
  });

  it("pins authentication and same-origin requirements per private route", async () => {
    const connecta = createTestConnecta({
      connectors: [surfaceConnector()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });

    for (const path of ["/ui/data", "/ui/activity"]) {
      const response = await connecta.fetch(new Request(`${BASE}${path}`));
      expect(response.status).toBe(401);
      expectGlobalSecurityHeaders(response);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }

    const mcp = await mcpRequest(connecta);
    expect(mcp.status).toBe(401);
    expectMcpCors(mcp);
    expect(mcp.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await mcp.text()).toBe('{"error":"unauthorized"}');

    // Auth guards /mcp before the transport sees the request for EVERY
    // method, not just POST — session semantics belong to the transport, but
    // reaching it unauthenticated would be a routing bug the extraction could
    // introduce silently.
    for (const method of ["GET", "DELETE"]) {
      const nonPost = await connecta.fetch(
        new Request(`${BASE}/mcp`, { method }),
      );
      expect(nonPost.status, `${method} /mcp`).toBe(401);
      expectMcpCors(nonPost);
      expect(nonPost.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await nonPost.text()).toBe('{"error":"unauthorized"}');
    }

    const offOriginCredential = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/surface`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({ value: "secret" }),
      }),
    );
    expectPrivateJson(offOriginCredential);
    expect(offOriginCredential.status).toBe(403);
    expect(await offOriginCredential.text()).toBe(
      '{"error":"same-origin request required"}',
    );

    const offOriginOAuth = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/surface`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: "https://attacker.example",
        },
      }),
    );
    expectPrivateJson(offOriginOAuth);
    expect(offOriginOAuth.status).toBe(403);
    expect(await offOriginOAuth.text()).toBe(
      '{"error":"same-origin request required"}',
    );

    const credentialWithoutClerk = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/surface`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Origin: BASE,
        },
        body: JSON.stringify({ value: "secret" }),
      }),
    );
    expectPrivateJson(credentialWithoutClerk);
    expect(credentialWithoutClerk.status).toBe(403);
    expect(await credentialWithoutClerk.text()).toBe(
      '{"error":"credential management requires Clerk authentication"}',
    );

    const oauthWithoutClerk = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/surface`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: BASE,
        },
      }),
    );
    expectPrivateJson(oauthWithoutClerk);
    expect(oauthWithoutClerk.status).toBe(403);
    expect(await oauthWithoutClerk.text()).toBe(
      '{"error":"OAuth management requires Clerk authentication"}',
    );

    for (const path of [
      "/ui/credentials/surface",
      "/ui/oauth/surface",
    ]) {
      const preflight = await connecta.fetch(
        new Request(`${BASE}${path}`, { method: "OPTIONS" }),
      );
      expectPrivateJson(preflight);
      expect(preflight.status).toBe(405);
      expect(await preflight.text()).toBe(
        '{"error":"method not allowed"}',
      );
    }
  });

  it("refuses ?toolkit= on /mcp with an explicit 404 after the retirement", async () => {
    const warn = vi.fn();
    const connecta = createTestConnecta({
      connectors: [testConnector("alpha")],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: { ...silentLogger, warn },
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });

    // Every ?toolkit= value — a formerly configured name, garbage, or empty —
    // gets the same 404: an endpoint URL minted before the retirement (#178)
    // must not silently widen into the full registry.
    for (const value of ["support", "no-such-toolkit", ""]) {
      const response = await mcpRequest(connecta, {
        token: TOKEN,
        query: `?toolkit=${value}`,
      });
      expect(response.status, `?toolkit=${value}`).toBe(404);
      expectMcpCors(response);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("#178");
    }
    // The client-facing body is discarded by SDK transports, so the reason
    // must also reach the operator log (#47).
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toContain("#178");

    // Auth still runs first: an unauthenticated ?toolkit= request is a plain
    // 401, revealing nothing about the retirement.
    const unauthenticated = await mcpRequest(connecta, {
      query: "?toolkit=support",
    });
    expect(unauthenticated.status).toBe(401);

    // The same credential without the param reaches the endpoint normally —
    // and the call actually succeeds, which is the only way this contrasts
    // with the 404 above rather than with some other refusal.
    const clean = await mcpRequest(connecta, { token: TOKEN });
    expect(clean.status).toBe(200);
    const cleanBody = (await clean.json()) as {
      error?: unknown;
      result?: { isError?: boolean };
    };
    expect(cleanBody.error, JSON.stringify(cleanBody)).toBeUndefined();
    expect(cleanBody.result?.isError).toBeFalsy();
  });

  it("verifies OAuth callback state before exchange and keeps all unverifiable callbacks opaque", async () => {
    const acceptedOrder: string[] = [];
    const rejectedFinish = vi.fn();
    const throwingFinish = vi.fn();
    const connecta = createTestConnecta({
      connectors: [
        testConnector("plain"),
        {
          ...testConnector("accepted"),
          async verifyState(state) {
            acceptedOrder.push(`verify:${state}`);
            return state === "valid-state";
          },
          async finishAuth(code, _ctx, callbackParams) {
            acceptedOrder.push(`finish:${code}`);
            acceptedOrder.push(`iss:${callbackParams?.get("iss")}`);
          },
        },
        {
          ...testConnector("rejected"),
          async verifyState() {
            return false;
          },
          async finishAuth(code) {
            rejectedFinish(code);
          },
        },
        {
          ...testConnector("throwing"),
          async verifyState() {
            throw new Error("verifier unavailable");
          },
          async finishAuth(code) {
            throwingFinish(code);
          },
        },
        {
          ...testConnector("no-verifier"),
          async finishAuth() {},
        },
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
    });

    const accepted = await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/accepted?code=auth-code&state=valid-state&iss=https%3A%2F%2Fauth.example`,
      ),
    );
    expect(accepted.status).toBe(200);
    expectGlobalSecurityHeaders(accepted);
    expect(acceptedOrder).toEqual([
      "verify:valid-state",
      "finish:auth-code",
      "iss:https://auth.example",
    ]);

    const opaquePaths = [
      "/oauth/callback/unknown?code=auth-code&state=wrong",
      "/oauth/callback/plain?code=auth-code&state=wrong",
      "/oauth/callback/rejected?code=auth-code&state=wrong",
      "/oauth/callback/throwing?code=auth-code&state=wrong",
      "/oauth/callback/no-verifier?code=auth-code&state=wrong",
    ];
    const opaque = [];
    for (const path of opaquePaths) {
      const response = await connecta.fetch(new Request(`${BASE}${path}`));
      expectGlobalSecurityHeaders(response);
      opaque.push(await responseShape(response));
    }

    const [baseline, ...otherRefusals] = opaque;
    expect(baseline).toBeDefined();
    if (!baseline) throw new Error("missing OAuth refusal baseline");
    expect(baseline.status).toBe(400);
    expect(baseline.body).toContain(
      "Authorization could not be completed",
    );
    for (const refusal of otherRefusals) {
      expect(refusal).toEqual(baseline);
    }
    expect(rejectedFinish).not.toHaveBeenCalled();
    expect(throwingFinish).not.toHaveBeenCalled();
  });
});
