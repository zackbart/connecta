---
type: added
---

**Google Discovery drift checks.** `npm run providers:check -- --provider
gmail` reads Gmail's credential-free Discovery document and digests the nine
methods the tools call like any other touched endpoint, and also reports a
touched method that stops accepting the provider's delegated scopes. A
manifest with `"format": "google-discovery"` and a `scopes` list is all a
further Workspace product needs.
