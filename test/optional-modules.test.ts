import { afterEach, describe, expect, it, vi } from "vitest";
import { customExecutor, createConnecta, type Connector } from "../src/index.js";
import { operatorUi } from "../src/ui.js";
import { activityHistory } from "../src/activity.js";
import { encryptedCredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";

const BASE = "https://connecta.test";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
const auth = { ...fakeClerkAuth({ token: "human" }), activityActorNamespace: "test-humans" };
// The spread copy is not a registered test fixture, so it names its maintainer (#837).
const maintainers = ["user_operator"];
const headers = { Authorization: "Bearer human", Origin: BASE, "Content-Type": "application/json" };
function connector(id = "shared", personal = false): Connector {
  return {
    id,
    authScope: personal ? "personal" : "shared",
    credential: { label: "API key" },
    listTools: vi.fn(async () => []),
    callTool: async () => null,
    status: vi.fn(async () => ({ state: "ok" as const })),
  };
}

describe("optional deployment modules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits all UI routes while core health and OAuth callbacks remain available", async () => {
    const app = createConnecta({ readOnly: false, connectors: [], executor, logger: "silent" });
    for (const path of [
      "/",
      "/credentials",
      "/tokens",
      "/activity",
      "/ui",
      "/ui/data",
      "/ui/oauth/missing",
      "/favicon.svg",
    ]) {
      expect((await app.fetch(new Request(BASE + path))).status, path).toBe(404);
    }
    expect((await app.fetch(new Request(BASE + "/health"))).status).toBe(200);
    const callback = await app.fetch(new Request(BASE + "/oauth/callback/missing"));
    expect(callback.status).toBe(400);
    expect(await callback.text()).not.toContain('href="/"');
  });

  it.each([
    { ui: false, vault: true },
    { ui: true, vault: false },
  ])("offers no credential handoff when a recovery module is missing (%j)", async (modules) => {
    const storage = memoryStorage();
    const app = createConnecta({
      readOnly: false,
      connectors: [connector()],
      executor,
      auth,
      maintainers,
      logger: "silent",
      publicUrl: BASE,
      ...(modules.ui ? { ui: operatorUi() } : {}),
      ...(modules.vault ? { vault: encryptedCredentialVault(storage, btoa("a".repeat(32))) } : {}),
    });
    const response = await mcpRpc(
      app,
      "tools/call",
      {
        name: "authorize_connector",
        arguments: { connector: "shared" },
      },
      { baseUrl: BASE, token: "human" },
    );
    const body = (await response.json()) as any;
    const recovery = JSON.parse(body.result.content[0].text);
    expect(recovery).toMatchObject({ connector: "shared", recovery: "unavailable" });
    expect(recovery).not.toHaveProperty("operatorUrl");
    expect(recovery.message).toContain("vault and ui");
  });

  it("returns configured connections without touching provider status or tools", async () => {
    // A fake clock: the probe deadline is what ends the slow status, and on a
    // loaded host a real 20ms one could end the fast status first.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const slow = connector("slow"),
      fast = connector("fast");
    delete slow.credential;
    delete fast.credential;
    slow.status = vi.fn(() => new Promise<never>(() => {}));
    slow.closeScope = vi.fn(async () => {});
    const app = createConnecta({
      readOnly: false,
      connectors: [slow, fast],
      executor,
      auth,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
      discovery: { probeTimeoutMs: 20 },
    });
    const list = await app.fetch(new Request(BASE + "/ui/data", { headers }));
    expect(((await list.json()) as any).connectors.map((c: any) => c.status)).toEqual(["loading", "loading"]);
    expect(slow.status).not.toHaveBeenCalled();
    expect(fast.listTools).not.toHaveBeenCalled();
    let settled = false;
    const pending = app.fetch(new Request(BASE + "/ui/connectors/slow", { headers }));
    void pending.finally(() => {
      settled = true;
    });
    const ready = await app.fetch(new Request(BASE + "/ui/connectors/fast", { headers }));
    expect(((await ready.json()) as any).status).toBe("ok");
    // Identity hashing during authorization can let the fast request overtake
    // the slow one. Wait for its probe timer without moving the fake clock:
    // waitFor's default interval would advance it by 50ms on every poll.
    const beforeProbe = Date.now();
    await vi.waitFor(
      () => {
        expect(slow.status).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(1);
      },
      { interval: 0 },
    );
    expect(Date.now()).toBe(beforeProbe);
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    expect(slow.closeScope).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Await the response's finalizers and Promise handlers at the same 20ms.
    const response = await pending;
    expect(settled).toBe(true);
    expect(Date.now() - beforeProbe).toBe(20);
    expect(((await response.json()) as any).status).toBe("error");
    expect(slow.closeScope).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled vault read and closes the connector request scope", async () => {
    const c = connector();
    c.closeScope = vi.fn(async () => {});
    const vault = encryptedCredentialVault(memoryStorage(), btoa("a".repeat(32)));
    let release!: () => void;
    vault.getAll = () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      });
    const app = createConnecta({
      readOnly: false,
      connectors: [c],
      executor,
      auth,
      maintainers,
      ui: operatorUi(),
      vault,
      logger: "silent",
      discovery: { probeTimeoutMs: 10 },
    });
    const response = await app.fetch(new Request(BASE + "/ui/connectors/shared", { headers }));
    expect(((await response.json()) as any).status).toBe("error");
    expect(c.closeScope).toHaveBeenCalledOnce();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.status).not.toHaveBeenCalled();
    expect(c.closeScope).toHaveBeenCalledOnce();
  });

  it("allows authorized MCP OAuth initiation and completion with no UI", async () => {
    const oauth: Connector = {
      ...connector("oauth"),
      startAuth: vi.fn(async () => ({
        state: "auth_required" as const,
        authorizationUrl: BASE + "/consent?state=state",
      })),
      verifyState: async (state) => state === "state",
      finishAuth: vi.fn(async () => {}),
    };
    const app = createConnecta({
      readOnly: false,
      connectors: [oauth],
      executor,
      auth,
      maintainers,
      vault: encryptedCredentialVault(memoryStorage(), btoa("a".repeat(32))),
      logger: "silent",
      publicUrl: BASE,
    });
    const response = await mcpRpc(
      app,
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "oauth" } },
      { baseUrl: BASE, token: "human" },
    );
    const rpc = await readJsonRpc(response);
    const link = JSON.parse(rpc.result.content[0].text).authorizationUrl;
    expect(link).toContain("/connect/oauth?h=");
    expect(oauth.startAuth).not.toHaveBeenCalled();
    expect((await app.fetch(new Request(link, { headers }))).status).toBe(302);
    expect(oauth.startAuth).toHaveBeenCalledOnce();
    const callback = await app.fetch(new Request(BASE + "/oauth/callback/oauth?code=code&state=state", { headers }));
    expect(callback.status).toBe(200);
    expect(oauth.finishAuth).toHaveBeenCalledOnce();
    expect(await callback.text()).not.toContain('href="/"');
  });

  it("keeps shared OAuth capability after details load for a namespaced maintainer", async () => {
    const oauth: Connector = {
      ...connector("oauth"),
      startAuth: vi.fn(async () => ({ state: "ok" as const })),
      disconnectAuth: vi.fn(async () => {}),
    };
    const app = createConnecta({
      readOnly: false,
      connectors: [oauth],
      executor,
      auth,
      maintainers,
      ui: operatorUi(),
      logger: "silent",
    });
    const list = await app.fetch(new Request(BASE + "/ui/data", { headers }));
    const configured = ((await list.json()) as any).connectors[0];
    const details = await app.fetch(new Request(BASE + "/ui/connectors/oauth", { headers }));
    const loaded = await details.json();
    const expected = {
      oauth: true,
      permissions: { use: true, manageSharedAuth: true, connectPersonal: false },
    };
    expect(configured).toMatchObject(expected);
    expect(loaded).toMatchObject(expected);
    expect(oauth.startAuth).not.toHaveBeenCalled();
    expect(oauth.disconnectAuth).not.toHaveBeenCalled();
  });

  it("INV-4: never starts shared OAuth for a pool member who is not a maintainer", async () => {
    const oauth: Connector = {
      ...connector("oauth"),
      startAuth: vi.fn(async () => ({ state: "ok" as const })),
      verifyState: async () => true,
      finishAuth: vi.fn(async () => {}),
    };
    const app = createConnecta({
      readOnly: false,
      connectors: [oauth],
      executor,
      auth,
      maintainers: ["user_maintainer"],
      pools: { team: { tools: ["oauth"], members: ["user_operator"] } },
      vault: encryptedCredentialVault(memoryStorage(), btoa("a".repeat(32))),
      logger: "silent",
      publicUrl: BASE,
    });
    const response = await mcpRpc(
      app,
      "tools/call",
      { name: "authorize_connector", arguments: { connector: "oauth" } },
      { baseUrl: BASE, token: "human", pool: "team" },
    );
    expect(await response.text()).toContain("not permitted");
    expect(oauth.startAuth).not.toHaveBeenCalled();
    expect(
      (await app.fetch(new Request(BASE + "/oauth/callback/oauth?code=code&state=state", { headers }))).status,
    ).toBe(400);
    expect(oauth.finishAuth).not.toHaveBeenCalled();
  });

  it("INV-10: refuses passive consent writes while preserving pending state", async () => {
    const storage = memoryStorage();
    const active = new KvOAuthProvider("oauth", storage, BASE, undefined, true);
    const state = await active.state();
    await active.saveCodeVerifier("original");
    await active.redirectToAuthorization(new URL(`${BASE}/authorize?state=${state}`));
    const pending = await storage.list("");
    const passive = new KvOAuthProvider("oauth", storage, BASE, undefined, false);
    await expect(passive.state()).rejects.toThrow("Authorization required");
    await expect(passive.saveCodeVerifier("replacement")).rejects.toThrow("Authorization required");
    await expect(passive.redirectToAuthorization(new URL(BASE))).rejects.toThrow("Authorization required");
    expect(await storage.list("")).toEqual(pending);
    const callback = new KvOAuthProvider("oauth", storage, BASE, undefined, false);
    expect(await callback.verifyState(state)).toBe(true);
    expect(await callback.codeVerifier()).toBe("original");
  });

  it("INV-4: mounts activity only with a reader and admits maintainers alone", async () => {
    const app = createConnecta({
      readOnly: false,
      connectors: [],
      executor,
      auth,
      maintainers,
      ui: operatorUi(),
      activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
      logger: "silent",
    });
    expect((await app.fetch(new Request(BASE + "/ui/activity", { headers }))).status).toBe(200);
    const denied = createConnecta({
      readOnly: false,
      connectors: [connector()],
      executor,
      auth,
      maintainers: ["user_maintainer"],
      pools: { team: { tools: ["shared"], members: ["user_operator"] } },
      ui: operatorUi(),
      activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
      logger: "silent",
    });
    const refused = await denied.fetch(new Request(BASE + "/ui/activity", { headers }));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not found" });
  });
});
