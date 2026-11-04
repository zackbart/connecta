---
type: fixed
---

Program writes no longer hide how they failed or leave altered. `write_outcome_unknown` now carries `unknownWrites` with each write's address, code and redacted message, plus `toolAnswered: true` when the downstream tool answered `isError`; the outcome stays unknown and nothing is sent again. A program write whose arguments match a credential the request already sent is refused before dispatch with `invalid_args`, rather than sent with `[redacted]` in place of the match, which could first appear on a program's second call. Operator logs name a tool's own failure `DownstreamToolError` rather than `Error`.
