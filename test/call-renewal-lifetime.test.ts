import { auth } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator } from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
import { providerRequests, tracksEveryRequest } from "../src/provider-call.js";
import { callFromContext, contextView, openRequest, viewLease } from "../src/runtime/call.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  oauthGrantKeys,
  oauthRefreshActiveKeys,
  oauthRefreshKeys,
  oauthRefreshSpentKeys,
  scopes,
} from "../src/storage/keys.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";
import { makeRegistry } from "./helpers.js";
import { deferred } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";

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
  "claimed read",
  "liveness reply",
  "dispatch reply",
  "spent write",
  "spent reply",
  "dispatched",
] as const;
type Phase = (typeof phases)[number];

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
      // A submitted CAS cannot be retracted through KVStorage. Holding it
      // before its commit separately proves the one unavoidable late write.
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

afterEach(() => vi.unstubAllGlobals());

describe("production OAuth renewal ownership", () => {
  for (const boundary of ["call", "request"] as const) {
    for (const method of ["GET", "POST"] as const) {
      it.each(phases)(
        `INV-7 INV-9: api OAuth ${method} closed at the ${boundary} during %s refuses without consuming renewal`,
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
                    const pending = ctx.oauth!.fetch(`${ORIGIN}/notes`, { method });
                    renewal = pending.catch((error: unknown) => error);
                    await pending;
                    return { ok: true };
                  },
                },
              ],
            }),
          );
          const scope = {};
          const tools = createMetaTools(makeRegistry([connector], { storage: store.storage }), BASE, {
            requestScope: scope,
            defer: (tail) => tails.push(tail),
          });
          const call =
            method === "GET"
              ? tools.callTool({ address: "tickets.run" })
              : tools.callDestructiveTool({ address: "tickets.run" });
          try {
            await (phase === "dispatched" ? dispatched.promise : store.entered);
            if (phase === "grant read" || phase === "coordinator read") expect(store.writes).toEqual([]);
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
            } else {
              expect(tokens).toBe(0);
              expect(store.writes).toHaveLength(writesAtClose);
              expect(await snapshot(backing)).toEqual(before);
            }
            // Release only after the closed caller has failed. The late answer
            // belongs to the coordinator; it cannot renew this call's ledger.
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
            expect(tokens).toBe(phase === "dispatched" ? 1 : 0);
            if (phase === "dispatched") {
              expect((await storedGrant(backing, namespace))!.body!.tokens).toMatchObject(fresh);
              const spent = await backing.list(`${namespace}${oauthRefreshSpentKeys.family.prefixes[0]}`);
              expect(spent).toHaveLength(1);
              expect(JSON.parse((await backing.get(spent[0]!))!)).toMatchObject({ state: "resolved" });
            } else {
              expect((await storedGrant(backing, namespace))!.body!.tokens).toEqual(old);
              expect(store.writes).toHaveLength(writesAtClose);
              const after = await snapshot(backing);
              if (phase === "spent write") {
                const spent = Object.keys(after).filter((key) => !(key in before));
                expect(spent).toHaveLength(1);
                expect(spent[0]).toContain(oauthRefreshSpentKeys.family.prefixes[0]);
                expect(JSON.parse(after[spent[0]!]!)).toMatchObject({ state: "outstanding" });
                delete after[spent[0]!];
              }
              expect(after).toEqual(before);
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

    it.each(phases)(
      `INV-5 INV-7: downstream OAuth SDK grant closed at the ${boundary} during %s keeps coordinator ownership`,
      async (phase) => {
        const backing = memoryStorage();
        await seedGrant(backing, {
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
        let running = false;
        const store = observedStore(backing, phase, () => running);
        const scope = {};
        const operation: ConnectorContext = {
          storage: store.storage,
          baseUrl: BASE,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          requestScope: scope,
        };
        const lease = callFromContext(operation, "read");
        const view = contextView(lease, operation);
        const coordinator = new OAuthRefreshCoordinator();
        const provider = new KvOAuthProvider(
          "tickets",
          store.storage,
          `${BASE}/oauth/callback/tickets`,
          coordinator,
          false,
          undefined,
          view.signal,
        );
        await provider.beginFlow();
        await provider.tokens({ issuer: ORIGIN });
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
          if (phase === "grant read" || phase === "coordinator read") expect(store.writes).toEqual([]);
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
          if (phase === "dispatched") {
            expect((await storedGrant(backing))!.body!.tokens).toMatchObject(fresh);
            const spent = await backing.list(oauthRefreshSpentKeys.family.prefixes[0]);
            expect(spent).toHaveLength(1);
            expect(JSON.parse((await backing.get(spent[0]!))!)).toMatchObject({ state: "resolved" });
          } else {
            expect((await storedGrant(backing))!.body!.tokens).toEqual(old);
            expect(store.writes).toHaveLength(writesAtClose);
            const after = await snapshot(backing);
            if (phase === "spent write") {
              const spent = Object.keys(after).filter((key) => !(key in before));
              expect(spent).toHaveLength(1);
              expect(spent[0]).toContain(oauthRefreshSpentKeys.family.prefixes[0]);
              expect(JSON.parse(after[spent[0]!]!)).toMatchObject({ state: "outstanding" });
              delete after[spent[0]!];
            }
            expect(after).toEqual(before);
          }
          expect(send).toHaveBeenCalledTimes(phase === "dispatched" ? 1 : 0);
        } finally {
          store.release();
          response.resolve(Response.json(fresh));
          await pending;
          await Promise.all(tails);
          openRequest(scope).close();
        }
      },
    );
  }
});
