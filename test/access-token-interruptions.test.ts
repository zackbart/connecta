import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessTokenManager, accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import fixture from "./fixtures/access-tokens-v023.json";
import { fakeClerkAuth } from "./fixtures/http.js";
import { createTestConnecta } from "./helpers.js";

const BASE = "https://connecta.test";
/** Any slot revision: opaque, 22 base64url characters. */
const REVISION = expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u);
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

/** Wrap storage so every call is counted, and calls on matching keys can be held. */
function counted(base: KVStorage, hold?: (operation: Operation, key: string) => Promise<void> | undefined) {
  const calls: string[] = [];
  const storage = hooked(base, {
    before: async (operation, key) => {
      calls.push(`${operation} ${key}`);
      await hold?.(operation, key);
    },
  });
  return { storage, calls };
}

/** A promise the test resolves, and one that resolves when code reaches a point. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

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
    expect(await seed.list()).toEqual([
      { name: "simon", state: "revoked", revokedAt: expect.any(String), revision: REVISION },
    ]);
    // An operator rotates again to recover.
    vi.restoreAllMocks();
    expect(await admits(seed, (await seed.rotate("simon")).token)).toBe(true);
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
      logger: "silent",
    });
    const secret = predictableSecret();
    const controller = new AbortController();
    try {
      const response = app.fetch(
        new Request(`${BASE}/ui/access-tokens/simon`, {
          method: "POST",
          headers: { Authorization: "Bearer clerk-operator", Origin: BASE, "Content-Type": "application/json" },
          body: JSON.stringify({ expect: previous.agent.revision }),
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
      expect(await seed.list()).toEqual([
        { name: "simon", state: "issued", issuedAt: expect.any(String), revision: REVISION },
      ]);
    } finally {
      gate.open();
      await app.close();
    }
  });
});

describe("garbage the slot does not name", () => {
  it("INV-4: a lost commit answer is read back, and the previous token's surviving lookup and record are inert", async () => {
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

describe("the reconciliation deadline", () => {
  it("INV-7: a stalled read after the commit reports outcome_unknown by the deadline and starts nothing after it", async () => {
    const base = memoryStorage();
    const seed = new AccessTokenManager(base, { agents: ["simon"] });
    await seed.rotate("simon");
    const controller = new AbortController();
    const stall = latch();
    let committed = false;
    const { storage, calls } = counted(base, (operation, key) => {
      if (operation === "compareAndSet" && key === SLOT) {
        committed = true;
        controller.abort();
        return undefined;
      }
      return committed && key === SLOT ? stall.opened : undefined;
    });
    try {
      const started = Date.now();
      await expect(
        new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon", "operator", {
          signal: controller.signal,
          deadline: Date.now() + 300,
        }),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(Date.now() - started).toBeLessThan(1_500);
      const settled = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls.length).toBe(settled);
    } finally {
      stall.open();
    }
  });
});

describe("no request-path deletion", () => {
  it("INV-4: rotate, revoke and adopt never delete a lookup or record they did not just write", async () => {
    const base = await legacyStorage();
    const removed: string[] = [];
    const storage: KVStorage = {
      ...base,
      delete: async (key) => {
        removed.push(key);
        return base.delete(key);
      },
      compareAndSet: async (key, expected, next, options) => {
        if (next === null) removed.push(key);
        return base.compareAndSet(key, expected, next, options);
      },
    };
    const manager = new AccessTokenManager(storage, { agents: ["simon", "legacy"] });
    const lookups = async () => new Set(await base.list(LOOKUPS));
    for (const operation of [
      () => manager.rotate("simon"),
      () => manager.rotate("simon"),
      () => manager.revoke("simon"),
      () => manager.adopt(fixture.unbound.accessToken.id, "legacy"),
      () => manager.rotate("legacy"),
      () => manager.revoke("legacy"),
    ]) {
      const before = await lookups();
      await operation();
      const after = await lookups();
      for (const key of before) expect(after.has(key), key).toBe(true);
    }
    expect(removed).toEqual([]);
  });

  it("INV-4: a second agent cannot adopt a token another agent claimed mid-adoption, before or after it is retired", async () => {
    const base = await legacyStorage();
    const agents = { agents: ["first", "second"] };
    const firstSlot = "access-token:v1:agent:first";
    const atCommit = latch();
    const paused = latch();
    const firstStorage = hooked(base, {
      before: async (operation, key) => {
        if (operation === "compareAndSet" && key === firstSlot) {
          paused.open();
          await atCommit.opened;
        }
      },
    });
    const first = new AccessTokenManager(firstStorage, agents).adopt(fixture.unbound.accessToken.id, "first");
    await paused.opened;
    const manager = new AccessTokenManager(base, agents);
    await expect(manager.adopt(fixture.unbound.accessToken.id, "second")).rejects.toMatchObject({
      code: "not_adoptable",
    });
    atCommit.open();
    await expect(first).resolves.toMatchObject({ state: "issued" });
    expect(await manager.auth.authorize(request(fixture.unbound.token), BASE)).toMatchObject({
      ok: true,
      agent: "first",
    });
    // Retired by rotation, the legacy secret stays consumed.
    await manager.rotate("first");
    expect(await admits(manager, fixture.unbound.token)).toBe(false);
    await expect(manager.adopt(fixture.unbound.accessToken.id, "second")).rejects.toMatchObject({
      code: "not_adoptable",
    });
    expect((await manager.unboundTokens()).map((token) => token.id)).not.toContain(fixture.unbound.accessToken.id);
  });
});

describe("unacknowledged commits", () => {
  /** Apply a compare-and-set on `key`, then withhold its answer until released. */
  function withheld(base: KVStorage, key: string) {
    const release = latch();
    const applied = latch();
    const storage: KVStorage = {
      ...base,
      compareAndSet: async (candidate, expected, next, options) => {
        const result = await base.compareAndSet(candidate, expected, next, options);
        if (candidate !== key) return result;
        applied.open();
        await release.opened;
        return result;
      },
    };
    return { storage, release, applied };
  }

  const settles = (operation: Promise<unknown>) =>
    operation.then(
      () => "success",
      (error: { code?: string }) => error.code,
    );

  it("INV-7: an adoption whose applied commit is never acknowledged reports outcome_unknown, and a rerun completes it", async () => {
    const base = await legacyStorage();
    const { storage, release } = withheld(base, "access-token:v1:agent:legacy");
    try {
      const started = Date.now();
      const outcome = await settles(
        new AccessTokenManager(storage, { agents: ["legacy"] }).adopt(fixture.unbound.accessToken.id, "legacy", {
          deadline: Date.now() + 300,
        }),
      );
      expect(outcome).toBe("outcome_unknown");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      release.open();
    }
    const manager = new AccessTokenManager(base, { agents: ["legacy"] });
    expect(await admits(manager, fixture.unbound.token)).toBe(false);
    await expect(manager.adopt(fixture.unbound.accessToken.id, "legacy")).resolves.toMatchObject({ state: "issued" });
    expect(await admits(manager, fixture.unbound.token)).toBe(true);
  });
});

describe("adoption claims", () => {
  it("INV-4: a claim left by an aborted adoption lets the same agent resume and refuses another", async () => {
    const base = await legacyStorage();
    const controller = new AbortController();
    const storage = hooked(base, {
      after: (operation, key) => {
        if (operation === "compareAndSet" && key === `access-token:v1:adopted:${fixture.unbound.accessToken.id}`) {
          controller.abort();
        }
      },
    });
    const agents = { agents: ["a", "b"] };
    await expect(
      new AccessTokenManager(storage, agents).adopt(fixture.unbound.accessToken.id, "a", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(await base.get("access-token:v1:agent:a")).toBeNull();
    expect(JSON.parse((await base.get(`access-token:v1:adopted:${fixture.unbound.accessToken.id}`))!)).toEqual({
      version: 1,
      agent: "a",
    });
    const manager = new AccessTokenManager(base, agents);
    expect((await manager.unboundTokens()).map((token) => token.id)).not.toContain(fixture.unbound.accessToken.id);
    await expect(manager.adopt(fixture.unbound.accessToken.id, "b")).rejects.toMatchObject({ code: "not_adoptable" });
    await expect(manager.adopt(fixture.unbound.accessToken.id, "a")).resolves.toMatchObject({ state: "issued" });
    expect(await manager.auth.authorize(request(fixture.unbound.token), BASE)).toMatchObject({ ok: true, agent: "a" });
  });
});

describe("pre-commit acknowledgements", () => {
  /** Apply every write on a matching key, then withhold its answer until released; count every call. */
  function withholding(base: KVStorage, matches: (operation: Operation, key: string) => boolean) {
    const release = latch();
    const calls: string[] = [];
    const answer = async <T>(operation: Operation, key: string, applied: Promise<T>): Promise<T> => {
      calls.push(`${operation} ${key}`);
      const result = await applied;
      if (matches(operation, key)) await release.opened;
      return result;
    };
    const storage: KVStorage = {
      ...base,
      get: (key) => answer("get", key, base.get(key)),
      set: (key, value, options) => answer("set", key, base.set(key, value, options)),
      delete: (key) => answer("delete", key, base.delete(key)),
      compareAndSet: (key, expected, next, options) =>
        answer("compareAndSet", key, base.compareAndSet(key, expected, next, options)),
    };
    return { storage, calls, release };
  }

  /** Run `operation`, expect `code` within the deadline, then no further storage call. */
  async function boundedBy(operation: () => Promise<unknown>, calls: string[], code: string) {
    const started = Date.now();
    const outcome = await operation().then(
      () => "success",
      (error: { code?: string }) => error.code,
    );
    expect(outcome).toBe(code);
    expect(Date.now() - started).toBeLessThan(1_500);
    const settled = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.length).toBe(settled);
  }

  it.each([["record", RECORDS]])(
    "INV-7: a withheld %s write before a rotation's commit ends by the deadline and publishes nothing",
    async (_write, prefix) => {
      const base = memoryStorage();
      const seed = new AccessTokenManager(base, { agents: ["simon"] });
      const previous = await seed.rotate("simon");
      const slotBefore = await base.get(SLOT);
      const { storage, calls, release } = withholding(
        base,
        (operation, key) => operation === "set" && key.startsWith(prefix),
      );
      try {
        await boundedBy(
          () =>
            new AccessTokenManager(storage, { agents: ["simon"] }).rotate("simon", "operator", {
              deadline: Date.now() + 300,
            }),
          calls,
          "outcome_unknown",
        );
      } finally {
        release.open();
      }
      expect(await base.get(SLOT)).toBe(slotBefore);
      expect(await admits(seed, previous.token)).toBe(true);
    },
  );
});
