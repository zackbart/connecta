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
import { DOCS_INDEX, DOCS_VERDICTS, docsBinding } from "./lib/discovery.js";
import { docsResult } from "./safety.js";
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
    baselineGzip: 370111,
    note: "./providers/docs evaluated snapshot 2ce02c7c measures 369,878 B gzip standalone for Docs step 2 (#703), versus 354,308 B on main ff3f7c3b (+15,570 B), using Node 22.23.3, gzip level 9 and the standard neutral esbuild settings. This includes the shared Effect kit, paid once per deployment; standalone sizes are not additive and remain report-only. The combined Gmail/Docs merge snapshot over main f9bf5afb remeasures this standalone entry at 370,111 B gzip before recording these facts, with the same Node 22.23.3/neutral Worker/gzip-9 toolchain (#703).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Docs as the signed-in Workspace user: read, create, and edit documents by id — ${options.purpose}`,
  vendor: DocsApi,
  baseUrl: (options) => options.baseUrl?.trim() || DOCS_API_BASE_URL,
  maxResponseBytes: DOCS_MAX_RESPONSE_BYTES,
  idempotencyKey: false,
  grant: (options) => googleGrant(DOCS, workspaceOf("docs", options)),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  safety: () => safety,
  result: docsResult,
  probe,
  guide: (options) => ({
    heading: "Google Docs usage",
    context: [
      `Purpose: ${options.purpose}`,
      "Workspace delegation is configured by the deployment. Each call acts as the mapped Workspace user; document access follows that user's Drive sharing.",
      ...(options.readOnly ? ["This connection is read-only."] : []),
    ],
    summary: "Docs by id: tabs, UTF-16 edit indexes, revisions and partial-create recovery.",
    required: true,
  }),
  hatch: {
    name: "docs",
    title: "Google Docs",
    index: DOCS_INDEX,
    verdicts: DOCS_VERDICTS,
    named: {
      "GET /documents/{documentId}": "get_document",
      "POST /documents": "create_document",
      "POST /documents/{documentId}:batchUpdate": "batch_update_document",
    },
    pathExample: "/documents/doc_123",
    notes: () => ({
      write:
        "Batch updates require writeControl.requiredRevisionId, 1–100 requests and exactly one supported GA kind each; preview comment and suggestion kinds are refused.",
    }),
    binding: ({ connection }) => docsBinding(connection),
  },
  tools: docsTools,
  tagConnector: tagWorkspace("docs"),
});
