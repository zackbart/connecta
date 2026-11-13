---
type: added
---

Writable `/agent/<pool>` endpoints list `execute_read_code`, with the same contract as people's endpoints: it is annotated read-only, every write it attempts is refused below the sandbox with nothing sent, and `execute.readRoute: false` turns it off. Read-only and native agent pools keep their tools. Endpoint facts gain `executeReadCode`, and `@zackbart/connecta-eve` sends lookups to `execute_read_code` and changes to `execute_code` or `call_destructive_tool` when it is listed. (#1410)
