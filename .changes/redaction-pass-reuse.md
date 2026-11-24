---
type: changed
---

Secret redaction no longer walks the same unchanged value twice within a request. A pass over an object a previous pass returned unchanged and frozen, or over the same long string, under the same secret set, revision and mode, returns it without walking again; any new registration, memo write or minted state walks it again first. A remote MCP call result is walked by the invocation's raw and processing passes, and a program presentation by the host-to-guest pass, only when those would differ, and a warm search walks each remote catalog six times instead of eight. In a local benchmark with registered credentials, a 500 KB direct-call result spends about half as long in redaction (670 ms to 350 ms) and a warm search over six remote connectors about a fifth less. The MCP route's final pass and text about to be stored or paged are always walked.
