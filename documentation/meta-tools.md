# Meta-tools

Connecta keeps one small tool surface in model context and resolves downstream
tools behind it. `search_tools` finds addresses, the call tools enforce safety
annotations, `execute_code` runs work as a program that pauses at each write
until `resume_execution` approves it, and `get_result` pages bounded results.

This guide is the contract an MCP client sees. The in-program `connecta.*` API
those tools imply belongs to [code mode](./code-mode.md); inbound identity and
credential administration belong to [auth](./auth.md).

## The eight tools

Every deployment requires an executor, so `tools/list` is exactly eight. No
configuration adds a ninth or removes one — not even turning resumable writes
off, which changes what `resume_execution` answers and nothing about whether it
is listed, so a client's cached tool list never depends on the storage behind
the deployment. `execute_code` keeps its read-only hint although its programs
may now reach writes, because no write runs there: a program stops before
sending one, and the write runs only inside the destructive-annotated
`resume_execution` that repeats it ([code mode](./code-mode.md#pausing-and-resuming)).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `execute_code` | `code`, `diagnostics?` | the program's reduced return value, plus a `diagnostics` block when asked; or, when it reached a write, `{ paused: { address, args, token, expiresAt, nextAction, hint } }` |
| `resume_execution` | `token`, `address`, `args`, `approval?: "call" \| "tool"`, `reason?` | what `execute_code` would have returned had the write been approved: the result, the next pause, or a typed failure |
| `search_tools` | `query?`, `connector?`, `safety?`, `limit?`, `offset?`, `fullDescriptions?`, `includeSchemas?: "compact" \| "json" \| "typescript"` | `{ connectors: [{ id, tools }], total, offset, limit, hasMore }`, plus `queryAnalysis` on a partial or failed search |
| `call_tool` | `address`, `args?`, `resultMode?: "mcp" \| "value"`, `timeoutMs?`, `diagnostics?` | the downstream result, bounded as [result representation](#result-representation) describes |
| `call_destructive_tool` | the same, plus `reason?` | the same |
| `authorize_connector` | `connector`, `force?` | the class-specific handoff in [authorization recovery](#authorization-recovery) |
| `get_result` | `id`, `offset?`, `maxBytes?` | a one-line JSON header `{ resultId, offset, bytes, totalBytes, hasMore, nextAction? }`, a newline, then the page as raw text ([paging](#paging-with-get_result)) |
| `skills` | `name?` | the listing when `name` is absent, that skill's markdown when it is present |

`limit` defaults to 8 and is capped at 100, as is one `connecta.describe` batch.
`get_result.offset` is a whole number of bytes ≥ 0 defaulting to 0 and
`maxBytes` a whole number ≥ 1 that defaults to, and is clamped to, the inline
cap of the call that stashed the result — 24,000 bytes unless
`calls.maxResultBytes` or a per-connector override says otherwise
([why 24,000](#truncated-direct-call-results)). A value outside those domains is
an input error; a valid `maxBytes` above the cap is an upper bound, not an
error ([why](#paging-with-get_result)). `reason` is at most 500 characters of context for the host's human
approval view; Connecta neither treats it as authority nor sends it downstream,
and an empty or whitespace-only one reads as no reason rather than as grounds to
refuse a consequential call.

`diagnostics: true` adds compact request-local timing and serialized-size
aggregates for a caller measuring a workflow: a `diagnostics` block from
`execute_code`, a `timing` block on a call response that is already structured
(value mode, or a failure carrying recovery). Normal calls pay nothing for it,
and the measurements never contain program source, arguments, values, addresses,
credentials, logs, or raw error text.

Connecta's own tools carry the annotations it demands of downstream tools:
read-only hints on all but `authorize_connector`, which mutates stored auth
state, and the two that send writes, `call_destructive_tool` and
`resume_execution`, both destructive. Otherwise a host that gates on
annotations would prompt for every search, and a connecta aggregated behind
another connecta would be refused by its own policy. `resume_execution` is
where the prompt belongs: its arguments are the exact write, so the human
approves what will be sent rather than a program that might send anything.
Its `reason`, like `call_destructive_tool`'s, is dropped before anything runs.

## Routing between the call surfaces

The route is chosen before discovery, and read-only work has exactly two:
`call_tool` for one known address, `execute_code` for everything wider — an
unknown address, a result that will be reduced, a call whose arguments depend on
an earlier result, or several operations. A program keeps discovery, calls, and
reduction together when the schemas and result shapes suffice, and gives each
distinct operation its own short `connecta.search` query. That is cheaper than it
looks: discovery inside the program returns no candidate schema to the model and
costs no round trip. One exception — an unfamiliar provider result may come back
as a small sample for inspection before continuing in another call, which avoids
repeated guesses at text formats and collection roots without restoring a
mandatory discovery-only round trip.

Writes take the same route. A program that reaches a tool not explicitly
annotated read-only stops before sending it and returns the exact call with a
token; `resume_execution` repeating it is the approval, and the program
replays from a journal to send it and carry on — to its answer, or to its next
write. So "close the stale issues and post a summary" is one program and a few
approvals, not one program and thirty-one top-level calls, and the program's
reasoning survives between them. `approval: "tool"` covers the rest of the
run's calls to that tool, so thirty closes cost one prompt. One known write
still goes straight to `call_destructive_tool`, and top-level discovery stays
for catalog inspection. On a deployment without resumable writes (storage
without `compareAndSet`), a program cannot write at all: the call fails
`destructive_tool_requires_approval`, multi-step writes discover at the top
level and run each step through `call_destructive_tool`, and the MCP
instructions say so.

The three discovery routes use deliberately different envelopes. These are their
smallest successful one-tool shapes:

```js
// Top-level search_tools
{ connectors: [{ id: "ci", tools: [{ name: "get_run", address: "ci.get_run" }] }], total: 1, offset: 0, limit: 8, hasMore: false }

// Inside execute_code
{ tools: [{ name: "get_run", address: "ci.get_run" }], total: 1, offset: 0, limit: 8, hasMore: false } // connecta.search
{ tools: [{ name: "get_run", address: "ci.get_run", inputSchema: "{ runId: integer }" }] } // connecta.describe
```

Live connector probing is not a fourth: the operator pages and `/health` own it.

## Discovery context

The deployment-derived `execute_code` description carries a live connector
inventory before any catalog search — registry order, each canonical id, and a
distinct configured title, with no second name minted for programs. Titles
normalize whitespace and cap at 48 UTF-8 bytes, the complete line caps at 256,
entries stay whole, and a truncated line ends with the exact `+N more` count, so
account and environment hints cannot eat the inventory. It reads only the
configured registry: no catalog load, no credential probe, no capability, and no
replacement for canonical discovery or addressing. Program search results carry
the same bounded `connectorTitle` per tool, so choosing an account or
environment costs no provider read. Context, not a ranking input and not proof
of live access.

Read-only lookup belongs in `connecta.search` inside the program; top-level
`search_tools` stays for explicit catalog inspection and approval-required
discovery. Both take the same arguments.

| Argument | What it does |
| --- | --- |
| `query` | two to four action/object terms; empty or whitespace-only browses |
| `connector` | scopes to one id, loading that catalog alone instead of fanning out across every configured connector. Set it when the integration is obvious, omit it when the right one is genuinely ambiguous |
| `safety` | `"readOnly"` for what runs unasked, `"approvalRequired"` for the complementary set that pauses a program or crosses `call_destructive_tool`, omitted or `"all"` for the complete configured catalog |
| `limit` / `offset` | page the ranked results; omit `limit` initially so the default eight-result page stays small |
| `includeSchemas` | `"compact"` for the rendered routing view, `"json"` for the exact schema, `"typescript"` for a function signature ([below](#typescript-signatures)) |
| `fullDescriptions` | unabridged tool purposes, at the obvious cost |

Neither `connector` nor `safety` grants authority or changes invocation
admission; they select what discovery shows and nothing else.

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
so it spends bytes on shape and none on prose: tool purposes cap at 160
characters, connector descriptions and property prose are dropped, and required
input fields render before optional ones. Both surfaces share one renderer, so
its byte and work budgets, its truncation renderings, and its handling of enums,
tuples, and conditional keywords are documented once under
[`connecta.search`](./code-mode.md#connectasearch) and
[`connecta.describe`](./code-mode.md#connectadescribe). The part a client must
act on is the flag: any cap sets `inputSchemaTruncated` or
`outputSchemaTruncated`, and that means repeat with `includeSchemas: "json"`, or
describe, when the exact constraints matter.

### TypeScript signatures

`includeSchemas: "typescript"` replaces both schema fields with one
`signature`: the function `connecta.call(address, args)` resolves to, written
as a TypeScript type because agents write code against types more reliably
than against JSON Schema ([executor](https://github.com/UsefulSoftwareCo/executor)'s
discovery made the same bet).

```ts
(args: { team: string; limit?: number /* <= 250 */ }) => Promise<unknown>
(args?: {}) => Promise<{ accounts: { stripe_context: string; livemode: boolean; name?: string }[] }>
(args: { team: string }) => Promise</* observed, not declared */ { cursor?: string; issues?: { id?: string }[] }>
```

It is something to read, not something that runs: programs stay JavaScript,
and the refusal of erasable TypeScript in `execute_code` stands
([ethos](../ethos.md#decisions)). The output half is the provider's declared
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
shared runtime template. `content` is the markdown `skills` returns verbatim.
`summary` is normalized and refuses construction over 120 characters; absent,
Connecta derives the same bounded fallback the skills listing uses from the
guide's first meaningful body paragraph. `required: true` is reserved for
generic API wrappers and cross-operation conventions a complete downstream
schema cannot express.

Search and describe results carry a `guide: "connector:<id>"` pointer and a
`guideSummary`. A matching tool also carries `guideRequired: true` and
`guideRequiredReasons` when Connecta can prove review is necessary:

| Reason | Raised by | Survives exact schema expansion |
| --- | --- | --- |
| `connector_required` | the explicit `required: true` above | yes |
| `approval_required` | an unannotated or write-capable tool | yes |
| `schema_truncated` | a requested compact shape was capped | no — the describe that returns the exact shape clears it |

Describe reports whatever reasons remain in the same two fields. The boolean is
an instruction, not a server-side gate: nothing refuses the call, so the agent
is merely told to fetch the guide first, for any reason listed. Otherwise the
bounded summary decides — connector-specific sequencing, units, pagination,
aliases, and generic API conventions still need the guide when they affect the
task, while a complete and unambiguous one-read schema proceeds directly. Guide
lookup always uses an exact name returned by `skills({})`, search, or describe;
callers never manufacture `connector:<id>` from an unmarked connector.

A connector-scoped lexical miss keeps that connector's guide metadata under
`queryAnalysis`. This matters for generic wrappers whose broad tool name
contains no endpoint vocabulary: a required guide stays discoverable instead of
disappearing with the zero-tool page.

Two built-in skills are byte-identical across deployments. `usage` says to read
it at most once per task and owns program selection detail, examples, runtime
differences, and repair guidance; `investigate` is on-demand guidance for
purchase verification, experiment checks, and customer or deployment
investigations — shared guidance, not a saved workflow and not a source of
deployment-specific ids. The always-loaded instructions and tool definitions keep
route selection, the fail-closed boundary, and the minimum guest syntax, so a
client that never fetches a skill can still write a valid first program. Connector
guides stay scoped to the deployment that listed them even when two deployments
use identical content, and a deployment with no connector guides receives none of
the short conditional guide pointers in its tool definitions.

## Result representation

For object results, `structuredContent` is the canonical full-fidelity value and
`content` carries the same complete value as compact JSON for clients that only
consume text. Keeping both follows MCP's backwards-compatibility guidance;
dropping the text copy waits on host-forwarding measurements showing supported
clients do not need it. Plain-text guidance and errors stay text-only, and a
downstream MCP tool's native content blocks pass through in MCP result mode.
When no text block exists and `structuredContent` is present, Connecta appends a
text block carrying its compact JSON and then applies the same content size
guard, which preserves structured-only results including `null`, arrays, and
scalars. An existing text mirror stays unchanged; Connecta adds no second copy.
Newly stashed JSON and downstream content envelopes use compact serialization,
and a lone text block stashes as its own text, so `get_result` offsets and
totals describe exactly that text.

| Bound | Value |
| --- | --- |
| Stashed result TTL | 15 minutes |
| `results.maxStashBytes` | 8 MiB per `createConnecta` runtime |
| `results.maxStashEntries` | 64 per runtime |
| Top-level discovery result ceiling | 256,000 UTF-8 bytes |
| Downstream MCP `isError` text | 512 UTF-8 bytes plus an `…` marker |

The discovery ceiling counts text, `structuredContent`, and JSON escaping
together, because measuring one copy would advertise half the bytes the adapter
actually returns; error framing may shorten a bounded `isError` reason further to
fit the call's result cap on the same arithmetic. Both stash options accept
non-negative safe integers, zero disabling stashing, and are shared across all
subjects and pools; they count the stored ASCII paging envelope, base64 overhead
included, not only the result text. Capacity is reserved before each storage
write so concurrent requests cannot oversubscribe it, and a full stash refuses
new entries. A later attempt deletes expired entries before reusing their
capacity; a failed deletion keeps the charge. These bounds cover writes by this
runtime — not other processes, Worker isolates, or entries a previous runtime
left behind.

Results belong to the authenticated subject whenever auth supplies a subject or
user id, independently of activity configuration, under the provider's namespace
when it has one and `connecta:auth:<provider kind>` otherwise. Keep subject ids
distinct within that namespace. An explicit principal is the fallback subject
when neither id is supplied, and open deployments and auth providers that supply
no identity share one partition.

New entries store UTF-8 bytes in a base64 envelope split across storage keys,
48 KiB of result text per chunk — widening past roughly 1.5 MB so no result
occupies more than 33 keys, because every chunk is also a write. `get_result`
reads and decodes only the chunks a page covers plus a few boundary bytes, so
paging a 1.2 MB result costs the same per page as paging a 300 KB one; it
neither encodes nor reads the whole result per page. Pre-upgrade entries remain readable during their TTL — the earlier
single-key envelope reads one full value per page, and raw text before that
also pays one full encoding. Offsets and `totalBytes` always describe the
original UTF-8 text, not the envelope. A supplied offset inside a character
moves back to its start; page ends also align to character boundaries, and a
page smaller than one character widens just enough to make progress.

A per-call `timeoutMs` covers catalog resolution, admission, and connector
execution under one deadline. The admission queue's own timeout may expire
sooner but cannot extend the call deadline. Result processing happens after that
deadline ends, because a completed downstream call must not turn into a
retryable timeout while Connecta prepares its response.

### Truncated direct-call results

A `call_tool` or `call_destructive_tool` result over its cap — the connector's
`maxResultBytes`, else `calls.maxResultBytes`, else 24,000 bytes — comes back
as one text block. Its first line is the truncation notice, one line of compact
JSON; everything after the first newline is the preview:

```text
{"truncated":true,"resultId":"…","totalBytes":161420,"hint":"This write already ran: do not call it again to see its result. Bytes 0-24000 of 161420 follow; page the rest with get_result using nextAction.","nextAction":{"tool":"get_result","arguments":{"id":"…","offset":24000}}}
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
because a token covers at least one byte. A `get_result` page obeys the same
cap, and 24,000 matches the program result boundary in
[code mode](./code-mode.md). A deployment whose
clients take more can raise the cap, and one whose clients take less can lower
it, per connector if need be; a result between 24,000 and 50,000 bytes that
used to arrive whole now pages. A client that spills rather than rejects keeps
the notice whatever its threshold, since the notice is the first few hundred
characters. One that rejects outright — Claude Code with
`MAX_MCP_OUTPUT_TOKENS` set below 12,500 — needs a cap under twice its limit.

The preview is the head of what `get_result` pages, cut on a character
boundary, so `nextAction.arguments.offset` continues exactly where it stops. A
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
becomes three. For an explicitly read-only call, repeating is the better route,
so the hint offers it first: to find something specific, repeat the read inside
`execute_code` with `connecta.call` and filter or search the result there; to
read it in full, page with `get_result`. Inside a program the inline cap does
not apply to a host call's result, only to what the program returns (`L6` in
[code mode](./code-mode.md) bounds a host call far higher), so the reduction
sees the whole result at once. When the hint named paging alone, the eval's
weakest model read a 185 KB CI log in 24,000-byte pages, skipped the range
holding the real failure, and named the flaky test near the top; before the
notice was visible, it had reduced the log in a program and found the failure.
`nextAction` stays the page handle for either kind of call, because paging is
the one next step connecta can spell out exactly, while a reduction is a
program the agent has to write. `resultId` stays beside the exact `nextAction`,
so the handle is actionable without copying an identifier out of prose.
Program results and oversized discovery responses carry no such route: paging a
program's return value is a refused shape, because a program can shrink
anything before it returns.

### Paging with get_result

A page is the truncated result's shape again: one text block whose first line
is a JSON header and whose remainder is the page, raw.

```text
{"resultId":"…","offset":24000,"bytes":24000,"totalBytes":161420,"hasMore":true,"nextAction":{"tool":"get_result","arguments":{"id":"…","offset":48000}}}
{"ts":"2026-09-17T23:42:55.357Z","actor":"noor.haddad@example.com",…
```

`bytes` is what this page returned; `hasMore` is false on the last page, which
carries no `nextAction`. The page is the stashed text as-is — a lone text
block's own text, a value's compact JSON, several blocks' serialized content
array — and never a JSON string holding it. Pages used to arrive as
`{ offset, nextOffset?, totalBytes, text }`, which escaped every quote and
newline in the page: a second layer over JSON payloads that made them hard to
read and swelled a 20,000-byte page of JSON lines to 25,000 characters or more.

`maxBytes` is an upper bound clamped to the inline cap of the call that stashed
the result — the connector's override when it had one, recorded in the stash
entry — and a clamped request is answered, not refused, with `bytes` saying how
much came back. Clients cut an oversized page exactly as they cut the original
result. In the eval, agents that could finally see the handle asked for pages of
50,000 bytes and more, and Claude Code rejected every one of those answers
outright, leaving an agent that had just been told not to repeat a write with
nothing to read. So no response to a truncated call or to a page request
exceeds the cap plus a header of a few hundred bytes. Value mode's unpageable
preview is cut short enough that its JSON escaping still fits. Entries stashed
before the cap was recorded page at the deployment cap.

A refused or failed stash write cannot undo a downstream success. Both call tools
then return the same layout with a paging-unavailable notice and no `resultId`
or paging action — the notice first, then the preview where one is usable, and
for a write the same warning not to repeat it. Activity records success, and
the operator logger receives a fixed warning naming the connector and tool
without storage error prose. For read-only work, reduce the result inside
`execute_code` — repeating an approved write is not a way to recover its output. Other result-processing failures use a fixed
`result_processing_failed` message and are never retryable.

## Lexical discovery

`search_tools` tokenizes tool names and descriptions at punctuation and
camel-case boundaries. Exact whole-token matches carry the most weight, and a
small set of inflectional variants preserves singular/plural and verb-form
recall without admitting arbitrary mid-word substrings. Each query term is
weighted by its document frequency across the catalogs available to that search,
so a rare domain term outranks a ubiquitous action while action terms still
distinguish `get`, `list`, `search`, and write operations. Complete matches rank
before ordinary partial matches; a partial candidate whose complete normalized
tool name occurs in the normalized raw query competes with complete matches by
score, and other candidates covering at least two terms fill the remaining page.
Conversational cleanup applies to scoring terms only, never to the exact-name
phrase check. If no tool covers every non-conversational term, the same scorer
preserves the wider any-term fallback and marks the result
`matchMode: "partial"`.

Tool rows expose neither lexical scores nor per-result query coverage. Select
from the returned purpose, address, schema, safety, and output shape; page-level
`queryAnalysis` is the recovery path when no single result covers every term or
none exists. It reports `representedTerms` (in the current page),
`otherResultTerms` (only in another result), and `unmatchedTerms` (no lexical
match in the catalogs that answered), covers at most eight distinct terms of at
most 64 displayed characters each while marking longer input `truncated`, and
never changes lexical ranking. A non-empty query that normalizes to no ASCII
lexical terms returns no tools rather than unrelated browse results, with the
clipped raw query in `unmatchedTerms`; a mixed query searches with its ASCII
terms, and unsupported characters become neither false matches nor coverage
terms.

What the analysis says next depends on why the page is thin:

| Case | Fields and guidance |
| --- | --- |
| Partial match | no single tool covered every term; split distinct intents |
| True negative | no matching capability is configured; refine, connector-scope, or browse |
| True negative naming a configured connector | the same, plus up to three such connectors named by id and a pointer to a scoped browse |
| Unscoped search or browse with some connector unavailable | `unavailableConnectorCount` alone |
| Scoped to an unavailable connector | `unavailableConnectorCount`, `catalogError`, guidance |
| Scoped to an unconfigured id | `connectorScope`, `unknownConnector`, omit-the-connector guidance |
| Connector configured and genuinely exposing no tools | no analysis |

Three of those rows earn their asymmetry. An unavailable catalog downgrades the
claim, because a search may not report that nothing is configured when it does
not know. Connector identity is deliberately absent from the lexical index —
indexing it would move ranking for every query that already matches tools — so a
query naming one gets exactly one extra sentence and nothing else: no ranking
change, no result, no new field. And a browse scoped to an unavailable connector
must not serialize like a connector that genuinely has no tools, or the advice to
browse lands in silence that reads like an answer.

`catalogError` is the bounded classified failure — `code`, `message`,
`retryable`, and any `retryAfterMs` — so a caller can tell a transient outage
from one an operator must clear, and nothing else the call-path classifier knows,
because a discovery read is not a call. Only an explicitly scoped search gets it:
one connector's failure is not another search's context, and a scope that was
never configured gets neither it nor a count, since nothing was attempted.

## Authorization recovery

Every typed `auth_required` call failure uses the same envelope:

```json
{
  "code": "auth_required",
  "message": "...",
  "retryable": false,
  "connector": "service",
  "operation": "service.read",
  "recovery": "oauth",
  "nextAction": {
    "tool": "authorize_connector",
    "arguments": { "connector": "service" },
    "operatorHandoff": "Give the URL and instructions it returns to the operator."
  },
  "retry": "Retry service.read after the operator completes recovery."
}
```

`recovery` is `oauth`, `operator_config`, or `unavailable`. Call
`authorize_connector` only after this error. It returns the class-specific
handoff:

- `oauth`: an `authorizationUrl` and consent instructions;
- `operator_config`: an `operatorUrl` to the mounted connection UI, plus the
  declared credential label and field names/guidance; or
- `unavailable`: an honest deployment/configuration message.

The class follows what the connector declares, not how it was authored: a
`remoteMcp()` connection using `auth: { type: "credential" }` declares a slot
and no OAuth flow, so it uses `operator_config` when both vault and UI are
configured. Without either it returns `unavailable`, never a dead UI link.

The tool accepts no secret. `force` applies only to OAuth and may discard its
stored grant before restarting consent. Static credential values are written
only through the same-origin interactive-user credential route, and only for a
connector visible to that user with the relevant shared or personal management
permission; OAuth start, `force` included, requires that permission too. Core
callbacks work without the UI for authorized interactive callers. After OAuth
consent or a human update, retry the original operation; a static update is read
from the vault on the next call and needs no redeploy.

## Routing recovery

Predictable local refusals carry structured recovery on both result modes. An
unknown connector suggests an unscoped discovery query derived from the
attempted tool name; an unknown tool scopes the same query to the connector that
answered. The suggested route follows the route the caller took:
`tool: "search_tools"` for a top-level call, `function: "connecta.search"` with
the same arguments when the miss happened inside `execute_code`, which has no
way to call a tool. `call_tool` reaching an unannotated, write-capable, or
destructive tool returns `nextAction` for `call_destructive_tool` with the
canonical address; inside a program the same call pauses, and the pause result
names `resume_execution` instead. Nothing is executed by these records.

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

| Field | Over 512 UTF-8 bytes |
| --- | --- |
| `args` on `call_tool` and `connecta.call` | dropped whole; `purpose` says to re-send what was just sent |
| the attempted address | clamped with a trailing `…` |
| unknown `get_result.id`, `authorize_connector.connector`, `skills.name` | clamped the same way |
| `search_tools.connector` | rejected with `invalid_args` before catalog lookup |

Arguments go all or nothing because the agent already holds what it sent, and
half of it would describe a call nobody made. The address gets the opposite rule
because it is the thing being corrected: a clipped one still identifies the
mistake, and a short one — every real one — comes back exact and untagged. A
scope is rejected outright because a clipped one could select a different
connector. A failed result-storage read returns typed `unavailable` without
exposing backend error text.

Activity records each of these refusals with the coarse `friction` class derived
from its typed error code — `tool_not_found`, `schema_retry`,
`destructive_reroute`, `auth_required` — and clamps the caller-authored
`connectorId`, `toolName`, and `address` it keeps, both under
[code mode](./code-mode.md#activity)'s `V2` and `V3`. A `call_tool` result too
large to return inline is the one exception: it is friction
(`result_too_large`) on a call whose `outcome` is still `"success"`, so it
carries no `errorCode`.

## Argument recovery

A remote MCP tool's advertised `inputSchema` is checked in the shared invocation
path before admission and provider dispatch, so a mismatch is the non-retryable
`invalid_args` identically on `call_tool`, `call_destructive_tool`,
generated-code failures, and rejected promises. The error names the connector and
operation and carries `validation.issues`: JSON Pointer `path`, schema-keyword
`code`, and expected shape, with submitted values never copied into a finding. At
most three are returned, and `validation.truncated` says when more exist — the
same three-item bound describe's nearby-address list uses.

`nextAction` points to discovery scoped to the same connector and tool name when
the compact schema is needed, routed like any other miss: a program to
`connecta.search`, a top-level call to `search_tools`. `retry` says to correct
the listed arguments and reissue the original operation. Which keyword a finding
names, and what the local validator declines to evaluate, is
[code mode](./code-mode.md#errors)'s `E8`.
