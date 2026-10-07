---
type: fixed
---

**A grant from before issuer binding is retired, not bound to whoever is
named.** A token set or client registration v0.8.1 or earlier wrote carries
no stamp, and connecta bound it on first read to the issuer that read's
discovery found. With discovery not cached, that was the server a
compromised downstream named, and the refresh token and client secret went
to its token endpoint. No stored record proves where such a grant came from:
v0.8.1 kept no discovery at all, and from v0.22.3, which first persisted
discovery, a flow saves it before it reads credentials, so a record beside an
unbound grant may be the downstream's. Such a grant is now retired before
anything it holds is sent. The SDK's own SEP-2352 check does not cover this
state, as its advisory says: it trusts whatever stamp the provider hands
back.
