// One API call's request ledger and private failure provenance. The symbol is
// copied by deriveContext, while each api() entry installs a fresh ledger even
// if a direct caller reuses its context concurrently. No request facts escape
// into the agent envelope or operator records.
import { contextKey, deriveContext } from "./derived-context.js";
import { ConnectorCallError } from "./errors.js";
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
const advice = new WeakMap<object, string>();
const trackedConnectors = new WeakSet<object>();
const delegatingCalls = new WeakSet<object>();

// One invocation's logical call: the connector it entered and every api() or
// remoteMcp() boundary entered beneath it, keyed like every call side table
// so a derived context shares it.
interface LogicalCall {
  connector: Connector;
  boundaries: Connector[];
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
 * it (GitHub). Only then may that boundary's verdict stand for the call.
 */
export function delegatesEachCall<T extends Connector>(connector: T): T {
  delegatingCalls.add(connector.callTool);
  return connector;
}

/** The invocation opens one logical call on the context it hands `connector`. */
export function openLogicalCall(ctx: ConnectorContext, connector: Connector): void {
  logicalCalls.set(contextKey(ctx), { connector, boundaries: [] });
}

/** An api() or remoteMcp() `callTool` was entered under `ctx`'s logical call. */
export function enterProviderBoundary(ctx: ConnectorContext, boundary: Connector): void {
  logicalCalls.get(contextKey(ctx))?.boundaries.push(boundary);
}

/**
 * Whether a failure's known mark holds for its whole logical call (INV-9).
 * A boundary marks a write known only when every request it dispatched is
 * proven unapplied, so the mark stands when that boundary owned the call:
 * the invocation entered the boundary's own `callTool`, or a declared
 * delegator's, and no other boundary was entered. A wrapper that composed
 * several calls, or could send around them, never inherits an inner verdict.
 */
export function knownForLogicalCall(ctx: object, error: unknown): boolean {
  const call = logicalCalls.get(contextKey(ctx));
  if (!call || !isKnownProviderFailure(error) || call.boundaries.length > 1) return false;
  const entered = call.connector.callTool;
  return call.boundaries[0]?.callTool === entered || delegatingCalls.has(entered);
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

/**
 * Name the advice to send again inside a failure's message (a rate limit's
 * "back off before retrying", an overload's "retry after the window"). It
 * holds for a read and a known refusal. Every verdict that makes a write's
 * outcome unknown removes it through {@link withoutResendAdvice}, so no such
 * advice reaches a write that may have applied (INV-9).
 */
export function resendAdvice<T extends Error>(error: T, text: string): T {
  advice.set(error, text);
  return error;
}

/** `message` without the resend advice recorded on `from`. */
export function withoutResendAdvice(message: string, from: unknown): string {
  const text = from !== null && typeof from === "object" ? advice.get(from) : undefined;
  return text === undefined ? message : message.replace(text, "");
}

/** Withdraw a verdict that does not hold for the call that reports it. */
export function forgetProviderFailure(error: object): void {
  knownFailures.delete(error);
  refusals.delete(error);
}

/** Preserve internal verdicts through redaction and provider recovery wording. */
export function carryProviderFailure<T>(from: unknown, to: T): T {
  if (to !== null && typeof to === "object") {
    const refusal = refusalRequest(from);
    if (refusal) refusals.set(to, refusal);
    if (isKnownProviderFailure(from)) knownFailures.add(to);
    const text = from !== null && typeof from === "object" ? advice.get(from) : undefined;
    if (text !== undefined && !advice.has(to)) advice.set(to, text);
  }
  return to;
}
