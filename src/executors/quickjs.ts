// Node's built-in code-mode executor. QuickJS itself lives in a disposable
// child process: guest CPU, WASM aborts, and interpreter OOMs cannot block or
// terminate the HTTP-serving process.

import { Buffer } from "node:buffer";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AdmissionController,
  ExecutorAdmissionError,
  ExecutorExecutionError,
} from "../executor-admission.js";
import { msg } from "../errors.js";
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

interface ActiveRun {
  id: number;
  providers: Map<string, ExecutorProvider>;
  resolve: (outcome: ExecuteResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  wallTimer: ReturnType<typeof setTimeout>;
}

interface ChildSlot {
  child?: ChildProcess | undefined;
  ready?: Promise<void> | undefined;
  resolveReady?: (() => void) | undefined;
  rejectReady?: ((error: Error) => void) | undefined;
  readyTimer?: ReturnType<typeof setTimeout> | undefined;
  active?: ActiveRun | undefined;
  expectedExit?: ChildProcess | undefined;
  consecutiveCrashes: number;
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
const MAX_CHILD_STDERR_BYTES = 8 * 1024;
const MAX_ERROR_CHARS = 4_000;

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
  return JSON.stringify({
    ok: false,
    error: error.slice(0, MAX_ERROR_CHARS),
  } satisfies HostResultPayload);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new ExecutorAdmissionError(
          "executor_cancelled",
          "Execution was cancelled while the sandbox was restarting.",
        ),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitForReady(
  ready: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return ready;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          new ExecutorAdmissionError(
            "executor_cancelled",
            "Execution was cancelled while the sandbox was starting.",
          ),
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void ready.then(
      () => finish(resolve),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
    );
  });
}

class QuickJsChildPool implements AdmittingExecutor {
  /** What `/health` and `connecta doctor` call this sandbox (#368). */
  readonly name = "QuickJS";
  private readonly admission: AdmissionController;
  private readonly slots: ChildSlot[];
  private readonly available: ChildSlot[];
  private readonly runtimeOptions: QuickJsRuntimeOptions;
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
      consecutiveCrashes: 0,
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
        return this.run(slot, code, providers, options.signal);
      },
      release: () => {
        if (released) return;
        released = true;
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
    const exits = this.slots.map((slot) => this.stopSlot(slot));
    await Promise.allSettled(exits);
  }

  private async run(
    slot: ChildSlot,
    code: string,
    providers: ExecutorProvider[],
    signal?: AbortSignal,
  ): Promise<ExecuteResult> {
    if (signal?.aborted) {
      throw new ExecutorAdmissionError(
        "executor_cancelled",
        "Execution was cancelled before it started.",
      );
    }
    await this.ensureChild(slot, signal);
    if (signal?.aborted) {
      throw new ExecutorAdmissionError(
        "executor_cancelled",
        "Execution was cancelled before it started.",
      );
    }
    const child = slot.child;
    if (!child?.connected) {
      throw new Error("QuickJS child IPC channel is unavailable.");
    }

    const id = this.nextJobId++;
    const providerMap = new Map(providers.map((item) => [item.name, item]));
    let payloadJson: string;
    let runMessage: ParentToChildMessage;
    try {
      payloadJson = stringifyBounded(
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
    return new Promise<ExecuteResult>((resolve, reject) => {
      const wallTimer = setTimeout(() => {
        this.resolveActive(
          slot,
          {
            result: undefined,
            error: `QuickJS child exceeded the ${this.runtimeOptions.timeoutMs}ms wall budget and was terminated.`,
          },
        );
        this.recycle(slot);
      }, this.runtimeOptions.timeoutMs + CHILD_EXIT_GRACE_MS);
      const active: ActiveRun = {
        id,
        providers: providerMap,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        wallTimer,
      };
      active.onAbort = () => {
        this.rejectActive(
          slot,
          new ExecutorAdmissionError(
            "executor_cancelled",
            "Execution was cancelled.",
          ),
        );
        this.recycle(slot);
      };
      signal?.addEventListener("abort", active.onAbort, { once: true });
      slot.active = active;
      if (signal?.aborted) {
        active.onAbort();
        return;
      }
      try {
        child.send(
          runMessage,
          (error) => {
            if (!error || slot.active?.id !== id) return;
            this.rejectActive(slot, error);
            this.recycle(slot);
          },
        );
      } catch (err) {
        this.rejectActive(
          slot,
          err instanceof Error ? err : new Error(String(err)),
        );
        this.recycle(slot);
      }
    });
  }

  private async ensureChild(
    slot: ChildSlot,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) {
      throw new ExecutorAdmissionError(
        "executor_closed",
        "Executor is shutting down.",
      );
    }
    if (slot.child?.connected) {
      if (slot.ready) await waitForReady(slot.ready, signal);
      return;
    }
    await delay(Math.max(0, slot.notBefore - Date.now()), signal);
    if (this.closed) {
      throw new ExecutorAdmissionError(
        "executor_closed",
        "Executor is shutting down.",
      );
    }

    const sourceMode = import.meta.url.endsWith(".ts");
    const childUrl = new URL(
      sourceMode ? "./quickjs-child.ts" : "./quickjs-child.js",
      import.meta.url,
    );
    const childPath = fileURLToPath(childUrl);
    if (!existsSync(childPath)) {
      throw new Error(
        `QuickJS child entry is missing at ${childPath}. ` +
          "The @zackbart/connecta/quickjs subpath requires the package file " +
          "layout on disk; externalize @zackbart/connecta (or at least " +
          "@zackbart/connecta/quickjs) when bundling the server.",
      );
    }
    const child = fork(childPath, [], {
      // The child needs only its entry path, exec arguments, and IPC channel.
      // Do not copy deployment credentials or Node startup configuration into
      // the process that contains the guest runtime.
      env: {},
      execArgv: sourceMode ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderrTail: Buffer = Buffer.alloc(0);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = retainStderrTail(stderrTail, chunk);
    });
    (
      child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null
    )?.unref?.();
    slot.child = child;
    slot.ready = new Promise<void>((resolve, reject) => {
      slot.resolveReady = resolve;
      slot.rejectReady = reject;
    });
    slot.readyTimer = setTimeout(() => {
      if (slot.child !== child || !slot.ready) return;
      const error = new Error(
        `QuickJS child did not become ready within ${CHILD_STARTUP_TIMEOUT_MS}ms.`,
      );
      this.failChildStartup(slot, child, error);
    }, CHILD_STARTUP_TIMEOUT_MS);
    child.on("message", (message: ChildToParentMessage) => {
      void this.onMessage(slot, child, message);
    });
    child.on("error", (error) => {
      if (slot.child !== child) return;
      if (slot.ready) {
        this.failChildStartup(slot, child, error);
        return;
      }
      this.rejectActive(slot, error);
      this.recycle(slot);
    });
    // `close`, unlike `exit`, runs after the stdio streams have closed, so the
    // diagnostic includes stderr bytes flushed immediately before a crash.
    child.on("close", (code, exitSignal) => {
      const expected = slot.expectedExit === child;
      if (slot.expectedExit === child) slot.expectedExit = undefined;
      const exitDescription = `${
        exitSignal ? `signal ${exitSignal}` : `code ${String(code)}`
      }`;
      this.rejectChildReady(
        slot,
        child,
        childExitError(
          `QuickJS child exited before becoming ready (${exitDescription}).`,
          stderrTail,
        ),
      );
      if (slot.child === child) slot.child = undefined;
      if (expected) return;
      this.recordCrash(slot);
      const error = childExitError(
        `QuickJS child exited unexpectedly (${exitDescription}).`,
        stderrTail,
      );
      this.resolveActive(slot, { result: undefined, error: error.message });
    });
    child.unref();
    child.channel?.unref();
    if (slot.ready) await waitForReady(slot.ready, signal);
  }

  private async onMessage(
    slot: ChildSlot,
    child: ChildProcess,
    message: ChildToParentMessage,
  ): Promise<void> {
    // A compromised child is exactly the adversary this process boundary
    // contains, and this handler's rejection would crash the serving process.
    // Refuse malformed intake before touching any field.
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      this.resolveChildReady(slot, child);
      return;
    }
    const active = slot.active;
    if (!active || slot.child !== child) return;
    if (typeof message.payloadJson !== "string") return;
    if (message.type === "host-call") {
      if (message.jobId !== active.id) return;
      await this.handleHostCall(child, active, message);
      return;
    }
    if (message.type !== "result" || message.jobId !== active.id) return;
    if (serializedBytes(message.payloadJson) > MAX_QUICKJS_IPC_BYTES) {
      this.resolveActive(slot, {
        result: undefined,
        error: "QuickJS execution result exceeded the IPC limit.",
      });
      this.recycle(slot);
      return;
    }
    try {
      const payload = JSON.parse(message.payloadJson) as ExecutionPayload;
      slot.consecutiveCrashes = 0;
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
      this.resolveActive(slot, {
        result: undefined,
        error: `QuickJS child returned an invalid result: ${msg(err)}`,
      });
      this.recycle(slot);
    }
  }

  private async handleHostCall(
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
        // rather than the internal dispatcher every shortcut namespace shares.
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
    if (!child.connected) return;
    try {
      const response = {
        type: "host-result",
        jobId: message.jobId,
        callId: message.callId,
        payloadJson,
      } satisfies ParentToChildMessage;
      stringifyBounded(response, "QuickJS host-result IPC envelope");
      child.send(response);
    } catch {
      // The execution has already ended or the child is exiting. Its exit
      // handler owns the structured failure for any still-active job.
    }
  }

  private resolveActive(slot: ChildSlot, outcome: ExecuteResult): void {
    const active = slot.active;
    if (!active) return;
    this.clearActive(slot, active);
    active.resolve(outcome);
  }

  private rejectActive(slot: ChildSlot, error: Error): void {
    const active = slot.active;
    if (!active) return;
    this.clearActive(slot, active);
    active.reject(error);
  }

  private clearActive(slot: ChildSlot, active: ActiveRun): void {
    clearTimeout(active.wallTimer);
    if (active.onAbort) {
      active.signal?.removeEventListener("abort", active.onAbort);
    }
    slot.active = undefined;
    slot.child?.unref();
    slot.child?.channel?.unref();
  }

  private resolveChildReady(slot: ChildSlot, child: ChildProcess): void {
    if (slot.child !== child || !slot.ready) return;
    if (slot.readyTimer) clearTimeout(slot.readyTimer);
    const resolve = slot.resolveReady;
    slot.ready = undefined;
    slot.resolveReady = undefined;
    slot.rejectReady = undefined;
    slot.readyTimer = undefined;
    resolve?.();
  }

  private rejectChildReady(
    slot: ChildSlot,
    child: ChildProcess,
    error: Error,
  ): void {
    if (slot.child !== child || !slot.ready) return;
    if (slot.readyTimer) clearTimeout(slot.readyTimer);
    const reject = slot.rejectReady;
    slot.ready = undefined;
    slot.resolveReady = undefined;
    slot.rejectReady = undefined;
    slot.readyTimer = undefined;
    reject?.(error);
  }

  private recordCrash(slot: ChildSlot): void {
    slot.consecutiveCrashes++;
    slot.notBefore =
      Date.now() +
      Math.min(5_000, 100 * 2 ** (slot.consecutiveCrashes - 1));
  }

  private failChildStartup(
    slot: ChildSlot,
    child: ChildProcess,
    error: Error,
  ): void {
    if (slot.child !== child || !slot.ready) return;
    // Detach before the rejected readiness promise can release the lease. A
    // queued successor must never observe a connected child that is unready
    // and already on its way out.
    slot.expectedExit = child;
    this.rejectChildReady(slot, child, error);
    slot.child = undefined;
    this.recordCrash(slot);
    child.kill();
  }

  private recycle(slot: ChildSlot): void {
    const child = slot.child;
    if (!child) return;
    this.rejectChildReady(
      slot,
      child,
      new Error("QuickJS child was recycled before becoming ready."),
    );
    slot.expectedExit = child;
    slot.child = undefined;
    child.kill();
  }

  private stopSlot(slot: ChildSlot): Promise<void> {
    const child = slot.child;
    if (!child) return Promise.resolve();
    this.rejectActive(
      slot,
      new ExecutorExecutionError(
        "executor_closed",
        "Executor is shutting down.",
      ),
    );
    this.rejectChildReady(
      slot,
      child,
      new ExecutorAdmissionError(
        "executor_closed",
        "Executor is shutting down.",
      ),
    );
    slot.expectedExit = child;
    slot.child = undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
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
