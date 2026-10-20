---
type: changed
---

Pin `effect` to exactly 4.0.5 (from `^4.0.0`), so a deployment that also uses Effect, such as an Alchemy resource stack, installs the same version and resolves one copy. Bundle caps stay on the deployed shapes; per-provider entries are now reported against their baseline instead of capped, because every deployment already pays for the Effect core through the root.
