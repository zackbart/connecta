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

/**
 * Throw from `Connector.callTool` (or anything beneath it) to classify a
 * failure exactly. Untyped errors fall back to a message-text heuristic, so a
 * connector whose legitimate error text mentions "timeout" is misread as a
 * retryable timeout — this class is the escape hatch. `retryable` defaults per
 * code (timeout, rate_limited, and unavailable retry; the rest do not) and may
 * be overridden.
 */
export class ConnectorCallError extends Error {
  readonly code: ConnectorCallErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ConnectorCallErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ConnectorCallError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_CODE[code];
  }
}

/** The `error` object surfaced in call_tool/batch_call value-mode results. */
export interface CallErrorDetails {
  code: string;
  message: string;
  retryable: boolean;
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
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: TIMEOUT_MESSAGE_RE.test(message) ? "timeout" : fallbackCode,
    message,
    retryable: RETRYABLE_MESSAGE_RE.test(message),
  };
}
