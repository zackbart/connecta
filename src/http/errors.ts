// Internal prototype for decision 0010 (B.3). Unreachable from src/index.ts.
//
// Every way a kit request can fail, as a tagged error, and the one mapping
// from those to the wire `ConnectorCallError`. A provider supplies meaning
// only where meaning differs by vendor: what 401, 403, and 404 say (required,
// because the same 403 is an ungranted capability at one vendor and a token
// scope at another), which machine-readable facts its error bodies and
// headers carry, rules that cut across statuses, and its wording.
//
// Classification and wording are two steps. A vendor's `facts` reads a copy
// of the error body that keeps only tokens, finite numbers, and booleans, and
// its rules read those facts and the reviewed `headers` allowlist, nothing
// else, and return a `Verdict`: a code and retry advice. Only after that does
// the kit build the vendor's detail line, and the verdict's `words` render
// the message from it. A rule's input has no prose to read, and when a rule
// runs, this failure's prose does not exist yet.
//
// Write outcomes are decided here, not per provider, from the call's
// dispatch ledger (src/http/services.ts): what each resource request did,
// recorded when it happened, and which failure each one's own answer settled
// into. A write keeps the meaning of its own answer whatever happens after it
// (a token renewal, its failure, a cancellation, an auxiliary request's
// failure), and a write that may have reached the vendor is never advertised
// as retryable (INV-9). The words are A.2's (#902), so a provider that moves
// onto the kit keeps its goldens.

import { Data } from "effect";
import { retryAfterMs } from "../connectors/guarded-fetch.js";
import { ConnectorCallError, networkErrorCode, unavailableCallError, type ConnectorCallErrorCode } from "../errors.js";
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

/**
 * A logical write was about to be handed to `fetch` a second time in one
 * call, by any path (an Effect retry, a redirect follower, a renewal that
 * replays, a reconnect, a retry under a new request id). Raised below all of
 * them, before anything leaves; `first` is the dispatch that did leave.
 */
export class ResendRefused extends Data.TaggedError("ResendRefused")<{ readonly first: Dispatch }> {}

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
  | ResendRefused
  | StatusFailure
  | UnreadableBody
  | Refusal;

/** One machine-readable value from an error body: a code, a reason, a type. */
type Fact = string | number | boolean;
type Facts = Readonly<Record<string, Fact | ReadonlyArray<Fact> | undefined>>;

/**
 * Everything classification reads. There is no detail line and no body: a
 * rule cannot reach a vendor's prose, so it cannot branch on it.
 */
export interface Classified<F extends Facts = Facts> {
  readonly status: number;
  /** The vendor's `facts`, over the whole error body: tokens, finite numbers, booleans, and complete lists of them. */
  readonly facts: F;
  /** Only the vendor's reviewed `headers`, by lowercase name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly retryAfterMs: number | undefined;
  readonly operation: OperationRef;
  /** The operation withholds vendor text (value safety); its detail line will be built without the body. */
  readonly withheld: boolean;
}

/** A classification: the wire code and its retry advice, decided before any prose exists. */
export interface Verdict {
  readonly code: ConnectorCallErrorCode;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly current?: Readonly<Record<string, number>>;
  /**
   * The agent-facing message, rendered from the vendor's detail line once
   * the code is fixed. It receives the line and returns words; it decides
   * nothing. Without it the message is the line itself.
   */
  readonly words?: (detail: string) => string;
}

/** What `detail` may read. `body` is absent when the operation withholds vendor text. */
interface DetailInput<F extends Facts = Facts> {
  readonly status: number;
  /** The same facts, with each list cut to its first eight entries for display. */
  readonly facts: F;
  readonly headers: Readonly<Record<string, string>>;
  readonly withheld: boolean;
  readonly body?: unknown;
}

export type StatusRule<F extends Facts = Facts> = (input: Classified<F>) => Verdict;

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
  /**
   * The machine-readable fields of an error body. It receives a copy that
   * keeps only tokens (1–128 characters of `[A-Za-z0-9_.:[\]-]`, keys
   * included), finite numbers, booleans, and null, so a vendor's message is
   * not there to read. Runs on every failure, withheld or not.
   */
  readonly facts: (tokens: unknown) => F;
  /** Response headers rules and wording may read, by lowercase name. Every other header is invisible. */
  readonly headers?: readonly string[];
  /** One detail line for the reader, built after classification. */
  readonly detail: (input: DetailInput<F>) => string;
  /** Rules that cut across statuses, in order, before the table: the first verdict wins. */
  readonly classify?: ReadonlyArray<(input: Classified<F>) => Verdict | undefined>;
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
const DEFAULTS: Readonly<Record<number, StatusRule>> = {
  400: () => ({ code: "invalid_args" }),
  422: () => ({ code: "invalid_args" }),
  429: ({ retryAfterMs: wait }) => ({ code: "rate_limited", retryAfterMs: wait }),
};

const serverErrorDefault: StatusRule = ({ retryAfterMs: wait }) => ({ code: "unavailable", retryAfterMs: wait });

const otherwiseDefault: StatusRule = () => ({ code: "connector_call_failed", retryable: false });

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
/** How many entries of a list the detail line sees. Classification sees them all. */
const DISPLAYED = 8;
const MAX_HEADER = 128;
const MAX_DEPTH = 32;

/**
 * The body as a vendor's `facts` may read it: tokens, finite numbers,
 * booleans, and null, under keys that are tokens. Prose, URLs, and anything
 * deeper than 32 levels are gone before any vendor code runs.
 */
function tokensOf(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return TOKEN.test(value) ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object" || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((entry) => tokensOf(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => (TOKEN.test(key) ? [[key, tokensOf(entry, depth + 1)]] : [])),
  );
}

function boundedFact(value: unknown): Fact | undefined {
  if (typeof value === "string") return TOKEN.test(value) ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "boolean" ? value : undefined;
}

/** Keep tokens, finite numbers, and booleans, in complete lists; anything else is dropped. */
function bounded<F extends Facts>(facts: F): F {
  const out: Record<string, Fact | Fact[] | undefined> = {};
  for (const [name, value] of Object.entries(facts)) {
    out[name] = Array.isArray(value)
      ? value.map(boundedFact).filter((fact): fact is Fact => fact !== undefined)
      : boundedFact(value);
  }
  return out as F;
}

/** The facts the detail line shows: each list cut to its first eight entries. */
function displayed<F extends Facts>(facts: F): F {
  return Object.fromEntries(
    Object.entries(facts).map(([name, value]) => [name, Array.isArray(value) ? value.slice(0, DISPLAYED) : value]),
  ) as F;
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

/**
 * A.2's explicit unknown write outcome (#902): the error keeps its own code
 * (`auth_required` keeps invocation's `authorize_connector` handoff) and is
 * never retryable, and `classifyWriteOutcome` reads `writeOutcome` before its
 * refusal codes, so a direct call, a caught program failure, and an uncaught
 * one all report the write as unknown. The prototype sets the field #902 adds
 * to `ConnectorCallError`; once #902 merges, this is its constructor option.
 */
function unknownWrite(code: ConnectorCallErrorCode, message: string): ConnectorCallError {
  return Object.assign(new ConnectorCallError(code, message, { retryable: false }), {
    writeOutcome: "unknown" as const,
  });
}

/** The explicit outcome an error carries, if any (#902's `writeOutcome`). */
export function writeOutcomeOf(error: unknown): "unknown" | undefined {
  return error instanceof ConnectorCallError && (error as { writeOutcome?: unknown }).writeOutcome === "unknown"
    ? "unknown"
    : undefined;
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
  return options.classification === "read" ? error : writeOutcome(failure, error, vendor, options);
}

/**
 * What a write call's failure says, read from the ledger:
 *
 * 1. Nothing of the write left connecta (no write request, or `fetch` refused
 *    to connect for each): the verdict stands, retry advice included.
 * 2. A second dispatch of the write was stopped (`ResendRefused`): something
 *    above the transport took the first attempt for a failure and tried
 *    again, so the outcome is unknown.
 * 3. The failure is the write's own answer (the call's one write that left,
 *    and the failure its answer settled into): a 401 keeps its code with an
 *    unknown outcome; a request with an idempotency key keeps the verdict; a
 *    retryable outage becomes an unknown outcome; any other verdict is the
 *    vendor's refusal of the write itself and stands.
 * 4. Anything else came after the write left (an auxiliary request, the
 *    provider's own check, a second write step): the write's outcome is
 *    unknown and the call is never retryable as a whole, whatever the later
 *    failure's code.
 */
function writeOutcome(
  failure: HttpFailure,
  error: ConnectorCallError,
  vendor: VendorErrors<any>,
  options: MapOptions,
): ConnectorCallError {
  const left = options.dispatches.filter((dispatch) => dispatch.write && dispatch.state !== "unconnected");
  if (left.length === 0) {
    // A blocked second attempt of a write that never connected reports that first attempt.
    return failure._tag === "ResendRefused" && failure.first.failure
      ? verdict(failure.first.failure, vendor, options)
      : error;
  }
  // A deadline is invocation's `write_outcome_unknown`, with its own facts.
  if (timedOut(error)) return error;
  if (failure._tag === "ResendRefused") return resend(failure.first, vendor, options);
  const own = options.dispatches.find((dispatch) => dispatch.failure === failure);
  if (own !== undefined && left.length === 1 && left[0] === own) return writeAnswer(own, error, vendor, options);
  return afterWrite(error, left, vendor);
}

function writeAnswer(
  own: Dispatch,
  error: ConnectorCallError,
  vendor: VendorErrors<any>,
  options: MapOptions,
): ConnectorCallError {
  if (own.state === "answered" && own.status === 401) return unauthorized(own, error, vendor);
  if (options.idempotent === true) return error;
  if (error.code !== "unavailable" || !error.retryable) return error;
  return unknownWrite(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.provider} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
  );
}

const RESEND = "A second attempt to send it was stopped before it left: connecta sends a write once.";

/**
 * The transport stopped a second dispatch of a write whose first left. The
 * words start from what the first attempt was answered; the outcome is
 * unknown whatever that was, and a 401 keeps its code and handoff (or the
 * vendor's documented refusal) as it would have without the attempt.
 */
function resend(first: Dispatch, vendor: VendorErrors<any>, options: MapOptions): ConnectorCallError {
  const answer = first.failure
    ? verdict(first.failure, vendor, options)
    : first.state === "answered" && !ok(first.status)
      ? verdict(answerOf(first), vendor, options)
      : undefined;
  if (answer && first.state === "answered" && first.status === 401) {
    const decided = unauthorized(first, answer, vendor);
    return reworded(decided, `${decided.message} ${RESEND}`);
  }
  const was =
    answer?.message ??
    `This call had already sent its write to ${vendor.provider}` +
      `${first.state === "answered" ? `, which answered HTTP ${first.status}` : ""}.`;
  return unknownWrite(
    answer && AUTH_CODES.has(answer.code) ? answer.code : "connector_call_failed",
    `${was} ${RESEND} Whether the write took effect at ${vendor.provider} is unknown: check the target before ` +
      "repeating it.",
  );
}

/**
 * A write the resource server answered 401 (Q8). A server may act before it
 * rejects a credential, so unless the vendor documents that it authenticates
 * first, the outcome is unknown and never retryable. The code is the
 * vendor's 401 verdict, kept so invocation still hands the agent
 * `authorize_connector`, whatever renewal met afterwards (a refusal, a
 * throttled or unreachable token endpoint, a cancellation). Only a renewal
 * that succeeded drops the handoff: the credential needs no recovery, and the
 * write is still unknown.
 */
function unauthorized(answer: Dispatch, error: ConnectorCallError, vendor: VendorErrors<any>): ConnectorCallError {
  if (vendor.authBeforeExecution) return error;
  if (answer.renewed) {
    return unknownWrite(
      "connector_call_failed",
      `${vendor.provider} answered this write with HTTP 401. The credential is renewed for the next call, but the ` +
        "write was not sent again, so whether it took effect is unknown: check the target before repeating it.",
    );
  }
  return unknownWrite(
    error.code,
    `${error.message} The write was sent before ${vendor.provider} rejected its credential, so whether it took ` +
      "effect is unknown: check the target before repeating it.",
  );
}

const AUTH_CODES: ReadonlySet<string> = new Set(["auth_required", "downstream_oauth_required"]);

/**
 * A failure after the call's write left: an auxiliary request's, the
 * provider's own, a second write step's. It cannot describe the write, so the
 * write's outcome is unknown and the call is not retryable as a whole. An
 * authorization verdict keeps its code and handoff; every other code becomes
 * `connector_call_failed`, so neither "wait and retry" nor "refused" reaches
 * a write that may have run.
 *
 * The write is reported unknown even when the vendor answered it with a 2xx:
 * the call failed, so the agent has no result to check against, a 2xx is one
 * request's status and not the tool's success (a later step, or the
 * provider's own check, can still find it incomplete), and counting it `ok`
 * would drop it from a program's `writes.unknown` and its reconciliation
 * facts. The words say the vendor accepted it, so reconciling it is one read.
 */
function afterWrite(
  error: ConnectorCallError,
  left: readonly Dispatch[],
  vendor: VendorErrors<any>,
): ConnectorCallError {
  const accepted = left.every((dispatch) => dispatch.state === "answered" && ok(dispatch.status) && !dispatch.failure);
  const statuses = left.map((dispatch) => dispatch.status).join(", ");
  return unknownWrite(
    AUTH_CODES.has(error.code) ? error.code : "connector_call_failed",
    accepted
      ? `${error.message} ${vendor.provider} had already accepted this call's write (HTTP ${statuses}), so it has ` +
          "probably taken effect: check the target before repeating the call."
      : `${error.message} This call had already sent its write to ${vendor.provider}, so whether the write took ` +
          "effect is unknown: check the target before repeating it.",
  );
}

/**
 * The verdict a write's recorded 401 still fixes when the caller left before
 * the call could settle (during the renewal, or while its body was read);
 * undefined otherwise, and invocation reports the cancellation as it does
 * today, an unknown outcome.
 */
export function departedVerdict(
  vendor: VendorErrors<any>,
  options: Pick<MapOptions, "classification" | "dispatches" | "withholds" | "signal">,
): ConnectorCallError | undefined {
  if (options.classification !== "write") return undefined;
  const answer = options.dispatches.find(
    (dispatch) => dispatch.write && dispatch.state === "answered" && dispatch.status === 401,
  );
  return answer ? unauthorized(answer, verdict(answerOf(answer), vendor, options), vendor) : undefined;
}

/** A recorded answer as the failure it was, from the facts the ledger kept (its body is gone). */
function answerOf(dispatch: Dispatch): StatusFailure {
  return new StatusFailure({
    status: dispatch.status ?? 0,
    headers: dispatch.headers ?? new Headers(),
    body: undefined,
    operation: dispatch.operation ?? { method: "", template: "" },
  });
}

function ok(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status <= 299;
}

function timedOut(error: ConnectorCallError): boolean {
  const code = error.details?.code;
  return error.code === "timeout" || code === "timeout" || code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT") === true;
}

/** The same verdict in other words: code, retry advice, and explicit outcome kept. */
function reworded(error: ConnectorCallError, message: string): ConnectorCallError {
  const copy = new ConnectorCallError(error.code, message, {
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.details ? { details: error.details } : {}),
    ...(error.current ? { current: error.current } : {}),
  });
  return writeOutcomeOf(error) ? Object.assign(copy, { writeOutcome: "unknown" as const }) : copy;
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
    case "ResendRefused":
      return new ConnectorCallError(
        "connector_call_failed",
        `This call already sent a write to ${vendor.provider}; a second attempt was stopped before it left.`,
        { retryable: false },
      );
    case "UnreadableBody":
      return new ConnectorCallError("connector_call_failed", vendor.unreadable, { retryable: false });
    case "StatusFailure":
      return statusVerdict(failure, vendor, options.withholds?.(failure.operation) === true);
  }
}

function statusVerdict(failure: StatusFailure, vendor: VendorErrors<any>, withheld: boolean): ConnectorCallError {
  const facts = bounded(vendor.facts(tokensOf(failure.body)));
  const headers = visibleHeaders(failure.headers, vendor.headers);
  const input: Classified = {
    status: failure.status,
    facts,
    headers,
    retryAfterMs: retryAfterMs(failure.headers),
    operation: failure.operation,
    withheld,
  };
  // Classification first, over facts and headers only.
  const { code, retryable, retryAfterMs: wait, current, words } = classified(input, vendor);
  // Then the wording. The body reaches `detail` only when this operation's
  // value-safety review lets its vendor text through.
  const detail = vendor.detail({
    status: failure.status,
    facts: displayed(facts),
    headers,
    withheld,
    ...(withheld ? {} : { body: failure.body }),
  });
  return new ConnectorCallError(code, words ? words(detail) : detail, {
    ...(retryable === undefined ? {} : { retryable }),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(current ? { current } : {}),
  });
}

function classified(input: Classified, vendor: VendorErrors<any>): Verdict {
  for (const rule of vendor.classify ?? []) {
    const decided = rule(input);
    if (decided) return decided;
  }
  const table = vendor.statuses;
  const rule =
    table[input.status] ??
    (input.status >= 500 ? (table.serverError ?? serverErrorDefault) : undefined) ??
    DEFAULTS[input.status] ??
    table.otherwise ??
    otherwiseDefault;
  return rule(input);
}
