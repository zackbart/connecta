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
 * A call with no admitted caller, or one the mapping answers `undefined` for,
 * fails `auth_required` before anything leaves the host. Catalogs need no
 * subject: tools are static.
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
 * A function receives the identity inbound auth admitted for this request and
 * returns that person's Workspace address, or `undefined` for a caller who has
 * none — that call then fails closed. It may be async, for a directory lookup
 * (a Clerk user id to an email, say); it is called on every tool call and
 * should cache what it fetches. A string is one fixed account for every
 * caller who can reach the connector, for a shared mailbox or scheduled work
 * with no caller; limit who reaches it with `identity.connectorAccess`.
 */
export type GoogleWorkspaceSubject =
  | string
  | ((
      identity: Readonly<AuthenticatedIdentity>,
    ) => string | undefined | Promise<string | undefined>);

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
      `${provider} acts as the signed-in Workspace user, and this call has no admitted caller (an open deployment, a scheduled run, or a context no request admitted). Configure inbound auth, or a fixed subject for shared use.`,
    );
  }
  let mapped: string | undefined;
  try {
    mapped = await subject(caller.identity);
  } catch (cause) {
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

function apiFailure(
  context: FailureContext,
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const { provider, api, scopes } = context;
  const error = asRecord(asRecord(payload)["error"]);
  const message = typeof error["message"] === "string" ? error["message"].trim().slice(0, 500) : "";
  const detail = message ? `${provider}: ${message}` : `${provider} returned HTTP ${status}.`;
  const reasons = reasonsOf(error);
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
    if (reasons.has("accessNotConfigured") || reasons.has("SERVICE_DISABLED")) {
      return new ConnectorCallError(
        "connector_call_failed",
        `${detail} The ${api} is not enabled in the service account's Google Cloud project; an operator enables it there.`,
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
  if (status === 400 && (reasons.has("failedPrecondition") || reasons.has("FAILED_PRECONDITION"))) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} The account is not in a state to serve this call — the product may be disabled for this user.`,
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

/** A product's request path to its API, as the calling user. */
export interface GoogleWorkspaceClient {
  /**
   * Send one JSON request and return the parsed body (`undefined` for an
   * empty one). Failures arrive as typed `ConnectorCallError`s mapped by what
   * the caller does next. A 401 earns one fresh token and one replay.
   */
  json(request: GuardedRequest, ctx: ConnectorContext): Promise<unknown>;
}

/** The token the API refused, carried out of the mapper for one replay. */
class TokenRejected extends Error {
  constructor(readonly failure: ConnectorCallError) {
    super(failure.message);
  }
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
  const send = guardedFetch({
    provider,
    baseUrl: options.baseUrl,
    headers: { Accept: "application/json" },
    maxResponseBytes: options.maxResponseBytes,
    // The subject is resolved here, per request, from config and the
    // admitted caller; the token is the cached one or a fresh mint.
    authenticate: async (ctx) => ({
      Authorization: `Bearer ${await delegatedToken(await tokenRequest(ctx), ctx)}`,
    }),
  });
  return {
    async json(request, ctx) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await send(request, ctx, async (response) => {
            const parsed = await response.jsonResult();
            const payload = "value" in parsed ? parsed.value : undefined;
            if (!response.ok) {
              const mapped = apiFailure(failure, response.status, response.headers, payload);
              throw response.status === 401 ? new TokenRejected(mapped) : mapped;
            }
            if (!("value" in parsed)) {
              throw new ConnectorCallError(
                "connector_call_failed",
                `${provider} returned a successful response that is not JSON.`,
                { retryable: false },
              );
            }
            return parsed.value;
          });
        } catch (error) {
          if (!(error instanceof TokenRejected)) throw error;
          // A 401 is a refusal before the request did anything, so one replay
          // with a fresh token is safe for a write too.
          forgetDelegatedToken(await tokenRequest(ctx));
          if (attempt > 0) throw error.failure;
        }
      }
    },
  };
}
