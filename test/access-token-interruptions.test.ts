import { afterEach, describe, expect, it, vi } from "vitest";
import { accessTokens, AccessTokenManager } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import fixture from "./fixtures/access-tokens-v023.json";
import type { KVStorage } from "../src/types.js";

const BASE = "https://connecta.test";
const SLOT = "access-token:v1:agent:simon";
const LOOKUPS = "access-token:v1:lookup:";
const RECORDS = "access-token:v1:record:";

type Operation = "get" | "set" | "delete" | "compareAndSet";
/** Runs `after` once an operation on a matching key has settled, committed or not. */
type Hook = (operation: Operation, key: string) => void | Promise<void>;

function hooked(base: KVStorage, hooks: { before?: Hook; after?: Hook }): KVStorage {
  const wrap =
    <A extends unknown[], R>(operation: Operation, call: (key: string, ...rest: A) => Promise<R>) =>
    async (key: string, ...rest: A): Promise<R> => {
      await hooks.before?.(operation, key);
      try {
        return await call(key, ...rest);
      } finally {
        await hooks.after?.(operation, key);
      }
    };
  return {
    ...base,
    get: wrap("get", (key) => base.get(key)),
    set: wrap("set", (key, value: string, options?: Parameters<KVStorage["set"]>[2]) => base.set(key, value, options)),
    delete: wrap("delete", (key) => base.delete(key)),
    compareAndSet: wrap(
      "compareAndSet",
      (key, expected: string | null, next: string | null, options?: Parameters<KVStorage["compareAndSet"]>[3]) =>
        base.compareAndSet(key, expected, next, options),
    ),
  };
}

const request = (token: string) => new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
const admits = async (manager: AccessTokenManager, token: string) =>
  (await manager.auth.authorize(request(token), BASE)).ok;

/** Make the next issued secret predictable, so a test can present a token rotate never returned. */
function predictableSecret(): string {
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint8Array) array.fill(7);
    return array;
  });
  return (
    "cta_" +
    btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "")
  );
}

/** A promise the test resolves, and one that resolves when code reaches a point. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const slotOf = async (storage: KVStorage, agent = "simon") =>
  JSON.parse((await storage.get(`access-token:v1:agent:${agent}`)) ?? "null") as Record<string, unknown> | null;

async function legacyStorage() {
  const storage = memoryStorage();
  for (const [key, value] of Object.entries(fixture.records)) await storage.set(key, value);
  return storage;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancelled rotations", () => {
  const beforeCommit = [
    ["the record write", (operation: Operation, key: string) => operation === "get" && key.startsWith(LOOKUPS)],
    ["the lookup write", (operation: Operation, key: string) => operation === "set" && key.startsWith(RECORDS)],
    ["the slot commit", (operation: Operation, key: string) => operation === "set" && key.startsWith(LOOKUPS)],
  ] as const;

  it.each(beforeCommit)(
    "INV-7: a rotation aborted before %s publishes nothing and keeps the previous token",
    async (_point, trigger) => {
      const base = memoryStorage();
      const seed = new AccessTokenManager(base, { agents: ["simon"] });
      const previous = await seed.rotate("simon");
      const slotBefore = await base.get(SLOT);
      const controller = new AbortController();
      const storage = hooked(base, {
        after: (operation, key) => {
          if (trigger(operation, key)) controller.abort();
        },
      });
      const secret = predictableSecret();
      await expect(
        new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon", "operator", {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "aborted" });
      expect(await base.get(SLOT)).toBe(slotBefore);
      expect(await admits(seed, previous.token)).toBe(true);
      expect(await admits(seed, secret)).toBe(false);
      // The inert provisional record was collected inside the request.
      expect(await base.list(LOOKUPS)).toHaveLength(1);
      expect(await base.list(RECORDS)).toHaveLength(1);
    },
  );

  it("INV-7: a rotation aborted after its commit revokes the slot instead of delivering", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const controller = new AbortController();
    const storage = hooked(base, {
      after: (operation, key) => {
        if (operation === "compareAndSet" && key === SLOT) controller.abort();
      },
    });
    const secret = predictableSecret();
    await expect(
      new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon", "operator", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(await admits(seed, previous.token)).toBe(false);
    expect(await admits(seed, secret)).toBe(false);
    expect(await seed.list()).toEqual([{ name: "simon", state: "revoked", revokedAt: expect.any(String) }]);
    // An operator rotates again to recover.
    vi.restoreAllMocks();
    expect(await admits(seed, (await seed.rotate("simon")).token)).toBe(true);
  });

  it("INV-7: an abort while the previous record's collection is stalled revokes the slot at once", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const previousKey = `${RECORDS}${(await slotOf(base))!.tokenId}`;
    const stalled = latch();
    const stall = latch();
    const controller = new AbortController();
    const storage = hooked(base, {
      before: async (operation, key) => {
        if (operation === "get" && key === previousKey) {
          stalled.open();
          await stall.opened;
        }
      },
    });
    const secret = predictableSecret();
    try {
      const rotation = new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon", "operator", {
        signal: controller.signal,
      });
      const outcome = rotation.then(
        () => "delivered",
        (error: { code?: string }) => error.code,
      );
      await stalled.opened;
      controller.abort();
      // The stall is still holding: nothing waits on it.
      expect(await outcome).toBe("aborted");
      expect(await admits(seed, secret)).toBe(false);
      expect(await admits(seed, previous.token)).toBe(false);
      expect((await slotOf(base))?.state).toBe("revoked");
    } finally {
      stall.open();
    }
  });

  it("INV-7: a transient read failure while revoking after the commit resolves or reports the outcome unknown", async () => {
    for (const failures of [2, Number.POSITIVE_INFINITY]) {
      const base = memoryStorage();
      const seed = new AccessTokenManager(base, { agents: ["simon"] });
      await seed.rotate("simon");
      const controller = new AbortController();
      let committed = false;
      let failed = 0;
      const storage: KVStorage = {
        ...base,
        get: async (key) => {
          if (committed && key === SLOT && failed < failures) {
            failed++;
            throw new Error("slot read failed");
          }
          return base.get(key);
        },
        compareAndSet: async (key, expected, next, options) => {
          const result = await base.compareAndSet(key, expected, next, options);
          if (key === SLOT && !committed) {
            committed = true;
            controller.abort();
          }
          return result;
        },
      };
      const secret = predictableSecret();
      const outcome = await new AccessTokenManager(storage, { agents: ["simon"] })
        .rotate("simon", "operator", { signal: controller.signal })
        .then(
          () => "delivered",
          (error: { code?: string }) => error.code,
        );
      vi.restoreAllMocks();
      if (failures === 2) {
        expect(outcome).toBe("aborted");
        expect((await slotOf(base))?.state).toBe("revoked");
        expect(await admits(seed, secret)).toBe(false);
      } else {
        // Never a silent success: the operator is told to rotate again.
        expect(outcome).toBe("outcome_unknown");
      }
    }
  });

  it("INV-7: a cancelled HTTP rotation never leaves an unreturned secret admitting", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const paused = latch();
    const gate = latch();
    const storage = hooked(base, {
      before: async (operation, key) => {
        if (operation === "set" && key.startsWith(RECORDS)) {
          paused.open();
          await gate.opened;
        }
      },
    });
    const app = createTestConnecta({
      connectors: [],
      storage,
      auth: fakeClerkAuth(),
      agents: ["simon"],
      accessTokens: accessTokens(storage),
      identity: { accessTokenManagement: () => true },
      logger: "silent",
    });
    const secret = predictableSecret();
    const controller = new AbortController();
    try {
      const response = app.fetch(
        new Request(`${BASE}/ui/access-tokens/simon`, {
          method: "POST",
          headers: { Authorization: "Bearer clerk-operator", Origin: BASE },
          signal: controller.signal,
        }),
      );
      await paused.opened;
      controller.abort();
      await response.then(
        async (answer) => expect(answer.status).not.toBe(200),
        () => {},
      );
      gate.open();
      await expect.poll(async () => (await base.list(RECORDS)).length).toBe(1);
      await expect.poll(async () => (await base.list(LOOKUPS)).length).toBe(1);
      expect(await admits(seed, previous.token)).toBe(true);
      expect(await admits(seed, secret)).toBe(false);
      expect(await seed.list()).toEqual([{ name: "simon", state: "issued", issuedAt: expect.any(String) }]);
    } finally {
      gate.open();
      await app.close();
    }
  });
});

describe("cancelled revocations", () => {
  it("INV-7: an already aborted request changes nothing on rotate, revoke or adopt", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon", "legacy"] });
    const { token } = await manager.rotate("simon");
    const state = async () =>
      JSON.stringify(await Promise.all((await storage.list("")).map((key) => storage.get(key))));
    const before = await state();
    const signal = AbortSignal.abort();
    for (const operation of [
      () => manager.rotate("simon", "operator", { signal }),
      () => manager.revoke("simon", "operator", { signal }),
      () => manager.adopt(fixture.unbound.accessToken.id, "legacy", { signal }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "aborted" });
    }
    expect(await state()).toBe(before);
    expect(await admits(manager, token)).toBe(true);
  });

  it("INV-7: a revocation aborted after its read is a no-op", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const { token } = await seed.rotate("simon");
    const slotBefore = await base.get(SLOT);
    const controller = new AbortController();
    const storage = hooked(base, {
      after: (operation, key) => {
        if (operation === "get" && key === SLOT) controller.abort();
      },
    });
    await expect(
      new AccessTokenManager(storage, { agents: ["simon"] }).revoke("simon", "operator", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(await base.get(SLOT)).toBe(slotBefore);
    expect(await admits(seed, token)).toBe(true);
  });
});

describe("garbage the slot does not name", () => {
  it("INV-4: a lost commit answer and failed collection leave the previous token inert and the new one delivered", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        if (key.startsWith(LOOKUPS)) throw new Error("lookup collection failed");
        const committed = await base.compareAndSet(key, expected, next, options);
        if (key === SLOT) throw new Error("commit answer lost");
        return committed;
      },
      delete: async (key) => {
        if (key.startsWith(RECORDS)) throw new Error("record collection failed");
        return base.delete(key);
      },
    };
    const delivered = await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
    // The previous lookup and record both survive, yet the slot does not name them.
    expect(await base.list(LOOKUPS)).toHaveLength(2);
    expect(await base.list(RECORDS)).toHaveLength(2);
    expect(await admits(seed, previous.token)).toBe(false);
    expect(await admits(seed, delivered.token)).toBe(true);
  });
});

describe("interrupted adoption", () => {
  const unbound = fixture.unbound;
  const legacyKey = `${RECORDS}${unbound.accessToken.id}`;
  const legacyRaw = fixture.records[legacyKey as keyof typeof fixture.records];
  const LEGACY_SLOT = "access-token:v1:agent:legacy";

  it("INV-4: an adoption aborted before its commit leaves another adoption of the same token whole", async () => {
    const base = await legacyStorage();
    const paused = latch();
    const gate = latch();
    const controller = new AbortController();
    let first = true;
    const slow = hooked(base, {
      after: async (operation, key) => {
        if (first && operation === "set" && key.startsWith(RECORDS)) {
          first = false;
          paused.open();
          await gate.opened;
        }
      },
    });
    const agents = { agents: ["legacy", "other"] };
    const a = new AccessTokenManager(slow, agents)
      .adopt(unbound.accessToken.id, "legacy", { signal: controller.signal })
      .then(
        () => "adopted",
        (error: { code?: string }) => error.code,
      );
    await paused.opened;
    // B adopts the same token while A is paused with its record written.
    await expect(new AccessTokenManager(base, agents).adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({
      state: "issued",
    });
    controller.abort();
    gate.open();
    expect(await a).toBe("aborted");
    const manager = new AccessTokenManager(base, agents);
    expect(await admits(manager, unbound.token)).toBe(true);
    expect(await base.get(legacyKey)).toBe(legacyRaw);
    await expect(manager.adopt(unbound.accessToken.id, "other")).rejects.toMatchObject({ code: "not_adoptable" });
    expect((await manager.unboundTokens()).map((token) => token.id)).not.toContain(unbound.accessToken.id);
    // The three legacy records and B's: A's inert record was collected.
    expect(await base.list(RECORDS)).toHaveLength(4);
  });

  it("INV-4: a resumed adoption completes one whose lookup step was interrupted", async () => {
    const base = await legacyStorage();
    const lookupKey = `${LOOKUPS}${JSON.parse(legacyRaw).tokenHash}`;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        if (key === lookupKey) throw new Error("lookup unreachable");
        return base.compareAndSet(key, expected, next, options);
      },
    };
    const agents = { agents: ["legacy", "other"] };
    // The slot commits but the lookup never moves: reported, never success.
    await expect(new AccessTokenManager(storage, agents).adopt(unbound.accessToken.id, "legacy")).rejects.toMatchObject(
      { code: "outcome_unknown" },
    );
    const manager = new AccessTokenManager(base, agents);
    expect(await admits(manager, unbound.token)).toBe(false);
    // Another agent cannot take it while the slot carries its digest.
    await expect(manager.adopt(unbound.accessToken.id, "other")).rejects.toMatchObject({ code: "not_adoptable" });
    expect((await manager.unboundTokens()).map((token) => token.id)).not.toContain(unbound.accessToken.id);
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
    expect(await base.get(legacyKey)).toBe(legacyRaw);
  });

  it("INV-4: an unanswered slot commit is read back and completed", async () => {
    const base = await legacyStorage();
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        const committed = await base.compareAndSet(key, expected, next, options);
        if (key === LEGACY_SLOT) throw new Error("commit answer lost");
        return committed;
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
  });

  it("INV-4: a slot commit that fails leaves the token listed and adoptable on retry", async () => {
    const base = await legacyStorage();
    let failing = true;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        if (failing && key === LEGACY_SLOT) {
          failing = false;
          throw new Error("slot write failed");
        }
        return base.compareAndSet(key, expected, next, options);
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).rejects.toThrow("slot write failed");
    expect(await base.get(LEGACY_SLOT)).toBeNull();
    expect(await base.get(legacyKey)).toBe(legacyRaw);
    expect((await manager.unboundTokens()).map((token) => token.id)).toContain(unbound.accessToken.id);
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
  });

  it("INV-7: an adoption aborted after its commit still completes, since it delivers no secret", async () => {
    const base = await legacyStorage();
    const controller = new AbortController();
    const storage = hooked(base, {
      after: (operation, key) => {
        if (operation === "compareAndSet" && key === LEGACY_SLOT) controller.abort();
      },
    });
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy", { signal: controller.signal })).resolves.toMatchObject(
      { state: "issued" },
    );
    expect(await admits(manager, unbound.token)).toBe(true);
  });
});
