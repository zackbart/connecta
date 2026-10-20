// Internal prototype for decision 0010 (B.3). Unreachable from src/index.ts.
//
// Every way a kit request can fail, as a tagged error, and the one mapping
// from those to the wire `ConnectorCallError`. A provider supplies meaning
// only where meaning differs by vendor: what 401, 403, and 404 say (required,
// because the same 403 is an ungranted capability at one vendor and a token
// scope at another), which machine-readable facts its error bodies and
// headers carry, rules that cut across statuses, and its wording.
//
// Classification reads facts, never prose. `facts` parses a bounded record of
// tokens (codes, reasons, types) from the body, and only the reviewed
// `headers` allowlist is visible. Rules receive the detail line as `Prose`,
// which has no string methods, so a rule cannot branch on what a vendor wrote.
//
// Write outcomes are decided here, not per provider, from the call's
// dispatch ledger (src/http/services.ts): what each resource request did,
// recorded when it happened. A write the vendor answered keeps that answer's
// meaning whatever happens after it (a token renewal, its failure, a
// cancellation), and a write that may have reached the vendor is never
// advertised as retryable (INV-9). The words are the REST kit's
// `unknownOutcome`, so a provider that moves onto the kit keeps its goldens.

import { Data } from "effect";
import { retryAfterMs } from "../connectors/guarded-fetch.js";
import { ConnectorCallError, networkErrorCode, unavailableCallError } from "../errors.js";
import type { Dispatch } from "./services.js";

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

/** The operation a request carried out, known before anything is read from its answer. */
export interface OperationRef {
  readonly method: string;
  /** The declared path template, such as `/charges/:chargeId`; a hatch passes its index's template. */
  readonly template: string;
  /** Named facts the provider set for this request, such as Google's `revisionGuarded`. */
  readonly flags?: Readonly<Record<string, true>>;
}

/** A non-2xx answer (or an in-band refusal mapped as one), with the body parsed when it was JSON. */
export class StatusFailure extends Data.TaggedError("StatusFailure")<{
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly operation: OperationRef;
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

/** One machine-readable value from an error body: a code, a reason, a type. */
type Fact = string | number | boolean;
type Facts = Readonly<Record<string, Fact | ReadonlyArray<Fact> | undefined>>;

declare const PROSE: unique symbol;
/** A vendor's detail line, for wording only. It has no string methods: interpolate it, never parse it. */
interface Prose {
  readonly [PROSE]: true;
  toString(): string;
}

/** What every rule reads: bounded facts, never the raw body. */
interface StatusFacts<F extends Facts = Facts> {
  readonly status: number;
  /** The vendor's `facts`, bounded: strings outside the token grammar and lists past eight entries are gone. */
  readonly facts: F;
  /** Only the vendor's reviewed `headers`, by lowercase name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly retryAfterMs: number | undefined;
  readonly operation: OperationRef;
  /** The operation withholds vendor text (value safety); `detail` was built without the body. */
  readonly withheld: boolean;
  readonly detail: Prose;
}

/** What `detail` may read. `body` is absent when the operation withholds vendor text. */
interface DetailInput<F extends Facts = Facts> {
  readonly status: number;
  readonly facts: F;
  readonly headers: Readonly<Record<string, string>>;
  readonly withheld: boolean;
  readonly body?: unknown;
}

type StatusRule<F extends Facts> = (facts: StatusFacts<F>) => ConnectorCallError;

/**
 * A vendor's status table. 401, 403, and 404 are required: their meaning
 * differs by vendor and a default would guess. `serverError` covers 5xx.
 */
interface StatusTable<F extends Facts> {
  readonly 401: StatusRule<F>;
  readonly 403: StatusRule<F>;
  readonly 404: StatusRule<F>;
  readonly [status: number]: StatusRule<F> | undefined;
  readonly serverError?: StatusRule<F>;
  readonly otherwise?: StatusRule<F>;
}

export interface VendorErrors<F extends Facts = Facts> {
  /** Name in failure prose, such as "Tithe.ly". Never parsed. */
  readonly provider: string;
  /** The machine-readable fields of an error body. Runs on every failure, withheld or not. */
  readonly facts: (body: unknown) => F;
  /** Response headers rules and wording may read, by lowercase name. Every other header is invisible. */
  readonly headers?: readonly string[];
  /** One detail line for the reader. */
  readonly detail: (input: DetailInput<F>) => string;
  /** Rules that cut across statuses, in order, before the table: the first verdict wins. */
  readonly classify?: ReadonlyArray<(facts: StatusFacts<F>) => ConnectorCallError | undefined>;
  readonly statuses: StatusTable<F>;
  /** Message for a successful status whose body is not JSON. */
  readonly unreadable: string;
  /**
   * Where the vendor documents that it authenticates a request before acting
   * on it. With it, a write answered 401 is that 401's refusal; without it,
   * the write's outcome is unknown, since a server may act before it rejects
   * a credential.
   */
  readonly authBeforeExecution?: { readonly evidence: string };
}

// No 409: `conflict` is a refusal, so it tells invocation a write did not
// land. Only a vendor that documents its 409 may say that, in its own table.
const DEFAULTS: Readonly<Record<number, StatusRule<Facts>>> = {
  400: ({ detail }) => new ConnectorCallError("invalid_args", String(detail)),
  422: ({ detail }) => new ConnectorCallError("invalid_args", String(detail)),
  429: ({ detail, retryAfterMs: wait }) =>
    new ConnectorCallError("rate_limited", String(detail), wait === undefined ? {} : { retryAfterMs: wait }),
};

const serverErrorDefault: StatusRule<Facts> = ({ detail, retryAfterMs: wait }) =>
  new ConnectorCallError("unavailable", String(detail), wait === undefined ? {} : { retryAfterMs: wait });

const otherwiseDefault: StatusRule<Facts> = ({ detail }) =>
  new ConnectorCallError("connector_call_failed", String(detail), { retryable: false });

/**
 * Failures that prove nothing was sent, but only when `fetch` itself rejected
 * before any response existed: no connection was established, so the vendor
 * cannot have acted.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
]);

/** Whether a `fetch` rejection proves the request never left (the dispatch ledger's `unconnected`). */
export function neverConnected(failure: unknown): boolean {
  const code = networkErrorCode(failure);
  return code !== undefined && NEVER_CONNECTED.has(code);
}

const TOKEN = /^[A-Za-z0-9_.:[\]-]{1,128}$/;
const MAX_LIST = 8;
const MAX_HEADER = 128;

function boundedFact(value: unknown): Fact | undefined {
  if (typeof value === "string") return TOKEN.test(value) ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "boolean" ? value : undefined;
}

/** Keep tokens, finite numbers, and booleans; anything else (prose, URLs, objects) is dropped. */
function bounded<F extends Facts>(facts: F): F {
  const out: Record<string, Fact | Fact[] | undefined> = {};
  for (const [name, value] of Object.entries(facts)) {
    out[name] = Array.isArray(value)
      ? value
          .map(boundedFact)
          .filter((fact): fact is Fact => fact !== undefined)
          .slice(0, MAX_LIST)
      : boundedFact(value);
  }
  return out as F;
}

function visibleHeaders(headers: Headers, allowed: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowed ?? []) {
    const value = headers.get(name);
    if (value !== null && value.length <= MAX_HEADER && !hasControl(value)) out[name.toLowerCase()] = value;
  }
  return out;
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function prose(text: string): Prose {
  return { toString: () => text } as Prose;
}

export interface MapOptions {
  /** The call's served classification (the Classification service), never the HTTP method. */
  readonly classification: "read" | "write";
  /** A write whose request carried an idempotency key keeps its retry advice. */
  readonly idempotent?: boolean;
  /** Every resource request of this call, as the transport recorded it (the Dispatches service). */
  readonly dispatches: ReadonlyArray<Dispatch>;
  /** Whether an operation withholds vendor error text (the connection's ResultSafety). */
  readonly withholds?: (operation: OperationRef) => boolean;
  readonly signal?: AbortSignal | undefined;
}

/** The single mapping from a kit failure to what an agent reads. */
export function toConnectorCallError(
  failure: HttpFailure,
  vendor: VendorErrors<any>,
  options: MapOptions,
): ConnectorCallError {
  const error = verdict(failure, vendor, options);
  if (options.classification === "read") return error;
  const writes = options.dispatches.filter((dispatch) => dispatch.write);
  // Nothing of the write left connecta: no request, or fetch refused to connect.
  if (writes.every((dispatch) => dispatch.state === "unconnected")) return error;
  const answered = answeredVerdict(failure._tag === "StatusFailure" ? { failure, error } : undefined, vendor, options);
  if (answered) return answered;
  if (options.idempotent === true) return error;
  // Any carrier of a retryable outage after dispatch: a 5xx, a connection
  // lost after sending, a provider's own Refusal. A timeout is invocation's
  // `write_outcome_unknown`.
  if (error.code !== "unavailable" || !error.retryable || error.details?.code === "timeout") return error;
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.provider} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false },
  );
}

/**
 * The verdict a write's answer fixed when the resource server gave it, or
 * undefined when no answer fixes one. Today that is a 401: unknown unless the
 * vendor documents that it authenticates first. Read from the ledger, so a
 * renewal that fails afterwards, for whatever reason, and a cancellation
 * during it, report the same thing (Q8).
 */
export function answeredVerdict(
  current: { readonly failure: StatusFailure; readonly error: ConnectorCallError } | undefined,
  vendor: VendorErrors<any>,
  options: Pick<MapOptions, "classification" | "dispatches" | "withholds" | "signal">,
): ConnectorCallError | undefined {
  if (options.classification !== "write") return undefined;
  const answer = options.dispatches.find(
    (dispatch) => dispatch.write && dispatch.state === "answered" && dispatch.status === 401,
  );
  if (!answer) return undefined;
  const own =
    current?.failure.status === 401
      ? current.error
      : verdict(
          new StatusFailure({
            status: 401,
            headers: answer.headers ?? new Headers(),
            body: undefined,
            operation: answer.operation ?? { method: "", template: "" },
          }),
          vendor,
          options,
        );
  if (vendor.authBeforeExecution) return own;
  return new ConnectorCallError(
    "connector_call_failed",
    `${own.message} The write was sent before ${vendor.provider} rejected its credential, so whether it took effect ` +
      "is unknown: check the target before repeating it.",
    { retryable: false },
  );
}

function verdict(
  failure: HttpFailure,
  vendor: VendorErrors<any>,
  options: Pick<MapOptions, "withholds" | "signal">,
): ConnectorCallError {
  switch (failure._tag) {
    case "Refusal":
      return failure.error;
    case "RequestRefused":
      return new ConnectorCallError("invalid_args", failure.message);
    case "TransportFailure":
      return unavailableCallError(
        failure.failure,
        failure.host,
        `Could not reach the ${vendor.provider} API.`,
        options.signal,
      );
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
    case "StatusFailure":
      return statusVerdict(failure, vendor, options.withholds?.(failure.operation) === true);
  }
}

function statusVerdict(failure: StatusFailure, vendor: VendorErrors<any>, withheld: boolean): ConnectorCallError {
  const facts = bounded(vendor.facts(failure.body));
  const headers = visibleHeaders(failure.headers, vendor.headers);
  // The body reaches `detail` only when this operation's value-safety review
  // lets its vendor text through; facts and headers are bounded either way.
  const detail = vendor.detail({
    status: failure.status,
    facts,
    headers,
    withheld,
    ...(withheld ? {} : { body: failure.body }),
  });
  const input: StatusFacts = {
    status: failure.status,
    facts,
    headers,
    retryAfterMs: retryAfterMs(failure.headers),
    operation: failure.operation,
    withheld,
    detail: prose(detail),
  };
  for (const rule of vendor.classify ?? []) {
    const decided = rule(input);
    if (decided) return decided;
  }
  const table = vendor.statuses;
  const rule =
    table[failure.status] ??
    (failure.status >= 500 ? (table.serverError ?? serverErrorDefault) : undefined) ??
    DEFAULTS[failure.status] ??
    table.otherwise ??
    otherwiseDefault;
  return rule(input);
}
