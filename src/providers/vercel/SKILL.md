---
{
  "name": "vercel",
  "instructionsHeading": "Account instructions"
}
---

<!-- fragment: guide_0 -->
`. Every named account-scoped tool accepts a `teamId` override; pass `null` to target the token owner's personal account.<!-- endfragment -->

<!-- fragment: guide_1 -->

## REST complement routing

Hosted MCP is the default. Configure this complement with `surface: "api"`
and a separate connector id and access-token credential. OAuth and API-token
stores are independent; failures never switch identity or replay a write.
Team defaults route calls and do not constrain the token's permissions.

Use hosted `list_teams`, `list_projects`, `get_project`, `list_deployments`,
`get_deployment`, `get_deployment_build_logs` or `list_deployment_events`,
`get_runtime_logs`, `list_project_domains`, `add_project_domain`, and
`cancel_deployment` for the corresponding operations. Follow their live schemas,
not the removed REST argument shapes. Read deployment status before logs and
narrow log windows.

This complement retains `verify_project_domain`, `remove_project_domain`,
`promote_deployment`, and `delete_deployment` because the reviewed category
pages do not publish equivalent tools. `promote_deployment` moves an existing
build to production and does not rebuild it. New deployments use hosted
`create_deployment` or `deploy_to_vercel`.

## Environment values

`list_project_env_vars` never decrypts or returns values. Set `upsert: false` on
`upsert_project_env_var` for create-only writes that refuse to overwrite. `upsert_project_env_var`,
`update_project_env_var`, and `delete_project_env_var` return metadata without
values. Create/update values are write input only. The hosted connector excludes
`filter_project_envs`, `get_project_env`, `create_project_env`, and
`edit_project_env`, whose published contracts lack these response protections.
Environment changes apply to future deployments.

## REST gaps and uploads

`vercel_api_get` and `vercel_api_mutate` reach uncovered endpoints. They refuse
paths owned by the canonical hosted or value-safe named tools. Do not use a
raw hatch to restore a removed duplicate. `upload_file` on MCP owns deployment
file uploads; `vercel_api_upload` retains other raw-body endpoints and explicit
headers. It never reads a local file. Paths include the API version and cannot
be absolute URLs. Query parameters are name/value pairs; `personalAccount: true`
omits this connection's default team. Rate-limit failures carry vendor retry timing.
<!-- endfragment -->

<!-- fragment: guide_2 -->
# Vercel MCP usage

Official MCP surface: tool names, descriptions, argument schemas, and result
schemas come from Vercel's live server. Connecta preserves retained vendor contracts and
applies release-reviewed classification. Reviewed writes stay writes even when Vercel claims they only read.

Account purpose: <!-- endfragment -->

<!-- fragment: guide_3 -->


- Hosted MCP owns discovery, deployments, logs, project-domain listing/adding,
  cancellation and file uploads. Use the separately configured REST complement
  for value-safe project environment variables, uncovered lifecycle/domain
  operations and REST gaps. It has its own connector id and credential.
- Discover the live catalog before assuming a tool exists. Vercel can change
  the surface independently of a Connecta release, and account features may
  affect what the authorization can reach.
- Complete authorization and grant access to the owning team before acting. Listing this server does not prove team access. A configured API `teamId` is a routing default, not an authorization boundary.
- MCP pagination and arguments follow the live MCP schemas; do not apply API pagination or argument shapes to them.
- Resolve team, project, deployment, run, thread, and order ids with the list
  and get tools. Do not guess opaque ids.
- Diagnose deployments with `get_deployment`, then build logs, runtime error
  clusters, and runtime logs. Narrow time windows before raising result limits.
- Purchase tools change billing. Read a quote first and carry its price,
  idempotency key, and requested term into the confirmed purchase unchanged.
- `get_access_to_vercel_url` creates a temporary access grant. Treat the URL
  it returns as a credential and do not expose it outside the requested task.
- `deploy_to_vercel` and `import-claude-design-from-url` can create or update
  live projects. Read the target and deployment mode before invoking them.
- An `auth_required` failure means this connector's OAuth grant is missing or
  expired. Run `authorize_connector` for this connector id, then retry.
<!-- endfragment -->
