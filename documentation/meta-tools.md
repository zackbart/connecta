# Meta-tools

Connecta keeps one small tool surface in model context and resolves downstream
tools behind it. `search_tools` finds addresses, the call tools enforce the
stored classification, `execute_code` runs programs under pool trust, and `connecta.result` inside programs
pages bounded results.

This guide is the contract an MCP client sees. The in-program `connecta.*` API
those tools imply belongs to [code mode](./code-mode.md); inbound identity and
credential administration belong to [auth](./auth.md).

## Task routes

Start with [Operating an endpoint](./operating.md) for a workflow, or
[the agent index](./README.md) for setup and repository tasks. This reference
owns the top-level MCP contract; it does not require reading the core internals.

| Task                                               | Sections                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose a tool or construct its arguments           | [Six-tool table](#the-six-tools), [call routing](#routing-between-the-call-surfaces), [downstream input](#downstream-input-on-direct-calls) |
| Find an operation and its schema                   | [Discovery context](#discovery-context), [TypeScript signatures](#typescript-signatures), [lexical discovery](#lexical-discovery)           |
| Load provider instructions or native skills        | [Connector guides](#connector-guides-and-skills), [native extension](#native-skills-extension)                                              |
| Interpret a direct response or page a large result | [Representation](#result-representation), [truncation](#truncated-direct-call-results), [paging](#paging-with-connectaresult)               |
| Recover a refused or invalid call                  | [Authorization](#authorization-recovery), [routing](#routing-recovery), [arguments](#argument-recovery), [echo budgets](#echo-budgets)      |
| Change the contract                                | [Source and tests](#source-and-tests), [guest API](./code-mode.md#verification)                                                             |

## The six tools

Every deployment requires an executor, so `tools/list` is exactly six. No
configuration adds a seventh or removes one, so a client's cached tool list
never depends on the storage behind the deployment. There was an eighth,
`resume_execution`, while programs paused at writes; it left with pausing
([#672](https://github.com/zackbart/connecta/issues/672)). `execute_code`
is annotated `readOnlyHint: true, destructiveHint: false` on a `read-only`
endpoint, and `readOnlyHint: false, destructiveHint: true` on a `trusted`
endpoint. Approval belongs to the host. Pool trust never changes connector
visibility or tool grants. The four tools with structured-only success results
advertise `outputSchema`. The two direct-call tools omit it because their default
mode returns native `content`. Default-mode successes declare
`_meta["dev.connecta/format"]: "json" | "text"`; value mode places the value in
`data` and declares `format` in its complete result envelope.

| Tool                    | Arguments                                                                                                                           | Returns                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `execute_code`          | `code`, `diagnostics?`                                                                                                              | `{ result?, error?, hostCalls }`, plus diagnostics when asked                                                 |
| `search_tools`          | `query?`, `connector?`, `safety?`, `limit?`, `offset?`, `fullDescriptions?`, `includeSchemas?: "compact" \| "json" \| "typescript"` | `{ catalogErrors, tools, total, offset, limit, hasMore }`, plus `queryAnalysis` on a partial or failed search |
| `call_tool`             | `address`, `args?`, `resultMode?: "mcp" \| "value"`, `timeoutMs?`, `diagnostics?`                                                   | the downstream result, bounded as [result representation](#result-representation) describes                   |
| `call_destructive_tool` | the same, plus `reason?`                                                                                                            | the same                                                                                                      |
| `authorize_connector`   | `connector`, `force?`                                                                                                               | the class-specific handoff in [authorization recovery](#authorization-recovery)                               |
| `skills`                | `name?`                                                                                                                             | the listing when `name` is absent, that skill's markdown when it is present                                   |

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
`execute_code`, a `timing` block on a call response that is already structured
(value mode, or a failure carrying recovery). Normal calls pay nothing for it,
and the measurements never contain program source, arguments, values, addresses,
credentials, logs, or raw error text.

Connecta's discovery tools carry read-only hints. `authorize_connector`
requests interactive authentication changes; `call_destructive_tool` sends
writes and is annotated destructive. `execute_code` reports the selected pool's
trust in its description and annotations. Its host may approve the whole
program on a trusted endpoint. `call_destructive_tool.reason` is dropped before
anything runs.

## Routing between the call surfaces

The route is chosen before discovery, and read-only work has exactly two:
`call_tool` for one known address, `execute_code` for everything wider — an
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
use a direct `call_destructive_tool` result and page it with `connecta.result` after
the write runs once. A program return has no page handle; sampling or slicing
a write's output there can discard the answer.

A `trusted` pool lets the same program discover and dispatch writes.
A `read-only` pool refuses writes before validation or dispatch with
`destructive_tool_requires_approval` and a `nextAction` naming
`call_destructive_tool` and the canonical address. Each write then uses its
own top-level call. Connecta never pauses, replays, or approves a program.
Top-level discovery remains available for catalog inspection and write routing.

Both search routes return the flat page specified under
[lexical discovery](#lexical-discovery), using the catalog's shared output schema.
Describe returns an ordered tool list without pagination. Optional row metadata
is omitted in this example:

```js
// connecta.describe defaults to JSON
{ tools: [{ name: "get_run", address: "ci.get_run", schemaFormat: "json", inputSchema: { type: "object" } }] }
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
environment costs no provider read. The inventory does not probe live access.

Read-only lookup belongs in `connecta.search` inside the program; top-level
`search_tools` stays for explicit catalog inspection and approval-required
discovery. Both take the same arguments.

| Argument           | What it does                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`            | two to four action/object terms; empty or whitespace-only browses                                                                                                                                                                                                       |
| `connector`        | scopes to one id, loading that catalog alone instead of fanning out across every configured connector. Set it when the integration is obvious, omit it when the right one is genuinely ambiguous                                                                        |
| `safety`           | `"readOnly"` selects stored `read` verdicts; `"approvalRequired"` selects stored `write` verdicts; omitted or `"all"` selects both. Each row carries `classification: "read" \| "write"`. These legacy filter names do not describe host approval policy or pool trust. |
| `limit` / `offset` | page the ranked results; omit `limit` initially so the default eight-result page stays small                                                                                                                                                                            |
| `includeSchemas`   | `"compact"` for the rendered routing view, `"json"` for the exact schema, `"typescript"` for a function signature ([below](#typescript-signatures))                                                                                                                     |
| `fullDescriptions` | unabridged tool purposes, at the obvious cost                                                                                                                                                                                                                           |

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
and `execute_code` accepts no erasable TypeScript
([decision history](https://github.com/zackbart/connecta/blob/main/decisions/0001-ethos-verdict-table.md)). The output half is the provider's declared
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
shared runtime template. The registry prepends Agent Skills frontmatter to
`content` and preserves the guide body, including its whitespace.
`summary` is normalized and refuses construction over 120 characters; absent,
Connecta derives the same bounded fallback the skills listing uses from the
guide's first meaningful body paragraph. `required: true` is reserved for
generic API wrappers and cross-operation conventions a complete downstream
schema cannot express.

Search and describe results carry a `guide: "connector:<id>"` pointer and a
`guideSummary`. A matching tool also carries `guideRequired: true` and
`guideRequiredReasons` when Connecta can prove review is necessary:

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

### Native Skills extension

Connecta declares `resources: {}` and `io.modelcontextprotocol/skills`, then
serves `skills/list`, `skills/get`, `resources/list` and `resources/read` from
the same registry as `skills` and `connecta.skill`. These methods return
`resultType: "complete"`, `ttlMs: 0` and `cacheScope: "private"`. Listing pages
contain at most five complete skills: usage first, required connector guides
next, other connector guides, downstream skills, then the investigation guide.
Subsequent pages use `cursor`/`nextCursor`. Local lookup works without listing.

The local document URIs are `skill://connecta/usage/SKILL.md` and
`skill://connecta/connectors/<slug>/SKILL.md`. A valid Agent Skills connector ID
is its slug; other IDs use `connector-` followed by a stable SHA-256 prefix.
The suffix makes each
document a valid Agent Skills file; the roots `skill://connecta/usage` and
`skill://connecta/connectors/<connector-id>` also resolve. Provider guides are
built from the generated `src/providers/*/SKILL.md` content with the existing
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
text-only. Successful direct calls with `resultMode` omitted or `"mcp"` return
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

| Bound                              | Value                              |
| ---------------------------------- | ---------------------------------- |
| Stashed result TTL                 | 15 minutes                         |
| `results.maxStashBytes`            | 8 MiB per shared storage ledger    |
| `results.maxStashEntries`          | 64 per shared storage ledger       |
| Top-level discovery result ceiling | 256,000 UTF-8 bytes                |
| Downstream MCP `isError` text      | 512 UTF-8 bytes plus an `…` marker |

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

Results belong to the authenticated subject whenever auth supplies a subject or
user id, independently of activity configuration, under the provider's namespace
when it has one and `connecta:auth:<provider kind>` otherwise. Keep subject ids
distinct within that namespace. An explicit principal is the fallback subject
when neither id is supplied, and open deployments and auth providers that supply
no identity share one partition. Each new stash also binds the principal,
endpoint/pool, request origin, connector, tool, and classification. A page must
match those bindings and pass current auth, connector/tool grants, pool membership,
and trust checks. Old entries lacking bindings fail closed. A random UUID is a
handle, never an access grant.

New entries store UTF-8 bytes in a base64 envelope split across storage keys,
48 KiB of result text per chunk — widening past roughly 1.5 MB so no result
occupies more than 33 keys, because every chunk is also a write. `connecta.result`
reads and decodes only the chunks a page covers plus a few boundary bytes, so
paging a 1.2 MB result costs the same per page as paging a 300 KB one; it
neither encodes nor reads the whole result per page. Entries without the required identity and invocation bindings fail closed,
including pre-upgrade single-key envelopes and raw-text entries. Offsets and `totalBytes` always describe the
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
JSON; everything after the first newline is the preview. `structuredContent`
is absent, so the notice cannot hide the preview in clients that prefer it:

```text
{"truncated":true,"resultId":"…","totalBytes":161420,"hint":"This write already ran: do not call it again to see its result. Bytes 0-24000 of 161420 follow; page the rest with connecta.result using nextAction.","nextOffset":24000,"nextAction":{"tool":"execute_code","arguments":{"code":"async () => await connecta.result(\"…\", { offset: 24000 })"}}}
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
inline byte cap, and 24,000 matches the program result boundary in
[code mode](./code-mode.md). A deployment whose
clients take more can raise the cap, and one whose clients take less can lower
it, per connector if need be; a result between 24,000 and 50,000 bytes that
used to arrive whole now pages. A client that spills rather than rejects keeps
the notice whatever its threshold, since the notice is the first few hundred
characters. One that rejects outright — Claude Code with
`MAX_MCP_OUTPUT_TOKENS` set below 12,500 — needs a cap under twice its limit.

The preview is the head of what `connecta.result` pages, cut on a character
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
read it in full, page with `connecta.result`. Inside a program the inline cap does
not apply to a host call's result, only to what the program returns (`L6` in
[code mode](./code-mode.md) bounds a host call far higher), so the reduction
sees the whole result at once. When the hint named paging alone, the eval's
weakest model read a 185 KB CI log in 24,000-byte pages, skipped the range
holding the real failure, and named the flaky test near the top; before the
notice was visible, it had reduced the log in a program and found the failure.
When paging is available, `nextAction` is the page handle for either kind of call, because paging is
the one next step connecta can spell out exactly, while a reduction is a
program the agent has to write. `resultId` stays beside the exact `nextAction`,
so the handle is actionable without copying an identifier out of prose.
Program results and oversized discovery responses carry no such route: paging a
program's return value is a refused shape, because a program can shrink
anything before it returns.

### Paging with connecta.result

Paging is a guest operation, never another top-level tool. A direct call's
notice carries a `resultId`, `nextOffset`, and an executable `execute_code`
recovery action. Read and reduce the result in one program:

```js
async () => {
  let text = "", offset = 0, page;
  do {
    page = await connecta.result("result-id", { offset, maxBytes: 8_000 });
    text += page.text;
    offset = page.nextOffset;
  } while (page.hasMore);
  return JSON.parse(text).items.map(item => item.id);
}
```

A page is `{ resultId, offset, bytes, totalBytes, hasMore, nextOffset?,
format: "text", text }`. The page size is clamped to the original call's inline
cap, with UTF-8 alignment and forward progress. Reassemble inside the sandbox;
returning pages unchanged can hit the program result cap. The admitted subject
and principal, endpoint/pool, request origin, connector, and tool bindings must
match. The host rechecks current access and trust before returning each page; a
read-only endpoint cannot read a write stash. Caller arguments select no partition.

A write on a read-only endpoint returns an inline truncation notice and any
usable bounded preview. It says paging is unavailable and the write already
ran; it carries no result handle or recovery action and stores no unreachable
stash. Write paging remains available on trusted endpoints.

A refused stash write cannot undo a downstream success. Both call tools return
a paging-unavailable notice, without a handle or recovery action. A write's
notice still says it already ran. Activity records success; operator logs receive
a fixed warning without storage error prose. Never repeat a write to recover output.

## Lexical discovery

`search_tools` and in-program `connecta.search` return the same flat discovery
page. Select tool rows from `page.tools`.
With the same schema format, schema-key option, and scoped registry, both paths
return identical data. Top-level search omits schemas unless requested; programs
default to JSON schemas and schema-key metadata.

```json
{
  "catalogErrors": [],
  "tools": [
    {
      "name": "get_issue",
      "address": "linear.get_issue",
      "connectorTitle": "Linear Production",
      "classification": "read",
      "schemaFormat": "json",
      "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
    }
  ],
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

Tool rows carry the address, configured display title when present, guide and
guide summary when available, and stored classification. Requested schemas have
`schemaFormat: "json"` for JSON Schema values or `schemaFormat: "text"` for
compact schema strings and TypeScript signatures. Compact schemas are text;
`inputSchema.properties` is meaningful only in JSON mode. Pagination counts
tools across connectors: `nextOffset` is present only when another page remains.

Search tokenizes tool names and descriptions at punctuation and camel-case
boundaries. Whole-token matches and a small set of inflectional variants preserve
recall without admitting arbitrary mid-word substrings. Document frequency weights
rare domain terms above ubiquitous action terms. Exact tool names and canonical
addresses rank first, so `get_issue` beats `get_issue_status` even when a
connector is named `issue`. Exact configured connector IDs, full display titles,
and recognized service names rank next. Complete lexical matches then precede
partial matches, with score and catalog order breaking ties.
An exact connector ID or title query browses that connector's tools, even when
individual tool names or descriptions mention that identity. Connector identity
terms that never occur in its tools need not be repeated in every tool description.

An explicit unknown `connector` scope returns no tools and an `absence` record:
`{ service, message, configuredConnectors }`. The message says
`No connector for "X" is configured for this endpoint.` Unscoped queries naming
recognized services such as GitHub, Linear, Mixpanel, Supabase, or PostHog do the
same when no visible connector ID or title names that service. This service-name
vocabulary is query interpretation, not an inventory of configured providers.
For other service names, use the explicit `connector` scope. An unavailable
catalog is a catalog failure, never an absence. Absence records and catalog
errors use only the endpoint/pool and grant intersection; a connector hidden by
that intersection is indistinguishable from an unconfigured one.

If no tool covers every search term, wider any-term fallback remains available
for ordinary action/object searches and the page carries `matchMode: "partial"`.
A service absence suppresses that fallback, so `GitHub get issue` cannot return
Linear issues or Mixpanel/Supabase projects. Tool rows expose no scores or
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
HTTP 401 or redirect before the SDK can refresh authorization or resend the call.
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
`input_required_unsupported`, and `input_required_round_limit` are non-retryable
typed failures.

Programs and in-process meta-tools return `input_required_unsupported`, with a
`nextAction` naming the equivalent direct call and bounded original arguments.
Programs never receive downstream state or prompts, and never restart to
fulfill downstream input.

## Authorization recovery

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

The host echoes `requestState` and its bare `inputResponses.connecta_auth`
response on the original `tools/call`. Accept re-runs the original call; it
does not prove browser consent completed. Decline or cancel ends without
dispatch, with `auth_declined` or `auth_cancelled`. Three prompts are allowed
within one ten-minute retry window, then `auth_round_limit` ends the flow.
Each state can be consumed once; concurrent or repeated retries are refused
before dispatch. A Continue link from a pending restart requires that restart
to start successfully before the browser can consume it.
Host-owned invocation facts record the auth failure's origin and entry into
all calls, including each classification, catalog freshness and classification
digest. Raw fetches and custom connector transports cannot establish recovery
eligibility. Each accept retry rechecks all previously entered reads before
restarting a program or direct call. A write classification, changed digest, or
stale catalog returns `auth_replay_refused` and reconciliation guidance.
Each round also checks its own invocation facts. Normal stale-fallback calls
retain their existing behavior.
An auth failure after a write handler or transport was entered keeps its
ordinary error code,
`retryable: false`, `reconciliationRequired: true`, and manual `/connect` guidance
where available. The write may have partially run; reconcile its target before
retrying after connection. Handler-authored error fields cannot clear this guard.

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

- `oauth`: an `authorizationUrl` to connecta's `/connect/<connector>?h=...` route
  and instructions to sign in as the initiating user;
- `operator_config`: an `operatorUrl` to the mounted connection UI, plus the
  declared credential label and field names/guidance; or
- `unavailable`: an honest deployment/configuration message.

The class follows what the connector declares, not how it was authored: a
`remoteMcp()` connection using `auth: { type: "credential" }` declares a slot
and no OAuth flow, so it uses `operator_config` when both vault and UI are
configured. Without either it returns `unavailable`, never a dead UI link.

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
way to call a tool. `call_tool` reaching an unannotated, write-capable, or
destructive tool returns `nextAction` for `call_destructive_tool` with the
canonical address, and so does the same call inside a program, unless config
marks that pool trusted. Nothing is executed by these records.

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

`repair` adds agent-only detail from that tool's published schema: accepted
keys, received JSON types, enum values, numeric/length/item bounds, and known
conditional requirements such as `dependentRequired` and `if`/`then`/`else`.
Its `example` is synthesized without submitted values and checked against the
same validator. Complex or unsatisfiable schemas get `exampleUnavailable`
rather than an invalid example. Synthesis detects recursive references and
shares a 128-node work budget. Alternative branches do not emit dependency
advice unless the branch condition is known. Repair detail has a 4 KiB budget; oversized
detail is withheld whole with `truncated: true`. Operator records still contain
only checked failure facts, never findings or examples.

Unknown-address errors list `configuredConnectors` from the current endpoint's
scoped registry, including an empty list when none are accessible. They never
list connectors from another pool or identity's grants.

A write that times out after dispatch returns `write_outcome_unknown` with
`retryable: false` and an agent-only `uncertainCall: { address, args?, argsOmitted?, argsRedacted? }`.
No write is automatically replayed. `args` may be partial reconciliation context
with `argsRedacted: true`. A withheld echo or arguments over the 512-byte budget
carry `argsOmitted: true`; sensitive or unresolved schemas also carry
`argsRedacted: true`. When `args` is absent or redacted, use the original
arguments if reconciliation requires another call. A timeout before dispatch remains `timeout`. Trusted
program write accounting keeps this detail even if the guest catches the
failure or returns early. Multiple uncertain writes use `uncertainCalls`,
bounded to ten calls with `uncertainCallsTruncated` when more exist.

Retryability comes from typed errors, HTTP status, registered OAuth error codes,
SDK timeout classes, and runtime network codes. Untyped prose is non-retryable:
"timeout", "temporarily unavailable", "rate limit", or "503" in a body, tool
name, or URL never changes the verdict. JSON-RPC `ProtocolError.data` is dropped
at the downstream boundary, even when the agent may see the error's message.

## Source and tests

Handlers and schemas live in [meta-tools.ts](https://github.com/zackbart/connecta/blob/main/src/meta-tools.ts).
[Catalog service](https://github.com/zackbart/connecta/blob/main/src/catalog-service.ts)
and [invocation](https://github.com/zackbart/connecta/blob/main/src/invocation.ts)
serve both direct tools and programs. [Skills](https://github.com/zackbart/connecta/blob/main/src/skills.ts)
owns the supplied usage instructions and connector guides.

[Schema tests](https://github.com/zackbart/connecta/blob/main/test/meta-tool-schemas.test.ts),
[search tests](https://github.com/zackbart/connecta/blob/main/test/meta-tools-search.test.ts),
[call tests](https://github.com/zackbart/connecta/blob/main/test/meta-tools-call.test.ts),
[skills tests](https://github.com/zackbart/connecta/blob/main/test/skills-extension.test.ts),
and [surface tests](https://github.com/zackbart/connecta/blob/main/test/code-first-surface.test.ts)
check the published contract. Guest parity and clause evidence are in
[code-mode verification](./code-mode.md#verification).
