---
type: added
---

Meta endpoints mark one entry tool `_meta["anthropic/alwaysLoad"]: true` (`execute_read_code` where it is listed, else `execute_code`), so Claude Code loads it upfront instead of behind its tool search; native pools mark none. When a configured result cap plus 8,192 characters exceeds Claude Code's 50,000-character inline line, `call_tool`, `call_destructive_tool`, both program tools and native downstream tools carry `_meta["anthropic/maxResultSizeChars"]` derived from that cap (at most 500,000), so capped results arrive inline instead of in a spill file. Default caps send no size hint.
