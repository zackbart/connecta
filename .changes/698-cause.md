---
type: fixed
breaking: true
---

Sanitize connector failures at shared request boundaries (#695). Transport, parser and unexpected handler failures expose checked failure facts and fixed descriptions instead of downstream-derived causes or nested errors. Agent-facing downstream refusals retain their classification and pass through request credential redaction. Callers that inspected error causes must use typed details instead.
