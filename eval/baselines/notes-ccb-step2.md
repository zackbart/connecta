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
state, HTTP fake, grader or expected answer. The first five tasks use read-only
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
The latter is the shared approval-wording observation from #991, not a new
permission requirement. Both repeat-2 writes succeed and reconcile. Sonnet
passes all AFTER tasks. All six dispatched AFTER mutations occur once and
are read back; no other business state changes.

BEFORE Luna's two failed writes guess PATCH and do not perform the requested
PUT. Its paging repeat 2 omits inactive people and reports 109 rather than
137. BEFORE Sonnet's three failures first send unsupported PATCH, then PUT:
the business update occurs once and is verified, but two HTTP mutation
attempts correctly fail the frozen exactly-once condition. No identical
HTTP write is duplicated in either arm. These failures remain in the scores.

| Mean per trial | Luna BEFORE → AFTER | Sonnet BEFORE → AFTER |
| --- | ---: | ---: |
| MCP calls | 4.64 → 5.07 | 4.29 → 4.50 |
| Observed discovery bytes | 26,586 → 31,558 | 14,802 → 14,337 |
| Wall time | 15.65 s → 14.82 s | 10.55 s → 11.48 s |

Discovery bytes sum serialized observed search/describe/guide and operation
search/details results, including guest calls; they are not tokenized model
context. Accuracy improves here, while call counts increase. No general
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
