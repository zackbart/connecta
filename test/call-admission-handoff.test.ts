// A queued call's permit is handed over by whichever request releases one,
// and on Workers that request may not touch the waiter's I/O objects: reading
// an AbortSignal another request created throws "Cannot perform I/O on behalf
// of a different request" (verified on workerd; see P1-S12). The signal here
// throws the same way whenever it is read from inside the releasing call.
import { describe, expect, it } from "vitest";
import {
  ConnectorCallAdmissionController,
  type CallAdmissionPermit,
} from "../src/call-admission.js";

function otherRequestsSignal(): {
  signal: AbortSignal;
  asReleaser: (release: () => void) => void;
} {
  const owner = new AbortController();
  let releasing = false;
  const signal = new Proxy(owner.signal, {
    get(target, key) {
      if (releasing && (key === "aborted" || key === "reason")) {
        throw new Error("Cannot perform I/O on behalf of a different request.");
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    signal,
    asReleaser(release) {
      releasing = true;
      try {
        release();
      } finally {
        releasing = false;
      }
    },
  };
}

describe("a permit handed across requests", () => {
  it("never reads the waiter's signal from the request that releases the slot", async () => {
    const admission = new ConnectorCallAdmissionController("limited", {
      rules: [{ maxConcurrency: 1 }],
    });
    const held = await admission.acquire({ toolName: "read", args: {} });
    const waiter = otherRequestsSignal();
    const queued = admission.acquire({
      toolName: "read",
      args: {},
      signal: waiter.signal,
    });
    expect(admission.snapshot().queued).toBe(1);

    waiter.asReleaser(() => held.release());

    const permit: CallAdmissionPermit = await queued;
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
    permit.release();
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      totals: { admitted: 2, cancelled: 0 },
    });
  });

  it("still withdraws a waiter whose own request gave up before its turn", async () => {
    const admission = new ConnectorCallAdmissionController("limited", {
      rules: [{ maxConcurrency: 1 }],
    });
    const held = await admission.acquire({ toolName: "read", args: {} });
    const caller = new AbortController();
    const queued = admission.acquire({
      toolName: "read",
      args: {},
      signal: caller.signal,
    });
    caller.abort(new Error("caller left"));
    await expect(queued).rejects.toMatchObject({ admissionKind: "cancelled" });

    held.release();
    expect(admission.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { admitted: 1, cancelled: 1 },
    });
  });
});
