---
type: added
---

Add characterization goldens for every maintained `api()` provider: catalog, fixture-call requests (exact JSON body bytes included) and results, failure mapping (including transport timeouts and a vendor error that echoes credentials), token-exchange and consent requests with decoded JWT claims, and sent-secret echo redaction across raw, percent, base64, base64url, `\u`-escaped and HTTP Basic encodings, compared byte for byte on Node and Workers independent of request scheduling, with `pnpm run goldens:update` to regenerate them.
