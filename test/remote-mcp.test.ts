import {
  InMemoryTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  inputRequired,
  McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import {
  buildSandboxProviders,
  createExecuteTool,
} from "../src/execute.js";
import { InvocationFailure } from "../src/invocation.js";
import {
  MAX_REMOTE_REDIRECT_HOPS,
  redirectSafeFetch,
  remoteMcp,
  RemoteMcpRedirectError,
} from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import { withTimeout } from "../src/timeout.js";
import { buildUiData } from "../src/ui.js";
import type {
  ConnectorContext,
  Executor,
  KVStorage,
  Logger,
} from "../src/types.js";
import { required, makeRegistry, silentLogger } from "./helpers.js";

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
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `echo:${text}` }],
      structuredContent: { echoed: text },
    }),
  );
  server.registerTool(
    "fail",
    { description: "Always fails", inputSchema: z.object({}) },
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

async function makeInputRequiredConnector() {
  const url = "https://mrtr-downstream.test/mcp";
  const handler = createMcpHandler(() => {
    const server = new McpServer({
      name: "mrtr-downstream",
      version: "1.0.0",
    });
    server.registerTool(
      "needs_input",
      {
        description: "Requires a second protocol round trip",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => inputRequired({ requestState: "opaque-resume-state" }),
    );
    return server;
  });
  return remoteMcp("mrtr", {
    url,
    description: "MRTR downstream",
    _transportFactory: () =>
      new StreamableHTTPClientTransport(new URL(url), {
        fetch: async (input, init) =>
          handler.fetch(new Request(input, init)),
      }) as unknown as Transport,
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
    send: (message, sendOpts) =>
      clientTransport.send(
        message,
        sendOpts?.relatedRequestId !== undefined
          ? { relatedRequestId: sendOpts.relatedRequestId }
          : undefined,
      ),
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
    // Auto negotiation treats any non-auth, non-5xx HTTP rejection without a
    // modern discovery result as legacy evidence, then performs initialize.
    if (message.method === "server/discover") {
      return new Response("not found", { status: 404 });
    }
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
      // See remote-mcp.ts: exact optional types exposes an SDK declaration
      // mismatch for sessionId, but the class implements this transport at
      // runtime and is the production transport under test.
      new StreamableHTTPClientTransport(new URL(url), {
        fetch: fetchStub,
      }) as unknown as Transport,
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
    expect(required(byName.echo).description).toBe("Echo text back");
    expect((required(byName.echo).inputSchema as any).properties.text.type).toBe(
      "string",
    );
    expect((required(byName.echo).outputSchema as any).properties.echoed.type).toBe(
      "string",
    );
    expect(required(byName.echo).annotations).toMatchObject({
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

  it("passes callAdmission through, and leaves it unset by default", async () => {
    expect((await makeConnector()).callAdmission).toBeUndefined();
    const callAdmission = { rules: [{ maxConcurrency: 2 }] } as const;
    const limited = remoteMcp("limited", {
      url: "https://downstream.test/mcp",
      callAdmission,
    });
    expect(limited.callAdmission).toBe(callAdmission);
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
    expect(required(result.content[0]).text).toContain("downstream boom");
  });

  it("fails loudly and structurally when a downstream returns input_required", async () => {
    const connector = await makeInputRequiredConnector();
    const direct = await connector
      .callTool("needs_input", {}, ctx())
      .then(() => undefined, (error: unknown) => error);
    expect(direct).toMatchObject({
      name: "ConnectorCallError",
      code: "input_required_unsupported",
      retryable: false,
    });
    expect((direct as Error).message).toContain("input_required");
    expect((direct as Error).message).toContain("gated");

    const meta = createMetaTools(makeRegistry([connector]), BASE);
    const single = await meta.callTool({
      address: "mrtr.needs_input",
      args: {},
    });
    expect(single.isError).toBe(true);
    expect(single.structuredContent).toMatchObject({
      error: {
        code: "input_required_unsupported",
        retryable: false,
        message: expect.stringContaining("input_required"),
      },
    });

    const batch = await meta.batchCall({
      calls: [{ address: "mrtr.needs_input", args: {} }],
    });
    expect(batch.structuredContent).toMatchObject({
      results: [
        {
          address: "mrtr.needs_input",
          ok: false,
          errorDetails: {
            code: "input_required_unsupported",
            retryable: false,
          },
        },
      ],
    });

    const providers = await buildSandboxProviders(
      makeRegistry([connector]),
      BASE,
      silentLogger,
    );
    const host = required(
      providers.find((provider) => provider.name === "connecta"),
    );
    const executeError = await required(host.fns.call)(
      "mrtr.needs_input",
      {},
    ).then(() => undefined, (error: unknown) => error);
    expect(executeError).toBeInstanceOf(InvocationFailure);
    expect(executeError).toMatchObject({
      code: "input_required_unsupported",
      retryable: false,
      message: expect.stringContaining("input_required"),
    });

    const executor: Executor = {
      async execute(_code, sandboxProviders) {
        const connecta = required(
          sandboxProviders.find((provider) => provider.name === "connecta"),
        );
        try {
          await required(connecta.fns.call)("mrtr.needs_input", {});
          return { result: "unexpected success" };
        } catch (error) {
          return {
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
    const executeResult = await createExecuteTool(
      makeRegistry([connector]),
      BASE,
      executor,
      silentLogger,
    )({ code: "async () => mrtr.needs_input({})" });
    expect(executeResult.isError).toBe(true);
    expect(executeResult.structuredContent).toMatchObject({
      error: {
        code: "input_required_unsupported",
        retryable: false,
        message: expect.stringContaining("input_required"),
      },
    });
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

    expect(required(result.content[0]).text).toBe("echo:next request");
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

  it("does not create connection state for a scope closed before use", async () => {
    let builds = 0;
    const connector = remoteMcp("down", {
      url: "https://unused.example/mcp",
      description: "Downstream",
      _transportFactory: () => {
        builds++;
        return {
          async start() {
            throw new Error("closed scope built a transport");
          },
          async send() {},
          async close() {},
        };
      },
    });
    const context = { ...ctx(), requestScope: {} };

    await connector.closeScope!(context);
    await expect(connector.listTools(context)).rejects.toThrow(
      "scope ended during connection",
    );
    expect(builds).toBe(0);
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
    expect(required(result.content[0]).text).toContain("timed out");
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
    expect(required(deletes[0]).sessionId).toBe("sess-1");
    // Load-bearing: the DELETE rides the transport's AbortSignal, so a
    // termination issued after the close would be aborted on arrival and free
    // nothing server-side while still looking like it worked.
    expect(required(deletes[0]).abortedWhenIssued).toBe(false);
    expect(required(deletes[0]).signal!.aborted).toBe(true);
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

  it("keeps the status verdict when the downstream refuses to terminate", async () => {
    const warn = vi.fn();
    const { connector, requests } = makeHttpDownstream({
      sessionId: "sess-1",
      onDelete: async () => new Response("no", { status: 500 }),
    });
    const context = {
      ...ctx(),
      logger: { ...silentLogger, warn },
      requestScope: {},
    };

    await expect(connector.status!(context)).resolves.toMatchObject({
      state: "ok",
    });
    await connector.closeScope!(context);
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(required(warn.mock.calls[0])[0]).toContain(
      'connector "down" session termination was refused or failed',
    );
    expect(String(required(warn.mock.calls[0])[1])).toContain(
      "Failed to terminate session",
    );
  });

  it("bounds a downstream that never answers the termination request", async () => {
    const warn = vi.fn();
    const { connector, requests } = makeHttpDownstream({
      sessionId: "sess-1",
      onDelete: () => new Promise<Response>(() => {}),
    });
    const context = {
      ...ctx(),
      logger: { ...silentLogger, warn },
      requestScope: {},
    };

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
    // caller-facing scope-close budget when invoked through the core; this
    // direct hook call waits its full network acknowledgement budget.
    expect(pending!.signal!.aborted).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(required(warn.mock.calls[0])[0]).toContain(
      "session termination was not acknowledged within 1000 ms",
    );
    expect(required(warn.mock.calls[0])[0]).toContain(
      "downstream may still finish the headers-only DELETE",
    );
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
    expect(required(warn.mock.calls[0])[0]).toContain("cleartext");
    expect(required(warn.mock.calls[0])[0]).toMatch(/http:\/\/example\.com/);
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

describe("remoteMcp() redirect policy", () => {
  it("rejects redirects by default without issuing the target request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const guarded = redirectSafeFetch(
      "down",
      undefined,
      async (url, init = {}) => {
        calls.push({ url: new URL(url).href, init });
        return new Response(null, {
          status: 307,
          headers: {
            location: "https://other.test/mcp?token=redirect-secret",
          },
        });
      },
    );

    const err = await guarded("https://downstream.test/mcp", {
      method: "POST",
      headers: { "x-api-key": "static-secret" },
      body: "{}",
    }).then(() => null, (error: unknown) => error);

    expect(err).toBeInstanceOf(RemoteMcpRedirectError);
    expect(err).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect((err as Error).message).not.toContain("redirect-secret");
    expect((err as Error).message).not.toContain("static-secret");
    expect(calls).toHaveLength(1);
    expect(required(calls[0]).init.redirect).toBe("manual");
  });

  it.each([
    [301, "GET", undefined],
    [302, "GET", undefined],
    [303, "GET", undefined],
    [307, "POST", "payload"],
    [308, "POST", "payload"],
  ] as const)(
    "follows an allowed same-origin %i with deliberate method/body semantics",
    async (status, expectedMethod, expectedBody) => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const guarded = redirectSafeFetch(
        "down",
        "same-origin",
        async (url, init = {}) => {
          calls.push({ url: new URL(url).href, init });
          if (calls.length === 1) {
            return new Response(null, {
              status,
              headers: {
                location:
                  status % 2 === 0
                    ? "https://downstream.test/next"
                    : "/next",
              },
            });
          }
          return new Response("ok");
        },
      );

      await expect(
        guarded("https://downstream.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "static-secret",
          },
          body: "payload",
        }),
      ).resolves.toBeInstanceOf(Response);

      expect(calls).toHaveLength(2);
      expect(required(calls[1]).url).toBe("https://downstream.test/next");
      expect(required(calls[1]).init.method).toBe(expectedMethod);
      expect(required(calls[1]).init.body).toBe(expectedBody);
      expect(new Headers(required(calls[1]).init.headers).get("x-api-key")).toBe(
        "static-secret",
      );
      expect(
        new Headers(required(calls[1]).init.headers).get("content-type"),
      ).toBe(expectedBody ? "application/json" : null);
      expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
    },
  );

  it.each([
    "http://downstream.test/plaintext",
    "https://127.0.0.1/mcp",
    "https://10.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/mcp",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[fe80::1]/mcp",
    "https://224.0.0.1/mcp",
  ])("never sends static headers to redirect target %s", async (target) => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const guarded = redirectSafeFetch(
      "down",
      "same-origin",
      async (url, init = {}) => {
        calls.push({
          url: new URL(url).href,
          headers: new Headers(init.headers),
        });
        return new Response(null, {
          status: 307,
          headers: { location: `${target}?secret=redirect-secret` },
        });
      },
    );

    const err = await guarded("https://downstream.test/mcp", {
      method: "POST",
      headers: { "x-api-key": "static-secret" },
      body: "{}",
    }).then(() => null, (error: unknown) => error);

    expect(err).toBeInstanceOf(RemoteMcpRedirectError);
    expect((err as Error).message).not.toContain("redirect-secret");
    expect((err as Error).message).not.toContain(target);
    expect(calls).toHaveLength(1);
    expect(required(calls[0]).headers.get("x-api-key")).toBe("static-secret");
  });

  it("never sends an OAuth bearer token across an origin boundary", async () => {
    const storage = memoryStorage();
    await storage.set(
      "oauth:tokens",
      JSON.stringify({ access_token: "oauth-secret", token_type: "bearer" }),
    );
    const calls: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: string | URL, init: RequestInit = {}) => {
        calls.push(new Headers(init.headers));
        return new Response(null, {
          status: 302,
          headers: { location: "https://authorization.test/elsewhere" },
        });
      },
    );
    const connector = remoteMcp("down", {
      url: "https://downstream.test/mcp",
      auth: { type: "oauth" },
      redirects: "same-origin",
    });

    await expect(
      connector.status!(ctx(storage)),
    ).resolves.toMatchObject({
      state: "error",
      message: expect.stringContaining("cross-origin redirect"),
    });
    expect(calls).toHaveLength(1);
    expect(required(calls[0]).get("authorization")).toBe("Bearer oauth-secret");
  });

  it("fails redirect loops and chains beyond the hard hop limit", async () => {
    const loopCalls: string[] = [];
    const looping = redirectSafeFetch(
      "down",
      "same-origin",
      async (url) => {
        const current = new URL(url);
        loopCalls.push(current.pathname);
        return new Response(null, {
          status: 308,
          headers: { location: current.pathname === "/a" ? "/b" : "/a" },
        });
      },
    );
    await expect(looping("https://downstream.test/a")).rejects.toThrow(
      /chain loops/,
    );
    expect(loopCalls).toEqual(["/a", "/b"]);

    let chainCalls = 0;
    const endless = redirectSafeFetch(
      "down",
      "same-origin",
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: `/hop-${++chainCalls}` },
        }),
    );
    await expect(endless("https://downstream.test/start")).rejects.toThrow(
      new RegExp(`exceeded ${MAX_REMOTE_REDIRECT_HOPS} hops`),
    );
    expect(chainCalls).toBe(MAX_REMOTE_REDIRECT_HOPS + 1);
  });

  it("installs the guarded fetch on the real SDK transport", async () => {
    const calls: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      async (_url: string | URL, init: RequestInit = {}) => {
        calls.push(new Headers(init.headers));
        return new Response(null, {
          status: 307,
          headers: { location: "https://other.test/mcp" },
        });
      },
    );
    const connector = remoteMcp("down", {
      url: "https://downstream.test/mcp",
      auth: { type: "headers", headers: { "x-api-key": "static-secret" } },
    });

    await expect(connector.status!(ctx())).resolves.toMatchObject({
      state: "error",
      message: expect.stringContaining("redirect policy rejected"),
    });
    expect(calls).toHaveLength(1);
    expect(required(calls[0]).get("x-api-key")).toBe("static-secret");
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
