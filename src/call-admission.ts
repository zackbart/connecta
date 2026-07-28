import { ConnectorCallError } from "./errors.js";
import type {
  ConnectorCallAdmissionInput,
  ConnectorCallAdmissionPolicy,
  ConnectorCallAdmissionRule,
} from "./types.js";

const DEFAULT_MAX_QUEUE_SIZE = 32;
const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const DEFAULT_MAX_PARTITIONS = 1_024;
const MAX_PARTITION_KEY_BYTES = 128;
const DEFAULT_PARTITION_KEY = "";
const enc = new TextEncoder();

export type CallAdmissionFailureKind =
  | "concurrency"
  | "budget"
  | "cancelled"
  | "closed"
  | "partition";

/**
 * A locally-produced connector-call failure. Extending ConnectorCallError
 * preserves the public error envelope while letting call paths avoid recording
 * a refusal as evidence that the downstream provider is unhealthy.
 */
export class CallAdmissionError extends ConnectorCallError {
  constructor(
    readonly admissionKind: CallAdmissionFailureKind,
    code: ConstructorParameters<typeof ConnectorCallError>[0],
    message: string,
    opts: ConstructorParameters<typeof ConnectorCallError>[2] = {},
  ) {
    super(code, message, opts);
    this.name = "CallAdmissionError";
  }
}

export function isCallAdmissionError(
  error: unknown,
): error is CallAdmissionError {
  return error instanceof CallAdmissionError;
}

export interface CallAdmissionPermit {
  /** Time spent in the concurrency queue. Zero for immediate admission. */
  readonly waitMs: number;
  /** Idempotent. */
  release(): void;
}

interface Waiter {
  queuedAt: number;
  resolve: (permit: CallAdmissionPermit) => void;
  reject: (error: CallAdmissionError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PartitionState {
  active: number;
  waiters: Waiter[];
  admittedAt: number[];
}

export interface ConnectorCallAdmissionSnapshot {
  rules: number;
  partitions: number;
  active: number;
  queued: number;
  closed: boolean;
  totals: {
    admitted: number;
    queued: number;
    rejected: number;
    rateLimited: number;
    cancelled: number;
  };
  queueWaitMs: {
    count: number;
    total: number;
    max: number;
  };
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
 * Per-runtime, per-connector call admission. State contains only bounded
 * partition keys, counters, timestamps, signals, and promise continuations;
 * tool arguments never enter the controller.
 */
export class ConnectorCallAdmissionController {
  private readonly maxConcurrency: number | undefined;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private readonly retryAfterMs: number;
  private readonly maxPartitions: number;
  private readonly budget:
    | { maxCalls: number; windowMs: number }
    | undefined;
  private readonly partitionKey:
    | ConnectorCallAdmissionRule["partitionKey"]
    | undefined;
  private readonly partitions = new Map<string, PartitionState>();
  private closed = false;
  private admittedTotal = 0;
  private queuedTotal = 0;
  private rejectedTotal = 0;
  private rateLimitedTotal = 0;
  private cancelledTotal = 0;
  private queueWaitCount = 0;
  private queueWaitTotalMs = 0;
  private queueWaitMaxMs = 0;

  constructor(
    readonly connectorId: string,
    policy: ConnectorCallAdmissionPolicy,
  ) {
    if (!Array.isArray(policy.rules) || policy.rules.length !== 1) {
      throw new TypeError(
        `connector "${connectorId}" callAdmission.rules must contain exactly one rule in this release.`,
      );
    }
    const rule = policy.rules[0];
    if (
      rule.maxConcurrency === undefined &&
      rule.budget === undefined
    ) {
      throw new TypeError(
        `connector "${connectorId}" callAdmission rule must declare maxConcurrency or budget.`,
      );
    }
    this.maxConcurrency =
      rule.maxConcurrency === undefined
        ? undefined
        : positiveWhole(
            rule.maxConcurrency,
            `connector "${connectorId}" callAdmission maxConcurrency`,
          );
    if (
      this.maxConcurrency === undefined &&
      (rule.maxQueueSize !== undefined ||
        rule.queueTimeoutMs !== undefined ||
        rule.retryAfterMs !== undefined)
    ) {
      throw new TypeError(
        `connector "${connectorId}" callAdmission queue settings require maxConcurrency.`,
      );
    }
    this.maxQueueSize = nonNegativeWhole(
      rule.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      `connector "${connectorId}" callAdmission maxQueueSize`,
    );
    this.queueTimeoutMs = positiveWhole(
      rule.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
      `connector "${connectorId}" callAdmission queueTimeoutMs`,
    );
    this.retryAfterMs = nonNegativeWhole(
      rule.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      `connector "${connectorId}" callAdmission retryAfterMs`,
    );
    this.maxPartitions = positiveWhole(
      policy.maxPartitions ?? DEFAULT_MAX_PARTITIONS,
      `connector "${connectorId}" callAdmission maxPartitions`,
    );
    if (rule.budget) {
      if (rule.budget.kind !== "rolling-window") {
        throw new TypeError(
          `connector "${connectorId}" callAdmission budget kind must be "rolling-window".`,
        );
      }
      const maxCalls = positiveWhole(
        rule.budget.maxCalls,
        `connector "${connectorId}" callAdmission budget.maxCalls`,
      );
      const windowMs = positiveWhole(
        rule.budget.windowMs,
        `connector "${connectorId}" callAdmission budget.windowMs`,
      );
      this.budget = { maxCalls, windowMs };
    } else {
      this.budget = undefined;
    }
    this.partitionKey = rule.partitionKey;
  }

  acquire(
    input: Readonly<ConnectorCallAdmissionInput> & { signal?: AbortSignal },
  ): Promise<CallAdmissionPermit> {
    // Copy the signal out before constructing any waiter closure. Referencing
    // `input` from a queued callback would retain its `args`, defeating the
    // limiter's payload-free state contract.
    const signal = input.signal;
    if (this.closed) {
      return Promise.reject(
        new CallAdmissionError(
          "closed",
          "unavailable",
          `Connector "${this.connectorId}" call admission is closed.`,
        ),
      );
    }
    if (signal?.aborted) {
      this.cancelledTotal++;
      return Promise.reject(this.cancelled(signal));
    }

    let key: string;
    try {
      key = this.partitionKey
        ? this.partitionKey({
            toolName: input.toolName,
            args: input.args,
          })
        : DEFAULT_PARTITION_KEY;
    } catch (cause) {
      this.rejectedTotal++;
      return Promise.reject(
        new CallAdmissionError(
          "partition",
          "connector_call_failed",
          `Connector "${this.connectorId}" call-admission partitionKey threw.`,
          { cause },
        ),
      );
    }
    if (
      typeof key !== "string" ||
      enc.encode(key).length > MAX_PARTITION_KEY_BYTES
    ) {
      this.rejectedTotal++;
      return Promise.reject(
        new CallAdmissionError(
          "partition",
          "connector_call_failed",
          `Connector "${this.connectorId}" call-admission partitionKey must return a string of at most ${MAX_PARTITION_KEY_BYTES} UTF-8 bytes.`,
        ),
      );
    }
    // A partition callback is operator code and may synchronously abort the
    // caller. Recheck after it returns so that cancellation cannot consume a
    // budget entry or concurrency slot.
    if (signal?.aborted) {
      this.cancelledTotal++;
      return Promise.reject(this.cancelled(signal));
    }

    const now = Date.now();
    let state = this.partitions.get(key);
    if (!state) {
      this.evictIdlePartitions(now);
      if (this.partitions.size >= this.maxPartitions) {
        this.rejectedTotal++;
        return Promise.reject(
          new CallAdmissionError(
            "partition",
            "rate_limited",
            `Connector "${this.connectorId}" call-admission partition capacity is exhausted.`,
            { retryAfterMs: this.retryAfterMs },
          ),
        );
      }
      state = {
        active: 0,
        waiters: [],
        admittedAt: [],
      };
      this.partitions.set(key, state);
    }
    this.pruneBudget(state, now);
    const budgetRetryAfterMs = this.budgetRetryAfterMs(state, now);
    if (budgetRetryAfterMs !== undefined) {
      this.rateLimitedTotal++;
      return Promise.reject(this.budgetLimited(budgetRetryAfterMs));
    }
    if (
      this.maxConcurrency === undefined ||
      state.active < this.maxConcurrency
    ) {
      return Promise.resolve(this.admit(state, now, 0));
    }
    if (state.waiters.length >= this.maxQueueSize) {
      this.rejectedTotal++;
      return Promise.reject(this.concurrencyLimited("queue is full"));
    }

    return new Promise<CallAdmissionPermit>((resolve, reject) => {
      const waiter: Waiter = {
        queuedAt: now,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      waiter.onAbort = () => {
        if (!this.removeWaiter(state!, waiter)) return;
        this.cleanupWaiter(waiter);
        this.cancelledTotal++;
        reject(this.cancelled(signal!));
        this.maybeDeletePartition(key, state!, Date.now());
      };
      waiter.timer = setTimeout(() => {
        if (!this.removeWaiter(state!, waiter)) return;
        this.cleanupWaiter(waiter);
        this.rejectedTotal++;
        reject(
          this.concurrencyLimited(
            `queue wait exceeded ${this.queueTimeoutMs}ms`,
          ),
        );
        this.maybeDeletePartition(key, state!, Date.now());
      }, this.queueTimeoutMs);
      state!.waiters.push(waiter);
      this.queuedTotal++;
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      // Close the check-to-listener race: an abort before registration is not
      // replayed by AbortSignal, so inspect it once after the waiter is fully
      // removable and its timer is installed.
      if (signal?.aborted) waiter.onAbort();
    });
  }

  snapshot(): ConnectorCallAdmissionSnapshot {
    let active = 0;
    let queued = 0;
    for (const state of this.partitions.values()) {
      active += state.active;
      queued += state.waiters.length;
    }
    return {
      rules: 1,
      partitions: this.partitions.size,
      active,
      queued,
      closed: this.closed,
      totals: {
        admitted: this.admittedTotal,
        queued: this.queuedTotal,
        rejected: this.rejectedTotal,
        rateLimited: this.rateLimitedTotal,
        cancelled: this.cancelledTotal,
      },
      queueWaitMs: {
        count: this.queueWaitCount,
        total: this.queueWaitTotalMs,
        max: this.queueWaitMaxMs,
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.partitions.values()) {
      for (const waiter of state.waiters.splice(0)) {
        this.cleanupWaiter(waiter);
        waiter.reject(
          new CallAdmissionError(
            "closed",
            "unavailable",
            `Connector "${this.connectorId}" call admission is closed.`,
          ),
        );
      }
    }
  }

  private admit(
    state: PartitionState,
    now: number,
    waitMs: number,
  ): CallAdmissionPermit {
    state.active++;
    if (this.budget) state.admittedAt.push(now);
    this.admittedTotal++;
    if (waitMs > 0) {
      this.queueWaitCount++;
      this.queueWaitTotalMs += waitMs;
      this.queueWaitMaxMs = Math.max(this.queueWaitMaxMs, waitMs);
    }
    let released = false;
    return {
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        if (state.active > 0) state.active--;
        this.pump(state);
      },
    };
  }

  private pump(state: PartitionState): void {
    if (this.closed || this.maxConcurrency === undefined) return;
    while (
      state.active < this.maxConcurrency &&
      state.waiters.length > 0
    ) {
      const waiter = state.waiters.shift()!;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        this.cancelledTotal++;
        waiter.reject(this.cancelled(waiter.signal));
        continue;
      }
      const now = Date.now();
      this.pruneBudget(state, now);
      const retryAfterMs = this.budgetRetryAfterMs(state, now);
      if (retryAfterMs !== undefined) {
        this.rateLimitedTotal++;
        waiter.reject(this.budgetLimited(retryAfterMs));
        continue;
      }
      const waitMs = Math.max(0, now - waiter.queuedAt);
      waiter.resolve(this.admit(state, now, waitMs));
    }
  }

  private pruneBudget(state: PartitionState, now: number): void {
    const budget = this.budget;
    if (!budget || state.admittedAt.length === 0) return;
    let expired = 0;
    while (expired < state.admittedAt.length) {
      const admittedAt = state.admittedAt[expired];
      if (admittedAt === undefined || admittedAt + budget.windowMs > now) {
        break;
      }
      expired++;
    }
    if (expired > 0) state.admittedAt.splice(0, expired);
  }

  private budgetRetryAfterMs(
    state: PartitionState,
    now: number,
  ): number | undefined {
    const budget = this.budget;
    if (!budget || state.admittedAt.length < budget.maxCalls) {
      return undefined;
    }
    const oldestAdmission = state.admittedAt[0];
    if (oldestAdmission === undefined) return undefined;
    return Math.max(0, oldestAdmission + budget.windowMs - now);
  }

  private evictIdlePartitions(now: number): void {
    for (const [key, state] of this.partitions) {
      this.pruneBudget(state, now);
      this.maybeDeletePartition(key, state, now);
    }
  }

  private maybeDeletePartition(
    key: string,
    state: PartitionState,
    now: number,
  ): void {
    this.pruneBudget(state, now);
    if (
      state.active === 0 &&
      state.waiters.length === 0 &&
      state.admittedAt.length === 0
    ) {
      this.partitions.delete(key);
    }
  }

  private removeWaiter(state: PartitionState, waiter: Waiter): boolean {
    const index = state.waiters.indexOf(waiter);
    if (index < 0) return false;
    state.waiters.splice(index, 1);
    return true;
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  }

  private concurrencyLimited(reason: string): CallAdmissionError {
    return new CallAdmissionError(
      "concurrency",
      "rate_limited",
      `Connector "${this.connectorId}" call concurrency ${reason}.`,
      { retryAfterMs: this.retryAfterMs },
    );
  }

  private budgetLimited(retryAfterMs: number): CallAdmissionError {
    return new CallAdmissionError(
      "budget",
      "rate_limited",
      `Connector "${this.connectorId}" rolling call budget is exhausted.`,
      { retryAfterMs },
    );
  }

  private cancelled(signal: AbortSignal): CallAdmissionError {
    return new CallAdmissionError(
      "cancelled",
      "timeout",
      `Connector "${this.connectorId}" call was cancelled before admission.`,
      { cause: signal.reason },
    );
  }
}
