# Disclosed Google grader correction (#1024)

This is an offline regrade of all **120 saved trials** from ten Sheets/Gmail
result files, including Gmail's separate eight-trial post-fix refresh. No model
ran, no saved program executed, and no downstream request was sent. The
[companion JSON](./google-graders-1024.json) records every original and corrected
status/check, all ten raw-artifact hashes, original protocol/source metadata,
and the exact grader source hash. All raw hashes match the previously published
summaries. Replaying the original grader first reproduced all 120 original
statuses and required check verdicts; every corrected replay has complete saved
evidence. Original JSON, source hashes and scored tables are unchanged.

Two narrow rules change. Gmail G3's prompt says "sorted", so its exact complete
100-id answer may use numeric or lexical order. Unsorted lists, duplicates,
omissions, extra ids and a wrong source still fail. Sheets S5 and S6 both use
`values.append` to search a table on Alice's costs. Equivalent A..D ranges
(`A:D`, `A1:D1`, `A1:D7`, or other valid positive row bounds) are accepted on
that exact sheet and workbook. Wrong sheets, columns, workbook and malformed
ranges still fail even if the synthetic final state matches. Literal values,
insert-rows mode, the exact requested row, a successful verification read and
single-write accounting remain required. S6 uses the same append-range rule as
S5; four of the nine original range-only failures belonged to S6.

| Product / arm | Model | Original | Corrected |
| --- | --- | ---: | ---: |
| Sheets BEFORE | Luna | 5/14 | 6/14 |
| Sheets BEFORE | Sonnet | 7/14 | 11/14 |
| Sheets AFTER | Luna | 7/14 | 7/14 |
| Sheets AFTER | Sonnet | 10/14 | 14/14 |
| Gmail BEFORE | Luna | 12/14 | 12/14 |
| Gmail BEFORE | Sonnet | 10/14 | 12/14 |
| Gmail AFTER | Luna | 9/14 | 10/14 |
| Gmail AFTER | Sonnet | 10/14 | 12/14 |
| Gmail post-fix AFTER (G3/G4 only) | Luna | 3/4 | 4/4 |
| Gmail post-fix AFTER (G3/G4 only) | Sonnet | 2/4 | 4/4 |

Sheets combined becomes **17/28 BEFORE → 21/28 AFTER**, compared with the
original **12/28 → 17/28**. Gmail becomes **24/28 → 22/28**, compared with
**22/28 → 19/28**; its separate post-fix subset becomes **8/8** instead of
**5/8**. The refresh is still AFTER-only and does not replace the original
comparison. Nine Sheets range checks and eight Gmail answer checks change;
no other check changes. Luna's Sheets S6 regression still remains: its AFTER
trials did not dispatch the requested append. Gmail's one original AFTER
paging omission still fails. Two repeats remain a small correlated sample,
not a reliability estimate.

The existing provider guides already tell agents to use supplied ids directly;
no provider guidance or product behavior changes here. Grader controls exercise
the real task functions with offline world/trace evidence, including wrong
state, unverified appends and duplicate writes. Original prompts, expected
canonical answers, fakes, reference programs and all product source stay fixed.

To replay an individual raw artifact with the corrected grader, use the existing
`pnpm run eval:regrade --grading outcome --in <original.json> --out <new.json>`
from an installed checkout. Output must differ from input. The raw-artifact paths
and hashes in the companion JSON identify all ten source files. The complete
batch/hash/baseline-verification script and logs are retained under
`/home/operator/.t3/scratch/connecta-effect-core-20261025/evidence/eval-graders/`.
