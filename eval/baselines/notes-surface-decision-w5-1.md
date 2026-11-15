# Worker surface decision run: six vs native vs native-no-code (#1431, W5.1)

The preregistered Worker native/code experiment
([README](../README.md#worker-nativecode-experiment), `WORKER_DECISION_RULE` in
[worker-comparison-plan.ts](../worker-comparison-plan.ts)), run on main `e2f20349ba20`
(package 0.49.0, src tree `fb9be78b9255`, clean). Protocol: taskDefinitionsHash `f3ad7d2d…`,
harnessHash `3e8870d1…`, served Worker graph `5917ec31…` (matches HEAD) for every arm.

## Setup

- `--target worker --no-build --grading outcome`, the frozen `WORKER_COMPARISON` roster
  (23 tasks: 16 Worker-eligible comparison tasks plus 7 `pco-step2-*`), concurrency 2 per arm,
  the three arms of each model run together in one batch window, default 8-minute deadline and effort.
- Sonnet 5.5 (`--runner claude`, Claude Code 2.1.325, `--max-budget-usd 2`), **5 repeats**, pair id
  `w51-sonnet-worker-2026-11-15`. GPT-6-Luna (`--runner codex`, Codex CLI 0.169.0), **3 repeats**
  (the rule is evaluated per model but registers no second model), pair id `w51-luna-worker-2026-11-15`.
  Served models matched the requested ones. No auth failure, rate limit or stopped batch.
- Linux x64, Node 26.13.0, a shared 24-core host whose 1-minute load ranged 5–24 from unrelated work.
  One Luna six trial (`pco-step2-group-services-join` #3) saw 8 MCP transport errors and still passed;
  no other trial saw any, so nothing was rerun.
- Claude reported $15.78 API-equivalent usage (telemetry, not an invoice): six $3.47, native $2.97,
  native-no-code $9.34. Codex reports no cost.

```sh
T=<the 23 WORKER_COMPARISON ids>
for arm in six native native-no-code; do
  pnpm run eval:agent --runner claude --models claude-sonnet-5-5 --target worker --no-build --surface $arm \
    --grading outcome --tasks "$T" --repeats 5 --concurrency 2 --max-budget-usd 2 \
    --pair-id w51-sonnet-worker-2026-11-15 --out eval/results/w51/sonnet-$arm.json &
done
# Luna: --runner codex --models gpt-6-luna --repeats 3, no budget flag, pair id w51-luna-worker-2026-11-15
pnpm run eval:compare --a eval/results/w51/<model>-<armA>.json --b eval/results/w51/<model>-<armB>.json
```

## Scores (outcome grading)

"Comparable" is the roster minus `NO_CODE_CAPABILITY_MISMATCHES` (18 tasks, less Claude's N/A
`p5-direct-rich-output`, so 17 for Sonnet). "Adjusted" removes the grader false negatives and the
fixture defect triaged below; it is not a measured score.

| Model / arm | All tasks (N/A excluded) | Comparable roster | Comparable, adjusted | pass@k / pass^k (compare) |
| --- | --- | --- | --- | --- |
| Sonnet six | 100/105 (95.2%) | 85/85 | 85/85 | 87.0 / 87.0 |
| Sonnet native | 97/105 (92.4%) | 84/85 | 85/85 | 87.0 / 78.3 |
| Sonnet native-no-code | 80/100 (80.0%) | 79/85 | 84–85/85 | 73.9 / 65.2 |
| Luna six | 62/69 (89.9%) | 47/54 | 54/54 | 95.7 / 87.0 |
| Luna native | 62/69 (89.9%) | 48/54 | 52/54 | 100 / 73.9 |
| Luna native-no-code | 49/66 (74.2%) | 47/54 | 52/54 | 82.6 / 56.5 |

Duplicate writes: 0 in every arm. The compare's native-arm lines print "100/115" style
totals because they keep N/A rows in the denominator.

### Per task

`*` marks a capability mismatch (excluded from the code rule). Cells: passes; Sonnet efficiency
is passing-median turns / input tokens incl. cache.

| Task | Category | Sonnet six | native | no-code | Sonnet turns/in (six · native · no-code) | Luna six | native | no-code |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cross-connector-join | reduction/join | 5/5 | 5/5 | 5/5 | 7/51k · 11/25k · 11/25k | 3/3 | 2/3 | 3/3 |
| stale-close-and-summarize | writes | 5/5 | 5/5 | 5/5 | 5/23k · 8/19k · 8/19k | 3/3 | 3/3 | 3/3 |
| auth-required-recovery* | discovery | 5/5 | 5/5 | N/A | 12/61k · 10/65k · – | 3/3 | 2/3 | N/A |
| truncated-read-paging | paging | 5/5 | 5/5 | 5/5 | 7/32k · 5/20k · 11/291k | 3/3 | 3/3 | 3/3 |
| truncated-write-export | paging | 5/5 | 5/5 | 5/5 | 8/45k · 6/74k · 10/269k | 3/3 | 3/3 | 2/3 |
| p5-trusted-program-write | writes | 5/5 | 5/5 | 0/5 | 4/16k · 3/11k · – | 3/3 | 3/3 | 1/3 |
| p5-read-only-program-refusal* | writes | 0/5 | 3/5 | 1/5 | – · 3/10k · 3/7k | 3/3 | 3/3 | 2/3 |
| p5-result-paging | paging | 5/5 | 5/5 | 5/5 | 5/22k · 5/23k · 10/559k | 3/3 | 2/3 | 2/3 |
| p5-direct-rich-output | known read | N/A | N/A | N/A | – | 3/3 | 3/3 | 3/3 |
| p5-program-image* | known read | N/A | N/A | N/A | – | 3/3 | 3/3 | 0/3 |
| p5-fanout-over-budget* | known read | 5/5 | 0/5 | 0/5 | 4/9k · – · – | 3/3 | 3/3 | 0/3 |
| p5-revenuecat-text | reduction/join | 5/5 | 5/5 | 5/5 | 4/13k · 4/11k · 5/13k | 3/3 | 3/3 | 3/3 |
| p5-supabase-project-ref | reduction/join | 5/5 | 5/5 | 5/5 | 4/13k · 4/11k · 4/11k | 3/3 | 3/3 | 3/3 |
| p5-absent-github | discovery | 5/5 | 4/5 | 5/5 | 2/6k · 4/9k · 4/9k | 3/3 | 3/3 | 3/3 |
| p5-known-read-routing | known read | 5/5 | 5/5 | 5/5 | 2/5k · 3/8k · 3/8k | 3/3 | 3/3 | 3/3 |
| p5-connecta-read* | reduction/join | 5/5 | 5/5 | 0/5 | 3/8k · 4/15k · – | 3/3 | 3/3 | 0/3 |
| pco-step2-filtered-people | reduction/join | 5/5 | 5/5 | 5/5 | 4/34k · 3/11k · 3/11k | 1/3 | 1/3 | 2/3 |
| pco-step2-group-services-join | reduction/join | 5/5 | 5/5 | 4/5 | 7/69k · 12/50k · 12.5/49k | 3/3 | 3/3 | 3/3 |
| pco-step2-plan-join | reduction/join | 5/5 | 5/5 | 5/5 | 5/42k · 5/21k · 5/20k | 3/3 | 3/3 | 3/3 |
| pco-step2-people-paging | paging | 5/5 | 5/5 | 5/5 | 3/23k · 4/19k · 5/17k | 0/3 | 2/3 | 1/3 |
| pco-step2-merger-hatch | discovery | 5/5 | 5/5 | 5/5 | 6/44k · 5/18k · 6/19k | 1/3 | 2/3 | 3/3 |
| pco-step2-note-once | writes | 5/5 | 5/5 | 5/5 | 7/42k · 5/16k · 5/18k | 3/3 | 3/3 | 3/3 |
| pco-step2-update-recovery | writes | 5/5 | 5/5 | 5/5 | 6/54k · 5/22k · 5/21k | 3/3 | 3/3 | 3/3 |

## Efficiency (passing-trial medians)

Input includes cache reads and writes. Codex records no model-turn count; its host-search figure
counts every host `exec`.

| Model / arm | Turns | Top-level calls | Input | Output | First request | Wall | Response bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sonnet six | 5 (mean 5.3) | 4 | 23.9k | 753 | 2,558 | 9.8 s | 5.9 KB |
| Sonnet native | 5 (mean 5.6) | 4 | 18.7k | 622 | 2,298 | 8.5 s | 1.3 KB |
| Sonnet native-no-code | 5 (mean 6.7) | 4 | 18.9k | 665 | 2,302 | 8.7 s | 1.4 KB |
| Luna six | n/a | 9 | 56.2k | 486 | 6,139 | 15.7 s | 30.3 KB |
| Luna native | n/a | 7 | 55.1k | 363 | 6,132 | 13.4 s | 30.4 KB |
| Luna native-no-code | n/a | 7 | 53.7k | 271 | 6,147 | 11.9 s | 30.0 KB |

Paging tasks on the comparable roster (4 tasks), passing medians:

| Model | six | native | native-no-code |
| --- | --- | --- | --- |
| Sonnet turns / input / wall / paging-task cost | 5.5 / 24.1k / 15.6 s / $0.73 | 5 / 20.3k / 13.5 s / $0.89 | **10 / 280k / 17.6 s / $7.62** |
| Luna calls / input / wall | 11 / 89.1k / 25.1 s | 9 / 83.8k / 22.0 s | 13.5 / 145.7k / 19.9 s |

Without code, both models page retained results through repeated `read_result` calls (7 pages per
log for Sonnet), so each page re-sends the growing context.

## Decision output

`eval:compare` on main **refuses** every native vs native-no-code pair, for both runners:
`Comparison refused: served model for [<model>,"auth-required-recovery",1..k]`. The per-trial
served-model check in `settingMismatches` (`eval/compare.ts`, the `served model for` loop) does not
skip the arm's capability-mismatch N/A rows, which have no runner observation by design. The lines
below come from an unshipped copy of `compare.ts` with that one loop skipping `isNA` rows; nothing
else changed.

```text
Sonnet  Decision rule inputs (the comparable roster, complete):
        native: 84/85 passing; reduction/join/paging passing medians: model turns 5, total tokens 21041
        native-no-code: 79/85 passing; reduction/join/paging passing medians: model turns 5, total tokens 20781
Luna    Decision rule inputs (the comparable roster, complete):
        native: 48/54 passing; reduction/join/paging passing medians: model turns N/A, total tokens 70931
        native-no-code: 47/54 passing; reduction/join/paging passing medians: model turns N/A, total tokens 62405
```

six vs native (unpatched compare, diagnostic): Sonnet six 100 vs native 97 passing; Luna 62 vs 62;
0 duplicate writes in each.

### Applying `WORKER_DECISION_RULE`

**Clause 1, code earns its place** (native vs native-no-code on the comparable roster):

- Pass rate: native beats native-no-code for both models as measured (Sonnet 84 vs 79/85,
  Luna 48 vs 47/54). The margin is not robust. Sonnet's five-trial gap is a grader false
  negative on `p5-trusted-program-write`, and Luna's one trial is noise. Adjusted, Luna ties
  (52 vs 52/54) and Sonnet ranges from one trial behind to tied (84–85 vs 85/85).
- Turns or tokens on reduction/join/paging: the pooled medians show no win (Sonnet 5 vs 5 turns,
  21.0k vs 20.8k tokens). For Luna, no-code is cheaper (62.4k vs 70.9k). The pool hides a
  split. On paging, code wins by a wide margin: Sonnet takes half the turns and 1/14 of the input
  tokens (20.3k vs 280k median), and Luna uses 42% less input. On joins, Sonnet does not write
  programs on either native arm, and Luna on no-code uses Codex's host `code_mode`, which is
  cheaper than Connecta programs.
- **Verdict: PASS as printed.** Code earns its place on native pools. The evidence that holds up
  is paging/retained results, not joins.

**Clause 2, six stops being the default for bounded pools** (native matches six's pass rate,
no extra duplicate writes, fewer turns):

- Sonnet: native scored 97/105 vs 100/105 (−2.9 pp, 3 trials) with equal duplicate writes (0).
  Median turns were 5 vs 5, and the mean was higher on native (5.6 vs 5.3). Native needs *more*
  turns on joins (cross-connector-join 11 vs 7, group-services-join 12 vs 7) because Sonnet calls
  native tools one by one. It needs fewer on paging and writes. **Not met.**
- Luna: pass rate 62 = 62 and 0 duplicate writes. Turns are unrecorded for Codex, so the clause
  cannot be evaluated by its letter. On the calls proxy, native used fewer (7 vs 9 median) and
  ran 15% faster.
- **Verdict: inconclusive.** Six stays the default.

## Recommendation

1. **Keep `executeCode` on for native pools by default.** Hosts without their own code mode (the
   Claude runner) should not get native-no-code: on paging tasks it took twice the turns, about
   14× the input tokens (280k vs 20.3k median) and 8.6× native's API-equivalent cost ($7.62 vs $0.89),
   with no pass-rate gain. Across the whole arm its cost was 3.1× native's ($9.34 vs $2.97). The
   program-only capabilities (budgeted fan-out, `connecta.read`, `connecta.emit`) also disappear.
2. **For hosts with their own code mode (Codex `code_mode`), native-no-code is a viable opt-in, not a
   default.** It reached parity on the comparable roster (47 vs 48/54; 52 vs 52 adjusted). It was
   cheaper on joins (Luna plan-join 58k vs 87k, group-services-join 72k vs 108k) and faster
   (11.9 s vs 13.4 s). It cost 73% more input on paging and lost one large-export trial.
3. **Six remains the default for bounded pools.** Native is the efficient opt-in. For Sonnet it
   cut input 22%, output 17%, wall time 14% and response bytes 78%. For Luna it made 22% fewer
   calls and ran 15% faster at the same pass rate. The rule's turns criterion is not met for
   Sonnet and cannot be measured for Codex.
4. Before re-deciding clause 2, fix the items below and either record a Codex turn proxy or
   amend the rule to name top-level calls for runners without turns.

## Failure triage (every failing trial read)

| Arm | Trials | Root cause | Category |
| --- | --- | --- | --- |
| Sonnet six | refusal ×5 | Read-only pool hides write names. The agent guesses `tracker.update_issue` (unknown tool) or searches, finds no write, and never attempts `close_issue`. | Product (read-only discoverability) |
| Sonnet native | fanout ×5 | It recovers runs 4812/4811 in a 2-call program and 4810 with a direct native `ci__get_run`. The answer is correct and within budget, but `boundedFanout` requires every id in a program. | Arm-specific grader strictness (prompt says "smaller programs") |
| Sonnet native | refusal #4, #5 | Same as six. | Product |
| Sonnet native | absent-github #1 | Correct "ANSWER: unavailable". `statesAbsence` misses "I can't get GitHub data" / "None of them exposes GitHub". | Grader false negative |
| Sonnet no-code | trusted-write ×5 | The write landed and the answer was "WEB-105 is closed". The evidence requires `/tracker/i`. | Grader false negative |
| Sonnet no-code | group-services-join #5 | The fake's schedules are hardcoded to 2026-10-25, now in the past. The agent correctly reported no *future* schedule. | Fixture defect (`eval/fakes/planning-center.ts`) |
| Sonnet no-code | fanout ×5, connecta-read ×5, refusal ×4 | Capability mismatches (excluded). | By design |
| Luna six | filtered ×2, people-paging ×3 | Answer source "Planning Center People", which the label normalization (`^(pco\|planning center)$`) rejects. | Grader false negative |
| Luna six | merger-hatch ×2 | Ids emitted as numbers (`2999`) vs expected strings. The prompt asks for "literal JSON numbers". | Grader/prompt ambiguity |
| Luna native | filtered ×2, people-paging #1, merger #2 | Same two grader issues. | Grader false negative |
| Luna native | result-paging #1 | Stopped paging early and honestly said it could not identify the failure. | Agent: incomplete paging |
| Luna native | cross-connector-join #3 | Posted WEB-101/Initech $48000 instead of the highest-MRR open bug. | Agent: join error |
| Luna native | auth-required-recovery #2 | Filtered invoices to `status:"open"` only: $2,170 instead of $5,650.50. | Agent: filter judgment |
| Luna no-code | trusted-write #1, #2 | "WEB-105 is closed." without "tracker". | Grader false negative |
| Luna no-code | people-paging ×2, filtered #2 | Source label. | Grader false negative |
| Luna no-code | result-paging #1 | Skipped log pages 72k–160k. It named the test and status without those facts in any delivered page. | Agent: incomplete paging, unsupported answer |
| Luna no-code | truncated-write-export #3 | Ten `read_result` pages of the export, never found the deleter, posted nothing. | Agent: large-result paging without code |
| Luna no-code | program-image ×3, fanout ×3, connecta-read ×3, refusal #1 | Capability mismatches (excluded). | By design |

## Harness follow-ups

1. `eval:compare` cannot produce the preregistered native vs native-no-code decision: skip
   capability-mismatch N/A rows in the per-trial served-model check, and add a selftest control
   that pairs a real native/native-no-code batch.
2. The native-arm compare lines count N/A rows in pass denominators.
3. Codex records no `modelTurns`, so the rule's turn criterion is N/A for it.
4. Graders: the `p5-trusted-program-write` evidence regex (`/tracker/i`); Planning Center source
   normalization (accept "Planning Center People") and id type versus the "literal JSON numbers"
   prompt; the `statesAbsence` negation forms; `boundedFanout` versus a direct native read on native arms.
5. The Planning Center fake's fixed 2026-10-25 schedule dates now make "future schedule" tasks
   depend on the wall clock. Make them relative to the run date.
