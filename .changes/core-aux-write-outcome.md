---
type: fixed
---

Infer write outcomes and reconciliation advice from call-owned dispatches. A failed maintained-provider call whose complete tracking records an auxiliary resource read and no call-owned dispatch keeps its retry or authorization recovery advice, including when it reports a timeout. Explicit unknown-outcome markers always take precedence. Empty ledgers, missing or incomplete evidence, authentication POSTs alone, kit requests falsely declared as auxiliary reads, custom `api()` and `remoteMcp()` connectors, invocation deadlines, cancellation, and dispatched call-owned writes remain conservative. Auxiliary effect labels do not change core write reservation or replay rules.
