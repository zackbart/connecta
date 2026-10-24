import { skill } from "./skill.generated.js";
/**
 * Google Forms, as the signed-in Workspace user: read a form's questions,
 * create a form, read its responses, and edit it through Google's own
 * batchUpdate. Hand-written against the Forms API v1 reference
 * (https://developers.google.com/workspace/forms/api/reference/rest).
 *
 * Whose forms. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. The Forms API has no per-user path to confine beneath — a form id
 * is a Drive file id — so the token's subject is what decides what a request
 * can reach: exactly the forms that person can open in Forms.
 *
 * What it does not do. Listing forms is Drive's job (a Drive files query for
 * `mimeType = 'application/vnd.google-apps.form'`); the Forms API has no list
 * method and this connection requests no Drive scope. Deleting,
 * sharing, and publishing are Drive or `setPublishSettings`, outside both of
 * this connection's scopes or its surface, and watches (push notifications)
 * are out of scope entirely. Responses are read-only: `forms.responses.readonly`
 * is the only response scope requested.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/forms/drift.json` records the five methods the tools
 * call, and `pnpm run providers:check --provider forms` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { FORMS_HATCH, formsBinding } from "./lib/hatch.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { errors, FORMS, FormsApi, probe, safety } from "./api.js";
import { FORMS_API_BASE_URL, FORMS_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { formsTools } from "./tools.js";

export { FORMS_API_BASE_URL, FORMS_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/** Options for {@link forms}: the shared Workspace delegation options. */
export type FormsOptions = GoogleWorkspaceOptions;

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Forms connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Forms API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' forms.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the entry another Workspace provider already made for this client ID, and
 *    append to its scopes). Paste the client ID and exactly these scopes,
 *    comma-separated ({@link FORMS_SCOPES}):
 *    `https://www.googleapis.com/auth/forms.body,https://www.googleapis.com/auth/forms.responses.readonly`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * forms("forms", {
 *   purpose: "Event registration forms and their responses",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Listing forms needs Drive, which this connection does not request; pair it
 * with a Drive connection for that. `create_form` is an additive write the
 * host approves through call_destructive_tool or a program on a writable endpoint;
 * `update_form_info` and `batch_update_form` are destructive.
 */
export const forms = defineApiProvider<FormsOptions>({
  name: "forms",
  title: "Google Forms",
  readme: "Google Forms",
  bundle: {
    baselineGzip: 334835,
    note: "./providers/forms measures 334,835 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Forms as the signed-in Workspace user: read and edit forms, read responses — ${options.purpose}`,
  vendor: FormsApi,
  baseUrl: (options) => options.baseUrl?.trim() || FORMS_API_BASE_URL,
  maxResponseBytes: FORMS_MAX_RESPONSE_BYTES,
  // The delegated token: the subject resolves per call, and the service
  // account mints as that user. The key was checked at construction.
  grant: (options) => googleGrant(FORMS, workspaceOf("forms", options)),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  safety: () => safety,
  probe,
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      "Workspace delegation is configured by the deployment. Each call acts as the mapped Workspace user; no argument chooses a subject. Responses, respondent email and quiz answers are user data; no configurable sensitive-field set is declared.",
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    instructions: options.instructions,
    summary: "Each caller's own forms: questions by id, labeled responses, revision-checked batch edits.",
    // Required: whose forms they are, that Drive lists them, and the
    // revision-checked edit sequence are conventions no schema can carry.
    required: true,
  }),
  idempotencyKey: false,
  pageSize: { default: 25, max: 100 },
  hatch: {
    ...FORMS_HATCH,
    binding: ({ connection }) => formsBinding(connection),
    notes: () => ({
      read: "Paths are relative to /v1. Full vendor JSON follows the same privacy and permanent value-safety boundary as named reads. Responses page with top-level cursor from page.nextCursor; never pass a raw pageToken. fields selects response data; query.fields is Google's wire mask.",
      write:
        "Only create and batchUpdate are admitted. Batch bodies require 1–100 requests, one reviewed kind each, and writeControl.requiredRevisionId from a current read. Publish settings and all watches are refused. No idempotency key or automatic replay.",
    }),
  },
  tools: formsTools,
  tagConnector: tagWorkspace("forms"),
});
