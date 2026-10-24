import { skill } from "./skill.generated.js";
/**
 * Gmail, draft-only, as the signed-in Workspace user: search and read mail,
 * list labels, and create or update drafts — and nothing that sends, deletes,
 * or relabels. Hand-written against the Gmail API v1 reference
 * (https://developers.google.com/workspace/gmail/api/reference/rest).
 *
 * Whose mailbox. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. There is no per-user consent step, no operator credential slot,
 * and no argument that names a mailbox — the transport is confined beneath
 * `users/me`, so the token's subject is the only mailbox any request reaches.
 *
 * Why draft-only. `gmail.compose` is the narrowest scope that can write a
 * draft, and Google lets it send too; the tool surface is what keeps this
 * connection from sending. Every indexed send route is explicitly refused, so
 * nothing reaches `drafts.send` or `messages.send`. A deployment that wants an
 * agent to send mail is choosing something this provider deliberately does
 * not offer.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/gmail/drift.json` records the frozen inventory and the methods the tools
 * call, and `pnpm run providers:check --provider gmail` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { errors, GMAIL, GmailApi, probe, result, safety } from "./api.js";
import { GMAIL_API_BASE_URL, GMAIL_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { googleHatchBinding } from "../_shared/google/hatch.js";
import { index, verdicts, named, pages, refusalReasons } from "./lib/index.js";
import { gmailTools } from "./tools.js";
export { GMAIL_API_BASE_URL, GMAIL_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";
export type GmailOptions = GoogleWorkspaceOptions;

// --- Construction -----------------------------------------------------------------

/**
 * A maintained, draft-only Gmail connection acting as each signed-in
 * Workspace user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Gmail API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches mailboxes.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new. Paste
 *    the client ID and exactly these scopes, comma-separated
 *    ({@link GMAIL_SCOPES}):
 *    `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.compose`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to mailboxes:
 *
 * ```ts
 * gmail("mail", {
 *   purpose: "Staff email triage and reply drafting",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => mailboxes[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * `gmail.compose` technically allows sending; this connection never does,
 * because no tool reaches a send method. Drafts are additive writes the host
 * approves through call_destructive_tool or a program on a writable endpoint.
 */
export const gmail = defineApiProvider<GmailOptions>({
  name: "gmail",
  title: "Gmail",
  displayTitle: () => "Gmail (drafts only)",
  readme: "Gmail",
  bundle: {
    baselineGzip: 378563,
    note: "./providers/gmail measures 339,455 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899). The combined Gmail/Docs merge snapshot over main f9bf5afb remeasures this standalone entry at 378,563 B gzip before recording these facts, Node 22.23.3, esbuild 0.28.1, neutral Worker conditions and gzip level 9 (#703).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Gmail as the signed-in Workspace user: read mail and write drafts, never send — ${options.purpose}`,
  vendor: GmailApi,
  baseUrl: (options) => options.baseUrl?.trim() || GMAIL_API_BASE_URL,
  maxResponseBytes: GMAIL_MAX_RESPONSE_BYTES,
  grant: (options) => googleGrant(GMAIL, workspaceOf("gmail", options)),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  pageSize: { default: 10, max: 25 },
  idempotencyKey: false,
  hatch: {
    name: "gmail",
    title: "Gmail",
    index,
    verdicts,
    named,
    pages,
    pageCursor: "argument",
    pathExample: "/messages/message1",
    binding: ({ connection }) =>
      googleHatchBinding(connection, {
        index,
        review:
          "Exactly eleven reviewed Gmail reads beneath users/me. Draft writes use named guarded MIME tools; sending/settings/media are never admitted.",
        refuse: (call) => {
          const refused = refusalReasons[`${call.method} ${call.op.path}`];
          if (refused) return refused;
          if (call.query["maxResults"] !== undefined) {
            const count = Number(call.query["maxResults"]);
            if (!Number.isInteger(count) || count < 1 || count > 500)
              return "Gmail query.maxResults must be an integer from 1 to 500.";
          }
          return undefined;
        },
      }),
    notes: () => ({
      read: "Gmail is the three-hatch exception: there is no write hatch. Drafts use only create_draft/update_draft; sending is never available. Full MIME and raw-message fields retain decoded sent-secret safety. Use get_attachment for fresh immutable-part resolution and bounded decoded content.",
    }),
  },
  result,
  safety: () => safety,
  probe,
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      "Workspace delegation is already configured. The deployment chooses the subject; no argument selects a mailbox.",
      typeof options.subject === "string"
        ? "Every caller uses the deployment's fixed mailbox."
        : "Each call uses the mailbox mapped from its admitted caller or pool owner.",
      "A missing subject fails auth_required; ask the operator to repair configuration after an auth failure.",
      ...(options.readOnly ? ["This connection is read-only; draft writes are refused."] : []),
    ],
    summary: "Each caller's own mailbox: Gmail search syntax, capped bodies, reply threading, drafts that never send.",
    required: true,
  }),
  tools: gmailTools,
  tagConnector: tagWorkspace("gmail"),
});
