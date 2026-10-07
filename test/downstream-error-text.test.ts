import type { FetchLike, Transport } from "@modelcontextprotocol/client";
import { RegistrationRejectedError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext, Logger } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { makeRegistry, required } from "./helpers.js";

// Text a downstream or authorization server wrote, planted where each path
// would carry it: a registration body, an issuer, a runtime error. The issue
// is #695; none of it may reach an agent, a logger, or the console.
const SECRET = "planted-secret-7f3a9c";
const MCP_URL = "https://downstream.example/mcp";
const ISSUER = "https://auth.example";
const REDIRECT = "https://connecta.test/oauth/callback/svc";

/**
 * Everything a renderer could print for `value`: each error's string form,
 * stack, and own properties, followed down the `cause` chain.
 */
function rendered(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = value;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      parts.push(typeof current === "string" ? current : safeJson(current));
      break;
    }
    parts.push(String(current), current.stack ?? "", safeJson({ ...current }));
    current = current.cause;
  }
  return parts.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Every line written to the console, rendered the way a sink would. */
let consoleLines: string[] = [];

beforeEach(() => {
  consoleLines = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(rendered).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => {
    lines.push(args.map(rendered).join(" "));
  };
  return { logger: { debug: sink, info: sink, warn: sink, error: sink }, lines };
}

/** Asserts the planted text appears nowhere it was rendered. */
function expectWithheld(...renders: string[]): void {
  for (const text of [...renders, ...consoleLines]) {
    expect(text).not.toContain(SECRET);
  }
}

/**
 * An MCP endpoint that answers 401 and points at an authorization server
 * whose answers each case chooses.
 */
function downstream(overrides: {
  register?: (body: string) => Response | Promise<Response>;
  issuer?: string;
  resource?: string;
  /** Serve the handshake and challenge only tool calls: a live client's flows. */
  live?: boolean;
  /** Challenge a live tool call with a 403 `insufficient_scope`: a step-up. */
  stepUp?: boolean;
  /** Answer the n-th live tool call (from 0): a response, a 401, or a step-up 403. */
  toolCall?: (n: number, id: number | undefined) => Response | "401" | "403";
  /** Answer every live request but notifications and tool calls: the handshake. */
  handshake?: () => Response;
  /** The tools a live tools/list serves. */
  tools?: unknown[];
  /** Delay the n-th authorization-server metadata answer (from 0), then name `issuer`. */
  serverMetadata?: (n: number) => Promise<string | undefined>;
  token?: () => Response;
}): FetchLike {
  const resourceMetadataUrl = `${new URL(MCP_URL).origin}/.well-known/oauth-protected-resource`;
  const challenge = () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
    });
  let serverMetadataRequests = 0;
  let toolCalls = 0;
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.href === MCP_URL) {
      if (init.method !== "POST") return new Response(null, { status: 405 });
      if (!overrides.live) return challenge();
      const request = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (overrides.handshake && request.method !== "tools/call" && !request.method.startsWith("notifications/")) {
        return overrides.handshake();
      }
      if (request.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: request.id, result: {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        } });
      }
      if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (request.method === "tools/list" && overrides.tools) {
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: overrides.tools } });
      }
      if (request.method === "tools/call") {
        const answer = overrides.toolCall?.(toolCalls++, request.id) ?? (overrides.stepUp ? "403" : "401");
        if (answer instanceof Response) return answer;
        if (answer === "401") return challenge();
        return new Response(null, {
          status: 403,
          headers: {
            "www-authenticate":
              `Bearer error="insufficient_scope", scope="files:write", resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
    if (url.href === resourceMetadataUrl) {
      return Response.json({
        resource: overrides.resource ?? MCP_URL,
        authorization_servers: [ISSUER],
      });
    }
    if (url.href === `${ISSUER}/token`) {
      return overrides.token?.() ?? new Response(null, { status: 404 });
    }
    if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) {
      const named = await overrides.serverMetadata?.(serverMetadataRequests++);
      return Response.json({
        issuer: named ?? overrides.issuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.href === `${ISSUER}/register`) {
      const body = String(init.body ?? "");
      if (overrides.register) return await overrides.register(body);
      return Response.json({
        client_id: "connecta-client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      });
    }
    return new Response(null, { status: 404 });
  };
}

/** Every refusal body served, in order. */
let served: string[] = [];
beforeEach(() => {
  served = [];
});

/** A refusal that echoes the submitted metadata and plants a secret. */
const echoingRefusal = (status: number, error?: string) => (body: string) => {
  const text = JSON.stringify({
    ...(error ? { error } : {}),
    error_description: `refused ${SECRET}; you sent ${body}`,
  });
  served.push(text);
  return new Response(text, { status, headers: { "content-type": "application/json" } });
};

function scope(logger?: Logger): ConnectorContext {
  return {
    ...connectorContext(memoryStorage()),
    ...(logger ? { logger } : {}),
    requestScope: {},
  };
}

describe("a refused client registration", () => {
  it.each(["legacy", "auto"] as const)(
    "reaches authorize_connector as fixed text under %s negotiation",
    async (versionNegotiation) => {
      vi.stubGlobal("fetch", downstream({ register: echoingRefusal(400, "invalid_client_metadata") }));
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation });
      const { logger, lines } = capturingLogger();
      const started = await connector.startAuth!(scope(logger));

      expect(started.state).toBe("error");
      expect(started.message).toContain('Connector "svc" could not register an OAuth client with https://auth.example');
      expect(started.message).toContain("HTTP 400 with OAuth error invalid_client_metadata");
      // Neither the body nor the metadata connecta submitted is echoed.
      expect(started.message).not.toContain("redirect_uris");
      expect(started.message).not.toContain("refused");
      expectWithheld(rendered(started), ...lines);
    },
  );

  it.each([
    [400, "invalid_redirect_uri"],
    [400, undefined],
    [400, "not-a-registered-code"],
    [503, "temporarily_unavailable"],
  ] as const)(
    "throws HTTP %i (%s) from a call with the classification the SDK's error had",
    async (status, code) => {
      vi.stubGlobal("fetch", downstream({ register: echoingRefusal(status, code) }));
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
      const { logger, lines } = capturingLogger();
      const context = scope(logger);
      const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
      await connector.closeScope!(context);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(`answered HTTP ${status}`);
      if (code === "invalid_redirect_uri" || code === "temporarily_unavailable") {
        expect(message).toContain(`with OAuth error ${code}`);
      } else {
        expect(message).not.toContain("with OAuth error");
      }
      expect((error as Error).cause).toBeUndefined();

      // The verdict is the one the SDK's own error, body and all, would have
      // received, under both the default and the catalog's fallback code.
      expect(served).toHaveLength(1);
      const original = new RegistrationRejectedError({
        status,
        body: required(served[0]),
        submittedMetadata: { redirect_uris: [REDIRECT] },
      });
      for (const fallback of ["connector_call_failed", "catalog_lookup_failed"]) {
        const before = classifyCallError(original, fallback);
        const after = classifyCallError(error, fallback);
        expect({ code: after.code, retryable: after.retryable }).toEqual({
          code: before.code,
          retryable: before.retryable,
        });
      }
      expect(classifyCallError(error).retryable).toBe(status === 503);
      expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
    },
  );

  it("keeps the planted text out of every meta-tool result and the deployment log", async () => {
    vi.stubGlobal("fetch", downstream({ register: echoingRefusal(400, "invalid_client_metadata") }));
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([connector], { logger });
    const tools = createMetaTools(registry, "https://connecta.test", { canManageAuth: () => true });

    const call = await tools.callTool({ address: "svc.read", resultMode: "value" });
    const search = await tools.searchTools({ query: "read", connector: "svc" });
    const authorize = await tools.authorizeConnector({ connector: "svc" });

    expect(JSON.stringify(call)).toContain("could not register an OAuth client");
    expectWithheld(JSON.stringify(call), JSON.stringify(search), JSON.stringify(authorize), ...lines);
  });
});

describe("an OAuth discovery failure", () => {
  it.each([
    ["an issuer the metadata names", { issuer: `${ISSUER}/?${SECRET}` }, " (IssuerMismatchError)"],
    ["a protected resource it does not serve", { resource: `https://elsewhere.example/${SECRET}` }, ""],
  ] as const)("withholds %s", async (_label, overrides, kind) => {
    vi.stubGlobal("fetch", downstream(overrides));
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const { logger, lines } = capturingLogger();
    const started = await connector.startAuth!(scope(logger));
    const context = scope(logger);
    const error = await connector.listTools(context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);

    expect(started).toMatchObject({ state: "error" });
    expect(started.message).toContain(`Connector "svc" OAuth discovery with`);
    expect(started.message).toContain(`failed${kind}.`);
    expect((error as Error).message).toContain("OAuth discovery with");
    expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
    expectWithheld(rendered(started), rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });
});

describe("a downstream transport failure", () => {
  /** A runtime error quoting the request it failed, as some runtimes do. */
  const planted = () =>
    new TypeError(`fetch failed for ${MCP_URL}?token=${SECRET}`, {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), {
        code: "ECONNREFUSED",
      }),
    });

  it.each([
    ["a static-header connector", { headers: { "x-api-key": "k" } }],
    ["an OAuth connector", undefined],
  ] as const)("drops the runtime's error from %s and keeps origin and errno", async (_label, headers) => {
    vi.stubGlobal("fetch", async () => {
      throw planted();
    });
    const connector = remoteMcp("svc", {
      url: MCP_URL,
      versionNegotiation: "legacy",
      ...(headers ? { auth: { type: "headers", headers: headers.headers } } : { auth: { type: "oauth" } }),
    });
    const { logger, lines } = capturingLogger();
    const context = scope(logger);
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);

    expect((error as Error).cause).toBeUndefined();
    expect(classifyCallError(error)).toMatchObject({
      code: "unavailable",
      retryable: true,
      details: { host: "https://downstream.example", code: "ECONNREFUSED" },
    });
    expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });

  it("keeps it out of a meta-tool result and the deployment log", async () => {
    vi.stubGlobal("fetch", async () => {
      throw planted();
    });
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: "legacy" });
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([connector], { logger });
    const tools = createMetaTools(registry, "https://connecta.test");
    const call = await tools.callTool({ address: "svc.read", resultMode: "value" });

    expect(JSON.stringify(call)).toContain("unavailable");
    expectWithheld(JSON.stringify(call), ...lines);
  });
});

describe("an OAuth flow on a live client", () => {
  const modes = ["legacy", "auto"] as const;

  /**
   * Connect without credentials, which the live downstream allows, then call
   * a tool: its 401 starts the flow under test on the connected client.
   */
  async function liveFailure(
    fetchStub: FetchLike,
    versionNegotiation: (typeof modes)[number],
    storage = memoryStorage(),
  ) {
    vi.stubGlobal("fetch", fetchStub);
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(storage), logger, requestScope: {} };
    expect(await connector.status!(context)).toMatchObject({ state: "ok" });
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(error).toBeInstanceOf(Error);
    const classified = classifyCallError(error);
    expectWithheld(rendered(error), JSON.stringify(classified), ...lines);
    return { error: error as Error, classified };
  }

  it.each(modes)("names discovery and its host for an issuer the metadata names (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      downstream({ live: true, issuer: `${ISSUER}/?${SECRET}` }),
      mode,
    );
    expect(error.message).toContain(
      'Connector "svc" OAuth discovery with https://auth.example failed (IssuerMismatchError).',
    );
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("bounds a step-up flow the same way (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      downstream({ live: true, stepUp: true, issuer: `${ISSUER}/?${SECRET}` }),
      mode,
    );
    expect(error.message).toContain(
      'Connector "svc" OAuth discovery with https://auth.example failed (IssuerMismatchError).',
    );
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("names discovery and its host for a resource it does not serve (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      downstream({ live: true, resource: `https://elsewhere.example/${SECRET}` }),
      mode,
    );
    expect(error.message).toContain('Connector "svc" OAuth discovery with https://auth.example failed.');
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("names the registration endpoint for a refused registration (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      downstream({ live: true, register: echoingRefusal(400, "invalid_client_metadata") }),
      mode,
    );
    expect(error.message).toContain(
      "could not register an OAuth client with https://auth.example: the registration endpoint answered HTTP 400 with OAuth error invalid_client_metadata.",
    );
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(
    modes.flatMap((mode) => [
      [mode, 500, "unavailable", true],
      [mode, 400, "auth_required", false],
    ] as const),
  )("keeps a refused refresh's body out of the verdict (%s, HTTP %i)", async (mode, status, code, retryable) => {
    const storage = memoryStorage();
    const seeder = new KvOAuthProvider("svc", storage, REDIRECT, undefined, true);
    await seeder.saveClientInformation(
      { client_id: "connecta-client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
      { issuer: ISSUER },
    );
    await seeder.saveTokens(
      { access_token: "access-old", token_type: "Bearer", refresh_token: "refresh-old" },
      { issuer: ISSUER },
    );
    const { error, classified } = await liveFailure(
      downstream({
        live: true,
        token: () =>
          Response.json({ error: "invalid_grant", error_description: `refused ${SECRET}` }, { status }),
      }),
      mode,
      storage,
    );
    expect(classified).toMatchObject({ code, retryable });
    if (status === 500) expect(error.message).toContain("could not refresh its OAuth grant");
  });

  it.each(modes)("tells concurrent flows' failures by each flow's own last request (%s)", async (mode) => {
    // Two calls on one client each start a flow. The second flow's last
    // request, its server metadata, is answered only once the first flow has
    // sent its registration, and that answer fails the second flow: so it
    // fails while the latest request anywhere on the transport is the first
    // flow's registration, the attribution a shared trail would get wrong.
    // The first flow's registration is answered once the second has failed.
    let secondMetadataArrived!: () => void;
    const secondArrived = new Promise<void>((resolve) => (secondMetadataArrived = resolve));
    let registrationArrived!: () => void;
    const registering = new Promise<void>((resolve) => (registrationArrived = resolve));
    let secondSettled: Promise<unknown> = Promise.resolve();
    vi.stubGlobal(
      "fetch",
      downstream({
        live: true,
        serverMetadata: async (n) => {
          if (n === 0) {
            await secondArrived;
            return undefined;
          }
          secondMetadataArrived();
          await registering;
          return `${ISSUER}/?${SECRET}`;
        },
        register: async (body) => {
          registrationArrived();
          await secondSettled;
          return echoingRefusal(400, "invalid_redirect_uri")(body);
        },
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: mode });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    expect(await connector.status!(context)).toMatchObject({ state: "ok" });
    const first = connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    const second = connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    secondSettled = second;
    const [firstError, secondError] = (await Promise.all([first, second])) as Error[];
    await connector.closeScope!(context);

    expect(firstError?.message).toContain(
      "could not register an OAuth client with https://auth.example: the registration endpoint answered HTTP 400 with OAuth error invalid_redirect_uri.",
    );
    expect(secondError?.message).toContain(
      'Connector "svc" OAuth discovery with https://auth.example failed (IssuerMismatchError).',
    );
    expectWithheld(rendered(firstError), rendered(secondError), ...lines);
  });
});

describe("a credential the runtime refuses to send", () => {
  it.each(["legacy", "auto"] as const)(
    "is still auth_required once the transport error drops the runtime's text (%s)",
    async (versionNegotiation) => {
      const secret = "private-header-secret";
      vi.stubGlobal("fetch", async () => {
        throw new TypeError(`Cannot send Bearer ${secret}`);
      });
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "credential" }, versionNegotiation });
      const context = {
        ...connectorContext(memoryStorage()),
        requestScope: {},
        credential: { get: async () => secret },
      } as unknown as ConnectorContext;
      const error = await connector.listTools(context).then(() => null, (err: unknown) => err);
      await connector.closeScope!(context);
      expect(classifyCallError(error)).toMatchObject({ code: "auth_required", retryable: false });
      expect((error as Error).message).toContain("could not send its stored credential as a header");
      expect(rendered(error)).not.toContain(secret);
    },
  );
});

describe("status", () => {
  it("keeps the origin and errno of a transport failure in its message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed ${SECRET}`, { cause: { code: "ECONNREFUSED" } });
    });
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: "legacy" });
    const context = scope();
    const status = await connector.status!(context);
    await connector.closeScope!(context);
    expect(status).toMatchObject({
      state: "error",
      // The failure's record: step, origin, class, code, and errno.
      message:
        'Connector "svc" MCP handshake with https://downstream.example failed (ConnectorCallError, unavailable, ECONNREFUSED).',
    });
    expectWithheld(JSON.stringify(status));
  });
});

describe("a reply the SDK cannot parse", () => {
  const modes = ["legacy", "auto"] as const;

  async function liveCall(
    toolCall: (n: number, id: number | undefined) => Response,
    versionNegotiation: (typeof modes)[number],
  ) {
    vi.stubGlobal("fetch", downstream({ live: true, toolCall }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    const classified = classifyCallError(error);
    expectWithheld(rendered(error), JSON.stringify(classified), ...lines);
    return { error: error as Error, classified };
  }

  it.each(modes)("withholds a JSON parser's account of a 200 reply (%s)", async (mode) => {
    const { error, classified } = await liveCall(
      () => new Response(`${SECRET} is not json`, { headers: { "content-type": "application/json" } }),
      mode,
    );
    expect(error.message).toContain(
      'Connector "svc" tools/call with https://downstream.example failed (SyntaxError).',
    );
    // A SyntaxError's verdict, as it had before its text was withheld.
    expect(classified).toEqual({ ...classifyCallError(new SyntaxError("Unexpected token")), message: error.message });
  });

  it.each(modes)("withholds a parser's account of the handshake's reply (%s)", async (mode) => {
    vi.stubGlobal("fetch", downstream({
      live: true,
      handshake: () => new Response(`${SECRET} is not json`, { headers: { "content-type": "application/json" } }),
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    const status = await connector.status!(context);
    const error = await connector.listTools(context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(status).toMatchObject({ state: "error", message: expect.stringContaining('Connector "svc" MCP handshake with https://downstream.example failed') });
    expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
    expectWithheld(JSON.stringify(status), rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });

  it.each(modes)("withholds a JSON-RPC schema validator's account of a 200 reply (%s)", async (mode) => {
    const { error, classified } = await liveCall(
      () => Response.json({ jsonrpc: "2.0", id: SECRET, planted: { [SECRET]: true } }),
      mode,
    );
    expect(error.message).toContain('Connector "svc" tools/call with https://downstream.example failed');
    expect(classified).toMatchObject({ code: "connector_call_failed" });
  });

  it.each(modes)("keeps an SSE frame's parser account out of a call that never got an answer (%s)", async (mode) => {
    vi.stubGlobal("fetch", downstream({
      live: true,
      toolCall: () =>
        new Response(`event: message\ndata: ${SECRET} is not json\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = {
      ...connectorContext(memoryStorage()),
      logger,
      requestScope: {},
      timeoutMs: 500,
    };
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    // The SDK reports a frame it cannot parse only to the transport's
    // `onerror`, which nothing renders; the call itself runs out of time.
    expect(classifyCallError(error)).toMatchObject({ code: "timeout", retryable: true });
    expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });

  it.each(modes)("withholds a result validator's account of a tool result (%s)", async (mode) => {
    const { error, classified } = await liveCall(
      (_n, id) => Response.json({ jsonrpc: "2.0", id, result: { content: SECRET } }),
      mode,
    );
    expect(error.message).toContain('Connector "svc" tools/call with https://downstream.example failed (SdkError).');
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("still relays the downstream's own JSON-RPC answer to the call (%s)", async (mode) => {
    vi.stubGlobal("fetch", downstream({
      live: true,
      toolCall: (_n, id) =>
        Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "the tool says: bad input" } }),
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const context = scope();
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(classifyCallError(error)).toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("the tool says: bad input"),
    });
  });
});

describe("a cancellation in an OAuth flow", () => {
  it.each(["legacy", "auto"] as const)(
    "withholds an AbortError the request did not raise and keeps its verdict (%s)",
    async (versionNegotiation) => {
      const { error, classified } = await (async () => {
        vi.stubGlobal("fetch", downstream({
          register: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new DOMException(`stream closed ${SECRET}`, "AbortError"));
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            ),
        }));
        const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation });
        const { logger, lines } = capturingLogger();
        const context = scope(logger);
        const thrown = await connector.listTools(context).then(() => null, (err: unknown) => err);
        await connector.closeScope!(context);
        const verdict = classifyCallError(thrown);
        expectWithheld(rendered(thrown), JSON.stringify(verdict), ...lines);
        return { error: thrown as Error, classified: verdict };
      })();
      expect(error.message).toContain(
        'Connector "svc" OAuth client registration with https://auth.example failed (AbortError).',
      );
      expect(classified).toMatchObject({ code: "timeout", retryable: true });
    },
  );

  it("passes the request's own abort reason through unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("caller left");
    // Aborted while discovery is answered: the flow's next request is
    // refused with the request's own reason, and that error is the caller's.
    vi.stubGlobal("fetch", downstream({
      serverMetadata: async () => {
        controller.abort(reason);
        return undefined;
      },
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const context: ConnectorContext = { ...scope(), signal: controller.signal };
    const thrown = await connector.listTools(context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(thrown).toBe(reason);
  });
});

describe("the SDK seams OAuth flows are bounded at", () => {
  it("refuses to build a transport whose step-up seam is gone, rather than run flows unbounded", async () => {
    const prototype = StreamableHTTPClientTransport.prototype as unknown as Record<string, unknown>;
    const original = prototype["_stepUpAuthorize"];
    expect(typeof original).toBe("function");
    prototype["_stepUpAuthorize"] = undefined;
    try {
      vi.stubGlobal("fetch", downstream({ live: true }));
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
      const context = scope();
      const status = await connector.status!(context);
      await connector.closeScope!(context);
      expect(status).toMatchObject({ state: "error" });
      expect(status.message).toContain("(UnboundOAuthFlowsError)");
    } finally {
      prototype["_stepUpAuthorize"] = original;
    }
  });

  it.each(["legacy", "auto"] as const)(
    "tells a step-up flow and a 401 flow running at once apart (%s)",
    async (mode) => {
      // Whichever flow asks for server metadata first is held at
      // registration until the other has failed, on server metadata answered
      // only after that registration was sent. Which flow wins that race is
      // the SDK's, so the two verdicts are matched as a pair.
      let secondMetadataArrived!: () => void;
      const secondArrived = new Promise<void>((resolve) => (secondMetadataArrived = resolve));
      let registrationArrived!: () => void;
      const registering = new Promise<void>((resolve) => (registrationArrived = resolve));
      let otherSettled: Promise<unknown> = Promise.resolve();
      vi.stubGlobal("fetch", downstream({
        live: true,
        toolCall: (n) => (n === 0 ? "403" : "401"),
        serverMetadata: async (n) => {
          if (n === 0) {
            await secondArrived;
            return undefined;
          }
          secondMetadataArrived();
          await registering;
          return `${ISSUER}/?${SECRET}`;
        },
        register: async (body) => {
          registrationArrived();
          await otherSettled;
          return echoingRefusal(400, "invalid_redirect_uri")(body);
        },
      }));
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: mode });
      const { logger, lines } = capturingLogger();
      const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
      expect(await connector.status!(context)).toMatchObject({ state: "ok" });
      const stepUp = connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
      const challenged = connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
      // The registering call cannot settle before its registration answers,
      // so the first to settle is the other one.
      otherSettled = Promise.race([stepUp, challenged]);
      const errors = (await Promise.all([stepUp, challenged])) as Error[];
      await connector.closeScope!(context);

      const registration =
        "could not register an OAuth client with https://auth.example: the registration endpoint answered HTTP 400 with OAuth error invalid_redirect_uri.";
      const discovery = 'Connector "svc" OAuth discovery with https://auth.example failed (IssuerMismatchError).';
      const told = errors.map((error) =>
        error.message.includes(registration) ? "registration" : error.message.includes(discovery) ? "discovery" : error.message,
      );
      expect(told.sort()).toEqual(["discovery", "registration"]);
      expectWithheld(...errors.map(rendered), ...lines);
    },
  );
});

describe("the MCP boundary is an allow-list", () => {
  const modes = ["legacy", "auto"] as const;

  /** A live call that fails as `toolCall` answers, rendered everywhere it could be. */
  async function liveFailure(
    toolCall: (n: number, id: number | undefined) => Response,
    versionNegotiation: (typeof modes)[number],
    handshake?: () => Response,
    tools?: unknown[],
  ) {
    vi.stubGlobal("fetch", downstream({
      live: true,
      toolCall,
      ...(handshake ? { handshake } : {}),
      ...(tools ? { tools } : {}),
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    try {
      // tools/list first, so a declared output schema reaches the call.
      if (!handshake) await connector.listTools(context).catch(() => undefined);
      const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
      const classified = classifyCallError(error);
      expectWithheld(rendered(error), JSON.stringify(classified), ...lines);
      return { error: error as Error, classified };
    } finally {
      await connector.closeScope!(context);
    }
  }

  it.each(modes)("withholds an output schema the SDK cannot compile, still invalid_args (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      (_n, id) => Response.json({ jsonrpc: "2.0", id, result: { content: [], structuredContent: {} } }),
      mode,
      undefined,
      [{ name: "read", inputSchema: { type: "object" }, outputSchema: { type: SECRET } }],
    );
    // AJV (Node) refuses to compile the schema; @cfworker/json-schema
    // (workerd) compiles it and the result then fails it. Either way the
    // SDK's check is told in connecta's words.
    expect(error.message).toMatch(
      /tools\/call with https:\/\/downstream\.example failed \(ProtocolError\): the (tool's declared output schema could not be compiled|result did not match the tool's declared output schema)\./,
    );
    expect(classified).toMatchObject({ code: "invalid_args", retryable: false });
  });

  it.each(modes)("withholds a content type the SDK refuses (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      () => new Response("ok", { headers: { "content-type": `application/${SECRET}` } }),
      mode,
    );
    expect(error.message).toContain('Connector "svc" tools/call with https://downstream.example failed (SdkError).');
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("withholds a reply stream the runtime could not finish reading (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError(`stream failed ${SECRET}`));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      mode,
    );
    expect(error.message).toContain('Connector "svc" tools/call with https://downstream.example failed (TypeError).');
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("withholds a protocol version the handshake cannot accept (%s)", async (mode) => {
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit = {}) => {
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (request.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: request.id, result: {
          protocolVersion: SECRET, capabilities: {}, serverInfo: { name: "test", version: "1" },
        } });
      }
      if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    });
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    const status = await connector.status!(context);
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(status).toMatchObject({ state: "error", message: expect.stringContaining("MCP handshake with https://downstream.example failed") });
    expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
    expectWithheld(JSON.stringify(status), rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });

  it.each(modes)("withholds a non-4xx refusal's body and names its status (%s)", async (mode) => {
    const { error, classified } = await liveFailure(() => new Response(SECRET, { status: 500 }), mode);
    expect(error.message).toContain(
      'Connector "svc" tools/call with https://downstream.example failed with HTTP 500 (SdkHttpError).',
    );
    expect(classified).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each(modes)("still relays a 4xx refusal, the settled exception (%s)", async (mode) => {
    vi.stubGlobal("fetch", downstream({
      live: true,
      toolCall: () => Response.json({ error: { message: "the tool says: bad input" } }, { status: 400 }),
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const context = scope();
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(classifyCallError(error)).toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("the tool says: bad input"),
    });
  });

  it.each(modes)("passes a call's own abort reason through by identity, whatever its class (%s)", async (mode) => {
    const controller = new AbortController();
    const reason = Object.assign(new SyntaxError("caller left"), { name: "AbortError" });
    vi.stubGlobal("fetch", downstream({
      live: true,
      toolCall: () => {
        controller.abort(reason);
        return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
      },
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const context: ConnectorContext = { ...scope(), signal: controller.signal };
    const error = await connector.callTool("read", {}, context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    // The SDK rejects a request it cancels with an SdkError of the reason's
    // own text; that passes as the SDK wrote it, never rewritten.
    expect((error as Error).message).toBe(String(reason));
  });

  it("passes a handshake's own abort reason through by identity, whatever its class", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new SyntaxError("caller left"), { name: "AbortError" });
    vi.stubGlobal("fetch", downstream({
      serverMetadata: async () => {
        controller.abort(reason);
        return undefined;
      },
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const context: ConnectorContext = { ...scope(), signal: controller.signal };
    const thrown = await connector.listTools(context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    expect(thrown).toBe(reason);
  });

  /** An error class nothing at the boundary has ever heard of. */
  class PlantedError extends Error {
    override name = "PlantedError";
  }

  /**
   * A transport that completes the legacy handshake and throws a
   * `PlantedError` wherever `fail` says, so each boundary meets it.
   */
  function scriptedTransport(fail: (step: string) => boolean): Transport {
    const transport: Transport = {
      async start() {
        if (fail("start")) throw new PlantedError(`refused ${SECRET}`);
      },
      async send(message) {
        const request = message as { id?: number; method?: string; params?: { protocolVersion?: string } };
        if (request.method !== undefined && fail(request.method)) throw new PlantedError(`refused ${SECRET}`);
        if (request.method === "initialize") {
          queueMicrotask(() =>
            transport.onmessage?.({
              jsonrpc: "2.0",
              id: request.id as number,
              result: {
                protocolVersion: request.params?.protocolVersion as string,
                capabilities: { tools: {} },
                serverInfo: { name: "test", version: "1" },
              },
            } as never),
          );
        }
      },
      async close() {
        transport.onclose?.();
      },
    };
    return transport;
  }

  it.each([
    ["MCP handshake", "start", "status"],
    ["tools/list", "tools/list", "list"],
    ["tools/call", "tools/call", "call"],
  ] as const)("withholds an unknown error class at the %s boundary", async (step, at, action) => {
    const connector = remoteMcp("svc", {
      url: MCP_URL,
      versionNegotiation: "legacy",
      _transportFactory: () => scriptedTransport((where) => where === at),
    });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    const outcome =
      action === "status"
        ? await connector.status!(context)
        : await (action === "list" ? connector.listTools(context) : connector.callTool("read", {}, context)).then(
            () => null,
            (err: unknown) => err,
          );
    await connector.closeScope!(context);
    const text = action === "status" ? JSON.stringify(outcome) : rendered(outcome);
    expect(text).toContain(`${step} with https://downstream.example failed (PlantedError).`);
    if (action !== "status") {
      expect(classifyCallError(outcome)).toEqual({
        ...classifyCallError(new PlantedError(`refused ${SECRET}`)),
        message: (outcome as Error).message,
      });
      expectWithheld(JSON.stringify(classifyCallError(outcome)));
    }
    expectWithheld(text, ...lines);
  });

  it("withholds an unknown error class at the OAuth flow boundary", async () => {
    vi.stubGlobal("fetch", downstream({
      serverMetadata: async () => {
        throw new PlantedError(`refused ${SECRET}`);
      },
    }));
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const { logger, lines } = capturingLogger();
    const context = scope(logger);
    const error = await connector.listTools(context).then(() => null, (err: unknown) => err);
    await connector.closeScope!(context);
    // The stub's throw is a fetch rejection, which connecta's own fetch turns
    // into its unreachable-host error before any flow sees it.
    expect(classifyCallError(error)).toMatchObject({ code: "unavailable", retryable: true });
    expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });

  it("withholds an unknown error class an OAuth flow raises after its request", async () => {
    vi.stubGlobal("fetch", downstream({ resource: MCP_URL }));
    const original = KvOAuthProvider.prototype.saveDiscoveryState;
    KvOAuthProvider.prototype.saveDiscoveryState = async function () {
      throw new PlantedError(`refused ${SECRET}`);
    };
    try {
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
      const { logger, lines } = capturingLogger();
      const context = scope(logger);
      const error = await connector.listTools(context).then(() => null, (err: unknown) => err);
      await connector.closeScope!(context);
      expect((error as Error).message).toContain(
        'Connector "svc" OAuth discovery with https://auth.example failed (PlantedError).',
      );
      expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
    } finally {
      KvOAuthProvider.prototype.saveDiscoveryState = original;
    }
  });
});

describe("an api() handler that reads a reply it cannot parse", () => {
  it("withholds the parser's account, keeps its verdict, and names no host", async () => {
    vi.stubGlobal("fetch", async () => new Response(`${SECRET} is not json`));
    const connector = api("svc", {
      tools: [{
        name: "read",
        description: "Read a thing",
        annotations: { readOnlyHint: true },
        handler: async () => (await fetch("https://api.example/read")).json(),
      }],
    });
    const error = await connector.callTool("read", {}, connectorContext()).then(() => null, (err: unknown) => err);
    expect((error as Error).message).toBe(
      'Connector "svc" tool "read" handler failed (SyntaxError). Its text is withheld because it can quote what the downstream sent.',
    );
    expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(classifyCallError(error)).not.toHaveProperty("details");
    expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)));
  });
});
