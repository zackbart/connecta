// The deadline vocabulary shared by downstream discovery probes and tool calls.
// One definition keeps those waits bounded consistently.

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

/** Resolve after `ms`, or false when the caller aborts first. */
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

export function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () =>
    rejectAbort(controller.signal.reason ?? options.timeoutError);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(
        () => controller.abort(options.timeoutError),
        options.timeoutMs,
      );
  let work: Promise<T>;
  try {
    work = operation(controller.signal);
  } catch (error) {
    work = Promise.reject(error);
  }
  return Promise.race([work, aborted]).finally(() => {
    controller.abort();
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    options.signal?.removeEventListener("abort", forwardAbort);
  });
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
