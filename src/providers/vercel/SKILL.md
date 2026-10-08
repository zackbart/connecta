---
{
  "name": "vercel",
  "instructionsHeading": "Account instructions"
}
---

<!-- fragment: guide_0 -->
`. Every named account-scoped tool accepts a `teamId` override; pass `null` to target the token owner's personal account.<!-- endfragment -->

<!-- fragment: guide_1 -->


Project names are accepted where Vercel accepts an id or name, but deployment,
environment-variable, and team ids are opaque. Read them from their list tool
and pass them back unchanged.

## Diagnose deployments in order

- Read `get_deployment` first. Its state says whether logs can still change.
- Use `get_build_logs` for install, build, and framework output.
- Use `get_runtime_logs` for application requests after a deployment runs.
- `promote_deployment` moves an existing build to production. It does not
  rebuild it. A rebuild or Git deployment belongs in `vercel_api_mutate`.

## Environment values

`list_project_env_vars` never decrypts or returns values. It reports names,
targets, visibility, branch bindings, and ids. The create and update tools take
values only as write input, and their projected results omit them. Environment
changes apply to future deployments, not deployments that already exist.

## Named tools and the REST hatches

Use named tools when one exists. They validate arguments and return smaller,
stable objects. `vercel_api_get` reaches every other GET endpoint and
`vercel_api_mutate` reaches JSON POST, PUT, PATCH, and DELETE endpoints.
`vercel_api_upload` sends explicit text or base64 bytes and never reads a
local file. Paths include Vercel's API version, such as `/v1/edge-config`,
and query parameters are name/value pairs. Pass `personalAccount: true` to
omit this connection's default team. No hatch accepts an absolute URL.

## Pagination and rate limits

List tools return `page.hasMore` and `page.nextCursor`. Pass the cursor back
unchanged. Vercel meters endpoints separately and returns the reset in response
headers. A rate-limit failure carries that delay when Vercel supplies it.
<!-- endfragment -->

<!-- fragment: guide_2 -->
# Vercel MCP usage

Official MCP surface: tool names, descriptions, argument schemas, and result
schemas come from Vercel's live server. Connecta preserves that catalog and
only fills in release-reviewed safety annotations when Vercel leaves them out.

Account purpose: <!-- endfragment -->

<!-- fragment: guide_3 -->


- Discover the live catalog before assuming a tool exists. Vercel can change
  the surface independently of a Connecta release, and account features may
  affect what the authorization can reach.
- Resolve team, project, deployment, run, thread, and order ids with the list
  and get tools. Do not guess opaque ids.
- Diagnose deployments with `get_deployment`, then build logs, runtime error
  clusters, and runtime logs. Narrow time windows before raising result limits.
- Purchase tools change billing. Read a quote first and carry its price,
  idempotency key, and requested term into the confirmed purchase unchanged.
- `get_access_to_vercel_url` creates a temporary access grant. Treat the URL
  it returns as a credential and do not expose it outside the requested task.
- `deploy_to_vercel` and `import-claude-design-from-url` can create or update
  live projects. Read the target and deployment mode before approving them.
- An `auth_required` failure means this connector's OAuth grant is missing or
  expired. Run `authorize_connector` for this connector id, then retry.
<!-- endfragment -->
