---
type: fixed
---

Infer write outcomes and reconciliation advice from call-owned dispatches. A complete failed call that dispatched only auxiliary reads keeps its retry or authorization recovery advice, including when it reports a timeout. Missing or incomplete evidence, invocation deadlines, cancellation, and dispatched call-owned writes remain conservative.
