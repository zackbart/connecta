// Pure physical-request facts, failure provenance and construction identities.
// No operation/call services or transport graph: provider definitions and
// operator sinks can preserve provenance without acquiring Effect.
import { carryResendAdvice, ConnectorCallError } from "./errors.js";
import { followRedactedCopies } from "./redaction-identity.js";
import type { Connector } from "./types.js";
export interface ProviderRequest {
  readonly dispatched: boolean;
  readonly status?: number;
  auxiliary: boolean;
  /** A kit auxiliary declared as a read lacked physical GET/HEAD proof at dispatch. */
  readonly blocksAuxiliaryProof?: true;
  provider: string;
  /** The HTTP method it was sent with, when its channel knows it. */
  readonly method?: string;
  /** Positive operation/tool evidence; an HTTP method alone proves no read. */
  classification?: "read" | "write" | undefined;
  /** Remote MCP's source class said write, recorded at physical dispatch. */
  readonly sourceWrite?: true;
  /** The genuine, legal idempotency key the vendor honors that it carried; nothing else. */
  key?: string;
  /**
   * Its answer was a 401 that the transport's reviewed `authBeforeExecution`
   * evidence covers: the vendor rejected the credential before it acted on
   * the request. Only that makes a 401 a refusal (`servedRefusal`).
   */
  authBeforeExecution?: true;
  /**
   * Its answer was a 401, and a renewal then replaced the credential it sent
   * with a different one ({@link renewedAfterUnauthorized}). The 401 no
   * longer needs the operator's recovery. The single `settleWrite` decider
   * still reports unknown, without the handoff (Q8).
   */
  readonly renewed?: true;
}
// A redacted copy of a failure is the same failure: its verdict follows it.
const refusals = followRedactedCopies(new WeakMap<object, ProviderRequest>());
const knownFailures = followRedactedCopies(new WeakSet<object>());
// Verdicts that already account for a write's 401 in words of their own: a
// renewal's (`unsentAfterUnauthorized`) or Q8's own. Q8 adds no sentence to them.
const explainedUnauthorized = followRedactedCopies(new WeakSet<object>());
// Verdicts the one Q8 decision (`settleWrite`) made. They are final: nothing
// after it may add retry, resend, key-reuse or wait advice to them.
const settledWrites = followRedactedCopies(new WeakSet<object>());
// The authorization verdict a request's own 401 was mapped to, kept for the
// call's verdict whatever failure surfaces after it (Q8).
const unauthorizedAnswers = new WeakMap<ProviderRequest, ConnectorCallError>();
const trackedConnectors = new WeakSet<object>();

// Call identities, each bound to the connector object it was built as and
// the `callTool` function it had then. A copy (`{ ...boundary }`,
// `Object.assign`) is another object and is in neither table, so it can
// share a boundary's function but never its standing; reassigning the
// property on the original leaves the recorded function behind.
export type CallTool = Connector["callTool"];
interface Boundary {
  /** The api() or remoteMcp() object whose own code enters the logical call. */
  boundary: object;
  own: CallTool;
}
const boundaries = new WeakMap<object, Boundary>();
const delegators = new WeakMap<object, CallTool>();

const aliases = new WeakMap<object, object>();
export function originalCallIdentity(connector: object): object {
  return aliases.get(connector) ?? connector;
}
export function boundaryFor(connector: object): Boundary | undefined {
  return boundaries.get(connector);
}
export function delegatorFor(connector: object): CallTool | undefined {
  return delegators.get(connector);
}
/** A physical send owns its fields permanently; its own answer is recorded once. */
export function recordRequestField(request: ProviderRequest, field: keyof ProviderRequest, value: unknown): void {
  Object.defineProperty(request, field, { value, enumerable: true, writable: false, configurable: false });
}

export function recordProviderResponse(request: ProviderRequest, status: number): void {
  if (request.status !== undefined) throw new Error("Provider request already answered.");
  recordRequestField(request, "status", status);
}

/**
 * Declare that every request the connector's handlers send goes through a
 * channel the call ledger records: a guarded transport, `ctx.fetch`, or
 * `ctx.oauth.fetch`. Only then does an empty ledger prove that a failed
 * write never left. Maintained providers declare it; an arbitrary `api()`
 * handler can reach the network some other way, so its ledger proves nothing.
 */
export function tracksEveryRequest<T extends object>(connector: T): T {
  trackedConnectors.add(connector);
  return connector;
}

export function tracksRequests(connector: object): boolean {
  return trackedConnectors.has(connector);
}

/**
 * Declare a maintained connector whose `callTool` hands each call to at most
 * one api() or remoteMcp() boundary and sends nothing else that could apply
 * it (GitHub). Only then may that boundary's verdict stand for the call. The
 * object and its function are recorded now, at construction: a later
 * assignment to the property, or a copy of the object, declares nothing.
 */
export function delegatesEachCall<T extends Connector>(connector: T): T {
  delegators.set(connector, connector.callTool);
  return connector;
}

/**
 * Record a just-built api() or remoteMcp() object as a boundary, with its
 * published `callTool`. Its own code then names the same object, from its
 * closure, in {@link enterProviderBoundary}.
 */
export function providerBoundary(connector: Connector): void {
  boundaries.set(connector, { boundary: connector, own: connector.callTool });
}

/**
 * `alias` serves `base` itself (`defineProvider`'s inheriting stamp), so it
 * takes `base`'s recorded identities. Only construction code calls this.
 */
export function aliasCallIdentity(alias: object, base: object): void {
  aliases.set(alias, originalCallIdentity(base));
  const boundary = boundaries.get(base);
  const delegator = delegators.get(base);
  if (boundary) boundaries.set(alias, boundary);
  if (delegator) delegators.set(alias, delegator);
}

/**
 * Whether a served HTTP status says the request was refused, not applied: a
 * 4xx other than 408. A 408 is a timeout, whose request may have been acted
 * on; a 2xx or 5xx never proves a write unapplied. A 401 passes here, and
 * `servedRefusal` still asks for the vendor's reviewed evidence.
 */
export function refusedStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/**
 * Refusal provenance, recorded where the answer is observed: the request was
 * served a refusing status (`refusedStatus`) and the mapper failed on it. An
 * error code alone is never this evidence.
 */
export function vendorRefusal<T>(error: T, request: ProviderRequest): T {
  if (error !== null && typeof error === "object" && refusedStatus(request.status)) {
    refusals.set(error, request);
    if (request.status === 401 && authorizationFailure(error) && !unauthorizedAnswers.has(request))
      unauthorizedAnswers.set(request, error);
  }
  return error;
}

/** An authorization verdict, the kind that keeps the `authorize_connector` handoff. */
export function authorizationFailure(error: unknown): error is ConnectorCallError {
  return (
    error instanceof ConnectorCallError &&
    (error.code === "auth_required" || error.code === "downstream_oauth_required")
  );
}

/**
 * The authorization verdict `request`'s own 401 answer was mapped to, as
 * {@link vendorRefusal} recorded it. Undefined when nothing mapped that
 * answer, such as a body past the ceiling.
 */
export function unauthorizedAnswer(request: ProviderRequest): ConnectorCallError | undefined {
  return unauthorizedAnswers.get(request);
}

/**
 * A renewal answered `request`'s own 401 (a refresh, a login, a fresh token
 * minted) with `fresh`, a credential other than `sent`, the one the request
 * carried: that 401 no longer needs the operator's recovery (Q8). It names
 * the one request it answered and never marks another. A renewal that hands
 * back the credential the request already sent (an earlier recovery reused)
 * renewed nothing.
 */
export function renewedAfterUnauthorized(request: ProviderRequest | undefined, sent: string, fresh: string): void {
  if (request?.status === 401 && fresh !== sent && !request.renewed) recordRequestField(request, "renewed", true);
}

export function refusalRequest(error: unknown): ProviderRequest | undefined {
  return error !== null && typeof error === "object" ? refusals.get(error) : undefined;
}

export function knownProviderFailure<T>(error: T): T {
  if (error !== null && typeof error === "object") knownFailures.add(error);
  return error;
}

export function isKnownProviderFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && knownFailures.has(error);
}

/** Withdraw a verdict that does not hold for the call that reports it. */
export function forgetProviderFailure(error: object): void {
  knownFailures.delete(error);
  refusals.delete(error);
}

/** Preserve internal verdicts and resend advice through redaction and provider recovery wording. */
export function carryProviderFailure<T>(from: unknown, to: T): T {
  if (to !== null && typeof to === "object") {
    const refusal = refusalRequest(from);
    if (refusal) refusals.set(to, refusal);
    if (isKnownProviderFailure(from)) knownFailures.add(to);
    if (explainsUnauthorized(from)) explainedUnauthorized.add(to);
    if (isSettledWrite(from)) settledWrites.add(to);
    carryResendAdvice(from, to);
  }
  return to;
}

/** Mark a verdict that already accounts for a write's 401 in its own words. */
export function explainedUnauthorizedVerdict<T>(error: T): T {
  if (error !== null && typeof error === "object") explainedUnauthorized.add(error);
  return error;
}

export function explainsUnauthorized(error: unknown): boolean {
  return error !== null && typeof error === "object" && explainedUnauthorized.has(error);
}

/** Mark a verdict the Q8 decision made, final for every step after it. */
export function settledWrite<T>(error: T): T {
  if (error !== null && typeof error === "object") settledWrites.add(error);
  return error;
}

export function isSettledWrite(error: unknown): boolean {
  return error !== null && typeof error === "object" && settledWrites.has(error);
}
