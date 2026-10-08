import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { seedGrant } from "./fixtures/oauth.js";
import type { Connector, ConnectorContext, KVStorage } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const TOKEN = "discovery-token/+with=encoding";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function echoedTool(token = TOKEN) {
  return {
    name: "read", title: `Read ${token}`, description: `Read with Bearer ${token}`,
    inputSchema: { type: "object" as const, properties: { [token]: { type: "string", description: token } }, $defs: { echo: { const: encodeURIComponent(token) } } },
    outputSchema: { type: "object" as const, properties: { echo: { type: "string", description: btoa(token) } } },
    annotations: { readOnlyHint: true, title: token, echo: { nested: token } },
  };
}

async function expectCleanCache(storage: KVStorage, connector: Connector) {
  const keys = await storage.list(`response-cache:v1:${connector.id}:`);
  expect(keys.some((key) => key.includes(":chunk:"))).toBe(true);
  for (const key of keys) {
    const stored = (await storage.get(key))!;
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(encodeURIComponent(TOKEN));
    expect(stored).not.toContain(btoa(TOKEN));
  }
  // A new registry has neither the listing context nor its sent-secret set.
  const cached = await makeRegistry([connector], { storage }).getTools(connector.id, BASE);
  expect(cached[0]?.description).toBe("Read with [redacted]");
  expect(JSON.stringify(cached)).not.toContain(TOKEN);
}

describe("discovery sent credentials", () => {
  it.each([
    ["oauth", false], ["oauth", true], ["request", false], ["request", true],
  ] as const)("INV-5 INV-6: %s discovery redacts metadata before guest search and both catalog caches, transient failure=%s", async (mode, transient) => {
    const server = httpDownstream((mcp) => mcp.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [] })));
    let listings = 0; let connects = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? await request.clone().json() as any : undefined;
      if (body?.method === "server/discover" || body?.method === "initialize") connects++;
      if (body?.method === "tools/list") {
        expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        listings++;
        if (transient && listings === 1) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Temporary listing failure" } });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", tools: [echoedTool()] } });
      }
      return server.fetch(input instanceof Request ? input.url : input, init);
    });
    const storage = memoryStorage();
    if (mode === "oauth") await seedGrant(storage, { issuer: "https://authorization.test", tokens: { access_token: TOKEN, token_type: "bearer" } }, undefined, scopes.connector("remote"));
    const connector = remoteMcp("remote", { url: server.url, auth: mode === "request" ? { type: "request", token: async () => TOKEN } : { type: "oauth" } });
    const registry = makeRegistry([connector], { storage });
    const contexts: ConnectorContext[] = [];
    const listTools = connector.listTools;
    connector.listTools = (ctx) => { contexts.push(ctx); return listTools(ctx); };
    try {
      const providers = await buildSandboxProviders(registry, BASE, silentLogger);
      const host = providers.find((provider) => provider.name === "connecta")!.fns;
      const args = { connector: "remote", fullDescriptions: true, includeSchemas: "json" as const };
      if (transient) {
        const failed = await host.search!(args);
        expect(JSON.stringify(failed)).toContain("catalogErrors");
        expect(await storage.list("catalog:remote")).toEqual([]);
      }
      const result = await host.search!(args);
      expect(JSON.stringify(result)).toContain("Read with [redacted]");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      const tools = await registry.getTools("remote", BASE);
      expect(tools[0]).toMatchObject({ name: "read", title: "Read [redacted]", inputSchema: { properties: { "[redacted]": { description: "[redacted]" } } }, outputSchema: { properties: { echo: { description: "[redacted]" } } }, annotations: { title: "[redacted]" } });
      const later = await createMetaTools(registry, BASE).searchTools(args);
      expect(JSON.stringify(later)).toContain("Read with [redacted]");
      expect(JSON.stringify(later)).not.toContain(TOKEN);
      await expectCleanCache(storage, connector);
      expect(listings).toBe(transient ? 2 : 1);
      expect(connects).toBeGreaterThan(0);
      expect(contexts.length).toBeGreaterThanOrEqual(transient ? 2 : 1);
      if (transient) {
        expect(contexts[1]).not.toBe(contexts[0]);
        expect(contexts[1]!.requestScope).toBe(contexts[0]!.requestScope);
      }
    } finally { for (const ctx of contexts) await connector.closeScope?.(ctx); }
  });

  it.each(["auto", "legacy"] as const)("INV-5: %s discovery registers auxiliary auth headers through handshake and catalog intake", async (versionNegotiation) => {
    const header = "discovery-auxiliary-credential";
    const server = httpDownstream((mcp) => mcp.registerTool("read", {}, async () => ({ content: [] })));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? await request.clone().json() as any : undefined;
      if (body?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", tools: [echoedTool(header)] } });
      return server.fetch(input instanceof Request ? input.url : input, init);
    });
    const connector = remoteMcp("remote", { url: server.url, versionNegotiation, auth: { type: "request", token: async () => TOKEN, headers: { "X-API-Key": header } } });
    const ctx = connectorContext();
    try {
      const tools = await connector.listTools(ctx);
      expect(tools[0]?.description).toBe("Read with [redacted]");
      expect(JSON.stringify(tools)).not.toContain(header);
    } finally { await connector.closeScope?.(ctx); }
  });

  it("INV-5 INV-8: refuses a secret-bearing tool name without publishing a mangled or partial catalog", async () => {
    const server = httpDownstream((mcp) => mcp.registerTool("read", {}, async () => ({ content: [] })));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? await request.clone().json() as any : undefined;
      if (body?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", tools: [echoedTool(), { ...echoedTool(), name: `read_${TOKEN}` }] } });
      return server.fetch(input instanceof Request ? input.url : input, init);
    });
    const connector = remoteMcp("remote", { url: server.url, auth: { type: "request", token: async () => TOKEN } });
    const storage = memoryStorage();
    await expect(makeRegistry([connector], { storage }).getTools("remote", BASE)).rejects.toThrow("tool name");
    expect(await storage.list("catalog:remote")).toEqual([]);
  });

  it("INV-5: registry intake tracks custom catalog credential reads before persistence", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, KEY);
    await vault.set("custom", TOKEN, "test-user");
    const connector: Connector = {
      id: "custom", kind: "api", credential: { label: "Key" },
      listTools: async (ctx) => [echoedTool((await ctx.credential!.getAll())!.value!)],
      callTool: async () => null,
    };
    const tools = await makeRegistry([connector], { storage, credentialVault: vault }).getTools("custom", BASE);
    expect(tools[0]?.description).toBe("Read with [redacted]");
    expect(await storage.list("response-cache:v1:")).toEqual([]);
  });

  it.each(["api", "oauth"] as const)("INV-5: %s catalog decorators use credentials sent by API fetch paths at registry intake", async (mode) => {
    const storage = memoryStorage();
    const tokenEndpoint = "https://oauth.api.test/token";
    if (mode === "oauth") await seedGrant(storage, { issuer: tokenEndpoint, tokens: { access_token: TOKEN, token_type: "bearer" } }, undefined, scopes.connector("api"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get(mode === "oauth" ? "authorization" : "x-api-key")).toBe(mode === "oauth" ? `Bearer ${TOKEN}` : TOKEN);
      return Response.json([echoedTool()]);
    });
    const base = api("api", {
      ...(mode === "oauth" ? { oauth: { authorizationEndpoint: "https://oauth.api.test/authorize", tokenEndpoint, clientId: "client", apiOrigins: ["https://api.test"] } } : {}),
      tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => {
        const response = await (ctx.oauth?.fetch ?? ctx.fetch)("https://api.test/catalog", mode === "api" ? { headers: { "X-API-Key": TOKEN } } : undefined);
        return response.json();
      } }],
    });
    const { staticTools: _staticTools, ...dynamic } = base;
    const connector: Connector = { ...dynamic, async listTools(ctx) {
      await base.callTool("read", {}, ctx);
      // A decorator adds vendor facts after the API result boundary. Intake
      // must still use the actual request's credentials before caching them.
      return [echoedTool()];
    } };
    const tools = await makeRegistry([connector], { storage }).getTools("api", BASE);
    expect(tools[0]?.description).toBe("Read with [redacted]");
    expect(await storage.list("response-cache:v1:")).toEqual([]);
  });
});
