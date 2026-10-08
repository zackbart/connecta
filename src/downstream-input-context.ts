import { ConnectorCallError } from "./errors.js";

/** Host-only MRTR material. This module must stay safe in executor bundles. */
export interface DownstreamInputResult {
  resultType: "input_required";
  inputRequests?: Record<string, unknown>;
  requestState?: string;
}

export function isDownstreamInputResult(value: unknown): value is DownstreamInputResult {
  return value !== null && typeof value === "object" && "resultType" in value && value.resultType === "input_required";
}

export interface InputContinuation {
  requestState?: string;
  inputResponses: Record<string, unknown>;
}
interface ContinuationTarget {
  connector: string;
  address: string;
  input: InputContinuation;
}
export interface InputCapabilities {
  elicitation?: { form?: Record<string, never>; url?: Record<string, never> };
}
const continuations = new WeakMap<object, ContinuationTarget>();
const capabilities = new WeakMap<object, InputCapabilities>();

export function bindDownstreamCapabilities(scope: object, declared: InputCapabilities): void {
  capabilities.set(scope, declared);
}

/** Only the relayable declarations travel to the downstream SDK, never grants. */
export function downstreamInputCapabilities(scope: object): InputCapabilities {
  return capabilities.get(scope) ?? {};
}

export function bindDownstreamContinuation(scope: object, target: ContinuationTarget): void {
  continuations.set(scope, target);
}

export function clearDownstreamContinuation(scope: object): void {
  continuations.delete(scope);
}

/** The host binds one verified target before invocation constructs its context. */
export function downstreamContinuation(scope: object, connector: string, address: string): InputContinuation | undefined {
  const continuation = continuations.get(scope);
  if (!continuation) return undefined;
  if (continuation.connector !== connector || continuation.address !== address) {
    throw new ConnectorCallError("input_required_invalid", "The resolved target no longer matches this continuation.");
  }
  return continuation.input;
}
