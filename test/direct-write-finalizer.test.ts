// Every path a direct write's failure can leave a connector by, driven with a
// timeout and with the caller's abort after the server received the write
// (#902 round 10). A direct call has no invocation to report its outcome, so
// each one must say it: unknown and never retryable, whatever timed out or
// aborted it, unless a genuine idempotency key makes a repeat harmless. Reads
// and served calls keep what they had.
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { notion } from "../src/providers/notion/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { classifyCallError } from "../src/errors.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { makeRegistry } from "./helpers.js";

const WORKERD = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const BASE = "https://connecta.example";
/** Long enough for loopback to deliver the request before it fires. */
const DEADLINE_MS = 200;

afterEach(() => {
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
          : ({ method: "GET", path: "/hold" } as const);
      return { pending: failure(send(request, ctx, (response) => response.json())), ctx, received: server.received };
    },
  },
  {
    name: "the shared REST layer (Notion, no idempotency key)",
    timeout: "caller signal",
    async start(kind, options) {
      const server = held();
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith("https://api.notion.com/") ? real(`${server.origin}/hold`, init) : real(input, init),
      );
      const connector = notion("workspace", { auth: { type: "token" }, purpose: "Team knowledge base" });
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
              "notion_api_write",
              {
                method: "PATCH",
                path: "/v1/pages/page-1",
                body: { cover: { type: "external", external: { url: "https://example.com/cover.png" } } },
              },
              ctx,
            )
          : connector.callTool("notion_api_read", { path: "/v1/users/me" }, ctx);
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

/** The options that time a surface's call out. */
function timingOut(surface: Surface): { signal?: AbortSignal; timeoutMs?: number } {
  if (surface.timeout === "caller signal") return { signal: AbortSignal.timeout(DEADLINE_MS) };
  if (surface.timeout === "SDK deadline") return { timeoutMs: DEADLINE_MS };
  return {};
}

/** Wait until the server holds the request, then abort the caller's signal. */
async function abortedAfterDelivery(surface: Surface, kind: Kind) {
  const controller = new AbortController();
  const started = await surface.start(kind, { signal: controller.signal });
  for (let attempt = 0; attempt < 200 && (await started.received()) === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await started.received()).toBe(1);
  const reason = new Error("caller left");
  controller.abort(reason);
  return { error: await started.pending, reason };
}

describe("a direct write's timeout or abort, on every path out of a connector", () => {
  it.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    "INV-9: through %s, a timeout after delivery is unknown and never retryable",
    async (_name, surface) => {
      const started = await surface.start("write", timingOut(surface));
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

  it.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    "INV-9: control: through %s, a read's timeout stays retryable",
    async (_name, surface) => {
      const started = await surface.start("read", timingOut(surface));
      const classified = classifyCallError(await started.pending);
      expect(classified).toMatchObject({ retryable: true });
      expect(classified.writeOutcome).toBeUndefined();
    },
  );

  it.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    "INV-9: control: through %s, a read's abort carries no write outcome",
    async (_name, surface) => {
      const { error } = await abortedAfterDelivery(surface, "read");
      expect(classifyCallError(error).writeOutcome).toBeUndefined();
    },
  );

  it("INV-9: the caller's own timeout stays recognizable: its class and code in details, its reason as the cause", async () => {
    const surface = SURFACES.find((candidate) => candidate.name === "ctx.fetch with the caller's signal")!;
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const started = await surface.start("write", { signal });
    const error = (await started.pending) as Error & { code: string; details?: unknown };
    expect(error).toMatchObject({
      code: "timeout",
      retryable: false,
      writeOutcome: "unknown",
      details: { name: "TimeoutError", code: "timeout" },
    });
    expect(error.cause).toBe(signal.reason);
    // Control: a read passes the caller's reason through by identity, where
    // the runtime's fetch rejects with it (workerd rejects with its own).
    const readSignal = AbortSignal.timeout(DEADLINE_MS);
    const read = await surface.start("read", { signal: readSignal });
    const readError = await read.pending;
    if (!WORKERD) expect(readError).toBe(readSignal.reason);
    expect(classifyCallError(readError)).toMatchObject({ retryable: true });
  });

  it("INV-9: a caller's plain abort reason stays the cause of a direct write's unknown outcome", async () => {
    const surface = SURFACES.find((candidate) => candidate.name === "ctx.fetch with the caller's signal")!;
    const { error, reason } = await abortedAfterDelivery(surface, "write");
    expect(error).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
      details: { name: "Error" },
    });
    expect((error as Error).cause).toBe(reason);
    expect((error as Error).message).toBe(
      "The caller's signal aborted this call (Error) after the write may have reached tickets. Whether it took " +
        "effect is unknown; check the target before repeating it.",
    );
  });
});

describe("controls the finalizer keeps", () => {
  it("INV-9: a direct Stripe write with a genuine key keeps its retry advice after the caller's timeout", async () => {
    const server = held();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://api.stripe.com/") ? real(`${server.origin}/hold`, init) : real(input, init),
    );
    const connector = stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    const registry = makeRegistry([connector], { storage, credentialVault: vault });
    const ctx = registry.contextFor("billing", BASE, undefined, { signal: AbortSignal.timeout(DEADLINE_MS) });
    const error = await failure(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/customers", body: { description: "Fixture" }, idempotencyKey: "fixture-key" },
        ctx,
      ),
    );
    expect(await server.received()).toBe(1);
    expect(classifyCallError(error)).toMatchObject({ retryable: true });
    expect(classifyCallError(error).writeOutcome).toBeUndefined();
  });

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
