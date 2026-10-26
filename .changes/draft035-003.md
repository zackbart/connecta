---
type: added
---

Add characterization goldens for every maintained `api()` provider: catalog, fixture-call requests (exact JSON body bytes included) grouped into causal steps with delivered-answer frontiers under a virtual clock installed before provider imports, with compact prefix frontiers and independently captured canonical/reverse answer orders, and results, failure mapping (including transport timeouts and a vendor error that echoes credentials), token-exchange and consent requests with decoded JWT claims, and sent-secret echo redaction across raw, percent, base64, base64url, `\u`-escaped and HTTP Basic encodings, compared byte for byte on Node and Workers independent of request scheduling, with explicit rejection of unsupported asynchronous sources and ambiguous concurrent reply fixtures, with `pnpm run goldens:update` to regenerate them.
