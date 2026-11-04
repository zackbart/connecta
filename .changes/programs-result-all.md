---
type: added
---

Add `connecta.result(handleOrId, { all: true })`, which reads a retained result whole as `{ data, format }` for one host call up to a read ceiling of 1.5 MiB (scaled with `cpuTimeMs` on QuickJS, and declared by the new optional `Executor.maxReadBytes`), and throws a catchable `result_too_large` above it. Finished transfers now give their stash back, leaving the run's unsealed ledger first: a read's when its value is whole, a write's when its run succeeds. A QuickJS run keeps its answer when freeing its runtime aborts the child, which is then replaced. Handles within the ceiling now say to read whole. Migration: an oversized program return's `nextAction` now reads whole and marks where to reduce, instead of returning a 3,829-byte page, so code that parses that action's output as a page should read `connecta.result` with `{ offset }` instead.
