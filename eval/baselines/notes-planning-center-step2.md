# Planning Center step 2 paired evaluation

Decision 0011 step 2 / decision 0014, #703. Measured 2026-10-24 on bigserv,
Linux x64. These seven builder-authored tasks support a workflow choice; two
repeats per model are not production traffic or a general curation benchmark.

## Result and limits

The final paired batches score **GPT-6-Luna 11/14 → 12/14** and
**Claude Sonnet 5.5 14/14 → 14/14**, or 25/28 → 26/28 overall. The filtered
read regresses on the frozen strict answer check, while merger history improves.
Luna's two AFTER filtered answers contain every correct id and the correct
count, 73. Their source label is `Planning Center People`, outside the frozen
normalizer (`pco`, `Planning Center` or `Planning.Center`). They remain failures.

The final Luna BEFORE misses are: one merger workflow with no HTTP evidence
following a QuickJS startup failure and unsuccessful discovery; one otherwise
correct filtered answer labelled `pco Planning Center`; and one otherwise
correct merger answer with numeric ids instead of strings. The startup error
is `QuickJS child did not become ready within 10000ms`. Final BEFORE contains
two concurrent startup timeouts on merger repeat 1: Luna fails, while Sonnet
recovers and passes. Both remain in the evidence and error totals, with no
deadline change or selective retry. This asymmetry prevents attributing the
full score delta to the provider surface. The original BEFORE also varied materially on
the join task, which reinforces the small-sample limitation.

| Task | Luna BEFORE | Luna AFTER | Sonnet BEFORE | Sonnet AFTER |
| --- | ---: | ---: | ---: | ---: |
| Filtered People profiles | 1/2 | 0/2 | 2/2 | 2/2 |
| Groups → People → future Services schedules | 2/2 | 2/2 | 2/2 | 2/2 |
| Service type → plan → items/team identities | 2/2 | 2/2 | 2/2 | 2/2 |
| All 137 People profiles, 100 per page | 2/2 | 2/2 | 2/2 | 2/2 |
| Merger history through coverage hatch | 0/2 | 2/2 | 2/2 | 2/2 |
| Exactly one categorized profile note | 2/2 | 2/2 | 2/2 | 2/2 |
| Reconcile a profile update committed before HTTP 500 | 2/2 | 2/2 | 2/2 | 2/2 |
| Total | 11/14 | 12/14 | 14/14 | 14/14 |

The grader checks the HTTP ledger, exact requested state, the final structured
answer, read-only attempts and duplicate writes. Server-side filtering is an
advisory efficiency check. No tool name is required for the joins; merger history
requires its stated coverage read. Both writes execute exactly once; recovery
requires a later read. Both models pass every AFTER write/recovery trial.

## Provenance and corrections

The [JSON summary](./planning-center-step2.json) preserves every scored trial's
checks, answer, metrics, tool addresses, HTTP ledger and model evidence. It also
records run configuration, clean git provenance, protocol hashes and SHA-256
of each full unmodified result file. Full traces remain under
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/planning-center/`.

- Original BEFORE: clean `eee4b8555721`, source tree `f1122bdcb2cc`, based on
  main `8e92eed9` (#989). Luna 10/14 and Sonnet 14/14. It ran before the provider
  surface changed, and is retained as `diagnostic-before`, without regrading.
- Final BEFORE: clean `67abfb2d9dda`, source tree **the same** `f1122bdcb2cc`.
  Only the final eval harness was copied to the isolated old-provider worktree.
- Final AFTER: clean `0db499dd4097`, source tree `ac4de5bfefc4`.
- Final pair id: `planning-center-step2-final-2026-10-24`.
- Final task hash: `7544ae2a83fa1cdef8015840bd0d183e3f4ffa54210ccbd61e54cff70fbddac7`.
- Final harness hash: `615cfa45cab05e9ba6f2ce6bafc0ab0007536c0de1a24e2cb10506543dc8a2c6`.

Those final hashes match across all four final batches. Codex CLI 0.163.0 served
`gpt-6-luna`; Claude Code 2.1.309 served `claude-sonnet-5-5`. Both used Node
22.23.3, the six-meta-tool surface, outcome grading, default model effort,
eight-minute trial limits, two repeats and concurrency one per runner (at most
two globally active scored trials). Tools/skills/plugins were isolated by the
existing runners; requested/served models and inventories are in the evidence.

The orchestrator approved stacking on Stripe #990 at
`49b21b02551134afd6a9f83b276ee9e71d4b8667` for its shared binding and H5 opt-in.
Its additional eval files changed the global harness hashes. Before final live
runs, the scripted **standard-surface paging reference only** was corrected to
select ids: a 100-person inline result hid its cursor. No prompt, seed, fake
behavior or grader was changed. Unused fake-helper exports were also made
private. The complete BEFORE batches were then rerun using that identical final
harness. There are 56 final scored trials plus 28 original diagnostic trials;
no measured trial was discarded or selectively rerun.

Positive references and independent negative controls cover fabricated facts,
no HTTP evidence, the wrong source, a missing page/second leader, attempted
writes on read tasks, duplicate writes and missing reconciliation. The full
selftest exercised six/code presentations and route/outcome modes. Under heavy
concurrent host load, exploratory code-arm references and two five-second hatch
tests hit timeouts. Their isolated reruns passed unchanged; the scored six-arm
runs retain both startup failures described above. The paging-reference
failure was corrected before the final measured pair, without score changes.

## Calls, metadata and tokens

All rows aggregate 14 trials, including failed trials. HTTP counts come from
the fake ledger. Tool errors include the intentionally injected update failure.
Discovery bytes are minified UTF-8 JSON of captured `search`/`describe`/`skill`
results and indexed search/details results, counted once per program or direct
MCP call. This measures metadata retrieved, not necessarily the smaller value
a program returns to the model. The generic discovery/guide figures are not
the indexed hatch's per-response budget.

| Metric | Luna BEFORE | Luna AFTER | Sonnet BEFORE | Sonnet AFTER |
| --- | ---: | ---: | ---: | ---: |
| MCP calls | 55 | 56 | 60 | 59 |
| HTTP calls | 48 | 47 | 51 | 54 |
| Tool errors | 5 | 4 | 6 | 5 |
| Maximum discovery result, B | 19,334 | 22,278 | 35,116 | 19,103 |
| Cumulative discovery results, B | 275,063 | 380,317 | 189,552 | 188,720 |
| Input tokens (runner's uncached field) | 257,115 | 282,720 | 142 | 144 |
| Output tokens | 6,512 | 6,976 | 11,448 | 10,810 |
| Cache-read tokens | 883,200 | 1,041,280 | 475,500 | 474,536 |
| Cache-creation tokens | 0 | 0 | 102,177 | 102,769 |
| Median trial wall time, ms | 20,114 | 16,862.5 | 18,185 | 13,708.5 |

Token fields are runner-reported and should be compared within one model.
Luna retrieves more metadata and uses more input tokens AFTER: it fetches the
guide 14 times via programs versus seven BEFORE, and searches more often.
The guide itself grows from roughly 4.9 to 7.1 KB with maintained domain advice
and generated Conventions. Sonnet's cumulative discovery bytes are nearly flat.
The smaller catalog therefore does not establish a universal context-cost win.

AFTER recorded one indexed metadata-search result (567 B); the other hatch
workflows used known paths from guidance. Provider regressions separately pin
natural-query ranking (`person mergers`, `note categories`, `song arrangements`,
`group memberships`), at most eight hits / 16 KiB, 32 KiB details, and lossless
continuation of the largest 67-KB request contract. All 1,753 operations are
indexed across the ten product documents; 1,479 declare response fields.

## Curated surface and retention guard

The catalog changes from **48 to 27 tools**: 23 curated names and four hatches,
`pco_api_search`, `pco_api_details`, `pco_api_read`, `pco_api_write`. The `pco`
prefix is retained. Every proposed removed name was checked against successful
workflows in both original and final BEFORE batches; **none was used**. Failed
write calls used by successful reconciliation workflows count as usage too.

| Retained tool | Workflow reason |
| --- | --- |
| `get_me` | Token identity and organization context |
| `search_people` | Filtered identity resolution and People iteration; observed |
| `get_person` | Contact/identity join and reconciliation; observed |
| `create_person` | Common profile creation with a bounded projection |
| `update_person` | Sparse profile changes and reconciliation; observed |
| `list_workflows` | Discover staff follow-up pipelines |
| `list_workflow_cards` | Resolve work queues with person/step joins |
| `add_workflow_card` | Enroll a person in an existing follow-up workflow |
| `apply_workflow_card_action` | One reviewed workflow transition, acknowledgement only |
| `list_person_notes` | Pastoral follow-up context with categories |
| `add_person_note` | Exactly one categorized profile note; observed |
| `list_person_field_data` | Resolve an organization's custom identity fields |
| `list_service_types` | Resolve the recurring service before plan joins; observed |
| `list_plans` | Resolve the requested service date/title; observed |
| `get_plan` | Bounded items/team/time join and seconds-to-minutes reasoning; observed |
| `list_teams` | Resolve service team/position choices for scheduling |
| `list_person_schedules` | People/Groups → future Services joins; observed |
| `schedule_plan_person` | Schedule one person into a plan/team position |
| `list_groups` | Resolve a group while rejecting similarly named decoys; observed |
| `list_group_memberships` | Join leaders/member identities; observed |
| `add_group_member` | Enroll a known person in a known group |
| `list_donations` | Person/fund/designation financial joins in cents |
| `list_funds` | Resolve the organization's fund identities |

The unobserved retained tools are approved workflow judgments, not measured
wins. The 23 retired convenience wrappers are shallow, less common coverage
served by the full index; their complete method/path/filter/body mappings are
in [the migration](../../documentation/provider-migration-0.35.md#planning-center).
This includes additive wrappers moving to the destructive approval-gated hatch.

## Contracts, cost and handoff

Named lists use `items/page`, `limit`, signed cursors and fields. `get_plan`
flattens its plan properties and reports `truncated` paths. Workflow-action
acknowledgements return `{ok:true}`. The hatch retains JSON:API under `data`,
with an indexed request contract and reviewed response fields. Raw/version
arguments are removed. Credentials, private feed codes/download destinations
and opaque webhook payload/header/body values remain unavailable without a
nominal `sensitiveFields` return option.

The ten pins, literal 1,124-read / 628-destructive / one-refused policy, 143
candidate-operation safety reviews, error meanings and ambiguous source route
are documented in
[the contributor review](../../src/providers/planning-center/evidence/review.md).
The multi-document compiler change is its own commit, `1dc5141e`, reusing
`buildOperationIndex` with actual child URLs and exact saved-byte pins.

The orchestrator amended H9 to allow one isolated shared fix, based on main:
`fb717c715db6cd9f9f3d396b67e5144b44890de3`. It caches first-match operation-key
lookups per index, preserving validation errors/order. Stripe can take that
commit. The merge retained both its lookup change and Stripe's binding/page
adapter seam. No request or test time budget was raised.

Three fresh Node 22 processes measured PCO cold construction at 665.7 ms median
before the lookup fix (665.7–676.7 ms), then 316.5 ms (282.1–330.6 ms). With the
old provider it was 229.7 ms median (224.2–506.6 ms). The final indexed snapshot
imports in 4.19–4.86 s and makes its first owned-fake call in 165–196 ms.
These are shared-host observations with warm OS/toolchain caches; the fake
transport excludes network latency. No deployment deadline conclusion follows.
Raw cold observations are preserved beside the full eval results.

Before updating the metadata baseline, the PCO entry measured **635,569 B gzip**,
versus **349,553 B** on the same runtime/system zlib at main `8e92eed9`:
**+286,016 B**. It includes the full ten-product index and shared Effect kit,
which a deployment pays once; provider entries are reported, not capped. No
bundle cap moved. The final bundle report can differ slightly after recording
that baseline text; the review uses the measured comparison above.
The final report confirms **635,566 B**, three bytes below that baseline
(**+286,013 B** against the same BEFORE entry); every cap passes.

H5 uses Stripe's unchanged `bodyFailures` opt-in, with distinct incomplete-read
and malformed-JSON wording and no status-only overrides. People's documented
duplicate 409 becomes `conflict`; 404 retains declared `not_found` / absence
meaning. H1–H4, H6–H8 and H10–H14 do not establish a PCO-specific change here.
`page.total` is deliberately omitted until Overflow's generic opt-in extension
lands; the hatch retains exact vendor `meta.total_count`. Reuse that extension
in a small follow-up instead of adding a competing implementation.

The public drift check found no changes across the 1,753 pinned contracts. It
reports a newer People publication, 2026-10-05; the approved 2026-06-04 pin was
retained. The orchestrator owns the independent Opus review, CI monitoring,
retargeting from `t3/stripe-step2` to main, and merge. No deployment or publishing
is part of this work.

## Validation and golden changes

All 15 providers passed Node goldens with
`CONNECTA_GOLDENS_DETERMINISM=1` (forward/reverse captures, identical repeat,
jitter seeds and source-probe matrix), and all 15 passed their canonical
workerd captures. Both runs include the inventory check: 16 passing tests
each. Planning Center took 107.5 s in Node determinism and 9.3 s on workerd;
the existing 120 s / 60 s budgets are unchanged. All other providers' stored
goldens are byte-identical to main, allowing only the inherited Stripe #990
layer. Stripe's stored goldens match its branch exactly.

Planning Center's golden differences cover five categories:

- Names: retire the 23 shallow wrappers, rename the two call hatches and add
  indexed search/details; the curated set is 23 names, 27 tools total.
- Schemas: standard fields, bounded limit/signed cursor, indexed path/query/body
  admission; remove raw, version, perPage and offset intake on named tools.
- Envelopes: items/page, omitted terminal cursors and named totals, flattened
  plan, truncation paths, acknowledgement-only workflow actions and safe
  JSON:API hatch envelopes.
- Errors: product-scoped People duplicate conflict, declared absence meaning,
  kit status fallbacks and opt-in incomplete-body / malformed-JSON wording.
- Guide: maintained cross-product workflow advice, pin/exclusion context and
  generated Conventions.

The isolated compiler/generation/standard suites, provider failure sweep,
HTTP kit and hatch checks passed. `check:static` and `check:build` passed;
the browser suite passed 20 cases, and the Node 24 Eve check and packed-consumer
smoke passed. Public drift checking used the saved ten-document evidence
without changing the pins. No root `pnpm run check` was run under the load
policy. Logs are beside the raw eval artifacts.

The collected test-count change attributable to this step is **−42**:
Planning Center failure-sweep cases shrink from 98 to 56 when its catalog
shrinks from 48 to 27 tools. Compiler, hatch and provider assertions are folded
into existing cases; the provider suite retains eight default-five-second
cases. The earlier large regression case was split across those eight cases
without increasing their count or time budgets.
All eight passed in the final isolated run; the slowest took 2.49 s. An
intermediate redistribution still exceeded five seconds and its unfinished
calls affected the next case; catalog and header checks were then moved to
the lighter existing cases. No production behavior changed after the frozen
AFTER snapshot.

## Round-1 fixes

The 2026-10-24 Opus review requested changes at `07777ab94762`. The fix round
replaces the stale email/phone tool names and GET-only custom-field write
guidance with real indexed methods/paths. Publishing signed-download generation
and Webhooks signing-key rotation are refused before transport, with reasons;
the receiving system cannot use a credential this connection permanently
withholds. Migration notes also disclose success on empty 2xx replies for the
removed additive write wrappers.

The source documents still contain 1,753 operations. Exactly one empty-path
People composition artifact is now omitted, leaving **1,752 indexed operations**
with 1,124 read / 626 destructive / two refused verdicts. Provider-local reviewed
summaries and a singular-person profile scope make the requested volunteer,
group-leader, custom-field, order-of-service and person queries find their
roots without changing shared ranking. The existing ranking test covers all
seven requested natural phrasings, including queries without a method filter.

PCO alone opts into optional compiled numeric bounds. All 560 `per_page`
contracts retain integer 1–100, including intersection of composed constraints;
malformed, fractional and out-of-range values fail before dispatch. Existing
indexes without the opt-in keep their current validation. The review probes
were replayed against the real factory with its fake transport: all four
signed-link formats and both rotation probes send nothing, all six original
invalid page sizes send nothing, and all 560 schemas have the exact bounds.

Agent-facing descriptions and discovery text changed materially, so this round
ran an AFTER-only follow-up of all seven tasks, both required models and two
repeats per task. The original paired results above remain frozen. Excluded
named-tool pointers and lossless shared-index compaction are deferred by the
orchestrator; neither is implemented in this round.

Stripe's follow-up `38de8fbf5f86` is merged before the new AFTER snapshot. Its
shared binding guards remain enabled. PCO drops its duplicate other-server
check and keeps JSON-only body admission plus the two credential-action
refusals. No shared seam or ranking change is authored by this fix round.
Stripe's plural-refund task/fake updates also move the global protocol hashes;
the seven PCO prompts, graders and fake behavior are unchanged. This is an
AFTER-only follow-up, rather than a newly paired BEFORE/AFTER experiment.


### AFTER-only follow-up result

The clean snapshot is `37faf86bd93f`, source tree `bdecfc375823`, after the
Stripe merge. Both runners used Node 22.23.3, the same CLI/model versions and
six/outcome settings as before, two repeats, eight-minute limits, and one
active trial per runner (at most two globally). The pair-window id is
`planning-center-step2-r1-2026-10-24`; both files agree on:

- Task hash: `ad9aaf9ad07de3f45d58a4938a065f7e788cd2f6fa5b1bd0691d05f173371373`.
- Harness hash: `4dd487f0c591e61405e9dc665d0379a211155cee31a169a2be95451a255d895c`.

All 28 new trials are retained in the JSON as `after-r1`, alongside the original
84. No prompt, grader, PCO fake behavior, deadline or score was changed and no
trial was selectively rerun. Both models pass all write/recovery checks, and
no executor startup failure occurred in this follow-up.

| Task | Luna AFTER R1 | Sonnet AFTER R1 |
| --- | ---: | ---: |
| Filtered People profiles | 2/2 | 2/2 |
| Groups → People → Services schedules | 2/2 | 2/2 |
| Plan/items/team join | 2/2 | 2/2 |
| All 137 profiles, count ids divisible by seven | 1/2 | 2/2 |
| Merger history through coverage hatch | 1/2 | 2/2 |
| Exactly one categorized note | 2/2 | 2/2 |
| Reconcile update committed before HTTP 500 | 2/2 | 2/2 |
| Total | 12/14 | 14/14 |

The totals equal the original AFTER (12/14 and 14/14), with different Luna
answer-format failures. Paging repeat 1 reads both pages at offsets 0/100,
processes all 137 profiles and correctly computes 20 ids divisible by seven;
its source label `Planning Center People` fails the frozen source normalizer.
Merger repeat 2 reads the correct history and surviving profile, but returns
numeric ids 2999/1001 instead of the required strings. Both remain failures.
The global hashes differ from the original pair because of Stripe's task/fake
changes, so these follow-up figures do not establish a new paired improvement.

| Metric (14 trials per runner) | Luna R1 | Sonnet R1 |
| --- | ---: | ---: |
| MCP calls | 78 | 58 |
| HTTP calls | 49 | 52 |
| Tool errors | 8 | 5 |
| Maximum discovery result, B | 40,420 | 11,503 |
| Cumulative discovery results, B | 498,261 | 185,024 |
| Uncached input tokens | 294,958 | 140 |
| Output tokens | 8,347 | 10,824 |
| Cache-read tokens | 1,520,000 | 445,291 |
| Cache-creation tokens | 0 | 100,483 |
| Median trial wall time, ms | 18,116.5 | 12,773.5 |

Luna retrieves more metadata than in the original AFTER: 33 program searches,
three indexed searches and three indexed details calls. Its largest result is
a generic `connecta.search` response, not a hatch budget breach. The indexed
search maximum is 1,859 B and details maximum is 32,642 B, within 16/32 KiB.
Sonnet uses known hatch paths without retrieving indexed metadata. The local
natural-phrasing regression checks improve discovery coverage; this rerun
provides no universal context-cost or task-success gain.

After freezing these runs, only evidence and bundle-report metadata change.
The bundle note records the review's index/repeated-filter attribution and the
orchestrator's deferred compaction work. No cap or request/test budget moves.


### Verification after the main squash merge

#990 squash-merged as `9e3fbbfb745b392dac506fff7a53cf4ae2d1529a`.
#992 now targets main; merge `e5fc4d2b5189fef68ea818f601d921c06913223a`
reconciles its inherited Stripe commits with that squash. The hatch conflict
keeps main's shared guards and `fb717c71`'s lookup cache. All Stripe code,
tasks/fake behavior and goldens, every other provider's source, and all non-PCO
stored goldens match main. The remaining shared compiler/range, evidence,
contract and eval changes support PCO's approved index. No Planning Center
behavior or agent-facing text changed after the frozen AFTER R1 source snapshot,
so the model runs above remain the applicable follow-up.

Post-merge checks on Node 22.23.3, with `VITEST_MAX_WORKERS=2`, all pass:

| Check | Result |
| --- | --- |
| PCO provider, shared hatch and REST connector | 30/30 |
| Provider generation, run alone | 21/21 |
| Provider standard/conventions, purity and package surface | 107/107 |
| Filtered PCO failure sweep and inventory | 57/57 (56 PCO cases) |
| All-provider Node goldens, `CONNECTA_GOLDENS_DETERMINISM=1` | 16/16; PCO 67.226 s |
| All-provider workerd goldens | 16/16; PCO 8.524 s |
| `check:static` and `check:build` | Pass, including all existing capped entries |
| Browser behavior and visual checks | 20/20, two workers |
| Eve check and packed runtime/type smoke, Node 24 | 5/5 and pass |
| Public `providers:check --provider planning-center` | No pinned drift; existing newer-People-version advisory |

No golden changed during post-merge verification. No case or deadline was added
in round 1: PCO's provider suite stays at eight cases and its existing five-second
budgets; the overall step-2 test delta stays −42. An earlier pre-main combined
run hit one existing generation test's five-second limit. Its complete isolated
rerun passed unchanged, as did the post-main isolated run above; the initial
failure remains in `r1-targeted.log`. This is separate from the two frozen
BEFORE QuickJS startup timeouts.

The final build with system zlib reports **638,026 B gzip** for the PCO entry:
**+288,473 B** against the recorded pre-step-2 349,553 B at `8e92eed9`, and
+2,457 B against the initial step-2 metadata baseline of 635,569 B. The latter
stays explicitly historical. The review's original 635,566 B measurement is
3 B below that metadata baseline; neither measurement is relabelled as this
round's result. Provider entries are report-only and no cap moves. The index's
roughly 263 KB attribution and deferred lossless compaction remain disclosed.

Scratch evidence includes `r1-main-diff-audit.txt`, `r1-main-check-results.json`,
`r1-main-targeted.log` and each `r1-main-<check>.log`. The read-only drift run
again reports People 2026-10-05 published against the retained 2026-06-04 pin;
it does not accept or refresh that version. The full root `pnpm run check` was
not run. The orchestrator owns independent round 2 and CI/merge decisions.


### CI fixture correction after round 1

CI at `b39de42dad4716427d92c5277e8ac3957289f712` exposed five failures in
cross-provider suites omitted from the earlier local selection. These are stale
fixtures, rather than changed transport/redaction behavior:

- Drift coverage supplied an object for every JSON:API response, including
  list reads, and called retired Group-events/Check-Ins wrappers. It now supplies
  arrays for collections and objects for single records/writes, drops the two
  retired wrappers, and requires every request sent by a retained named tool
  to match a manifest row. The old reverse direction is replaced by exact
  full-index ↔ manifest coverage. It also verifies each product-version header.
- Provider evidence discovery assumed every index had one top-level URL and
  digest. It now validates a composition and every actual child URL/digest,
  including exact retained document bytes; single-document checks remain.
- The short-secret output-boundary case called `pco_api_get` twice. Both calls
  use `pco_api_read`, preserving its complete INV-5 assertions.
- Both real-socket hidden-replay controls invoked `pco_api_mutate`, so admission
  stopped at an unknown tool before sending. They now invoke `pco_api_write`,
  preserving POST body/DELETE receipt, non-retryability and unknown-outcome
  assertions under INV-9.

A whole-test-tree audit covers all 25 retired names (23 wrappers/two hatches),
version overrides, query pairs and path forms. No stale positive PCO call remains.
Other removed-name matches belong to CCB/Breeze or intentional catalog-absence
assertions. The only PCO `version` argument is its before-dispatch rejection
control; concrete successful paths and the failure-arguments table use the new
indexed surface. Audit files and the complete suite inventory are retained in
scratch as `ci-pco-audit-report.txt`, `ci-hatch-argument-audit.txt`,
`ci-removed-name-audit.txt` and `ci-pco-suite-inventory.json`.

All five originally failing cases pass in the focused reproduction. Before the
round-2 search correction, all 16 selected Node files passed (880 tests), as did
workerd HTTP kit (13 native cases). The queue was stopped during workerd golden
harness when round 2 arrived, to finish both fixes in one push. These are partial
local selections; the full unfiltered `pnpm run test:node` was not run locally.
No test case is added or removed; every existing title, INV citation and time
budget is retained. The CI repair itself changes tests/evidence only.


### Round-2 discovery correction

The reviewed workflow text replaced generated summaries, losing CRUD verbs and
resource nouns because PCO compiles without operation ids. Retain both: append
`(<generated summary without its Planning Center product suffix>)` to each of
the 19 reviewed summaries. The longest resulting label is 126 characters,
within the hatch's 300-character cap. Four rows folded into the existing
ranking case require `list person mergers`, `create phone number`, `list people`
and `list groups` in the first two results, keeping the natural-phrasing rows
and search/details byte budgets. The real-factory verb probes cover the other
reported regressions with/without method filters and send no HTTP requests.
Only two summary values change in PCO's calls golden; no other stored golden
changes. No shared ranker changes.

The optional bare `person` reorder stays deferred: the shared hatch reorders
index results by literal path after the provider's search, so sorting locally
would not keep profile roots first. Its existing documented filter remains.
The expanded name/argument audit also covers `src/providers/*` and `eval/`.
Its remaining PCO legacy hatch is the deliberately frozen BEFORE reference
branch, plus retained BEFORE transcripts and migration narrative; none is a
current-surface positive call.

The production summary correction is validated separately from the completed
CI-fixture selection above. Final checks and a fresh AFTER-only follow-up will
be recorded below; prompts, graders, PCO fake behavior and deadlines stay fixed.


### Final AFTER-only result

The final summary fix is frozen at clean commit `30fb1f4b632d`, source tree
`49154fca9f95`. Both required models rerun all seven unchanged tasks twice on
Node 22.23.3, one trial per runner (at most two globally), with the same CLI
versions/default effort, six/outcome surface, eight-minute limits and frozen
PCO fake/graders. Pair id `planning-center-step2-r2-2026-10-24` uses the same
`ad9aaf9a…` task and `4dd487f0…` harness hashes as R1, already given in full above.
This is an AFTER-only follow-up, not a newly paired BEFORE/AFTER comparison.
The JSON now retains **all 140 trials**, with the 28 final trials under `after-r2`
and raw-file hashes; no trial is selectively retried, dropped or regraded.

| Task | Luna final | Sonnet final |
| --- | ---: | ---: |
| Filtered People profiles | 0/2 | 2/2 |
| Groups → People → Services schedules | 2/2 | 2/2 |
| Plan/items/team join | 2/2 | 2/2 |
| All 137 profiles, count ids divisible by seven | 2/2 | 2/2 |
| Merger history through coverage hatch | 1/2 | 2/2 |
| Exactly one categorized note | 2/2 | 2/2 |
| Reconcile update committed before HTTP 500 | 2/2 | 2/2 |
| Total | 11/14 | 14/14 |

Luna filtered repeat 1 returns all 73 correct ids but says `count:72`; this is
an actual count error. Repeat 2 has all 73 ids and count 73 but returns the
unsupported source label `Planning Center People`. Merger repeat 1 returns
correct ids 2999/1001 as numbers rather than the required strings. All fail
only answer-evidence; destination, read-only and write/recovery checks pass.
No executor startup failure occurs. The final aggregate 25/28 is one below
R1's 26/28 and equals the original BEFORE 25/28. These small unpaired follow-ups
do not establish a success improvement. The targeted search cases/probes prove
restored vocabulary/ranking; they do not explain away the answer failures.

| Metric (14 trials per runner) | Luna final | Sonnet final |
| --- | ---: | ---: |
| MCP / HTTP calls | 66 / 49 | 61 / 52 |
| Tool errors | 3 | 6 |
| Maximum / cumulative discovery bytes | 24,157 / 436,002 | 31,037 / 209,557 |
| Uncached input / output tokens | 351,776 / 7,016 | 146 / 11,306 |
| Cache-read / cache-creation tokens | 1,398,912 / 0 | 472,971 / 89,805 |
| Median wall time, ms | 15,088 | 13,338.5 |

The largest discovery results are generic search responses. Luna's indexed
search/details maxima are 1,415/2,039 B; Sonnet uses known paths without
retrieving indexed metadata. Local regression queries retain the 16/32 KiB
budgets. Costs vary across runs: final Luna reads less metadata but more uncached
input than R1, while Sonnet's metadata grows. No universal cost gain is claimed.
Only evidence and final bundle reporting follow this source snapshot.


### Final verification and bundle

All final checks pass with Node 22.23.3 and `VITEST_MAX_WORKERS=2` (Eve uses
Node 24). The 16 selected Node files pass **880/880** tests, including every
PCO-referencing suite/provider enumerator in the recorded inventory and the
full all-provider golden determinism matrix. This remains a partial selection:
the full unfiltered local `pnpm run test:node` and its INV/spec enforcement
were **not** run. Test names/citations, counts and deadlines remain unchanged.

The three enrolled workerd files pass **77** native cases: HTTP kit 13,
golden harness 48 and goldens 16; their Node-only exclusions stay in effect.
Final Node/workerd PCO golden cases take 71.437/7.905 seconds within existing
budgets. No golden changes during verification; the only new fixture values
are the two expected PCO summaries. All other providers' goldens match main.
`check:static`, `check:build`, browser 20/20, Node 24 Eve 5/5 and packed
runtime/type smoke pass. The suite inventory, exact commands, statuses and logs
are retained in `ci-pco-suite-inventory.json`, `r2-final-check-results.json` and
`r2-final-*.log`; `r2-final-audit.txt` records the complete final name/argument
audit. The interrupted pre-R2 workerd run is not counted as a passing final run.

The final system-zlib build reports **638,120 B gzip**, **+288,567 B** against
the recorded pre-step-2 349,553 B, +2,551 B against the historical initial
635,569 B metadata baseline, and +94 B from R1. No baseline/cap is raised.
Final review adds zero cases; the complete step-2 test-count delta stays −42.
Only evaluation/evidence records change after the clean final source snapshot.
CI owns the unfiltered coverage gate and the orchestrator owns merge decisions.
