// Typed failure contract for connector tool calls. Web-API only — no node:
// imports here.

/**
 * Machine-readable classification of a failed connector tool call.
 *
 * A code earns its place by changing what the caller does next, never by
 * naming a cause — the rule provider conventions call H11.
 */
export type ConnectorCallErrorCode =
  | "timeout"
  | "auth_required"
  | "rate_limited"
  | "unavailable"
  | "invalid_args"
  /** Provider-owned absence; see provider-conventions.md H11 for the rule and
   * the permission-ambiguity exception. */
  | "not_found"
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
// Shared by argument and text echoes; see meta-tools.md lines 360-372.
const MAX_ECHOED_BYTES = 512;

/**
 * The same budget spent on caller-authored *text* — the address it mistyped,
 * the discovery query derived from it — rather than on its arguments.
 *
 * Text is clamped where {@link echoedCallArgs} drops: an address is the thing
 * the refusal exists to correct, so a refusal that named nothing would be
 * useless, while a clipped one still carries the prefix that identifies the
 * mistake. The marker says it was clipped, so nothing reads a clamped address
 * as the address that was sent. Arguments get the opposite rule because they
 * end at a human approving one specific call.
 *
 * The number is not cosmetic. An error result is not size-guarded the way a
 * result is, and every echoed byte lands twice (text content *and*
 * `structuredContent`), so an unbounded address turned a 50 KB typo into a
 * 200 KB refusal against a deployment that capped results at 1 KB.
 */
const echoEncoder = new TextEncoder();
const echoDecoder = new TextDecoder();

/**
 * Clamp a string to a UTF-8 byte budget, appending `…` when it clipped.
 * Short strings — the common case, and the one that has to stay exact — are
 * returned unchanged and untagged.
 */
export function boundedEchoText(
  value: string,
  maxBytes: number = MAX_ECHOED_BYTES,
): string {
  const bytes = echoEncoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  // Never split a codepoint: walk back off UTF-8 continuation bytes (10xxxxxx)
  // so the clamp cannot manufacture a replacement character.
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${echoDecoder.decode(bytes.slice(0, end))}…`;
}

/**
 * `{ args }` when the caller's arguments fit the shared echo budget,
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
  return echoEncoder.encode(text).length <= MAX_ECHOED_BYTES
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

/** Optional transport diagnostics; never a URL path or raw runtime message. */
interface UnavailableDetails {
  /** HTTP(S) origin only, at most 253 UTF-8 bytes. */
  host?: string;
  /** Validated network errno or `timeout`, at most 32 bytes. */
  code?: string;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
  "EAI_FAIL", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EHOSTDOWN",
  "ECONNABORTED", "EPIPE", "EACCES", "EPERM",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "timeout",
]);

function networkCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 32 && NETWORK_ERROR_CODES.has(value)
    ? value
    : undefined;
}

function sanitizedUnavailableDetails(
  details: UnavailableDetails | undefined,
): UnavailableDetails | undefined {
  if (!details) return undefined;
  let host: string | undefined;
  if (typeof details.host === "string") {
    try {
      const url = new URL(details.host);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        echoEncoder.encode(url.origin).length <= 253
      ) host = url.origin;
    } catch {
      // An invalid or oversized origin is absent, never a clipped destination.
    }
  }
  const code = networkCode(details.code);
  return host || code ? { ...(host ? { host } : {}), ...(code ? { code } : {}) } : undefined;
}

/** Runtime fields only: provider prose cannot supply an errno or a deadline. */
export function networkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "timeout";
  }
  const runtime = error as { code?: unknown; cause?: unknown };
  const cause = runtime.cause;
  return networkCode(runtime.code) ?? (
    cause && typeof cause === "object"
      ? networkCode((cause as { code?: unknown }).code)
      : undefined
  );
}

/** Use at a fetch boundary where the destination and transport failure are known. */
export function unavailableCallError(
  cause: unknown,
  host?: string,
  message = "Could not reach the downstream service.",
): ConnectorCallError {
  const code = networkErrorCode(cause);
  return new ConnectorCallError("unavailable", message, {
    cause,
    details: { ...(host ? { host } : {}), ...(code ? { code } : {}) },
  });
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
  not_found: false,
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
  /** Sanitized transport diagnostics for `unavailable` only. */
  readonly details: UnavailableDetails | undefined;

  constructor(
    code: ConnectorCallErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
      validation?: ArgumentValidationDetails;
      details?: UnavailableDetails;
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
    this.details =
      code === "unavailable" ? sanitizedUnavailableDetails(opts.details) : undefined;
    this.validation =
      code === "invalid_args" ? boundedValidation(opts.validation) : undefined;
  }
}

/** The `error` object surfaced in value-mode call results and rejected promises. */
export interface CallErrorDetails {
  /** Sanitized transport diagnostics, absent when the runtime supplies none. */
  details?: UnavailableDetails;
  code: string;
  message: string;
  retryable: boolean;
  /** Connector-known wait window; see {@link ConnectorCallError.retryAfterMs}. */
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
       * the shared echo budget — and then whole, never clipped. Absent
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
  "result_processing_failed",
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
function messageLooksRetryable(message: string): boolean {
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
      ...(err.details ? { details: err.details } : {}),
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

export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
