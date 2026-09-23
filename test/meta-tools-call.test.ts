import { describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, registry, textOf } from "./fixtures/meta-tools.js";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { api } from "../src/connectors/api.js";
import { CatalogService } from "../src/catalog-service.js";
import { InvocationService } from "../src/invocation.js";
import { unwrapMcpResult } from "../src/mcp-result.js";
import { ConnectorCallError } from "../src/errors.js";
import {
  alignEndToCharBoundary,
  alignStartToCharBoundary,
  createMetaTools,
} from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import {
  activitySink,
  required,
  calcConnector,
  makeRegistry,
  silentLogger,
} from "./helpers.js";

/**
 * One get_result page, read the way a client does: a one-line JSON header,
 * a newline, and the raw page text.
 */
function pageOf(result: { content: { text: string }[] }): {
  offset: number;
  nextOffset?: number | undefined;
  totalBytes: number;
  text: string;
} {
  const whole = required(result.content[0]).text;
  const newline = whole.indexOf("\n");
  const header = JSON.parse(whole.slice(0, newline)) as {
    offset: number;
    totalBytes: number;
    hasMore: boolean;
    nextAction?: { arguments: { offset: number } };
  };
  return {
    offset: header.offset,
    ...(header.hasMore ? { nextOffset: header.nextAction?.arguments.offset } : {}),
    totalBytes: header.totalBytes,
    text: whole.slice(newline + 1),
  };
}

describe("call_tool", () => {
  it("JSON-wraps an api connector's return value", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "calc.add",
      args: { a: 2, b: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(required(result.content[0]).text)).toEqual({ sum: 5 });
  });

  it("passes an mcp connector's content array through as-is", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({
      address: "remote.echo",
      args: { text: "hi" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  it("optionally unwraps MCP content into a structured value envelope", async () => {
    const mt = createMetaTools(makeRegistry([jsonMcpConnector]), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "jm.rec",
        resultMode: "value",
      }),
    ) as { ok: boolean; data: unknown; durationMs: number };

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ a: 1, b: 2 });
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("turns downstream errors into isError results, not throws", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({ address: "calc.bogus", args: {} });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown tool");
  });

  it("returns an isError result for an unknown address", async () => {
    const mt = createMetaTools(registry(), BASE);
    const result = await mt.callTool({ address: "ghost.x" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown address");
  });

  it("returns structured errors in value mode", async () => {
    const mt = createMetaTools(registry(), BASE);
    const parsed = textOf(
      await mt.callTool({
        address: "ghost.x",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
      durationMs: number;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("unknown_address");
    expect(parsed.error.message).toContain("Unknown address");
    expect(parsed.error.retryable).toBe(false);
  });

  it("returns actionable recovery for unknown addresses and tools", async () => {
    const mt = createMetaTools(registry(), BASE);
    const address = textOf(
      await mt.callTool({ address: "ghost.read_items" }),
    ) as {
      error: { nextAction: Record<string, unknown> };
    };
    expect(address.error.nextAction).toEqual({
      tool: "search_tools",
      arguments: {
        query: "read items",
        includeSchemas: "compact",
      },
      purpose: "Find the configured canonical address before retrying.",
    });

    const tool = textOf(
      await mt.callTool({ address: "calc.missing_sum" }),
    ) as {
      error: { nextAction: Record<string, unknown> };
    };
    expect(tool.error.nextAction).toEqual({
      tool: "search_tools",
      arguments: {
        query: "missing sum",
        connector: "calc",
        includeSchemas: "compact",
      },
      purpose: "Find the connector's current canonical tool address.",
    });
  });

  it("routes annotated destructive tools through the approval-specific handler", async () => {
    let calls = 0;
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: {
            destructiveHint: true,
            readOnlyHint: false,
          },
          handler: () => {
            calls++;
            return { erased: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([dangerous]), BASE);

    const ordinary = await mt.callTool({
      address: "danger.erase",
      args: { target: "duplicate" },
    });
    expect(ordinary.isError).toBe(true);
    expect(textOf(ordinary)).toMatchObject({
      error: {
        nextAction: {
          tool: "call_destructive_tool",
          arguments: {
            address: "danger.erase",
            args: { target: "duplicate" },
          },
        },
      },
    });
    expect(calls).toBe(0);

    const approved = await mt.callDestructiveTool({
      address: "danger.erase",
      args: { target: "duplicate" },
      reason: "Remove the duplicate selected by the user.",
    });
    expect(approved.isError).toBeFalsy();
    expect(textOf(approved)).toEqual({ erased: true });
    expect(calls).toBe(1);
  });

  it("keeps a destructive refusal small when the arguments are not", async () => {
    // An error result is not size-guarded the way a result is, so echoing the
    // caller's arguments back unbounded once turned a 50 KB argument object
    // into a 101 KB refusal against a 1 KB cap — twice over, since it lands in
    // both the text content and structuredContent.
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: { destructiveHint: true, readOnlyHint: false },
          handler: () => ({ erased: true }),
        },
      ],
    });
    const mt = createMetaTools(
      makeRegistry([dangerous], { maxResultBytes: 1_000 }),
      BASE,
    );
    const huge = { blob: "x".repeat(50_000) };

    const direct = await mt.callTool({ address: "danger.erase", args: huge });
    const directBytes = JSON.stringify(direct).length;
    expect(direct.isError).toBe(true);
    expect(directBytes).toBeLessThan(4_000);
    expect(JSON.stringify(direct)).not.toContain("xxxxx");
    const refusal = textOf(direct) as {
      error: {
        nextAction: {
          arguments: { address: string; args?: unknown };
          purpose: string;
        };
      };
    };
    expect(refusal.error.nextAction.arguments).toEqual({
      address: "danger.erase",
    });
    expect(refusal.error.nextAction.purpose).toContain(
      "Re-send the arguments you just sent",
    );

    // Arguments that fit the echo budget still come back whole.
    const small = textOf(
      await mt.callTool({ address: "danger.erase", args: { target: "dupe" } }),
    ) as { error: { nextAction: { arguments: { args?: unknown } } } };
    expect(small.error.nextAction.arguments.args).toEqual({ target: "dupe" });
  });

  it("keeps a routing refusal small when the address is not", async () => {
    // The argument echo was bounded; the *address* was not. It reaches the
    // refusal twice over — once in the error message, once as the recovery
    // record's search query — and each of those lands in both the text content
    // and structuredContent, so a 50 KB invented address produced a 200 KB
    // refusal against a deployment that capped results at 1 KB.
    const mt = createMetaTools(
      makeRegistry([calcConnector], { maxResultBytes: 1_000 }),
      BASE,
    );
    const filler = "x".repeat(50_000);

    const unknownAddress = await mt.callTool({ address: `ghost.${filler}` });
    expect(unknownAddress.isError).toBe(true);
    expect(JSON.stringify(unknownAddress).length).toBeLessThan(4_000);
    const address = textOf(unknownAddress) as {
      error: {
        code: string;
        message: string;
        nextAction: { arguments: { query: string } };
      };
    };
    expect(address.error.code).toBe("unknown_address");
    expect(address.error.message).toContain("Unknown address");
    // Clamped, not dropped: the caller still learns which address was refused,
    // and the marker says it is not the whole of what it sent.
    expect(address.error.message).toContain("…");
    expect(address.error.nextAction.arguments.query).toContain("…");
    expect(address.error.nextAction.arguments.query.length).toBeLessThan(600);

    // Same bypass one resolution step later: the connector exists, the tool
    // name is the caller's invention.
    const unknownTool = await mt.callTool({ address: `calc.${filler}` });
    expect(unknownTool.isError).toBe(true);
    expect(JSON.stringify(unknownTool).length).toBeLessThan(4_000);
    const tool = textOf(unknownTool) as {
      error: {
        code: string;
        message: string;
        nextAction: { arguments: { query: string; connector: string } };
      };
    };
    expect(tool.error.code).toBe("unknown_tool");
    expect(tool.error.message).toContain("Unknown tool");
    expect(tool.error.nextAction.arguments.connector).toBe("calc");
    expect(tool.error.nextAction.arguments.query.length).toBeLessThan(600);

    // The common case must stay exact — a short address is corrected verbatim.
    const short = textOf(await mt.callTool({ address: "ghost.read_items" })) as {
      error: { message: string; nextAction: { arguments: { query: string } } };
    };
    expect(short.error.message).toBe('Unknown address "ghost.read_items"');
    expect(short.error.nextAction.arguments.query).toBe("read items");
  });

  it("keeps call_destructive_tool's reason out of the downstream arguments", async () => {
    const seen: unknown[] = [];
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          description: "Erase the thing",
          annotations: { destructiveHint: true, readOnlyHint: false },
          handler: (args: unknown) => {
            seen.push(args);
            return { erased: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([dangerous]), BASE);

    await mt.callDestructiveTool({
      address: "danger.erase",
      args: { target: "duplicate" },
      reason: "The user asked to remove the duplicate they selected.",
    });

    // `reason` is context for the host's approval view and stops there. It is
    // not authority, and a connector must never see it as an input.
    expect(seen).toEqual([{ target: "duplicate" }]);
    expect(Object.keys(required(seen[0]) as object)).toEqual(["target"]);
  });

  it("requires approval for unannotated and contradictory tools", async () => {
    const calls: string[] = [];
    // An unannotated tool no longer comes from api() — it refuses to
    // construct one — so it arrives the way it does in production: from a
    // catalog somebody else annotated, or forgot to.
    const silent: Connector = connectorWith({
      id: "silent",
      kind: "mcp",
      description: "A downstream that annotates nothing",
      tools: [{ name: "unannotated", description: "Who knows" }],
      call: async () => {
        calls.push("unannotated");
        return { ok: true };
      },
    });
    const ambiguous = api("ambiguous", {
      tools: [
        {
          name: "contradictory",
          description: "Claims to read and destroy at once",
          annotations: {
            readOnlyHint: true,
            destructiveHint: true,
          },
          handler: () => {
            calls.push("contradictory");
            return { ok: true };
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([silent, ambiguous]), BASE);

    for (const address of [
      "silent.unannotated",
      "ambiguous.contradictory",
    ]) {
      const ordinary = await mt.callTool({ address });
      expect(ordinary.isError).toBe(true);
      expect(required(ordinary.content[0]).text).toContain("not explicitly read-only");
    }
    expect(calls).toEqual([]);

    const approved = await mt.callDestructiveTool({
      address: "silent.unannotated",
    });
    expect(approved.isError).toBeFalsy();
    expect(calls).toEqual(["unannotated"]);
  });

  it("deduplicates concurrent request-local catalog loads", async () => {
    let catalogLoads = 0;
    const connector: Connector = connectorWith({
      id: "shared",
      kind: "api",
      tools: async () => {
        catalogLoads++;
        await Promise.resolve();
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      call: async () => ({ ok: true }),
    });
    // One meta-tool set is one inbound request, so its two concurrent calls
    // share the request-local catalog rather than each loading their own.
    const mt = createMetaTools(
      makeRegistry([connector], { toolCacheTtlSeconds: 0 }),
      BASE,
    );
    const results = await Promise.all([
      mt.callTool({ address: "shared.read", resultMode: "value" }),
      mt.callTool({ address: "shared.read", resultMode: "value" }),
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(catalogLoads).toBe(1);
  });

  it("does not retain failed request-local catalog loads", async () => {
    let catalogLoads = 0;
    const connector: Connector = connectorWith({
      id: "recovering",
      kind: "api",
      tools: async () => {
        catalogLoads++;
        if (catalogLoads === 1) throw new Error("catalog temporarily down");
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      call: async () => ({ ok: true }),
    });
    const mt = createMetaTools(
      makeRegistry([connector], { toolCacheTtlSeconds: 0 }),
      BASE,
    );
    expect(
      (
        textOf(
          await mt.callTool({
            address: "recovering.read",
            resultMode: "value",
          }),
        ) as { ok: boolean }
      ).ok,
    ).toBe(false);
    expect(
      (
        textOf(
          await mt.callTool({
            address: "recovering.read",
            resultMode: "value",
          }),
        ) as { ok: boolean }
      ).ok,
    ).toBe(true);
    expect(catalogLoads).toBe(2);
  });

  it("returns transient failures after one attempt and preserves read-only admission", async () => {
    let safeCalls = 0;
    let unsafeCalls = 0;
    const connector = api("retry", {
      tools: [
        {
          name: "safe_read",
          description: "Read a value, retryably",
          annotations: { readOnlyHint: true },
          handler: () => {
            safeCalls++;
            if (safeCalls === 1) throw new Error("temporary 503");
            return { ok: true };
          },
        },
        {
          name: "unsafe_write",
          description: "Write something the host must approve",
          annotations: { readOnlyHint: false },
          handler: () => {
            unsafeCalls++;
            throw new Error("temporary 503");
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const safe = textOf(
      await mt.callTool({
        address: "retry.safe_read",
        resultMode: "value",

        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      timing: {
        catalogMs: number;
        connectorMs: number;
        resultProcessingMs: number;
        totalMs: number;
      };
    };
    const unsafe = textOf(
      await mt.callTool({
        address: "retry.unsafe_write",
        resultMode: "value",

      }),
    ) as { ok: boolean; attempts: number };

    expect(safe).toMatchObject({ ok: false, attempts: 1, error: { retryable: true } });
    expect(safe.timing.connectorMs).toBeGreaterThanOrEqual(0);
    expect(safe.timing).not.toHaveProperty("backoffMs");
    expect(safe.timing.totalMs).toBeGreaterThanOrEqual(safe.timing.connectorMs);
    expect(safeCalls).toBe(1);
    expect(unsafe).toMatchObject({
      ok: false,
      attempts: 0,
      error: { code: "destructive_tool_requires_approval" },
    });
    expect(unsafeCalls).toBe(0);
  });

  it("passes a deadline signal to API handlers and returns a timeout error", async () => {
    let sawSignal = false;
    const connector = api("slow", {
      tools: [
        {
          name: "wait",
          description: "Wait until the deadline",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            sawSignal = Boolean(ctx.signal);
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { completedAfterAbort: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "slow.wait",
        resultMode: "value",
        timeoutMs: 10,
      }),
    ) as {
      ok: boolean;
      error: { message: string; retryable: boolean };
      attempts: number;
    };
    expect(sawSignal).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain("timed out");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.attempts).toBe(1);
  });

  it("no default deadline unless the deployment configures one", async () => {
    const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = [];
    const connector = api("budget", {
      tools: [
        {
          name: "peek",
          description: "Report the request context it received",
          annotations: { readOnlyHint: true },
          handler: (_args, ctx) => {
            seen.push({
              ...(ctx.timeoutMs !== undefined
                ? { timeoutMs: ctx.timeoutMs }
                : {}),
              hasSignal: Boolean(ctx.signal),
            });
            return { ok: true };
          },
        },
      ],
    });
    const call = { address: "budget.peek", resultMode: "value" as const };

    // Today's behaviour, unchanged: no budget and no way to be cancelled.
    await createMetaTools(makeRegistry([connector]), BASE).callTool(call);
    expect(seen[0]).toEqual({ timeoutMs: undefined, hasSignal: false });

    // defaultToolTimeoutMs fills the gap for callers that pass none…
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).callTool(call);
    expect(seen[1]).toEqual({ timeoutMs: 5_000, hasSignal: true });

    // …and an explicit per-call timeoutMs still wins over it.
    await createMetaTools(makeRegistry([connector]), BASE, {
      defaultToolTimeoutMs: 5_000,
    }).callTool({ ...call, timeoutMs: 25 });
    expect(seen[2]).toEqual({ timeoutMs: 25, hasSignal: true });
  });

  it("a configured default deadline aborts and times out a hanging call", async () => {
    const connector = api("stuck", {
      tools: [
        {
          name: "wait",
          description: "Wait until the deadline",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { completedAfterAbort: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE, {
        defaultToolTimeoutMs: 10,
      }).callTool({ address: "stuck.wait", resultMode: "value" }),
    ) as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
    });
  });

  it("surfaces a connector's retryAfterMs in the error envelope", async () => {
    const connector = api("limited", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("rate_limited", "slow down", {
              retryAfterMs: 3_600_000,
            });
          },
        },
      ],
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const parsed = textOf(
      await mt.callTool({ address: "limited.read", resultMode: "value" }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean; retryAfterMs?: number };
    };
    // Reported verbatim even though the engine would never wait this long
    // itself — an hour is the agent's decision to make, not the engine's.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "rate_limited", retryable: true, retryAfterMs: 3_600_000 },
    });
  });

  it("omits retryAfterMs when the connector reports no window", async () => {
    const connector = api("plain", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError("rate_limited", "slow down");
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "plain.read",
        resultMode: "value",
      }),
    ) as { error: Record<string, unknown> };
    expect(parsed.error).toEqual({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
    });
  });

  it("a typed non-retryable error is not retried even if its text says timeout", async () => {
    let calls = 0;
    const connector = api("typed", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            throw new ConnectorCallError(
              "connector_call_failed",
              'downstream rejected field "timeout"',
              { retryable: false },
            );
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "typed.read",
        resultMode: "value",

      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    // The regex heuristic would have coded this "timeout" and retried it.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "connector_call_failed", retryable: false },
    });
    expect(calls).toBe(1);
  });

  it("a typed auth_required from a call keeps its code so the agent can re-auth", async () => {
    const connector = api("expired", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError(
              "auth_required",
              'Connector "expired" requires authorization — call authorize_connector({ connector: "expired" }).',
            );
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "expired.read",
        resultMode: "value",

      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        retry: string;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.attempts).toBe(1);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.message).toContain("authorize_connector");
    expect(parsed.error).toMatchObject({
      connector: "expired",
      operation: "expired.read",
      recovery: "unavailable",
      nextAction: {
        tool: "authorize_connector",
        arguments: { connector: "expired" },
      },
    });
    expect(parsed.error.retry).toContain("expired.read");
  });

  it("returns the same structured auth_required envelope in MCP result mode", async () => {
    const connector = api("expired", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new ConnectorCallError(
              "auth_required",
              "Authorization is required.",
            );
          },
        },
      ],
    });
    const result = await createMetaTools(
      makeRegistry([connector]),
      BASE,
    ).callTool({ address: "expired.read" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({
      ok: false,
      error: {
        code: "auth_required",
        connector: "expired",
        operation: "expired.read",
        recovery: "unavailable",
      },
    });
  });

  it("schema-invalid args fail closed as invalid_args without reaching the handler", async () => {
    let calls = 0;
    const connector = api("strict", {
      tools: [
        {
          name: "page",
          description: "Read one page of values",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { page: { type: "integer" } },
            required: ["page"],
          },
          handler: () => {
            calls++;
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "strict.page",
        resultMode: "value",
        args: { page: "3" },

      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { code: string; retryable: boolean };
    };
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "invalid_args", retryable: false },
    });
    expect(calls).toBe(0);
  });

  it("classifies remote schema mismatches consistently without provider prose", async () => {
    let calls = 0;
    const connector: Connector = connectorWith({
      id: "remote_strict",
      kind: "mcp",
      tools: async () => {
        const inputSchema = {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            options: {
              type: "object" as const,
              properties: { enabled: { type: "boolean" as const } },
              required: ["enabled"],
            },
          },
          required: ["title", "options"],
        };
        return [
          {
            name: "read",
            annotations: { readOnlyHint: true },
            inputSchema,
          },
          {
            name: "write",
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema,
          },
          {
            name: "provider_only",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { value: { $ref: "#/definitions/missing" } },
            },
          },
        ];
      },
      call: async (name) => {
        calls++;
        if (name === "provider_only") {
          throw new Error(
            'Malformed validation text: path=/value value="provider-secret"',
          );
        }
        return { content: [{ type: "text", text: "unexpected dispatch" }] };
      },
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const args = {
      options: { enabled: "submitted-secret" },
    };
    const expected = {
      ok: false,
      attempts: 0,
      error: {
        code: "invalid_args",
        retryable: false,
        connector: "remote_strict",
        validation: {
          issues: [
            { path: "/title", code: "required", expected: "string" },
            {
              path: "/options/enabled",
              code: "type",
              expected: "boolean",
            },
          ],
        },
        nextAction: {
          tool: "search_tools",
          arguments: {
            connector: "remote_strict",
            includeSchemas: "compact",
          },
        },
      },
    };

    const direct = textOf(
      await mt.callTool({ address: "remote_strict.read", args }),
    );
    const destructive = textOf(
      await mt.callDestructiveTool({
        address: "remote_strict.write",
        args,
      }),
    );
    expect(direct).toMatchObject({
      ...expected,
      error: { ...expected.error, operation: "remote_strict.read" },
    });
    expect(destructive).toMatchObject({
      ...expected,
      error: { ...expected.error, operation: "remote_strict.write" },
    });

    expect(JSON.stringify([direct, destructive])).not.toContain(
      "submitted-secret",
    );
    expect(calls).toBe(0);

    const providerOnly = textOf(
      await mt.callTool({
        address: "remote_strict.provider_only",
        args: { value: "provider-secret" },
        resultMode: "value",
      }),
    ) as { error: { code: string; validation?: unknown } };
    expect(providerOnly.error).toMatchObject({
      code: "connector_call_failed",
    });
    expect(providerOnly.error.validation).toBeUndefined();
    expect(calls).toBe(1);
  });
});

// An API connector returning a result large enough to exercise paging.
const dataConnector: Connector = connectorWith({
  id: "data",
  kind: "api",
  description: "Data",
  tools: [
    {
      name: "big",
      description: "Return a large blob",
      annotations: { readOnlyHint: true },
    },
  ],
  call: async (name) => {
    if (name === "big") return { blob: "x".repeat(500) };
    throw new Error(`Unknown tool "${name}" on connector "data"`);
  },
});

// An MCP connector whose JSON text can be unwrapped in value mode.
const jsonMcpConnector: Connector = connectorWith({
  id: "jm",
  kind: "mcp",
  description: "JSON mcp",
  tools: [
      {
        name: "rec",
        description: "record",
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      },
    ],
  call: async () => ({
      content: [{ type: "text", text: JSON.stringify({ a: 1, b: 2 }) }],
    }),
});

describe("call_tool size guard + get_result", () => {
  it("truncates oversized results and pages the rest via get_result", async () => {
    const registryWithData = makeRegistry([dataConnector], {
      maxResultBytes: 100,
    });
    const mt = createMetaTools(registryWithData, BASE);
    const result = await mt.callTool({ address: "data.big" });
    const lines = required(result.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as {
      truncated: boolean;
      resultId: string;
      totalBytes: number;
      nextAction: {
        tool: string;
        arguments: { id: string; offset: number };
      };
    };
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBeGreaterThan(100);
    expect(notice.nextAction).toEqual({
      tool: "get_result",
      arguments: { id: notice.resultId, offset: 100 },
    });

    // Round-trip the full text back through get_result.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = pageOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 100 })
      );
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(JSON.stringify({ blob: "x".repeat(500) }));
  });

  it("returns an error for an unknown/expired result id", async () => {
    const mt = createMetaTools(makeRegistry([dataConnector]), BASE);
    const result = await mt.getResult({ id: "nope" });
    expect(result.isError).toBe(true);
    expect(required(result.content[0]).text).toContain("Unknown or expired");
  });

  it("replaces oversized value-mode data with a page handle", async () => {
    const mt = createMetaTools(
      makeRegistry([dataConnector], { maxResultBytes: 100 }),
      BASE,
    );
    const parsed = textOf(
      await mt.callTool({
        address: "data.big",
        resultMode: "value",
      }),
    ) as {
      ok: boolean;
      data: { truncated: boolean; resultId: string; totalBytes: number };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.data.truncated).toBe(true);
    expect(parsed.data.totalBytes).toBeGreaterThan(100);
    expect(parsed.data).toMatchObject({
      nextAction: {
        tool: "get_result",
        arguments: { id: parsed.data.resultId, offset: 0 },
      },
    });
    let text = "";
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = pageOf(
        await mt.getResult({ id: parsed.data.resultId, offset, maxBytes: 1_000 })
      );
      expect(page.text.length).toBeLessThanOrEqual(100);
      text += page.text;
      offset = page.nextOffset;
    }
    expect(JSON.parse(text)).toEqual({ blob: "x".repeat(500) });
  });

  it("pages multi-byte content at a codepoint-splitting boundary byte-exactly", async () => {
    // "aa😀bb" — the emoji is 4 UTF-8 bytes, so a 4-byte page ending at byte 4
    // lands mid-codepoint. Reassembly must equal the original with no U+FFFD.
    const original = JSON.stringify({ v: "aa😀bb界🎉cc" });
    const conn: Connector = connectorWith({
      id: "mb",
      kind: "api",
      description: "Multibyte",
      tools: [
          {
            name: "get",
            description: "unicode",
            annotations: { readOnlyHint: true },
          },
        ],
      call: async () => JSON.parse(original),
    });
    // cap of 4 forces truncation and 4-byte pages that split codepoints.
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 4 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as { resultId: string };

    const expected = JSON.stringify(JSON.parse(original));
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = pageOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 4 })
      );
      expect(page.text).not.toContain("�");
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(expected);
  });

  it("guardText's truncated head never ends in a replacement char", async () => {
    // Emoji straddles the cap boundary; the head must stop before it.
    const conn: Connector = connectorWith({
      id: "mb2",
      kind: "api",
      description: "Multibyte head",
      tools: [
          {
            name: "get",
            description: "unicode",
            annotations: { readOnlyHint: true },
          },
        ],
      call: async () => "abc😀defghijklmnop",
    });
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 5 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb2.get" });
    const head = required(call.content[0]).text.split("\n")[1];
    expect(head).not.toContain("�");
    // Head is a byte-exact prefix of the original (JSON-encoded) string.
    const full = JSON.stringify("abc😀defghijklmnop");
    expect(full.startsWith(required(head))).toBe(true);
  });
});

// ASCII, so byte length == char length, and it JSON-encodes to one line.
const PAYLOAD = "x".repeat(500);
const FULL = JSON.stringify(PAYLOAD); // 502 bytes

/** An api connector returning PAYLOAD, optionally under its own byte cap. */
function capped(id: string, maxResultBytes?: number): Connector {
    return connectorWith({
      id,
      kind: "api",
      description: "Capped",
      ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      tools: [
          {
            name: "big",
            description: "Return a large blob",
            annotations: { readOnlyHint: true },
          },
        ],
      call: async () => PAYLOAD,
    });
}

describe("per-connector maxResultBytes override", () => {

  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  /** Split a guarded text result into its head and its truncation notice. */
  function truncation(result: { content: { text: string }[] }): {
    head: string;
    notice: Notice;
  } {
    const [notice, head] = required(result.content[0]).text.split("\n");
    return {
      head: required(head),
      notice: JSON.parse(required(notice)) as Notice,
    };
  }

  it.each([
    ["truncates at a connector cap lower than the global one", "tight", 100, 400, 100, true],
    ["keeps a result inline under a connector cap higher than the global one", "wide", 1_000, 100, null, false],
    ["falls back to the global cap when a connector declares no override", "plain", undefined, 300, 300, true],
    ["falls back to the registry default when nothing is configured", "plain", undefined, undefined, null, false],
  ] as const)("%s", async (_name, id, override, deploymentCap, expectedHead, truncated) => {
    const mt = createMetaTools(
      makeRegistry([capped(id, override)], deploymentCap === undefined ? {} : { maxResultBytes: deploymentCap }),
      BASE,
    );
    const result = await mt.callTool({ address: `${id}.big` });
    if (!truncated) {
      expect(required(result.content[0]).text).toBe(FULL);
      return;
    }
    const guarded = truncation(result);
    expect(guarded.head).toBe(FULL.slice(0, required(expectedHead)));
    expect(guarded.notice.truncated).toBe(true);
    expect(guarded.notice.totalBytes).toBe(FULL.length);
  });

  it("pages a result truncated under an override through get_result", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("tight", 100)], { maxResultBytes: 400 }),
      BASE,
    );
    const { notice } = truncation(await mt.callTool({ address: "tight.big" }));

    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = pageOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 64 })
      );
      expect(page.totalBytes).toBe(FULL.length);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("pages an override-truncated result with get_result's default page size", async () => {
    // Cap above the global one but below the payload: truncation happens at
    // the connector's 300, and get_result, given no maxBytes, pages at that
    // same 300 the stash recorded — not the deployment-wide 100.
    const mt = createMetaTools(
      makeRegistry([capped("wide", 300)], { maxResultBytes: 100 }),
      BASE,
    );
    const { head, notice } = truncation(
      await mt.callTool({ address: "wide.big" }),
    );
    expect(head).toBe(FULL.slice(0, 300));

    let offset = 0;
    let assembled = "";
    let pages = 0;
    for (;;) {
      const page = pageOf(
        await mt.getResult({ id: notice.resultId, offset })
      );
      pages++;
      expect(page.totalBytes).toBe(FULL.length);
      expect(page.text.length).toBeLessThanOrEqual(300);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    // 502 bytes in 300-byte default pages — the connector's cap, recorded
    // with the stash, not the deployment's 100.
    expect(pages).toBe(2);
    expect(assembled).toBe(FULL);
  });

  it("value mode honours the override too", async () => {
    const mt = createMetaTools(
      makeRegistry([capped("tight", 100), capped("wide", 1_000)], {
        maxResultBytes: 400,
      }),
      BASE,
    );
    const truncated = textOf(
      await mt.callTool({ address: "tight.big", resultMode: "value" }),
    ) as { data: { truncated?: boolean; totalBytes?: number } };
    const inline = textOf(
      await mt.callTool({ address: "wide.big", resultMode: "value" }),
    ) as { data: unknown };

    expect(truncated.data.truncated).toBe(true);
    expect(truncated.data.totalBytes).toBe(FULL.length);
    expect(inline.data).toBe(PAYLOAD);
  });
});

describe("maxResultBytes validation", () => {
  /** Caps that are accepted today but silently do something wrong (issue #32). */
  const BAD_CAPS = [0, -1, -50, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  /** Stash an oversized result and hand back its page id. */
  async function stash(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const mt = createMetaTools(
      makeRegistry([capped("c")], { maxResultBytes: 100 }),
      BASE,
    );
    const call = await mt.callTool({ address: "c.big" });
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[0])) as {
      resultId: string;
    };
    return { mt, resultId: notice.resultId };
  }

  it.each(BAD_CAPS)("rejects get_result maxBytes %s", async (maxBytes) => {
    const { mt, resultId } = await stash();
    const result = await mt.getResult({ id: resultId, maxBytes });
    expect(result.isError, `maxBytes ${String(maxBytes)}`).toBe(true);
    expect(required(result.content[0]).text).toContain("Invalid maxBytes");
  });

  it("accepts the 1-byte floor and still pages to completion", async () => {
    const { mt, resultId } = await stash();
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < FULL.length + 10; guard++) {
      const page = pageOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 1 })
      );
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("always advances past the offset, whatever end is asked for", () => {
    // Belt and braces behind the argument check: an empty or inverted window
    // must still yield forward progress rather than nextOffset === offset.
    const bytes = new TextEncoder().encode('"aa😀bb"');
    for (const end of [-5, 0, 1, 2]) {
      expect(
        alignEndToCharBoundary(bytes, 1, end, bytes.length),
        `end ${end}`,
      ).toBeGreaterThan(1);
    }
    // At a multi-byte codepoint the widened window still lands on a boundary:
    // byte 3 starts the 4-byte emoji, so the whole emoji comes along.
    expect(alignEndToCharBoundary(bytes, 3, 3, bytes.length)).toBe(7);
  });

  it.each(BAD_CAPS)("ignores deployment cap %s", async (maxResultBytes) => {
    const mt = createMetaTools(
      makeRegistry([capped("c")], { maxResultBytes }),
      BASE,
    );
    const result = await mt.callTool({ address: "c.big" });
    // Falls back to the built-in 24_000, so 502 bytes stay inline whole.
    expect(required(result.content[0]).text, `cap ${String(maxResultBytes)}`).toBe(FULL);
  });

  it.each(BAD_CAPS)("ignores connector override %s", async (override) => {
    const mt = createMetaTools(
      makeRegistry([capped("c", override)], { maxResultBytes: 400 }),
      BASE,
    );
    const result = await mt.callTool({ address: "c.big" });
    const [, head] = required(result.content[0]).text.split("\n");
    // Inherits the deployment-wide 400 exactly as an unset override would.
    expect(head, `override ${String(override)}`).toBe(FULL.slice(0, 400));
  });

  it("warns with the very cap a call then falls back to", async () => {
    // The startup warning quotes a number; a call inheriting that fallback
    // must truncate at exactly it, or the warning tells operators a fiction.
    const warnings: string[] = [];
    const registry = new Registry([capped("c", 0)], {
      storage: memoryStorage(),
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
      maxResultBytes: 400,
    });
    const warning = warnings.find((w) => w.includes("Ignoring the override"));
    const warned = Number(/\((\d+)\)\.$/.exec(warning ?? "")?.[1]);
    expect(warned).toBe(400);

    const result = await createMetaTools(registry, BASE).callTool({
      address: "c.big",
    });
    expect(required(result.content[0]).text.split("\n")[1]).toBe(FULL.slice(0, warned));
  });

  it("leaves valid caps byte-identical at every level", async () => {
    // The floor, a tiny cap, and a cap either side of the payload — all
    // unchanged by validation.
    for (const cap of [1, 4, 100, 400, 1_000]) {
      const viaGlobal = await createMetaTools(
        makeRegistry([capped("c")], { maxResultBytes: cap }),
        BASE,
      ).callTool({ address: "c.big" });
      const viaOverride = await createMetaTools(
        makeRegistry([capped("c", cap)], { maxResultBytes: 50_000 }),
        BASE,
      ).callTool({ address: "c.big" });
      const expected = cap >= FULL.length ? FULL : FULL.slice(0, cap);
      const preview = (result: typeof viaGlobal) =>
        cap >= FULL.length
          ? required(result.content[0]).text
          : required(result.content[0]).text.split("\n")[1];
      expect(preview(viaGlobal), `global ${cap}`).toBe(expected);
      expect(preview(viaOverride), `override ${cap}`).toBe(expected);
    }
  });
});

/** UTF-8 byte length, the unit every cap and offset in these suites is in. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Assert a result is valid against the MCP schema as a client receives it. */
function overTheWire(result: unknown): {
  content: { type: string; text?: string }[];
} {
  const serialized = JSON.parse(JSON.stringify(result));
  const parsed =
    specTypeSchemas.CallToolResult["~standard"].validate(serialized);
  expect(parsed.issues, JSON.stringify(serialized)).toBeUndefined();
  return serialized;
}

describe("handler returns JSON cannot represent", () => {
  /** An api connector whose one read-only tool returns `value`. */
  function returning(value: unknown): Connector {
    return api("ret", {
      description: "Returns a canned value",
      tools: [
        {
          name: "get",
          description: "Return the canned value",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => value,
        },
      ],
    });
  }

  function callFor(value: unknown) {
    return createMetaTools(makeRegistry([returning(value)]), BASE).callTool({
      address: "ret.get",
    });
  }

  it("renders an undefined return as text instead of a block with no text", async () => {
    // Pre-fix this emitted `{"type":"text"}` — schema-invalid, because
    // JSON.stringify(undefined) is undefined and the size guard measured the
    // empty string the TextEncoder substituted for it (issue #42).
    const result = await callFor(undefined);
    expect(overTheWire(result).content).toEqual([
      { type: "text", text: "undefined" },
    ]);
  });

  it("renders the other returns JSON drops the same way", async () => {
    // A function and a Symbol also serialize as `undefined`.
    const fn = () => 1;
    const sym = Symbol("marker");
    for (const value of [fn, sym]) {
      const result = await callFor(value);
      expect(overTheWire(result).content).toEqual([
        { type: "text", text: String(value) },
      ]);
    }
  });

  it("renders null as JSON null on both result paths", async () => {
    // `null` was never the hole — JSON renders it as "null" — so this pins it.
    const mcp = await callFor(null);
    expect(overTheWire(mcp).content).toEqual([{ type: "text", text: "null" }]);

    const value = await createMetaTools(
      makeRegistry([returning(null)]),
      BASE,
    ).callTool({ address: "ret.get", resultMode: "value" });
    expect(overTheWire(value)).toBeTruthy();
    expect(textOf(value)).toMatchObject({ ok: true, data: null });
  });

  it("carries no data for an undefined return in value mode", async () => {
    // JSON has no `undefined`, so the envelope simply omits the key — a
    // well-formed answer, unlike the block the mcp path used to emit.
    const result = await createMetaTools(
      makeRegistry([returning(undefined)]),
      BASE,
    ).callTool({ address: "ret.get", resultMode: "value" });
    const parsed = textOf(result) as Record<string, unknown>;
    expect(overTheWire(result)).toBeTruthy();
    expect(parsed.ok).toBe(true);
    expect("data" in parsed).toBe(false);
  });

  it("leaves a serializable return byte-identical", async () => {
    const value = { user: { name: "Ada" }, ids: [1, 2, 3] };
    const result = await callFor(value);
    expect(required(result.content[0]).text).toBe(JSON.stringify(value));
  });

  it("stashes an oversized undefined-adjacent return under the same text", async () => {
    // The guard measures and stashes one string on every path, so what pages
    // back is what was measured — even for a return JSON cannot represent.
    const long = "y".repeat(500);
    const mt = createMetaTools(
      makeRegistry([returning(long)], { maxResultBytes: 100 }),
      BASE,
    );
    const call = await mt.callTool({ address: "ret.get" });
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[0])) as {
      resultId: string;
      totalBytes: number;
    };
    const full = JSON.stringify(long);
    expect(notice.totalBytes).toBe(byteLength(full));
    let text = "";
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = pageOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 10_000 }),
      );
      text += page.text;
      offset = page.nextOffset;
    }
    expect(text).toBe(full);
  });
});

describe("mcp-mode content size guard", () => {
  /** A kind:"mcp" connector whose one tool returns `content` verbatim. */
  function downstream(content: unknown[]): Connector {
    return connectorWith({
      id: "down",
      kind: "mcp",
      description: "Downstream MCP",
      tools: [
          {
            name: "fetch",
            description: "Return canned content",
            annotations: { readOnlyHint: true },
          },
        ],
      call: async () => ({ content }),
    });
  }

  function metaTools(content: unknown[], maxResultBytes?: number) {
    return createMetaTools(
      makeRegistry(
        [downstream(content)],
        maxResultBytes !== undefined ? { maxResultBytes } : {},
      ),
      BASE,
    );
  }

  /** What `call_tool` stashes and pages for an oversized mcp result. */
  function envelope(content: unknown[]): string {
    return JSON.stringify(content);
  }

  interface Notice {
    truncated: boolean;
    resultId: string;
    totalBytes: number;
  }

  it("measures the envelope it truncates, not just the text inside it", async () => {
    // 12 blocks of 20 characters: 240 bytes of text, but a 700+ byte envelope
    // once block wrappers, keys, quoting and indentation are counted. Pre-fix
    // the decision used the 240 while the head and totalBytes were cut from
    // the envelope, so a cap between the two returned everything inline and a
    // cap under both described a string it never compared against (issue #43).
    const content = Array.from({ length: 12 }, (_, i) => ({
      type: "text",
      text: `block-${i}`.padEnd(20, "x"),
    }));
    const full = envelope(content);
    const textOnly = content.reduce((n, b) => n + byteLength(b.text), 0);
    const cap = 300;
    expect(textOnly).toBeLessThan(cap);
    expect(byteLength(full)).toBeGreaterThan(cap);

    const result = await metaTools(content, cap).callTool({
      address: "down.fetch",
    });
    const lines = required(result.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as Notice;
    const head = lines.slice(1).join("\n");
    expect(notice.truncated).toBe(true);
    // One unit for the cap and totalBytes: the envelope. The preview is the
    // blocks' readable text, bounded by the same cap.
    expect(notice.totalBytes).toBe(byteLength(full));
    expect(head).toBe(content.map((b) => b.text).join("\n").slice(0, cap));
    expect(byteLength(head)).toBeLessThanOrEqual(cap);
  });

  it("bounds an all-image result and hands back a page handle", async () => {
    // Pre-fix contentBytes([image]) was 0, so `0 > cap` was false and the whole
    // 50 KB envelope came back inline with no resultId to page from — the one
    // guarantee maxResultBytes exists to give, missing entirely.
    const content = [
      { type: "image", data: "A".repeat(50_000), mimeType: "image/png" },
    ];
    const full = envelope(content);
    const cap = 1_000;
    const mt = metaTools(content, cap);
    const result = await mt.callTool({ address: "down.fetch" });

    expect(overTheWire(result).content).toHaveLength(1);
    const notice = JSON.parse(required(result.content[0]).text) as Notice;
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(byteLength(full));
    expect(byteLength(required(result.content[0]).text)).toBeLessThan(cap);
    // The notice alone — no prefix of a base64 image, which no client could use.
    expect(required(result.content[0]).text).not.toContain("AAAA");

    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = pageOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 10_000 })
      );
      expect(page.totalBytes).toBe(byteLength(full));
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(full);
    expect(JSON.parse(assembled)).toEqual(content);
  });

  it("counts text and non-text blocks together", async () => {
    const content = [
      { type: "text", text: "a caption" },
      {
        type: "resource",
        resource: { uri: "file:///big", text: "z".repeat(5_000) },
      },
    ];
    const result = await metaTools(content, 1_000).callTool({
      address: "down.fetch",
    });
    const notice = JSON.parse(required(result.content[0]).text) as Notice;
    expect(notice.truncated).toBe(true);
    expect(notice.totalBytes).toBe(byteLength(envelope(content)));
  });

  it("passes an unserializable under-cap result through instead of failing", async () => {
    // The guard has to serialize the envelope to measure it, but a block
    // carrying a BigInt or a cycle cannot be serialized — and could not be
    // stashed or paged either, so the cap has nothing to offer it. Such a result
    // came back inline under the old text-only measure; failing it with
    // result_processing_failed would be a regression, not a fix.
    const withBigInt = [{ type: "text", text: "small", size: 1n }];
    const circular: Record<string, unknown>[] = [
      { type: "text", text: "small" },
    ];
    required(circular[0]).self = circular[0];
    for (const content of [withBigInt, circular]) {
      const result = await metaTools(content).callTool({
        address: "down.fetch",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(required(result.content[0]).text).toBe("small");
    }
    // The block reaches the client exactly as the downstream produced it.
    const result = await metaTools(withBigInt).callTool({
      address: "down.fetch",
    });
    expect((result.content[0] as unknown as Record<string, unknown>).size).toBe(
      1n,
    );
  });

  it("passes an under-cap result through untouched, blocks and order intact", async () => {
    const content = [
      { type: "text", text: "first" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: "last" },
    ];
    const result = await metaTools(content).callTool({ address: "down.fetch" });
    expect(result.content).toEqual(content);
    expect(overTheWire(result).content).toEqual(content);
  });
});

describe("get_result offset validation and alignment", () => {
  // Stored as `"aa😀bb"` — byte 3 starts the 4-byte emoji, so bytes 4, 5 and 6
  // are inside a character and byte 3 is the boundary they belong to.
  const EMOJI_PAYLOAD = "aa😀bb";
  const EMOJI_FULL = JSON.stringify(EMOJI_PAYLOAD);
  const EMOJI_START = 3;

  async function stashEmoji(): Promise<{
    mt: ReturnType<typeof createMetaTools>;
    resultId: string;
  }> {
    const conn = api("mb", {
      description: "Multibyte",
      tools: [
        {
          name: "get",
          description: "unicode",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => EMOJI_PAYLOAD,
        },
      ],
    });
    // A cap of 9, one byte under the payload, stashes it whole; pages are
    // clamped to that cap, so it is also wide enough for the 100-byte requests
    // below to reach the end from any offset.
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 9 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[0])) as { resultId: string };
    return { mt, resultId: notice.resultId };
  }

  it.each([
    -50,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects in-process offset %s", async (offset) => {
    // The tier #32 chose to defend for maxBytes: MCP callers are stopped by the
    // registered schema, in-process callers of createMetaTools are not. Pre-fix
    // `offset: NaN` answered with `"offset": null`, empty text and no
    // nextOffset — the result silently vanished instead of erroring (issue #38).
    const { mt, resultId } = await stashEmoji();
    const result = await mt.getResult({ id: resultId, offset });
    expect(result.isError, `offset ${String(offset)}`).toBe(true);
    expect(required(result.content[0]).text).toContain("Invalid offset");
  });

  it.each([4, 5, 6])(
    "aligns offset %s landing inside a character",
    async (requested) => {
    // Pre-fix these decoded the severed bytes as U+FFFD.
    const { mt, resultId } = await stashEmoji();
    const page = pageOf(
      await mt.getResult({ id: resultId, offset: requested, maxBytes: 100 })
    );
    expect(page.text, `offset ${requested}`).not.toContain("�");
    expect(page.offset, `offset ${requested}`).toBe(EMOJI_START);
    expect(page.text).toBe("😀bb\"");
    expect(page.totalBytes).toBe(byteLength(EMOJI_FULL));
    },
  );

  it("leaves a boundary-aligned offset byte-identical", async () => {
    const { mt, resultId } = await stashEmoji();
    // Every boundary in the payload, including the ones paging produces.
    for (const offset of [0, 1, 2, EMOJI_START, 7, 8]) {
      const page = pageOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 100 })
      );
      expect(page.offset, `offset ${offset}`).toBe(offset);
      expect(page.text).not.toContain("�");
    }
    // And a full paging loop still reassembles the stashed text exactly.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = pageOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 3 })
      );
      expect(page.text).not.toContain("�");
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(EMOJI_FULL);
  });

  it("answers an offset past the end with an empty final page", async () => {
    // Still a whole number of bytes, so still legal: an empty last page rather
    // than an error, and nothing to align.
    const { mt, resultId } = await stashEmoji();
    const page = pageOf(
      await mt.getResult({ id: resultId, offset: byteLength(EMOJI_FULL) + 5 }),
    );
    expect(page.text).toBe("");
    expect(page.offset).toBe(byteLength(EMOJI_FULL) + 5);
    expect(page.nextOffset).toBeUndefined();
  });

  it("moves a start offset back to the character it lands inside", () => {
    const bytes = new TextEncoder().encode(EMOJI_FULL);
    expect([4, 5, 6].map((o) => alignStartToCharBoundary(bytes, o))).toEqual([
      3, 3, 3,
    ]);
    for (const o of [0, 1, 2, 3, 7, 8, 9]) {
      expect(alignStartToCharBoundary(bytes, o), `offset ${o}`).toBe(o);
    }
    // Past the end there is no character to split.
    expect(alignStartToCharBoundary(bytes, bytes.length + 5)).toBe(
      bytes.length + 5,
    );
  });
});


describe("audit regressions", () => {
  it.each(["callTool", "callDestructiveTool"] as const)("keeps %s successful when result storage fails", async (method) => {
    const store = memoryStorage();
    const storage = { ...store, set: vi.fn(async (key: string, value: string, opts?: { ttlSeconds?: number }) => {
      if (key.includes("result:")) throw new Error("KV PUT failed: 503 Service Temporarily Unavailable secret");
      await store.set(key, value, opts);
    }) };
    const warn = vi.fn();
    const call = vi.fn(async () => "x".repeat(4_000));
    const connector = connectorWith({ id: "large", kind: "api", tools: [{ name: "read", annotations: { readOnlyHint: method === "callTool" } }], call });
    const target = activitySink();
    const mt = createMetaTools(makeRegistry([connector], { storage, maxResultBytes: 1_000, logger: { ...silentLogger, warn } }), BASE, { activity: target.activity });
    for (const resultMode of ["mcp", "value"] as const) {
      const result = await mt[method]({ address: "large.read", resultMode });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain("Paging is unavailable");
      expect(JSON.stringify(result)).not.toContain("resultId");
      expect(JSON.stringify(result)).not.toContain("KV PUT");
      if (resultMode === "value") expect(textOf(result)).toMatchObject({ ok: true });
    }
    expect(call).toHaveBeenCalledTimes(2);
    expect(target.events).toHaveLength(2);
    expect(target.events.every((event) => event.outcome === "success")).toBe(true);
    expect(warn.mock.calls.filter(([line]) => line === "[connecta] result paging unavailable")).toHaveLength(2);
  });

  it("never retries result processing after a completed downstream call", async () => {
    const reg = makeRegistry([calcConnector]);
    const outcome = await new InvocationService(reg, new CatalogService(reg, BASE)).invoke("calc.add", { a: 1, b: 2 }, {
      source: "call_tool",
      processResult: () => { throw new Error("503 temporarily unavailable secret"); },
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "result_processing_failed", retryable: false } });
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  it.each(["mcp", "value"] as const)("bounds a 120 KB MCP error in %s mode", async (resultMode) => {
    const connector = connectorWith({ id: "remote", kind: "mcp", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => ({ isError: true, content: [{ type: "text", text: "x".repeat(120_000) }] }) });
    const result = await createMetaTools(makeRegistry([connector], { maxResultBytes: 1_000 }), BASE).callTool({ address: "remote.read", resultMode });
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(result)).toContain("…");
    expect(() => unwrapMcpResult("mcp", { isError: true, content: [{ type: "text", text: "x".repeat(120_000) }] })).toThrow(/^x{512}…$/);
  });

  it.each([null, 7, [1, 2], { answer: 42 }].map((value) => [value]))("preserves a structured MCP value %j without a text mirror", async (value) => {
    const connector = connectorWith({ id: "remote", kind: "mcp", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => ({ content: [], structuredContent: value }) });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    expect((await mt.callTool({ address: "remote.read" })).content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
    expect(textOf(await mt.callTool({ address: "remote.read", resultMode: "value" }))).toMatchObject({ ok: true, data: value });
  });

  it("guards synthesized structured text and preserves existing text", async () => {
    let nativeText = false;
    const connector = connectorWith({ id: "remote", kind: "mcp", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => ({ content: nativeText ? [{ type: "text", text: "native" }] : [{ type: "image", data: "AA==", mimeType: "image/png" }], structuredContent: { large: "x".repeat(4_000) } }) });
    const mt = createMetaTools(makeRegistry([connector], { maxResultBytes: 1_000 }), BASE);
    const result = await mt.callTool({ address: "remote.read" });
    expect(JSON.stringify(result)).toContain("resultId");
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
    nativeText = true;
    expect((await mt.callTool({ address: "remote.read" })).content).toEqual([{ type: "text", text: "native" }]);
  });

  it.each(["result", "authorization", "skill", "connector skill", "search"])(
    "bounds caller-authored %s names in refusals",
    async (kind) => {
      const mt = createMetaTools(
        makeRegistry([calcConnector], { maxResultBytes: 1_000 }), BASE,
      );
      const huge = "x".repeat(50_000);
      const result = await (kind === "result" ? mt.getResult({ id: huge })
        : kind === "authorization" ? mt.authorizeConnector({ connector: huge })
        : kind === "skill" ? mt.skills({ name: huge })
        : kind === "connector skill" ? mt.skills({ name: `connector:${huge}` })
        : mt.searchTools({ query: "read", connector: huge }));
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(1_000);
      expect(result.isError).toBe(true);
    },
  );

  it("maps result read failures to unavailable", async () => {
    const store = memoryStorage();
    const mt = createMetaTools(makeRegistry([], { storage: { ...store, get: async () => { throw new Error("storage secret"); } } }), BASE);
    const result = await mt.getResult({ id: "missing" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("includes a hanging catalog load in the per-call deadline", async () => {
    vi.useFakeTimers();
    try {
      const call = vi.fn();
      const connector = connectorWith({ id: "hung", kind: "api", tools: () => new Promise(() => {}), call });
      const mt = createMetaTools(makeRegistry([connector]), BASE);
      const pending = mt.callTool({ address: "hung.read", timeoutMs: 100, resultMode: "value" });
      await vi.advanceTimersByTimeAsync(100);
      expect(textOf(await pending)).toMatchObject({ ok: false, error: { code: "timeout" } });
      expect(call).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["admission", "connector"])(
    "releases the permit when the deadline expires during %s",
    async (stage) => {
      vi.useFakeTimers();
      try {
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const call = vi.fn(() => {
          enter();
          return new Promise(() => {});
        });
        const connector = connectorWith({
          id: "limited",
          kind: "api",
          callAdmission: { rules: [{ maxConcurrency: 1 }] },
          tools: [{ name: "read", annotations: { readOnlyHint: true } }],
          call,
        });
        const reg = makeRegistry([connector]);
        const held = stage === "admission"
          ? await reg.admitCall("limited", { toolName: "read", args: {} })
          : undefined;
        if (stage === "admission") {
          const admit = reg.admitCall.bind(reg);
          vi.spyOn(reg, "admitCall").mockImplementation((...args) => {
            const pendingPermit = admit(...args);
            enter();
            return pendingPermit;
          });
        }
        const pending = createMetaTools(reg, BASE).callTool({
          address: "limited.read", timeoutMs: 100, resultMode: "value",
        });
        await entered;
        await vi.advanceTimersByTimeAsync(100);
        expect(textOf(await pending)).toMatchObject({
          ok: false, error: { code: "timeout" },
        });
        held?.release();
        expect(reg.callAdmissionSnapshot().limited).toMatchObject({
          active: 0, queued: 0,
        });
        expect(call).toHaveBeenCalledTimes(stage === "admission" ? 0 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not restart the deadline after catalog resolution", async () => {
    vi.useFakeTimers();
    try {
      let releaseCatalog!: () => void;
      const ready = new Promise<void>((resolve) => { releaseCatalog = resolve; });
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const call = vi.fn(() => {
        enter();
        return new Promise(() => {});
      });
      const connector = connectorWith({
        id: "slow",
        kind: "api",
        tools: async () => {
          await ready;
          return [{ name: "read", annotations: { readOnlyHint: true } }];
        },
        call,
      });
      const pending = createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "slow.read", timeoutMs: 100, resultMode: "value",
      });
      await vi.advanceTimersByTimeAsync(60);
      releaseCatalog();
      await entered;
      await vi.advanceTimersByTimeAsync(40);
      expect(textOf(await pending)).toMatchObject({
        ok: false, durationMs: 100, error: { code: "timeout" },
      });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

});


describe("bounded result stash", () => {
  const notice = (result: { content: { text: string }[] }) =>
    JSON.parse(required(required(result.content[0]).text.split("\n")[0]));

  it.each([
    { maxStashBytes: 1 },
    { maxStashEntries: 0 },
  ])("keeps a preview when the stash refuses %j", async (results) => {
    const mt = createMetaTools(new Registry([capped("large", 100)], { storage: memoryStorage(), logger: silentLogger, results }), BASE);
    const result = await mt.callTool({ address: "large.big" });
    expect(result.isError).toBeFalsy();
    expect(required(result.content[0]).text.split("\n")[1]).toBe(FULL.slice(0, 100));
    expect(notice(result)).toMatchObject({ truncated: true, totalBytes: FULL.length });
    expect(notice(result).hint).toContain("Paging is unavailable");
    expect(notice(result)).not.toHaveProperty("resultId");
  });

  it.each([{ maxStashEntries: 1 }, { maxStashBytes: 1_000 }])("reserves capacity across subjects before concurrent writes finish: %j", async (results) => {
    const storage = memoryStorage();
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const root = new Registry([capped("large", 100)], {
      logger: silentLogger,
      results,
      storage: { ...storage, async set(key, value, options) {
        if (key.startsWith("subject:a:result:")) { entered(); await gate; }
        await storage.set(key, value, options);
      } },
    });
    const first = createMetaTools(root.scoped({ connectorIds: "all", subjectKey: "a" }), BASE)
      .callTool({ address: "large.big" });
    await writing;
    try {
      const second = await createMetaTools(root.scoped({ connectorIds: "all", subjectKey: "b" }), BASE)
        .callTool({ address: "large.big" });
      expect(notice(second)).not.toHaveProperty("resultId");
    } finally { release(); }
    expect(notice(await first)).toHaveProperty("resultId");
    expect(notice(await createMetaTools(root, BASE).callTool({ address: "large.big" })))
      .not.toHaveProperty("resultId");
  });

  it("deletes expired backing entries before reusing their capacity", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const values = new Map<string, string>();
    const root = new Registry([capped("large", 100)], {
      logger: silentLogger,
      results: { maxStashEntries: 1 },
      persistToolCatalog: false,
      storage: {
        async get(key) { return values.get(key) ?? null; },
        async set(key, value) { values.set(key, value); },
        async delete(key) { values.delete(key); },
      },
    });
    try {
      const first = notice(await createMetaTools(root, BASE).callTool({ address: "large.big" }));
      now.mockReturnValue(10_000 + 16 * 60_000);
      const second = notice(await createMetaTools(root, BASE).callTool({ address: "large.big" }));
      expect(second).toHaveProperty("resultId");
      expect(values.has(`results:result:${first.resultId}`)).toBe(false);
      expect(values.size).toBe(1);
    } finally { now.mockRestore(); }
  });

  it("keeps a failed write charged until backing cleanup succeeds", async () => {
    const storage = memoryStorage();
    let failWrite = true;
    let failDelete = true;
    const root = new Registry([capped("large", 100)], {
      logger: silentLogger,
      results: { maxStashEntries: 1 },
      storage: { ...storage,
        async set(key, value, options) {
          await storage.set(key, value, options);
          if (key.includes("result:") && failWrite) { failWrite = false; throw new Error("write failed after persisting"); }
        },
        async delete(key) {
          if (key.includes("result:") && failDelete) throw new Error("delete unavailable");
          await storage.delete(key);
        },
      },
    });
    const call = () => createMetaTools(root, BASE).callTool({ address: "large.big" });
    expect(notice(await call())).not.toHaveProperty("resultId");
    expect(notice(await call())).not.toHaveProperty("resultId");
    expect(await storage.list!("results:result:")).toHaveLength(1);
    failDelete = false;
    expect(notice(await call())).toHaveProperty("resultId");
    expect(await storage.list!("results:result:")).toHaveLength(1);
  });

  it("pages a large stored result without encoding the full text again", async () => {
    const payload = "aé界😀".repeat(20_000);
    const connector = connectorWith({ id: "large", kind: "api", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => payload });
    const root = makeRegistry([connector], { maxResultBytes: 100 });
    const id = notice(await createMetaTools(root, BASE).callTool({ address: "large.read" })).resultId;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      // Fresh adapters pin paging across requests, not a request-local cache.
      for (const offset of [0, 100_001, 150_003]) {
        const page = pageOf(await createMetaTools(root, BASE).getResult({ id, offset, maxBytes: 1024 }));
        expect(page.text).not.toContain("�");
        expect(page.totalBytes).toBe(200_002);
      }
      expect(encode.mock.calls.every(([text]) => (text?.length ?? 0) < 2048)).toBe(true);
    } finally { encode.mockRestore(); }
  });

  // One page, two results whose sizes differ by a factor of four. Counting the
  // characters storage hands back is structural: it fails if a page's read grows
  // with the stash rather than with the page, however fast the machine is.
  it("reads the same bytes for one page whatever the stored result's size", async () => {
    const pageRead = async (repeats: number) => {
      // Ten UTF-8 bytes per repeat, plus the two quotes JSON adds around it.
      const payload = "aé界😀".repeat(repeats);
      const inner = memoryStorage();
      let chars = 0;
      const storage = { ...inner, async get(key: string) {
        const value = await inner.get(key);
        chars += value?.length ?? 0;
        return value;
      } };
      const connector = connectorWith({ id: "large", kind: "api", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => payload });
      const root = makeRegistry([connector], { maxResultBytes: 100, storage });
      const id = notice(await createMetaTools(root, BASE).callTool({ address: "large.read" })).resultId;
      // Chunks widen rather than multiply past a point, so no result turns into
      // an unbounded pile of keys — and of writes — on the way in.
      expect((await inner.list!("results:result:")).length).toBeLessThanOrEqual(33);
      chars = 0;
      // One byte past JSON's opening quote plus 10,000 whole repeats: a page
      // deep inside both results, at the same byte, from a different chunk index.
      const page = pageOf(await createMetaTools(root, BASE).getResult({ id, offset: 100_001, maxBytes: 1024 }));
      expect(page.totalBytes).toBe(repeats * 10 + 2);
      expect(page.text.startsWith("aé界😀")).toBe(true);
      expect(page.text).not.toContain("�");
      return { chars, text: page.text };
    };
    const small = await pageRead(30_000); // 300 KB stored
    const large = await pageRead(120_000); // 1.2 MB stored, same page
    expect(large.text).toBe(small.text);
    // Identical but for the decimal digits `totalBytes` adds to the header, and
    // a couple of chunks rather than the megabyte behind them.
    expect(large.chars - small.chars).toBeLessThan(8);
    expect(large.chars).toBeLessThan(200_000);
  });

  it("reassembles a chunked stash byte-exactly across stored chunk boundaries", async () => {
    const payload = "aé界😀".repeat(30_000); // 300 KB: several stored chunks
    const connector = connectorWith({ id: "large", kind: "api", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => payload });
    // Pages are clamped to the stashing call's cap, so the cap must admit the
    // 7,777-byte pages below.
    const root = makeRegistry([connector], { maxResultBytes: 8_000 });
    const id = notice(await createMetaTools(root, BASE).callTool({ address: "large.read" })).resultId;
    const full = JSON.stringify(payload); // what was stashed, quotes included
    // A page size coprime with the chunk width lands boundaries mid-chunk and
    // mid-character, which is where a byte-range reader would lose or dupe bytes.
    let text = "";
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = pageOf(await createMetaTools(root, BASE).getResult({ id, offset, maxBytes: 7_777 }));
      expect(page.totalBytes).toBe(300_002);
      text += page.text;
      offset = page.nextOffset;
    }
    expect(text).toBe(full);
  });

  // A deployment that upgrades mid-TTL still holds entries in the shapes that
  // came before chunking: v1's single inline envelope, and raw text before that.
  // Neither may decode into something other than what was stashed.
  it("still pages entries stashed in the pre-chunk formats", async () => {
    const stashed = JSON.stringify("aé界😀".repeat(400)); // 4,002 bytes
    const bytes = new TextEncoder().encode(stashed);
    const storage = memoryStorage();
    await storage.set("results:result:inline",
      `connecta-result-v1:${bytes.length}:${btoa(String.fromCharCode(...bytes))}`);
    await storage.set("results:result:raw", stashed);
    const mt = createMetaTools(makeRegistry([calcConnector], { storage }), BASE);
    for (const id of ["inline", "raw"]) {
      let text = "";
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page = pageOf(await mt.getResult({ id, offset, maxBytes: 777 }));
        expect(page.totalBytes).toBe(4_002);
        text += page.text;
        offset = page.nextOffset;
      }
      expect(text).toBe(stashed);
    }
  });
});

describe("truncated results lead with their get_result handle", () => {
  // JSON lines: quote-heavy, so a serialized content envelope would escape
  // every one of them and a preview cut from it would read `\"ts\":…`.
  const JSON_LINES = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({ ts: `2026-09-16T00:${String(i % 60).padStart(2, "0")}:00Z`, actor: `user${i}@example.com`, action: "login" }),
  ).join("\n");

  /** A kind:"mcp" connector returning `content`, read-only or write-capable. */
  function downstream(content: unknown[], readOnly: boolean): Connector {
    return connectorWith({
      id: "down",
      kind: "mcp",
      tools: [{ name: "run", annotations: { readOnlyHint: readOnly } }],
      call: async () => ({ content }),
    });
  }

  interface LeadingNotice {
    truncated: true;
    resultId: string;
    totalBytes: number;
    nextAction: { tool: string; arguments: { id: string; offset: number } };
    hint: string;
  }

  /** The first line of a truncated text result is its notice; the rest is the preview. */
  function lead(result: { content: { text: string }[] }): { notice: LeadingNotice; preview: string } {
    expect(result.content).toHaveLength(1);
    const text = required(result.content[0]).text;
    const newline = text.indexOf("\n");
    expect(newline).toBeGreaterThan(0);
    return {
      notice: JSON.parse(text.slice(0, newline)) as LeadingNotice,
      preview: text.slice(newline + 1),
    };
  }

  async function pageFrom(mt: ReturnType<typeof createMetaTools>, id: string, from: number): Promise<string> {
    let text = "";
    let offset: number | undefined = from;
    while (offset !== undefined) {
      const page = pageOf(await mt.getResult({ id, offset }));
      text += page.text;
      offset = page.nextOffset;
    }
    return text;
  }

  it("puts the notice and its next action before the preview", async () => {
    const mt = createMetaTools(makeRegistry([capped("c")], { maxResultBytes: 100 }), BASE);
    const { notice, preview } = lead(await mt.callTool({ address: "c.big" }));
    expect(notice).toMatchObject({ truncated: true, totalBytes: FULL.length });
    expect(notice.resultId).toBeTypeOf("string");
    // The preview is the first `cap` bytes, so paging continues where it stops.
    expect(preview).toBe(FULL.slice(0, 100));
    expect(notice.nextAction).toEqual({
      tool: "get_result",
      arguments: { id: notice.resultId, offset: 100 },
    });
    expect(preview + await pageFrom(mt, notice.resultId, 100)).toBe(FULL);
  });

  it.each([
    ["callTool", true],
    ["callDestructiveTool", false],
  ] as const)("keeps the %s handle inside what a cutting client still shows", async (method, readOnly) => {
    // Claude Code replaces an oversized MCP result with its first 2,000
    // characters of `JSON.stringify(content, null, 2)`. A tail notice never
    // survives that; a leading one must.
    const mt = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: JSON_LINES }], readOnly)], { maxResultBytes: 10_000 }),
      BASE,
    );
    const result = await mt[method]({ address: "down.run" });
    const { notice } = lead(result);
    const shown = JSON.stringify(result.content, null, 2).slice(0, 2_000);
    expect(shown).toContain(notice.resultId);
    expect(shown).toContain("get_result");
    expect(shown).toContain(String(notice.totalBytes));
  });

  it("tells a write's caller that the call already ran and must not be repeated", async () => {
    const mt = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: JSON_LINES }], false)], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { notice } = lead(await mt.callDestructiveTool({ address: "down.run", reason: "export" }));
    expect(notice.hint).toMatch(/already ran/i);
    expect(notice.hint).toMatch(/do not (call|repeat|run)/i);
    expect(notice.hint).toContain("get_result");
    const value = textOf(
      await mt.callDestructiveTool({ address: "down.run", reason: "export", resultMode: "value" }),
    ) as { data: LeadingNotice };
    expect(value.data.hint).toMatch(/already ran/i);

    const read = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: JSON_LINES }], true)], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { notice: readNotice } = lead(await read.callTool({ address: "down.run" }));
    expect(readNotice.hint).not.toMatch(/already ran/i);
    expect(readNotice.hint).toContain("get_result");
  });

  it("previews a lone text block as its text, not its serialized envelope", async () => {
    const mt = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: JSON_LINES }], true)], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { notice, preview } = lead(await mt.callTool({ address: "down.run" }));
    expect(preview.startsWith('[{"type"')).toBe(false);
    expect(preview).not.toContain('\\"');
    expect(preview).toBe(JSON_LINES.slice(0, 1_000));
    expect(notice.totalBytes).toBe(byteLength(JSON_LINES));
    expect(notice.nextAction.arguments.offset).toBe(1_000);
    // The stash holds the same text, so the preview plus the pages after it
    // reassemble the downstream text byte for byte.
    expect(preview + await pageFrom(mt, notice.resultId, notice.nextAction.arguments.offset))
      .toBe(JSON_LINES);
  });

  it("previews several text blocks as readable text and pages their content array", async () => {
    const content = [
      { type: "text", text: JSON_LINES.slice(0, 700) },
      { type: "text", text: JSON_LINES.slice(700, 1_400) },
    ];
    const mt = createMetaTools(makeRegistry([downstream(content, true)], { maxResultBytes: 500 }), BASE);
    const { notice, preview } = lead(await mt.callTool({ address: "down.run" }));
    expect(preview).toBe(JSON_LINES.slice(0, 500));
    expect(preview).not.toContain('\\"');
    // Block boundaries live only in the envelope, which pages from the start.
    expect(notice.totalBytes).toBe(byteLength(JSON.stringify(content)));
    expect(notice.nextAction.arguments.offset).toBe(0);
    expect(JSON.parse(await pageFrom(mt, notice.resultId, 0))).toEqual(content);
  });

  it("defaults the inline cap to 24,000 bytes", () => {
    expect(makeRegistry([]).maxResultBytes).toBe(24_000);
  });

  it.each([
    ["callTool", true],
    ["callDestructiveTool", false],
  ] as const)("keeps a default-capped %s result under 25,000 bytes whole", async (method, readOnly) => {
    // 25,000 is Claude Code's default MAX_MCP_OUTPUT_TOKENS, and a token covers
    // at least one byte, so this also bounds the tokens; its 50,000-character
    // persistence threshold is further off still.
    const text = "é".repeat(60_000);
    const mt = createMetaTools(makeRegistry([downstream([{ type: "text", text }], readOnly)]), BASE);
    const result = await mt[method]({ address: "down.run" });
    const { notice, preview } = lead(result);
    expect(byteLength(preview)).toBeLessThanOrEqual(24_000);
    expect(byteLength(preview)).toBeGreaterThan(23_990);
    expect(byteLength(required(result.content[0]).text)).toBeLessThan(25_000);
    expect(notice.totalBytes).toBe(byteLength(text));

    const inline = createMetaTools(
      makeRegistry([downstream([{ type: "text", text: "x".repeat(24_000) }], readOnly)]),
      BASE,
    );
    expect((await inline[method]({ address: "down.run" })).content)
      .toEqual([{ type: "text", text: "x".repeat(24_000) }]);
  });
});

describe("get_result pages raw text, clamped to the result's cap", () => {
  const LINES = Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ ts: `2026-09-16T00:00:${String(i % 60).padStart(2, "0")}Z`, actor: `user${i}@example.com`, note: 'says "hi"' }),
  ).join("\n");

  function mcpText(id: string, content: unknown[], maxResultBytes?: number): Connector {
    return connectorWith({
      id,
      kind: "mcp",
      ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      tools: [{ name: "run", annotations: { readOnlyHint: true } }],
      call: async () => ({ content }),
    });
  }

  interface PageHeader {
    resultId: string;
    offset: number;
    bytes: number;
    totalBytes: number;
    hasMore: boolean;
    nextAction?: { tool: string; arguments: { id: string; offset: number } };
  }

  /** A page is one text block: a one-line JSON header, a newline, the raw text. */
  function rawPage(result: { content: { text: string }[]; isError?: boolean }): { header: PageHeader; body: string; whole: string } {
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const whole = required(result.content[0]).text;
    const newline = whole.indexOf("\n");
    expect(newline).toBeGreaterThan(0);
    return { header: JSON.parse(whole.slice(0, newline)) as PageHeader, body: whole.slice(newline + 1), whole };
  }

  async function truncatedId(mt: ReturnType<typeof createMetaTools>, address: string): Promise<{ id: string; next: number }> {
    const text = required((await mt.callTool({ address })).content[0]).text;
    const notice = JSON.parse(text.slice(0, text.indexOf("\n"))) as { resultId: string; nextAction: { arguments: { offset: number } } };
    return { id: notice.resultId, next: notice.nextAction.arguments.offset };
  }

  it("returns a header line then the raw page text, never JSON-escaped", async () => {
    const mt = createMetaTools(makeRegistry([mcpText("down", [{ type: "text", text: LINES }])], { maxResultBytes: 1_000 }), BASE);
    const { id, next } = await truncatedId(mt, "down.run");
    const { header, body } = rawPage(await mt.getResult({ id, offset: next }));
    expect(body).toBe(LINES.slice(1_000, 2_000));
    expect(body).not.toContain('\\"ts\\"');
    expect(header).toEqual({
      resultId: id,
      offset: 1_000,
      bytes: 1_000,
      totalBytes: byteLength(LINES),
      hasMore: true,
      nextAction: { tool: "get_result", arguments: { id, offset: 2_000 } },
    });
  });

  it("clamps a larger maxBytes to the cap instead of refusing it", async () => {
    const mt = createMetaTools(makeRegistry([mcpText("down", [{ type: "text", text: LINES }])], { maxResultBytes: 1_000 }), BASE);
    const { id } = await truncatedId(mt, "down.run");
    for (const maxBytes of [1_001, 50_000, Number.MAX_SAFE_INTEGER]) {
      const { header, body } = rawPage(await mt.getResult({ id, offset: 0, maxBytes }));
      expect(header.bytes, `maxBytes ${maxBytes}`).toBe(1_000);
      expect(body).toBe(LINES.slice(0, 1_000));
      expect(header.nextAction?.arguments.offset).toBe(1_000);
    }
    // A smaller request is still honoured: maxBytes is an upper bound.
    expect(rawPage(await mt.getResult({ id, offset: 0, maxBytes: 10 })).header.bytes).toBe(10);
  });

  it("reports the last page with hasMore false and no next action", async () => {
    const mt = createMetaTools(makeRegistry([mcpText("down", [{ type: "text", text: LINES }])], { maxResultBytes: 1_000 }), BASE);
    const { id } = await truncatedId(mt, "down.run");
    const total = byteLength(LINES);
    const { header, body } = rawPage(await mt.getResult({ id, offset: total - 10 }));
    expect(body).toBe(LINES.slice(-10));
    expect(header).toMatchObject({ offset: total - 10, bytes: 10, totalBytes: total, hasMore: false });
    expect(header).not.toHaveProperty("nextAction");
  });

  it("pages at the connector's own cap, not the deployment's", async () => {
    const mt = createMetaTools(
      makeRegistry([mcpText("wide", [{ type: "text", text: LINES }], 3_000)], { maxResultBytes: 1_000 }),
      BASE,
    );
    const { id, next } = await truncatedId(mt, "wide.run");
    expect(next).toBe(3_000);
    for (const maxBytes of [undefined, 9_999]) {
      const { header } = rawPage(await mt.getResult({ id, offset: next, ...(maxBytes ? { maxBytes } : {}) }));
      expect(header.bytes, `maxBytes ${String(maxBytes)}`).toBe(3_000);
    }
  });

  it("pages a multi-block envelope as its stored JSON, escaped once", async () => {
    const content = [
      { type: "text", text: LINES.slice(0, 900) },
      { type: "text", text: LINES.slice(900, 1_800) },
    ];
    const mt = createMetaTools(makeRegistry([mcpText("down", content)], { maxResultBytes: 500 }), BASE);
    const { id } = await truncatedId(mt, "down.run");
    let offset: number | undefined = 0;
    let stored = "";
    while (offset !== undefined) {
      const { header, body } = rawPage(await mt.getResult({ id, offset }));
      stored += body;
      offset = header.hasMore ? header.nextAction?.arguments.offset : undefined;
    }
    expect(stored).toBe(JSON.stringify(content));
    expect(JSON.parse(stored)).toEqual(content);
  });

  it("never answers a page request with more than the cap plus a small header", async () => {
    const cap = 1_000;
    const mt = createMetaTools(makeRegistry([mcpText("down", [{ type: "text", text: LINES }])], { maxResultBytes: cap }), BASE);
    const { id } = await truncatedId(mt, "down.run");
    for (const maxBytes of [undefined, 1, cap, cap * 10, Number.MAX_SAFE_INTEGER]) {
      for (const offset of [0, 777, 5_000]) {
        const result = await mt.getResult({ id, offset, ...(maxBytes ? { maxBytes } : {}) });
        // What a client measures: the text it is handed, with no second copy.
        expect(result.structuredContent).toBeUndefined();
        expect(byteLength(rawPage(result).whole), `maxBytes ${String(maxBytes)} offset ${offset}`)
          .toBeLessThanOrEqual(cap + 400);
      }
    }
  });

  it.each(["mcp", "value"] as const)("bounds an unpageable %s-mode truncation by the cap plus a small header", async (resultMode) => {
    const store = memoryStorage();
    const storage = { ...store, set: async (key: string, value: string, opts?: { ttlSeconds?: number }) => {
      if (key.includes("result:")) throw new Error("stash down");
      await store.set(key, value, opts);
    } };
    const cap = 1_000;
    // Quote-heavy JSON, so a preview escaped into value mode's JSON envelope
    // would grow well past the cap if it were cut at `cap` bytes before escaping.
    const connector = connectorWith({ id: "api", kind: "api", tools: [{ name: "read", annotations: { readOnlyHint: true } }], call: async () => LINES });
    const mt = createMetaTools(makeRegistry([connector], { storage, maxResultBytes: cap }), BASE);
    const result = await mt.callTool({ address: "api.read", resultMode });
    expect(JSON.stringify(result)).toContain("Paging is unavailable");
    expect(byteLength(required(result.content[0]).text)).toBeLessThanOrEqual(cap + 400);
  });

  it("pages an entry stashed before the cap was recorded at the deployment cap", async () => {
    const stashed = LINES.slice(0, 3_000);
    const bytes = new TextEncoder().encode(stashed);
    const storage = memoryStorage();
    await storage.set("results:result:old", `connecta-result-v2:${bytes.length}:49152:${btoa(String.fromCharCode(...bytes))}`);
    const mt = createMetaTools(makeRegistry([calcConnector], { storage, maxResultBytes: 1_000 }), BASE);
    const { header, body } = rawPage(await mt.getResult({ id: "old", offset: 0, maxBytes: 5_000 }));
    expect(header.bytes).toBe(1_000);
    expect(body).toBe(stashed.slice(0, 1_000));
  });
});
