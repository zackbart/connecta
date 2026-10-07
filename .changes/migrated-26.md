---
type: fixed
---

**A rotation that cannot be stored is a retryable outage, not consent.**
When the authorization server honored a refresh but its new tokens could not
be written, the SDK used to swallow the failure and start authorization, so
a passive call answered `auth_required` for a grant that was still good. It
now fails `unavailable` and retryable, writes no consent URL, and leaves the
stored grant as it was. Any failed credential write — tokens, client
registration, PKCE verifier — reports fixed text with no cause attached,
because a store's own error can quote the value it refused.
