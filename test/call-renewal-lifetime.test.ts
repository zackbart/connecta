import { auth } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator } from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
import { providerRequests, tracksEveryRequest } from "../src/provider-call.js";
import { callFromContext, contextView, openRequest, viewLease } from "../src/runtime/call.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  oauthGrantKeys,
  oauthFlowKeys,
  oauthRefreshActiveKeys,
  oauthRefreshKeys,
  oauthRefreshSpentKeys,
  scopes,
} from "../src/storage/keys.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";
import { makeRegistry } from "./helpers.js";
import { deferred } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { oauthTransports, staticOAuthRequest } from "./fixtures/static-oauth-transport.js";

const BASE = "https://connecta.example";
const ORIGIN = "https://tickets.example";
const TOKEN = `${ORIGIN}/token`;
const old = { access_token: "stale-access", refresh_token: "stale-refresh", token_type: "Bearer" };
const fresh = { access_token: "fresh-access", refresh_token: "fresh-refresh", token_type: "Bearer" };
const namespace = scopes.connector("tickets");
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const phases = [
  "grant read",
  "coordinator read",
  "claim submitted",
  "claimed read",
  "liveness reply",
  "dispatch reply",
  "spent write",
  "spent reply",
  "dispatched",
] as const;
type Phase = (typeof phases)[number];
const coordinatorOwned = (phase: Phase) => phase !== "grant read" && phase !== "coordinator read";

async function snapshot(storage: KVStorage): Promise<Record<string, string | null>> {
  return Object.fromEntries(
    await Promise.all((await storage.list("")).map(async (key) => [key, await storage.get(key)])),
  );
}

/** Check settlement while the grant read or authorization-server response is still held. */
async function promptly<T>(promise: Promise<T>): Promise<T | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hold real storage preparation, including the last spent CAS, recording write starts. */
function observedStore(backing: KVStorage, phase: Phase, ready: () => boolean, namespace = "") {
  const entered = deferred<void>();
  const release = deferred<void>();
  const writes: string[] = [];
  let held = false;
  const wait = async () => {
    held = true;
    entered.resolve();
    await release.promise;
  };
  const lease = (key: string) => key.startsWith(`${namespace}${oauthRefreshKeys.prefix}`);
  const spent = (key: string) => key.startsWith(`${namespace}${oauthRefreshSpentKeys.family.prefixes[0]}`);
  const storage: KVStorage = {
    ...backing,
    async get(key) {
      if (
        !held &&
        ready() &&
        ((phase === "grant read" && key === `${namespace}${oauthGrantKeys.grant}`) ||
          (phase === "coordinator read" && lease(key)) ||
          (phase === "claimed read" && key === `${namespace}${oauthGrantKeys.grant}` && writes.some(lease)))
      )
        await wait();
      return backing.get(key);
    },
    async set(key, value, options) {
      writes.push(key);
      await backing.set(key, value, options);
      if (!held && phase === "liveness reply" && key.startsWith(`${namespace}${oauthRefreshActiveKeys.prefix}`))
        await wait();
    },
    async delete(key) {
      writes.push(key);
      return backing.delete(key);
    },
    async compareAndSet(key, expected, next, options) {
      writes.push(key);
      // Hold submission before the durable claim exists: ownership must
      // transfer before the CAS promise settles, including when it loses.
      if (!held && phase === "claim submitted" && lease(key) && next?.includes('"state":"claimed"')) await wait();
      if (!held && phase === "spent write" && spent(key)) await wait();
      const won = await backing.compareAndSet(key, expected, next, options);
      if (
        !held &&
        won &&
        ((phase === "dispatch reply" && lease(key) && next?.includes('"state":"dispatched"')) ||
          (phase === "spent reply" && spent(key)))
      )
        await wait();
      return won;
    },
  };
  return { storage, writes, entered: entered.promise, release: () => release.resolve() };
}

async function seedDownstream(storage: KVStorage) {
  await seedGrant(storage, {
    issuer: ORIGIN,
    tokens: old,
    client: { value: { client_id: "fixture-client", issuer: ORIGIN } },
    discovery: {
      authorizationServerUrl: ORIGIN,
      resourceMetadata: { resource: ORIGIN },
      authorizationServerMetadata: {
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: TOKEN,
        response_types_supported: ["code"],
      },
    },
  });
}

async function downstreamFlow(storage: KVStorage, scope: object, coordinator = new OAuthRefreshCoordinator()) {
  const operation: ConnectorContext = {
    storage,
    baseUrl: BASE,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    requestScope: scope,
  };
  const lease = callFromContext(operation, "read");
  const view = contextView(lease, operation);
  const provider = new KvOAuthProvider(
    "tickets",
    storage,
    `${BASE}/oauth/callback/tickets`,
    coordinator,
    false,
    undefined,
    view.signal,
  );
  await provider.beginFlow();
  await provider.tokens({ issuer: ORIGIN });
  return { lease, view, provider, coordinator };
}

beforeEach(() => {
  installOwnedTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("production OAuth renewal ownership", () => {
  it("INV-7: code exchange without an external signal cannot POST after its callback request closes", async () => {
    const backing = memoryStorage();
    const entered = deferred<void>();
    const gate = deferred<void>();
    let hold = false;
    const storage: KVStorage = {
      ...backing,
      async compareAndSet(key, expected, next, options) {
        const won = await backing.compareAndSet(key, expected, next, options);
        if (hold && won && key.startsWith(`${namespace}${oauthFlowKeys.prefix}`) && next?.includes('"consumed":true')) {
          hold = false;
          entered.resolve();
          await gate.promise;
        }
        return won;
      },
    };
    const send = vi.fn(async () => Response.json(fresh));
    vi.stubGlobal("fetch", send);
    const connector = api("tickets", {
      oauth: {
        authorizationEndpoint: `${ORIGIN}/authorize`,
        tokenEndpoint: TOKEN,
        clientId: "fixture-client",
        apiOrigins: [ORIGIN],
      },
      tools: [],
    });
    const registry = makeRegistry([connector], { storage });
    const consent = await connector.startAuth!(registry.contextFor("tickets", BASE));
    const state = new URL(consent.authorizationUrl!).searchParams.get("state")!;
    const scope = {};
    const callback = registry.contextFor("tickets", BASE, scope);
    expect(callback.signal).toBeUndefined();
    expect(await connector.verifyState!(state, callback)).toBe(true);
    hold = true;
    const pending = connector.finishAuth!(
      "fixture-code",
      callback,
      new URLSearchParams({ code: "fixture-code", state }),
    ).catch((error: unknown) => error);
    try {
      await entered.promise;
      openRequest(scope).close();
      gate.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(send).not.toHaveBeenCalled();
      expect((await storedGrant(backing, namespace))?.body?.tokens).toBeUndefined();
    } finally {
      gate.resolve();
      await pending;
      openRequest(scope).close();
    }
  });

  for (const boundary of ["call", "request"] as const) {
    for (const transport of oauthTransports) {
      for (const method of ["GET", "POST"] as const) {
        it.each(phases)(
          `INV-7 INV-9: api OAuth ${transport} ${method} closed at the ${boundary} during %s refuses without consuming renewal`,
          async (phase) => {
            const backing = memoryStorage();
            await seedGrant(backing, { issuer: TOKEN, tokens: old }, "v3:seeded", namespace);
            let unauthorized = false;
            const store = observedStore(backing, phase, () => unauthorized, namespace);
            const dispatched = deferred<void>();
            const response = deferred<Response>();
            const tails: Promise<unknown>[] = [];
            const resources: string[] = [];
            let tokenSignal: AbortSignal | undefined;
            let tokens = 0;
            vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
              if (String(input) === TOKEN) {
                tokens++;
                tokenSignal = init?.signal ?? undefined;
                dispatched.resolve();
                return response.promise;
              }
              resources.push(new Headers(init?.headers).get("authorization")!);
              if (new Headers(init?.headers).get("authorization") === `Bearer ${fresh.access_token}`)
                return Response.json({ ok: true });
              unauthorized = true;
              return new Response(null, { status: 401 });
            });
            let view!: ConnectorContext;
            let renewal!: Promise<unknown>;
            const connector = tracksEveryRequest(
              api("tickets", {
                oauth: {
                  authorizationEndpoint: `${ORIGIN}/authorize`,
                  tokenEndpoint: TOKEN,
                  clientId: "fixture-client",
                  apiOrigins: [ORIGIN],
                },
                tools: [
                  {
                    name: "run",
                    description: "Read or write tickets.",
                    annotations: { readOnlyHint: method === "GET" },
                    handler: async (_, ctx) => {
                      view = ctx;
                      const pending = staticOAuthRequest(
                        transport,
                        ctx,
                        ORIGIN,
                        { method, path: "/notes", template: "/notes" },
                        method === "GET" ? "read" : "write",
                      );
                      renewal = pending.catch((error: unknown) => error);
                      await pending;
                      return { ok: true };
                    },
                  },
                ],
              }),
            );
            const scope = {};
            const registry = makeRegistry([connector], { storage: store.storage });
            const tools = createMetaTools(registry, BASE, {
              requestScope: scope,
              defer: (tail) => tails.push(tail),
            });
            const call =
              method === "GET"
                ? tools.callTool({ address: "tickets.run" })
                : tools.callDestructiveTool({ address: "tickets.run" });
            try {
              await (phase === "dispatched" ? dispatched.promise : store.entered);
              if (!coordinatorOwned(phase)) expect(store.writes).toEqual([]);
              const before = await snapshot(backing);
              const writesAtClose = store.writes.length;
              const requests = providerRequests(view)!;
              const resource = requests.find((entry) => !entry.auxiliary)!;
              (boundary === "call" ? viewLease(view)! : openRequest(scope)).close();
              const ended = await promptly(renewal);
              expect(ended).toMatchObject({
                code: "connector_call_failed",
                message: expect.stringContaining("This call has ended"),
              });
              expect(resources).toEqual([`Bearer ${old.access_token}`]);
              expect((await storedGrant(backing, namespace))!.body!.tokens).toEqual(old);
              if (phase === "dispatched") {
                expect(tokenSignal).toBeDefined();
                expect(tokenSignal!.aborted).toBe(false);
              } else expect(tokens).toBe(0);
              if (!coordinatorOwned(phase)) {
                expect(store.writes).toHaveLength(writesAtClose);
                expect(await snapshot(backing)).toEqual(before);
              }
              // Claim submission already committed the coordinator to finish.
              // Release only after the caller refused; no caller result or
              // resource resend may follow the eventual grant commit.
              store.release();
              response.resolve(Response.json(fresh));
              await Promise.all(tails);
              await pause();
              const result = await call;
              expect(result.isError).toBe(true);
              if (method === "POST") {
                expect(result.structuredContent).toMatchObject({
                  error: {
                    code: "downstream_oauth_required",
                    retryable: false,
                    writeOutcome: "unknown",
                    nextAction: { tool: "authorize_connector" },
                  },
                });
              }
              expect(resource.renewed).not.toBe(true);
              expect(resources).toEqual([`Bearer ${old.access_token}`]);
              expect(tokens).toBe(coordinatorOwned(phase) ? 1 : 0);
              if (coordinatorOwned(phase)) {
                expect(tokenSignal!.aborted).toBe(false);
                expect((await storedGrant(backing, namespace))!.body!.tokens).toMatchObject(fresh);
                const spent = await backing.list(`${namespace}${oauthRefreshSpentKeys.family.prefixes[0]}`);
                expect(spent).toHaveLength(1);
                expect(JSON.parse((await backing.get(spent[0]!))!)).toMatchObject({ state: "resolved" });
                // A fresh deliberate call needs no consent or second refresh.
                const nextTools = createMetaTools(registry, BASE);
                const next = await (method === "GET"
                  ? nextTools.callTool({ address: "tickets.run" })
                  : nextTools.callDestructiveTool({ address: "tickets.run" }));
                expect(next.isError).not.toBe(true);
                expect(resources).toEqual([`Bearer ${old.access_token}`, `Bearer ${fresh.access_token}`]);
                expect(tokens).toBe(1);
              } else {
                expect((await storedGrant(backing, namespace))!.body!.tokens).toEqual(old);
                expect(store.writes).toHaveLength(writesAtClose);
                expect(await snapshot(backing)).toEqual(before);
              }
            } finally {
              store.release();
              response.resolve(Response.json(fresh));
              await call;
              await Promise.all(tails);
              openRequest(scope).close();
            }
          },
        );
      }
    }

    it.each(phases)(
      `INV-5 INV-7: downstream OAuth SDK grant closed at the ${boundary} during %s keeps coordinator ownership`,
      async (phase) => {
        const backing = memoryStorage();
        await seedDownstream(backing);
        let running = false;
        const store = observedStore(backing, phase, () => running);
        const scope = {};
        const { lease, view, provider, coordinator } = await downstreamFlow(store.storage, scope);
        const response = deferred<Response>();
        const dispatched = deferred<void>();
        const tails: Promise<unknown>[] = [];
        let tokenSignal: AbortSignal | undefined;
        const send = vi.fn(async (_input: string | URL, init?: RequestInit) => {
          expect(String(_input)).toBe(TOKEN);
          expect(new URLSearchParams(init?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
          tokenSignal = init?.signal ?? undefined;
          dispatched.resolve();
          return response.promise;
        });
        running = true;
        const pending = auth(provider, {
          serverUrl: new URL(ORIGIN),
          fetchFn: coordinator.coordinatedFetch(provider, send, view.signal, (tail) => tails.push(tail)),
        }).catch((error: unknown) => error);
        try {
          await (phase === "dispatched" ? dispatched.promise : store.entered);
          if (!coordinatorOwned(phase)) expect(store.writes).toEqual([]);
          const before = await snapshot(backing);
          const writesAtClose = store.writes.length;
          (boundary === "call" ? lease : openRequest(scope)).close();
          expect(await promptly(pending)).toMatchObject({
            code: "connector_call_failed",
            message: expect.stringContaining("This call has ended"),
          });
          if (phase === "dispatched") expect(tokenSignal!.aborted).toBe(false);
          else expect(send).not.toHaveBeenCalled();
          store.release();
          response.resolve(Response.json(fresh));
          await Promise.all(tails);
          await pause();
          if (coordinatorOwned(phase)) {
            expect(tokenSignal!.aborted).toBe(false);
            expect((await storedGrant(backing))!.body!.tokens).toMatchObject(fresh);
            const spent = await backing.list(oauthRefreshSpentKeys.family.prefixes[0]);
            expect(spent).toHaveLength(1);
            expect(JSON.parse((await backing.get(spent[0]!))!)).toMatchObject({ state: "resolved" });
          } else {
            expect((await storedGrant(backing))!.body!.tokens).toEqual(old);
            expect(store.writes).toHaveLength(writesAtClose);
            expect(await snapshot(backing)).toEqual(before);
          }
          expect(send).toHaveBeenCalledTimes(coordinatorOwned(phase) ? 1 : 0);
        } finally {
          store.release();
          response.resolve(Response.json(fresh));
          await pending;
          await Promise.all(tails);
          openRequest(scope).close();
        }
      },
    );

    it(`INV-5 INV-7: a submitted claim that loses after ${boundary} closure adopts the winner without another token request`, async () => {
      const backing = memoryStorage();
      await seedDownstream(backing);
      const store = observedStore(backing, "claim submitted", () => true);
      const scope = {};
      const first = await downstreamFlow(store.storage, scope);
      const tails: Promise<unknown>[] = [];
      let coordinatorFinished = false;
      const send = vi.fn(async () => Response.json(fresh));
      const pending = auth(first.provider, {
        serverUrl: new URL(ORIGIN),
        fetchFn: first.coordinator.coordinatedFetch(first.provider, send, first.view.signal, (tail) => {
          tails.push(tail);
          void tail.then(() => {
            coordinatorFinished = true;
          });
        }),
      }).catch((error: unknown) => error);
      try {
        await store.entered;
        (boundary === "call" ? first.lease : openRequest(scope)).close();
        expect(await promptly(pending)).toMatchObject({ message: expect.stringContaining("This call has ended") });
        expect(coordinatorFinished).toBe(false);
        // Another isolate wins while the first CAS is still submitted.
        const winnerScope = {};
        const winner = await downstreamFlow(backing, winnerScope);
        expect(
          await auth(winner.provider, {
            serverUrl: new URL(ORIGIN),
            fetchFn: winner.coordinator.coordinatedFetch(winner.provider, send, winner.view.signal),
          }),
        ).toBe("AUTHORIZED");
        openRequest(winnerScope).close();
        store.release();
        await Promise.all(tails);
        expect(send).toHaveBeenCalledTimes(1);
        expect((await storedGrant(backing))!.body!.tokens).toMatchObject(fresh);
      } finally {
        store.release();
        await pending;
        await Promise.all(tails);
        openRequest(scope).close();
      }
    });

    it(`INV-5 INV-7: the coordinator keeps its own preparation deadline after claim submission and ${boundary} closure`, async () => {
      const backing = memoryStorage();
      await seedDownstream(backing);
      const store = observedStore(backing, "claim submitted", () => true);
      const scope = {};
      let pins = 0;
      const coordinator = new OAuthRefreshCoordinator(() => {
        pins++;
        return () => {
          pins--;
        };
      });
      const flow = await downstreamFlow(store.storage, scope, coordinator);
      const entered = deferred<() => void>();
      const realTimeout = globalThis.setTimeout;
      const cleared = vi.spyOn(globalThis, "clearTimeout");
      let preparationTimer: ReturnType<typeof setTimeout> | undefined;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        const timer = realTimeout(fn, ms);
        if (ms === 35_000) {
          preparationTimer = timer;
          entered.resolve(fn);
        }
        return timer;
      }) as typeof setTimeout);
      const tails: Promise<unknown>[] = [];
      const send = vi.fn(async () => Response.json(fresh));
      const pending = auth(flow.provider, {
        serverUrl: new URL(ORIGIN),
        fetchFn: coordinator.coordinatedFetch(flow.provider, send, flow.view.signal, (tail) => tails.push(tail)),
      }).catch((error: unknown) => error);
      try {
        await store.entered;
        (boundary === "call" ? flow.lease : openRequest(scope)).close();
        expect(await promptly(pending)).toMatchObject({ message: expect.stringContaining("This call has ended") });
        expect(pins).toBe(1);
        expect(preparationTimer).toBeDefined();
        expect(cleared).not.toHaveBeenCalledWith(preparationTimer);
        (await entered.promise)();
        await Promise.all(tails);
        expect(pins).toBe(0);
        expect(cleared).toHaveBeenCalledWith(preparationTimer);
        expect(send).not.toHaveBeenCalled();
        expect((await storedGrant(backing))!.body!.tokens).toEqual(old);
      } finally {
        store.release();
        await pending;
        await Promise.all(tails);
        openRequest(scope).close();
      }
    });
  }
});
