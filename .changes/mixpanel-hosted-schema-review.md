---
type: fixed
---

Refresh reviewed hosted Mixpanel schemas so Get-Events, Get-Dashboard, List-Cohorts, and Get-Metric remain available to read-only endpoints without deployment overrides. Review the limited-beta Get-Audit-Log as a read, retain Fill-Event-Metadata as a write, and classify Get-Experiment as destructive because its optional computations can persist results and auto-conclude experiments.
