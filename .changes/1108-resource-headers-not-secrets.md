---
type: fixed
---

`remoteMcp()` top-level `headers` values are no longer treated as sent secrets. Every call in a code-mode program now reaches the downstream with arguments equal to a header value intact, instead of `[redacted]` after the first call, and results, catalogs and errors that echo a header value return it unchanged. `auth` headers and other credentials are still registered and redacted as before.
