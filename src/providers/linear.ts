import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import { defined } from "../connectors/api.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
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

export interface LinearOptions {
  /**
   * Human-readable display name; defaults to "Linear", or
   * "Linear (read-only)" when `access` is `"read-only"`.
   */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which workspace this is and what decisions it answers. */
  purpose: string;
  /** Required endpoint selection; see `documentation/linear.md`. */
  access: LinearAccess;
  /** OAuth or a personal API key; see `documentation/linear.md`. */
  auth?: RemoteMcpAuth;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Optional per-runtime policy; see `documentation/linear.md#rate-limits`. */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/** Reviewed reads; see `documentation/linear.md` and provider convention P5. */
const READ_ONLY_TOOLS = new Set([
  // Issues
  "list_issues",
  "get_issue",
  "list_issue_statuses",
  "get_issue_status",
  "list_issue_labels",
  // Projects
  "list_projects",
  "get_project",
  "list_project_labels",
  // Milestones
  "list_milestones",
  "get_milestone",
  // Initiatives
  "list_initiatives",
  "get_initiative",
  "list_initiative_labels",
  // Cycles
  "list_cycles",
  // Comments
  "list_comments",
  // Documents
  "list_documents",
  "get_document",
  // Teams and users
  "list_teams",
  "get_team",
  "list_users",
  "get_user",
  "get_workspace",
  // Templates
  "list_templates",
  "get_template",
  // Status updates
  "get_status_updates",
  // Releases
  "list_release_pipelines",
  "list_releases",
  "get_release",
  "list_release_notes",
  "get_release_note",
  // Code review
  "list_diffs",
  "get_diff",
  "get_diff_threads",
  // Attachments
  "get_attachment",
  // Agent skills
  "list_agent_skills",
  "get_agent_skill",
  // Documentation search
  "search_documentation",
  // Customer requests (plan-gated)
  "list_customers",
  // Markdown helper. It reads images out of content it is handed and touches
  // no workspace state; the hosted server ships it annotated `readOnlyHint:
  // true, idempotentHint: true`, and a fill-in classification agrees rather
  // than argues.
  "extract_images",
]);

/** Reviewed writes; `save_*` upsert rationale lives in `documentation/linear.md`. */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  // Issues
  ["save_issue", "destructive"],
  ["create_issue_label", "additive"],
  // Projects
  ["save_project", "destructive"],
  // Milestones
  ["save_milestone", "destructive"],
  // Initiatives
  ["save_initiative", "destructive"],
  ["create_initiative_label", "additive"],
  // Comments
  ["save_comment", "destructive"],
  ["delete_comment", "destructive"],
  // Documents
  ["save_document", "destructive"],
  // Status updates
  ["save_status_update", "destructive"],
  ["delete_status_update", "destructive"],
  // Releases
  ["save_release", "destructive"],
  ["save_release_note", "destructive"],
  // Code review
  ["save_diff_comment", "destructive"],
  ["resolve_diff_thread", "destructive"],
  ["delete_diff_comment", "destructive"],
  ["submit_diff_review", "destructive"],
  ["merge_diff", "destructive"],
  // Attachments
  ["prepare_attachment_upload", "additive"],
  ["create_attachment_from_upload", "additive"],
  ["create_attachment", "additive"],
  ["delete_attachment", "destructive"],
  // Explicit issue access
  ["share_issue", "destructive"],
  ["unshare_issue", "destructive"],
  // Customer requests (plan-gated)
  ["save_customer", "destructive"],
  ["delete_customer", "destructive"],
  ["save_customer_need", "destructive"],
  ["delete_customer_need", "destructive"],
]);

/** Release-reviewed manifest; see provider conventions P5 and P13. */
export const LINEAR_VETTED_CATALOG = vettedCatalog({
  reads: READ_ONLY_TOOLS,
  writes: WRITE_TOOLS,
});

function usageGuide(
  purpose: string,
  access: LinearAccess,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  // Leads the guide because discovery summarizes a connector by its first
  // content line: whether this connection can write at all is the one thing an
  // agent must know before it opens the guide, and `search_tools` shows the
  // summary without the description.
  const accessNote =
    access === "read-only"
      ? "Read-only connection: bound to Linear's read-only endpoint, whose token is scope-limited downstream, so every write fails at Linear regardless of arguments. Route writes to a connector configured for read-write access."
      : "Read-write connection: treat every `save_`, `create_`, `delete_`, `resolve_`, `submit_`, and `merge_` operation as a write. Connecta routes the maintained write catalog through `call_destructive_tool`; newly added tools also fail closed until a release classifies them.";
  return `# Linear usage

${accessNote}

Workspace purpose: ${purpose}

- Resolve identity before acting. \`list_teams\`, \`list_users\`, \`list_projects\`, \`list_issue_statuses\`, and \`list_issue_labels\` return the ids that create and update arguments expect; do not guess a team, status, label, or assignee id.
- Issues carry a human identifier like \`ENG-123\` — team key, dash, number — alongside a UUID. Use the identifier the request gave you and resolve it with \`get_issue\` or \`list_issues\` when a tool wants an id; never fabricate an identifier or renumber one.
- \`save_*\` tools are upserts: omit the record id to create, supply it to update in place. Read the record first when you mean to update, and send only the fields you intend to change — an upsert overwrites what you restate.
- Labels are the exception to that naming: \`create_issue_label\` and \`create_initiative_label\` only ever create.
- Projects, milestones, and initiatives nest: initiatives contain projects, projects contain milestones and issues, and cycles are per-team time boxes. Scope a search by team or project rather than listing the workspace and filtering afterwards.
- List tools paginate with a cursor. Thread the returned cursor for the next page instead of raising the page size, and reduce pages inside \`execute_code\` before returning them.
- This workspace's catalog is not the whole product. Customer requests, releases, and code review are plan- and feature-gated, so search the catalog for what this connector actually exposes rather than assuming a tool exists.
- Linear meters the underlying API per user per hour, shared with everything else that credential does. Reuse discovery results within a run and avoid speculative fan-out.
- An \`auth_required\` failure means this connector's Linear authorization is missing or expired: run \`authorize_connector\` for this connector id, then retry the same call unchanged.
${
    accountInstructions
      ? `\n## Workspace instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

/** A maintained Linear hosted-MCP connection. */
export function linear(id: string, options: LinearOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("linear() requires a non-empty workspace purpose.");
  }
  const access = options.access;
  if (access !== "read-write" && access !== "read-only") {
    throw new Error(
      `linear("${id}") requires access "read-write" or "read-only".`,
    );
  }
  const connector = remoteMcp(id, {
    url: LINEAR_MCP_ENDPOINTS[access],
    ...(options.authScope ? { authScope: options.authScope } : {}),
    // The title is what browse-time discovery renders; a read-only connection
    // says so there rather than only in a description the caller may not see.
    title:
      options.title ?? (access === "read-only" ? "Linear (read-only)" : "Linear"),
    description:
      access === "read-only"
        ? `Linear issue tracking and project planning (read-only) — ${purpose}`
        : `Linear issue tracking and project planning — ${purpose}`,
    // Linear's MCP endpoint takes an API key the same way it takes an OAuth
    // token — `Authorization: Bearer <yourtoken>` — so only the slot copy is
    // provider-specific and the bearer framing default stands. The bare-header
    // convention belongs to Linear's GraphQL API, not to this endpoint.
    auth: withCredentialDefaults(options.auth ?? { type: "oauth" }, {
      credential: {
        label: "Personal API key",
        description:
          "A Linear personal API key. It carries the issuing user's full workspace access and is stored encrypted; the read-only endpoint still limits what it can reach.",
        placeholder: "lin_api_…",
      },
    }),
    requireHttps: true,
    usageGuide: {
      content: usageGuide(purpose, access, options.instructions),
      // Explicit rather than derived. The derived summary would truncate the
      // access note mid-sentence at 120 characters, and the one thing a
      // browsing agent must not get wrong is whether this connection can write
      // at all ([#342](https://github.com/zackbart/connecta/issues/342)).
      summary:
        access === "read-only"
          ? "Read-only: every write fails at Linear. Id resolution, upsert semantics, and cursor paging."
          : "Read-write. Id resolution, `save_*` upsert semantics, plan-gated areas, and cursor paging.",
      // Not `required`. Linear's own schemas describe each call correctly; the
      // guide adds cross-tool sequence advice that is worth reading before a
      // write, not worth loading before every read.
    },
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
  });
  return withVettedCatalog(connector, LINEAR_VETTED_CATALOG);
}
