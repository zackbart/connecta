import { skill } from "./skill.generated.js";
/**
 * Google Calendar, as the signed-in Workspace user: list calendars, list and
 * search events, read one event, query free/busy, and create, change, answer,
 * move and delete events. Hand-written against the Calendar API v3 reference
 * (https://developers.google.com/workspace/calendar/api/v3/reference).
 *
 * Whose calendars. In delegation mode, access is a service account with
 * domain-wide delegation (`src/providers/_shared/google/`): deployment config
 * maps the admitted identity to a Workspace address, and each call mints, or
 * reuses, a token as that user. `primary` and `/users/me/...` resolve to that
 * user, so the token's subject decides whose calendars a request reaches; no
 * argument names an account.
 *
 * What the hatch reaches. Every indexed Calendar method has a reviewed
 * verdict: sharing rules, calendar create/update/delete, the calendar list,
 * settings, colors, instances and import are admitted behind approval.
 * Push notification channels (every `watch` and `channels.stop`) are refused:
 * they deliver to a webhook this connection cannot receive.
 *
 * OAuth mode (`{ oauth, authScope }`) instead uses the downstream OAuth grant
 * of each connected Google account, or one shared account, with the same
 * scope and tool surface (`src/providers/_shared/google/kit.ts`).
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/calendar/drift.json` records every indexed method, and
 * `pnpm run providers:check --provider calendar` reports a touched contract
 * that moved or a method that stopped accepting the scope below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import {
  GOOGLE_GRANT_RENEWAL,
  googleActor,
  googleAuthScope,
  googleDelegatedGrant,
  googleOAuth,
  googleOAuthContext,
  tagWorkspace,
} from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { CALENDAR, CalendarApi, connectionErrors, errors, probe, safety } from "./api.js";
import { CALENDAR_API_BASE_URL, CALENDAR_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { CALENDAR_HATCH, calendarBinding } from "./lib/hatch.js";
import { calendarTools } from "./tools.js";

export { CALENDAR_API_BASE_URL, CALENDAR_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/** Options for {@link calendar}: the shared Workspace delegation options. */
export type CalendarOptions = GoogleWorkspaceOptions;

const apiBaseUrl = (options: Readonly<CalendarOptions>) => options.baseUrl?.trim() || CALENDAR_API_BASE_URL;

/**
 * A maintained Google Calendar connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Calendar API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' calendars.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the client's existing entry, adding to its scopes). Paste the client ID
 *    and exactly this scope ({@link CALENDAR_SCOPES}):
 *    `https://www.googleapis.com/auth/calendar`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * calendar("calendar", {
 *   purpose: "Staff scheduling and meeting invitations",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * `create_event` and `quick_add_event` are additive writes; every other
 * write is destructive. Each crosses host approval through
 * call_destructive_tool or a program on a writable endpoint.
 */
export const calendar = defineApiProvider<CalendarOptions>({
  name: "calendar",
  title: "Google Calendar",
  readme: "Google Calendar",
  bundle: {
    baselineGzip: 401353,
    note: "./providers/calendar measures 401,353 B gzip standalone for its initial provider (#1395), Node 22.23.4, esbuild 0.28.1, neutral Worker conditions and gzip level 9; the same local toolchain measures ./providers/forms at 395,582 B against its recorded 372,442 B. This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },

  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Calendar as ${googleActor("calendar", options)}: find free time, read, create and answer events — ${options.purpose}`,
  vendor: CalendarApi,
  baseUrl: apiBaseUrl,
  maxResponseBytes: CALENDAR_MAX_RESPONSE_BYTES,
  grant: (options) => googleDelegatedGrant(CALENDAR, "calendar", options),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  oauth: (options) => googleOAuth(CALENDAR, "calendar", options, [apiBaseUrl(options)]),
  oauthWrite401: "grant",
  authScope: googleAuthScope("calendar"),
  connectionErrors,
  authenticate: bearer,
  errors,
  safety: () => safety,
  probe,
  blocks: { keys: ["writes"], select: (options) => (options.readOnly ? [] : ["writes"]) },
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      googleOAuthContext("calendar", options) ??
        "Workspace delegation is configured by the deployment. Each call acts as the mapped Workspace user; no argument chooses a subject, and primary is that user's own calendar.",
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    instructions: options.instructions,
    summary: "Load for calendar time zones, free/busy, recurring events, invitations and guest notifications.",
    // Required: time zones, recurring instances and notification choices are
    // conventions no schema can carry.
    required: true,
  }),
  idempotencyKey: false,
  pageSize: { default: 25, max: 250 },
  hatch: {
    ...CALENDAR_HATCH,
    binding: ({ connection }) => calendarBinding(connection),
    notes: () => ({
      read: "Paths are relative to /calendar/v3. Lists page with top-level cursor from page.nextCursor; never pass a raw pageToken. fields selects response data; query.fields is Google's wire mask.",
      write:
        "Push notification channels are refused. Event inserts, patches, moves and deletes take query.sendUpdates; a Meet link needs query.conferenceDataVersion 1. No idempotency key or automatic replay.",
    }),
  },
  tools: calendarTools,
  tagConnector: tagWorkspace("calendar"),
});
