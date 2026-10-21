---
type: changed
---

Reduce required PR CI to static/build, complete Node coverage with INV/spec enforcement, selected native workerd boundaries, and a fail-closed `check` gate. Browser and dependency audit block relevant PRs through one inline changed-files step; main and nightly always run both. Compare forward/reverse golden bytes on Node and canonical bytes on workerd, with repeats and jitter nightly. Run package/Docker smoke on main and nightly and advisory provider drift weekly. Remove custom selection machinery, retain a small no-new-provider-exemptions check, and keep additional release checks in `release:check`.
