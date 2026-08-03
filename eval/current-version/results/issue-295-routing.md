# Issue #295 routing evidence

The benchmark starts a fresh isolated Connecta server and Codex session for
each run. The prompts do not explain Connecta's routing workflow. Six cases
cover the routing boundaries requested by issue #295: one unknown read,
dependent reads, an in-program reduction, multiple discovered operations, an
ambiguous lexical candidate, and a nonstandard collection root.

| Measurement | Before | After |
| --- | ---: | ---: |
| Repetitions | 1 | 5 |
| Sessions | 6 | 30 |
| Correct result | 6/6 | 30/30 |
| Safety | 6/6 | 30/30 |
| Intended outer route | 1/6 (16.7%) | 29/30 (96.7%) |
| 95% route target | No | Yes |

The release audit stayed qualified. Definition tokens moved from 2,522 to
2,557 (+35, 1.4%); all 21 behavioral scenarios passed before and after.
Held-out discovery stayed at 93.1% top-1 accuracy, 100% positive recall, and
100% default-page recall.

Machine-readable traces are in `issue-295-before.json` and
`issue-295-after.json`. The corresponding release-audit evidence is in
`issue-295-before-audit.json` and `issue-295-after-audit.json`.
