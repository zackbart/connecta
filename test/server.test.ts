import { describe, expect, it } from "vitest";
import { createConnecta } from "../src/index.js";

// True under @cloudflare/vitest-pool-workers. quickJsExecutor() is the Node
// executor (emscripten WASM loaded from disk) — Workers deployments use
// DynamicWorkerExecutor instead — so tests that actually run code skip there.
const WORKERD =
  typeof navigator !== "undefined" &&
  navigator.userAgent?.includes("Cloudflare-Workers");
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ActivityStore, ToolCallActivityEvent } from "../src/activity.js";
import type { Connector } from "../src/types.js";

const TOKEN = "test-token-123";
const BASE = "https://connecta.test";

function calc() {
  return api("calc", {
    description: "Calculator",
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        handler: (args: { a: number; b: number }) => ({ sum: args.a + args.b }),
      },
    ],
  });
}

function makeConnecta() {
  return createConnecta({
    connectors: [calc()],
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
  });
}

let nextId = 1;
async function rpc(
  connecta: { fetch: (r: Request) => Promise<Response> },
  method: string,
  params: unknown,
  opts: { token?: string } = {},
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await connecta.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  return res;
}

async function readBody(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    // Parse the last SSE `data:` line as JSON.
    const line = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .pop();
    return line ? JSON.parse(line.slice("data:".length).trim()) : null;
  }
  return text ? JSON.parse(text) : null;
}

describe("server /mcp end-to-end", () => {
  it("401s without a token and includes WWW-Authenticate", async () => {
    const c = makeConnecta();
    const res = await rpc(c, "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("serves CORS on /mcp errors so browsers can read the 401", async () => {
    const c = makeConnecta();
    const res = await rpc(c, "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain(
      "WWW-Authenticate",
    );
  });

  it("serves CORS on successful /mcp responses too", async () => {
    const c = makeConnecta();
    const res = await rpc(
      c,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      { token: TOKEN },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain(
      "mcp-session-id",
    );
  });

  it("initialize succeeds with a valid token", async () => {
    const c = makeConnecta();
    const res = await rpc(
      c,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      { token: TOKEN },
    );
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.result.serverInfo.name).toBe("connecta");
    expect(body.result.instructions).toContain(
      "Use call_tool for one explicitly read-only call",
    );
    expect(body.result.instructions).toContain('skills({ name: "usage" })');
  });

  it("initialize passes through title, websiteUrl, and icons (MCP icons spec)", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      serverInfo: {
        name: "acme-tools",
        title: "Acme Tools",
        websiteUrl: "https://acme.example",
        icons: [{ src: `${BASE}/favicon.svg`, mimeType: "image/svg+xml" }],
      },
    });
    const res = await rpc(
      c,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      { token: TOKEN },
    );
    const body = await readBody(res);
    expect(body.result.serverInfo.name).toBe("acme-tools");
    expect(body.result.serverInfo.title).toBe("Acme Tools");
    expect(body.result.serverInfo.websiteUrl).toBe("https://acme.example");
    expect(body.result.serverInfo.icons).toEqual([
      { src: `${BASE}/favicon.svg`, mimeType: "image/svg+xml" },
    ]);
  });

  it("tools/list shows exactly the 9 base meta-tools", async () => {
    const c = makeConnecta();
    const res = await rpc(c, "tools/list", {}, { token: TOKEN });
    const body = await readBody(res);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "authorize_connector",
      "batch_call",
      "call_destructive_tool",
      "call_tool",
      "describe_tools",
      "get_result",
      "list_connectors",
      "search_tools",
      "skills",
    ]);
    const byName = Object.fromEntries(
      body.result.tools.map((tool: { name: string }) => [tool.name, tool]),
    );
    expect(
      byName.search_tools.inputSchema.properties.includeSchemas.enum,
    ).toEqual(["compact", "json"]);
    expect(byName.call_tool.inputSchema.properties).toHaveProperty("timeoutMs");
    expect(byName.call_tool.inputSchema.properties).toHaveProperty(
      "maxRetries",
    );
    expect(byName.call_tool.inputSchema.properties).toHaveProperty(
      "diagnostics",
    );
    expect(byName.call_destructive_tool.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(byName.skills.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.call_tool.description).toContain(
      "For 2–10 independent read-only calls use batch_call",
    );
    expect(byName.batch_call.description).toContain(
      "use execute_code when available instead for dependencies",
    );
  });

  it("lists and fetches the usage skill", async () => {
    const c = makeConnecta();
    const listed = await rpc(
      c,
      "tools/call",
      { name: "skills", arguments: {} },
      { token: TOKEN },
    );
    const listedBody = await readBody(listed);
    expect(listedBody.result.isError).toBeFalsy();
    expect(listedBody.result.content[0].text).toContain(
      "`usage` — How to choose among Connecta",
    );

    const fetched = await rpc(
      c,
      "tools/call",
      { name: "skills", arguments: { name: "usage" } },
      { token: TOKEN },
    );
    const fetchedBody = await readBody(fetched);
    const skill = fetchedBody.result.content[0].text as string;
    expect(skill).toContain("# Connecta usage");
    expect(skill).toContain("One explicitly read-only call: `call_tool`");
    expect(skill).toContain(
      "Dependent read-only calls, loops, joins, branching, or large-result reduction",
    );
    expect(skill).toContain(
      "Any unannotated, write-capable, or destructive call: `call_destructive_tool`",
    );

    const missing = await rpc(
      c,
      "tools/call",
      { name: "skills", arguments: { name: "missing" } },
      { token: TOKEN },
    );
    const missingBody = await readBody(missing);
    expect(missingBody.result.isError).toBe(true);
    expect(missingBody.result.content[0].text).toContain(
      'Unknown skill "missing"',
    );
  });

  it("mentions per-connector guides only when the deployment has one", async () => {
    async function skillsSurface(connectors: Connector[]) {
      const c = createConnecta({
        connectors,
        auth: bearerToken(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const listed = await readBody(
        await rpc(c, "tools/list", {}, { token: TOKEN }),
      );
      const usage = await readBody(
        await rpc(
          c,
          "tools/call",
          { name: "skills", arguments: { name: "usage" } },
          { token: TOKEN },
        ),
      );
      const byName = Object.fromEntries(
        listed.result.tools.map((tool: { name: string }) => [tool.name, tool]),
      );
      return {
        description: byName.skills.description as string,
        search: byName.search_tools.description as string,
        describe: byName.describe_tools.description as string,
        usage: usage.result.content[0].text as string,
      };
    }

    const plain = await skillsSurface([calc()]);
    expect(plain.description).not.toContain("connector:<connectorId>");
    expect(plain.usage).not.toContain("## Per-connector guides");
    expect(plain.search).not.toContain("`guide`");
    expect(plain.describe).not.toContain("`guide`");

    const guided = await skillsSurface([
      api("notion", {
        description: "Notion",
        usageGuide: "# Notion usage\n\nSearch before listing.\n",
        tools: [
          {
            name: "search",
            description: "Search pages",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            handler: () => [],
          },
        ],
      }),
    ]);
    expect(guided.description).toContain("connector:<connectorId>");
    expect(guided.usage).toContain("## Per-connector guides");
    expect(guided.search).toContain("`guide`");
    expect(guided.describe).toContain("`guide`");
  });

  it("tools/call search_tools returns results grouped by connector", async () => {
    const c = makeConnecta();
    const res = await rpc(
      c,
      "tools/call",
      { name: "search_tools", arguments: { query: "add" } },
      { token: TOKEN },
    );
    const body = await readBody(res);
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text) as {
      connectors: { id: string; tools: { address: string }[] }[];
      total: number;
    };
    expect(payload.connectors).toHaveLength(1);
    expect(body.result.structuredContent).toEqual(payload);
    expect(payload.connectors[0].id).toBe("calc");
    expect(payload.connectors[0].tools.map((t) => t.address)).toEqual([
      "calc.add",
    ]);
    expect(payload.total).toBe(1);
  });

  it("tools/call call_tool invokes a downstream api tool", async () => {
    const c = makeConnecta();
    const res = await rpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 2, b: 5 } },
      },
      { token: TOKEN },
    );
    const body = await readBody(res);
    expect(body.result.isError).toBeFalsy();
    const inner = JSON.parse(body.result.content[0].text);
    expect(inner).toEqual({ sum: 7 });
  });

  it("records one payload-free activity event for each resolved tool call", async () => {
    const events: ToolCallActivityEvent[] = [];
    const activity: ActivityStore = {
      record(event) {
        events.push(event);
      },
    };
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN, { subjectId: "cli-zack" }),
      storage: memoryStorage(),
      publicUrl: BASE,
      activity,
      activityDeploymentId: "test",
    });

    await rpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: {
          address: "calc.add",
          args: { a: 2, b: 5, secret: "never-store-this" },
        },
      },
      { token: TOKEN },
    );
    await rpc(
      c,
      "tools/call",
      {
        name: "batch_call",
        arguments: {
          calls: [
            { address: "calc.add", args: { a: 1, b: 2 } },
            { address: "calc.add", args: { a: 3, b: 4 } },
          ],
        },
      },
      { token: TOKEN },
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      actor: { kind: "bearer", id: "cli-zack" },
      address: "calc.add",
      connectorId: "calc",
      toolName: "add",
      source: "call_tool",
      outcome: "success",
      attempts: 1,
      deploymentId: "test",
    });
    expect(
      events.slice(1).every((event) => event.source === "batch_call"),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("never-store-this");
  });

  it("stores a finite error code instead of a raw downstream error", async () => {
    const events: ToolCallActivityEvent[] = [];
    const failing: Connector = {
      id: "private",
      kind: "api",
      async listTools() {
        return [{ name: "fail", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        throw new Error("customer secret appeared in the provider response");
      },
    };
    const c = createConnecta({
      connectors: [failing],
      auth: bearerToken(TOKEN),
      activity: {
        record(event) {
          events.push(event);
        },
      },
      publicUrl: BASE,
    });

    await rpc(
      c,
      "tools/call",
      { name: "call_tool", arguments: { address: "private.fail" } },
      { token: TOKEN },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { kind: "bearer" },
      address: "private.fail",
      outcome: "error",
      errorCode: "connector_call_failed",
    });
    expect(JSON.stringify(events)).not.toContain("customer secret");
  });

  it("tools/call authorize_connector kicks a startAuth flow end-to-end", async () => {
    const authConn: Connector = {
      id: "needsauth",
      kind: "mcp",
      description: "Needs auth",
      async listTools() {
        throw new Error("unauthorized");
      },
      async callTool() {
        throw new Error("unauthorized");
      },
      async startAuth() {
        return {
          state: "auth_required",
          authorizationUrl: "https://auth.example/authorize?x=1",
          message: "Authorization required — open the URL to connect.",
        };
      },
    };
    const c = createConnecta({
      connectors: [calc(), authConn],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await rpc(
      c,
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "needsauth" } },
      { token: TOKEN },
    );
    const body = await readBody(res);
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text) as {
      connector: string;
      status: string;
      authorizationUrl?: string;
    };
    expect(payload.connector).toBe("needsauth");
    expect(payload.status).toBe("auth_required");
    expect(payload.authorizationUrl).toContain("auth.example");
  });

  it("tools/call get_result rejects a page size that could not advance", async () => {
    // Characterization, not regression: the registered zod schema already
    // rejected a maxBytes of 0 before issue #32, and this passes unchanged
    // against that earlier code. It is here to pin that pre-existing wire
    // behavior in place, because the handler behind it used to answer such a
    // page size with an empty slice whose nextOffset equalled the offset it
    // was given — a client paging on nextOffset would never terminate. The
    // schema is the only thing that kept that off the wire, so it should not
    // be loosened without noticing.
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await rpc(
      c,
      "tools/call",
      { name: "get_result", arguments: { id: "any", maxBytes: 0 } },
      { token: TOKEN },
    );
    const body = await readBody(res);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("maxBytes");
  });
});

describe("server open routes", () => {
  it("redirects HTTP to the configured HTTPS public URL", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request("http://connecta.test/ui?probe=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://connecta.test/ui?probe=1",
    );
  });

  it("dispatches connector-owned routes, inside the security headers", async () => {
    const withRoute: Connector = {
      ...calc(),
      id: "files",
      async handleRequest(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/download/report.txt") return null;
        return new Response("body", { headers: { "Content-Type": "text/plain" } });
      },
    };
    const c = createConnecta({
      connectors: [withRoute],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await c.fetch(new Request(`${BASE}/download/report.txt`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
    // The seam exists so these routes stop bypassing the wrapper every other
    // route goes through.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
  });

  it("declining connector routes fall through to 404", async () => {
    const c = createConnecta({
      connectors: [{ ...calc(), async handleRequest() { return null; } }],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    expect((await c.fetch(new Request(`${BASE}/nope`))).status).toBe(404);
  });

  it("a connector route cannot shadow a built-in route", async () => {
    const greedy: Connector = {
      ...calc(),
      async handleRequest() {
        return new Response("hijacked", { status: 200 });
      },
    };
    const c = createConnecta({
      connectors: [greedy],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const health = await c.fetch(new Request(`${BASE}/health`));
    expect(await health.text()).toContain('"status":"ok"');
    const mcp = await c.fetch(new Request(`${BASE}/mcp`, { method: "POST" }));
    expect(mcp.status).toBe(401);
  });

  it("a throwing connector route is a 500, not a 404", async () => {
    const c = createConnecta({
      connectors: [
        {
          ...calc(),
          async handleRequest() {
            throw new Error("boom");
          },
        },
      ],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    expect((await c.fetch(new Request(`${BASE}/anything`))).status).toBe(500);
  });

  it("serves /health over HTTP without redirecting to the public URL", async () => {
    // Container HEALTHCHECKs hit loopback over plain HTTP; a 308 to the public
    // origin would make the probe depend on external DNS and TLS.
    const c = makeConnecta();
    const res = await c.fetch(new Request("http://127.0.0.1:8787/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("keeps HTTP available when no HTTPS public URL is configured", async () => {
    const c = createConnecta({ connectors: [calc()] });
    const res = await c.fetch(new Request("http://localhost:8787/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("/health is open (no auth)", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.connectors).toBe(1);
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("protects the UI from framing without applying UI CSP to MCP routes", async () => {
    const c = makeConnecta();
    const ui = await c.fetch(new Request(`${BASE}/ui`));
    // The /ui page ships a nonce-based script CSP that still forbids framing.
    const csp = ui.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(ui.headers.get("X-Frame-Options")).toBe("DENY");

    const health = await c.fetch(new Request(`${BASE}/health`));
    expect(health.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("/health exposes additive server and deployment version metadata", async () => {
    const c = createConnecta({
      connectors: [calc()],
      deploymentInfo: {
        id: "worker-version-123",
        tag: "production",
        timestamp: "2026-07-23T00:00:00.000Z",
      },
      serverInfo: { name: "connecta-test", version: "9.9.9" },
    });
    const res = await c.fetch(new Request(`${BASE}/health`));
    const body = (await res.json()) as any;
    expect(body.server).toEqual({ name: "connecta-test", version: "9.9.9" });
    expect(body.deployment).toMatchObject({
      id: "worker-version-123",
      tag: "production",
    });
  });

  it("OPTIONS returns a CORS preflight 204", async () => {
    const c = makeConnecta();
    const res = await c.fetch(
      new Request(`${BASE}/mcp`, { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("clerk metadata routes (no network)", () => {
  // Fake publishable key: pk_test_<base64 domain with trailing $>.
  const domain = "clerk.example.com$";
  const pk = "pk_test_" + Buffer.from(domain, "utf8").toString("base64");

  function makeClerkConnecta() {
    return createConnecta({
      connectors: [calc()],
      auth: [
        bearerToken(TOKEN),
        clerkAuth({
          publishableKey: pk,
          secretKey: "sk_test_fake",
          publicUrl: BASE,
        }),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
  }

  it("serves oauth-protected-resource metadata pointing at the derived fapi url", async () => {
    const c = makeClerkConnecta();
    const res = await c.fetch(
      new Request(`${BASE}/.well-known/oauth-protected-resource`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resource).toBe(`${BASE}/mcp`);
    expect(body.authorization_servers).toEqual(["https://clerk.example.com"]);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves the /mcp-suffixed protected-resource variant too", async () => {
    const c = makeClerkConnecta();
    const res = await c.fetch(
      new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resource).toBe(`${BASE}/mcp`);
  });

  it("OPTIONS on a .well-known route returns 204 with CORS", async () => {
    const c = makeClerkConnecta();
    const res = await c.fetch(
      new Request(`${BASE}/.well-known/oauth-protected-resource`, {
        method: "OPTIONS",
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("bearer token still admits /mcp when clerk is co-configured", async () => {
    const c = makeClerkConnecta();
    const res = await rpc(c, "tools/list", {}, { token: TOKEN });
    const body = await readBody(res);
    expect(body.result.tools).toHaveLength(9);
  });
});

describe("execute_code registration (code mode)", () => {
  it("is absent without an executor and present with one", async () => {
    const plain = makeConnecta();
    const res1 = await rpc(plain, "tools/list", {}, { token: TOKEN });
    const names1 = (await readBody(res1)).result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names1).not.toContain("execute_code");

    const { quickJsExecutor } = await import("../src/executors/quickjs.js");
    const withExec = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: quickJsExecutor(),
    });
    const res2 = await rpc(withExec, "tools/list", {}, { token: TOKEN });
    const names2 = (await readBody(res2)).result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names2).toContain("execute_code");
    expect(names2).toHaveLength(10);
  });

  it.skipIf(WORKERD)("runs code against connectors end to end", async () => {
    const { quickJsExecutor } = await import("../src/executors/quickjs.js");
    const events: ToolCallActivityEvent[] = [];
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: quickJsExecutor(),
      activity: {
        record(event) {
          events.push(event);
        },
      },
    });
    const res = await rpc(
      c,
      "tools/call",
      {
        name: "execute_code",
        arguments: {
          code: `async () => {
            const sums = await Promise.all(
              [1, 2, 3].map((n) => calc.add({ a: n, b: n }))
            );
            console.log("done");
            return sums.map((s) => s.sum);
          }`,
        },
      },
      { token: TOKEN },
    );
    const body = await readBody(res);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.result).toEqual([2, 4, 6]);
    expect(payload.logs).toBe("done");
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.source === "execute_code")).toBe(true);
  });

  it.skipIf(WORKERD)("discovers and calls an API tool inside one execute_code request", async () => {
    const { quickJsExecutor } = await import("../src/executors/quickjs.js");
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: quickJsExecutor(),
    });
    const res = await rpc(
      c,
      "tools/call",
      {
        name: "execute_code",
        arguments: {
          code: `async () => {
            const found = await connecta.search({
              query: "add",
              includeSchemas: "compact"
            });
            const described = await connecta.describe({
              addresses: [found.tools[0].address]
            });
            const value = await connecta.call(found.tools[0].address, {
              a: 4,
              b: 5
            });
            return {
              address: found.tools[0].address,
              schema: described.tools[0].inputSchema,
              value
            };
          }`,
        },
      },
      { token: TOKEN },
    );
    const body = await readBody(res);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.result).toEqual({
      address: "calc.add",
      schema: "{ a: number, b: number }",
      value: { sum: 9 },
    });
  });
});
