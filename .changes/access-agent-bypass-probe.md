---
type: changed
---

Record a production Cloudflare probe showing that a path-scoped Access Bypass application for `<host>/agent/*` overrides a Worker-level Access application on that path only, with the edge's path matching and the pathnames the Worker receives, so `/agent/<pool>` can carry a single `cta_` credential behind Access.
