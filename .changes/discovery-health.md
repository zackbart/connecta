---
type: changed
---

Unscoped search now remembers a connector whose discovery timed out or failed slowly and skips it for up to 60 seconds, reporting it in `catalogErrors` with `retryAfterMs`. Each connector gets at most 5 seconds and the whole fan-out ends within a 9-second budget. Records are typed facts partitioned by owner and configuration, lapse on a credential change, and clear on recovery. Scoped search, describe and calls still reach the connector.
