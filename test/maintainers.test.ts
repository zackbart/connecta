import { describe, expect, it } from "vitest";
import { discoverOAuthProtectedResourceMetadata, discoverOAuthServerInfo } from "@modelcontextprotocol/client";
import { clerkAuth } from "../src/auth/clerk.js";
import { api } from "../src/connectors/api.js";
import type { InboundAuth } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";
const METADATA = "/.well-known/oauth-protected-resource";

function deployment(options: Partial<Parameters<typeof createTestConnecta>[0]> = {}) {
  const auth: InboundAuth = {
    kind: "test",
    interactiveOperator: true,
    activityActorNamespace: "test",
    authorize(request) {
      const id = /^Bearer (human|other)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
      return id ? { ok: true, userId: id } : { ok: false, response: new Response(null, { status: 401 }) };
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
        tools: [{ name: "read", description: "Read docs", annotations: { readOnlyHint: true }, handler: () => "ok" }],
      }),
    ],
    auth,
    maintainers: ["human"],
    publicUrl: BASE,
    logger: silentLogger,
    pools: { team: { tools: ["docs"], members: ["other"] } },
    ...options,
  });
}

describe("maintainers", () => {
  it("INV-4 INV-10: keeps protected-resource metadata public at /mcp and every pool alias", async () => {
    const app = deployment();
    try {
      for (const path of [METADATA, `${METADATA}/mcp`, `${METADATA}/mcp/team`, `${METADATA}/mcp/missing`]) {
        for (const token of [undefined, "human", "other", "invalid"]) {
          const response = await app.fetch(
            new Request(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
          );
          expect(response.status, `${path} ${token}`).toBe(200);
          expect(await response.json()).toEqual({ resource: `${BASE}${path.slice(METADATA.length) || "/mcp"}` });
        }
      }
      const refused = await mcpRpc(app, "tools/list", {}, { token: "other" });
      expect(refused.status).toBe(404);
      await refused.arrayBuffer();
    } finally {
      await app.close();
    }
  });

  it("INV-4 INV-10: credential-free Clerk discovery for a maintainer-only /mcp completes through the MCP SDK", async () => {
    const issuer = "https://clerk.example.com";
    const app = deployment({
      auth: clerkAuth({
        publishableKey: `pk_test_${btoa("clerk.example.com$")}`,
        secretKey: "sk_test_fake",
        publicUrl: BASE,
      }),
      maintainers: ["user_maintainer"],
      pools: {},
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
      expect(app.describeConfig().maintainers).toEqual([
        { namespace: "https://clerk.example.com", id: "user_maintainer" },
      ]);
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
    } finally {
      await app.close();
    }
  });
});
