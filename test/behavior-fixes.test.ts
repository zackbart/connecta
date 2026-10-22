import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityHistory, recordToolActivity, type ToolCallActivityEvent } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth, ToolDef } from "../src/types.js";
import type { OperatorUiContract } from "../src/ui.js";
import { modernRequest } from "./fixtures/client-identity.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { readJsonRpc } from "./fixtures/http.js";
import { activitySink, createTestConnecta, invokeTestCall, makeRegistry } from "./helpers.js";

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
