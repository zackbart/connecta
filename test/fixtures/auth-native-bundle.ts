import { Effect } from "effect";
import { withAuthenticationDeadline } from "../../src/auth-admission.js";
import { KvOAuthProvider } from "../../src/auth/downstream-oauth.js";
import { authCall, authInvoke, authMethod, hasAuthProgram } from "../../src/auth/native.js";
import { staticOAuth } from "../../src/auth/static-oauth.js";
import { openRequest } from "../../src/runtime/call.js";
import { registerNativeStorage, type NativeStorage } from "../../src/runtime/native-storage.js";
import { RequestScope, requestOwner } from "../../src/runtime/request-scope.js";
import { runEdge } from "../../src/runtime/run.js";
import { oauthGrantKeys } from "../../src/storage/keys.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { ConnectorContext } from "../../src/types.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Executed only from the production-minified bundle, without source imports. */
export async function runAuthBundleSmoke() {
  const issuer = "https://auth.example/token";
  const tokens = { access_token: "bundle-access", token_type: "Bearer" };
  const storage = memoryStorage();
  await storage.set(oauthGrantKeys.grant, JSON.stringify({ connectaOAuth: 3, epoch: "v3:bundle", body: { issuer, tokens } }));
  const original = { ...storage };
  const owners: Array<object | undefined> = [];
  const leaf = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error });
  const native: NativeStorage = {
    get: (key) => Effect.gen(function* () {
      const owner = yield* Effect.serviceOption(RequestScope);
      owners.push(owner._tag === "Some" ? owner.value : undefined);
      return yield* leaf(() => original.get(key));
    }),
    set: (...args) => leaf(() => original.set(...args)),
    delete: (key) => leaf(() => original.delete(key)),
    list: (prefix) => leaf(() => original.list(prefix)),
    compareAndSet: (...args) => leaf(() => original.compareAndSet(...args)),
  };
  registerNativeStorage(storage, native);
  let promiseStorageCalls = 0;
  const poisoned = () => { promiseStorageCalls++; throw new Error("Promise storage shell reentered"); };
  Object.assign(storage, { get: poisoned, set: poisoned, delete: poisoned, list: poisoned, compareAndSet: poisoned });
  const requestScope = {};
  const request = openRequest(requestScope);
  const owner = requestOwner(requestScope);
  check(owner, "canonical owner missing");
  check(hasAuthProgram(withAuthenticationDeadline), "pure top-level native registration removed");
  const observed = await runEdge(authCall(withAuthenticationDeadline, [
    new Request("https://connecta.example/mcp"),
    authMethod(() => Effect.map(Effect.serviceOption(RequestScope), (value) => value._tag === "Some" ? value.value : undefined)),
  ]).pipe(Effect.provideService(RequestScope, owner)));
  check(observed === owner, "top-level dispatch reentered a Promise shell and lost Context");

  const ctx: ConnectorContext = {
    storage, requestScope, baseUrl: "https://connecta.example",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const hooks = staticOAuth("tickets", {
    authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: issuer,
    clientId: "assistant", apiOrigins: ["https://api.example"],
  });
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (_input, init) => {
    fetches++;
    check(new Headers(init?.headers).get("authorization") === "Bearer bundle-access", "native grant not applied");
    return Response.json({ ok: true });
  };
  const decorators: string[] = [];
  try {
    const response = await hooks.access(ctx, { write: false }).fetch("https://api.example/items");
    check((await response.json() as { ok: boolean }).ok, "resource request failed");
    check(owners.length > 0 && owners.every(value => value === owner), "real native storage lost RequestScope");
    check(promiseStorageCalls === 0, "native storage identity dispatch removed");
    request.close();
    let refused = false;
    try { await hooks.access(ctx, { write: false }).fetch("https://api.example/items"); }
    catch { refused = true; }
    check(refused && fetches === 1, "closed request retained resource authority");

    for (const kind of ["instance", "prototype", "inherited"] as const) {
      const provider = new KvOAuthProvider("tickets", storage, "https://connecta.example/callback");
      const view: KvOAuthProvider = kind === "inherited" ? Object.create(provider) : provider;
      const target = kind === "prototype" ? KvOAuthProvider.prototype : view;
      const descriptor = Object.getOwnPropertyDescriptor(target, "tokens");
      const saved = target.tokens;
      let calls = 0;
      target.tokens = function (...args) { calls++; return saved.apply(this, args); };
      try {
        const answer = await runEdge(authInvoke<{ access_token: string }>(view, "tokens", [{ issuer }]));
        check(answer.access_token === tokens.access_token && calls === 1, `${kind} saved-original delegation failed`);
        decorators.push(kind);
      } finally {
        if (descriptor) Object.defineProperty(target, "tokens", descriptor);
        else Reflect.deleteProperty(target, "tokens");
      }
    }
    const custom = new KvOAuthProvider("tickets", storage, "https://connecta.example/callback");
    const customTokens = { access_token: "custom-access", token_type: "Bearer" };
    let customCalls = 0;
    custom.tokens = async () => { customCalls++; return customTokens; };
    check(await runEdge(authInvoke(custom, "tokens", [{ issuer }])) === customTokens && customCalls === 1,
      "custom override bypassed by native identity dispatch");
    check(promiseStorageCalls === 0, "decorated original reentered Promise storage");
    return { topLevelRegistration: true, canonicalRequestScope: true, nativeStorageReads: owners.length,
      promiseStorageCalls, fetches, closedOwnerRefused: true, decorators, customCalls };
  } finally {
    request.close();
    globalThis.fetch = savedFetch;
  }
}
