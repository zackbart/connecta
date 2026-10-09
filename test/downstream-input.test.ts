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
import { connectorContext, guestErrorText, guestFailureFacts, spyLogger } from "./fixtures/misc.js";
import { operatorUi } from "../src/ui.js";
import { activityHistory } from "../src/activity.js";
import { inputRetryKeys, negotiationKeys, resultKeys, scopes } from "../src/storage/keys.js";
import { seedGrant } from "./fixtures/oauth.js";
import { readNegotiation } from "../src/connectors/negotiation-cache.js";
import { bindDownstreamContinuation, clearDownstreamContinuation } from "../src/downstream-input-context.js";
import { privateArgumentCases, PRIVATE_MARKER } from "./fixtures/private-arguments.js";
import type { JsonSchema } from "../src/types.js";

const BASE = "https://connecta.test";
const OPAQUE = "DOWNSTREAM_OPAQUE_STATE";
const SECRET = "relay-test-credential-9a38c";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(
  options: {
    repeat?: boolean;
    key?: string;
    url?: string;
    message?: string;
    raw?: Record<string, unknown>;
    vault?: boolean;
    output?: boolean;
    invalidOutput?: boolean;
    authFirst?: boolean;
    programWrite?: boolean;
    failContinuationAuth?: boolean;
    opaque?: string;
    completeText?: string;
    completeStructured?: Record<string, unknown>;
    roundStates?: string[];
    continuationMessage?: string;
    completeError?: boolean;
    oauth?: boolean;
    failureStatus?: number;
    continuationTimeout?: boolean;
    catalogEcho?: boolean;
    skills?: boolean;
    privateArguments?: "top-level" | "nested" | "array";
    catalogSchema?: JsonSchema;
  } = {},
) {
  const storage = memoryStorage();
  const vault = encryptedCredentialVault(storage, CREDENTIAL_KEY);
  const logs: unknown[] = [];
  const { logger } = spyLogger();
  for (const method of ["debug", "info", "warn", "error"] as const)
    logger[method] = (...args) => {
      logs.push(args);
    };
  const activity = { record: vi.fn(async () => {}) };
  const key = options.key ?? "question";
  const call = vi.fn();
  const continuationSend = vi.fn();
  const completedWrite = vi.fn();
  const tokenRefresh = vi.fn();
  let catalogs = 0;
  const requests: Record<string, any>[] = [];
  const downstream = httpDownstream(
    (server) => {
      for (const [name, read] of [
        ["read", true],
        ["write", false],
      ] as const) {
        server.registerTool(
          name,
          {
            inputSchema: z
              .object({
                id: z.number().optional(),
                ...(options.privateArguments
                  ? {
                      password: (options.privateArguments === "top-level"
                        ? z.string().meta({ writeOnly: true })
                        : options.privateArguments === "nested"
                          ? z.object({ label: z.string(), value: z.string().meta({ writeOnly: true }) })
                          : z.array(z.object({ label: z.string(), value: z.string().meta({ writeOnly: true }) }))
                      ).optional(),
                    }
                  : {}),
              })
              .loose(),
            ...(options.output ? { outputSchema: z.object({ done: z.boolean() }) } : {}),
            annotations: { readOnlyHint: read },
          },
          async (args, context) => {
            const state = context.mcpReq.requestState();
            const responses = context.mcpReq.inputResponses;
            call(name, args, state, responses);
            const round =
              state === undefined ? 0 : (options.roundStates?.indexOf(typeof state === "string" ? state : "") ?? 0) + 1;
            if (state && !options.repeat && (!options.roundStates || round >= options.roundStates.length)) {
              if (!read) completedWrite();
              return {
                content: [{ type: "text", text: options.completeText ?? JSON.stringify({ done: true, responses }) }],
                structuredContent:
                  options.completeStructured ?? (options.output ? { done: true } : { done: true, responses }),
                ...(options.completeError ? { isError: true } : {}),
              };
            }
            return inputRequired({
              requestState: options.roundStates?.[round] ?? options.opaque ?? OPAQUE,
              inputRequests: {
                [key]: options.url
                  ? inputRequired.elicitUrl({ message: options.message ?? "Open this page", url: options.url })
                  : inputRequired.elicit({
                      message: (state ? options.continuationMessage : undefined) ?? options.message ?? "Pick a name",
                      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
                    }),
              },
            });
          },
        );
      }
    },
    {
      ...(options.catalogEcho ? { catalogTtlMs: 0 } : {}),
      capture: async (request) => {
        if (request.method === "POST") requests.push(await request.json());
      },
    },
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      init?.method === "POST" && typeof init.body === "string" && init.body.startsWith("{")
        ? JSON.parse(init.body)
        : undefined;
    const url = String(input);
    if (url.includes("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: downstream.url, authorization_servers: ["https://auth.test"] });
    if (url.includes("https://auth.test/.well-known/"))
      return Response.json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/authorize",
        token_endpoint: "https://auth.test/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url === "https://auth.test/token") {
      tokenRefresh();
      return Response.json({
        access_token: "REFRESHED_ACCESS_CREDENTIAL",
        refresh_token: "REFRESHED_REFRESH_CREDENTIAL",
        token_type: "Bearer",
      });
    }
    if (request?.method === "tools/call" && request.params.inputResponses !== undefined) {
      continuationSend(request);
      if (options.continuationTimeout) {
        const reply = await downstream.fetch(input as string, init);
        await reply.body?.cancel();
        throw new DOMException("PRIVATE_TRANSPORT_TIMEOUT", "TimeoutError");
      }
      if (
        options.failureStatus &&
        new Headers(init?.headers).get("authorization") !== "Bearer REFRESHED_ACCESS_CREDENTIAL"
      ) {
        return new Response(null, {
          status: options.failureStatus,
          headers:
            options.failureStatus === 307
              ? { Location: `${downstream.url}?redirected=true` }
              : {
                  "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"${options.failureStatus === 403 ? ', error="insufficient_scope", scope="changed"' : ""}`,
                },
        });
      }
    }
    if (options.failContinuationAuth && request?.method === "tools/call" && request.params.requestState !== undefined)
      return new Response(null, { status: 401 });
    const reply = await downstream.fetch(input as string, init);
    if (options.catalogSchema && request?.method === "tools/list") {
      const body = (await reply.json()) as { result: { tools: Array<Record<string, unknown>> } };
      for (const tool of body.result.tools) tool.inputSchema = options.catalogSchema;
      return Response.json(body, { status: reply.status, headers: reply.headers });
    }
    if (options.catalogEcho && request?.method === "tools/list" && ++catalogs === 2) {
      const body = (await reply.json()) as { result: { tools: Array<Record<string, unknown>>; ttlMs: number } };
      body.result.tools[0]!.description = OPAQUE;
      body.result.ttlMs = 60_000;
      return Response.json(body);
    }
    if (options.invalidOutput && request?.method === "tools/call" && request.params.requestState !== undefined) {
      await reply.body?.cancel();
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "bad" }],
          structuredContent: { done: "bad" },
        },
      });
    }
    if (!options.raw || init?.method !== "POST") return reply;
    if (request.method !== "tools/call") return reply;
    if (!options.repeat && request.params.requestState !== undefined) return reply;
    await reply.body?.cancel();
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { resultType: "input_required", ...options.raw } });
  });
  const connector = remoteMcp("service", {
    url: downstream.url,
    auth: options.oauth
      ? { type: "oauth" }
      : options.authFirst
        ? { type: "credential" }
        : { type: "headers", headers: { Authorization: `Bearer ${SECRET}` } },
    ...(options.failureStatus === 307 ? { redirects: "same-origin" } : {}),
    ...(options.skills ? { skills: true } : {}),
    logger,
  });
  const app = createTestConnecta({
    connectors: [connector],
    storage,
    logger,
    publicUrl: BASE,
    ...(options.vault === false ? {} : { vault }),
    auth: ["alice", "bob"].map((user) => fakeClerkAuth({ token: user, userId: user })),
    identity: { credentialAdministration: () => (options.authFirst ? "all" : "none") },
    ...(options.authFirst ? { ui: operatorUi() } : {}),
    activity: activityHistory({ store: activity }),
    pools: { trusted: { tools: ["service"], grant: () => true, trust: "trusted" } },
    executor: {
      execute: async (_code, providers) => {
        try {
          const result = await required(providers.find((p) => p.name === "connecta")).fns.call!(
            options.programWrite ? "service.write" : "service.read",
            { id: 1 },
          );
          return { result };
        } catch (error) {
          return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) };
        }
      },
    },
  });
  apps.push(app);
  const rpc = async (
    opts: {
      name?: string;
      args?: Record<string, unknown>;
      state?: string;
      responses?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
      user?: string;
      pool?: string;
      legacy?: boolean;
    } = {},
  ) => {
    const name = opts.name ?? "call_tool";
    const args = opts.args ?? { address: "service.read", args: { id: 1 } };
    const request = mcpRpc("tools/call", {
      name,
      arguments: args,
      ...(opts.state === undefined ? {} : { requestState: opts.state }),
      ...(opts.responses === undefined ? {} : { inputResponses: opts.responses }),
      ...(opts.legacy
        ? {}
        : {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "relay-test", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": opts.capabilities ?? { elicitation: { form: {}, url: {} } },
            },
          }),
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
  return {
    rpc,
    call,
    requests,
    logs,
    activity,
    storage,
    vault,
    continuationSend,
    completedWrite,
    tokenRefresh,
    seedOAuth: () =>
      seedGrant(
        storage,
        {
          issuer: "https://auth.test",
          client: {
            value: {
              client_id: "relay-client",
              redirect_uris: [`${BASE}/oauth/callback/service`],
              token_endpoint_auth_method: "none",
            },
          },
          tokens: { access_token: SECRET, refresh_token: "INITIAL_REFRESH_CREDENTIAL", token_type: "Bearer" },
        },
        "v3:seeded",
        scopes.connector("service"),
      ),
  };
}

describe("downstream input relay", () => {
  for (const { name, schema, args: original, echo } of privateArgumentCases)
    it(`INV-5: continuation failures preserve safe ${name} echoes`, async () => {
      const flow = setup({ catalogSchema: schema, failureStatus: 429 });
      const args = { address: "service.read", args: original };
      const first = (await flow.rpc({ args })).result;
      // Whole-private objects also protect submitted names such as "config".
      // Short private names use the same input-request refusal as short leaves.
      if (
        [
          "root writeOnly",
          "recursive ref",
          "sensitive patternProperties",
          "sensitive additionalProperties ref",
          "conditional sensitivity",
        ].includes(name)
      ) {
        expect(first.isError).toBe(true);
        expect(first.structuredContent.error).toMatchObject({ code: "input_required_unsupported", retryable: false });
        expect(first.requestState).toBeUndefined();
        expect(JSON.stringify(first)).not.toContain(PRIVATE_MARKER);
        expect(flow.continuationSend).not.toHaveBeenCalled();
        return;
      }
      const result = (
        await flow.rpc({ args, state: first.requestState, responses: { question: { action: "accept" } } })
      ).result;
      expect(result.isError).toBe(true);
      const error = result.structuredContent.error;
      expect(error).toMatchObject({
        code: "rate_limited",
        retryable: false,
        nextAction: { tool: "call_tool", arguments: { address: "service.read", ...echo } },
      });
      expect(error.nextAction.arguments).toEqual({ address: "service.read", ...echo });
      expect(error.nextAction.purpose).toContain("original arguments");
      expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(flow.continuationSend).toHaveBeenCalledOnce();
    });
  it.each([
    ["top-level", "private-value".repeat(100), undefined],
    ["nested", { label: "db", value: "private-marker-12345" }, { label: "db" }],
    ["array", [{ label: "db", value: "private-marker-12345" }], [{ label: "db" }]],
  ] as const)(
    "INV-5: continuation retry hints omit %s writeOnly arguments",
    async (privateArguments, password, safePassword) => {
      const flow = setup({ privateArguments, failureStatus: 429 });
      const args = { address: "service.read", args: { id: 1, password } };
      const first = (await flow.rpc({ args })).result;
      const result = (
        await flow.rpc({
          args,
          state: first.requestState,
          responses: { question: { action: "accept" } },
        })
      ).result;
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: "rate_limited",
        nextAction: {
          tool: "call_tool",
          arguments: {
            address: "service.read",
            args: { id: 1, ...(safePassword ? { password: safePassword } : {}) },
            argsRedacted: true,
          },
        },
      });
      expect(result.structuredContent.error.nextAction.arguments.args).toEqual({
        id: 1,
        ...(safePassword ? { password: safePassword } : {}),
      });
      expect(JSON.stringify(result)).not.toContain("private-marker-12345");
      expect(result.structuredContent.error.nextAction.purpose).toContain("original arguments");
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(flow.continuationSend).toHaveBeenCalledOnce();
    },
  );
  it("INV-5: short writeOnly arguments withhold downstream input requests", async () => {
    const flow = setup({ privateArguments: "top-level", message: "Downstream quoted z", failureStatus: 429 });
    const result = (await flow.rpc({ args: { address: "service.read", args: { id: 1, password: "z" } } })).result;
    expect(result.isError).toBe(true);
    expect(result.requestState).toBeUndefined();
    expect(result.inputRequests).toBeUndefined();
    expect(result.structuredContent.error).toMatchObject({
      code: "input_required_unsupported",
      message: expect.stringContaining("detail withheld"),
    });
    expect(JSON.stringify(result)).not.toContain("Downstream quoted");
    expect(flow.call).toHaveBeenCalledOnce();
    expect(flow.continuationSend).not.toHaveBeenCalled();
  });
  it("INV-2 INV-4 INV-5 INV-9: relays accept, decline, and cancel as bound read and write continuations", async () => {
    for (const write of [false, true])
      for (const action of ["accept", "decline", "cancel"]) {
        const flow = setup();
        const opts = write
          ? { name: "call_destructive_tool", args: { address: "service.write", args: { id: 1 } } }
          : {};
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

  it("INV-4 INV-10: composes request-bound elicitation modes with downstream Skills capabilities", async () => {
    const flow = setup({ skills: true });
    const first = (await flow.rpc({ capabilities: { elicitation: { form: {} } } })).result;
    expect(first.resultType).toBe("input_required");
    expect(
      (
        await flow.rpc({
          state: first.requestState,
          responses: { "downstream/service/0": { action: "accept" } },
          capabilities: { elicitation: { form: {} } },
        })
      ).result.isError,
    ).toBeFalsy();
    for (const request of flow.requests.filter((request) => request.method === "tools/call")) {
      expect(request.params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
        elicitation: { form: {} },
        extensions: { "io.modelcontextprotocol/skills": {} },
      });
    }
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4: namespaces downstream connecta keys and ignores unrelated input responses", async () => {
    const flow = setup({ key: "connecta_auth" });
    const first = (await flow.rpc()).result;
    const key = Object.keys(first.inputRequests)[0]!;
    expect(key).toBe("downstream/service/0");
    await flow.rpc({
      state: first.requestState,
      responses: { connecta_auth: { action: "cancel" }, [key]: { action: "accept" } },
    });
    expect(flow.call).toHaveBeenLastCalledWith("read", { id: 1 }, OPAQUE, { connecta_auth: { action: "accept" } });
  });

  it("INV-4 INV-5 INV-9: rejects tamper, replay, concurrent forks, cross-principal, cross-pool, and expiry", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    const responses = { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } };
    for (const opts of [
      { state: `${first.requestState}x` },
      { state: first.requestState, user: "bob" },
      { state: first.requestState, pool: "trusted" },
    ]) {
      expect((await flow.rpc({ ...opts, responses })).error).toMatchObject({
        code: -32602,
        data: { reason: "invalid_request_state" },
      });
    }
    const forks = await Promise.all([
      flow.rpc({ state: first.requestState, responses }),
      flow.rpc({ state: first.requestState, responses }),
    ]);
    expect(forks.filter((reply) => reply.result?.isError !== true && !reply.error)).toHaveLength(1);
    expect(flow.call).toHaveBeenCalledTimes(2);
    const next = (await flow.rpc()).result;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    expect((await flow.rpc({ state: next.requestState, responses })).error).toMatchObject({
      code: -32602,
      data: { reason: "invalid_request_state" },
    });
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
      const retry = await flow.rpc({
        ...opts,
        ...change,
        state: first.requestState,
        responses: { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } },
      });
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
      result = (
        await flow.rpc({
          state: result.requestState,
          responses: { [Object.keys(result.inputRequests)[0]!]: { action: "accept" } },
        })
      ).result;
      expect(result.resultType).toBe("input_required");
      expect((await open(result.requestState)).expiresAt).toBe(initial.expiresAt);
    }
    result = (
      await flow.rpc({
        state: result.requestState,
        responses: { [Object.keys(result.inputRequests)[0]!]: { action: "accept" } },
      })
    ).result;
    expect(result.structuredContent.error.code).toBe("input_required_round_limit");
    expect(flow.call).toHaveBeenCalledTimes(4);
  });

  it("INV-2 INV-4: programs retain input_required_unsupported with the equivalent direct call", async () => {
    for (const write of [false, true]) {
      const flow = setup({ programWrite: write });
      const result = (
        await flow.rpc({
          name: "execute_code",
          pool: "trusted",
          args: { code: `return await connecta.call('service.${write ? "write" : "read"}', { id: 1 });` },
        })
      ).result;
      expect(result.structuredContent.error).toMatchObject({
        code: "input_required_unsupported",
        nextAction: {
          tool: write ? "call_destructive_tool" : "call_tool",
          arguments: { address: `service.${write ? "write" : "read"}`, args: { id: 1 } },
        },
      });
      expect(JSON.stringify(result)).not.toContain(OPAQUE);
      expect(JSON.stringify(result)).not.toContain("Pick a name");
    }
  });

  it("INV-4: refuses undeclared kinds, malformed requests, and excessive payloads with typed errors", async () => {
    for (const [raw, capabilities, code] of [
      [
        {
          requestState: OPAQUE,
          inputRequests: {
            k: {
              method: "elicitation/create",
              params: { mode: "url", message: "open", url: "https://downstream.test/approve" },
            },
          },
        },
        { elicitation: { form: {} } },
        "input_required_unsupported",
      ],
      [
        { requestState: OPAQUE, inputRequests: { k: { method: "roots/list" } } },
        { roots: {} },
        "input_required_unsupported",
      ],
      [
        {
          requestState: OPAQUE,
          inputRequests: { k: { method: "elicitation/create", params: { mode: "form", message: 3 } } },
        },
        { elicitation: { form: {} } },
        "input_required_invalid",
      ],
      [{ requestState: "x".repeat(70_000) }, {}, "input_required_limit"],
      [
        {
          requestState: OPAQUE,
          inputRequests: Object.fromEntries(
            Array.from({ length: 17 }, (_, i) => [
              String(i),
              {
                method: "elicitation/create",
                params: { mode: "url", message: "Open", url: "https://downstream.test/approve" },
              },
            ]),
          ),
        },
        { elicitation: { url: {} } },
        "input_required_limit",
      ],
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
    for (const url of [
      "http://downstream.test/approve",
      "https://user:pass@downstream.test/approve",
      `https://downstream.test/approve?token=${SECRET}`,
      "https://downstream.test/approve?nonce=ok\nauthorization: ordinary-approval-id",
    ]) {
      const invalid = setup({ url });
      const result = (await invalid.rpc()).result;
      expect(result.structuredContent, JSON.stringify(result)).toBeDefined();
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
    }
  });

  it("INV-4 INV-5 INV-6: refuses opaque-state echoes in prompts and completed continuation output", async () => {
    for (const [opaque, message] of [
      [OPAQUE, `Confirm ${OPAQUE}`],
      [OPAQUE, `Confirm ${btoa(OPAQUE)}`],
      ["private state", "Confirm private%20state"],
      ["q7z", "Confirm q7z"],
      ["[redacted]", "Confirm [redacted]"],
    ] as const) {
      const flow = setup({ opaque, message });
      const result = (await flow.rpc()).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(message);
      expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(message);
      expect(flow.call).toHaveBeenCalledOnce();
    }
    for (const params of [
      { mode: "url", message: "Open", url: `https://downstream.test/approve?state=${OPAQUE}` },
      {
        mode: "form",
        message: "Confirm",
        requestedSchema: { type: "object", properties: { [OPAQUE]: { type: "string" } } },
      },
    ]) {
      const flow = setup({
        raw: { requestState: OPAQUE, inputRequests: { k: { method: "elicitation/create", params } } },
      });
      const result = (await flow.rpc()).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(OPAQUE);
    }
    const flow = setup({ completeText: `Completed with state ${OPAQUE}` });
    const first = (await flow.rpc()).result;
    const final = (
      await flow.rpc({
        state: first.requestState,
        responses: { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } },
      })
    ).result;
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
      const flow = setup({
        raw: {
          requestState: OPAQUE,
          inputRequests: {
            k: {
              method: "elicitation/create",
              params: { mode: "form", message: "Confirm", requestedSchema },
            },
          },
        },
      });
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
      const result = (
        await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
      ).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(OPAQUE);
      const keys = await flow.storage.list("");
      expect(keys.filter((key) => key.includes(resultKeys.family.prefixes[0]))).toHaveLength(0);
      for (const key of keys) expect(await flow.storage.get(key)).not.toContain(OPAQUE);
      const search = await flow.rpc({ name: "search_tools", args: { query: "service.read" }, user: "bob" });
      expect(search.result.isError).toBeFalsy();
      expect(JSON.stringify(search)).not.toContain(OPAQUE);
      expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(OPAQUE);
    }
  });

  it("INV-4 INV-5 INV-9: retains bounded encrypted private state history across different downstream rounds", async () => {
    const states = ["PRIVATE_FIRST_ROUND_STATE", "PRIVATE_SECOND_ROUND_STATE"];
    for (const opts of [
      { completeText: `Completed with ${states[0]}` },
      { continuationMessage: `Confirm ${states[0]}` },
    ]) {
      const flow = setup({ roundStates: states, ...opts });
      const first = (await flow.rpc()).result;
      let result = (
        await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
      ).result;
      if (!opts.continuationMessage) {
        expect(result.resultType).toBe("input_required");
        const wrapper = JSON.parse(atob(result.requestState.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).p;
        expect(JSON.stringify(wrapper)).not.toContain(states[0]);
        const privateState = JSON.parse(
          await flow.vault.open!("service", "connecta:downstream-input:v1", wrapper.sealed),
        );
        expect(privateState.previousStates).toEqual([states[0]]);
        result = (
          await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })
        ).result;
      }
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect(JSON.stringify(result)).not.toContain(states[0]);
      expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(states[0]);
    }
    const flow = setup({ roundStates: ["a".repeat(30_000), "b".repeat(40_000)] });
    const first = (await flow.rpc()).result;
    expect(first.resultType, JSON.stringify(first)).toBe("input_required");
    const result = (
      await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(result.structuredContent.error.code).toBe("input_required_limit");
    expect(result.requestState).toBeUndefined();
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-5 INV-6: refuses mixed percent-encoded private states in prompts, URLs, and paged output across rounds", async () => {
    const variants = [
      `%44${OPAQUE.slice(1)}`,
      [...OPAQUE].map((char) => `%${char.charCodeAt(0).toString(16)}`).join(""),
    ];
    for (const encoded of variants) {
      for (const opts of [
        { message: `Confirm ${encoded}` },
        { url: `https://downstream.test/approve?state=${encoded}` },
      ]) {
        const flow = setup(opts);
        const result = (await flow.rpc()).result;
        expect(result.structuredContent.error.code).toBe("input_required_invalid");
        expect(JSON.stringify(result)).not.toContain(encoded);
      }
      const flow = setup({
        roundStates: [OPAQUE, "DIFFERENT_SECOND_STATE"],
        completeText: `${"x".repeat(25_000)}${encoded}`,
      });
      let result = (await flow.rpc()).result;
      for (let round = 0; round < 2; round++)
        result = (
          await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })
        ).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
      expect((await flow.storage.list("")).filter((key) => key.includes(resultKeys.family.prefixes[0]))).toHaveLength(
        0,
      );
    }
  });

  it("INV-4 INV-5: checks serialized primitive echoes in completed values and elicitation schemas", async () => {
    for (const [opaque, value] of [
      ["731496280517349", 731496280517349],
      ["true", true],
      ["null", null],
    ] as const) {
      const flow = setup({ opaque, completeStructured: { n: value } });
      const args = { address: "service.read", args: { id: 1 }, resultMode: "value" };
      const first = (await flow.rpc({ args })).result;
      const result = (
        await flow.rpc({ args, state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
      ).result;
      expect(result.structuredContent.error.code).toBe("input_required_invalid");
    }
    const flow = setup({
      raw: {
        requestState: "731496280517349",
        inputRequests: {
          k: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Confirm",
              requestedSchema: { type: "object", properties: { n: { type: "number", default: 731496280517349 } } },
            },
          },
        },
      },
    });
    expect((await flow.rpc()).result.structuredContent.error.code).toBe("input_required_invalid");
  });

  it("INV-4 INV-5 INV-6: guards raw continuation catalogs before public cache publication", async () => {
    const flow = setup({ catalogEcho: true });
    const first = (await flow.rpc()).result;
    const retry = (
      await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(retry.structuredContent.error.code).toBe("input_required_invalid");
    for (const key of await flow.storage.list("")) expect(await flow.storage.get(key)).not.toContain(OPAQUE);
    const search = await flow.rpc({ name: "search_tools", args: { query: "service.read" }, user: "bob" });
    expect(search.result.isError).toBeFalsy();
    expect(JSON.stringify(search)).not.toContain(OPAQUE);
    expect(flow.call).toHaveBeenCalledOnce();
  });

  it("INV-4 INV-5 INV-6: guards refreshed discovery before negotiation-cache persistence and reuse", async () => {
    const flow = setup({ authFirst: true });
    await flow.vault.set("service", SECRET, "alice");
    const first = (await flow.rpc()).result;
    expect(first.resultType).toBe("input_required");
    const fetch = globalThis.fetch;
    let discovery: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (typeof init?.body !== "string" || JSON.parse(init.body).method !== "server/discover") return response;
      const body = (await response.json()) as { result: Record<string, unknown> };
      body.result.instructions = OPAQUE;
      discovery = body.result;
      return Response.json(body);
    });
    // Rotating the credential changes the negotiation partition and forces a
    // discovery after the host has verified and unwrapped the continuation.
    await flow.vault.set("service", `${SECRET}-rotated`, "alice");
    const result = (
      await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(result.structuredContent.error.code).toBe("input_required_invalid");
    expect(discovery.instructions).toBe(OPAQUE);
    expect(flow.call).toHaveBeenCalledOnce();
    for (const key of await flow.storage.list("")) expect(await flow.storage.get(key)).not.toContain(OPAQUE);
    expect(JSON.stringify([flow.logs, flow.activity.record.mock.calls])).not.toContain(OPAQUE);

    // An existing verdict must also be checked before it reaches a new client.
    const ctx = connectorContext();
    const scope = ctx.requestScope ?? ctx;
    bindDownstreamContinuation(scope, {
      connector: "service",
      address: "service.read",
      input: { requestState: OPAQUE, inputResponses: {} },
      privateStates: [OPAQUE],
      write: false,
    });
    await ctx.storage.set(
      negotiationKeys.verdict("reuse"),
      JSON.stringify({ prior: { kind: "modern", discover: discovery }, expiresAt: Date.now() + 60_000 }),
    );
    try {
      await expect(readNegotiation(ctx, "reuse")).rejects.toMatchObject({ code: "input_required_invalid" });
    } finally {
      clearDownstreamContinuation(scope);
    }
  });

  it("INV-2 INV-4 INV-9: sends an OAuth write continuation once without auth refresh, step-up, or redirect replay", async () => {
    for (const failureStatus of [401, 403, 307]) {
      const flow = setup({ oauth: true, failureStatus });
      await flow.seedOAuth();
      const opts = { name: "call_destructive_tool", args: { address: "service.write", args: { id: 1 } } };
      const first = (await flow.rpc(opts)).result;
      expect(first.resultType, JSON.stringify(first)).toBe("input_required");
      const retryOpts = {
        ...opts,
        state: first.requestState,
        responses: { "downstream/service/0": { action: "accept" } },
      };
      const result = (await flow.rpc(retryOpts)).result;
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.retryable).toBe(false);
      if (failureStatus === 401)
        expect(result.structuredContent.error).toMatchObject({
          code: "downstream_oauth_required",
          reconciliationRequired: true,
          nextAction: {
            tool: "authorize_connector",
            arguments: { connector: "service" },
            operatorHandoff: "Give the URL and instructions it returns to the operator.",
          },
          retry:
            "This write may have partially run. Reconcile its target before retrying after the operator completes recovery.",
        });
      expect(flow.continuationSend).toHaveBeenCalledOnce();
      expect(flow.tokenRefresh).not.toHaveBeenCalled();
      expect((await flow.rpc(retryOpts)).result.isError).toBe(true);
      expect(flow.continuationSend).toHaveBeenCalledOnce();
    }
    // The fixture can refresh and retry reads; the write assertion cannot pass
    // merely because the authorization server failed to refresh its token.
    const read = setup({ oauth: true, failureStatus: 401 });
    await read.seedOAuth();
    const first = (await read.rpc()).result;
    const result = (
      await read.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(read.tokenRefresh, JSON.stringify(read.logs)).toHaveBeenCalledOnce();
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(read.continuationSend).toHaveBeenCalledTimes(2);
    expect(read.tokenRefresh).toHaveBeenCalledOnce();
  });

  it.each([429, 502, 503, 504, "timeout"] as const)(
    "INV-4 INV-6 INV-9: makes a spent continuation non-retryable after %s with recovery appropriate to reads and writes",
    async (failure) => {
      for (const write of [false, true]) {
        const flow = setup(failure === "timeout" ? { continuationTimeout: true } : { failureStatus: failure });
        const opts = {
          name: write ? "call_destructive_tool" : "call_tool",
          args: { address: `service.${write ? "write" : "read"}`, args: { id: 1 } },
        };
        const first = (await flow.rpc(opts)).result;
        expect(first.resultType).toBe("input_required");
        const continuation = {
          ...opts,
          state: first.requestState,
          responses: { "downstream/service/0": { action: "accept" } },
        };
        const result = (await flow.rpc(continuation)).result;
        expect(result.isError).toBe(true);
        expect(result.structuredContent.error).toMatchObject({
          code:
            failure === 429
              ? "rate_limited"
              : failure === "timeout"
                ? write
                  ? "write_outcome_unknown"
                  : "unavailable"
                : "connector_call_failed",
          retryable: false,
        });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(flow.continuationSend).toHaveBeenCalledOnce();
        const replay = (await flow.rpc(continuation)).result;
        expect(replay.isError).toBe(true);
        expect(replay.content[0].text).toContain("Invalid or expired requestState");
        expect(flow.continuationSend).toHaveBeenCalledOnce();
        expect(JSON.stringify([result, flow.logs, flow.activity.record.mock.calls])).not.toContain(
          "PRIVATE_TRANSPORT_TIMEOUT",
        );
        if (failure === "timeout" && write) {
          expect(result.structuredContent.error.uncertainCall).toEqual({ address: "service.write", args: { id: 1 } });
          expect(result.structuredContent.error.retry).toContain("Check whether the write took effect first");
        }
        if (write) {
          // The underlying transport failure supplies no nextAction. In particular,
          // losing a completed write's response must not direct another write.
          expect(result.structuredContent.error).not.toHaveProperty("nextAction");
          if (failure === "timeout") {
            expect(flow.completedWrite).toHaveBeenCalledOnce();
            expect(flow.call).toHaveBeenCalledTimes(2);
            expect(flow.call).toHaveBeenLastCalledWith("write", { id: 1 }, OPAQUE, { question: { action: "accept" } });
          }
        } else {
          expect(result.structuredContent.error.nextAction).toEqual({
            tool: opts.name,
            arguments: opts.args,
            purpose:
              "Re-issue the original direct call without requestState or inputResponses to start a fresh input round. Do not resend this continuation.",
          });
          expect(result.structuredContent.error).not.toHaveProperty("retry");
          const next = result.structuredContent.error.nextAction;
          const fresh = (await flow.rpc({ name: next.tool, args: next.arguments })).result;
          expect(fresh.resultType).toBe("input_required");
          expect(fresh.requestState).not.toBe(first.requestState);
          expect(flow.continuationSend).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("INV-4 INV-9: preserves auth recovery prerequisites for a failed read continuation", async () => {
    const flow = setup({ failContinuationAuth: true });
    const first = (await flow.rpc()).result;
    const result = (
      await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(result.structuredContent.error).toMatchObject({
      code: "auth_required",
      retryable: false,
      nextAction: {
        tool: "authorize_connector",
        arguments: { connector: "service" },
        operatorHandoff: "Give the URL and instructions it returns to the operator.",
      },
      retry: "Retry service.read after the operator completes recovery.",
    });
    expect(flow.continuationSend).toHaveBeenCalledOnce();
  });

  it.each([429, 502, 503, 504])("INV-9: preserves first-call retryability after HTTP %s", async (failureStatus) => {
    const flow = setup();
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call")
        return new Response(null, { status: failureStatus });
      return fetch(input, init);
    });
    const result = (await flow.rpc()).result;
    expect(result.structuredContent.error).toMatchObject({
      code: failureStatus === 429 ? "rate_limited" : "connector_call_failed",
      retryable: true,
    });
    expect(result.structuredContent.error).not.toHaveProperty("nextAction");
    expect(flow.continuationSend).not.toHaveBeenCalled();
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
    await flow.rpc({
      state: first.requestState,
      responses: { [Object.keys(first.inputRequests)[0]!]: { action: "accept" } },
    });
    expect(flow.call).toHaveBeenLastCalledWith("read", { id: 1 }, opaque, { [SECRET]: { action: "accept" } });
  });

  it("INV-4 INV-9: validates input responses and capabilities before consuming a continuation", async () => {
    const flow = setup();
    const first = (await flow.rpc()).result;
    const key = Object.keys(first.inputRequests)[0]!;
    for (const response of [
      { action: "invalid" },
      { action: "accept", content: { name: {} } },
      { action: "accept", content: { name: "x".repeat(70_000) } },
    ]) {
      const retry = await flow.rpc({ state: first.requestState, responses: { [key]: response } });
      expect(retry.result?.isError ?? Boolean(retry.error)).toBe(true);
    }
    const incapable = (
      await flow.rpc({ state: first.requestState, capabilities: {}, responses: { [key]: { action: "accept" } } })
    ).result;
    expect(incapable.structuredContent.error.code).toBe("input_required_unsupported");
    expect(flow.call).toHaveBeenCalledOnce();
    expect(
      (await flow.rpc({ state: first.requestState, responses: { [key]: { action: "accept" } } })).result.isError,
    ).toBeFalsy();
    expect(flow.call).toHaveBeenCalledTimes(2);
  });

  it("INV-4 INV-9: auth-to-downstream composition shares its round bound and never confuses input keys", async () => {
    const flow = setup({ authFirst: true, repeat: true });
    const first = (await flow.rpc()).result;
    expect(Object.keys(first.inputRequests)).toEqual(["connecta_auth"]);
    await flow.vault.set("service", SECRET, "alice");
    let result = (await flow.rpc({ state: first.requestState, responses: { connecta_auth: { action: "accept" } } }))
      .result;
    expect(Object.keys(result.inputRequests)).toEqual(["downstream/service/0"]);
    result = (
      await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(result.resultType).toBe("input_required");
    result = (
      await flow.rpc({ state: result.requestState, responses: { "downstream/service/0": { action: "accept" } } })
    ).result;
    expect(result.structuredContent.error.code).toBe("input_required_round_limit");
    expect(flow.call).toHaveBeenCalledTimes(3);
  });

  it("INV-9: an auth failure during a write continuation cannot create an auth replay or reuse the nonce", async () => {
    const flow = setup({ failContinuationAuth: true });
    const opts = { name: "call_destructive_tool", args: { address: "service.write", args: { id: 1 } } };
    const first = (await flow.rpc(opts)).result;
    const retryOpts = {
      ...opts,
      state: first.requestState,
      responses: { "downstream/service/0": { action: "accept" } },
    };
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
    await flow.rpc({
      state: first.requestState,
      responses: { "downstream/service/0": { action: "accept", content: { name: "INPUT_PRIVATE_TEXT" } } },
    });
    const entries = await flow.storage.list(`${scopes.connector("service")}${inputRetryKeys.family.prefixes[0]}`);
    expect(entries).toHaveLength(1);
    expect(await flow.storage.get(entries[0]!)).toBe("used");
  });

  it("INV-4: validates final output schemas while allowing input-required suspensions", async () => {
    for (const invalidOutput of [false, true]) {
      const flow = setup({ output: true, invalidOutput });
      const first = (await flow.rpc()).result;
      expect(first.resultType).toBe("input_required");
      const result = (
        await flow.rpc({ state: first.requestState, responses: { "downstream/service/0": { action: "accept" } } })
      ).result;
      expect(result.isError === true).toBe(invalidOutput);
      if (invalidOutput) expect(result.structuredContent.error.code).toBe("invalid_args");
    }
  });
});
