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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KvOAuthProvider,
  OAuthRefreshCoordinator,
  oauthValueStorageKey,
} from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { classifyCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  ConnectorContext,
  InboundAuth,
  KVStorage,
  Logger,
} from "../src/types.js";
import { createTestConnecta, required, silentLogger } from "./helpers.js";
import { inMemoryDownstream, throwingTransport } from "./fixtures/downstream-mcp.js";
import { connectorContext as ctx, deferred } from "./fixtures/misc.js";

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

  it("finishes OAuth from a non-default protected-resource metadata URL", async () => {
    const storage = memoryStorage();
    const issuer = "https://auth.example";
    const mcpUrl = "https://downstream.example/mcp";
    const metadataUrl =
      "https://downstream.example/.well-known/custom-protected-resource/mcp";
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
        return Response.json({
          access_token: "access-token",
          token_type: "Bearer",
        });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };

    const start = new KvOAuthProvider("svc", storage, REDIRECT);
    await expect(
      auth(start, {
        serverUrl: mcpUrl,
        resourceMetadataUrl: new URL(metadataUrl),
        fetchFn: fetchStub,
      }),
    ).resolves.toBe("REDIRECT");
    const pending = new URL((await start.pendingAuthorizationUrl())!);

    const callback = new KvOAuthProvider("svc", storage, REDIRECT);
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

    await new KvOAuthProvider("svc", storage, REDIRECT).resetAuthorization();
    expect(await backing.get(oldTokenKey)).toBeNull();
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
    await new KvOAuthProvider("svc", storage, REDIRECT).resetAuthorization();
    releaseRememberRead();
    await lateWrite;

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

  it("rechecks a pending mutation after a contender's token read", async () => {
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
    const trackedOwner = trackedAbortSignal();
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

    trackedOwner.controller.abort(
      new DOMException("Owner scope ended", "AbortError"),
    );
    releaseTokenRead();
    const blocked = await contenderRefresh;

    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "temporarily_unavailable",
    });
    expect(upstreamRequests).toBe(1);
    expect(trackedOwner.listeners()).toBe(0);
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

  it("shares one rotating-token redemption across two request scopes", async () => {
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

    let oldTokenRequests = 0;
    let refreshRequests = 0;
    let releaseRefresh!: () => void;
    const bothScopesRejected = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
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
        expect((init.body as URLSearchParams).get("refresh_token")).toBe(
          "refresh-old",
        );
        if (refreshRequests > 1) {
          return Response.json(
            { error: "invalid_grant", error_description: "already rotated" },
            { status: 400 },
          );
        }
        await bothScopesRejected;
        return Response.json({
          access_token: "access-new",
          token_type: "Bearer",
          refresh_token: "refresh-new",
        });
      }
      if (url.href !== mcpUrl) {
        throw new Error(`Unexpected OAuth test request: ${url.href}`);
      }
      if (init.method !== "POST") return new Response(null, { status: 405 });

      const authorization = new Headers(init.headers).get("authorization");
      if (authorization === "Bearer access-old") {
        oldTokenRequests++;
        if (oldTokenRequests === 2) releaseRefresh();
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://downstream.example/.well-known/oauth-protected-resource"',
          },
        });
      }
      expect(authorization).toBe("Bearer access-new");
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
    const first = { ...ctx(storage), requestScope: {} };
    const second = { ...ctx(storage), requestScope: {} };

    vi.stubGlobal("fetch", fetchStub);
    try {
      await expect(
        Promise.all([connector.listTools(first), connector.listTools(second)]),
      ).resolves.toEqual([[], []]);
    } finally {
      await Promise.all([
        connector.closeScope?.(first),
        connector.closeScope?.(second),
      ]);
      vi.unstubAllGlobals();
    }

    expect(oldTokenRequests).toBe(2);
    expect(refreshRequests).toBe(1);
    expect(
      await new KvOAuthProvider("svc", storage, REDIRECT).tokens(),
    ).toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
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
    expect(status.authorizationUrl).toBe(authUrl);
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
      await operatorRequest("/ui/data")
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
    await storage.set("oauth:pending", url);
    await storage.set("oauth:verifier", "verifier-123");
    const context = ctx(storage);

    const first = await c.startAuth!(context, {});
    const second = await c.startAuth!(context, {});

    expect(first.state).toBe("auth_required");
    expect(first.authorizationUrl).toBe(url);
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
    expect(after.authorizationUrl).toBe("https://auth.example/reauth");
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
    expect(await res.text()).toContain("access_denied");
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
    expect(body).toContain("&lt;script&gt;");
  });
});
