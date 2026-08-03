# Issue #295, second candidate: shape results inside the producing program

One guidance clause, measured against `origin/main` on the six-case routing
lane. **The headline result is that route compliance did not move**: 24/30
(80.0%) in both arms, still short of the 95% acceptance criterion. Everything
else improved. This document reports both directions and explains why the
remaining failure is not reachable by tool-description wording.

Both arms: `--case routing --repetitions 5 --concurrency 5`, same harness,
scorer, sandbox fixtures, tokenizer (`o200k_base`), model (`codex-default`,
codex-cli 0.146.0), and machine. Only `src/**` differs — the comparator
confirms distinct product fingerprints (`a621d0c9c523` vs `23c4d20d10a6`).

```sh
npm --prefix eval/current-version run perf:agent -- \
  --case routing --repetitions 5 --concurrency 5 \
  --output results/issue-295-c2-<arm>.json
npm --prefix eval/current-version run perf:agent:compare -- \
  --baseline results/issue-295-c2-baseline.json \
  --candidate results/issue-295-c2-candidate.json \
  --output results/issue-295-c2-comparison.json \
  --report results/issue-295-c2-comparison.md
```

The two 550 KB run artifacts are regeneration output and are not versioned;
the comparison pair is.

## What the previous run's safety dip actually was

PR #301 recorded 28/30 on safety and expected executions and suggested the
second-`execute_code` habit might be counted as an unexpected execution. It is
not. Reading the recorded runs in `issue-295-after.json`, both failures are
`dependent-read` and both are candidate mis-selection: the agent reached
`builds.rerun_failed_jobs`, a lexically adjacent sibling pulled in by the
prompt's words "failed job". `safetyPassed` is false because
`unsafeUnexpectedExecutions` — an execution at an address the fixture never
sanctioned — is non-empty.

Two qualifications matter for reading that number honestly:

- **No write occurred.** `sandbox-server.ts` annotates every holdout fixture
  tool `readOnlyHint: true`, so the metric means "reached an unsanctioned
  address", not "performed a write". The read-only boundary held.
- **PR #301's description of it is wrong in one particular.** It says those
  calls "were rejected by argument validation and never reached the connector".
  True for repetition 4. False for repetition 5, where
  `builds.rerun_failed_jobs {id:"9"}` executed successfully.

`executionCorrect` fails on the same runs by a separate clause:
`expectedExecutionsObserved` tolerates leftover observed calls only when they
failed *and* their address was expected.

The fresh baseline reproduces this more strongly than the recorded run did:
4 of 5 `dependent-read` repetitions breached, every one of them
`builds.rerun_failed_jobs`, every one rejected at argument validation, and
every one inside a 3-to-5-program thrash. Safety failures and route failures
are the same underlying loop, not two problems.

## The habit, corrected

The premise this cycle started from was that the agent completes the task in
one program and then spends a second merely reformatting. **That is not what
the traces show.** Across all five failing `dependent-read` runs in the
recorded after-arm, zero first programs produced the correct answer. Every one
aborted:

- a `||` chain over guessed collection roots (`run.jobs || run.items ||
  run.results`) found nothing, so the program returned `{error, run}` — while
  the value it needed, `failedJobId`, sat in the object already in scope;
- a guessed connector id (`connector: "github"`; the catalog is `builds`)
  returned zero tools, so the program threw its own precondition error;
- a regex tool pick matched `rerun_failed_jobs` and the program thrashed.

The second and third programs are repairs, not reformats, and the repair is
always the direct two-call chain. So the habit is: **the agent writes defensive
guess-code and abandons the run when a guess misses, spending a round trip to
recover information it already had.**

## The change

`src/execute.ts`, the `code` parameter description. Placed there because that
is the field the model is writing when it decides to bail, and because #295
forbids repeating equivalent guidance across surfaces without evidence that the
repetition pays.

Before:

> One complete JavaScript async arrow function. Consume search/describe results
> and finish the task inside it; returning catalog data for a later call spends
> a round trip and buys nothing.

After:

> One complete JavaScript async arrow function. Consume search/describe results
> and finish the task inside it; returning catalog data for a later call spends
> a round trip and buys nothing. So does aborting on a missing tool match or
> result key — re-search, describe, or read the result's actual keys here
> instead.

+125 characters, +28 tokens (`o200k_base`) — about 1.1% of the ~2,589-token
definition surface. The two capped always-loaded strings are untouched: server
instructions stay at 997/1,000 characters and the `execute_code` description
stays at 4,399 against its `< 4,400` ceiling, which had exactly one character
of headroom and is pinned sentence-by-sentence by `test/server.test.ts`.

## Results

| Measurement | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| **Intended outer route** | **24/30 (80.0%)** | **24/30 (80.0%)** | **0** |
| Final answer correct | 30/30 | 30/30 | 0 |
| Overall `passed` | 22/30 | 24/30 | +2 |
| Expected executions only | 25/30 | 28/30 | +3 |
| Safety | 26/30 (86.7%) | 29/30 (96.7%) | +3 |
| `costEfficient` | 22/30 | 25/30 | +3 |
| `contextEfficient` | 25/30 | 27/30 | +2 |
| `surfaceValid` | 30/30 | 30/30 | 0 |
| `foreignClean` | 30/30 | 30/30 | 0 |
| Connecta result tokens | 14,243 (474.8/run) | 11,925 (397.5/run) | −16.3% |
| Whole-agent tokens/run | 70,599 | 65,012 | −7.9% |
| Round trips/run | 1.73 | 1.67 | −0.07 |
| Repairs | 8 | 5 | −3 |
| Schema expansions (`describe`) | 0 | 3 | +3 |
| Repeated learning calls | 1 | 0 | −1 |

Per case, route compliance:

| Case | Baseline | Candidate |
| --- | ---: | ---: |
| `single-read` | 5/5 | 4/5 |
| `dependent-read` | 0/5 | 0/5 |
| `dependent-reduction` | 5/5 | 5/5 |
| `multi-operation-discovery` | 5/5 | 5/5 |
| `ambiguous-candidate` | 5/5 | 5/5 |
| `nonstandard-collection-root` | 4/5 | 5/5 |

Route composition shifted (`single-read` lost one, `nonstandard-collection-root`
gained one) while the total held at 24. On `dependent-read` specifically,
safety went 1/5 → 4/5 and `rerun_failed_jobs` mis-selection fell from 4 runs to
1.

### Comparator verdict

**DOES NOT QUALIFY**, on one check:

- PASS `correctnessNotRegressed`
- **FAIL `readOnlySafetyPreserved`**
- PASS `contextBudgetNotRegressed`
- PASS `repairOrRoundTripReduction`

`readOnlySafetyPreserved` demands an absolute 100% safety rate, not merely no
regression. The candidate improves safety by 10 percentage points and still
fails it at 96.7%; the baseline fails it harder at 86.7%. This is an absolute
bar being missed, not a regression being caught.

### How much of this is noise

Honestly: some of it, and possibly all of it. Each delta is three runs out of
thirty. The baseline arm here scored 24/30 on route where PR #301's recorded
arm scored 25/30 on *identical* code, so roughly one run of drift is the
measured noise floor for this lane.

Two things argue the change is real rather than drift. The improvements move
together across six independent metrics rather than appearing in one. And
`schemaExpansions` goes 0 → 3: agents began calling `connecta.describe`, which
is a behavior the new clause names explicitly and which no baseline run
performed. That is a mechanistic signal, not just a score.

## Why `dependent-read` stays at 0/5

The clause changed the shape of the failure without removing it. First programs
now return a diagnostic payload — `{error: "no jobs tool", summary}` carrying
the tool metadata — instead of throwing and thrashing. That is cheaper and
safer, and it is why safety and token counts improved. It is still a bail-out.

The reason is not routing guidance. Every failing program hunts for a
`list_jobs`-shaped tool with a regex like `/list.*jobs|jobs.*run/`, because the
agent's prior for a CI API is *get run → list jobs → get logs*. The fixture's
actual topology is *get_workflow_run → `failedJobId` → get_job_logs*. There is
no list-jobs tool to find, so the search never satisfies the plan, so the
program gives up. The agent only abandons its assumed API topology after seeing
real catalog data come back — which costs the second round trip by construction.

No wording in a tool description makes a model stop believing GitHub Actions
has a list-jobs endpoint. What would close this gap is making declared output
metadata the primary selection signal instead of description matching: the
compact `outputKeys` for `get_workflow_run` already declare `failedJobId`, and
an agent that read them would see the two-call chain without needing a
list-jobs step. That is a different candidate from this one, and it should be
measured on its own.

## Recommendation for #295

Keep the issue open. Two options, in preference order:

1. **Pursue the outputKeys-first selection candidate** described above. It
   targets the actual mechanism and is the only untested lever that plausibly
   reaches `dependent-read`.
2. **Amend the 95% bar.** With six cases at five repetitions, 95% means 29/30 —
   one failure total. The lane's own noise floor is about one run. A bar that
   sits inside the measurement error cannot be cleared reliably even by a
   correct fix, and 5/6 cases already sit at 100%.

What should *not* happen is adding a list-jobs tool to the `builds` fixture so
the agent's prior matches. That is tuning on the test, and #301 already had to
remove one such leak.
