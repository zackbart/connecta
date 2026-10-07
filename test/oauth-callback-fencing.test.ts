import type { FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, oauthValueStorageKey } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, KVStorage } from "../src/types.js";
import { required } from "./helpers.js";
import { connectorContext as ctx, deferred } from "./fixtures/misc.js";

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
      let holding = false;
      const valueRead = deferred<void>();
      const epochChecked = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = { ...backing,
        async get(key) {
          if (key === holdKey) {
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
    "keeps the grant a duplicate callback completed while the other was held at its verifier read, on %s",
    async (_label, atomic) => {
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(atomic);
      let holdKey: string | undefined;
      const reached = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = { ...backing,
        async get(key) {
          const value = await backing.get(key);
          if (key === holdKey) {
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
    const reached = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = { ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key === holdKey) {
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
    const reached = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = { ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key === holdKey) {
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

  it("leaves nothing of a restart it replaced once Disconnect runs", async () => {
    // A flow inspects an unbound grant and passes its retirement's recheck. A
    // restart then runs start to finish and completes its consent. Only then
    // does the retirement's generation write land, replacing the restart's
    // epoch, which no lineage names. A later Disconnect must still delete it.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(false);
    // An epoch published by an earlier restart, holding a grant no issuer stamp binds.
    const unbound = "v2:unbound-epoch";
    await backing.set("oauth:generation", unbound);
    await backing.set(manifestKey(unbound), "[]");
    for (const [key, value] of [
      ["oauth:client", { client_id: "old-client", client_secret: "old-secret", redirect_uris: [REDIRECT] }],
      ["oauth:tokens", { access_token: "old-access", token_type: "Bearer", refresh_token: "old-refresh" }],
    ] as const) {
      await backing.set(oauthValueStorageKey(key, unbound), JSON.stringify({ connectaOAuthVersion: 2, generation: unbound, value }));
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
