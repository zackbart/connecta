import { createTestConnecta, required } from "./helpers.js";
import {
  calcApi,
  fakeClerkAuth,
  makeDeployment,
  mcpRpc,
  readJsonRpc,
} from "./fixtures/http.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_INVENTORY_MAX_BYTES } from "../src/execute.js";
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
import type { Connector, Executor, InboundAuth } from "../src/types.js";

const TOKEN = "test-token-123";
const BASE = "https://connecta.test";
const CREDENTIAL_KEY = "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=";

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

describe("server /mcp end-to-end", () => {
  it("401s without a token and includes WWW-Authenticate", async () => {
    const c = makeDeployment();
    const res = await mcpRpc(c, "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("serves CORS on /mcp errors so browsers can read the 401", async () => {
    const c = makeDeployment();
    const res = await mcpRpc(c, "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain(
      "WWW-Authenticate",
    );
  });

  it("serves CORS on successful legacy /mcp responses too", async () => {
    const c = makeDeployment();
    const res = await mcpRpc(
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
    const c = makeDeployment();
    const res = await mcpRpc(
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
    const body = await readJsonRpc(res);
    expect(body.result.serverInfo.name).toBe("connecta");
    expect(body.result.instructions).toContain(
      "Unknown-address read-only work starts with one execute_code program",
    );
    expect(body.result.instructions).toContain('skills({ name: "usage" })');
    expect(body.result.instructions).toContain(
      "Guidance is on demand",
    );
    expect(body.result.instructions).toContain(
      "starts with one execute_code program",
    );
    expect(body.result.instructions).toContain(
      "discovers, calls, and returns the answer",
    );
    expect(body.result.instructions).toContain(
      "connecta.ui(html) exists only inside execute_code",
    );
    expect(body.result.instructions).toContain(
      "not in connector search",
    );
    expect(body.result.instructions).toContain(
      "return the same summary data the HTML renders",
    );
    expect(body.result.instructions).toContain("only when");
  });

  it("legacy initialize passes through title, websiteUrl, and icons (MCP icons spec)", async () => {
    const c = createTestConnecta({
      connectors: [calcApi()],
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
    const res = await mcpRpc(
      c,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      { token: TOKEN },
    );
    const body = await readJsonRpc(res);
    expect(body.result.serverInfo.name).toBe("acme-tools");
    expect(body.result.serverInfo.title).toBe("Acme Tools");
    expect(body.result.serverInfo.websiteUrl).toBe("https://acme.example");
    expect(body.result.serverInfo.icons).toEqual([
      { src: `${BASE}/favicon.svg`, mimeType: "image/svg+xml" },
    ]);
  });

  it("serves a modern client without initialize and emits private tools/list cache hints", async () => {
    const c = makeDeployment();
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
    const c = makeDeployment();
    const res = await mcpRpc(c, "tools/list", {}, { token: TOKEN });
    const body = await readJsonRpc(res);
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
  });

  it("declares the Apps template only on execute_code", async () => {
    const body = await readJsonRpc(
      await mcpRpc(makeDeployment(), "tools/list", {}, { token: TOKEN }),
    );
    const tools = body.result.tools as Array<{
      name: string;
      description: string;
      _meta?: unknown;
    }>;
    const execute = required(
      tools.find((tool) => tool.name === "execute_code"),
    );
    expect(execute._meta).toEqual({
      ui: {
        resourceUri: PROGRAM_UI_RESOURCE_URI,
        visibility: ["model"],
      },
    });
    expect(execute.description).toContain("connecta.ui(html)");
    expect(execute.description).toContain("display-only");
    expect(execute.description).not.toContain("connecta.ui(html, options?)");

    for (const tool of tools) {
      if (tool.name === "execute_code") continue;
      expect(tool._meta, tool.name).toEqual({
        ui: { visibility: ["model"] },
      });
    }
  });

  it("declares exactly one extension, the MCP Apps one (U11)", async () => {
    const c = makeDeployment();
    const body = await readJsonRpc(
      await mcpRpc(
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

  it("serves exactly the shell URI and lists nothing (U5)", async () => {
    const c = makeDeployment();
    const read = await readJsonRpc(
      await mcpRpc(
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
      "ui://connecta/program-ui/v2",
      "ui://connecta/program-ui/v1",
      "ui://connecta/program-ui",
      "ui://elsewhere/view",
      "https://connecta.test/mcp",
      "file:///etc/passwd",
    ]) {
      const missing = await readJsonRpc(
        await mcpRpc(c, "resources/read", { uri }, { token: TOKEN }),
      );
      expect(missing.result, uri).toBeUndefined();
      expect(missing.error, uri).toBeDefined();
    }

    // The method answers — the capability stays honest — and carries nothing.
    const listed = await readJsonRpc(
      await mcpRpc(c, "resources/list", {}, { token: TOKEN }),
    );
    expect(listed.result.resources).toEqual([]);

    // The sibling listing has to survive the `resources/list` override: the
    // resources capability covers both methods, and a client that probes for
    // templates must get an empty list rather than "method not found".
    const templates = await readJsonRpc(
      await mcpRpc(c, "resources/templates/list", {}, { token: TOKEN }),
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
      connectors: [calcApi()],
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
    const body = await readJsonRpc(
      await mcpRpc(
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
    const c = makeDeployment();
    for (const reason of ["", "   "]) {
      const res = await mcpRpc(
        c,
        "tools/call",
        {
          name: "call_destructive_tool",
          arguments: { address: "calc.add", args: { a: 1, b: 2 }, reason },
        },
        { token: TOKEN },
      );
      const body = await readJsonRpc(res);
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
    const c = makeDeployment();
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
    const c = makeDeployment();
    const listed = await mcpRpc(
      c,
      "tools/call",
      { name: "skills", arguments: {} },
      { token: TOKEN },
    );
    const listedBody = await readJsonRpc(listed);
    expect(listedBody.result.isError).toBeFalsy();
    expect(listedBody.result.content[0].text).toContain(
      "`usage` — How to route work between one execute_code program",
    );

    const fetched = await mcpRpc(
      c,
      "tools/call",
      { name: "skills", arguments: { name: "usage" } },
      { token: TOKEN },
    );
    const fetchedBody = await readJsonRpc(fetched);
    const skill = fetchedBody.result.content[0].text as string;
    expect(skill).toContain("# Connecta usage");
    expect(skill).toContain("always-loaded MCP instructions are authoritative");
    expect(skill).toContain("## Discover and select");
    expect(skill).toContain("## Errors and repair");
    expect(skill).toContain(
      "Only tools explicitly annotated `readOnlyHint: true` are reachable",
    );
    expect(skill).toContain("Dynamic Workers must use only `{ loader }`");
    expect(skill).toContain("node:fs/http/https are absent");
    expect(skill).toContain("outbound fetch, WebSocket, node:net, and node:tls are denied");
    expect(skill).toContain("Runtime builtins remain through `import()`");
    expect(skill).toContain("this set can drift");
    expect(skill).toContain("2–4 distinctive action/object terms");
    // #418: top-level search defaults, paging, compact row semantics, and
    // non-ASCII behavior moved here from the always-loaded definition.
    expect(skill).toContain("omit `limit` initially (the default is 10)");
    expect(skill).toContain("page with a limit up to 50");
    expect(skill).toContain(
      "Plain objects expose `inputKeys`, `requiredInputKeys`, and `outputKeys`",
    );
    expect(skill).toContain("non-empty query with no ASCII terms returns no matches");
    expect(skill).toContain("mixed input searches with its ASCII terms");
    expect(skill).toContain(
      '`format: "json"` only for exact constraints',
    );
    // #418: direct-call shaping, bounded execution, retry safety, diagnostics,
    // and byte-exact paging all remain model-visible.
    expect(skill).toContain('`resultMode: "value"` unwraps the result');
    expect(skill).toContain("`timeoutMs` sets its deadline");
    expect(skill).toContain(
      "`maxRetries` is honored only for safely annotated tools",
    );
    expect(skill).toContain("`diagnostics: true` adds timing");
    expect(skill).toContain(
      "`get_result({ id, offset?, maxBytes? })` returns `{ text, offset, nextOffset?, totalBytes }`",
    );
    expect(skill).toContain("`maxBytes` must be a whole number at least 1");
    expect(skill).toContain("`offset` must be a whole number at least 0");
    expect(skill).toContain(
      "offset inside a multi-byte character moves back to its first byte",
    );
    expect(skill).toContain("unknown or expired id is an error");
    // #484: program views are local snapshots again. No app-to-host call
    // grammar is taught, while rendering still shares the rich-output budget.
    expect(skill).toContain("no network, connector calls, discovery");
    expect(skill).not.toContain("connecta.read");
    expect(skill).not.toContain("fixedArgs");
    expect(skill).toContain(
      "One shared budget applies to the UI and emitted content, not separate budgets",
    );
    expect(skill).toContain("## Examples");
    expect(skill).toContain("crm.get_account");

    const missing = await mcpRpc(
      c,
      "tools/call",
      { name: "skills", arguments: { name: "missing" } },
      { token: TOKEN },
    );
    const missingBody = await readJsonRpc(missing);
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
      const listed = await readJsonRpc(
        await mcpRpc(c, "tools/list", {}, { token: TOKEN }),
      );
      const usage = await readJsonRpc(
        await mcpRpc(
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

    const plain = await skillsSurface([calcApi()]);
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
    expect(guided.description).toContain("connector guides by exact name");
    expect(guided.usage).toContain("## Per-connector guides");
    expect(guided.search).toContain("guideRequired: true");
    expect(guided.destructive).toContain("exact connector guide");
    expect(guided.execute).toContain("guide handling");
    // The deployment inventory may spend at most 256 bytes inside #418's
    // always-loaded execute definition; this cap must not drift around it.
    expect(guided.execute.length).toBeLessThan(1_800);
    expect(guided.usage).toBe(plain.usage);
  });

  it("shows a bounded, deterministic live connector inventory without loading a catalog", async () => {
    const listTools = vi.fn(async () => {
      throw new Error("inventory must not load a catalog");
    });
    const callTool = vi.fn(async () => {
      throw new Error("inventory must not call a connector");
    });
    const connector = (id: string): Connector => ({
      id,
      description: id,
      listTools,
      callTool,
    });
    async function executeDescription(ids: string[]) {
      const c = createTestConnecta({
        connectors: ids.map(connector),
        auth: bearerToken(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const listed = await readJsonRpc(
        await mcpRpc(c, "tools/list", {}, { token: TOKEN }),
      );
      const execute = listed.result.tools.find(
        (tool: { name: string }) => tool.name === "execute_code",
      ) as { description: string };
      await c.close();
      return execute.description;
    }
    async function inventory(ids: string[]) {
      return (await executeDescription(ids)).match(/^Connectors: .*$/m)?.[0];
    }

    expect(await inventory([])).toBe("Connectors: none.");
    expect(await inventory(["calc", "my-service", "email_api"])).toBe(
      "Connectors: calc, my-service (shortcut my_service), email_api.",
    );
    const ids = Array.from(
      { length: 104 },
      (_, index) =>
        `connector-${String(index).padStart(3, "0")}-xxxxxxxx`,
    );
    ids[2] = `${ids[2]}y`;
    const first = await inventory(ids);
    const second = await inventory(ids);
    expect(first).toBe(second);
    expect(first).toMatch(/; \+100 more\.$/);
    expect(new TextEncoder().encode(first).length).toBe(
      CONNECTOR_INVENTORY_MAX_BYTES,
    );
    expect((await executeDescription(ids)).length).toBeLessThan(1_800);
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("tools/call search_tools returns its grouped discovery envelope", async () => {
    const c = makeDeployment();
    const res = await mcpRpc(
      c,
      "tools/call",
      { name: "search_tools", arguments: { query: "add" } },
      { token: TOKEN },
    );
    const body = await readJsonRpc(res);
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

  it.each(["search_tools", "execute_code"] as const)(
    "threads waitUntil to stale catalog reads through %s",
    async (surface) => {
      vi.useFakeTimers();
      try {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        const connector: Connector = {
          id: "deferred_catalog",
          kind: "mcp",
          description: "Deferred catalog test",
          async listTools() {
            const call = ++calls;
            if (call > 1) await gate;
            return [
              {
                name: call === 1 ? "old_read" : "new_read",
                description: "Read the deferred fixture",
                annotations: { readOnlyHint: true },
              },
            ];
          },
          async callTool() {
            return null;
          },
        };
        const executor: Executor = {
          async execute(_code, providers) {
            const provider = providers.find((item) => item.name === "connecta");
            const search = provider?.fns.search;
            if (!search) throw new Error("connecta.search provider missing");
            return { result: await search({ query: "read" }) };
          },
        };
        const c = createTestConnecta({
          connectors: [connector],
          auth: bearerToken(TOKEN),
          storage: memoryStorage(),
          publicUrl: BASE,
          discovery: {
            catalogTtlSeconds: 1,
            staleCatalogSeconds: 30,
          },
          executor,
        });
        await c.registry.getTools("deferred_catalog", BASE, {});
        vi.advanceTimersByTime(2_000);
        const tails: Promise<unknown>[] = [];
        let settled = false;
        const response = mcpRpc(
          c,
          "tools/call",
          {
            name: surface,
            arguments:
              surface === "search_tools"
                ? { query: "read" }
                : { code: "async () => null" },
          },
          {
            token: TOKEN,
            runtimeContext: {
              waitUntil(promise) {
                tails.push(promise);
              },
            },
          },
        ).finally(() => {
          settled = true;
        });

        await vi.waitFor(() => expect(calls).toBe(2));
        await vi.waitFor(() => expect(settled).toBe(true));
        expect((await response).status).toBe(200);
        expect(tails).toHaveLength(1);
        release();
        await Promise.all(tails);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("search_tools ignores the private flag and includes keys with schemas", async () => {
    // The undeclared flag is still dropped at the MCP boundary. Key metadata
    // follows includeSchemas rather than a private client control.
    const c = makeDeployment();
    const res = await mcpRpc(
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
    const body = await readJsonRpc(res);
    expect(body.result.isError).toBeFalsy();
    const tool = body.result.structuredContent.connectors[0].tools[0];
    expect(tool.inputSchema).toBe("{ a: number, b: number }");
    expect(tool.inputKeys).toEqual(["a", "b"]);
    expect(tool.requiredInputKeys).toEqual(["a", "b"]);
    expect(tool).not.toHaveProperty("outputKeys");
  });

  it("tools/call call_tool invokes a downstream api tool", async () => {
    const c = makeDeployment();
    const res = await mcpRpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 2, b: 5 } },
      },
      { token: TOKEN },
    );
    const body = await readJsonRpc(res);
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
      connectors: [calcApi()],
      auth: bearerToken(TOKEN, { subjectId: "cli-zack" }),
      storage: memoryStorage(),
      publicUrl: BASE,
      activity: { store: activity, deploymentId: "test" },
    });

    await mcpRpc(
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
    await mcpRpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "calc.add", args: { a: 1, b: 2 } },
      },
      { token: TOKEN },
    );
    await mcpRpc(
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
      connectors: [calcApi()],
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

    await mcpRpc(
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

    await mcpRpc(
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
      connectors: [calcApi(), authConn],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await mcpRpc(
      c,
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "needsauth" } },
      { token: TOKEN },
    );
    const body = await readJsonRpc(res);
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
    const response = await mcpRpc(
      c,
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "static" } },
      { token: TOKEN },
    );
    const body = await readJsonRpc(response);
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
      error: "credential management requires interactive operator authentication",
    });
  });

  it("recovers a bearer agent after a Clerk operator update without redeploy", async () => {
    const c = createTestConnecta({
      connectors: [recoverableStaticConnector()],
      auth: [bearerToken(TOKEN), fakeClerkAuth({ frontendApiUrl: "https://clerk.example.com", token: "operator-token", userId: "operator_1" })],
      storage: memoryStorage(),
      publicUrl: BASE,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });

    const failed = await readJsonRpc(
      await mcpRpc(
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

    const handoff = await readJsonRpc(
      await mcpRpc(
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

    const retried = await readJsonRpc(
      await mcpRpc(
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
      connectors: [calcApi()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await mcpRpc(
      c,
      "tools/call",
      { name: "get_result", arguments: { id: "any", maxBytes: 0 } },
      { token: TOKEN },
    );
    const body = await readJsonRpc(res);
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
      connectors: [calcApi()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    for (const offset of [-1, 1.5]) {
      const res = await mcpRpc(
        c,
        "tools/call",
        { name: "get_result", arguments: { id: "any", offset } },
        { token: TOKEN },
      );
      const body = await readJsonRpc(res);
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
    const res = await mcpRpc(
      c,
      "tools/call",
      { name: "call_tool", arguments: { address: "blob.big" } },
      { token: TOKEN },
    );
    const body = await readJsonRpc(res);
    const lines = (body.result.content[0].text as string).split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as {
      truncated: boolean;
      resultId: string;
      totalBytes: number;
    };
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(502);
    expect(lines.slice(0, -1).join("\n")).toHaveLength(100);

    const paged = await mcpRpc(
      c,
      "tools/call",
      {
        name: "get_result",
        arguments: { id: notice.resultId, maxBytes: 1_000 },
      },
      { token: TOKEN },
    );
    const page = JSON.parse(
      (await readJsonRpc(paged)).result.content[0].text,
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

    await mcpRpc(
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
      connectors: [hanging, calcApi()],
      auth: bearerToken(TOKEN),
      publicUrl: BASE,
      discovery: { probeTimeoutMs: 10 },
    });
    const started = Date.now();

    const response = await mcpRpc(
      c,
      "tools/call",
      {
        name: "search_tools",
        arguments: { query: "add impossible" },
      },
      { token: TOKEN },
    );
    const body = await readJsonRpc(response);
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

    await mcpRpc(
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
    const c = makeDeployment();
    const res = await c.fetch(new Request("http://connecta.test/ui?probe=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://connecta.test/?probe=1",
    );
  });

  it("keeps authority-shaped upgrade paths on the configured origin", async () => {
    const c = makeDeployment();
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
    const c = makeDeployment();
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
      ...calcApi(),
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
      connectors: [{ ...calcApi(), async handleRequest() { return null; } }],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    expect((await c.fetch(new Request(`${BASE}/nope`))).status).toBe(404);
  });

  it("a connector route cannot shadow a built-in route", async () => {
    const greedy: Connector = {
      ...calcApi(),
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
          ...calcApi(),
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
    const c = makeDeployment();
    const res = await c.fetch(new Request("http://127.0.0.1:8787/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("keeps HTTP available when no HTTPS public URL is configured", async () => {
    const c = createTestConnecta({ connectors: [calcApi()] });
    const res = await c.fetch(new Request("http://localhost:8787/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("/health is open (no auth)", async () => {
    const c = makeDeployment();
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
    const c = makeDeployment();
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
      connectors: [calcApi()],
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

  it("/health reports the configured sandbox, sanitized and bounded", async () => {
    class DynamicWorkerExecutor {
      async execute() {
        return { result: null };
      }
    }
    const named = createTestConnecta({
      connectors: [calcApi()],
      executor: new DynamicWorkerExecutor(),
    });
    const namedBody = (await (
      await named.fetch(new Request(`${BASE}/health`))
    ).json()) as any;
    expect(namedBody.executor).toEqual({ name: "DynamicWorkerExecutor" });

    const hostile = createTestConnecta({
      connectors: [calcApi()],
      executor: {
        name: "bad\nname " + "y".repeat(80),
        execute: async () => ({ result: null }),
      },
    });
    const hostileBody = (await (
      await hostile.fetch(new Request(`${BASE}/health`))
    ).json()) as any;
    expect(hostileBody.executor.name).toMatch(/^bad name y+$/);
    expect(hostileBody.executor.name.length).toBeLessThanOrEqual(40);

    // An anonymous object literal identifies nothing, so /health claims
    // nothing and `connecta doctor` names no sandbox (#368).
    const anonymous = createTestConnecta({
      connectors: [calcApi()],
      executor: { execute: async () => ({ result: null }) },
    });
    const anonymousBody = (await (
      await anonymous.fetch(new Request(`${BASE}/health`))
    ).json()) as any;
    expect(anonymousBody).not.toHaveProperty("executor");
  });

  it("OPTIONS returns a CORS preflight 204", async () => {
    const c = makeDeployment();
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
      connectors: [calcApi()],
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
    const res = await mcpRpc(c, "tools/list", {}, { token: TOKEN });
    const body = await readJsonRpc(res);
    expect(body.result.tools).toHaveLength(7);
  });
});

describe("execute_code registration (code mode)", () => {
  it("advertises and runs execute_code on the seven-tool surface", async () => {
    let executions = 0;
    const withExec = createTestConnecta({
      connectors: [calcApi()],
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
    const res2 = await mcpRpc(withExec, "tools/list", {}, { token: TOKEN });
    const listed2 = (await readJsonRpc(res2)).result.tools;
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
      "Unknown-address and wider read-only work",
    );
    expect(executeTool.description).toContain("use exactly one execute_code call");
    // Advice, not a validity claim: nothing rejects a program that returns
    // catalog matches, and a description that says otherwise teaches the model
    // a rule the server does not enforce (#295).
    expect(executeTool.description).toContain(
      "Finish in that program; don't return catalog matches for a later call",
    );
    expect(executeTool.description).not.toContain("Never make a discovery-only");
    expect(executeTool.description).toContain(
      "Unknown-address and wider read-only work use exactly one execute_code call",
    );
    expect(executeTool.description).toContain("No portable ambient capabilities");
    expect(executeTool.description).toContain('skills({ name: "usage" })');
    expect(executeTool.inputSchema.properties.code.description).toContain(
      "discovers, calls, and returns the reduced answer",
    );
    // The call form itself, not just the address: a bullet that says an
    // address is "callable" without showing the parentheses teaches nothing,
    // and the sanitization rule two clauses later makes "as written" false.
    expect(executeTool.description).toContain(
      "<connectorId>.<toolName>(args)",
    );
    // #418 deliberately replaces the former 4.4 KiB ceiling. The detailed
    // selection rules and examples now live only in the on-demand usage skill.
    expect(executeTool.description.length).toBeLessThan(1_800);
    expect(executeTool.description).not.toContain("Dependent example");
    expect(executeTool.description).not.toContain("requiredInputKeys");
    expect(executeTool.description).not.toContain("requiredInputKeys[0]");
    // The classic three-step funnel (search_tools → describe_tools → …) is
    // gone with the tool that anchored it; naming it here would teach a route
    // no deployment serves. Guard the tool name itself, not the sentence.
    expect(executeTool.description).not.toContain("describe_tools");
    expect(executeTool.description).not.toContain("list_connectors");
    expect(executeTool.description).not.toContain("batch_call");

    const executed = await mcpRpc(
      withExec,
      "tools/call",
      {
        name: "execute_code",
        arguments: { code: "async () => null" },
      },
      { token: TOKEN },
    );
    const executedBody = await readJsonRpc(executed);
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
      connectors: [calcApi()],
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
    const res = await mcpRpc(
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
    const body = await readJsonRpc(res);
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
      connectors: [calcApi()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      executor: quickJsExecutor(),
    });
    const res = await mcpRpc(
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
    const body = await readJsonRpc(res);
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
        connectors: [calcApi()],
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
          void mcpRpc(
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
            const body = await readJsonRpc(response);
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
