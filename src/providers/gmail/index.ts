import { skill } from "./skill.generated.js";
/**
 * Gmail, full read-write, as the signed-in Workspace user: search and read
 * mail; send, reply and forward; draft; relabel, archive, trash and
 * permanently delete; manage labels, filters and the vacation responder; and
 * reach every other mailbox setting through the indexed hatch. Hand-written
 * against the Gmail API v1 reference
 * (https://developers.google.com/workspace/gmail/api/reference/rest).
 *
 * Whose mailbox. In delegation mode, access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. There is no per-user consent step, no operator credential slot,
 * and no argument that names a mailbox — the transport is confined beneath
 * `users/me`, so the token's subject is the only mailbox any request reaches.
 *
 * Why full access. Owners want an agent to work the mailbox as a person
 * does, so the connection requests `https://mail.google.com/` (the only scope
 * admitting permanent deletion) and both settings scopes. Every write is
 * classified as one, and sends and permanent deletes are destructive and say
 * so; the host owns approval. A deployment that wants less marks the
 * connection `readOnly` or exposes only chosen tools through its pools.
 *
 * OAuth mode (`{ oauth, authScope }`) instead uses the downstream OAuth grant
 * of each connected Google account, or one shared account, with the same
 * scopes and tool surface (`src/providers/_shared/google/kit.ts`).
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `src/providers/gmail/drift.json` records the frozen inventory and the methods the tools
 * call, and `pnpm run providers:check --provider gmail` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { bearer } from "../../http/oauth.js";
import { defineApiProvider } from "../../http/provider.js";
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
import { errors, GMAIL, GmailApi, probe, result, safety } from "./api.js";
import { GMAIL_API_BASE_URL, GMAIL_MAX_RESPONSE_BYTES } from "./lib/constants.js";
import { googleHatchBinding } from "../_shared/google/hatch.js";
import { index, verdicts, named, pages } from "./lib/index.js";
import { refuseWithheldRaw } from "./lib/raw.js";
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
 * A maintained, full read-write Gmail connection acting as each signed-in
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
 *    `https://mail.google.com/,https://www.googleapis.com/auth/gmail.settings.basic,https://www.googleapis.com/auth/gmail.settings.sharing`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to mailboxes:
 *
 * ```ts
 * gmail("mail", {
 *   purpose: "Staff email triage and replies",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => mailboxes[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Sends, permanent deletes and every other mailbox change are writes the host
 * approves through call_destructive_tool or a program on a writable endpoint.
 */
export const gmail = defineApiProvider<GmailOptions>({
  name: "gmail",
  title: "Gmail",
  displayTitle: () => "Gmail",
  readme: "Gmail",
  bundle: {
    baselineGzip: 379539,
    note: "./providers/gmail measures 339,455 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899). The combined Gmail/Docs merge snapshot over main f9bf5afb remeasures this standalone entry at 378,563 B gzip before recording these facts, Node 22.23.3, esbuild 0.28.1, neutral Worker conditions and gzip level 9 (#703). The round-1 fix snapshot remeasures 379,199 B gzip before recording this additional fact, using the same toolchain; caps remain unchanged. Combined Gmail/Docs/Forms merge snapshot over main 84fb4eee measures 379,265 B gzip before recording these facts, Node 22.23.3, esbuild 0.28.1, neutral Worker conditions and gzip level 9; no cap changes (#703). Combined Google merge snapshot over main db979604 measures 379,539 B gzip before recording these facts, Node 22.23.3, esbuild 0.28.1, neutral Worker conditions and gzip level 9; no cap changes (#703). Full read-write (#1398) measures 414,075 B against 400,989 B for main cbc920bf on the same local toolchain (Node 22.23.4, esbuild 0.28.2): +13,086 B for twenty-two named tools, the write hatch and the settings value-safety table; provider entries stay uncapped.",
  },
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  description: (options) =>
    `Gmail as ${googleActor("gmail", options)}: read, send, organize and delete mail and manage settings — ${options.purpose}`,
  vendor: GmailApi,
  baseUrl: (options) => options.baseUrl?.trim() || GMAIL_API_BASE_URL,
  maxResponseBytes: GMAIL_MAX_RESPONSE_BYTES,
  grant: (options) => googleDelegatedGrant(GMAIL, "gmail", options),
  grantRenewal: GOOGLE_GRANT_RENEWAL,
  oauth: (options) => googleOAuth(GMAIL, "gmail", options, [options.baseUrl?.trim() || GMAIL_API_BASE_URL]),
  oauthWrite401: "grant",
  authScope: googleAuthScope("gmail"),
  connectionErrors: googleConnectionErrors(GMAIL, "gmail", errors),
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
    pathExample: "/messages/{id}",
    binding: ({ connection }) =>
      googleHatchBinding(connection, {
        index,
        review:
          "All 79 reviewed Gmail methods beneath users/me with literal read, write and destructive verdicts; composed raw MIME is checked for withheld links before send.",
        refuse: (call) => {
          const withheld = refuseWithheldRaw(call.body);
          if (withheld) return withheld;
          if (call.query["maxResults"] !== undefined) {
            const count = Number(call.query["maxResults"]);
            if (!Number.isInteger(count) || count < 1 || count > 500)
              return "Gmail query.maxResults must be an integer from 1 to 500.";
          }
          return undefined;
        },
      }),
    notes: () => ({
      read: "Full MIME and raw-message fields retain decoded sent-secret safety. Use get_attachment for fresh immutable-part resolution and bounded decoded content.",
      write:
        "Prefer the named tools, which build RFC 2822 MIME, threading and merges. A raw body here is base64url RFC 2822 that you compose; messages/send and drafts/send deliver a message immediately and irreversibly.",
    }),
  },
  result,
  safety: () => safety,
  probe,
  blocks: {
    keys: ["writes"],
    select: (options) => (options.readOnly ? [] : ["writes"]),
  },
  guide: (options) => ({
    context: [
      `Purpose: ${options.purpose}`,
      ...(googleOAuthContext("gmail", options) !== undefined
        ? [googleOAuthContext("gmail", options)!]
        : [
            "Workspace delegation is already configured. The deployment chooses the subject; no argument selects a mailbox.",
            typeof options.subject === "string"
              ? "Every caller uses the deployment's fixed mailbox."
              : "Each call uses the mailbox mapped from its admitted caller or pool owner.",
            "A missing subject fails auth_required; ask the operator to repair configuration after an auth failure.",
          ]),
      ...(options.readOnly ? ["This connection is read-only; sends, drafts and every other change are refused."] : []),
    ],
    summary: "Load for Gmail search, bodies, sending, threaded replies, forwards, labels, trash, filters and vacation.",
    required: true,
  }),
  tools: gmailTools,
  tagConnector: tagWorkspace("gmail"),
});
