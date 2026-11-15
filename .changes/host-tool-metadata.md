---
type: added
---

Meta endpoints mark one entry tool `_meta["anthropic/alwaysLoad"]: true` (`execute_read_code` where it is listed, else `execute_code`), so Claude Code loads it upfront instead of behind its tool search; native pools mark none. Result-returning tools carry `_meta["anthropic/maxResultSizeChars"]` when their configured cap would let a result pass Claude Code's 50,000-character inline line: direct calls, native downstream tools and `read_result` advertise their direct-call cap plus 8,192, and program tools `execute.maxResultChars` plus 12,192, at most 500,000. Default caps send no size hint.
