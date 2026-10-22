import { afterEach, expect, it, vi } from "vitest";
import { remoteMcp, type RemoteMcpOptions } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import { connectorContext } from "./fixtures/misc.js";

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

it("INV-4 INV-5 INV-8: normalized extra headers partition negotiation and catalogs, redact echoes and coexist with mirrored names", async () => {
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
      expect(JSON.stringify(result)).not.toContain("tenant_");
    } finally {
      await connector.closeScope?.(ctx);
    }
  }
  expect(requests.filter((request) => request.method === "server/discover")).toHaveLength(2);
  expect(requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
  expect(requests.filter((request) => request.method === "tools/call")).toHaveLength(3);
  expect(requests.every((request) => request.headers.has("x-context") && request.headers.has("x-mode"))).toBe(true);
  expect((await Promise.all((await storage.list("")).map((key) => storage.get(key)))).join("")).not.toContain(
    "tenant_",
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
