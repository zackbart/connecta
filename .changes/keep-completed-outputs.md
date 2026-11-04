---
type: added
---

Report the calls that finished before an `execute_code` run failed as `error.completed`, and keep their outputs in the result stash for `connecta.result`, so a later throw, deadline or budget failure no longer discards a write's only output. The host holds up to 1 MiB per run, drops older reads first, and writes to the stash only on failure; a full stash leaves addresses and says so.
