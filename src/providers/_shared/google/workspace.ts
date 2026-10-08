/**
 * Google Workspace access as the person calling, with no per-user consent:
 * a service account with domain-wide delegation mints a token *as* the user
 * the deployment maps the admitted caller to. The foundation each Workspace
 * product provider (`gmail()` first) builds on; never its own export.
 *
 * Whose account. `ConnectorContext` carries no identity, and a deployment's
 * own connector never learns its caller (`src/connector-caller.ts`). A
 * maintained Workspace provider is the second sanctioned reader of that
 * channel (PRINCIPLES.md INV-3, #678): deployment config supplies
 * `subject`, a function from the admitted `AuthenticatedIdentity` to a
 * Workspace address, and the provider reads the identity core attached beside
 * the context. No tool argument, header, or program can name the subject —
 * every product's base URL is confined beneath `users/me`, or its product's
 * equivalent, so the token's subject is the only account a request reaches.
 * A call with no admitted caller, one an open deployment admitted without
 * authentication (the mapping is never asked about it), or one the mapping
 * answers `undefined` for, fails `auth_required` before anything leaves the
 * host. Catalogs need no subject: tools are static.
 *
 * A product builds on three calls: `workspaceConnection(factory, options)` at
 * construction, `googleWorkspaceClient({...})` once, and the client's `json`,
 * `bytes`, or `text` per request — plus `googleReasonsOf(error)` where a
 * product must decide on a Google reason the shared mapping leaves generic.
 * Nothing else here is the products' to touch.
 *
 * Setup, once per Workspace, shared by every product:
 *
 * 1. In a Google Cloud project, enable each product's API (Gmail API, Google
 *    Drive API, …).
 * 2. Create a service account. It needs no IAM role: delegation, not project
 *    permission, is what reaches user data.
 * 3. Create a JSON key for it. An organization policy
 *    (`iam.disableServiceAccountKeyCreation`, on by default for newer
 *    organizations) may refuse; an org policy administrator can override it
 *    for this project alone.
 * 4. Copy the service account's numeric client ID (Details → Advanced
 *    settings, or the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new, with
 *    that client ID and *exactly* the scopes each product provider lists, comma
 *    separated. A grant can take up to 24 hours to apply.
 * 6. Pass the key to the provider from the deployment's secrets, and map the
 *    admitted identity to a Workspace address in `subject`.
 */
import { guardedFetch, retryAfterMs, type GuardedRequest } from "../../../connectors/guarded-fetch.js";
import { keys, optionsOf } from "../../../config-schema.js";
import { callerOf } from "../../../connector-caller.js";
import { CALL_ADMISSION } from "../../../connectors/option-shapes.js";
import { ConnectorCallError } from "../../../errors.js";
import type { AuthenticatedIdentity, ConnectorCallAdmissionPolicy, ConnectorContext } from "../../../types.js";
import {
  delegatedToken,
  forgetDelegatedToken,
  parseServiceAccount,
  type DelegatedTokenRequest,
  type GoogleServiceAccount,
  type ServiceAccountKey,
} from "./service-account.js";

export type { GoogleServiceAccount } from "./service-account.js";

/**
 * Whose Workspace account a call acts as.
 *
 * A function receives the identity an inbound auth provider authenticated for
 * this request and returns that person's Workspace address, or `undefined`
 * for a caller who has none — that call then fails closed. It is never called
 * for an open deployment's anonymous requests, nor for a call no request
 * admitted. It may be async, for a directory lookup (a Clerk user id to an
 * email, say), and receives the call's cancellation signal for that; it runs
 * once per tool call and should cache what it fetches. A string is one fixed
 * account for every caller who can reach the connector, for a shared mailbox
 * or scheduled work with no caller; limit who reaches it with
 * `identity.connectorAccess`.
 */
export type GoogleWorkspaceSubject =
  | string
  | ((
      identity: Readonly<AuthenticatedIdentity>,
      context: GoogleSubjectContext,
    ) => string | undefined | Promise<string | undefined>);

/** What a subject mapping is told about the call it resolves for. */
export interface GoogleSubjectContext {
  /** The call's cancellation, for an async directory lookup to honor. */
  readonly signal?: AbortSignal;
}

/** Options every Workspace product provider shares. */
export interface GoogleWorkspaceOptions {
  /** What this connection is for, appended to the maintained guide. */
  purpose: string;
  /**
   * The delegated service account: `{ clientEmail, privateKey }` from its
   * JSON key, or the key file's whole JSON text. From deployment secrets,
   * never a literal in source. One key serves every Workspace connector.
   */
  serviceAccount: GoogleServiceAccount | string;
  /** Whose account each call acts as; see {@link GoogleWorkspaceSubject}. */
  subject: GoogleWorkspaceSubject;
  /** Human-readable display name. */
  title?: string;
  /** Organization-specific conventions appended to the maintained guide. */
  instructions?: string;
  /**
   * Optional per-runtime call-admission policy. Google meters Workspace APIs
   * per user and per project, so none is declared by default.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** API base override for a proxy or test double. */
  baseUrl?: string;
}

/** The closed options every Workspace provider accepts; see `assertKnownOptions`. */
export const GOOGLE_WORKSPACE_OPTIONS = optionsOf<GoogleWorkspaceOptions>()({
  ...keys("purpose", "subject", "title", "instructions", "maxResultBytes", "baseUrl"),
  // A string is the key's JSON; only the object form has keys to check.
  serviceAccount: optionsOf<GoogleServiceAccount>()(keys("clientEmail", "privateKey", "clientId")),
  callAdmission: CALL_ADMISSION,
});

/** The checked, construction-time half of {@link GoogleWorkspaceOptions}. */
export interface WorkspaceConnection {
  purpose: string;
  account: ServiceAccountKey;
  subject: GoogleWorkspaceSubject;
}

/** A plausible mailbox: one `@`, no whitespace or control characters. */
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** Validate the shared options at construction; throws on a structural mistake. */
export function workspaceConnection(factory: string, options: GoogleWorkspaceOptions): WorkspaceConnection {
  const purpose = options?.purpose?.trim();
  if (!purpose) throw new Error(`${factory}() requires a non-empty purpose.`);
  const account = parseServiceAccount(`${factory}()`, options.serviceAccount);
  const subject = options.subject;
  if (typeof subject === "string") {
    if (!ADDRESS.test(subject.trim())) {
      throw new Error(`${factory}() subject must be a Workspace email address or a function of the caller.`);
    }
    return { purpose, account, subject: subject.trim() };
  }
  if (typeof subject !== "function") {
    throw new Error(
      `${factory}() requires subject: a function from the admitted identity to a Workspace address, or one fixed address. Delegated access never guesses whose account to open.`,
    );
  }
  return { purpose, account, subject };
}

/**
 * The Workspace address this call acts as, resolved from config and the
 * admitted caller only. Throws before any network call when there is none.
 */
async function subjectFor(provider: string, subject: GoogleWorkspaceSubject, ctx: ConnectorContext): Promise<string> {
  if (typeof subject === "string") return subject;
  const caller = callerOf(ctx);
  if (!caller) {
    throw new ConnectorCallError(
      "auth_required",
      `${provider} acts as the signed-in Workspace user, and this call has no admitted caller (a scheduled run, or a context no request admitted). Use a fixed subject for work with no caller.`,
    );
  }
  // An open deployment admits every request as the anonymous actor. That is
  // a caller, but not anyone, and the mapping never gets to decide otherwise.
  if (!caller.authenticated) {
    throw new ConnectorCallError(
      "auth_required",
      `${provider} acts as the signed-in Workspace user, and this deployment admitted the call without authentication. Configure inbound auth, or a fixed subject for shared use.`,
    );
  }
  let mapped: string | undefined;
  try {
    mapped = await subject(caller.identity, ctx.signal ? { signal: ctx.signal } : {});
  } catch (cause) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    throw new ConnectorCallError(
      "connector_call_failed",
      `The deployment's ${provider} subject mapping threw while resolving this caller's Workspace account.`,
      { retryable: false, cause },
    );
  }
  if (mapped === undefined) {
    throw new ConnectorCallError(
      "auth_required",
      `This caller has no Google Workspace account mapped for ${provider}. An operator maps signed-in identities to Workspace addresses in the deployment's subject config; nothing a call sends can choose one.`,
    );
  }
  if (typeof mapped !== "string" || !ADDRESS.test(mapped.trim())) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `The deployment's ${provider} subject mapping returned something that is not an email address.`,
      { retryable: false },
    );
  }
  return mapped.trim();
}

// --- API failures ------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The machine-readable reasons in a Google API error body: the legacy
 * `errors[].reason`, the AIP-193 `details[].reason`, and the canonical
 * `status`. Classification reads these and nothing else; `message` is prose
 * for the reader.
 */
function reasonsOf(error: Record<string, unknown>): Set<string> {
  const reasons = new Set<string>();
  for (const entry of [...asArray(error["errors"]), ...asArray(error["details"])]) {
    const reason = asRecord(entry)["reason"];
    if (typeof reason === "string") reasons.add(reason);
  }
  if (typeof error["status"] === "string") reasons.add(error["status"]);
  return reasons;
}

/** How a product reads an HTTP 404 — see H11. */
type NotFoundMeaning = "absent" | "ambiguous";

interface FailureContext {
  provider: string;
  /** The API's display name in the Cloud console, for "enable the … API". */
  api: string;
  scopes: readonly string[];
  notFound: NotFoundMeaning;
}

/** The canonical and legacy spellings of a refused precondition. */
const PRECONDITION_REASONS = ["FAILED_PRECONDITION", "failedPrecondition"];
/** Concurrency aborts, which a revision-checked write also answers with. */
const ABORTED_REASONS = ["ABORTED", "aborted"];

/** A reason token as Google spells one; anything else is not passed on. */
const REASON_TOKEN = /^[A-Za-z0-9_.]{1,64}$/;
/** More than this many reasons on one error is noise, not information. */
const MAX_REASONS = 8;

/** Google's reasons for each failure this layer mapped, beside the error. */
const googleReasons = new WeakMap<ConnectorCallError, readonly string[]>();

/**
 * Google's machine-readable reasons for a failure the shared client mapped:
 * `errors[].reason`, `details[].reason`, and the canonical `status`, in that
 * order, deduplicated, at most eight, and only tokens of `[A-Za-z0-9_.]` up to
 * 64 characters — never a message or any other part of the payload. An empty
 * array for anything else, including a failure that never reached Google.
 *
 * For a product that needs a decision the shared mapping does not make, such
 * as Drive telling `cannotDownloadAbusiveFile` from another refusal. Classify
 * on these, never on the error's message.
 */
export function googleReasonsOf(error: unknown): readonly string[] {
  return error instanceof ConnectorCallError ? (googleReasons.get(error) ?? []) : [];
}

/**
 * How far a failed request got, for a product that must decide whether its
 * write may have landed:
 *
 * - `before-send`: nothing left connecta — no caller, no mapped account, a
 *   refused token, a local refusal. Nothing happened downstream.
 * - `awaiting-response`: the request was sent and no HTTP status came back.
 *   Google may or may not have applied it.
 * - `reading-body`: Google answered 2xx — it accepted the request — and the
 *   reply could not be used. A write probably applied.
 * - `redirected`: Google answered 3xx, which is never followed. It shows
 *   neither that a write applied nor that it did not: outcome unknown.
 * - `server-error`: Google answered a non-idempotent write with a 5xx,
 *   whatever reason it named. It may have committed before failing, so the
 *   outcome is unknown.
 * - `refused`: Google answered with a 4xx, or a read or idempotent write
 *   with a 5xx. Nothing to repeat blindly: a 4xx applied nothing, and a
 *   repeated read or idempotent write is harmless.
 */
interface GoogleOutcome {
  /** Whether the request left connecta for Google's API. */
  readonly dispatched: boolean;
  /** The HTTP status Google answered with, when one arrived. */
  readonly status?: number;
  readonly phase: "before-send" | "awaiting-response" | "reading-body" | "redirected" | "server-error" | "refused";
}

/** What one attempt saw, as it happened. */
interface SendFacts {
  dispatched: boolean;
  status?: number;
  /** The answer's headers, kept for an error status no mapper got to read. */
  headers?: Headers;
  /** Google answered with an error status, which the mapper classified. */
  refused?: boolean;
  /** Google answered a non-idempotent write with a 5xx. */
  serverError?: boolean;
}

const googleOutcomes = new WeakMap<object, GoogleOutcome>();

function outcome<T>(error: T, facts: GoogleOutcome): T {
  if (error !== null && typeof error === "object") googleOutcomes.set(error, Object.freeze({ ...facts }));
  return error;
}

/**
 * How far the request behind a failure from `json`, `bytes`, or `text` got —
 * see {@link GoogleOutcome}. `undefined` for anything the client did not
 * throw. Read it beside the error, the way `googleReasonsOf` is read; the
 * error itself already carries the right retry verdict.
 */
export function googleOutcomeOf(error: unknown): GoogleOutcome | undefined {
  return error !== null && typeof error === "object" ? googleOutcomes.get(error) : undefined;
}

function apiFailure(
  context: FailureContext,
  status: number,
  headers: Headers,
  payload: unknown,
  options: GoogleRequestOptions,
): ConnectorCallError {
  const failure = classifyApiFailure(context, status, headers, payload, options);
  const error = asRecord(asRecord(payload)["error"]);
  const reasons = [...reasonsOf(error)].filter((reason) => REASON_TOKEN.test(reason)).slice(0, MAX_REASONS);
  googleReasons.set(failure, Object.freeze(reasons));
  return failure;
}

function classifyApiFailure(
  context: FailureContext,
  status: number,
  headers: Headers,
  payload: unknown,
  options: GoogleRequestOptions,
): ConnectorCallError {
  const { provider, api, scopes } = context;
  const error = asRecord(asRecord(payload)["error"]);
  const message = typeof error["message"] === "string" ? error["message"].trim().slice(0, 500) : "";
  const detail = message ? `${provider}: ${message}` : `${provider} returned HTTP ${status}.`;
  const reasons = reasonsOf(error);
  const precondition = PRECONDITION_REASONS.some((reason) => reasons.has(reason));
  // Order matters. Google's own specific reasons decide first, whatever the
  // status and whatever the request asked for: a guarded write refused
  // because the API is off, or because of a quota, must not read as "re-read
  // and retry". Only a refused precondition or an abort with nothing more
  // specific to say is left for the revision guard, then for the status.
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} Google rejected a freshly minted delegated token. The domain-wide delegation grant or the service account may have been revoked.`,
    );
  }
  // The API is off in the service account's project.
  if (reasons.has("accessNotConfigured") || reasons.has("SERVICE_DISABLED")) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} The ${api} is not enabled in the service account's Google Cloud project; an operator enables it there.`,
      { retryable: false },
    );
  }
  if (
    status === 429 ||
    reasons.has("rateLimitExceeded") ||
    reasons.has("userRateLimitExceeded") ||
    reasons.has("RATE_LIMIT_EXCEEDED")
  ) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} Google meters this API per user and per project; wait before retrying.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (reasons.has("insufficientPermissions") || reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} The delegated token lacks a scope this call needs. The Admin console's domain-wide delegation entry must list exactly: ${scopes.join(",")}.`,
    );
  }
  // Where Google names the refusal precisely, so does the message.
  if (reasons.has("exportSizeLimitExceeded")) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} The item is larger than Google will export in this format. Download the original file instead, or export a smaller part.`,
      { retryable: false },
    );
  }
  if (reasons.has("domainPolicy")) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} A Workspace domain policy forbids this action for this account; only a Workspace administrator can change that.`,
      { retryable: false },
    );
  }
  if (reasons.has("insufficientFilePermissions") || reasons.has("forbidden")) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} This account does not have the permission on this item that the action needs — it may be shared view-only, or not shared with this user. Its owner can grant more.`,
      { retryable: false },
    );
  }
  // A write that named the revision it was made against hears "the item moved
  // on" as a refused precondition or an abort. Fixed words, so no provider
  // ever matches on Google's prose or on this file's.
  if (
    options.revisionGuarded === true &&
    (status === 400 || status === 409) &&
    (precondition || ABORTED_REASONS.some((reason) => reasons.has(reason)))
  ) {
    return new ConnectorCallError(
      "conflict",
      `${provider} refused the write because the item changed after the revision it named. Re-read it for the current revision, reapply the change, and retry.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} Google refused the request; the account may lack access to this item, or a Workspace policy may block it. Google does not say which. Ask the item owner to grant access or a Workspace administrator to review the policy.`,
      { retryable: false },
    );
  }
  if (status === 404) {
    return context.notFound === "absent"
      ? new ConnectorCallError("not_found", `${detail} Re-read the id from a list or search tool.`)
      : new ConnectorCallError(
          "connector_call_failed",
          `${detail} The id is unknown or not visible to this account; Google does not distinguish them.`,
          { retryable: false },
        );
  }
  // Google uses the same reason for a product switched off for this user
  // (Gmail's "Mail service not enabled") and for a stale write, so the
  // classification asserts neither; Google's own message says which.
  if (status === 400 && precondition) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} Google refused the request's precondition; its message says which.`,
      { retryable: false },
    );
  }
  if (status === 400 || status === 422) {
    return new ConnectorCallError("invalid_args", detail);
  }
  if (status >= 500) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `${detail} Google is failing upstream.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError("connector_call_failed", detail, { retryable: false });
}

// --- Client ----------------------------------------------------------------------

/** What a Workspace product needs to reach its API as the calling user. */
export interface GoogleWorkspaceClientOptions {
  /** Product name in messages: "Gmail", "Google Drive". */
  provider: string;
  /** The API's console name, for an "enable the API" message: "Gmail API". */
  api: string;
  /**
   * Absolute base URL, confined to the delegated user's own resources — for
   * Gmail, `…/gmail/v1/users/me` — so no path can address another account.
   */
  baseUrl: string;
  /** This product's scopes, and only these; the DWD grant must list them. */
  scopes: readonly string[];
  /** Response ceiling in bytes. */
  maxResponseBytes: number;
  /** H11: whether this API's 404 means absence or may hide a permission gap. */
  notFound: NotFoundMeaning;
  connection: WorkspaceConnection;
}

/** A non-JSON response body, read under the product's byte ceiling. */
interface GoogleBytes {
  bytes: Uint8Array;
  /** The response's `Content-Type`, when it sent one. */
  contentType: string | undefined;
  /**
   * Whether the body went on past what was kept. Only a request with
   * `maxBytes` keeps less than the whole body, so without it this is false.
   */
  truncated: boolean;
  /** The HTTP status: 200, 206 for an honored Range, 416 for an empty file. */
  status: number;
  /** The response's `Content-Range`, when it sent one. */
  contentRange: string | undefined;
}

/** A text response body, decoded in the charset its `Content-Type` names. */
interface GoogleText {
  text: string;
  contentType: string | undefined;
  truncated: boolean;
  status: number;
  contentRange: string | undefined;
}

/** {@link GoogleRequestOptions}, plus a bound on how much of the body to read. */
interface GoogleReadOptions extends GoogleRequestOptions {
  /**
   * Read at most this many bytes of the body: the result retains at most
   * `maxBytes` (+1 to detect overflow, reported as `truncated`) and may
   * consume at most one extra transport chunk from the stream; the rest is
   * cancelled unread. A declared length past the client's ceiling is
   * then no reason to refuse; the ceiling still bounds the read. With it set,
   * a 416 carrying `Content-Range: bytes *\/0` — a Range request against an
   * empty file — answers an empty result with that status, not a failure.
   * A whole number of bytes, zero or more.
   */
  maxBytes?: number;
}

/**
 * A product's request path to its API, as the calling user. Every method
 * resolves the subject once per call context, sends the cached or a freshly
 * minted token, maps Google's failures by what the caller does next, and
 * answers a 401 with one fresh token and one replay — safe for a write too,
 * since a 401 is a refusal before the request did anything. Because of that
 * replay a `rawBody` must be sendable twice: a `ReadableStream` is refused
 * with a `TypeError` before any request; strings, bytes, Blobs, FormData, and
 * URLSearchParams are fine.
 */
export interface GoogleWorkspaceClient {
  /** One JSON request; the parsed body, `undefined` for an empty one. */
  json(request: GuardedRequest, ctx: ConnectorContext, options?: GoogleRequestOptions): Promise<unknown>;
  /**
   * One request whose answer is not JSON — a download, an export — as bytes,
   * bounded by `maxResponseBytes`. `accept` is sent as `Accept`.
   */
  bytes(
    request: GuardedRequest,
    ctx: ConnectorContext,
    accept?: string,
    options?: GoogleReadOptions,
  ): Promise<GoogleBytes>;
  /**
   * As {@link bytes}, decoded as text in the response's declared charset. A
   * truncated prefix drops a code point the cut left incomplete.
   */
  text(
    request: GuardedRequest,
    ctx: ConnectorContext,
    accept?: string,
    options?: GoogleReadOptions,
  ): Promise<GoogleText>;
}

/** How one request's failures read, beyond the product's defaults. */
interface GoogleRequestOptions {
  /**
   * The request is a write that names the revision it was made against —
   * Docs, Slides, or Forms `writeControl.requiredRevisionId`. Google answers
   * a stale one with HTTP 400 or 409 carrying FAILED_PRECONDITION or
   * ABORTED, which then maps to `conflict` with fixed text telling the agent
   * to re-read for the current revision and retry. Without it, such a refusal
   * stays `connector_call_failed`, since the same reason also means things
   * like a product switched off for the user.
   */
  revisionGuarded?: boolean;
  /**
   * Sending this write twice leaves the same state as sending it once — a
   * PUT of a whole resource, a Sheets `values.update` of fixed cells. Only
   * then does a 5xx on a write stay a retryable `unavailable`; otherwise its
   * outcome is unknown and it is not retried. Reads are always idempotent.
   */
  idempotent?: boolean;
}

/** The token the API refused, carried out of the mapper for one replay. */
class TokenRejected extends Error {
  constructor(readonly failure: ConnectorCallError) {
    super(failure.message);
  }
}

/** The parts of a guarded response the client reads. */
interface ReadableResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  jsonResult(): Promise<{ value: unknown } | { parseError: unknown }>;
  prefix(maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }>;
}

/** A Range request against an empty file: Google's verified "nothing here". */
function isEmptyRange(response: ReadableResponse): boolean {
  return response.status === 416 && /^bytes \*\/0$/i.test(response.headers.get("content-range")?.trim() ?? "");
}

function charsetOf(contentType: string | undefined): string {
  return /charset="?([^";\s]+)"?/i.exec(contentType ?? "")?.[1] ?? "utf-8";
}

/** Build the delegated, confined, Google-error-mapped transport for one product. */
export function googleWorkspaceClient(options: GoogleWorkspaceClientOptions): GoogleWorkspaceClient {
  const { provider, scopes, connection } = options;
  const failure: FailureContext = {
    provider,
    api: options.api,
    scopes,
    notFound: options.notFound,
  };
  // One resolution per call context: a tool that sends several requests acts
  // as one account throughout, and the mapping runs once rather than per
  // request. The context dies with its call, and so does the entry.
  const subjects = new WeakMap<ConnectorContext, Promise<string>>();
  const tokenRequest = async (ctx: ConnectorContext): Promise<DelegatedTokenRequest> => {
    let subject = subjects.get(ctx);
    if (!subject) {
      subject = subjectFor(provider, connection.subject, ctx);
      subjects.set(ctx, subject);
    }
    return { account: connection.account, subject: await subject, scopes };
  };
  // The transport is bound to one token, so the request that a 401 answers
  // names exactly the token to forget. Building one validates the base URL
  // and ceiling at construction, where a structural mistake belongs.
  const transport = (token: string, facts: SendFacts = { dispatched: false }) =>
    guardedFetch({
      provider,
      baseUrl: options.baseUrl,
      maxResponseBytes: options.maxResponseBytes,
      authenticate: () => ({ Authorization: `Bearer ${token}` }),
      // The one place a request leaves and an answer arrives, recorded as
      // they happen so a failure can say how far the request got.
      fetch: async (url, init) => {
        facts.dispatched = true;
        const response = await fetch(url, init);
        // Recorded before the transport validates anything: a ceiling or a
        // redirect check can fail an answer, but not change what it said.
        facts.status = response.status;
        facts.headers = response.headers;
        return response;
      },
    });
  transport("");

  /**
   * What a failure means for a request that may have changed something. A
   * write Google accepted, or one that left with no answer, may have landed:
   * telling the agent to retry it invites a duplicate, so it is reported as
   * an uncertain outcome that is not retried — the same verdict core reaches
   * for a trusted-pool program write (`write_outcome_unknown`). A read is safe to
   * repeat and keeps its retryable classification.
   */
  /**
   * A 5xx answering a write that is not idempotent. Google can fail after a
   * change commits, so "unavailable, retry" would invite a duplicate insert
   * or a second draft: the outcome is unknown and the write is not retried,
   * whatever reason the 5xx names. Its reasons stay readable beside it.
   */
  function serverErrorOnWrite(
    mapped: ConnectorCallError,
    status: number,
    method: string,
    requestOptions: GoogleRequestOptions,
  ): ConnectorCallError | undefined {
    // Any 5xx, whatever reason it names: a quota reason on a 503 does not
    // prove the write was turned away before it committed. Only a 429, or a
    // 4xx naming a quota, is a rejection that applied nothing.
    if (status < 500 || method === "GET" || requestOptions.idempotent === true) {
      return undefined;
    }
    const unknown = new ConnectorCallError(
      "connector_call_failed",
      `${provider} answered HTTP ${status} after receiving the request, so its outcome is unknown — it may have been applied. Re-read its target before repeating it.`,
      { retryable: false, cause: mapped },
    );
    const reasons = googleReasons.get(mapped);
    if (reasons) googleReasons.set(unknown, reasons);
    return unknown;
  }

  // The errors built below keep no cause: a stream's or parser's error can
  // quote the body it failed on, and the phase and status already say what
  // happened (#695).
  function settled(
    error: unknown,
    facts: SendFacts,
    method: string,
    ctx: ConnectorContext,
    requestOptions: GoogleRequestOptions,
  ): unknown {
    const write = method !== "GET";
    const status = facts.status;
    if (facts.serverError) {
      return outcome(error, { dispatched: true, phase: "server-error", ...(status === undefined ? {} : { status }) });
    }
    if (facts.refused) {
      return outcome(error, { dispatched: true, phase: "refused", ...(status === undefined ? {} : { status }) });
    }
    // An error status keeps its meaning whatever went wrong reading its body
    // — a body past the ceiling, a stream that broke off: the status alone
    // still says what to do next.
    if (status !== undefined && status >= 400 && !ctx.signal?.aborted) {
      const mapped = apiFailure(failure, status, facts.headers ?? new Headers(), undefined, requestOptions);
      const unknown = serverErrorOnWrite(mapped, status, method, requestOptions);
      return unknown
        ? outcome(unknown, { dispatched: true, status, phase: "server-error" })
        : outcome(mapped, { dispatched: true, status, phase: "refused" });
    }
    if (!facts.dispatched) return outcome(error, { dispatched: false, phase: "before-send" });
    // The caller's own cancellation is core's to classify, not this layer's —
    // but what Google had already said by then is still what it said.
    if (ctx.signal?.aborted) {
      const phase: GoogleOutcome["phase"] =
        status === undefined
          ? "awaiting-response"
          : status >= 500 && write && requestOptions.idempotent !== true
            ? "server-error"
            : status >= 400
              ? "refused"
              : status >= 300
                ? "redirected"
                : "reading-body";
      return outcome(error, { dispatched: true, phase, ...(status === undefined ? {} : { status }) });
    }
    if (status === undefined) {
      const mapped = write
        ? new ConnectorCallError(
            "connector_call_failed",
            `${provider} was sent the request but no answer came back, so it may or may not have been applied. Re-read its target before repeating it.`,
            { retryable: false },
          )
        : error;
      return outcome(mapped, { dispatched: true, phase: "awaiting-response" });
    }
    // A redirect, which the transport refuses to follow. It shows neither
    // that a write applied nor that it did not, so a write's outcome is
    // unknown — never "probably applied". A read keeps the transport's own
    // refusal.
    if (status >= 300 && status < 400) {
      const redirected = write
        ? new ConnectorCallError(
            "connector_call_failed",
            `${provider} answered HTTP ${status} with a redirect, which this connection does not follow, so whether the request was applied is unknown. Re-read its target before repeating it.`,
            { retryable: false },
          )
        : error;
      return outcome(redirected, { dispatched: true, status, phase: "redirected" });
    }
    // Google accepted the request — a 2xx — and its reply broke off,
    // overflowed, or would not parse.
    const mapped = write
      ? new ConnectorCallError(
          "connector_call_failed",
          `${provider} accepted the request but its reply could not be read; the change probably applied. Re-read before repeating it.`,
          { retryable: false },
        )
      : error instanceof ConnectorCallError
        ? error
        : new ConnectorCallError(
            "unavailable",
            `${provider}'s reply broke off while it was being read; reading again is safe.`,
          );
    return outcome(mapped, { dispatched: true, status, phase: "reading-body" });
  }

  async function call<T>(
    request: GuardedRequest,
    ctx: ConnectorContext,
    accept: string,
    read: (response: ReadableResponse) => Promise<T>,
    requestOptions: GoogleRequestOptions = {},
  ): Promise<T> {
    // A 401 is answered by sending the same request again, so its body must
    // survive being sent twice. A stream is consumed by the first send; it
    // is a provider's wiring mistake, refused before anything leaves.
    if (typeof ReadableStream !== "undefined" && request.rawBody instanceof ReadableStream) {
      throw outcome(
        new TypeError(
          `${provider}: a Workspace request body must be replayable — pass a string, Uint8Array, ArrayBuffer, Blob, FormData, or URLSearchParams, never a ReadableStream.`,
        ),
        { dispatched: false, phase: "before-send" },
      );
    }
    const headed: GuardedRequest = { ...request, headers: { Accept: accept, ...request.headers } };
    for (let attempt = 0; ; attempt += 1) {
      const facts: SendFacts = { dispatched: false };
      let delegated: DelegatedTokenRequest;
      let token: string;
      try {
        // Subject first: no caller, or no mapped account, fails before any
        // token is minted or request sent.
        delegated = await tokenRequest(ctx);
        token = await delegatedToken(delegated, ctx);
      } catch (error) {
        throw outcome(error, { dispatched: false, phase: "before-send" });
      }
      try {
        return await transport(token, facts)(headed, ctx, async (response) => {
          // Every 3xx — the ones the transport refuses and the 300, 304, 305,
          // and 306 it lets through — is a redirect before it is anything
          // else: no body or reason it carries makes it a refusal.
          if (response.status >= 300 && response.status < 400) {
            throw new ConnectorCallError(
              "connector_call_failed",
              `${provider} answered HTTP ${response.status} with a redirect; this connection talks to exactly one origin and never forwards its credential to another.`,
              { retryable: false },
            );
          }
          // A bounded read answers an empty file's 416 as an empty result.
          if (!response.ok && !(headed.prefixOnly === true && isEmptyRange(response))) {
            const parsed = await response.jsonResult();
            const payload = "value" in parsed ? parsed.value : undefined;
            const mapped = apiFailure(failure, response.status, response.headers, payload, requestOptions);
            const unknown = serverErrorOnWrite(mapped, response.status, headed.method, requestOptions);
            if (unknown) {
              facts.serverError = true;
              throw unknown;
            }
            facts.refused = true;
            throw response.status === 401 ? new TokenRejected(mapped) : mapped;
          }
          return await read(response);
        });
      } catch (error) {
        // Every 401 Google sent earns the refresh and the one replay, whether
        // its body was read or failed the transport's checks first: what the
        // status said about the token does not depend on the body.
        // A caller that has left gets neither: the 401 it saw is reported as
        // it was, and no new token is minted for a request nobody awaits.
        const failed = error instanceof TokenRejected ? error.failure : error;
        const unauthorized = !ctx.signal?.aborted && (error instanceof TokenRejected || facts.status === 401);
        if (!unauthorized) throw settled(failed, facts, headed.method, ctx, requestOptions);
        // Only the token this request carried; a newer one stays.
        await forgetDelegatedToken(delegated, token);
        if (attempt > 0 || ctx.signal?.aborted) {
          throw settled(failed, facts, headed.method, ctx, requestOptions);
        }
      }
    }
  }

  return {
    json: (request, ctx, requestOptions) =>
      call(
        request,
        ctx,
        "application/json",
        async (response) => {
          // Read first, parse second: a body that breaks off while it is being
          // read is a transport failure (a GET may read again), and only text
          // that arrived whole and still is not JSON is malformed.
          const body = await response.text();
          if (body.trim() === "") return undefined;
          try {
            return JSON.parse(body) as unknown;
          } catch {
            throw new ConnectorCallError(
              "connector_call_failed",
              `${provider} returned a successful response that is not JSON.`,
              { retryable: false },
            );
          }
        },
        requestOptions,
      ),
    bytes: (request, ctx, accept = "*/*", requestOptions) => read(request, ctx, accept, requestOptions),
    text: async (request, ctx, accept = "text/plain, */*", requestOptions) => {
      const { bytes, ...rest } = await read(request, ctx, accept, requestOptions);
      let text: string;
      try {
        // A cut prefix may end inside a code point; streaming decode drops
        // the incomplete tail instead of inventing a replacement character.
        text = new TextDecoder(charsetOf(rest.contentType)).decode(bytes, { stream: rest.truncated });
      } catch {
        text = new TextDecoder().decode(bytes, { stream: rest.truncated });
      }
      return { text, ...rest };
    },
  };

  /** The body as bytes: whole, or a bounded prefix when `maxBytes` is set. */
  async function read(
    request: GuardedRequest,
    ctx: ConnectorContext,
    accept: string,
    requestOptions: GoogleReadOptions = {},
  ): Promise<GoogleBytes> {
    const { maxBytes } = requestOptions;
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
      throw outcome(new TypeError(`${provider}: maxBytes must be a whole number of bytes, zero or more.`), {
        dispatched: false,
        phase: "before-send",
      });
    }
    const bounded = maxBytes !== undefined;
    return call(
      bounded ? { ...request, prefixOnly: true } : request,
      ctx,
      accept,
      async (response) => {
        const facts = {
          contentType: response.headers.get("content-type") ?? undefined,
          status: response.status,
          contentRange: response.headers.get("content-range") ?? undefined,
        };
        if (!bounded) return { bytes: await response.bytes(), truncated: false, ...facts };
        if (!response.ok) {
          // Only the empty-file 416 reaches here; its body is not the file.
          await response.prefix(0);
          return { bytes: new Uint8Array(), truncated: false, ...facts };
        }
        return { ...(await response.prefix(maxBytes)), ...facts };
      },
      requestOptions,
    );
  }
}
