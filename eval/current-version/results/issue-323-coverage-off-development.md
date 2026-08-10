# Issue #322 development discovery evidence

Source commit: `aca486ce83abd9b9ac5084927c254ca26d353a08`

Runtime: Node 26.5.1 on darwin-arm64; tokenizer `o200k_base`

Machine-readable results: [`issue-323-coverage-off-development.json`](./issue-323-coverage-off-development.json)

## Result

- Development gate: pass
- Expected top-1 accuracy: 100.0%
- Positive recall: 100.0%
- Mean precision: 12.5%
- Serialized query-coverage rows: 0
- Serialized query-coverage bytes/tokens: 0/0

The development corpus is separate from the sealed release holdout. The server exposes only its synthetic analytics connector on loopback. It does not call a model, the Codex CLI, a host app, a plugin, or an external account.
