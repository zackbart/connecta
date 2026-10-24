# Google Drive step 2 evaluation (#703)

Seven fake-only workflows compare main's 17 named tools with 17 retained named
tools plus four standard `drive_api_*` tools. The [JSON summary](./google-drive-step2.json)
retains all 56 trials, checks, final answers, requested/served models, CLI metadata,
per-tool attempts, discovery bytes, writes and source/protocol hashes. Original
unmodified JSON and saved worlds remain in
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/drive/`; each original's
SHA-256 is recorded in the summary. No failure was dropped or rescored.

## Frozen protocol and sources

BEFORE is clean main `ff3f7c3b9cbf0e8958599834850876c24ab64d7e`, source tree
`d5e26d1d940e`. AFTER is clean `0f1fd3714c9d9448b7a5b2e4fd6c4ac28762ab28`,
source tree `ed5d887f5c70`. Both include H1 (#1008), the frozen route-neutral
graders/checkers (#1011) and caller-bound continuations (#1013). Only AFTER folds
Drive H2. Task definitions, fakes, prompts, graders, harness and references are
identical across the four paid batches.

The surface is `six` (real meta tools plus execute_code), grading is `outcome`,
with route/advisory checks retained. Codex CLI 0.163.0 serves `gpt-6-luna`;
Claude Code 2.1.309 serves `claude-sonnet-5-5`. Each runs two repeats per task,
default effort, an eight-minute deadline and concurrency one. At most two trials
run simultaneously. All batches use Node 22.23.3 on linux-x64. The CLI isolates
sessions/tools; no explicit cache busting is added, and observed cache tokens are
reported. Each world generates fresh fake credentials under the neutral-credential
guard. No real Workspace data or service-account token is used.

Paid task-definition hash:
`56e66bd447b3fb1ed8bcd6a56d4c9623c86db9c6a3e7f4a7a7c8cece2b130edd`.
Harness hash:
`6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.

## Outcomes

D4 is new coverage and is reported separately. D1–D3 and D5–D7 measure existing
capabilities. Each task/model cell contains two trials.

| Task | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| D1 filtered files | 0/2 | 0/2 | 2/2 | 2/2 |
| D2 access join | 0/2 | 0/2 | 0/2 | 0/2 |
| D3 full pagination | 0/2 | 1/2 | 1/2 | 0/2 |
| D4 revision metadata (new coverage) | 0/2 | 0/2 | 0/2 | 2/2 |
| D5 binary upload once | 2/2 | 2/2 | 2/2 | 2/2 |
| D6 uncertain rename recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| D7 permitted role change | 2/2 | 2/2 | 2/2 | 2/2 |
| Existing capabilities | 6/12 | 7/12 | 9/12 | 8/12 |
| All tasks | 6/14 | 7/14 | 9/14 | 10/14 |

Combined preservation is **15/24 → 15/24**. D4 is **0/4 → 2/4**, bringing all-task
completion to **15/28 → 17/28**. All D5–D7 trials pass in both arms, including
exact upload bytes, MIME `application/octet-stream`, parents `["folder1"]`, one
physical mutation, no notification and read-back after the committed-500 rename.
There are no timeouts, runner errors, duplicate writes or unauthorized requests.

Sonnet's existing-capability score regresses by one: D3 changes 1/2 → 0/2.
BEFORE Sonnet repeat 1 (limit 5) and AFTER repeats 1/2 (limits 2/1) hit
execute_code's 20-host-call cap; their 21st call fails `budget_exceeded`.
Each then restarts with a higher limit and completes the new chain. The frozen
`full-pages` check rejects the unconsumed token from the earlier chain. AFTER
Luna repeat 2 hits the same cap with limit 5; BEFORE Luna repeat 1 stops its own
loop at 20 with limit 1. No trial has a cursor-binding, changed-arguments or
conflict refusal. These failures come from small page limits and the program
call cap, not a broken continuation. The earlier guide omitted the distinction
between `maxBytes` and `limit`; its contribution cannot be established at n=2.

Luna's recorded D3 score changes 0/2 → 1/2. Its AFTER repeat 1 pass has a grader
limitation: the frozen grader matches only path and `pageToken`, and the fake's
tokens are offset-derived. An abandoned name-search token (`empty`) counts as
consumed by an unrelated folder listing with the same path/token. The completed
folder enumeration is real, but the recorded pass does not prove every original
query chain was consumed. No result is rescored. The per-model regression was
reported before opening the PR; this sample establishes neither causal
improvement nor equivalence.

D1 BEFORE Luna repeat 1 returns id/name objects where the required answer uses
id strings. BEFORE repeat 2 stops with `p8` still pending and returns `[]`, citing
uncertainty over excluding another Workspace owner despite the observed owner.
AFTER repeat 1 stops at an unambiguous empty page with `hasMore:true` and a cursor;
that program makes only two calls. AFTER repeat 2 again returns objects instead
of id strings. D2 failures include treating supplied ids as file names, incomplete
source evidence, and object-valued permission holders where strings are expected.
Both AFTER Luna D4 failures treat `pdf1` as a name; repeat 1 discovers revision
operations but never invokes a revision read. Sonnet reads revision metadata in
both repeats. Deterministic references prove D4 is callable on AFTER and remains
unavailable on BEFORE. Prompts, fakes and graders are unchanged.

## Calls, discovery, tokens and latency

Discovery bytes include direct search/guide/details replies and serialized guest
`connecta.search`, `connecta.describe`, `connecta.skill` and hatch discovery results,
counted once. Failed attempts remain in tool-use counts. One failed BEFORE Luna
guest discovery attempt retains only its error code, so its unavailable reply
bytes are excluded; the JSON records that missing measurement. HTTP reads/writes
are physical fake data requests; token mints are separate. Duplicate-read counts
are diagnostics. Sonnet's increase from 14 to 61 comes mainly from switching
from `search_files` to `list_folder_items`, which re-reads folder metadata on
every page, as it did on main: 57 of its 61 duplicate reads are folder lookups;
two are in D1 and two in D5. This is not an attribution to abandoned chains.
Luna also incurs folder lookups and re-fetches of vendor pages shortened by the
local byte budget. `fields` is applied after byte fitting, so selecting only ids
does not increase the number of source rows fitted into that budget.

| Arm/model | Mean MCP calls | HTTP reads/writes | Duplicate reads | Total discovery bytes | Max per-trial / reply bytes | Mean wall seconds |
| --- | --- | --- | --- | --- | --- | --- |
| before / Luna | 7.21 | 126/6 | 31 | 435,464 | 89,433 / 21,302 | 23.85 |
| before / Sonnet | 5.07 | 88/6 | 14 | 113,090 | 15,256 / 11,608 | 18.50 |
| after / Luna | 7.93 | 170/6 | 62 | 363,136 | 63,555 / 19,955 | 25.43 |
| after / Sonnet | 4.64 | 157/6 | 61 | 218,872 | 34,960 / 20,186 | 19.12 |

| Arm/model | Input | Output | Cache read | Cache creation | API-equivalent cost |
| --- | --- | --- | --- | --- | --- |
| before / Luna | 327,067 | 10,772 | 1,813,376 | 0 | unknown |
| before / Sonnet | 154 | 15,464 | 459,733 | 76,373 | $0.506413 |
| after / Luna | 337,120 | 13,888 | 2,185,600 | 0 | unknown |
| after / Sonnet | 146 | 14,702 | 513,804 | 107,857 | $0.630120 |

Costs are CLI telemetry, not subscription invoices. Luna reports no dollar cost;
unknown is not zero. All arms have zero confirmation nudges and permission
denials. Each has 16 fake token mints, including cross-product attachment reads.
Per-trial approval gates, tool errors, failed attempts and destination paths are
retained in JSON. BEFORE named-tool use supports keeping the existing workflows;
no retirement was proposed. AFTER Sonnet uses `drive_api_read` for D4; Luna uses
operation search without completing that workflow. The full per-tool counts
include both direct and guest program calls.

## Reference-only and deterministic review follow-up

After the paid batches, the universal #1014 review rulings were applied. Drive's
references already contain no `raw: true`, and no out-of-repository preload was
used. Reference-only commit `972d25dd` selects `revisions.id` and
`revisions.modifiedTime` in D4's standard hatch call. It changes the task-file
hash because references share that file. The refreshed task-definition hash is
`6bf5fc1093fc578f01f3af586c1845204fdf48ba9af47ed6a89876844a20d8cb`;
the harness hash is unchanged. JSON records both file hashes and the unchanged
grade/task-construction digest. Prompts, fakes and graders are unchanged.

Commit `429b34d2` also puts write action words and explicit `Refused: …` reasons
inside compiled first sentences, initially with 13 raw-index query rows, and preserves root
and per-item `truncated` after fields selection on all six named reads. These
follow-ups are validated deterministically, separately from the paid source
snapshot; no paid trial was rerun or rescored. The authorized Forms
`google-controls.ts` envelope fix was not needed or applied. The round-1 fix now runs all
13 rows through the actual `drive_api_search` tool and checks its first two hits.
The accepted refusal query is `permanently delete a file`; the shared intent
ranker demotes refused operations for leading write verbs such as `delete file
permanently` (#1018). The guide now explains high row limits, byte budgets,
continuing the same listing, supplied ids and hatch paths without `/drive/v3`.
Named-list `maxBytes` and `fields` no longer participate in the cursor argument
binding. Short-lived `backgroundImageLink` values are withheld. These fixes and
the Docs #1015 merge are validated deterministically without new paid trials.
The merged task-definition hash is
`5023cf8db6abcf879f6f754697136463d42464b6c94ef3e81555a9c2e7b27842`;
the harness hash remains unchanged.

## Verification and size

The original BEFORE and AFTER selftest gates pass both surfaces and both grading
modes, with only the expected BEFORE D4 gap. The final AFTER reference selftest
repeats that matrix after the reference-only change. Counterexamples reject
wrong subjects, missing evidence, partial pages, wrong upload parents/MIME,
duplicate mutations and fabricated answers.

Original post-eval targeted Node coverage includes 264 passing provider/standards/conventions/
delegation/secret-boundary cases. The 37 selected failure-sweep cases, 69 golden
harness cases, 46 registry/generation/purity/package cases, Node 24 Eve check and
packed-consumer smoke also pass. All-provider Node goldens run with
`CONNECTA_GOLDENS_DETERMINISM=1`; workerd goldens/native/delegation checks run too.
`check:static` and `check:build` pass with `VITEST_MAX_WORKERS=2`. No full `check`
is run under the builder load policy; full INV/spec enforcement remains in CI.

After the Docs merge and round-1 fixes, all 1,149 cases across 28 targeted
Node suites pass, including every suite explicitly referencing Drive. All-provider
Node goldens pass determinism again (16/16); workerd goldens/native/delegation/
write-evidence checks pass (119 passing, 112 platform skips). The Drive
selftest repeats all seven references on both surfaces and both grading modes.
Static, build/declarations/bundle, the five Node 24 Eve cases and packed-consumer
smoke pass. All 65 non-Drive golden files match merged main byte for byte.
Round-1 log paths, hashes, runtime versions and source tree are recorded in JSON.

Collected test delta is **0**: Drive stays at 12 cases. New cursor, decision,
summary, safety and field-selection rows are folded into existing cases. Drive
leaves both pending lists. Only Drive's three stored goldens change: tool names,
schemas, standard envelopes/paging/truncation, errors/H2/H13, guide/conventions,
and operation summaries. Other providers' stored goldens match main byte for byte.

Node 22.23.3, esbuild 0.28.1 and gzip level 9 measure Drive **357,131 → 390,396 B**,
**+33,265 B** against the same main and dependencies. The all-six synthetic entry
is **417,678 → 451,230 B**, +33,552 B. These measurements describe the original
post-eval snapshot. The review round refreshes Drive's declared baseline and
remeasures against merged main `f9bf5afb`; those measurements are retained
separately in the JSON. Root, Worker, UI and example bundle caps pass without
adjustments.

Against merged main `f9bf5afb`, the final review snapshot measures Drive
**357,131 → 390,559 B (+33,428 B)** and all six Google products
**434,506 → 463,243 B (+28,737 B)** with the same Node 22 toolchain.
The generated Drive baseline is 390,559 B; Docs' baseline remains the merged
369,878 B measurement.

Fresh Node 22 process observations on bigserv measure import 3.65 → 3.44 s
(retained heap +42.92 → +44.05 MB), factory 44.6 → 120.5 ms (+0.40 → +1.00 MB),
cold named search 271.8 → 250.3 ms (+1.42 → +1.64 MB), and warm search
28.4 → 35.6 ms (+0.17 → +0.22 MB). These single samples ran under shared-machine
load and include tsx/import behavior; they imply no SLA or causal speed claim.
The underlying measurements and runtime versions are retained in JSON.

Public-contract drift is advisory: the compiled pin has no drift. `GET /apps`
does not accept the configured Drive scope and is explicitly refused; no scope
expansion is made. H2 and H13 are folded, H7 whole-binary withholding is retained,
and H9 is characterized without changing deadlines.
