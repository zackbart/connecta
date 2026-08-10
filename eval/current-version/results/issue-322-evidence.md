# Issue #322 discovery evidence

The deterministic release audit passes, and the mixed all/partial development
case has complete retrieval. The preregistered 30-run qualification does not
show a statistically credible clean-route improvement from trailing coverage.
The exact product commit `bbfb522` is not qualified to merge or release.

## Provenance

The committed deterministic baseline is
[`issue-322-before-audit.json`](./issue-322-before-audit.json) from
`d58f874588bdf6aa37b4404b9416a8b9b0b917c9`. Its artifact SHA-256 is
`0775ed3e1a502089b5999932d25653e6a66b9e6bac808895d56f089810b0279d`.
The current audit tests product commit
`62e2b1f0f6ec681cd3049a3a12621ab3d6978ff6`. The committed evidence change is
eval-only, so cold candidate commit
`4123d2fafc6e9e6b2878de9a6b1b67c64a8d2a6c` contains the same product source.

The release audit used Node 26.5.1 on darwin-arm64 and tokenizer
`o200k_base`. It used a loopback sandbox, deterministic providers, the required
QuickJS executor, and the seven-tool surface. It did not invoke a model or the
Codex CLI.

Both cold-agent arms used Node 26.5.1, Codex CLI 0.147.0,
`gpt-5.6-sol`, and tokenizer `o200k_base`. Each arm used 10 fresh sessions at
concurrency 5. Both used the same harness (`dd11bb3b…`), corpus (`48006378…`),
and sandbox (`7a8b811f…`). User config was ignored. Apps, plugins, browser,
computer use, image generation, multi-agent, goals, tool search, skill search,
shell, unified execution, and workspace dependencies were disabled. Both arms
recorded zero host actions and zero foreign MCP calls.

## Sealed holdout movement

[`issue-322-current-audit.json`](./issue-322-current-audit.json) and
[`issue-322-current-audit.md`](./issue-322-current-audit.md) are the current
release evidence. `discovery-holdout.json` remains byte-identical at
`25928ad2634f44ba02653613fd54d3cd93da6bde9a6a7fee845e336a004bbb1a`.

| Metric | d58f874 | Current | Movement |
| --- | ---: | ---: | ---: |
| Release qualification | pass | pass | unchanged |
| Behavioral scenarios | 21/21 | 21/21 | unchanged |
| Positive recall | 100.0% | 100.0% | 0.0 pp |
| Default-page recall | 100.0% | 100.0% | 0.0 pp |
| Top-1 accuracy | 93.1% | 93.1% | 0.0 pp |
| Negative false-positive rate | 40.0% | 40.0% | 0.0 pp |
| Mean precision | 71.1% | 63.5% | -7.6 pp |
| Mean results | 2.971 | 3.206 | +0.235 |
| Mean discovery response tokens | 402.9 | 595.4 | +47.8% |
| Total discovery response tokens | 13,697 | 20,243 | +47.8% |
| Complete measured surface tokens | 22,910 | 29,537 | +28.9% |

The new `queryCoverage` fields account for 5,945 holdout response tokens.
That is 29.4% of the current discovery response and 90.8% of the 6,546-token
increase from d58f874. The counterfactual removes only those fields from both
MCP result forms. It does not predict which result form a specific host sends
to a model.

The release gates remain unchanged: all behavioral scenarios, minimum 89.7%
top-1, complete positive and default-page recall, the seven-tool surface, and
payload-free activity. Mean precision, false positives, and token cost remain
reported evidence rather than gates.

## Development corpus

[`issue-322-development-discovery.json`](./issue-322-development-discovery.json)
and [`issue-322-development-discovery.md`](./issue-322-development-discovery.md)
use the separate `discovery-development.json`. The lane exposes only its
synthetic analytics connector.

| Metric | Result |
| --- | ---: |
| Expected top-1 | 100.0% |
| Positive recall | 100.0% |
| Mean precision | 12.5% |
| Coverage assertions | 1/1 |
| Coverage distinguishes name from description-only decoys | 2/2 cases |
| Total response tokens | 2,310 |
| `queryCoverage` tokens | 790 (34.2%) |

The low precision is expected: the default page retains seven broad decoys to
preserve mixed all/partial recall. The intended `List-Organizations` tool is
first, and its coverage identifies two name terms plus one unmatched term.
Each broad decoy reports all three terms as description-only matches.

## Cold-agent movement

The paired artifacts are
[`issue-322-cold-agent-before.json`](./issue-322-cold-agent-before.json),
[`issue-322-cold-agent-before.md`](./issue-322-cold-agent-before.md),
[`issue-322-cold-agent-current.json`](./issue-322-cold-agent-current.json), and
[`issue-322-cold-agent-current.md`](./issue-322-cold-agent-current.md).

| Metric | d58f874 | Current | Movement |
| --- | ---: | ---: | ---: |
| First-search recall | 0/10 | 10/10 | +100 pp |
| First-search top-1 | 0/10 | 10/10 | +100 pp |
| Exact address | 1/10 | 3/10 | +20 pp |
| Exact arguments | 1/10 | 3/10 | +20 pp |
| Final answer | 1/10 | 4/10 | +30 pp |
| Address + arguments + final | 1/10 | 3/10 | +20 pp |
| Intended outer route | 1/10 | 2/10 | +10 pp |
| Clean intended route | 1/10 | 2/10 | +10 pp |
| Mean Connecta round trips | 2.4 | 2.2 | -8.3% |
| Mean search-result tokens | 1,616.4 | 1,912.1 | +18.3% |
| Mean estimated search-noise tokens | 1,533.1 | 1,575.3 | +2.8% |
| Mean Connecta MCP result tokens | 535.9 | 463.0 | -13.6% |
| Mean whole-agent input tokens | 76,808.5 | 67,173.0 | -12.5% |
| Mean non-cached input tokens | 22,664.5 | 19,096.2 | -15.7% |
| Mean latency | 34.8 s | 33.5 s | -3.6% |

Current retrieval is deterministic in this lane, but seven of ten agents still
called a decoy or supplied the wrong arguments. One additional final answer
matched without a correct execution, so routing-result agreement is the safer
correctness measure. Query coverage and mixed-candidate ranking shipped
together between these commits. This comparison proves their combined routing
effect; it does not isolate the causal value of the coverage fields alone.

## Coverage-off ablation

The causal arm uses the exact current candidate commit and removes only the
serialized `queryCoverage` object in an uncommitted worktree. Ranking and all
other current behavior stay fixed. No product flag or alternate surface was
added. The coverage-on and coverage-off artifacts have identical model, CLI,
Node, tokenizer, prompt, repetitions, concurrency, harness, corpus, sandbox,
host isolation, and scoring configuration.

- Coverage-on product file: `2d94f669afb090fbfe34e8935e0123ac84883ad78a5c58f7423f7c09cf80a2d1`
- Coverage-off product file: `cbaaefd04012daf6fe9a3a38fab27f332d05e554f18816b1728d381718efd7cb`
- One-deletion patch: `9db0c8011ea3743a0d605aa86fa0842c769125f89006f05e768e6080a522226f`

The raw arm is
[`issue-322-cold-agent-coverage-off.json`](./issue-322-cold-agent-coverage-off.json)
with its generated
[`Markdown report`](./issue-322-cold-agent-coverage-off.md).

| Metric | Coverage on | Coverage off | Off minus on |
| --- | ---: | ---: | ---: |
| First-search recall | 10/10 | 10/10 | 0 pp |
| First-search top-1 | 10/10 | 10/10 | 0 pp |
| Exact address | 3/10 | 7/10 | +40 pp |
| Exact arguments | 3/10 | 7/10 | +40 pp |
| Final answer | 4/10 | 7/10 | +30 pp |
| Address + arguments + final | 3/10 | 7/10 | +40 pp |
| Intended outer route | 2/10 | 4/10 | +20 pp |
| Clean intended route | 2/10 | 4/10 | +20 pp |
| Mean Connecta round trips | 2.2 | 1.7 | -22.7% |
| Mean search-result tokens | 1,912.1 | 1,080.1 | -43.5% |
| Mean estimated search-noise tokens | 1,575.3 | 865.3 | -45.1% |
| Mean Connecta MCP result tokens | 463.0 | 612.5 | +32.3% |
| Mean whole-agent input tokens | 67,173.0 | 59,894.5 | -10.8% |
| Mean non-cached input tokens | 19,096.2 | 14,966.5 | -21.6% |
| Mean latency | 33.5 s | 23.0 s | -31.3% |

Coverage-on reduced outer Connecta MCP result tokens because agents used
`execute_code` more often, which keeps nested search payloads inside the
sandbox. That narrow saving did not offset worse execution correctness, more
searches, more whole-agent input, or higher latency. With 10 stochastic runs
per arm, this is a canary rather than a significance claim. The effect is large
and consistent across the primary measures: the current verbose coverage shape
does not earn its 29.4% held-out response cost. Redesign it before release,
then rerun this ablation against the compact candidate.

## Compact-coverage qualification

The final arm combines compact product commit
`afbaa320b86ff996806a97009adcafec55148e56` with the exact PR #333 eval tree
from `f84d0b3d7f06079a5d7a9e97f8bd135983a6ab66`. The temporary worktree used
`git restore --source f84d0b3 --staged --worktree eval/current-version` on the
compact product. It did not merge either PR.

- Compact product tree: `d98f4ca388f0f17798493c16254a5bc1e88ddaf9`
- Compact product file: `b61ca75632aed4ab3d039583c9f240eb5bac616e71fea1e2dd9db22211eabea1`
- PR #333 eval tree: `65bd023242c18f26db3296f77cb7cb3875030c20`
- Eval overlay patch: `1b36bdf808aea6b1dcc6efda2c01608a4e1c369176653f303291682fc7b74758`
- Deterministic indexed-term adapter: `a033f402147ab5e541f74a881b192bdf23f9baf5f077aa648e31f0f7e88c10f0`

The adapter ran only after the cold arm. It resolves compact coverage indexes
through the page's `queryTerms` table for the existing semantic assertions. Its
token counterfactual removes both the term table and per-tool coverage. The
cold harness remained byte-identical to coverage-off at `dd11bb3b…`.

[`issue-322-cold-agent-compact.json`](./issue-322-cold-agent-compact.json) and
[`issue-322-cold-agent-compact.md`](./issue-322-cold-agent-compact.md) record
the raw cold arm. Its configuration object is identical to coverage-off except
for the product source: Node 26.5.1, Codex CLI 0.147.0, `gpt-5.6-sol`, 10
repetitions, concurrency 5, and zero host or foreign calls in both arms.

| Metric | Coverage off | Compact on | Compact minus off |
| --- | ---: | ---: | ---: |
| First-search recall | 10/10 | 10/10 | 0 pp |
| First-search top-1 | 10/10 | 10/10 | 0 pp |
| Exact address | 7/10 | 7/10 | 0 pp |
| Exact arguments | 7/10 | 7/10 | 0 pp |
| Final answer | 7/10 | 9/10 | +20 pp |
| Address + arguments + final | 7/10 | 7/10 | 0 pp |
| Intended outer route | 4/10 | 4/10 | 0 pp |
| Clean intended route | 4/10 | 4/10 | 0 pp |
| Mean Connecta round trips | 1.7 | 2.8 | +64.7% |
| Mean search-result tokens | 1,080.1 | 2,328.1 | +115.5% |
| Mean estimated search-noise tokens | 865.3 | 1,893.0 | +118.8% |
| Mean Connecta MCP result tokens | 612.5 | 1,340.4 | +118.8% |
| Mean whole-agent input tokens | 59,894.5 | 77,328.9 | +29.1% |
| Mean non-cached input tokens | 14,966.5 | 23,799.3 | +59.0% |
| Mean latency | 23.0 s | 30.0 s | +30.5% |

Compact coverage is not materially equivalent to coverage-off. It preserves
exact execution correctness. Two extra final texts match without correct
execution, so the combined 7/10 measure remains authoritative. Every main cost
mean regresses. The medians do not reverse the result: round trips stay 2.0,
search tokens rise 1,254.5 to 1,526.0 (+21.6%), non-cached input rises 17,048.5
to 20,035.0 (+17.5%), and latency rises 18.7 to 20.1 seconds (+7.4%). Median
whole-agent input is nearly flat at +0.8%; median outer MCP tokens rise from
115.5 to 1,628 because the route mix changes. Three five-round-trip compact
runs drive part of the larger mean regression, but the robust medians still
favor coverage-off.

Against d58, compact still improves exact execution
from 10% to 70%, final answers from 10% to 90%, and clean intended routing from
10% to 40%. It also raises round trips by 16.7%, search-result tokens by 44.0%,
outer Connecta tokens by 150.1%, and non-cached input by 5.0%. Whole-agent
input is effectively flat at +0.7%; latency improves 13.7%.

The compact deterministic artifacts are
[`issue-322-compact-audit.json`](./issue-322-compact-audit.json),
[`issue-322-compact-audit.md`](./issue-322-compact-audit.md),
[`issue-322-compact-development.json`](./issue-322-compact-development.json),
and [`issue-322-compact-development.md`](./issue-322-compact-development.md).
The sealed holdout hash remains
`25928ad2634f44ba02653613fd54d3cd93da6bde9a6a7fee845e336a004bbb1a`.

| Deterministic metric | Verbose | Compact | Movement |
| --- | ---: | ---: | ---: |
| Holdout top-1 | 93.1% | 93.1% | 0 pp |
| Holdout recall | 100.0% | 100.0% | 0 pp |
| Holdout false positives | 40.0% | 40.0% | 0 pp |
| Holdout mean response tokens | 595.4 | 560.2 | -5.9% |
| Holdout coverage tokens | 5,945 | 4,749 | -20.1% |
| Holdout coverage share | 29.4% | 24.9% | -4.5 pp |
| Complete measured surface tokens | 29,537 | 28,319 | -4.1% |
| Development top-1 and recall | 100.0% | 100.0% | 0 pp |
| Development coverage tokens | 790 | 450 | -43.0% |
| Development coverage share | 34.2% | 22.8% | -11.4 pp |

The compact encoding reduces repeated coverage strings, but the holdout still
spends one quarter of discovery response tokens on the signal. The cold arm
does not recover a route or execution gain over coverage-off and materially
increases cost. The release criterion fails. Do not merge #334; redesign the
signal again or remove it, then rerun the exact three-arm evidence.

## Superseded 10-run trailing-coverage canary

The replacement candidate moves coverage after the complete result rows and
keeps one ordered page-level table. This arm combines exact product commit
`bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c` with the exact PR #333 eval tree
from `f84d0b3d7f06079a5d7a9e97f8bd135983a6ab66`. It uses the same temporary
eval overlay method and does not merge either PR.

- Product tree: `ce24ad2eac7d299eaf61c2e4a4be9bbb11016c0f`
- Product file: `3faa304f145723c4bfa4e5954e1f5b99619ef495cfb4f7d3ac9fd4f0884abc1f`
- PR #333 eval tree: `65bd023242c18f26db3296f77cb7cb3875030c20`
- Eval overlay patch: `1b36bdf808aea6b1dcc6efda2c01608a4e1c369176653f303291682fc7b74758`
- Trailing deterministic adapter: `80fe433520f0cecc25ddcaf34fb8de1e44a44f8d23f1af5b1d79e2217ec1041b`

The adapter ran only after the cold arm. It aligns each trailing entry with its
canonical address and resolves indexes through the trailing `terms` table. The
token counterfactual removes the complete trailing block. The cold harness,
corpus, sandbox, model, CLI, Node, prompt, repetitions, concurrency, isolation,
and scoring are identical to coverage-off. Both arms record zero host and
foreign calls.

The raw cold artifacts are
[`issue-322-cold-agent-trailing.json`](./issue-322-cold-agent-trailing.json) and
[`issue-322-cold-agent-trailing.md`](./issue-322-cold-agent-trailing.md).

| Metric | Coverage off | Trailing | Movement |
| --- | ---: | ---: | ---: |
| First-search recall | 10/10 | 10/10 | 0 pp |
| First-search top-1 | 10/10 | 10/10 | 0 pp |
| Exact address | 7/10 | 7/10 | 0 pp |
| Exact arguments | 7/10 | 7/10 | 0 pp |
| Final answer | 7/10 | 7/10 | 0 pp |
| Address + arguments + final | 7/10 | 7/10 | 0 pp |
| Intended outer route | 4/10 | 7/10 | +30 pp |
| Clean intended route | 4/10 | 7/10 | +30 pp |
| Mean Connecta round trips | 1.7 | 2.1 | +23.5% |
| Mean search-result tokens | 1,080.1 | 1,596.5 | +47.8% |
| Mean estimated search-noise tokens | 865.3 | 1,010.3 | +16.8% |
| Mean Connecta MCP result tokens | 612.5 | 1,269.1 | +107.2% |
| Mean whole-agent input tokens | 59,894.5 | 66,762.1 | +11.5% |
| Mean non-cached input tokens | 14,966.5 | 19,530.1 | +30.5% |
| Mean latency | 23.0 s | 19.6 s | -14.8% |

Trailing costs more than coverage-off, but it exposes a routing benefit the
prior compact placement did not: clean intended routing rises from 4/10 to
7/10 without losing combined correctness. The robust medians show the trade:
round trips stay 2.0; search tokens rise 30.0%; outer MCP tokens rise because
seven runs take the visible intended route; whole-agent input falls 1.5%;
non-cached input falls 19.0%; and latency falls 10.2%.

The trailing candidate avoids the first compact candidate's material
efficiency regression. At the same 7/10 combined correctness, mean round trips
fall 25.0%, search tokens 31.4%, search noise 46.6%, whole-agent input 13.7%,
non-cached input 17.9%, and latency 34.7%. Clean routing rises 4/10 to 7/10.
Median whole-agent input, non-cached input, and latency also improve 2.3%,
31.1%, and 16.4%; median round trips stay equal at 2.0. Median search and outer
MCP tokens rise 6.9% and 6.4%, which is not the first candidate's broad
regression.

Against d58, trailing improves exact execution and combined correctness from
1/10 to 7/10, and clean intended routing from 1/10 to 7/10. Mean round trips
fall 12.5%, search tokens 1.2%, noise 34.1%, whole-agent input 13.1%, non-cached
input 13.8%, and latency 43.6%. Outer Connecta tokens rise 136.8% because the
agent now uses the visible intended route. Medians keep round trips equal and
improve whole-agent input 0.4%, non-cached input 35.3%, and latency 43.0%; they
raise search and outer MCP tokens 34.8% and 1,733.9% from d58's mostly hidden,
mostly incorrect execution path.

The deterministic artifacts are
[`issue-322-trailing-audit.json`](./issue-322-trailing-audit.json),
[`issue-322-trailing-audit.md`](./issue-322-trailing-audit.md),
[`issue-322-trailing-development.json`](./issue-322-trailing-development.json),
and [`issue-322-trailing-development.md`](./issue-322-trailing-development.md).
The release gate passes with 21/21 scenarios, 93.1% top-1, 100% recall, and
40% negative false positives. The sealed holdout remains byte-identical at
`25928ad2634f44ba02653613fd54d3cd93da6bde9a6a7fee845e336a004bbb1a`.

Trailing coverage costs 6,087 of 20,385 held-out discovery response tokens,
or 29.9%. That is slightly larger than verbose coverage's 5,945 tokens and
29.4% share. It is also larger than the first compact wire. The signal earns a
cold-agent routing benefit only in trailing position; it is not a wire-size
win. Development top-1 and recall remain 100%; trailing coverage costs 662 of
2,182 response tokens, or 30.3%.

This 10-run canary suggested a route benefit but could not establish one. The
preregistered 30-run qualification below supersedes its merge verdict. Do not
use the 10-run result as release evidence.

## Preregistered 30-run off-vs-trailing qualification

The machine-readable plan was committed before sampling at
`6b84d5f57749323b675bab7d0c9e2cd705fd59e1`. The same OID was pushed to
`refs/heads/eval/322-current-discovery-evidence` during the first batch. No
gate, scorer, run, or arm changed after sampling started. The committed
[`remote provenance`](./issue-322-preregistered-provenance.json) records the
remote OID and hashes for the plan, exact coverage-off patch, comparison, and
both raw arms.

The plan used 30 fresh sessions per arm in six five-run batches. The fixed
schedule interleaved both arms. Both arms used `gpt-5.6-sol`, Codex CLI
0.147.0, Node 26.5.1, tokenizer `o200k_base`, concurrency 5, the same prompt,
and byte-identical harness, corpus, sandbox, isolation, and scoring. Both arms
recorded zero host actions and zero foreign MCP calls.

The raw results are
[`issue-322-preregistered-off.json`](./issue-322-preregistered-off.json) and
[`issue-322-preregistered-trailing.json`](./issue-322-preregistered-trailing.json).
The generated
[`machine comparison`](./issue-322-preregistered-comparison.json) and
[`Markdown comparison`](./issue-322-preregistered-comparison.md) apply the
preregistered gates without adjustment.

| Correctness metric | Coverage off | Trailing | Movement |
| --- | ---: | ---: | ---: |
| Exact address | 18/30 | 24/30 | +20.0 pp |
| Exact arguments | 18/30 | 24/30 | +20.0 pp |
| Final answer | 20/30 | 25/30 | +16.7 pp |
| Address + arguments + final | 18/30 | 24/30 | +20.0 pp |
| Clean intended route | 9/30 | 13/30 | +13.3 pp |
| Clean-route Fisher two-sided p | — | — | 0.421975 |
| First-search top-1 | 30/30 | 30/30 | 0 pp |
| First-search complete recall | 30/30 | 30/30 | 0 pp |

| Efficiency metric | Off mean | Trailing mean | Ratio | Off median | Trailing median | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Whole-agent input | 68,834.1 | 64,452.1 | 0.936 | 62,780.0 | 63,452.0 | 1.011 |
| Non-cached input | 19,298.1 | 18,926.7 | 0.981 | 18,950.5 | 18,813.0 | 0.993 |
| Connecta round trips | 2.3 | 1.9 | 0.826 | 2.0 | 2.0 | 1.000 |
| Wall latency, ms | 32,276.7 | 25,495.9 | 0.790 | 27,000.1 | 20,895.7 | 0.774 |
| Search-result tokens | 1,627.8 | 1,448.2 | 0.890 | 1,301.0 | 1,631.0 | 1.254 |
| Connecta MCP tokens | 663.6 | 870.8 | 1.312 | 236.5 | 522.0 | 2.207 |

Combined correctness passes noninferiority with a +20-point movement. All
preregistered mean, median, latency, and isolation gates pass. Search tokens
fall on the mean but rise on the median. Connecta MCP tokens rise on both.
Those secondary measures cannot offset a failed primary gate.

The clean-route gate fails both required parts. The observed improvement is
13.3 points, below the 20-point minimum, and Fisher p=0.421975, above 0.05.
The prior 4/10 to 7/10 route movement did not reproduce at sufficient scale.
This candidate does not prove that its 29.9% deterministic coverage-token cost
causes the intended route benefit.

All tested `queryCoverage` shapes are blocked: verbose coverage lost its
coverage-off ablation, the first compact shape regressed efficiency, and the
trailing shape failed the preregistered route gate. **Do not merge PR #334 or
release any tested coverage shape.** Remove serialized `queryCoverage` while
preserving the ranking improvement. Qualify that removal before release. A new
shape requires a new preregistered qualification.

## Commands

```sh
npm --prefix eval/current-version run audit:development
npm --prefix eval/current-version run audit -- \
  --output results/issue-322-current-audit.json \
  --report results/issue-322-current-audit.md
CONNECTA_EVAL_AGENT_MODEL=gpt-5.6-sol \
  node eval/current-version/issue-322-qualification-runner.mjs \
  --off-worktree /tmp/connecta-322-off \
  --trailing-worktree /tmp/connecta-322-trailing
npm --prefix eval/current-version run check
npm run check
```
