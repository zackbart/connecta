import { describe, expect, it } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import {
  alignEndToCharBoundary,
  alignStartToCharBoundary,
  createMetaTools,
  MAX_RETRY_BACKOFF_MS,
  retryBackoffMs,
} from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { required,
  authConnector,
  brokenConnector,
  calcConnector,
  makeRegistry,
  remoteConnector,
  silentLogger,
} from "./helpers.js";

const BASE = "https://connecta.test";


function textOf(result: { content: { text: string }[] }): unknown {
  return JSON.parse(required(result.content[0]).text);
}

function registry() {
  return makeRegistry([
    calcConnector,
    remoteConnector,
    brokenConnector,
    authConnector,
  ]);
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

  it("retries transient failures only for safely annotated API tools", async () => {
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
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      timing: {
        catalogMs: number;
        connectorMs: number;
        backoffMs: number;
        resultProcessingMs: number;
        totalMs: number;
      };
    };
    const unsafe = textOf(
      await mt.callTool({
        address: "retry.unsafe_write",
        resultMode: "value",
        maxRetries: 2,
      }),
    ) as { ok: boolean; attempts: number };

    expect(safe).toMatchObject({ ok: true, attempts: 2 });
    expect(safe.timing.connectorMs).toBeGreaterThanOrEqual(0);
    expect(safe.timing.backoffMs).toBeGreaterThanOrEqual(240);
    expect(safe.timing.totalMs).toBeGreaterThanOrEqual(safe.timing.connectorMs);
    expect(safeCalls).toBe(2);
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

  it("backs off for the connector's retryAfterMs instead of the exponential guess", async () => {
    let calls = 0;
    const connector = api("paced", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            if (calls === 1) {
              throw new ConnectorCallError("rate_limited", "slow down", {
                retryAfterMs: 600,
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "paced.read",
        resultMode: "value",
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The exponential default for attempt 1 is 250ms; the connector said 600.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(550);
    expect(calls).toBe(2);
  });

  it("still backs off after an attempt that failed by timing out", async () => {
    // timeoutMs is a per-attempt budget, so an attempt that spends all of it
    // must not shorten the wait before the next one. A whole-call deadline
    // would leave nothing remaining here and retry instantly.
    let calls = 0;
    const connector = api("expiring", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          async handler(_args, ctx) {
            calls++;
            if (calls === 1) {
              await new Promise<void>((resolve) => {
                ctx.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "expiring.read",
        resultMode: "value",
        timeoutMs: 50,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The full 250ms exponential default (less timer slop), not the ~0 a
    // spent whole-call deadline would have left.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(240);
    expect(calls).toBe(2);
  });

  it("gives every attempt the full timeoutMs budget, not a share of one", async () => {
    let calls = 0;
    const connector = api("perattempt", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          async handler() {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (calls === 1) throw new Error("temporary 503");
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "perattempt.read",
        resultMode: "value",
        timeoutMs: 60,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { totalMs: number } };
    // Two 40ms attempts plus a 250ms backoff far exceed the 60ms budget in
    // total, and that is exactly the point: the budget is per attempt.
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    expect(parsed.timing.totalMs).toBeGreaterThan(60);
    expect(calls).toBe(2);
  });

  it("waits a reported window in full even when it outlasts the per-attempt budget", async () => {
    let calls = 0;
    const connector = api("windowed", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            if (calls === 1) {
              throw new ConnectorCallError("rate_limited", "slow down", {
                retryAfterMs: 150,
              });
            }
            return { ok: true };
          },
        },
      ],
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "windowed.read",
        resultMode: "value",
        timeoutMs: 25,
        maxRetries: 1,
        diagnostics: true,
      }),
    ) as { ok: boolean; attempts: number; timing: { backoffMs: number } };
    expect(parsed).toMatchObject({ ok: true, attempts: 2 });
    // The whole 150ms window (less timer slop), despite a 25ms per-attempt
    // budget that a whole-call deadline would have clamped it to.
    expect(parsed.timing.backoffMs).toBeGreaterThanOrEqual(140);
    expect(calls).toBe(2);
  });

  it("declines the retry outright when the reported window is too long to wait", async () => {
    let calls = 0;
    const connector = api("parked", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => {
            calls++;
            throw new ConnectorCallError("rate_limited", "slow down", {
              retryAfterMs: 30_000,
            });
          },
        },
      ],
    });
    const startedAt = Date.now();
    const parsed = textOf(
      await createMetaTools(makeRegistry([connector]), BASE).callTool({
        address: "parked.read",
        resultMode: "value",
        maxRetries: 2,
        diagnostics: true,
      }),
    ) as {
      ok: boolean;
      attempts: number;
      error: { retryAfterMs?: number };
      timing: { backoffMs: number };
    };
    // Retrying inside a 30s rate-limit window is the harm this channel exists
    // to prevent, and truncating a *known* window to 10s would do exactly
    // that. So: no retry, no wait, and the window reported verbatim.
    expect(parsed).toMatchObject({
      ok: false,
      attempts: 1,
      error: { retryAfterMs: 30_000 },
    });
    expect(parsed.timing.backoffMs).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(calls).toBe(1);
  });

  // The 10s ceiling can't be waited out in a test, so it is asserted on the
  // pure calculation the retry loop calls.
  it("bounds the backoff: a reported window is honoured exactly or not at all", () => {
    // No window reported → the historical exponential guess, capped at 1s.
    expect(retryBackoffMs(1, undefined)).toBe(250);
    expect(retryBackoffMs(2, undefined)).toBe(500);
    expect(retryBackoffMs(3, undefined)).toBe(1_000);
    expect(retryBackoffMs(9, undefined)).toBe(1_000);

    // A reported window replaces the guess, in both directions, and 0 means
    // "retry now" rather than "no window".
    expect(retryBackoffMs(1, 40)).toBe(40);
    expect(retryBackoffMs(1, 4_000)).toBe(4_000);
    expect(retryBackoffMs(1, 0)).toBe(0);

    // Up to the ceiling it is honoured exactly; past it the retry is declined
    // (undefined) rather than truncated into the rate-limit window.
    expect(MAX_RETRY_BACKOFF_MS).toBe(10_000);
    expect(retryBackoffMs(1, MAX_RETRY_BACKOFF_MS)).toBe(MAX_RETRY_BACKOFF_MS);
    expect(retryBackoffMs(1, MAX_RETRY_BACKOFF_MS + 1)).toBe(undefined);
    expect(retryBackoffMs(1, 3_600_000)).toBe(undefined);
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
        maxRetries: 2,
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
        maxRetries: 2,
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
        maxRetries: 2,
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
    const notice = JSON.parse(required(lines[lines.length - 1])) as {
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
      arguments: { id: notice.resultId, offset: 0 },
    });

    // Round-trip the full text back through get_result.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 100 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
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
    const page = textOf(
      await mt.getResult({ id: parsed.data.resultId, maxBytes: 1_000 }),
    ) as { text: string };
    expect(JSON.parse(page.text)).toEqual({ blob: "x".repeat(500) });
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
    const notice = JSON.parse(required(lines[lines.length - 1])) as { resultId: string };

    const expected = JSON.stringify(JSON.parse(original));
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 4 }),
      ) as { text: string; nextOffset?: number };
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
    const head = required(call.content[0]).text.split("\n")[0];
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
    const [head, notice] = required(result.content[0]).text.split("\n");
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
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 64 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      expect(page.totalBytes).toBe(FULL.length);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(FULL);
  });

  it("pages an override-truncated result with get_result's default page size", async () => {
    // Cap above the global one but below the payload: truncation happens at
    // the connector's 300 while get_result, given no maxBytes, falls back to
    // the deployment-wide 100 — so this covers both the larger-than-global
    // truncation and get_result's default page size in one round trip.
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
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
      pages++;
      expect(page.totalBytes).toBe(FULL.length);
      expect(page.text.length).toBeLessThanOrEqual(100);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    // 502 bytes in 100-byte default pages — the global cap, not the 300 the
    // connector truncated at.
    expect(pages).toBe(6);
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
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[1])) as {
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
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 1 }),
      ) as { text: string; nextOffset?: number };
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
    // Falls back to the built-in 50_000, so 502 bytes stay inline whole.
    expect(required(result.content[0]).text, `cap ${String(maxResultBytes)}`).toBe(FULL);
  });

  it.each(BAD_CAPS)("ignores connector override %s", async (override) => {
    const mt = createMetaTools(
      makeRegistry([capped("c", override)], { maxResultBytes: 400 }),
      BASE,
    );
    const result = await mt.callTool({ address: "c.big" });
    const [head] = required(result.content[0]).text.split("\n");
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
    expect(required(result.content[0]).text.split("\n")[0]).toBe(FULL.slice(0, warned));
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
      expect(required(viaGlobal.content[0]).text.split("\n")[0], `global ${cap}`).toBe(
        expected,
      );
      expect(
        required(viaOverride.content[0]).text.split("\n")[0],
        `override ${cap}`,
      ).toBe(expected);
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
    const notice = JSON.parse(required(required(call.content[0]).text.split("\n")[1])) as {
      resultId: string;
      totalBytes: number;
    };
    const full = JSON.stringify(long);
    expect(notice.totalBytes).toBe(byteLength(full));
    const page = textOf(
      await mt.getResult({ id: notice.resultId, maxBytes: 10_000 }),
    ) as { text: string };
    expect(page.text).toBe(full);
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
    const notice = JSON.parse(required(lines[lines.length - 1])) as Notice;
    const head = lines.slice(0, -1).join("\n");
    expect(notice.truncated).toBe(true);
    // One unit for all three: the cap, the head served, and totalBytes.
    expect(notice.totalBytes).toBe(byteLength(full));
    expect(head).toBe(full.slice(0, cap));
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
      const page = textOf(
        await mt.getResult({ id: notice.resultId, offset, maxBytes: 10_000 }),
      ) as { text: string; nextOffset?: number; totalBytes: number };
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
    // A cap of 1 stashes the payload whole while keeping the inline head tiny.
    const mt = createMetaTools(
      makeRegistry([conn], { maxResultBytes: 1 }),
      BASE,
    );
    const call = await mt.callTool({ address: "mb.get" });
    const lines = required(call.content[0]).text.split("\n");
    const notice = JSON.parse(required(lines[lines.length - 1])) as { resultId: string };
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
    const page = textOf(
      await mt.getResult({ id: resultId, offset: requested, maxBytes: 100 }),
    ) as { text: string; offset: number; totalBytes: number };
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
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 100 }),
      ) as { text: string; offset: number };
      expect(page.offset, `offset ${offset}`).toBe(offset);
      expect(page.text).not.toContain("�");
    }
    // And a full paging loop still reassembles the stashed text exactly.
    let offset = 0;
    let assembled = "";
    for (;;) {
      const page = textOf(
        await mt.getResult({ id: resultId, offset, maxBytes: 3 }),
      ) as { text: string; nextOffset?: number };
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
    const page = textOf(
      await mt.getResult({ id: resultId, offset: byteLength(EMOJI_FULL) + 5 }),
    ) as { text: string; offset: number; nextOffset?: number };
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
