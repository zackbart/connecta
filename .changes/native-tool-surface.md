---
type: added
---

Add a native tool surface for clients with their own tool search: a pool with `surface: "native"` lists each downstream tool as `<connector>__<tool>`, annotated read or write from its classification, beside `skills` and `execute_code` (or `read_result` with `executeCode: false`), and runs every call through the existing `call_tool` or `call_destructive_tool` path.
