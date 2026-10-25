import { Context, Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chargeConnectorCall } from "../src/call-admission-context.js";
import { callClassification } from "../src/call-classification.js";
import { recordRecovery } from "../src/call-recovery.js";
import { callerOf } from "../src/connector-caller.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { authorizingContext } from "../src/auth/downstream-oauth.js";
import { deriveContext } from "../src/derived-context.js";
import { ConnectorCallError } from "../src/errors.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { createMetaTools } from "../src/meta-tools.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import {
  Budget,
  Classification,
  Credentials,
  Recovery,
  Signal,
  callFromContext,
  contextView,
  openRequest,
  serviceFor,
  viewServices,
  type CallLease,
} from "../src/runtime/call.js";
import { CatalogService } from "../src/catalog-service.js";
import { InvocationService } from "../src/invocation.js";
import { read } from "../src/http/tools.js";
import { resultSafety } from "../src/http/safety.js";
import { errors as tithelyErrors } from "../src/providers/tithely/api.js";
import { RequestScope, requestOwner } from "../src/runtime/request-scope.js";
import { getNativeStorage } from "../src/runtime/native-storage.js";
import { Storage } from "../src/runtime/services.js";
import { storageGet, storageSet, storageDelete, storageList, storageCompareAndSet } from "../src/runtime/storage.js";
import { registryProgram } from "../src/runtime/registry.js";
import { SharedRead } from "../src/runtime/shared-read.js";
import { authRecoveryFacts, recordAuthFailure, recordCallEntry } from "../src/invocation-auth.js";
import { recordedService } from "../src/runtime/call.js";
import { sentSecretsForRequest } from "../src/sent-secrets.js";
import * as runner from "../src/runtime/run.js";
import { callEntry } from "../src/runtime/call-entry.js";
import { runEdge } from "../src/runtime/run.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { makeRegistry, required } from "./helpers.js";
import type { ConnectorContext } from "../src/types.js";

const BASE = "https://connecta.example";
afterEach(() => vi.unstubAllGlobals());
function fixture(handler: (ctx: ConnectorContext) => Promise<unknown>, credential = false) {
  return api("crm", {
    ...(credential ? { credential: { label: "Token" } } : {}),
    tools: [
      {
        name: "run",
        description: "Read a record.",
        annotations: { readOnlyHint: true },
        handler: (_, ctx) => handler(ctx),
      },
    ],
  });
}

describe("live call services (B.1)", () => {
  it(
    "INV-7: a service and Promise view kept past invocation refuse credentials and charge, and drop late recovery",
    WORKERS,
    async () => {
      let view!: ConnectorContext;
      let services!: ReturnType<typeof viewServices>;
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, CREDENTIAL_KEY);
      await vault.set("crm", "call-services-secret-123", "alice");
      const registry = makeRegistry(
        [
          fixture(async (ctx) => {
            view = ctx;
            services = viewServices(ctx);
            return {};
          }, true),
        ],
        { storage, credentialVault: vault },
      );
      await createMetaTools(registry, BASE).callTool({ address: "crm.run" });
      await expect(runEdge(Context.get(services, Credentials).values)).rejects.toThrow(/call has ended/);
      await expect(runEdge(Context.get(services, Budget).charge)).rejects.toThrow(/call has ended/);
      await expect(view.credential!.getAll()).rejects.toThrow(/call has ended/);
      await expect(chargeConnectorCall(deriveContext(view, {}))).rejects.toThrow(/call has ended/);
      expect(() => recordRecovery(view, { idempotencyKey: "late" })).not.toThrow();
      await runEdge(Context.get(services, Recovery).record({ idempotencyKey: "late" }));
      expect(serviceFor(view, Signal)?.aborted).toBe(true);
    },
  );

  it.each(["call", "request"] as const)(
    "INV-7: closing the %s promptly settles paused credentials and budget through a registry view",
    WORKERS,
    async (boundary) => {
      let lease!: CallLease;
      let view!: ConnectorContext;
      const seen: AbortSignal[] = [];
      const scope = {};
      const paused = (signal: AbortSignal) => {
        seen.push(signal);
        return new Promise<never>(() => {});
      };
      const registry = makeRegistry([fixture(async () => ({}))]);
      const operation = registry.contextFor("crm", BASE, scope);
      lease = callFromContext(operation, "read", { credentials: paused, charge: paused });
      view = contextView(
        lease,
        deriveContext(operation, { credential: { get: async () => null, getAll: async () => null } }),
      );
      const credentials = view.credential!.getAll().catch((error: unknown) => error);
      const budget = chargeConnectorCall(view).catch((error: unknown) => error);
      expect(seen).toHaveLength(2);
      (boundary === "call" ? lease : openRequest(scope)).close();
      for (const result of await Promise.all([credentials, budget]))
        expect(result).toMatchObject({ code: "connector_call_failed" });
      expect(seen.every((signal) => signal.aborted)).toBe(true);
    },
  );

  it(
    "INV-4 INV-10: discovery, status and startAuth views carry each scoped pool's caller; a spread carries none",
    NODE,
    async () => {
      const seen: Array<[string, string | undefined, string | undefined]> = [];
      const observe = (operation: string, ctx: ConnectorContext) => {
        seen.push([operation, callerOf(ctx)?.identity.actor.id, callerOf(ctx)?.pool]);
        expect(callerOf({ ...ctx })).toBeUndefined();
      };
      const connector = {
        id: "crm",
        kind: "api" as const,
        listTools: async (ctx: ConnectorContext) => {
          observe("discovery", deriveContext(ctx, {}));
          return [];
        },
        status: async (ctx: ConnectorContext) => {
          observe("status", ctx);
          return { state: "ok" as const };
        },
        startAuth: async (ctx: ConnectorContext) => {
          observe("startAuth", authorizingContext(ctx));
          return { state: "ok" as const };
        },
        callTool: async () => ({}),
      };
      const registry = makeRegistry([connector]);
      for (const [id, pool] of [
        ["alice", "crm"],
        ["bob", "tickets"],
      ] as const) {
        const view = registry.scoped({
          connectorIds: ["crm"],
          caller: {
            authenticated: true,
            identity: { actor: { kind: "human", id, namespace: "test" }, interactive: true },
            pool,
          },
        });
        const scope = {};
        await view.getTools("crm", BASE, scope);
        await view.statusFor("crm", BASE, scope);
        await connector.startAuth(view.contextFor("crm", BASE, scope));
      }
      expect(seen).toEqual([
        ["discovery", "alice", "crm"],
        ["status", "alice", "crm"],
        ["startAuth", "alice", "crm"],
        ["discovery", "bob", "tickets"],
        ["status", "bob", "tickets"],
        ["startAuth", "bob", "tickets"],
      ]);
    },
  );

  it("INV-7: a request-owned MCP session outlives its call and closes with its request", WORKERS, async () => {
    let slow = false;
    let sent!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const downstream = httpDownstream((server) =>
      server.registerTool(
        "read",
        { description: "Read.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => {
          if (slow) {
            sent();
            return new Promise<never>(() => {});
          }
          return { content: [{ type: "text", text: "ok" }] };
        },
      ),
    );
    const remote = remoteMcp("crm", { url: downstream.url, _transportFactory: downstream.transport });
    const registry = makeRegistry([remote]);
    const scope = {};
    const tools = createMetaTools(registry, BASE, { requestScope: scope });
    expect((await tools.callTool({ address: "crm.read" })).isError).not.toBe(true);
    expect((await tools.callTool({ address: "crm.read" })).isError).not.toBe(true);
    slow = true;
    const pending = tools.callTool({ address: "crm.read" });
    await pendingSend;
    openRequest(scope).close();
    expect((await pending).isError).toBe(true);
    await expect(remote.listTools(registry.contextFor("crm", BASE, scope))).rejects.toThrow(/scope|ended/i);
  });

  it.each([0, 1, 2])(
    "INV-7: throwing request finalizer %i stops no cleanup and observes revoked registry views",
    NODE,
    async (position) => {
      const scope = {};
      const registry = makeRegistry([fixture(async () => ({}))]);
      const view = registry.contextFor(
        "crm",
        BASE,
        scope,
        {},
        {
          connectorIds: "all",
          caller: {
            identity: { actor: { kind: "human", namespace: "test", id: "alice" }, interactive: true },
            authenticated: true,
          },
        },
      );
      const lease = callFromContext(view, "read");
      contextView(lease, view);
      const request = openRequest(scope);
      const ran: number[] = [];
      for (const index of [0, 1, 2])
        request.own(() => {
          expect(callerOf(view)).toBeUndefined();
          expect(lease.closed()).toBe(true);
          ran.push(index);
          if (index === position) throw new Error("cleanup failed");
        });
      expect(request.close).toThrow(AggregateError);
      expect(ran).toEqual([2, 1, 0]);
      expect(request.close).not.toThrow();
    },
  );

  it(
    "INV-4 INV-9: the api Effect entry receives the admitted caller and served classification and invocation owns recovery",
    NODE,
    async () => {
      const connector = tracksEveryRequest(
        api("crm", {
          tools: [
            {
              name: "run",
              description: "Read.",
              annotations: { readOnlyHint: true },
              handler: async (_, ctx) => {
                expect(callerOf(ctx)?.identity.actor.id).toBe("alice");
                expect(callClassification(ctx)).toBe("write");
                recordRecovery(deriveContext(ctx, {}), { idempotencyKey: "recorded-before-deadline" });
                throw new ConnectorCallError("timeout", "Lost reply.");
              },
            },
          ],
        }),
      );
      expect(callEntry(connector, connector.callTool)).toBeDefined();
      const registry = makeRegistry([connector], { classification: { crm: { run: "write" } } });
      const view = registry.scoped({
        connectorIds: ["crm"],
        caller: {
          identity: { actor: { kind: "human", namespace: "test", id: "alice" }, interactive: true },
          authenticated: true,
        },
      });
      const result = await createMetaTools(view, BASE).callDestructiveTool({
        address: "crm.run",
        args: { caller: "bob", classification: "read" },
      });
      expect(JSON.parse(required(result.content[0]).text!)).toMatchObject({
        error: { uncertainCall: { recovery: { idempotencyKey: "recorded-before-deadline" } } },
      });
    },
  );

  it(
    "INV-4 INV-5 INV-10: credential probes receive anonymous read services and revoke candidate credentials on return",
    NODE,
    async () => {
      let retained!: ConnectorContext;
      const connector = api("crm", {
        tools: [],
        testCredential: async (_value, ctx) => {
          retained = ctx;
          expect(callerOf(ctx)).toBeUndefined();
          expect(Context.get(viewServices(ctx), Classification)).toBe("read");
          expect(await ctx.credential!.get()).toBe("candidate-secret-1234");
          await chargeConnectorCall(ctx);
          return { ok: true };
        },
      });
      const registry = makeRegistry([connector]);
      const operation = registry.contextFor(
        "crm",
        BASE,
        {},
        {},
        {
          connectorIds: "all",
          caller: {
            authenticated: true,
            identity: { actor: { kind: "human", namespace: "test", id: "alice" }, interactive: true },
          },
        },
      );
      expect(await connector.testCredential!("candidate-secret-1234", operation)).toEqual({ ok: true });
      await expect(retained.credential!.getAll()).rejects.toThrow(/call has ended/);
    },
  );

  it("INV-7 INV-9: request revocation retains the logical write ledger for settlement", WORKERS, async () => {
    const scope = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 401 })),
    );
    const connector = api("crm", {
      tools: [
        {
          name: "write",
          description: "Write.",
          annotations: { readOnlyHint: false },
          handler: async (_, ctx) => {
            await ctx.fetch("https://tickets.example/notes", { method: "POST" });
            openRequest(scope).close();
            return {};
          },
        },
      ],
    });
    const result = await createMetaTools(makeRegistry([connector]), BASE, { requestScope: scope }).callDestructiveTool({
      address: "crm.write",
    });
    expect(JSON.parse(required(result.content[0]).text!)).toMatchObject({
      error: { code: "auth_required", writeOutcome: "unknown", retryable: false },
    });
  });

  it(
    "INV-7 INV-9: an outer api call revokes a nested call paused in authentication before it can send",
    WORKERS,
    async () => {
      let entered!: () => void;
      const prepared = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const auth = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const transport = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        maxResponseBytes: 1024,
        authenticate: async () => {
          entered();
          await auth;
          return {};
        },
        fetch,
      });
      const inner = api("tickets", {
        tools: [
          {
            name: "write",
            description: "Write.",
            annotations: { readOnlyHint: false },
            handler: (_, ctx) => transport({ method: "POST", path: "/notes" }, ctx, async () => ({})),
          },
        ],
      });
      let nested!: Promise<unknown>;
      let parent!: ConnectorContext;
      const outer = fixture(async (ctx) => {
        parent = ctx;
        nested = inner.callTool("write", {}, ctx).catch((error: unknown) => error);
        await prepared;
        return {};
      });
      const registry = makeRegistry([outer]);
      expect((await createMetaTools(registry, BASE).callTool({ address: "crm.run" })).isError).not.toBe(true);
      expect(serviceFor(parent, Signal)?.aborted).toBe(true);
      expect(await nested).toBeInstanceOf(Error);
      release();
      await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("native registry and request entry (D.1)", () => {
  it(
    "INV-7 INV-13: a maintained program shares one request owner and one Promise edge through invocation",
    WORKERS,
    async () => {
      const scope = {};
      let owner: ReturnType<typeof requestOwner> | undefined;
      const tool = read(
        {
          errors: tithelyErrors,
          safety: resultSafety({
            review: "Fixture returns only an authored boolean.",
            sensitiveFields: { names: [], choice: "drop" },
          }),
        },
        {
          name: "native",
          description: "Read a fixture.",
          input: Schema.Struct({}),
          output: Schema.Boolean,
          run: () =>
            Effect.gen(function* () {
              owner = yield* RequestScope;
              const credentials = yield* (yield* Credentials).values.pipe(Effect.orDie);
              expect(credentials).toEqual({ value: "native-secret-123456" });
              return true;
            }),
        },
      );
      const connector = api("crm", { credential: { label: "Token" }, tools: [tool] });
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, CREDENTIAL_KEY);
      await vault.set("crm", "native-secret-123456", "alice");
      const registry = makeRegistry([connector], { storage, credentialVault: vault });
      const catalog = new CatalogService(registry, BASE, { requestScope: scope });
      const edge = vi.spyOn(runner, "runEdge");
      try {
        const outcome = await new InvocationService(registry, catalog).invoke(
          "crm.native",
          {},
          { source: "call_tool" },
        );
        expect(outcome).toMatchObject({ ok: true, value: true });
        expect(owner).toBe(requestOwner(scope));
        expect(edge).toHaveBeenCalledTimes(1);
      } finally {
        edge.mockRestore();
        openRequest(scope).close();
      }
    },
  );

  it(
    "INV-4 INV-7: request revocation retains redaction and auth facts without restoring live context authority",
    WORKERS,
    async () => {
      const scope = {};
      const registry = makeRegistry([fixture(async () => ({}))]);
      const operation = registry.contextFor("crm", BASE, scope);
      const lease = callFromContext(operation, "read", { admitted: true });
      const view = contextView(lease, operation);
      const owner = recordedService(view, RequestScope)!;
      sentSecretsForRequest(scope).secret("retained-secret-123456");
      recordCallEntry(
        scope,
        { address: "crm.run", classification: "read", fresh: true },
        { name: "run", classification: "read" },
      );
      recordAuthFailure(scope, "crm", true);
      openRequest(scope).close();
      expect(serviceFor(view, RequestScope)).toBeUndefined();
      expect(recordedService(view, RequestScope)).toBe(owner);
      expect(owner.retained.secrets!.redact("retained-secret-123456")).not.toContain("retained-secret");
      expect(await authRecoveryFacts(scope, "crm")).toMatchObject({
        writeEntered: false,
        unsafeEntered: false,
        eligible: true,
        reads: [{ address: "crm.run" }],
      });
      expect(await authRecoveryFacts({}, "crm")).toMatchObject({ eligible: false, reads: [] });
      expect(() => callFromContext({ ...view }, "read")).toThrow(/ended/);
    },
  );

  it("INV-7 INV-8: a native shared listing survives its first reader and ends with the request", WORKERS, async () => {
    const scope = {};
    const first = new AbortController();
    let signal!: AbortSignal;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const read = new SharedRead(
      (owned) =>
        Effect.tryPromise({
          try: () => {
            signal = owned;
            entered();
            return new Promise<never>((_, reject) =>
              owned.addEventListener("abort", () => reject(owned.reason), { once: true }),
            );
          },
          catch: (error) => error,
        }),
      () => {},
      scope,
    );
    const one = runEdge(read.join(first.signal)).catch((error: unknown) => error);
    const two = runEdge(read.join()).catch((error: unknown) => error);
    await ready;
    const reason = new Error("first reader left");
    first.abort(reason);
    expect(await one).toBe(reason);
    expect(signal.aborted).toBe(false);
    openRequest(scope).close();
    expect(await two).toBeInstanceOf(Error);
    expect(signal.aborted).toBe(true);
  });

  it("INV-5 INV-6: native credential checks retain the Promise boundary's withheld read failure", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    const malformed = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("private-vault-read-text");
      },
    });
    vi.spyOn(vault, "getAll").mockResolvedValue(malformed);
    const registry = makeRegistry([fixture(async () => ({}), true)], { storage, credentialVault: vault });
    expect(await registry.credentialDriftFor("crm")).toBeUndefined();
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "crm.run",
      {},
      { source: "call_tool" },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "auth_required" }, dispatched: false });
    expect(JSON.stringify(outcome)).not.toContain("private-vault-read-text");
  });

  it("INV-4 INV-13: custom Promise stores keep their fallback across nested registry namespaces", async () => {
    const storage = memoryStorage();
    const methods = ["get", "set", "delete", "list", "compareAndSet"] as const;
    const calls = methods.map((method) => vi.spyOn(storage, method));
    const connector = { ...fixture(async () => ({})), authScope: "personal" as const };
    const registry = makeRegistry([connector], { storage });
    const view = registry.scoped({ connectorIds: ["crm"], principalKey: "alice" }).contextFor("crm", BASE);
    expect(getNativeStorage(view.storage)).toBeUndefined();
    await runEdge(
      Effect.gen(function* () {
        yield* storageSet("data:key", "first");
        expect(yield* storageGet("data:key")).toBe("first");
        expect(yield* storageCompareAndSet("data:key", "first", "next")).toBe(true);
        expect(yield* storageList("data:")).toEqual(["data:key"]);
        yield* storageDelete("data:key");
      }).pipe(Effect.provideService(Storage, view.storage)),
    );
    for (const call of calls) expect(call).toHaveBeenCalledTimes(1);
    const reason = new Error("custom store failure");
    calls[0]!.mockImplementation(() => {
      throw reason;
    });
    await expect(runEdge(storageGet("data:key").pipe(Effect.provideService(Storage, view.storage)))).rejects.toBe(
      reason,
    );
  });

  it("INV-4: native registry access honors a replaced Promise method", async () => {
    const registry = makeRegistry([fixture(async () => ({}))]);
    const replacement = vi.fn(async () => [{ name: "replacement", classification: "read" as const }]);
    registry.getTools = replacement;
    expect(await runEdge(registryProgram(registry, "getTools", "crm", BASE))).toEqual([
      { name: "replacement", classification: "read" },
    ]);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
