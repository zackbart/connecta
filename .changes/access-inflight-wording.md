---
type: fixed
---

Corrected the Cloudflare Access `identityLookup.inFlight` documentation: it counts lookup attempts still pending, so a hung lookup counts itself, and a rejected lookup or a deadline during retry backoff does not.
