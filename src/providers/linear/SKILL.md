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
- Prefer `save_issue_label`, `save_project_label`, and `save_initiative_label` for label upserts. The deprecated `create_issue_label` and `create_initiative_label` remain create-only writes. Resolve existing labels with the corresponding `list_*_labels`; when updating issue or project labels, `teamId` disambiguates a name and cannot move the label to another team.
- `retire_*_label` prevents new uses while preserving labels on existing records. Retiring a group retires its children; restoring a group restores every child, including children retired separately. Check the group and child scope before either lifecycle write.
- `get_notifications` only reads the authenticated user's inbox. `mark_notification` writes read/unread or snooze state; resolve notification ids from that inbox before marking.
- Read `get_diff` before `update_diff` and send only intended changes. Combined updates can partially succeed: inspect the result and reread before deciding whether any remaining change needs another call; never blindly replay the whole write. Use `merge_diff` to merge and `submit_diff_review` to approve or request changes.
- Projects, milestones, and initiatives nest: initiatives contain projects, projects contain milestones and issues, and cycles are per-team time boxes. Scope a search by team or project rather than listing the workspace and filtering afterwards.
- List tools paginate with a cursor. Thread the returned cursor for the next page instead of raising the page size, and reduce pages inside `execute_code` before returning them.
- This workspace's catalog is not the whole product. Customer requests, releases, and code review are plan- and feature-gated, so search the catalog for what this connector actually exposes rather than assuming a tool exists.
- Linear meters the underlying API per user per hour, shared with everything else that credential does. Reuse discovery results within a run and avoid speculative fan-out.
- An `auth_required` failure means this connector's Linear authorization is missing or expired: run `authorize_connector` for this connector id, then retry the same call unchanged.<!-- endfragment -->
