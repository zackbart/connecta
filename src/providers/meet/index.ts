import { skill } from "./skill.generated.js";
/**
 * Google Meet, as the signed-in Workspace user: create meeting spaces and
 * change their settings, end a meeting under way, and read what happened —
 * conference records, participants and their sessions, recordings,
 * transcripts and their entries, and Gemini smart notes. Hand-written against
 * the Meet REST API v2 reference
 * (https://developers.google.com/workspace/meet/api/reference/rest).
 *
 * Whose meetings. In delegation mode, access is a service account with
 * domain-wide delegation (`src/providers/_shared/google/`): deployment config
 * maps the admitted identity to a Workspace address, and each call mints, or
 * reuses, a token as that user. Meet resource names carry no user segment, so
 * the token's subject decides what a request can reach.
 *
 * What it does not do. Meet cannot list a user's spaces; Calendar events carry
 * the meeting codes that resolve to them. Recording, transcript and smart-note
 * files live in Drive and Docs, which this connection requests no scope for.
 * Event subscriptions (the Workspace Events API) are out of scope.
 *
 * OAuth mode (`{ oauth, authScope }`) instead uses the downstream OAuth grant
 * of each connected Google account, or one shared account, with the same
 * scopes and tool surface (`src/providers/_shared/google/kit.ts`).
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/meet/drift.json` records the methods the tools call, and
 * `pnpm run providers:check --provider meet` reports a touched contract that
 * moved or a method that stopped accepting the scopes below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { MEET_HATCH, meetBinding } from "./lib/hatch.js";
import {
  GOOGLE_GRANT_RENEWAL,
  googleActor,
  googleAuthScope,
  googleOAuthContext,
  tagWorkspace,
  googleConnectionErrors,
  googleDelegatedGrant,
  googleOAuth,
} from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { errors, MEET, MeetApi, probe, safety } from "./api.js";
import { MEET_API_BASE_URL, MEET_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { meetTools } from "./tools.js";

export { MEET_API_BASE_URL, MEET_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/** Options for {@link meet}: the shared Workspace delegation options. */
export type MeetOptions = GoogleWorkspaceOptions;

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Meet connection acting as each signed-in Workspace
 * user through a delegated service account, or as connected Google accounts
 * in OAuth mode.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Meet REST API**.
 * 2. Create a service account with no IAM roles, and a JSON key for it.
 * 3. As a Workspace super admin, add (or extend) the domain-wide delegation
 *    entry for its client ID with exactly these scopes ({@link MEET_SCOPES}):
 *    `https://www.googleapis.com/auth/meetings.space.created,https://www.googleapis.com/auth/meetings.space.readonly,https://www.googleapis.com/auth/meetings.space.settings`.
 * 4. Map callers to accounts:
 *
 * ```ts
 * meet("meet", {
 *   purpose: "Team meetings, attendance and transcripts",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * `create_space` is an additive write; `update_space` and
 * `end_active_conference` are destructive.
 */
export const meet = defineApiProvider<MeetOptions>({
  name: "meet",
  title: "Google Meet",
  readme: "Google Meet",
  bundle: {
    baselineGzip: 391930,
    note: "./providers/meet initial baseline measures 391,930 B gzip standalone (#1397), Node 26.13.0 with scripts/bundle-size.mjs; ./providers/forms measures 395,582 B on the same toolchain. This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Meet as ${googleActor("meet", options)}: create and configure meeting spaces, read conferences, attendees, recordings and transcripts — ${options.purpose}`,
  vendor: MeetApi,
  baseUrl: (options) => options.baseUrl?.trim() || MEET_API_BASE_URL,
  maxResponseBytes: MEET_MAX_RESPONSE_BYTES,
  // The delegated token: the subject resolves per call, and the service
  // account mints as that user. The key was checked at construction.
  grant: (options) => googleDelegatedGrant(MEET, "meet", options),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  oauth: (options) => googleOAuth(MEET, "meet", options, [options.baseUrl?.trim() || MEET_API_BASE_URL]),
  oauthWrite401: "grant",
  authScope: googleAuthScope("meet"),
  connectionErrors: googleConnectionErrors(MEET, "meet", errors),
  authenticate: bearer,
  errors,
  safety: () => safety,
  probe,
  blocks: { keys: ["writes"], select: (options) => (options.readOnly ? [] : ["writes"]) },
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      `${
        googleOAuthContext("meet", options) ??
        "Workspace delegation is configured by the deployment. Each call acts as the mapped Workspace user; no argument chooses a subject."
      } Attendee names, user ids and transcript text are user data; no configurable sensitive-field set is declared.`,
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    instructions: options.instructions,
    summary: "Load for Meet spaces, conference attendance, recordings, transcripts and smart notes.",
    // Required: meeting codes versus space names, the Calendar join, and the
    // Drive/Docs artifact join are conventions no schema can carry.
    required: true,
  }),
  idempotencyKey: false,
  pageSize: { default: 25, max: 100 },
  hatch: {
    ...MEET_HATCH,
    binding: ({ connection }) => meetBinding(connection),
    notes: () => ({
      read: "Paths are relative to /v2 and use resource-name segments, e.g. /conferenceRecords/conference_123/participants. Full vendor JSON follows the same privacy and permanent value-safety boundary as named reads. Lists page with top-level cursor from page.nextCursor; never pass a raw pageToken. query.pageSize accepts integers from 1 to 500; Google lowers it to each method's maximum. query.filter takes Google's documented filter grammar. fields selects response data; query.fields is Google's wire mask.",
      write:
        "Space creation, settings, ending a conference and space members are admitted. Members batches take 1–500 updates. No idempotency key or automatic replay.",
    }),
  },
  tools: meetTools,
  tagConnector: tagWorkspace("meet"),
});
