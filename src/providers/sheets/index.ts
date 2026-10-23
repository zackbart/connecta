import { skill } from "./skill.generated.js";
/**
 * Google Sheets as the signed-in Workspace user: read a spreadsheet's shape
 * and its values, write, append, and clear values, create spreadsheets and
 * sheets, and reach the rest of the editor through one approval-gated
 * `batchUpdate`. Hand-written against the Sheets API v4 reference
 * (https://developers.google.com/workspace/sheets/api/reference/rest).
 *
 * Whose spreadsheets. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. There is no per-user consent step, no operator credential slot,
 * and no argument that names an account. Sheets has no `users/me` root to
 * confine paths beneath, so the token is the confinement: a spreadsheet id
 * reaches exactly what that user could open in the Sheets UI, and nothing
 * more.
 *
 * What it will not do. Finding a spreadsheet by name is Google Drive's job —
 * the Sheets API has no list method — so this connection starts from an id.
 * It never moves, shares, or trashes a file, which are Drive's too.
 *
 * The safety classes. Reads are read-only. Creating a spreadsheet, adding a
 * sheet, and appending rows lose nothing and are additive writes. Writing over
 * a range, clearing one, and the raw `batchUpdate` — whose requests can delete
 * sheets, rows, and protections — are destructive. Append is pinned to
 * `INSERT_ROWS`: Google's `OVERWRITE` writes over whatever sits below the
 * table, and a tool that could do that is not additive.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/sheets/drift.json` records the seven methods the tools
 * call, and `pnpm run providers:check --provider sheets` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { errors, SHEETS, SheetsApi, probe, safety } from "./api.js";
import { SHEETS_API_BASE_URL, SHEETS_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { sheetsGuide, sheetsTools } from "./tools.js";

export { SHEETS_API_BASE_URL, SHEETS_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/** Options for {@link sheets}: the shared Workspace delegation options. */
export type SheetsOptions = GoogleWorkspaceOptions;

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Sheets connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Sheets API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches spreadsheets.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or
 *    edit the client ID's existing entry — one client ID has one entry, so add
 *    to the scopes another Workspace provider already listed rather than
 *    replacing them). The scope this connection needs ({@link SHEETS_SCOPES}):
 *    `https://www.googleapis.com/auth/spreadsheets`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * sheets("sheets", {
 *   purpose: "Finance and attendance spreadsheets",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 *    Agents never reach that function: give each pool they use an `owner`,
 *    the address they act as there (decisions/0006).
 *
 * Reads are read-only. `create_spreadsheet`, `add_sheet`, and `append_values`
 * are additive writes the host approves through call_destructive_tool or a
 * program on a writable endpoint; the value writes, `clear_values`, and the raw
 * `batch_update_spreadsheet` are destructive.
 */
export const sheets = defineApiProvider<SheetsOptions>({
  name: "sheets",
  title: "Google Sheets",
  readme: "Google Sheets",
  bundle: {
    baselineGzip: 333125,
    note: "./providers/sheets remeasures at 333,125 B gzip in C.7 on local Node 26, including reviewed fixed JSON keys: the shared Google Workspace layer now runs on the Effect provider kit, from 26,026 B for the api() provider (#682). A deployment pays the kit once, for its first kit provider. Reported against this baseline, not capped (#899).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Sheets as the signed-in Workspace user: read and write values in spreadsheets they can open, by id — ${options.purpose}`,
  vendor: SheetsApi,
  baseUrl: (options) => options.baseUrl?.trim() || SHEETS_API_BASE_URL,
  maxResponseBytes: SHEETS_MAX_RESPONSE_BYTES,
  grant: (options) => googleGrant(SHEETS, workspaceOf("sheets", options)),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  safety: () => safety,
  probe,
  guide: (options) => ({
    content: sheetsGuide(options.purpose, options.instructions),
    summary:
      "Each caller's own spreadsheets by id: A1 ranges, cell-paged reads, RAW or USER_ENTERED writes, raw batchUpdate.",
    // Whose spreadsheets they are, how Drive finds them, and the cell-write
    // meanings of null and "" are conventions no schema carries.
    required: true,
  }),
  tools: sheetsTools,
  tagConnector: tagWorkspace("sheets"),
});
