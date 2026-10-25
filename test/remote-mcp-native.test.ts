import { Cause, Context, Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authCall, authInvoke, authMethod } from "../src/auth/native.js";
import { catalogClientOptions, closeCatalogCacheScope } from "../src/catalog-cache.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { deriveContext } from "../src/derived-context.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { callEntry } from "../src/runtime/call-entry.js";
import { callFromContext, contextView, openRequest, viewServices } from "../src/runtime/call.js";
import { registerNativeStorage, type NativeStorage } from "../src/runtime/native-storage.js";
import { RequestScope, requestOwner } from "../src/runtime/request-scope.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, KVStorage } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, deferred } from "./fixtures/misc.js";
import { makeRegistry } from "./helpers.js";

const BASE = "https://connecta.test";
afterEach(() => vi.unstubAllGlobals());

function downstream(handler = async () => ({ content: [{ type: "text" as const, text: "received" }] })) {
  const calls = vi.fn(handler);
  const fixture = httpDownstream((server) => {
    server.registerTool("read", { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, calls);
  });
  return { connector: remoteMcp("crm", { url: fixture.url, _transportFactory: fixture.transport }), calls };
}

function nativeCall(connector: Connector) {
  const registry = makeRegistry([connector]);
  const scope = {};
  const operation = registry.contextFor("crm", BASE, scope);
  const lease = callFromContext(operation, "read", { admitted: true });
  const view = contextView(lease, operation);
  const entry = callEntry(connector, connector.callTool);
  expect(entry).toBeDefined();
  return {
    view,
    run: (options?: Parameters<Connector["callTool"]>[3]) =>
      entry!("read", {}, options).pipe(Effect.provideContext(viewServices(view))),
    close: () => {
      lease.close();
      openRequest(scope).close();
    },
  };
}

describe("native remote MCP entry", () => {
  it.each(["native", "decorated", "inherited", "replacement"] as const)(
    "INV-4 INV-7 INV-13: %s dispatch keeps saved-original delegation and custom replacement authority",
    async (mode) => {
      const { connector, calls } = downstream();
      const saved = connector.callTool;
      const wrapper = vi.fn<Connector["callTool"]>((...args) => saved(...args));
      let current = connector;
      if (mode === "decorated") connector.callTool = wrapper;
      if (mode === "inherited") {
        current = Object.create(connector) as Connector;
        current.callTool = wrapper;
      }
      if (mode === "replacement")
        connector.callTool = vi.fn(async () => ({ content: [{ type: "text", text: "custom" }] }));
      expect(callEntry(current, current.callTool) !== undefined).toBe(mode === "native");
      const result = await createMetaTools(makeRegistry([current]), BASE).callTool({ address: "crm.read" });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain(mode === "replacement" ? "custom" : "received");
      expect(calls).toHaveBeenCalledTimes(mode === "replacement" ? 0 : 1);
      expect(wrapper).toHaveBeenCalledTimes(mode === "decorated" || mode === "inherited" ? 1 : 0);
    },
  );

  it("INV-9 INV-13: native validation and policy failures are typed, preserve identity and send no tool call", async () => {
    const { connector, calls } = downstream();
    const native = nativeCall(connector);
    const sentinel = new ConnectorCallError("invalid_args", "Fixture policy refused before dispatch.");
    const options = Object.defineProperty({}, "definition", {
      get: () => {
        throw sentinel;
      },
    });
    try {
      const failure = await runEdge(Effect.result(native.run(options)));
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect(failure.failure).toBe(sentinel);
      const unsupported = await runEdge(
        Effect.result(native.run({ definition: { name: "read", execution: { taskSupport: "required" } } })),
      );
      expect(unsupported._tag).toBe("Failure");
      if (unsupported._tag === "Failure") expect(unsupported.failure).toMatchObject({ code: "connector_call_failed" });
      expect(calls).not.toHaveBeenCalled();
      await runEdge(native.run({ definition: { name: "read", annotations: { readOnlyHint: true } } }));
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      native.close();
    }
  });

  it("INV-7 INV-13: runner interruption stays interruption and retains the original abort reason", async () => {
    const ready = deferred<void>(),
      release = deferred<void>();
    const { connector } = downstream(async () => {
      ready.resolve();
      await release.promise;
      return { content: [] };
    });
    const native = nativeCall(connector),
      interrupt = new AbortController();
    const exits: Exit.Exit<unknown, unknown>[] = [];
    const pending = runEdge(
      native.run().pipe(
        Effect.result,
        Effect.onExit((exit) =>
          Effect.sync(() => {
            exits.push(exit);
          }),
        ),
      ),
      { signal: interrupt.signal },
    );
    try {
      await ready.promise;
      const reason = { source: "caller interrupt" };
      interrupt.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(exits).toHaveLength(1);
      const exit = exits[0]!;
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
      }
    } finally {
      release.resolve();
      native.close();
    }
  });
});

function nativeStore(owner: object) {
  const backing = memoryStorage();
  const shell = Object.fromEntries(
    ["get", "set", "delete", "list", "compareAndSet"].map((key) => [
      key,
      vi.fn(() => {
        throw new Error(`Promise storage shell called: ${key}`);
      }),
    ]),
  ) as unknown as KVStorage;
  Object.defineProperty(shell, "capabilities", { value: backing.capabilities });
  const observed: object[] = [];
  const operation = <A>(run: () => Promise<A>) =>
    Effect.gen(function* () {
      const maybe = yield* Effect.serviceOption(RequestScope);
      expect(maybe._tag).toBe("Some");
      if (maybe._tag !== "Some") throw new Error("Missing request scope");
      const request = maybe.value;
      observed.push(request.identity);
      expect(request).toBe(requestOwner(owner));
      return yield* Effect.tryPromise({ try: run, catch: (error) => error });
    });
  const native: NativeStorage = {
    get: (key) => operation(() => backing.get(key)),
    set: (key, value, opts) => operation(() => backing.set(key, value, opts)),
    delete: (key) => operation(() => backing.delete(key)),
    list: (key) => operation(() => backing.list(key)),
    compareAndSet: (key, expected, next, opts) => operation(() => backing.compareAndSet(key, expected, next, opts)),
  };
  registerNativeStorage(shell, native);
  return { shell, backing, observed };
}

it("INV-5 INV-7 INV-8 INV-13: SDK cache programs use native storage and the canonical request owner through a derived view", async () => {
  const owner = {},
    { shell, observed } = nativeStore(owner);
  const ctx = deriveContext({ ...connectorContext(shell), requestScope: owner }, {});
  const cacheOwner = {};
  const program = Effect.gen(function* () {
    const cache = yield* authCall<Awaited<ReturnType<typeof catalogClientOptions>>>(catalogClientOptions, [
      ctx,
      "crm",
      "fixture",
      "grant",
      undefined,
      cacheOwner,
    ]);
    const key = { method: "tools/list", partition: JSON.stringify(["server", cache.cachePartition]) };
    return yield* authInvoke(cache, "withListing", [
      ctx,
      authMethod(() =>
        Effect.gen(function* () {
          const result = {
            tools: [{ name: "read", inputSchema: { type: "object" } }],
            ttlMs: 60000,
            cacheScope: "private",
          };
          yield* authInvoke(cache.responseCacheStore, "set", [
            key,
            { value: JSON.stringify(result), expiresAt: Date.now() + 60000 },
          ]);
          const entry = yield* authInvoke<{ value: string }>(cache.responseCacheStore, "get", [key]);
          const refresh = yield* authInvoke(cache, "completeCatalogRefresh", [result]);
          expect(JSON.parse(entry.value)).toMatchObject({ tools: [{ name: "read" }] });
          expect(refresh).toMatchObject({ connectorId: "crm", private: true });
          return true;
        }),
      ),
    ]);
  }).pipe(Effect.provideContext(viewServices(ctx)));
  try {
    expect(Context.get(viewServices(ctx), RequestScope)).toBe(requestOwner(owner));
    expect(await runEdge(program)).toBe(true);
    expect(observed.length).toBeGreaterThan(8);
    for (const method of [shell.get, shell.set, shell.delete, shell.list, shell.compareAndSet])
      expect(method).not.toHaveBeenCalled();
  } finally {
    closeCatalogCacheScope(ctx, "crm", cacheOwner);
    openRequest(owner).close();
  }
});

it("INV-7 INV-8: cancelling a queued native listing never unlocks an active listing or publishes after closure", async () => {
  const owner = {},
    ctx: ConnectorContext = { ...connectorContext(), requestScope: owner };
  const cache = await catalogClientOptions(ctx, "crm", "queue", "grant");
  const entered = deferred<void>(),
    release = deferred<void>(),
    third = vi.fn(async () => true);
  const active = cache.withListing(ctx, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  await entered.promise;
  const abort = new AbortController();
  const queued = runEdge(
    authInvoke(cache, "withListing", [ctx, authMethod(() => Effect.die("cancelled waiter ran"))]),
    { signal: abort.signal },
  );
  const rejected = expect(queued).rejects.toBe("queued caller left");
  abort.abort("queued caller left");
  await rejected;
  const next = cache.withListing(ctx, third);
  await Promise.resolve();
  expect(third).not.toHaveBeenCalled();
  release.resolve();
  expect(await active).toBe(true);
  expect(await next).toBe(true);
  expect(third).toHaveBeenCalledTimes(1);
  openRequest(owner).close();
  await expect(cache.withListing(ctx, async () => true)).rejects.toThrow(/scope ended/);
});
