---
type: security
---

A read program (`execute_read_code`), and `execute_code` on a read-only endpoint, now lists a connector's catalog again before admitting a call when the copy its request retained has passed its TTL (#1414). Previously such a program admitted every call against the catalog listed at its first use, so a downstream that reclassified a tool from read to write mid-program without sending `notifications/tools/list_changed` could have that tool dispatched by a program that never writes. The tool is now refused (`destructive_tool_requires_approval`, or `read_only_endpoint`) and nothing is sent. Calls within a catalog's TTL list nothing again, concurrent calls share one relisting, and a zero-TTL catalog is listed again before each later call in such a program. Writable `execute_code`, `call_tool` and `call_destructive_tool` keep the catalog their request retained.
