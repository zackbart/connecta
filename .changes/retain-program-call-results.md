---
type: added
---

`execute_code` and `execute_read_code` results carry a top-level `calls` log of the program's `connecta.call` calls (address, outcome and duration; never arguments or values). When a program throws, times out or otherwise fails after reads completed, each completed read gets a `resultId` the agent can page with `connecta.result` in a new program instead of reading again. Writes report their outcome only, and `budget_exceeded` stays terminal: it returns the log with no retained results.
