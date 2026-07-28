import type { ExecuteResult } from "./types.js";

/** ~6k tokens. Sandbox code should filter data down before returning. */
const MAX_EXECUTE_RESULT_CHARS = 24_000;
export const MAX_EXECUTE_LOG_CHARS = 4_000;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeExecuteValue(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

export function guardExecuteResultValue(value: unknown): unknown {
  const text = serializeExecuteValue(value);
  if (text.length <= MAX_EXECUTE_RESULT_CHARS) return value;
  return {
    truncated: true,
    preview: text.slice(0, MAX_EXECUTE_RESULT_CHARS),
    totalChars: text.length,
    hint: "filter/map/slice data inside execute_code and return only what you need",
  };
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
