---
type: fixed
---

Infer write outcomes and reconciliation advice from call-owned dispatches. A failed maintained-provider call with complete tracking that positively recorded an auxiliary resource read and no call-owned dispatch keeps its retry or authorization recovery advice, including when it reports a timeout. Explicit unknown-outcome markers always take precedence. Empty ledgers, missing or incomplete evidence, authentication POSTs alone, custom `api()` and `remoteMcp()` connectors, invocation deadlines, cancellation, and dispatched call-owned writes remain conservative. Refuse auxiliary kit requests marked as reads unless they use GET or HEAD without a method override.
