# Current-version benchmark

This is the active whole-agent benchmark for Connecta's seven-tool surface. It is deliberately small: four deterministic cases, one runner, one fixture server, and exact pass/fail checks.

The cases answer four product questions:

1. Does a cold unknown-address read stay inside one `execute_code` program?
2. Does a known-address read take the cheaper direct `call_tool` route?
3. Does the agent obey provider semantics rather than fuzzy-matching plausible names?
4. Does code mode paginate and reduce private records without forwarding them to the model?

Every run records whole-agent input, cached-input, and output tokens from the Codex CLI; model-visible MCP result tokens; outer MCP response bytes plus separate `content` and `structuredContent` bytes; latency; chosen meta-tools; exact downstream calls; and the final answer. A run passes only when routing, answer, semantics, and privacy all pass.

## Run it

Prerequisites are a working `codex` CLI login and the repository's normal Node dependencies.

```sh
npm --prefix eval/current-version install
npm --prefix eval/current-version run check
npm --prefix eval/current-version run benchmark
```

The default is three sequential repetitions of all four cases and writes ignored `results/latest.json` and `results/latest.md` files. Narrow a diagnosis without changing the benchmark:

```sh
npm --prefix eval/current-version run benchmark -- --case semantic-analytics --repetitions 1
```

Supported case ids are `cold-unknown-read`, `known-address-read`, `semantic-analytics`, and `private-pagination`.

Runs pin `gpt-5.6-sol` by default. Set `CONNECTA_BENCHMARK_MODEL` to test another exact model id; reports record the selected id.

## Interpretation

Use the JSON as evidence. The Markdown is only a compact reading view. In particular, do not infer that result forwarding can be changed merely because one Codex run succeeds: `forwarding.representationDuplicated` makes the current cost visible, but changing the MCP representation still requires the supported-client compatibility matrix recorded in the changelog and issue #483.

Historical issue-specific runners and snapshots were removed from the active tree when this benchmark replaced them. Git history remains their archive. `results/issue-350-evidence.md` stays because current documentation links to that release evidence.
