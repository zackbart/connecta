---
type: fixed
---

Stop build hooks rewriting unchanged generated sources, so they cannot reload a smoke under Wrangler, and report a Worker eval reload as an infrastructure error instead of a lost connection or host authorization failure.
