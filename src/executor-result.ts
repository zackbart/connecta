import type { ExecuteResult } from "./types.js";
import { msg } from "./errors.js";

/** ~6k tokens. Sandbox code should filter data down before returning. */
export const MAX_EXECUTE_RESULT_CHARS = 24_000;
export const MAX_EXECUTE_LOG_CHARS = 4_000;

export function serializeResultText(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

const TRUNCATION_HINT =
  "filter/map/slice data inside execute_code and return only what you need";

/**
 * Shape the over-cap notice so the **serialized envelope** fits the same cap
 * the raw value missed. Escaping matters: a preview sliced to the cap is JSON
 * text whose quotes and newlines re-escape to well over it, so a fixed slice
 * would leave the envelope over-cap and a second pass through this guard would
 * truncate the truncation — reporting the envelope's length as `totalChars` and
 * burying the real size. Shrinking proportionally until it fits keeps the guard
 * idempotent by construction: `totalChars` is always the true serialized size
 * of what the program returned, and truncation happens exactly once no matter
 * how many hops the value takes.
 */
function truncationEnvelope(text: string, maxChars: number, totalChars = text.length): {
  truncated: true;
  preview: string;
  totalChars: number;
  hint: string;
} {
  const base = {
    truncated: true as const,
    preview: "",
    totalChars,
    hint: TRUNCATION_HINT,
  };
  let budget = Math.max(
    0,
    maxChars - JSON.stringify(base).length,
  );
  for (let attempt = 0; attempt < 8 && budget > 0; attempt += 1) {
    const candidate = { ...base, preview: text.slice(0, budget) };
    const size = JSON.stringify(candidate).length;
    if (size <= maxChars) return candidate;
    // Every character costs at least one serialized character, so scaling by
    // the overshoot ratio (minus a step) strictly shrinks the budget.
    budget = Math.max(
      0,
      Math.floor(budget * (maxChars / size)) - 8,
    );
  }
  return { ...base, preview: text.slice(0, budget) };
}

export function guardExecuteResultValue(value: unknown, maxChars = MAX_EXECUTE_RESULT_CHARS): unknown {
  const text = serializeResultText(value);
  if (text.length <= maxChars) return value;
  // A child may already have guarded this value at a larger transport cap.
  // Shrink its preview once more without nesting notices or losing original size.
  if (value !== null && typeof value === "object") {
    const prior = value as { truncated?: unknown; preview?: unknown; totalChars?: unknown; hint?: unknown };
    if (prior.truncated === true && prior.hint === TRUNCATION_HINT && typeof prior.preview === "string" &&
      typeof prior.totalChars === "number" && Number.isSafeInteger(prior.totalChars) && prior.totalChars >= prior.preview.length &&
      Object.keys(value).length === 4) {
      return truncationEnvelope(prior.preview, maxChars, prior.totalChars);
    }
  }
  return truncationEnvelope(text, maxChars);
}

export function truncateExecuteText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n--- TRUNCATED (${text.length} chars total) — filter/map/slice data inside your code and return only what you need ---`;
}

/**
 * Apply the public execute_code result/log policy before a child result enters
 * IPC. The parent repeats the guard for third-party Executor implementations.
 */
export function prepareExecuteResultForTransport(
  outcome: ExecuteResult,
): ExecuteResult {
  // QuickJS already bounds captured logs at source (entries + cumulative
  // characters). Preserve that Executor-level shape; createExecuteTool applies
  // the smaller model-facing 4k presentation cap in the parent.
  const logs =
    outcome.logs && outcome.logs.length > 0 ? outcome.logs : undefined;
  // An empty string is still a failure (E5): the parent renders a fixed
  // message for it, but this transport must not turn it into a success.
  if (outcome.error !== undefined) {
    return {
      result: undefined,
      error: outcome.error,
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(logs ? { logs } : {}),
    };
  }
  try {
    return {
      result: guardExecuteResultValue(outcome.result),
      ...(logs ? { logs } : {}),
    };
  } catch (err) {
    return {
      result: undefined,
      error: `result is not JSON-serializable: ${msg(err)}`,
      ...(logs ? { logs } : {}),
    };
  }
}
