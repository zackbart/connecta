import { Deferred, Duration, Effect } from "effect";
import { admit, provideAdmissionProgram } from "./runtime/admission.js";
import { fromSignal, runEdge } from "./runtime/run.js";
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

/**
 * One queued caller. Its outcome is a Deferred completed by exactly one party:
 * release() with a lease, close() with a shutdown error, or the waiting fiber
 * itself on timeout or abort. remove() arbitrates, as it always has — only
 * the party that takes the waiter out of the queue may settle it.
 */
interface Waiter {
  readonly queuedAt: number;
  readonly outcome: Deferred.Deferred<AdmissionLease, ExecutorAdmissionError>;
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
    return runEdge(admit(this, options));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.closedTotal++;
      Deferred.doneUnsafe(
        waiter.outcome,
        Effect.fail(
          new ExecutorAdmissionError(
            "executor_closed",
            "Executor is shutting down.",
          ),
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
    const waitMs = Math.max(0, Date.now() - waiter.queuedAt);
    this.admittedTotal++;
    this.queueWaitCount++;
    this.queueWaitTotalMs += waitMs;
    this.queueWaitMaxMs = Math.max(this.queueWaitMaxMs, waitMs);
    this.active++;
    Deferred.doneUnsafe(waiter.outcome, Effect.succeed(this.makeLease(waitMs)));
  }

  private remove(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    return true;
  }

  // The waiting fiber was interrupted — an Effect caller's scope closed, not a
  // signal. Withdraw the waiter if it is still queued; if release() handed it
  // a slot in the same breath, give the slot back, because nobody is left to
  // receive the lease. (A line comment, not JSDoc: TypeScript copies a private
  // member's JSDoc into the published declaration.)
  private cleanup(waiter: Waiter): Effect.Effect<void> {
    if (this.remove(waiter)) {
      this.cancelledTotal++;
      return Effect.void;
    }
    if (!Deferred.isDoneUnsafe(waiter.outcome)) return Effect.void;
    return Deferred.await(waiter.outcome).pipe(
      Effect.tap((lease) => Effect.sync(() => lease.release())),
      Effect.ignore,
    );
  }

  // The admission program, handed to src/runtime/admission.ts. It lives in a
  // static block because the class declaration ships, private member names
  // and all: a new method or field would change the published `.d.ts`, and a
  // static block is the one place outside an instance method that may read
  // this bookkeeping while emitting nothing there.
  static {
    provideAdmissionProgram((controller, signal) =>
      Effect.suspend(() => {
        if (controller.closed) {
          controller.closedTotal++;
          return Effect.fail(
            new ExecutorAdmissionError(
              "executor_closed",
              "Executor is shutting down.",
            ),
          );
        }
        if (signal?.aborted) {
          controller.cancelledTotal++;
          return Effect.fail(
            new ExecutorAdmissionError(
              "executor_cancelled",
              "Execution was cancelled before admission.",
            ),
          );
        }
        if (controller.active < controller.concurrency) {
          controller.active++;
          controller.admittedTotal++;
          return Effect.succeed(controller.makeLease(0));
        }
        if (controller.waiters.length >= controller.maxQueueSize) {
          controller.rejectedTotal++;
          return Effect.fail(controller.overloaded("Executor queue is full."));
        }

        const waiter: Waiter = {
          queuedAt: Date.now(),
          outcome: Deferred.makeUnsafe(),
        };
        controller.waiters.push(waiter);
        controller.queuedTotal++;

        // A timeout or abort settles the waiter only if it takes it out of the
        // queue first. Otherwise release() or close() got there in the same
        // tick, and the outcome they recorded is the answer.
        const giveUp = (
          count: () => void,
          error: () => ExecutorAdmissionError,
        ): Effect.Effect<AdmissionLease, ExecutorAdmissionError> =>
          Effect.suspend(() => {
            if (!controller.remove(waiter)) return Deferred.await(waiter.outcome);
            count();
            return Effect.fail(error());
          });

        // One flat race; each contender is a forked fiber.
        const contenders = [
          Deferred.await(waiter.outcome),
          Effect.sleep(Duration.millis(controller.queueTimeoutMs)).pipe(
            Effect.andThen(
              giveUp(
                () => controller.rejectedTotal++,
                () =>
                  controller.overloaded(
                    `Executor admission timed out after ${controller.queueTimeoutMs}ms.`,
                  ),
              ),
            ),
          ),
        ];
        if (signal) {
          contenders.push(
            fromSignal(signal).pipe(
              Effect.catch(() =>
                giveUp(
                  () => controller.cancelledTotal++,
                  () =>
                    new ExecutorAdmissionError(
                      "executor_cancelled",
                      "Execution was cancelled while queued.",
                    ),
                ),
              ),
            ),
          );
        }
        return Effect.raceAllFirst(contenders).pipe(
          Effect.onInterrupt(() => controller.cleanup(waiter)),
        );
      }),
    );
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
