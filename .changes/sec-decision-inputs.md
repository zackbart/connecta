---
type: security
---

Value safety now takes its most protective choice when sent-secret redaction changed a value it decides on: a resource type, a record's label or type, an environment entry, a URL's scheme or parameter name, a streamed row's field name, a response's Content-Type, or the public prefix of a credential (such as `sk_live_`, `whsec_` or a signing parameter's name) whose remainder follows. Echoed sensitive header lines are read before an echoed value in them is replaced, so their whole value is withheld. Such a response may withhold more than before; other responses are unchanged.
