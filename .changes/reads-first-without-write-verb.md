---
type: changed
---

Search ranks read rows before write rows within each relevance tier unless the query states a write (`create`, `send`, `update`, `delete`, `reply`, `schedule`, `put`, `refund` and similar, or a present-tense English inflection such as `updates` or `updating`), instead of only after a leading `list`/`get`/`search`-style verb; a leading read verb still reads first. In `execute_read_code`, the rows the route can call lead whatever the query says. Writes stay on the page.
