// The deadline vocabulary shared by downstream discovery probes and tool calls.
// One definition keeps those waits bounded consistently.

import { Effect } from "effect";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";

/**
 * Generous default bound for a single downstream probe/catalog call. High enough
 * to trip only on a pathological hang, not a realistically slow probe.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** A finite, positive integer number of milliseconds, or undefined. */
export function normalizeTimeoutMs(
  value: number | undefined,
): number | undefined {
  if (value === undefined || !Number.isFinite(value) || !(value > 0)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

/**
 * Resolve after `ms`, or false when the caller aborts first.
 *
 * Deliberately a bare timer rather than a run of `Effect.sleep`: there is no
 * work here for a fiber to own, and Effect's clock reads a zero or negative
 * wait as a microtask yield and a non-finite one as forever, where
 * `setTimeout` treats both as "next macrotask". Effect code sleeps with
 * `Effect.sleep` and never needs this.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(value);
    };
    const timer = setTimeout(() => finish(true), ms);
    const cancel = () => finish(false);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export interface DeadlineOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  timeoutError: Error;
}

/**
 * Run one operation under a deadline and the caller's signal, whichever ends
 * it first.
 *
 * The operation gets a signal of its own: the caller's abort is forwarded to
 * it, and the deadline aborts it with `timeoutError`. Either way the promise
 * rejects with that signal's reason, without waiting for work that ignores
 * the signal. A synchronous throw rejects like an asynchronous one. This is
 * the Promise face of `withDeadlineEffect` (src/runtime/run.ts), which owns
 * the contract; an Effect caller uses that directly.
 */
export function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  return runEdge(
    withDeadlineEffect(
      (signal) =>
        Effect.tryPromise({
          try: () => operation(signal),
          catch: (error) => error,
        }),
      options,
    ),
  );
}

/**
 * Give one operation a caller-facing deadline and the matching cancellation
 * signal. The timeout rejects with the stable, labelled error while aborting
 * any in-flight work that honors the signal.
 */
export function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return withDeadline(operation, {
    timeoutMs: ms,
    timeoutError: new Error(`${label} timed out after ${ms}ms`),
  });
}
