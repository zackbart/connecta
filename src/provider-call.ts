// One API call's request ledger and private failure provenance. The symbol is
// copied by deriveContext, while each api() entry installs a fresh ledger even
// if a direct caller reuses its context concurrently. No request facts escape
// into the agent envelope or operator records.
import { contextKey, deriveContext } from "./derived-context.js";
import { carryResendAdvice, ConnectorCallError } from "./errors.js";
import { followRedactedCopies } from "./redaction-identity.js";
import type { Connector, ConnectorContext } from "./types.js";

export interface ProviderRequest {
  dispatched: boolean;
  status?: number;
  auxiliary: boolean;
  provider: string;
  /** The HTTP method it was sent with, when its channel knows it. */
  method?: string;
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
   * longer needs the operator's recovery, so it no longer decides the call's
   * verdict (Q8).
   */
  renewed?: true;
}
interface ProviderCall {
  requests: ProviderRequest[];
  /** The handler settled: its outcome may be reported, so nothing more leaves. */
  closed: boolean;
  /** The calls of api() boundaries entered beneath this one's handler. */
  nested: ProviderCall[];
  /** The call whose handler entered this one; undefined for the outermost. */
  parent?: ProviderCall;
}
const CALL = Symbol("provider call");
type CallContext = ConnectorContext & { [CALL]?: ProviderCall };
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
type CallTool = Connector["callTool"];
interface Boundary {
  /** The api() or remoteMcp() object whose own code enters the logical call. */
  boundary: object;
  own: CallTool;
}
const boundaries = new WeakMap<object, Boundary>();
const delegators = new WeakMap<object, CallTool>();

// One invocation's logical call: the connector object and the `callTool`
// function it invoked, and the object of every boundary entered beneath it,
// each captured when it ran, never read back from a mutable property. Keyed
// like every call side table so a derived context shares it.
interface LogicalCall {
  target: object;
  entered: CallTool;
  boundaries: object[];
  /** Every resource request dispatched under it, once per dispatch, from any ledger. */
  sent: ProviderRequest[];
}
const logicalCalls = new WeakMap<object, LogicalCall>();

export function providerCallContext(ctx: ConnectorContext): ConnectorContext {
  const parent = (ctx as CallContext)[CALL];
  const call: ProviderCall = { requests: [], closed: false, nested: [], ...(parent ? { parent } : {}) };
  parent?.nested.push(call);
  return deriveContext<CallContext>(ctx, { [CALL]: call });
}

/** Whether `ctx`'s call was entered by another api() boundary's handler. */
export function nestedProviderCall(ctx: ConnectorContext): boolean {
  return (ctx as CallContext)[CALL]?.parent !== undefined;
}

export function providerRequests(ctx: ConnectorContext): readonly ProviderRequest[] | undefined {
  return (ctx as CallContext)[CALL]?.requests;
}

/**
 * Every request the ledgers of api() boundaries nested beneath `ctx`'s call
 * recorded, at any depth: an inner call's 401 still decides the outer's
 * write (Q8), whatever the outer handler made of the inner's failure.
 */
export function nestedProviderRequests(ctx: ConnectorContext): ProviderRequest[] {
  const found: ProviderRequest[] = [];
  const visit = (call: ProviderCall) => {
    for (const inner of call.nested) {
      found.push(...inner.requests);
      visit(inner);
    }
  };
  const call = (ctx as CallContext)[CALL];
  if (call) visit(call);
  return found;
}

/**
 * End the call's ledger before its outcome is decided. A request still in
 * flight already counts as dispatched; one that has not left yet (a sibling
 * still reading its credential, say) is refused by {@link dispatchProviderRequest}
 * and never leaves after the failure is reported.
 */
export function closeProviderCall(ctx: ConnectorContext): void {
  const call = (ctx as CallContext)[CALL];
  if (call) call.closed = true;
}

/**
 * Refuse a resource request whose call has ended, before credential reads
 * and again immediately before it is sent. Auxiliary requests (token mints,
 * lookups) cannot perform the write and may be shared with other calls.
 */
export function assertProviderCallOpen(ctx: ConnectorContext, provider: string, auxiliary: boolean): void {
  if (auxiliary || (ctx as CallContext)[CALL]?.closed !== true) return;
  throw new ConnectorCallError(
    "connector_call_failed",
    `This ${provider} request belongs to a call that has already ended, so it was not sent.`,
    { retryable: false },
  );
}

/** Record that a request leaves now; synchronous with the send that follows it. */
export function dispatchProviderRequest(ctx: ConnectorContext, request: ProviderRequest): void {
  assertProviderCallOpen(ctx, request.provider, request.auxiliary);
  request.dispatched = true;
  if (!request.auxiliary) logicalCalls.get(contextKey(ctx))?.sent.push(request);
}

export function providerRequest(
  ctx: ConnectorContext,
  auxiliary: boolean,
  provider: string,
  sent: { method?: string; key?: string } = {},
): ProviderRequest {
  const request: ProviderRequest = { dispatched: false, auxiliary, provider, ...sent };
  (ctx as CallContext)[CALL]?.requests.push(request);
  return request;
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
  const boundary = boundaries.get(base);
  const delegator = delegators.get(base);
  if (boundary) boundaries.set(alias, boundary);
  if (delegator) delegators.set(alias, delegator);
}

/**
 * The invocation opens one logical call on the context it hands a connector,
 * naming the exact object and `callTool` function it is about to invoke.
 */
export function openLogicalCall(ctx: ConnectorContext, target: object, entered: CallTool): void {
  logicalCalls.set(contextKey(ctx), { target, entered, boundaries: [], sent: [] });
}

/**
 * An api() or remoteMcp() boundary was entered under `ctx`'s logical call.
 * `boundary` is the object it was built as, from its own closure, never `this`.
 */
export function enterProviderBoundary(ctx: ConnectorContext, boundary: object): void {
  logicalCalls.get(contextKey(ctx))?.boundaries.push(boundary);
}

/**
 * Whether a failure's known mark holds for its whole logical call (INV-9).
 * A boundary marks a write known only when every request it dispatched is
 * proven unapplied, so the mark stands when that boundary owned the call
 * ({@link ownsLogicalCall}) and at most one boundary was entered. A wrapper
 * that composed several calls, or could send around them, never inherits an
 * inner verdict.
 */
export function knownForLogicalCall(ctx: object, error: unknown): boolean {
  const call = logicalCalls.get(contextKey(ctx));
  return call !== undefined && isKnownProviderFailure(error) && call.boundaries.length <= 1 && ownsLogicalCall(call);
}

/**
 * Whether reusing `key` with the exact original arguments cannot repeat any
 * write of `ctx`'s logical call, the one basis for key-reuse advice (INV-9).
 * It holds only when the call entered exactly one boundary, which owned it
 * and tracks every request, and sent exactly one write, carrying `key`. A
 * request counts as a read only by its recorded GET or HEAD
 * ({@link readMethod}). An inner request's key never speaks for a composite,
 * a wrapper, a second write, or an earlier unrelated request.
 */
export function keyProtectsLogicalCall(ctx: object | undefined, key: string | undefined): boolean {
  const call = ctx ? logicalCalls.get(contextKey(ctx)) : undefined;
  const [boundary, ...others] = call?.boundaries ?? [];
  if (!call || key === undefined || boundary === undefined || others.length > 0 || !tracksRequests(boundary))
    return false;
  const writes = call.sent.filter((request) => !readMethod(request.method));
  return ownsLogicalCall(call) && writes.length === 1 && writes[0]?.key === key;
}

/**
 * The call's invoked object owns it: a boundary object invoked with the
 * function recorded for it at construction, and that boundary was the one
 * entered; or a declared delegator object, likewise. Only identities captured
 * at construction, dispatch and entry decide it, so a wrapper that reassigns
 * `callTool` mid-call, or a copy that shares a boundary's function, cannot
 * borrow its standing.
 */
function ownsLogicalCall(call: LogicalCall): boolean {
  const boundary = boundaries.get(call.target);
  return (
    (boundary?.own === call.entered && boundary.boundary === call.boundaries[0]) ||
    delegators.get(call.target) === call.entered
  );
}

/** The shared read classification of an HTTP method: GET or HEAD, nothing unrecorded. */
export function readMethod(method: string | undefined): boolean {
  const normalized = method?.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

// OAuth does credential checks before the actual send. Associate a guarded
// request with its init so the grant records that same request at dispatch,
// rather than counting the wrapper and resource as two requests.
const requestInits = new WeakMap<RequestInit, ProviderRequest>();
export function bindProviderRequest(init: RequestInit, request: ProviderRequest): void {
  requestInits.set(init, request);
}
export function boundProviderRequest(init: RequestInit): ProviderRequest | undefined {
  return requestInits.get(init);
}

export function providerFetch(
  ctx: ConnectorContext,
  provider: string,
  auxiliary: boolean,
  send: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const request = providerRequest(ctx, auxiliary, provider, { method });
    dispatchProviderRequest(ctx, request);
    const response = await send(input, init);
    request.status = response.status;
    return response;
  };
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
  if (request?.status === 401 && fresh !== sent) request.renewed = true;
}

/** Whether an invocation opened the logical call `ctx` belongs to; it then settles Q8 itself. */
export function inLogicalCall(ctx: object): boolean {
  return logicalCalls.has(contextKey(ctx));
}

/**
 * Every resource request dispatched under `ctx`'s logical call, from any
 * ledger, nested ones included; undefined outside one.
 */
export function logicalCallRequests(ctx: object | undefined): readonly ProviderRequest[] | undefined {
  return ctx ? logicalCalls.get(contextKey(ctx))?.sent : undefined;
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
