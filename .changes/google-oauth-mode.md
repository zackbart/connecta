---
type: added
---

Google Workspace providers (`gmail`, `drive`, `docs`, `sheets`, `slides`, `forms`) take an OAuth mode beside domain-wide delegation: `{ oauth: { clientId, clientSecret }, authScope: "personal" | "shared" }` connects each person's own Google account (or one maintainer-connected account) through the downstream OAuth flow, requests exactly the product's scopes, renews a read once after a 401 and never resends a write. No Google revocation endpoint is configured. Construction requires exactly one mode. `defineApiProvider` now selects a machine grant or static OAuth per connection options. (#1375)
