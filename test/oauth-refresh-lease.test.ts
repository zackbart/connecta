import { auth, UnauthorizedError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  OAUTH_REFRESH_LEASE_SECONDS,
  oauthGrantKeys,
  oauthRefreshActiveKeys,
  oauthRefreshKeys,
} from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { deferred } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";

const ISSUER = "https://issuer.example";
const REDIRECT = "https://connecta.test/oauth/callback/svc";
const tokens = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const next = { ...tokens, access_token: "new-access", refresh_token: "new-refresh" };
const init = {
  method: "POST",
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function store(delayed: boolean): KVStorage {
  const backing = memoryStorage();
  const hop =
    <Args extends unknown[], R>(op: (...args: Args) => Promise<R>) =>
    async (...args: Args): Promise<R> => {
      if (delayed) await pause();
      const answer = await op(...args);
      if (delayed) await pause();
      return answer;
    };
  return {
    get: hop(backing.get),
    set: hop(backing.set),
    delete: hop(backing.delete),
    list: hop(backing.list),
    compareAndSet: hop(backing.compareAndSet),
  };
}
async function isolate(storage: KVStorage, clock = Date.now, coordinator = new OAuthRefreshCoordinator()) {
  const provider = new KvOAuthProvider(
    "svc",
    storage,
    REDIRECT,
    coordinator,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clock,
  );
  await provider.beginFlow();
  await provider.tokens({ issuer: ISSUER });
  return { provider, coordinator, fetch: coordinator.coordinatedFetch.bind(coordinator, provider) };
}
async function leaseKey(storage: KVStorage) {
  return oauthRefreshKeys.lease((await storedGrant(storage))!.epoch, await oauthStateDigest(tokens.refresh_token));
}
/** Fire the production deadline deterministically, retaining its exact duration. */
function deadline(ms: number) {
  const entered = deferred<() => void>();
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number) => {
    if (delay === ms) entered.resolve(fn);
    return real(fn, delay);
  }) as typeof setTimeout);
  return entered.promise;
}
afterEach(() => vi.restoreAllMocks());

describe.each([
  ["memory", false],
  ["delayed", true],
] as const)("refresh dispatch leases on %s storage", (_label, delayed) => {
  it.each([31_000, 121_000])(
    "never resends a live holder's token after %i ms, including shared-storage expiry (INV-5)",
    async (elapsed) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const storage = store(delayed);
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const a = await isolate(storage);
      const b = await isolate(storage);
      const entered = deferred<void>();
      const gate = deferred<void>();
      const send = vi.fn(async () => {
        entered.resolve();
        await gate.promise;
        return Response.json(next);
      });
      const first = a
        .fetch(send)(`${ISSUER}/token`, init)
        .catch((error: unknown) => error);
      await entered.promise;
      const key = await leaseKey(storage);
      expect(JSON.parse((await storage.get(key))!)).toMatchObject({ state: "dispatched" });
      now += elapsed;
      const second = b
        .fetch(send)(`${ISSUER}/token`, init)
        .catch((error: unknown) => error);
      if (elapsed > OAUTH_REFRESH_LEASE_SECONDS * 1000) {
        expect(await second).toBeInstanceOf(UnauthorizedError);
        expect(await a.provider.storedTokens()).toBeUndefined();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      expect(send).toHaveBeenCalledTimes(1);
      gate.resolve();
      if (elapsed > OAUTH_REFRESH_LEASE_SECONDS * 1000) expect(await first).toBeInstanceOf(UnauthorizedError);
      else expect(((await first) as Response).status).toBe(200);
      if (elapsed < OAUTH_REFRESH_LEASE_SECONDS * 1000) expect(await second).toBeInstanceOf(Response);
      else expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([-300_000, 300_000])("ignores %i ms of contender clock skew for a dispatched lease (INV-5)", async (skew) => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const a = await isolate(storage, () => Date.now());
    const b = await isolate(storage, () => Date.now() + skew);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const send = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      return Response.json(next);
    });
    const first = a.fetch(send)(`${ISSUER}/token`, init);
    await entered.promise;
    const second = b.fetch(send)(`${ISSUER}/token`, init);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(send).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await storedGrant(storage))!.body!.tokens).toMatchObject(next);
  });

  it("takes over an expired claimed lease once and fences the unsent holder's dispatch CAS (INV-5)", async () => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const entered = deferred<void>();
    const gate = deferred<void>();
    let held = false;
    const slow: KVStorage = {
      ...storage,
      async set(key, value, opts) {
        if (!held && key.startsWith(oauthRefreshActiveKeys.prefix)) {
          held = true;
          entered.resolve();
          await gate.promise;
        }
        return storage.set(key, value, opts);
      },
    };
    const a = await isolate(slow, () => Date.now() - 300_000);
    const b = await isolate(storage);
    const send = vi.fn(async () => Response.json(next));
    const first = a
      .fetch(send)(`${ISSUER}/token`, init)
      .catch((error: unknown) => error);
    await entered.promise;
    expect(JSON.parse((await storage.get(await leaseKey(storage)))!)).toMatchObject({ state: "claimed" });
    expect((await b.fetch(send)(`${ISSUER}/token`, init)).status).toBe(200);
    gate.resolve();
    expect(await first).toMatchObject({ code: "unavailable", retryable: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps an expired dispatched fingerprint refused even after a later grant write (INV-5)", async () => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const key = await leaseKey(storage);
    const activeKey = oauthRefreshActiveKeys.holder((await storedGrant(storage))!.epoch, "crashed");
    await storage.set(
      key,
      JSON.stringify({
        connectaOAuthRefresh: 1,
        holder: "crashed",
        state: "dispatched",
        activeKey,
        expiresAt: Date.now() + 999_999,
      }),
    );
    // The liveness key has expired in storage, regardless of isolate clocks.
    const a = await isolate(storage, () => Date.now() - 300_000);
    const send = vi.fn(async () => Response.json(next));
    await expect(a.fetch(send)(`${ISSUER}/token`, init)).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
    expect(JSON.parse((await storage.get(key))!)).toMatchObject({ state: "dispatched", verdict: { kind: "dead" } });
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const later = await isolate(storage);
    await expect(later.fetch(send)(`${ISSUER}/token`, init)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"])(
    "bounds the refresh %s to 20 seconds and refuses an ambiguous token (INV-5) (INV-7)",
    async (phase) => {
      const storage = store(delayed);
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const a = await isolate(storage);
      const fire = deadline(20_000);
      const entered = deferred<void>();
      let requestSignal: AbortSignal | undefined;
      let cancelled = false;
      const gate = deferred<Response>();
      const send = vi.fn(async (_input: string | URL, request?: RequestInit) => {
        requestSignal = request?.signal ?? undefined;
        entered.resolve();
        if (phase === "fetch") return gate.promise;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      });
      const request = a
        .fetch(send)(`${ISSUER}/token`, init)
        .catch((error: unknown) => error);
      await entered.promise;
      // Let the response-body reader start before firing its deadline.
      await pause();
      (await fire)();
      expect(await request).toBeInstanceOf(Error);
      expect(requestSignal?.aborted).toBe(true);
      expect(a.provider.refreshVerdict()).toEqual({ kind: "dead" });
      expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
      if (phase === "fetch") {
        gate.resolve(Response.json(next));
        await pause();
      } else await vi.waitFor(() => expect(cancelled).toBe(true));
      const later = await isolate(storage);
      expect((await later.fetch(send)(`${ISSUER}/token`, init)).status).toBe(400);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 503])(
    "permanently refuses a lost HTTP %i response stream before newcomers can resend (INV-5)",
    async (status) => {
      const storage = store(delayed);
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const a = await isolate(storage);
      const b = await isolate(storage);
      const key = await leaseKey(storage);
      const send = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"access_token":"new-access",'));
                controller.error(new Error("Response body lost"));
              },
            }),
            { status },
          ),
      );
      await expect(a.fetch(send)(`${ISSUER}/token`, init)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(a.provider.refreshVerdict()).toEqual({ kind: "dead" });
      expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
      const refused = await storage.get(key);
      expect(JSON.parse(refused!)).toMatchObject({ state: "dispatched", verdict: { kind: "dead" } });
      await seedGrant(storage, { issuer: ISSUER, tokens });
      await expect(b.fetch(send)(`${ISSUER}/token`, init)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(await storage.get(key)).toBe(refused);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("returns retryable unavailable through SDK fallback when a waiter reaches 35 seconds, keeping the grant (INV-5)", async () => {
    const storage = store(delayed);
    await seedGrant(storage, {
      issuer: ISSUER,
      tokens,
      client: { value: { client_id: "client" } },
      discovery: {
        authorizationServerUrl: ISSUER,
        authorizationServerMetadata: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          response_types_supported: ["code"],
        },
      },
    });
    const key = await leaseKey(storage);
    const activeKey = oauthRefreshActiveKeys.holder((await storedGrant(storage))!.epoch, "holder");
    await storage.set(activeKey, "{}", { ttlSeconds: OAUTH_REFRESH_LEASE_SECONDS });
    await storage.set(
      key,
      JSON.stringify({
        connectaOAuthRefresh: 1,
        holder: "holder",
        state: "dispatched",
        activeKey,
        expiresAt: Date.now() - 1,
      }),
    );
    const a = await isolate(storage);
    const fire = deadline(35_000);
    const send = vi.fn(async () => Response.json(next));
    const request = auth(a.provider, {
      serverUrl: `${ISSUER}/mcp`,
      fetchFn: a.fetch(async (input) =>
        new URL(input).pathname === "/token" ? send() : new Response(null, { status: 404 }),
      ),
    }).catch((error: unknown) => error);
    (await fire)();
    const error = await request;
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect((await storedGrant(storage))!.body!.tokens).toEqual(tokens);
    expect(send).not.toHaveBeenCalled();
    expect(await a.provider.pendingAuthorizationUrl()).toBeUndefined();
  });

  it.each(["initial grant", "refresh record"])(
    "times out a cross-isolate waiter whose %s read is blocked, without a late dispatch (INV-5)",
    async (phase) => {
      const storage = store(delayed);
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const key = await leaseKey(storage);
      const gate = deferred<void>();
      const entered = deferred<void>();
      let blocked = false;
      const held: KVStorage = {
        ...storage,
        async get(readKey) {
          if (blocked && readKey === (phase === "initial grant" ? oauthGrantKeys.grant : key)) {
            entered.resolve();
            await gate.promise;
          }
          return storage.get(readKey);
        },
      };
      const a = await isolate(held);
      blocked = true;
      const fire = deadline(35_000);
      const send = vi.fn(async () => Response.json(next));
      const request = a
        .fetch(send)(`${ISSUER}/token`, init)
        .catch((error: unknown) => error);
      await entered.promise;
      (await fire)();
      expect(await request).toMatchObject({ code: "unavailable", retryable: true });
      expect((await storedGrant(storage))!.body!.tokens).toEqual(tokens);
      gate.resolve();
      await pause();
      expect(send).not.toHaveBeenCalled();
      expect(await storage.get(key)).toBeNull();
    },
  );

  it("times out a local joiner while its holder's commit is blocked, leaving the holder able to commit (INV-5)", async () => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const gate = deferred<void>();
    const entered = deferred<void>();
    const held: KVStorage = {
      ...storage,
      async compareAndSet(key, expected, value, opts) {
        if (key === oauthGrantKeys.grant && value?.includes(next.refresh_token)) {
          entered.resolve();
          await gate.promise;
        }
        return storage.compareAndSet(key, expected, value, opts);
      },
    };
    const a = await isolate(held);
    const send = vi.fn(async () => Response.json(next));
    const owner = a.fetch(send)(`${ISSUER}/token`, init);
    await entered.promise;
    const b = new KvOAuthProvider("svc", storage, REDIRECT, a.coordinator, false);
    await b.beginFlow();
    await b.tokens({ issuer: ISSUER });
    const fire = deadline(35_000);
    const waiter = a.coordinator
      .coordinatedFetch(b, send)(`${ISSUER}/token`, init)
      .catch((error: unknown) => error);
    (await fire)();
    expect(await waiter).toMatchObject({ code: "unavailable", retryable: true });
    await expect(b.state()).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect((await storedGrant(storage))!.body!.tokens).toEqual(tokens);
    gate.resolve();
    expect((await owner).status).toBe(200);
    expect((await storedGrant(storage))!.body!.tokens).toMatchObject(next);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("settles a cancelled unsent owner's local flight while grant reads and cleanup are blocked (INV-5)", async () => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const key = await leaseKey(storage);
    const entered = deferred<void>();
    const readGate = deferred<void>();
    const cleanupGate = deferred<void>();
    let claimed = false;
    let pins = 0;
    const coordinator = new OAuthRefreshCoordinator(() => {
      pins++;
      return () => {
        pins--;
      };
    });
    const held: KVStorage = {
      ...storage,
      async get(readKey) {
        if (claimed && readKey === oauthGrantKeys.grant) {
          entered.resolve();
          await readGate.promise;
        }
        return storage.get(readKey);
      },
      async compareAndSet(casKey, expected, value, opts) {
        if (casKey === key && value === null) await cleanupGate.promise;
        const won = await storage.compareAndSet(casKey, expected, value, opts);
        if (casKey === key && won && value?.includes('"state":"claimed"')) claimed = true;
        return won;
      },
    };
    const a = await isolate(held, Date.now, coordinator);
    const controller = new AbortController();
    const send = vi.fn(async () => Response.json(next));
    const owner = a
      .fetch(send, controller.signal)(`${ISSUER}/token`, init)
      .catch((error: unknown) => error);
    await entered.promise;
    expect(pins).toBe(1);
    controller.abort(new Error("caller left"));
    expect(await owner).toBe(controller.signal.reason);
    await vi.waitFor(() => expect(pins).toBe(0));
    expect(send).not.toHaveBeenCalled();
    expect((await storedGrant(storage))!.body!.tokens).toEqual(tokens);
    // A later local caller can safely replace the expired unsent claim.
    const b = await isolate(storage, () => Date.now() + 300_000, coordinator);
    expect((await b.fetch(send)(`${ISSUER}/token`, init)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pins).toBe(0);
    readGate.resolve();
    cleanupGate.resolve();
    await pause();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["liveness write", "cancel"],
    ["liveness write", "timeout"],
    ["dispatch CAS", "cancel"],
    ["dispatch CAS", "timeout"],
  ] as const)(
    "settles an unsent owner's flight when %s is blocked and the caller reaches %s (INV-5)",
    async (phase, end) => {
      const storage = store(delayed);
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const key = await leaseKey(storage);
      const entered = deferred<void>();
      const gate = deferred<void>();
      const cleanupGate = deferred<void>();
      let pins = 0;
      const coordinator = new OAuthRefreshCoordinator(() => {
        pins++;
        return () => {
          pins--;
        };
      });
      const held: KVStorage = {
        ...storage,
        async set(setKey, value, opts) {
          if (phase === "liveness write" && setKey.startsWith(oauthRefreshActiveKeys.prefix)) {
            entered.resolve();
            await gate.promise;
          }
          return storage.set(setKey, value, opts);
        },
        async compareAndSet(casKey, expected, value, opts) {
          if (casKey === key && value === null) await cleanupGate.promise;
          if (phase === "dispatch CAS" && casKey === key && value?.includes('"state":"dispatched"')) {
            entered.resolve();
            await gate.promise;
          }
          return storage.compareAndSet(casKey, expected, value, opts);
        },
      };
      const a = await isolate(held, Date.now, coordinator);
      const controller = new AbortController();
      const fire = end === "timeout" ? deadline(35_000) : undefined;
      const send = vi.fn(async () => Response.json(next));
      const owner = a
        .fetch(send, controller.signal)(`${ISSUER}/token`, init)
        .catch((error: unknown) => error);
      await entered.promise;
      expect(pins).toBe(1);
      if (fire) (await fire)();
      else controller.abort(new Error("caller left"));
      const error = await owner;
      if (end === "cancel") expect(error).toBe(controller.signal.reason);
      else expect(error).toMatchObject({ code: "unavailable", retryable: true });
      await vi.waitFor(() => expect(pins).toBe(0));
      expect(send).not.toHaveBeenCalled();
      expect((await storedGrant(storage))!.body!.tokens).toEqual(tokens);
      const b = await isolate(storage, () => Date.now() + 300_000, coordinator);
      expect((await b.fetch(send)(`${ISSUER}/token`, init)).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(pins).toBe(0);
      gate.resolve();
      cleanupGate.resolve();
      await pause();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});
