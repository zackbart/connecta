---
type: fixed
---

`execute_code` programs that read a property off a `connecta.call` or `connecta.search` result without `.data` or `.tools` now get the `{ data, format }` / `{ tools }` shape hint under both QuickJS and V8 wording, and the `result()` declaration in the tool description now includes the `connecta.result(id, { all: true })` form that recovery text tells agents to use.
