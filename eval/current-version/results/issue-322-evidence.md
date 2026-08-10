# Issue #322 discovery evidence

The current release audit passes. The mixed all/partial development case now
has complete retrieval. The coverage-off ablation is better than coverage-on
for execution correctness, round trips, whole-agent tokens, and latency.
Current `queryCoverage` is not justified by this evidence. Keep the ranking
fix, but redesign #323's coverage into a compact form before release.

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

## Commands

```sh
npm --prefix eval/current-version run audit:development
npm --prefix eval/current-version run audit -- \
  --output results/issue-322-current-audit.json \
  --report results/issue-322-current-audit.md
CONNECTA_EVAL_AGENT_MODEL=gpt-5.6-sol \
  npm --prefix eval/current-version run perf:lookup -- \
  --case mixed-decoy-organizations --repetitions 10 --concurrency 5
npm --prefix eval/current-version run check
npm run check
```
