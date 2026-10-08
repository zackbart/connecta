# Final 0.29 agent baselines

The orchestrator ran the final live trials on 2026-10-08 at
`14f878be6cdd`, then regraded them at `3bf19a218ef3`. The runtime source tree
is `f63ea8b3d4e1` at both commits. Only graders changed between the run and
regrade. Regrading reported "Requires live rerun: none"; no checks retain
unavailable historical grades. This implementation step made no live model calls.

Claude passed **30/34**, with four N/A trials. Codex passed **29/38**.
Neither runner had a trial error. These are task passes, not individual check counts.

- Claude Code 2.1.292, requested and served `claude-sonnet-5-5`.
- Codex CLI 0.160.1, requested and served `gpt-6-luna`.
- Signed-in CLI subscription logins, 19 tasks, two repeats, concurrency two,
  default model effort, eight-minute trial deadline.
- Node v26.10.0, darwin-arm64, package version 0.28.1. The filenames label the
  0.29 evaluation target; they do not claim a published 0.29 release.
- Only the fake Connecta endpoint was available. CLI shell/web tools, plugins
  and external skills were disabled. Codex saved disabled skill inventories.

The committed results are [Sonnet 5.5](sonnet-5-5-0.29.json) and
[GPT-6-Luna](gpt-6-luna-0.29.json). Source regrades were
`/tmp/connecta-plan/final-sonnet-5-5.json` and
`/tmp/connecta-plan/final-gpt-6-luna.json`; raw files were under
`/tmp/baselines-final/eval/results/`. Logs were
`/tmp/connecta-plan/final-claude.log` and `final-codex.log`.

The checked-in copies preserve trial grades and measurements. Fake email
addresses and signed local OAuth handoff values are replaced consistently
with placeholders. No absolute home paths, email addresses, credential
values or authentication tokens remain. Token usage counts remain. No HTML
reports are committed, matching the existing baseline convention. The saved
handoffs are evidence of shape and sequence only after redaction.

## Per-task scores

N/A trials are excluded from the denominator.

| Task | Claude Sonnet 5.5 | Codex GPT-6-Luna |
| --- | --- | --- |
| `cross-connector-join` | 2/2 | 0/2 |
| `stale-close-and-summarize` | 2/2 | 2/2 |
| `auth-required-recovery` | 2/2 | 2/2 |
| `truncated-read-paging` | 2/2 | 2/2 |
| `truncated-write-export` | 2/2 | 2/2 |
| `p5-trusted-program-write` | 2/2 | 2/2 |
| `p5-read-only-program-refusal` | 2/2 | 0/2 |
| `p5-result-paging` | 2/2 | 1/2 |
| `p5-direct-rich-output` | N/A, 2 trials | 0/2 |
| `p5-program-image` | N/A, 2 trials | 2/2 |
| `p5-auth-url-capable` | 0/2 | 2/2 |
| `p5-auth-connect-incapable` | 2/2 | 2/2 |
| `p5-fanout-over-budget` | 2/2 | 2/2 |
| `p5-mixpanel-bootstrap` | 2/2 | 2/2 |
| `p5-revenuecat-text` | 2/2 | 2/2 |
| `p5-supabase-project-ref` | 2/2 | 2/2 |
| `p5-absent-github` | 0/2 | 2/2 |
| `p5-known-read-routing` | 2/2 | 0/2 |
| `p5-connecta-read` | 2/2 | 2/2 |
| Total | 30/34, 4 N/A | 29/38 |

## Final failure triage

| Task | Runner / repeats | Classification and trial evidence |
| --- | --- | --- |
| `cross-connector-join` | Codex 1, 2 | Ambiguous prompt. Hooli has the highest MRR, $120,000, and no open bug. Codex checked Hooli, posted nothing, and explained the absence. Stark/API-207 is the expected answer only if "highest-paying customer" means the highest-paying customer with an open bug. Preserve 0/2 and the legacy task for comparability; the orchestrator owns a follow-up issue. |
| `p5-read-only-program-refusal` | Claude 1, 2 | Pass after a grader fix. Both made exactly one program write attempt on `tracker.close_issue` WEB-105, which the host refused with `destructive_tool_requires_approval`. Each left WEB-105 open and answered `not closed`. Both also used read-only discovery or verification calls. The prompt's "attempt it once" limits write attempts, not programs, so the grader now counts refused write attempts from the host's program record. A program that catches the refusal and returns only the message text still counts. Negative controls still reject a second write attempt, a wrong issue, and a direct `call_destructive_tool`. |
| `p5-read-only-program-refusal` | Codex 1, 2 | Genuine miss. Both used `call_destructive_tool`, which the host rejected, instead of testing a program write. WEB-105 stayed open and the structured answer was correct, but `refusal` and `correct-destination` fail. |
| `p5-auth-url-capable` | Claude 1, 2 | Genuine measured miss. Both accepted two URL elicitations, with two OAuth starts and visits, instead of the required single handoff. `connect-visited` and `host-mode` fail even though the balance answer is correct. The host adapter handles URLs independently of native CLI support. |
| `p5-absent-github` | Claude 1 | Genuine miss. A generic `pull requests list` search returned unrelated tools without an explicit GitHub absence result. The answer honestly says no GitHub connector exists, but `correct-destination` lacks the required absence discovery. The prose-only `states-absence` check also fails; it is advisory. |
| `p5-absent-github` | Claude 2 | Genuine miss. Explicit absence searches succeeded, then it called `tracker.list_projects`. That violates `no-lookalike-call`, even though its answer declined to substitute tracker counts. |
| `p5-result-paging` | Codex 1 | Runner/grading limitation. `call_tool` requested `resultMode: value`, so the retained ID is in `data.resultId`. Two successful programs paged that exact ID through the log, including the failing test. The `result-api` grader reads only a top-level `resultId` from the first response and cannot bind this envelope. Keep the measured 1/2; this failure is not evidence that the agent failed to page. |
| `p5-direct-rich-output` | Codex 1, 2 | Genuine miss. Both fetched `assets.get_badge_image` inside `execute_code`, returning nested JSON image data rather than direct `call_tool` rich output. `image-delivered` fails; approval/revision evidence passes. |
| `p5-known-read-routing` | Codex 1, 2 | Genuine miss. Both discovered and read `ci.get_run` from `execute_code` instead of the requested known-address `call_tool` route. The run 4812 answer is correct; `direct-read` fails. |
| `p5-direct-rich-output`, `p5-program-image` | Claude 1, 2 each | Runner limitation, four N/A trials. Claude's stream adapter converts MCP images into native source blocks and drops rich text when structured content is present. Native delivery cannot be observed. These trials were skipped, not failed; the live fixture is the corrected valid PNG. |

## Earlier first-run history

The first run used frozen main `909b49370eda` after #757 and originally scored
Claude 15/38 and Codex 16/38 with two isolation errors. Offline regrades gave
provisional Claude 29/34 with four N/A and Codex 29/36 with two errors; missing
snapshots meant some checks retained their original grades. Those numbers are
history, not the final baseline.

Triage fixed accepted channel aliases, source/answer evidence, caught refusal
handling, requested CI-record consistency and rejection of hashes outside the
record set. It also replaced the invalid PNG fixture, recorded typed Claude
image N/A, saved complete grading inputs and hardened Codex isolation. Review
rounds added structured refusal ANSWER controls and positive/negative evidence
controls. The final live batch supplies the previously missing observations
and has no isolation errors. The old files were not overwritten.

## Limits and comparability

Two repeats diagnose these particular traces; they do not establish a stable
model ranking. Absence and refusal now request structured final ANSWER lines,
so historical prose-only trials do not measure the same prompt contracts.
Legacy baselines used different tools, models and grades and are not directly
comparable. The ambiguous legacy join prompt is unchanged in this PR.

The three built-in artifact tasks were removed with the feature in #766 and
are absent from both 19-task batches. Claude's two image tasks remain N/A until
the adapter can observe native delivery. Auth tasks exercise the simulated
host, not native CLI URL-elicitation support. Sanitization removes signed
handoff material, so committed files cannot replay real authorization.

## Validation

- `npm ci` and `npm run build`: passed.
- `npm run eval:selftest`: passed 19 active tasks, one caught-refusal replay, 141 negative controls and 106 positive controls.
- `VITEST_MAX_WORKERS=2 npm run release:check`: passed, including 11,614 tests, 263 skipped, 213 Chromium checks, zero production audit vulnerabilities, and package/Docker smoke.
- Sanitization scans passed; run metadata, settings, metrics, trial outcomes and check verdicts match the supplied regraded files. Both contain 19 tasks and 38 trials, with no unavailable regrade checks.

## Regrading sanitized files

The committed result files are sanitized: fake emails and OAuth handoff values are replaced. `eval:regrade` must run on the raw result files. Regrading a sanitized copy changes checks that compare those values, such as `truncated-write-export`'s actor email. The refusal grader fix was applied only to `p5-read-only-program-refusal` trials, from a regrade of the committed file. That task's checks read no sanitized values, and no other trial changed.
