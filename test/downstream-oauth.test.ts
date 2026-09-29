import { fetchTestUiDetails } from "./helpers.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  FetchLike,
  OAuthClientInformationContext,
  OAuthClientInformationFull,
  OAuthDiscoveryState,
  OAuthTokens,
  Transport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  KvOAuthProvider,
  OAuthRefreshCoordinator,
  oauthValueStorageKey,
} from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import { CredentialVault } from "../src/credentials.js";
import { vaultOAuthSealer } from "../src/oauth-sealing.js";
import { attachOAuthSealer } from "../src/oauth-sealing.js";
import type {
  Connector,
  ConnectorContext,
  InboundAuth,
  KVStorage,
  Logger,
} from "../src/types.js";
import { createTestConnecta, required, silentLogger } from "./helpers.js";
import { inMemoryDownstream, throwingTransport } from "./fixtures/downstream-mcp.js";
import { connectorContext as ctx, deferred, spyLogger } from "./fixtures/misc.js";

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;

async function storeCurrentOAuthValue(
  storage: KVStorage,
  key: string,
  value: unknown,
  issuer?: string,
): Promise<void> {
  const generation = (await storage.get("oauth:generation")) ?? "legacy";
  await storage.set(
    oauthValueStorageKey(key, generation),
    JSON.stringify({
      connectaOAuthVersion: 2,
      generation,
      ...(issuer !== undefined ? { issuer } : {}),
      value,
    }),
  );
}

// ---------------------------------------------------------------------------
// KvOAuthProvider unit behavior (no authorization server involved).
// ---------------------------------------------------------------------------
describe("KvOAuthProvider over memoryStorage", () => {
  function provider() {
    return new KvOAuthProvider("svc", memoryStorage(), REDIRECT);
  }

  it("removes a client write whose storage call finishes after cancellation", async () => {
    const inner = memoryStorage();
    const blocked = deferred<void>();
    const writing = deferred<void>();
    const storage: KVStorage = {
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
      async set(key, value, options) {
        if (key.startsWith("oauth:client:epoch:")) {
          writing.resolve();
          await blocked.promise;
        }
        await inner.set(key, value, options);
      },
      compareAndSet: (key, expected, next, options) =>
        inner.compareAndSet!(key, expected, next, options),
    };
    const controller = new AbortController();
    const p = new KvOAuthProvider(
      "svc", storage, REDIRECT, undefined, true, undefined,
      controller.signal, "binding",
    );
    const generation = await p.bumpGeneration();
    p.captureGeneration(generation);
    const save = p.saveClientInformation({ client_id: "late" }, { issuer: "https://auth.example" });
    await writing.promise;
    controller.abort();
    blocked.resolve();
    await save;

    expect(await inner.get(oauthValueStorageKey("oauth:client", generation))).toBeNull();
  });

  it("exposes redirectUrl and the connecta client metadata", () => {
    const p = provider();
    expect(p.redirectUrl).toBe(REDIRECT);
    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toEqual([REDIRECT]);
    expect(meta.client_name).toBe("connecta");
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
  });

  it("round-trips client information (DCR)", async () => {
    const p = provider();
    expect(await p.clientInformation()).toBeUndefined();
    const info: OAuthClientInformationFull = {
      client_id: "abc",
      client_secret: "shh",
      redirect_uris: [REDIRECT],
    };
    await p.saveClientInformation(info);
    expect(await p.clientInformation()).toEqual(info);
  });

  it("round-trips tokens", async () => {
    const p = provider();
    expect(await p.tokens()).toBeUndefined();
    const tokens: OAuthTokens = {
      access_token: "at",
      token_type: "Bearer",
      refresh_token: "rt",
    };
    await p.saveTokens(tokens);
    expect(await p.tokens()).toEqual(tokens);
  });

  it("persists discovery state across OAuth callback request scopes", async () => {
    const storage = memoryStorage();
    const start = new KvOAuthProvider("svc", storage, REDIRECT);
    const discovery: OAuthDiscoveryState = {
      authorizationServerUrl: "https://auth.example",
      resourceMetadataUrl:
        "https://downstream.example/.well-known/custom-protected-resource",
      resourceMetadata: {
        resource: "https://downstream.example/mcp",
        authorization_servers: ["https://auth.example"],
      },
    };

    await start.saveDiscoveryState(discovery);

    const callback = new KvOAuthProvider("svc", storage, REDIRECT);
    await expect(callback.discoveryState()).resolves.toEqual(discovery);
  });

  it.each([false, true])("finishes OAuth from non-default metadata, URL client ID: %s", async (urlClient) => {
    const storage = memoryStorage();
    const issuer = "https://auth.example";
    const mcpUrl = "https://downstream.example/mcp";
    const metadataUrl =
      "https://downstream.example/.well-known/custom-protected-resource/mcp";
    const clientMetadataUrl = "https://connecta.test/oauth-client.json";
    const makeProvider = () => new KvOAuthProvider(
      "svc", storage, REDIRECT, undefined, true, undefined, undefined, undefined, undefined,
      urlClient ? clientMetadataUrl : undefined,
      "full mcp",
    );
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      if (url.href === metadataUrl) {
        return Response.json({
          resource: mcpUrl,
          authorization_servers: [issuer],
        });
      }
      if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          client_id_metadata_document_supported: urlClient,
          scopes_supported: ["full", "mcp", "offline_access"],
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === `${issuer}/register`) {
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
      if (url.href === `${issuer}/token`) {
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(URLSearchParams);
        expect((init.body as URLSearchParams).get("code")).toBe("auth-code");
        expect((init.body as URLSearchParams).get("client_id")).toBe(urlClient ? clientMetadataUrl : "registered-client");
        return Response.json({
          access_token: "access-token",
          token_type: "Bearer",
        });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };

    const start = makeProvider();
    await expect(
      auth(start, {
        serverUrl: mcpUrl,
        resourceMetadataUrl: new URL(metadataUrl),
        fetchFn: fetchStub,
      }),
    ).resolves.toBe("REDIRECT");
    const pending = new URL((await start.pendingAuthorizationUrl())!);

    expect(pending.searchParams.get("client_id")).toBe(urlClient ? clientMetadataUrl : "registered-client");
    expect(pending.searchParams.get("scope")).toBe("full mcp offline_access");
    const callback = makeProvider();
    expect(await callback.verifyState(pending.searchParams.get("state"))).toBe(
      true,
    );
    await expect(
      auth(callback, {
        serverUrl: mcpUrl,
        authorizationCode: "auth-code",
        fetchFn: fetchStub,
      }),
    ).resolves.toBe("AUTHORIZED");
    await expect(callback.tokens()).resolves.toMatchObject({
      access_token: "access-token",
    });
  });

  it("binds client registration and tokens to the validated authorization issuer", async () => {
    const storage = memoryStorage();
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    const issuer: OAuthClientInformationContext = {
      issuer: "https://auth.example",
    };
    const info: OAuthClientInformationFull = {
      client_id: "issuer-client",
      redirect_uris: [REDIRECT],
    };
    const tokens: OAuthTokens = {
      access_token: "issuer-token",
      token_type: "Bearer",
    };

    await p.saveClientInformation(info, issuer);
    await p.saveTokens(tokens, issuer);

    expect(await p.clientInformation(issuer)).toEqual(info);
    expect(await p.tokens(issuer)).toEqual(tokens);
    // Token attachment has no issuer context, so it reads the already-bound
    // credential selected during validated discovery.
    expect(await p.tokens()).toEqual(tokens);
    expect(JSON.parse((await storage.get("oauth:client"))!)).toMatchObject({
      connectaOAuthVersion: 2,
      generation: "legacy",
      issuer: issuer.issuer,
      value: { client_id: "issuer-client" },
    });
    expect(JSON.parse((await storage.get("oauth:tokens"))!)).toMatchObject({
      connectaOAuthVersion: 2,
      generation: "legacy",
      issuer: issuer.issuer,
      value: { access_token: "issuer-token" },
    });
  });

  it("invalidates the credential generation when validated discovery changes issuer", async () => {
    const storage = memoryStorage();
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    const original = { issuer: "https://auth-a.example" };
    const replacement = { issuer: "https://auth-b.example" };
    await p.saveClientInformation(
      { client_id: "client-a", redirect_uris: [REDIRECT] },
      original,
    );
    await p.saveTokens(
      { access_token: "token-a", token_type: "Bearer" },
      original,
    );

    expect(await p.clientInformation(replacement)).toBeUndefined();
    expect(await p.generation()).toMatch(/^v2:/);
    expect(await p.tokens()).toBeUndefined();
    expect(await storage.get("oauth:client")).toBeNull();
    expect(await storage.get("oauth:tokens")).toBeNull();

    await p.saveTokens(
      { access_token: "token-b", token_type: "Bearer" },
      replacement,
    );
    expect(await p.tokens(replacement)).toMatchObject({
      access_token: "token-b",
    });
  });

  it("upgrades a v1 credential envelope by binding it on first issuer-aware read", async () => {
    const storage = memoryStorage();
    await storage.set(
      "oauth:client",
      JSON.stringify({
        connectaOAuthVersion: 1,
        generation: "legacy",
        value: {
          client_id: "upgrade-client",
          redirect_uris: [REDIRECT],
        },
      }),
    );
    const p = new KvOAuthProvider("svc", storage, REDIRECT);

    await expect(
      p.clientInformation({ issuer: "https://auth.example" }),
    ).resolves.toMatchObject({ client_id: "upgrade-client" });
    expect(JSON.parse((await storage.get("oauth:client"))!)).toMatchObject({
      connectaOAuthVersion: 2,
      generation: "legacy",
      issuer: "https://auth.example",
      value: { client_id: "upgrade-client" },
    });
  });

  it("round-trips the PKCE code verifier and throws when missing", async () => {
    const p = provider();
    await expect(p.codeVerifier()).rejects.toThrow(/verifier/i);
    await p.saveCodeVerifier("v-123");
    expect(await p.codeVerifier()).toBe("v-123");
  });

  it("stores the pending authorization URL and surfaces it", async () => {
    const p = provider();
    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    await p.redirectToAuthorization(
      new URL("https://auth.example/authorize?client_id=abc&state=xyz"),
    );
    expect(await p.pendingAuthorizationUrl()).toBe(
      "https://auth.example/authorize?client_id=abc&state=xyz",
    );
  });

  it("state() persists a random opaque value verifyState checks constant-time", async () => {
    const p = provider();
    // Nothing stored yet → fail closed.
    expect(await p.verifyState("anything")).toBe(false);
    const s = await p.state();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(await p.verifyState(s)).toBe(true);
    expect(await p.verifyState(`${s}x`)).toBe(false); // length differs
    const differentLast = s.endsWith("0") ? "1" : "0";
    expect(await p.verifyState(s.slice(0, -1) + differentLast)).toBe(false); // same length
    expect(await p.verifyState(null)).toBe(false);
  });

  it("state() mints a fresh value each call; only the latest verifies", async () => {
    const p = provider();
    const a = await p.state();
    const b = await p.state();
    expect(a).not.toBe(b);
    expect(await p.verifyState(a)).toBe(false);
    expect(await p.verifyState(b)).toBe(true);
  });

  it("generation defaults to legacy and bumps to unique epochs", async () => {
    const p = provider();
    expect(await p.generation()).toBe("legacy");
    const first = await p.bumpGeneration();
    const second = await p.bumpGeneration();
    expect(first).toMatch(/^v2:/);
    expect(second).toMatch(/^v2:/);
    expect(second).not.toBe(first);
    expect(await p.generation()).toBe(second);
  });

  it("generation survives clearPending and invalidateCredentials('all')", async () => {
    const p = provider();
    await p.bumpGeneration();
    const generation = await p.bumpGeneration();
    await p.clearPending();
    await p.invalidateCredentials("all");
    // The epoch is a fence; ordinary state cleanup may not erase it.
    expect(await p.generation()).toBe(generation);
  });

  it("reads pre-envelope grants until the first modern reset", async () => {
    const storage = memoryStorage();
    await storage.set("oauth:generation", "2");
    await storage.set(
      "oauth:tokens",
      JSON.stringify({ access_token: "legacy-token", token_type: "Bearer" }),
    );
    const p = new KvOAuthProvider("svc", storage, REDIRECT);

    expect(await p.tokens()).toMatchObject({ access_token: "legacy-token" });
    await p.resetAuthorization();
    expect(await p.tokens()).toBeUndefined();
  });

  it("preserves old-reader formats before the first modern reset", async () => {
    for (const generation of [null, "7"]) {
      const storage = memoryStorage();
      if (generation !== null) {
        await storage.set("oauth:generation", generation);
      }
      const p = new KvOAuthProvider("svc", storage, REDIRECT);
      const state = await p.state();
      await p.saveCodeVerifier("legacy-verifier");
      await p.redirectToAuthorization(
        new URL("https://auth.example/legacy"),
      );
      await p.saveClientInformation({
        client_id: "legacy-client",
        redirect_uris: [REDIRECT],
      });
      await p.saveTokens({
        access_token: "legacy-token",
        token_type: "Bearer",
      });

      expect(await storage.get("oauth:state")).toBe(state);
      expect(await storage.get("oauth:verifier")).toBe("legacy-verifier");
      expect(await storage.get("oauth:pending")).toBe(
        "https://auth.example/legacy",
      );
      expect(JSON.parse((await storage.get("oauth:client"))!)).toMatchObject({
        client_id: "legacy-client",
      });
      expect(JSON.parse((await storage.get("oauth:tokens"))!)).toMatchObject({
        access_token: "legacy-token",
      });
    }
  });

  it("saveTokens persists a refresh under a captured generation that has not advanced", async () => {
    // Ordinary token refresh (no force): the flow captured the current
    // generation and nothing bumped it, so the write must go through.
    const p = provider();
    p.captureGeneration(await p.generation());
    await p.saveTokens({ access_token: "refreshed", token_type: "Bearer" });
    expect(await p.tokens()).toEqual({
      access_token: "refreshed",
      token_type: "Bearer",
    });
  });

  it("saveTokens/saveClientInformation skip once a concurrent force bumps the generation past the captured one", async () => {
    // Two providers over ONE storage stand in for two isolates. A is mid-flow;
    // B force-reauthorizes (bump + wipe). A's SDK then tries to persist tokens
    // it minted against the still-valid grant — the write must be dropped so it
    // cannot resurrect the wiped credentials for a later isolate to read.
    const storage = memoryStorage();
    const a = new KvOAuthProvider("svc", storage, REDIRECT);
    const b = new KvOAuthProvider("svc", storage, REDIRECT);

    // A starts its flow under the legacy generation.
    a.captureGeneration(await a.generation());

    // B publishes a unique epoch, wipes state, and opens a new namespace.
    await b.resetAuthorization();

    // A's late writes are dropped — KV stays wiped.
    await a.saveTokens({ access_token: "resurrected", token_type: "Bearer" });
    await a.saveClientInformation({
      client_id: "resurrected",
      redirect_uris: [REDIRECT],
    });
    expect(await storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("oauth:client")).toBeNull();

    // A provider that connects fresh under the NEW generation persists normally.
    const a2 = new KvOAuthProvider("svc", storage, REDIRECT);
    a2.captureGeneration(await a2.generation());
    await a2.saveTokens({ access_token: "fresh", token_type: "Bearer" });
    expect(await a2.tokens()).toEqual({
      access_token: "fresh",
      token_type: "Bearer",
    });
  });

  it("clearPending wipes pending + verifier + state but keeps tokens/client", async () => {
    const p = provider();
    await p.saveClientInformation({
      client_id: "abc",
      redirect_uris: [REDIRECT],
    });
    await p.saveTokens({ access_token: "at", token_type: "Bearer" });
    await p.saveCodeVerifier("v-123");
    const s = await p.state();
    await p.redirectToAuthorization(new URL("https://auth.example/authorize"));

    await p.clearPending();

    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    await expect(p.codeVerifier()).rejects.toThrow();
    expect(await p.verifyState(s)).toBe(false); // state cleared
    expect(await p.tokens()).toBeDefined();
    expect(await p.clientInformation()).toBeDefined();
  });

  it("resetAuthorization fences stale writers and attempts every state deletion", async () => {
    const backing = memoryStorage();
    const deleted: string[] = [];
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        deleted.push(key);
        if (key === "oauth:tokens") {
          throw new Error("token delete unavailable");
        }
        await backing.delete(key);
      },
    };
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    for (const key of [
      "oauth:client",
      "oauth:tokens",
      "oauth:pending",
      "oauth:verifier",
      "oauth:state",
      "oauth:discovery",
    ]) {
      await backing.set(key, key);
    }

    await expect(p.resetAuthorization()).rejects.toThrow(
      "token delete unavailable",
    );

    expect(await backing.get("oauth:generation")).toMatch(/^v2:/);
    expect(deleted).toEqual([
      "oauth:client",
      "oauth:tokens",
      "oauth:pending",
      "oauth:verifier",
      "oauth:state",
      "oauth:discovery",
    ]);
    expect(await backing.get("oauth:client")).toBeNull();
    expect(await backing.get("oauth:tokens")).toBe("oauth:tokens");
    expect(await backing.get("oauth:pending")).toBeNull();
    expect(await backing.get("oauth:verifier")).toBeNull();
    expect(await backing.get("oauth:state")).toBeNull();
    expect(await backing.get("oauth:discovery")).toBeNull();
    // The surviving physical token is legacy residue outside the active
    // generation namespace, so it is no longer a usable credential.
    expect(await p.tokens()).toBeUndefined();
  });

  it("rejects a stale token write that lands after reset completed", async () => {
    const backing = memoryStorage();
    const { promise: writing, resolve: reachedWrite } = deferred<void>();
    const { promise: writeGate, resolve: releaseWrite } = deferred<void>();
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, opts) {
        if (key === "oauth:tokens") {
          reachedWrite();
          await writeGate;
        }
        await backing.set(key, value, opts);
      },
      delete: (key) => backing.delete(key),
    };
    const stale = new KvOAuthProvider("svc", storage, REDIRECT);
    stale.captureGeneration(await stale.generation());
    const resetter = new KvOAuthProvider("svc", storage, REDIRECT);

    const lateWrite = stale.saveTokens({
      access_token: "stale",
      token_type: "Bearer",
    });
    await writing;
    await resetter.resetAuthorization();
    await resetter.saveTokens({
      access_token: "fresh",
      token_type: "Bearer",
    });
    releaseWrite();
    await lateWrite;

    expect(await backing.get("oauth:tokens")).toBeNull();
    // Both readers see the active namespace; the old physical write cannot
    // overwrite the fresh token stored under that namespace.
    expect(await stale.tokens()).toMatchObject({ access_token: "fresh" });
    expect(await resetter.tokens()).toMatchObject({ access_token: "fresh" });
  });

  it("fences one-shot state and callback token writes from an older flow", async () => {
    const storage = memoryStorage();
    const stale = new KvOAuthProvider("svc", storage, REDIRECT);
    stale.captureGeneration(await stale.generation());
    const expectedState = await stale.state();
    await stale.saveCodeVerifier("old-verifier");
    expect(await stale.verifyState(expectedState)).toBe(true);

    const resetter = new KvOAuthProvider("svc", storage, REDIRECT);
    await resetter.resetAuthorization();
    await stale.saveCodeVerifier("resurrected-verifier");
    await stale.redirectToAuthorization(
      new URL("https://auth.example/stale"),
    );
    await stale.saveTokens({
      access_token: "resurrected",
      token_type: "Bearer",
    });

    await expect(resetter.codeVerifier()).rejects.toThrow();
    expect(await resetter.pendingAuthorizationUrl()).toBeUndefined();
    expect(await resetter.tokens()).toBeUndefined();
    expect(await resetter.verifyState(expectedState)).toBe(false);
  });

  it("does not retag the provider that performed a reset", async () => {
    const storage = memoryStorage();
    const staleAttempt = new KvOAuthProvider("svc", storage, REDIRECT);
    staleAttempt.captureGeneration(await staleAttempt.generation());

    await staleAttempt.resetAuthorization();
    await staleAttempt.saveTokens({
      access_token: "late-from-abandoned-transport",
      token_type: "Bearer",
    });

    expect(await staleAttempt.tokens()).toBeUndefined();
    expect(
      await new KvOAuthProvider("svc", storage, REDIRECT).tokens(),
    ).toBeUndefined();
  });

  it("concurrent resets cannot finalize over a newer epoch", async () => {
    const backing = memoryStorage();
    const { promise: firstCleanup, resolve: firstCleanupReached } = deferred<void>();
    const { promise: firstCleanupGate, resolve: releaseFirstCleanup } = deferred<void>();
    let heldFirstCleanup = false;
    let secondGeneration: string | null = null;
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, opts) {
        if (key === "oauth:generation" && heldFirstCleanup) {
          secondGeneration = value;
        }
        await backing.set(key, value, opts);
      },
      async delete(key) {
        if (key === "oauth:client" && !heldFirstCleanup) {
          heldFirstCleanup = true;
          firstCleanupReached();
          await firstCleanupGate;
        }
        if (
          secondGeneration !== null &&
          key.startsWith("oauth:tokens:epoch:")
        ) {
          throw new Error("second reset cleanup failed");
        }
        await backing.delete(key);
      },
    };
    const a = new KvOAuthProvider("svc", storage, REDIRECT);
    const b = new KvOAuthProvider("svc", storage, REDIRECT);

    const resetA = a.resetAuthorization();
    await firstCleanup;
    await expect(b.resetAuthorization()).rejects.toThrow(
      "second reset cleanup failed",
    );
    expect(secondGeneration).toMatch(/^v2:/);
    releaseFirstCleanup();
    await resetA;

    expect(await backing.get("oauth:generation")).toBe(secondGeneration);
  });

  it("retries failed cleanup of an older modern epoch on the next reset", async () => {
    const backing = memoryStorage();
    let failTokenDelete = false;
    let oldTokenKey = "";
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        if (failTokenDelete && key === oldTokenKey) {
          failTokenDelete = false;
          throw new Error("transient token cleanup failure");
        }
        await backing.delete(key);
      },
    };
    const first = new KvOAuthProvider("svc", storage, REDIRECT);
    await first.resetAuthorization();
    const firstGeneration = await first.generation();
    oldTokenKey = oauthValueStorageKey("oauth:tokens", firstGeneration);
    await first.saveTokens({
      access_token: "retired-secret",
      token_type: "Bearer",
    });
    expect(await backing.get(oldTokenKey)).not.toBeNull();

    failTokenDelete = true;
    await expect(first.resetAuthorization()).rejects.toThrow(
      "transient token cleanup failure",
    );
    expect(await backing.get(oldTokenKey)).not.toBeNull();
    // Its manifest outlives the failed values: that is the retry's signal.
    expect(
      await backing.get(`oauth:cleanup:${encodeURIComponent(firstGeneration)}`),
    ).not.toBeNull();

    await new KvOAuthProvider("svc", storage, REDIRECT).resetAuthorization();
    expect(await backing.get(oldTokenKey)).toBeNull();
    expect(
      await backing.get(`oauth:cleanup:${encodeURIComponent(firstGeneration)}`),
    ).toBeNull();
  });

  it("deletes a grant whose disconnect failed when the operator retries it", async () => {
    const backing = memoryStorage();
    let failures = 1;
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        if (failures > 0 && key.startsWith("conn:svc:oauth:tokens:epoch:")) {
          failures--;
          throw new Error("token delete unavailable");
        }
        await backing.delete(key);
      },
    };
    const connecta = createTestConnecta({
      connectors: [
        remoteMcp("svc", { url: "https://unused.example/mcp", auth: { type: "oauth" } }),
      ],
      auth: {
        kind: "operator",
        interactiveOperator: true,
        activityActorNamespace: "https://identity.test",
        authorize: () => ({ ok: true, userId: "operator" }),
      },
      storage,
      publicUrl: BASE,
      logger: silentLogger,
    });
    const grant = new KvOAuthProvider("svc", {
      get: (key) => backing.get(`conn:svc:${key}`),
      set: (key, value, opts) => backing.set(`conn:svc:${key}`, value, opts),
      delete: (key) => backing.delete(`conn:svc:${key}`),
    }, REDIRECT);
    await grant.resetAuthorization();
    const granted = await grant.generation();
    await grant.saveTokens({
      access_token: "live-access",
      token_type: "Bearer",
      refresh_token: "live-refresh",
    });
    const tokenKey = `conn:svc:${oauthValueStorageKey("oauth:tokens", granted)}`;
    expect(await backing.get(tokenKey)).toContain("live-refresh");
    const disconnect = () =>
      connecta.fetch(
        new Request(`${BASE}/ui/oauth/svc`, {
          method: "DELETE",
          headers: { Origin: BASE },
        }),
      );

    const failed = await disconnect();
    expect(failed.status).toBe(400);
    await expect(failed.json()).resolves.toEqual({
      error: "OAuth disconnect failed",
    });
    expect(await backing.get(tokenKey)).toContain("live-refresh");

    expect((await disconnect()).status).toBe(204);
    expect(await backing.get(tokenKey)).toBeNull();
    await connecta.close();
  });

  it("keeps lineage while a late stale-write cleanup races the next reset", async () => {
    const backing = memoryStorage();
    const { promise: atStaleSet, resolve: staleSetReached } = deferred<void>();
    const { promise: staleSetGate, resolve: releaseStaleSet } = deferred<void>();
    const { promise: atRememberRead, resolve: rememberReadReached } = deferred<void>();
    const { promise: rememberReadGate, resolve: releaseRememberRead } = deferred<void>();
    let activeManifest = "";
    let gatedRememberRead = false;
    let failLateDelete = false;
    let lateCleanupFailed = false;
    const storage: KVStorage = {
      async get(key) {
        if (
          lateCleanupFailed &&
          key === activeManifest &&
          !gatedRememberRead
        ) {
          gatedRememberRead = true;
          const value = await backing.get(key);
          rememberReadReached();
          await rememberReadGate;
          return value;
        }
        return backing.get(key);
      },
      async set(key, value, opts) {
        if (key === "oauth:tokens") {
          staleSetReached();
          await staleSetGate;
        }
        await backing.set(key, value, opts);
      },
      async delete(key) {
        if (failLateDelete && key === "oauth:tokens") {
          failLateDelete = false;
          lateCleanupFailed = true;
          throw new Error("late cleanup unavailable");
        }
        await backing.delete(key);
      },
    };
    const stale = new KvOAuthProvider("svc", storage, REDIRECT);
    stale.captureGeneration(await stale.generation());
    const lateWrite = stale.saveTokens({
      access_token: "late-secret",
      token_type: "Bearer",
    });
    await atStaleSet;

    const resetter = new KvOAuthProvider("svc", storage, REDIRECT);
    await resetter.resetAuthorization();
    const active = await resetter.generation();
    activeManifest = `oauth:cleanup:${encodeURIComponent(active)}`;
    expect(JSON.parse((await backing.get(activeManifest))!)).toContain(
      "legacy",
    );

    failLateDelete = true;
    releaseStaleSet();
    await atRememberRead;
    // A successor copies the immutable lineage while the stale writer is
    // paused after reading it.
    const successor = new KvOAuthProvider("svc", storage, REDIRECT);
    await successor.resetAuthorization();
    releaseRememberRead();
    await lateWrite;

    // The residue is unreadable, and still in the lineage the successor
    // published, so the first reset past its grace reclaims it.
    expect(await backing.get("oauth:tokens")).not.toBeNull();
    expect(await successor.tokens()).toBeUndefined();
    const successorManifest = `oauth:cleanup:${encodeURIComponent(await successor.generation())}`;
    expect(JSON.parse((await backing.get(successorManifest))!)).toContain(
      "legacy",
    );
    const realNow = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow + 24 * 60 * 60 * 1000 + 1);
    onTestFinished(() => clock.mockRestore());
    await successor.resetAuthorization();
    expect(await backing.get("oauth:tokens")).toBeNull();
  });

  it("clearPending attempts every one-shot deletion after a failure", async () => {
    const backing = memoryStorage();
    const deleted: string[] = [];
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        deleted.push(key);
        if (key === "oauth:pending") throw new Error("pending delete failed");
        await backing.delete(key);
      },
    };
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    await expect(p.clearPending()).rejects.toThrow("pending delete failed");
    expect(deleted).toEqual([
      "oauth:pending",
      "oauth:verifier",
      "oauth:state",
    ]);
  });

  it("an old callback cannot clear a replacement flow's one-shot state", async () => {
    const storage = memoryStorage();
    const oldCallback = new KvOAuthProvider("svc", storage, REDIRECT);
    const oldState = await oldCallback.state();
    await oldCallback.saveCodeVerifier("old-verifier");
    expect(await oldCallback.verifyState(oldState)).toBe(true);

    const replacement = new KvOAuthProvider("svc", storage, REDIRECT);
    await replacement.resetAuthorization();
    const freshState = await replacement.state();
    await replacement.saveCodeVerifier("fresh-verifier");
    await replacement.redirectToAuthorization(
      new URL("https://auth.example/fresh"),
    );

    await oldCallback.clearPending();

    expect(await replacement.verifyState(freshState)).toBe(true);
    expect(await replacement.codeVerifier()).toBe("fresh-verifier");
    expect(await replacement.pendingAuthorizationUrl()).toBe(
      "https://auth.example/fresh",
    );
  });

  it("a stale invalidation cannot remove replacement credentials", async () => {
    const storage = memoryStorage();
    const stale = new KvOAuthProvider("svc", storage, REDIRECT);
    stale.captureGeneration(await stale.generation());

    const replacement = new KvOAuthProvider("svc", storage, REDIRECT);
    await replacement.resetAuthorization();
    await replacement.saveTokens({
      access_token: "fresh",
      token_type: "Bearer",
    });
    await replacement.saveClientInformation({
      client_id: "fresh",
      redirect_uris: [REDIRECT],
    });

    await stale.invalidateCredentials("all");

    expect(await replacement.tokens()).toMatchObject({ access_token: "fresh" });
    expect(await replacement.clientInformation()).toMatchObject({
      client_id: "fresh",
    });
  });

  it("invalidateCredentials is scoped", async () => {
    const seed = async (p: KvOAuthProvider) => {
      await p.saveClientInformation({
        client_id: "abc",
        redirect_uris: [REDIRECT],
      });
      await p.saveTokens({ access_token: "at", token_type: "Bearer" });
      await p.saveCodeVerifier("v-123");
      await p.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example",
      });
    };

    const pTokens = provider();
    await seed(pTokens);
    await pTokens.invalidateCredentials("tokens");
    expect(await pTokens.tokens()).toBeUndefined();
    expect(await pTokens.clientInformation()).toBeDefined();
    expect(await pTokens.codeVerifier()).toBe("v-123");
    expect(await pTokens.discoveryState()).toBeDefined();

    const pClient = provider();
    await seed(pClient);
    await pClient.invalidateCredentials("client");
    expect(await pClient.clientInformation()).toBeUndefined();
    expect(await pClient.tokens()).toBeDefined();
    expect(await pClient.discoveryState()).toBeDefined();

    const pVerifier = provider();
    await seed(pVerifier);
    await pVerifier.invalidateCredentials("verifier");
    await expect(pVerifier.codeVerifier()).rejects.toThrow();
    expect(await pVerifier.tokens()).toBeDefined();
    expect(await pVerifier.discoveryState()).toBeDefined();

    const pDiscovery = provider();
    await seed(pDiscovery);
    await pDiscovery.invalidateCredentials("discovery");
    expect(await pDiscovery.discoveryState()).toBeUndefined();
    expect(await pDiscovery.clientInformation()).toBeDefined();
    expect(await pDiscovery.tokens()).toBeDefined();

    const pAll = provider();
    await seed(pAll);
    await pAll.invalidateCredentials("all");
    expect(await pAll.clientInformation()).toBeUndefined();
    expect(await pAll.tokens()).toBeUndefined();
    expect(await pAll.discoveryState()).toBeUndefined();
    await expect(pAll.codeVerifier()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A reset's storage work does not grow with the resets before it: it deletes
// the epoch it retires and sweeps a bounded number past their grace.
// ---------------------------------------------------------------------------
describe("KvOAuthProvider cleanup lineage", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const T0 = Date.UTC(2026, 0, 1);
  const manifestKey = (generation: string) =>
    `oauth:cleanup:${encodeURIComponent(generation)}`;
  const timesKey = (generation: string) =>
    `oauth:cleanup-at:${encodeURIComponent(generation)}`;
  /** A timed entry, or a bare name for one the times record does not cover. */
  type Entry = { generation: string; retiredAt: number } | string;
  const generationOf = (entry: Entry) =>
    typeof entry === "string" ? entry : entry.generation;

  let now = T0;
  let restoreClock: (() => void) | undefined;
  afterEach(() => {
    restoreClock?.();
    restoreClock = undefined;
  });
  function useClock(start = T0) {
    now = start;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    restoreClock = () => clock.mockRestore();
  }

  /** The manifest, joined with its times the way a reset reads them. */
  async function lineageOf(storage: KVStorage, generation: string) {
    const names = JSON.parse(
      required((await storage.get(manifestKey(generation))) ?? undefined),
    ) as string[];
    const times = JSON.parse(
      (await storage.get(timesKey(generation))) ?? "{}",
    ) as Record<string, number>;
    return names.map((name): Entry =>
      Object.hasOwn(times, name)
        ? { generation: name, retiredAt: required(times[name]) }
        : name,
    );
  }

  /** Bare names seed an untimed manifest, as an earlier release wrote it. */
  async function seedLineage(
    storage: KVStorage,
    current: string,
    lineage: readonly Entry[],
  ) {
    await storage.set("oauth:generation", current);
    await storage.set(
      manifestKey(current),
      JSON.stringify(lineage.map(generationOf)),
    );
    const timed = lineage.filter(
      (entry): entry is Exclude<Entry, string> => typeof entry !== "string",
    );
    if (timed.length > 0) {
      await storage.set(
        timesKey(current),
        JSON.stringify(
          Object.fromEntries(timed.map((e) => [e.generation, e.retiredAt])),
        ),
      );
    }
  }

  function countingStorage(backing: KVStorage) {
    const counter = { ops: 0 };
    const storage: KVStorage = {
      get: (key) => (counter.ops++, backing.get(key)),
      set: (key, value, opts) => (counter.ops++, backing.set(key, value, opts)),
      delete: (key) => (counter.ops++, backing.delete(key)),
    };
    return { storage, counter };
  }

  it("does the same storage work for every reset on one day, however many came before", async () => {
    useClock();
    const backing = memoryStorage();
    const { storage, counter } = countingStorage(backing);
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    const perReset: number[] = [];
    for (let reset = 0; reset < 150; reset++) {
      now += MINUTE;
      counter.ops = 0;
      await p.resetAuthorization();
      perReset.push(counter.ops);
    }

    // The generation, manifest, and times reads (3), the publication (2),
    // the fence (1), the retired epoch's six values, manifest, and times (8),
    // and one manifest probe for each of up to eight younger epochs, whose
    // cleanups all finished — the same from reset 9 to reset 150.
    expect(perReset).toEqual(
      Array.from({ length: 150 }, (_, reset) => 14 + Math.min(reset, 8)),
    );
    expect(new Set(perReset.slice(8))).toEqual(new Set([22]));
    expect(await lineageOf(backing, await p.generation())).toHaveLength(150);
  });

  it("keeps each reset's storage work flat once earlier generations pass the grace", async () => {
    useClock();
    const backing = memoryStorage();
    const { storage, counter } = countingStorage(backing);
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    const perReset: number[] = [];
    for (let reset = 0; reset < 40; reset++) {
      now += DAY + 1;
      counter.ops = 0;
      await p.resetAuthorization();
      perReset.push(counter.ops);
    }

    // Past the first, each reset also sweeps the one past-grace epoch (8)
    // and re-reads the lineage (2) before publishing.
    expect(perReset[0]).toBe(14);
    expect(perReset.slice(1)).toEqual(Array(39).fill(24));
    expect(await lineageOf(backing, await p.generation())).toHaveLength(1);
  });

  it("refuses a full lineage inside the grace and drains it once the grace passes", async () => {
    useClock();
    const storage = memoryStorage();
    await seedLineage(
      storage,
      "v2:current",
      Array.from({ length: 5_000 }, (_, i) => ({
        generation: `v2:old-${i}`,
        retiredAt: T0,
      })),
    );
    for (const index of [0, 15, 16, 4_999]) {
      await storage.set(
        oauthValueStorageKey("oauth:tokens", `v2:old-${index}`),
        "residue",
      );
    }
    const p = new KvOAuthProvider("svc", storage, REDIRECT);

    now = T0 + 60 * MINUTE;
    await expect(p.resetAuthorization()).rejects.toThrow(/backlog .* is full/);
    expect(await p.generation()).toBe("v2:current");

    now = T0 + DAY + 1;
    await p.resetAuthorization();
    const lineage = await lineageOf(storage, await p.generation());
    // The sixteen oldest were swept and left; the rest wait their turn.
    expect(lineage).toHaveLength(5_000 - 16 + 1);
    expect(lineage).toContainEqual({ generation: "v2:current", retiredAt: now });
    expect(lineage.map(generationOf)).not.toContain("v2:old-15");
    expect(lineage.map(generationOf)).toContain("v2:old-16");
    const tokens = (index: number) =>
      storage.get(oauthValueStorageKey("oauth:tokens", `v2:old-${index}`));
    expect(await tokens(0)).toBeNull();
    expect(await tokens(15)).toBeNull();
    expect(await tokens(16)).toBe("residue");

    for (let reset = 0; reset < 5; reset++) await p.resetAuthorization();
    expect(await lineageOf(storage, await p.generation())).toHaveLength(
      5_000 - 6 * 16 + 6,
    );
  });

  it("stamps an untimed lineage from an earlier release with the reset's own time", async () => {
    useClock();
    const storage = memoryStorage();
    await seedLineage(storage, "v2:current", [
      "legacy",
      "v2:older",
      { generation: "v2:timed", retiredAt: T0 - DAY / 2 },
    ]);
    const p = new KvOAuthProvider("svc", storage, REDIRECT);

    await p.resetAuthorization();
    const first = await p.generation();
    expect(await lineageOf(storage, first)).toEqual([
      { generation: "legacy", retiredAt: T0 },
      { generation: "v2:older", retiredAt: T0 },
      { generation: "v2:timed", retiredAt: T0 - DAY / 2 },
      { generation: "v2:current", retiredAt: T0 },
    ]);

    // The timed entry leaves once its own grace passes; the untimed ones got
    // a full grace from the reset that first read them.
    now = T0 + DAY / 2 + 1;
    await p.resetAuthorization();
    const second = await p.generation();
    expect((await lineageOf(storage, second)).map(generationOf)).toEqual([
      "legacy",
      "v2:older",
      "v2:current",
      first,
    ]);

    now = T0 + DAY + 1;
    await p.resetAuthorization();
    expect(await lineageOf(storage, await p.generation())).toEqual([
      { generation: first, retiredAt: T0 + DAY / 2 + 1 },
      { generation: second, retiredAt: now },
    ]);
  });

  it("restarts, on the day it upgrades, a connector an earlier release had filled", async () => {
    useClock();
    const storage = memoryStorage();
    await seedLineage(
      storage,
      "v2:current",
      Array.from({ length: 1_000 }, (_, i) => `v2:untimed-${i}`),
    );
    const p = new KvOAuthProvider("svc", storage, REDIRECT);

    // The earlier release refused this reset and every one after it.
    await p.resetAuthorization();
    now += MINUTE;
    await p.resetAuthorization();
    now += MINUTE;
    await p.resetAuthorization();
    expect(await lineageOf(storage, await p.generation())).toHaveLength(1_003);

    // A day later the stamped backlog starts to drain.
    now = T0 + DAY + 1;
    await p.resetAuthorization();
    expect(await lineageOf(storage, await p.generation())).toHaveLength(
      1_003 - 16 + 1,
    );
  });

  it("carries a past-grace generation whose sweep failed, and drops it once one succeeds", async () => {
    useClock();
    const backing = memoryStorage();
    let failing = true;
    const failingKey = oauthValueStorageKey("oauth:tokens", "v2:a");
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        if (failing && key === failingKey) throw new Error("sweep unavailable");
        await backing.delete(key);
      },
    };
    await seedLineage(backing, "v2:current", [
      { generation: "v2:a", retiredAt: T0 },
      { generation: "v2:b", retiredAt: T0 },
    ]);
    for (const generation of ["v2:a", "v2:b"]) {
      await backing.set(oauthValueStorageKey("oauth:tokens", generation), "residue");
      await backing.set(manifestKey(generation), "[]");
    }
    const p = new KvOAuthProvider("svc", storage, REDIRECT);

    now = T0 + DAY + 1;
    // Housekeeping for an old generation does not fail the reset.
    await p.resetAuthorization();
    const first = await p.generation();
    expect(await lineageOf(backing, first)).toEqual([
      { generation: "v2:a", retiredAt: T0 },
      { generation: "v2:current", retiredAt: now },
    ]);
    expect(await backing.get(failingKey)).toBe("residue");
    // A manifest waits for every one of its generation's values.
    expect(await backing.get(manifestKey("v2:a"))).toBe("[]");
    expect(await backing.get(manifestKey("v2:b"))).toBeNull();

    failing = false;
    now += 1;
    await p.resetAuthorization();
    expect(await backing.get(failingKey)).toBeNull();
    expect(await backing.get(manifestKey("v2:a"))).toBeNull();
    expect(
      (await lineageOf(backing, await p.generation())).map(generationOf),
    ).toEqual(["v2:current", first]);
  });

  it("keeps a bounded number of cleanup deletes in flight", async () => {
    useClock();
    const backing = memoryStorage();
    let inFlight = 0;
    let maxInFlight = 0;
    const deleted: string[] = [];
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        deleted.push(key);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        await backing.delete(key);
      },
    };
    await seedLineage(
      backing,
      "v2:current",
      Array.from({ length: 10 }, (_, i) => ({
        generation: `v2:expired-${i}`,
        retiredAt: T0 - DAY - 1,
      })),
    );

    await new KvOAuthProvider("svc", storage, REDIRECT).resetAuthorization();

    // Ten past-grace sweeps and the retired epoch: six values, a manifest,
    // and times each.
    expect(deleted).toHaveLength(88);
    expect(new Set(deleted).size).toBe(88);
    expect(maxInFlight).toBe(6);
  });

  it("fails on a falsy rejection and keeps the manifest of the generation it left behind", async () => {
    useClock();
    const backing = memoryStorage();
    let rejectKey: string | undefined;
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      async delete(key) {
        if (key === rejectKey) {
          rejectKey = undefined;
          // A store that rejects without a reason still failed.
          await Promise.reject(undefined);
        }
        await backing.delete(key);
      },
    };
    const p = new KvOAuthProvider("svc", storage, REDIRECT);
    await p.resetAuthorization();
    const first = await p.generation();
    const tokenKey = oauthValueStorageKey("oauth:tokens", first);
    const clientKey = oauthValueStorageKey("oauth:client", first);
    await backing.set(tokenKey, "residue");
    await backing.set(clientKey, "residue");
    rejectKey = tokenKey;

    const outcome = await p.resetAuthorization().then(
      () => ({ rejected: false }),
      (reason: unknown) => ({ rejected: true, reason }),
    );
    expect(outcome).toEqual({ rejected: true, reason: undefined });
    expect(await backing.get(tokenKey)).toBe("residue");
    expect(await backing.get(clientKey)).toBeNull();
    expect(await backing.get(manifestKey(first))).not.toBeNull();

    now += DAY + 1;
    await p.resetAuthorization();
    expect(await backing.get(tokenKey)).toBeNull();
    expect(await backing.get(manifestKey(first))).toBeNull();
  });

  it("carries a stale-write cleanup appended while a reset sweeps past-grace generations", async () => {
    useClock();
    const backing = memoryStorage();
    const sibling = "v2:sibling";
    const siblingTokens = oauthValueStorageKey("oauth:tokens", sibling);
    const { promise: atSiblingSet, resolve: siblingSetReached } = deferred<void>();
    const { promise: siblingSetGate, resolve: releaseSiblingSet } = deferred<void>();
    const { promise: atSweep, resolve: sweepReached } = deferred<void>();
    const { promise: sweepGate, resolve: releaseSweep } = deferred<void>();
    let failSiblingDelete = true;
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, opts) {
        if (key === siblingTokens) {
          siblingSetReached();
          await siblingSetGate;
        }
        await backing.set(key, value, opts);
      },
      async delete(key) {
        if (key === "oauth:client") {
          // The reset is sweeping the past-grace legacy namespace.
          sweepReached();
          await sweepGate;
        }
        if (failSiblingDelete && key === siblingTokens) {
          failSiblingDelete = false;
          throw new Error("late cleanup unavailable");
        }
        await backing.delete(key);
      },
    };
    const first = new KvOAuthProvider("svc", backing, REDIRECT);
    await first.resetAuthorization();
    const current = await first.generation();

    // A sibling epoch that lost the last-writer race is still what a stale
    // reader sees, and it starts a write under it.
    await backing.set("oauth:generation", sibling);
    const stale = new KvOAuthProvider("svc", storage, REDIRECT);
    stale.captureGeneration(sibling);
    const lateWrite = stale.saveTokens({
      access_token: "late-secret",
      token_type: "Bearer",
    });
    await atSiblingSet;
    await backing.set("oauth:generation", current);

    now = T0 + DAY + 1;
    const resetter = new KvOAuthProvider("svc", storage, REDIRECT);
    const reset = resetter.resetAuthorization();
    await atSweep;
    // While the reset sweeps, the stale write lands, fails to remove itself,
    // and appends its epoch to the live manifest the reset has already read.
    releaseSiblingSet();
    await lateWrite;
    expect(await lineageOf(backing, current)).toContainEqual({
      generation: sibling,
      retiredAt: now,
    });
    releaseSweep();
    await reset;

    expect(await lineageOf(backing, await resetter.generation())).toEqual([
      { generation: sibling, retiredAt: now },
      { generation: current, retiredAt: now },
    ]);
    expect(await resetter.tokens()).toBeUndefined();
    expect(await backing.get(siblingTokens)).not.toBeNull();

    now += DAY + 1;
    await resetter.resetAuthorization();
    expect(await backing.get(siblingTokens)).toBeNull();
  });

  it("restarts the grace of a listed generation that a late write lands in mid-sweep", async () => {
    useClock();
    const backing = memoryStorage();
    const expired = "v2:expired";
    const expiredTokens = oauthValueStorageKey("oauth:tokens", expired);
    const expiredClient = oauthValueStorageKey("oauth:client", expired);
    const { promise: atLateSet, resolve: lateSetReached } = deferred<void>();
    const { promise: lateSetGate, resolve: releaseLateSet } = deferred<void>();
    const { promise: atSweep, resolve: sweepReached } = deferred<void>();
    const { promise: sweepGate, resolve: releaseSweep } = deferred<void>();
    let lateWriteLanded = false;
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, opts) {
        if (key === expiredTokens) {
          lateSetReached();
          await lateSetGate;
          await backing.set(key, value, opts);
          lateWriteLanded = true;
          return;
        }
        await backing.set(key, value, opts);
      },
      async delete(key) {
        if (key === expiredClient) {
          sweepReached();
          await sweepGate;
        }
        if (lateWriteLanded && key === expiredTokens) {
          throw new Error("late cleanup unavailable");
        }
        await backing.delete(key);
      },
    };
    await seedLineage(backing, "v2:current", [
      { generation: expired, retiredAt: T0 },
    ]);

    // A writer that captured the expired epoch long ago, and whose write
    // passed its fence check before that epoch was retired.
    await backing.set("oauth:generation", expired);
    const late = new KvOAuthProvider("svc", storage, REDIRECT);
    late.captureGeneration(expired);
    const lateWrite = late.saveTokens({
      access_token: "late-secret",
      token_type: "Bearer",
    });
    await atLateSet;
    await backing.set("oauth:generation", "v2:current");

    now = T0 + DAY + 1;
    const resetter = new KvOAuthProvider("svc", storage, REDIRECT);
    const reset = resetter.resetAuthorization();
    // The sweep has deleted the expired tokens and is still running when the
    // late write lands and fails to delete itself. The epoch is already
    // listed, so only its time moves.
    await atSweep;
    releaseLateSet();
    await lateWrite;
    expect(await lineageOf(backing, "v2:current")).toEqual([
      { generation: expired, retiredAt: now },
    ]);
    releaseSweep();
    await reset;

    // Its sweep succeeded, but the re-read saw the new time and kept it.
    expect(await backing.get(expiredTokens)).not.toBeNull();
    expect(await resetter.tokens()).toBeUndefined();
    expect(await lineageOf(backing, await resetter.generation())).toEqual([
      { generation: expired, retiredAt: now },
      { generation: "v2:current", retiredAt: now },
    ]);

    lateWriteLanded = false;
    now += DAY + 1;
    await resetter.resetAuthorization();
    expect(await backing.get(expiredTokens)).toBeNull();
  });

  it("lets two resets from one predecessor sweep the same generations", async () => {
    useClock();
    const backing = memoryStorage();
    const old = ["v2:old-0", "v2:old-1", "v2:old-2"];
    let arrivals = 0;
    const { promise: bothSweeping, resolve: releaseSweeps } = deferred<void>();
    const gatedKey = oauthValueStorageKey("oauth:tokens", "v2:old-0");
    const fences: string[] = [];
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      async set(key, value, opts) {
        if (key === "oauth:generation") fences.push(value);
        await backing.set(key, value, opts);
      },
      async delete(key) {
        if (key === gatedKey) {
          if (++arrivals === 2) releaseSweeps();
          await bothSweeping;
        }
        await backing.delete(key);
      },
    };
    await seedLineage(
      backing,
      "v2:current",
      old.map((generation) => ({ generation, retiredAt: T0 })),
    );
    for (const generation of [...old, "v2:current"]) {
      await backing.set(oauthValueStorageKey("oauth:tokens", generation), "residue");
    }

    now = T0 + DAY + 1;
    const a = new KvOAuthProvider("svc", storage, REDIRECT);
    const b = new KvOAuthProvider("svc", storage, REDIRECT);
    await Promise.all([a.resetAuthorization(), b.resetAuthorization()]);

    expect(arrivals).toBe(2);
    const winner = await a.generation();
    expect(winner).toMatch(/^v2:/);
    expect(winner).not.toBe("v2:current");
    // Both swept, both reclaimed, and whichever fence landed last publishes
    // a lineage holding only the predecessor.
    expect(await lineageOf(backing, winner)).toEqual([
      { generation: "v2:current", retiredAt: now },
    ]);
    for (const generation of [...old, "v2:current"]) {
      expect(
        await backing.get(oauthValueStorageKey("oauth:tokens", generation)),
      ).toBeNull();
      expect(await backing.get(manifestKey(generation))).toBeNull();
    }

    // A reader whose replica still shows the losing epoch as current writes
    // a grant into it. Every reader of the authoritative generation reads the
    // winner's namespace, where that grant does not exist.
    expect(fences).toHaveLength(2);
    const loser = required(fences.find((fence) => fence !== winner));
    const staleReplica = new KvOAuthProvider("svc", {
      get: (key) =>
        key === "oauth:generation" ? Promise.resolve(loser) : backing.get(key),
      set: (key, value, opts) => backing.set(key, value, opts),
      delete: (key) => backing.delete(key),
    }, REDIRECT);
    await staleReplica.saveTokens({
      access_token: "loser-access",
      token_type: "Bearer",
      refresh_token: "loser-refresh",
    });
    const loserTokens = oauthValueStorageKey("oauth:tokens", loser);
    expect(await backing.get(loserTokens)).toContain("loser-refresh");
    expect(await a.tokens()).toBeUndefined();
    expect(await new KvOAuthProvider("svc", backing, REDIRECT).tokens())
      .toBeUndefined();

    // The next reset proceeds from the winner, and the losing epoch's write
    // stays out of every namespace a reader can reach.
    now += MINUTE;
    await a.resetAuthorization();
    expect((await lineageOf(backing, await a.generation())).map(generationOf))
      .toEqual(["v2:current", winner]);
    expect(await a.tokens()).toBeUndefined();
    expect(await new KvOAuthProvider("svc", backing, REDIRECT).tokens())
      .toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sealed OAuth state: tokens, client registration, and the PKCE verifier are
// ciphertext at rest when the deployment has a vault that can seal.
// ---------------------------------------------------------------------------
describe("KvOAuthProvider sealed state", () => {
  const SEAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const OTHER_SEAL_KEY = Buffer.alloc(32, 9).toString("base64");

  function sealerFor(key = SEAL_KEY, logger: Logger = silentLogger) {
    return vaultOAuthSealer(
      new CredentialVault(memoryStorage(), key),
      "svc",
      undefined,
      logger,
    );
  }

  function sealedProvider(storage: KVStorage, sealer = sealerFor()) {
    return new KvOAuthProvider("svc", storage, REDIRECT, undefined, true, sealer);
  }

  function isSealed(raw: string | null): boolean {
    if (raw === null) return false;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return (
        parsed.connectaOAuthSealed === 1 &&
        typeof parsed.sealed === "string" &&
        !("value" in parsed)
      );
    } catch {
      return false;
    }
  }

  const issuer = { issuer: "https://auth.example" };
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

  it("reseals a preserved registration under the replacement physical key", async () => {
    const storage = memoryStorage();
    const p = new KvOAuthProvider(
      "svc", storage, REDIRECT, undefined, true, sealerFor(), undefined,
      "same-config",
    );
    const firstGeneration = await p.bumpGeneration();
    await p.saveClientInformation(client, issuer);
    const firstKey = oauthValueStorageKey("oauth:client", firstGeneration);
    const firstCiphertext = await storage.get(firstKey);
    expect(isSealed(firstCiphertext)).toBe(true);

    await p.resetAuthorization(false, true);
    const secondGeneration = required((await storage.get("oauth:generation")) ?? undefined);
    const secondKey = oauthValueStorageKey("oauth:client", secondGeneration);
    const secondCiphertext = await storage.get(secondKey);
    expect(isSealed(secondCiphertext)).toBe(true);
    expect(secondCiphertext).not.toBe(firstCiphertext);
    expect(await storage.get(firstKey)).toBeNull();
    await expect(p.clientInformation(issuer)).resolves.toMatchObject(client);

    await p.resetAuthorization(true);
    expect(await p.clientInformation(issuer)).toBeUndefined();
  });

  it("seals tokens, client registration, and the verifier; flow bookkeeping stays plaintext", async () => {
    const storage = memoryStorage();
    const p = sealedProvider(storage);
    const generation = await p.bumpGeneration();
    const discovery: OAuthDiscoveryState = {
      authorizationServerUrl: "https://auth.example",
    };

    await p.saveClientInformation(client, issuer);
    await p.saveTokens(tokens, issuer);
    await p.saveCodeVerifier("secret-verifier");
    const state = await p.state();
    await p.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
    await p.saveDiscoveryState(discovery);

    const raw = (key: string) => storage.get(oauthValueStorageKey(key, generation));
    for (const key of ["oauth:tokens", "oauth:client", "oauth:verifier"]) {
      const value = await raw(key);
      expect(isSealed(value)).toBe(true);
      for (const secret of ["secret-access", "secret-refresh", "dcr-secret", "secret-verifier"]) {
        expect(value).not.toContain(secret);
      }
    }
    for (const [key, value] of [
      ["oauth:state", state],
      ["oauth:pending", "https://auth.example/authorize?x=1"],
      ["oauth:discovery", discovery],
    ] as const) {
      expect(JSON.parse(required((await raw(key)) ?? undefined))).toEqual({
        connectaOAuthVersion: 2,
        generation,
        // Only the pending URL carries its write time, and it is plaintext.
        ...(key === "oauth:pending" ? { writtenAt: expect.any(Number) } : {}),
        value,
      });
    }
    expect(await storage.get("oauth:generation")).toBe(generation);

    const reader = sealedProvider(storage);
    expect(await reader.tokens(issuer)).toEqual(tokens);
    expect(await reader.clientInformation(issuer)).toEqual(client);
    expect(await reader.codeVerifier()).toBe("secret-verifier");
    expect(await reader.discoveryState()).toEqual(discovery);
    expect(await reader.verifyState(state)).toBe(true);

    // Without the sealer the ciphertext is nothing a caller could use.
    const unsealed = new KvOAuthProvider("svc", storage, REDIRECT);
    expect(await unsealed.tokens()).toBeUndefined();
    expect(await unsealed.clientInformation()).toBeUndefined();
    await expect(unsealed.codeVerifier()).rejects.toThrow("No PKCE code verifier");
  });

  it.each([
    {
      shape: "raw legacy strings",
      generation: null,
      tokens: () => JSON.stringify(tokens),
      verifier: () => "legacy-verifier",
      ctx: undefined,
    },
    {
      shape: "v1 envelopes",
      generation: "7",
      tokens: () =>
        JSON.stringify({ connectaOAuthVersion: 1, generation: "7", value: tokens }),
      verifier: () =>
        JSON.stringify({ connectaOAuthVersion: 1, generation: "7", value: "legacy-verifier" }),
      ctx: undefined,
    },
    {
      shape: "v2 envelopes",
      generation: "v2:seeded",
      tokens: () =>
        JSON.stringify({
          connectaOAuthVersion: 2,
          generation: "v2:seeded",
          issuer: issuer.issuer,
          value: tokens,
        }),
      verifier: () =>
        JSON.stringify({
          connectaOAuthVersion: 2,
          generation: "v2:seeded",
          value: "legacy-verifier",
        }),
      ctx: issuer,
    },
  ])("upgrades $shape to sealed state on read", async (seed) => {
    const storage = memoryStorage();
    if (seed.generation !== null) {
      await storage.set("oauth:generation", seed.generation);
    }
    const tokensKey = oauthValueStorageKey("oauth:tokens", seed.generation);
    const verifierKey = oauthValueStorageKey("oauth:verifier", seed.generation);
    await storage.set(tokensKey, seed.tokens());
    await storage.set(verifierKey, seed.verifier());

    const p = sealedProvider(storage);
    expect(await p.tokens(seed.ctx)).toEqual(tokens);
    expect(await p.codeVerifier()).toBe("legacy-verifier");

    for (const key of [tokensKey, verifierKey]) {
      const value = await storage.get(key);
      expect(isSealed(value)).toBe(true);
      expect(value).not.toContain("secret-access");
      expect(value).not.toContain("legacy-verifier");
    }
    // The upgrade re-encodes; it neither moves the epoch nor loses the issuer.
    expect(await storage.get("oauth:generation")).toBe(seed.generation);
    const reader = sealedProvider(storage);
    expect(await reader.tokens(seed.ctx)).toEqual(tokens);
    expect(await reader.codeVerifier()).toBe("legacy-verifier");
    expect(await storage.get("oauth:generation")).toBe(seed.generation);
  });

  it("does not rewrite plaintext after the generation has moved", async () => {
    const base = memoryStorage();
    const plaintext = JSON.stringify(tokens);
    await base.set("oauth:tokens", plaintext);
    let moved = false;
    // A force reset lands between this read and the upgrade write.
    const storage: KVStorage = {
      ...base,
      async get(key) {
        const value = await base.get(key);
        if (key === "oauth:tokens" && !moved) {
          moved = true;
          await base.set("oauth:generation", "v2:moved");
        }
        return value;
      },
    };

    await sealedProvider(storage).tokens();

    expect(moved).toBe(true);
    expect(await base.get("oauth:tokens")).toBe(plaintext);
    expect(await base.get(oauthValueStorageKey("oauth:tokens", "v2:moved"))).toBeNull();
    expect(required(await base.list!(""))).toEqual(["oauth:generation", "oauth:tokens"]);
  });

  it("reads tampered or foreign-key ciphertext as absent, and warns without the secret", async () => {
    const storage = memoryStorage();
    await sealedProvider(storage).saveTokens(tokens);
    const sealed = required((await storage.get("oauth:tokens")) ?? undefined);
    expect(isSealed(sealed)).toBe(true);

    const wrongKey = spyLogger();
    expect(
      await sealedProvider(storage, sealerFor(OTHER_SEAL_KEY, wrongKey.logger)).tokens(),
    ).toBeUndefined();
    expect(wrongKey.warnings().join("\n")).toMatch(/"svc".*oauth:tokens/);

    // Flip one base64 digit in the ciphertext's middle: still well-formed,
    // no longer authentic.
    const envelope = JSON.parse(sealed) as { sealed: string };
    const at = Math.floor(envelope.sealed.length * 0.75);
    const flipped = envelope.sealed[at] === "A" ? "B" : "A";
    await storage.set(
      "oauth:tokens",
      JSON.stringify({
        ...envelope,
        sealed: envelope.sealed.slice(0, at) + flipped + envelope.sealed.slice(at + 1),
      }),
    );
    const tampered = spyLogger();
    expect(
      await sealedProvider(storage, sealerFor(SEAL_KEY, tampered.logger)).tokens(),
    ).toBeUndefined();
    expect(tampered.warnings()).toHaveLength(1);
    for (const warning of [...wrongKey.warnings(), ...tampered.warnings()]) {
      expect(warning).not.toContain("secret-access");
      expect(warning).not.toContain(envelope.sealed);
    }
  });
});

describe("OAuthRefreshCoordinator", () => {
  const refreshInit = (token: string): RequestInit => ({
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
    }),
  });

  const trackedAbortSignal = () => {
    const controller = new AbortController();
    let listeners = 0;
    const signal = {
      get aborted() {
        return controller.signal.aborted;
      },
      get reason() {
        return controller.signal.reason;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean,
      ) {
        if (type === "abort") listeners++;
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean,
      ) {
        if (type === "abort") listeners--;
        controller.signal.removeEventListener(type, listener, options);
      },
    } as unknown as AbortSignal;
    return { controller, signal, listeners: () => listeners };
  };

  it("settles non-2xx waiters at fetch completion and permits a later retry", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const retry = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, follower, retry]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let attempts = 0;
    let releaseFailure!: () => void;
    let observedFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      observedFirstRequest = resolve;
    });
    const failureBarrier = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const baseFetch: FetchLike = async () => {
      attempts++;
      if (attempts === 1) {
        observedFirstRequest();
        await failureBarrier;
        return Response.json(
          { error: "server_error", error_description: "temporarily down" },
          { status: 503 },
        );
      }
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };
    const ownerRefresh = coordinator.coordinatedFetch(owner, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-old"),
    );
    await firstRequest;
    let observedFollowerOldToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerOldToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") {
        observedFollowerOldToken();
      }
      return tokens;
    };
    const followerRefresh = coordinator.coordinatedFetch(follower, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-old"),
    );
    const firstOutcomes = Promise.allSettled([ownerRefresh, followerRefresh]);
    await followerRead;
    expect(attempts).toBe(1);
    releaseFailure();
    const [ownerOutcome, followerOutcome] = await firstOutcomes;

    expect(ownerOutcome.status).toBe("fulfilled");
    if (ownerOutcome.status === "fulfilled") {
      expect(ownerOutcome.value.status).toBe(503);
    }
    expect(followerOutcome).toMatchObject({
      status: "rejected",
      reason: new Error("OAuth refresh failed with HTTP 503."),
    });

    const response = await coordinator.coordinatedFetch(retry, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-old"),
    );
    const tokens = (await response.json()) as OAuthTokens;
    await retry.saveTokens(tokens);

    expect(attempts).toBe(2);
    expect(await retry.tokens()).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("releases an SDK-invalid success body without clearing its exact retry", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const malformed = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const retry = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [malformed, retry, follower]) {
      provider.captureGeneration("legacy");
    }
    await malformed.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });

    let attempts = 0;
    const baseFetch: FetchLike = async () => {
      attempts++;
      return attempts === 1
        ? Response.json({
            access_token: "access-malformed",
            token_type: "Bearer",
            refresh_token: 123,
          })
        : Response.json({
            access_token: "access-new",
            token_type: "Bearer",
            refresh_token: "refresh-new",
            id_token: "id-new",
            scope: "read",
            expires_in: "3600",
          });
    };

    const malformedResponse = await coordinator.coordinatedFetch(
      malformed,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await expect(malformedResponse.json()).resolves.toMatchObject({
      refresh_token: 123,
    });

    // The SDK rejects the first body before any provider callback. Its gate
    // must already be gone so this same-generation attempt can own a retry.
    const retryResponse = await coordinator.coordinatedFetch(
      retry,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    expect(attempts).toBe(2);

    // A delayed callback from the malformed attempt must not clear the newer
    // exact flight. The valid response includes every SDK string optional and
    // an expires_in value its schema coerces to a number.
    await malformed.redirectToAuthorization(
      new URL("https://auth.example/authorize"),
    );
    let observedFollowerOldToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerOldToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") {
        observedFollowerOldToken();
      }
      return tokens;
    };
    let followerSettled = false;
    const followerResponse = coordinator.coordinatedFetch(
      follower,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old")).then(
      (response) => {
        followerSettled = true;
        return response;
      },
    );
    await followerRead;
    await Promise.resolve();
    expect(followerSettled).toBe(false);
    expect(attempts).toBe(2);

    const raw = (await retryResponse.json()) as Record<string, unknown>;
    await retry.saveTokens({
      access_token: String(raw.access_token),
      token_type: String(raw.token_type),
      refresh_token: String(raw.refresh_token),
      id_token: String(raw.id_token),
      scope: String(raw.scope),
      expires_in: Number(raw.expires_in),
    });
    const replayed = (await (await followerResponse).json()) as OAuthTokens;
    await follower.saveTokens(replayed);

    expect(attempts).toBe(2);
    expect(replayed).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    });
  });

  it("lets an aborted follower leave an owner flight without poisoning it", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const later = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, follower, later]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };

    const ownerResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    let observedFollowerOldToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerOldToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") {
        observedFollowerOldToken();
      }
      return tokens;
    };
    const controller = new AbortController();
    const reason = new DOMException("Follower scope ended", "AbortError");
    const followerRefresh = coordinator.coordinatedFetch(
      follower,
      baseFetch,
      controller.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await followerRead;
    controller.abort(reason);

    await expect(followerRefresh).rejects.toBe(reason);
    expect(upstreamRequests).toBe(1);

    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    const laterResponse = await coordinator.coordinatedFetch(
      later,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const replayed = (await laterResponse.json()) as OAuthTokens;
    await later.saveTokens(replayed);

    expect(upstreamRequests).toBe(1);
    expect(replayed).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
    expect(await later.tokens()).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("aborts the owner fetch and fails joined scopes without promotion", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const later = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, follower, later]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });

    const trackedOwner = trackedAbortSignal();
    const trackedFollower = trackedAbortSignal();
    let upstreamRequests = 0;
    let observedOwnerFetch!: () => void;
    const ownerFetch = new Promise<void>((resolve) => {
      observedOwnerFetch = resolve;
    });
    let fetchAbortListenerActive = false;
    let firstFetchSignal: AbortSignal | null | undefined;
    const baseFetch: FetchLike = async (_input, init) => {
      upstreamRequests++;
      if (upstreamRequests === 1) {
        firstFetchSignal = init?.signal;
        observedOwnerFetch();
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeDefined();
          const onAbort = () => {
            fetchAbortListenerActive = false;
            signal?.removeEventListener("abort", onAbort);
            reject(signal?.reason);
          };
          fetchAbortListenerActive = true;
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };

    const ownerRefresh = coordinator.coordinatedFetch(
      owner,
      baseFetch,
      trackedOwner.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await ownerFetch;
    let observedFollowerOldToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerOldToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") {
        observedFollowerOldToken();
      }
      return tokens;
    };
    const followerRefresh = coordinator.coordinatedFetch(
      follower,
      baseFetch,
      trackedFollower.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const outcomes = Promise.allSettled([ownerRefresh, followerRefresh]);
    await followerRead;
    await vi.waitFor(() => expect(trackedFollower.listeners()).toBe(1));

    const ownerAbort = new DOMException("Owner scope ended", "AbortError");
    trackedOwner.controller.abort(ownerAbort);
    await expect(outcomes).resolves.toEqual([
      { status: "rejected", reason: ownerAbort },
      { status: "rejected", reason: ownerAbort },
    ]);
    expect(firstFetchSignal).toBe(trackedOwner.signal);
    expect(upstreamRequests).toBe(1);
    expect(fetchAbortListenerActive).toBe(false);
    expect(trackedOwner.listeners()).toBe(0);
    expect(trackedFollower.listeners()).toBe(0);

    const laterController = new AbortController();
    const retryResponse = await coordinator.coordinatedFetch(
      later,
      baseFetch,
      laterController.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await later.saveTokens((await retryResponse.json()) as OAuthTokens);

    expect(upstreamRequests).toBe(2);
    expect(await later.tokens()).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it.each(["redirect", "denied-redirect", "invalidate"])("releases a successful fetch when the SDK chooses %s instead of saveTokens", async (ending) => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider("svc", storage, REDIRECT, coordinator, ending !== "denied-redirect");
    const retry = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    const tokens = { access_token: "old", token_type: "Bearer", refresh_token: "refresh-old" };
    await owner.saveTokens(tokens);
    const fetch = vi.fn(async () => Response.json({ ...tokens, access_token: "new" }));
    await coordinator.coordinatedFetch(owner, fetch)("https://auth.example/token", refreshInit("refresh-old"));
    if (ending === "invalidate") {
      await owner.invalidateCredentials("tokens");
      await retry.saveTokens(tokens);
    } else if (ending === "denied-redirect") {
      await expect(owner.redirectToAuthorization(new URL("https://auth.example/authorize"))).rejects.toBeInstanceOf(UnauthorizedError);
    } else {
      await owner.redirectToAuthorization(new URL("https://auth.example/authorize"));
    }
    const response = await coordinator.coordinatedFetch(retry, fetch)("https://auth.example/token", refreshInit("refresh-old"));
    expect(response.status).toBe(200);
    await retry.saveTokens(await response.json() as OAuthTokens);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await retry.tokens()).toMatchObject({ access_token: "new" });
  });

  it("bounds successful token response reads and releases the failed owner", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    const retry = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    const tokens = { access_token: "old", token_type: "Bearer", refresh_token: "refresh-old" };
    await owner.saveTokens(tokens);
    let pulled = 0;
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(4096).fill(32));
        if (pulled === 100) controller.close();
      },
    })));
    await expect(coordinator.coordinatedFetch(owner, fetch)("https://auth.example/token", refreshInit("refresh-old")))
      .rejects.toThrow("exceeded 65536 bytes");
    expect(pulled).toBeLessThan(100);
    const response = await coordinator.coordinatedFetch(retry, async () => Response.json(tokens))(
      "https://auth.example/token", refreshInit("refresh-old"));
    expect(response.status).toBe(200);
    await retry.saveTokens(tokens);
  });

  it("does not start a token request after its scope is already aborted", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const provider = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    await provider.saveTokens({ access_token: "old", token_type: "Bearer", refresh_token: "refresh-old" });
    const controller = new AbortController();
    controller.abort(new Error("scope ended"));
    const fetch = vi.fn(async () => Response.json({ access_token: "new", token_type: "Bearer" }));
    await expect(coordinator.coordinatedFetch(provider, fetch, controller.signal)(
      "https://auth.example/token", refreshInit("refresh-old"))).rejects.toThrow("scope ended");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds repeated revision changes while reading credentials", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const provider = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    const tokens = { access_token: "same", token_type: "Bearer", refresh_token: "refresh-old" };
    await provider.saveTokens(tokens);
    let interruptions = 0;
    const read = provider.tokens.bind(provider);
    provider.tokens = async () => {
      const snapshot = await read();
      // Another request finishes a refresh during each read. Stop at 100 so
      // the old unbounded implementation fails an assertion rather than spins.
      if (interruptions++ < 100) {
        const owner = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
        await coordinator.coordinatedFetch(owner, async () => Response.json(tokens))(
          "https://auth.example/token", refreshInit("refresh-old"));
        await owner.saveTokens(tokens);
      }
      return snapshot;
    };
    const response = await coordinator.coordinatedFetch(provider, async () => Response.json(tokens))(
      "https://auth.example/token", refreshInit("refresh-old"));
    expect(response.status).toBe(503);
    expect(interruptions).toBeLessThan(100);
    expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("persists an aborted owner's accepted rotation and hands it to a contender", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, contender]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    const redeemed: string[] = [];
    const baseFetch: FetchLike = async (_input, init) => {
      upstreamRequests++;
      redeemed.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };
    const trackedOwner = trackedAbortSignal();
    // The owner has its valid response; the SDK has not saved it yet.
    await coordinator.coordinatedFetch(
      owner,
      baseFetch,
      trackedOwner.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));

    let observedTokenRead!: () => void;
    let releaseTokenRead!: () => void;
    const tokenRead = new Promise<void>((resolve) => {
      observedTokenRead = resolve;
    });
    const tokenReadBarrier = new Promise<void>((resolve) => {
      releaseTokenRead = resolve;
    });
    const readContenderTokens = contender.tokens.bind(contender);
    contender.tokens = async (issuerContext) => {
      observedTokenRead();
      await tokenReadBarrier;
      return readContenderTokens(issuerContext);
    };
    const contenderRefresh = coordinator.coordinatedFetch(
      contender,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await tokenRead;

    // Cancelling the owner now means its SDK saveTokens never arrives. The
    // authorization server has already consumed refresh-old, so the host must
    // persist refresh-new itself and the contender must receive that rotation
    // rather than redeeming the retired token a second time (#526).
    trackedOwner.controller.abort(
      new DOMException("Owner scope ended", "AbortError"),
    );
    releaseTokenRead();
    const recovered = await contenderRefresh;
    expect(recovered.status).toBe(200);
    const replayed = await recovered.json() as OAuthTokens;
    expect(replayed).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new" });
    await contender.saveTokens(replayed);
    expect(await contender.tokens()).toMatchObject({ access_token: "access-new" });
    expect(upstreamRequests).toBe(1);
    expect(redeemed).toEqual(["refresh-old"]);
    expect(trackedOwner.listeners()).toBe(0);
    // A delayed SDK save from the cancelled owner is a duplicate of the same
    // rotation, and the gate is free for the next refresh.
    await expect(owner.saveTokens(replayed)).resolves.toBeUndefined();
    expect(await contender.tokens()).toMatchObject({ access_token: "access-new" });
    const later = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    later.captureGeneration("legacy");
    const next = await coordinator.coordinatedFetch(
      later,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-new"));
    expect(next.status).toBe(200);
    expect(upstreamRequests).toBe(2);
    expect(redeemed).toEqual(["refresh-old", "refresh-new"]);
  });

  it("keeps a refused grant's flight standing when its owner aborts during the discard", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    const contender = new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
    for (const provider of [owner, contender]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    const tokenKey = oauthValueStorageKey("oauth:tokens", "legacy");
    const discard = deferred<void>();
    const discarding = deferred<void>();
    const compareAndSet = storage.compareAndSet!.bind(storage);
    storage.compareAndSet = async (key, expected, next, opts) => {
      if (key === tokenKey && next === null) {
        discarding.resolve();
        await discard.promise;
      }
      return compareAndSet(key, expected, next, opts);
    };
    const redeemed: string[] = [];
    const baseFetch: FetchLike = async (_input, init) => {
      redeemed.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    };
    const ownerScope = new AbortController();
    const ownerAbort = new DOMException("Owner scope ended", "AbortError");
    const ownerRefresh = coordinator.coordinatedFetch(
      owner,
      baseFetch,
      ownerScope.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const ownerOutcome = ownerRefresh.then(
      (response) => response.status,
      (error: unknown) => error,
    );
    await discarding.promise;

    // The authorization server has refused refresh-old, and the owner is
    // deleting it. Cancelling the owner now must not free the generation
    // for a contender to redeem the refused token a second time (P1-S09).
    ownerScope.abort(ownerAbort);
    const contenderScope = trackedAbortSignal();
    const contenderRefresh = coordinator.coordinatedFetch(
      contender,
      baseFetch,
      contenderScope.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const contenderOutcome = contenderRefresh.then(
      (response) => response.status,
      (error: unknown) => error,
    );
    // One listener: the contender is either waiting on the owner's flight or
    // has published its own. Only the second redeems refresh-old again.
    await vi.waitFor(() => expect(contenderScope.listeners()).toBe(1));
    discard.resolve();

    const [contenderResult, ownerResult] = await Promise.all([
      contenderOutcome,
      ownerOutcome,
    ]);
    expect(redeemed).toEqual(["refresh-old"]);
    // The contender inherits the owner's refusal, verdict and all.
    expect(contenderResult).toEqual(
      new Error("OAuth refresh failed with HTTP 400."),
    );
    expect(ownerResult).toBe(ownerAbort);
    expect(contenderScope.listeners()).toBe(0);
    expect(await storage.get(tokenKey)).toBeNull();
  });

  it("surfaces a pending mutation as retryable without starting authorization", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const issuer = "https://auth.example";
    const mcpUrl = "https://downstream.example/mcp";
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, contender]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveClientInformation(
      {
        client_id: "connecta-client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      },
      { issuer },
    );
    await owner.saveTokens(
      {
        access_token: "access-old",
        token_type: "Bearer",
        refresh_token: "refresh-old",
      },
      { issuer },
    );
    let tokenRequests = 0;
    const baseFetch: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.href === `${issuer}/token`) {
        tokenRequests++;
        return Response.json({
          access_token: "access-new",
          token_type: "Bearer",
          refresh_token: "refresh-new",
        });
      }
      if (
        url.href ===
        "https://downstream.example/.well-known/oauth-protected-resource/mcp"
      ) {
        return Response.json({
          resource: mcpUrl,
          authorization_servers: [issuer],
        });
      }
      if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };
    const trackedOwner = trackedAbortSignal();
    await coordinator.coordinatedFetch(
      owner,
      baseFetch,
      trackedOwner.signal,
    )(`${issuer}/token`, refreshInit("refresh-old"));
    const writing = deferred<void>();
    const writeGate = deferred<void>();
    const originalSet = storage.set.bind(storage);
    storage.set = async (key, value, ttl) => {
      if (key.startsWith("oauth:tokens") && value.includes("access-new")) {
        writing.resolve();
        await writeGate.promise;
      }
      await originalSet(key, value, ttl);
    };
    const saving = owner.saveTokens({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
    await writing.promise;
    trackedOwner.controller.abort(
      new DOMException("Owner scope ended", "AbortError"),
    );

    let sdkError: unknown;
    try {
      await auth(contender, {
        serverUrl: mcpUrl,
        fetchFn: coordinator.coordinatedFetch(contender, baseFetch),
      });
    } catch (error) {
      sdkError = error;
    }

    expect(sdkError).toBeInstanceOf(Error);
    expect(classifyCallError(sdkError)).toMatchObject({ retryable: true });
    expect(await contender.pendingAuthorizationUrl()).toBeUndefined();
    expect(tokenRequests).toBe(1);
    writeGate.resolve();
    await saving;

  });

  it("rereads a stale snapshot when an active refresh completes", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, contender]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };
    const ownerResponse = await coordinator.coordinatedFetch(owner, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-old"),
    );

    let observedStaleSnapshot!: () => void;
    let releaseStaleSnapshot!: () => void;
    const staleSnapshot = new Promise<void>((resolve) => {
      observedStaleSnapshot = resolve;
    });
    const staleSnapshotBarrier = new Promise<void>((resolve) => {
      releaseStaleSnapshot = resolve;
    });
    let holdFirstRead = true;
    const readContenderTokens = contender.tokens.bind(contender);
    contender.tokens = async (issuerContext) => {
      const tokens = await readContenderTokens(issuerContext);
      if (holdFirstRead) {
        holdFirstRead = false;
        observedStaleSnapshot();
        await staleSnapshotBarrier;
      }
      return tokens;
    };
    const contenderRefresh = coordinator.coordinatedFetch(
      contender,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await staleSnapshot;

    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    releaseStaleSnapshot();
    const replayed = (await (await contenderRefresh).json()) as OAuthTokens;

    expect(upstreamRequests).toBe(1);
    expect(replayed).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("detects a complete flight ABA during a stale token snapshot", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [contender, owner]) {
      provider.captureGeneration("legacy");
    }
    await contender.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };

    let observedStaleSnapshot!: () => void;
    let releaseStaleSnapshot!: () => void;
    const staleSnapshot = new Promise<void>((resolve) => {
      observedStaleSnapshot = resolve;
    });
    const staleSnapshotBarrier = new Promise<void>((resolve) => {
      releaseStaleSnapshot = resolve;
    });
    let holdFirstRead = true;
    const readContenderTokens = contender.tokens.bind(contender);
    contender.tokens = async (issuerContext) => {
      const tokens = await readContenderTokens(issuerContext);
      if (holdFirstRead) {
        holdFirstRead = false;
        observedStaleSnapshot();
        await staleSnapshotBarrier;
      }
      return tokens;
    };
    const contenderRefresh = coordinator.coordinatedFetch(
      contender,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await staleSnapshot;

    const ownerResponse = await coordinator.coordinatedFetch(owner, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-old"),
    );
    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    releaseStaleSnapshot();
    const replayed = (await (await contenderRefresh).json()) as OAuthTokens;

    expect(upstreamRequests).toBe(1);
    expect(replayed).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("replays byte-identical success completed before wrapped fetch", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, contender]) {
      provider.captureGeneration("legacy");
    }
    const unchanged: OAuthTokens = {
      access_token: "access-same",
      token_type: "Bearer",
      refresh_token: "refresh-same",
    };
    await owner.saveTokens(unchanged);
    await contender.tokens({ issuer: "https://auth.example" });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json(unchanged);
    };

    const ownerResponse = await coordinator.coordinatedFetch(owner, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-same"),
    );
    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    const replayedResponse = await coordinator.coordinatedFetch(
      contender,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-same"));
    const replayed = (await replayedResponse.json()) as OAuthTokens;

    expect(upstreamRequests).toBe(1);
    expect(replayed).toEqual(unchanged);
  });

  it("captures success identity before the SDK token-basis read", async () => {
    const backing = memoryStorage();
    let blockBasisRead = false;
    let observedBasisRead!: () => void;
    let releaseBasisRead!: () => void;
    const basisRead = new Promise<void>((resolve) => {
      observedBasisRead = resolve;
    });
    const basisReadBarrier = new Promise<void>((resolve) => {
      releaseBasisRead = resolve;
    });
    const storage: KVStorage = {
      get: async (key) => {
        const snapshot = await backing.get(key);
        if (blockBasisRead && key === "oauth:tokens") {
          blockBasisRead = false;
          observedBasisRead();
          await basisReadBarrier;
        }
        return snapshot;
      },
      set: (key, value, options) => backing.set(key, value, options),
      delete: (key) => backing.delete(key),
    };
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, contender]) {
      provider.captureGeneration("legacy");
    }
    const unchanged: OAuthTokens = {
      access_token: "access-same",
      token_type: "Bearer",
      refresh_token: "refresh-same",
    };
    await owner.saveTokens(unchanged);
    blockBasisRead = true;
    const contenderBasis = contender.tokens({
      issuer: "https://auth.example",
    });
    await basisRead;

    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json(unchanged);
    };
    const ownerResponse = await coordinator.coordinatedFetch(owner, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-same"),
    );
    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    releaseBasisRead();
    await contenderBasis;

    const replayedResponse = await coordinator.coordinatedFetch(
      contender,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-same"));
    const replayed = (await replayedResponse.json()) as OAuthTokens;

    expect(upstreamRequests).toBe(1);
    expect(replayed).toEqual(unchanged);
  });

  it("detects byte-identical success across a complete flight ABA", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const contender = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [contender, owner]) {
      provider.captureGeneration("legacy");
    }
    const unchanged: OAuthTokens = {
      access_token: "access-same",
      token_type: "Bearer",
      refresh_token: "refresh-same",
    };
    await contender.saveTokens(unchanged);
    await contender.tokens({ issuer: "https://auth.example" });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json(unchanged);
    };

    let observedStaleSnapshot!: () => void;
    let releaseStaleSnapshot!: () => void;
    const staleSnapshot = new Promise<void>((resolve) => {
      observedStaleSnapshot = resolve;
    });
    const staleSnapshotBarrier = new Promise<void>((resolve) => {
      releaseStaleSnapshot = resolve;
    });
    let holdFirstRead = true;
    const readContenderTokens = contender.tokens.bind(contender);
    contender.tokens = async (issuerContext) => {
      const tokens = await readContenderTokens(issuerContext);
      if (holdFirstRead) {
        holdFirstRead = false;
        observedStaleSnapshot();
        await staleSnapshotBarrier;
      }
      return tokens;
    };
    const contenderRefresh = coordinator.coordinatedFetch(
      contender,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-same"));
    await staleSnapshot;

    const ownerResponse = await coordinator.coordinatedFetch(owner, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-same"),
    );
    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    releaseStaleSnapshot();
    const replayed = (await (await contenderRefresh).json()) as OAuthTokens;

    expect(upstreamRequests).toBe(1);
    expect(replayed).toEqual(unchanged);
  });

  it("rechecks generation after a stale token read", async () => {
    const backing = memoryStorage();
    let blockTokenRead = false;
    let observedTokenRead!: () => void;
    let releaseTokenRead!: () => void;
    const tokenRead = new Promise<void>((resolve) => {
      observedTokenRead = resolve;
    });
    const tokenReadBarrier = new Promise<void>((resolve) => {
      releaseTokenRead = resolve;
    });
    const storage: KVStorage = {
      get: async (key) => {
        const snapshot = await backing.get(key);
        if (blockTokenRead && key === "oauth:tokens") {
          blockTokenRead = false;
          observedTokenRead();
          await tokenReadBarrier;
        }
        return snapshot;
      },
      set: (key, value, options) => backing.set(key, value, options),
      delete: (key) => backing.delete(key),
    };
    const coordinator = new OAuthRefreshCoordinator();
    const stale = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    stale.captureGeneration("legacy");
    await stale.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    blockTokenRead = true;
    const staleRefresh = coordinator.coordinatedFetch(stale, async () => {
      upstreamRequests++;
      return Response.json({});
    })("https://auth.example/token", refreshInit("refresh-old"));
    await tokenRead;

    const resetter = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    await resetter.resetAuthorization();
    releaseTokenRead();
    const response = await staleRefresh;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(upstreamRequests).toBe(0);
    expect(await storage.get("oauth:generation")).not.toBe("legacy");
  });

  it("blocks a new grant while an aborted owner's token write is pending", async () => {
    const backing = memoryStorage();
    let blockTokenWrite = false;
    let observedBlockedWrite!: () => void;
    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      observedBlockedWrite = resolve;
    });
    const blockedWriteBarrier = new Promise<void>((resolve) => {
      releaseBlockedWrite = resolve;
    });
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: async (key, value, options) => {
        if (blockTokenWrite && key === "oauth:tokens") {
          blockTokenWrite = false;
          observedBlockedWrite();
          await blockedWriteBarrier;
        }
        await backing.set(key, value, options);
      },
      delete: (key) => backing.delete(key),
    };
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const retry = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const retryFollower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, follower, retry, retryFollower]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });

    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token:
          upstreamRequests === 1 ? "access-owner" : "access-retry",
        token_type: "Bearer",
        refresh_token:
          upstreamRequests === 1 ? "refresh-owner" : "refresh-retry",
      });
    };
    const trackedOwner = trackedAbortSignal();
    const ownerResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
      trackedOwner.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const trackedFollower = trackedAbortSignal();
    blockTokenWrite = true;
    let ownerSaveSettled = false;
    const ownerSave = owner
      .saveTokens((await ownerResponse.json()) as OAuthTokens)
      .then(() => {
        ownerSaveSettled = true;
      });
    await blockedWrite;

    let observedFollowerOldToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerOldToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") {
        observedFollowerOldToken();
      }
      return tokens;
    };
    const followerRefresh = coordinator.coordinatedFetch(
      follower,
      baseFetch,
      trackedFollower.signal,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const followerOutcome = followerRefresh.then(
      () => undefined,
      (error: unknown) => error,
    );
    await followerRead;
    await vi.waitFor(() => expect(trackedFollower.listeners()).toBe(1));
    expect(trackedOwner.listeners()).toBe(1);

    const ownerAbort = new DOMException("Owner scope ended", "AbortError");
    trackedOwner.controller.abort(ownerAbort);
    await expect(followerOutcome).resolves.toBe(ownerAbort);
    expect(ownerSaveSettled).toBe(false);
    expect(trackedOwner.listeners()).toBe(0);
    expect(trackedFollower.listeners()).toBe(0);
    expect(upstreamRequests).toBe(1);

    const blockedRetry = await coordinator.coordinatedFetch(retry, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-old"),
    );
    expect(blockedRetry.status).toBe(503);
    await expect(blockedRetry.json()).resolves.toMatchObject({
      error: "temporarily_unavailable",
    });
    expect(upstreamRequests).toBe(1);

    releaseBlockedWrite();
    await ownerSave;
    expect(await owner.tokens()).toMatchObject({
      access_token: "access-owner",
      refresh_token: "refresh-owner",
    });

    // An already-started old-token flow reuses the committed result locally.
    const replayedResponse = await coordinator.coordinatedFetch(
      retry,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    const replayed = (await replayedResponse.json()) as OAuthTokens;
    await retry.saveTokens(replayed);
    expect(upstreamRequests).toBe(1);
    expect(replayed).toMatchObject({
      access_token: "access-owner",
      refresh_token: "refresh-owner",
    });

    // Once the old mutation physically settles, the generation can safely own
    // another refresh and no late old write remains to overwrite its result.
    const nextResponse = await coordinator.coordinatedFetch(
      retryFollower,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-owner"));
    const next = (await nextResponse.json()) as OAuthTokens;
    await retryFollower.saveTokens(next);

    expect(upstreamRequests).toBe(2);
    expect(await retryFollower.tokens()).toMatchObject({
      access_token: "access-retry",
      refresh_token: "refresh-retry",
    });
  });

  it("shares a storage mutation failure before allowing an independent retry", async () => {
    const backing = memoryStorage();
    const storageFailure = new Error("token storage unavailable");
    let failTokenWrite = false;
    let observedFailedWrite!: () => void;
    let releaseFailedWrite!: () => void;
    const failedWrite = new Promise<void>((resolve) => {
      observedFailedWrite = resolve;
    });
    const failedWriteBarrier = new Promise<void>((resolve) => {
      releaseFailedWrite = resolve;
    });
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: async (key, value, options) => {
        if (failTokenWrite && key === "oauth:tokens") {
          failTokenWrite = false;
          observedFailedWrite();
          await failedWriteBarrier;
          throw storageFailure;
        }
        await backing.set(key, value, options);
      },
      delete: (key) => backing.delete(key),
    };
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const retry = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, follower, retry]) {
      provider.captureGeneration("legacy");
    }
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };

    const ownerResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    let observedFollowerOldToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerOldToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") {
        observedFollowerOldToken();
      }
      return tokens;
    };
    const followerRefresh = coordinator.coordinatedFetch(
      follower,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await followerRead;

    failTokenWrite = true;
    const ownerSave = owner.saveTokens(
      (await ownerResponse.json()) as OAuthTokens,
    );
    const failedOutcomes = Promise.allSettled([ownerSave, followerRefresh]);
    await failedWrite;
    expect(upstreamRequests).toBe(1);
    releaseFailedWrite();
    const outcomes = await failedOutcomes;
    expect(outcomes).toEqual([
      { status: "rejected", reason: storageFailure },
      { status: "rejected", reason: storageFailure },
    ]);
    expect(await owner.tokens()).toMatchObject({
      access_token: "access-old",
      refresh_token: "refresh-old",
    });

    const retryResponse = await coordinator.coordinatedFetch(
      retry,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await retry.saveTokens((await retryResponse.json()) as OAuthTokens);

    expect(upstreamRequests).toBe(2);
    expect(await retry.tokens()).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("keeps a late old-token flow behind the owner until rotated tokens are saved", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    owner.captureGeneration("legacy");
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    const late = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    late.captureGeneration("legacy");
    let observedLateOldToken!: () => void;
    const lateRead = new Promise<void>((resolve) => {
      observedLateOldToken = resolve;
    });
    const readLateTokens = late.tokens.bind(late);
    late.tokens = async (issuerContext) => {
      const tokens = await readLateTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-old") observedLateOldToken();
      return tokens;
    };
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
        refresh_token: "refresh-new",
      });
    };

    // The owner has its successful response, but has not parsed or saved it.
    const ownerResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    let lateSettled = false;
    const lateResponse = coordinator.coordinatedFetch(
      late,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old")).then(
      (response) => {
        lateSettled = true;
        return response;
      },
    );
    await lateRead;
    await Promise.resolve();
    expect(lateSettled).toBe(false);
    expect(upstreamRequests).toBe(1);

    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    const replayed = (await (await lateResponse).json()) as OAuthTokens;
    await late.saveTokens(replayed);

    expect(upstreamRequests).toBe(1);
    expect(replayed).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
    expect(await late.tokens()).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("does not merge a retired refresh token into a tokenless current value", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const provider = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    provider.captureGeneration("legacy");
    await provider.saveTokens({
      access_token: "access-current",
      token_type: "Bearer",
    });
    let upstreamRequests = 0;
    const response = await coordinator.coordinatedFetch(
      provider,
      async () => {
        upstreamRequests++;
        return Response.json({});
      },
    )("https://auth.example/token", refreshInit("refresh-retired"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(upstreamRequests).toBe(0);
    const current = await provider.tokens();
    expect(current?.access_token).toBe("access-current");
    expect(current?.refresh_token).toBeUndefined();
  });

  it("shares a successful refresh that keeps the existing refresh token", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    owner.captureGeneration("legacy");
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    follower.captureGeneration("legacy");
    const issuerContext = { issuer: "https://auth.example" };
    await owner.tokens(issuerContext);
    await follower.tokens(issuerContext);

    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token: "access-new",
        token_type: "Bearer",
      });
    };
    const ownerResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    let followerSettled = false;
    const followerResponse = coordinator.coordinatedFetch(
      follower,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old")).then(
      (response) => {
        followerSettled = true;
        return response;
      },
    );
    await Promise.resolve();
    expect(followerSettled).toBe(false);

    const ownerTokens = (await ownerResponse.json()) as OAuthTokens;
    await owner.saveTokens({
      refresh_token: "refresh-old",
      ...ownerTokens,
    });
    const followerTokens = (await (await followerResponse).json()) as OAuthTokens;
    await follower.saveTokens(followerTokens);

    expect(upstreamRequests).toBe(1);
    expect(followerTokens).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-old",
    });
    expect(await follower.tokens()).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-old",
    });
  });

  it("shares a successful refresh whose tokens are byte-identical", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const follower = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [owner, follower]) {
      provider.captureGeneration("legacy");
    }
    const unchanged: OAuthTokens = {
      access_token: "access-same",
      token_type: "Bearer",
      refresh_token: "refresh-same",
    };
    await owner.saveTokens(unchanged);
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json(unchanged);
    };

    const ownerResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-same"));
    let observedFollowerToken!: () => void;
    const followerRead = new Promise<void>((resolve) => {
      observedFollowerToken = resolve;
    });
    const readFollowerTokens = follower.tokens.bind(follower);
    follower.tokens = async (issuerContext) => {
      const tokens = await readFollowerTokens(issuerContext);
      if (tokens?.refresh_token === "refresh-same") observedFollowerToken();
      return tokens;
    };
    const followerResponse = coordinator.coordinatedFetch(
      follower,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-same"));
    await followerRead;
    expect(upstreamRequests).toBe(1);

    await owner.saveTokens((await ownerResponse.json()) as OAuthTokens);
    const replayed = (await (await followerResponse).json()) as OAuthTokens;
    await follower.saveTokens(replayed);

    expect(upstreamRequests).toBe(1);
    expect(replayed).toEqual(unchanged);
  });

  it("does not join refreshes captured under different generations", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const oldProvider = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    oldProvider.captureGeneration("legacy");
    await oldProvider.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });

    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const baseFetch: FetchLike = async (_input, init) => {
      const body = init?.body as URLSearchParams;
      const token = body.get("refresh_token")!;
      started.push(token);
      await new Promise<void>((resolve) => releases.set(token, resolve));
      return Response.json({
        access_token: `rotated-${token}`,
        token_type: "Bearer",
        refresh_token: `next-${token}`,
      });
    };
    const oldRefresh = coordinator.coordinatedFetch(
      oldProvider,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));
    await vi.waitFor(() => expect(started).toEqual(["refresh-old"]));

    const nextGeneration = `v2:${crypto.randomUUID()}`;
    await storage.set("oauth:generation", nextGeneration);
    await storeCurrentOAuthValue(
      storage,
      "oauth:tokens",
      {
        access_token: "access-current",
        token_type: "Bearer",
        refresh_token: "refresh-current",
      },
    );
    const currentProvider = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    currentProvider.captureGeneration(nextGeneration);
    const currentRefresh = coordinator.coordinatedFetch(
      currentProvider,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-current"));
    await vi.waitFor(() =>
      expect(started).toEqual(["refresh-old", "refresh-current"]),
    );

    releases.get("refresh-old")!();
    releases.get("refresh-current")!();
    const [oldOutcome, currentOutcome] = await Promise.allSettled([
      oldRefresh,
      currentRefresh,
    ]);
    expect(oldOutcome).toMatchObject({
      status: "rejected",
      reason: new Error("OAuth refresh ended before tokens could be saved."),
    });
    expect(currentOutcome.status).toBe("fulfilled");
    if (currentOutcome.status === "fulfilled") {
      await currentProvider.saveTokens(
        (await currentOutcome.value.json()) as OAuthTokens,
      );
    }
    expect(await currentProvider.tokens()).toMatchObject({
      access_token: "rotated-refresh-current",
      refresh_token: "next-refresh-current",
    });
  });

  it("cannot let late old-generation success replace the active success identity", async () => {
    const backing = memoryStorage();
    let blockOldWrite = false;
    let observedOldWrite!: () => void;
    let releaseOldWrite!: () => void;
    const oldWrite = new Promise<void>((resolve) => {
      observedOldWrite = resolve;
    });
    const oldWriteBarrier = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    const storage: KVStorage = {
      get: (key) => backing.get(key),
      set: async (key, value, options) => {
        if (blockOldWrite && key === "oauth:tokens") {
          blockOldWrite = false;
          observedOldWrite();
          await oldWriteBarrier;
        }
        await backing.set(key, value, options);
      },
      delete: (key) => backing.delete(key),
    };
    const coordinator = new OAuthRefreshCoordinator();
    const oldOwner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    oldOwner.captureGeneration("legacy");
    await oldOwner.saveTokens({
      access_token: "access-a",
      token_type: "Bearer",
      refresh_token: "refresh-a",
    });
    const upstreamTokens: string[] = [];
    const baseFetch: FetchLike = async (_input, init) => {
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      const token = (init!.body as URLSearchParams).get("refresh_token")!;
      upstreamTokens.push(token);
      return token === "refresh-a"
        ? Response.json({
            access_token: "access-a-new",
            token_type: "Bearer",
            refresh_token: "refresh-a-new",
          })
        : Response.json({
            access_token: "access-b",
            token_type: "Bearer",
            refresh_token: "refresh-b",
          });
    };
    const oldResponse = await coordinator.coordinatedFetch(
      oldOwner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-a"));
    blockOldWrite = true;
    const oldSave = oldOwner.saveTokens(
      (await oldResponse.json()) as OAuthTokens,
    );
    await oldWrite;

    const generationB = `v2:${crypto.randomUUID()}`;
    await storage.set("oauth:generation", generationB);
    const unchangedB: OAuthTokens = {
      access_token: "access-b",
      token_type: "Bearer",
      refresh_token: "refresh-b",
    };
    await storeCurrentOAuthValue(storage, "oauth:tokens", unchangedB);
    const ownerB = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    const contenderB = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    for (const provider of [ownerB, contenderB]) {
      provider.captureGeneration(generationB);
    }
    await contenderB.tokens({ issuer: "https://auth.example" });
    const responseB = await coordinator.coordinatedFetch(ownerB, baseFetch)(
      "https://auth.example/token",
      refreshInit("refresh-b"),
    );
    await ownerB.saveTokens((await responseB.json()) as OAuthTokens);

    releaseOldWrite();
    await oldSave;
    const replayedResponse = await coordinator.coordinatedFetch(
      contenderB,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-b"));
    const replayed = (await replayedResponse.json()) as OAuthTokens;

    expect(upstreamTokens).toEqual(["refresh-a", "refresh-b"]);
    expect(replayed).toEqual(unchangedB);
    expect(await contenderB.tokens()).toEqual(unchangedB);
  });

  it("retires a pending mutation when force reauthorization fences its generation", async () => {
    const storage = memoryStorage();
    const coordinator = new OAuthRefreshCoordinator();
    const owner = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    owner.captureGeneration("legacy");
    await owner.saveTokens({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    });
    let upstreamRequests = 0;
    const baseFetch: FetchLike = async () => {
      upstreamRequests++;
      return Response.json({
        access_token:
          upstreamRequests === 1 ? "access-retired" : "access-current-new",
        token_type: "Bearer",
        refresh_token:
          upstreamRequests === 1 ? "refresh-retired" : "refresh-current-new",
      });
    };
    const retiredResponse = await coordinator.coordinatedFetch(
      owner,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-old"));

    const resetter = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    await resetter.resetAuthorization();
    const currentGeneration = (await storage.get("oauth:generation"))!;
    await storeCurrentOAuthValue(storage, "oauth:tokens", {
      access_token: "access-current",
      token_type: "Bearer",
      refresh_token: "refresh-current",
    });
    const current = new KvOAuthProvider(
      "svc",
      storage,
      REDIRECT,
      coordinator,
    );
    current.captureGeneration(currentGeneration);
    const currentResponse = await coordinator.coordinatedFetch(
      current,
      baseFetch,
    )("https://auth.example/token", refreshInit("refresh-current"));
    await current.saveTokens((await currentResponse.json()) as OAuthTokens);

    // The retired provider can finish late, but its generation fence makes the
    // write unreadable and its exact marker no longer blocks the active epoch.
    await owner.saveTokens((await retiredResponse.json()) as OAuthTokens);
    expect(upstreamRequests).toBe(2);
    expect(await current.tokens()).toMatchObject({
      access_token: "access-current-new",
      refresh_token: "refresh-current-new",
    });
  });

  it("shares exactly one rotating-token grant in each of two waves of eight scopes", async () => {
    const storage = memoryStorage();
    const issuer = "https://auth.example";
    const mcpUrl = "https://downstream.example/mcp";
    await storeCurrentOAuthValue(
      storage,
      "oauth:client",
      {
        client_id: "connecta-client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      },
      issuer,
    );
    await storeCurrentOAuthValue(
      storage,
      "oauth:tokens",
      {
        access_token: "access-old",
        token_type: "Bearer",
        refresh_token: "refresh-old",
      },
      issuer,
    );

    let wave = 0;
    let oldTokenRequests = 0;
    const redeemed: string[] = [];
    let rejected = deferred<void>();
    let tokenEntered = deferred<void>();
    let tokenGate = deferred<void>();
    let refreshRequests = 0;
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      if (url.href === "https://downstream.example/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: mcpUrl,
          authorization_servers: [issuer],
        });
      }
      if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === `${issuer}/token`) {
        refreshRequests++;
        expect(init.body).toBeInstanceOf(URLSearchParams);
        const token = (init.body as URLSearchParams).get("refresh_token")!;
        expect(redeemed).not.toContain(token);
        redeemed.push(token);
        expect(token).toBe(wave === 0 ? "refresh-old" : "refresh-new");
        tokenEntered.resolve();
        await tokenGate.promise;
        return Response.json({
          access_token: wave === 0 ? "access-new" : "access-second",
          token_type: "Bearer",
          refresh_token: wave === 0 ? "refresh-new" : "refresh-second",
        });
      }
      if (url.href !== mcpUrl) {
        throw new Error(`Unexpected OAuth test request: ${url.href}`);
      }
      if (init.method !== "POST") return new Response(null, { status: 405 });

      const authorization = new Headers(init.headers).get("authorization");
      if (authorization === (wave === 0 ? "Bearer access-old" : "Bearer access-new")) {
        oldTokenRequests++;
        if (oldTokenRequests === 8) rejected.resolve();
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://downstream.example/.well-known/oauth-protected-resource"',
          },
        });
      }
      expect(authorization).toBe(wave === 0 ? "Bearer access-new" : "Bearer access-second");
      const message = JSON.parse(String(init.body)) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "rotating", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : undefined;
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    const connector = remoteMcp("svc", {
      url: mcpUrl,
      auth: { type: "oauth" },
      versionNegotiation: "legacy",
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      for (wave = 0; wave < 2; wave++) {
        oldTokenRequests = 0;
        rejected = deferred<void>();
        tokenEntered = deferred<void>();
        tokenGate = deferred<void>();
        const scopes = Array.from({ length: 8 }, () => ({ ...ctx(storage), requestScope: {} }));
        const calls = Promise.all(scopes.map(scope => connector.listTools(scope)));
        await Promise.all([rejected.promise, tokenEntered.promise]);
        expect(refreshRequests).toBe(wave + 1);
        tokenGate.resolve();
        await expect(calls).resolves.toEqual(Array.from({ length: 8 }, () => []));
        expect(oldTokenRequests).toBe(8);
        expect(refreshRequests).toBe(wave + 1);
        expect(await new KvOAuthProvider("svc", storage, REDIRECT).tokens()).toMatchObject({
          access_token: wave === 0 ? "access-new" : "access-second",
          refresh_token: wave === 0 ? "refresh-new" : "refresh-second",
        });
        await Promise.all(scopes.map(scope => connector.closeScope?.(scope)));
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(redeemed).toEqual(["refresh-old", "refresh-new"]);
  });
});

// ---------------------------------------------------------------------------
// remoteMcp() oauth-mode status via the _transportFactory seam.
// ---------------------------------------------------------------------------

/** A downstream MCP server exposing a single tool, wired in-process. */
async function connectServer() {
  return inMemoryDownstream((server) => {
    server.registerTool(
      "ping",
      { description: "Ping", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "pong" }] }),
    );
  });
}

let closer: (() => Promise<void>) | null = null;
afterEach(async () => {
  await closer?.();
  closer = null;
});

describe("remoteMcp() oauth status via _transportFactory", () => {
  it("UnauthorizedError → auth_required with the stored authorization URL", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const authUrl = "https://auth.example/authorize?client_id=abc";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          // Simulate the SDK's headless redirectToAuthorization: stash the URL.
          await storage.set("oauth:pending", authUrl);
        }),
    });

    const status = await connector.status!(c);
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBeUndefined();
  });

  it("a plain network error → error, NOT auth_required", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new Error("ECONNREFUSED downstream")),
    });

    const status = await connector.status!(ctx());
    expect(status.state).toBe("error");
    expect(status.authorizationUrl).toBeUndefined();
    expect(status.message).toContain("ECONNREFUSED");
  });
});

describe("remoteMcp() startAuth", () => {
  it("OAuth lifecycle hooks are absent unless auth is oauth", () => {
    const headers = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "headers", headers: { Authorization: "Bearer x" } },
    });
    expect(headers.startAuth).toBeUndefined();
    expect(headers.disconnectAuth).toBeUndefined();
    const oauth = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
    });
    expect(oauth.startAuth).toBeDefined();
    expect(oauth.disconnectAuth).toBeDefined();
  });

  it("disconnect wipes the grant without starting a replacement flow", async () => {
    const storage = memoryStorage();
    await storage.set(
      "oauth:tokens",
      JSON.stringify({ access_token: "old", token_type: "Bearer" }),
    );
    await storage.set("oauth:pending", "https://auth.example/stale");
    let builds = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        builds++;
        return throwingTransport(new UnauthorizedError("401"));
      },
    });
    const c = ctx(storage);

    await connector.disconnectAuth!(c);

    expect(builds).toBe(0);
    expect(await storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("oauth:pending")).toBeNull();
    expect(await storage.get("oauth:generation")).toMatch(/^disconnected:/);

    const passive = await connector.status!(c);
    expect(passive).toMatchObject({
      state: "auth_required",
      message: expect.stringContaining("disconnected by an operator"),
    });
    expect(passive.authorizationUrl).toBeUndefined();
    expect(builds).toBe(0);
    expect(await storage.get("oauth:pending")).toBeNull();
  });

  it("can start a fresh authorization after an explicit disconnect", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const authUrl = "https://auth.example/reconnect";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          await storeCurrentOAuthValue(storage, "oauth:pending", authUrl);
        }),
    });

    await connector.disconnectAuth!(c);
    const status = await connector.startAuth!(c);

    expect(status).toMatchObject({
      state: "auth_required",
      authorizationUrl: authUrl,
    });
    expect(await storage.get("oauth:generation")).toMatch(/^v2:/);
  });

  it("keeps DELETE durable across /ui/data until POST explicitly reconnects", async () => {
    const storage = memoryStorage();
    await storage.set(
      "conn:svc:oauth:tokens",
      JSON.stringify({ access_token: "old", token_type: "Bearer" }),
    );
    const authUrl = "https://auth.example/reconnect";
    let builds = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: (transportCtx) => {
        builds++;
        return throwingTransport(new UnauthorizedError("401"), async () => {
          await storeCurrentOAuthValue(
            transportCtx.storage,
            "oauth:pending",
            authUrl,
          );
        });
      },
    });
    const clerk: InboundAuth = {
      kind: "clerk",
      interactiveOperator: true,
      uiAuth: {
        kind: "clerk",
        publishableKey: "pk_test_fake",
        frontendApiUrl: "https://clerk.example.com",
      },
      authorize(request) {
        return request.headers.get("authorization") === "Bearer clerk-token"
          ? { ok: true, userId: "user_123" }
          : {
              ok: false,
              response: Response.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            };
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: clerk,
      storage,
      publicUrl: BASE,
    });
    const operatorRequest = (path: string, method = "GET") =>
      connecta.fetch(
        new Request(`${BASE}${path}`, {
          method,
          headers: {
            Authorization: "Bearer clerk-token",
            Origin: BASE,
          },
        }),
      );

    expect((await operatorRequest("/ui/oauth/svc", "DELETE")).status).toBe(204);
    const data = (await (
      await fetchTestUiDetails(connecta, new Request(`${BASE}/ui/data`, { headers: { Authorization: "Bearer clerk-token" } }))
    ).json()) as {
      connectors: Array<{
        status: string;
        authorizationUrl?: string;
        toolCount: number;
      }>;
    };
    expect(data.connectors[0]).toMatchObject({
      status: "auth_required",
      toolCount: 0,
    });
    expect(required(data.connectors[0]).authorizationUrl).toBeUndefined();
    expect(builds).toBe(0);
    expect(await storage.get("conn:svc:oauth:pending")).toBeNull();
    expect(await storage.get("conn:svc:oauth:generation")).toMatch(
      /^disconnected:/,
    );

    const restarted = await operatorRequest("/ui/oauth/svc", "POST");
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      state: "auth_required",
      authorizationUrl: authUrl,
    });
    expect(builds).toBe(1);
  });

  it("kicks the flow and returns auth_required with the stored URL", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const authUrl = "https://auth.example/authorize?client_id=abc";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          await storage.set("oauth:pending", authUrl);
        }),
    });

    const status = await connector.startAuth!(c);
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBe(authUrl);
  });

  it("returns ok when the connection is already healthy", async () => {
    const { server, clientTransport } = await connectServer();
    closer = () => server.close();
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => clientTransport,
    });

    const status = await connector.startAuth!(ctx());
    expect(status.state).toBe("ok");
  });

  it("force wipes stored credentials and restarts the flow", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    // Stale credentials from a previous (now-revoked) authorization.
    await storage.set("oauth:client", JSON.stringify({ client_id: "old" }));
    await storage.set(
      "oauth:tokens",
      JSON.stringify({ access_token: "old", token_type: "Bearer" }),
    );
    await storage.set("oauth:pending", "https://auth.example/stale");
    await storage.set("oauth:verifier", "stale-verifier");
    await storage.set("oauth:state", "stale-state");

    const freshUrl = "https://auth.example/authorize?client_id=new";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          await storeCurrentOAuthValue(storage, "oauth:pending", freshUrl);
        }),
    });

    const status = await connector.startAuth!(c, { force: true });
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBe(freshUrl);
    expect(await storage.get("oauth:client")).toBeNull();
    expect(await storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("oauth:verifier")).toBeNull();
    expect(await storage.get("oauth:state")).toBeNull();
    expect(await storage.get("oauth:generation")).toMatch(/^v2:/);
  });

  it("force fences and replaces a connect that never settles on its own", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const { promise: started, resolve: reachedStart } = deferred<void>();
    const pendingStart = deferred<void>();
    let builds = 0;
    const freshUrl = "https://auth.example/recovered";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        builds++;
        if (builds === 1) {
          return {
            start() {
              reachedStart();
              return pendingStart.promise;
            },
            async send() {},
            async close() {
              pendingStart.reject(new Error("abandoned by force reset"));
            },
          } as unknown as Transport;
        }
        return throwingTransport(new UnauthorizedError("401"), async () => {
          await storeCurrentOAuthValue(storage, "oauth:pending", freshUrl);
        });
      },
    });

    const abandoned = connector.status!(c);
    await started;
    const forced = connector.startAuth!(c, { force: true });
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 250),
    );
    const result = await Promise.race([forced, timeout]);

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      state: "auth_required",
      authorizationUrl: freshUrl,
    });
    expect(await storage.get("oauth:generation")).toMatch(/^v2:/);
    expect(builds).toBe(2);
    await expect(abandoned).resolves.toMatchObject({ state: "error" });
  });

  it("an abandoned Unauthorized completion cannot poison its healthy replacement", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const { promise: started, resolve: reachedStart } = deferred<void>();
    const oldStart = deferred<void>();
    let builds = 0;
    const healthy = await connectServer();
    closer = () => healthy.server.close();
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        builds++;
        if (builds === 1) {
          return {
            start() {
              reachedStart();
              return oldStart.promise;
            },
            async send() {},
            async close() {
              // Simulate a transport whose close cannot cancel start().
            },
          } as unknown as Transport;
        }
        return healthy.clientTransport;
      },
    });

    const abandoned = connector.status!(c);
    await started;
    await expect(connector.startAuth!(c, { force: true })).resolves.toMatchObject({
      state: "ok",
    });
    oldStart.reject(new UnauthorizedError("late 401"));
    await expect(abandoned).resolves.toMatchObject({ state: "error" });

    expect(await connector.status!(c)).toMatchObject({ state: "ok" });
    expect(builds).toBe(2);
  });

  it("a plain network error → error, NOT auth_required", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new Error("ECONNREFUSED downstream")),
    });

    const status = await connector.startAuth!(ctx());
    expect(status.state).toBe("error");
    expect(status.message).toContain("ECONNREFUSED");
  });
  it("non-force re-issues an outstanding consent URL without touching the verifier", async () => {
    const storage = memoryStorage();
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      // Must not connect while a URL is pending — the pending short-circuit
      // fires first, so this factory should never run.
      _transportFactory: () => {
        throw new Error("should not connect while a consent URL is pending");
      },
    });
    const url = "https://auth.example/authorize?code_challenge=abc";
    await storage.set(
      "oauth:pending",
      JSON.stringify({
        connectaOAuthVersion: 2,
        generation: "legacy",
        writtenAt: Date.now(),
        value: url,
      }),
    );
    await storage.set("oauth:verifier", "verifier-123");
    const context = ctx(storage);

    const first = await c.startAuth!(context, {});
    const second = await c.startAuth!(context, {});

    expect(first.state).toBe("auth_required");
    expect(first.authorizationUrl).toBe(url);
    expect(first.authorizationReused).toBe(true);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    // The verifier the operator's URL is bound to must survive both touches.
    expect(await storage.get("oauth:verifier")).toBe("verifier-123");
  });

  it("force with a live client closes it, wipes creds, and reconnects", async () => {
    const s1 = await connectServer();
    const s2 = await connectServer();
    closer = async () => {
      await s1.server.close();
      await s2.server.close();
    };
    let closedFirst = false;
    const origClose = s1.clientTransport.close.bind(s1.clientTransport);
    s1.clientTransport.close = async () => {
      closedFirst = true;
      return origClose();
    };
    const transports = [s1.clientTransport, s2.clientTransport];
    const storage = memoryStorage();
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => transports.shift()!,
    });
    const context = ctx(storage);

    // First connect → live client on transport #1.
    await c.listTools(context);
    await storage.set("oauth:pending", "x");
    await storage.set("oauth:verifier", "v");
    await storage.set("oauth:tokens", "tok");
    await storage.set("oauth:client", "cli");

    const result = await c.startAuth!(context, { force: true });

    expect(closedFirst).toBe(true);
    // Reconnected cleanly via transport #2 → healthy again.
    expect(result.state).toBe("ok");
    expect(await storage.get("oauth:pending")).toBeNull();
    expect(await storage.get("oauth:verifier")).toBeNull();
    expect(await storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("oauth:client")).toBeNull();
  });

  it("force fences an in-flight connect before wiping", async () => {
    const storage = memoryStorage();
    let started = 0;
    // A transport whose start() rejects after a tick, standing in for a slow
    // connect that is still in flight when force lands.
    const slowFailing = (): Transport => ({
      async start() {
        started++;
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("ECONNREFUSED");
      },
      async send() {},
      async close() {},
    });
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: slowFailing,
    });
    const context = ctx(storage);

    // Kick a connect without awaiting so it is in flight when force runs.
    const inflight = c.listTools(context).catch(() => {});
    const result = await c.startAuth!(context, { force: true });
    await inflight;

    // force awaited the in-flight connect (fence) then ran its own connect.
    expect(started).toBe(2);
    // Network failure on an oauth connector surfaces as error, not auth_required.
    expect(result.state).toBe("error");
    expect(result.message).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// startAuth's two starts, over the real SDK flow: continue reuses a recent
// pending URL and a stored registration; restart re-registers from scratch.
// ---------------------------------------------------------------------------
describe("remoteMcp() continue and restart starts", () => {
  const issuer = "https://auth.example";
  const mcpUrl = "https://downstream.example/mcp";
  const resourceMetadataUrl =
    "https://downstream.example/.well-known/oauth-protected-resource";
  const MINUTE = 60 * 1000;

  function authorizationServer() {
    const counts = { register: 0, fetches: 0 };
    let selectedIssuer = issuer;
    const fetchStub: FetchLike = async (input, init = {}) => {
      counts.fetches++;
      const url = new URL(input);
      if (url.href === resourceMetadataUrl) {
        return Response.json({ resource: mcpUrl, authorization_servers: [selectedIssuer] });
      }
      if (url.href === `${selectedIssuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: selectedIssuer,
          authorization_endpoint: `${selectedIssuer}/authorize`,
          token_endpoint: `${selectedIssuer}/token`,
          registration_endpoint: `${selectedIssuer}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === `${selectedIssuer}/register`) {
        counts.register++;
        return Response.json({
          ...(JSON.parse(String(init.body)) as object),
          client_id: `client-${counts.register}`,
        });
      }
      if (url.href === `${selectedIssuer}/token`) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (url.href === mcpUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };
    return { fetchStub, counts, selectIssuer: (next: string) => { selectedIssuer = next; } };
  }

  async function withServer(
    run: (
      server: ReturnType<typeof authorizationServer>,
      clock: { advance(ms: number): void },
    ) => Promise<void>,
  ) {
    const server = authorizationServer();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    vi.stubGlobal("fetch", server.fetchStub);
    try {
      await run(server, { advance: (ms) => (offset += ms) });
    } finally {
      vi.unstubAllGlobals();
      clock.mockRestore();
    }
  }

  const connector = () =>
    remoteMcp("svc", {
      url: mcpUrl,
      auth: { type: "oauth" },
      versionNegotiation: "legacy",
    });
  const scope = (storage: KVStorage): ConnectorContext => ({
    ...ctx(storage),
    requestScope: {},
  });
  const clientOf = (url: string | undefined) =>
    new URL(required(url)).searchParams.get("client_id");

  it("continue reuses a recent pending URL without touching the network", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      const restarted = await c.startAuth!(scope(storage), { force: true });
      expect(restarted.state).toBe("auth_required");
      expect(restarted.authorizationReused).toBeUndefined();
      expect(server.counts.register).toBe(1);
      const fetches = server.counts.fetches;
      const generation = await storage.get("oauth:generation");

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued).toMatchObject({
        state: "auth_required",
        authorizationUrl: restarted.authorizationUrl,
        authorizationReused: true,
      });
      expect(server.counts.fetches).toBe(fetches);
      expect(await storage.get("oauth:generation")).toBe(generation);
    });
  });

  it("continue starts a fresh flow for a stale pending URL, keeping the registration", async () => {
    await withServer(async (server, clock) => {
      const storage = memoryStorage();
      const c = connector();
      const restarted = await c.startAuth!(scope(storage), { force: true });
      const generation = await storage.get("oauth:generation");

      clock.advance(10 * MINUTE);
      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.state).toBe("auth_required");
      expect(continued.authorizationReused).toBeUndefined();
      expect(continued.authorizationUrl).not.toBe(restarted.authorizationUrl);
      // Same epoch, same client: no registration, no reset.
      expect(clientOf(continued.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
      expect(await storage.get("oauth:generation")).toBe(generation);

      // The fresh URL is itself reusable.
      const again = await c.startAuth!(scope(storage), { force: false });
      expect(again).toMatchObject({
        authorizationUrl: continued.authorizationUrl,
        authorizationReused: true,
      });
    });
  });

  it("continue treats an untimed pending URL from an earlier release as stale", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      const generation = required((await storage.get("oauth:generation")) ?? undefined);
      const untimed = "https://auth.example/authorize?from=an-earlier-release";
      await storage.set(
        oauthValueStorageKey("oauth:pending", generation),
        JSON.stringify({ connectaOAuthVersion: 2, generation, value: untimed }),
      );

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.authorizationReused).toBeUndefined();
      expect(continued.authorizationUrl).not.toBe(untimed);
      expect(clientOf(continued.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
    });
  });

  it("restart reuses an issuer-bound registration while replacing each flow epoch", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      const first = await c.startAuth!(scope(storage), { force: true });
      const firstGeneration = await storage.get("oauth:generation");

      const second = await c.startAuth!(scope(storage), { force: true });

      expect(second.authorizationReused).toBeUndefined();
      expect(second.authorizationUrl).not.toBe(first.authorizationUrl);
      expect(clientOf(second.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
      expect(await storage.get("oauth:generation")).not.toBe(firstGeneration);
    });
  });

  it("registers again when fresh discovery selects a different issuer", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      server.selectIssuer("https://new-auth.example");

      const second = await c.startAuth!(scope(storage), { force: true });

      expect(clientOf(second.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
    });
  });

  it("registers again when redirect URI or connector configuration changes", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      await connector().startAuth!(scope(storage), { force: true });
      const changedRedirect = scope(storage);
      changedRedirect.baseUrl = "https://another-operator.example";
      await connector().startAuth!(changedRedirect, { force: true });
      expect(server.counts.register).toBe(2);

      const changedConfig = remoteMcp("svc", {
        url: mcpUrl,
        auth: { type: "oauth" },
        versionNegotiation: "legacy",
        redirects: "same-origin",
      });
      await changedConfig.startAuth!(changedRedirect, { force: true });
      expect(server.counts.register).toBe(3);
    });
  });

  it("re-registers on the next restart after a callback rejects the client", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      await c.startAuth!(scope(storage), { force: true });
      expect(server.counts.register).toBe(1);

      const callback = new KvOAuthProvider("svc", storage, `${BASE}/oauth/callback/svc`);
      await expect(auth(callback, {
        serverUrl: mcpUrl,
        authorizationCode: "rejected-code",
        fetchFn: server.fetchStub,
      })).rejects.toThrow();
      expect(await callback.clientInformation({ issuer })).toBeUndefined();

      const retried = await c.startAuth!(scope(storage), { force: true });
      expect(clientOf(retried.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
    });
  });

  it("continue on a disconnected connector still resets before starting", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      await c.disconnectAuth!(scope(storage));
      expect(await storage.get("oauth:generation")).toMatch(/^disconnected:/);

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.state).toBe("auth_required");
      expect(continued.authorizationReused).toBeUndefined();
      expect(await storage.get("oauth:generation")).toMatch(/^v2:/);
      expect(server.counts.register).toBe(2);
    });
  });

  it("continues only the calling principal's own flow on a personal connector", async () => {
    await withServer(async (server) => {
      const users: InboundAuth = {
        kind: "test-users",
        interactiveOperator: true,
        activityActorNamespace: "https://identity.test",
        authorize(request) {
          const user = /^Bearer (alice|bob)$/u.exec(
            request.headers.get("authorization") ?? "",
          )?.[1];
          return user
            ? { ok: true, userId: user, subjectId: user }
            : { ok: false, response: new Response(null, { status: 401 }) };
        },
      };
      const connecta = createTestConnecta({
        connectors: [
          remoteMcp("svc", {
            url: mcpUrl,
            auth: { type: "oauth" },
            authScope: "personal",
            versionNegotiation: "legacy",
          }),
        ],
        auth: users,
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const start = async (user: "alice" | "bob", query = "") => {
        const response = await connecta.fetch(
          new Request(`${BASE}/ui/oauth/svc${query}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${user}`, Origin: BASE },
          }),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          authorizationUrl: string;
          reused: boolean;
        };
      };
      const principalOf = async (url: string) =>
        (await connecta.registry.oauthCallbackView(
          "svc",
          new URL(url).searchParams.get("state"),
        ))?.principalKey;

      const aliceFirst = await start("alice");
      const aliceAgain = await start("alice", "?mode=continue");
      expect(aliceAgain).toEqual({ ...aliceFirst, reused: true });
      expect(server.counts.register).toBe(1);

      // Bob's partition holds no pending flow, so his continue starts his own.
      const bob = await start("bob", "?mode=continue");
      expect(bob.reused).toBe(false);
      expect(bob.authorizationUrl).not.toBe(aliceFirst.authorizationUrl);
      expect(server.counts.register).toBe(2);

      // The reused URL still hands its callback to Alice, never to Bob.
      const alice = await principalOf(aliceAgain.authorizationUrl);
      const bobPrincipal = await principalOf(bob.authorizationUrl);
      expect(alice).toBeTypeOf("string");
      expect(bobPrincipal).toBeTypeOf("string");
      expect(bobPrincipal).not.toBe(alice);
      await connecta.close();
    });
  });
});

describe("remoteMcp() finishAuth", () => {
  it("drives transport.finishAuth, clears pending, and reconnects next use", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    // Seed one-shot flow state that clearPending should wipe.
    await storage.set("oauth:pending", "https://auth.example/authorize");
    await storage.set("oauth:verifier", "v-123");

    const finishAuth = vi.fn(async (_params: URLSearchParams) => {});
    const { server, clientTransport } = await connectServer();
    closer = () => server.close();

    let build = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        build += 1;
        // First build: the transport finishAuth() is called on.
        if (build === 1) {
          return { finishAuth, async close() {} } as unknown as Transport;
        }
        // Second build: a working in-process transport for the reconnect.
        return clientTransport;
      },
    });

    const callbackParams = new URLSearchParams({
      code: "code123",
      iss: "https://auth.example",
    });
    await connector.finishAuth!("code123", c, callbackParams);

    expect(finishAuth).toHaveBeenCalledWith(callbackParams);
    expect(await storage.get("oauth:pending")).toBeNull();
    expect(await storage.get("oauth:verifier")).toBeNull();

    // Next use reconnects (second factory build) and lists tools.
    const tools = await connector.listTools(c);
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    expect(build).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cross-isolate force re-auth via the shared KV generation counter (#11).
// Two remoteMcp() instances over the SAME storage stand in for two isolates.
// ---------------------------------------------------------------------------
describe("remoteMcp() cross-isolate force re-auth", () => {
  it("a stale isolate drops its client once another isolate force-reauthorizes", async () => {
    const storage = memoryStorage();

    // Isolate A: healthy first, then (after the force wipes creds) an
    // unauthorized transport standing in for the revoked credentials.
    const sA = await connectServer();
    let aBuilds = 0;
    const a = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        aBuilds += 1;
        if (aBuilds === 1) return sA.clientTransport;
        return throwingTransport(new UnauthorizedError("401"), async () => {
          await storeCurrentOAuthValue(
            storage,
            "oauth:pending",
            "https://auth.example/reauth",
          );
        });
      },
    });

    // Isolate B: a second instance on the SAME KV that performs the force.
    const sB = await connectServer();
    const b = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => sB.clientTransport,
    });
    closer = async () => {
      await sA.server.close();
      await sB.server.close();
    };

    const ctxA = ctx(storage);
    const ctxB = ctx(storage);

    // A connects and is healthy under generation 0.
    expect((await a.status!(ctxA)).state).toBe("ok");

    // B force-reauthorizes → publishes a unique epoch and wipes credentials.
    await b.startAuth!(ctxB, { force: true });
    expect(await storage.get("oauth:generation")).toMatch(/^v2:/);

    // A's next call notices the generation advanced, drops its now-stale client,
    // and reconnects — against wiped creds, so it degrades to auth_required
    // instead of silently keeping the revoked token alive.
    const after = await a.status!(ctxA);
    expect(after.state).toBe("auth_required");
    expect(after.authorizationUrl).toBeUndefined();
    expect(aBuilds).toBe(2);
  });

  it("discards a client whose connect completed after a concurrent force bumped the generation", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);

    const { server, clientTransport } = await connectServer();
    closer = () => server.close();
    // Simulate a force re-auth landing in ANOTHER isolate mid-connect: bump the
    // shared generation as part of this connect's start().
    const origStart = clientTransport.start.bind(clientTransport);
    clientTransport.start = async () => {
      await origStart();
      await storage.set("oauth:generation", `v2:${crypto.randomUUID()}`);
    };

    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => clientTransport,
    });

    // connect() itself succeeds, but the generation advanced while it ran, so
    // the client is discarded rather than cached — the wiped-and-reauthorized
    // connector must not be resurrected by this stale isolate.
    const status = await connector.status!(c);
    expect(status.state).toBe("auth_required");
  });
});

// ---------------------------------------------------------------------------
// End-to-end /oauth/callback/<id> route.
// ---------------------------------------------------------------------------
describe("/oauth/callback/<id> route", () => {
  // The connector namespaces its storage as conn:<id>: — this is where the
  // provider reads oauth:state from, so tests seed the expected state here.
  const STATE_KEY = "conn:svc:oauth:state";

  function callbackConnector(
    id: string,
    finishAuth: (code: string) => Promise<void>,
    verifyState?: (
      state: string | null,
      ctx: ConnectorContext,
    ) => Promise<boolean>,
  ): Connector {
    return {
      id,
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
      ...(verifyState ? { verifyState } : {}),
      finishAuth,
    };
  }

  function makeConnecta(
    finishAuth: (code: string) => void,
    storage = memoryStorage(),
    logger: Logger = silentLogger,
  ) {
    const connecta = createTestConnecta({
      publicUrl: BASE,
      storage,
      logger,
      connectors: [
        remoteMcp("svc", {
          url: "https://unused.example/mcp",
          auth: { type: "oauth" },
          _transportFactory: () =>
            ({
              finishAuth: async (code: string) => finishAuth(code),
              async close() {},
            }) as unknown as Transport,
        }),
      ],
    });
    return { connecta, storage };
  }

  it("matching state + code → 200 'Connected' and calls finishAuth", async () => {
    const spy = vi.fn();
    const { connecta, storage } = makeConnecta(spy);
    await storage.set(STATE_KEY, "s3cr3t-state");
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=s3cr3t-state`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Connected");
    const callbackParams = spy.mock.calls[0]?.[0];
    expect(callbackParams).toBeInstanceOf(URLSearchParams);
    expect(callbackParams.get("code")).toBe("abc");
  });

  it.each([401, 403])("allows an identity-free callback on 401, but refuses an explicit 403 (%i)", async (status) => {
    const finish = vi.fn(async () => {});
    const connecta = createTestConnecta({
      publicUrl: BASE,
      auth: { kind: "browser-bearer", interactiveOperator: true,
        authorize: () => ({ ok: false, response: new Response(null, { status }) }) },
      connectors: [callbackConnector("svc", finish, async state => state === "verified-state")],
    });
    const response = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=verified-state`));
    expect(response.status).toBe(status === 401 ? 200 : 400);
    expect(finish).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    const invalid = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=wrong`));
    expect(invalid.status).toBe(400);
    expect(finish).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("every unverifiable callback failure is indistinguishable", async () => {
    const spy = vi.fn();
    const { connecta, storage } = makeConnecta(spy);
    const unverifiedFinish = vi.fn();
    const throwingFinish = vi.fn();
    const edgeConnecta = createTestConnecta({
      publicUrl: BASE,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [
        // A connector that exists but has no OAuth at all — the other half of
        // `!connector || !connector.finishAuth`, and the id an attacker is
        // likeliest to guess right. It must not answer differently from an id
        // that names nothing.
        api("plain", {
          description: "not an OAuth connector",
          tools: [
            {
              name: "noop",
              description: "does nothing",
              annotations: { readOnlyHint: true },
              handler: async () => ({}),
            },
          ],
        }),
        callbackConnector("unverified", async (code) => {
          unverifiedFinish(code);
        }),
        callbackConnector(
          "throwing",
          async (code) => {
            throwingFinish(code);
          },
          async () => {
            throw new Error("verifier unavailable");
          },
        ),
      ],
    });
    await storage.set(STATE_KEY, "the-real-state");
    const shape = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers.entries()),
    });
    const unknown = await shape(
      await connecta.fetch(
        new Request(
          `${BASE}/oauth/callback/nope?code=abc&state=attacker-state`,
        ),
      ),
    );
    const nonOAuth = await shape(
      await edgeConnecta.fetch(
        new Request(
          `${BASE}/oauth/callback/plain?code=abc&state=attacker-state`,
        ),
      ),
    );
    const missingState = await shape(
      await connecta.fetch(
        new Request(`${BASE}/oauth/callback/svc?code=abc`),
      ),
    );
    const mismatchedState = await shape(
      await connecta.fetch(
        new Request(
          `${BASE}/oauth/callback/svc?code=abc&state=attacker-state`,
        ),
      ),
    );
    const noVerifier = await shape(
      await edgeConnecta.fetch(
        new Request(
          `${BASE}/oauth/callback/unverified?code=abc&state=attacker-state`,
        ),
      ),
    );
    const throwingVerifier = await shape(
      await edgeConnecta.fetch(
        new Request(
          `${BASE}/oauth/callback/throwing?code=abc&state=attacker-state`,
        ),
      ),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain("Authorization could not be completed");
    expect(nonOAuth).toEqual(unknown);
    expect(missingState).toEqual(unknown);
    expect(mismatchedState).toEqual(unknown);
    expect(noVerifier).toEqual(unknown);
    expect(throwingVerifier).toEqual(unknown);
    expect(spy).not.toHaveBeenCalled();
    expect(unverifiedFinish).not.toHaveBeenCalled();
    expect(throwingFinish).not.toHaveBeenCalled();
  });

  it("logs the reason for an opaque state refusal", async () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const { connecta, storage } = makeConnecta(
      vi.fn(),
      memoryStorage(),
      logger,
    );
    warn.mockClear();
    await storage.set(STATE_KEY, "the-real-state");

    await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/svc?code=abc&state=attacker-state`,
      ),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(required(warn.mock.calls[0])[0]).toContain(
      "state did not match the pending authorization flow",
    );
  });

  it("distinguishes a missing state parameter from a mismatched one in the log", async () => {
    const warn = vi.fn();
    const { connecta, storage } = makeConnecta(vi.fn(), memoryStorage(), {
      ...silentLogger,
      warn,
    });
    warn.mockClear();
    await storage.set(STATE_KEY, "the-real-state");

    await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc`));

    expect(warn).toHaveBeenCalledTimes(1);
    const diagnostic = String(required(warn.mock.calls[0])[0]);
    expect(diagnostic).toContain("the state parameter was missing");
    expect(diagnostic).not.toContain("did not match");
  });

  // The response channel is closed above; this closes the clock. A refusal that
  // returns without touching storage answers measurably sooner than one that
  // read `oauth:state` first — on a KV-backed deployment that is a network hop
  // — which would re-open the enumeration the flat 400 exists to deny. Counting
  // reads rather than timing them: a wall-clock assertion is a CI flake waiting
  // to happen, and the count is the property that actually matters.
  it("an unknown id costs the same storage reads as a configured one", async () => {
    const reads: string[] = [];
    const inner = memoryStorage();
    const counting: KVStorage = {
      get: async (k) => {
        reads.push(k);
        return inner.get(k);
      },
      set: (k, v, o) => inner.set(k, v, o),
      delete: (k) => inner.delete(k),
    };
    const connecta = createTestConnecta({
      publicUrl: BASE,
      storage: counting,
      logger: silentLogger,
      connectors: [
        remoteMcp("svc", {
          url: "https://unused.example/mcp",
          auth: { type: "oauth" },
          _transportFactory: () => ({ async close() {} }) as unknown as Transport,
        }),
        api("plain", {
          description: "not an OAuth connector",
          tools: [
            {
              name: "noop",
              description: "does nothing",
              annotations: { readOnlyHint: true },
              handler: async () => ({}),
            },
          ],
        }),
        callbackConnector("unverified", async () => {}),
      ],
    });
    await counting.set(STATE_KEY, "the-real-state");

    const readsFor = async (id: string) => {
      reads.length = 0;
      const res = await connecta.fetch(
        new Request(
          `${BASE}/oauth/callback/${id}?code=abc&state=attacker-state`,
        ),
      );
      expect(res.status).toBe(400);
      return [...reads];
    };

    // The configured downstream-OAuth connector is the baseline: state plus
    // the epoch that decides whether that state is still current.
    expect(await readsFor("svc")).toEqual([
      "conn:svc:oauth:generation",
      "conn:svc:oauth:state",
    ]);
    // Every free-by-default refusal pays the same reads in its own namespace,
    // where an unconfigured id simply misses.
    expect(await readsFor("nope")).toEqual([
      "conn:nope:oauth:generation",
      "conn:nope:oauth:state",
    ]);
    expect(await readsFor("plain")).toEqual([
      "conn:plain:oauth:generation",
      "conn:plain:oauth:state",
    ]);
    expect(await readsFor("unverified")).toEqual([
      "conn:unverified:oauth:generation",
      "conn:unverified:oauth:state",
    ]);

    // A configured connector with no outstanding flow still pays both reads.
    await counting.delete(STATE_KEY);
    expect(await readsFor("svc")).toEqual([
      "conn:svc:oauth:generation",
      "conn:svc:oauth:state",
    ]);
  });

  it("bounds and escapes a verifier exception in the operator log", async () => {
    const warn = vi.fn();
    const finishAuth = vi.fn();
    const thrownMessage = `bad\n${"x".repeat(100)}`;
    const connecta = createTestConnecta({
      publicUrl: BASE,
      storage: memoryStorage(),
      logger: { ...silentLogger, warn },
      connectors: [
        callbackConnector(
          "throwing",
          async (code) => {
            finishAuth(code);
          },
          async () => {
            throw new Error(thrownMessage);
          },
        ),
      ],
    });
    warn.mockClear();

    const res = await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/throwing?code=abc&state=attacker-state`,
      ),
    );

    expect(res.status).toBe(400);
    expect(finishAuth).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const diagnostic = String(required(warn.mock.calls[0])[0]);
    expect(diagnostic).toContain("verifyState threw");
    expect(diagnostic).toContain("\\n");
    expect(diagnostic).not.toContain("\n");
    expect(diagnostic).toContain("(truncated)");
    expect(diagnostic).not.toContain("x".repeat(65));
  });

  it("error param → 400", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?error=access_denied`),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('data-oauth-callback="denied"');
  });

  it("missing code → 400", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc`));
    expect(res.status).toBe(400);
  });

  it("escapes a malicious error param (no raw <script> in the body)", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const evil = "<script>alert(1)</script>";
    const res = await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/svc?error=${encodeURIComponent(evil)}`,
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(evil);
    expect(body).not.toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// remoteMcp() refresh failures: a dead grant is an authorization problem, an
// unreachable or throttled token endpoint is an outage. The SDK's own auth()
// blurs the two (see KvOAuthProvider), so these run the whole path.
// ---------------------------------------------------------------------------
describe("remoteMcp() dead and transient refresh grants", () => {
  const issuer = "https://auth.example";
  const mcpUrl = "https://downstream.example/mcp";
  const resourceMetadataUrl =
    "https://downstream.example/.well-known/oauth-protected-resource";
  const SEAL_KEY = Buffer.alloc(32, 7).toString("base64");

  type TokenAnswer = () => Response | Promise<Response>;

  async function seededStorage(
    sealer?: ReturnType<typeof vaultOAuthSealer>,
    accessToken = "access-old",
  ) {
    const storage = memoryStorage();
    const seeder = new KvOAuthProvider("svc", storage, REDIRECT, undefined, true, sealer);
    await seeder.saveClientInformation(
      {
        client_id: "connecta-client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      },
      { issuer },
    );
    await seeder.saveTokens(
      {
        access_token: accessToken,
        token_type: "Bearer",
        refresh_token: "refresh-old",
      },
      { issuer },
    );
    return storage;
  }

  /**
   * The `https://auth.example` fixture: a downstream that rejects the stored
   * access token, and a token endpoint whose answer each case chooses.
   */
  function downstream(answer: {
    current: TokenAnswer;
    /** Accept the stored token for connect, then 401 every tool call. */
    revokedAfterConnect?: boolean;
  }) {
    const counts = { token: 0, register: 0, rejected: 0 };
    const redeemed: string[] = [];
    let rejectedAll = deferred<void>();
    let expectedRejections = Infinity;
    let tokenEntered = deferred<void>();
    let tokenGate: Promise<void> = Promise.resolve();
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      if (url.href === resourceMetadataUrl) {
        return Response.json({
          resource: mcpUrl,
          authorization_servers: [issuer],
        });
      }
      if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === `${issuer}/register`) {
        counts.register++;
        return Response.json({
          client_id: "replacement-client",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (url.href === `${issuer}/token`) {
        counts.token++;
        expect(init.body).toBeInstanceOf(URLSearchParams);
        redeemed.push((init.body as URLSearchParams).get("refresh_token") ?? "");
        tokenEntered.resolve();
        await tokenGate;
        return answer.current();
      }
      if (url.href !== mcpUrl) {
        throw new Error(`Unexpected OAuth test request: ${url.href}`);
      }
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const authorization = new Headers(init.headers).get("authorization");
      const method = (JSON.parse(String(init.body)) as { method: string }).method;
      if (
        authorization !== "Bearer access-new" ||
        (answer.revokedAfterConnect && method === "tools/call")
      ) {
        counts.rejected++;
        if (counts.rejected >= expectedRejections) rejectedAll.resolve();
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      const message = JSON.parse(String(init.body)) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "refreshing", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : undefined;
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    return {
      fetchStub,
      counts,
      redeemed,
      /** Hold the token endpoint until `callers` scopes have all been rejected. */
      gate(callers: number) {
        expectedRejections = callers;
        rejectedAll = deferred<void>();
        tokenEntered = deferred<void>();
        const release = deferred<void>();
        tokenGate = release.promise;
        return {
          ready: Promise.all([rejectedAll.promise, tokenEntered.promise]),
          release: () => release.resolve(),
        };
      },
    };
  }

  function connector() {
    return remoteMcp("svc", {
      url: mcpUrl,
      auth: { type: "oauth" },
      versionNegotiation: "legacy",
    });
  }

  const scope = (
    storage: KVStorage,
    sealer?: ReturnType<typeof vaultOAuthSealer>,
  ): ConnectorContext =>
    attachOAuthSealer({ ...ctx(storage), requestScope: {} }, sealer);

  async function failureOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return { error, classified: classifyCallError(error) };
    }
    throw new Error("expected the call to fail");
  }

  const deadAnswers: [string, TokenAnswer][] = [
    [
      "GitHub's 200 bad_refresh_token",
      () =>
        Response.json({
          error: "bad_refresh_token",
          error_description: "The refresh token passed is incorrect or expired.",
          error_uri: "https://docs.github.com/apps",
        }),
    ],
    [
      "400 invalid_grant",
      () =>
        Response.json(
          { error: "invalid_grant", error_description: "Token revoked." },
          { status: 400 },
        ),
    ],
    [
      "401 invalid_client",
      () =>
        Response.json(
          { error: "invalid_client", error_description: "Unknown client." },
          { status: 401 },
        ),
    ],
    [
      "400 invalid_scope",
      () => Response.json({ error: "invalid_scope" }, { status: 400 }),
    ],
    [
      "403 with a non-OAuth body",
      () =>
        new Response("<html>Forbidden</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    ],
    ["404 with no body", () => new Response(null, { status: 404 })],
  ];

  it.each(deadAnswers)(
    "%s ends as auth_required, drops the dead grant, and authorize_connector reaches consent",
    async (_label, tokenAnswer) => {
      const storage = await seededStorage();
      const answer = { current: tokenAnswer };
      const server = downstream(answer);
      const c = connector();
      vi.stubGlobal("fetch", server.fetchStub);
      try {
        const passive = scope(storage);
        const { error, classified } = await failureOf(c.listTools(passive));
        expect(error).toBeInstanceOf(Error);
        expect(classified).toMatchObject({
          code: "auth_required",
          retryable: false,
        });
        expect(classified.message).toContain("authorize_connector");
        expect(server.counts.token).toBe(1);
        // A passive call never starts consent, and never registers a client.
        expect(server.counts.register).toBe(0);
        const reader = new KvOAuthProvider("svc", storage, REDIRECT);
        expect(await reader.pendingAuthorizationUrl()).toBeUndefined();
        // The dead grant is gone, so nothing will replay it.
        expect(await reader.tokens()).toBeUndefined();
        await expect(c.status!(passive)).resolves.toMatchObject({
          state: "auth_required",
        });
        await c.closeScope?.(passive);

        const later = scope(storage);
        await expect(c.status!(later)).resolves.toMatchObject({
          state: "auth_required",
        });
        await c.closeScope?.(later);
        expect(server.counts.token).toBe(1);

        const authorizing = scope(storage);
        const started = await c.startAuth!(authorizing);
        expect(started.state).toBe("auth_required");
        expect(started.authorizationUrl).toMatch(
          new RegExp(`^${issuer}/authorize\\?`),
        );
        await c.closeScope?.(authorizing);
        expect(server.redeemed).toEqual(["refresh-old"]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("drops a dead grant held as sealed state", async () => {
    const sealer = vaultOAuthSealer(
      new CredentialVault(memoryStorage(), SEAL_KEY),
      "svc",
      undefined,
      silentLogger,
    );
    const storage = await seededStorage(sealer);
    const tokenKey = oauthValueStorageKey("oauth:tokens", "legacy");
    expect(await storage.get(tokenKey)).not.toContain("refresh-old");
    const server = downstream({
      current: () => Response.json({ error: "bad_refresh_token" }),
    });
    const c = connector();
    vi.stubGlobal("fetch", server.fetchStub);
    try {
      const passive = scope(storage, sealer);
      const { classified } = await failureOf(c.listTools(passive));
      expect(classified).toMatchObject({ code: "auth_required" });
      await c.closeScope?.(passive);
      expect(await storage.get(tokenKey)).toBeNull();

      const authorizing = scope(storage, sealer);
      const started = await c.startAuth!(authorizing);
      expect(started.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
      await c.closeScope?.(authorizing);
      expect(server.redeemed).toEqual(["refresh-old"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("discardRefusedGrant", () => {
    const tokenKey = oauthValueStorageKey("oauth:tokens", "legacy");
    const sealer = () =>
      vaultOAuthSealer(
        new CredentialVault(memoryStorage(), SEAL_KEY),
        "svc",
        undefined,
        silentLogger,
      );

    it("deletes through compareAndSet against the exact sealed raw value it read", async () => {
      const s = sealer();
      const storage = await seededStorage(s);
      const sealedRaw = await storage.get(tokenKey);
      expect(sealedRaw).not.toContain("refresh-old");
      const cas = vi.spyOn(storage, "compareAndSet");
      const del = vi.spyOn(storage, "delete");
      const p = new KvOAuthProvider("svc", storage, REDIRECT, undefined, false, s);
      await p.discardRefusedGrant("refresh-old", "legacy");
      expect(cas).toHaveBeenCalledWith(tokenKey, sealedRaw, null);
      expect(del).not.toHaveBeenCalled();
      expect(await storage.get(tokenKey)).toBeNull();
    });

    it("keeps a consent that lands between the read and the compare-and-set delete", async () => {
      const s = sealer();
      const storage = await seededStorage(s);
      const consent = new KvOAuthProvider("svc", storage, REDIRECT, undefined, true, s);
      const originalCas = storage.compareAndSet!.bind(storage);
      let casResult: boolean | undefined;
      storage.compareAndSet = async (key, expected, next, opts) => {
        if (key === tokenKey) {
          // A callback on another request completes consent right here.
          await consent.saveTokens(
            {
              access_token: "access-consented",
              token_type: "Bearer",
              refresh_token: "refresh-consented",
            },
            { issuer },
          );
        }
        casResult = await originalCas(key, expected, next, opts);
        return casResult;
      };
      const del = vi.spyOn(storage, "delete");
      const p = new KvOAuthProvider("svc", storage, REDIRECT, undefined, false, s);
      await p.discardRefusedGrant("refresh-old", "legacy");
      expect(casResult).toBe(false);
      expect(del).not.toHaveBeenCalled();
      expect(await consent.tokens()).toMatchObject({
        access_token: "access-consented",
        refresh_token: "refresh-consented",
      });
    });

    it("falls back to a plain delete on a store without compareAndSet", async () => {
      const seeded = await seededStorage();
      const { compareAndSet: _omitted, ...rest } = seeded;
      const storage: KVStorage = rest;
      const del = vi.spyOn(storage, "delete");
      const p = new KvOAuthProvider("svc", storage, REDIRECT, undefined, false);
      await p.discardRefusedGrant("refresh-old", "legacy");
      expect(del).toHaveBeenCalledWith(tokenKey);
      expect(await storage.get(tokenKey)).toBeNull();
    });

    it("leaves a different refresh token alone", async () => {
      const storage = await seededStorage();
      const p = new KvOAuthProvider("svc", storage, REDIRECT, undefined, false);
      await p.discardRefusedGrant("refresh-other", "legacy");
      expect(await p.tokens()).toMatchObject({ refresh_token: "refresh-old" });
    });
  });

  it("gives every caller joined on a dead refresh flight the same auth_required", async () => {
    const storage = await seededStorage();
    const server = downstream({
      current: () => Response.json({ error: "bad_refresh_token" }),
    });
    const c = connector();
    vi.stubGlobal("fetch", server.fetchStub);
    try {
      const gate = server.gate(3);
      const scopes = Array.from({ length: 3 }, () => scope(storage));
      const calls = Promise.all(scopes.map((s) => failureOf(c.listTools(s))));
      await gate.ready;
      gate.release();
      const failures = await calls;
      expect(failures.map((f) => f.classified.code)).toEqual([
        "auth_required",
        "auth_required",
        "auth_required",
      ]);
      expect(server.counts.token).toBe(1);
      const reader = new KvOAuthProvider("svc", storage, REDIRECT);
      expect(await reader.tokens()).toBeUndefined();
      expect(await reader.pendingAuthorizationUrl()).toBeUndefined();
      await Promise.all(scopes.map((s) => c.closeScope?.(s)));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const transientAnswers: [
    string,
    TokenAnswer,
    { code: string; retryAfterMs?: number },
  ][] = [
    [
      "503 server_error",
      () =>
        Response.json(
          { error: "server_error", error_description: "down" },
          { status: 503 },
        ),
      { code: "unavailable" },
    ],
    [
      "503 temporarily_unavailable with Retry-After",
      () =>
        Response.json(
          { error: "temporarily_unavailable" },
          { status: 503, headers: { "retry-after": "12" } },
        ),
      { code: "unavailable", retryAfterMs: 12_000 },
    ],
    [
      "502 with a non-OAuth body",
      () => new Response("Bad Gateway", { status: 502 }),
      { code: "unavailable" },
    ],
    [
      "500 invalid_grant",
      () => Response.json({ error: "invalid_grant" }, { status: 500 }),
      { code: "unavailable" },
    ],
    ["408", () => new Response(null, { status: 408 }), { code: "unavailable" }],
    ["425", () => new Response(null, { status: 425 }), { code: "unavailable" }],
    [
      "429 with Retry-After",
      () =>
        Response.json(
          { error: "too_many_requests" },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      { code: "rate_limited", retryAfterMs: 30_000 },
    ],
    [
      "429 without Retry-After",
      () => new Response("slow down", { status: 429 }),
      { code: "rate_limited" },
    ],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          }),
        });
      },
      { code: "unavailable" },
    ],
  ];

  it.each(transientAnswers)(
    "%s stays a retryable outage, keeps the grant, and writes no consent",
    async (_label, tokenAnswer, expected) => {
      const storage = await seededStorage();
      const answer = { current: tokenAnswer };
      const server = downstream(answer);
      const c = connector();
      vi.stubGlobal("fetch", server.fetchStub);
      try {
        const passive = scope(storage);
        const { classified } = await failureOf(c.listTools(passive));
        expect(classified).toMatchObject({ ...expected, retryable: true });
        if (expected.retryAfterMs === undefined) {
          expect(classified.retryAfterMs).toBeUndefined();
        }
        expect(server.counts.token).toBe(1);
        expect(server.counts.register).toBe(0);
        const reader = new KvOAuthProvider("svc", storage, REDIRECT);
        expect(await reader.pendingAuthorizationUrl()).toBeUndefined();
        expect(await reader.tokens()).toMatchObject({
          access_token: "access-old",
          refresh_token: "refresh-old",
        });
        // Nothing is latched: a status read in the same scope tries again,
        // meets the same outage, and still reports it as one.
        await expect(c.status!(passive)).resolves.toMatchObject({
          state: "error",
        });
        await c.closeScope?.(passive);
        expect(server.counts.token).toBe(2);
        expect(await reader.pendingAuthorizationUrl()).toBeUndefined();

        // The outage passes; the kept grant still works.
        answer.current = () =>
          Response.json({
            access_token: "access-new",
            token_type: "Bearer",
            refresh_token: "refresh-new",
          });
        const later = scope(storage);
        await expect(c.listTools(later)).resolves.toEqual([]);
        await c.closeScope?.(later);
        expect(server.redeemed).toEqual([
          "refresh-old",
          "refresh-old",
          "refresh-old",
        ]);
        expect(await reader.tokens()).toMatchObject({
          refresh_token: "refresh-new",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    [
      "a dead grant",
      () => Response.json({ error: "bad_refresh_token" }),
      { code: "auth_required", retryable: false },
      undefined,
    ],
    [
      "an outage",
      () => new Response("Service Unavailable", { status: 503 }),
      { code: "unavailable", retryable: true },
      { refresh_token: "refresh-old" },
    ],
  ])(
    "classifies %s met by a tool call after connect",
    async (_label, tokenAnswer, expected, keptTokens) => {
      const storage = await seededStorage(undefined, "access-new");
      const server = downstream({
        current: tokenAnswer,
        revokedAfterConnect: true,
      });
      const c = connector();
      vi.stubGlobal("fetch", server.fetchStub);
      try {
        const passive = scope(storage);
        await expect(c.listTools(passive)).resolves.toEqual([]);
        expect(server.counts.token).toBe(0);
        const { classified } = await failureOf(c.callTool("ping", {}, passive));
        expect(classified).toMatchObject(expected);
        expect(server.counts.token).toBe(1);
        const reader = new KvOAuthProvider("svc", storage, REDIRECT);
        expect(await reader.pendingAuthorizationUrl()).toBeUndefined();
        if (keptTokens === undefined) {
          expect(await reader.tokens()).toBeUndefined();
        } else {
          expect(await reader.tokens()).toMatchObject(keptTokens);
        }
        await c.closeScope?.(passive);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("gives every caller joined on a transient refresh flight the same retryable outage", async () => {
    const storage = await seededStorage();
    const tokenKey = oauthValueStorageKey("oauth:tokens", "legacy");
    // A follower's last token read comes from the coordinator itself, right
    // before it joins the flight: the bearer header read, the SDK's issuer
    // read, then the coordinator's. Hold the owner's token request until both
    // followers have made all three, so none can arrive after the flight ends.
    let tokenReads = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = async (key) => {
      if (key === tokenKey) tokenReads++;
      return originalGet(key);
    };
    const server = downstream({
      current: () =>
        Response.json({ error: "server_error" }, { status: 503 }),
    });
    const c = connector();
    vi.stubGlobal("fetch", server.fetchStub);
    try {
      const gate = server.gate(3);
      const scopes = Array.from({ length: 3 }, () => scope(storage));
      const calls = Promise.all(scopes.map((s) => failureOf(c.listTools(s))));
      await gate.ready;
      await vi.waitFor(() => expect(tokenReads).toBe(9));
      // The join itself follows one more generation read: let it land.
      await new Promise((resolve) => setTimeout(resolve, 0));
      gate.release();
      const failures = await calls;
      for (const { classified } of failures) {
        expect(classified).toMatchObject({ code: "unavailable", retryable: true });
      }
      expect(server.counts.token).toBe(1);
      const reader = new KvOAuthProvider("svc", storage, REDIRECT);
      expect(await reader.pendingAuthorizationUrl()).toBeUndefined();
      expect(await reader.tokens()).toMatchObject({ refresh_token: "refresh-old" });
      await Promise.all(scopes.map((s) => c.closeScope?.(s)));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
