# Issue #322 development discovery evidence

Source commit: `bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c`

Runtime: Node 26.5.1 on darwin-arm64; tokenizer `o200k_base`

Machine-readable results: [`issue-322-trailing-development.json`](./issue-322-trailing-development.json)

## Result

- Development gate: pass
- Expected top-1 accuracy: 100.0%
- Positive recall: 100.0%
- Mean precision: 12.5%
- Coverage assertions: 1/1
- Cases where coverage distinguishes the name match from description-only decoys: 2/2
- Query-coverage cost: 662 of 2182 response tokens (30.3%)

The development corpus is separate from the sealed release holdout. The server exposes only its synthetic analytics connector on loopback. It does not call a model, the Codex CLI, a host app, a plugin, or an external account.
