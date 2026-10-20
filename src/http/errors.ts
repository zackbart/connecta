// Internal prototype for decision 0010 (B.3). Unreachable from src/index.ts.
//
// Every way a kit request can fail, as a tagged error, and the one mapping
// from those to the wire `ConnectorCallError`. A provider supplies meaning
// only where meaning differs by vendor: what 401, 403, and 404 say (required,
// because the same 403 is an ungranted capability at one vendor and a token
// scope at another), how to read a detail line from an error body, and any
// other status it wants to word itself. Everything else has one default.
//
// Write outcomes are decided here, not per provider: a write that may have
// reached the vendor (a 5xx, a connection lost after sending) is never
// advertised as retryable (INV-9), whatever the vendor's own table says. The
// rule and its words are the REST kit's `unknownOutcome`, so a provider that
// moves onto the kit keeps its goldens.

import { Data } from "effect";
import { retryAfterMs } from "../connectors/guarded-fetch.js";
import { ConnectorCallError, unavailableCallError } from "../errors.js";

/** A request the kit refused before sending: confinement, a shadowed credential header. */
export class RequestRefused extends Data.TaggedError("RequestRefused")<{ readonly message: string }> {}

/** `fetch` rejected. `failure` is read for its errno only and never surfaces. */
export class TransportFailure extends Data.TaggedError("TransportFailure")<{
  readonly failure: unknown;
  readonly host: string;
}> {}

/** The vendor answered with a redirect; the credential is never forwarded. */
export class RedirectRefused extends Data.TaggedError("RedirectRefused")<{ readonly status: number }> {}

/** The body crossed the connector's byte ceiling, declared or streamed. */
export class ResponseTooLarge extends Data.TaggedError("ResponseTooLarge")<{ readonly detail: string }> {}

/** A non-2xx answer, with the body parsed when it was JSON. */
export class StatusFailure extends Data.TaggedError("StatusFailure")<{
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}> {}

/** A successful status whose body is not JSON. Its text never surfaces. */
export class UnreadableBody extends Data.TaggedError("UnreadableBody")<{}> {}

/** The vendor's own typed verdict: an in-band refusal, a missing credential. */
export class Refusal extends Data.TaggedError("Refusal")<{ readonly error: ConnectorCallError }> {}

export type HttpFailure =
  | RequestRefused
  | TransportFailure
  | RedirectRefused
  | ResponseTooLarge
  | StatusFailure
  | UnreadableBody
  | Refusal;

/** What a status rule may read: never the raw body, only the vendor's detail line. */
interface StatusFacts {
  readonly status: number;
  readonly detail: string;
  readonly retryAfterMs: number | undefined;
}

type StatusRule = (facts: StatusFacts) => ConnectorCallError;

/**
 * A vendor's status table. 401, 403, and 404 are required: their meaning
 * differs by vendor and a default would guess. `serverError` covers 5xx.
 */
interface StatusTable {
  readonly 401: StatusRule;
  readonly 403: StatusRule;
  readonly 404: StatusRule;
  readonly [status: number]: StatusRule | undefined;
  readonly serverError?: StatusRule;
  readonly otherwise?: StatusRule;
}

export interface VendorErrors {
  /** Name in failure prose, such as "Tithe.ly". Never parsed. */
  readonly provider: string;
  /** One detail line from an error body; the default when none is found. */
  readonly detail: (body: unknown, status: number) => string;
  readonly statuses: StatusTable;
  /** Message for a successful status whose body is not JSON. */
  readonly unreadable: string;
}

// No 409: `conflict` is a refusal, so it tells invocation a write did not
// land. Only a vendor that documents its 409 may say that, in its own table.
const DEFAULTS: Readonly<Record<number, StatusRule>> = {
  400: ({ detail }) => new ConnectorCallError("invalid_args", detail),
  422: ({ detail }) => new ConnectorCallError("invalid_args", detail),
  429: ({ detail, retryAfterMs: wait }) =>
    new ConnectorCallError("rate_limited", detail, wait === undefined ? {} : { retryAfterMs: wait }),
};

const serverErrorDefault: StatusRule = ({ detail, retryAfterMs: wait }) =>
  new ConnectorCallError("unavailable", detail, wait === undefined ? {} : { retryAfterMs: wait });

const otherwiseDefault: StatusRule = ({ detail }) =>
  new ConnectorCallError("connector_call_failed", detail, { retryable: false });

/**
 * Failures that prove nothing was sent: `fetch` rejected before any response,
 * with no connection established, so the vendor cannot have acted.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
]);

export interface MapOptions {
  /** The call's served classification (the Classification service), never the HTTP method. */
  readonly classification: "read" | "write";
  /** A write whose request carried an idempotency key keeps its retry advice. */
  readonly idempotent?: boolean;
  /** Whether any request of this call reached `fetch` (the Dispatches service). Defaults to true. */
  readonly dispatched?: boolean;
  readonly signal?: AbortSignal | undefined;
}

/** The single mapping from a kit failure to what an agent reads. */
export function toConnectorCallError(
  failure: HttpFailure,
  vendor: VendorErrors,
  options: MapOptions,
): ConnectorCallError {
  const error = verdict(failure, vendor, options.signal);
  if (
    options.classification === "read" ||
    options.idempotent === true ||
    options.dispatched === false ||
    !mayHaveLanded(failure, error)
  ) {
    return error;
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.provider} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false },
  );
}

function verdict(failure: HttpFailure, vendor: VendorErrors, signal: AbortSignal | undefined): ConnectorCallError {
  switch (failure._tag) {
    case "Refusal":
      return failure.error;
    case "RequestRefused":
      return new ConnectorCallError("invalid_args", failure.message);
    case "TransportFailure":
      return unavailableCallError(failure.failure, failure.host, `Could not reach the ${vendor.provider} API.`, signal);
    case "RedirectRefused":
      return new ConnectorCallError(
        "connector_call_failed",
        `${vendor.provider} answered HTTP ${failure.status} with a redirect; this connector talks to exactly one origin and never forwards its credential to another.`,
        { retryable: false },
      );
    case "ResponseTooLarge":
      return new ConnectorCallError("connector_call_failed", failure.detail, { retryable: false });
    case "UnreadableBody":
      return new ConnectorCallError("connector_call_failed", vendor.unreadable, { retryable: false });
    case "StatusFailure": {
      const facts: StatusFacts = {
        status: failure.status,
        detail: vendor.detail(failure.body, failure.status),
        retryAfterMs: retryAfterMs(failure.headers),
      };
      const table = vendor.statuses;
      const rule =
        table[failure.status] ??
        (failure.status >= 500 ? (table.serverError ?? serverErrorDefault) : undefined) ??
        DEFAULTS[failure.status] ??
        table.otherwise ??
        otherwiseDefault;
      return rule(facts);
    }
  }
}

/**
 * Whether a dispatched write's failure would be advertised as retryable after
 * the vendor may have acted on it. Only a retryable `unavailable` qualifies,
 * whichever tag carried it: every other verdict is a refusal or already
 * non-retryable, and invocation reads a non-retryable failure after dispatch
 * as an unknown outcome on its own. Not rewritten: a timeout (invocation
 * answers `write_outcome_unknown`) and a connection never made.
 */
function mayHaveLanded(failure: HttpFailure, error: ConnectorCallError): boolean {
  if (error.code !== "unavailable" || !error.retryable) return false;
  const code = error.details?.code;
  return (
    code !== "timeout" && !(failure._tag === "TransportFailure" && code !== undefined && NEVER_CONNECTED.has(code))
  );
}
