# Cold-agent comparison

Baseline: `4222434a19605dd770b44c5159b5f40a46c92bcb` (12 runs; clean product tree)

Candidate: `4222434a19605dd770b44c5159b5f40a46c92bcb` (12 runs; product changes present)

## Result

**DOES NOT QUALIFY**

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Correctness | 75.0% | 66.7% | -8.3 pp |
| Read-only safety | 100.0% | 100.0% | 0.0 pp |
| Context-budget pass | 66.7% | 50.0% | -16.7 pp |
| Connecta round trips / run | 3.25 | 2.58 | -0.67 |
| MCP result tokens / run | 1396.6 | 1427.8 | +31.2 |
| Whole-agent tokens / run | 117995.9 | 104530.8 | -13465.1 |
| Repairs / run | 0.58 | 0.25 | -0.33 |

## Acceptance checks

- FAIL: correctnessNotRegressed
- PASS: readOnlySafetyPreserved
- FAIL: contextBudgetNotRegressed
- PASS: repairOrRoundTripReduction

Negative cost deltas are improvements. Qualification requires repeated comparable sessions, no correctness or context-budget regression, complete read-only safety, and fewer repairs or Connecta round trips.
