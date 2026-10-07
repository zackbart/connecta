// What an operator may read about a failure: log records and status text.
// Web-API only — no node: imports here.
//
// INV-6 says logs carry no arguments, results, code, or raw downstream error
// text. Filtering errors where they arise kept missing sources: a validator's
// diagnostic, a stream's TypeError, a JSON-RPC error the agent may see. So the
// rule is enforced here, at the sink. A failure reaches an operator only as
// the fields below, each one a fact connecta derived and checked itself; an
// error's message, cause, stack, data, or nested errors have no field to go
// in. Every log line about a failure goes through `logFailure`, and every
// status message about one through `describeFailure`
// (test/operator-records.test.ts holds src/ to that).
//
// Agent-facing results are a different surface with a different rule: a
// downstream's own answer to a call may reach the agent that made it (see
// documentation/architecture.md, "Errors and records").

import { ConnectorCallError, WithheldTextError } from "./errors.js";
import type { Logger } from "./types.js";

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

/** One failure as an operator may read it. Every field is checked here. */
export interface FailureRecord extends FailureFacts {
  /** Classification code, such as `unavailable` or `connector_call_failed`. */
  code?: string;
  retryable?: boolean;
  /** The error's class name, such as `TypeError` or `SdkHttpError`. */
  errorClass?: string;
  /** A network errno or `timeout`. */
  errno?: string;
}

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CLASS_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERRNO_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

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

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function checkedFacts(facts: FailureFacts | undefined): FailureFacts {
  if (!facts) return {};
  const step = facts.step;
  return {
    ...(step ? { step } : {}),
    ...defined("origin", origin(facts.origin)),
    ...defined("httpStatus", httpStatus(facts.httpStatus)),
    ...defined("oauthError", matching(facts.oauthError, CODE_RE)),
  };
}

function defined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * Facts attached to failures by identity, never as properties: nothing about
 * the failure's own shape changes, and nothing a caller can see grows.
 */
const attached = new WeakMap<object, FailureFacts>();

/** Note what connecta knows about `failure` for any record made of it later. */
export function attachFailureFacts<T>(failure: T, facts: FailureFacts): T {
  if (failure !== null && typeof failure === "object") {
    attached.set(failure, { ...attached.get(failure), ...checkedFacts(facts) });
  }
  return failure;
}

/** The facts and class of `from`, kept for `to` (its classified form, say). */
export function carryFailureFacts<T>(from: unknown, to: T): T {
  if (to === null || typeof to !== "object") return to;
  const facts = from !== null && typeof from === "object" ? attached.get(from) : undefined;
  const errorClass = className(from);
  // A class carried here already (the original behind a rebuilt error) wins.
  const carried = { ...(errorClass ? { errorClass } : {}), ...facts };
  attached.set(to, { ...carried, ...attached.get(to) });
  return to;
}

function className(failure: unknown): string | undefined {
  return failure instanceof Error ? matching(failure.name, CLASS_RE) : undefined;
}

/**
 * The record of a failure: its attached facts, its class, and the typed
 * classification it carries (a `ConnectorCallError`'s code, retryability,
 * origin, and errno, or a classified `CallErrorDetails` object's). Never its
 * text.
 */
export function failureRecord(failure: unknown): FailureRecord {
  const facts = failure !== null && typeof failure === "object"
    ? (attached.get(failure) as FailureRecord | undefined)
    : undefined;
  let typed: { code?: unknown; retryable?: unknown; details?: unknown } | undefined;
  if (failure instanceof ConnectorCallError) typed = failure;
  else if (failure instanceof WithheldTextError) {
    typed = { retryable: failure.retryable, ...(failure.timeout ? { code: "timeout" } : {}) };
  } else if (failure !== null && typeof failure === "object" && !(failure instanceof Error)) {
    typed = failure as typeof typed;
  }
  const details = typed?.details !== null && typeof typed?.details === "object"
    ? (typed.details as { host?: unknown; code?: unknown })
    : undefined;
  const errorClass = matching(facts?.errorClass, CLASS_RE) ?? className(failure);
  return {
    ...defined("code", matching(typed?.code, CODE_RE)),
    ...defined("retryable", typeof typed?.retryable === "boolean" ? typed.retryable : undefined),
    ...defined("errorClass", errorClass),
    ...defined("origin", origin(details?.host)),
    ...defined("errno", matching(details?.code, ERRNO_RE)),
    ...checkedFacts(facts),
  };
}

/** What a failure record may be about: ids, names, and counts. */
export interface FailureSubject {
  connector?: string;
  tool?: string;
  /** `connector.tool`, where the caller has only the address. */
  address?: string;
  source?: string;
  /** An inbound identity's opaque id. */
  userId?: string;
  attempts?: number;
  durationMs?: number;
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
  | "request failed"
  | "Clerk email lookup failed; denying";

/** Log one failure as `[connecta] <event>` and a record of typed facts. */
export function logFailure(
  logger: Pick<Logger, "warn" | "error">,
  event: FailureEvent,
  subject: FailureSubject,
  failure: unknown,
  level: "warn" | "error" = "warn",
): void {
  logger[level](`[connecta] ${event}`, { ...subject, ...failureRecord(failure) });
}

/**
 * A failure in connecta's words, from its record alone:
 * `Connector "<id>" <step> with <origin> failed with HTTP <status> (<class>, <code>, <errno>).`
 * Used for status messages, and for agent-facing text where the error's own
 * may not pass.
 */
export function describeFailure(connectorId: string, failure: unknown): string {
  const record = failureRecord(failure);
  const where = record.step
    ? ` ${record.step}${record.origin ? ` with ${record.origin}` : ""}`
    : record.origin
      ? ` request to ${record.origin}`
      : "";
  const status = record.httpStatus ? ` with HTTP ${record.httpStatus}` : "";
  const oauth = record.oauthError ? ` and OAuth error ${record.oauthError}` : "";
  const kind = [record.errorClass, record.code, record.errno].filter(Boolean).join(", ");
  return `Connector "${connectorId}"${where} failed${status}${oauth}${kind ? ` (${kind})` : ""}.`;
}

const STEPS: readonly FailureStep[] = [
  "MCP handshake", "tools/list", "tools/call", "OAuth discovery",
  "OAuth client registration", "OAuth token request", "OAuth flow", "handler",
];
const ORIGIN_PATTERN = "https?://[A-Za-z0-9.\\-\\[\\]:]{1,253}";
const DESCRIPTION_RE = new RegExp(
  `^Connector "(?<id>[^"]{1,128})"` +
    `(?: (?:${STEPS.map((step) => step.replace("/", "\\/")).join("|")})(?: with ${ORIGIN_PATTERN})?| request to ${ORIGIN_PATTERN})?` +
    " failed(?: with HTTP [1-5][0-9]{2})?(?: and OAuth error [a-z][a-z0-9_]{0,63})?" +
    "(?: \\([A-Za-z][A-Za-z0-9_]{0,63}(?:, [A-Za-z][A-Za-z0-9_]{0,63}){0,2}\\))?\\.$",
);

/**
 * Whether `message` is exactly a `describeFailure` sentence for this
 * connector: something that parses as a record carries nothing else. A
 * status from a connector's own `status()` seam is otherwise its author's
 * text, which connecta cannot vouch for, so it is logged only when it parses.
 */
export function isFailureDescription(connectorId: string, message: string): boolean {
  return DESCRIPTION_RE.exec(message)?.groups?.id === connectorId;
}
