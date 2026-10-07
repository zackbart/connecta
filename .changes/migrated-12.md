---
type: changed
---

Validate Clerk OAuth audiences on `/mcp` and pool endpoints for both JWT
and opaque tokens. Enable Clerk's `aud_claim_enabled` setting and request the
endpoint's canonical URL as `resource`. Omitted or empty `allowedOAuthClientIds`
requires bound tokens; an explicit list admits unbound tokens from dedicated
clients only. Clerk browser session tokens authenticate operator routes only.
Rejections log fixed reason codes, and the MCP `401` metadata challenge is
unchanged.
