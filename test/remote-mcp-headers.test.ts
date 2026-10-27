import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { remoteMcp, type RemoteMcpOptions } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import { connectorContext, scriptedExecutor } from "./fixtures/misc.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, required, silentLogger } from "./helpers.js";

beforeEach(() => {
  installOwnedTransport();
});

const URL = "https://down.test/mcp";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("INV-5 INV-11: extra header rules reject credentials, transport ownership and auth collisions without echoing values", () => {
  const value = "HEADER_VALUE_MUST_NOT_BE_DESCRIBED";
  const cases: Partial<RemoteMcpOptions>[] = [
    ...[
      "Authorization",
      "Cookie",
      "Host",
      "Content-Type",
      "Content-Length",
      "Accept",
      "Connection",
      "Keep-Alive",
      "Proxy-Authorization",
      "TE",
      "Trailer",
      "Transfer-Encoding",
      "Upgrade",
      "Mcp-Session-Id",
      "MCP-Protocol-Version",
      "Last-Event-ID",
      "DPoP",
      "X-Api-Key",
      "X-Secret",
    ].map((name) => ({ headers: { [name]: value } })),
    { headers: { "X-Context": value, "x-context": value } },
    { headers: { "bad name": value } },
    { headers: { "X-Context": `${value}\n` } },
    { headers: { "X-Context": 42 as never } },
    { headers: { "X-Context": value }, auth: { type: "headers", headers: {} } },
    { headers: { "x-context": value }, auth: { type: "credential", header: "X-Context" } },
    {
      headers: { "x-context": value },
      auth: { type: "request", token: async () => "token", headers: { "X-Context": "other" } },
    },
  ];
  for (const options of cases) {
    let failure: unknown;
    try {
      remoteMcp("down", { url: URL, ...options });
    } catch (error) {
      failure = error;
    }
    expect(failure, JSON.stringify(Object.keys(options.headers ?? {}))).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(value);
  }
  for (const auth of [
    undefined,
    { type: "oauth" },
    { type: "credential" },
    { type: "request", token: async () => "token" },
  ] satisfies (RemoteMcpOptions["auth"] | undefined)[]) {
    const connector = remoteMcp("down", { url: URL, headers: { "X-MCP-Toolsets": value }, ...(auth ? { auth } : {}) });
    expect(connector.describe?.().auth?.headerNames).toContain("x-mcp-toolsets");
    expect(JSON.stringify(connector.describe?.())).not.toContain(value);
  }
});

it("INV-4 INV-8: normalized extra headers partition negotiation and catalogs, return echoes and coexist with mirrored names", async () => {
  const requests: { method: string; headers: Headers }[] = [];
  let mirrored = false;
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const rpc = JSON.parse(String(init.body));
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    const headers = new Headers(init.headers);
    requests.push({ method: rpc.method, headers });
    const first = headers.get("x-context") === "tenant_alpha";
    const result =
      rpc.method === "server/discover"
        ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, instructions: headers.get("x-context") }
        : rpc.method === "tools/list"
          ? {
              resultType: "complete",
              ttlMs: 60_000,
              cacheScope: "public",
              tools: [
                {
                  name: first ? "read_one" : "read_two",
                  description: headers.get("x-context"),
                  annotations: { readOnlyHint: true },
                  inputSchema: {
                    type: "object",
                    properties: { scope: { type: "string", ...(mirrored ? { "x-mcp-header": "X-CONTEXT" } : {}) } },
                  },
                },
              ],
            }
          : { resultType: "complete", content: [{ type: "text", text: headers.get("x-context") }] };
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  const storage = memoryStorage();
  for (const [headers, expected] of [
    [{ "X-Context": "tenant_alpha", "X-Mode": "public_context" }, "read_one"],
    [{ "X-Context": "tenant_beta", "X-Mode": "public_context" }, "read_two"],
    [{ "x-mode": "public_context", "x-context": " tenant_alpha " }, "read_one"],
  ] as const) {
    const connector = remoteMcp("down", { url: URL, headers });
    const ctx = { ...connectorContext(storage), requestScope: {} };
    try {
      expect((await connector.listTools(ctx)).map((tool) => tool.name)).toEqual([expected]);
      const result = await connector.callTool(expected, {}, ctx);
      // Resource headers are non-secret context, so echoes return as sent (#1108).
      expect(JSON.stringify(result)).toContain(headers["X-Context" as keyof typeof headers] ?? "tenant_alpha");
    } finally {
      await connector.closeScope?.(ctx);
    }
  }
  expect(requests.filter((request) => request.method === "server/discover")).toHaveLength(2);
  expect(requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
  expect(requests.filter((request) => request.method === "tools/call")).toHaveLength(3);
  expect(requests.every((request) => request.headers.has("x-context") && request.headers.has("x-mode"))).toBe(true);
  expect((await Promise.all((await storage.list("")).map((key) => storage.get(key)))).join("")).toContain(
    "tenant_beta",
  );
  mirrored = true;
  const connector = remoteMcp("down", { url: URL, headers: { "X-Context": "new_context" } });
  const ctx = connectorContext(storage);
  try {
    const [tool] = await connector.listTools(ctx);
    await connector.callTool(tool!.name, { scope: "argument_context" }, ctx);
    const sent = requests.at(-1)!.headers;
    expect(sent.get("x-context")).toBe("new_context");
    expect(sent.get("mcp-param-x-context")).toBe("argument_context");
  } finally {
    await connector.closeScope?.(ctx);
  }
});

it("INV-5: resource headers never redact program arguments or echoes, while auth credentials still do (#1108)", async () => {
  const project = "project_alpha_123";
  const context = "tenant_context_456";
  const token = "REQUEST_BEARER_TOKEN_789";
  const sent: {
    args: Record<string, unknown>;
    project: string | null;
    context: string | null;
    mirrored: string | null;
  }[] = [];
  const downstream = httpDownstream((server) => {
    server.registerTool(
      "query",
      {
        inputSchema: z.object({ projectId: z.string(), scope: z.string(), probe: z.string() }).loose(),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [] }),
    );
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const message =
      request.method === "POST"
        ? ((await request.clone().json()) as { id?: unknown; method?: string; params?: Record<string, any> })
        : undefined;
    if (message?.method === "tools/call") {
      const args = message.params!.arguments as Record<string, unknown>;
      sent.push({
        args,
        project: request.headers.get("x-goog-user-project"),
        context: request.headers.get("x-auth-context"),
        mirrored: request.headers.get("mcp-param-x-auth-context"),
      });
      // The downstream echoes the project argument and the bearer it actually received.
      const text = `${args.projectId}.dataset|${args.scope}|${request.headers.get("authorization")}`;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { resultType: "complete", content: [{ type: "text", text }] },
      });
    }
    const response = await downstream.fetch(input as string, init);
    if (message?.method !== "tools/list") return response;
    const body = (await response.json()) as { result: { tools: { inputSchema: any }[] } };
    // `scope` is mirrored as `Mcp-Param-X-Auth-Context`, a credential-shaped wire name.
    body.result.tools[0]!.inputSchema.properties.scope["x-mcp-header"] = "X-Auth-Context";
    return Response.json(body, { status: response.status, headers: response.headers });
  });
  const executor = scriptedExecutor(async (fns) => {
    const results: unknown[] = [];
    for (const i of [1, 2, 3])
      results.push(
        await required(fns.call)("bq.query", { projectId: project, scope: context, probe: i === 1 ? "plain" : token }),
      );
    return results;
  });
  const connecta = createTestConnecta({
    connectors: [
      remoteMcp("bq", {
        url: downstream.url,
        // `X-Auth-Context` is an accepted resource name that wire-header registration
        // would otherwise treat as credential-shaped.
        headers: { "x-goog-user-project": project, "X-Auth-Context": context },
        auth: { type: "request", token: async () => token },
        readOnly: true,
      }),
    ],
    auth: [],
    storage: memoryStorage(),
    executor,
    logger: silentLogger,
  });
  const rpc = await readJsonRpc(
    await connecta.fetch(mcpRpc("tools/call", { name: "execute_code", arguments: { code: "async () => null" } })),
  );
  expect(rpc.result.isError, JSON.stringify(rpc.result)).toBeUndefined();
  expect(sent).toHaveLength(3);
  for (const call of sent)
    expect(call).toMatchObject({ project, context, mirrored: context, args: { projectId: project, scope: context } });
  // The outbound bearer token is still a sent secret: later calls never carry it.
  expect(sent.slice(1).map((call) => call.args.probe)).toEqual(["[redacted]", "[redacted]"]);
  const text = JSON.stringify(rpc.result);
  // Every call's echo returns the resource values intact; the bearer echo is redacted.
  expect(text.split(`${project}.dataset|${context}|[redacted]`).length - 1).toBeGreaterThanOrEqual(3);
  expect(text).not.toContain(token);
});

it("INV-5: auth.type headers values stay sent secrets in program arguments and echoes (#1108)", async () => {
  const key = "STATIC_HEADER_SECRET_321";
  const sent: unknown[] = [];
  const downstream = httpDownstream(
    (server) => {
      server.registerTool(
        "echo",
        { inputSchema: z.object({ value: z.string() }).loose(), annotations: { readOnlyHint: true } },
        async (args) => ({ content: [{ type: "text", text: `echo:${args.value}` }] }),
      );
    },
    {
      capture: async (request) => {
        if (request.method !== "POST") return;
        const message = (await request.json()) as { method?: string; params?: { arguments?: { value?: unknown } } };
        if (message.method === "tools/call") sent.push(message.params?.arguments?.value);
      },
    },
  );
  vi.stubGlobal("fetch", downstream.fetch);
  const executor = scriptedExecutor(async (fns) => {
    const results: unknown[] = [];
    for (let i = 0; i < 2; i++) results.push(await required(fns.call)("svc.echo", { value: key }));
    return results;
  });
  const connecta = createTestConnecta({
    connectors: [
      remoteMcp("svc", {
        url: downstream.url,
        auth: { type: "headers", headers: { "X-Service-Key": key } },
        readOnly: true,
      }),
    ],
    auth: [],
    storage: memoryStorage(),
    executor,
    logger: silentLogger,
  });
  const rpc = await readJsonRpc(
    await connecta.fetch(mcpRpc("tools/call", { name: "execute_code", arguments: { code: "async () => null" } })),
  );
  expect(rpc.result.isError).toBeUndefined();
  // The set fills during the first dispatch, as before; every later call is filtered.
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe("[redacted]");
  expect(JSON.stringify(rpc.result)).not.toContain(key);
});
