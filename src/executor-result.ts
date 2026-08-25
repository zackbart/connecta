import type { ExecuteResult } from "./types.js";
import { msg } from "./errors.js";

/** ~6k tokens. Sandbox code should filter data down before returning. */
const MAX_EXECUTE_RESULT_CHARS = 24_000;
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
function truncationEnvelope(text: string): {
  truncated: true;
  preview: string;
  totalChars: number;
  hint: string;
} {
  const base = {
    truncated: true as const,
    preview: "",
    totalChars: text.length,
    hint: TRUNCATION_HINT,
  };
  let budget = Math.max(
    0,
    MAX_EXECUTE_RESULT_CHARS - JSON.stringify(base).length,
  );
  for (let attempt = 0; attempt < 8 && budget > 0; attempt += 1) {
    const candidate = { ...base, preview: text.slice(0, budget) };
    const size = JSON.stringify(candidate).length;
    if (size <= MAX_EXECUTE_RESULT_CHARS) return candidate;
    // Every character costs at least one serialized character, so scaling by
    // the overshoot ratio (minus a step) strictly shrinks the budget.
    budget = Math.max(
      0,
      Math.floor(budget * (MAX_EXECUTE_RESULT_CHARS / size)) - 8,
    );
  }
  return { ...base, preview: text.slice(0, budget) };
}

export function guardExecuteResultValue(value: unknown): unknown {
  const text = serializeResultText(value);
  if (text.length <= MAX_EXECUTE_RESULT_CHARS) return value;
  return truncationEnvelope(text);
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
  if (outcome.error) {
    return {
      result: undefined,
      error: outcome.error,
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
