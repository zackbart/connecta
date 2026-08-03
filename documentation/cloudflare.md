# Cloudflare prebuilt connection

Import `cloudflare()` independently from
`@zackbart/connecta/providers/cloudflare`. It is a deliberate, hand-written
surface over Cloudflare's v4 REST API — fourteen tools with complete schemas,
lean projections, typed failures, and a rate-limit budget matching the
documented one. It adds no provider dependency, imports nothing outside
Connecta, and is not reachable from Connecta's root entry.

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

The API itself does not need one. It is Bearer-token JSON over `fetch` with a
uniform `{ success, errors, messages, result, result_info }` envelope. Writing
that by hand is about two hundred lines, keeps the provider Workers-clean, and
means `@zackbart/connecta/providers/cloudflare` installs and runs with nothing
extra. `test/package-surface.test.ts` pins the claim: the `cloudflare` package
must not appear in `dependencies`, `peerDependencies`, or `devDependencies`,
and every import in the provider must be relative.

## Credentials

The connection declares one operator-managed credential: a scoped Cloudflare
API token, sent as `Authorization: Bearer <token>`. Create it under My Profile →
API Tokens → Create Token. Do not use a Global API Key — it carries every
permission on the account and cannot be scoped.

Grant only what the deployment needs:

| Tools | Token permission | Scope |
| --- | --- | --- |
| `list_zones`, `get_zone` | Zone Read | Zone |
| `list_dns_records`, `get_dns_record` | DNS Read | Zone |
| `create_dns_record`, `update_dns_record`, `delete_dns_record` | DNS Write | Zone |
| `purge_cache` | Cache Purge | Zone |
| `list_worker_scripts` | Workers Scripts Read | Account |
| `list_kv_namespaces` | Workers KV Storage Read | Account |
| `list_r2_buckets` | Workers R2 Storage Read | Account |
| `list_pages_projects` | Cloudflare Pages Read | Account |

Those are the names as they appear in the token editor. "Cache Purge" is a
single permission with no Read/Write split, and Cloudflare's own reference
renders a few labels differently between its Dashboard and API tabs — if a name
above does not match what you see, look for the same noun with the other verb.

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

## Tools

Ten reads, all annotated `readOnlyHint: true` and therefore admissible from
`call_tool` and `execute_code`:

`verify_api_token`, `list_accounts`, `list_zones`, `get_zone`,
`list_dns_records`, `get_dns_record`, `list_worker_scripts`,
`list_kv_namespaces`, `list_r2_buckets`, `list_pages_projects`.

Four writes, all routed through `call_destructive_tool`:

- `create_dns_record` is additive and leaves `destructiveHint` unset —
  `readOnlyHint: false` already routes it for approval, and asserting
  destruction only inflates the copy a human sees.
- `update_dns_record`, `delete_dns_record`, and `purge_cache` change or discard
  live state and are annotated `destructiveHint: true`.

Every tool carries a complete hand-written input schema: closed
(`additionalProperties: false`), with an accurate `required` list, an `enum` on
every constrained field, per-endpoint `perPage` bounds, and a description on
every property. This is the point of the connection. A generated wrapper around
the same API exposed `arguments?: {}[]` in its compact schema and pushed the
real parameter list into operation documentation, so an agent had to read a doc
page before it could make a call. Here the compact schema is enough.

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
day-to-day zone administration. Structured-data records stay fully readable;
only creating and updating them is out of scope, and the enum says so rather
than letting the call reach Cloudflare and 400.

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

Two endpoints do not work that way, and the schemas say so rather than leaving
an agent to discover it. `list_r2_buckets` paginates by cursor: its
`result_info` carries only a cursor, so it returns `nextCursor` instead of
`page`, and the next call passes it back as `cursor`. `list_worker_scripts`
reports no counters at all and omits `page` entirely.

Every read accepts `raw: true`, which returns the unprojected result for the
case where a dropped field genuinely matters. It is an escape hatch, not a
default: the raw shapes are large enough to hit a deployment's result cap.

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
