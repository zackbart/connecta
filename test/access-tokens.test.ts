import { describe, expect, it, vi } from "vitest";
import { AccessTokenError, AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { CredentialVault } from "../src/credentials.js";
import { authorize, authorizeAgent } from "../src/routes/shared.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { AuthResult, Connector, KVStorage } from "../src/types.js";
import fixture from "./fixtures/access-tokens-v023.json";
import { calcApi, fakeClerkAuth, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta } from "./helpers.js";
import { machineAuth, TEST_MACHINE_NAMESPACE } from "./helpers/machine-auth.js";

const BASE = "https://connecta.test";
/** Any slot revision: opaque, 22 base64url characters. */
const REVISION = expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u);
/** Well-formed, and the revision of no slot. */
const UNKNOWN_REVISION = "A".repeat(22);
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
    // Each mutation names the revision the list shows for the slot it decides from.
    const send = async (method: "POST" | "DELETE", name = "simon") => {
      const { agents } = (await list()).body as { agents: Array<{ name: string; revision: string }> };
      const revision = agents.find((agent) => agent.name === name)?.revision ?? UNKNOWN_REVISION;
      return app.fetch(request("clerk-operator", `/ui/access-tokens/${name}`, method, { expect: revision }));
    };
    try {
      expect((await list()).body).toEqual({
        agents: [
          { name: "simon", state: "none", revision: REVISION },
          { name: "ci", state: "none", revision: REVISION },
        ],
      });

      const issued = await send("POST");
      expect(issued.status).toBe(200);
      expect(issued.headers.get("cache-control")).toContain("no-store");
      const first = (await issued.json()) as { token: string; agent: { name: string; issuedAt: string } };
      expect(first.token).toMatch(/^cta_[A-Za-z0-9_-]{43}$/);
      expect(first.agent).toEqual({ name: "simon", state: "issued", issuedAt: expect.any(String), revision: REVISION });
      expect(await admits(manager, first.token)).toBe(true);

      const rotated = (await (await send("POST")).json()) as { token: string };
      expect(rotated.token).not.toBe(first.token);
      expect(await admits(manager, first.token)).toBe(false);
      expect(await admits(manager, rotated.token)).toBe(true);

      const listed = await list();
      const [simon, ci] = listed.body.agents as Array<Record<string, unknown>>;
      expect(Object.keys(simon!).sort()).toEqual(["issuedAt", "name", "revision", "state"]);
      expect(ci).toEqual({ name: "ci", state: "none", revision: REVISION });
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

      const revoked = await send("DELETE");
      expect(await revoked.json()).toEqual({
        agent: { name: "simon", state: "revoked", revokedAt: expect.any(String), revision: REVISION },
      });
      expect(await admits(manager, rotated.token)).toBe(false);
      const reissued = (await (await send("POST")).json()) as { token: string };
      expect(await admits(manager, reissued.token)).toBe(true);

      // Agents come from code: nothing creates, renames or rebinds one here.
      expect((await send("POST", "nobody")).status).toBe(404);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens", "POST", { name: "x" }))).status).toBe(405);
      expect(
        (await app.fetch(request("clerk-operator", "/ui/access-tokens/simon", "PUT", { name: "renamed" }))).status,
      ).toBe(405);
      expect((await send("DELETE", fixture.unbound.accessToken.id)).status).toBe(404);
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
        { name: "simon", state: "issued", issuedAt: expect.any(String), revision: REVISION },
      ]);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens"))).status).toBe(200);
      const foreign = request("clerk-operator", "/ui/access-tokens/simon", "POST");
      foreign.headers.set("Origin", "https://evil.test");
      expect((await app.fetch(foreign)).status).toBe(403);
      expect((await app.fetch(request("clerk-operator", "/ui/access-tokens", "OPTIONS"))).status).toBe(403);
      expect(await new AccessTokenManager(storage, { agents: ["simon"] }).list()).toEqual([
        { name: "simon", state: "issued", issuedAt: expect.any(String), revision: REVISION },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe("rotation and revocation", () => {
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

  it("INV-4: adopt keeps a legacy token's secret for one agent without rewriting the legacy record", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["legacy", "other"] });
    expect(await manager.adopt(fixture.unbound.accessToken.id, "legacy")).toEqual({
      name: "legacy",
      state: "issued",
      issuedAt: fixture.unbound.accessToken.createdAt,
      revision: REVISION,
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
      JSON.stringify({ ...record, revokedAt: "2026-10-01T00:00:00.000Z" }),
      JSON.stringify({ ...record, agent: "other" }),
      JSON.stringify({ ...record, id: fixture.bound.accessToken.id }),
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
});

it.each([3])("INV-7: an agent deadline at storage read %i refuses promptly and starts no later read", async (stage) => {
  vi.useFakeTimers();
  const { authenticate } = await import("../src/auth-admission.js");
  const storage = memoryStorage();
  const manager = new AccessTokenManager(storage, { agents: ["assistant"] });
  const { token } = await manager.rotate("assistant");
  const nativeGet = storage.get.bind(storage);
  let release!: () => void;
  let count = 0;
  let settlement: Promise<unknown> | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = vi.spyOn(storage, "get").mockImplementation(async (key) => {
    if (++count === stage) await held;
    return nativeGet(key);
  });
  const caller = new AbortController();
  const pending = authenticate(
    manager.auth,
    new Request(request(token), { signal: caller.signal }),
    BASE,
    undefined,
    { info() {}, warn() {}, error() {}, debug() {} },
    (work) => {
      settlement = work;
    },
  );
  try {
    await vi.waitFor(() => expect(count).toBe(stage));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.result.ok).toBe(false);
    release();
    await settlement;
    expect(get).toHaveBeenCalledTimes(stage);
  } finally {
    caller.abort();
    release();
    await pending;
    await settlement;
    get.mockRestore();
    vi.useRealTimers();
  }
});
