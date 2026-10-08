---
type: security
---

Refuse redirects for credential-bearing OAuth token requests in remote MCP and static API connectors. A redirected refresh requires re-consent without another send. Keep spent records for each grant epoch and fingerprint so a new consent can use a byte-identical refresh token without reopening the prior epoch.
