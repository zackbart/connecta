# Agent routing guidance A/B

Generated: 2026-07-29

Control: `a4e4b599e37dbb943b2de783d7934dd7d188cad1`

Candidate: `abcfa9c0853682c3460e523231f50fb9e1dd6767`

Both arms used Codex CLI 0.145.0, pinned `gpt-5.6-sol`, Node 26.5.0 on
darwin-arm64, five repetitions, concurrency three, repetition-major ordering,
and the same merged issue-213 trace/fixture harness. Each of the 30 runs in an
arm received a fresh Connecta server and ephemeral Codex session with host
apps, plugins, browser, computer-use, multi-agent, goals, tool suggestion, and
skill search disabled.

## Candidate

The candidate changed only always-loaded routing guidance:

- ordinary unknown-address tasks use one focused compact-schema search and
  call directly when that shape is sufficient;
- `describe_tools` remains reserved for ambiguity or exact constraints;
- real dependent/reduction workflows start with `execute_code` and discover
  inside that execution;
- one-call, independent-call, and search-only work does not use code mode; and
- ordinary search-to-call routing does not fetch the usage skill.

It removed the `execute_code` search-only example and the
`search_tools → describe_tools → execute_code` workflow line. Ranking, schemas,
limits, result representation, and runtime behavior were unchanged.

## Result

| Measure | Control | Candidate | Change |
| --- | ---: | ---: | ---: |
| Exact executed-address accuracy | 29/30 (96.7%) | 29/30 (96.7%) | 0 pp |
| Exact argument accuracy | 29/30 (96.7%) | 29/30 (96.7%) | 0 pp |
| Final-result accuracy | 30/30 (100%) | 30/30 (100%) | 0 pp |
| Intended minimal route | 20/30 (66.7%) | 19/30 (63.3%) | -3.3 pp |
| Dependent-case minimal route | 0/5 | 0/5 | 0 pp |
| Compact-sufficient runs using `describe_tools` | 1/30 (3.3%) | 1/30 (3.3%) | 0 pp |
| Usage-skill fetches | 1 | 0 | -1 |
| Nested search calls | 4 | 8 | +4 |
| Outer Connecta round trips | 55 | 56 | +1 |
| Search-result tokens | 15,943 | 16,807 | +5.4% |
| Estimated irrelevant search tokens | 9,425 (59.1%) | 10,333 (61.5%) | +2.4 pp |
| All Connecta result tokens | 20,416 | 24,876 | +21.8% |
| Whole-agent input tokens | 2,092,951 | 2,193,641 | +4.8% |
| Non-cached input tokens | 383,639 | 582,377 | +51.8% |
| Summed agent latency | 393,205 ms | 463,473 ms | +17.9% |
| Clean page-search accuracy | 5/5 | 5/5 | 0 pp |
| Pressure page-search accuracy | 5/5 | 5/5 | 0 pp |

The candidate moved every dependent run's discovery inside code mode, but it
did not make the route one-pass. All five candidate runs used two outer
`execute_code` calls: the first searched and returned or retained discovery
state, and the second performed the dependent calls. Two runs searched twice
inside the sandbox. Control also used two outer round trips in every dependent
run, split between `search_tools → execute_code` and repeated `execute_code`.

This is the causal result: concise routing prose can move discovery across the
boundary, but it does not make the agent compose discovery and dependent calls
in one program. The extra nested work increased Connecta and host context
instead of reducing either.

One accuracy miss occurred in each arm on the workflow-by-id task. In both,
the agent first called `builds.get_workflow_run` with `run_id`, received the
validated argument error, and retried with `runId`. The final result remained
correct, but exact execution and argument scoring correctly counted the extra
attempt. This was not changed by the candidate.

## Acceptance gates

| Gate | Result |
| --- | --- |
| All outer and nested discovery attributed | pass |
| Realistic arguments and dependent results validated | pass |
| Deterministic positive recall 100%; top-1 at least 93.1% | pass: 100%, 93.1% |
| Repeated exact-address accuracy at least 95% | pass: 96.7% |
| Minimal-route rate improves by at least 20 percentage points | fail: -3.3 pp |
| `describe_tools` in at most 10% of compact-sufficient runs | pass: 3.3% |
| Irrelevant search-token share below 40% | fail: 59.1% control, 61.5% candidate |
| Non-cached whole-agent input improves | fail: +51.8% |
| Clean/pressure accuracy within five percentage points | pass: 0 pp |
| 10,000-tool warm-search p50 below 5 ms | pass: 3.052 ms distributed, 2.757 ms wide |

## Decision

Do not ship the candidate guidance. The A/B provides no evidence that the
additional dependent-route wording improves route shape, token use, or
latency. The final product tree therefore remains the control.

Also do not add another general routing paragraph. The next experiment should
target the observed code-mode failure narrowly: whether one concrete,
one-pass dependent example can make the agent continue from in-sandbox
discovery to both dependent calls in the same function. That experiment should
reuse this harness and must beat the 66.7% rebaselined overall minimal-route
rate without regressing exact address/argument accuracy. Follow-up:
[#215](https://github.com/zackbart/connecta/issues/215).

## Evidence

- `issue-213-control.json` / `issue-213-control.md`
- `issue-213-candidate.json` / `issue-213-candidate.md`
- `issue-213-final-audit.json` / `issue-213-final-audit.md`
- `issue-213-final-logic.json`
