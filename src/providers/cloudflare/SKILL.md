---
{
  "name": "cloudflare",
  "instructionsHeading": "Account instructions",
  "content": "shared"
}
---

<!-- fragment: oauth -->


- The catalog is Cloudflare's own `docs`, `search`, and `execute`. `docs` searches Cloudflare developer documentation. `search` runs code against Cloudflare's OpenAPI document; `execute` runs code that may call any Cloudflare API endpoint the OAuth grant allows.
- Connecta classifies `execute` as a write, even for a program that only reads, because one program can mix GET, POST, PUT, PATCH, and DELETE and no schema proves otherwise. A read-only endpoint therefore gets `docs` and `search` here. Deployments that need API reads from a read-only endpoint configure an API-token connector, whose `cloudflare_api_read` and named reads are reads.
- Use `search` to find the exact method, path, and fields before writing an execute program. Do not guess an endpoint from product naming.
- Keep returned values small. Filter and project inside the Cloudflare program, then reduce again inside Connecta's `execute_code` when several calls must be joined.
- This connection has none of the REST connector's tools: no `cloudflare_api_*` validation against a pinned index, no `graphql_query`, no `cloudflare_api_upload`, and no account or zone pin. OAuth permissions are the boundary.
<!-- endfragment -->

<!-- fragment: oauth_tail -->
- An `auth_required` failure means this connector's Cloudflare authorization is missing or expired: run `authorize_connector` for this connector id, then retry the same call unchanged.
<!-- endfragment -->

<!-- fragment: global_warning -->


This connector holds a Global API Key. It acts as its Cloudflare user with every permission that user has, in every account and zone the user belongs to, and nothing on Cloudflare's side narrows it. A mistaken write can reach production domains, billing, and members across all of them. Prefer reads, state the account and zone of every write, and stop when a request is ambiguous. Writes under `/user` and `/memberships` are refused. R2 accepts API tokens only, so R2 operations fail with this key.
<!-- endfragment -->

<!-- fragment: key -->


- This is Connecta's REST connector to the Cloudflare v4 API, holding one operator-managed credential. `cloudflare_api_search` finds API operations in a pinned index (not records) and names the tool that calls each; `cloudflare_api_details` returns one operation's parameters and body with types, enums, and required names. Neither sends a request.
- `cloudflare_api_read` calls GET operations plus reviewed read-only POSTs: analytics queries, Analytics Engine and SQL API queries, Log Explorer SQL, Vectorize queries, KV bulk get, telemetry queries, application-name lookup, and validation checks (including custom posture finding types). `cloudflare_api_write` calls every other POST, PUT, PATCH, and DELETE with `method` and `path` stated. D1 `…/query` and `…/raw`, Durable Object queries, Workers AI `…/ai/run`, AI Search and AutoRAG search (query rewriting runs billed models), monetization checks, and flag evaluation are writes: they can change data, cost money, or activate something.
- Paths are concrete: substitute ids into the template search returned (`/zones/<zone id>/dns_records/<record id>`). Pass `query` and `body` as JSON named as details lists them; text operations (Analytics Engine SQL, Log Explorer SQL, Worker scripts) take a string body, and Vectorize inserts a list of objects sent as NDJSON. R2 calls accept `headers` with `cf-r2-jurisdiction` or `cf-r2-storage-class`. Encode a `/` inside an R2 object key or KV key name as `%2F`.
- Every call is checked against the pinned index before it is sent. An unknown path returns the nearest operations; an unknown or missing parameter returns `validation.issues` with the accepted names. Nothing reached Cloudflare, so fix the call from that answer.
- Under an account pin, each uncached zone-ownership check also spends the connector's call budget. Checks stay capped at three per call and 60 per five minutes per connector; an exhausted budget stops the check and the requested operation.
- Results arrive as `{ status, data, page? }` with Cloudflare's envelope unwrapped: `data` is the `result`. On a list, pass `page.next` as the `page.param` query argument (`page` for numbered lists, `cursor` for KV, R2, and other cursor lists). Lists belong inside `execute_code`; pass `select` (dot paths such as `id` and `name`) to keep only the fields the question needs.
- `list_zones` and `list_accounts` resolve names to ids; `verify_credential` separates a bad credential from a missing permission. `graphql_query` runs read-only GraphQL Analytics queries (mutations are refused before sending); filter every `zones` or `accounts` field by `zoneTag` or `accountTag`. A pinned connector sends one query per document, with every fragment it defines used.
- Multipart, binary, and file bodies go through `cloudflare_api_upload`: Worker scripts and versions, KV values, R2 objects, Pages deployments, Images, Stream, DNS zone-file import, and Snippets. It takes `textBody`, `base64Body`, or multipart `parts`, never a local file.
- Refused by design: every operation that mints, rotates, or hands back a credential (API tokens, Access service tokens, R2 temporary credentials, tunnel and Mesh node tokens, signing keys, registry credentials, direct-upload URLs, deploy hooks, preview and participant tokens), payment client secrets (including AI Gateway top-up configuration), Cloudforce One priority-intelligence match reads and updates (their response schemas are unreviewed), URL Scanner captures (results, HAR, DOM, raw responses: they hold the scanned session's cookies and headers; use the scan search for verdicts), and GETs that act (an email unsubscribe, a PagerDuty connect). Stored and embedded secrets (Turnstile, TSIG, webhook and identity-provider secrets, Stream keys, Logpush destination credentials, probe, custom-provider, and AI Search crawler headers (every `include_headers` map value; names stay), BGP keys, Zaraz variables, Hyperdrive database passwords, RealtimeKit storage credentials, transform-rule header values) and application setup form defaults and every environment or plain-text binding value (Pages, Containers, Workers, Builds; names and types stay) come back as `"[redacted]"` on every method. Notification, RealtimeKit, and data security webhook destinations keep only their scheme and host. Workers KV values are application data and come back as stored. Reviewed operations, and operations that take credentials, report Cloudflare's error codes without its error text. Worker script content is readable: it is code, and secret bindings are not part of it.
- An `auth_required` failure means the credential is missing, revoked, or malformed: an operator must replace it in this connection in the operator UI, and `authorize_connector` returns that handoff. `provider_permission_denied` means the credential works but lacks this permission or resource, or the call is outside the pin; ask rather than retry.
- Embedded URL safety uses reviewed paths plus global signing parameters. Generic credential-named query parameters (`code`, `key`, `token`, `sig`, etc.) and credential-looking fragments withhold the destination's entire query/fragment only in Workers build `lines`, Pages log `data.line`, and telemetry `$metadata.message`/`error` and raw string/object `source` payloads in both `events.events` and `invocations.*` on the reviewed log operations and vendor error text. Ordinary `code`/`key` links can therefore be false positives in these diagnostics. DNS TXT content, KV values, Access/Waiting Room custom HTML and other operator content keep those ordinary URL parameters byte for byte. Literal AWS SigV4/Google V4 `X-Amz-*`/`X-Goog-*` Signature, Credential and Security-Token values are withheld in every decoded string before projection. A withheld value is not the original: do not write it back. KV bulk writes also inspect decoded `value` fields with `base64: true` (up to Cloudflare's 25 MiB decoded value limit; malformed or oversized base64 is refused, and the host's inbound body cap still applies). All writes, including named writes and supported raw/base64/multipart uploads, reject URL destinations whose own query/fragment contains the exact `[redacted]` placeholder, plain or encoded, with `invalid_args` before dispatch. Admission iteratively checks every JSON key and value within the host's accepted request size, without separate depth or node-count ceilings; cyclic direct arguments are refused. A marker outside the destination remains ordinary text. Split strings, encoded host/signing names, bare hosts without `//`, and opaque bearer paths remain outside this scan. Binary responses represented as base64, including Worker JavaScript served as `application/javascript`, are returned unchanged and are not decoded/scanned. An envelope cursor that would change under URL sanitizing is omitted rather than echoed or reused.
<!-- endfragment -->

<!-- fragment: shared -->
- Resolve account and zone ids before acting; never guess one. Ids are 32-character hex strings, and a zone is found by its domain name. Defaults and pins route a connector; Cloudflare's permissions still decide what the credential may do.
- Read state before replacing, rolling back, or purging. For DNS, PATCH changes the fields you send and PUT replaces the whole record, so read the record first and send its type, name, and content with the change. Prefer a targeted cache purge (files, tags, hosts, or prefixes) over purging everything.
- Cloudflare reports failures in `errors` with numeric codes and returns `success: false`; read the message instead of retrying the same call.
- Honor rate-limit waits. Cloudflare documents 1,200 requests per five minutes per user, counted across the dashboard and every token; Connecta's per-runtime window approximates it, and a limited user is blocked for the rest of the window.
- Treat every create, update, delete, purge, deploy, and upload as a write. For guest calls, classification, and routing, fetch `skills({ name: "usage" })`.
<!-- endfragment -->

<!-- fragment: key_tail -->
- Cloudflare answers a rate limit with HTTP 429; the failure carries `retryAfterMs`. Failed authentication is limited separately (code 10502), so diagnose a credential once with `verify_credential` rather than retrying calls.
<!-- endfragment -->
