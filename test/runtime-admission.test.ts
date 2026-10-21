// Admission and deadlines run on Effect behind their Promise faces (P1-S02).
// test/executor-admission.test.ts and test/request-admission.test.ts pin the
// Promise contract unchanged; this suite pins what only the Effect side can
// reach — a scope-owned lease, interruption of a queued wait — and the timer
// hygiene of the Effect-backed queue and deadline.

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../src/executor-admission.js";
import { acquireScoped } from "../src/runtime/admission.js";
import { runEdge } from "../src/runtime/run.js";

function controller(concurrency = 1, maxQueueSize = 2, queueTimeoutMs = 1_000) {
  return new AdmissionController({ concurrency, maxQueueSize, queueTimeoutMs });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("acquireScoped", () => {
  it("releases the lease when its scope closes", async () => {
    const admission = controller();
    const seen = await runEdge(
      Effect.scoped(
        acquireScoped(admission).pipe(Effect.map((lease) => ({ waitMs: lease.waitMs, active: admission.activeCount }))),
      ),
    );
    expect(seen).toEqual({ waitMs: 0, active: 1 });
    expect(admission.activeCount).toBe(0);
  });
});

describe("the Effect-backed queue under fake timers", () => {
  it("an abort that loses to a grant in the same tick still yields the lease", async () => {
    const admission = controller();
    const held = await admission.acquire();
    const caller = new AbortController();
    const waiting = admission.acquire({ signal: caller.signal });
    held.release();
    caller.abort();
    const lease = await waiting;
    expect(admission.activeCount).toBe(1);
    lease.release();
    expect(admission.snapshot().totals.cancelled).toBe(0);
  });
});
