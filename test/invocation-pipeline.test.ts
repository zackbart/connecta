// The single-call pipeline's deadline, admission permit, and timing, observed
// through InvocationService directly so the numbers are the engine's own.
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordToolActivity } from "../src/activity.js";
import { connectorWith } from "./fixtures/connectors.js";
import { CatalogService } from "../src/catalog-service.js";
import type { CallAdmissionPermit } from "../src/call-admission.js";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { InvocationService } from "../src/invocation.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import type { Registry } from "../src/registry.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import type { Connector } from "../src/types.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { z } from "zod";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

function limited(call: () => Promise<unknown>): Registry {
  return makeRegistry([
    connectorWith({
      id: "limited",
      kind: "api",
      callAdmission: { rules: [{ maxConcurrency: 1 }] },
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call,
    }),
  ]);
}

function invoke(registry: Registry, timeoutMs: number) {
  return new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
    "limited.read",
    {},
    { source: "call_tool", timeoutMs },
  );
}

/** Resolves once the call has asked for admission, however that answers. */
function admissionStarted(
  registry: Registry,
  admit: (...args: Parameters<Registry["admitCall"]>) => Promise<CallAdmissionPermit>,
): Promise<void> {
  return new Promise((entered) => {
    vi.spyOn(registry, "admitCall").mockImplementation((...args) => {
      const permit = admit(...args);
      entered();
      return permit;
    });
  });
}

describe("one deadline over resolve, admission, and dispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses at the final gate, unsent, as no attempt and no failure, and frees its permit", async () => {
    const call = vi.fn(async () => "sent");
    const logged: unknown[] = [];
    const logger = {
      ...silentLogger,
      warn: (...line: unknown[]) => void logged.push(line),
      error: (...line: unknown[]) => void logged.push(line),
    };
    const registry = makeRegistry(
      [
        connectorWith({
          id: "limited",
          kind: "api",
          callAdmission: { rules: [{ maxConcurrency: 1 }] },
          tools: [{ name: "read", annotations: { readOnlyHint: true } }],
          call,
        }),
      ],
      { logger },
    );
    const events: Array<{ outcome: string; attempts: number; errorCode?: string }> = [];
    const service = new InvocationService(registry, new CatalogService(registry, BASE), {
      recordTool: recordToolActivity,
      sink: { record: (event) => void events.push(event) },
      actor: { kind: "test" },
      requestId: "r",
      serverInfo: { name: "t", version: "0" },
      logger: silentLogger,
    });
    const refusal = vi.fn((address: string) => ({
      code: "timeout",
      message: `${address} was not sent.`,
      retryable: true,
      details: { operation: address, stage: "dispatch gate" },
    }));
    const refused = await service.invoke(
      "limited.read",
      {},
      { source: "call_tool", dispatchDeadline: { at: Date.now() - 1, refusal } },
    );
    expect(refused).toMatchObject({
      ok: false,
      dispatched: false,
      error: { code: "timeout", retryable: true, details: { stage: "dispatch gate" } },
    });
    // The gate's own words stand: the host's deadline phrasing would call this a timeout it was not.
    expect(refused).toMatchObject({ error: { message: "limited.read was not sent." } });
    expect(refusal).toHaveBeenCalledWith("limited.read");
    expect(call).not.toHaveBeenCalled();
    // Nothing reached the connector, so nothing timed out downstream: a cancelled
    // event of no attempts, its reason kept as the code, and no failure line.
    expect(refused.attempts).toBe(0);
    expect(events.map(({ outcome, attempts, errorCode }) => ({ outcome, attempts, errorCode }))).toEqual([
      { outcome: "cancelled", attempts: 0, errorCode: "timeout" },
    ]);
    expect(JSON.stringify(logged)).not.toContain("call failed");
    // maxConcurrency 1: a permit the refusal kept would hang this.
    await expect(service.invoke("limited.read", {}, { source: "call_tool", timeoutMs: 1_000 })).resolves.toMatchObject({
      ok: true,
      dispatched: true,
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("charges a call that timed out in the admission queue with that wait", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async () => "never reached");
    const registry = limited(call);
    const held = await registry.admitCall("limited", { toolName: "read", args: {} });
    const entered = admissionStarted(registry, registry.admitCall.bind(registry));

    const pending = invoke(registry, 100);
    await entered;
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(outcome.timing.admissionMs).toBe(100);
    expect(outcome.timing.connectorMs).toBe(0);
    expect(call).not.toHaveBeenCalled();
    held.release();
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 0,
      queued: 0,
    });
  });

  it("INV-9: charges an unresponsive call's wait; a deadline or cancellation without a complete answer stays conservative", async () => {
    vi.useFakeTimers();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const registry = limited(() => {
      enter();
      return new Promise(() => {});
    });

    const pending = invoke(registry, 100);
    await entered;
    await vi.advanceTimersByTimeAsync(100);
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(outcome.timing.connectorMs).toBe(100);
    // The permit went back before the outcome did.
    expect(registry.callAdmissionSnapshot().limited).toMatchObject({
      active: 0,
      queued: 0,
    });

    for (const dispatch of ["untracked", "auxiliary", "call-owned"] as const) {
      for (const end of ["deadline", "cancel"] as const) {
        const label = `${dispatch}, ${end}`;
        const requests: string[] = [];
        let sent!: () => void;
        const reached = new Promise<void>((resolve) => {
          sent = resolve;
        });
        const request = guardedFetch({
          provider: "Tickets",
          baseUrl: "https://tickets.test",
          authenticate: () => ({}),
          maxResponseBytes: 1024,
          fetch: async (_input, init) => {
            requests.push(init?.method ?? "GET");
            return Response.json({});
          },
        });
        const write = { name: "send", description: "Send", annotations: { readOnlyHint: false } };
        const connector =
          dispatch === "untracked"
            ? connectorWith({
                id: "tickets",
                kind: "api",
                tools: [write],
                call: async () => {
                  sent();
                  return new Promise(() => {});
                },
              })
            : tracksEveryRequest(
                api("tickets", {
                  tools: [
                    {
                      ...write,
                      handler: async (_args, ctx) => {
                        await request(
                          {
                            method: dispatch === "auxiliary" ? "GET" : "POST",
                            path: "/items",
                            auxiliary: dispatch === "auxiliary",
                            classification: dispatch === "auxiliary" ? "read" : "write",
                          },
                          ctx,
                          (response) => response.json(),
                        );
                        sent();
                        return new Promise(() => {});
                      },
                    },
                  ],
                }),
              );
        const writes = makeRegistry([connector]);
        const cancel = new AbortController();
        const pendingWrite = new InvocationService(writes, new CatalogService(writes, BASE)).invoke(
          "tickets.send",
          {},
          { source: "call_destructive_tool", timeoutMs: 100, requestSignal: cancel.signal },
        );
        await reached;
        if (end === "deadline") await vi.advanceTimersByTimeAsync(100);
        else cancel.abort();
        const outcome = await pendingWrite;
        expect(requests, label).toEqual(dispatch === "untracked" ? [] : [dispatch === "auxiliary" ? "GET" : "POST"]);
        expect(outcome, label).toMatchObject({
          ok: false,
          answered: false,
          error: {
            code: end === "deadline" ? "write_outcome_unknown" : "cancelled",
            retryable: false,
            ...(end === "cancel" ? { writeOutcome: "unknown" } : {}),
          },
        });
        expect(outcome.timing.connectorMs, label).toBe(end === "deadline" ? 100 : 0);
      }
    }
  });

  it("releases a permit granted only after the deadline ended the wait", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async () => "never reached");
    const registry = limited(call);
    const release = vi.fn();
    let grant!: () => void;
    // An admission that ignores the call's signal and grants late.
    const entered = admissionStarted(
      registry,
      () =>
        new Promise((resolve) => {
          grant = () => resolve({ waitMs: 0, release });
        }),
    );

    const pending = invoke(registry, 100);
    await entered;
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });

    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("what a write's outcome can know", () => {
  function writer(call: () => Promise<unknown>, kind: "api" | "mcp" = "api") {
    return makeRegistry([
      connectorWith({
        id: "w",
        kind,
        tools: [
          {
            name: "send",
            annotations: { destructiveHint: true },
            inputSchema: {
              type: "object",
              properties: { to: { type: "string" } },
              required: ["to"],
            },
          },
        ],
        call,
      }),
    ]);
  }

  it("asks a write gate only after validation, and records an unrecorded refusal as nothing", async () => {
    const gate = vi.fn(() =>
      Effect.succeed({
        kind: "refuse" as const,
        error: { code: "cancelled", message: "The program had already returned.", retryable: false },
        unrecorded: true as const,
      }),
    );
    const events: Array<{ outcome: string; attempts: number }> = [];
    const registry = writer(async () => ({ ok: true }), "mcp");
    const service = new InvocationService(registry, new CatalogService(registry, BASE), {
      recordTool: recordToolActivity,
      sink: { record: (event) => void events.push(event) },
      actor: { kind: "test" },
      requestId: "r",
      serverInfo: { name: "t", version: "0" },
      logger: silentLogger,
    });
    const invalid = await service.invoke("w.send", {}, { source: "execute_code", readOnly: false, beforeWrite: gate });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(gate).not.toHaveBeenCalled();
    const refusedCall = await service.invoke(
      "w.send",
      { to: "a" },
      { source: "execute_code", readOnly: false, beforeWrite: gate },
    );
    expect(refusedCall).toMatchObject({
      ok: false,
      dispatched: false,
      error: { code: "cancelled" },
    });
    expect(gate).toHaveBeenCalledTimes(1);
    // The validation failure is an attempt; the unrecorded refusal is not.
    expect(events.map((event) => [event.outcome, event.attempts])).toEqual([["error", 1]]);
  });
});

// The invocation's gate runs before the connector, but a connector may still
// connect, renew or authenticate before its physical send. That send checks the
// dispatch deadline again, and only a ledger that proves nothing left makes the
// refusal the gate's.
describe("the physical send checks the dispatch deadline again", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const refusal = (address: string) => ({
    code: "timeout",
    message: `${address} was not sent.`,
    retryable: true,
    details: { operation: address, stage: "dispatch gate" },
  });

  function observed(registry: Registry) {
    const events: Array<{ outcome: string; attempts: number; errorCode?: string }> = [];
    const service = new InvocationService(registry, new CatalogService(registry, BASE), {
      recordTool: recordToolActivity,
      sink: { record: (event) => void events.push(event) },
      actor: { kind: "test" },
      requestId: "r",
      serverInfo: { name: "t", version: "0" },
      logger: silentLogger,
    });
    return { service, events };
  }

  /** From now on the clock reads `ms` later: work the timers never see. */
  function jumpClock(ms: number) {
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + ms);
  }

  it.each([
    { tool: "create_item", source: "call_destructive_tool" },
    { tool: "get_item", source: "call_tool" },
  ] as const)(
    "INV-9: a remote MCP $tool its reconnect outlasted is refused unsent from a cached catalog",
    async ({ tool, source }) => {
      installOwnedTransport();
      const downstream = httpDownstream((server) => {
        server.registerTool(
          "create_item",
          { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
          async () => ({ content: [{ type: "text", text: "created" }] }),
        );
        server.registerTool(
          "get_item",
          { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "item" }] }),
        );
      });
      let slow = false;
      const methods: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
        if (rpc.method) methods.push(rpc.method);
        // The reconnect takes longer than the call has left.
        if (slow && rpc.method === "initialize") jumpClock(5_000);
        return downstream.fetch(String(input), init);
      });
      const connector = remoteMcp("tickets", { url: downstream.url, versionNegotiation: "legacy" });
      const registry = makeRegistry([connector], { toolCacheTtlSeconds: 3600 });
      const ctx = registry.contextFor("tickets", BASE);
      Object.assign(connector, { staticTools: await connector.listTools(ctx) });
      await connector.closeScope?.(ctx);
      methods.length = 0;
      slow = true;

      const { service, events } = observed(registry);
      const outcome = await service.invoke(
        `tickets.${tool}`,
        {},
        {
          source,
          dispatchDeadline: { at: Date.now() + 1_000, refusal },
        },
      );

      // It connected, but its tools/call never left: zero physical sends.
      expect(methods).toContain("initialize");
      expect(methods).not.toContain("tools/call");
      expect(outcome).toMatchObject({
        ok: false,
        dispatched: false,
        attempts: 0,
        error: { code: "timeout", retryable: true, details: { stage: "dispatch gate" } },
      });
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.error.writeOutcome).toBeUndefined();
      expect(classifyWriteOutcome(outcome)).toBe("failed");
      expect(events).toEqual([expect.objectContaining({ outcome: "cancelled", attempts: 0, errorCode: "timeout" })]);
      await connector.closeScope?.(registry.contextFor("tickets", BASE));
    },
  );

  function slowCredential() {
    const sent: string[] = [];
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.test",
      // A token refresh before the send outlasts the call's time.
      authenticate: () => {
        jumpClock(5_000);
        return { Authorization: "Bearer fresh" };
      },
      maxResponseBytes: 1024,
      fetch: async (_input, init) => {
        sent.push(init?.method ?? "GET");
        return Response.json({ id: "item_1" });
      },
    });
    const boundary = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "send",
            description: "Send",
            annotations: { readOnlyHint: false },
            handler: (_args, ctx) => send({ method: "POST", path: "/items" }, ctx, (response) => response.json()),
          },
        ],
      }),
    );
    return { sent, boundary };
  }

  it("INV-9: an api() write whose credential refresh outlasted it is refused unsent", async () => {
    const { sent, boundary } = slowCredential();
    const { service, events } = observed(makeRegistry([boundary]));
    const outcome = await service.invoke(
      "tickets.send",
      {},
      {
        source: "call_destructive_tool",
        dispatchDeadline: { at: Date.now() + 1_000, refusal },
      },
    );
    expect(sent).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, dispatched: false, attempts: 0, error: { code: "timeout" } });
    expect(classifyWriteOutcome(outcome)).toBe("failed");
    expect(events).toEqual([expect.objectContaining({ outcome: "cancelled", attempts: 0, errorCode: "timeout" })]);
  });

  it("INV-9: control: a wrapper that owns no ledger keeps its write's unknown outcome", async () => {
    const { sent, boundary } = slowCredential();
    // A custom connector could have sent around the ledger before it rethrew.
    const wrapper: Connector = {
      id: "tickets",
      kind: "api",
      listTools: (ctx) => boundary.listTools(ctx),
      callTool: (name, args, ctx, options) => boundary.callTool(name, args, ctx, options),
    };
    const { service, events } = observed(makeRegistry([wrapper]));
    const outcome = await service.invoke(
      "tickets.send",
      {},
      {
        source: "call_destructive_tool",
        dispatchDeadline: { at: Date.now() + 1_000, refusal },
      },
    );
    expect(sent).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, dispatched: true, attempts: 1 });
    expect(classifyWriteOutcome(outcome)).toBe("unknown");
    expect(events).not.toContainEqual(expect.objectContaining({ outcome: "cancelled" }));
  });
});
