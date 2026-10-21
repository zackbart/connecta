// The collector's release path, driven by a stand-in FinalizationRegistry so
// a finalizer can fire at any instant, including the impossible ones.
import { afterEach, expect, it, vi } from "vitest";
import type { AuthResult, InboundAuth } from "../src/types.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

class StandInRegistry<T> {
  static latest: StandInRegistry<unknown> | undefined;
  readonly entries = new Map<object, { target: object; held: T }>();
  constructor(readonly cleanup: (held: T) => void) {
    StandInRegistry.latest = this as StandInRegistry<unknown>;
  }
  register(target: object, held: T, unregisterToken?: object) {
    this.entries.set(unregisterToken ?? target, { target, held });
  }
  unregister(unregisterToken: object) {
    return this.entries.delete(unregisterToken);
  }
}

async function load(available = true) {
  vi.resetModules();
  vi.stubGlobal("FinalizationRegistry", available ? StandInRegistry : undefined);
  StandInRegistry.latest = undefined;
  const admission = await import("../src/auth-admission.js");
  return { ...admission, registry: StandInRegistry.latest as StandInRegistry<object> | undefined };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function controlled() {
  const settle: Array<() => void> = [];
  const provider: InboundAuth = {
    kind: "custom",
    authorize: () =>
      new Promise<AuthResult>((resolve) => {
        settle.push(() => resolve({ ok: false, response: new Response(null, { status: 401 }) }));
      }),
  };
  return { provider, settle };
}

it("INV-7: a finalizer racing a late settlement releases an active charge exactly once", async () => {
  const { authenticate, authenticationSnapshot, registry } = await load();
  const { provider, settle } = controlled();
  const warn = vi.fn();
  const logger = { ...silentLogger, warn };
  const pending = authenticate(provider, new Request(`${BASE}/mcp`), BASE, undefined, logger);
  expect(authenticationSnapshot()).toMatchObject({ active: 1, abandoned: 0, unreachableRelease: true });
  const [entry] = [...registry!.entries.values()];
  // The registry holds the plain record, never the token it watches.
  expect(entry!.held).toEqual({ state: "active" });
  expect(entry!.held).not.toBe(entry!.target);
  registry!.cleanup(entry!.held);
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
  registry!.cleanup(entry!.held);
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
  // The late settlement finds the record released and decrements nothing.
  settle[0]!();
  expect((await pending).admitted).toBe(true);
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
  expect(registry!.entries.size).toBe(0);
  // The next admission logs the collector's release once, without request facts.
  const next = authenticate(provider, new Request(`${BASE}/mcp`), BASE, undefined, logger);
  expect(warn.mock.calls).toEqual([
    [
      "[connecta] Authentication released after its pending work became unreachable",
      { reason: "authentication_unreachable" },
    ],
  ]);
  settle[1]!();
  await next;
  expect(warn).toHaveBeenCalledTimes(1);
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
});

it("INV-7: an overdue active charge takes the abandoned slot a finalizer frees", async () => {
  vi.useFakeTimers();
  const { authenticate, authenticationSnapshot, registry } = await load();
  const { provider, settle } = controlled();
  const stuck = authenticate(provider, new Request(`${BASE}/mcp`), BASE, undefined, silentLogger);
  await vi.advanceTimersByTimeAsync(11_000);
  const wave = Array.from({ length: 16 }, () =>
    authenticate(provider, new Request(`${BASE}/mcp`), BASE, undefined, silentLogger),
  );
  // Fifteen of the wave fit the allowance; one stays active and overdue.
  await vi.advanceTimersByTimeAsync(11_000);
  expect(authenticationSnapshot()).toMatchObject({ active: 1, abandoned: 16 });
  const [oldest] = [...registry!.entries.values()];
  registry!.cleanup(oldest!.held);
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 16 });
  settle.forEach((release) => release());
  await Promise.all([stuck, ...wave]);
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0 });
});

it("INV-7: without FinalizationRegistry, settlement is the only release and /health says so", async () => {
  const { authenticate, authenticationSnapshot, registry } = await load(false);
  expect(registry).toBeUndefined();
  const { provider, settle } = controlled();
  const pending = authenticate(provider, new Request(`${BASE}/mcp`), BASE, undefined, silentLogger);
  expect(authenticationSnapshot()).toMatchObject({ active: 1, unreachableRelease: false });
  settle[0]!();
  await pending;
  expect(authenticationSnapshot()).toMatchObject({ active: 0, abandoned: 0, unreachableRelease: false });
});
