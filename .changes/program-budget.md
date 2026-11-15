---
type: added
---

`connecta.budget()` in programs resolves to the run's own remaining bounds, `{ hostCallsLeft, writesLeft, msLeft }`: host calls before the terminal `budget_exceeded` stop, writes before the write budget (0 on read-only endpoints and in `execute_read_code`), and milliseconds before the run stops sending calls. It spends no host call, is not logged in `calls`, and lets a loop return partial results with a cursor instead of hitting the budget stop.
