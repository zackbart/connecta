---
type: removed
breaking: true
---

Remove catalog drift counts from `/health`, `connecta doctor`, and activity. Remove the old optional drift-count channel and its event type. Keep discrete catalog-change events in the ordinary activity timeline. Authenticated connector status and the maintainer-run provider check retain drift observations.
