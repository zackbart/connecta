# Provider conventions

The five maintained prebuilt connections grew one at a time, and until now
"excellent provider" meant whatever the last author thought. This document
writes the judgment down so it can be argued with, audited, and reused.

There are two genuinely different provider shapes, and one convention set
cannot honestly cover both:

- **Hand-written HTTP providers** — `api()` surfaces where Connecta owns every
  tool name, schema, projection, and error. Today: Cloudflare, Notion.
- **Hosted-MCP proxies** — `remoteMcp()` wrappers around a server somebody else
  operates, where the names, schemas, results, and error prose arrive as they
  are. Today: Linear, Stripe, Mixpanel.

The governing principle for every convention below is the same: **keep the
model that interacts with connecta as efficient as possible.** A convention
earns its place by reducing what an agent spends discovering, selecting,
calling, and reading. It does not earn its place by being tidy.

Nothing here overrides [ethos.md](../ethos.md). In particular, prebuilt
connections remain ordinary `Connector` instances with no extra privileges,
their annotations fill in downstream silence rather than replacing it, and no
tool is ever generated from a schema document.

## How to read a convention

Every convention is one rule, one reason, and one cost. The cost is drawn from
a fixed vocabulary of four, because those are the four things an agent actually
pays:

| Cost | What it means |
| --- | --- |
| **discovery tokens** | bytes the agent reads before it can call anything |
| **wrong-tool selection** | it picked the wrong tool, connector, or mode |
| **argument retries** | the call was made and rejected, so it must be made again |
| **result size** | bytes the agent reads back, and the round trips paging them |

A convention that cannot name one of those four is a preference, not a
convention, and does not belong in this document.

## What discovery actually shows

Several conventions are budgets, and the budgets are not arbitrary — they are
the points at which Connecta's own surface starts dropping characters on the
floor. From `src/catalog.ts` and `src/catalog-service.ts`:

- **A tool description is cut to 160 characters in `search_tools`** and to 240
  in the describe path, both with a trailing `…`, unless the caller asks for
  full descriptions. Prose past those points is written for nobody.
- **A compact schema renders into at most 1,024 UTF-8 bytes**, and any single
  enum node into at most 256. Past either cap the renderer keeps what fits and
  degrades the rest — a prefix of the enum plus `unknown`, a required-first
  object with `unknown` types, or `unknown /* truncated */` — and flags the
  match, which costs a describe round trip to recover.
- **`inputKeys`, `requiredInputKeys`, and `outputKeys` come only from bounded
  plain-object schemas.** A top-level `anyOf` has no keys to list, so a caller
  learns nothing about the arguments without expanding the schema.
- **A guide summary is capped at 120 characters**, defaulting to the guide's
  first meaningful body line.
- **Search returns a connector's `id`, `title`, `guide`, and `guideSummary` —
  never its `description`.** The description reaches an agent only as the
  fallback summary for a guide with no usable body line. Routing facts belong
  in the title and the guide's first line; a routing fact that lives only in
  the connector description has been written into a field the model does not
  read.

Two construction-time checks already enforce the floor beneath all of this:
`Registry.checkConventions()` warns about a connector with no description, and
about a static tool with no description or no `inputSchema`.

## Hand-written HTTP providers

Connecta owns the whole surface here, which means every miss is ours. These
apply to `api()`-based prebuilt connections (Cloudflare, Notion) and are the
bar any future one is written to.

### H1 — Identity is deployment-owned; the provider supplies everything else

The constructor takes an `id`, a required `purpose`, an optional `title`, and
optional `instructions` appended to — never replacing — the maintained guide.
A blank `purpose` throws at construction.

*Why:* an agent choosing between two instances of the same provider has only
the title and the guide summary to choose from. *Cost:* wrong-tool selection.

### H2 — Names are `verb_object`, and the verb is the safety class

`snake_case`, a leading verb from the small set the surface already uses
(`list_`, `get_`, `search_`, `create_`, `update_`, `delete_`, plus a provider's
own vocabulary such as `purge_` or `trash_`), and a noun that matches the
provider's own word for the thing. A read never opens with a write verb, and a
write never hides behind a neutral one. Escape hatches are named
`<provider>_api_<class>` so they sort together and read as generic.

*Why:* the name is the only thing lexical search indexes besides the
description, and it is what an agent skims first. *Cost:* wrong-tool selection.

### H3 — The selection sentence fits in 160 characters; the whole description in 240

Sentence one says what the tool returns or does, in the imperative, and is
complete inside 160 characters (roughly 40 tokens). Everything else — the
constraint, the disqualifier, the handoff — fits in the remaining 80 characters
(240 total, roughly 60 tokens). Detail that does not fit belongs in a property
description or the usage guide, both of which are fetched only when needed.

*Why:* search cuts at 160 and describe at 240, so a longer description is
paid for in authoring effort and delivered to no one. *Cost:* discovery tokens.

### H4 — The description names the disqualifier, not the pitch

Say what the tool will not do when an agent is likely to assume it does:
`search` "finds pages and data sources by **title**. Never searches content."
One clause of honest negative space outperforms three of capability.

*Why:* the cheapest wrong call is the one never made. *Cost:*
wrong-tool selection.

### H5 — Input schemas are complete, closed, and bounded

Every tool carries a hand-written `inputSchema`: a plain object at the top
level, `additionalProperties: false`, an accurate `required` list, an `enum` on
every constrained field, explicit numeric bounds on every page size and count,
and a description on every property. `strictValidation: true`, so a schema the
validator cannot evaluate fails the call rather than silently admitting
unvalidated input — in a surface we wrote ourselves, an unevaluable schema is
our bug.

*Why:* a complete schema is the difference between one call and a call, a
rejection, and a repair. *Cost:* argument retries.

### H6 — A local bound says whose bound it is

When a schema's bound is the provider's, the description says so; when the
bound is narrower than the provider's, the description says that too. A local
cap that an agent is told about beats a page size that fails somewhere inside
the provider — but only if the agent is told.

*Why:* an unexplained refusal reads as a bug and gets retried. *Cost:*
argument retries.

### H7 — Schemas fit the compact renderer, or selection does not depend on the part that is cut

Keep the common path's compact input and output shapes inside 1,024 bytes and
each enum node inside 256. Where a legitimate enum genuinely cannot fit — 21
DNS record types — the truncation is acceptable only if the tool's name and
description already carry enough for selection, so the caller expands the
schema to *call*, not to *choose*.

*Why:* a truncated compact shape costs a describe round trip. *Cost:* discovery
tokens.

### H8 — Every tool declares an `outputSchema`

Declared outputs are what produce `outputKeys` and the `fields` projection's
`availableFields`, and they let a program reduce a result without first
fetching one to look at. Connecta measured undeclared output schemas at 0/30
and 3/30 on real deployments; a maintained provider has no excuse to join them.

*Why:* an agent that knows the shape projects before it reads. *Cost:* result
size.

### H9 — Every read projects, and says what it dropped

Reads return the provider's payload flattened and renamed, with plan,
permission, and presentation noise removed. Where the dropped detail can
matter, the tool takes `raw: true` and returns the untouched response; where
the provider itself truncated something, the projection surfaces that fact and
the id needed to fetch the rest, rather than handing back a confident partial.
The argument and result vocabulary is consistent within a connector, and the
mapping from the provider's own names is either identity or one mechanical rule
stated in the guide.

*Why:* projection is the largest single lever on what an agent reads, and a
silent truncation is worse than a large result. *Cost:* result size.

### H10 — Pagination is one convention per connector, with one field to branch on

List tools take an explicit page argument and a cursor, default to a page size
smaller than the provider's maximum because a first read should be cheap, and
return exactly one branchable signal — `hasMore` beside a cursor. Cursors are
opaque: passed back verbatim, never parsed or constructed. Where an endpoint
paginates differently from the rest of the connector, the schema and the guide
both say so instead of letting an agent discover it.

*Why:* the loop condition should not be a research project. *Cost:* result size.

### H11 — Errors are mapped to what the caller does next

The typed failure code is chosen by the caller's next move, not by the
provider's name for what happened: an authorization gap an operator must fix is
not `auth_required` if `authorize_connector` cannot fix it; a retryable failure
carries `retryAfterMs` when the provider says how long; an ambiguous provider
code gets a message that states the ambiguity rather than picking the
convenient reading. A call that can only fail is refused locally as
`invalid_args` before the round trip. Provider error prose is never parsed to
invent a classification.

*Why:* a misrouted error sends an agent down a recovery path that cannot
succeed. *Cost:* argument retries.

### H12 — One operator credential, one cheap test, no probing

The connection declares its credential slot with a labeled field per secret and
implements `testCredential`/`testCredentials` with the cheapest call that proves
the secret is live, reporting the identity or workspace it authenticated as.
Connecta does not check credentials behind an operator's back; the test runs
when a human asks, and everything else fails loudly at use.

*Why:* "which account is this?" answered once at configuration time is a
question no agent has to answer by calling something. *Cost:* wrong-tool
selection.

### H13 — The guide carries only what a schema cannot

`usageGuide` uses the structured form: `content`, an explicit `summary`, and
`required: true` only when correct use depends on a sequence or convention no
complete schema can express. Imperative bullets, decision first, exact tool and
argument names, constraints with their numbers. The first content line is the
routing fact, because it is the summary fallback. Nothing in the guide restates
a schema.

*Why:* the guide is fetched into a live context window, so every line that
repeats a schema is paid for twice. *Cost:* discovery tokens.

### H14 — A named tool must beat the escape hatch, and the escape hatch splits by safety

Guarded raw access is an accepted shape, not a required one — a small provider
whose surface is genuinely finite may deliberately have none, and say so. Where
a provider is large and fast-moving enough to need one, it is split by safety
class: a GET-only tool that is explicitly read-only, a JSON mutation tool that
is always destructive, and an upload tool that is always destructive. The split
is Connecta's, never an agent-supplied HTTP method. Paths are provider-relative
and confined; the connector owns authentication, host, content type, and
framing. This is not schema ingestion — a fixed handful of stable tools, never
one per operation — and a *named* tool earns its place only by beating the
hatch on schema, projection, or safety routing.

*Why:* every named tool costs catalog bytes forever, and a thin wrapper around
a call the hatch already makes costs them for nothing. *Cost:* discovery
tokens.

## Hosted-MCP proxies

Here the downstream owns the tool names, descriptions, input schemas, result
shapes, pagination, and error prose. Conventions that legislate those things
would be fiction. What Connecta owns is the endpoint, the credential, the
classification, the connector's own identity, the guide, and the budget — so
that is what these conventions cover.

### P1 — Normalize by adding, never by rewriting

A proxy may add annotations, a title, a guide, and an admission policy. It does
not rewrite a downstream tool's name, description, or schema, and it does not
re-shape a downstream result. A rewritten description drifts silently away from
the schema it describes, and the agent believes the description.

*Why:* the catalog must stay a true report of what the downstream will accept.
*Cost:* argument retries.

### P2 — Identity is deployment-owned

Identical to H1: `id`, required `purpose`, optional `title`, and `instructions`
appended to the maintained guide, never replacing it, and never able to change
the safety classification.

*Why:* two instances of the same provider are told apart only by title and
guide summary. *Cost:* wrong-tool selection.

### P3 — The fact that decides routing goes in the title and the guide's first line

Whichever variant an agent must not get wrong — production versus sandbox,
read-only versus read-write, region, account — appears in the default `title`
and as the first content line of the guide. It may also appear in the
`description`; it may never appear *only* there, because search never returns
the description.

*Why:* the model reads title and guide summary at browse time and nothing else.
*Cost:* wrong-tool selection.

### P4 — Endpoint selection is a constructor option with the safest honest default

Where the provider publishes more than one endpoint, the option selects between
them and the default is the safe one. Where the provider publishes one endpoint
and the environment rides the credential, the mode is required with no default,
and construction throws when a recognizable credential contradicts the declared
mode. Deprecated transports stay unreachable.

*Why:* a provider-enforced scope limit is a stronger guarantee than any
annotation Connecta applies, and a wrong-mode write is not recoverable by
retrying. *Cost:* wrong-tool selection.

### P5 — Classification is a reviewed allowlist that fails closed

Reads are listed by name, writes are listed by name with their destructive
verdict, and anything unlisted is not read-only. The lists are supersets:
hosted catalogs vary by plan and feature flags, so a classified name a
workspace never returns costs nothing while an unclassified new one fails
closed onto `call_destructive_tool`. The classification fills in downstream
silence and otherwise preserves explicit annotations, with the single
fail-closed exception the ethos records — a release-reviewed destructive
verdict outranks a contradictory `readOnlyHint: true`. An additive write leaves
`destructiveHint` unset.

*Why:* the fail-closed read-only invariant is not negotiable, and inflated
destructive copy trains humans to approve without reading. *Cost:* wrong-tool
selection.

### P6 — The guide says the catalog is not a fixed set

The guide tells the agent to search this connector for what the workspace
actually exposes rather than assuming a documented tool exists, and names the
plan- or beta-gated areas where absence is expected.

*Why:* a hosted catalog varies per account, and an agent that assumes ours is
complete spends calls proving it is not. *Cost:* wrong-tool selection.

### P7 — The guide carries the reduction advice the schemas cannot

A proxy cannot project a downstream result, so the guide tells the agent to
page with the cursor rather than raising the page size, and to reduce inside
`execute_code` before returning anything. Structured form, explicit `summary`,
`required: true` only for a genuine cross-tool sequence or a generic wrapper.

*Why:* the only projection available is the one the program writes. *Cost:*
result size.

### P8 — Identity resolution comes before action

Where a downstream's write arguments take ids, the guide names the read tools
that produce them and says not to guess. Where the provider has a
human-readable identifier alongside a UUID, the guide says which is which.

*Why:* a guessed id is a call, a rejection, and a repair. *Cost:* argument
retries.

### P9 — Authentication defaults to OAuth, with a documented headless alternative

OAuth per connector instance, stored in connector-scoped storage, is the
default. The provider's own headless credential — a personal API key, a
restricted key, a service account — is supported through explicit `headers`
auth, documented as a secret rather than configuration, and paired with the
narrowest mode the deployment can use. `requireHttps` is set. Recovery from an
expired authorization is the ordinary `auth_required` → `authorize_connector`
route.

*Why:* one route back from an expired credential is what keeps a failed call
from becoming an abandoned task. *Cost:* wrong-tool selection.

### P10 — Declare an admission budget only when the provider documents a number

Where the provider publishes a rate limit, transcribe it as a rolling-window
budget and say in the guide that it is a per-runtime approximation, not an
enforcement. Where the provider documents nothing, or documents a limit metered
per user in a way a per-runtime counter cannot approximate, declare no budget
and leave the number to the operator who knows the account — with a documented
example of how to supply one. A `maxConcurrency` beside a budget is a choice
Connecta made and is labeled as one.

*Why:* a hardcoded ceiling either throttles a healthy deployment or fails to
protect a busy one, and both look like the provider being flaky. *Cost:*
argument retries.

### P11 — A drifting downstream must be visible, not absorbed

The classification lists name what a release reviewed. When the downstream
changes underneath them, the correct outcome is a loud unclassified tool on the
approval path and a maintained record of the drift — never a quiet re-guess.
Detection during catalog refresh is
[#343](https://github.com/zackbart/connecta/issues/343) and the maintainer-run
check is [#351](https://github.com/zackbart/connecta/issues/351); this
convention is what they are checking against.

*Why:* an allowlist nobody can tell is stale is an allowlist that is wrong.
*Cost:* wrong-tool selection.

## What the audit checks

The provider audit ([#342](https://github.com/zackbart/connecta/issues/342))
runs this document against each of the five providers and returns a verdict per
convention: **meets**, **misses** (with the fix), or **not applicable** (with
the reason). A convention is never quietly skipped, and an accepted miss is
recorded as a provider-specific exception with its argument, not left blank.

Hand-written providers are audited against H1–H14; hosted-MCP proxies against
P1–P11. Applying a hand-written convention to a proxy is a category error, not
a finding.

Most of the bar is mechanically checkable against the shipped surface rather
than by reading:

| Convention | Mechanical check |
| --- | --- |
| H1, P2 | constructor throws on a blank `purpose`; `instructions` appear appended to the guide |
| H2 | every tool name matches `^[a-z][a-z0-9_]*$` and opens with a verb from the connector's own set |
| H3 | first sentence ≤ 160 characters; whole description ≤ 240 |
| H5 | every tool has an `inputSchema` that is a closed plain object with a `required` list and a description on every property; the connector sets `strictValidation: true` |
| H7 | every compact input and output render stays inside 1,024 bytes, or the tool is on a recorded exception list |
| H8 | every tool declares an `outputSchema` |
| H9 | every read either projects or documents why it does not; `raw: true` exists wherever the projection drops something recoverable |
| H10 | every list tool has bounded page arguments, a default below the provider maximum, and exactly one `hasMore`-shaped signal |
| H11 | every mapped provider status has a test asserting the resulting code and retryability |
| H12 | `credential` declared with labeled fields, and `testCredential`/`testCredentials` implemented |
| H13, P7 | `usageGuide` uses the structured form with an explicit `summary`; `required` is set only with a stated reason |
| H14 | escape hatches split GET / JSON-mutate / upload, and the GET tool is annotated read-only |
| P1 | the wrapper's `listTools` changes annotations only |
| P3 | the routing fact appears in the default `title` and the guide's first content line |
| P4 | endpoint or mode option exists, with the documented default (or no default, where none is safe) |
| P5 | reads and writes are named lists; an unlisted tool resolves to not-read-only; a reviewed destructive name beats a contradictory `readOnlyHint: true` |
| P6, P8 | the guide contains the catalog-varies note and the id-resolution rule |
| P9 | `auth` defaults to OAuth and `requireHttps` is set |
| P10 | a declared budget matches a citable documented limit, or the absence is justified in the guide |
| P11 | classification lists are maintained in one place per provider, addressable by a drift check |

The remainder — H4, H6, and the judgment in H14 about whether a named tool
beats the escape hatch — is a reading, and the audit reports it as one. The
Cloudflare keep/prune half of that judgment belongs to
[#350](https://github.com/zackbart/connecta/issues/350), which measures the
named surface with usage evidence; this document only supplies the test it is
measured against.

Each provider's own guide ([Cloudflare](./cloudflare.md),
[Linear](./linear.md), [Mixpanel](./mixpanel.md), [Notion](./notion.md),
[Stripe](./stripe.md)) is part of the audited surface: documentation moves with
the work, and a guide describing a surface that shipped differently is itself a
miss.
