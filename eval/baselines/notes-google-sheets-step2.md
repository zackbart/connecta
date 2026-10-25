# Google Sheets step 2 evaluation (#703)

A later [disclosed offline grader correction](./notes-google-grader-followups.md)
regrades every saved arm, including Gmail's separate refresh. The original
results and frozen-protocol statements below remain unchanged.

Seven fake-only workflows compare main's nine named tools with the nine retained
workflows plus four `sheets_api_*` tools. The [JSON summary](./google-sheets-step2.json)
retains all 56 trials, checks, final answers, requested/served models, CLI metadata,
per-tool attempts (including Drive), discovery bytes, writes and source/protocol
hashes. Original unmodified result JSON, saved worlds, logs and measurements remain
in `/home/zackbart/.t3/scratch/connecta-orchestrator/step2/sheets/`.
No trial was dropped, rerun or rescored.

## Frozen protocol and sources

BEFORE product source is clean main
`ff3f7c3b9cbf0e8958599834850876c24ab64d7e`, full source tree
`d5e26d1d940edb701274b996753418971dcf7bf2`. A clean reference-only snapshot,
`7bd944ff5340d1255b5aab7e373c671eed6064b7`, supplies the paid checkout. Its entire
`src/` tree equals main; this snapshot is preserved in the branch's merge history.
AFTER is clean `535ce06584b83ef8d1036c1301fdd78e92feec2b`, source tree
`407307124b301b7aaf810b4f8cc465d7b0e9cbd2`. The evaluation-artifact and provenance commits preserve that product source.
The later main merges bring Docs and Forms changes and refresh Sheets bundle facts.
The round-1 fixes below subsequently change Sheets discovery, guidance and refused-kind
messages; the paid trials measure the frozen source above, before those fixes. Both arms include H1 (#1008), the
route-neutral graders/checker fixes (#1011) and delegated-caller binding (#1013).

The reference-only change replaces S4's `get_spreadsheet.raw` call with a GET
metadata hatch and S7's raw call with the reviewed developer-metadata POST read.
No Sheets reference retains `raw: true`. Prompts, expected facts, fakes, task
construction and outcome graders are unchanged. Main's own reference adapters
passed selftests before freezing the common task file; the AFTER references passed
on the Sheets head. Reference functions are not executed by paid trials. Copying
only these reference changes into the baseline snapshot gives all four paid files
identical task/harness bytes without changing the main surface being measured.

Main's original task-file-set hash was
`56e66bd447b3fb1ed8bcd6a56d4c9623c86db9c6a3e7f4a7a7c8cece2b130edd`.
The common paid task-definition hash, refreshed for the reference-only change, is
`7a006a519437655daebeb4f379463f9205808fab7216cdda5f5a1a04bdb2b464`.
The common harness hash is
`6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
The unchanged portion of `google.ts` outside the reference function hashes to
`77920015877a4ccb76c919b8c26d7f90f86d3c02e42fa92b89fb089de9ddeacb`.
No shared grader or fake was modified by this product.

All paid batches use pair id `google-sheets-step2-2026-10-24`, the real `six`
meta-plus-execute_code surface and `outcome` grading with route/advisory evidence
retained. Codex CLI 0.163.0 serves `gpt-6-luna`; Claude Code 2.1.309 serves
`claude-sonnet-5-5`. Each runs two repeats per task, default effort, an eight-minute
deadline and concurrency one. At most two model trials run concurrently across
batches. Node is 22.23.3 on linux-x64. Every original is clean, complete and has
matching requested/served models, runtime/configuration and protocol fingerprints.
The CLI isolates sessions/tools, no explicit cache busting is added, and observed
cache tokens are retained. Fresh per-trial fake credentials pass the neutral-token
guard. No real Workspace data or service-account credentials are used.

## Outcomes and regressions

S7 is an ordinary comparable preservation row, included in every total. Main can
read the metadata through its legacy raw metadata route; BEFORE model failures
do not turn it into new capability credit. Each cell contains two trials.

| Task | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| S1 filtered cells | 0/2 | 0/2 | 2/2 | 2/2 |
| S2 workbook/range join | 1/2 | 2/2 | 2/2 | 2/2 |
| S3 full content paging | 2/2 | 2/2 | 1/2 | 2/2 |
| S4 metadata and bold format | 0/2 | 1/2 | 2/2 | 2/2 |
| S5 literal append once | 1/2 | 1/2 | 0/2 | 0/2 |
| S6 uncertain append recovery | 1/2 | 0/2 | 0/2 | 0/2 |
| S7 review metadata | 0/2 | 1/2 | 0/2 | 2/2 |
| All tasks | 5/14 | 7/14 | 7/14 | 10/14 |

Combined completion is **12/28 → 17/28**. Luna improves **5/14 → 7/14** and
Sonnet **7/14 → 10/14**. S7 is **0/4 → 3/4**, within the ordinary seven-task
comparison. There are no timeouts, runner errors, interruptions, duplicate writes
or unauthorized physical requests. The small sample does not establish causality
or equivalence.

The one per-task regression is Luna S6, **1/2 → 0/2**. Both AFTER attempts search
Drive for `sheets1` or the tab name instead of invoking Sheets with the supplied
spreadsheet id. Neither reaches append or reconciliation. One explicitly reports
no append, and the physical ledger confirms no Sheets write. This is a real task
completion loss and remains in the score. The supplied-id deferrals are BEFORE
S1 repeats 1/2, S4 repeats 1/2, S6 repeat 2 and S7 repeats 1/2; AFTER S1 repeats
1/2, S4 repeat 2, S5 repeat 1, S6 repeats 1/2 and S7 repeat 1. The independent
review counts the same **7/14 supplied-id deferrals in each arm**; only the
affected tasks shifted.
Neither arm's guide explicitly said a supplied id works as is. The review identifies
this as weak guidance shared by both arms, without attributing an AFTER miss to
a surface execution defect. The review-requested guide correction is described
below; no paid trial was rerun and the S6 regression remains in the scored table.

Luna gains a join, a formatting workflow and a metadata read; it successfully uses
both indexed read and write hatches. Sonnet gains one paging answer and both S7
reads. The BEFORE Sonnet paging failure reads the complete data but puts `record1`
in the final JSON's spreadsheet `id`. BEFORE Luna's failed join returns a
record-to-name object where the frozen expected `names` value is an array. These
answer-shape failures remain failures.

## Frozen append-path grader defect (review analysis only)

Nine trials fail only `only-requested-writes`: five BEFORE and four AFTER. The
frozen guard accepts exactly
`/spreadsheets/sheets1/values/'Alice''s costs'!A:D:append`. It rejects same-sheet
append calls using `A1:D1` or `A1:D7`, even when the saved world contains exactly
one requested row and all other required checks pass: RAW literals, INSERT_ROWS,
one physical append, correct final state, and recovery read-back where required.
These are all four Sonnet S5/S6 rows in each arm, plus BEFORE Luna S5 repeat 1.
The JSON records the canonical and observed paths beside their unchanged scores.

The independent Opus round-1 review confirms these nine failures are a defect in
the frozen grader: the prompts specify the sheet, not an exact append range, and
values.append uses that range to find the table. The saved calls target the correct
sheet and satisfy every other required check.

The reviewer's **range-neutral diagnostic recount is 17/28 BEFORE → 21/28 AFTER**
(Luna 6/14 → 7/14; Sonnet 11/14 → 14/14). This is analysis only: no grader, saved
grade, trial status or scored table is changed. The primary scores remain
**12/28 → 17/28**. The grader defect does not explain Luna's S6 regression,
whose AFTER trials never dispatched the requested append.

The shared follow-up is [#1024](https://github.com/zackbart/connecta/issues/1024),
covering the range-strict Sheets grader and supplied ids treated as names.

## Calls, discovery, tokens and latency

Discovery bytes count direct search/guide/details replies and serialized guest
`connecta.search`, `connecta.describe`, `connecta.skill` and hatch discovery replies
once each. Failed attempts remain in tool counts. Two BEFORE Luna and four AFTER
Luna failed guest discoveries retain no result bytes; the JSON marks these missing
measurements instead of estimating them. HTTP counts are physical business
requests; token mints are separate. Duplicate-read metrics include legitimate
content paging, verification and abandoned read paths.

| Arm/model | Mean MCP calls | HTTP reads/writes | Duplicate reads | Total discovery bytes | Max trial / reply bytes | Mean wall seconds |
| --- | --- | --- | --- | --- | --- | --- |
| before / Luna | 6.93 | 64/3 | 4 | 390,163 | 63,584 / 24,906 | 20.55 |
| after / Luna | 8.50 | 87/2 | 8 | 456,926 | 82,883 / 30,067 | 24.18 |
| before / Sonnet | 5.64 | 49/6 | 5 | 161,553 | 29,192 / 19,332 | 16.24 |
| after / Sonnet | 6.14 | 52/6 | 7 | 210,161 | 22,451 / 16,114 | 18.20 |

| Arm/model | Input | Output | Cache read | Cache creation | API-equivalent cost |
| --- | --- | --- | --- | --- | --- |
| before / Luna | 355,854 | 9,879 | 1,734,912 | 0 | unknown |
| after / Luna | 355,678 | 12,077 | 2,297,088 | 0 | unknown |
| before / Sonnet | 164 | 13,536 | 520,808 | 76,952 | $0.495577 |
| after / Sonnet | 180 | 15,422 | 639,572 | 92,408 | $0.588169 |

Cost is CLI telemetry, not a subscription invoice. Luna's dollar cost is unknown,
not zero. All arms record zero confirmation nudges and permission denials; the
supplied-id clarification deferrals above still fail their tasks. Per-trial host
approval gates, errors, maximum latency, tool attempts and physical write targets
are retained in JSON. Token mints are 17/21 BEFORE and 21/23 AFTER for Luna/Sonnet.
BEFORE use of cell paging, append and guarded batches supports retaining those
workflows. All nine named tools remain; no retirement was proposed from two repeats.

## Verification, goldens and size

The seven selftests pass with their surface-specific reference adapters on main
and the measured Sheets head, across both surfaces and both grading modes. The
committed append network/body failures reconcile without replay, and no-op,
wrong-subject, missing-evidence, partial-page and duplicate-write controls fail.
The shared envelope control passes unchanged, so the conditional Forms
`google-controls.ts` fix was not needed or applied.

The standards/conventions and Sheets suites pass **78/78**, including both formerly
known checker failures. The selected cross-provider/caller/failure rows pass
**31/31**. Sheets deterministic Node goldens and all **16** workerd provider goldens
pass. `check:static`, `check:build`, the Node 24 Eve check and packed-consumer smoke
pass with `VITEST_MAX_WORKERS=2`. No full `check` is run under the common load policy;
complete INV/spec enforcement remains in CI. Public-contract drift reports no drift
across the 17 endpoints or against the archived revision 20261019 pin.

Collected test delta is **0**: the affected provider/failure-sweep collection is
**445 → 445**. New caller-A/B, tampered/legacy cursor, selected-field truncation,
first-sentence summary and natural-query assertions are folded into existing rows.
A's signed cursor is refused for mapped caller B before any API request or token
mint, while A continues. Both named reads restore `truncated` after `fields`;
`get_values` also preserves its page. All 17 compiled first sentences fit 120
characters and retain eval-write action words and applicable refusal reasons.

Only Sheets' stored goldens change: tool names, input/output schemas, envelopes,
standard cursors/truncation, errors, guide/conventions and indexed summaries.
Every other provider's goldens remain byte-identical to main. Sheets leaves
`PENDING.step2`. Held H5 incomplete-read wording is folded; H9 is measured without
changing deadlines. Cell values remain requested data under S6, with no privacy
widening argument. Preview comments/external-data-source batch guards remain.

Like-for-like Node 22.23.3, esbuild and gzip level 9 measure standalone Sheets
**353,251 → 394,761 B**, **+41,510 B**. The all-six Google entry is
**418,022 → 461,176 B**, +43,154 B. Product growth is below the +60 KB threshold.
Historical budget baselines and caps are unchanged; root/Worker/UI/example caps
pass. Local cold/warm H9 samples and their limitations remain in the provider's
`evidence/review.md` and scratch timing JSON; they imply no latency guarantee.

## Original artifact hashes

The filenames below resolve in the scratch directory stated above. Original JSON
includes complete saved grading inputs; this committed summary retains every
trial's result/checks and enough provenance to locate those immutable originals.

| Arm/runner | Original JSON | SHA-256 |
| --- | --- | --- |
| before / codex | `before-luna.json` | `e4888e0e6f1077c375e7483bf4fc983f9ffdabf434026077b5e08a2cdb777b26` |
| before / claude | `before-sonnet.json` | `daf722457eeea3ff526f6ad525fe332ab1f9aad0beb322b7660bc54184c2f945` |
| after / codex | `after-luna.json` | `f308114cd34749d8242f3481f417385547a1019eed8b8fae2cd73f9e6df5326e` |
| after / claude | `after-sonnet.json` | `80e3b398bc433306c13e523fb6e5fc1ccf7c034de6367fe04dd63e36c5745d6b` |

## Post-eval merge of Docs #1015

Main `f9bf5afb` is merged into the Sheets branch without rebasing. Both products
are retained in migration/setup documentation, pending-list removals, eval
reference adapters and fixtures, and the representative hatch failure sweep.
Docs source, its eval evidence and its goldens match main. All 65 non-Sheets
golden files are byte-identical to main. The source review still targets
`f0ea7223`; this merge applies no review fixes and runs no additional paid trials.

The post-merge task-definition hash is
`8212d4a30ad170accf7fce9ee985ed2af0b937651af09d469259f38ea324c914`
from the inherited Docs reference/boundary adapter updates. The common harness
hash remains `6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
These are merge-validation fingerprints. The four paid originals, their
fingerprints and all 56 grades above are retained unchanged.

Fresh matched Node 22.23.3/esbuild 0.28.1/gzip-9 measurements against this main
are Sheets **353,251 → 394,761 B** before recording bundle facts, **+41,510 B**;
the final source including those facts is **394,793 B**, **+41,542 B**.
The all-six Google entry is **434,797 → 472,507 B**, **+37,710 B** including
the facts. Docs measures **370,111 B** in both trees. Its reviewed snapshot
baseline **369,878 B** and note are preserved. Sheets' report-only snapshot
baseline is refreshed to **394,761 B** through its declaration and provider
generation; no cap changes. These merge measurements supersede the earlier
combined-bundle sample for the current branch, not the paid-run evidence.

Merge validation passes: **541** selected Node cases, deterministic Docs/Sheets
Node goldens, all **16** workerd provider goldens, `check:static` and
`check:build`. All **42** Google reference tasks match expected outcomes across
both surfaces and both grading modes, including the expected Drive D4 capability
gap and committed network/body recovery variants. The final byte audit again
confirms all **65** non-Sheets golden files match main. The original four paid
JSON hashes still match, test delta remains **0**, and no review fixes are applied.

## Round-1 fixes and Forms #1014 merge

The review fixes are committed on top of 6e9f9e07, followed by a merge of main
`84fb4eee` (the full commit is recorded in JSON). Both products' documentation,
pending-list removals, reference entries, eval fixtures and hatch failure coverage
are retained. The inherited `google-controls.ts` envelope-control fix is exactly
main's #1014 version; this product adds no local shared-control change. Forms and
Docs source and all 65 non-Sheets golden files match this main byte for byte.

The batch summary uses the reviewer's exact first sentence. A Sheets-local
`spreadsheets ranges headers` discovery category supplies the nouns missing from
the 115-character summary, without changing method/path/schema/verdict admission
or the shared ranker. Sort range, merge cells, delete rows, rename sheet and freeze
header row now rank batchUpdate first. A 42-query surface probe loses no prior
top-two batch match. These rows, sort rows, and assertions for all ten actual
refusal reasons on named and hatch batches are folded into existing test cases.
The round-1 guide and id parameter accepted a supplied `sheets1` as is, named
`get_spreadsheet` and `append_values`, and reserved Drive searches for names.
Migration notes disclose the shared builder's omission of create/add/append
`destructiveHint:false` (#1017); approval routing is unchanged. Unrelated fixture
Unicode escaping is restored. No paid trials are rerun for these fixes; the scored
table and all 56 saved trial grades remain the original frozen comparison.

The post-Forms merge task-definition hash is
`1a4f873d0aba4e7cb50a8b02a5743d4dc2cabf24f5f4e609004a62a88c48e923`;
the harness hash remains
`6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
This is a validation fingerprint, not the paid-run task fingerprint. The merged
source includes the review changes to discovery, guidance and refusal messages.

Matched Node 22.23.3/esbuild 0.28.1/gzip-9 measurements against clean main
84fb4eee are Sheets **353,251 → 395,008 B (+41,757 B)** including bundle facts;
the all-six Google entry is **448,880 → 481,506 B (+32,626 B)**. Docs stays
**370,111 B** and Forms stays **372,171 B**. The refreshed report-only Sheets
baseline is **394,998 B** before embedding the new facts. Other providers'
approved baselines and all caps are retained. These measurements supersede the
pre-Forms bundle report for the current head.

Merged validation passes all **679 non-Forms selected Node cases**, including
Sheets, Docs, standards/conventions, the shared failure sweep, delegation and
content-cut safety. Sheets deterministic Node goldens, all **16** workerd provider
goldens, `check:static`, `check:build`, Node 24 Eve checks and packed-consumer smoke
pass with `VITEST_MAX_WORKERS=2`. The affected collection is **445 → 445**, test
delta **0**. No full local `check` or additional paid trial is run.

An extra run of the unchanged Forms suite exposes an inherited local failure:
its large-form paging test exceeds its explicit 30-second timeout. It also times
out on clean main 84fb4eee under the same Node 22 environment. The first expanded
run's following anchor-deletion assertion fails; that cursor test passes in the
isolated Forms rerun (**4 pass, 1 timeout**). No Forms source, tests or goldens
are edited to address this upstream timing issue. All non-Sheets golden bytes
remain identical to main.

The final all-Google selftest matches expected outcomes for all **42 tasks** on
both surfaces and both grading modes (**168 combinations**, plus transport and
12 committed network/body recovery controls; **182** successful control rows).
Drive D4 retains its expected BEFORE capability gap and failed task outcome.
No trial result is reclassified by this validation. The final byte audit confirms
all **65** non-Sheets golden files remain identical to main 84fb4eee.

## Approved round-2 follow-ups

The approved `v4-suggested.patch` gives values.get and values.batchGet the
Sheets-local `spreadsheets.values rows headers` discovery category. A tool search
for "read header row" now leads with GET values:batchGet; "update range" retains
the reviewed structural batch match. Both queries are rows in the existing tool
search test, and the index-bound discovery cursor is refreshed. Both batch
entrypoints check refused-kind membership with `Object.hasOwn`; prototype-named
unknown kinds retain an ordinary unknown-kind refusal without sending or minting.
These assertions add no test cases.

The S-task scores above were produced with the original, frozen pre-round-1
wording. The supplied-id clarification and its `sheets1` example were introduced
after those paid runs. The example is now removed from the shipped guide and
spreadsheetId description; supplied ids still work as is. Neither guide revision
was evaluated in a new paid trial. All 56 saved trial grades, the scored table,
and the original **12/28 → 17/28** comparison are unchanged. The range-neutral
recount remains analysis only; [#1024](https://github.com/zackbart/connecta/issues/1024)
owns the grader and supplied-id follow-ups.
