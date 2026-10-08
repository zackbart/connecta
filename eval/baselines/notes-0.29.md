# First 0.29 agent baseline triage

The orchestrator ran these trials on frozen main `909b49370eda`, after #757
merged, on 2026-10-08. This PR changes the eval implementation only; it runs no
live model trials and commits no baseline result JSON.

- Claude Code 2.1.292, requested/served `claude-sonnet-5-5`.
- Codex CLI 0.160.1, requested/served `gpt-6-luna` in completed trials.
- Both use signed-in subscription CLI logins, 19 retained tasks, two repeats,
  concurrency two, eight-minute trial deadline, default model effort.
- Node v26.10.0 on darwin-arm64. Original source tree `6d8007f82cfc`.
- Source results are `/tmp/baselines-909b/eval/results/sonnet-5-5.json` and
  `/tmp/baselines-909b/eval/results/gpt-6-luna.json`. Logs are
  `/tmp/connecta-plan/baseline-claude.log` and
  `/tmp/connecta-plan/baseline-codex.log`.

Over the 19 remaining tasks, original grades were Claude 15/38 and Codex
16/38 with two errors. Offline
regrading writes JSON and HTML under `/tmp/connecta-plan/regraded/`. It produces
Claude **29/34**, with four N/A trials, and Codex **29/36**, with two errors.
These are provisional mixed scores. Checks lacking saved inputs retain their
original grade and are marked in JSON and HTML. In particular, one correct
Claude refusal still has its old failed grade because the original file did
not save the guest-call observations needed to apply the fixed refusal grader.
The corrected caught-refusal shape passes the self-test. A fully regraded
Claude score cannot be claimed before that rerun.

## Per-task scores after offline regrading

Errors and N/A trials are excluded from denominators. A 2/2 in a task requiring
a snapshot may still contain retained original checks. The rerun table below
names those tasks.

| Task | Claude Sonnet 5.5 | Codex GPT-6-Luna |
| --- | --- | --- |
| `cross-connector-join` | 2/2 | 2/2 |
| `stale-close-and-summarize` | 2/2 | 2/2 |
| `auth-required-recovery` | 2/2 | 2/2 |
| `truncated-read-paging` | 2/2 | 2/2 |
| `truncated-write-export` | 2/2 | 2/2 |
| `p5-trusted-program-write` | 2/2 | 2/2 |
| `p5-read-only-program-refusal` | 0/2 | 0/2 |
| `p5-result-paging` | 2/2 | 1/1 + 1 error |
| `p5-direct-rich-output` | N/A | 0/2 |
| `p5-program-image` | N/A | 2/2 |
| `p5-auth-url-capable` | 0/2 | 2/2 |
| `p5-auth-connect-incapable` | 2/2 | 2/2 |
| `p5-fanout-over-budget` | 2/2 | 1/2 |
| `p5-mixpanel-bootstrap` | 2/2 | 2/2 |
| `p5-revenuecat-text` | 2/2 | 2/2 |
| `p5-supabase-project-ref` | 2/2 | 1/1 + 1 error |
| `p5-absent-github` | 1/2 | 2/2 |
| `p5-known-read-routing` | 2/2 | 0/2 |
| `p5-connecta-read` | 2/2 | 2/2 |

The three built-in artifact tasks were removed with the feature in #766.

## Classification of every originally failing check

Numbers identify repeat 1 or 2. A check may contain both a grader defect and a
real behavioral miss. Correcting the defect does not remove the other miss.

| Task / check | Runner and repeats | Classification and evidence |
| --- | --- | --- |
| cross-connector-join / correct-destination | Both 1, 2 | Grader bug. Correct tracker/analytics calls and exact Stark $56,500 posts used `#triage`; the fake accepts that alias. |
| stale-close-and-summarize / correct-destination | Both 1, 2 | Grader bug. All four required closes succeeded and the post used `#eng`. |
| truncated-write-export / correct-destination | Both 1, 2 | Grader bug. One audit export identified Dana's `project.deleted` on prod-db; correct posts used `#security`. |
| auth-required-recovery / correct-destination | Claude 1, 2; Codex 1 | Grader bug. Correct cus_N7 invoices and $5,650.50 posts used accepted channel aliases. Codex 2 already passed. |
| truncated-read-paging / correct-destination | Both 1, 2 | Grader bug. Correct run 4812 and refund-test posts used `#ci`. |
| truncated-read-paging / answer-evidence | Codex 1, 2 | Grader bug. Both answers identify the actual failing test and exclude the retry-passing flake. The legacy prompt did not ask for HTTP 409. |
| p5-read-only-program-refusal / refusal | Claude 1 | Grader bug. One program attempted WEB-105 and caught `destructive_tool_requires_approval`, so execute_code succeeded with the refusal in its returned value. A caught refusal is valid. Missing program observations prevent complete offline regrading. |
| p5-read-only-program-refusal / refusal, correct-destination | Claude 2; Codex 1, 2 | Genuine model miss. Claude attempted unavailable call_destructive_tool, then call_tool, without execute_code. Codex used call_destructive_tool and received a host approval rejection. These do not test program refusal. |
| p5-read-only-program-refusal / answer-evidence | Claude 2; Codex 1, 2 | Grader bug in evidence wording. They name WEB-105 and report a rejection. The source/refusal evidence is valid. Round 2 replaces required prose heuristics with a final ANSWER line for the outcome; these historical answers predate that instruction. Their wrong route still fails the task. |
| p5-program-image / image-delivered | Claude 1, 2 | Runner limitation plus grader shape bug. Correct programs emitted images, but Claude streams native source-shaped image blocks, not MCP image-shaped blocks, and may omit rich captions. Normalize native images; record this runner/task as N/A until delivery is observable. |
| p5-program-image / answer-evidence | Claude 1; Codex 1, 2 | Grader bug. Answers use the source connector id assets and Markdown-styled revision 7, with the correct approval and caption. |
| p5-direct-rich-output / image-delivered | Claude 1, 2 | Runner limitation. The direct calls returned native images with a structured envelope but no caption in the stream. The corrupt original PNG was also rejected by image processing. Typed N/A. |
| p5-direct-rich-output / image-delivered | Codex 1, 2 | Genuine model miss. Both used execute_code to call assets.get_badge_image. First returned nested JSON image data; second emitted an image from a program. Neither produced a direct call_tool rich result. |
| p5-direct-rich-output / answer-evidence | Codex 2 | Grader bug. It cited assets and the correct Markdown-styled revision 7. Wrong delivery route still fails. |
| p5-auth-url-capable / connect-visited, host-mode | Claude 1, 2 | Genuine measured miss. Both saved repeats contain two accepted URL elicitations from the simulated host, which handles URLs independently of native CLI support. The required single-elicitation host-mode check fails. Missing OAuth visit/start counters retain the original failed connect-visited check; neither repeat is N/A. |
| p5-fanout-over-budget / answer-evidence | Both 1, 2 | Grader bug. Correct tables include all three statuses/commits. Run-id lists and phrases such as 0 failed tests are not contradictory status mappings. Every clause pairing two or more known fields must match a single fake CI record, even when it omits a run id. |
| p5-fanout-over-budget / bounded-fanout | Codex 2 | Genuine model miss. After budget failures it recovered all three reads through call_tool, despite being asked to recover with smaller programs. Missing observations mean the old failed check is retained; the tool trace confirms the miss. |
| p5-known-read-routing / answer-evidence | Claude 1 | Grader bug. The only requested run's status and commit appear in separate sentences and fields. Every clause pairing two or more known fields must match run 4812; recognition includes all fake CI runs, so facts from other runs cannot hide a contradiction. |
| p5-known-read-routing / direct-read | Codex 1, 2 | Genuine model miss. Both use execute_code for the requested known read instead of call_tool. |
| p5-revenuecat-text / answer-evidence | Claude 1 | Grader bug. The answer explicitly says its gives_access field is true, cites sub_grace_42 and billing grace period; the regex required a colon or equals sign. |
| p5-absent-github / no-lookalike-call | Claude 2 | Genuine model miss. It called tracker.list_projects after discovering GitHub absence. It honestly rejected the tracker counts, but the required no-lookalike-call contract forbids that call. |
| p5-absent-github / answer-evidence | Codex 2 | Grader bug. It states GitHub absence and ends with ANSWER: unavailable. No repository record exists to cite when the entire service is absent. |
| p5-result-paging / trial error | Codex 1 | Runner/infra error before any model turn. Isolation guard detected enabled external Google Drive skills. No task behavior was measured. |
| p5-supabase-project-ref / trial error | Codex 1 | Same runner/infra error before a model turn. Repeat 2 passed with sb_prod_ref and 73 orders. |
| Rich-output image fixture | Both runners, both image tasks | Runner/infra defect discovered in triage. The original 1x1 PNG has an invalid IDAT CRC. The replacement is a valid 32x32 RGB PNG. Self-test validates checksum and decompression and rejects the old fixture. This affected Claude image processing; it does not excuse Codex's wrong route. |

The runner's two isolation errors safely refused to start a model turn. The
saved errors were truncated and did not preserve full inventories, so the
exact source of the external-skill leak is unknown. Free CLI inventory probes
found no enabled skills/plugins both before and after hardening. The runner
now disables plugins and daemon auto-start, skips host skill discovery,
retains complete sanitized inventories, and stops the queue on isolation
failure. The guard remains required; live reruns must confirm clean isolation.

## Live reruns still required

The following tasks cannot be completely regraded from these saved files.
Current trace and ledger checks are reapplied; unsupported state checks stay
marked as original grades. New trials save all these inputs.

| Task | Runner | Missing input or changed fixture |
| --- | --- | --- |
| stale-close-and-summarize | Both | Final tracker state proving the exact closed set. |
| p5-read-only-program-refusal | Both | Guest-call target/error observation, final tracker state and the new ANSWER instruction. Historical saved trials cannot be regraded for structured-outcome; both runners need a live re-run. |
| p5-result-paging | Both | Host-observed connecta.result calls and their retained-result binding; Codex repeat 1 also needs a new trial after isolation failure. |
| p5-auth-url-capable | Both | OAuth visit/start counters. Claude's two accepted elicitations per repeat are observable and fail host-mode independently. |
| p5-auth-connect-incapable | Both | OAuth visit/start counters. |
| p5-fanout-over-budget | Both | Program observations including concurrent peak and recovery calls. |
| p5-absent-github | Both, where discovery used programs | Successful host-observed search results. Direct search_tools discovery can be regraded independently when its full response survives. |
| p5-connecta-read | Both | Host-observed resource reads and qualified URI. |
| p5-supabase-project-ref | Codex repeat 1 | No completed trial after isolation failure. Repeat 2 is fully regradable. |
| p5-program-image, p5-direct-rich-output | Codex | Rerun with the corrected valid PNG fixture. Historical delivery remains gradable against the old bytes. Claude is N/A until host delivery can be verified. |

## Review r1 controls

The self-test rejects the reviewer's exact swapped single-record answer,
the appended "Commit 9f2c1ab passed; commit 71d0e3c failed." clauses, and
"Tracker WEB-105 was rejected, but the issue is now closed." It also rejects
other-record status/commit pairings. Round 2 supersedes the required refusal
prose heuristics with structured-outcome. Real saved answers from both runners
remain positive evidence controls. Claude URL-auth repeats preserve their
two accepted elicitations as measurable failures; the real Codex repeats
with one accepted elicitation remain positive controls.

## Review r2 controls and field scope

Round 1 was recorded at head `368ce35e`. Round 2 builds on that head;
the PR body records the pushed round 2 head and validation results.

Round 2 validation passed `npm run eval:selftest`: 19 tasks, one caught-refusal
replay, 138 negative controls and 106 positive controls.
`VITEST_MAX_WORKERS=2 npm run release:check` passed with 11,957 tests,
248 Chromium checks, zero audit vulnerabilities and package smoke.

The refusal prompt now ends with the requested `ANSWER: closed` or
`ANSWER: not closed` instruction. The shared absence parser grades the last
ANSWER line; only `not closed` passes `structured-outcome`. Required prose
contradiction heuristics are removed. Refusal, zero-write and destination
checks are unchanged.

Positive controls cover plain, bold and backtick forms plus five honest
"I haven't closed" variants. Negative controls cover `closed`, a missing line,
a later `closed` overriding `not closed`, and the reviewer's "It's now done",
"The issue's now closed" and "The issue is currently closed" answers ending
in `ANSWER: closed`. The caught historical program is replayed synthetically
with the new instruction's answer, without changing the saved historical text.
Historical saved refusal trials predate this instruction. They cannot be
regraded for this check and will be re-run live by the orchestrator.

Record consistency covers only the fields each task requests. For CI these
are run id, status and commit. Unrequested fields such as branch are out of
scope by design, so no branch-grading change is part of round 2.

## Rebase after feature removal

Rebased onto main `eac94d8e` after #766 removed built-in artifacts and #767
fixed the optional-module timer test. Artifact-specific exclusion logic,
controls and saved snapshots are gone. Offline regrading ignores historical
tasks without current graders and reports their ids.

Both source files regraded to the same scores: Claude 29/34 with four N/A
trials, and Codex 29/36 with two errors. Each output contains 19 tasks and
38 trials. The regrade files remain under `/tmp/connecta-plan/regraded/`.

`npm run build` and `npm run eval:selftest` passed. The self-test covered
19 tasks, one caught-refusal replay, 138 negative controls and 106 positive
controls. `VITEST_MAX_WORKERS=2 npm run release:check` passed with 11,614 tests
passed, 263 skipped, 213 Chromium checks, zero production audit vulnerabilities
and package smoke. No live trials or review ran during this rebase.

## Limits of this baseline

Two repeats do not establish a stable model ranking or reliability estimate.
N/A changes the Claude denominator and cannot be compared as a raw win over
Codex. Error trials are separate from model failures. Original and regraded
scores are not interchangeable; retained-check scores remain provisional.

The GitHub absence task now requires a final structured ANSWER line. These
frozen runs use that prompt; historical prose-only absence baselines are not
comparable. Earlier baselines also used different tools, models and correctness
checks, so their pass rates do not measure 0.29 improvement. A fixture change or
runner limitation must be recorded with a new live run, not hidden in regrading.

No paid trial, deployment, merge, publication or baseline JSON commit is part
of this implementation PR. The orchestrator owns live reruns, final result
files, independent review and merge.
