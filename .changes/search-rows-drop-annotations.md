---
type: changed
---

Search rows from `search_tools` and `connecta.search` no longer repeat the tool's `annotations` beside `classification`, the served read/write verdict; `describe` still returns them. This saves about 100 bytes per row. The usage guide and search description now call `guideRequired` advisory (nothing blocks the call) and say that optional fields such as `absence` and `signature` appear only when they apply.
