import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import type { ToolDef } from "../src/types.js";
import { modernRequest } from "./fixtures/client-identity.js";
import { readJsonRpc } from "./fixtures/http.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityHistory,
  recordToolActivity,
  recordCatalogChangeActivity,
  type ToolCallActivityEvent,
} from "../src/activity.js";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, makeRegistry, activitySink, invokeTestCall } from "./helpers.js";
import { machineAuth, TEST_MACHINE_NAMESPACE } from "./helpers/machine-auth.js";
import { Registry } from "../src/registry.js";
import type { Connector, InboundAuth } from "../src/types.js";
import type { OperatorUiContract } from "../src/ui.js";

const BASE = "https://connecta.test";
const alice = { namespace: "directory", id: "alice" };
const bob = { namespace: "directory", id: "bob" };
const apps: ReturnType<typeof createTestConnecta>[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const close of closers.splice(0)) await close();
  vi.unstubAllGlobals();
});
function app(config: Parameters<typeof createTestConnecta>[0]) {
  const result = createTestConnecta(config);
  apps.push(result);
  return result;
}
function event(id: string, overrides: Partial<ToolCallActivityEvent> = {}): ToolCallActivityEvent {
  return {
    schemaVersion: 1,
    id,
    requestId: "request",
    occurredAt: new Date().toISOString(),
    actor: { kind: "machine" },
    connectorId: "visible",
    toolName: "read",
    address: "visible.read",
    source: "call_tool",
    outcome: "success",
    durationMs: 1,
    attempts: 1,
    serverName: "test",
    serverVersion: "1",
    classification: "read",
    ...overrides,
  };
}
const connector = (id: string): Connector =>
  api(id, {
    tools: [
      { name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => null },
      { name: "write", description: "Write", annotations: { readOnlyHint: false }, handler: () => null },
    ],
  });

function remoteCatalog(id: string, tools: () => ToolDef[], authScope?: "personal") {
  return remoteMcp(id, {
    url: "https://downstream.test/mcp",
    ...(authScope ? { authScope } : {}),
    _transportFactory: () => {
      const [client, peer] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "downstream", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({
        tools: tools().map((tool) => ({ ...tool, inputSchema: { type: "object" as const } })),
        ttlMs: 0,
        cacheScope: "public",
      }));
      server.setRequestHandler("tools/call", async () => ({ content: [], structuredContent: { ok: true } }));
      const connected = server.connect(peer);
      closers.push(async () => {
        await connected;
        await server.close();
      });
      return client;
    },
  });
}

describe("Phase 4 behavior fixes", () => {
  it("INV-5 INV-6 INV-10: empty slots override a successful status without probing, including the UI contract", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("x".repeat(32)));
    const status = vi.fn(async () => ({ state: "ok" as const }));
    const c = { ...connector("slot"), credential: { label: "API key" }, status };
    const registry = makeRegistry([c], { credentialVault: vault });
    expect(await registry.statusFor("slot", BASE)).toEqual({ state: "credential_required" });
    expect(status).not.toHaveBeenCalled();
    const deployment = app({ connectors: [c], storage, vault, logger: "silent" });
    const data = (await (await deployment.fetch(new Request(BASE + "/ui/api/config"))).json()) as OperatorUiContract;
    expect(data.live.connectors[0]).toMatchObject({
      status: "credential_required",
      problem: "credential_required",
      tools: [],
    });
    await vault.set("slot", "secret-value", "operator");
    expect((await registry.statusFor("slot", BASE)).state).toBe("ok");
    expect(status).toHaveBeenCalledOnce();
    expect(JSON.stringify(data)).not.toContain("secret-value");
    expect((await makeRegistry([c]).statusFor("slot", BASE)).state).toBe("credential_required");
  });

  it("INV-4 INV-6: permits maintainers only through activityAccess and filters connectors, pool tools, owners and undeclared pools", async () => {
    const storage = memoryStorage();
    const principal = { namespace: "directory", id: "owner" };
    const agentToken = (await new AccessTokenManager(storage, { agents: ["machine"] }).rotate("machine")).token;
    const reader: InboundAuth = {
      kind: "api",
      recognizesCredential: (request) => /^Bearer (reader|member)$/.test(request.headers.get("authorization") ?? ""),
      authorize: (request) => {
        const token = request.headers.get("authorization");
        if (token === "Bearer reader") return { ok: true, principal };
        if (token === "Bearer member") return { ok: true, principal: { namespace: "directory", id: "member" } };
        return { ok: false, response: new Response(null, { status: 401 }) };
      },
    };
    let permitted = true;
    let readGate = true;
    const own = { kind: "api", id: principal.id, namespace: principal.namespace };
    const read = vi.fn(async () => ({
      events: [
        event("yes"),
        // Plain /mcp serves the whole catalog, so its rows show every tool.
        event("tool", { toolName: "write" }),
        event("gone", { connectorId: "gone" }),
        // Every declared pool's rows, members or not, within that pool's tools.
        event("pool", { pool: "others" }),
        event("pool-read", { pool: "narrow" }),
        event("pool-tool", { pool: "narrow", toolName: "write" }),
        event("retired", { pool: "retired" }),
        event("personal", { connectorId: "personal", actor: { kind: "clerk", id: "other" } }),
        event("personal-own", { connectorId: "personal", actorBasis: "principal", actor: own }),
      ],
    }));
    const deployment = app({
      connectors: [connector("visible"), { ...connector("personal"), authScope: "personal" }],
      storage,
      auth: reader,
      maintainers: [principal],
      agents: ["machine"],
      accessTokens: accessTokens(storage),
      logger: "silent",
      identity: { activityAccess: () => permitted },
      pools: {
        others: { tools: ["visible"], members: [{ namespace: "directory", id: "member" }] },
        narrow: { tools: ["visible.read"], members: [principal, { namespace: "directory", id: "member" }] },
      },
      activity: activityHistory({ store: { record() {}, list: read }, readGate: () => readGate }),
    });
    const request = (method = "GET", token = "reader") =>
      new Request(BASE + "/ui/api/activity", { method, headers: { Authorization: `Bearer ${token}` } });
    // Activity access is not enough: a pool member that is not a maintainer,
    // and an agent (never one), get the operator routes' private 404.
    for (const token of ["member", agentToken]) {
      const refused = await deployment.fetch(request("GET", token));
      expect(refused.status, token).toBe(404);
      expect(await refused.json()).toEqual({ error: "not found" });
    }
    const response = await deployment.fetch(request());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { events: ToolCallActivityEvent[] }).events.map((e) => e.id)).toEqual([
      "yes",
      "tool",
      "pool",
      "pool-read",
      "personal-own",
    ]);
    expect((await deployment.fetch(request("POST"))).status).toBe(405);
    permitted = false;
    expect((await deployment.fetch(request())).status).toBe(403);
    permitted = true;
    readGate = false;
    expect((await deployment.fetch(request())).status).toBe(403);
    expect(read).toHaveBeenCalledOnce();
  });

  it("INV-4: permits a non-interactive API principal and denies missing principals or missing activityAccess", async () => {
    for (const [id, hasGate, expected] of [
      ["reader", true, 200],
      // Without a principal no one can be a maintainer.
      [undefined, true, 404],
      ["reader", false, 403],
      // A principal activityAccess admits is still not a maintainer.
      ["other", true, 404],
    ] as const) {
      const auth: InboundAuth = {
        kind: "api",
        authorize: () => ({ ok: true, ...(id ? { principal: { namespace: "api", id } } : {}) }),
      };
      const deployment = app({
        connectors: [connector("visible")],
        auth,
        maintainers: [{ namespace: "api", id: "reader" }],
        logger: "silent",
        identity: hasGate ? { activityAccess: () => true } : {},
        activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
      });
      expect((await deployment.fetch(new Request(BASE + "/ui/activity"))).status).toBe(expected);
    }
  });

  it("INV-6: records call-time classification and UTF-8 result bytes before truncation and groups calls", async () => {
    const c = api("visible", {
      tools: [
        {
          name: "read",
          description: "Read",
          annotations: { readOnlyHint: true },
          handler: () => ({ value: "é".repeat(100) }),
        },
      ],
    });
    const registry = makeRegistry([c], { maxResultBytes: 64 });
    const sink = activitySink();
    await invokeTestCall(registry, sink, "visible.read");
    await invokeTestCall(registry, sink, "visible.read");
    expect(sink.events).toHaveLength(2);
    for (const row of sink.events)
      expect(row).toMatchObject({
        classification: "read",
        resultBytes: new TextEncoder().encode(JSON.stringify({ value: "é".repeat(100) })).byteLength,
        requestId: "test-request",
      });
    expect(JSON.stringify(sink.events)).not.toContain("é");
    recordToolActivity(sink.activity, {
      connectorId: "visible",
      toolName: "read",
      address: "visible.read",
      source: "call_tool",
      outcome: "success",
      durationMs: 1,
      attempts: 1,
      classification: "payload" as "read",
      resultBytes: NaN,
    });
    expect(sink.events.at(-1)).not.toHaveProperty("classification");
    expect(sink.events.at(-1)).not.toHaveProperty("resultBytes");
  });

  it("INV-6 INV-8: emits one discrete payload-free change per accepted catalog transition", async () => {
    const events: ToolCallActivityEvent[] = [];
    let tools = [{ name: "read", description: "secret-text" }, { name: "removed" }];
    const c = remoteCatalog("dynamic", () => tools);
    const registry = new Registry([c], {
      storage: memoryStorage(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      toolCacheTtlSeconds: 0,
      catalogDriftActivity: {
        recordChange: recordCatalogChangeActivity,
        sink: {
          record: (e) => {
            events.push(e);
          },
        },
        serverInfo: { name: "test", version: "1" },
      },
    });
    await registry.getTools("dynamic", BASE);
    expect(events).toHaveLength(0);
    tools = [{ name: "read", description: "changed-secret" }, { name: "added" }];
    await registry.getTools("dynamic", BASE);
    await registry.getTools("dynamic", BASE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "catalog_drift",
      source: "catalog_refresh",
      drift: { kind: "catalog_changed", addedTools: 1, removedTools: 1, changedTools: 1 },
    });
    expect(events[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(events)).not.toMatch(/secret|removed"|added"/);
  });

  it("INV-6 INV-7: a catalog change and its downstream call share the HTTP request and pool", async () => {
    const events: ToolCallActivityEvent[] = [];
    let description = "Initial catalog";
    const c = remoteCatalog("dynamic", () => [{ name: "read", description, annotations: { readOnlyHint: true } }]);
    // Pools need inbound auth; the bearer caller is the pool's member.
    const deployment = app({
      connectors: [c],
      auth: machineAuth("member"),
      logger: "silent",
      discovery: { catalogTtlSeconds: 0 },
      pools: { support: { tools: ["dynamic"], members: [{ namespace: TEST_MACHINE_NAMESPACE, id: "machine" }] } },
      activity: activityHistory({
        store: {
          record: (e) => {
            events.push(e);
          },
        },
      }),
    });
    const call = async () => {
      const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "dynamic.read" } });
      request.headers.set("Authorization", "Bearer member");
      const response = await readJsonRpc(await deployment.fetch(new Request(BASE + "/mcp/support", request)));
      expect(response.result.isError).not.toBe(true);
    };
    await call();
    description = "Changed catalog";
    await call();
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      kind: "catalog_drift",
      pool: "support",
      drift: { kind: "catalog_changed", addedTools: 0, removedTools: 0, changedTools: 1 },
    });
    expect(events[1]?.requestId).toBe(events[2]?.requestId);
    expect(events[0]?.requestId).not.toBe(events[2]?.requestId);
    expect(events[1]?.actor).toEqual(events[2]?.actor);
    expect(JSON.stringify(events)).not.toContain("Changed catalog");
  });

  it.each(["request-public", "shared-private"] as const)(
    "INV-4 INV-5 INV-6 INV-8: %s catalog drift in partition A is neither emitted for nor visible to partition B",
    async (mode) => {
      const events: ToolCallActivityEvent[] = [];
      const descriptions: Record<string, string> = { alice: "A initial secret", bob: "B distinct secret" };
      const downstream = httpDownstream((server) =>
        server.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [] })),
      );
      let listingPrincipal = "alice";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const message =
          request.method === "POST" ? ((await request.clone().json()) as { method: string; id: string }) : undefined;
        if (message?.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              tools: [
                {
                  name: "read",
                  description: descriptions[listingPrincipal],
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
              ],
              ttlMs: 0,
              cacheScope: mode === "request-public" ? "public" : "private",
            },
          });
        return downstream.fetch(input instanceof Request ? input.url : input, init);
      });
      const c = remoteMcp("partitioned", {
        url: downstream.url,
        ...(mode === "request-public"
          ? { auth: { type: "request" as const, token: async () => "same-secret-token" } }
          : {}),
      });
      const auth: InboundAuth = {
        kind: "api",
        authorize: (request) => ({
          ok: true,
          subjectId: "shared-subject",
          principal: { namespace: "directory", id: request.headers.get("X-Principal") ?? "alice" },
        }),
      };
      const deployment = app({
        connectors: [c],
        auth,
        storage: memoryStorage(),
        logger: "silent",
        // Both read activity as maintainers, so the drift row's owner decides.
        maintainers: [alice, bob],
        identity: { activityAccess: () => true },
        pools: { support: { tools: ["partitioned"], members: [alice, bob] } },
        activity: activityHistory({
          store: {
            record: (e) => {
              events.push(e);
            },
            list: async () => ({ events }),
          },
        }),
      });
      const call = async (principal: string) => {
        listingPrincipal = principal;
        const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "partitioned.read" } });
        request.headers.set("X-Principal", principal);
        const result = await readJsonRpc(await deployment.fetch(new Request(BASE + "/mcp/support", request)));
        expect(result.result, JSON.stringify(result)).not.toHaveProperty("isError", true);
      };
      const changes = () => events.filter((e) => e.kind === "catalog_drift");
      await call("alice");
      await call("bob");
      expect(changes()).toEqual([]);
      descriptions.alice = "A changed secret";
      await call("alice");
      expect(changes()).toHaveLength(1);
      expect(changes()[0]).toMatchObject({
        actorBasis: "principal",
        actor: { kind: "api", id: "alice", namespace: "directory" },
        pool: "support",
        drift: { kind: "catalog_changed", addedTools: 0, removedTools: 0, changedTools: 1 },
      });
      expect(changes()[0]!.requestId).toBe(events.at(-1)!.requestId);
      await call("bob");
      await call("alice");
      expect(changes()).toHaveLength(1);
      const read = async (principal: string) =>
        (await (
          await deployment.fetch(new Request(BASE + "/ui/api/activity", { headers: { "X-Principal": principal } }))
        ).json()) as { events: ToolCallActivityEvent[] };
      expect((await read("bob")).events.filter((e) => e.kind === "catalog_drift")).toEqual([]);
      expect((await read("alice")).events.filter((e) => e.kind === "catalog_drift").map((e) => e.id)).toEqual([
        changes()[0]!.id,
      ]);
      expect(JSON.stringify(changes())).not.toMatch(/secret|same-secret-token/);
    },
  );

  it.each([false, true])(
    "INV-4 INV-6: API principals cannot read another owner or ownerless legacy rows with shared subject=%s",
    async (sharedSubject) => {
      const events: ToolCallActivityEvent[] = [];
      const auth: InboundAuth = {
        kind: "api",
        authorize: (request) => ({
          ok: true,
          ...(sharedSubject ? { subjectId: "shared-service" } : {}),
          principal: { namespace: "directory", id: request.headers.get("X-Principal") ?? "alice" },
        }),
      };
      const deployment = app({
        connectors: [{ ...connector("personal"), authScope: "personal" }],
        auth,
        maintainers: [alice, bob],
        logger: "silent",
        identity: { activityAccess: () => true },
        activity: activityHistory({
          store: {
            record: (e) => {
              events.push(e);
            },
            list: async () => ({ events }),
          },
        }),
      });
      const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "personal.read" } });
      expect((await readJsonRpc(await deployment.fetch(request))).result.isError).not.toBe(true);
      expect(events[0]?.actor).toEqual({ kind: "api", id: "alice", namespace: "directory" });
      events.push(event("legacy", { connectorId: "personal", actor: { kind: "api" } }));
      // Pre-fix subjectId could name Bob even though Alice was the admitted owner.
      events.push(
        event("ambiguous-legacy", {
          connectorId: "personal",
          actor: { kind: "api", id: "bob", namespace: "directory" },
        }),
      );
      const read = async (principal: string) =>
        (await (
          await deployment.fetch(new Request(BASE + "/ui/api/activity", { headers: { "X-Principal": principal } }))
        ).json()) as { events: ToolCallActivityEvent[] };
      expect((await read("bob")).events).toEqual([]);
      expect((await read("alice")).events.map((e) => e.id)).toEqual([events[0]!.id]);
    },
  );

  it("INV-4 INV-6: pagination never returns a hidden row's cursor and advances to visible history", async () => {
    const rows = [
      event("alice-1", {
        connectorId: "personal",
        actorBasis: "principal",
        actor: { kind: "api", id: "alice", namespace: "directory" },
      }),
      event("alice-2", {
        connectorId: "personal",
        actorBasis: "principal",
        actor: { kind: "api", id: "alice", namespace: "directory" },
      }),
    ];
    const auth: InboundAuth = {
      kind: "api",
      authorize: () => ({ ok: true, principal: bob }),
    };
    const deployment = app({
      connectors: [connector("visible"), { ...connector("personal"), authScope: "personal" }],
      auth,
      maintainers: [bob],
      logger: "silent",
      identity: { activityAccess: () => true },
      activity: activityHistory({
        store: {
          record: () => {},
          list: async ({ cursor, limit }) => {
            const start = cursor ? rows.findIndex((e) => e.id === cursor) + 1 : 0;
            const events = rows.slice(start, start + limit!);
            return {
              events,
              ...(start + events.length < rows.length ? { nextCursor: events[events.length - 1]!.id } : {}),
            };
          },
        },
      }),
    });
    const read = async (cursor = "") =>
      (await (
        await deployment.fetch(new Request(BASE + "/ui/api/activity?limit=1" + (cursor ? "&cursor=" + cursor : "")))
      ).json()) as { events: ToolCallActivityEvent[]; nextCursor?: string };
    expect(await read()).toEqual({ events: [] });
    rows.push(event("visible-1"), event("alice-3", { ...rows[0], id: "alice-3" }), event("visible-2"));
    const first = await read();
    expect(first.events.map((e) => e.id)).toEqual(["visible-1"]);
    expect(first.nextCursor).toBe("visible-1");
    const second = await read(first.nextCursor);
    expect(second.events.map((e) => e.id)).toEqual(["visible-2"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("INV-4 INV-6 INV-7: hidden-boundary reads stop after cancellation and have a finite work budget", async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let blocked = true;
    const list = vi.fn(async () => {
      if (blocked) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { events: [event("hidden", { connectorId: "hidden" })], nextCursor: "hidden-" + list.mock.calls.length };
    });
    const deployment = app({
      connectors: [connector("visible")],
      auth: { kind: "api", authorize: () => ({ ok: true, principal: { namespace: "directory", id: "reader" } }) },
      maintainers: [{ namespace: "directory", id: "reader" }],
      identity: { activityAccess: () => true },
      logger: "silent",
      activity: activityHistory({ store: { record() {}, list } }),
    });
    const controller = new AbortController();
    const abandoned = deployment.fetch(new Request(BASE + "/ui/api/activity", { signal: controller.signal }));
    const rejected = expect(abandoned).rejects.toThrow();
    await pending;
    controller.abort();
    await rejected;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(list).toHaveBeenCalledTimes(1);
    blocked = false;
    list.mockClear();
    const response = await deployment.fetch(new Request(BASE + "/ui/api/activity"));
    expect(response.status).toBe(503);
    expect(list).toHaveBeenCalledTimes(1001);
    expect(JSON.stringify(await response.json())).not.toContain("hidden-");
  });

  it.each(["/ui/api/config", "/ui/connectors/personal"])(
    "INV-4 INV-6: %s attributes personal catalog changes to the admitted owner",
    async (path) => {
      const events: ToolCallActivityEvent[] = [];
      let description = "Initial";
      const c = remoteCatalog("personal", () => [{ name: "read", description }], "personal");
      const auth: InboundAuth = {
        kind: "human",
        authorize: (request) => ({
          ok: true,
          interactive: true,
          subjectId: "shared-subject",
          principal: { namespace: "directory", id: request.headers.get("X-Principal") ?? "alice" },
        }),
      };
      const deployment = app({
        connectors: [c],
        auth,
        maintainers: [alice, bob],
        identity: { activityAccess: () => true },
        logger: "silent",
        discovery: { catalogTtlSeconds: 0 },
        activity: activityHistory({
          store: {
            record: (e) => {
              events.push(e);
            },
            list: async () => ({ events }),
          },
        }),
      });
      expect((await deployment.fetch(new Request(BASE + path))).status).toBe(200);
      description = "Changed";
      expect((await deployment.fetch(new Request(BASE + path))).status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "catalog_drift",
        actorBasis: "principal",
        actor: { kind: "human", id: "alice", namespace: "directory" },
      });
      const read = async (principal: string) =>
        (await (
          await deployment.fetch(new Request(BASE + "/ui/api/activity", { headers: { "X-Principal": principal } }))
        ).json()) as { events: ToolCallActivityEvent[] };
      expect((await read("alice")).events.map((e) => e.id)).toEqual([events[0]!.id]);
      expect((await read("bob")).events).toEqual([]);
    },
  );

  it("INV-4 INV-6: keeps long configured pool names scoped through recording and disclosure", async () => {
    const events: ToolCallActivityEvent[] = [];
    const pool = "p".repeat(65);
    const auth: InboundAuth = {
      kind: "api",
      authorize: (request) => ({
        ok: true,
        principal: { namespace: "directory", id: request.headers.get("X-Principal") ?? "alice" },
      }),
    };
    const deployment = app({
      connectors: [connector("visible")],
      auth,
      maintainers: [bob],
      logger: "silent",
      identity: { activityAccess: () => true },
      pools: { [pool]: { tools: ["visible.read"], members: [alice] } },
      activity: activityHistory({
        store: {
          record: (e) => {
            events.push(e);
          },
          list: async () => ({ events }),
        },
      }),
    });
    const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "visible.read" } });
    expect(
      (await readJsonRpc(await deployment.fetch(new Request(BASE + "/mcp/" + pool, request)))).result.isError,
    ).not.toBe(true);
    expect(events[0]?.pool).toBe(pool);
    // Outside the pool's declared tools, and in a pool whose name a
    // truncation would produce, rows are withheld.
    events.push(event("outside", { pool, toolName: "write" }), event("truncated", { pool: pool.slice(0, 64) }));
    const read = (principal: string) =>
      deployment.fetch(new Request(BASE + "/ui/api/activity", { headers: { "X-Principal": principal } }));
    // The maintainer finds the row under its full pool name; the member, not a maintainer, gets the 404.
    expect(((await (await read("bob")).json()) as { events: ToolCallActivityEvent[] }).events.map((e) => e.id)).toEqual(
      [events[0]!.id],
    );
    expect((await read("alice")).status).toBe(404);
  });

  it.each(["/ui/api/config", "/ui/connectors/dynamic"])(
    "INV-7: %s defers pending catalog activity writes through the Workers lifetime hook",
    async (path) => {
      let description = "Initial";
      let release!: () => void;
      const writes: Promise<unknown>[] = [];
      const c = remoteCatalog("dynamic", () => [{ name: "read", description }]);
      const deployment = app({
        connectors: [c],
        logger: "silent",
        discovery: { catalogTtlSeconds: 0 },
        activity: activityHistory({
          store: {
            record: () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          },
        }),
      });
      expect((await deployment.fetch(new Request(BASE + path))).status).toBe(200);
      description = "Changed";
      const response = await deployment.fetch(new Request(BASE + path), undefined, {
        waitUntil: (pending: Promise<unknown>) => {
          writes.push(pending);
        },
      });
      expect(response.status).toBe(200);
      expect(writes.length).toBeGreaterThan(0);
      expect(release).toBeTypeOf("function");
      release();
      await Promise.all(writes);
    },
  );
});
