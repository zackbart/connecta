---
type: security
---

Pending downstream OAuth flow records store less. With a sealing vault, the consent URL, server and client binding, and PKCE verifier are sealed together. With no vault, the record stores no consent URL and its binding keeps no URL userinfo, query or fragment, so a repeated non-forced start mints a fresh consent instead of reusing the pending URL. `documentation/auth.md` states the narrower no-vault guarantee. Sealed consents already in flight across the upgrade still complete. A no-vault consent whose discovery URL holds userinfo, a query or a fragment fails cleanly and needs a fresh start.
