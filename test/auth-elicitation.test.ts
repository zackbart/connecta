import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { identityStorageKey } from "../src/identity.js";
import { claimOAuthConnectStart, verifyOAuthHandoff } from "../src/oauth-handoff.js";
import { oauthConnectKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, KVStorage } from "../src/types.js";
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
    storage?: KVStorage;
    catalogAuth?: boolean;
    credential?: boolean;
    namedCredential?: boolean;
    uiPath?: string;
    noUi?: boolean;
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
    ...(options.noUi ? { ui: undefined } : {}),
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
      name = String(args.address).replace(".", name === "call_tool" ? "__" : "__WRITE__");
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

const forcedStarts = (...flows: ReturnType<typeof setup>[]) =>
  flows
    .flatMap((flow) => vi.mocked(flow.connector.startAuth!).mock.calls)
    .filter(([, options]) => options?.force === true).length;

/** Hold the next browser start open until `resume`, then let it succeed or fail. */
function holdNextStart(flow: ReturnType<typeof setup>, failure?: Error) {
  let resume!: () => void;
  let enter!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  vi.mocked(flow.connector.startAuth!).mockImplementationOnce(async () => {
    enter();
    await paused;
    if (failure) throw failure;
    return { state: "auth_required", authorizationUrl: `https://downstream.test/secret?state=${crypto.randomUUID()}` };
  });
  return { entered, resume };
}

describe("native auth URL elicitation", { tags: ["workers"] }, () => {
  it("INV-4: native auth binds the wire name, canonical target and arguments through accept, decline and cancel", async () => {
    for (const action of ["accept", "decline", "cancel"]) {
      const flow = setup({ native: true });
      const first = (await flow.rpc()).result;
      expect(first.resultType).toBe("input_required");
      for (const [name, args] of [
        ["service__WRITE__write", { id: 1 }],
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

  it("INV-4 INV-5: a signing failure leaves the refusal without a link and says how to get one", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    const sign = vi.spyOn(flow.vault, "signOAuthHandoff").mockRejectedValueOnce(new Error("SIGNING_KEY_PRIVATE_TEXT"));
    const retry = (await flow.rpc(undefined, undefined, { state: first.requestState, action: "decline" })).result;
    expect(retry.structuredContent).toEqual({
      ok: false,
      error: {
        code: "auth_declined",
        message: expect.stringMatching(
          /possibly automatically.*has not refused this connection, repeat this request once for a new link.*Stop if that repeat also fails/s,
        ),
        retryable: false,
      },
    });
    expect(JSON.stringify(retry)).not.toContain("SIGNING_KEY_PRIVATE_TEXT");
    // The step it names works: the same request prompts again, and that refusal carries the link.
    sign.mockRestore();
    const again = (await flow.rpc()).result;
    expect(again.resultType).toBe("input_required");
    const handed = (await flow.rpc(undefined, undefined, { state: again.requestState, action: "decline" })).result;
    expect(handed.structuredContent.error.authorizationUrl).toEqual(expect.stringContaining("/connect/service"));
  });

  it("INV-4 INV-9: a refusal that could not issue a link leaves the prompt's link able to reset", async () => {
    const args = { connector: "service", force: true };
    const flow = setup();
    flow.connect();
    const first = (await flow.rpc("authorize_connector", args)).result;
    const sign = vi.spyOn(flow.vault, "signOAuthHandoff").mockRejectedValueOnce(new Error("storage went away"));
    const refused = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "cancel" }))
      .result.structuredContent.error;
    sign.mockRestore();
    expect(refused.authorizationUrl).toBeUndefined();
    expect(refused.message).toMatch(/repeat this request once for a new link/);
    expect((await flow.browser(first.inputRequests.connecta_auth.params.url)).status).toBe(302);
    expect(forcedStarts(flow)).toBe(1);
  });

  it("INV-4 INV-5: a caller who may no longer connect is not told to ask for a link", async () => {
    const storage = memoryStorage();
    const opened = setup({ credential: true, uiPath: "/operator", storage });
    const args = { connector: "service" };
    const first = (await opened.rpc("authorize_connector", args)).result;
    const withoutUi = setup({ credential: true, noUi: true, storage });
    const refused = (await withoutUi.rpc("authorize_connector", args, { state: first.requestState, action: "decline" }))
      .result.structuredContent;
    expect(refused.error.code).toBe("auth_declined");
    expect(refused.error.authorizationUrl).toBeUndefined();
    expect(refused.error.message).not.toMatch(/repeat this request/);
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
    const held = holdNextStart(pending);
    const opening = (await pending.rpc("authorize_connector", args)).result;
    const browser = pending.browser(opening.inputRequests.connecta_auth.params.url);
    await held.entered;
    let declined;
    try {
      declined = (await pending.rpc("authorize_connector", args, { state: opening.requestState, action: "decline" }))
        .result.structuredContent.error;
      // The pending start owns the reset, so this link waits on it and cannot begin another.
      expect((await pending.browser(declined.authorizationUrl)).status).toBe(409);
      expect(pending.connector.startAuth).toHaveBeenCalledOnce();
    } finally {
      held.resume();
    }
    await browser;
    // Waiting spent nothing, and the same link now continues that attempt.
    expect((await pending.browser(declined.authorizationUrl)).status).toBe(302);
    expect(forcedStarts(pending)).toBe(1);
    expect(pending.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
  });

  it("INV-4 INV-9: a refused restart's prompt link and fallback share one reset, in either visit order, across instances", async () => {
    const args = { connector: "service", force: true };
    for (const order of ["prompt first", "fallback first"]) {
      const storage = memoryStorage();
      const declining = setup({ storage });
      const isolate = setup({ storage });
      declining.connect();
      isolate.connect();
      const opening = (await declining.rpc("authorize_connector", args)).result;
      const refused = (
        await declining.rpc("authorize_connector", args, { state: opening.requestState, action: "decline" })
      ).result.structuredContent.error;
      const prompt: string = opening.inputRequests.connecta_auth.params.url;
      const links = order === "prompt first" ? [prompt, refused.authorizationUrl] : [refused.authorizationUrl, prompt];
      expect((await isolate.browser(links[0]!)).status).toBe(302);
      expect(forcedStarts(declining, isolate)).toBe(1);
      expect(isolate.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
      expect((await declining.browser(links[1]!)).status).toBe(302);
      expect(forcedStarts(declining, isolate)).toBe(1);
      expect(declining.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
    }
  });

  describe("a forced flow's links", () => {
    const args = { connector: "service", force: true };
    const LINK = (result: { inputRequests: { connecta_auth: { params: { url: string } } } }) =>
      result.inputRequests.connecta_auth.params.url;
    // Two app instances over one store, so nothing can rest on request or process memory.
    const pair = (storage: KVStorage = memoryStorage()) => {
      const asking = setup({ storage });
      const other = setup({ storage });
      asking.connect();
      other.connect();
      return { asking, other, flows: [asking, other] as const };
    };
    /** Accept every prompt at once, as the SDK does: a round returns before any browser moves. */
    const rounds = async (pairing: ReturnType<typeof pair>, count: number) => {
      let result = (await pairing.asking.rpc("authorize_connector", args)).result;
      const links = [LINK(result)];
      for (let round = 1; round < count; round++) {
        result = (
          await pairing.other.rpc("authorize_connector", args, { state: result.requestState, action: "accept" })
        ).result;
        expect(result.resultType).toBe("input_required");
        links.push(LINK(result));
      }
      return { links, last: result };
    };
    const permutations = <T>(items: T[]): T[][] =>
      items.length < 2
        ? [items]
        : items.flatMap((item, index) =>
            permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
          );

    it.each([0, 1, 5, 20])(
      "INV-4 INV-9: a visit landing %i ms after accept returned performs the one reset",
      async (delay) => {
        const pairing = pair();
        const { links } = await rounds(pairing, 2);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        expect((await pairing.asking.browser(links[0]!)).status).toBe(302);
        expect(pairing.asking.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
        expect((await pairing.other.browser(links[1]!)).status).toBe(302);
        expect(pairing.other.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
        expect(forcedStarts(...pairing.flows)).toBe(1);
      },
    );

    it("INV-4 INV-9: a maintainer already on the page can press Start after the prompt was accepted", async () => {
      const pairing = pair();
      const opening = (await pairing.asking.rpc("authorize_connector", args)).result;
      const opened = await pairing.asking.app.fetch(
        new Request(LINK(opening), { headers: { Cookie: "__session=alice" } }),
      );
      expect(new URL(opened.headers.get("Location")!).pathname).toBe("/connectors/service");
      const next = (
        await pairing.other.rpc("authorize_connector", args, { state: opening.requestState, action: "accept" })
      ).result;
      expect(forcedStarts(...pairing.flows)).toBe(0);
      expect((await pairing.asking.browser(LINK(opening))).status).toBe(302);
      expect((await pairing.other.browser(LINK(next))).status).toBe(302);
      expect(forcedStarts(...pairing.flows)).toBe(1);
    });

    it("INV-4 INV-9: every round's link works once and all of them reset once, in every visit order", async () => {
      for (const order of permutations([0, 1, 2])) {
        const pairing = pair();
        const { links } = await rounds(pairing, 3);
        for (const [position, index] of order.entries()) {
          const visitor = position % 2 ? pairing.other : pairing.asking;
          expect((await visitor.browser(links[index]!)).status).toBe(302);
          expect(visitor.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: position === 0 });
        }
        expect(forcedStarts(...pairing.flows)).toBe(1);
        // Live is not reusable: each link is still spent by its own visit.
        for (const link of links) expect((await pairing.other.browser(link)).status).toBe(400);
        expect(forcedStarts(...pairing.flows)).toBe(1);
      }
    });

    it("INV-4 INV-9: separate flows reset separately", async () => {
      const pairing = pair();
      const first = await rounds(pairing, 2);
      const second = await rounds(pairing, 2);
      expect((await pairing.asking.browser(first.links[0]!)).status).toBe(302);
      expect((await pairing.asking.browser(second.links[1]!)).status).toBe(302);
      expect(forcedStarts(...pairing.flows)).toBe(2);
    });

    it("INV-4 INV-9: an unforced prompt's links stay independent and never reset", async () => {
      const flow = setup();
      const plain = { connector: "service" };
      const opening = (await flow.rpc("authorize_connector", plain)).result;
      const next = (await flow.rpc("authorize_connector", plain, { state: opening.requestState, action: "accept" }))
        .result;
      for (const link of [LINK(next), LINK(opening)]) {
        expect((await flow.browser(link)).status).toBe(302);
        expect(flow.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
      }
    });

    it("INV-4 INV-9: a later visitor waits on a pending winner, keeps its link, then continues", async () => {
      const pairing = pair();
      const { links, last } = await rounds(pairing, 2);
      const held = holdNextStart(pairing.asking);
      const winner = pairing.asking.browser(links[0]!);
      await held.entered;
      try {
        const waiting = await pairing.other.browser(links[1]!);
        expect(waiting.status).toBe(409);
        expect(await waiting.json()).toEqual({ error: expect.stringMatching(/Reload this page/) });
        // A second wait is as harmless as the first.
        expect((await pairing.other.browser(links[1]!)).status).toBe(409);
        expect(forcedStarts(...pairing.flows)).toBe(1);
        // Completion cannot claim the old grant while the reset is still running.
        const retried = (
          await pairing.other.rpc("authorize_connector", args, { state: last.requestState, action: "accept" })
        ).result;
        expect(retried.resultType).toBe("input_required");
      } finally {
        held.resume();
      }
      expect((await winner).status).toBe(302);
      expect((await pairing.other.browser(links[1]!)).status).toBe(302);
      expect(pairing.other.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
      expect(forcedStarts(...pairing.flows)).toBe(1);
    });

    it("INV-4 INV-9: a failed winner hands the reset to the next visitor, who starts it afresh", async () => {
      const pairing = pair();
      const { links } = await rounds(pairing, 3);
      vi.mocked(pairing.asking.connector.startAuth!).mockRejectedValueOnce(new Error("Reset failed"));
      expect((await pairing.asking.browser(links[0]!)).status).toBe(400);
      // The failed link is spent; the flow is not. Its other links can recover it.
      expect((await pairing.asking.browser(links[0]!)).status).toBe(400);
      expect((await pairing.other.browser(links[1]!)).status).toBe(302);
      expect(pairing.other.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
      expect((await pairing.asking.browser(links[2]!)).status).toBe(302);
      expect(pairing.asking.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
      // One failed attempt and the one reset that succeeded, never a reset over a live attempt.
      expect(forcedStarts(...pairing.flows)).toBe(2);
    });

    it("INV-4 INV-9: visitors waiting on a winner that fails can recover it without a new link", async () => {
      const pairing = pair();
      const { links } = await rounds(pairing, 2);
      const held = holdNextStart(pairing.asking, new Error("Reset failed"));
      const winner = pairing.asking.browser(links[0]!);
      await held.entered;
      try {
        expect((await pairing.other.browser(links[1]!)).status).toBe(409);
      } finally {
        held.resume();
      }
      expect((await winner).status).toBe(400);
      expect((await pairing.other.browser(links[1]!)).status).toBe(302);
      expect(pairing.other.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: true });
    });

    it("INV-4 INV-9: a claim whose process died names the way out, and a fresh request recovers", async () => {
      const flow = setup();
      flow.connect();
      const first = (await flow.rpc("authorize_connector", args)).result;
      const late = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" }))
        .result;
      // Exactly the storage a killed start leaves: claimed, never settled.
      const opts = { config: { vault: flow.vault }, registry: flow.app.registry } as unknown as Parameters<
        typeof verifyOAuthHandoff
      >[0];
      const handoff = await verifyOAuthHandoff(opts, BASE, "service", new URL(LINK(first)).searchParams.get("h"));
      expect(await claimOAuthConnectStart(opts, required(handoff ?? undefined))).toBe("reset");
      const stuck = await flow.browser(LINK(late));
      expect(stuck.status).toBe(409);
      expect(await stuck.json()).toEqual({
        error: expect.stringMatching(/Reload this page in a moment.*start a new connection request/s),
      });
      expect(flow.connector.startAuth).not.toHaveBeenCalled();
      const recovery = (await flow.rpc("authorize_connector", args)).result;
      expect((await flow.browser(LINK(recovery))).status).toBe(302);
      expect(flow.connector.startAuth).toHaveBeenCalledExactlyOnceWith(expect.anything(), { force: true });
    });

    it("INV-4 INV-9: a reset's record outlives the link that claimed it, so a later round's link cannot repeat it", async () => {
      const pairing = pair();
      const { links, last } = await rounds(pairing, 1);
      const start = Date.now();
      const now = vi.spyOn(Date, "now");
      // Round two arrives at the end of the retry window, just before the first link expires.
      now.mockReturnValue(start + 9 * 60_000);
      const next = (
        await pairing.other.rpc("authorize_connector", args, { state: last.requestState, action: "accept" })
      ).result;
      now.mockReturnValue(start + 14 * 60_000);
      expect((await pairing.asking.browser(links[0]!)).status).toBe(302);
      now.mockReturnValue(start + 20 * 60_000);
      expect((await pairing.other.browser(LINK(next))).status).toBe(302);
      expect(forcedStarts(...pairing.flows)).toBe(1);
    });

    it("INV-4 INV-9: a later link during the completion status check cannot reset or strand the flow", async () => {
      const pairing = pair();
      const { asking, other } = pairing;
      const { links, last } = await rounds(pairing, 2);
      expect((await asking.browser(links[0]!)).status).toBe(302);
      expect(forcedStarts(asking, other)).toBe(1);
      let resume!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const checking = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(other.connector, "status").mockImplementationOnce(async () => {
        entered();
        await paused;
        return { state: "ok" };
      });
      const retry = other.rpc("authorize_connector", args, { state: last.requestState, action: "accept" });
      await checking;
      try {
        expect((await asking.browser(links[1]!)).status).toBe(302);
        expect(asking.connector.startAuth).toHaveBeenLastCalledWith(expect.anything(), { force: false });
        expect(forcedStarts(asking, other)).toBe(1);
      } finally {
        resume();
      }
      expect((await retry).result.structuredContent).toEqual({ connector: "service", status: "ok" });
    });

    it(
      "INV-4 INV-7 INV-9: concurrent visitors race the claim on real SQLite connections with one reset per flow",
      { timeout: 60_000 },
      async () => {
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { openSqlite, sqliteStorage } = await import("../src/sqlite.js");
        const directory = mkdtempSync(join(tmpdir(), "connecta-forced-link-"));
        const databases = [openSqlite(join(directory, "shared.db")), openSqlite(join(directory, "shared.db"))];
        try {
          const stores = databases.map((database) => sqliteStorage(database));
          const [first, second] = stores.map((storage) => setup({ storage }));
          // node:sqlite answers synchronously, so visitors would otherwise run one after another.
          // Hold each racing visitor at its read until all have read, so they meet at the claim.
          let racers = 0;
          let arrive = () => {};
          const met = () => new Promise<void>((resolve) => (arrive = resolve));
          let meeting = met();
          for (const store of stores) {
            const get = store.get.bind(store);
            vi.spyOn(store, "get").mockImplementation(async (key) => {
              const value = await get(key);
              if (racers > 0 && key.includes("oauth:connect-reset:")) {
                if (--racers === 0) arrive();
                await meeting;
              }
              return value;
            });
          }
          first!.connect();
          second!.connect();
          const pairing = { asking: first!, other: second!, flows: [first!, second!] as const };
          for (let trial = 0; trial < 24; trial++) {
            vi.mocked(first!.connector.startAuth!).mockClear();
            vi.mocked(second!.connector.startAuth!).mockClear();
            const { links } = await rounds(pairing, 3);
            racers = links.length;
            meeting = met();
            const visits = await Promise.all(links.map((link, index) => (index % 2 ? second! : first!).browser(link)));
            const statuses = visits.map((visit) => visit.status);
            expect(statuses).toContain(302);
            for (const status of statuses) expect([302, 409]).toContain(status);
            // A visitor told to wait reloads and continues the same attempt.
            for (const [index, status] of statuses.entries())
              if (status === 409) expect((await second!.browser(links[index]!)).status).toBe(302);
            expect(forcedStarts(first!, second!)).toBe(1);
          }
        } finally {
          await Promise.all(apps.splice(0).map((app) => app.close()));
          for (const database of databases) database.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  });

  describe("a legacy link carrying the retired predecessor field", () => {
    /** A pre-upgrade signed JSON or sealed v2 link, exactly as an older deployment minted it. */
    const legacyLink = async (flow: ReturnType<typeof setup>, format: string, fields: Record<string, unknown> = {}) => {
      const json = JSON.stringify({
        connector: "service",
        owner: "shared",
        principal: await identityStorageKey({ namespace: "https://clerk.example.test", id: "alice" }),
        origin: BASE,
        expiresAt: Date.now() + 15 * 60_000,
        nonce: crypto.randomUUID(),
        force: false,
        ...fields,
      });
      const payload =
        format === "json"
          ? btoa(json)
          : `v2:${btoa(await flow.vault.seal!("service", "connecta:connect-link:v2", json))}`;
      const url = new URL(`${BASE}/connect/service`);
      url.searchParams.set("h", `${payload}.${await flow.vault.signOAuthHandoff!(payload)}`);
      return url.href;
    };

    it.each([
      ["json", "never visited", null],
      ["json", "still pending", "used"],
      ["json", "failed", "failed"],
      ["json", "started", "started"],
      ["v2", "never visited", null],
      ["v2", "still pending", "used"],
      ["v2", "failed", "failed"],
      ["v2", "started", "started"],
    ])(
      "INV-4 INV-9: a %s Continue link whose predecessor %s is refused and starts nothing",
      async (format, _name, stage) => {
        const flow = setup();
        flow.connect();
        const after = crypto.randomUUID();
        if (stage) await flow.app.registry.contextFor("service", BASE).storage.set(oauthConnectKeys.used(after), stage);
        const response = await flow.browser(await legacyLink(flow, format, { after }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "Invalid or expired connection link. Request a new link from connecta.",
        });
        expect(flow.connector.startAuth).not.toHaveBeenCalled();
      },
    );

    it.each(["json", "v2"])(
      "INV-4: a %s link without that field still works until its original expiry",
      async (format) => {
        const flow = setup();
        expect((await flow.browser(await legacyLink(flow, format))).status).toBe(302);
        expect(flow.connector.startAuth).toHaveBeenCalledExactlyOnceWith(expect.anything(), { force: false });
      },
    );
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

  it("INV-4 INV-5 INV-9: no link can reuse the old grant when the forced start fails", async () => {
    const flow = setup();
    flow.connect();
    const held = holdNextStart(flow, new Error("Reset failed before changing the old grant"));
    const args = { connector: "service", force: true };
    const first = (await flow.rpc("authorize_connector", args)).result;
    const browser = flow.browser(first.inputRequests.connecta_auth.params.url);
    await held.entered;
    let pending;
    try {
      pending = (await flow.rpc("authorize_connector", args, { state: first.requestState, action: "accept" })).result;
      expect(pending.resultType).toBe("input_required");
      expect((await flow.browser(pending.inputRequests.connecta_auth.params.url)).status).toBe(409);
    } finally {
      held.resume();
    }
    expect((await browser).status).toBe(400);
    expect(flow.connector.startAuth).toHaveBeenCalledOnce();
    // Nothing completes against the old grant; the next round's prompt and the waiting link both restart.
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
