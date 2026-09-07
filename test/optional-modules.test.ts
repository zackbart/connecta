import { describe, expect, it, vi } from "vitest";
import { createConnecta, type ConnectaIdentityConfig, type Connector } from "../src/index.js";
import { operatorUi } from "../src/ui.js";
import { activityHistory } from "../src/activity.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { fakeClerkAuth, mcpRpc } from "./fixtures/http.js";
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
});
