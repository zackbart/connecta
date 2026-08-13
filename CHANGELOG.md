# Changelog

All notable changes to this package are documented here.

## Unreleased

### Changed

- **Stripe OAuth mode now belongs to each returned account.** OAuth-backed
  connectors no longer accept a connector-wide `mode`. Their neutral metadata
  and guide support mixed live and sandbox accounts, require
  `list_available_accounts_or_orgs`, and carry its exact `stripe_context` and
  `livemode` into each account-scoped call. They use the stricter sandbox
  admission ceiling. Header credentials still require one fixed mode, retain
  key-prefix contradiction checks, and keep Stripe Connect behavior (#414).

## 0.17.0 — 2026-08-13

This minor release makes catalog discovery faster and its answers more exact.
Agent reads can use a verified stale catalog while one bounded refresh runs,
guide summaries now read Markdown as prose, compact schemas retain more declared
constraints, array projection distinguishes misses from genuine nulls, and
Mixpanel carries the conditional rules its live tools enforce. One construction
contract tightens: an explicit `usageGuide.summary` over 120 characters now
refuses to boot. Deployments whose summaries fit, or which let Connecta derive
them, need no configuration change. Operator catalog reads retain their blocking
freshness behavior. This release also makes the two code sandboxes' runtime
differences explicit. The shipped
Worker example is already loader-only; deployments that added executor
`bindings`, `modules`, or `globalOutbound` must remove them. Existing portable
`execute_code` programs keep their behavior. Programs can now classify a caught
Connecta failure without parsing its message.

### Changed

- An explicit `usageGuide.summary` longer than 120 characters after whitespace
  normalization now throws during registry construction. Exactly 120 remains
  valid, and a blank explicit summary still falls back to derivation (#392).

- **Agent catalog reads now serve a verified stale entry while they refresh it.**
  Search, describe, and code-mode calls no longer await a downstream listing
  when the runtime already holds a complete catalog inside its stale window.
  The inbound request still causes the refresh; there is no timer, warmup, or
  credential probe. One bounded refresh per connector owns and closes a fresh
  scope, while operator status stays blocking and shows whether the last agent
  read in this runtime was fresh or stale (#396).

### Fixed

- **Caught `execute_code` failures now keep their machine-readable type.**
  Calls, connector shortcuts, discovery, emitted-output and UI validation,
  batch validation, and host-call budgets still throw with the same human
  message, but now expose `code`, `retryable`, and full `details`. Batch entries
  use the same codes. A per-run authenticated frame prevents connector prose or
  guest code from forging the host transport on either executor (#393).

- **`execute_code` now tells the truth about each shipped sandbox.** QuickJS
  has no `fetch`, `process`, timers, `crypto`, or `WebSocket`, and blocks
  imports. Loader-only Dynamic Workers deny outbound fetch, WebSocket,
  `node:net`, and `node:tls`; leave DNS unresolved; expose no environment
  bindings or filesystem/HTTP builtins; but retain local `data:` fetch,
  runtime globals, and a non-contract builtin set that can drift. The example
  pins the required loader-only construction, and agent guidance tells portable
  programs to use none of that Dynamic-only authority (#390).

- **Clerk-authenticated operator pages now wait for ClerkJS before booting.**
  The loader runs before the later inline operator bundle instead of deferring
  until after parsing, so a fresh page no longer mistakes normal script order
  for a network failure. Clerk's major-to-pinned version redirect remains
  supported, and a real loader failure keeps the existing clear error (#403).

- **Stripe's guide now treats connector identity as routing intent, not account
  proof.** One OAuth session may cover several accounts in one organization,
  so agents resolve the intended account through the live tool schema and stop
  when the target or selector is ambiguous. The guide also keeps organization
  accounts separate from the restricted-key-only Stripe Connect path (#404).

- **The no-account-model constitution now matches provider-owned sessions.**
  Connecta still has no account dimension: credentials, storage, admission,
  and health remain connector-scoped. A provider may expose its own account
  scope only through its live schema; metadata never proves identity, and an
  ambiguous target or selector stops instead of becoming a guess (#410).

- **The reviewed Notion page contracts are current again.** Notion added
  create-page template and placement options plus update-page locking,
  template, and erase options. The existing parent, properties, Markdown,
  children, emoji, and trash request subsets remain valid, so this release
  records the two changed endpoint digests without adding the new capabilities.
  Their product decisions remain in #408 and #409.

- **Array field misses now report what happened.** A path that misses every
  element appears in `unmatchedFields` instead of returning a clean array of
  false nulls. A heterogeneous array keeps its positional result and names the
  path in `partialFields`, so genuine downstream nulls remain distinguishable.
  Schema-backed misses keep the same bounded guidance through nested arrays;
  schema-free projections still report their observed misses (#394).
- Derived guide summaries now join a hard-wrapped opening paragraph before
  selecting a complete sentence or shortening at a clause or word boundary.
  Frontmatter, fences, headings, rules, tables, and description fallbacks keep
  their prior roles; multi-line HTML comments are now skipped whole (#392).

- **Compact schemas now carry declared numeric and string constraints.** Search
  and compact describe show numeric bounds, multiples, string length bounds,
  patterns, and formats beside the affected type. Search keeps its 1,024-byte
  schema ceiling and 256-byte node budget: a constraint that does not fit is
  dropped whole, and the existing truncation flag sends the caller to describe
  for the complete shape (#391).

- **Carry Mixpanel's three enforced conditional-input rules in its maintained
  guide.** A live read-only audit confirmed that `Get-Business-Context`,
  `Get-Property-Values`, and `List-Properties` accept shapes in their advertised
  schemas that their implementations reject. Connecta still preserves the
  hosted schemas unchanged; the guide now prevents those rejected calls, the
  vetted manifest records schema digests for all 63 tools, and the provider
  defect is tracked upstream. The maintainer drift check also frames
  Mixpanel's service account as its documented `Bearer Basic` value instead of
  ordinary HTTP Basic (#395).

## 0.16.1 — 2026-08-13

This is the cleanup that follows 0.16.0 out the door: the packaging housekeeping
the pre-release smoke gauntlet turned up, one provider tool Cloudflare
deprecated out from under us, a discovery answer that told a plain lie, and the
upgrade runbook an existing deployment never had. Two things break, both on
Cloudflare and both named here rather than left to the section below:
`list_zone_settings` is gone from the `cloudflare()` named surface, and
Cloudflare's 404 arrives as `not_found` instead of `connector_call_failed`.
Nothing else does — no wire shape changes, no construction contract moves, no
other code reclassified, and the per-setting operations `list_zone_settings`
sat beside are the supported ones and are untouched. A deployment that writes
no `api()` connectors, branches on no error code, and never asked an agent for
a whole zone's settings in one call upgrades without reading further.

Three things are additions rather than repairs, and they are the reason this
release is worth reading rather than just installing: a new
`ConnectorCallErrorCode` member, `not_found`, with a rule for when a connector
may mint it; a `"./package.json"` entry in the `exports` map, so the installed
manifest resolves; and `@cloudflare/codemode` declared as an optional peer at
`^0.4.4 || ^0.5.0`. Strict semver would read those three as a minor, and would
read the two Cloudflare changes above as more than that. This ships as a patch
deliberately: every addition is opt-in at the point a deployment chooses to
read it, and the tool removal and the 404 reclassification ride along in the
same patch on purpose — both are scoped to one provider, both have a stated
replacement, and both carry a version boundary in
[`documentation/upgrading.md`](./documentation/upgrading.md). Holding them for
a minor would mean shipping a release that keeps calling an endpoint its
provider deprecated. The one install-time consequence is spelled out next.

One thing to check before upgrading a Worker: `@cloudflare/codemode` is now a
declared peer, so if your `package.json` holds it at a version outside
`^0.4.4 || ^0.5.0` — a `0.3.x`, or a `0.4` below `0.4.4` — npm stops the
upgrade with an `ERESOLVE` conflict rather than installing. Move it into the
range this release is tested against, or pass `--legacy-peer-deps` if you have
a reason to run outside it. A version already inside the range, and a range
loose enough for npm to pick one that is, both resolve exactly as before.

Alongside it, the upgrade path an existing deployment takes gets written down.
`connecta init` was the golden path for a new deployment and the whole story
for an old one, which is a gap with a shape: `init` refuses to merge into an
existing path — the guard that keeps an initializer from eating a connector
set — so an agent pointed at a deployment two releases behind had to
reconstruct the procedure from release prose written for the maintainer. Both
interesting failures there were silent too. It overwrites the configuration the
deployment exists for, or it "fixes" a construction throw by weakening a
fail-closed default and ships something quieter and wrong.

### Added

- **`not_found`, for a downstream that answered and had nothing to give.** A
  hand-written connector meeting a 404 had exactly one honest code,
  `connector_call_failed`, which also means "the call blew up" — so a program
  inside `execute_code` could not tell a clean absence from a broken connector,
  and a loop over ids had to abort where it should have skipped one. The new
  code earns its place the way every code has to: it changes what the caller
  does next. You do not wait, you do not go to `authorize_connector`, you do
  not repair the arguments — you re-address. It is non-retryable, carries no
  recovery envelope, derives no activity friction class, and is exported from
  the root entry as part of `ConnectorCallErrorCode`.

  The qualifier is the interesting half, and it is now written down in
  [H11](./documentation/provider-conventions.md#h11--errors-are-mapped-to-what-the-caller-does-next):
  map a status to `not_found` only where the provider tells absence apart from
  a permission gap. Cloudflare does — a token that may not touch a resource is
  refused with 401 or 403 — so its 404 is now `not_found` instead of
  `connector_call_failed`. Notion does not: `object_not_found` means both "it
  is gone" and "it was never shared with this integration", so it deliberately
  stays generic with a message that says so. The hosted-MCP proxy path mints
  the code never, because `P1` forbids re-shaping downstream framing and
  provider prose is never parsed to invent a classification (#373).

- **An upgrade runbook for existing deployments.**
  [`documentation/upgrading.md`](./documentation/upgrading.md) is written for
  the agent sitting inside a generated deployment it did not create: read the
  exact pin and the template generation it implies, regenerate that generation
  with `npx @zackbart/connecta@<pin> init` to get a real merge base, three-way
  reconcile the scaffolding against the current template while `src/index.ts`
  stays the deployment's own, cross the version boundaries that break
  construction, and finish where `init` finishes — typecheck, start,
  `connecta doctor`, then a program that exercises the deployment's *own*
  connectors, which doctor deliberately knows nothing about. The migration
  notes are per boundary and derived from this file: the 0.16.0 `api()`
  construction contract (with the one safe answer for an unannotated tool
  written down — `readOnlyHint: false`, which is the routing it already had),
  the `linear()`, `mixpanel()`, and Cloudflare provider changes, redirect
  refusal and the response ceilings, and the fail-closed shipped defaults; then
  0.14's annotation-precedence change, 0.13's rewritten guide summaries, the
  0.11.0 executor requirement, 0.7.0's `verifyState` requirement and
  core-owned routes for the pre-template deployments that still have to cross
  them, and every removed option that throws with its migration. It closes with five refusals, because each is somebody's plausible
  shortcut: no re-init over the top, no weakening a fail-closed default to get
  green, no pinning back, no vendored internals, no second project shape.
  Reachable from the README, from `operations.md`, and — absolutely, because
  that reader has no copy of this repository — from the template's `AGENTS.md`
  (#380).
- **A suite that keeps the guide honest.** `test/upgrade-guide.test.ts` pins
  every claim its reader cannot check: the generated file inventory against
  `templates/node/`, the seven tool names against the CLI's own list, each
  named version boundary against a release that shipped, each removed option
  against the release section that names its issue, the bump target against
  this package's version, and the three places the guide is linked from. A template that gains a file now fails `npm run check` rather than
  leaving an agent to guess which of the two is wrong (#380).
- **`@cloudflare/codemode` is a declared optional peer.** Every Workers
  deployment installs the executor behind `execute_code` by hand, and until now
  the only version range anywhere was a devDependency no consumer can read — a
  fresh install resolved a minor ahead of what this repository tests, silently.
  The manifest now publishes `^0.4.4 || ^0.5.0` for it, optional like
  `@clerk/backend` and `quickjs-emscripten`, so a supported version installs in
  silence and an unsupported one stops the install with something to act on
  instead of becoming skew a Worker discovers in production. It still installs
  with nothing: a default `npm install @zackbart/connecta` pulls no executor,
  and the package smoke proves that, both halves of the range behavior, and
  that the version this repository develops against stays inside the range it
  publishes (#376).

### Changed

- **Cloudflare's 404 is `not_found`.** A deployment branching on
  `connector_call_failed` to detect an unknown zone or account id should read
  `not_found` instead; retryability, the message, and its pointer to
  `list_zones` / `list_accounts` are unchanged (#373).
- `cloudflare()` no longer names a bulk zone-settings read.
  `GET /zones/{zoneId}/settings` and its `PATCH` sibling are published as
  `deprecated: true`, Cloudflare offers no bulk replacement, and the tool that
  wrapped the read projected nothing — it took a zone id and grew the payload
  by wrapping an unpaginated array in a page object. Read one setting with
  `get_zone_setting` and write one with `update_zone_setting`, both on the
  supported `/zones/{zoneId}/settings/{settingId}` operations. An operator who
  still wants the whole set can name the deprecated path explicitly through
  `cloudflare_api_get`. The named surface is 47 tools plus the three escape
  hatches ([#361](https://github.com/zackbart/connecta/issues/361)).
- The Cloudflare touched-endpoint manifest drops the deprecated row with the
  tool, so `npm run drift:check -- --specs` is quiet about zone settings
  because nothing calls the endpoint, not because a maintainer signed off on
  calling it anyway.

### Fixed

- **A search for a connector's own name stops claiming the deployment has no
  such capability.** A connector's `id` — the address prefix an agent already
  holds — and its `title` are displayed, never indexed, so `search_tools({
  query: "inventory" })` against a connector called `inventory` matched no tool
  and was answered with "No matching capability is configured in this
  deployment", which was plainly false. Connector identity stays out of the
  lexical index, because putting it in would move ranking for every query that
  already matches tools; instead an unscoped miss whose terms name configured
  connectors says so, names up to three of them by ID, and sends the caller to
  a scoped browse. A term that matches nothing in the deployment still gets the
  original sentence, unchanged. One `queryAnalysis.guidance` string differs; no
  ranking, result, or field changed (#372).
- **Every relative link in the shipped Markdown resolves for the reader who
  installed the package.** Ten of them pointed at `eval/`, `test/`, `scripts/`,
  and the README hero — repository paths the tarball has never carried and, per
  #346, should not start carrying. The link gate could not see any of them: it
  read only `documentation/` targets, so the whole class was invisible and grew
  with every trim. The policy is now stated once in the operations guide and
  enforced over *every* relative link in packed Markdown: it either resolves
  inside the tarball or it is cited as an absolute
  `https://github.com/zackbart/connecta/blob/main/...` URL, which an outside
  reader can follow and which `check:docs` resolves back to the checkout, so a
  citation still fails when the file it names moves. The ten links were
  rewritten that way, the README hero now loads from
  `raw.githubusercontent.com` and still renders on npmjs.com, and the
  repository reader loses no citation (#378).
- **`@zackbart/connecta/package.json` resolves.** The `exports` map listed
  every code subpath and nothing else, so a bundler plugin, framework build
  step, or version probe reaching for the installed manifest — a thing the
  ecosystem broadly expects to work — got `ERR_PACKAGE_PATH_NOT_EXPORTED`
  instead of the file. The manifest is now exported. It is a data file, so this
  widens the published surface by exactly zero code paths: the root entry's
  Workers purity boundary and the optional-peer subpaths are untouched. The
  package-surface gate now asserts the whole subpath set, manifest included, so
  neither this entry nor an unwanted one can arrive unnoticed (#374).
- **The published-surface rule says what it actually forbids.** `AGENTS.md`
  claimed platform-specific storage adapters live in `examples/`, "not the
  package", while the tarball has always carried `examples/worker` — Cloudflare
  KV and D1 adapters included — because that example is the Workers starting
  template a consumer copies. The invariant was never in danger: nothing under
  `examples/` appears in the `exports` map, so those adapters are reference
  source and not an importable subpath. The wording now draws the line where
  the gates draw it — a platform-bound adapter must not reach `src/` or the
  `exports` map — and says why the example ships, in `AGENTS.md`, the
  operations guide, and the `scripts/check-package.mjs` comment. A new
  assertion in `test/package-surface.test.ts` holds the instruction file and
  the exports map to the same story (#377).

## 0.16.0 — 2026-08-12

This is the agent-efficiency refocus. One release, sixteen merges, and a single
question asked of every tool description, schema, discovery result, and error
message in the package: what does this cost the model that has to read it?
Where operator convenience and agent cost disagreed, the agent-facing contract
won. The work lands on two pillars — excellent curated providers, and a
footgun-free path for everything else — plus an operator boundary that finally
describes the surface it guards, exactly two deployment shapes instead of four,
and an operator UI that is a component app rather than string-built HTML.

What breaks, breaks loudly, and mostly at construction rather than at 2 a.m.
`api()` now requires a `description` and an explicit
`annotations.readOnlyHint` on every tool and refuses an `inputSchema` it cannot
compile; `strictValidation` is gone because fail-closed is the only behavior
left for it to switch. `linear()` requires an explicit `access` mode.
`mixpanel()` no longer declares a call-admission budget. `cloudflare()` checks
an overridden `baseUrl` where it is written. The Cloudflare connection ships 52
named tools instead of 55, having been measured against its own escape hatches
rather than assumed to beat them. And Cloudflare and Notion now refuse a
redirect and cap the response they will read, which is visible only to a
deployment that was downloading something enormous through a tool call. Each
of those has a one-line migration, spelled out below.

A deployment that writes no `api()` connectors and runs none of the five
prebuilt connections can upgrade without editing anything. Nothing in the core
runtime surface moved: the seven meta-tools, the executor contract, the storage
interfaces, the route table, and the wire shapes are where they were. The
tarball is half the size, the guides are all written, and `connecta init` now
produces a project that runs under `docker compose up` without becoming a
second project shape.

`api()` stops being forgiving. A hand-written tool now declares what it does
and whether calling it needs a human, and any `inputSchema` it ships is one
Connecta can actually enforce — all three checked at construction, where a
deployment can still refuse to boot, rather than discovered by an agent at
2 a.m. The warn-once-then-pass-raw-arguments-through behavior behind an
unenforceable schema is gone, and with it the `strictValidation` option that
existed only to turn it off.

That construction contract breaks `api()` authors and nobody else. Migration is
mechanical: give every tool a non-empty `description` and an explicit
`annotations.readOnlyHint` — `true` for a read, `false` for work that should
cross `call_destructive_tool` — then delete `strictValidation`, which is now
the only behavior. A tool that used to ship unannotated becomes
`readOnlyHint: false`, which is exactly the routing it already got.
Hosted-MCP proxies are untouched: `remoteMcp()` relays a downstream's names,
descriptions, schemas, and annotations as they arrive, and an unannotated or
contradictory downstream tool still fails closed onto `call_destructive_tool`.
Connecta infers read-only behavior from nothing, anywhere.

The maintained Cloudflare connection ships the second break. Its named surface
was measured against its own escape hatches instead of being assumed to beat
them, and three tools came out. Every named tool now carries a recorded `keep`,
`prune`, or `improve` verdict backed by per-tool numbers: catalog tokens, rank
in a real `search_tools` call for a representative operator request, whether
classes of argument mistake are refused before the round trip, and whether the
handler projects Cloudflare's object or hands it back whole. The evidence, the
tasks, and the reason for every removal — including the one removed for pair
symmetry rather than for a measured defect — are in
[`eval/current-version/results/issue-350-evidence.md`](./eval/current-version/results/issue-350-evidence.md).
**A deployment that calls `set_r2_cors`, `delete_r2_cors`, or `get_r2_metrics`
has to change.** No capability is lost: `get_r2_cors` still reads a bucket's
policy, and the usage guide now names the replacement routes —
`cloudflare_api_mutate` at
`PUT`/`DELETE /accounts/{accountId}/r2/buckets/{bucketName}/cors`, and
`cloudflare_api_get` at `/accounts/{accountId}/r2/metrics`. Every other
Cloudflare tool, argument, projection, and annotation is unchanged.

All five maintained prebuilt connections have been audited against the written
provider conventions, one report per provider, with a verdict for every
applicable convention. Nineteen misses were found and fixed. Sixteen of them
were a guide, a title, or a schema description failing to say something the
implementation already did correctly — the conventions were mostly not asking
for different behavior, they were asking for the behavior to reach the agent.

Three of them did change behavior, and two of those break a deployment:
`linear()` now requires an `access` mode, and `mixpanel()` no longer declares a
call-admission budget. Both failures are loud — one at construction, one as an
absent ceiling an operator can restore in one option. Everything else is a
smaller catalog, a better summary, and a guide that says what it always meant.

Underneath all of that, the two hand-written providers stopped each keeping
their own copy of the same transport safety machinery. Cloudflare and Notion
now send every request through one guarded transport that owns URL
confinement, redirect refusal, bounded response reads, and network-failure
normalization, and owns no opinion at all about what a status code means.

Consolidating it was not free, and three of the differences are visible from
outside. A 3xx from either provider is refused now rather than followed, which
is what both used to do by default — a redirect is an instruction to re-send
the connector's credential to whatever origin `Location` names, and neither
API has a legitimate one to send. Both providers now cap what they will read,
at 8 MiB for Cloudflare and 4 MiB for Notion, so a `cloudflare_api_get`
downloading an R2 object or a Worker script larger than 8 MiB fails instead of
returning it. And `cloudflare()`'s optional `baseUrl` is checked where it is
written: a non-loopback plain-http origin, URL-embedded credentials, or a
query or fragment throws at construction, so a deployment pointed at an http
proxy stops booting rather than sending it a token.

The repository now models exactly the two deployments it actually has: a Node
one and a Worker one. `connecta init` still copies the same template, but that
template now carries its own `Dockerfile` and `docker-compose.yml`, so the
generated project runs from `npm start` locally and from `docker compose up`
in production without becoming a second project shape. The two near-identical
Node scaffolds that sat beside it — `examples/node` and `examples/docker`, the
latter of which built the Connecta repository rather than a consumer project —
are gone. Existing deployments can ignore all of this; nothing in the package's
runtime surface moved.

The three maintained hosted-MCP connections now notice when the catalog they
were reviewed against moves. Each ships a vetted manifest — the tool names and
classifications a release read, plus schema digests once a release records
them — and compares it with the live listing *inside* a catalog refresh the
deployment already asked for. Nothing new is requested: no scheduled job, no
background poll, no credential probe, which is the boundary that keeps this
from being the proactive liveness checking connecta removed. What comes out is
four counts — unclassified additions, names no longer served, explicit
annotation conflicts, schema changes — on connector status, on `/health`, and
in `connecta doctor`, plus one payload-free activity event per change in those
counts for stores that implement the new optional `recordCatalogDrift`. The
observation is per runtime and is not persisted, so status, `/health`, and
doctor answer for the isolate or process that served the refresh — an empty
report means that runtime has observed nothing, and the activity event is the
durable half. A deployment can ignore all of it: an unclassified tool already
failed closed onto `call_destructive_tool` before anyone counted it.

The other half of that story is a command, not a surface. `npm run drift:check`
is maintainer tooling — it ships nowhere, runs on a laptop before a release, and
answers the question the runtime counts deliberately cannot: *which* tool moved.
It diffs each hosted-MCP catalog against the same vetted manifest the connector
classifies from, using the maintainer's own credential, and it compares the
handful of endpoints Cloudflare and Notion actually call against those
providers' published OpenAPI documents — reporting a gone path, a gone method, a
new deprecation, or a changed contract, and ignoring the two thousand operations
connecta never touches. No credential goes near CI, nothing is scheduled,
nothing files itself, and a published specification is drift evidence only: it
never generates a tool and never becomes a runtime input.

Both deployment shapes now carry the operator feature set the operator pages
were built for. A fresh `connecta init` used to produce a deployment with a
Credentials page and no vault, a Tokens page and no issuance, and an Activity
page with nothing behind it — pages for things that deployment could not do.
The Node template now ships sign-in, vault, tokens, and activity as four
clearly-marked commented blocks in `src/index.ts`, each one an environment
variable and an uncommented block away, plus a deployment-owned
`src/file-activity.ts` that is compiled rather than commented. The Worker
example wires the first three outright and comments the fourth, which needs a
D1 database nobody can create for you. Existing deployments can ignore this
entirely: nothing in the package's runtime surface moved, and both READMEs
walk through the enablement.

Finally, the tarball is half of what it was, and nothing that left it was
reachable. `exports` resolves only into `dist/`, so the packed `src/` was
never imported by anything — it was there to back the source and declaration
maps, and all three went together. Out with them, and out with the 230 KB
README hero image, which npmjs.com renders from the repository anyway. An
install unpacks to 1.8 MB instead of 3.8 MB. The code, the types, the CLI, the
template, the Worker example, and every guide are exactly where they were —
and there are four more guides than there were mid-release, because the four
stubs `check:package` had been excluding got written instead.

Which is the quiet half of this release. The five prebuilt connections used to
encode five sets of private judgment about what a good provider surface looks
like; that judgment is now two written convention sets, H1–H14 for hand-written
`api()` surfaces and P1–P13 for `remoteMcp()` proxies, each rule carrying its
reason and the agent cost it reduces. The placeholder guides in
`documentation/` — which covered, with some irony, the load-bearing subsystems,
while the newest features had the best docs — are written against the code as
it is, and none is left. And the ethos bullet that promised
"observable, never administrable" was retired for one that is true: operator
routes manage authentication material for capabilities declared in deployment
configuration, and a suite now snapshots every declared structure and demands
it back byte-identical after each operator mutation.

### Added

- **Two written provider convention sets.**
  [`documentation/provider-conventions.md`](./documentation/provider-conventions.md)
  states H1–H14 for hand-written `api()` surfaces, where Connecta owns every
  name, schema, projection, and error, and P1–P13 for `remoteMcp()` proxies,
  where the downstream owns the catalog and Connecta owns the endpoint,
  credential, classification, guide, and budget. Every convention carries its
  rule, its reason, and which of the four agent costs it reduces — discovery
  tokens, wrong-tool selection, argument retries, result size — and names the
  budgets at which the surface itself starts dropping characters: 160 for a
  tool description in search, 240 in describe, 1,024 bytes per compact schema,
  120 for a guide summary. A description longer than its budget is written for
  nobody (#339).
- **The core subsystem guides, written.** `architecture.md`,
  `request-admission.md`, `call-admission.md`, and `operations.md` were
  identical seven-line placeholders pointing at git history; they now describe
  the code as it is — the two lifetimes, the ordered route table and why each position is
  behavior rather than taste, the import-graph purity rule and what it actually
  prevents, both admission pools and why `/mcp` admits before it authenticates,
  and the connector-partitioned downstream policy. `operations.md` also carries
  the test map AGENTS.md had been deferring since the docs restructure: all 61
  suites plus the two browser specs, with each Node-only suite's reason for not
  running in workerd, so "this suite exists" and "this suite is justified" are
  one lookup. `connector-guides.md` gains the general authoring half #339 left
  open, including the `required` flag in full. With no stubs left, the four
  `!documentation/…` negations in `files` went too (#348).
- **A maintainer-run provider drift check.** `npm run drift:check` diffs the
  live Linear, Stripe, and Mixpanel catalogs against their vetted manifests by
  name — added, no longer served, annotation conflicts, and schema changes — and
  cross-checks its totals against the runtime `detectCatalogDrift()`, because
  two readings of one manifest that disagree mean one of them is lying. Its
  second half compares committed touched-endpoint manifests
  (`scripts/drift/cloudflare-endpoints.json`, `scripts/drift/notion-endpoints.json`:
  method, path, reviewed spec revision, reviewed deprecation, contract digest)
  with each provider's published OpenAPI document, and `--record` refreshes
  them. Deprecation is reported as a transition in either direction, so a
  reviewed one stops being news. A missing credential, an unreachable
  specification, or a `--provider` the selected half does not check stops the
  run and says which one.
  Written up in
  [`documentation/provider-conventions.md`](./documentation/provider-conventions.md#the-maintainer-run-drift-check)
  (#351).
- **Hosted-provider drift detection at refresh.** Linear, Stripe, and Mixpanel
  each ship a vetted manifest and compare it with the live catalog while
  serving a refresh that was going to happen anyway. `ConnectorStatus` gains
  `catalogDrift` (four counts and the time they were observed), `/health` gains
  the same per connector, `connecta doctor` reports it without failing on it,
  and `ActivitySink` gains an optional `recordCatalogDrift` that receives one
  payload-free event per change in the counts. Both read surfaces report what
  the answering runtime observed — the observation is isolate-local, not
  persisted — and both project the counts rather than echo the connector seam.
  The policy is written up in
  [`documentation/provider-conventions.md`](./documentation/provider-conventions.md#the-runtime-drift-policy)
  (#343).
- **The Node template is Docker-ready.** `Dockerfile`, `docker-compose.yml`,
  and `.dockerignore` ship with `connecta init`. The image installs
  `@zackbart/connecta` from the registry like any other consumer, runs as the
  non-root `node` user with state on a named volume, probes the always-open
  `/health` route, and keeps Node in the foreground so `compose down` stops it
  promptly. `PUBLIC_URL` and `CONNECTA_STATE_FILE` now configure the generated
  `src/index.ts`, which is what makes one source serve both run paths (#344).
- **The package smoke exercises the generated container.** `check:package`
  builds and runs the initialized deployment through Compose and points
  `connecta doctor` at it; it fails rather than skips when Docker is missing
  in CI (#344).
- **A deterministic named-surface measurement lane.**
  `npm --prefix eval/current-version run report:cloudflare-surface` measures the
  maintained Cloudflare connection one tool at a time and writes a JSON and
  Markdown artifact. It needs no model, no network, and no credential: the real
  constructor, schemas, validation path, handlers, and catalog service run, and
  only `fetch` is a probe that records the request (#350).
- **Five provider audit reports** in
  [`documentation/provider-audit.md`](./documentation/provider-audit.md), with
  a verdict per convention, the fix for every miss, and every accepted
  exception recorded with its argument (#342).
- **A convention test over the shipped surface.**
  `test/provider-conventions.test.ts` walks both `api()` providers on every run
  and enforces the mechanically checkable bar — naming, description budgets,
  closed schemas described at every depth, compact-render budgets, declared
  outputs, structured guides, and credential tests — so a convention met once
  stays met. The one accepted gap, the undescribed name/value members of
  Cloudflare's escape-hatch request parts, is listed by path in the suite with
  its argument rather than left for a shallower check to miss (#342).
- **Guide coverage the schemas cannot carry.** Stripe and Mixpanel guides now
  name their id-resolution rules, say the hosted catalog is not a fixed set, and
  give the `auth_required` → `authorize_connector` recovery route. Notion's
  guide states that it deliberately has no raw-REST escape hatch (#342).
- **A guarded fetch transport for hand-written connectors.** One factory
  supplies the machinery every `api()` HTTP surface was re-deriving: strict
  base-origin and path confinement checked after URL normalization, encoded
  query and JSON body construction, `ctx.signal` propagation, a required
  response-byte ceiling enforced while reading, a flat refusal to follow a
  redirect or to let a request header shadow an authentication one, and an
  unreachable provider normalized to a retryable `unavailable`. Authentication
  and status interpretation stay in provider callbacks — the helper never
  guesses what a 403 means. Cloudflare and Notion both run on it; it is held
  internal this release rather than exported, and
  [`documentation/connectors.md`](./documentation/connectors.md#the-guarded-fetch-transport)
  records why (#341).
- **The operator feature set in both deployment shapes.** The Node template
  gains commented, documented configuration for Clerk operator sign-in, the
  credential vault, access-token issuance, and payload-free activity, the four
  environment variables they read (passed through Compose and defaulted in the
  Dockerfile so the container works the moment a block is uncommented), and
  `src/file-activity.ts` — a deployment-owned `ActivityStore` that appends one
  JSON line per call and rewrites the log back down to the newest 5,000 once it
  runs a slack window past that, repairing a torn trailing line on the way in
  rather than appending onto it. The Worker example wires the credential vault
  to a new `CREDENTIAL_ENCRYPTION_KEY` secret beside the Clerk and access-token
  configuration it already had, and carries the D1 activity wiring and its
  binding as commented lines rather than as README-only instructions. Both
  READMEs walk through enabling each half — including the part neither vault
  can supply, a connector that declares a `credential` slot, which is what puts
  the Credentials page in the nav — and both say why `connecta doctor` reports
  none of it: doctor holds a bearer, and a client key does not get to learn a
  deployment's configuration topology (#345).

### Changed

- **The operator boundary is stated as authentication material.** "Observable,
  never administrable" had stopped describing the surface — operator routes
  rotate credentials, issue and revoke access tokens, and drive downstream
  OAuth, each under its own accepted decision. The ethos bullet, the invariant,
  and a new decisions row now say the true thing: operator routes may manage
  authentication material for capabilities *declared* in deployment
  configuration, and may never change the connector set, the declared tool
  catalog or annotations, requested OAuth scopes, admission policy,
  authorization rules, or caller tool scope. The word "declared" is doing work
  twice over — a broader-scoped replacement token widens downstream reach and
  no browser page can honestly promise otherwise, and a remote MCP server's
  catalog is discovered rather than declared, so storing a credential can take
  an `mcp()` connector from no tools to N. That is discovery arriving, which is
  exactly why those routes call `invalidateStored()`.
  `test/operator-boundary.test.ts` snapshots every declared structure, drives
  each operator mutation route against both a static and a re-listing
  connector, and requires the snapshot back byte-identical; a second case
  proves the snapshot can fail. No runtime behavior changed (#338).
- **The operator UI is a component app.** The hand-written DOM layer is gone,
  replaced by a small Preact app compiled by the same esbuild step and inlined
  into a shell that is now a mount point rather than a page. Nothing builds
  HTML from strings any more, so the escaping every rendered value used to
  depend on is structural; the served markup is identical on all four pages and
  still carries no operator data. Credential, token, and OAuth flows gained
  deliberate loading, error, empty, and success states — a failed save keeps
  the form and what was typed in it, a failed list offers a retry, and an empty
  collection says what would fill it. Each connector card also reads the drift
  the last catalog refresh saw (#343) as four category counts, with `clean`,
  `warning`, and "not observed in this runtime" kept as three distinct answers
  — no tool name, schema, or payload rides that panel. Preact rides in as a
  `devDependency` inlined into the committed bundle and never reaches a
  deployment's dependency tree (#347).

- **`api()` enforces its construction contract.** Every tool requires a
  non-empty `description` and an explicit boolean `annotations.readOnlyHint`;
  a missing or non-boolean classification throws with the address that needs
  fixing. The classification is never inferred from a tool name, description,
  schema, HTTP method, or the other annotations (#340).
- **An unenforceable `inputSchema` fails at construction.** A schema the
  validator cannot compile throws when the connector is built, whether or not
  `validateArgs` is on — opting out of enforcement is not opting out of the
  schema being real. A schema that only reveals itself on first use, such as an
  unresolvable `$ref`, now fails that call as non-retryable `invalid_args`
  instead of forwarding raw arguments to the handler (#340).
- **`linear()` requires `access`.** There is no safe default between Linear's
  two endpoints: `"read-write"` hands out writes nobody asked for, and
  `"read-only"` breaks a writing deployment at Linear, at runtime, where no
  agent can repair it. Construction now throws naming both options. Add
  `access: "read-write"` to keep an existing deployment's behavior (#342).
- **`mixpanel()` declares no call-admission budget.** The old hardcoded 600
  calls per hour transcribed a limit Mixpanel meters *per user*, which a
  per-runtime counter cannot approximate in either direction. Supply
  `callAdmission` explicitly if the account needs a ceiling, as Linear already
  did (#342).
- **`mixpanel()` titles itself by region.** The default title is now
  `Mixpanel (us)`, `(eu)`, or `(in)`, and the guide opens with the residency,
  because a project lives in exactly one and search never shows a description.
  An unknown region throws at construction (#342).
- **Provider guides are structured everywhere.** All five declare an explicit
  `summary` instead of leaning on the guide's first line, which was truncating
  the routing fact at 120 characters on three of them (#342).
- **Smaller discovery payloads.** Over-budget tool descriptions
  (`cloudflare_api_get`, `cloudflare_api_mutate`, `create_dns_record`, Notion's
  `search`) were trimmed to the 240-character describe budget, and shared
  property descriptions were cut so `cloudflare_api_upload` and
  `query_data_source` render inside the 1,024-byte compact budget instead of
  degrading and costing a describe round trip (#342).
- **Cloudflare and Notion never follow a redirect.** Both used `fetch`'s
  default `redirect: "follow"` and now send `redirect: "manual"`; a 3xx fails
  as non-retryable `connector_call_failed` instead of re-sending the
  connector's credential to whatever origin the `Location` names (#341).
- **Cloudflare and Notion bound the response they will read.** 8 MiB and
  4 MiB respectively, enforced against a declared `Content-Length` before the
  first byte and again while the body streams. Both are ceilings on absurdity
  rather than quotas — anything near them was already past whatever
  `maxResultBytes` the deployment set — but a `cloudflare_api_get` reading an
  R2 object or Worker script past 8 MiB now fails as non-retryable instead of
  returning it (#341).
- **`cloudflare()` checks its `baseUrl` at construction.** A non-loopback
  plain-http origin, URL-embedded credentials, or a query or fragment throws
  where the connector is written rather than on the first call. A deployment
  overriding `baseUrl` with an http proxy must move it to https or bind it to
  loopback; the default Cloudflare base is unaffected (#341).

### Fixed

- **`connecta doctor` names the sandbox that actually ran the program.** It
  printed "QuickJS executed" at every deployment it had ever checked, including
  the Worker example, whose sandbox is a Dynamic Worker — the one field the
  Worker README says doctor confirms, reported wrong. The deployment now says
  what its executor is: `/health` carries the configured executor's name when
  it has one (an explicit `name`, else a class-shaped executor's constructor
  name), sanitized and bounded because it lands in a public response body and
  an operator's terminal. Doctor reports that name, and a deployment whose
  executor identifies as nothing gets `code executed` rather than a guess. The
  Node template still reads `QuickJS executed`; the Worker example now reads
  `DynamicWorkerExecutor executed` (#368).
- **The Node template's `.env.example` ships an empty `CONNECTA_TOKEN`.**
  `docker-compose.yml` has always promised to refuse a deployment with no
  inbound auth, but its `${CONNECTA_TOKEN:?…}` guard only fires on unset or
  empty — and the file it reads shipped `replace-me`, which is neither. Copying
  `.env.example` and running the README's Docker block therefore produced a
  healthy, port-published deployment whose bearer token was a string published
  in this repository. The value is now empty, so both Compose and `npm start`
  refuse until an operator sets one (#367).
- **The Worker example names the optional peer it imports.**
  `examples/worker` wires `clerkAuth` by default and calls itself the starting
  template for a deployment, but its README listed only `@cloudflare/codemode`
  as an extra install. `@clerk/backend` is an optional peer that never installs
  with Connecta, and `auth/clerk` imports it at the top level, so a copied
  deployment following the README verbatim died at
  `Could not resolve "@clerk/backend"` before it ever reached Cloudflare. The
  deploy section now carries the whole install line for a copy in its own
  repository (#367).
- **A malformed Clerk publishable key fails like a configuration mistake.**
  `clerkAuth` derives its Frontend API origin by base64-decoding
  `publishableKey` and used to hand a bad key straight to `atob`, so the
  placeholder the Workers example ships raised a bare `InvalidCharacterError`
  from inside the returned object — and, on a deployment that builds per
  request, turned every route including `/health` into a 500 whose stack named
  base64 instead of the environment variable. The key's shape is now checked
  where `allowedDomains` is, at construction, and the throw names the option.
  It does not quote the rejected value back: the usual way to land here is
  pasting the secret key into the publishable slot (#366).
- **Notion declares the `required` lists it was missing.** `search`,
  `list_users`, `get_self`, and `create_page` now say which arguments a call
  must carry, so a malformed call is refused locally instead of at Notion. The
  fail-closed schema handling those lists rely on is the package default as of
  #340 (#342).
- **Cloudflare's cursor pagination says so in the schema.**
  `list_zone_rulesets`, `list_kv_keys`, `list_r2_buckets`, and
  `list_r2_objects` now state on both the `cursor` argument and the
  `nextCursor` result that they page by cursor and return no `page` object —
  previously only the usage guide said it (#342).
- **Nested schema properties describe themselves.** The six fields inside
  `bulk_write_kv_values`'s `entries[]` — including the expiry pair, whose units
  and 60-second floor were the entire question — and Notion's
  `sorts[].direction` were shipping bare types, because H5's description rule
  had only ever been read at the top level (#342).

### Removed

- **`ApiOptions.strictValidation`.** Fail-closed schema handling is the only
  behavior, so the opt-in has nothing left to switch. Delete the option;
  nothing else changes (#340).
- **Three Cloudflare named tools; the connection ships 52, down from 55.**
  `set_r2_cors` declared a free-form rule body, so its schema validated the ids
  and waved through the part of the call that fails, and `get_r2_metrics` put
  one account id into a path and returned the response unprojected — both
  measurably weaker than the raw call that replaces them. `delete_r2_cors`
  measured clean and went anyway, to keep the CORS write pair together: with
  the write unnamed, a named delete would leave half of policy management on
  each route. All three are one raw call away, and the guide says which one
  (#350).
- **`examples/node` and `examples/docker`.** Both were diffs from the
  template. `examples/` is the Worker deployment now, and the root
  `.dockerignore` that existed only for the repository-context Docker build
  went with them (#344).
- **`src/`, `.js.map`, `.d.ts.map`, and `assets/` — from the tarball only.**
  All of them are still in the repository; none of them ships. The published
  package is 167 files and 550 KB, down from 357 and 1.1 MB. The stub guides
  left with them and came back written (#348), which is why the file count is
  four higher than the trim alone left it.
  Stepping into Connecta's TypeScript from an installed copy no longer works;
  the emitted JavaScript and the `.d.ts` files beside it do. `check:package`
  now fails on a packed `src/`, `.map`, or `assets/` path, derives the shipped
  guide list from which guides are still stubs, so filling one in ships it, and
  refuses a packed document whose relative link lands on a guide the tarball
  does not carry — the three that pointed at `operations.md` now name it
  instead (#346).

## 0.15.1 — 2026-08-12

The Cloudflare connection now supports legacy user-scoped Global API Keys as
an explicit authentication mode. Scoped API tokens remain the default. The
three guarded raw tools still cover the full v4 path space without adding one
tool per endpoint, and ordinary JSON responses such as GraphQL results now
survive that path intact.

Nothing breaks for existing deployments. They keep their current API token,
credential form, verification tool, and 55-tool surface. A deployment that
needs the legacy scheme opts in and stores the Cloudflare user email and Global
API Key as separate encrypted fields.

### Added

- **Legacy Cloudflare Global API Key authentication.** Set
  `authentication: "globalApiKey"` to send operator-managed `X-Auth-Email` and
  `X-Auth-Key` headers. `verify_global_api_key` checks the pair through
  Cloudflare's authenticated user endpoint, and raw calls cannot replace either
  connector-owned header.

### Fixed

- **Raw Cloudflare calls preserve non-envelope JSON.** Endpoints such as
  `/graphql` return their complete JSON document instead of an undefined
  `result`.

## 0.15.0 — 2026-08-10

Discovery now keeps strong action/object near-matches visible beside complete
matches, gives each compact enum its own bound, and states the grouped, flat,
and describe envelopes plainly. Invalid arguments also stop producing the
contradictory claim that a declared property is undeclared. The result is a
more dependable route from a short query to one correctly shaped call, without
a new tool, a semantic index, or a larger discovery budget.

No published surface is removed. Per-result `queryCoverage` was prototyped on
`main`, measured in cold-agent runs, and removed before this release because it
did not earn its repeated response cost. Deployments upgrading from 0.14.2 can
ignore that experiment. Discovery consumers should note that result order can
improve, an empty output object no longer emits `outputKeys: []`, and a large
enum's compact rendering is now abbreviated; exact JSON schemas remain
available through JSON discovery and `connecta.describe`.

### Changed

- **Complete and partial lexical matches can share a page.** A weak all-term
  description match no longer suppresses a stronger action/object tool.
  Complete matches normally lead; a partial candidate whose full normalized
  tool name occurs in the raw query can compete by score, and other candidates
  covering at least two terms fill the remaining page after all complete
  matches. Stable pagination, connector and safety filters, the no-complete
  any-term fallback, and discovery size bounds remain intact (#326).
- **Large compact enums have a per-node budget.** Each enum receives 256 bytes
  inside the unchanged 1,024-byte schema ceiling. Truncation preserves whole
  values and reports the exact omitted count before `unknown`; an empty enum
  renders as `never`. Small enums remain complete, surrounding property types
  stay visible, and JSON discovery and describe retain every value (#325).
- **Discovery envelopes and schema-key metadata are explicit.** Guidance now
  distinguishes grouped top-level `search_tools`, flat `connecta.search`, and
  the `connecta.describe` tools envelope. Output objects with no declared
  properties omit `outputKeys`, while zero-input objects still report empty
  input-key lists. Program-UI guidance again documents the read manifest and
  its exact `connecta.read(name, args)` route (#324).
- **Non-lexical input no longer becomes a browse.** A non-empty query with no
  ASCII lexical terms returns bounded no-match analysis; mixed input searches
  with its ASCII terms, and echoed query feedback clips at Unicode character
  boundaries rather than splitting a code point (#323).

### Fixed

- **Argument failures report only the constraints that failed.** When a
  declared property violates its enum, type, or another subschema beside
  `additionalProperties: false`, the error no longer also calls that property
  undeclared or exposes the validator's `False boolean schema` wording.
  Genuine unknown properties still produce one `additionalProperties` issue;
  independent false-schema failures, nested paths, empty property names,
  issue truncation, and strict-validation behavior remain accurate (#316).

### Removed

- **Unreleased per-result lexical query coverage.** `search_tools` and
  `connecta.search` do not serialize the experimental `queryCoverage` field.
  Coverage-off beat the verbose wire, the first compact wire regressed
  efficiency, and the trailing form missed its locally precommitted 30-run
  gate: 13/30 clean routes versus 9/30 without coverage (+13.3 percentage
  points, Fisher p=0.422). Ranking, pagination, filters, Unicode handling, and
  page-level partial/no-match `queryAnalysis` remain (#322, #323, #326).

## 0.14.2 — 2026-08-08

Remote MCP connectors can now make one explicit compatibility concession for a
known-legacy server: skip modern version discovery and begin with the ordinary
2025 initialization lifecycle. This is for otherwise functional downstreams
that crash or return a server error when they receive `server/discover` before
`initialize`; COROS build 2.11.15 is the motivating deployment.

Nothing changes for existing deployments. Automatic negotiation remains the
default, and connectors that do not set the new option continue to probe for a
modern server and conservatively fall back to legacy MCP. OAuth, request-scoped
client reuse, catalog pagination, tool calls, and legacy session teardown all
share the same paths after connection.

### Added

- **Per-connector legacy MCP negotiation.** `remoteMcp(id, {
  versionNegotiation: "legacy", ... })` starts directly with `initialize` and
  never sends `server/discover`, allowing known-legacy downstreams to opt out
  without changing negotiation for any other connector (#321).

## 0.14.1 — 2026-08-06

The Cloudflare connection is now an operations surface rather than a narrow
inventory sample. Common zone, Worker, KV, R2, and Pages workflows have named,
closed schemas and lean results; three guarded v4 escape hatches cover Images,
Stream, Email Routing, D1, Queues, and future Cloudflare products without
turning the catalog into an OpenAPI dump. GET remains the only raw path admitted
to programs. JSON mutations and raw or multipart uploads always cross the
destructive boundary, while the configured Cloudflare token remains the final
provider-side capability limit.

Nothing breaks for existing deployments. The original fourteen tool names and
their behavior are unchanged, and deployments can keep their current read-only
token if they only use those reads. Operators who use the new writes must add
the corresponding narrowly scoped Cloudflare permissions. The new raw tools
return provider shapes by design, so programs should project their results just
as they would any other large downstream response.

### Added

- **Named Cloudflare administration across five product areas.** Zone settings
  and rulesets, Worker settings and deployments, KV namespaces/keys/bulk
  values, R2 buckets/objects/metrics/CORS, and Pages projects/deployments/domains
  now have maintained operations with explicit schemas, pagination, projections,
  and safety annotations.
- **Guarded access to the rest of Cloudflare v4.** `cloudflare_api_get` handles
  JSON, text, and base64 reads; `cloudflare_api_mutate` handles JSON POST, PUT,
  PATCH, and DELETE; `cloudflare_api_upload` handles explicit text, base64, and
  multipart bodies. Raw paths cannot be absolute, traverse with `..`, hide a
  query string, or choose their own host.

### Changed

- **Cloudflare credential guidance now covers operational permissions.** The
  guide distinguishes product Read and Write scopes, explains the three raw
  routes, names common media, email, database, and queue paths, and records the
  cursor behavior of R2 object and KV key listings.

## 0.14.0 — 2026-08-03

Connecta went from one maintained prebuilt connection to five. Stripe, Linear,
Notion, and Cloudflare join Mixpanel behind `./providers/<name>`, and together
they answer the question the Mixpanel connection left open: whether a
maintained connection means anything more specific than a wrapper. Stripe and
Linear proxy hosted MCP servers and spend their effort on what a transport
cannot say — Stripe makes production-versus-sandbox a required declaration with
no default and refuses a deployment whose API key contradicts it; Linear
selects a read-only *endpoint* whose token cannot reach a write API, which is a
stronger guarantee than any annotation. Notion and Cloudflare are hand-written
`api()` surfaces, and they exist because shape is the problem rather than
transport: a Notion page is tens of kilobytes of discriminated wrappers and
rich-text runs around a few hundred bytes of meaning, and a generated
Cloudflare wrapper exposed `arguments?: {}[]` in its compact schema and pushed
the real parameter list into a documentation page an agent had to read before
it could call anything. Fifteen and fourteen deliberate tools respectively,
projected down to ids and plain values, with `raw: true` wherever the dropped
detail can matter. None of the four adds a dependency — not to core, not as an
optional peer, not in `devDependencies`. The whole set installs with nothing
extra and none of it is reachable from the root entry.

Nothing breaks. Every export is additive and lives behind its own subpath, no
existing signature moved, and a deployment that configures none of the new
providers can upgrade with a version bump and read no further. Two changes are
worth knowing about anyway. Vetted annotations on a prebuilt connection no
longer argue with an explicit downstream annotation in *either* direction: a
name the downstream explicitly marks `readOnlyHint: true` that no release has
classified now stays callable from `execute_code` instead of failing closed
onto the approval path. Silence on an unclassified name still means not
read-only, so catalog drift is unaffected — this only moves names the
downstream actually spoke about. The one branch that still outranks the
downstream is a name a release reviewed and filed destructive: a
`Delete-Dashboard` arriving with `readOnlyHint: true` is a downstream bug
rather than news, and stays behind `call_destructive_tool`. That asymmetry is
deliberate for now and tracked as an open question (#315). The other change is
text: the `execute_code` code-parameter description gained a sentence about not
aborting on a missing tool match or result key. Everything in `eval/` is
internal and ships in no package (#295, #297, #303, #306, #310, PRs #305–#317).

### Added

- **A maintained Stripe connection at `./providers/stripe`.** `stripe(id, {
  mode, purpose, title?, auth?, connectedAccount?, instructions?,
  maxResultBytes? })` proxies Stripe's hosted MCP server at
  `https://mcp.stripe.com/` over HTTPS, OAuth by default and static headers for
  restricted API keys. `mode` is `"production" | "sandbox"` with **no default**,
  because there is no safe guess between an account that moves real money and
  one that does not. Stripe publishes one endpoint and selects the environment
  by credential, so the mode cannot be routed — instead it is made impossible to
  miss, appearing in the default title, in the description `search_tools` ranks,
  in the first two lines of the guide, and in the admission policy (production
  100 calls/second at concurrency 8; sandbox 25 at 4). A `headers` credential
  carrying a recognizable key prefix (`sk_`, `rk_`, or `pk_` with `_live_` or
  `_test_`) that contradicts the declared mode throws at construction; an OAuth
  connector or an unrecognized credential shape is left alone rather than
  guessed at, and the error names only the two modes, never the key.
  `connectedAccount` requires an `acct_` id and headers auth. Seven reads and
  four writes are vetted fill-in-only.
- **A maintained Linear connection at `./providers/linear`.** `linear(id, {
  purpose, access?, title?, auth?, instructions?, maxResultBytes?,
  callAdmission? })` proxies Linear's hosted MCP server, with `access` selecting
  the endpoint: `"read-write"` (default) at `https://mcp.linear.app/mcp` with
  the `read` and `write` scopes, `"read-only"` at
  `https://mcp.linear.app/mcp/readonly` with `read` alone. Read-only is not a
  client-side filter — the token minted for that endpoint cannot reach Linear's
  write APIs at all. The mode is legible at browse time rather than only after
  the guide is fetched: a read-only connection titles itself `Linear
  (read-only)` and its guide opens with the access note, which is what discovery
  summarizes. The deprecated `/sse` transport is deliberately unreachable. No
  admission policy is imposed by default, because Linear's published limit is
  per user per hour and varies by credential type while Connecta's counter is
  per runtime; a deployment that knows its own ceiling can pass `callAdmission`.
  The read allowlist is a deliberate superset of any one workspace, since
  several tools are plan-gated. Every `save_*` is filed destructive — they are
  upserts.
- **A maintained Notion connection at `./providers/notion`.** `notion(id, {
  purpose, title?, instructions?, credentialLabel?, defaultPageSize?,
  maxResultBytes? })` is the first prebuilt connection built on `api()` rather
  than `remoteMcp()`: fifteen hand-written tools over `api.notion.com` pinned to
  `Notion-Version: 2026-03-11` with no override, because that is the version in
  which databases split into data sources, `archived` became `in_trash`, and
  block append took a `position` object — an older pin would return quietly
  wrong results rather than fail loudly. Ten reads carry `readOnlyHint: true`;
  five writes route through `call_destructive_tool`, with `destructiveHint`
  reserved for the two that replace or remove existing state.
  `update_page_properties` has no `in_trash` argument, so an update can never
  trash a page; `trash_page` is its own named and reversible tool. Lean
  projections are the headline — properties flattened, rich text reduced to
  plain strings, `search` dropping properties entirely, `get_page` reporting
  what Notion truncated at 25 references — and seven reads take `raw: true` to
  return the untouched payload where the dropped detail matters. Errors map to
  what the caller should do next: 403 is deliberately not `auth_required`,
  because re-authorizing cannot grant a capability or share a page, and 404 says
  out loud that Notion returns it both for a missing object and an unshared one.
  Admission pairs a 180-per-minute rolling budget with `maxConcurrency: 3`,
  because a budget alone is an average and an average cannot stop a program
  firing forty calls in one tick. Its guide is the only one of the four marked
  `required`.
- **A maintained Cloudflare connection at `./providers/cloudflare`.**
  `cloudflare(id, { purpose, title?, accountId?, zoneId?, baseUrl?,
  credential?, instructions?, maxResultBytes?, maxConcurrency? })` is fourteen
  hand-written tools over the v4 REST API, fetch-native and dependency-free:
  Cloudflare publishes an official SDK and this connection does not use it,
  because the SDK's typed wrappers and pagination helpers are exactly what a
  projected result and a `page.hasMore` boolean replace. `test/package-surface.test.ts`
  pins the claim — the `cloudflare` package must appear in no dependency list at
  all, and every import in the provider must be relative. Every tool carries a
  complete closed schema: `additionalProperties: false`, an accurate `required`
  list, an `enum` on every constrained field, a description on every property
  (asserted, not claimed), and per-endpoint `perPage` bounds. Because
  `strictValidation` refuses an out-of-range page size locally, the schemas
  record *whose* bound is being enforced and the descriptions say so out loud:
  Cloudflare's own where documented, this connection's cap where Cloudflare's
  nominal ceiling is unusable (`list_dns_records` caps at 1,000 against a
  documented 5,000,000), and this connection's entirely where Cloudflare
  documents none (`list_pages_projects`). Twenty-one DNS record types are
  exported as `CLOUDFLARE_DNS_RECORD_TYPES`. Admission mirrors the documented
  1,200-per-five-minutes with a default concurrency of 6.

### Changed

- **Explicit downstream annotations win in both directions.** A prebuilt
  connection's vetted classification was already fill-in only against a
  downstream saying a name is *less* safe than the allowlist claims. It now also
  yields to a downstream saying a name is safe when no release has classified
  that name at all: an explicit `readOnlyHint: true` on an unreviewed tool is
  kept, and the tool stays callable from `execute_code`. On a name no release
  has reviewed, the downstream's word is the only evidence there is. Silence
  still means not read-only, so catalog drift fails closed exactly as before,
  and a name a release reviewed and filed destructive still outranks a
  downstream `readOnlyHint: true` — an open question rather than a settled
  invariant (#315). Mixpanel deployments are the ones that can observe this
  today: a tool Mixpanel explicitly annotates read-only that this release's
  allowlist has never seen moves off the approval path.
- **`execute_code` tells a program not to abort on a missing key.** The code
  parameter's description gained: "So does aborting on a missing tool match or
  result key — re-search, describe, or read the result's actual keys here
  instead." The eval lane that motivated it measures whether a program shapes
  its result in the run that produced it rather than returning catalog data for
  a later call.
- **`documentation/` gained a guide per maintained connection** — `stripe.md`,
  `linear.md`, `notion.md`, `cloudflare.md` — and `connectors.md` now lists all
  five. Its custom-`remoteMcp()` example moved off Linear to an in-house deploy
  server, as did the Docker example's OAuth demo, since Linear is now a prebuilt
  connection rather than an illustration of hand-writing one.

### Fixed

- **`api()` connectors await their handlers.** `callTool` returned the handler's
  promise without awaiting it, so a handler that threw before its first `await`
  sat handler-less through the thenable-adoption microtask and was reported as
  an unhandled rejection by workerd and vitest even though the caller caught the
  typed failure. It is now a caught typed failure and nothing else. Affects
  every `api()` connector, hand-written or prebuilt.
- **An empty-query browse of an unavailable catalog says so.** A browse has no
  terms to analyze and so reported nothing at all, which was indistinguishable
  from a connector that simply exposes no tools — while the guidance on a scoped
  miss recommends exactly that browse. A browse scoped to an unavailable
  connector now carries `unavailableConnectorCount`, the typed `catalogError`,
  and guidance naming it; an unscoped browse carries the count and a
  scope-by-connector pointer but no `catalogError`, because one connector's
  failure is not another browse's context. A configured connector that
  correctly exposes no tools still reports no analysis, so empty, unavailable,
  and unknown do not serialize alike.
- **An empty-query browse of an unknown connector reports the unknown
  connector.** A browse scoped to an id that is not configured now returns
  `connectorScope`, `unknownConnector`, and the same omit-the-connector guidance
  the term-bearing path already gave. Nothing was attempted, so there is no
  count and no `catalogError`, and the response names no connector but the one
  the caller supplied — listing what else is configured would answer a question
  they did not ask, past a filter they may not pass.

### Internal

- **A reference-connection lane in `eval/`.** Six cases — discovery, a simple
  read, a dependent reduction, invalid arguments, an unavailable credential, and
  write routing — run a cold agent against a second isolated deployment whose
  `cloudflare()` connector is the real constructor with only the network
  doubled, reached through the already-documented `baseUrl`. Schemas,
  `strictValidation`, annotations, projections, admission, guide, and error
  mapping are the shipped ones, and credentials go through the real vault; no
  product surface was added for the benchmark. Write routing is the only case
  permitted across the destructive boundary, and the fixture exposes a
  downstream-effects endpoint as independent evidence. `eval/` is not in the
  published `files` allowlist; deployments never see it.

## 0.13.0 — 2026-08-03

Everything an agent reads before it calls anything got more selective. Connecta
ships its first maintained prebuilt connection — `mixpanel()` behind
`./providers/mixpanel`, one import returning one ordinary `Connector` with the
provider's endpoint, region, auth, and rate-limit defaults already right — and
the ethos now names a maintained prebuilt connection the preferred authoring
path, with `remoteMcp()` and `api()` staying equal first-class primitives for
everything nobody maintains. Connector guides became structured: a guide can
declare a bounded `summary` and mark itself `required`, and discovery carries
`guideSummary` with `guideRequired`/`guideRequiredReasons`, so an agent fetches
a guide when it changes the call and skips it when a complete read-only schema
already says everything. A connector-scoped search whose catalog is down now
returns a typed `catalogError` instead of advice to retry later. And the tool
descriptions stopped inviting the two failures the new cold-agent benchmark
kept catching: a top-level search that duplicates the one the program was about
to run, and a program guessing at a result shape it never read.

No API breaks. `usageGuide` still accepts a plain markdown string and means
exactly what it did; every new discovery field is additive and absent unless
earned. What changed under existing deployments is text, and it is worth
knowing about: the served tool descriptions and the MCP `instructions` string
are rewritten, and `skills({})` now summarizes a connector guide from its first
body line rather than its heading — a guide opening `# Acme` that used to list
as "Acme" now lists as the sentence beneath it. The built-in usage skill also
grew, because the per-connector guides section is now appended unconditionally
rather than only where a guide exists; that keeps the shared guide
byte-identical across every deployment, so an agent that read it once in a task
never needs a second local copy, at the cost of one paragraph in deployments
with no guides. Upgrading is a version bump and nothing else — there is no new
configuration, no new dependency, and no behavior a deployment must opt into
(#294, #295, #296, #297, PRs #298–#302).

### Added

- **A maintained Mixpanel connection at `./providers/mixpanel`.**
  `mixpanel(id, { purpose, region?, auth?, instructions?, title?,
  maxResultBytes? })` proxies Mixpanel's hosted MCP server with the endpoint
  chosen by data residency (`us`, `eu`, `in`, default `us`), OAuth by default
  and static headers for service accounts, HTTPS required, and a rolling
  600-calls-per-hour admission budget matching the provider's published limit.
  It carries a maintained usage guide — start at `Get-Projects`, then
  `Get-Business-Context`; discover names instead of guessing spellings; fetch
  `Get-Query-Schema` before `Run-Query` — to which a deployment may append its
  own account instructions. The subpath is an optional import, not a
  dependency: nothing new installs with core.
- **Fill-in-only vetted safety annotations.** The connection classifies 63
  Mixpanel tools — 35 read-only, 28 writes split into additive creates and
  destructive edits — but only where the downstream is silent. An explicit
  `destructiveHint: true` or `readOnlyHint: false` from Mixpanel on an
  allowlisted read name wins, because that is the downstream saying this
  release's allowlist is wrong. Tools this release has never seen fail closed
  to approval-visible rather than being assumed safe.
- **`ConnectorUsageGuide`.** A connector may now declare
  `usageGuide: { content, summary?, required? }` instead of a bare string.
  `summary` is the bounded line discovery shows; `required: true` says correct
  use always depends on conventions no tool schema can carry. Mutations and
  truncated schemas already require review and do not need the flag.
- **`guideSummary`, `guideRequired`, and `guideRequiredReasons` on discovery.**
  `search_tools`, `connecta.search`, and `connecta.describe` now say what a
  guide covers and whether it must be read first, with the reason named:
  `connector_required` and `approval_required` stand however far a schema is
  expanded, while `schema_truncated` clears once describe returns the exact
  shape. A connector-scoped search that matches nothing still surfaces the
  connector's guide, so an agent that searched the wrong terms learns the
  vocabulary instead of concluding the connector is empty.
- **A scoped `catalogError`.** A search explicitly scoped to one connector
  whose catalog is unavailable now returns the classified failure — `code`,
  bounded `message`, `retryable`, and `retryAfterMs` when known — so an agent
  can tell a transient outage from one an operator has to clear. Exactly four
  fields, pinned by a test: an unscoped search still gets only
  `unavailableConnectorCount`, because one connector's failure is not another
  search's context.

### Changed

- **Routing guidance no longer invites redundant discovery.** Top-level
  `search_tools` is now reserved for a single unreduced read or for
  write-capable work; anything involving reduction, dependent steps, loops, or
  joins is one `execute_code` program that searches and calls inside the run.
  Search guidance also tells an agent to scope to an obvious connector id and
  to require purpose, input, truncation, safety, and output fit rather than
  taking the first lexical match. Measured against the shipped text over five
  repetitions, route compliance went from 9/30 to 25/30.
- **`call_destructive_tool` carries the guide note.** Destructive multi-step
  work keeps its route through top-level discovery — `execute_code` admits only
  read-only tools — and its description now says to inspect the address and
  fetch any guide it names before a consequential call.
- **The ethos prefers prebuilt connections, and refuses a registry.** The
  decisions table accepts prebuilt connections as the preferred authoring path
  *when connecta maintains one*, fenced: exactly one ordinary `Connector` with
  no extra privileges, never a bundle or preset, tools hand-written or proxied
  rather than generated from a schema document, and vetted annotations that
  only fill in downstream silence. A provider registry or integration
  marketplace is refused outright — prebuilt connections are imports, not
  listings, and discovery happens in documentation, never at runtime.
- **The usage skill is byte-identical everywhere.** The per-connector guides
  section is appended unconditionally and rewritten to route on
  `guideRequired`/`guideSummary` rather than telling agents to read every
  guide before first use. Guide-free deployments still pay no fixed
  tool-description cost — the conditional notes in the meta-tool descriptions
  remain absent.
- **Guide summaries prefer substance over headings.** `skills({})` reads a
  guide's first meaningful body line, falling back to the heading and then to
  the connector description, so a listing describes what a guide says rather
  than what it is titled.

### Fixed

- **The Mixpanel connection could not have booted.** Its call-admission rule
  paired a budget with `retryAfterMs` — a queue setting without a queue, which
  the admission controller refuses at construction. No suite caught it because
  every suite stubbed remote-MCP before the registry saw the connector; a new
  suite now boots two accounts through the real `createConnecta` with `fetch`
  rigged to throw, proving the boot and the per-account address, catalog,
  storage, credential, and budget namespaces.
- **Tool descriptions claimed a waiver describe already performs.** Three
  descriptions said schema expansion never clears a guide requirement while
  `describe` cleared `schema_truncated` on every call. The text moved to the
  behavior rather than the reverse.
- **Package-surface guards derive from `src/providers/`** instead of naming
  `mixpanel.ts`, so the next provider fails them only for a real reason.

### Internal

- **A cold-agent benchmark lane in `eval/`.** Fourteen cases across two lanes —
  eight measuring whether an agent meeting a connector cold discovers, routes,
  and recovers, six measuring route compliance for the description rewrite —
  with a comparator that refuses to compare runs whose harness, scoring, or
  sandbox fingerprints differ, and reports a `productSha256` over `src/**`. A
  baseline and a candidate cut from one working tree record the same commit and
  the same dirty flag, and only the fingerprint says whether the candidate
  measured changed code. It also reports host-routing probes separately from
  foreign calls, so a contaminated run announces itself instead of reading as a
  product regression. `eval/` is not in the published `files` list; deployments
  never see it.

## 0.12.2 — 2026-08-02

Rendered programs can now bind a small, explicit set of read-only connector
calls into their view. `connecta.ui(html, { reads })` validates every binding
against the request-local catalog before accepting the UI, and the trusted
Apps shell exposes only those names and declared view arguments through
`connecta.read`. The program markup never receives connector addresses or a
general tool channel, and mutation-capable tools remain unavailable. Existing
`connecta.ui(html)` calls are byte-for-byte unchanged and remain display-only;
deployments whose views do not need refresh, pagination, or drill-down reads
can ignore this release. No deployment configuration changes are required
(#287, #289, PR #290).

### Added

- **Bounded read bindings for rendered views.** Programs may bind 1–32 names
  to catalog addresses proven read-only, with optional fixed arguments and an
  allowlist of view-supplied arguments. The manifest shares the existing
  emitted-byte budget and binding does not dispatch a call or spend the
  program's host-call budget.
- **A narrow `connecta.read(name, args)` view API.** The trusted outer shell
  translates bound names into ordinary `call_tool` requests, reusing its
  current authorization, catalog, and safety checks. It rejects unknown names,
  undeclared arguments, fixed-argument overrides, and more than eight
  concurrent reads.

### Changed

- **The program UI resource advances to `/v2`.** The new shell requires the
  host's MCP Apps server-tools capability and makes only `call_tool` visible to
  the app; the other six meta-tools remain model-only. Display-only views do
  not receive the read bridge.
- **The UI security contract is explicit.** The new design record defines the
  data flow, threat model, validation rules, executor parity, and the boundary
  between accepted reads and still-gated mutations.

## 0.12.1 — 2026-08-01

Instructions, not behavior. Calling-side feedback and a first-hand run of the
render loop found the same gap twice: a program that renders a view has to guess
at shapes the text never showed it. Guessing `{ result }` for a batch entry
fails silently through optional chaining — the run succeeds, the view renders,
and it is confidently empty — so the entry envelope now rides the
`connecta.call`/`connecta.batch` capabilities bullet rather than prose three
paragraphs down. The `connecta.ui` bullet and a new `U12` state the other half:
the model reads the return value, not the view, so a program that renders one
also returns the summary built from the same variables the view renders. No
runtime path changed. The only deltas a deployment ships are the served
`execute_code` description, the served usage skill, and the docs — upgrade and
its agents simply read better instructions. Nothing breaks, and a deployment
whose agents never render a view can ignore all of it; for the ones that do,
the new text is the entire release (#282, PR #284).

### Changed

- **The batch entry envelope is stated where it is read.**
  `execute_code`'s `connecta.call`/`connecta.batch` bullet now carries
  `{ address, ok: true, data }` / `{ address, ok: false, error, errorDetails }`
  and says to destructure that, not a bare result. Hosts truncate long
  descriptions, so the bullets are a fixed budget: the text moved weight
  forward instead of adding it and came out net shorter, now under a
  4,400-character ceiling test.
- **The return value is what the model reads.** The `connecta.ui` bullet and
  the new normative `U12` in `documentation/code-mode.md` bind program authors
  to returning the summary built from the same variables the view renders — a
  view the return value does not mirror is a view nobody in the loop can check.
  Connecta enforces nothing here; it never reads the HTML or diffs it against
  the return, because a heuristic there would be the host-side projection the
  ethos already refuses.
- **The usage skill has a guarded-render recipe.** A "Rendering a view" section
  says to fetch first and check the shape in code, and on a surprise — empty
  array, missing key — to return a trimmed first record instead of rendering.
  The wrong view becomes the sample you needed.
- **Result sampling on the catalog surface is refused.** The `ethos.md`
  decisions table records `sample` / `dryRun` as refused: sampling is execution
  and cannot ride a catalog read, most tools carry required arguments no
  sampler can invent, and a program that checks the shape before rendering
  already hands back the first record inside the run it was going to make
  anyway, at zero new surface.

## 0.12.0 — 2026-08-01

Programs gained a *view*. `execute_code` code can now call `connecta.ui(html)`
to hand the client one rendered MCP Apps view of the run — the thing
`connecta.emit` could not do, which is give a human something to look at while
the model keeps its cheap textual summary. Programs supply HTML content and
nothing else: the only `ui://` URI in the system is connecta's build-time shell,
so nothing a client could dereference is derived from anything a program said,
and the shell forwards no channel from the program's markup back to the host.
The channel is additive — a program that never calls `connecta.ui` produces the
byte-for-byte prior response, no executor changed to carry it, and there is no
new budget knob. Deployments do gain a `resources` capability and one extension
declaration, both of which the design requires before any host will render.
The design record is `documentation/mcp-ui-design.md` (#266); the contract is
`code-mode.md`'s "Rendered output" clauses (#277).

### Added

- **`connecta.ui(html)` inside `execute_code`.** One non-empty HTML string, at
  most one payload per run, delivered on success only in the tool result's
  `_meta["connecta/ui"]` with `ui: true` on the JSON envelope. A failed program
  discards it visibly (`uiDiscarded: true`), alongside `emittedDiscarded` when
  one failure loses both. The payload spends the existing
  `execute.maxEmittedBytes` aggregate, no block count, and no host calls.
- **The MCP Apps shell.** A static connecta-authored HTML5 template at
  `ui://connecta/program-ui/v1` (`text/html;profile=mcp-app`), served by a
  `resources/read` handler that answers exactly that URI; `resources/list` is
  served and returns an empty list. `execute_code` declares it through
  `_meta.ui.resourceUri` with `_meta.ui.visibility: ["model"]`, and the server
  declares the `io.modelcontextprotocol/ui` extension — the one extension
  connecta advertises, without which no host renders anything.
- **`diagnostics.ui`.** With `diagnostics: true`, the accepted payload's
  serialized byte size, distinct from the `emitted` aggregate.

### Fixed

- **Visible output discarded during QuickJS shutdown.** Closing the executor
  after a program starts now reports accepted blocks and UI as discarded on
  both error paths; admission failures before execution remain unchanged. (#279)

## 0.11.0 — 2026-07-31

**This is a breaking deployment release.** Connecta no longer carries the old
executor-free compatibility surface. Every deployment must configure an
executor and now exposes the same seven tools; construction refuses to boot
without one. Existing code-first deployments keep their model-facing surface.
Node deployments that omitted an executor must add `quickJsExecutor()`, while
Workers deployments must configure a `DynamicWorkerExecutor` and its paid-plan
Worker Loader binding. Remove any `surface` setting during the upgrade. (#273)

The consolidation also removes the classic-only handlers and configuration
that had become two implementations of the same work. Discovery and batching
now have one home inside `execute_code`, while `call_tool`,
`call_destructive_tool`, and result retrieval remain explicit host boundaries.
The superseded code-first gate has been reduced to its surviving measurement
record instead of retaining a second executable version of the product.

### Changed

- **An executor is required.** `ConnectaConfig.executor` is no longer optional;
  use `quickJsExecutor()` from `@zackbart/connecta/quickjs` on Node or
  `DynamicWorkerExecutor` from `@cloudflare/codemode` on Workers. The CLI
  template, examples, doctor, documentation, and package smoke test all enforce
  the same deployment shape.
- **Every MCP connection advertises exactly seven tools.** The former
  top-level `list_connectors`, `describe_tools`, and `batch_call` registrations
  are removed. Their supported equivalents are `connecta.search`,
  `connecta.describe`, and `connecta.batch` inside `execute_code`.
- **The old surface controls fail explicitly.** Supplying the removed
  `ConnectaConfig.surface` option throws instead of being ignored. The
  classic-only `calls.maxBatchResultBytes` option also throws; program batching
  is bounded by the executor and `connecta.batch` limits, while individual
  calls still honor `calls.maxResultBytes` and connector overrides.
- **Cloudflare deployments require code mode.** The Worker example now requires
  its `worker_loaders` binding and the Workers Paid plan rather than falling
  back to the classic surface when the binding is absent.
- **The retired code-first gate is archival.** Its executable harness is
  removed now that code-first is the sole product surface; the current-version
  audit remains the live measurement path.

## 0.10.6 — 2026-07-31

Programs gained a rich-output channel. `execute_code` code can now call
`connecta.emit(block)` to deliver text, image, and audio MCP content blocks
alongside its JSON return value — the piece code mode was missing for output
that cannot be projected, like a screenshot a downstream tool returned. The
channel is additive: a program that never emits produces the byte-for-byte
prior response, no executor changed to carry it, and deployments that do
nothing get sensible budgets. The design record is
`documentation/rich-output-design.md` (#267); the contract is `code-mode.md`'s
"Emitted output" clauses (#270).

Agent recovery is now executable data instead of prose at the remaining local
failure points. Address mistakes, approval reroutes, shortcut collisions, and
paged results identify their next call directly; activity classifies those
moments without retaining payloads. Connector behavior and approval authority
are unchanged.

Alongside both, three pieces of runtime text stop naming tools the receiving
surface does not serve — a routing failure connecta authored itself, and one the
always-loaded-text sweep missed because it only reads descriptions, not error
strings and tool results. All three fixes are agent-visible wording; no wire
shape, tool surface, or policy changes. Operators who tightened
`discovery.probeTimeoutMs` also get that deadline honored inside `execute_code`,
which had been probing at the 30-second default no matter what was configured.

### Added

- **`connecta.emit(block)` inside `execute_code`.** Strictly validated
  `text` / `image` / `audio` blocks, collected host-side and appended to the
  result after the JSON envelope on success only; a failed program discards
  them visibly (`emittedDiscarded`). Budgets fail loudly at the emit call and
  spend no host-call budget.
- **`ConnectaConfig.execute.maxEmittedBytes` / `.maxEmittedBlocks`.** The
  emission budgets, defaulting to 4,000,000 serialized bytes and 32 blocks per
  run.
- **`diagnostics.emitted`.** With `diagnostics: true`, one payload-free
  aggregate (block count and serialized bytes) when a program emitted.
- **Local routing failures carry structured recovery.** Unknown addresses and
  tools suggest scoped discovery, read-path policy refusals preserve the
  canonical address for `call_destructive_tool` — with the original arguments
  when they fit a 512-byte echo budget, and an instruction to re-send them when
  they do not — and ambiguous code-mode aliases list every canonical
  `connecta.call` candidate. The suggested discovery route follows the caller's
  own surface: `search_tools` for a top-level call, `connecta.search` with the
  same arguments for a miss inside `execute_code`, which cannot call a tool.
  The address gets the same 512-byte budget as the argument echo but the
  opposite rule — clamped with a `…` marker rather than dropped, since the
  address is the thing being corrected. Short addresses, which is all real
  ones, come back exact.
- **Destructive calls accept explanatory context.** An optional `reason` of at
  most 500 characters gives the MCP host human-readable intent without entering
  downstream arguments or granting authority. An empty or whitespace-only one
  is treated as absent rather than failing the call.
- **Activity exposes coarse agent friction.** Typed codes derive
  `tool_not_found`, `schema_retry`, `destructive_reroute`, `auth_required`, or
  `result_too_large`; no payload or raw error text is added.

### Changed

- **Paged results name the exact next call.** `call_tool` and `batch_call`
  truncation notices include `get_result` arguments with the generated id and
  byte offset zero. Program results and oversized discovery responses still
  carry no `get_result` route: paging a program's return value is refused by
  design, and a program can shrink anything.
- **`nextAction` is a wider union than it was.** `search_tools` routes may now
  omit `arguments.connector` (an unknown *connector* cannot scope discovery to
  itself), the ambiguous-alias route is keyed `function: "connecta.call"` with
  no `tool` at all, and in-program discovery recovery is keyed
  `function: "connecta.search"` carrying the same `{ query, connector?,
  includeSchemas }` arguments the tool route does. A consumer that narrowed on
  `nextAction.tool` must handle the function-keyed shapes too.
- **An address that resolves to nothing is now recorded.** A call to a
  connector id that does not exist emits one activity event at the address as
  written, with `unknown_address` and `tool_not_found` friction — provided the
  address splits into the `<connectorId>.<toolName>` shape activity keeps; one
  with no interior dot still records nothing. Previously the single most common
  address mistake left no trace at all. Addresses were already a first-class
  activity field; nothing new is retained. Because those fields now hold
  caller-authored text, the recording seam clamps `connectorId` and `toolName`
  at 128 UTF-8 bytes each and `address` at 257, marked with `…` — far past any
  real id, far short of an invented 40 KB one.
- **A truncated result is friction, not an error.** An oversized result reports
  `friction: "result_too_large"` on an `outcome: "success"` event and writes no
  `errorCode`, so consumers counting error codes stop counting truncated
  successes as failures. The Worker D1 example gains a `friction` column;
  existing tables need `ALTER TABLE tool_call_activity ADD COLUMN friction
  TEXT` before deploying it.

### Fixed

- **Discovery errors stay on their advertised surface.** The over-100-address
  rejection and the catalog-probe timeout label now name `describe_tools` or
  `connecta.describe` according to the route the caller actually took, so a
  program is never told to split its list across a tool it cannot call. The
  route is passed in explicitly rather than inferred from the deployment's
  surface: a classic deployment with an executor serves `describe_tools` at top
  level while every in-program describe still arrives through
  `connecta.describe`.
- **The OAuth handoff points at a check the caller can run.** `authorize_connector`
  is registered on both surfaces, but its success instructions told every agent
  to "re-run `list_connectors`" — a tool the code-first surface folded away. A
  code-first deployment is now told to retry the original call and confirm the
  catalog loads with `connecta.search` inside `execute_code`; the classic
  wording is unchanged.
- **`discovery.probeTimeoutMs` reaches code mode.** The sandbox's catalog
  service received the deployment's discovery concurrency but not its probe
  deadline, so an in-program `connecta.describe` against a hung connector waited
  the 30-second default regardless of operator configuration.

## 0.10.5 — 2026-07-30

A consumer-audit recovery release. Schema discovery now provides the bounded
key contracts an agent needs before its first read, a single-address describe
no longer requires plural ceremony, and field-projection failures teach the
array syntax when that is the likely mistake. Discovery payload ceilings and
write admission are unchanged.

### Changed

- **Schema search exposes usable key contracts on both surfaces.**
  `search_tools` now includes `inputKeys`, `requiredInputKeys`, and `outputKeys`
  alongside bounded plain-object schemas, matching code-mode discovery.
  Truncated shapes omit their corresponding key list instead of repeating a
  large partial inventory.
- **One address has a singular describe form.**
  `connecta.describe({ address: "connector.tool" })` complements the bounded
  plural form. Supplying both forms is rejected with a direct conflict error.

### Fixed

- **Projection misses teach array traversal when applicable.** Tool guidance
  documents `results[].id`, and a plausible `results.id` miss gains a targeted
  hint when the declared output schema confirms the array path.

## 0.10.4 — 2026-07-30

A small code-mode recovery release. The `execute_code` contract now shows the
literal object shape required by `connecta.describe`, and its validation error
repeats that shape when a program passes a bare address or array. Valid programs
and deployments without an executor are unchanged.

### Fixed

- **`connecta.describe` states its argument shape at both failure points.** The
  tool description now spells out `{ addresses: ["<connectorId>.<toolName>",
  ...] }`, and a malformed call receives the same actionable example instead of
  only learning that `addresses` must be an array.

## 0.10.3 — 2026-07-30

Two agent-recovery gaps are closed without changing the seven-tool surface.
Code-mode search now points directly at connector guides, and predictable
remote argument mistakes return bounded schema findings before provider
dispatch. Deployments without connector guides and calls with valid arguments
are unchanged.

### Fixed

- **Connector guides survive code-mode search.** Every guided tool returned by
  `connecta.search` carries the same `connector:<id>` identifier as
  `search_tools`, including scoped, paginated, and partial results.
- **Remote argument mistakes are structured and non-retryable.** Supported
  advertised input schemas produce `invalid_args` with bounded JSON Pointer,
  keyword, and expected-shape findings across direct, destructive, batch, and
  generated-code calls. Submitted values are not copied into recovery metadata,
  and unknown provider error formats remain generic.

## 0.10.2 — 2026-07-30

A prescribed deployment path for agents and operators. `connecta init` now
creates one small, reviewable Node project with exact dependencies and
auto-discoverable conventions; `connecta doctor` proves the running endpoint is
healthy, advertises the intended seven tools, and can actually execute a
harmless QuickJS program. The initializer never merges into an existing path,
and it stages the complete project before an atomic rename so an interrupted
setup leaves nothing half-created. **Existing deployments are unchanged.** The
new template refuses to start without an explicit bearer token, while the
repository Docker example now selects the same code-first surface by default.

### Added

- **One command to create the prescribed deployment.**
  `npx @zackbart/connecta init <directory>` writes only the deployment config,
  exact package manifest, TypeScript config, environment example, ignore rules,
  README, and canonical `AGENTS.md` with `CLAUDE.md` pointing to it. The command
  refuses every existing destination and pins the generated project to the
  initializer's exact Connecta version.
- **A live deployment doctor.** `CONNECTA_TOKEN=… connecta doctor` checks
  `/health`, requires the exact seven-tool code-first surface, and runs
  `async () => 42` through `execute_code`. Requests are bounded to ten seconds,
  bearer tokens are accepted only from the environment, and remote plaintext
  HTTP is refused.
- **Artifact-level setup qualification.** The package smoke now installs the
  packed tarball, initializes a deployment, checks overwrite refusal, installs
  and typechecks the generated project, verifies tokenless startup fails,
  starts it with auth, and runs the live doctor through QuickJS.

### Changed

- **Agent instructions have one source of truth.** `AGENTS.md` is canonical in
  the package repository and generated deployments; `CLAUDE.md` is a symlink
  where the filesystem supports it.
- **The setup material ships with the package.** The standalone template,
  agent-facing documentation, ethos, and usable Node and Worker examples are
  available beside the installed package. Docker remains explicitly
  repository-only because its reproducible build consumes repository inputs.
- **The Docker example is code-first by default.** Its entrypoint configures the
  bounded QuickJS executor instead of leaving operators to infer and add it.

### Fixed

- **The prescribed Node deployment no longer has a known fallback secret.**
  Both the generated template and repository example refuse startup when
  `CONNECTA_TOKEN` is absent.
- **Failed initialization no longer strands a partial destination.** Work is
  assembled in a uniquely named sibling directory, cleaned on failure, and
  renamed into place only when complete.

## 0.10.1 — 2026-07-30

An inbound-auth escape hatch for MCP clients whose OAuth implementations do not
interoperate cleanly with a Connecta deployment. Eligible Clerk operators can
now issue named, revocable Bearer tokens from `/tokens`; each call is attributed
to the token's immutable identity while activity history resolves the current
friendly name. The secret is shown once, only a SHA-256 digest is stored, and a
token can authenticate MCP without gaining operator privileges. **Deployments
that do not set `accessTokens: {}` are unchanged.** Enabling it requires a
storage adapter with `list(prefix)` and a Clerk auth provider so token lifecycle
operations remain behind the human operator boundary.

### Added

- **Managed MCP access tokens.** `accessTokens: {}` adds a Clerk-only operator
  ledger for creating, naming, renaming, and revoking `cta_…` Bearer tokens.
  `maxActive` defaults to 100 and can be configured from 1 through 1,000.
- **Token-attributed activity.** Calls authenticated by a managed token record
  its immutable token ID and resolve the current friendly name when an eligible
  operator reads activity. Revoked metadata remains as a tombstone so historical
  attribution survives rotation.
- **Enumerable storage.** `KVStorage.list(prefix)` is available for durable
  metadata ledgers, with implementations in the built-in memory and file
  adapters and the Cloudflare Workers KV example.

### Fixed

- **One-time secrets leave no reusable operator-UI state.** The plaintext token
  disappears when it is dismissed, when the operator navigates away or signs
  out, and before the document enters the browser back-forward cache. The create
  form stays unavailable while a newly issued secret is waiting to be stored.

## 0.10.0 — 2026-07-30

**Code-first is what a model sees.** A deployment with an executor now serves
seven meta-tools instead of ten: `list_connectors`, `describe_tools`, and
`batch_call` are no longer top-level tools, and their behavior lives in
`connecta.search`, `connecta.describe`, and `connecta.batch` inside a program.
Nothing became unreachable and no policy machinery changed — writes still cross
`call_destructive_tool`, and `call_tool` deliberately stays, because a single cold
call is measurably cheaper direct than through a program. What breaks is a client
that calls one of the three folded names against an executor-backed deployment:
it gets an unknown-tool error. The always-loaded instructions, the `skills`
guidance, and the routing sentences in `call_tool`, `search_tools`, `get_result`,
and `execute_code` are rewritten for that surface, which measures 19.6% smaller
serialized tool definitions (10,675B → 8,587B), correcting the exploration's ~32%
estimate. **An executor-free deployment can ignore all of it**: it serves the same
nine tools with the same descriptions and the same instructions as before, byte
for byte. `surface: "classic"` alongside an executor restores the ten-tool shape.

The default was flipped by owner decision for a single-operator deployment rather
than by the repeated per-model eval that [`ethos.md`](./ethos.md) had gated it on;
that row now records the decision and its reasoning, and
[`eval/code-first-gate`](./eval/code-first-gate/README.md) remains as measurement
with all three of its arms now real deployment shapes rather than harness
simulations.

The code-mode guest API is now specified rather than merely described:
[`documentation/code-mode.md`](./documentation/code-mode.md) states what a
program is promised — surface, addressing, error shapes, projection, retry,
cancellation, limits, activity — with clause identifiers the tests cite, and
names the QuickJS/Dynamic Worker divergences as documented exceptions instead of
leaving them to be discovered. Both executors now run the same contract case
table, the Workers arm against a real Dynamic Worker in workerd. Writing the
clauses down turned up four places where the code did not quite match the
behavior worth having; those are the changes below, all additive or corrective,
and one of them (retryable policy refusals) reaches `call_tool` and `batch_call`
as well as programs.

### Changed

- **The code-first surface is the default wherever an executor is configured.**
  Seven tools: `execute_code`, `search_tools`, `call_tool`,
  `call_destructive_tool`, `authorize_connector`, `get_result`, `skills`. Four
  overlapping ways to reach one connector became two — `search_tools` then
  `call_tool` for a single cold read, one `execute_code` run for everything wider.
  An executor-free deployment is unchanged.
- **`ConnectaConfig.surface`** overrides what the executor implies. The reason to
  set it is `"classic"` beside an executor, which is the ten-tool shape the eval
  gate's incremental arm measures. `"code-first"` without an executor throws at
  construction rather than advertise a program surface that does not exist, as
  does any other value.
- **The eval gate configures its arms instead of faking one.** `gate-server.ts`
  no longer filters `tools/list` or rewrites connecta's descriptions: all three
  arms are ordinary deployments, so the harness measures the product and the arms
  are byte-for-byte identical in the transport layer.

### Added

- **Typed failures inside `connecta.batch`.** A failed call now reports
  `{ address, ok: false, error, errorDetails }`, where `errorDetails` is the
  same typed object `batch_call` returns (`code`, `retryable`, `retryAfterMs`,
  and the `auth_required` recovery envelope). A thrown host error crosses the
  sandbox bridge as a bare message in every executor, so this is the one channel
  through which a program can tell a policy refusal from a transient failure
  instead of cheerfully retrying the refusal. Programs reading `error` are
  unaffected. An entry connecta could not even attempt — a malformed call object
  — reports `batch_call_failed`, the code `batch_call` already uses for the same
  situation.

### Fixed

- **A policy refusal can no longer look retryable.** `unknown_address`,
  `unknown_tool`, `ambiguous_tool_alias`, and
  `destructive_tool_requires_approval` now pin `retryable: false` instead of
  deriving it from their own message text. Those messages embed the address the
  caller asked for, and the heuristic that classifies connector errors matches
  `503`, `429`, and `temporar`, so a connector named `svc-503` or
  `temporary-export` turned a refusal that will never succeed into one an agent
  was told to retry. This affects `call_tool` and `batch_call` too, not only
  programs.
- **An uncaught discovery-bound failure inside a program is typed.** A bad
  `limit`, an oversized `addresses` list, or a discovery page over the
  256,000-byte ceiling now reaches the model as `invalid_args` or
  `result_too_large` with `retryable: false`, the same envelope a failed tool
  call gets, instead of as untyped error prose.
- **Bridge-limit errors name the address, not the plumbing.** A host call over
  the QuickJS 256 KiB bound reported `connecta.__callNamespace` — the internal
  dispatcher every shortcut namespace shares — where it now reports the
  `connector.tool` address the program called.
- **An oversized program result is truncated once.** The over-cap notice is now
  sized so its *serialized* form fits the 24,000-character result cap.
  Previously the QuickJS path truncated in the child and again in the parent, so
  a very large result came back as a truncation envelope wrapped in a truncation
  envelope whose `totalChars` reported the inner envelope's length rather than
  the real size. Previews are somewhat shorter; `totalChars` is now the true
  serialized size of what the program returned.

## 0.9.1 — 2026-07-29

A code-mode routing release. Agents that needed an unknown address *and* a
dependent call used to spend two outer executions on it — one to search, one to
act. They now spend one: schema-bearing `connecta.search()` matches carry the
exact field names a dependent program needs, and `execute_code` says to search
inside the run rather than ahead of it. A deployment can ignore all of this
unless it runs code mode; nothing in the published surface, the nine base
meta-tools, or `search_tools` responses changed.

Measured against the previous release across 60 matched runs per arm with a
pinned model: the dependent one-pass route went 0/10 to 10/10, the intended
route 41/60 to 52/60, exact addresses and arguments 58/60 to 60/60, and outer
round trips fell 10.8%. Final-answer correctness stayed at 60/60 in both arms.
The trade is real and recorded rather than buried: agent *output* tokens rose
38.3% and non-cached host input 107.1%, both reproducing across replications,
while total agent input still fell 1.7%. Search performance is untouched —
10,000-tool warm-search p50 stays near 3 ms.

### Added

- **Schema key metadata in code mode.** `connecta.search()` matches that carry
  schemas also carry `inputKeys`, `requiredInputKeys`, and `outputKeys`. The
  names come from the same walk that renders the compact schema, so a top-level
  `$ref` resolves and an `allOf` composes instead of reporting an empty field
  list beside a schema that plainly lists fields. A schema that is not an object
  shape — a union, an array, an unresolvable `$ref` — gets no lists rather than
  empty ones: absent means "read the schema", where `[]` would claim the tool
  takes no fields. A program that wants the bytes back passes
  `includeSchemaKeys: false`.

### Changed

- **`execute_code` routes dependent unknown-address work in one execution.**
  Its description, the server instructions, and the usage guide agreed on the
  two-round-trip pattern; they now agree on the one-pass one, and still send
  search-only and single-call work to `search_tools` and `call_tool`.
- **The dependent example names its fields.** It previously indexed
  `requiredInputKeys[0]`, which is a positional guess in a description that
  forbids guessing, and worked only because the benchmark's tool has exactly
  one required key.

### Fixed

- **The workflow-by-id benchmark fixture no longer contradicts its own
  prompt.** It asked for "the integration's JSON result" while naming a
  projection of it, so no answer satisfied both readings and a wording defect
  scored as a routing failure.

## 0.9.0 — 2026-07-29

Connecta now speaks the 2026-07-28 MCP revision on both sides while retaining
its legacy compatibility floor (#176). Nothing breaks for deployments:
Connecta's exports, configuration, connector definitions, meta-tool surface,
and its own stateless `/mcp` behavior are unchanged. Deployments can ignore the
wire revision entirely unless they imported or pinned transitive MCP SDK
internals; those internals moved from the v1 monolith to the exact-pinned v2
client and server packages.

This is alignment and compatibility work, not a state-management rewrite. The
new spec arrived at Connecta's existing stateless server design. Modern clients
now negotiate without `initialize`, while legacy clients remain served.
Stateful legacy *downstreams* still require Connecta's explicit session DELETE:
tests confirm SDK v2 client close does not make it redundant.

### Added

- **Modern/legacy version negotiation and cache metadata.** Modern
  `tools/list` results declare a one-hour private cache lifetime; the legacy
  initialize path and session headers remain supported.
- **Issuer-bound downstream OAuth storage.** Registrations and tokens are
  stored with the validated authorization-server issuer. A changed issuer
  advances the existing generation fence before the SDK starts a fresh grant;
  pre-upgrade credentials bind in place on their first validated read.
- **A complete in-repo disposition of the revision** in
  [`documentation/mcp-2026-07-28.md`](./documentation/mcp-2026-07-28.md),
  including the declined and gated surfaces.

### Changed

- **Downstream multi-round-trip results fail loudly instead of being
  misread as complete.** `call_tool`, `batch_call`, and the `execute_code` host
  boundary preserve the non-retryable `input_required_unsupported` code.
  Passthrough remains gated until a real host and downstream establish the
  resumed-call contract.
- **Browser CORS allows the modern `Mcp-Method` and `Mcp-Name` request
  headers.**
- **JSON Schema 2020-12 compatibility is pinned by exotic-keyword discovery
  and validation coverage.**

## 0.8.1 — 2026-07-29

0.8.1 hardens agent routing, response efficiency, and credential recovery while
making deployment boundaries the audience-scoping model. It removes toolkits
and proactive credential liveness probing: deployments still using either
retired configuration must migrate, and stale configuration fails at startup
instead of silently widening access. Deployments that use neither retired
feature need no configuration or storage migration; orphaned credential-health
records and old toolkit columns can remain unused.

Against the pre-0.8.1 release-audit baseline, all 21 task scenarios still pass,
discovery remains at 89.7% top-1 accuracy and 100% positive/default-page recall,
and discovery mean precision improves from 46.4% to 73.5%. The same 55 round
trips take 225.6 ms versus 228.4 ms of summed local-call latency (effectively
flat). Definition tokens move from 2,164 to 2,174 and request tokens from 1,144
to 1,145, while response tokens fall from 68,765 to 16,343 (-76.2%) and the
complete measured surface falls from 72,073 to 19,662 tokens (-72.7%).

### Added

- **A current-version release audit and independently authored discovery
  holdout** (#189). It exercises every meta-tool, destructive routing, OAuth
  and static-credential recovery, result paging, client compatibility, and the
  payload-free activity invariant on Node 20 and 22. Its evidence stays under
  `eval/` and is excluded from the published package.

### Changed

- **Lexical discovery ignores conservative conversational framing and defaults
  to eight results instead of 25** (#190). Action terms such as `get`, `list`,
  `search`, `find`, and `create` remain significant; cleanup that removes every
  term falls back to the original query. Explicit `limit` still supports up to
  100 results, and `total`, `hasMore`, and `nextOffset` preserve complete
  pagination. On the holdout, mean results fall from 14.0 to 2.853 and negative
  false positives from 80% to 20%, without losing positive or default-page
  recall.
- **`execute_code` is advertised only with a configured live executor** (#193).
  The existing capability boundary is now explicit in instructions,
  documentation, and regression coverage: deployments without code mode expose
  the nine base meta-tools; deployments with it expose ten.
- **The `usage` guide is slimmer and fetched on demand** (#194). The
  `skills` meta-tool and per-connector guide delivery remain unchanged, while
  the generic guide drops redundant examples and keeps only routing, probe,
  recovery, and code-mode rules. Server instructions now recommend fetching it
  when the routing workflow is unfamiliar instead of once per task.
- **Structured results now serialize compactly in text compatibility content**
  (#191). `structuredContent` remains the canonical full-fidelity object and
  `content` remains complete JSON for text-only clients, but indentation no
  longer inflates discovery, call, paging, batch, authorization, or code-mode
  responses. Replacing the compatibility copy with a summary remains deferred
  until host-forwarding measurements justify departing from MCP's compatibility
  guidance.
- **Credential recovery has one agent-facing route** (#192).
  `auth_required` errors now name the connector, failed operation, recovery
  class, `authorize_connector` call, operator handoff, and retry. Calling
  `authorize_connector` returns `recovery: "oauth"`, `"operator_config"`, or
  `"unavailable"`; static handoffs expose only declared field names and
  guidance plus the Clerk-protected `/credentials` URL, never credential
  values. A missing `credentials.encryptionKey` now boots with an explicit
  unavailable recovery state instead of preventing the deployment from
  explaining the problem.
- **Toolkits are removed** (#178). `ConnectaConfig.toolkits`, toolkit bindings
  on `bearerToken` and `clerkAuth`, `?toolkit=` routing, scoped registries, and
  the operator UI's toolkit projection no longer exist. Passing `toolkits` or
  `unscoped` to any of those construction surfaces throws instead of silently
  widening access, and an `/mcp` request still carrying `?toolkit=` — a URL
  minted before the retirement — gets an explicit 404 naming #178, never a
  silent widening to the full registry.
- **Activity events no longer carry `toolkitId`.** The Worker D1 example drops
  its `toolkit_id` column; existing columns may be left in place unused.
- **Proactive credential liveness is removed** (#179), reverting the feature
  introduced in #24. `credentials.health`, legacy `credentialHealth`,
  `Connecta.checkCredentials`, scheduled sweep wiring, persisted verdict reads
  and writes, and `credentialCheck` response/UI fields no longer exist.
  Operator-triggered credential tests and local stored-shape drift detection
  remain. A drifted connector now reports `auth_required` directly from the
  drift check — `list_connectors` with `probe: true` and `/ui/data` no longer
  live-probe a connector whose stored credential cannot be consumed anyway.
  Existing `credhealth:*` KV records are harmless orphaned data: they are
  never read or rewritten, and no cleanup migration runs.

### Fixed

- **Missing credential-vault configuration now fails at use with a typed,
  actionable recovery envelope** (#192) instead of preventing the deployment
  from starting before an agent or operator can diagnose it.

## 0.8.0 — 2026-07-28

0.8.0 is consolidation before capability growth (#157): the semantics that were
independently implemented across call paths — invocation, catalog access,
discovery bounds, timeouts — now live in shared services, the oversized modules
(`server.ts`, the operator UI) are split into typed, tested units, and the dev
loop gained correctness-only linting, an unused-code gate, strict indexed and
optional property checks, and an automated Workers test-partition guard. A
deployment can take this release without touching its config: entrypoints,
options, storage formats, and the tool surface are unchanged. The docs were
restructured — the old numbered manual is retired in favor of a terse
[`ethos.md`](./ethos.md) and stub guides in `documentation/` — and the
temporary `@hono/node-server` override is gone now that the SDK (1.30.0)
depends on a patched version upstream.

### Added

- **`ethos.md`** — what connecta is, what it refuses to be, a decisions table,
  and the invariants, each enforced or reviewer-owned (#175, PR #180). CI caps
  its length; terseness is the point.
- **Route-contract and operator-UI browser tests** pinning server behavior
  before extraction (#148 PR #168, #149 PR #169).
- **Automated Workers test-partition guard** — every suite must be classified
  portable or Node-bound, with a reason (#150, PR #161).

### Changed

- **Tool invocation and catalog access are shared services** used by direct,
  batch, and code-mode paths alike (#144, PR #162); code-mode dispatch is lazy
  (#145, PR #163); catalog discovery is deduplicated and bounded (#146,
  PR #164); persisted catalogs are chunked with bounded I/O (#147/#167,
  PRs #166/#172).
- **`server.ts` is a composition root** over extracted route modules (#148,
  PR #170); the operator UI is typed, bundled browser source (#149, PR #169).
- **Strict indexed access and exact optional property types** are on across
  src and tests (#151, PR #181); Oxlint correctness and Knip unused-code gates
  run in `npm run check` (#155, PR #171).
- **`@modelcontextprotocol/sdk` 1.30.0** with the `@hono/node-server` override
  removed (#40, PR #174).
- **Docs restructure** — `docs/` retired; `README.md` is a short overview and
  per-subsystem guides will be rewritten in `documentation/` (#175, PR #180).
  Toolkits (#178) and proactive credential liveness (#179) are recorded as
  retired decisions; their code remains in this release pending removal.

### Fixed

- Nothing user-visible; behavior-preserving consolidation throughout.

## 0.7.9 — 2026-07-28

0.7.9 adds opt-in, connector-scoped admission for downstream tool calls. Direct
calls, batch children, and code-mode host calls to the same connector now share
one per-runtime limiter, including through toolkit-scoped views. Connectors
without a `callAdmission` policy behave as before. Dependencies, storage
formats, and package entrypoints are unchanged.

The policy is exact within one Node process or Worker isolate. Concurrency
limits fully contain one request's fan-out; rolling budgets remain best-effort
across multiple isolates, replicas, or restarts. This release deliberately
does not add a distributed coordinator.

### Added

- **Connector-scoped downstream admission** (issue #138, PR #143).
  `api()`, `remoteMcp()`, and custom connectors accept a plural-ready
  `callAdmission.rules` policy. The single rule supported today can bound
  concurrency, queue size and wait, and rolling-window calls, optionally
  partitioned by a bounded operator-derived key.
- **Payload-free admission telemetry.** `/health` reports connector aggregates
  for live partitions, active and queued calls, admission outcomes, and queue
  waits without exposing partition keys, arguments, or results.
- **Explicit cancelled Activity outcomes.** Caller cancellation is represented
  separately from provider errors and timeouts in the public Activity event
  union, the operator UI, and the Worker D1 example.

### Changed

- **Retries reacquire admission per attempt.** Backoff does not retain a
  concurrency permit, and each actual retry consumes a fresh rolling-budget
  entry. Short proactive `rate_limited` windows continue to use the existing
  safe retry contract.
- **Queue and connector deadlines are separate.** `queueTimeoutMs` bounds only
  permit wait; the per-attempt tool deadline begins after admission.
  `diagnostics: true` reports the phases separately as `admissionMs` and
  `connectorMs`.

### Fixed

- **Caller cancellation no longer retries an abandoned attempt or degrades
  connector health.** A call already cancelled avoids connector dispatch.
  Queued cancellation still releases its place without spending a
  rolling-budget entry, while active cancellation releases its permit and
  records a non-retryable `cancelled` result.

## 0.7.8 — 2026-07-28

0.7.8 makes dependency-free tool discovery recover from natural-language
queries that contain more related terms than one catalog entry covers, and
closes the aggregate result-size gap in `batch_call`. Small batches, exact and
all-term search ranking, empty-query browsing, dependencies, storage formats,
and package entrypoints are unchanged.

Existing deployments gain an independent 100,000-byte final batch-envelope
boundary. Set `calls.maxBatchResultBytes` to another whole positive byte count
when needed. When the boundary is crossed, successful payloads move behind the
existing `get_result` page handle while ordered success/failure outcomes and
bounded failure details remain inline.

### Added

- **An independent aggregate batch-result cap** (issue #139, PR #141).
  `calls.maxBatchResultBytes` defaults to 100,000 bytes, is validated with the
  ordinary result-cap rules, and applies after every child's global or
  connector-level guard. The exact serialized `{ results, durationMs }`
  envelope is stashed in the existing toolkit-aware result store and pages with
  the same byte offsets and UTF-8 invariants as ordinary guarded results.

### Changed

- **Lexical tool search recovers from over-specified queries** (issue #137,
  PR #140). Exact, prefix, and all-term ranking remains the first stage. Only
  when an entire scoped search has no match does dependency-free fallback rank
  partial matches by term coverage, tool-name coverage, and stable catalog
  order, marking the response with `matchMode: "partial"`. The behavior is
  shared by `search_tools` and code mode's `connecta.search`; no-overlap
  searches remain empty.

### Fixed

- **`batch_call` can no longer multiply the inline result boundary by child
  count** (issue #139, PR #141). The complete final envelope is measured before
  emission. Oversized batches return a compact ordered outcome summary plus a
  `get_result` handle, with partial failures still visible inline and successful
  data available through paging. Below-cap batches retain their prior response
  shape.

## 0.7.7 — 2026-07-27

0.7.7 gives operators explicit downstream OAuth lifecycle controls, makes
Activity identities useful without weakening their privacy boundary, and
hardens persistent connector state against reset and cleanup races. The
Connections page now reports the installed Connecta package version rather than
the deployment's configurable MCP server version. There are no dependency or
package-entrypoint changes.

Deployments using the optional Worker D1 Activity example must add its nullable
`actor_namespace` column before deploying the updated writer; the example
README includes the `ALTER TABLE` migration. Existing rows remain valid legacy
events and fail closed when their identity directory is ambiguous.

OAuth epoch fencing and disconnect are immediate on read-after-write-consistent
storage. Cloudflare Workers KV is eventually consistent, so another location
may temporarily observe the prior epoch or grant; deployments requiring
immediate global disconnect or rotation should use a strongly consistent
adapter such as a Durable Object. Legacy unsuffixed OAuth values require no
migration and remain readable until the first intentional reset. Complete
physical erasure can require operator-side backend prefix cleanup because the
three-method storage seam cannot enumerate keys.

### Added

- **Operator-managed downstream OAuth disconnect and reconnect** (issue #122,
  PR #134). Eligible unrestricted Clerk operators receive same-origin
  Connections controls backed by a durable disconnected epoch. Passive status,
  tool, and UI probes cannot restart consent; only explicit reconnect can
  replace that epoch. Bearer and toolkit-restricted identities remain refused,
  unusable authorization URLs fail closed, and request-owned connector scopes,
  catalogs, health, and toolkit state are refreshed after mutations.
- **Friendly, provider-scoped Activity identities** (issue #124, PR #135).
  Authorized reads may resolve a stored actor through its admitting identity
  directory; Clerk prefers full name, verified primary email, then username.
  Labels are display-only and never persisted or trusted from storage. The UI
  retains a namespace-qualified stable ID, while lookup concurrency, retained
  state, cache size, and page latency remain bounded. Legacy events resolve
  only when one directory is unambiguous.

### Changed

- **Connections reports the installed npm package version** (PR #133). Its
  header now uses the build-asserted Connecta package version rather than the
  configurable deployment/MCP `serverInfo.version`.

### Fixed

- **Persistent connector state is fenced across reset, replacement, and
  cleanup races** (issue #130, PR #132). Downstream OAuth uses epoch-specific
  physical namespaces, one authoritative reset transition, immutable cleanup
  lineage, and one provider per connection attempt so stale callbacks, writes,
  and deletes cannot affect replacement credentials. Catalog invalidation is
  serialized with persisted refreshes, transient OAuth cleanup is retried, and
  Node file-storage pruning occurs only on later mutations so a read cannot
  overwrite a newer value from another instance.

## 0.7.6 — 2026-07-27

0.7.6 gives every runtime an explicit MCP memory-pressure boundary and closes
three Node code-mode failure-reporting and transport gaps. Ordinary requests now
stop at a bounded FIFO before auth and per-request server construction, while
code mode retains a separate smaller pool and health/UI capacity remains
reserved. Existing deployments gain conservative admission defaults; operators
may tune the active count, queue, wait deadline, and retry hint. Node deployments
also get actionable missing-child guidance, bounded stderr context when a
QuickJS child exits abnormally, and transport-aware log truncation that
preserves successful results. There are no dependency, storage, or package
entrypoint changes.

### Added

- **Bounded request admission and observable backpressure** (issue #85,
  PR #129).
  `/mcp` defaults to 16 active requests and 32 queued for at most five seconds.
  Overflow returns HTTP 503 plus a stable JSON-RPC `server_overloaded` error and
  `Retry-After`; queued cancellation removes the caller immediately, response
  completion/error/cancellation releases exactly once, and shutdown rejects
  queued/new work before draining active requests. `/health` reports
  payload-free bounds, active/queued counts, rejection/cancellation totals, and
  queue-wait observations while operator routes bypass the MCP pool.
- **Separate fallback admission for one-method code executors.** Executors that
  do not implement `acquire()` receive a default 2-active/8-queued pool.
  Already-bounded executors keep their own limits, and the built-in QuickJS pool
  now exposes the same health snapshot.
- **A split-process real-TCP load/soak harness** (`npm run load:admission`) for
  the 100/500/1,000/5,000-call matrix and a repeated 15,000-call soak, recording
  verified outcomes, throughput, p50/p95/p99, server-only peak/RSS-after-GC,
  and live heap without turning host-specific numbers into CI assertions.

### Fixed

- **Abnormal QuickJS child exits now include bounded stderr context** (issue
  #118, PR #126). The parent retains only the most recent 8 KiB, waits for stdio
  to close so final crash output is available, and includes the tail in startup
  and runtime exit diagnostics without allowing stderr to grow unbounded.
- **Missing QuickJS child files fail before `fork()` with an actionable error**
  (issue #119, PR #127). The message names the exact expected
  `quickjs-child.js` path and tells bundled Node deployments to externalize
  `@zackbart/connecta` or its `quickjs` subpath so the published child file
  remains on disk.
- **QuickJS log truncation now budgets the bytes used by the complete IPC
  transport** (issue #120, PR #128). The existing entry and character caps
  remain, with an additional 512 KiB allowance measured after both JSON
  encodings and space reserved for the truncation marker, preventing
  escape-heavy logs from displacing an otherwise valid result in the 1 MiB
  child-message envelope.

## 0.7.5 — 2026-07-27

0.7.5 makes the deployable Cloudflare Worker starter match Connecta's
pay-as-you-opt-in runtime behavior. The default config now runs on Workers Free;
accounts that want sandboxed `execute_code` add one paid Worker Loader binding,
and the existing optional `env.LOADER` wiring turns code mode on without a
source edit. There are no package API or runtime changes.

### Changed

- **The Cloudflare Worker starter is now free-tier compatible by default.**
  Its Worker Loader binding is an explicit paid-plan opt-in: adding that one
  Wrangler block makes the already-optional `env.LOADER` register
  `execute_code`, while leaving it absent serves the nine base meta-tools from
  the same TypeScript. The Worker example, package README, and code-mode
  reference now document the binding-as-switch pattern, plan requirement, and
  deployment-owned `@cloudflare/codemode` install together.

## 0.7.4 — 2026-07-27

0.7.4 moves the built-in QuickJS executor out of the HTTP-serving process. A
runaway guest used to occupy Node's event loop for its entire wall budget —
health checks, ordinary tool calls, timers, and shutdown all waited behind it.
Guest code now runs in a bounded pool of replaceable child processes behind
FIFO admission, so the serving thread stays responsive regardless of what the
model wrote, and a WASM abort or interpreter OOM kills a disposable child
instead of the server. Deployments without an `executor`, and Workers
deployments on `DynamicWorkerExecutor`, can take this release without reading
further — the nine base meta-tools and every package entrypoint are untouched.
Node code-mode deployments should note two intentional guest-visible changes:
synchronous guest CPU gets its own 250 ms default budget separate from the
30 s wall clock, and connector namespaces are lazy proxies, so
`Object.keys(github)` is empty and an unknown function fails through the host
bridge rather than at property access. Neither grants any authority.

### Added

- **QuickJS child-process pool with bounded admission** (issue #83, PR #116).
  `quickJsExecutor()` gains `cpuTimeMs`, `concurrency`, `maxQueueSize`, and
  `queueTimeoutMs` beside the existing wall/memory/stack caps. Admission is
  acquired before provider construction, so queued calls retain no catalogs or
  request-scoped closures; overflow and queue expiry return the stable,
  retryable `executor_overloaded` error with `retryAfterMs`, and cancellation
  and shutdown report `executor_cancelled` / `executor_closed`. Every
  parent/child IPC envelope is byte-bounded, the parent treats child messages
  as untrusted input, and a wall timeout retires the child on a structural
  flag rather than error text a guest could fabricate.
- **`Connecta.close()`** drains and releases executor resources, idempotently.
  The Node `listen()` adapter calls it the moment graceful shutdown begins, so
  sandbox children stop holding open the very requests shutdown waits on.
- **`AdmittingExecutor` and `ExecutorLease`** extend the one-method `Executor`
  seam for bounded executors. The lease carries execution so an
  already-admitted caller cannot acquire twice and deadlock a pool of one;
  `DynamicWorkerExecutor` remains structurally compatible unchanged.
- **HTTP client disconnects now cancel in-flight work** in the Node adapter:
  the abort propagates through the Web `Request` into `execute_code` catalog
  construction, queued admission, host calls, and the running child.

### Fixed

- **Downstream session termination gets a realistic acknowledgement window and
  an operator-visible failure signal** (issue #96, PR #117). Probe callers
  retain their 100 ms teardown cap while the headers-only `DELETE` gets one
  second for a cross-internet round trip; Workers keep that bounded tail alive
  with `waitUntil`. Refusals and transport failures now warn through the
  deployment logger, and expiry is reported honestly as unacknowledged because
  the downstream may still complete a request that was already sent.

## 0.7.3 — 2026-07-27

0.7.3 is the first published package after 0.7.1. It consolidates the
unpublished 0.7.2 candidate with the hardening and operator work that followed:
catalog deadlines and authorization recovery, session-safe operator pages,
terminal probe and QuickJS cleanup, decisive credential-shape drift, stronger
documentation checks, and a read-only toolkit map. There are no dependency,
configuration, storage-schema, or breaking TypeScript changes. The authenticated
`/ui/data` response gains one additive `toolkits` array; existing fields and
package entrypoints are unchanged.

### Added

- **Connections shows the configured toolkit views** (PR #112). Unrestricted
  operators can inspect connector membership, tool inclusions/exclusions,
  currently loaded effective tool counts, and copyable scoped MCP URLs without
  gaining any mutation or persistence path. Toolkit-restricted identities still
  cannot enumerate deployment-wide data, the open HTML shell remains data-free,
  and config-only toolkit descriptions never leave the server.

### Changed

- **Discovery deadlines now govern the catalog work, not only the caller's
  wait** (issue #98). `list_connectors`, `search_tools`, and `describe_tools`
  pass `discovery.probeTimeoutMs` into a full downstream `tools/list` walk.
  Expiry cancels the in-flight page where the transport supports it and prevents
  another page from starting; existing tool/page bounds remain as backstops,
  partial catalogs are never published, and the last complete stale catalog
  remains eligible.
- **`nextCursor: null` is accepted as end-of-pagination** (issue #99). This
  narrow compatibility concession treats the common JSON null spelling like an
  absent cursor while preserving empty string as a real cursor and retaining
  the SDK's validation for every tool and other result field.

### Fixed

- **Authorization expiry is classified consistently across a catalog walk**
  (issue #97). A downstream 401 on any `tools/list` page now reports
  `auth_required` with the pending authorization URL, latches that verdict for
  the request scope, and never publishes the prefix collected before failure.
  Network, protocol, and malformed-page failures remain ordinary errors.
- **Operator pages clear stale identity data when Clerk changes in another tab
  or outside the page** (issue #92). Connector inventory, masked credential
  metadata and notices, activity rows, toolkit rows, and capability navigation
  are discarded together, and the next navigation fetches under the new session
  rather than repainting cached data.
- **The three operator routes handle HEAD and small navigation-state edges
  correctly** (issue #93). `/`, `/credentials`, and `/activity` return their GET
  headers with no HEAD body; Back/Forward focus stays visible while gated;
  credential notices clear on page changes; and credential controls use the
  same Clerk capability predicate as the mutation API.
- **Stored credential-shape drift is decisive on both status and calls** (issue
  #90). The fast connector inventory reports the existing `auth_required`
  replacement state instead of a stale `ok`, while `ctx.credential.get()` and
  `getAll()` reject the obsolete shape before returning any value. Generic
  failed health checks remain non-decisive, valid stored supersets remain
  readable, and replacement/removal remains the recovery path.
- **Probe teardown cannot be skipped or resurrect a closed request scope**
  (issue #91). Sibling work settles before shared teardown, cleanup no longer
  short-circuits on the first rejection, and a closed scope remains terminal.
  The formerly exported scope-borrowing option remains accepted as deprecated
  and ignored so the fix does not create a TypeScript compatibility break.
- **QuickJS host-result cleanup is deterministic under timeout and load**
  (issue #84). Settled bridge results are bounded, consumed exactly once, and
  released when execution completes or its deadline wins, preventing late work
  from retaining unobservable values.
- **The documentation guard catches the legacy syntax it was meant to prevent**
  (issue #94). Bare `§N` citations now fail on live source, docs, examples, and
  README surfaces—including extensionless files—while historical changelog
  entries remain explicitly exempt. Negative fixtures cover every structural
  invariant.

## 0.7.1 — 2026-07-27

0.7.1 is a security-and-bounds patch. It closes both redirect paths that could
let untrusted URL text choose an origin, and it puts hard request and response
ceilings around discovery. There are no dependency changes and no breaking
TypeScript changes. There is one intentional runtime hardening to notice:
`remoteMcp` now rejects downstream redirects by default. A deployment whose MCP
endpoint legitimately redirects within the same origin can opt into the new
`redirects: "same-origin"` policy; cross-origin redirects and HTTPS downgrades
remain impossible.

### Added

- **`remoteMcp` has an explicit downstream redirect policy** (issue #81).
  `redirects` defaults to `"none"`; `"same-origin"` follows at most five
  manually validated hops with deliberate 301/302/303/307/308 method and body
  semantics. Static headers and OAuth credentials never reach a cross-origin
  target, and policy failures are typed, non-retryable, and sanitized.

### Changed

- **Discovery requests and generated results are bounded** (issue #82).
  `search_tools` accepts at most 100 results, `describe_tools` accepts at most
  100 raw addresses, and both reject generated results above 256,000 UTF-8
  bytes. Compact, JSON-schema, value, and code-mode paths share the same policy,
  so alternate entry points cannot bypass it.

### Fixed

- **Inbound HTTP-to-HTTPS upgrades preserve the configured public origin**
  (issue #89). Protocol-relative, backslash, and control-character path forms
  can no longer turn the upgrade response into an open redirect; ordinary
  operator and private API paths still retain their path and query.
- **Downstream MCP redirects are validated before every target request**
  (issue #81). Redirect loops, excessive chains, scheme downgrades, origin
  changes, and credential-bearing URL targets now fail closed in both Node and
  Workers.

## 0.7.0 — 2026-07-27

0.7.0 is the surface settlement: one release that finishes moving connecta's
public shape so that it can stop moving. It arrives from two directions at once.
A controlled qualification pass against 0.6.1 (issue #86) measured four ways a
deployment could be worn down — an unbounded cache, an enumerable callback, a
session leak, and a credential that reports itself usable and then isn't — and
those are fixed here. Meanwhile the config surface had accumulated eleven flat
tuning fields, the reference manual had reached 2,600 lines, and the operator UI
was one page pretending to be three. Those are settled here too, and settling
them breaks things, which is the argument for doing it in one release instead of
spreading it across three.

**What breaks.** Three things, and each is a compile error or a loud refusal
rather than a behavior change you have to notice on your own. Every flat 0.6.x
tuning option is removed in favour of four grouped ones. A connector that
implements `finishAuth` without `verifyState` can no longer complete OAuth. And
`/`, `/credentials`, and `/activity` are now core-owned routes, so a connector
`handleRequest` that served any of them is shadowed. The first is mechanical:
`createConnecta` throws once, before it reads anything else, naming every legacy
path it found and its replacement.

**What a deployment can ignore.** The defaults and runtime behavior of every
config option are unchanged — only the paths moved. `/ui` bookmarks keep working
through a permanent redirect, and all 17 documentation anchors still resolve
even though the manual is now nine files. If you configure connecta with a
literal object, do not paginate a downstream MCP server, and write your own
connectors against `remoteMcp`/`api` rather than hand-rolling `finishAuth`, the
whole migration is a mechanical rewrite of one config block.

### Breaking

- **`ConnectaConfig` tuning is grouped by subsystem for 0.7.0** (issue #28).
  The flat 0.6.x options are removed rather than deprecated: TypeScript rejects
  them, and JavaScript callers get one fail-fast error from `createConnecta`
  listing every legacy own property it finds and its replacement. Supplying
  both an old and a new path is still an error; there is no precedence rule or
  compatibility alias. Migrate configuration as follows:

  | 0.6.x | 0.7.0 |
  |---|---|
  | `activity` | `activity.store` |
  | `activityReadGate` | `activity.readGate` |
  | `activityDeploymentId` | `activity.deploymentId` |
  | `credentialEncryptionKey` | `credentials.encryptionKey` |
  | `credentialHealth` | `credentials.health` |
  | `toolCacheTtlSeconds` | `discovery.catalogTtlSeconds` |
  | `persistToolCatalog` | `discovery.persistCatalog` |
  | `toolCatalogStaleSeconds` | `discovery.staleCatalogSeconds` |
  | `probeTimeoutMs` | `discovery.probeTimeoutMs` |
  | `defaultToolTimeoutMs` | `calls.defaultTimeoutMs` |
  | `maxResultBytes` | `calls.maxResultBytes` |

  For example:

  ```ts
  // 0.6.x
  createConnecta({
    connectors,
    storage,
    activity,
    credentialEncryptionKey: env.CONNECTA_CREDENTIAL_KEY,
    toolCacheTtlSeconds: 300,
    defaultToolTimeoutMs: 30_000,
    maxResultBytes: 50_000,
  });

  // 0.7.0
  createConnecta({
    connectors,
    storage,
    activity: { store: activity },
    credentials: { encryptionKey: env.CONNECTA_CREDENTIAL_KEY },
    discovery: { catalogTtlSeconds: 300 },
    calls: { defaultTimeoutMs: 30_000, maxResultBytes: 50_000 },
  });
  ```

  The defaults and runtime behavior of each option are unchanged. Connector
  definitions keep their per-connector `maxResultBytes`, and structural seams
  such as `storage`, `auth`, `connectors`, `toolkits`, and `executor` remain at
  the top level.
- **A connector implementing `finishAuth` without `verifyState` can no longer
  complete OAuth** (issue #62). Such a connector previously exchanged the
  authorization code with no CSRF guard at all — connecta had no way to
  establish that it had started the flow being completed. The callback now
  refuses with the same opaque 400 as every other refusal, exchanges no code,
  and logs one operator-grade line naming the connector and the missing hook.
  `verifyState` stays optional in the type system and is required in practice
  wherever `finishAuth` is present. The shipped `remoteMcp` OAuth provider has
  always implemented it, so this reaches hand-written connectors only.
- **`/`, `/credentials`, and `/activity` are now core-owned routes** (issue
  #57). They previously fell through to connector `handleRequest` and then to a
  404, so a connector serving any of the three is now shadowed without warning.
  `GET /` returns the operator shell where 0.6.1 returned 404, and non-GET on
  those routes and on `/ui` returns 405 rather than falling through.

### Added

- **`Connector.closeScope?(ctx)`** (issue #66) — an optional, best-effort seam
  for releasing whatever a connector opened for one scope. Called at most once,
  inside a fixed 100 ms completion window: a hook that is absent, throws, or
  never settles cannot replace, corrupt, or delay the result of the operation
  that triggered it. `remoteMcp` implements it, tearing down cached and
  half-open sessions and fencing late connection races. Connectors that do not
  implement it are unaffected.

### Changed

- **The operator UI is now a direct-linkable three-page set** (issue #57):
  Connections at `/`, Credentials at `/credentials`, and Activity at
  `/activity`. `GET /ui` remains as a permanent `308` compatibility redirect to
  `/`. The pages use semantic navigation, path-specific titles, direct
  load/refresh/bookmark and Back/Forward behavior, and the same restrained
  responsive connector-ledger design. They are three routes over one
  no-build-step client implementation, not copied applications.
- **Every canonical operator route serves the same open, data-free shell.** The
  nonce CSP, framing denial, referrer policy, HSTS behavior, content-type
  protection, URL gates, and escaping guarantees formerly attached to `/ui`
  apply equally to `/`, `/credentials`, and `/activity`. Deployment data remains
  behind the unchanged private APIs: `/ui/data`, `/ui/activity`, and
  `/ui/credentials/<connectorId>[/test]`.
- **Vault controls moved out of connector cards and into Credentials.**
  Connections remains read-only status; Credentials preserves Add/Replace/Test/
  Remove, masked metadata, stored-shape recovery, and live feedback without ever
  returning a secret. Its explicit capability states cover eligible Clerk
  operators, bearer-only sessions, missing vaults, and deployments with no
  credential slots without broadening the existing Clerk/user-id/toolkit/
  same-origin mutation boundary. Activity likewise renders an explicit
  not-configured state when `activity.store.list` is absent. OAuth result pages
  now return to `/`.
- **The reference manual is nine documents instead of one** (issue #61).
  `docs/documentation.md` had reached 2,600 lines; it is now a compatibility
  index that preserves all 17 `#N-…` anchors, so every existing deep link from
  the README, the examples, and source comments still resolves. The prose moved
  to `architecture`, `meta-tools`, `connectors`, `auth`,
  `storage-and-credentials`, `operations`, `code-mode`, `operator-ui`, and
  `toolkits`. A new `npm run check:docs` validates local links, fragments,
  heading slugs, and the legacy-anchor manifest, and runs first in
  `npm run check`. Contributor-facing only: the published package is unchanged
  and docs still ship in no tarball.

### Fixed

- **`clerkAuth`'s identity-decision cache is bounded at 1,024 identities per
  instance** (issue #70). It never evicted: every distinct identity that reached
  the gate was retained for the lifetime of the isolate. `allowedDomains` made
  that attacker-reachable on an open-signup Clerk instance, since an
  authenticated-but-denied identity is still a cache entry — 100,000 denied
  identities measured at roughly 11.96 MiB retained, with the oldest entry still
  present. Eviction is LRU, so a small active set stays hot, and the only thing
  evicting an entry can cause is a fresh check against Clerk: it can never turn
  a denial into an admission, and it cannot extend an allow past its TTL, since
  a cache hit re-inserts the same record rather than restamping it. The bound is
  deliberately fixed rather than an operator knob, and the ~60 s allow / ~30 s
  deny windows are unchanged.
- **`/oauth/callback/<id>` no longer lets an unauthenticated caller enumerate
  configured connector ids** (issue #62). 0.6.1 answered `404 Unknown connector
  "<id>"` for an id it did not recognise and a distinct 400 for a state
  mismatch, which made the callback a free directory of every connector a
  deployment had configured. Unknown ids, non-OAuth connectors, missing or
  mismatched state, an absent verifier, and a throwing verifier now return one
  byte-identical 400 — same status, same body, same headers. They also cost the
  same single storage read, so the clock cannot sort the ids the body refuses to
  name. That is cost equalisation rather than constant time, and the
  documentation says so and enumerates what stays distinguishable. The precise
  diagnosis moved to the operator log, bounded and escaped.
- **Probe-opened downstream MCP sessions are closed instead of abandoned**
  (issue #66). Credential-health sweeps, `list_connectors({ probe: true })`, and
  `/ui/data` each opened downstream sessions and left them for the provider to
  age out — measured at 200 probes opening 200 sessions and explicitly closing
  zero, made continuous by the periodic sweep. Closing now ends the session
  rather than merely dropping the local client: `remoteMcp` issues the
  specification's `DELETE` carrying `Mcp-Session-Id` *before* the close that
  would otherwise abort it, feature-detected and best-effort, while a stateless
  downstream issues none. A downstream that refuses, errors, or never answers is
  closed anyway. One consequence worth knowing: a probing `list_connectors` now
  runs on its own scope rather than the request's — it has to, since a request
  scope cannot be closed — so a request that probes *and* then calls the same
  connector opens two downstream sessions where it opened one. Per-request
  `/mcp` scopes are unchanged.
- **A credential stored under an older declaration no longer reports itself
  usable and then fails** (issue #69). `/ui`, the credential Test route, and
  credential health each interpreted the stored shape slightly differently, so a
  credential could render as configured and testable and then answer 409 with a
  misleading configure-first message. One pure classifier now answers for all
  three, and it asks about *containment* rather than equality: a stored set is
  fine as long as it holds every field the declaration currently names. A
  missing declared field is drift — which covers every case issue #69 reported,
  including a rename and a swap between the single-value and named shapes in
  either direction — and drift is never auto-migrated. Credentials keeps Replace
  and Remove and hides Test, the test route answers 409 without calling a hook,
  and health records an explicit error rather than a fabricated verdict, checked
  before the freshness gate so a stale `ok` cannot mask a redeploy. Leftover
  keys are explicitly *not* drift: dropping a field from a declaration leaves
  its secret in the vault, but every accessor keeps returning the right value
  and every call keeps working, so calling that drift would tell an operator to
  re-enter a credential that works and that many providers will not reissue in
  readable form. Credentials prints one non-blocking line naming the leftovers
  instead. A repeated drift verdict is charged to the freshness budget rather
  than rewritten on every sweep in every isolate.
- **A paginated downstream MCP server no longer loses everything after its
  first `tools/list` page** (issue #77). `tools/list` is cursor-paginated in the
  MCP specification and the SDK's `Client.listTools()` returns one page,
  `nextCursor` included, without following it. `remoteMcp()` called it once, so
  a downstream that paged its catalog was split in half without complaint:
  page-one tools were counted, searchable, describable and callable, and every
  tool after them appeared not to exist — missing from `list_connectors` counts,
  `search_tools`, `describe_tools`, and address resolution alike, with nothing
  in any log saying a page had been left behind. That is the wrong failure for
  a product whose premise is progressive discovery over large tool catalogs,
  since large catalogs are exactly the ones that paginate. A catalog refresh now
  walks the whole cursor chain on the same request-scoped client before the
  result is indexed. Cursors are handed back byte-for-byte and never parsed,
  rewritten, or persisted; an empty-string `nextCursor` is treated as *present*
  (pagination ends on an absent one, and a truthiness check there would truncate
  the catalog silently). A downstream that advertises no `nextCursor` is
  unchanged in both directions: one request, sent with no `cursor` param, and
  byte-identical tool definitions. Tools are deduplicated by name, first page
  wins, so an unstable cursor that overlaps pages cannot inflate `toolCount`,
  double a `search_tools` row, or churn the registry into a persistence write
  per refresh. A `nextCursor: null` — a common JSON idiom for end-of-pagination
  that the MCP result schema does not accept — is now reported as a named
  nonconformance instead of a raw Zod dump. Any page that fails fails the whole
  refresh rather than publishing a prefix, so the registry keeps serving the
  last complete catalog through its existing stale fallback.

  The walk is bounded on **tools**, not pages. A page ceiling is the wrong
  dimension — the server picks the page size, so N pages is N × a number
  connecta cannot observe, and the common conformant idiom of "advertise a
  cursor whenever the page came back full, then serve one empty page to
  terminate" means a well-behaved 10,000-tool server paging at 100 spends 101
  requests. So a refresh now fails immediately on a cursor handed back twice,
  fails on two consecutive pages that add nothing while still promising more
  (one is legal — that empty terminator), caps what it accumulates at
  `MAX_TOOLS` (100,000, the top of the catalog envelope issue #82 benchmarks),
  and keeps `MAX_TOOL_PAGES` (raised to 10,000) only as an unreachable runaway
  backstop. These bounds make an unterminating walk finite and report it as a
  connector error; they do not cancel one that a probe deadline has already
  abandoned, because `withTimeout` bounds the caller's wait rather than the
  work.

- **Downstream output-schema validation now covers every page of a paginated
  catalog, not just the last one** (issue #77). The MCP SDK's
  `Client.listTools()` rebuilds its output-schema validators and task-support
  sets from each page it receives, clearing them first — so walking the cursor
  chain left the request-scoped client validating the final page alone. A
  `call_tool` against any earlier-page tool then found no validator and
  silently skipped both the "declared an `outputSchema` but returned no
  `structuredContent`" check and the structured-content validation, and lost
  the required-task guard with them. Enforcement depended on which page a tool
  happened to land on. A completed walk now re-primes that cache once from the
  full aggregated catalog; a test asserts the pinned SDK still provides the
  method it reaches for, so a future bump fails CI rather than quietly
  restoring the gap.

## 0.6.1 — 2026-07-26

A patch release: three bug fixes and a documentation overhaul. No new
configuration, no new exported types, no change to the published API surface —
`ConnectaConfig` and every type are byte-identical to 0.6.0. Nothing here is
breaking. But two of the fixes *withdraw* behavior a deployment could have been
relying on by accident, and in both cases withdrawing it is what the fix is, not
a decision taken alongside it:

- **A `uiAuth.signInUrl` or `signUpUrl` that is not an absolute `https:` URL is
  now dropped** rather than handed to `Clerk.load` (issue #56). Relative paths,
  `http:`, protocol-relative, `javascript:` and `data:` values all fall together,
  under the same gate `frontendApiUrl` has always passed. A rejected value reaches no part of the rendered page: the key is
  simply absent from `/ui`'s inline `AUTH` object, so Clerk falls back to its own
  default exactly as it does for an unset field, and `/ui` still renders and
  still signs operators in. Construction logs one warning naming each dropped
  field. What belongs in these fields is a hosted Account Portal address
  (`https://accounts.<domain>`, `https://<slug>.accounts.dev`), so a deployment
  that noticed this at all was pointing operators at a sign-in page connecta does
  not host.
- **The declared credential shape now picks the credential test hook, on every
  surface** (issue #55). Two of the four shape/hook combinations change behavior.
  A **single-value `credential` declaring both hooks** now runs
  `testCredential(value)` with the raw string, where the test route previously
  preferred `testCredentials` and handed it the vault's reserved `{ value }` map
  — the single-value hook now receives the string it was written to expect
  instead of a one-entry map named after a storage detail. A **single-value
  `credential` declaring only `testCredentials`** is no longer tested or probed
  at all: /ui renders no Test button, a direct POST answers 400 naming the
  mismatch, `createConnecta` warns at construction, and the liveness sweep added
  in 0.6.0 reports it `not_checkable` instead of calling a hook with a shape its
  connector never declared. Both of those are the fallback order that *was* the
  bug, so there is no version of this fix that preserves them. Named `fields`
  with `testCredentials`, or with both hooks, behave exactly as they did.

One textual delta reaches every deployment and no configuration turns it off, so
anything snapshotting agent-facing error text will diff: `resolveSkill`'s two
`Available:` branches now say `Available skills:` like the other three (issue
#50).

The docs are substantially reorganized, and one of the changes ships to npm:
readers of the package page get a completely different README. See Changed. The
next intentional breaking release stays reserved for issue #28.

### Changed

- **The README is rewritten around the problem connecta solves** (345 lines to
  196). It had become a condensed reference manual — roughly 60% code blocks and
  option tables, every one of them duplicated in `docs/documentation.md` or
  `examples/` — with a single paragraph explaining why connecta exists. npm
  readers see only this file, so it was the worst place for the duplication and
  the best place for the argument. It now runs as prose: the context-window and
  per-client configuration costs of connecting an agent to N MCP servers, what
  connecta does about them, why it is shaped the way it is (config as code, a
  server-side credential vault with liveness checks, fail-closed read-only,
  toolkits and who is admitted to them, payload-free activity, a read-only
  operator dashboard), when *not* to use it, one minimal Node quickstart, and
  links out. Removed from it and unchanged in `docs/` and `examples/`: the
  nine-row signature-level meta-tool table (the nine names now appear in prose
  with their purposes), the Worker quickstart, and the toolkits, code-mode,
  credentials, activity and branding blocks with their option semantics.
  **Links out of the README are now absolute GitHub URLs**, because `docs/` does
  not ship in the package and relative links are dead on npmjs.com. This is the
  only change in the release that reaches npm as content rather than code.
- **`docs/design.md` is retired into a new `docs/decisions.md`.** design.md was
  mostly a worse copy of documentation.md, and it had gone stale in at least one
  load-bearing way: it claimed the Clerk adapter passes `authorizedParties:
  [connectaOrigin]` to `authenticateRequest`. It does not, and must not — OAuth
  access tokens may be JWTs with no `azp` claim, and Clerk rejects `azp ===
  undefined` when that option is set, so passing it would reject every MCP
  client; the `azp` pin is applied by hand after verification, for session tokens
  only. decisions.md records that as a **rejected alternative** rather than
  repeating the wrong version. It answers two questions documentation.md does
  not: "may I build X?" (non-goals, rejected alternatives) and "must my change
  preserve Y?" (invariants) — collecting the invariants documentation.md states
  but never gathers as pointers rather than duplicated prose, alongside the four
  that lived only in design.md: no runtime admin, nothing request-bound surviving
  a request, single tenant, and fail-closed read-only. Two facts moved into
  documentation.md §13 instead, next to the code they explain. Inbound references
  in the README, documentation.md and the Docker example follow; **any external
  link to `docs/design.md` is now dead**, and the 0.x CHANGELOG mentions of it
  stay as historical record. The credential-test invariant added by issue #55
  also gained the qualifier §17 already carried: a connector whose shape and hook
  mismatch carries no verdict *from a credential hook*, but is still probed
  through `status()` if it declares one, since that question never involves the
  shape.
- **CLAUDE.md is an agent brief rather than a policy stub.** It now states what
  gates "done" (`npm run check`, and what that runs), the two-document map
  (documentation.md as reference manual, decisions.md as non-goals and
  invariants) with the warning that its section numbers are linked from source
  comments, the two CI-enforced boundaries that are invisible from inside a
  single file (import-graph purity, the published surface) as where-new-code-goes
  guidance, the `WORKERS_SUITES` allowlist trap that silently skips a portable
  suite left out of it, and the commit, CHANGELOG and release conventions. The
  roadmap-lives-in-GitHub-issues policy is unchanged, verbatim.

### Fixed

- **One rule decides how a credential is tested, and three copies of it no
  longer disagree** (issue #55). `/ui` offered a Test button from the mere
  presence of a hook (`testCredential || testCredentials`); the test route made
  its own different choice — prefer `testCredentials`, else `testCredential` on
  the vault's reserved `value` field; and 0.6.0's credential-health prober added
  a third copy of that same preference order. They disagreed in both mismatch
  shapes, and the visible bug was the ugliest one: a connector declaring named
  `credential.fields` with only `testCredential` answered **409 "configure the
  credential before testing it" on a fully configured credential**, blaming the
  operator for connecta's own hook selection. `credentialTestRule` in
  `src/credentials.ts` is now the single source of truth — `buildUiData`'s
  `testable` flag, the test route's hook selection, the credential-health
  prober's `testHookFor`/`isCheckableConnector`, and a new construction-time
  warning all read it, so they cannot drift apart again. **The declared shape
  picks the hook and the other one is never substituted**: named fields are
  tested by `testCredentials` with the whole set, a single value by
  `testCredential` with the raw string. A connector implementing only the
  mismatched hook is not testable rather than testable-by-accident — no button, a
  400 sharing its wording with the boot warning, and `not_checkable` to the
  prober, which carries no verdict rather than an invented one (handing
  `testCredential` a `value` that named fields never wrote would test the empty
  string and record a confident `auth_required` about a credential nothing
  examined). `status()` is unaffected: a mismatched connector that implements it
  is still probed through it. The two behavior deltas this produces are stated
  above. Recorded as an invariant in `docs/decisions.md`, and stated in
  documentation.md §4, §7, §14 and §17.
- **`uiAuth.signInUrl` and `signUpUrl` are gated like every other URL that
  reaches the browser** (issue #56). They were the residual — operator config
  that arrives in the page as a *navigation target* rather than an attribute, so
  no gate covered them and §14's URL-position invariant had to be read with an
  exception beside it. Both are serialized into `/ui`'s inline `AUTH` object and
  handed to `Clerk.load`, which navigates to them when an operator signs in. They
  now pass the same gate `frontendApiUrl` does, so `isSafeScriptSrcUrl` — named
  for the one position it used to guard — becomes `isSafeHttpsUrl`, one predicate
  for all three `uiAuth` URLs. Absolute `https:` only, for the typed fields as
  for the derived one: the loose carve-outs buy nothing real, since `http:` would
  carry a sign-in over cleartext and a path relative to this origin is
  meaningless because connecta hosts no sign-in page of its own. The drop warning
  decides "did the operator mean to supply this?" through the same `isSetUrlValue`
  helper `branding` uses, so a blank-string or falsy non-string value cannot warn
  on one path and stay silent on the other. **§14 now states the invariant over
  every URL position — attribute and navigation target — with no carve-out left.**
- **`resolveSkill` enumerates its list under one label** (issue #50). Three
  branches said `Available skills:` and two said `Available:`, so which one an
  agent saw depended on the branch it hit rather than on any difference in
  meaning. Agent-facing error text is interface, and two labels read as two
  concepts where there is one. Both stragglers now say `Available skills:`, and a
  test walks all five error branches so reverting any one of them fails.

## 0.6.0 — 2026-07-26

A feature release that makes two of 0.5.0's mechanisms protective rather than
merely organizational. Toolkits gain an identity binding, so a credential opens
the view its team was given and nothing else; connector status gains a proactive
credential liveness layer, so an expired downstream token shows up as
`auth_required` before an agent's call trips over it; and `clerkAuth` gains an
email-domain allowlist. Eight fixes on the result path and the diagnostic
surfaces sit underneath them. Nothing here is breaking — every new config key is
optional and every new type is additive — but this release is *not* runtime-inert
for a deployment that declares none of them, and the deltas are worth reading
before upgrading:

- **MCP-mode truncation now measures what it truncates.** A `kind: "mcp"`
  connector's result whose size falls between the old text-only measure and the
  serialized envelope came back inline in 0.5.0 and now truncates, pages, and
  reports `totalBytes` in envelope bytes (issue #43, below). It is deliberate,
  and it is the one change on the result path that a deployment can notice
  without changing any configuration.
- **A handler returning `undefined` renders as the text `undefined`** under
  `resultMode: "mcp"`, where 0.5.0 emitted a `TextContent` block with no `text`
  at all (issue #42). Every serializable return is byte-identical.
- **The cheap status path reports more failures.** `list_connectors({ probe:
  false })` now reads `error` for a connector whose *catalog* load keeps failing
  (issue #46) and `auth_required` when a background liveness check found the
  stored credential dead (issue #24). Both are the fix; both mean a connector
  that read clean in 0.5.0 while being broken now reads broken.
- **Credential liveness checks are on by default.** A deployment holding an
  operator-managed `credential` or a downstream OAuth grant begins making
  liveness calls — its own `testCredential(s)` hook, or the OAuth
  `status(ctx)` refresh — piggybacked on authenticated `/mcp` and `/ui/data`
  traffic, at most one per connector per 15 minutes. No downstream *tool* is
  ever called and no catalog is fetched. Setting `credentialHealth.onRequest`
  to `false` turns that trigger off; the explicit `checkCredentials()` call
  stays available.
- **Three textual deltas that no configuration turns off**, so anything
  snapshotting them will diff: `get_result`'s tool description now documents the
  `offset` domain and the codepoint realignment, reaching every deployment (its
  JSON Schema is unchanged, `minimum: 0` either way); both favicon routes now
  carry `X-Content-Type-Options` and a `Content-Security-Policy` header, with
  the bodies byte-identical; and any deployment declaring toolkits gets a
  rewritten startup warning, now split into three.

The next intentional breaking release stays reserved for issue #28.

### Added

- **Toolkit ↔ identity binding — a credential opens the view its team was
  given** (issue #37). Toolkits shipped in 0.5.0 with self-service selection:
  any authenticated caller could name any toolkit, or omit `?toolkit=` and get
  the whole registry. The binding closes that. It is declared **on the auth
  adapter**, not in a deployment-level table keyed by identity id —
  `bearerToken(secret, { subjectId: "support-team", toolkits: ["support"] })`,
  and the same two options on `clerkAuth` — because a typo in such a key means
  *unbound*, which fails open and hands over everything, while a typo in a
  toolkit *name* throws at construction. `InboundAuth.toolkitBinding` is the
  provider-wide declaration and `AuthResult.toolkitBinding` overrides it per
  identity, the documented seam for an adapter mapping its own users to views;
  the declaration is a **ceiling**, not a default — connecta intersects the two
  and grants `unscoped` only if both do, so an adapter reading a user-writable
  IdP claim cannot let a user widen their own binding. Enforcement is one point
  (`resolveToolkitScope`, after the auth gate and before any `ScopedRegistry`
  exists) deciding *whether* a scope is built; what a built scope contains stays
  entirely in `ScopedRegistry`. For a bound identity, a toolkit outside the
  binding, an undeclared or malformed name, and — without `unscoped: true` — a
  connection with no `?toolkit=` are all **403, byte-identical in status and
  body**, and the body names no toolkit: a team credential must not become a
  directory of the org's other teams. The operator log is where the three
  reasons are told apart, naming the identity, the reason and the binding, with
  the same 64-character bounding and U+2028/U+2029 escaping the toolkit
  rejection uses. A bound-but-not-`unscoped` identity is also refused the
  deployment-wide operator surfaces — `/ui/data`, `/ui/activity`, and the
  credential API — because those payloads describe every connector in the org
  and a credential write reaches every view; `/health` and the open routes are
  unchanged. **An unbound identity behaves exactly as 0.5.0 shipped**, and
  bindings are per identity, so a legacy token beside two bound ones keeps
  working. Bindings are validated in three places that each catch what the
  others cannot: the adapter throws on a declaration that does not mean what it
  says (`unscoped` with no `toolkits`, an empty `toolkits` without it, a name
  outside the grammar, a non-array); `createConnecta` cross-checks every name
  against the declared toolkits and throws on an unknown one; and **every
  request re-validates the binding it is about to enforce**, because
  `InboundAuth` is an open interface and neither half can be trusted from the
  type — a binding that fails validation is a 403 with a log line, never a
  silent drop, since dropping it would read as "unbound". `ToolkitBinding`,
  `ToolkitBindingOptions` and `BearerTokenOptions` are exported. The startup
  warning story changes with it (see Fixed).
- **Proactive credential liveness checks, so a dead credential surfaces before
  a call fails** (issue #24). A connector's auth status previously flipped only
  when something *observed* a failure — an agent's real call erroring
  `auth_required`, or an operator running `list_connectors({ probe: true })` —
  so a revoked token surfaced mid-task. Connecta now checks the credentials it
  stores and serves the verdict from the cheap surfaces. Only two credential
  shapes are eligible, each asked through the hook that exists to answer exactly
  this question: an operator-managed `credential` via `testCredentials(values)`
  / `testCredential(value)` (the same call /ui's Test button makes), and a
  downstream OAuth grant via `status(ctx)`, whose refresh *is* the liveness
  question for a token. **A check never calls a downstream tool and never
  fetches a catalog**, so it cannot mutate downstream state and no destructive
  tool is reachable from it, and **a connector with nothing stored is never
  probed** — a new optional `Connector.hasStoredCredential` answers for
  connectors holding their own credential (`remoteMcp` implements it for
  oauth) and the vault answers for the rest, so a timer never starts DCR and
  consent for a connector nobody has authorized. The core starts **no timers**,
  because it has to run unchanged on Workers: instead there are two triggers
  sharing one budget — an authenticated `/mcp` or `/ui/data` request hands a
  *due* sweep to `ctx.waitUntil` (never awaited by the request, never triggered
  by an unauthenticated or refused one), and the new
  `Connecta.checkCredentials({ baseUrl?, force?, ids? })` is an ordinary awaited
  call for the host's own scheduler — wired to a cron trigger in the Worker
  example and a `setInterval(...).unref()` in the Node and Docker ones —
  returning one `CredentialCheckResult` per connector considered, and never
  rejecting on a connector failure.
  Cost is bounded four ways: eligibility, a persisted freshness window
  (`intervalSeconds`, default 900, shared across isolates so repeated status
  reads never each produce a check), one traffic-triggered sweep per interval
  per isolate, and a per-check deadline (`timeoutMs`, default 30 000) with at
  most `concurrency` (default 4) in flight. Verdicts are persisted under
  `credhealth:<connectorId>` rather than held in memory, because on Workers the
  cron isolate is not the isolate answering status reads. `list_connectors`
  gains `credentialCheck: { state, checkedAt, message?, authorizationUrl? }`,
  present only for connectors holding a stored credential, and /ui's connector
  card renders it. What a verdict may *decide* is deliberately narrow and lives
  in one function: only `auth_required` ever sets the `probe: false` status, and
  only while nothing better has happened since — a real call that succeeded
  after `checkedAt` retires it, read deployment-wide so a sibling toolkit's
  success counts. An `error` verdict is **reported and decides nothing**: a
  check that timed out or got a 502 failed to *complete* and learned nothing
  about the credential, so letting it set the status would flip a working
  connector to `error` for a whole interval on a DNS blip. An `ok` verdict
  upgrades `unknown` to `ok` and never downgrades an observed failure, while
  `auth_required` outranks even a newer real-call failure — both say something
  is wrong, only one carries the URL that fixes it, and the failure stays
  visible as `lastError`. Recovery needs no restart and is fenced against a
  check in flight: a completed `/oauth/callback/<id>` and a credential `PUT` or
  `DELETE` drop the verdict and advance a per-connector generation counter
  (`credhealth:gen:<id>`) that a check captures at its start and re-reads before
  writing, so a check that began before consent finished cannot resurrect the
  stale `auth_required` and its stale consent URL. `credentialHealth` on
  `ConnectaConfig` tunes all of it; `CredentialHealthConfig`,
  `CredentialCheckResult`, `CredentialCheckSkip`, `CredentialCheckState` and
  `CredentialHealthRecord` are exported. Automatic re-authorization is out of
  scope — refresh rotation is already the OAuth flow's job and interactive
  re-consent stays manual through `authorize_connector`. **Known gap, filed not
  fixed:** a probe leaves a downstream MCP session open, because
  `remoteMcp().status()` connects a client that nothing closes. That has been
  true of `list_connectors({ probe: true })` and `/ui/data` since long before
  this release; the sweep makes it periodic rather than operator-triggered.
  Closing it needs a teardown seam on the `Connector` contract, so it is issue
  #66 and is named in the docs beside the feature.
- **`clerkAuth({ allowedDomains })` — "anyone @acme.com, nobody else" as one
  option** (issue #58). The policy was expressible with `gate` already, but only
  by hand-writing fetch-user / read-primary-email / compare-domain /
  handle-the-lookup-failing in every deployment, a security-relevant idiom with
  four ways to get subtly wrong. Matching is exact, case-insensitive and on the
  whole domain: `acme.com` admits `dev@ACME.com` and rejects `evil-acme.com`,
  `acme.com.evil.com`, `acme.co` and `mail.acme.com` — a subdomain must be
  spelled out — and the address is split on its **last** `@`, so
  `"dev@acme.com"@evil.com` resolves to `evil.com`. It **fails closed** on every
  uncertainty (no primary email, an unverified one, a malformed address, a Clerk
  lookup that throws), returning the same bare `403 {"error":"forbidden"}` a
  `gate` rejection returns with no hint why, while the operator gets the reason
  in the log with the domain bounded and escaped and never the local part of
  anyone's address. The list is validated at construction — a non-domain, an
  `@`, an empty list, a non-array, or a Unicode lookalike (internationalized
  domains must be written in punycode) throws where the operator wrote it rather
  than silently binding nothing. It composes with `gate`: each configured one
  must pass, the allowlist is evaluated first so a caller outside the org never
  reaches operator gate code, and one verdict per user covers both and rides the
  existing identity cache, so it costs no more Clerk calls than `gate` alone. It
  governs Clerk sign-in only — a co-configured `bearerToken` has no email to
  read. Unset, no user lookup happens at all and any authenticated user is
  admitted, exactly as before. Where this sits relative to the toolkit binding
  is now documented explicitly: `allowedDomains`/`gate` decide **who gets into
  the org**, the binding decides **what they see** once in. **Residual:** the
  identity cache is a `Map` that never evicts, and an allowlist beside open
  Clerk sign-up is the first configuration in which a stranger can populate it —
  each denied user id costs a permanent entry for the life of the isolate. The
  denial itself is correct and TTL'd; the footprint is issue #70.

### Fixed

- **MCP-mode truncation measured text blocks but truncated the envelope, and
  never fired on non-text content at all** (issue #43). The quantity that
  *decided* truncation was the text blocks' byte length; what was truncated,
  stashed and reported as `totalBytes` was `JSON.stringify(content, null, 2)`,
  the strictly larger envelope. So the head and `totalBytes` described a string
  the cap was never compared against (pinned by a test where 240 bytes of text
  sit in a 700-plus-byte envelope under a 300-byte cap — it came back inline
  before and truncates now), and an all-non-text result scored zero text bytes,
  so a single 50 KB base64 `image` block was returned inline, unbounded, with no
  `resultId` to page from. One `guardContent` now measures the same string it
  stashes and counts every block. What truncation *means* differs by content: an
  all-text envelope keeps the historical head plus notice, since a JSON prefix
  is still readable, while an envelope carrying any non-text block is replaced
  by the `{ truncated, resultId, totalBytes, hint }` notice **alone**, because
  the head of a half-written base64 image is useless and leaves unparseable
  block structure. Either way the full envelope is stashed and pages back whole
  through `get_result`, and the ~170-byte notice sits outside the cap as it
  always has on the truncated-head path. Under the cap, blocks pass through
  untouched and in order — including a result whose measurement itself is
  impossible: a `BigInt` or a cycle makes the envelope stringify throw, which is
  caught and falls back to returning the content untouched rather than failing a
  call that used to pass. **The one thing an existing `kind: "mcp"` deployment
  will notice** is stated above: results between the two measures now truncate.
- **A handler returning `undefined` emitted a `TextContent` block with no
  `text`** (issue #42). `JSON.stringify(undefined, null, 2)` *is* `undefined`,
  not a string; `guardText` then measured `enc.encode(undefined)` — the empty
  string, per the WebIDL default — took the under-cap early return, and emitted
  the non-string unchanged, so clients received `{"content":[{"type":"text"}]}`,
  which `TextContent` does not permit. The three guards that answer this same
  question each defended differently, so they now share one
  `serializeResultText`: JSON text for whatever JSON can represent, `String(
  value)` for what JSON renders as `undefined`, and `guardText` normalizes at
  the door so its size logic is unreachable with a non-string. A value JSON
  cannot serialize at all still throws and is reported as a failure. The
  semantics are now written down where `resultMode` is documented, including the
  sharp edge that only a bare `undefined` renders as `undefined` — a function
  renders as its **source text** and a Symbol as `Symbol(label)`, so a handler
  mistakenly returning a closure puts the function's source in front of the
  model.
- **`get_result`'s `offset` had none of the defense issue #32 gave `maxBytes`**
  (issue #38). An in-handler `offset: NaN` propagated through `Math.max(0,
  Math.trunc(...))`, sliced to nothing, and serialized as `"offset": null` with
  empty text and no `nextOffset` — the result vanished silently instead of
  erroring. Validity is now one shared rule spelled once for the wire schema and
  once in the handler, exactly as #32 did for the cap, and an out-of-domain
  value is an ordinary input-validation error; an offset past the end of the
  payload stays legal and answers with an empty final page. Separately, a legal
  in-range offset landing mid-codepoint emitted U+FFFD; it is now aligned
  **back** to that character's first byte — re-reading a few bytes is
  recoverable, silently skipping the rest of a character is not — and the offset
  actually served is what the response reports. Server-produced `nextOffset`
  values are already boundaries and are served exactly as given, so paging is
  byte-identical.
- **A failing catalog lookup never recorded a connector health failure** (issue
  #46). `call_tool`'s catalog-lookup catch returned a failure to the caller but,
  unlike the execution catch a hundred lines below, never called
  `recordFailure`, and neither `getTools` nor `refreshTools` compensated. A
  connector whose `listTools` fails persistently — a revoked downstream grant,
  the scenario the comment at that catch already named — therefore accumulated
  no `consecutiveFailures` and read **clean** from `list_connectors({ probe:
  false })` while every single call against it failed, which is precisely the
  cheap signal an operator or agent consults to find a broken connector. Both
  catalog-load sites now record: the shared `runCall` catch behind `call_tool`,
  `call_destructive_tool` and `batch_call`, and the `execute_code` path's
  provider build, which previously dropped a connector's whole sandbox namespace
  with nothing but a `logger.warn`. The accounting deliberately stays at the
  call sites rather than inside `Registry`: `registry` there is the connection's
  *view*, so a toolkit-scoped session records into its own health log as well as
  the deployment-wide one, and registry-level accounting would leave scoped
  sessions blind while double-counting against the probe path that already
  records. A warm-cache hit still records nothing in either direction — a hit is
  not evidence of health.
- **The toolkits startup warning fired for a configuration that cannot have the
  risk it named** (issue #45), and now tells three different stories. The check
  tested `config.toolkits` for truthiness; `{}` is truthy but resolves to no
  selectable toolkit at all, so a deployment configured that way was told that
  "any caller can choose any toolkit" — the kind of warning that teaches
  operators to skim past the ones that matter. All warnings are now keyed off
  the **resolved** toolkit map, the same one `?toolkit=` resolves against, so
  they cannot drift from what is actually selectable. With the binding feature
  the single warning splits into three, because the fix differs in each: toolkits
  with no `auth` at all (no identity exists to bind — configure `auth` first);
  toolkits with `auth` but no declared binding anywhere (the shape that
  organizes without protecting); and the dangerous middle, toolkits with *some*
  providers bound, which names the unbound ones — the shape where an operator
  believes the deployment is separated while one forgotten credential opens every
  view
  and every deployment-wide surface. Declaring `toolkits: [...], unscoped: true`
  is how an operator credential says so and stops appearing. The open-mode "no
  inbound authentication" warning remains independent of the `toolkits` value.
- **An unknown `?toolkit=` was undiagnosable from both ends** (issue #47). The
  404 is correct and its body is well worded, but mainstream MCP clients treat a
  404 on the transport endpoint as a transport failure and discard the body, and
  nothing was logged — so a one-character typo in a hand-copied MCP URL gave the
  user "failed to connect" and the operator nothing at all. A rejected selection
  now emits an operator `logger.warn` naming the rejected value and the
  configured toolkits, while the **response is byte-for-byte unchanged**: still
  no enumeration, still the same bounded echo. The new channel is bounded and
  unforgeable — the value is truncated to the same 64 characters the body echoes
  at and escaped with `JSON.stringify` plus a hand-rolled escape for U+2028 and
  U+2029, which `JSON.stringify` leaves raw — and the line is written **after**
  the auth gate, so on a deployment with `auth` configured a caller the gate
  rejects cannot make it log anything.
- **The dead `maxResultBytes` parameter on the meta-tool constructors is gone**
  (issue #44). Removed rather than exposed: `ConnectaConfig.maxResultBytes` and
  the per-connector override are already the documented answer to where a
  deployment sets the cap, a third global knob would need a precedence rule
  nobody asked for, and `ServerOptions` never carried the field, so nothing
  production could reach it — the constructors are internal factoring and are
  not part of the exported API. Cap tests now configure the deployment cap the
  way `createConnecta` does, so they also pick up its normalization, plus a new
  end-to-end test that a `createConnecta({ maxResultBytes })` value truncates
  and pages over the wire. The effective cap for a deployment that sets nothing
  is unchanged.
- **The documented `ApiOptions` and `RemoteMcpOptions` now match the source
  field for field** (issue #41). Both were presented as verbatim `export
  interface` listings while silently dropping real fields, which is worse than
  no listing: `ApiOptions` lacked `credential`, `testCredential`,
  `testCredentials` and `strictValidation` — putting the docs in direct
  contradiction with the README quick start, which uses `credential` — and
  `RemoteMcpOptions` lacked `requireHttps` and `logger`. Two of the omissions
  are security controls, so `strictValidation` and `requireHttps` now carry
  behavior, default and threat model verified against the implementation. Same
  sweep: the credential field sub-shape had dropped `description`/`placeholder`,
  the `validateToolInput` example omitted `failClosed`, and the `clerkAuth`
  bullet claimed `authorizedParties: [connectaOrigin]` is passed to
  `authenticateRequest` when the source deliberately does not — an OAuth access
  token may carry no `azp` — and pins `azp` by hand for session tokens instead.
  The remaining listings were checked against source and were accurate as
  written. **Residual, filed not fixed:** the review that produced this pass
  also found that `/ui` offers its credential Test button from the mere presence
  of a test hook, without checking it matches the credential *shape* configured,
  so a fully configured named-fields credential can answer "configure the
  credential before testing it" (issue #55).

### Security

- **Favicon bodies are served inertly, completing the URL-position invariant**
  (issue #31). `/favicon.svg` returned an operator-supplied SVG verbatim as
  `image/svg+xml` with no `X-Content-Type-Options` and no CSP, so a `<script>`
  inside a branding SVG executed **on the deployment origin** the moment anyone
  navigated straight to the URL — strictly more powerful than the
  `favicon.href` vector 0.5.0 closed, because the payload is same-origin. Both
  favicon routes now answer with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`. Neutralizing the *response* rather than inspecting the body is what
  keeps every valid static SVG byte-identical, the built-in mark included, and
  inline styles stay allowed because the default mark uses one to follow the OS
  colour scheme while CSS cannot script. `.ico` bodies are inert bytes and are
  still served verbatim, but deliberately in scope of the same headers, so the
  rule reads "every favicon route is neutralized" rather than "whichever route
  happened to get attention".
- **`uiAuth.frontendApiUrl` is scheme-gated.** It was the last operator-config
  value reaching a URL-valued HTML position — the `<script src>` of `/ui`'s
  sign-in loader — without one. It now requires an absolute `https:` URL,
  deliberately stricter than the branding gates with no `http:` and no loopback
  carve-out, because nobody types this value: `clerkAuth` derives it from the
  publishable key and Clerk's Frontend API is always https. A rejected value
  reaches neither position on the page — the loader tag is not emitted, and the
  serialized `AUTH` object is enumerated field by field so the bad URL cannot
  slip in through the inline script. `/ui` still renders, reports that Clerk
  could not load, and `createConnecta` logs a warning naming the provider, the
  same fallback-and-warn posture the branding drops established. **Residual:**
  `uiAuth.signInUrl` and `signUpUrl` are operator config that reaches the
  browser as a *navigation target* rather than as a rendered attribute, so the
  invariant as written does not cover them and neither does any gate; the
  exposure is narrow (`/ui`'s nonce CSP blocks a `javascript:` navigation on a
  CSP3 browser, the `'unsafe-inline'` legacy fallback would not) but the
  exception is the cost. Issue #56.
- **`/oauth/callback/<id>` still distinguishes a real connector id from an
  invented one** to an unauthenticated caller — 404 for unknown, 400 for a real
  connector with a bad `state`. Nothing is authorized and `verifyState` still
  holds, but the connector inventory leaks, which softens the same "not a
  directory" property the toolkit binding above is built to provide.
  Pre-existing, found while reviewing that binding, filed as issue #62.

## 0.5.0 — 2026-07-26

A feature release. Toolkits, per-connector usage guides, and per-connector
result caps are the substance; a paging fix, a docs coherence pass, and a
cleared audit advisory round it out. Nothing here is breaking, and a deployment
that declares none of the new options keeps its 0.4.1 *runtime* behavior on
every path that matters: an unscoped connection still sees the whole registry,
a zero-guide catalog gains no discovery text, and an unset cap truncates where
it always did. One narrow exception — a request carrying `?toolkit=` against a
deployment that configures no toolkits is now a 404, where 0.4.1 never read the
parameter and served the request; no 0.4.1 client had reason to send it. Three
textual changes are unconditional and reach every deployment, so anything that
snapshots them will diff: the `get_result` tool description now documents the
accepted `maxBytes` range, its `maxBytes` JSON Schema tightens from
`exclusiveMinimum: 0` to `minimum: 1`, and the matching validation error
message is reworded. The next intentional breaking release stays reserved for
issue #28.

### Added

- **Toolkits — named scoped views over one deployment's registry.** A connecta
  deployment belongs to an org; a toolkit is the slice one team group sees.
  Operators declare them in the new `ConnectaConfig.toolkits` (`{ support: {
  connectors: [...], includeTools?, excludeTools? } }`, with per-tool address
  grain; `ToolkitConfig` and `ToolkitDefinition` are exported), and a client
  selects one with `?toolkit=<name>` on the MCP URL. The boundary is a single
  enforcement point: a `ScopedRegistry` built once per HTTP request — the
  transport is stateless, so there is no longer-lived connection to hang it on
  — with every meta-tool and the `execute_code` sandbox bridge typed against a
  narrow `RegistryView` rather than the full `Registry`, so reaching for an
  unfiltered method is a compile error instead of a silent leak. All nine
  meta-tools are scoped; an out-of-scope address fails byte-identically to a
  nonexistent one; `get_result` stashes are namespaced per toolkit so a scoped
  session cannot page out a sibling's results; and health observations are
  per-toolkit so one scope's `lastError` never names another's tools. A
  monotonic has-ever-succeeded flag is the one deployment-wide *observation* a
  scoped view can read back, so scoped sessions don't misreport live remote
  connectors as `unknown`. Plenty of other state is shared by design and is not
  scoped at all — the tool-catalog cache, and, worth saying out loud, the
  `conn:<id>:` storage namespace and the credential vault: **a downstream OAuth
  token obtained under one toolkit is usable from another.** `/ui`, `/health`,
  and the OAuth pages stay unscoped operator surfaces. **Selection is
  self-service: any caller who can reach the endpoint may name any toolkit, or
  omit the parameter and see the whole registry.** A toolkit scopes visibility,
  not identity — binding a team member to a toolkit belongs in `auth`, and
  enforcing that binding is a deliberate follow-up (issue #37). Until it lands,
  treat toolkits as an ergonomics and context-budget feature rather than access
  control; connecta warns at startup when toolkits are configured without
  inbound `auth`. `InboundAuth.authorize` already receives the full request, so
  an adapter can refuse a mismatched `?toolkit=` today.
- **Per-connector usage guides, served by the existing `skills` meta-tool.** A
  connector declaration can carry `usageGuide` — agent-facing markdown,
  config-as-code, and a new pass-through option on both `ApiOptions` and
  `RemoteMcpOptions`. `skills({})` then lists the built-in `usage` guide
  alongside one summarized entry per guided connector, with `skills({ name:
  "connector:<id>" })` returning the guide verbatim. Collision with a built-in
  skill name is structurally impossible because the built-in names are bare
  identifiers that never contain `:`, so no `connector:<id>` can ever match one
  — not even when a connector's id is literally `usage`. The prefixed form is
  also the only way to reach a guide: a bare connector id is never resolved,
  and errors with a pointer to the prefixed name rather than shadowing
  anything. Discovery is conditional: the extra `usage` section and the `guide`
  hints on `search_tools`/`describe_tools`/`skills` appear only once some
  connector declares a guide, so a zero-guide deployment's catalog is
  byte-identical to before — with one exception: the `skills({ name })` error
  wording for connector-shaped names. Those branches are gated on the name
  matching a connector id, not on any guide existing, so asking for a bare
  connector id now reports that the connector has no usage guide where 0.4.1
  said `Unknown skill`, and `connector:<unknown>` reports an unknown connector.
  Guides follow the connection's toolkit scope — a scoped session sees only
  in-scope guides.
- **Per-connector `maxResultBytes` override.** The inline-result byte cap now
  resolves per call as connector value → global `ConnectaConfig.maxResultBytes`
  → the built-in 50 000 default, so a connector that habitually returns large
  payloads can be capped without shrinking everything else. It is a new
  `maxResultBytes` field on the `Connector` interface with pass-through options
  on both `ApiOptions` and `RemoteMcpOptions`. Resolution happens after address
  resolution inside the call path, so `call_tool`, `call_destructive_tool`, and
  each leg of a `batch_call` use their own connector's cap. `get_result`'s
  default page size deliberately stays on the global cap — a stashed result
  carries no connector identity — and `execute_code` host-call results never
  flowed through this truncation path at all (they have a separate guard on the
  final sandbox return), so they're unaffected. A toolkit can neither raise nor
  lower a cap.
- **`ToolCallActivityEvent.toolkitId`** — an optional field on the exported
  activity event, set to the toolkit a call arrived through and absent on
  unscoped calls. Every custom `ActivityStore` now receives it, so a sink that
  persists into a typed or column-bound schema needs a migration to keep the
  value rather than drop it on the floor; sinks that pass the event through
  untouched need no change.

### Fixed

- **`maxResultBytes` is validated at all three intake points, and `get_result`
  paging can never fail to advance** (issue #32). The cap is now a whole number
  of bytes >= 1, enforced from one shared definition. An unusable operator
  value (zero, negative, `NaN`, non-integer, `Infinity`) emits a startup
  warning through the existing insensible-config channel — naming the connector
  for a per-connector override, and quoting the exact value the runtime falls
  back to — instead of silently misbehaving: previously `0`/`NaN` served a
  0-byte head, and a *negative* cap served a **larger** head than the default
  (`Uint8Array.slice` counts from the end) while still claiming truncation. A
  bad `get_result` `maxBytes` argument is now an ordinary input-validation
  error. On top of intake validation, `alignEndToCharBoundary` widens any
  window that would yield no bytes, so a page inside the payload always
  advances; the end of the payload is handled separately, by only reporting a
  `nextOffset` while the window stops short of the total. Between them, paging
  terminates whatever effective page size reaches it. Worth recording so the
  issue isn't closed on a false premise: the *client*-triggerable hang the
  issue suspected was confirmed never reachable — the wire schema already
  rejected non-positive `maxBytes` before dispatch, verified empirically
  against the previous release. The hang was real but operator-triggered only;
  the in-handler check is defense in depth for in-process callers. Valid values
  behave byte-identically to 0.4.1.
- **Documentation coherence pass across README, `docs/`, and `examples/`.** The
  changes above each documented themselves; nobody had reconciled the set.
  Fixed: a TOC link to an anchor that never existed, a toolkits section that
  opened by calling a toolkit "an access boundary" in direct contradiction of
  the "what toolkits are *not*" text below it, a `ConnectaConfig` table missing
  `toolkits` and `probeTimeoutMs`, design.md's silence on guides and toolkits,
  and a `serveMcp` misattribution of where the scope is actually built.
  **Operators running the worker example should note a schema migration**: its
  `ActivityStore` dropped `toolkitId`, the field that shows which team's view a
  call came through. The example now binds and reads back a `toolkit_id`
  column, and its README carries an `ALTER TABLE` note for pre-existing D1
  tables — without it, every insert fails with `no such column`, and because
  activity writes are best-effort the failure is invisible to the caller (it
  surfaces only as a warning per write in the operator log) while the activity
  table stops filling.

### Security

- **`branding.favicon.href` is now scheme-gated**, completing the branding-URL
  invariant begun in 0.4.1 (issue #29). All three branding URLs are validated
  in one resolver shared by both HTML surfaces (`/ui` and the OAuth result
  pages). A favicon href must be an absolute http(s) URL or a genuinely
  root-relative path — enforced structurally, after stripping the tab/LF/CR
  characters URL parsers ignore, with an origin comparison kept as defense in
  depth. Root-relative only, because `/ui` and `/oauth/callback/<id>` sit at
  different depths and a document-relative path would resolve differently on
  each. A rejected value falls back silently to the default `/favicon.svg` and
  is named in a startup warning — which also names a dropped `productUrl` or
  `ownerUrl`, so a deployment that has been quietly carrying one of those since
  0.4.1 will start seeing a warning line it did not see before.
  `resolveBranding` also reads every field through a string guard, so malformed
  branding from an untyped JavaScript caller degrades to defaults instead of
  throwing at construction.
- **GHSA-frvp-7c67-39w9 cleared, and `check:security` tightened from `high` to
  `moderate`.** The advisory (a Windows-only path traversal in
  `@hono/node-server`'s `serve-static`) is resolved by a root `overrides` entry
  pinning `@hono/node-server@^2.0.12`. No *declared* dependency version changes
  — the MCP SDK stays where it was — though the override does of course move
  the resolved transitive package across a major, 1.19.14 to 2.0.12. The
  planned SDK bump could not work: every SDK release from 1.25.0 onward pins a
  `@hono/node-server@^1.19.x` range that can never resolve to the patched 2.x
  line, and it is those same releases that pull the package in at all. This is
  audit-noise remediation rather than live vulnerability remediation — a
  module-graph trace from every SDK entrypoint connecta uses found no reachable
  `@hono/node-server` import, and the vulnerable `serve-static` subpath is
  imported by nothing in the tree — which is what makes the forced major safe.
  The old `high` gate caught high and critical findings correctly, but by
  construction could never surface this moderate one; `SECURITY.md` is updated
  to match, having still recorded the advisory as an accepted open finding
  under the old threshold. **Residual, stated plainly:** npm applies
  `overrides` only at the root project, so consumers who install this package
  still resolve the `1.19.x` range and will keep seeing the advisory in their
  own audits until the SDK moves to `@hono/node-server@^2`. Tracked as issue
  #40, which also retires the override.

## 0.4.1 — 2026-07-25

A security-hardening release from a full audit of the codebase. Every change is
backward-compatible: new safety that could alter behavior is opt-in or a
generous default, and existing well-behaved deployments are unaffected. No
sandbox-escape, RCE, or XSS was found; the items below are the real gaps.

### Security

- **QuickJS sandbox log memory is now bounded.** `execute_code`'s `console.log`
  capped only the *number* of retained entries (200), not their size, so
  untrusted guest code — the sandbox's explicit threat model — could
  `console.log("x".repeat(25_000_000))` two hundred times and retain multiple
  GB of host memory, OOMing the Node process. Each entry is now truncated to 8k
  chars and the cumulative buffer to 256k, both at capture time. Small logs are
  byte-for-byte unchanged.

- **The `fileStorage` state file is now owner-only.** It holds downstream OAuth
  access/refresh tokens in cleartext on the Node backend and was written with
  no mode (world-readable `0644`), so any local user could read long-lived
  tokens. The directory is now `0700`, the temp file `0600` (the atomic rename
  preserves it), and an existing loose-mode file is repaired to `0600` on load.
  Repair is best-effort so a non-POSIX filesystem can't block startup.

- **Cleartext-credential and destination guard on `remoteMcp`.** Static
  `headers` credentials were attached with no scheme check, so an `http://`
  `url` sent bearer tokens / API keys in cleartext. `remoteMcp` now warns at
  construction when headers-auth targets a non-https, non-loopback URL, and a
  new opt-in `requireHttps` makes that a hard error. A `NOTE` documents the
  residual redirect-following SSRF in the SDK's fetch transport (a malicious
  downstream could 3xx-redirect to an internal address); a full guard needs
  manual redirect handling in the SDK and is deferred to a non-patch release.

- **Construction-time warnings for insecure deployment shapes.**
  `createConnecta` now emits a one-time `logger.warn` when: no inbound `auth`
  is configured while credential/OAuth connectors are present (any caller
  reaches the credential vault — connecta's trust model is single-domain, so an
  open or open-signup deployment grants every caller full access); `publicUrl`
  is unset while OAuth connectors exist (the downstream `redirect_uri` is
  derived from the attacker-influenced inbound `Host` header — set `publicUrl`
  to a fixed https origin); or a connector exposes `finishAuth` but not
  `verifyState` (its `/oauth/callback` would exchange any delivered `code`).
  The shipped `remoteMcp` implements `verifyState`, so the last fires only for
  hand-rolled connectors. Full per-actor authorization remains an architectural
  change for a future release.

- **The discovery meta-tools no longer hang on a stuck downstream.**
  `list_connectors`, `search_tools`, and `describe_tools` fanned out live
  probes to every connector with no deadline, so one hung downstream stalled
  the whole call. Bounded by the new `probeTimeoutMs` (below); a timed-out
  connector degrades to an unavailable/errored entry. The bound is
  caller-facing — the registry takes no `AbortSignal` yet, so the underlying
  fetch is not cancelled; real cancellation is a documented follow-up.

- **`/ui` now ships a nonce-based script CSP.** The operator page carried no
  script-restricting CSP, so any future escaping regression would be directly
  exploitable. It now sends a per-request `script-src 'nonce-…' 'strict-dynamic'
  https: 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors
  'none'`. `'strict-dynamic'` keeps Clerk's runtime-injected scripts working;
  the `https:`/`'unsafe-inline'` fallbacks are ignored by modern browsers and
  only cover legacy ones; and no `default-src` is set so Clerk's network/fonts
  and the inline styles stay unrestricted. Operator `branding` `productUrl`/
  `ownerUrl` values are now scheme-gated (a `javascript:` URL is dropped rather
  than rendered as a link), and credential metadata omits `lastFour` for values
  shorter than 12 chars so a short secret doesn't leak half of itself.

### Added

- `RemoteMcpOptions.requireHttps` (default `false`) — reject a non-`https://`
  (non-loopback) `url` at construction, and `RemoteMcpOptions.logger` for the
  cleartext-credential warning.
- `ApiOptions.strictValidation` (default `false`) and
  `ValidateToolInputOptions.failClosed` (default `false`) — reject a call whose
  `inputSchema` the validator cannot evaluate instead of passing the raw
  arguments through. The default remains fail-open (a broken schema does not
  break an otherwise working tool); `api()` also now eagerly compiles each tool
  schema at construction so a bad one warns once at startup rather than
  silently on first use.
- `ConnectaConfig.probeTimeoutMs` (default `30_000`) — per-connector deadline
  for the `list_connectors`/`search_tools`/`describe_tools` fan-out. Generous
  by default so it trips only on a pathological hang; does not apply to
  `call_tool`/`batch_call`, which carry `defaultToolTimeoutMs`.

## 0.4.0 — 2026-07-25

### Added

- `ConnectorCallError` accepts `retryAfterMs` — the wait window a connector
  already knows (a `Retry-After` header, say) and until now had no way to
  report. It round-trips into the value-mode error envelope as
  `error.retryAfterMs` (and `errorDetails.retryAfterMs` in `batch_call`), so an
  agent that receives the failure can schedule a re-issue instead of guessing,
  and the engine's retry loop waits that long in place of its exponential
  guess. A reported window is honoured exactly or not at all: up to 10 s the
  engine waits it in full; beyond that it declines the retry and returns the
  failure immediately rather than retrying inside a rate-limit window it was
  told about. The reported value is never capped.
- `ConnectaConfig.defaultToolTimeoutMs` — a deadline for `call_tool`/
  `batch_call` calls that pass no `timeoutMs`, giving the connector both a
  budget (`ctx.timeoutMs`) and a cancellation signal (`ctx.signal`) on the
  common path, as `execute_code` host calls have always had. **Opt-in and unset
  by default**: switching it on globally would put a deadline on every call in
  every existing deployment, and the failure mode is a working long-running
  call starting to time out. An explicit per-call `timeoutMs` always wins.
- `validateToolInput(schema, args, { address, logger? })` — the argument
  validation `api()` performs, extracted to `src/validate.ts` and exported so
  connectors that implement the `Connector` interface directly can use it too.
  Previously enforcement lived inside `api()`, so a hand-rolled connector whose
  manifest declared `additionalProperties: false` had nothing enforcing it: an
  unknown argument key was silently dropped, an empty body went upstream, and a
  200 was reported back as a successful write. It **returns** the non-retryable
  `invalid_args` `ConnectorCallError` (or `null`) instead of throwing, so the
  connector owns the decision — its own error prose, or stripping a
  connector-wide convention argument the tool schema doesn't declare. `api()`
  now calls it; behaviour is unchanged (`test/api-connector.test.ts` is
  untouched).
- `@zackbart/connecta/json-schema` — re-exports `Validator` from
  `@cfworker/json-schema`. It was already a direct dependency but not public,
  so downstream build-time validation (a manifest generator asserting its own
  output) resolved it only through npm hoisting.

### Fixed

- `compactSchema` — the rendering behind `search_tools` and `describe_tools`,
  and for most models the only description of a tool they ever read — dropped
  `const` and did not handle `allOf`. A discriminated union, the standard shape
  for "one of these request bodies", therefore rendered as several textually
  identical branches with the field that selects them erased
  (`{ type: string, emoji: string } | { type: string, external: {…} }`), and a
  schema using `allOf` fell through to raw `JSON.stringify` — on a real
  connector that measured *longer* than the schema it was meant to compact.
  `const` now renders as a literal, so unions are self-documenting again, and
  `allOf` composes with the schema's own shape joined by `&` rather than
  replacing it: a sibling `properties`, `$ref`, `enum`, `const`, or `items` is
  no longer silently dropped, and an empty `allOf` beside real properties no
  longer erases the whole schema.
- An aborted call — including one the engine itself cancelled at its deadline —
  was classified `connector_call_failed`/`retryable: false`. An aborted `fetch`
  rejects with a `DOMException` named `AbortError` whose message matches
  neither classification regex. `classifyCallError` now checks the name before
  the message text and classifies it as a retryable `timeout`, so connectors
  that pass `ctx.signal` through no longer have to special-case it.

## 0.3.0 — 2026-07-24

### Added

- `ConnectorCallError` — a typed failure contract for `Connector.callTool`.
  Connectors can classify failures exactly (`timeout`, `auth_required`,
  `rate_limited`, `unavailable`, `invalid_args`, `connector_call_failed`) and
  set `retryable` explicitly, instead of the meta-tools regexing message text.
  Plain `Error`s keep the old heuristic as a fallback, so existing connectors
  are unaffected. `remoteMcp()` now converts the SDK's `UnauthorizedError`
  into a per-call `auth_required` error that names `authorize_connector`, so
  a token that expires between `status()` and `callTool` routes the agent to
  re-auth instead of a generic failure.
- `api()` validates call arguments against each tool's `inputSchema` (draft
  2020-12, using the existing `@cfworker/json-schema` dependency) before the
  handler runs. Mismatches fail closed as non-retryable `invalid_args` errors
  naming the offending locations. Opt out per connector with
  `validateArgs: false`. Remote MCP connectors deliberately stay
  pass-through — the downstream server is authoritative for its own schemas.
- `fileStorage(path, { logger })` — the corrupt-state-file recovery report now
  goes through the package's `Logger` seam instead of being hardwired to
  `console.error`.
- Workers runtime test suite: the vitest config now runs the suite under both
  Node and `workerd` (`@cloudflare/vitest-pool-workers`), so Workers-only
  regressions fail CI instead of surfacing in production. Two real
  `return await` bugs in the credential and sandbox paths were found and
  fixed by the new pool.
- The Docker example is now verified: CI builds `examples/docker/Dockerfile`
  and smoke-tests `/health` on every push.

### Fixed

- A connector error whose legitimate message text merely mentioned "timeout"
  was misclassified as a retryable timeout and re-run (and recorded as
  outcome "timeout" in activity). Typed errors are now authoritative for
  classification wherever they pass through `call_tool`, `batch_call`, and
  `execute_code` host calls.

## 0.2.1 — 2026-07-24

### Added

- `serverInfo` now passes `title`, `websiteUrl`, and `icons` (MCP icons spec)
  through to the initialize response, so icon-aware clients (claude.ai)
  render the declared mark and human-readable name instead of a scraped
  domain favicon.

## 0.2.0 — 2026-07-24

### Breaking

- Trimmed internal factoring out of the root export: `CredentialVault`,
  `createMetaTools`, `buildSandboxProviders`, `createExecuteTool`, and
  `sanitizeIdentifier` are no longer exported, and `Registry` is now a
  type-only export (it is still reachable as `Connecta.registry`). Import from
  source paths if you were depending on any of them.

### Added

- `Connector.handleRequest(request, ctx)` — an optional seam for
  connector-owned public routes, e.g. a signed download link minted by one of
  the connector's tools. Dispatched only after every built-in route misses, so
  a connector can add a route but never shadow `/mcp`, `/ui`, `/health`, or the
  credential API, and inside the security-header wrapper that previously only
  covered connecta's own routes. Generalizes the `/oauth/callback/<id>`
  special case.
- Branding is now complete: `productUrl`, `pageTitle`, `themeColor`, and
  `favicon: { svg, ico, href }` join the existing labels, and the dashboard's
  remaining hardcoded "Connecta" strings now follow `productName`. A
  deployment can replace every operator-facing label and mark.
- `listen()` accepts an options object — `{ port, host, maxBodyBytes,
  gracefulShutdown, shutdownTimeoutMs }` — alongside the existing plain port.
  Graceful shutdown is on by default: SIGTERM/SIGINT stop accepting
  connections, let in-flight requests finish, drain deferred work, then exit.
- `CONNECTA_VERSION` is exported and is now the single source of the version
  reported by `/health` and by the downstream MCP client handshake. A test
  asserts it matches package.json.

### Fixed

- `fileStorage` no longer silently discards a corrupt state file. It moves the
  damaged bytes to `<path>.corrupt-<timestamp>`, logs loudly, and starts from
  empty — previously the next write persisted `{}` over irreplaceable
  downstream OAuth tokens and credential-vault entries. If the file cannot be
  moved aside, startup fails rather than overwriting it.
- The Node adapter streams response bodies instead of buffering them through
  `arrayBuffer()`, and caps request bodies at 10 MiB (413) instead of
  accumulating them without limit.
- Deferred work now settles on Node: `listen()` supplies a `waitUntil`
  equivalent and drains it on shutdown. The Workers example passes `ctx`
  through, so the `defer` path is exercised on both runtimes.
- The meta-tools carry their own MCP behavior annotations. Previously only
  `skills` and `call_destructive_tool` did, so hosts that gate on hints treated
  read-only meta-tools as potentially destructive — and a connecta aggregated
  behind another connecta would have been refused by its own fail-closed
  policy.
- `listen()`'s request handler logs the error it catches instead of returning a
  bare 500.
- The import-graph purity test now also rejects dynamic `import("node:…")`,
  which previously slipped past both of its patterns.
- Operator-supplied `branding.productName` is escaped for the `<script>`
  context it is inlined into, not just for HTML attributes.
- A mid-stream response failure destroys the connection instead of appending an
  error string to the partial body the client is already reading, and graceful
  shutdown closes idle keep-alive sockets rather than waiting out its own
  deadline on them.

## 0.1.1 — 2026-07-24

- Fix: `/health` is no longer 308-redirected to `publicUrl` when it is reached
  over plain HTTP. Container and orchestrator liveness probes hit loopback
  without `X-Forwarded-Proto`, so the redirect made an internal health check
  depend on external DNS, TLS, and any proxy in front of connecta — the shipped
  Docker `HEALTHCHECK` reported unhealthy for every HTTPS `PUBLIC_URL`
  deployment. All other routes still redirect.

## 0.1.0 — 2026-07-23

- Initial public package release.
- Generic API and remote MCP connector contracts.
- Nine fixed meta-tools with progressive tool discovery and approval boundaries.
- Optional sandboxed code mode for dependent read-only orchestration.
- Generic storage, activity, authentication, and credential-management seams.
- Node and Web-standard fetch runtimes.
- Optional Clerk authentication adapter.
