---
type: added
---

Add characterization goldens for every maintained `api()` provider: catalog, fixture-call requests and results, failure mapping (including transport timeouts and a vendor error that echoes credentials), token-exchange and consent requests with decoded JWT claims, and sent-secret echo redaction, compared byte for byte on Node and Workers, with `pnpm run goldens:update` to regenerate them.
