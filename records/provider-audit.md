# Provider audit

[`provider-conventions.md`](../documentation/provider-conventions.md) wrote the bar down. This
document runs it against the seven maintained providers and their ten selectable
interfaces, then returns a verdict for every applicable convention: **meets**,
**misses** (with the fix), or **n/a** (with the reason). A convention is never
quietly skipped, and an accepted miss is recorded as a provider-specific
exception with its argument rather than left blank.

Hand-written HTTP providers are audited against H1–H14; hosted-MCP proxies
against P1–P13. Applying a hand-written convention to a proxy is a category
error, not a finding, so the proxy reports have no H rows.

Every miss below is fixed in the same change that recorded it
([#342](https://github.com/zackbart/connecta/issues/342)), except where the row
says otherwise. The mechanically checkable half of the hand-written bar is now
a test — [`test/provider-conventions.test.ts`](https://github.com/zackbart/connecta/blob/main/test/provider-conventions.test.ts)
walks the shipped surface of all three `api()` providers on every run, so these
verdicts cannot rot quietly back into prose. The proxies' mechanical rows live
in their own suites, because what they assert is the wrapper's identity,
classification, and budget rather than tool shapes the wrapper does not own.

Two things this audit deliberately does not decide:

- **Whether each Cloudflare named tool earns its place.** That is
  [#350](https://github.com/zackbart/connecta/issues/350), which measures the
  named surface against the escape hatch with usage evidence. H14's keep/prune
  judgment is reported here as open, not answered.
- **Whether a downstream catalog has drifted since a release reviewed it.**
  Detection at refresh shipped with
  [#343](https://github.com/zackbart/connecta/issues/343) and the maintainer-run
  check is [#351](https://github.com/zackbart/connecta/issues/351). P13 is
  audited as "is the list addressable by such a check", not as "is the list
  current" — the answer to the second question arrives from a running
  deployment, not from a reading.

## Cloudflare — hand-written HTTP

Fifty-one tools over the v4 REST API: forty-eight named, three guarded escape
hatches. The largest surface here and the one with the most to get wrong.

| Convention | Verdict | Notes |
| --- | --- | --- |
| H1 identity | meets | `id`, required `purpose` (blank throws), optional `title`, `instructions` appended under `## Account instructions` |
| H2 names | meets | every name is `snake_case` and opens with a verb from the connector's own set; the hatches sort together as `cloudflare_api_*` |
| H3 budgets | **missed → fixed** | `cloudflare_api_get` (289), `cloudflare_api_mutate` (266), and `create_dns_record` (305) exceeded the 240-character describe budget. All three trimmed; the record-type list `create_dns_record` was spending 60 characters on is already the `type` enum |
| H4 disqualifiers | meets (a reading) | the hatch descriptions say what they will not do — mutate, upload — and `create_dns_record` now names the types it reads but cannot create |
| H5 schemas | **missed → fixed** | the top level was already exemplary — every tool a closed plain object with a `required` list, a description on every property, and an `api()` construction contract that refuses an unenforceable schema (#340) — but H5 says *every* property, and the nested ones had been read as furniture. `bulk_write_kv_values` shipped six undescribed fields inside `entries[]`, including the expiry pair whose units and floor are the whole question. All six now say what they are, and the convention test walks every depth rather than the first one |
| H5 exception | recorded | the three escape hatches' request parts — `query[]`, `headers[]`, `fields[]`, `files[]` — keep undescribed `name`/`value` members, because H5 collides with H7 there. `query` and `headers` are one shared constant the renderer inlines into all three hatches, and `cloudflare_api_upload` sits at 1,007 of the 1,024-byte budget this same audit brought it back under; describing name/value pairs the parent property has already named as name/value pairs would truncate the whole tool in discovery. The 21 properties are listed by path in `test/provider-conventions.test.ts` and asserted exactly, so a new one fails and so does a stale entry |
| H6 whose bound | meets | exemplary. `pagingInputProperties` carries a three-way `bounds` vocabulary — `cloudflare`, `clamped`, `undocumented` — and the description says which one applies |
| H7 compact fit | **missed → fixed** | `cloudflare_api_upload` rendered to 1,297 bytes. The refused-header list, inlined once per hatch, moved to the usage guide; the remaining upload descriptions were cut to the fact each adds. Now 1,007 |
| H8 output schemas | meets | all 48 named tools declare useful top-level keys; the three endpoint-generic hatches alone keep open result objects |
| H9 projection | meets | reads project and rename; `raw: true` wherever the projection drops something recoverable; `cloudflare_api_get` is the universal unprojected read |
| H10 pagination | **missed → fixed** | two conventions live here, which H10 allows, but only the guide said so. Three of the four cursor tools had a bare `nextCursor: { type: "string" }` with no description. Both ends now state it: `cursor` says the endpoint pages by cursor, `nextCursor` says it is the only signal and no `page` object is coming |
| H11 errors | meets | mapped by the caller's next move, including the 400-with-credential-code case that is `auth_required` rather than `invalid_args`; every mapped status has a test asserting code and retryability |
| H12 credential | meets | labeled fields per authentication mode, `testCredential` on the token path (`/user/tokens/verify`) and `testCredentials` on the Global API Key pair (`/user`), each reporting who it authenticated as |
| H13 guide | **missed → fixed** | the guide was a bare string, so its summary was derived from the first content line — the zone-scoping rule, which varies per deployment and reads as an instruction. Now structured with a declared summary. `required` stays unset, deliberately: every named schema is complete enough to call on its own and the scoping convention is repeated on each `zoneId` and `accountId` property, so forcing the guide into context before every operation would buy nothing |
| H14 hatch shape | meets | split GET / JSON-mutate / upload, the split is Connecta's, the GET tool is annotated read-only, paths are provider-relative and confined |
| H14 keep/prune | meets | #350 measured 30 keep, 18 improve, and 3 prune; the three removals shipped, and #488 resolved the output misses on the tools that stayed |

## Notion — hand-written HTTP

Fifteen tools over the public REST API, pinned to `2026-03-11`. A small,
deliberate surface.

| Convention | Verdict | Notes |
| --- | --- | --- |
| H1 identity | meets | `id`, required `purpose` (blank throws), optional `title`, `instructions` appended under `## Workspace instructions` |
| H2 names | meets | `snake_case` throughout, and Notion's own vocabulary (`query_`, `append_`, `trash_`) where the shared verbs would lie — `trash_page` is not `delete_page`, because Notion does not delete |
| H3 budgets | **missed → fixed** | `search` was 252 characters. Trimmed to 205; the clause it lost restated what `get_page` is for |
| H4 disqualifiers | meets (a reading) | `search` "Never searches page content" is the convention document's own worked example, and it came from here |
| H5 schemas | **missed → fixed** | four gaps. A schema the validator could not evaluate would have forwarded arguments unchecked rather than refusing — in a surface we wrote ourselves that is our bug being papered over; `api()` now refuses such a schema at construction for every connector (#340). `search`, `list_users`, and `get_self` carried no `required` list at all, and `create_page` carried none because its constraint is exclusive rather than positional. All four now declare one, and the shipped schemas are asserted evaluable so fail-closed handling cannot become a blanket refusal. The fourth gap was nested: `query_data_source`'s `sorts[].direction` carried an enum and no description, which the top-level-only reading of H5 had missed |
| H5 exception | recorded | `create_page` declares `required: []`, not the truth. A page needs exactly one parent, but *which* parent is an exclusive choice a plain-object `required` list cannot express, and the top-level `anyOf` that could would cost the tool its `inputKeys` in discovery — the caller would learn nothing about the arguments without expanding the schema. The rule is stated in both parent descriptions and enforced locally as `invalid_args` before any round trip, so the cost H5 exists to avoid is still avoided |
| H6 whose bound | meets | `page_size` names Notion's 1–100 and says the default is the connector's configured one |
| H7 compact fit | **missed → fixed** | `query_data_source` rendered to 1,087 bytes. Three shared property descriptions (`raw`, `start_cursor`, `properties`) were carrying guide-length prose that the renderer inlines once per tool that uses them; cut to the fact each one adds. `query_data_source` is now 909 and every other tool got smaller for free |
| H8 output schemas | meets | 15 of 15 |
| H9 projection | meets | every read projects; `raw: true` on the seven reads where the dropped detail can matter; Notion's own 25-entry property truncation is surfaced as `truncated_properties` with the `property_id` needed to fetch the rest, rather than handed back as a confident partial |
| H10 pagination | meets | one convention, one signal: `page_size` and `start_cursor` in, `has_more` beside `next_cursor` out, default 25 against Notion's 100 |
| H11 errors | meets | and unusually careful about the ambiguity: a 404 is `connector_call_failed`, not `auth_required`, because `authorize_connector` cannot fix "never shared with this integration", and the message states the ambiguity instead of picking the convenient reading |
| H12 credential | meets | one labeled integration-token field; `testCredential` calls `/v1/users/me` and reports the workspace it authenticated as |
| H13 guide | meets | structured, declared summary, `required: true` with a stated reason — the database→data-source lookup is a sequence no complete schema can express |
| H14 hatch | **missed → fixed** | Notion has no guarded raw-REST tool, which H14 explicitly permits for a finite surface — provided it says so. It did not. The guide now names the absence, so an agent does not spend a search proving there is no `notion_api_get` |

The 0.17.0 drift review also considered Notion's expanded create and update
contracts. Workspace-private creation, templates, placement, richer media,
locking, and irreversible content erasure stay outside the maintained surface.
They are separate ownership, ordering, asynchronous, coordination, file, or
deletion workflows rather than missing fields on the five existing writes
([#408](https://github.com/zackbart/connecta/issues/408),
[#409](https://github.com/zackbart/connecta/issues/409)).

## Vercel — hand-written HTTP

Twenty-one tools over the public REST API: eighteen named, two guarded request
hatches, and one guarded upload hatch. The named tools deliberately go past
Vercel MCP on project domains, environment variables, and deployment lifecycle.

| Convention | Verdict | Notes |
| --- | --- | --- |
| H1 identity | meets | `id`, required `purpose` (blank throws), optional `title`, default `teamId`, and `instructions` appended under `## Account instructions` |
| H2 names | meets | every name is `snake_case`, opens with its safety verb, and the three generic tools sort together as `vercel_api_*` |
| H3 budgets | meets | every selection sentence fits 160 characters and every full description fits 240, asserted with the other hand-written providers |
| H4 disqualifiers | meets | project and deployment reads state what their logs and actions do not include; the mutate hatch says JSON and no uploads; the upload hatch says explicit bytes and no local files |
| H5 schemas | meets | all 21 tools use closed plain-object input schemas with explicit required lists, described nested fields, local bounds, and construction-time validator compilation |
| H6 whose bound | meets | list sizes name the connector's 1–100 cap and configured default; build logs name the 1,000-event cap; runtime logs name the 500-row and 10-second connector bounds; environment values name Vercel's 64 KB total |
| H7 compact fit | meets | every input and output remains complete under the 1,024-byte compact renderer budget |
| H8 output schemas | meets | 21 of 21; the endpoint-generic hatches alone keep an open `result` |
| H9 projection | meets | project, deployment, domain, and build-log reads project and offer `raw: true`; environment reads never decrypt or return values, and writes also strip values from their result |
| H10 pagination | meets | teams, projects, deployments, and domains expose the same `page.hasMore` and opaque `page.nextCursor`; environment listing honestly has no page in Vercel's contract |
| H11 errors | meets | 401/403 auth, 404 absence, 400/409/422 arguments, 429 rate limit with either reset header, and 5xx availability are asserted by code and retryability |
| H12 credential | meets | one labeled access-token field; `testCredential` calls `/v2/user` and reports the identity the token authenticated |
| H13 guide | meets | structured, declared summary, `required: true` because personal-versus-team scope and build-versus-runtime log selection are cross-tool rules no one schema can carry |
| H14 hatch | meets | split GET, JSON mutation, and raw upload; only GET is read-only, all paths are provider-relative and confined, personal-account scope is explicit, and upload bytes and transport-owned headers stay guarded |

The initial drift review used Vercel's live OpenAPI document rather than the
generated SDK as authority. It caught two version changes before this provider
shipped: deployment listing is `/v7/deployments`, and environment-variable
list/create are `/v10/projects/{idOrName}/env` while update/delete remain on
v9. The reviewed 19 fixed operations now live in
`scripts/drift/vercel-endpoints.json`; the dynamic hatches do not pretend to
have a fixed endpoint manifest.

## Cloudflare, Notion, and Vercel — hosted-MCP alternatives

These three providers also expose an explicitly selected hosted-MCP interface.
They share the proxy boundary without pretending their catalogs are the same:
the provider owns every name, description, schema, and result, while Connecta
adds only the release-reviewed safety verdict and routing guide.

| Convention | Verdict | Notes |
| --- | --- | --- |
| P1 add, never rewrite | meets | `withVettedCatalog()` preserves every live tool field and changes only missing or contradicted safety annotations; deterministic coverage pins the description and both schemas by reference |
| P2 identity | meets | all three require a non-empty `purpose`; `instructions` are appended to the guide and cannot alter classification |
| P3 routing fact | meets | default titles name the provider and `(MCP)` interface; each guide opens with the deployment purpose and official-interface boundary |
| P4 endpoint default | n/a, recorded | each provider publishes one whole-interface endpoint, so there is no regional or access-mode endpoint choice to default; selecting `surface: "mcp"` is itself explicit |
| P5 classification | meets | every officially documented name is reviewed; unlisted names fail closed, and Vercel URL fetching is destructive because an application GET route may execute stateful code |
| P6 catalog varies | meets | the guides say permissions, account features, plans, clients, and provider rollout can change the live catalog independently of Connecta |
| P7 reduction advice | meets | all three guides tell agents to narrow at the provider call and reduce again inside `execute_code`; the summaries identify the cross-tool routing facts |
| P8 identity resolution | meets | Cloudflare searches the OpenAPI document before execute; Notion and Vercel name the discovery tools and opaque ids their subsequent calls require |
| P9 authentication | meets | all require HTTPS and default to OAuth; Cloudflare additionally accepts a scoped bearer token for a headless deployment |
| P10 no credential test | meets | construction performs no downstream request and the wrappers expose no credential-test hook |
| P11 transport vs tool error | meets | inherited from `remoteMcp()`; provider argument, permission, plan, and rollout errors remain provider-owned prose |
| P12 admission budget | meets | no guessed provider-wide quota is hardcoded; each MCP option accepts an operator-supplied per-runtime admission policy |
| P13 drift visible | meets | module-level vetted catalogs feed runtime count-only drift and the credential-free public-docs check; live `tools/list` remains the schema authority |

## Linear — hosted-MCP proxy

| Convention | Verdict | Notes |
| --- | --- | --- |
| P1 add, never rewrite | meets | `listTools` maps annotations and returns every other field untouched |
| P2 identity | meets | required `purpose` (blank throws), `instructions` appended, and appended text cannot reach the classification |
| P3 routing fact | meets | read-only rides the default title *and* opens the guide, because search renders neither description |
| P4 endpoint default | **missed → fixed, departing from the letter** | `access` defaulted to `"read-write"`, which is not the safe endpoint. It is now required with no default, and construction throws naming both options. The convention says "default to the safe one"; the honest reading of its heading — *the safest **honest** default* — is that Linear has none. Defaulting to `"read-only"` would turn a deployment that does write into one whose every write fails at Linear, at runtime, where no agent can repair it; defaulting to `"read-write"` hands out writes nobody asked for. Requiring the declaration fails at construction, where an operator can act. This is the one place in the audit where the fix departs from a convention's literal text, and it is recorded here rather than smuggled |
| P5 classification | meets | reads and writes named, unlisted resolves to not-read-only, reviewed destructive beats a contradictory `readOnlyHint: true`, additive writes leave `destructiveHint` unset |
| P6 catalog varies | meets | the guide names customer requests, releases, and code review as the plan- and feature-gated areas where absence is expected |
| P7 reduction advice | **missed → fixed** | the guide was a bare string. Its derived summary was the access note cut mid-sentence at 120 characters — the one fact an agent must not get wrong, delivered as a fragment. Now structured with a declared summary per access mode. `required` stays unset: Linear's own schemas describe each call, and the guide's value is cross-tool sequence advice worth reading before a write, not before every read |
| P8 identity resolution | meets | exemplary. The guide names the read tools that produce each id, and separates Linear's human identifier (`ENG-123`) from its UUID |
| P9 authentication | meets | OAuth default, `requireHttps`, personal API key documented as a secret and paired with the narrowest access, `auth_required` → `authorize_connector` route named in the guide |
| P10 no credential test | meets | no `credential`, `testCredential`, or `testCredentials` on the wrapper |
| P11 transport vs tool error | meets | inherited whole from `remoteMcp()`; the wrapper adds no error handling and reads no downstream prose |
| P12 admission budget | meets | exemplary, and the reason P12 exists. Linear documents no MCP-specific limit and meters the underlying API per user per hour, so the connection declares no budget and documents how an operator supplies one |
| P13 drift visible | meets | both lists are module-level constants in one file per provider, and now *are* the manifest the wrapper classifies from, compared against the live catalog on every refresh ([#343](https://github.com/zackbart/connecta/issues/343)); the maintainer-run check is [#351](https://github.com/zackbart/connecta/issues/351) |

## Stripe — hosted-MCP proxy

| Convention | Verdict | Notes |
| --- | --- | --- |
| P1 add, never rewrite | meets | annotations only |
| P2 identity | meets | required `purpose`, `instructions` appended, classification untouchable from there; purpose states deployment routing intent and the guide says it is not proof of authenticated account identity |
| P3 routing fact | meets | OAuth metadata states mixed account scope and the guide resolves mode from `livemode`; fixed header credentials retain their mode in every routing surface |
| P4 endpoint default | meets | OAuth has no connector-wide mode to default; static headers require one, and construction throws when a recognizable key prefix contradicts it |
| P5 classification | meets | `stripe_api_read` is a read because the tool is the boundary; `stripe_implementation_planner` and `stripe_analytics` are additive because their shared tool boundaries can create guide or query-run state without changing an existing Stripe resource |
| P6 catalog varies | **missed → fixed** | the doc already knew this (`get_balance_summary` is Treasury and gated; a `create_customer` example survives in Stripe's prose but not its tool table), but the *guide* did not say it, and the guide is what reaches the agent. Added |
| P7 reduction advice | **missed → fixed** | OAuth has a mixed-scope summary; fixed credentials keep mode-shaped summaries. `required` stays unset because the four generic tools remain the routing decision |
| P8 identity resolution | **missed → fixed** | The guide names typed object ids and their read sources. For OAuth it requires `list_available_accounts_or_orgs`, then carries the returned `stripe_context` and `livemode` unchanged; ambiguity stops ([#404](https://github.com/zackbart/connecta/issues/404), [#414](https://github.com/zackbart/connecta/issues/414)) |
| P9 authentication | meets | OAuth default, `requireHttps`, restricted key documented as a secret and paired with the narrowest scope. The guide distinguishes organization accounts within an OAuth session from Connect connected accounts, whose calls reject OAuth and use a deployment-configured restricted key plus `Stripe-Account`. The `auth_required` → `authorize_connector` route was added alongside P8, since a proxy's only recovery instruction lives there |
| P10 no credential test | meets | no credential slot; the mode/key contradiction throws at construction instead, which is where P10 says the H12 guarantee gets paid |
| P11 transport vs tool error | meets | inherited from `remoteMcp()`; the guide now also says that a rejected argument or plan restriction arrives in Stripe's own words and is not an authorization problem |
| P12 admission budget | meets | fixed credentials use their documented mode rate; mixed OAuth uses the stricter 25/s sandbox rate and concurrency bound |
| P13 drift visible | meets | both lists are module-level constants in one file, and are the manifest the refresh-time drift check compares against ([#343](https://github.com/zackbart/connecta/issues/343)) |

## Mixpanel — hosted-MCP proxy

The proxy with the most misses, and none of them subtle: it was written before
the conventions existed and inherited its shape from Linear without inheriting
Linear's reasoning.

| Convention | Verdict | Notes |
| --- | --- | --- |
| P1 add, never rewrite | meets | annotations only |
| P2 identity | meets | required `purpose`, `instructions` appended |
| P3 routing fact | **missed → fixed** | region is exactly the fact P3 names, and it appeared in neither the default title (`"Mixpanel"`) nor the guide's first line. A project lives in one residency, so a question pointed at the wrong connector comes back empty rather than wrong — which reads as the project having no data. The title now carries it (`Mixpanel (us)`, `(eu)`, `(in)`) and the guide opens with it |
| P4 endpoint default | meets | three published endpoints, an option that selects between them, and `"us"` as the default because that is where a project lives unless it was explicitly created elsewhere. Unlike Linear's, this default is honest: a wrong region cannot cause an irrecoverable write, only an empty read. Construction now also rejects a region there is no endpoint for |
| P5 classification | meets | reads and writes named, unlisted fails closed, reviewed destructive beats a contradictory `readOnlyHint: true` |
| P6 catalog varies | **missed → fixed** | the provider doc knew that beta surfaces vary by account; the guide did not say so. Added, naming experiments, feature flags, session replay, and issue triage as the usual absentees. The 2026-08-30 review classified the new `Fill-Event-Metadata` write and refreshed three beta experiment schemas (#512) |
| P7 reduction advice | **missed → fixed** | bare string, derived summary. Now structured with a declared, region-shaped summary. `required` unset: the project-then-context sequence is worth reading before an analysis, not before every call |
| P8 identity resolution | **missed → fixed** | the guide told an agent not to guess event and property *spelling* but said nothing about ids, and Mixpanel's `Get-`, `Update-`, and `Delete-` tools all take them. Added, naming the `List-` tools that produce each one |
| P9 authentication | meets | OAuth default, `requireHttps`, service account documented as a secret |
| P10 no credential test | partial — n/a for half | no `credential`, `testCredential`, or `testCredentials`, as required. The construction-time contradiction check P10 points at has nothing to check here: a Mixpanel service-account token does not encode its region, so there is no recognizable credential for a declared region to contradict. Recorded rather than invented — guessing a region from a token shape this release does not understand is precisely what P4 tells Stripe not to do |
| P11 transport vs tool error | meets | inherited from `remoteMcp()`; the guide now names the `auth_required` → `authorize_connector` route and says a plan restriction arrives in Mixpanel's own words |
| P12 admission budget | **missed → fixed** | the connection hardcoded a 600-call hourly budget transcribed from a limit Mixpanel meters **per user**. P12 names this case exactly: a per-runtime counter cannot approximate a per-user quota in either direction — one runtime serving several users under-counts, several isolates sharing one credential each admit a full budget. The default is removed; `callAdmission` is now an operator option with a documented example, matching Linear |
| P13 drift visible | meets | both lists are module-level constants in one file, and are the manifest the refresh-time drift check compares against ([#343](https://github.com/zackbart/connecta/issues/343)) |

## RevenueCat — hosted-MCP proxy

Written after the conventions existed, so it has no misses to record, only two
places where the honest answer departs from the obvious one. One hundred five
documented tools, 104 classified, one deliberately not.

| Convention | Verdict | Notes |
| --- | --- | --- |
| P1 add, never rewrite | meets | `listTools` maps annotations and returns every other field untouched |
| P2 identity | meets | required `purpose` (blank throws), `instructions` appended under `## Project instructions`, and appended text cannot reach the classification |
| P3 routing fact | meets, with the fact split in two | the routing fact is scope, and it has two halves. The *shape* — one project versus every project the account can reach — is knowable at construction and rides the default title (`RevenueCat (single project)` versus `RevenueCat`). *Which* project a key opens is not knowable without calling something, which P10 forbids, so it rides the guide's first line and the declared summary, built from the operator's `purpose`. That makes this the one maintained proxy with a purpose-bearing summary rather than a static one, and the reason is P3's own cost: two `sk_` connectors share a title, an endpoint, and a catalog, so a static summary would leave them indistinguishable in the only field search returns |
| P4 endpoint default | n/a — one endpoint, and the scope rides the credential | RevenueCat publishes a single MCP endpoint, so there is nothing to select between. The scope difference comes from the credential shape itself, which the constructor reads rather than asks for: `auth.type === "headers"` *is* the single-project declaration. There is no mode to default and no mode to contradict, so the P4 machinery Stripe needs has nothing to do here |
| P5 classification | meets | 51 reads, 17 additive writes, and 36 destructive writes named. `render-paywall-screenshot` remains unclassified because RevenueCat's reference gives it no access column; its current explicit read-only annotation is preserved, and silence fails closed. Borderline verdicts are argued beside the rows they decide and asserted in the suite so a silent flip fails |
| P6 catalog varies | meets | the guide names paywall AI editing, benchmarks, experiments, virtual currencies, and account billing as the plan-, platform-, and beta-gated areas where absence is expected, and separately names the unclassified tool so its approval prompt does not read as a bug |
| P7 reduction advice | meets | structured guide, declared summary, cursor-then-reduce advice aimed at the two objects that are actually large here (customers and their event history). `required` stays unset: the project-resolution sequence is worth reading before a run, not before every call |
| P8 identity resolution | meets | the guide names the whole chain — `list-projects` for the `project_id` every project-scoped call takes, then `list-apps`, `list-products`, `list-entitlements`, `list-offerings`, `list-paywalls`, `list-audiences`, and `list-customers` for the ids their `get-`, `update-`, `archive-`, and `delete-` counterparts expect — and says a plausible-looking id belongs to another project or to nobody. For OAuth it also says to stop and ask when more than one project fits |
| P9 authentication | meets | OAuth default, `requireHttps`, the API v2 secret key documented as a secret and paired with the narrowest scope RevenueCat offers (one project). The guide names the `auth_required` → `authorize_connector` route, and separately says that a read-only key's refusal is RevenueCat's own words rather than an authorization gap connecta can repair |
| P10 no credential test | meets | no `credential`, `testCredential`, or `testCredentials`. This is also where the constructor's most tempting option was refused: a `project?: string` checked against `list-projects` at construction is a credential test wearing a configuration hat, so the operator's stated purpose carries the claim and the agent confirms it on first use. There is no recognizable-credential contradiction to throw on either — an `sk_` key encodes no project — so the construction-time half of P10 has nothing to check here, exactly as it has nothing to check for Mixpanel's region |
| P11 transport vs tool error | meets | inherited whole from `remoteMcp()`; the wrapper adds no error handling and reads no downstream prose. The guide says a rejected argument, a permission gap, and a plan restriction all arrive in RevenueCat's own words |
| P12 admission budget | meets, by declining a number that exists | RevenueCat does publish limits, which is why this row needed an argument rather than a shrug. It meters per domain — 480/min for customer information, virtual currencies, and refunds; 60 for project configuration and audiences; 25 for charts and metrics — and a `ConnectorCallAdmissionPolicy` carries exactly one rule. Picking 25 throttles a customer read loop to a nineteenth of its allowance; picking 480 leaves a chart sweep unprotected; neither is the provider's limit. The metering scope repeats the point: developer-level keys are metered per developer, which a per-runtime counter cannot approximate. So the guide states RevenueCat's own numbers and the `429` / `Retry-After` / `backoff_ms` signals, and `callAdmission` stays an operator option with a documented example |
| P13 drift visible | meets | both lists are module-level constants in one file and *are* the manifest the wrapper classifies from, compared against the live catalog on every refresh ([#343](https://github.com/zackbart/connecta/issues/343)). The credential-free provider check compares them with RevenueCat's official 105-row reference. No schema is vendored; the live definition remains the one agents receive |

## Scoreboard

| Provider interface | Meets | Missed and fixed | Recorded exception | Open |
| --- | --- | --- | --- | --- |
| Cloudflare API | 9 | 5 | H5 hatch request parts | — |
| Cloudflare MCP | 12 | 0 | P4 n/a (one endpoint) | — |
| Notion API | 10 | 4 | H5 exclusive parent | — |
| Notion MCP | 12 | 0 | P4 n/a (one endpoint) | — |
| Linear | 11 | 2 | P4 departs from the letter | — |
| Stripe | 10 | 3 | — | — |
| Mixpanel | 7 | 5 | P10 half n/a | — |
| RevenueCat | 12 | 0 | P4 n/a (one endpoint); P3 met with a purpose-bearing summary | — |
| Vercel API | 14 | 0 | — | — |
| Vercel MCP | 12 | 0 | P4 n/a (one endpoint) | — |

The original seven interfaces recorded nineteen misses and nineteen fixes. The
three hosted alternatives add no misses and record their one-endpoint P4 cases
instead of inventing a choice. The pattern in the original misses is worth naming: sixteen of
the nineteen are a guide, a title, or a schema description failing to *say*
something the implementation already did correctly. Only three changed what a
provider does — Notion refusing an unevaluable schema, Linear requiring an
access declaration, Mixpanel dropping a budget it could not honestly compute.
The conventions are mostly not asking for different behavior. They are asking
for the behavior to reach the agent, which is a different problem and, on this
evidence, the one the providers were losing.

RevenueCat and Vercel were written *after* the conventions and add no misses to
those nineteen, which is the least interesting thing about their rows.
The interesting part is that two conventions came out somewhere other than
their obvious reading — P4 has no endpoint to select and P12 declines a number
the provider actually publishes — and both had to be argued rather than
skipped. A convention that only ever returns "meets" is not being applied.
