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
  it("INV-4 INV-6: permits maintainers only and filters connectors, pool tools, owners and undeclared pools", async () => {
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
      pools: {
        others: { tools: ["visible"], members: [{ namespace: "directory", id: "member" }] },
        narrow: { tools: ["visible.read"], members: [principal, { namespace: "directory", id: "member" }] },
      },
      activity: activityHistory({ store: { record() {}, list: read }, readGate: () => readGate }),
    });
    const request = (method = "GET", token = "reader") =>
      new Request(BASE + "/ui/api/activity", { method, headers: { Authorization: `Bearer ${token}` } });
    // A pool member that is not a maintainer gets the operator routes'
    // private 404, and an agent token is refused outright, since operator
    // routes are human routes (#837).
    const refused = await deployment.fetch(request("GET", "member"));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not found" });
    expect((await deployment.fetch(request("GET", agentToken))).status).toBe(401);
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
    readGate = false;
    expect((await deployment.fetch(request())).status).toBe(403);
    expect(read).toHaveBeenCalledOnce();
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

  it.each(["request-public"] as const)(
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

  it.each([true])(
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

});
