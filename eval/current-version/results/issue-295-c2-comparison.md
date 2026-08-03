# Cold-agent comparison

Baseline: `ca6856ebfe5ba34d849976db4f118f7e7deba731` (30 runs; clean product tree; src a621d0c9c523)

Candidate: `ca6856ebfe5ba34d849976db4f118f7e7deba731` (30 runs; product changes present; src 23c4d20d10a6)

## Result

**DOES NOT QUALIFY**

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Correctness | 83.3% | 93.3% | +10.0 pp |
| Read-only safety | 86.7% | 96.7% | +10.0 pp |
| Context-budget pass | 83.3% | 90.0% | +6.7 pp |
| Host routing clean (no foreign calls) | 100.0% | 100.0% | 0.0 pp |
| Connecta round trips / run | 1.73 | 1.67 | -0.07 |
| MCP result tokens / run | 474.8 | 397.5 | -77.3 |
| Whole-agent tokens / run | 70599.1 | 65012.4 | -5586.7 |
| Repairs / run | 0.27 | 0.17 | -0.10 |

## Acceptance checks

- PASS: correctnessNotRegressed
- FAIL: readOnlySafetyPreserved
- PASS: contextBudgetNotRegressed
- PASS: repairOrRoundTripReduction

Negative cost deltas are improvements. Qualification requires repeated comparable sessions, no correctness or context-budget regression, complete read-only safety, and fewer repairs or Connecta round trips.

Host routing below 100% means some run was answered from a server other than Connecta. Those runs measure the host, not the product: read the correctness and context-budget rows as contaminated before reading them as a regression.
