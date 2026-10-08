import type { FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthGrantKeys, oauthRefreshSpentKeys, oauthV2Keys } from "../src/storage/keys.js";
import type { Connector, ConnectorContext, KVStorage } from "../src/types.js";
import { createTestConnecta, required } from "./helpers.js";
import { connectorContext as ctx, deferred, spyLogger } from "./fixtures/misc.js";
import { bindCallback, callbackAuth, consentKey, storedGrant } from "./fixtures/oauth.js";

// Every interleaving below is driven through remoteMcp()'s own verifyState and
// finishAuth, so the SDK runs its real callback sequence: discovery, client,
// verifier, then the token request. Storage reads and writes are held on
// deferred promises at the exact point each race needs, never on a timer.
// Ported from #699's suite (#697) to layout 3: one grant record per owner and
// one flow record per consent (#707).

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const GRANT = oauthGrantKeys.grant;
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
    issue(code: string) {
      issuedCodes.add(code);
      return code;
    },
    /** Run `work` once a code exchange has reached the server, before it answers. */
    onExchange(work: () => Promise<void>) {
      whileOnTheWire = async () => {
        whileOnTheWire = undefined;
        await work();
      };
    },
    /** Token requests that carried `code`. */
    carrying: (code: string) => tokenRequests.filter((params) => params.get("code") === code).length,
  };
}

/**
 * memoryStorage as it is, or answering each operation a macrotask later on
 * either side, as D1 and SQLite do across a network or thread hop. Its
 * compare-and-set stays atomic; only the interleavings around it widen.
 */
function backingStore(remote: boolean): KVStorage {
  const storage = memoryStorage();
  if (!remote) return storage;
  const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const hop =
    <A extends unknown[], R>(op: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await turn();
      const result = await op(...args);
      await turn();
      return result;
    };
  return {
    capabilities: storage.capabilities,
    get: hop(storage.get),
    set: hop(storage.set),
    delete: hop(storage.delete),
    list: hop(storage.list),
    compareAndSet: hop(storage.compareAndSet),
  };
}

const STORES = [
  ["memory storage", false],
  ["a store a round trip away", true],
] as const;

const scope = (storage: KVStorage): ConnectorContext => ({ ...ctx(storage), requestScope: {} });
const connector = () => remoteMcp("svc", { url: mcpUrl, auth: { type: "oauth" }, versionNegotiation: "legacy" });

/** Start a fresh authorization and return its consent URL's state and epoch. */
async function started(c: Connector, storage: KVStorage) {
  const start = await c.startAuth!(scope(storage), { force: true });
  const url = new URL(required(start.authorizationUrl));
  return {
    state: required(url.searchParams.get("state") ?? undefined),
    epoch: required((await storedGrant(storage))?.epoch),
  };
}

/** A callback verified and ready to finish, as the callback route drives it. */
async function verified(c: Connector, storage: KVStorage, state: string) {
  const callback = scope(storage);
  expect(await c.verifyState!(state, callback)).toBe(true);
  return (code: string) =>
    c.finishAuth!(code, callback, new URLSearchParams({ code, state })).then(
      () => undefined,
      (error: unknown) => error,
    );
}

/** The tokens stored in `epoch`; none when another epoch is live. */
async function storedTokens(storage: KVStorage, epoch: string) {
  const grant = await storedGrant(storage);
  return grant?.epoch === epoch ? grant.body?.tokens : undefined;
}

/** Make a consent too old for Continue to hand back, as eleven minutes would. */
async function age(storage: KVStorage, state: string) {
  const key = await consentKey(state);
  const flow = JSON.parse(required((await storage.get(key)) ?? undefined)) as { at: number };
  flow.at = Date.now() - 11 * 60 * 1000;
  await storage.set(key, JSON.stringify(flow));
}

/**
 * How many grant reads a verified exchange makes before it claims its
 * consent, measured on a store of its own: the last of them is the read a
 * restart can race just before the claim.
 */
async function grantReadsBeforeClaim(): Promise<number> {
  const server = authorizationServer();
  vi.stubGlobal("fetch", server.fetchStub);
  const backing = memoryStorage();
  let counting = false;
  let reads = 0;
  const storage: KVStorage = {
    ...backing,
    async get(key) {
      if (counting && key === GRANT) reads++;
      return backing.get(key);
    },
    async compareAndSet(key, expected, next, options) {
      if (counting && key.startsWith("oauth:flow:")) counting = false;
      return backing.compareAndSet(key, expected, next, options);
    },
  };
  const c = connector();
  const { state } = await started(c, storage);
  const finish = await verified(c, storage, state);
  counting = true;
  expect(await finish(server.issue("calibration"))).toBeUndefined();
  vi.unstubAllGlobals();
  return reads;
}

/**
 * A view of `backing` that holds its `nth` grant read once armed: the value
 * is read first, then returned only after `release`, so whatever the holder
 * does next acts on what the grant was before.
 */
function holdingGrantRead(backing: KVStorage, nth: number) {
  let armed = false;
  let reads = 0;
  const reached = deferred<void>();
  const release = deferred<void>();
  const storage: KVStorage = {
    ...backing,
    async get(key) {
      const value = await backing.get(key);
      if (armed && key === GRANT && ++reads === nth) {
        armed = false;
        reached.resolve();
        await release.promise;
      }
      return value;
    },
  };
  return {
    storage,
    arm: () => {
      armed = true;
    },
    reached: reached.promise,
    release: () => release.resolve(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an OAuth callback's code exchange is fenced against restarts", () => {
  it.each(STORES)(
    "sends nothing when a restart lands while its last grant read before the claim is in flight, on %s",
    async (_label, remote) => {
      const nth = await grantReadsBeforeClaim();
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(remote);
      const held = holdingGrantRead(backing, nth);
      const c = connector();
      const { state, epoch } = await started(c, backing);
      const code = server.issue("code-a");
      const finish = await verified(c, held.storage, state);
      held.arm();

      const finishing = finish(code);
      await held.reached;
      const restarted = await started(c, backing);
      expect(restarted.epoch).not.toBe(epoch);
      held.release();

      const error = await finishing;
      expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(classifyCallError(error)).toMatchObject({ code: "unavailable", retryable: true });
      // Not the code, the verifier, or the client secret: no token request at all.
      expect(server.tokenRequests).toEqual([]);
      // The restart's flow is untouched and still completes.
      const next = await verified(c, backing, restarted.state);
      expect(await next(server.issue("code-b"))).toBeUndefined();
      expect(await storedTokens(backing, restarted.epoch)).toMatchObject({ access_token: "access-1" });
    },
  );

  it.each(STORES)(
    "sends nothing when a restart lands while the consent claim's answer is on its way back, on %s",
    async (_label, remote) => {
      // The claim commits; its answer is held; a restart completes; the
      // answer arrives. The final epoch check comes after the claim, so it
      // sees the restart.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(remote);
      let claimKey: string | undefined;
      const claimed = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = {
        ...backing,
        async compareAndSet(key, expected, next, options) {
          const won = await backing.compareAndSet(key, expected, next, options);
          if (key === claimKey) {
            claimKey = undefined;
            claimed.resolve();
            await release.promise;
          }
          return won;
        },
      };
      const c = connector();
      const { state } = await started(c, backing);
      const finish = await verified(c, storage, state);
      claimKey = await consentKey(state);

      const finishing = finish(server.issue("code-a"));
      await claimed.promise;
      await started(c, backing);
      release.resolve();

      const error = await finishing;
      expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(server.tokenRequests).toEqual([]);
    },
  );

  it.each(STORES)(
    "sends nothing when a restart lands while the final epoch read is in flight, on %s",
    async (_label, remote) => {
      // The read is issued after the claim and held before it reaches the
      // store; the restart publishes; the read then sees it.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(remote);
      let armed = false;
      let claimKey: string | undefined;
      const reading = deferred<void>();
      const release = deferred<void>();
      const storage: KVStorage = {
        ...backing,
        async get(key) {
          if (armed && key === GRANT) {
            armed = false;
            reading.resolve();
            await release.promise;
          }
          return backing.get(key);
        },
        async compareAndSet(key, expected, next, options) {
          const won = await backing.compareAndSet(key, expected, next, options);
          if (key === claimKey) armed = true;
          return won;
        },
      };
      const c = connector();
      const { state } = await started(c, backing);
      const finish = await verified(c, storage, state);
      claimKey = await consentKey(state);

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
    async (_label, remote) => {
      // The other side of the line: the code has left. Its tokens never land,
      // the callback still reports the supersession, and the restart's own
      // consent is untouched. That grant is the one more consent this costs.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const storage = backingStore(remote);
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const finish = await verified(c, storage, state);
      let restarted: Awaited<ReturnType<typeof started>> | undefined;
      server.onExchange(async () => {
        restarted = await started(c, storage);
      });

      const error = await finish(server.issue("code-a"));

      expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
      expect(server.carrying("code-a")).toBe(1);
      const restart = required(restarted);
      expect(await storedTokens(storage, epoch)).toBeUndefined();
      expect(await storedTokens(storage, restart.epoch)).toBeUndefined();
      expect((await storedGrant(storage))?.epoch).toBe(restart.epoch);
      expect(await (await verified(c, storage, restart.state))(server.issue("code-b"))).toBeUndefined();
      expect(await storedTokens(storage, restart.epoch)).toMatchObject({ access_token: "access-2" });
    },
  );

  it.each(STORES)(
    "keeps the grant a duplicate callback completed while the other was held before its claim, on %s",
    async (_label, remote) => {
      const nth = await grantReadsBeforeClaim();
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(remote);
      const held = holdingGrantRead(backing, nth);
      const c = connector();
      const { state, epoch } = await started(c, backing);
      const code = server.issue("code-a");
      // The browser delivers the same callback twice; both pass the state check.
      const finishHeld = await verified(c, held.storage, state);
      const finishFirst = await verified(c, backing, state);
      held.arm();

      const pending = finishHeld(code);
      await held.reached;
      expect(await finishFirst(code)).toBeUndefined();
      const completed = await storedTokens(backing, epoch);
      expect(completed).toMatchObject({ access_token: "access-1" });
      held.release();

      const error = await pending;
      expect(String(error)).toMatch(
        /authorization callback was already used by another request; nothing was exchanged/,
      );
      expect(classifyCallError(error)).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(server.carrying(code)).toBe(1);
      expect(await storedTokens(backing, epoch)).toEqual(completed);
      expect((await storedGrant(backing))?.epoch).toBe(epoch);
    },
  );

  it.each(STORES)(
    "redeems one code once when duplicate callbacks race to the exchange together, on %s",
    async (_label, remote) => {
      // Neither is held: all reach the fence in the same turn, and the claim
      // lets exactly one of them through.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const storage = backingStore(remote);
      const c = connector();
      const { state, epoch } = await started(c, storage);
      const code = server.issue("code-a");
      const callbacks = await Promise.all([
        verified(c, storage, state),
        verified(c, storage, state),
        verified(c, storage, state),
      ]);

      const outcomes = await Promise.all(callbacks.map((finish) => finish(code)));

      expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
      expect(server.carrying(code)).toBe(1);
      expect(await storedTokens(storage, epoch)).toMatchObject({ access_token: "access-1" });
    },
  );

  it("never discards the winner's grant when another consent's exchange is refused after it", async () => {
    // A second consent in the same epoch binds before the first completes,
    // then sends a code the server refuses. The SDK's recovery invalidates
    // tokens, but this exchange began with none, so it deletes nothing.
    const nth = await grantReadsBeforeClaim();
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(false);
    const held = holdingGrantRead(backing, nth);
    const c = connector();
    const first = await started(c, backing);
    await age(backing, first.state);
    const second = new URL(required((await c.startAuth!(scope(backing), { force: false })).authorizationUrl));
    const secondState = required(second.searchParams.get("state") ?? undefined);
    expect(secondState).not.toBe(first.state);
    const finishLoser = await verified(c, held.storage, secondState);
    const finishWinner = await verified(c, backing, first.state);
    held.arm();

    const loser = finishLoser("never-issued");
    await held.reached;
    expect(await finishWinner(server.issue("code-a"))).toBeUndefined();
    const completed = await storedTokens(backing, first.epoch);
    held.release();

    expect(((await loser) as { code?: unknown }).code).toBe("downstream_oauth_required");
    expect(server.carrying("never-issued")).toBe(1);
    expect(completed).toMatchObject({ access_token: "access-1" });
    expect(await storedTokens(backing, first.epoch)).toEqual(completed);
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

  it.each(STORES)("keeps tokens another flow wrote while the exchange was in flight, on %s", async (_label, remote) => {
    const nth = await grantReadsBeforeClaim();
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(remote);
    const held = holdingGrantRead(backing, nth);
    const c = connector();
    const { state, epoch } = await started(c, backing);
    await seedTokens(backing, "kept-before");
    const finish = await verified(c, held.storage, state);
    held.arm();

    // A code the server never issued: the exchange is refused.
    const finishing = finish("unknown-code");
    await held.reached;
    await seedTokens(backing, "written-meanwhile");
    held.release();

    const error = await finishing;
    expect((error as { code?: unknown }).code).toBe("downstream_oauth_required");
    expect(server.carrying("unknown-code")).toBe(1);
    expect(await storedTokens(backing, epoch)).toMatchObject({ access_token: "written-meanwhile" });
  });

  it.each(STORES)("still deletes the tokens it began with, on %s", async (_label, remote) => {
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = backingStore(remote);
    const c = connector();
    const { state, epoch } = await started(c, storage);
    await seedTokens(storage, "began-with");
    const finish = await verified(c, storage, state);

    const error = await finish("unknown-code");

    expect((error as { code?: unknown }).code).toBe("downstream_oauth_required");
    // Refused once, and the SDK's retry is answered with that refusal.
    expect(server.carrying("unknown-code")).toBe(1);
    expect(await storedTokens(storage, epoch)).toBeUndefined();
  });

  it.each(STORES)(
    "keeps the consent Continue started while an earlier callback's exchange was on the wire, on %s",
    async (_label, remote) => {
      // A's claim spent its consent, so Continue starts consent B in the same
      // epoch while A waits on the token endpoint. A then succeeds, and B is
      // still the one Continue hands back.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const storage = backingStore(remote);
      const c = connector();
      const first = await started(c, storage);
      const finish = await verified(c, storage, first.state);
      const sent = deferred<void>();
      const release = deferred<void>();
      server.onExchange(async () => {
        sent.resolve();
        await release.promise;
      });

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
    },
  );

  it.each(STORES)(
    "does not hand a consent URL whose state an exchange spent back to Continue, on %s",
    async (_label, remote) => {
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const storage = backingStore(remote);
      const c = connector();
      const first = await c.startAuth!(scope(storage), { force: true });
      const state = required(new URL(required(first.authorizationUrl)).searchParams.get("state") ?? undefined);
      const finish = await verified(c, storage, state);
      expect(((await finish("unknown-code")) as { code?: unknown }).code).toBe("downstream_oauth_required");

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.authorizationReused).toBeUndefined();
      const next = new URL(required(continued.authorizationUrl));
      expect(next.searchParams.get("state")).not.toBe(state);
      expect(next.searchParams.get("client_id")).toBe("client-1");
      // The new consent completes.
      const nextState = required(next.searchParams.get("state") ?? undefined);
      expect(await (await verified(c, storage, nextState))(server.issue("code-b"))).toBeUndefined();
    },
  );
});

describe("a completed exchange and a newer consent's records", () => {
  it.each(
    STORES.flatMap(([label, remote]) =>
      (["its flow record", "the grant's pointer to it"] as const).map((record) => [label, record, remote] as const),
    ),
  )(
    "leaves a newer consent intact when it publishes while A completes, on %s, holding %s",
    async (_label, record, remote) => {
      // A's exchange is on the wire when Continue starts consent B, which is
      // held just before it publishes one of its two writes. A completes and
      // stores its tokens; B then publishes. Both survive: A's write never
      // touches a consent, and B's pointer write retries over A's tokens.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(remote);
      const c = connector();
      const first = await started(c, backing);
      const finish = await verified(c, backing, first.state);
      const sent = deferred<void>();
      const answer = deferred<void>();
      server.onExchange(async () => {
        sent.resolve();
        await answer.promise;
      });
      const completing = finish(server.issue("code-a"));
      await sent.promise;
      const begunB = deferred<void>();
      const publishB = deferred<void>();
      let holding = true;
      const continuingStore: KVStorage = {
        ...backing,
        async compareAndSet(key, expected, next, options) {
          const target =
            record === "its flow record" ? key.startsWith("oauth:flow:") && expected === null : key === GRANT;
          if (holding && target) {
            holding = false;
            begunB.resolve();
            await publishB.promise;
          }
          return backing.compareAndSet(key, expected, next, options);
        },
      };
      const continuing = c.startAuth!(scope(continuingStore), { force: false });
      await begunB.promise;
      answer.resolve();
      expect(await completing).toBeUndefined();
      publishB.resolve();
      const next = new URL(required((await continuing).authorizationUrl));
      const stateB = required(next.searchParams.get("state") ?? undefined);
      const keyB = await consentKey(stateB);
      const flowB = await backing.get(keyB);

      expect(flowB).not.toBeNull();
      const grant = required(await storedGrant(backing));
      expect(grant.body?.tokens).toMatchObject({ access_token: "access-1" });
      expect(grant.flow).toBe(keyB.slice("oauth:flow:".length));
      expect(await c.startAuth!(scope(backing), { force: false })).toMatchObject({
        authorizationUrl: next.href,
        authorizationReused: true,
      });
      expect(await backing.get(keyB)).toBe(flowB);
      expect(await (await verified(c, backing, stateB))(server.issue("code-b"))).toBeUndefined();
    },
  );

  it.each(STORES)(
    "leaves a newer consent alone after an exchange no callback verified, on %s",
    async (_label, remote) => {
      // finishAuth driven without verifyState, over a consent too old to hand
      // back: Continue starts consent B while A is on the wire. A names its
      // consent by its callback's state and claims that one alone.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const storage = backingStore(remote);
      const c = connector();
      const first = await started(c, storage);
      await age(storage, first.state);
      const sent = deferred<void>();
      const release = deferred<void>();
      server.onExchange(async () => {
        sent.resolve();
        await release.promise;
      });
      const code = server.issue("code-a");
      const completing = c.finishAuth!(code, scope(storage), new URLSearchParams({ code, state: first.state }));
      await sent.promise;
      const next = new URL(required((await c.startAuth!(scope(storage), { force: false })).authorizationUrl));
      const stateB = required(next.searchParams.get("state") ?? undefined);
      expect(stateB).not.toBe(first.state);
      release.resolve();
      await completing;

      expect(await (await verified(c, storage, stateB))(server.issue("code-b"))).toBeUndefined();
    },
  );

  it("leaves another provider's consent alone when it verified none of its own", async () => {
    // A provider that neither verified a callback nor wrote a consent owns
    // nothing to claim or invalidate.
    const storage = memoryStorage();
    const writer = new KvOAuthProvider("svc", storage, REDIRECT);
    const state = await writer.state();
    await writer.saveCodeVerifier("theirs");
    await writer.redirectToAuthorization(new URL(`https://auth.example/authorize?state=${state}`));
    const stranger = new KvOAuthProvider("svc", storage, REDIRECT);
    await expect(stranger.bindFlow()).rejects.toThrow(/authorization changed/);
    await expect(stranger.claimCodeExchange()).rejects.toThrow(/authorization changed/);
    await stranger.invalidateCredentials("all");
    const owner = new KvOAuthProvider("svc", storage, REDIRECT);
    expect(await owner.verifyState(state)).toBe(true);
    expect(await owner.codeVerifier()).toBe("theirs");
  });

  it.each(STORES)("lets the next consent replace what a completed exchange left, on %s", async (_label, remote) => {
    // What the claim leaves is harmless: a claimed consent keeps neither its
    // URL nor its verifier, Continue never hands it back, and the consent it
    // starts instead has a record of its own.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const storage = backingStore(remote);
    const c = connector();
    const first = await started(c, storage);
    const firstKey = await consentKey(first.state);
    expect(await (await verified(c, storage, first.state))(server.issue("code-a"))).toBeUndefined();
    const left = JSON.parse(required((await storage.get(firstKey)) ?? undefined)) as Record<string, unknown>;
    expect(left).toMatchObject({ consumed: true });
    expect(left).not.toHaveProperty("verifier");
    expect(left).not.toHaveProperty("url");

    // Continue never hands back the spent consent.
    const again = await c.startAuth!(scope(storage), { force: false });
    expect(again.authorizationReused).toBeUndefined();
    // Once the grant is gone, as a refused refresh leaves it, Continue starts
    // a fresh consent in the same epoch.
    const grant = required(await storedGrant(storage));
    delete grant.body?.tokens;
    await storage.set(GRANT, JSON.stringify(grant));
    const continued = await c.startAuth!(scope(storage), { force: false });
    expect(continued.authorizationReused).toBeUndefined();
    const next = new URL(required(continued.authorizationUrl));
    const nextState = required(next.searchParams.get("state") ?? undefined);
    expect(nextState).not.toBe(first.state);
    expect((await storedGrant(storage))?.epoch).toBe(first.epoch);
    expect(await storage.get(await consentKey(nextState))).not.toBeNull();
    expect(await (await verified(c, storage, nextState))(server.issue("code-b"))).toBeUndefined();
  });
});

describe("a layout 2 migration racing a restart", () => {
  it.each([
    ["an epoch an earlier release published", "v2:unbound-epoch"],
    ["the legacy generation, under the historical key names", "legacy"],
  ] as const)(
    "never replaces the restart's grant, and Disconnect leaves nothing of it, migrating %s",
    async (_label, generation) => {
      // A passive call finds layout 2 and is held just before it writes the
      // migrated record. A restart then migrates too, runs start to finish, and
      // completes its consent. The held write lands last and loses its
      // compare-and-set; a later Disconnect leaves no trace of the restart.
      const server = authorizationServer();
      vi.stubGlobal("fetch", server.fetchStub);
      const backing = backingStore(false);
      const epoch = generation === "legacy" ? null : generation;
      if (epoch !== null) await backing.set(oauthV2Keys.generation, epoch);
      for (const [field, value] of [
        [oauthV2Keys.field.client, { client_id: "old-client", client_secret: "old-secret", redirect_uris: [REDIRECT] }],
        [oauthV2Keys.field.tokens, { access_token: "old-access", token_type: "Bearer", refresh_token: "old-refresh" }],
      ] as const) {
        await backing.set(
          oauthV2Keys.value(field, epoch),
          JSON.stringify({ connectaOAuthVersion: 2, generation, issuer, value }),
        );
      }
      let holding = true;
      const migrating = deferred<void>();
      const land = deferred<void>();
      const storage: KVStorage = {
        ...backing,
        async compareAndSet(key, expected, next, options) {
          if (holding && key === GRANT && expected === null) {
            holding = false;
            migrating.resolve();
            await land.promise;
          }
          return backing.compareAndSet(key, expected, next, options);
        },
      };
      const c = connector();

      const passive = c.listTools(scope(storage)).then(
        () => undefined,
        (error: unknown) => error,
      );
      await migrating.promise;
      const restart = await started(c, backing);
      expect(await (await verified(c, backing, restart.state))(server.issue("code-b"))).toBeUndefined();
      expect(await storedTokens(backing, restart.epoch)).toMatchObject({ access_token: "access-1" });
      land.resolve();
      await passive;
      // The migration's write lost: the restart's grant is the live one.
      expect((await storedGrant(backing))?.epoch).toBe(restart.epoch);
      expect(await storedTokens(backing, restart.epoch)).toBeDefined();

      await c.disconnectAuth!(scope(backing));

      const keys = await backing.list("");
      for (const key of keys) {
        if (!key.startsWith("oauth:refresh-spent:")) expect(key).not.toContain(restart.epoch);
        if (!key.startsWith("oauth:refresh-spent:")) expect(await backing.get(key), key).not.toContain(restart.epoch);
        expect(
          oauthV2Keys.family.prefixes.some((prefix) => key.startsWith(prefix)),
          key,
        ).toBe(false);
      }
      expect(keys).toEqual([GRANT, oauthRefreshSpentKeys.spent(await oauthStateDigest("refresh-1"))]);
    },
  );
});

describe("the callback route and a duplicate callback", () => {
  it("answers a duplicate that got past a renewed handoff as an already-used link, not as a refused exchange", async () => {
    // The route consumes its state handoff by compare-and-set, so a
    // duplicate needs a second handoff for the same state, as Continue
    // binds when it hands the same consent out again. The first callback is
    // held just before its claim; the duplicate completes; the first then
    // reaches the claim, which refuses it.
    const server = authorizationServer();
    vi.stubGlobal("fetch", server.fetchStub);
    const backing = backingStore(false);
    let holding = false;
    const reached = deferred<void>();
    const release = deferred<void>();
    const storage: KVStorage = {
      ...backing,
      async compareAndSet(key, expected, next, options) {
        if (holding && key.includes(":oauth:flow:") && expected !== null) {
          holding = false;
          reached.resolve();
          await release.promise;
        }
        return backing.compareAndSet(key, expected, next, options);
      },
    };
    const { logger, warnings } = spyLogger();
    const connecta = createTestConnecta({
      publicUrl: BASE,
      storage,
      logger,
      auth: callbackAuth,
      connectors: [connector()],
    });
    try {
      const c = required(connecta.registry.getConnector("svc"));
      const start = await c.startAuth!(connecta.registry.contextFor("svc", BASE), { force: true });
      const state = required(new URL(required(start.authorizationUrl)).searchParams.get("state") ?? undefined);
      await bindCallback(connecta, "svc", state);
      const callback = `${BASE}/oauth/callback/svc?code=${server.issue("code-a")}&state=${state}`;
      holding = true;

      const held = connecta.fetch(new Request(callback));
      await reached.promise;
      await bindCallback(connecta, "svc", state);
      const first = await connecta.fetch(new Request(callback));
      release.resolve();
      const duplicate = await held;

      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(400);
      expect(await duplicate.text()).toContain("Authorization could not be completed");
      expect(server.carrying("code-a")).toBe(1);
      expect(warnings().join("\n")).toMatch(
        /with 400: another callback had already claimed its state\. No authorization code was exchanged\./,
      );
      expect(warnings().join("\n")).not.toMatch(/with 500/);
    } finally {
      await connecta.close();
    }
  });
});
