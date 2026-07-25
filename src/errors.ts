// Typed failure contract for connector tool calls. Web-API only — no node:
// imports here.

/** Machine-readable classification of a failed connector tool call. */
export type ConnectorCallErrorCode =
  | "timeout"
  | "auth_required"
  | "rate_limited"
  | "unavailable"
  | "invalid_args"
  | "connector_call_failed";

const RETRYABLE_BY_CODE: Record<ConnectorCallErrorCode, boolean> = {
  timeout: true,
  rate_limited: true,
  unavailable: true,
  auth_required: false,
  invalid_args: false,
  connector_call_failed: false,
};

/** Non-negative integer milliseconds, or undefined for anything else. */
function normalizeRetryAfterMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/**
 * Throw from `Connector.callTool` (or anything beneath it) to classify a
 * failure exactly. Untyped errors fall back to a message-text heuristic, so a
 * connector whose legitimate error text mentions "timeout" is misread as a
 * retryable timeout — this class is the escape hatch. `retryable` defaults per
 * code (timeout, rate_limited, and unavailable retry; the rest do not) and may
 * be overridden.
 *
 * `retryAfterMs` carries a wait window the connector already knows — a
 * `Retry-After` header, say — so the engine can wait that long instead of
 * guessing, and so an agent that receives the failure can decide when to
 * re-issue.
 */
export class ConnectorCallError extends Error {
  readonly code: ConnectorCallErrorCode;
  readonly retryable: boolean;
  /** Connector-known wait window in ms before this call is worth repeating. */
  readonly retryAfterMs?: number;

  constructor(
    code: ConnectorCallErrorCode,
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ConnectorCallError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_CODE[code];
    const retryAfterMs = normalizeRetryAfterMs(opts.retryAfterMs);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** The `error` object surfaced in call_tool/batch_call value-mode results. */
export interface CallErrorDetails {
  code: string;
  message: string;
  retryable: boolean;
  /**
   * Connector-reported wait window in ms, when known. Reported verbatim — the
   * engine bounds how long it will itself wait, but the caller sees the real
   * window so it can schedule a re-issue.
   */
  retryAfterMs?: number;
}

const RETRYABLE_MESSAGE_RE =
  /timeout|timed out|econnreset|econnrefused|temporar|rate.?limit|429|502|503|504|refcountedcanceler|different request/i;
const TIMEOUT_MESSAGE_RE = /timed out|timeout/i;

/** Message-text fallback used when an error carries no typed classification. */
export function messageLooksRetryable(message: string): boolean {
  return RETRYABLE_MESSAGE_RE.test(message);
}

/**
 * Classify a value thrown by a connector call. A `ConnectorCallError` is
 * authoritative; anything else falls back to the historical message-text
 * heuristic.
 */
export function classifyCallError(
  err: unknown,
  fallbackCode = "connector_call_failed",
): CallErrorDetails {
  if (err instanceof ConnectorCallError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      ...(err.retryAfterMs !== undefined
        ? { retryAfterMs: err.retryAfterMs }
        : {}),
    };
  }
  // An aborted fetch rejects with a DOMException named "AbortError" whose
  // message ("The operation was aborted", and variants across runtimes) matches
  // neither heuristic below — so a call the engine itself cancelled would read
  // as a non-retryable failure, the opposite of the truth. Note this also
  // covers an abort the connector triggered for its own reasons; running out of
  // time is by far the likelier cause and retryable/timeout is the safer read.
  if (err instanceof Error && err.name === "AbortError") {
    return { code: "timeout", message: err.message, retryable: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: TIMEOUT_MESSAGE_RE.test(message) ? "timeout" : fallbackCode,
    message,
    retryable: RETRYABLE_MESSAGE_RE.test(message),
  };
}
