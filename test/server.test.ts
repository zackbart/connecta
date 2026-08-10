import { createTestConnecta, required } from "./helpers.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { MAX_SEARCH_LIMIT } from "../src/meta-tools.js";
import {
  MCP_APPS_EXTENSION,
  PROGRAM_UI_MIME_TYPE,
  PROGRAM_UI_RESOURCE_URI,
  PROGRAM_UI_SHELL_HTML,
} from "../src/apps-shell.js";

// True under @cloudflare/vitest-pool-workers. quickJsExecutor() is the Node
// executor (emscripten WASM loaded from disk) — Workers deployments use
// DynamicWorkerExecutor instead — so tests that actually run code skip there.
const WORKERD =
  typeof navigator !== "undefined" &&
  navigator.userAgent?.includes("Cloudflare-Workers");

async function loadQuickJsExecutor() {
  // This module now imports node:child_process by design. Keep it out of the
  // Workers bundle entirely; the two callers below skip under workerd.
  const path = "../src/executors/quickjs" + ".js";
  return import(/* @vite-ignore */ path) as Promise<
    typeof import("../src/executors/quickjs.js")
  >;
}
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ActivityStore, ToolCallActivityEvent } from "../src/activity.js";
import type { Connector, InboundAuth } from "../src/types.js";

const TOKEN = "test-token-123";
const BASE = "https://connecta.test";
const CREDENTIAL_KEY = Buffer.alloc(32, 13).toString("base64");

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
  return createTestConnecta({
    connectors: [calc()],
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
  });
}

function fakeClerkOperator(): InboundAuth {
  return {
    kind: "clerk",
    uiAuth: {
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.com",
    },
    authorize(request) {
      if (request.headers.get("authorization") === "Bearer operator-token") {
        return { ok: true, userId: "operator_1" };
      }
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    },
  };
}

function recoverableStaticConnector(): Connector {
  return api("static", {
    description: "Static credential recovery fixture",
    credential: {
      label: "Service credentials",
      fields: [
        {
          name: "account",
          label: "Account",
          description: "The service account identifier.",
        },
        {
          name: "apiKey",
          label: "API key",
          description: "The API key issued for that account.",
        },
      ],
    },
    tools: [
      {
        name: "whoami",
        description: "Return the configured service account.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
        handler: async (_args, ctx) => {
          const values = await ctx.credential?.getAll();
          if (!values) {
            throw new ConnectorCallError(
              "auth_required",
              "Operator-managed credentials are required.",
            );
          }
          return { account: values.account };
        },
      },
    ],
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

  it("serves CORS on successful legacy /mcp responses too", async () => {
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

  it("legacy initialize succeeds with a valid token", async () => {
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
      "then one call_tool",
    );
    expect(body.result.instructions).toContain(
      "2–4 distinctive action/object terms",
    );
    expect(body.result.instructions).toContain('skills({ name: "usage" })');
    expect(body.result.instructions).toContain(
      "If this routing is unfamiliar",
    );
    expect(body.result.instructions).toContain(
      "do not call top-level search_tools",
    );
    expect(body.result.instructions).toContain(
      "never return discovery for another call",
    );
    expect(body.result.instructions).toContain(
      "connecta.ui(html) is a guest function inside execute_code",
    );
    expect(body.result.instructions).toContain(
      "never a connector address or search_tools result",
    );
    expect(body.result.instructions).toContain("pass one HTML string");
    expect(body.result.instructions).toContain(
      "return the same initial summary data the HTML renders",
    );
    expect(body.result.instructions).not.toContain("once per task");
  });

  it("legacy initialize passes through title, websiteUrl, and icons (MCP icons spec)", async () => {
    const c = createTestConnecta({
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

  it("serves a modern client without initialize and emits private tools/list cache hints", async () => {
    const c = makeConnecta();
    const methods: string[] = [];
    let toolsListResult: Record<string, unknown> | undefined;
    const client = new Client(
      { name: "modern-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${BASE}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const payload = (await request.clone().json()) as {
            method?: string;
          };
          if (payload.method) methods.push(payload.method);
          const response = await c.fetch(request);
          if (payload.method === "tools/list") {
            const body = (await response.clone().json()) as {
              result?: Record<string, unknown>;
            };
            toolsListResult = body.result;
          }
          return response;
        },
      },
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();

      expect(result.tools).toHaveLength(7);
      expect(client.getProtocolEra()).toBe("modern");
      expect(methods).toContain("server/discover");
      expect(methods).not.toContain("initialize");
      expect(toolsListResult).toMatchObject({
        resultType: "complete",
        ttlMs: 3_600_000,
        cacheScope: "private",
      });
    } finally {
      await client.close();
    }
  });

  it("tools/list shows exactly the seven meta-tools", async () => {
    const c = makeConnecta();
    const res = await rpc(c, "tools/list", {}, { token: TOKEN });
    const body = await readBody(res);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "authorize_connector",
      "call_destructive_tool",
      "call_tool",
      "execute_code",
      "get_result",
      "search_tools",
      "skills",
    ]);
    const byName = Object.fromEntries(
      body.result.tools.map((tool: { name: string }) => [tool.name, tool]),
    );
    expect(
      byName.search_tools.inputSchema.properties.includeSchemas.enum,
    ).toEqual(["compact", "json"]);
    expect(byName.search_tools.inputSchema.properties.safety.enum).toEqual([
      "readOnly",
      "approvalRequired",
      "all",
    ]);
    expect(byName.search_tools.description).toContain(
      "2–4 distinctive action/object terms",
    );
    expect(byName.search_tools.description).toContain(
      "omit limit initially (default 8)",
    );
    expect(byName.search_tools.description).toContain(
      "Use top-level search only for exactly one unreduced read",
    );
    expect(byName.search_tools.description).toContain(
      "For read-only reduction, dependent or multiple calls, never search here",
    );
    // Programs admit read-only tools only, so multi-step destructive work has
    // nowhere to discover but here. Scoping the prohibition to read-only work
    // is what keeps that route open (#295).
    expect(byName.search_tools.description).toContain(
      "for write-capable work, then call_destructive_tool",
    );
    expect(byName.search_tools.description).toContain(
      "never the first lexical match",
    );
    expect(byName.search_tools.description).toContain(
      "set connector to the obvious integration id to load one catalog instead of all",
    );
    expect(byName.search_tools.description).toContain(
      "the input and any declared output shape",
    );
    expect(byName.search_tools.description).toContain(
      "matches also carry declared annotations",
    );
    expect(byName.search_tools.description).toContain(
      'safety="readOnly" returns only calls available',
    );
    expect(byName.search_tools.description).toContain(
      "filters results, not authority",
    );
    expect(byName.search_tools.description).toContain("connecta.describe");
    expect(byName.execute_code.description).toContain(
      "set connector to the obvious id to load one, otherwise it loads all",
    );
    expect(byName.search_tools.inputSchema.properties.limit.maximum).toBe(
      MAX_SEARCH_LIMIT,
    );
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
    // Bounded above only: an empty reason is treated as no reason, never as a
    // validation failure that refuses the call.
    expect(
      byName.call_destructive_tool.inputSchema.properties.reason,
    ).toMatchObject({ type: "string", maxLength: 500 });
    expect(
      byName.call_destructive_tool.inputSchema.properties.reason,
    ).not.toHaveProperty("minLength");
    expect(byName.call_destructive_tool.description).toContain(
      "reason explaining the intended consequence",
    );
    expect(byName.skills.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // Both halves of the routing each of these descriptions performs: where
    // the tool sends work it declines to do, and the narrow case it admits.
    expect(byName.call_tool.description).toContain("connecta.batch");
    expect(byName.call_tool.description).toContain(
      "ONE tool explicitly annotated",
    );
    expect(byName.get_result.description).toContain(
      "reduce it in code instead",
    );
  });

  it("declares exactly one extension, the MCP Apps one (U11)", async () => {
    const c = makeConnecta();
    const body = await readBody(
      await rpc(
        c,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        { token: TOKEN },
      ),
    );
    const extensions = body.result.capabilities.extensions as Record<
      string,
      unknown
    >;
    expect(Object.keys(extensions)).toEqual([MCP_APPS_EXTENSION]);
    expect(extensions[MCP_APPS_EXTENSION]).toEqual({
      mimeTypes: [PROGRAM_UI_MIME_TYPE],
    });
    // Registering the shell is what puts `resources` on the wire; without it
    // `resources/list` would be an undeclared method. `listChanged: false` is
    // declared rather than defaulted: connecta serves one build-time template
    // and never sends a list_changed notification, so a client that subscribed
    // on the strength of that flag would wait forever.
    expect(body.result.capabilities.resources).toEqual({ listChanged: false });
  });

  it("keeps seven tools while exposing only call_tool to program views", async () => {
    const c = makeConnecta();
    const body = await readBody(await rpc(c, "tools/list", {}, { token: TOKEN }));
    const execute = body.result.tools.find(
      (tool: { name: string }) => tool.name === "execute_code",
    );
    expect(execute._meta.ui).toEqual({
      resourceUri: PROGRAM_UI_RESOURCE_URI,
      visibility: ["model"],
    });
    expect(execute.description).toContain("connecta.ui(html, options?)");
    expect(execute.description).toContain(
      "{ reads: { name: { address, fixedArgs?, viewArgs? } } }",
    );
    expect(execute.description).toContain("connecta.read(name, args)");
    // U12: the model never sees the view, so the description says what the
    // program owes it instead — a return value that mirrors what was rendered.
    // A view the return does not mirror is a view nobody can check (#282).
    expect(execute.description).toContain(
      "the model reads the return value, not the view",
    );
    expect(execute.description).toContain(
      "return the initial summary from its variables",
    );
    // U2 and U4 are the two facts compression keeps eroding: a second call
    // throws rather than quietly winning, and the payload spends the emit
    // budget itself rather than a same-sized one of its own.
    expect(execute.description).toContain(
      "a second, over-budget, or invalid call throws catchably",
    );
    expect(execute.description).toContain("one budget, not two");
    expect(body.result.tools).toHaveLength(7);
    // No other tool claims a view. `call_tool` alone accepts app-originated
    // calls; every other existing model tool says model-only explicitly so
    // the Apps default cannot widen it by accident.
    for (const tool of body.result.tools) {
      if (tool.name === "execute_code") continue;
      expect(tool._meta?.ui).toEqual({
        visibility:
          tool.name === "call_tool" ? ["model", "app"] : ["model"],
      });
    }
  });

  it("serves exactly the shell URI and lists nothing (U5)", async () => {
    const c = makeConnecta();
    const read = await readBody(
      await rpc(
        c,
        "resources/read",
        { uri: PROGRAM_UI_RESOURCE_URI },
        { token: TOKEN },
      ),
    );
    expect(read.result.contents).toHaveLength(1);
    const [shell] = read.result.contents;
    expect(shell.uri).toBe(PROGRAM_UI_RESOURCE_URI);
    expect(shell.mimeType).toBe(PROGRAM_UI_MIME_TYPE);
    expect(shell.text).toBe(PROGRAM_UI_SHELL_HTML);
    expect(String(shell.text).startsWith("<!doctype html>")).toBe(true);

    for (const uri of [
      "ui://connecta/program-ui/v3",
      "ui://connecta/program-ui",
      "ui://elsewhere/view",
      "https://connecta.test/mcp",
      "file:///etc/passwd",
    ]) {
      const missing = await readBody(
        await rpc(c, "resources/read", { uri }, { token: TOKEN }),
      );
      expect(missing.result, uri).toBeUndefined();
      expect(missing.error, uri).toBeDefined();
    }

    // The method answers — the capability stays honest — and carries nothing.
    const listed = await readBody(
      await rpc(c, "resources/list", {}, { token: TOKEN }),
    );
    expect(listed.result.resources).toEqual([]);

    // The sibling listing has to survive the `resources/list` override: the
    // resources capability covers both methods, and a client that probes for
    // templates must get an empty list rather than "method not found".
    const templates = await readBody(
      await rpc(c, "resources/templates/list", {}, { token: TOKEN }),
    );
    expect(templates.error).toBeUndefined();
    expect(templates.result.resourceTemplates).toEqual([]);
  });

  it("delivers the UI payload in result _meta over the wire (U3)", async () => {
    // The unit tests call the handler directly. This one is the whole path:
    // an execute_code tools/call through the transport, so a serialization
    // step that dropped `_meta` — the only channel the shell reads — would be
    // caught here rather than in a host.
    const view = "<!doctype html><p>over the wire</p>";
    const c = createTestConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: {
        execute: async (_code, providers) => {
          const fns = required(
            providers.find((provider) => provider.name === "connecta"),
          ).fns;
          await required(fns.ui)(view);
          return { result: { rendered: true } };
        },
      },
    });
    const body = await readBody(
      await rpc(
        c,
        "tools/call",
        { name: "execute_code", arguments: { code: "async () => null" } },
        { token: TOKEN },
      ),
    );
    expect(body.result.isError).toBeFalsy();
    // Assert the key, not the whole object: the SDK stamps its own
    // `io.modelcontextprotocol/serverInfo` into the same `_meta`.
    expect(body.result._meta["connecta/ui"]).toEqual({ html: view });
    expect(body.result.structuredContent).toEqual({
      result: { rendered: true },
      ui: true,
    });
    // The model's channel says a view rendered and never carries its bytes.
    expect(body.result.content[0].text).not.toContain("over the wire");
  });

  it("treats an empty call_destructive_tool reason as absent, not invalid", async () => {
    // A model that sends "" or whitespace has written no reason. Refusing the
    // whole consequential call over a field the host merely displays would be
    // a validation error where a shrug belongs.
    const c = makeConnecta();
    for (const reason of ["", "   "]) {
      const res = await rpc(
        c,
        "tools/call",
        {
          name: "call_destructive_tool",
          arguments: { address: "calc.add", args: { a: 1, b: 2 }, reason },
        },
        { token: TOKEN },
      );
      const body = await readBody(res);
      expect(body.error, JSON.stringify(body)).toBeUndefined();
      expect(body.result.isError).toBeFalsy();
      expect(JSON.parse(body.result.content[0].text)).toMatchObject({ sum: 3 });
    }
  });

  it("serves a modern-era (2026-07-28) client the same seven-tool surface", async () => {
    // Every other test in this suite sends bare JSON-RPC, which the entry
    // classifies as legacy traffic — so this is the one automated proof that
    // the modern createMcpHandler leg of serveMcp works at all. PR B owns the
    // full revision-adoption matrix; this pins the fork itself.
    const c = makeConnecta();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${BASE}/mcp`),
      {
        fetch: (async (url: string | URL, init?: RequestInit) =>
          c.fetch(new Request(url, init))) as typeof fetch,
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    );
    const client = new Client(
      { name: "modern-probe", version: "0.0.0" },
      // Pinning is the strict spelling: auto would silently fall back to the
      // legacy leg and this test would stop proving anything. The literal is
      // deliberate — the pinned SDK's *typed* surface exports no modern
      // version constant (its LATEST_PROTOCOL_VERSION is still 2025-11-25),
      // and a pin of a non-modern revision throws at connect, so a stale
      // literal here fails loudly rather than drifting.
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(client.getProtocolEra()).toBe("modern");
      expect(listed.tools.map((t) => t.name).sort()).toEqual([
        "authorize_connector",
        "call_destructive_tool",
        "call_tool",
        "execute_code",
        "get_result",
        "search_tools",
        "skills",
      ]);
      // One tools/call round trip so the modern leg proves results, not just
      // catalog serving.
      const skills = (await client.callTool({
        name: "skills",
        arguments: {},
      })) as { content: { type: string; text?: string }[] };
      expect(skills.content[0]?.type).toBe("text");
    } finally {
      await client.close();
    }
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
      "`usage` — How to route work between one execute_code program",
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
    expect(skill).toContain("then `call_tool` once");
    expect(skill).toContain("Anything wider — two or more calls");
    expect(skill).toContain(
      "Any unannotated, write-capable, or destructive call: `call_destructive_tool`",
    );
    expect(skill).toContain(
      "Only tools annotated `readOnlyHint: true` are reachable",
    );
    expect(skill).toContain("2–4 distinctive action/object terms");
    expect(skill).toContain(
      '`format: "json"` only for exact constraints',
    );
    expect(skill).not.toContain("## Examples");

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

  it("keeps shared usage stable while guide-specific tool notes stay conditional", async () => {
    async function skillsSurface(connectors: Connector[]) {
      const c = createTestConnecta({
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
        destructive: byName.call_destructive_tool.description as string,
        execute: byName.execute_code.description as string,
        usage: usage.result.content[0].text as string,
      };
    }

    const plain = await skillsSurface([calc()]);
    expect(plain.description).not.toContain("connector:<connectorId>");
    expect(plain.usage).toContain("## Per-connector guides");
    expect(plain.search).not.toContain("`guide`");
    expect(plain.destructive).not.toContain("connector guide");
    expect(plain.execute).not.toContain("guideRequired");

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
    expect(guided.description).toContain("fetch only an exact name");
    expect(guided.usage).toContain("## Per-connector guides");
    expect(guided.search).toContain("`guideSummary`");
    expect(guided.search).toContain("`guideRequiredReasons`");
    expect(guided.search).toContain("`guideRequired: true`");
    expect(guided.destructive).toContain("fetch any connector guide");
    expect(guided.execute).toContain("guideRequired: true = stop");
    expect(guided.execute).toContain("Describe clears only schema_truncated");
    expect(guided.execute).toContain("return its exact guide");
    expect(guided.execute).toContain("fetch with top-level skills");
    expect(guided.execute).toContain("write the informed call");
    expect(guided.execute.length).toBeLessThan(4_400);
    expect(guided.usage).toBe(plain.usage);
  });

  it("tools/call search_tools returns its grouped discovery envelope", async () => {
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
    expect(payload).toEqual({
      connectors: [
        {
          id: "calc",
          tools: [
            {
              name: "add",
              address: "calc.add",
              description: "Add two numbers",
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      total: 1,
      offset: 0,
      limit: 8,
      hasMore: false,
    });
    expect(body.result.structuredContent).toEqual(payload);
    expect(body.result.content[0].text).toBe(
      JSON.stringify(body.result.structuredContent),
    );
    expect(required(payload.connectors[0]).id).toBe("calc");
    expect(required(payload.connectors[0]).tools.map((t) => t.address)).toEqual([
      "calc.add",
    ]);
    expect(payload.total).toBe(1);
  });

  it("search_tools ignores the private flag and includes keys with schemas", async () => {
    // The undeclared flag is still dropped at the MCP boundary. Key metadata
    // follows includeSchemas rather than a private client control.
    const c = makeConnecta();
    const res = await rpc(
      c,
      "tools/call",
      {
        name: "search_tools",
        arguments: {
          query: "add",
          includeSchemas: "compact",
          includeSchemaKeys: true,
        },
      },
      { token: TOKEN },
    );
    const body = await readBody(res);
    expect(body.result.isError).toBeFalsy();
    const tool = body.result.structuredContent.connectors[0].tools[0];
    expect(tool.inputSchema).toBe("{ a: number, b: number }");
    expect(tool.inputKeys).toEqual(["a", "b"]);
    expect(tool.requiredInputKeys).toEqual(["a", "b"]);
    expect(tool).not.toHaveProperty("outputKeys");
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
    const c = createTestConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN, { subjectId: "cli-zack" }),
      storage: memoryStorage(),
      publicUrl: BASE,
      activity: { store: activity, deploymentId: "test" },
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
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 1, b: 2 } },
      },
      { token: TOKEN },
    );
    await rpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 3, b: 4 } },
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
    expect(events.every((event) => event.source === "call_tool")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("never-store-this");
  });

  it("stores the admitting activity identity namespace with the stable actor id", async () => {
    const events: ToolCallActivityEvent[] = [];
    const auth: InboundAuth = {
      kind: "oidc",
      activityActorNamespace: "https://identity.example",
      authorize(request) {
        return request.headers.get("authorization") === `Bearer ${TOKEN}`
          ? { ok: true, userId: "local-user-1" }
          : {
              ok: false,
              response: Response.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            };
      },
    };
    const c = createTestConnecta({
      connectors: [calc()],
      auth,
      storage: memoryStorage(),
      publicUrl: BASE,
      activity: {
        store: {
          record(event) {
            events.push(event);
          },
        },
      },
    });

    await rpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 1, b: 2 } },
      },
      { token: TOKEN },
    );

    expect(required(events[0]).actor).toEqual({
      kind: "oidc",
      id: "local-user-1",
      namespace: "https://identity.example",
    });
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
    const c = createTestConnecta({
      connectors: [failing],
      auth: bearerToken(TOKEN),
      activity: {
        store: {
          record(event) {
            events.push(event);
          },
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
    const c = createTestConnecta({
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
    expect((payload as any).recovery).toBe("oauth");
    expect(payload.status).toBe("auth_required");
    expect(payload.authorizationUrl).toContain("auth.example");
  });

  it("gives a bearer-only deployment a safe handoff but keeps mutation Clerk-only", async () => {
    const c = createTestConnecta({
      connectors: [recoverableStaticConnector()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });
    const response = await rpc(
      c,
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "static" } },
      { token: TOKEN },
    );
    const body = await readBody(response);
    const recovery = JSON.parse(body.result.content[0].text);
    expect(recovery).toMatchObject({
      connector: "static",
      recovery: "operator_config",
      operatorUrl: `${BASE}/credentials`,
    });
    expect(recovery.instructions).toContain("Clerk-authenticated operator");

    const mutation = await c.fetch(
      new Request(`${BASE}/ui/credentials/static`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: { account: "operator@example.com", apiKey: "secret" },
        }),
      }),
    );
    expect(mutation.status).toBe(403);
    expect(await mutation.json()).toEqual({
      error: "credential management requires Clerk authentication",
    });
  });

  it("recovers a bearer agent after a Clerk operator update without redeploy", async () => {
    const c = createTestConnecta({
      connectors: [recoverableStaticConnector()],
      auth: [bearerToken(TOKEN), fakeClerkOperator()],
      storage: memoryStorage(),
      publicUrl: BASE,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });

    const failed = await readBody(
      await rpc(
        c,
        "tools/call",
        {
          name: "call_tool",
          arguments: {
            address: "static.whoami",
            resultMode: "value",
          },
        },
        { token: TOKEN },
      ),
    );
    expect(failed.result.isError).toBe(true);
    const failure = JSON.parse(failed.result.content[0].text);
    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        connector: "static",
        operation: "static.whoami",
        recovery: "operator_config",
        nextAction: {
          tool: "authorize_connector",
          arguments: { connector: "static" },
        },
      },
    });

    const handoff = await readBody(
      await rpc(
        c,
        "tools/call",
        {
          name: "authorize_connector",
          arguments: { connector: "static" },
        },
        { token: TOKEN },
      ),
    );
    const handoffPayload = JSON.parse(handoff.result.content[0].text);
    expect(handoffPayload).toMatchObject({
      recovery: "operator_config",
      operatorUrl: `${BASE}/credentials`,
      credential: {
        label: "Service credentials",
        fields: [
          {
            name: "account",
            guidance: "The service account identifier.",
          },
          {
            name: "apiKey",
            guidance: "The API key issued for that account.",
          },
        ],
      },
    });

    const secret = "operator-secret-never-returned";
    const saved = await c.fetch(
      new Request(`${BASE}/ui/credentials/static`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer operator-token",
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: { account: "service-account", apiKey: secret },
        }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(secret);

    const retried = await readBody(
      await rpc(
        c,
        "tools/call",
        {
          name: "call_tool",
          arguments: {
            address: "static.whoami",
            resultMode: "value",
          },
        },
        { token: TOKEN },
      ),
    );
    expect(retried.result.isError).toBeFalsy();
    expect(JSON.parse(retried.result.content[0].text)).toMatchObject({
      ok: true,
      data: { account: "service-account" },
    });
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
    const c = createTestConnecta({
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

  it("tools/call get_result rejects an offset outside its domain", async () => {
    // The wire half of issue #38: the registered schema and the handler now
    // spell one rule (MIN_RESULT_OFFSET), so a negative or fractional offset is
    // refused here as well as in process. The schema already carried
    // `nonnegative().int()`, so this pins pre-existing wire behavior in place
    // rather than changing it.
    const c = createTestConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    for (const offset of [-1, 1.5]) {
      const res = await rpc(
        c,
        "tools/call",
        { name: "get_result", arguments: { id: "any", offset } },
        { token: TOKEN },
      );
      const body = await readBody(res);
      expect(body.result.isError, `offset ${offset}`).toBe(true);
      expect(body.result.content[0].text).toContain("offset");
    }
  });

  it("honors the deployment-wide maxResultBytes end to end", async () => {
    // `ConnectaConfig.calls.maxResultBytes` is the only place a deployment sets
    // the cap — `createMetaTools` takes no override (issue #44) — so this pins
    // that the configured value reaches call_tool through serve() and stashes a
    // pageable result.
    const c = createTestConnecta({
      connectors: [
        api("blob", {
          description: "Blobs",
          tools: [
            {
              name: "big",
              description: "Return a large blob",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object" },
              handler: () => "x".repeat(500),
            },
          ],
        }),
      ],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      calls: { maxResultBytes: 100 },
    });
    const res = await rpc(
      c,
      "tools/call",
      { name: "call_tool", arguments: { address: "blob.big" } },
      { token: TOKEN },
    );
    const body = await readBody(res);
    const lines = (body.result.content[0].text as string).split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as {
      truncated: boolean;
      resultId: string;
      totalBytes: number;
    };
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(502);
    expect(lines.slice(0, -1).join("\n")).toHaveLength(100);

    const paged = await rpc(
      c,
      "tools/call",
      {
        name: "get_result",
        arguments: { id: notice.resultId, maxBytes: 1_000 },
      },
      { token: TOKEN },
    );
    const page = JSON.parse(
      (await readBody(paged)).result.content[0].text,
    ) as { text: string };
    expect(JSON.parse(page.text)).toBe("x".repeat(500));
  });

  it("forwards calls.defaultTimeoutMs into connector call context", async () => {
    const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = [];
    const c = createTestConnecta({
      connectors: [
        api("budget", {
          description: "Budget",
          tools: [
            {
              name: "read",
              description: "Read the call budget",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object" },
              handler: (_args, ctx) => {
                seen.push({
                  ...(ctx.timeoutMs !== undefined
                    ? { timeoutMs: ctx.timeoutMs }
                    : {}),
                  hasSignal: Boolean(ctx.signal),
                });
                return { ok: true };
              },
            },
          ],
        }),
      ],
      auth: bearerToken(TOKEN),
      publicUrl: BASE,
      calls: { defaultTimeoutMs: 1_234 },
    });

    await rpc(
      c,
      "tools/call",
      { name: "call_tool", arguments: { address: "budget.read" } },
      { token: TOKEN },
    );

    expect(seen).toEqual([{ timeoutMs: 1_234, hasSignal: true }]);
  });

  it("forwards discovery.probeTimeoutMs to the discovery fan-out", async () => {
    const hanging: Connector = {
      id: "hang",
      kind: "mcp",
      description: "Never resolves",
      listTools() {
        return new Promise<never>(() => {});
      },
      async callTool() {
        return null;
      },
    };
    const c = createTestConnecta({
      connectors: [hanging, calc()],
      auth: bearerToken(TOKEN),
      publicUrl: BASE,
      discovery: { probeTimeoutMs: 10 },
    });
    const started = Date.now();

    const response = await rpc(
      c,
      "tools/call",
      {
        name: "search_tools",
        arguments: { query: "add impossible" },
      },
      { token: TOKEN },
    );
    const body = await readBody(response);
    const payload = JSON.parse(body.result.content[0].text) as {
      connectors: Array<{ id: string }>;
      queryAnalysis?: { unavailableConnectorCount?: number };
    };

    // The deadline is honored end to end: the search returns on the healthy
    // catalog rather than waiting on the one that never answers, and reports
    // the connector it could not reach.
    expect(Date.now() - started).toBeLessThan(2_000);
    const ids = payload.connectors.map((connector) => connector.id);
    expect(ids).toContain("calc");
    expect(ids).not.toContain("hang");
    expect(payload.queryAnalysis).toMatchObject({
      unavailableConnectorCount: 1,
    });
  });

  it("forwards discovery.concurrency to catalog fan-out", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from(
      { length: 6 },
      (_, index): Connector => ({
        id: `bounded_${index}`,
        kind: "mcp",
        description: `Bounded ${index}`,
        async listTools() {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return [{ name: `read_${index}`, description: "Read bounded data" }];
        },
        async callTool() {
          return null;
        },
      }),
    );
    const c = createTestConnecta({
      connectors,
      auth: bearerToken(TOKEN),
      publicUrl: BASE,
      discovery: { concurrency: 2 },
    });

    await rpc(
      c,
      "tools/call",
      {
        name: "search_tools",
        arguments: { query: "bounded" },
      },
      { token: TOKEN },
    );

    expect(maxActive).toBe(2);
  });
});

describe("server open routes", () => {
  it("redirects HTTP to the configured HTTPS public URL", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request("http://connecta.test/ui?probe=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://connecta.test/?probe=1",
    );
  });

  it("keeps authority-shaped upgrade paths on the configured origin", async () => {
    const c = makeConnecta();
    for (const unsafe of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example/x",
      "/\r/evil.example/x",
      "/\n/evil.example/x",
    ]) {
      const res = await c.fetch(
        new Request(`http://connecta.test${unsafe}?next=%2Fcredentials`),
      );
      const location = new URL(res.headers.get("location")!);
      expect(res.status).toBe(308);
      expect(location.origin).toBe(BASE);
      expect(location.search).toBe("?next=%2Fcredentials");
    }
  });

  it("preserves ordinary operator and private-API paths while upgrading", async () => {
    const c = makeConnecta();
    for (const path of [
      "/credentials?from=http",
      "/ui/data?include=connectors",
    ]) {
      const res = await c.fetch(new Request(`http://connecta.test${path}`));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${BASE}${path}`);
    }
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
    const c = createTestConnecta({
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
    const c = createTestConnecta({
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
    const c = createTestConnecta({
      connectors: [greedy],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const health = await c.fetch(new Request(`${BASE}/health`));
    expect(await health.text()).toContain('"status":"ok"');
    const mcp = await c.fetch(new Request(`${BASE}/mcp`, { method: "POST" }));
    expect(mcp.status).toBe(401);
    for (const path of ["/", "/credentials", "/tokens", "/activity"]) {
      const shell = await c.fetch(new Request(`${BASE}${path}`));
      expect(shell.status).toBe(200);
      expect(await shell.text()).not.toBe("hijacked");
      const write = await c.fetch(
        new Request(`${BASE}${path}`, { method: "POST" }),
      );
      expect(write.status).toBe(405);
    }
  });

  it("a throwing connector route is a 500, not a 404", async () => {
    const c = createTestConnecta({
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
    const c = createTestConnecta({ connectors: [calc()] });
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
    for (const path of ["/", "/credentials", "/tokens", "/activity"]) {
      const ui = await c.fetch(new Request(`${BASE}${path}`));
      const csp = ui.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("script-src 'nonce-");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(ui.headers.get("X-Frame-Options")).toBe("DENY");
    }

    const legacy = await c.fetch(new Request(`${BASE}/ui`));
    expect(legacy.status).toBe(308);
    expect(legacy.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(legacy.headers.get("X-Frame-Options")).toBe("DENY");

    const health = await c.fetch(new Request(`${BASE}/health`));
    expect(health.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("/health exposes additive server and deployment version metadata", async () => {
    const c = createTestConnecta({
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
    return createTestConnecta({
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
    expect(body.result.tools).toHaveLength(7);
  });
});

describe("execute_code registration (code mode)", () => {
  it("advertises and runs execute_code on the seven-tool surface", async () => {
    let executions = 0;
    const withExec = createTestConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: {
        execute: async () => {
          executions++;
          return { result: { executor: "live" } };
        },
      },
    });
    const res2 = await rpc(withExec, "tools/list", {}, { token: TOKEN });
    const listed2 = (await readBody(res2)).result.tools;
    const names2 = listed2.map(
      (t: { name: string }) => t.name,
    );
    expect(names2.sort()).toEqual([
      "authorize_connector",
      "call_destructive_tool",
      "call_tool",
      "execute_code",
      "get_result",
      "search_tools",
      "skills",
    ]);

    const executeTool = listed2.find(
      (tool: { name: string }) => tool.name === "execute_code",
    );
    expect(executeTool.description).toContain(
      "Choose the route before discovery",
    );
    expect(executeTool.description).toContain(
      "primary surface for everything wider",
    );
    expect(executeTool.description).toContain("make exactly one execute_code call");
    // Advice, not a validity claim: nothing rejects a program that returns
    // catalog matches, and a description that says otherwise teaches the model
    // a rule the server does not enforce (#295).
    expect(executeTool.description).toContain(
      "A discovery-only program wastes its round trip: finish here, don't return catalog matches for a later call",
    );
    expect(executeTool.description).not.toContain("Never make a discovery-only");
    expect(executeTool.description).toContain(
      "Exactly one unknown-address read uses top-level search_tools then call_tool",
    );
    expect(executeTool.description).toContain(
      "For distinct operations, make separate short searches here",
    );
    expect(executeTool.description).toContain(
      "must be followed by selection and calls in this program",
    );
    expect(executeTool.inputSchema.properties.code.description).toContain(
      "Consume search/describe results and finish the task inside it",
    );
    expect(executeTool.inputSchema.properties.code.description).toContain(
      "returning catalog data for a later call spends a round trip",
    );
    expect(executeTool.inputSchema.properties.code.description).not.toContain(
      "is invalid",
    );
    // Measured habit, not a style note: every `dependent-read` route failure in
    // the #295 lane was a program that gave up — a regex tool pick that missed,
    // a guessed connector id that emptied the catalog, a `||` chain over result
    // roots that found nothing — and then threw or returned an error object so a
    // second program could redo the work. The recovery program was always the
    // direct one, using information the first program already had in scope. The
    // clause lives on the `code` parameter because that is the field the model
    // is writing when it decides to bail, and repeating it across surfaces is
    // exactly what #295 forbids without evidence that the repetition pays.
    expect(executeTool.inputSchema.properties.code.description).toContain(
      "So does aborting on a missing tool match or result key",
    );
    // The reason batch exists for a caller: a thrown error is a bare message,
    // so a program that must tell a refusal from a transient failure needs the
    // typed entry. Compressing the clause to "use batch" loses the why (#295).
    expect(executeTool.description).toContain(
      "A thrown error is only a message; connecta.batch tells a policy refusal",
    );
    // The eval's builds fixture must not leak into shipped text: no fixture
    // field names in the guidance prose (the dependent example is its own
    // illustration and keeps its names).
    expect(executeTool.description).not.toContain("failedJobId supplies jobId");
    expect(executeTool.description).toContain('includeSchemas: "compact"');
    expect(executeTool.description).toContain('safety: "readOnly"');
    expect(executeTool.description).toContain(
      "avoid advertising calls this sandbox cannot execute",
    );
    expect(executeTool.description).toContain("requiredInputKeys");
    expect(executeTool.description).toContain(
      "never take the first lexical or merely input-compatible match",
    );
    expect(executeTool.description).toContain(
      "Reducers use declared outputKeys, never guessed items/results roots",
    );
    expect(executeTool.description).toContain(
      "[] means no required keys, not permission to invent args",
    );
    expect(executeTool.description).toContain(
      "Describe only a truncated/insufficient compact shape",
    );
    expect(executeTool.description).toContain(
      "match an earlier outputKey to the later requiredInputKey",
    );
    expect(executeTool.description).toContain(
      "Put every requiredInputKey in call args",
    );
    expect(executeTool.description).toContain(
      "do not prefer zero required keys",
    );
    expect(executeTool.description).toContain(
      "Missing outputKeys means inspect outputSchema",
    );
    expect(executeTool.description).toContain(
      "do not require it to be the only match",
    );
    // The call form itself, not just the address: a bullet that says an
    // address is "callable" without showing the parentheses teaches nothing,
    // and the sanitization rule two clauses later makes "as written" false.
    expect(executeTool.description).toContain(
      "<connectorId>.<toolName>(args)",
    );
    // The batch entry envelope rides the capabilities bullet rather than the
    // prose three paragraphs down. Guessing `{ result }` fails silently through
    // optional chaining — a run that succeeds and delivers nothing — so the
    // shape belongs in the line an author actually reads (#282).
    expect(executeTool.description).toContain(
      "Every batch entry is { address, ok: true, data }",
    );
    expect(executeTool.description).toContain(
      "top-level search_tools returns { connectors: [{ id, tools }], total, offset, limit, hasMore }",
    );
    expect(executeTool.description).toContain(
      "connecta.search returns { tools, total, offset, limit, hasMore }",
    );
    expect(executeTool.description).toContain(
      "connecta.describe returns { tools }",
    );
    // Hosts truncate long descriptions, so the bullets are a fixed budget:
    // #282 moved weight forward instead of adding it, and this ceiling is what
    // keeps the next clause paying for itself the same way.
    expect(executeTool.description.length).toBeLessThan(4_400);
    expect(executeTool.description).toContain(
      "write the property names they display",
    );
    expect(executeTool.description).toContain(
      "the second call requires a value returned by the first",
    );
    // The dependent example names its fields. Positional indexing into the key
    // lists is the pattern this description must never teach: the first
    // required key of a multi-argument tool is not the one the value belongs to.
    expect(executeTool.description).toContain("{ jobId: run.failedJobId }");
    expect(executeTool.description).not.toContain("requiredInputKeys[0]");
    // The classic three-step funnel (search_tools → describe_tools → …) is
    // gone with the tool that anchored it; naming it here would teach a route
    // no deployment serves. Guard the tool name itself, not the sentence.
    expect(executeTool.description).not.toContain("describe_tools");
    expect(executeTool.description).not.toContain("list_connectors");
    expect(executeTool.description).not.toContain("batch_call");

    const executed = await rpc(
      withExec,
      "tools/call",
      {
        name: "execute_code",
        arguments: { code: "async () => null" },
      },
      { token: TOKEN },
    );
    const executedBody = await readBody(executed);
    expect(executedBody.result.isError).toBeFalsy();
    expect(executedBody.result.structuredContent).toMatchObject({
      result: { executor: "live" },
    });
    expect(executions).toBe(1);
  });

  it.skipIf(WORKERD)("runs code against connectors end to end", async () => {
    const { quickJsExecutor } = await loadQuickJsExecutor();
    const events: ToolCallActivityEvent[] = [];
    const c = createTestConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: quickJsExecutor(),
      activity: {
        store: {
          record(event) {
            events.push(event);
          },
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
    await c.close();
  });

  it.skipIf(WORKERD)("discovers and calls an API tool inside one execute_code request", async () => {
    const { quickJsExecutor } = await loadQuickJsExecutor();
    const c = createTestConnecta({
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
    await c.close();
  });

  it.skipIf(WORKERD)(
    "keeps health and ordinary calls responsive while guests run away",
    async () => {
      const { quickJsExecutor } = await loadQuickJsExecutor();
      const executor = quickJsExecutor({
        concurrency: 4,
        maxQueueSize: 8,
        cpuTimeMs: 200,
        timeoutMs: 2_000,
      });
      const c = createTestConnecta({
        connectors: [calc()],
        auth: bearerToken(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
        executor,
      });
      const probeStart = performance.now();
      const healthProbes = Array.from(
        { length: 20 },
        (_, index) =>
          new Promise<number>((resolve) => {
            const due = probeStart + index * 10;
            setTimeout(() => {
              void c.fetch(new Request(`${BASE}/health`)).then((response) => {
                expect(response.status).toBe(200);
                resolve(performance.now() - due);
              });
            }, index * 10);
          }),
      );
      const ordinaryCall = new Promise<number>((resolve) => {
        const due = probeStart + 50;
        setTimeout(() => {
          void rpc(
            c,
            "tools/call",
            {
              name: "call_tool",
              arguments: {
                address: "calc.add",
                args: { a: 4, b: 6 },
              },
            },
            { token: TOKEN },
          ).then(async (response) => {
            const body = await readBody(response);
            expect(JSON.parse(body.result.content[0].text)).toEqual({
              sum: 10,
            });
            resolve(performance.now() - due);
          });
        }, 50);
      });
      const runaways = Array.from({ length: 4 }, () =>
        executor.execute(`async () => { while (true) {} }`, []),
      );
      const latencies = await Promise.all(healthProbes);
      const callLatency = await ordinaryCall;
      const outcomes = await Promise.all(runaways);
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
      const p99 = latencies[latencies.length - 1];
      expect(p95).toBeLessThan(150);
      expect(p99).toBeLessThan(150);
      expect(callLatency).toBeLessThan(150);
      expect(
        outcomes.every((outcome) =>
          outcome.error?.includes("guest CPU budget"),
        ),
      ).toBe(true);
      await c.close();
    },
    10_000,
  );
});
