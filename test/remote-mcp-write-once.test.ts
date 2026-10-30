import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { z } from "zod";
import { attachCallClassification } from "../src/call-classification.js";
import { CatalogService } from "../src/catalog-service.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { scopes } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { guestErrorText, guestFailureFacts, scriptedExecutor } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { createTestConnecta, makeRegistry, required, silentLogger } from "./helpers.js";

beforeEach(() => {
  installOwnedTransport();
});

// Remote MCP writes through the real SDK client and transport against a real
// MCP server: a write leaves once whatever answers it (INV-9), and a read may
// be sent again after a refresh or a redirect.

const BASE = "https://connecta.test";
const STALE = "STALE_ACCESS_CREDENTIAL";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * How a tools/call is answered. After `307`, `308`, `"mismatch"`, or
 * `"resume"` the server has acted on the call; `"mismatch"` answers
 * HeaderMismatch once, and `"resume"` breaks the answer stream after its
 * priming event, so the answer arrives only on a resumed stream.
 */
type Answer =
  | "pass"
  | 400
  | 401
  | 403
  | 502
  | 503
  | 504
  | 307
  | 308
  | "mismatch"
  | "resume"
  | "reset"
  | "refused"
  | "timeout"
  | "deadline";

function setup(
  options: {
    oauth?: boolean;
    overrideRead?: boolean;
    sameOriginOAuth?: boolean;
    public?: boolean;
    missingReadHints?: boolean;
    onApplied?: () => void;
    headers?: Record<string, string>;
    refresh?: "rotate" | "dead" | "outage";
    redirects?: "same-origin";
    versionNegotiation?: "legacy" | "auto";
    /** Runs as a tools/call is answered 401, before the answer reaches connecta. */
    onUnauthorized?: () => void;
  } = {},
) {
  const applied: string[] = [];
  const authOrigin = options.sameOriginOAuth ? "https://downstream.test" : "https://auth.test";
  const downstream = httpDownstream((server) => {
    server.registerTool(
      "create_item",
      { inputSchema: z.object({ id: z.number() }), annotations: { readOnlyHint: false } },
      async ({ id }) => {
        applied.push(`create_item ${id}`);
        return { content: [{ type: "text", text: JSON.stringify({ created: id }) }] };
      },
    );
    server.registerTool(
      "list_items",
      { inputSchema: z.object({}), ...(options.missingReadHints ? {} : { annotations: { readOnlyHint: true } }) },
      async () => {
        applied.push("list_items");
        return { content: [{ type: "text", text: "[]" }] };
      },
    );
  });
  /** Every tools/call POST that left connecta, by tool name and bearer token. */
  const sent: Array<{ name: string; authorization: string | null }> = [];
  let refreshes = 0;
  const requests: { url: string; headers: Headers }[] = [];
  /** How the next tools/call per tool is answered; "pass" lets it through. */
  const answers = new Map<string, Answer>();
  /** The Last-Event-ID of each resumed stream, and the answer it carries. */
  const resumed: string[] = [];
  let pendingAnswer: string | undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const lastEventId = init?.method === "GET" ? new Headers(init.headers).get("last-event-id") : null;
    if (lastEventId) {
      resumed.push(lastEventId);
      return new Response(`id: ev-2\nevent: message\ndata: ${pendingAnswer}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.includes("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: downstream.url, authorization_servers: [authOrigin] });
    if (url.startsWith(`${authOrigin}/.well-known/`))
      return Response.json({
        issuer: authOrigin,
        authorization_endpoint: `${authOrigin}/authorize`,
        token_endpoint: `${authOrigin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url === `${authOrigin}/token`) {
      refreshes++;
      if (options.refresh === "dead") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (options.refresh === "outage") return new Response("down", { status: 503 });
      return Response.json({
        access_token: `FRESH_ACCESS_${refreshes}`,
        refresh_token: `FRESH_REFRESH_${refreshes}`,
        token_type: "Bearer",
      });
    }
    const rpc =
      init?.method === "POST" && typeof init.body === "string"
        ? (JSON.parse(init.body) as { method?: string; params?: { name?: string } })
        : undefined;
    if (rpc?.method !== "tools/call") return downstream.fetch(input as string, init);
    const name = rpc.params!.name!;
    const authorization = new Headers(init?.headers).get("authorization");
    const answer = answers.get(name) ?? "pass";
    if (answer === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    sent.push({ name, authorization });
    if (answer === 401 && (options.public || authorization === `Bearer ${STALE}`)) {
      options.onUnauthorized?.();
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${downstream.url.replace("/mcp", "")}/.well-known/oauth-protected-resource"`,
        },
      });
    }
    if (answer === 403)
      return new Response(null, {
        status: 403,
        headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="items:write"' },
      });
    // Everything else reaches the server, which acts on it, and then the
    // gateway, the connection, or the server's own answer fails the call.
    const reply = await downstream.fetch(downstream.url, init);
    if (answer === "pass" || answer === 401) return reply;
    if ((answer === 307 || answer === 308) && url.endsWith("?moved")) return reply;
    await reply.body?.cancel();
    if (answer === 307 || answer === 308)
      return new Response(null, { status: answer, headers: { location: `${downstream.url}?moved` } });
    if (answer === "resume") {
      pendingAnswer = JSON.stringify({
        jsonrpc: "2.0",
        id: (rpc as { id?: unknown }).id,
        result: { content: [{ type: "text", text: JSON.stringify({ created: 1 }) }] },
      });
      return new Response("retry: 10\nid: ev-1\ndata: \n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (answer === "mismatch") {
      answers.delete(name);
      return Response.json(
        { jsonrpc: "2.0", id: (rpc as { id?: unknown }).id, error: { code: -32020, message: "Header mismatch" } },
        { status: 400 },
      );
    }
    if (answer === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (answer === "timeout")
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    // The answer never arrives: the SDK's request deadline or the caller's
    // signal ends the call, rejecting fetch with its reason.
    if (answer === "deadline") {
      const signal = init!.signal!;
      options.onApplied?.();
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return new Response("<html>bad gateway</html>", { status: answer, headers: { "content-type": "text/html" } });
  });
  const storage = memoryStorage();
  const connector = remoteMcp("svc", {
    url: downstream.url,
    versionNegotiation: options.versionNegotiation ?? "legacy",
    ...(options.redirects ? { redirects: options.redirects } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.public
      ? {}
      : {
          auth: options.oauth
            ? { type: "oauth" as const }
            : { type: "headers" as const, headers: { Authorization: "Bearer HEADER_CREDENTIAL" } },
        }),
  });
  const registry = makeRegistry([connector], {
    storage,
    ...(options.overrideRead
      ? {
          classification: {
            svc: { create_item: "read", ...(options.missingReadHints ? { list_items: "read" as const } : {}) },
          },
        }
      : {}),
  });
  const tools = createMetaTools(registry, BASE);
  const seedOAuth = () =>
    seedGrant(
      storage,
      {
        issuer: authOrigin,
        client: {
          value: {
            client_id: "svc-client",
            redirect_uris: [`${BASE}/oauth/callback/svc`],
            token_endpoint_auth_method: "none",
          },
        },
        tokens: { access_token: STALE, refresh_token: "INITIAL_REFRESH", token_type: "Bearer" },
      },
      "v3:seeded",
      scopes.connector("svc"),
    );
  const outcome = async (tool: "create_item" | "list_items", args: Record<string, unknown> = {}) => {
    const address = `svc.${tool}`;
    const result =
      tool === "create_item" && !options.overrideRead
        ? await tools.callDestructiveTool({ address, args })
        : await tools.callTool({ address, args });
    return JSON.parse(result.content[0]!.text) as {
      error?: {
        code: string;
        retryable: boolean;
        retryAfterMs?: number;
        message: string;
        reconciliationRequired?: boolean;
        writeOutcome?: string;
        details?: Record<string, unknown>;
        uncertainCall?: unknown;
      };
    };
  };
  /** Run a program that sends one write, catching its failure or not. */
  const program = async (caught: boolean, count = 1) => {
    const execute = createExecuteTool(
      registry,
      BASE,
      scriptedExecutor(async (fns) => {
        for (let id = 1; id <= count; id++) {
          try {
            await required(fns.call)("svc.create_item", { id });
          } catch (error) {
            if (!caught) throw error;
          }
        }
        return "done";
      }),
      silentLogger,
      undefined,
      { readOnly: false },
    );
    return (await execute({ code: "async () => null" })).structuredContent as Record<string, any>;
  };
  return {
    outcome,
    requests,
    program,
    connector,
    context: (options?: { signal?: AbortSignal; timeoutMs?: number }) =>
      registry.contextFor("svc", BASE, undefined, options),
    registry,
    storage,
    seedOAuth,
    applied,
    answers,
    sent: (name: string) => sent.filter((entry) => entry.name === name),
    resumed: () => resumed,
    refreshes: () => refreshes,
  };
}

/** Exercise the URL-elicitation replay boundary with the same real downstream. */
async function authRecoveryRow(surface: "program" | "call_tool") {
  const flow = setup({ overrideRead: true, public: true });
  flow.connector.startAuth = async () => ({ state: "auth_required", authorizationUrl: "https://auth.test/authorize" });
  flow.answers.set(surface === "program" ? "list_items" : "create_item", 401);
  const app = createTestConnecta({
    connectors: [flow.connector],
    storage: flow.storage,
    vault: encryptedCredentialVault(flow.storage, CREDENTIAL_KEY),
    publicUrl: BASE,
    logger: "silent",
    auth: [fakeClerkAuth({ token: "alice", userId: "alice" })],
    classification: { svc: { create_item: "read" } },
    pools: { trusted: { tools: ["svc"], members: ["alice"], readOnly: false } },
    executor: {
      execute: async (_code, providers) => {
        const call = required(providers.find((provider) => provider.name === "connecta")).fns.call!;
        try {
          await call("svc.create_item", { id: 1 });
          return { result: await call("svc.list_items", {}) };
        } catch (error) {
          return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) };
        }
      },
    },
  });
  const rpc = async (state?: string) => {
    const name = surface === "program" ? "execute_code" : "call_tool";
    const request = mcpRpc("tools/call", {
      name,
      arguments: surface === "program" ? { code: "program" } : { address: "svc.create_item", args: { id: 1 } },
      ...(state ? { requestState: state, inputResponses: { connecta_auth: { action: "accept" } } } : {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
      },
    });
    request.headers.set("MCP-Protocol-Version", "2026-07-28");
    request.headers.set("Mcp-Method", "tools/call");
    request.headers.set("Mcp-Name", name);
    request.headers.set("Authorization", "Bearer alice");
    if (surface === "call_tool") request.headers.set("Mcp-Param-Address", "svc.create_item");
    return (
      await readJsonRpc(await app.fetch(surface === "program" ? new Request(`${BASE}/mcp/trusted`, request) : request))
    ).result;
  };
  try {
    const first = await rpc();
    if (first.resultType === "input_required") {
      flow.answers.clear();
      await rpc(first.requestState);
    }
    expect.soft(first.resultType, surface).not.toBe("input_required");
    expect.soft(flow.sent("create_item"), surface).toHaveLength(1);
    expect.soft(first.structuredContent ?? first, surface).toMatchObject({ error: { reconciliationRequired: true } });
  } finally {
    await app.close();
  }
}

describe("remote MCP OAuth writes after a 401", () => {
  it("INV-4 INV-9: write-to-read overrides never replay source writes through recovery and settle every dispatched failure", async () => {
    for (const [answer, oauth, versionNegotiation, sameOriginOAuth, recover] of [
      [401, true, "legacy", false, false],
      [401, true, "legacy", true, false],
      ["reset", false, "legacy", false, true],
      ["mismatch", false, "auto", false, true],
      ["reset", false, "legacy", false, false],
      ["prepare", false, "legacy", false, false],
      ["invoke-timeout", false, "legacy", false, false],
      ["invoke-cancel", false, "legacy", false, false],
      ["program", false, "legacy", false, false],
      ["call_tool", false, "legacy", false, false],
      ["missing-hints", true, "legacy", false, false],
      ["caught-reset", false, "legacy", false, false],
      ["caught-503", false, "legacy", false, false],
      ["caught-timeout", false, "legacy", false, false],
      ["thirteen-reads", false, "legacy", false, false],
    ] as const) {
      if (answer === "program" || answer === "call_tool") {
        await authRecoveryRow(answer);
        vi.unstubAllGlobals();
        continue;
      }
      if (
        answer === "caught-reset" ||
        answer === "caught-503" ||
        answer === "caught-timeout" ||
        answer === "thirteen-reads"
      ) {
        const flow = setup({ overrideRead: true });
        if (answer !== "thirteen-reads")
          flow.answers.set(
            "create_item",
            answer === "caught-reset" ? "reset" : answer === "caught-503" ? 503 : "timeout",
          );
        const count = answer === "thirteen-reads" ? 13 : 1;
        const result = await flow.program(true, count);
        if (answer === "thirteen-reads") {
          expect
            .soft(result, answer)
            .toMatchObject({ result: "done", hostCalls: { admitted: 13, succeeded: 13, failed: 0 } });
          expect.soft(result, answer).not.toHaveProperty("error");
        } else {
          expect.soft(result, answer).toMatchObject({
            error: {
              code: "write_outcome_unknown",
              retryable: false,
              writes: { succeeded: 0, failed: 0, unknown: 1 },
            },
          });
        }
        expect.soft(flow.sent("create_item"), answer).toHaveLength(count);
        expect.soft(flow.applied, answer).toHaveLength(count);
        vi.unstubAllGlobals();
        continue;
      }
      const controller = new AbortController();
      const interrupted = answer === "invoke-timeout" || answer === "invoke-cancel";
      if (answer === "prepare") {
        vi.spyOn(Client.prototype, "callTool").mockRejectedValue(
          new ConnectorCallError("rate_limited", "Unsent preparation refusal.", { retryAfterMs: 50 }),
        );
      } else if (recover) {
        // Model recovery/fallback issuing a fresh JSON-RPC id after failure.
        vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, params, options) {
          try {
            return (await this.request({ method: "tools/call", params }, options)) as never;
          } catch {
            return (await this.request({ method: "tools/call", params }, options)) as never;
          }
        });
      }
      const flow = setup({
        oauth,
        versionNegotiation,
        overrideRead: true,
        missingReadHints: answer === "missing-hints",
        ...(answer === "invoke-cancel" ? { onApplied: () => controller.abort(new Error("Caller left.")) } : {}),
        sameOriginOAuth,
        ...(oauth ? { headers: { "X-Context": "tenant_selector" } } : {}),
      });
      if (oauth) await flow.seedOAuth();
      if (answer === "missing-hints") {
        flow.answers.set("list_items", 401);
        expect((await flow.outcome("list_items")).error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
        expect(flow.sent("list_items")).toHaveLength(1);
        expect(flow.refreshes()).toBe(1);
        vi.unstubAllGlobals();
        continue;
      }
      if (answer !== "prepare") flow.answers.set("create_item", interrupted ? "deadline" : answer);
      const invoked = interrupted
        ? await new InvocationService(flow.registry, new CatalogService(flow.registry, BASE)).invoke(
            "svc.create_item",
            { id: 1 },
            {
              source: "call_tool",
              ...(answer === "invoke-timeout" ? { timeoutMs: 1000 } : { requestSignal: controller.signal }),
            },
          )
        : undefined;
      const failed = invoked
        ? invoked.ok
          ? {}
          : { error: invoked.error }
        : await flow.outcome("create_item", { id: 1 });
      expect.soft(failed.error, String(answer)).toBeDefined();
      if (answer === "prepare") {
        expect.soft(failed.error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 50 });
        expect.soft(failed.error).not.toHaveProperty("writeOutcome");
      } else {
        expect.soft(failed.error, String(answer)).toMatchObject({ retryable: false, writeOutcome: "unknown" });
        expect.soft(failed.error).not.toHaveProperty("retryAfterMs");
      }
      if (interrupted)
        expect
          .soft(failed.error?.code, answer)
          .toBe(answer === "invoke-timeout" ? "write_outcome_unknown" : "cancelled");
      expect.soft(flow.sent("create_item"), String(answer)).toHaveLength(answer === "prepare" ? 0 : 1);
      expect.soft(flow.applied).toEqual(answer === 401 || answer === "prepare" ? [] : ["create_item 1"]);
      expect.soft(flow.refreshes()).toBe(oauth ? 1 : 0);
      if (oauth) {
        expect
          .soft(
            flow.requests
              .filter((request) => request.url.includes("/.well-known/") || request.url.endsWith("/token"))
              .every((request) => !request.headers.has("x-context")),
          )
          .toBe(true);
        expect
          .soft(
            flow.requests
              .filter((request) => request.url.endsWith("/mcp"))
              .every((request) => request.headers.get("x-context") === "tenant_selector"),
          )
          .toBe(true);
      }
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it("INV-9: sends an ordinary write once, refreshes the grant, and lets a deliberate repeat use it", async () => {
    const flow = setup({ oauth: true });
    await flow.seedOAuth();
    flow.answers.set("create_item", 401);

    const failed = await flow.outcome("create_item", { id: 1 });
    expect(failed.error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failed.error!.message).toBe(
      `Connector "svc"'s MCP server answered this write with HTTP 401. The credential is renewed for the next ` +
        "call, but the write was not sent again, so whether it took effect is unknown: check the target before repeating it.",
    );
    expect(flow.sent("create_item")).toEqual([{ name: "create_item", authorization: `Bearer ${STALE}` }]);
    expect(flow.refreshes()).toBe(1);
    expect(flow.applied).toEqual([]);

    // The explicit repeat is one new call on the refreshed grant.
    expect((await flow.outcome("create_item", { id: 1 })).error).toBeUndefined();
    expect(flow.sent("create_item").map((entry) => entry.authorization)).toEqual([
      `Bearer ${STALE}`,
      "Bearer FRESH_ACCESS_1",
    ]);
    expect(flow.applied).toEqual(["create_item 1"]);
    expect(flow.refreshes()).toBe(1);
  });

  it("INV-9: refreshes and sends a read again once", async () => {
    const flow = setup({ oauth: true });
    await flow.seedOAuth();
    flow.answers.set("list_items", 401);
    expect((await flow.outcome("list_items")).error).toBeUndefined();
    expect(flow.sent("list_items").map((entry) => entry.authorization)).toEqual([
      `Bearer ${STALE}`,
      "Bearer FRESH_ACCESS_1",
    ]);
    expect(flow.refreshes()).toBe(1);
  });

  it.each(["dead", "outage"] as const)(
    "INV-9: a write whose grant cannot be refreshed (%s) is sent once and never advertised as retryable",
    async (refresh) => {
      const flow = setup({ oauth: true, refresh });
      await flow.seedOAuth();
      flow.answers.set("create_item", 401);
      const failed = await flow.outcome("create_item", { id: 1 });
      // The authorization verdict keeps its code and handoff, and says the
      // write it followed has an unknown outcome.
      expect(failed.error).toMatchObject({
        code: "downstream_oauth_required",
        retryable: false,
        reconciliationRequired: true,
        writeOutcome: "unknown",
        nextAction: { tool: "authorize_connector", arguments: { connector: "svc" } },
      });
      expect(flow.sent("create_item")).toHaveLength(1);
      expect(flow.refreshes()).toBe(1);
    },
  );

  it.each([true, false])(
    "INV-9: a program that sent a write the dead grant then refused reports it unknown (caught: %s)",
    async (caught) => {
      const flow = setup({ oauth: true, refresh: "dead" });
      await flow.seedOAuth();
      flow.answers.set("create_item", 401);
      const result = await flow.program(caught);
      // Catching the failure cannot make the program's result "done": the
      // verdict is the result, as a direct call reports it, with the write
      // counted unknown.
      expect(result.result).toBeUndefined();
      expect(result.error).toMatchObject({
        code: "downstream_oauth_required",
        retryable: false,
        writeOutcome: "unknown",
        writes: { succeeded: 0, failed: 0, unknown: 1 },
        reconciliationRequired: true,
        connector: "svc",
        nextAction: { tool: "authorize_connector", arguments: { connector: "svc" } },
      });
      expect(flow.sent("create_item")).toHaveLength(1);
    },
  );

  it("INV-9: a direct write whose caller leaves as it is answered 401 keeps the auth code, unknown and unsent", async () => {
    const controller = new AbortController();
    const flow = setup({
      oauth: true,
      onUnauthorized: () => controller.abort(new DOMException("The caller left.", "AbortError")),
    });
    await flow.seedOAuth();
    flow.answers.set("create_item", 401);
    const failed = await flow.connector
      .callTool("create_item", { id: 1 }, flow.context({ signal: controller.signal }))
      .catch((error: unknown) => error);
    // Renewal never succeeded, so the 401's authorization verdict stands.
    expect(failed).toMatchObject({ code: "downstream_oauth_required", retryable: false, writeOutcome: "unknown" });
    expect(flow.sent("create_item")).toHaveLength(1);
  });

  it("INV-9: a write the downstream refuses for scope is sent once; the step-up never resends it", async () => {
    const flow = setup({ oauth: true });
    await flow.seedOAuth();
    flow.answers.set("create_item", 403);
    const failed = await flow.outcome("create_item", { id: 1 });
    expect(failed.error).toMatchObject({ code: "provider_permission_denied", retryable: false });
    expect(flow.sent("create_item")).toHaveLength(1);
  });
});

describe("remote MCP writes and redirects", () => {
  it.each([307, 308] as const)(
    "INV-9: a write answered %s after the server acted is not sent to the new location; its outcome is unknown",
    async (status) => {
      const flow = setup({ redirects: "same-origin" });
      flow.answers.set("create_item", status);
      const write = await flow.outcome("create_item", { id: 1 });
      expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      expect(write.error!.message).toBe(
        `Connector "svc"'s MCP server answered this write with a redirect, and the write was not sent again, so ` +
          "whether it took effect is unknown: check the target before repeating it.",
      );
      expect(flow.sent("create_item")).toHaveLength(1);
      expect(flow.applied).toEqual(["create_item 1"]);
    },
  );

  it.each([307, 308] as const)("INV-9: a read answered %s follows it within the origin", async (status) => {
    const flow = setup({ redirects: "same-origin" });
    flow.answers.set("list_items", status);
    expect((await flow.outcome("list_items")).error).toBeUndefined();
    expect(flow.sent("list_items")).toHaveLength(2);
  });

  it.each([true, false])(
    "INV-9: a program whose write was redirected reports it unknown (caught: %s)",
    async (caught) => {
      const flow = setup({ redirects: "same-origin" });
      flow.answers.set("create_item", 307);
      const result = await flow.program(caught);
      expect(result.error).toMatchObject({
        code: "write_outcome_unknown",
        writes: { succeeded: 0, failed: 0, unknown: 1 },
      });
      expect(flow.applied).toEqual(["create_item 1"]);
    },
  );
});

describe("remote MCP writes and SSE resumption", () => {
  it("INV-9: a write whose answer stream breaks resumes with Last-Event-ID and is never sent again", async () => {
    const flow = setup();
    flow.answers.set("create_item", "resume");
    const write = await flow.outcome("create_item", { id: 1 });
    expect(write.error).toBeUndefined();
    expect(flow.resumed()).toEqual(["ev-1"]);
    expect(flow.sent("create_item")).toHaveLength(1);
    expect(flow.applied).toEqual(["create_item 1"]);
  });
});

describe("remote MCP writes and SDK recoveries under a new JSON-RPC id", () => {
  it("INV-9: a direct write with no definition is sent once when the server answers HeaderMismatch", async () => {
    const flow = setup({ versionNegotiation: "auto" });
    flow.answers.set("create_item", "mismatch");
    // Outside an invocation, with nothing listed: no definition for the SDK.
    await expect(flow.connector.callTool("create_item", { id: 1 }, flow.context())).rejects.toMatchObject({
      retryable: false,
    });
    expect(flow.sent("create_item")).toHaveLength(1);
    expect(flow.applied).toEqual(["create_item 1"]);
  });

  it("INV-9: an effective direct read without source hints refuses the SDK's second send after HeaderMismatch", async () => {
    const flow = setup({ versionNegotiation: "auto" });
    flow.answers.set("list_items", "mismatch");
    const ctx = flow.context();
    attachCallClassification(ctx, "read");
    // A definition-free call has no source read proof. Its effective read
    // classification cannot relax the fail-closed source class.
    await expect(flow.connector.callTool("list_items", {}, ctx)).rejects.toMatchObject({ retryable: false });
    expect(flow.sent("list_items")).toHaveLength(1);
    expect(flow.applied).toEqual(["list_items"]);
  });

  it.each([false, true])(
    "INV-1 INV-9: losing the dispatch Symbol refuses writes and permits reads (after a send: %s)",
    async (resend) => {
      vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, params, options) {
        if (resend) await this.request({ method: "tools/call", params }, options);
        const cloned = structuredClone(params);
        expect(Object.getOwnPropertySymbols(params)).toHaveLength(1);
        expect(Object.getOwnPropertySymbols(cloned)).toHaveLength(0);
        return (await this.request({ method: "tools/call", params: cloned }, options)) as never;
      });
      const flow = setup();
      const write = await flow.outcome("create_item", { id: 1 });
      expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      expect(write.error!.message).toContain("lost its dispatch record");
      expect(flow.sent("create_item")).toHaveLength(resend ? 1 : 0);
      expect(flow.applied).toEqual(resend ? ["create_item 1"] : []);

      expect((await flow.outcome("list_items")).error).toBeUndefined();
      expect(flow.sent("list_items")).toHaveLength(resend ? 2 : 1);
    },
  );

  it("INV-9: tracked fetch refuses a write whose transport lost its JSON-RPC dispatch mapping", async () => {
    const send = StreamableHTTPClientTransport.prototype.send;
    vi.spyOn(StreamableHTTPClientTransport.prototype, "send").mockImplementation(function (
      this: StreamableHTTPClientTransport,
      message,
      options,
    ) {
      const changed =
        !Array.isArray(message) && "method" in message && message.method === "tools/call" && "id" in message
          ? { ...message, id: `${message.id}-lost` }
          : message;
      return send.call(this, changed, options);
    });
    const flow = setup();
    const write = await flow.outcome("create_item", { id: 1 });
    expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(write.error!.message).toContain("lost its dispatch record");
    expect(flow.sent("create_item")).toHaveLength(0);
    expect(flow.applied).toEqual([]);
  });

  it("INV-1 INV-9: a recordless call cannot use catalog read hints to overrule its served write classification", async () => {
    vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, params, options) {
      return (await this.request({ method: "tools/call", params: structuredClone(params) }, options)) as never;
    });
    const flow = setup();
    const ctx = flow.context();
    await flow.connector.listTools(ctx);
    attachCallClassification(ctx, "write");
    await expect(flow.connector.callTool("list_items", {}, ctx)).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(flow.sent("list_items")).toHaveLength(0);
    // A direct unlisted call is not proven read either.
    await expect(flow.connector.callTool("unlisted_tool", {}, flow.context())).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(flow.sent("unlisted_tool")).toHaveLength(0);
  });

  it("INV-1 INV-9: a concurrent read of the same tool cannot authorize a recordless write", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, params, options) {
      if (++entered === 2) release();
      await ready;
      return (await this.request({ method: "tools/call", params: structuredClone(params) }, options)) as never;
    });
    const flow = setup();
    const requestScope = {};
    const write = { ...flow.context(), requestScope };
    const read = { ...flow.context(), requestScope };
    attachCallClassification(write, "write");
    attachCallClassification(read, "read");
    const results = await Promise.allSettled([
      flow.connector.callTool("list_items", {}, write),
      flow.connector.callTool("list_items", {}, read),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "connector_call_failed", retryable: false, writeOutcome: "unknown" },
      });
    expect(flow.sent("list_items")).toHaveLength(0);
  });

  it("INV-9: whatever JSON-RPC id the SDK gives a second message for one write, it never leaves", async () => {
    // Stand in for any SDK recovery that sends one call again as a new message.
    vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, params, options) {
      try {
        return (await this.request({ method: "tools/call", params }, options)) as never;
      } catch {
        return (await this.request({ method: "tools/call", params }, options)) as never;
      }
    });
    const flow = setup();
    flow.answers.set("create_item", 502);
    const write = await flow.outcome("create_item", { id: 1 });
    expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(write.error!.message).toBe(
      `Connector "svc"'s MCP server was sent this write, and a second send of it was stopped, so whether it took ` +
        "effect is unknown: check the target before repeating it.",
    );
    expect(flow.sent("create_item")).toHaveLength(1);
    expect(flow.applied).toEqual(["create_item 1"]);

    // A read's second message leaves.
    flow.answers.set("list_items", 502);
    await flow.outcome("list_items");
    expect(flow.sent("list_items")).toHaveLength(2);
  });
});

describe("remote MCP writes after an ambiguous failure", () => {
  it.each([502, 503, 504, "reset"] as const)(
    "INV-9: a write answered %s after the server acted is an unknown outcome, never retryable; a read stays retryable",
    async (answer) => {
      const flow = setup();
      flow.answers.set("create_item", answer);
      const write = await flow.outcome("create_item", { id: 1 });
      expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(write.error!.message).toContain('Whether the write took effect at connector "svc" is unknown');
      expect(flow.sent("create_item")).toHaveLength(1);
      expect(flow.applied).toEqual(["create_item 1"]);

      flow.answers.set("list_items", answer);
      const read = await flow.outcome("list_items");
      expect(read.error).toMatchObject({
        code: answer === "reset" ? "unavailable" : "connector_call_failed",
        retryable: true,
      });
    },
  );

  it("INV-9: a write answered a bare HTTP 400 on a modern verdict is unknown, and the renegotiation never resends it", async () => {
    // The downgrade path: a gateway (or a server now refusing the modern era)
    // answers 400 with no JSON-RPC error after the server acted.
    const flow = setup({ versionNegotiation: "auto" });
    const probes = () => flow.requests.filter((request) => request.headers.get("mcp-method") === "server/discover");
    expect((await flow.outcome("list_items")).error).toBeUndefined();
    expect(probes()).toHaveLength(1);
    flow.answers.set("create_item", 400);
    const served = await flow.outcome("create_item", { id: 1 });
    expect(served.error).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
      message: expect.stringContaining("whether it took effect is unknown"),
    });
    expect(flow.sent("create_item")).toHaveLength(1);

    // A direct call reports the uncertainty itself.
    flow.answers.set("create_item", 400);
    const ctx = flow.context();
    await flow.connector.listTools(ctx);
    const direct = await flow.connector.callTool("create_item", { id: 2 }, ctx).then(
      () => undefined,
      (failure: unknown) => failure as { code: string; retryable: boolean; writeOutcome?: string },
    );
    expect(direct).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(flow.applied).toEqual(["list_items", "create_item 1", "create_item 2"]);

    // The unrecognized 400 forgot the verdict: the next call probes again,
    // and neither write is ever sent a second time.
    const before = probes().length;
    expect((await flow.outcome("list_items")).error).toBeUndefined();
    expect(probes().length).toBeGreaterThan(before);
    expect(flow.sent("create_item")).toHaveLength(2);
    expect(flow.applied).toEqual(["list_items", "create_item 1", "create_item 2", "list_items"]);
  });

  it("INV-9: a write whose send reports a refused connection is unknown; a read stays retryable", async () => {
    // fetch can hide earlier attempts behind its last one (a 421 or HTTP/2
    // refused-stream resend, a retrying dispatcher), so a refusal proves
    // nothing about the write.
    const flow = setup();
    flow.answers.set("create_item", "refused");
    const write = await flow.outcome("create_item", { id: 1 });
    expect(write.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(write.error!.message).toContain('Whether the write took effect at connector "svc" is unknown');

    flow.answers.set("list_items", "refused");
    const read = await flow.outcome("list_items");
    expect(read.error).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("INV-9: a direct write that timed out after the server acted is unknown, never retryable, and stays a timeout", async () => {
    // A direct callTool has no invocation to report its timeout unknown.
    const flow = setup();
    const ctx = flow.context();
    // Listed hints classify the direct read as one.
    await flow.connector.listTools(ctx);
    flow.answers.set("create_item", "timeout");
    const direct = (name: string, args: Record<string, unknown>) =>
      flow.connector.callTool(name, args, ctx).then(
        () => {
          throw new Error("expected the call to fail");
        },
        (failure: unknown) => failure as { code: string; retryable: boolean; writeOutcome?: string },
      );
    expect(await direct("create_item", { id: 1 })).toMatchObject({
      code: "unavailable",
      retryable: false,
      writeOutcome: "unknown",
      details: { code: "UND_ERR_HEADERS_TIMEOUT" },
    });
    expect(flow.applied).toEqual(["create_item 1"]);

    // Control: a direct read's timeout stays retryable.
    flow.answers.set("list_items", "timeout");
    const read = await direct("list_items", {});
    expect(read).toMatchObject({ code: "unavailable", retryable: true, details: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    expect(read.writeOutcome).toBeUndefined();

    // Control: a served write's timeout is unchanged; the invocation reports it.
    const served = await flow.outcome("create_item", { id: 2 });
    expect(served.error).toMatchObject({
      code: "write_outcome_unknown",
      retryable: false,
      details: { code: "UND_ERR_HEADERS_TIMEOUT", stage: "downstream" },
      uncertainCall: { address: "svc.create_item", args: { id: 2 } },
    });
    expect(flow.applied).toEqual(["create_item 1", "list_items", "create_item 2"]);
  });
  it("INV-9: a direct write the SDK's request deadline ended after the server acted is unknown and never retryable", async () => {
    // The SDK's own deadline fails the call with `code: "timeout"`, which no
    // common-code filter may let past as retryable: each repeat applies again.
    const flow = setup();
    const ctx = flow.context({ timeoutMs: 100 });
    await flow.connector.listTools(ctx);
    flow.answers.set("create_item", "deadline");
    flow.answers.set("list_items", "deadline");
    const direct = (name: string, args: Record<string, unknown>) =>
      flow.connector.callTool(name, args, ctx).then(
        () => {
          throw new Error("expected the call to fail");
        },
        (failure: unknown) => failure as { code: string; retryable: boolean; writeOutcome?: string },
      );
    for (const id of [1, 2])
      expect(await direct("create_item", { id })).toMatchObject({
        code: "timeout",
        retryable: false,
        writeOutcome: "unknown",
      });
    expect(flow.applied).toEqual(["create_item 1", "create_item 2"]);

    // Control: a direct read's deadline stays retryable.
    const read = await direct("list_items", {});
    expect(read).toMatchObject({ code: "timeout", retryable: true });
    expect(read.writeOutcome).toBeUndefined();

    // Control: a served write's deadline is unchanged; the invocation reports it.
    const served = await new InvocationService(flow.registry, new CatalogService(flow.registry, BASE)).invoke(
      "svc.create_item",
      { id: 3 },
      { source: "call_destructive_tool", timeoutMs: 100 },
    );
    if (served.ok) throw new Error("expected the write to fail");
    expect(served.error).toMatchObject({
      code: "write_outcome_unknown",
      retryable: false,
      details: { stage: "downstream" },
      uncertainCall: { address: "svc.create_item", args: { id: 3 } },
    });
    expect(flow.applied).toEqual(["create_item 1", "create_item 2", "list_items", "create_item 3"]);
  });

  it("INV-9: a direct write the caller aborted after the server acted is unknown; its reason, redacted, stays the cause", async () => {
    const flow = setup();
    const controller = new AbortController();
    const ctx = flow.context({ signal: controller.signal });
    await flow.connector.listTools(ctx);
    flow.answers.set("create_item", "deadline");
    const pending = flow.connector.callTool("create_item", { id: 1 }, ctx).then(
      () => {
        throw new Error("expected the call to fail");
      },
      (failure: unknown) => failure as Error & { code: string },
    );
    await vi.waitFor(() => expect(flow.applied).toEqual(["create_item 1"]));
    const reason = new Error("caller left");
    controller.abort(reason);
    const error = await pending;
    expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown", details: { name: "Error" } });
    // The boundary's output redaction (#911) returns a copy of every error it
    // checked, the cause included: the same class and text, not the object.
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe(reason.message);
  });
});
