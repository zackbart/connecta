import { authenticate, authenticationSnapshot } from "../src/auth-admission.js";
import { cloudflareAccessAuth } from "../src/auth/cloudflare-access.js";
import { deferred } from "./fixtures/misc.js";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { authInvoke } from "../src/auth/native.js";
import { staticOAuth } from "../src/auth/static-oauth.js";
import { registerNativeStorage, type NativeStorage } from "../src/runtime/native-storage.js";
import { RequestScope, requestOwner } from "../src/runtime/request-scope.js";
import { openRequest } from "../src/runtime/call.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { seedGrant } from "./fixtures/oauth.js";

const ISSUER = "https://auth.example/token";
const tokens = { access_token: "native-access", token_type: "Bearer" };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native auth consumers", () => {
  it("INV-7 INV-13: composes real static OAuth under the canonical RequestScope and native storage", async () => {
    const storage = memoryStorage();
    await seedGrant(storage, { issuer: ISSUER, tokens });
    const original = { ...storage };
    const owners: Array<object | undefined> = [];
    const leaf = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (error) => error });
    const native: NativeStorage = {
      get: (key) =>
        Effect.gen(function* () {
          const owner = yield* Effect.serviceOption(RequestScope);
          owners.push(Option.isSome(owner) ? owner.value : undefined);
          return yield* leaf(() => original.get(key));
        }),
      set: (...args) => leaf(() => original.set(...args)),
      delete: (key) => leaf(() => original.delete(key)),
      list: (prefix) => leaf(() => original.list(prefix)),
      compareAndSet: (...args) => leaf(() => original.compareAndSet(...args)),
    };
    registerNativeStorage(storage, native);
    const promiseReentry = vi.fn(() => {
      throw new Error("Promise storage shell re-entered");
    });
    Object.assign(storage, {
      get: promiseReentry,
      set: promiseReentry,
      list: promiseReentry,
      delete: promiseReentry,
      compareAndSet: promiseReentry,
    });
    const requestScope = {};
    const ctx: ConnectorContext = { storage, logger, baseUrl: "https://connecta.example", requestScope };
    const hooks = staticOAuth("tickets", {
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: ISSUER,
      clientId: "assistant",
      apiOrigins: ["https://api.example"],
    });
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer native-access");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const response = await hooks.access(ctx, { write: false }).fetch("https://api.example/items", { method: "GET" });
      expect(await response.json()).toEqual({ ok: true });
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.every((owner) => owner === requestOwner(requestScope))).toBe(true);
      expect(promiseReentry).not.toHaveBeenCalled();
      openRequest(requestScope).close();
      await expect(hooks.access(ctx, { write: false }).fetch("https://api.example/items", {})).rejects.toBeDefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      openRequest(requestScope).close();
    }
  });

  it.each(["instance", "prototype", "inherited"] as const)(
    "INV-13: %s decorators can delegate to their saved original shell",
    async (kind) => {
      const storage = memoryStorage();
      await seedGrant(storage, { issuer: ISSUER, tokens });
      const provider = new KvOAuthProvider("tickets", storage, "https://connecta.example/callback");
      const view: KvOAuthProvider = kind === "inherited" ? Object.create(provider) : provider;
      const target = kind === "prototype" ? KvOAuthProvider.prototype : view;
      const original = target.tokens;
      const wrapper = vi.spyOn(target, "tokens").mockImplementation(function (this: KvOAuthProvider, context) {
        return original.call(this, context);
      });
      expect(await runEdge(authInvoke(view, "tokens", [{ issuer: ISSUER }]))).toEqual({ ...tokens, issuer: ISSUER });
      expect(wrapper).toHaveBeenCalledTimes(1);
    },
  );

  it("INV-7: a decorated native adapter retains its charge until an uncancellable identity leaf settles", async () => {
    const entered = deferred<void>();
    const identity = deferred<Record<string, unknown>>();
    const controller = new AbortController();
    const provider = cloudflareAccessAuth();
    const original = provider.authorize;
    provider.authorize = function (...args) {
      return original.apply(this, args);
    };
    const before = authenticationSnapshot().active;
    let settled = false;
    const admitted = authenticate(
      provider,
      new Request("https://connecta.example/mcp", { signal: controller.signal }),
      "https://connecta.example",
      {
        access: {
          aud: "application",
          getIdentity: () => {
            entered.resolve();
            return identity.promise;
          },
        },
      },
      logger,
      (pending) => {
        void pending.then(() => {
          settled = true;
        });
      },
    );
    await entered.promise;
    controller.abort(new Error("identity caller left"));
    expect((await admitted).admitted).toBe(true);
    expect(authenticationSnapshot().active).toBe(before + 1);
    expect(settled).toBe(false);
    identity.resolve({ email: "alice@example.com" });
    await vi.waitFor(() => expect(authenticationSnapshot().active).toBe(before));
    expect(settled).toBe(true);
  });

  it("INV-7: native storage failures remain catchable with their original identity", async () => {
    const storage = memoryStorage();
    const sentinel = { private: "native-storage-failure" };
    registerNativeStorage(storage, {
      get: () => Effect.fail(sentinel),
      set: () => Effect.void,
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      compareAndSet: () => Effect.succeed(false),
    });
    const provider = new KvOAuthProvider("tickets", storage, "https://connecta.example/callback");
    expect(
      await runEdge(
        authInvoke(provider, "tokens", [{ issuer: ISSUER }]).pipe(Effect.catch((error) => Effect.succeed(error))),
      ),
    ).toBe(sentinel);
  });
});
