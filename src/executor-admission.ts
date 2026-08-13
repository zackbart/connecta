import type {
  AdmittingExecutor,
  AdmissionSnapshot,
  Executor,
  ExecutorLease,
} from "./types.js";

export type ExecutorAdmissionErrorCode =
  | "executor_overloaded"
  | "executor_cancelled"
  | "executor_closed";

/**
 * A stable, machine-readable admission failure. Overload is retryable; caller
 * cancellation and shutdown are terminal for this invocation.
 */
export class ExecutorAdmissionError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: ExecutorAdmissionErrorCode,
    message: string,
    opts: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ExecutorAdmissionError";
    this.retryable = code === "executor_overloaded";
    if (
      opts.retryAfterMs !== undefined &&
      Number.isFinite(opts.retryAfterMs) &&
      opts.retryAfterMs >= 0
    ) {
      this.retryAfterMs = Math.trunc(opts.retryAfterMs);
    }
  }
}

/**
 * A lifecycle failure after the sandbox started running. It keeps the stable
 * admission-error envelope while letting response assembly distinguish work
 * torn down in flight from work that never entered the executor.
 */
export class ExecutorExecutionError extends ExecutorAdmissionError {
  constructor(code: ExecutorAdmissionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutorExecutionError";
  }
}

export interface AdmissionLease {
  /** Time spent waiting behind active work. Zero for immediate admission. */
  readonly waitMs: number;
  release(): void;
}

interface Waiter {
  queuedAt: number;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: ExecutorAdmissionError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AdmissionControllerOptions {
  concurrency: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  /** Suggested delay exposed with retryable overload failures. */
  retryAfterMs?: number;
}

function positiveWhole(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive whole number.`);
  }
  return value;
}

function nonNegativeWhole(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative whole number.`);
  }
  return value;
}

/**
 * Runtime-portable bounded admission. It deliberately owns no executor or
 * request state: queued requests retain only a resolver and AbortSignal, while
 * provider catalogs are constructed after the returned lease is granted.
 */
export class AdmissionController {
  readonly concurrency: number;
  readonly maxQueueSize: number;
  readonly queueTimeoutMs: number;
  readonly retryAfterMs: number;

  private active = 0;
  private closed = false;
  private readonly waiters: Waiter[] = [];
  private admittedTotal = 0;
  private queuedTotal = 0;
  private rejectedTotal = 0;
  private cancelledTotal = 0;
  private closedTotal = 0;
  private queueWaitCount = 0;
  private queueWaitTotalMs = 0;
  private queueWaitMaxMs = 0;

  constructor(options: AdmissionControllerOptions) {
    this.concurrency = positiveWhole(options.concurrency, "concurrency");
    this.maxQueueSize = nonNegativeWhole(
      options.maxQueueSize,
      "maxQueueSize",
    );
    this.queueTimeoutMs = positiveWhole(
      options.queueTimeoutMs,
      "queueTimeoutMs",
    );
    this.retryAfterMs = nonNegativeWhole(
      options.retryAfterMs ?? this.queueTimeoutMs,
      "retryAfterMs",
    );
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  snapshot(): AdmissionSnapshot {
    return {
      concurrency: this.concurrency,
      maxQueueSize: this.maxQueueSize,
      queueTimeoutMs: this.queueTimeoutMs,
      retryAfterMs: this.retryAfterMs,
      active: this.active,
      queued: this.waiters.length,
      closed: this.closed,
      totals: {
        admitted: this.admittedTotal,
        queued: this.queuedTotal,
        rejected: this.rejectedTotal,
        cancelled: this.cancelledTotal,
        closed: this.closedTotal,
      },
      queueWaitMs: {
        count: this.queueWaitCount,
        total: this.queueWaitTotalMs,
        max: this.queueWaitMaxMs,
      },
    };
  }

  acquire(options: { signal?: AbortSignal } = {}): Promise<AdmissionLease> {
    if (this.closed) {
      this.closedTotal++;
      return Promise.reject(
        new ExecutorAdmissionError(
          "executor_closed",
          "Executor is shutting down.",
        ),
      );
    }
    if (options.signal?.aborted) {
      this.cancelledTotal++;
      return Promise.reject(
        new ExecutorAdmissionError(
          "executor_cancelled",
          "Execution was cancelled before admission.",
        ),
      );
    }
    if (this.active < this.concurrency) {
      this.active++;
      this.admittedTotal++;
      return Promise.resolve(this.makeLease(0));
    }
    if (this.waiters.length >= this.maxQueueSize) {
      this.rejectedTotal++;
      return Promise.reject(this.overloaded("Executor queue is full."));
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        queuedAt: Date.now(),
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      waiter.onAbort = () => {
        if (!this.remove(waiter)) return;
        this.cleanup(waiter);
        this.cancelledTotal++;
        reject(
          new ExecutorAdmissionError(
            "executor_cancelled",
            "Execution was cancelled while queued.",
          ),
        );
      };
      options.signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiter.timer = setTimeout(() => {
        if (!this.remove(waiter)) return;
        this.cleanup(waiter);
        this.rejectedTotal++;
        reject(
          this.overloaded(
            `Executor admission timed out after ${this.queueTimeoutMs}ms.`,
          ),
        );
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
      this.queuedTotal++;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      this.closedTotal++;
      waiter.reject(
        new ExecutorAdmissionError(
          "executor_closed",
          "Executor is shutting down.",
        ),
      );
    }
  }

  private overloaded(message: string): ExecutorAdmissionError {
    return new ExecutorAdmissionError("executor_overloaded", message, {
      retryAfterMs: this.retryAfterMs,
    });
  }

  private makeLease(waitMs: number): AdmissionLease {
    let released = false;
    return {
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  private release(): void {
    if (this.active > 0) this.active--;
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    this.cleanup(waiter);
    const waitMs = Math.max(0, Date.now() - waiter.queuedAt);
    this.admittedTotal++;
    this.queueWaitCount++;
    this.queueWaitTotalMs += waitMs;
    this.queueWaitMaxMs = Math.max(this.queueWaitMaxMs, waitMs);
    this.active++;
    waiter.resolve(this.makeLease(waitMs));
  }

  private remove(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    return true;
  }

  private cleanup(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  }
}

/** Preserve the one-method Workers seam while recognizing richer Node executors. */
export function isAdmittingExecutor(
  executor: Executor,
): executor is AdmittingExecutor {
  return (
    "acquire" in executor &&
    typeof (executor as { acquire?: unknown }).acquire === "function"
  );
}

/** Terminal- and JSON-safe upper bound for an executor's self-reported name. */
const MAX_EXECUTOR_NAME_LENGTH = 40;

/**
 * Best-effort name for the configured sandbox, for `/health` and through it
 * `connecta doctor` — which otherwise has to guess, and guessed QuickJS at
 * every deployment including the Workers one ([#368]). The executor seam is
 * structural, so this reads what is already there: an explicit `name`, else
 * the constructor name a class-shaped executor carries for free. The value is
 * a stranger's string bound for a public response body and an operator's
 * terminal, so it is sanitized rather than trusted; nothing identifiable
 * reports nothing, and doctor says so instead of naming a sandbox.
 */
export function executorName(executor: Executor): string | undefined {
  const declared = (executor as { name?: unknown }).name;
  const ctor = (executor as { constructor?: { name?: unknown } }).constructor;
  const raw =
    typeof declared === "string" && declared.trim()
      ? declared
      : typeof ctor?.name === "string" && ctor.name !== "Object"
        ? ctor.name
        : "";
  const cleaned = raw
    .replace(/[^\w .+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXECUTOR_NAME_LENGTH)
    .trim();
  return cleaned || undefined;
}

/**
 * Give a structurally-compatible but otherwise unbounded executor the same
 * admission contract as the built-in Node executor. The wrapper owns only the
 * queue; closing the underlying runtime remains the Connecta lifecycle's job.
 */
export function withExecutorAdmission(
  executor: Executor,
  admission: AdmissionController,
): AdmittingExecutor {
  return {
    async acquire(options = {}): Promise<ExecutorLease> {
      const token = await admission.acquire(options);
      let released = false;
      return {
        waitMs: token.waitMs,
        execute: (code, providers) => executor.execute(code, providers),
        release: () => {
          if (released) return;
          released = true;
          token.release();
        },
      };
    },
    async execute(code, providers) {
      const lease = await this.acquire();
      try {
        return await lease.execute(code, providers);
      } finally {
        lease.release();
      }
    },
    admissionSnapshot: () => admission.snapshot(),
  };
}
