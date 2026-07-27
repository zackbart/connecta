import { describe, expect, it, vi } from "vitest";
import {
  AdmissionController,
  ExecutorAdmissionError,
} from "../src/executor-admission.js";

describe("AdmissionController", () => {
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
});
