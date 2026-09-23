// Node's built-in code-mode executor. QuickJS itself lives in a disposable
// child process: guest CPU, WASM aborts, and interpreter OOMs cannot block or
// terminate the HTTP-serving process.
//
// The pool is Effect inside and Promise at the edge. A child process is a
// scoped resource: its Scope owns the startup watchdog and a finalizer that
// kills the process and waits a bounded time for it to go. Retiring a child —
// recycled after a deadline, a cancellation, a released lease, or shutdown —
// is closing that Scope, so every path out of a child runs the same teardown.
// Respawn after a crash waits out a Schedule. The IPC protocol stays plain:
// the child's messages arrive as Node events, and host calls are the
// Promise-shaped provider functions execute.ts hands over.

import { Buffer } from "node:buffer";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Deferred, Duration, Effect, Exit, Schedule, Scope } from "effect";
import {
  AdmissionController,
  ExecutorAdmissionError,
  ExecutorExecutionError,
} from "../executor-admission.js";
import { msg } from "../errors.js";
import { MAX_EXECUTE_LOG_CHARS } from "../executor-result.js";
import { detach, fromSignal, runEdge } from "../runtime/run.js";
import type {
  AdmittingExecutor,
  AdmissionSnapshot,
  ExecuteResult,
  ExecutorLease,
  ExecutorProvider,
} from "../types.js";
import {
  hostCallLabel,
  MAX_QUICKJS_IPC_BYTES,
  MAX_QUICKJS_HOST_RPC_BYTES,
  type ChildToParentMessage,
  type ExecutionPayload,
  type HostCallPayload,
  type HostResultPayload,
  type ParentToChildMessage,
  type RunPayload,
  serializedBytes,
  stringifyBounded,
} from "./quickjs-protocol.js";
import type { QuickJsRuntimeOptions } from "./quickjs-runtime.js";

export { normalizeCode } from "./quickjs-runtime.js";

export interface QuickJsExecutorOptions {
  /**
   * Wall-clock budget for the whole execution, host tool calls included.
   * Default 30s.
   */
  timeoutMs?: number;
  /**
   * Cumulative time spent synchronously driving guest JavaScript. Host waits do
   * not consume it. Default 250ms.
   */
  cpuTimeMs?: number;
  /** Guest heap limit per child execution. Default 64 MiB. */
  memoryLimitBytes?: number;
  /** Guest stack limit. Default 1 MiB. */
  maxStackSizeBytes?: number;
  /** Maximum simultaneous executions/child processes. Default 1. */
  concurrency?: number;
  /** Maximum callers waiting before provider construction. Default 32. */
  maxQueueSize?: number;
  /** Maximum admission wait. Default 5s. */
  queueTimeoutMs?: number;
}

// One execution in flight on a slot. `outcome` is settled exactly once — by
// the child's result, a crash, a failed send, the wall deadline, the caller's
// abort, a released lease, or shutdown — and the running program awaits it.
interface ActiveRun {
  id: number;
  logs: string[];
  logChars: number;
  providers: Map<string, ExecutorProvider>;
  outcome: Deferred.Deferred<ExecuteResult, Error>;
}

// One forked child process and the Scope that owns it.
interface Child {
  readonly process: ChildProcess;
  readonly scope: Scope.Closeable;
  // Settled by the child's "ready" message, or failed by whatever ends it
  // first. Shared: a caller that stops waiting leaves the child warming for
  // the next lease on the slot.
  readonly ready: Deferred.Deferred<void, Error>;
  // Settled by the first of "exit" and "close"; the finalizer's bounded wait.
  readonly exited: Deferred.Deferred<void>;
  // Set when the pool let the child go. Its exit is then expected and never
  // counts as a crash.
  retired: boolean;
}

// The crash-respawn step: from the time of a crash to the earliest moment a
// replacement may start.
type CrashStep = (crashedAt: number) => Effect.Effect<number>;

interface ChildSlot {
  child?: Child | undefined;
  active?: ActiveRun | undefined;
  // Crashes not yet charged to the backoff; the next spawn charges them.
  crashes: number[];
  // The backoff Schedule's live step state, for as long as a crash streak
  // lasts. A result from a child ends the streak.
  backoff?: CrashStep | undefined;
  notBefore: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CPU_TIME_MS = 250;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_STACK_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_QUEUE_SIZE = 32;
const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;
const CHILD_EXIT_GRACE_MS = 250;
const CHILD_STARTUP_TIMEOUT_MS = 10_000;
// How long a retired child gets to exit after SIGTERM before SIGKILL.
const CHILD_KILL_GRACE_MS = 1_000;
const MAX_CHILD_STDERR_BYTES = 8 * 1024;
const MAX_ERROR_CHARS = 4_000;

// Respawn backoff after consecutive crashes: 100 ms, doubling, capped at 5 s.
// A value, not a running effect: stepping it happens inside a request's fiber.
const CRASH_BACKOFF = Schedule.min([
  Schedule.exponential(Duration.millis(100)),
  Schedule.spaced(Duration.seconds(5)),
]);

const crashBackoff: Effect.Effect<CrashStep> = Effect.map(
  Schedule.toStep(CRASH_BACKOFF),
  (step) => (crashedAt) =>
    step(crashedAt, undefined).pipe(
      Effect.map(([, delay]) => crashedAt + Duration.toMillis(delay)),
      // Neither schedule ever halts; a halt here would be a broken invariant.
      Effect.orDie,
    ),
);

function retainStderrTail(current: Buffer, chunk: Buffer | string): Buffer {
  const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  if (incoming.length >= MAX_CHILD_STDERR_BYTES) {
    return Buffer.from(
      incoming.subarray(incoming.length - MAX_CHILD_STDERR_BYTES),
    );
  }
  const combined = Buffer.concat([current, incoming]);
  if (combined.length <= MAX_CHILD_STDERR_BYTES) return combined;
  return Buffer.from(combined.subarray(combined.length - MAX_CHILD_STDERR_BYTES));
}

function childExitError(message: string, stderrTail: Buffer): Error {
  if (stderrTail.length === 0) return new Error(message);
  return new Error(
    `${message}\nRecent child stderr (last ${stderrTail.length} bytes):\n` +
      stderrTail.toString("utf8"),
  );
}

function positiveWhole(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    !Number.isInteger(resolved) ||
    resolved < 1
  ) {
    throw new TypeError(`${name} must be a positive whole number.`);
  }
  return resolved;
}

function nonNegativeWhole(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isFinite(resolved) ||
    !Number.isInteger(resolved) ||
    resolved < 0
  ) {
    throw new TypeError(`${name} must be a non-negative whole number.`);
  }
  return resolved;
}

function errorPayload(error: string): string {
  // X11: a partial authenticated frame exposes its secret instead of decoding.
  // Refuse it whole if a host ever bypasses execute.ts's framing bound.
  const message =
    error.length > MAX_ERROR_CHARS && error.includes("\u001econnecta-error:")
      ? `Host failure exceeded the ${MAX_ERROR_CHARS}-character bridge limit.`
      : error.slice(0, MAX_ERROR_CHARS);
  return JSON.stringify({
    ok: false,
    error: message,
  } satisfies HostResultPayload);
}

function cancelled(message: string): ExecutorAdmissionError {
  return new ExecutorAdmissionError("executor_cancelled", message);
}

function shuttingDown(): ExecutorAdmissionError {
  return new ExecutorAdmissionError(
    "executor_closed",
    "Executor is shutting down.",
  );
}

/**
 * Wait for `effect` unless the caller's signal aborts first, which fails with
 * `executor_cancelled`. An already-aborted signal fails without waiting, even
 * when the effect would have completed at once.
 */
function unlessCancelled<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
  message: string,
): Effect.Effect<A, E | ExecutorAdmissionError> {
  if (!signal) return effect;
  if (signal.aborted) return Effect.fail(cancelled(message));
  return Effect.raceAllFirst([
    effect,
    fromSignal(signal).pipe(Effect.mapError(() => cancelled(message))),
  ]);
}

/**
 * The child's release: SIGTERM, then wait for the exit, bounded — a child
 * still there after the grace gets SIGKILL and is not waited on further. A
 * child that already exited is left alone.
 */
function terminate(child: Child): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (Deferred.isDoneUnsafe(child.exited)) return Effect.void;
    child.process.kill();
    return Effect.raceAllFirst([
      Deferred.await(child.exited),
      Effect.sleep(Duration.millis(CHILD_KILL_GRACE_MS)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            child.process.kill("SIGKILL");
          }),
        ),
      ),
    ]);
  });
}

class QuickJsChildPool implements AdmittingExecutor {
  /** What `/health` and `connecta doctor` call this sandbox (#368). */
  readonly name = "QuickJS";
  private readonly admission: AdmissionController;
  private readonly slots: ChildSlot[];
  private readonly available: ChildSlot[];
  private readonly runtimeOptions: QuickJsRuntimeOptions;
  // Scope closes still in flight, so close() can wait out every child rather
  // than only the ones it retired itself.
  private readonly retiring = new Set<Promise<void>>();
  private closed = false;
  private nextJobId = 1;

  constructor(options: QuickJsExecutorOptions) {
    const concurrency = positiveWhole(
      options.concurrency,
      DEFAULT_CONCURRENCY,
      "concurrency",
    );
    const queueTimeoutMs = positiveWhole(
      options.queueTimeoutMs,
      DEFAULT_QUEUE_TIMEOUT_MS,
      "queueTimeoutMs",
    );
    this.admission = new AdmissionController({
      concurrency,
      maxQueueSize: nonNegativeWhole(
        options.maxQueueSize,
        DEFAULT_MAX_QUEUE_SIZE,
        "maxQueueSize",
      ),
      queueTimeoutMs,
      retryAfterMs: queueTimeoutMs,
    });
    this.runtimeOptions = {
      timeoutMs: positiveWhole(
        options.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        "timeoutMs",
      ),
      cpuTimeMs: positiveWhole(
        options.cpuTimeMs,
        DEFAULT_CPU_TIME_MS,
        "cpuTimeMs",
      ),
      memoryLimitBytes: positiveWhole(
        options.memoryLimitBytes,
        DEFAULT_MEMORY_LIMIT_BYTES,
        "memoryLimitBytes",
      ),
      maxStackSizeBytes: positiveWhole(
        options.maxStackSizeBytes,
        DEFAULT_STACK_LIMIT_BYTES,
        "maxStackSizeBytes",
      ),
    };
    this.slots = Array.from({ length: concurrency }, () => ({
      crashes: [],
      notBefore: 0,
    }));
    this.available = [...this.slots];
  }

  async acquire(options: { signal?: AbortSignal } = {}): Promise<ExecutorLease> {
    const admission = await this.admission.acquire(options);
    const slot = this.available.shift();
    if (!slot) {
      admission.release();
      throw new Error("Executor admission invariant failed: no child slot.");
    }
    let released = false;
    let executed = false;
    return {
      waitMs: admission.waitMs,
      execute: async (code, providers) => {
        if (released) throw new Error("Executor lease was already released.");
        if (executed) throw new Error("Executor lease may execute only once.");
        executed = true;
        return runEdge(this.run(slot, code, providers, options.signal));
      },
      release: () => {
        if (released) return;
        released = true;
        // A lease let go mid-run takes its child with it: the program is
        // abandoned, and the next lease must not inherit its leftovers.
        if (slot.active) {
          this.rejectActive(
            slot,
            new Error("Executor lease was released during execution."),
          );
          this.recycle(slot);
        }
        this.available.push(slot);
        admission.release();
      },
    };
  }

  admissionSnapshot(): AdmissionSnapshot {
    return this.admission.snapshot();
  }

  async execute(
    code: string,
    providers: ExecutorProvider[],
  ): Promise<ExecuteResult> {
    const lease = await this.acquire();
    try {
      return await lease.execute(code, providers);
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.admission.close();
    for (const slot of this.slots) this.stopSlot(slot);
    await Promise.allSettled(this.retiring);
  }

  // One execution on a leased slot: a ready child, the run message, then the
  // outcome raced against the wall deadline and the caller's abort. Either of
  // those settles the outcome and recycles the child; the race's losers are
  // interrupted, which clears their timer and abort listener.
  private run(
    slot: ChildSlot,
    code: string,
    providers: ExecutorProvider[],
    signal?: AbortSignal,
  ): Effect.Effect<ExecuteResult, Error> {
    return Effect.gen({ self: this }, function* () {
      if (signal?.aborted) {
        return yield* Effect.fail(
          cancelled("Execution was cancelled before it started."),
        );
      }
      yield* this.ensureChild(slot, signal);
      if (signal?.aborted) {
        return yield* Effect.fail(
          cancelled("Execution was cancelled before it started."),
        );
      }
      const child = slot.child?.process;
      if (!child?.connected) {
        return yield* Effect.fail(
          new Error("QuickJS child IPC channel is unavailable."),
        );
      }

      const id = this.nextJobId++;
      const providerMap = new Map(providers.map((item) => [item.name, item]));
      let runMessage: ParentToChildMessage;
      try {
        const payloadJson = stringifyBounded(
          {
            id,
            code,
            providers: providers.map((item) => ({
              name: item.name,
              ...(item.prelude ? { prelude: item.prelude } : {}),
            })),
            options: this.runtimeOptions,
          } satisfies RunPayload,
          "QuickJS run payload",
        );
        runMessage = { type: "run", payloadJson };
        stringifyBounded(runMessage, "QuickJS run IPC envelope");
      } catch (err) {
        return { result: undefined, error: msg(err) };
      }

      child.ref();
      child.channel?.ref();
      const active: ActiveRun = {
        id,
        logs: [],
        logChars: 0,
        providers: providerMap,
        outcome: Deferred.makeUnsafe(),
      };
      slot.active = active;
      try {
        child.send(runMessage, (error) => {
          if (!error || slot.active?.id !== id) return;
          this.rejectActive(slot, error);
          this.recycle(slot);
        });
      } catch (err) {
        this.rejectActive(
          slot,
          err instanceof Error ? err : new Error(String(err)),
        );
        this.recycle(slot);
      }

      // Settle the outcome from outside the child, then leave the verdict to
      // the outcome contender: exactly one party ever settles it. A run that
      // has already settled keeps its child.
      const endWith = (error: Error) =>
        Effect.sync(() => {
          if (slot.active !== active) return;
          this.rejectActive(slot, error);
          this.recycle(slot);
        }).pipe(Effect.andThen(Effect.never));
      const contenders: Array<Effect.Effect<ExecuteResult, Error>> = [
        Deferred.await(active.outcome),
        Effect.sleep(
          Duration.millis(this.runtimeOptions.timeoutMs + CHILD_EXIT_GRACE_MS),
        ).pipe(
          Effect.andThen(
            endWith(
              new Error(
                `QuickJS child exceeded the ${this.runtimeOptions.timeoutMs}ms wall budget and was terminated.`,
              ),
            ),
          ),
        ),
      ];
      if (signal) {
        contenders.push(
          fromSignal(signal).pipe(
            Effect.catch(() => endWith(cancelled("Execution was cancelled."))),
          ),
        );
      }
      return yield* Effect.raceAllFirst(contenders);
    });
  }

  // A ready child on the slot: the warm one, or a new one once any crash
  // backoff has passed. Waiting stops at the caller's abort, but a child that
  // is still starting keeps starting for whoever leases the slot next.
  private ensureChild(
    slot: ChildSlot,
    signal: AbortSignal | undefined,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* Effect.fail(shuttingDown());
      const current = slot.child;
      if (current?.process.connected) {
        return yield* this.awaitReady(current, signal);
      }
      // Disconnected but not yet closed: already on its way out.
      if (current) this.retire(slot, current);

      for (const crashedAt of slot.crashes.splice(0)) {
        slot.backoff ??= yield* crashBackoff;
        slot.notBefore = yield* slot.backoff(crashedAt);
      }
      const wait = slot.notBefore - Date.now();
      if (wait > 0) {
        yield* unlessCancelled(
          Effect.sleep(Duration.millis(wait)),
          signal,
          "Execution was cancelled while the sandbox was restarting.",
        );
      }
      if (this.closed) return yield* Effect.fail(shuttingDown());

      const child = yield* this.spawn(slot);
      return yield* this.awaitReady(child, signal);
    });
  }

  private awaitReady(
    child: Child,
    signal: AbortSignal | undefined,
  ): Effect.Effect<void, Error> {
    if (Deferred.isDoneUnsafe(child.ready)) return Deferred.await(child.ready);
    return unlessCancelled(
      Deferred.await(child.ready),
      signal,
      "Execution was cancelled while the sandbox was starting.",
    );
  }

  // Acquire a child into a Scope of its own. The Scope outlives the request
  // that started the child — a warm child serves many leases — and closes
  // when the pool retires it. The watchdog is forked during acquisition, so
  // its finalizer is registered before the release and runs after it: the
  // SIGTERM goes out first, synchronously, and the watchdog stops after.
  private spawn(slot: ChildSlot): Effect.Effect<Child, Error> {
    return Effect.suspend(() => {
      const sourceMode = import.meta.url.endsWith(".ts");
      const childUrl = new URL(
        sourceMode ? "./quickjs-child.ts" : "./quickjs-child.js",
        import.meta.url,
      );
      const childPath = fileURLToPath(childUrl);
      if (!existsSync(childPath)) {
        return Effect.fail(
          new Error(
            `QuickJS child entry is missing at ${childPath}. ` +
              "The @zackbart/connecta/quickjs subpath requires the package file " +
              "layout on disk; externalize @zackbart/connecta (or at least " +
              "@zackbart/connecta/quickjs) when bundling the server.",
          ),
        );
      }
      const scope = Scope.makeUnsafe();
      return Effect.acquireRelease(
        Effect.sync(() => this.forkChild(slot, scope, childPath, sourceMode)).pipe(
          Effect.tap((child) =>
            Effect.forkIn(this.startupWatchdog(slot, child), scope),
          ),
        ),
        terminate,
      ).pipe(Scope.provide(scope));
    });
  }

  // Fails a child that never reports ready. It lives in the child's Scope,
  // so it ends with the child, and it finishes as soon as readiness settles
  // either way, so a ready child leaves no timer behind.
  private startupWatchdog(slot: ChildSlot, child: Child): Effect.Effect<void> {
    return Effect.raceFirst(
      Deferred.await(child.ready).pipe(Effect.ignore),
      Effect.sleep(Duration.millis(CHILD_STARTUP_TIMEOUT_MS)).pipe(
        Effect.andThen(
          Effect.sync(() =>
            this.failChildStartup(
              slot,
              child,
              new Error(
                `QuickJS child did not become ready within ${CHILD_STARTUP_TIMEOUT_MS}ms.`,
              ),
            ),
          ),
        ),
      ),
    );
  }

  private forkChild(
    slot: ChildSlot,
    scope: Scope.Closeable,
    childPath: string,
    sourceMode: boolean,
  ): Child {
    const subprocess = fork(childPath, [], {
      // The child needs only its entry path, exec arguments, and IPC channel.
      // Do not copy deployment credentials or Node startup configuration into
      // the process that contains the guest runtime.
      env: {},
      execArgv: sourceMode ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const child: Child = {
      process: subprocess,
      scope,
      ready: Deferred.makeUnsafe(),
      exited: Deferred.makeUnsafe(),
      retired: false,
    };
    let stderrTail: Buffer = Buffer.alloc(0);
    subprocess.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = retainStderrTail(stderrTail, chunk);
    });
    (
      subprocess.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null
    )?.unref?.();
    slot.child = child;
    subprocess.on("message", (message: ChildToParentMessage) => {
      void this.onMessage(slot, child, message);
    });
    subprocess.on("error", (error) => {
      if (slot.child !== child) return;
      if (!Deferred.isDoneUnsafe(child.ready)) {
        this.failChildStartup(slot, child, error);
        return;
      }
      this.rejectActive(slot, error);
      this.recycle(slot);
    });
    subprocess.once("exit", () => {
      Deferred.doneUnsafe(child.exited, Exit.void);
    });
    // `close`, unlike `exit`, runs after the stdio streams have closed, so the
    // diagnostic includes stderr bytes flushed immediately before a crash.
    subprocess.on("close", (code, exitSignal) => {
      Deferred.doneUnsafe(child.exited, Exit.void);
      const expected = child.retired;
      const current = slot.child === child;
      const exitDescription = `${
        exitSignal ? `signal ${exitSignal}` : `code ${String(code)}`
      }`;
      // Charge the crash and detach the child before failing its readiness:
      // a settled Deferred resumes its waiter synchronously, and a successor
      // must never find a dead child on the slot or a crash not yet counted.
      if (!expected) this.recordCrash(slot);
      this.retire(
        slot,
        child,
        childExitError(
          `QuickJS child exited before becoming ready (${exitDescription}).`,
          stderrTail,
        ),
      );
      if (expected || !current) return;
      this.rejectActive(
        slot,
        childExitError(
          `QuickJS child exited unexpectedly (${exitDescription}).`,
          stderrTail,
        ),
      );
    });
    subprocess.unref();
    subprocess.channel?.unref();
    return child;
  }

  private async onMessage(
    slot: ChildSlot,
    child: Child,
    message: ChildToParentMessage,
  ): Promise<void> {
    // A compromised child is exactly the adversary this process boundary
    // contains, and this handler's rejection would crash the serving process.
    // Refuse malformed intake before touching any field.
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      if (slot.child === child) Deferred.doneUnsafe(child.ready, Exit.void);
      return;
    }
    const active = slot.active;
    if (!active || slot.child !== child) return;
    if (typeof message.payloadJson !== "string") return;
    if (message.type === "log") {
      if (message.jobId !== active.id) return;
      // Keep one extra character so the presentation layer can signal loss.
      // The final reply owns complete successful logs; this prefix survives
      // only when that reply cannot arrive. Bound even a compromised child.
      if (active.logChars >= MAX_EXECUTE_LOG_CHARS + 1) return;
      if (serializedBytes(message.payloadJson) > MAX_QUICKJS_IPC_BYTES) return;
      try {
        stringifyBounded(message, "QuickJS log IPC envelope");
        const entry: unknown = JSON.parse(message.payloadJson);
        if (typeof entry !== "string") return;
        const separator = active.logs.length > 0 ? 1 : 0;
        const retained = entry.slice(0, MAX_EXECUTE_LOG_CHARS + 1 - active.logChars - separator);
        active.logs.push(retained);
        active.logChars += separator + retained.length;
      } catch { /* Malformed log messages carry no output. */ }
      return;
    }
    if (message.type === "host-call") {
      if (message.jobId !== active.id) return;
      await this.handleHostCall(slot, child.process, active, message);
      return;
    }
    if (message.type !== "result" || message.jobId !== active.id) return;
    if (serializedBytes(message.payloadJson) > MAX_QUICKJS_IPC_BYTES) {
      this.rejectActive(slot, new Error("QuickJS execution result exceeded the IPC limit."));
      this.recycle(slot);
      return;
    }
    try {
      const payload = JSON.parse(message.payloadJson) as ExecutionPayload;
      // A result ends any crash streak: the next crash backs off from 100 ms.
      slot.crashes.length = 0;
      slot.backoff = undefined;
      slot.notBefore = 0;
      this.resolveActive(slot, payload.outcome);
      if (payload.timedOut) {
        // A timed-out host call may still retain QuickJS handles. A fresh child
        // is cheaper and safer than reusing a context with unknown stragglers.
        // The runtime sets this flag itself: matching error text here would let
        // a guest throw "Execution timed out…" and force cold-start churn.
        this.recycle(slot);
      }
    } catch (err) {
      this.rejectActive(slot, new Error(`QuickJS child returned an invalid result: ${msg(err)}`));
      this.recycle(slot);
    }
  }

  private async handleHostCall(
    slot: ChildSlot,
    child: ChildProcess,
    active: ActiveRun,
    message: Extract<ChildToParentMessage, { type: "host-call" }>,
  ): Promise<void> {
    let payloadJson: string;
    try {
      if (
        serializedBytes(message.payloadJson) >
        MAX_QUICKJS_HOST_RPC_BYTES
      ) {
        // Refused before parsing, so there is no address to name here: parsing
        // an over-limit payload to improve its error message would spend the
        // work the limit exists to refuse.
        throw new RangeError("Host call arguments exceeded the IPC limit.");
      }
      const payload = JSON.parse(message.payloadJson) as HostCallPayload;
      const provider = active.providers.get(payload.namespace);
      const fn =
        provider && Object.hasOwn(provider.fns, payload.functionName)
          ? provider.fns[payload.functionName]
          : undefined;
      if (!fn) {
        throw new Error(
          `Unknown function ${payload.namespace}.${payload.functionName}`,
        );
      }
      const value = await fn(...payload.args);
      try {
        payloadJson = stringifyBounded(
          { ok: true, value } satisfies HostResultPayload,
          `Host result from ${hostCallLabel(payload)}`,
          MAX_QUICKJS_HOST_RPC_BYTES,
        );
      } catch (err) {
        // The guest reads this text, so it names the address the program called
        // rather than only the generic connecta.call bridge function.
        const label = hostCallLabel(payload);
        const detail =
          err instanceof RangeError
            ? `Host result from ${label} exceeds the ${MAX_QUICKJS_HOST_RPC_BYTES}-byte serialized bridge limit.`
            : `Host result from ${label} could not be serialized: ${msg(err)}`;
        payloadJson = errorPayload(detail);
      }
    } catch (err) {
      payloadJson = errorPayload(msg(err));
    }
    if (!child.connected || slot.active !== active) return;
    const response = {
      type: "host-result",
      jobId: message.jobId,
      callId: message.callId,
      payloadJson,
    } satisfies ParentToChildMessage;
    try {
      stringifyBounded(response, "QuickJS host-result IPC envelope");
    } catch {
      // L6/X10: settle the rejected call even if the outer encoding overflows.
      response.payloadJson = errorPayload(
        `QuickJS host-result IPC envelope could not be serialized within the ${MAX_QUICKJS_IPC_BYTES}-byte IPC limit.`,
      );
    }
    const failedSend = (error: Error | null) => {
      if (!error || slot.active !== active) return;
      this.rejectActive(slot, error);
      this.recycle(slot);
    };
    try {
      stringifyBounded(response, "QuickJS host-result IPC envelope");
      child.send(response, failedSend);
    } catch (err) {
      failedSend(err instanceof Error ? err : new Error(msg(err)));
    }
  }

  private resolveActive(slot: ChildSlot, outcome: ExecuteResult): void {
    const active = slot.active;
    if (!active) return;
    // Never concatenate the stream with the final reply: those entries are
    // the same logs. A normal reply retains its existing full log contract.
    const resolved = outcome.logs === undefined && active.logs.length > 0
      ? { ...outcome, logs: active.logs }
      : outcome;
    this.clearActive(slot);
    Deferred.doneUnsafe(active.outcome, Exit.succeed(resolved));
  }

  private rejectActive(slot: ChildSlot, error: Error): void {
    const active = slot.active;
    if (!active) return;
    this.clearActive(slot);
    if (active.logs.length > 0) Object.assign(error, { logs: active.logs });
    Deferred.doneUnsafe(active.outcome, Exit.fail(error));
  }

  private clearActive(slot: ChildSlot): void {
    slot.active = undefined;
    slot.child?.process.unref();
    slot.child?.process.channel?.unref();
  }

  private recordCrash(slot: ChildSlot): void {
    slot.crashes.push(Date.now());
  }

  private failChildStartup(slot: ChildSlot, child: Child, error: Error): void {
    if (slot.child !== child || Deferred.isDoneUnsafe(child.ready)) return;
    this.recordCrash(slot);
    this.retire(slot, child, error);
  }

  private recycle(slot: ChildSlot): void {
    const child = slot.child;
    if (!child) return;
    this.retire(
      slot,
      child,
      new Error("QuickJS child was recycled before becoming ready."),
    );
  }

  private stopSlot(slot: ChildSlot): void {
    const child = slot.child;
    if (!child) return;
    this.rejectActive(
      slot,
      new ExecutorExecutionError(
        "executor_closed",
        "Executor is shutting down.",
      ),
    );
    this.retire(slot, child, shuttingDown());
  }

  // Let a child go: off the slot first, so nothing new reaches it, then its
  // Scope closes — the finalizer's SIGTERM is sent before this returns, since
  // a detached fiber runs synchronously up to its first wait — and last its
  // readiness fails with `readyError` if it never reported ready. Idempotent.
  // The bounded wait for the exit continues in the background; close() waits
  // for every one still running.
  private retire(slot: ChildSlot, child: Child, readyError?: Error): void {
    if (slot.child === child) slot.child = undefined;
    if (!child.retired) {
      child.retired = true;
      const closing = detach(Scope.close(child.scope, Exit.void));
      this.retiring.add(closing);
      void closing.then(() => this.retiring.delete(closing));
    }
    if (readyError) Deferred.doneUnsafe(child.ready, Exit.fail(readyError));
  }
}

/**
 * Bounded Node QuickJS executor. Admission is acquired before connecta builds
 * providers; one lease maps to one child and carries execution, avoiding a
 * double-acquire deadlock at concurrency 1.
 */
export function quickJsExecutor(
  options: QuickJsExecutorOptions = {},
): AdmittingExecutor {
  return new QuickJsChildPool(options);
}
