import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { guardedFetch, oauthBearer } from "../src/connectors/guarded-fetch.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
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

function setup(connector: Connector) {
  const storage = memoryStorage();
  const app = createTestConnecta({
    connectors: [connector], storage, vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
    publicUrl: BASE, logger: "silent", auth: [fakeClerkAuth({ token: "alice", userId: "alice" })],
    identity: { credentialAdministration: () => "all" },
    pools: { trusted: { tools: ["service"], grant: () => true, trust: "trusted" } },
    executor: { execute: async (_code, providers) => {
      const call = required(providers.find(provider => provider.name === "connecta")).fns.call!;
      try { return { result: await call("service.write", {}) }; }
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
  return { app, rpc, connect };
}

function apiFlow(options: { plain?: boolean; guarded?: boolean } = {}) {
  let items = 0;
  let audits = 0;
  let rejectAudit = true;
  const sends = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      name, ...(name === "read" ? { annotations: { readOnlyHint: true } } : {}),
      handler: async (_args, ctx) => {
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
  return { ...setup(connector), sends, items: () => items, audits: () => audits, allowAudit: () => { rejectAudit = false; } };
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

describe("auth recovery dispatch eligibility", () => {
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

  it.each([false, true])("INV-9: a write whose auth fails before any send elicits and succeeds once (guarded %s)", async guarded => {
    const flow = apiFlow({ guarded });
    const first = await flow.rpc();
    expect(first.resultType).toBe("input_required");
    expect(flow.sends).not.toHaveBeenCalled();
    await flow.connect();
    flow.allowAudit();
    expect((await flow.rpc(undefined, first.requestState)).isError).toBeFalsy();
    expect(flow.items()).toBe(1);
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

  it.each([false, true])("INV-2 INV-9: programs use downstream write dispatch facts (connected %s)", async connected => {
    const flow = apiFlow();
    if (connected) await flow.connect();
    const result = await flow.rpc("execute_code");
    if (connected) { expectReconciliation(result); expect(flow.items()).toBe(1); }
    else { expect(result.resultType).toBe("input_required"); expect(flow.sends).not.toHaveBeenCalled(); }
  });

  it("INV-9: remoteMcp direct writes cannot elicit after tools/call returns HTTP 401", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as any;
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "tools/call") { calls++; return new Response(null, { status: 401 }); }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "service", version: "1" } }
        : { tools: [{ name: "write", inputSchema: { type: "object" } }] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });
    const connector = remoteMcp("service", { url: `${API}/mcp`, versionNegotiation: "legacy" });
    // The no-auth transport gives the exact HTTP 401 boundary without beginning
    // a separate SDK authorization flow. Recovery remains available to the host.
    connector.startAuth = async () => ({ state: "auth_required", authorizationUrl: "https://auth.service.test/authorize" });
    const flow = setup(connector);
    expectReconciliation(await flow.rpc());
    expect(calls).toBe(1);
  });
});
