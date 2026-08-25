# Provider conventions

The six maintained prebuilt connections grew one at a time, and until now
"excellent provider" meant whatever the last author thought. This document
writes the judgment down so it can be argued with, audited, and reused.

There are two genuinely different provider shapes, and one convention set
cannot honestly cover both:

- **Hand-written HTTP providers** — `api()` surfaces where Connecta owns every
  tool name, schema, projection, and error. Today: Cloudflare, Notion.
- **Hosted-MCP proxies** — `remoteMcp()` wrappers around a server somebody else
  operates, where the names, schemas, results, and error prose arrive as they
  are. Today: Linear, Stripe, Mixpanel, RevenueCat.

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
  in the describe path, both with a trailing `…`, unless the caller passes
  `fullDescriptions: true`. Prose past those points reaches an agent only when
  it pays for the expansion.
- **A compact schema renders into at most 1,024 UTF-8 bytes**, and any single
  enum or constraint annotation into at most 256. Numeric bounds, string
  length bounds, patterns, and formats ride beside their TypeScript-like type.
  Past a cap the renderer keeps what fits and degrades the rest — a prefix of
  the enum plus `unknown`, a shape without the constraints that did not fit, a
  required-first object with `unknown` types, or
  `unknown /* truncated */` — and flags the match, which costs a describe
  round trip to recover.
- **`inputKeys`, `requiredInputKeys`, and `outputKeys` come only from bounded
  plain-object schemas.** A top-level `anyOf` has no keys to list, so a caller
  learns nothing about the arguments without expanding the schema.
- **A guide summary is bounded at 120 characters.** A configured value past
  the bound refuses construction. An omitted one defaults to the guide's first
  meaningful body paragraph, joined across physical line wraps and shortened
  at a readable boundary.
- **Search returns a connector's `id`, `title`, `guide`, and `guideSummary` —
  never its `description`.** The description reaches an agent only as the
  fallback summary for a guide with no usable body paragraph. Routing facts belong
  in the title and the guide's opening paragraph; a routing fact that lives only in
  the connector description has been written into a field the model does not
  read. Neither the `id` nor the `title` is a lexical document, so a term drawn
  from one of them is not a search hit — it is a no-match whose guidance names
  the connector and points at a scoped browse.

Two construction-time checks enforce the floor beneath all of this. The hard
one is `api()` itself: since
[#340](https://github.com/zackbart/connecta/issues/340) a hand-written tool
throws unless it carries a non-empty description, an explicit boolean
`annotations.readOnlyHint`, and an `inputSchema` — where it declares one — the
validator can compile. The soft one is `Registry.checkConventions()`, which
warns about a connector with no description, and about a static tool from any
other source with no description or no `inputSchema`.

## Hand-written HTTP providers

Connecta owns the whole surface here, which means every miss is ours. These
apply to `api()`-based prebuilt connections (Cloudflare, Notion) and are the
bar any future one is written to.

None of them asks an author to re-derive transport safety. URL confinement,
query and body construction, `ctx.signal`, redirect refusal, credential
shadowing, bounded response reads, and network-failure normalization are the
[guarded fetch transport](./connectors.md#the-guarded-fetch-transport)'s job
([#341](https://github.com/zackbart/connecta/issues/341)). What the conventions
below still demand — H11's error mapping and H12's credential test above all —
is the provider knowledge no shared helper can hold.

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
description, and it is what an agent skims first. A connector's `id` and
`title` are displayed, not indexed — a search for one of them matches no tool,
and the miss is answered by guidance naming that connector rather than by a
ranked result. *Cost:* wrong-tool selection.

### H3 — The selection sentence fits in 160 characters; the whole description in 240

Sentence one says what the tool returns or does, in the imperative, and is
complete inside 160 characters (roughly 40 tokens). Everything else — the
constraint, the disqualifier, the handoff — fits in the remaining 80 characters
(240 total, roughly 60 tokens). Detail that does not fit belongs in a property
description or the usage guide, both of which are fetched only when needed.

*Why:* search cuts at 160 and describe at 240 unless the caller passes
`fullDescriptions: true`, so anything past the budget is delivered only to an
agent that spends a second, larger read to get it. *Cost:* discovery tokens.

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
explicit string bounds where length or shape is constrained, and a description
on every property — nested objects and array items included,
because a caller composing an array element is reading that element's fields,
not the parent's prose. `api()` enforces the enforceability half for free since
[#340](https://github.com/zackbart/connecta/issues/340): a schema the validator
cannot compile throws at construction, and one that only reveals itself on
first use fails the call rather than silently admitting unvalidated input — in
a surface we wrote ourselves, an unenforceable schema is our bug.

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
each enum or constraint annotation inside 256. Numeric and string constraints
render when they fit. Search drops complete constraints that do not fit and
sets the existing truncation flag; compact describe keeps them. Where a
legitimate enum genuinely cannot fit — 21 DNS record types — the truncation is
acceptable only if the tool's name and description already carry enough for
selection, so the caller expands the schema to *call*, not to *choose*.

*Why:* a truncated compact shape costs a describe round trip. *Cost:* discovery
tokens.

### H8 — Every tool declares an `outputSchema`

Declared outputs are what produce `outputKeys` and the `fields` projection's
`availableFields`, and they let a program reduce a result without first
fetching one to look at. Connecta measured *declared* output schemas at 0 of 30
tools on one real deployment and 3 of 30 on another
([#282](https://github.com/zackbart/connecta/issues/282)) — nearly every tool an
agent meets is a shape it can only learn by calling. A maintained provider has
no excuse to join that majority.

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

**A downstream 404 is `not_found` — when the provider means it.** The code
exists because the next move is none of the others': you do not wait, you do
not send the agent to `authorize_connector`, you do not repair the argument
object. You re-address — look the id up again, or accept the absence and carry
on — and a program looping over ids inside `execute_code` can continue past
`not_found` where `connector_call_failed` would have to abort the run, reading
the code off a `connecta.batch` entry's `errorDetails` rather than off a caught
error, which the guest bridge has already stripped to prose. That
control-flow difference is the H11 test being met; it is not a label for the
cause.

The qualifier is the whole rule. Map a status to `not_found` only where the
provider distinguishes absence from a permission gap. Where it does not —
Notion returns `object_not_found` both for an object that is gone and for one
that was never shared with the integration, and will not say which — the honest
code stays `connector_call_failed` (or `auth_required`, where a credential
really is the fix) and the message states the ambiguity, exactly as the
paragraph above requires. Cloudflare is the other side of the pair: a token
that may not touch a resource is refused with 401 or 403, so its 404 is an
absence and maps to `not_found`. Neither connector's mapping changed shape when
the code arrived; one of them changed codes.

Two boundaries. `not_found` is about a resource the *downstream* owns: an
address connecta cannot resolve is already framed as `unknown_address` or
`unknown_tool` and never reaches a connector. And it never appears on the
hosted-MCP proxy path, because `P1` forbids re-shaping downstream framing and
prose is never parsed to invent a classification — a proxied server's own
missing-resource error arrives as that server wrote it. The two paths do not
diverge on the rule; they diverge on who is entitled to apply it, which is the
same split every other code already has.

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
fail-closed exception the [ethos](../ethos.md) accepted-prebuilt row records
([#315](https://github.com/zackbart/connecta/issues/315)) — a release-reviewed
destructive verdict outranks a contradictory `readOnlyHint: true`, because that
release independently established that the tool mutates existing state. An
additive write leaves `destructiveHint` unset.

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
`execute_code` before returning anything — and, where a value's rendering is
the provider's rule rather than the schema's, what that value means: Mixpanel
renders an absent boolean property as `false` in a breakdown, so the guide
says to confirm presence before reading `false` as a signal
([#430](https://github.com/zackbart/connecta/issues/430)). Structured form,
explicit `summary`, `required: true` only for a genuine cross-tool sequence or
a generic wrapper.

*Why:* the only projection available is the one the program writes, and a
value the schema types correctly can still mislead without the provider's
rendering rule beside it — the agent then re-queries to explain a signal that
was never there. *Cost:* result size.

### P8 — Identity resolution comes before action

Where a downstream's write arguments take ids, the guide names the read tools
that produce them and says not to guess. Where the provider has a
human-readable identifier alongside a UUID, the guide says which is which.

*Why:* a guessed id is a call, a rejection, and a repair. *Cost:* argument
retries.

### P9 — Authentication defaults to OAuth, with a documented headless alternative

OAuth per connector instance, stored in connector-scoped storage, is the
default. The provider's own headless credential — a personal API key, a
restricted key, a service account — is supported two ways: explicit `headers`
auth, documented as a secret rather than configuration, and `{ type:
"credential" }`, which declares an operator slot and takes the same secret from
`/credentials` instead. Either way it is paired with the narrowest mode the
deployment can use, and the framing matches the provider's *published* contract
for the MCP endpoint — not a convention borrowed from that provider's other
APIs, and not this repository's earlier example, which is the same claim wearing
a circle. `requireHttps` is set. Recovery from an expired authorization is the
ordinary `auth_required` → `authorize_connector` route, which returns the
consent URL for OAuth and the `/credentials` handoff for a declared slot.

*Why:* one route back from an expired credential is what keeps a failed call
from becoming an abandoned task. *Cost:* wrong-tool selection.

### P10 — Nothing probes a credential unasked; a declared slot may be tested on request

A proxy declares an operator credential slot exactly when its auth is `{ type:
"credential" }`, and then it inherits H12 whole
([#439](https://github.com/zackbart/connecta/issues/439)). The other two shapes
declare no slot and hold nothing for the credentials page: OAuth lives in
connector-scoped storage and is exercised by the authorization flow itself,
while a `headers` key arrives as deployment configuration. H12 is owed in every
shape, and a proxy pays it in two places that do not depend on a slot:
construction throws when a recognizable credential contradicts the declared mode
(P4) — a check a vault-managed key cannot get, because there is nothing in the
deployment file to read — and a dead, revoked, or absent credential fails loudly
at use as `auth_required` with the `authorize_connector` route attached (P9).

`testCredential` exists only behind the operator-pressed Test action on
`/credentials`, and only for a declared slot. It connects with the stored value
and reports how many tools the downstream served, which is the whole honest
check for a proxy: which account, project, or mode a key reaches is the
provider's answer, not Connecta's. That is not the shape
[#179](https://github.com/zackbart/connecta/issues/179) removed. What was
removed is the *unasked* probe — a liveness call every deployment pays on a
schedule or at startup to answer a question only a misconfigured one has. A
human clicking Test has asked, `api()` has had that button since the vault
existed, and nothing here probes on its own: no timer, no warmup, no check on
the read path.

*Why:* an unasked-for liveness probe spends a call on every deployment to answer
a question only a misconfigured one has; a requested one spends a call the
person requesting it chose. *Cost:* result size.

### P11 — Connecta classifies the transport; the downstream owns the tool error

Connecta maps what it can see from outside the tool: an authorization failure to
`auth_required`, a session or scope teardown, a timeout, and a capability the
proxy will not relay (`input_required`, task-required execution) to an explicit
refusal that says so. A tool-level failure the downstream returns — a validation
complaint, a not-found, a plan restriction — is passed back as it arrived. The
proxy does not read downstream error prose to invent a Connecta classification,
and does not repackage a downstream error as `invalid_args`, because it has no
schema of its own to have validated against. Where a downstream reliably reports
a retryable condition, the guide says how to recognize it rather than the code
guessing.

*Why:* a transport failure and a rejected argument need different next moves,
and prose-sniffing routes the second one down the first one's path. *Cost:*
argument retries.

### P12 — Declare an admission budget only when the provider documents a number

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

### P13 — A drifting downstream must be visible, not absorbed

The classification lists name what a release reviewed, and they are the
manifest the runtime drift check compares against — one structure per provider,
built once by `vettedCatalog()` and used both to classify and to compare, so
the annotation a caller gets and the verdict a check reads can never disagree.
When the downstream changes underneath them, the correct outcome is a loud
unclassified tool on the approval path and a maintained record of the drift —
never a quiet re-guess. The runtime half is
[the runtime drift policy](#the-runtime-drift-policy) below; the release-time
half is [the maintainer-run drift check](#the-maintainer-run-drift-check).

*Why:* an allowlist nobody can tell is stale is an allowlist that is wrong.
*Cost:* wrong-tool selection.

## The runtime drift policy

Detection rides a refresh; it never causes one
([#343](https://github.com/zackbart/connecta/issues/343)). The comparison
happens inside the wrapper's `listTools`, on the listing the downstream just
returned to serve a request the deployment already made, before the
classification is applied — so what it reads is the downstream's own word, not
connecta's fill-in. There is no scheduled job, no background request, no
credential probe, and no automatic issue filing. Proactive credential liveness
stays removed ([#179](https://github.com/zackbart/connecta/issues/179)); this
is the shape that does not become it.

**What a manifest holds.** Every tool name a release reviewed, the verdict it
reviewed it as (`read-only`, `additive`, `destructive`), and — where a release
actually read them — a digest of that tool's input and output schemas. Today
three of the four proxies ship names and verdicts and no digests, because no
release has read a live schema and written it down, and an invented digest reports a
change that never happened. `npm run drift:check -- --record` reads them from a
live catalog and prints the block a release pastes in; until a release does,
a manifest without digests counts no schema changes, which is the honest answer
rather than a silent zero.

**What it counts.** Four categories, and only counts:

| Category | What it means |
| --- | --- |
| unclassified additions | the downstream serves a tool no release classified; it already fails closed onto `call_destructive_tool` |
| names no longer served | a classified name is absent from this catalog |
| annotation conflicts | the downstream *explicitly* contradicts a vetted verdict — `readOnlyHint: false` or `destructiveHint: true` on a vetted read, `readOnlyHint: true` on a vetted write |
| schema changes | a recorded digest no longer matches the schemas that arrived |

Silence is never a conflict: filling it in is what the classification is for.
A non-zero "no longer served" count is the expected reading on a plan-gated
workspace, because P5's lists are deliberate supersets — it is triage input,
not an alarm.

**Where it surfaces.** Connector status carries the counts and the time they
were observed; `/health` carries the same per connector, which is where
`connecta doctor` reads them, and doctor reports drift without failing on it.
Both reads are projections — four counts and a bounded timestamp, rebuilt from
whatever the connector seam returned, because `/health` is unauthenticated and
`Connector.catalogDrift()` is third-party code.
One activity event per *change* in the counts — an identical report every TTL
is a heartbeat, not news — carrying the connector id and four integers. The
event type has nowhere to put a tool name, a schema, an argument, a result, or
downstream error prose, which is the same construction guarantee the tool-call
event makes. Which tool drifted is deliberately absent from the runtime: it is
answered by the maintainer-run check, with a live catalog in front of it.

**How far an observation reaches.** One runtime, and no further. The
observation lives in the isolate or process that served the refresh; unlike the
catalog, it is not persisted, so nothing carries it across a Workers isolate, a
restart, or a second Node process. Status and `/health` therefore answer for
the instance that took the request: on Workers a `connecta doctor` run will
usually land on an isolate that has served no refresh and print nothing, and
behind more than one process it is a coin flip. Read an empty report as *this
runtime has observed nothing*, never as *nothing drifted* — the durable record
of a finding is the activity event a sink already stored, and naming the tool
is still the maintainer-run check's job.

**What a finding obliges.** A contradicted vetted verdict — the downstream
calling a release-reviewed destructive tool `readOnlyHint: true`, or a vetted
read `destructiveHint: true` — blocks that provider's next release until a
human has re-reviewed the tool. Everything else enters ordinary issue triage.
No finding changes what a caller may reach: an unclassified tool fails closed
whether or not anybody noticed it arrived.

## The maintainer-run drift check

`npm run drift:check` is the other half
([#351](https://github.com/zackbart/connecta/issues/351)): a human at a laptop,
before a release, with local credentials and the published specifications in
front of them. It lives in
[`scripts/drift-check.mjs`](https://github.com/zackbart/connecta/blob/main/scripts/drift-check.mjs) and ships nowhere —
`scripts/` is outside the package, no runtime module imports it, and nothing it
reads becomes a runtime input.

**Hosted-MCP catalogs.** `--hosted` lists each proxy's live catalog with the
maintainer's own key and diffs it against the same `vettedCatalog()` manifest
the connector classifies from, reporting tools *by name*: added, no longer
served, annotation conflicts with what the downstream actually claimed, and —
once a manifest records schema digests — which tool's schemas moved. The names
live here rather than in the runtime because the runtime's counts are
payload-free by construction, and a name has no reader there anyway. It then
compares its own totals against `detectCatalogDrift()`: two readings of one
manifest that disagree mean one of them is lying, which is worth failing over.
One credential per provider comes from the environment —
`CONNECTA_DRIFT_LINEAR_KEY`, `CONNECTA_DRIFT_STRIPE_KEY`,
`CONNECTA_DRIFT_MIXPANEL_KEY`, `CONNECTA_DRIFT_REVENUECAT_KEY` — and a missing
or dead one stops the run with a message naming it rather than reporting an
empty catalog as mass removal. Linear, bare Stripe, and RevenueCat `sk_` values
use their documented bearer or Basic framing.
Mixpanel's beta service-account form is provider-specific:
`user:secret` becomes `Bearer Basic <base64(user:secret)>`, exactly as its MCP
documentation requires. A value that already includes whitespace is treated
as a complete Authorization value and passes through unchanged.

**Touched endpoints.** A hand-written provider is written against a published
OpenAPI document and calls a few dozen of its operations, so
[`scripts/drift/`](https://github.com/zackbart/connecta/tree/main/scripts/drift) commits exactly those: method, path, the
specification revision a release reviewed the endpoint at, whether the
operation was deprecated at that revision, and a digest of that endpoint's
contract. `--specs` fetches each provider's published document and reports four
things per touched endpoint — the path is gone, the method is gone, the
operation's deprecation changed, or its contract changed since the recorded
revision. Everything else in the document is ignored, which is the point: a
Cloudflare release that rewrites 2,000 operations connecta never calls is not
news, and a revision bump that left the touched contracts alone reports
nothing.

Deprecation is reported as a *transition*, not a state: a deprecation a
maintainer has read and recorded stops being news, and an operation that comes
back off the deprecation list is its own finding. Without that, a single
reviewed deprecation would fail every release forever, and the check could
never reach the "no drift" state its exit code is for.

A contract digest covers the parameters, the request body, and the success
responses, with local `$ref`s inlined so a change inside a shared component is
visible, and with descriptions, examples, and `x-` extensions stripped so a
reworded document is not a finding. Inlining runs before a response's `content`
is read, because a whole response object is often a reference itself —
Cloudflare writes several of connecta's touched responses that way — and
reading through the reference would digest the response contract as nothing at
all. Two bounds are deliberate: a `$ref` cycle stays a reference rather than an
infinite walk, and failure responses are excluded because an error body is
H11's business, mapped from the status. `--record` rewrites the manifests from
the documents on hand; run it when a finding has been reviewed, and read the
diff before committing it.

Narrowing is checked against the half being run: `--specs --provider linear`
and `--hosted --provider notion` exit 2 rather than checking nothing and
reporting no drift, because a false green from a plausible typo is the one
failure mode a release-time exit code cannot afford.

**What it never does.** No downstream credential reaches CI. No scheduled job,
no background traffic in a deployment, no automatic issue filing. A finding is
read by a human and becomes a GitHub issue they wrote, because the decision a
finding needs — the provider moved this endpoint, or connecta has to stop
calling it — is not one a diff can make. Published specifications remain drift
evidence and nothing else: no tool is generated from one, which is the
[ethos](../ethos.md)'s refusal, not a detail of this script.

## What the audit checks

The provider audit ([#342](https://github.com/zackbart/connecta/issues/342))
runs this document against each of the six providers and returns a verdict per
convention: **meets**, **misses** (with the fix), or **not applicable** (with
the reason). A convention is never quietly skipped, and an accepted miss is
recorded as a provider-specific exception with its argument, not left blank.
Its six reports live in [provider-audit.md](https://github.com/zackbart/connecta/blob/main/records/provider-audit.md), and the
mechanically checkable half of the hand-written bar runs on every test run in
[`test/provider-conventions.test.ts`](https://github.com/zackbart/connecta/blob/main/test/provider-conventions.test.ts) —
so a convention that was met once stays met, or fails loudly.

Hand-written providers are audited against H1–H14; hosted-MCP proxies against
P1–P13. Applying a hand-written convention to a proxy is a category error, not
a finding.

Most of the bar is mechanically checkable against the shipped surface rather
than by reading:

| Convention | Mechanical check |
| --- | --- |
| H1, P2 | constructor throws on a blank `purpose`; `instructions` appear appended to the guide |
| H2 | every tool name matches `^[a-z][a-z0-9_]*$` and opens with a verb from the connector's own set |
| H3 | first sentence ≤ 160 characters; whole description ≤ 240 |
| H5 | every tool has an `inputSchema` that is a closed plain object with a `required` list, and every property at every depth — nested objects and array items included — carries a description or sits on a recorded exception list; `api()` refuses to construct one it cannot enforce |
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
| P9 | `auth` defaults to OAuth and `requireHttps` is set; a credential-auth shape frames the key the way the provider's MCP documentation does |
| P10 | a `credential` slot exactly when auth is `{ type: "credential" }`; `testCredential` runs only from the operator's Test action, never on a timer or a read path; the mode/key contradiction still throws at construction |
| P11 | an authorization failure surfaces as `auth_required`; a downstream tool error is returned unchanged, with no code chosen from its prose |
| P12 | a declared budget matches a citable documented limit, or the absence is justified in the guide |
| P13 | classification lists are maintained in one place per provider and built into the manifest the wrapper classifies from, so the drift check compares against the same fact the caller is served |

The remainder — H4, H6, and the judgment in H14 about whether a named tool
beats the escape hatch — is a reading, and the audit reports it as one. The
Cloudflare keep/prune half of that judgment was made in
[#350](https://github.com/zackbart/connecta/issues/350): 30 keep, 18 improve,
3 prune, measured per tool in
[`eval/current-version/results/issue-350-evidence.md`](https://github.com/zackbart/connecta/blob/main/eval/current-version/results/issue-350-evidence.md).
Its eighteen `improve` rows are H8 and H9 misses on tools that clearly earn
their place, so they are this audit's work, not a second removal argument.

Each provider's own guide ([Cloudflare](./cloudflare.md),
[Linear](./linear.md), [Mixpanel](./mixpanel.md), [Notion](./notion.md),
[RevenueCat](./revenuecat.md), [Stripe](./stripe.md)) is part of the audited
surface: documentation moves with
the work, and a guide describing a surface that shipped differently is itself a
miss.
