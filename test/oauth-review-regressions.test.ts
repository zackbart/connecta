import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { api } from "../src/connectors/api.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthGrantKeys, oauthRefreshKeys, oauthV2Keys, OAUTH_REFRESH_LEASE_SECONDS } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { connectorContext, deferred } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";

const A = "https://issuer-a.example";
const B = "https://issuer-b.example";
const REDIRECT = "https://connecta.test/oauth/callback/svc";
const GRANT = oauthGrantKeys.grant;
const tokens = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const discovery = (issuer = A, endpoint = `${issuer}/token`) => ({
  authorizationServerUrl: issuer,
  authorizationServerMetadata: {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: endpoint,
    response_types_supported: ["code"],
  },
});
function backingStore(delayed: boolean): KVStorage {
  const backing = memoryStorage();
  if (!delayed) return backing;
  const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const hop =
    <Args extends unknown[], R>(op: (...args: Args) => Promise<R>) =>
    async (...args: Args): Promise<R> => {
      await turn();
      const answer = await op(...args);
      await turn();
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
const provider = (storage: KVStorage, coordinator?: OAuthRefreshCoordinator) =>
  new KvOAuthProvider("svc", storage, REDIRECT, coordinator);
async function consent(storage: KVStorage) {
  const p = provider(storage);
  await p.beginFlow();
  await p.saveDiscoveryState(discovery());
  await p.saveClientInformation({ client_id: "client-a" }, { issuer: A });
  const state = await p.state();
  await p.saveCodeVerifier("verifier-a");
  await p.redirectToAuthorization(new URL(`${A}/authorize?client_id=client-a&state=${state}`));
  return state;
}
async function v2(storage: KVStorage) {
  await storage.set(oauthV2Keys.generation, "v2:old");
  for (const [field, value] of [
    [oauthV2Keys.field.client, { client_id: "client-a" }],
    [oauthV2Keys.field.tokens, tokens],
    [oauthV2Keys.field.discovery, discovery()],
  ] as const) {
    await storage.set(
      oauthV2Keys.value(field, "v2:old"),
      JSON.stringify({ connectaOAuthVersion: 2, generation: "v2:old", issuer: A, value }),
    );
  }
  await storage.set("oauth:cleanup:v2:older", "[]");
  await storage.set("oauth:cleanup-at:v2:older", "0");
}
const refreshInit = {
  method: "POST",
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
};
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["memory", false],
  ["delayed", true],
] as const)("round-1 OAuth regressions on %s storage", (_label, delayed) => {
  it("fences A's consent when a concurrent Continue selects B, including callbacks without iss (INV-5)", async () => {
    const storage = backingStore(delayed);
    const metadata = "https://resource.example/.well-known/oauth-protected-resource";
    const resource = "https://resource.example/mcp";
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const releaseSecond = deferred<void>();
    let discoveries = 0;
    const dispatches: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.href === metadata) {
        const n = ++discoveries;
        if (n === 1) {
          firstEntered.resolve();
          await secondEntered.promise;
        } else {
          secondEntered.resolve();
          await releaseSecond.promise;
        }
        return Response.json({ resource, authorization_servers: [n === 1 ? A : B] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          ...discovery(url.origin).authorizationServerMetadata,
          registration_endpoint: `${url.origin}/register`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (url.pathname === "/register")
        return Response.json({
          ...(JSON.parse(String(init?.body)) as object),
          client_id: url.origin === A ? "client-a" : "client-b",
        });
      if (url.pathname === "/token") {
        dispatches.push(url.origin);
        return Response.json(tokens);
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
      });
    });
    const c = () => remoteMcp("svc", { url: resource, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    const ctx = () => ({ ...connectorContext(storage), requestScope: {} });
    const firstConnector = c();
    const first = firstConnector.startAuth!(ctx());
    // Bind A to the first metadata exchange before starting B; async cache
    // fingerprinting does not promise launch-order network dispatch.
    await firstEntered.promise;
    const second = c().startAuth!(ctx());
    await secondEntered.promise;
    const startA = await first;
    expect(startA.state).toBe("auth_required");
    const state = new URL(startA.authorizationUrl!).searchParams.get("state")!;
    const epochA = (await storedGrant(storage))!.epoch;
    releaseSecond.resolve();
    expect((await second).state).toBe("auth_required");
    expect((await storedGrant(storage))!.epoch).not.toBe(epochA);
    await expect(
      firstConnector.finishAuth!("code-a", ctx(), new URLSearchParams({ state, code: "code-a" })),
    ).rejects.toThrow(/authorization changed/);
    expect(dispatches).toEqual([]);
  });

  it.each(["issuer", "client", "endpoint", "discovery"])(
    "refuses a changed %s after the claim even if the epoch stays the same (INV-5)",
    async (changed) => {
      const storage = backingStore(delayed);
      const state = await consent(storage);
      const p = provider(storage);
      expect(await p.verifyState(state)).toBe(true);
      await p.bindFlow();
      await p.claimCodeExchange();
      const grant = (await storedGrant(storage))!;
      if (changed === "issuer") grant.body!.issuer = B;
      if (changed === "client") grant.body!.client!.value.client_id = "client-b";
      if (changed === "endpoint") grant.body!.discovery = discovery(A, `${B}/token`);
      if (changed === "discovery")
        grant.body!.discovery = { ...discovery(), resourceMetadata: { resource: "https://other.example/mcp" } };
      await storage.set(GRANT, JSON.stringify(grant));
      const send = vi.fn(async () => Response.json(tokens));
      await expect(p.dispatchCodeExchange(send)).rejects.toThrow(/authorization changed/);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("refuses an iss mismatch against the consent before claiming or dispatching (INV-5)", async () => {
    const storage = backingStore(delayed);
    const state = await consent(storage);
    const c = remoteMcp("svc", { url: "https://resource.example/mcp", auth: { type: "oauth" } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      c.finishAuth!("code", connectorContext(storage), new URLSearchParams({ state, code: "code", iss: B })),
    ).rejects.toThrow(/issuer does not match/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await provider(storage).verifyState(state)).toBe(true);
  });

  it.each(["rotation", "unchanged refresh", "identical answer"])(
    "N independent isolates dispatch exactly one refresh with %s (INV-5)",
    async (answer) => {
      const storage = backingStore(delayed);
      await seedGrant(storage, { issuer: A, tokens });
      const isolates = Array.from({ length: 8 }, () => new OAuthRefreshCoordinator());
      const providers = await Promise.all(
        isolates.map(async (coordinator) => {
          const p = provider(storage, coordinator);
          await p.beginFlow();
          await p.tokens({ issuer: A });
          return p;
        }),
      );
      const gate = deferred<void>();
      const entered = deferred<void>();
      const next =
        answer === "identical answer"
          ? tokens
          : {
              ...tokens,
              access_token: "new-access",
              ...(answer === "rotation" ? { refresh_token: "new-refresh" } : {}),
            };
      const fetch = vi.fn(async () => {
        entered.resolve();
        await gate.promise;
        return Response.json(next);
      });
      const requests = isolates.map((coordinator, n) =>
        coordinator.coordinatedFetch(providers[n]!, fetch)(`${A}/token`, refreshInit),
      );
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fetch).toHaveBeenCalledTimes(1);
      gate.resolve();
      expect(await Promise.all(requests.map(async (request) => (await request).json()))).toEqual(
        Array.from({ length: 8 }, () => next),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await storedGrant(storage))!.body!.tokens).toMatchObject(next);
    },
  );

  it("recovers a crashed holder after lease expiry without dispatch while its lease is held (INV-7)", async () => {
    const storage = backingStore(delayed);
    await seedGrant(storage, { issuer: A, tokens });
    const coordinator = new OAuthRefreshCoordinator();
    const p = provider(storage, coordinator);
    await p.beginFlow();
    await p.tokens({ issuer: A });
    const key = oauthRefreshKeys.lease(
      (await storedGrant(storage))!.epoch,
      await oauthStateDigest(tokens.refresh_token),
    );
    await storage.set(
      key,
      JSON.stringify({
        connectaOAuthRefresh: 1,
        holder: "crashed",
        state: "claimed",
        expiresAt: Date.now() + OAUTH_REFRESH_LEASE_SECONDS * 1000,
      }),
    );
    const fetch = vi.fn(async () => Response.json({ ...tokens, refresh_token: "new-refresh" }));
    const request = coordinator.coordinatedFetch(p, fetch)(`${A}/token`, refreshInit);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).not.toHaveBeenCalled();
    const raw = JSON.parse((await storage.get(key))!) as { expiresAt: number };
    raw.expiresAt = Date.now() - 1;
    await storage.set(key, JSON.stringify(raw));
    expect((await request).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["after grant CAS", "during deletion", "after deletion", "during marker clear"])(
    "retries migration cleanup after a crash %s, and Disconnect cannot resurrect it (INV-5)",
    async (crash) => {
      const backing = backingStore(delayed);
      await v2(backing);
      let failed = false;
      const storage: KVStorage = {
        ...backing,
        async compareAndSet(key, expected, next, opts) {
          if (
            !failed &&
            key === GRANT &&
            ((crash === "after grant CAS" && expected === null) ||
              (crash === "during marker clear" && next !== null && !next.includes("cleanupPending")))
          ) {
            failed = true;
            if (crash === "after grant CAS") await backing.compareAndSet(key, expected, next, opts);
            throw new Error("simulated crash");
          }
          return backing.compareAndSet(key, expected, next, opts);
        },
        async delete(key) {
          if (!failed && (crash === "during deletion" || crash === "after deletion")) {
            failed = true;
            if (crash === "after deletion") await backing.delete(key);
            throw new Error("simulated crash");
          }
          await backing.delete(key);
        },
      };
      await provider(storage)
        .tokens({ issuer: A })
        .catch(() => undefined);
      expect(failed).toBe(true);
      expect(JSON.parse((await backing.get(GRANT))!)).toHaveProperty("cleanupPending", true);
      await provider(backing).resetAuthorization(true);
      expect(await provider(backing).tokens()).toBeUndefined();
      expect(await provider(backing).operatorDisconnected()).toBe(true);
      expect(
        (await backing.list("oauth:")).filter((key) =>
          oauthV2Keys.family.prefixes.some((prefix) => key.startsWith(prefix)),
        ),
      ).toEqual([]);
      expect(JSON.parse((await backing.get(GRANT))!)).not.toHaveProperty("cleanupPending");
      expect(await provider(backing).tokens()).toBeUndefined();
    },
  );

  it.each([false, true])(
    "keeps cleanup pending through a failed reset deletion, disconnect %s (INV-5)",
    async (disconnect) => {
      const backing = backingStore(delayed);
      await v2(backing);
      let refuse = true;
      const storage: KVStorage = {
        ...backing,
        async delete(key) {
          if (refuse) throw new Error("delete refused");
          await backing.delete(key);
        },
      };
      await provider(storage).tokens({ issuer: A });
      await provider(storage).resetAuthorization(disconnect);
      expect(JSON.parse((await backing.get(GRANT))!)).toHaveProperty("cleanupPending", true);
      expect(await provider(storage).tokens()).toBeUndefined();
      refuse = false;
      expect(await provider(storage).tokens()).toBeUndefined();
      expect(JSON.parse((await backing.get(GRANT))!)).not.toHaveProperty("cleanupPending");
      expect(await provider(storage).operatorDisconnected()).toBe(disconnect);
      expect(await backing.list("oauth:")).toEqual([GRANT]);
    },
  );

  it("hands cross-isolate waiters the re-consent verdict without a second dispatch or stored raw text (INV-6)", async () => {
    const storage = backingStore(delayed);
    await seedGrant(storage, { issuer: A, tokens });
    const coordinators = Array.from({ length: 4 }, () => new OAuthRefreshCoordinator());
    const providers = await Promise.all(
      coordinators.map(async (coordinator) => {
        const p = provider(storage, coordinator);
        await p.beginFlow();
        await p.tokens({ issuer: A });
        return p;
      }),
    );
    const gate = deferred<void>();
    const entered = deferred<void>();
    const fetch = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      return Response.json({ error: "server_error", error_description: "DOWNSTREAM_SECRET_SENTINEL" }, { status: 503 });
    });
    const requests = coordinators.map((coordinator, n) =>
      coordinator
        .coordinatedFetch(providers[n]!, fetch)(`${A}/token`, refreshInit)
        .catch(() => undefined),
    );
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.resolve();
    await Promise.all(requests);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const p of providers) expect(p.refreshVerdict()).toEqual({ kind: "dead" });
    for (const key of await storage.list("oauth:refresh:"))
      expect(await storage.get(key)).not.toContain("DOWNSTREAM_SECRET_SENTINEL");
    expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
  });

  it("requires re-consent if a crashed holder rotated before committing (INV-5)", async () => {
    const storage = backingStore(delayed);
    await seedGrant(storage, { issuer: A, tokens });
    const coordinator = new OAuthRefreshCoordinator();
    const p = provider(storage, coordinator);
    await p.beginFlow();
    await p.tokens({ issuer: A });
    const key = oauthRefreshKeys.lease(
      (await storedGrant(storage))!.epoch,
      await oauthStateDigest(tokens.refresh_token),
    );
    await storage.set(
      key,
      JSON.stringify({
        connectaOAuthRefresh: 1,
        holder: "crashed-after-rotation",
        state: "dispatched",
        expiresAt: Date.now() - 1,
      }),
    );
    const fetch = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(coordinator.coordinatedFetch(p, fetch)(`${A}/token`, refreshInit)).rejects.toThrow(
      /authorization required/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await provider(storage).tokens()).toBeUndefined();
  });

  it("advances the epoch before a static endpoint replacement publishes consent and completes the new grant (INV-5)", async () => {
    const storage = backingStore(delayed);
    const ctx = () => ({ ...connectorContext(storage), requestScope: {} });
    const c = (endpoint: string) =>
      api("svc", {
        oauth: {
          authorizationEndpoint: `${A}/authorize`,
          tokenEndpoint: endpoint,
          clientId: "static-client",
          apiOrigins: ["https://resource.example"],
        },
        tools: [],
      });
    const fetch = vi.fn(async () => Response.json(tokens));
    vi.stubGlobal("fetch", fetch);
    const old = c(`${A}/token`);
    const start = await old.startAuth!(ctx());
    const oldState = new URL(start.authorizationUrl!).searchParams.get("state")!;
    await old.finishAuth!("old-code", ctx(), new URLSearchParams({ state: oldState, code: "old-code" }));
    const epoch = (await storedGrant(storage))!.epoch;
    const next = c(`${B}/token`);
    const nextStart = await next.startAuth!(ctx());
    const state = new URL(nextStart.authorizationUrl!).searchParams.get("state")!;
    expect((await storedGrant(storage))!.epoch).not.toBe(epoch);
    await next.finishAuth!("new-code", ctx(), new URLSearchParams({ state, code: "new-code" }));
    expect((await storedGrant(storage))!.body!.issuer).toBe(`${B}/token`);
    expect((await storedGrant(storage))!.body!.tokens).toMatchObject(tokens);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("claims a PKCE-less api consent once across two programmatic callbacks (INV-5)", async () => {
    const storage = backingStore(delayed);
    const c = api("svc", {
      oauth: {
        authorizationEndpoint: `${A}/authorize`,
        tokenEndpoint: `${A}/token`,
        clientId: "static-client",
        pkce: false,
        apiOrigins: ["https://resource.example"],
      },
      tools: [],
    });
    const ctx = () => ({ ...connectorContext(storage), requestScope: {} });
    const start = await c.startAuth!(ctx());
    const state = new URL(start.authorizationUrl!).searchParams.get("state")!;
    const fetch = vi.fn(async () => Response.json(tokens));
    vi.stubGlobal("fetch", fetch);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => c.finishAuth!("code", ctx(), new URLSearchParams({ state, code: "code" }))),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await storedGrant(storage))!.body!.tokens).toMatchObject(tokens);
  });

  it("Disconnect removes historical keys even when a modern grant already exists (INV-5)", async () => {
    const storage = backingStore(delayed);
    await v2(storage);
    await seedGrant(storage, { issuer: A, tokens });
    await provider(storage).resetAuthorization(true);
    expect(await storage.list("oauth:")).toEqual([GRANT]);
  });

  it.each(["remoteMcp", "api"])(
    "two programmatic %s callbacks without state send nothing, including pkce false (INV-5)",
    async (kind) => {
      const storage = backingStore(delayed);
      const c =
        kind === "api"
          ? api("svc", {
              oauth: {
                authorizationEndpoint: `${A}/authorize`,
                tokenEndpoint: `${A}/token`,
                clientId: "static-client",
                pkce: false,
                apiOrigins: ["https://resource.example"],
              },
              tools: [],
            })
          : remoteMcp("svc", { url: "https://resource.example/mcp", auth: { type: "oauth" } });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () => Reflect.apply(c.finishAuth!, c, ["code", connectorContext(storage)])),
      );
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
