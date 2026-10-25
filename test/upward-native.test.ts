import { readAgentAdmission } from "../src/agent-observation.js";
import { accessTokens } from "../src/access-tokens.js";
import { memoryStorage } from "../src/storage/memory.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { Cause, Deferred, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { authCall, authFlow, authInvoke, authMethod, registerAuth } from "../src/auth/native.js";
import {
  authorizationHandoff,
  bindAuthorizationHandoffs,
  withAuthorizationHandoff,
  withAuthorizationHandoffEffect,
} from "../src/authorization-handoff.js";
import { DiscoveryPolicyError, CatalogService } from "../src/catalog-service.js";
import type { AuthorizationHandoff, CallErrorDetails } from "../src/errors.js";
import { InvocationService } from "../src/invocation.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Caller, Credentials, Budget } from "../src/runtime/call.js";
import { RequestScope, requestOwner } from "../src/runtime/request-scope.js";
import { runEdge } from "../src/runtime/run.js";
import { agentOutputOperations, sentSecretsForRequest } from "../src/sent-secrets.js";
import { upwardStep } from "../src/upward.js";
import { createTestConnecta, makeRegistry } from "./helpers.js";
import { deferred } from "./fixtures/misc.js";
import { runUpwardBundleSmoke } from "./fixtures/upward-native-bundle.js";

const failure = (unknown = false): CallErrorDetails => ({
  code: "auth_required",
  message: "Connect crm.",
  retryable: false,
  ...(unknown ? { writeOutcome: "unknown" as const } : {}),
  nextAction: {
    tool: "authorize_connector",
    arguments: { connector: "crm" },
    operatorHandoff: "Give this handoff to the operator.",
  },
});

it("INV-4 INV-7 INV-9 INV-13: native upward dispatch preserves immutable originals and canonical ownership on both protocol leaves", async () => {
  expect(await runUpwardBundleSmoke()).toMatchObject({
    skills: true,
    registeredNames: true,
    modern: { answered: "read" },
    legacy: { answered: "write" },
    nativePromiseListings: 0,
    promiseListings: 1,
    decoratedListings: 1,
    writes: 1,
    requestOwners: 4,
    allOwnersClosed: true,
  });
});

it("INV-7 INV-13: native output composition selects programs while decorators and synchronous custom operations retain authority", async () => {
  const scope = {},
    secrets = sentSecretsForRequest(scope);
  secrets.secret("sent-secret-value");
  const native = vi.fn(() => Effect.succeed({ text: "sent-secret-value" }));
  const original = vi.fn(() => runEdge(native()));
  registerAuth(original, native);
  const operations = agentOutputOperations(() => ({ read: original }), scope);
  expect(JSON.stringify(await runEdge(authInvoke(operations, "read", [])))).not.toContain("sent-secret-value");
  expect(original).not.toHaveBeenCalled();
  const saved = operations.read;
  operations.read = vi.fn(() => saved());
  await runEdge(authInvoke(operations, "read", []));
  expect(operations.read).toHaveBeenCalledOnce();
  expect(original).not.toHaveBeenCalled();
  const owner = requestOwner(scope);
  owner.close();
  await expect(runEdge(authInvoke(operations, "read", []))).rejects.toMatchObject({ message: "The request ended." });
  expect(native).toHaveBeenCalledTimes(2);
  const synchronous = () => ({ text: "custom" });
  expect(await runEdge(authCall(synchronous, []))).toEqual({ text: "custom" });
});

it("INV-7 INV-13: typed generator adapters deliver original failures to catches without catching interruption", async () => {
  const sentinel = new DiscoveryPolicyError("invalid_args", "fixture");
  const caught = await runEdge(
    authFlow(function* () {
      try {
        yield* upwardStep(Effect.fail(sentinel));
      } catch (error) {
        return error;
      }
    }),
  );
  expect(caught).toBe(sentinel);
  const started = deferred<void>(),
    controller = new AbortController(),
    reason = { cancelled: "caller" };
  let swallowed = false;
  const exits: Exit.Exit<unknown, unknown>[] = [];
  const pending = runEdge(
    authFlow(function* () {
      try {
        started.resolve();
        yield* upwardStep(Effect.never);
      } catch {
        swallowed = true;
      }
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          exits.push(exit);
        }),
      ),
    ),
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(swallowed).toBe(false);
  expect(exits.some((exit) => Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason))).toBe(true);
});

it("INV-9 INV-13: actual native catalog policy failures reach the meta consumer as ordinary refusals", async () => {
  const mt = createMetaTools(makeRegistry([]), "https://connecta.test");
  const result = await runEdge(authInvoke(mt, "searchTools", [{ query: 4 }]));
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_args" } } });
});

it.each(["native", "decorator", "sync"] as const)(
  "INV-9 INV-13: invocation result callbacks preserve %s consumer dispatch",
  async (mode) => {
    const registry = makeRegistry([
      {
        id: "crm",
        listTools: async () => [{ name: "read", annotations: { readOnlyHint: true } }],
        callTool: async () => "reply",
      },
    ]);
    const invocation = new InvocationService(registry, new CatalogService(registry, "https://connecta.test"));
    const native = vi.fn(() => Effect.succeed({ native: true }));
    const original = vi.fn(() => runEdge(native()));
    registerAuth(original, native);
    const wrapped = vi.fn(() => original());
    const processResult = mode === "native" ? original : mode === "decorator" ? wrapped : () => ({ native: false });
    const result = await invocation.invoke("crm.read", {}, { source: "call_tool", processResult });
    expect(result).toMatchObject({ ok: true, value: { native: mode !== "sync" } });
    expect(original).toHaveBeenCalledTimes(mode === "decorator" ? 1 : 0);
    expect(wrapped).toHaveBeenCalledTimes(mode === "decorator" ? 1 : 0);
  },
);

describe("request-owned authorization handoff sharing", () => {
  it("INV-4 INV-7 INV-9: two runners share one producer, remove call services, and retain the unknown-write variant after a waiter cancels", async () => {
    const scope = {},
      owner = requestOwner(scope),
      ready = deferred<void>(),
      release = Deferred.makeUnsafe<void>();
    let factories = 0,
      physicalLinks = 0;
    const registry = makeRegistry([
      {
        id: "crm",
        listTools: async () => [],
        callTool: async () => null,
        startAuth: async () => ({ state: "auth_required", authorizationUrl: "https://auth.test" }),
      },
    ]);
    const create = authMethod((connector: string) =>
      Effect.gen(function* () {
        factories++;
        expect(yield* Effect.serviceOption(RequestScope)).toMatchObject({ _tag: "Some", value: owner });
        expect((yield* Effect.serviceOption(Caller))._tag).toBe("None");
        expect((yield* Effect.serviceOption(Credentials))._tag).toBe("None");
        expect((yield* Effect.serviceOption(Budget))._tag).toBe("None");
        ready.resolve();
        yield* Deferred.await(release);
        return yield* authCall<AuthorizationHandoff>(authorizationHandoff, [
          registry,
          "https://connecta.test",
          scope,
          {
            canManageAuth: () => true,
            oauthConnectUrl: () => {
              physicalLinks++;
              return Promise.resolve("https://connecta.test/connect/crm");
            },
          },
          { connector },
        ]);
      }),
    );
    bindAuthorizationHandoffs(scope, create);
    const controller = new AbortController(),
      reason = { left: "first waiter" };
    const first = runEdge(
      withAuthorizationHandoffEffect(scope, failure()).pipe(
        Effect.provideService(Caller, undefined),
        Effect.provideService(Budget, { charge: Effect.void }),
      ),
      { signal: controller.signal },
    );
    const firstOutcome = first.catch((error: unknown) => error);
    await ready.promise;
    const second = withAuthorizationHandoff(scope, failure(true));
    controller.abort(reason);
    expect(await firstOutcome).toBe(reason);
    await runEdge(Deferred.succeed(release, undefined));
    const unknown = await second;
    expect(unknown.instructions).toContain("re-read the target");
    const ordinary = await withAuthorizationHandoff(scope, failure());
    expect(ordinary.instructions).toContain("retry the original call");
    const shared = owner.retained.handoffs!.handoffs.get("crm")!;
    expect(await runEdge(shared)).toBe(await runEdge(shared));
    expect(factories).toBe(1);
    expect(physicalLinks).toBe(1);
    owner.close();
  });

  it.each(["native", "synchronous", "promise"] as const)(
    "INV-7 INV-13: concurrent %s factory failures settle once and retain original failure identity",
    async (mode) => {
      const scope = {},
        owner = requestOwner(scope),
        sentinel = { rejected: "factory" };
      let factories = 0;
      const create =
        mode === "native"
          ? authMethod(() => {
              factories++;
              return Effect.fail(sentinel);
            })
          : mode === "synchronous"
            ? () => {
                factories++;
                throw sentinel;
              }
            : () => {
                factories++;
                return Promise.reject(sentinel);
              };
      bindAuthorizationHandoffs(scope, create);
      const a = failure(),
        b = failure(true);
      expect(await Promise.all([withAuthorizationHandoff(scope, a), withAuthorizationHandoff(scope, b)])).toEqual([
        a,
        b,
      ]);
      expect(factories).toBe(1);
      const shared = owner.retained.handoffs!.handoffs.get("crm")!;
      await expect(runEdge(shared)).rejects.toBe(sentinel);
      expect(await withAuthorizationHandoff(scope, a)).toBe(a);
      expect(factories).toBe(1);
      owner.close();
    },
  );

  it("INV-7: closing the request interrupts the producer, removes finalizers and cannot publish or restart late handoffs", async () => {
    const scope = {},
      owner = requestOwner(scope),
      ready = deferred<void>(),
      ended = deferred<void>();
    let factories = 0,
      published = false;
    bindAuthorizationHandoffs(
      scope,
      authMethod(() =>
        Effect.gen(function* () {
          factories++;
          ready.resolve();
          yield* Effect.never;
          published = true;
          return {} as AuthorizationHandoff;
        }).pipe(Effect.ensuring(Effect.sync(() => ended.resolve()))),
      ),
    );
    const original = failure(),
      pending = withAuthorizationHandoff(scope, original);
    await ready.promise;
    owner.close();
    await ended.promise;
    expect(await pending).toBe(original);
    expect(await withAuthorizationHandoff(scope, original)).toBe(original);
    expect(owner.finalizers).toHaveLength(0);
    expect(factories).toBe(1);
    expect(published).toBe(false);
  });
});

it("INV-4 INV-7: frozen agent observation follows scope admission and precedes body dispatch even when the exchange fails", async () => {
  const storage = memoryStorage();
  const app = createTestConnecta({
    storage,
    publicUrl: "https://connecta.test",
    logger: "silent",
    agents: ["assistant"],
    accessTokens: accessTokens(storage),
    connectors: [{ id: "crm", listTools: async () => [], callTool: async () => null }],
    pools: { trusted: { tools: ["crm"], members: ["agent:assistant"] } },
  });
  const token = await issueAgentToken(storage, "assistant");
  const request = (path: string, bearer: string, body = "{") =>
    new Request(`https://connecta.test${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body,
    });
  try {
    for (const [path, bearer, status] of [
      ["/agent/trusted", "cta_invalid", 401],
      ["/agent/missing", token, 404],
      ["/mcp", token, 401],
    ] as const) {
      const response = await app.fetch(request(path, bearer));
      expect(response.status).toBe(status);
      await response.text();
      expect(await runEdge(readAgentAdmission(storage, "assistant"))).toBeNull();
    }
    let observedBeforeRead: string | null = null;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(new TextEncoder().encode("{"));
            return;
          }
          observedBeforeRead = await runEdge(readAgentAdmission(storage, "assistant"));
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const init = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body,
      duplex: "half",
    } as RequestInit;
    const response = await app.fetch(new Request("https://connecta.test/agent/trusted", init));
    expect(response.status).toBe(400);
    await response.text();
    expect(observedBeforeRead).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await runEdge(readAgentAdmission(storage, "assistant"))).toBe(observedBeforeRead);
  } finally {
    await app.close();
  }
});
