# Issue #295 routing evidence

The benchmark starts a fresh isolated Connecta server and Codex session for
each run. The prompts do not explain Connecta's routing workflow. Six cases
cover the routing boundaries requested by issue #295: one unknown read,
dependent reads, an in-program reduction, multiple discovered operations, an
ambiguous lexical candidate, and a nonstandard collection root.

Both arms in the table below were run at five repetitions and concurrency five,
with the same harness, the same fixtures, and the same scorer. The only
difference between them is the guidance text: the before arm is commit
`4222434` (the guidance as it stood before this change), the after arm is this
branch. An earlier version of this file compared a one-repetition before arm
against a five-repetition after arm; that table compared sample sizes as much
as guidance and has been replaced.

| Measurement | Before | After |
| --- | ---: | ---: |
| Repetitions × cases | 5 × 6 = 30 | 5 × 6 = 30 |
| Intended outer route | 9/30 (30.0%) | 25/30 (83.3%) |
| Overall `passed` | 9/30 (30.0%) | 25/30 (83.3%) |
| Final answer correct | 30/30 | 30/30 |
| Expected executions only | 30/30 | 28/30 |
| Safety | 30/30 | 28/30 |
| `foreignClean` | 30/30 | 30/30 |
| `costEfficient` | 12/30 | 25/30 |
| Connecta result tokens | 22,627 (754.2/run) | 10,756 (358.5/run) |
| Connecta round trips | 58 | 53 |
| 95% route target | No | No |

## Route compliance per case

| Case | Before | After |
| --- | ---: | ---: |
| single-read | 3/5 | 5/5 |
| dependent-read | 1/5 | 0/5 |
| dependent-reduction | 0/5 | 5/5 |
| multi-operation-discovery | 0/5 | 5/5 |
| ambiguous-candidate | 5/5 | 5/5 |
| nonstandard-collection-root | 0/5 | 5/5 |

Five of six cases moved to full compliance and Connecta result tokens more than
halved. The 95% acceptance criterion in issue #295 is **not** met: 83.3% route
compliance is short of it, and every remaining failure is `dependent-read`.

## Why dependent-read still fails

In all five `dependent-read` runs the agent reached the answer but spent more
than one `execute_code` call to do it. The first program discovers, chains
`builds.get_workflow_run` → `builds.get_job_logs`, and returns the data; the
agent then issues a second program to reshape that result into the requested
array rather than trusting the first return. The route policy for the case
allows exactly one outer `execute_code`, so those runs fail `routePassed` and
`costEfficient` even though the final answer is right.

Two of the five (repetitions 4 and 5) also tried a lexically adjacent sibling —
`builds.rerun_failed_jobs` — with invented arguments before finding the correct
pair. Those calls were rejected by argument validation and never reached the
connector, but they count as unexpected executions, which is the whole of the
28/30 on expected-executions and safety. Both runs still returned the correct
final answer.

Prior evidence for this case is not comparable. It was measured while the
`execute_code` description carried the hint `(failedJobId supplies jobId)` —
the name of a field in this benchmark's own `builds` fixture. That is tuning on
the test: it taught the model the exact chaining key the case needs. The hint
has been removed from the shipped description, and this case's measured
compliance fell with it. The honest reading is that the earlier `dependent-read`
number was bought by the leak, not earned by the guidance.

## Host protocol probes are not foreign tool calls

Both arms show Codex calling `list_mcp_resources` and
`list_mcp_resource_templates` (five occurrences after, nine before). Those are
the host enumerating a connected server's MCP resources on its own initiative —
protocol introspection, not the agent reaching for a tool outside Connecta. The
scorer allowlists them, reports them separately as `hostProtocolProbes`, and
`foreignClean` counts only calls the agent chose. Under that definition both
arms are 30/30 clean; no agent-chosen foreign call was recorded in either arm.

## Cost envelopes

`ambiguous-candidate` carries a 750-token result envelope. The earlier 650
could not be met: the intended `search_tools` → `call_tool` route costs 681
tokens against this fixture in every recorded run, so the case failed
`costEfficient` deterministically on the route it was built to reward. A budget
no correct route can meet measures the budget, not the agent.

## Definition cost

Definition tokens moved from 2,522 to 2,589 (+67, 2.7%). That is more than the
+35 measured mid-review, and the difference is two deliberate additions: the
`connecta.batch` clause again explains *why* a typed failure beats a thrown
message, and the top-level search guidance is now scoped to read-only work so
that multi-step destructive work still has a route to
`call_destructive_tool`. Both always-loaded strings remain inside their enforced
ceilings (server instructions ≤ 1,000 characters, the `execute_code`
description < 4,400).

The release audit stayed qualified in both arms: 21/21 behavioral scenarios,
93.1% held-out discovery top-1 accuracy, 100% positive recall, and 100%
default-page recall, unchanged before and after.

The after arm's JSON records `source.commit` as `a98bc18`, the commit checked
out while it ran; the guidance text it measured was uncommitted at that moment
and landed in the commit that carries this file. The before arm ran from a
detached worktree at `4222434`, so its recorded commit is exact.

Machine-readable traces are in `issue-295-before.json` and
`issue-295-after.json`. The corresponding release-audit evidence is in
`issue-295-before-audit.json` and `issue-295-after-audit.json`.
