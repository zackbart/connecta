import type {
  AdmittingExecutor,
  Executor,
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

export interface AdmissionLease {
  release(): void;
}

interface Waiter {
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

  acquire(options: { signal?: AbortSignal } = {}): Promise<AdmissionLease> {
    if (this.closed) {
      return Promise.reject(
        new ExecutorAdmissionError(
          "executor_closed",
          "Executor is shutting down.",
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new ExecutorAdmissionError(
          "executor_cancelled",
          "Execution was cancelled before admission.",
        ),
      );
    }
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.makeLease());
    }
    if (this.waiters.length >= this.maxQueueSize) {
      return Promise.reject(this.overloaded("Executor queue is full."));
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      waiter.onAbort = () => {
        if (!this.remove(waiter)) return;
        this.cleanup(waiter);
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
        reject(
          this.overloaded(
            `Executor admission timed out after ${this.queueTimeoutMs}ms.`,
          ),
        );
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
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

  private makeLease(): AdmissionLease {
    let released = false;
    return {
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
    this.active++;
    waiter.resolve(this.makeLease());
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
