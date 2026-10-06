/**
 * Google Workspace access as the person calling, with no per-user consent:
 * a service account with domain-wide delegation mints a token *as* the user
 * the deployment maps the admitted caller to. The foundation each Workspace
 * product provider (`gmail()` first) builds on; never its own export.
 *
 * Whose account. `ConnectorContext` carries no identity, and a deployment's
 * own connector never learns its caller (`src/connector-caller.ts`). A
 * maintained Workspace provider is the second sanctioned reader of that
 * channel (ethos.md, delegated subjects, #678): deployment config supplies
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
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
} from "../../connectors/guarded-fetch.js";
import { callerOf } from "../../connector-caller.js";
import { ConnectorCallError } from "../../errors.js";
import type {
  AuthenticatedIdentity,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
} from "../../types.js";
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

/** The checked, construction-time half of {@link GoogleWorkspaceOptions}. */
export interface WorkspaceConnection {
  purpose: string;
  account: ServiceAccountKey;
  subject: GoogleWorkspaceSubject;
}

/** A plausible mailbox: one `@`, no whitespace or control characters. */
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** Validate the shared options at construction; throws on a structural mistake. */
export function workspaceConnection(
  factory: string,
  options: GoogleWorkspaceOptions,
): WorkspaceConnection {
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
async function subjectFor(
  provider: string,
  subject: GoogleWorkspaceSubject,
  ctx: ConnectorContext,
): Promise<string> {
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  return error instanceof ConnectorCallError ? googleReasons.get(error) ?? [] : [];
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
  // The API is off in the service account's project. Keyed on Google's own
  // reason, whatever status carries it.
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
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} Google rejected a freshly minted delegated token. The domain-wide delegation grant or the service account may have been revoked.`,
    );
  }
  if (status === 403) {
    if (reasons.has("insufficientPermissions") || reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      return new ConnectorCallError(
        "auth_required",
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
        "connector_call_failed",
        `${detail} A Workspace domain policy forbids this action for this account; only a Workspace administrator can change that.`,
        { retryable: false },
      );
    }
    if (reasons.has("insufficientFilePermissions") || reasons.has("forbidden")) {
      return new ConnectorCallError(
        "connector_call_failed",
        `${detail} This account does not have the permission on this item that the action needs — it may be shared view-only, or not shared with this user. Its owner can grant more.`,
        { retryable: false },
      );
    }
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} Google refused the request; the account may lack access to this item, or a Workspace policy may block it. Google does not say which.`,
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
}

/** A text response body, decoded in the charset its `Content-Type` names. */
interface GoogleText {
  text: string;
  contentType: string | undefined;
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
    options?: GoogleRequestOptions,
  ): Promise<GoogleBytes>;
  /** As {@link bytes}, decoded as text in the response's declared charset. */
  text(
    request: GuardedRequest,
    ctx: ConnectorContext,
    accept?: string,
    options?: GoogleRequestOptions,
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
  jsonResult(): Promise<{ value: unknown } | { parseError: unknown }>;
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
  const transport = (token: string) =>
    guardedFetch({
      provider,
      baseUrl: options.baseUrl,
      maxResponseBytes: options.maxResponseBytes,
      authenticate: () => ({ Authorization: `Bearer ${token}` }),
    });
  transport("");

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
      throw new TypeError(
        `${provider}: a Workspace request body must be replayable — pass a string, Uint8Array, ArrayBuffer, Blob, FormData, or URLSearchParams, never a ReadableStream.`,
      );
    }
    const headed: GuardedRequest = { ...request, headers: { Accept: accept, ...request.headers } };
    for (let attempt = 0; ; attempt += 1) {
      // Subject first: no caller, or no mapped account, fails before any
      // token is minted or request sent.
      const delegated = await tokenRequest(ctx);
      const token = await delegatedToken(delegated, ctx);
      try {
        return await transport(token)(headed, ctx, async (response) => {
          if (!response.ok) {
            const parsed = await response.jsonResult();
            const payload = "value" in parsed ? parsed.value : undefined;
            const mapped = apiFailure(failure, response.status, response.headers, payload, requestOptions);
            throw response.status === 401 ? new TokenRejected(mapped) : mapped;
          }
          return await read(response);
        });
      } catch (error) {
        if (!(error instanceof TokenRejected)) throw error;
        // Only the token this request carried; a newer one stays.
        await forgetDelegatedToken(delegated, token);
        if (attempt > 0) throw error.failure;
      }
    }
  }

  return {
    json: (request, ctx, requestOptions) =>
      call(request, ctx, "application/json", async (response) => {
        const parsed = await response.jsonResult();
        if (!("value" in parsed)) {
          throw new ConnectorCallError(
            "connector_call_failed",
            `${provider} returned a successful response that is not JSON.`,
            { retryable: false },
          );
        }
        return parsed.value;
      }, requestOptions),
    bytes: (request, ctx, accept = "*/*", requestOptions) =>
      call(request, ctx, accept, async (response) => ({
        bytes: await response.bytes(),
        contentType: response.headers.get("content-type") ?? undefined,
      }), requestOptions),
    text: (request, ctx, accept = "text/plain, */*", requestOptions) =>
      call(request, ctx, accept, async (response) => {
        const contentType = response.headers.get("content-type") ?? undefined;
        const bytes = await response.bytes();
        let text: string;
        try {
          text = new TextDecoder(charsetOf(contentType)).decode(bytes);
        } catch {
          text = new TextDecoder().decode(bytes);
        }
        return { text, contentType };
      }, requestOptions),
  };
}
