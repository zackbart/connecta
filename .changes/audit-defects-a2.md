---
type: security
breaking: true
---

Close audit defects in the HTTP providers. A write that fails ambiguously (a 5xx, a broken-off reply, or a connection lost after sending) is now reported as a non-retryable unknown outcome in Tithe.ly, Planning Center, Church Community Builder, Breeze (whose writes use GET), Overflow, Infisical, and GitHub's REST tools, instead of a retryable `unavailable`; reads keep `unavailable`. `api()` downstream OAuth refreshes on a 401 but never resends a write-classified call, whatever its HTTP method, and the call reports an unknown outcome. Church Community Builder and Tithe.ly drop their sensitive fields from every result, `raw: true` and the hatches included, unless deployment code sets the new `sensitiveFields: "return"` option; Breeze hatches no longer return a calendar's keyless feed address. Maintained providers derive connector contexts so the caller, admission permit, recovery facts, and sent-secret redaction survive the copy, and `api()` no longer mutates the registry's context.
