---
type: security
---

The Eve helper's dependency audit ignores GHSA-fc5q-39xc-vjpf (picomatch ReDoS, no patched release) until picomatch ships a fix (#1480). It reaches only the helper's development and build tooling; core's production audit is unchanged and clean.
