---
type: security
---

A call now revalidates its connector's catalog when the copy its request retained has passed its TTL, before admitting the call (#1414). Previously a program admitted every call against the catalog listed at its first use, so a downstream that reclassified a tool from read to write mid-program without sending `notifications/tools/list_changed` could have the tool dispatched by `execute_read_code`, which never writes. The relisted catalog now governs admission: `execute_read_code` refuses the reclassified tool with `destructive_tool_requires_approval` and sends nothing, and `execute_code`, `call_tool` and `call_destructive_tool` admit it as a write. Calls within a catalog's TTL list nothing again; a catalog with a zero TTL is listed again before each later call in the program.
