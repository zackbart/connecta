import { Deferred, Duration, Effect } from "effect";
import { ConnectorCallError } from "./errors.js";
import {
  provideCallAdmissionProgram,
  startCallAdmission,
} from "./runtime/call-admission.js";
import { fromSignal, runEdge } from "./runtime/run.js";
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

/**
 * One queued call. Its outcome is a Deferred completed by exactly one party:
 * the pump with a permit or a refusal, close() with a shutdown error, or the
 * waiting fiber itself on timeout or abort. removeWaiter() arbitrates — only
 * the party that takes the waiter out of the queue may settle it. A waiter
 * holds a clock and a continuation; never the call's arguments, and never its
 * signal, which belongs to the waiter's request and is watched from there.
 */
interface Waiter {
  readonly queuedAt: number;
  readonly now: () => number;
  readonly outcome: Deferred.Deferred<CallAdmissionPermit, CallAdmissionError>;
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

/** Sum gauges and counters without publishing connector or principal keys. */
export function aggregateCallAdmissionSnapshots(
  snapshots: readonly ConnectorCallAdmissionSnapshot[],
): ConnectorCallAdmissionSnapshot {
  const aggregate: ConnectorCallAdmissionSnapshot = {
    rules: 0, partitions: 0, active: 0, queued: 0, closed: snapshots.length > 0,
    totals: { admitted: 0, queued: 0, rejected: 0, rateLimited: 0, cancelled: 0 },
    queueWaitMs: { count: 0, total: 0, max: 0 },
  };
  for (const snapshot of snapshots) {
    for (const key of ["rules", "partitions", "active", "queued"] as const) {
      aggregate[key] += snapshot[key];
    }
    aggregate.closed &&= snapshot.closed;
    for (const key of ["admitted", "queued", "rejected", "rateLimited", "cancelled"] as const) {
      aggregate.totals[key] += snapshot.totals[key];
    }
    aggregate.queueWaitMs.count += snapshot.queueWaitMs.count;
    aggregate.queueWaitMs.total += snapshot.queueWaitMs.total;
    aggregate.queueWaitMs.max = Math.max(aggregate.queueWaitMs.max, snapshot.queueWaitMs.max);
  }
  return aggregate;
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
    // The checks run now and the returned effect only waits. It closes over
    // the partition key, not `input`, so a queued call does not retain its
    // `args` — the limiter's payload-free state contract.
    return runEdge(startCallAdmission(this, input));
  }

  /** A principal registry may be evicted only after calls and budgets drain. */
  isIdle(): boolean {
    this.evictIdlePartitions(Date.now());
    return this.partitions.size === 0;
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
        Deferred.doneUnsafe(
          waiter.outcome,
          Effect.fail(
            new CallAdmissionError(
              "closed",
              "unavailable",
              `Connector "${this.connectorId}" call admission is closed.`,
            ),
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
      // The waiter's signal is not read here. This runs in whichever request
      // released a slot, and on Workers reading an AbortSignal that another
      // request created throws, failing the releaser and stranding the
      // waiter. Nor does it need reading: a waiter whose signal aborted took
      // itself out of the queue when it did, from its own abort listener.
      //
      // The waiter's own clock: the fiber's Clock for an Effect caller, the
      // live `Date.now` for a Promise one.
      const now = waiter.now();
      this.pruneBudget(state, now);
      const retryAfterMs = this.budgetRetryAfterMs(state, now);
      if (retryAfterMs !== undefined) {
        this.rateLimitedTotal++;
        Deferred.doneUnsafe(
          waiter.outcome,
          Effect.fail(this.budgetLimited(retryAfterMs)),
        );
        continue;
      }
      const waitMs = Math.max(0, now - waiter.queuedAt);
      Deferred.doneUnsafe(
        waiter.outcome,
        Effect.succeed(this.admit(state, now, waitMs)),
      );
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

  // The waiting fiber was interrupted — an Effect caller's scope closed, not a
  // signal. Withdraw the waiter if it is still queued; if the pump handed it a
  // permit in the same breath, give the slot back, because nobody is left to
  // receive it. (A line comment, not JSDoc: TypeScript copies a private
  // member's JSDoc into the published declaration.)
  private cleanupWaiter(
    key: string,
    state: PartitionState,
    waiter: Waiter,
  ): Effect.Effect<void> {
    if (this.removeWaiter(state, waiter)) {
      this.cancelledTotal++;
      this.maybeDeletePartition(key, state, waiter.now());
      return Effect.void;
    }
    if (!Deferred.isDoneUnsafe(waiter.outcome)) return Effect.void;
    return Deferred.await(waiter.outcome).pipe(
      Effect.tap((permit) => Effect.sync(() => permit.release())),
      Effect.ignore,
    );
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

  // The admission program, handed to src/runtime/call-admission.ts. It lives
  // in a static block because the class declaration ships, private member
  // names and all: a new method or field would change the published `.d.ts`,
  // and a static block is the one place outside an instance method that may
  // read this bookkeeping while emitting nothing there.
  //
  // Calling the program decides: everything up to a grant, a refusal, or a
  // place in the queue happens synchronously, and only the queued wait is left
  // for a fiber. Semaphore does not fit that wait — permits here are
  // per-partition, the queue is bounded and counted, and each waiter carries
  // its own timeout and budget recheck — so the queue stays explicit, as in
  // AdmissionController, with a Deferred per waiter.
  static {
    provideCallAdmissionProgram((controller, input, now) => {
      // Copy the signal out before building the wait: the effect returned
      // below must not reach `input`, or a queued call would retain `args`.
      const signal = input.signal;
      if (controller.closed) {
        return Effect.fail(
          new CallAdmissionError(
            "closed",
            "unavailable",
            `Connector "${controller.connectorId}" call admission is closed.`,
          ),
        );
      }
      if (signal?.aborted) {
        controller.cancelledTotal++;
        return Effect.fail(controller.cancelled(signal));
      }

      let key: string;
      try {
        key = controller.partitionKey
          ? controller.partitionKey({
              toolName: input.toolName,
              args: input.args,
            })
          : DEFAULT_PARTITION_KEY;
      } catch (cause) {
        controller.rejectedTotal++;
        return Effect.fail(
          new CallAdmissionError(
            "partition",
            "connector_call_failed",
            `Connector "${controller.connectorId}" call-admission partitionKey threw.`,
            { cause },
          ),
        );
      }
      if (
        typeof key !== "string" ||
        enc.encode(key).length > MAX_PARTITION_KEY_BYTES
      ) {
        controller.rejectedTotal++;
        return Effect.fail(
          new CallAdmissionError(
            "partition",
            "connector_call_failed",
            `Connector "${controller.connectorId}" call-admission partitionKey must return a string of at most ${MAX_PARTITION_KEY_BYTES} UTF-8 bytes.`,
          ),
        );
      }
      // A partition callback is operator code and may synchronously abort the
      // caller. Recheck after it returns so that cancellation cannot consume a
      // budget entry or concurrency slot.
      if (signal?.aborted) {
        controller.cancelledTotal++;
        return Effect.fail(controller.cancelled(signal));
      }

      const queuedAt = now();
      let found = controller.partitions.get(key);
      if (!found) {
        controller.evictIdlePartitions(queuedAt);
        if (controller.partitions.size >= controller.maxPartitions) {
          controller.rejectedTotal++;
          return Effect.fail(
            new CallAdmissionError(
              "partition",
              "rate_limited",
              `Connector "${controller.connectorId}" call-admission partition capacity is exhausted.`,
              { retryAfterMs: controller.retryAfterMs },
            ),
          );
        }
        found = { active: 0, waiters: [], admittedAt: [] };
        controller.partitions.set(key, found);
      }
      const state = found;
      controller.pruneBudget(state, queuedAt);
      const budgetRetryAfterMs = controller.budgetRetryAfterMs(state, queuedAt);
      if (budgetRetryAfterMs !== undefined) {
        controller.rateLimitedTotal++;
        return Effect.fail(controller.budgetLimited(budgetRetryAfterMs));
      }
      if (
        controller.maxConcurrency === undefined ||
        state.active < controller.maxConcurrency
      ) {
        return Effect.succeed(controller.admit(state, queuedAt, 0));
      }
      if (state.waiters.length >= controller.maxQueueSize) {
        controller.rejectedTotal++;
        return Effect.fail(controller.concurrencyLimited("queue is full"));
      }

      const waiter: Waiter = {
        queuedAt,
        now,
        outcome: Deferred.makeUnsafe(),
      };
      state.waiters.push(waiter);
      controller.queuedTotal++;

      // A timeout or abort settles the waiter only if it takes it out of the
      // queue first. Otherwise the pump or close() got there in the same tick,
      // and the outcome they recorded is the answer.
      const giveUp = (
        count: () => void,
        error: () => CallAdmissionError,
      ): Effect.Effect<CallAdmissionPermit, CallAdmissionError> =>
        Effect.suspend(() => {
          if (!controller.removeWaiter(state, waiter)) {
            return Deferred.await(waiter.outcome);
          }
          count();
          const refusal = error();
          controller.maybeDeletePartition(key, state, now());
          return Effect.fail(refusal);
        });

      // One flat race; each contender is a forked fiber. The abort contender
      // checks the signal as it starts, which closes the check-to-listener
      // race an AbortSignal would not replay.
      const contenders = [
        Deferred.await(waiter.outcome),
        Effect.sleep(Duration.millis(controller.queueTimeoutMs)).pipe(
          Effect.andThen(
            giveUp(
              () => controller.rejectedTotal++,
              () =>
                controller.concurrencyLimited(
                  `queue wait exceeded ${controller.queueTimeoutMs}ms`,
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
                () => controller.cancelled(signal),
              ),
            ),
          ),
        );
      }
      return Effect.raceAllFirst(contenders).pipe(
        Effect.onInterrupt(() => controller.cleanupWaiter(key, state, waiter)),
      );
    });
  }
}
