---
type: security
---

Refuse redirects for credential-bearing OAuth token requests in remote MCP and static API connectors. A redirected refresh requires re-consent without another send. Keep spent fingerprints across grant epochs. A new consent can use a byte-identical refresh token only after the earlier dispatch resolved and the consent observed that resolution.
