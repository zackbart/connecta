# Google Forms step 2 evaluation (#703)

Seven fake-only workflows compare the six named Forms tools on main with the
standard surface's six retained names and four indexed hatches. The paired
matrix completes **56 trials**, with no reruns or rescoring: **17/28 BEFORE →
20/28 AFTER**. These paid trials measure the pre-review implementation; the
round-1 fixes below have deterministic verification and no paid rerun.
The [JSON summary](./google-forms-step2.json) retains source,
protocol and CLI metadata, every trial's outcome and metrics, attempted tools,
discovery sizes, failed checks, and exact write destinations/bodies. Original
JSON, complete transcripts and saved grading inputs remain under
`/home/operator/.t3/scratch/connecta-orchestrator/step2/forms/`.

## Frozen protocol and provenance

BEFORE is clean main `ff3f7c3b9cbf0e8958599834850876c24ab64d7e`, source tree
`d5e26d1d940e`. AFTER is clean `7ec41a1fc9e61708f5c15be23c4d233d972f2a4b`, source
tree `2edb103a3775`. Both include the frozen route-neutral graders, checker fixes
and caller-bound cursors from #1011/#1013, and the independently merged H1.
Reporting commit `99be2ca7` changes no production source. The round-1 production
fixes below postdate the paid trials. Main was fetched again for handoff and
remained at the BEFORE commit.

Codex CLI `0.163.0` uses `gpt-6-luna`; Claude Code `2.1.309` uses
`claude-sonnet-5-5`. Each arm has two repeats of each of the seven tasks, default
effort, `six` surface, `route` grading, and an eight-minute trial deadline on
Node `26.12.0`, linux-x64. One serial batch per runner allows at most two Forms
trials concurrently. Each runner finishes BEFORE before starting AFTER. Pair id:
`google-forms-step2-2026-10-24`. Cache conditions are ordinary CLI defaults;
there is no cache reset or cache matching. Fake credentials pass the neutral
substring guard. No real Workspace data call or service-account token mint is
used.

Across the original paid arms, all task prompts, graders, fake responses and reference definitions
are byte-identical. The only changed file in the frozen task/fake/harness tree
is the explicitly approved **surface adapter**, committed separately as
`7ec41a1f`: [google-controls.ts:250](../tasks/google-controls.ts) now selects
`items ?? responses`. An `items` result must have `page.hasMore === false` and
omit `nextCursor`; the legacy result retains its null terminal cursor check.
Both branches require an empty array, so a non-empty result still fails. The
original failure was at line 247; the changed expectation is now lines 245–256,
with row selection at **line 250**.

There is no checked-in per-file frozen-hash manifest to refresh. The original
paid-arm file audit has exactly one changed row, `eval/tasks/google-controls.ts`:
`cf6d73782e7820287aaaa3e65275d9534b7df9e57a9697b5307fdb3e25bd3a75` →
`51bc61da3eebc0b41a390a05a5efbb8755a0ac22ab1da7809f56f07c498edf3b`.
The harness fingerprints the whole task directory, so this approved control
changes the aggregate task hash from
`56e66bd447b3fb1ed8bcd6a56d4c9623c86db9c6a3e7f4a7a7c8cece2b130edd` to
`2de39234aca7099f03c19f57e82c59e57bbcec5b0c82ef8984cd80df9715f1ea`.
The harness hash remains
`6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
No grader, prompt or fake changed, and no paid outcome was revised.

The BEFORE scripted references pass the frozen graders without adaptation.
Pre-review AFTER selftests used an external, reference-only preload for F4: its old
`get_form({raw:true})` call becomes `forms_api_read({path:"/forms/forms1"})`,
unwrapping the vendor Form from `reply.data`. The preload does not modify the
on-disk task file, prompts, graders or fakes, and **is never loaded in paid
trials**. Its historical artifact was `forms-reference-adapter.mjs` in the directory above,
SHA-256 `ddbc36bba8eee60e688c2c5f941a1bb303f424396ccede4d89ba8332318066ac`.
The orchestrator's round-1 ruling replaces this mechanism with the product's
own in-tree reference entry, in separate commit `abcbbf3d`. F4 now reads
`forms_api_read({path:"/forms/forms1"})` and takes its `data`. The external
preload has been deleted. Current selftests run normally with
`node --import tsx eval/selftest.ts --tasks google-forms-4` or the full seven
Forms task ids, without any preload. References never execute in paid trials;
their saved outcomes and original hashes remain unchanged. The historical
control failure and pre-review passing logs are retained separately.

## Round-1 fixes and current hashes

The review fixes are on top of `99be2ca7`; the F4 reference migration is its own
commit. The production fixes keep refusal reasons in the compiler-retained first
sentence, improve edit discovery, preserve `truncated` after named field
selection and `omittedQuestionIds` on single responses, and refuse non-integer
or out-of-range hatch pageSize before mint/send. The connector accepts 1–5000;
omission retains Google's default. The 150-option dropdown and oversized response
rows prove selected data still carries cut/recovery metadata. All requested
option/choice/form-name searches rank batchUpdate first; publish/watch searches
show their refusal reason. Existing test cases contain the new assertions, so
the collected test delta remains zero.

The empty-response control additionally rejects `items: []` when `responses`
is present, including a non-empty legacy collection. A six-case control probe
includes that counterexample. Migration wording now names the delegated caller;
unrelated Drive/Gmail fixture re-escaping is reverted. Only Forms stored goldens
change. The generated bundle-budget row changes only Forms, through the normal
provider generator; no shared Google/HTTP or generator logic changes.

Current task-directory hash:
`0a1561b61a404ad909daf53d64fedde6fd0962e76e5a191a3cb2173f9f90a15c`.
The harness hash remains `6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
The JSON's `reviewFixes` records current file hashes for the hardened control
and Forms-only F4 reference separately from the historical paid-run audit.
No prompt, grader or fake changes; no paid outcome is regraded or replaced.

Round-1 validation passes: the six targeted suites **654/654**, a final Forms
run **5/5**, all seven normal selftests across both surfaces/grading modes,
and the exact F4-only selftest command. Node goldens with full determinism
and workerd goldens each pass **16/16**. Node 24 Eve **5/5**, packed-consumer
smoke, generated freshness, formatting, `check:static` and `check:build` pass;
all bundle caps pass. `VITEST_MAX_WORKERS=2` throughout; no full check or paid
rerun. Test registrations are unchanged, and other products' goldens remain
byte-identical. Logs are retained as `r1-*` in the artifact directory above.

| Original artifact | SHA-256 |
| --- | --- |
| `before-luna.json` | `6e1d5dba50fa81e5349f91eae3ea18e2c7410340ce4de382b215daa219cb9711` |
| `before-sonnet.json` | `ff2f03866c95ebb068d84bae8f94b069fad922a9c19dbf7706512f7f56d342f9` |
| `after-luna.json` | `e3c9fd0c9eb2d64b8aae2fc40027176befee2ab2e0026fe7ef73791905fd84fd` |
| `after-sonnet.json` | `dd4bf3d1000e58db506a91658cc6b17d49c008a4abb29d9f93dedc084dbcfb50` |

## Outcomes and regression analysis

All seven tasks preserve existing capabilities; Forms has no new-coverage row.
The existing-capability score therefore equals the all-task score.

| Task | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| F1 filtered responses | 1/2 | 1/2 | 2/2 | 2/2 |
| F2 question/response join | 0/2 | 0/2 | 0/2 | 0/2 |
| F3 complete paging | 0/2 | 1/2 | 2/2 | 2/2 |
| F4 quiz/navigation edit | 0/2 | 1/2 | 2/2 | 2/2 |
| F5 create question once | 1/2 | 2/2 | 2/2 | 2/2 |
| F6 reconcile uncertain rename | 1/2 | 1/2 | 2/2 | 2/2 |
| F7 stale revision recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| **Total** | **5/14** | **8/14** | **12/14** | **12/14** |

No task's pass count declines. Luna gains one completion each in paging, rare
metadata/editing and the write-once task. This small correlated sample cannot
establish causation or production reliability.

The failures remain significant:

- Luna treats the supplied `forms1` id as a name to search in Drive in several
  trials. BEFORE F1 #1, F3 #1/#2, F4 #1 and F6 #2 never read the requested form.
  AFTER F1 #1, F3 #1, F6 #1 and F2 #2 make the same mistake. The last is a
  qualitative regression hidden by F2's unchanged failing score: both BEFORE
  joins read the right facts, while AFTER #2 never reaches them. It also makes
  an invalid `connecta.describe({connector,query})` attempt. No tool error
  establishes that the supplied form id was unavailable.
- Both Sonnet joins in each arm, both BEFORE Luna joins, and AFTER Luna F2 #1
  correctly read the question and two responses but return a different JSON
  structure from the frozen expected `questionId`, `title`, `answers` shape.
  The prompt lists the top-level keys but does not spell out the nested
  `answers: [{id,value}]` structure, which limits what these format failures
  establish about workflow quality. Those answer-evidence failures stay failed.
  BEFORE Luna F5 #1 creates the correct
  question once but omits `source` from its final JSON; that also stays failed.
- BEFORE Luna F4 #2 and AFTER F4 #1 send malformed `updateItem` requests missing
  the required location. The fake faults, the option remains unchanged, and
  both agents read back without replay. AFTER #1 also returns `correct` as an
  array rather than the expected scalar. AFTER #2 uses structural hatch
  discovery/read and completes the edit while preserving grading/navigation.
- Sonnet AFTER F4 #1 first guesses a native `forms_api_details` tool on the
  six-tool surface, then supplies an unsupported `method` key to the read
  hatch. It repairs the call and passes. Luna AFTER F5 #1 repairs an invalid
  `connecta.describe({query})` attempt and passes. These failed discovery/call
  attempts remain in the telemetry.

## Calls, discovery, time and tokens

| Arm/model | MCP calls total / mean | HTTP reads / writes | Mean discovery bytes | Max cumulative / reply bytes | Mean wall time |
| --- | --- | --- | --- | --- | --- |
| BEFORE Luna | 77 / 5.50 | 48 / 8 | 16,942 | 25,300 / 13,602 | 17.33 s |
| AFTER Luna | 99 / 7.07 | 81 / 9 | 32,295 | 54,234 / 15,451 | 21.30 s |
| BEFORE Sonnet | 73 / 5.21 | 73 / 10 | 14,287 | 54,271 / 36,820 | 13.94 s |
| AFTER Sonnet | 68 / 4.86 | 68 / 10 | 14,756 | 28,393 / 12,959 | 13.64 s |

MCP counts include failed calls to the six exposed meta tools and execute_code;
Sonnet's one unavailable native-tool guess is recorded separately. HTTP counts
are physical ledger dispatches, including stale-write refusals and injected
post-commit failures. OAuth mints are separate: BEFORE Luna/Sonnet 15/16, AFTER
18/16. There are no trial timeouts, CLI auth/rate-limit stops or batch retries.

Discovery bytes count UTF-8 top-level search/description/guide and Forms hatch
search/details replies, plus compact JSON received by guest
`connecta.search/describe/skill` and hatch discovery calls. Program output is not
counted a second time. The largest actual Forms hatch discovery reply is
15,451 B, within its budget; the larger BEFORE Sonnet reply is shared catalog
discovery. Luna's discovery cost, calls, HTTP reads and latency increase, and
Sonnet's mean cumulative discovery bytes also increase slightly. These results
do not demonstrate an overall efficiency improvement.

| Arm/model | Input tokens | Output | Cache read | Cache creation | API-equivalent USD |
| --- | --- | --- | --- | --- | --- |
| BEFORE Luna | 316,855 | 8,111 | 1,332,992 | 0 | unknown |
| AFTER Luna | 421,376 | 10,392 | 1,973,888 | 0 | unknown |
| BEFORE Sonnet | 148 | 12,044 | 513,657 | 99,600 | 0.570502 |
| AFTER Sonnet | 148 | 11,524 | 573,494 | 101,632 | 0.579413 |

Claude cost is API-equivalent telemetry from subscription CLI runs, not an
invoice. Luna does not report a dollar cost; unknown does not mean zero.

## Writes, recovery and tool retention

All **37 physical write attempts** target only `POST /forms/forms1:batchUpdate`.
They include eight deliberately stale revision refusals and the two malformed
rare-edit attempts described above. There are **zero duplicate writes and zero
unauthorized requests**. F6's six completed recovery workflows each send one
rename, observe its post-commit 500, read back and do not resend. Two Luna F6
trials never reach the target. Every F7 trial re-reads after its stale attempt
and applies one authorized edit at the new revision. There are no authorization
calls, URL elicitations, permission denials or confirmation nudges.

| Tool attempted | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| `get_form` | 14 | 12 | 17 | 13 |
| `get_response` | 4 | 2 | 4 | 4 |
| `list_responses` | 3 | 17 | 23 | 20 |
| `batch_update_form` | 3 | 4 | 4 | 4 |
| `update_form_info` | 5 | 5 | 6 | 6 |
| `create_form` | 0 | 0 | 0 | 0 |
| `forms_api_search` | — | 4 | — | 0 |
| `forms_api_details` | — | 1 | — | 0 |
| `forms_api_read` | — | 3 | — | 6 |
| `forms_api_write` | — | 0 | — | 0 |

Counts include direct calls, observed guest calls and failed attempts; the
unavailable native-tool guess is excluded from this registered-tool table.
The JSON also records Drive discovery and failures. All six named tools remain
under the approved retention ruling. In particular, zero `create_form` calls
in these seven workflows does not authorize retirement. No new named tool or
batch-wrapper retirement is proposed. The hatch write boundary has deterministic
direct/native/execute_code coverage; these models chose retained writers.

## Deterministic and size evidence

Post-merge Forms/delegation/standards/conventions checks pass **190/190**; both
previous checker failures pass. Full Node collection at the paired commits is
**4,205 → 4,205**, with identical counts in every file: **net test delta 0**.
The Forms caller-isolation row exercises real
named and hatch cursors: delegated B receives `invalid_args` with no token mint
or API send, while A continues to the second response. All custom Forms cursors
use signed bound cursors; no legacy unsigned continuation is emitted.

All-provider Node goldens pass with `CONNECTA_GOLDENS_DETERMINISM=1` (**16/16**),
and all-provider workerd goldens pass (**16/16**). Only Forms stored goldens
change: four names added; real schemas/fields and raw removal; standard items,
terminal cursor omission and truncation paths; standard errors; plain guide and
generated Conventions. Phase-1 evidence additionally includes the failure sweep
(441), cross-provider provenance/privacy/registry/purity/package checks, native
and execute_code cases, workerd delegation/hatch/native probes, Node 24 Eve checks
(5) and packed-consumer smoke. Public contract checking reports no drift.
`check:static` and `check:build` pass after the main merge; root/Worker/UI bundle
caps pass. Checks use `VITEST_MAX_WORKERS=2`. No full local `pnpm run check` runs;
the required full CI gate remains the merge requirement.

The same measurement toolchain against exact BEFORE `ff3f7c3b`, after the
round-1 fixes, gives Forms **353,598 → 372,123 B gzip (+18,525 B)** and all-six
deployment **417,651 → 436,937 B (+19,286 B)**. The provider's refreshed bundle
baseline/note records the 372,120 B snapshot before recording those bundle facts;
the facts themselves add 3 B gzip. The original paid-head measurement was
371,901 B Forms / 436,748 B all-six, retained in the historical JSON bundle rows.
The actual generated index is 30,278 B text / 5,597 B gzip, retaining ten methods
and five admitted methods.
Publish settings and every watch operation remain refused before authentication.
Responses, respondent emails and quiz answers remain requested user data under
S6; temporary `Image.contentUri` destinations are permanently withheld across
named and hatch result shapes. H5 is folded in; H9 is characterized without a
deadline change. Loaded-host cold/warm timing samples are retained in the scratch
artifacts and are not an SLA.

## Main reconciliation and final review

Merged Docs main `f9bf5afb` into the reviewed Forms head `7ce696af` using merge
commit `568fc36a`; no rebase or stash. Both products' migration/setup sections,
pending removals, bundle declarations, failure fixtures and scripted reference
entries are retained. Docs source and its eval notes/JSON remain byte-identical
to main. Every non-Forms stored golden is byte-identical to main; the unrelated
Drive/Gmail failure-argument rows remain unchanged.

R2-B1 uses the reviewer's exact 115-character batchUpdate summary:

> Edit form: change name/title/quiz settings/correct answer key, rename choice option, add/delete/move item/question.

The evidence document, generated index and Forms call golden were regenerated.
“quiz settings” and “update item” are additional rows inside the existing
natural-query test, both ranking batchUpdate first. All **59** queries from
`reviews/1014-r2/probes/search-compare.txt` rank batchUpdate at least as well as
the best recorded rank across round 1, the reviewed head and the proposed
candidate. Queries absent from all three references remain absent; this is a
ranking non-regression check, not a claim that all 59 find the operation.
The JSON includes each comparison row. No test case was added.

Fresh same-toolchain measurements against merged main `f9bf5afb`, using Node
26.12.0 and `scripts/measure-google-index.mjs`, are Forms **353,598 → 372,120 B
gzip (+18,522 B)**; Docs **370,091 → 370,091 B**; and all-six deployment
**434,446 → 448,515 B (+14,069 B)**. The final Forms bundle is 1,218,225 B
minified text; its actual generated module is 30,274 B text / 5,600 B gzip.
Forms' regenerated bundle note records the refreshed 372,120 B snapshot; the
post-note measurement is also 372,120 B. Docs' recorded 369,878 B entry remains
the explicitly labeled Node 22 evaluated snapshot, rather than being rewritten
as a Node 26 measurement. Standalone entries include shared code and are not
additive. The earlier bundle rows above describe their original snapshots.

No paid trials were rerun or regraded. The merged task-directory hash is
`fb62ac966deb1f06c592f9bb8f9e26067fd6ac191f9d3fa465a484bf4917b058`;
the harness hash remains
`6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
Its difference from the historical review hash is the merged Docs reference and
surface-control adapter. The Forms reference-only change remains at
`eval/tasks/google.ts:853`; the Forms empty-result adapter remains at
`eval/tasks/google-controls.ts:250` (terminal/mixed-envelope checks at 253).
The paid-arm task hashes, file audit, raw hashes and outcomes are preserved.

The first merged selftest exposed double unwrapping in the Forms F4 reference:
Docs main already unwraps every `*_api_read` in the shared `read` helper. The
reference-only follow-up `aef6c6cb` changes only Forms' line 853 to consume that
Form directly, keeping `forms_api_read`. The shared helper and Docs reference
are retained unchanged. This explains the final task hash above and changes no
prompt, grader, fake or paid trial. The failed deterministic attempt is retained
in scratch `r2-google-selftest.log`; subsequent verification uses the corrected
reference.

Post-merge targeted suites pass **809/809** (13 files); the post-R2 targeted
run passes **662/662** (11 files), including the Forms suite and both standards
checkers. All-provider Node deterministic goldens pass **16/16**, and workerd
goldens pass **16/16**. Final `check:static` passes. The exact F4 selftest passes
on both surfaces and both grading modes without any preload. Full Node
collection against `f9bf5afb` is **4,205 → 4,205**, with identical per-file counts
and **test delta 0**. Node 24 Eve checks pass **5/5**, with packed-consumer smoke.

The full Google selftest passes for all **42 tasks × two surfaces × two grading
modes (168 reference checks)**, including the shared identity, transport and
boundary controls. Drive F4's known BEFORE capability gap remains an unsuccessful
outcome, correctly recognized by the selftest; it is not scored as a capability
success. All seven Forms references pass in every mode. The corrected full log
is `r2-google-selftest-final.log`; no prompt, grader, fake or paid outcome changes.

Final `check:build` passes, including emitted declarations and root/Worker/UI
bundle caps. Its published `dist` entry measurement is **372,171 B gzip for
Forms**, **370,111 B for Docs** (root 371,362 B, UI 344,549 B, Worker 76,747 B).
The paired `scripts/measure-google-index.mjs` comparison above measures source
entries, so its Forms figure is 372,120 B; these are distinct inputs, not a
changed paid measurement. All required checks use `VITEST_MAX_WORKERS=2`.
No full local check, paid rerun or regrading was performed.
