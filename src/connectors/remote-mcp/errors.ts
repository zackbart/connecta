// Error mapping at the MCP boundary: what of an SDK, runtime or downstream
// error survives, how it is classified, and the connector's own error classes.
import { routePhrases } from "../../agent-routes.js";
import { authFlow, authCall, authMethod } from "../../auth/native.js";
import {
  AuthorizationServerMismatchError,
  InsecureTokenEndpointError,
  InsufficientScopeError,
  IssuerMismatchError,
  MissingRequiredClientCapabilityError,
  OAuthClientFlowError,
  OAuthError,
  ProtocolError,
  RegistrationRejectedError,
  ResourceNotFoundError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SseError,
  UnsupportedProtocolVersionError,
  UrlElicitationRequiredError,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { redactSentSecrets, requestSentSecrets, type SentSecrets } from "../../sent-secrets.js";
import {
  boundedEchoText,
  ConnectorCallError,
  msg,
  networkErrorCode,
  resendAdviceOf,
  unavailableCallError,
  WithheldTextError,
  withResendAdvice,
} from "../../errors.js";
import {
  attachFailureFacts,
  carryFailureFacts,
  errorLabel,
  failureRecord,
  labelErrorClass,
  OAUTH_ERROR_CODES,
} from "../../operator-record.js";
import type { ConnectorContext } from "../../types.js";
import type { OAuthStep } from "./oauth.js";
import type { RemoteMcpRuntime, RemoteMcpShared } from "./runtime.js";

/**
 * An `authorize_connector` start message for a failure: its text, which has
 * passed the MCP and OAuth boundaries, and the origin and errno connecta
 * derived for it, which a message alone would drop.
 */
/** An authorization start's failure for authorize_connector: no write's, so its advice stays. */
export function startMessage(err: unknown): string {
  const details = err instanceof ConnectorCallError ? err.details : undefined;
  const facts = [details?.host, details?.code].filter(Boolean).join(", ");
  return withResendAdvice(facts ? `${msg(err)} (${facts})` : msg(err), resendAdviceOf(err));
}

/**
 * One Promise step of an Effect program. It fails with exactly what the
 * promise rejected with, never a wrapper, because callers check the SDK's and
 * connecta's own error classes. `evaluate` takes no signal, so the step
 * allocates no AbortController.
 */
export function promised<A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return authCall(evaluate, []);
}

/** A retained cause chain must not smuggle an SDK payload past the boundary. */
export function hasSdkPayload(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof ProtocolError || current instanceof SdkError) return true;
    seen.add(current);
  }
  return false;
}

/** Cancellation can bypass an inner SDK catch and return the signal's reason. */
export function payloadFree<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return authMethod((...args: A) =>
    authFlow<R>(function* () {
      try {
        return (yield authCall(run, [...args])) as Awaited<R>;
      } catch (error) {
        throw hasSdkPayload(error) ? carryFailureFacts(error, downstreamCallError(error)) : error;
      }
    }),
  );
}

/** Both the SDK's auth signal and its classified form invalidate a live client. */
export function requiresAuthorization(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof ConnectorCallError &&
      (error.code === "auth_required" || error.code === "downstream_oauth_required"))
  );
}

/** Classify SDK/runtime facts, dropping every SDK payload and cause chain. */
export function downstreamCallError(
  error: unknown,
  httpStatus?: number,
  wait?: number,
  oauthStep?: OAuthStep,
  secrets?: SentSecrets,
): unknown {
  if (error instanceof ConnectorCallError) {
    return hasSdkPayload(error.cause) ? carryFailureFacts(error, withheldAs(error.message, error)) : error;
  }
  if (error instanceof WithheldTextError || error instanceof UnauthorizedError) return error;
  const network =
    !(error instanceof SdkError) && !(error instanceof OAuthClientFlowError) ? networkErrorCode(error) : undefined;
  if (network) {
    return network === "timeout" || network === "ETIMEDOUT" || network.endsWith("_TIMEOUT")
      ? new ConnectorCallError("timeout", "The downstream request timed out.")
      : unavailableCallError(error);
  }
  const status =
    error instanceof SdkHttpError || error instanceof RegistrationRejectedError ? error.status : httpStatus;
  if (
    error instanceof InsufficientScopeError ||
    (status === 403 && !(error instanceof RegistrationRejectedError)) ||
    (error instanceof OAuthError && ["insufficient_scope", "invalid_scope", "access_denied"].includes(error.code))
  ) {
    return new ConnectorCallError(
      "provider_permission_denied",
      "The provider denied this operation. Check the account's permissions and the tool's required access with the provider or an administrator.",
    );
  }
  // Token endpoints return typed OAuth recovery codes on HTTP 400. Other
  // OAuth steps, especially registration, keep their HTTP status verdict.
  if (
    error instanceof OAuthError &&
    OAUTH_ERROR_CODES.has(error.code) &&
    (status === undefined || oauthStep === "token request")
  ) {
    return new ConnectorCallError(
      ["invalid_client", "invalid_grant", "invalid_token", "unauthorized_client"].includes(error.code)
        ? "downstream_oauth_required"
        : error.code === "too_many_requests"
          ? "rate_limited"
          : ["server_error", "temporarily_unavailable"].includes(error.code)
            ? "unavailable"
            : "connector_call_failed",
      `OAuth failed with error ${error.code}.`,
    );
  }
  if (status !== undefined && status >= 400) {
    let message = `The downstream service answered HTTP ${status}.`;
    if (error instanceof SdkHttpError && status < 500 && typeof error.data.text === "string") {
      message = error.message;
      try {
        const body = JSON.parse(error.data.text);
        const detail = body?.message ?? body?.error?.message ?? body?.error_description;
        if (typeof detail === "string") message = detail;
      } catch {
        // Non-JSON MCP refusals retain only a bounded diagnostic.
      }
    }
    return new ConnectorCallError(
      status === 401 && !(error instanceof RegistrationRejectedError)
        ? "auth_required"
        : status === 429
          ? "rate_limited"
          : status === 408 && !(error instanceof RegistrationRejectedError)
            ? "timeout"
            : "connector_call_failed",
      boundedEchoText(secrets?.text(message) ?? message),
      {
        retryable:
          [429, 502, 503, 504].includes(status) || (status === 408 && !(error instanceof RegistrationRejectedError)),
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      },
    );
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new ConnectorCallError("timeout", "The downstream request timed out.");
  }
  // ProtocolError.data is server-chosen even when its message is allowed.
  if (error instanceof ProtocolError) {
    return new ConnectorCallError(
      error.code === -32602 ? "invalid_args" : "connector_call_failed",
      boundedEchoText(secrets?.text(error.message) ?? error.message),
    );
  }
  return new ConnectorCallError("connector_call_failed", "The downstream operation failed.");
}

/** A connection whose request scope ended while it was being made. */
export class ScopeEndedError extends Error {
  override readonly name = "ScopeEndedError";
}
labelErrorClass(ScopeEndedError, "ScopeEndedError");

/** The MCP client's transport lacks the OAuth flow seams this release is pinned against. */
export class UnboundOAuthFlowsError extends Error {
  override readonly name = "UnboundOAuthFlowsError";
}
labelErrorClass(UnboundOAuthFlowsError, "UnboundOAuthFlowsError");

// The pinned SDK's exported errors, labelled by identity for records and
// connecta's fixed text.
for (const [ctor, label] of [
  [SdkError, "SdkError"],
  [SdkHttpError, "SdkHttpError"],
  [ProtocolError, "ProtocolError"],
  [MissingRequiredClientCapabilityError, "MissingRequiredClientCapabilityError"],
  [ResourceNotFoundError, "ResourceNotFoundError"],
  [UnsupportedProtocolVersionError, "UnsupportedProtocolVersionError"],
  [UrlElicitationRequiredError, "UrlElicitationRequiredError"],
  [SseError, "SseError"],
  [OAuthError, "OAuthError"],
  [UnauthorizedError, "UnauthorizedError"],
  [OAuthClientFlowError, "OAuthClientFlowError"],
  [AuthorizationServerMismatchError, "AuthorizationServerMismatchError"],
  [InsecureTokenEndpointError, "InsecureTokenEndpointError"],
  [InsufficientScopeError, "InsufficientScopeError"],
  [IssuerMismatchError, "IssuerMismatchError"],
  [RegistrationRejectedError, "RegistrationRejectedError"],
] as const) {
  labelErrorClass(ctor, label);
}

/** The JSON-RPC error answers each transport delivered, as `code\0message`. */
const wireErrors = new WeakMap<Transport, Set<string>>();
/** Answers remembered per transport; one request scope rarely sees more. */
const MAX_WIRE_ERRORS = 64;

function wireErrorKey(code: unknown, message: unknown): string {
  return `${String(code)}\u0000${String(message)}`;
}

/**
 * Remember every JSON-RPC error response `transport` delivers, so that a
 * `ProtocolError` can be told apart as the downstream's own answer. The SDK
 * builds its local refusals (an output schema it cannot compile, a result
 * that fails it) from the same class, with its own text about what the
 * downstream sent; only one whose code and message arrived on the wire is
 * the answer. Installed before `Client.connect`, whose protocol calls the
 * `onmessage` it finds there ahead of its own for every message, and whose
 * version probe restores it when the probe is done.
 */
/** The JSON-RPC error a response body is, when it is one. */
export function jsonRpcErrorBody(text: unknown): { code: number; data?: unknown } | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const message = JSON.parse(text) as { jsonrpc?: unknown; error?: { code?: unknown } } | null;
    if (message?.jsonrpc === "2.0" && Number.isInteger(message.error?.code))
      return message.error as { code: number; data?: unknown };
  } catch {}
  return undefined;
}

/**
 * Whether a 400's recognized modern error leaves a modern verdict usable.
 * `HeaderMismatch` (-32020) and `MissingRequiredClientCapability` (-32021)
 * concern the request alone. `UnsupportedProtocolVersion` (-32022) keeps it
 * only while its `supported` list, the versions the server now accepts, still
 * names the version the request selected; a missing, malformed or other list
 * ends the verdict. Anything else is a legacy refusal.
 */
export function keepsModernVerdict(
  error: { code: number; data?: unknown } | undefined,
  selected: string | null,
): boolean {
  if (error?.code === -32020 || error?.code === -32021) return true;
  if (error?.code !== -32022 || selected === null) return false;
  const supported = (error.data as { supported?: unknown } | null | undefined)?.supported;
  return (
    Array.isArray(supported) &&
    supported.length <= 64 &&
    supported.every((version) => typeof version === "string") &&
    supported.includes(selected)
  );
}

/** HTTP refusals with their own accounting: authorization, scope and throttling. */
export const AUTH_OR_THROTTLE = [401, 403, 429];

/**
 * A bounded clone of an error answer's body, read before the SDK reads the
 * original: `""` when longer than the bound, `undefined` for an event stream,
 * an unreadable body, or a read one of `signals` ended. An abort cancels the
 * clone's reader at once, so no read outlives the request or its scope (INV-7).
 */
export async function errorBodyText(
  response: Response,
  signals: readonly (AbortSignal | undefined)[],
): Promise<string | undefined> {
  if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return undefined;
  const reader = response.clone().body?.getReader();
  const stop = () => void reader?.cancel().catch(() => {});
  const ended = () => signals.some((signal) => signal?.aborted);
  for (const signal of signals) signal?.addEventListener("abort", stop, { once: true });
  try {
    const decoder = new TextDecoder();
    let text = "";
    for (let bytes = 0; reader && !ended();) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BODY_BYTES) {
        stop();
        return "";
      }
      text += decoder.decode(value, { stream: true });
    }
    if (ended()) {
      stop();
      return undefined;
    }
    return text + decoder.decode();
  } catch {
    stop();
    return undefined;
  } finally {
    for (const signal of signals) signal?.removeEventListener("abort", stop);
  }
}
const MAX_ERROR_BODY_BYTES = 16_384;

export function recordWireErrors(transport: Transport, catalogChanged: () => void): void {
  const seen = new Set<string>();
  wireErrors.set(transport, seen);
  transport.onmessage = (message) => {
    // The public transport observer runs before SDK 2.3.1's delete-based
    // eviction. Ordinary opposite-scope cleanup never rotates this fence.
    if (
      isJSONRPCNotification(message) &&
      (message.method === "notifications/tools/list_changed" ||
        message.method === "notifications/resources/list_changed")
    )
      catalogChanged();
    if (isJSONRPCErrorResponse(message) && seen.size < MAX_WIRE_ERRORS) {
      seen.add(wireErrorKey(message.error.code, message.error.message));
    }
  };
}

/**
 * Whether an error leaving the SDK may keep its own text. The boundary is an
 * allow-list: a JSON-RPC error the downstream answered with, an HTTP 4xx
 * refusal from the MCP endpoint, and errors already in connecta's words (its
 * own classes, an OAuth error the token responses were rebuilt into, and
 * `UnauthorizedError`, whose class is the whole verdict and whose text is
 * never shown). The request's own abort reason is checked by identity before
 * this. Everything else is withheld.
 */
function keepsItsText(err: unknown, transport: Transport | undefined): boolean {
  if (
    err instanceof ConnectorCallError ||
    err instanceof WithheldTextError ||
    err instanceof UnauthorizedError ||
    err instanceof OAuthError
  ) {
    return true;
  }
  if (err instanceof SdkHttpError) return err.status >= 400 && err.status < 500;
  if (err instanceof ProtocolError) {
    return transport !== undefined && wireErrors.get(transport)?.has(wireErrorKey(err.code, err.message)) === true;
  }
  return false;
}

/**
 * The SDK's own checks of a tool's output schema, recognized by how the
 * pinned SDK (2.3.1) begins their messages, and told in connecta's words.
 * Recognition reads the SDK's text only to choose connecta's: none of it, nor
 * the validator's account that follows, is repeated.
 */
const SDK_OUTPUT_SCHEMA_CHECKS: readonly (readonly [RegExp, string])[] = [
  [
    /^Structured content does not match the tool's output schema/,
    "the result did not match the tool's declared output schema",
  ],
  [
    /^Tool .* has an output schema but did not return structured content/s,
    "the result did not return structured content although the tool declares an output schema",
  ],
  [/^Tool .* has an invalid outputSchema/s, "the tool's declared output schema could not be compiled"],
];

function sdkCheckFailed(err: unknown): string {
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return ": the request timed out";
  if (!(err instanceof ProtocolError)) return "";
  const check = SDK_OUTPUT_SCHEMA_CHECKS.find(([pattern]) => pattern.test(err.message));
  return check ? `: ${check[1]}` : "";
}

/** The first error in `err`'s cause chain already told in connecta's words. */
function connectaErrorWithin(err: unknown): ConnectorCallError | WithheldTextError | undefined {
  const seen = new Set<unknown>();
  for (
    let current: unknown = err instanceof Error ? err.cause : undefined;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (current instanceof ConnectorCallError || current instanceof WithheldTextError) return current;
  }
  return undefined;
}

/** The request's own abort reason, by identity, never by name or class. */
export function ownAbortReason(err: unknown, signals: readonly (AbortSignal | undefined)[]): boolean {
  return signals.some((signal) => signal?.aborted === true && err === signal.reason);
}

/**
 * The request's own abort reason as the SDK hands it back: a request it
 * cancels rejects with `new SdkError(RequestTimeout, String(reason))` unless
 * the reason already is one (pinned against client 2.3.1). Its text is the
 * caller's, so it passes as the SDK wrote it.
 */
function ownAbortReasonAsSdkReports(err: unknown, signals: readonly (AbortSignal | undefined)[]): boolean {
  return (
    err instanceof SdkError &&
    err.code === SdkErrorCode.RequestTimeout &&
    signals.some((signal) => signal?.aborted === true && err.message === String(signal.reason))
  );
}

/** An error's class name, when it is a plain identifier worth naming. */
export function errorKind(err: unknown): string {
  const label = errorLabel(err);
  return label && label !== "Error" ? ` (${label})` : "";
}

/**
 * Replace text while keeping a verdict already derived from structured facts.
 * Never retain the original SDK error as a cause.
 */
export function withheldAs(message: string, verdict: unknown): Error {
  if (verdict instanceof ConnectorCallError) {
    return new ConnectorCallError(verdict.code, message, {
      retryable: verdict.retryable,
      ...(verdict.retryAfterMs !== undefined ? { retryAfterMs: verdict.retryAfterMs } : {}),
      ...(verdict.details ? { details: verdict.details } : {}),
      ...(verdict.validation ? { validation: verdict.validation } : {}),
      ...(verdict.current ? { current: verdict.current } : {}),
      ...(verdict.writeOutcome ? { writeOutcome: verdict.writeOutcome } : {}),
    });
  }
  return new WithheldTextError(message, verdict);
}

/** One connector's error classes and boundary mapping. */
export function remoteMcpErrors(
  rt: RemoteMcpRuntime,
): Pick<
  RemoteMcpShared,
  | "UnresolvedTokenError"
  | "CredentialRequiredError"
  | "atMcpBoundary"
  | "scopeEndedError"
  | "authRequiredError"
  | "withoutCredential"
  | "operatorDisconnectedError"
  | "OperatorDisconnectedError"
> {
  const { isOauth, id, endpointOrigin, requestAuth } = rt;

  /**
   * Typed per-call auth signal. The `UnauthorizedError` behind it is not kept
   * as cause: the class is the whole verdict, and a logger rendering the
   * chain would render whatever text the error carried.
   */
  const authRequiredError = (ctx: ConnectorContext) =>
    new ConnectorCallError(
      isOauth ? "downstream_oauth_required" : "auth_required",
      `Connector "${id}" requires authorization — ${routePhrases(ctx).authorizeAndOpen(id)}.`,
    );

  /**
   * The MCP boundary, where an error leaves the SDK at the handshake, a
   * `tools/list` page, or a `tools/call`. The request's own abort reason
   * passes first, by identity, then what `keepsItsText` allows. Anything else
   * (a parser's or validator's account, a non-4xx body, a runtime's message)
   * is told as the step, the endpoint's origin, the HTTP status if there was
   * one, and the error's class, classified as `verdict` would have been.
   */
  const atMcpBoundary = (
    ctx: ConnectorContext,
    err: unknown,
    step: "MCP handshake" | "tools/list" | "tools/call" | "skills/list" | "resources/read",
    transport: Transport | undefined,
    signals: readonly (AbortSignal | undefined)[],
  ): unknown => {
    // An OAuth flow already attached the step and origin it failed at. The
    // outer MCP operation must not replace them with the endpoint's facts.
    if (failureRecord({}, err).step?.startsWith("OAuth ")) return downstreamCallError(err);
    const httpStatus = err instanceof SdkHttpError ? err.status : undefined;
    // Skills operations retain the existing closed operator-record vocabulary.
    const facts = {
      ...(step === "skills/list" || step === "resources/read" ? {} : { step }),
      origin: endpointOrigin,
      ...(httpStatus ? { httpStatus } : {}),
    };
    const classified = downstreamCallError(
      redactSentSecrets(ctx, err),
      undefined,
      undefined,
      undefined,
      requestSentSecrets(ctx),
    );
    const verdict =
      isOauth && classified instanceof ConnectorCallError && classified.code === "auth_required"
        ? carryFailureFacts(err, authRequiredError(ctx))
        : classified;
    if (ownAbortReasonAsSdkReports(err, signals)) {
      return attachFailureFacts(carryFailureFacts(err, withheldAs(msg(err), verdict)), facts);
    }
    if (err instanceof InsufficientScopeError) {
      return attachFailureFacts(carryFailureFacts(err, verdict), facts);
    }
    if (requestAuth && httpStatus === 401) {
      return attachFailureFacts(
        new ConnectorCallError("auth_required", "The downstream rejected this request's Bearer token."),
        facts,
      );
    }
    if (ownAbortReason(err, signals) || keepsItsText(err, transport)) {
      return attachFailureFacts(
        carryFailureFacts(
          err,
          redactSentSecrets(
            ctx,
            err instanceof UnauthorizedError || (ownAbortReason(err, signals) && !hasSdkPayload(err)) ? err : verdict,
          ),
        ),
        facts,
      );
    }
    // The SDK wraps a failure of connecta's own fetch (a refused redirect, an
    // unreachable host) in an error of its own, such as the version probe's;
    // that failure's words are connecta's, and they say what happened.
    const ours = connectaErrorWithin(err);
    if (ours) {
      return attachFailureFacts(carryFailureFacts(ours, withheldAs(ours.message, ours)), facts);
    }
    const status = httpStatus ? ` with HTTP ${httpStatus}` : "";
    return attachFailureFacts(
      carryFailureFacts(
        err,
        withheldAs(
          `Connector "${id}" ${step} with ${endpointOrigin} failed${status}` +
            `${errorKind(err)}${sdkCheckFailed(err)}. The error is withheld because ` +
            "its text can quote what the server sent.",
          verdict,
        ),
      ),
      facts,
    );
  };

  class OperatorDisconnectedError extends ConnectorCallError {
    constructor() {
      super(
        "downstream_oauth_required",
        `Connector "${id}" was disconnected by an operator — explicitly start authorization to reconnect it.`,
      );
    }
  }
  const operatorDisconnectedError = () => new OperatorDisconnectedError();

  /**
   * The credential slot is declared but the vault has nothing in it (or has no
   * key to read it with). Deliberately the same `auth_required` code an absent
   * OAuth grant produces: the agent's next move is `authorize_connector`
   * either way, and that tool reads `connector.credential` to hand the
   * operator the connection in the UI when available instead of a consent URL.
   */
  class CredentialRequiredError extends ConnectorCallError {
    constructor(message: string) {
      super("auth_required", message);
    }
  }

  /**
   * A request resolver threw something untyped. Calls still fail with
   * `auth_required`, but status reports an error: the resolver's own outage
   * is not an authorization the operator can grant.
   */
  class UnresolvedTokenError extends ConnectorCallError {
    constructor() {
      super("auth_required", "The request token could not be resolved.");
    }
  }

  /**
   * Replace, never edit.
   *
   * Any error whose message quotes the credential — the raw value or the
   * framed header it becomes — is discarded whole and replaced with a fixed
   * sentence. Nothing is substringed, masked, or truncated out of the original:
   * a redaction that keeps part of a secret is still a leak, and the original
   * error is not worth one. This is defense in depth behind the validation
   * above, which is what keeps an unsendable value from reaching a transport
   * at all.
   */
  const withoutCredential = (ctx: ConnectorContext, err: unknown, ...secrets: (string | null)[]): unknown => {
    const quoted = secrets.filter((secret): secret is string => typeof secret === "string" && secret !== "");
    if (quoted.length === 0) return err;
    const seen = new Set<unknown>();
    let current: unknown = err;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      // Decided already, beneath the transport, and wrapped by the SDK on
      // the way up (the version probe's error, say).
      if (current instanceof CredentialRequiredError) return current;
      if (quoted.some((secret) => current instanceof Error && current.message.includes(secret))) {
        return new CredentialRequiredError(
          `Connector "${id}" could not send its stored credential as a ` +
            `header. ${routePhrases(ctx).authorizeFor("recovery options")}. When available, ` +
            "re-enter it in this connection in the operator UI. " +
            "The value is not shown or logged.",
        );
      }
      current = current.cause;
    }
    return err;
  };

  // Its own class, so that a status record, which carries no message, still says so.
  const scopeEndedError = () => new ScopeEndedError(`Connector "${id}" scope ended during connection.`);
  return {
    UnresolvedTokenError,
    CredentialRequiredError,
    atMcpBoundary,
    scopeEndedError,
    authRequiredError,
    withoutCredential,
    operatorDisconnectedError,
    OperatorDisconnectedError,
  };
}
