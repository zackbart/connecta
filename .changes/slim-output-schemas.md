---
type: changed
---

`tools/list` now advertises open output schemas for `execute_code`, `search_tools` and `authorize_connector`: required keys and top-level types, with every other field open. Served results are unchanged, and the server still validates each successful one against the full contract before sending it. A client that read the closed schema or `$defs.failure` from `tools/list` finds the failure and handoff shape in `documentation/meta-tools.md`.
