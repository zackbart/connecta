---
type: changed
---

Reduce required PR CI to static/build checks, the complete Node suite with invariant and spec enforcement, runtime-specific workerd suites, and the fail-closed `check` gate. Compare each provider golden once per runtime. Run browser, dependency audit, and package/Docker smoke on main and nightly, with native path-filtered browser and dependency PR workflows; run advisory provider drift weekly. Remove custom selection machinery and the provider exemption history comparison, retaining provider conformance checks. Make local `check` mirror required PR CI and put the additional checks in `release:check`.
