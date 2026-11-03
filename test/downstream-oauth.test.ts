import type { OAuthClientInformationFull, OAuthDiscoveryState, OAuthTokens } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { vaultOAuthSealer, type OAuthStateSealer } from "../src/oauth-sealing.js";
import { memoryStorage } from "../src/storage/memory.js";
import { OAUTH_FLOW_TTL_SECONDS, oauthConnectKeys, oauthFlowKeys, oauthGrantKeys } from "../src/storage/keys.js";
import type { KVStorage, Logger } from "../src/types.js";
import { required, silentLogger } from "./helpers.js";
import { deferred, spyLogger } from "./fixtures/misc.js";
import { consentKey, storedGrant } from "./fixtures/oauth.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";

// The provider over layout 3: one grant record per owner (`oauth:grant`) and
// one flow record per consent (`oauth:flow:<sha256(state)>`). The refresh coordinator and remoteMcp()'s
// flows have suites of their own.

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const GRANT = oauthGrantKeys.grant;
const ISSUER = "https://auth.example";
const ctxA = { issuer: ISSUER };
const ctxB = { issuer: "https://auth-b.example" };
const BINDING = "same-config";
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
// Its advice to try again is a separate segment, composed only at output.
const SUPERSEDED = /authorization changed while this request was in flight\./;

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
  } = {},
): KvOAuthProvider {
  return new KvOAuthProvider("svc", storage, REDIRECT, undefined, true, opts.sealer, opts.signal, opts.binding);
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
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
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
      tokenRevision: 1,
      body: { issuer: ISSUER, client: { value: client, registrationPath: "dcr" }, tokens },
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
      issuer: ISSUER,
      client: { value: client, registrationPath: "dcr" },
      tokens,
      discovery,
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
    expect((await storedGrant(storage))?.epoch).toMatch(/^v3:/);
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

  it("stores each consent with the link's fifteen-minute lifetime", async () => {
    const backing = memoryStorage();
    const ttls: Array<number | undefined> = [];
    const storage: KVStorage = {
      ...backing,
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
    const sealed = () => provider(storage, { sealer: sealerFor() });
    const p = sealed();
    await p.saveClientInformation(client, ctxA);
    const { url } = await publish(p);
    expect(await sealed().reusablePendingAuthorizationUrl()).toBe(url);

    // Past ten minutes it is only pending.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000);
    expect(await sealed().reusablePendingAuthorizationUrl()).toBeUndefined();
    expect(await sealed().pendingAuthorizationUrl()).toBe(url);
    vi.restoreAllMocks();

    // A consent naming another client is not handed back.
    const other = await publish(sealed(), "v", `${ISSUER}/authorize?client_id=other`);
    expect(await sealed().reusablePendingAuthorizationUrl()).toBeUndefined();
    expect(await sealed().pendingAuthorizationUrl()).toBe(other.url);
  });
});

describe("KvOAuthProvider epochs", () => {
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
    const storage: KVStorage = {
      ...backing,
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
    const storage: KVStorage = {
      ...backing,
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
  async function granted(storage: KVStorage) {
    const p = provider(storage, { binding: BINDING });
    await p.saveDiscoveryState(discovery);
    await p.saveClientInformation(client, ctxA);
    await p.saveTokens(tokens, ctxA);
  }

  it.each<{ held: string; carried: boolean; setup: (storage: KVStorage) => Promise<void> }>([
    { held: "an issuer-bound client registered under this configuration", carried: true, setup: (s) => granted(s) },
    {
      held: "a client stored with no issuer",
      carried: false,
      setup: (s) => provider(s, { binding: BINDING }).saveClientInformation(client),
    },
    {
      held: "a client registered under another configuration",
      carried: false,
      setup: (s) => provider(s, { binding: "old-config" }).saveClientInformation(client, ctxA),
    },
  ])("a restart that preserves the client, holding $held, carries it: $carried", async ({ carried, setup }) => {
    const storage = memoryStorage();
    await setup(storage);
    const before = (await storedGrant(storage))?.body?.client;
    await provider(storage, { binding: BINDING }).resetAuthorization(false, true);
    const grant = required(await storedGrant(storage));
    expect(grant.epoch).toMatch(/^v3:/);
    if (!carried) {
      expect(grant.body).toBeUndefined();
      return;
    }
    // Only the registration, marked carried; never tokens or discovery.
    expect(grant.body).toEqual({
      issuer: ISSUER,
      client: { value: required(before).value, binding: BINDING, carried: true, registrationPath: "dcr" },
    });
    expect(await provider(storage).clientInformation(ctxA)).toMatchObject({ client_id: client.client_id });
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

// With no vault there is nothing to seal with, so the pending flow record keeps
// only what its callback needs: no consent URL, no URL userinfo, query or
// fragment, and a discovery digest that does not cover them.
describe("KvOAuthProvider pending flow without a vault", () => {
  const SECRET = "config-secret";
  const metadata = (token_endpoint: string) =>
    ({
      authorizationServerUrl: ISSUER,
      authorizationServerMetadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint,
        response_types_supported: ["code"],
      },
    }) as OAuthDiscoveryState;
  const secretDiscovery = metadata(`https://user:${SECRET}@auth.example/token?key=${SECRET}#${SECRET}`);

  it("stores no consent URL and no URL secret in the binding or its digest", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    await p.saveDiscoveryState(secretDiscovery);
    await p.saveClientInformation({ ...client, client_id: `https://client.example/meta?key=${SECRET}` }, ctxA);
    const { state, url } = await publish(p, "secret-verifier", `${ISSUER}/authorize?resource=${SECRET}`);
    expect(await p.consentUrl()).toBe(url);

    const raw = required((await storage.get(await consentKey(state))) ?? undefined);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(state);
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored).toEqual({
      connectaOAuthFlow: 1,
      epoch: "initial",
      at: expect.any(Number),
      verifier: "secret-verifier",
      binding: {
        issuer: ISSUER,
        clientId: "https://client.example/meta",
        tokenEndpoint: "https://auth.example/token",
        discovery: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(raw).not.toContain(await oauthStateDigest(JSON.stringify(secretDiscovery)));
    expect(await provider(storage).pendingAuthorizationUrl()).toBeUndefined();
    expect(await provider(storage).reusablePendingAuthorizationUrl()).toBeUndefined();
  });

  it("completes its callback against the minimized binding and fences a changed server", async () => {
    const storage = memoryStorage();
    const p = provider(storage);
    await p.saveDiscoveryState(secretDiscovery);
    await p.saveClientInformation(client, ctxA);
    const { state } = await publish(p, "secret-verifier");

    const callback = provider(storage);
    expect(await callback.verifyState(state)).toBe(true);
    expect(await callback.codeVerifier()).toBe("secret-verifier");
    callback.validateCallbackIssuer(ISSUER);
    expect(() => callback.validateCallbackIssuer("https://other.example")).toThrow(/issuer does not match/);
    await expect(callback.consumeAuthError()).resolves.toBeUndefined();

    const moved = provider(storage);
    const next = await publish(moved, "v2", `${ISSUER}/authorize?client_id=dcr-client`);
    await provider(storage).saveDiscoveryState(metadata("https://auth.example/elsewhere"));
    const late = provider(storage);
    expect(await late.verifyState(next.state)).toBe(true);
    await expect(late.consumeAuthError()).rejects.toMatchObject({ code: expect.any(String) });
  });
});

// Tokens, client registration, and discovery (the grant body) and the pending
// flow's binding, URL and verifier are ciphertext at rest when the deployment
// has a vault that seals.
describe("KvOAuthProvider sealed state", () => {
  it("seals the grant body and the whole pending flow; only its epoch and time stay plaintext", async () => {
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
      tokenRevision: 1,
      flow: await oauthStateDigest(state),
      sealed: expect.stringMatching(/^v1\./),
    });
    expect(JSON.parse(flowRaw)).toEqual({
      connectaOAuthFlow: 1,
      epoch: "initial",
      at: expect.any(Number),
      record: expect.stringMatching(/^v1\./),
    });
    for (const secret of ["secret-access", "secret-refresh", "dcr-secret", "dcr-client", ISSUER]) {
      expect(grantRaw).not.toContain(secret);
    }
    for (const secret of [
      "secret-verifier",
      "dcr-client",
      ISSUER,
      url,
      state,
      await oauthStateDigest(JSON.stringify(discovery)),
    ]) {
      expect(flowRaw).not.toContain(secret);
    }

    const reader = provider(storage, { sealer: sealerFor() });
    expect(await reader.tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
    expect(await reader.clientInformation(ctxA)).toEqual({ ...client, ...ctxA });
    expect(await reader.discoveryState()).toEqual(discovery);
    expect(await reader.verifyState(state)).toBe(true);
    expect(await reader.codeVerifier()).toBe("secret-verifier");
    expect(await reader.pendingAuthorizationUrl()).toBe(url);

    // Without the sealer the ciphertext is nothing a caller could use.
    const unsealed = provider(storage);
    expect(await unsealed.tokens()).toBeUndefined();
    expect(await unsealed.clientInformation()).toBeUndefined();
    expect(await unsealed.discoveryState()).toBeUndefined();
    expect(await unsealed.verifyState(state)).toBe(false);
    expect(await unsealed.pendingAuthorizationUrl()).toBeUndefined();
  });

  it("still completes a consent written before the whole flow was sealed", async () => {
    const storage = memoryStorage();
    const sealer = sealerFor();
    const p = provider(storage, { sealer });
    await p.saveDiscoveryState(discovery);
    await p.saveClientInformation(client, ctxA);
    const { state, url } = await publish(p, "secret-verifier");
    const key = await consentKey(state);
    const { epoch, at } = JSON.parse(required((await storage.get(key)) ?? undefined)) as { epoch: string; at: number };
    await storage.set(
      key,
      JSON.stringify({
        connectaOAuthFlow: 1,
        epoch,
        at,
        url,
        binding: { issuer: ISSUER, clientId: "dcr-client" },
        verifier: await sealer.seal(`${key}:${epoch}`, "secret-verifier"),
        sealed: true,
      }),
    );
    const reader = provider(storage, { sealer: sealerFor() });
    expect(await reader.pendingAuthorizationUrl()).toBe(url);
    expect(await reader.verifyState(state)).toBe(true);
    expect(await reader.codeVerifier()).toBe("secret-verifier");
  });

  it("does not open a sealed verifier moved into the record slot, or a record into the verifier slot", async () => {
    const storage = memoryStorage();
    const { state } = await publish(provider(storage, { sealer: sealerFor() }), "secret-verifier");
    const key = await consentKey(state);
    const stored = JSON.parse(required((await storage.get(key)) ?? undefined)) as {
      epoch: string;
      at: number;
      record: string;
    };
    await storage.set(
      key,
      JSON.stringify({
        connectaOAuthFlow: 1,
        epoch: stored.epoch,
        at: stored.at,
        verifier: stored.record,
        sealed: true,
      }),
    );
    expect(await provider(storage, { sealer: sealerFor() }).verifyState(state)).toBe(false);
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
    const flow = JSON.parse(required((await storage.get(key)) ?? undefined)) as { record: string };
    await storage.set(key, JSON.stringify({ ...flow, record: flip(flow.record) }));
    const consent = spyLogger();
    expect(await provider(storage, { sealer: sealerFor(CREDENTIAL_KEY, consent.logger) }).verifyState(state)).toBe(
      false,
    );
    expect(consent.warnings().join("\n")).toMatch(/"svc" has a sealed OAuth consent/);

    for (const warning of [...wrongKey.warnings(), ...tampered.warnings(), ...consent.warnings()]) {
      expect(warning).not.toContain("secret-access");
      expect(warning).not.toContain("secret-verifier");
      expect(warning).not.toContain(envelope.sealed);
      expect(warning).not.toContain(flow.record);
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

describe("retired OAuth layouts", () => {
  it.each(["legacy", "v2:live"])(
    "refuses %s layout-2 grants without reading credentials or leaking token text",
    async (generation) => {
      const backing = memoryStorage();
      const suffix = generation === "legacy" ? "" : `:epoch:${generation}`;
      const secret = "SENTINEL-retired-token";
      await backing.set("oauth:generation", generation);
      for (const [field, value] of Object.entries({ client, tokens: { ...tokens, access_token: secret }, discovery }))
        await backing.set(
          `oauth:${field}${suffix}`,
          JSON.stringify({ connectaOAuthVersion: 2, generation, issuer: ISSUER, value }),
        );
      const before = await backing.list("");
      const storage = {
        ...backing,
        get: vi.fn(backing.get),
        compareAndSet: vi.fn(backing.compareAndSet),
        delete: vi.fn(backing.delete),
      };
      const logger = spyLogger();
      const sealer = sealerFor(CREDENTIAL_KEY, logger.logger);
      const open = vi.spyOn(sealer, "open");
      const p = provider(storage, { sealer });
      await expect(p.tokens(ctxA)).resolves.toBeUndefined();
      await expect(p.clientInformation(ctxA)).resolves.toBeUndefined();
      await expect(p.discoveryState()).resolves.toBeUndefined();
      await expect(p.storedAuthorization(ISSUER)).resolves.toBe(false);
      await expect(p.liveEpoch()).resolves.toBe("initial");
      expect(storage.get.mock.calls.every(([key]) => key === GRANT)).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(storage.compareAndSet).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(await backing.list("")).toEqual(before);
      const warnings = JSON.stringify(logger.warn.mock.calls);
      expect(warnings).toContain("unsupported pre-layout-3 OAuth grant");
      expect(warnings).toContain("Connect again to authorize");
      expect(warnings).toContain("0.37.1");
      expect(warnings).not.toContain(secret);
      // Fresh consent replaces the absent grant; old keys cannot be resurrected by reset.
      await p.saveTokens(tokens, ctxA);
      expect(await p.tokens(ctxA)).toEqual({ ...tokens, ...ctxA });
      await p.resetAuthorization(true);
      expect(await p.tokens(ctxA)).toBeUndefined();
      expect(await p.operatorDisconnected()).toBe(true);
    },
  );

  it("keeps layout-3 grants with an obsolete cleanup marker readable without touching old keys", async () => {
    const backing = memoryStorage();
    await backing.set(
      GRANT,
      JSON.stringify({
        connectaOAuth: 3,
        epoch: "v3:existing",
        cleanupPending: true,
        body: { issuer: ISSUER, tokens },
      }),
    );
    await backing.set("oauth:tokens", "SENTINEL-retired-token");
    const storage = { ...backing, list: vi.fn(backing.list), delete: vi.fn(backing.delete) };
    await expect(provider(storage).tokens(ctxA)).resolves.toEqual({ ...tokens, ...ctxA });
    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await backing.get("oauth:tokens")).toBe("SENTINEL-retired-token");
  });

  it("reports retired OAuth state without a vault and does not open malformed stored text", async () => {
    const storage = memoryStorage();
    const secret = "SENTINEL-malformed-retired-token";
    await storage.set("oauth:tokens", `{${secret}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(provider(storage).tokens(ctxA)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Connect again to authorize"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(await storage.get(GRANT)).toBeNull();
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
});

describe("grant revision observations", () => {
  it("INV-6 INV-10: same-epoch reconsent fences clock-ahead refusal with one atomic token commit", async () => {
    const storage = memoryStorage();
    const a = provider(storage);
    await a.saveTokens(tokens, ctxA);
    await a.tokens(ctxA);
    const old = { epoch: a.observed!.epoch, revision: a.observed!.revision };
    const b = provider(storage);
    await b.saveTokens(tokens, ctxA); // Even an identical token is a new consent revision.
    await b.tokens(ctxA);
    const current = { epoch: b.observed!.epoch, revision: b.observed!.revision };
    expect(current.epoch).toBe(old.epoch);
    expect(current.revision).toBe(old.revision + 1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    await a.recordTokenOutcome(old, "refused");
    await b.recordTokenOutcome(current, "accepted");
    const raw = await storage.get(GRANT);
    expect(JSON.parse(raw!).observation).toEqual({ revision: current.revision, outcome: "accepted" });
    await b.peekGrant();
    expect(await storage.get(GRANT)).toBe(raw);
    vi.restoreAllMocks();
  });

  it("a delayed old observation CAS cannot overwrite the replacement's fence or block its observations", async () => {
    const inner = memoryStorage();
    const entered = deferred<void>();
    const release = deferred<void>();
    let held = false;
    const storage: KVStorage = {
      ...inner,
      compareAndSet: async (key, expected, value, options) => {
        if (!held && key === GRANT && value && JSON.parse(value).observation?.outcome === "refused") {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return inner.compareAndSet!(key, expected, value, options);
      },
    };
    const a = provider(storage);
    await a.saveTokens(tokens, ctxA);
    await a.tokens(ctxA);
    const pending = a.recordTokenOutcome({ epoch: a.observed!.epoch, revision: a.observed!.revision }, "refused");
    await entered.promise;
    const b = provider(storage);
    await b.saveTokens({ ...tokens, access_token: "replacement-access" }, ctxA);
    await b.tokens(ctxA);
    const snapshot = { epoch: b.observed!.epoch, revision: b.observed!.revision };
    await b.recordTokenOutcome(snapshot, "accepted");
    release.resolve();
    await pending;
    expect(JSON.parse((await inner.get(GRANT))!).observation).toEqual({
      revision: snapshot.revision,
      outcome: "accepted",
    });
    await b.recordTokenOutcome(snapshot, "refused");
    expect(JSON.parse((await inner.get(GRANT))!).observation.outcome).toBe("refused");
  });
});
