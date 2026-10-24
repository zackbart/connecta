import { skill } from "./skill.generated.js";
/**
 * Google Slides as the signed-in Workspace user: read a deck's text slide by
 * slide, any page element by element, its layouts and masters, its comment
 * threads, and a slide's thumbnail link; create a deck, add a slide, replace
 * text, comment and reply, and send raw `batchUpdate` requests behind
 * approval. Hand-written against the Slides API v1 reference
 * (https://developers.google.com/workspace/slides/api/reference/rest) and its
 * comments guide (https://developers.google.com/workspace/slides/api/guides/comments).
 *
 * Whose decks. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. Slides has no `users/me` to confine beneath — a presentation id
 * names a file in Drive — so the token's subject is the confinement: a
 * request reaches exactly the decks that person can open, and no argument
 * names an account.
 *
 * Everything readable is reachable. Every read result is built under the
 * shared Workspace result budget, so it is deliverable inside a program and
 * directly alike, and whatever a result cannot carry is named with the exact
 * cursor that reads it: text cut on a slide continues in get_page, element by
 * element and character by character; full structural JSON comes from slides_api_read;
 * layouts continue in list_layouts. Every cursor is bound to the deck and to
 * the revision it was issued at, so a deck that changed between pages is a
 * `conflict` to restart, never a page that skips or repeats.
 *
 * What it does not do. Slides has no list method; finding a deck is Drive's
 * job, and this connection says so rather than guessing. Nothing here shares,
 * moves, or deletes a file. Every write but the four additive ones — a deck,
 * a slide, a comment, a reply — is destructive, and the raw hatch requires
 * the revision it was read at, so a request built against an old read cannot
 * land on a deck someone else has changed since.
 *
 * Comments save apart. Slides commits a batch's deck changes and its comment
 * changes separately and reports the second in `commentUpdateState`, so a
 * batch can apply while its comments do not. Every write that carries a
 * comment request says so in a declared field rather than calling the batch
 * all or none, and tells the caller to re-read, not repeat.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/slides/drift.json` records the five methods the tools
 * call, and `pnpm run providers:check --provider slides` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
import { GOOGLE_GRANT_RENEWAL, googleGrant, tagWorkspace, workspaceOf } from "../_shared/google/kit.js";
import { GOOGLE_WORKSPACE_OPTIONS, type GoogleWorkspaceOptions } from "../_shared/google/workspace.js";
import {
  errors,
  SLIDES,
  SlidesApi,
  probe,
  safety,
  result,
  SLIDES_INDEX,
  SLIDES_VERDICTS,
  SLIDES_NAMED,
  slidesBinding,
} from "./api.js";
import { SLIDES_API_BASE_URL, SLIDES_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { slidesTools } from "./tools.js";
export { SLIDES_API_BASE_URL, SLIDES_SCOPES } from "./lib/constants.js";
export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";
/** Options for {@link slides}: the shared Workspace delegation options. */
export type SlidesOptions = GoogleWorkspaceOptions;
/**
 * A maintained Google Slides connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Slides API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches users' decks.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation. Add the client
 *    ID, or edit its existing entry, so its scopes include exactly this one
 *    ({@link SLIDES_SCOPES}):
 *    `https://www.googleapis.com/auth/presentations`. One entry carries every
 *    Workspace provider's scopes, comma-separated. A new grant can take up to
 *    24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * slides("decks", {
 *   purpose: "Team presentations",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Reads run in programs. `create_presentation`, `create_slide`,
 * `create_comment`, and `create_comment_reply` are additive writes the host
 * approves through call_destructive_tool or a program on a writable endpoint;
 * `replace_all_text`, `update_comment_thread`, `update_comment_post`,
 * `delete_comment`, `delete_comment_reply`, and `batch_update_presentation`
 * are destructive.
 */
export const slides = defineApiProvider<SlidesOptions>({
  name: "slides",
  title: "Google Slides",
  readme: "Google Slides",
  bundle: {
    baselineGzip: 385794,
    note: "./providers/slides step-2 snapshot measures 385,794 B gzip standalone before recording these bundle facts (#703), Node 26.12.0 and zlib-ng 1.3.1. Same-toolchain main ff3f7c3b measured 362,798 B: +22,996 B. This includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Google Slides as the signed-in Workspace user: read decks slide by slide, create them, edit their text, and comment — ${options.purpose}`,
  vendor: SlidesApi,
  baseUrl: (options) => options.baseUrl?.trim() || SLIDES_API_BASE_URL,
  maxResponseBytes: SLIDES_MAX_RESPONSE_BYTES,
  grant: (options) => googleGrant(SLIDES, workspaceOf("slides", options)),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  authenticate: bearer,
  errors,
  safety: () => safety,
  result,
  idempotencyKey: false,
  hatch: {
    name: "slides",
    title: "Google Slides",
    index: SLIDES_INDEX,
    verdicts: SLIDES_VERDICTS,
    named: SLIDES_NAMED,
    pathExample: "/presentations/deck1",
    pageCursor: "argument",
    binding: ({ connection }) => slidesBinding(connection),
  },
  probe,
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      "Workspace delegation is configured. Each call acts as the account deployment code maps the caller to; an agent uses its pool owner unless one shared account is configured. No argument selects a subject.",
      "Content windows: get_presentation defaults to 20 slides (maximum 100); get_page to 50 elements (maximum 500); list_layouts to 100 rows (maximum 500); list_comments to 50 threads (maximum 500). Slides has no vendor list pagination.",
      "Generic thumbnails/preview links are refused; get_slide_thumbnail is the reviewed short-lived-link workflow. The generic batch retains only the 49 shipped request kinds; no extra preview methods are admitted.",
      ...(options.readOnly ? ["This connection is read-only; writes are refused."] : []),
    ],
    summary: "Each caller's decks: text, notes, layouts, comments, guarded edits and indexed Slides JSON operations.",
    required: true,
  }),
  tools: slidesTools,
  tagConnector: tagWorkspace("slides"),
});
