// The single-call pipeline's deadline, admission permit, and timing, observed
// through InvocationService directly so the numbers are the engine's own.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { CatalogService } from "../src/catalog-service.js";
import type { CallAdmissionPermit } from "../src/call-admission.js";
import { InvocationService } from "../src/invocation.js";
import type { Registry } from "../src/registry.js";
import { makeRegistry } from "./helpers.js";

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
