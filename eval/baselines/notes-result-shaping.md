# Result-shaping study (not for merge)

Question: how much agent context can Connecta save on tool results without
losing what agents need? Plan fixed in `eval/result-shaping/plan.ts` before any
trial. 200 paid trials, `--target worker --catalog-tools 300 --grading outcome`,
Sonnet 5.5 and GPT-6.1 Sol, `six` and `native`, two repeats, concurrency 3.
Per-trial evidence: `result-shaping-rs1.json`. Analysis: `eval/result-shaping-report.ts`.

A workerd boot failure stopped one batch after 12 of 20 trials. Its eight missing
repeat-2 trials were rerun (`-rerun`) and count toward the 200. The declared spare
task `p5-result-paging` used the remaining 16. Batches after the first round carry
`dirty: true` only because the analysis script was untracked; the harness hash is
the same across all batches. Lint and analysis-only commits followed the trials.

## Where the tokens go (first comparison, 26 tasks)

Fit per file: prompt tokens = base × turns + rate × (result chars × later turns) +
rate₂ × (model-written chars × later turns). A result is re-read on every later
request, so position matters. Shares are estimates; a low r² means do not trust the row.

| Arm             | Mean tokens | Definitions and system | Vendor-data results | Discovery and guide results | Model-written | r²   |
| --------------- | ----------- | ---------------------- | ------------------- | --------------------------- | ------------- | ---- |
| six / Sonnet    | 38,172      | 46%                    | 14%                 | 26%                         | 14%           | 0.98 |
| six / Sol       | 67,220      | 87%                    | 6%                  | 10%                         | -4%           | 0.96 |
| native / Sonnet | 51,453      | 53%                    | 17%                 | 2%                          | 23%           | 0.89 |
| native / Sol    | 97,189      | 59%                    | 8%                  | 5%                          | 19%           | 0.67 |
| no-code / Sonnet| 76,438      | 44%                    | 39%                 | 1%                          | 15%           | 0.98 |
| no-code / Sol   | 89,848      | no usable fit          |                     |                             |               | 0.36 |

Results cost 1.8–2.2 characters per token on the well-fitted Sonnet rows: IDs,
timestamps and JSON punctuation are token dense. On `six`, 71% (Sonnet) and 78% (Sol)
of `execute_code` result bytes are discovery-only programs (search and guides), not
vendor data. Discovery is the largest result class on `six` and no arm here touches it.
Sol's definitions share is inflated: Codex reports no per-request usage and its
hidden tool loading and reasoning land in the base term.

Largest direct results in the first comparison: `ci.get_run_log`, `tithely.list_charges`
and `audit.export_events`, each at the 24.5 KB cap, then Overflow donor pages and
Tithe.ly recurring charges at about 4 KB.

## Noise in result bytes

Share of compact JSON bytes. Classes are exclusive except repeated keys, duplicates
and deep. Whitespace was zero everywhere except one pretty-printed hosted MCP.

| Source (results)               | Nulls and empties | URLs | Link blocks | Audit fields | Vendor tags | HTML | Repeated row keys | Duplicate objects | Depth ≥ 5 |
| ------------------------------ | ----------------- | ---- | ----------- | ------------ | ----------- | ---- | ----------------- | ----------------- | --------- |
| Eval fakes, all (291)          | 0.2               | 0.1  | 0.4         | 1.4          | 0.2         | 0    | 7.1               | 0.2               | 38        |
| Fake Tithe.ly (10)             | 0                 | 0    | 0           | 13.3         | 1.3         | 0    | 36.5              | 0.3               | 0         |
| Fake Overflow (23)             | 0.2               | 0.1  | 0           | 14           | 0           | 0    | 26.5              | 8.9               | 0.3       |
| Fake Vercel (15)               | 0.1               | 0    | 26          | 8.7          | 0           | 0    | 29.1              | 0                 | 1         |
| Fake Planning Center (20)      | 11.5              | 0    | 0.8         | 11.9         | 0           | 0    | 36.9              | 0                 | 0.7       |
| Fake Stripe (17)               | 0.4               | 0.3  | 0           | 10           | 15.8        | 0    | 25.7              | 0                 | 28        |
| Fake Cloudflare (23)           | 2.8               | 0    | 0           | 0.2          | 0           | 0    | 23.3              | 0                 | 46.8      |
| Real logs, vendors (about 290 KB) | 8.2            | 2.8  | 1.1         | 5.9          | 0.1         | 1.7  | 7.3               | 8.5               | 33.9      |
| Real Cloudflare (104)          | 7.8               | 1.6  | 0.5         | 9.5          | 0.1         | 0    | 9.1               | 16.8              | 34.9      |
| Real Mixpanel (48)             | 8.6               | 5.7  | 0           | 0.5          | 0           | 0.7  | 5.7               | 0                 | 51.3      |
| Real Vercel (8)                | 8.1               | 3.5  | 17.1        | 8.6          | 0           | 0    | 6.6               | 0                 | 12.3      |
| Real Stripe (8)                | 15.3              | 4.4  | 0           | 4.1          | 5.9         | 0    | 0                 | 0                 | 0         |
| Real Intercom (1, 25% whitespace) | 19.1           | 0    | 0           | 3.9          | 0           | 32.1 | 16.2              | 6.6               | 9.1       |

Fakes do not resemble vendors on the class that matters most here. Fake records
hold almost no nulls: a fake Stripe customer has 4 fields where the contract declares
far more, and the pinned contracts declare 45 charge and 49 pull request properties.
No fake can measure null omission's saving. Their repeated-key share is high because
the records are small. Real logs are a small, single-operator sample and contain only
what agents chose to read directly; a program's raw vendor reads are not in them.

Repeated row keys are the largest fake class but cannot be removed safely: a columnar
view changes the shape, so code written from it would fail against the program's value.

## Fields and lean reads

`fields` use: 25% and 17% of direct list reads on native (Sonnet, Sol), 21–23% without
code, almost all on tools whose schema makes it obvious. Real logs: 29 of 336 direct
calls, nearly all on Cloudflare hatches, and 25 of 2,488 programs. Zero refusals appear in
the real logs on three machines and zero `items.email` matches on two (the third scan
counted refusals, not that string), so this study could not reproduce the reported wrong-shape
guesses. A forced wrong path (`items.email`) returns a 936-byte `invalid_args` listing the
valid keys, naming the path and giving a retry. In eval, wrong paths surfaced as
`fields/N matched nothing` warnings, which can be larger than the result: a two-field
pull request reply carried about 440 bytes of declared names.

`verbose` exists in no maintained provider. Curated tools already project rows. No trial
evidence supports adding a general opt-in.

## Truncation

Real logs on the primary machine: 34 of 243 direct calls truncated. The agent's next step:
26 re-read inside a program and reduced, 5 another direct call, 1 paged raw, 1 used the
handle and reduced, 1 repeated the same tool. In 76% of truncations the agent discarded the
24 KB preview and read again, while the preview stayed in context for every later request
(about 12k tokens).

## Results

Preview against control, 88 trials per arm:

| Group                   | Pass C → P | Tokens C → P        | Change | Paired mean Δ, 95% CI | Result KB | Tool errors | Duplicate writes |
| ----------------------- | ---------- | ------------------- | ------ | --------------------- | --------- | ----------- | ---------------- |
| All 11 tasks            | 78 → 83    | 68,717 → 60,471     | -12.0% | -16,126..-1,228       | 11.3 → 7.7 | 0.16 → 0.13 | 0 → 0            |
| Fired (4 tasks)         | 25 → 28    | 79,211 → 59,953     | -24.3% | -35,968..-4,385       | data 14.2 → 3.9 |         | 0 → 0            |
| Never fired (7, placebo)| 53 → 55    | 62,720 → 60,768     | -3.1%  | -8,727..3,791         | data 1.9 → 2.0 |          | 0 → 0            |
| six / Sonnet            | 19 → 21    | 45,490 → 36,546     | -19.7% | -27,924..3,423        | 12.3 → 9.6 | 0.32 → 0.32 | 0 → 0            |
| six / Sol               | 22 → 22    | 78,770 → 74,557     | -5.3%  | -12,012..2,525        | 16.7 → 13.1 | 0.05 → 0.05 | 0 → 0            |
| native / Sonnet         | 17 → 20    | 51,769 → 37,284     | -28.0% | -32,392..1,440        | 7.0 → 2.9 | 0.14 → 0.05 | 0 → 0            |
| native / Sol            | 20 → 20    | 98,838 → 93,498     | -5.4%  | -20,502..9,530        | 9.4 → 5.3 | 0.14 → 0.09 | 0 → 0            |

The fired and never-fired split is post hoc. Claude cost on fired tasks, per trial:
$0.0779 → $0.0518. Preview fired in all 8 `truncated-read-paging` trials, 6 of 8
`p5-result-paging`, 4 of 8 `tithely-recurring-join` and 1 of 8 `overflow-donor-paging`.

| Task / cell                            | Control             | Preview             | Change |
| -------------------------------------- | ------------------- | ------------------- | ------ |
| tithely-recurring-join native / Sonnet | 109,784, 0/2 passed | 50,722, 2/2 passed  | -54%   |
| truncated-read-paging six / Sonnet     | 132,367, 2/2        | 38,187, 2/2         | -71%   |
| truncated-read-paging six / Sol        | 83,646, 2/2         | 51,686, 2/2         | -38%   |
| truncated-read-paging native / Sonnet  | 128,778, 2/2        | 50,702, 2/2         | -61%   |
| truncated-read-paging native / Sol     | 123,407, 2/2        | 95,521, 2/2         | -23%   |
| p5-result-paging six / Sonnet          | 42,892, 1/2         | 17,837, 2/2         | -58%   |
| p5-result-paging six / Sol             | 61,640, 2/2         | 40,161, 2/2         | -35%   |

After a preview, agents ran the offered program, editing its last line, in 15 of 19 cases.
`ci.get_run_log` was fetched 17 times across 8 control `truncated-read-paging` trials and 8 times
across 8 preview trials. On `p5-result-paging` it was 12 against 10; the two preview repeats are
native Sonnet trials that read the log only inside programs, so no preview fired. Control re-read
the log after a raw preview in 2 cases and paged raw in 2.

Lean against control, two tasks, 16 trials per arm: 15 → 16 passed, tokens 82,066 → 85,133
(+3.7%, inside noise for a treatment moving about 200 bytes), tool errors equal, duplicate
writes 0 → 0. This tests harm on real nulls only; it cannot measure a saving.

Replaying real direct reads through the arms (two machines, 1,838 KB of direct reads, or
275 KB without one internal knowledge tool): lean saved 0.4% (2.7%), preview about 44% (43%),
counting each previously truncated result as a 2.3 KB preview. Lean's saving falls short of the null
share because continuation and list keys stay, over-cap results keep their ordinary route,
and each view carries a disclosure line. Behavior on real vendors is untested.

## Native against meta

| Tasks       | Model  | Arm     | six    | native | Overhead | six / native data KB |
| ----------- | ------ | ------- | ------ | ------ | -------- | -------------------- |
| All 11      | Sonnet | control | 45,490 | 51,769 | 14%      | 5.6 / 6.8            |
| All 11      | Sonnet | preview | 36,546 | 37,284 | 2%       | 2.7 / 2.6            |
| All 11      | Sol    | control | 78,770 | 98,838 | 25%      | 6.7 / 6.5            |
| All 11      | Sol    | preview | 74,557 | 93,498 | 25%      | 2.8 / 2.6            |
| Never fired | Sonnet | control | 35,543 | 36,936 | 4%       | 2.0 / 1.2            |
| Never fired | Sol    | control | 83,227 | 95,173 | 14%      | 2.7 / 1.8            |

Native returns about the same vendor data as `six` and fewer result bytes overall, so its
overhead is not a result problem. Sol's 25% survives previews untouched. Sonnet's closes on
this paging-heavy set because native Sonnet was the arm holding raw 24 KB previews.

## Grader notes

No grader rejected a correct shaped result because it was shaped. Two reject correct answers on
both arms: `p5-result-paging` on native fails `answer-evidence` (the native prompt rewrite drops
"Finish with the source system, record ids, and facts", while the grader still requires them),
so all 8 native `p5-result-paging` trials fail on both arms. Those are 8 of the study's 15
failures. Without them preview passes 83 of 84 against control's 78 of 84. `google-sheets-3` also
fails `answer-evidence` on both arms (control 2, preview 1); its cause was not investigated. The inherited `eval:outcomes` control
`ccb-advanced-search loses delivered data` fails on the base branch since c2b6fdf2. No grader
was changed; only a formatting fix was applied to `eval/tasks/ccb.ts`.
