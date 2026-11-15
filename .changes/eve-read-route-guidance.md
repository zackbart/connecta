---
type: changed
---

`@zackbart/connecta-eve` now tells the model to send every program that writes nothing to `execute_read_code` when the endpoint lists it, even where other instructions name `execute_code`, and to use `execute_code` only for programs that change something. The guide previously said "lookups", which agents whose own instructions answer questions with `execute_code` did not apply. The helper README asks operators to route their own agent instructions the same way.
