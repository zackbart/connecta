import { callerOf } from "../../../connector-caller.js";
import { ConnectorCallError } from "../../../errors.js";
import type { AuthenticatedIdentity, ConnectorContext } from "../../../types.js";

/**
 * The Intercom teammate every write acts as: one fixed admin id for every
 * caller, or a function from the admitted identity (a person, or a declared
 * agent through `identity.agent`) to that caller's admin id. The function
 * answers `undefined` for a caller with no teammate, and that write is
 * refused before anything is sent.
 */
export type IntercomAdmin =
  | string
  | ((
      identity: Readonly<AuthenticatedIdentity>,
      context: IntercomAdminContext,
    ) => string | undefined | Promise<string | undefined>);

/** What an admin mapping is told about the call it resolves for. */
export interface IntercomAdminContext {
  /** The call's cancellation, for an async directory lookup to honor. */
  readonly signal?: AbortSignal;
}

const ADMIN_ID = /^[1-9][0-9]{0,19}$/;

function isAdminId(value: unknown): value is string {
  return typeof value === "string" && ADMIN_ID.test(value);
}

export function adminOption(value: unknown, readOnly: boolean): IntercomAdmin | undefined {
  if (value === undefined) {
    if (readOnly) return undefined;
    throw new Error(
      "intercom() requires admin: the Intercom admin id writes act as, or a function from the admitted identity to one. Set readOnly: true for a connection without writes.",
    );
  }
  if (typeof value === "function") return value as IntercomAdmin;
  if (typeof value === "string" && isAdminId(value.trim())) return value.trim();
  throw new Error("intercom() admin must be a numeric Intercom admin id, or a function of the caller returning one.");
}

export async function adminFor(admin: IntercomAdmin | undefined, ctx: ConnectorContext): Promise<string> {
  if (admin === undefined)
    throw new ConnectorCallError(
      "auth_required",
      "This Intercom connection has no acting admin configured, so it cannot write. An operator sets admin in the deployment's config.",
    );
  if (typeof admin === "string") return admin;
  const caller = callerOf(ctx);
  if (!caller)
    throw new ConnectorCallError(
      "auth_required",
      "Intercom writes act as the caller's mapped teammate, and this call has no admitted caller. Use a fixed admin for work with no caller.",
    );
  if (!caller.authenticated)
    throw new ConnectorCallError(
      "auth_required",
      "Intercom writes act as the caller's mapped teammate, and this deployment admitted the call without authentication. Configure inbound auth, or a fixed admin for shared use.",
    );
  let mapped: string | undefined;
  try {
    mapped = await admin(caller.identity, ctx.signal ? { signal: ctx.signal } : {});
  } catch (cause) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    throw new ConnectorCallError(
      "connector_call_failed",
      "The deployment's Intercom admin mapping threw while resolving this caller's teammate.",
      { retryable: false, cause },
    );
  }
  if (mapped === undefined)
    throw new ConnectorCallError(
      "auth_required",
      "This caller has no Intercom teammate mapped. An operator maps admitted identities to Intercom admin ids in the deployment's admin config; nothing a call sends can choose one.",
    );
  if (typeof mapped !== "string" || !isAdminId(mapped.trim()))
    throw new ConnectorCallError(
      "connector_call_failed",
      "The deployment's Intercom admin mapping returned something that is not an Intercom admin id.",
      { retryable: false },
    );
  return mapped.trim();
}
