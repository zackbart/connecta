import { beforeEach as beforeTransportTest } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";

// Stand in for the Node host while preserving this suite's fetch leaves.
beforeTransportTest(() => {
  installOwnedTransport();
});

import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { sentSecretsFor, sentSecretsForRequest } from "../src/sent-secrets.js";
import { scopes } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, ToolDef } from "../src/types.js";
import { deferred } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const TOKEN = "r5-failed-catalog-bearer-credential";
const BASE = "https://connecta.test";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("INV-5: a downstream 400 catalog diagnostic cannot disclose its sent vault token", async () => {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  await vault.set("catalog", TOKEN, "operator");
  const records: unknown[] = [];
  const record = (...args: unknown[]) => {
    records.push(args);
  };
  const logger = { debug: record, info: record, warn: record, error: record };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // Ordinary 4xx error response includes the authorization it received.
    return Response.json({ message: `Catalog refused: ${request.headers.get("authorization")}` }, { status: 400 });
  });
  const transport = guardedFetch({
    provider: "Catalog",
    baseUrl: "https://catalog.test",
    maxResponseBytes: 65536,
    authenticate: async (ctx) => ({ Authorization: `Bearer ${await ctx.credential!.get()}` }),
  });
  const contexts: ConnectorContext[] = [];
  const connector: Connector = {
    id: "catalog",
    kind: "api",
    credential: { label: "API token" },
    async listTools(ctx) {
      contexts.push(ctx);
      return transport({ method: "GET", path: "/tools" }, ctx, async (response) => {
        const parsed = await response.jsonResult();
        if ("parseError" in parsed) throw new ConnectorCallError("connector_call_failed", "Malformed catalog");
        const payload = parsed.value as { message: string; tools: ToolDef[] };
        if (!response.ok) throw new ConnectorCallError("invalid_args", payload.message);
        return payload.tools;
      });
    },
    async callTool() {
      return null;
    },
  };
  const registry = makeRegistry([connector], { storage, credentialVault: vault, logger });
  const host = (await buildSandboxProviders(registry, "https://connecta.test", silentLogger))[0]!.fns;
  const search = await host.search!({ connector: "catalog" });
  expect(JSON.stringify(search)).not.toContain(TOKEN);
  const description = await host.describe!({ addresses: ["catalog.read"], format: "json" });
  const call = await createMetaTools(registry, "https://connecta.test").callTool({ address: "catalog.read" });
  // Confirm registration succeeded, and no raw operator text or cache was written.
  expect(contexts.every((ctx) => sentSecretsFor(ctx).text(TOKEN) === "[redacted]")).toBe(true);
  expect(await storage.list("catalog:catalog")).toEqual([]);
  expect(JSON.stringify(records)).not.toContain(TOKEN);
  expect.soft(JSON.stringify(description)).not.toContain(TOKEN);
  expect.soft(JSON.stringify(call)).not.toContain(TOKEN);
});

it.each([false, true])(
  "INV-5: independent failed listings sanitize their own failure intake, synchronous=%s",
  async (synchronous) => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let calls = 0;
    const storage = memoryStorage();
    const scopesSeen: object[] = [];
    const connector: Connector = {
      id: "catalog",
      kind: "api",
      listTools(ctx) {
        calls++;
        scopesSeen.push(ctx.requestScope!);
        sentSecretsFor(ctx).add(TOKEN);
        if (synchronous) throw new ConnectorCallError("invalid_args", TOKEN);
        entered.resolve();
        return gate.promise.then(() => {
          throw new ConnectorCallError("invalid_args", TOKEN, { cause: new Error(TOKEN) });
        });
      },
      async callTool() {
        return null;
      },
    };
    const registry = makeRegistry([connector], { storage });
    if (synchronous) {
      await expect(registry.getTools("catalog", BASE, {})).rejects.toThrow("[redacted]");
    } else {
      const firstScope = {};
      const secondScope = {};
      const first = registry.getTools("catalog", BASE, firstScope).catch((error) => error);
      await entered.promise;
      const second = registry.getTools("catalog", BASE, secondScope).catch((error) => error);
      // Both request-owned listings must enter before either fails.
      await new Promise((resolve) => setTimeout(resolve, 0));
      gate.resolve();
      const failures = await Promise.all([first, second]);
      expect(calls).toBe(2);
      expect(sentSecretsForRequest(secondScope).text(TOKEN)).toBe("[redacted]");
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
  },
);

it("INV-5 INV-6: a later failed listing preserves classification without a stale fallback or inherited secrets", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const connector: Connector = {
    id: "catalog",
    kind: "api",
    async listTools(ctx) {
      sentSecretsFor(ctx).add(TOKEN);
      if (++calls > 1) throw new ConnectorCallError("invalid_args", `Refresh refused ${TOKEN}`);
      return [{ name: "read", description: `Read ${TOKEN}`, annotations: { readOnlyHint: true } }];
    },
    async callTool() {
      return null;
    },
  };
  const registry = makeRegistry([connector], { storage });
  expect((await registry.getTools("catalog", BASE, {}))[0]?.description).toBe("Read [redacted]");
  const requestScope = {};
  await expect(registry.getTools("catalog", BASE, requestScope)).rejects.toMatchObject({
    code: "invalid_args",
    message: "Refresh refused [redacted]",
  });
  expect(sentSecretsForRequest({}).text(TOKEN)).toBe(TOKEN);
  expect(await storage.list("catalog:")).toEqual([]);
});

it("INV-5: listing credentials redact a later unauthenticated result before stash storage and later paging", async () => {
  const storage = memoryStorage();
  const contexts: ConnectorContext[] = [];
  let calls = 0;
  const connector: Connector = {
    id: "catalog",
    kind: "api",
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
  const notice = result.structuredContent!.data as { resultId: string };
  expect(notice.resultId).toBeTypeOf("string");
  expect(contexts[0]!.requestScope).toBe(contexts[1]!.requestScope);
  expect(sentSecretsFor(contexts[1]!).text(TOKEN)).toBe(TOKEN);
  let body = "";
  let offset = 0;
  for (;;) {
    const page = await createMetaTools(registry, BASE).readResult({ id: notice.resultId, offset });
    const [header, ...text] = page.content[0]!.text.split("\n");
    body += text.join("\n");
    const paging = JSON.parse(header!) as { hasMore: boolean; nextOffset?: number };
    if (!paging.hasMore) break;
    offset = paging.nextOffset!;
  }
  expect(JSON.parse(body).echo).toBe("[redacted]");
  const later = await tools.callTool({ address: "catalog.read", resultMode: "value" });
  expect(later.structuredContent!.data).toMatchObject({ echo: "[redacted]" });
  expect(contexts.at(-1)!.requestScope).not.toBe(contexts[0]!.requestScope);
});

it.each(["http", "throw"])(
  "INV-5: OAuth refresh %s errors register and redact the refresh credential",
  async (mode) => {
    const storage = memoryStorage();
    const tokenEndpoint = "https://oauth.api.test/token";
    const refresh = "request-refresh-credential/+echo";
    await seedGrant(
      storage,
      { issuer: tokenEndpoint, tokens: { access_token: TOKEN, refresh_token: refresh, token_type: "bearer" } },
      undefined,
      scopes.connector("api"),
    );
    let refreshes = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== tokenEndpoint) return new Response("", { status: 401 });
      refreshes++;
      expect(new URLSearchParams(init?.body as URLSearchParams).get("refresh_token")).toBe(refresh);
      if (mode === "throw") throw new ConnectorCallError("invalid_args", `Refresh refused ${refresh}`);
      return Response.json(
        { error: "invalid_grant", error_description: `Refresh refused ${refresh}` },
        { status: 400 },
      );
    });
    const connector = api("api", {
      oauth: {
        authorizationEndpoint: "https://oauth.api.test/authorize",
        tokenEndpoint,
        clientId: "client",
        apiOrigins: ["https://api.test"],
      },
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          handler: async (_args, ctx) => ctx.oauth!.fetch("https://api.test/read"),
        },
      ],
    });
    const requestScope = {};
    const result = await createMetaTools(makeRegistry([connector], { storage }), BASE, { requestScope }).callTool({
      address: "api.read",
    });
    expect(result.isError).toBe(true);
    expect(refreshes).toBe(1);
    expect(sentSecretsForRequest(requestScope).text(refresh)).toBe("[redacted]");
    expect(JSON.stringify(result)).not.toContain(refresh);
  },
);

it("INV-5: remote MCP OAuth refresh uses the tracked token send path", async () => {
  const issuer = "https://authorization.test";
  const tokenEndpoint = `${issuer}/token`;
  const url = "https://downstream.test/mcp";
  const refresh = "remote-refresh-credential/+echo";
  const storage = memoryStorage();
  await seedGrant(
    storage,
    {
      issuer,
      client: { value: { client_id: "test-client", token_endpoint_auth_method: "none" } },
      tokens: { access_token: TOKEN, refresh_token: refresh, token_type: "bearer" },
      discovery: {
        authorizationServerUrl: issuer,
        authorizationServerMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: tokenEndpoint,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        },
        resourceMetadata: { resource: url, authorization_servers: [issuer] },
      },
    },
    undefined,
    scopes.connector("remote"),
  );
  let sent = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target === tokenEndpoint) {
      sent++;
      expect(new URLSearchParams(init?.body as URLSearchParams).get("refresh_token")).toBe(refresh);
      expect(init?.redirect).toBe("manual");
      return Response.json(
        { error: "invalid_grant", error_description: `Refresh refused ${refresh}` },
        { status: 400 },
      );
    }
    if (target.includes(".well-known/oauth-protected-resource"))
      return Response.json({ resource: url, authorization_servers: [issuer] });
    if (target.includes(".well-known/oauth-authorization-server"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    return new Response("", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"`,
      },
    });
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
