---
type: changed
---

Default downstream OAuth to per-connector client metadata documents on public HTTPS deployments, retain DCR fallback, support issuer-bound static remote MCP clients, and report the selected registration path. Basecamp no longer requires an external metadata document.

Validate callback state and issuer before interpreting authorization errors.

On Disconnect, remove local authorization first and attempt issuer-bound RFC 7009 revocation once when advertised. Failed revocation reports `oauth_revocation_failed` without provider text or credentials.
