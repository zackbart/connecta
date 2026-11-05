---
type: added
---

`classification` accepts a new value, `"read-repeatable"`, the migration path for a deployment that overrode a vendor-declared write to `"read"` on purpose. The deployment has checked the tool and accepts that hosts may repeat it, so it serves as a read on every route: read annotations, read-only endpoints, `call_tool`, programs and its plain native name. A host's resend after a connection failure can reach the vendor twice. Connecta still sends it at most once and never replays it after an authorization failure. Plain `"read"` is unchanged: it does not apply over a declared write, so a vendor that later declares one fails safe.
