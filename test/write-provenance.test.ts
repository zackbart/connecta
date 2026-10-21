// A dispatched write is a known failure only on refusal provenance recorded
// where the evidence was observed (#902 round 11): the ledger shows it never
// left, or the downstream served a refusing HTTP status (a 4xx other than
// 408). An error code thrown after dispatch (a mapper's rate_limited, an
// output validator's invalid_args, a JSON-RPC -32602) is never that evidence,
// on direct and served calls and in program accounting alike. Nor is an
// operation hint: only an idempotency key the vendor honors makes a direct
// write repeatable. Round 12: a custom connector, an input_required
// suspension, and a provider that reads a refusing status as `unavailable`
// prove nothing either. Round 13: refusal evidence holds only for its whole
// logical call, and a write's MCP isError is no evidence at all. Round 14:
// the identities that decide a logical call are captured when they run.
// Round 15: they are invoked with Reflect.apply and bound to the objects that
// own them, so a function's own `call` or a copy of a boundary borrows nothing.
// Round 16: key-reuse advice holds only when its key protects the whole
// logical call: one boundary, one write sent, carrying that key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { createExecuteTool } from "../src/execute.js";
import { stripe } from "../src/providers/stripe/index.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import type { Connector, ConnectorContext, Executor } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

function failure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("an error code after dispatch is no refusal (round 11)", () => {
  it("INV-9: a direct guarded POST answered 200 whose mapper throws rate_limited is unknown, each time", async () => {
    let sent = 0;
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        sent++;
        return Response.json({ created: sent });
      },
    });
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await failure(
        send({ method: "POST", path: "/items" }, ctx, () => {
          throw new ConnectorCallError("rate_limited", "Later quota check failed");
        }),
      );
      expect(classifyCallError(error)).toEqual({
        code: "rate_limited",
        message: "Later quota check failed",
        retryable: false,
        writeOutcome: "unknown",
      });
    }
    expect(sent).toBe(2);
  });

});

/**
 * A remote MCP server whose create_item runs (counted in `applied`) and then
 * fails on the way back: `output` lists an output schema its result breaks,
 * `invalidParams` has the server answer a malformed result the client
 * rejects as -32602.
 */
function brokenResult(mode: "output" | "invalidParams") {
  const state = { applied: 0 };
  const downstream = httpDownstream((server) => {
    server.registerTool(
      "create_item",
      { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
      async () => {
        state.applied++;
        return { content: [{ type: "text", text: "created" }], structuredContent: { id: "not-a-number" } };
      },
    );
    server.registerTool("list_items", { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: "text", text: "[]" }],
    }));
    if (mode === "invalidParams")
      server.server.setRequestHandler("tools/call", async () => {
        state.applied++;
        return { content: [{ type: "text", text: 17 as unknown as string }] };
      });
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: string }) : {};
    const response = await downstream.fetch(String(input), init);
    if (mode === "output" && rpc.method === "tools/list") {
      await response.body?.cancel();
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            {
              name: "create_item",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false },
              outputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            },
          ],
        },
      });
    }
    return response;
  });
  const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
  const registry = makeRegistry([connector]);
  return { state, connector, registry };
}

describe("a remote MCP write that was sent: no JSON-RPC error or output verdict is a refusal (round 11)", () => {
  it.each([
    ["a failed output validation", "output"],
    ["a server's -32602 for a malformed result", "invalidParams"],
  ] as const)("INV-9: %s is unknown on the direct, served, and program paths", async (_label, mode) => {
    const { state, connector, registry } = brokenResult(mode);
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);

    const direct = await failure(connector.callTool("create_item", {}, ctx));
    expect(state.applied).toBe(1);
    expect(classifyCallError(direct)).toMatchObject({
      code: "invalid_args",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: direct as never })).toBe("unknown");

    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state.applied).toBe(2);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({ code: "invalid_args", retryable: false, writeOutcome: "unknown" });
    expect(served.error.retry).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("unknown");

    // A program that catches the failure still reports the unknown write.
    const executor: Executor = {
      async execute(_code, providers) {
        try {
          await providers.find((provider) => provider.name === "connecta")!.fns["call"]!("tickets.create_item", {});
        } catch {
          /* caught by the guest */
        }
        return { result: "caught and continued" };
      },
    };
    const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false });
    const program = await execute({ code: "async () => null" });
    expect(state.applied).toBe(3);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
    await connector.closeScope?.(ctx);
  });

  it("INV-9: control: an HTTP 4xx refusal of the tools/call stays known; a 408 is unknown", async () => {
    for (const [status, state] of [
      [422, "failed"],
      [408, "unknown"],
    ] as const) {
      const downstream = httpDownstream((server) => {
        server.registerTool(
          "create_item",
          { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
          async () => ({ content: [{ type: "text", text: "created" }] }),
        );
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
        if (rpc.method === "tools/call") return new Response("refused", { status });
        return downstream.fetch(String(input), init);
      });
      const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
      const ctx = makeRegistry([connector]).contextFor("tickets", BASE);
      await connector.listTools(ctx);
      const error = await failure(connector.callTool("create_item", {}, ctx));
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe(state);
      expect(classifyCallError(error).retryable).toBe(false);
      await connector.closeScope?.(ctx);
    }
  });

});

/** A program that calls `address` once, catches its failure, and returns. */
function catchingProgram(registry: ReturnType<typeof makeRegistry>, address: string) {
  const executor: Executor = {
    async execute(_code, providers) {
      try {
        await providers.find((provider) => provider.name === "connecta")!.fns["call"]!(address, {});
      } catch {
        /* caught by the guest */
      }
      return { result: "caught and continued" };
    },
  };
  return createExecuteTool(registry, BASE, executor, silentLogger, undefined, { readOnly: false })({
    code: "async () => null",
  });
}

describe("a served write's unknown outcome is final before any advice (round 12)", () => {
  /**
   * A custom connector (neither api() nor remoteMcp()) that applies each
   * call, counted in `applied`, and then throws `failure`.
   */
  function custom(failure: () => ConnectorCallError) {
    const state = { applied: 0 };
    const connector = {
      id: "tickets",
      kind: "api" as const,
      description: "Tickets",
      async listTools() {
        return [
          { name: "create_item", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} },
          { name: "list_items", description: "List", annotations: { readOnlyHint: true }, inputSchema: {} },
        ];
      },
      async callTool() {
        state.applied++;
        throw failure();
      },
    };
    const registry = makeRegistry([connector]);
    return { state, registry, invoke: new InvocationService(registry, new CatalogService(registry, BASE)) };
  }

  it.each([
    ["rate_limited", () => new ConnectorCallError("rate_limited", "A check after applying the write failed")],
    [
      "invalid_args with findings",
      () =>
        new ConnectorCallError("invalid_args", "A check after applying the write failed", {
          validation: { issues: [{ path: "/name", code: "type", expected: "string" }] },
        }),
    ],
  ] as const)(
    "INV-9: a custom connector's %s after entry is unknown, never retryable, with no retry advice",
    async (_label, failure) => {
      const { state, registry, invoke } = custom(failure);
      const served = await invoke.invoke("tickets.create_item", {}, { source: "call_destructive_tool" });
      expect(state.applied).toBe(1);
      if (served.ok) throw new Error("expected the served write to fail");
      expect(served.error).toMatchObject({ code: failure().code, retryable: false, writeOutcome: "unknown" });
      expect(served.error.retry).toBeUndefined();
      expect(served.error.nextAction).toBeUndefined();
      expect(classifyWriteOutcome(served)).toBe("unknown");

      const program = await catchingProgram(registry, "tickets.create_item");
      expect(state.applied).toBe(2);
      expect(program.structuredContent).toMatchObject({
        error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
      });
    },
  );

  it("INV-9: control: a write's pre-dispatch refusal and a served 403 refusal stay known, with their advice", async () => {
    let sent = 0;
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        sent++;
        return Response.json({}, { status: 403 });
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "create_item",
            description: "Create",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
            handler: (_args, ctx) =>
              send({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("provider_permission_denied", "Tickets refused the scope");
              }),
          },
        ],
      }),
    );
    const registry = makeRegistry([connector]);
    const invoke = new InvocationService(registry, new CatalogService(registry, BASE));

    const invalid = await invoke.invoke("tickets.create_item", { name: 7 }, { source: "call_destructive_tool" });
    if (invalid.ok) throw new Error("expected the refusal");
    expect(sent).toBe(0);
    expect(invalid.dispatched).toBe(true);
    expect(invalid.error).toMatchObject({ code: "invalid_args", retryable: false });
    expect(invalid.error.writeOutcome).toBeUndefined();
    expect(invalid.error.retry).toMatch(/^Correct the listed arguments and retry/);
    expect(classifyWriteOutcome(invalid)).toBe("failed");

    const denied = await invoke.invoke("tickets.create_item", { name: "x" }, { source: "call_destructive_tool" });
    if (denied.ok) throw new Error("expected the refusal");
    expect(sent).toBe(1);
    expect(denied.error).toMatchObject({ code: "provider_permission_denied", retryable: false });
    expect(denied.error.writeOutcome).toBeUndefined();
    expect(denied.error.retry).toMatch(/grant the required permission or scope, then retry/);
    expect(classifyWriteOutcome(denied)).toBe("failed");
  });
});

describe("refusal evidence holds only for its whole logical call (round 13)", () => {
  const stripeWrite = (id: string) => ({ method: "DELETE", path: `/v1/customers/${id}` });

  /** A Stripe connection whose odd-numbered requests delete and even-numbered ones are refused 429. */
  async function billing() {
    const state = { sent: 0, applied: 0 };
    vi.stubGlobal("fetch", async () => {
      state.sent++;
      if (state.sent % 2 === 1) {
        state.applied++;
        return Response.json({ id: "cus_1", deleted: true });
      }
      return Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 });
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  /** A custom connector whose one tool composes `run` over the Stripe connection. */
  function composite(inner: Connector, run: (inner: Connector, ctx: ConnectorContext) => Promise<unknown>): Connector {
    return {
      id: "billing",
      kind: "api",
      ...(inner.credential ? { credential: inner.credential } : {}),
      description: "Composite operation",
      async listTools() {
        return [
          { name: "delete_pair", description: "Delete two", annotations: { readOnlyHint: false }, inputSchema: {} },
        ];
      },
      callTool: (_name, _args, ctx) => run(inner, ctx),
    };
  }

  it("INV-9: a composite's second Stripe DELETE refused 429 after its first applied is unknown, served and in a program", async () => {
    const { state, connector, storage, vault } = await billing();
    const wrapper = composite(connector, async (inner, ctx) => {
      await inner.callTool("stripe_api_write", stripeWrite("cus_1"), ctx);
      return await inner.callTool("stripe_api_write", stripeWrite("cus_2"), ctx);
    });
    const registry = makeRegistry([wrapper], { storage, credentialVault: vault });
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.delete_pair",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state).toEqual({ sent: 2, applied: 1 });
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.answered).toBe(false);
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    // Stripe's own back-off advice held only for the refused request.
    expect(served.error.message).toBe("Stripe rate_limit_error: Rate limit");
    expect(served.error.retry).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await catchingProgram(registry, "billing.delete_pair");
    expect(state).toEqual({ sent: 4, applied: 2 });
    expect(program.isError).toBe(true);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
  });

});

describe("a logical call's identities are bound to the objects that own them (round 15)", () => {
  const stripeWrite = { method: "DELETE", path: "/v1/customers/cus_2" };

  /** Stripe behind a vault: side requests apply, every Stripe request is refused 429. */
  async function billing() {
    const state = { applied: 0, refused: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://side.example/")) {
        state.applied++;
        return Response.json({ id: "created" });
      }
      state.refused++;
      return Response.json({ error: { type: "rate_limit_error", message: "Rate limit" } }, { status: 429 });
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  function invoke(registry: ReturnType<typeof makeRegistry>, address: string, args: unknown) {
    return new InvocationService(registry, new CatalogService(registry, BASE)).invoke(address, args, {
      source: "call_destructive_tool",
    });
  }

  it("INV-9: a boundary whose callTool property was replaced after construction loses its standing", async () => {
    const { state, connector, storage, vault } = await billing();
    const own = connector.callTool;
    connector.callTool = async (name, args, ctx, options) => {
      await fetch("https://side.example/apply", { method: "POST" });
      return await own(name, args, ctx, options);
    };
    const outcome = await invoke(
      makeRegistry([connector], { storage, credentialVault: vault }),
      "billing.stripe_api_write",
      stripeWrite,
    );
    expect(state).toEqual({ applied: 1, refused: 1 });
    if (outcome.ok) throw new Error("expected the refusal");
    expect(outcome.answered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(outcome.error.message).toBe("Stripe rate_limit_error: Rate limit");
  });

});

describe("a write's MCP isError is a 2xx reply, never a known failure (round 13)", () => {
  /** A real SDK server whose write applies, then answers isError over HTTP 200. */
  function erroring() {
    const state = { applied: 0, statuses: [] as number[] };
    const downstream = httpDownstream((server) => {
      server.registerTool("create_item", { annotations: { readOnlyHint: false } }, async () => {
        state.applied++;
        return { isError: true, content: [{ type: "text", text: "Follow-up quota check failed." }] };
      });
      server.registerTool("list_items", { annotations: { readOnlyHint: true } }, async () => {
        return { isError: true, content: [{ type: "text", text: "No such list." }] };
      });
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await downstream.fetch(String(input), init);
      if (typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call")
        state.statuses.push(response.status);
      return response;
    });
    const registry = makeRegistry([remoteMcp("tickets", { url: downstream.url })]);
    return { state, registry, invoke: new InvocationService(registry, new CatalogService(registry, BASE)) };
  }

  it("INV-9: a served write answered isError over HTTP 200 is unknown, keeps its text, and a program reports it", async () => {
    const { state, registry, invoke } = erroring();
    const served = await invoke.invoke("tickets.create_item", {}, { source: "call_destructive_tool" });
    expect(state.applied).toBe(1);
    expect(state.statuses).toEqual([200]);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.answered).toBe(false);
    expect(served.error).toMatchObject({
      code: "connector_call_failed",
      message: "Follow-up quota check failed.",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await catchingProgram(registry, "tickets.create_item");
    expect(state.applied).toBe(2);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
  });

});

describe("key-reuse advice needs its key to protect the whole logical call (round 16)", () => {
  const KEY_ADVICE = /cannot repeat the write|Reusing it|recovery\.idempotencyKey/;
  const create = (name: string, idempotencyKey?: string) => ({
    method: "POST",
    path: "/v1/customers",
    body: { name },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

  interface Sent {
    method: string;
    url: string;
    key: string | null;
    name: string | null;
  }

  /**
   * Stripe behind a vault. Every request is recorded with its key; `answer`
   * decides each reply. A create applies once per key, as Stripe's do.
   */
  async function billing(answer: (request: Sent, applied: number) => Response | Promise<Response>) {
    const state = { sent: [] as Sent[], applied: new Map<string, number>(), ticketsApplied: 0 };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const name = request.method === "POST" ? new URLSearchParams(await request.text()).get("name") : null;
      const sent = { method: request.method, url: request.url, key: request.headers.get("idempotency-key"), name };
      state.sent.push(sent);
      if (request.url === "https://tickets.example/create") {
        state.ticketsApplied++;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      }
      const applied = name ?? request.url;
      if (request.method === "POST" && (sent.key === null || !state.sent.slice(0, -1).some((s) => s.key === sent.key)))
        state.applied.set(applied, (state.applied.get(applied) ?? 0) + 1);
      return answer(sent, state.applied.get(applied) ?? 0);
    });
    const connector = stripe("billing", { purpose: "Review", auth: { type: "apiKey" }, mode: "sandbox" });
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.set("billing", "sk_test_fixture", "fixture");
    return { state, connector, storage, vault };
  }

  const created = (sent: Sent) => Response.json({ id: `cus_${sent.name}`, name: sent.name });

  function invoke(
    registry: ReturnType<typeof makeRegistry>,
    address: string,
    args: unknown,
    timeoutMs?: number,
  ): ReturnType<InvocationService["invoke"]> {
    return new InvocationService(registry, new CatalogService(registry, BASE)).invoke(address, args, {
      source: "call_destructive_tool",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  function expectNoKeyAdvice(error: { message: string; retry?: string }) {
    expect(error.message).not.toMatch(KEY_ADVICE);
    expect(error.retry ?? "").not.toMatch(KEY_ADVICE);
  }

  it("INV-9: an api() composite's keyed Stripe create grants no advice to the unkeyed ticket POST that lost its reply", async () => {
    const { state, connector, storage, vault } = await billing(created);
    const composite = api("billing", {
      credential: connector.credential!,
      tools: [
        {
          name: "create_pair",
          description: "Create a customer and a ticket",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" } } },
          async handler(args, ctx) {
            await connector.callTool("stripe_api_write", create("first", String(args["idempotencyKey"])), ctx);
            return (await ctx.fetch("https://tickets.example/create", { method: "POST", body: "create" })).json();
          },
        },
      ],
    });
    const registry = makeRegistry([composite], { storage, credentialVault: vault });
    const first = await invoke(registry, "billing.create_pair", { idempotencyKey: "stable-first" });
    if (first.ok) throw new Error("expected the composite to fail");
    expect(first.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expectNoKeyAdvice(first.error);
    // The key stays as a diagnostic.
    expect(first.error.uncertainCall?.recovery).toEqual({ idempotencyKey: "stable-first" });
    expect(classifyWriteOutcome(first)).toBe("unknown");
    // Why: the same arguments again create one customer and a second ticket.
    await invoke(registry, "billing.create_pair", { idempotencyKey: "stable-first" });
    expect(state.applied.get("first")).toBe(1);
    expect(state.ticketsApplied).toBe(2);
  });

});
