import type { FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, oauthValueStorageKey } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, KVStorage } from "../src/types.js";
import { createTestConnecta, required } from "./helpers.js";
import { connectorContext as ctx, deferred, spyLogger } from "./fixtures/misc.js";

// Every interleaving below is driven through remoteMcp()'s own verifyState and
// finishAuth, so the SDK runs its real callback sequence: discovery, client,
// verifier, then the token request. Storage reads and writes are held on
// deferred promises at the exact point each race needs, never on a timer.

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const issuer = "https://auth.example";
const mcpUrl = "https://downstream.example/mcp";
const resourceMetadataUrl = "https://downstream.example/.well-known/oauth-protected-resource";

/**
 * An authorization server that redeems each code it issued once, as RFC 6749
 * section 4.1.2 requires, and answers `invalid_grant` for a code it has
 * already redeemed or never issued. Every token request is recorded.
 */
function authorizationServer() {
  const redeemed = new Set<string>();
  const issuedCodes = new Set<string>();
  const tokenRequests: URLSearchParams[] = [];
  let registered = 0;
  let issued = 0;
  let whileOnTheWire: (() => Promise<void>) | undefined;
  const fetchStub: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    if (url.href === resourceMetadataUrl) {
      return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
    }
    if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.href === `${issuer}/register`) {
      registered++;
      return Response.json({
        ...(JSON.parse(String(init.body)) as object),
        client_id: `client-${registered}`,
        client_secret: `secret-${registered}`,
      });
    }
    if (url.href === `${issuer}/token`) {
      const params = new URLSearchParams(String(init.body));
      tokenRequests.push(params);
      if (params.get("grant_type") === "authorization_code") {
        await whileOnTheWire?.();
        const code = params.get("code") ?? "";
        if (!issuedCodes.has(code) || redeemed.has(code)) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        redeemed.add(code);
      }
      issued++;
      return Response.json({
        access_token: `access-${issued}`,
        token_type: "Bearer",
        refresh_token: `refresh-${issued}`,
      });
    }
    if (url.href === mcpUrl) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
      });
    }
    throw new Error(`Unexpected OAuth test request: ${url.href}`);
  };
  return {
    fetchStub,
    tokenRequests,
    /** Consent at the server: a code it will redeem exactly once. */
    issue(code: string) { issuedCodes.add(code); return code; },
    /** Run `work` once a code exchange has reached the server, before it answers. */
    onExchange(work: () => Promise<void>) { whileOnTheWire = async () => { whileOnTheWire = undefined; await work(); }; },
    /** Token requests that carried `code`. */
    carrying: (code: string) => tokenRequests.filter((params) => params.get("code") === code).length,
  };
}

/** memoryStorage with or without its atomic compare-and-set. */
function backingStore(atomic: boolean): KVStorage {
  const storage = memoryStorage();
  if (atomic) return storage;
  const { compareAndSet: _omitted, ...withoutClaim } = storage;
  return withoutClaim;
}

const STORES = [
  ["a store with compareAndSet", true],
  ["a store without compareAndSet", false],
] as const;

const scope = (storage: KVStorage): ConnectorContext => ({ ...ctx(storage), requestScope: {} });
const connector = () =>
  remoteMcp("svc", { url: mcpUrl, auth: { type: "oauth" }, versionNegotiation: "legacy" });

/** Start a fresh authorization and return its consent URL's state and epoch. */
async function started(c: Connector, storage: KVStorage) {
  const start = await c.startAuth!(scope(storage), { force: true });
  const url = new URL(required(start.authorizationUrl));
  return {
    state: required(url.searchParams.get("state") ?? undefined),
    epoch: required((await storage.get("oauth:generation")) ?? undefined),
  };
}

/** A callback verified and ready to finish, as the callback route drives it. */
async function verified(c: Connector, storage: KVStorage, state: string) {
  const callback = scope(storage);
  expect(await c.verifyState!(state, callback)).toBe(true);
  return (code: string) =>
    c.finishAuth!(code, callback, new URLSearchParams({ code, state }))
      .then(() => undefined, (error: unknown) => error);
}

async function storedTokens(storage: KVStorage, epoch: string) {
  const raw = await storage.get(oauthValueStorageKey("oauth:tokens", epoch));
  return raw === null ? undefined : (JSON.parse(raw) as { value: { access_token: string } }).value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an OAuth callback's code exchange is fenced against restarts", () => {
  it.each(STORES)(
    "sends nothing when a restart lands between its verifier read's epoch check and the value, on %s",
    async (_label, atomic) => {
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(atomic);
      // The bound verifier read checks the live epoch beside its value read.
      // Hold the value until that check has completed, then restart.
      let holdKey: string | undefined;
      // The bind's own snapshot reads the verifier first; hold the SDK's read.
      let skipReads = 0;
      let holding = false;
      const valueRead = deferred<void>();
      const epochChecked = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = { ...backing,
        async get(key) {
          if (key === holdKey && skipReads-- <= 0) {
            holdKey = undefined;
            holding = true;
            const value = await backing.get(key);
            valueRead.resolve();
            await release.promise;
            holding = false;
            return value;
          }
          const value = await backing.get(key);
          if (holding && key === "oauth:generation") epochChecked.resolve();
          return value;
        },
      };
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const code = server.issue("code-a");
      const finish = await verified(c, storage, state);
      holdKey = oauthValueStorageKey("oauth:verifier", epoch);
      skipReads = 1;

      const finishing = finish(code);
      await valueRead.promise;
      await epochChecked.promise;
      const restarted = await started(c, storage);
      expect(restarted.epoch).not.toBe(epoch);
      release.resolve();

      const error = await finishing;
      expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(classifyCallError(error)).toMatchObject({ code: "unavailable", retryable: true });
      // Not the code, the verifier, or the client secret: no token request at all.
      expect(server.tokenRequests).toEqual([]);
      // The restart's flow is untouched and still completes.
      const next = await verified(c, storage, restarted.state);
      expect(await next(server.issue("code-b"))).toBeUndefined();
      expect(await storedTokens(storage, restarted.epoch)).toMatchObject({ access_token: "access-1" });
    },
  );

  it.each(STORES)(
    "sends nothing when a restart lands while the state claim's answer is on its way back, on %s",
    async (_label, atomic) => {
      // The claim commits; its answer is held; a restart completes; the
      // answer arrives. The final epoch check comes after the claim, so it
      // sees the restart.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(atomic);
      let stateKey: string | undefined;
      const claimed = deferred<void>();
      const release = deferred<void>();
      const hold = async <T>(answer: T) => {
        stateKey = undefined;
        claimed.resolve();
        await release.promise;
        return answer;
      };
      const storage: KVStorage = atomic
        ? { ...backing,
            async compareAndSet(key, expected, next, options) {
              const won = await backing.compareAndSet!(key, expected, next, options);
              return key === stateKey ? hold(won) : won;
            } }
        : { ...backing,
            async delete(key) {
              await backing.delete(key);
              if (key === stateKey) await hold(undefined);
            } };
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const finish = await verified(c, storage, state);
      stateKey = oauthValueStorageKey("oauth:state", epoch);

      const finishing = finish(server.issue("code-a"));
      await claimed.promise;
      await started(c, storage);
      release.resolve();

      const error = await finishing;
      expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(server.tokenRequests).toEqual([]);
    },
  );

  it.each(STORES)(
    "sends nothing when a restart lands while the final epoch read is in flight, on %s",
    async (_label, atomic) => {
      // The read is issued after the claim and held before it reaches the
      // store; the restart publishes; the read then sees it.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(atomic);
      let armed = false;
      let stateKey: string | undefined;
      const reading = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = { ...backing,
        async get(key) {
          if (armed && key === "oauth:generation") {
            armed = false;
            reading.resolve();
            await release.promise;
          }
          return backing.get(key);
        },
        ...(atomic
          ? { async compareAndSet(key: string, expected: string | null, next: string | null) {
              const won = await backing.compareAndSet!(key, expected, next);
              if (key === stateKey) armed = true;
              return won;
            } }
          : { async delete(key: string) {
              await backing.delete(key);
              if (key === stateKey) armed = true;
            } }),
      };
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const finish = await verified(c, storage, state);
      stateKey = oauthValueStorageKey("oauth:state", epoch);

      const finishing = finish(server.issue("code-a"));
      await reading.promise;
      await started(c, backing);
      release.resolve();

      expect(String(await finishing)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(server.tokenRequests).toEqual([]);
    },
  );

  it.each(STORES)(
    "saves nothing when a restart lands after the final check, while the request is on the wire, on %s",
    async (_label, atomic) => {
      // The other side of the line: the code has left. Its tokens never land
      // where any reader looks, the callback still reports the supersession,
      // and the restart's own consent is untouched. That grant is the one more
      // consent this costs.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const storage = backingStore(atomic);
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const finish = await verified(c, storage, state);
      let restarted: Awaited<ReturnType<typeof started>> | undefined;
      server.onExchange(async () => { restarted = await started(c, storage); });

      const error = await finish(server.issue("code-a"));

      expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(server.carrying("code-a")).toBe(1);
      const restart = required(restarted);
      expect(await storedTokens(storage, epoch)).toBeUndefined();
      expect(await storedTokens(storage, restart.epoch)).toBeUndefined();
      expect(await storage.get("oauth:generation")).toBe(restart.epoch);
      expect(await (await verified(c, storage, restart.state))(server.issue("code-b"))).toBeUndefined();
      expect(await storedTokens(storage, restart.epoch)).toMatchObject({ access_token: "access-2" });
    },
  );

  it.each(STORES)(
    "keeps the grant a duplicate callback completed while the other was held at its verifier read, on %s",
    async (_label, atomic) => {
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(atomic);
      let holdKey: string | undefined;
      // The bind's own snapshot reads the verifier first; hold the SDK's read.
      let skipReads = 0;
      const reached = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = { ...backing,
        async get(key) {
          const value = await backing.get(key);
          if (key === holdKey && skipReads-- <= 0) {
            holdKey = undefined;
            reached.resolve();
            await release.promise;
          }
          return value;
        },
      };
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const code = server.issue("code-a");
      // The browser delivers the same callback twice; both pass the state check.
      const finishHeld = await verified(c, storage, state);
      const finishFirst = await verified(c, storage, state);
      holdKey = oauthValueStorageKey("oauth:verifier", epoch);
      skipReads = 1;

      const held = finishHeld(code);
      await reached.promise;
      expect(await finishFirst(code)).toBeUndefined();
      const completed = await storedTokens(storage, epoch);
      expect(completed).toMatchObject({ access_token: "access-1" });
      release.resolve();

      const error = await held;
      expect(String(error)).toMatch(/authorization callback was already used by another request; nothing was exchanged/);
      expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(server.carrying(code)).toBe(1);
      expect(await storedTokens(storage, epoch)).toEqual(completed);
      expect(await storage.get("oauth:generation")).toBe(epoch);
    },
  );

  it("redeems one code once when duplicate callbacks race to the exchange together", async () => {
    // Neither is held: both reach the fence in the same turn, and the atomic
    // claim lets exactly one of them through.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = memoryStorage();
    const c = connector();
    const { state, epoch } = await started(c, storage);
    const code = server.issue("code-a");
    const callbacks = await Promise.all([verified(c, storage, state), verified(c, storage, state), verified(c, storage, state)]);

    const outcomes = await Promise.all(callbacks.map((finish) => finish(code)));

    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
    expect(server.carrying(code)).toBe(1);
    expect(await storedTokens(storage, epoch)).toMatchObject({ access_token: "access-1" });
  });

  it("never discards the winner's grant when a store without compareAndSet lets the loser send too", async () => {
    // Without an atomic claim, two callbacks can both pass the claim's read
    // before either deletes the state. Hold the loser right there, let the
    // winner complete, then let the loser redeem the spent code: the server
    // refuses it, and the SDK's recovery would delete the tokens it finds.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(false);
    let holdKey: string | undefined;
    let skipReads = 0;
    const reached = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = { ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key === holdKey && skipReads-- <= 0) {
          holdKey = undefined;
          reached.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const c = connector();
    const { state, epoch } = await started(c, storage);
    const code = server.issue("code-a");
    const finishLoser = await verified(c, storage, state);
    const finishWinner = await verified(c, storage, state);
    holdKey = oauthValueStorageKey("oauth:state", epoch);

    const loser = finishLoser(code);
    await reached.promise;
    expect(await finishWinner(code)).toBeUndefined();
    const completed = await storedTokens(storage, epoch);
    release.resolve();

    // The loser's one request was refused, and its failure deleted nothing:
    // it began before the winner wrote anything.
    expect(await loser).toBeInstanceOf(Error);
    expect(server.carrying(code)).toBe(2);
    expect(completed).toMatchObject({ access_token: "access-1" });
    expect(await storedTokens(storage, epoch)).toEqual(completed);
  });
});

describe("a refused code exchange invalidates only what it began with", () => {
  /** A grant already in the epoch the consent is written in, as an outage-kept one would be. */
  async function seedTokens(storage: KVStorage, accessToken: string) {
    await new KvOAuthProvider("svc", storage, REDIRECT).saveTokens(
      { access_token: accessToken, token_type: "Bearer", refresh_token: `${accessToken}-refresh` },
      { issuer },
    );
  }

  it.each(STORES)("keeps tokens another flow wrote while the exchange was in flight, on %s", async (_label, atomic) => {
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(atomic);
    let holdKey: string | undefined;
    // The bind's own snapshot reads the verifier first; hold the SDK's read.
    let skipReads = 0;
    const reached = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = { ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key === holdKey && skipReads-- <= 0) {
          holdKey = undefined;
          reached.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const c = connector();
    const { state, epoch } = await started(c, storage);
    await seedTokens(storage, "kept-before");
    const finish = await verified(c, storage, state);
    holdKey = oauthValueStorageKey("oauth:verifier", epoch);
    skipReads = 1;

    // A code the server never issued: the exchange is refused.
    const finishing = finish("unknown-code");
    await reached.promise;
    await seedTokens(storage, "written-meanwhile");
    release.resolve();

    const error = await finishing;
    expect((error as { code?: unknown }).code).toBe("invalid_grant");
    expect(server.carrying("unknown-code")).toBe(1);
    expect(await storedTokens(storage, epoch)).toMatchObject({ access_token: "written-meanwhile" });
  });

  it("still deletes the tokens it began with on a store with compareAndSet", async () => {
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = memoryStorage();
    const c = connector();
    const { state, epoch } = await started(c, storage);
    await seedTokens(storage, "began-with");
    const finish = await verified(c, storage, state);

    const error = await finish("unknown-code");

    expect((error as { code?: unknown }).code).toBe("invalid_grant");
    expect(await storedTokens(storage, epoch)).toBeUndefined();
  });

  it("keeps them on a store without compareAndSet, which cannot delete conditionally", async () => {
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = backingStore(false);
    const c = connector();
    const { state, epoch } = await started(c, storage);
    await seedTokens(storage, "began-with");
    const finish = await verified(c, storage, state);

    const error = await finish("unknown-code");

    expect((error as { code?: unknown }).code).toBe("invalid_grant");
    expect(await storedTokens(storage, epoch)).toMatchObject({ access_token: "began-with" });
  });

  it.each(STORES)("keeps the consent Continue started while an earlier callback's exchange was on the wire, on %s", async (_label, atomic) => {
    // A's claim spent its state, so Continue starts consent B in the same
    // epoch while A waits on the token endpoint. A then succeeds, and its
    // cleanup must take only its own consent's records, not B's.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = backingStore(atomic);
    const c = connector();
    const first = await started(c, storage);
    const finish = await verified(c, storage, first.state);
    const sent = deferred<void>();
    const release = deferred<void>();
    server.onExchange(async () => { sent.resolve(); await release.promise; });

    const completing = finish(server.issue("code-a"));
    await sent.promise;
    const continued = await c.startAuth!(scope(storage), { force: false });
    const next = new URL(required(continued.authorizationUrl));
    const nextState = required(next.searchParams.get("state") ?? undefined);
    expect(nextState).not.toBe(first.state);
    release.resolve();
    expect(await completing).toBeUndefined();

    const again = await c.startAuth!(scope(storage), { force: false });
    expect(again).toMatchObject({ authorizationUrl: next.href, authorizationReused: true });
    expect(await (await verified(c, storage, nextState))(server.issue("code-b"))).toBeUndefined();
    expect(await storedTokens(storage, first.epoch)).toMatchObject({ access_token: "access-2" });
  });

  it("does not hand a consent URL whose state an exchange spent back to Continue", async () => {
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = memoryStorage();
    const c = connector();
    const first = await c.startAuth!(scope(storage), { force: true });
    const state = required(new URL(required(first.authorizationUrl)).searchParams.get("state") ?? undefined);
    const finish = await verified(c, storage, state);
    expect((await finish("unknown-code") as { code?: unknown }).code).toBe("invalid_grant");

    const continued = await c.startAuth!(scope(storage), { force: false });

    expect(continued.authorizationReused).toBeUndefined();
    const next = new URL(required(continued.authorizationUrl));
    expect(next.searchParams.get("state")).not.toBe(state);
    expect(next.searchParams.get("client_id")).toBe("client-1");
    // The new consent completes.
    const nextState = required(next.searchParams.get("state") ?? undefined);
    expect(await (await verified(c, storage, nextState))(server.issue("code-b"))).toBeUndefined();
  });
});

describe("an entry retirement on a store without compareAndSet", () => {
  const manifestKey = (generation: string) => `oauth:cleanup:${encodeURIComponent(generation)}`;

  it.each([
    ["an epoch an earlier restart published", "v2:unbound-epoch"],
    ["the legacy generation, which has no record and no manifest", "legacy"],
  ] as const)("leaves nothing of a restart it replaced once Disconnect runs, retiring %s", async (_label, unbound) => {
    // A flow inspects an unbound grant and passes its retirement's recheck. A
    // restart then runs start to finish and completes its consent. Only then
    // does the retirement's generation write land, replacing the restart's
    // epoch, which no lineage names. A later Disconnect must still delete it.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(false);
    // A grant no issuer stamp binds: in a published epoch with its manifest,
    // or written before epochs existed, under the historical key names.
    if (unbound !== "legacy") {
      await backing.set("oauth:generation", unbound);
      await backing.set(manifestKey(unbound), "[]");
    }
    for (const [key, value] of [
      ["oauth:client", { client_id: "old-client", client_secret: "old-secret", redirect_uris: [REDIRECT] }],
      ["oauth:tokens", { access_token: "old-access", token_type: "Bearer", refresh_token: "old-refresh" }],
    ] as const) {
      await backing.set(
        oauthValueStorageKey(key, unbound),
        unbound === "legacy" ? JSON.stringify(value) : JSON.stringify({ connectaOAuthVersion: 2, generation: unbound, value }),
      );
    }
    let holdGeneration = true;
    const recheckPassed = deferred<void>();
    const land = deferred<void>();
    const storage: KVStorage = { ...backing,
      async set(key, value, options) {
        if (holdGeneration && key === "oauth:generation") {
          holdGeneration = false;
          recheckPassed.resolve();
          await land.promise;
        }
        await backing.set(key, value, options);
      },
    };
    const c = connector();

    const retiring = c.listTools(scope(storage)).then(() => undefined, (error: unknown) => error);
    await recheckPassed.promise;
    const restart = await started(c, storage);
    expect(await (await verified(c, storage, restart.state))(server.issue("code-b"))).toBeUndefined();
    expect(await storedTokens(storage, restart.epoch)).toMatchObject({ access_token: "access-1" });
    land.resolve();
    await retiring;
    // The stale write won: the restart's grant is unreachable, which only an
    // atomic swap could have prevented.
    expect(await storage.get("oauth:generation")).not.toBe(restart.epoch);

    await c.disconnectAuth!(scope(storage));

    const encoded = encodeURIComponent(restart.epoch);
    const keys = await storage.list!("");
    expect(keys.filter((key) => key.includes(restart.epoch) || key.includes(encoded))).toEqual([]);
    // What still names it is the live epoch's own cleanup lineage, as for any
    // epoch retired within the last day.
    const live = required((await storage.get("oauth:generation")) ?? undefined);
    const lineage = new Set([manifestKey(live), `oauth:cleanup-at:${encodeURIComponent(live)}`]);
    for (const key of keys) {
      if (lineage.has(key)) continue;
      expect(await storage.get(key), key).not.toContain(restart.epoch);
    }
  });
});

describe("the callback route and a duplicate callback", () => {
  it("answers the losing duplicate as an already-used link, not as a refused exchange", async () => {
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = memoryStorage();
    let holdKey: string | undefined;
      // The bind's own snapshot reads the verifier first; hold the SDK's read.
      let skipReads = 0;
    const reached = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = { ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key === holdKey && skipReads-- <= 0) {
          holdKey = undefined;
          reached.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const { logger, warnings } = spyLogger();
    const connecta = createTestConnecta({ publicUrl: BASE, storage, logger, connectors: [connector()] });
    try {
      const c = required(connecta.registry.getConnector("svc"));
      const start = await c.startAuth!(connecta.registry.contextFor("svc", BASE), { force: true });
      const state = required(new URL(required(start.authorizationUrl)).searchParams.get("state") ?? undefined);
      const epoch = required((await backing.get("conn:svc:oauth:generation")) ?? undefined);
      const callback = `${BASE}/oauth/callback/svc?code=${server.issue("code-a")}&state=${state}`;
      holdKey = `conn:svc:${oauthValueStorageKey("oauth:verifier", epoch)}`;
      skipReads = 1;

      const held = connecta.fetch(new Request(callback));
      await reached.promise;
      const first = await connecta.fetch(new Request(callback));
      release.resolve();
      const duplicate = await held;

      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(400);
      expect(await duplicate.text()).toContain("Authorization could not be completed");
      expect(server.carrying("code-a")).toBe(1);
      expect(warnings().join("\n")).toMatch(/with 400: another callback had already claimed its state\. No authorization code was exchanged\./);
      expect(warnings().join("\n")).not.toMatch(/with 500/);
    } finally {
      await connecta.close();
    }
  });
});
