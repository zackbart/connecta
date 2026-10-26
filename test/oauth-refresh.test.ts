import { beforeEach as beforeTransportTest } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";

// Stand in for the Node host while preserving this suite's fetch leaves.
beforeTransportTest(() => {
  installOwnedTransport();
});

import { UnauthorizedError } from "@modelcontextprotocol/client";
import type { FetchLike, OAuthTokens } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { identityStorageKey } from "../src/identity.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthGrantKeys, scopes as keyScopes } from "../src/storage/keys.js";
import type { KVStorage } from "../src/types.js";
import { makeRegistry } from "./helpers.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext as ctx, deferred } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";

// The refresh coordinator (#707): one token request per owner partition and
// epoch, an accepted rotation stored by compare-and-set before anyone is
// released, and joined scopes handed the owner's tokens or verdict. Every
// interleaving is held on a deferred promise, never on a timer. The dispatched
// failure matrix lives with the remoteMcp() flows.

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const GRANT = oauthGrantKeys.grant;
const issuer = "https://auth.example";
const ISSUER = { issuer };
const TOKEN_URL = `${issuer}/token`;
const mcpUrl = "https://downstream.example/mcp";
const resourceMetadataUrl = "https://downstream.example/.well-known/oauth-protected-resource";

const bearer = (access: string, refresh?: string): OAuthTokens => ({
  access_token: access,
  token_type: "Bearer",
  ...(refresh !== undefined ? { refresh_token: refresh } : {}),
});

const refreshInit = (token: string): RequestInit => ({
  method: "POST",
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }),
});

/** Let every pending continuation run: memory storage and the stubs answer in microtasks. */
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A grant for `issuer` holding `tokens`, in a fresh store. */
async function grantStore(tokens: OAuthTokens = bearer("access-old", "refresh-old")): Promise<KVStorage> {
  const storage = memoryStorage();
  await seedGrant(storage, { issuer, tokens: tokens as NonNullable<Parameters<typeof seedGrant>[1]["tokens"]> });
  return storage;
}

/**
 * A flow as remoteMcp() runs one: bound to the live epoch, then the SDK's
 * issuer-aware token read that decides to refresh.
 */
async function flow(
  storage: KVStorage,
  coordinator: OAuthRefreshCoordinator,
  options: { passive?: boolean; signal?: AbortSignal } = {},
): Promise<KvOAuthProvider> {
  const provider = new KvOAuthProvider(
    "svc",
    storage,
    REDIRECT,
    coordinator,
    !options.passive,
    undefined,
    options.signal,
  );
  await provider.beginFlow();
  await provider.tokens(ISSUER);
  return provider;
}

const refresh = (
  coordinator: OAuthRefreshCoordinator,
  provider: KvOAuthProvider,
  fetch: FetchLike,
  token = "refresh-old",
  signal?: AbortSignal,
) => coordinator.coordinatedFetch(provider, fetch, signal)(TOKEN_URL, refreshInit(token));

/** A token endpoint that records each refresh token it redeems. */
function tokenServer(
  answer: (n: number, token: string) => Response | Promise<Response> = () =>
    Response.json(bearer("access-new", "refresh-new")),
) {
  const redeemed: string[] = [];
  const entered = deferred<void>();
  const fetch: FetchLike = async (_input, init) => {
    const token = new URLSearchParams(init?.body as URLSearchParams).get("refresh_token") ?? "";
    redeemed.push(token);
    entered.resolve();
    return answer(redeemed.length, token);
  };
  return { fetch, redeemed, entered: entered.promise };
}

/** `backing`, with the first grant compare-and-set whose next value `hold` matches held. */
function holdingStore(backing: KVStorage, hold: (next: string | null) => boolean) {
  const entered = deferred<void>();
  const release = deferred<void>();
  let armed = true;
  const storage: KVStorage = {
    ...backing,
    compareAndSet: async (key, expected, next, options) => {
      if (armed && key === GRANT && hold(next)) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return backing.compareAndSet(key, expected, next, options);
    },
  };
  return { storage, entered: entered.promise, release: () => release.resolve() };
}

/** Authorization-server metadata and the protected resource's 401, for flows the SDK drives. */
function discovery(input: string | URL): Response | undefined {
  const url = new URL(input);
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
  }
  if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
    return Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: TOKEN_URL,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  return undefined;
}

const unauthorized = () =>
  new Response(null, {
    status: 401,
    headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
  });

/** A minimal MCP server answer for initialize and tools/list. */
function mcpAnswer(init: RequestInit): Response {
  const message = JSON.parse(String(init.body)) as {
    id?: number | string;
    method: string;
    params?: { protocolVersion?: string };
  };
  if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
  return Response.json({
    jsonrpc: "2.0",
    id: message.id,
    result:
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "rotating", version: "1" },
          }
        : { tools: [] },
  });
}

describe("OAuthRefreshCoordinator", () => {
  it.each([
    ["a rotating answer", bearer("access-new", "refresh-new"), bearer("access-new", "refresh-new")],
    ["an answer that keeps the refresh token", bearer("access-new"), bearer("access-new", "refresh-old")],
  ])(
    "coordinates eight scopes and permits the next successful refresh generation after %s",
    async (_name, answer, expected) => {
      const storage = await grantStore();
      const coordinator = new OAuthRefreshCoordinator();
      const gate = deferred<void>();
      const nextGate = deferred<void>();
      const server = tokenServer(async (n) => {
        await (n === 1 ? gate.promise : nextGate.promise);
        return Response.json(n === 1 ? answer : bearer("access-next", expected.refresh_token));
      });
      const flows = await Promise.all(Array.from({ length: 8 }, () => flow(storage, coordinator)));
      const refreshes = flows.map((provider) => refresh(coordinator, provider, server.fetch));
      await server.entered;
      await drain();
      expect(server.redeemed).toEqual(["refresh-old"]);
      gate.resolve();
      const bodies = await Promise.all(
        (await Promise.all(refreshes)).map((response) => response.json() as Promise<OAuthTokens>),
      );
      for (const body of bodies) expect(body).toEqual(expected);
      // Stored once, stamped with the issuer the refresh answered to.
      expect((await storedGrant(storage))?.body?.tokens).toEqual({ ...expected, issuer });
      // Each SDK's own save of those tokens writes nothing more.
      const writes = vi.spyOn(storage, "compareAndSet");
      await Promise.all(flows.map((provider, i) => provider.saveTokens(bodies[i]!, ISSUER)));
      expect(writes).not.toHaveBeenCalled();
      // A fresh flow can refresh again after the successful commit, including
      // vendors that return the same refresh-token bytes for several hours.
      const coordinators = [new OAuthRefreshCoordinator(), new OAuthRefreshCoordinator()];
      const next = await Promise.all(coordinators.map((c) => flow(storage, c)));
      const following = next.map((provider, i) =>
        refresh(coordinators[i]!, provider, server.fetch, expected.refresh_token),
      );
      await drain();
      nextGate.resolve();
      for (const response of await Promise.all(following)) expect(response.status).toBe(200);
      expect(server.redeemed).toEqual(["refresh-old", expected.refresh_token]);
    },
  );

  it("hands a scope whose token read predates a rotation the stored result without a token request", async () => {
    const expected = bearer("access-new", "refresh-new");
    const storage = await grantStore();
    const coordinator = new OAuthRefreshCoordinator();
    const server = tokenServer(() => Response.json(expected));
    const stale = await flow(storage, coordinator);
    const owner = await flow(storage, coordinator);
    const owned = (await (await refresh(coordinator, owner, server.fetch)).json()) as OAuthTokens;
    await owner.saveTokens(owned, ISSUER);
    // The stale scope still asks with refresh-old, the token the owner spent.
    const handed = (await (await refresh(coordinator, stale, server.fetch)).json()) as OAuthTokens;
    expect(handed).toEqual(expected);
    await stale.saveTokens(handed, ISSUER);
    expect(server.redeemed).toEqual(["refresh-old"]);
    expect((await storedGrant(storage))?.body?.tokens).toEqual({ ...expected, issuer });
  });

  it("settles joined scopes with re-consent after HTTP 503 and never resends (INV-5)", async () => {
    const storage = await grantStore();
    const coordinator = new OAuthRefreshCoordinator();
    const gate = deferred<void>();
    const server = tokenServer(async () => {
      await gate.promise;
      return Response.json({ error: "server_error" }, { status: 503 });
    });
    const owner = await flow(storage, coordinator, { passive: true });
    const follower = await flow(storage, coordinator, { passive: true });
    const owning = refresh(coordinator, owner, server.fetch);
    await server.entered;
    const following = refresh(coordinator, follower, server.fetch).catch((error: unknown) => error);
    await drain();
    gate.resolve();
    expect(await (await owning).json()).toMatchObject({ error: "invalid_grant" });
    expect(await following).toBeInstanceOf(Error);
    for (const provider of [owner, follower]) await expect(provider.state()).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await storedGrant(storage))?.body?.tokens).toBeUndefined();
    const retry = await flow(storage, coordinator);
    expect((await refresh(coordinator, retry, server.fetch)).status).toBe(400);
    expect(server.redeemed).toEqual(["refresh-old"]);
  });

  it.each(["redirects to consent", "invalidates its tokens"])(
    "stores an accepted rotation before release when the owner %s instead of saving",
    async (ending) => {
      const storage = await grantStore();
      const coordinator = new OAuthRefreshCoordinator();
      const server = tokenServer((n) =>
        Response.json(n === 1 ? bearer("access-new", "refresh-new") : bearer("access-next", "refresh-next")),
      );
      const stale = await flow(storage, coordinator);
      const owner = await flow(storage, coordinator);
      const owned = (await (await refresh(coordinator, owner, server.fetch)).json()) as OAuthTokens;
      // Stored before the owner's SDK did anything with the answer.
      expect((await storedGrant(storage))?.body?.tokens).toEqual({ ...bearer("access-new", "refresh-new"), issuer });
      if (ending === "invalidates its tokens") {
        await owner.invalidateCredentials("tokens");
      } else {
        await owner.state();
        await owner.redirectToAuthorization(new URL(`${issuer}/authorize?state=s`));
      }
      expect((await storedGrant(storage))?.body?.tokens).toMatchObject({ refresh_token: "refresh-new" });
      // A scope that read refresh-old gets the rotation instead of spending it again.
      expect(await (await refresh(coordinator, stale, server.fetch)).json()).toEqual(
        bearer("access-new", "refresh-new"),
      );
      expect(server.redeemed).toEqual(["refresh-old"]);
      // The next rotation is free to go, and the owner's late SDK save of the
      // one already stored does not write over it.
      const next = await flow(storage, coordinator);
      await refresh(coordinator, next, server.fetch, "refresh-new");
      await owner.saveTokens(owned, ISSUER);
      expect(server.redeemed).toEqual(["refresh-old", "refresh-new"]);
      expect((await storedGrant(storage))?.body?.tokens).toMatchObject({ refresh_token: "refresh-next" });
    },
  );

  it.each(["the epoch is still live", "a disconnect landed before the answer"])(
    "commits an answer that arrives after its owner left only into its own epoch: %s",
    async (phase) => {
      const backing = await grantStore();
      const coordinator = new OAuthRefreshCoordinator();
      const gate = deferred<void>();
      // The answer arrives whatever the owner's signal says.
      const server = tokenServer(async () => {
        await gate.promise;
        return Response.json(bearer("access-new", "refresh-new"));
      });
      const controller = new AbortController();
      const owner = await flow(backing, coordinator, { signal: controller.signal });
      const committing = vi.spyOn(owner, "storeRefresh");
      const owning = refresh(coordinator, owner, server.fetch, "refresh-old", controller.signal);
      await server.entered;
      const reason = new Error("owner left");
      controller.abort(reason);
      // The owner leaves at once; its redemption goes on without it.
      await expect(owning).rejects.toBe(reason);
      const resetter = new KvOAuthProvider("svc", backing, REDIRECT, coordinator);
      if (phase !== "the epoch is still live") await resetter.resetAuthorization(true);
      gate.resolve();
      await vi.waitFor(() => expect(committing).toHaveBeenCalledTimes(1));
      await committing.mock.results[0]!.value;
      const grant = await storedGrant(backing);
      if (phase === "the epoch is still live") {
        expect(grant).toMatchObject({ epoch: "v3:seeded", body: { tokens: { refresh_token: "refresh-new", issuer } } });
        return;
      }
      expect(grant?.epoch).not.toBe("v3:seeded");
      expect(grant?.body?.tokens).toBeUndefined();
      expect(await resetter.operatorDisconnected()).toBe(true);
    },
  );

  it("stamps a rotation with the issuer its refresh answered to, never one the token endpoint wrote", async () => {
    const storage = await grantStore();
    const coordinator = new OAuthRefreshCoordinator();
    const server = tokenServer(() =>
      Response.json({ ...bearer("access-new", "refresh-new"), issuer: "https://elsewhere.example" }),
    );
    const owner = await flow(storage, coordinator);
    const answer = await (await refresh(coordinator, owner, server.fetch)).json();
    expect(answer).not.toHaveProperty("issuer");
    expect((await storedGrant(storage))?.body?.tokens).toEqual({ ...bearer("access-new", "refresh-new"), issuer });
    expect(await storage.get(GRANT)).not.toContain("elsewhere");
    const repointed = new KvOAuthProvider("svc", storage, REDIRECT, new OAuthRefreshCoordinator());
    expect(await repointed.tokens({ issuer: "https://new-as.example" })).toBeUndefined();
  });

  it.each(["a newer rotation another isolate stored", "another server's grant"])(
    "does not store a late rotation over %s",
    async (landed) => {
      const storage = await grantStore();
      // Another writer may finish a consent while a leased refresh is in flight.
      const coordinator = new OAuthRefreshCoordinator();
      const gate = deferred<void>();
      const slow = tokenServer(async () => {
        await gate.promise;
        return Response.json(bearer("access-slow", "refresh-slow"));
      });
      const owner = await flow(storage, coordinator);
      const owning = refresh(coordinator, owner, slow.fetch);
      await slow.entered;
      if (landed === "another server's grant") {
        await new KvOAuthProvider("svc", storage, REDIRECT).saveClientInformation(
          { client_id: "other", redirect_uris: [REDIRECT] },
          { issuer: "https://other-as.example" },
        );
      } else {
        await new KvOAuthProvider("svc", storage, REDIRECT).saveTokens(bearer("access-fast", "refresh-fast"), ISSUER);
      }
      const before = await storage.get(GRANT);
      gate.resolve();
      if (landed === "another server's grant") {
        await expect(owning).rejects.toBeInstanceOf(UnauthorizedError);
      } else {
        const answered = (await (await owning).json()) as OAuthTokens;
        await owner.saveTokens(answered, ISSUER);
      }
      expect(await storage.get(GRANT)).toBe(before);
      expect(before).not.toContain("refresh-slow");
    },
  );

  it.each(["the grant still holds them", "a consent landed meanwhile"])(
    "drops refused tokens by compare-and-set before releasing joiners when %s",
    async (phase) => {
      const backing = await grantStore();
      const discarding = phase === "the grant still holds them";
      const held = holdingStore(backing, (next) => discarding && next !== null && !next.includes("refresh-old"));
      const coordinator = new OAuthRefreshCoordinator();
      const gate = deferred<void>();
      const server = tokenServer(async () => {
        await gate.promise;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      });
      const ownerScope = new AbortController();
      const owner = await flow(held.storage, coordinator, { passive: true, signal: ownerScope.signal });
      const owning = refresh(coordinator, owner, server.fetch, "refresh-old", ownerScope.signal).catch(() => undefined);
      await server.entered;
      const follower = await flow(backing, coordinator, { passive: true });
      const outcomes = [
        refresh(coordinator, follower, server.fetch).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ];
      await drain();
      if (!discarding)
        await new KvOAuthProvider("svc", backing, REDIRECT).saveTokens(bearer("access-fresh", "refresh-fresh"), ISSUER);
      gate.resolve();
      if (discarding) {
        await held.entered;
        // The owner leaving mid-discard frees nothing: a scope arriving now
        // joins the refusal instead of redeeming refresh-old again.
        ownerScope.abort(new DOMException("Owner scope ended", "AbortError"));
        const late = await flow(backing, coordinator, { passive: true });
        outcomes.push(
          refresh(coordinator, late, server.fetch).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        await drain();
        held.release();
      }
      await owning;
      for (const outcome of await Promise.all(outcomes)) {
        expect(outcome).toEqual(new Error("OAuth refresh failed with HTTP 400."));
      }
      expect(server.redeemed).toEqual(["refresh-old"]);
      // A joined passive scope inherits the dead verdict: auth_required.
      await expect(follower.invalidateCredentials("tokens")).rejects.toBeInstanceOf(UnauthorizedError);
      const tokens = (await storedGrant(backing))?.body?.tokens;
      if (discarding) expect(tokens).toBeUndefined();
      else expect(tokens).toMatchObject({ refresh_token: "refresh-fresh" });
    },
  );

  it("bounds a successful token response's read and permanently refuses its ambiguous oversized answer", async () => {
    const storage = await grantStore();
    const coordinator = new OAuthRefreshCoordinator();
    let pulled = 0;
    const oversized: FetchLike = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(4096).fill(32));
            if (pulled === 100) controller.close();
          },
        }),
      );
    const owner = await flow(storage, coordinator, { passive: true });
    await expect(refresh(coordinator, owner, oversized)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(pulled).toBeLessThan(100);
    await expect(owner.state()).rejects.toThrow("Authorization required");
    const server = tokenServer();
    expect((await storedGrant(storage))?.body?.tokens).toBeUndefined();
    expect((await refresh(coordinator, await flow(storage, coordinator), server.fetch)).status).toBe(400);
    expect(server.redeemed).toEqual([]);
  });

  it("shares exactly one rotating-token grant in each of two waves of eight scopes", async () => {
    const storage = memoryStorage();
    await seedGrant(storage, {
      issuer,
      client: {
        value: { client_id: "connecta-client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
      },
      tokens: { access_token: "access-old", token_type: "Bearer", refresh_token: "refresh-old" },
    });
    let wave = 0;
    let oldTokenRequests = 0;
    const redeemed: string[] = [];
    let rejected = deferred<void>();
    let tokenEntered = deferred<void>();
    let tokenGate = deferred<void>();
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const known = discovery(input);
      if (known) return known;
      const url = new URL(input);
      if (url.href === TOKEN_URL) {
        const token = (init.body as URLSearchParams).get("refresh_token")!;
        expect(redeemed).not.toContain(token);
        redeemed.push(token);
        expect(token).toBe(wave === 0 ? "refresh-old" : "refresh-new");
        tokenEntered.resolve();
        await tokenGate.promise;
        return Response.json(
          wave === 0 ? bearer("access-new", "refresh-new") : bearer("access-second", "refresh-second"),
        );
      }
      if (url.href !== mcpUrl) throw new Error(`Unexpected OAuth test request: ${url.href}`);
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const authorization = new Headers(init.headers).get("authorization");
      if (authorization === (wave === 0 ? "Bearer access-old" : "Bearer access-new")) {
        if (++oldTokenRequests === 8) rejected.resolve();
        return unauthorized();
      }
      expect(authorization).toBe(wave === 0 ? "Bearer access-new" : "Bearer access-second");
      return mcpAnswer(init);
    });
    const connector = remoteMcp("svc", { url: mcpUrl, auth: { type: "oauth" }, versionNegotiation: "legacy" });
    try {
      for (wave = 0; wave < 2; wave++) {
        oldTokenRequests = 0;
        rejected = deferred<void>();
        tokenEntered = deferred<void>();
        tokenGate = deferred<void>();
        const scopes = Array.from({ length: 8 }, () => ({ ...ctx(storage), requestScope: {} }));
        const calls = Promise.all(scopes.map((scope) => connector.listTools(scope)));
        await Promise.all([rejected.promise, tokenEntered.promise]);
        expect(redeemed).toHaveLength(wave + 1);
        tokenGate.resolve();
        await expect(calls).resolves.toEqual(Array.from({ length: 8 }, () => []));
        expect(oldTokenRequests).toBe(8);
        expect(redeemed).toHaveLength(wave + 1);
        expect((await storedGrant(storage))?.body?.tokens).toMatchObject(
          wave === 0 ? bearer("access-new", "refresh-new") : bearer("access-second", "refresh-second"),
        );
        await Promise.all(scopes.map((scope) => connector.closeScope?.(scope)));
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(redeemed).toEqual(["refresh-old", "refresh-new"]);
  });

  it.each(["status", "late-answer"])(
    "retains a personal registry during %s and recovers idle eviction capacity",
    async (phase) => {
      const owner = await identityStorageKey({ namespace: "synthetic", id: "alice" });
      const grantKey = `${keyScopes.principal(owner)}${keyScopes.connector("svc")}${GRANT}`;
      const backing = memoryStorage();
      const entered = deferred<void>();
      const release = deferred<void>();
      const writeEntered = deferred<void>();
      const writeRelease = deferred<void>();
      let grantReads = 0;
      const storage: KVStorage = {
        ...backing,
        async get(key) {
          if (key === grantKey) grantReads++;
          return backing.get(key);
        },
        async compareAndSet(key, expected, next, options) {
          if (phase === "late-answer" && key === grantKey && next?.includes("rotated-refresh")) {
            writeEntered.resolve();
            await writeRelease.promise;
          }
          return backing.compareAndSet(key, expected, next, options);
        },
      };
      const connector = remoteMcp("svc", {
        url: mcpUrl,
        auth: { type: "oauth" },
        authScope: "personal",
        versionNegotiation: "legacy",
      });
      const root = makeRegistry([connector], { storage });
      const active = root.personalRegistry(owner);
      const view = () => root.scoped({ connectorIds: "all", principalKey: owner });
      const seeder = new KvOAuthProvider("svc", view().contextFor("svc", BASE).storage, REDIRECT);
      await seeder.saveClientInformation(
        { client_id: "synthetic", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
        ISSUER,
      );
      await seeder.saveTokens(bearer("old", "old-refresh"), ISSUER);
      const downstream = httpDownstream(() => {}, { url: mcpUrl });
      let redemptions = 0;
      let refusals = 0;
      const bothRefused = deferred<void>();
      vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
        const known = discovery(input);
        if (known) return known;
        if (new URL(input).href === TOKEN_URL) {
          redemptions++;
          expect((init.body as URLSearchParams).get("refresh_token")).toBe("old-refresh");
          entered.resolve();
          await release.promise;
          return Response.json(bearer("new", "rotated-refresh"));
        }
        if (new Headers(init.headers).get("authorization") !== "Bearer new") {
          if (++refusals === 2) bothRefused.resolve();
          return unauthorized();
        }
        return downstream.fetch(input, init);
      });
      const controller = new AbortController();
      const statusScopes = [{}, {}, {}];
      const pending: Promise<unknown>[] = [];
      try {
        const first = view().statusFor("svc", BASE, statusScopes[0], { signal: controller.signal });
        pending.push(first);
        await entered.promise;
        if (phase === "late-answer") {
          controller.abort(new Error("synthetic owner left before answer"));
          await first;
        }
        // Make Alice the oldest of 1,024 entries, then force an eviction.
        for (let i = 0; i < 1_024; i++) root.personalRegistry(`filler:${i}`);
        expect(root.personalRegistry(owner)).toBe(active);
        if (phase === "late-answer") {
          release.resolve();
          await writeEntered.promise;
          for (let i = 0; i < 1_024; i++) root.personalRegistry(`late:${i}`);
          expect(root.personalRegistry(owner)).toBe(active);
          writeRelease.resolve();
          await vi.waitFor(async () =>
            expect(await seeder.tokens()).toMatchObject({ refresh_token: "rotated-refresh" }),
          );
        }
        const second = view().statusFor("svc", BASE, statusScopes[1]);
        pending.push(second);
        if (phase !== "late-answer") await bothRefused.promise;
        // Let the second caller reach the first's flight: its grant reads stop
        // once it waits there.
        let reads = -1;
        while (reads !== grantReads) {
          reads = grantReads;
          for (let i = 0; i < 5; i++) await drain();
        }
        release.resolve();
        await Promise.all(pending);
        expect((await view().statusFor("svc", BASE, statusScopes[2])).state).toBe("ok");
        expect(redemptions).toBe(1);
        // Once work drains, Alice can be evicted again. New owners still fit.
        for (let i = 0; i < 1_024; i++) root.personalRegistry(`idle:${i}`);
        expect(root.personalRegistry(owner)).not.toBe(active);
      } finally {
        release.resolve();
        writeRelease.resolve();
        await Promise.allSettled(pending);
        await Promise.all(statusScopes.map((scope) => connector.closeScope?.(active.contextFor("svc", BASE, scope))));
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["initial", "disconnect"])(
    "isolates personal registry refreshes with %s epochs while coalescing each owner's scopes",
    async (epoch) => {
      const connector = remoteMcp("svc", {
        url: mcpUrl,
        auth: { type: "oauth" },
        authScope: "personal",
        versionNegotiation: "legacy",
      });
      const registry = makeRegistry([connector]);
      const principalKeys = await Promise.all(
        ["alice", "bob"].map((id) => identityStorageKey({ namespace: "synthetic", id })),
      );
      const ownerViews = principalKeys.map((principalKey) => registry.scoped({ connectorIds: "all", principalKey }));
      const scopes = ownerViews.map((view, owner) => [
        view.contextFor("svc", BASE),
        registry.scoped({ connectorIds: "all", principalKey: principalKeys[owner]! }).contextFor("svc", BASE),
      ]);
      const gates = [deferred<void>(), deferred<void>()];
      const entered = [deferred<void>(), deferred<void>()];
      const rejected = [deferred<void>(), deferred<void>()];
      const counts = [0, 0];
      const oldRequests = [0, 0];
      const outcomes: Promise<unknown>[] = [];
      for (let owner = 0; owner < 2; owner++) {
        const p = new KvOAuthProvider("svc", scopes[owner]![0]!.storage, REDIRECT);
        if (epoch !== "initial") await p.resetAuthorization();
        await p.saveClientInformation(
          { client_id: `client-${owner}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
          ISSUER,
        );
        await p.saveTokens(bearer(`old-${owner}`, `refresh-${owner}`), ISSUER);
      }
      vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
        const known = discovery(input);
        if (known) return known;
        if (new URL(input).href === TOKEN_URL) {
          const owner = Number((init.body as URLSearchParams).get("refresh_token")!.slice(-1));
          counts[owner] = counts[owner]! + 1;
          entered[owner]!.resolve();
          await gates[owner]!.promise;
          return Response.json(bearer(`new-${owner}`, `rotated-${owner}`));
        }
        if (init.method !== "POST") return new Response(null, { status: 405 });
        const authorization = new Headers(init.headers).get("authorization")!;
        const owner = Number(authorization.slice(-1));
        if (authorization === `Bearer old-${owner}`) {
          if (++oldRequests[owner]! === 2) rejected[owner]!.resolve();
          return unauthorized();
        }
        expect(authorization).toBe(`Bearer new-${owner}`);
        return mcpAnswer(init);
      });
      try {
        const a = Promise.all(scopes[0]!.map((scope) => connector.listTools(scope)));
        const aOutcome = a.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        outcomes.push(aOutcome);
        await Promise.all([entered[0]!.promise, rejected[0]!.promise]);
        const b = Promise.all(scopes[1]!.map((scope) => connector.listTools(scope)));
        const bOutcome = b.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        outcomes.push(bOutcome);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([entered[1]!.promise, rejected[1]!.promise]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Bob's refresh waited on Alice's partition")), 1_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        expect(counts).toEqual([1, 1]);
        if (epoch === "disconnect") await connector.disconnectAuth!(ownerViews[0]!.contextFor("svc", BASE));
        gates[1]!.resolve();
        expect(await bOutcome).toEqual({ value: [[], []] });
        gates[0]!.resolve();
        if (epoch === "disconnect") expect(await aOutcome).toHaveProperty("error");
        else expect(await aOutcome).toEqual({ value: [[], []] });
        expect(counts).toEqual([1, 1]);
        for (let owner = 0; owner < 2; owner++) {
          const saved = await new KvOAuthProvider("svc", scopes[owner]![0]!.storage, REDIRECT).tokens();
          if (epoch === "disconnect" && owner === 0) expect(saved).toBeUndefined();
          else expect(saved).toMatchObject({ access_token: `new-${owner}`, refresh_token: `rotated-${owner}` });
        }
      } finally {
        gates.forEach((gate) => gate.resolve());
        await Promise.all(outcomes);
        await Promise.all(scopes.flat().map((scope) => connector.closeScope?.(scope)));
        vi.unstubAllGlobals();
      }
    },
  );
});
