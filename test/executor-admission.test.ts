import { describe, expect, it, vi } from "vitest";
import {
  AdmissionController,
  ExecutorAdmissionError,
} from "../src/executor-admission.js";

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

  it("hands an expired slot to the oldest waiter before a newcomer", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const admission = new AdmissionController({
        concurrency: 1,
        maxQueueSize: 1,
        queueTimeoutMs: 1_000,
        maxDurationMs: 50,
      });
      const old = await admission.acquire();
            const queued = admission.acquire();
      vi.setSystemTime(1_050);
      const newcomer = admission.acquire();
      const first = await queued;
      expect(first.waitMs).toBe(50);
      expect(admission.queuedCount).toBe(1);
      old.release();
      expect(admission.activeCount).toBe(1);
      first.release();
      (await newcomer).release();
      expect(admission.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a queued request's own timer reclaim a silent expired response", async () => {
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
            const queued = admission.acquire();
      await vi.advanceTimersByTimeAsync(50);
      const next = await queued;
      expect(admission.activeCount).toBe(1);
      old.release();
      expect(admission.activeCount).toBe(1);
      next.release();
      expect(admission.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hand an expired permit to a queued request whose timeout callback never ran", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const admission = new AdmissionController({
        concurrency: 1,
        maxQueueSize: 1,
        queueTimeoutMs: 40,
        maxDurationMs: 50,
      });
      const old = await admission.acquire();
            const orphaned = admission.acquire();
      const refused = expect(orphaned).rejects.toMatchObject({
        code: "executor_overloaded",
        message: "Executor admission timed out after 40ms.",
      });
      // Move the clock without running the orphan's timer or continuation.
      vi.setSystemTime(1_050);
      const next = await admission.acquire();
      await refused;
      expect(admission.queuedCount).toBe(0);
      expect(admission.activeCount).toBe(1);
      old.release();
      expect(admission.activeCount).toBe(1);
      next.release();
    } finally {
      vi.useRealTimers();
    }
  });
  it("reclaims an orphan promoted before its queue timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const admission = new AdmissionController({
        concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 500, maxDurationMs: 50,
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

  it("rejects overflow with stable retry metadata", async () => {
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 2_000,
      retryAfterMs: 750,
    });
    const active = await admission.acquire();
    const queued = admission.acquire();
    await expect(admission.acquire()).rejects.toMatchObject({
      name: "ExecutorAdmissionError",
      code: "executor_overloaded",
      retryable: true,
      retryAfterMs: 750,
      message: "Executor queue is full.",
    });
    active.release();
    (await queued).release();
  });

  it("removes an aborted queued caller without consuming the next slot", async () => {
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 2,
      queueTimeoutMs: 1_000,
    });
    const active = await admission.acquire();
    const controller = new AbortController();
    const cancelled = admission.acquire({ signal: controller.signal });
    const next = admission.acquire();
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({
      code: "executor_cancelled",
      retryable: false,
    });
    active.release();
    (await next).release();
    expect(admission.activeCount).toBe(0);
  });

  it("times out a queued caller and clears the losing timer", async () => {
    vi.useFakeTimers();
    try {
      const admission = new AdmissionController({
        concurrency: 1,
        maxQueueSize: 1,
        queueTimeoutMs: 25,
      });
      const active = await admission.acquire();
      const queued = admission.acquire();
      const rejected = expect(queued).rejects.toMatchObject({
        code: "executor_overloaded",
        retryable: true,
        message: "Executor admission timed out after 25ms.",
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      active.release();
    } finally {
      vi.useRealTimers();
    }
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

  it("reports payload-free totals and queue-wait observations", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const admission = new AdmissionController({
        concurrency: 1,
        maxQueueSize: 2,
        queueTimeoutMs: 1_000,
        retryAfterMs: 250,
      });
      const active = await admission.acquire();
      const queued = admission.acquire();
      vi.setSystemTime(1_125);
      active.release();
      const admitted = await queued;

      expect(admitted.waitMs).toBe(125);
      expect(admission.snapshot()).toEqual({
        concurrency: 1,
        maxQueueSize: 2,
        queueTimeoutMs: 1_000,
        retryAfterMs: 250,
        active: 1,
        queued: 0,
        closed: false,
        totals: {
          admitted: 2,
          queued: 1,
          rejected: 0,
          cancelled: 0,
          closed: 0,
        },
        queueWaitMs: { count: 1, total: 125, max: 125 },
      });
      admitted.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
