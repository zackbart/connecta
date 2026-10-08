---
{
  "name": "linear",
  "instructionsHeading": "Workspace instructions"
}
---

<!-- fragment: content -->
- Issue arguments use `state`, not `status`. Resolve team-specific states through `list_issue_statuses` and use the value format required by the live input schema.
- Resolve identity before acting. `list_teams`, `list_users`, `list_projects`, `list_issue_statuses`, and `list_issue_labels` return the ids that create and update arguments expect; do not guess a team, status, label, or assignee id.
- Issues carry a human identifier like `ENG-123` — team key, dash, number — alongside a UUID. Use the identifier the request gave you and resolve it with `get_issue` or `list_issues` when a tool wants an id; never fabricate an identifier or renumber one.
- `save_*` tools are upserts: omit the record id to create, supply it to update in place. Read the record first when you mean to update, and send only the fields you intend to change — an upsert overwrites what you restate.
- Labels are the exception to that naming: `create_issue_label` and `create_initiative_label` only ever create.
- Projects, milestones, and initiatives nest: initiatives contain projects, projects contain milestones and issues, and cycles are per-team time boxes. Scope a search by team or project rather than listing the workspace and filtering afterwards.
- List tools paginate with a cursor. Thread the returned cursor for the next page instead of raising the page size, and reduce pages inside `execute_code` before returning them.
- This workspace's catalog is not the whole product. Customer requests, releases, and code review are plan- and feature-gated, so search the catalog for what this connector actually exposes rather than assuming a tool exists.
- Linear meters the underlying API per user per hour, shared with everything else that credential does. Reuse discovery results within a run and avoid speculative fan-out.
- An `auth_required` failure means this connector's Linear authorization is missing or expired: run `authorize_connector` for this connector id, then retry the same call unchanged.<!-- endfragment -->
