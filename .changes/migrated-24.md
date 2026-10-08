---
type: fixed
---

Keep each OAuth grant bound to one issuer by construction. Flow entry binds the current epoch; reads, writes and consent completion remain fenced to that epoch, so superseded flows cannot change a newer grant or return its consent URL. On the first grant read, the one-shot layout-2 migration preserves consistently issuer-stamped credentials, rejects unstamped or inconsistent credentials, and discards pending consents.
