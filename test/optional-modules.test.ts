import { describe, expect, it, vi } from "vitest";
import { createConnecta, type ConnectaIdentityConfig, type Connector, type KVStorage } from "../src/index.js";
import { required } from "./helpers.js";
import { operatorUi } from "../src/ui.js";
import { activityHistory } from "../src/activity.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { authorize } from "../src/routes/shared.js";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";

const BASE = "https://connecta.test";
const executor = { execute: async () => ({ result: null }) };
const auth = { ...fakeClerkAuth({ token: "human" }), activityActorNamespace: "test-humans" };
const headers = { Authorization: "Bearer human", Origin: BASE, "Content-Type": "application/json" };
function connector(id = "shared", personal = false): Connector {
  return { id, authScope: personal ? "personal" : "shared", credential: { label: "API key" }, listTools: vi.fn(async () => []), callTool: async () => null, status: vi.fn(async () => ({ state: "ok" as const })) };
}
function deployment(identity?: ConnectaIdentityConfig) {
  const storage = memoryStorage();
  return createConnecta({ connectors: [connector(), connector("personal", true)], executor, logger: "silent", auth, publicUrl: BASE, storage, vault: encryptedCredentialVault(storage, btoa("a".repeat(32))), ui: operatorUi(), ...(identity ? { identity } : {}) });
}

describe("optional deployment modules", () => {
  it("omits all UI routes while core health and OAuth callbacks remain available", async () => {
    const app = createConnecta({ connectors: [], executor, logger: "silent" });
    for (const path of ["/", "/credentials", "/tokens", "/activity", "/ui", "/ui/data", "/ui/oauth/missing", "/favicon.svg"]) {
      expect((await app.fetch(new Request(BASE + path))).status, path).toBe(404);
    }
    expect((await app.fetch(new Request(BASE + "/health"))).status).toBe(200);
    const callback = await app.fetch(new Request(BASE + "/oauth/callback/missing"));
    expect(callback.status).toBe(400);
    expect(await callback.text()).not.toContain('href="/"');
  });

  it("omits vault and history routes independently while UI remains enabled", async () => {
    const app = createConnecta({ connectors: [connector()], executor, auth, ui: operatorUi(), logger: "silent" });
    for (const path of ["/ui/credentials/shared", "/ui/activity", "/activity"]) {
      expect((await app.fetch(new Request(BASE + path, { headers }))).status).toBe(404);
    }
    expect((await app.fetch(new Request(BASE + "/", { headers }))).status).toBe(200);
  });

  it.each([
    { ui: false, vault: false },
    { ui: false, vault: true },
    { ui: true, vault: false },
  ])("offers no credential handoff when a recovery module is missing (%j)", async modules => {
    const storage = memoryStorage();
    const app = createConnecta({
      connectors: [connector()], executor, auth, logger: "silent", publicUrl: BASE,
      ...(modules.ui ? { ui: operatorUi() } : {}),
      ...(modules.vault ? { vault: encryptedCredentialVault(storage, btoa("a".repeat(32))) } : {}),
    });
    const response = await mcpRpc(app, "tools/call", {
      name: "authorize_connector", arguments: { connector: "shared" },
    }, { baseUrl: BASE, token: "human" });
    const body = await response.json() as any;
    const recovery = JSON.parse(body.result.content[0].text);
    expect(recovery).toMatchObject({ connector: "shared", recovery: "unavailable" });
    expect(recovery).not.toHaveProperty("operatorUrl");
    expect(recovery.message).toContain("vault and ui");
  });

  it("returns configured connections without touching provider status or tools", async () => {
    const slow = connector("slow"), fast = connector("fast");
    slow.status = vi.fn(() => new Promise<never>(() => {}));
    const app = createConnecta({ connectors: [slow, fast], executor, auth, ui: operatorUi(), logger: "silent", discovery: { probeTimeoutMs: 20 } });
    const list = await app.fetch(new Request(BASE + "/ui/data", { headers }));
    expect((await list.json() as any).connectors.map((c: any) => c.status)).toEqual(["loading", "loading"]);
    expect(slow.status).not.toHaveBeenCalled();
    expect(fast.listTools).not.toHaveBeenCalled();
    const pending = app.fetch(new Request(BASE + "/ui/connectors/slow", { headers }));
    const ready = await app.fetch(new Request(BASE + "/ui/connectors/fast", { headers }));
    expect((await ready.json() as any).status).toBe("ok");
    expect((await (await pending).json() as any).status).toBe("error");
  });

  it("bounds a stalled vault read and closes the connector request scope", async () => {
    const c = connector();
    c.closeScope = vi.fn(async () => {});
    const vault = encryptedCredentialVault(memoryStorage(), btoa("a".repeat(32)));
    let release!: () => void;
    vault.getAll = () => new Promise(resolve => { release = () => resolve(null); });
    const app = createConnecta({ connectors: [c], executor, auth, ui: operatorUi(), vault, logger: "silent", identity: { credentialAdministration: () => "all" }, discovery: { probeTimeoutMs: 10 } });
    const response = await app.fetch(new Request(BASE + "/ui/connectors/shared", { headers }));
    expect((await response.json() as any).status).toBe("error");
    expect(c.closeScope).toHaveBeenCalledOnce();
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(c.status).not.toHaveBeenCalled();
    expect(c.closeScope).toHaveBeenCalledOnce();
  });

  it("defaults both auth management permissions to none and hides secret metadata", async () => {
    const app = deployment();
    for (const id of ["shared", "personal"]) {
      const response = await app.fetch(new Request(`${BASE}/ui/credentials/${id}`, { method: "PUT", headers, body: JSON.stringify({ value: "private-key-value" }) }));
      expect(response.status).toBe(403);
      const detail = await app.fetch(new Request(`${BASE}/ui/connectors/${id}`, { headers }));
      expect(await detail.json()).not.toHaveProperty("credential");
    }
  });

  it("grants shared and personal auth management independently of use", async () => {
    const app = deployment({ credentialAdministration: () => ["shared"] });
    const put = (id: string) => app.fetch(new Request(`${BASE}/ui/credentials/${id}`, { method: "PUT", headers, body: JSON.stringify({ value: "private-key-value" }) }));
    expect((await put("shared")).status).toBe(200);
    expect((await put("personal")).status).toBe(403);
    const invalid = deployment({ credentialAdministration: () => ["typo"] });
    expect((await invalid.fetch(new Request(BASE + "/ui/data", { headers }))).status).toBe(403);
  });

  it.each([
    { connectorAccess: () => undefined },
    { connectorAccess: () => null },
    { activityAccess: () => "false" },
    { activityAccess: () => ({}) },
    { personalConnection: () => undefined },
    { credentialAdministration: () => ["invalid.id"] },
    { connectorAccess: () => { throw new Error("resolver failed"); } },
  ])("fails closed on invalid resolver results", async identity => {
    const result = await authorize(new Request(BASE, { headers }), BASE, [auth], undefined, identity as unknown as ConnectaIdentityConfig);
    expect(result.ok).toBe(false);
  });

  it("allows authorized MCP OAuth initiation and completion with no UI", async () => {
    const oauth: Connector = { ...connector("oauth"), startAuth: vi.fn(async () => ({ state: "auth_required" as const, authorizationUrl: BASE + "/consent?state=state" })), verifyState: async state => state === "state", finishAuth: vi.fn(async () => {}) };
    const app = createConnecta({ connectors: [oauth], executor, auth, logger: "silent", publicUrl: BASE, identity: { credentialAdministration: () => "all" } });
    const response = await mcpRpc(app, "tools/call", { name: "authorize_connector", arguments: { connector: "oauth" } }, { baseUrl: BASE, token: "human" });
    expect(await response.text()).toContain("authorizationUrl");
    expect(oauth.startAuth).toHaveBeenCalledOnce();
    const callback = await app.fetch(new Request(BASE + "/oauth/callback/oauth?code=code&state=state"));
    expect(callback.status).toBe(200);
    expect(oauth.finishAuth).toHaveBeenCalledOnce();
    expect(await callback.text()).not.toContain('href="/"');
  });

  it.each([true, false])("keeps shared OAuth capability after details load for a namespaced human (admin=%s)", async admin => {
    const oauth: Connector = {
      ...connector("oauth"),
      startAuth: vi.fn(async () => ({ state: "ok" as const })),
      disconnectAuth: vi.fn(async () => {}),
    };
    const app = createConnecta({
      connectors: [oauth],
      executor,
      auth,
      ui: operatorUi(),
      logger: "silent",
      identity: { credentialAdministration: () => admin ? "all" : "none" },
    });
    const list = await app.fetch(new Request(BASE + "/ui/data", { headers }));
    const configured = (await list.json() as any).connectors[0];
    const details = await app.fetch(new Request(BASE + "/ui/connectors/oauth", { headers }));
    const loaded = await details.json();
    const expected = {
      oauth: true,
      permissions: { use: true, manageSharedAuth: admin, connectPersonal: false },
    };
    expect(configured).toMatchObject(expected);
    expect(loaded).toMatchObject(expected);
    expect(oauth.startAuth).not.toHaveBeenCalled();
    expect(oauth.disconnectAuth).not.toHaveBeenCalled();
  });

  it("never starts OAuth for a use-only identity or a revoked browser grant", async () => {
    const oauth: Connector = { ...connector("oauth"), startAuth: vi.fn(async () => ({ state: "ok" as const })), verifyState: async () => true, finishAuth: vi.fn(async () => {}) };
    const app = createConnecta({ connectors: [oauth], executor, auth, logger: "silent", publicUrl: BASE });
    const response = await mcpRpc(app, "tools/call", { name: "authorize_connector", arguments: { connector: "oauth" } }, { baseUrl: BASE, token: "human" });
    expect(await response.text()).toContain("not permitted");
    expect(oauth.startAuth).not.toHaveBeenCalled();
    expect((await app.fetch(new Request(BASE + "/oauth/callback/oauth?code=code&state=state", { headers }))).status).toBe(400);
    expect(oauth.finishAuth).not.toHaveBeenCalled();
  });

  it("refuses passive consent writes while preserving pending state", async () => {
    const storage = memoryStorage();
    const active = new KvOAuthProvider("oauth", storage, BASE, undefined, true);
    const state = await active.state();
    await active.saveCodeVerifier("original");
    const passive = new KvOAuthProvider("oauth", storage, BASE, undefined, false);
    await expect(passive.state()).rejects.toThrow("Authorization required");
    await expect(passive.saveCodeVerifier("replacement")).rejects.toThrow("Authorization required");
    await expect(passive.redirectToAuthorization(new URL(BASE))).rejects.toThrow("Authorization required");
    expect(await active.verifyState(state)).toBe(true);
    expect(await active.codeVerifier()).toBe("original");
  });

  it("mounts activity only with a reader and enforces interactive access", async () => {
    const app = createConnecta({ connectors: [], executor, auth, ui: operatorUi(), activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }), logger: "silent" });
    expect((await app.fetch(new Request(BASE + "/ui/activity", { headers }))).status).toBe(200);
    const denied = createConnecta({ connectors: [], executor, auth, ui: operatorUi(), activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }), identity: { activityAccess: () => false }, logger: "silent" });
    expect((await denied.fetch(new Request(BASE + "/ui/activity", { headers }))).status).toBe(403);
  });

  it("does no artifact work when the artifacts module is omitted", async () => {
    const keys: string[] = [];
    const inner = memoryStorage();
    const spy: KVStorage = {
      get: (key) => (keys.push(key), inner.get(key)),
      set: (key, value, opts) => (keys.push(key), inner.set(key, value, opts)),
      delete: (key) => (keys.push(key), inner.delete(key)),
      list: (prefix) => (keys.push(prefix), required(inner.list)(prefix)),
      compareAndSet: (key, expected, next, opts) => (keys.push(key), required(inner.compareAndSet)(key, expected, next, opts)),
    };
    const app = createConnecta({ connectors: [connector()], executor, auth, ui: operatorUi(), storage: spy, publicUrl: BASE, logger: "silent" });
    expect(app.registry.listConnectors().map((c) => c.id)).toEqual(["shared"]);
    const rpc = async (name: string, args: Record<string, unknown>) =>
      JSON.stringify(await readJsonRpc(await mcpRpc(app, "tools/call", { name, arguments: args }, { baseUrl: BASE, token: "human" })));
    expect(await rpc("search_tools", { query: "artifact" })).not.toContain("artifacts.");
    expect(await rpc("skills", {})).not.toContain("connector:artifacts");
    expect(await rpc("call_tool", { address: "artifacts.list_artifacts", args: {} })).toContain("unknown_address");
    await app.fetch(new Request(BASE + "/ui/data", { headers }));
    await app.fetch(new Request(BASE + "/ui/connectors/shared", { headers }));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => key.includes("artifact"))).toEqual([]);
  });
});
