---
type: added
---

Add `connecta.result(handleOrId, { all: true })`, which reads a retained result whole as `{ data, format }` for one host call up to a read ceiling of 1.5 MiB (scaled with `cpuTimeMs` on QuickJS, and declared by the new optional `Executor.maxReadBytes`), and throws a catchable `result_too_large` above it. A read's finished transfer now gives its stash back, up to three per run within a one-second budget, leaving the run's unsealed ledger first. Handles within the ceiling now say to read whole. Migration: an oversized program return's `nextAction` now reads whole and marks where to reduce, instead of returning a 3,829-byte page, so code that parses that action's output as a page should read `connecta.result` with `{ offset }` instead.
