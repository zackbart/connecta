---
type: changed
---

On a read-only endpoint, a `readOnly` connector, or for a write a read-only pool does not grant, an `unknown_tool` error now says that search omits refused writes and that only a write's exact address returns `read_only_endpoint`. The note depends only on the scope's configuration: hidden tools, tools outside the pool, and absent names still fail alike.
