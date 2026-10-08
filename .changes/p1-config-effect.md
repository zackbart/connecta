---
type: changed
---

Depend on `effect` through `^4.0.0` instead of exactly `4.0.0`, so a
deployment that also uses Effect resolves one copy. The root still imports
only the stable `effect` module (#705).
