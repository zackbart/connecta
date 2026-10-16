import { afterEach, describe, expect, it, vi } from "vitest";
import { accessTokens, AccessTokenManager, isSlotRevision } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import fixture from "./fixtures/access-tokens-v023.json";
import type { KVStorage } from "../src/types.js";

// Slot preconditions (#837 P3b): every token mutation names the slot revision
// it decided from, and the slot's compare-and-set commits only from that slot.

const BASE = "https://connecta.test";
const SLOT = "access-token:v1:agent:simon";
const owner = { namespace: "clerk:test", id: "owner" };
const human = { ...fakeClerkAuth({ userId: "owner" }), activityActorNamespace: owner.namespace };
/** Well-formed, and the revision of no slot. */
const UNKNOWN_REVISION = "A".repeat(22);

async function snapshot(storage: KVStorage) {
  const keys = await storage.list("");
  return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await storage.get(key)] as const)));
}

async function legacyStorage() {
  const storage = memoryStorage();
  for (const [key, value] of Object.entries(fixture.records)) await storage.set(key, value);
  return storage;
}

const admits = async (manager: AccessTokenManager, token: string) =>
  (await manager.auth.authorize(new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${token}` } }), BASE))
    .ok;

/** Calls `before` ahead of each compareAndSet on the slot, with what it will compare against. */
function beforeSlotCommit(base: KVStorage, before: (expected: string | null) => Promise<void>): KVStorage {
  return {
    ...base,
    compareAndSet: async (key, expected, next, options) => {
      if (key === SLOT) await before(expected);
      return base.compareAndSet(key, expected, next, options);
    },
  };
}

function setup(storage: KVStorage = memoryStorage()) {
  const app = createTestConnecta({
    connectors: [],
    auth: human,
    maintainers: [owner],
    agents: ["simon"],
    accessTokens: accessTokens(storage),
  });
  const send = (method: string, body?: unknown, query = "", headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(`${BASE}/ui/access-tokens/simon${query}`, {
        method,
        headers: {
          Authorization: "Bearer clerk-operator",
          Origin: BASE,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
  const listed = async () => {
    const response = await app.fetch(
      new Request(`${BASE}/ui/access-tokens`, { headers: { Authorization: "Bearer clerk-operator" } }),
    );
    const { agents } = (await response.json()) as { agents: Array<{ name: string; revision: string }> };
    return agents[0]!.revision;
  };
  return { app, send, listed };
}

describe("slot revisions", () => {
  it("INV-10: the revision changes on every commit (issue, rotate, revoke, adopt) and on nothing else", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon", "legacy"] });
    const revision = async (name = "simon") => (await manager.list()).find((slot) => slot.name === name)!.revision;
    const seen = new Set<string>();
    const fresh = (value: string) => {
      expect(isSlotRevision(value)).toBe(true);
      expect(seen.has(value), value).toBe(false);
      seen.add(value);
      return value;
    };

    const none = fresh(await revision());
    expect(await revision()).toBe(none);
    const issued = await manager.rotate("simon");
    expect(issued.agent.revision).toBe(fresh(await revision()));
    const rotated = await manager.rotate("simon");
    expect(rotated.agent.revision).toBe(fresh(await revision()));
    const revoked = await manager.revoke("simon");
    expect(revoked.revision).toBe(fresh(await revision()));
    // Revoking a revoked slot commits nothing, so the revision stays.
    expect((await manager.revoke("simon")).revision).toBe(revoked.revision);
    expect(await revision()).toBe(revoked.revision);
    const reissued = await manager.rotate("simon");
    expect(reissued.agent.revision).toBe(fresh(await revision()));
    // Two revocations of different tokens store different slots, even within one millisecond.
    expect((await manager.revoke("simon")).revision).toBe(fresh(await revision()));

    const legacyNone = fresh(await revision("legacy"));
    const adopted = await manager.adopt(fixture.unbound.accessToken.id, "legacy");
    expect(adopted.revision).not.toBe(legacyNone);
    expect(adopted.revision).toBe(fresh(await revision("legacy")));
    // Rerunning a completed adoption commits nothing to the slot.
    expect((await manager.adopt(fixture.unbound.accessToken.id, "legacy")).revision).toBe(adopted.revision);
    // A refused mutation commits nothing either.
    await expect(manager.rotate("simon", "operator", { expect: none })).rejects.toMatchObject({ code: "slot_changed" });
    expect([...seen]).toContain(await revision());
  });

  it("INV-5: a revision carries no secret, digest, prefix or token id", async () => {
    const storage = memoryStorage();
    const { app, listed } = setup(storage);
    try {
      const { token, agent } = await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
      const slot = JSON.parse((await storage.get(SLOT))!) as { tokenId: string };
      const record = JSON.parse((await storage.get(`access-token:v1:record:${slot.tokenId}`))!) as {
        tokenHash: string;
        tokenPrefix: string;
      };
      const revision = await listed();
      expect(revision).toBe(agent.revision);
      expect(revision).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      const response = await app.fetch(
        new Request(`${BASE}/ui/access-tokens`, { headers: { Authorization: "Bearer clerk-operator" } }),
      );
      const text = await response.text();
      for (const secret of [
        token,
        token.slice(0, 12),
        record.tokenHash,
        record.tokenPrefix,
        slot.tokenId,
        slot.tokenId.replaceAll("-", ""),
      ]) {
        expect(text).not.toContain(secret);
        expect(secret).not.toContain(revision);
      }
      for (const part of [record.tokenHash, slot.tokenId]) {
        for (let at = 0; at + 8 <= revision.length; at++) expect(part).not.toContain(revision.slice(at, at + 8));
      }
    } finally {
      await app.close();
    }
  });
});

describe("token routes require expect", () => {
  it.each([
    ["POST", undefined, ""],
    ["DELETE", undefined, ""],
    ["POST", {}, ""],
    ["DELETE", {}, ""],
    ["POST", { expect: 7 }, ""],
    ["POST", { expect: "short" }, ""],
    ["DELETE", { expect: null }, ""],
    ["POST", "{not json", ""],
    ["POST", [UNKNOWN_REVISION], ""],
    ["DELETE", undefined, "?expect=short"],
  ] as const)(
    "INV-9: %s with a missing or malformed expect (%j%s) is 400 and writes nothing",
    async (method, body, query) => {
      const storage = memoryStorage();
      await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
      const before = await snapshot(storage);
      const { app, send } = setup(storage);
      try {
        const response = await send(method, body, query);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.any(String) });
        expect(await snapshot(storage)).toEqual(before);
      } finally {
        await app.close();
      }
    },
  );

  it("INV-9: expect is a JSON body on POST; DELETE takes the body or ?expect=, never both", async () => {
    const storage = memoryStorage();
    const { app, send, listed } = setup(storage);
    try {
      expect((await send("POST", undefined, `?expect=${await listed()}`)).status).toBe(400);
      expect(
        (await send("POST", JSON.stringify({ expect: await listed() }), "", { "Content-Type": "text/plain" })).status,
      ).toBe(415);
      expect((await send("POST", { expect: "x".repeat(2_000) })).status).toBe(413);
      const issued = await send("POST", { expect: await listed() });
      expect(issued.status).toBe(200);
      const revision = await listed();
      expect((await send("DELETE", { expect: revision }, `?expect=${revision}`)).status).toBe(400);
      expect((await send("DELETE", undefined, `?expect=${revision}&expect=${revision}`)).status).toBe(400);
      const revoked = await send("DELETE", undefined, `?expect=${revision}`);
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ agent: { state: "revoked", revision: await listed() } });
    } finally {
      await app.close();
    }
  });

  it.each(["POST", "DELETE"] as const)(
    "INV-9: %s with a stale expect is 409 slot_changed, mints nothing and leaves the slot unchanged",
    async (method) => {
      const storage = memoryStorage();
      const manager = new AccessTokenManager(storage, { agents: ["simon"] });
      const stale = (await manager.rotate("simon")).agent.revision;
      const current = await manager.rotate("simon");
      const before = await snapshot(storage);
      const { app, send } = setup(storage);
      try {
        for (const expected of [stale, UNKNOWN_REVISION]) {
          const response = await send(method, { expect: expected });
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({ error: expect.any(String), code: "slot_changed" });
        }
        expect(await snapshot(storage)).toEqual(before);
        expect(await admits(manager, current.token)).toBe(true);
      } finally {
        await app.close();
      }
    },
  );

  it("INV-9: issuing with a none-era revision over a slot that now exists is 409 and mints nothing", async () => {
    const storage = memoryStorage();
    const { app, send, listed } = setup(storage);
    try {
      const noneEra = await listed();
      const first = await send("POST", { expect: noneEra });
      expect(first.status).toBe(200);
      const { token } = (await first.json()) as { token: string };
      const before = await snapshot(storage);
      // A second tab still shows "No token" and issues from that view.
      const second = await send("POST", { expect: noneEra });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ code: "slot_changed" });
      expect(await snapshot(storage)).toEqual(before);
      expect(await admits(new AccessTokenManager(storage, { agents: ["simon"] }), token)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("INV-9: a rotation that commits between this rotation's read and its commit makes this one 409, never a commit", async () => {
    const base = memoryStorage();
    const manager = new AccessTokenManager(base, { agents: ["simon"] });
    const seeded = await manager.rotate("simon");
    let racer: Awaited<ReturnType<AccessTokenManager["rotate"]>> | undefined;
    const compared: Array<string | null> = [];
    const storage = beforeSlotCommit(base, async (expected) => {
      compared.push(expected);
      // Another operator's rotation lands after this request read the slot.
      racer ??= await manager.rotate("simon");
    });
    const { app, send } = setup(storage);
    try {
      const response = await send("POST", { expect: seeded.agent.revision });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String), code: "slot_changed" });
      // The one commit attempt compared against the slot `expect` named, and was not retried.
      expect(compared).toHaveLength(1);
      expect(compared[0]).not.toBeNull();
      expect((await manager.list())[0]!.revision).toBe(racer!.agent.revision);
      expect(JSON.parse((await base.get(SLOT))!)).toMatchObject({ state: "issued" });
      expect(await admits(manager, racer!.token)).toBe(true);
      expect(await admits(manager, seeded.token)).toBe(false);
      // This request's own record and lookup were removed; only the two committed rotations' remain.
      expect(await base.list("access-token:v1:record:")).toHaveLength(2);
      expect(await base.list("access-token:v1:lookup:")).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("INV-9: a rotation that commits between a revocation's read and its commit makes the revocation 409 and keeps the fresh token", async () => {
    const base = memoryStorage();
    const manager = new AccessTokenManager(base, { agents: ["simon"] });
    const seeded = await manager.rotate("simon");
    let racer: Awaited<ReturnType<AccessTokenManager["rotate"]>> | undefined;
    let commits = 0;
    const storage = beforeSlotCommit(base, async () => {
      commits++;
      racer ??= await manager.rotate("simon");
    });
    const { app, send } = setup(storage);
    try {
      const response = await send("DELETE", { expect: seeded.agent.revision });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "slot_changed" });
      expect(commits).toBe(1);
      // Without expect the revocation would revoke whatever the slot named; with it, the fresh rotation stands.
      expect(await admits(manager, racer!.token)).toBe(true);
      expect((await manager.list())[0]).toMatchObject({ state: "issued", revision: racer!.agent.revision });
    } finally {
      await app.close();
    }
  });

  it("INV-9: the commit compares against exactly the raw slot whose revision the caller expected", async () => {
    const base = memoryStorage();
    const manager = new AccessTokenManager(base, { agents: ["simon"] });
    const seeded = await manager.rotate("simon");
    const raw = await base.get(SLOT);
    const compared: Array<string | null> = [];
    const storage = beforeSlotCommit(base, async (expected) => {
      compared.push(expected);
    });
    const { app, send } = setup(storage);
    try {
      const rotated = await send("POST", { expect: seeded.agent.revision });
      expect(rotated.status).toBe(200);
      const { agent } = (await rotated.json()) as { agent: { revision: string } };
      const afterRotate = await base.get(SLOT);
      const revoked = await send("DELETE", { expect: agent.revision });
      expect(revoked.status).toBe(200);
      expect(compared).toEqual([raw, afterRotate]);
    } finally {
      await app.close();
    }
  });
});

/**
 * Hold the first two slot reads until both have started, so two operations
 * decide from the same slot; `onCommit` sees each slot compare-and-set in
 * order with its definitive answer and may make it unanswered by throwing.
 */
function sameSlotRace(base: KVStorage, onCommit: (index: number, committed: boolean) => void = () => {}): KVStorage {
  let reads = 0;
  let commits = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ...base,
    get: async (key) => {
      const raw = await base.get(key);
      if (key === SLOT && reads < 2) {
        if (++reads === 2) release();
        await both;
      }
      return raw;
    },
    compareAndSet: async (key, expected, next, options) => {
      const committed = await base.compareAndSet(key, expected, next, options);
      if (key === SLOT) onCommit(commits++, committed);
      return committed;
    },
  };
}

describe("concurrent conditional revocations", () => {
  const FIXED = new Date("2026-10-15T12:00:00.000Z");
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["refused", false],
    ["unanswered", true],
  ] as const)(
    "INV-9: two conditional revokes of one slot in one millisecond give exactly one 200 and one 409 (loser %s)",
    async (_loser, ambiguous) => {
      const base = memoryStorage();
      const manager = new AccessTokenManager(base, { agents: ["simon"] });
      const { agent } = await manager.rotate("simon");
      // Both revocations are built at the same instant, so only a per-call id tells them apart.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED);
      const storage = sameSlotRace(base, (index, committed) => {
        if (index === 1 && ambiguous) {
          expect(committed).toBe(false);
          throw new Error("connection reset before the answer");
        }
      });
      const { app, send } = setup(storage);
      try {
        const responses = await Promise.all([
          send("DELETE", { expect: agent.revision }),
          send("DELETE", { expect: agent.revision }),
        ]);
        const bodies = await Promise.all(responses.map((response) => response.json()));
        const outcomes = responses.map((response, i) => [response.status, bodies[i]] as const);
        outcomes.sort(([a], [b]) => a - b);
        expect(outcomes.map(([status]) => status)).toEqual([200, 409]);
        expect(outcomes[1]![1]).toEqual({ error: expect.any(String), code: "slot_changed" });
        const stored = JSON.parse((await base.get(SLOT))!) as { revokedAt: string; revocationId: string };
        expect(stored.revokedAt).toBe(FIXED.toISOString());
        // The winner reports exactly the slot that is stored.
        expect((outcomes[0]![1] as { agent: { revision: string } }).agent.revision).toBe(
          (await manager.list())[0]!.revision,
        );
      } finally {
        await app.close();
      }
    },
  );

  it("INV-9: an unanswered conditional revoke that landed is recognized by its own revocation id", async () => {
    const base = memoryStorage();
    const manager = new AccessTokenManager(base, { agents: ["simon"] });
    const issued = await manager.rotate("simon");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED);
    let commits = 0;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        const committed = await base.compareAndSet(key, expected, next, options);
        if (key === SLOT && commits++ === 0) throw new Error("connection reset after the write");
        return committed;
      },
    };
    const revoked = await new AccessTokenManager(storage, { agents: ["simon"] }).revoke("simon", {
      expect: issued.agent.revision,
    });
    expect(revoked).toMatchObject({ state: "revoked", revision: (await manager.list())[0]!.revision });
    // Read back, never written again.
    expect(commits).toBe(1);
    expect(await admits(manager, issued.token)).toBe(false);
  });
});

describe("manager preconditions", () => {
  it("INV-9: rotate, revoke and adopt work without expect and honor it when given", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon", "legacy"] });
    // Without expect: the provisioning-script path is unchanged.
    const issued = await manager.rotate("simon", "test-provisioning");
    expect(await admits(manager, issued.token)).toBe(true);
    expect(await manager.revoke("simon")).toMatchObject({ state: "revoked" });

    // With expect: a current revision commits, a stale one refuses before writing.
    const revoked = (await manager.list())[0]!.revision;
    const rotated = await manager.rotate("simon", "operator", { expect: revoked });
    await expect(manager.rotate("simon", "operator", { expect: revoked })).rejects.toMatchObject({
      code: "slot_changed",
    });
    await expect(manager.revoke("simon", { expect: revoked })).rejects.toMatchObject({ code: "slot_changed" });
    expect(await admits(manager, rotated.token)).toBe(true);
    expect(await manager.revoke("simon", { expect: rotated.agent.revision })).toMatchObject({ state: "revoked" });

    // A stale adoption refuses before its write-once claim is set.
    const legacyNone = (await manager.list())[1]!.revision;
    const before = await snapshot(storage);
    await expect(
      manager.adopt(fixture.unbound.accessToken.id, "legacy", { expect: UNKNOWN_REVISION }),
    ).rejects.toMatchObject({ code: "slot_changed" });
    expect(await snapshot(storage)).toEqual(before);
    await expect(
      manager.adopt(fixture.unbound.accessToken.id, "legacy", { expect: legacyNone }),
    ).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, fixture.unbound.token)).toBe(true);
  });
});
