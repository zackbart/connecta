# Connecta usability evaluation, September 7, 2026

The local transcript review covered 2,222 recorded BePresent MCP calls across
120 t3code threads. Recurring friction included choosing the wrong account,
relearning project prerequisites, guessing result shapes, confusing payment
with access, and continuing after the requested evidence proved unavailable.
This change addresses how Connecta presents its existing capabilities and how
agents discover and use them. No BePresent deployment was changed.

## What changed

Configured account titles now appear in the initial connector inventory and
program search results. The latter previously discarded those titles. Both are
bounded and require no provider call. Agents can distinguish production from
sandbox before reading customer data.

The execute instructions state the actual search and call result shapes,
recommend JSON schemas for programmatic inspection, and require checking Promise.allSettled
status before interpreting values. Failed checks and missing fields remain
unknown. Unfamiliar provider results may be returned as a small sample before
continuing, replacing the instruction to finish every investigation in exactly
one program.

The optional investigation guide explains evidence, scope, and stopping points
for recurring tasks. The usage example now performs separate scoped searches
and handles missing dependent evidence. The example itself runs in QuickJS tests.

## Method

Fresh Codex 0.153.0 sessions requested `gpt-5.6-sol`, with only a local synthetic
MCP fixture connected. Normal CLI authentication was used for model access;
no deployment credentials or live provider data were used. The prompts requested
outcomes without specifying a particular route. The same runner and fixtures
were used for the baseline and candidate. Cases were derived from the transcript
review and used while iterating, so these are regression checks, not a held-out
validation set.

The initial baseline is commit `bf7d96e04ffa9f910fd8e52f926253b0f838362c`.
Baseline and candidate builds were frozen separately. The fingerprint below is
SHA-256 over the names and contents of compiled `execute.js`, `skills.js`, and
`catalog-service.js`, in that order.

- Baseline: `12697d93612f28ff15caf3d46a8d5441b8a255c4c9e75f9da30f3b2730667470`
- Initial candidate: `2f1a29b4ef66a786cde5595bd339a116f68ae3f18df79d33b24ba10002e6ce37`

Each case checks the answer and its evidence. Purchase verification also rejects
sandbox reads, even if the final answer is correct. Capability detection requires
reading the connector guide and rejects substituting an aggregate query for an
individual timeline. The experiment fixture uses synthetic argument shapes;
it does not claim to reproduce a live provider schema.

Tool counts include guide fetches. Errors count top-level error responses,
not every caught or nested failure. Session latency includes model reasoning
and host overhead. Samples are small and model latency varies.

## Initial comparison before the upstream cleanup

Two fresh runs per task on each build. The baseline passed 6/8; the initial candidate passed 8/8. Neither candidate set had a top-level tool error.

| Task | Baseline passed | Candidate passed | Baseline tools | Candidate tools | Baseline errors | Candidate errors | Mean seconds, baseline → candidate |
| --- | ---: | ---: | --- | --- | --- | --- | ---: |
| text-project-resolution | 2/2 | 2/2 | 6, 8 | 4, 4 | 2, 3 | 0, 0 | 140.4 → 53.9 |
| purchase-verification | 0/2 | 2/2 | 5, 3 | 3, 4 | 0, 0 | 0, 0 | 59.1 → 51.4 |
| experiment-check | 2/2 | 2/2 | 4, 7 | 4, 5 | 0, 2 | 0, 0 | 74.5 → 55.8 |
| capability-limit | 2/2 | 2/2 | 6, 2 | 4, 4 | 0, 0 | 0, 0 | 76.9 → 52.0 |

The strongest correctness improvement is purchase verification. One baseline run read sandbox before eventually answering correctly; the other returned sandbox payment/access as production. Both candidate runs used production and correctly reported a paid purchase without subscription access.

For text-formatted project lookup, the candidate inspected the returned shape and used the exact project id. It avoided the baseline’s repeated field and parser guesses. Experiment and capability answers were already correct on the baseline; the candidate retained correctness. Capability detection used the same total number of tools, so these runs do not demonstrate fewer calls for that task.

Raw local reports: `ux-baseline.json`, `ux-text-baseline.json`, `ux-reviewed-a.json`, and `ux-reviewed-b.json` in this directory. They contain synthetic traces and are ignored by Git. This candidate ran as two independent four-case sets with identical recorded fingerprints.

## Iteration evidence

The first guidance-only attempt was insufficient. A frozen intermediate build
passed four of six runs and still produced a confident false answer after
misreading a failed batch result. That failure moved the result-shape rules
into the always-visible execute description.

The next two frozen variants each passed six of six runs on purchase,
experiment, and capability tasks. They still showed schema mistakes, and the
JSON-schema variant was slower on experiments. Passing an answer check alone
was not evidence that the interaction had become efficient.

The additional text-format case exposed repeated parser guessing under the
one-program instruction. The baseline eventually succeeded in both runs, but
needed six and eight tools, with two and three errors. The inspection variant
succeeded with four tools and no errors in both runs. The inspection exception was retained.

Two early exploratory runs are excluded from comparisons: a baseline run whose
old runner timed out without saving its trace, and a candidate set whose build
changed during execution. The runner now preserves completed-run checkpoints,
records timeout failures, and rejects a set with inconsistent build fingerprints.

## Integration with current main

Main advanced during this work to `597102a8ec488e0dba1e7050f1f520f80262233b`,
which removed batch helpers, connector globals, and client-owned rendering. The
patch was rebased onto that commit and its instructions now use JavaScript
promises and canonical calls. The earlier comparison above concerns the old
implementation and must not be attributed to this newer baseline.

The first routing controls also exposed unnecessary discovery-only calls. Two
of four controls failed their strict route gate while returning correct answers.
The final guidance keeps discovery and calls together when schemas suffice,
while allowing a small sample of an unfamiliar provider result.

For the current-main comparison and independent review, see
[PR #527](https://github.com/zackbart/connecta/pull/527).

## Limits

These evaluations measure behavior within the supplied connection. They do not
establish whether t3code chooses BePresent over another app or browser without a
reminder. They also do not validate Claude behavior, production provider changes,
or reduced user intervention over a long conversation. The optional investigation
guide was not fetched in the initial comparison runs, so their gains cannot be
attributed to that guide.

Connecta cannot supply missing deployment-owned app mappings, restore a broken
host connection, or produce evidence that a downstream provider does not expose.
The changes improve the agent's information and instructions; they do not enforce
correct judgment in every run.
