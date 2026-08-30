# Meta-tools

Connecta keeps one small tool surface in model context and resolves downstream
tools behind it. `search_tools` finds addresses, the call tools enforce safety
annotations, and `get_result` pages bounded results.

## The deployment surface

Every deployment requires an executor and `tools/list` is exactly seven:
`execute_code`, `search_tools`, `call_tool`, `call_destructive_tool`,
`authorize_connector`, `get_result`, and `skills`. Discovery breadth and
batching live in `connecta.search`, `connecta.describe`, and `connecta.batch`
inside a program ([#273](https://github.com/zackbart/connecta/issues/273)).

Code-first is what a model sees. Read-only work has two routes: `call_tool` for
one known address, and `execute_code` when discovery or any wider work is
needed. Real hosted catalogs reversed the earlier synthetic result that made a
top-level cold search look cheaper. Keeping discovery inside the program avoids
returning every candidate schema to the model and removes a model round trip.
The [guest API contract](./code-mode.md) is what a program is promised.

The route is chosen before discovery. An unknown address, a result that will be
reduced, a call whose arguments depend on an earlier result, or work with
multiple operations starts with one `execute_code` call and keeps discovery,
calls, and reduction inside it. Distinct operations get distinct short
`connecta.search` queries in that program. A known address needs only
`call_tool`.

That routing is about read-only work, because that is the only work a program
can do. Anything unannotated, write-capable, or destructive is inadmissible
inside the sandbox, so multi-step destructive work discovers at the top level
and runs each step through `call_destructive_tool` — where the host can put the
question to a human. Telling an agent never to search at the top level for
multiple calls would close the only route that work has
([#295](https://github.com/zackbart/connecta/issues/295)).

`execute_code` accepts optional `diagnostics: true` when a caller is measuring
a workflow. It adds only compact request-local timing and serialized-size
aggregates; normal calls carry no diagnostics block or response-context cost.
The measurements never contain program source, arguments, values, addresses,
credentials, logs, or raw error text.

Nothing became unreachable. `connecta.describe` takes the same addresses and
formats as the internal catalog service, `connecta.batch` runs 1–10 parallel
read-only calls and returns typed outcomes, and an unfiltered
`connecta.search({})` browses every catalog a program can reach. Live connector
probing is an operator concern: the operator pages and `/health` own it.

The three discovery routes use deliberately different envelopes. These are
their smallest successful one-tool shapes:

```js
// Top-level search_tools
{ connectors: [{ id: "ci", tools: [{ name: "get_run", address: "ci.get_run" }] }], total: 1, offset: 0, limit: 8, hasMore: false }

// Inside execute_code
{ tools: [{ name: "get_run", address: "ci.get_run" }], total: 1, offset: 0, limit: 8, hasMore: false } // connecta.search
{ tools: [{ name: "get_run", address: "ci.get_run", inputSchema: "{ runId: integer }" }] } // connecta.describe
```

## Discovery context

The deployment-derived `execute_code` description includes a live connector
inventory before any catalog search. It preserves registry order and uses each
canonical id, adding `shortcut <name>` only when the program namespace differs.
The complete inventory line is capped at 256 UTF-8 bytes. Entries stay whole,
and a truncated line ends with the exact `+N more` count. This reads only the
configured registry: it loads no catalog, probes no credential, grants no
capability, and does not replace canonical discovery or addressing.

Start a lookup with two to four distinctive action/object terms, not the full
request. Read-only lookup belongs in `connecta.search` inside the program.
Top-level `search_tools` remains available for explicit catalog inspection and
approval-required discovery. Omit `limit` initially so the default
eight-result page stays small. When the integration is obvious, set
`connector` to its id: a scoped search loads that catalog alone, while an
unscoped search must fan out across every configured connector. Leave the
search unscoped when the right integration is genuinely ambiguous. Set
`safety: "readOnly"` for generated code; `safety: "approvalRequired"` finds the
complementary set that must cross `call_destructive_tool`. Omitting `safety`,
or setting it to `"all"`, preserves the complete configured catalog. This is
only a discovery filter: it neither grants authority nor changes invocation admission.
`includeSchemas: "compact"` adds each match's input and any provider-declared
output shape. When the provider declared none but an earlier successful call
learned one, the same field carries the open observed schema beside
`outputSchemaSource: "observed"`. That marker matters: observed fields and broad
JSON types are routing evidence, not a provider contract, and every object field
remains optional and open to unseen names. A provider declaration always wins.
Bounded plain-object schemas also expose `inputKeys`,
`requiredInputKeys`, and `outputKeys`; a zero-input object keeps
`requiredInputKeys: []`, while an output object with no declared properties
omits `outputKeys`. A truncated shape omits its corresponding list rather than
repeating a large partial inventory. Matches carry declared
behavior annotations. Lexical rank is only one signal: select a candidate whose
required inputs are available, whose schema is complete enough for the call,
and whose safety and available outputs fit the work. A reducer uses `outputKeys`
before inspecting the value; it does not assume a collection is named `items`
or `results`. When that shape is sufficient, call the returned address directly. Reserve schema
expansion through `connecta.describe` for a search without schemas, an
ambiguous compact shape, or exact
constraints that require `format: "json"`.

Observed schemas originate no provider traffic. A successful explicitly
read-only call the user already made contributes names and broad types after
Connecta unwraps the result. Arguments, scalar values, raw results, code,
credentials, and errors are not retained, though property names may themselves
be user-authored. Shapes merge in a 256-entry runtime cache for 24 hours under
the exact tool definition that produced them. A changed definition, process
restart, or Worker isolate eviction starts cold. Observation cannot fail the
call, and the declared catalog remains the fallback.

Compact search is deliberately a routing view, not a second copy of connector
documentation. Tool purposes are capped at 160 characters, connector
descriptions and property prose are omitted, required input fields render
before optional ones, and each input or output shape is capped at 1,024 UTF-8
bytes. Within that unchanged total, each enum node and each constraint
annotation may spend at most 256 UTF-8 bytes. Numeric bounds, string length
bounds, patterns, and formats render beside their type. A constraint that does
not fit is dropped whole. If constraints push the full shape over 1,024 bytes,
search retries the shape without them. Compact describe keeps all declared
constraints. A large enum keeps the longest whole-value prefix that fits, then
adds `unknown` and a comment with the exact omitted-value count. An empty enum
renders as the valid `never` type. A capped object becomes a valid
required-first shape with `unknown` types; other shapes become
`unknown /* truncated */`. Any cap marks the match with
`inputSchemaTruncated` or `outputSchemaTruncated`; repeat the search with
`includeSchemas: "json"` or use the existing describe path when exact
constraints matter. Small enums and both exact paths remain complete.

## Connector guide selection

A connector may attach a deployment-owned guide as markdown, preserving the
original `usageGuide: string` configuration, or as
`{ content, summary?, required? }`. The structured form does not register a
connector or create a shared runtime template. `content` remains the markdown
returned verbatim by `skills`; `summary` is normalized and refuses construction
when it exceeds 120 characters. When it is absent, Connecta derives the same
bounded fallback used by the skills listing: the first meaningful body
paragraph, joined across physical Markdown line wraps and shortened at a
sentence, clause, or word boundary, with a heading used only when the guide has
no body. `required: true` is reserved for generic API wrappers and
cross-operation conventions a complete downstream schema cannot express.

Search and describe results keep the existing `guide: "connector:<id>"`
pointer and add `guideSummary`. A matching tool also carries
`guideRequired: true` and `guideRequiredReasons` when Connecta can prove review
is necessary:
`connector_required` for the explicit configuration above,
`approval_required` for an unannotated or write-capable tool, and
`schema_truncated` when a requested compact input or output shape was capped.
The boolean is an instruction, not a server-side gate — nothing refuses the
call, so the agent is told to fetch the guide before making it, for any reason
listed. `connector_required` and `approval_required` survive exact schema
expansion; `schema_truncated` is cleared by the describe that returns the exact
shape, and describe reports whatever reasons remain in the same two fields.
Otherwise it reads the
bounded summary: connector-specific sequencing, units, pagination, aliases,
and generic API conventions still require the guide when they affect the task,
while a complete and unambiguous one-read schema proceeds directly.
Guide lookup always uses an exact name returned by `skills({})`, search, or
describe; callers do not manufacture `connector:<id>` from an unmarked
connector.

A connector-scoped lexical miss retains that connector's guide metadata under
`queryAnalysis`. This matters for generic wrappers whose broad tool name does
not contain endpoint vocabulary: a required guide remains discoverable before
the caller falls back to an empty-query browse, rather than disappearing with
the zero-tool page.

The built-in `usage` skill is byte-identical across deployments and says to
read it at most once per task. Connector guides remain scoped to the deployment
that listed them, even when two deployments happen to use identical content.
The always-loaded instructions and seven tool definitions own route selection,
the fail-closed boundary, and the minimum guest syntax. The usage skill owns
program selection detail, examples, runtime differences, and repair guidance.
This split avoids two normative copies while preserving a valid first program
for clients that never fetch the skill. Deployments without connector guides
receive none of the short conditional guide pointers in their definitions.

## Result representation

For object results, `structuredContent` is the canonical full-fidelity value.
`content` carries the same complete value as compact JSON for clients that only
consume text. Keeping both follows MCP's backwards-compatibility guidance;
removing or summarizing the text copy is deferred until host-forwarding
measurements demonstrate that supported clients do not need it.

Plain-text guidance and errors remain text-only. A downstream MCP tool's native
content blocks also pass through unchanged when `call_tool` uses MCP result
mode; they are not a duplicated Connecta object result. Newly stashed JSON and
downstream content envelopes use compact serialization, so `get_result` byte
offsets and totals refer to that exact compact text.

A `call_tool` truncation notice carries both the historical `resultId` and an
exact `nextAction: { tool: "get_result", arguments: { id, offset: 0 } }`. The
handle is therefore
directly actionable without copying an identifier out of prose. Program results
and oversized discovery responses carry no such route — paging a program's
return value is a refused shape, because a program can shrink anything before
it returns.

## Lexical discovery

`search_tools` tokenizes tool names and descriptions at punctuation and
camel-case boundaries. Exact whole-token matches carry the most weight; a small
set of inflectional variants preserves singular/plural and verb-form recall
without allowing arbitrary mid-word substring matches. Ranking weights each
query term by its document frequency across the available catalogs in that
search, so a rare domain term outranks a ubiquitous action while action terms
still distinguish `get`, `list`, `search`, and write operations. The scorer
always evaluates useful near-matches instead of letting one broad all-term
description hide them. Complete matches rank before ordinary partial matches;
a partial candidate whose complete normalized tool name occurs in the
normalized raw query competes with complete matches by score, and other
candidates covering at least two terms fill the remaining page after them.
Conversational cleanup applies only to scoring terms, never to the exact-name
phrase check. If no tool covers every non-conversational term, the same scorer
preserves the wider any-term fallback and marks the result
`matchMode: "partial"`.

Returned tool rows expose neither lexical scores nor per-result query coverage.
The mixed complete/partial scorer still ranks rare domain terms, action terms,
and exact tool-name phrases. Select from the returned purpose, address, schema,
safety, and output shape. Page-level `queryAnalysis` remains the recovery path
when no single result covers every term or no match exists.

Only an empty or whitespace-only query browses. A non-empty query that
normalizes to no ASCII lexical terms returns no tools instead of unrelated
browse results. Its bounded `queryAnalysis.unmatchedTerms` contains the clipped
raw query and guidance asks for ASCII action/object terms. A mixed query still
searches with its ASCII terms; unsupported characters do not become false
matches or per-tool coverage terms.

Every partial or no-match lexical search also returns bounded page-level
`queryAnalysis`; an all-term result needs no recovery advice.
`representedTerms` occur in the current page, `otherResultTerms` occur only in
another result, and
`unmatchedTerms` have no lexical match in the catalogs that answered. Partial
results explain that no single tool covered every term and recommend splitting
distinct intents. A true negative says that no matching capability is
configured and recommends refining, connector-scoping, or browsing; when a
connector catalog was unavailable, the response includes
`unavailableConnectorCount` instead of making that stronger claim. A no-match
query whose terms name a configured connector's `id` or `title` never makes it
either: connector identity is not in the lexical index — indexing it would move
ranking for every query that already matches tools — so instead the guidance on
an unscoped miss names up to three such connectors by ID and sends the caller
to a scoped browse. Identity affects that one sentence and nothing else: no
ranking, no result, and no new field. A search
explicitly scoped to that unavailable connector also receives `catalogError` —
the bounded classified failure (`code`, `message`, `retryable`, and any
`retryAfterMs`) so the caller can tell a transient outage from one a deployment
operator must clear. It carries nothing else the call-path classifier knows: a
discovery read is not a call. Unscoped searches keep the count only — one
connector's failure is not another search's context. An empty query browses
rather than searches, so it reports no term analysis — except when the scope
itself failed, where the same fields apply. A browse scoped to an unavailable
connector carries `unavailableConnectorCount`, `catalogError`, and guidance,
and an unscoped browse again carries the count alone. A browse scoped to an ID
that is not configured at all carries `connectorScope`, `unknownConnector`, and
the same omit-the-connector guidance the term-bearing path gives — nothing was
attempted, so there is no count and no `catalogError` — and it names no
connector but the one the caller supplied. A connector that correctly exposes
no tools still reports no analysis, so the two do not serialize alike. The
advice to browse a connector with an empty query must not land in silence that
reads like a connector with no tools. Analysis
from a connector-filtered search includes `connectorScope` and speaks only
about that connector; `unknownConnector` distinguishes an unconfigured ID from
a known connector with no match. Analysis covers at most eight distinct terms
of at most 64 displayed characters each, marks longer input `truncated`, and
never changes lexical ranking.

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
- `operator_config`: an `operatorUrl` ending in `/credentials`, plus the
  declared credential label and field names/guidance; or
- `unavailable`: an honest deployment/configuration message.

The class follows what the connector declares, not how it was authored: a
`remoteMcp()` connection using `auth: { type: "credential" }` declares a slot
and no OAuth flow, so it lands in `operator_config` beside every `api()`
credential.

The tool accepts no secret. `force` applies only to OAuth and may discard its
stored grant before restarting consent. Static credential values are written
only through the same-origin, Clerk-operator credential route. After OAuth
consent or an operator update, retry the original operation; a static update is
read from the vault on the next call and needs no redeploy.

## Routing recovery

Predictable local refusals carry structured recovery on both result modes.
An unknown connector suggests an unscoped discovery query derived from the
attempted tool name; an unknown tool scopes the same query to the connector that
answered. The suggested route follows the route the caller took: `tool:
"search_tools"` for a top-level call, `function: "connecta.search"` with the same
arguments when the miss happened inside `execute_code`, which has no way to call
a tool. A read path that reaches an unannotated, write-capable, or destructive
tool returns `nextAction` for `call_destructive_tool` with the canonical
address. Nothing is executed by these records.

`connecta.describe` keeps failures inline so one miss cannot discard the other
schemas. Each failed entry keeps its human `error` and adds `errorDetails` with
the equivalent invocation `code` and `retryable`. Address and tool misses use
the same route-aware discovery action above. A close tool-name miss on a known
connector may also carry `suggestions`: at most three deterministically ranked
canonical addresses, with no scores or descriptions. An unknown connector
stays unscoped and has no suggestions. A catalog-load failure carries only
`code`, bounded `message`, `retryable`, and any `retryAfterMs`; discovery does
not inherit later additions to the call-failure envelope.

That route echoes the caller's own arguments back only while they fit a
512-byte budget, and then whole — never clipped. An error envelope is not
size-guarded the way a result is, so an unbounded echo would let a large
argument object produce a refusal many times the deployment's result cap, on
both `call_tool` and calls a program routes through `connecta.call` or
`connecta.batch`. Over budget, `args` is absent and the `purpose` says to
re-send what was just sent: the agent already holds its own arguments, and half
of them would describe a call nobody made.

The address gets the same budget and the opposite rule: 512 bytes, clamped
with a trailing `…` rather than dropped. It is caller-authored too — an
invented one can be any length — and it reaches the error message *and* the
recovery query, each of which lands in both the text content and
`structuredContent`; unbounded, a 50 KB typo produced a 200 KB refusal under a
1 KB result cap. Dropping it is not an option the way dropping arguments is:
the address is the thing being corrected, a clipped one still identifies the
mistake, and a short one — every real one — comes back exact and untagged.

Shortcut ambiguity inside `execute_code` returns every colliding canonical
address and points at `connecta.call`; the program or model must still choose
which one matches the user's intent. `call_destructive_tool` accepts an optional
`reason` of at most 500 characters for the host's human approval view. It is
outer-call context only: Connecta neither treats it as authority nor passes it
to the downstream connector, and an empty or whitespace-only one is read as no
reason rather than as a reason to refuse the call.

Activity carries an optional coarse `friction` class: `tool_not_found`,
`schema_retry`, `destructive_reroute`, `auth_required`, or `result_too_large`.
It is derived from the typed error code, except on the one call that has no
error code to derive from: a result too large to return inline is friction for
the agent while remaining `outcome: "success"`. That applies to a `call_tool`
result, the only source of `result_too_large` friction. (Activity stored by
older releases may still carry the retired `batch_call` source; nothing writes
it today.)
An oversized *discovery* response and an oversized program return are shaped
differently and produce none, and an `errorCode` is written only when the call
actually failed. The category adds no arguments, results, search text,
generated code, credentials, or raw errors.

An address whose connector does not exist is recorded too, as written, provided
it has the `<connectorId>.<toolName>` shape at all — a string that never split
into the two fields activity keeps still records nothing. A hallucinated
connector id is the most common address mistake, and an operator reading
activity should see it; addresses are already a first-class activity field, so
nothing new is retained.

What *is* new is that those fields now hold caller-authored text, so the
recording seam clamps them: `connectorId` and `toolName` at 128 UTF-8 bytes
each, `address` at 257, with a `…` marker. Far past any real id or tool name,
and far short of a 40 KB invented one. The clamp is structural rather than a
policy the writer applies, because "payload-free by construction" has to mean
the event type has nowhere to put a payload — a 40 KB connector id is a payload
wearing an id's clothing. Clamped rather than skipped: the invented id is
exactly what an operator needs to see, and its first 128 bytes say as much
about the mistake as all 40,000 would.

## Argument recovery

A remote MCP tool's advertised `inputSchema` is checked in the shared
invocation path before admission and provider dispatch. A mismatch is the
non-retryable `invalid_args`, consistently across `call_tool`,
`call_destructive_tool`, batch outcomes, and generated-code failures. The error
names the connector and operation and carries bounded `validation.issues`:
JSON Pointer `path`, schema-keyword `code`, and expected shape. Submitted
values are never copied into those findings.

At most three findings are returned; `validation.truncated` says when more
exist. `nextAction` points to discovery scoped to the same connector and tool
name when the compact schema is needed — routed like any other miss, so a
program is sent to `connecta.search` and a top-level call to `search_tools` —
while `retry` says to correct the listed arguments and reissue the original
operation. A declared property reports only its failed schema keyword, while a
truly undeclared property reports `additionalProperties`; validator-internal
duplicate `additionalProperties` branches never reach the caller. A schema the local
validator cannot evaluate passes through to the provider. Provider error prose
is not parsed or guessed, so an unknown format remains
`connector_call_failed`.

Describe's nearby-address list uses the same three-item recovery bound. It
contains addresses only; it never serializes ranking scores or result prose.
