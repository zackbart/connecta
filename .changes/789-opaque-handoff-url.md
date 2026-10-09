---
type: fixed
---

Issue compact downstream-OAuth handoff URLs with opaque, unpadded base64url tokens so agents can copy them intact. Preserve exact signature verification, all identity and lifetime checks, and pre-upgrade links until their original expiry. Authorization guidance now tells agents to copy the URL unchanged and request a fresh link when it is invalid or expired.
