// Node's built-in code-mode executor. QuickJS itself lives in a disposable
// child process: guest CPU, WASM aborts, and interpreter OOMs cannot block or
// terminate the HTTP-serving process.

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AdmissionController,
  ExecutorAdmissionError,
} from "../executor-admission.js";
import type {
  AdmittingExecutor,
  ExecuteResult,
  ExecutorLease,
  ExecutorProvider,
} from "../types.js";
import {
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
  child?: ChildProcess;
  active?: ActiveRun;
  expectedExit?: ChildProcess;
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
const MAX_ERROR_CHARS = 4_000;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

class QuickJsChildPool implements AdmittingExecutor {
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
    const child = slot.child;
    if (!child?.connected) {
      throw new Error("QuickJS child IPC channel is unavailable.");
    }

    const id = this.nextJobId++;
    const providerMap = new Map(providers.map((item) => [item.name, item]));
    let payloadJson: string;
    try {
      payloadJson = stringifyBounded(
        {
          id,
          code,
          providerNames: providers.map((item) => item.name),
          options: this.runtimeOptions,
        } satisfies RunPayload,
        "QuickJS run payload",
      );
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
          { type: "run", payloadJson } satisfies ParentToChildMessage,
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
    if (slot.child?.connected) return;
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
    const child = fork(fileURLToPath(childUrl), [], {
      execArgv: sourceMode ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    slot.child = child;
    child.on("message", (message: ChildToParentMessage) => {
      void this.onMessage(slot, child, message);
    });
    child.on("error", (error) => {
      if (slot.child !== child) return;
      this.rejectActive(slot, error);
    });
    child.on("exit", (code, exitSignal) => {
      const expected = slot.expectedExit === child;
      if (slot.expectedExit === child) slot.expectedExit = undefined;
      if (slot.child === child) slot.child = undefined;
      if (expected) return;
      slot.consecutiveCrashes++;
      slot.notBefore =
        Date.now() +
        Math.min(5_000, 100 * 2 ** (slot.consecutiveCrashes - 1));
      this.resolveActive(slot, {
        result: undefined,
        error:
          `QuickJS child exited unexpectedly` +
          ` (${exitSignal ? `signal ${exitSignal}` : `code ${String(code)}`}).`,
      });
    });
    child.unref();
    child.channel?.unref();
  }

  private async onMessage(
    slot: ChildSlot,
    child: ChildProcess,
    message: ChildToParentMessage,
  ): Promise<void> {
    const active = slot.active;
    if (!active || slot.child !== child || !message) return;
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
      if (payload.outcome.error?.includes("Execution timed out")) {
        // A timed-out host call may still retain QuickJS handles. A fresh child
        // is cheaper and safer than reusing a context with unknown stragglers.
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
        throw new RangeError("Host call arguments exceeded the IPC limit.");
      }
      const payload = JSON.parse(message.payloadJson) as HostCallPayload;
      const provider = active.providers.get(message.namespace);
      const fn =
        provider && Object.hasOwn(provider.fns, message.functionName)
          ? provider.fns[message.functionName]
          : undefined;
      if (!fn) {
        throw new Error(
          `Unknown function ${message.namespace}.${message.functionName}`,
        );
      }
      const value = await fn(...payload.args);
      try {
        payloadJson = stringifyBounded(
          { ok: true, value } satisfies HostResultPayload,
          `Host result from ${message.namespace}.${message.functionName}`,
          MAX_QUICKJS_HOST_RPC_BYTES,
        );
      } catch (err) {
        const detail =
          err instanceof RangeError
            ? `Host result from ${message.namespace}.${message.functionName} exceeds the ${MAX_QUICKJS_HOST_RPC_BYTES}-byte serialized bridge limit.`
            : `Host result from ${message.namespace}.${message.functionName} could not be serialized: ${msg(err)}`;
        payloadJson = errorPayload(detail);
      }
    } catch (err) {
      payloadJson = errorPayload(msg(err));
    }
    if (!child.connected) return;
    try {
      child.send({
        type: "host-result",
        jobId: message.jobId,
        callId: message.callId,
        payloadJson,
      } satisfies ParentToChildMessage);
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

  private recycle(slot: ChildSlot): void {
    const child = slot.child;
    if (!child) return;
    slot.expectedExit = child;
    slot.child = undefined;
    child.kill();
  }

  private stopSlot(slot: ChildSlot): Promise<void> {
    const child = slot.child;
    if (!child) return Promise.resolve();
    this.rejectActive(
      slot,
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
