---
type: fixed
---

The `execute_code` description no longer overstates the deadline of `connecta.result`, `connecta.skill` and `connecta.read`. When `calls.defaultTimeoutMs` differs from `execute.hostCallTimeoutMs`, it states both, for example `Limits: 20 host calls, 10 writes, 25s/call (15s result/skill/read).`, instead of advertising the call default for every host call. Enforcement is unchanged; deployments without `calls.defaultTimeoutMs` see the same `15s/host call` text as before.
