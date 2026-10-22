import { Context, Effect } from "effect";
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
import { callEntry } from "../src/runtime/call-entry.js";
import { runEdge } from "../src/runtime/run.js";
import { duringCall, fromConnectorContext } from "../src/http/services.js";
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
      view = contextView(lease, { ...operation, credential: { get: async () => null, getAll: async () => null } });
      const credentials = view.credential!.getAll().catch((error: unknown) => error);
      const budget = chargeConnectorCall(view).catch((error: unknown) => error);
      expect(seen).toHaveLength(2);
      (boundary === "call" ? lease : openRequest(scope)).close();
      for (const result of await Promise.all([credentials, budget]))
        expect(result).toMatchObject({ code: "connector_call_failed" });
      expect(seen.every((signal) => signal.aborted)).toBe(true);
    },
  );

  it.each(["call", "request"] as const)(
    "INV-7: closing the %s aborts paused grant renewal without releasing it or updating state",
    WORKERS,
    async (boundary) => {
      const scope = {};
      let kept!: CallLease;
      let changed = false;
      let signal!: AbortSignal;
      const registry = makeRegistry([
        fixture(async (ctx) => {
          kept = fromConnectorContext(ctx, "read");
          signal = Context.get(kept.services, Signal)!;
          const renewal = duringCall(
            Effect.tryPromise({ try: () => new Promise<never>(() => {}), catch: (error) => error }),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                changed = true;
              }),
            ),
            Effect.provideContext(kept.services),
          );
          return await runEdge(renewal);
        }),
      ]);
      const pending = createMetaTools(registry, BASE, { requestScope: scope }).callTool({ address: "crm.run" });
      await vi.waitFor(() => expect(kept).toBeDefined());
      (boundary === "call" ? kept : openRequest(scope)).close();
      expect((await pending).isError).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(changed).toBe(false);
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
