---
type: fixed
---

Sanitize OAuth token-endpoint failures before they reach the SDK or its console diagnostics. Failures retain the HTTP status, registered OAuth error code and `Retry-After`, with fixed descriptions instead of downstream response text. Invalid code-exchange responses receive the same treatment, and migrated grants retain their issuer stamps.
