# Cloudflare prebuilt connection

Import `cloudflare()` independently from
`@zackbart/connecta/providers/cloudflare`. It is a deliberate, hand-written
surface over Cloudflare's v4 REST API. Fifty-five tools combine ergonomic,
fully described operations for common work with three guarded escape hatches
for the rest of Cloudflare's fast-moving control plane. Reads, JSON mutations,
and raw/multipart uploads remain separate so safety routing does not depend on
an agent-supplied HTTP method. The connection keeps lean projections, typed
failures, and a rate-limit budget matching the documented one. It adds no
provider dependency, imports nothing outside Connecta, and is not reachable
from Connecta's root entry.

```ts
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";

const edge = cloudflare("cloudflare_prod", {
  title: "Production edge",
  purpose: "DNS and cache administration for the production estate",
  zoneId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  accountId: "9f8e7d6c5b4a30291817263544332211",
  instructions: "Never purge the whole zone during business hours.",
});
```

The `id` owns the ordinary connector namespaces; use a different id for every
Cloudflare account or estate. `purpose` is required because an agent choosing
between a production and a staging instance needs to know which one answers the
question. Account `instructions` are appended to the maintained guide and
cannot change the connector's safety classification.

## No SDK, on purpose

Cloudflare publishes an official `cloudflare` npm SDK, and this connection does
not use it. The SDK's value is typed request wrappers and pagination helpers.
Both are things this connection replaces rather than consumes: an agent needs a
projected result and a `page.hasMore` boolean, not Cloudflare's full response
object, so the SDK's types would be re-projected away at the boundary. What the
dependency would cost is real — an optional peer with its own install step and
version skew, an import that never belongs in the root graph, and a second
opinion about what a Cloudflare call looks like.

The API itself does not need one. It is Bearer-token `fetch` with a uniform
`{ success, errors, messages, result, result_info }` response envelope. JSON,
raw bytes, and multipart request bodies all use Web APIs, which keeps the
provider Workers-clean and means `@zackbart/connecta/providers/cloudflare`
installs and runs with nothing extra. `test/package-surface.test.ts` pins the
claim: the `cloudflare` package must not appear in `dependencies`,
`peerDependencies`, or `devDependencies`, and every import in the provider
must be relative.

## Credentials

The connection declares one operator-managed credential: a scoped Cloudflare
API token, sent as `Authorization: Bearer <token>`. Create it under My Profile →
API Tokens → Create Token. Do not use a Global API Key — it carries every
permission on the account and cannot be scoped.

Grant only what the deployment needs:

| Tools | Token permission | Scope |
| --- | --- | --- |
| Zone discovery and settings reads | Zone Read | Zone |
| `update_zone_setting` | Zone Settings Write | Zone |
| Zone ruleset reads | Relevant Rules product Read permission, such as Transform Rules Read or Firewall Services Read | Zone |
| `list_dns_records`, `get_dns_record` | DNS Read | Zone |
| `create_dns_record`, `update_dns_record`, `delete_dns_record` | DNS Write | Zone |
| `purge_cache` | Cache Purge | Zone |
| Worker script/deployment reads | Workers Scripts Read | Account |
| Worker writes through named or raw tools | Workers Scripts Write | Account |
| KV reads | Workers KV Storage Read | Account |
| KV creates, renames, writes, and deletes | Workers KV Storage Write | Account |
| R2 reads | Workers R2 Storage Read | Account |
| R2 creates, changes, uploads, deletes, and configuration writes | Workers R2 Storage Write | Account |
| Pages reads | Cloudflare Pages Read | Account |
| Pages retries, rollbacks, domains, purges, uploads, and deletes | Cloudflare Pages Write | Account |
| Images, Stream, Email Routing, D1, Queues, and other raw calls | Matching product Read or Write permission | Account or Zone |

Most names above appear directly in the token editor. Ruleset access is split
by product and phase, so grant the narrow Rules permission for the phases the
agent must inspect rather than looking for one generic "Zone Rulesets Read"
scope. "Cache Purge" is a single permission with no Read/Write split, and
Cloudflare's own reference renders a few labels differently between its
Dashboard and API tabs.

`verify_api_token` needs no permission beyond the token existing, which is what
makes it the right first call when something fails. The `/credentials` Test
action runs the same verification against the candidate token before it is
stored.

Cloudflare rate-limits *authentication failures* aggressively and separately
from the global limit: a few requests with a bad token return HTTP 429 with
code `10502`, "Too many authentication failures". That surfaces here as
`rate_limited`, not `auth_required`, which is correct — the token may well be
fine by the time the window clears — but it means a broken token should be
diagnosed once with `verify_api_token` rather than by retrying real calls.

## Scoping

`zoneId` and `accountId` are deployment defaults, not restrictions. When a
default is set, the corresponding argument drops out of the tool's `required`
list and calls that omit it use the default; a call may still pass a different
id. When no default is set, the argument is required and the schema's own
description names the discovery tool that produces it — `list_zones` for a
zone, `list_accounts` for an account.

That is the discovery flow worth knowing: Cloudflare addresses almost
everything by an opaque 32-character id, and an agent that only knows a domain
name must call `list_zones` with `name: "example.com"` first. Configuring
`zoneId` removes that hop entirely for a single-zone deployment.

`list_zones` is the one tool a configured `accountId` deliberately does *not*
reach. It is the discovery step, and a default that quietly filtered it would
be a restriction in all but name — one with no argument that escapes it, since
an empty `accountId` would fall back to the default again. A deployment that
wants zones from one account passes `accountId` explicitly, and the property
says so.

## Tools

The named surface covers workflows that benefit most from concise schemas and
projections:

| Area | Reads | Writes |
| --- | --- | --- |
| Zones | discovery, details, settings, rulesets | update a setting |
| DNS/cache | list and get records | create, update, delete, targeted/full purge |
| Workers | scripts, settings, deployments | delete a script |
| KV | namespaces, keys, bulk values | create/rename/delete namespace, bulk write/delete |
| R2 | buckets, object metadata, metrics, CORS | create/update/delete bucket, delete object, replace/delete CORS |
| Pages | projects, deployments, domains | retry/rollback/delete deployments, add/delete domains, purge build cache, delete project |

Every named tool carries a complete hand-written input schema: closed
(`additionalProperties: false`), with an accurate `required` list, an `enum` on
every constrained field, endpoint-specific pagination bounds, and a description
on every property. `test/cloudflare-provider.test.ts` walks the surface and
asserts those properties rather than leaving them as a claim.

### The whole-v4 escape hatch

Cloudflare adds products and endpoints faster than a curated connector should
grow tool names. Three provider-relative tools cover the rest without turning
method classification into user input:

- `cloudflare_api_get` accepts only GET and is explicitly read-only. JSON is the
  default; `responseType: "text" | "base64"` retrieves scripts, logs, R2
  objects, and media bodies without pretending they have a JSON envelope.
- `cloudflare_api_mutate` accepts JSON POST, PUT, PATCH, and DELETE. It is always
  destructive, even when a particular POST is merely additive.
- `cloudflare_api_upload` accepts POST or PUT plus exactly one of raw text,
  base64 bytes, or multipart fields/files. It is always destructive and reads
  no local files.

All three accept explicit endpoint-specific headers, which supports R2
jurisdictions, conditional requests, encryption controls, and object metadata.
Authentication, host selection, content type, content length, and transfer
framing remain connector-owned and cannot be overridden.

Paths are relative to `/client/v4`. Absolute URLs, protocol-relative paths,
`..` traversal, fragments, and embedded query strings are refused locally;
query parameters are explicit name/value pairs. These tools reuse the same
credential, admission budget, abort signal, envelope parsing, and typed failure
mapping as named tools. They do not widen the token's Cloudflare permissions.

This is intentionally not OpenAPI ingestion: it creates three stable tools,
not one tool per Cloudflare operation. For example, an agent can list Images at
`/accounts/{accountId}/images/v1`, manage Stream at
`/accounts/{accountId}/stream`, manage Email Routing at
`/zones/{zoneId}/email/routing/rules`, reach D1 at
`/accounts/{accountId}/d1/database`, and reach Queues at
`/accounts/{accountId}/queues`. The endpoint-specific query and body shape still
comes from Cloudflare's API reference.

### Where the `perPage` bounds come from

`strictValidation` is on, so an out-of-range `perPage` is refused locally
before it reaches Cloudflare. That is only a favor when the bound is really
Cloudflare's, so the schemas record which ones are and the descriptions say so
out loud:

| Tool | `perPage` | Default | Whose bound |
| --- | --- | --- | --- |
| `list_accounts`, `list_zones` | 5–50 | 20 | Cloudflare's, as documented |
| `list_kv_namespaces` | 1–1000 | 20 | Cloudflare's, as documented |
| `list_dns_records` | 1–1000 | 100 | Cloudflare's minimum; the ceiling is ours |
| `list_pages_projects` | 1–100 | — | Ours entirely |

Two need the note. Cloudflare's schema documents `per_page` on
`/zones/{id}/dns_records` as 1 to **5,000,000** — a nominal ceiling no listing
will honor — so this connection caps it at 1,000, the same conservative-reading
move as the [one-variant purge rule](#cache-purging): a local cap an agent is
told about beats a page size that fails somewhere inside Cloudflare. And
`/accounts/{id}/pages/projects` documents no bounds and no default at all, so
1 to 100 is a choice made here and labeled as one.

### DNS record types

Cloudflare accepts 21 record types, exported as `CLOUDFLARE_DNS_RECORD_TYPES`.
Eight of them take a single `content` string; the other thirteen (CAA, CERT,
DNSKEY, DS, HTTPS, LOC, NAPTR, SMIMEA, SRV, SSHFP, SVCB, TLSA, URI) take a
per-type structured `data` object with its own field set.

`list_dns_records` filters on all 21. `create_dns_record` and
`update_dns_record` accept only the eight content-based types, exported as
`CLOUDFLARE_CONTENT_DNS_RECORD_TYPES`. Supporting the rest would mean either a
free-form `data` passthrough — the untyped `{}` this connection exists to
avoid — or thirteen more hand-written schemas for record types that are rare in
day-to-day zone administration. Structured-data records stay fully readable.
The named create/update tools omit them and the enum says so rather than letting
the call reach Cloudflare and 400; an operator who needs one can use the
approval-gated raw mutation tool with Cloudflare's documented per-type `data`
body.

### Cache purging

`purge_cache` takes exactly one variant per call: `everything: true`, or one of
`files`, `tags`, `hosts`, or `prefixes`. Cloudflare caps a purge at 100
operations per request (500 files on Enterprise), and all four targeted methods
are available on every plan — tag, host, and prefix purging is no longer
Enterprise-only.

The one-variant rule is this connection's contract, not a documented API
restriction. Cloudflare's schema models the body as `anyOf`, which does not
forbid combining, and the only explicit exclusivity statement in its
documentation is about the Workers cache binding rather than the REST endpoint.
Refusing a combined call locally is the conservative reading: an agent gets a
clear `invalid_args` naming the conflict instead of a purge whose actual scope
is ambiguous. If a future deployment needs combined tag-and-prefix purging,
that is a deliberate change to make here, not something to discover in
production.

## Results

Reads return Cloudflare's `result` unwrapped and projected: identity and
description fields kept, plan/permission/meta noise dropped, `snake_case`
renamed to `camelCase`. A zone comes back as `id`, `name`, `status`, `paused`,
`type`, `accountId`, `accountName`, `plan`, `nameServers`, and timestamps —
not the forty-field object Cloudflare sends.

Paginated lists add a `page` object derived from `result_info`:
`{ page, perPage, count, totalCount, totalPages, hasMore }`. `hasMore` is the
field to branch on.

Some endpoints do not work that way, and the schemas say so rather than leaving
an agent to discover it. `list_r2_buckets`, `list_r2_objects`, and
`list_kv_keys` paginate by cursor and return `nextCursor` instead of `page`.
`list_worker_scripts` reports no counters at all and omits `page` entirely.

Projected resource reads expose `raw: true` where the provider's larger object
is commonly useful. `cloudflare_api_get` is the universal unprojected escape
hatch. Raw shapes can hit a deployment's result cap, so programs should still
filter and project before returning them.

## Typed failures

Cloudflare's error envelope carries an array of `{ code, message }` entries and
sometimes a nested `error_chain`; the connection flattens the whole chain into
the failure message so the provider's own code number survives to the agent.

| Cloudflare | Connecta failure | Agent behavior |
| --- | --- | --- |
| 429 | `rate_limited`, retryable | Waits `retryAfterMs` — the `retry-after` header when present, otherwise the full five-minute window |
| 401 or 403 | `auth_required`, not retryable | Stops and reports which permission is missing |
| 400 with a credential-shaped code (1001, 6003, 6111, 9103, 9106, 9107) | `auth_required`, not retryable | Stops; the header or key is malformed, not the arguments |
| 400, 409, 422 | `invalid_args`, not retryable | Repairs the arguments |
| 404 | `connector_call_failed`, not retryable | Re-runs discovery for the id |
| 5xx or a transport error | `unavailable`, retryable | Retries |

The six credential-shaped codes deserve a caveat: Cloudflare publishes no
official table mapping error codes to causes, so that set is assembled from
community reports and probing, not from documentation. The same goes for the
claim below that `10000` is overloaded — that is an observation about responses
seen in practice. Treat both as well-supported readings that Cloudflare could
invalidate without notice, and prefer `verify_api_token` over the code list
when a diagnosis actually matters.

Two ordering decisions are deliberate. The 429 branch is checked before the
authentication codes, because Cloudflare reuses the generic `10000` code on
throttled responses and reading a rate limit as an auth failure would tell an
agent to stop when it should wait. And `10000` is *not* itself treated as an
auth code: Cloudflare returns it for "Authentication error" but also for
ordinary validation failures like "Invalid pagination cursor" and
"domain_name is required", so routing on it would tell an agent its token was
broken when its arguments were. Genuine `10000` auth failures arrive with 401
or 403 and are caught by status.

Because the connection declares an operator-managed credential rather than an
OAuth flow, an `auth_required` failure resolves to the `operator_config`
recovery mode — the fix is a human updating the token, not an authorization
URL the agent can open. A missing token fails that way before any request is
made.

Some failures never reach Cloudflare at all. A blank scope id, a `purge_cache`
call with no variant or two, and an `update_dns_record` with nothing to change
are all refused locally as `invalid_args` with a validation issue attached,
because a round trip that can only 400 is a wasted call and a worse
explanation.

## Rate limits

Cloudflare documents a global limit of
[1,200 requests per five minutes per user](https://developers.cloudflare.com/fundamentals/api/reference/limits/),
counted cumulatively across the dashboard, API keys, and API tokens. The
connection declares a matching rolling-window admission budget plus a
`maxConcurrency` of 6, overridable with the `maxConcurrency` option.

The budget is a best-effort approximation of the per-user limit, not an
enforcement of it. Each runtime keeps its own counter, so N Worker isolates or
Node processes serving one deployment can each admit up to 1,200 — and the
dashboard traffic of a human sharing the account is counted by Cloudflare but
not by Connecta. `maxConcurrency` is the bound that actually protects a shared
token, because a single `execute_code` program can fan out far faster than the
window notices.
