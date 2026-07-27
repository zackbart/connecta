import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import { withTimeout } from "../src/timeout.js";
import { buildUiData } from "../src/ui.js";
import type { ConnectorContext, KVStorage, Logger } from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

function ctx(storage: KVStorage = memoryStorage()): ConnectorContext {
  return { storage, logger: silentLogger, baseUrl: BASE };
}

/** Build a downstream MCP server exposing echo + fail tools, wired in-process. */
async function connectServer() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "downstream", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo text back",
      inputSchema: { text: z.string() },
      outputSchema: { echoed: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `echo:${text}` }],
      structuredContent: { echoed: text },
    }),
  );
  server.registerTool(
    "fail",
    { description: "Always fails", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: "downstream boom" }],
      isError: true,
    }),
  );
  await server.connect(serverTransport);
  return { server, clientTransport };
}

let closer: (() => Promise<void>) | null = null;
afterEach(async () => {
  await closer?.();
  closer = null;
  vi.unstubAllGlobals();
});

async function makeConnector() {
  const { server, clientTransport } = await connectServer();
  closer = () => server.close();
  return remoteMcp("down", {
    url: "https://unused.example/mcp",
    description: "Downstream",
    _transportFactory: () => clientTransport,
  });
}

async function makeTrackedConnector(opts: { oauth?: boolean } = {}) {
  const { server, clientTransport } = await connectServer();
  closer = () => server.close();
  const counts = { connect: 0, close: 0 };
  const trackedTransport: Transport = {
    async start() {
      counts.connect++;
      await clientTransport.start();
    },
    send: (message, sendOpts) => clientTransport.send(message, sendOpts),
    async close() {
      counts.close++;
      await clientTransport.close();
    },
  };
  // The SDK installs its callbacks on the transport object it receives. Forward
  // those properties to the linked in-memory transport while keeping start and
  // close wrapped exactly once for accounting.
  for (const key of ["onclose", "onerror", "onmessage"] as const) {
    Object.defineProperty(trackedTransport, key, {
      get: () => clientTransport[key],
      set: (value) => {
        clientTransport[key] = value as never;
      },
    });
  }
  const connector = remoteMcp("down", {
    url: "https://unused.example/mcp",
    description: "Downstream",
    ...(opts.oauth ? { auth: { type: "oauth" as const } } : {}),
    _transportFactory: () => trackedTransport,
  });
  return { connector, counts };
}

interface DownstreamRequest {
  method: string;
  sessionId: string | null;
  /** Whether the transport had already aborted when the request went out. */
  abortedWhenIssued: boolean;
  signal: AbortSignal | null | undefined;
}

/**
 * A downstream reached through the SDK's real HTTP transport, so the session
 * DELETE is observable — `InMemoryTransport` has no session semantics at all,
 * which is exactly why the connect/close counters above cannot see it. Passing
 * `sessionId` makes the downstream stateful: it answers initialize with the
 * `mcp-session-id` header that spec termination has to carry back.
 */
function makeHttpDownstream(
  opts: {
    sessionId?: string;
    oauth?: boolean;
    onDelete?: () => Promise<Response>;
  } = {},
) {
  const url = "https://downstream.test/mcp";
  const requests: DownstreamRequest[] = [];
  const fetchStub: FetchLike = async (_url, init = {}) => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    requests.push({
      method: init.method ?? "GET",
      sessionId: headers.get("mcp-session-id"),
      abortedWhenIssued: init.signal?.aborted ?? false,
      signal: init.signal,
    });
    if (init.method === "DELETE") {
      return (await opts.onDelete?.()) ?? new Response(null, { status: 200 });
    }
    // The transport optimistically opens a GET SSE stream after initializing;
    // 405 is the spec's "no stream here", which it accepts silently.
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    if (message.method !== "initialize") {
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: {},
          serverInfo: { name: "downstream", version: "1.0.0" },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
        },
      },
    );
  };
  const connector = remoteMcp("down", {
    url,
    description: "Downstream",
    ...(opts.oauth ? { auth: { type: "oauth" as const } } : {}),
    _transportFactory: () =>
      new StreamableHTTPClientTransport(new URL(url), { fetch: fetchStub }),
  });
  return { connector, requests };
}

describe("remoteMcp() connector", () => {
  it("passes usageGuide through, and leaves it unset by default", () => {
    expect(
      remoteMcp("plain", { url: "https://downstream.test/mcp" }).usageGuide,
    ).toBeUndefined();
    const guide = "# Downstream usage\n\nPaginate with `cursor`.\n";
    expect(
      remoteMcp("guided", {
        url: "https://downstream.test/mcp",
        usageGuide: guide,
      }).usageGuide,
    ).toBe(guide);
  });

  it("listTools reflects the downstream server's tools", async () => {
    const c = await makeConnector();
    const tools = await c.listTools(ctx());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["echo", "fail"]);
    expect(byName.echo.description).toBe("Echo text back");
    expect((byName.echo.inputSchema as any).properties.text.type).toBe(
      "string",
    );
    expect((byName.echo.outputSchema as any).properties.echoed.type).toBe(
      "string",
    );
    expect(byName.echo.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
  });

  it("discovers output-schema tools when dynamic code generation is blocked", async () => {
    const c = await makeConnector();
    vi.stubGlobal(
      "Function",
      function blockedFunction(): never {
        throw new EvalError("Code generation from strings disallowed");
      },
    );

    const tools = await c.listTools(ctx());

    expect(tools.find((tool) => tool.name === "echo")?.outputSchema).toBeTruthy();
  });

  it("passes maxResultBytes through, and leaves it unset by default", async () => {
    expect((await makeConnector()).maxResultBytes).toBeUndefined();
    const capped = remoteMcp("search", {
      url: "https://unused.example/mcp",
      maxResultBytes: 5_000,
    });
    expect(capped.maxResultBytes).toBe(5_000);
  });

  it("callTool proxies args and returns the content array as-is", async () => {
    const c = await makeConnector();
    const result = (await c.callTool("echo", { text: "hi" }, ctx())) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(result.isError).toBeFalsy();
  });

  it("surfaces a downstream error result with isError", async () => {
    const c = await makeConnector();
    const result = (await c.callTool("fail", {}, ctx())) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("downstream boom");
  });

  it("reports ok status once connected", async () => {
    const c = await makeConnector();
    const status = await c.status!(ctx());
    expect(status.state).toBe("ok");
  });

  it("converts the SDK's UnauthorizedError into a typed auth_required call error", async () => {
    const c = remoteMcp("locked", {
      url: "https://unused.example/mcp",
      description: "Locked",
      _transportFactory: () =>
        ({
          async start() {
            throw new UnauthorizedError("Unauthorized");
          },
          async send() {},
          async close() {},
        }) as unknown as Transport,
    });
    const err = await c
      .callTool("echo", {}, ctx())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    const typed = err as ConnectorCallError;
    expect(typed.code).toBe("auth_required");
    expect(typed.retryable).toBe(false);
    expect(typed.message).toContain('authorize_connector({ connector: "locked" })');
    expect(typed.cause).toBeInstanceOf(UnauthorizedError);
  });

  it("reuses a client within one request scope but never across requests", async () => {
    const first = await connectServer();
    const second = await connectServer();
    closer = async () => {
      await first.server.close();
      await second.server.close();
    };
    const transports = [first.clientTransport, second.clientTransport];
    let builds = 0;
    const c = remoteMcp("down", {
      url: "https://unused.example/mcp",
      description: "Downstream",
      _transportFactory: () => {
        builds++;
        const transport = transports.shift();
        if (!transport) throw new Error("unexpected third transport");
        return transport;
      },
    });
    const registry = makeRegistry([c]);
    const firstRequest = createMetaTools(registry, BASE);
    const firstResult = await firstRequest.batchCall({
      calls: [
        { address: "down.echo", args: { text: "first" } },
        { address: "down.echo", args: { text: "same request" } },
      ],
    });
    expect(firstResult.isError).toBeFalsy();
    expect(builds).toBe(1);

    // Production creates a fresh meta-tool set for every inbound MCP request.
    const secondRequest = createMetaTools(registry, BASE);
    const result = await secondRequest.callTool({
      address: "down.echo",
      args: { text: "next request" },
    });

    expect(result.content[0].text).toBe("echo:next request");
    expect(builds).toBe(2);
  });

  it("closes a connected scope at most once", async () => {
    const { connector, counts } = await makeTrackedConnector();
    const requestScope = {};
    const context = { ...ctx(), requestScope };

    await expect(connector.status!(context)).resolves.toMatchObject({
      state: "ok",
    });
    expect(counts).toEqual({ connect: 1, close: 0 });

    await connector.closeScope!(context);
    await connector.closeScope!(context);

    expect(counts).toEqual({ connect: 1, close: 1 });
  });

  it("discards a client when its scope closes during the post-connect generation read", async () => {
    const backing = memoryStorage();
    let generationReads = 0;
    let reachedSecondRead!: () => void;
    const secondRead = new Promise<void>((resolve) => {
      reachedSecondRead = resolve;
    });
    let releaseSecondRead!: () => void;
    const generationGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const storage: KVStorage = {
      async get(key) {
        if (key === "oauth:generation" && ++generationReads === 2) {
          reachedSecondRead();
          await generationGate;
        }
        return backing.get(key);
      },
      set: (key, value, opts) => backing.set(key, value, opts),
      delete: (key) => backing.delete(key),
    };
    const { connector, counts } = await makeTrackedConnector({ oauth: true });
    const context = { ...ctx(storage), requestScope: {} };

    const status = connector.status!(context);
    await withTimeout(secondRead, 250, "post-connect generation read");
    await connector.closeScope!(context);
    expect(counts).toEqual({ connect: 1, close: 1 });
    releaseSecondRead();

    await expect(status).resolves.toMatchObject({
      state: "error",
      message: expect.stringContaining("scope ended during connection"),
    });
    // The connected client was discarded rather than cached into the detached
    // state. Its transport had already observed close, so no second close is
    // necessary.
    expect(counts).toEqual({ connect: 1, close: 1 });
  });
});

describe("probe scope teardown", () => {
  it("closes a half-open transport after a probe deadline", async () => {
    const counts = { connect: 0, close: 0 };
    const connector = remoteMcp("down", {
      url: "https://unused.example/mcp",
      description: "Downstream",
      _transportFactory: () =>
        ({
          async start() {
            counts.connect++;
            await new Promise<never>(() => {});
          },
          async send() {},
          async close() {
            counts.close++;
          },
        }) as unknown as Transport,
    });

    const result = await createMetaTools(makeRegistry([connector]), BASE, {
      probeTimeoutMs: 10,
    }).listConnectors({ probe: true });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("timed out");
    expect(counts).toEqual({ connect: 1, close: 1 });
  });

  it("closes the remote session opened by list_connectors({ probe: true })", async () => {
    const { connector, counts } = await makeTrackedConnector();
    const result = await createMetaTools(
      makeRegistry([connector]),
      BASE,
    ).listConnectors({ probe: true });

    expect(result.isError).toBeFalsy();
    expect(counts).toEqual({ connect: 1, close: 1 });
  });

  it("closes the remote session opened by buildUiData", async () => {
    const { connector, counts } = await makeTrackedConnector();
    const data = await buildUiData(
      makeRegistry([connector]),
      BASE,
      { name: "connecta", version: "test" },
    );

    expect(data.connectors[0]).toMatchObject({
      id: "down",
      status: "ok",
      toolCount: 2,
    });
    expect(counts).toEqual({ connect: 1, close: 1 });
  });

  it("closes the remote session opened by a credential-health sweep", async () => {
    const storage = memoryStorage();
    await storage.set(
      "conn:down:oauth:tokens",
      JSON.stringify({ access_token: "at", token_type: "bearer" }),
    );
    const { connector, counts } = await makeTrackedConnector({
      oauth: true,
    });
    const registry = makeRegistry([connector], { storage });

    await expect(registry.checkCredentialHealth(BASE)).resolves.toMatchObject([
      { connectorId: "down", record: { state: "ok" } },
    ]);
    expect(counts).toEqual({ connect: 1, close: 1 });
  });
});

describe("downstream session termination", () => {
  it("sends the spec DELETE for a stateful downstream before closing", async () => {
    const { connector, requests } = makeHttpDownstream({ sessionId: "sess-1" });
    const context = { ...ctx(), requestScope: {} };

    await expect(connector.status!(context)).resolves.toMatchObject({
      state: "ok",
    });
    await connector.closeScope!(context);

    const deletes = requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sessionId).toBe("sess-1");
    // Load-bearing: the DELETE rides the transport's AbortSignal, so a
    // termination issued after the close would be aborted on arrival and free
    // nothing server-side while still looking like it worked.
    expect(deletes[0].abortedWhenIssued).toBe(false);
    expect(deletes[0].signal!.aborted).toBe(true);
  });

  it("sends no DELETE for a stateless downstream", async () => {
    const { connector, requests } = makeHttpDownstream();
    const context = { ...ctx(), requestScope: {} };

    await expect(connector.status!(context)).resolves.toMatchObject({
      state: "ok",
    });
    await connector.closeScope!(context);

    // No `mcp-session-id` was ever issued, so there is no session to end and a
    // DELETE would only be an unexplained request in the provider's logs.
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("keeps the probe verdict when the downstream refuses to terminate", async () => {
    const storage = memoryStorage();
    await storage.set(
      "conn:down:oauth:tokens",
      JSON.stringify({ access_token: "at", token_type: "bearer" }),
    );
    const { connector, requests } = makeHttpDownstream({
      sessionId: "sess-1",
      oauth: true,
      onDelete: async () => new Response("no", { status: 500 }),
    });
    const registry = makeRegistry([connector], { storage });

    await expect(registry.checkCredentialHealth(BASE)).resolves.toMatchObject([
      { connectorId: "down", record: { state: "ok" } },
    ]);
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("bounds a downstream that never answers the termination request", async () => {
    const { connector, requests } = makeHttpDownstream({
      sessionId: "sess-1",
      onDelete: () => new Promise<Response>(() => {}),
    });
    const context = { ...ctx(), requestScope: {} };

    await expect(connector.status!(context)).resolves.toMatchObject({
      state: "ok",
    });
    const started = Date.now();
    await connector.closeScope!(context);
    const elapsed = Date.now() - started;

    const pending = requests.find((r) => r.method === "DELETE");
    expect(pending).toBeDefined();
    // Teardown stopped waiting and closed anyway, which aborts the DELETE still
    // hanging on the transport's signal. Well inside the core's 100 ms
    // scope-close budget, so a stalled provider cannot spend it.
    expect(pending!.signal!.aborted).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("remoteMcp() destination guard", () => {
  function loggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    return { logger: { ...silentLogger, warn }, warn };
  }

  it("warns when static headers auth would travel over http://", () => {
    const { logger, warn } = loggerSpy();
    remoteMcp("cleartext", {
      url: "http://example.com/mcp",
      auth: { type: "headers", headers: { authorization: "Bearer secret" } },
      logger,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("cleartext");
    expect(warn.mock.calls[0][0]).toMatch(/http:\/\/example\.com/);
  });

  it("does not warn for headers auth over https://", () => {
    const { logger, warn } = loggerSpy();
    remoteMcp("secure", {
      url: "https://example.com/mcp",
      auth: { type: "headers", headers: { authorization: "Bearer secret" } },
      logger,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for headers auth over http://localhost", () => {
    const { logger, warn } = loggerSpy();
    remoteMcp("local", {
      url: "http://localhost:8787/mcp",
      auth: { type: "headers", headers: { authorization: "Bearer secret" } },
      logger,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when there is no static headers auth, even over http://", () => {
    const { logger, warn } = loggerSpy();
    remoteMcp("noauth", { url: "http://example.com/mcp", logger });
    expect(warn).not.toHaveBeenCalled();
  });

  it("requireHttps throws a config error for an http:// url", () => {
    expect(() =>
      remoteMcp("must-tls", {
        url: "http://example.com/mcp",
        requireHttps: true,
      }),
    ).toThrow(/requireHttps/);
  });

  it("requireHttps allows https:// and loopback without throwing", () => {
    const { logger, warn } = loggerSpy();
    expect(() =>
      remoteMcp("tls", {
        url: "https://example.com/mcp",
        requireHttps: true,
        logger,
      }),
    ).not.toThrow();
    expect(() =>
      remoteMcp("loopback", {
        url: "http://127.0.0.1:8787/mcp",
        requireHttps: true,
        logger,
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("remoteMcp() startAuth", () => {
  it("non-force re-issues an outstanding consent URL without touching the verifier", async () => {
    const storage = memoryStorage();
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      // Must not connect while a URL is pending — the pending short-circuit
      // fires first, so this factory should never run.
      _transportFactory: () => {
        throw new Error("should not connect while a consent URL is pending");
      },
    });
    const url = "https://auth.example/authorize?code_challenge=abc";
    await storage.set("oauth:pending", url);
    await storage.set("oauth:verifier", "verifier-123");
    const context = ctx(storage);

    const first = await c.startAuth!(context, {});
    const second = await c.startAuth!(context, {});

    expect(first.state).toBe("auth_required");
    expect(first.authorizationUrl).toBe(url);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    // The verifier the operator's URL is bound to must survive both touches.
    expect(await storage.get("oauth:verifier")).toBe("verifier-123");
  });

  it("force with a live client closes it, wipes creds, and reconnects", async () => {
    const s1 = await connectServer();
    const s2 = await connectServer();
    closer = async () => {
      await s1.server.close();
      await s2.server.close();
    };
    let closedFirst = false;
    const origClose = s1.clientTransport.close.bind(s1.clientTransport);
    s1.clientTransport.close = async () => {
      closedFirst = true;
      return origClose();
    };
    const transports = [s1.clientTransport, s2.clientTransport];
    const storage = memoryStorage();
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => transports.shift()!,
    });
    const context = ctx(storage);

    // First connect → live client on transport #1.
    await c.listTools(context);
    await storage.set("oauth:pending", "x");
    await storage.set("oauth:verifier", "v");
    await storage.set("oauth:tokens", "tok");
    await storage.set("oauth:client", "cli");

    const result = await c.startAuth!(context, { force: true });

    expect(closedFirst).toBe(true);
    // Reconnected cleanly via transport #2 → healthy again.
    expect(result.state).toBe("ok");
    expect(await storage.get("oauth:pending")).toBeNull();
    expect(await storage.get("oauth:verifier")).toBeNull();
    expect(await storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("oauth:client")).toBeNull();
  });

  it("force fences an in-flight connect before wiping", async () => {
    const storage = memoryStorage();
    let started = 0;
    // A transport whose start() rejects after a tick, standing in for a slow
    // connect that is still in flight when force lands.
    const slowFailing = (): Transport => ({
      async start() {
        started++;
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("ECONNREFUSED");
      },
      async send() {},
      async close() {},
    });
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: slowFailing,
    });
    const context = ctx(storage);

    // Kick a connect without awaiting so it is in flight when force runs.
    const inflight = c.listTools(context).catch(() => {});
    const result = await c.startAuth!(context, { force: true });
    await inflight;

    // force awaited the in-flight connect (fence) then ran its own connect.
    expect(started).toBe(2);
    // Network failure on an oauth connector surfaces as error, not auth_required.
    expect(result.state).toBe("error");
    expect(result.message).toContain("ECONNREFUSED");
  });
});
