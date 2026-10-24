// Internal HTTP failure contract (decision 0010, B.3). Unreachable from src/index.ts.
//
// Every way a kit request can fail, as a tagged error, and the one mapping
// from those to the wire `ConnectorCallError`. A provider supplies meaning
// only where meaning differs by vendor: what 401, 403, and 404 say (required,
// because the same 403 is an ungranted capability at one vendor and a token
// scope at another), which machine-readable facts its error bodies and
// headers carry, rules that cut across statuses, and its wording.
//
// Classification and wording are two steps. A vendor's `facts` reads a copy
// of the error body that keeps only tokens, finite numbers, and booleans.
// Declared public fact values and parsed numeric sources are captured before sent-secret redaction;
// wording reads a separate extraction from the redacted body. The vendor's
// rules read those facts and the reviewed `headers` allowlist, nothing
// else, and return a `Verdict`: a code and retry advice. Only after that does
// the kit build the vendor's detail line, and the verdict's `words` render
// the message from it. A rule's input has no prose to read, and when a rule
// runs, this failure's prose does not exist yet.
//
// This file decides no write's outcome. The core does (src/write-outcome.ts):
// the transport records every request in the core ledger as it leaves, and
// `api()`'s boundary hands the call's failure to `providerCallFailure`, which
// reads that ledger over the whole logical call (INV-9). What the kit adds is
// provenance, recorded where it was observed: a failure that is its own
// request's served answer is marked as that request's (`vendorRefusal`), so a
// refusing status counts only for the request that received it. Advice to
// send a call again is a segment of its own (`resendAdvice`), never part of
// the message, so output composes it only where the outcome allows.
// Q8 policy is decided once by the core's `settleWrite` (#917), from the
// ledger entries this kit forwards its matched proof and renewals to. A
// write answered 401 stays unknown; only renewal removes its handoff, and
// only a reviewed authentication-before-execution declaration proves refusal.

import { Data } from "effect";
import {
  ConnectorCallError,
  isConnectorCallErrorCode,
  resendAdvice,
  unavailableCallError,
  type ConnectorCallErrorCode,
} from "../errors.js";
import { attachFailureFacts } from "../operator-record.js";
import { vendorRefusal } from "../provider-call.js";
import { providerFailureMessage } from "../write-outcome.js";
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
 * them, before anything leaves; `first` is the permanent reservation, which may still be preparing.
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
  readonly unreadable?: true;
  readonly operation: OperationRef;
}> {}

/** A successful status whose body is not JSON. Its text never surfaces. */
export class UnreadableBody extends Data.TaggedError("UnreadableBody")<{
  readonly readFailed?: true;
  readonly unexpectedText?: true;
}> {
  constructor(options: { readonly readFailed?: true; readonly unexpectedText?: true } = {}) {
    super(options);
  }
}

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

// One completeness-checked vocabulary for the typed client boundary.
const TAGS = {
  RequestRefused: true,
  TransportFailure: true,
  RedirectRefused: true,
  ResponseTooLarge: true,
  ResendRefused: true,
  StatusFailure: true,
  UnreadableBody: true,
  Refusal: true,
} satisfies Record<HttpFailure["_tag"], true>;

export function isHttpFailure(error: unknown): error is HttpFailure {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return typeof error._tag === "string" && Object.hasOwn(TAGS, error._tag);
}

/** One machine-readable value from an error body: a code, a reason, a type. */
type Fact = string | number | boolean;
type Facts = Readonly<Record<string, Fact | ReadonlyArray<Fact> | undefined>>;
/** A reviewed response shape, without its text or any other downstream value. */
type Presence = Readonly<Record<string, { readonly present: boolean; readonly nonBlank: boolean }>>;
type PresenceReview = Readonly<
  Record<string, { readonly path: readonly string[]; readonly content: "string" | "text" }>
>;
type NumericFormat = "integer" | "seconds" | "epoch-seconds" | "retry-after";
type NumericReview = {
  readonly review: string;
  /** Delay formats yield milliseconds, capped at 24 hours; integer is the default. */
  readonly format?: NumericFormat;
} & (
  | { readonly path: readonly string[]; readonly header?: never }
  | { readonly header: string; readonly path?: never }
);

/**
 * Everything classification reads. There is no detail line and no body: a
 * rule cannot reach a vendor's prose, so it cannot branch on it.
 */
export interface Classified<F extends Facts = Facts> {
  readonly status: number;
  /** Bounded redacted facts, with declared public values preserved before redaction; lists stay complete. */
  readonly facts: F;
  readonly presence: Presence;
  /** Declared integers and bounded delays captured before redaction; never supplies wording. */
  readonly numbers: Readonly<Record<string, number | undefined>>;
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
   * nothing. Without it the message is the line itself. It never says to
   * send the call again: that is `advice`.
   */
  readonly words?: (detail: string) => string;
  /**
   * Advice to send the call again (" Wait before retrying.", "; read the
   * reason before retrying"), attached as its own segment (`resendAdvice`).
   * Output composes it only for a read or a known refusal, so it can never
   * reach a write whose outcome is unknown.
   */
  readonly advice?: string;
}

/** What `detail` may read. `body` is absent when the operation withholds vendor text. */
interface DetailInput<F extends Facts = Facts> {
  readonly status: number;
  /** Facts from the redacted body, with each list cut to its first eight entries for display. */
  readonly facts: F;
  readonly presence: Presence;
  readonly numbers: Readonly<Record<string, number | undefined>>;
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
  /**
   * Closed public values that classification may preserve before sent-secret
   * redaction, by fact name. Undeclared values are absent from that fact.
   * Wording always reads facts from the redacted body instead.
   */
  readonly factVocabulary?: Readonly<Record<string, readonly Fact[]>>;
  /** Structural text facts only: never exposes the string, including on withheld operations. */
  readonly presence?: PresenceReview;
  /**
   * Exact numeric body paths or lowercase headers read before redaction.
   * Only nonnegative integers (or retry-after HTTP-dates) survive parsing.
   * Name the standard Retry-After delay `retryAfterMs` to supply the kit's hint.
   * That name requires an explicit delay format, never the default integer format.
   * Wording reads these sources separately from the redacted response.
   */
  readonly numericFacts?: Readonly<Record<string, NumericReview>>;
  /** Reviewed recovery ids may need more than the default eight display tokens; never changes classification. */
  readonly displayFacts?: Readonly<Record<string, { readonly maxItems: number; readonly review: string }>>;
  /** Response headers rules and wording may read, by lowercase name. Every other header is invisible. */
  readonly headers?: readonly string[];
  /** One detail line for the reader, built after classification. */
  readonly detail: (input: DetailInput<F>) => string;
  /** Rules that cut across statuses, in order, before the table: the first verdict wins. */
  readonly classify?: ReadonlyArray<(input: Classified<F>) => Verdict | undefined>;
  readonly statuses: StatusTable<F>;
  /** Message for a successful status whose body is not JSON. */
  readonly unreadable: string;
  /** Complete write message; otherwise core appends unknown-outcome and check-before-repeating guidance. */
  readonly unreadableWrite?: string;
  /** Reviewed opt-in handling when a bounded body cannot be read; no additional I/O or raw causes. */
  readonly bodyFailures?: {
    readonly review: string;
    readonly statusOnly: readonly number[];
    readonly readFailed: string;
  };
  /**
   * Where the vendor documents that it authenticates a request before acting
   * on it (Q8). With it, a write answered 401 is that 401's served refusal,
   * which the core then weighs like any other; without it, the write's
   * outcome is unknown, since a server may act before it rejects a
   * credential. It only narrows: no declaration makes any other answer a
   * refusal, and a 5xx never proves a write unapplied.
   */
  readonly authBeforeExecution?: AuthBeforeExecution<F>;
  /**
   * What this vendor's failures mean for an agent, declared by review for the
   * generated Conventions (decision 0011): the code an unknown id fails with,
   * whether that code proves absence (only the vendor's documentation can
   * say so), and each documented source of `conflict`, one line each, such
   * as "HTTP 409 when the record changed since it was read". Never inferred
   * from the status table or the rules.
   */
  readonly meanings?: {
    readonly unknownId: ConnectorCallErrorCode;
    readonly provesAbsence: boolean;
    readonly conflicts: readonly string[];
  };
}

/** A trusted per-vendor declaration: the reviewer verifies the cited documentation and the narrow raw-fact predicate. */
interface AuthBeforeExecution<F extends Facts> {
  readonly evidence: string;
  readonly matches: (input: Classified<F>) => boolean;
}

/** Refuse empty evidence at connection construction (INV-11); prose is never proof by itself. */
export function validateVendorErrors(vendor: VendorErrors<any>): void {
  errorMeanings(vendor);
  captureErrorReviews(vendor);
  const proof = vendor.authBeforeExecution;
  if (proof && (typeof proof.evidence !== "string" || !proof.evidence.trim() || typeof proof.matches !== "function")) {
    throw new Error("An authBeforeExecution declaration requires nonempty evidence and a narrow raw-fact predicate.");
  }
}

// No 409 default: only a vendor that documents its meaning may name a conflict.
// The core decides refusal from the served answer's provenance, never this code.
const DEFAULTS: Readonly<Record<number, StatusRule>> = {
  400: () => ({ code: "invalid_args" }),
  422: () => ({ code: "invalid_args" }),
  429: ({ retryAfterMs: wait }) => ({ code: "rate_limited", retryAfterMs: wait }),
};

const serverErrorDefault: StatusRule = ({ retryAfterMs: wait }) => ({ code: "unavailable", retryAfterMs: wait });

const otherwiseDefault: StatusRule = () => ({ code: "connector_call_failed", retryable: false });

const TOKEN = /^[A-Za-z0-9_.:[\]-]{1,128}$/;
/** How many entries of a list the detail line sees. Classification sees them all. */
const DISPLAYED = 8;
const MAX_HEADER = 128;
const MAX_DEPTH = 32;
const MAX_WAIT_MS = 86_400_000;
const errorReviews = new WeakMap<
  object,
  {
    presence: PresenceReview;
    display: Readonly<Record<string, number>>;
    numbers: Readonly<Record<string, NumericReview>>;
    vocabulary: Readonly<Record<string, ReadonlySet<Fact>>>;
    bodyFailures?: NonNullable<VendorErrors["bodyFailures"]>;
  }
>();
/** Metadata snapshots contain no request data, promises or services. */
function captureErrorReviews(vendor: VendorErrors<any>) {
  const previous = errorReviews.get(vendor);
  if (previous) return previous;
  const presence: Record<string, { path: readonly string[]; content: "string" | "text" }> = {};
  for (const [name, review] of Object.entries(vendor.presence ?? {})) {
    if (
      !TOKEN.test(name) ||
      !Array.isArray(review.path) ||
      review.path.length === 0 ||
      review.path.length > MAX_DEPTH ||
      review.path.some((part) => typeof part !== "string" || !part) ||
      !["string", "text"].includes(review.content)
    )
      throw new Error("Error presence reviews need a name, a bounded property path and string or text content.");
    presence[name] = Object.freeze({ path: Object.freeze([...review.path]), content: review.content });
  }
  const display: Record<string, number> = {};
  for (const [name, review] of Object.entries(vendor.displayFacts ?? {})) {
    if (!TOKEN.test(name) || !Number.isSafeInteger(review.maxItems) || review.maxItems < 1 || !review.review.trim())
      throw new Error("Displayed error facts need a positive whole maxItems and a nonempty review.");
    display[name] = review.maxItems;
  }
  const numbers: Record<string, NumericReview> = {};
  for (const [name, review] of Object.entries(vendor.numericFacts ?? {})) {
    const path = review.path;
    const header = review.header;
    if (
      !TOKEN.test(name) ||
      (header === undefined
        ? !Array.isArray(path) ||
          path.length === 0 ||
          path.length > MAX_DEPTH ||
          path.some((part) => typeof part !== "string" || !part)
        : path !== undefined ||
          typeof header !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(header) ||
          header.length > MAX_HEADER) ||
      (review.format !== undefined &&
        !["integer", "seconds", "epoch-seconds", "retry-after"].includes(review.format)) ||
      (name === "retryAfterMs" && (review.format === undefined || review.format === "integer")) ||
      typeof review.review !== "string" ||
      !review.review.trim()
    )
      throw new Error(
        "Numeric error facts need a name, an exact path or lowercase header, a numeric format and a nonempty review.",
      );
    numbers[name] = Object.freeze({
      ...(header === undefined ? { path: Object.freeze([...path!]) } : { header }),
      format: review.format ?? "integer",
      review: review.review,
    });
  }
  const captured = {
    ...(vendor.bodyFailures
      ? {
          bodyFailures: (() => {
            const review = vendor.bodyFailures;
            if (
              !review.review?.trim() ||
              !review.readFailed?.trim() ||
              !Array.isArray(review.statusOnly) ||
              review.statusOnly.some(
                (status) => !Number.isInteger(status) || status < 400 || status > 599 || status === 401,
              )
            )
              throw new Error(
                "Body-failure handling needs a review, fixed wording and reviewed error statuses other than 401.",
              );
            return Object.freeze({ ...review, statusOnly: Object.freeze([...review.statusOnly]) });
          })(),
        }
      : {}),
    presence: Object.freeze(presence),
    display: Object.freeze(display),
    numbers: Object.freeze(numbers),
    vocabulary: Object.freeze(
      Object.fromEntries(
        Object.entries(vendor.factVocabulary ?? {}).map(([name, values]) => {
          if (!TOKEN.test(name) || !Array.isArray(values) || values.some((value) => boundedFact(value) === undefined))
            throw new Error(
              "Error fact vocabularies need token names and finite public token, number or boolean values.",
            );
          return [name, new Set(values)];
        }),
      ),
    ),
  };
  errorReviews.set(vendor, captured);
  return captured;
}

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
  return Object.fromEntries(
    Object.entries(facts)
      .filter(([name]) => TOKEN.test(name))
      .map(([name, value]) => [
        name,
        Array.isArray(value)
          ? value.map(boundedFact).filter((fact): fact is Fact => fact !== undefined)
          : boundedFact(value),
      ]),
  ) as F;
}

interface CapturedClassifierFacts {
  readonly vendor: VendorErrors<any>;
  readonly facts: Facts;
  readonly numbers: Readonly<Record<string, number | undefined>>;
}

const classifierFacts = new WeakMap<StatusFailure, CapturedClassifierFacts>();

function vocabularyFacts(facts: Facts, vendor: VendorErrors<any>): Facts {
  return Object.fromEntries(
    Object.entries(captureErrorReviews(vendor).vocabulary).map(([name, values]) => {
      const value = facts[name];
      return [
        name,
        Array.isArray(value)
          ? Object.freeze(value.filter((entry) => values.has(entry)))
          : value !== undefined && values.has(value as Fact)
            ? value
            : undefined,
      ];
    }),
  );
}

/** Read only declared public facts before redaction; never retain the original body or an unreviewed value. */
export function captureClassifierFacts(
  body: unknown,
  vendor: VendorErrors<any>,
  headers = new Headers(),
): CapturedClassifierFacts | undefined {
  const review = captureErrorReviews(vendor);
  const vocabulary = Object.keys(review.vocabulary).length > 0;
  if (!vocabulary && !Object.keys(review.numbers).length) return undefined;
  return {
    vendor,
    facts: vocabulary ? vocabularyFacts(bounded(vendor.facts(tokensOf(body))), vendor) : {},
    numbers: numericFacts(body, headers, review.numbers),
  };
}

/** Reject coercions and unbounded text; only parsed integers or bounded wait windows leave this function. */
function numericValue(value: unknown, format: NumericFormat): number | undefined {
  if (typeof value === "string") {
    if (value.length > MAX_HEADER) return undefined;
    const raw = value.trim();
    if (format === "retry-after" && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
      const date = Date.parse(raw);
      return Number.isFinite(date) ? Math.min(MAX_WAIT_MS, Math.max(0, date - Date.now())) : undefined;
    }
    if (!/^\d+$/.test(raw)) return undefined;
    value = Number(raw);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  const integer = Math.min(Number.MAX_SAFE_INTEGER, value);
  if (format === "integer") return integer;
  const milliseconds = integer * 1000 - (format === "epoch-seconds" ? Date.now() : 0);
  return Math.min(MAX_WAIT_MS, Math.max(0, milliseconds));
}

function numericFacts(body: unknown, headers: Headers, reviews: Readonly<Record<string, NumericReview>>) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(reviews).map(([name, review]) => {
        let value = review.header === undefined ? body : headers.get(review.header);
        for (const part of review.path ?? [])
          value =
            value !== null && typeof value === "object" && Object.hasOwn(value, part)
              ? (value as Record<string, unknown>)[part]
              : undefined;
        return [name, numericValue(value, review.format ?? "integer")];
      }),
    ),
  );
}

/** Keep classification facts off the failure's enumerable data and its redacted detail body. */
export function withClassifierFacts(
  failure: StatusFailure,
  captured: CapturedClassifierFacts | undefined,
): StatusFailure {
  if (captured) classifierFacts.set(failure, captured);
  return failure;
}

/** The detail line gets eight list entries by default; reviewed recovery fields retain their fixed bound. */
function displayed<F extends Facts>(facts: F, vendor: VendorErrors<any>): F {
  const { display } = captureErrorReviews(vendor);
  return Object.fromEntries(
    Object.entries(facts).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.slice(0, display[name] ?? DISPLAYED) : value,
    ]),
  ) as F;
}

function visibleHeaders(headers: Headers, allowed: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
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

export interface MapOptions {
  /** The call's served classification (the Classification service), never the HTTP method. */
  readonly classification: "read" | "write";
  /** Every resource request of this call, as the transport recorded it (the Dispatches service). */
  readonly dispatches: ReadonlyArray<Dispatch>;
  /** Whether an operation withholds vendor error text (the connection's ResultSafety). */
  readonly withholds?: (operation: OperationRef) => boolean;
  readonly signal?: AbortSignal | undefined;
}

/** Shed a defect's text and typed identity when any request withholds vendor text. */
export function withheldDefect(
  defect: unknown,
  options: Pick<MapOptions, "dispatches"> & { readonly withholds: (operation: OperationRef) => boolean },
  // Custom probe programs may send outside this ledger, so always withhold their defects.
  always = false,
): unknown {
  try {
    if (!always && !options.dispatches.some(({ operation }) => operation && options.withholds(operation)))
      return defect;
  } catch {
    // A broken visibility hook cannot authorize exposing a defect's text.
  }
  return new Error("A provider hook withholding vendor text failed.");
}

/**
 * The single mapping from a kit failure to what an agent reads. It decides
 * no write: the core does, from its ledger (`providerCallFailure` at the
 * `api()` boundary, and Q8's `settleWrite` once per logical call). A failure
 * that is its own request's served answer carries that request as its
 * provenance (`vendorRefusal`, which holds only for a refusing status: a 4xx
 * other than 408). A write call records each 401 its requests met
 * ({@link recordUnauthorized}) and words a blocked resend.
 */
export function toConnectorCallError(
  failure: HttpFailure,
  vendor: VendorErrors<any>,
  options: MapOptions,
): ConnectorCallError {
  if (options.classification === "write") recordUnauthorized(vendor, options);
  // A served read can still issue a physical write (POST or a method override).
  // A blocked resend always reports that reservation's original attempt.
  return failure._tag === "ResendRefused"
    ? resent(failure.first, vendor, options)
    : answered(failure, verdict(failure, vendor, options), options.dispatches);
}

/**
 * Provenance (b), recorded where it was observed: `error` is its own
 * request's answer, so it carries that request's core ledger entry. The core
 * counts a refusal only for a refusing status on that entry, and only when it
 * is the one request the whole logical call sent.
 */
function answered(failure: HttpFailure, error: ConnectorCallError, dispatches: ReadonlyArray<Dispatch>) {
  const own = dispatches.find((dispatch) => dispatch.failure === failure);
  return own?.request ? vendorRefusal(error, own.request) : error;
}

const RESEND = "A second attempt to send it was stopped before it left: connecta sends a write once.";

/**
 * The transport stopped a second dispatch of a write. The call reports what
 * the first attempt was answered, with that attempt's provenance, so the
 * core keeps a sole served refusal known and anything else that left unknown.
 * A first attempt that never left reports its own failure.
 */
function resent(first: Dispatch, vendor: VendorErrors<any>, options: MapOptions): ConnectorCallError {
  const own = first.failure ?? (first.state === "answered" && !ok(first.status) ? answerOf(first) : undefined);
  if (own === undefined) {
    return new ConnectorCallError(
      "connector_call_failed",
      !first.write || first.request?.auxiliary
        ? `The ${JSON.stringify(first.step ?? "write")} write step's slot is already taken. ` +
            `Declare a separate writeSteps entry for each request the tool must send. ${RESEND}`
        : `This call had already sent its write to ${vendor.provider}` +
            `${first.state === "answered" ? `, which answered HTTP ${first.status}` : ""}. ${RESEND}`,
      { retryable: false },
    );
  }
  const error = verdict(own, vendor, options, first);
  const marked = first.request ? vendorRefusal(error, first.request) : error;
  return providerFailureMessage(marked, `${marked.message} ${RESEND}`);
}

/**
 * Record, on the core ledger entry of each write request answered 401, the
 * facts Q8 is decided from (`settleWrite`): that answer's own vendor verdict
 * (`vendorRefusal`, from its recorded answer even when no body was read), and
 * whether the vendor's reviewed `authBeforeExecution` evidence covers it
 * (`ProviderRequest.authBeforeExecution`). It decides nothing: a write's
 * outcome, its code and its handoff are the core's.
 */
export function recordUnauthorized(
  vendor: VendorErrors<any>,
  options: Pick<MapOptions, "dispatches" | "withholds" | "signal">,
): void {
  const proof = vendor.authBeforeExecution;
  for (const dispatch of options.dispatches) {
    if (!dispatch.write || dispatch.state !== "answered" || dispatch.status !== 401 || !dispatch.request) continue;
    const recorded = recordedAnswer(dispatch);
    if (
      proof !== undefined &&
      proof.evidence.trim().length > 0 &&
      proof.matches(classificationInput(recorded, vendor, options.withholds?.(recorded.operation) === true))
    )
      dispatch.request.authBeforeExecution = true;
    vendorRefusal(verdict(recorded, vendor, options), dispatch.request);
  }
}

/** Use a parsed body only when it belongs to this recorded status; ceilings and later failures cannot supply its code. */
function recordedAnswer(dispatch: Dispatch): StatusFailure {
  return dispatch.failure?._tag === "StatusFailure" && dispatch.failure.status === dispatch.status
    ? dispatch.failure
    : answerOf(dispatch);
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

function verdict(
  failure: HttpFailure,
  vendor: VendorErrors<any>,
  options: Pick<MapOptions, "withholds" | "signal" | "dispatches"> & Partial<Pick<MapOptions, "classification">>,
  dispatch = options.dispatches.find((entry) => entry.failure === failure),
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
    case "ResponseTooLarge": {
      if (
        dispatch?.status !== undefined &&
        captureErrorReviews(vendor).bodyFailures?.statusOnly.includes(dispatch.status)
      ) {
        // The ceiling discarded the body, not the answered status. Only opted-in
        // statuses use the vendor's status-only rules; 401/Q8 stays unchanged.
        const mapped = statusVerdict(
          new StatusFailure({
            status: dispatch.status,
            headers: new Headers(),
            body: undefined,
            unreadable: true,
            operation: dispatch.operation ?? { method: "", template: "" },
          }),
          vendor,
          options.withholds?.(dispatch.operation ?? { method: "", template: "" }) === true,
          !dispatch.write,
        );
        return providerFailureMessage(mapped, failure.detail);
      }
      return attachFailureFacts(
        new ConnectorCallError("connector_call_failed", failure.detail, { retryable: false }),
        dispatch?.status === undefined ? {} : { httpStatus: dispatch.status },
      );
    }
    case "ResendRefused":
      return new ConnectorCallError(
        "connector_call_failed",
        `This call already sent a write to ${vendor.provider}; a second attempt was stopped before it left.`,
        { retryable: false },
      );
    case "UnreadableBody": {
      const unreadable = failure.readFailed
        ? (captureErrorReviews(vendor).bodyFailures?.readFailed ?? vendor.unreadable)
        : failure.unexpectedText
          ? `${vendor.provider} returned unexpected text/HTML for a JSON response.`
          : vendor.unreadable;
      return new ConnectorCallError(
        "connector_call_failed",
        options.classification === "write" && dispatch?.request?.auxiliary !== true
          ? (!failure.unexpectedText && vendor.unreadableWrite) ||
              `${unreadable} Whether the write took effect is unknown; check the target before repeating it.`
          : unreadable,
        { retryable: false },
      );
    }
    case "StatusFailure":
      return statusVerdict(
        failure,
        vendor,
        options.withholds?.(failure.operation) === true,
        options.dispatches.some((dispatch) => dispatch.failure === failure && !dispatch.write),
      );
  }
}

function statusVerdict(
  failure: StatusFailure,
  vendor: VendorErrors<any>,
  withheld: boolean,
  read: boolean,
): ConnectorCallError {
  const input = classificationInput(failure, vendor, withheld);
  const { headers, presence } = input;
  // Classification first, over facts and headers only.
  const decided = classified(input, vendor);
  // The transport already applied the core's positive-read method/header rule.
  // A 421 advises an explicit retry only for that request; no resend happens here.
  const {
    code,
    retryable,
    retryAfterMs: wait,
    current,
    words,
    advice,
  } = failure.status === 421 && read ? { ...decided, code: "unavailable" as const, retryable: true } : decided;
  // Then the wording. The body reaches `detail` only when this operation's
  // value-safety review lets its vendor text through.
  const detail = vendor.detail({
    status: failure.status,
    facts: displayed(bounded(vendor.facts(tokensOf(failure.body))), vendor),
    presence,
    numbers: numericFacts(failure.body, failure.headers, captureErrorReviews(vendor).numbers),
    headers,
    withheld,
    ...(withheld ? {} : { body: failure.body }),
  });
  const error = new ConnectorCallError(code, words ? words(detail) : detail, {
    ...(retryable === undefined ? {} : { retryable }),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(current ? { current } : {}),
  });
  attachFailureFacts(error, { httpStatus: failure.status });
  return advice === undefined ? error : resendAdvice(error, advice);
}

/** Only membership and whitespace are examined; no text is copied into classification. */
function structuralPresence(body: unknown, reviews: PresenceReview | undefined): Presence {
  return Object.fromEntries(
    Object.entries(reviews ?? {}).map(([name, review]) => {
      let value = body;
      for (const part of review.path) {
        value =
          value !== null && typeof value === "object" && Object.hasOwn(value, part)
            ? (value as Record<string, unknown>)[part]
            : undefined;
      }
      const strings =
        typeof value === "string"
          ? [value]
          : review.content === "text" && Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === "string")
            : [];
      return [
        name,
        { present: strings.some((text) => text.length > 0), nonBlank: strings.some((text) => text.trim().length > 0) },
      ];
    }),
  );
}

function classificationInput(failure: StatusFailure, vendor: VendorErrors<any>, withheld: boolean): Classified {
  const redacted = bounded(vendor.facts(tokensOf(failure.body)));
  const captured = classifierFacts.get(failure);
  const numbers =
    captured?.vendor === vendor
      ? captured.numbers
      : numericFacts(failure.body, failure.headers, captureErrorReviews(vendor).numbers);
  return {
    status: failure.status,
    facts: { ...redacted, ...(captured?.vendor === vendor ? captured.facts : vocabularyFacts(redacted, vendor)) },
    presence: structuralPresence(failure.body, captureErrorReviews(vendor).presence),
    numbers,
    headers: visibleHeaders(failure.headers, vendor.headers),
    retryAfterMs: numbers["retryAfterMs"],
    operation: failure.operation,
    withheld,
  };
}

/** The reviewed meanings a vendor declares for the generated Conventions; see `VendorErrors.meanings`. */
export type ErrorMeanings = NonNullable<VendorErrors["meanings"]>;

/**
 * A frozen copy of a vendor's declared meanings, refused when inconsistent
 * (INV-11): `not_found` exactly when the vendor tells absence from a
 * permission gap, and each conflict source a one-line documented fact.
 */
export function errorMeanings(vendor: VendorErrors<any>): ErrorMeanings | undefined {
  const declared = vendor.meanings;
  if (declared === undefined) return undefined;
  const { unknownId, provesAbsence, conflicts } = declared;
  if (
    !isConnectorCallErrorCode(unknownId) ||
    typeof provesAbsence !== "boolean" ||
    (unknownId === "not_found") !== provesAbsence ||
    !Array.isArray(conflicts) ||
    conflicts.some((fact) => typeof fact !== "string" || !fact.trim() || /[\r\n]/.test(fact))
  ) {
    throw new Error(
      `${vendor.provider} error meanings need unknownId "not_found" exactly when provesAbsence is true, and one-line conflict facts.`,
    );
  }
  return Object.freeze({ unknownId, provesAbsence, conflicts: Object.freeze([...conflicts]) });
}

function classified(input: Classified, vendor: VendorErrors<any>): Verdict {
  for (const rule of vendor.classify ?? []) {
    const decided = rule(input);
    if (decided) return decided;
  }
  const table = vendor.statuses;
  const rule =
    table[input.status] ??
    (input.status >= 500 && input.status <= 599 ? (table.serverError ?? serverErrorDefault) : undefined) ??
    DEFAULTS[input.status] ??
    table.otherwise ??
    otherwiseDefault;
  return rule(input);
}
