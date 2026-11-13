import { skill } from "./skill.generated.js";
/**
 * Google People, as the signed-in Google user: the user's own contacts and
 * contact groups, "Other contacts" Gmail saved from interactions, the user's
 * own profile (`people/me`), and in Google Workspace the organization
 * directory. Hand-written against the People API v1 reference
 * (https://developers.google.com/people/api/rest).
 *
 * Whose contacts. In delegation mode, access is a service account with
 * domain-wide delegation (`src/providers/_shared/google/`): deployment config
 * maps the admitted identity to a Workspace address, and each call mints, or
 * reuses, a token as that user. The People API has no per-user path to
 * confine beneath, so the token's subject decides what a request reaches:
 * exactly that person's contacts and the directory their domain shows them.
 * OAuth mode (`{ oauth, authScope }`) instead uses the downstream OAuth grant
 * of each connected Google account, or one shared account, with the same
 * scopes and tool surface (`src/providers/_shared/google/kit.ts`).
 *
 * Privacy. Contacts are personal data. Addresses, birthdays, notes, events,
 * external ids, genders, relations and custom fields
 * ({@link PEOPLE_SENSITIVE_FIELDS}) leave every result unless the deployment
 * sets `sensitiveFields: "return"`; no tool argument can ask for them. Photo
 * destinations and other applications' private client data are always
 * withheld.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/people/drift.json` records the methods the tools call, and
 * `pnpm run providers:check --provider people` reports a touched contract
 * that moved or a method that stopped accepting the scopes below.
 */
import { keys, optionsOf } from "../../config-schema.js";
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { PEOPLE_HATCH, peopleBinding } from "./lib/hatch.js";
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
import { sensitiveFieldsOption } from "../_shared/sensitive-fields.js";
import { errors, PEOPLE, PeopleApi, peopleSafety, probe } from "./api.js";
import { PEOPLE_API_BASE_URL, PEOPLE_MAX_RESPONSE_BYTES, PEOPLE_SENSITIVE_FIELDS } from "./lib/constants.js";
import { peopleTools } from "./tools.js";

export { PEOPLE_API_BASE_URL, PEOPLE_SCOPES, PEOPLE_SENSITIVE_FIELDS } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/** Options for {@link people}: the shared Workspace options and the sensitive-field choice. */
export type PeopleOptions = GoogleWorkspaceOptions & {
  /**
   * Whether results may carry {@link PEOPLE_SENSITIVE_FIELDS}: addresses, age
   * ranges, birthdays, notes (`biographies`), events, external ids, genders,
   * relations and custom fields (`userDefined`). `"drop"` (default) removes
   * them wherever they appear, in every named read and `people_api_read` and
   * `people_api_write` replies, and named reads cannot ask for them.
   * `"return"` returns them. Only deployment code decides; no tool argument can.
   */
  sensitiveFields?: "drop" | "return";
};

/** The closed options people() accepts; see `assertKnownOptions`. */
const PEOPLE_OPTIONS = optionsOf<PeopleOptions>()({
  ...GOOGLE_WORKSPACE_OPTIONS.shape,
  ...keys("sensitiveFields"),
});

const sensitiveFields = (options: Readonly<PeopleOptions>) => sensitiveFieldsOption("people", options.sensitiveFields);

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google People connection acting as each signed-in Workspace
 * user through a delegated service account, or as connected Google accounts
 * in OAuth mode.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **People API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' contacts.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the entry another Workspace provider already made for this client ID, and
 *    append to its scopes). Paste the client ID and exactly the scopes in
 *    {@link PEOPLE_SCOPES}, comma-separated. A new grant can take up to 24
 *    hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * people("contacts", {
 *   purpose: "Resolve the people in mail and meetings",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * `create_contact`, `create_contact_group` and `copy_other_contact` are
 * additive writes; updates, deletes and membership changes are destructive.
 */
export const people = defineApiProvider<PeopleOptions>({
  name: "people",
  title: "Google People",
  readme: "Google People (Contacts and directory)",
  bundle: {
    baselineGzip: 400081,
    note: "./providers/people measures 400,081 B gzip standalone in its initial build (#1396), Node 26.13.0 with local zlib-ng 1.3.1 and esbuild 0.28.2, neutral Worker conditions and gzip level 9. This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  skill,
  options: PEOPLE_OPTIONS,
  description: (options) =>
    `Google contacts and directory as ${googleActor("people", options)}: find, read and edit contacts, groups and other contacts — ${options.purpose}`,
  vendor: PeopleApi,
  baseUrl: (options) => options.baseUrl?.trim() || PEOPLE_API_BASE_URL,
  maxResponseBytes: PEOPLE_MAX_RESPONSE_BYTES,
  // The delegated token: the subject resolves per call, and the service
  // account mints as that user. The key was checked at construction.
  grant: (options) => googleDelegatedGrant(PEOPLE, "people", options),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  oauth: (options) => googleOAuth(PEOPLE, "people", options, [options.baseUrl?.trim() || PEOPLE_API_BASE_URL]),
  oauthWrite401: "grant",
  authScope: googleAuthScope("people"),
  connectionErrors: googleConnectionErrors(PEOPLE, "people", errors, { revisionConflicts: true }),
  authenticate: bearer,
  errors,
  safety: (options) => peopleSafety({ names: PEOPLE_SENSITIVE_FIELDS, choice: sensitiveFields(options) }),
  probe,
  blocks: { keys: ["writes"], select: (options) => (options.readOnly ? [] : ["writes"]) },
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      googleOAuthContext("people", options) ??
        "Workspace delegation is configured by the deployment. Each call acts as the mapped Workspace user; no argument chooses a subject.",
      sensitiveFields(options) === "return"
        ? "This connection returns addresses, birthdays, notes, events, external ids, genders, relations and custom fields when a read asks for them."
        : "This connection withholds addresses, birthdays, notes, events, external ids, genders, relations and custom fields from every result.",
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    instructions: options.instructions,
    summary: "Load to resolve people to emails and phones across contacts, other contacts and the Workspace directory.",
    // Required: which of three address books answers a question, and the
    // etag-guarded replace semantics of edits, are conventions no schema carries.
    required: true,
  }),
  idempotencyKey: false,
  pageSize: { default: 25, max: 100 },
  hatch: {
    ...PEOPLE_HATCH,
    binding: ({ connection }) => peopleBinding(connection),
    notes: (options) => ({
      read: `Paths are relative to /v1; resource names are paths, e.g. /people/me or /contactGroups/myContacts. Lists page with top-level cursor from page.nextCursor; never pass a raw pageToken. query.personFields or query.readMask is required by Google. ${
        sensitiveFields(options) === "return"
          ? "Sensitive person fields are returned."
          : "Sensitive person fields are dropped."
      } Photo URLs and client data are withheld.`,
      write:
        "Writes replace whole fields named in updatePersonFields at the etag a read returned. Batch create/update/delete, photo update/delete and group edits are admitted. No idempotency key or automatic replay.",
    }),
  },
  tools: peopleTools,
  tagConnector: tagWorkspace("people"),
});
