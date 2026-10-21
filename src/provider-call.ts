// One API call's request ledger and private failure provenance. The symbol is
// copied by deriveContext, while each api() entry installs a fresh ledger even
// if a direct caller reuses its context concurrently. No request facts escape
// into the agent envelope or operator records.
import { contextKey, deriveContext } from "./derived-context.js";
import { carryResendAdvice, ConnectorCallError } from "./errors.js";
import type { Connector, ConnectorContext } from "./types.js";

export interface ProviderRequest {
  dispatched: boolean;
  status?: number;
  auxiliary: boolean;
  provider: string;
  /** A genuine idempotency key the vendor honors was sent with it; nothing else. */
  repeatable: boolean;
}
interface ProviderCall {
  requests: ProviderRequest[];
  /** The handler settled: its outcome may be reported, so nothing more leaves. */
  closed: boolean;
}
const CALL = Symbol("provider call");
type CallContext = ConnectorContext & { [CALL]?: ProviderCall };
const refusals = new WeakMap<object, ProviderRequest>();
const knownFailures = new WeakSet<object>();
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
}
const logicalCalls = new WeakMap<object, LogicalCall>();

export function providerCallContext(ctx: ConnectorContext): ConnectorContext {
  return deriveContext<CallContext>(ctx, { [CALL]: { requests: [], closed: false } });
}

export function providerRequests(ctx: ConnectorContext): readonly ProviderRequest[] | undefined {
  return (ctx as CallContext)[CALL]?.requests;
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
}

export function providerRequest(
  ctx: ConnectorContext,
  auxiliary: boolean,
  provider: string,
  repeatable = false,
): ProviderRequest {
  const request: ProviderRequest = { dispatched: false, auxiliary, provider, repeatable };
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
  logicalCalls.set(contextKey(ctx), { target, entered, boundaries: [] });
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
 * proven unapplied, so the mark stands when that boundary owned the call:
 * the invocation invoked a boundary object with the function recorded for
 * it at construction, and that boundary was the one entered; or a declared
 * delegator object, likewise, entered at most one boundary. Only identities
 * captured at construction, dispatch and entry decide it, so a wrapper that
 * reassigns `callTool` mid-call, or a copy that shares a boundary's
 * function, cannot borrow its standing. A wrapper that composed several
 * calls, or could send around them, never inherits an inner verdict.
 */
export function knownForLogicalCall(ctx: object, error: unknown): boolean {
  const call = logicalCalls.get(contextKey(ctx));
  if (!call || !isKnownProviderFailure(error) || call.boundaries.length > 1) return false;
  const boundary = boundaries.get(call.target);
  return (
    (boundary?.own === call.entered && boundary.boundary === call.boundaries[0]) ||
    delegators.get(call.target) === call.entered
  );
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
    const request = providerRequest(ctx, auxiliary, provider);
    dispatchProviderRequest(ctx, request);
    const response = await send(input, init);
    request.status = response.status;
    return response;
  };
}

/**
 * Whether a served HTTP status says the request was refused, not applied: a
 * 4xx other than 408. A 408 is a timeout, whose request may have been acted
 * on; a 2xx or 5xx never proves a write unapplied.
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
  if (error !== null && typeof error === "object" && refusedStatus(request.status)) refusals.set(error, request);
  return error;
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
    carryResendAdvice(from, to);
  }
  return to;
}
