---
type: fixed
---

Charge Cloudflare zone-ownership lookups for account pin enforcement to the
connector's shared call-admission budget. An exhausted budget refuses the lookup
and enclosing call before sending the lookup or target request. Keep the separate
limits of three ownership lookups per call and 60 per five minutes per connector.
