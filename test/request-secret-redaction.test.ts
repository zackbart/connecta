import { afterEach, expect, it, vi } from "vitest";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { ConnectorCallError } from "../src/errors.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { createTestConnecta, makeRegistry, silentLogger } from "./helpers.js";
import { agentOutputOperations, sentSecretsFor, sentSecretsForRequest } from "../src/sent-secrets.js";
import { Registry } from "../src/registry.js";
import { scopes } from "../src/storage/keys.js";
import { seedGrant } from "./fixtures/oauth.js";
import { deferred } from "./fixtures/misc.js";
import { mcpRpc } from "./fixtures/http.js";
import type { Connector, ConnectorContext, ToolDef } from "../src/types.js";

const TOKEN = "r5-failed-catalog-bearer-credential";
const BASE = "https://connecta.test";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("INV-5: a downstream 400 catalog diagnostic cannot disclose its sent vault token", async () => {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  await vault.set("catalog", TOKEN, "operator");
  const records: unknown[] = [];
  const record = (...args: unknown[]) => { records.push(args); };
  const logger = { debug: record, info: record, warn: record, error: record };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // Ordinary 4xx error response includes the authorization it received.
    return Response.json({ message: `Catalog refused: ${request.headers.get("authorization")}` }, { status: 400 });
  });
  const transport = guardedFetch({ provider: "Catalog", baseUrl: "https://catalog.test", maxResponseBytes: 65536,
    authenticate: async ctx => ({ Authorization: `Bearer ${await ctx.credential!.get()}` }) });
  const contexts: ConnectorContext[] = [];
  const connector: Connector = { id: "catalog", kind: "api", credential: { label: "API token" },
    async listTools(ctx) {
      contexts.push(ctx);
      return transport({ method: "GET", path: "/tools" }, ctx, async response => {
        const parsed = await response.jsonResult();
        if ("parseError" in parsed) throw new ConnectorCallError("connector_call_failed", "Malformed catalog");
        const payload = parsed.value as { message: string; tools: ToolDef[] };
        if (!response.ok) throw new ConnectorCallError("invalid_args", payload.message);
        return payload.tools;
      });
    },
    async callTool() { return null; }
  };
  const registry = makeRegistry([connector], { storage, credentialVault: vault, logger });
  const host = (await buildSandboxProviders(registry, "https://connecta.test", silentLogger))[0]!.fns;
  const search = await host.search!({ connector: "catalog" });
  expect(JSON.stringify(search)).not.toContain(TOKEN);
  const description = await host.describe!({ addresses: ["catalog.read"], format: "json" });
  const call = await createMetaTools(registry, "https://connecta.test").callTool({ address: "catalog.read" });
  // Confirm registration succeeded, and no raw operator text or cache was written.
  expect(contexts.every(ctx => sentSecretsFor(ctx).text(TOKEN) === "[redacted]")).toBe(true);
  expect(await storage.list("catalog:catalog")).toEqual([]);
  expect(JSON.stringify(records)).not.toContain(TOKEN);
  expect.soft(JSON.stringify(description)).not.toContain(TOKEN);
  expect.soft(JSON.stringify(call)).not.toContain(TOKEN);
});

it("INV-5: failed search_tools listings register credentials in the search request", async () => {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, KEY);
  await vault.set("catalog", TOKEN, "operator");
  const contexts: ConnectorContext[] = [];
  const connector: Connector = {
    id: "catalog", kind: "api", credential: { label: "Token" },
    async listTools(ctx) {
      contexts.push(ctx);
      const token = await ctx.credential!.get();
      throw new ConnectorCallError("invalid_args", `Catalog refused ${token}`, { cause: new Error(String(token)) });
    },
    async callTool() { return null; },
  };
  const result = await createMetaTools(makeRegistry([connector], { storage, credentialVault: vault }), BASE).searchTools({ connector: "catalog" });
  expect(result.structuredContent).toMatchObject({ catalogErrors: [{ connector: "catalog", code: "invalid_args" }] });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(sentSecretsForRequest(contexts[0]!.requestScope!).text(TOKEN)).toBe("[redacted]");
  expect(await storage.list("catalog:catalog")).toEqual([]);
});

it.each([false, true])("INV-5: a failed registry refresh sanitizes shared failure intake, synchronous=%s", async (synchronous) => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  let calls = 0;
  const storage = memoryStorage();
  const scopesSeen: object[] = [];
  const connector: Connector = {
    id: "catalog", kind: "api",
    listTools(ctx) {
      calls++;
      scopesSeen.push(ctx.requestScope!);
      sentSecretsFor(ctx).add(TOKEN);
      if (synchronous) throw new ConnectorCallError("invalid_args", TOKEN);
      entered.resolve();
      return gate.promise.then(() => { throw new ConnectorCallError("invalid_args", TOKEN, { cause: new Error(TOKEN) }); });
    },
    async callTool() { return null; },
  };
  const registry = makeRegistry([connector], { storage });
  if (synchronous) {
    await expect(registry.getTools("catalog", BASE, {})).rejects.toThrow("[redacted]");
  } else {
    const firstScope = {};
    const secondScope = {};
    const first = registry.getTools("catalog", BASE, firstScope).catch(error => error);
    await entered.promise;
    const second = registry.getTools("catalog", BASE, secondScope).catch(error => error);
    // Drain the joiner's storage reads before the owner publishes its failure.
    await new Promise(resolve => setTimeout(resolve, 0));
    gate.resolve();
    const failures = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(sentSecretsForRequest(secondScope).text(TOKEN)).toBe(TOKEN);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ConnectorCallError);
      expect(failure.message).toBe("[redacted]");
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(failure))).not.toContain(TOKEN);
    }
  }
  const later = await createMetaTools(registry, BASE).callTool({ address: "catalog.read" });
  expect(later.isError).toBe(true);
  expect(JSON.stringify(later)).not.toContain(TOKEN);
  expect(await storage.list("catalog:catalog")).toEqual([]);
  expect(scopesSeen.at(-1)).not.toBe(scopesSeen[0]);
});

it("INV-5 INV-7: deferred refresh contexts contribute credentials and retain clean stale facts for later requests", async () => {
  const clock = vi.spyOn(Date, "now");
  let now = 1_800_000_000_000;
  clock.mockImplementation(() => now);
  const storage = memoryStorage();
  const contexts: ConnectorContext[] = [];
  const connector: Connector = {
    id: "catalog", kind: "api",
    async listTools(ctx) {
      contexts.push(ctx);
      sentSecretsFor(ctx).add(TOKEN);
      if (contexts.length > 1) throw new ConnectorCallError("invalid_args", `Refresh refused ${TOKEN}`);
      return [{ name: "read", description: `Read ${TOKEN}`, annotations: { readOnlyHint: true } }];
    },
    async callTool() { return null; },
  };
  const registry = new Registry([connector], { storage, logger: silentLogger, toolCacheTtlSeconds: 1, toolCatalogStaleSeconds: 30 });
  await registry.getTools("catalog", BASE, {});
  now += 2_000;
  const requestScope = {};
  const tails: Promise<unknown>[] = [];
  const stale = await registry.getTools("catalog", BASE, requestScope, {}, { refreshTimeoutMs: 1_000, defer: promise => tails.push(promise) });
  expect(stale[0]?.description).toBe("Read [redacted]");
  await Promise.all(tails);
  expect(contexts).toHaveLength(2);
  expect(contexts[1]!.requestScope).not.toBe(requestScope);
  expect(sentSecretsForRequest(requestScope).text(TOKEN)).toBe("[redacted]");
  const later = await createMetaTools(registry, BASE).searchTools({ connector: "catalog", fullDescriptions: true });
  expect(JSON.stringify(later)).toContain("Read [redacted]");
  expect(JSON.stringify(later)).not.toContain(TOKEN);
  for (const key of await storage.list("catalog:catalog")) expect(await storage.get(key)).not.toContain(TOKEN);
  // A fresh registry, with no original request or credentials, reads the same facts.
  const cached = await makeRegistry([connector], { storage }).getTools("catalog", BASE, {});
  expect(cached[0]?.description).toBe("Read [redacted]");
});

it("INV-5: listing credentials redact a later unauthenticated result before stash storage and later paging", async () => {
  const storage = memoryStorage();
  const contexts: ConnectorContext[] = [];
  let calls = 0;
  const connector: Connector = {
    id: "catalog", kind: "api",
    async listTools(ctx) {
      contexts.push(ctx);
      sentSecretsFor(ctx).add(TOKEN);
      return [{ name: "read", annotations: { readOnlyHint: true } }];
    },
    async callTool(_name, _args, ctx) {
      contexts.push(ctx);
      return { echo: TOKEN, text: ++calls === 1 ? "x".repeat(8_000) : "ordinary" };
    },
  };
  const registry = makeRegistry([connector], { storage, maxResultBytes: 1_024 });
  const tools = createMetaTools(registry, BASE);
  const result = await tools.callTool({ address: "catalog.read", resultMode: "value" });
  const notice = (result.structuredContent!.data as { resultId: string });
  expect(notice.resultId).toBeTypeOf("string");
  expect(contexts[0]!.requestScope).toBe(contexts[1]!.requestScope);
  expect(sentSecretsFor(contexts[1]!).text(TOKEN)).toBe(TOKEN);
  let body = "";
  let offset = 0;
  for (;;) {
    const page = await createMetaTools(registry, BASE).getResult({ id: notice.resultId, offset });
    const [header, ...text] = page.content[0]!.text.split("\n");
    body += text.join("\n");
    const paging = JSON.parse(header!) as { hasMore: boolean; nextAction?: { arguments: { offset: number } } };
    if (!paging.hasMore) break;
    offset = paging.nextAction!.arguments.offset;
  }
  expect(JSON.parse(body).echo).toBe("[redacted]");
  const later = await tools.callTool({ address: "catalog.read", resultMode: "value" });
  expect(later.structuredContent!.data).toMatchObject({ echo: TOKEN });
  expect(contexts.at(-1)!.requestScope).not.toBe(contexts[0]!.requestScope);
});

it("INV-5: api handler errors redact the header credential on direct and guest exits", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Request(input, init).headers.get("x-api-key")).toBe(TOKEN);
    return Response.json({ message: `Handler refused ${TOKEN}` }, { status: 400 });
  });
  const connector = api("api", { tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => {
    const body = await (await ctx.fetch("https://api.test/read", { headers: { "X-API-Key": TOKEN } })).json() as { message: string };
    throw new ConnectorCallError("invalid_args", body.message, { cause: new Error(TOKEN) });
  } }] });
  const registry = makeRegistry([connector]);
  const direct = await createMetaTools(registry, BASE).callTool({ address: "api.read" });
  expect(direct.isError).toBe(true);
  expect(JSON.stringify(direct)).toContain("Handler refused [redacted]");
  expect(JSON.stringify(direct)).not.toContain(TOKEN);
  const guest = (await buildSandboxProviders(registry, BASE, silentLogger))[0]!.fns;
  await expect(guest.call!("api.read", {})).rejects.toThrow("Handler refused [redacted]");
});

it.each(["http", "throw"])("INV-5: OAuth refresh %s errors register and redact the refresh credential", async (mode) => {
  const storage = memoryStorage();
  const tokenEndpoint = "https://oauth.api.test/token";
  const refresh = "request-refresh-credential/+echo";
  await seedGrant(storage, { issuer: tokenEndpoint, tokens: { access_token: TOKEN, refresh_token: refresh, token_type: "bearer" } }, undefined, scopes.connector("api"));
  let refreshes = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== tokenEndpoint) return new Response("", { status: 401 });
    refreshes++;
    expect(new URLSearchParams(init?.body as URLSearchParams).get("refresh_token")).toBe(refresh);
    if (mode === "throw") throw new ConnectorCallError("invalid_args", `Refresh refused ${refresh}`);
    return Response.json({ error: "invalid_grant", error_description: `Refresh refused ${refresh}` }, { status: 400 });
  });
  const connector = api("api", {
    oauth: { authorizationEndpoint: "https://oauth.api.test/authorize", tokenEndpoint, clientId: "client", apiOrigins: ["https://api.test"] },
    tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: async (_args, ctx) => ctx.oauth!.fetch("https://api.test/read") }],
  });
  const requestScope = {};
  const result = await createMetaTools(makeRegistry([connector], { storage }), BASE, { requestScope }).callTool({ address: "api.read" });
  expect(result.isError).toBe(true);
  expect(refreshes).toBe(1);
  expect(sentSecretsForRequest(requestScope).text(refresh)).toBe("[redacted]");
  expect(JSON.stringify(result)).not.toContain(refresh);
});

it("INV-5: every meta-tool output and guest bridge entry uses the request boundary", async () => {
  const connector = api("contract", {
    tools: [{ name: "read", description: `Read ${TOKEN}`, annotations: { readOnlyHint: true }, handler: async () => ({ echo: TOKEN }) }],
  });
  connector.usageGuide = `Guide ${TOKEN}`;
  connector.startAuth = async () => ({ state: "auth_required" });
  const registry = makeRegistry([connector]);
  const requestScope = {};
  const secrets = sentSecretsForRequest(requestScope);
  secrets.add(TOKEN);
  const tools = createMetaTools(registry, BASE, {
    requestScope, canManageAuth: () => true, oauthConnectUrl: async () => `https://oauth.test/${TOKEN}`,
  });
  const outputs: Record<keyof typeof tools, () => Promise<unknown>> = {
    skills: () => tools.skills({ name: "connector:contract" }),
    searchTools: () => tools.searchTools({ connector: "contract", fullDescriptions: true }),
    callTool: () => tools.callTool({ address: "contract.read", resultMode: "value" }),
    callDestructiveTool: () => tools.callDestructiveTool({ address: "contract.read", reason: "Contract test", resultMode: "value" }),
    getResult: () => tools.getResult({ id: TOKEN }),
    authorizeConnector: () => tools.authorizeConnector({ connector: "contract" }),
  };
  expect(Object.keys(tools).sort()).toEqual(Object.keys(outputs).sort());
  for (const [name, run] of Object.entries(outputs)) {
    const result = JSON.stringify(await run());
    expect(result, name).not.toContain(TOKEN);
    expect(result, name).toContain("[redacted]");
  }
  const bridge = (await buildSandboxProviders(registry, BASE, silentLogger, undefined, { sentSecrets: secrets }))[0]!.fns;
  const entries: Record<string, () => Promise<unknown>> = {
    call: () => bridge.call!("contract.read", {}),
    search: () => bridge.search!({ connector: "contract", fullDescriptions: true }),
    describe: () => bridge.describe!({ address: "contract.read", fullDescriptions: true }),
    emit: () => bridge.emit!({ type: TOKEN }),
  };
  expect(Object.keys(bridge).sort()).toEqual(Object.keys(entries).sort());
  for (const [name, run] of Object.entries(entries)) {
    const result = await run().catch(error => ({ message: error.message }));
    expect(JSON.stringify(result), name).not.toContain(TOKEN);
  }
});

it("INV-5: future operation-table entries and thrown errors pass through the same output function", async () => {
  const operations = agentOutputOperations(scope => {
    const ctx = { storage: memoryStorage(), logger: silentLogger, baseUrl: BASE, requestScope: scope };
    return {
      async futureResult() {
        sentSecretsFor(ctx).add(TOKEN);
        return { content: [{ type: "text", text: TOKEN.slice(0, 12) }, { type: "text", text: TOKEN.slice(12) }], structuredContent: { echo: TOKEN } };
      },
      async futureError() {
        sentSecretsFor(ctx).add(TOKEN);
        throw new ConnectorCallError("invalid_args", TOKEN, { cause: new Error(TOKEN) });
      },
    };
  });
  expect(await operations.futureResult()).toMatchObject({ content: [{ text: "[redacted]" }, { text: "" }], structuredContent: { echo: "[redacted]" } });
  await expect(operations.futureError()).rejects.toThrow("[redacted]");
});

it.each(["modern", "legacy"])("INV-5: %s MCP wire responses redact failed listings in text and structured content", async (protocol) => {
  vi.stubGlobal("fetch", async () => Response.json({ message: `Catalog refused ${TOKEN}` }, { status: 400 }));
  const transport = guardedFetch({ provider: "Catalog", baseUrl: "https://catalog.test", maxResponseBytes: 65_536, authenticate: async () => ({ Authorization: `Bearer ${TOKEN}` }) });
  const connector: Connector = {
    id: "catalog", kind: "api",
    async listTools(ctx) {
      return transport({ method: "GET", path: "/tools" }, ctx, async response => {
        const parsed = await response.jsonResult();
        if ("parseError" in parsed) throw new Error("Bad fixture");
        throw new ConnectorCallError("invalid_args", (parsed.value as { message: string }).message);
      });
    },
    async callTool() { return null; },
  };
  const app = createTestConnecta({ connectors: [connector], storage: memoryStorage(), logger: silentLogger });
  try {
    const request = mcpRpc("tools/call", {
      name: "call_tool", arguments: { address: "catalog.read" },
      ...(protocol === "modern" ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    });
    if (protocol === "modern") {
      request.headers.set("Mcp-Protocol-Version", "2026-07-28");
      request.headers.set("Mcp-Method", "tools/call");
      request.headers.set("Mcp-Name", "call_tool");
    }
    const response = await app.fetch(request);
    const body = await response.text();
    expect(body).not.toContain(TOKEN);
    const rpc = JSON.parse(body) as { result: { isError: boolean; content: { text: string }[]; structuredContent: { error: { message: string } } } };
    expect(rpc.result, body).toBeDefined();
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0]!.text).toContain("Catalog refused [redacted]");
    expect(rpc.result.structuredContent.error.message).toBe("Catalog refused [redacted]");
  } finally { await app.close(); }
});

it("INV-5: remote MCP OAuth refresh uses the tracked token send path", async () => {
  const issuer = "https://authorization.test";
  const tokenEndpoint = `${issuer}/token`;
  const url = "https://downstream.test/mcp";
  const refresh = "remote-refresh-credential/+echo";
  const storage = memoryStorage();
  await seedGrant(storage, {
    issuer, client: { value: { client_id: "test-client", token_endpoint_auth_method: "none" } },
    tokens: { access_token: TOKEN, refresh_token: refresh, token_type: "bearer" },
    discovery: {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: tokenEndpoint, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] },
      resourceMetadata: { resource: url, authorization_servers: [issuer] },
    },
  }, undefined, scopes.connector("remote"));
  let sent = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target === tokenEndpoint) {
      sent++;
      expect(new URLSearchParams(init?.body as URLSearchParams).get("refresh_token")).toBe(refresh);
      expect(init?.redirect).toBe("manual");
      return Response.json({ error: "invalid_grant", error_description: `Refresh refused ${refresh}` }, { status: 400 });
    }
    if (target.includes(".well-known/oauth-protected-resource")) return Response.json({ resource: url, authorization_servers: [issuer] });
    if (target.includes(".well-known/oauth-authorization-server")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: tokenEndpoint, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"` } });
  });
  const connector = remoteMcp("remote", { url, auth: { type: "oauth" } });
  const registry = makeRegistry([connector], { storage });
  const requestScope = {};
  const result = await createMetaTools(registry, BASE, { requestScope }).callTool({ address: "remote.read" });
  expect(result.isError).toBe(true);
  expect(sent).toBe(1);
  expect(sentSecretsForRequest(requestScope).text(refresh)).toBe("[redacted]");
  expect(JSON.stringify(result)).not.toContain(refresh);
  await connector.closeScope?.(registry.contextFor("remote", BASE, requestScope));
});
