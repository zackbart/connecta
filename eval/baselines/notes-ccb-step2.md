# CCB step 2 eval and implementation evidence (#703)

Seven fresh fake-only workflows compare CCB's existing v2 JSON/OAuth surface
with decision 0011 step 2. The [frozen tasks](../tasks/ccb.ts),
[137-person fake](../fakes/ccb.ts) and outcome graders serve both arms.
[The JSON summary](./ccb-step2.json) records every trial, failure, source stamp,
raw-file digest, tool use and metric. Full transcripts, fake snapshots and
verification logs remain in
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/ccb/`.

## Protocol and provenance

Codex CLI 0.163.0 ran `gpt-6-luna`; Claude Code 2.1.309 ran
`claude-sonnet-5-5`, default effort. Both arms ran all seven tasks twice per
model, outcome grading, an eight-minute trial deadline, one trial per runner
and at most two trials concurrently. All **56 primary trials** are retained;
there are no discarded, rerun, regraded or corrected outcomes, infrastructure
errors or grader changes. The fake credential values are random UUIDs, with
no provider/resource vocabulary. Transcript audit finds no unexpected public
name redaction: AFTER's only 28 `[redacted]` occurrences are the literal
Withheld-values guide sentence, once per trial. BEFORE has none.

| Arm | Clean commit | Source tree | Raw files |
| --- | --- | --- | --- |
| BEFORE | `b5bce7b4c872` | `47e358cc24de` | `before-luna.json`, `before-sonnet.json` |
| AFTER | `76d65c5bbbe5` | `e06f0b3a1da7` | `after-luna.json`, `after-sonnet.json` |

BEFORE is main `9e3fbbfb` plus eval-only changes; its production source tree is
identical to that main. AFTER includes the merge of Overflow #991 at
`b98635ef`, as required to reuse its opt-in exact-total extension from
`ab707ee4`. Both task inventories remain present. Global task/harness hashes
therefore differ; no equality of those global hashes is claimed. CCB's task
and fake files are byte-identical across arms:

- Task SHA-256: `137a6eee4956fea1a364d95af8fc59146de2321ba06963027dcafa755883d8db`.
- Fake SHA-256: `7b882693701adc0bedf372f49976152e8c73a9bc7def336ba4473d64cf62a8c7`.

The merge adds Overflow's unrelated eval wiring; it changes no CCB prompt,
state, HTTP fake, grader or expected answer. The `reads-only` classifier uses
the running tree's `REST_TOOL_KINDS` catalog. Offline BEFORE regrades must
therefore run in the BEFORE tree, and AFTER regrades in the AFTER tree.
Regrading BEFORE under HEAD instead flips all four campus-hatch passes because
`ccb_api_get` no longer exists there; arm-native regrades reproduce all 56
recorded outcomes. This catalog dependence is separate from grader-code identity.
The first five tasks use read-only
endpoints. Selftests pass both six/code surfaces and route/outcome grading,
including no-op, missing-answer and duplicate-write counterexamples. The
post-eval change to a test tuple's `as const` annotation has no runtime effect.

## Tasks and outcomes

The filtered read counts active campus-1 individuals while including inactive
source rows. The join resolves family 9 and Choir group 5, joining individual
1002 to its leader role. Paging counts all 137 people across vendor pages.
Advanced POST search counts 28 inactive people. The rare campus lookup requires
the North name, America/Chicago timezone and exact public gift message. Each
write task resolves Alice Rowan, changes only her email through PUT, verifies
the stored profile and allows exactly one HTTP mutation. Recovery commits the
update before returning HTTP 500; reading the target must establish success.

| Task | Luna BEFORE | Luna AFTER | Sonnet BEFORE | Sonnet AFTER |
| --- | ---: | ---: | ---: | ---: |
| Filtered individuals | 2/2 | 2/2 | 2/2 | 2/2 |
| Family/group join | 2/2 | 2/2 | 2/2 | 2/2 |
| Individual paging | 1/2 | 2/2 | 2/2 | 2/2 |
| Advanced search | 2/2 | 2/2 | 2/2 | 2/2 |
| Rare campus hatch | 2/2 | 2/2 | 2/2 | 2/2 |
| Update once | 1/2 | 1/2 | 0/2 | 2/2 |
| Failed-response recovery | 1/2 | 1/2 | 1/2 | 2/2 |
| **Total** | **11/14** | **12/14** | **11/14** | **14/14** |

Combined outcomes improve **22/28 → 26/28** in this small, correlated set.
Luna's two AFTER failures send no writes. Update-once repeat 1 selects
`fields: ["status", "data"]` as vendor-body fields; the hatch refuses before
dispatch, and Luna stops. Recovery repeat 1 discovers the write hatch but
stops for approval already supplied by the task, without attempting a write.
This trial saw both the CCB-local “reads plus approval-gated writes” line
and shared “every call ... needs approval” / “stated for approval” text.
The harness auto-approves, and no write call or host approval request occurred.
BEFORE had the same local line and stronger “always needs approval” text, yet
Luna attempted writes in all four BEFORE write trials. These observations do
not isolate the cause of the deferral. Both repeat-2 writes succeed and reconcile. Sonnet
passes all AFTER tasks. All six dispatched AFTER mutations occur once and
are read back; no other business state changes.

BEFORE Luna's two failed writes guess PATCH and do not perform the requested
PUT. Its paging repeat 2 omits inactive people and reports 109 rather than
137. Its initial malformed `call_tool` omitted the address, so that trial also
fails `reads-only` despite dispatching no write. BEFORE Sonnet's three failures first send unsupported PATCH, then PUT:
the business update occurs once and is verified, but two HTTP mutation
attempts correctly fail the frozen exactly-once condition. No identical
HTTP write is duplicated in either arm. These failures remain in the scores.

| Mean per trial | Luna BEFORE → AFTER | Sonnet BEFORE → AFTER |
| --- | ---: | ---: |
| MCP calls | 4.64 → 5.07 | 4.29 → 4.50 |
| Observed discovery bytes | 26,586 → 31,558 | 14,802 → 14,337 |
| Wall time | 15.65 s → 14.82 s | 10.55 s → 11.48 s |

The table preserves the original address-based discovery-byte calculation:
it counts serialized search/describe/guide and `_api_search`/details results,
including guest calls, without tokenization. That rule mistakenly includes
BEFORE's old data `ccb_api_search` (four calls across both models), while
excluding AFTER's data-search counterparts. With operation discovery only,
Luna is **25,895.86 → 31,558 B (+21.9%)**, and Sonnet is
**14,118.43 → 14,336.79 B (+1.5%)**. The table's apparent Sonnet decrease is
an artifact of the old definition. Raw transcripts, recorded metrics and
scores are unchanged. Accuracy improves here, while call counts increase. No general
accuracy or efficiency gain is claimed. One Luna `individual update` search
places the intended PUT fifth under the shared exact-path-word ranking, then
finds it with `updateIndividual`; a template query also falls through to
field matches. These shared search limitations are disclosed, not solved by
changing core search. CCB's tested natural email-edit phrasings rank the
intended PUT first/two; catalog searches find read/write hatches through the
new domain notes.

## Tool retention and removal

Writable catalog **27 → 20**; configured read-only scopes omit the write hatch
(**26 → 19**). Counts below include actual direct and guest calls, including
caught or refused calls, in all 28 BEFORE trials.

| Decision | Tools and reason |
| --- | --- |
| Observed reads retained | `list_individuals` 24 calls; `list_families`, `list_groups`, `get_family`, `list_group_members` 4 each; `get_individual` 11. These support people resolution, stable-id joins, paging and reconciliation |
| Retained workflow choices, unobserved | `get_me` for grant identity; `get_group`/`list_individual_groups` for bidirectional membership; `list_events`/`get_event`/`get_event_attendance`/`list_event_attendees` for series/occurrence identity and attendance projection; `list_individual_notes` for sharing/context and pastoral projection; `get_giving_metrics` for counts, exclusive target and 12-month bound. These are explicit domain judgments, not measured eval wins |
| Renamed | `ccb_api_get` → `ccb_api_read` (4 BEFORE calls); old data `ccb_api_search` → `search_records` (4); `ccb_api_mutate` → `ccb_api_write` (11). Add offline `ccb_api_search`/`ccb_api_details` |
| Removed, zero BEFORE uses each | `list_forms`, `list_form_responses`, `list_processes`, `list_queues`, `list_queue_individuals`, `list_scheduling_categories`, `list_schedules`, `list_individual_assignments`, `list_individual_pledges`; indexed reads cover their resources. The pin exposes unsupported wildcard GET-body filters for categories/assignments, disclosed in migration notes |

The named advanced search retains all 15 domains as compact common record
summaries, with projected counts for schedule totals; indexed reads expose
domain-specific vendor fields. The [migration contract](../../documentation/provider-migration-0.35.md#church-community-builder)
lists every retired argument/name, path and output change. Private file,
calendar, payment and OAuth values remain permanently withheld, even with
`sensitiveFields: "return"` or `fields`. No named write or in-band write
failure hook was removed.

## Verification and accounting

- `check:static` and `check:build` pass. The build checks declarations and all
  bundle caps. No full local `pnpm run check` ran, per load policy.
- Initial focused Node suites: 654 passing in ten files. Post-merge shared
  kit/provider/conventions: 157 passing. Final CCB/safety/failure-sweep/standard/
  conventions: 576 passing. Cross-provider contracts, OAuth,
  write evidence/provenance, sent-secret boundary, drift and hatch: 231 passing.
- All-provider Node goldens with `CONNECTA_GOLDENS_DETERMINISM=1`: 85 passing
  (16 provider captures plus 69 harness/source-probe cases). Forward/reverse,
  repeat and jitter checks pass; only CCB golden bytes differ from merged main.
- workerd canonical goldens and the selected native hatch check: 17 passing,
  2 intentionally skipped.
- Browser: 20/20. Node 24 Eve typecheck, 5 tests, build and isolated runtime/type
  package smoke: pass. Audit is unselected by CI paths; dependencies are unchanged.
- CCB's verified pin and all 385 endpoint contract digests report no drift.
  Original bare-URL 403 is resolved by the official download query; no live
  church account, credential or mutation was used.
- Collected affected Vitest cases **619 → 611, delta −8** against merged main
  `b98635ef`: failure sweep 499→485, authenticated safety +6; provider 13,
  http-kit 83, http-hatch 3 and generation 21 unchanged. Added assertions fold
  into existing rows. Full collection was stopped; these complete affected
  suites establish the delta, without claiming full INV/spec enforcement.

Golden changes by category: **names** replace the two legacy call hatches,
repurpose operation search and replace nine wrapper fixtures with indexed reads;
**schemas** add offline contracts, enum limits, fields, signed cursors, totals
and compact advanced summaries while dropping raw/page/perPage;
**envelopes** use items/page and status/data, retaining safe pagination headers;
**errors** replace unproven 409 conflict with generic failure and complete
sentences; **guide** uses domain-only G content plus generated Conventions,
configured scope/privacy context and provider vocabulary in hatch notes.

H14 canonical indexed path confinement is folded, including percent/double
encoding, semicolons, OAuth and traversal refusals. H5 uses the merged
incomplete-body cause to distinguish broken reads from complete non-JSON.
H9 is characterization only: three fresh Node 26.12.0 processes importing the
built provider measured import **1.25–1.42 s**, factory **71–140 ms**, and
direct call-to-first owned-transport send **38–41 ms**, after fake OAuth setup.
These loaded-host observations establish no SLA and change no deadline policy.
Other H items stay with their owning core/other-provider work.

Same esbuild options, Node 26.12.0 and zlib-ng 1.3.1: standalone CCB gzip
**344,995 → 388,662 B (+43,667 B)**. A clean merged-main `b98635ef` measurement
also gives 344,995 B, so this delta belongs to CCB/shared opt-ins. Growth pays
for the verified 385-operation request/response index and its explicit safety
review. The recorded historical CI baseline is 328,952 B, a different toolchain
snapshot; its printed delta is +59,710 B. Provider entries are uncapped and
non-additive because Effect is paid once; composite caps pass without changes.


## Planning Center merge and confirmation wording follow-up

Merge commit `05c0f5016a684ece9883371bf5d281ec23b5fd55` combines the prior
CCB head `6e4addc5` with main `ce0c7492` (Planning Center #992). Compared with
Git's preserved `AUTO_MERGE` tree
`51e22744553bfb1bc753103014ddf892b3664d11`, the merge changes exactly the nine
conflicted files: migration notes, saved eval state, eval deployment and tool
wiring, fake worlds, task inventory, failure sweep, pending baseline and
provider-standard pending set. Both providers' tasks/state/wiring remain;
both providers are absent from `PENDING.step2`. Planning Center's bundle
entry, provider and golden bytes are retained from main.

The subsequent CCB-only wording change replaces the local “approval-gated”
label with “reads and writes.” The source guide and write-tool note name
`ccb_api_write` and say the host may ask the user to confirm. The shared
generated Conventions sentence belongs to still-unmerged #998; this change
does not copy that PR's shared changes or assert that it has merged.
The `ffd64b04` local rewording is unevaluated; it cannot be claimed to fix
the deferral or to establish that the shared text alone caused it.
No model trials were rerun for this follow-up; the complete original 56-trial
record and its frozen source stamps above remain unchanged.

The post-merge CCB/safety/failure-sweep/standards/conventions/generation/hatch
run passes 558 cases, including the current 443-case failure sweep. No case
is added or removed by this follow-up. The generated CCB bundle baseline is
refreshed from the post-merge `check:build` output (388,923 B gzip); Planning
Center's 635,569 B baseline and all caps remain intact. The baseline is a
measured snapshot; changing the declaration's own metadata can slightly
change its standalone compressed size.

Merge audit, requested golden reruns, static/build logs and final build
measurements are under the same scratch directory with `wording-` prefixes.

The final post-merge build reports CCB at **388,892 B gzip**. Static/build
and the all-provider deterministic Node golden/harness run (85 cases) pass.
Workerd canonical goldens and the native hatch case also pass: 17 passing,
2 intentional Node-case skips.
Only CCB's generated bundle entry/note changes; all other bundle entries,
notes and caps compare identically with the automatic merge.


## Round-1 corrections

The generator's CCB-only `emptyObjectsOpen` option admits vendor-defined search
filter keys, with dispatch assertions for both `search_records` and POST
`ccb_api_read`. All thirteen reviewed modeled JSON wildcard writes (twelve objects and one
array, including bulk group removal and saved-search creation/update) are admitted
as JSON; real multipart uploads remain refused before dispatch. Named output
schemas now include every emitted individual/group key. Natural operation and
catalog queries cover attendance, group membership/roles, phone edits, new
individuals, donations and contributions. These assertions fold into existing
cases; the frozen model trials and raw scores remain unchanged.

The recorded bundle baseline is now **389,649 B gzip**, from [CI static run
`40080865116`](https://github.com/zackbart/connecta/actions/runs/40080865116/job/120833959810) at `ffd64b04` on Node 22.23.3. Its main base `ce0c7492` measured
**345,272 B**, so that CI comparison is **+44,377 B**. This supersedes the local
Node 26 snapshot as the declared baseline; the historical measurements above
retain their original commits and toolchains. Provider entries remain uncapped
and non-additive, and no composite cap changes.

The shared integer path-parameter validation follow-up is
[#1002](https://github.com/zackbart/connecta/issues/1002); this fix round makes
no shared path-validation change.

Fresh round-1 checks pass 651 cases in nine targeted files, including the
443-case failure sweep. Static checks (including generated-provider freshness)
and build/declarations/all bundle caps pass. The fresh Node 26.12.0/zlib-ng
build measures CCB at **389,200 B gzip**; this remains separate from the cited
CI baseline. Strict provider checks find no drift across 385 endpoints.
Other providers' 42 golden JSON files and five operation indexes are byte-identical
to both `ffd64b04` and merged main `ce0c7492`.

All-provider deterministic Node goldens and harness/source probes pass **85
cases**. Workerd canonical goldens plus the native hatch pass **17 cases**,
with two intentional Node-only skips. This round adds/removes no test cases
(delta 0); the PR's overall affected-case delta remains **−8**. Round-1 logs
and the byte audit use the `r1-` prefix in the scratch evidence directory.


## Final-review corrections

Three additional wildcard-labelled request bodies now use JSON: bulk group
removal (`PUT /individuals/{id}/groups/bulk`, an array) and saved-search
creation/update (`POST /search/save`, `PUT /search/save/{id}`, objects).
There are thirteen reviewed wildcard JSON writes, twelve objects and one array.
The verdict counts remain 197 read / 174 destructive / 14 refuse because these
three already had destructive verdicts. Every body sends once as JSON; unknown
keys and the unsupported bulk action `ADD` remain refused before dispatch.
`search_records` now refuses whole withheld markers and withheld links in its
body before sending, matching POST-search hatch behavior. A mixed validation
message describes invalid `limit` once and retains the other argument issues.
No test cases or model trials are added or removed. Main is not merged in this
fix; shared wording regeneration remains pending the orchestrator's request.

Fresh final-fix verification passes 651 targeted cases in nine files, including
the 443-case failure sweep. All-provider deterministic Node goldens/harness
pass 85 cases; workerd canonical goldens/native hatch pass 17 with two
intentional Node-only skips. Static/generated checks, strict CCB drift checking
and build/declarations/all bundle caps pass. The local Node 26.12.0/zlib-ng
CCB bundle is **389,282 B gzip**; the cited CI baseline remains 389,649 B.
Other providers' 42 golden JSON files and five operation indexes remain
byte-identical to `93ba5381` and merged main `ce0c7492`. Evidence uses the
`r2-` prefix in the same scratch directory. No full local check was run.
