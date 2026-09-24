// The single-call pipeline's deadline, admission permit, and timing, observed
// through InvocationService directly so the numbers are the engine's own.
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordToolActivity } from "../src/activity.js";
import { connectorWith } from "./fixtures/connectors.js";
import { CatalogService } from "../src/catalog-service.js";
import type { CallAdmissionPermit } from "../src/call-admission.js";
import { InvocationService } from "../src/invocation.js";
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
  return new InvocationService(
    registry,
    new CatalogService(registry, BASE),
  ).invoke("limited.read", {}, { source: "call_tool", timeoutMs });
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

  it("charges a call that timed out in an unresponsive connector with that wait", async () => {
    vi.useFakeTimers();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
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
        tools: [{
          name: "send",
          annotations: { destructiveHint: true },
          inputSchema: {
            type: "object",
            properties: { to: { type: "string" } },
            required: ["to"],
          },
        }],
        call,
      }),
    ]);
  }
  const send = (registry: Registry, args: unknown) =>
    new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "w.send",
      args,
      { source: "call_destructive_tool", allowDestructive: true },
    );

  it("reports whether the connector was actually called", async () => {
    await expect(send(writer(async () => ({ ok: true })), { to: "a" }))
      .resolves.toMatchObject({ ok: true, dispatched: true });
    // Refused before dispatch: nothing reached the connector.
    const call = vi.fn(async () => ({ ok: true }));
    await expect(send(writer(call, "mcp"), {}))
      .resolves.toMatchObject({ ok: false, dispatched: false, error: { code: "invalid_args" } });
    expect(call).not.toHaveBeenCalled();
  });

  it("tells an answer from silence", async () => {
    const answered = await send(
      writer(
        async () => ({ isError: true, content: [{ type: "text", text: "no such thread" }] }),
        "mcp",
      ),
      { to: "a" },
    );
    expect(answered).toMatchObject({ ok: false, dispatched: true, answered: true });
    const silent = await send(
      writer(async () => { throw new TypeError("fetch failed"); }),
      { to: "a" },
    );
    expect(silent).toMatchObject({ ok: false, dispatched: true, answered: false });
  });

  it("asks a write gate only after validation, and records a pause as a pause", async () => {
    const gate = vi.fn(() => Effect.succeed({
      kind: "refuse" as const,
      error: { code: "execution_paused", message: "paused", retryable: false },
      activity: "paused" as const,
    }));
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
    const invalid = await service.invoke("w.send", {}, { source: "execute_code", writeGate: gate });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(gate).not.toHaveBeenCalled();
    const pausedCall = await service.invoke(
      "w.send",
      { to: "a" },
      { source: "execute_code", writeGate: gate },
    );
    expect(pausedCall).toMatchObject({
      ok: false,
      dispatched: false,
      error: { code: "execution_paused" },
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(events.map((event) => [event.outcome, event.attempts])).toEqual([
      ["error", 1],
      ["paused", 0],
    ]);
  });
});
