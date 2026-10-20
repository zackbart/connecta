// One API call's request ledger and private failure provenance. The symbol is
// copied by deriveContext, while each api() entry installs a fresh ledger even
// if a direct caller reuses its context concurrently. No request facts escape
// into the agent envelope or operator records.
import { deriveContext } from "./derived-context.js";
import type { ConnectorContext } from "./types.js";

export interface ProviderRequest {
  dispatched: boolean;
  answered: boolean;
  status?: number;
  auxiliary: boolean;
  provider: string;
  repeatable: boolean;
  neverConnected?: boolean;
}
const CALL = Symbol("provider call");
type CallContext = ConnectorContext & { [CALL]?: ProviderRequest[] };
const refusals = new WeakMap<object, ProviderRequest>();
const knownFailures = new WeakSet<object>();

export function providerCallContext(ctx: ConnectorContext): ConnectorContext {
  return deriveContext<CallContext>(ctx, { [CALL]: [] });
}

export function providerRequests(ctx: ConnectorContext): readonly ProviderRequest[] | undefined {
  return (ctx as CallContext)[CALL];
}

export function providerRequest(
  ctx: ConnectorContext,
  auxiliary: boolean,
  provider: string,
  repeatable = false,
): ProviderRequest {
  const request: ProviderRequest = { dispatched: false, answered: false, auxiliary, provider, repeatable };
  (ctx as CallContext)[CALL]?.push(request);
  return request;
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
    request.dispatched = true;
    const response = await send(input, init);
    request.answered = true;
    request.status = response.status;
    return response;
  };
}

/** Only the mapper's own 4xx answer supplies refusal provenance. */
export function vendorRefusal<T>(error: T, request: ProviderRequest): T {
  if (
    error !== null &&
    typeof error === "object" &&
    request.status !== undefined &&
    request.status >= 400 &&
    request.status < 500
  )
    refusals.set(error, request);
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

/** Preserve internal verdicts through redaction and provider recovery wording. */
export function carryProviderFailure<T>(from: unknown, to: T): T {
  if (to !== null && typeof to === "object") {
    const refusal = refusalRequest(from);
    if (refusal) refusals.set(to, refusal);
    if (isKnownProviderFailure(from)) knownFailures.add(to);
  }
  return to;
}
