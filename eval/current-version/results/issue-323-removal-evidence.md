# Issue #323 query-coverage removal evidence

The candidate removes serialized per-result query coverage and preserves the
mixed complete/partial lexical ranking. The deterministic release and
development gates pass. A five-session cold smoke completes the intended call
in every run.

## Provenance

- Baseline product: `0fbc50f775eb9d418b6aa8b40dcddd547762b59c`
- Removal product: `aca486ce83abd9b9ac5084927c254ca26d353a08`
- Node: 26.5.1 on darwin-arm64
- Tokenizer: `o200k_base`
- Sealed holdout SHA-256:
  `25928ad2634f44ba02653613fd54d3cd93da6bde9a6a7fee845e336a004bbb1a`

The baseline ran in a detached worktree at exact `0fbc50f`. It used the eval
tree from `aca486c` so both products used the same byte-measuring harness,
corpus, tokenizer, executor, and scoring. The product source stayed at
`0fbc50f`; only `eval/current-version` was overlaid.

Artifact hashes:

- before audit: `46419e49520a40a88f7b97ab669870a9c3eb1c70f55b7340a8dc6cd8e6e4de8c`
- removal audit: `a65e32ec11c9a10517aa826c1b85899e299c4d98c7bbd40374c36633f901bb97`
- development audit: `b90f7fd1dbd93681570326f4806eb2a0c207ffb8b8f6ecd48899aceeebb8171c`
- cold smoke: `5cd6acc4f3a4857fd0bb09ffb9cdcbb06058b13fa79178aa29e9b82a15a81ea3`

## Sealed holdout

[`issue-323-before-audit.json`](./issue-323-before-audit.json) and
[`issue-323-coverage-off-audit.json`](./issue-323-coverage-off-audit.json) both
pass all 21 task scenarios. The holdout is byte-identical in both arms.

| Metric | Main | Removal | Movement |
| --- | ---: | ---: | ---: |
| Top-1 | 93.1% | 93.1% | 0 pp |
| Expected top-1 | 82.8% | 82.8% | 0 pp |
| Positive recall | 100.0% | 100.0% | 0 pp |
| Default-page recall | 100.0% | 100.0% | 0 pp |
| Negative false positives | 40.0% | 40.0% | 0 pp |
| Mean precision | 63.5% | 63.5% | 0 pp |
| Mean results | 3.206 | 3.206 | 0 |
| Discovery response bytes | 87,340 | 63,234 | -24,106 (-27.6%) |
| Discovery response tokens | 20,243 | 14,298 | -5,945 (-29.4%) |
| Mean discovery response tokens | 595.4 | 420.5 | -174.9 (-29.4%) |
| Serialized coverage rows | present | 0 | removed |

The exact removed discovery wire is 24,106 JSON bytes and 5,945
`o200k_base` tokens across 34 held-out queries. This is the complete difference
between each discovery result and its coverage-free counterfactual. The whole
55-call audit removes 24,526 response bytes and 6,056 response tokens because
other audit tasks also exercise discovery. The shorter `search_tools`
definition removes another 18 definition tokens.

## Development ranking

[`issue-323-coverage-off-development.json`](./issue-323-coverage-off-development.json)
uses the separate mixed all/partial corpus. Expected top-1 and recall remain
100%. Both cases return zero serialized coverage rows, bytes, and tokens. The
exact-name framing case still ranks `List-All-Organizations` first for `list
all organizations projects`; the ordinary mixed case still ranks
`List-Organizations` first.

The portable regressions also prove:

- grouped `search_tools` and flat `connecta.search` rows contain no
  `queryCoverage` or score;
- default and maximum pages remain coverage-free;
- empty and whitespace-only queries still browse;
- Unicode-only queries remain bounded no-matches;
- mixed Unicode queries search their ASCII terms;
- partial results retain `queryAnalysis` and stable pagination;
- safety filters, compact schemas, enum bounds, and result envelopes stay on
  their existing paths.

## Cold smoke

[`issue-323-coverage-off-cold-smoke.json`](./issue-323-coverage-off-cold-smoke.json)
uses five fresh sessions at concurrency five with `gpt-5.6-sol`, Codex CLI
0.147.0, Node 26.5.1, the exact `aca486c` product, and zero host or foreign
calls.

| Metric | Result |
| --- | ---: |
| First-search top-1 | 5/5 |
| First-search complete recall | 5/5 |
| Exact address | 5/5 |
| Exact arguments | 5/5 |
| Final answer | 5/5 |
| Address + arguments + final | 5/5 |
| Clean intended route | 4/5 |
| Mean Connecta round trips | 1.8 |
| Mean search-result tokens | 1,161.6 |
| Mean whole-agent input tokens | 63,812.0 |
| Mean non-cached input tokens | 14,967.2 |
| Mean latency | 20.8 s |

This is a smoke test, not a new causal or significance claim. The 30-run
coverage-off arm in issue #322 remains the scaled evidence for the target
shape.

## Migration risk

Version 0.14.2 never published `queryCoverage`, so released deployments have no
migration. A caller built against the brief unreleased `main` surface that
reads `queryCoverage` will lose that field in both grouped and flat search
rows. It must select from the existing purpose, address, schema, safety, and
output shape, and use page-level `queryAnalysis` for partial or no-match
recovery. There is intentionally no replacement per-result score or coverage
field.
