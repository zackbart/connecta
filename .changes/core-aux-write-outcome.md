---
type: fixed
---

Infer write outcomes and reconciliation advice from call-owned dispatches. A complete failed call that positively recorded an auxiliary resource read and no call-owned dispatch keeps its retry or authorization recovery advice, including when it reports a timeout. Empty ledgers, missing or incomplete evidence, authentication POSTs alone, custom entries without recorded dispatches, invocation deadlines, cancellation, and dispatched call-owned writes remain conservative.
