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
 * connection from sending. There is no send tool and no raw hatch (H14), so
 * nothing reaches `drafts.send` or `messages.send`. A deployment that wants an
 * agent to send mail is choosing something this provider deliberately does
 * not offer.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/gmail/drift.json` records the nine methods the tools
 * call, and `pnpm run providers:check --provider gmail` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { errors, GMAIL, GmailApi, probe, result, safety } from "./api.js";
import { GMAIL_API_BASE_URL, GMAIL_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { gmailTools } from "./tools.js";
export { GMAIL_API_BASE_URL, GMAIL_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";
export type GmailOptions = GoogleWorkspaceOptions;

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
}

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
    baselineGzip: 340098,
    note: "./providers/gmail measures 340,098 B gzip in C.7, Node 22 CI static at 87e8a63d (run 39982381093): the shared Google Effect provider kit replaces the legacy transport (27,085 B). A deployment pays the kit once. Provider entries are reported, not capped (#899).",
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
  result,
  safety: () => safety,
  probe,
  guide: (options) => ({
    content: usageGuide(options.purpose, options.instructions),
    summary: "Each caller's own mailbox: Gmail search syntax, capped bodies, reply threading, drafts that never send.",
    required: true,
  }),
  tools: gmailTools,
  tagConnector: tagWorkspace("gmail"),
});
