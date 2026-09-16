import { encryptedCredentialVault } from "../src/credentials.js";
import { describe, expect, it, vi } from "vitest";
import { bearerToken } from "../src/auth/bearer.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

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
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
    "WWW-Authenticate, Retry-After, mcp-session-id, mcp-protocol-version",
  );
  expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
    "Content-Type, Authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name",
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
  it("refuses disallowed origins before auth and admission, including preflight", async () => {
    const authorize = vi.fn(() => ({ ok: false as const, response: new Response("auth", { status: 401 }) }));
    const connecta = createTestConnecta({ connectors: [], publicUrl: BASE, auth: { kind: "test", authorize } });
    for (const path of ["/mcp", "/mcp/Support"]) {
      for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
        const response = await connecta.fetch(new Request(`${BASE}${path}`, {
          method, headers: { Origin: "https://attacker.example" },
        }));
        expect(response.status).toBe(403);
        expectGlobalSecurityHeaders(response);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.text()).toBe('{"error":"origin not allowed"}');
      }
    }
    const http = await connecta.fetch(new Request("http://127.0.0.1/mcp", { headers: { Origin: "https://attacker.example" } }));
    expect(http.status).toBe(403);
    expect(await http.text()).toBe('{"error":"origin not allowed"}');
    expect(authorize).not.toHaveBeenCalled();
    const health = await (await connecta.fetch(new Request(`${BASE}/health`))).json() as any;
    expect(health.admission.requests.totals.admitted).toBe(0);
    await connecta.close();
    const closed = await connecta.fetch(new Request(`${BASE}/mcp`, { headers: { Origin: "null" } }));
    expect(closed.status).toBe(403);
    expect(await closed.text()).toBe('{"error":"origin not allowed"}');
  });

  it("admits only exact configured origins, defaults to public and loopback, and permits originless clients", async () => {
    for (const config of [
      { publicUrl: BASE },
      {},
      { allowedOrigins: ["https://client.example"] },
      { allowedOrigins: "*" as const },
    ]) {
      const connecta = createTestConnecta({ connectors: [], auth: bearerToken(TOKEN), ...config });
      for (const origin of [undefined, BASE, "https://client.example", "http://localhost:4321", "https://127.0.0.1:99", "http://[::1]:4321", "https://attacker.example", "null", "https://localhost.attacker.example", `${BASE}/`, "https://user:pass@localhost"]) {
        const allowed = origin === undefined || config.allowedOrigins === "*" ||
          (Array.isArray(config.allowedOrigins) ? config.allowedOrigins.includes(origin) :
            origin === config.publicUrl || ["http://localhost:4321", "https://127.0.0.1:99", "http://[::1]:4321"].includes(origin));
        const response = await connecta.fetch(new Request(`${BASE}/mcp`, {
          headers: origin === undefined ? {} : { Origin: origin },
        }));
        expect(response.status, JSON.stringify({ config, origin })).toBe(allowed ? 401 : 403);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
          config.allowedOrigins === "*" ? "*" : allowed && origin !== undefined ? origin : null,
        );
        await response.text();
      }
      await connecta.close();
    }
  });

  it("permits MCP preflight without auth and mirrors valid Mcp-Param header names only", async () => {
    const authorize = vi.fn(() => ({ ok: false as const, response: new Response(null, { status: 401 }) }));
    const connecta = createTestConnecta({ connectors: [], publicUrl: BASE, auth: { kind: "test", authorize } });
    const response = await connecta.fetch(new Request(`${BASE}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: BASE, "Access-Control-Request-Headers": "Mcp-Param-Region, mcp-param-tenant, unrelated, mcp-param-bad header" },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(BASE);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, mcp-param-region, mcp-param-tenant",
    );
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("Vary")).toContain("Access-Control-Request-Headers");
    expect(authorize).not.toHaveBeenCalled();
    await connecta.close();
  });

  it("authenticates every pool suffix before returning the same pool refusal", async () => {
    const connecta = createTestConnecta({
      connectors: [testConnector("docs")], auth: bearerToken(TOKEN), publicUrl: BASE,
      pools: { support: { tools: ["docs"], grant: () => false }, broken: { tools: ["docs"], grant: () => { throw new Error("private"); } } },
    });
    let baseline: Awaited<ReturnType<typeof responseShape>> | undefined;
    for (const suffix of ["support", "broken", "missing", "Support", "日本語", "support.extra", "nested/path", ""]) {
      const url = `${BASE}/mcp/${suffix}`;
      const unauthenticated = await connecta.fetch(new Request(url));
      expect(unauthenticated.status).toBe(401);
      expectMcpCors(unauthenticated);
      expect(await unauthenticated.text()).toBe('{"error":"unauthorized"}');
      const response = await connecta.fetch(new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } }));
      expectMcpCors(response);
      const shape = await responseShape(response);
      expect(shape.status).toBe(404);
      expect(shape.body).toBe("Not Found");
      baseline ??= shape;
      expect(shape).toEqual(baseline);
    }
    await connecta.close();
  });

  it("keeps connector identities out of health while preserving doctor's drift signal", async () => {
    const connecta = createTestConnecta({ connectors: [{
      ...testConnector("private_connector_id"),
      callAdmission: { rules: [{ maxConcurrency: 1 }] },
      catalogDrift: () => ({ observedAt: "2026-09-16T00:00:00.000Z", unclassifiedTools: 2, unservedTools: 1, annotationConflicts: 0, schemaChanges: 3 }),
    }], auth: bearerToken(TOKEN), publicUrl: BASE });
    let previous: unknown;
    for (let i = 0; i < 2; i++) {
      const response = await connecta.fetch(new Request(`${BASE}/health`, { headers: { Origin: "https://attacker.example" } }));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("private_connector_id");
      const body = JSON.parse(text);
      expect(body.connectors).toBe(1);
      expect(Object.keys(body.catalogDrift)).toHaveLength(1);
      expect(Object.keys(body.catalogDrift)[0]).toMatch(/^[a-f0-9]{16}$/);
      expect(Object.values(body.catalogDrift)).toEqual([{ observedAt: "2026-09-16T00:00:00.000Z", unclassifiedTools: 2, unservedTools: 1, annotationConflicts: 0, schemaChanges: 3 }]);
      if (previous) expect(body.catalogDrift).toEqual(previous);
      previous = body.catalogDrift;
    }
    await connecta.close();
  });

  it("pins application error codes for overload and shutdown", async () => {
    const connecta = createTestConnecta({ connectors: [], admission: { requests: { concurrency: 1, maxQueueSize: 0 } }, auth: {
      kind: "test", authorize: () => ({ ok: false, response: new Response(new ReadableStream({ pull() {} }), { status: 401 }) }),
    } });
    const held = await connecta.fetch(new Request(`${BASE}/mcp`));
    const overloaded = await connecta.fetch(new Request(`${BASE}/mcp`));
    expect(overloaded.status).toBe(503);
    expect(await overloaded.text()).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-31001,"message":"Server capacity is exhausted. Retry later.","data":{"code":"server_overloaded","retryable":true,"retryAfterMs":1000}}}');
    await held.body?.cancel();
    await connecta.close();
    const closed = await connecta.fetch(new Request(`${BASE}/mcp`));
    expect(closed.status).toBe(503);
    expect(await closed.text()).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-31002,"message":"Server is shutting down.","data":{"code":"server_shutting_down","retryable":false}}}');
  });

  it("keeps every built-in and the final 404 inside the security wrapper", async () => {
    const connector = surfaceConnector();
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
    });

    const builtIns: Array<{
      path: string;
      init?: RequestInit;
      status: number;
    }> = [
      { path: "/health", status: 200 },
      { path: "/", status: 200 },
      { path: "/credentials", status: 404 },
      { path: "/activity", status: 404 },
      { path: "/tokens", status: 404 },
      { path: "/ui", status: 308 },
      { path: "/ui/data", status: 401 },
      { path: "/ui/activity", status: 404 },
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

    const mcp = await mcpRpc(connecta, "tools/call", { name: "search_tools", arguments: { query: "read" } });
    expect(mcp.status).toBe(401);
    expectMcpCors(mcp);
    expect(await mcp.text()).toBe('{"error":"unauthorized"}');

    const owned = await connecta.fetch(new Request(`${BASE}/owned`));
    expect(owned.status).toBe(404);
    expectGlobalSecurityHeaders(owned);
    expect(await owned.text()).toBe("Not Found");
  });

  it("keeps operator shells open, framed off, and data-free", async () => {
    const connecta = createTestConnecta({
      connectors: [surfaceConnector()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
    });

    for (const path of ["/"]) {
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
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
    });

    for (const path of ["/ui/data"]) {
      const response = await connecta.fetch(new Request(`${BASE}${path}`));
      expect(response.status).toBe(401);
      expectGlobalSecurityHeaders(response);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }

    const mcp = await mcpRpc(connecta, "tools/call", { name: "search_tools", arguments: { query: "read" } });
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
      '{"error":"credential management requires interactive user authentication"}',
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
      '{"error":"OAuth management requires interactive user authentication"}',
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
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
    });

    // Every ?toolkit= value — a formerly configured name, garbage, or empty —
    // gets the same 404: an endpoint URL minted before the retirement (#178)
    // must not silently widen into the full registry.
    for (const value of ["support", "no-such-toolkit", ""]) {
      const response = await mcpRpc(connecta, "tools/call", { name: "search_tools", arguments: { query: "read" } }, {
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
    const unauthenticated = await mcpRpc(connecta, "tools/call", { name: "search_tools", arguments: { query: "read" } }, {
      query: "?toolkit=support",
    });
    expect(unauthenticated.status).toBe(401);

    // The same credential without the param reaches the endpoint normally —
    // and the call actually succeeds, which is the only way this contrasts
    // with the 404 above rather than with some other refusal.
    const clean = await mcpRpc(connecta, "tools/call", { name: "search_tools", arguments: { query: "read" } }, { token: TOKEN });
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
