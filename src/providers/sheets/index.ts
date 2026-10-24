import { skill } from "./skill.generated.js";
/**
 * Google Sheets as the signed-in Workspace user: read a spreadsheet's shape
 * and its values, write, append, and clear values, create spreadsheets and
 * sheets, and use indexed discovery, details, reads and writes for reviewed
 * editor operations. Pinned against the Sheets API v4 Discovery contract
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
 * The safety classes. Reads are read-only. All writes use the host's
 * destructive route. Named create/add/append catalog entries retain their
 * explicit destructiveHint:false through the shared builder; approval
 * routing is unchanged. Named append is pinned to `INSERT_ROWS`; hatch append
 * may choose Google's `OVERWRITE`, which can replace cells below the table.
 * Structural batches can delete sheets, rows and protections.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/sheets/drift.json` records all 17 indexed methods, including those the named tools
 * call, and `pnpm run providers:check --provider sheets` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { errors, SHEETS, SheetsApi, probe, safety } from "./api.js";
import { SHEETS_API_BASE_URL, SHEETS_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { SHEETS_HATCH, sheetsBinding } from "./lib/hatch.js";
import { sheetsTools } from "./tools.js";

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
 * Reads are read-only. Every write, including `create_spreadsheet`, `add_sheet`,
 * `append_values` and `batch_update_spreadsheet`, uses call_destructive_tool or a
 * program on a writable endpoint, with approval controlled by the host.
 */
export const sheets = defineApiProvider<SheetsOptions>({
  name: "sheets",
  title: "Google Sheets",
  readme: "Google Sheets",
  bundle: {
    baselineGzip: 395178,
    note: "./providers/sheets step-2 merge with Gmail main c6e91446 measures 395,178 B gzip standalone before recording these bundle facts, versus 353,451 B on main c6e91446 (+41,727 B), Node 22.23.3, esbuild 0.28.1 and gzip level 9. The all-six Google entry is 537,813 B versus 506,081 B (+31,732 B). This includes the shared Effect kit, paid once per deployment; provider entries remain report-only, uncapped and non-additive (#703).",
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
    context: [
      `Purpose: ${options.purpose}`,
      typeof options.subject === "string"
        ? "Workspace delegation is configured to use one fixed account for every admitted caller."
        : "Workspace delegation is configured to use the mapped Workspace user, or the agent pool owner. No argument selects an account.",
      "Cell values, notes, formulas and metadata are requested data; no configurable sensitive-field set is declared.",
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    instructions: options.instructions,
    summary:
      "Each caller's own spreadsheets by id: A1 ranges, cell-paged reads, RAW or USER_ENTERED writes, formatting and structure.",
    // Whose spreadsheets they are, how Drive finds them, and the cell-write
    // meanings of null and "" are conventions no schema carries.
    required: true,
  }),
  idempotencyKey: false,
  hatch: {
    ...SHEETS_HATCH,
    binding: ({ connection }) => sheetsBinding(connection),
    notes: () => ({
      read: "Paths are relative to /v4. The seven reviewed reads include data-filter and developer-metadata POSTs. Full vendor JSON follows the same safety boundary as named reads. fields narrows response data; query.fields is Google's vendor mask. Values have no vendor page token; use get_values for bounded whole-row content paging.",
      write:
        "Batch updates need 1–100 requests, exactly one reviewed kind each. Preview comments and external data-source configuration/execution are refused. Value writes retain scalar/null semantics and range/cell ceilings. Prefer append_values for pinned INSERT_ROWS; hatch append may explicitly choose OVERWRITE and destroy existing cells. No revision guarantee or idempotency key.",
    }),
  },
  tools: sheetsTools,
  tagConnector: tagWorkspace("sheets"),
});
