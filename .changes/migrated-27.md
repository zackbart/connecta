---
type: fixed
---

**A token endpoint cannot stamp its own issuer.** A refresh answer carrying
`issuer` had that field kept when connecta persisted a rotation for a
cancelled caller with no issuer to stamp. Only the client binds a grant, so
the field is dropped, as the SDK drops it.
