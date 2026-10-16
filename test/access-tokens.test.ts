import { describe, expect, it } from "vitest";
import { AccessTokenError, accessTokens, AccessTokenManager } from "../src/access-tokens.js";
import { CredentialVault } from "../src/credentials.js";
import { machineAuth, TEST_MACHINE_NAMESPACE } from "./helpers/machine-auth.js";
import { memoryStorage } from "../src/storage/memory.js";
import { authorize, authorizeAgent } from "../src/routes/shared.js";
import { createTestConnecta } from "./helpers.js";
import { calcApi, fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import fixture from "./fixtures/access-tokens-v023.json";
import type { AuthResult, Connector, InboundAuth, KVStorage } from "../src/types.js";

const BASE = "https://connecta.test";
const NAMESPACE = "connecta:access-tokens:v1";
const owner = { namespace: "clerk:test", id: "owner" };
const human = { ...fakeClerkAuth({ userId: "owner" }), activityActorNamespace: owner.namespace };
/** The person behind `human`; a spread fixture is never a default maintainer. */
const maintainers = [owner];
const recordKey = `access-token:v1:record:${fixture.unbound.accessToken.id}`;
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
async function snapshot(storage: KVStorage) {
  const keys = await storage.list("");
  return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await storage.get(key)] as const)));
}
const admits = async (manager: AccessTokenManager, token: string) =>
  (await manager.auth.authorize(request(token), BASE)).ok;
/** A refusal as a caller sees it: status, challenge and body. */
async function refusal(result: AuthResult) {
  if (result.ok) throw new Error("admitted");
  return {
    status: result.response.status,
    challenge: result.response.headers.get("WWW-Authenticate"),
    body: await result.response.text(),
  };
}
/** Hold the first `count` reads of `key` until all of them have started. */
function barrierStorage(base: KVStorage, key: string, count: number): KVStorage {
  let waiting = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ...base,
    get: async (candidate) => {
      const raw = await base.get(candidate);
      if (candidate === key && waiting < count) {
        if (++waiting === count) release();
        await all;
      }
      return raw;
    },
  };
}

describe("declared agents", () => {
  it.each([
    ["simon", /agents must be an array of agent names/],
    [["Simon"], /agents\[0\] must be an agent name/],
    [["build agent"], /agents\[0\] must be an agent name/],
    [[""], /agents\[0\] must be an agent name/],
    [["x".repeat(65)], /agents\[0\] must be an agent name: 1 to 64 characters/],
    [[7], /agents\[0\] must be an agent name/],
    [["simon", "ci", "simon"], /agents\[2\] repeats the agent name "simon"/],
  ])("INV-11: refuses malformed agents at construction: %j", (agents, message) => {
    expect(() =>
      createTestConnecta({ connectors: [], agents: agents as never, accessTokens: accessTokens(memoryStorage()) }),
    ).toThrow(message);
    expect(() => new AccessTokenManager(memoryStorage(), { agents: agents as never })).toThrow(message);
  });

  it("INV-11: refuses agents without accessTokens and the removed maxActive option, naming the replacement", () => {
    expect(() => createTestConnecta({ connectors: [], agents: ["simon"] })).toThrow(
      /ConnectaConfig.agents needs accessTokens: accessTokens\(storage\)/,
    );
    expect(() => accessTokens(memoryStorage(), { maxActive: 3 } as never)).toThrow(
      /accessTokens\(\).maxActive was removed: each agent declared in ConnectaConfig.agents/,
    );
  });

  it("INV-11: refuses storage without compareAndSet at construction, as a Workers KV adapter is", async () => {
    const { compareAndSet: _omitted, ...eventual } = await legacyStorage();
    expect(() => accessTokens(eventual as KVStorage)).toThrow(/list and compareAndSet/);
  });

  it("INV-5: describeConfig lists agent names in order and never token state", async () => {
    const storage = memoryStorage();
    const { token } = await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
    const app = createTestConnecta({ connectors: [], agents: ["simon", "ci"], accessTokens: accessTokens(storage) });
    try {
      const description = app.describeConfig();
      expect(description.agents).toEqual(["simon", "ci"]);
      expect(description.modules.accessTokens).toEqual({ enabled: true });
      const serialized = JSON.stringify(description);
      for (const secret of [token, token.slice(0, 12), "issued", "tokenHash", "access-token:v1"]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });
});

describe("agent token slots", () => {
  it("INV-5: issues, rotates and revokes one slot per declared agent and never lists secret material", async () => {
    const storage = await legacyStorage();
    const app = createTestConnecta({
      connectors: [],
      auth: human,
      maintainers,
      agents: ["simon", "ci"],
      accessTokens: accessTokens(storage),
    });
    const manager = new AccessTokenManager(storage, { agents: ["simon", "ci"] });
    const list = async () => {
      const response = await app.fetch(request("clerk-operator", "/ui/access-tokens"));
      expect(response.headers.get("cache-control")).toContain("no-store");
      return { text: await response.clone().text(), body: (await response.json()) as { agents: unknown[] } };
    };
    try {
      expect((await list()).body).toEqual({
        agents: [
          { name: "simon", state: "none" },
          { name: "ci", state: "none" },
        ],
      });

      const issued = await app.fetch(request("clerk-operator", "/ui/access-tokens/simon", "POST"));
      expect(issued.status).toBe(200);
      expect(issued.headers.get("cache-control")).toContain("no-store");
      const first = (await issued.json()) as { token: string; agent: { name: string; issuedAt: string } };
      expect(first.token).toMatch(/^cta_[A-Za-z0-9_-]{43}$/);
      expect(first.agent).toEqual({ name: "simon", state: "issued", issuedAt: expect.any(String) });
      expect(await admits(manager, first.token)).toBe(true);

      const rotated = (await (
        await app.fetch(request("clerk-operator", "/ui/access-tokens/simon", "POST"))
      ).json()) as { token: string };
      expect(rotated.token).not.toBe(first.token);
      expect(await admits(manager, first.token)).toBe(false);
      expect(await admits(manager, rotated.token)).toBe(true);

      const listed = await list();
      const [simon, ci] = listed.body.agents as Array<Record<string, unknown>>;
      expect(Object.keys(simon!).sort()).toEqual(["issuedAt", "name", "state"]);
      expect(ci).toEqual({ name: "ci", state: "none" });
      for (const secret of [
        first.token,
        rotated.token,
        rotated.token.slice(0, 12),
        "tokenHash",
        "tokenPrefix",
        "tokenId",
      ]) {
        expect(listed.text).not.toContain(secret);
      }
      for (const [, value] of Object.entries(await snapshot(storage))) {
        expect(value).not.toContain(first.token);
        expect(value).not.toContain(rotated.token);
      }

      const revoked = await app.fetch(request("clerk-operator", "/ui/access-tokens/simon", "DELETE"));
      expect(await revoked.json()).toEqual({
        agent: { name: "simon", state: "revoked", revokedAt: expect.any(String) },
      });
      expect(await admits(manager, rotated.token)).toBe(false);
      const reissued = (await (
        await app.fetch(request("clerk-operator", "/ui/access-tokens/simon", "POST"))
      ).json()) as { token: string };
      expect(await admits(manager, reissued.token)).toBe(true);

      // Agents come from code: nothing creates, renames or rebinds one here.
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens/nobody", "POST"))).status).toBe(404);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens", "POST", { name: "x" }))).status).toBe(405);
      expect(
        (await app.fetch(request("clerk-operator", "/ui/access-tokens/simon", "PUT", { name: "renamed" }))).status,
      ).toBe(405);
      expect(
        (await app.fetch(request("clerk-operator", `/ui/access-tokens/${fixture.unbound.accessToken.id}`, "DELETE")))
          .status,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("INV-4: token management is interactive-maintainer only; agents, machines and members are refused", async () => {
    const storage = memoryStorage();
    const agentToken = (await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon")).token;
    const member = { ...fakeClerkAuth({ token: "member", userId: "member" }), activityActorNamespace: owner.namespace };
    const app = createTestConnecta({
      connectors: [calcApi()],
      vault: new CredentialVault(storage, btoa("x".repeat(32))),
      auth: [human, member, machineAuth("static")],
      // The machine principal is a maintainer too, so its refusal is the
      // interactive-user requirement, not the maintainer gate.
      maintainers: [owner, { namespace: TEST_MACHINE_NAMESPACE, id: "machine" }],
      agents: ["simon"],
      accessTokens: accessTokens(storage),
      pools: { team: { tools: ["calc"], members: [{ ...owner, id: "member" }, "agent:simon"] } },
    });
    try {
      // An agent (never a maintainer) and a machine maintainer are refused as
      // non-interactive; a pool member who is not a maintainer gets the
      // private 404 every operator route gives them.
      const expected: Record<string, number> = { static: 403, [agentToken]: 403, member: 404 };
      for (const [token, status] of Object.entries(expected)) {
        expect((await app.fetch(request(token, "/ui/access-tokens/simon", "POST"))).status, token).toBe(status);
        expect((await app.fetch(request(token, "/ui/access-tokens"))).status, token).toBe(status);
        expect((await app.fetch(request(token, "/ui/access-tokens/simon", "DELETE"))).status, token).toBe(status);
      }
      expect(await new AccessTokenManager(storage, { agents: ["simon"] }).list()).toEqual([
        { name: "simon", state: "issued", issuedAt: expect.any(String) },
      ]);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens"))).status).toBe(200);
      const foreign = request("clerk-operator", "/ui/access-tokens/simon", "POST");
      foreign.headers.set("Origin", "https://evil.test");
      expect((await app.fetch(foreign)).status).toBe(403);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens", "OPTIONS"))).status).toBe(403);
      expect(await new AccessTokenManager(storage, { agents: ["simon"] }).list()).toEqual([
        { name: "simon", state: "issued", issuedAt: expect.any(String) },
      ]);
    } finally {
      await app.close();
    }
  });

  it("omitting the module leaves token authentication and management unavailable", async () => {
    const storage = memoryStorage();
    const token = (await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon")).token;
    const app = createTestConnecta({ connectors: [], auth: human, maintainers, storage });
    try {
      expect((await mcpRpc(app, "tools/list", {}, { token })).status).toBe(401);
      expect((await app.fetch(request("clerk-operator", "/tokens"))).status).toBe(404);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens"))).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("rotation and revocation", () => {
  it("INV-4: rotation is an immediate cutover: the old secret refuses on the very next request", async () => {
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon"] });
    const first = await manager.rotate("simon");
    expect(await admits(manager, first.token)).toBe(true);
    const second = await manager.rotate("simon");
    expect(await admits(manager, first.token)).toBe(false);
    expect(await admits(manager, second.token)).toBe(true);
    // The previous lookup stays behind, inert: the slot no longer names it.
    expect(await storage.list("access-token:v1:lookup:")).toHaveLength(2);
  });

  it("INV-4: of concurrent rotations exactly one returns a secret, and it is the only live one", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const storage = barrierStorage(base, "access-token:v1:agent:simon", 6);
    const managers = Array.from({ length: 6 }, () => new AccessTokenManager(storage, { agents: ["simon"] }));
    const results = await Promise.allSettled(managers.map((manager) => manager.rotate("simon")));
    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(AccessTokenError);
        expect((result.reason as AccessTokenError).code).toBe("conflict");
      }
    }
    const winner = (won[0] as PromiseFulfilledResult<{ token: string }>).value.token;
    expect(await admits(seed, winner)).toBe(true);
    expect(await admits(seed, previous.token)).toBe(false);
    // The previous token and the winner; each loser removed its uncommitted pair.
    expect(await base.list("access-token:v1:lookup:")).toHaveLength(2);
  });

  it("INV-4: a revocation racing a rotation leaves no live secret", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const first = await seed.rotate("simon");
    const storage = barrierStorage(base, "access-token:v1:agent:simon", 2);
    const [rotated, revoked] = await Promise.allSettled([
      new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon"),
      new AccessTokenManager(storage, { agents: ["simon"] }).revoke("simon"),
    ]);
    expect(revoked).toMatchObject({ status: "fulfilled", value: { state: "revoked" } });
    if (rotated.status === "fulfilled") expect(await admits(seed, rotated.value.token)).toBe(false);
    // Every lookup that survives is inert: no secret admits.
    expect(await admits(seed, first.token)).toBe(false);
    expect(await seed.list()).toEqual([{ name: "simon", state: "revoked", revokedAt: expect.any(String) }]);
  });

  it("INV-4: revocation is one slot commit and deletes nothing", async () => {
    const base = memoryStorage();
    const manager = new AccessTokenManager(base, { agents: ["simon"] });
    const { token } = await manager.rotate("simon");
    const order: string[] = [];
    const storage: KVStorage = {
      ...base,
      delete: async (key) => {
        order.push(`delete ${key.split(":")[2]}`);
        await base.delete(key);
      },
      compareAndSet: async (key, expected, next, options) => {
        order.push(`swap ${key.split(":")[2]}`);
        return base.compareAndSet(key, expected, next, options);
      },
    };
    await new AccessTokenManager(storage, { agents: ["simon"] }).revoke("simon");
    expect(order).toEqual(["swap agent"]);
    expect(await admits(manager, token)).toBe(false);
    // Nothing is deleted: the record and lookup stay behind, inert.
    expect(await base.list("access-token:v1:lookup:")).toHaveLength(1);
    expect(await base.list("access-token:v1:record:")).toHaveLength(1);
  });

  it("INV-4: an interrupted rotation never leaves a live secret nobody holds", async () => {
    for (const failure of ["lookup", "swap"] as const) {
      const base = memoryStorage();
      const seed = new AccessTokenManager(base, { agents: ["simon"] });
      const previous = await seed.rotate("simon");
      let failing = true;
      const storage: KVStorage = {
        ...base,
        set: async (key, value, options) => {
          await base.set(key, value, options);
          if (failure === "lookup" && failing && key.startsWith("access-token:v1:lookup:")) {
            failing = false;
            throw new Error("answer lost after commit");
          }
        },
        compareAndSet: async (key, expected, next, options) => {
          const committed = await base.compareAndSet(key, expected, next, options);
          if (failure === "swap" && failing && key === "access-token:v1:agent:simon") {
            failing = false;
            throw new Error("answer lost after commit");
          }
          return committed;
        },
      };
      const rotation = new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
      if (failure === "lookup") {
        // Before the commit: nothing is published and the previous token stays.
        await expect(rotation).rejects.toThrow("answer lost");
        expect(await base.list("access-token:v1:lookup:")).toHaveLength(1);
        expect(await admits(seed, previous.token)).toBe(true);
      } else {
        // An unanswered commit is read back: it committed, so the secret is delivered.
        const delivered = await rotation;
        expect(await admits(seed, delivered.token)).toBe(true);
        expect(await admits(seed, previous.token)).toBe(false);
      }
      const recovered = await seed.rotate("simon");
      expect(await admits(seed, recovered.token)).toBe(true);
      expect(await admits(seed, previous.token)).toBe(false);
    }
  });

  it("INV-4: an agent removed from code refuses on the next request with no storage write", async () => {
    const storage = memoryStorage();
    const { token } = await new AccessTokenManager(storage, { agents: ["simon", "ci"] }).rotate("simon");
    const before = await snapshot(storage);
    const writes: string[] = [];
    const watched: KVStorage = {
      ...storage,
      set: async (key, ...rest) => {
        writes.push(key);
        return storage.set(key, ...rest);
      },
      delete: async (key) => {
        writes.push(key);
        return storage.delete(key);
      },
      compareAndSet: async (key, ...rest) => {
        writes.push(key);
        return storage.compareAndSet(key, ...rest);
      },
    };
    const app = createTestConnecta({
      connectors: [calcApi()],
      storage: watched,
      agents: ["ci"],
      accessTokens: accessTokens(watched),
    });
    try {
      expect((await mcpRpc(app, "tools/list", {}, { token })).status).toBe(401);
      expect(writes.filter((key) => key.startsWith("access-token:"))).toEqual([]);
      for (const [key, value] of Object.entries(before)) expect(await storage.get(key)).toBe(value);
    } finally {
      await app.close();
    }
    expect(await admits(new AccessTokenManager(storage, { agents: ["simon"] }), token)).toBe(true);
  });

  it("refuses operations on undeclared agents", async () => {
    const manager = new AccessTokenManager(memoryStorage(), { agents: ["simon"] });
    for (const operation of [
      () => manager.rotate("ci"),
      () => manager.revoke("ci"),
      () => manager.adopt(fixture.unbound.accessToken.id, "ci"),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "unknown_agent" });
    }
  });
});

describe("tokens issued before agents", () => {
  it("INV-4: refuses human-bound, unbound and revoked v0.23 tokens exactly as an unknown token, with no rewrite", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    const unknown = await refusal(await manager.auth.authorize(request("cta_" + "x".repeat(43)), BASE));
    for (const entry of [fixture.bound, fixture.unbound, fixture.revoked]) {
      expect(await refusal(await manager.auth.authorize(request(entry.token), BASE))).toEqual(unknown);
      const authz = await authorizeAgent(request(entry.token, "/agent/pool"), BASE, [manager.auth]);
      expect(authz.ok).toBe(false);
    }
    expect(await storage.list("access-token:")).toEqual(Object.keys(fixture.records).sort());
    for (const [key, value] of Object.entries(fixture.records)) expect(await storage.get(key)).toBe(value);
  });

  it.each(["cta_" + "x".repeat(43), "cta_bad", "", "other-secret"])(
    "refuses unknown and malformed credentials: %s",
    async (token) => {
      const manager = new AccessTokenManager(await legacyStorage(), { agents: ["legacy"] });
      expect(await admits(manager, token)).toBe(false);
    },
  );

  it("INV-4: adopt keeps a legacy token's secret for one agent without rewriting the legacy record", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["legacy", "other"] });
    expect(await manager.adopt(fixture.unbound.accessToken.id, "legacy")).toEqual({
      name: "legacy",
      state: "issued",
      issuedAt: fixture.unbound.accessToken.createdAt,
    });
    const authz = await authorizeAgent(request(fixture.unbound.token, "/agent/pool"), BASE, [manager.auth]);
    expect(authz).toMatchObject({ ok: true, identity: { agent: "legacy" } });
    expect(await storage.get(recordKey)).toBe(fixture.records[recordKey as keyof typeof fixture.records]);
    // Repeating the same adoption is idempotent; anything else is refused.
    await expect(manager.adopt(fixture.unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    for (const [tokenId, agent] of [
      [fixture.unbound.accessToken.id, "other"],
      [fixture.bound.accessToken.id, "other"],
      [fixture.revoked.accessToken.id, "other"],
      ["00000000-0000-4000-8000-000000000000", "other"],
    ] as const) {
      await expect(manager.adopt(tokenId, agent)).rejects.toMatchObject({ code: "not_adoptable" });
    }
    expect(await admits(manager, fixture.bound.token)).toBe(false);
    expect((await manager.unboundTokens()).map((token) => token.id)).not.toContain(fixture.unbound.accessToken.id);
    // An agent whose slot was ever issued is rotated, never adopted into.
    const fresh = new AccessTokenManager(await legacyStorage(), { agents: ["other"] });
    await fresh.rotate("other");
    await expect(fresh.adopt(fixture.unbound.accessToken.id, "other")).rejects.toMatchObject({
      code: "not_adoptable",
    });
    // Rotation after adoption cuts the adopted secret over like any other.
    const replacement = await manager.rotate("legacy");
    expect(await admits(manager, fixture.unbound.token)).toBe(false);
    expect(await admits(manager, replacement.token)).toBe(true);
    await expect(manager.adopt(fixture.unbound.accessToken.id, "other")).rejects.toMatchObject({
      code: "not_adoptable",
    });
  });

  it("INV-4: concurrent adoptions of one token by two agents leave exactly one admitting", async () => {
    const base = await legacyStorage();
    const storage = barrierStorage(base, recordKey, 2);
    const results = await Promise.allSettled(
      (["legacy", "other"] as const).map((agent) =>
        new AccessTokenManager(storage, { agents: ["legacy", "other"] }).adopt(fixture.unbound.accessToken.id, agent),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const manager = new AccessTokenManager(base, { agents: ["legacy", "other"] });
    // The adoption claim admits one agent; the other never reaches its commit.
    expect((await manager.list()).map((slot) => slot.state).sort()).toEqual(["issued", "none"]);
    expect(await admits(manager, fixture.unbound.token)).toBe(true);
  });

  it("INV-4: fails closed on a corrupt, unbound or rebound record after adoption", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["legacy", "other"] });
    await manager.adopt(fixture.unbound.accessToken.id, "legacy");
    const adoptedKey = `access-token:v1:record:${JSON.parse((await storage.get("access-token:v1:agent:legacy"))!).tokenId}`;
    const adopted = (await storage.get(adoptedKey))!;
    const record = JSON.parse(adopted) as Record<string, unknown>;
    const { agent: _agent, ...unbound } = record;
    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ ...record, id: fixture.bound.accessToken.id }),
      JSON.stringify({ ...record, revokedAt: "" }),
      JSON.stringify({ ...record, revokedAt: "2026-10-01T00:00:00.000Z" }),
      JSON.stringify({ ...record, agent: "Not An Agent" }),
      JSON.stringify({ ...record, agent: "other" }),
      JSON.stringify({ ...record, principal: owner }),
      JSON.stringify({ ...record, tokenHash: "0".repeat(64) }),
      JSON.stringify(unbound),
    ]) {
      await storage.set(adoptedKey, raw);
      expect(await admits(manager, fixture.unbound.token), raw).toBe(false);
    }
    await storage.set(adoptedKey, adopted);
    expect(await admits(manager, fixture.unbound.token)).toBe(true);
  });

  it("INV-4: fails closed on a corrupt agent slot", async () => {
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon"] });
    const { token } = await manager.rotate("simon");
    const slot = JSON.parse((await storage.get("access-token:v1:agent:simon"))!) as Record<string, unknown>;
    for (const raw of [
      "not json",
      JSON.stringify({ ...slot, agent: "ci" }),
      JSON.stringify({ ...slot, state: "live" }),
    ]) {
      await storage.set("access-token:v1:agent:simon", raw);
      expect(await admits(manager, token)).toBe(false);
    }
  });
});

describe("agent identity", () => {
  it("INV-4: an admitted agent carries identity.agent, an agent subject and actor, and no principal", async () => {
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon"] });
    const { token } = await manager.rotate("simon");
    const authz = await authorizeAgent(request(token, "/agent/pool"), BASE, [manager.auth, human]);
    if (!authz.ok) throw new Error("not admitted");
    // Human endpoints refuse the same token outright.
    expect((await authorize(request(token), BASE, [manager.auth, human])).ok).toBe(false);
    expect(authz.identity).toEqual({
      actor: { kind: "access_token", id: "simon", namespace: NAMESPACE },
      subject: { namespace: NAMESPACE, id: "agent:simon" },
      agent: "simon",
      interactive: false,
    });
    expect(authz.actor).toEqual({ kind: "access_token", id: "simon", namespace: NAMESPACE });
    expect(authz.subjectKey).toEqual(expect.any(String));
    expect(authz.principalKey).toBeUndefined();
    expect(await manager.auth.activityActorLabel?.("simon")).toBe("simon");
    expect(await manager.auth.activityActorLabel?.(fixture.unbound.accessToken.id)).toBeUndefined();
  });

  it("INV-4: an agent claim from any other inbound provider is refused like an unknown token", async () => {
    const claim = (kind: string, extra: Partial<Extract<AuthResult, { ok: true }>> = {}): InboundAuth => ({
      kind,
      recognizesCredential: (candidate) => candidate.headers.get("authorization") === "Bearer custom",
      authorize: () => ({ ok: true, subjectId: "service", agent: "simon", ...extra }),
    });
    for (const provider of [claim("custom"), claim("access_token"), claim("custom", { principal: owner })]) {
      const authz = await authorize(request("custom"), BASE, [provider]);
      expect(authz.ok).toBe(false);
      if (!authz.ok) expect(authz.response.status).toBe(401);
      const app = createTestConnecta({ connectors: [calcApi()], auth: provider, maintainers });
      try {
        expect((await mcpRpc(app, "tools/list", {}, { token: "custom" })).status).toBe(401);
      } finally {
        await app.close();
      }
    }
    // Without the claim the same provider is admitted, so the claim is what refuses.
    const plain: InboundAuth = { ...claim("custom"), authorize: () => ({ ok: true, subjectId: "service" }) };
    expect((await authorize(request("custom"), BASE, [plain])).ok).toBe(true);
  });

  it("INV-4: pool members recognize agents by identity.agent at /agent/<pool>, and an agent never opens /mcp or /mcp/<pool>", async () => {
    const storage = memoryStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon", "ci"] });
    const simon = (await manager.rotate("simon")).token;
    const ci = (await manager.rotate("ci")).token;
    const config = {
      connectors: [calcApi()],
      auth: human,
      maintainers,
      agents: ["simon", "ci"],
      accessTokens: accessTokens(storage),
      pools: { desktop: { tools: ["calc.add"], members: ["agent:simon"] } },
    };
    expect(() => createTestConnecta({ ...config, maintainers: ["owner", "agent:simon"] })).toThrow(
      "ConnectaConfig.maintainers[1] is an agent. Agents are never maintainers",
    );
    const app = createTestConnecta(config);
    try {
      const call = (token: string, options: { pool?: string; agentPool?: string } = {}) =>
        mcpRpc(
          app,
          "tools/call",
          { name: "call_tool", arguments: { address: "calc.add", args: { a: 2, b: 3 } } },
          { token, ...options },
        );
      const served = await call(simon, { agentPool: "desktop" });
      expect(served.status).toBe(200);
      expect((await readJsonRpc(served)).result.isError).not.toBe(true);
      // A non-member agent and the maintainer outside the pool's members get
      // the one endpoint-not-found refusal.
      const notFound = { jsonrpc: "2.0", error: { code: -33004, message: "MCP endpoint not found." } };
      for (const response of [
        await call(ci, { agentPool: "desktop" }),
        await call("clerk-operator", { pool: "desktop" }),
      ]) {
        expect(response.status).toBe(404);
        expect(await readJsonRpc(response)).toMatchObject(notFound);
      }
      // Human endpoints refuse agent tokens, and agent endpoints refuse people.
      for (const response of [
        await call(simon),
        await call(simon, { pool: "desktop" }),
        await call(ci),
        await call("clerk-operator", { agentPool: "desktop" }),
      ]) {
        expect(response.status).toBe(401);
      }
      expect((await call("clerk-operator")).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("INV-5: an agent has no principal, so personal connectors are absent for it", async () => {
    const storage = memoryStorage();
    const { token } = await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
    const personal: Connector = {
      id: "mine",
      description: "Mine — personal records",
      authScope: "personal",
      listTools: async () => [
        {
          name: "read",
          description: "Read mine",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      callTool: async () => ({ content: [{ type: "text", text: "personal data" }] }),
    };
    const app = createTestConnecta({
      connectors: [calcApi(), personal],
      auth: human,
      maintainers,
      agents: ["simon"],
      accessTokens: accessTokens(storage),
      // The agent and the person share one pool that declares the personal connector.
      pools: { shared: { tools: ["calc", "mine"], members: ["agent:simon", "owner"] } },
    });
    try {
      const call = (address: string, credential: string) =>
        mcpRpc(
          app,
          "tools/call",
          { name: "call_tool", arguments: { address, args: {} } },
          { token: credential, ...(credential === token ? { agentPool: "shared" } : { pool: "shared" }) },
        );
      const denied = await readJsonRpc(await call("mine.read", token));
      expect(denied.result.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("personal data");
      const search = await readJsonRpc(
        await mcpRpc(
          app,
          "tools/call",
          { name: "search_tools", arguments: { query: "read" } },
          { token, agentPool: "shared" },
        ),
      );
      expect(JSON.stringify(search)).not.toContain("mine");
      // The same connector is there for a human with a principal.
      expect(JSON.stringify(await readJsonRpc(await call("mine.read", "clerk-operator")))).toContain("personal data");
    } finally {
      await app.close();
    }
  });

  it("INV-6: activity attributes an agent's calls to its name and records no payload or token", async () => {
    const storage = memoryStorage();
    const { token } = await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
    const recorded: unknown[] = [];
    const { activityHistory } = await import("../src/activity.js");
    const app = createTestConnecta({
      connectors: [calcApi()],
      agents: ["simon"],
      accessTokens: accessTokens(storage),
      pools: { desktop: { tools: ["calc"], members: ["agent:simon"] } },
      activity: activityHistory({ store: { record: (event) => void recorded.push(event) } }),
    });
    try {
      await readJsonRpc(
        await mcpRpc(
          app,
          "tools/call",
          { name: "call_tool", arguments: { address: "calc.add", args: { a: 4242, b: 1717 } } },
          { token, agentPool: "desktop" },
        ),
      );
      await expect.poll(() => recorded.length).toBeGreaterThan(0);
      expect(recorded[0]).toMatchObject({ actor: { kind: "access_token", id: "simon", namespace: NAMESPACE } });
      const rows = JSON.stringify(recorded);
      // Neither the arguments, the result, the secret nor its digest reach activity.
      for (const payload of ["4242", "1717", "5959", token, token.slice(0, 12)]) expect(rows).not.toContain(payload);
    } finally {
      await app.close();
    }
  });
});
