---
type: added
---

Add `execute.maxResultChars`, the serialized characters an `execute_code` program may return before Connecta stashes the return behind a paging notice. The default stays 24,000; values from 4,000 to 1,000,000 are accepted, and anything else fails at construction. Emitted text shares the configured cap, and the paging notices that `execute_code` and direct calls return ask for pages sized to it instead of a fixed 3,829 bytes, never more than the stashed call's `maxResultBytes` or the 32 KiB bridge ceiling. A connector whose cap is below 3,829 bytes now gets a notice asking for the page size it actually serves. `describeConfig()` and the operator settings report it. Stash pages still obey each call's `maxResultBytes`. Connecta has no response-size limit, so keep the cap below what every client accepts: Claude Code passes at most 50,000 characters of text.
