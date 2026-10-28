---
type: added
---

Add `execute.maxResultChars`, the serialized characters an `execute_code` program may return before Connecta stashes the return behind a paging notice. The default stays 24,000; values from 4,000 to 1,000,000 are accepted, and anything else fails at construction. Emitted text shares the configured cap, and the paging notices that `execute_code` and direct calls return ask for pages sized to it (up to the 32 KiB bridge ceiling) instead of a fixed 3,829 bytes. `describeConfig()` and the operator settings report it. Stash pages still obey each call's `maxResultBytes`. MCP responses carry the return twice and have no size limit of their own, so check what your client accepts before raising the cap far.
