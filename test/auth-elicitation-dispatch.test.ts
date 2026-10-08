import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { guardedFetch, oauthBearer } from "../src/connectors/guarded-fetch.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { createTestConnecta, required } from "./helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { guestErrorText, guestFailureFacts } from "./fixtures/misc.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";

const BASE = "https://connecta.test";
const API = "https://api.service.test";
const TOKEN = "https://auth.service.test/token";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(connector: Connector, options: { additional?: Connector[]; program?: (call: (address: string, args: unknown) => Promise<unknown>) => Promise<unknown> } = {}) {
  const storage = memoryStorage();
  const connectors = [connector, ...(options.additional ?? [])];
  const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
  const app = createTestConnecta({
    connectors, storage, vault,
    publicUrl: BASE, logger: "silent", auth: [fakeClerkAuth({ token: "alice", userId: "alice" })],
    identity: { credentialAdministration: () => "all" },
    pools: { trusted: { tools: connectors.map(item => item.id), grant: () => true, trust: "trusted" } },
    executor: { execute: async (_code, providers) => {
      const call = required(providers.find(provider => provider.name === "connecta")).fns.call!;
      try {
        if (options.program) return { result: await options.program(call) };
        await call("service.write", {});
        return { result: await call("service.read", {}) };
      }
      catch (error) { return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) }; }
    } },
  });
  apps.push(app);
  const rpc = async (name = "call_destructive_tool", state?: string, address = "service.write") => {
    const args = name === "execute_code" ? { code: "write" } : { address, args: {} };
    const request = mcpRpc("tools/call", {
      name, arguments: args, ...(state ? { requestState: state, inputResponses: { connecta_auth: { action: "accept" } } } : {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
      },
    });
    request.headers.set("MCP-Protocol-Version", "2026-07-28");
    request.headers.set("Mcp-Method", "tools/call");
    request.headers.set("Mcp-Name", name);
    request.headers.set("Authorization", "Bearer alice");
    if (name !== "execute_code") request.headers.set("Mcp-Param-Address", address);
    return (await readJsonRpc(await app.fetch(name === "execute_code" ? new Request(`${BASE}/mcp/trusted`, request) : request))).result;
  };
  const connect = async () => {
    const ctx = () => app.registry.contextFor("service", BASE);
    const started = await connector.startAuth!(ctx(), { force: true });
    const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
    const callback = ctx();
    expect(await connector.verifyState!(state, callback)).toBe(true);
    await connector.finishAuth!("consented", callback, new URLSearchParams({ code: "consented", state }));
  };
  return { app, rpc, connect, vault };
}

function apiFlow(options: { plain?: boolean; guarded?: boolean; resetScope?: boolean } = {}) {
  let items = 0;
  let audits = 0;
  let entries = 0;
  let rejectAudit = true;
  const sends = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === TOKEN) return Response.json({ access_token: "service-access-token", token_type: "Bearer" });
    if (url === `${API}/items`) { items++; return Response.json({ id: items }); }
    if (url === `${API}/audit`) { audits++; return Response.json({}, { status: rejectAudit ? 401 : 200 }); }
    throw new Error(`Unexpected test URL ${url}`);
  });
  vi.stubGlobal("fetch", sends);
  const transport = guardedFetch({ provider: "Service", baseUrl: API, maxResponseBytes: 1024,
    ...(options.plain ? { authenticate: () => ({}) } : oauthBearer("Service")),
  });
  const connector = api("service", {
    oauth: { authorizationEndpoint: "https://auth.service.test/authorize", tokenEndpoint: TOKEN,
      clientId: "client", apiOrigins: [API] },
    tools: ["write", "read"].map(name => ({
      name, description: name === "write" ? "Create an item and read its audit" : "Read the audit",
      annotations: { readOnlyHint: name === "read" },
      handler: async (_args, ctx) => {
        entries++;
        if (options.resetScope) ctx.requestScope = {};
        if (options.guarded) {
          if (name === "write") await transport({ method: "POST", path: "/items" }, ctx, response => response.json());
          return transport({ method: "GET", path: "/audit" }, ctx, response => {
            if (response.status === 401) throw new ConnectorCallError("auth_required", "Audit requires authentication.");
            return response.json();
          });
        }
        const send = options.plain ? ctx.fetch : ctx.oauth!.fetch;
        if (name === "write") await send(`${API}/items`, { method: "POST" });
        const audit = await send(`${API}/audit`);
        if (audit.status === 401) throw new ConnectorCallError("auth_required", "Audit requires authentication.");
        return audit.json();
      },
    })),
  });
  return { ...setup(connector), sends, items: () => items, audits: () => audits, entries: () => entries,
    allowAudit: () => { rejectAudit = false; } };
}

function expectReconciliation(result: any) {
  expect(result.resultType).not.toBe("input_required");
  expect(result.requestState).toBeUndefined();
  expect(result.isError).toBe(true);
  expect(result.structuredContent.error).toMatchObject({
    code: "downstream_oauth_required", retryable: false, reconciliationRequired: true,
    authorizationUrl: expect.stringContaining(`${BASE}/connect/service?h=`),
    retry: expect.stringContaining("Reconcile"),
  });
}

describe("auth recovery invocation eligibility", () => {
  it.each([["api", false], ["custom", false], ["api", true], ["custom", true]] as const)(
    "INV-9: raw fetch in a %s connector write cannot elicit or replay a completed item (program %s)", async (kind, program) => {
      let items = 0;
      const send = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === `${API}/items`) { items++; return Response.json({ id: items }); }
        return Response.json({}, { status: 401 });
      });
      vi.stubGlobal("fetch", send);
      const handler = async (_args: unknown, ctx: ConnectorContext) => {
        // Both sends bypass Connecta's fetch wrappers. Replacing the scope
        // must not detach the host's invocation facts either.
        ctx.requestScope = {};
        await fetch(`${API}/items`, { method: "POST" });
        const response = await fetch(`${API}/audit`);
        if (response.status === 401) throw new ConnectorCallError("auth_required", "Audit needs auth");
        return response.json();
      };
      const definition = { name: "write", description: "Create item and get audit", annotations: { readOnlyHint: false } };
      const connector: Connector = kind === "api"
        ? api("service", { tools: [{ ...definition, handler }] })
        : { id: "service", kind: "api", staticTools: [definition], listTools: async () => [definition],
            callTool: (_name, args, ctx) => handler(args, ctx) };
      connector.startAuth = async () => ({ state: "auth_required", authorizationUrl: "https://auth.service.test/authorize" });
      const flow = setup(connector);
      expectReconciliation(await flow.rpc(program ? "execute_code" : undefined));
      expect(items).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])("INV-9: pre-invocation missing credential slots elicit without entering a write (named %s)", async named => {
    let writes = 0;
    const connector = api("service", { credential: { label: "Token",
      ...(named ? { fields: [{ name: "apiKey", label: "API key" }] } : {}) },
      tools: [{ name: "write", description: "Create an item", annotations: { readOnlyHint: false },
        handler: () => { writes++; return { id: writes }; } }],
    });
    const flow = setup(connector);
    // A previously declared slot cannot satisfy the current named slot.
    if (named) await flow.vault.set("service", "old-token", "alice");
    const first = await flow.rpc();
    expect(first.resultType).toBe("input_required");
    expect(writes).toBe(0);
    if (named) await flow.vault.setAll("service", { apiKey: "current-token" }, "alice");
    else await flow.vault.set("service", "current-token", "alice");
    expect((await flow.rpc(undefined, first.requestState)).isError).toBeFalsy();
    expect(writes).toBe(1);
  });

  it("INV-2 INV-9: a program cannot elicit after an earlier write handler entered and a read lacks credentials", async () => {
    let entries = 0;
    let reads = 0;
    const service = api("service", { tools: [{ name: "write", description: "Enter a write", annotations: { readOnlyHint: false },
      handler: () => { entries++; throw new ConnectorCallError("invalid_args", "Write refused inside handler"); } }],
    });
    const protectedRead = api("protected", { credential: { label: "Read token" },
      tools: [{ name: "read", description: "Read an item", annotations: { readOnlyHint: true }, handler: () => { reads++; return {}; } }],
    });
    const flow = setup(service, { additional: [protectedRead], program: async call => {
      try { await call("service.write", {}); } catch { /* Continue to the protected read. */ }
      return call("protected.read", {});
    } });
    const result = await flow.rpc("execute_code");
    expect(result.resultType).not.toBe("input_required");
    expect(result.structuredContent.error).toMatchObject({ code: "auth_required", retryable: false, reconciliationRequired: true,
      authorizationUrl: expect.stringContaining(`${BASE}/connect/protected?h=`) });
    expect(entries).toBe(1);
    expect(reads).toBe(0);
  });

  it.each([{}, { plain: true }, { guarded: true }, { plain: true, guarded: true }])(
    "INV-9: a direct write followed by an auth failure cannot elicit or replay (%j)", async options => {
      const flow = apiFlow(options);
      await flow.connect();
      const result = await flow.rpc();
      expectReconciliation(result);
      expect(flow.items()).toBe(1);
      await flow.connect();
      expect(flow.items()).toBe(1);
    },
  );

  it.each([false, true])("INV-9: a write with a pre-invocation missing grant elicits and succeeds once (guarded %s)", async guarded => {
    const flow = apiFlow({ guarded });
    const first = await flow.rpc();
    expect(first.resultType).toBe("input_required");
    expect(flow.sends).not.toHaveBeenCalled();
    expect(flow.entries()).toBe(0);
    await flow.connect();
    flow.allowAudit();
    expect((await flow.rpc(undefined, first.requestState)).isError).toBeFalsy();
    expect(flow.items()).toBe(1);
    expect(flow.entries()).toBe(1);
  });

  it("INV-9: an accept retry that dispatches a write and then fails auth cannot elicit another round", async () => {
    const flow = apiFlow();
    const first = await flow.rpc();
    expect(first.resultType).toBe("input_required");
    expect(flow.items()).toBe(0);
    await flow.connect();
    expectReconciliation(await flow.rpc(undefined, first.requestState));
    expect(flow.items()).toBe(1);
    const repeated = await flow.rpc(undefined, first.requestState);
    expect(repeated.structuredContent.error.code).toBe("invalid_request_state");
    expect(flow.items()).toBe(1);
  });

  it("INV-9: each accepted write round rechecks pre-invocation eligibility before handler entry", async () => {
    const flow = apiFlow();
    const first = await flow.rpc();
    const second = await flow.rpc(undefined, first.requestState);
    expect(second.resultType).toBe("input_required");
    expect(second.requestState).not.toBe(first.requestState);
    expect(flow.entries()).toBe(0);
    expect(flow.sends).not.toHaveBeenCalled();
    await flow.connect();
    expectReconciliation(await flow.rpc(undefined, second.requestState));
    expect(flow.items()).toBe(1);
    expect(flow.entries()).toBe(1);
    expect((await flow.rpc(undefined, second.requestState)).structuredContent.error.code).toBe("invalid_request_state");
    expect(flow.items()).toBe(1);
  });

  it("INV-9: a read using raw fetch elicits after a mid-handler 401 and re-runs", async () => {
    let authorized = false;
    let entries = 0;
    vi.stubGlobal("fetch", async () => Response.json({}, { status: authorized ? 200 : 401 }));
    const connector = api("service", { tools: [{ name: "read", description: "Read an audit", annotations: { readOnlyHint: true },
      handler: async () => {
        entries++;
        const response = await fetch(`${API}/audit`);
        if (response.status === 401) throw new ConnectorCallError("auth_required", "Audit needs auth");
        return response.json();
      } }],
    });
    connector.startAuth = async () => ({ state: "auth_required", authorizationUrl: "https://auth.service.test/authorize" });
    const flow = setup(connector);
    const first = await flow.rpc("call_tool", undefined, "service.read");
    expect(first.resultType).toBe("input_required");
    expect(entries).toBe(1);
    authorized = true;
    expect((await flow.rpc("call_tool", first.requestState, "service.read")).isError).toBeFalsy();
    expect(entries).toBe(2);
  });

  it.each([false, true])("INV-9: custom write auth errors before any send cannot elicit (program %s)", async program => {
    let entries = 0;
    const definition = { name: "write", annotations: { readOnlyHint: false } };
    const connector: Connector = { id: "service", kind: "api", staticTools: [definition], listTools: async () => [definition],
      callTool: () => { entries++; throw new ConnectorCallError("auth_required", "Connect first"); },
      startAuth: async () => ({ state: "auth_required", authorizationUrl: "https://auth.service.test/authorize" }),
    };
    const flow = setup(connector);
    expectReconciliation(await flow.rpc(program ? "execute_code" : undefined));
    expect(entries).toBe(1);
  });

  it("INV-4 INV-9: a handler cannot reset invocation facts by replacing its context scope", async () => {
    const flow = apiFlow({ plain: true, resetScope: true });
    await flow.connect();
    expectReconciliation(await flow.rpc());
    expect(flow.items()).toBe(1);
  });

  it("INV-9: a read with a mid-handler 401 elicits and can re-run after connection", async () => {
    const flow = apiFlow();
    await flow.connect();
    const first = await flow.rpc("call_tool", undefined, "service.read");
    expect(first.resultType).toBe("input_required");
    expect(flow.audits()).toBeGreaterThan(0);
    await flow.connect();
    flow.allowAudit();
    expect((await flow.rpc("call_tool", first.requestState, "service.read")).isError).toBeFalsy();
    expect(flow.items()).toBe(0);
  });

  it.each([false, true])("INV-2 INV-9: programs use write handler entry facts (connected %s)", async connected => {
    const flow = apiFlow();
    if (connected) await flow.connect();
    const result = await flow.rpc("execute_code");
    if (connected) { expectReconciliation(result); expect(flow.items()).toBe(1); }
    else { expect(result.resultType).toBe("input_required"); expect(flow.sends).not.toHaveBeenCalled(); }
  });

  it("INV-2 INV-9: completed local program writes remain guarded before a later auth failure", async () => {
    let writes = 0;
    const connector = api("service", { tools: [
      { name: "write", description: "Record a local write", annotations: { readOnlyHint: false }, handler: () => { writes++; return {}; } },
      { name: "read", description: "Read a protected record", annotations: { readOnlyHint: true }, handler: () => { throw new ConnectorCallError("auth_required", "Connect first."); } },
    ] });
    connector.startAuth = async () => ({ state: "auth_required", authorizationUrl: "https://auth.service.test/authorize" });
    const flow = setup(connector);
    expectReconciliation(await flow.rpc("execute_code"));
    expect(writes).toBe(1);
  });

  it.each([false, true])("INV-9: remoteMcp direct writes cannot elicit after tools/call returns HTTP 401 (OAuth %s)", async oauth => {
    let calls = 0;
    let granted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === TOKEN) {
        granted = true;
        return Response.json({ access_token: "service-access-token", token_type: "Bearer" });
      }
      if (request.url.includes(".well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${API}/mcp`, authorization_servers: ["https://auth.service.test"] });
      }
      if (request.url.includes(".well-known/oauth-authorization-server")) {
        return Response.json({ issuer: "https://auth.service.test", authorization_endpoint: "https://auth.service.test/authorize",
          token_endpoint: TOKEN, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"] });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as any;
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "tools/call") calls++;
      if ((oauth && !granted) || message.method === "tools/call") {
        return new Response(null, { status: 401, headers: {
          "www-authenticate": `Bearer resource_metadata="${API}/.well-known/oauth-protected-resource"`,
        } });
      }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "service", version: "1" } }
        : { tools: [{ name: "write", inputSchema: { type: "object" } }] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });
    const connector = remoteMcp("service", { url: `${API}/mcp`, versionNegotiation: "legacy",
      ...(oauth ? { auth: { type: "oauth" as const, client: { issuer: "https://auth.service.test", clientId: "client", tokenEndpointAuthMethod: "none" as const } } } : {}),
    });
    // The no-auth transport gives the exact HTTP 401 boundary without beginning
    // a separate SDK authorization flow. Recovery remains available to the host.
    if (!oauth) connector.startAuth = async () => ({ state: "auth_required", authorizationUrl: "https://auth.service.test/authorize" });
    const flow = setup(connector);
    if (oauth) await flow.connect();
    expectReconciliation(await flow.rpc());
    expect(calls).toBe(1);
  });
});
