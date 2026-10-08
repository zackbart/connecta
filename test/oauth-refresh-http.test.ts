import { UnauthorizedError } from "@modelcontextprotocol/client";
import { describe, expect, inject, it, onTestFinished, vi } from "vitest";
import { KvOAuthProvider, OAuthRefreshCoordinator, oauthStateDigest } from "../src/auth/downstream-oauth.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthRefreshKeys, scopes } from "../src/storage/keys.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";
import { api } from "../src/connectors/api.js";
import { createTestConnecta } from "./helpers.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";

const ISSUER = "https://issuer.example";
const tokens = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const next = { access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" };
const init = () => ({ method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }) });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function store(delayed: boolean): KVStorage {
  const backing = memoryStorage();
  const hop = <Args extends unknown[], R>(op: (...args: Args) => Promise<R>) => async (...args: Args): Promise<R> => {
    if (delayed) await pause();
    const answer = await op(...args);
    if (delayed) await pause();
    return answer;
  };
  return { get: hop(backing.get), set: hop(backing.set), delete: hop(backing.delete), list: hop(backing.list), compareAndSet: hop(backing.compareAndSet) };
}
async function isolate(storage: KVStorage, coordinator = new OAuthRefreshCoordinator()) {
  const provider = new KvOAuthProvider("svc", storage, "https://connecta.test/oauth/callback/svc", coordinator, false);
  await provider.beginFlow();
  await provider.tokens({ issuer: ISSUER });
  return {
    provider, coordinator,
    refresh: (url: string, signal?: AbortSignal, defer?: ConnectorContext["defer"], bodySignal?: AbortSignal) =>
      coordinator.coordinatedFetch(provider, async (input, request) => {
        const response = await fetch(input, request);
        if (!response.headers.has("x-test-buffer-body")) return response;
        // workerd's native JS reader emits a second rejection for a broken TCP
        // body. Read this tiny fixture body with the native Body API and carry
        // its loss into the bounded reader as an errored Response stream.
        try {
          return new Response(await response.text(), { status: response.status });
        } catch {
          return new Response(new ReadableStream({ start(controller) {
            controller.error(new Error("HTTP response body lost"));
          } }), { status: response.status });
        }
      }, signal, defer)(url, { ...init(), ...(bodySignal ? { signal: bodySignal } : {}) }),
  };
}
async function tokenServer(mode: string) {
  const base = inject("oauthHttpServer");
  const { id } = await (await fetch(`${base}/new`, { method: "POST", body: mode })).json() as { id: string };
  const finish = async () => { await (await fetch(`${base}/session/${id}/finish`, { method: "POST" })).text(); };
  onTestFinished(finish);
  return {
    url: `${base}/session/${id}/token`, finish,
    sent: async () => (await (await fetch(`${base}/session/${id}`)).json() as { redeemed: string[] }).redeemed,
  };
}

describe.each([["memory", false], ["delayed", true]] as const)("native HTTP refresh on %s storage", (_label, delayed) => {
  it.each([
    [false, "caller"], [true, "caller"], [false, "sdk"], [true, "sdk"], [false, "both"], [true, "both"],
  ] as const)("commits after dispatch cancellation without replay, runtime hook %s, signal %s (INV-5) (INV-7)", async (runtimeHook, cancelled) => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const a = await isolate(storage);
    const local = await isolate(storage, a.coordinator);
    const b = await isolate(storage);
    const newcomer = await isolate(storage);
    const server = await tokenServer("success");
    const owner = new AbortController();
    const sdk = new AbortController();
    const tails: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { tails.push(promise); });
    const first = a.refresh(server.url, owner.signal, runtimeHook ? waitUntil : undefined, sdk.signal).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await server.sent()).toEqual([tokens.refresh_token]));
    const joined = local.refresh(server.url);
    const second = b.refresh(server.url);
    const reason = new DOMException("Owner request ended", "AbortError");
    if (cancelled !== "sdk") owner.abort(reason);
    if (cancelled !== "caller") sdk.abort(reason);
    expect(await first).toBe(reason);
    if (runtimeHook) expect(waitUntil).toHaveBeenCalledTimes(1);
    const late = newcomer.refresh(server.url);
    expect(await server.sent()).toEqual([tokens.refresh_token]);
    await server.finish();
    for (const answer of await Promise.all([joined, second, late])) expect(await answer.json()).toEqual(next);
    await Promise.all(tails);
    expect((await storedGrant(storage))!.body!.tokens).toMatchObject(next);
    // A stale isolate also reads the committed tokens without another send.
    expect(await (await b.refresh(server.url)).json()).toEqual(next);
    expect(await server.sent()).toEqual([tokens.refresh_token]);
  });

  it.each(["lost", "body-lost", "malformed-success", "failure-with-tokens"])("permanently refuses %s after send across isolates and newcomer reads (INV-5)", async (mode) => {
    const storage = store(delayed);
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const key = oauthRefreshKeys.lease((await storedGrant(storage))!.epoch, await oauthStateDigest(tokens.refresh_token));
    const a = await isolate(storage);
    const b = await isolate(storage);
    const local = await isolate(storage, a.coordinator);
    const server = await tokenServer(mode);
    const first = a.refresh(server.url).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await server.sent()).toEqual([tokens.refresh_token]));
    const joined = local.refresh(server.url).catch((error: unknown) => error);
    const second = b.refresh(server.url).catch((error: unknown) => error);
    await server.finish();
    expect(await first).toBeInstanceOf(UnauthorizedError);
    for (const outcome of await Promise.all([joined, second])) {
      if (outcome instanceof Response) expect(await outcome.json()).toMatchObject({ error: "invalid_grant" });
      else expect(outcome).toBeInstanceOf(UnauthorizedError);
    }
    expect(a.provider.refreshVerdict()).toEqual({ kind: "dead" });
    await expect(a.provider.state()).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
    const refused = (await storage.get(key))!;
    expect(JSON.parse(refused)).toMatchObject({ state: "dispatched", verdict: { kind: "dead" } });
    // Reinserting that fingerprint in the same epoch cannot clear its refusal.
    for (let attempt = 0; attempt < 3; attempt++) {
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const newcomer = await isolate(storage);
      await expect(newcomer.refresh(server.url)).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(newcomer.provider.state()).rejects.toBeInstanceOf(UnauthorizedError);
      expect((await storedGrant(storage))!.body!.tokens).toBeUndefined();
      expect(await storage.get(key)).toBe(refused);
    }
    expect(await server.sent()).toEqual([tokens.refresh_token]);
  });
});


it.each(["call_tool", "execute_code"])("threads Workers waitUntil through %s to an API refresh commit after caller cancellation (INV-5) (INV-7)", async (route) => {
  const server = await tokenServer("success");
  const storage = memoryStorage();
  const endpoint = `${ISSUER}/token`;
  const namespace = scopes.connector("svc");
  await seedGrant(storage, { issuer: endpoint, tokens }, "v3:seeded", namespace);
  const nativeFetch = fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, request?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === endpoint) return nativeFetch(server.url, request);
    if (url === "https://api.example/resource") {
      return Promise.resolve(new Headers(request?.headers).get("authorization") === "Bearer new-access"
        ? Response.json({ ok: true }) : new Response(null, { status: 401 }));
    }
    return nativeFetch(input, request);
  });
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const connector = () => api("svc", {
    oauth: { authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: endpoint, clientId: "client", apiOrigins: ["https://api.example"] },
    tools: [{ name: "read", description: "Read a resource", annotations: { readOnlyHint: true },
      handler: async (_args, ctx) => (await ctx.oauth!.fetch("https://api.example/resource")).json(),
    }],
  });
  const app = () => createTestConnecta({ connectors: [connector()], storage, publicUrl: "https://connecta.test", logger: "silent",
    executor: { execute: async (_code, providers) => ({ result: await providers.find((provider) => provider.name === "connecta")!.fns.call!("svc.read", {}) }) },
  });
  const a = app();
  const b = app();
  onTestFinished(async () => { await a.close(); await b.close(); });
  const owner = new AbortController();
  const tails: Promise<unknown>[] = [];
  const runtimeContext = { waitUntil(promise: Promise<unknown>) { tails.push(promise); } };
  const params = route === "call_tool" ? { name: route, arguments: { address: "svc.read", args: {} } }
    : { name: route, arguments: { code: 'return await connecta.call("svc.read", {});' } };
  const first = mcpRpc(a, "tools/call", params, { signal: owner.signal, runtimeContext }).catch((error: unknown) => error);
  await vi.waitFor(async () => expect(await server.sent()).toEqual([tokens.refresh_token]));
  owner.abort(new DOMException("Caller left", "AbortError"));
  await first;
  expect(tails.length).toBeGreaterThan(0);
  const second = mcpRpc(b, "tools/call", { name: "call_tool", arguments: { address: "svc.read", args: {} } }, { runtimeContext });
  await server.finish();
  expect((await readJsonRpc(await second)).result.isError).not.toBe(true);
  await Promise.all(tails);
  expect((await storedGrant(storage, namespace))!.body!.tokens).toMatchObject(next);
  expect(await server.sent()).toEqual([tokens.refresh_token]);
});
