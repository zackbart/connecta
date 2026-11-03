---
type: fixed
---

`workerExecutor()` works with `@cloudflare/codemode` 0.5.5 and later. Those releases close a call gate when the SDK's `execute()` settles, and Connecta's inert loader settled it before the real program ran, so every `execute_code` host call failed with "The code execution finished before this tool call settled". The gate now stays open for the whole native run and closes when it ends or its lease is released. Development and CI use codemode 0.5.6.
