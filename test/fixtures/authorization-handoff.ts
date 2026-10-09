import { expect, vi } from "vitest";
import { encryptedCredentialVault } from "../../src/credentials.js";
import { ConnectorCallError } from "../../src/errors.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector, Executor } from "../../src/types.js";
import { createTestConnecta, required } from "../helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./http.js";
import { CREDENTIAL_KEY } from "./ui.js";

export const HANDOFF_BASE = "https://connecta.test";
export const AUTH_PROGRAM = `async () => {
  const calls = await Promise.all([1, 2, 3].map(async () => {
    try { return await connecta.call("service.read"); }
    catch (e) { return { data: e.data, details: e.details }; }
  }));
  const search = await connecta.search({ connector: "service" });
  const describe = await connecta.describe({ addresses: ["service.read", "service.read"] });
  return { calls, search, describe };
}`;

export function handoffFixture(options: {
  catalogAuth?: boolean;
  credential?: boolean;
  manage?: boolean;
  authScope?: "personal" | "shared";
  executor?: Executor;
} = {}) {
  const storage = memoryStorage();
  const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
  const sign = vi.spyOn(vault, "signOAuthHandoff");
  let connected = false;
  let state = "";
  const tools = [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
  const connector: Connector = {
    id: "service",
    kind: "api",
    authScope: options.authScope ?? "personal",
    listTools: async () => {
      if (options.catalogAuth && !connected) throw new ConnectorCallError("downstream_oauth_required", "PRIVATE_CATALOG");
      return tools;
    },
    callTool: async () => {
      if (!connected) throw new ConnectorCallError("auth_required", "PRIVATE_DOWNSTREAM");
      return { connected: true };
    },
    status: async () => ({ state: connected ? "ok" : "auth_required" }),
    startAuth: vi.fn(async (ctx) => {
      state = crypto.randomUUID();
      await ctx.storage.set("consent", state);
      return { state: "auth_required" as const, authorizationUrl: `https://consent.test/authorize?state=${state}` };
    }),
    verifyState: async (candidate, ctx) => candidate !== null && candidate === await ctx.storage.get("consent"),
    finishAuth: async () => { connected = true; },
  };
  if (options.credential) {
    delete connector.startAuth;
    delete connector.finishAuth;
    delete connector.verifyState;
    delete connector.status;
    connector.credential = { label: "Service token", fields: [{ name: "apiKey", label: "API key", description: "Enter the service API key." }] };
    connector.listTools = async (ctx) => {
      if (options.catalogAuth && !await ctx.credential?.get("apiKey")) throw new ConnectorCallError("auth_required", "PRIVATE_CATALOG");
      return tools;
    };
    connector.callTool = async (_name, _args, ctx) => ({ connected: Boolean(await ctx.credential?.get("apiKey")) });
  }
  const executor: Executor = options.executor ?? {
    execute: async (_code, providers) => {
      const fns = required(providers.find(p => p.name === "connecta")).fns;
      const calls = await Promise.all([1, 2, 3].map(async () => {
        try { return await fns.call!("service.read"); }
        catch (e) { const error = e as { data: unknown; details: unknown }; return { data: error.data, details: error.details }; }
      }));
      const search = await fns.search!({ connector: "service" });
      const describe = await fns.describe!({ addresses: ["service.read", "service.read"] });
      return { result: { calls, search, describe } };
    },
  };
  const app = createTestConnecta({
    connectors: [connector], storage, vault, publicUrl: HANDOFF_BASE, logger: "silent", executor,
    auth: ["alice", "bob"].map(user => fakeClerkAuth({ token: user, userId: user })),
    identity: { credentialAdministration: () => options.manage === false ? "none" : "all", personalConnection: () => options.manage === false ? "none" : "all" },
    pools: { team: { tools: ["service"], grant: () => true, trust: "read-only" } },
  });
  const rpc = async (name: string, args: Record<string, unknown>, pool = "team") => {
    const request = mcpRpc("tools/call", { name, arguments: args }, { token: "alice" });
    return (await readJsonRpc(await app.fetch(new Request(`${HANDOFF_BASE}/mcp/${pool}`, request)))).result;
  };
  const browser = (url: string, user = "alice") => app.fetch(new Request(url, { headers: { Cookie: `__session=${user}` } }));
  const complete = async (url: string) => {
    expect((await browser(url, "bob")).status).toBe(403);
    const start = new URL(url);
    start.searchParams.set("start", "1");
    const response = await browser(start.href);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`https://consent.test/authorize?state=${state}`);
    expect(connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
    expect((await browser(start.href)).status).toBe(400);
    const callback = await browser(`${HANDOFF_BASE}/oauth/callback/service?code=test&state=${state}`);
    expect(callback.status).toBe(200);
    expect((await rpc("call_tool", { address: "service.read", resultMode: "value" })).structuredContent.data).toEqual({ connected: true });
  };
  return { app, rpc, browser, complete, vault, sign, connector };
}

/** Runs against both actual guest bridges, including concurrent and catalog failures. */
export async function checkAuthHandoffProgram(executor: Executor): Promise<void> {
  const flow = handoffFixture({ catalogAuth: true, executor });
  try {
    const result = (await flow.rpc("execute_code", { code: AUTH_PROGRAM })).structuredContent.result;
    const error = result.calls[0].data;
    expect(error).toMatchObject({ code: "downstream_oauth_required", recovery: "oauth", nextAction: { tool: "authorize_connector", arguments: { connector: "service" } }, authorizationUrl: expect.stringContaining(`${HANDOFF_BASE}/connect/service?h=v3.`), instructions: expect.any(String) });
    for (const call of result.calls) {
      expect(call.data).toEqual(call.details);
      expect(call.data.authorizationUrl).toBe(error.authorizationUrl);
    }
    expect(result.search.catalogErrors[0].authorizationUrl).toBe(error.authorizationUrl);
    expect(result.search.queryAnalysis.catalogError.authorizationUrl).toBe(error.authorizationUrl);
    for (const tool of result.describe.tools) expect(tool.errorDetails.authorizationUrl).toBe(error.authorizationUrl);
    expect(flow.sign).toHaveBeenCalledOnce();
    expect(flow.connector.startAuth).not.toHaveBeenCalled();

    await flow.complete(error.authorizationUrl);
  } finally { await flow.app.close(); }
}
