# Meta-tools

Connecta keeps one small tool surface in model context and resolves downstream
tools behind it. `search_tools` finds addresses, the call tools enforce the
stored classification, `execute_code` runs programs on a writable or read-only endpoint, and `connecta.result` inside programs
pages bounded results.

A pool may instead list each downstream tool directly, for clients that run
their own tool search; see [native tool surface](#native-tool-surface).

This guide is the contract an MCP client sees. The in-program `connecta.*` API
those tools imply belongs to [code mode](./code-mode.md); inbound identity and
credential administration belong to [auth](./auth.md).

## Task routes

Start with [Operating an endpoint](./operating.md) for a workflow, or
[the agent index](./README.md) for setup and repository tasks. This reference
owns the top-level MCP contract; it does not require reading the core internals.

| Task                                               | Sections                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose a tool or construct its arguments           | [Meta-tool table](#the-meta-tools), [call routing](#routing-between-the-call-surfaces), [downstream input](#downstream-input-on-direct-calls) |
| Find an operation and its schema                   | [Discovery context](#discovery-context), [TypeScript signatures](#typescript-signatures), [lexical discovery](#lexical-discovery)             |
| Load provider instructions or native skills        | [Connector guides](#connector-guides-and-skills), [native extension](#native-skills-extension)                                                |
| Interpret a direct response or page a large result | [Representation](#result-representation), [truncation](#truncated-direct-call-results), [paging](#paging-with-connectaresult)                 |
| Recover a refused or invalid call                  | [Authorization](#authorization-recovery), [routing](#routing-recovery), [arguments](#argument-recovery), [echo budgets](#echo-budgets)        |
| List downstream tools directly, or connect Eve     | [Native tool surface](#native-tool-surface), [Eve agents](#eve-agents)                                                                        |
| Read an endpoint's surface and connector roster    | [Endpoint facts](#endpoint-facts)                                                                                                             |
| Change the contract                                | [Source and tests](#source-and-tests), [guest API](./code-mode.md#verification)                                                               |

## Tool presentation

The default surface is the meta-tools below. From 0.35.0, pools can use
[native tool presentation](#native-tool-surface) for clients with their own
tool search. Both presentations use the same invocation enforcement; native
pools keep code available by default.

## The meta-tools

Every deployment requires an executor. A meta endpoint's `tools/list` is exactly
these six, plus `execute_read_code` on a writable `/mcp`, `/mcp/<pool>` or
`/agent/<pool>` unless `execute.readRoute` is `false` ([read programs](#read-programs)).
A read-only endpoint lists six. This is the default; a pool may instead use the
[native tool surface](#native-tool-surface). No other configuration changes the
list, so a client's cached meta-tool list never depends on
the storage behind the deployment. `execute_code`
is annotated `readOnlyHint: true, destructiveHint: false` on a read-only
endpoint, and `readOnlyHint: false, destructiveHint: true` on a writable one.
Approval belongs to the client. A read-only endpoint keeps all six tools, omits
write tools from `search_tools` results and describe, and refuses every write
call. Connector `readOnly` applies the same restriction on every endpoint; effective read-only is endpoint OR connector. Neither setting changes connector visibility or read grants. Guides
(`queryAnalysis.guideSummary`, `skills`, `connecta.skill`, skill
`resources/read`) are documentation and may name tools the endpoint refuses. The three tools with structured-only success results
(`execute_code`, `search_tools`, `authorize_connector`) advertise an open
`outputSchema`: required keys and top-level types, with every other field open.
The schemas declare no `$schema`, and validators for drafts 4, 7, 2019-09 and
2020-12 accept the same results. The server checks each successful result against
its full contract before sending it, so the shapes this guide states hold though
`tools/list` omits them. Both SDK edges exempt `isError: true` responses from
output-schema validation. Failures on a `search_tools` page are one such shape: each
`catalogErrors[]` entry and `queryAnalysis.catalogError` requires `code`, `message`
and `retryable`, may carry `retryAfterMs`, `retry`, `nextAction`, `stale`, `ageMs`
and the authorization-handoff fields (`recovery`, `status`, `authorizationUrl`,
`operatorUrl`, `instructions`, `credential`), and has no others; a `catalogErrors[]`
entry also requires `connector`, which `queryAnalysis.catalogError` may carry.
The two direct-call tools omit `outputSchema` because their default
mode returns native `content`. Default-mode successes declare
`_meta["dev.connecta/format"]: "json" | "text"`; value mode places the value in
`data` and declares `format` in its complete result envelope.

| Tool                    | Arguments                                                                                                                           | Returns                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute_code`          | `code`, `diagnostics?`                                                                                                              | `{ result?, error?, hostCalls }`, plus `logs`, `emitted`, and `emittedDiscarded` when present and diagnostics when asked                                                                                                                               |
| `execute_read_code`     | the same                                                                                                                            | the same; [read programs](#read-programs) lists where it appears and what it refuses                                                                                                                                                                   |
| `search_tools`          | `query?`, `connector?`, `safety?`, `limit?`, `offset?`, `fullDescriptions?`, `includeSchemas?: "compact" \| "json" \| "typescript"` | `{ catalogErrors, tools, total, offset, limit, hasMore }`, plus `nextOffset` when more remain, `absence` when the query names a service with no configured connector, and `queryAnalysis` on a partial, failed, unsearchable, or absent-service search |
| `call_tool`             | `address`, `args?`, `resultMode?: "mcp" \| "value"`, `timeoutMs?`, `diagnostics?`                                                   | the downstream result, bounded as [result representation](#result-representation) describes                                                                                                                                                            |
| `call_destructive_tool` | the same, plus `reason?`                                                                                                            | the same                                                                                                                                                                                                                                               |
| `authorize_connector`   | `connector`, `force?`                                                                                                               | the class-specific handoff in [authorization recovery](#authorization-recovery)                                                                                                                                                                        |
| `skills`                | `name?`                                                                                                                             | the listing when `name` is absent, that skill's markdown when it is present                                                                                                                                                                            |

`limit` defaults to 8 and is capped at 100, as is one `connecta.describe` batch.
`connecta.result`'s `offset` is a whole number of bytes ≥ 0 defaulting to 0 and
`maxBytes` a whole number ≥ 1 that defaults to, and is clamped to, the inline
cap of the call that stashed the result — 24,000 bytes unless
`calls.maxResultBytes` or a per-connector override says otherwise
([why 24,000](#truncated-direct-call-results)). A value outside those domains is
an input error; a valid `maxBytes` above the cap is an upper bound, not an
error ([why](#paging-with-connectaresult)). `reason` is at most 500 characters of context for the host's human
approval view; Connecta neither treats it as authority nor sends it downstream,
and an empty or whitespace-only one reads as no reason rather than as grounds to
refuse a consequential call.

`diagnostics: true` adds compact request-local timing and serialized-size
aggregates for a caller measuring a workflow: a `diagnostics` block from
`execute_code`, a `timing` block on every structured call response: value-mode successes
and every `{ ok: false }` failure. Normal calls pay nothing for it,
and the measurements never contain program source, arguments, values, addresses,
credentials, logs, or raw error text.

Connecta's discovery tools carry read-only hints. `authorize_connector`
requests interactive authentication changes; `call_destructive_tool` sends
writes and is annotated destructive. `execute_code` states whether the endpoint
is read-only or writable in its description and annotations. On a writable
endpoint the client may approve the whole program as a write. On a read-only
endpoint, the `call_tool`, `call_destructive_tool`, and `search_tools`
descriptions say so too; `call_destructive_tool` still runs reads there. `call_destructive_tool.reason` is dropped before
anything runs.

## Read programs

`execute_read_code` runs a program with the same guest API, sandbox and budgets as
`execute_code`, annotated `readOnlyHint: true, destructiveHint: false`, so a host
that gates on annotations does not prompt for a read-only program. On a writable
endpoint `execute_code` stays annotated as a write.

| Endpoint                                        | Lists `execute_read_code`                     |
| ----------------------------------------------- | --------------------------------------------- |
| Writable `/mcp`, `/mcp/<pool>`, `/agent/<pool>` | Yes, unless `execute.readRoute: false`        |
| Read-only pool with a `writes` grant            | Yes, unless `execute.readRoute: false`        |
| Read-only endpoint, read-only agent pool        | No: `execute_code` is already read-only there |
| Native pool                                     | No                                            |

On a writable `/agent/<pool>`, an agent host that reviews writes can let `call_tool`
and `execute_read_code` run and review only `execute_code` and `call_destructive_tool`.
Connecta enforces that split below the sandbox, so a program that builds an address at
runtime meets the same refusal. [Endpoint facts](#endpoint-facts) carry
`executeReadCode`, so a helper can send lookups to this route.

**Refusal.** Every call whose effective or source class is write is refused below
the sandbox, before validation and dispatch, with `retryable: false` and a message
naming `call_destructive_tool` and `execute_code`. Its code is
`destructive_tool_requires_approval`, including a write a read-only pool's `writes`
grants, or `read_only_endpoint` for a write with no write route: one on a read-only
connector, or one a read-only pool's `writes` does not grant. A program can read and then attempt a write; it
gets that refusal with zero writes sent, and catching it or using
`Promise.allSettled` changes nothing. A plain `"read"` override does not bring a source
write here: a tool it serves as a read over a silent source is refused, though `call_tool`
runs it. `"read-repeatable"` is the exception, because the deployment accepted that a host
may repeat the call, and a host can resend a whole read program: such a tool runs here
unmarked, and a resent program can reach the vendor twice.

**Freshness bound.** A program admits each call against the catalog its request
retained, so calls made within a catalog's TTL see one consistent catalog and
list nothing again. In a read program, and in `execute_code` on a read-only
endpoint, a call to a connector whose retained catalog has passed its TTL first
lists that connector again and admits against the new listing: a tool the
downstream has since reclassified as a write is refused as above, with nothing
sent, whether or not the downstream sent `notifications/tools/list_changed`.
Concurrent calls share one relisting. A downstream's reclassification therefore
reaches such a program no later than its catalog TTL (`ttlMs`, or
`discovery.catalogTtlSeconds` for a listing without one).

Two costs follow. A catalog with a zero TTL, which is the MCP SDK server's
default, is listed again before every call after the program's first to that
connector, one `tools/list` round trip each. A relisting that fails transiently
resolves the call through the bounded stale fallback in
[architecture](./architecture.md#storage-credentials-and-connectors), so while a
downstream cannot list, the bound extends by at most five minutes.

Writable `execute_code`, `call_destructive_tool` and `call_tool` never relist
within a request. A writable program is approved as a write program as a whole,
so its calls keep the catalog its request retained for the whole run. `call_tool`
and `call_destructive_tool` make one call per request against a catalog that the
call itself read.

**Discovery lists writes, marked.** `connecta.search` and `connecta.describe` return
them with `callable: false`, and no other entry carries the field. Writes are not
omitted because omission reads as absence, and a program that reduces a page keeps
the marker on the entry it selects where it would drop a page-level note.
`search_tools` remains the unprompted way to find a write's address outside a program.

**Handles.** `connecta.result` works with the existing stash bindings: a `resultId`
from a direct read or a read program pages, or reads whole with `{ all: true }`, from a
read program on the same endpoint.
Follow-up text from `call_tool`, `search_tools` and both program routes names this route
on endpoints that list it, including paging a writing program's oversized return, so
paging costs no write approval and cannot resend the write.

**Off switch.** `execute: { readRoute: false }` in deployment code stops listing it
on every writable endpoint. It is the deployment's choice alone, and suits a deployment
that wants a person to see every program, given the limit below.

**Known limit: a read program can still send data out through a read.** A read program runs
without a prompt on hosts that auto-approve reads. Sandboxes deny egress, but a read
tool that takes a URL or a query can carry data out in its arguments, so data a program
reads can instruct an agent to do that. Connecta enforces by classification and cannot
see intent. `call_tool` has the same exposure one call at a time; a program adds
loops and joins. Keep such tools out of the pool, or set them to `"write"` or `"hidden"`
in `classification`, or turn this route off. The `read-route-injection` eval task
measures whether agents follow such an instruction.

Activity records calls and programs on this route with source `execute_read_code`.

## Routing between the call surfaces

The route is chosen before discovery, and read-only work has exactly two:
`call_tool` for one known address, a program for everything wider —
`execute_read_code` where it is listed, otherwise `execute_code` — an
unknown address, a result that will be reduced, a call whose arguments depend on
an earlier result, or several operations. A program keeps discovery, calls, and
reduction together when the schemas and result shapes suffice, and gives each
distinct operation its own short `connecta.search` query. That is cheaper than it
looks: discovery inside the program returns no candidate schema to the model and
costs no round trip. One exception — an unfamiliar read result may come back as
a small sample for inspection before continuing in another call, which avoids
repeated guesses at text formats and collection roots without restoring a
mandatory discovery-only round trip. A one-time write can return the only copy
of its result. Inspect and reduce the full value before a program returns, or
page the completed direct-call result or oversized program return with
`connecta.result` after the write runs once. Sampling or slicing a write's output
inside the program can still discard the answer.

On a writable endpoint the same program discovers and dispatches writes, capped
by `execute.maxWrites`, and `call_destructive_tool` sends one known write. On a
read-only endpoint nothing writes: `search_tools`, `connecta.search`, and
`connecta.describe` omit write tools as if the connector lacked them, and
every write call through `call_tool`, `call_destructive_tool`, or a program is
refused before validation or dispatch with `read_only_endpoint`,
`retryable: false`, and an explicit statement that no write route exists here.
Bootstrap instructions state the serving endpoint’s actual write policy. Connector
guides preserve their authored Markdown and prepend the effective read-only
endpoint or connection restriction: steps that change data will be refused.
The agent reports the limitation and can ask the operator for a writable connection. Connecta
never pauses, replays, or approves a program.

Both search routes return the flat page specified under
[lexical discovery](#lexical-discovery), which the server validates against one
catalog page contract.
Describe returns an ordered tool list without pagination. Optional row metadata
is omitted in this example:

```js
// connecta.describe defaults to JSON
{ tools: [{ name: "get_run", address: "ci.get_run", schemaFormat: "json", inputSchema: { type: "object" } }] }
```

Live connector probing is not a fourth: the operator pages and `/health` own it.

## Discovery context

The deployment-derived `execute_code` and `execute_read_code` descriptions carry
one connector inventory before any catalog search — registry order and each canonical id,
with no second name minted for programs. An entry adds the configured title
only when it says more than the id: a title whose words the id already spells,
such as `Google Calendar` for `google_calendar`, is dropped. It then adds the
connector's configured description as a one-line purpose, unless that too only
respells the id and title. Titles and purposes normalize whitespace; titles cap
at 48 UTF-8 bytes and purposes at 60, clipping on a whole token; text with no token
that fits is omitted. A connector whose guide is required
carries a `*`, and one legend follows when an entry shown has the mark. Optional
guides are not named here; search and describe name them. For example:
`Connectors: crm* (Customer CRM; Current accounts and contracts), tickets. *Read connecta.skill("connector:<id>") before its first call.`

Write each description so its first 60 bytes tell the connector apart from its
neighbours. Purposes stay in this inventory, never in the instructions, which
some hosts repeat on every tool.

The complete line, legend included, caps at 1,024 UTF-8 bytes, which names every
connector of a typical deployment. Past the cap, detail degrades before names do:
purposes are dropped first, from the end of registry order, then titles. Only
when bare ids still exceed it do whole entries give way, in registry order, to an
exact `+N more` count. The inventory reads only the configured registry: no
catalog load, no credential probe, no live status, no capability, and no
replacement for canonical discovery or addressing. Search pages carry the same
bounded title once per connector in `connectors[<id>].title`, so choosing an
account or environment costs no provider read.

Read-only lookup belongs in `connecta.search` inside the program; top-level
`search_tools` stays for explicit catalog inspection and approval-required
discovery. Both take the same arguments.

| Argument           | What it does                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`            | two to four action/object terms; empty or whitespace-only browses                                                                                                                                                                                                                                   |
| `connector`        | scopes to one id, loading that catalog alone instead of fanning out across every configured connector. Set it when the integration is obvious, omit it when the right one is genuinely ambiguous                                                                                                    |
| `safety`           | `"readOnly"` selects stored `read` verdicts; `"approvalRequired"` selects stored `write` verdicts; omitted or `"all"` selects both. Each row carries `classification: "read" \| "write"`. These legacy filter names do not describe client approval policy; a read-only endpoint has no write rows. |
| `limit` / `offset` | page the ranked results; omit `limit` initially so the default eight-result page stays small                                                                                                                                                                                                        |
| `includeSchemas`   | `"compact"` for the rendered routing view, `"json"` for the exact schema, `"typescript"` for a function signature ([below](#typescript-signatures))                                                                                                                                                 |
| `fullDescriptions` | unabridged tool purposes instead of the one-sentence summary, at the obvious cost                                                                                                                                                                                                                   |

Neither `connector` nor `safety` grants authority or changes invocation
admission; they select what discovery shows and nothing else.

Main search also consults a standard hatch's construction-authored operation
vocabulary (path, operation id, vendor summary and tag), without calling a tool
or reading account data. A match returns the owning `_api_search` tool; call it
with the original query to retrieve operations. Exact tool/address and complete
authored-tool matches retain precedence, and a vocabulary match never suppresses
lexical partial matches: both stay on the page, the hatch above partial tools.
A vocabulary match requires every term in one operation, and the operation's
hatch route must be visible and match the read/write filter. On `approvalRequired` searches the returned discovery tool
is still a read. Hidden tools, missing grants and read-only restrictions remain
in force. Browsing does not consult operation vocabulary.

When a matched operation's call is fully determined, the first page also
carries it in `readyCalls`, so a program can call it without operation search or
details:

```json
{
  "readyCalls": [
    {
      "address": "notes.notes_api_read",
      "args": { "path": "/v1/notes" },
      "classification": "read",
      "summary": "List notes"
    }
  ]
}
```

Pass `args` unchanged to `connecta.call(address, args)` or `call_tool`. An
operation is fully determined only when it is a reviewed read served by the
hatch's `_api_read` tool itself (no named tool), uses GET, the read tool's
default method, and declares no path template, required parameter or required
body. Anything needing an id, a method choice or an argument the agent must
fill in stays behind `_api_search` and `_api_details`. Ready calls pass the same
endpoint, connector read-only, safety, hidden-tool and grant checks as the
vocabulary match, through a visible read tool in the caller's view. They are
computed offline from the construction-time index, read no account data, and
start no authorization.

A ready call must also be what the query names. Each path segment, and the
operationId without its action and version words, is one whole resource name:
`event_destinations` is the name "event destination", never "event". Every
query word other than an action (`list`, `get`, `count`, `show`, `create`,
`update`, `delete` and their vocabulary aliases) must belong to a resource name
whose words the query states in order, with singular/plural normalization and
the provider's declared synonyms. Version segments such as `v1` never count, and
a summary may supply only actions. A query with no object word gets no ready
call. Ready calls are omitted entirely when the top result is an exact tool name
or address, or a complete match on an authored tool, not the hatch's own search
or read tool, whose name adds nothing to the query: each of its name words is an
action or a query word, up to plural/singular and declared synonyms. For
example, `list teams` returns `list_teams` and no ready call, even when other
operations mention teams in their summaries, while `list projects` still offers
`/v10/projects` beside `list_project_env_vars`, whose name adds `env` and `vars`.
Each hatch offers only its top-ranked operation: a last path segment naming the
resource first, then the fewest resource words the query did not ask for, then
the shortest path. A connector offers at most one ready call and a page at most
three, in connector order. Later pages carry none. A ready
call keeps its read tool's `guideRequired` and `guideRequiredReasons`, and its
connector appears in `connectors`.

Vocabulary is bounded: queries at most 200 characters and eight terms; each
hatch caches at most 8,192 rows and 2,097,152 characters, with at most 1,024
characters per row and 128 query intersections. Longer queries and vocabulary
outside these bounds remain available through the hatch's own search. These
bounds never claim an exhaustive operation search.

When a non-empty query matches no catalog tool or bounded operation vocabulary,
visible standard API hatches may still cover it. `queryAnalysis.guidance` names up to three qualified API
search tools in connector order and reports the omitted count; full indexes have
not been searched. For example, call `crm.crm_api_search` with the original
query before concluding that the operation is unavailable. Browse with an
empty query and follow every page, or search for `_api_search`, to list all API
search tools. If the query names a configured connector, its identity and
scoped-browse guidance comes first, followed by the API-search pointer.
The pointer respects endpoint and tool visibility; a read search tool can
discover indexed writes when the catalog query selected
`safety: "approvalRequired"`, provided the endpoint and connector allow writes.
That filter suppresses pointers on read-only endpoints and for read-only
connectors. Required connector guides and catalog failures still apply.
Catalog search itself performs no API index lookup.

`includeSchemas: "compact"` adds each match's input and any provider-declared
output shape, plus `inputKeys`, `requiredInputKeys`, and `outputKeys` for
bounded plain objects. Where the provider declared no output shape but an
earlier successful call learned one, the same field carries that open observed
schema beside `outputSchemaSource: "observed"`. The marker is load-bearing:
observed names and broad types are routing evidence, never a provider contract,
and a provider declaration always wins. Observation originates no provider
traffic and cannot fail a call; the mechanism and its bounds are
[code mode](./code-mode.md#connectasearch)'s `S9`, and this surface only labels
what it returns.

Lexical rank is one signal among several: pick a candidate whose required inputs
are available, whose schema is complete enough for the call, and whose safety
and outputs fit the work. When that shape suffices, call the returned address
directly; reserve `connecta.describe` for a search without schemas, an ambiguous
compact shape, or exact constraints that need `format: "json"`.

Compact search is a routing view, not a second copy of connector documentation,
so it spends bytes on shape and little on prose: a tool's purpose is its summary
([below](#lexical-discovery)), connector descriptions and property prose are
dropped, and required input fields render before optional ones. Both surfaces share one renderer, so
its byte and work budgets, its truncation renderings, and its handling of enums,
tuples, and conditional keywords are documented once under
[`connecta.search`](./code-mode.md#connectasearch) and
[`connecta.describe`](./code-mode.md#connectadescribe). The part a client must
act on is the flag: any cap sets `inputSchemaTruncated` or
`outputSchemaTruncated`, and that means repeat with `includeSchemas: "json"`, or
describe, when the exact constraints matter.

Repeated searches in one request reuse a private lexical index for the same
visible catalog and safety filter. Returned schemas and annotations are independent
copies: changing a result cannot change later discovery or tool classification.
In-process registry invalidation (including refresh and OAuth connect/disconnect/restart)
or built-in vault set/clear replaces the retained catalog and its index before the
next discovery read in that request, without storage reads on unchanged repeats.
Changes from another process/isolate or direct storage writes need not be observed
until the next request. Custom vault mutations must also invalidate the registry.
The index never crosses request or caller/pool boundaries.

### TypeScript signatures

`includeSchemas: "typescript"` replaces both schema fields with one
`signature`: the downstream function whose result is `(await connecta.call(address, args)).data`, written
as a TypeScript type because agents write code against types more reliably
than against JSON Schema ([executor](https://github.com/UsefulSoftwareCo/executor)'s
discovery made the same bet).

```ts
(args: { team: string; limit?: number /* <= 250 */ }) => Promise<unknown>
(args?: {}) => Promise<{ accounts: { stripe_context: string; livemode: boolean; name?: string }[] }>
(args: { team: string }) => Promise</* observed, not declared */ { cursor?: string; issues?: { id?: string }[] }>
```

It is something to read, not something that runs: programs stay JavaScript,
and `execute_code` accepts no erasable TypeScript. The output half is the provider's declared
schema, else an `S9` observation that opens with the
`/* observed, not declared */` marker and keeps the `outputSchemaSource`
field, else `unknown` — runtime evidence never reads as a contract, even when
the signature is lifted out of its entry. A tool without parameters takes
`args?: {}`.

The walk, byte budgets, and truncation flags are compact's, each half
separately, and search, describe, and every discovery route share them, so the
same tool renders the same signature from `search_tools` and `connecta.search`.
What changes is the dialect: `number` for `integer`, `;` between members,
quoted non-identifier keys, `| null` for OpenAPI `nullable` and type lists,
index signatures for schema-valued `additionalProperties`,
`Record<string, unknown>` for an open object with no declared properties, and
JSDoc for property prose where describe keeps it. Both dialects parenthesize a
union or intersection before an array suffix, `(A | B)[]`.
Where compact would print a bare definition name or raw JSON, the signature
prints `unknown` with a marker and sets the flag: `/* recursive */` for a
`$ref` cycle, `/* unresolved */` for a missing target, `/* truncated */` past
depth four or an exhausted budget. `inputKeys` and friends come from the
declared schema exactly as they do for compact.

## Connector guides and skills

A connector may attach a deployment-owned guide as markdown, keeping the
original `usageGuide: string` configuration, or as
`{ content, summary?, required? }` — which registers no connector and creates no
shared runtime template. The skills catalog prepends Agent Skills frontmatter to
`content` for native `skills/get` and `resources/read`, and preserves the guide
body, including its whitespace. The `skills` tool and `connecta.skill` return that
body without the frontmatter; a downstream skill's file keeps its exact bytes on
every reader. One read-only notice leads a guide: the endpoint's on a read-only
endpoint, otherwise the connection's on a read-only connector.
`summary` is normalized and refuses construction over 120 characters; absent,
Connecta derives the same bounded fallback the skills listing uses from the
guide's first meaningful body paragraph. `required: true` is reserved for
generic API wrappers and cross-operation conventions a complete downstream
schema cannot express.

A maintained provider's guide states only what no schema, description or typed
refusal already tells the agent where it acts. Generic rules live at the point of
use: `cursor` and hatch `page` schemas for continuation, `fields` for narrowing,
withheld values and cuts, hatch descriptions and `withheld` hints for operation
discovery, and the `write_outcome_unknown` error for write-once. A hatch `page`
with `hasMore: true` and no `nextCursor` also adds a `warnings` notice that the
result is incomplete. Money units, account or environment selection, sensitive
data reduction and "absence does not prove" rules stay in the guide, as does any
disqualifier that no refusal enforces. A read-only connection is not served its
guide's `writes` blocks.

Describe results carry a `guide: "connector:<id>"` pointer and a
`guideSummary`; a search page carries both once per connector in
`connectors[<id>]`. A matching tool row or description also carries
`guideRequired: true` and `guideRequiredReasons` when Connecta can prove review
is necessary:

| Reason               | Raised by                            | Survives exact schema expansion                          |
| -------------------- | ------------------------------------ | -------------------------------------------------------- |
| `connector_required` | the explicit `required: true` above  | yes                                                      |
| `approval_required`  | an unannotated or write-capable tool | yes                                                      |
| `schema_truncated`   | a requested compact shape was capped | no — the describe that returns the exact shape clears it |

Describe reports whatever reasons remain in the same two fields. The boolean is
an instruction, not a server-side gate: nothing refuses the call, so the agent
is merely told to fetch the guide first, for any reason listed. Otherwise the
bounded summary decides — connector-specific sequencing, units, pagination,
aliases, and generic API conventions still need the guide when they affect the
task, while a complete and unambiguous one-read schema proceeds directly. Guide
lookup uses an exact name returned by `skills({})`, search, describe, or the
`execute_code` inventory; callers never manufacture `connector:<id>` from an
unmarked connector. A bare connector id, such as `skills({ name: "crm" })` or
`connecta.skill("crm")`, also serves that connector's guide. Built-in skill
names stay reserved: `usage` and `investigate` always fetch the built-in skill,
even when a connector has that id, whose guide stays at `connector:usage` or
`connector:investigate`. A bare id naming a connector without a guide fails with
`Connector "<id>" has no usage guide.`; any other unknown name fails as an
unknown skill. Names containing `:`, including URIs, never fall back to a bare
id. MCP `skills/get` resolves names the same way; `resources/read` accepts only
document URIs. Canonical names and document/root URIs take priority over compatibility aliases. An alias shared by multiple guides fails as ambiguous; use the canonical URI.

A connector-scoped lexical miss keeps that connector's guide metadata under
`queryAnalysis`. This matters for generic wrappers whose broad tool name
contains no endpoint vocabulary: a required guide stays discoverable instead of
disappearing with the zero-tool page.

Two built-in skills are byte-identical across deployments. `usage` is fetched
only for missing guidance or program repair, and owns program selection detail, examples, runtime
differences, and repair guidance; `investigate` is domain-neutral on-demand
guidance for an investigation that spans several services — shared guidance,
not a saved workflow and not a source of deployment-specific ids. `skills`
lists it; the `execute_code` description does not advertise it. The always-loaded instructions and tool definitions keep
route selection, the fail-closed boundary, and the minimum guest syntax, so a
client that never fetches a skill can still write a valid first program.

The server instructions state the complete routing rule once. Some clients
drop server instructions, so each tool description stays sufficient for its own
correct use without restating that rule: `call_tool` names its scope (one
known-address read) and points other read work to `execute_code`;
`search_tools` names its scope (catalog inspection, or finding a write) and
points read work into a program; `execute_code` opens with the terse
three-route lead (`One known read: call_tool. One known write:
call_destructive_tool. Everything else: execute_code.`, or the read-only
two-route form). The `usage` skill points to those two sources instead of
repeating them.

Tool descriptions and output schemas carry deployment configuration only: the
connector inventory, budgets, the endpoint's read-only setting, and whether any
visible connector has a guide. No catalog outcome, call, authorization state,
or other live status reaches `tools/list` or the instructions, so the
always-loaded surface stays byte-stable for a client's prompt cache.
Instructions reflect the surface and endpoint write policy, subject to connector
restrictions. When all admitted connectors are read-only, instructions state that
writes are unavailable. On the meta surface they open by saying what the endpoint
reaches, for example `Gateway to connected services: crm, tickets.`, and then give
the routes, the write policy and recovery through `nextAction`. A native pool omits
the ids, because its tool names show them.

The ids come only from the caller's admitted view, the same view the `execute_code`
inventory reads: configured ids in registry order, never a value from the request,
a catalog or a credential. A maintainer at plain `/mcp` sees every id; a person
routed there sees only their pool's, and an id outside the admitted view never
appears. Past 120 UTF-8 bytes, ids give way, in registry order, to an exact
`+N more` count, and the inventory carries the fuller list.

They also include pool scope: a pool that sets a
[`description`](./auth.md#pools) has it placed first at `/mcp/<pool>` and
`/agent/<pool>`, and for a person routed to that pool at plain `/mcp`, so the model
learns that endpoint's scope, for example
`Team tier: shared tools only. For someone's own mail or files, ask them to message you one-on-one.`
A maintainer at plain `/mcp` receives none. The description changes no tool or tool
description. Plain `/mcp` can serve different ids and scope to different callers at
one URL, as its tool list and inventory already do, so `initialize` and
`server/discover` stay `cacheScope: "private"`: a client keeps what it learned per
caller and endpoint and never shares it. Connector
guides stay scoped to the deployment that listed them even when two deployments
use identical content, and a deployment with no connector guides receives none of
the short conditional guide pointers in its tool definitions.

### Native Skills extension

The [Skills extension](https://github.com/modelcontextprotocol/ext-skills) is Beta under
[SEP-3392](https://modelcontextprotocol.io/seps/3392-extension-lifecycle): breaking
revisions can reuse its ID. The released settings define no `revision`; Connecta
refuses downstream declarations with an explicit revision rather than enabling
unknown semantics. Upward handlers remain Connecta-owned to preserve caller views.

Connecta declares `resources: {}` and `io.modelcontextprotocol/skills`, then
serves `skills/list`, `skills/get`, `resources/list` and `resources/read` from
the same registry as `skills` and `connecta.skill`. These methods return
`resultType: "complete"` and `cacheScope: "private"`. Local-only caller views
advertise `ttlMs: 300000` (five minutes); any visible downstream skill source
keeps `ttlMs: 0`, including reads of local guides on that view. Clients must key
private caches by endpoint and authenticated caller. No request-bound catalog or
digest promise is retained across requests. Listing pages
contain at most five complete skills: usage first, required connector guides
next, other connector guides, downstream skills, then the investigation guide.
Subsequent pages use `cursor`/`nextCursor`. Local lookup works without listing.

The local document URIs are `skill://connecta/usage/SKILL.md` and
`skill://connecta/connectors/<slug>/SKILL.md`. A valid Agent Skills connector ID
is its slug; other IDs use a readable normalized ID slug plus a 12-character
SHA-256 suffix. Generated slugs reserve every configured connector ID and append
a deterministic numeric suffix on collision. Avoid a connector ID equal to another
connector's generated name: allocation depends on the IDs a catalog can see, so
adding one moves the other guide to a suffixed name.
The former `connector-<48-character-hash>` names, roots and file URIs remain
resolvable aliases. The deployment's construction warns once, without
rejecting a guide, when its summary cannot say when to load it: a summary
derived from a guide with no paragraph (its first heading, however long, or
the generic fallback), or, by an advisory English heuristic, a credential or
scope statement with no task verb or operation noun. The `Read-only.` prefix of
a read-only connector is ignored. A capability description is not flagged.
Personal registries built per principal never repeat the warning. Set
`usageGuide.summary` to say when to load the guide; non-English prose may
produce a false-positive warning.
The suffix makes each
document a valid Agent Skills file; the roots `skill://connecta/usage` and
`skill://connecta/connectors/<connector-id>` also resolve. Provider guides are
built from maintained provider guides with the existing
connection context and deployment instructions. Local manifests contain a
SHA-256 digest and UTF-8 byte size of the complete document. `usage` and
`investigate` remain compatibility names; `connector:<id>` remains a
one-release alias for its canonical document.

Set `remoteMcp(id, { url, skills: true })` to opt into downstream skills.
Each downstream URI maps under `skill://downstream/<connector-id>/` with an
encoded origin and the original path tree, preserving relative references.
The originating authority is repeated as a path segment so an authority-rooted
skill retains its directory name. All frontmatter fields, manifests and digests
are preserved except for the namespace prefix on URIs. Listing never retrieves
file bodies. Reads accept only files advertised in a complete manifest, or the
main file of a dynamic skill. Non-file URI shapes, query/fragment URIs and
traversal segments fail closed. No URI is fetched directly over HTTP.

Local guides follow connector visibility. Downstream skills require a
whole-connector grant in the caller's admitted pool; a tool-only grant cannot
authorize arbitrary files. Each list/read uses that caller's context and
credential ownership. Downstream skills use uncached `skills/list` and explicit
`resources/read` requests on the same request-scoped connection as ordinary
resource reads. The SDK's auth-partitioned resource inventories remain separate
from skill manifests; neither skill catalogs nor file bodies enter its response
cache. A failed or malformed opted-in listing fails the entire skills catalog,
with no partial cache. Known local guides remain readable during an outage.

On `skills` and program `connecta.skill` reads, downstream text is prefixed with
a fixed third-party origin sentence naming the connector (bounded to 128 ID
characters). This prefix has no closing delimiter. `skills` listings carry the
same sentence before each downstream description, collapsed to one line, in text
and structured output. Program `connecta.read` applies it to text contents whose
URI uses the `skill:` scheme or ends in `SKILL.md`; a downstream's other resources
are returned as ordinary data, and binary contents are not labeled. Maintained and
deployment guides remain unlabeled. Native `skills/get` metadata and `resources/read`
contents stay unchanged so original manifest digests remain verifiable; adding a
label there would break integrity checks. A native host must attach its own origin
label when it loads verified content into model context, as the Skills extension
requires.

Downstream files are proxied byte-exact, including CRLF and binary supporting
files, within 512 files and 16 MiB per skill. Catalog metadata is bounded to
1,024 entries and 8 MiB. The existing request-scoped agent boundary redacts
sent credential echoes, including a credential in a binary file's wire
encoding. Binary echoes remain valid base64; mixed UTF-8/JSON escapes and an
encoding that itself echoes a credential cause the file to be withheld as an
encoded placeholder. Unmatched binary bytes remain exact. That is the sole
exception to byte-exactness: digests remain the downstream's originals, so a host's integrity check rejects altered
content. Refreshing a manifest cannot make credential-bearing content safe to
load. URI and digest fields containing a sent credential are refused rather
than repaired, including credentials sent by later catalog or read operations.
Skill content never reaches operator logs, activity or status. Upward
`resources/read` is skill-only; downstream general resource reads are the
separate Phase 3 item 7 program API.

The wire contract follows the [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
and [2026-07-28 Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources).

## Result representation

For structured envelopes, `structuredContent` is the canonical full-fidelity value and
`content` carries the same complete value as compact JSON for clients that only
consume text. Keeping both follows MCP's backwards-compatibility guidance;
dropping the text copy waits on host-forwarding measurements showing supported
clients do not need it. Direct-call failures set `isError: true` and carry the
same `{ ok: false, error, durationMs, attempts }` envelope in both forms, whether
`resultMode` is omitted, `"mcp"`, or `"value"`. Plain-text guidance stays
text-only: a `skills` fetch returns the guide once, in `content`, and the tool
advertises no `outputSchema`, while its listing and errors keep `structuredContent`.
A program's `connecta.skill` returns its own `{ name, format, text }` value. Successful direct calls with `resultMode` omitted or `"mcp"` return
their data only in `content`, with the downstream format in
`_meta["dev.connecta/format"]`. They omit `structuredContent`, including on
truncated results, so clients that prefer it cannot replace data or a preview
with metadata. API results keep their serialized value; downstream MCP native
content blocks pass through. Value-mode successes retain
`{ ok: true, data, format, durationMs, attempts }` in both forms, including when
`data` is a truncation notice. Direct-call tools advertise no `outputSchema`:
MCP requires a tool declaring one to supply conforming structured results, which
default native content does not promise.
When downstream MCP content has no text block and downstream `structuredContent`
is present, Connecta appends a
text block carrying its compact JSON and then applies the same content size
guard, which preserves structured-only results including `null`, arrays, and
scalars. An existing text mirror stays unchanged; Connecta adds no second copy.
Newly stashed JSON and downstream content envelopes use compact serialization,
and a lone text block stashes as its own text, so `connecta.result` offsets and
totals describe exactly that text.

| Bound                              | Value                               |
| ---------------------------------- | ----------------------------------- |
| Stashed result TTL                 | 15 minutes                          |
| `results.maxStashBytes`            | 8 MiB per shared storage ledger     |
| `results.maxStashEntries`          | 64 per shared storage ledger        |
| Downstream MCP tool answer         | larger of `maxStashBytes` and 8 MiB |
| Top-level discovery result ceiling | 256,000 UTF-8 bytes                 |
| Downstream MCP `isError` text      | 512 UTF-8 bytes plus an `…` marker  |

A remote MCP tool answer past its bound is not read further and fails the call
before result processing, as [remote MCP servers](./integrating.md#another-remote-mcp-server)
describes; it is never stashed or previewed.

The discovery ceiling counts text, `structuredContent`, and JSON escaping
together, because measuring one copy would advertise half the bytes the adapter
actually returns; error framing may shorten a bounded `isError` reason further to
fit the call's result cap on the same arithmetic. Both stash options accept
non-negative safe integers, zero disabling stashing, and are shared across all
subjects and pools; they count the stored ASCII paging envelope, base64 overhead
included, not only the result text. Capacity is reserved before each storage
write so concurrent requests cannot oversubscribe it, and a full stash refuses
new entries. A later attempt deletes expired entries before reusing their
capacity; a failed deletion keeps the charge. These bounds cover all processes and Worker isolates sharing the store.
Compare-and-set reserves each charge in one storage ledger before any chunk
is written; chunk TTLs cannot exceed the charge deadline.
The whole stash, including reservation, stops waiting after 45 seconds, or sooner
when the call's remaining deadline or request cancellation ends result processing.
A completed call whose result processing is cut off returns the non-retryable
`result_processing_failed`: any write already happened and must not be repeated
to recover its result. Programs keep that write in `writes.succeeded`, even if
paging is cancelled. A full or unavailable stash that answers within the budget
still returns the ordinary truncated result and paging-unavailable hint.

Results belong to the authenticated subject whenever auth supplies a subject or
user id, independently of activity configuration, under the provider's namespace
when it has one and `connecta:auth:<provider kind>` otherwise. Keep subject ids
distinct within that namespace. An explicit principal is the fallback subject
when neither id is supplied, and open deployments and auth providers that supply
no identity share one partition. Each new stash also binds the principal,
endpoint/pool, request origin, connector, tool, and classification. Program-return
stashes bind every contributing call, resource or skill read, and catalog lookup,
including dependencies inherited from pages read during the run. Downstream skill and
resource content requires a whole-connector grant on every page. Local guides and catalog
metadata require the contributing connector or tool to remain visible, including
caught catalog-load errors, unknown-tool failures, and recovery messages that
list visible connectors or local guides. No-match search guidance also retains
the connectors it names or summarizes by count, including matches to connector
titles; scoped guides and summaries, absence rosters, and catalog errors retain
their contributors. Search counts, ranking, and term analysis also retain every
searched connector, including matches outside the returned page. Returns with no downstream calls still
require matching identity, origin and endpoint, current auth, and pool membership. A page must
match those bindings and pass current auth, connector/tool grants, pool membership,
and read-only checks. Old entries lacking bindings fail closed. A random UUID is a
handle, never an access grant.

Each page validates access twice: before decoding its payload and again before
returning it. Each pass authenticates the caller once, checks every dependency
against that admitted scope, and reuses each connector's catalog within the
pass. Authentication is never reused across passes or requests, so revocation
during the page read still refuses the page. For example, a search handle with
30 tool dependencies requires the same number of authentications as one with
one dependency. Paging deadlines cover both storage and access validation;
timeout errors identify the active stage as `result storage` or `access validation`.

New entries store UTF-8 bytes in a base64 envelope split across storage keys,
48 KiB of result text per chunk — widening past roughly 1.5 MB so no result
occupies more than 32 keys, because every chunk is also a write. `connecta.result`
reads and decodes only the chunks a page covers plus a few boundary bytes, so
paging a 1.2 MB result costs the same per page as paging a 300 KB one; it
neither encodes nor reads the whole result per page. Entries without the required identity and invocation bindings fail closed,
including pre-upgrade single-key envelopes and raw-text entries. Offsets and `totalBytes` always describe the
original UTF-8 text, not the envelope. A supplied offset inside a character
moves back to its start; page ends also align to character boundaries, and a
page smaller than one character widens just enough to make progress.
Decoding preserves every payload code point, including U+FEFF at the start of
the result or any page, so joining pages reproduces the original UTF-8 text.
Oversized raw text containing unpaired UTF-16 surrogates cannot use this UTF-8
page/offset contract. It returns a successful truncation notice explaining that
the text cannot be paged and suggesting a JSON value request for recovery,
without a stash id, paging action, or altered preview.
Completed writes remain successful and must not be repeated. JSON values still
round-trip such strings through their escaped JSON representation.

A per-call `timeoutMs` covers catalog resolution, admission, and connector
execution under one deadline, cut to the response ceiling, `execute.watchdogMs`
(55 s by default) from the request's arrival, so the client gets a typed result
rather than its own transport timeout. A call with no more than the dispatch floor
left (100 ms, or a tenth of a ceiling shorter than one second: less than one vendor
round trip) is refused before it resolves, as a retryable `timeout` at
`details.stage: "response ceiling"` that says it was not sent. A call whose time runs
down to the floor during resolution, admission or auth gets the same refusal from a
check that is the last step before its connector, and again from `remoteMcp()` and
`api()` at the physical send, after any reconnect, grant renewal or credential
refresh, when the call's ledger proves nothing left (`L3`). Each refusal records a
`cancelled` activity event with `attempts: 0` and `errorCode: "timeout"`, since
nothing downstream timed out. See [`L3`](./code-mode.md#cancellation-and-limits). The admission queue's own timeout may expire
sooner but cannot extend the call deadline. Result processing happens after that
deadline ends, because a completed downstream call must not turn into a
retryable timeout while Connecta prepares its response.

### Previews of reads over the cap

A result at or under its cap always returns whole. A successful direct read over
its cap (the connector's `maxResultBytes`, else `calls.maxResultBytes`, else 24,000
bytes), on a surface that lists a program tool, may show a sample instead of its
first bytes: the structure and whole rows, or the head and tail of its text, with a
retained copy of the result and a ready-to-edit program. Such a read is already cut
and already stashed, so a preview adds no storage cost, and valid JSON with a notice
saying what it holds replaces raw JSON sliced mid-value. The rule is generic and
needs nothing from a provider. It reads the result after redaction and value safety,
for API values and for a lone MCP text block.

**Rows.** A preview fires when all of these hold:

- its largest list holds at least 3 records or arrays, sits within 3 keys of the
  root, and holds at least half the bytes;
- everything outside that list fits in 1,024 bytes;
- at least the first row can be shown whole, within 3,000 bytes, and at least one
  row is left out;
- every number in the result keeps its exact value through `JSON.parse`.

```text
{"truncated":true,"resultId":"…","totalBytes":48210,"rows":{"path":"items","count":200,"shown":18,"keys":["id","email","status"]},"hint":"Sample only: rows 1-18 of 200 at items follow, in the result's own shape, with every value outside the list; the other 182 are not shown. All of it is retained for 15 minutes: run nextAction in execute_code, editing its last line to filter, join or count the rows, instead of reading pages by hand. If execute_code is refused or unavailable, the rest can't be read here: narrow this read with its own filter, limit or fields arguments, or say what was not read.","nextOffset":0,"nextAction":{"tool":"execute_code","arguments":{"code":"async () => { let text = \"\", offset = 0, page; do { page = await connecta.result(\"…\", { offset }); text += page.text; offset = page.nextOffset; } while (page.hasMore); const rows = JSON.parse(text).items; return { count: rows.length, rows: rows.slice(0, 5) }; }"}}}
{"items":[{"id":"t_1","email":"alice@example.com","status":"open"},…],"has_more":true,"next_cursor":"c2"}
```

The body after the first newline is valid JSON in the result's own shape: whole
rows from the start of the list up to 1,500 bytes, and every value outside it.
`rows.path` names the list as JavaScript would, so a key a dotted path cannot
spell reads `["a.b"].items`, and a root array reads `(root)`. `rows.keys` samples
up to 40 keys of at most 64 characters from the first 50 rows; `rows.count` and
`totalBytes` describe the whole result.

On an endpoint that lists `execute_read_code`, the hint and `nextAction` name it instead
of `execute_code`. A preview only ever follows a read, and its program reads only the
retained result, so it runs on either route.

**Text.** Text that is not JSON, or an API connector's text value, returns its line
count in `text.lines`, then its first 1,200 and last 800 bytes around a marker saying
how many bytes were left out, with `text.shownBytes` beside it. Cuts fall on
character boundaries. Its program reads the retained text and returns the lines
matching a pattern the agent can edit.

**Everything else keeps the route below:** results no program can reach whole within
`execute.maxHostCalls`, JSON objects with no such list, scalars, lists of scalars,
lists deeper than 3 keys or shorter than 3 rows, a first row over 3,000 bytes, text
with unpaired surrogates, several blocks, non-text blocks and value mode. So does any
number parsing would change: complete tokens are compared by exact value, including
fractions and exponents, so `9.007199254740993e15`, `1e999` and `-0` decline the view
wherever they appear, and `1e3` and `12.50` do not. Digits inside a string never count.
The offered program parses the same text, so a number past the sample declines too.

**A call that may have written never previews.** That covers every effective write
and a source write a deployment overrode to read: its result is its only copy, and
repeating it to look again is forbidden. It keeps its first bytes, and its notice says
the write already ran and offers no repeat.

A preview is presentation only. A program's value and the handle's pages are
byte-for-byte what they would have been: the retained text is the same redacted
text the read would have paged, and `format` keeps its meaning. A view drops no
continuation field, total, warning, status or `format`, shows no empty list in place
of a full one, keeps array positions, and shows `false` and `0` as they are.
`totalBytes` is the original size. Clients that parse a direct read should not assume
the body after a `truncated` notice is a prefix: `nextOffset` is 0 and the body is a
separate view. The per-connector and deployment `maxResultBytes` still bound what is
shown: a preview that does not fit the call's cap takes the route below, and a raised
cap returns more results whole. A preview counts as `result_too_large` friction, as
any result past its cap does. If the stash fails, the read keeps its first bytes and
its paging-unavailable notice, and the operator warning fires as usual.

**Recovery depends on the program tool.** `connecta.result` exists only inside
programs, and a host may prompt for or refuse `execute_code`, which is annotated as a
write on a writable endpoint. A refused program means the rows or text the preview left
out can't be read from this result, which is also true of the first-bytes route. So the
hint states the fallback: narrow the read with its own arguments, or say what was not
read. A view shows less of the result than first bytes would, 1,500 bytes of rows
against 24,000, so narrowing matters more on such a host.

Previews need a program tool, not only a paging tool. Page-first reading failed when an
agent read a 185 KB log in pages and missed the failing range, and a preview shows too
little to read by hand, so a native pool with `executeCode: false` keeps its first
bytes and its `read_result` notice. One value in `src/routes/mcp.ts` registers the
program tool for a request and names it in `nextAction` and the hint, so the text never
offers a tool the surface does not list.

### Truncated direct-call results

A `call_tool` or `call_destructive_tool` result over its cap — the connector's
`maxResultBytes`, else `calls.maxResultBytes`, else 24,000 bytes — that does not
get a [preview](#previews-of-reads-over-the-cap) comes back as one text block. Its first line is the truncation notice, one line of compact
JSON; everything after the first newline is the preview. `structuredContent`
is absent, so the notice cannot hide the preview in clients that prefer it:

```text
{"truncated":true,"resultId":"…","totalBytes":161420,"hint":"This write already ran: do not call it again to see its result. Bytes 0-24000 of 161420 follow; page the rest with connecta.result using nextAction.","nextOffset":24000,"nextAction":{"tool":"execute_code","arguments":{"code":"async () => await connecta.result(\"…\", { offset: 24000, maxBytes: 3829 })"}}}
{"ts":"2026-09-16T21:31:11.759Z","actor":"sam.ortiz@example.com",…
```

The notice leads because clients cut oversized results from the end, and a
notice at the tail is the part they drop. Claude Code (measured on 2.1.280, from
its bundled source and with `claude -p` against a probe server) passes an MCP
result through untouched while its text blocks total at most 50,000 characters.
One character more and it replaces the whole result with a pointer to a spill
file plus the first 2,000 characters of `JSON.stringify(content, null, 2)`,
whatever `MAX_MCP_OUTPUT_TOKENS` says. Once the characters exceed twice
`MAX_MCP_OUTPUT_TOKENS` (25,000 by default, so again 50,000) it also counts real
tokens against that limit, and a result over it arrives as an error carrying no
content at all — no preview, no notice. The old layout — a
50,000-byte preview, then the notice — crossed the first line every time, so an
agent without file tools never saw the handle; in the eval's write task two of
three models re-ran a billable export three times trying to read its result.

The default cap sits under both lines with room to spare. Preview plus notice
stays under 25,000 bytes, which is under 50,000 characters for any text, because
a character is at least one UTF-8 byte, and under 25,000 tokens for any text,
because a token covers at least one byte. A `connecta.result` page is bounded by the same
inline byte cap, and 24,000 matches the default program result boundary in
[code mode](./code-mode.md) (`execute.maxResultChars`). The `maxBytes` in
`nextAction` is sized so one page fits that boundary under worst-case JSON
escaping, capped by the call's own inline cap: 3,829 bytes by default. A deployment whose
clients take more can raise the cap, and one whose clients take less can lower
it, per connector if need be; a result between 24,000 and 50,000 bytes that
used to arrive whole now pages. A client that spills rather than rejects keeps
the notice whatever its threshold, since the notice is the first few hundred
characters. One that rejects outright — Claude Code with
`MAX_MCP_OUTPUT_TOKENS` set below 12,500 — needs a cap under twice its limit.

The preview is the head of what `connecta.result` pages, cut on a character
boundary, so the `offset` in `nextAction.arguments.code` continues exactly where it stops. A
lone text block — including the one synthesized from `structuredContent` — is
measured, stashed, previewed, and paged as its text: wrapping it in a content
envelope added nothing but a second layer of JSON escaping, so a JSON payload
used to preview as `[{"type":"text","text":"{\"ts\":…` and every page carried
the escaping twice. Several text blocks keep the serialized envelope as the one
string measured, stashed, and paged, because their boundaries live there; they
preview as their text joined by newlines, and their next action starts at
offset 0. A content array carrying non-text blocks returns the notice alone,
because the head of a half-written base64 image helps nobody. In value mode the
notice is `data` itself, with no preview and a next action at offset 0.

The hint says what to do next. For a call not explicitly annotated read-only it
opens with “This write already ran: do not call it again to see its result.”
The approved write happened; repeating it to look again is how one export
becomes three. For an explicitly read-only call, the hint offers reduction first:
to find something specific, loop `connecta.result` over the retained result in
one `execute_code` program, filter there and return the matches; to read
on, run `nextAction`. A reduction must see the whole value at once, because
page-by-page reading in the model misses things: when the hint named paging
alone, the eval's weakest model read a 185 KB CI log in 24,000-byte pages, skipped
the range holding the real failure, and named the flaky test near the top. The
loop keeps that whole-value reduction without fetching from the downstream a
second time. The hint names the result ID and that the result is retained for 15
minutes.

The loop is offered only when one program can finish it: every page at the
connector's cap (at most the 32 KiB bridge ceiling), plus two host calls spare,
must fit `execute.maxHostCalls`. At the defaults that is about 432 KB. Past that
a loop would end in `budget_exceeded` with nothing returned, so the hint says to
repeat the read inside `execute_code` with `connecta.call` and reduce it there;
a host call's result is not bound by the inline cap, only what the program returns
(`L6` in [code mode](./code-mode.md)). A value over `L6`'s host-call bound returns
a paged handle instead, whose own hint is sized the same way.
When paging is available, `nextAction` is the page handle for either kind of call, because paging is
the one next step connecta can spell out exactly, while a reduction is a
program the agent has to write. `resultId` stays beside the exact `nextAction`,
so the handle is actionable without copying an identifier out of prose.
Oversized program returns carry the same route, with a bounded preview after
its notice fields. They stash the compact JSON return and page from offset 0;
see [program returns](./code-mode.md#results-and-projection). A run that completed
any write gets the same no-repeat warning. Oversized discovery responses carry
no paging route.

### Paging with connecta.result

Meta endpoints page inside a program. Native pools without code list `read_result` for the same bound handles. Program calls also
return handles for oversized values; see [program result limits](./code-mode.md#cancellation-and-limits).
A handle within the program's [read ceiling](./code-mode.md#connectaresult-and-connectaskill)
says to read it whole with `connecta.result(handle, { all: true })`, for one host call.
Past the ceiling, a read's handle says to loop `connecta.result(handle, { offset })`
until `!hasMore` only when every page at the connector's cap, plus two host calls
spare, fits the calls its program has left. At the default 20 calls and 24,000-byte
cap it doesn't: its hint then gives the pages
to read in this program and in each new one, and says to return the reduction so
far with `nextOffset` and continue from both, by `resultId`, inside the 15-minute
retention. A loop past the budget ends in `budget_exceeded` with nothing returned.
A write's handle says the write already ran and not to repeat it.
`connecta.result(handle, { page: 0 })` accepts those handles alongside direct
result IDs. Numbered pages are zero-based and mutually exclusive with offset.
Keep maxBytes fixed while incrementing pages. A direct call's
notice carries a `resultId`, `nextOffset`, and an executable `execute_code`
recovery action. When the hint offers the loop, read and reduce the result in one
program. Leave `maxBytes` unset, because a smaller page spends more host calls:

```js
async () => {
  let text = "", offset = 0, page;
  do {
    page = await connecta.result("result-id", { offset });
    text += page.text;
    offset = page.nextOffset;
  } while (page.hasMore);
  return JSON.parse(text).items.map(item => item.id);
}
```

A page is `{ resultId, offset, bytes, totalBytes, hasMore, nextOffset?,
format: "text", text }`. The page size is clamped to the original call's inline
cap and a 32 KiB program bridge ceiling, with UTF-8 alignment and forward progress. Reassemble inside the sandbox;
returning pages unchanged can hit the program result cap. The admitted subject
and principal, endpoint/pool, request origin, connector, and tool bindings must
match. The host rechecks current access and whether the endpoint is read-only
before returning each page; a read-only endpoint or connector cannot read a write stash.
Caller arguments select no partition. A read-only endpoint never runs a write,
so every write result it could page came from a writable endpoint.

A refused stash write cannot undo a downstream success. Direct calls and program returns produce
a paging-unavailable notice, without a handle or recovery action. A write's
notice still says it already ran. Activity records success; operator logs receive
a fixed warning without storage error prose. Never repeat a write to recover output.

A result a program retained is readable from later requests only once it has passed
that run's final secret set. Otherwise it stays unreadable: paging answers
`result_not_retained` with `retryable: false`, telling a read to rerun and a write
not to repeat ([code mode `R4a`](./code-mode.md#results-and-projection)).
A direct call's stash passes its own request's set when stored; a later direct call
in another request shares no set with it.

## Lexical discovery

`search_tools` and in-program `connecta.search` return the same flat discovery
page. Select tool rows from `page.tools`.
With the same schema format, schema-key option, and scoped registry, both paths
return identical data. Top-level search omits schemas unless requested; programs
default to TypeScript signatures and schema-key metadata.

```json
{
  "catalogErrors": [],
  "tools": [
    {
      "name": "get_ticket",
      "address": "tickets.get_ticket",
      "classification": "read",
      "schemaFormat": "json",
      "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
    }
  ],
  "connectors": { "tickets": { "title": "Tickets", "guide": "connector:tickets", "guideSummary": "Ticket ids and states." } },
  "total": 1,
  "offset": 0,
  "limit": 8,
  "hasMore": false
}
```

`catalogErrors` is always present and serialized before tools. It contains
bounded typed failures from visible catalogs, including on an unscoped search
with healthy matches. Credential and permission failures appear first. OAuth
and operator credential failures carry the codes and `recovery`, `nextAction`,
and retry instructions described below. `provider_permission_denied` asks the
resource owner to grant access and carries no reconnect action. Discovery never
starts recovery. Failure messages use fixed text derived from the error code
and connector id, never connector-supplied error text. Other failures retain
`code`, `message`, `retryable`, and any
`retryAfterMs`. A scoped search also keeps its bounded failure subset under
`queryAnalysis.catalogError` for clients that already use it.

An unscoped search gives each connector at most 5 seconds (or
`discovery.probeTimeoutMs` when shorter) and ends within a 9-second discovery
budget. A connector that recently timed out or failed slowly is skipped for up
to 60 seconds: its entry keeps the recorded code with `retryable: true`,
`retryAfterMs`, and the message `Connector "X" was skipped because its catalog
lookup failed recently (CODE). Search with connector "X" to try it now.` A
scoped search always probes. Records are kept per owner, admitted endpoint and
described connector configuration. A healthy connector whose catalog always
takes more than 5 seconds and has no earlier complete catalog can stay out of
unscoped search; search it with `connector`, or let any longer-deadline operation
warm its complete catalog. See
[Discovery health](./architecture.md#storage-credentials-and-connectors).

**Stale listings.** When a connector does not answer an unscoped search, because
of a timeout, a skip after a recent one, the discovery budget, `unavailable`,
`rate_limited` or a retryable downstream failure, the search lists that
connector's last complete catalog if the same owner, credential and catalog
generation have one no more than 24 hours past its expiry. Its `catalogErrors`
entry then adds `stale: true` and `ageMs`, the milliseconds since the downstream
last confirmed that catalog, and keeps `code`, `retryable` and any
`retryAfterMs`. A downstream's own retry delay stays as it named it, and the
message then says to wait rather than to search again. A skipped connector's
`retryAfterMs` is when discovery next asks it, at most 60 seconds:

```json
{
  "connector": "tickets",
  "code": "timeout",
  "message": "Connector \"tickets\" did not answer discovery (timeout), so its tools are listed from its last complete catalog. Calls still check the live catalog. Search with connector \"tickets\" to try it now.",
  "retryable": true,
  "stale": true,
  "ageMs": 412000
}
```

A stale listing grants nothing. A call, `connecta.describe` and a search with
`connector` read the live catalog, so a tool the downstream removed fails with
`unknown_tool` and a reclassified one runs under its current verdict. Deployment
classification, hidden tools, pool grants and read-only endpoints apply to a
stale listing as they do to a live one. Authorization and permission failures,
refusals and malformed catalogs never list a stale catalog, and a partial catalog
is never stored or listed. An entry without `stale` lists no tools for that
connector. `queryAnalysis.catalogError` holds failures only.

An authorization or permission refusal also retires that credential's catalog
for later requests, in every isolate: it is neither listed nor reused, fresh or
stale, by discovery or by a call's five-minute fallback, until a listing
succeeds. On a connector with a shared credential this covers everyone using
that credential; on any other connector, only the caller refused. A credential
change, OAuth connect or disconnect, or operator invalidation has the same effect
at once for every owner. A stale listing is read again after its probe fails, so
any of these during the probe also takes the tools out of that search.

A refusal retires the catalog of the credential, OAuth identity and catalog
generation its attempt was dispatched under, whichever are current when it
answers, so another credential's catalog keeps working. A listing lifts only the
retirement it read before it asked the downstream; a refusal that lands while it
runs stays until a later listing succeeds. A custom connector's answer is
retained only if its credential did not change while it was listing. Connecta
cannot see which credential a custom connector sent, so a refusal whose
credential changed while it was listing, or cannot be read afterwards, retires
that connector's catalogs for every credential and owner.

Three limits follow:

- A custom connector's credential is compared when its listing begins and when
  it is refused. A change back to the same credential between them goes unseen,
  as does a connector sending a credential it kept from earlier. The credential
  actually refused is then not retired: its catalog can be listed stale if it
  becomes current again, until its first answer.
- A retirement that cannot be written is logged as `catalog fence failed` and the
  refusal is still returned. The catalog stays reusable until a later refusal is
  recorded, a listing replaces it or its stale limit passes.
- A connector whose `tools/list` keeps answering 401 or 403 has no catalog to
  fall back on, so every call that must resolve a tool through its catalog fails
  with that refusal until a listing succeeds. This includes a credential that may
  call tools but not list them, and the five-minute fallback does not apply while
  the catalog is retired.

`total` counts this response's matches. Offsets are stateless, so it stays the
same across a browse's pages while each catalog is unchanged, including one
listed stale, and can change if a catalog refreshes between pages or a connector
with no stale catalog starts answering.

A cached or authored catalog does not wait for a probe slot, so
`discovery.concurrency` bounds the connectors actually being asked. A probe that
runs out of its own deadline also starts one refresh in the runtime's tail
(`ctx.waitUntil`, or the Node listener's tracked equivalent) under the full probe
deadline, at most 20 seconds, and that refresh warms the next search.

Tool rows carry the address, stored classification, and tool-specific
`guideRequired` and `guideRequiredReasons`. Facts shared by every row of one
connector appear once per page in `connectors`, keyed by the connector id that
prefixes each row's address: the configured display `title` when present and
`guide` and `guideSummary` when the connector has a guide. The map names only
connectors with a row or ready call on this page and is omitted when none has
such facts.
Requested schemas have
`schemaFormat: "json"` for JSON Schema values or `schemaFormat: "text"` for
compact schema strings and TypeScript signatures. Compact schemas are text;
`inputSchema.properties` is meaningful only in JSON mode. Pagination counts
tools across connectors: `nextOffset` is present only when another page remains.

A row's `description` is a summary: the first complete sentence, joined to the
following ones until it reaches 40 characters, within 160 UTF-16 code units. Text
with no sentence end in that range is cut at a word and marked `…`. The row
carries `descriptionTruncated: true` whenever text was left out;
`fullDescriptions: true` returns the original text and no flag.

Search tokenizes tool names, titles and full descriptions at punctuation and
camel-case boundaries. Whole-token matches, a small set of inflectional variants
and a few unambiguous abbreviations (`config`/`configuration`, `db`/`database`,
`doc`/`document`, `env`/`environment`, `org`/`organization`,
`repo`/`repository`, `var`/`variable`) preserve recall without admitting
arbitrary mid-word substrings. Document frequency weights rare domain terms above
ubiquitous action terms. A term weighs most in the name, then the summary, then
the title (`title` or `annotations.title`), and least in the rest of the
description, which stays searchable but is weak evidence. A tool's score is then
multiplied by the square of the share of the query's total rarity it covers in
any zone, so rare words in a description's tail outrank a common verb in a name,
and a tool covering every term is unaffected.

Exact tool names and canonical addresses rank first, so `get_issue` beats
`get_issue_status` even when a connector is named `issue`. A tool named only by
an action word, such as `search`, is exact when it is the whole query, not when a
longer query contains that word. Exact configured connector IDs, full display
titles, and recognized service names rank next. Three tiers follow:

1. Complete matches: every term is in the name, title or summary. A tool on the
   connector the query or scope names need not repeat that connector's name.
2. A hatch whose operation vocabulary matched, and a tool whose name states a
   query word other than an action or the connector, with the remaining terms in
   the rest of its description.
3. Every other match.

When a complete match exists, tier 3 keeps only tools covering every term
somewhere, covering at least two terms, or whose name states a term at least as
rare as the query's average. Otherwise it keeps any match. Within a tier, a query
whose first word outside connector names is `list`, `get`, `find`, `search`,
`show`, `read`, `fetch`, or `count` ranks read rows before write rows; writes stay
on the page. Score and catalog order break the remaining ties.

A maintained provider may declare `searchSynonyms`: groups of single lowercase
words its users and its vendor use for the same record, such as `household`
and `family` for Church Community Builder. A query word then matches that
provider's tools and operation vocabulary through any word in its group, as an
ordinary whole-token match ranked below the word itself. Synonyms never widen
another connector's matches. Church Community Builder declares
`person`/`individual` and `household`/`family`; Granola declares
`meeting`/`note`.
An exact connector ID or title query browses that connector's tools, even when
individual tool names or descriptions mention that identity. Connector identity
terms that never occur in its tools need not be repeated in every tool description.

An explicit unknown `connector` scope returns no tools and an `absence` record:
`{ service, message, configuredConnectors }`. The message says
`No connector for "X" is configured for this endpoint.` Unscoped queries naming
recognized services such as GitHub, Linear, Supabase, or PostHog do the
same when no visible connector ID or title names that service. This service-name
vocabulary is query interpretation, not an inventory of configured providers.
For other service names, use the explicit `connector` scope. An unavailable
catalog is a catalog failure, never an absence. Absence records and catalog
errors use only the endpoint's tools; a connector the endpoint does not serve
is indistinguishable from an unconfigured one.

If no tool covers every search term, in any part of its text or through one
operation of its vocabulary, wider any-term fallback remains available for
ordinary action/object searches and the page carries `matchMode: "partial"`.
A service absence suppresses that fallback, so `GitHub get issue` cannot return
Linear issues or Supabase projects. Tool rows expose no scores or
per-result query coverage. `queryAnalysis` partitions at most eight terms of at
most 64 characters into `representedTerms`, `otherResultTerms`, and
`unmatchedTerms`, marking longer input `truncated`. Its guidance distinguishes
partial matches, unavailable catalogs, unknown scopes, and genuine no-match
results. A non-empty query with no ASCII lexical terms returns no tools with
bounded no-match analysis. An empty or whitespace-only query browses.

## Downstream input on direct calls

On MCP 2026-07-28, `call_tool` and `call_destructive_tool` relay a downstream
`input_required` through connecta's own `requestState`. This requires an
authenticated principal and a vault with `requestStateKey`, `seal`, and `open`.
The original request must be retried with identical arguments. Connecta
continues only the same connector and resolved address, after the normal
identity, pool, classification, schema, and admission checks.

The signed `createRequestStateCodec` envelope contains a version-2
`downstream` discriminator, connector id, and vault ciphertext. The encrypted
payload binds the principal, endpoint including its pool path, meta-tool,
submitted address and resolved target, arguments digest, round, original expiry,
and one-use nonce. It carries the opaque downstream state byte-exact, bounded
private state history from earlier rounds, and a map
from connecta's numbered `downstream/<connector>/<index>` keys to the original
downstream keys and elicitation modes. Neither the opaque state nor the original
keys appear in agent output. Each round consumes a TTL-bound storage CAS before
dispatch; tampering, expiry, changed arguments, cross-principal/pool reuse, and
concurrent or repeated consumption are refused.

Only well-formed form and URL elicitation declared by the client on that request
is forwarded. An empty `elicitation: {}` declaration means form support, as in
the spec. Capabilities are checked again on retry. Unknown response keys are
ignored; recognized bare responses are validated and renamed back before being
sent downstream. Accept, decline, and cancel all continue the pending downstream
call, so the downstream can finish or terminate it. URL acknowledgements and
decline/cancel carry only their action. Sampling and roots remain unsupported
under [#703](https://github.com/zackbart/connecta/issues/703).

URL elicitation retains the downstream-provided URL unchanged. It must be HTTPS,
have no URL userinfo or control/space characters, contain no credential known to
the sent-secret boundary, and remain byte-identical through agent redaction.
Connecta refuses unsafe URLs instead of rewriting them. Messages begin
with `Downstream <connector>:` so the host can display who supplied the prompt;
the host owns consent and browser navigation. Connecta never adds credentials
or follows the URL. Messages pass the ordinary agent-output redaction boundary.
A form is refused if that boundary would change its schema, including property
names, enum values, or annotations; the host never receives a rewritten answer
contract. Prompts, raw continuation results, discovery, and continuation-time
catalogs that echo any round's opaque state are refused before redaction, paging,
stashing, error shaping, schema observation, or cache publication and reuse.
This includes bounded percent-decoded and JSON-escaped views, encoded echoes,
short state, and serialized
numbers, booleans, and null. No prompt, state,
response, arguments, or raw error reaches activity, logs, or status.

Connecta's confidentiality guarantee covers its own handling and persistence of
`requestState`. Checks for state echoed in downstream content are defense in
depth; a downstream's deliberate disclosure of its own state is outside that
guarantee. Binary blobs are not decoded to look for echoes.

A write returning `input_required` has not completed its operation: the
[MRTR spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
defines that result as awaiting input before completion. Sending the original
opaque state and input responses is a continuation, not an automatic replay.
The sealed arguments digest prevents using that continuation for fresh write
arguments. A timeout or other failure during a continuation leaves its nonce
spent, so it cannot authorize a second attempt. Write continuations stop at an
HTTP 401 or redirect before the SDK can refresh authorization or resend the call;
an ordinary write lets the refresh run and stops only the resend.
HTTP 403 scope escalation also remains disabled. Read continuations retain normal
OAuth refresh behavior.

Auth recovery and downstream input are distinct state variants, with only one
active in a round. An auth retry can reach downstream input within the same
three-prompt, ten-minute window. A downstream continuation that fails auth ends
with the ordinary failure; it does not replace its pending state with an auth
replay. Downstream payloads and input responses are capped at 64 KiB, with at
most 16 inputs and 256 characters per downstream key. The combined private
state history is also capped at 64 KiB. Sealed wire state is
capped at 128 KiB. `input_required_invalid`, `input_required_limit`,
and `input_required_unsupported` are non-retryable typed failures;
`input_required_round_limit` is an untyped failure with `retryable: false`.

For a read, programs and in-process meta-tools return
`input_required_unsupported`, with a `nextAction` naming the equivalent direct
call and bounded original arguments. A downstream asks for input from inside
its handler, so a write that suspends may already have applied. A write's
`input_required_unsupported` is `retryable: false` with
`writeOutcome: "unknown"`, carries no `nextAction`, and its `retry` says to
re-read the target before any fresh call; a program counts it in
`writes.unknown`. A direct write whose input cannot be relayed (no sealing
vault, the round limit, or private state over its cap) also carries
`writeOutcome: "unknown"` and is never told to start a new request.
Programs never receive downstream state or prompts, and never restart to
fulfill downstream input.

## Authorization recovery

Every native pool lists `authorize_connector`, including pools without code.
If a connector’s tools are missing, use its id from that tool’s granted-connector
list to request a typed handoff. Give the URL and instructions to the operator;
after repair the host must refresh its tool list before it can call the repaired
tools (the cache hint is 300 seconds). A host that keeps its first list needs a
reconnect or a new conversation; on a pool with `execute_code`, a program can call
them by address without one.
Listing never creates a handoff. Authorization accepts only connectors already
granted to this request; it cannot enable a connector or expand pool scope.

On MCP 2026-07-28, a host declaring `elicitation.url` receives
`resultType: "input_required"` when an eligible call or program needs recoverable
connector authentication and the admitted identity may manage that connector.
Read-classified calls may re-run after a mid-handler auth failure only when
their classification came from a catalog accepted within its TTL. Stale
fallback catalogs cannot authorize post-entry recovery. A write may
elicit only when Connecta's own pre-invocation credential resolution
reports a missing grant, a missing credential slot, or required consent before
refresh. Its handler and transport have not been entered. Programs also require
that every entered call has a fresh read classification during this run.
The `connecta_auth` input request uses `elicitation/create`,
`mode: "url"`, fixed copy, and an identity-checked `/connect/<id>` link built
from configured `publicUrl`. OAuth consent stays in the browser; a credential
slot uses the authenticated operator UI. `authorize_connector` uses the same
flow for explicit connect and restart. There is no legacy shim.

For an operator-managed credential, an explicit `authorize_connector` returns
`recovery: "ready"` when the declared credential fields are configured. This
reports local presence, without testing the key or remembering earlier requests.
The message is conditional: if a call just failed with an authentication or
operator-configuration error, give the retained `operatorUrl`, `credential` and
`instructions` to the operator; otherwise proceed with the requested call.
Without the optional UI, the message retains the deployment configuration
needed for recovery. A missing, unreadable or mismatched slot returns the
operator handoff or `unavailable`. The explicit authorization result has its own
type; authentication errors never carry `ready`. OAuth sign-in and restart
behavior is unchanged.

The host echoes `requestState` and its bare `inputResponses.connecta_auth`
response on the original `tools/call`. Accept re-runs the original call; it
does not prove browser consent completed. Decline or cancel ends without
dispatch or another prompt, with `auth_declined` or `auth_cancelled`. A client
can answer without showing anything, so neither code means a person refused, and
Connecta cannot tell the difference. When this caller may still connect, the
refusal carries the handoff this connector would get on a host without URL
support (`connector`, `recovery`, `authorizationUrl` or `operatorUrl`,
`instructions`), plus `nextAction: { url, purpose }`:

```json
{
  "code": "auth_declined",
  "message": "The client declined the connection prompt, possibly automatically, so the user may not have seen it. Nothing was retried.",
  "retryable": false,
  "connector": "service",
  "recovery": "oauth",
  "authorizationUrl": "https://connecta.example/connect/service?h=...",
  "nextAction": { "url": "https://connecta.example/connect/service?h=...", "purpose": "..." }
}
```

Give that link to the user once, then stop. Do not prompt again, retry, or reach
the service another way until they confirm. If they already refused this
connection in the conversation, only mention that the link is available.
A failed signing or storage step leaves the refusal without a link. Its message
says so: unless the user refused this connection, repeat the request once for a
new link, then give that link to them, and stop if that repeat also fails. Connecta
keeps no record of which clients refuse, so each new prompt to such a client
ends the same way. Three prompts are allowed
within one ten-minute retry window, then `auth_round_limit` ends the flow.
Each state can be consumed once; concurrent or repeated retries are refused
before dispatch. Accept does not mean a browser has opened the link, so every link
in a flow stays live. A `force: true` flow's links, including a refusal's, share one
reset: the first verified visit performs it and later visits continue it. A visit
during a running start returns 409 without spending its link, and says to start a new
connection request if it persists, because a new call is a new flow. A failed start
lets the flow's next visit begin again.
Host-owned invocation facts record the auth failure's origin and entry into
all calls, including each classification, catalog freshness and classification
digest. Raw fetches and custom connector transports cannot establish recovery
eligibility. Each accept retry rechecks all previously entered reads before
restarting a program or direct call. A write classification, changed digest, or
stale catalog returns `auth_replay_refused` and reconciliation guidance.
Each round also checks its own invocation facts. Normal stale-fallback calls
retain their existing behavior.
An auth failure after a write handler or transport was entered keeps its
ordinary error code and manual `/connect` guidance where available. Unless a
maintained provider's complete ledger records an auxiliary resource read and
proves that only auxiliary resource reads and authentication token mints departed,
it also carries `retryable: false` and `reconciliationRequired: true`:
the write may have partially run, so reconcile its target before retrying after
connection. An explicit `writeOutcome: "unknown"` always keeps this guard.

State integrity, expiry, principal, endpoint, and tool failures produce the
SDK's JSON-RPC `-32602` with `data.reason: "invalid_request_state"` before the
handler runs. Changed arguments or code produce a typed `invalid_request_state`
tool failure before dispatch. Retry state grants no access; each request still
passes current identity, pool, connector visibility, and management checks.
Hosts without URL support keep the recovery envelope below, with a `/connect`
URL when this deployment can issue one. Without an interactive provider,
signing vault, or configured public URL, automatic elicitation is unavailable.

`downstream_oauth_required` means the connector needs an OAuth grant.
`auth_required` means its operator-managed credentials or configuration need
repair. Both carry the recovery envelope below. `provider_permission_denied`
means the provider refused a permission or scope; ask its resource owner or
administrator to grant access before retrying. It does not invite a reconnect.

A host rejected before MCP dispatch gets HTTP 401 or 403 with
`error.code: "host_auth_required"`, `recovery: "host_connection"`, and the auth
adapter's original `WWW-Authenticate` challenge. Custom streaming or non-JSON
responses keep their body and expose `Connecta-Error-Code` and
`Connecta-Recovery` headers instead. Repair the host's connecta
connection or endpoint grants. This cannot be fixed by `authorize_connector`.

An OAuth call failure uses this envelope:

```json
{
  "code": "downstream_oauth_required",
  "message": "...",
  "retryable": false,
  "connector": "service",
  "operation": "service.read",
  "recovery": "oauth",
  "authorizationUrl": "https://connecta.example/connect/service?h=...",
  "instructions": "For the person opening this link: sign in as the user who requested this connection; ...",
  "nextAction": {
    "url": "https://connecta.example/connect/service?h=...",
    "purpose": "Give this link to the user, unchanged, then stop. Retry after they confirm."
  },
  "retry": "Retry service.read after the operator completes recovery."
}
```

`recovery` is `oauth`, `operator_config`, or `unavailable`. On hosts without URL
elicitation, auth errors carry the same handoff fields that `authorize_connector`
returns for the admitted user, connector, and pool. Direct calls include them in
`error`; program `connecta.call` failures include them in `error.data` and
`error.details`. Search `catalogErrors` and scoped `queryAnalysis.catalogError`,
and describe `errorDetails`, carry them too. When an auth error includes a
handoff, give it to the user or operator. An error that carries a handoff says
so in `nextAction`, because calling `authorize_connector` would only return the
same thing:

- a link: `{ url, purpose }`, with `url` equal to `authorizationUrl` or `operatorUrl`;
- no link (`unavailable`): `{ action: "contact_operator", purpose }`, with the
  repair in `instructions`;
- after a write of unknown outcome, either `purpose` says to re-read the write's
  target once they confirm, never to retry.

`message` drops its route text the same way. The typed fields are unchanged:
`nextAction` repeats a link, it does not replace `authorizationUrl`, `operatorUrl`,
`credential` or `instructions`. `nextAction` keeps
`{ tool: "authorize_connector", arguments: { connector } }` in two cases: when no
handoff could be attached, as for a request that has no handoff factory or whose
signing failed, and in a program's terminal `write_outcome_unknown`-family result,
which carries no handoff fields and so holds no link. A URL-elicitation host's
call that falls back to a link gets the same `{ url, purpose }`.

The class-specific handoff is:

- `oauth`: an `authorizationUrl` to connecta's `/connect/<connector>?h=...` route
  and instructions to sign in as the initiating user;
- `operator_config`: an `operatorUrl` to the mounted connection UI, plus the
  declared credential label and field names/guidance; or
- `unavailable`: an honest deployment/configuration message.

The class follows what the connector declares, not how it was authored: a
`remoteMcp()` connection using `auth: { type: "credential" }` declares a slot
and no OAuth flow, so it uses `operator_config` when both vault and UI are
configured. Without either it returns `unavailable`, never a dead UI link.

Errors mint at most one handoff per connector per direct call or program run,
including concurrent and repeated call or catalog errors. The request reuses the
same signed URL; a later request can issue a fresh one. Issuing a link is
stateless and starts no consent. Errors never request `force`; use an explicit
`authorize_connector` call for a restart or a fresh expired link. URL-elicitation
hosts keep the existing prompt and retry flow.

The tool accepts no secret and starts no downstream consent. `force` applies
only to OAuth and requests a restart when the verified browser opens the signed
link. That visit may discard the stored grant before restarting consent. Static credential values are written
only through the same-origin interactive-user credential route, and only for a
connector visible to that user with the relevant shared or personal management
permission; Issuing an OAuth link, `force` included, requires that permission too. The
`/connect` visit and callback both verify the same initiating user under Clerk or
Cloudflare Access, including for shared connectors.

Copy `authorizationUrl` exactly as returned. Do not decode or re-encode its opaque,
unpadded base64url handoff token. If the link is invalid or expired, request a fresh link with
`authorize_connector`. The URL expires after fifteen minutes and carries no browser authentication.
A signing credential vault is required; deployments without either interactive provider return `unavailable`
with a clear configuration message. Status reads stay passive and never expose
a downstream authorization-server URL. These routes work without the UI. After OAuth
consent or a human update, retry the original operation; a static update is read
from the vault on the next call and needs no redeploy.

## Routing recovery

Predictable local refusals carry structured recovery on both result modes. An
unknown connector suggests an unscoped discovery query derived from the
attempted tool name; an unknown tool scopes the same query to the connector that
answered. The suggested route follows the route the caller took:
`tool: "search_tools"` for a top-level call, `function: "connecta.search"` with
the same arguments when the miss happened inside `execute_code`, which has no
way to call a tool. On a writable endpoint, `call_tool` reaching an unannotated,
write-capable, or destructive tool returns `destructive_tool_requires_approval`
with `nextAction` for `call_destructive_tool` and the canonical address. On a
read-only endpoint every write path returns `read_only_endpoint` with no
`nextAction`. Its message says no write route exists, not to try another route,
to tell the user, and that only the operator can provide a writable connection.
Nothing is executed by these records.

`connecta.describe` keeps its failures inline instead, so one miss cannot
discard the other schemas; each failed entry carries a human `error`, typed
`errorDetails`, the same route-aware discovery action, and — on a close
tool-name miss against a known connector — at most three deterministically
ranked canonical `suggestions` with no scores and no descriptions. A
catalog-load failure carries only `code`, bounded `message`, `retryable`, and
any `retryAfterMs`: discovery does not inherit later additions to the
call-failure envelope. The per-entry rules are
[code mode](./code-mode.md#connectadescribe)'s `S4`.

### Echo budgets

An error envelope is not size-guarded the way a result is, and every echoed byte
lands twice — in the text content and in `structuredContent` — so a 50 KB
invented address once produced a 200 KB refusal against a 1 KB result cap. Every
caller-authored string a refusal repeats therefore gets 512 UTF-8 bytes, and
what happens over budget differs by field.

| Field                                                                         | Over 512 UTF-8 bytes                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `args` on `call_tool` and `connecta.call`                                     | dropped whole; `purpose` says to re-send what was just sent |
| the attempted address                                                         | clamped with a trailing `…`                                 |
| unknown `connecta.result(id)`, `authorize_connector.connector`, `skills.name` | clamped the same way                                        |
| `search_tools.connector`                                                      | rejected with `invalid_args` before catalog lookup          |

Arguments are schema-filtered before budgeting. `writeOnly: true` values are
omitted at any depth, including array items and prefixes, local `$ref`/`$defs`,
and `allOf`. `oneOf`/`anyOf` alternatives must agree on sensitivity. Unresolved
or remote references, sensitive `patternProperties`/`additionalProperties`
schemas, unsupported sensitivity rules, and traversal limits omit the entire
echo. A private array element omits its containing array to keep indices intact.
`argsRedacted: true` marks partial or withheld echoes. Use them only to identify
the target for reconciliation; any new call requires the original arguments.
The filtered snapshot is never clipped: over-budget arguments are dropped whole.
The address gets the opposite rule
because it is the thing being corrected: a clipped one still identifies the
mistake, and a short one — every real one — comes back exact and untagged. A
scope is rejected outright because a clipped one could select a different
connector. A failed result-storage read returns typed `unavailable` without
exposing backend error text.
Submitted `writeOnly` values also enter the call's sent-secret output redaction
set, including property names inside private object subtrees. Downstream
result and error text quoting them, in raw or credential-supported encoded
forms, or any run of eight consecutive units of one, is redacted before
direct-call output, program returns, logs, and emits, or result stash
persistence; paging in a later request reads already-redacted bytes. A
program's `connecta.read` resources, connector usage guides, and downstream
`connecta.skill` files take the same rules before the program sees them. JSON
stays valid: a matching number or boolean becomes `"[redacted]"`. Empty private
strings are exempt. A private value of one to three characters is withheld only
where a whole string, property name, number, or boolean equals it; one of four
to seven characters is also replaced wherever it occurs in result and error
text. Typed classification, retry facts, and write outcome remain.
Work limits withhold the affected text without failing the call. See
[output redaction](./auth.md#what-a-servers-errors-may-say)
for the shared encoding, budget, and argument-filter contract.

Activity records each of these refusals with the coarse `friction` class derived
from its typed error code — `tool_not_found`, `schema_retry`,
`destructive_reroute`, `auth_required` — and clamps the caller-authored
`connectorId`, `toolName`, and `address` it keeps, both under
[code mode](./code-mode.md#activity)'s `V2` and `V3`. Optional
[operation history](./operator-ui.md#opt-in-to-operation-history) records
search, skill and result reads with fixed names, without arguments or payloads;
it is off by default and separate from downstream-call counts. A `call_tool` result too
large to return inline is the one exception: it is friction
(`result_too_large`) on a call whose `outcome` is still `"success"`, so it
carries no `errorCode`.

Recovery actions outside the tool namespace use `nextAction.action` and a
`purpose`: `reconnect_host` repairs inbound HTTP authentication (separate from
connector OAuth), `contact_operator` reports catalog or utility availability,
`inspect_capabilities` requests a supporting client/operation, and
`recover_result` requests a retained handle or an honest missing-output report.
Unsupported task, Skills, and resource capabilities use the non-retryable
`unsupported_capability` code with `inspect_capabilities`. Missing or expired handles have `code: not_found`; storage outages retain
`code: unavailable`. Neither action authorizes anything or replays writes.
Unknown skill names and connectors without a guide retain their local lookup
diagnostic with `code: not_found` and a `nextAction` calling `skills` with no
name to discover available names. They do not request service restoration.
The server's search page contract states action discriminators compactly; action
advice is additive, while catalog error and authorization handoff fields retain
their detailed contracts.
A spent read continuation's fresh-call action takes precedence over generic
retry advice, while auth and provider permission repair prerequisites and unknown-write reconciliation remain
in force. HTTP 401/403 responses preserve the adapter status and challenge. JSON responses
carry the host recovery envelope. Custom non-JSON responses preserve their body
and lifetime, with the same typed facts in `Connecta-Error-Code`,
`Connecta-Recovery`, and JSON-encoded `Connecta-Next-Action` headers (also exposed
to cross-origin hosts).

## Recovery limits

Typed `invalid_args` failures without validation findings point to scoped schema
inspection. `not_found` asks the caller to verify the resource id, account and
visibility. `unavailable` asks the operator to restore connector availability.
These use `nextAction` for an executable action and `retry` for explicit limits.
An uncertain write has no safe replay action: read its target to reconcile its
outcome before deciding on any fresh operation. Host authentication requires
reconnecting the host; downstream authorization handoffs repair credentials;
provider permission denial requires the resource owner to grant access.

## Argument recovery

Standard API hatches refuse marker containment in request paths and query
keys/values. Body fields and named kit writes refuse whole `[redacted]` values
(including decoded spellings) and withheld links, before sending. Longer prose
such as `the log says [redacted]` is allowed. Obtain the original value/link or
omit its field: do not copy `{ "token": "[redacted]" }` from a read into a write.
These rules check agent arguments; a body composed later from internal reads
is not rescanned as a whole. Legacy tools and remote MCP keep their own rules.

Pass signed hatch and named-list cursors back unchanged. They authenticate the
continuation and bind its connection, personal owner and arguments; hatch
search/details cursors also bind the index content.
When the connection acts as a different downstream identity per caller, the
signature also binds the admitted caller and pool owner. These identities are
not included in the readable cursor. Fixed shared identities keep the shared
binding. For example, a cursor issued to `alice` on a caller-mapped connection
is refused when `bob` presents it, before any downstream request. An altered cursor
or changed scope/index is `invalid_args`. Start discovery again after that
refusal. Cursors survive restarts with persistent storage. A signing-key load failure is retryable `unavailable`; operators can follow [cursor-key recovery](./deploying.md#recover-a-cursor-signing-key).

A remote MCP tool's advertised `inputSchema` is checked in the shared invocation
path before admission and provider dispatch, so a mismatch is the non-retryable
`invalid_args` identically on `call_tool`, `call_destructive_tool`,
generated-code failures, and rejected promises. The error names the connector and
operation and carries one recovery envelope, `validation`:

```json
{
  "issues": [
    { "path": "/limit", "expected": "at least 5", "received": "4" },
    { "path": "/mode", "expected": "one of \"fast\", \"safe\"", "received": "string" },
    { "path": "/<key>", "expected": "one of the accepted keys: mode, limit" }
  ],
  "acceptedKeys": ["mode", "limit"],
  "example": { "mode": "fast", "limit": 5 }
}
```

Every finding is listed, and the message repeats them, so one corrected call
fixes them all.

A refusal contains only names and literals the published schema declares at
non-sensitive positions, numbers allowed by the bound rule below, and fixed
placeholder text. It never contains a submitted string or object key, in the
message, a finding, `acceptedKeys` or the example. A position is sensitive when
it or an ancestor is `writeOnly`; a named tool's input schema marks each request
secret that way. API hatch findings name only the operation contract's
properties and enum members, as `*_api_details` publishes them.

- `path` is a JSON Pointer naming declared properties and array indices. The
  first key the schema does not declare (a misspelled argument, a map key)
  reads `<key>` and ends the path, e.g. `/headers/<key>`.
- `expected` states the constraint that failed, then every other constraint
  the position declares: bounds, property and item counts, `multipleOf`,
  `pattern`, `format`, `uniqueItems`, enum members, `dependentRequired`
  (`string (required with tags)`). A sensitive position never renders an enum,
  `const` or pattern literal. Each position gets one finding.
- `received` is the submitted JSON type, `missing`, or, for a numeric bound at
  a non-sensitive position of a named tool, the submitted number.

At most eight findings are returned, each field clipped (path and expected 256
characters, received 64), and `truncated: true` says something was omitted or
clipped.

`example` is one valid call synthesized from the published schema and checked
against the same validator. It never copies a submitted value, and a sensitive
position never renders a schema literal (`enum`, `const`, `default`,
`examples`). Complex or unsatisfiable schemas get `exampleUnavailable` instead.
Synthesis detects recursive references and shares a 128-node work budget.
Invocation uses only this schema example, never a connector's copy of the
call, unless the connector states `exampleUnavailable`. API hatches
(`*_api_read`, `*_api_write`) always do: their generic schema says nothing
about an operation's arguments, so the reason points to the operation's
`*_api_details`.

`acceptedKeys` names the tool's top-level arguments. `conditionalRequirements`
lists known `dependentRequired` and `dependentSchemas` requirements by
property name; `if`/`then`/`else` conditions are schema subtrees and are not
rendered. The envelope has a 4 KiB budget:
optional detail, then the example, then trailing findings are dropped whole,
with `truncated: true`. A `repair` object a custom connector passes contributes
its received types and schema facts. A custom connector's own findings must
follow the same rule. Operator records contain only checked failure facts,
never findings or examples.

When `issues` and `acceptedKeys` are present and nothing was truncated, the
findings name the fix, so the envelope has no `nextAction` and `retry` leads.
Otherwise `nextAction` points to discovery scoped to the same connector and tool
name, with the purpose "Only if the validation above is not enough: inspect the
schema.", routed like any other miss: a program to `connecta.search`, a top-level
call to `search_tools`. `example` is synthesized from the published schema and
checked against its validator; a plain required string reads as a named
placeholder such as `"<id>"` rather than an empty string, which would pass local
validation and reach the downstream. A schema that refuses the placeholder, and a
`writeOnly` position, keep the plain sample. `retry` says to correct
the listed arguments and reissue the original operation. What the local
validator declines to evaluate is [code mode](./code-mode.md#errors)'s `E8`.

Earlier releases returned `validation.issues[].code` (the schema keyword)
and a separate `repair` object. Both are gone from responses; a custom
connector may still pass `code` and `repair` to `ConnectorCallError`, which
folds `repair` into `validation`.

Unknown-address errors list `configuredConnectors` from the current endpoint's
scoped registry, including an empty list when none are accessible. They never
list connectors from another pool or identity's grants.

An `unknown_tool` error from a direct call or a program carries `suggestions`
when the connector has a tool with a near name: canonical addresses ranked as
describe ranks them, and only reads on a read-only endpoint or connector.

A direct call whose arguments do not match `call_tool` or `call_destructive_tool`
fails input validation before anything is resolved. The message names the shape:
`Send { address, args }`, with the tool's own arguments inside `args`. Neither
tool accepts MCP's `name` or `arguments` keys.

A write that times out after dispatch without complete auxiliary-only proof
returns `write_outcome_unknown` with
`retryable: false` and an agent-only `uncertainCall: { address, args?, argsOmitted?, argsRedacted?, recovery? }`.
An auxiliary-only timeout reported by a completed maintained-provider call keeps
its `timeout` verdict under the rule below.
No write is automatically replayed. `recovery` carries facts the connector
recorded before dispatch, such as a REST connector's
generated or caller-supplied `idempotencyKey`. A caller-supplied key that is
empty once leading and trailing whitespace is removed is refused with
`invalid_args` before dispatch and never recorded: fetch would send it empty,
which is no key. Recovery accepts keys up to 255
characters, matching the REST write schema. Other recovery values remain capped
at 128 characters, with at most four facts per call and camelCase names of at
most 32 characters. Values outside these bounds are dropped whole. A recovery
key is a diagnostic. Only when the call sent exactly one write, carrying that
key, through the one connector it entered does `retry` add that a deliberate
retry that reuses the key with the exact original arguments cannot repeat the
write while the vendor retains the key
(Stripe may prune v1 keys after 24 hours). After that, look the object up before
retrying. The advice needs one boundary that owns the call and exactly one
dispatched write carrying the key; GET and HEAD reads beside it do not count.
A second write, a write the key did not travel on, or a connector that wraps
another or enters more than one boundary never gets it, since reusing the key
would protect that request alone. A key generated but never sent (a write
refused before dispatch, such as one with no configured credential) stays in
the message as a diagnostic, with no reuse advice, direct or served. When a connector recorded such facts, any other dispatched write whose
outcome is unknown (a lost response body, a 5xx) also carries `uncertainCall`
with them under its own code, and program write accounting keeps it. `args` may be partial reconciliation context
with `argsRedacted: true`. A withheld echo or arguments over the 512-byte budget
carry `argsOmitted: true`; sensitive or unresolved schemas also carry
`argsRedacted: true`. When `args` is absent or redacted, use the original
arguments if reconciliation requires another call. A timeout before dispatch remains `timeout`.
A connector's `callTool` called directly from code, outside an invocation, has
no such boundary: a write that may have been dispatched and then timed out
(an SDK deadline or HTTP 408 included) keeps its code and timeout
`details.code`, and is `retryable: false` with `writeOutcome: "unknown"`. A
write the caller's own signal aborted after it may have been dispatched is
the same: `timeout` when the reason is one (`AbortSignal.timeout`), else
`connector_call_failed`, with the caller's reason as its `cause` (a redacted
copy of the same class where the connector's output redaction applies, as on
`remoteMcp()`) and the reason's class and code in `details` (`{ name: "TimeoutError", code:
"timeout" }`). Only an idempotency key the vendor receives keeps such a direct
write's retry advice: a key that is blank once trimmed, or that holds a
character fetch cannot send in a header, is refused as `invalid_args`. A
direct read's timeout stays retryable, and a direct read's own abort reason is
rethrown unchanged.
Program write accounting keeps this detail even if the guest catches the
failure or returns early. Multiple uncertain writes use `uncertainCalls`,
bounded to ten calls with `uncertainCallsTruncated` when more exist.

A dispatched write is never reported as retryable once the downstream may
have acted on it (INV-9). A failed maintained-provider write call whose complete
request ledger records an auxiliary resource read and proves that no call-owned
request or kit auxiliary falsely declared as a read departed keeps the failure's retry advice and needs no write
reconciliation. For example, a Gmail connector named `mail` can fail
`mail.update_draft` during its auxiliary draft lookup before sending the update;
its authorization handoff then says to retry after recovery. The same rule applies
to a timeout reported by that completed call. An explicit `writeOutcome: "unknown"`
always takes precedence. A kit request declared `effect: "read"` that uses POST
or a method-overridden GET blocks this inference even alongside an auxiliary read,
while retaining core write reservation and replay rules. Authentication token mints
supply no resource-read proof but do not invalidate a later auxiliary resource read.
Empty, absent or incomplete ledgers, invocation deadlines and caller
cancellation without a complete answer retain conservative write outcomes.
Custom `api()` and `remoteMcp()` connectors always stay conservative: the internal
complete-tracking declaration is available only to maintained providers.
A 5xx (a gateway's 502 to 504 included), any
network failure of its send (a refused connection included), or a reply that
broke off is a non-retryable `connector_call_failed` whose outcome is unknown,
from `remoteMcp()`, `api()` handlers, and the maintained providers alike;
reads keep their retryable verdict. One send can hide several attempts:
Node's fetch sends a request again after HTTP 421 and after an HTTP/2
`REFUSED_STREAM`, both of which servers define as not processed, and an
operator-installed dispatcher such as undici's `RetryAgent` can retry further,
so a refusal on the last attempt says nothing about the earlier ones.
Connecta therefore never reports a transport-failed write as known failed. A
write stays a known failure, with its own advice, only on refusal provenance
recorded where the evidence was observed: connecta refused it before it left,
or the downstream served an HTTP refusal, a 4xx other than 408 that its
provider reads as a refusal. A 408 is a timeout, and a refusing status the
provider reads as `unavailable` or a timeout (Stripe's 424) does not prove the
write unapplied, so a keyless Stripe write answered 424 is unknown. An error
code is never that evidence by itself. A `rate_limited`,
`invalid_args`, or any other code thrown after a 2xx (by a response mapper,
a parser, or an output-schema check) or after a 408, and any JSON-RPC error a
`remoteMcp()` server returns once the `tools/call` was sent (`-32602`
included: a server can run the tool and then reject its own result), keeps
its code and message for diagnostics but is `retryable: false` with
`writeOutcome: "unknown"`, on a direct and a served call alike, and counts in
a program's `writes.unknown`. An HTTP refusal of the call's own write stays
known only under the refusal rules above and a complete ledger proving the
refusal covers the whole call; its recovery advice and program accounting both
report failure. A `remoteMcp()` write answered with a 4xx (other than 401, 403,
408 or 429) whose body is not a JSON-RPC error is unknown, never a refusal: a
gateway may have answered after the server acted. Partial or unknown ledgers remain conservative. An auth failure after entering a write with
no call-owned dispatch reports an unknown outcome and requires reconciliation,
including credential refusals, static-OAuth refresh failures, and `remoteMcp()`
connect or initialize 401s before `tools/call`. A non-auth refusal before
`tools/call` is sent stays known. A custom connector can show no such
provenance: a served write whose
`callTool` throws after it was entered is `retryable: false` with
`writeOutcome: "unknown"` whatever its code, and gets no retry advice
(neither "grant the permission, then retry" nor "correct the arguments and
retry"). That includes a refusal it rethrows from a call it made to another
connector: refusal evidence holds only for the whole call, so a custom
connector that deletes one Stripe customer and is then refused 429 on a
second reports the unknown outcome. A served write whose downstream MCP tool
answers `isError` came back over a 2xx after the tool ran, so it is unknown
too, with its text kept; a read's `isError` stays a known answer. No text on
an unknown write says to retry it: a rate limit's or overload's wait-and-retry
wording is dropped from its message, and an authorization or credential
handoff (`instructions`) says to re-read the target before any fresh call
instead of to retry the original call. A read, and a write with a known
outcome, keep that advice. A failure during a composite
call's later request leaves earlier requests' outcomes unknown, and once the
call's outcome is decided, a request that had not left is never sent. A
write the downstream answered with HTTP 401 has an unknown outcome, since a
server may act on a request before it rejects the credential, and is never
resent. It is never retryable and carries no wait. Until the credential is
renewed, the failure keeps its authorization code (`auth_required`, or
`downstream_oauth_required` for an OAuth connector) with
`writeOutcome: "unknown"`, `reconciliationRequired: true`, and the
authorization handoff, whose `instructions` and `nextAction` say to authorize and then
re-read the target before any fresh call. That holds whatever renewal meets: a
refused or unreachable token endpoint, a disconnect, or the caller leaving. It
also holds whatever the call met after the 401: a body past the response
ceiling, a later failure in the same call, a 401 on a later request of a
composite write, a 401 answered inside another connector the call reached
(an `api()` or `remoteMcp()` connector, through a custom connector or a
program), or the call's deadline or the caller's cancellation cutting the
write off after the 401: the result is that verdict, not
`write_outcome_unknown`. Nor can such a call succeed: a handler that caught
the 401 and returned, or a result that could not be processed, still ends
in that verdict, and a program counts the write in `writes.unknown`. An
idempotency key never makes such a write repeatable, so it gets no
key-reuse advice. Once every such 401 is renewed
the handoff goes, but the call stays unknown, even if its handler caught
the failure and returned a result: renewal does not prove whether the write
took effect. A caught read 401, or a declared refusal followed by a successful
write, does not prevent the call from succeeding. A read needs positive
operation or tool classification and a recorded GET or HEAD; the method
alone is insufficient. Breeze GET writes and requests carrying
`X-HTTP-Method-Override`, `X-HTTP-Method` or `X-Method-Override` remain writes,
even when a handler catches their 401 and returns.
Once renewal succeeds (an OAuth refresh), nothing is left
to authorize: the call reports a non-retryable `connector_call_failed` with
the unknown outcome, and the renewed credential serves any fresh call after
the target is reconciled. Renewal succeeds only when it yields a different
credential than the one the write sent: a refresh or login that hands back
the rejected token, or an earlier recovery in the same request, renews
nothing, and the write keeps its handoff. Google Workspace renews on the next call, so its
write keeps the authorization code and handoff. A write answered 401 is a
known refusal only where its provider has reviewed vendor documentation that
the vendor authenticates a request before acting on it. Among the maintained
providers that is Stripe with an API key, for an API v1 answer that carries
Stripe's `Request-Id`, since Stripe documents that an invalid API key is an
error that occurs before execution begins. A read answered 401 keeps its
refusal, and its handoff says to retry the original call.
A `remoteMcp()` write answered with a redirect is not sent to the new location,
whatever the connector's `redirects` setting, and reports the unknown outcome;
reads follow same-origin redirects as configured. An error whose write outcome
is unknown carries `writeOutcome: "unknown"` unless its code is already
`write_outcome_unknown`, and a program that sent the write fails with it counted
in `writes.unknown` even when the program caught the failure. When that write
met an authorization verdict, the program's error is that verdict, as a direct
call reports it: its code, `connector`, `recovery`, and `nextAction`, with
`writeOutcome: "unknown"` and `reconciliationRequired: true`. Any other unknown
write makes it `write_outcome_unknown`. Either error's `unknownWrites` lists at
most ten such writes with their `address`, `code` and redacted `message`, and
`unknownWritesTruncated` marks a write left out or a message dropped. A write whose
tool answered `isError` carries `toolAnswered: true`, on a direct call too: its
message is the tool's own words, up to 4,096 UTF-8 bytes, cut only between tokens
and marked `… [truncated]`. Its outcome stays unknown because its handler ran before
it answered, and `retry` says to check the target and to give the user any approval
link or request id. A program's `write_outcome_unknown` leads its `message` with
those words instead of repeating them in the entry. A later call the tool's words
ask for, such as one carrying a provider's approval token, is a new deliberate call.

The classification served for the call decides this advice, including deployment
`classification` overrides. For example, `classification: { crm: { get_person:
"write" } }` makes a dispatched `crm.get_person` that receives HTTP 503 report
`retryable: false` and `writeOutcome: "unknown"`, even if its request uses GET.
A served read keeps the provider's read retry advice even if its request uses
POST. Tool defaults and HTTP methods supply a fallback only when no served
classification exists. A vendor idempotency key does not change an uncertain
served write into retry advice; its recovery facts still help reconcile the
target before any fresh call. An operation hint (a whole-resource `PUT`,
fixed spreadsheet cells, a content-addressed upload) grants no retry credit on
any call, direct or served: only an idempotency key the vendor honors, which is
Stripe's today, keeps a direct write's retry advice.

Retryability comes from typed errors, HTTP status, registered OAuth error codes,
SDK timeout classes, and runtime network codes. Untyped prose is non-retryable:
"timeout", "temporarily unavailable", "rate limit", or "503" in a body, tool
name, or URL never changes the verdict. JSON-RPC `ProtocolError.data` is dropped
at the downstream boundary, even when the agent may see the error's message.

## Native tool surface

A pool set to `surface: "native"` lists each downstream tool as its own MCP
tool instead of the six meta-tools, for clients that already defer tools behind
their own search (Eve, Claude Code with tool search). The meta surface stays
the default everywhere. Plain `/mcp` is always meta for a maintainer; a person
routed there by their one pool membership gets that pool's surface.

```ts
pools: {
  assistant: { tools: ["crm", "tickets"], members: ["agent:assistant"], surface: "native" },
  assistant_lean: { tools: ["crm"], members: ["agent:assistant"], surface: "native", executeCode: false },
}
```

`executeCode: false` is valid only with `surface: "native"`; construction
refuses it otherwise, and refuses any `surface` other than `"meta"` or
`"native"`. Both pool endpoints, `/mcp/<pool>` and `/agent/<pool>`, serve the
pool's surface.

| A native pool lists          | Shape                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each visible downstream tool | A read is `<connector>__<tool>`, a write `<connector>__WRITE__<tool>`; object input constraints and local references preserved; no `outputSchema`; `_meta["dev.connecta/address"]` is its address |
| `execute_code`               | Unless `executeCode: false`. Each downstream tool's description then ends with `Program address: <connector>.<tool>`, the address `connecta.call` takes                                           |
| `read_result`                | Only with `executeCode: false`: `{ id, offset?, page?, maxBytes? }` pages a stashed result exactly as `connecta.result` does, with the same bindings and rechecks                                 |
| `authorize_connector`        | Always; requests the existing typed authorization handoff for a granted connector                                                                                                                 |
| `skills`                     | Always                                                                                                                                                                                            |

`search_tools`, `call_tool`, and `call_destructive_tool` are not listed. Auth failures still carry their handoff in the error envelope.

Native tool descriptions append `Guide: skills <name>` when their connector has
guidance. Call `skills` with `{name:"<name>"}` to read it. The name is the same
allocated readable name listed by `skills`, including collision suffixes; a
name reserved for a built-in guide uses its canonical connector skill URI. This
compact pointer repeats on each tool so host search results retain it; connectors
without guides add nothing. It depends only on the admitted connector roster.

**Names.** A name is a pure function of the connector id, the downstream tool
name and its served classification, so it survives catalog refreshes until the
classification changes. A read is `<connector>__<tool>` and a write
`<connector>__WRITE__<tool>` when the tool name uses only `[A-Za-z0-9_-]`,
contains no `__`, does not start with `_`, and the whole name fits 48 characters.
Otherwise a read is that name's head plus `_` and the first six hex digits of the
SHA-256 of `<connector>.<tool>`, and a write is up to 24 characters of the
connector, `__WRITE__`, the head of the tool name, `_w` and the same six hex
digits. A write whose plain name would end in `_` and six lowercase hex digits,
such as a tool named `get_373b87` or `facade`, also takes this hashed form. A
connector id that does not start with a letter is prefixed with `C`. 48 characters
leave room for a client's own prefix under common 64-character tool-name limits
(Eve's `connecta__`, Claude Code's `mcp__connecta__`).

A name a client holds for a read can never select a write. Every write's name
contains `__WRITE__` and never ends in `_` and six lowercase hex digits. A read's
name contains `__WRITE__` only when the tool's own name supplies it, and such a read
is always hashed, so it ends that way and takes the read route. A tool's read name
does not depend on its classification or on this rule, so names clients cached from
earlier versions stay read names. Two tools that would share either name are both
left out of the list, with an operator warning, and a call by either of their names
is refused; both stay callable by address in `execute_code`.

Read a tool's name from `tools/list` rather than building it. Host approval rules,
allowlists, prompts and recipes that name a native write must use its `__WRITE__`
name, and a tool that changes classification changes name. Programs keep using the
address, which never changes.

**Annotations** come from the served classification only: a read is
`{ readOnlyHint: true, destructiveHint: false, openWorldHint: true }` and a
write `{ readOnlyHint: false, destructiveHint: true, openWorldHint: true }`,
whatever hints the downstream declared. A deployment `"read"` override never
produces read annotations for a tool whose source explicitly declares a write;
`"read-repeatable"` does, and accepts that a host may repeat the call. See
[deployment overrides](./integrating.md#another-remote-mcp-server). A read-only endpoint or connector
leaves write tools out of the list, by the same rule search and describe use.

**Calls take the existing paths.** A name selects its route: a read's name is the
`call_tool` call for its address, and a write's name is the
`call_destructive_tool` call, run by the same handler. So classification,
`read_only_endpoint` refusal, argument validation and repair, admission, redaction,
single-attempt writes, auth elicitation, downstream input, result caps, and activity
use the same enforcement. Activity records source `native` with the canonical
address and served classification. Unknown or ambiguous names fail with
`unknown_tool`; catalog failures retain their handoff. Success results are
`call_tool`'s default mode: native `content`, never `structuredContent`, which
is why no `outputSchema` is advertised. A truncated result's notice pages with
`connecta.result` inside `execute_code`, or with `read_result` on a pool without
`execute_code`.

**Approval is the host's, enforcement is Connecta's.** The host approves from
the annotations of the list it cached, and some hosts resend calls they believe
are read-only when a connection fails. Those resends are new stateless requests:
their JSON-RPC ids restart and they carry no session id, so Connecta cannot tell
them from new calls. A name is therefore bound to its classification. If a tool
changes from read to write between that list and a call (a downstream changes its
hints, or the deployment changes its classification), the cached read name takes
the `call_tool` route, which refuses before dispatch: `read_only_endpoint` on a
read-only endpoint, otherwise `destructive_tool_requires_approval` with
`nextAction.tool` set to the write's name. However often the host resends, nothing
reaches the downstream. The write runs only by its own name, annotated destructive, after a refreshed
list; Claude Code 2.1.318 and Codex 0.166.0 did not resend destructive calls when
tested. In the other direction, a cached
write name whose tool is now a read still runs, once, on the
`call_destructive_tool` route. A native `tools/list` carries a 300-second private
cache hint, against an hour on meta endpoints; hosts need not honor it. A listing
that omits a connector or lists one stale carries 60 seconds instead, about when
that connector is next asked.

The verdict is Connecta's current catalog: a downstream change takes effect when
Connecta's catalog next loads it. A tool whose source declares a write and whose
deployment classification overrides it to read has a read's name and takes the
`call_tool` route, and a host may resend it; do not override a write to read unless
repeating it is harmless. This also applies to `call_tool` on the meta surface.

**Known limit: a change Connecta has not seen.** Connecta enforces the catalog it
holds. A vendor can change a tool from read to write before Connecta's catalog
refreshes, and until then every read-annotated route treats that tool as a read:
`call_tool`, a read-annotated native tool and programs on a read-only endpoint. A
host may also resend such a call after a connection failure, so the vendor can
receive it more than once. The catalog refresh closes this window, and nothing
closes it sooner.

**Listing.** `tools/list` is one page with no cursor (Eve's MCP client reads only the
first page). A pool listing more than 1,000 tools fails `tools/list` with a
JSON-RPC error asking the operator to narrow the pool; nothing is silently
dropped. A connector that does not answer in time, is `unavailable` or
`rate_limited`, or hits a retryable downstream failure stays listed from its last
complete catalog, under the same limit and partitioning as
[stale listings](#lexical-discovery). Such a connector gets the 5-second deadline, or
`discovery.probeTimeoutMs` when shorter, and is skipped for up to 60 seconds after
a failure; one with nothing to fall back on keeps the full deadline. Each of its
tools carries `_meta["dev.connecta/stale"]` with `code`, `ageMs` and any
`retryAfterMs`, and `readOnlyHint: false, destructiveHint: true` whatever its stored
classification, because an old catalog cannot vouch for a read (INV-1). The `skills`
tool's `dev.connecta/surface` metadata names these connectors in `staleCatalogs`. A
`tools/call` always resolves a live catalog, under the verdict it finds.

A connector whose catalog cannot load and has no stale catalog, or that fails
for authorization, permission or a malformed catalog, is left out of that listing
whole, never partially, with an operator warning and a `catalogErrors` entry in the
same metadata; its tools return with the next listing that loads it. Listing never
starts authorization. The server still declares `tools.listChanged: false`.

**Instructions** replace the meta routing text: call one known operation
directly; with `execute_code`, combine several using each tool's `Program address`;
state the endpoint's write policy; on a writable endpoint, never resend a write to
see its output; follow `nextAction` on errors and truncated results. A pool
`description` is placed first, as on meta endpoints.

**Recovery.** `authorize_connector` remains listed even when a catalog fails.
Its description lists all granted connector ids independently of catalog health.
Use it for a missing connector, then refresh the host tool list after repair.
Endpoint instructions carry the same recovery rule for hosts that fetch them
separately. A cached list retains the recovery tool; a refreshed list restores
the repaired connector’s whole catalog.

Repair and validation fields retain the exact constraint details.
Discovery `nextAction` points to the host's tool search (`host: "search"`), with
only a `query` argument. Retry actions and retry text name the native tool,
never a meta wrapper; a program on a native pool sees the same native wording
in a failure it catches. An unknown name is reported as sent. Auth actions carry the link as `nextAction.url`,
beside `authorizationUrl` or `operatorUrl`; give it and the instructions to the user or operator. Capable modern
clients may resume native auth and downstream form/URL input with the same
wire name, arguments and returned `requestState`. Changed names, targets or
arguments, expired state and spent retry nonces are refused. Never resend a
write to recover output. A refusal of a stale read name says nothing was sent:
refresh the host's tool list and call the write's own name only if the write is
still wanted.

**Schemas.** Ordinary `type: "object"` schemas are byte-identical. Object
constraints without a top-level type, composed object schemas and local
`$defs`/`$ref` keep their constraints with `type: "object"` at the root. A schema
that cannot be represented as object arguments omits its connector whole from
that listing, with an operator warning naming the connector and tool. Other
connectors remain listed. Correct the schema or use the meta surface.

**Diagnostics.** `connecta doctor --pool assistant` recognizes the configured
surface and code setting from the local `skills` tool's
`_meta["dev.connecta/surface"]`. It checks the required local tools, fails on
unavailable connector catalogs, listing-cap errors and connectors listed stale
(`Native discovery degraded`), and runs only a constant
program when code is enabled. It never dispatches a downstream tool. The
metadata's `catalogErrors` exposes this request's failing connector ids,
including connectors with unrepresentable schemas, to every client of the pool.
Connector ids already appear in native tool names. The
operator UI and `describeConfig()` show every pool's effective `surface` and
`executeCode` as facts from deployment code. Change these settings in code.

Keep native pools bounded. Local real-Eve validation uses seeded catalogs from
40 through 1,000 downstream tools across meta, native and native-plus-code
surfaces, with a deterministic model transport and no paid model calls. These
checks establish local runtime contracts; model task quality and large
production catalogs near the cap remain unmeasured.

### Eve agents

Starting with 0.35.0, the Eve helper ships separately as `@zackbart/connecta-eve`.
Connecta core supplies the native pool surface and has no Eve dependency.
Consult that package's documentation for its compatibility and setup. The helper
composes its Eve-specific guidance from [endpoint facts](#endpoint-facts) and
places it before the server's own instructions; Connecta's text stays host-neutral.

## Endpoint facts

`server/discover` and `initialize` both advertise the endpoint in
`capabilities.extensions["dev.connecta/endpoint"]`, so a client composing its
own guidance can read what this request reached:

```json
{
  "surface": "meta",
  "executeCode": true,
  "executeReadCode": true,
  "readOnly": false,
  "connectors": [
    { "id": "crm", "title": "Customer records", "readFirst": "connector:crm" },
    { "id": "tickets" },
    { "id": "warehouse", "unlisted": true }
  ]
}
```

| Field                    | Meaning                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `surface`                | `"meta"` or `"native"`: the surface this request is served                                                                   |
| `executeCode`            | Whether `execute_code` is listed. Always `true` on meta                                                                      |
| `executeReadCode`        | Whether `execute_read_code` is listed ([read programs](#read-programs)). Always `false` on native                            |
| `readOnly`               | The effective policy: the endpoint is read-only, or every connector it reaches is. `false` on a read-only pool with `writes` |
| `connectors[].id`        | Each canonical connector id the caller's scope reaches, in registry order                                                    |
| `connectors[].title`     | Present only when the title says more than the id; normalized and capped as in the [inventory](#discovery-context)           |
| `connectors[].readFirst` | Present only for a required guide: the name to pass to `skills`                                                              |
| `connectors[].unlisted`  | `true` only for a connector the pool's `unlisted` names: keep it off the model's roster. It stays callable                   |

The facts come from the admitted scope and deployment code, never from request
arguments or `_meta`: a person on plain `/mcp` sees their one pool's connectors,
a maintainer sees the whole catalog, and a refused caller gets the usual 404
with no facts. The roster is the one `execute_code`'s inventory describes for
the same caller, without its byte cap. Reading it loads no catalog, probes no
credential, and records no activity. It says nothing about connector health or
authorization, and grants nothing.

A client that does not recognize the extension ignores it. An older server omits
it; treat the surface as unknown rather than assuming one.

## Contributor reference

### Source and tests

Handlers and schemas live in [meta-tools.ts](https://github.com/zackbart/connecta/blob/main/src/meta-tools.ts).
[Catalog service](https://github.com/zackbart/connecta/blob/main/src/catalog-service.ts)
and [invocation](https://github.com/zackbart/connecta/blob/main/src/invocation.ts)
serve both direct tools and programs. [Skills](https://github.com/zackbart/connecta/blob/main/src/skills.ts)
owns the supplied usage instructions, each endpoint's instructions
(`endpointInstructions`), and connector guides. The native surface's names,
listing, and call translation live in
[native-tools.ts](https://github.com/zackbart/connecta/blob/main/src/native-tools.ts).
[result-preview.ts](https://github.com/zackbart/connecta/blob/main/src/result-preview.ts)
owns the rule behind previews of reads over the cap, as pure functions of redacted text.

[Schema tests](https://github.com/zackbart/connecta/blob/main/test/meta-tool-schemas.test.ts),
[search tests](https://github.com/zackbart/connecta/blob/main/test/meta-tools-search.test.ts),
[call tests](https://github.com/zackbart/connecta/blob/main/test/meta-tools-call.test.ts),
[skills tests](https://github.com/zackbart/connecta/blob/main/test/skills-extension.test.ts),
and [native surface tests](https://github.com/zackbart/connecta/blob/main/test/native-tools.test.ts)
check the published contract. Guest parity and clause evidence are in
[code-mode verification](./code-mode.md#verification).

### Skills conformance (contributor)

On 2026-11-03, the official [conformance runner](https://github.com/modelcontextprotocol/conformance)
at `c37eec888e1c6ff140af79987a40008548b7cc5f` passed enumeration (32 checks)
and manifest (6 checks), with no warnings, against Connecta's HTTP handlers
and a six-connector local fixture. Directory checks correctly skipped because
`directoryRead` is not advertised; its wire-schema check passed. This is not
full MCP conformance or a downstream-provider conformance claim.

To rerun, first read the runner's package scripts, CLI, connection code and
`src/scenarios/server/skills/` as untrusted code in a temporary directory
outside the checkout. Pin the commit above, install there with
`pnpm install --ignore-scripts`, and keep its packages and outputs there.
In the Connecta checkout, run `pnpm run build:operator-ui` and
`pnpm exec tsx scripts/skills-conformance.ts`. From the runner directory, run
`pnpm exec tsx src/index.ts server --url http://127.0.0.1:39743/mcp --scenario sep-2640-skills-enumeration --spec-version 2026-07-28 --force`;
repeat with `sep-2640-skills-manifest` and `sep-2640-skills-directory`.
Stop the fixture when done. `--force` selects extension scenarios outside the
base protocol timeline. This remains an optional contributor check: the
separately installed runner and dependency graph are not pinned in Connecta CI.
