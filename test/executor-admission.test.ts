import { describe, expect, it, vi } from "vitest";
import { AdmissionController, ExecutorAdmissionError } from "../src/executor-admission.js";

describe("AdmissionController", () => {
  it("reclaims an expired response lease before a new admission without releasing its successor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const admission = new AdmissionController({
        concurrency: 1,
        maxQueueSize: 0,
        queueTimeoutMs: 1_000,
        maxDurationMs: 50,
      });
      const old = await admission.acquire();
      vi.setSystemTime(1_049);
      await expect(admission.acquire()).rejects.toMatchObject({ code: "executor_overloaded" });

      // No timer or old-response callback runs. The incoming request itself
      // reaps only the expired lease's scalar admission record.
      vi.setSystemTime(1_050);
      const next = await admission.acquire();
      expect(admission.activeCount).toBe(1);
      old.release();
      old.release();
      expect(old.remainingMs()).toBe(0);
      expect(admission.activeCount).toBe(1);
      next.release();
      expect(admission.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims an orphan promoted before its queue timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const admission = new AdmissionController({
        concurrency: 1,
        maxQueueSize: 1,
        queueTimeoutMs: 500,
        maxDurationMs: 50,
      });
      const old = await admission.acquire();
      const orphaned = admission.acquire();
      // Promotion happens while the queued request is still eligible, but its
      // continuation never acts on the permit (as in a runtime-ended request).
      vi.setSystemTime(1_050);
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
      vi.setSystemTime(1_100);
      const successor = await admission.acquire();
      old.release();
      (await orphaned).release();
      expect(admission.activeCount).toBe(1);
      successor.release();
      expect(admission.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds active work and admits queued callers in FIFO order", async () => {
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 2,
      queueTimeoutMs: 1_000,
    });
    const first = await admission.acquire();
    const order: number[] = [];
    const second = admission.acquire().then((lease) => {
      order.push(2);
      return lease;
    });
    const third = admission.acquire().then((lease) => {
      order.push(3);
      return lease;
    });

    expect(admission.activeCount).toBe(1);
    expect(admission.queuedCount).toBe(2);
    first.release();
    const secondLease = await second;
    expect(order).toEqual([2]);
    secondLease.release();
    const thirdLease = await third;
    expect(order).toEqual([2, 3]);
    thirdLease.release();
    expect(admission.activeCount).toBe(0);
  });

  it("closes queued and future admission while active leases release safely", async () => {
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 1_000,
    });
    const active = await admission.acquire();
    const queued = admission.acquire();
    admission.close();

    await expect(queued).rejects.toBeInstanceOf(ExecutorAdmissionError);
    await expect(admission.acquire()).rejects.toMatchObject({
      code: "executor_closed",
      retryable: false,
    });
    active.release();
    active.release();
    expect(admission.activeCount).toBe(0);
  });
});
