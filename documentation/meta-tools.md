# Meta-tools

Connecta keeps one small tool surface in model context and resolves downstream
tools behind it. `search_tools` finds addresses, the call tools enforce safety
annotations, and `get_result` pages bounded results.

## Which surface a deployment serves

The `executor` decides it, and there is nothing else to configure
([#224](https://github.com/zackbart/connecta/issues/224)):

| | `tools/list` | Discovery breadth and batching |
| --- | --- | --- |
| **executor configured** | seven: `execute_code`, `search_tools`, `call_tool`, `call_destructive_tool`, `authorize_connector`, `get_result`, `skills` | `connecta.search`, `connecta.describe`, `connecta.batch` inside a program |
| **no executor** | nine: the above minus `execute_code`, plus `list_connectors`, `describe_tools`, `batch_call` | those three top-level tools |

Code-first is what a model sees. Four overlapping ways to reach one connector
became two: `search_tools` then `call_tool` for a single cold read — measurably
cheaper direct than through a program — and `execute_code` for everything wider.
The fold is worth 19.6% of the serialized tool definitions measured against the
ten-tool shape an executor-backed deployment used to serve — 10,675B to 8,587B —
and, more durably, one fewer routing decision a model makes before doing any
work. Note which baseline that is: the executor-free nine serialize to 7,207B,
so the seven-tool surface is *larger* than the row below it in that table. It
buys the program with those bytes. The [guest API contract](./code-mode.md) is
what a program is promised.

Classic is the compatibility surface: what an executor-free deployment
necessarily serves, since the program surface the fold depends on is not there.
It is supported and tested, not an equal citizen in the docs. `surface:
"classic"` beside an executor is the only override; it produces the ten-tool
shape the [eval gate](../eval/code-first-gate/README.md)'s *incremental* arm
measures. That gate's control arm is executor-free classic and needs no
override.

Nothing became unreachable. `connecta.describe` takes the same addresses and
formats as `describe_tools`, `connecta.batch` runs the same 1–10 parallel
read-only calls as `batch_call` and returns the same typed outcomes, and an
unfiltered `connecta.search({})` browses every catalog a program can reach —
the part of `list_connectors` a model used. Live connector probing was the rest
of it, and that is an operator concern: the operator pages and `/health` own it.

## Discovery context

Start an unknown-address lookup with two to four distinctive action/object
terms, not the full request, and omit `limit` so the default eight-result page
stays small. `includeSchemas: "compact"` adds each match's input and any
declared output shape; matches also carry declared behavior annotations. When
that shape is sufficient, call the returned address directly. Reserve schema
expansion — `connecta.describe` in a program, `describe_tools` on the classic
surface — for a search without schemas, an ambiguous compact shape, or exact
constraints that require `format: "json"`.

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
