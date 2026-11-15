---
type: fixed
---

A read program, or another call whose admission revalidates an expired catalog, now relists each connector at most once per request. A relisting that came back with a zero TTL, uncached, or through the stale fallback is kept for the request's remaining calls instead of costing a full `tools/list` before every call.
