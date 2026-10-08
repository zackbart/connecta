import { afterEach, describe, expect, it, vi } from "vitest";
import { inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, required } from "./helpers.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { guestErrorText, guestFailureFacts, spyLogger } from "./fixtures/misc.js";
import { operatorUi } from "../src/ui.js";
import { activityHistory } from "../src/activity.js";
import { inputRetryKeys, resultKeys, scopes } from "../src/storage/keys.js";

const BASE = "https://connecta.test";
const OPAQUE = "DOWNSTREAM_OPAQUE_STATE";
const SECRET = "relay-test-credential-9a38c";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(options: { repeat?: boolean; key?: string; url?: string; message?: string; raw?: Record<string, unknown>; vault?: boolean; output?: boolean; invalidOutput?: boolean; authFirst?: boolean; programWrite?: boolean; failContinuationAuth?: boolean; opaque?: string; completeText?: string; completeStructured?: Record<string, unknown>; roundStates?: string[]; continuationMessage?: string; completeError?: boolean } = {}) {
  const storage = memoryStorage();
  const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
  const logs: unknown[] = [];
  const { logger } = spyLogger();
  for (const method of ["debug", "info", "warn", "error"] as const) logger[method] = (...args) => { logs.push(args); };
  const activity = { record: vi.fn(async () => {}) };
  const key = options.key ?? "question";
  const call = vi.fn();
  const requests: Record<string, any>[] = [];
  const downstream = httpDownstream(server => {
    for (const [name, read] of [["read", true], ["write", false]] as const) {
      server.registerTool(name, {
        inputSchema: z.object({ id: z.number().optional() }),
        ...(options.output ? { outputSchema: z.object({ done: z.boolean() }) } : {}),
        annotations: { readOnlyHint: read },
      }, async (args, context) => {
        const state = context.mcpReq.requestState();
        const responses = context.mcpReq.inputResponses;
        call(name, args, state, responses);
        const round = state === undefined ? 0 : (options.roundStates?.indexOf(typeof state === "string" ? state : "") ?? 0) + 1;
        if (state && !options.repeat && (!options.roundStates || round >= options.roundStates.length)) return {
          content: [{ type: "text", text: options.completeText ?? JSON.stringify({ done: true, responses }) }],
          structuredContent: options.completeStructured ?? (options.output ? { done: true } : { done: true, responses }),
          ...(options.completeError ? { isError: true } : {}),
        };
        return inputRequired({ requestState: options.roundStates?.[round] ?? options.opaque ?? OPAQUE,
          inputRequests: { [key]: options.url
            ? inputRequired.elicitUrl({ message: options.message ?? "Open this page", url: options.url })
            : inputRequired.elicit({ message: (state ? options.continuationMessage : undefined) ?? options.message ?? "Pick a name", requestedSchema: { type: "object", properties: { name: { type: "string" } } } }) },
        });
      });
    }
  }, { capture: async request => { if (request.method === "POST") requests.push(await request.json()); } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
    if (options.failContinuationAuth && request?.method === "tools/call" && request.params.requestState !== undefined) return new Response(null, { status: 401 });
    const reply = await downstream.fetch(input as string, init);
    if (options.invalidOutput && request?.method === "tools/call" && request.params.requestState !== undefined) {
      await reply.body?.cancel();
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { resultType: "complete", content: [{ type: "text", text: "bad" }], structuredContent: { done: "bad" } } });
    }
    if (!options.raw || init?.method !== "POST") return reply;
    if (request.method !== "tools/call") return reply;
    if (!options.repeat && request.params.requestState !== undefined) return reply;
    await reply.body?.cancel();
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { resultType: "input_required", ...options.raw } });
  });
  const connector = remoteMcp("service", { url: downstream.url, auth: options.authFirst ? { type: "credential" } : { type: "headers", headers: { Authorization: `Bearer ${SECRET}` } }, logger });
  const app = createTestConnecta({
    connectors: [connector], storage, logger,
    publicUrl: BASE, ...(options.vault === false ? {} : { vault }),
    auth: ["alice", "bob"].map(user => fakeClerkAuth({ token: user, userId: user })),
    identity: { credentialAdministration: () => options.authFirst ? "all" : "none" },
    ...(options.authFirst ? { ui: operatorUi() } : {}),
    activity: activityHistory({ store: activity }),
    pools: { trusted: { tools: ["service"], grant: () => true, trust: "trusted" } },
    executor: { execute: async (_code, providers) => {
      try {
        const result = await required(providers.find(p => p.name === "connecta")).fns.call!(options.programWrite ? "service.write" : "service.read", { id: 1 });
        return { result };
      } catch (error) { return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) }; }
    } },
  });
  apps.push(app);
  const rpc = async (opts: { name?: string; args?: Record<string, unknown>; state?: string; responses?: Record<string, unknown>; capabilities?: Record<string, unknown>; user?: string; pool?: string; legacy?: boolean } = {}) => {
    const name = opts.name ?? "call_tool";
    const args = opts.args ?? { address: "service.read", args: { id: 1 } };
    const request = mcpRpc("tools/call", { name, arguments: args,
      ...(opts.state === undefined ? {} : { requestState: opts.state }),
      ...(opts.responses === undefined ? {} : { inputResponses: opts.responses }),
      ...(opts.legacy ? {} : { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "relay-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": opts.capabilities ?? { elicitation: { form: {}, url: {} } },
      } }),
    });
    if (!opts.legacy) {
      request.headers.set("MCP-Protocol-Version", "2026-07-28");
      request.headers.set("Mcp-Method", "tools/call");
      request.headers.set("Mcp-Name", name);
      if (typeof args.address === "string") request.headers.set("Mcp-Param-Address", args.address);
    }
    request.headers.set("Authorization", `Bearer ${opts.user ?? "alice"}`);
    return readJsonRpc(await app.fetch(opts.pool ? new Request(`${BASE}/mcp/${opts.pool}`, request) : request));
  };
  return { rpc, call, requests, logs, activity, storage, vault };
}

describe("downstream input relay", () => {
  it("INV-2 INV-4 INV-5 INV-9: relays accept, decline, and cancel as bound read and write continuations", async () => {
    for (const write of [false, true]) for (const action of ["accept", "decline", "cancel"]) {
      const flow = setup();
      const opts = write ? { name: "call_destructive_tool", args: { address: "service.write", args: { id: 1 } } } : {};
      const first = (await flow.rpc(opts)).result;
      expect(first.resultType).toBe("input_required");
      expect(JSON.stringify(first)).not.toContain(OPAQUE);
      expect(atob(first.requestState.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain(OPAQUE);
      const key = Object.keys(first.inputRequests)[0]!;
      const response = { action, ...(action === "accept" ? { content: { name: "Ada" } } : {}) };
      const retry = (await flow.rpc({ ...opts, state: first.requestState, responses: { [key]: response } })).result;
      expect(retry.isError).toBeFalsy();
      expect(flow.call).toHaveBeenLastCalledWith(write ? "write" : "read", { id: 1 }, OPAQUE, { question: response });
      expect(flow.call).toHaveBeenCalledTimes(2);
    }
  });

  it("INV-4: namespaces downstream connecta keys and ignores unrelated input responses", async () => {
    const flow = setup({ key: "connecta_auth" });
    const first = (await flow.rpc()).result;
    const key = Object.keys(first.inputRequests)[0]!;
    expect(key).toBe("downstream/service/0");
    await flow.rpc({ state: first.requestState, responses: { connecta_auth: { action: "cancel" }, [key]: { action: "accept" } } });
    expect(flow.call).toHaveBeenLastCalledWith("read", { id: 1 }, OPAQUE, { connecta_auth: { action: "accept" } });
  });

  it("INV-4 INV-5 INV-9: rejects tamper, replay, concurrent forks, cross-principal, cross-pool, and expiry", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    const responses = { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } };
    for (const opts of [{ state: `${first.requestState}x` }, { state: first.requestState, user: "bob" }, { state: first.requestState, pool: "trusted" }]) {
      expect((await flow.rpc({ ...opts, responses })).error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
    }
    const forks = await Promise.all([flow.rpc({ state: first.requestState, responses }), flow.rpc({ state: first.requestState, responses })]);
    expect(forks.filter(reply => reply.result?.isError !== true && !reply.error)).toHaveLength(1);
    expect(flow.call).toHaveBeenCalledTimes(2);
    const next = (await flow.rpc()).result;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect((await flow.rpc({ state: next.requestState, responses })).error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
    expect(flow.call).toHaveBeenCalledTimes(3);
  });

  it("INV-2 INV-4 INV-9: refuses changed write arguments, address, and meta-tool before continuation dispatch", async () => {
    const flow = setup();
    const opts = { name: "call_destructive_tool", args: { address: "service.write", args: { id: 1 } } };
    const first = (await flow.rpc(opts)).result;
    for (const change of [
      { args: { address: "service.write", args: { id: 2 } } },
      { args: { address: "service.read", args: { id: 1 } } },
      { name: "call_tool" },
    ]) {
      const retry = await flow.rpc({ ...opts, ...change, state: first.requestState, responses: { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } } });
      expect(retry.error ?? retry.result.structuredContent.error).toBeDefined();
    }
    expect(flow.call).toHaveBeenCalledOnce();
  });

  it("INV-4 INV-9: bounds downstream rounds and preserves the original expiry", async () => {
    const flow = setup({ repeat: true });
    let result = (await flow.rpc()).result;
    const open = async (wire: string) => {
      const wrapper = JSON.parse(atob(wire.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).p;
      return JSON.parse(await flow.vault.open!("service", "connecta:downstream-input:v1", wrapper.sealed));
    };
    const initial = await open(result.requestState);
    for (let round = 1; round < 3; round++) {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      result = (await flow.rpc({ state: result.requestState, responses: { [Object.keys(result.inputRequests)[0]!]: { action: "accept" } } })).result;
      expect(result.resultType).toBe("input_required");
      expect((await open(result.requestState)).expiresAt).toBe(initial.expiresAt);
    }
    result = (await flow.rpc({ state: result.requestState, responses: { [Object.keys(result.inputRequests)[0]!]: { action: "accept" } } })).result;
    expect(result.structuredContent.error.code).toBe("input_required_round_limit");
    expect(flow.call).toHaveBeenCalledTimes(4);
  });

  it("INV-2 INV-4: programs retain input_required_unsupported with the equivalent direct call", async () => {
    for (const write of [false, true]) {
      const flow = setup({ programWrite: write });
      const result = (await flow.rpc({ name: "execute_code", pool: "trusted", args: { code: `return await connecta.call('service.${write ? "write" : "read"}', { id: 1 });` } })).result;
      expect(result.structuredContent.error).toMatchObject({ code: "input_required_unsupported", nextAction: { tool: write ? "call_destructive_tool" : "call_tool", arguments: { address: `service.${write ? "write" : "read"}`, args: { id: 1 } } } });
      expect(JSON.stringify(result)).not.toContain(OPAQUE);
      expect(JSON.stringify(result)).not.toContain("Pick a name");
    }
  });

  it("INV-4: refuses undeclared kinds, malformed requests, and excessive payloads with typed errors", async () => {
    for (const [raw, capabilities, code] of [
      [{ requestState: OPAQUE, inputRequests: { k: { method: "elicitation/create", params: { mode: "url", message: "open", url: "https://downstream.test/approve" } } } }, { elicitation: { form: {} } }, "input_required_unsupported"],
      [{ requestState: OPAQUE, inputRequests: { k: { method: "roots/list" } } }, { roots: {} }, "input_required_unsupported"],
      [{ requestState: OPAQUE, inputRequests: { k: { method: "elicitation/create", params: { mode: "form", message: 3 } } } }, { elicitation: { form: {} } }, "input_required_invalid"],
      [{ requestState: "x".repeat(70_000) }, {}, "input_required_limit"],
      [{ requestState: OPAQUE, inputRequests: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i), { method: "elicitation/create", params: { mode: "url", message: "Open", url: "https://downstream.test/approve" } }])) }, { elicitation: { url: {} } }, "input_required_limit"],
    ] as const) {
      const flow = setup({ raw });
      const result = (await flow.rpc({ capabilities })).result;
      expect(result.resultType).not.toBe("input_required");
      expect(result.structuredContent.error).toMatchObject({ code, retryable: false });
    }
  });

  it("INV-4 INV-5: forwards HTTPS URLs as downstream-provided and refuses unsafe or credential-bearing URLs", async () => {
    const flow = setup({ url: "https://downstream.test/approve?nonce=123" });
    const first = (await flow.rpc()).result;
    const params = first.inputRequests[Object.keys(first.inputRequests)[0]!].params;
    expect(params.url).toBe("https://downstream.test/approve?nonce=123");
    expect(params.message).toContain("Downstream service:");
    for (const url of ["http://downstream.test/approve", "https://user:pass@downstream.test/approve", `https://downstream.test/approve?token=${SECRET}`,
      "https://downstream.test/approve?nonce=ok\nauthorization: ordinary-approval-id"]) {
      const invalid = setup({ url });
      const result = (await invalid.rpc()).result;
      expect(result.structuredContent, JSON.stringify(result)).toBeDefined();
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
    }
  });

  it("INV-4 INV-5 INV-6: refuses opaque-state echoes in prompts and completed continuation output", async () => {
    for (const [opaque, message] of [[OPAQUE, `Confirm ${OPAQUE}`], [OPAQUE, `Confirm ${btoa(OPAQUE)}`],
      ["private state", "Confirm private%20state"], ["q7z", "Confirm q7z"], ["[redacted]", "Confirm [redacted]"]] as const) {
      const flow = setup({ opaque, message });
      const result = (await flow.rpc()).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(message);
      expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(message);
      expect(flow.call).toHaveBeenCalledOnce();
    }
    for (const params of [
      { mode: "url", message: "Open", url: `https://downstream.test/approve?state=${OPAQUE}` },
      { mode: "form", message: "Confirm", requestedSchema: { type: "object", properties: { [OPAQUE]: { type: "string" } } } },
    ]) {
      const flow = setup({ raw: { requestState: OPAQUE, inputRequests: { k: { method: "elicitation/create", params } } } });
      const result = (await flow.rpc()).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(OPAQUE);
    }
    const flow = setup({ completeText: `Completed with state ${OPAQUE}` });
    const first = (await flow.rpc()).result;
    const final = (await flow.rpc({ state: first.requestState, responses: { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } } })).result;
    expect(final.structuredContent.error.code).toBe("input_required_invalid");
    expect(JSON.stringify(final)).not.toContain(OPAQUE);
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-5: refuses form schemas that redaction would change instead of changing the answer contract", async () => {
    for (const requestedSchema of [
      { type: "object", properties: { [SECRET]: { type: "string" } }, required: [SECRET] },
      { type: "object", properties: { name: { type: "string", enum: [SECRET] } } },
      { type: "object", properties: { name: { type: "string", description: SECRET } } },
    ]) {
      const flow = setup({ raw: { requestState: OPAQUE, inputRequests: { k: {
        method: "elicitation/create", params: { mode: "form", message: "Confirm", requestedSchema },
      } } } });
      const result = (await flow.rpc()).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.requestState).toBeUndefined();
      expect(flow.call).toHaveBeenCalledOnce();
    }
  });

  it("INV-4 INV-5 INV-6: rejects private state before paging, schema observation, or downstream error shaping", async () => {
    for (const opts of [
      { completeText: `${"x".repeat(25_000)}${OPAQUE}` },
      { completeStructured: { [OPAQUE]: true } },
      { completeText: `Downstream error ${OPAQUE}`, completeError: true },
    ]) {
      const flow = setup(opts);
      const first = (await flow.rpc()).result;
      const result = (await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(OPAQUE);
      const keys = await flow.storage.list("");
      expect(keys.filter(key => key.includes(resultKeys.family.prefixes[0]))).toHaveLength(0);
      for (const key of keys) expect(await flow.storage.get(key)).not.toContain(OPAQUE);
      const search = await flow.rpc({ name: "search_tools", args: { query: "service.read" }, user: "bob" });
      expect(search.result.isError).toBeFalsy();
      expect(JSON.stringify(search)).not.toContain(OPAQUE);
      expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(OPAQUE);
    }
  });

  it("INV-4 INV-5 INV-9: retains bounded encrypted private state history across different downstream rounds", async () => {
    const states = ["PRIVATE_FIRST_ROUND_STATE", "PRIVATE_SECOND_ROUND_STATE"];
    for (const opts of [{ completeText: `Completed with ${states[0]}` }, { continuationMessage: `Confirm ${states[0]}` }]) {
      const flow = setup({ roundStates: states, ...opts });
      const first = (await flow.rpc()).result;
      let result = (await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
      if (!opts.continuationMessage) {
        expect(result.resultType).toBe("input_required");
        const wrapper = JSON.parse(atob(result.requestState.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).p;
        expect(JSON.stringify(wrapper)).not.toContain(states[0]);
        const privateState = JSON.parse(await flow.vault.open!("service", "connecta:downstream-input:v1", wrapper.sealed));
        expect(privateState.previousStates).toEqual([states[0]]);
        result = (await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
      }
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(states[0]);
      expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(states[0]);
    }
    const flow = setup({ roundStates: ["a".repeat(30_000), "b".repeat(40_000)] });
    const first = (await flow.rpc()).result;
    expect(first.resultType, JSON.stringify(first)).toBe("input_required");
    const result = (await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
    expect(result.structuredContent.error.code).toBe("input_required_limit");
    expect(result.requestState).toBeUndefined();
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-5 INV-6: redacts sent credential echoes in elicitation through the agent boundary without operator payloads", async () => {
    const flow = setup({ message: `Please confirm ${SECRET}` });
    const first = (await flow.rpc()).result;
    expect(first.resultType).toBe("input_required");
    expect(JSON.stringify(first)).toContain("[redacted]");
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(flow.activity.record).toHaveBeenCalled();
    expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain("Please confirm");
    expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(OPAQUE);
    expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(SECRET);
  });

  it("INV-4 INV-5: preserves opaque state containing a sent credential and keeps downstream keys private", async () => {
    const opaque = `${OPAQUE}:${SECRET}`;
    const flow = setup({ opaque, key: SECRET });
    const first = (await flow.rpc()).result;
    expect(JSON.stringify(first)).not.toContain(SECRET);
    await flow.rpc({ state: first.requestState, responses: { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } } });
    expect(flow.call).toHaveBeenLastCalledWith("read", { id: 1 }, opaque, { [SECRET]: { action: "accept" } });
  });

  it("INV-4 INV-9: validates input responses and capabilities before consuming a continuation", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    const key = Object.keys(first.inputRequests)[0]!;
    for (const response of [{ action: "invalid" }, { action: "accept", content: { name: {} } }, { action: "accept", content: { name: "x".repeat(70_000) } }]) {
      const retry = await flow.rpc({ state: first.requestState, responses: { [key]: response } });
      expect(retry.result?.isError ?? Boolean(retry.error)).toBe(true);
    }
    const incapable = (await flow.rpc({ state: first.requestState, capabilities: {}, responses: { [key]: { action: "accept" } } })).result;
    expect(incapable.structuredContent.error.code).toBe("input_required_unsupported");
    expect(flow.call).toHaveBeenCalledOnce();
    expect((await flow.rpc({ state: first.requestState, responses: { [key]: { action: "accept" } } })).result.isError).toBeFalsy();
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-9: auth-to-downstream composition shares its round bound and never confuses input keys", async () => {
    const flow = setup({ authFirst: true, repeat: true });
    const first = (await flow.rpc()).result;
    expect(Object.keys(first.inputRequests)).toEqual(["connecta_auth"]);
    await flow.vault.set("service", SECRET, "alice");
    let result = (await flow.rpc({ state: first.requestState, responses: { connecta_auth: { action: "accept" } } })).result;
    expect(Object.keys(result.inputRequests)).toEqual(["downstream/service/0"]);
    result = (await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
    expect(result.resultType).toBe("input_required");
    result = (await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
    expect(result.structuredContent.error.code).toBe("input_required_round_limit");
    expect(flow.call).toHaveBeenCalledTimes(3);
  });

  it("INV-9: an auth failure during a write continuation cannot create an auth replay or reuse the nonce", async () => {
    const flow = setup({ failContinuationAuth: true });
    const opts = { name: "call_destructive_tool", args: { address: "service.write", args: { id: 1 } } };
    const first = (await flow.rpc(opts)).result;
    const retryOpts = { ...opts, state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } };
    const result = (await flow.rpc(retryOpts)).result;
    expect(result.resultType).not.toBe("input_required");
    expect(result.structuredContent.error).toMatchObject({ code: "auth_required", reconciliationRequired: true });
    expect((await flow.rpc(retryOpts)).result.isError).toBe(true);
    expect(flow.call).toHaveBeenCalledOnce();
  });

  it("INV-4: handles state-only downstream rounds and refuses relay without a sealing vault or modern protocol", async () => {
    const flow = setup({ raw: { requestState: OPAQUE } });
    const first = (await flow.rpc()).result;
    expect(first.resultType).toBe("input_required");
    expect(first.inputRequests).toBeUndefined();
    await flow.rpc({ state: first.requestState });
    expect(flow.call).toHaveBeenLastCalledWith("read", { id: 1 }, OPAQUE, {});
    for (const opts of [{ vault: false }, {}]) {
      const blocked = setup({ ...opts, raw: { requestState: OPAQUE } });
      const result = (await blocked.rpc(opts.vault === false ? {} : { legacy: true })).result;
      expect(result.structuredContent.error.code).toBe("input_required_unsupported");
    }
  });

  it("INV-4 INV-9: records only a TTL-bound retry nonce without downstream payload in storage", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept", content: { name: "INPUT_PRIVATE_TEXT" } } } });
    const entries = await flow.storage.list(`${scopes.connector("service")}${inputRetryKeys.family.prefixes[0]}`);
    expect(entries).toHaveLength(1);
    expect(await flow.storage.get(entries[0]!)).toBe("used");
  });

  it("INV-4: validates final output schemas while allowing input-required suspensions", async () => {
    for (const invalidOutput of [false, true]) {
      const flow = setup({ output: true, invalidOutput });
      const first = (await flow.rpc()).result;
      expect(first.resultType).toBe("input_required");
      const result = (await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })).result;
      expect(result.isError === true).toBe(invalidOutput);
      if (invalidOutput) expect(result.structuredContent.error.code).toBe("invalid_args");
    }
  });
});
