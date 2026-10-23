/**
 * Google Workspace access as the person calling, with no per-user consent:
 * a service account with domain-wide delegation mints a token *as* the user
 * the deployment maps the admitted caller to. The foundation each Workspace
 * product provider builds on; never its own export.
 *
 * Whose account. `ConnectorContext` carries no identity, and a deployment's
 * own connector never learns its caller (`src/connector-caller.ts`). A
 * maintained Workspace provider is the second sanctioned reader of that
 * channel (PRINCIPLES.md INV-3, #678): deployment config supplies
 * `subject`, a function from the admitted `AuthenticatedIdentity` to a
 * Workspace address, and the provider reads the identity core attached beside
 * the context. An agent, which has no Workspace account, acts instead as the
 * `owner` of the pool it came through, which core copies from that pool's
 * config beside the identity; the mapping never sees an agent. In a pool
 * without an owner the connector is absent for agents (core's scoped
 * registry view hides it), and this provider still fails `auth_required` if
 * one reaches it anyway (decisions/0006). A fixed
 * `subject` address is every caller's, owners aside. No tool argument,
 * header, or program can name the subject — every product's base URL is
 * confined beneath `users/me`, or its product's equivalent, so the token's
 * subject is the only account a request reaches.
 * A call with no admitted caller, one an open deployment admitted without
 * authentication (the mapping is never asked about it), or one the mapping
 * answers `undefined` for, fails `auth_required` before anything leaves the
 * host. Catalogs need no subject: tools are static.
 *
 * This module owns shared options, connection parsing and subject resolution.
 * `kit.ts` builds the delegated grant, Google error mapping and request adapter
 * on these foundations; `service-account.ts` owns token exchange and caching.
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
 *    admitted identity to a Workspace address in `subject`. Give each pool
 *    agents use an `owner`, the address they act as there.
 */
import { keys, optionsOf } from "../../../config-schema.js";
import { callerOf } from "../../../connector-caller.js";
import { CALL_ADMISSION } from "../../../connectors/option-shapes.js";
import { ConnectorCallError } from "../../../errors.js";
import type { AuthenticatedIdentity, ConnectorCallAdmissionPolicy, ConnectorContext } from "../../../types.js";
import { isWorkspaceAddress } from "../../../workspace-address.js";
import { parseServiceAccount, type GoogleServiceAccount, type ServiceAccountKey } from "./service-account.js";

export type { GoogleServiceAccount } from "./service-account.js";

/**
 * Whose Workspace account a call acts as.
 *
 * A function receives the identity an inbound auth provider authenticated for
 * this request and returns that person's Workspace address, or `undefined`
 * for a caller who has none — that call then fails closed. It is never called
 * for an open deployment's anonymous requests, for a call no request
 * admitted, or for an agent: an agent acts as the `owner` of the pool it
 * came through, and never sees the connector in a pool without one. It may be async, for
 * a directory lookup (a Clerk user id to an email, say), and receives the
 * call's cancellation signal for that; it runs once per tool call and should
 * cache what it fetches. A string is one fixed account for every caller who
 * can reach the connector, agents included and pool owners aside, for a
 * shared mailbox or scheduled work with no caller; limit who reaches it with
 * `maintainers` and the `members` of the pools that list it.
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
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** API base override for a proxy or test double. */
  baseUrl?: string;
}

/** The closed options every Workspace provider accepts; see `assertKnownOptions`. */
export const GOOGLE_WORKSPACE_OPTIONS = optionsOf<GoogleWorkspaceOptions>()({
  ...keys("purpose", "subject", "title", "instructions", "maxResultBytes", "baseUrl", "readOnly"),
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

/** Validate the shared options at construction; throws on a structural mistake. */
export function workspaceConnection(factory: string, options: GoogleWorkspaceOptions): WorkspaceConnection {
  const purpose = options?.purpose?.trim();
  if (!purpose) throw new Error(`${factory}() requires a non-empty purpose.`);
  const account = parseServiceAccount(`${factory}()`, options.serviceAccount);
  const subject = options.subject;
  if (typeof subject === "string") {
    if (!isWorkspaceAddress(subject.trim())) {
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
export async function subjectFor(
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
  // An agent has no Workspace account of its own. It acts as the owner of the
  // pool it came through, which core copied from that pool's config, and the
  // mapping, which answers for people, is never asked about it (decisions/0006).
  // Core's scoped view already hides the connector from an agent without an
  // owner; this refusal is the fallback for any context built without it.
  if (caller.identity.agent !== undefined) {
    if (caller.pool !== undefined && isWorkspaceAddress(caller.poolOwner)) return caller.poolOwner;
    throw new ConnectorCallError(
      "auth_required",
      `${provider} acts as a pool's owner for agents, and the pool this agent reached it through has no owner. An operator sets owner on the pool in the deployment's config; nothing a call sends can choose one.`,
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
  if (typeof mapped !== "string" || !isWorkspaceAddress(mapped.trim())) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `The deployment's ${provider} subject mapping returned something that is not an email address.`,
      { retryable: false },
    );
  }
  return mapped.trim();
}
