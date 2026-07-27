// The deadline vocabulary shared by every non-call downstream probe: the
// discovery meta-tools' catalog fan-out (src/meta-tools.ts) and the credential
// liveness checks (src/credential-health.ts). One definition so a "probe" means
// the same thing, and is bounded the same way, wherever one is issued.

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
 * Reject `promise` after `ms` if it has not settled, so one hung downstream
 * cannot stall a whole fan-out. This form bounds only the caller-facing wait;
 * use `withAbortableTimeout` when the operation accepts an AbortSignal and the
 * underlying work must stop too.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
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
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timeoutError = new Error(`${label} timed out after ${ms}ms`);
    const timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, ms);
    let promise: Promise<T>;
    try {
      promise = operation(controller.signal);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
