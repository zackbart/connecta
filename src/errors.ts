// Typed failure contract for connector tool calls. Web-API only — no node:
// imports here.

/** Machine-readable classification of a failed connector tool call. */
export type ConnectorCallErrorCode =
  | "timeout"
  | "auth_required"
  | "rate_limited"
  | "unavailable"
  | "invalid_args"
  | "input_required_unsupported"
  | "connector_call_failed";

/** One bounded, payload-free explanation of an input-schema mismatch. */
export interface ArgumentValidationIssue {
  /** JSON Pointer into the submitted arguments; "/" means the root value. */
  path: string;
  /** JSON Schema keyword that rejected the argument. */
  code: string;
  /** Expected shape only — never the submitted value. */
  expected: string;
}

export interface ArgumentValidationDetails {
  issues: ArgumentValidationIssue[];
  /** More findings existed but were omitted from the bounded response. */
  truncated?: true;
}

export const MAX_ARGUMENT_VALIDATION_ISSUES = 3;
const MAX_ARGUMENT_ISSUE_PATH_CHARS = 256;
const MAX_ARGUMENT_ISSUE_CODE_CHARS = 64;
const MAX_ARGUMENT_ISSUE_EXPECTED_CHARS = 128;

function boundedIssueText(
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return {
    value: `${value.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

/**
 * How many bytes of the caller's own arguments an error envelope will echo
 * back to it. Small on purpose: an error result is not size-guarded the way a
 * *result* is, so an unbounded echo turns a 50 KB argument object into a 100 KB
 * refusal against a deployment that capped results at 1 KB — twice over, since
 * the payload lands in both the text content and `structuredContent`. The agent
 * already holds what it sent; the echo is a convenience, never the record.
 */
const MAX_ECHOED_ARGS_BYTES = 512;

const echoEncoder = new TextEncoder();

/**
 * `{ args }` when the caller's arguments fit {@link MAX_ECHOED_ARGS_BYTES},
 * `{}` when they do not. All or nothing: a clipped echo would be a *different*
 * call than the one that was refused, and the routes this feeds end at a human
 * approving one. Unserializable arguments are treated the same way as oversized
 * ones — there is nothing honest to put in the field.
 */
export function echoedCallArgs(args: unknown): { args?: unknown } {
  if (args === undefined) return {};
  let text: string | undefined;
  try {
    text = JSON.stringify(args);
  } catch {
    return {};
  }
  if (text === undefined) return {};
  return echoEncoder.encode(text).length <= MAX_ECHOED_ARGS_BYTES
    ? { args }
    : {};
}

function boundedValidation(
  details: ArgumentValidationDetails | undefined,
): ArgumentValidationDetails | undefined {
  if (!details) return undefined;
  let truncated =
    details.truncated === true ||
    details.issues.length > MAX_ARGUMENT_VALIDATION_ISSUES;
  const issues = details.issues
    .slice(0, MAX_ARGUMENT_VALIDATION_ISSUES)
    .map((issue) => {
      const path = boundedIssueText(
        issue.path,
        MAX_ARGUMENT_ISSUE_PATH_CHARS,
      );
      const code = boundedIssueText(
        issue.code,
        MAX_ARGUMENT_ISSUE_CODE_CHARS,
      );
      const expected = boundedIssueText(
        issue.expected,
        MAX_ARGUMENT_ISSUE_EXPECTED_CHARS,
      );
      truncated ||= path.truncated || code.truncated || expected.truncated;
      return {
        path: path.value,
        code: code.value,
        expected: expected.value,
      };
    });
  return {
    issues,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** Agent-visible recovery class attached only to `auth_required` failures. */
export type AuthRecoveryMode =
  | "oauth"
  | "operator_config"
  | "unavailable";

const RETRYABLE_BY_CODE: Record<ConnectorCallErrorCode, boolean> = {
  timeout: true,
  rate_limited: true,
  unavailable: true,
  auth_required: false,
  invalid_args: false,
  input_required_unsupported: false,
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
  /**
   * Connector-known wait window in ms before this call is worth repeating,
   * or undefined when the connector reported none. Always an own property —
   * under ES2022 class fields the declaration itself defines it, so guarding
   * the assignment would not keep it off the instance. Keeping the window out
   * of the wire format is `classifyCallError`'s job, not this constructor's.
   */
  readonly retryAfterMs: number | undefined;
  /** Bounded schema findings for `invalid_args`; never submitted values. */
  readonly validation: ArgumentValidationDetails | undefined;

  constructor(
    code: ConnectorCallErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
      validation?: ArgumentValidationDetails;
    } = {},
  ) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "ConnectorCallError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_CODE[code];
    this.retryAfterMs = normalizeRetryAfterMs(opts.retryAfterMs);
    this.validation =
      code === "invalid_args" ? boundedValidation(opts.validation) : undefined;
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
  /** Bounded input-schema findings; paths and expectations, never values. */
  validation?: ArgumentValidationDetails;
  /** Connector whose failed operation needs recovery. */
  connector?: string;
  /** Canonical downstream address the agent may retry after recovery. */
  operation?: string;
  /** Which safe recovery path `authorize_connector` will return. */
  recovery?: AuthRecoveryMode;
  /** The single model-facing entry point for every credential class. */
  nextAction?: {
    tool: "authorize_connector";
    arguments: { connector: string };
    operatorHandoff: string;
  } | {
    tool: "search_tools";
    arguments: {
      query: string;
      connector?: string;
      includeSchemas: "compact";
    };
    purpose: string;
  } | {
    tool: "call_destructive_tool";
    arguments: {
      address: string;
      /**
       * The caller's own arguments, echoed only when they fit
       * {@link MAX_ECHOED_ARGS_BYTES} — and then whole, never clipped. Absent
       * means "re-send exactly what you sent": a half-copied argument object
       * routed into a human approval prompt would describe a call nobody made.
       */
      args?: unknown;
    };
    purpose: string;
  } | {
    /**
     * The same scoped discovery as the `search_tools` route above, addressed to
     * a caller inside `execute_code`, which cannot call a tool. Which of the two
     * a routing failure emits follows the route the caller took, not the
     * deployment's advertised surface.
     */
    function: "connecta.search";
    arguments: {
      query: string;
      connector?: string;
      includeSchemas: "compact";
    };
    purpose: string;
  } | {
    function: "connecta.call";
    addresses: string[];
    purpose: string;
  };
  /** Explicit retry guidance; recovery never retries or mutates by itself. */
  retry?: string;
}

/**
 * Codes whose retryability is a fact about connecta's own framing, never a
 * guess from text. The message embeds the address the caller asked for, so a
 * connector named `svc-503` or `temporary-export` would otherwise flip a policy
 * refusal into `retryable: true` through the heuristic below — and a caller that
 * trusts the flag would cheerfully retry a refusal forever.
 */
const NEVER_RETRYABLE_FRAMING = new Set([
  "unknown_address",
  "unknown_tool",
  "ambiguous_tool_alias",
  "destructive_tool_requires_approval",
]);

/**
 * Details for a failure connecta itself framed — an address it could not
 * resolve, a tool it refuses to run — rather than one a connector threw.
 */
export function framingError(code: string, message: string): CallErrorDetails {
  return {
    code,
    message,
    retryable: NEVER_RETRYABLE_FRAMING.has(code)
      ? false
      : messageLooksRetryable(message),
  };
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
      ...(err.validation ? { validation: err.validation } : {}),
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
