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
