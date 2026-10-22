import { encryptedCredentialVault } from "../src/credentials.js";
import { activityHistory } from "../src/activity.js";
import { createTestConnecta } from "./helpers.js";
import { calcApi, fakeClerkAuth, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_INVENTORY_MAX_BYTES } from "../src/execute.js";

import { api } from "../src/connectors/api.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ActivityStore, ToolCallActivityEvent } from "../src/activity.js";
import type { Connector, Executor } from "../src/types.js";

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
            throw new ConnectorCallError("auth_required", "Operator-managed credentials are required.");
          }
          return { account: values.account };
        },
      },
    ],
  });
}

describe("server /mcp end-to-end", () => {
  it("serves CORS on successful legacy /mcp responses too", async () => {
    const c = makeDeployment();
    const request = mcpRpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
      { token: TOKEN },
    );
    request.headers.set("Origin", BASE);
    const res = await c.fetch(request);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(BASE);
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("mcp-session-id");
  });

  it("legacy initialize passes through title, websiteUrl, and icons (MCP icons spec)", async () => {
    const c = createTestConnecta({
      connectors: [calcApi()],
      auth: machineAuth(TOKEN),
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
    expect(body.result.serverInfo.icons).toEqual([{ src: `${BASE}/favicon.svg`, mimeType: "image/svg+xml" }]);
  });

  it("serves a modern client without initialize and emits private tools/list cache hints", async () => {
    const c = makeDeployment();
    const methods: string[] = [];
    let toolsListResult: Record<string, unknown> | undefined;
    const client = new Client({ name: "modern-e2e", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
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
    });

    try {
      await client.connect(transport);
      const result = await client.listTools();

      expect(result.tools).toHaveLength(6);
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

  it("keeps the six tools in registration order across requests", async () => {
    const c = makeDeployment();
    for (let i = 0; i < 2; i++) {
      const body = await readJsonRpc(await mcpRpc(c, "tools/list", {}, { token: TOKEN }));
      expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "skills",
        "search_tools",
        "call_tool",
        "call_destructive_tool",
        "authorize_connector",
        "execute_code",
      ]);
    }
    await c.close();
  });

  it("rejects removed retry arguments before dispatching either direct-call tool", async () => {
    const call = vi.fn(async () => ({ done: true }));
    const c = createTestConnecta({
      connectors: [
        api("counter", {
          tools: [
            {
              name: "read",
              description: "Count reads",
              annotations: { readOnlyHint: true },
              handler: call,
            },
          ],
        }),
      ],
      auth: machineAuth(TOKEN),
      publicUrl: BASE,
    });
    for (const name of ["call_tool", "call_destructive_tool"]) {
      const body = await readJsonRpc(
        await mcpRpc(
          c,
          "tools/call",
          {
            name,
            arguments: { address: "counter.read", maxRetries: 1 },
          },
          { token: TOKEN },
        ),
      );
      expect(body.result?.isError || body.error).toBeTruthy();
      expect(JSON.stringify(body)).toContain("maxRetries");
    }
    expect(call).not.toHaveBeenCalled();
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

  it("serves a modern-era (2026-07-28) client the same six-tool surface", async () => {
    // Every other test in this suite sends bare JSON-RPC, which the entry
    // classifies as legacy traffic — so this is the one automated proof that
    // the modern createMcpHandler leg of serveMcp works at all. PR B owns the
    // full revision-adoption matrix; this pins the fork itself.
    const c = makeDeployment();
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (async (url: string | URL, init?: RequestInit) => c.fetch(new Request(url, init))) as typeof fetch,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
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

  // Two 5 MiB bodies read and parsed end to end: CPU-bound, with no timing
  // behavior, and on a loaded host past vitest's 5s default. The budget is a
  // hang guard, not a speed assertion.
  it("leaves the inbound body bound to the host on both protocol legs", async () => {
    // @modelcontextprotocol/server 2.1.0 started refusing bodies over 4 MiB
    // with its own 413. Connecta's bound belongs to the host — `listen()`'s
    // `maxBodyBytes`, the Workers platform — so a body the host admitted must
    // reach the meta-tools. JSON whitespace pads past the SDK default without
    // changing what the request says.
    const padding = " ".repeat(5 * 1024 * 1024);
    const c = makeDeployment();

    const legacy = await c.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "skills", arguments: {} },
        })}${padding}`,
      }),
    );
    expect(legacy.status).toBe(200);
    const legacyBody = await readJsonRpc(legacy);
    expect(legacyBody.error, JSON.stringify(legacyBody)).toBeUndefined();
    expect(legacyBody.result.isError).toBeFalsy();

    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const padded =
          typeof init?.body === "string" && init.body.includes('"tools/call"')
            ? { ...init, body: `${init.body}${padding}` }
            : init;
        return c.fetch(new Request(url, padded));
      }) as typeof fetch,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client(
      { name: "modern-probe", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("modern");
      const skills = (await client.callTool({
        name: "skills",
        arguments: {},
      })) as { isError?: boolean; content: { type: string }[] };
      expect(skills.isError).toBeFalsy();
      expect(skills.content[0]?.type).toBe("text");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("refuses a 2026-07-28 request that drops MCP-Protocol-Version with HeaderMismatch", async () => {
    // 2026-07-28 requires the header on every POST and has the server reject a
    // request missing it, so an intermediary routing on the header and the
    // server executing the body cannot disagree. @modelcontextprotocol/server
    // 2.0.0 served such a request anyway; 2.1.0 enforces the rule. A client
    // the SDK builds always sends the header — here a proxy strips it.
    const c = makeDeployment();
    let refused: { status: number; body: any } | undefined;
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const isCall = typeof init?.body === "string" && init.body.includes('"tools/call"');
        if (!isCall) return c.fetch(new Request(url, init));
        const headers = new Headers(init?.headers);
        expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
        headers.delete("mcp-protocol-version");
        const response = await c.fetch(new Request(url, { ...init, headers }));
        refused = { status: response.status, body: await response.clone().json() };
        return response;
      }) as typeof fetch,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client(
      { name: "modern-probe", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    try {
      await expect(client.callTool({ name: "skills", arguments: {} })).rejects.toThrow();
      expect(refused?.status).toBe(400);
      expect(refused?.body.error.code).toBe(-32020);
    } finally {
      await client.close();
    }
  });

  it("keeps shared usage stable while guide-specific tool notes stay conditional", async () => {
    async function skillsSurface(connectors: Connector[]) {
      const c = createTestConnecta({
        connectors,
        auth: machineAuth(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const listed = await readJsonRpc(await mcpRpc(c, "tools/list", {}, { token: TOKEN }));
      const usage = await readJsonRpc(
        await mcpRpc(c, "tools/call", { name: "skills", arguments: { name: "usage" } }, { token: TOKEN }),
      );
      const byName = Object.fromEntries(listed.result.tools.map((tool: { name: string }) => [tool.name, tool]));
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
        auth: machineAuth(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const listed = await readJsonRpc(await mcpRpc(c, "tools/list", {}, { token: TOKEN }));
      const execute = listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code") as {
        description: string;
      };
      await c.close();
      return execute.description;
    }
    async function inventory(ids: string[]) {
      return (await executeDescription(ids)).match(/^Connectors: .*$/m)?.[0];
    }

    expect(await inventory([])).toBe("Connectors: none.");
    expect(await inventory(["calc", "my-service", "email_api"])).toBe("Connectors: calc, my-service, email_api.");
    const ids = Array.from({ length: 104 }, (_, index) => `connector-${String(index).padStart(3, "0")}-xxxxxxxx`);
    ids[2] = `${ids[2]}y`;
    const first = await inventory(ids);
    const second = await inventory(ids);
    expect(first).toBe(second);
    expect(first).toMatch(/; \+95 more\.$/);
    expect(new TextEncoder().encode(first).length).toBeLessThanOrEqual(CONNECTOR_INVENTORY_MAX_BYTES);
    expect((await executeDescription(ids)).length).toBeLessThan(1_800);
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("orients agents with account titles without loading either catalog", async () => {
    const listTools = vi.fn(async () => {
      throw new Error("no catalog read");
    });
    const callTool = vi.fn(async () => {
      throw new Error("no provider call");
    });
    const c = createTestConnecta({
      connectors: [
        { id: "billing", title: "Android production", listTools, callTool },
        { id: "billing_test", title: "Android sandbox", listTools, callTool },
        { id: "international", title: "日本語".repeat(40), listTools, callTool },
      ],
      auth: machineAuth(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const listed = await readJsonRpc(await mcpRpc(c, "tools/list", {}, { token: TOKEN }));
    const description = listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code").description;
    const inventory = description.match(/^Connectors: .*$/m)[0];
    expect(inventory).toContain("billing: Android production");
    expect(inventory).toContain("billing_test: Android sandbox");
    expect(new TextEncoder().encode(inventory).length).toBeLessThanOrEqual(CONNECTOR_INVENTORY_MAX_BYTES);
    expect(inventory).not.toContain("\uFFFD");
    expect(description).toContain('skills({ name: "investigate" })');
    const guide = await readJsonRpc(
      await mcpRpc(
        c,
        "tools/call",
        {
          name: "skills",
          arguments: { name: "investigate" },
        },
        { token: TOKEN },
      ),
    );
    expect(guide.result.isError).toBeFalsy();
    expect(guide.result.content[0].text).toContain("Purchase verification");
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    await c.close();
  });

  it.each(["search_tools", "execute_code"] as const)(
    "INV-7: waits for a fresh catalog through %s without spawning a deferred refresh",
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
          auth: machineAuth(TOKEN),
          storage: memoryStorage(),
          publicUrl: BASE,
          discovery: {
            catalogTtlSeconds: 1,
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
            arguments: surface === "search_tools" ? { query: "read" } : { code: "async () => null" },
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
        expect(settled).toBe(false);
        release();
        expect((await response).status).toBe(200);
        expect(tails).toHaveLength(0);
        await Promise.all(tails);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("INV-6: records one payload-free activity event for each resolved tool call", async () => {
    const events: ToolCallActivityEvent[] = [];
    const activity: ActivityStore = {
      record(event) {
        events.push(event);
      },
    };
    const c = createTestConnecta({
      connectors: [calcApi()],
      auth: machineAuth(TOKEN, { subjectId: "cli-zack" }),
      storage: memoryStorage(),
      publicUrl: BASE,
      activity: activityHistory({ store: activity, deploymentId: "test" }),
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
      actor: { kind: "access_token", id: "cli-zack" },
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

  it("INV-6: stores a finite error code instead of a raw downstream error", async () => {
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
      auth: machineAuth(TOKEN),
      activity: activityHistory({
        store: {
          record(event) {
            events.push(event);
          },
        },
      }),
      publicUrl: BASE,
    });

    await mcpRpc(c, "tools/call", { name: "call_tool", arguments: { address: "private.fail" } }, { token: TOKEN });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { kind: "access_token" },
      address: "private.fail",
      outcome: "error",
      errorCode: "connector_call_failed",
    });
    expect(JSON.stringify(events)).not.toContain("customer secret");
  });

  it("recovers a machine agent after a Clerk operator update without redeploy", async () => {
    const c = createTestConnecta({
      connectors: [recoverableStaticConnector()],
      auth: [
        machineAuth(TOKEN),
        fakeClerkAuth({ frontendApiUrl: "https://clerk.example.com", token: "operator-token", userId: "operator_1" }),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
      vault: encryptedCredentialVault(memoryStorage(), CREDENTIAL_KEY),
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
      operatorUrl: `${BASE}/`,
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
      data: { account: "[redacted]" },
    });
  });

  it("forwards discovery.concurrency to catalog fan-out", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from({ length: 6 }, (_, index): Connector => ({
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
    }));
    const c = createTestConnecta({
      connectors,
      auth: machineAuth(TOKEN),
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
  it("keeps authority-shaped upgrade paths on the configured origin", async () => {
    const c = makeDeployment();
    for (const unsafe of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example/x",
      "/\r/evil.example/x",
      "/\n/evil.example/x",
    ]) {
      const res = await c.fetch(new Request(`http://connecta.test${unsafe}?next=%2Fcredentials`));
      const location = new URL(res.headers.get("location")!);
      expect(res.status).toBe(308);
      expect(location.origin).toBe(BASE);
      expect(location.search).toBe("?next=%2Fcredentials");
    }
  });

  it("preserves ordinary operator and private-API paths while upgrading", async () => {
    const c = makeDeployment();
    for (const path of ["/credentials?from=http", "/ui/data?include=connectors"]) {
      const res = await c.fetch(new Request(`http://connecta.test${path}`));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${BASE}${path}`);
    }
  });

  it("serves /health over HTTP without redirecting to the public URL", async () => {
    // Container HEALTHCHECKs hit loopback over plain HTTP; a 308 to the public
    // origin would make the probe depend on external DNS and TLS.
    const c = makeDeployment();
    const res = await c.fetch(new Request("http://127.0.0.1:8787/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
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
});

describe("clerk metadata routes (no network)", () => {
  // Fake publishable key: pk_test_<base64 domain with trailing $>.
  const domain = "clerk.example.com$";
  const pk = "pk_test_" + Buffer.from(domain, "utf8").toString("base64");

  function makeClerkConnecta() {
    return createTestConnecta({
      connectors: [calcApi()],
      auth: [
        machineAuth(TOKEN),
        clerkAuth({
          publishableKey: pk,
          secretKey: "sk_test_fake",
          allowedOAuthClientIds: ["client_connecta"],
          publicUrl: BASE,
        }),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
  }

  it("serves oauth-protected-resource metadata pointing at the derived fapi url", async () => {
    const c = makeClerkConnecta();
    const res = await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resource).toBe(`${BASE}/mcp`);
    expect(body.authorization_servers).toEqual(["https://clerk.example.com"]);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves the /mcp-suffixed protected-resource variant too", async () => {
    const c = makeClerkConnecta();
    const res = await c.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.resource).toBe(`${BASE}/mcp`);
  });
});

describe("execute_code registration (code mode)", () => {
  it("advertises the host-call limits the sandbox enforces", async () => {
    async function executeDescription(execute?: {
      maxHostCalls?: number;
      hostCallTimeoutMs?: number;
      maxWrites?: number;
    }): Promise<string> {
      const connecta = createTestConnecta({
        connectors: [calcApi()],
        auth: machineAuth(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
        ...(execute ? { execute } : {}),
      });
      const listed = await readJsonRpc(await mcpRpc(connecta, "tools/list", {}, { token: TOKEN }));
      return listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code").description as string;
    }
    expect(await executeDescription()).toContain("Limits: 20 host calls, 10 writes, 15s/host call.");
    expect(
      await executeDescription({
        maxHostCalls: 7,
        hostCallTimeoutMs: 45_000,
        maxWrites: 3,
      }),
    ).toContain("Limits: 7 host calls, 3 writes, 45s/host call.");
    // Unusable values refuse to construct rather than advertise a limit
    // nobody chose (INV-11).
    for (const execute of [{ maxHostCalls: 0 }, { hostCallTimeoutMs: Number.NaN }, { maxWrites: -1 }]) {
      await expect(executeDescription(execute)).rejects.toThrow(
        `ConnectaConfig.execute.${Object.keys(execute)[0]} must be a positive whole number`,
      );
    }
    const description = await executeDescription();
    expect(description).toContain("Writable endpoint: programs may read and write; the client approves.");
    expect(description).not.toContain("resume_execution");
  });
});
