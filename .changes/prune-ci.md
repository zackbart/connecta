---
type: changed
---

Simplify CI and the contributor checks. Every job runs for every change, with no path, planning-only or goldens-tier selection, and the `check` gate fails unless every job succeeded. workerd runs only the suites whose behaviour can differ from Node's, listed in `vitest.config.ts`, instead of every portable suite. `security` audits on every PR and push, replacing the nightly workflow; provider drift scans every provider. `check:static` and `check:build` name CI's static and build jobs, `test:node` runs the complete Node project with coverage enforcement, and `check:fast` uses Vitest's `--changed` selection.
