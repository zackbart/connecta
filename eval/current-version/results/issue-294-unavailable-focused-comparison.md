# Cold-agent comparison

Baseline: `4222434a19605dd770b44c5159b5f40a46c92bcb` (5 runs; clean product tree)

Candidate: `4222434a19605dd770b44c5159b5f40a46c92bcb` (5 runs; product changes present)

## Result

**QUALIFIES**

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Correctness | 0.0% | 100.0% | +100.0 pp |
| Read-only safety | 100.0% | 100.0% | 0.0 pp |
| Context-budget pass | 100.0% | 100.0% | 0.0 pp |
| Connecta round trips / run | 2.00 | 1.80 | -0.20 |
| MCP result tokens / run | 268.2 | 322.6 | +54.4 |
| Whole-agent tokens / run | 63036.2 | 59328.8 | -3707.4 |
| Repairs / run | 0.20 | 0.20 | 0.00 |

## Acceptance checks

- PASS: correctnessNotRegressed
- PASS: readOnlySafetyPreserved
- PASS: contextBudgetNotRegressed
- PASS: repairOrRoundTripReduction

Negative cost deltas are improvements. Qualification requires repeated comparable sessions, no correctness or context-budget regression, complete read-only safety, and fewer repairs or Connecta round trips.
