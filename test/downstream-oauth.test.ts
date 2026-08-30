import { UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  OAuthClientInformationContext,
  OAuthClientInformationFull,
  OAuthTokens,
  Transport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KvOAuthProvider,
  oauthValueStorageKey,
} from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
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
): Promise<void> {
  const generation = (await storage.get("oauth:generation")) ?? "legacy";
  await storage.set(
    oauthValueStorageKey(key, generation),
    JSON.stringify({
      connectaOAuthVersion: 2,
      generation,
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
    ]);
    expect(await backing.get("oauth:client")).toBeNull();
    expect(await backing.get("oauth:tokens")).toBe("oauth:tokens");
    expect(await backing.get("oauth:pending")).toBeNull();
    expect(await backing.get("oauth:verifier")).toBeNull();
    expect(await backing.get("oauth:state")).toBeNull();
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
    };

    const pTokens = provider();
    await seed(pTokens);
    await pTokens.invalidateCredentials("tokens");
    expect(await pTokens.tokens()).toBeUndefined();
    expect(await pTokens.clientInformation()).toBeDefined();
    expect(await pTokens.codeVerifier()).toBe("v-123");

    const pClient = provider();
    await seed(pClient);
    await pClient.invalidateCredentials("client");
    expect(await pClient.clientInformation()).toBeUndefined();
    expect(await pClient.tokens()).toBeDefined();

    const pVerifier = provider();
    await seed(pVerifier);
    await pVerifier.invalidateCredentials("verifier");
    await expect(pVerifier.codeVerifier()).rejects.toThrow();
    expect(await pVerifier.tokens()).toBeDefined();

    const pAll = provider();
    await seed(pAll);
    await pAll.invalidateCredentials("all");
    expect(await pAll.clientInformation()).toBeUndefined();
    expect(await pAll.tokens()).toBeUndefined();
    await expect(pAll.codeVerifier()).rejects.toThrow();
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
