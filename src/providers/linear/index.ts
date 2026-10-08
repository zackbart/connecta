import { skill } from "./skill.generated.js";
import { remoteMcp, withCredentialDefaults, type RemoteMcpAuth } from "../../connectors/remote-mcp.js";
import { keys, optionsOf } from "../../config-schema.js";
import { REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import type { ConnectorCallAdmissionPolicy, ToolClassification } from "../../types.js";

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
    list_issues: {
      "verdict": "read",
      "reason": "Reads existing Linear list issues data without changing workspace state.",
    },
    get_issue: {
      "verdict": "read",
      "reason": "Reads existing Linear get issue data without changing workspace state.",
    },
    list_issue_statuses: {
      "verdict": "read",
      "reason": "Reads existing Linear list issue statuses data without changing workspace state.",
    },
    get_issue_status: {
      "verdict": "read",
      "reason": "Reads existing Linear get issue status data without changing workspace state.",
    },
    list_issue_labels: {
      "verdict": "read",
      "reason": "Reads existing Linear list issue labels data without changing workspace state.",
    },
    save_issue: { verdict: "destructive", reason: UPSERT },
    create_issue_label: {
      "verdict": "write",
      "reason": "Creates Linear state through create_issue_label; the reviewed operation only appends.",
    },
    // Projects
    list_projects: {
      "verdict": "read",
      "reason": "Reads existing Linear list projects data without changing workspace state.",
    },
    get_project: {
      "verdict": "read",
      "reason": "Reads existing Linear get project data without changing workspace state.",
    },
    list_project_labels: {
      "verdict": "read",
      "reason": "Reads existing Linear list project labels data without changing workspace state.",
    },
    save_project: { verdict: "destructive", reason: UPSERT },
    // Milestones
    list_milestones: {
      "verdict": "read",
      "reason": "Reads existing Linear list milestones data without changing workspace state.",
    },
    get_milestone: {
      "verdict": "read",
      "reason": "Reads existing Linear get milestone data without changing workspace state.",
    },
    save_milestone: { verdict: "destructive", reason: UPSERT },
    // Initiatives
    list_initiatives: {
      "verdict": "read",
      "reason": "Reads existing Linear list initiatives data without changing workspace state.",
    },
    get_initiative: {
      "verdict": "read",
      "reason": "Reads existing Linear get initiative data without changing workspace state.",
    },
    list_initiative_labels: {
      "verdict": "read",
      "reason": "Reads existing Linear list initiative labels data without changing workspace state.",
    },
    save_initiative: { verdict: "destructive", reason: UPSERT },
    create_initiative_label: {
      "verdict": "write",
      "reason": "Creates Linear state through create_initiative_label; the reviewed operation only appends.",
    },
    // Cycles
    list_cycles: {
      "verdict": "read",
      "reason": "Reads existing Linear list cycles data without changing workspace state.",
    },
    // Comments
    list_comments: {
      "verdict": "read",
      "reason": "Reads existing Linear list comments data without changing workspace state.",
    },
    save_comment: { verdict: "destructive", reason: UPSERT },
    delete_comment: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_comment.",
    },
    // Documents
    list_documents: {
      "verdict": "read",
      "reason": "Reads existing Linear list documents data without changing workspace state.",
    },
    get_document: {
      "verdict": "read",
      "reason": "Reads existing Linear get document data without changing workspace state.",
    },
    save_document: { verdict: "destructive", reason: UPSERT },
    // Teams and users
    list_teams: {
      "verdict": "read",
      "reason": "Reads existing Linear list teams data without changing workspace state.",
    },
    get_team: { "verdict": "read", "reason": "Reads existing Linear get team data without changing workspace state." },
    list_users: {
      "verdict": "read",
      "reason": "Reads existing Linear list users data without changing workspace state.",
    },
    get_user: { "verdict": "read", "reason": "Reads existing Linear get user data without changing workspace state." },
    get_workspace: {
      "verdict": "read",
      "reason": "Reads existing Linear get workspace data without changing workspace state.",
    },
    // Templates
    list_templates: {
      "verdict": "read",
      "reason": "Reads existing Linear list templates data without changing workspace state.",
    },
    get_template: {
      "verdict": "read",
      "reason": "Reads existing Linear get template data without changing workspace state.",
    },
    // Status updates
    get_status_updates: {
      "verdict": "read",
      "reason": "Reads existing Linear get status updates data without changing workspace state.",
    },
    save_status_update: { verdict: "destructive", reason: UPSERT },
    delete_status_update: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_status_update.",
    },
    // Releases
    list_release_pipelines: {
      "verdict": "read",
      "reason": "Reads existing Linear list release pipelines data without changing workspace state.",
    },
    list_releases: {
      "verdict": "read",
      "reason": "Reads existing Linear list releases data without changing workspace state.",
    },
    get_release: {
      "verdict": "read",
      "reason": "Reads existing Linear get release data without changing workspace state.",
    },
    list_release_notes: {
      "verdict": "read",
      "reason": "Reads existing Linear list release notes data without changing workspace state.",
    },
    get_release_note: {
      "verdict": "read",
      "reason": "Reads existing Linear get release note data without changing workspace state.",
    },
    save_release: { verdict: "destructive", reason: UPSERT },
    save_release_note: { verdict: "destructive", reason: UPSERT },
    // Code review
    list_diffs: {
      "verdict": "read",
      "reason": "Reads existing Linear list diffs data without changing workspace state.",
    },
    get_diff: { "verdict": "read", "reason": "Reads existing Linear get diff data without changing workspace state." },
    get_diff_threads: {
      "verdict": "read",
      "reason": "Reads existing Linear get diff threads data without changing workspace state.",
    },
    save_diff_comment: { verdict: "destructive", reason: UPSERT },
    resolve_diff_thread: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through resolve_diff_thread.",
    },
    delete_diff_comment: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_diff_comment.",
    },
    submit_diff_review: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through submit_diff_review.",
    },
    merge_diff: { "verdict": "destructive", "reason": "Changes or removes existing Linear state through merge_diff." },
    // Attachments
    get_attachment: {
      "verdict": "read",
      "reason": "Reads existing Linear get attachment data without changing workspace state.",
    },
    prepare_attachment_upload: {
      verdict: "write",
      reason: "Mints an upload URL: a side effect, but it changes no existing record.",
    },
    create_attachment_from_upload: {
      "verdict": "write",
      "reason": "Creates Linear state through create_attachment_from_upload; the reviewed operation only appends.",
    },
    create_attachment: {
      "verdict": "write",
      "reason": "Creates Linear state through create_attachment; the reviewed operation only appends.",
    },
    delete_attachment: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_attachment.",
    },
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
    list_agent_skills: {
      "verdict": "read",
      "reason": "Reads existing Linear list agent skills data without changing workspace state.",
    },
    get_agent_skill: {
      "verdict": "read",
      "reason": "Reads existing Linear get agent skill data without changing workspace state.",
    },
    // Documentation search
    search_documentation: {
      "verdict": "read",
      "reason": "Reads existing Linear search documentation data without changing workspace state.",
    },
    // Customer requests (plan-gated)
    list_customers: {
      "verdict": "read",
      "reason": "Reads existing Linear list customers data without changing workspace state.",
    },
    save_customer: { verdict: "destructive", reason: UPSERT },
    delete_customer: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_customer.",
    },
    save_customer_need: { verdict: "destructive", reason: UPSERT },
    delete_customer_need: {
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_customer_need.",
    },
    // Markdown helper.
    extract_images: {
      verdict: "read",
      reason:
        "Reads images out of content it is handed and touches no workspace state; the hosted server ships it annotated readOnlyHint: true and idempotentHint: true.",
    },
  },
};

/**
 * Connection-independent conventions. The access note and purpose lead the
 * rendered guide; deployment instructions follow it.
 */

/** The closed options linear() accepts, checked against LinearOptions. */
const LINEAR_OPTIONS = optionsOf<LinearOptions>()({
  ...PROVIDER_COMMON,
  ...keys("access"),
  auth: REMOTE_MCP_AUTH,
});

/** A maintained Linear hosted-MCP connection. */
export const linear = defineProvider<LinearOptions>({
  name: "linear",
  title: "Linear",
  kind: "mcp",
  readme: "Linear",
  bundle: { "baselineGzip": 127244, "maxGzip": 187244 },
  skill,
  options: LINEAR_OPTIONS,
  classify: LINEAR_CLASSIFICATION,
  create(id, options, provider) {
    const access = options.access;
    if (access !== "read-write" && access !== "read-only") {
      throw new Error(`linear("${id}") requires access "read-write" or "read-only".`);
    }
    // Leads the guide because discovery summarizes a connector by its first
    // content line: whether this connection can write at all is the one thing
    // an agent must know before it opens the guide, and `search_tools` shows
    // the summary without the description.
    const accessNote =
      access === "read-only"
        ? "Read-only connection: bound to Linear's read-only endpoint, whose token is scope-limited downstream, so every write fails at Linear regardless of arguments. Route writes to a connector configured for read-write access."
        : "Read-write connection: treat every `save_`, `create_`, `delete_`, `resolve_`, `submit_`, and `merge_` operation as a write. Connecta classifies the maintained writes explicitly and enforces the configured pool trust policy. Unknown tools without an explicit, uncontradicted read annotation fail closed.";
    return remoteMcp(id, {
      url: LINEAR_MCP_ENDPOINTS[access],
      ...provider.connectorOptions,
      // The title is what browse-time discovery renders; a read-only
      // connection says so there rather than only in a description the caller
      // may not see.
      title: options.title ?? (access === "read-only" ? "Linear (read-only)" : "Linear"),
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

/**
 * The reviewed classification in the legacy manifest form.
 *
 * @deprecated Read `linear.definition.classify` instead. This alias is derived
 * from it and retained for existing public imports.
 */
export const LINEAR_VETTED_CATALOG = reviewedCatalog(linear.definition.classify!, 'defineProvider("linear")');
