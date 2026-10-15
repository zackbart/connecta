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

async function records(storage: KVStorage) {
  const keys = await storage.list(RECORDS);
  return Promise.all(keys.map(async (key) => JSON.parse((await storage.get(key))!) as Record<string, unknown>));
}

async function legacyStorage() {
  const storage = memoryStorage();
  for (const [key, value] of Object.entries(fixture.records)) await storage.set(key, value);
  return storage;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancelled token operations", () => {
  const beforeSwap = [
    ["the record write", (operation: Operation, key: string) => operation === "get" && key.startsWith(LOOKUPS)],
    ["the lookup write", (operation: Operation, key: string) => operation === "set" && key.startsWith(RECORDS)],
    ["the slot swap", (operation: Operation, key: string) => operation === "set" && key.startsWith(LOOKUPS)],
  ] as const;

  it.each(beforeSwap)(
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
      // Settled means cleaned up: nothing is left for after the request.
      expect(await base.get(SLOT)).toBe(slotBefore);
      expect(await admits(seed, previous.token)).toBe(true);
      expect(await admits(seed, secret)).toBe(false);
      expect(await base.list(LOOKUPS)).toHaveLength(1);
      const live = JSON.parse(slotBefore!).tokenId;
      for (const record of await records(base)) {
        expect(record.revokedAt === undefined, String(record.id)).toBe(record.id === live);
      }
    },
  );

  it("INV-7: a rotation aborted between the swap and the response retires the undeliverable secret", async () => {
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
    // The swap committed, so the previous token is gone; the new one was never delivered.
    expect(await admits(seed, previous.token)).toBe(false);
    expect(await admits(seed, secret)).toBe(false);
    expect(await base.list(LOOKUPS)).toEqual([]);
    expect(await seed.list()).toEqual([{ name: "simon", state: "revoked", revokedAt: expect.any(String) }]);
    // An operator re-rotates to recover.
    vi.restoreAllMocks();
    expect(await admits(seed, (await seed.rotate("simon")).token)).toBe(true);
  });

  it("INV-7: an already aborted request changes nothing on rotate, revoke or adopt", async () => {
    const storage = await legacyStorage();
    const manager = new AccessTokenManager(storage, { agents: ["simon", "legacy"] });
    const { token } = await manager.rotate("simon");
    const before = JSON.stringify(await Promise.all((await storage.list("")).map((key) => storage.get(key))));
    const signal = AbortSignal.abort();
    for (const operation of [
      () => manager.rotate("simon", "operator", { signal }),
      () => manager.revoke("simon", "operator", { signal }),
      () => manager.adopt(fixture.unbound.accessToken.id, "legacy", { signal }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "aborted" });
    }
    expect(JSON.stringify(await Promise.all((await storage.list("")).map((key) => storage.get(key))))).toBe(before);
    expect(await admits(manager, token)).toBe(true);
  });

  it("INV-7: a cancelled HTTP rotation never leaves an unreturned secret admitting", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    let pause!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = hooked(base, {
      before: async (operation, key) => {
        if (operation === "set" && key.startsWith(RECORDS)) {
          pause();
          await gate;
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
      await paused;
      controller.abort();
      await response.then(
        async (answer) => expect(answer.status).not.toBe(200),
        () => {},
      );
      release();
      // The handler finishes its cleanup after the caller has gone.
      const live = JSON.parse((await base.get(SLOT))!).tokenId;
      await expect
        .poll(async () => (await records(base)).every((record) => record.revokedAt || record.id === live))
        .toBe(true);
      await expect.poll(async () => (await base.list(LOOKUPS)).length).toBe(1);
      expect(await admits(seed, previous.token)).toBe(true);
      expect(await admits(seed, secret)).toBe(false);
      expect(await seed.list()).toEqual([{ name: "simon", state: "issued", issuedAt: expect.any(String) }]);
    } finally {
      release();
      await app.close();
    }
  });
});

describe("interrupted retirement", () => {
  it("INV-4: a lost swap answer and a failed lookup delete still leave the unpublished secret refused", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const previousLookup = (await base.list(LOOKUPS))[0]!;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        const committed = await base.compareAndSet(key, expected, next, options);
        if (key === SLOT) throw new Error("swap answer lost");
        return committed;
      },
      delete: async (key) => {
        if (key.startsWith(LOOKUPS)) throw new Error("lookup delete failed");
        return base.delete(key);
      },
    };
    const secret = predictableSecret();
    await expect(new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon")).rejects.toThrow(
      "swap answer lost",
    );
    // Both lookups survive, yet neither secret admits: one record is revoked
    // and no longer the slot's, the other is no longer the slot's either.
    expect(await base.list(LOOKUPS)).toHaveLength(2);
    expect(await base.list(LOOKUPS)).toContain(previousLookup);
    expect(await admits(seed, secret)).toBe(false);
    expect(await admits(seed, previous.token)).toBe(false);
    for (const record of await records(base)) expect(record.revokedAt).toEqual(expect.any(String));
    expect((await seed.list())[0]?.state).toBe("revoked");
  });

  it("INV-4: a record that is no longer the slot's refuses even when its lookup delete failed", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    const previous = await seed.rotate("simon");
    const storage: KVStorage = {
      ...base,
      delete: async (key) => {
        if (key.startsWith(LOOKUPS)) throw new Error("lookup delete failed");
        return base.delete(key);
      },
      compareAndSet: async (key, expected, next, options) => {
        // The revoked mark fails too: only the slot no longer names it.
        if (key.startsWith(RECORDS)) throw new Error("record write failed");
        return base.compareAndSet(key, expected, next, options);
      },
    };
    const next = await new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon");
    expect(await base.list(LOOKUPS)).toHaveLength(2);
    expect(await admits(seed, previous.token)).toBe(false);
    expect(await admits(seed, next.token)).toBe(true);
  });
});

describe("interrupted adoption", () => {
  const unbound = fixture.unbound;
  const recordKey = `${RECORDS}${unbound.accessToken.id}`;

  it("INV-4: a record bind whose answer was lost is released, listed again and adoptable on retry", async () => {
    const base = await legacyStorage();
    let failing = true;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        const committed = await base.compareAndSet(key, expected, next, options);
        if (failing && key === recordKey) {
          failing = false;
          throw new Error("bind answer lost");
        }
        return committed;
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).rejects.toThrow("bind answer lost");
    expect(JSON.parse((await base.get(recordKey))!).agent).toBeUndefined();
    expect(await base.get("access-token:v1:agent:legacy")).toBeNull();
    expect((await manager.unboundTokens()).map((token) => token.id)).toContain(unbound.accessToken.id);
    expect(await admits(manager, unbound.token)).toBe(false);
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
  });

  it("INV-4: a slot write that fails before committing releases the bind for a retry", async () => {
    const base = await legacyStorage();
    let failing = true;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        if (failing && key === "access-token:v1:agent:legacy") {
          failing = false;
          throw new Error("slot write failed");
        }
        return base.compareAndSet(key, expected, next, options);
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).rejects.toThrow("slot write failed");
    expect(JSON.parse((await base.get(recordKey))!).agent).toBeUndefined();
    expect((await manager.unboundTokens()).map((token) => token.id)).toContain(unbound.accessToken.id);
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
  });

  it("INV-4: a slot write that committed without an answer is a completed adoption", async () => {
    const base = await legacyStorage();
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        const committed = await base.compareAndSet(key, expected, next, options);
        if (key === "access-token:v1:agent:legacy") throw new Error("slot answer lost");
        return committed;
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).rejects.toMatchObject({ code: "not_adoptable" });
  });

  it("INV-4: a bind that cannot be released resumes on retry and is named for any other agent", async () => {
    const base = await legacyStorage();
    let slotFails = true;
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (key, expected, next, options) => {
        if (slotFails && key === "access-token:v1:agent:legacy") {
          slotFails = false;
          throw new Error("slot write failed");
        }
        // The release back to unbound fails too.
        if (key === recordKey && next !== null && JSON.parse(next).agent === undefined) {
          throw new Error("release failed");
        }
        return base.compareAndSet(key, expected, next, options);
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["legacy", "other"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).rejects.toThrow("slot write failed");
    expect(JSON.parse((await base.get(recordKey))!).agent).toBe("legacy");
    expect((await manager.unboundTokens()).map((token) => token.id)).toContain(unbound.accessToken.id);
    await expect(manager.adopt(unbound.accessToken.id, "other")).rejects.toThrow(
      /interrupted adoption for "legacy"; retry adopting it as "legacy"/,
    );
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, unbound.token)).toBe(true);
  });

  it("INV-7: an adoption aborted between its writes releases the bind", async () => {
    const base = await legacyStorage();
    const controller = new AbortController();
    const storage = hooked(base, {
      after: (operation, key) => {
        if (operation === "compareAndSet" && key === recordKey) controller.abort();
      },
    });
    const manager = new AccessTokenManager(storage, { agents: ["legacy"] });
    await expect(manager.adopt(unbound.accessToken.id, "legacy", { signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(await base.get(recordKey)).toBe(fixture.records[recordKey as keyof typeof fixture.records]);
    expect(await base.get("access-token:v1:agent:legacy")).toBeNull();
    await expect(manager.adopt(unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
  });
});
