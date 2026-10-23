---
type: security
---

Value safety now takes its most protective choice when sent-secret redaction changed a value it decides on: a resource type, a record's label or type, an environment entry, a URL's scheme or parameter name, a header line's name, a streamed row's field name, a response's Content-Type, or the public prefix of a credential (such as `sk_live_`, `whsec_` or `Bearer `) whose remainder follows. Such a response may withhold more than before; other responses are unchanged.
