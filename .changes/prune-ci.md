---
type: changed
---

Run CI jobs in parallel without path, planning-only, or goldens-tier selectors. Keep the required `check` gate fail-closed on every job result, and run the complete Node suite with invariant and spec evidence enforcement. Limit workerd to platform-sensitive suites, including native-output privacy guards and provider goldens. Audit dependencies on every PR and main push as well as nightly. Replace the custom local change selector with Vitest's built-in selection, and expose `check:static` and `check:build` for the shared local and CI steps.
