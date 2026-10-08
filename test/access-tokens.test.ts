import { describe, expect, it } from "vitest";
import { accessTokens, AccessTokenManager } from "../src/access-tokens.js";
import { CredentialVault } from "../src/credentials.js";
import { machineAuth } from "./helpers/machine-auth.js";
import { memoryStorage } from "../src/storage/memory.js";
import { authorize } from "../src/routes/shared.js";
import { createTestConnecta } from "./helpers.js";
import { calcApi, fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import fixture from "./fixtures/access-tokens-v023.json";
import type { KVStorage } from "../src/types.js";

const BASE = "https://connecta.test";
const owner = { namespace: "clerk:test", id: "owner" };
const human = { ...fakeClerkAuth({ userId: "owner" }), activityActorNamespace: owner.namespace };
const recordKey = `access-token:v1:record:${fixture.bound.accessToken.id}`;
function request(token: string, path = "/mcp", method = "GET", body?: unknown) {
  return new Request(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: BASE,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function legacyStorage() {
  const storage = memoryStorage();
  for (const [key, value] of Object.entries(fixture.records)) await storage.set(key, value);
  return storage;
}

describe("v0.23 client-token migration", () => {
  it("admits the original secrets with unchanged identity, labels and no storage rewrite", async () => {
    const storage = await legacyStorage();
    const module = accessTokens(storage);
    for (const entry of [fixture.bound, fixture.unbound]) {
      const authz = await authorize(request(entry.token), BASE, [module.auth]);
      expect(authz.ok).toBe(true);
      if (!authz.ok) throw new Error("not admitted");
      expect(authz.actor).toEqual({
        kind: "access_token",
        id: entry.accessToken.id,
        namespace: "connecta:access-tokens:v1",
      });
      expect(authz.identity.interactive).toBe(false);
      expect(authz.identity.principal).toEqual(entry === fixture.bound ? owner : undefined);
      expect(authz.accessTokenManagement).toBe(false);
      expect(authz.credentialAdministration).toBe("none");
      expect(await module.auth.activityActorLabel?.(entry.accessToken.id)).toBe(entry.accessToken.name);
    }
    expect(await storage.list!("access-token:")).toEqual(Object.keys(fixture.records).sort());
    for (const [key, value] of Object.entries(fixture.records)) expect(await storage.get(key)).toBe(value);
  });

  it("INV-11: refuses storage without compareAndSet at construction, as a Workers KV adapter is", async () => {
    const { compareAndSet: _omitted, ...eventual } = await legacyStorage();
    expect(() => accessTokens(eventual as KVStorage)).toThrow(/list and compareAndSet/);
  });

  it.each([fixture.revoked.token, "cta_" + "x".repeat(43), "cta_bad", "", "other-secret"])(
    "refuses revoked, unknown and malformed credentials: %s",
    async (token) => {
      const module = accessTokens(await legacyStorage());
      expect((await module.auth.authorize(request(token), BASE)).ok).toBe(false);
    },
  );

  it.each([
    "not json",
    "null",
    JSON.stringify({
      ...JSON.parse(fixture.records[recordKey as keyof typeof fixture.records]),
      id: fixture.unbound.accessToken.id,
    }),
    JSON.stringify({ ...JSON.parse(fixture.records[recordKey as keyof typeof fixture.records]), revokedAt: "" }),
    JSON.stringify({
      ...JSON.parse(fixture.records[recordKey as keyof typeof fixture.records]),
      principal: { id: "owner" },
    }),
    JSON.stringify({
      ...JSON.parse(fixture.records[recordKey as keyof typeof fixture.records]),
      tokenHash: "0".repeat(64),
    }),
  ])("fails closed on corrupt records", async (raw) => {
    const storage = await legacyStorage();
    await storage.set(recordKey, raw);
    expect((await accessTokens(storage).auth.authorize(request(fixture.bound.token), BASE)).ok).toBe(false);
  });

  it("applies current tool and pool grants to the stored principal on every request", async () => {
    const storage = await legacyStorage();
    let allowed = true;
    const app = createTestConnecta({
      connectors: [calcApi()],
      accessTokens: accessTokens(storage),
      identity: { connectorAccess: ({ principal }) => (allowed && principal?.id === "owner" ? ["calc.add"] : []) },
      pools: { desktop: { tools: ["calc.add"], grant: ({ principal }) => allowed && principal?.id === "owner" } },
    });
    try {
      const list = await readJsonRpc(await mcpRpc(app, "tools/list", {}, { token: fixture.bound.token }));
      expect(list.result.tools).toHaveLength(6);
      const call = () =>
        mcpRpc(
          app,
          "tools/call",
          { name: "call_tool", arguments: { address: "calc.add", args: { a: 2, b: 3 } } },
          { token: fixture.bound.token },
        );
      expect((await readJsonRpc(await call())).result.isError).not.toBe(true);
      const poolRequest = () =>
        new Request(BASE + "/mcp/desktop", mcpRpc("tools/list", {}, { token: fixture.bound.token }));
      expect((await app.fetch(poolRequest())).status).toBe(200);
      allowed = false;
      expect((await readJsonRpc(await call())).result.isError).toBe(true);
      expect((await app.fetch(poolRequest())).status).toBe(404);
      const data = (await (await app.fetch(request(fixture.bound.token, "/ui/data"))).json()) as {
        connectors: unknown[];
      };
      expect(data.connectors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("optional token lifecycle", () => {
  it("creates, shows only once, renames and revokes through the operator routes", async () => {
    const storage = await legacyStorage();
    const app = createTestConnecta({
      connectors: [],
      auth: human,
      accessTokens: accessTokens(storage),
      identity: { accessTokenManagement: () => true },
    });
    try {
      const created = await app.fetch(request("clerk-operator", "/ui/access-tokens", "POST", { name: "New desktop" }));
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toContain("no-store");
      const result = (await created.json()) as { token: string; accessToken: { id: string } };
      expect(result.token).toMatch(/^cta_[A-Za-z0-9_-]{43}$/);
      const manager = new AccessTokenManager(storage);
      expect(await manager.auth.authorize(request(result.token), BASE)).toEqual({
        ok: true,
        subjectId: result.accessToken.id,
        principal: owner,
      });
      const path = `/ui/access-tokens/${result.accessToken.id}`;
      expect((await app.fetch(request("clerk-operator", path, "PUT", { name: "Renamed" }))).status).toBe(200);
      expect(await manager.auth.activityActorLabel?.(result.accessToken.id)).toBe("Renamed");
      const listed = await (await app.fetch(request("clerk-operator", "/ui/access-tokens"))).text();
      expect(listed).not.toContain(result.token);
      expect(listed).not.toContain("tokenHash");
      for (const key of await storage.list!("")) expect(await storage.get(key)).not.toContain(result.token);
      expect((await app.fetch(request("clerk-operator", path, "DELETE"))).status).toBe(200);
      expect((await manager.auth.authorize(request(result.token), BASE)).ok).toBe(false);
      expect(
        (await app.fetch(request("clerk-operator", `/ui/access-tokens/${fixture.bound.accessToken.id}`, "DELETE")))
          .status,
      ).toBe(200);
      expect((await manager.auth.authorize(request(fixture.bound.token), BASE)).ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("denies machine token management, missing permission, cross-origin and oversized writes", async () => {
    const storage = await legacyStorage();
    let permission = false;
    const app = createTestConnecta({
      connectors: [],
      vault: new CredentialVault(storage, btoa("x".repeat(32))),
      auth: [human, machineAuth("static")],
      accessTokens: accessTokens(storage),
      identity: { accessTokenManagement: () => permission },
    });
    try {
      for (const token of ["clerk-operator", "static", fixture.bound.token]) {
        const res = await app.fetch(request(token, "/ui/access-tokens", "POST", { name: "Denied" }));
        expect([401, 403]).toContain(res.status);
      }
      permission = true;
      for (const token of ["static", fixture.bound.token]) {
        expect([401, 403]).toContain((await app.fetch(request(token, "/ui/access-tokens"))).status);
        expect([401, 403]).toContain(
          (await app.fetch(request(token, "/ui/credentials/missing", "PUT", { value: "x" }))).status,
        );
      }
      const foreign = request("clerk-operator", "/ui/access-tokens", "POST", { name: "Denied" });
      foreign.headers.set("Origin", "https://evil.test");
      expect((await app.fetch(foreign)).status).toBe(403);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens", "OPTIONS"))).status).toBe(403);
      expect(
        (await app.fetch(request("clerk-operator", "/ui/access-tokens", "POST", { name: "x".repeat(2000) }))).status,
      ).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("omitting the module leaves token authentication and management unavailable", async () => {
    const app = createTestConnecta({ connectors: [], auth: human });
    try {
      expect((await mcpRpc(app, "tools/list", {}, { token: fixture.bound.token })).status).toBe(401);
      expect((await app.fetch(request("clerk-operator", "/tokens"))).status).toBe(404);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens"))).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("bounds concurrent creation across managers and releases capacity on revocation", async () => {
    const storage = await legacyStorage();
    const managers = Array.from({ length: 8 }, () => new AccessTokenManager(storage, { maxActive: 3 }));
    const created = await Promise.allSettled(managers.map((manager) => manager.create("client", owner)));
    expect(created.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await managers[0]!.revoke(fixture.bound.accessToken.id, "owner");
    await expect(managers[1]!.create("replacement", owner)).resolves.toHaveProperty("token");
  });
});

describe("token lifecycle races", () => {
  it("a stale rename cannot erase a concurrent revocation", async () => {
    const base = await legacyStorage();
    let hold = true;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage: KVStorage = {
      ...base,
      get: async (key) => {
        const raw = await base.get(key);
        if (key === recordKey && hold) {
          hold = false;
          enter();
          await barrier;
        }
        return raw;
      },
    };
    const manager = new AccessTokenManager(storage);
    const rename = manager.rename(fixture.bound.accessToken.id, "Renamed while revoking");
    await entered;
    await new AccessTokenManager(base).revoke(fixture.bound.accessToken.id, "owner");
    release();
    expect((await rename)?.revokedAt).toBeTruthy();
    expect((await manager.auth.authorize(request(fixture.bound.token), BASE)).ok).toBe(false);
  });

  it.each([false, true])("releases capacity after a failed metadata write, committed=%s", async (committed) => {
    const base = memoryStorage();
    let failing = true;
    const storage: KVStorage = {
      ...base,
      set: async (key, value) => {
        if (failing && key.startsWith("access-token:v1:record:")) {
          failing = false;
          if (committed) await base.set(key, value);
          throw new Error("metadata write failed");
        }
        await base.set(key, value);
      },
    };
    const manager = new AccessTokenManager(storage, { maxActive: 1 });
    await expect(manager.create("Interrupted", owner)).rejects.toThrow("metadata write failed");
    expect((await manager.list()).filter((token) => !token.revokedAt)).toEqual([]);
    expect(await base.list!("access-token:v1:lookup:")).toEqual([]);
    const created = await new AccessTokenManager(base, { maxActive: 1 }).create("Replacement", owner);
    expect((await manager.auth.authorize(request(created.token), BASE)).ok).toBe(true);
  });

  it("releases a reservation whose compareAndSet committed before rejecting", async () => {
    const base = memoryStorage();
    let failing = true;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, value) => {
        const committed = await base.compareAndSet!(key, expected, value);
        if (failing && key === "access-token:v1:active" && committed) {
          failing = false;
          throw new Error("reservation answer lost");
        }
        return committed;
      },
    };
    const manager = new AccessTokenManager(storage, { maxActive: 1 });
    await expect(manager.create("Interrupted", owner)).rejects.toThrow("reservation answer lost");
    expect(await manager.list()).toEqual([]);
    await expect(manager.create("Replacement", owner)).resolves.toHaveProperty("token");
  });

  it("keeps capacity and revocable metadata after an uncertain lookup write", async () => {
    const base = memoryStorage();
    const storage: KVStorage = {
      ...base,
      set: async (key, value) => {
        await base.set(key, value);
        if (key.startsWith("access-token:v1:lookup:")) throw new Error("answer lost after commit");
      },
    };
    const manager = new AccessTokenManager(storage, { maxActive: 1 });
    await expect(manager.create("Interrupted", owner)).rejects.toThrow("answer lost");
    await expect(manager.create("Another", owner)).rejects.toThrow("maximum");
    const [token] = await manager.list();
    expect(token).toBeDefined();
    await manager.revoke(token!.id, "owner");
    expect(await base.list!("access-token:v1:lookup:")).toEqual([]);
    await expect(new AccessTokenManager(base, { maxActive: 1 }).create("Replacement", owner)).resolves.toHaveProperty(
      "token",
    );
  });
});
