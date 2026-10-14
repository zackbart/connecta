import { describe, expect, it, vi } from "vitest";
import { discoverOAuthProtectedResourceMetadata, discoverOAuthServerInfo } from "@modelcontextprotocol/client";
import { clerkAuth } from "../src/auth/clerk.js";
import { accessTokens, AccessTokenManager } from "../src/access-tokens.js";
import { activityHistory } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import type { ConnectaConfig } from "../src/index.js";
import type { AuthenticatedIdentity, InboundAuth } from "../src/types.js";
import { describeConfigSources } from "../src/config-value-sources.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { credentialConnector } from "./fixtures/ui.js";
import { oauthVault } from "./fixtures/oauth.js";
import { scriptedExecutor } from "./fixtures/misc.js";

const BASE = "https://connecta.test";
const METADATA = "/.well-known/oauth-protected-resource";

function deployment(options: Partial<Parameters<typeof createTestConnecta>[0]> = {}) {
  const auth: InboundAuth = {
    kind: "test",
    authorize(request) {
      const id = /^Bearer (human|agent)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
      return id ? { ok: true, subjectId: id } : { ok: false, response: new Response(null, { status: 401 }) };
    },
    handleMetadata(request) {
      const path = new URL(request.url).pathname;
      return path === METADATA || path.startsWith(`${METADATA}/mcp`)
        ? Response.json({ resource: `${BASE}${path.slice(METADATA.length) || "/mcp"}` })
        : null;
    },
  };
  return createTestConnecta({
    connectors: [
      api("docs", {
        tools: [
          {
            name: "read",
            description: "Read docs",
            annotations: { readOnlyHint: true },
            handler: () => "x".repeat(500),
          },
        ],
      }),
    ],
    auth,
    publicUrl: BASE,
    logger: silentLogger,
    pools: {
      allowed: { tools: ["docs"], grant: () => true },
      refused: { tools: ["docs"], grant: () => false },
    },
    ...options,
  });
}

const rpc = (app: ReturnType<typeof deployment>, pool?: string, token = "human") =>
  mcpRpc(app, "tools/list", {}, { ...(pool ? { pool } : {}), token });

async function wire(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].sort(),
    body: [...new Uint8Array(await response.arrayBuffer())],
  };
}

describe("default endpoint grant", () => {
  it.each([undefined, () => true, async () => true])(
    "INV-4: admits /mcp with an omitted or literal-true grant: %s",
    async (grant) => {
      const app = deployment({ grant });
      try {
        const response = await rpc(app);
        expect(response.status).toBe(200);
        expect((await readJsonRpc(response)).result.tools.map((tool: { name: string }) => tool.name)).toContain(
          "call_tool",
        );
      } finally {
        await app.close();
      }
    },
  );

  it("INV-4 INV-6: refuses /mcp byte-identically to pools after auth and still admits a granting pool", async () => {
    const grant = vi.fn((identity: Readonly<AuthenticatedIdentity>) => identity.subject?.id === "human");
    const warn = vi.fn();
    const app = deployment({ grant, logger: { ...silentLogger, warn } });
    try {
      const denied = await wire(await rpc(app, undefined, "agent"));
      expect(denied.status).toBe(404);
      for (const pool of ["refused", "missing"]) expect(await wire(await rpc(app, pool, "agent"))).toEqual(denied);
      expect(warn.mock.calls.flat()).toContainEqual(expect.objectContaining({ reason: "default_grant_denied" }));
      grant.mockClear();
      const allowed = await rpc(app, "allowed", "agent");
      expect(allowed.status).toBe(200);
      await allowed.arrayBuffer();
      expect(grant).not.toHaveBeenCalled();
      const unauthenticated = await mcpRpc(app, "tools/list", {});
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();
      expect(grant).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([false, undefined, null, 1, "true", {}, []].map((value) => ({ value })))(
    "INV-4: denies a non-true grant return: $value",
    async ({ value }) => {
      const app = deployment({ grant: (async () => value) as ConnectaConfig["grant"] });
      try {
        expect(await wire(await rpc(app))).toEqual(await wire(await rpc(app, "refused")));
      } finally {
        await app.close();
      }
    },
  );

  it.each([false, true])(
    "INV-4 INV-6: a throwing grant denies without logging its error, async=%s",
    async (asyncThrow) => {
      const warn = vi.fn();
      const fail = () => {
        throw new Error("private-grant-error");
      };
      const app = deployment({ grant: asyncThrow ? async () => fail() : fail, logger: { ...silentLogger, warn } });
      try {
        expect(await wire(await rpc(app))).toEqual(await wire(await rpc(app, "refused")));
        expect(warn.mock.calls.flat()).toContainEqual(expect.objectContaining({ reason: "default_grant_threw" }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private-grant-error");
      } finally {
        await app.close();
      }
    },
  );

  it.each([null, true, false, "grant", 42, {}, []].map((grant) => ({ grant })))(
    "INV-11: rejects an invalid top-level grant at construction: $grant",
    ({ grant }) => {
      expect(() => deployment({ grant: grant as unknown as ConnectaConfig["grant"] })).toThrow("ConnectaConfig.grant");
    },
  );

  it.each([
    undefined,
    () => true,
    () => false,
    () => {
      throw new Error("private-grant-error");
    },
  ])(
    "INV-4 INV-10: keeps protected-resource metadata public without evaluating the default grant: %s",
    async (configured) => {
      const grant = configured ? vi.fn(configured) : undefined;
      const app = deployment({ grant });
      try {
        for (const path of [METADATA, `${METADATA}/mcp`, `${METADATA}/mcp/refused`, `${METADATA}/mcp/missing`]) {
          for (const token of [undefined, "agent", "invalid"]) {
            const response = await app.fetch(
              new Request(`${BASE}${path}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              }),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ resource: `${BASE}${path.slice(METADATA.length) || "/mcp"}` });
          }
        }
        if (grant) expect(grant).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("INV-4 INV-10: credential-free Clerk discovery with a default grant completes through the MCP SDK", async () => {
    const grant = vi.fn(() => true);
    const issuer = "https://clerk.example.com";
    const app = deployment({
      grant,
      auth: clerkAuth({
        publishableKey: `pk_test_${btoa("clerk.example.com$")}`,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
      }),
    });
    const authorizationMetadata = {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    };
    const fetchDiscovery: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.has("Authorization")).toBe(false);
      return new URL(request.url).origin === BASE ? app.fetch(request) : Response.json(authorizationMetadata);
    };
    try {
      for (const path of [METADATA, `${METADATA}/mcp`]) {
        const response = await app.fetch(new Request(`${BASE}${path}`));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [issuer] });
        const metadata = await discoverOAuthProtectedResourceMetadata(
          `${BASE}/mcp`,
          { resourceMetadataUrl: `${BASE}${path}` },
          fetchDiscovery,
        );
        expect(metadata.resource).toBe(`${BASE}/mcp`);
      }
      const discovery = await discoverOAuthServerInfo(`${BASE}/mcp`, { fetchFn: fetchDiscovery });
      expect(discovery.resourceMetadata?.resource).toBe(`${BASE}/mcp`);
      expect(discovery.authorizationServerUrl).toBe(issuer);
      expect(discovery.authorizationServerMetadata).toEqual(authorizationMetadata);
      expect(grant).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("INV-4: refuses default-denied machine tokens on every operator catalog route and admits humans", async () => {
    const storage = memoryStorage();
    const tokens = accessTokens(storage);
    const token = await new AccessTokenManager(storage).create("Simon", "test-operator");
    const grant = vi.fn((identity: Readonly<AuthenticatedIdentity>) => identity.interactive);
    const app = deployment({
      storage,
      accessTokens: tokens,
      auth: fakeClerkAuth(),
      grant,
      activity: activityHistory({ store: { record: async () => {}, list: async () => ({ events: [] }) } }),
      identity: { activityAccess: () => true, accessTokenManagement: () => true },
    });
    try {
      expect((await wire(await rpc(app, undefined, token.token))).status).toBe(404);
      expect((await wire(await rpc(app, "allowed", token.token))).status).toBe(200);
      for (const path of ["/ui/api/config", "/ui/data", "/ui/connectors/docs", "/ui/activity", "/ui/api/activity"]) {
        const denied = await app.fetch(
          new Request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token.token}` } }),
        );
        expect(denied.status, path).toBe(404);
        expect(await denied.json()).toEqual({ error: "not found" });
        const admitted = await app.fetch(
          new Request(`${BASE}${path}`, { headers: { Authorization: "Bearer clerk-operator" } }),
        );
        expect(admitted.status, path).toBe(200);
        await admitted.arrayBuffer();
      }
      const tokensResponse = await app.fetch(
        new Request(`${BASE}/ui/access-tokens`, { headers: { Authorization: "Bearer clerk-operator" } }),
      );
      expect(tokensResponse.status).toBe(200);
      await tokensResponse.arrayBuffer();
    } finally {
      await app.close();
    }
  });

  it("INV-4: operator auth routes retain their own gates and require default admission", async () => {
    const storage = memoryStorage();
    let allowed = true;
    const disconnectAuth = vi.fn(async () => {});
    const app = deployment({
      storage,
      pools: {},
      vault: oauthVault(storage),
      auth: fakeClerkAuth(),
      grant: () => allowed,
      connectors: [
        credentialConnector(),
        {
          id: "service",
          listTools: async () => [],
          callTool: async () => null,
          startAuth: async () => ({ state: "auth_required", authorizationUrl: "https://consent.example/authorize" }),
          disconnectAuth,
        },
      ],
    });
    const request = (path: string, method: string, token = "clerk-operator", body?: object) =>
      app.fetch(
        new Request(`${BASE}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Origin: BASE, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    try {
      const operations = [
        ["/ui/credentials/vaulted", "PUT", { value: "valid-secret-9876" }],
        ["/ui/credentials/vaulted/test", "POST", undefined],
        ["/ui/oauth/service", "POST", undefined],
      ] as const;
      for (const [path, method, body] of operations) {
        const admitted = await request(path, method, "clerk-operator", body);
        expect(admitted.status, path).toBe(200);
        await admitted.arrayBuffer();
        allowed = false;
        const refused = await request(path, method, "clerk-operator", body);
        expect(refused.status, path).toBe(404);
        expect(await refused.json()).toEqual({ error: "not found" });
        allowed = true;
        const unauthenticated = await request(path, method, "invalid", body);
        expect(unauthenticated.status, path).toBe(401);
        await unauthenticated.arrayBuffer();
      }
      const disconnected = await request("/ui/oauth/service", "DELETE");
      expect(disconnected.status).toBe(204);
      expect(disconnectAuth).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    () => undefined,
    () => "true",
    () => {
      throw new Error("private-grant-error");
    },
  ])("INV-4 INV-6: operator catalog admission denies non-true or throwing grants: %s", async (grant) => {
    const app = deployment({ grant: grant as unknown as ConnectaConfig["grant"] });
    try {
      for (const path of ["/ui/api/config", "/ui/data", "/ui/connectors/docs"]) {
        const response = await app.fetch(new Request(`${BASE}${path}`, { headers: { Authorization: "Bearer human" } }));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not found" });
      }
    } finally {
      await app.close();
    }
  });

  it("INV-4: binds result handles to their endpoint and rechecks the default grant when paging", async () => {
    let allowed = true;
    let revokeInProgram = false;
    let resultId = "";
    const app = deployment({
      grant: () => allowed,
      storage: memoryStorage(),
      calls: { maxResultBytes: 100 },
      executor: scriptedExecutor(async (fns) => {
        if (revokeInProgram) allowed = false;
        return fns.result!(resultId, { maxBytes: 100 });
      }),
    });
    const call = async (name: string, args: object, pool?: string) =>
      (
        await readJsonRpc(
          await mcpRpc(app, "tools/call", { name, arguments: args }, { token: "human", ...(pool ? { pool } : {}) }),
        )
      ).result;
    const page = (pool?: string) => call("execute_code", { code: "return await connecta.result(id)" }, pool);
    try {
      for (const pool of [undefined, "allowed"]) {
        const original = await call("call_tool", { address: "docs.read" }, pool);
        resultId = JSON.parse(original.content[0].text.split("\n")[0]).resultId;
        expect(resultId).toBeTypeOf("string");
        expect((await page(pool)).isError).toBeFalsy();
        expect((await page(pool === undefined ? "allowed" : undefined)).isError).toBe(true);
      }
      resultId = JSON.parse(
        (await call("call_tool", { address: "docs.read" })).content[0].text.split("\n")[0],
      ).resultId;
      revokeInProgram = true;
      expect((await page()).isError).toBe(true);
      expect((await wire(await rpc(app))).status).toBe(404);
      expect((await page("allowed")).isError).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each([undefined, () => true])(
    "INV-4 INV-10: describes grant presence without evaluating it: %s",
    async (configured) => {
      const grant = configured ? vi.fn(configured) : undefined;
      const app = deployment({ grant });
      try {
        expect(app.describeConfig().hasGrant).toBe(Boolean(grant));
        const raw = { readOnly: false, connectors: [], executor: {} as ConnectaConfig["executor"], grant };
        expect(describeConfigSources(app.describeConfig(), raw)["config.hasGrant"]).toBe(grant ? "config" : "default");
        if (grant) expect(grant).not.toHaveBeenCalled();
        const ui = await app.fetch(
          new Request(`${BASE}/ui/api/config`, { headers: { Authorization: "Bearer human" } }),
        );
        expect((await ui.json()) as object).toHaveProperty("config.hasGrant", Boolean(grant));
        if (grant) expect(grant).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );
});
