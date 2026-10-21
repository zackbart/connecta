// Call admission and connector scope close run on Effect behind their Promise
// faces (P1-S04). test/call-admission.test.ts pins the Promise contract; this
// suite pins an internal charge's partition, the call queue's timeout and
// abort/grant races, and the bounded connector scope close.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallAdmissionController } from "../src/call-admission.js";
import { closeConnectorScope } from "../src/connector-scope.js";
import { chargeCallBudget } from "../src/runtime/call-admission.js";
import { runEdge } from "../src/runtime/run.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";

const input = { toolName: "read", args: {} };

function limited(maxQueueSize = 2, queueTimeoutMs = 1_000) {
  return new ConnectorCallAdmissionController("limited", {
    rules: [{ maxConcurrency: 1, maxQueueSize, queueTimeoutMs }],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("internal call budget charges", () => {
  it("INV-4: charges the original partition without another permit or partition callback", async () => {
    const args = { project: "a" };
    const partitionKey = vi.fn(({ args }: { args: unknown }) => (args as { project: string }).project);
    const admission = new ConnectorCallAdmissionController("budgeted", {
      rules: [
        {
          maxConcurrency: 1,
          maxQueueSize: 0,
          budget: { kind: "rolling-window", maxCalls: 2, windowMs: 60_000 },
          partitionKey,
        },
      ],
    });
    const permit = await admission.acquire({ toolName: "read", args });
    args.project = "b";
    await runEdge(chargeCallBudget(permit));
    expect(partitionKey).toHaveBeenCalledTimes(1);
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0, totals: { admitted: 2 } });
    await expect(runEdge(chargeCallBudget(permit))).rejects.toMatchObject({ admissionKind: "budget" });
    permit.release();
    await expect(admission.acquire({ toolName: "read", args: { project: "a" } })).rejects.toMatchObject({
      admissionKind: "budget",
    });
    (await admission.acquire({ toolName: "read", args })).release();
  });
});

describe("the Effect-backed call queue", () => {
  it("times out on the faked clock and leaves no timer behind a grant", async () => {
    vi.useFakeTimers();
    const admission = limited(2, 25);
    const held = await admission.acquire(input);
    const rejected = expect(admission.acquire(input)).rejects.toMatchObject({
      admissionKind: "concurrency",
      message: 'Connector "limited" call concurrency queue wait exceeded 25ms.',
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    const granted = admission.acquire({
      ...input,
      signal: new AbortController().signal,
    });
    expect(vi.getTimerCount()).toBe(1);
    held.release();
    const permit = await granted;
    expect(permit.waitMs).toBe(0);
    permit.release();
    expect(vi.getTimerCount()).toBe(0);
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 2, queued: 2, rejected: 1 },
    });
    expect(admission.isIdle()).toBe(true);
  });

  it("an abort that lands before the grant is delivered still cancels", async () => {
    const admission = limited();
    const held = await admission.acquire(input);
    const caller = new AbortController();
    const waiting = admission.acquire({ ...input, signal: caller.signal });
    caller.abort(new Error("caller left"));
    held.release();
    await expect(waiting).rejects.toMatchObject({ admissionKind: "cancelled" });
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      totals: { admitted: 1, cancelled: 1 },
    });
  });

  it("a grant that lands before the abort keeps the permit", async () => {
    const admission = limited();
    const held = await admission.acquire(input);
    const caller = new AbortController();
    const waiting = admission.acquire({ ...input, signal: caller.signal });
    held.release();
    caller.abort();
    const permit = await waiting;
    expect(admission.snapshot().active).toBe(1);
    permit.release();
    expect(admission.snapshot().totals.cancelled).toBe(0);
  });
});

function closingConnector(closeScope: Connector["closeScope"]): Connector {
  return connectorWith({
    id: "scoped",
    kind: "api",
    description: "Scoped",
    ...(closeScope ? { closeScope } : {}),
  });
}

const ctx = {} as ConnectorContext;

describe("closeConnectorScope", () => {
  it("bounds the deferred tail of a close that never settles", async () => {
    vi.useFakeTimers();
    const deferred: Array<Promise<unknown>> = [];
    const closing = closeConnectorScope(
      closingConnector(() => new Promise<void>(() => {})),
      ctx,
      (promise) => deferred.push(promise),
    );
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    let tailDone = false;
    void deferred[0]!.then(() => {
      tailDone = true;
    });
    await vi.advanceTimersByTimeAsync(1_899);
    expect(tailDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(tailDone).toBe(true);
  });

  it("swallows a throwing hook, a rejecting hook, and a throwing defer", async () => {
    await expect(
      closeConnectorScope(
        closingConnector(() => {
          throw new Error("sync");
        }),
        ctx,
      ),
    ).resolves.toBeUndefined();
    await expect(
      closeConnectorScope(
        closingConnector(() => Promise.reject(new Error("async"))),
        ctx,
        () => {
          throw new Error("defer");
        },
      ),
    ).resolves.toBeUndefined();
    await expect(closeConnectorScope(closingConnector(undefined), ctx)).resolves.toBeUndefined();
  });
});
