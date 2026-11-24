---
type: changed
---

`pnpm run eval:perf` now measures the built `dist/` package over a matrix of catalog TTL, connector count, catalog size, result size and secrets, and records per-request storage round trips and statements, downstream requests and response bytes beside latency. The counts are committed in `eval/baselines/perf.json` and checked in CI's `behavior` job; a change that moves one updates the baseline with `--update-baseline` in the same PR.
