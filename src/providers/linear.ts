import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
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
  /** Which workspace this is and what decisions it answers. */
  purpose: string;
  /**
   * Endpoint selection. Required, and deliberately undefaulted.
   *
   * `"read-only"` binds the connection to Linear's read-only endpoint, whose
   * token is scope-limited downstream — a stronger guarantee than any
   * annotation Connecta applies. `"read-write"` reaches the full API.
   *
   * Neither is a safe default. Defaulting to `"read-write"` hands a deployment
   * write access it never asked for, and defaulting to `"read-only"` turns a
   * deployment that does write into one whose every write fails at Linear —
   * at runtime, where no agent can repair it. So the operator declares it, and
   * a deployment that forgot fails here instead
   * ([#342](https://github.com/zackbart/connecta/issues/342)).
   */
  access: LinearAccess;
  /**
   * OAuth by default. A Linear personal API key works either as a literal
   * header or as an operator-managed credential (`{ type: "credential" }`),
   * which Linear expects bare — no `Bearer` framing — in `Authorization`.
   */
  auth?: RemoteMcpAuth;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /**
   * Optional per-runtime call-admission policy. Deliberately not defaulted:
   * Linear documents no MCP-specific limit, and the underlying API limit is
   * per user per hour, varies by credential type, and is raised dynamically
   * for workspace-level OAuth apps. A hardcoded per-runtime ceiling would
   * either throttle a healthy deployment or fail to protect a busy one, so
   * the number stays with the operator who knows the workspace.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * Tools whose contract is observational rather than mutating.
 *
 * Linear's hosted catalog is not a fixed set — it varies by workspace plan and
 * enabled features (customer requests, releases, and code review are gated),
 * so this list is a superset of what any one workspace lists. A name here that
 * the workspace never returns costs nothing; a real read missing from it merely
 * fails closed. Only a write mistakenly listed here would be a safety bug,
 * which is why ambiguous helpers stay out.
 */
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

/**
 * The maintained write catalog. `"destructive"` tools modify or remove state
 * that already exists; `"additive"` ones only bring something new into being.
 * Both leave the read-only path — the distinction only decides whether the
 * connection asserts `destructiveHint`, which shapes the host's approval copy.
 *
 * Linear's `save_*` tools are upserts: passing an existing record's id updates
 * it in place. An upsert can therefore overwrite, so every `save_*` is
 * destructive even though some calls only create. The `create_*_label` tools
 * are the genuine creates.
 */
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
  // Customer requests (plan-gated)
  ["save_customer", "destructive"],
  ["delete_customer", "destructive"],
  ["save_customer_need", "destructive"],
  ["delete_customer_need", "destructive"],
]);

/**
 * The manifest this release reviewed: both lists in one place, which is what
 * makes the classification the connector applies and the drift check that runs
 * beside it the same fact (P13). No schema digests yet — no release has read
 * Linear's live schemas and written them down, and an invented digest would
 * report a change that never happened. `npm run drift:check -- --record` reads
 * them from a live workspace and prints the block to paste in
 * ([#351](https://github.com/zackbart/connecta/issues/351)).
 *
 * Exported because the maintainer-run check compares against this manifest and
 * *names* what moved, which the runtime check deliberately cannot.
 */
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
    // The title is what browse-time discovery renders; a read-only connection
    // says so there rather than only in a description the caller may not see.
    title:
      options.title ?? (access === "read-only" ? "Linear (read-only)" : "Linear"),
    description:
      access === "read-only"
        ? `Linear issue tracking and project planning (read-only) — ${purpose}`
        : `Linear issue tracking and project planning — ${purpose}`,
    // Linear reads a personal API key straight out of `Authorization` with no
    // scheme token in front of it, so credential auth defaults to `null`
    // framing rather than the bearer form every other provider here uses.
    auth: withCredentialDefaults(options.auth ?? { type: "oauth" }, {
      credential: {
        label: "Personal API key",
        description:
          "A Linear personal API key. It carries the issuing user's full workspace access and is stored encrypted; the read-only endpoint still limits what it can reach.",
        placeholder: "lin_api_…",
      },
      scheme: null,
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
    ...(options.callAdmission !== undefined
      ? { callAdmission: options.callAdmission }
      : {}),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
  return withVettedCatalog(connector, LINEAR_VETTED_CATALOG);
}
