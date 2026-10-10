---
{
  "name": "vercel",
  "instructionsHeading": "Account instructions",
  "content": "shared"
}
---

<!-- fragment: oauth -->


Tool names, descriptions, argument schemas, and result schemas come from Vercel's live server. Connecta applies release-reviewed classification; reviewed writes stay writes even when Vercel claims they only read.

- Discover the live catalog before assuming a tool exists. Vercel can change the surface independently of a Connecta release, and account features may affect what the authorization can reach.
- Complete authorization and grant access to the owning team before acting. Listing this server does not prove team access.
- MCP pagination and arguments follow the live MCP schemas; do not apply REST pagination or argument shapes to them.
- Diagnose deployments with `get_deployment`, then build logs, runtime error clusters, and runtime logs.
- `get_project_env` and `filter_project_envs` can return decrypted environment values, so Connecta reviews them as writes and the pool's trust policy gates them. Prefer reading variable keys and targets without values.
- Purchase tools change billing. Read a quote first and carry its price, idempotency key, and requested term into the confirmed purchase unchanged.
- `get_access_to_vercel_url` creates a temporary access grant. Treat the URL it returns as a credential and do not expose it outside the requested task.
- `deploy_to_vercel` and `import-claude-design-from-url` can create or update live projects. Read the target and deployment mode before invoking them.
- An `auth_required` failure means this connector's OAuth grant is missing or expired. Run `authorize_connector` for this connector id, then retry.
<!-- endfragment -->

<!-- fragment: key -->


- This is Connecta's REST connector to `api.vercel.com`, holding one operator-managed access token. A default team routes calls; it does not narrow what the token can reach.
- `vercel_api_search` finds API operations, not records: it searches the pinned API index and names the tool that calls each operation. `vercel_api_details` returns one operation's parameters with types, enums, and required names. Neither sends a request.
- `vercel_api_read` calls GET operations, plus reviewed POSTs that only read: `POST /v2/observability/query`, registrar availability, price, and search, and `POST /v8/artifacts`. `vercel_api_write` calls every other POST, PUT, PATCH, and DELETE, with `method` and `path` stated; execution follows the configured pool trust policy.
- Paths are concrete and carry the version search returned: `/v13/deployments/dpl_123`, not `/deployments/dpl_123`. Pass `query` and `body` as JSON objects named as `vercel_api_details` lists them. Every call is checked against the pinned index before it is sent: an unknown path returns the nearest operations, and an unknown or missing parameter returns `validation.issues` with the accepted names. Nothing reached Vercel, so fix the call from that answer.
- Results arrive as `{ status, data, page? }`. On a list, `page.next` is the cursor and `page.param` the query parameter to pass it as: `until` (a millisecond timestamp from `pagination.next`) on most lists, `cursor` on newer ones. Lists belong inside `execute_code`; pass `select` (dot paths such as `deployments.uid` and `deployments.state`) to keep only the fields the question needs.
- `list_teams` returns team ids and slugs and the connection's default team. `get_deployment_build_logs` reads a deployment's build events without following live output. `get_runtime_logs` collects the runtime log stream for at most `waitMs` or `maxRows`, then stops and says why. Generic reads refuse `follow` and the runtime-log stream, which never end on their own.
- `vercel_api_upload` sends explicit text or base64 bytes to an octet-stream operation, such as `POST /v2/files` before a deployment (Connecta computes `x-vercel-digest`). `vercel_api_write` sends JSON only.
- Environment values never come back. `list_project_env_vars` never decrypts. `upsert_project_env_var` (`upsert: false` for create-only), `update_project_env_var`, and `delete_project_env_var` return metadata without values; values are write input only. Generic reads refuse `GET /v1/projects/{idOrName}/env/{id}`, `GET /v10/projects/{idOrName}/env`, `GET /v1/env/{id}`, and any `decrypt`, and Connecta replaces the value of every environment variable in any result with `"[redacted]"`, including project reads, shared variables, and audit events.
- Other secrets read as `[redacted]` in every result: credential-named fields and their whole contents (`token`, `secret`, `password`, `jwt`, `credentials`, `Authorization`, …), protection-bypass secrets (each bypass's metadata stays under a numbered placeholder), deploy hook URLs, drain and webhook headers and signing secrets (including the one a new webhook or drain returns), drain and webhook destination URLs and external route, rewrite, and redirect destinations beyond their scheme and host, the args and values of every header, cookie, and query rule (route transforms and conditions, firewall conditions), team invite codes, synced Global Config items, and credentials inside other URLs. Failures of every reviewed operation, and of any operation whose request takes a credential-named field, say only the status and a reviewed code. Read or rotate withheld secrets in the Vercel dashboard. A `[redacted]` field is never the real value; do not send it back.
- Refused by design: endpoints that mint credentials (access tokens, AI Gateway API keys, project OIDC and trace tokens, Connect and SSO tokens, Edge Config tokens, KMS-signed tokens, Flags SDK keys, protection-bypass secrets, installation credential rotation), Connect authorization requests, project transfer requests (the code lets another team claim the project), KMS signing, a domain move-out (its answer is a transfer token), Global Config items, backups, and tokens, and domain transfer auth codes. Each refusal names its reason.
- The hosted OAuth connection's documentation search, runtime error clusters, toolbar threads, agent runs, web analytics summaries, purchase quotes, `deploy_to_vercel`, and access grants for protected URLs do not exist with a token. Configure an OAuth connector for those.
- A `429` carries Vercel's reset time; Vercel meters endpoints separately, so wait before retrying the same operation. An `auth_required` failure means the token is missing, expired, or outside this team: an operator must replace it in this connection in the operator UI, and `authorize_connector` returns that handoff. A rejected argument comes back in Vercel's own words; read it rather than replacing the token.
<!-- endfragment -->

<!-- fragment: shared -->
- Resolve team, project, and deployment ids with list reads; never guess one. Team ids begin `team_`, project ids `prj_`, and deployment ids `dpl_`.
- Diagnose a deployment by reading its state first (`readyState`, `errorCode`, `errorMessage`), then its build logs, then runtime logs for a deployment that built. Narrow time windows before raising limits.
- Environment variable changes apply only to future deployments; a new deployment is a separate write. Promoting an existing deployment to production does not rebuild it.
- Treat every create, update, delete, promotion, cancellation, and purchase as a write. For guest calls, classification, and routing, fetch `skills({ name: "usage" })`.
<!-- endfragment -->
