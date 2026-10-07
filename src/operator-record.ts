// What an operator may read about a failure: log records and status text.
// Web-API only — no node: imports here.
//
// INV-6 says logs carry no arguments, results, code, or raw downstream error
// text. Filtering errors where they arise kept missing sources: a validator's
// diagnostic, a stream's TypeError, a JSON-RPC error the agent may see. So the
// rule is enforced here, at the sink. A failure reaches an operator only as
// the fields of a `FailureRecord`, which `failureRecord` alone builds: each
// one copied from an explicit list, checked against a constant table or a
// grammar, and never taken from an error's message, cause, stack, data,
// nested errors, or name. `logFailure` writes nothing else, and every status
// message about a failure comes from `describeFailure`
// (test/operator-record-sources.node.test.ts holds src/ to that).
//
// Provenance is by identity, never by shape. Text that merely looks like
// connecta's (an error named like one of its classes, a status sentence
// shaped like a record) carries no weight: a class label comes from the
// prototype chain, a status message from the status object connecta built.
//
// Agent-facing results are a different surface with a different rule: a
// downstream's own answer to a call may reach the agent that made it (see
// documentation/architecture.md, "Errors and records").

import { ConnectorCallError, NETWORK_ERROR_CODES, WithheldTextError } from "./errors.js";
import type { ConnectorStatus, Logger } from "./types.js";

/** Where in connecta's work a failure happened. Closed, so it carries no prose. */
type FailureStep =
  | "MCP handshake"
  | "tools/list"
  | "tools/call"
  | "OAuth discovery"
  | "OAuth client registration"
  | "OAuth token request"
  | "OAuth flow"
  | "handler";

const STEPS: ReadonlySet<string> = new Set<FailureStep>([
  "MCP handshake", "tools/list", "tools/call", "OAuth discovery",
  "OAuth client registration", "OAuth token request", "OAuth flow", "handler",
]);

/** Classification codes connecta assigns. Anything else is left out. */
const CODES: ReadonlySet<string> = new Set([
  "timeout", "auth_required", "rate_limited", "unavailable", "invalid_args",
  "not_found", "conflict", "input_required_unsupported", "connector_call_failed",
  "cancelled", "unknown_address", "unknown_tool", "result_too_large",
  "destructive_tool_requires_approval", "write_outcome_unknown",
  "result_processing_failed", "budget_exceeded", "executor_failed",
  "executor_overloaded", "executor_cancelled", "executor_closed",
]);

/**
 * Registered OAuth `error` codes: the pinned SDK's `OAuthErrorCode` values
 * (RFC 6749, 6750, 7591, 8707, 9449) and RFC 7591's software-statement pair.
 */
export const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied", "server_error",
  "temporarily_unavailable", "unsupported_response_type", "unsupported_token_type",
  "invalid_token", "method_not_allowed", "too_many_requests",
  "invalid_client_metadata", "invalid_redirect_uri", "insufficient_scope",
  "invalid_target", "invalid_dpop_proof", "use_dpop_nonce",
  "invalid_software_statement", "unapproved_software_statement",
]);

const SOURCES: ReadonlySet<string> = new Set([
  "call_tool", "call_destructive_tool", "batch_call", "execute_code", "resume_execution",
]);

const STATUS_STATES: ReadonlySet<string> = new Set(["ok", "auth_required", "error"]);
/** A status state, or `failed` for a status that could not be read at all. */
const STATES: ReadonlySet<string> = new Set([...STATUS_STATES, "failed"]);

/** The registry's connector id grammar (src/registry.ts). */
const CONNECTOR_ID_RE = /^[a-z0-9_-]{1,64}$/;
/** MCP's tool name grammar (SEP-986). */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
/** An inbound identity's opaque id. */
const USER_ID_RE = /^[A-Za-z0-9_.:@|-]{1,128}$/;
const LABEL_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** What stands in for a name connecta could not vouch for. */
const UNLISTED_TOOL = "<unlisted>";
const UNKNOWN_CONNECTOR = "<unknown>";

// ---------------------------------------------------------------------------
// Error class labels, by identity

/** Prototype → label. Labels are literals in source, never read from an error. */
const labels = new Map<object, string>();
const labelNames = new Set<string>(["DOMException", "AbortError", "TimeoutError"]);

/**
 * Name `ctor`'s instances `label` in records and fixed text. Call once, at
 * module scope, beside the class. An error whose prototype chain reaches no
 * labelled class has no label; its `name` is never consulted.
 */
export function labelErrorClass(ctor: { readonly prototype: object }, label: string): void {
  if (!LABEL_RE.test(label)) throw new TypeError(`Invalid error class label "${label}"`);
  labels.set(ctor.prototype, label);
  labelNames.add(label);
}

for (const [ctor, label] of [
  [Error, "Error"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [URIError, "URIError"],
  [EvalError, "EvalError"],
  [AggregateError, "AggregateError"],
  [ConnectorCallError, "ConnectorCallError"],
  [WithheldTextError, "WithheldTextError"],
] as const) {
  labelErrorClass(ctor, label);
}

/** The two DOMException names a record tells apart; any other is `DOMException`. */
const DOM_EXCEPTION_LABELS: ReadonlySet<string> = new Set(["AbortError", "TimeoutError"]);

/**
 * The label of the nearest labelled class on `failure`'s prototype chain.
 * A genuine DOMException is told as `AbortError` or `TimeoutError` when its
 * name is exactly one of those, else `DOMException`.
 */
export function errorLabel(failure: unknown): string | undefined {
  if (failure === null || typeof failure !== "object") return undefined;
  try {
    for (
      let proto: object | null = Object.getPrototypeOf(failure);
      proto !== null;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      if (typeof DOMException === "function" && proto === DOMException.prototype) {
        const name = (failure as DOMException).name;
        return DOM_EXCEPTION_LABELS.has(name) ? name : "DOMException";
      }
      const label = labels.get(proto);
      if (label) return label;
    }
  } catch {
    // A proxy, or a DOMException-shaped object without its internal slot.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Facts attached by identity

/** Facts connecta derived about a failure where it saw it. */
export interface FailureFacts {
  step?: FailureStep;
  /** Scheme, host, and port of the request that failed. */
  origin?: string;
  /** The HTTP status the downstream answered with. */
  httpStatus?: number;
  /** A registered OAuth `error` code the server named. */
  oauthError?: string;
}

interface CarriedFacts extends FailureFacts {
  /** The label of the original behind a rebuilt error. */
  errorClass?: string;
}

function origin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin.length <= 253
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function httpStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : undefined;
}

function member(value: unknown, table: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && table.has(value) ? value : undefined;
}

function checkedFacts(facts: CarriedFacts | undefined): CarriedFacts {
  if (!facts) return {};
  return {
    ...defined("step", member(facts.step, STEPS) as FailureStep | undefined),
    ...defined("origin", origin(facts.origin)),
    ...defined("httpStatus", httpStatus(facts.httpStatus)),
    ...defined("oauthError", member(facts.oauthError, OAUTH_ERROR_CODES)),
    ...defined("errorClass", member(facts.errorClass, labelNames)),
  };
}

function defined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * Facts attached to failures by identity, never as properties: nothing about
 * the failure's own shape changes, and nothing a caller can see grows.
 */
const attached = new WeakMap<object, CarriedFacts>();

/** Note what connecta knows about `failure` for any record made of it later. */
export function attachFailureFacts<T>(failure: T, facts: FailureFacts): T {
  if (failure !== null && typeof failure === "object") {
    attached.set(failure, { ...attached.get(failure), ...checkedFacts(facts) });
  }
  return failure;
}

/** The facts and class label of `from`, kept for `to` (its classified form, say). */
export function carryFailureFacts<T>(from: unknown, to: T): T {
  if (to === null || typeof to !== "object") return to;
  const facts = from !== null && typeof from === "object" ? attached.get(from) : undefined;
  const errorClass = errorLabel(from);
  // A class carried here already (the original behind a rebuilt error) wins.
  const carried = { ...(errorClass ? { errorClass } : {}), ...facts };
  attached.set(to, { ...carried, ...attached.get(to) });
  return to;
}

// ---------------------------------------------------------------------------
// The record

/** What a failure record may be about. Only these fields are read. */
export interface FailureSubject {
  /** A registered connector's id. */
  connector?: string;
  /**
   * The catalog entry the call resolved to, never a name alone: a tool is
   * named only when connecta found it in that connector's catalog.
   */
  tool?: { readonly name: string } | undefined;
  source?: string;
  /** An inbound identity's opaque id. */
  userId?: string;
  /** A status state, for a status record. */
  state?: ConnectorStatus["state"] | "failed";
  attempts?: number;
  durationMs?: number;
}

declare const recordBrand: unique symbol;

/** One failure as an operator may read it. Only `failureRecord` makes one. */
export interface FailureRecord {
  readonly [recordBrand]: true;
  readonly connector?: string;
  readonly tool?: string;
  readonly source?: string;
  readonly userId?: string;
  readonly state?: string;
  readonly attempts?: number;
  readonly durationMs?: number;
  readonly step?: string;
  readonly origin?: string;
  readonly httpStatus?: number;
  readonly oauthError?: string;
  /** Classification code, such as `unavailable` or `connector_call_failed`. */
  readonly code?: string;
  readonly retryable?: boolean;
  /** The error's class label, by identity, such as `TypeError`. */
  readonly errorClass?: string;
  /** A network errno or `timeout`. */
  readonly errno?: string;
}

const built = new WeakSet<object>();

function count(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? Math.round(value)
    : undefined;
}

function connectorId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && CONNECTOR_ID_RE.test(value) ? value : UNKNOWN_CONNECTOR;
}

function checkedSubject(subject: FailureSubject): object {
  const tool = subject.tool;
  return {
    ...defined("connector", connectorId(subject.connector)),
    ...("tool" in subject
      ? { tool: tool && typeof tool.name === "string" && TOOL_NAME_RE.test(tool.name) ? tool.name : UNLISTED_TOOL }
      : {}),
    ...defined("source", member(subject.source, SOURCES)),
    ...defined(
      "userId",
      typeof subject.userId === "string" && USER_ID_RE.test(subject.userId) ? subject.userId : undefined,
    ),
    ...defined("state", member(subject.state, STATES)),
    ...defined("attempts", count(subject.attempts, 1_000)),
    ...defined("durationMs", count(subject.durationMs, 86_400_000)),
  };
}

/** The typed classification `failure` carries. */
function classification(failure: unknown): object {
  let typed: { code?: unknown; retryable?: unknown; details?: unknown } | undefined;
  if (failure instanceof ConnectorCallError) typed = failure;
  else if (failure instanceof WithheldTextError) {
    typed = { retryable: failure.retryable, ...(failure.timeout ? { code: "timeout" } : {}) };
  } else if (failure !== null && typeof failure === "object" && !(failure instanceof Error)) {
    // A classified `CallErrorDetails` object.
    typed = failure as typeof typed;
  }
  const details = typed?.details !== null && typeof typed?.details === "object"
    ? (typed.details as { host?: unknown; code?: unknown })
    : undefined;
  return {
    ...defined("code", member(typed?.code, CODES)),
    ...defined("retryable", typeof typed?.retryable === "boolean" ? typed.retryable : undefined),
    ...defined("origin", origin(details?.host)),
    ...defined("errno", member(details?.code, NETWORK_ERROR_CODES)),
  };
}

/**
 * The record of a failure: the subject's listed fields, each checked; the
 * facts attached to the failure; its class label; and the typed
 * classification it carries (a `ConnectorCallError`'s code, retryability,
 * origin, and errno, or a classified `CallErrorDetails` object's). Never its
 * text, and nothing else from `subject`.
 */
export function failureRecord(subject: FailureSubject, failure?: unknown): FailureRecord {
  const facts = failure !== null && typeof failure === "object" ? attached.get(failure) : undefined;
  const errorClass = errorLabel(failure);
  const record = Object.freeze({
    ...checkedSubject(subject),
    ...classification(failure),
    ...(errorClass ? { errorClass } : {}),
    ...checkedFacts(facts),
  }) as FailureRecord;
  built.add(record);
  return record;
}

/**
 * The events an operator log reports failures as. Closed: a new one is a
 * reviewed line here, never a string assembled at the call site.
 */
export type FailureEvent =
  | "call failed"
  | "input schema unusable; arguments are not validated"
  | "catalog read failed"
  | "catalog persistence failed"
  | "catalog invalidation failed"
  | "catalog refresh failed; serving stale catalog"
  | "deferred catalog refresh failed"
  | "deferred catalog refresh could not attach to the runtime"
  | "catalog drift check failed"
  | "credential shape read failed"
  | "credential test failed"
  | "credential test threw"
  | "session termination refused or failed; the downstream session may remain until its provider timeout"
  | "activity record failed"
  | "catalog drift record failed"
  | "activity read failed"
  | "OAuth start failed"
  | "OAuth disconnect failed"
  | "OAuth callback verifyState threw; no authorization code was exchanged"
  | "OAuth callback handoff could not be consumed; no authorization code was exchanged"
  | "MCP handler error"
  | "operator status"
  | "request failed"
  | "Clerk email lookup failed; denying";

/**
 * Log one failure as `[connecta] <event>` and its record. A record
 * `failureRecord` did not build is refused, whatever its shape.
 */
export function logFailure(
  logger: Pick<Logger, "info" | "warn" | "error">,
  event: FailureEvent,
  record: FailureRecord,
  level: "info" | "warn" | "error" = "warn",
): void {
  if (!built.has(record)) {
    throw new TypeError("logFailure takes only a record built by failureRecord");
  }
  logger[level](`[connecta] ${event}`, record);
}

/**
 * A failure in connecta's words, from its record alone:
 * `Connector "<id>" <step> with <origin> failed with HTTP <status> (<class>, <code>, <errno>).`
 * Used for status messages, and for agent-facing text where the error's own
 * may not pass.
 */
export function describeFailure(connectorId: string, failure: unknown): string {
  const record = failureRecord({ connector: connectorId }, failure);
  const where = record.step
    ? ` ${record.step}${record.origin ? ` with ${record.origin}` : ""}`
    : record.origin
      ? ` request to ${record.origin}`
      : "";
  const status = record.httpStatus ? ` with HTTP ${record.httpStatus}` : "";
  const oauth = record.oauthError ? ` and OAuth error ${record.oauthError}` : "";
  const kind = [record.errorClass, record.code, record.errno].filter(Boolean).join(", ");
  return `Connector "${record.connector}"${where} failed${status}${oauth}${kind ? ` (${kind})` : ""}.`;
}

// ---------------------------------------------------------------------------
// Status provenance

/** Status objects whose message connecta wrote, and the failure behind each. */
const ownStatuses = new WeakMap<object, { failure?: unknown }>();

/** A status whose message connecta wrote, such as an auth_required notice. */
export function ownStatus<T extends ConnectorStatus>(status: T): T {
  ownStatuses.set(status, {});
  return status;
}

/** An error status described from `failure`'s record, remembering the failure. */
export function failureStatus(connectorId: string, failure: unknown): ConnectorStatus {
  const status: ConnectorStatus = { state: "error", message: describeFailure(connectorId, failure) };
  ownStatuses.set(status, { failure });
  return status;
}

/**
 * `status` rebuilt from its typed state. Its message survives only when
 * connecta wrote it (`ownStatus`, `failureStatus`): a plugin `status()` seam
 * returns its author's text, which can quote a downstream, and connecta
 * cannot vouch for it whatever it looks like.
 */
export function boundedStatus(status: ConnectorStatus): ConnectorStatus {
  const own = status !== null && typeof status === "object" ? ownStatuses.get(status) : undefined;
  const state = member(status?.state, STATUS_STATES) as ConnectorStatus["state"] | undefined ?? "error";
  const rebuilt: ConnectorStatus = {
    state,
    ...(own && typeof status.message === "string" ? { message: status.message } : {}),
  };
  if (own) ownStatuses.set(rebuilt, own);
  return rebuilt;
}

/** The failure connecta saw behind a status it described, if any. */
export function statusFailure(status: ConnectorStatus): unknown {
  return ownStatuses.get(status)?.failure;
}
