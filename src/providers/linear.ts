import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { reviewedCatalog } from "../catalog-drift.js";
import { defineProvider, type ProviderOptions } from "../provider.js";
import type {
  ConnectorCallAdmissionPolicy,
  ToolClassification,
} from "../types.js";

/** Which of Linear's two hosted MCP endpoints this connection is bound to. */
export type LinearAccess = "read-write" | "read-only";

/**
 * Linear publishes two hosted endpoints. `read-only` is not a client-side
 * filter: it advertises the `read` scope alone, so the token minted for it
 * cannot reach Linear's write APIs at all. The deprecated `/sse` transport is
 * deliberately absent — it now answers 404.
 */
export const LINEAR_MCP_ENDPOINTS: Readonly<Record<LinearAccess, string>> = {
  "read-write": "https://mcp.linear.app/mcp",
  "read-only": "https://mcp.linear.app/mcp/readonly",
};

export interface LinearOptions extends ProviderOptions {
  /**
   * Human-readable display name; defaults to "Linear", or
   * "Linear (read-only)" when `access` is `"read-only"`.
   */
  title?: string;
  /** Which workspace this is and what decisions it answers. */
  purpose: string;
  /**
   * Endpoint selection, required with no default. Linear's read-only endpoint
   * advertises the `read` scope alone, so its token cannot reach the write APIs
   * — a stronger guarantee than any annotation. Neither default is safe:
   * read-write hands out access nobody asked for, and read-only breaks a
   * writing deployment at runtime, where no agent can repair it.
   */
  access: LinearAccess;
  /**
   * OAuth 2.1 with dynamic client registration by default. Linear's MCP server
   * also accepts a personal API key in `Authorization: Bearer` — note this is
   * the MCP endpoint's own documented contract, not the GraphQL API convention.
   * A personal key carries the acting user's full permissions, so pair it with
   * `access: "read-only"` unless the deployment genuinely writes.
   */
  auth?: RemoteMcpAuth;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /**
   * Optional per-runtime policy. There is no default: Linear documents no
   * MCP-specific limit, the GraphQL limits it rides are metered per user per
   * hour (and its own page disagrees with itself on the API-key figure), and
   * Connecta's counter is per runtime. Only the operator knows the workspace.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * Every `save_*` is destructive because Linear's `save_*` tools are upserts:
 * omitting a record id creates, supplying one overwrites in place, and the
 * schema cannot tell them apart.
 */
const UPSERT =
  "An upsert: supplying a record id overwrites that record in place, and the schema cannot tell a create from an update.";

/**
 * The release-reviewed classification (P5), used both to classify a live tool
 * and as the record the drift check compares against, so the annotation a
 * caller gets and the verdict a check reads can never disagree. It is a
 * superset: Linear's hosted `tools/list` varies by plan and enabled features,
 * so a name this workspace never returns costs nothing, while an unlisted new
 * one fails closed. The genuine creates — the `create_*_label` and attachment
 * tools — are plain writes rather than destructive.
 */
const LINEAR_CLASSIFICATION: ToolClassification = {
  tools: {
    // Issues
    list_issues: "read",
    get_issue: "read",
    list_issue_statuses: "read",
    get_issue_status: "read",
    list_issue_labels: "read",
    save_issue: { verdict: "destructive", reason: UPSERT },
    create_issue_label: "write",
    // Projects
    list_projects: "read",
    get_project: "read",
    list_project_labels: "read",
    save_project: { verdict: "destructive", reason: UPSERT },
    // Milestones
    list_milestones: "read",
    get_milestone: "read",
    save_milestone: { verdict: "destructive", reason: UPSERT },
    // Initiatives
    list_initiatives: "read",
    get_initiative: "read",
    list_initiative_labels: "read",
    save_initiative: { verdict: "destructive", reason: UPSERT },
    create_initiative_label: "write",
    // Cycles
    list_cycles: "read",
    // Comments
    list_comments: "read",
    save_comment: { verdict: "destructive", reason: UPSERT },
    delete_comment: "destructive",
    // Documents
    list_documents: "read",
    get_document: "read",
    save_document: { verdict: "destructive", reason: UPSERT },
    // Teams and users
    list_teams: "read",
    get_team: "read",
    list_users: "read",
    get_user: "read",
    get_workspace: "read",
    // Templates
    list_templates: "read",
    get_template: "read",
    // Status updates
    get_status_updates: "read",
    save_status_update: { verdict: "destructive", reason: UPSERT },
    delete_status_update: "destructive",
    // Releases
    list_release_pipelines: "read",
    list_releases: "read",
    get_release: "read",
    list_release_notes: "read",
    get_release_note: "read",
    save_release: { verdict: "destructive", reason: UPSERT },
    save_release_note: { verdict: "destructive", reason: UPSERT },
    // Code review
    list_diffs: "read",
    get_diff: "read",
    get_diff_threads: "read",
    save_diff_comment: { verdict: "destructive", reason: UPSERT },
    resolve_diff_thread: "destructive",
    delete_diff_comment: "destructive",
    submit_diff_review: "destructive",
    merge_diff: "destructive",
    // Attachments
    get_attachment: "read",
    prepare_attachment_upload: {
      verdict: "write",
      reason: "Mints an upload URL: a side effect, but it changes no existing record.",
    },
    create_attachment_from_upload: "write",
    create_attachment: "write",
    delete_attachment: "destructive",
    // Explicit issue access.
    share_issue: {
      verdict: "destructive",
      reason: "Changes who can see an existing issue.",
    },
    unshare_issue: {
      verdict: "destructive",
      reason: "Changes who can see an existing issue.",
    },
    // Agent skills
    list_agent_skills: "read",
    get_agent_skill: "read",
    // Documentation search
    search_documentation: "read",
    // Customer requests (plan-gated)
    list_customers: "read",
    save_customer: { verdict: "destructive", reason: UPSERT },
    delete_customer: "destructive",
    save_customer_need: { verdict: "destructive", reason: UPSERT },
    delete_customer_need: "destructive",
    // Markdown helper.
    extract_images: {
      verdict: "read",
      reason:
        "Reads images out of content it is handed and touches no workspace state; the hosted server ships it annotated readOnlyHint: true and idempotentHint: true.",
    },
  },
};

/**
 * The reviewed classification in the legacy manifest form.
 *
 * @deprecated Read `linear.definition.classify` instead. This alias is derived
 * from it, so the two cannot disagree, and is removed when the remaining
 * hosted providers convert (#705).
 */
export const LINEAR_VETTED_CATALOG = reviewedCatalog(
  LINEAR_CLASSIFICATION,
  'defineProvider("linear")',
);

/**
 * Connection-independent conventions. The access note and purpose lead the
 * rendered guide; deployment instructions follow it.
 */
const LINEAR_SKILL = `- Resolve identity before acting. \`list_teams\`, \`list_users\`, \`list_projects\`, \`list_issue_statuses\`, and \`list_issue_labels\` return the ids that create and update arguments expect; do not guess a team, status, label, or assignee id.
- Issues carry a human identifier like \`ENG-123\` — team key, dash, number — alongside a UUID. Use the identifier the request gave you and resolve it with \`get_issue\` or \`list_issues\` when a tool wants an id; never fabricate an identifier or renumber one.
- \`save_*\` tools are upserts: omit the record id to create, supply it to update in place. Read the record first when you mean to update, and send only the fields you intend to change — an upsert overwrites what you restate.
- Labels are the exception to that naming: \`create_issue_label\` and \`create_initiative_label\` only ever create.
- Projects, milestones, and initiatives nest: initiatives contain projects, projects contain milestones and issues, and cycles are per-team time boxes. Scope a search by team or project rather than listing the workspace and filtering afterwards.
- List tools paginate with a cursor. Thread the returned cursor for the next page instead of raising the page size, and reduce pages inside \`execute_code\` before returning them.
- This workspace's catalog is not the whole product. Customer requests, releases, and code review are plan- and feature-gated, so search the catalog for what this connector actually exposes rather than assuming a tool exists.
- Linear meters the underlying API per user per hour, shared with everything else that credential does. Reuse discovery results within a run and avoid speculative fan-out.
- An \`auth_required\` failure means this connector's Linear authorization is missing or expired: run \`authorize_connector\` for this connector id, then retry the same call unchanged.`;

/** A maintained Linear hosted-MCP connection. */
export const linear = defineProvider<LinearOptions>({
  name: "linear",
  title: "Linear",
  kind: "mcp",
  skill: { content: LINEAR_SKILL, instructionsHeading: "Workspace instructions" },
  classify: LINEAR_CLASSIFICATION,
  create(id, options, provider) {
    const access = options.access;
    if (access !== "read-write" && access !== "read-only") {
      throw new Error(
        `linear("${id}") requires access "read-write" or "read-only".`,
      );
    }
    // Leads the guide because discovery summarizes a connector by its first
    // content line: whether this connection can write at all is the one thing
    // an agent must know before it opens the guide, and `search_tools` shows
    // the summary without the description.
    const accessNote =
      access === "read-only"
        ? "Read-only connection: bound to Linear's read-only endpoint, whose token is scope-limited downstream, so every write fails at Linear regardless of arguments. Route writes to a connector configured for read-write access."
        : "Read-write connection: treat every `save_`, `create_`, `delete_`, `resolve_`, `submit_`, and `merge_` operation as a write. Connecta routes the maintained write catalog through `call_destructive_tool`; newly added tools also fail closed until a release classifies them.";
    return remoteMcp(id, {
      url: LINEAR_MCP_ENDPOINTS[access],
      ...provider.connectorOptions,
      // The title is what browse-time discovery renders; a read-only
      // connection says so there rather than only in a description the caller
      // may not see.
      title:
        options.title ??
        (access === "read-only" ? "Linear (read-only)" : "Linear"),
      description:
        access === "read-only"
          ? `Linear issue tracking and project planning (read-only) — ${options.purpose}`
          : `Linear issue tracking and project planning — ${options.purpose}`,
      // Linear's MCP endpoint takes an API key the same way it takes an OAuth
      // token — `Authorization: Bearer <yourtoken>` — so only the slot copy is
      // provider-specific and the bearer framing default stands. The
      // bare-header convention belongs to Linear's GraphQL API, not to this
      // endpoint.
      auth: withCredentialDefaults(options.auth ?? { type: "oauth" }, {
        credential: {
          label: "Personal API key",
          description:
            "A Linear personal API key. It carries the issuing user's full workspace access and is stored encrypted; the read-only endpoint still limits what it can reach.",
          placeholder: "lin_api_…",
        },
      }),
      requireHttps: true,
      classify: provider.classify,
      usageGuide: provider.usageGuide({
        context: [accessNote, `Workspace purpose: ${options.purpose}`],
        // Explicit rather than derived. The derived summary would truncate the
        // access note mid-sentence at 120 characters, and the one thing a
        // browsing agent must not get wrong is whether this connection can
        // write at all ([#342](https://github.com/zackbart/connecta/issues/342)).
        // Not `required`: Linear's own schemas describe each call correctly;
        // the guide adds cross-tool sequence advice worth reading before a
        // write, not before every read.
        summary:
          access === "read-only"
            ? "Read-only: every write fails at Linear. Id resolution, upsert semantics, and cursor paging."
            : "Read-write. Id resolution, `save_*` upsert semantics, plan-gated areas, and cursor paging.",
      }),
    });
  },
});
