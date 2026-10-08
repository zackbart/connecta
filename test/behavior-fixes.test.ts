import { modernRequest } from "./fixtures/client-identity.js";
import { readJsonRpc } from "./fixtures/http.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityHistory, recordToolActivity, recordCatalogChangeActivity, type ToolCallActivityEvent } from "../src/activity.js";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, makeRegistry, activitySink, invokeTestCall } from "./helpers.js";
import { Registry } from "../src/registry.js";
import type { Connector, InboundAuth } from "../src/types.js";
import type { OperatorUiContract } from "../src/ui.js";

const BASE = "https://connecta.test";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function app(config: Parameters<typeof createTestConnecta>[0]) { const result = createTestConnecta(config); apps.push(result); return result; }
function event(id: string, overrides: Partial<ToolCallActivityEvent> = {}): ToolCallActivityEvent {
  return { schemaVersion: 1, id, requestId: "request", occurredAt: new Date().toISOString(), actor: { kind: "machine" }, connectorId: "visible", toolName: "read", address: "visible.read", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1, serverName: "test", serverVersion: "1", classification: "read", ...overrides };
}
const connector = (id: string): Connector => api(id, { tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => null }, { name: "write", description: "Write", annotations: { readOnlyHint: false }, handler: () => null }] });

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
    const data = await (await deployment.fetch(new Request(BASE + "/ui/api/config"))).json() as OperatorUiContract;
    expect(data.live.connectors[0]).toMatchObject({ status: "credential_required", problem: "credential_required", tools: [] });
    await vault.set("slot", "secret-value", "operator");
    expect((await registry.statusFor("slot", BASE)).state).toBe("ok");
    expect(status).toHaveBeenCalledOnce();
    expect(JSON.stringify(data)).not.toContain("secret-value");
    expect((await makeRegistry([c]).statusFor("slot", BASE)).state).toBe("credential_required");
  });

  it("INV-4 INV-6: permits cta_ principals only through activityAccess and filters connectors, tools, owners and pools", async () => {
    const storage = memoryStorage();
    const principal = { namespace: "directory", id: "owner" };
    const token = await new AccessTokenManager(storage).create("machine", principal);
    let permitted = true;
    let readGate = true;
    const read = vi.fn(async () => ({ events: [event("yes"), event("tool", { toolName: "write" }), event("hidden", { connectorId: "hidden" }), event("pool", { pool: "denied" }), event("pool-tool", { pool: "narrow", toolName: "write" }), event("personal", { connectorId: "personal", actor: { kind: "clerk", id: "other" } })] }));
    const deployment = app({ connectors: [connector("visible"), connector("hidden"), { ...connector("personal"), authScope: "personal" }], storage, accessTokens: accessTokens(storage), logger: "silent",
      identity: { activityAccess: value => permitted && value.id === principal.id, connectorAccess: () => ["visible.read", "personal"] },
      pools: { denied: { tools: ["visible"], grant: () => false }, narrow: { tools: ["visible.read"], grant: () => true } },
      activity: activityHistory({ store: { record() {}, list: read }, readGate: () => readGate }),
    });
    const request = (method = "GET") => new Request(BASE + "/ui/api/activity", { method, headers: { Authorization: `Bearer ${token.token}` } });
    const response = await deployment.fetch(request());
    expect(response.status).toBe(200);
    expect((await response.json() as { events: ToolCallActivityEvent[] }).events.map(e => e.id)).toEqual(["yes"]);
    expect((await deployment.fetch(request("POST"))).status).toBe(405);
    permitted = false;
    expect((await deployment.fetch(request())).status).toBe(403);
    permitted = true; readGate = false;
    expect((await deployment.fetch(request())).status).toBe(403);
    expect(read).toHaveBeenCalledOnce();
  });

  it("INV-4: permits a non-interactive API principal and denies missing principals or missing activityAccess", async () => {
    for (const [hasPrincipal, hasGate, expected] of [[true, true, 200], [false, true, 403], [true, false, 403]] as const) {
      const auth: InboundAuth = { kind: "api", authorize: () => ({ ok: true, ...(hasPrincipal ? { principal: { namespace: "api", id: "reader" } } : {}) }) };
      const deployment = app({ connectors: [connector("visible")], auth, logger: "silent", identity: hasGate ? { activityAccess: p => p.id === "reader" } : {}, activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }) });
      expect((await deployment.fetch(new Request(BASE + "/ui/activity"))).status).toBe(expected);
    }
  });

  it("INV-6: records call-time classification and UTF-8 result bytes before truncation and groups calls", async () => {
    const c = api("visible", { tools: [{ name: "read", description: "Read", annotations: { readOnlyHint: true }, handler: () => ({ value: "é".repeat(100) }) }] });
    const registry = makeRegistry([c], { maxResultBytes: 64 });
    const sink = activitySink();
    await invokeTestCall(registry, sink, "visible.read");
    await invokeTestCall(registry, sink, "visible.read");
    expect(sink.events).toHaveLength(2);
    for (const row of sink.events) expect(row).toMatchObject({ classification: "read", resultBytes: new TextEncoder().encode(JSON.stringify({ value: "é".repeat(100) })).byteLength, requestId: "test-request" });
    expect(JSON.stringify(sink.events)).not.toContain("é");
    recordToolActivity(sink.activity, { connectorId: "visible", toolName: "read", address: "visible.read", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1, classification: "payload" as "read", resultBytes: NaN });
    expect(sink.events.at(-1)).not.toHaveProperty("classification");
    expect(sink.events.at(-1)).not.toHaveProperty("resultBytes");
  });

  it("INV-6 INV-8: emits one discrete payload-free change per accepted catalog transition", async () => {
    const events: ToolCallActivityEvent[] = [];
    let tools = [{ name: "read", description: "secret-text" }, { name: "removed" }];
    const c: Connector = { id: "dynamic", listTools: async () => tools, callTool: async () => null };
    const registry = new Registry([c], { storage: memoryStorage(), logger: { debug() {}, info() {}, warn() {}, error() {} }, toolCacheTtlSeconds: 0, catalogDriftActivity: { recordChange: recordCatalogChangeActivity, sink: { record: e => { events.push(e); } }, serverInfo: { name: "test", version: "1" } } });
    await registry.getTools("dynamic", BASE);
    expect(events).toHaveLength(0);
    tools = [{ name: "read", description: "changed-secret" }, { name: "added" }];
    await registry.getTools("dynamic", BASE);
    await registry.getTools("dynamic", BASE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "catalog_drift", source: "catalog_refresh", drift: { kind: "catalog_changed", addedTools: 1, removedTools: 1, changedTools: 1 } });
    expect(events[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(events)).not.toMatch(/secret|removed"|added"/);
  });

  it("INV-6 INV-7: a catalog change and its downstream call share the HTTP request and pool", async () => {
    const events: ToolCallActivityEvent[] = [];
    let description = "Initial catalog";
    const c: Connector = { id: "dynamic", listTools: async () => [{ name: "read", description, annotations: { readOnlyHint: true } }], callTool: async () => ({ ok: true }) };
    const deployment = app({ connectors: [c], logger: "silent", discovery: { catalogTtlSeconds: 0 }, pools: { support: { tools: ["dynamic"], grant: () => true } }, activity: activityHistory({ store: { record: e => { events.push(e); } } }) });
    const call = async () => {
      const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "dynamic.read" } });
      const response = await readJsonRpc(await deployment.fetch(new Request(BASE + "/mcp/support", request)));
      expect(response.result.isError).not.toBe(true);
    };
    await call();
    description = "Changed catalog";
    await call();
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ kind: "catalog_drift", pool: "support", drift: { kind: "catalog_changed", addedTools: 0, removedTools: 0, changedTools: 1 } });
    expect(events[1]?.requestId).toBe(events[2]?.requestId);
    expect(events[0]?.requestId).not.toBe(events[2]?.requestId);
    expect(events[1]?.actor).toEqual(events[2]?.actor);
    expect(JSON.stringify(events)).not.toContain("Changed catalog");
  });


  it("INV-4 INV-6: principal-only API callers cannot read another principal's personal history or ownerless legacy rows", async () => {
    const events: ToolCallActivityEvent[] = [];
    const auth: InboundAuth = { kind: "api", authorize: request => ({ ok: true, principal: { namespace: "directory", id: request.headers.get("X-Principal") ?? "alice" } }) };
    const deployment = app({ connectors: [{ ...connector("personal"), authScope: "personal" }], auth, logger: "silent", identity: { activityAccess: () => true }, activity: activityHistory({ store: { record: e => { events.push(e); }, list: async () => ({ events }) } }) });
    const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "personal.read" } });
    expect((await readJsonRpc(await deployment.fetch(request))).result.isError).not.toBe(true);
    expect(events[0]?.actor).toEqual({ kind: "api", id: "alice", namespace: "directory" });
    events.push(event("legacy", { connectorId: "personal", actor: { kind: "api" } }));
    const read = async (principal: string) => await (await deployment.fetch(new Request(BASE + "/ui/api/activity", { headers: { "X-Principal": principal } }))).json() as { events: ToolCallActivityEvent[] };
    expect((await read("bob")).events).toEqual([]);
    expect((await read("alice")).events.map(e => e.id)).toEqual([events[0]!.id]);
  });

  it("INV-4 INV-6: keeps long configured pool names scoped through recording and disclosure", async () => {
    const events: ToolCallActivityEvent[] = [];
    const pool = "p".repeat(65);
    const auth: InboundAuth = { kind: "api", authorize: request => ({ ok: true, principal: { namespace: "directory", id: request.headers.get("X-Principal") ?? "alice" } }) };
    const deployment = app({ connectors: [connector("visible")], auth, logger: "silent", identity: { activityAccess: () => true }, pools: { [pool]: { tools: ["visible"], grant: identity => identity.principal?.id === "alice" } }, activity: activityHistory({ store: { record: e => { events.push(e); }, list: async () => ({ events }) } }) });
    const request = modernRequest("tools/call", { name: "call_tool", arguments: { address: "visible.read" } });
    expect((await readJsonRpc(await deployment.fetch(new Request(BASE + "/mcp/" + pool, request)))).result.isError).not.toBe(true);
    expect(events[0]?.pool).toBe(pool);
    const read = await deployment.fetch(new Request(BASE + "/ui/api/activity", { headers: { "X-Principal": "bob" } }));
    expect((await read.json() as { events: ToolCallActivityEvent[] }).events).toEqual([]);
  });

  it.each(["/ui/api/config", "/ui/connectors/dynamic"])("INV-7: %s defers pending catalog activity writes through the Workers lifetime hook", async path => {
    let description = "Initial";
    let release!: () => void;
    const writes: Promise<unknown>[] = [];
    const c: Connector = { id: "dynamic", listTools: async () => [{ name: "read", description }], callTool: async () => null };
    const deployment = app({ connectors: [c], logger: "silent", discovery: { catalogTtlSeconds: 0 }, activity: activityHistory({ store: { record: () => new Promise<void>(resolve => { release = resolve; }) } }) });
    expect((await deployment.fetch(new Request(BASE + path))).status).toBe(200);
    description = "Changed";
    const response = await deployment.fetch(new Request(BASE + path), undefined, { waitUntil: pending => { writes.push(pending); } });
    expect(response.status).toBe(200);
    expect(writes.length).toBeGreaterThan(0);
    expect(release).toBeTypeOf("function");
    release(); await Promise.all(writes);
  });

});
