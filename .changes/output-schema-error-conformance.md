---
type: fixed
---

Error results from `search_tools`, `authorize_connector`, `execute_code` and `execute_read_code` now omit `structuredContent` unless it satisfies the tool's advertised `outputSchema`, carrying the same JSON in text, so hosts that validate error results against the schema no longer reject `search_tools` refusals or declined program authorizations.
