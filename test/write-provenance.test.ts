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
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { delegatesEachCall, tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { createExecuteTool } from "../src/execute.js";
import { github } from "../src/providers/github/index.js";
import { sheets } from "../src/providers/sheets/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import type { Connector, ConnectorContext, Executor } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { googleOptions } from "./fixtures/provider-options.js";
import { PRIVATE_KEY } from "./goldens/rsa-fixture.js";
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

  it("INV-9: a tracked api() write answered 408 whose mapper throws timeout is unknown, not a refusal", async () => {
    let sent = 0;
    const deadline = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        sent++;
        return Response.json({}, { status: 408 });
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) =>
              deadline({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("timeout", "The request timed out");
              }),
          },
        ],
      }),
    );
    const error = await failure(connector.callTool("send", {}, makeRegistry([connector]).contextFor("tickets", BASE)));
    expect(sent).toBe(1);
    expect(classifyCallError(error)).toMatchObject({ code: "timeout", retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("unknown");
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

  it("INV-9: control: a refusal before the tools/call is sent stays a known failure, direct and served", async () => {
    const downstream = httpDownstream((server) => {
      server.registerTool(
        "create_item",
        { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
        async () => ({ content: [{ type: "text", text: "created" }] }),
      );
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: string }) : {};
      if (rpc.method) calls.push(rpc.method);
      const response = await downstream.fetch(String(input), init);
      if (rpc.method !== "tools/list") return response;
      await response.body?.cancel();
      // A task-only tool: refused before its tools/call reaches fetch.
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            {
              name: "create_item",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false },
              execution: { taskSupport: "required" },
            },
          ],
        },
      });
    });
    const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
    const registry = makeRegistry([connector]);
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);
    const direct = await failure(connector.callTool("create_item", {}, ctx));
    expect(classifyCallError(direct).writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: direct as never })).toBe("failed");
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error.writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome(served)).toBe("failed");
    expect(calls).not.toContain("tools/call");
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

  it("INV-9: control: a read's -32602 for a malformed result keeps its classification", async () => {
    const { connector, registry } = brokenResult("invalidParams");
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);
    const error = await failure(connector.callTool("list_items", {}, ctx));
    expect(classifyCallError(error)).toMatchObject({ code: "invalid_args" });
    expect(classifyCallError(error).writeOutcome).toBeUndefined();
    await connector.closeScope?.(ctx);
  });
});

describe("an operation hint grants no retry credit (round 11)", () => {
  it("INV-9: two direct Sheets update_values writes that time out after delivery are each unknown", async () => {
    const id = crypto.randomUUID();
    const origin = `${inject("evidenceHttpServer")}/${id}`;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "https://oauth2.googleapis.com/token"
        ? Promise.resolve(Response.json({ access_token: "fixture", expires_in: 3599 }))
        : real(`${origin}/hold`, init),
    );
    const connector = sheets("sheets", { ...googleOptions, subject: "alice@example.com", purpose: "Review" });
    const registry = makeRegistry([connector]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = registry.contextFor("sheets", BASE, undefined, { signal: AbortSignal.timeout(300) });
      const error = await failure(
        connector.callTool(
          "update_values",
          { spreadsheetId: "sheet-1", range: "Sheet1!A1", values: [["changed"]], valueInputOption: "RAW" },
          ctx,
        ),
      );
      expect(classifyCallError(error)).toMatchObject({ code: "timeout", retryable: false, writeOutcome: "unknown" });
    }
    const received = (await (await real(`${origin}/exchanges`)).json()) as Array<{ method: string }>;
    expect(received.map((exchange) => exchange.method)).toEqual(["POST", "POST"]);
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
      "provider_permission_denied",
      () => new ConnectorCallError("provider_permission_denied", "A check after applying the write failed"),
    ],
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

  it("INV-9: control: a custom connector's read keeps its retryable code and its grant-then-retry advice", async () => {
    let code: "rate_limited" | "provider_permission_denied" = "rate_limited";
    const { invoke } = custom(() => new ConnectorCallError(code, "Read refused"));
    const limited = await invoke.invoke("tickets.list_items", {}, { source: "call_tool" });
    if (limited.ok) throw new Error("expected the read to fail");
    expect(limited.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(limited.error.writeOutcome).toBeUndefined();
    code = "provider_permission_denied";
    const denied = await invoke.invoke("tickets.list_items", {}, { source: "call_tool" });
    if (denied.ok) throw new Error("expected the read to fail");
    expect(denied.error.retry).toMatch(/grant the required permission or scope, then retry/);
  });

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

describe("a write's input_required suspension is no proof the handler never ran (round 12)", () => {
  /** A real SDK server whose tools suspend for input after `create_item` applied. */
  function suspending() {
    const state = { applied: 0 };
    const downstream = httpDownstream((server) => {
      server.registerTool("create_item", { annotations: { readOnlyHint: false } }, async () => {
        state.applied++;
        return { resultType: "input_required", requestState: "write-already-applied" } as never;
      });
      server.registerTool("list_items", { annotations: { readOnlyHint: true } }, async () => {
        return { resultType: "input_required", requestState: "read-state" } as never;
      });
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => downstream.fetch(String(input), init));
    const connector = remoteMcp("tickets", { url: downstream.url });
    const registry = makeRegistry([connector]);
    return { state, connector, registry };
  }

  it("INV-9: a served write suspended for input is unknown, told to reconcile, and counted unknown by a program", async () => {
    const { state, connector, registry } = suspending();
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(state.applied).toBe(1);
    if (served.ok) throw new Error("expected the served write to fail");
    expect(served.error).toMatchObject({
      code: "input_required_unsupported",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(served.error.nextAction).toBeUndefined();
    expect(served.error.retry).toMatch(/^Do not resend this write\. Re-read its target/);
    expect(classifyWriteOutcome(served)).toBe("unknown");

    const program = await catchingProgram(registry, "tickets.create_item");
    expect(state.applied).toBe(2);
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
    await connector.closeScope?.(ctx);
  });

  it("INV-9: control: a read suspended for input keeps its direct-call nextAction", async () => {
    const { connector, registry } = suspending();
    const ctx = registry.contextFor("tickets", BASE);
    await connector.listTools(ctx);
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.list_items",
      {},
      { source: "call_tool" },
    );
    if (served.ok) throw new Error("expected the served read to fail");
    expect(served.error).toMatchObject({
      code: "input_required_unsupported",
      retryable: false,
      nextAction: { tool: "call_tool", arguments: { address: "tickets.list_items" } },
    });
    expect(served.error.writeOutcome).toBeUndefined();
    await connector.closeScope?.(ctx);
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

  it("INV-9: an untracked wrapper that sends on its own before one refused Stripe call never inherits the refusal", async () => {
    const { state, connector, storage, vault } = await billing();
    const wrapper = composite(connector, async (inner, ctx) => {
      await fetch("https://side.example/apply", { method: "POST" });
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
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome(served)).toBe("unknown");
  });

  it("INV-9: control: Stripe's own single DELETE refused 429 stays a known failure with its advice", async () => {
    const { state, connector, storage, vault } = await billing();
    state.sent = 1; // The next request is refused.
    const registry = makeRegistry([connector], { storage, credentialVault: vault });
    const served = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.stripe_api_write",
      stripeWrite("cus_2"),
      { source: "call_destructive_tool" },
    );
    expect(state).toEqual({ sent: 2, applied: 0 });
    if (served.ok) throw new Error("expected the refusal");
    expect(served.answered).toBe(true);
    expect(served.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(served.error.writeOutcome).toBeUndefined();
    expect(served.error.message).toMatch(/Back off before retrying\.$/);
    expect(classifyWriteOutcome(served)).toBe("failed");
    state.sent++; // The direct request is refused too.
    const direct = classifyCallError(
      await failure(connector.callTool("stripe_api_write", stripeWrite("cus_4"), registry.contextFor("billing", BASE))),
    );
    expect(direct).toMatchObject({ code: "rate_limited", retryable: true });
    expect(direct.message).toMatch(/Back off before retrying\.$/);
  });
});

describe("a logical call's identities are captured when they run (round 14)", () => {
  const stripeWrite = { method: "DELETE", path: "/v1/customers/cus_2" };

  /** Stripe, behind a vault, whose odd-numbered requests apply and even-numbered ones are refused 429. */
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

  /** A custom write whose `run` gets the connector itself, so it can reassign its own callTool. */
  function wrapping(inner: Connector, run: (self: Connector, ctx: ConnectorContext) => Promise<unknown>): Connector {
    const self: Connector = {
      id: "billing",
      kind: "api",
      ...(inner.credential ? { credential: inner.credential } : {}),
      description: "Composite operation",
      async listTools() {
        return [
          { name: "delete_pair", description: "Delete two", annotations: { readOnlyHint: false }, inputSchema: {} },
        ];
      },
      callTool: (_name, _args, ctx) => run(self, ctx),
    };
    return self;
  }

  async function served(registry: ReturnType<typeof makeRegistry>) {
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "billing.delete_pair",
      {},
      { source: "call_destructive_tool" },
    );
    if (outcome.ok) throw new Error("expected the served write to fail");
    return outcome;
  }

  it("INV-9: a wrapper that sends, reassigns its callTool to a declared delegator's, then rethrows a Stripe refusal is unknown", async () => {
    const delegator = github("github", {
      purpose: "Review",
      app: { appId: "12345", privateKey: PRIVATE_KEY },
      scopes: [{ org: "acme", access: "read-write" }],
    });
    const { state, connector, storage, vault } = await billing();
    const wrapper = wrapping(connector, async (self, ctx) => {
      await fetch("https://side.example/apply", { method: "POST" });
      self.callTool = delegator.callTool;
      return await connector.callTool("stripe_api_write", stripeWrite, ctx);
    });
    const initial = wrapper.callTool;
    const registry = makeRegistry([wrapper], { storage, credentialVault: vault });
    const outcome = await served(registry);
    expect(state).toEqual({ sent: 2, applied: 1 });
    expect(outcome.answered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(outcome.error.message).toBe("Stripe rate_limit_error: Rate limit");
    expect(classifyWriteOutcome(outcome)).toBe("unknown");

    wrapper.callTool = initial;
    const program = await catchingProgram(registry, "billing.delete_pair");
    expect(state).toEqual({ sent: 4, applied: 2 });
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 1 } },
    });
  });

  it("INV-9: a wrapper that reassigns the boundary's callTool to its own before entering it never passes for that boundary", async () => {
    let applied = 0;
    vi.stubGlobal("fetch", async () => {
      applied++;
      return Response.json({ ok: true });
    });
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => Response.json({}, { status: 429 }),
    });
    const boundary = tracksEveryRequest(
      api("billing", {
        tools: [
          {
            name: "create_item",
            description: "Create",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
            handler: (_args, ctx) =>
              send({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("rate_limited", "Tickets is throttling.");
              }),
          },
        ],
      }),
    );
    const own = boundary.callTool;
    const wrapper = wrapping(boundary, async (self, ctx) => {
      await fetch("https://side.example/apply", { method: "POST" });
      boundary.callTool = self.callTool;
      return await own.call(boundary, "create_item", {}, ctx);
    });
    const outcome = await served(makeRegistry([wrapper]));
    expect(applied).toBe(1);
    expect(outcome.answered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "rate_limited", retryable: false, writeOutcome: "unknown" });
    expect(classifyWriteOutcome(outcome)).toBe("unknown");
  });

  it("INV-9: a declared delegator's verdict is unaffected by reassigning its callTool after dispatch", async () => {
    let sent = 0;
    const boundary = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "create_item",
            description: "Create",
            annotations: { readOnlyHint: false },
            inputSchema: { type: "object" },
            // Refused before anything left: the ledger is empty.
            handler: async () => {
              throw new ConnectorCallError("invalid_args", "Tickets refused the item before sending it.");
            },
          },
        ],
      }),
    );
    const delegator: Connector = delegatesEachCall({
      id: "tickets",
      kind: "api",
      description: "Tickets",
      async listTools() {
        return [{ name: "create_item", description: "Create", annotations: { readOnlyHint: false }, inputSchema: {} }];
      },
      async callTool(name, args, ctx, options) {
        delegator.callTool = async () => {
          sent++;
          throw new Error("never invoked by this call");
        };
        return await boundary.callTool(name, args, ctx, options);
      },
    });
    const registry = makeRegistry([delegator]);
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create_item",
      {},
      { source: "call_destructive_tool" },
    );
    expect(sent).toBe(0);
    if (outcome.ok) throw new Error("expected the refusal");
    expect(outcome.answered).toBe(true);
    expect(outcome.error.code).toBe("invalid_args");
    expect(outcome.error.writeOutcome).toBeUndefined();
    expect(classifyWriteOutcome(outcome)).toBe("failed");
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

  it("INV-9: control: a read's isError is still the downstream's answer", async () => {
    const { invoke } = erroring();
    const served = await invoke.invoke("tickets.list_items", {}, { source: "call_tool" });
    if (served.ok) throw new Error("expected the served read to fail");
    expect(served.answered).toBe(true);
    expect(served.error).toMatchObject({ code: "connector_call_failed", message: "No such list.", retryable: false });
    expect(served.error.writeOutcome).toBeUndefined();
  });
});
