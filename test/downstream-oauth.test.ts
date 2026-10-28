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
      binding: { issuer: ISSUER, clientId: "dcr-client", discovery: expect.stringMatching(/^[a-f0-9]{64}$/) },
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
    expect(await provider(storage, { sealer: sealerFor(CREDENTIAL_KEY, consent.logger) }).verifyState(state)).toBe(
      false,
    );
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
