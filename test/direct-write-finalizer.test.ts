// Every path a direct write's failure can leave a connector by, driven with a
// timeout and with the caller's abort after the server received the write
// (#902 round 10). A direct call has no invocation to report its outcome, so
// each one must say it: unknown and never retryable, whatever timed out or
// aborted it, unless a genuine idempotency key makes a repeat harmless. Reads
// and served calls keep what they had. Round 11: a served answer is a known
// failure only when its status refuses (a 4xx other than 408); an error code
// a mapper or parser throws after a 2xx, or after a 408, is no evidence.
// Round 12: nor is a refusing status the provider itself reads as
// `unavailable` (Stripe's 424), inside a call ledger or outside one.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { InvocationService } from "../src/invocation.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { stripe } from "../src/providers/stripe/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, Executor } from "../src/types.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";
/** Long enough for loopback to deliver the request before it fires. */
const DEADLINE_MS = 200;

beforeEach(() => {
  configureGuardedTransport({ send: async (url, init) => globalThis.fetch(url, init) });
});

afterEach(() => {
  configureGuardedTransport(undefined);
  vi.unstubAllGlobals();
});

async function exchanges(id: string): Promise<Array<{ method: string; bytes: number }>> {
  return (await (await fetch(`${inject("evidenceHttpServer")}/${id}/exchanges`)).json()) as Array<{
    method: string;
    bytes: number;
  }>;
}

/** A `/hold` route of the evidence server: it reads each request and never answers. */
function held() {
  const id = crypto.randomUUID();
  return { origin: `${inject("evidenceHttpServer")}/${id}`, received: async () => (await exchanges(id)).length };
}

type Kind = "write" | "read";

/** One direct call, the context it ran on, and how many requests reached the server. */
interface Started {
  pending: Promise<unknown>;
  ctx: ConnectorContext;
  received: () => Promise<number>;
}

/**
 * A connector surface. `start` makes one direct call with `options` as its
 * call options; `timeout` names what times the call out: the caller's own
 * signal (`AbortSignal.timeout`), the handler's own fetch signal, or the
 * SDK's request deadline (`timeoutMs`).
 */
interface Surface {
  name: string;
  timeout: "caller signal" | "handler signal" | "SDK deadline";
  start(kind: Kind, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<Started>;
}

function failure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

/** An api() tool per kind that calls `send`. */
function tickets(send: (kind: Kind, ctx: ConnectorContext & { fetch: typeof fetch }) => Promise<unknown>) {
  return api("tickets", {
    tools: (["write", "read"] as const).map((kind) => ({
      name: kind,
      description: `${kind} a ticket`,
      annotations: { readOnlyHint: kind === "read" },
      handler: (_args: unknown, ctx: ConnectorContext & { fetch: typeof fetch }) => send(kind, ctx),
    })),
  });
}

function startApi(connector: Connector, server: ReturnType<typeof held>) {
  const registry = makeRegistry([connector]);
  return async (kind: Kind, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<Started> => {
    const ctx = registry.contextFor("tickets", BASE, undefined, options);
    return { pending: failure(connector.callTool(kind, {}, ctx)), ctx, received: server.received };
  };
}

const init = (kind: Kind): RequestInit =>
  kind === "write" ? { method: "POST", body: JSON.stringify({ title: "Fixture" }) } : { method: "GET" };

const SURFACES: Surface[] = [
  {
    name: "an api() handler's own fetch",
    timeout: "handler signal",
    async start(kind, options) {
      const server = held();
      // The handler bounds its own fetch; it also honors the caller's signal.
      const connector = tickets((kind, ctx) =>
        globalThis.fetch(`${server.origin}/hold`, {
          ...init(kind),
          signal: options.signal ? ctx.signal! : AbortSignal.timeout(DEADLINE_MS),
        }),
      );
      return startApi(connector, server)(kind, options.signal ? options : {});
    },
  },
  {
    name: "ctx.fetch with the caller's signal",
    timeout: "caller signal",
    async start(kind, options) {
      const server = held();
      const connector = tickets((kind, ctx) =>
        ctx.fetch(`${server.origin}/hold`, { ...init(kind), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
      );
      return startApi(connector, server)(kind, options);
    },
  },
  {
    name: "a guarded transport in a tracked api() call",
    timeout: "caller signal",
    async start(kind, options) {
      const server = held();
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: server.origin,
        authenticate: () => ({}),
        maxResponseBytes: 1024,
      });
      const connector = tracksEveryRequest(
        tickets((kind, ctx) =>
          send(
            kind === "write"
              ? { method: "POST", path: "/hold", body: { title: "Fixture" } }
              : { method: "GET", path: "/hold" },
            ctx,
            (response) => response.json(),
          ),
        ),
      );
      return startApi(connector, server)(kind, options);
    },
  },
  {
    name: "a guarded transport outside any call ledger",
    timeout: "caller signal",
    async start(kind, options) {
      const server = held();
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: server.origin,
        authenticate: () => ({}),
        maxResponseBytes: 1024,
      });
      const ctx = makeRegistry([]).contextFor("tickets", BASE, undefined, options);
      const request =
        kind === "write"
          ? ({ method: "POST", path: "/hold", body: { title: "Fixture" } } as const)
          : ({ method: "GET", path: "/hold", classification: "read" } as const);
      return { pending: failure(send(request, ctx, (response) => response.json())), ctx, received: server.received };
    },
  },
  {
    name: "the shared REST layer (Stripe, no idempotency key)",
    timeout: "caller signal",
    async start(kind, options) {
      const server = held();
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith("https://api.stripe.com/") ? real(`${server.origin}/hold`, init) : real(input, init),
      );
      const connector = stripe("workspace", { auth: { type: "apiKey" }, mode: "sandbox", purpose: "Billing" });
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, btoa("k".repeat(32)));
      await vault.set("workspace", "secret_token", "fixture");
      const ctx = makeRegistry([connector], { storage, credentialVault: vault }).contextFor(
        "workspace",
        BASE,
        undefined,
        options,
      );
      const pending =
        kind === "write"
          ? connector.callTool(
              "stripe_api_write",
              {
                method: "POST",
                path: "/v1/customers",
                body: { name: "Fixture" },
              },
              ctx,
            )
          : connector.callTool("stripe_api_read", { path: "/v1/account" }, ctx);
      return { pending: failure(pending), ctx, received: server.received };
    },
  },
  {
    name: "remoteMcp().callTool()",
    timeout: "SDK deadline",
    async start(kind, options) {
      const applied: string[] = [];
      const downstream = httpDownstream((server) => {
        server.registerTool(
          "create_item",
          { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
          async () => {
            applied.push("create_item");
            return { content: [{ type: "text", text: "created" }] };
          },
        );
        server.registerTool(
          "list_items",
          { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
          async () => {
            applied.push("list_items");
            return { content: [{ type: "text", text: "[]" }] };
          },
        );
      });
      // The server acts on each tools/call; its answer never arrives.
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : undefined;
        const reply = await downstream.fetch(String(input), init);
        if (rpc?.method !== "tools/call") return reply;
        await reply.body?.cancel();
        const signal = init!.signal!;
        return await new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
      const ctx = makeRegistry([connector]).contextFor("tickets", BASE, undefined, options);
      // Listed hints classify the direct read as one.
      await connector.listTools(ctx);
      const pending = failure(connector.callTool(kind === "write" ? "create_item" : "list_items", {}, ctx)).then(
        async (error) => {
          await connector.closeScope?.(ctx);
          return error;
        },
      );
      return {
        pending,
        ctx,
        received: async () => applied.filter((tool) => tool !== "list_items" || kind === "read").length,
      };
    },
  },
];

/** Arm a caller's timeout after delivery, so first-call construction cannot expire it before dispatch. */
async function timingOut(surface: Surface): Promise<Started> {
  if (surface.timeout !== "caller signal")
    return surface.start("write", surface.timeout === "SDK deadline" ? { timeoutMs: DEADLINE_MS } : {});
  const { started, controller } = await startedAfterDelivery(surface, "write");
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  deadline.addEventListener("abort", () => controller.abort(deadline.reason), { once: true });
  return started;
}

/** Wait until the server holds exactly one request before triggering its caller's end. */
async function startedAfterDelivery(surface: Surface, kind: Kind) {
  const controller = new AbortController();
  const started = await surface.start(kind, { signal: controller.signal });
  for (let attempt = 0; attempt < 200 && (await started.received()) === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await started.received()).toBe(1);
  return { started, controller };
}

/** Wait until the server holds the request, then abort the caller's signal. */
async function abortedAfterDelivery(surface: Surface, kind: Kind) {
  const { started, controller } = await startedAfterDelivery(surface, kind);
  const reason = new Error("caller left");
  controller.abort(reason);
  return { error: await started.pending, reason };
}

describe("a direct write's timeout or abort, on every path out of a connector", () => {
  it.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    "INV-9: through %s, a timeout after delivery is unknown and never retryable",
    async (_name, surface) => {
      const started = await timingOut(surface);
      const error = await started.pending;
      expect(await started.received()).toBe(1);
      expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("unknown");
    },
  );

  it.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    "INV-9: through %s, the caller's abort after delivery is unknown and never retryable",
    async (_name, surface) => {
      const { error } = await abortedAfterDelivery(surface, "write");
      expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("unknown");
    },
  );
});

/** A route of the evidence server that answers each request with `status` and `body`. */
function answering(status: number, body?: string) {
  const id = crypto.randomUUID();
  return {
    origin: `${inject("evidenceHttpServer")}/${id}`,
    path: `/status/${status}`,
    query: body === undefined ? {} : { body },
    received: async () => (await exchanges(id)).length,
  };
}

type Mapper = (response: { json(): Promise<unknown> }) => unknown;

/** What a provider's mapper does with the answer it was served. */
const throwing =
  (code: "rate_limited" | "invalid_args" | "timeout", retryable = true): Mapper =>
  () => {
    throw new ConnectorCallError(code, `The mapper's own ${code}.`, { retryable });
  };

/** Send one request through a guarded transport, outside any ledger or inside a tracked api() call. */
async function guardedCall(
  where: "outside any call ledger" | "in a tracked api() call",
  kind: Kind,
  server: ReturnType<typeof answering>,
  map: Mapper,
): Promise<unknown> {
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: server.origin,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
  });
  const request =
    kind === "write"
      ? ({ method: "POST", path: server.path, query: server.query, body: { title: "Fixture" } } as const)
      : ({ method: "GET", path: server.path, query: server.query, classification: "read" } as const);
  if (where === "outside any call ledger") {
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    return failure(send(request, ctx, (response) => map(response)));
  }
  const connector = tracksEveryRequest(tickets((_kind, ctx) => send(request, ctx, map)));
  return failure(connector.callTool(kind, {}, makeRegistry([connector]).contextFor("tickets", BASE)));
}

const GUARDED = ["outside any call ledger", "in a tracked api() call"] as const;

const UNKNOWN_ANSWERS: Array<[label: string, status: number, body: string | undefined, map: Mapper, code: string]> = [
  ["200 then the mapper's rate_limited", 200, undefined, throwing("rate_limited"), "rate_limited"],
  ["200 then the mapper's invalid_args", 200, undefined, throwing("invalid_args", false), "invalid_args"],
  ["200 then an unparseable reply", 200, "not json", (response) => response.json(), ""],
  ["408 the mapper reads as a timeout", 408, undefined, throwing("timeout"), "timeout"],
  ["408 then the mapper's invalid_args", 408, undefined, throwing("invalid_args", false), "invalid_args"],
];

describe("a direct write's served answer: only a refusing status is evidence (round 11)", () => {
  it.each(GUARDED.flatMap((where) => UNKNOWN_ANSWERS.map((answer) => [where, ...answer] as const)))(
    "INV-9: through a guarded transport %s, %s is unknown and never retryable",
    async (where, _label, status, body, map, code) => {
      const server = answering(status, body);
      const error = await guardedCall(where, "write", server, map);
      expect(await server.received()).toBe(1);
      const classified = classifyCallError(error);
      expect(classified).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      // The code stays for diagnostics; it is not the verdict.
      if (code) expect(classified.code).toBe(code);
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("unknown");
    },
  );

  it.each(
    GUARDED.flatMap((where) => [
      [where, 422, throwing("invalid_args", false), false] as const,
      [where, 429, throwing("rate_limited"), true] as const,
    ]),
  )(
    "INV-9: control: through a guarded transport %s, a served %i refusal stays a known failure",
    async (where, status, map, retryable) => {
      const server = answering(status);
      const error = await guardedCall(where, "write", server, map);
      expect(await server.received()).toBe(1);
      const classified = classifyCallError(error);
      expect(classified.retryable).toBe(retryable);
      expect(classified.writeOutcome).toBeUndefined();
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("failed");
    },
  );
});

/**
 * A Stripe API-key connector whose every request reaches the evidence server
 * and is answered `status` with Stripe's error `body`. `keys` records each
 * request's Idempotency-Key header.
 */
async function stripeAnswering(status: number, body: unknown) {
  const server = answering(status, JSON.stringify(body));
  const keys: Array<string | null> = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.stripe.com/")) return real(input, init);
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    return real(`${server.origin}${server.path}?${new URLSearchParams(server.query)}`, init);
  });
  const connector = stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, mode: "sandbox" });
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.set("billing", "sk_test_fixture", "fixture");
  const registry = makeRegistry([connector], { storage, credentialVault: vault });
  const program = (args: Record<string, unknown>) => {
    const executor: Executor = {
      async execute(_code, providers) {
        try {
          await providers.find((provider) => provider.name === "connecta")!.fns["call"]!(
            "billing.stripe_api_write",
            args,
          );
        } catch {
          /* caught by the guest */
        }
        return { result: "caught and continued" };
      },
    };
    return createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
      code: "async () => null",
    });
  };
  return {
    server,
    keys,
    direct: (args: Record<string, unknown>) =>
      failure(connector.callTool("stripe_api_write", args, registry.contextFor("billing", BASE))),
    served: (args: Record<string, unknown>) =>
      new InvocationService(registry, new CatalogService(registry, BASE)).invoke("billing.stripe_api_write", args, {
        source: "call_destructive_tool",
      }),
    program,
  };
}

const STRIPE_424 = { error: { type: "api_error", message: "External dependency failed" } };

describe("a refusing status the provider reads as unavailable is no refusal (round 12)", () => {
  it("INV-9: Stripe's 424 on a keyless DELETE is unknown and never retryable, direct, served, and in a program", async () => {
    const stripe424 = await stripeAnswering(424, STRIPE_424);
    const args = { method: "DELETE", path: "/v1/customers/cus_1" };

    const direct = await stripe424.direct(args);
    expect(classifyCallError(direct)).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: direct as never })).toBe("unknown");

    const served = await stripe424.served(args);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(served.error.retry).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await stripe424.program(args);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
    expect(await stripe424.server.received()).toBe(3);
    expect(stripe424.keys).toEqual([null, null, null]);
  });

  it("INV-9: Stripe's 424 with a genuine key keeps the direct retry and the served key-reuse advice", async () => {
    const stripe424 = await stripeAnswering(424, STRIPE_424);
    const args = { method: "POST", path: "/v1/customers", body: { description: "Fixture" }, idempotencyKey: "k-424" };

    const direct = await stripe424.direct(args);
    expect(classifyCallError(direct)).toMatchObject({ code: "unavailable", retryable: true });
    expect(classifyCallError(direct).writeOutcome).toBeUndefined();

    // A served verdict still reconciles first; the key makes the deliberate retry safe.
    const served = await stripe424.served(args);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({
      retryable: false,
      writeOutcome: "unknown",
      uncertainCall: { recovery: { idempotencyKey: "k-424" } },
    });
    expect(served.error.retry).toContain("uncertainCall.recovery.idempotencyKey");
    expect(stripe424.keys).toEqual(["k-424", "k-424"]);
  });

  it("INV-9: control: Stripe's 400 refusal of a keyless DELETE stays a known failure, direct and served", async () => {
    const stripe400 = await stripeAnswering(400, {
      error: { type: "invalid_request_error", message: "No such customer: 'cus_1'" },
    });
    const args = { method: "DELETE", path: "/v1/customers/cus_1" };
    const direct = await stripe400.direct(args);
    expect(classifyCallError(direct).writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: direct as never })).toBe("failed");
    const served = await stripe400.served(args);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error.writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("failed");
    expect(await stripe400.server.received()).toBe(2);
  });
});

describe("controls the finalizer keeps", () => {
  it("INV-9: a served write's timeout is still reported by its invocation", async () => {
    const server = held();
    const connector = tickets((kind, ctx) =>
      ctx.fetch(`${server.origin}/hold`, { ...init(kind), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    );
    const registry = makeRegistry([connector]);
    const result = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.write",
      {},
      { source: "call_destructive_tool", timeoutMs: DEADLINE_MS },
    );
    if (result.ok) throw new Error("expected the write to fail");
    expect(result.error).toMatchObject({
      code: "write_outcome_unknown",
      retryable: false,
      details: { stage: "downstream" },
      uncertainCall: { address: "tickets.write", args: {} },
    });
    expect(await server.received()).toBe(1);
  });
});
