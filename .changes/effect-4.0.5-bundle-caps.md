---
type: changed
---

Pin `effect` to exactly 4.0.5 (from `^4.0.0`). A deployment that also depends on Effect, such as an Alchemy resource stack, must pin the same 4.0.5 to resolve one copy. Bundle caps stay on the deployed shapes; per-provider entries are now reported against their baseline instead of capped, because every deployment already pays for the Effect core through the root. `ProviderDefinition`'s `bundle.maxGzip` stays accepted but deprecated and ignored.
