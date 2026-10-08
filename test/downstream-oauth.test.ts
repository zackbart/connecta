import { auth } from "@modelcontextprotocol/client";
import type {
  FetchLike,
  OAuthClientInformationFull,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KvOAuthProvider,
  OAuthCallbackClaimedError,
  oauthStateDigest,
} from "../src/auth/downstream-oauth.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { vaultOAuthSealer, type OAuthStateSealer } from "../src/oauth-sealing.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  OAUTH_FLOW_TTL_SECONDS,
  oauthConnectKeys,
  oauthFlowKeys,
  oauthGrantKeys,
  oauthV2Keys,
  type OAuthV2ValueKey,
} from "../src/storage/keys.js";
import type { KVStorage, Logger } from "../src/types.js";
import { required, silentLogger } from "./helpers.js";
import { deferred, spyLogger } from "./fixtures/misc.js";
import { consentKey, storedGrant } from "./fixtures/oauth.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";

// The provider over layout 3: one grant record per owner (`oauth:grant`) and
// one flow record per consent (`oauth:flow:<sha256(state)>`), and the one-shot
// migration from layout 2 (#707). The refresh coordinator and remoteMcp()'s
// flows have suites of their own.

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const GRANT = oauthGrantKeys.grant;
const ISSUER = "https://auth.example";
const ctxA = { issuer: ISSUER };
const ctxB = { issuer: "https://auth-b.example" };
const BINDING = "same-config";
const URL_CLIENT = `${BASE}/oauth-client.json`;
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const SUPERSEDED = /authorization changed while this request was in flight; try again/;

const tokens: OAuthTokens = {
  access_token: "secret-access",
  token_type: "Bearer",
  refresh_token: "secret-refresh",
};
const client: OAuthClientInformationFull = {
  client_id: "dcr-client",
  client_secret: "dcr-secret",
  redirect_uris: [REDIRECT],
};
const discovery: OAuthDiscoveryState = { authorizationServerUrl: ISSUER };

function provider(
  storage: KVStorage = memoryStorage(),
  opts: {
    sealer?: OAuthStateSealer;
    signal?: AbortSignal;
    binding?: string;
    clientMetadataUrl?: string;
    scope?: string;
  } = {},
): KvOAuthProvider {
  return new KvOAuthProvider(
    "svc", storage, REDIRECT, undefined, true, opts.sealer, opts.signal,
    opts.binding, undefined, opts.clientMetadataUrl, opts.scope,
  );
}

function sealerFor(
  key = CREDENTIAL_KEY,
  logger: Logger = silentLogger,
  connectorId = "svc",
  owner?: string,
): OAuthStateSealer {
  return required(vaultOAuthSealer(new CredentialVault(memoryStorage(), key), connectorId, owner, logger));
}

/** Publish a consent the way the SDK starts one: state, verifier, redirect. */
async function publish(
  p: KvOAuthProvider,
  verifier = "verifier",
  authorize = `${ISSUER}/authorize?client_id=dcr-client`,
): Promise<{ state: string; url: string }> {
  const state = await p.state();
  await p.saveCodeVerifier(verifier);
  const url = new URL(authorize);
  url.searchParams.set("state", state);
  await p.redirectToAuthorization(url);
  return { state, url: url.toString() };
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => undefined, (error: unknown) => error);
}

function expectSuperseded(error: unknown): void {
  expect(error).toBeInstanceOf(ConnectorCallError);
  expect(String(error)).toMatch(SUPERSEDED);
  expect(classifyCallError(error)).toMatchObject({ code: "unavailable", retryable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KvOAuthProvider over memoryStorage", () => {
  it("exposes redirectUrl and the connecta client metadata", () => {
    const p = provider(memoryStorage(), { scope: "read write" });
    expect(p.redirectUrl).toBe(REDIRECT);
    expect(p.clientMetadata).toEqual({
      redirect_uris: [REDIRECT],
      client_name: "connecta",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read write",
    });
    expect(provider().clientMetadata).not.toHaveProperty("scope");
  });

  it("round-trips client information (DCR)", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    expect(await p.clientInformation()).toBeUndefined();
    await p.saveClientInformation(client);
    expect(await p.clientInformation()).toEqual(client);
    expect(await provider(storage).clientInformation()).toEqual(client);
  });

  it("round-trips tokens", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens(tokens);
    expect(await p.tokens()).toEqual(tokens);
    expect(await provider(storage).tokens()).toEqual(tokens);
  });

  it("persists discovery state across OAuth callback request scopes", async () => {
    const storage = memoryStorage();
    const state: OAuthDiscoveryState = {
      authorizationServerUrl: ISSUER,
      resourceMetadataUrl: "https://downstream.example/.well-known/custom-protected-resource",
      resourceMetadata: {
        resource: "https://downstream.example/mcp",
        authorization_servers: [ISSUER],
      },
    };
    await provider(storage).saveDiscoveryState(state);
    await expect(provider(storage).discoveryState()).resolves.toEqual(state);
    // Discovery names the grant's server.
    expect((await storedGrant(storage))?.body).toEqual({ issuer: ISSUER, discovery: state });
  });

  it.each([false, true])("finishes OAuth from non-default metadata, URL client ID: %s", async (urlClient) => {
    const storage = memoryStorage();
    const mcpUrl = "https://downstream.example/mcp";
    const metadataUrl = "https://downstream.example/.well-known/custom-protected-resource/mcp";
    const makeProvider = () => provider(storage, {
      ...(urlClient ? { clientMetadataUrl: URL_CLIENT } : {}),
      scope: "full mcp",
    });
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      if (url.href === metadataUrl) {
        return Response.json({ resource: mcpUrl, authorization_servers: [ISSUER] });
      }
      if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: ISSUER,
          client_id_metadata_document_supported: urlClient,
          scopes_supported: ["full", "mcp", "offline_access"],
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === `${ISSUER}/register`) {
        expect(urlClient).toBe(false);
        expect(init.method).toBe("POST");
        return Response.json({
          client_id: "registered-client",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (url.href === `${ISSUER}/token`) {
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(URLSearchParams);
        expect((init.body as URLSearchParams).get("code")).toBe("auth-code");
        expect((init.body as URLSearchParams).get("client_id")).toBe(urlClient ? URL_CLIENT : "registered-client");
        return Response.json({ access_token: "access-token", token_type: "Bearer" });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };

    const start = makeProvider();
    await expect(
      auth(start, { serverUrl: mcpUrl, resourceMetadataUrl: new URL(metadataUrl), fetchFn: fetchStub }),
    ).resolves.toBe("REDIRECT");
    const pending = new URL(required(await start.pendingAuthorizationUrl()));
    expect(pending.searchParams.get("client_id")).toBe(urlClient ? URL_CLIENT : "registered-client");
    expect(pending.searchParams.get("scope")).toBe("full mcp offline_access");

    const callback = makeProvider();
    expect(await callback.verifyState(pending.searchParams.get("state"))).toBe(true);
    await expect(
      auth(callback, { serverUrl: mcpUrl, authorizationCode: "auth-code", fetchFn: fetchStub }),
    ).resolves.toBe("AUTHORIZED");
    await expect(callback.tokens()).resolves.toMatchObject({ access_token: "access-token" });
  });

  it("binds client registration and tokens to the validated authorization issuer", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    await p.saveClientInformation(client, ctxA);
    await p.saveTokens(tokens, ctxA);

    // An issuer-aware read hands back the stamp, so the SDK's own SEP-2352
    // check reads the value as bound rather than warning on the console.
    expect(await p.clientInformation(ctxA)).toEqual({ ...client, ...ctxA });
    expect(await p.tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
    // Token attachment has no issuer context: it reads the grant as stored.
    expect(await p.tokens()).toEqual(tokens);
    expect(await storedGrant(storage)).toEqual({
      connectaOAuth: 3,
      epoch: "initial",
      body: { issuer: ISSUER, client: { value: client }, tokens },
    });
  });

  it("keeps one server per grant: another issuer's write replaces the body, and its reads get nothing", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    await p.saveClientInformation(client, ctxA);
    await p.saveTokens(tokens, ctxA);
    await p.saveDiscoveryState(discovery);
    const before = await storage.get(GRANT);

    // A read for another server gets nothing, and changes nothing.
    expect(await p.clientInformation(ctxB)).toBeUndefined();
    expect(await p.tokens(ctxB)).toBeUndefined();
    expect(await storage.get(GRANT)).toBe(before);
    // Discovery for the same server keeps the client and tokens beside it.
    expect((await storedGrant(storage))?.body).toEqual({
      issuer: ISSUER, client: { value: client }, tokens, discovery,
    });

    // Tokens for another server replace the whole grant.
    const other = { access_token: "b-access", token_type: "Bearer" };
    await p.saveTokens(other, ctxB);
    expect((await storedGrant(storage))?.body).toEqual({ issuer: ctxB.issuer, tokens: other });
    expect(await p.clientInformation()).toBeUndefined();
    expect(await p.tokens(ctxA)).toBeUndefined();

    // So does discovery naming a third.
    await p.saveDiscoveryState({ authorizationServerUrl: "https://auth-c.example" });
    expect((await storedGrant(storage))?.body).toEqual({
      issuer: "https://auth-c.example",
      discovery: { authorizationServerUrl: "https://auth-c.example" },
    });
    expect(await p.tokens()).toBeUndefined();
    expect((await storedGrant(storage))?.epoch).toBe("initial");
  });

  it("round-trips the PKCE code verifier and throws when missing", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    await expect(p.codeVerifier()).rejects.toThrow(/verifier/i);
    await p.saveCodeVerifier("v-123");
    expect(await p.codeVerifier()).toBe("v-123");

    // Across request scopes it travels in its consent, found by state.
    const { state } = await publish(p, "v-456");
    const callback = provider(storage);
    await expect(callback.codeVerifier()).rejects.toThrow(/verifier/i);
    expect(await callback.verifyState(state)).toBe(true);
    expect(await callback.codeVerifier()).toBe("v-456");
  });

  it("stores the pending authorization URL and surfaces it", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    await p.redirectToAuthorization(new URL(`${ISSUER}/authorize?client_id=abc&state=xyz`));
    expect(await provider(storage).pendingAuthorizationUrl()).toBe(`${ISSUER}/authorize?client_id=abc&state=xyz`);
    expect(await p.consentUrl()).toBe(`${ISSUER}/authorize?client_id=abc&state=xyz`);
    expect(await provider(storage).verifyState("xyz")).toBe(true);
  });

  it("state() mints a random opaque value its stored consent verifies by digest", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    // Nothing stored yet: fail closed.
    expect(await p.verifyState("anything")).toBe(false);
    const s = await p.state();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    // Held in memory until its consent is published.
    expect(await provider(storage).verifyState(s)).toBe(false);
    await p.saveCodeVerifier("v");
    await p.redirectToAuthorization(new URL(`${ISSUER}/authorize?state=${s}`));

    // Stored under its digest, which the grant points at.
    const digest = await oauthStateDigest(s);
    expect(await storage.list(oauthFlowKeys.prefix)).toEqual([oauthFlowKeys.flow(digest)]);
    expect((await storedGrant(storage))?.flow).toBe(digest);
    expect(await storage.list("")).not.toContainEqual(expect.stringContaining(s));

    const callback = provider(storage);
    expect(await callback.verifyState(s)).toBe(true);
    expect(await callback.verifyState(`${s}x`)).toBe(false);
    const differentLast = s.endsWith("0") ? "1" : "0";
    expect(await callback.verifyState(s.slice(0, -1) + differentLast)).toBe(false);
    expect(await callback.verifyState(null)).toBe(false);
    expect(callback.verified()).toBe(false);
  });

  it("state() mints a fresh value each call; every published consent verifies until claimed", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    const a = await p.state();
    const b = await p.state();
    expect(a).not.toBe(b);
    // A state is nothing until its consent is published.
    expect(await provider(storage).verifyState(b)).toBe(false);

    const first = await publish(provider(storage), "first-verifier", `${ISSUER}/authorize?n=1`);
    const second = await publish(provider(storage), "second-verifier", `${ISSUER}/authorize?n=2`);
    // The grant points at the latest; both consents still complete.
    expect(await provider(storage).pendingAuthorizationUrl()).toBe(second.url);
    const callback = provider(storage);
    const duplicate = provider(storage);
    expect(await callback.verifyState(first.state)).toBe(true);
    expect(await duplicate.verifyState(first.state)).toBe(true);
    expect(await callback.codeVerifier()).toBe("first-verifier");
    expect(await provider(storage).verifyState(second.state)).toBe(true);

    // The exchange claims its consent: exactly one of two callbacks wins,
    // and the claimed record keeps only its epoch.
    await callback.bindFlow();
    expect(await callback.claimCodeExchange()).toBeUndefined();
    await duplicate.bindFlow();
    expect(await rejection(duplicate.claimCodeExchange())).toBeInstanceOf(OAuthCallbackClaimedError);
    expect(JSON.parse(required((await storage.get(await consentKey(first.state))) ?? undefined))).toEqual({
      connectaOAuthFlow: 1, epoch: "initial", at: expect.any(Number), consumed: true,
    });
    expect(await provider(storage).verifyState(first.state)).toBe(false);
    expect(await provider(storage).verifyState(second.state)).toBe(true);

    // Claiming the latest leaves nothing pending.
    const last = provider(storage);
    expect(await last.verifyState(second.state)).toBe(true);
    await last.bindFlow();
    await last.claimCodeExchange();
    expect(await provider(storage).pendingAuthorizationUrl()).toBeUndefined();
  });

  it("stores each consent with the link's fifteen-minute lifetime", async () => {
    const backing = memoryStorage();
    const ttls: Array<number | undefined> = [];
    const storage: KVStorage = { ...backing,
      compareAndSet(key, expected, next, options) {
        if (key.startsWith(oauthFlowKeys.prefix) && next !== null) ttls.push(options?.ttlSeconds);
        return backing.compareAndSet(key, expected, next, options);
      },
    };
    const before = Date.now();
    const { state } = await publish(provider(storage));
    const flow = JSON.parse(required((await backing.get(await consentKey(state))) ?? undefined)) as { at: number };
    expect(OAUTH_FLOW_TTL_SECONDS).toBe(900);
    expect(ttls).toEqual([OAUTH_FLOW_TTL_SECONDS]);
    expect(flow.at).toBeGreaterThanOrEqual(before);
    expect(flow.at).toBeLessThanOrEqual(Date.now());

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + (OAUTH_FLOW_TTL_SECONDS + 1) * 1000);
    expect(await provider(storage).verifyState(state)).toBe(false);
  });

  it("hands the latest consent back for Continue only while fresh and naming the grant's client", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    await p.saveClientInformation(client, ctxA);
    const { url } = await publish(p);
    expect(await provider(storage).reusablePendingAuthorizationUrl()).toBe(url);

    // Past ten minutes it is only pending.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000);
    expect(await provider(storage).reusablePendingAuthorizationUrl()).toBeUndefined();
    expect(await provider(storage).pendingAuthorizationUrl()).toBe(url);
    vi.restoreAllMocks();

    // A consent naming another client is not handed back.
    const other = await publish(provider(storage), "v", `${ISSUER}/authorize?client_id=other`);
    expect(await provider(storage).reusablePendingAuthorizationUrl()).toBeUndefined();
    expect(await provider(storage).pendingAuthorizationUrl()).toBe(other.url);
  });
});

describe("KvOAuthProvider epochs", () => {
  it("starts in the initial epoch; restarts publish fresh v3 epochs and beginFlow binds the live one", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    expect(await p.liveEpoch()).toBe("initial");
    await p.resetAuthorization();
    const first = await p.liveEpoch();
    await p.resetAuthorization();
    const second = await p.liveEpoch();
    expect(first).toMatch(/^v3:/);
    expect(second).toMatch(/^v3:/);
    expect(second).not.toBe(first);
    expect(await provider(storage).beginFlow()).toBe(second);
    // Invalidation is ordinary grant work; it never moves the epoch.
    await p.invalidateCredentials("all");
    expect(await p.liveEpoch()).toBe(second);
  });

  it("fails a bound flow's reads and writes after a restart with the retryable supersession", async () => {
    const storage = memoryStorage();
    const flow = provider(storage);
    const epoch = await flow.beginFlow();
    const restarter = provider(storage);
    await restarter.resetAuthorization();
    expect(await restarter.liveEpoch()).not.toBe(epoch);

    for (const work of [
      () => flow.saveTokens(tokens, ctxA),
      () => flow.saveClientInformation(client, ctxA),
      () => flow.saveDiscoveryState(discovery),
      () => flow.tokens(),
      () => flow.clientInformation(ctxA),
      () => flow.discoveryState(),
    ]) {
      expectSuperseded(await rejection(work()));
    }
    // A consent it starts is refused, and its flow record removed.
    expectSuperseded(await rejection(publish(flow)));
    expect(await storage.list(oauthFlowKeys.prefix)).toEqual([]);
    expect((await storedGrant(storage))?.body).toBeUndefined();
  });

  it("drops an unbound flow's write that a restart overtook, even mid-write", async () => {
    const backing = memoryStorage();
    const reached = deferred<void>();
    const release = deferred<void>();
    let hold = true;
    const storage: KVStorage = { ...backing,
      async compareAndSet(key, expected, next, options) {
        if (key === GRANT && hold) {
          hold = false;
          reached.resolve();
          await release.promise;
        }
        return backing.compareAndSet(key, expected, next, options);
      },
    };
    const stale = provider(storage);
    const late = stale.saveTokens({ access_token: "stale", token_type: "Bearer" });
    await reached.promise;
    const fresh = provider(backing);
    await fresh.resetAuthorization();
    await fresh.saveTokens(tokens);
    release.resolve();
    await late;

    expect((await storedGrant(backing))?.body).toEqual({ tokens });
    // Later writes from the overtaken flow land nowhere, quietly.
    await stale.saveTokens({ access_token: "resurrected", token_type: "Bearer" });
    await stale.saveClientInformation({ client_id: "resurrected" });
    expect((await storedGrant(backing))?.body).toEqual({ tokens });
    expect(await stale.tokens()).toEqual(tokens);
  });

  it("stores nothing a cancelled request was still writing", async () => {
    const backing = memoryStorage();
    const reached = deferred<void>();
    const release = deferred<void>();
    let hold = true;
    const storage: KVStorage = { ...backing,
      async get(key) {
        const value = await backing.get(key);
        if (key === GRANT && hold) {
          hold = false;
          reached.resolve();
          await release.promise;
        }
        return value;
      },
    };
    const controller = new AbortController();
    const p = provider(storage, { signal: controller.signal, binding: BINDING });
    const save = p.saveClientInformation({ client_id: "late" }, ctxA);
    await reached.promise;
    controller.abort();
    release.resolve();
    await save;
    // Nor does it publish a consent once cancelled.
    const state = await p.state();
    await p.redirectToAuthorization(new URL(`${ISSUER}/authorize?state=${state}`));
    expect(await p.consentUrl()).toBeUndefined();
    expect(await backing.list("")).toEqual([]);
  });

  it("restarts by one compare-and-set and sweeps every other epoch's consents", async () => {
    const backing = memoryStorage();
    const grantOps: string[] = [];
    let plant = false;
    const planted = oauthFlowKeys.flow("f".repeat(64));
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, options) => (key === GRANT && grantOps.push("set"), backing.set(key, value, options)),
      delete: (key) => (key === GRANT && grantOps.push("delete"), backing.delete(key)),
      compareAndSet: (key, expected, next, options) =>
        (key === GRANT && grantOps.push("compareAndSet"), backing.compareAndSet(key, expected, next, options)),
      async list(prefix) {
        if (plant && prefix === oauthFlowKeys.prefix) {
          // A consent the new epoch began while the sweep was starting.
          const live = required((await storedGrant(backing))?.epoch);
          await backing.set(planted, JSON.stringify({ connectaOAuthFlow: 1, epoch: live, at: Date.now(), url: `${ISSUER}/live` }));
        }
        return backing.list(prefix);
      },
    };
    const p = provider(storage);
    await p.saveTokens(tokens, ctxA);
    const old = await publish(p);
    const older = oauthFlowKeys.flow("e".repeat(64));
    await backing.set(older, JSON.stringify({ connectaOAuthFlow: 1, epoch: "v3:older", at: Date.now(), url: `${ISSUER}/older` }));

    grantOps.length = 0;
    plant = true;
    await provider(storage).resetAuthorization();

    expect(grantOps).toEqual(["compareAndSet"]);
    const grant = required(await storedGrant(backing));
    expect(grant).toEqual({ connectaOAuth: 3, epoch: expect.stringMatching(/^v3:/) });
    expect(await backing.get(await consentKey(old.state))).toBeNull();
    expect(await backing.get(older)).toBeNull();
    expect(await backing.get(planted)).not.toBeNull();
    expect(await provider(backing).verifyState(old.state)).toBe(false);
  });

  it("disconnects to a tombstone epoch nothing passive writes into until a restart replaces it", async () => {
    const storage = memoryStorage();
    const p = provider(storage, { binding: BINDING });
    await p.saveClientInformation(client, ctxA);
    await p.saveTokens(tokens, ctxA);
    // A disconnect never carries the registration.
    await p.resetAuthorization(true, true);
    const tombstone = required(await storedGrant(storage));
    expect(tombstone).toEqual({ connectaOAuth: 3, epoch: expect.stringMatching(/^disconnected:/) });
    expect(await p.operatorDisconnected()).toBe(true);
    expect(p.isOperatorDisconnectedEpoch(tombstone.epoch)).toBe(true);

    const passive = provider(storage);
    expect(await passive.beginFlow()).toBe(tombstone.epoch);
    await passive.saveTokens(tokens, ctxA);
    await provider(storage).saveDiscoveryState(discovery);
    expect(await storedGrant(storage)).toEqual(tombstone);

    await provider(storage).resetAuthorization();
    expect(await p.operatorDisconnected()).toBe(false);
  });

  /** A grant whose client, tokens, and discovery a configured provider stored for `ctxA`. */
  async function granted(storage: KVStorage, extra: Partial<OAuthClientInformationFull> = {}) {
    const p = provider(storage, { binding: BINDING });
    await p.saveDiscoveryState(discovery);
    await p.saveClientInformation({ ...client, ...extra }, ctxA);
    await p.saveTokens(tokens, ctxA);
  }

  it.each<{ held: string; carried: boolean; setup: (storage: KVStorage) => Promise<void>; binding?: string | null }>([
    { held: "an issuer-bound client registered under this configuration", carried: true, setup: (s) => granted(s) },
    { held: "a client whose secret never expires", carried: true, setup: (s) => granted(s, { client_secret_expires_at: 0 }) },
    {
      held: "a carried client that has earned tokens since",
      carried: true,
      setup: async (s) => {
        await granted(s);
        await provider(s, { binding: BINDING }).resetAuthorization(false, true);
        await provider(s).saveTokens(tokens, ctxA);
      },
    },
    {
      held: "a carried client that earned no tokens",
      carried: false,
      setup: async (s) => {
        await granted(s);
        await provider(s, { binding: BINDING }).resetAuthorization(false, true);
      },
    },
    { held: "a client stored with no issuer", carried: false, setup: (s) => provider(s, { binding: BINDING }).saveClientInformation(client) },
    { held: "a client registered under another configuration", carried: false, setup: (s) => provider(s, { binding: "old-config" }).saveClientInformation(client, ctxA) },
    { held: "a client while no binding is configured", carried: false, setup: (s) => granted(s), binding: null },
    {
      held: "a client whose secret has expired",
      carried: false,
      setup: (s) => granted(s, { client_secret_expires_at: Math.floor(Date.now() / 1000) - 60 }),
    },
    {
      held: "a URL-based client",
      carried: false,
      setup: (s) => provider(s, { binding: BINDING, clientMetadataUrl: URL_CLIENT }).saveClientInformation({ client_id: URL_CLIENT }, ctxA),
    },
  ])("a restart that preserves the client, holding $held, carries it: $carried", async ({ carried, setup, binding }) => {
    const storage = memoryStorage();
    await setup(storage);
    const before = (await storedGrant(storage))?.body?.client;
    await provider(storage, {
      ...(binding === null ? {} : { binding: binding ?? BINDING }),
      clientMetadataUrl: URL_CLIENT,
    }).resetAuthorization(false, true);
    const grant = required(await storedGrant(storage));
    expect(grant.epoch).toMatch(/^v3:/);
    if (!carried) {
      expect(grant.body).toBeUndefined();
      return;
    }
    // Only the registration, marked carried; never tokens or discovery.
    expect(grant.body).toEqual({
      issuer: ISSUER,
      client: { value: required(before).value, binding: BINDING, carried: true },
    });
    expect(await provider(storage).clientInformation(ctxA)).toMatchObject({ client_id: client.client_id });
  });

  it("invalidateCredentials is scoped", async () => {
    const seeded = async () => {
      const p = provider(memoryStorage());
      await p.saveClientInformation(client, ctxA);
      await p.saveTokens(tokens, ctxA);
      await p.saveDiscoveryState(discovery);
      await p.saveCodeVerifier("v-123");
      return p;
    };
    const present = async (p: KvOAuthProvider) => ({
      client: (await p.clientInformation()) !== undefined,
      tokens: (await p.tokens()) !== undefined,
      discovery: (await p.discoveryState()) !== undefined,
    });
    const cases = {
      tokens: { client: true, tokens: false, discovery: true },
      client: { client: false, tokens: true, discovery: true },
      discovery: { client: true, tokens: true, discovery: false },
      // The verifier lives in its consent, which the exchange's claim spends.
      verifier: { client: true, tokens: true, discovery: true },
      all: { client: false, tokens: false, discovery: false },
    } as const;
    for (const [scope, expected] of Object.entries(cases)) {
      const p = await seeded();
      await p.invalidateCredentials(scope as keyof typeof cases);
      expect({ scope, ...(await present(p)) }).toEqual({ scope, ...expected });
    }
  });

  it("invalidates only the client and tokens this flow saw, and nothing in a newer epoch", async () => {
    const storage = memoryStorage();
    const writer = provider(storage);
    await writer.saveClientInformation(client, ctxA);
    await writer.saveTokens(tokens, ctxA);
    await writer.saveDiscoveryState(discovery);

    const flow = provider(storage);
    await flow.beginFlow();
    await flow.clientInformation(ctxA);
    await flow.tokens(ctxA);
    // Another request stores newer tokens meanwhile.
    const newer = { access_token: "newer", token_type: "Bearer", refresh_token: "newer-refresh" };
    await provider(storage).saveTokens(newer, ctxA);
    await flow.invalidateCredentials("all");
    expect((await storedGrant(storage))?.body).toEqual({ issuer: ISSUER, tokens: newer });

    // A flow that read nothing removes nothing.
    await provider(storage).invalidateCredentials("tokens");
    expect((await storedGrant(storage))?.body?.tokens).toEqual(newer);

    // A flow a restart overtook removes nothing from the new epoch, quietly.
    const stale = provider(storage);
    await stale.beginFlow();
    await stale.tokens(ctxA);
    const fresh = provider(storage);
    await fresh.resetAuthorization();
    await fresh.saveTokens(newer, ctxA);
    await fresh.saveDiscoveryState(discovery);
    await expect(stale.invalidateCredentials("all")).resolves.toBeUndefined();
    expect((await storedGrant(storage))?.body).toEqual({ issuer: ISSUER, tokens: newer, discovery });
  });

  it("fails a superseded consent link once its epoch is no longer live", async () => {
    const storage = memoryStorage();
    const start = provider(storage);
    await start.beginFlow();
    const { url } = await publish(start);
    expect(await start.consentUrl()).toBe(url);
    await provider(storage).resetAuthorization();
    expectSuperseded(await rejection(start.consentUrl()));
  });
});

// Tokens, client registration, and discovery (the grant body) and the PKCE
// verifier are ciphertext at rest when the deployment has a vault that seals.
describe("KvOAuthProvider sealed state", () => {
  it("seals the grant body and the verifier; the flow's URL and epoch stay plaintext", async () => {
    const storage = memoryStorage();
    const sealer = sealerFor();
    const p = provider(storage, { sealer });
    await p.saveDiscoveryState(discovery);
    await p.saveClientInformation(client, ctxA);
    await p.saveTokens(tokens, ctxA);
    const { state, url } = await publish(p, "secret-verifier");

    const grantRaw = required((await storage.get(GRANT)) ?? undefined);
    const flowRaw = required((await storage.get(await consentKey(state))) ?? undefined);
    expect(JSON.parse(grantRaw)).toEqual({
      connectaOAuth: 3,
      epoch: "initial",
      flow: await oauthStateDigest(state),
      sealed: expect.stringMatching(/^v1\./),
    });
    expect(JSON.parse(flowRaw)).toEqual({
      connectaOAuthFlow: 1,
      epoch: "initial",
      at: expect.any(Number),
      url,
      verifier: expect.stringMatching(/^v1\./),
      sealed: true,
    });
    for (const secret of ["secret-access", "secret-refresh", "dcr-secret", "dcr-client", ISSUER]) {
      expect(grantRaw).not.toContain(secret);
    }
    expect(flowRaw).not.toContain("secret-verifier");

    const reader = provider(storage, { sealer: sealerFor() });
    expect(await reader.tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
    expect(await reader.clientInformation(ctxA)).toEqual({ ...client, ...ctxA });
    expect(await reader.discoveryState()).toEqual(discovery);
    expect(await reader.verifyState(state)).toBe(true);
    expect(await reader.codeVerifier()).toBe("secret-verifier");

    // Without the sealer the ciphertext is nothing a caller could use; the
    // pending URL, plaintext, is still there.
    const unsealed = provider(storage);
    expect(await unsealed.tokens()).toBeUndefined();
    expect(await unsealed.clientInformation()).toBeUndefined();
    expect(await unsealed.discoveryState()).toBeUndefined();
    expect(await unsealed.verifyState(state)).toBe(false);
    expect(await unsealed.pendingAuthorizationUrl()).toBe(url);
  });

  it("reads tampered or foreign-key ciphertext as absent, and warns without the secret", async () => {
    const storage = memoryStorage();
    const { state } = await publish(provider(storage, { sealer: sealerFor() }), "secret-verifier");
    await provider(storage, { sealer: sealerFor() }).saveTokens(tokens, ctxA);
    const sealed = required((await storage.get(GRANT)) ?? undefined);

    const wrongKey = spyLogger();
    expect(await provider(storage, { sealer: sealerFor(OTHER_KEY, wrongKey.logger) }).tokens()).toBeUndefined();
    expect(wrongKey.warnings().join("\n")).toMatch(/"svc" has a sealed OAuth grant/);

    // Flip one base64 digit in the ciphertext's middle: still well-formed,
    // no longer authentic.
    const flip = (value: string) => {
      const at = Math.floor(value.length * 0.75);
      return value.slice(0, at) + (value[at] === "A" ? "B" : "A") + value.slice(at + 1);
    };
    const envelope = JSON.parse(sealed) as { sealed: string };
    await storage.set(GRANT, JSON.stringify({ ...envelope, sealed: flip(envelope.sealed) }));
    const tampered = spyLogger();
    expect(await provider(storage, { sealer: sealerFor(CREDENTIAL_KEY, tampered.logger) }).tokens()).toBeUndefined();
    expect(tampered.warnings()).toHaveLength(1);

    // A tampered verifier refuses its callback.
    const key = await consentKey(state);
    const flow = JSON.parse(required((await storage.get(key)) ?? undefined)) as { verifier: string };
    await storage.set(key, JSON.stringify({ ...flow, verifier: flip(flow.verifier) }));
    const consent = spyLogger();
    expect(await provider(storage, { sealer: sealerFor(CREDENTIAL_KEY, consent.logger) }).verifyState(state)).toBe(false);
    expect(consent.warnings().join("\n")).toMatch(/"svc" has a sealed OAuth consent/);

    for (const warning of [...wrongKey.warnings(), ...tampered.warnings(), ...consent.warnings()]) {
      expect(warning).not.toContain("secret-access");
      expect(warning).not.toContain("secret-verifier");
      expect(warning).not.toContain(envelope.sealed);
      expect(warning).not.toContain(flow.verifier);
    }
  });

  it("does not open a sealed grant moved to another connector, owner, or epoch", async () => {
    const storage = memoryStorage();
    await provider(storage, { sealer: sealerFor() }).saveTokens(tokens, ctxA);
    const raw = required((await storage.get(GRANT)) ?? undefined);
    expect(await provider(storage, { sealer: sealerFor() }).tokens()).toEqual(tokens);

    for (const sealer of [
      sealerFor(CREDENTIAL_KEY, silentLogger, "other"),
      sealerFor(CREDENTIAL_KEY, silentLogger, "svc", "owner-a"),
    ]) {
      const elsewhere = memoryStorage();
      await elsewhere.set(GRANT, raw);
      expect(await provider(elsewhere, { sealer }).tokens()).toBeUndefined();
    }
    await storage.set(GRANT, JSON.stringify({ ...JSON.parse(raw), epoch: "v3:elsewhere" }));
    expect(await provider(storage, { sealer: sealerFor() }).tokens()).toBeUndefined();
  });

  it("reseals a carried registration under the new epoch", async () => {
    const storage = memoryStorage();
    const p = provider(storage, { sealer: sealerFor(), binding: BINDING });
    await p.saveClientInformation(client, ctxA);
    const first = required(await storedGrant(storage));

    await p.resetAuthorization(false, true);
    const second = required(await storedGrant(storage));
    expect(second.epoch).toMatch(/^v3:/);
    expect(second.sealed).toEqual(expect.stringMatching(/^v1\./));
    expect(second.sealed).not.toBe(first.sealed);
    expect(second.body).toBeUndefined();
    await expect(p.clientInformation(ctxA)).resolves.toEqual({ ...client, ...ctxA });

    await p.resetAuthorization(true);
    expect(await p.clientInformation(ctxA)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layout 2 (0.22 through 0.28): six values per epoch at `oauth:<field>`,
// suffixed `:epoch:<generation>` once a `v2:` generation owned them. The first
// grant read that finds no record migrates it, then deletes it.
// ---------------------------------------------------------------------------
describe("layout 2 migration", () => {
  const F = oauthV2Keys.field;
  const v2 = (generation: string, value: unknown, stamp: Record<string, unknown> = {}) =>
    JSON.stringify({ connectaOAuthVersion: 2, generation, ...stamp, value });

  /** Seed one generation's values; `legacy` writes the unsuffixed keys and no generation. */
  async function seedV2(
    storage: KVStorage,
    generation: string,
    values: Partial<Record<OAuthV2ValueKey, string>>,
  ): Promise<void> {
    if (generation !== "legacy") await storage.set(oauthV2Keys.generation, generation);
    const epoch = generation.startsWith("v2:") ? generation : null;
    for (const [field, raw] of Object.entries(values)) {
      await storage.set(oauthV2Keys.value(field as OAuthV2ValueKey, epoch), raw);
    }
  }

  /** A connector namespace inside another partition of `backing`. */
  function partition(backing: KVStorage, prefix: string): KVStorage {
    return {
      get: (key) => backing.get(prefix + key),
      set: (key, value, options) => backing.set(prefix + key, value, options),
      delete: (key) => backing.delete(prefix + key),
      list: async (p) => (await backing.list(prefix + p)).map((key) => key.slice(prefix.length)),
      compareAndSet: (key, expected, next, options) => backing.compareAndSet(prefix + key, expected, next, options),
    };
  }

  it("migrates a legacy grant from stamped envelopes, discovery bare, and carries no consent", async () => {
    const storage = memoryStorage();
    await seedV2(storage, "legacy", {
      [F.client]: v2("legacy", client, { issuer: ISSUER, binding: BINDING }),
      [F.tokens]: v2("legacy", tokens, { issuer: ISSUER }),
      [F.discovery]: JSON.stringify(discovery),
      [F.pending]: v2("legacy", `${ISSUER}/authorize?state=old`),
      [F.verifier]: v2("legacy", "old-verifier"),
      [F.state]: v2("legacy", "old"),
    });
    const p = provider(storage);
    expect(await p.tokens(ctxA)).toEqual({ ...tokens, ...ctxA });

    expect(await storedGrant(storage)).toEqual({
      connectaOAuth: 3,
      epoch: expect.stringMatching(/^v3:/),
      body: { issuer: ISSUER, client: { value: client, binding: BINDING }, tokens, discovery },
    });
    expect(await storage.list("")).toEqual([GRANT]);
    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    expect(await p.verifyState("old")).toBe(false);
  });

  it("migrates a v2 epoch's suffixed grant, carried client and binding included, and deletes every layout 2 key", async () => {
    const storage = memoryStorage();
    const generation = "v2:live";
    await seedV2(storage, generation, {
      [F.client]: v2(generation, client, { issuer: ISSUER, binding: BINDING, carried: true }),
      [F.tokens]: v2(generation, tokens, { issuer: ISSUER }),
      [F.discovery]: v2(generation, discovery),
      [F.pending]: v2(generation, `${ISSUER}/authorize?state=old`, { writtenAt: Date.now() }),
      [F.verifier]: v2(generation, "old-verifier"),
      [F.state]: v2(generation, "old"),
    });
    // An older epoch's residue, the legacy names, cleanup lineage, and a
    // spent connect link that is not layout 2's to delete.
    await storage.set(oauthV2Keys.value(F.tokens, "v2:older"), v2("v2:older", { access_token: "older", token_type: "Bearer" }, { issuer: ISSUER }));
    await storage.set(oauthV2Keys.value(F.client, null), JSON.stringify({ client_id: "legacy-client" }));
    await storage.set(`oauth:cleanup:${encodeURIComponent("v2:older")}`, JSON.stringify(["legacy"]));
    await storage.set(`oauth:cleanup-at:${encodeURIComponent("v2:older")}`, JSON.stringify({ legacy: 1 }));
    const used = oauthConnectKeys.used("spent-nonce");
    await storage.set(used, "1");

    const p = provider(storage, { binding: BINDING });
    expect(await p.clientInformation(ctxA)).toEqual({ ...client, ...ctxA });
    const grant = required(await storedGrant(storage));
    expect(grant.body).toEqual({
      issuer: ISSUER,
      client: { value: client, binding: BINDING, carried: true },
      tokens,
      discovery,
    });
    expect(grant.epoch).toMatch(/^v3:/);
    expect(grant.epoch).not.toBe(generation);
    expect((await storage.list("")).sort()).toEqual([GRANT, used].sort());

    // Carried with tokens, the registration survives the next restart too.
    await p.resetAuthorization(false, true);
    expect((await storedGrant(storage))?.body?.client).toEqual({ value: client, binding: BINDING, carried: true });
  });

  it("opens sealed v2 values with their old physical key, and leaves behind what does not open", async () => {
    const sealer = sealerFor();
    const generation = "v2:sealed";
    const sealed = async (field: OAuthV2ValueKey, plaintext: string, label = oauthV2Keys.value(field, generation)) =>
      JSON.stringify({ connectaOAuthSealed: 1, sealed: await sealer.seal(label, plaintext) });
    const seed = async (storage: KVStorage, tokensLabel?: string) =>
      seedV2(storage, generation, {
        [F.client]: await sealed(F.client, v2(generation, client, { issuer: ISSUER })),
        [F.tokens]: await sealed(F.tokens, v2(generation, tokens, { issuer: ISSUER }), tokensLabel),
      });

    const storage = memoryStorage();
    await seed(storage);
    expect(await provider(storage, { sealer }).tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
    const raw = required((await storage.get(GRANT)) ?? undefined);
    expect(JSON.parse(raw)).toEqual({ connectaOAuth: 3, epoch: expect.stringMatching(/^v3:/), sealed: expect.any(String) });
    expect(raw).not.toContain("secret-access");
    expect(await provider(storage, { sealer }).clientInformation(ctxA)).toEqual({ ...client, ...ctxA });

    // Tokens sealed under another key than their own do not open: the
    // client that does is kept on its own.
    const moved = memoryStorage();
    await seed(moved, oauthV2Keys.value(F.tokens, null));
    expect(await provider(moved, { sealer }).tokens()).toBeUndefined();
    expect((await storedGrant(moved))?.body).toBeUndefined();
    expect(await provider(moved, { sealer }).clientInformation(ctxA)).toEqual({ ...client, ...ctxA });

    // Without a sealer nothing opens, and the grant migrates empty.
    const unsealed = memoryStorage();
    await seed(unsealed);
    expect(await provider(unsealed).tokens()).toBeUndefined();
    expect(await storedGrant(unsealed)).toEqual({ connectaOAuth: 3, epoch: expect.stringMatching(/^v3:/) });
    expect(await unsealed.list("")).toEqual([GRANT]);
  });

  it("migrates a disconnected generation as a disconnect tombstone", async () => {
    const storage = memoryStorage();
    const generation = "disconnected:abc";
    await seedV2(storage, generation, { [F.tokens]: v2(generation, tokens, { issuer: ISSUER }) });
    const p = provider(storage);
    expect(await p.operatorDisconnected()).toBe(true);
    expect(await p.tokens()).toBeUndefined();
    expect(await storedGrant(storage)).toEqual({ connectaOAuth: 3, epoch: expect.stringMatching(/^disconnected:/) });
    expect(await storage.list("")).toEqual([GRANT]);
  });

  const other = "https://auth-b.example";
  it.each<{ held: string; generation: string; values: Partial<Record<OAuthV2ValueKey, string>> }>([
    { held: "unstamped values from before v0.9", generation: "legacy", values: { [F.client]: JSON.stringify(client), [F.tokens]: JSON.stringify(tokens) } },
    {
      held: "v1 envelopes",
      generation: "legacy",
      values: { [F.tokens]: JSON.stringify({ connectaOAuthVersion: 1, generation: "legacy", value: tokens }) },
    },
    { held: "a numeric generation", generation: "7", values: { [F.tokens]: v2("7", tokens, { issuer: ISSUER }) } },
    { held: "an unfinished reset", generation: "reset:abc", values: { [F.tokens]: v2("reset:abc", tokens, { issuer: ISSUER }) } },
    {
      held: "an envelope of another generation",
      generation: "v2:a",
      values: { [F.tokens]: v2("v2:b", tokens, { issuer: ISSUER }) },
    },
    {
      held: "a credential missing its stamp",
      generation: "v2:a",
      values: { [F.client]: v2("v2:a", client, { issuer: ISSUER }), [F.tokens]: v2("v2:a", tokens) },
    },
    {
      held: "stamps naming different servers",
      generation: "v2:a",
      values: { [F.client]: v2("v2:a", client, { issuer: ISSUER }), [F.tokens]: v2("v2:a", tokens, { issuer: other }) },
    },
    {
      held: "stamps that disagree with discovery",
      generation: "v2:a",
      values: {
        [F.tokens]: v2("v2:a", tokens, { issuer: ISSUER }),
        [F.discovery]: v2("v2:a", { authorizationServerUrl: other }),
      },
    },
  ])("migrates empty from $held", async ({ generation, values }) => {
    const storage = memoryStorage();
    await seedV2(storage, generation, values);
    const p = provider(storage);
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeUndefined();
    expect(await p.operatorDisconnected()).toBe(false);
    expect(await storedGrant(storage)).toEqual({ connectaOAuth: 3, epoch: expect.stringMatching(/^v3:/) });
    expect(await storage.list("")).toEqual([GRANT]);
  });

  it("migrates once: two concurrent first reads write one record, and a later read does nothing more", async () => {
    const backing = memoryStorage();
    await seedV2(backing, "legacy", { [F.tokens]: v2("legacy", tokens, { issuer: ISSUER }) });
    const both = deferred<void>();
    let lists = 0;
    let written = 0;
    const storage: KVStorage = { ...backing,
      async list(prefix) {
        if (++lists === 2) both.resolve();
        await both.promise;
        return backing.list(prefix);
      },
      async compareAndSet(key, expected, next, options) {
        const ok = await backing.compareAndSet(key, expected, next, options);
        if (key === GRANT && ok) written++;
        return ok;
      },
    };
    const [a, b] = [provider(storage), provider(storage)];
    expect(await Promise.all([a.tokens(ctxA), b.tokens(ctxA)])).toEqual([{ ...tokens, ...ctxA }, { ...tokens, ...ctxA }]);
    expect(lists).toBe(2);
    expect(written).toBe(1);
    expect(await a.liveEpoch()).toBe(await b.liveEpoch());

    const raw = await backing.get(GRANT);
    expect(await provider(storage).tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
    expect(lists).toBe(2);
    expect(await backing.get(GRANT)).toBe(raw);
    expect(await backing.list("")).toEqual([GRANT]);
  });

  it("keeps layout 2 when its record cannot be written", async () => {
    const backing = memoryStorage();
    await seedV2(backing, "legacy", { [F.tokens]: v2("legacy", tokens, { issuer: ISSUER }) });
    const storage: KVStorage = { ...backing,
      compareAndSet: async () => { throw new Error("storage unavailable"); },
    };
    await expect(provider(storage).tokens()).rejects.toThrow();
    expect(await backing.list("")).toEqual([oauthV2Keys.value(F.tokens, null)]);
    expect(await provider(backing).tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
  });

  it("writes nothing when a never-authorized connector's grant is read (INV-10)", async () => {
    const storage = memoryStorage();
    const used = oauthConnectKeys.used("spent-nonce");
    await storage.set(used, "1");
    const p = provider(storage);
    expect(await p.tokens(ctxA)).toBeUndefined();
    expect(await p.clientInformation(ctxA)).toBeUndefined();
    expect(await p.discoveryState()).toBeUndefined();
    expect(await p.liveEpoch()).toBe("initial");
    expect(await p.operatorDisconnected()).toBe(false);
    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    expect(await p.reusablePendingAuthorizationUrl()).toBeUndefined();
    expect(await p.verifyState("anything")).toBe(false);
    expect(await storage.list("")).toEqual([used]);
  });

  it("migrates each personal partition on its own", async () => {
    const backing = memoryStorage();
    const shared = partition(backing, "conn:svc:");
    const alice = partition(backing, "principal:alice:conn:svc:");
    const bob = partition(backing, "principal:bob:conn:svc:");
    const aliceTokens = { ...tokens, access_token: "alice-access" };
    const bobTokens = { ...tokens, access_token: "bob-access" };
    await seedV2(alice, "legacy", { [F.tokens]: v2("legacy", aliceTokens, { issuer: ISSUER }) });
    await seedV2(bob, "v2:bob", { [F.tokens]: v2("v2:bob", bobTokens, { issuer: ISSUER }) });

    expect(await provider(alice).tokens(ctxA)).toEqual({ ...aliceTokens, ...ctxA });
    // Bob's partition and the shared namespace are untouched.
    expect(await bob.get(GRANT)).toBeNull();
    expect(await bob.list("oauth:")).toHaveLength(2);
    expect(await provider(shared).tokens()).toBeUndefined();
    expect(await shared.list("")).toEqual([]);

    expect(await provider(bob).tokens(ctxA)).toEqual({ ...bobTokens, ...ctxA });
    expect(await provider(alice).liveEpoch()).not.toBe(await provider(bob).liveEpoch());
    expect((await backing.list("")).sort()).toEqual([
      `principal:alice:conn:svc:${GRANT}`,
      `principal:bob:conn:svc:${GRANT}`,
    ]);
  });
});
