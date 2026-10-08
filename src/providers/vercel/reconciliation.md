# Vercel operation ownership

Hosted MCP is the default. `surface: "api"` explicitly selects the REST
complement under a separate connector id and access-token credential. OAuth team
access must be granted separately; a REST `teamId` default is routing, not a
permission boundary. The old `defaultPageSize` is deprecated and has no effect
on the REST complement; use hosted pagination arguments. There is no identity fallback or automatic write replay.

Reviewed on 2026-10-07: [current tool categories](https://vercel.com/docs/agent-resources/vercel-mcp/tools),
[projects](https://vercel.com/docs/agent-resources/vercel-mcp/tools/projects),
[deployments](https://vercel.com/docs/agent-resources/vercel-mcp/tools/deployments),
[observability](https://vercel.com/docs/agent-resources/vercel-mcp/tools/observability),
[domains](https://vercel.com/docs/agent-resources/vercel-mcp/tools/domains), and
[environment variables](https://vercel.com/docs/agent-resources/vercel-mcp/tools/environment-variables),
and [rolling releases](https://vercel.com/docs/agent-resources/vercel-mcp/tools/rolling-releases).
Category documentation covers more than the old 32-name review. The seven newly
reviewed canonical names have reasons in the definition; other live tools keep
registry fail-closed classification. The top-level drift parser's current
failure remains visible, rather than accepting its empty inventory as evidence.

| Capability | Canonical owner | Retained API reason |
| --- | --- | --- |
| Teams/projects/deployments, build/runtime logs, domain listing/adding, cancellation, file upload | Hosted MCP | Current categories document equivalents |
| Project environment metadata and writes | API `list_project_env_vars`, `upsert_project_env_var`, `update_project_env_var`, `delete_project_env_var` | Values never appear in results; `upsert: false` preserves create-only writes; hosted filter/get can decrypt and create/edit do not promise value-safe results |
| Domain verification/removal | API `verify_project_domain`, `remove_project_domain` | No equivalent published in reviewed projects/domains categories |
| Deployment promotion | Hosted `request_promote` | Current rolling-releases category and OpenAPI cover the original REST route |
| Deployment deletion | API `delete_deployment` | No equivalent in the 28 published categories |
| Remaining REST GET/JSON/raw-body operations | API `vercel_api_get`, `vercel_api_mutate`, `vercel_api_upload` | Generic gaps and explicit endpoint headers; migrated fixed operations and env routes are refused |

The hosted connector filters `filter_project_envs`, `get_project_env`,
`create_project_env`, and `edit_project_env`, and refuses direct calls to them.
Retained vendor tools keep their names, schemas and results. Raw-hatch rejection
normalizes dot segments and encoded paths before matching every API version,
before dispatch. It covers deployment creation, cancellation, promotion/deletion,
domain verification/removal, env operations and deployment file uploads.
`mcp-ownership.ts` records 185 REST counterparts from all 28 published categories
(213 tool names) and the pinned public OpenAPI hash. It includes project
create/update, pause/unpause, protection bypass, traces and other published
operations. Unreviewed annotations/classifications are not accepted as a new
baseline: names outside the classifier remain registry fail-closed. Virtual
tools without a public REST counterpart stay vendor-native. Exact operation/version
contracts resolve before generalized versions and wildcard ids. The concrete
`GET /v2/sandboxes/drives` REST gap remains available; the named-sandbox tool
cannot consume it.

| Removed API duplicate | Canonical hosted tool |
| --- | --- |
| `list_teams` | `list_teams` |
| `list_projects` | `list_projects` |
| `get_project` | `get_project` |
| `list_deployments` | `list_deployments` |
| `get_deployment` | `get_deployment` |
| `get_build_logs` | `list_deployment_events` |
| `get_runtime_logs` | `get_runtime_logs` |
| `list_project_domains` | `list_project_domains` |
| `add_project_domain` | `add_project_domain` |
| `cancel_deployment` | `cancel_deployment` |
| `promote_deployment` | `request_promote` |

`reconciliation-before.json` records both registry catalogs at `cf592d7b`;
`reconciliation-after.json` records the reconciled catalogs. Hosted names use
reviewed synthetic transport listings, not authenticated live captures. Tests
serve both through the production registry and check every removed mapping and
retained classification. Schemas and results for retained API tools remain under
the existing provider tests. No other provider implementation changes.
