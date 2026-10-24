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
requires an AFTER-only rerun of all seven tasks, both required models and two
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
