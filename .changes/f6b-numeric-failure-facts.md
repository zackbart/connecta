---
type: fixed
---

Preserve failure classification and bounded retry delays when sent private values match declared numeric response headers or body fields. Delays are read as whole seconds or an HTTP-date and capped at 24 hours; off-spec values such as `"1.5"` no longer give a retry hint. Failure messages and operator records continue to use redacted data.
