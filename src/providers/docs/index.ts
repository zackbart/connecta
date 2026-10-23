import { skill } from "./skill.generated.js";
/**
 * Google Docs as the signed-in Workspace user: read a document as readable
 * text with the indexes an edit needs, create one, append, insert, or replace
 * text, and send raw `documents.batchUpdate` requests behind approval.
 * Hand-written against the Docs API v1 reference
 * (https://developers.google.com/workspace/docs/api/reference/rest).
 *
 * Whose documents. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. Docs has no `users/me` path to confine beneath — a document id
 * addresses a Drive file — so the token's subject is the confinement: a
 * request reaches exactly the documents Drive shares with that person, and no
 * argument names anyone else.
 *
 * Why no search. Finding a document is Drive's job (`files.list` with a Docs
 * MIME type), and this connection requests only `documents`, which cannot
 * list anything. Duplicating a listing here would need a Drive scope this
 * connector deliberately does not ask for.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/docs/drift.json` records the three methods the tools
 * call, and `pnpm run providers:check --provider docs` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import { DOCS, DocsApi, errors, probe, safety } from "./api.js";
import { DOCS_API_BASE_URL, DOCS_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { docsTools } from "./tools.js";

export { DOCS_API_BASE_URL, DOCS_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

/** Options for {@link docs}: the shared Workspace delegation options. */
export type DocsOptions = GoogleWorkspaceOptions;

// --- Guide -------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
}

// --- Construction ------------------------------------------------------------------

/**
 * A maintained Google Docs connection acting as each signed-in Workspace user
 * through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Docs API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches documents.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or edit
 *    the service account's existing entry). Paste the client ID and add
 *    exactly this scope ({@link DOCS_SCOPES}):
 *    `https://www.googleapis.com/auth/documents`. One entry lists every
 *    Workspace provider's scopes, comma-separated. A new grant can take up to
 *    24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * docs("docs", {
 *   purpose: "Staff meeting notes and sermon drafts",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Reads run in programs. `create_document`, `append_text`, and `insert_text`
 * are additive writes the host approves through call_destructive_tool or a
 * program on a writable endpoint; `replace_all_text` and `batch_update_document` are
 * destructive.
 */
export const docs = defineApiProvider<DocsOptions>({
  name: "docs",
  title: "Google Docs",
  readme: "Google Docs",
  bundle: {
    baselineGzip: 333293,
    note: "./providers/docs remeasures at 333,293 B gzip in C.7 (decision 0010), on a local Node 26 measure: the provider now runs on the Effect provider kit through the shared Google Workspace layer, from 27,149 B for the api() provider. A deployment pays the kit once, for its first kit provider. Reported against this baseline, not capped (#899).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Docs as the signed-in Workspace user: read, create, and edit documents by id — ${options.purpose}`,
  vendor: DocsApi,
  baseUrl: (options) => options.baseUrl?.trim() || DOCS_API_BASE_URL,
  maxResponseBytes: DOCS_MAX_RESPONSE_BYTES,
  grant: (options) => googleGrant(DOCS, workspaceOf("docs", options)),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  safety: () => safety,
  probe,
  guide: (options) => ({
    content: usageGuide(options.purpose, options.instructions),
    summary: "Each caller's own Docs by id: readable text with edit indexes, append/insert/replace, raw batchUpdate.",
    // Required: whose documents they are, that ids come from elsewhere, and
    // that indexes shift and go stale are conventions no schema can carry.
    required: true,
  }),
  tools: docsTools,
  tagConnector: tagWorkspace("docs"),
});
