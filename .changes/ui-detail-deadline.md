---
type: changed
---

Operator-page connector details stop waiting on a downstream after 8 seconds, or after `discovery.probeTimeoutMs` when that is shorter, instead of the full 30-second probe deadline. A connector that does not answer in time now reports the typed problem `connector_timeout` and renders as **Not responding** with a fix prompt and Refresh, still showing its credential card. The page no longer retries a timed-out connector on its own or on focus; Refresh reads it again, and a consent return from OAuth keeps polling through a timeout. Agent discovery keeps the full `discovery.probeTimeoutMs`.
