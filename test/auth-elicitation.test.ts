import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { operatorUi } from "../src/ui.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { guestErrorText, guestFailureFacts } from "./fixtures/misc.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { createTestConnecta, required } from "./helpers.js";

const BASE = "https://connecta.test";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  options: {
    native?: boolean;
    routed?: boolean;
    poolName?: string;
    storage?: ReturnType<typeof memoryStorage>;
    catalogAuth?: boolean;
    credential?: boolean;
    namedCredential?: boolean;
    uiPath?: string;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
  let connected = false;
  const call = vi.fn(async (name: string) => {
    if (name !== "write" && !connected) throw new ConnectorCallError("auth_required", "DOWNSTREAM_PRIVATE_TEXT");
    return { done: true };
  });
  const connector: Connector = {
    id: "service",
    kind: "api",
    ...(options.routed ? { authScope: "personal" as const } : {}),
    listTools: async () => {
      if (options.catalogAuth && !connected) throw new ConnectorCallError("auth_required", "PRIVATE_CATALOG_AUTH");
      return [
        { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "write", inputSchema: { type: "object" } },
        { name: "needs_auth", inputSchema: { type: "object" } },
      ];
    },
    callTool: call,
    status: async () => ({ state: connected ? "ok" : "auth_required" }),
    startAuth: vi.fn(async () => ({
      state: "auth_required" as const,
      authorizationUrl: `https://downstream.test/secret?state=${crypto.randomUUID()}`,
    })),
  };
  if (options.credential) {
    delete connector.startAuth;
    connector.credential = {
      label: "Service token",
      ...(options.namedCredential ? { fields: [{ name: "apiKey", label: "API key" }] } : {}),
    };
    if (options.namedCredential) delete connector.status;
  }
  const app = createTestConnecta({
    connectors: [connector],
    storage,
    logger: "silent",
    publicUrl: BASE,
    vault,
    ...(options.uiPath ? { ui: { ...operatorUi(), credentialHandoffUrl: () => options.uiPath! } } : {}),
    auth: ["alice", "bob"].map((user) => fakeClerkAuth({ token: user, userId: user })),
    ...(options.routed ? { maintainers: [{ namespace: "https://clerk.example.test", id: "bob" }] } : {}),
    pools: {
      [options.poolName ?? "trusted"]: {
        tools: ["service"],
        members: [{ namespace: "https://clerk.example.test", id: "alice" }],
        readOnly: false,
        ...(options.native ? { surface: "native" as const } : {}),
      },
    },
    executor: {
      execute: async (_code, providers) => {
        const fn = required(providers.find((p) => p.name === "connecta")).fns.call!;
        try {
          const result = await fn("service.read", {});
          return { result };
        } catch (error) {
          return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) };
        }
      },
    },
  });
  apps.push(app);
  const rpc = async (
    name = "call_tool",
    args: Record<string, unknown> = { address: "service.read", args: { id: 1 } },
    opts: {
      state?: string;
      action?: string;
      user?: string;
      pool?: string;
      elicitation?: Record<string, unknown>;
    } = {},
  ) => {
    if (options.native && (name === "call_tool" || name === "call_destructive_tool")) {
      name = String(args.address).replace(".", "__");
      args = args.args as Record<string, unknown>;
    }
    const params = {
      name,
      arguments: args,
      ...(opts.state === undefined ? {} : { requestState: opts.state }),
      ...(opts.action === undefined ? {} : { inputResponses: { connecta_auth: { action: opts.action } } }),
    };
    const request = mcpRpc("tools/call", {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "auth-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": { elicitation: opts.elicitation ?? { url: {} } },
      },
    });
    request.headers.set("MCP-Protocol-Version", "2026-07-28");
    request.headers.set("Mcp-Method", "tools/call");
    request.headers.set("Mcp-Name", name);
    request.headers.set("Authorization", `Bearer ${opts.user ?? "alice"}`);
    if (typeof args.address === "string") request.headers.set("Mcp-Param-Address", args.address);
    const pool = opts.pool ?? (options.native ? "trusted" : undefined);
    const target = pool ? new Request(`${BASE}/mcp/${pool}`, request) : request;
    return readJsonRpc(await app.fetch(target));
  };
  const browser = async (url: string) => {
    const response = await app.fetch(new Request(url, { headers: { Cookie: "__session=alice" } }));
    const location = response.headers.get("Location");
    if (location && new URL(location).pathname === "/connectors/service") {
      const start = new URL(url);
      start.searchParams.set("start", "1");
      return app.fetch(new Request(start, { headers: { Cookie: "__session=alice" } }));
    }
    return response;
  };
  return {
    rpc,
    call,
    connector,
    app,
    vault,
    browser,
    connect: () => {
      connected = true;
    },
    disconnect: () => {
      connected = false;
    },
  };
}

describe("native auth URL elicitation", { tags: ["workers"] }, () => {
  it("INV-4: native auth binds the wire name, canonical target and arguments through accept, decline and cancel", async () => {
    for (const action of ["accept", "decline", "cancel"]) {
      const flow = setup({ native: true });
      const first = (await flow.rpc()).result;
      expect(first.resultType).toBe("input_required");
      for (const [name, args] of [
        ["service__write", { id: 1 }],
        ["service__read", { id: 2 }],
      ] as const) {
        const changed = await flow.rpc(name, args, { state: first.requestState, action });
        expect(changed.error || changed.result?.structuredContent?.error).toBeTruthy();
      }
      expect(flow.call).toHaveBeenCalledOnce();
      flow.connect();
      const retry = (await flow.rpc(undefined, undefined, { state: first.requestState, action })).result;
      if (action === "accept") {
        expect(retry.content[0].text).toBe('{"done":true}');
        expect(flow.call).toHaveBeenCalledTimes(2);
      } else {
        expect(retry.structuredContent.error.code).toBe(action === "decline" ? "auth_declined" : "auth_cancelled");
        expect(flow.call).toHaveBeenCalledOnce();
      }
      const replay = await flow.rpc(undefined, undefined, { state: first.requestState, action });
      expect(replay.result.structuredContent.error.code).toBe("invalid_request_state");
    }
  });
  it("INV-4 INV-5: native catalog misses retain an authorization handoff without dispatch or absent tools", async () => {
    const flow = setup({ native: true, catalogAuth: true });
    const result = (await flow.rpc()).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: "auth_required",
      authorizationUrl: expect.stringContaining("/connect/service"),
    });
    expect(result.structuredContent.error.nextAction).toMatchObject({
      url: result.structuredContent.error.authorizationUrl,
    });
    expect(JSON.stringify(result)).not.toMatch(/authorize_connector|search_tools|call_tool|PRIVATE_CATALOG_AUTH/);
    expect(flow.call).not.toHaveBeenCalled();
  });
});

describe("auth URL elicitation", { tags: ["node"] }, () => {
  it("INV-4 INV-5 INV-6: asks capable hosts through a fixed same-origin URL elicitation", async () => {
    const flow = setup();
    const sign = vi.spyOn(flow.vault, "signOAuthHandoff");
    const result = (await flow.rpc()).result;
    expect(result).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        connecta_auth: {
          method: "elicitation/create",
          params: { mode: "url", message: "Connect this service in your browser, then retry the request." },
        },
      },
    });
    expect(result.requestState).toEqual(expect.any(String));
    const url = new URL(result.inputRequests.connecta_auth.params.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/connect/service`);
    const [version, encrypted] = url.searchParams.get("h")!.split(".");
    expect(version).toBe("v4");
    expect(atob(encrypted!.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("alice");
    expect(url.href).not.toContain("%");
    expect(url.searchParams.get("h")).not.toContain("=");
    expect(JSON.stringify(result)).not.toContain("DOWNSTREAM_PRIVATE_TEXT");
    expect(JSON.stringify(result)).not.toContain("downstream.test");
    expect(flow.connector.startAuth).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledOnce();
  });

  it("invalidates routed auth continuations when membership selects a different pool", async () => {
    const storage = memoryStorage();
    const first = setup({ routed: true, storage, poolName: "team" });
    const state = (await first.rpc()).result.requestState;
    expect(state).toBeTypeOf("string");
    const moved = setup({ routed: true, storage, poolName: "other" });
    const sign = vi.spyOn(moved.vault, "signOAuthHandoff");
    expect((await moved.rpc(undefined, undefined, { state, action: "decline" })).error).toMatchObject({
      code: -32602,
      data: { reason: "invalid_request_state" },
    });
    expect((await moved.rpc(undefined, undefined, { state, action: "accept" })).error).toMatchObject({
      code: -32602,
      data: { reason: "invalid_request_state" },
    });
    expect(sign).not.toHaveBeenCalled();
    expect(moved.call).not.toHaveBeenCalled();
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

  it("INV-4 INV-5 INV-10: a refused prompt hands off one identity-checked link and starts nothing", async () => {
    for (const action of ["decline", "cancel"]) {
      const flow = setup();
      const sign = vi.spyOn(flow.vault, "signOAuthHandoff");
      const first = (await flow.rpc()).result;
      const retry = (await flow.rpc(undefined, undefined, { state: first.requestState, action })).result;
      const error = retry.structuredContent.error;
      expect(retry.isError).toBe(true);
      expect(error).toMatchObject({
        code: action === "decline" ? "auth_declined" : "auth_cancelled",
        retryable: false,
        connector: "service",
        recovery: "oauth",
        authorizationUrl: expect.stringContaining(`${BASE}/connect/service?h=v4.`),
        nextAction: { url: error.authorizationUrl, purpose: expect.stringMatching(/once.*stop/s) },
      });
      // Neither claims a person refused nor invites another prompt.
      expect(error.message).toMatch(/possibly automatically/);
      expect(error.message).not.toMatch(/^Connection was/);
      expect(error.authorizationUrl).not.toBe(first.inputRequests.connecta_auth.params.url);
      expect(JSON.stringify(retry)).not.toMatch(/alice|DOWNSTREAM_PRIVATE_TEXT|downstream\.test|authorize_connector/);
      // Issuing the link dispatches nothing and starts no consent.
      expect(flow.call).toHaveBeenCalledOnce();
      expect(flow.connector.startAuth).not.toHaveBeenCalled();
      expect(sign).toHaveBeenCalledTimes(2);

      // The state stays one-shot, so a client cannot farm links from one prompt,
      // and discovery with that state issues none.
      const replay = await flow.rpc(undefined, undefined, { state: first.requestState, action });
      expect(replay.result.structuredContent.error.code).toBe("invalid_request_state");
      const search = await flow.rpc("search_tools", { query: "read" }, { state: first.requestState, action });
      expect(JSON.stringify(search)).not.toContain("/connect/");
      expect(sign).toHaveBeenCalledTimes(2);

      const bob = await flow.app.fetch(new Request(error.authorizationUrl, { headers: { Cookie: "__session=bob" } }));
      expect(bob.status).toBe(403);
      expect(flow.connector.startAuth).not.toHaveBeenCalled();
      expect((await flow.browser(error.authorizationUrl)).status).toBeLessThan(400);
      expect(flow.connector.startAuth).toHaveBeenCalledOnce();
    }
  });

  it("INV-4: a refused prompt offers no handoff the caller lacked on an incapable host", async () => {
    const flow = setup();
    const ordinary = (await flow.rpc(undefined, undefined, { elicitation: { form: {} } })).result.structuredContent
      .error;
    const first = (await flow.rpc()).result;
    const refused = (await flow.rpc(undefined, undefined, { state: first.requestState, action: "decline" })).result
      .structuredContent.error;
    for (const field of ["connector", "recovery", "status", "instructions"])
      expect(refused[field]).toEqual(ordinary[field]);
    expect(new URL(refused.authorizationUrl).pathname).toBe(new URL(ordinary.authorizationUrl).pathname);
    // The agent now sees this link, and the sealed form does not name the principal.
    expect(new URL(refused.authorizationUrl).searchParams.get("h")).toMatch(/^v4\./);
    expect(new URL(ordinary.authorizationUrl).searchParams.get("h")).toMatch(/^v3\./);
  });

  it("INV-4: a refused prompt on a native pool names no route and keeps the handoff", async () => {
    const flow = setup({ native: true });
    const first = (await flow.rpc()).result;
    const retry = (await flow.rpc(undefined, undefined, { state: first.requestState, action: "decline" })).result;
    const error = retry.structuredContent.error;
    expect(error.nextAction).toMatchObject({ url: error.authorizationUrl });
    expect(JSON.parse(retry.content[0].text).error.authorizationUrl).toBe(error.authorizationUrl);
    expect(JSON.stringify(retry)).not.toMatch(/authorize_connector|search_tools|call_tool/);
  });

  it("INV-4 INV-5: a refused credential prompt returns the operator handoff without values", async () => {
    const flow = setup({ credential: true, uiPath: "/operator" });
    const args = { connector: "service" };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const error = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "cancel" })).result
      .structuredContent.error;
    expect(error).toMatchObject({
      code: "auth_cancelled",
      recovery: "operator_config",
      operatorUrl: "/operator",
      credential: { label: "Service token" },
      nextAction: { url: "/operator" },
    });
    expect(error.authorizationUrl).toBeUndefined();
  });

  it("INV-4 INV-5: a signing failure leaves the refusal without a link", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    vi.spyOn(flow.vault, "signOAuthHandoff").mockRejectedValue(new Error("SIGNING_KEY_PRIVATE_TEXT"));
    const retry = (await flow.rpc(undefined, undefined, { state: first.requestState, action: "decline" })).result;
    expect(retry.structuredContent).toEqual({
      ok: false,
      error: { code: "auth_declined", message: expect.stringMatching(/possibly automatically/), retryable: false },
    });
    expect(JSON.stringify(retry)).not.toContain("SIGNING_KEY_PRIVATE_TEXT");
  });

  it("INV-4 INV-9: a refused restart keeps its force and never resets a started attempt", async () => {
    const args = { connector: "service", force: true };
    const flow = setup();
    flow.connect();
    const first = (await flow.rpc("authorize_connector", args)).result;
    const refused = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "decline" }))
      .result.structuredContent.error;
    expect((await flow.browser(refused.authorizationUrl)).status).toBeLessThan(400);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });

    const pending = setup();
    pending.connect();
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(pending.connector.startAuth!).mockImplementationOnce(async () => {
      entered();
      await paused;
      return { state: "auth_required", authorizationUrl: "https://downstream.test/secret" };
    });
    const opening = (await pending.rpc("authorize_connector", args)).result;
    const browser = pending.browser(opening.inputRequests.connecta_auth.params.url);
    await starting;
    try {
      const declined = (
        await pending.rpc("authorize_connector", args, { state: opening.requestState, action: "decline" })
      ).result.structuredContent.error;
      // The pending start owns the reset, so this link waits on it and cannot begin another.
      expect((await pending.browser(declined.authorizationUrl)).status).toBe(400);
      expect(pending.connector.startAuth).toHaveBeenCalledOnce();
    } finally {
      resume();
    }
    await browser;
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
    expect((await flow.rpc(undefined, undefined, { state, action: "accept" })).error).toMatchObject({
      code: -32602,
      data: { reason: "invalid_request_state" },
    });
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
    const codeState = (await flow.rpc("execute_code", { code: "return await connecta.call('service.read', {});" }))
      .result.requestState;
    expect(
      (await flow.rpc("execute_code", { code: "return 1;" }, { state: codeState, action: "accept" })).result
        .structuredContent.error.code,
    ).toBe("invalid_request_state");
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-5 INV-9: a claimed forced reconnect cannot complete against the old grant before reset finishes", async () => {
    const flow = setup();
    flow.connect();
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(flow.connector.startAuth!).mockImplementation(async () => {
      entered();
      await paused;
      flow.disconnect();
      return {
        state: "auth_required",
        authorizationUrl: `https://downstream.test/secret?state=${crypto.randomUUID()}`,
      };
    });
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const browser = flow.browser(first.inputRequests.connecta_auth.params.url);
    await starting;
    let pending;
    try {
      pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
      expect(pending.resultType).toBe("input_required");
    } finally {
      resume();
    }
    expect((await browser).status).toBe(302);
    const afterReset = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" }))
      .result;
    expect(afterReset.resultType).toBe("input_required");
    flow.connect();
    expect(
      (await flow.rpc("authorize_connector", args, { state: afterReset.requestState, action: "accept" })).result
        .structuredContent,
    ).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-5: credential completion requires fields compatible with the current declaration", async () => {
    const flow = setup({ credential: true, namedCredential: true });
    await flow.vault.set("service", "old-single-value", "alice");
    const args = { connector: "service" };
    const first = (await flow.rpc("authorize_connector", args)).result;
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(302);
    const pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" }))
      .result;
    expect(pending.resultType).toBe("input_required");
    await flow.vault.setAll("service", { apiKey: "new-api-key" }, "alice");
    const completed = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" }))
      .result;
    expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-9: a failed browser start is terminal and does not block a later successful retry", async () => {
    const flow = setup();
    vi.mocked(flow.connector.startAuth!).mockRejectedValueOnce(new Error("Start failed"));
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(400);
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(400);
    const pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" }))
      .result;
    expect(pending.resultType).toBe("input_required");
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => {
      flow.connect();
      return { state: "ok" };
    });
    expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(200);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    const completed = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" }))
      .result;
    expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-5 INV-9: retires unused forced links before the completion status check", async () => {
    const flow = setup();
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const second = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" }))
      .result;
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => {
      flow.connect();
      return { state: "ok" };
    });
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(200);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
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
    } finally {
      resume();
    }
    expect((await retry).result.structuredContent).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-9: each requestState admits one retry and concurrent forks are refused", async () => {
    const flow = setup();
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const replies = await Promise.all(
      [1, 2].map(() => flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })),
    );
    expect(replies.filter((reply) => reply.result.resultType === "input_required")).toHaveLength(1);
    expect(
      replies.filter((reply) => reply.result.structuredContent?.error?.code === "invalid_request_state"),
    ).toHaveLength(1);
    expect(flow.connector.startAuth).not.toHaveBeenCalled();
    for (const action of ["decline", "cancel"]) {
      const state = (await flow.rpc()).result.requestState;
      await flow.rpc(undefined, undefined, { state, action });
      expect(
        (await flow.rpc(undefined, undefined, { state, action: "accept" })).result.structuredContent.error.code,
      ).toBe("invalid_request_state");
    }
  });

  it("INV-4 INV-5 INV-9: Continue cannot reuse the old grant when its forced predecessor fails", async () => {
    const flow = setup();
    flow.connect();
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
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
    } finally {
      resume();
    }
    expect((await browser).status).toBe(400);
    expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(400);
    expect(flow.connector.startAuth).toHaveBeenCalledOnce();
    const replacement = (await flow.rpc("authorize_connector", args, { state: pending.requestState, action: "accept" }))
      .result;
    expect(replacement.resultType).toBe("input_required");
    vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => ({ state: "ok" }));
    expect((await flow.browser(replacement.inputRequests.connecta_auth.params.url)).status).toBe(200);
    expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    expect(
      (await flow.rpc("authorize_connector", args, { state: replacement.requestState, action: "accept" })).result
        .structuredContent,
    ).toEqual({ connector: "service", status: "ok" });
  });

  it("INV-4 INV-5: credential handoffs respect configured UI paths and reject external redirects", async () => {
    for (const uiPath of ["/operator", "https://evil.test/operator"]) {
      const flow = setup({ credential: true, uiPath });
      const args = { connector: "service" };
      const first = (await flow.rpc("authorize_connector", args)).result;
      const browser = await flow.app.fetch(
        new Request(first.inputRequests.connecta_auth.params.url, { headers: { Cookie: "__session=alice" } }),
      );
      if (uiPath.startsWith("https:")) {
        expect(browser.status).toBe(503);
        expect(browser.headers.get("Location")).toBeNull();
      } else {
        expect(browser.headers.get("Location")).toBe(`${BASE}/operator`);
        await flow.vault.set("service", "configured-token", "alice");
        flow.connect();
        const completed = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" }))
          .result;
        expect(completed.structuredContent).toEqual({ connector: "service", status: "ok" });
      }
    }
  });
});
