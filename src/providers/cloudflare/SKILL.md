---
{
  "name": "cloudflare",
  "instructionsHeading": "Account instructions"
}
---

<!-- fragment: guide_0 -->
- This is the explicit `surface: "api"` complement. Hosted MCP is the default; configure each under a separate connector id with independent authorization and recovery. Never fall back to another credential after an error or repeat a write to recover its response.
- Named tools are canonical for reads in read-only programs. `cloudflare_api_get` covers other GET endpoints, including text and byte-preserving `responseType: "base64"` downloads. Hosted `search` discovers API contracts; hosted `execute` owns ordinary JSON mutations. Execute remains a write even for a GET-only program.
- `cloudflare_api_mutate` retains only a demonstrated auth/header gap: Global API Key identity, or R2 bucket endpoints requiring `cf-r2-jurisdiction`, which is absent from the vendor request helper. Ordinary headers such as `Accept` do not qualify. Other API-token JSON mutations are refused locally and must use hosted `execute`.
- `cloudflare_api_upload` retains byte-safe upload bodies, explicit endpoint headers and multipart field/file encoding for Worker scripts, KV values, R2 objects, Images, Stream and Pages uploads. Other token-auth endpoints are refused, regardless of claimed content type. The vendor supports raw/multipart bodies, but its helper returns non-JSON bodies as text and exposes only content type on the request. Use API uploads when those compatibility requirements matter. Raw tools take a path below `/client/v4`; absolute URLs, traversal and embedded query strings are refused. `Authorization`, `Cookie`, `Host`, `Content-Length`, `Content-Type`, and `Transfer-Encoding` are connector-owned headers and cannot be overridden.
- Useful paths include `/accounts/{accountId}/images/v1`, `/accounts/{accountId}/stream`, `/accounts/{accountId}/d1/database`, `/accounts/{accountId}/queues`, `/accounts/{accountId}/r2/buckets/{bucketName}/cors`, and `/accounts/{accountId}/r2/metrics`. Change CORS with hosted `execute`, except for the explicit legacy-identity/header gaps above.
- Lists use `page`/`perPage` and return `page.hasMore`; rulesets, R2 buckets/objects and KV keys instead use opaque cursors. `list_worker_scripts` is unpaginated. Use `get_zone_setting` for one setting; Cloudflare deprecated the bulk `/zones/{zoneId}/settings` read. Reads project resource identity and state; `raw: true` returns dropped vendor fields.
- <!-- endfragment -->

<!-- fragment: guide_1 -->
- Honor vendor rate-limit waits. The documented 1,200 calls per five minutes are cumulative across a user and its tokens.
- Read state before replacement, rollback or purge. Prefer targeted cache purges in hosted `execute`. Mutations/uploads stay write-classified; approval belongs to the host and program access to the configured pool.
<!-- endfragment -->

<!-- fragment: guide_2 -->


- Hosted `execute` owns ordinary mutations. The separate `surface: "api"`
  complement owns read-only-program reads, binary/header-compatible uploads
  and legacy Global API Key or R2 jurisdiction mutations. Configure distinct
  connector ids and authorize each explicitly; there is no credential fallback.
- Resolve account and zone ids independently. Defaults do not constrain token permissions. Distinguish missing or revoked credentials from missing product permissions, and honor supplied rate-limit waits.
- The catalog contains `search` and `execute`. Search runs code against
  Cloudflare's OpenAPI document. Execute runs code that may call any authorized
  Cloudflare API endpoint.
- Use `search` to find the exact method, path, and fields before writing an
  execute program. Do not guess an endpoint from product naming.
- Connecta classifies `execute` as a write because it can mix GET, POST,
  PUT, PATCH, and DELETE requests inside one program. Read-only pools route
  it through `call_destructive_tool`; trusted pools permit it in programs.
  The host controls approval. The MCP schema cannot establish that arbitrary
  code is read-only.
- Keep returned values small. Filter and project inside the Cloudflare MCP
  program, then reduce again inside Connecta's `execute_code` when several
  calls must be joined.
- OAuth and API-token permissions remain the provider-side boundary. An
  `auth_required` failure needs authorization or a token with the required
  Cloudflare permission.
<!-- endfragment -->
