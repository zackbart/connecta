---
type: added
---

`eval:agent --target worker` runs the agent tasks and graders against the production Worker shape (local D1, the Dynamic Worker executor and Access) under `wrangler dev`, refuses the tasks it cannot serve, records the target in every result, and pairs node with worker results only through `eval:compare --cross-target`.
