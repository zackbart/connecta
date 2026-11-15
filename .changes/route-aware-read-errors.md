---
type: fixed
---

`execute_read_code` budget stops, limit errors, timeouts (including executor-reported ones) and the unpageable-return hint now name `execute_read_code` instead of `execute_code`, and its host-call stop no longer warns against resending writes it could not send. `execute_code` messages are unchanged.
