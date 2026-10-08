# Cloudflare operation ownership

Hosted MCP is the default. `surface: "api"` explicitly selects a REST
complement under a separate connector id. Configure OAuth or a scoped API token
for hosted MCP, and independently configure the API complement's token or
Global API Key plus email. Account/zone defaults do not narrow credential grants.

Reviewed on 2026-10-07: [vendor setup and token support](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
and the pinned [execute implementation](https://github.com/cloudflare/mcp/blob/b40563709cef29bb5b44f0bc3a75aacf29a913ae/src/tools/execute.ts).
It supports arbitrary HTTP methods, JSON, raw bodies and explicit multipart
encoding. Its helper accepts `contentType` but no arbitrary endpoint headers,
and consumes non-JSON results as text. The published bearer-token/OAuth route
does not accept the legacy Global API Key/email pair.

| Capability | Canonical owner | Retained API reason |
| --- | --- | --- |
| OpenAPI contract discovery | Hosted `search` | No operational API request |
| Ordinary JSON mutation, including DNS, Workers, KV, R2, Pages, cache purge | Hosted `execute` | Whole-API coverage with bearer tokens/OAuth |
| Named and arbitrary GET reads, including token/key verification and bulk KV read | API read tools | Preserve read-only-program access; `execute` is always a write, including GET-only code |
| Raw/multipart uploads on reviewed body endpoint families | API `cloudflare_api_upload` | Explicit UTF-8/base64 bodies, multipart file fields and endpoint headers; other token-auth endpoints refused |
| Legacy identity or R2 jurisdiction JSON mutations | API `cloudflare_api_mutate` | Global API Key/email auth, or R2 bucket endpoints requiring `cf-r2-jurisdiction`, unavailable in hosted helper |

API-token JSON mutations outside the R2 jurisdiction exception are refused before transport;
ordinary `Accept` headers and upload content-type assertions cannot bypass ownership.
Use hosted `execute`. Mutations on a Global API Key deployment still use the
explicit REST identity. Every removed named mutation has that explicit legacy-identity replacement
as well as hosted `execute` for API-token/OAuth identities. Both raw writes
retain destructive classification.
No request is replayed against another implementation after failure.

| Removed API duplicate | Canonical hosted tool |
| --- | --- |
| `create_dns_record` | `execute` |
| `create_kv_namespace` | `execute` |
| `create_r2_bucket` | `execute` |
| `retry_pages_deployment` | `execute` |
| `add_pages_domain` | `execute` |
| `update_zone_setting` | `execute` |
| `delete_worker_script` | `execute` |
| `rename_kv_namespace` | `execute` |
| `delete_kv_namespace` | `execute` |
| `bulk_write_kv_values` | `execute` |
| `bulk_delete_kv_values` | `execute` |
| `update_r2_bucket` | `execute` |
| `delete_r2_bucket` | `execute` |
| `delete_r2_object` | `execute` |
| `rollback_pages_deployment` | `execute` |
| `delete_pages_deployment` | `execute` |
| `delete_pages_domain` | `execute` |
| `purge_pages_build_cache` | `execute` |
| `delete_pages_project` | `execute` |
| `update_dns_record` | `execute` |
| `delete_dns_record` | `execute` |
| `purge_cache` | `execute` |

`reconciliation-before.json` records both registry catalogs at `cf592d7b`;
`reconciliation-after.json` records the reconciled catalogs. Hosted names use
reviewed synthetic transport listings, not authenticated live captures. Tests
serve both through the production registry and check every removed mapping and
retained classification. Schemas and results for retained API tools remain under
the existing provider tests. No other provider implementation changes.
