---
type: changed
---

Read-only scopes list the writes they refuse instead of hiding them. On a read-only endpoint, a `readOnly` connector, or a read-only pool's ungranted write, `search_tools`, describe, `connecta.search` and `connecta.describe` return each write with `classification: "write"` and `callable: false`, with a one-sentence summary. Calls are still refused with `read_only_endpoint` before validation or dispatch. A native pool's tool list still omits these writes, and tools outside the scope stay undiscoverable. The `unknown_tool` note on these scopes now says search lists refused writes with `callable: false`.
