import type { FetchLike } from "@modelcontextprotocol/client";
import { ProtocolError } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { attachCallClassification } from "../src/call-classification.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CatalogService } from "../src/catalog-service.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { failureRecord } from "../src/operator-record.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext, Logger } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { makeRegistry } from "./helpers.js";

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
  endpoint?: string;
  authorizationServer?: string;
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
  /** Refuse a catalog page after a successful handshake. */
  listPage?: () => Response | "401";
  /** Delay the n-th authorization-server metadata answer (from 0), then name `issuer`. */
  serverMetadata?: (n: number) => Promise<string | undefined>;
  token?: () => Response;
}): FetchLike {
  const endpoint = overrides.endpoint ?? MCP_URL;
  const authorizationServer = overrides.authorizationServer ?? ISSUER;
  const resourceMetadataUrl = `${new URL(endpoint).origin}/.well-known/oauth-protected-resource`;
  const challenge = () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
    });
  let serverMetadataRequests = 0;
  let toolCalls = 0;
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.href === endpoint) {
      if (init.method !== "POST") return new Response(null, { status: 405 });
      if (!overrides.live) return challenge();
      const request = JSON.parse(String(init.body)) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (overrides.handshake && request.method !== "tools/call" && !request.method.startsWith("notifications/")) {
        return overrides.handshake();
      }
      if (request.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "test", version: "1" },
          },
        });
      }
      if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (request.method === "tools/list") {
        const answer = overrides.listPage?.();
        if (answer === "401") return challenge();
        if (answer instanceof Response) return answer;
        if (overrides.tools)
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: overrides.tools } });
      }
      if (request.method === "tools/call") {
        const answer = overrides.toolCall?.(toolCalls++, request.id) ?? (overrides.stepUp ? "403" : "401");
        if (answer instanceof Response) return answer;
        if (answer === "401") return challenge();
        return new Response(null, {
          status: 403,
          headers: {
            "www-authenticate": `Bearer error="insufficient_scope", scope="files:write", resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
    if (url.href === resourceMetadataUrl) {
      return Response.json({
        resource: overrides.resource ?? endpoint,
        authorization_servers: [authorizationServer],
      });
    }
    if (url.href === `${authorizationServer}/token`) {
      return overrides.token?.() ?? new Response(null, { status: 404 });
    }
    if (url.href === `${authorizationServer}/.well-known/oauth-authorization-server`) {
      const named = await overrides.serverMetadata?.(serverMetadataRequests++);
      return Response.json({
        issuer: named ?? overrides.issuer ?? authorizationServer,
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        registration_endpoint: `${authorizationServer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.href === `${authorizationServer}/register`) {
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

/**
 * A call's context as an invocation of a read builds it: these suites call
 * `read` directly, and a remote MCP call outside an invocation with no
 * definition to go on is a write (INV-1).
 */
function readContext(context: ConnectorContext): ConnectorContext {
  attachCallClassification(context, "read");
  return context;
}

function scope(logger?: Logger): ConnectorContext {
  return {
    ...connectorContext(memoryStorage()),
    ...(logger ? { logger } : {}),
    requestScope: {},
  };
}

describe("a refused client registration", () => {
  it("keeps the planted text out of every meta-tool result and the deployment log", async () => {
    vi.stubGlobal("fetch", downstream({ register: echoingRefusal(400, "invalid_client_metadata") }));
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const { logger, lines } = capturingLogger();
    const registry = makeRegistry([connector], { logger });
    const tools = createMetaTools(registry, "https://connecta.test", { canManageAuth: () => true });

    const call = await tools.callTool({ address: "svc.read", resultMode: "value" });
    const search = await tools.searchTools({ query: "read", connector: "svc" });
    const authorize = await tools.authorizeConnector({ connector: "svc" });

    expect(JSON.stringify(call)).toContain("requires authorization");
    expect(served).toHaveLength(0);
    expectWithheld(JSON.stringify(call), JSON.stringify(search), JSON.stringify(authorize), ...lines);
  });
});

describe("an OAuth flow on a live client", () => {
  const modes = ["legacy", "auto"] as const;

  /**
   * Connect without credentials, which the live downstream allows, then call
   * a tool in an explicitly authorized fixture: its 401 reaches the OAuth
   * failure boundary under test on the connected client.
   */
  async function liveFailure(
    fetchStub: FetchLike,
    versionNegotiation: (typeof modes)[number],
    storage = memoryStorage(),
  ) {
    vi.stubGlobal("fetch", fetchStub);
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation });
    const { logger, lines } = capturingLogger();
    const context = readContext({
      ...connectorContext(storage),
      logger,
      requestScope: {},
      allowAuthorization: true,
    });
    expect(await connector.status!(context)).toMatchObject({ state: "ok" });
    const error = await connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    await connector.closeScope!(context);
    expect(error).toBeInstanceOf(Error);
    const classified = classifyCallError(error);
    expectWithheld(rendered(error), JSON.stringify(classified), ...lines);
    return { error: error as Error, classified };
  }

  it.each(modes)("INV-6 INV-9: refuses a step-up as permission denial without OAuth (%s)", async (mode) => {
    const { error, classified } = await liveFailure(
      downstream({ live: true, stepUp: true, issuer: `${ISSUER}/?${SECRET}` }),
      mode,
    );
    expect(error.message).toContain("Check the account's permissions");
    expect(error.message).not.toMatch(/authorize_connector|retry authorization/);
    expect(classified).toMatchObject({ code: "provider_permission_denied", retryable: false });
  });

  it.each(
    modes.flatMap(
      (mode) =>
        [
          [mode, 500, "downstream_oauth_required", false],
          [mode, 400, "downstream_oauth_required", false],
        ] as const,
    ),
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
        token: () => Response.json({ error: "invalid_grant", error_description: `refused ${SECRET}` }, { status }),
      }),
      mode,
      storage,
    );
    expect(classified).toMatchObject({ code, retryable });
    expect(error.message).toContain("requires authorization");
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
    let aFlowSettled: Promise<unknown> = Promise.resolve();
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
          await aFlowSettled;
          return echoingRefusal(400, "invalid_redirect_uri")(body);
        },
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: mode });
    const { logger, lines } = capturingLogger();
    const context = readContext({
      ...connectorContext(memoryStorage()),
      logger,
      requestScope: {},
      allowAuthorization: true,
    });
    expect(await connector.status!(context)).toMatchObject({ state: "ok" });
    const first = connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    const second = connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    aFlowSettled = Promise.race([first, second]);
    const [firstError, secondError] = (await Promise.all([first, second])) as Error[];
    await connector.closeScope!(context);

    // Cache reads can reorder dispatch. The two flow-local trails must still
    // identify one failed registration and one failed metadata request.
    const messages = [firstError?.message, secondError?.message];
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "could not register an OAuth client with https://auth.example: the registration endpoint answered HTTP 400 with OAuth error invalid_redirect_uri.",
        ),
        expect.stringContaining(
          'Connector "svc" OAuth discovery with https://auth.example failed (IssuerMismatchError).',
        ),
      ]),
    );
    expectWithheld(rendered(firstError), rendered(secondError), ...lines);
  });
});

describe("a reply the SDK cannot parse", () => {
  const modes = ["legacy", "auto"] as const;

  it.each(modes)("keeps an SSE frame's parser account out of a call that never got an answer (%s)", async (mode) => {
    vi.stubGlobal(
      "fetch",
      downstream({
        live: true,
        toolCall: () =>
          new Response(`event: message\ndata: ${SECRET} is not json\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = {
      ...connectorContext(memoryStorage()),
      logger,
      requestScope: {},
      timeoutMs: 500,
    };
    const error = await connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    await connector.closeScope!(context);
    // The SDK reports a frame it cannot parse only to the transport's
    // `onerror`, which nothing renders; the call itself runs out of time.
    // The unlisted tool is a direct write, so the timeout is an unknown outcome.
    expect(classifyCallError(error)).toMatchObject({ code: "timeout", retryable: false, writeOutcome: "unknown" });
    expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), ...lines);
  });

  it.each(modes)("still relays the downstream's own JSON-RPC answer to the call (%s)", async (mode) => {
    vi.stubGlobal(
      "fetch",
      downstream({
        live: true,
        toolCall: (_n, id) =>
          Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "the tool says: bad input" } }),
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const context = scope();
    const error = await connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    await connector.closeScope!(context);
    expect(classifyCallError(error)).toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("the tool says: bad input"),
    });
  });
});

describe("the SDK seams OAuth flows are bounded at", () => {
  it.each(["legacy", "auto"] as const)(
    "INV-6 INV-9: keeps a 403 permission denial independent of a concurrent 401 OAuth flow (%s)",
    async (mode) => {
      let registrations = 0;
      vi.stubGlobal(
        "fetch",
        downstream({
          live: true,
          toolCall: (n) => (n === 0 ? "403" : "401"),
          register: (body) => {
            registrations++;
            return echoingRefusal(400, "invalid_redirect_uri")(body);
          },
        }),
      );
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation: mode });
      const context = { ...scope(), allowAuthorization: true };
      expect(await connector.status!(context)).toMatchObject({ state: "ok" });
      try {
        const errors = await Promise.all(
          [0, 1].map(() => connector.callTool("write", {}, context).catch((error: unknown) => error)),
        );
        // The 401's renewal failed at registration, so its write keeps the
        // authorization verdict with an unknown outcome.
        expect(errors.map((error) => classifyCallError(error).code).sort()).toEqual([
          "downstream_oauth_required",
          "provider_permission_denied",
        ]);
        expect(errors.find((error) => classifyCallError(error).code === "downstream_oauth_required")).toMatchObject({
          retryable: false,
          writeOutcome: "unknown",
        });
        expect(registrations).toBe(1);
        expectWithheld(...errors.map(rendered));
      } finally {
        await connector.closeScope!(context);
      }
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
    vi.stubGlobal(
      "fetch",
      downstream({
        live: true,
        toolCall,
        ...(handshake ? { handshake } : {}),
        ...(tools ? { tools } : {}),
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation });
    const { logger, lines } = capturingLogger();
    const context: ConnectorContext = { ...connectorContext(memoryStorage()), logger, requestScope: {} };
    try {
      // tools/list first, so a declared output schema reaches the call.
      if (!handshake) await connector.listTools(context).catch(() => undefined);
      const error = await connector.callTool("read", {}, context).then(
        () => null,
        (err: unknown) => err,
      );
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

  it.each(modes)("still relays a 4xx refusal, the settled exception (%s)", async (mode) => {
    vi.stubGlobal(
      "fetch",
      downstream({
        live: true,
        toolCall: () => Response.json({ error: { message: "the tool says: bad input" } }, { status: 400 }),
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const context = scope();
    const error = await connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    await connector.closeScope!(context);
    expect(classifyCallError(error)).toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("the tool says: bad input"),
    });
  });

  it.each(modes)("passes a call's own abort reason through by identity, whatever its class (%s)", async (mode) => {
    const controller = new AbortController();
    const reason = Object.assign(new SyntaxError("caller left"), { name: "AbortError" });
    vi.stubGlobal(
      "fetch",
      downstream({
        live: true,
        // A listed read: a direct write's abort after dispatch is an unknown outcome instead.
        tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
        toolCall: () => {
          controller.abort(reason);
          return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } });
        },
      }),
    );
    const connector = remoteMcp("svc", { url: MCP_URL, versionNegotiation: mode });
    const context: ConnectorContext = { ...scope(), signal: controller.signal };
    await connector.listTools(context);
    const error = await connector.callTool("read", {}, context).then(
      () => null,
      (err: unknown) => err,
    );
    await connector.closeScope!(context);
    // The Promise boundary preserves the caller's actual reason, including
    // its class and identity, rather than the SDK's former string wrapper.
    expect(error).toBe(reason);
  });
});

describe("SDK failure facts", () => {
  it.each(
    (["legacy", "auto"] as const).flatMap((versionNegotiation) =>
      [false, true].map((oauth) => ({ versionNegotiation, oauth })),
    ),
  )(
    "INV-6 INV-8: catalog HTTP 401 latches after OAuth=$oauth under $versionNegotiation negotiation",
    async ({ versionNegotiation, oauth }) => {
      let pages = 0;
      let calls = 0;
      let refreshes = 0;
      vi.stubGlobal(
        "fetch",
        downstream({
          live: true,
          listPage: () => {
            pages++;
            return "401";
          },
          toolCall: () => {
            calls++;
            return "401";
          },
          token: () => {
            refreshes++;
            return Response.json({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
          },
        }),
      );
      const connector = remoteMcp("svc", {
        url: MCP_URL,
        versionNegotiation,
        auth: oauth ? { type: "oauth" } : { type: "headers", headers: { authorization: "Bearer rejected-static" } },
      });
      const context = scope();
      const code = oauth ? "downstream_oauth_required" : "auth_required";
      try {
        if (oauth) {
          const seeder = new KvOAuthProvider("svc", context.storage, REDIRECT, undefined, true);
          await seeder.saveClientInformation(
            { client_id: "connecta-client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
            { issuer: ISSUER },
          );
          await seeder.saveTokens(
            { access_token: "access-old", token_type: "Bearer", refresh_token: "refresh-old" },
            { issuer: ISSUER },
          );
        }
        expect(await connector.status!(context)).toMatchObject({ state: "ok" });
        const error = await connector.listTools(context).catch((error: unknown) => error);
        expect(classifyCallError(error)).toMatchObject({ code, retryable: false });
        const record = failureRecord({ connector: "svc" }, error);
        expect(record).toMatchObject({
          code,
          retryable: false,
          step: "tools/list",
          origin: "https://downstream.example",
          httpStatus: 401,
          errorClass: "SdkHttpError",
        });
        expect(error).not.toHaveProperty("data");
        expect((error as Error).cause).toBeUndefined();
        expect(await connector.status!(context)).toMatchObject({ state: "auth_required" });
        if (oauth) {
          const started = await connector.startAuth!(context, { force: false });
          expect(started.state).toBe("auth_required");
          expect(started.authorizationUrl).toBeUndefined();
        }
        const listed = await connector.listTools(context).catch((error: unknown) => error);
        const called = await connector.callTool("read", {}, context).catch((error: unknown) => error);
        expect(classifyCallError(listed)).toMatchObject({ code, retryable: false });
        expect(classifyCallError(called)).toMatchObject({ code, retryable: false });
        expect(pages).toBe(oauth ? 2 : 1);
        expect(refreshes).toBe(oauth ? 1 : 0);
        expect(calls).toBe(0);
        expectWithheld(rendered(error), JSON.stringify(record), rendered(listed), rendered(called));
      } finally {
        await connector.closeScope!(context);
      }
    },
  );

  it.each(
    (["legacy", "auto"] as const).flatMap((versionNegotiation) =>
      [false, true].map((oauth) => ({ versionNegotiation, oauth })),
    ),
  )(
    "INV-6: endpoint HTTP 401 attaches auth recovery after OAuth=$oauth under $versionNegotiation negotiation",
    async ({ versionNegotiation, oauth }) => {
      let calls = 0;
      let refreshes = 0;
      vi.stubGlobal(
        "fetch",
        downstream({
          live: true,
          tools: [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
          toolCall: () => {
            calls++;
            return "401";
          },
          token: () => {
            refreshes++;
            return Response.json({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
          },
        }),
      );
      const connector = remoteMcp("svc", {
        url: MCP_URL,
        versionNegotiation,
        auth: oauth ? { type: "oauth" } : { type: "headers", headers: { authorization: "Bearer rejected-static" } },
      });
      const { logger, lines } = capturingLogger();
      const registry = makeRegistry([connector], { logger });
      const catalog = new CatalogService(registry, "https://connecta.test");
      const context = registry.contextFor("svc", catalog.baseUrl, catalog.requestScope);
      const call = vi.spyOn(connector, "callTool");
      try {
        if (oauth) {
          const seeder = new KvOAuthProvider("svc", context.storage, REDIRECT, undefined, true);
          await seeder.saveClientInformation(
            { client_id: "connecta-client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
            { issuer: ISSUER },
          );
          await seeder.saveTokens(
            { access_token: "access-old", token_type: "Bearer", refresh_token: "refresh-old" },
            { issuer: ISSUER },
          );
        }
        const outcome = await new InvocationService(registry, catalog).invoke("svc.read", {}, { source: "call_tool" });
        const code = oauth ? "downstream_oauth_required" : "auth_required";
        expect(outcome).toMatchObject({
          ok: false,
          attempts: 1,
          error: {
            code,
            retryable: false,
            recovery: oauth ? "oauth" : "unavailable",
            nextAction: { tool: "authorize_connector", arguments: { connector: "svc" } },
          },
        });
        expect(call).toHaveBeenCalledTimes(1);
        const error = await call.mock.results[0]!.value.catch((error: unknown) => error);
        expect(classifyCallError(error)).toMatchObject({ code, retryable: false });
        const record = failureRecord({ connector: "svc" }, error);
        expect(record).toMatchObject({
          code,
          retryable: false,
          step: "tools/call",
          origin: "https://downstream.example",
          httpStatus: 401,
          errorClass: "SdkHttpError",
        });
        expect(error).not.toHaveProperty("data");
        expect((error as Error).cause).toBeUndefined();
        expect(refreshes).toBe(oauth ? 1 : 0);
        expect(calls).toBe(oauth ? 2 : 1);
        // The post-refresh rejection is a verdict for this scope too. Reads
        // and another call must not reuse the client or resend its credential.
        const status = await connector.status!(context);
        expect(status.state).toBe("auth_required");
        const started = oauth ? await connector.startAuth!(context, { force: false }) : undefined;
        if (oauth) {
          expect(started).toMatchObject({ state: "auth_required" });
          expect(started?.authorizationUrl).toBeUndefined();
        }
        const listed = await connector.listTools(context).catch((error: unknown) => error);
        expect(classifyCallError(listed)).toMatchObject({ code, retryable: false });
        const again = await connector.callTool("read", {}, context).catch((error: unknown) => error);
        expect(classifyCallError(again)).toMatchObject({ code, retryable: false });
        const followup = await new InvocationService(registry, catalog).invoke("svc.read", {}, { source: "call_tool" });
        expect(followup).toMatchObject({
          ok: false,
          error: {
            code,
            retryable: false,
            recovery: oauth ? "oauth" : "unavailable",
            nextAction: { tool: "authorize_connector", arguments: { connector: "svc" } },
          },
        });
        expect(refreshes).toBe(oauth ? 1 : 0);
        expect(calls).toBe(oauth ? 2 : 1);
        expectWithheld(JSON.stringify(status), safeJson(started), rendered(listed), rendered(again));
        expectWithheld(rendered(error), JSON.stringify(record), JSON.stringify(outcome), ...lines);
      } finally {
        await connector.closeScope!(context);
      }
    },
  );

  const hostile = "timeout temporarily rate limit 429 502 503 504 econnreset";
  const names = [
    { id: "svc", endpoint: MCP_URL, authorizationServer: ISSUER },
    {
      id: "svc-timeout-503",
      endpoint: "https://timeout-503.example/mcp",
      authorizationServer: "https://temporarily-rate-limit.example",
    },
  ];
  const statuses = [400, 401, 403, 404, 408, 422, 429, 500, 502, 503, 504];

  it.each(
    statuses.flatMap((status) =>
      names.flatMap((name) => [false, true].map((malicious) => ({ status, ...name, malicious }))),
    ),
  )(
    "INV-6 INV-9: registration HTTP $status ignores prose=$malicious and name=$id",
    async ({ status, id, endpoint, authorizationServer, malicious }) => {
      vi.stubGlobal(
        "fetch",
        downstream({
          endpoint,
          authorizationServer,
          register: () =>
            Response.json(
              {
                // Even a registered transient OAuth code cannot override a registration status.
                error: malicious ? "temporarily_unavailable" : "invalid_client_metadata",
                error_description: malicious ? `${hostile} ${SECRET}` : "refused",
              },
              { status, headers: { "retry-after": "2" } },
            ),
        }),
      );
      const connector = remoteMcp(id, { url: endpoint, auth: { type: "oauth" }, versionNegotiation: "legacy" });
      const context = { ...scope(), allowAuthorization: true };
      try {
        const error = await connector.callTool("write", {}, context).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ConnectorCallError);
        expect(classifyCallError(error)).toMatchObject({
          retryable: [429, 502, 503, 504].includes(status),
          retryAfterMs: 2000,
        });
        expect(classifyCallError(error).code).not.toBe("timeout");
        expect(failureRecord({ connector: id }, error)).toMatchObject({
          httpStatus: status,
          step: "OAuth client registration",
          origin: authorizationServer,
          oauthError: malicious ? "temporarily_unavailable" : "invalid_client_metadata",
        });
        expect(error).not.toHaveProperty("data");
        expect((error as Error).cause).toBeUndefined();
        expectWithheld(rendered(error));
      } finally {
        await connector.closeScope!(context);
      }
    },
  );

  it.each(
    (["legacy", "auto"] as const).flatMap(
      (versionNegotiation) =>
        [
          { versionNegotiation, oauthCode: "invalid_grant", code: "downstream_oauth_required", retryable: false },
          { versionNegotiation, oauthCode: "temporarily_unavailable", code: "unavailable", retryable: true },
        ] as const,
    ),
  )(
    "INV-6: callback token HTTP 400 honors $oauthCode under $versionNegotiation negotiation",
    async ({ versionNegotiation, oauthCode, code, retryable }) => {
      let exchanges = 0;
      const base = downstream({
        token: () =>
          Response.json(
            {
              error: oauthCode,
              error_description: `${hostile} ${SECRET}`,
              error_uri: `https://evil.example/${SECRET}`,
              data: { payload: SECRET },
            },
            { status: 400 },
          ),
      });
      vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
        if (new URL(input).href === `${ISSUER}/token`) {
          exchanges++;
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe(`callback-${SECRET}`);
        }
        return base(input, init);
      });
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation });
      const { logger, lines } = capturingLogger();
      const startedContext = scope(logger);
      const callbackContext = { ...startedContext, requestScope: {} };
      try {
        const started = await connector.startAuth!(startedContext);
        expect(started.state).toBe("auth_required");
        const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
        expect(await connector.verifyState!(state, callbackContext)).toBe(true);
        const params = new URLSearchParams({ code: `callback-${SECRET}`, state });
        const error = await connector.finishAuth!(`callback-${SECRET}`, callbackContext, params).catch(
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(ConnectorCallError);
        expect(classifyCallError(error)).toMatchObject({
          code,
          retryable,
          message: `OAuth failed with error ${oauthCode}.`,
        });
        expect(error).not.toHaveProperty("data");
        expect(error).not.toHaveProperty("errorUri");
        expect((error as Error).cause).toBeUndefined();
        const record = failureRecord({ connector: "svc" }, error);
        expect(record).toEqual({
          connector: "svc",
          code,
          retryable,
          errorClass: "OAuthError",
          step: "OAuth token request",
          origin: ISSUER,
          httpStatus: 400,
        });
        expectWithheld(rendered(error), JSON.stringify(classifyCallError(error)), JSON.stringify(record), ...lines);
        expect(JSON.stringify(record)).not.toContain(hostile);
        expect(exchanges).toBeGreaterThan(0);
      } finally {
        await connector.closeScope!(startedContext);
        await connector.closeScope!(callbackContext);
      }
    },
  );

  it.each([-32602, -32603])(
    "INV-6 INV-9: wire ProtocolError %i keeps allowed text without data or replay",
    async (code) => {
      let dispatches = 0;
      vi.stubGlobal(
        "fetch",
        downstream({
          live: true,
          toolCall: (_n, id) => {
            dispatches++;
            return Response.json({
              jsonrpc: "2.0",
              id,
              error: { code, message: hostile, data: { request: SECRET, payload: [SECRET] } },
            });
          },
        }),
      );
      const connector = remoteMcp("svc-timeout-503", { url: MCP_URL, versionNegotiation: "legacy" });
      const context = scope();
      try {
        const error = await connector.callTool("write", {}, context).catch((error: unknown) => error);
        expect(classifyCallError(error)).toMatchObject({
          code: code === -32602 ? "invalid_args" : "connector_call_failed",
          message: expect.stringContaining(hostile),
          retryable: false,
        });
        expect(error).not.toHaveProperty("data");
        expect((error as Error).cause).toBeUndefined();
        expectWithheld(rendered(error));
        expect(dispatches).toBe(1);
      } finally {
        await connector.closeScope!(context);
      }
    },
  );

  it.each(["legacy", "auto"] as const)(
    "INV-6 INV-9: insufficient_scope dispatches once and never begins OAuth (%s)",
    async (versionNegotiation) => {
      let dispatches = 0;
      let oauthRequests = 0;
      const base = downstream({
        live: true,
        toolCall: () => {
          dispatches++;
          return "403";
        },
      });
      vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
        if (new URL(input).href !== MCP_URL) oauthRequests++;
        return base(input, init);
      });
      const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" }, versionNegotiation });
      const context = scope();
      try {
        const error = await connector.callTool("write", {}, context).catch((error: unknown) => error);
        expect(classifyCallError(error)).toMatchObject({ code: "provider_permission_denied", retryable: false });
        expect((error as Error).message).not.toMatch(/authorize_connector|retry authorization/);
        expect(dispatches).toBe(1);
        expect(oauthRequests).toBe(0);
        expect(await context.storage.get("oauth:pending")).toBeNull();
      } finally {
        await connector.closeScope!(context);
      }
    },
  );
});

describe("ProtocolError payloads at every SDK exit", () => {
  it.each([false, true])("INV-6: startAuth strips a payload-bearing abort, wrapped=%s", async (wrapped) => {
    const sdkError = new ProtocolError(-32603, "caller left", { payload: SECRET });
    const original = wrapped ? new Error("caller left", { cause: sdkError }) : sdkError;
    const controller = new AbortController();
    controller.abort(original);
    const connector = remoteMcp("svc", { url: MCP_URL, auth: { type: "oauth" } });
    const context = { ...scope(), signal: controller.signal };
    try {
      const error = await connector.startAuth!(context).catch((error: unknown) => error);
      expect(error).not.toBe(original);
      expect(error).toBeInstanceOf(ConnectorCallError);
      expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(error).not.toHaveProperty("data");
      expect((error as Error).cause).toBeUndefined();
      expectWithheld(rendered(error), JSON.stringify(failureRecord({ connector: "svc" }, error)));
    } finally {
      await connector.closeScope!(context);
    }
  });

  it.each(["initialize", "tools/list"] as const)("INV-6: removes allowed wire data at %s", async (method) => {
    const base = downstream({ live: true });
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit = {}) => {
      const request = init.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      return request?.method === method
        ? Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32603, message: "timeout temporarily 503", data: { secret: SECRET } },
          })
        : base(input, init);
    });
    const connector = remoteMcp("svc-503", { url: MCP_URL, versionNegotiation: "legacy" });
    const context = scope();
    try {
      const error = await connector.listTools(context).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ConnectorCallError);
      expect(classifyCallError(error)).toMatchObject({
        code: "connector_call_failed",
        retryable: false,
        message: expect.stringContaining("timeout temporarily 503"),
      });
      expect(error).not.toHaveProperty("data");
      expect((error as Error).cause).toBeUndefined();
      expectWithheld(rendered(error));
    } finally {
      await connector.closeScope!(context);
    }
  });
});
