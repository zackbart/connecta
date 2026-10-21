// A dispatched write is a known failure only on refusal provenance recorded
// where the evidence was observed (#902 round 11): the ledger shows it never
// left, or the downstream served a refusing HTTP status (a 4xx other than
// 408). An error code thrown after dispatch (a mapper's rate_limited, an
// output validator's invalid_args, a JSON-RPC -32602) is never that evidence,
// on direct and served calls and in program accounting alike. Nor is an
// operation hint: only an idempotency key the vendor honors makes a direct
// write repeatable. Round 12: a custom connector, an input_required
// suspension, and a provider that reads a refusing status as `unavailable`
// prove nothing either.
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { createExecuteTool } from "../src/execute.js";
import { sheets } from "../src/providers/sheets/index.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import type { Executor } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { googleOptions } from "./fixtures/provider-options.js";
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
