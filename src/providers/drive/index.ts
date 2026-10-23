import { skill } from "./skill.generated.js";
/**
 * Google Drive, as the signed-in Workspace user: search, read, create,
 * upload, rename, move, copy, trash and restore files, and read and change who
 * they are shared with — and nothing that deletes a file for good or hands one
 * to a new owner. Hand-written against the Drive API v3 reference
 * (https://developers.google.com/workspace/drive/api/reference/rest/v3).
 *
 * Whose Drive. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. Drive has no `users/me` segment to confine beneath; the token's
 * subject is what every request acts as, so a file id reaches exactly what
 * that person could open in the Drive web app, shared drives included, and no
 * argument names anyone else.
 *
 * Two transports, one account. Uploads go to Drive's upload host
 * (`/upload/drive/v3`), outside the API root, so the provider builds a second
 * confined client for it rather than widening the first to all of
 * `www.googleapis.com`. Each tool uses one of the two, never both, so a
 * `subject` function still runs once per call.
 *
 * What it will not do. There is no permanent delete, no empty-trash, and no
 * ownership transfer: trash is recoverable for thirty days, and an owner change
 * is not. Every write that overwrites content, renames, moves, trashes, or
 * changes sharing is destructive and crosses the host's approval prompt.
 *
 * Drift. `src/providers/drive/drift.json` records the eleven methods the
 * tools call, and `pnpm run providers:check --provider drive` reports a
 * touched contract that moved or a method that stopped accepting the scope
 * below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, tagWorkspace } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { driveGrant, DriveApi, errors, probe, result, safety, usageGuide } from "./api.js";
import { DRIVE_API_BASE_URL, DRIVE_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { driveTools } from "./tools.js";
export { DRIVE_API_BASE_URL, DRIVE_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";
/** Options for {@link drive}: the shared Workspace delegation options. */
export type DriveOptions = GoogleWorkspaceOptions;

/**
 * A maintained Google Drive connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Drive API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' files.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the client's existing entry, adding to its scopes). Paste the client ID
 *    and exactly this scope ({@link DRIVE_SCOPES}):
 *    `https://www.googleapis.com/auth/drive`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * drive("files", {
 *   purpose: "Staff documents and shared drives",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * The `drive` scope reaches everything the user can; the tool surface is what
 * keeps this connection from deleting a file permanently or transferring
 * ownership. Every write crosses host approval through call_destructive_tool
 * or a program on a writable endpoint.
 */
export const drive = defineApiProvider<DriveOptions>({
  name: "drive",
  title: "Google Drive",
  readme: "Google Drive",
  bundle: {
    baselineGzip: 338386,
    note: "./providers/drive measures 338,386 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    "Google Drive as the signed-in Workspace user: search, read, write, and share files, never delete them for good — " +
    options.purpose,
  vendor: DriveApi,
  baseUrl: (options) => options.baseUrl?.trim() || DRIVE_API_BASE_URL,
  maxResponseBytes: DRIVE_MAX_RESPONSE_BYTES,
  grant: driveGrant,
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  safety: () => safety,
  result,
  probe,
  guide: (options) => ({
    content: usageGuide(options.purpose, options.instructions),
    summary:
      "Each caller's own Drive: query syntax, Docs as Markdown, capped content, recoverable trash, quiet sharing.",
    required: true,
  }),
  tools: driveTools,
  tagConnector: tagWorkspace("drive"),
});
