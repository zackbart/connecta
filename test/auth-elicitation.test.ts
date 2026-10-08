import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { operatorUi } from "../src/ui.js";
import { createTestConnecta, required } from "./helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { guestErrorText, guestFailureFacts } from "./fixtures/misc.js";

const BASE = "https://connecta.test";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map(app => app.close()));
});

function setup(options: { manage?: boolean; vault?: boolean; publicUrl?: boolean; programWrite?: boolean; credential?: boolean; namedCredential?: boolean; uiPath?: string } = {}) {
  const storage = memoryStorage();
  const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
  let connected = false;
  const call = vi.fn(async (name: string) => {
    if (name !== "write" && !connected) throw new ConnectorCallError("auth_required", "DOWNSTREAM_PRIVATE_TEXT");
    return { done: true };
  });
  const connector: Connector = {
    id: "service", kind: "api",
    listTools: async () => [
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "write", inputSchema: { type: "object" } },
      { name: "needs_auth", inputSchema: { type: "object" } },
    ],
    callTool: call,
    status: async () => ({ state: connected ? "ok" : "auth_required" }),
    startAuth: vi.fn(async () => ({ state: "auth_required" as const, authorizationUrl: `https://downstream.test/secret?state=${crypto.randomUUID()}` })),
  };
  if (options.credential) {
    delete connector.startAuth;
    connector.credential = { label: "Service token", ...(options.namedCredential ? { fields: [{ name: "apiKey", label: "API key" }] } : {}) };
    if (options.namedCredential) delete connector.status;
  }
  const app = createTestConnecta({
    connectors: [connector], storage, logger: "silent",
    ...(options.publicUrl === false ? {} : { publicUrl: BASE }),
    ...(options.vault === false ? {} : { vault }),
    ...(options.uiPath ? { ui: { ...operatorUi(), credentialHandoffUrl: () => options.uiPath! } } : {}),
    auth: ["alice", "bob"].map(user => fakeClerkAuth({ token: user, userId: user })),
    identity: { credentialAdministration: () => options.manage === false ? "none" : "all" },
    pools: { trusted: { tools: ["service"], grant: () => true, trust: "trusted" } },
    executor: { execute: async (_code, providers) => {
      const fn = required(providers.find(p => p.name === "connecta")).fns.call!;
      try {
        if (options.programWrite) await fn("service.write", {});
        const result = await fn("service.read", {});
        return { result };
      } catch (error) { return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) }; }
    } },
  });
  apps.push(app);
  const rpc = async (name = "call_tool", args: Record<string, unknown> = { address: "service.read", args: { id: 1 } }, opts: {
    state?: string; action?: string; capable?: boolean; legacy?: boolean; user?: string; pool?: string;
  } = {}) => {
    const params = { name, arguments: args,
      ...(opts.state === undefined ? {} : { requestState: opts.state }),
      ...(opts.action === undefined ? {} : { inputResponses: { connecta_auth: { action: opts.action } } }),
    };
    const request = mcpRpc("tools/call", { ...params, ...(opts.legacy ? {} : { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "auth-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": { elicitation: opts.capable === false ? { form: {} } : { url: {} } },
    } }) });
    if (!opts.legacy) {
      request.headers.set("MCP-Protocol-Version", "2026-07-28");
      request.headers.set("Mcp-Method", "tools/call");
      request.headers.set("Mcp-Name", name);
    }
    request.headers.set("Authorization", `Bearer ${opts.user ?? "alice"}`);
    if (typeof args.address === "string" && !opts.legacy) request.headers.set("Mcp-Param-Address", args.address);
    const target = opts.pool ? new Request(`${BASE}/mcp/${opts.pool}`, request) : request;
    return readJsonRpc(await app.fetch(target));
  };
  const browser = async (url: string) => {
    const response = await app.fetch(new Request(url, { headers: { Cookie: "__session=alice" } }));
    const location = response.headers.get("Location");
    if (location && new URL(location).pathname === "/connectors/service") {
      const start = new URL(url); start.searchParams.set("start", "1");
      return app.fetch(new Request(start, { headers: { Cookie: "__session=alice" } }));
    }
    return response;
  };
  return { rpc, call, connector, app, vault, browser, connect: () => { connected = true; }, disconnect: () => { connected = false; } };
}

describe("auth URL elicitation", () => {
  it("INV-4 INV-5 INV-6: asks capable hosts through a fixed same-origin URL elicitation", async () => {
    const flow = setup();
    const result = (await flow.rpc()).result;
    expect(result).toMatchObject({ resultType: "input_required", inputRequests: {
      connecta_auth: { method: "elicitation/create", params: { mode: "url", message: "Connect this service in your browser, then retry the request." } },
    } });
    expect(result.requestState).toEqual(expect.any(String));
    const url = new URL(result.inputRequests.connecta_auth.params.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/connect/service`);
    const encrypted = url.searchParams.get("h")!.split(".")[0]!;
    expect(encrypted.startsWith("v2:")).toBe(true);
    expect(atob(encrypted.slice(3))).not.toContain("alice");
    expect(JSON.stringify(result)).not.toContain("DOWNSTREAM_PRIVATE_TEXT");
    expect(JSON.stringify(result)).not.toContain("downstream.test");
    expect(flow.connector.startAuth).not.toHaveBeenCalled();
  });

  it("INV-4: keeps the auth envelope and connect link for incapable and legacy hosts", async () => {
    const flow = setup();
    for (const opts of [{ capable: false }, { legacy: true }]) {
      const result = (await flow.rpc(undefined, undefined, opts)).result;
      expect(result.resultType).not.toBe("input_required");
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({ code: "downstream_oauth_required", authorizationUrl: expect.stringContaining(`${BASE}/connect/service?h=`) });
    }
  });

  it("INV-4: refuses elicitation without management, vault, or configured public URL", async () => {
    for (const options of [{ manage: false }, { vault: false }, { publicUrl: false }]) {
      const flow = setup(options);
      const result = (await flow.rpc()).result;
      expect(result.resultType).not.toBe("input_required");
      expect(result.isError).toBe(true);
    }
  });

  it("INV-4: accept re-runs the bound call and observes completed browser auth", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    flow.connect();
    const retry = await flow.rpc(undefined, undefined, { state: first.requestState, action: "accept" });
    expect(retry.result.isError).toBeFalsy();
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4: decline and cancel terminate without dispatch or another prompt", async () => {
    for (const action of ["decline", "cancel"]) {
      const flow = setup();
      const first = (await flow.rpc()).result;
      const retry = (await flow.rpc(undefined, undefined, { state: first.requestState, action })).result;
      expect(retry.resultType).not.toBe("input_required");
      expect(retry.structuredContent.error.code).toBe(action === "decline" ? "auth_declined" : "auth_cancelled");
      expect(flow.call).toHaveBeenCalledOnce();
    }
  });

  it("INV-4: bounds rounds while accept does not claim consent completed", async () => {
    const flow = setup();
    let result = (await flow.rpc()).result;
    for (let round = 1; round < 3; round++) {
      result = (await flow.rpc(undefined, undefined, { state: result.requestState, action: "accept" })).result;
      expect(result.resultType).toBe("input_required");
    }
    result = (await flow.rpc(undefined, undefined, { state: result.requestState, action: "accept" })).result;
    expect(result.structuredContent.error.code).toBe("auth_round_limit");
    expect(flow.call).toHaveBeenCalledTimes(4);
  });

  it("INV-4 INV-5: rejects tampered, expired, cross-principal, and cross-pool state before dispatch", async () => {
    const flow = setup();
    const state: string = (await flow.rpc()).result.requestState;
    for (const opts of [{ state: `${state}x` }, { state, user: "bob" }, { state, pool: "trusted" }]) {
      const retry = await flow.rpc(undefined, undefined, { ...opts, action: "accept" });
      expect(retry.error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect((await flow.rpc(undefined, undefined, { state, action: "accept" })).error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
    expect(flow.call).toHaveBeenCalledOnce();
  });

  it("INV-4: rejects changed arguments, address, tool, and code before retry dispatch", async () => {
    const flow = setup();
    const state: string = (await flow.rpc()).result.requestState;
    for (const [name, args] of [
      ["call_tool", { address: "service.read", args: { id: 2 } }],
      ["call_tool", { address: "service.write", args: { id: 1 } }],
      ["call_destructive_tool", { address: "service.read", args: { id: 1 } }],
    ] as const) {
      const retry = await flow.rpc(name, args, { state, action: "accept" });
      expect(retry.error?.data?.reason ?? retry.result?.structuredContent?.error?.code).toBe("invalid_request_state");
    }
    const codeState = (await flow.rpc("execute_code", { code: "return await connecta.call('service.read', {});" })).result.requestState;
    expect((await flow.rpc("execute_code", { code: "return 1;" }, { state: codeState, action: "accept" })).result.structuredContent.error.code).toBe("invalid_request_state");
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-2 INV-9: programs elicit only before any write was dispatched", async () => {
    for (const programWrite of [false, true]) {
      const flow = setup({ programWrite });
      const result = (await flow.rpc("execute_code", { code: "program" }, { pool: "trusted" })).result;
      if (!programWrite) expect(result.resultType).toBe("input_required");
      else {
        expect(result.resultType).not.toBe("input_required");
        expect(result.structuredContent.error.writes.succeeded).toBe(1);
        expect(result.structuredContent.error.authorizationUrl).toContain(`${BASE}/connect/service?h=`);
      }
    }
  });

  it("INV-2 INV-4: destructive calls and explicit authorize_connector share the auth elicitation", async () => {
    const flow = setup();
    expect((await flow.rpc("call_destructive_tool", { address: "service.needs_auth", args: {} })).result.resultType).toBe("input_required");
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    expect(first.resultType).toBe("input_required");
    const result = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "decline" })).result;
    expect(result.structuredContent.error.code).toBe("auth_declined");
    expect(flow.connector.startAuth).not.toHaveBeenCalled();
  });

  it("INV-4 INV-5: credential slots elicit through an identity-checked same-origin UI handoff", async () => {
    const flow = setup({ credential: true });
    for (const [name, args] of [["call_tool", { address: "service.read" }], ["authorize_connector", { connector: "service" }]] as const) {
      const result = (await flow.rpc(name, args)).result;
      expect(result.resultType).toBe("input_required");
      const url = result.inputRequests.connecta_auth.params.url;
      expect((await flow.app.fetch(new Request(url, { headers: { Cookie: "__session=bob" } }))).status).toBe(403);
      const browser = await flow.app.fetch(new Request(url, { headers: { Cookie: "__session=alice" } }));
      expect(browser.status).toBe(302);
      expect(browser.headers.get("Location")).toBe(`${BASE}/`);
      expect((await flow.app.fetch(new Request(url, { headers: { Cookie: "__session=alice" } }))).status).toBe(400);
    }
  });

  it("INV-4: allows reordered object keys but refuses state on unrelated tools", async () => {
    const flow = setup();
    const args = { address: "service.read", args: { id: 1, nested: { a: 2, b: 3 } } };
    const state = (await flow.rpc("call_tool", args)).result.requestState;
    flow.connect();
    const retry = await flow.rpc("call_tool", { args: { nested: { b: 3, a: 2 }, id: 1 }, address: "service.read" }, { state, action: "accept" });
    expect(retry.result.isError).toBeFalsy();
    expect((await flow.rpc("skills", {}, { state, action: "accept" })).error.data.reason).toBe("invalid_request_state");
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-9: authorize retries finish after a verified browser attempt and do not repeat force", async () => {
    const flow = setup();
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(302);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    const pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
    expect(pending.resultType).toBe("input_required");
    expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(302);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
    flow.connect();
    const completed = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" })).result;
    expect(completed.resultType).not.toBe("input_required");
    expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
    expect(flow.connector.startAuth).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-5 INV-9: a claimed forced reconnect cannot complete against the old grant before reset finishes", async () => {
    const flow = setup();
    flow.connect();
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const starting = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(flow.connector.startAuth!).mockImplementation(async () => {
      entered();
      await paused;
      flow.disconnect();
      return { state: "auth_required", authorizationUrl: `https://downstream.test/secret?state=${crypto.randomUUID()}` };
    });
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const browser = flow.browser(first.inputRequests.connecta_auth.params.url);
    await starting;
    let pending;
    try {
      pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
      expect(pending.resultType).toBe("input_required");
    } finally { resume(); }
    expect((await browser).status).toBe(302);
    const afterReset = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" })).result;
    expect(afterReset.resultType).toBe("input_required");
    flow.connect();
    expect((await flow.rpc("authorize_connector", args, { state: afterReset.requestState, action: "accept" })).result.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-5: credential completion requires fields compatible with the current declaration", async () => {
    const flow = setup({ credential: true, namedCredential: true });
    await flow.vault.set("service", "old-single-value", "alice");
    const args = { connector: "service" };
    const first = (await flow.rpc("authorize_connector", args)).result;
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(302);
    const pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
    expect(pending.resultType).toBe("input_required");
    await flow.vault.setAll("service", { apiKey: "new-api-key" }, "alice");
    const completed = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" })).result;
    expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-9: a failed browser start is terminal and does not block a later successful retry", async () => {
    const flow = setup();
    vi.mocked(flow.connector.startAuth!).mockRejectedValueOnce(new Error("Start failed"));
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(400);
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(400);
    const pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
    expect(pending.resultType).toBe("input_required");
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => {
      flow.connect();
      return { state: "ok" };
    });
    expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(200);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    const completed = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" })).result;
    expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-5 INV-9: retires unused forced links before the completion status check", async () => {
    const flow = setup();
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const second = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => {
      flow.connect();
      return { state: "ok" };
    });
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(200);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const checking = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(flow.connector, "status").mockImplementation(async () => {
      entered();
      await paused;
      return { state: "ok" };
    });
    const retry = flow.rpc("authorize_connector", args, { state: second.requestState, action: "accept" });
    await checking;
    try {
      expect((await flow.browser(second.inputRequests.connecta_auth.params.url)).status).toBe(400);
      expect(flow.connector.startAuth).toHaveBeenCalledOnce();
    } finally { resume(); }
    expect((await retry).result.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-9: each requestState admits one retry and concurrent forks are refused", async () => {
    const flow = setup();
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const replies = await Promise.all([1, 2].map(() => flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })));
    expect(replies.filter(reply => reply.result.resultType === "input_required")).toHaveLength(1);
    expect(replies.filter(reply => reply.result.structuredContent?.error?.code === "invalid_request_state")).toHaveLength(1);
    expect(flow.connector.startAuth).not.toHaveBeenCalled();
    for (const action of ["decline", "cancel"]) {
      const state = (await flow.rpc()).result.requestState;
      await flow.rpc(undefined, undefined, { state, action });
      expect((await flow.rpc(undefined, undefined, { state, action: "accept" })).result.structuredContent.error.code).toBe("invalid_request_state");
    }
  });

  it("INV-4 INV-5 INV-9: Continue cannot reuse the old grant when its forced predecessor fails", async () => {
    const flow = setup();
    flow.connect();
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const starting = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => {
      entered();
      await paused;
      throw new Error("Reset failed before changing the old grant");
    });
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const browser = flow.browser(first.inputRequests.connecta_auth.params.url);
    await starting;
    let pending;
    try {
      pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
      expect(pending.resultType).toBe("input_required");
      expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(400);
    } finally { resume(); }
    expect((await browser).status).toBe(400);
    expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(400);
    expect(flow.connector.startAuth).toHaveBeenCalledOnce();
    const replacement = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" })).result;
    expect(replacement.resultType).toBe("input_required");
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => ({ state: "ok" }));
    expect((await flow.browser(replacement.inputRequests.connecta_auth.params.url)).status).toBe(200);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    expect((await flow.rpc("authorize_connector", args, { state: replacement.requestState, action: "accept" })).result.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-5: credential handoffs respect configured UI paths and reject external redirects", async () => {
    for (const uiPath of ["/operator", "https://evil.test/operator"]) {
      const flow = setup({ credential: true, uiPath });
      const args = { connector: "service" };
      const first = (await flow.rpc("authorize_connector", args)).result;
      const browser = await flow.app.fetch(new Request(first.inputRequests.connecta_auth.params.url, { headers: { Cookie: "__session=alice" } }));
      if (uiPath.startsWith("https:")) {
        expect(browser.status).toBe(503);
        expect(browser.headers.get("Location")).toBeNull();
      } else {
        expect(browser.headers.get("Location")).toBe(`${BASE}/operator`);
        await flow.vault.set("service", "configured-token", "alice");
        flow.connect();
        const completed = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
        expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
      }
    }
  });

  it("INV-9: written programs keep a connect link for hosts without URL support", async () => {
    const flow = setup({ programWrite: true });
    const result = (await flow.rpc("execute_code", { code: "program" }, { pool: "trusted", capable: false })).result;
    expect(result.resultType).not.toBe("input_required");
    expect(result.structuredContent.error).toMatchObject({ writes: { succeeded: 1 }, authorizationUrl: expect.stringContaining(`${BASE}/connect/service?h=`) });
  });
});
