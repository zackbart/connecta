---
type: fixed
---

Meta-tools and native-surface tools drop a host's `wait_for_previous` control key from call arguments before validation, so Gemini CLI's calls to `call_tool`, `call_destructive_tool` and `read_result` no longer fail with `Unrecognized key`. Other unknown keys are still refused, and a native downstream tool whose schema may accept `wait_for_previous` still receives it. (#1431)
