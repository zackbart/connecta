import {
  boundaryFor,
  delegatorFor,
  recordRequestField,
  recordProviderResponse,
  tracksRequests,
  isKnownProviderFailure,
  type ProviderRequest,
  type CallTool,
} from "./provider-call-facts.js";
// One API call's request ledger in call services, and private failure
// provenance. Each api() entry installs fresh services even if a direct caller
// reuses its context concurrently. No request facts escape into agent or
// operator records.
import {
  Classification,
  ProviderLedger,
  LogicalLedger,
  recordedService,
  requestClosed,
  viewClosed,
  setViewService,
  callFromContext,
  contextView,
  viewLease,
  settleOnClose,
} from "./runtime/call.js";
import { callClassification } from "./call-classification.js";
import { ConnectorCallError } from "./errors.js";
import type { ConnectorContext } from "./types.js";

export interface ProviderCall {
  requests: ProviderRequest[];
  classification?: "read" | "write" | undefined;
  /** The handler settled: its outcome may be reported, so nothing more leaves. */
  closed: boolean;
  /** The calls of api() boundaries entered beneath this one's handler. */
  nested: ProviderCall[];
  /** The call whose handler entered this one; undefined for the outermost. */
  parent?: ProviderCall;
}
// One invocation's logical call: the connector object and the `callTool`
// function it invoked, and the object of every boundary entered beneath it,
// each captured when it ran, never read back from a mutable property. The
// LogicalLedger service shares it with derived views.
export interface LogicalCall {
  target: object;
  entered: CallTool;
  boundaries: object[];
  /** Every resource request dispatched under it, once per dispatch, from any ledger. */
  sent: ProviderRequest[];
}

export function providerCallContext(ctx: ConnectorContext, classification?: "read" | "write"): ConnectorContext {
  const parent = recordedService(ctx, ProviderLedger);
  const call: ProviderCall = { requests: [], classification, closed: false, nested: [], ...(parent ? { parent } : {}) };
  parent?.nested.push(call);
  let view: ConnectorContext;
  const lease = callFromContext(ctx, classification ?? callClassification(ctx) ?? "write", {
    providerLedger: call,
    ledger: {
      open: ({ auxiliary, provider, method, key }) =>
        providerRequest(view, auxiliary, provider, { method, ...(key === undefined ? {} : { key }) }),
      dispatch: (request, headers, method) => dispatchProviderRequest(view, request, headers, method),
    },
  });
  view = contextView(lease, ctx);
  return view;
}

/** Whether `ctx`'s call was entered by another api() boundary's handler. */
export function nestedProviderCall(ctx: ConnectorContext): boolean {
  return recordedService(ctx, ProviderLedger)?.parent !== undefined;
}

export function providerRequests(ctx: ConnectorContext): readonly ProviderRequest[] | undefined {
  return recordedService(ctx, ProviderLedger)?.requests;
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
  const call = recordedService(ctx, ProviderLedger);
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
  const call = recordedService(ctx, ProviderLedger);
  if (call) {
    const close = (current: ProviderCall) => {
      current.closed = true;
      for (const child of current.nested) close(child);
    };
    close(call);
  }
  viewLease(ctx)?.close();
}

/**
 * Refuse every request after its request scope ends, before credential reads
 * and again immediately before dispatch. Resource requests also require an
 * open call. Auxiliary requests (token mints, lookups) may outlive that call,
 * but never their request.
 */
export function assertProviderCallOpen(ctx: ConnectorContext, provider: string, auxiliary: boolean): void {
  if (requestClosed(ctx))
    throw new ConnectorCallError(
      "connector_call_failed",
      `This ${provider} request belongs to a request that has already ended, so it was not sent.`,
      { retryable: false },
    );
  if (auxiliary || (recordedService(ctx, ProviderLedger)?.closed !== true && !viewClosed(ctx))) return;
  throw new ConnectorCallError(
    "connector_call_failed",
    `This ${provider} request belongs to a call that has already ended, so it was not sent.`,
    { retryable: false },
  );
}

/** Record that a request leaves now; synchronous with the send that follows it. */
export function dispatchProviderRequest(
  ctx: ConnectorContext | undefined,
  request: ProviderRequest,
  headers?: HeadersInit,
  method = request.method,
): void {
  if (ctx) assertProviderCallOpen(ctx, request.provider, request.auxiliary);
  if (request.dispatched) throw new Error("Provider request already dispatched.");
  if (hasMethodOverride(headers)) request.classification = "write";
  recordRequestField(request, "method", method);
  recordRequestField(request, "dispatched", true);
  if (ctx && !request.auxiliary) recordedService(ctx, LogicalLedger)?.sent.push(request);
}

// Only a fetch that records physical sends may accept an unsent handoff.
const recordingFetches = new WeakSet<object>();
export function recordingFetch<T extends object>(send: T): T {
  recordingFetches.add(send);
  return send;
}
export function isRecordingFetch(send: object | undefined): boolean {
  return send !== undefined && recordingFetches.has(send);
}
const handoffs = new WeakMap<RequestInit, ProviderRequest>();
export function handoffProviderRequest(init: RequestInit, request: ProviderRequest): void {
  if (request.dispatched) throw new Error("Provider request already dispatched.");
  handoffs.set(init, request);
}
export function takeProviderHandoff(init: RequestInit): ProviderRequest | undefined {
  // Consume before any await: a read replay or another call cannot take it.
  const request = handoffs.get(init);
  handoffs.delete(init);
  return request?.dispatched ? undefined : request;
}
// Observation only: a mapper must name the physical reply it actually received.
const responseRequests = new WeakMap<object, { request: ProviderRequest; owner: ProviderRequest }>();
export function bindProviderResponse(
  response: object,
  request: ProviderRequest,
  owner: ProviderRequest | undefined,
): void {
  if (owner) responseRequests.set(response, { request, owner });
}
export function responseProviderRequest(response: object, owner: ProviderRequest): ProviderRequest | undefined {
  const answer = responseRequests.get(response);
  return answer?.owner === owner ? answer.request : undefined;
}

/** Override presence invalidates read evidence, whatever value the header carries. */
export function hasMethodOverride(headers: HeadersInit | undefined): boolean {
  const sent = new Headers(headers);
  return ["x-http-method-override", "x-http-method", "x-method-override"].some((name) => sent.has(name));
}

export function providerRequest(
  ctx: ConnectorContext,
  auxiliary: boolean,
  provider: string,
  sent: { method?: string; key?: string; classification?: "read" | "write" } = {},
): ProviderRequest {
  const request: ProviderRequest = {
    dispatched: false,
    auxiliary,
    provider,
    classification:
      recordedService(ctx, ProviderLedger)?.classification ??
      recordedService(ctx, Classification) ??
      callClassification(ctx),
    ...sent,
  };
  recordedService(ctx, ProviderLedger)?.requests.push(request);
  return request;
}

/**
 * The invocation opens one logical call on the context it hands a connector,
 * naming the exact object and `callTool` function it is about to invoke.
 */
export function openLogicalCall(ctx: ConnectorContext, target: object, entered: CallTool): LogicalCall {
  const call: LogicalCall = { target, entered, boundaries: [], sent: [] };
  setViewService(ctx, LogicalLedger, call);
  return call;
}

/**
 * An api() or remoteMcp() boundary was entered under `ctx`'s logical call.
 * `boundary` is the object it was built as, from its own closure, never `this`.
 */
export function enterProviderBoundary(ctx: ConnectorContext, boundary: object): void {
  recordedService(ctx, LogicalLedger)?.boundaries.push(boundary);
}

/**
 * Whether a failure's known mark holds for its whole logical call (INV-9).
 * A boundary marks a write known only when every request it dispatched is
 * proven unapplied, so the mark stands when that boundary owned the call
 * ({@link ownsLogicalCall}) and at most one boundary was entered. A wrapper
 * that composed several calls, or could send around them, never inherits an
 * inner verdict.
 */
export function knownCallFailure(call: LogicalCall | undefined, error: unknown): boolean {
  return call !== undefined && isKnownProviderFailure(error) && call.boundaries.length <= 1 && ownsLogicalCall(call);
}

/**
 * Whether reusing `key` with the exact original arguments cannot repeat any
 * write of `ctx`'s logical call, the one basis for key-reuse advice (INV-9).
 * It holds only when the call entered exactly one boundary, which owned it
 * and tracks every request, and sent exactly one write, carrying `key`. A
 * request counts as a read only with positive classification and a recorded
 * GET or HEAD ({@link readRequest}). An inner request's key never speaks for a composite,
 * a wrapper, a second write, or an earlier unrelated request.
 */
export function keyProtectsCall(call: LogicalCall | undefined, key: string | undefined): boolean {
  const [boundary, ...others] = call?.boundaries ?? [];
  if (!call || key === undefined || boundary === undefined || others.length > 0 || !tracksRequests(boundary))
    return false;
  const writes = call.sent.filter((request) => !readRequest(request));
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
  const boundary = boundaryFor(call.target);
  return (
    (boundary?.own === call.entered && boundary.boundary === call.boundaries[0]) ||
    delegatorFor(call.target) === call.entered
  );
}

/** Positive read evidence, with GET/HEAD as #902's additional conservative bound. */
export function readRequest(request: ProviderRequest): boolean {
  const method = request.method?.toUpperCase();
  return request.classification === "read" && (method === "GET" || method === "HEAD");
}

// A guarded send's identity, for its transport to identify the one request
// whose credential it renews (Google). Never reuse this entry for a new send.
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
  return (input, init) =>
    settleOnClose(
      ctx,
      async (signal) => {
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const request = providerRequest(ctx, auxiliary, provider, { method });
        dispatchProviderRequest(ctx, request, init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const signals = [signal, init?.signal ?? (input instanceof Request ? input.signal : undefined)].filter(
          (signal): signal is AbortSignal => signal !== undefined && signal !== null,
        );
        const sent = signals.length ? { ...init, signal: AbortSignal.any(signals) } : init;
        const response = await send(input, sent);
        recordProviderResponse(request, response.status);
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw signal.reason;
        }
        return response;
      },
      auxiliary,
    );
}

/** Whether an invocation opened the logical call `ctx` belongs to; it then settles Q8 itself. */
export function inLogicalCall(ctx: object): boolean {
  return recordedService(ctx, LogicalLedger) !== undefined;
}

/**
 * Every resource request dispatched under `ctx`'s logical call, from any
 * ledger, nested ones included; undefined outside one.
 */
export function logicalCallRequests(ctx: object | undefined): readonly ProviderRequest[] | undefined {
  return ctx ? recordedService(ctx, LogicalLedger)?.sent : undefined;
}

export {
  recordProviderResponse,
  tracksEveryRequest,
  tracksRequests,
  delegatesEachCall,
  providerBoundary,
  refusedStatus,
  vendorRefusal,
  authorizationFailure,
  unauthorizedAnswer,
  renewedAfterUnauthorized,
  refusalRequest,
  knownProviderFailure,
  isKnownProviderFailure,
  forgetProviderFailure,
  explainedUnauthorizedVerdict,
  explainsUnauthorized,
  settledWrite,
  isSettledWrite,
  type ProviderRequest,
} from "./provider-call-facts.js";
