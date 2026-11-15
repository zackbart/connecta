---
type: added
---

Activity fills three telemetry gaps. A request that declares no clientInfo, such as every call after a legacy `initialize`, records its User-Agent `product/version` as `clientName`/`clientVersion`. A run that a host-call, notice or emission-attempt budget ends records one `program` row with `budget_exceeded` even when operation history is off. With `activityHistory({ operations: true })`, program rows add write counts (`succeeded`, `failed`, `unknown`) and `authorize_connector` calls add an `authorize` row.
