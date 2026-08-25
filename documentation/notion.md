# Notion prebuilt connection

Import `notion()` independently from `@zackbart/connecta/providers/notion`. It
is a hand-written `api()` surface over Notion's public REST API — fifteen
deliberate tools, lean projections of Notion's famously bloated payloads, typed
failures, a rate budget matched to the documented limit, and a required usage
guide. It adds no provider dependency, imports no `node:` builtin, and is not
reachable from Connecta's root entry.

```ts
import { notion } from "@zackbart/connecta/providers/notion";

const wiki = notion("engineering_wiki", {
  title: "Engineering wiki",
  purpose: "Runbooks, specs, and on-call notes for the platform team",
  instructions: "Prefer the Runbooks database; specs live under Projects.",
});
```

The `id` owns the ordinary connector namespaces; use a different id for every
Notion workspace. `purpose` is required because an agent choosing between two
instances needs to know which workspace answers the question. Workspace
`instructions` are appended to the maintained guide and cannot change the
connector's safety classification.

## Why this one is `api()` and not `remoteMcp()`

Notion publishes an MCP server, but the interesting problem here is not
transport — it is shape. A single Notion page returns every property as a
discriminated wrapper object, every string as an array of rich-text runs each
carrying its own annotations block, and every user reference as a nested
object. A twenty-five row database query is tens of kilobytes of structure
around a few hundred bytes of meaning. Hand-writing the surface is what makes
the projections possible, and the projections are the point.

## Authentication

One operator-managed credential: an internal integration token from
[notion.so/profile/integrations](https://www.notion.so/profile/integrations).
The deployment needs `credentials.encryptionKey` configured, or the token
cannot be stored and every call fails `auth_required` at use.

Two Notion-specific facts decide whether a working token is enough:

- **Sharing is per object.** A token reaches only what has been explicitly
  shared with its integration. An unshared page returns 404, not 403.
- **Capabilities are per integration**, and the comment capabilities are off by
  default. `list_comments` and `add_comment` fail with 403 until an operator
  turns them on in Notion.

`/credentials` offers a Test action, which calls `GET /v1/users/me` — the
cheapest call that proves a token is live — and reports the workspace it
authenticated into.

## The pinned API version

The connection pins `Notion-Version: 2026-03-11` and offers no override. That
is deliberate rather than lazy. Notion's versions are date-named and old ones
keep working indefinitely, so an override would look harmless; it is not.
`2026-03-11` is the version in which databases split into data sources,
`archived` became `in_trash`, and block append took a `position` object instead
of an `after` string. Every projection and write body here assumes those
shapes, so a deployment that pinned an older version would get quietly wrong
results instead of a loud failure.

Notion also ships *additive* changes to every version simultaneously, which is
why the property and block projections fall back to unwrapping an unknown
type's payload rather than switching exhaustively. A property type that ships
after this release degrades to its raw value, and a block type that does keeps
its payload under `raw`; neither vanishes.

## Tools

Ten reads, all annotated `readOnlyHint: true`:

| Tool | What it is for |
| --- | --- |
| `search` | Find pages and data sources by **title**. Never searches content. |
| `get_page` | One page's metadata and flattened property values. |
| `get_page_content` | A page's body as flat blocks reduced to plain text. |
| `get_page_property` | One property in full, past the 25-entry truncation. |
| `get_database` | A database container and the data sources inside it. |
| `get_data_source_schema` | Property ids, types, and select/status options. |
| `query_data_source` | Filtered, sorted rows with properties already flattened. |
| `list_users` | Workspace users and bots with their ids. |
| `get_self` | Which integration and workspace this connector authenticates as. |
| `list_comments` | Unresolved comments as plain text with discussion ids. |

Five writes, none read-only, so all of them route through
`call_destructive_tool`:

| Tool | Classification |
| --- | --- |
| `create_page` | additive |
| `append_blocks` | additive |
| `add_comment` | additive |
| `update_page_properties` | `destructiveHint: true` — replaces existing values |
| `trash_page` | `destructiveHint: true` — removes a page from reads |

The additive three leave `destructiveHint` unset: `readOnlyHint: false` already
routes them through the approval path, and claiming a create destroys something
only inflates the copy a host shows a human. `update_page_properties`
deliberately has no `in_trash` argument, so an update can never trash a page by
accident; trashing is its own named, reversible tool.

## Lean projections, and the raw escape hatch

Every read projects. A page becomes ids, plain text, and flattened values:
`title` and `rich_text` collapse to strings, `select` and `status` to their
option name, `multi_select` to an array of names, `relation` to an array of
page ids, `people` to `{ id, name }`, `unique_id` to `"RL-12"`, and
`formula`/`rollup` to their computed value. No `plain_text` runs, no
`annotations` blocks, no property wrappers survive.

Two projections are opinionated enough to call out:

- **`search` returns identity fields only** — no properties at all. A
  twenty-five result search across a populated database would otherwise drag
  back several hundred flattened values for results the agent is about to
  discard. `get_page` fetches properties for the one that matched.
- **`get_page` reports what Notion hid.** Notion paginates four property types
  — `title`, `rich_text`, `relation`, and `people` — cutting each off at 25
  entries and signalling it only with a `has_more` flag on the property itself.
  The projection surfaces those in `truncated_properties` as `{ name, id }`,
  which is what stops an agent from confidently reasoning about 25 of 300
  relations. The `id` is there because the handoff needs it: `get_page_property`
  addresses a property by id, not by name.

Where the dropped detail can matter — `search`, `get_page`, `get_page_content`,
`get_page_property`, `get_data_source_schema`, `query_data_source`,
`list_comments` — `raw: true` returns Notion's untouched response instead. It is
much larger; it exists so a missing field is never a dead end. When the goal is
*fewer* fields rather than more, `get_page` and `query_data_source` also take a
`properties` array to project only the named ones.

One caveat with `get_page_content`: `raw: true` returns the requested level
exactly as Notion sent it and does not walk nested children, so `depth` is
ignored alongside it. A raw read of a deep page yields one level, not three.
Unmodelled *block* types are covered without it — a block whose type this
projection does not know, and whose payload is not plain rich text, keeps that
payload verbatim under `raw` on the block, so nothing collapses to an empty
string.

## Databases contain data sources

This is the trap the guide is marked `required` for. A Notion database is a
container; the rows and the schema live in a *data source* inside it, and the
two ids are not interchangeable. The id in a database's URL is a **database
id**, and passing it to `query_data_source` fails. The sequence is
`get_database` → `get_data_source_schema` → `query_data_source`; `search`
returns data sources directly and skips the first step.

`create_page` needs the same distinction: a row is created under
`parent_data_source_id`, never a database id. Its title also needs
`title_property` from the schema, because a database's title column is rarely
called "title".

## Typed failures

The mapping is deliberately not one-to-one with Notion's error codes. Notion's
`code` says what its API thinks happened; Connecta's says what the caller
should do next, and two of Notion's are easy to mistranslate.

| Notion | Connecta | Why |
| --- | --- | --- |
| 400 (`validation_error`, `invalid_json`, `invalid_request`, `missing_version`, …) | `invalid_args` | every documented 400 is a malformed request |
| 401 `unauthorized` | `auth_required` | the token is missing or invalid |
| 403 `restricted_resource` | `connector_call_failed`, non-retryable | **not** `auth_required` |
| 404 `object_not_found` | `connector_call_failed`, non-retryable | overloaded — deliberately **not** `not_found`; see below |
| 409 `conflict_error` | `unavailable`, retryable | Notion says to retry |
| 429 `rate_limited` | `rate_limited` + `retryAfterMs` | `Retry-After` seconds → ms |
| 529 `service_overload` | `unavailable` + `retryAfterMs` | back off like a 429 |
| 5xx | `unavailable`, retryable | upstream failure |

The two that matter:

**403 is not an authentication failure.** The token is fine; the integration
lacks a capability or was never shared the object. Routing it to
`auth_required` would send an agent to `authorize_connector`, which cannot
grant a Notion capability or share a page. It is a non-retryable call failure
whose message says an operator must change it in Notion.

**404 does not prove absence.** Notion returns `object_not_found` both for an
object that does not exist and for one that exists but has not been shared with
the integration, and it will not say which. The message says both, because
treating it as deletion is exactly how an agent concludes a page is gone when
it was simply never shared. This is why the row above does not use `not_found`,
which exists precisely to say "it is not there": the qualifier on that code
([H11](./provider-conventions.md#h11--errors-are-mapped-to-what-the-caller-does-next))
is that the provider must tell absence apart from a permission gap, and Notion
does not. A program that skipped this id as missing would be right about half
the time, which is the half that matters.

## Rate limiting

Notion documents "an average of three requests per second, with some bursts
beyond the average allowed" per connection, plus a separate per-workspace limit
scaled to the plan. The connection declares a rolling budget of 180 calls per
minute — the same average expressed over a window short bursts pass and a
sustained loop does not — **paired with `maxConcurrency: 3`**.

The concurrency cap is the load-bearing half. A budget alone is an average, and
an averaged budget cannot stop a program from firing forty calls in the same
tick; the cap keeps a burst shaped roughly like the one Notion documents.
Neither half is a guarantee, because admission meters *tool calls* rather than
requests — a single admitted `get_page_content` can spend twenty fetches, so
180 calls per minute is a floor on the real request rate, not a ceiling.
Declaring the cap is also what makes the queue settings legal — the admission
controller refuses queue settings without a queue at construction.

Like every connector budget this is per-runtime: N Worker isolates or Node
processes serving one deployment each keep their own counter. It approximates
the provider's limit; it does not enforce it.

One tool can turn a single agent call into several downstream requests:
`get_page_content` with `depth > 0` walks nested blocks, and call admission
meters tool calls, not the fetches inside them. That walk stops at an internal
ceiling of twenty requests and reports `truncated: true` rather than spending
the whole budget invisibly.

## Pagination

List-shaped tools take `page_size` (1–100) and `start_cursor`, and return
`has_more` with `next_cursor`. The default page size is 25 rather than Notion's
100, because a first read should be cheap; `defaultPageSize` raises it for a
deployment that pages a lot.

Cursors are opaque. Notion's own versioning page is explicit that they may
change in length, format, and structure at any time and must be passed back
verbatim — never parsed, validated, or constructed.

## What this connection does not do

No file uploads, no database or data-source creation, no schema editing, no
block updates or deletes, no page moves. Those are all real Notion endpoints
and all deliberately absent: this is a deliberate tool surface, not a mirror of
the API. Anything missing is reachable through a custom `api()` connector
beside this one, which remains a first-class path.

The 2026-03-11 contract also offers more fields on create and update. They were
reviewed after the 0.17.0 drift check and remain deliberately absent:

- `create_page` does not create workspace-private pages, apply templates,
  choose page placement, or accept expanded icon and cover forms. Those change
  ownership, start asynchronous content work, control ordering, or depend on
  file surfaces. They are not extensions of the maintained page/row authoring
  contract (#408).
- `update_page_properties` does not lock pages, apply templates, or erase page
  content. Locking is coordination state, templates finish asynchronously, and
  `erase_content` permanently deletes every child block through the API. None
  belongs under an approval named for property replacement (#409).

`trash_page` stays separate and reversible. The current `create_page`,
`update_page_properties`, and `trash_page` request subsets remain valid against
the expanded published contract.

There is also **no guarded raw-REST escape hatch** — no `notion_api_get`, no
`notion_api_mutate`. The convention that permits one
([H14](./provider-conventions.md#h14--a-named-tool-must-beat-the-escape-hatch-and-the-escape-hatch-splits-by-safety))
also permits a small provider to have none, provided it says so, and Notion's
public API is finite and slow-moving enough that a named surface can cover it.
The usage guide says it too, because an agent that assumes a hatch exists
spends a search proving it does not: absent from the tool list means absent
from this connection, not hidden behind a generic call.

## Conventions

This connection is audited against
[the provider conventions](./provider-conventions.md). Its verdict per
convention, including every recorded exception, is the Notion section of
[the provider audit](https://github.com/zackbart/connecta/blob/main/records/provider-audit.md).
