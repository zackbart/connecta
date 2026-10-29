import { Effect, Scheduler } from "effect";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createRouteDispatcher } from "../src/routes/dispatch.js";
import type { RouteContext } from "../src/routes/shared.js";
import { runEdge } from "../src/runtime/run.js";
import { operatorUi } from "../src/ui.js";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { activityHistory } from "../src/activity.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { CONNECTOR_INVENTORY_MAX_BYTES } from "../src/execute.js";
import { calcApi, fakeClerkAuth, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, required } from "./helpers.js";
import { scriptedExecutor } from "./fixtures/misc.js";

import type { ActivityStore, ToolCallActivityEvent } from "../src/activity.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, Executor } from "../src/types.js";
import { machineAuth } from "./helpers/machine-auth.js";

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
  it("honors the configured inbound body bound on both protocol legs", async () => {
    // @modelcontextprotocol/server 2.1.0 started refusing bodies over 4 MiB
    // with its own 413. Raise Connecta's explicit fetch-native bound so a body
    // it admits must reach the meta-tools on both SDK protocol legs. Direct
    // fetch does not pass through listen()'s independent outer transport cap.
    // JSON whitespace pads past the SDK default without changing the request.
    const padding = " ".repeat(5 * 1024 * 1024);
    const c = makeDeployment({ admission: { requests: { maxBodyBytes: 8 * 1024 * 1024 } } });

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
    expect((await executeDescription(ids)).length).toBeLessThan(2_650);
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
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

  it("returns programs whole up to execute.maxResultChars, shares it with emitted text, and pages to it", async () => {
    async function run(execute: { maxResultChars?: number } | undefined, returnChars: number, emitChars = 0) {
      const connecta = createTestConnecta({
        connectors: [calcApi()],
        auth: machineAuth(TOKEN),
        storage: memoryStorage(),
        publicUrl: BASE,
        ...(execute ? { execute } : {}),
        executor: scriptedExecutor(async (fns) => {
          if (emitChars) await required(fns.emit)({ type: "text", text: "y".repeat(emitChars) });
          return { rows: "x".repeat(returnChars) };
        }),
      });
      const ran = await readJsonRpc(
        await mcpRpc(
          connecta,
          "tools/call",
          { name: "execute_code", arguments: { code: "async () => rows" } },
          { token: TOKEN },
        ),
      );
      const limit = connecta.describeConfig().limits.execute.maxResultChars;
      await connecta.close();
      return { content: ran.result.structuredContent, limit };
    }
    const pageBytes = (content: { result: { nextAction: { arguments: { code: string } } } }) =>
      Number(/maxBytes: (\d+)/.exec(content.result.nextAction.arguments.code)?.[1]);

    // The default is unchanged: 100,000 characters are stashed behind a notice.
    const fallback = await run(undefined, 100_000);
    expect(fallback.limit).toEqual({ value: 24_000, source: "default" });
    expect(fallback.content.result).toMatchObject({ truncated: true, resultId: expect.any(String) });
    expect(pageBytes(fallback.content)).toBe(3_829);

    // Raised, the same return arrives whole in one step.
    const raised = await run({ maxResultChars: 150_000 }, 100_000);
    expect(raised.limit).toEqual({ value: 150_000, source: "config" });
    expect(raised.content.result).toEqual({ rows: "x".repeat(100_000) });

    // Past the raised cap, the notice pages in the largest step the stash serves
    // (calls.maxResultBytes, 24,000), not the 24,829 the return cap alone allows.
    const over = await run({ maxResultChars: 150_000 }, 200_000);
    expect(over.content.result).toMatchObject({ truncated: true, resultId: expect.any(String) });
    expect(pageBytes(over.content)).toBe(24_000);
    expect(JSON.stringify(over.content.result).length).toBeLessThanOrEqual(150_000);

    // Emitted text shares whichever cap the deployment set.
    expect((await run({ maxResultChars: 150_000 }, 10, 30_000)).content.isError).not.toBe(true);
    expect((await run(undefined, 10, 30_000)).content.error).toMatchObject({
      code: "result_too_large",
      message: expect.stringContaining("24,000-character program result limit"),
    });

    for (const [maxResultChars, message] of [
      [3_999, "must be a whole number of at least 4,000"],
      [1_000_001, "must be at most 1,000,000"],
      [1.5, "must be a whole number of at least 4,000"],
    ] as const) {
      await expect(run({ maxResultChars }, 10)).rejects.toThrow(`ConnectaConfig.execute.maxResultChars ${message}`);
    }
  });

  it("advertises the deadline each host call actually gets when calls.defaultTimeoutMs differs", async () => {
    const stalledId = crypto.randomUUID();
    const inner = memoryStorage();
    const storage = {
      ...inner,
      async get(key: string) {
        // A result read that never answers, so only the utility deadline ends it.
        if (key.includes(stalledId)) return new Promise<never>(() => {});
        return inner.get(key);
      },
    };
    const connecta = createTestConnecta({
      connectors: [calcApi()],
      auth: machineAuth(TOKEN),
      storage,
      publicUrl: BASE,
      calls: { defaultTimeoutMs: 2_000 },
      execute: { hostCallTimeoutMs: 100 },
      executor: scriptedExecutor(async (fns) => {
        try {
          return await required(fns.result)(stalledId);
        } catch (error) {
          return (error as { details?: unknown }).details;
        }
      }),
    });
    try {
      const listed = await readJsonRpc(await mcpRpc(connecta, "tools/list", {}, { token: TOKEN }));
      const description = listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code")
        .description as string;
      const advertised = /Limits: .*?, (\d+(?:\.\d+)?)s\/call \((\d+(?:\.\d+)?)s result\/skill\/read\)\./.exec(
        description,
      );
      expect(advertised?.slice(1)).toEqual(["2", "0.1"]);
      const ran = await readJsonRpc(
        await mcpRpc(
          connecta,
          "tools/call",
          { name: "execute_code", arguments: { code: "async () => connecta.result(id)" } },
          { token: TOKEN },
        ),
      );
      expect(ran.result.structuredContent.result).toMatchObject({
        code: "timeout",
        details: { operation: "connecta.result", deadlineMs: Number(advertised![2]) * 1_000 },
      });
    } finally {
      await connecta.close();
    }
  });
});

it("serves /health over HTTP without redirecting to the public URL", async () => {
  // Container HEALTHCHECKs hit loopback over plain HTTP; a 308 to the public
  // origin would make the probe depend on external DNS and TLS.
  const c = makeDeployment();
  const res = await c.fetch(new Request("http://127.0.0.1:8787/health"));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe("ok");
});

function context(path: string, init?: RequestInit): RouteContext {
  const request = new Request(BASE + path, init);
  return { request, url: new URL(request.url), path, baseUrl: BASE, opts: { config: {} } } as RouteContext;
}

describe("production HTTP dispatcher", () => {
  it("preserves Response/body identity and falls through only before handler entry", async () => {
    const response = new Response("owned", { status: 405, headers: { allow: "PUT", "set-cookie": "a=1; Path=/" } });
    let failure: unknown;
    const mcp = vi.fn(() => (failure ? Effect.fail(failure) : Effect.succeed(null)));
    const route = createRouteDispatcher(
      mcp,
      () => Effect.succeed(null),
      async () => response,
    );
    expect(await runEdge(route(context("/health")))).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("allow")).toBe("PUT");
    expect(response.headers.get("set-cookie")).toBe("a=1; Path=/");
    expect(mcp).not.toHaveBeenCalled();
    for (const path of ["/missing", "/connect", "/agent/missing"]) {
      const missing = await runEdge(route(context(path)));
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("Not Found");
    }
    const typed = new HttpServerError.HttpServerError({
      reason: new HttpServerError.RouteNotFound({ request: HttpServerRequest.fromWeb(context("/mcp").request) }),
    });
    for (const error of [new Error("private"), { reason: { _tag: "RouteNotFound" } }, typed]) {
      failure = error;
      for (const path of ["/mcp", "/missing", "/agent/native"]) {
        mcp.mockClear();
        await expect(runEdge(route(context(path)))).rejects.toBe(error);
        expect(mcp).toHaveBeenCalledTimes(1);
      }
    }
    expect(await response.text()).toBe("owned");
  });

  it("INV-7: concurrent first and later requests retain their own body, signal and services", async () => {
    const route = createRouteDispatcher(
      (ctx) =>
        Effect.gen(function* () {
          const preventYield = yield* Scheduler.PreventSchedulerYield;
          yield* Effect.promise(() => Promise.resolve());
          const body = yield* Effect.promise(() => ctx.request.text());
          ctx.defer?.(Promise.resolve());
          return Response.json({
            body,
            id: ctx.request.headers.get("x-request-id"),
            path: ctx.path,
            preventYield,
            aborted: ctx.request.signal.aborted,
          });
        }),
      () => Effect.succeed(null),
      async () => new Response("health"),
    );
    for (const offset of [0, 8]) {
      await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const id = String(offset + index);
          const path = index % 2 ? "/agent/native" : "/mcp/native";
          const caller = new AbortController();
          const ctx = context(path, {
            method: "POST",
            headers: { "x-request-id": id },
            body: `body-${id}`,
            signal: caller.signal,
          });
          let deferred = 0;
          ctx.defer = () => {
            deferred++;
          };
          const response = await runEdge(route(ctx).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)), {
            signal: caller.signal,
          });
          expect(await response.json()).toEqual({ body: `body-${id}`, id, path, preventYield: false, aborted: false });
          expect(deferred).toBe(1);
          caller.abort();
        }),
      );
    }
    expect(await (await runEdge(route(context("/health")))).text()).toBe("health");
  });

  it("INV-4 INV-10: keeps raw prefixes, malformed suffixes, extension methods and public CIMD in their owning routes", async () => {
    const trace: string[] = [];
    const ui = operatorUi();
    const storage = memoryStorage();
    const storageCalls = (["get", "set", "delete", "list", "compareAndSet"] as const).map((method) =>
      vi.spyOn(storage, method),
    );
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No outbound I/O expected"));
    const app = createTestConnecta({
      storage,
      connectors: [
        remoteMcp("oauth", {
          url: "https://remote.example/mcp",
          versionNegotiation: "legacy",
          auth: { type: "oauth", scope: "read" },
        }),
      ],
      logger: "silent",
      publicUrl: BASE,
      maintainers: [{ namespace: "fixture", id: "alice" }],
      auth: {
        kind: "router",
        authorize: (request) => {
          expect(request.bodyUsed).toBe(false);
          trace.push("auth");
          return { ok: false, response: new Response(null, { status: 401 }) };
        },
        handleMetadata: async (request) => {
          trace.push("metadata");
          return new URL(request.url).pathname === "/.well-known/example" ? new Response("metadata") : null;
        },
      },
      ui: {
        ...ui,
        handle: async () => {
          trace.push("ui");
          return null;
        },
      },
    });
    try {
      const cases: Array<[string, string, number, string[]]> = [
        ["/health", "PROPFIND", 200, ["ui"]],
        ["/health/", "GET", 404, ["ui"]],
        ["/health;tail", "GET", 404, ["ui"]],
        ["/%68ealth", "GET", 404, ["ui"]],
        ["/HEALTH", "GET", 404, ["ui"]],
        ["/mcp/%", "POST", 401, ["ui", "auth", "metadata"]],
        ["/mcp/%FF", "PROPFIND", 401, ["ui", "auth", "metadata"]],
        ["/mcp/a;b", "POST", 401, ["ui", "auth", "metadata"]],
        ["/mcp/" + "x".repeat(200), "POST", 401, ["ui", "auth", "metadata"]],
        ["/connect/%", "POST", 405, ["ui"]],
        ["/connect/%FF", "GET", 403, ["ui"]],
        ["/oauth/callback/%", "PROPFIND", 405, ["ui"]],
        ["/.well-known/example", "GET", 200, ["ui", "metadata"]],
        ["/%2ewell-known/example", "GET", 404, ["ui"]],
        ["/agent/native", "POST", 401, []],
        ["/%61gent/native", "GET", 404, []],
        ["//agent/native", "GET", 404, []],
        ["/missing%FF", "OPTIONS", 204, ["ui", "metadata"]],
        ["/oauth/client-metadata/oauth", "GET", 200, []],
        ["/oauth/client-metadata/oauth", "HEAD", 405, []],
        ["/oauth/client-metadata/oauth", "PROPFIND", 405, []],
        ["/oauth/client-metadata/oauth", "POST", 405, []],
        ["/oauth/client-metadata/oauth", "OPTIONS", 405, []],
        ["/oauth/client-metadata/%6fauth", "GET", 404, []],
        ["/oauth/client-metadata/oauth/", "GET", 404, []],
        ["/oauth/client-metadata/oauth;tail", "GET", 404, []],
        ["/oauth/%63lient-metadata/oauth", "GET", 404, ["ui"]],
        ["//oauth/client-metadata/oauth", "GET", 404, ["ui"]],
        ["/oauth//client-metadata/oauth", "GET", 404, ["ui"]],
      ];
      const admission = async () => {
        const response = await app.fetch(new Request(BASE + "/health"));
        const health = (await response.json()) as {
          admission: { requests: { active: number; queued: number; totals: { admitted: number } } };
        };
        const { active, queued, totals } = health.admission.requests;
        return { active, queued, admitted: totals.admitted };
      };
      for (const [path, method, status, expectedTrace] of cases) {
        const publicCimd = path.startsWith("/oauth/client-metadata/");
        const before = publicCimd ? await admission() : undefined;
        trace.length = 0;
        storageCalls.forEach((spy) => spy.mockClear());
        const request = new Request(BASE + path, { method, ...(method === "POST" ? { body: "unread" } : {}) });
        const response = await app.fetch(request);
        expect(response.status, `${method} ${path}`).toBe(status);
        expect(trace, `${method} ${path}`).toEqual(expectedTrace);
        if (publicCimd) {
          expect(request.bodyUsed).toBe(false);
          expect(await admission()).toEqual(before);
          for (const spy of storageCalls) expect(spy).not.toHaveBeenCalled();
          expect(outbound).not.toHaveBeenCalled();
        }
        if (path === "/oauth/client-metadata/oauth") {
          if (method === "GET") {
            expect(response.headers.get("cache-control")).toBe("public, max-age=300");
            expect(await response.json()).toEqual({
              client_id: `${BASE}${path}`,
              client_name: "connecta",
              application_type: "web",
              redirect_uris: [`${BASE}/oauth/callback/oauth`],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
              scope: "read",
            });
          } else {
            expect(response.headers.get("allow")).toBe("GET");
            expect(await response.text()).toBe("");
          }
        } else await response.body?.cancel();
      }
    } finally {
      outbound.mockRestore();
      storageCalls.forEach((spy) => spy.mockRestore());
      await app.close();
    }
  });

  it.each(["end", "failure", "cancel", "abort", "abandon"] as const)(
    "INV-7: keeps a response permit until %s and releases it exactly once",
    async (mode) => {
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let cancels = 0;
      let localSignal: AbortSignal | undefined;
      const app = createTestConnecta({
        connectors: [],
        logger: "silent",
        maintainers: [{ namespace: "fixture", id: "alice" }],
        admission: { requests: { concurrency: 1, maxQueueSize: 0, maxDurationMs: mode === "abandon" ? 50 : 2000 } },
        auth: {
          kind: "stream",
          authorize: (request) => {
            localSignal = request.signal;
            return {
              ok: false,
              response: new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    source = controller;
                    controller.enqueue(new TextEncoder().encode("slow"));
                  },
                  cancel() {
                    cancels++;
                  },
                }),
                { status: 401 },
              ),
            };
          },
        },
      });
      const active = async () =>
        (
          (await (await app.fetch(new Request(BASE + "/health"))).json()) as {
            admission: { requests: { active: number } };
          }
        ).admission.requests.active;
      const caller = new AbortController();
      try {
        const response = await app.fetch(new Request(BASE + "/mcp", { signal: caller.signal }));
        expect(await active()).toBe(1);
        if (mode === "end") {
          source.close();
          expect(await response.text()).toBe("slow");
        }
        if (mode === "failure") {
          const error = new Error("stream failed");
          source.error(error);
          await expect(response.text()).rejects.toBe(error);
        }
        if (mode === "cancel") await response.body?.cancel("cancelled");
        if (mode === "abort") caller.abort(new Error("caller left"));
        if (mode === "abandon") await new Promise((resolve) => setTimeout(resolve, 100));
        await Promise.resolve();
        expect(await active()).toBe(0);
        expect(localSignal?.aborted).toBe(true);
        const expectedCancels = ["cancel", "abort", "abandon"].includes(mode) ? 1 : 0;
        expect(cancels).toBe(expectedCancels);
        await response.body?.cancel().catch(() => {});
        expect(cancels).toBe(expectedCancels);
      } finally {
        await app.close();
      }
    },
  );
});
