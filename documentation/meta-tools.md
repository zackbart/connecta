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

Code-first is what a model sees. Four overlapping ways to reach one connector
became two: `search_tools` then `call_tool` for a single cold read — measurably
cheaper direct than through a program — and `execute_code` for everything wider.
The consolidation removed overlapping routing choices while preserving the
cheaper direct path for one cold call. The [guest API contract](./code-mode.md)
is what a program is promised.

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

## Discovery context

Start an unknown-address lookup with two to four distinctive action/object
terms, not the full request, and omit `limit` so the default eight-result page
stays small. When the integration is obvious, set `connector` to its id: a
scoped search loads that catalog alone, while an unscoped search must fan out
across every configured connector. Leave the search unscoped when the right
integration is genuinely ambiguous. Set `safety: "readOnly"` when the result is
headed to `call_tool` or generated code; `safety: "approvalRequired"` finds the
complementary set that must cross `call_destructive_tool`. Omitting `safety`,
or setting it to `"all"`, preserves the complete configured catalog. This is
only a discovery filter: it neither grants authority nor changes invocation admission.
`includeSchemas: "compact"` adds each match's input and any declared output
shape. Bounded plain-object schemas also expose `inputKeys`,
`requiredInputKeys`, and `outputKeys`; a truncated shape omits its corresponding
list rather than repeating a large partial inventory. Matches carry declared
behavior annotations. When
that shape is sufficient, call the returned address directly. Reserve schema
expansion through `connecta.describe` for a search without schemas, an
ambiguous compact shape, or exact
constraints that require `format: "json"`.

Compact search is deliberately a routing view, not a second copy of connector
documentation. Tool purposes are capped at 160 characters, connector
descriptions and property prose are omitted, required input fields render
before optional ones, and each input or output shape is capped at 1,024 UTF-8
bytes. A capped object becomes a valid required-first shape with `unknown`
types; other shapes become `unknown /* truncated */`. The match also carries
`inputSchemaTruncated` or `outputSchemaTruncated`; repeat the search with
`includeSchemas: "json"` or use the existing describe path when exact
constraints matter.

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
directly actionable without copying an identifier out of prose; re-calling with
`fields` remains the smaller alternative when projection is possible. Program results and oversized discovery responses carry no such
route — paging a program's return value is a refused shape, because a program
can shrink anything before it returns.

`fields` keeps its historical flat `{ "<path>": value }` result when every
requested dot-path resolves. Dot notation traverses objects; append `[]` to an
array field before continuing, as in `results[].id`. An exact downstream
`$connecta` field is always escaped under `data`. If any path misses—or that
reserved name is selected—the result carries matches under `data` and reserves `$connecta` for a
`type: "field_projection"` recovery record naming each `unmatchedFields`
entry. When a miss matches a declared array path except for `[]`, the record
also carries the traversal hint. The discriminator means downstream fields
named `data`, `projection`,
or `$connecta` remain ordinary values nested under `data`, never apparent
metadata. A declared output schema contributes a bounded `availableFields`
list and a `schemaCoverage` verdict. Only a completely analyzed, closed schema
can label paths `invalidFields`; open, patterned, tuple, unresolvable, cyclic,
`$ref`-sibling, or traversal-limited shapes stay `partial`. Traversal bounds
depth, nodes, path count, individual path characters/bytes, and cumulative path
characters/bytes before sorting or rendering. Without a schema, Connecta
reports only observed misses and does not pretend it knows the complete runtime
shape. API values and JSON-parseable downstream MCP text blocks follow the same
rule.

## Lexical discovery

`search_tools` tokenizes tool names and descriptions at punctuation and
camel-case boundaries. Exact whole-token matches carry the most weight; a small
set of inflectional variants preserves singular/plural and verb-form recall
without allowing arbitrary mid-word substring matches. Ranking weights each
query term by its document frequency across the available catalogs in that
search, so a rare domain term outranks a ubiquitous action while action terms
still distinguish `get`, `list`, `search`, and write operations. If no tool
covers every non-conversational term, the same scorer falls back to any-term
matching and marks the result `matchMode: "partial"`.

Every partial or no-match lexical search also returns bounded `queryAnalysis`;
an all-term result needs no recovery advice. `representedTerms` occur in the
current page, `otherResultTerms` occur only in another result, and
`unmatchedTerms` have no lexical match in the catalogs that answered. Partial
results explain that no single tool covered every term and recommend splitting
distinct intents. A true negative says that no matching capability is
configured and recommends refining, connector-scoping, or browsing; when a
connector catalog was unavailable, the response includes
`unavailableConnectorCount` instead of making that stronger claim. Analysis
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
operation. A schema the local
validator cannot evaluate passes through to the provider. Provider error prose
is not parsed or guessed, so an unknown format remains
`connector_call_failed`.
